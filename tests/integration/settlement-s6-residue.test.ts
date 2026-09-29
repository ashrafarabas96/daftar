/**
 * P3-S6 — NO SETTLEMENT LEAVES A SUB-UNIT RESIDUE (0067 R-77, R-78, R-69(b);
 * review M1).
 *
 * TRY at 0.11 into an ILS business: one kurus converts to 0.11 agora → 0, so
 * a purchase of T = 50.00 TRY has B = 5.50 ILS and a remaining 0.01 TRY
 * cannot be cleared by any allocation. S6 therefore never CREATES one:
 *   - R-77, the purchase side: paying 49.99 of 50.00 (in TRY, or 5.50 ILS
 *     applying 49.99) is 422 `supplier_payment.residue_below_base_unit`, and
 *     so is receive-and-pay; 49.90 is 201 (O = 0.10, conv 1), then 0.06 is
 *     refused (0.04 would remain), 0.05 is 201, 0.01 is
 *     `…amount_below_base_unit`, the last 0.05 is 201 and the purchase
 *     clears to 0 / 0; a credit allocation leaving 0.01 of the purchase is
 *     `supplier_credit_allocation.residue_below_base_unit`;
 *   - R-78, the note side: a refund of 49.99 of a 50.00 TRY note (in TRY or
 *     in ILS) is `supplier_refund.residue_below_base_unit`, 49.90 then 0.10
 *     are 201; a credit allocation leaving the NOTE 0.01 is
 *     `supplier_credit_allocation.residue_below_base_unit`;
 *   - every refusal writes nothing; the binder, the routine (a crafted call
 *     past the binder) and the COMMIT value guards (a forged row, fired
 *     alone) refuse alike;
 *   - the one origin left, a frozen S5 partial return (least(C, O)): lines
 *     49.99 + 0.01 TRY, the 49.99 returned → O = 0.01 whose base is 0 (since
 *     the corrective 0072 the API refuses that return,
 *     `supplier_return.residue_below_base_unit`, and the state is rebuilt with
 *     the frozen S5 return, `historicalReturn`). Paying
 *     or allocating 0.01 is `…amount_below_base_unit`; paying 0.02 or allocating 0.10 is
 *     `…amount_exceeds_outstanding`, returning the rest is
 *     `supplier_return.amount_below_base_unit`, and the reversal is
 *     `purchase_reversal.returned` — the residue stays open (R-69(b) debt).
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  attempt,
  expectAccepted,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  rolledBack,
  scratch,
  today,
  type HttpActor,
  type Outcome,
  type S3Business,
} from '../helpers/inventory-commands';
import { historicalReturn } from '../helpers/p3c-residue';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  allocateBody,
  bindingRefusal,
  createMethod,
  expectRefusal,
  httpDraft,
  httpMethod,
  httpPay,
  httpReceived,
  noteOf,
  outstandingOf,
  payBody,
  prepareAllocate,
  preparePay,
  prepareRefund,
  refundBody,
  returnToCredit,
  runS6,
  s6Counts,
  seedSettlementAccounts,
  settlementFx,
  settlementLedgerAp,
  sqlReturnToCredit,
  stateRate,
  tryS6,
  type HttpPurchase,
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
  owner = await registerActor(t, 'S6 residue owner');
  A = await onboardS3Business(t, owner, 's6residue');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  await stateRate(A, 'TRY', 'ILS', '0.1100000000', `${ago(10)}T00:00:00Z`);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, A.businessId);

/** A received TRY purchase of `lines` (major-unit prices), optionally for an existing supplier. */
function tryPurchase(lines: readonly { quantity: string; unitPrice: string }[], supplierId?: string): Promise<HttpPurchase> {
  return httpReceived(t, owner, A, {
    currency: 'TRY',
    ...(supplierId === undefined ? {} : { supplierId }),
    lines: lines.map((l) => ({ productId: A.piece.productId, ...l })),
  });
}

