/**
 * P4-S4 — THE CUSTOMER AR AGING BUCKET MAPPING, AND THE DEFECT IT REPLACES.
 *
 * `customer_ar_aging(...)` (`0084`, §6) returns
 *
 *     bucket_no = 1 + <count of supplied thresholds the days-past-due exceeds>
 *
 * so `bucket_no` is a **1-BASED** ordinal in `[1, bucketDays.length + 1]`.
 * `agingBucketLabels(bucketDays)` is a **0-BASED** array of
 * `bucketDays.length + 1` labels. The mapping is therefore
 * `bucketIndex = bucket_no - 1`, and the read used to be written
 *
 *     const bucket = buckets[r.bucket_no];
 *     if (bucket === undefined) continue;
 *
 * which was a financial defect in two directions at once:
 *
 *   1. the OLDEST band arrived as `bucket_no = bucketDays.length + 1`, indexed
 *      one past the end of `labels`, and was SILENTLY SKIPPED — out of
 *      `baseMinor`, out of `invoiceCount`, and out of `totalBaseMinor`, which
 *      is the figure the screen shows as the customer's aged debt. A customer
 *      whose whole debt sat in that band had an aged debt that read as ZERO:
 *      reported as NOT EXISTING, which is worse than reported as current and
 *      is a different diagnosis;
 *   2. index 0 — the `0-30`, not-yet-due band — was UNREACHABLE, because the
 *      SQL's smallest `bucket_no` is 1. No band ever held its own money: every
 *      band that did land carried the PREVIOUS band's.
 *
 * Both are asserted about the old fold, EXECUTED, in §B.
 *
 * ── WHAT THIS SUITE IS FOR ───────────────────────────────────────────────
 *
 * §A the twelve cases of the mapping, over `foldCustomerAging` — the PURE,
 *    exported fold the read now calls. No database, no Nest, no HTTP.
 * §B THE REGRESSION PROOF. It is not enough that the new code passes: the old
 *    defect must be shown to be DETECTED. `oldFoldUnderTest` below is the old
 *    implementation, written out for real and differing in exactly one
 *    expression — the index — and §B runs §A's assertions against it and
 *    asserts that they FAIL, with the actual numbers on both sides.
 *
 * ── TWO RULES THIS PROJECT LEARNED THE HARD WAY, BOTH APPLIED HERE ───────
 *
 * - **A negative assertion over an absent subject is green about nothing.**
 *   Before any "nothing was dropped" claim, this suite asserts that there WAS
 *   something to drop: the row set is non-empty, the oldest band is present in
 *   the input, its money is non-zero, and the wrong implementation really did
 *   produce a different number. Those are `§0`, and they run first.
 * - **An oracle that calls the implementation under test states
 *   `f(x) === f(x)`.** Every expected total here is summed FROM THE INPUT ROWS
 *   by `sumBase` / `sumCount` — local reducers over the fixture — and never by
 *   calling `foldCustomerAging`.
 */
import { describe, expect, it } from 'vitest';
import { AppError, MAX_AGING_BUCKETS, agingBucketLabels, validateAgingBucketDays } from '@daftar/domain-core';
import { foldCustomerAging, type CustomerAgingShape, type CustomerAgingSqlRow } from '../../apps/api/src/modules/selling/customer-reads';

// ─────────────────────────────────────────────────────────────────────────────
// The fixture: the canonical four-band shape, and rows in every band.
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET_DAYS = [30, 60, 90] as const;
const LABELS = agingBucketLabels([...BUCKET_DAYS]);
const SHAPE: CustomerAgingShape = { labels: LABELS, bucketDays: [...BUCKET_DAYS] };

/** The oldest band's 1-based ordinal, as the SQL function produces it. */
const OLDEST_BUCKET_NO = BUCKET_DAYS.length + 1;

/**
 * Rows as `customer_ar_aging` returns them, in the read's own `ORDER BY
 * bucket_no, currency_code` order. Every band is populated, the oldest twice
 * and in two currencies, so the oldest band's disappearance is measurable and
 * the multi-currency arms are not vacuous.
 *
 * The base figures are deliberately NOT equal to the transaction figures for
 * the EUR rows: a base total that accidentally equalled a txn total would make
 * "multi-currency rows do not alter the base total" unfalsifiable.
 */
const ROWS: readonly CustomerAgingSqlRow[] = Object.freeze([
  { bucket_no: 1, currency_code: 'USD', txn_minor: '1000', base_minor: '1000', invoice_count: 2 },
  { bucket_no: 2, currency_code: 'USD', txn_minor: '2000', base_minor: '2000', invoice_count: 1 },
  { bucket_no: 3, currency_code: 'EUR', txn_minor: '3000', base_minor: '3300', invoice_count: 3 },
  { bucket_no: OLDEST_BUCKET_NO, currency_code: 'EUR', txn_minor: '5000', base_minor: '5500', invoice_count: 5 },
  { bucket_no: OLDEST_BUCKET_NO, currency_code: 'USD', txn_minor: '4000', base_minor: '4000', invoice_count: 4 },
]);

