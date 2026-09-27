/**
 * P3-S7 T-07 — WHAT A PURCHASE CAN STILL RETURN, AND WHETHER IT CAN BE UNDONE
 * (docs PHASE_3_S7_CONTRACT A-09(c), §6 T-07; TL-4(b)).
 *
 * `GET /v1/purchases/:purchaseId/return-options` through the real application:
 *   - per line, `returnable = max(0, min(purchased − returned, onHand))`,
 *     derived live: after two partial returns, and after stock is
 *     transferred out of the purchase's warehouse;
 *   - every `reason` value: `not_received` (a draft), `reversed`,
 *     `supplier_inactive` (an archived supplier) and `nothing_left` (fully
 *     returned);
 *   - the reversal verdict, in the reversal's own order: `returned`,
 *     `payment_allocated`, `credit_allocated`, `insufficient_stock`,
 *     `reversed`, `not_received`, and `null` when the receipt can be undone;
 *   - names in the asked locale with the `ar` fallback;
 *   - scope: the manager assigned to Y reads a W2 purchase and gets 404 for a
 *     W1 one; another business's purchase is 404; the cashier is 403.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember } from '../helpers/inventory-commands';
import { addTrackedProduct } from '../helpers/stock-ledger';
import { allocateBody, expectRefusal, httpReturn, type HttpPurchase } from '../helpers/supplier-settlement';
import { httpAdjust, httpTransfer, nameProduct, namedSupplier, ok, readAs, receive, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';

interface Line {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string | null;
  unitDecimals: number;
  purchasedQty: string;
  returnedQty: string;
  returnableQty: string;
  onHandQty: string;
}
interface Options {
  purchaseId: string;
  status: string;
  reversed: boolean;
  supplierActive: boolean;
  returnable: boolean;
  reason: string | null;
  reversible: boolean;
  reversalReason: string | null;
  lines: Line[];
}

let t: TestApp;
let w: ReadsWorld;
let pear: { productId: string; variantId: string };

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'ret');
  pear = await addTrackedProduct(ownerPool(), w.A, 'piece', 0);
  await nameProduct(w.A.businessId, pear.productId, { ar: 'كمثرى', en: 'Pear' });
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const options = (p: Pick<HttpPurchase, 'purchaseId'>, by = w.owner, locale = 'en'): Promise<Options> =>
  ok<Options>(readAs(t, by, w.A.businessId, `/v1/purchases/${p.purchaseId}/return-options`, locale));

/** `[purchased, returned, onHand, returnable]` of every line. */
const quantities = (o: Options): string[][] => o.lines.map((l) => [l.purchasedQty, l.returnedQty, l.onHandQty, l.returnableQty]);

/** The live `returnable` identity of every line. */
function expectIdentity(o: Options): void {
  for (const l of o.lines) {
    const left = Number(l.purchasedQty) - Number(l.returnedQty);
    expect(Number(l.returnableQty), `line ${l.lineId}`).toBe(Math.max(0, Math.min(left, Number(l.onHandQty))));
  }
}

