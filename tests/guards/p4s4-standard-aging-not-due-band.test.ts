/**
 * DR-10 — THE STANDARD RECEIVABLES AGING, AND THE BAND THAT WAS MISSING.
 *
 * The owner's decision of 2026-10-26 settles a question the lock had left to
 * the caller: what the buckets ARE. The standard is
 *
 *     not due  |  1-30  |  31-60  |  61-90  |  over 90
 *
 * and the rule that gives it its meaning is that AN INVOICE NOT YET DUE IS IN
 * NO OVERDUE BAND. The sum across the bands is therefore the customer's TOTAL
 * RECEIVABLE — "إجمالي الذمم" — and not overdue debt.
 *
 * ── WHAT WAS WRONG, WHICH WAS NOT A MISMAPPING ───────────────────────────
 *
 * `p4s4-customer-aging-bucket-mapping.test.ts` fixed the C-1 defect: the
 * oldest band fell off the end of `labels` and its money vanished. This file
 * is about a DIFFERENT defect in the same answer, which survived that repair.
 *
 * `customer_ar_aging` (`0084`, §6) computes
 *
 *     bucket_no = 1 + <count of supplied thresholds that (as_of - due_date)
 *                      STRICTLY exceeds>
 *
 * With the old standard `[30, 60, 90]`, an invoice forty-five days FROM due —
 * `as_of - due_date = -45` — exceeds no threshold, so it arrived as
 * `bucket_no = 1`: the band the DTO labelled `0-30` and declared
 * `fromDays: 0`. Both statements were false about it. The money of invoices
 * NOBODY OWES YET was reported inside the youngest overdue band and inside
 * the total a merchant reads as what is late. An invoice with NO due date at
 * all landed there too, by the same arithmetic.
 *
 * The repair needs no change to the SQL and no migration. The arithmetic is
 * already strict (`>`), so a threshold of **0** splits exactly where the
 * decision splits: `(as_of - due_date) > 0` is false on and before the due
 * date and true after it. So the standard boundaries are
 *
 *     [0, 30, 60, 90]  ⇒  not-due | 1-30 | 31-60 | 61-90 | over-90
 *
 * and what changes in the product is three things: `0` becomes a legal FIRST
 * boundary, the band whose upper bound is `0` is labelled `not-due`, and the
 * first band's `fromDays` is `null` — because it has no lower bound, which is
 * the truth the old `0` was hiding.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ──────────────────────────────────
 *
 * It is a PURE test: the fold, the labels and the validator, with no database.
 * The day arithmetic itself lives in SQL, so what is asserted here is the
 * ORACLE — `1 + count(strictly exceeded)` — restated independently of the
 * product and checked at every boundary the decision names. The live proof
 * that PostgreSQL agrees is the P4-S4 aging integration suite, which needs a
 * database and therefore CI.
 */
import { describe, expect, it } from 'vitest';
import { AppError, STANDARD_AGING_BUCKET_DAYS, agingBucketLabels, validateAgingBucketDays } from '@daftar/domain-core';
import { foldCustomerAging, type CustomerAgingShape, type CustomerAgingSqlRow } from '../../apps/api/src/modules/selling/customer-reads';

const STANDARD = [...STANDARD_AGING_BUCKET_DAYS];
const LABELS = agingBucketLabels(STANDARD);
const SHAPE: CustomerAgingShape = { labels: LABELS, bucketDays: STANDARD };

const row = (bucketNo: number, baseMinor: string, invoices = 1): CustomerAgingSqlRow => ({
  bucket_no: bucketNo,
  currency_code: 'SAR',
  txn_minor: baseMinor,
  base_minor: baseMinor,
  invoice_count: invoices,
});

/**
 * The SQL's band arithmetic, restated. `null` is a missing due date, which the
 * function's `o.due_date IS NOT NULL AND ...` guard makes exceed no threshold.
 */
const bandOf = (daysPastDue: number | null, thresholds: readonly number[]): number =>
  1 + (daysPastDue === null ? 0 : thresholds.filter((t) => daysPastDue > t).length);

