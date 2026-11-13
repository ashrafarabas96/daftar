import { describe, expect, it } from 'vitest';
import type { CustomerOpenInvoiceDto } from '@daftar/shared-contracts';
import type { MethodChoice } from '@/views/common/payment-methods';
import {
  MAX_ALLOCATIONS,
  compareMinor,
  createSubmitGuard,
  heldOnRow,
  isAllocatable,
  mintCollectIds,
  parseAmount,
  planCollectPayment,
  sumMinor,
  surplusOf,
  type CollectFormModel,
  type CollectRowModel,
} from '@/views/customers/collect-payment';

/**
 * The money of the "Receive a payment" screen, pure: the typed amount becomes
 * minor units by TEXT, the only sum the screen makes (to know whether there is
 * a remainder, which decides whether `creditId` is sent) is BigInt-exact and
 * single-currency, and the ids are minted once per form.
 *
 * Every boundary is asserted on both sides and on it: 2^53 itself, one below
 * and one above, the 19-digit ceiling the server's schema admits, a remainder
 * of one minor unit, an exact match, and an excess of one minor unit.
 */

const TWO_53 = '9007199254740992';
const TWO_53_PLUS_1 = '9007199254740993';

describe('parseAmount — typed major units to minor units, by text', () => {
  it('reads plain amounts at the currency precision', () => {
    expect(parseAmount('12.50', 'ILS')).toBe('1250');
    expect(parseAmount('12.5', 'ILS')).toBe('1250');
    expect(parseAmount('12', 'ILS')).toBe('1200');
    expect(parseAmount('0.01', 'ILS')).toBe('1');
    expect(parseAmount('1.234', 'JOD')).toBe('1234');
    expect(parseAmount('0.001', 'JOD')).toBe('1');
  });

  it('refuses an amount in a currency the platform does not know, instead of guessing its decimals', () => {
    expect(parseAmount('5', 'JPY')).toBeNull();
    expect(parseAmount('5', 'XXX')).toBeNull();
  });

  it('trims surrounding space and leading zeros never survive', () => {
    expect(parseAmount(' 7.00 ', 'ILS')).toBe('700');
    expect(parseAmount('007.10', 'ILS')).toBe('710');
  });

  it('refuses every shape that is not a plain positive decimal', () => {
    for (const text of ['', ' ', '1.5.5', '1e3', '1E3', '+5', '-5', '1,000', '.5', '5.', '0x10', 'Infinity', 'NaN', '١,٠', '5-', '1..5']) {
      expect(parseAmount(text, 'ILS'), text).toBeNull();
    }
  });

  it('refuses zero in every spelling — a payment is a positive amount', () => {
    for (const text of ['0', '0.0', '0.00', '000', '٠']) expect(parseAmount(text, 'ILS'), text).toBeNull();
  });

  it('refuses more decimals than the currency has, and never rounds', () => {
    expect(parseAmount('12.345', 'ILS')).toBeNull();
    expect(parseAmount('12.001', 'ILS')).toBeNull();
    expect(parseAmount('1.2345', 'JOD')).toBeNull();
    expect(parseAmount('0.0001', 'JOD')).toBeNull();
  });

  it('converts Arabic-Indic and Extended Arabic-Indic digits and the Arabic decimal mark explicitly', () => {
    expect(parseAmount('١٢٫٥٠', 'ILS')).toBe('1250');
    expect(parseAmount('١٢.٥', 'ILS')).toBe('1250');
    expect(parseAmount('۱۲', 'ILS')).toBe('1200');
  });

  it('is exact beyond 2^53: one below, on, and one above', () => {
    expect(parseAmount('90071992547409.91', 'ILS')).toBe('9007199254740991');
    expect(parseAmount('90071992547409.92', 'ILS')).toBe(TWO_53);
    expect(parseAmount('90071992547409.93', 'ILS')).toBe(TWO_53_PLUS_1);
    // The server's schema admits up to 19 digits of minor units.
    expect(parseAmount('99999999999999999.99', 'ILS')).toBe('9999999999999999999');
  });
});