/** Pay `amount` TRY minor (or `payCurrency` applying `applied`) against one purchase. */
function pay(p: HttpPurchase, amount: string, o: { currencyCode?: string; applied?: string } = {}): Promise<Response> {
  return httpPay(
    t,
    owner,
    A,
    payBody(
      p.supplierId,
      method,
      day,
      [{ purchaseId: p.purchaseId, paymentAmountMinor: amount, ...(o.applied === undefined ? {} : { purchaseAmountAppliedMinor: o.applied }) }],
      {
        currencyCode: o.currencyCode ?? 'TRY',
      },
    ),
  );
}

const allocate = (creditNoteId: string, purchaseId: string, amount: string): Promise<Response> =>
  t.request
    .post('/v1/supplier-credit-allocations')
    .set(headers())
    .send(allocateBody(creditNoteId, purchaseId, day, amount));

const refund = (creditNoteId: string, amount: string, receipt: { currency: string; amount: string } = { currency: 'TRY', amount }): Promise<Response> =>
  t.request
    .post('/v1/supplier-refunds')
    .set(headers())
    .send(refundBody(creditNoteId, method, day, amount, { receiptCurrencyCode: receipt.currency, receiptAmountMinor: receipt.amount }));

/** A refused request writes nothing in the business. */
async function refusedNothingWritten(send: () => Promise<Response>, status: number, code: string, why: string): Promise<void> {
  const before = await s6Counts(ownerPool(), A.businessId);
  expectRefusal(await send(), status, code, why);
  expect(await s6Counts(ownerPool(), A.businessId), `${why}: nothing written`).toEqual(before);
}

const expectCreated = (r: Response, why: string): void => {
  expect(r.status, `${why}: ${JSON.stringify(r.body)}`).toBe(201);
};

describe('R-77 through the API: a payment never leaves the purchase a sub-unit residue', () => {
  it('50.00 TRY (B 5.50): 49.99 refused in TRY and in ILS; 49.90, 0.05, 0.05 accepted around the refused 0.06 and 0.01; clears to 0 / 0', async () => {
    const p = await tryPurchase([{ quantity: '1', unitPrice: '50.00' }]);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toEqual({ o: 5000n, t: 5000n, b: 550n });
    const residue = 'supplier_payment.residue_below_base_unit';
    await refusedNothingWritten(() => pay(p, '4999'), 422, residue, '49.99 TRY leaves 0.01 (conv 0)');
    await refusedNothingWritten(() => pay(p, '550', { currencyCode: 'ILS', applied: '4999' }), 422, residue, '5.50 ILS applying 49.99 TRY');
    expectCreated(await pay(p, '4990'), '49.90 leaves 0.10 (conv 1)');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 10n });
    await refusedNothingWritten(() => pay(p, '6'), 422, residue, '0.06 of 0.10 leaves 0.04 (conv 0)');
    expectCreated(await pay(p, '5'), '0.05 of 0.10 leaves 0.05 (conv 0.55 → 1)');
    await refusedNothingWritten(() => pay(p, '1'), 422, 'supplier_payment.amount_below_base_unit', '0.01 converts to 0 (judged first)');
    expectCreated(await pay(p, '5'), 'the last 0.05');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'AP clears exactly').toEqual({ base: 0n, txn: 0n });
  });

  it('receive-and-pay applying 49.99 of 50.00 TRY is refused the same, and the purchase stays a draft', async () => {
    const d = await httpDraft(t, owner, A, { currency: 'TRY', lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '50.00' }] });
    const body = (amountMinor: string): Record<string, unknown> => ({
      draftRevision: 1,
      payment: { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: method, currencyCode: 'TRY', amountMinor },
    });
    await refusedNothingWritten(
      () => t.request.post(`/v1/purchases/${d.purchaseId}/receive-and-pay`).set(headers()).send(body('4999')),
      422,
      'supplier_payment.residue_below_base_unit',
      'receive-and-pay 49.99',
    );
    const status = must(
      (await ownerPool().query<{ s: string }>(`SELECT status AS s FROM purchases WHERE business_id = $1 AND id = $2`, [A.businessId, d.purchaseId])).rows[0],
    ).s;
    expect(status, 'the receipt rolled back with the payment').toBe('draft');
    const ok = await t.request.post(`/v1/purchases/${d.purchaseId}/receive-and-pay`).set(headers()).send(body('4990'));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await outstandingOf(ownerPool(), A.businessId, d.purchaseId)).toMatchObject({ o: 10n });
  });
});