/** Whole civil days between two `YYYY-MM-DD` dates, as PostgreSQL's `date - date` counts them: no clock, no zone. */
const civilDaysPastDue = (asOf: string, dueDate: string): number => {
  const utc = (d: string): number => {
    const [y, m, day] = d.split('-').map((p) => Number.parseInt(p, 10)) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return (utc(asOf) - utc(dueDate)) / 86_400_000;
};

describe('DR-10 the standard receivables aging', () => {
  it('the standard is the five bands the owner decided, in order', () => {
    expect(STANDARD).toEqual([0, 30, 60, 90]);
    expect(validateAgingBucketDays(STANDARD)).toEqual([]);
    expect([...LABELS]).toEqual(['not-due', '1-30', '31-60', '61-90', 'over-90']);
  });

  it('the not-due band declares NO lower bound, because it has none', () => {
    const { buckets } = foldCustomerAging([], SHAPE);
    expect(buckets.map((b) => b.label)).toEqual([...LABELS]);
    // `null`, not `0`: the band holds every invoice up to and including its due
    // date, which is -45 days past due as readily as 0.
    expect(buckets.map((b) => b.fromDays)).toEqual([null, 1, 31, 61, 91]);
    expect(buckets.map((b) => b.toDays)).toEqual([0, 30, 60, 90, null]);
  });

  it('every boundary the decision names falls on the side the decision names', () => {
    const cases: readonly (readonly [number | null, number, string])[] = [
      [-365, 1, 'a year from due — not due'],
      [-45, 1, 'forty-five days from due — not due, and the case the old standard mis-banded'],
      [-1, 1, 'the day before the due date — not due'],
      [0, 1, 'THE DUE DATE ITSELF — not yet late, so not due'],
      [1, 2, 'the first day late — the first overdue band opens here'],
      [30, 2, 'thirty days late — still 1-30'],
      [31, 3, 'thirty-one — 31-60 opens'],
      [60, 3, 'sixty — still 31-60'],
      [61, 4, 'sixty-one — 61-90 opens'],
      [90, 4, 'ninety — still 61-90'],
      [91, 5, 'ninety-one — the open band opens'],
      [3650, 5, 'ten years late — the open band has no upper bound'],
      [null, 1, 'NO DUE DATE: nothing is late by a date nobody set, so not due'],
    ];
    for (const [daysPastDue, expectedBand, why] of cases) {
      expect(bandOf(daysPastDue, STANDARD), why).toBe(expectedBand);
    }
  });

  it('money that is not yet due stays OUT of every overdue band', () => {
    const rows = [row(1, '500000'), row(2, '10000'), row(3, '2000'), row(4, '300'), row(5, '40')];
    const { buckets, totalBaseMinor } = foldCustomerAging(rows, SHAPE);

    expect(buckets[0]?.label).toBe('not-due');
    expect(buckets[0]?.baseMinor).toBe('500000');
    // The overdue bands carry the overdue money and nothing else.
    expect(buckets.slice(1).map((b) => b.baseMinor)).toEqual(['10000', '2000', '300', '40']);

    const overdue = buckets.slice(1).reduce((s, b) => s + BigInt(b.baseMinor), 0n);
    expect(overdue.toString()).toBe('12340');
    // And the total is the TOTAL RECEIVABLE — not-due included. It is not a
    // figure to label "overdue"; DR-10 names it إجمالي الذمم.
    expect(totalBaseMinor).toBe('512340');
    expect((BigInt(totalBaseMinor) - overdue).toString()).toBe(buckets[0]?.baseMinor);
  });

  it('a customer who owes nothing LATE still reports a receivable', () => {
    const { buckets, totalBaseMinor } = foldCustomerAging([row(1, '75000', 3)], SHAPE);
    expect(totalBaseMinor).toBe('75000');
    expect(buckets[0]?.invoiceCount).toBe(3);
    expect(buckets.slice(1).map((b) => b.baseMinor)).toEqual(['0', '0', '0', '0']);
    expect(buckets.slice(1).map((b) => b.invoiceCount)).toEqual([0, 0, 0, 0]);
  });

  it('the day count is a CIVIL-DATE difference: no zone, no clock, no DST', () => {
    // A due date and an as-of date that straddle a DST transition. Parsed as
    // local wall time these pairs answer 29.958… or 30.041… days, and a floor
    // would move the invoice a whole band; as civil dates they are exactly
    // thirty, which is what `date - date` returns.
    expect(civilDaysPastDue('2026-04-26', '2026-03-27')).toBe(30);
    expect(civilDaysPastDue('2026-11-01', '2026-10-02')).toBe(30);
    expect(bandOf(civilDaysPastDue('2026-04-26', '2026-03-27'), STANDARD)).toBe(2);
    // The due date itself, across a leap day and across a year end.
    expect(civilDaysPastDue('2028-02-29', '2028-02-29')).toBe(0);
    expect(bandOf(civilDaysPastDue('2028-02-29', '2028-02-29'), STANDARD)).toBe(1);
    expect(civilDaysPastDue('2027-01-01', '2026-12-31')).toBe(1);
    expect(bandOf(civilDaysPastDue('2027-01-01', '2026-12-31'), STANDARD)).toBe(2);
    // The last day of a month, which is where a "+1 month" reading would drift.
    expect(civilDaysPastDue('2026-03-31', '2026-01-31')).toBe(59);
    expect(bandOf(civilDaysPastDue('2026-03-31', '2026-01-31'), STANDARD)).toBe(3);
  });

  it('the arithmetic is in MINOR UNITS and exact: no rounding, no float', () => {
    // One minor unit either side of a band boundary stays one minor unit, and a
    // receivable past 2^53 stays itself. A `number` would have lost both.
    const big = '9007199254740993';
    const { buckets, totalBaseMinor } = foldCustomerAging([row(1, big), row(2, '1'), row(5, '-1')], SHAPE);
    expect(buckets[0]?.baseMinor).toBe(big);
    expect(buckets[1]?.baseMinor).toBe('1');
    // A credit sitting in the oldest band is a negative, carried as one.
    expect(buckets[4]?.baseMinor).toBe('-1');
    expect(totalBaseMinor).toBe(big);
    // The same sum in floating point cannot even represent the operand.
    expect(Number(big).toString()).not.toBe(big);
  });

  it('the bands still sum to the total under the standard set', () => {
    const rows = [row(1, '1'), row(1, '2'), row(2, '4'), row(3, '8'), row(4, '16'), row(5, '32')];
    const { buckets, totalBaseMinor } = foldCustomerAging(rows, SHAPE);
    const summed = buckets.reduce((s, b) => s + BigInt(b.baseMinor), 0n);
    expect(summed.toString()).toBe(totalBaseMinor);
    expect(totalBaseMinor).toBe('63');
  });

  it('the C-1 repair holds under the standard set: the OLDEST band is band FIVE and keeps its money', () => {
    const { buckets, totalBaseMinor } = foldCustomerAging([row(STANDARD.length + 1, '909090')], SHAPE);
    expect(buckets[STANDARD.length]?.label).toBe('over-90');
    expect(buckets[STANDARD.length]?.baseMinor).toBe('909090');
    expect(totalBaseMinor).toBe('909090');
  });

  it('a zero boundary is legal ONLY as the first, and the validator still refuses the rest', () => {
    expect(validateAgingBucketDays([0])).toEqual([]);
    expect(validateAgingBucketDays([0, 30])).toEqual([]);
    // Strictly ascending already makes a second zero, or a zero after a
    // boundary, unreachable — so the not-due band cannot be asked for twice.
    expect(validateAgingBucketDays([0, 0])).toEqual(['bucket_days_not_ascending']);
    expect(validateAgingBucketDays([30, 0])).toEqual(['bucket_days_not_ascending']);
    expect(validateAgingBucketDays([-1])).toEqual(['bucket_days_out_of_range']);
    expect(validateAgingBucketDays([0, 3651])).toEqual(['bucket_days_out_of_range']);
  });

  it('red: a planted ordinal past the standard’s FIVE bands is refused, not folded into the last one', () => {
    // The plant, and the reason the fifth band is where it bites: the standard
    // set has one more band than the old one, so an ordinal that was the
    // oldest band under `[30, 60, 90]` (4) is now a legitimate middle band,
    // and the first unplaceable ordinal is 6. A fold that clamped instead of
    // refusing would put that money in `over-90` silently — the C-1 failure
    // mode, moved one place along.
    expect(() => foldCustomerAging([row(STANDARD.length + 2, '500')], SHAPE)).toThrow(AppError);
    try {
      foldCustomerAging([row(STANDARD.length + 2, '500')], SHAPE);
      expect.unreachable('the planted ordinal was folded instead of refused');
    } catch (error) {
      expect((error as AppError).details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');
    }
    // And the arm that makes the bound a bound: the LAST legitimate ordinal is
    // accepted and keeps its money.
    expect(foldCustomerAging([row(STANDARD.length + 1, '500')], SHAPE).totalBaseMinor).toBe('500');
  });

  it('red: the OLD boundaries cannot name the not-due band at all — the defect this decision removes', () => {
    const legacy = [30, 60, 90];
    const legacyLabels = agingBucketLabels(legacy);
    // No label in the old set says "not due", so there was nowhere for that
    // money to be reported as what it is.
    expect([...legacyLabels]).not.toContain('not-due');
    // And it was not merely unlabelled: the SQL bands a not-yet-due invoice as
    // ordinal 1 under either set, so under the old one it landed in the band
    // the client renders as "up to thirty days late".
    expect(bandOf(-45, legacy)).toBe(1);
    const old = foldCustomerAging([row(1, '500000')], { labels: legacyLabels, bucketDays: legacy });
    expect(old.buckets[0]?.label).toBe('0-30');
    expect(old.buckets[0]?.baseMinor).toBe('500000');
    // Under the standard set the same row is named correctly.
    expect(foldCustomerAging([row(1, '500000')], SHAPE).buckets[0]?.label).toBe('not-due');
  });

  it('a caller may still ask for the OLD boundaries, and then the first band is honest about mixing', () => {
    // DR-10 fixes the standard; it does not forbid a caller's own set. What it
    // does forbid is a band claiming a lower bound it has not got.
    const legacy = [30, 60, 90];
    const { buckets } = foldCustomerAging([], { labels: agingBucketLabels(legacy), bucketDays: legacy });
    expect(buckets.map((b) => b.fromDays)).toEqual([null, 31, 61, 91]);
    expect(buckets[0]?.toDays).toBe(30);
  });
});