describe('compareMinor and sumMinor — BigInt on strings, one currency', () => {
  it('compares on each side of and on the boundary, beyond 2^53', () => {
    expect(compareMinor(TWO_53_PLUS_1, TWO_53)).toBe(1);
    expect(compareMinor(TWO_53, TWO_53_PLUS_1)).toBe(-1);
    expect(compareMinor(TWO_53_PLUS_1, TWO_53_PLUS_1)).toBe(0);
    expect(compareMinor('9999', '10000')).toBe(-1);
    expect(compareMinor('10000', '10000')).toBe(0);
    expect(compareMinor('10001', '10000')).toBe(1);
  });

  it('sums exactly beyond 2^53, as an absolute value', () => {
    const sum = sumMinor(
      [
        { currency: 'ILS', amountMinor: TWO_53_PLUS_1 },
        { currency: 'ILS', amountMinor: '1' },
      ],
      'ILS',
    );
    expect(sum).toBe('9007199254740994');
    expect(sumMinor([{ currency: 'ILS', amountMinor: '9999999999999999999' }], 'ILS')).toBe('9999999999999999999');
    expect(sumMinor([], 'ILS')).toBe('0');
  });

  it('refuses to add two currencies, instead of skipping or converting', () => {
    expect(() =>
      sumMinor(
        [
          { currency: 'ILS', amountMinor: '100' },
          { currency: 'USD', amountMinor: '100' },
        ],
        'ILS',
      ),
    ).toThrow(/currency/);
  });

  it('refuses a figure that is not a minor-unit integer string', () => {
    expect(() => sumMinor([{ currency: 'ILS', amountMinor: '1.5' }], 'ILS')).toThrow();
    expect(() => compareMinor('1e3', '1')).toThrow();
  });
});

// ── The plan of a payment ────────────────────────────────────────────────

const CUSTOMER = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';
const METHOD_ID = 'a0416f73-0006-4a7b-8c9d-000000000011';
const CASH: MethodChoice = { paymentMethodId: METHOD_ID, name: 'Cash', requiresReference: false };
const BANK: MethodChoice = { paymentMethodId: METHOD_ID, name: 'Bank', requiresReference: true };

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

const A = invoice({ invoiceId: '11111111-1111-4111-8111-111111111111', documentNumber: 'INV-0001' });
const B = invoice({ invoiceId: '22222222-2222-4222-8222-222222222222', documentNumber: 'INV-0002' });
const USD = invoice({ invoiceId: '33333333-3333-4333-8333-333333333333', currency: 'USD', documentNumber: 'INV-0003' });
const CREDIT = invoice({
  invoiceId: '44444444-4444-4444-8444-444444444444',
  documentKind: 'credit_note',
  documentNumber: 'CN-0001',
  outstandingTxnMinor: '-500',
  outstandingBaseMinor: '-500',
  isCredit: true,
});

const form = (over: Partial<CollectFormModel> = {}): CollectFormModel => ({
  methodId: METHOD_ID,
  currency: 'ILS',
  currencyOptions: ['ILS', 'USD'],
  amount: '150.00',
  date: '2026-11-13',
  reference: '',
  errors: {},
  ...over,
});

function counterIds() {
  let n = 0;
  return mintCollectIds(() => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  });
}

const plan = (over: { form?: Partial<CollectFormModel>; rows?: CollectRowModel[]; method?: MethodChoice } = {}, ids = counterIds()) =>
  planCollectPayment({ customerId: CUSTOMER, form: form(over.form), rows: over.rows ?? [A, B], method: 'method' in over ? over.method : CASH, ids });

/** Every leaf of a value: no money may travel as a JS number. */
function leaves(value: unknown, path = '$'): { path: string; value: unknown }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
  return [{ path, value }];
}