describe('R-78 through the API: a refund never leaves the note a sub-unit residue', () => {
  it('a 50.00 TRY note: 49.99 refused in TRY and as 5.50 ILS; 49.90 then 0.10 accepted; the note is exhausted exactly', async () => {
    const n = await returnToCredit(t, owner, A, method, { currency: 'TRY', lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '50.00' }] });
    expect(await noteOf(ownerPool(), A.businessId, n.creditNoteId)).toMatchObject({ original: 5000n, originalCarrying: 550n, remaining: 5000n });
    const residue = 'supplier_refund.residue_below_base_unit';
    await refusedNothingWritten(() => refund(n.creditNoteId, '4999'), 422, residue, '49.99 TRY leaves the note 0.01');
    await refusedNothingWritten(() => refund(n.creditNoteId, '4999', { currency: 'ILS', amount: '550' }), 422, residue, '49.99 TRY received as 5.50 ILS');
    expectCreated(await refund(n.creditNoteId, '4990'), '49.90 leaves 0.10 (conv 1)');
    expectCreated(await refund(n.creditNoteId, '10'), 'the last 0.10');
    expect(await noteOf(ownerPool(), A.businessId, n.creditNoteId)).toMatchObject({ remaining: 0n, remainingCarrying: 0n });
  });
});

describe('R-77 / R-78 through the API: a credit allocation leaves neither side a sub-unit residue', () => {
  it('the purchase side: a 100.00 TRY note on a 50.00 TRY purchase — 49.99 refused, 49.90 accepted', async () => {
    const n = await returnToCredit(t, owner, A, method, {
      currency: 'TRY',
      lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }],
      quantity: '2',
    });
    const p = await tryPurchase([{ quantity: '1', unitPrice: '50.00' }], n.purchase.supplierId);
    await refusedNothingWritten(
      () => allocate(n.creditNoteId, p.purchaseId, '4999'),
      422,
      'supplier_credit_allocation.residue_below_base_unit',
      'the purchase would keep 0.01; the note 50.01',
    );
    expectCreated(await allocate(n.creditNoteId, p.purchaseId, '4990'), 'the purchase keeps 0.10');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 10n });
  });

  it('the note side: a 50.00 TRY note on a 100.00 TRY purchase — 49.99 refused, 49.90 accepted', async () => {
    const n = await returnToCredit(t, owner, A, method, { currency: 'TRY', lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '50.00' }] });
    const p = await tryPurchase([{ quantity: '2', unitPrice: '50.00' }], n.purchase.supplierId);
    await refusedNothingWritten(
      () => allocate(n.creditNoteId, p.purchaseId, '4999'),
      422,
      'supplier_credit_allocation.residue_below_base_unit',
      'the note would keep 0.01; the purchase 50.01',
    );
    expectCreated(await allocate(n.creditNoteId, p.purchaseId, '4990'), 'the note keeps 0.10');
    expect(await noteOf(ownerPool(), A.businessId, n.creditNoteId)).toMatchObject({ remaining: 10n, remainingCarrying: 1n });
  });
});

/** A crafted call: arguments as given, past the binder; no entries. */
const craft = (kind: S6Call['kind'], params: readonly unknown[]): S6Call => ({
  kind,
  params,
  postings: [],
  trace: randomUUID(),
  builtSha256: null,
  intentSha256: null,
});

