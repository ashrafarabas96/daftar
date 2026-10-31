import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregate, contributionsFor, type AgingContribution, type InstallmentPlan, type OpenInvoiceRow } from './phase4-s7-aging-reference-model';

/**
 * DR-29, THE ARITHMETIC HALF — the sum of the per-bucket invoice counts is NOT
 * the number of open invoices, and the distinct count is a different figure
 * measured over the same population.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * IT IS AN ORACLE AND NOT A RED PROOF, and saying so is the point. The
 * reference model already counts distinct invoices per bucket and already
 * flattens an instalment plan across its schedule, so almost every case here
 * was GREEN before DR-29 was implemented and stayed green after. That makes it
 * useless as evidence that the fix works and valuable as evidence of something
 * else: that the inequality DR-29 documents is a REAL ARITHMETIC FACT about
 * this projection, with numbers anyone can recompute by hand, rather than a
 * defensive sentence somebody added to an interface.
 *
 * The red-first proof of the fix lives in
 * `packages/shared-contracts/test/dr29-invoice-count-non-additive.test.ts`,
 * over the contract, the migration and the read surface. The one case here
 * that IS red before the fix is `dr29_19`, which refuses to let this file
 * prove a property of a field the contract does not declare.
 *
 * ── AND IT IS NOT A CLAIM ABOUT THE INSTALLED ROUTINE ────────────────────
 *
 * Everything below runs over the TypeScript reference model. Whether the SQL
 * body agrees is a database claim: NOT_RUN here, and owed by the live aging
 * suites. What the model does establish is that no implementation COULD make
 * the sum equal the distinct count, because the two answer different
 * questions.
 *
 * ── CIVIL DATES, NO CLOCK ────────────────────────────────────────────────
 *
 * Every date below is a civil date string and every age is a whole-day
 * difference the model computes from them. Nothing reads `Date.now`, a local
 * zone or a timestamp, so every figure is identical under `TZ=UTC`,
 * `TZ=Asia/Jerusalem` and `TZ=Pacific/Honolulu` (DR-20).
 */

const AS_OF = '2026-10-27';
/** The standard boundaries (DR-10/DR-14): five bands, the not-due one first. */
const STANDARD = [0, 30, 60, 90] as const;

/**
 * The routine groups `WHERE c.txn_minor <> 0`, so a contribution of zero is
 * not a row and its invoice is not counted in any band. The model's
 * `aggregate` does no such filtering — it is the grouping step alone — so the
 * filter is applied HERE, explicitly, to keep the oracle's population the same
 * population the SQL groups. Doing it silently would have been the quiet kind
 * of difference that makes an oracle agree with nothing.
 */
function nonZero(contributions: readonly AgingContribution[]): readonly AgingContribution[] {
  return contributions.filter((c) => c.txnMinor !== 0n);
}

/** The document-level figure, measured the way the new routine measures it: DISTINCT invoice ids. */
function distinctOpenInvoices(contributions: readonly AgingContribution[]): number {
  return new Set(contributions.map((c) => c.invoiceId)).size;
}

/** The figure a client would get by doing the forbidden thing. */
function sumOfBucketCounts(buckets: readonly { readonly invoiceCount: number }[]): number {
  return buckets.reduce((acc, b) => acc + b.invoiceCount, 0);
}

// ── The portfolio ────────────────────────────────────────────────────────
//
// Ages at `2026-10-27`, each one recomputed by hand so the band numbers below
// are arithmetic and not an echo of the model:
//
//   2026-05-01 → 179 days  (30 + 30 + 31 + 31 + 30 + 27)  → exceeds 0,30,60,90 → band 5
//   2026-08-01 →  87 days  (30 + 30 + 27)                 → exceeds 0,30,60    → band 4
//   2026-09-27 →  30 days  (3 + 27)                       → exceeds 0          → band 2
//   2026-12-01 → −35 days                                 → exceeds none       → band 1
//
// A band is `1 + the number of boundaries the age STRICTLY exceeds`, so the
// 30-day row sits in band 2 and not band 3: `30 > 30` is false. That strictness
// is DR-10's and it is why the 2026-09-27 date is in the fixture at all.

/** One invoice under an ACTIVE plan whose schedule declares the whole total. Paid nothing. */
const PLANNED: OpenInvoiceRow = {
  invoiceId: 'INV-PLANNED',
  currencyCode: 'USD',
  dueDate: '2026-08-01',
  issueDate: '2026-04-01',
  outstandingTxnMinor: 1_000_000n,
  paidTxnMinor: 0n,
  paidBaseMinor: 0n,
  outstandingBaseMinor: 1_000_000n,
};

const PLAN: InstallmentPlan = {
  invoiceId: 'INV-PLANNED',
  status: 'active',
  downPaymentMinor: 200_000n,
  downPaymentDueDate: '2026-05-01',
  installments: [
    { seqNo: 1, dueDate: '2026-09-27', amountTxnMinor: 300_000n },
    { seqNo: 2, dueDate: '2026-12-01', amountTxnMinor: 500_000n },
  ],
};

/** An ordinary invoice with no plan: the whole figure at its own term. */
const PLAIN: OpenInvoiceRow = {
  invoiceId: 'INV-PLAIN',
  currencyCode: 'USD',
  dueDate: '2026-08-01',
  issueDate: '2026-07-01',
  outstandingTxnMinor: 400_000n,
  paidTxnMinor: 0n,
  paidBaseMinor: 0n,
  outstandingBaseMinor: 400_000n,
};

