/**
 * P3-S6 T-18 — IDEMPOTENCY, CONFLICTS AND THE RETRYABLE REFUSALS
 * (docs/PHASE_3_S6_CONTRACT.md A-15, A-16, §6 T-18; 0068 R-74, R-75, R-76).
 *
 *   - A replay (the same id and the same intent) answers the STORED document
 *     — the same ids and amounts, `replayed: true`, 200 — and writes nothing
 *     (no row, no entry, no audit, no outbox), for the payment, the credit
 *     allocation, the refund and the method commands.
 *   - The same id with another intent is `….idempotency_conflict` (409).
 *   - A rate stated between the bind and the routine is `fx_rate_changed`
 *     (retryable): the re-bound command succeeds; a settlement committed in
 *     between is `settlement_changed`, and the retry succeeds.
 *   - R-74: an allocation id already used by another payment, or twice in one
 *     payment, is `supplier_payment.allocations_invalid` (400), never a raw
 *     key violation.
 *   - R-75: a missing scalar argument reaching the routine (under an honest
 *     assertion over it) is `inventory.payload_invalid`.
 *   - R-76: an unregistered payment or receipt currency is
 *     `purchase.currency_unknown` (400), and so at the routine.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  rolledBack,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  allocateBody,
  committed,
  createMethod,
  expectRefusal,
  httpMethod,
  httpReceived,
  methodBody,
  payBody,
  prepareAllocate,
  preparePay,
  prepareRefund,
  refundBody,
  returnToCredit,
  runS6,
  s6Counts,
  seedSettlementAccounts,
  sqlReturnToCredit,
  stateRate,
  tryS6,
  withElement,
  s6RawAssertionFor,
  withParam,
  type S6Call,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
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
  owner = await registerActor(t, 'S6 idempotency owner');
  A = await onboardS3Business(t, owner, 's6idem');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  await stateRate(A, 'USD', 'ILS', '3.6000000000', `${ago(10)}T00:00:00Z`);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, A.businessId);
const post = (path: string, body: Record<string, unknown>): Promise<Response> => t.request.post(path).set(headers()).send(body);

/** Every count and digest, less the assertion-use rows a replay's own fresh assertion adds. */
async function state(): Promise<Record<string, unknown>> {
  const { inventory_assertion_uses: _uses, ...rest } = await s6Counts(ownerPool(), A.businessId);
  return rest;
}

/** Send `body` to `path` twice: 201, then 200 replayed with the same body and nothing written. */
async function replays(path: string, body: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
  const first = await post(path, body);
  expect(first.status, `${what}: ${JSON.stringify(first.body)}`).toBe(201);
  const before = await state();
  const again = await post(path, body);
  expect(again.status, `${what} replayed: ${JSON.stringify(again.body)}`).toBe(200);
  const strip = (b: unknown): Record<string, unknown> => {
    const { replayed: _r, businessTransactionId: _t, ...rest } = b as Record<string, unknown>;
    return rest;
  };
  expect((again.body as { replayed: boolean }).replayed, what).toBe(true);
  expect(strip(again.body), `${what}: the stored document`).toEqual(strip(first.body));
  expect(await state(), `${what}: the replay writes nothing`).toEqual(before);
  return first.body as Record<string, unknown>;
}

describe('T-18 a replay answers the stored document and writes nothing', () => {
  it('payment, credit allocation, refund and method create', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    await replays(
      '/v1/supplier-payments',
      payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '1000' }], { reference: 'TRF-9' }),
      'payment',
    );
    await replays('/v1/supplier-credit-allocations', allocateBody(note.creditNoteId, p.purchaseId, day, '1500'), 'credit allocation');
    await replays('/v1/supplier-refunds', refundBody(note.creditNoteId, method, day, '2500', { reference: 'RF-9' }), 'refund');
    await replays('/v1/payment-methods', methodBody(acc.settlement.cash, { names: { en: 'Petty cash', ar: 'نثرية' } }), 'method create');
  });
});