describe('R-77 / R-78 in the binder and in the routine (a crafted call past the binder)', () => {
  it('pay, allocate and refund: the binder and the routine refuse …residue_below_base_unit, before any write', async () => {
    await rolledBack(async (c) => {
      const m = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const date = await today(c);
      const fx = await settlementFx(c, A.businessId, 'TRY', date);
      const at = `${fx.at.toISOString().slice(0, 19)}Z`;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '5000' }], { currency: 'TRY' });
      expect(
        await bindingRefusal(() =>
          preparePay(c, A, {
            supplierId: p.supplierId,
            paymentMethodId: m,
            currency: 'TRY',
            allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 4999n }],
          }),
        ),
        'the payment binder',
      ).toBe('supplier_payment.residue_below_base_unit');
      const payCall = (amount: string, base: string): S6Call =>
        craft('pay', [
          randomUUID(),
          p.supplierId,
          m,
          acc.settlement.cash,
          date,
          'TRY',
          amount,
          fx.rateId,
          fx.rate,
          fx.source,
          at,
          base,
          null,
          [randomUUID()],
          [p.purchaseId],
          [A.w1],
          ['TRY'],
          [amount],
          [base],
          [amount],
          ['0'],
          ['0'],
          ['0'],
          ['0'],
        ]);
      refusedWith(await tryS6(c, A, payCall('4999', '550')), 'P0001', 'supplier_payment.residue_below_base_unit', 'the routine: 49.99 of 50.00');
      refusedWith(await tryS6(c, A, payCall('4996', '550')), 'P0001', 'supplier_payment.residue_below_base_unit', 'the routine: 49.96 of 50.00');

      // Note side and purchase side of an allocation, and a refund, against real notes of the same supplier.
      const small = await sqlReturnToCredit(c, A, m, { currency: 'TRY', qty: '1', unitPriceMinor: '5000', supplierId: p.supplierId });
      const big = await sqlReturnToCredit(c, A, m, { currency: 'TRY', qty: '2', unitPriceMinor: '5000', returnQty: '2', supplierId: p.supplierId });
      const large = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '5000' }], {
        currency: 'TRY',
        supplierId: p.supplierId,
      });
      const counts = await s6Counts(c, A.businessId);
      refusedWith(await tryS6(c, A, payCall('4999', '550')), 'P0001', 'supplier_payment.residue_below_base_unit', 'the routine, beside real notes');
      for (const [what, creditNoteId, purchaseId, rb] of [
        ['note side: 50.00 note, 100.00 purchase', small.creditNoteId, large.purchaseId, '5000'],
        ['purchase side: 100.00 note, 50.00 purchase', big.creditNoteId, p.purchaseId, '10000'],
      ] as const) {
        expect(await bindingRefusal(() => prepareAllocate(c, A, { creditNoteId, purchaseId, consumedMinor: 4999n })), `the allocation binder, ${what}`).toBe(
          'supplier_credit_allocation.residue_below_base_unit',
        );
        refusedWith(
          await tryS6(
            c,
            A,
            craft('allocate_credit', [randomUUID(), creditNoteId, purchaseId, A.w1, date, 'TRY', '4999', rb, '0', '0', 'TRY', '4999', '0', '0', '0', '0']),
          ),
          'P0001',
          'supplier_credit_allocation.residue_below_base_unit',
          `the routine, ${what}`,
        );
      }
      expect(
        await bindingRefusal(() => prepareRefund(c, A, { creditNoteId: small.creditNoteId, paymentMethodId: m, consumedMinor: 4999n })),
        'the refund binder',
      ).toBe('supplier_refund.residue_below_base_unit');
      refusedWith(
        await tryS6(
          c,
          A,
          craft('receive_refund', [
            randomUUID(),
            small.creditNoteId,
            m,
            acc.settlement.cash,
            date,
            'TRY',
            '4999',
            '5000',
            '0',
            '0',
            'TRY',
            '4999',
            fx.rateId,
            fx.rate,
            fx.source,
            at,
            '550',
            '0',
            null,
          ]),
        ),
        'P0001',
        'supplier_refund.residue_below_base_unit',
        'the routine: 49.99 of a 50.00 note',
      );
      expect(await s6Counts(c, A.businessId), 'no crafted call wrote anything').toEqual(counts);
      // The ALLOW: the lawful amounts through the same routines.
      await runS6(
        c,
        A,
        await preparePay(c, A, {
          supplierId: p.supplierId,
          paymentMethodId: m,
          currency: 'TRY',
          allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 4990n }],
        }),
      );
      await runS6(c, A, await prepareRefund(c, A, { creditNoteId: small.creditNoteId, paymentMethodId: m, consumedMinor: 4990n }));
      expect(await outstandingOf(c, A.businessId, p.purchaseId)).toMatchObject({ o: 10n });
      expect(await noteOf(c, A.businessId, small.creditNoteId)).toMatchObject({ remaining: 10n });
    });
  });
});