/** Σ `base_minor` over a row set — the ORACLE, summed from the input and never from the fold. */
function sumBase(rows: readonly CustomerAgingSqlRow[]): bigint {
  return rows.reduce((acc, r) => acc + BigInt(r.base_minor), 0n);
}

/** Σ `invoice_count` over a row set — likewise an independent reducer. */
function sumCount(rows: readonly CustomerAgingSqlRow[]): number {
  return rows.reduce((acc, r) => acc + r.invoice_count, 0);
}

/** Σ `baseMinor` over the DTO's buckets — the third expression of the one quantity. */
function sumBucketBase(buckets: readonly { baseMinor: string }[]): bigint {
  return buckets.reduce((acc, b) => acc + BigInt(b.baseMinor), 0n);
}

/** Σ `invoiceCount` over the DTO's buckets. */
function sumBucketCount(buckets: readonly { invoiceCount: number }[]): number {
  return buckets.reduce((acc, b) => acc + b.invoiceCount, 0);
}

/** The rows the SQL function would have put in one band. */
function rowsOf(bucketNo: number): readonly CustomerAgingSqlRow[] {
  return ROWS.filter((r) => r.bucket_no === bucketNo);
}

/**
 * §D's subjects: the fewest boundaries the schema admits, the canonical three,
 * and the most. `CustomerAgingQuerySchema` takes 1..`MAX_AGING_BUCKETS`, and a
 * suite that exercises only the middle one cannot see an off-by-one in the
 * BOUND rather than in the index.
 */
const SHAPES: readonly number[][] = [[30], [...BUCKET_DAYS], Array.from({ length: MAX_AGING_BUCKETS }, (_, i) => (i + 1) * 30)];

