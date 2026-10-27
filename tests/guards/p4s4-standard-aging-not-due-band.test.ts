import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { CustomerAgingQuerySchema } from '../../apps/api/src/modules/selling/selling.schemas';
import { foldCustomerAging, type CustomerAgingShape, type CustomerAgingSqlRow } from '../../apps/api/src/modules/selling/customer-reads';

const ROOT = join(__dirname, '..', '..');
const STANDARD = [...STANDARD_AGING_BUCKET_DAYS];
const LABELS = agingBucketLabels(STANDARD);
const SHAPE: CustomerAgingShape = { labels: LABELS, bucketDays: STANDARD };

/**
 * `open_debit_count` and `open_credit_count` are the PER-CURRENCY document
 * counters DR-39 put in place of DR-29's single `open_invoice_count`: open
 * documents whose balance is `> 0` and whose balance is `< 0`, with a zero
 * balance counted in NEITHER, and never added together (DR-39 rule 5).
 *
 * The values below are deliberately NEITHER the sum of the per-band counts NOR
 * any one of them: since P4-S7 an invoice is aged across its instalment
 * schedule, so it reaches several bands and the sum counts it once per band.
 * Every row OF ONE CURRENCY carries the SAME pair, because `foldCustomerAging`
 * refuses a row set that disagrees with itself about a figure the document is
 * supposed to state once per currency — and this fixture is single-currency,
 * so every row it builds carries the one pair.
 */
const row = (bucketNo: number, baseMinor: string, invoices = 1): CustomerAgingSqlRow => ({
  bucket_no: bucketNo,
  currency_code: 'SAR',
  txn_minor: baseMinor,
  base_minor: baseMinor,
  invoice_count: invoices, open_debit_count: 3, open_credit_count: 1,
});

/**
 * The SQL's band arithmetic, restated. Since DR-13 there is no `null` arm: the
 * function measures against `coalesce(due_date, issue_date)`, which is never
 * null because `invoices.issue_date` is `NOT NULL`.
 */
const bandOf = (daysPastDue: number, thresholds: readonly number[]): number => 1 + thresholds.filter((t) => daysPastDue > t).length;

/**
 * DR-13's effective due date: the stated one, or the invoice's own issue date
 * when none was stated. `invoices_due_date_ck` guarantees
 * `due_date >= issue_date`, so this can only ever make an invoice MORE overdue
 * than a missing date did, never less — which is the point of the decision.
 */
