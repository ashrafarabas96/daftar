/**
 * P3-S6 T-11 — THE GOLDEN SETTLEMENTS, END TO END THROUGH THE API
 * (docs/PHASE_3_S6_CONTRACT.md §6 T-11; DAFTAR_GOLDEN_REGRESSION_SUITE
 * GOLD-58, GOLD-59, GOLD-61, GOLD-73; ACCOUNTING_RULES §9).
 *
 * Every figure is produced by the real commands — a received purchase, a
 * real payment, a real S5 return, a real credit allocation and a real
 * refund — never by a fixture, and every entry is read back line for line:
 *
 *   - GOLD-58: a 1000 purchase PAID IN FULL (the stock's average 90), a
 *     return of 5 → `Dr 1150 500 / Cr Inventory 450 / Cr 6200 50`, no AP
 *     line, no revenue; the supplier's cash then settles 1150 to exactly zero.
 *   - GOLD-59: paid 700 of 1000, a return of 500 → `Dr AP 300 + Dr 1150 200
 *     / Cr Inventory 450 / Cr 6200 50`; the purchase is left at zero.
 *   - GOLD-61: a 500 credit applied to a new 800 purchase → `Dr AP 500 /
 *     Cr 1150 500`; then cash of 300 only; the derived outstanding is 0.
 *   - GOLD-73: a 100 USD note carried at 360 received as 90 EUR @ 4.10 →
 *     `Dr Bank 369 / Cr 1150 360 / Cr 4900 9`; remaining 0 USD.
 */
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  allocateBody,
  httpMethod,
  httpPay,
  httpReceived,
  httpReturn,
  httpSupplier,
  noteOf,
  outstandingOf,
  payBody,
  refundBody,
  returnToCredit,
  seedSettlementAccounts,
  settlementEntry,
  settlementLedgerAp,
  stateRate,
  type HttpPurchase,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let bank: string;
let cash: string;
let day: string;

function ago(n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 gold owner');
  A = await onboardS3Business(t, owner, 's6gold');
  acc = await seedSettlementAccounts(ownerPool(), A);
  bank = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  cash = await httpMethod(t, owner, A, acc.settlement.cash, { systemType: 'cash' });
  await stateRate(A, 'USD', 'ILS', '3.6000000000', `${ago(10)}T00:00:00Z`);
  await stateRate(A, 'EUR', 'ILS', '4.1000000000', `${ago(10)}T00:00:00Z`);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const post = (path: string, body: Record<string, unknown>): Promise<Response> => t.request.post(path).set(asMember(owner, A.businessId)).send(body);

/** An entry as `side key base` rows (the posting account named by its system key), in line order. */
async function entry(sourceType: string, sourceId: string): Promise<string[]> {
  const e = must(await settlementEntry(ownerPool(), A.businessId, sourceType, sourceId), `${sourceType} ${sourceId} posted`);
  return e.lines.map((l) => `${l.side} ${l.systemKey ?? '(custom)'} ${l.baseAmountMinor}`);
}

/** The same rows with each line's transaction currency and amount. */
async function entryTxn(sourceType: string, sourceId: string): Promise<string[]> {
  const e = must(await settlementEntry(ownerPool(), A.businessId, sourceType, sourceId), `${sourceType} ${sourceId} posted`);
  return e.lines.map((l) => `${l.side} ${l.systemKey ?? '(custom)'} ${l.baseAmountMinor} ${l.currency} ${l.txnAmountMinor} @${Number(l.rate)}`);
}

/** A 10-piece purchase at 80.00 then one at 100.00 into (`productId`, w1): the stock's average is 90.00. */
async function atAverage90(productId: string): Promise<HttpPurchase> {
  const supplierId = await httpSupplier(t, owner, A);
  await httpReceived(t, owner, A, { supplierId, lines: [{ productId, quantity: '10', unitPrice: '80.00' }] });
  const p = await httpReceived(t, owner, A, { supplierId, lines: [{ productId, quantity: '10', unitPrice: '100.00' }] });
  expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toEqual({ o: 100000n, t: 100000n, b: 100000n });
  return p;
}

async function pay(p: HttpPurchase, method: string, amountMinor: string, currencyCode = 'ILS'): Promise<string> {
  const body = payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: amountMinor }], { currencyCode });
  const r = await httpPay(t, owner, A, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return must((body.allocations as { allocationId: string }[])[0]).allocationId;
}

async function noteOfReturn(returnId: string): Promise<string> {
  const r = await ownerPool().query<{ id: string }>(`SELECT id::text FROM supplier_credit_notes WHERE business_id = $1 AND supplier_return_id = $2`, [
    A.businessId,
    returnId,
  ]);
  return must(r.rows[0], 'the return issued a credit note').id;
}

