/**
 * P4-S3 — THE CART SNAPSHOT LAW, UNDER A FORCED INTERLEAVING (TL-P4-S3-R1).
 *
 * «A concurrent cart change between planning and commit must result in
 * either: the new state being included deterministically before the command
 * binds; or a stable "cart/state changed" refusal. Never silently sell one
 * cart and clear another.»
 *
 * ── NO SLEEPS, AND WHY THAT IS THE POINT ─────────────────────────────────
 *
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`: a race a suite
 * HOPES for is a verdict about the machine, not about the code. Every case
 * here forces its interleaving with a REAL HEAVYWEIGHT LOCK, through the
 * accepted mechanism this estate already proves before it trusts
 * (`tests/integration/sale-s2-interleaving.test.ts`):
 *
 *   1. a second connection opens a transaction and takes `FOR UPDATE` on ONE
 *      cart row of the basket about to be sold (`parkRow`, which THROWS
 *      rather than holding nothing if the row is not there);
 *   2. the checkout is fired and reaches its tombstone of that row, where it
 *      BLOCKS — `pos_cart_remove_line` issues an `UPDATE` on exactly that
 *      row, so the block is the database's and not a timer's;
 *   3. `waitUntilQueued` proves it is parked. It THROWS if the attempt
 *      settles without ever waiting, and its bound expiring is a FAILURE and
 *      never a pass, so a case that stopped forcing its race goes red rather
 *      than quietly passing;
 *   4. only then does the parker make its change and COMMIT, releasing the
 *      checkout into a world that moved under it.
 *
 * There is no `setTimeout` anywhere in this file, no retry, and no tolerance
 * for a deadlock: `expectNoDeadlock` fails on `40P01`, because a deadlock is a
 * lock-order defect and never a business outcome
 * (`[[daftar-lock-order-not-retry]]`, P4-AL-41). The checkout takes its locks
 * in ONE order — the session advisory lock, then the sale's warehouse and
 * variants in id order — which is why no case here has ever produced one.
 *
 * ── WHAT THE PARK PROVES ABOUT THE ORDER OF THE SERVICE'S STEPS ──────────
 *
 * The verification read runs AFTER the tombstones ON PURPOSE, and this file
 * is where that is demonstrated rather than asserted: a concurrent quantity
 * edit that commits while the checkout is parked is INVISIBLE to a read taken
 * before the lock and VISIBLE to one taken after it. The park puts the edit
 * exactly in that window.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { expectNoDeadlock, parkRow, parkStockKey, settle, waitUntilQueued, type Outcome } from '../golden-regression/phase4-s2/harness';
import {
  census,
  checkout,
  clearBasket,
  expectNoFinancialChange,
  expectUntouched,
  refusalCode,
  scan,
  seedCheckoutShop,
  type CheckoutShop,
} from '../helpers/till-checkout';

let t: TestApp;
let A: CheckoutShop;

const open = (): Promise<Client> => ownerClient();

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  A = await seedCheckoutShop(t, 'ilck');
}, 300_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

const liveLines = async (shop: CheckoutShop): Promise<string[]> =>
  (
    await ownerPool().query<{ id: string }>(
      `SELECT id::text AS id FROM pos_cart_lines WHERE business_id = $1 AND till_session_id = $2 AND removed_at IS NULL ORDER BY line_no`,
      [shop.business.businessId, shop.session.sessionId],
    )
  ).rows.map((r) => r.id);

/**
 * Fire one checkout, park the FIRST line of the basket while it runs, make
 * `change` under that park, then release — and answer what the checkout did.
 *
 * `parkOn` is the row the checkout will certainly touch: `consume` walks the
 * snapshot in `line_no` order, so the lowest-ordinal live line is the one it
 * blocks on first and the one that holds the window open.
 */