describe('T-18 the same id with another intent is a 409 conflict, nothing written', () => {
  it('payment, credit allocation, refund and method create', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    const cases: readonly (readonly [string, Record<string, unknown>, (b: Record<string, unknown>) => Record<string, unknown>, string])[] = [
      [
        '/v1/supplier-payments',
        payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '1000' }]),
        (b) => ({ ...b, reference: 'another reference' }),
        'supplier_payment.idempotency_conflict',
      ],
      [
        '/v1/supplier-credit-allocations',
        allocateBody(note.creditNoteId, p.purchaseId, day, '1500'),
        (b) => ({ ...b, creditAmountMinor: '1400', purchaseAmountAppliedMinor: '1400' }),
        'supplier_credit_allocation.idempotency_conflict',
      ],
      [
        '/v1/supplier-refunds',
        refundBody(note.creditNoteId, method, day, '2500'),
        (b) => ({ ...b, creditAmountMinor: '2400', receiptAmountMinor: '2400' }),
        'supplier_refund.idempotency_conflict',
      ],
      ['/v1/payment-methods', methodBody(acc.settlement.cash), (b) => ({ ...b, sortOrder: 99 }), 'payment_method.idempotency_conflict'],
    ];
    for (const [path, body, change, code] of cases) {
      const first = await post(path, body);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const before = await state();
      expectRefusal(await post(path, change(body)), 409, code, path);
      expect(await state(), `${path}: nothing written`).toEqual(before);
    }
  });
});

describe('T-18 fx_rate_changed and settlement_changed are retryable', () => {
  it('a USD rate stated between the bind and the routine: fx_rate_changed; re-bound, the payment succeeds', async () => {
    const m = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.bank }));
    const p = await committed((c) =>
      receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '1000' }], { currency: 'USD', documentDate: ago(5) }),
    );
    const bind = (): Promise<S6Call> =>
      rolledBack((c) =>
        preparePay(c, A, {
          supplierId: p.supplierId,
          paymentMethodId: m,
          currency: 'USD',
          allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 400n }],
        }),
      );
    const stale = await bind();
    await stateRate(A, 'USD', 'ILS', '3.6100000000', `${ago(1)}T00:00:00Z`);
    await rolledBack(async (c) => {
      refusedWith(await tryS6(c, A, stale), 'P0001', 'supplier_payment.fx_rate_changed', 'bound at 3.60, 3.61 now applies');
    });
    await committed(async (c) => runS6(c, A, await bind()));

    // The refund: its receipt snapshot too.
    const n = await committed((c) => sqlReturnToCredit(c, A, m, { qty: '2', unitPriceMinor: '5000' }));
    const bindRefund = (): Promise<S6Call> =>
      rolledBack((c) =>
        prepareRefund(c, A, { creditNoteId: n.creditNoteId, paymentMethodId: m, consumedMinor: 1000n, receiptCurrency: 'USD', receiptAmountMinor: 300n }),
      );
    const staleRefund = await bindRefund();
    await stateRate(A, 'USD', 'ILS', '3.6200000000', `${ago(0)}T00:00:00Z`);
    await rolledBack(async (c) => {
      refusedWith(await tryS6(c, A, staleRefund), 'P0001', 'supplier_refund.fx_rate_changed', 'the receipt rate moved');
    });
    await committed(async (c) => runS6(c, A, await bindRefund()));
  });

  it('a settlement committed between the bind and the routine: settlement_changed; the retry succeeds (payment and credit allocation)', async () => {
    const m = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.bank }));
    const n = await committed((c) => sqlReturnToCredit(c, A, m, { qty: '2', unitPriceMinor: '5000' }));
    const p = await committed((c) =>
      receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '10000' }], { supplierId: n.purchase.supplierId }),
    );
    const bindPay = (amount: bigint): Promise<S6Call> =>
      rolledBack((c) =>
        preparePay(c, A, { supplierId: p.supplierId, paymentMethodId: m, allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: amount }] }),
      );
    const bindAllocate = (amount: bigint): Promise<S6Call> =>
      rolledBack((c) => prepareAllocate(c, A, { creditNoteId: n.creditNoteId, purchaseId: p.purchaseId, consumedMinor: amount }));
    const stalePay = await bindPay(1000n);
    const staleAllocate = await bindAllocate(500n);
    await committed(async (c) => runS6(c, A, await bindPay(2000n)));
    await rolledBack(async (c) => {
      refusedWith(await tryS6(c, A, stalePay), 'P0001', 'supplier_payment.settlement_changed', 'X moved from 0 to 20.00');
      refusedWith(await tryS6(c, A, staleAllocate), 'P0001', 'supplier_credit_allocation.settlement_changed', 'X moved under the allocation');
    });
    await committed(async (c) => runS6(c, A, await bindPay(1000n)));
    await committed(async (c) => runS6(c, A, await bindAllocate(500n)));
    const o = await ownerPool().query<{ o: string }>(`SELECT purchase_ap_outstanding($1, $2)::text AS o`, [A.businessId, p.purchaseId]);
    expect(must(o.rows[0]).o, 'both retries landed: 100.00 − 20.00 − 10.00 − 5.00').toBe('6500');
  });
});

