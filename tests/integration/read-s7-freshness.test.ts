/**
 * P3-S7 T-03 — A READ RIGHT AFTER A COMMAND SEES IT (docs PHASE_3_S7_CONTRACT
 * A-03, §2(4), §6 T-03).
 *
 * Every command runs through the API and the read follows IMMEDIATELY, with
 * no sleep and no retry: nothing between the ledger and the read can be
 * stale, because there is nothing between them.
 *   - transfer → stock in both warehouses;
 *   - receive → stock and the supplier balance;
 *   - return → returnable quantity and the supplier balance;
 *   - payment → open purchases, the supplier balance and the purchase payable;
 *   - credit allocation → the balance in the merchant's favour;
 *   - stocktake count and finalize → the stocktake detail and the stock.
 * The web half of T-03 (the BFF proxy answers `cache-control: no-store`) is
 * a unit test of the route handler, owned by the web foundation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, today } from '../helpers/inventory-commands';
import { addTrackedProduct } from '../helpers/stock-ledger';
import { allocateBody, httpReturn, type HttpPurchase } from '../helpers/supplier-settlement';
import { httpPayPart, httpTransfer, nameProduct, ok, readAs, receive, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';

interface Amount {
  currency: string;
  amountMinor: string;
}

let t: TestApp;
let w: ReadsWorld;
let fig: { productId: string; variantId: string };

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'fresh');
  fig = await addTrackedProduct(ownerPool(), w.A, 'piece', 0);
  await nameProduct(w.A.businessId, fig.productId, { en: 'Fig' });
});

afterAll(async () => {
  await t.close();
  await resetData();
});

async function onHand(warehouseId: string, productId = fig.productId): Promise<string | undefined> {
  const page = await ok<{ items: { productId: string; onHand: string }[] }>(
    readAs(t, w.owner, w.A.businessId, `/v1/inventory/stock?warehouseId=${warehouseId}&search=Fig&limit=50`, 'en'),
  );
  return page.items.find((r) => r.productId === productId)?.onHand;
}

async function balance(): Promise<{ owed: Amount[]; inYourFavour: Amount[] }> {
  const page = await ok<{ items: { supplierId: string; owed: Amount[]; inYourFavour: Amount[] }[] }>(
    readAs(t, w.owner, w.A.businessId, `/v1/supplier-balances?search=${encodeURIComponent(w.supplierName)}`),
  );
  const row = page.items.find((r) => r.supplierId === w.supplierId);
  if (row === undefined) throw new Error('the supplier is not on its own search page');
  return row;
}

const owedIls = async (): Promise<string | undefined> => (await balance()).owed.find((a) => a.currency === 'ILS')?.amountMinor;

async function returnable(p: HttpPurchase): Promise<string | undefined> {
  const o = await ok<{ lines: { returnableQty: string }[] }>(readAs(t, w.owner, w.A.businessId, `/v1/purchases/${p.purchaseId}/return-options`));
  return o.lines[0]?.returnableQty;
}

describe('T-03 freshness: command, then read at once', () => {
  let p: HttpPurchase;

  it('receive → stock and the supplier balance', async () => {
    const owedBefore = BigInt((await owedIls()) ?? '0');
    expect(await onHand(w.A.w1)).toBe('0');
    p = await receive(w, { warehouseId: w.A.w1, lines: [{ productId: fig.productId, quantity: '6', unitPrice: '5.00' }] });
    expect(await onHand(w.A.w1)).toBe('6');
    expect(await owedIls()).toBe((owedBefore + 3000n).toString(10));
  });

  it('transfer → stock in both warehouses', async () => {
    await httpTransfer(t, w.owner, w.A, w.A.w1, w.A.w2, [{ productId: fig.productId, quantity: '2' }]);
    expect([await onHand(w.A.w1), await onHand(w.A.w2)]).toEqual(['4', '2']);
  });

  it('return → returnable and the supplier balance', async () => {
    const owedBefore = BigInt((await owedIls()) ?? '0');
    expect(await returnable(p)).toBe('4');
    await httpReturn(t, w.owner, w.A, p, '1');
    expect(await returnable(p)).toBe('3');
    expect(await owedIls()).toBe((owedBefore - 500n).toString(10));
  });

  it('payment → open purchases, the supplier balance and the purchase payable', async () => {
    const owedBefore = BigInt((await owedIls()) ?? '0');
    await httpPayPart(t, w.owner, w.A, w.method, p, '700');
    const open = await ok<{ items: { purchaseId: string; outstandingTxnMinor: string }[] }>(
      readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${w.supplierId}/open-purchases?limit=50`),
    );
    expect(open.items.find((r) => r.purchaseId === p.purchaseId)?.outstandingTxnMinor).toBe('1800');
    expect(await owedIls()).toBe((owedBefore - 700n).toString(10));
    const payable = await ok<{ outstandingTxnMinor: string }>(readAs(t, w.owner, w.A.businessId, `/v1/purchases/${p.purchaseId}/payable`));
    expect(payable.outstandingTxnMinor).toBe('1800');
  });

  it('credit allocation → the balance in the merchant’s favour', async () => {
    const favour = async (): Promise<string | undefined> => (await balance()).inYourFavour.find((a) => a.currency === 'ILS')?.amountMinor;
    expect(await favour()).toBe('800');
    const r = await t.request
      .post('/v1/supplier-credit-allocations')
      .set(asMember(w.owner, w.A.businessId))
      .send(allocateBody(w.creditNoteId, p.purchaseId, await today(), '300'));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await favour()).toBe('500');
  });

  it('stocktake count and finalize → the stocktake detail and the stock', async () => {
    const stocktakeId = randomUUID();
    const as = asMember(w.owner, w.A.businessId);
    const opened = await t.request.post('/v1/inventory/stocktakes').set(as).send({ stocktakeId, warehouseId: w.A.w2 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const counted = await t.request
      .put(`/v1/inventory/stocktakes/${stocktakeId}/counts`)
      .set(as)
      .send({ lines: [{ productId: fig.productId, quantity: '5' }] });
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    const detail = await ok<{ status: string; lines: { productId: string; countedQty: string }[] }>(
      readAs(t, w.owner, w.A.businessId, `/v1/inventory/stocktakes/${stocktakeId}`),
    );
    expect(detail.status).toBe('draft');
    expect(detail.lines.find((l) => l.productId === fig.productId)?.countedQty).toBe('5');
    const done = await t.request
      .post(`/v1/inventory/stocktakes/${stocktakeId}/finalize`)
      .set(as)
      .send({ occurredOn: await today() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await onHand(w.A.w2)).toBe('5');
    const after = await ok<{ status: string }>(readAs(t, w.owner, w.A.businessId, `/v1/inventory/stocktakes/${stocktakeId}`));
    expect(after.status).toBe('finalized');
  });
});
