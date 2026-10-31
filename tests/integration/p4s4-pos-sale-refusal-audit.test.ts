/**
 * P4-S4 — **THE POS AND SALE-COMMIT COMMANDS AUDIT THEIR REFUSALS** (P4-AL-48).
 *
 * The receivables surface already did. The sale commit, the till session, the
 * basket and the atomic POS checkout did NOT, and the reason was structural —
 * visible in the SQL, and NOT what the prose around it said. Each of the three
 * sites the slice was pointed at is an `INSERT INTO audit_events` of a
 * **SUCCESS**, placed as the routine's LAST write, after every one of its
 * `RAISE EXCEPTION`s:
 *
 *   - `0078:1002` — `sale.committed`, the only audit row `sale_commit` writes,
 *     after all 33 of its raises;
 *   - `0079:954` — `pos.till_session_opened`, inside
 *     `pos_till_session_open`'s NON-REPLAY arm, after its 7;
 *   - `0079:1022` — `pos.till_session_closed`, inside
 *     `pos_till_session_close`'s NON-REPLAY arm, after its 6.
 *
 * A `RAISE` aborts the transaction, so a row written before it would not
 * survive either: a refused sale, a refused till open, a refused till close,
 * a refused scan and a refused checkout persisted NO audit evidence at all.
 *
 * This suite drives each one over real HTTP against a real PostgreSQL and
 * reads the verdict off `audit_events` AS THE SCHEMA OWNER, who bypasses row
 * security — a response body is what the route SAID, the row is what happened.
 *
 * ## What makes it honest
 *
 * §A and §B are refusals raised INSIDE the routine, which can only be audited
 * if the second transaction really does outlive the abort — the whole
 * architectural claim of P4-AL-48(a). §D is the same on the sale path and adds
 * the two figures a late refusal knows: the intent digest and the branch. §C
 * proves the POS checkout's row carries its TILL, which is the one thing that
 * distinguishes it from the same sale committed through `POST /v1/sales`. §F
 * is the control: a SUCCESS writes no `.refused` row, so this suite cannot
 * pass by auditing everything as refused.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asMember } from '../helpers/inventory-commands';
import { openTillSession, terminalCode } from '../helpers/pos-till-sessions';
import { checkoutBody, scan, seedCheckoutShop, type CheckoutShop } from '../helpers/till-checkout';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';

const CLAIM =
  'every POS and sale-commit command persists an audit row for a refusal, in its own committed transaction, carrying the code the merchant was answered with';

let t: TestApp;
let shop: CheckoutShop;

interface AuditRow {
  action: string;
  entity: string;
  entity_id: string | null;
  actor_user_id: string | null;
  metadata: {
    outcome?: string;
    refusalCode?: string;
    operation?: string;
    intentSha256?: string | null;
    branchId?: string | null;
    tillSessionId?: string | null;
    figures?: Record<string, unknown>;
  };
}

/** Every row this business holds under one action, oldest first. */
async function rowsFor(action: string): Promise<AuditRow[]> {
  const r = await ownerPool().query<AuditRow>(
    `SELECT action, entity, entity_id::text AS entity_id, actor_user_id::text AS actor_user_id, metadata
       FROM audit_events WHERE business_id = $1 AND action = $2 ORDER BY created_at`,
    [shop.business.businessId, action],
  );
  return r.rows;
}

