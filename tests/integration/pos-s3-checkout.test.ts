/**
 * P4-S3 — THE ATOMIC POS CHECKOUT, PERFORMED (TL-P4-S3-R1).
 *
 * This suite drives `POST /v1/pos/till-sessions/:sessionId/checkout` over real
 * HTTP, against the real composition, the real `sale_commit`, the real
 * `pos_cart_remove_line` and a real PostgreSQL — and reads every verdict off
 * the DATABASE as the schema owner, who bypasses row security. A response
 * body is what the route SAID; the census is what happened.
 *
 * The law it performs, in the Tech Lead's words: «If ANY step fails: NOTHING
 * COMMITS. Never allow: sale committed + cart not consumed; cart consumed +
 * sale not committed; partial cart consumption; invoice without sale; stock
 * movement without sale; accounting posting without commercial source.»
 *
 * The forced-interleaving half — the four concurrency cases and the last-item
 * race — is `tests/integration/pos-s3-checkout-interleaving.test.ts`, because
 * those need a second connection parked on a real row lock and this one needs
 * none. The structural half is `tests/guards/pos-s3-checkout-law.test.ts`.
 *
 * ## The planted defects
 *
 * Two of the cases below plant a REAL failure in the database — a `BEFORE`
 * trigger that raises on a sentinel value — and assert that the whole
 * transaction rolls back. A trigger is the only honest way to plant a
 * mid-transaction failure in a path whose atomicity is the thing under test:
 * stubbing the service would test the stub, and a failure injected before the
 * transaction opens would prove nothing about the transaction. Each one is
 * created and dropped inside its own case, so the catalogue `0079-E` asserts
 * over is the catalogue every other suite sees.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember } from '../helpers/inventory-commands';
import { closeTillSession } from '../helpers/pos-till-sessions';
import { census, checkout, checkoutBody, clearBasket, expectUntouched, refusalCode, scan, seedCheckoutShop, type CheckoutShop } from '../helpers/till-checkout';

let t: TestApp;
let A: CheckoutShop;
let B: CheckoutShop;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  A = await seedCheckoutShop(t, 'ck1');
  B = await seedCheckoutShop(t, 'ck2');
}, 300_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

/** Plant a failure in one relation, run `body`, and remove the plant whatever happened. */
async function planted<T>(ddl: string, drop: string, body: () => Promise<T>): Promise<T> {
  await ownerPool().query(ddl);
  try {
    return await body();
  } finally {
    await ownerPool().query(drop);
  }
}

const liveLines = async (shop: CheckoutShop): Promise<string[]> =>
  (
    await ownerPool().query<{ id: string }>(
      `SELECT id::text AS id FROM pos_cart_lines WHERE business_id = $1 AND till_session_id = $2 AND removed_at IS NULL ORDER BY line_no`,
      [shop.business.businessId, shop.session.sessionId],
    )
  ).rows.map((r) => r.id);

describe('1–2: the happy path, and a refused sale that leaves the basket exactly as it was', () => {
  it('cart → sale → EMPTY active cart, with the sale’s own line ids equal to the cart line ids', async () => {
    await clearBasket(t, A);
    const one = await scan(t, A, A.business.piece.productId, '2');
    const two = await scan(t, A, A.business.piece2.productId, '3');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);

    const saleId = randomUUID();
    const res = await checkout(t, A, saleId);
    expect(res.status, `the checkout was refused: ${JSON.stringify(res.body)}`).toBe(200);

    const after = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    // The sale committed, in ONE of everything.
    expect(after.sales, 'exactly one sale').toBe(before.sales + 1);
    expect(after.saleItems, 'one sale item per cart line').toBe(before.saleItems + 2);
    expect(after.invoices, 'exactly one invoice').toBe(before.invoices + 1);
    expect(after.movements, 'one stock movement per line').toBe(before.movements + 2);
    expect(after.journalEntries, 'the COGS entry and the revenue entry').toBe(before.journalEntries + 2);
    // And the basket is EMPTY, by tombstone and not by delete.
    expect(await liveLines(A), 'the committed basket still holds live lines').toEqual([]);
    expect(after.tombstonedCartLines, 'the two lines were consumed as tombstones').toBe(before.tombstonedCartLines + 2);

    // THE BINDING. The sale's own line ids ARE the cart line ids it consumed,
    // which is what ties the consumption to the snapshot rather than to
    // "whatever was active".
    expect([...(res.body.consumedCartLineIds as string[])].sort()).toEqual([one, two].sort());
    expect((res.body.sale.lines as { lineId: string }[]).map((l) => l.lineId).sort()).toEqual([one, two].sort());
    expect(res.body.sale.replayed, 'a first checkout is not a replay').toBe(false);
  }, 120_000);

  it('a REFUSED sale leaves the FULL cart unchanged — no partial consumption, no tombstone', async () => {
    await clearBasket(t, A);
    const line = await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    // A document date in the FUTURE is refused by the sale writer's own rule
    // (`0058`), deep inside `plan` and before any transaction opens. The cart
    // must not notice.
    const res = await t.request
      .post(`/v1/pos/till-sessions/${A.session.sessionId}/checkout`)
      .set(asMember(A.cashier, A.business.businessId))
      .send({ ...checkoutBody(randomUUID(), A.day), documentDate: '2999-01-01' });
    expect(res.status, 'a future-dated checkout was accepted').toBeGreaterThanOrEqual(400);
    expect(refusalCode(res.body)).toBe('sale.document_date_in_future');
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a refused sale');
    expect(await liveLines(A), 'the basket must be exactly what it was').toEqual([line]);
  }, 120_000);
});

