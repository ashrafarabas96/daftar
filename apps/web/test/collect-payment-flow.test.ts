import { describe, expect, it } from 'vitest';
import type { CustomerOpenInvoiceDto, CustomerPaymentDto, CustomerPaymentResultDto } from '@daftar/shared-contracts';
import { ApiError } from '@/lib/client';
import type { CollectPaymentRequestDto } from '@/lib/phase4-collect-payment-api';
import type { MethodChoice } from '@/views/common/payment-methods';
import { planCollectPayment, type CollectFormModel, type CollectRowModel } from '@/views/customers/collect-payment';
import { STORED_UNREADABLE_KEY, afterOutcome, createCollectFlow, type CollectScreenState } from '@/views/customers/collect-flow';

/**
 * The page's send logic, outside React: the flow the page holds once per form.
 *
 * What it must guarantee, each shown here and each planted against:
 * - the ids are minted ONCE per flow and every send — a retry after no
 *   answer, a retryable 409, an edited resend — carries the same ones;
 * - a double click sends once;
 * - `customer_payment.idempotency_conflict` means a payment with this id IS
 *   ALREADY STORED (`customer-payment.service.ts`: raised only when
 *   `findCustomerPaymentIntent` found a row). So the stored payment is read
 *   and shown, never "start over";
 * - a refusal leaves the typed form exactly as it was;
 * - a replayed answer is a success.
 */

const CUSTOMER = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';
const METHOD: MethodChoice = { paymentMethodId: 'a0416f73-0006-4a7b-8c9d-000000000011', name: 'Cash', requiresReference: false };

const invoice = (over: Partial<CollectRowModel> & Pick<CustomerOpenInvoiceDto, 'invoiceId'>): CollectRowModel => ({
  documentKind: 'invoice',
  documentNumber: 'INV-0001',
  issueDate: '2026-10-01',
  dueDate: null,
  currency: 'ILS',
  totalTxnMinor: '10000',
  outstandingTxnMinor: '10000',
  outstandingBaseMinor: '10000',
  settlementState: 'unpaid',
  daysPastDue: 0,
  hasExplicitDueDate: false,
  ageDays: 0,
  isCredit: false,
  amount: '',
  invalid: false,
  ...over,
});
const A = invoice({ invoiceId: '11111111-1111-4111-8111-111111111111', amount: '100' });

const form = (amount: string): CollectFormModel => ({
  methodId: METHOD.paymentMethodId,
  currency: 'ILS',
  currencyOptions: ['ILS'],
  amount,
  date: '2026-11-13',
  reference: '',
  errors: {},
});

function counter() {
  let n = 0;
  const mint = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
  return { mint, count: () => n };
}

const answerFor = (body: CollectPaymentRequestDto, replayed: boolean): CustomerPaymentResultDto => ({
  paymentId: body.paymentId,
  customerId: body.customerId,
  paymentMethodId: body.paymentMethodId,
  paymentDate: body.paymentDate,
  currencyCode: body.currencyCode,
  amountMinor: body.amountMinor,
  reference: body.reference,
  allocations: body.allocations.map((a, i) => ({ ...a, lineNo: i + 1, invoiceCurrencyCode: 'ILS' })),
  credit: null,
  replayed,
});

const CONFLICT = new ApiError(409, 'CONFLICT', { receivablesCode: 'customer_payment.idempotency_conflict' });
const RETRYABLE = new ApiError(409, 'CONFLICT', { receivablesCode: 'customer_payment.settlement_changed' });
const REFUSED = new ApiError(409, 'CONFLICT', { receivablesCode: 'customer_payment.amount_exceeds_outstanding' });

const planner = (f: CollectFormModel, rows: CollectRowModel[]) => (ids: Parameters<typeof planCollectPayment>[0]['ids']) =>
  planCollectPayment({ customerId: CUSTOMER, form: f, rows, method: METHOD, ids });

const state = (f: CollectFormModel, rows: CollectRowModel[]): CollectScreenState => ({
  form: f,
  rows,
  busy: true,
  errorKey: null,
  result: null,
  stored: null,
  storedUnread: false,
});