/** The shape for a set of boundaries, labels and all — one construction, used by every §D loop. */
function shapeOf(days: readonly number[]): CustomerAgingShape {
  return { labels: agingBucketLabels(days), bucketDays: days };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OLD IMPLEMENTATION, FOR REAL.
// ─────────────────────────────────────────────────────────────────────────────

/** The old fold's bucket — the DTO's fields it actually touched, and no more. */
interface OldBucket {
  label: string;
  baseMinor: string;
  invoiceCount: number;
  byCurrency: { currency: string; txnMinor: string }[];
}

/**
 * `aging()`'s fold as it stood at `54a851c`, lifted verbatim except for being
 * a function over its inputs. It differs from `foldCustomerAging` in exactly
 * two expressions, and both are the defect:
 *
 *   - `buckets[r.bucket_no]` instead of `buckets[r.bucket_no - 1]`;
 *   - `if (bucket === undefined) continue` instead of a refusal.
 *
 * It is here so that §B can RUN it and read its actual numbers, rather than
 * assert in a comment that it would have been wrong.
 *
 * DELIBERATELY NOT SHARED with the second copy in
 * `tests/integration/p4s4-customer-aging-oldest-band-live.test.ts`. Do not
 * "finish the job" by extracting a helper: a red proof whose subject lives in
 * a file neither suite owns can be weakened by editing that subject, and both
 * proofs then go green together and in silence. Two homes for a WRONG
 * implementation is correct; two homes for a truth is what the rule forbids.
 */
function oldFoldUnderTest(rows: readonly CustomerAgingSqlRow[], shape: CustomerAgingShape): { buckets: OldBucket[]; totalBaseMinor: string } {
  const buckets: OldBucket[] = shape.labels.map((label) => ({ label, baseMinor: '0', invoiceCount: 0, byCurrency: [] }));
  let totalBaseMinor = 0n;
  for (const r of rows) {
    const bucket = buckets[r.bucket_no]; // ← THE DEFECT: `bucket_no` is 1-based.
    if (bucket === undefined) continue; // ← AND THE SILENCE.
    bucket.baseMinor = (BigInt(bucket.baseMinor) + BigInt(r.base_minor)).toString();
    bucket.invoiceCount += r.invoice_count;
    totalBaseMinor += BigInt(r.base_minor);
    if (r.currency_code !== null && r.txn_minor !== null) bucket.byCurrency.push({ currency: r.currency_code, txnMinor: r.txn_minor });
  }
  return { buckets, totalBaseMinor: totalBaseMinor.toString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// §0 NON-VACUITY. Every later claim rests on these, so they are asserted
//    first and on their own, not folded into the cases they protect.
// ─────────────────────────────────────────────────────────────────────────────

describe('§0 the fixture has a subject', () => {
  it('the shape is the four-band one and the labels are 0-based with one more entry than there are boundaries', () => {
    expect(LABELS.length).toBe(BUCKET_DAYS.length + 1);
    expect([...LABELS]).toEqual(['0-30', '31-60', '61-90', 'over-90']);
    expect(OLDEST_BUCKET_NO).toBe(4);
  });

  it('the row set is NON-EMPTY, every band is populated, and the oldest band is present with non-zero money', () => {
    // Without this, "the oldest band does not disappear" is a negative
    // assertion over an absent subject, and green about nothing.
    expect(ROWS.length).toBeGreaterThan(0);
    for (let bucketNo = 1; bucketNo <= LABELS.length; bucketNo += 1) {
      expect(rowsOf(bucketNo).length, `band ${bucketNo} is unpopulated`).toBeGreaterThan(0);
    }
    expect(rowsOf(OLDEST_BUCKET_NO).length).toBe(2);
    expect(sumBase(rowsOf(OLDEST_BUCKET_NO))).toBeGreaterThan(0n);
    expect(sumCount(rowsOf(OLDEST_BUCKET_NO))).toBeGreaterThan(0);
  });

  it('the fixture really is multi-currency, and its base figures are not a copy of its txn figures', () => {
    expect(new Set(ROWS.map((r) => r.currency_code)).size).toBeGreaterThan(1);
    expect(ROWS.some((r) => r.txn_minor !== r.base_minor)).toBe(true);
  });

  it('the oracles are independent reducers: they agree with hand arithmetic over the fixture', () => {
    // Pinned by hand so a bug in `sumBase` cannot travel into every expectation.
    expect(sumBase(ROWS)).toBe(1000n + 2000n + 3300n + 5500n + 4000n);
    expect(sumCount(ROWS)).toBe(2 + 1 + 3 + 5 + 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §A THE TWELVE CASES.
// ─────────────────────────────────────────────────────────────────────────────

describe('§A foldCustomerAging: the 1-based → 0-based mapping', () => {
  // 1
  it('CASE 1 — `bucket_no = 1` maps to the FIRST DTO bucket', () => {
    const only = rowsOf(1);
    expect(only.length).toBeGreaterThan(0); // non-vacuity: there is a row to place
    const { buckets } = foldCustomerAging(only, SHAPE);
    expect(buckets[0]?.label).toBe('0-30');
    expect(buckets[0]?.baseMinor).toBe(sumBase(only).toString());
    expect(buckets[0]?.invoiceCount).toBe(sumCount(only));
    // And nowhere else: the other three bands are untouched zeroes.
    expect(buckets.slice(1).map((b) => b.baseMinor)).toEqual(['0', '0', '0']);
  });

  // 2
  it('CASE 2 — the SECOND SQL bucket maps to the SECOND DTO bucket', () => {
    const only = rowsOf(2);
    expect(only.length).toBeGreaterThan(0);
    const { buckets } = foldCustomerAging(only, SHAPE);
    expect(buckets[1]?.label).toBe('31-60');
    expect(buckets[1]?.baseMinor).toBe(sumBase(only).toString());
    expect(buckets[1]?.invoiceCount).toBe(sumCount(only));
    expect(buckets[0]?.baseMinor).toBe('0');
    expect(buckets[2]?.baseMinor).toBe('0');
    expect(buckets[3]?.baseMinor).toBe('0');
  });

  // 3
  it('CASE 3 — the FINAL SQL bucket maps to the FINAL DTO bucket', () => {
    const only = rowsOf(OLDEST_BUCKET_NO);
    expect(only.length).toBeGreaterThan(0);
    const { buckets } = foldCustomerAging(only, SHAPE);
    const last = buckets[buckets.length - 1];
    expect(buckets.length).toBe(LABELS.length);
    expect(last?.label).toBe('over-90');
    expect(last?.toDays).toBeNull();
    expect(last?.fromDays).toBe(91);
    expect(last?.baseMinor).toBe(sumBase(only).toString());
  });

  // 4
  it('CASE 4 — the FINAL/OLDEST bucket DOES NOT DISAPPEAR when the whole row set is folded', () => {
    const oldest = rowsOf(OLDEST_BUCKET_NO);
    expect(sumBase(oldest)).toBeGreaterThan(0n); // non-vacuity: it has money to lose
    const { buckets, totalBaseMinor } = foldCustomerAging(ROWS, SHAPE);
    const last = buckets[buckets.length - 1];
    expect(last?.label).toBe('over-90');
    expect(last?.baseMinor).toBe(sumBase(oldest).toString());
    expect(last?.invoiceCount).toBe(sumCount(oldest));
    expect(last?.byCurrency.length).toBe(oldest.length);
    // And the total is NOT short by the oldest band.
    expect(BigInt(totalBaseMinor) - sumBase(oldest)).toBe(sumBase(ROWS.filter((r) => r.bucket_no !== OLDEST_BUCKET_NO)));
  });

  // 5
  it('CASE 5 — `totalBaseMinor` equals the sum of ALL SQL `base_minor` values, and the conservation law holds three ways', () => {
    const { buckets, totalBaseMinor } = foldCustomerAging(ROWS, SHAPE);
    const fromRows = sumBase(ROWS);
    expect(fromRows).toBeGreaterThan(0n); // non-vacuity: 0n === 0n would prove nothing
    // Three expressions of ONE quantity, all three asserted.
    expect(BigInt(totalBaseMinor)).toBe(fromRows);
    expect(sumBucketBase(buckets)).toBe(fromRows);
    expect(BigInt(totalBaseMinor)).toBe(sumBucketBase(buckets));
  });

  // 6
  it('CASE 6 — the total invoice count equals the sum across the mapped buckets, and across the input rows', () => {
    const { buckets } = foldCustomerAging(ROWS, SHAPE);
    const fromRows = sumCount(ROWS);
    expect(fromRows).toBeGreaterThan(0);
    expect(sumBucketCount(buckets)).toBe(fromRows);
    // Per band, too: a total can be right while two bands have swapped.
    for (let bucketNo = 1; bucketNo <= LABELS.length; bucketNo += 1) {
      expect(buckets[bucketNo - 1]?.invoiceCount, `band ${bucketNo}`).toBe(sumCount(rowsOf(bucketNo)));
    }
  });

  // 7
  it('CASE 7 — `byCurrency` stays in the CORRECT bucket', () => {
    const { buckets } = foldCustomerAging(ROWS, SHAPE);
    for (let bucketNo = 1; bucketNo <= LABELS.length; bucketNo += 1) {
      const expected = rowsOf(bucketNo).map((r) => ({ currency: r.currency_code, txnMinor: r.txn_minor }));
      expect(expected.length, `band ${bucketNo} has no currency rows`).toBeGreaterThan(0);
      expect(buckets[bucketNo - 1]?.byCurrency, `band ${bucketNo}`).toEqual(expected);
    }
    // The EUR amount that belongs to `61-90` is in `61-90` and in no other band.
    expect(buckets[2]?.byCurrency).toEqual([{ currency: 'EUR', txnMinor: '3000' }]);
    expect(buckets[3]?.byCurrency.map((c) => c.txnMinor)).toEqual(['5000', '4000']);
    expect(buckets[0]?.byCurrency.some((c) => c.txnMinor === '3000')).toBe(false);
  });

  // 8
  it('CASE 8 — multi-currency rows do not alter the BASE total', () => {
    // The same bands, the same base figures, but every row in one currency.
    const singleCurrency = ROWS.map((r) => ({ ...r, currency_code: 'USD', txn_minor: r.base_minor }));
    expect(ROWS.some((r) => r.currency_code !== 'USD')).toBe(true); // non-vacuity: the two sets really differ
    const multi = foldCustomerAging(ROWS, SHAPE);
    const single = foldCustomerAging(singleCurrency, SHAPE);
    expect(BigInt(multi.totalBaseMinor)).toBe(sumBase(ROWS));
    expect(BigInt(single.totalBaseMinor)).toBe(sumBase(ROWS));
    expect(multi.totalBaseMinor).toBe(single.totalBaseMinor);
    // The txn side DID change — otherwise the two inputs were the same input.
    expect(multi.buckets.map((b) => b.byCurrency)).not.toEqual(single.buckets.map((b) => b.byCurrency));
    // And per band the base figures are identical.
    expect(multi.buckets.map((b) => b.baseMinor)).toEqual(single.buckets.map((b) => b.baseMinor));
  });

  // 9
  it('CASE 9 — `bucket_no = 0` is REFUSED as an internal invariant failure, not skipped', () => {
    const impossible: CustomerAgingSqlRow[] = [{ bucket_no: 0, currency_code: 'USD', txn_minor: '700', base_minor: '700', invoice_count: 1 }];
    // Non-vacuity: the row carries money, so a silent skip would really lose it.
    expect(sumBase(impossible)).toBe(700n);
    let thrown: unknown;
    try {
      foldCustomerAging(impossible, SHAPE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.httpStatus).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');
    // A 500 is a DEFECT and never a merchant outcome (TL-P4-S2-R5): the
    // THROWN ERROR's `details` carries the typed code and nothing else — no
    // amount, no bucket number, no routine name, no SQL. This asserts the
    // `AppError` object, not the rendered HTTP body; what the filter puts on
    // the wire is `tests/integration/sale-s2-error-contract.test.ts`' subject.
    expect(Object.keys(error.details ?? {})).toEqual(['sellingCode']);
    expect(error.message).toBe('Internal error');
  });

  // 10
  it('CASE 10 — a `bucket_no` GREATER than the labels length is REFUSED', () => {
    const row: CustomerAgingSqlRow = { bucket_no: LABELS.length + 1, currency_code: 'USD', txn_minor: '900', base_minor: '900', invoice_count: 1 };
    expect(row.bucket_no).toBe(5); // non-vacuity: it really is past the end
    expect(sumBase([row])).toBe(900n); // and it really carries money
    let thrown: unknown;
    try {
      foldCustomerAging([row], SHAPE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).httpStatus).toBe(500);
    expect((thrown as AppError).details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');
    // `labels.length` ITSELF is legal — the boundary is INCLUSIVE, and an
    // off-by-one in the GUARD would be the same class of defect as the one
    // being fixed. This is the arm that makes the bound a bound and not a
    // second truncation.
    const atTheBoundary = foldCustomerAging([{ ...row, bucket_no: LABELS.length }], SHAPE);
    expect(atTheBoundary.totalBaseMinor).toBe('900');
    expect(atTheBoundary.buckets[LABELS.length - 1]?.baseMinor).toBe('900');
  });

  // 11
  it('CASE 11 — an EMPTY aging result is still a VALID DTO: every band present, every figure zero', () => {
    const { buckets, totalBaseMinor } = foldCustomerAging([], SHAPE);
    expect(buckets.length).toBe(LABELS.length);
    expect(buckets.map((b) => b.label)).toEqual([...LABELS]);
    expect(buckets.map((b) => b.baseMinor)).toEqual(['0', '0', '0', '0']);
    expect(buckets.map((b) => b.invoiceCount)).toEqual([0, 0, 0, 0]);
    expect(buckets.map((b) => b.byCurrency)).toEqual([[], [], [], []]);
    // The first band's lower bound is `null` since DR-10: it has none, because
    // days-past-due is negative for an invoice not yet due.
    expect(buckets.map((b) => b.fromDays)).toEqual([null, 31, 61, 91]);
    expect(buckets.map((b) => b.toDays)).toEqual([30, 60, 90, null]);
    expect(totalBaseMinor).toBe('0');
    expect(sumBucketBase(buckets)).toBe(sumBase([]));
  });

  // 12
  it('CASE 12 — NOTHING IS DROPPED SILENTLY: no input row can be absent from the output without a refusal', () => {
    // (a) the whole fixture is conserved, per band and in total.
    expect(ROWS.length).toBeGreaterThan(0); // non-vacuity, restated where it is used
    const { buckets, totalBaseMinor } = foldCustomerAging(ROWS, SHAPE);
    expect(sumBucketBase(buckets)).toBe(sumBase(ROWS));
    expect(sumBucketCount(buckets)).toBe(sumCount(ROWS));
    expect(BigInt(totalBaseMinor)).toBe(sumBase(ROWS));
    for (let bucketNo = 1; bucketNo <= LABELS.length; bucketNo += 1) {
      expect(buckets[bucketNo - 1]?.baseMinor, `band ${bucketNo}`).toBe(sumBase(rowsOf(bucketNo)).toString());
    }

    // (b) EVERY legal ordinal places its row, one band and no other. A sweep,
    //     so a future shape change cannot quietly reopen the end of the range.
    for (let bucketNo = 1; bucketNo <= LABELS.length; bucketNo += 1) {
      const one: CustomerAgingSqlRow[] = [{ bucket_no: bucketNo, currency_code: 'USD', txn_minor: '11', base_minor: '11', invoice_count: 1 }];
      const folded = foldCustomerAging(one, SHAPE);
      expect(BigInt(folded.totalBaseMinor), `band ${bucketNo} lost its row`).toBe(11n);
      const landedIndexes = folded.buckets.flatMap((b, i) => (b.baseMinor === '0' ? [] : [i]));
      expect(landedIndexes, `band ${bucketNo} landed in ${landedIndexes.length} buckets`).toEqual([bucketNo - 1]);
      expect(folded.buckets[bucketNo - 1]?.invoiceCount).toBe(1);
    }

    // (c) EVERY illegal ordinal REFUSES. The alternative — a value that
    //     neither lands nor refuses — is the defect, and this is the assertion
    //     that forbids it by construction rather than by inspection.
    const impossibleOrdinals = [-1, 0, 0.5, 1.5, LABELS.length + 1, LABELS.length + 2, Number.NaN, Number.POSITIVE_INFINITY];
    expect(impossibleOrdinals.length).toBeGreaterThan(0);
    for (const bucketNo of impossibleOrdinals) {
      const one: CustomerAgingSqlRow[] = [{ bucket_no: bucketNo, currency_code: 'USD', txn_minor: '13', base_minor: '13', invoice_count: 1 }];
      let refused = false;
      let total: string | null = null;
      try {
        total = foldCustomerAging(one, SHAPE).totalBaseMinor;
      } catch (error) {
        refused = true;
        expect((error as AppError).httpStatus, `bucket_no ${String(bucketNo)}`).toBe(500);
      }
      // Either it refused, or it placed the money. Never "returned a DTO that
      // is short by 13".
      expect(refused || total === '13', `bucket_no ${String(bucketNo)} was dropped silently (total ${String(total)})`).toBe(true);
      expect(refused, `bucket_no ${String(bucketNo)} should be refused`).toBe(true);
    }
  });

  // 13 — CHAL-4. `foldCustomerAging` is EXPORTED, so the shape is an input and
  // not an internal fact, and a malformed one used to reach the DTO.
  it('CASE 13 — a `labels` length that is not `bucketDays.length + 1` is REFUSED, and no DTO carries `fromDays: NaN`', () => {
    const row: CustomerAgingSqlRow = { bucket_no: 1, currency_code: 'USD', txn_minor: '55', base_minor: '55', invoice_count: 1 };

    // ONE TOO LONG. This is the NaN path: band index 4 read `bucketDays[3]`,
    // which is `undefined`, and `undefined + 1` is `NaN` — a money DTO with a
    // band whose lower bound is missing. Non-vacuity: the shape really is
    // longer than the boundaries admit.
    const tooLong: CustomerAgingShape = { labels: [...LABELS, 'over-120'], bucketDays: [...BUCKET_DAYS] };
    expect(tooLong.labels.length).toBe(tooLong.bucketDays.length + 2);
    expect(() => foldCustomerAging([row], tooLong)).toThrow(AppError);
    try {
      foldCustomerAging([row], tooLong);
    } catch (error) {
      expect((error as AppError).httpStatus).toBe(500);
      expect((error as AppError).details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');
    }

    // ONE TOO SHORT, the other direction: a band the boundaries describe and
    // the labels do not. Refused for the same reason and under the same code.
    const tooShort: CustomerAgingShape = { labels: LABELS.slice(0, -1), bucketDays: [...BUCKET_DAYS] };
    expect(tooShort.labels.length).toBe(tooShort.bucketDays.length);
    expect(() => foldCustomerAging([row], tooShort)).toThrow(AppError);

    // AND THE POSITIVE HALF: across every shape the schema admits, no band's
    // bounds are NaN and every one is a real finite number. A refusal that
    // fired on a WELL-FORMED shape would make this suite's own §D vacuous.
    for (const days of SHAPES) {
      const { buckets } = foldCustomerAging([], { labels: agingBucketLabels(days), bucketDays: days });
      expect(buckets.length, `${days.length} boundaries`).toBe(days.length + 1);
      for (const [i, b] of buckets.entries()) {
        // Since DR-10 the FIRST band's lower bound is `null` — the one band
        // that genuinely has none. That is an absent bound and not a broken
        // number, so the guard is split rather than relaxed: band 0 must be
        // exactly `null`, and every other band must still be a real finite
        // number. `NaN` remains refused everywhere, which is what this case is
        // here to catch.
        if (i === 0) {
          expect(b.fromDays, `${days.length} boundaries, band 0 fromDays`).toBeNull();
        } else {
          expect(Number.isFinite(b.fromDays), `${days.length} boundaries, band ${i} fromDays=${String(b.fromDays)}`).toBe(true);
        }
        expect(Number.isNaN(b.fromDays)).toBe(false);
        if (b.toDays !== null) expect(Number.isFinite(b.toDays)).toBe(true);
      }
      // The last band is the open one, and only the last.
      expect(buckets.filter((b) => b.toDays === null).length).toBe(1);
      expect(buckets[buckets.length - 1]?.toDays).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §D CHAL-5 — THE SAME LAWS OVER EVERY BUCKET SHAPE THE SCHEMA ADMITS.
//
// `CustomerAgingQuerySchema` takes 1..MAX_AGING_BUCKETS boundaries, and §A
// exercises exactly one of those shapes. An off-by-one in the BOUND rather
// than in the index would be invisible at three boundaries and bite at one or
// at six, so the inclusive-boundary arm and the land-or-refuse sweep are run
// over all three. A `for`, not a second file.
// ─────────────────────────────────────────────────────────────────────────────

describe('§D the mapping holds at 1, 3 and MAX_AGING_BUCKETS boundaries', () => {
  it('the shapes under test really are the extremes the schema admits', () => {
    // Non-vacuity for the whole section: if `SHAPES` collapsed to one entry,
    // every loop below would still pass and prove nothing new.
    expect(MAX_AGING_BUCKETS).toBe(6);
    expect(SHAPES.length).toBe(3);
    expect(SHAPES.map((s) => s.length)).toEqual([1, 3, MAX_AGING_BUCKETS]);
    for (const days of SHAPES) expect(validateAgingBucketDays(days), `${days.length} boundaries must be a lawful query`).toEqual([]);
  });

  it('the INCLUSIVE upper bound is exact at every shape: `labels.length` lands, `labels.length + 1` refuses', () => {
    for (const days of SHAPES) {
      const labels = agingBucketLabels(days);
      const shape: CustomerAgingShape = { labels, bucketDays: days };
      const where = `${days.length} boundaries`;
      expect(labels.length, where).toBe(days.length + 1);

      // The oldest legal ordinal lands, in the LAST band.
      const atBound = foldCustomerAging([{ bucket_no: labels.length, currency_code: 'USD', txn_minor: '77', base_minor: '77', invoice_count: 1 }], shape);
      expect(atBound.totalBaseMinor, where).toBe('77');
      expect(atBound.buckets[labels.length - 1]?.baseMinor, where).toBe('77');
      expect(atBound.buckets[labels.length - 1]?.toDays, where).toBeNull();

      // One past it refuses — and 0 does too, at every shape.
      for (const bad of [0, labels.length + 1]) {
        const one = [{ bucket_no: bad, currency_code: 'USD', txn_minor: '77', base_minor: '77', invoice_count: 1 }];
        expect(() => foldCustomerAging(one, shape), `${where}, bucket_no ${bad}`).toThrow(AppError);
      }
    }
  });

  it('LAND OR REFUSE, never vanish, at every shape: the full legal sweep and the illegal one', () => {
    for (const days of SHAPES) {
      const labels = agingBucketLabels(days);
      const shape: CustomerAgingShape = { labels, bucketDays: days };
      const where = `${days.length} boundaries`;

      // Every legal ordinal lands in exactly one band, at `bucket_no - 1`.
      for (let bucketNo = 1; bucketNo <= labels.length; bucketNo += 1) {
        const folded = foldCustomerAging([{ bucket_no: bucketNo, currency_code: 'USD', txn_minor: '9', base_minor: '9', invoice_count: 1 }], shape);
        expect(BigInt(folded.totalBaseMinor), `${where}, band ${bucketNo} lost its row`).toBe(9n);
        const landed = folded.buckets.flatMap((b, i) => (b.baseMinor === '0' ? [] : [i]));
        expect(landed, `${where}, band ${bucketNo}`).toEqual([bucketNo - 1]);
      }

      // Every illegal ordinal refuses. Derived from the shape, so the sweep
      // widens with it rather than staying about three boundaries.
      for (const bad of [-1, 0, 0.5, labels.length + 1, labels.length + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
        const one = [{ bucket_no: bad, currency_code: 'USD', txn_minor: '9', base_minor: '9', invoice_count: 1 }];
        let refused = false;
        try {
          foldCustomerAging(one, shape);
        } catch {
          refused = true;
        }
        expect(refused, `${where}, bucket_no ${String(bad)} neither landed nor refused`).toBe(true);
      }
    }
  });

  it('and the conservation law holds at every shape, with every band populated', () => {
    for (const days of SHAPES) {
      const labels = agingBucketLabels(days);
      const rows: CustomerAgingSqlRow[] = labels.map((_, i) => ({
        bucket_no: i + 1,
        currency_code: 'USD',
        txn_minor: String((i + 1) * 100),
        base_minor: String((i + 1) * 100),
        invoice_count: i + 1,
      }));
      const where = `${days.length} boundaries`;
      // Non-vacuity: a row per band, and real money in each.
      expect(rows.length, where).toBe(labels.length);
      const owed = rows.reduce((acc, r) => acc + BigInt(r.base_minor), 0n);
      expect(owed > 0n, where).toBe(true);

      const { buckets, totalBaseMinor } = foldCustomerAging(rows, shapeOf(days));
      expect(BigInt(totalBaseMinor), where).toBe(owed);
      expect(sumBucketBase(buckets), where).toBe(owed);
      expect(sumBucketCount(buckets), where).toBe(rows.reduce((acc, r) => acc + r.invoice_count, 0));
      // Per band, so a right total cannot hide a shift — which is the whole
      // defect, and it is exactly what a single-shape suite missed.
      for (const [i, b] of buckets.entries()) expect(b.baseMinor, `${where}, band ${i + 1}`).toBe(String((i + 1) * 100));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §B THE REGRESSION PROOF. The old implementation, EXECUTED, going RED.
// ─────────────────────────────────────────────────────────────────────────────

describe('§B the OLD `buckets[r.bucket_no]` implementation goes RED under these assertions', () => {
  /**
   * The rows the old indexing could still place: `buckets[bucket_no]` is in
   * range exactly when `bucket_no <= labels.length - 1`. Derived from the
   * fixture and the array length — NOT by running either implementation.
   */
  const OLD_MAPPABLE = ROWS.filter((r) => r.bucket_no <= LABELS.length - 1);
  const OLD_DROPPED = ROWS.filter((r) => r.bucket_no > LABELS.length - 1);

  it('RED 1 — the planted old implementation really differs from the fix: the gap, in minor units and in invoices', () => {
    const right = foldCustomerAging(ROWS, SHAPE);
    const wrong = oldFoldUnderTest(ROWS, SHAPE);

    // Non-vacuity FIRST: there was something to drop, and it was dropped.
    expect(OLD_DROPPED.length, 'the fixture must contain a row the old indexing could not place').toBeGreaterThan(0);
    expect(sumBase(OLD_DROPPED)).toBeGreaterThan(0n);

    // The RIGHT answer, against the input rows.
    expect(BigInt(right.totalBaseMinor)).toBe(sumBase(ROWS));
    expect(sumBucketCount(right.buckets)).toBe(sumCount(ROWS));

    // The WRONG answer, against an independently derived expectation.
    expect(BigInt(wrong.totalBaseMinor)).toBe(sumBase(OLD_MAPPABLE));
    expect(sumBucketCount(wrong.buckets)).toBe(sumCount(OLD_MAPPABLE));

    // THE GAP. Both sides printed, so the numbers are in the record.
    expect(BigInt(right.totalBaseMinor) - BigInt(wrong.totalBaseMinor)).toBe(sumBase(OLD_DROPPED));
    expect(sumBucketCount(right.buckets) - sumBucketCount(wrong.buckets)).toBe(sumCount(OLD_DROPPED));
    expect(wrong.totalBaseMinor).not.toBe(right.totalBaseMinor);
    expect(BigInt(wrong.totalBaseMinor) < BigInt(right.totalBaseMinor)).toBe(true);
  });

  it('RED 2 — CASE 4 fails against the planted old implementation: the oldest band vanishes', () => {
    const oldest = rowsOf(OLDEST_BUCKET_NO);
    expect(sumBase(oldest)).toBeGreaterThan(0n); // there was money in it
    const wrong = oldFoldUnderTest(ROWS, SHAPE);
    const last = wrong.buckets[wrong.buckets.length - 1];
    expect(last?.label).toBe('over-90');
    // The assertion CASE 4 makes — and here it is false.
    expect(last?.baseMinor).not.toBe(sumBase(oldest).toString());
    // Specifically: the band holds the `61-90` money instead, and the oldest
    // band's own money is nowhere at all.
    expect(last?.baseMinor).toBe(sumBase(rowsOf(LABELS.length - 1)).toString());
    expect(last?.invoiceCount).toBe(sumCount(rowsOf(LABELS.length - 1)));
    expect(sumBucketBase(wrong.buckets)).toBe(sumBase(OLD_MAPPABLE));
    expect(sumBucketBase(wrong.buckets)).not.toBe(sumBase(ROWS));
  });

  it('RED 3 — CASE 5 fails against the planted old implementation: `totalBaseMinor` comes out SHORT', () => {
    const wrong = oldFoldUnderTest(ROWS, SHAPE);
    const owed = sumBase(ROWS);
    expect(owed).toBeGreaterThan(0n);
    expect(BigInt(wrong.totalBaseMinor)).not.toBe(owed);
    expect(BigInt(wrong.totalBaseMinor)).toBeLessThan(owed);
    expect(owed - BigInt(wrong.totalBaseMinor)).toBe(sumBase(OLD_DROPPED));
  });

  it('RED 4 — CASE 1 fails against the planted old implementation: every surviving band is labelled ONE BAND TOO OLD', () => {
    const first = rowsOf(1);
    expect(first.length).toBeGreaterThan(0);
    const wrong = oldFoldUnderTest(first, SHAPE);
    // CASE 1's assertion: `bucket_no = 1` lands in the FIRST bucket.
    expect(wrong.buckets[0]?.baseMinor).not.toBe(sumBase(first).toString());
    expect(wrong.buckets[0]?.baseMinor).toBe('0');
    // It landed in the SECOND — one band too old, exactly as reported.
    expect(wrong.buckets[1]?.label).toBe('31-60');
    expect(wrong.buckets[1]?.baseMinor).toBe(sumBase(first).toString());
  });

  it('RED 5 — CASES 9, 10 and 12 fail against the planted old implementation: an impossible ordinal is swallowed in silence', () => {
    for (const bucketNo of [0, LABELS.length + 1]) {
      const one: CustomerAgingSqlRow[] = [{ bucket_no: bucketNo, currency_code: 'USD', txn_minor: '13', base_minor: '13', invoice_count: 1 }];
      expect(sumBase(one)).toBe(13n); // non-vacuity: there is money on the row
      // The new fold refuses…
      expect(() => foldCustomerAging(one, SHAPE)).toThrow(AppError);
      // …and the old one neither refuses nor places it: `bucket_no = 0` lands
      // in the FIRST band (wrong band, right total) and `labels.length + 1`
      // falls off the end (no band, short total). The second is the money
      // disappearance; both are failures of CASE 12.
      const wrong = oldFoldUnderTest(one, SHAPE);
      if (bucketNo === 0) {
        expect(wrong.buckets[0]?.baseMinor).toBe('13');
        expect(wrong.totalBaseMinor).toBe('13'); // placed, but in a band the SQL never named
      } else {
        expect(wrong.totalBaseMinor).toBe('0'); // ← money gone, exit status 0
        expect(sumBucketBase(wrong.buckets)).toBe(0n);
        expect(sumBucketBase(wrong.buckets)).not.toBe(sumBase(one));
      }
    }
  });

  it('RED 6 — the planted old implementation differs from the fix in the INDEX and not in the fixture', () => {
    // A proof that read the two implementations as black boxes could be
    // comparing two different arithmetics. Fed a row set in which the oldest
    // band is EMPTY and every ordinal is shifted down by one, the old fold
    // reproduces the new fold's per-band base figures exactly — so the only
    // difference between them is where the index starts.
    const shifted = ROWS.filter((r) => r.bucket_no < OLDEST_BUCKET_NO).map((r) => ({ ...r, bucket_no: r.bucket_no - 1 }));
    expect(shifted.length).toBeGreaterThan(0);
    expect(shifted.some((r) => r.bucket_no === 0)).toBe(true); // the shift really happened
    const wrongOnShifted = oldFoldUnderTest(shifted, SHAPE);
    const unshifted = ROWS.filter((r) => r.bucket_no < OLDEST_BUCKET_NO);
    const rightOnOriginal = foldCustomerAging(unshifted, SHAPE);
    expect(wrongOnShifted.buckets.map((b) => b.baseMinor)).toEqual(rightOnOriginal.buckets.map((b) => b.baseMinor));
    expect(wrongOnShifted.totalBaseMinor).toBe(rightOnOriginal.totalBaseMinor);
  });
});