describe('T-18 R-74 / R-75 / R-76', () => {
  it('R-74: an allocation id already used by another payment, or twice in one, is 400 allocations_invalid', async () => {
    const p = await httpReceived(t, owner, A);
    const first = payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }]);
    expect((await post('/v1/supplier-payments', first)).status).toBe(201);
    const used = must((first.allocations as { allocationId: string }[])[0]).allocationId;
    const reuse = payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }]);
    const reused = { ...reuse, allocations: (reuse.allocations as Record<string, unknown>[]).map((a) => ({ ...a, allocationId: used })) };
    const p2 = await httpReceived(t, owner, A, { supplierId: p.supplierId });
    const before = await state();
    expectRefusal(await post('/v1/supplier-payments', reused), 400, 'supplier_payment.allocations_invalid', 'another payment’s allocation id');
    const twice = payBody(p.supplierId, method, day, [
      { purchaseId: p.purchaseId, paymentAmountMinor: '100' },
      { purchaseId: p2.purchaseId, paymentAmountMinor: '100' },
    ]);
    const shared = randomUUID();
    const dup = { ...twice, allocations: (twice.allocations as Record<string, unknown>[]).map((a) => ({ ...a, allocationId: shared })) };
    expectRefusal(await post('/v1/supplier-payments', dup), 400, 'supplier_payment.allocations_invalid', 'one id twice');
    expect(await state()).toEqual(before);
    // At the routine: an allocation id stored under another payment.
    await rolledBack(async (c) => {
      const call = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: method,
        allocations: [{ purchaseId: p2.purchaseId, paymentAmountMinor: 100n }],
      });
      refusedWith(await tryS6(c, A, withElement(call, 13, 0, used)), 'P0001', 'supplier_payment.allocations_invalid', 'the routine (R-74)');
    });
  });

  it('R-75: a missing scalar reaching the routine under an honest assertion is inventory.payload_invalid', async () => {
    await rolledBack(async (c) => {
      const m = await createMethod(c, A, { postingAccountId: acc.settlement.bank });
      const n = await sqlReturnToCredit(c, A, m, { qty: '2', unitPriceMinor: '5000' });
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '10000' }], { supplierId: n.purchase.supplierId });
      const pay = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: m,
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 100n }],
      });
      const allocate = await prepareAllocate(c, A, { creditNoteId: n.creditNoteId, purchaseId: p.purchaseId, consumedMinor: 100n });
      const refund = await prepareRefund(c, A, { creditNoteId: n.creditNoteId, paymentMethodId: m, consumedMinor: 100n });
      // The minter's canonicalizer refuses a NULL here, so the assertion is
      // signed over the raw stream the routine itself hashes (NULL = 0x00):
      // it verifies, and the routine's shape check meets the NULL.
      for (const [what, honest, i] of [
        ['pay: no supplier', pay, 1],
        ['pay: no posting account', pay, 3],
        ['allocate: no purchase', allocate, 2],
        ['allocate: no warehouse', allocate, 3],
        ['refund: no method', refund, 2],
        ['refund: no posting account', refund, 3],
      ] as const) {
        const call = withParam(honest, i, null);
        refusedWith(await tryS6(c, A, call, { post: false, assertion: s6RawAssertionFor(A, call) }), 'P0001', 'inventory.payload_invalid', what);
      }
    });
  });

  it('R-76: an unregistered payment or receipt currency is 400 purchase.currency_unknown, and so at the routine', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '50.00' }] });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    const before = await state();
    expectRefusal(
      await post(
        '/v1/supplier-payments',
        payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100', purchaseAmountAppliedMinor: '100' }], {
          currencyCode: 'XQZ',
        }),
      ),
      400,
      'purchase.currency_unknown',
      'payment in XQZ',
    );
    expectRefusal(
      await post('/v1/supplier-refunds', refundBody(note.creditNoteId, method, day, '1000', { receiptCurrencyCode: 'XQZ', receiptAmountMinor: '1000' })),
      400,
      'purchase.currency_unknown',
      'receipt in XQZ',
    );
    expect(await state()).toEqual(before);
    await rolledBack(async (c) => {
      const call = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: method,
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 100n }],
      });
      refusedWith(await tryS6(c, A, withParam(call, 5, 'XQZ'), { post: false }), 'P0001', 'purchase.currency_unknown', 'the routine (R-76)');
    });
  });
});