describe('R-77 / R-78 at COMMIT: a forged row that would leave a sub-unit residue is refused by its value guard', () => {
  /** Fire one deferred value guard now (and only it), inside a savepoint. */
  const fire = (c: Client, trigger: string): Promise<Outcome<unknown>> =>
    attempt(c, async () => {
      await c.query(`SET CONSTRAINTS ${trigger} IMMEDIATE`);
      await c.query(`SET CONSTRAINTS ${trigger} DEFERRED`);
    });

  it('supplier_payment_allocations_value_complete: 0.06 after 49.90 → residue; 0.05 passes the residue check', async () => {
    await rolledBack(async (c) => {
      const m = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '5000' }], { currency: 'TRY' });
      const honest = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: m,
        currency: 'TRY',
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 4990n }],
      });
      await runS6(c, A, honest);
      expectAccepted(await fire(c, 'supplier_payment_allocations_value_complete'), 'the honest 49.90');
      const forge = async (applied: string): Promise<Outcome<unknown>> =>
        scratch(c, async () => {
          const paymentId = randomUUID();
          const allocationId = randomUUID();
          await c.query(
            `INSERT INTO supplier_payments (tenant_id, business_id, id, supplier_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                                            payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                                            allocation_count, intent_sha256, business_transaction_id, created_by)
             SELECT tenant_id, business_id, $3, supplier_id, payment_method_id, posting_account_id, currency_code, $4::bigint,
                    payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, 1, payment_date, reference,
                    1, intent_sha256, business_transaction_id, created_by
               FROM supplier_payments WHERE business_id = $1 AND id = $2`,
            [A.businessId, honest.params[0], paymentId, applied],
          );
          await c.query(
            `INSERT INTO supplier_payment_allocations (tenant_id, business_id, id, payment_id, supplier_id, purchase_id, line_no, payment_currency,
                                                       payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
                                                       purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                                       purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor, binding_source_id)
             SELECT tenant_id, business_id, $4, $3, supplier_id, purchase_id, 1, payment_currency,
                    $5::bigint, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
                    $5::bigint, purchase_historical_to_base_rate, 4990,
                    purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor, $4
               FROM supplier_payment_allocations WHERE business_id = $1 AND payment_id = $2`,
            [A.businessId, honest.params[0], paymentId, allocationId, applied],
          );
          return fire(c, 'supplier_payment_allocations_value_complete');
        });
      refusedWith(await forge('6'), 'P0001', 'supplier_payment.residue_below_base_unit', '0.06 after 49.90 leaves 0.04');
      // 0.05 leaves 0.05 (conv 1): past the residue check, the copied amounts are then the inconsistency.
      refusedWith(await forge('5'), 'P0001', 'supplier_payment.settlement_inconsistent', '0.05 after 49.90 leaves 0.05');
    });
  });

  it('supplier_credit_allocations_value_complete: the note side and the purchase side', async () => {
    await rolledBack(async (c) => {
      const m = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const n = await sqlReturnToCredit(c, A, m, { currency: 'TRY', qty: '2', unitPriceMinor: '5000', returnQty: '2' });
      const supplierId = n.purchase.supplierId;
      const bigP = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '5000' }], { currency: 'TRY', supplierId });
      const smallP = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '5000' }], { currency: 'TRY', supplierId });
      const honest = await prepareAllocate(c, A, { creditNoteId: n.creditNoteId, purchaseId: bigP.purchaseId, consumedMinor: 1000n });
      await runS6(c, A, honest);
      expectAccepted(await fire(c, 'supplier_credit_allocations_value_complete'), 'the honest 10.00');
      const forge = (o: { purchaseId: string; rb: string; amount: string; x: string }): Promise<Outcome<unknown>> =>
        scratch(c, async () => {
          const id = randomUUID();
          await c.query(
            `INSERT INTO supplier_credit_allocations (tenant_id, business_id, id, supplier_id, credit_note_id, purchase_id, allocation_date, credit_currency,
                                                      credit_amount_consumed_minor, credit_to_base_rate, credit_remaining_before_minor,
                                                      credit_carrying_base_released_minor, credit_dust_base_minor, purchase_currency,
                                                      purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                                      purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor,
                                                      intent_sha256, business_transaction_id, created_by, binding_source_id)
             SELECT tenant_id, business_id, $3, supplier_id, credit_note_id, $4, allocation_date, credit_currency,
                    $6::bigint, credit_to_base_rate, $5::bigint,
                    credit_carrying_base_released_minor, credit_dust_base_minor, purchase_currency,
                    $6::bigint, purchase_historical_to_base_rate, $7::bigint,
                    purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor,
                    intent_sha256, business_transaction_id, created_by, $3
               FROM supplier_credit_allocations WHERE business_id = $1 AND id = $2`,
            [A.businessId, honest.params[0], id, o.purchaseId, o.rb, o.amount, o.x],
          );
          return fire(c, 'supplier_credit_allocations_value_complete');
        });
      refusedWith(
        await forge({ purchaseId: bigP.purchaseId, rb: '9000', amount: '8996', x: '1000' }),
        'P0001',
        'supplier_credit_allocation.residue_below_base_unit',
        'the note keeps 0.04 (the purchase 100.04)',
      );
      refusedWith(
        await forge({ purchaseId: smallP.purchaseId, rb: '8000', amount: '4996', x: '0' }),
        'P0001',
        'supplier_credit_allocation.residue_below_base_unit',
        'the purchase keeps 0.04 (the note 30.04)',
      );
    });
  });

  it('supplier_refunds_value_complete: a refund leaving the note 0.04', async () => {
    await rolledBack(async (c) => {
      const m = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const n = await sqlReturnToCredit(c, A, m, { currency: 'TRY', qty: '1', unitPriceMinor: '5000' });
      const honest = await prepareRefund(c, A, { creditNoteId: n.creditNoteId, paymentMethodId: m, consumedMinor: 1000n });
      await runS6(c, A, honest);
      expectAccepted(await fire(c, 'supplier_refunds_value_complete'), 'the honest 10.00');
      const forged = await scratch(c, async () => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO supplier_refunds (tenant_id, business_id, id, supplier_id, credit_note_id, payment_method_id, posting_account_id, refund_date, reference,
                                         source_currency, source_amount_consumed_minor, source_to_base_rate, credit_remaining_before_minor,
                                         source_carrying_base_released_minor, source_dust_base_minor, receipt_currency, receipt_amount_minor,
                                         receipt_to_base_rate, receipt_base_amount_minor, rate_source, rate_timestamp, fx_rate_id, realized_fx_gain_loss_minor,
                                         intent_sha256, business_transaction_id, created_by, binding_source_id)
           SELECT tenant_id, business_id, $3, supplier_id, credit_note_id, payment_method_id, posting_account_id, refund_date, reference,
                  source_currency, 3996, source_to_base_rate, 4000,
                  source_carrying_base_released_minor, source_dust_base_minor, receipt_currency, 3996,
                  receipt_to_base_rate, receipt_base_amount_minor, rate_source, rate_timestamp, fx_rate_id, realized_fx_gain_loss_minor,
                  intent_sha256, business_transaction_id, created_by, $3
             FROM supplier_refunds WHERE business_id = $1 AND id = $2`,
          [A.businessId, honest.params[0], id],
        );
        return fire(c, 'supplier_refunds_value_complete');
      });
      refusedWith(forged, 'P0001', 'supplier_refund.residue_below_base_unit', '39.96 of the remaining 40.00');
    });
  });
});

describe('R-69(b): the one origin left — a frozen S5 partial return — and the stable refusals around it', () => {
  it('lines 49.99 + 0.01 TRY, the 49.99 returned → O = 0.01, base 0: pay / allocate / return / reverse are refused; the residue stays open', async () => {
    const note = await returnToCredit(t, owner, A, method, { currency: 'TRY', lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '50.00' }] });
    const p = await httpReceived(t, owner, A, {
      currency: 'TRY',
      supplierId: note.purchase.supplierId,
      lines: [
        { productId: A.piece.productId, quantity: '1', unitPrice: '49.99' },
        { productId: A.piece2.productId, quantity: '1', unitPrice: '0.01' },
      ],
    });
    // Phase 3 corrective (0072 R-95): a return may no longer CREATE this state — the API refuses it and
    // writes nothing. The residue a deployed database already holds is rebuilt with the frozen S5 return.
    await refusedNothingWritten(
      () =>
        t.request
          .post(`/v1/purchases/${p.purchaseId}/returns`)
          .set(headers())
          .send({
            returnId: randomUUID(),
            warehouseId: p.warehouseId,
            documentDate: day,
            lines: [{ lineId: randomUUID(), purchaseLineId: must(p.lineIds[0]), quantity: '1' }],
          }),
      422,
      'supplier_return.residue_below_base_unit',
      'the 49.99 return would leave 0.01 (0072 R-95)',
    );
    await historicalReturn(A, p, 0, '1');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'S5 released least(C, O) = 49.99').toMatchObject({ o: 1n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'a txn-only residue').toEqual({ base: 0n, txn: 1n });

    await refusedNothingWritten(() => pay(p, '1'), 422, 'supplier_payment.amount_below_base_unit', 'pay the 0.01');
    await refusedNothingWritten(() => pay(p, '2'), 422, 'supplier_payment.amount_exceeds_outstanding', 'pay 0.02');
    await refusedNothingWritten(
      () => allocate(note.creditNoteId, p.purchaseId, '1'),
      422,
      'supplier_credit_allocation.amount_below_base_unit',
      'allocate the 0.01',
    );
    await refusedNothingWritten(
      () => allocate(note.creditNoteId, p.purchaseId, '10'),
      422,
      'supplier_credit_allocation.amount_exceeds_outstanding',
      'allocate 0.10 (conv 1) against 0.01',
    );
    await refusedNothingWritten(
      () =>
        t.request
          .post(`/v1/purchases/${p.purchaseId}/returns`)
          .set(headers())
          .send({
            returnId: randomUUID(),
            warehouseId: p.warehouseId,
            documentDate: day,
            lines: [{ lineId: randomUUID(), purchaseLineId: must(p.lineIds[1]), quantity: '1' }],
          }),
      422,
      'supplier_return.amount_below_base_unit',
      'return the 0.01 line',
    );
    await refusedNothingWritten(
      () => t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(headers()).send({ reversalDate: day, reason: 'Received twice' }),
      409,
      'purchase_reversal.returned',
      'reverse the returned purchase',
    );
    // Every merchant settlement path still refuses it; its closure is the 0072 write-off (p3c-td16-residue-closure).
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'the residue stays open to settlement (R-69(b))').toMatchObject({ o: 1n });
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId), 'the note is untouched').toMatchObject({ remaining: 5000n });
  });
});
