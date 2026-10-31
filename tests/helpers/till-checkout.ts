/**
 * THE POS CHECKOUT FIXTURE — a shop, a stocked product, a till and a basket,
 * built through the PRODUCT'S OWN ROUTES and nothing else (TL-P4-S3-R1).
 *
 * The Tech Lead's standing ruling is that «a sale endpoint that requires
 * manual SQL setup is not a complete product path», and `daftar_app` holds
 * `SELECT` only on both POS relations (`0079:693`), so a basket cannot be
 * inserted by hand even deliberately. Everything below is an HTTP call a
 * cashier could make: onboard, configure, stock, open the till, scan.
 *
 * Deliberately NOT named `pos-s3-*` or `phase4-pos-*`: those basenames are the
 * P4-S3 gate's derived roster (`scripts/phase4-s3-gate.ts:111`), and a helper
 * with no `it(` in it would be rostered as a suite the runner finds nothing
 * in — which `rosterRedProofProblems` fails, correctly.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Pool } from 'pg';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from './inventory-commands';
import { addMember } from './merchant-reads';
import { openTillSession, terminalCode, type OpenTillSession } from './pos-till-sessions';
import type { TestApp } from './test-app';

/** One shop, its cashier, a till, and a stocked product the till can scan. */
export interface CheckoutShop {
  readonly business: S3Business;
  /** The actor who onboarded and who holds every key. The till's own cashier. */
  readonly cashier: HttpActor;
  /** A SECOND member of the same business with the same keys: a colleague, for OD-P4-09. */
  readonly colleague: HttpActor;
  readonly session: OpenTillSession;
  readonly day: string;
}

/** The headers of this shop's own cashier. */
export const asCashier = (shop: CheckoutShop): Record<string, string> => asMember(shop.cashier, shop.business.businessId);

/**
 * Give a product stock through `POST /v1/inventory/adjustments`, the real
 * inbound command. `unitCost` is non-round so the COGS a sale releases is a
 * real quotient and not a number that would agree by accident.
 */
export async function stockProduct(
  t: TestApp,
  by: HttpActor,
  businessId: string,
  warehouseId: string,
  productId: string,
  qty: string,
  day: string,
): Promise<void> {
  const res = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(by, businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId,
      occurredOn: day,
      reason: 'the POS checkout fixture',
      lines: [{ productId, quantity: qty, unitCost: '3.00' }],
    });
  expect(res.status, `the stock of ${productId} could not be seeded: ${JSON.stringify(res.body)}`).toBe(201);
}

/**
 * A whole shop, ready to check out: onboarded, stocked, with an OPEN till
 * owned by `cashier` and a colleague who is a real second member.
 *
 * `onHand` is generous by default so no case is refused for the stock rather
 * than for the law under test — a 409 that meant `insufficient_stock` is a
 * refusal that proves nothing about a checkout.
 */
export async function seedCheckoutShop(t: TestApp, label: string, onHand = '100'): Promise<CheckoutShop> {
  const cashier = await registerActor(t, `POS checkout cashier ${label}`);
  const business = await onboardS3Business(t, cashier, label);
  const colleague = await addMember(t, cashier, business, `POS checkout colleague ${label}`, 'cashier');
  const day = await today();
  await stockProduct(t, cashier, business.businessId, business.w1, business.piece.productId, onHand, day);
  await stockProduct(t, cashier, business.businessId, business.w1, business.piece2.productId, onHand, day);
  const session = await openTillSession(
    t,
    cashier,
    business.businessId,
    { branchId: business.branchX, warehouseId: business.w1 },
    { terminalCode: terminalCode(label.slice(0, 8)) },
  );
  return { business, cashier, colleague, session, day };
}

/** Scan one product into the till's basket. Answers the server-minted cart line id. */
export async function scan(t: TestApp, shop: CheckoutShop, productId: string, quantity = '1', by: HttpActor = shop.cashier): Promise<string> {
  const res = await t.request
    .post(`/v1/pos/till-sessions/${shop.session.sessionId}/cart-lines`)
    .set(asMember(by, shop.business.businessId))
    .send({ productId, variantId: null, quantity });
  expect(res.status, `the scan of ${productId} was refused: ${JSON.stringify(res.body)}`).toBe(201);
  const lines = res.body.lines as { cartLineId: string }[];
  const last = lines[lines.length - 1];
  expect(last, 'the append answered with no line').toBeDefined();
  return (last as { cartLineId: string }).cartLineId;
}

/**
 * Empty the basket through the REAL `DELETE .../cart-lines/:cartLineId`, one
 * line at a time, so a case that asserts over the live lines starts from a
 * basket it put there itself.
 *
 * It is the product path and not a `TRUNCATE`: `daftar_app` could not delete a
 * cart row anyway, and a fixture that reached around the routine would be
 * arranging a state no till can reach.
 */
export async function clearBasket(t: TestApp, shop: CheckoutShop): Promise<void> {
  const live = (
    await (await import('./test-app')).ownerPool().query<{
      id: string;
    }>(`SELECT id::text AS id FROM pos_cart_lines WHERE business_id = $1 AND till_session_id = $2 AND removed_at IS NULL ORDER BY line_no`, [shop.business.businessId, shop.session.sessionId])
  ).rows.map((r) => r.id);
  for (const id of live) {
    const res = await t.request
      .delete(`/v1/pos/till-sessions/${shop.session.sessionId}/cart-lines/${id}`)
      .set(asMember(shop.cashier, shop.business.businessId))
      .send({});
    expect(res.status, `the basket could not be cleared: ${JSON.stringify(res.body)}`).toBe(200);
  }
}