/** A settled invoice: still a row of the reader, contributes nothing, counts nowhere. */
const SETTLED: OpenInvoiceRow = {
  invoiceId: 'INV-SETTLED',
  currencyCode: 'USD',
  dueDate: '2026-08-01',
  issueDate: '2026-07-01',
  outstandingTxnMinor: 0n,
  paidTxnMinor: 250_000n,
  paidBaseMinor: 250_000n,
  outstandingBaseMinor: 0n,
};

describe('DR-29: the per-bucket counts do not partition the invoices', () => {
  it('dr29_16: one invoice under a plan reaches THREE bands, so the sum of the counts is 4 while only 2 invoices are open', () => {
    const contributions = nonZero(contributionsFor([PLANNED, PLAIN], [PLAN], AS_OF, [...STANDARD]));
    const buckets = aggregate(contributions);

    // The bands, by hand: the down payment at 2026-05-01 is band 5, instalment
    // 1 at 2026-09-27 is band 2, instalment 2 at 2026-12-01 is band 1, and the
    // plain invoice at 2026-08-01 is band 4. The schedule declares the whole
    // total, so there is no residual and no fourth contribution.
    expect(
      buckets.map((b) => b.bucketNo),
      'four bands are reached, in ascending order',
    ).toEqual([1, 2, 4, 5]);
    expect(
      buckets.map((b) => b.invoiceCount),
      'and each band holds exactly one DISTINCT invoice',
    ).toEqual([1, 1, 1, 1]);

    // THE WHOLE CARD, in two numbers that are not equal.
    expect(sumOfBucketCounts(buckets), 'the forbidden sum').toBe(4);
    expect(distinctOpenInvoices(contributions), 'the figure a merchant actually asked for').toBe(2);
    expect(sumOfBucketCounts(buckets)).toBeGreaterThan(distinctOpenInvoices(contributions));

    // And the money still conserves, which is what says the fixture is coherent
    // rather than merely convenient: the shares total the authoritative figure
    // EXACTLY, asserted as an absolute value and not as an identity between two
    // sums taken the same way.
    expect(contributions.reduce((acc, c) => acc + c.txnMinor, 0n)).toBe(1_400_000n);
    expect(PLANNED.outstandingTxnMinor + PLAIN.outstandingTxnMinor).toBe(1_400_000n);
  });

  it('dr29_17: with no plans at all the two figures AGREE — so the law is "not necessarily equal", never "never equal"', () => {
    // This is the half that keeps dr29_16 from being read as "the sum is always
    // wrong". Before P4-S7 every invoice made one contribution and the sum WAS
    // the count; that is still the answer for a portfolio with no plan, and a
    // client that happened to sum would get the right number — which is exactly
    // what makes the habit dangerous rather than obviously broken.
    const contributions = nonZero(contributionsFor([PLAIN, { ...PLANNED, invoiceId: 'INV-OTHER' }], [], AS_OF, [...STANDARD]));
    const buckets = aggregate(contributions);
    expect(
      buckets.map((b) => b.bucketNo),
      'both age at their own term; both land in band 4',
    ).toEqual([4]);
    expect(sumOfBucketCounts(buckets)).toBe(2);
    expect(distinctOpenInvoices(contributions)).toBe(2);
    expect(sumOfBucketCounts(buckets), 'equal here, and that is permitted').toBe(distinctOpenInvoices(contributions));
  });

  it('dr29_18: the population is the same one the buckets are built from — a settled invoice counts in neither', () => {
    // The new routine counts DISTINCT ids over the invoices whose settlement sum
    // is non-zero, which is the identical population the bands are built from.
    // So a fully settled invoice is a row of the authoritative reader and is in
    // neither figure, and the distinct count cannot drift from the bands by
    // counting a different set.
    const contributions = nonZero(contributionsFor([PLANNED, PLAIN, SETTLED], [PLAN], AS_OF, [...STANDARD]));
    expect(
      contributions.some((c) => c.invoiceId === 'INV-SETTLED'),
      'a zero contribution is not a row',
    ).toBe(false);
    expect(distinctOpenInvoices(contributions), 'two of the three invoices are open with something outstanding').toBe(2);

    // And the figure is INVARIANT across the slice that made the sum unreliable:
    // the same two invoices, read with and without the plan, give the same
    // distinct count while the sum of the bands changes from 2 to 4.
    const withoutPlan = nonZero(contributionsFor([PLANNED, PLAIN, SETTLED], [], AS_OF, [...STANDARD]));
    expect(distinctOpenInvoices(withoutPlan), 'the distinct count does not move').toBe(2);
    expect(sumOfBucketCounts(aggregate(withoutPlan)), 'while the sum does').toBe(2);
    expect(sumOfBucketCounts(aggregate(contributions))).toBe(4);
  });

  it('dr29_19: ANTI-ORPHAN — the contract really declares the field these numbers are about', () => {
    // Without this, the file proves an arithmetic fact about a figure no
    // interface offers, and would keep passing if the DR-39 counters were
    // dropped tomorrow. This is the one case here that is RED before DR-29 is
    // implemented.
    const contract = readFileSync(join(__dirname, '..', '..', 'shared-contracts', 'src', 'customers.ts'), 'utf8');
    // DR-39 amended the single figure into TWO per-currency counters, so what
    // the document must declare is the PAIR.
    expect(contract, 'the aging document must declare the distinct debit counter').toMatch(/openDebitCount:\s*number;/);
    expect(contract, 'and the distinct credit counter').toMatch(/openCreditCount:\s*number;/);
    expect(contract, 'and it must warn that the per-bucket counts are not additive').toContain('NOT ADDITIVE');
  });
});