describe('planCollectPayment — the body the screen sends', () => {
  it('a partial payment over two invoices: pairs equal, strings only, the remainder kept with a credit id', () => {
    const p = plan({
      rows: [
        { ...A, amount: '100' },
        { ...B, amount: '49.99' },
      ],
    });
    if (!p.ok) throw new Error('expected a plan');
    expect(p.surplus).toBe('kept');
    expect(p.body.amountMinor).toBe('15000');
    expect(p.body.currencyCode).toBe('ILS');
    expect(p.body.customerId).toBe(CUSTOMER);
    expect(p.body.creditId).not.toBeNull();
    expect(p.body.allocations).toEqual([
      { allocationId: expect.any(String), invoiceId: A.invoiceId, paymentAmountMinor: '10000', invoiceAmountAppliedMinor: '10000' },
      { allocationId: expect.any(String), invoiceId: B.invoiceId, paymentAmountMinor: '4999', invoiceAmountAppliedMinor: '4999' },
    ]);
    for (const leaf of leaves(p.body)) expect(typeof leaf.value, leaf.path).not.toBe('number');
  });

  it('the remainder boundary: one minor unit left keeps a credit id, exactly zero sends null, one over sends null', () => {
    const under = plan({
      rows: [
        { ...A, amount: '100' },
        { ...B, amount: '49.99' },
      ],
    });
    const exact = plan({
      rows: [
        { ...A, amount: '100' },
        { ...B, amount: '50' },
      ],
    });
    const over = plan({
      rows: [
        { ...A, amount: '100' },
        { ...B, amount: '50.01' },
      ],
    });
    if (!under.ok || !exact.ok || !over.ok) throw new Error('expected three plans');
    expect([under.surplus, exact.surplus, over.surplus]).toEqual(['kept', 'none', 'over']);
    expect(under.body.creditId).not.toBeNull();
    expect(exact.body.creditId).toBeNull();
    // An excess is NOT refused here: the server is the authority and its refusal text is shown.
    expect(over.body.creditId).toBeNull();
  });

  it('no allocation at all is a whole payment held for the customer (zero allocations is a legal body)', () => {
    const p = plan({ rows: [] });
    if (!p.ok) throw new Error('expected a plan');
    expect(p.body.allocations).toEqual([]);
    expect(p.surplus).toBe('kept');
    expect(p.body.creditId).not.toBeNull();
  });

  it('the same form planned twice — a retry, a double click — carries the very same ids', () => {
    const ids = counterIds();
    const rows = [
      { ...A, amount: '100' },
      { ...B, amount: '10' },
    ];
    const first = plan({ rows }, ids);
    const second = plan({ rows }, ids);
    if (!first.ok || !second.ok) throw new Error('expected two plans');
    expect(second.body).toEqual(first.body);
    expect(second.body.paymentId).toBe(first.body.paymentId);
    expect(second.body.creditId).toBe(first.body.creditId);
    expect(second.body.allocations.map((a) => a.allocationId)).toEqual(first.body.allocations.map((a) => a.allocationId));
    // One id per invoice, distinct from each other and from the payment's.
    const all = [first.body.paymentId, first.body.creditId, ...first.body.allocations.map((a) => a.allocationId)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('an invoice in another currency and a balance row are never allocated, whatever is typed against them', () => {
    expect(isAllocatable(USD, 'ILS')).toBe(false);
    expect(isAllocatable(USD, 'USD')).toBe(true);
    expect(isAllocatable(CREDIT, 'ILS')).toBe(false);
    const p = plan({
      rows: [
        { ...A, amount: '100' },
        { ...USD, amount: '50' },
        { ...CREDIT, amount: '5' },
      ],
    });
    if (!p.ok) throw new Error('expected a plan');
    expect(p.body.allocations.map((a) => a.invoiceId)).toEqual([A.invoiceId]);
    expect(p.surplus).toBe('kept');
  });

  it('refuses a malformed row and names it, instead of skipping it', () => {
    const p = plan({
      rows: [
        { ...A, amount: '1.2.3' },
        { ...B, amount: '0' },
      ],
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.invalidRows).toEqual([A.invoiceId, B.invoiceId]);
    expect(p.errors.rows).toBe(true);
  });

  it('refuses a missing method, amount, date, and a reference the method requires', () => {
    const p = plan({ form: { amount: '1e3', date: '', reference: '  ' }, method: undefined });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errors).toMatchObject({ method: true, amount: true, date: true });
    const r = plan({ method: BANK, form: { reference: ' ' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.reference).toBe(true);
    const ok = plan({ method: BANK, form: { reference: '  TR-77 ' } });
    if (!ok.ok) throw new Error('expected a plan');
    expect(ok.body.reference).toBe('TR-77');
    const none = plan();
    if (!none.ok) throw new Error('expected a plan');
    expect(none.body.reference).toBeNull();
  });

  it('refuses more than fifty allocations before sending, and admits exactly fifty', () => {
    const many = (n: number): CollectRowModel[] =>
      Array.from({ length: n }, (_, i) => invoice({ invoiceId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, amount: '1' }));
    const fifty = plan({ form: { amount: '50' }, rows: many(MAX_ALLOCATIONS) });
    expect(fifty.ok).toBe(true);
    const fiftyOne = plan({ form: { amount: '51' }, rows: many(MAX_ALLOCATIONS + 1) });
    expect(fiftyOne.ok).toBe(false);
    if (!fiftyOne.ok) expect(fiftyOne.errors.tooMany).toBe(true);
  });

  it('is exact beyond 2^53 end to end', () => {
    const p = plan({ form: { amount: '90071992547409.94' }, rows: [{ ...A, amount: '90071992547409.93' }] });
    if (!p.ok) throw new Error('expected a plan');
    expect(p.body.amountMinor).toBe('9007199254740994');
    expect(p.body.allocations[0]?.paymentAmountMinor).toBe(TWO_53_PLUS_1);
    expect(p.surplus).toBe('kept');
  });
});

describe('heldOnRow — a balance row shown without its minus sign, and only then', () => {
  it('drops the sign character of a negative balance row and touches no digit', () => {
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: '-2500' })).toBe('2500');
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: `-${TWO_53_PLUS_1}` })).toBe(TWO_53_PLUS_1);
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: '-1' })).toBe('1');
  });

  it('shows no figure rather than guess: a debit row, zero, a positive or malformed balance figure', () => {
    expect(heldOnRow({ isCredit: false, outstandingTxnMinor: '-2500' })).toBeNull();
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: '2500' })).toBeNull();
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: '-0' })).toBeNull();
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: '0' })).toBeNull();
    expect(heldOnRow({ isCredit: true, outstandingTxnMinor: '-25.00' })).toBeNull();
  });
});