describe('T-07 return options', () => {
  it('returnable = min(purchased − returned, onHand), after two partial returns and after a transfer out', async () => {
    // W2 held 3 of piece2 before this purchase (the world's partly returned one).
    const p = await receive(w, {
      warehouseId: w.A.w2,
      lines: [
        { productId: pear.productId, quantity: '10', unitPrice: '1.00' },
        { productId: w.A.piece2.productId, quantity: '2', unitPrice: '1.00' },
      ],
    });
    const fresh = await options(p, w.owner, 'tr');
    expect(fresh).toMatchObject({
      purchaseId: p.purchaseId,
      status: 'received',
      reversed: false,
      supplierActive: true,
      returnable: true,
      reason: null,
      reversible: true,
      reversalReason: null,
    });
    expect(fresh.lines.map((l) => [l.lineId, l.productId, l.variantId, l.name, l.variantName, l.unitCode, l.unitDecimals])).toEqual([
      [p.lineIds[0], pear.productId, null, 'كمثرى', null, 'piece', 0],
      [p.lineIds[1], w.A.piece2.productId, null, 'موز', null, 'piece', 0],
    ]);
    expect(quantities(fresh)).toEqual([
      ['10', '0', '10', '10'],
      ['2', '0', '5', '2'],
    ]);
    expect(JSON.stringify(fresh).includes(pear.variantId), 'no base variant id').toBe(false);

    await httpReturn(t, w.owner, w.A, p, '2');
    await httpReturn(t, w.owner, w.A, p, '3');
    const returned = await options(p);
    expect(quantities(returned)).toEqual([
      ['10', '5', '5', '5'],
      ['2', '0', '5', '2'],
    ]);
    expect(returned).toMatchObject({ returnable: true, reason: null, reversible: false, reversalReason: 'returned' });
    expectIdentity(returned);

    await httpTransfer(t, w.owner, w.A, w.A.w2, w.A.w1, [{ productId: pear.productId, quantity: '4' }]);
    const moved = await options(p);
    expect(quantities(moved)[0], 'on hand is the binding bound').toEqual(['10', '5', '1', '1']);
    expectIdentity(moved);

    await httpTransfer(t, w.owner, w.A, w.A.w2, w.A.w1, [{ productId: pear.productId, quantity: '1' }]);
    const empty = await options(p);
    expect(quantities(empty)[0]).toEqual(['10', '5', '0', '0']);
    expect(empty.returnable, 'the second line can still go back').toBe(true);

    await httpReturn(t, w.owner, w.A, p, '2', 1);
    const done = await options(p);
    expect(quantities(done)).toEqual([
      ['10', '5', '0', '0'],
      ['2', '2', '3', '0'],
    ]);
    expect(done).toMatchObject({ returnable: false, reason: 'nothing_left' });
    expectIdentity(done);
  });

  it('a fully returned purchase: nothing_left', async () => {
    const p = await receive(w, { warehouseId: w.A.w1, lines: [{ productId: w.A.piece2.productId, quantity: '2', unitPrice: '1.00' }] });
    await httpReturn(t, w.owner, w.A, p, '2');
    const o = await options(p);
    expect(o).toMatchObject({ status: 'received', returnable: false, reason: 'nothing_left', reversible: false, reversalReason: 'returned' });
    expect(quantities(o)[0]?.slice(0, 2)).toEqual(['2', '2']);
    expect(quantities(o)[0]?.[3]).toBe('0');
  });

  it('a draft: not_received, and nothing is returnable though the warehouse holds the goods', async () => {
    const o = await options(w.purchases.draft);
    expect(o).toMatchObject({ status: 'draft', reversed: false, returnable: false, reason: 'not_received', reversible: false, reversalReason: 'not_received' });
    expect(quantities(o)).toEqual([['4', '0', '4', '0']]);
  });

  it('a reversed purchase: reversed', async () => {
    const o = await options(w.purchases.reversed);
    expect(o).toMatchObject({ status: 'reversed', reversed: true, returnable: false, reason: 'reversed', reversible: false, reversalReason: 'reversed' });
    expect(o.lines.every((l) => l.returnableQty === '0')).toBe(true);
  });

  it('an archived supplier: supplier_inactive; the receipt can still be undone', async () => {
    const supplierId = await namedSupplier(t, w.owner, w.A, 'Soon archived');
    const p = await receive({ ...w, supplierId }, { warehouseId: w.A.w1, lines: [{ productId: w.A.piece.productId, quantity: '1', unitPrice: '1.00' }] });
    const s = await ok<{ revision: number }>(readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${supplierId}`));
    const archived = await t.request.post(`/v1/suppliers/${supplierId}/archive`).set(asMember(w.owner, w.A.businessId)).send({ expectedRevision: s.revision });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const o = await options(p);
    expect(o).toMatchObject({ supplierActive: false, returnable: false, reason: 'supplier_inactive', reversible: true, reversalReason: null });
    expect(quantities(o)[0]?.[3], 'the quantity is still derived').toBe('1');
  });

  it('the reversal verdict: payment_allocated, credit_allocated, insufficient_stock', async () => {
    expect(await options(w.purchases.partPaid)).toMatchObject({ reversible: false, reversalReason: 'payment_allocated', returnable: true });
    const alloc = await t.request
      .post('/v1/supplier-credit-allocations')
      .set(asMember(w.owner, w.A.businessId))
      .send(allocateBody(w.creditNoteId, w.purchases.received.purchaseId, w.day, '100'));
    expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
    expect(await options(w.purchases.received)).toMatchObject({ reversible: false, reversalReason: 'credit_allocated' });
    const short = await addTrackedProduct(ownerPool(), w.A, 'piece', 0);
    await nameProduct(w.A.businessId, short.productId, { en: 'Plum' });
    const p = await receive(w, { warehouseId: w.A.w1, lines: [{ productId: short.productId, quantity: '3', unitPrice: '1.00' }] });
    expect(await options(p)).toMatchObject({ reversible: true, reversalReason: null });
    await httpAdjust(t, w.owner, w.A, w.A.w1, [{ productId: short.productId, quantity: '-1' }]);
    const o = await options(p);
    expect(o).toMatchObject({ reversible: false, reversalReason: 'insufficient_stock', returnable: true, reason: null });
    expect(quantities(o)).toEqual([['3', '0', '2', '2']]);
  });

  it('scope: the manager reads a W2 purchase and not a W1 one; another business and the cashier are refused', async () => {
    expect((await options(w.purchases.partlyReturned, w.manager)).purchaseId).toBe(w.purchases.partlyReturned.purchaseId);
    expect((await options(w.purchases.partPaid, w.manager)).purchaseId, 'W3 serves Y').toBe(w.purchases.partPaid.purchaseId);
    const path = `/v1/purchases/${w.purchases.received.purchaseId}/return-options`;
    expectRefusal(await readAs(t, w.manager, w.A.businessId, path), 404, 'purchase.not_found', 'a W1 purchase for the Y manager');
    expectRefusal(await readAs(t, w.owner, w.A2.businessId, path), 404, 'purchase.not_found', 'an A purchase read under A2');
    expectRefusal(await readAs(t, w.owner, w.A.businessId, '/v1/purchases/00000000-0000-4000-8000-000000000000/return-options'), 404, 'purchase.not_found');
    expect((await readAs(t, w.cashier, w.A.businessId, path)).status, 'the cashier holds no purchases.view').toBe(403);
    const bad = await readAs(t, w.owner, w.A.businessId, '/v1/purchases/NOT-A-UUID/return-options');
    expect(bad.status).toBe(400);
  });
});
