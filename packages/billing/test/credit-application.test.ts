/**
 * `TL-P5-R5` — PLATFORM CREDIT APPLICATION, as executed cases.
 *
 * Every clause of PART 25 is a case here: automatic at finalization, oldest
 * grant first by `created_at` then stable id, up to the invoice amount only,
 * payable never negative, remainder carries forward, no zero-value noise
 * rows, exact conservation, and no path to cash.
 *
 * The conservation cases are the point of the file. They are written as
 * PROPERTIES over a swept range rather than as examples, because an allocator
 * is exactly the kind of code that is correct on the three cases its author
 * thought of.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCreditToInvoice } from '../src/credit-application';
import { foldCreditBalance, type CreditAdjustment, type CreditLedgerScope } from '../src/credit';
import { BillingError } from '../src/errors';
import { blankOut } from './helpers/lexer';

const SCOPE: CreditLedgerScope = { businessId: 'biz-1', currency: 'ILS' };
const IDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];

function grant(id: string, amountMinor: bigint, occurredAt: string): CreditAdjustment {
  return { id, businessId: 'biz-1', kind: 'grant', amountMinor, currency: 'ILS', occurredAt, ref: 'plan-change', reason: 'downgrade proration' };
}

function apply(ledger: readonly CreditAdjustment[], invoiceTotalMinor: bigint, ids: readonly string[] = IDS) {
  return applyCreditToInvoice({
    scope: SCOPE,
    ledger,
    invoiceTotalMinor,
    invoiceRef: 'inv-2026-05',
    appliedAt: '2026-05-01T00:00:00.000Z',
    consumptionIds: ids,
    reason: 'automatic application at invoice finalization',
  });
}

function expectRefusal(fn: () => unknown, code: string): BillingError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
  return caught as BillingError;
}

describe('applyCreditToInvoice — the allocation', () => {
  it('applies available credit AUTOMATICALLY: there is no "whether" argument', () => {
    // The ruling's default is automatic application, so the function has no
    // opt-in and no opt-out. A caller who wanted to skip it would have to not
    // call it, which is a visible choice at the finalization site rather than
    // a flag nobody reads.
    const r = apply([grant('g1', 3_000n, '2026-04-10T00:00:00.000Z')], 10_000n);
    expect(r.appliedMinor).toBe(3_000n);
    expect(r.payableMinor).toBe(7_000n);
    expect(r.consumptions).toHaveLength(1);
  });

  it('takes the OLDEST grant first, and only as much of the next as it needs', () => {
    const ledger = [
      grant('g1', 1_000n, '2026-04-10T00:00:00.000Z'),
      grant('g2', 1_000n, '2026-04-11T00:00:00.000Z'),
      grant('g3', 1_000n, '2026-04-12T00:00:00.000Z'),
    ];
    const r = apply(ledger, 1_500n);
    expect(r.appliedMinor).toBe(1_500n);
    expect(r.payableMinor).toBe(0n);
    // g1 fully, g2 partly, g3 untouched — and the ORDER of the rows is the
    // allocation order, not an accident of iteration.
    expect(r.consumptions.map((c) => [c.appliesToGrantId, c.amountMinor])).toEqual([
      ['g1', 1_000n],
      ['g2', 500n],
    ]);
    expect(r.balanceAfterMinor).toBe(1_500n);
    expect(r.balanceAfter.grants.map((g) => [g.grantId, g.remainingMinor])).toEqual([
      ['g1', 0n],
      ['g2', 500n],
      ['g3', 1_000n],
    ]);
  });

  it('does not SORT: it reads the order the ledger authority already verified', () => {
    // An allocator that sorted would silently repair an order the balance
    // authority refuses, and the refusal is the whole protection against a
    // replayed or interleaved ledger. So an out-of-order ledger reaches the
    // fold and is refused there, rather than being tidied up here.
    const ledger = [grant('g1', 1_000n, '2026-04-12T00:00:00.000Z'), grant('g2', 1_000n, '2026-04-10T00:00:00.000Z')];
    expectRefusal(() => apply(ledger, 500n), 'billing.credit_ledger_out_of_order');
  });

  it('skips an exhausted grant without writing a zero-value row', () => {
    const ledger: CreditAdjustment[] = [
      grant('g1', 1_000n, '2026-04-10T00:00:00.000Z'),
      grant('g2', 1_000n, '2026-04-11T00:00:00.000Z'),
      {
        id: 'old',
        businessId: 'biz-1',
        kind: 'consumption',
        amountMinor: 1_000n,
        currency: 'ILS',
        occurredAt: '2026-04-20T00:00:00.000Z',
        ref: 'inv-2026-04',
        reason: 'earlier application',
        appliesToGrantId: 'g1',
      },
    ];
    const r = apply(ledger, 400n);
    // g1 is spent, so it contributes NO row — "no zero-value noise rows".
    expect(r.consumptions.map((c) => c.appliesToGrantId)).toEqual(['g2']);
    expect(r.consumptions.every((c) => c.amountMinor > 0n)).toBe(true);
  });

  it('writes NO rows at all when there is no credit', () => {
    const r = apply([], 10_000n);
    expect(r.appliedMinor).toBe(0n);
    expect(r.payableMinor).toBe(10_000n);
    expect(r.consumptions).toEqual([]);
  });

  it('carries the invoice ref, the instant and the reason onto every row', () => {
    const r = apply([grant('g1', 5_000n, '2026-04-10T00:00:00.000Z')], 2_000n);
    for (const c of r.consumptions) {
      expect(c.ref).toBe('inv-2026-05');
      expect(c.occurredAt).toBe('2026-05-01T00:00:00.000Z');
      expect(c.reason).toBe('automatic application at invoice finalization');
      expect(c.businessId).toBe('biz-1');
      expect(c.kind).toBe('consumption');
    }
  });
});

describe('applyCreditToInvoice — the bounds', () => {
  it('applies UP TO THE INVOICE AMOUNT ONLY, leaving the rest as balance', () => {
    const r = apply([grant('g1', 10_000n, '2026-04-10T00:00:00.000Z')], 2_500n);
    expect(r.appliedMinor).toBe(2_500n);
    expect(r.payableMinor).toBe(0n);
    // "credit remainder carries forward"
    expect(r.balanceAfterMinor).toBe(7_500n);
  });

  it('never makes the payable negative, over a swept range of balance/invoice pairs', () => {
    for (let credit = 0n; credit <= 6_000n; credit += 500n) {
      for (let invoice = 500n; invoice <= 6_000n; invoice += 500n) {
        const ledger = credit === 0n ? [] : [grant('g1', credit, '2026-04-10T00:00:00.000Z')];
        const r = apply(ledger, invoice);
        expect(r.payableMinor).toBeGreaterThanOrEqual(0n);
        expect(r.appliedMinor).toBeGreaterThanOrEqual(0n);
        expect(r.appliedMinor).toBeLessThanOrEqual(invoice);
        expect(r.appliedMinor).toBeLessThanOrEqual(credit);
        // Conservation (1): the invoice side.
        expect(r.appliedMinor + r.payableMinor).toBe(invoice);
        // Conservation (2): the ledger side.
        expect(r.consumptions.reduce((t, c) => t + c.amountMinor, 0n)).toBe(r.appliedMinor);
        // Conservation (3): the authority side.
        expect(r.balanceAfterMinor).toBe(credit - r.appliedMinor);
      }
    }
  });

  it('conserves exactly across MANY grants and a sweep of invoice totals', () => {
    // Three grants of different sizes, so the allocation crosses grant
    // boundaries at several points rather than at one.
    const ledger = [
      grant('g1', 700n, '2026-04-10T00:00:00.000Z'),
      grant('g2', 1_300n, '2026-04-11T00:00:00.000Z'),
      grant('g3', 500n, '2026-04-12T00:00:00.000Z'),
    ];
    const total = 2_500n;
    let sawPartial = false;
    for (let invoice = 100n; invoice <= 3_000n; invoice += 100n) {
      const r = apply(ledger, invoice);
      const expected = invoice < total ? invoice : total;
      expect(r.appliedMinor).toBe(expected);
      expect(r.payableMinor).toBe(invoice - expected);
      expect(r.consumptions.reduce((t, c) => t + c.amountMinor, 0n)).toBe(expected);
      // Each row draws no more than its grant held, and the rows are in
      // oldest-first order with no repeats.
      const ids = r.consumptions.map((c) => c.appliesToGrantId);
      expect(ids).toEqual([...new Set(ids)]);
      expect(ids).toEqual(['g1', 'g2', 'g3'].filter((g) => ids.includes(g)));
      // And the re-fold agrees, which is the check that catches rows that
      // balance but are not valid.
      const refold = foldCreditBalance([...ledger, ...r.consumptions], SCOPE);
      expect(refold.balanceMinor).toBe(total - expected);
      if (r.consumptions.length > 1) sawPartial = true;
    }
    // Non-vacuity: the sweep really did cross grant boundaries.
    expect(sawPartial).toBe(true);
  });

  it('applies the whole balance when the invoice is exactly the balance', () => {
    const r = apply([grant('g1', 1_000n, '2026-04-10T00:00:00.000Z'), grant('g2', 1_000n, '2026-04-11T00:00:00.000Z')], 2_000n);
    expect(r.appliedMinor).toBe(2_000n);
    expect(r.payableMinor).toBe(0n);
    expect(r.balanceAfterMinor).toBe(0n);
    expect(r.consumptions).toHaveLength(2);
  });
});

describe('applyCreditToInvoice — the refusals', () => {
  it('REFUSES rather than partially applying when the caller supplied too few identities', () => {
    // A partial application is a lost credit that balances: the invoice would
    // be short-paid and the ledger would look consistent. So this refuses.
    const ledger = [
      grant('g1', 1_000n, '2026-04-10T00:00:00.000Z'),
      grant('g2', 1_000n, '2026-04-11T00:00:00.000Z'),
      grant('g3', 1_000n, '2026-04-12T00:00:00.000Z'),
    ];
    const e = expectRefusal(() => apply(ledger, 2_500n, ['only-one']), 'billing.credit_application_ids_exhausted');
    expect(e.toSafeJSON()).toEqual({ code: 'billing.credit_application_ids_exhausted', businessId: 'biz-1', currency: 'ILS' });
    // One id is enough for an application that needs exactly one row.
    expect(apply(ledger, 800n, ['only-one']).consumptions).toHaveLength(1);
  });

  it('REFUSES a non-positive invoice total rather than returning "nothing applied"', () => {
    expectRefusal(() => apply([grant('g1', 1_000n, '2026-04-10T00:00:00.000Z')], 0n), 'billing.payload_invalid');
    expectRefusal(() => apply([grant('g1', 1_000n, '2026-04-10T00:00:00.000Z')], -1n), 'billing.payload_invalid');
  });

  it('REFUSES a missing invoice ref, reason or instant', () => {
    const ledger = [grant('g1', 1_000n, '2026-04-10T00:00:00.000Z')];
    const good = { scope: SCOPE, ledger, invoiceTotalMinor: 500n, invoiceRef: 'inv', appliedAt: '2026-05-01T00:00:00.000Z', consumptionIds: IDS, reason: 'r' };
    expectRefusal(() => applyCreditToInvoice({ ...good, invoiceRef: ' ' }), 'billing.payload_invalid');
    expectRefusal(() => applyCreditToInvoice({ ...good, reason: '' }), 'billing.credit_reason_required');
    expectRefusal(() => applyCreditToInvoice({ ...good, appliedAt: 'next Tuesday' }), 'billing.as_of_required');
    expectRefusal(() => applyCreditToInvoice({ ...good, consumptionIds: undefined as unknown as string[] }), 'billing.payload_invalid');
  });

  it('REFUSES a ledger belonging to another business, and one in another currency', () => {
    const foreign = { ...grant('g1', 1_000n, '2026-04-10T00:00:00.000Z'), businessId: 'biz-2' };
    expectRefusal(() => apply([foreign], 500n), 'billing.credit_business_mismatch');
    const otherCurrency = { ...grant('g1', 1_000n, '2026-04-10T00:00:00.000Z'), currency: 'USD' };
    expectRefusal(() => apply([otherCurrency], 500n), 'billing.credit_currency_mismatch');
  });

  it('delegates every ledger rule to the balance authority rather than restating it', () => {
    // A replayed grant is refused by the fold, not by a second copy of the
    // rule living here — which is what keeps there being one authority.
    const dup = grant('g1', 1_000n, '2026-04-10T00:00:00.000Z');
    expectRefusal(() => apply([dup, dup], 500n), 'billing.credit_adjustment_replayed');
  });
});

describe('TL-P5-R5 — no path from an application to cash', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'src', 'credit-application.ts'), 'utf8');
  const CODE = blankOut(SOURCE);

  it('names the six forbidden things in prose (non-vacuity for the scan below)', () => {
    const lower = SOURCE.toLowerCase();
    for (const w of ['refund', 'payout', 'disbursement', 'expiry', 'write-off', 'reversal']) {
      expect(lower, `the prose does not mention ${w}, so the scan below proves nothing`).toContain(w);
    }
  });

  it('contains none of them in CODE, and imports no provider', () => {
    const lower = CODE.toLowerCase();
    for (const w of ['refund', 'payout', 'disburse', 'expir', 'writeoff', 'write_off', 'reversal', 'transfer']) {
      expect(lower, `${w} reached the code of the credit allocator`).not.toContain(w);
    }
    expect(CODE).not.toContain('./ports');
    expect(CODE).not.toContain('./fake-provider');
  });

  it('does not claim atomicity it cannot provide', () => {
    // The module must SAY that atomicity is the database's, because a pure
    // function that implied otherwise would be the worst kind of green. This
    // asserts the disclosure exists in the prose and that no code here
    // pretends to transact.
    expect(SOURCE).toContain('WAITING_FOR_INTEGRATED_SURFACE');
    const lower = CODE.toLowerCase();
    for (const w of ['begin', 'commit', 'rollback', 'transaction', 'advisory', 'lock']) {
      expect(lower, `${w} appears in a pure module's code`).not.toContain(w);
    }
  });
});
