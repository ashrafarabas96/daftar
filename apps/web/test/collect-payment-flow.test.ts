import { describe, expect, it } from 'vitest';
import type { CustomerOpenInvoiceDto, CustomerPaymentDto, CustomerPaymentResultDto } from '@daftar/shared-contracts';
import { ApiError } from '@/lib/client';
import type { CollectPaymentRequestDto } from '@/lib/phase4-collect-payment-api';
import type { MethodChoice } from '@/views/common/payment-methods';
import { planCollectPayment, type CollectFormModel, type CollectRowModel } from '@/views/customers/collect-payment';
import {
  PENDING_NOT_FOUND_KEY,
  STORED_UNREADABLE_KEY,
  UNCONFIRMED_KEY,
  afterOutcome,
  createCollectFlow,
  pendingKey,
  type CollectScreenState,
  type PendingStore,
} from '@/views/customers/collect-flow';

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
const NOT_FOUND = new ApiError(404, 'NOT_FOUND', { receivablesCode: 'customer_payment.not_found' });

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
    let read = 0;
    const flow = createCollectFlow({
      mint: ids.mint,
      send: (body) => {
        sent.push(body);
        call += 1;
        return Promise.reject(call === 1 ? new TypeError('Failed to fetch') : CONFLICT);
      },
      readStored: (paymentId) => {
        reads.push(paymentId);
        read += 1;
        // The first read-back, right after the lost answer, does not find it yet; the second does.
        return read === 1 ? Promise.reject(NOT_FOUND) : Promise.resolve(STORED);
      },
    });
    const mintedAtCreation = ids.count();

    // The first send's fate is unknown (the server saved it; the answer was lost). It is NOT
    // reported as "nothing was saved": the flow reads the payment back by its id at once, and
    // when that read does not find it, says the save could not be confirmed.
    const first = await flow.submit(planner(form('100'), [A]));
    expect(first).toEqual({ kind: 'unconfirmed', errorKey: UNCONFIRMED_KEY });
    expect(reads).toEqual([sent[0]?.paymentId]);

    // The merchant edits a figure and sends again with the SAME form.
    const second = await flow.submit(planner(form('120'), [A]));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.paymentId).toBe(sent[0]?.paymentId);
    expect(sent[1]?.allocations[0]?.allocationId).toBe(sent[0]?.allocations[0]?.allocationId);
    expect(reads).toEqual([sent[0]?.paymentId, sent[0]?.paymentId]);
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

/**
 * HARM-STOP, not a fix of the underlying defect. A lost answer or a 5xx leaves the send's fate
 * unknown: the server may have saved the payment. The screen must never say "nothing was saved"
 * then, and a reload must not mint new ids (a second payment). Whether the SERVER refuses a
 * second payment sent under a NEW id is not measured here (L3 owns it); this only keeps the ids.
 */