/** The checkout body. The caller supplies the identity and the day; nothing else is spellable. */
export function checkoutBody(saleId: string, day: string): Record<string, unknown> {
  return { saleId, settlementMode: 'cash', customerId: null, documentDate: day, dueDate: null, taxMinor: '0', notes: null };
}

/** `POST .../checkout`, as `by` (the shop's own cashier unless another is named). */
export function checkout(t: TestApp, shop: CheckoutShop, saleId: string, by: HttpActor = shop.cashier, businessId = shop.business.businessId) {
  return t.request.post(`/v1/pos/till-sessions/${shop.session.sessionId}/checkout`).set(asMember(by, businessId)).send(checkoutBody(saleId, shop.day));
}

/**
 * THE WHOLE WORLD A CHECKOUT TOUCHES, counted as the SCHEMA OWNER — who
 * bypasses row security, so a row written and merely hidden from the caller is
 * still counted here.
 *
 * Every relation the atomic law names is in it, plus the basket: "no sale
 * committed with the cart unconsumed" and "no cart consumed with no sale" are
 * both claims about this one census, which is why they are read together and
 * never one at a time.
 */
export interface CheckoutCensus {
  readonly sales: number;
  readonly saleItems: number;
  readonly invoices: number;
  readonly invoiceItems: number;
  readonly movements: number;
  readonly bindings: number;
  readonly journalEntries: number;
  readonly journalLines: number;
  readonly liveCartLines: number;
  readonly tombstonedCartLines: number;
}

const count = async (pool: Pool, sql: string, params: readonly unknown[]): Promise<number> =>
  Number((await pool.query<{ n: string }>(sql, [...params])).rows[0]?.n ?? '-1');

export async function census(pool: Pool, businessId: string, tillSessionId: string): Promise<CheckoutCensus> {
  const where = (relation: string): string => `SELECT count(*)::text AS n FROM ${relation} WHERE business_id = $1`;
  return {
    sales: await count(pool, where('sales'), [businessId]),
    saleItems: await count(pool, where('sale_items'), [businessId]),
    invoices: await count(pool, where('invoices'), [businessId]),
    invoiceItems: await count(pool, where('invoice_items'), [businessId]),
    movements: await count(pool, `${where('stock_movements')} AND source_type = 'sale'`, [businessId]),
    bindings: await count(pool, `${where('accounting_source_bindings')} AND source_type IN ('sale', 'invoice')`, [businessId]),
    journalEntries: await count(pool, where('journal_entries'), [businessId]),
    journalLines: await count(
      pool,
      `SELECT count(*)::text AS n FROM journal_lines l JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id WHERE l.business_id = $1`,
      [businessId],
    ),
    liveCartLines: await count(pool, `SELECT count(*)::text AS n FROM pos_cart_lines WHERE business_id = $1 AND till_session_id = $2 AND removed_at IS NULL`, [
      businessId,
      tillSessionId,
    ]),
    tombstonedCartLines: await count(
      pool,
      `SELECT count(*)::text AS n FROM pos_cart_lines WHERE business_id = $1 AND till_session_id = $2 AND removed_at IS NOT NULL`,
      [businessId, tillSessionId],
    ),
  };
}

/**
 * THE ORPHAN LAW (TL-P4-S3-R1 test 16), as one function over two censuses.
 *
 * A refused checkout must leave the world EXACTLY as it found it. Every
 * relation is compared, not a selected few, because the orphan the law is
 * about is the one nobody thought to count: a journal entry with no
 * commercial source, a stock movement with no sale, an invoice with no sale,
 * a tombstone with no sale.
 */
export function expectUntouched(before: CheckoutCensus, after: CheckoutCensus, what: string): void {
  expect(after, `${what}: the refused checkout changed the world — nothing may commit when any step fails`).toEqual(before);
}

/**
 * THE FINANCIAL HALF of the orphan law, for a case in which SOMEBODY ELSE
 * legitimately changed the basket while the checkout ran.
 *
 * The cart counts are deliberately excluded and nothing else is. A concurrent
 * scan or removal is another transaction's committed work and must survive;
 * what must not have moved is the sale, the invoice, the movements, the
 * bindings and the ledger. The cart's own outcome is then asserted ROW BY ROW
 * by the case itself — which is stronger than a count, because it names which
 * lines are still in the basket.
 */
export function expectNoFinancialChange(before: CheckoutCensus, after: CheckoutCensus, what: string): void {
  const financial = ({
    liveCartLines: _live,
    tombstonedCartLines: _dead,
    ...rest
  }: CheckoutCensus): Omit<CheckoutCensus, 'liveCartLines' | 'tombstonedCartLines'> => rest;
  expect(financial(after), `${what}: the refused checkout left financial or inventory truth behind`).toEqual(financial(before));
}

/** The machine code of a refusal, wherever the envelope carries it. */
export function refusalCode(body: unknown): string | null {
  const seen: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      seen.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  walk((body as { error?: unknown } | undefined)?.error ?? body, 0);
  return seen.find((s) => /^(pos|sale|invoice|customer|inventory)\.[a-z_]+$/.test(s)) ?? null;
}