const effectiveDueDate = (dueDate: string | null, issueDate: string): string => dueDate ?? issueDate;

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
    const cases: readonly (readonly [number, number, string])[] = [
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

/**
 * DR-13 — AN INVOICE WITH NO DUE DATE IS DUE FROM ITS OWN ISSUE DATE.
 *
 * The owner's decision of 2026-10-26 closes the question DR-10 left open. The
 * old behaviour was not designed: `customer_ar_aging` guarded its band
 * arithmetic with `o.due_date IS NOT NULL AND …`, so an invoice with no stated
 * due date exceeded no threshold and landed in band 1 — the not-due band since
 * DR-10, and the `0-30` band before it. Either way a receivable with no stated
 * term could sit forever in the youngest band and never age, which is a way
 * for debt to disappear from a report by omission rather than by payment.
 *
 * The decision: `coalesce(due_date, issue_date)`. `invoices.issue_date` is
 * `NOT NULL` and `invoices_due_date_ck` enforces `due_date >= issue_date`, so
 * the substitute is always present and can only ever make an invoice MORE
 * overdue than the missing date did, never less.
 *
 * WHERE THE CHANGE LIVES. `invoice_outstanding` already scans `invoices` and
 * already returns `due_date`, so `issue_date` is added to its result — an
 * ADDITIVE column that changes no existing one's meaning — and
 * `customer_ar_aging` coalesces the two. The alternative, joining `invoices`
 * back inside the aging reader, is refused: `0084` removed exactly that join
 * so the routine visits `invoices` once (R-104), and DR-13 is not a reason to
 * put it back. The `due_date` column itself is left alone, because the
 * open-invoice page returns it to the client and "no due date" must keep
 * reading as no due date there.
 *
 * Migration `0084` is edited in place rather than superseded: `frozenThrough`
 * is `0079`, and DR-03 keeps `0080`–`0086` candidates until the Phase 4 gate
 * is sealed. The static case below reads the migration text, because the
 * behavioural proof is PostgreSQL's and belongs to the live suite.
 */
describe('DR-13 an invoice with no due date ages from its issue date', () => {
  const MIGRATION = 'infrastructure/database/migrations/0084_phase4_ar_fixed_cost_and_open_invoice_page.sql';
  const sql = (): string => readFileSync(join(ROOT, MIGRATION), 'utf8');

  it('the aging reader measures against coalesce(due_date, issue_date)', () => {
    const body = sql();
    expect(body).toMatch(/coalesce\(\s*o\.due_date\s*,\s*o\.issue_date\s*\)/i);
  });

  it('red: the retired NULL guard is gone — a missing due date no longer exceeds nothing by construction', () => {
    // The exact expression that made a termless receivable immortal. Its
    // presence anywhere in the aging reader is the defect.
    expect(sql()).not.toMatch(/o\.due_date\s+IS\s+NOT\s+NULL\s+AND\s+\(p_as_of/i);
  });

  it('invoice_outstanding carries issue_date, so the reader visits invoices once (R-104)', () => {
    const body = sql();
    expect(body).toMatch(/RETURNS TABLE \(invoice_id UUID[\s\S]*?issue_date DATE\)/);
    // And the aging reader did NOT get its join back.
    const aging = body.slice(body.indexOf('CREATE FUNCTION customer_ar_aging'));
    const fn = aging.slice(0, aging.indexOf('$fn$;'));
    expect(fn).not.toMatch(/JOIN\s+public\.invoices/i);
  });

  it('the effective due date is the stated one, and the issue date only when none was stated', () => {
    expect(effectiveDueDate('2026-03-31', '2026-01-31')).toBe('2026-03-31');
    expect(effectiveDueDate(null, '2026-01-31')).toBe('2026-01-31');
    // A termless invoice issued sixty-one days ago is in 61-90, not in not-due.
    const days = civilDaysPastDue('2026-04-02', effectiveDueDate(null, '2026-01-31'));
    expect(days).toBe(61);
    expect(bandOf(days, STANDARD)).toBe(4);
    // And one issued today is not yet late, because the term is zero days.
    expect(bandOf(civilDaysPastDue('2026-01-31', effectiveDueDate(null, '2026-01-31')), STANDARD)).toBe(1);
  });
});

/**
 * DR-14 — THE FIRST RELEASE ACCEPTS THE STANDARD SET AND NOTHING ELSE.
 *
 * DR-10 settled what the bands are; this settles who may choose them. The
 * answer for release one is nobody: the server takes `bucketDays` and refuses
 * any value but `0,30,60,90` with `VALIDATION_FAILED`.
 *
 * This does NOT re-open the lock's "the server decides no bucket policy". The
 * boundaries are still a required input the client states and the answer still
 * echoes them, so the reader invents nothing; what the owner has fixed is the
 * SET OF ACCEPTABLE VALUES, which is a product decision and recorded as one.
 * `validateAgingBucketDays` keeps admitting every shape it admitted, because
 * it is the domain's own rule about well-formed boundaries and not the
 * product's about which are offered — widening the release later is then a
 * change to one schema and not to the domain.
 */
describe('DR-14 the aging endpoint takes the standard set only', () => {
  const parse = (v: string) => CustomerAgingQuerySchema.safeParse({ asOf: '2026-10-26', bucketDays: v });

  it('the standard set is accepted, and comes through as the five-band shape', () => {
    const ok = parse('0,30,60,90');
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.bucketDays).toEqual([...STANDARD_AGING_BUCKET_DAYS]);
  });

  it('red: every other well-formed set is REFUSED, including the one the product used before', () => {
    for (const bad of ['30,60,90', '0,30,60', '0,30,60,90,120', '0,15,30,60', '7', '0']) {
      const r = parse(bad);
      expect(r.success, `bucketDays=${bad} must be refused`).toBe(false);
    }
    // The refusal names the field, which is what DR-11 makes contractual.
    const r = parse('30,60,90');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain('bucketDays');
  });

  it('the DOMAIN rule is untouched: those sets are still well-formed, they are just not offered', () => {
    // The distinction matters. If DR-14 had been written into
    // `validateAgingBucketDays`, widening the release later would mean
    // changing a domain law, and every test that states what a well-formed
    // boundary set is would have to move with it.
    expect(validateAgingBucketDays([30, 60, 90])).toEqual([]);
    expect(validateAgingBucketDays([0, 15, 30, 60])).toEqual([]);
  });
});

/**
 * C-1 Q-1 — THE CONTRACT THE DEFECT WENT THROUGH.
 *
 * The independent review package asks: is the ordinal base PINNED or merely
 * ASSUMED? The C-1 repair maps `bucket_no - 1` and refuses anything out of
 * range, but nothing stated that `customer_ar_aging` must keep producing
 * 1-based ordinals — so a later migration could renumber from 0, every test
 * would stay green, and the money would move one band without a word.
 *
 * DR-10 made that worse rather than better: five bands instead of four, so a
 * wrong base loses a larger slice.
 *
 * This block is that missing contract, in three statements a renumbering
 * cannot satisfy: the SMALLEST ordinal the reader accepts is 1 and 0 is
 * refused; the standard answer has exactly 5 bands; and the bands sum to
 * `totalBaseMinor` EXACTLY, with no rounding and no remainder.
 */
describe('C-1 Q-1 the aging contract: 1-based, five bands, exact sum', () => {
  it('the ordinal base is ONE: zero is refused, and refused as a defect rather than skipped', () => {
    expect(() => foldCustomerAging([row(0, '100')], SHAPE)).toThrow(AppError);
    try {
      foldCustomerAging([row(0, '100')], SHAPE);
      expect.unreachable('bucket_no 0 was accepted');
    } catch (error) {
      expect((error as AppError).details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');
      expect((error as AppError).httpStatus).toBe(500);
    }
    // And one is accepted, so the refusal is about the base and not about the row.
    expect(foldCustomerAging([row(1, '100')], SHAPE).totalBaseMinor).toBe('100');
  });

  it('the SQL function itself numbers from one, read off the migration', () => {
    const body = readFileSync(join(ROOT, 'infrastructure/database/migrations/0084_phase4_ar_fixed_cost_and_open_invoice_page.sql'), 'utf8');
    const aging = body.slice(body.indexOf('CREATE FUNCTION customer_ar_aging'));
    // `1 + <count>`: the literal that makes the base one. A renumbering to
    // zero-based would have to delete it, and this case would name the loss.
    expect(aging.slice(0, aging.indexOf('$fn$;'))).toMatch(/SELECT\s+\(1\s*\+\s*\(SELECT pg_catalog\.count\(\*\)/);
  });

  it('the standard answer has exactly FIVE bands, in order, open last', () => {
    const { buckets } = foldCustomerAging([], SHAPE);
    expect(buckets.length).toBe(5);
    expect(buckets.map((b) => b.label)).toEqual(['not-due', '1-30', '31-60', '61-90', 'over-90']);
    expect(buckets.filter((b) => b.toDays === null).length).toBe(1);
    expect(buckets[4]?.toDays).toBeNull();
  });

  it('the bands sum to totalBaseMinor EXACTLY, over every ordinal and a mixed sign', () => {
    const rows = [row(1, '1000'), row(2, '-250'), row(3, '7'), row(4, '0'), row(5, '9007199254740993')];
    const { buckets, totalBaseMinor } = foldCustomerAging(rows, SHAPE);
    const summed = buckets.reduce((s, b) => s + BigInt(b.baseMinor), 0n);
    expect(summed.toString()).toBe(totalBaseMinor);
    // Stated absolutely, not just as an identity between two sums of mine.
    expect(totalBaseMinor).toBe('9007199254741750');
    // No band was skipped on the way: each ordinal reached its own band.
    expect(buckets.map((b) => b.baseMinor)).toEqual(['1000', '-250', '7', '0', '9007199254740993']);
  });

  it('red: a count that disagrees with the labels is refused, so the five is a FIVE and not a length', () => {
    const four = { labels: agingBucketLabels([30, 60, 90]), bucketDays: [...STANDARD] };
    expect(() => foldCustomerAging([], four)).toThrow(AppError);
  });
});