describe('createCollectFlow — an unknown outcome is read back, never called "nothing was saved"', () => {
  const unknownFates: ReadonlyArray<[string, unknown]> = [
    ['no answer at all', new TypeError('Failed to fetch')],
    ['500, the first server failure', new ApiError(500, 'INTERNAL_ERROR')],
    ['503', new ApiError(503, 'SERVICE_UNAVAILABLE')],
  ];

  for (const [name, failure] of unknownFates) {
    it(`${name}: the payment is read back by its id; found => shown as already saved`, async () => {
      const reads: string[] = [];
      const STORED: CustomerPaymentDto = { ...answerFor(planOk(planner(form('100'), [A])), false) };
      const flow = createCollectFlow({
        mint: counter().mint,
        send: () => Promise.reject(failure),
        readStored: (id) => (reads.push(id), Promise.resolve(STORED)),
      });
      const outcome = await flow.submit(planner(form('100'), [A]));
      expect(outcome).toEqual({ kind: 'alreadySaved', payment: STORED });
      expect(reads).toEqual([flow.ids.paymentId]);
    });

    it(`${name}: not found => "could not confirm", the form and the ids kept, never the "nothing was saved" text`, async () => {
      const sent: CollectPaymentRequestDto[] = [];
      const flow = createCollectFlow({
        mint: counter().mint,
        send: (body) => (sent.push(body), Promise.reject(failure)),
        readStored: () => Promise.reject(NOT_FOUND),
      });
      const outcome = await flow.submit(planner(form('100'), [A]));
      expect(outcome).toEqual({ kind: 'unconfirmed', errorKey: UNCONFIRMED_KEY });
      if (outcome === null) throw new Error('the send was not made');
      const after = afterOutcome(state(form('100'), [A]), outcome);
      expect(after.errorKey).toBe(UNCONFIRMED_KEY);
      expect(after.errorKey).not.toBe('error.fallback');
      expect(after.errorKey).not.toBe('error.INTERNAL_ERROR');
      expect(after.form.amount).toBe('100');
      expect(after.storedUnread).toBe(false);
      expect(after.stored).toBeNull();
      expect(after.result).toBeNull();
      // Pressing Save again from this form re-sends the SAME ids.
      await flow.submit(planner(form('100'), [A]));
      expect(sent).toHaveLength(2);
      expect(sent[1]?.paymentId).toBe(sent[0]?.paymentId);
      expect(sent[1]?.allocations[0]?.allocationId).toBe(sent[0]?.allocations[0]?.allocationId);
    });
  }

  it('the read-back itself fails: "may already be saved, read again", no form; reading again and not finding it gives the form back', async () => {
    let read = 0;
    const flow = createCollectFlow({
      mint: counter().mint,
      send: () => Promise.reject(new TypeError('Failed to fetch')),
      readStored: () => ((read += 1), Promise.reject(read === 1 ? new TypeError('Failed to fetch') : NOT_FOUND)),
    });
    expect(await flow.submit(planner(form('100'), [A]))).toEqual({ kind: 'storedUnread' });
    const again = await flow.rereadStored();
    expect(again).toEqual({ kind: 'unconfirmed', errorKey: UNCONFIRMED_KEY });
    if (again === null) throw new Error('no read');
    const after = afterOutcome({ ...state(form('100'), [A]), storedUnread: true, errorKey: STORED_UNREADABLE_KEY }, again);
    expect(after.storedUnread).toBe(false);
    expect(after.errorKey).toBe(UNCONFIRMED_KEY);
  });

  // The boundary: 499 and 404 are the server's own answer (it refused; nothing of this send is stored);
  // 500 is the first status whose fate is unknown.
  const explicitRefusals: ReadonlyArray<[string, ApiError]> = [
    ['409 amount_exceeds_outstanding', REFUSED],
    ['404 on the send (e.g. the method is gone)', NOT_FOUND],
    ['403', new ApiError(403, 'FORBIDDEN')],
    ['499, the last status below 500', new ApiError(499, 'CLIENT_CLOSED')],
  ];
  for (const [name, refusal] of explicitRefusals) {
    it(`${name}: an explicit refusal keeps its own text and reads nothing back`, async () => {
      let reads = 0;
      const flow = createCollectFlow({
        mint: counter().mint,
        send: () => Promise.reject(refusal),
        readStored: () => ((reads += 1), Promise.reject(new Error('not asked'))),
      });
      const outcome = await flow.submit(planner(form('100'), [A]));
      expect(outcome?.kind).toBe('refused');
      expect(reads).toBe(0);
    });
  }
});

function memoryStore(): PendingStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}
const throwingStore: PendingStore = {
  get: () => {
    throw new Error('SecurityError');
  },
  set: () => {
    throw new Error('QuotaExceededError');
  },
  remove: () => {
    throw new Error('SecurityError');
  },
};