/** How many `.refused` rows this business holds, whatever the command. */
async function refusedCount(): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action LIKE '%.refused'`, [
    shop.business.businessId,
  ]);
  return r.rows[0]?.n ?? 0;
}

/** The stable code the response carried, wherever the module put it. */
function answered(body: unknown): string | undefined {
  const e = (body as { error?: { details?: Record<string, unknown> } }).error;
  const d = e?.details ?? {};
  const code = d['sellingCode'] ?? d['inventoryCode'];
  return typeof code === 'string' ? code : undefined;
}

/** §A — a refused till OPEN: a second open session for the same cashier. */
let openRefusal: { status: number; body: unknown; sessionId: string };
/** §B — a refused till CLOSE: a colleague closing the cashier's own shift. */
let closeRefusal: { status: number; body: unknown };
/** §C — a refused POS CHECKOUT: an empty basket. */
let checkoutRefusal: { status: number; body: unknown; saleId: string };
/** §D — a refused SALE COMMIT through `POST /v1/sales`: more stock than exists. */
let saleRefusal: { status: number; body: unknown; saleId: string };
/** §E — a refused CART command: a removal of a line this basket never held. */
let cartRemoveRefusal: { status: number; body: unknown; cartLineId: string };
/** §E — and the other cart operation: a scan of a product that does not exist. */
let cartAddRefusal: { status: number; body: unknown };
/** §F — the control: the colleague opens their OWN till, which succeeds. */
let success: { status: number; body: unknown; refusedBefore: number; refusedAfter: number };

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  shop = await seedCheckoutShop(t, 'posaudit');
  const cashier = asMember(shop.cashier, shop.business.businessId);
  const colleague = asMember(shop.colleague, shop.business.businessId);

  // §A. `pos_till_sessions_one_open_per_user_uq` is the authority and
  // `pos_till_session_open` pre-checks it under its own advisory key
  // (`0079:939-943`), so this refusal is the ROUTINE's and is raised inside
  // the transaction it then aborts.
  const openSessionId = randomUUID();
  const a = await t.request
    .post('/v1/pos/till-sessions')
    .set(cashier)
    .send({
      sessionId: openSessionId,
      branchId: shop.business.branchX,
      warehouseId: shop.business.w1,
      terminalCode: terminalCode('dupopen'),
      openingFloatMinor: '2500',
    });
  openRefusal = { status: a.status, body: a.body, sessionId: openSessionId };

  // §B. `OD-P4-09`: only the session's own user ends their own shift. The
  // comparison is `pos_till_session_close`'s (`0079:1008`), so again a refusal
  // raised inside the aborted transaction.
  const b = await t.request.post(`/v1/pos/till-sessions/${shop.session.sessionId}/close`).set(colleague).send({ closingCountMinor: '0' });
  closeRefusal = { status: b.status, body: b.body };

  // §C. The basket is empty — `seedCheckoutShop` scans nothing — so the
  // checkout is refused by the service before any transaction opens.
  const checkoutSaleId = randomUUID();
  const c = await t.request.post(`/v1/pos/till-sessions/${shop.session.sessionId}/checkout`).set(cashier).send(checkoutBody(checkoutSaleId, shop.day));
  checkoutRefusal = { status: c.status, body: c.body, saleId: checkoutSaleId };

  // §D. More units than the warehouse holds. The refusal is
  // `inventory.insufficient_stock`, raised by the ONE stock writer under the
  // level row's own `FOR UPDATE` — inside `sale_commit`, which means AFTER the
  // intent digest and the branch were bound. This is the case that proves both
  // of those reach the row.
  const saleId = randomUUID();
  const d = await t.request
    .post('/v1/sales')
    .set(cashier)
    .send({
      saleId,
      settlementMode: 'cash',
      customerId: null,
      warehouseId: shop.business.w1,
      documentDate: shop.day,
      dueDate: null,
      taxMinor: '0',
      notes: null,
      lines: [{ lineId: randomUUID(), productId: shop.business.piece.productId, variantId: null, quantity: '999999', discountMinor: '0' }],
    });
  saleRefusal = { status: d.status, body: d.body, saleId };

  // §E. A removal of a cart line this basket never held. The cart's GATE
  // refuses it, outside the write transaction, which is the earliest a cart
  // command can be refused — so this is the arm that proves the attempt record
  // exists before the first statement. It is also the `pos.cart_remove_line`
  // half of the cart's authority, where the scan below is the
  // `pos.cart_set_line` half: the two operations the four commands map onto.
  const unknownLine = randomUUID();
  const e1 = await t.request.delete(`/v1/pos/till-sessions/${shop.session.sessionId}/cart-lines/${unknownLine}`).set(cashier).send({});
  cartRemoveRefusal = { status: e1.status, body: e1.body, cartLineId: unknownLine };

  // And a scan of a product id that names nothing. Its refusal is NOT
  // `pos.cart_product_not_found`: measured here, the gate finds no product
  // row, so the payload the service would sign has no product to carry and
  // `buildInventoryPayload` refuses it as `inventory.payload_invalid` (400)
  // before any authority is minted. That is the code the merchant actually
  // receives, so it is the code this suite asserts — a test written to the
  // code the registry merely HOLDS would have been green about a sentence
  // nobody is ever told.
  const e2 = await t.request
    .post(`/v1/pos/till-sessions/${shop.session.sessionId}/cart-lines`)
    .set(cashier)
    .send({ productId: randomUUID(), variantId: null, quantity: '1' });
  cartAddRefusal = { status: e2.status, body: e2.body };

  // §F. The control. A different user may hold their own till, so this open
  // succeeds — and must add no `.refused` row.
  const before = await refusedCount();
  const f = await openTillSession(t, shop.colleague, shop.business.businessId, { branchId: shop.business.branchX, warehouseId: shop.business.w1 });
  success = { status: 200, body: f, refusedBefore: before, refusedAfter: await refusedCount() };
}, 600_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe(`P4-AL-48 — ${CLAIM}`, () => {
  describe('§A — a refused till OPEN (`0079:954` audits only the success)', () => {
    it('the cashier got the refusal they earned', () => {
      expect(openRefusal.status, JSON.stringify(openRefusal.body)).toBe(409);
      expect(answered(openRefusal.body)).toBe('pos.session_already_open');
    });

    it('one refusal row exists, keyed to the session the open NAMED and not to the one that was already there', async () => {
      const rows = await rowsFor('pos.session_open.refused');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entity).toBe('pos_till_session');
      expect(rows[0]?.entity_id).toBe(openRefusal.sessionId);
      expect(rows[0]?.metadata.outcome).toBe('refused');
      expect(rows[0]?.metadata.operation).toBe('pos.session_open');
      expect(rows[0]?.metadata.refusalCode).toBe('pos.session_already_open');
      expect(typeof rows[0]?.actor_user_id).toBe('string');
    });

    it('it carries the till, the branch and the counted float — the figures that caused it', async () => {
      const m = (await rowsFor('pos.session_open.refused'))[0]?.metadata;
      expect(m?.tillSessionId).toBe(openRefusal.sessionId);
      expect(m?.branchId).toBe(shop.business.branchX);
      // The float is inside the SIGNED payload, so a replay presenting a
      // different one is a conflict rather than a replay — which makes it part
      // of what distinguishes this attempt from any other.
      expect(m?.figures?.['openingFloatMinor']).toBe('2500');
      expect(m?.figures?.['warehouseId']).toBe(shop.business.w1);
      for (const [k, v] of Object.entries(m?.figures ?? {})) expect(typeof v, `${k} must not be a number in a figures object`).not.toBe('number');
    });
  });

  describe('§B — a refused till CLOSE (`0079:1022` audits only the success)', () => {
    it('the colleague was refused the shift that is not theirs', () => {
      expect(closeRefusal.status, JSON.stringify(closeRefusal.body)).toBe(403);
      expect(answered(closeRefusal.body)).toBe('pos.session_not_owned');
    });

    it('the row survived the abort and names the session, its branch and the counted cash', async () => {
      const rows = await rowsFor('pos.session_close.refused');
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.entity_id).toBe(shop.session.sessionId);
      expect(row?.metadata.operation).toBe('pos.session_close');
      expect(row?.metadata.refusalCode).toBe('pos.session_not_owned');
      expect(row?.metadata.tillSessionId).toBe(shop.session.sessionId);
      // Read from the session row, which the close reads before the routine —
      // so a close that got that far carries the branch it was aimed at.
      expect(row?.metadata.branchId).toBe(shop.business.branchX);
      expect(row?.metadata.figures?.['closingCountMinor']).toBe('0');
    });
  });

  describe('§C — a refused POS CHECKOUT carries its TILL', () => {
    it('the empty basket was refused', () => {
      expect(checkoutRefusal.status, JSON.stringify(checkoutRefusal.body)).toBe(409);
      expect(answered(checkoutRefusal.body)).toBe('pos.checkout_cart_empty');
    });

    it('its row is a `sale.commit` refusal — because a checkout IS a sale commit — and names the till it was rung up on', async () => {
      const rows = (await rowsFor('sale.commit.refused')).filter((r) => r.entity_id === checkoutRefusal.saleId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.entity).toBe('sale');
      expect(row?.metadata.operation).toBe('sale.commit');
      expect(row?.metadata.refusalCode).toBe('pos.checkout_cart_empty');
      // The ONE thing that distinguishes this from the same sale committed
      // through `POST /v1/sales`, and the reason `AuditRefusalEntry` carries
      // the column at all.
      expect(row?.metadata.tillSessionId).toBe(shop.session.sessionId);
      // Refused before the planner ran, so there is no digest and no branch —
      // and NULL here is the truth rather than a gap.
      expect(row?.metadata.intentSha256).toBeNull();
      expect(row?.metadata.branchId).toBeNull();
    });
  });

  describe('§D — a refused SALE COMMIT (`0078:1002` audits only the success)', () => {
    it('the oversell was refused with the stock reason', () => {
      expect(saleRefusal.status, JSON.stringify(saleRefusal.body)).toBe(409);
      expect(answered(saleRefusal.body)).toBe('inventory.insufficient_stock');
    });

    it('the row survived the abort, under the operation the command exercised', async () => {
      const rows = (await rowsFor('sale.commit.refused')).filter((r) => r.entity_id === saleRefusal.saleId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata.operation).toBe('sale.commit');
      // The code the merchant was answered with, which is the inventory
      // module's and not this surface's — one code, one contract, wherever it
      // is raised.
      expect(rows[0]?.metadata.refusalCode).toBe('inventory.insufficient_stock');
    });

    it('and it carries the intent digest and the branch, which this refusal happened late enough to know', async () => {
      const m = (await rowsFor('sale.commit.refused')).filter((r) => r.entity_id === saleRefusal.saleId)[0]?.metadata;
      expect(m?.intentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m?.branchId).toBe(shop.business.branchX);
      // NOT a POS sale: `POST /v1/sales` is the generic surface and has no till.
      expect(m?.tillSessionId).toBeNull();
    });

    it('its figures are the REQUEST figures, because `sale_commit` recomputes every amount itself', async () => {
      const f = (await rowsFor('sale.commit.refused')).filter((r) => r.entity_id === saleRefusal.saleId)[0]?.metadata.figures ?? {};
      expect(f['settlementMode']).toBe('cash');
      expect(f['warehouseId']).toBe(shop.business.w1);
      expect(f['documentDate']).toBe(shop.day);
      expect(f['lineCount']).toBe('1');
      expect(String(f['lines'])).toContain('999999');
      for (const [k, v] of Object.entries(f)) expect(typeof v, `${k} must not be a number in a figures object`).not.toBe('number');
    });
  });

  describe('§E — a refused CART command, on both of the cart’s two operations', () => {
    it('the removal of a line this basket never held was refused', () => {
      expect(cartRemoveRefusal.status, JSON.stringify(cartRemoveRefusal.body)).toBe(404);
      expect(answered(cartRemoveRefusal.body)).toBe('pos.cart_line_not_found');
    });

    it('its row names the removal operation, the till and the line that was addressed', async () => {
      const rows = await rowsFor('pos.cart_remove_line.refused');
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.entity).toBe('pos_cart_line');
      expect(row?.entity_id).toBe(cartRemoveRefusal.cartLineId);
      expect(row?.metadata.operation).toBe('pos.cart_remove_line');
      expect(row?.metadata.refusalCode).toBe('pos.cart_line_not_found');
      expect(row?.metadata.tillSessionId).toBe(shop.session.sessionId);
      expect(row?.metadata.figures?.['command']).toBe('cart.remove_line');
    });

    it('the scan of a product that does not exist was refused — as `inventory.payload_invalid`, which is what it MEASURABLY answers', () => {
      expect(cartAddRefusal.status, JSON.stringify(cartAddRefusal.body)).toBe(400);
      expect(answered(cartAddRefusal.body)).toBe('inventory.payload_invalid');
    });

    it('and its row carries that code under the set-line operation, with the command that was attempted', async () => {
      const rows = await rowsFor('pos.cart_set_line.refused');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata.operation).toBe('pos.cart_set_line');
      expect(rows[0]?.metadata.refusalCode).toBe('inventory.payload_invalid');
      expect(rows[0]?.metadata.figures?.['command']).toBe('cart.add_line');
      expect(rows[0]?.metadata.figures?.['quantity']).toBe('1');
      expect(rows[0]?.metadata.tillSessionId).toBe(shop.session.sessionId);
    });
  });

  describe('§F — a SUCCESS writes no refusal row, so this suite cannot pass by auditing everything', () => {
    it('the colleague opened their own till', () => {
      expect(success.status).toBe(200);
    });

    it('and the `.refused` census did not move', () => {
      expect(success.refusedAfter).toBe(success.refusedBefore);
    });

    it('the successful open wrote the routine’s own success row and no `.refused` one', async () => {
      const opened = await rowsFor('pos.till_session_opened');
      // Two: the cashier's from the fixture, and the colleague's from §F.
      expect(opened.length).toBeGreaterThanOrEqual(2);
      expect(await rowsFor('pos.session_open')).toEqual([]);
    });

    it('every refusal this suite drove is accounted for, and nothing else was audited as refused', () => {
      // Six refusals, six rows. A seventh would mean a success had been
      // audited as a refusal somewhere; a fifth would mean one was lost.
      expect(success.refusedAfter).toBe(6);
    });
  });

  describe('§G — the audit is per ATTEMPT', () => {
    it('a second refused removal adds exactly one more row, so a row is not per session or per cart', async () => {
      const before = (await rowsFor('pos.cart_remove_line.refused')).length;
      const res = await t.request
        .delete(`/v1/pos/till-sessions/${shop.session.sessionId}/cart-lines/${randomUUID()}`)
        .set(asMember(shop.cashier, shop.business.businessId))
        .send({});
      expect(res.status).toBe(404);
      expect((await rowsFor('pos.cart_remove_line.refused')).length).toBe(before + 1);
    });

    it('and a SUCCESSFUL scan of a real product adds none', async () => {
      const before = await refusedCount();
      await scan(t, shop, shop.business.piece.productId, '1');
      expect(await refusedCount()).toBe(before);
    });
  });
});