describe('surplusOf — the hint beside the form, from the same comparison', () => {
  it('answers only when every typed figure parses', () => {
    expect(surplusOf(form({ amount: '' }), [A])).toBeNull();
    expect(surplusOf(form(), [{ ...A, amount: 'x' }])).toBeNull();
    expect(surplusOf(form(), [{ ...A, amount: '150' }])).toBe('none');
    expect(surplusOf(form(), [{ ...A, amount: '149.99' }])).toBe('kept');
    expect(surplusOf(form(), [{ ...A, amount: '150.01' }])).toBe('over');
  });
});

describe('createSubmitGuard — a double click sends once', () => {
  it('a second press while the first is in flight sends nothing; after it settles the next press sends', async () => {
    const guard = createSubmitGuard();
    let calls = 0;
    let release: () => void = () => undefined;
    const send = () =>
      new Promise<string>((resolve) => {
        calls += 1;
        release = () => resolve('done');
      });
    const first = guard.run(send);
    const second = guard.run(send);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(guard.busy).toBe(true);
    expect(calls).toBe(1);
    release();
    await first;
    expect(guard.busy).toBe(false);
    const third = guard.run(send);
    expect(third).not.toBeNull();
    expect(calls).toBe(2);
    release();
    await third;
  });

  it('a refused send frees the guard and reaches the caller', async () => {
    const guard = createSubmitGuard();
    await expect(guard.run(() => Promise.reject(new Error('refused')))).rejects.toThrow('refused');
    expect(guard.busy).toBe(false);
  });
});
