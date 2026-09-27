/**
 * P3-S7 §5 — THE API READ FIXTURES (docs PHASE_3_S7_CONTRACT §5.1).
 *
 * One business seeded through the real Nest application, composed from the
 * S4/S5/S6 helpers, with every shape the S7 reads must answer for:
 *
 * - two branches (X, Y) and three warehouses: W1 (home X), W2 (home Y) and
 *   W3 (home X, ALSO serving Y through `branch_warehouses`);
 * - a business-wide owner, the built-in manager ASSIGNED to branch Y (so it
 *   reaches W2 and W3, never W1), and a cashier;
 * - tracked products: simple (`piece`, `piece2`, `dec2`), a variant product
 *   (two merchant variants, no base), and `mixed` — a simple product that
 *   received stock and THEN gained a merchant variant, so its base variant
 *   holds pre-variant stock; named in ar/en/tr (some locales deliberately
 *   missing, for the `ar` fallback);
 * - purchases of one supplier: a draft, a received one, a partly returned
 *   one (W2), a reversed one, one paid in full and then partly returned (a
 *   credit note with remaining value), a part-paid one (W3) and a
 *   foreign-currency (USD) one;
 * - A2: a second business of the SAME owner in the same tenant, and B: a
 *   business of another tenant, for the isolation DENY cases.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Response } from 'supertest';
import { ownerPool, type TestApp } from './test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from './inventory-commands';
import { addMerchantVariant, addTrackedProduct } from './stock-ledger';
import {
  httpDraft,
  httpMethod,
  httpPay,
  httpReceived,
  httpReturn,
  payBody,
  returnToCredit,
  seedSettlementAccounts,
  stateRate,
  type HttpPurchase,
  type HttpPurchaseInput,
  type SettlementAccounts,
} from './supplier-settlement';

export interface MixedProduct {
  readonly productId: string;
  readonly baseVariantId: string;
  readonly merchantVariantId: string;
}

export interface ReadsWorld {
  readonly t: TestApp;
  readonly day: string;
  readonly owner: HttpActor;
  /** The built-in manager, branch scope `assigned` to Y: reaches W2 and W3. */
  readonly manager: HttpActor;
  readonly cashier: HttpActor;
  readonly A: S3Business;
  /** Home X, also serving Y. */
  readonly w3: string;
  /** Same owner, same tenant, another business. */
  readonly A2: S3Business;
  /** Another tenant's business with its own owner. */
  readonly B: S3Business;
  readonly ownerB: HttpActor;
  readonly acc: SettlementAccounts;
  /** An active cash method of A. */
  readonly method: string;
  readonly mixed: MixedProduct;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly purchases: {
    readonly draft: HttpPurchase;
    readonly received: HttpPurchase;
    readonly partlyReturned: HttpPurchase;
    readonly reversed: HttpPurchase;
    readonly paid: HttpPurchase;
    readonly partPaid: HttpPurchase;
    readonly foreign: HttpPurchase;
  };
  readonly creditNoteId: string;
}

/** `n` civil days before `day`. */
export function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** States a product's names, replacing any it had. */
export async function nameProduct(
  businessId: string,
  productId: string,
  names: { readonly ar?: string; readonly en?: string; readonly tr?: string },
): Promise<void> {
  const pool = ownerPool();
  // Upsert first, then drop the other locales: a product always keeps one name.
  for (const [locale, name] of Object.entries(names)) {
    await pool.query(
      `INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, product_id, locale) DO UPDATE SET name = EXCLUDED.name`,
      [businessId, productId, locale, name],
    );
  }
  await pool.query('DELETE FROM product_translations WHERE business_id = $1 AND product_id = $2 AND NOT (locale = ANY($3::text[]))', [
    businessId,
    productId,
    Object.keys(names),
  ]);
}

/** States a merchant variant's attributes (its display name). */
export async function nameVariant(businessId: string, variantId: string, attributes: Readonly<Record<string, string>>): Promise<void> {
  await ownerPool().query('UPDATE product_variants SET attributes = $3::jsonb WHERE business_id = $1 AND id = $2', [
    businessId,
    variantId,
    JSON.stringify(attributes),
  ]);
}