async function underPark(parkOn: string, change: (c: Client) => Promise<void>): Promise<Outcome<Response>> {
  const park = await parkRow(
    open,
    `SELECT 1 FROM pos_cart_lines WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [A.business.businessId, parkOn],
    `underPark: no pos_cart_lines row ${parkOn} to hold`,
  );
  const settled = { done: false };
  const attempt = settle(() => checkout(t, A, randomUUID()).then((r) => r));
  const running = attempt.finally(() => {
    settled.done = true;
  });
  try {
    // The checkout must really be waiting on the held row. If it settles
    // without ever parking, this THROWS — the race did not happen and a
    // verdict read out of it would be about the machine's speed.
    await waitUntilQueued([park.pid], 1, settled, 'the checkout must block on the held cart row');
    // The world moves, in the window the park is holding open.
    const mover = await open();
    try {
      await mover.query('BEGIN');
      // The tenant and business GUCs the POLICIES read. `pos_cart_line_guard`
      // is `SECURITY DEFINER` owned by `daftar_inventory_internal`, which is
      // NOT a superuser, so its read of `pos_till_sessions` runs under the
      // RESTRICTIVE isolation policies: without these the guard sees no
      // session at all and raises `pos.session_not_open` — a refusal about the
      // FIXTURE that would have looked like the law firing.
      await mover.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.business.tenantId, A.business.businessId]);
      await change(mover);
      await mover.query('COMMIT');
    } finally {
      await mover.end();
    }
  } finally {
    await park.release();
  }
  return running;
}

describe('5–7: a cart that changes under a running checkout', () => {
  it('a concurrent QUANTITY edit is a stable refusal: nothing is sold and nothing is cleared', async () => {
    await clearBasket(t, A);
    const first = await scan(t, A, A.business.piece.productId, '1');
    const second = await scan(t, A, A.business.piece2.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);

    const outcome = await underPark(first, async (c) => {
      await c.query(`UPDATE pos_cart_lines SET quantity = 7 WHERE business_id = $1 AND id = $2`, [A.business.businessId, second]);
    });
    expectNoDeadlock([outcome], 'a concurrent quantity edit');
    expect(outcome.kind).toBe('ok');
    const res = (outcome as { value: Response }).value;
    expect(res.status, `the checkout sold a basket that had changed: ${JSON.stringify(res.body)}`).toBe(409);
    expect(refusalCode(res.body)).toBe('pos.checkout_cart_state_changed');

    // NOTHING COMMITS. Not the sale, not the invoice, not the movements, not
    // the postings — and not one tombstone, which is the half a service that
    // tombstoned first and checked afterwards would have got wrong.
    expectUntouched(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a concurrent quantity edit');
    expect(await liveLines(A), 'the basket must still hold both lines').toEqual([first, second]);
    // And the edit the OTHER transaction made is still there: the checkout
    // rolled ITSELF back and nothing of anybody else's.
    const qty = (
      await ownerPool().query<{ q: string }>(`SELECT quantity::text AS q FROM pos_cart_lines WHERE business_id = $1 AND id = $2`, [
        A.business.businessId,
        second,
      ])
    ).rows[0];
    expect(qty?.q, 'the concurrent edit was rolled back with the checkout — a transaction undid somebody else’s work').toBe('7.0000');
  }, 180_000);

  it('a concurrent LINE REMOVAL is a stable refusal: the sale the removed line was priced into never commits', async () => {
    await clearBasket(t, A);
    const first = await scan(t, A, A.business.piece.productId, '1');
    const second = await scan(t, A, A.business.piece2.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);

    const outcome = await underPark(first, async (c) => {
      await c.query(`UPDATE pos_cart_lines SET removed_at = now() WHERE business_id = $1 AND id = $2`, [A.business.businessId, second]);
    });
    expectNoDeadlock([outcome], 'a concurrent line removal');
    const res = (outcome as { value: Response }).value;
    expect(res.status, `a basket whose line had been removed was sold anyway: ${JSON.stringify(res.body)}`).toBe(409);
    expect(refusalCode(res.body)).toBe('pos.checkout_cart_state_changed');
    expectNoFinancialChange(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a concurrent line removal');
    // The removal stands — it was somebody else's committed work — and the
    // line the checkout was going to sell is still there, unsold.
    expect(await liveLines(A)).toEqual([first]);
  }, 180_000);

  it('a concurrent EXTRA LINE is a stable refusal: a half-sold basket is never committed', async () => {
    await clearBasket(t, A);
    const first = await scan(t, A, A.business.piece.productId, '1');
    const before = await census(ownerPool(), A.business.businessId, A.session.sessionId);
    const added = randomUUID();

    const outcome = await underPark(first, async (c) => {
      // A scan that lands while the checkout is already inside its
      // transaction. It is written here as the row the routine writes,
      // because the routine cannot be called from a connection that is
      // holding the park open.
      await c.query(
        `INSERT INTO pos_cart_lines (tenant_id, business_id, till_session_id, id, line_no, product_id, variant_id, quantity, requested_discount_minor, added_by)
         SELECT s.tenant_id, s.business_id, s.id, $3::uuid,
                (SELECT coalesce(max(l.line_no), 0) + 1 FROM pos_cart_lines l WHERE l.business_id = s.business_id AND l.till_session_id = s.id),
                $4::uuid, $5::uuid, 1, 0, s.opened_by
           FROM pos_till_sessions s WHERE s.business_id = $1::uuid AND s.id = $2::uuid`,
        [A.business.businessId, A.session.sessionId, added, A.business.piece2.productId, A.business.piece2.variantId],
      );
    });
    expectNoDeadlock([outcome], 'a concurrent extra line');
    const res = (outcome as { value: Response }).value;
    expect(res.status, `half a basket was sold: ${JSON.stringify(res.body)}`).toBe(409);
    expect(refusalCode(res.body)).toBe('pos.checkout_cart_state_changed');
    expectNoFinancialChange(before, await census(ownerPool(), A.business.businessId, A.session.sessionId), 'a concurrent extra line');
    expect(await liveLines(A), 'both the bound line and the new one must still be in the basket').toEqual([first, added]);

    // And the retry sells BOTH, which is the other half of the ruling: the
    // refusal is a state the till can act on, not a dead end.
    const retry = await checkout(t, A, randomUUID());
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect([...(retry.body.consumedCartLineIds as string[])].sort()).toEqual([first, added].sort());
    expect(await liveLines(A)).toEqual([]);
  }, 180_000);
});

describe('15: the last item, sold by exactly one till', () => {
  it('two tills checking out the last unit produce exactly ONE stock winner and ONE stable refusal', async () => {
    // Two tills need two ACTORS: `pos_till_sessions_one_open_per_user_uq` is a
    // partial unique index on `(business_id, opened_by) WHERE status = 'open'`,
    // so one cashier cannot hold two drawers. That is the ruling, not an
    // inconvenience to work around.
    const one = await seedCheckoutShop(t, 'race1', '1');
    await scan(t, one, one.business.piece.productId, '1');

    // The SAME shop, a second till, a second cashier: this is the race that
    // matters, because both baskets name the same stock key.
    const colleagueSession = await t.request
      .post('/v1/pos/till-sessions')
      .set({ Authorization: `Bearer ${one.colleague.token}`, 'X-Business-Id': one.business.businessId })
      .send({
        sessionId: randomUUID(),
        branchId: one.business.branchX,
        warehouseId: one.business.w1,
        terminalCode: `race_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        openingFloatMinor: '0',
      });
    expect(colleagueSession.status, `the second till could not be opened: ${JSON.stringify(colleagueSession.body)}`).toBe(200);
    const second: CheckoutShop = { ...one, cashier: one.colleague, session: { ...one.session, sessionId: String(colleagueSession.body.id) } };
    await scan(t, second, one.business.piece.productId, '1', one.colleague);

    const before = await census(ownerPool(), one.business.businessId, one.session.sessionId);
    // THE PARK: the one row `inventory_apply_stock_movements` must lock for
    // this key. Both checkouts queue behind it; neither can reach the stock
    // before the other by being faster.
    const park = await parkStockKey(open, one.business.businessId, one.business.w1, one.business.piece.variantId);
    const settled = { done: false };
    let left = 0;
    const attempts = [settle(() => checkout(t, one, randomUUID())), settle(() => checkout(t, second, randomUUID(), one.colleague))].map((p) =>
      p.finally(() => {
        left += 1;
        if (left === 2) settled.done = true;
      }),
    );
    try {
      await waitUntilQueued([park.pid], 2, settled, 'both checkouts must park on the held stock key');
    } finally {
      await park.release();
    }
    const outcomes = await Promise.all(attempts);
    expectNoDeadlock(outcomes, 'the last-item checkout race');

    const answers = outcomes.map((o) => (o as { value: Response }).value);
    const won = answers.filter((r) => r.status === 200);
    const lost = answers.filter((r) => r.status !== 200);
    expect(won.length, `both tills sold the last unit: ${answers.map((r) => `${r.status} ${JSON.stringify(r.body)}`).join(' | ')}`).toBe(1);
    expect(lost.length).toBe(1);
    // The loser is a STABLE BUSINESS REFUSAL naming the stock, not a crash.
    expect(refusalCode(lost[0]?.body), `the loser answered ${lost[0]?.status}: ${JSON.stringify(lost[0]?.body)}`).toMatch(/insufficient_stock|state_changed/);

    // Exactly one sale in the business, and the LOSER's basket is intact — a
    // till whose sale was refused still holds the goods it was ringing up.
    const after = await census(ownerPool(), one.business.businessId, one.session.sessionId);
    expect(after.sales, 'the race committed more than one sale').toBe(before.sales + 1);
    expect(after.movements, 'the race moved stock twice').toBe(before.movements + 1);
    const onHand = (
      await ownerPool().query<{ q: string }>(`SELECT on_hand::text AS q FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
        one.business.businessId,
        one.business.w1,
        one.business.piece.variantId,
      ])
    ).rows[0];
    expect(Number(onHand?.q ?? -1), 'the last unit was sold twice').toBe(0);
    const liveA = await liveLines(one);
    const liveB = (
      await ownerPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pos_cart_lines WHERE business_id = $1 AND till_session_id = $2 AND removed_at IS NULL`,
        [one.business.businessId, second.session.sessionId],
      )
    ).rows[0];
    expect(liveA.length + Number(liveB?.n ?? -1), 'exactly one of the two baskets was consumed, and exactly one still holds its line').toBe(1);
  }, 300_000);
});