describe('createCollectFlow — the ids of an unconfirmed send survive a reload', () => {
  it('a send in flight is remembered per customer; a reload re-uses ITS ids and reads it back first', async () => {
    const store = memoryStore();
    const firstSent: CollectPaymentRequestDto[] = [];
    const before = createCollectFlow({
      mint: counter().mint,
      pending: { store, customerId: CUSTOMER },
      send: (body) => (firstSent.push(body), Promise.reject(new TypeError('Failed to fetch'))),
      readStored: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(before.resumed).toBe(false);
    await before.submit(planner(form('100'), [A]));
    expect(store.map.has(pendingKey(CUSTOMER))).toBe(true);

    // The reload: a new flow from a DIFFERENT minter must still carry the remembered ids.
    const reads: string[] = [];
    const resent: CollectPaymentRequestDto[] = [];
    const reloaded = createCollectFlow({
      mint: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      pending: { store, customerId: CUSTOMER },
      send: (body) => (resent.push(body), Promise.resolve(answerFor(body, true))),
      readStored: (id) => (reads.push(id), Promise.reject(NOT_FOUND)),
    });
    expect(reloaded.resumed).toBe(true);
    expect(reloaded.ids.paymentId).toBe(firstSent[0]?.paymentId);
    expect(reloaded.ids.creditId).toBe(before.ids.creditId);
    const resumed = await reloaded.resume();
    expect(reads).toEqual([firstSent[0]?.paymentId]);
    expect(resumed).toEqual({ kind: 'unconfirmed', errorKey: PENDING_NOT_FOUND_KEY });
    // Saving again after the reload carries the same payment and allocation ids.
    const saved = await reloaded.submit(planner(form('100'), [A]));
    expect(saved?.kind).toBe('saved');
    expect(resent[0]?.paymentId).toBe(firstSent[0]?.paymentId);
    expect(resent[0]?.allocations[0]?.allocationId).toBe(firstSent[0]?.allocations[0]?.allocationId);
    // A confirmed save forgets the ids: the next form is a new payment.
    expect(store.map.has(pendingKey(CUSTOMER))).toBe(false);
  });

  it('a reload that finds the payment shows it as already saved and forgets the ids', async () => {
    const store = memoryStore();
    const first = createCollectFlow({
      mint: counter().mint,
      pending: { store, customerId: CUSTOMER },
      send: () => Promise.reject(new ApiError(502, 'BAD_GATEWAY')),
      readStored: () => Promise.reject(new ApiError(503, 'SERVICE_UNAVAILABLE')),
    });
    await first.submit(planner(form('100'), [A]));
    const STORED: CustomerPaymentDto = { ...answerFor(planOk(planner(form('100'), [A])), false) };
    const reloaded = createCollectFlow({
      mint: counter().mint,
      pending: { store, customerId: CUSTOMER },
      send: () => Promise.reject(new Error('not asked')),
      readStored: () => Promise.resolve(STORED),
    });
    expect(await reloaded.resume()).toEqual({ kind: 'alreadySaved', payment: STORED });
    expect(store.map.has(pendingKey(CUSTOMER))).toBe(false);
  });

  it('the remembered ids are per customer: another customer gets new ones', async () => {
    const store = memoryStore();
    const first = createCollectFlow({
      mint: counter().mint,
      pending: { store, customerId: CUSTOMER },
      send: () => Promise.reject(new TypeError('x')),
      readStored: () => Promise.reject(NOT_FOUND),
    });
    await first.submit(planner(form('100'), [A]));
    const other = createCollectFlow({
      mint: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      pending: { store, customerId: '9d2e0b63-4c8f-4e1b-8b64-1a3c7d2e8b02' },
      send: () => Promise.reject(new Error('x')),
      readStored: () => Promise.reject(new Error('x')),
    });
    expect(other.resumed).toBe(false);
    expect(other.ids.paymentId).not.toBe(first.ids.paymentId);
    expect(other.resume()).toBeNull();
  });

  it('an explicit refusal of a send whose fate was never unknown forgets the ids; one after an unknown fate keeps them', async () => {
    const clean = memoryStore();
    const refusedOnly = createCollectFlow({
      mint: counter().mint,
      pending: { store: clean, customerId: CUSTOMER },
      send: () => Promise.reject(REFUSED),
      readStored: () => Promise.reject(new Error('not asked')),
    });
    await refusedOnly.submit(planner(form('100'), [A]));
    expect(clean.map.has(pendingKey(CUSTOMER))).toBe(false);

    const doubtful = memoryStore();
    let call = 0;
    const flow = createCollectFlow({
      mint: counter().mint,
      pending: { store: doubtful, customerId: CUSTOMER },
      send: () => ((call += 1), Promise.reject(call === 1 ? new TypeError('x') : REFUSED)),
      readStored: () => Promise.reject(NOT_FOUND),
    });
    await flow.submit(planner(form('100'), [A]));
    await flow.submit(planner(form('100'), [A]));
    expect(doubtful.map.has(pendingKey(CUSTOMER))).toBe(true);
  });

  it('a corrupted or foreign record is not taken as ids', () => {
    for (const junk of ['not json', '{"paymentId":"x","creditId":"y","allocations":{}}', '[]', 'null', '{"paymentId":1}']) {
      const store = memoryStore();
      store.map.set(pendingKey(CUSTOMER), junk);
      const flow = createCollectFlow({
        mint: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        pending: { store, customerId: CUSTOMER },
        send: () => Promise.reject(new Error('x')),
        readStored: () => Promise.reject(new Error('x')),
      });
      expect(flow.resumed, junk).toBe(false);
      expect(flow.ids.paymentId).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    }
  });

  it('works with no storage at all, and with a storage that throws on every call', async () => {
    for (const store of [null, throwingStore]) {
      let sends = 0;
      const flow = createCollectFlow({
        mint: counter().mint,
        pending: { store, customerId: CUSTOMER },
        send: (body) => ((sends += 1), Promise.resolve(answerFor(body, false))),
        readStored: () => Promise.reject(new Error('not asked')),
      });
      expect(flow.resumed).toBe(false);
      expect((await flow.submit(planner(form('100'), [A])))?.kind).toBe('saved');
      expect(sends).toBe(1);
    }
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