describe('3–4 and 16: a planted failure on either side rolls the WHOLE transaction back, with no orphan anywhere', () => {
  it('red: a planted cart-consumption failure rolls the SALE back entirely', async () => {
    await clearBasket(t, A);
    const line = await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    const res = await planted(
      `CREATE FUNCTION pos_checkout_planted_consume_failure() RETURNS trigger LANGUAGE plpgsql AS $plant$
         BEGIN
           IF NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
             RAISE EXCEPTION 'planted: the cart consumption fails' USING ERRCODE = 'P0001';
           END IF;
           RETURN NEW;
         END
       $plant$;
       CREATE TRIGGER pos_checkout_planted_consume BEFORE UPDATE ON pos_cart_lines
         FOR EACH ROW EXECUTE FUNCTION pos_checkout_planted_consume_failure();`,
      `DROP TRIGGER pos_checkout_planted_consume ON pos_cart_lines; DROP FUNCTION pos_checkout_planted_consume_failure();`,
      () => checkout(t, A, randomUUID()),
    );
    expect(res.status, 'the checkout answered success while its cart consumption was failing').toBeGreaterThanOrEqual(400);
    // THE LAW. The sale, its items, the invoice, the movements, the bindings
    // and BOTH journal entries are gone with it — the whole census, not a
    // chosen relation.
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a planted cart-consumption failure');
    expect(await liveLines(A), 'the basket is intact, because nothing committed').toEqual([line]);
  }, 120_000);

  it('red: a planted sale-side failure leaves the cart INTACT and writes no sale, invoice, movement or entry', async () => {
    await clearBasket(t, A);
    const line = await scan(t, A, A.business.piece2.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    const res = await planted(
      `CREATE FUNCTION pos_checkout_planted_sale_failure() RETURNS trigger LANGUAGE plpgsql AS $plant$
         BEGIN
           RAISE EXCEPTION 'planted: the sale item write fails' USING ERRCODE = 'P0001';
         END
       $plant$;
       CREATE TRIGGER pos_checkout_planted_sale BEFORE INSERT ON sale_items
         FOR EACH ROW EXECUTE FUNCTION pos_checkout_planted_sale_failure();`,
      `DROP TRIGGER pos_checkout_planted_sale ON sale_items; DROP FUNCTION pos_checkout_planted_sale_failure();`,
      () => checkout(t, A, randomUUID()),
    );
    expect(res.status, 'the checkout answered success while the sale write was failing').toBeGreaterThanOrEqual(400);
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a planted sale-side failure');
    expect(await liveLines(A), 'a cart consumed with no sale committed is the law’s other direction').toEqual([line]);
  }, 120_000);
});

describe('8–9: the replay, and the line a replay must NOT consume', () => {
  it('a duplicate checkout returns the SAME sale and creates no second anything', async () => {
    await clearBasket(t, A);
    await scan(t, A, A.business.piece.productId, '1');
    const saleId = randomUUID();
    const first = await checkout(t, A, saleId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const afterFirst = await census(ownerPool(), A.business.businessId, A.session.sessionId);

    const second = await checkout(t, A, saleId);
    expect(second.status, `the replay was refused: ${JSON.stringify(second.body)}`).toBe(200);
    expect(second.body.sale.saleId).toBe(first.body.sale.saleId);
    expect(second.body.sale.replayed, 'a replay says so').toBe(true);
    expect(second.body.sale.invoice.invoiceId).toBe(first.body.sale.invoice.invoiceId);
    expectUntouched(afterFirst, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a replay');
  }, 120_000);

  it('THE CRITICAL ONE: a replay after new lines were added does NOT consume the new lines', async () => {
    await clearBasket(t, A);
    const sold = await scan(t, A, A.business.piece.productId, '1');
    const saleId = randomUUID();
    const first = await checkout(t, A, saleId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await liveLines(A)).toEqual([]);

    // The next customer's goods are scanned into the same shift.
    const fresh1 = await scan(t, A, A.business.piece2.productId, '2');
    const fresh2 = await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);

    // The till's network retried the FIRST checkout.
    const replay = await checkout(t, A, saleId);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.sale.replayed).toBe(true);
    // The consumed identity is the ORIGINAL snapshot, named from the stored
    // sale — never "the active lines".
    expect(replay.body.consumedCartLineIds).toEqual([sold]);
    expect(await liveLines(A), 'the replay cleared lines added AFTER the original checkout').toEqual([fresh1, fresh2]);
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a replay with a refilled basket');

    // And the refilled basket still sells, under its own identity.
    const next = await checkout(t, A, randomUUID());
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect([...(next.body.consumedCartLineIds as string[])].sort()).toEqual([fresh1, fresh2].sort());
    expect(await liveLines(A)).toEqual([]);
  }, 120_000);

  it('the same id over a DIFFERENT intent is a stable conflict, not a success', async () => {
    await clearBasket(t, A);
    await scan(t, A, A.business.piece.productId, '1');
    const saleId = randomUUID();
    expect((await checkout(t, A, saleId)).status).toBe(200);
    await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    // Same key, different note: a different command wearing a spent identity.
    const res = await t.request
      .post(`/v1/pos/till-sessions/${A.session.sessionId}/checkout`)
      .set(asMember(A.cashier, A.business.businessId))
      .send({ ...checkoutBody(saleId, A.day), notes: 'a different command' });
    expect(res.status, 'a reused key over a different intent answered success').toBe(409);
    expect(refusalCode(res.body)).toBe('pos.checkout_idempotency_conflict');
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'an idempotency conflict');
  }, 120_000);

  it('a sale id born at ANOTHER till cannot be replayed here: the proof is the cart line identity', async () => {
    await clearBasket(t, B);
    await scan(t, B, B.business.piece.productId, '1');
    const saleId = randomUUID();
    expect((await checkout(t, B, saleId)).status).toBe(200);
    await clearBasket(t, A);
    await scan(t, A, A.business.piece.productId, '1');
    // A's till, B's sale id. Different businesses, so A cannot even see the
    // sale — but the claim under test is that the proof is the LINE IDENTITY
    // and not merely RLS, which the guard suite asserts structurally.
    const res = await checkout(t, A, saleId);
    expect(res.status, `a till that could not see the foreign sale should have sold its own basket: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.sale.saleId, 'a sale id invisible here is a NEW sale here, not a replay of another business’s').toBe(saleId);
    expect(res.body.sale.replayed).toBe(false);
  }, 120_000);
});

describe('10–12: who may check out, and when', () => {
  it('a cross-business checkout is refused and writes nothing', async () => {
    await clearBasket(t, B);
    await scan(t, B, B.business.piece.productId, '1');
    const before = await census(ownerPool(), B.business.businessId, B.session.sessionId);
    // B's session id under A's header, by an actor with no membership in B.
    const res = await t.request
      .post(`/v1/pos/till-sessions/${B.session.sessionId}/checkout`)
      .set(asMember(A.cashier, A.business.businessId))
      .send(checkoutBody(randomUUID(), A.day));
    expect([403, 404, 409, 422], `the cross-business checkout answered ${res.status}`).toContain(res.status);
    expectUntouched(before, await census(ownerPool(), B.business.businessId, B.session.sessionId), 'a cross-business checkout');
  }, 120_000);

  it('a COLLEAGUE cannot check out this cashier’s till (OD-P4-09): 403, and nothing written', async () => {
    await clearBasket(t, A);
    const line = await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    const res = await checkout(t, A, randomUUID(), A.colleague);
    expect(res.status, 'a colleague sold another cashier’s drawer').toBe(403);
    expect(refusalCode(res.body)).toBe('pos.session_not_owned');
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a colleague’s checkout');
    expect(await liveLines(A)).toEqual([line]);
  }, 120_000);

  it('a CLOSED till cannot check out: 409, and the shift’s frozen basket is untouched', async () => {
    const shop = await seedCheckoutShop(t, 'ckclosed');
    const line = await scan(t, shop, shop.business.piece.productId, '1');
    await closeTillSession(t, shop.cashier, shop.business.businessId, shop.session.sessionId);
    const before = await census(ownerPool(), shop.business.businessId, shop.session.sessionId);
    const res = await checkout(t, shop, randomUUID());
    expect(res.status, 'a closed till sold something').toBe(409);
    expect(refusalCode(res.body)).toBe('pos.session_not_open');
    expectUntouched(before, await census(ownerPool(), shop.business.businessId, shop.session.sessionId), 'a closed till’s checkout');
    expect(await liveLines(shop), 'a closed session and its lines are the frozen record of the shift').toEqual([line]);
  }, 300_000);
});

describe('13–14: the client is not the price authority', () => {
  it('a forged TOTAL is refused by name, and nothing is sold', async () => {
    await clearBasket(t, A);
    const line = await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    for (const forged of [{ cartTotalMinor: '1' }, { totalMinor: '1' }, { subtotalMinor: '1' }, { unitPriceMinor: '1' }] as const) {
      const res = await t.request
        .post(`/v1/pos/till-sessions/${A.session.sessionId}/checkout`)
        .set(asMember(A.cashier, A.business.businessId))
        .send({ ...checkoutBody(randomUUID(), A.day), ...forged });
      expect(res.status, `a forged ${Object.keys(forged)[0]} was accepted`).toBe(400);
      expect(refusalCode(res.body), 'the refusal names the law, not a shape complaint').toBe('pos.checkout_price_authority_refused');
    }
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a forged total');
    expect(await liveLines(A)).toEqual([line]);
  }, 120_000);

  it('a forged DISCOUNT and a forged basket are refused: neither is a field this request has', async () => {
    await clearBasket(t, A);
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    for (const forged of [
      { discountMinor: '500' },
      { lines: [{ productId: A.business.piece.productId, quantity: '99', discountMinor: '9999' }] },
      { warehouseId: A.business.w2 },
    ] as const) {
      const res = await t.request
        .post(`/v1/pos/till-sessions/${A.session.sessionId}/checkout`)
        .set(asMember(A.cashier, A.business.businessId))
        .send({ ...checkoutBody(randomUUID(), A.day), ...forged });
      expect(res.status, `a forged ${Object.keys(forged)[0]} was accepted`).toBe(400);
      // `lines` and `cart*` are judged BY NAME as price authority — a basket
      // the client chose is a price claim even with no number in it. A
      // `discountMinor` or a `warehouseId` on this request is an unknown key:
      // the cart owns the discount request and the session owns the
      // warehouse, so neither is a field a CHECKOUT has at all. Both are
      // refused, and neither is silently ignored, which is the whole claim.
      expect(['pos.checkout_price_authority_refused', 'pos.cart_field_unknown']).toContain(refusalCode(res.body));
    }
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a forged discount or basket');
  }, 120_000);

  it('the discount the SERVER sells is the CART’s stored request, never one the checkout stated', async () => {
    await clearBasket(t, A);
    const line = await scan(t, A, A.business.piece.productId, '1');
    const asked = await t.request
      .post(`/v1/pos/till-sessions/${A.session.sessionId}/cart-lines/${line}/discount`)
      .set(asMember(A.cashier, A.business.businessId))
      .send({ discountMinor: '250' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const res = await checkout(t, A, randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 1000 minor is the fixture's catalogue price; the cart asked 250 off.
    expect(res.body.sale.discountTxnMinor, 'the sale carries the CART’s discount request').toBe('250');
    expect(res.body.sale.totalTxnMinor).toBe('750');
  }, 120_000);
});