describe('T-11 GOLD-58 — a purchase paid in full, then a return', () => {
  it('Dr 1150 500 / Cr Inventory 450 / Cr 6200 50 with no AP line; the supplier’s cash settles 1150 to zero', async () => {
    const p = await atAverage90(A.piece.productId);
    const paid = await pay(p, bank, '100000');
    expect(await entry('supplier_payment', paid)).toEqual(['D accounts_payable 100000', 'C bank 100000']);
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o, 'AP = 0 before the return').toBe(0n);

    const ret = await httpReturn(t, owner, A, p, '5');
    const returnId = String(ret.returnId);
    const lines = await entry('supplier_return', returnId);
    expect(lines.slice().sort()).toEqual(['C inventory 45000', 'C purchase_price_variance 5000', 'D supplier_receivable 50000'].sort());
    expect(
      lines.some((l) => l.includes('accounts_payable')),
      'never a silent debit on AP',
    ).toBe(false);
    expect(
      lines.some((l) => /revenue|sales/.test(l)),
      'no revenue',
    ).toBe(false);
    const noteId = await noteOfReturn(returnId);
    expect(await noteOf(ownerPool(), A.businessId, noteId)).toEqual({
      original: 50000n,
      originalCarrying: 50000n,
      remaining: 50000n,
      remainingCarrying: 50000n,
    });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId)).toEqual({ base: 0n, txn: 0n });

    // GOLD-58/2: the supplier's cash settles the receivable to exactly zero.
    const body = refundBody(noteId, cash, day, '50000');
    const r = await post('/v1/supplier-refunds', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await entry('supplier_refund', String(body.refundId))).toEqual(['D cash 50000', 'C supplier_receivable 50000']);
    expect(await noteOf(ownerPool(), A.businessId, noteId)).toMatchObject({ remaining: 0n, remainingCarrying: 0n });
  });
});

describe('T-11 GOLD-59 — paid 700 of 1000, then a return of 500', () => {
  it('Dr AP 300 + Dr 1150 200 / Cr Inventory 450 / Cr 6200 50; the purchase is left at zero', async () => {
    const p = await atAverage90(A.piece2.productId);
    await pay(p, bank, '70000');
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o).toBe(30000n);

    const ret = await httpReturn(t, owner, A, p, '5');
    const returnId = String(ret.returnId);
    expect((await entry('supplier_return', returnId)).sort()).toEqual(
      ['D accounts_payable 30000', 'D supplier_receivable 20000', 'C inventory 45000', 'C purchase_price_variance 5000'].sort(),
    );
    const noteId = await noteOfReturn(returnId);
    expect(await noteOf(ownerPool(), A.businessId, noteId)).toEqual({
      original: 20000n,
      originalCarrying: 20000n,
      remaining: 20000n,
      remainingCarrying: 20000n,
    });
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o, 'the payable is extinguished').toBe(0n);
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId)).toEqual({ base: 0n, txn: 0n });
    const payable = await t.request.get(`/v1/purchases/${p.purchaseId}/payable`).set(asMember(owner, A.businessId));
    expect(payable.status).toBe(200);
    expect(payable.body).toMatchObject({ outstandingBaseMinor: '0', outstandingTxnMinor: '0' });
  });
});

describe('T-11 GOLD-61 — a supplier credit on a later purchase', () => {
  it('Dr AP 500 / Cr 1150 500, then cash of 300 only; the derived outstanding is 0', async () => {
    const note = await returnToCredit(t, owner, A, bank, {
      warehouseId: A.w2,
      lines: [{ productId: A.piece.productId, quantity: '5', unitPrice: '100.00' }],
      quantity: '5',
    });
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId)).toMatchObject({ remaining: 50000n, remainingCarrying: 50000n });
    const p = await httpReceived(t, owner, A, {
      supplierId: note.purchase.supplierId,
      warehouseId: A.w2,
      lines: [{ productId: A.piece.productId, quantity: '8', unitPrice: '100.00' }],
    });
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o).toBe(80000n);

    const alloc = allocateBody(note.creditNoteId, p.purchaseId, day, '50000');
    const a = await post('/v1/supplier-credit-allocations', alloc);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(await entry('supplier_credit_allocation', String(alloc.allocationId))).toEqual(['D accounts_payable 50000', 'C supplier_receivable 50000']);
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o, 'only 300 is left to pay').toBe(30000n);
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId)).toMatchObject({ remaining: 0n, remainingCarrying: 0n });

    const paid = await pay(p, cash, '30000');
    expect(await entry('supplier_payment', paid)).toEqual(['D accounts_payable 30000', 'C cash 30000']);
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o).toBe(0n);
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId)).toEqual({ base: 0n, txn: 0n });
    const keys = await ownerPool().query<{ k: string | null }>(
      `SELECT DISTINCT a.system_key AS k FROM journal_entries e
         JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE e.business_id = $1 AND e.source_type = 'supplier_credit_allocation'`,
      [A.businessId],
    );
    expect(keys.rows.map((r) => r.k).sort(), 'a credit allocation touches no revenue').toEqual(['accounts_payable', 'supplier_receivable']);
  });
});

describe('T-11 GOLD-73 — a USD supplier credit received as EUR', () => {
  it('Dr Bank 369 (90 EUR @ 4.10) / Cr 1150 360 (100 USD @ 3.60) / Cr 4900 9; remaining 0 USD', async () => {
    const note = await returnToCredit(t, owner, A, bank, {
      currency: 'USD',
      warehouseId: A.w2,
      lines: [{ productId: A.piece2.productId, quantity: '1', unitPrice: '100.00' }],
      quantity: '1',
    });
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId), 'CN 100 USD carried at 360').toEqual({
      original: 10000n,
      originalCarrying: 36000n,
      remaining: 10000n,
      remainingCarrying: 36000n,
    });
    const body = refundBody(note.creditNoteId, bank, day, '10000', { receiptCurrencyCode: 'EUR', receiptAmountMinor: '9000' });
    const r = await post('/v1/supplier-refunds', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await entryTxn('supplier_refund', String(body.refundId))).toEqual([
      'D bank 36900 EUR 9000 @4.1',
      'C supplier_receivable 36000 USD 10000 @3.6',
      'C fx_gain 900 ILS 900 @1',
    ]);
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId)).toMatchObject({ remaining: 0n, remainingCarrying: 0n });
  });
});