describe('createCollectFlow — one set of ids per form', () => {
  it('no answer, then an edited resend refused as already stored: the stored payment is read and shown, with no new ids', async () => {
    const ids = counter();
    const sent: CollectPaymentRequestDto[] = [];
    const reads: string[] = [];
    const STORED: CustomerPaymentDto = { ...answerFor(planOk(planner(form('100'), [A])), false) };
    let call = 0;
    const flow = createCollectFlow({
      mint: ids.mint,
      send: (body) => {
        sent.push(body);
        call += 1;
        return Promise.reject(call === 1 ? new TypeError('Failed to fetch') : CONFLICT);
      },
      readStored: (paymentId) => {
        reads.push(paymentId);
        return Promise.resolve(STORED);
      },
    });
    const mintedAtCreation = ids.count();

    // The first send's fate is unknown (the server saved it; the answer was lost).
    const first = await flow.submit(planner(form('100'), [A]));
    expect(first).toMatchObject({ kind: 'refused', errorKey: 'error.fallback' });

    // The merchant edits a figure and sends again with the SAME form.
    const second = await flow.submit(planner(form('120'), [A]));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.paymentId).toBe(sent[0]?.paymentId);
    expect(sent[1]?.allocations[0]?.allocationId).toBe(sent[0]?.allocations[0]?.allocationId);
    expect(reads).toEqual([sent[0]?.paymentId]);
    expect(second).toEqual({ kind: 'alreadySaved', payment: STORED });

    // No id was minted by any send: only at creation, and once for the one invoice.
    expect(ids.count()).toBe(mintedAtCreation + 1);

    // And the screen shows the stored payment, not a refusal and not a fresh form.
    if (second === null) throw new Error('the second send was not made');
    const after = afterOutcome(state(form('120'), [A]), second);
    expect(after.stored).toEqual(STORED);
    expect(after.errorKey).toBeNull();
    expect(after.result).toBeNull();
    expect(after.form.amount).toBe('120');
  });

  it('when the stored payment cannot be read, it says so and offers to read again — never a new form', async () => {
    const flow = createCollectFlow({
      mint: counter().mint,
      send: () => Promise.reject(CONFLICT),
      readStored: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const outcome = await flow.submit(planner(form('100'), [A]));
    expect(outcome).toEqual({ kind: 'storedUnread' });
    if (outcome === null) throw new Error('the send was not made');
    const after = afterOutcome(state(form('100'), [A]), outcome);
    expect(after.storedUnread).toBe(true);
    expect(after.errorKey).toBe(STORED_UNREADABLE_KEY);
    expect(after.stored).toBeNull();
    // Reading again asks for the same payment id.
    const reread: string[] = [];
    const flow2 = createCollectFlow({
      mint: counter().mint,
      send: () => Promise.reject(CONFLICT),
      readStored: (id) => {
        reread.push(id);
        return Promise.reject(new TypeError('x'));
      },
    });
    await flow2.submit(planner(form('100'), [A]));
    await flow2.rereadStored();
    expect(reread).toEqual([flow2.ids.paymentId, flow2.ids.paymentId]);
  });

  it('every send of one flow carries the same ids, a retryable 409 included', async () => {
    const sent: CollectPaymentRequestDto[] = [];
    let call = 0;
    const flow = createCollectFlow({
      mint: counter().mint,
      send: (body) => {
        sent.push(body);
        call += 1;
        if (call === 1) return Promise.reject(RETRYABLE);
        if (call === 2) return Promise.reject(REFUSED);
        return Promise.resolve(answerFor(body, false));
      },
      readStored: () => Promise.reject(new Error('not asked')),
    });
    const refused = await flow.submit(planner(form('100'), [A]));
    expect(refused).toMatchObject({ kind: 'refused', errorKey: 'error.customer_payment.amount_exceeds_outstanding' });
    const saved = await flow.submit(planner(form('100'), [A]));
    expect(saved).toMatchObject({ kind: 'saved' });
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((b) => b.paymentId)).size).toBe(1);
    expect(new Set(sent.map((b) => b.allocations[0]?.allocationId)).size).toBe(1);
  });

  it('a double click sends once', async () => {
    let calls = 0;
    let release: (v: CustomerPaymentResultDto) => void = () => undefined;
    const flow = createCollectFlow({
      mint: counter().mint,
      send: (body) => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve(answerFor(body, false));
        });
      },
      readStored: () => Promise.reject(new Error('not asked')),
    });
    const first = flow.submit(planner(form('100'), [A]));
    const second = flow.submit(planner(form('100'), [A]));
    expect(second).toBeNull();
    expect(calls).toBe(1);
    release(answerFor(planOk(planner(form('100'), [A])), false));
    await first;
  });

  it('an invalid form sends nothing and comes back as its plan', async () => {
    let calls = 0;
    const flow = createCollectFlow({
      mint: counter().mint,
      send: () => ((calls += 1), Promise.reject(new Error('x'))),
      readStored: () => Promise.reject(new Error('x')),
    });
    const outcome = await flow.submit(planner(form('1e3'), [A]));
    expect(outcome?.kind).toBe('invalid');
    expect(calls).toBe(0);
  });
});

describe('afterOutcome — what the screen keeps', () => {
  const typed = state(form('150.00'), [{ ...A, amount: '150.00' }]);

  it('a refusal sets only the refusal: every typed figure stays', () => {
    const after = afterOutcome(typed, { kind: 'refused', errorKey: 'error.FORBIDDEN' });
    expect(after.form).toEqual(typed.form);
    expect(after.rows).toEqual(typed.rows);
    expect(after.errorKey).toBe('error.FORBIDDEN');
    expect(after.result).toBeNull();
    expect(after.busy).toBe(false);
  });

  it('a replayed answer is a success, not an error', () => {
    const body = planOk(planner(form('100'), [A]));
    const after = afterOutcome(typed, { kind: 'saved', payment: answerFor(body, true) });
    expect(after.result?.replayed).toBe(true);
    expect(after.errorKey).toBeNull();
    expect(after.stored).toBeNull();
  });

  it('an invalid plan marks the form and the rows, and keeps the figures', () => {
    const plan = planner(form('150.00'), [{ ...A, amount: '1.2.3' }])(
      createCollectFlow({ mint: counter().mint, send: () => Promise.reject(new Error('x')), readStored: () => Promise.reject(new Error('x')) }).ids,
    );
    if (plan.ok) throw new Error('expected an invalid plan');
    const before = state(form('150.00'), [{ ...A, amount: '1.2.3' }]);
    const after = afterOutcome(before, { kind: 'invalid', errors: plan.errors, invalidRows: plan.invalidRows });
    expect(after.form.amount).toBe('150.00');
    expect(after.form.errors.rows).toBe(true);
    expect(after.rows[0]?.invalid).toBe(true);
    expect(after.rows[0]?.amount).toBe('1.2.3');
  });
});

function planOk(make: ReturnType<typeof planner>): CollectPaymentRequestDto {
  const plan = make({
    paymentId: '00000000-0000-4000-8000-000000000001',
    creditId: '00000000-0000-4000-8000-000000000002',
    allocationIdFor: () => '00000000-0000-4000-8000-000000000003',
  });
  if (!plan.ok) throw new Error('expected a plan');
  return plan.body;
}