/** A supplier with a stated name, created by `by` through the API. */
export async function namedSupplier(t: TestApp, by: HttpActor, biz: S3Business, name: string): Promise<string> {
  const id = randomUUID();
  const r = await t.request.post('/v1/suppliers').set(asMember(by, biz.businessId)).send({ supplierId: id, name });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

/** A member added by the owner under a built-in role, optionally assigned to branches. */
export async function addMember(
  t: TestApp,
  owner: HttpActor,
  biz: S3Business,
  name: string,
  roleKey: string,
  branchIds?: readonly string[],
): Promise<HttpActor> {
  const actor = await registerActor(t, name);
  const m = await t.request.post('/v1/businesses/current/members').set(asMember(owner, biz.businessId)).send({ email: actor.email, roleKey });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  if (branchIds !== undefined) {
    const s = await t.request
      .patch(`/v1/businesses/current/members/${actor.userId}/branch-scope`)
      .set(asMember(owner, biz.businessId))
      .send({ mode: 'assigned', branchIds });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
  }
  return actor;
}

/** A third warehouse through the API, homed on `branchId`. */
export async function addHttpWarehouse(t: TestApp, owner: HttpActor, biz: S3Business, name: string, branchId: string): Promise<string> {
  const r = await t.request.post('/v1/businesses/current/warehouses').set(asMember(owner, biz.businessId)).send({ name, branchId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(r.body.id);
}

/** Associates a warehouse with one more branch through the API. */
export async function associate(t: TestApp, owner: HttpActor, biz: S3Business, warehouseId: string, branchId: string): Promise<void> {
  const r = await t.request.post(`/v1/businesses/current/warehouses/${warehouseId}/branches`).set(asMember(owner, biz.businessId)).send({ branchId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** A GET by `by` in `businessId`, with an optional `Accept-Language`. */
export function readAs(t: TestApp, by: HttpActor, businessId: string, path: string, locale?: string): Promise<Response> {
  const req = t.request.get(path).set(asMember(by, businessId));
  return locale === undefined ? req : req.set('Accept-Language', locale);
}

/** A 200 body, asserted. */
export async function ok<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as T;
}

/** Reverses a received purchase through the API. */
export async function httpReverse(t: TestApp, by: HttpActor, biz: S3Business, p: HttpPurchase, date: string): Promise<void> {
  const r = await t.request
    .post(`/v1/purchases/${p.purchaseId}/reversal`)
    .set(asMember(by, biz.businessId))
    .send({ reversalDate: date, reason: 'Received against the wrong supplier' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Pays `amountMinor` of one purchase in its own currency through the API. */
export async function httpPayPart(
  t: TestApp,
  by: HttpActor,
  biz: S3Business,
  method: string,
  p: HttpPurchase,
  amountMinor: string,
  date?: string,
): Promise<void> {
  const r = await httpPay(
    t,
    by,
    biz,
    payBody(p.supplierId, method, date ?? p.documentDate, [{ purchaseId: p.purchaseId, paymentAmountMinor: amountMinor }], { currencyCode: p.currency }),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** A received purchase of the world's supplier. */
export function receive(w: Pick<ReadsWorld, 't' | 'owner' | 'A' | 'supplierId'>, input: HttpPurchaseInput): Promise<HttpPurchase> {
  return httpReceived(w.t, w.owner, w.A, { supplierId: w.supplierId, ...input });
}

/** The §5 world. */
export async function seedReadsWorld(t: TestApp, label: string): Promise<ReadsWorld> {
  const pool = ownerPool();
  const day = await today();
  const owner = await registerActor(t, `S7 ${label} owner`);
  const A = await onboardS3Business(t, owner, `s7${label}`);
  const A2 = await onboardS3Business(t, owner, `s7${label}2`, A.tenantId);
  const ownerB = await registerActor(t, `S7 ${label} other owner`);
  const B = await onboardS3Business(t, ownerB, `s7${label}b`);
  await stateRate(A, 'USD', 'ILS', '3.7000000000', `${daysBefore(day, 30)}T00:00:00Z`);

  const w3 = await addHttpWarehouse(t, owner, A, 'W3', A.branchX);
  await associate(t, owner, A, w3, A.branchY);
  const manager = await addMember(t, owner, A, `S7 ${label} manager`, 'manager', [A.branchY]);
  const cashier = await addMember(t, owner, A, `S7 ${label} cashier`, 'cashier');

  await nameProduct(A.businessId, A.piece.productId, { ar: 'تفاح', en: 'Apple', tr: 'Elma' });
  await nameProduct(A.businessId, A.piece2.productId, { ar: 'موز', en: 'Banana' });
  await nameProduct(A.businessId, A.dec2.productId, { ar: 'سلك' });
  await nameProduct(A.businessId, A.variantProduct.productId, { ar: 'قميص', en: 'Shirt', tr: 'Gömlek' });
  await nameVariant(A.businessId, A.variantProduct.variantIds[0], { size: 'L' });
  await nameVariant(A.businessId, A.variantProduct.variantIds[1], { size: 'M' });
  await nameProduct(A.businessId, A.untracked.productId, { en: 'Gift card' });

  const acc = await seedSettlementAccounts(pool, A);
  const method = await httpMethod(t, owner, A, acc.settlement.cash, { systemType: 'cash' });
  const supplierName = `Supplier ${label} ${randomUUID().slice(0, 4)}`;
  const supplierId = await namedSupplier(t, owner, A, supplierName);
  const w = { t, owner, A, supplierId };

  // The mixed product: stock received while simple, then a merchant variant.
  const base = await addTrackedProduct(pool, A, 'piece', 0);
  await nameProduct(A.businessId, base.productId, { ar: 'مزيج', en: 'Mixed' });
  await receive(w, { warehouseId: A.w1, lines: [{ productId: base.productId, quantity: '3', unitPrice: '2.00' }] });
  const merchantVariantId = await addMerchantVariant(pool, A.businessId, base.productId);
  await nameVariant(A.businessId, merchantVariantId, { colour: 'Red' });
  const mixed: MixedProduct = { productId: base.productId, baseVariantId: base.variantId, merchantVariantId };

  const draft = await httpDraft(t, owner, A, { supplierId, warehouseId: A.w1 });
  const received = await receive(w, {
    warehouseId: A.w1,
    documentDate: daysBefore(day, 6),
    lines: [{ productId: A.piece.productId, quantity: '4', unitPrice: '12.50' }],
  });
  const partlyReturned = await receive(w, {
    warehouseId: A.w2,
    documentDate: daysBefore(day, 5),
    lines: [{ productId: A.piece2.productId, quantity: '5', unitPrice: '10.00' }],
  });
  await httpReturn(t, owner, A, partlyReturned, '2');
  const reversed = await receive(w, { warehouseId: A.w1, lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '9.00' }] });
  await httpReverse(t, owner, A, reversed, day);
  const credit = await returnToCredit(t, owner, A, method, {
    supplierId,
    warehouseId: A.w1,
    documentDate: daysBefore(day, 4),
    lines: [{ productId: A.dec2.productId, quantity: '2.50', unitPrice: '8.00' }],
    quantity: '1',
  });
  const partPaid = await receive(w, {
    warehouseId: w3,
    documentDate: daysBefore(day, 3),
    lines: [{ productId: A.piece.productId, quantity: '10', unitPrice: '3.00' }],
  });
  await httpPayPart(t, owner, A, method, partPaid, '1000');
  const foreign = await receive(w, {
    warehouseId: A.w1,
    currency: 'USD',
    documentDate: daysBefore(day, 2),
    lines: [{ productId: A.piece2.productId, quantity: '2', unitPrice: '5.00' }],
  });
  return {
    t,
    day,
    owner,
    manager,
    cashier,
    A,
    w3,
    A2,
    B,
    ownerB,
    acc,
    method,
    mixed,
    supplierId,
    supplierName,
    purchases: { draft, received, partlyReturned, reversed, paid: credit.purchase, partPaid, foreign },
    creditNoteId: must(credit.creditNoteId),
  };
}

/** One stock line of a movement command: the product, and a merchant variant only when it has them. */
export interface StockLine {
  readonly productId: string;
  readonly variantId?: string;
  readonly quantity: string;
}

/** Moves stock between two warehouses through the API. */
export async function httpTransfer(
  t: TestApp,
  by: HttpActor,
  biz: S3Business,
  sourceWarehouseId: string,
  destinationWarehouseId: string,
  lines: readonly StockLine[],
): Promise<void> {
  const r = await t.request
    .post('/v1/inventory/transfers')
    .set(asMember(by, biz.businessId))
    .send({ transferId: randomUUID(), sourceWarehouseId, destinationWarehouseId, lines });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** A signed stock adjustment through the API (a gain states `unitCost`). */
export async function httpAdjust(
  t: TestApp,
  by: HttpActor,
  biz: S3Business,
  warehouseId: string,
  lines: readonly (StockLine & { readonly unitCost?: string })[],
): Promise<void> {
  const r = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(by, biz.businessId))
    .send({ adjustmentId: randomUUID(), warehouseId, occurredOn: await today(), reason: 'counted by hand', lines });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
