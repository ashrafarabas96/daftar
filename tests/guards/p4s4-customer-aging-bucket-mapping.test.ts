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
import {
  foldCustomerAging,
  type CustomerAgingBandRow,
  type CustomerAgingShape,
  type CustomerAgingSqlRow,
} from '../../apps/api/src/modules/selling/customer-reads';

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
/**
 * `open_debit_count` and `open_credit_count` are the PER-CURRENCY document
 * counters DR-39 put in place of DR-29's single `open_invoice_count`: open
 * documents whose balance is `> 0` and whose balance is `< 0` respectively,
 * with a zero balance counted in NEITHER, and they are **never added
 * together** (DR-39 rule 5).
 *
 * The values below are deliberately NEITHER the sum of the per-band counts NOR
 * any one of them: since P4-S7 an invoice is aged across its instalment
 * schedule, so it reaches several bands and the sum counts it once per band.
 * Every row OF ONE CURRENCY carries the SAME pair, because `foldCustomerAging`
 * refuses a row set that disagrees with itself about a figure the document is
 * supposed to state once per currency — and the two currencies carry
 * DIFFERENT pairs, so a fold that collapsed the counters across currencies
 * could not produce this fixture's answer.
 */
/*
 * TYPED `CustomerAgingBandRow`, the TOTAL row — rows as a CORRECT database
 * yields them. Every column of the wire row is nullable since DR-39, and that
 * is a fact about the read's `FULL JOIN`, not about a fixture: these rows are
 * written here, in full, by hand. Saying so in the type is what lets the
 * oracles below read `base_minor` and `invoice_count` as the money and the
 * count they are, instead of each deciding for itself what a null would have
 * meant. The JOIN's orphans have their own, nullable, type and their own
 * cases — §A's impossible ordinals and §E4's missing columns — where the
 * refusal is the subject rather than an obstacle.
 */
const ROWS: readonly CustomerAgingBandRow[] = Object.freeze([
  { bucket_no: 1, currency_code: 'USD', txn_minor: '1000', base_minor: '1000', invoice_count: 2, open_debit_count: 3, open_credit_count: 1 },
  { bucket_no: 2, currency_code: 'USD', txn_minor: '2000', base_minor: '2000', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 },
  { bucket_no: 3, currency_code: 'EUR', txn_minor: '3000', base_minor: '3300', invoice_count: 3, open_debit_count: 2, open_credit_count: 0 },
  { bucket_no: OLDEST_BUCKET_NO, currency_code: 'EUR', txn_minor: '5000', base_minor: '5500', invoice_count: 5, open_debit_count: 2, open_credit_count: 0 },
  { bucket_no: OLDEST_BUCKET_NO, currency_code: 'USD', txn_minor: '4000', base_minor: '4000', invoice_count: 4, open_debit_count: 3, open_credit_count: 1 },
]);

/** Σ `base_minor` over a row set — the ORACLE, summed from the input and never from the fold. */
function sumBase(rows: readonly CustomerAgingBandRow[]): bigint {
  return rows.reduce((acc, r) => acc + BigInt(r.base_minor), 0n);
}

/** Σ `invoice_count` over a row set — likewise an independent reducer. */
function sumCount(rows: readonly CustomerAgingBandRow[]): number {
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
function rowsOf(bucketNo: number): readonly CustomerAgingBandRow[] {
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
 *
 * IT TAKES THE TOTAL ROW, and that is the historically faithful signature: the
 * implementation this reproduces PREDATES DR-39, so the columns it reads were
 * not nullable when it was written and it never had a null branch. Its two
 * planted defects — the 1-based index and the silent `continue` — are
 * untouched by the type; the only thing the type removes is a question the
 * original was never asked.
 */
function oldFoldUnderTest(rows: readonly CustomerAgingBandRow[], shape: CustomerAgingShape): { buckets: OldBucket[]; totalBaseMinor: string } {
  const buckets: OldBucket[] = shape.labels.map((label) => ({ label, baseMinor: '0', invoiceCount: 0, byCurrency: [] }));
  let totalBaseMinor = 0n;
  for (const r of rows) {
    const bucket = buckets[r.bucket_no]; // ← THE DEFECT: `bucket_no` is 1-based.
    if (bucket === undefined) continue; // ← AND THE SILENCE.
    bucket.baseMinor = (BigInt(bucket.baseMinor) + BigInt(r.base_minor)).toString();
    bucket.invoiceCount += r.invoice_count;
    totalBaseMinor += BigInt(r.base_minor);
    bucket.byCurrency.push({ currency: r.currency_code, txnMinor: r.txn_minor });
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

  /**
   * THE TOTAL ROW TYPE, PINNED IN BOTH DIRECTIONS.
   *
   * `CustomerAgingBandRow` is DERIVED from `CustomerAgingSqlRow`
   * (`NonNullable` over its keys), and the fixtures above are typed with it so
   * the oracles can read money and counts without each one deciding, per
   * field, what a null would have meant. That makes the derivation
   * load-bearing: if it ever widened — a column added nullable and not
   * narrowed, a `NonNullable` lost, the whole thing collapsing to `any` — the
   * oracles would go on compiling while silently accepting the `FULL JOIN`'s
   * orphans, and §E4's refusals would be refusing something else.
   *
   * So it is asserted, and by the compiler, which is the only thing that can
   * assert it. The claims are:
   *
   *   NEGATIVE — a null in ANY of the seven columns is rejected. Each
   *   `@ts-expect-error` IS the assertion: should the line stop being an
   *   error, TypeScript reports the unused directive as `TS2578` and
   *   `npm run typecheck` fails. Seven directives, one per column, because a
   *   derivation that narrowed six would be a hole in the seventh.
   *
   *   POSITIVE — and this is what stops the seven from being vacuous: the
   *   UNMUTATED total row is accepted by the total type AND by the wire type.
   *   A `CustomerAgingBandRow` that had degenerated to something accepting
   *   nothing would fail the first; one that had degenerated to `any` would
   *   make all seven directives unused and fail on `TS2578`. Only a type that
   *   is exactly "the wire row with no nulls" passes both.
   *
   * It is a `describe`-level block with a runtime body so the suite also
   * states, at run time, that the fixture row really carries all seven
   * columns — a type-only claim about a fixture nobody runs is worth little.
   */
  it('the TOTAL row type rejects a null in every column and still accepts the row the fixture writes', () => {
    const total = ROWS[0];
    if (total === undefined) throw new Error('the fixture lost its first row, so this case has no subject');

    // Run time: all seven columns really are present on the fixture's row, so
    // "no nulls" is a statement about something.
    expect(Object.keys(total).sort()).toEqual([
      'base_minor',
      'bucket_no',
      'currency_code',
      'invoice_count',
      'open_credit_count',
      'open_debit_count',
      'txn_minor',
    ]);

    const asBand = (_row: CustomerAgingBandRow): void => undefined;
    const asWire = (_row: CustomerAgingSqlRow): void => undefined;

    // POSITIVE, first, so the negatives below cannot be vacuous.
    asBand(total);
    asWire(total);

    // NEGATIVE, one per column.
    // @ts-expect-error a total row's `bucket_no` may not be null
    asBand({ ...total, bucket_no: null });
    // @ts-expect-error a total row's `currency_code` may not be null
    asBand({ ...total, currency_code: null });
    // @ts-expect-error a total row's `txn_minor` may not be null
    asBand({ ...total, txn_minor: null });
    // @ts-expect-error a total row's `base_minor` may not be null
    asBand({ ...total, base_minor: null });
    // @ts-expect-error a total row's `invoice_count` may not be null
    asBand({ ...total, invoice_count: null });
    // @ts-expect-error a total row's `open_debit_count` may not be null
    asBand({ ...total, open_debit_count: null });
    // @ts-expect-error a total row's `open_credit_count` may not be null
    asBand({ ...total, open_credit_count: null });

    // And the wire row DOES take every one of those — it is the `FULL JOIN`'s
    // shape, and refusing them is `foldCustomerAging`'s job (§E4), not the
    // type's. Without this the seven above would only show that SOMETHING
    // rejects a null, not that the two types differ in exactly that way.
    asWire({ ...total, bucket_no: null });
    asWire({ ...total, currency_code: null });
    asWire({ ...total, txn_minor: null });
    asWire({ ...total, base_minor: null });
    asWire({ ...total, invoice_count: null });
    asWire({ ...total, open_debit_count: null });
    asWire({ ...total, open_credit_count: null });
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
    const singleCurrency = ROWS.map((r) => ({ ...r, currency_code: 'USD', txn_minor: r.base_minor, open_debit_count: 3, open_credit_count: 1 }));
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
    // TOTAL and still impossible: every column is present and the ordinal is
    // the defect, so the refusal cannot be mistaken for a refusal of a missing
    // column. `CustomerAgingBandRow` asserts COMPLETENESS, never validity.
    const impossible: CustomerAgingBandRow[] = [
      { bucket_no: 0, currency_code: 'USD', txn_minor: '700', base_minor: '700', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 },
    ];
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
    // Total, and the ordinal is still past the end — see CASE 9.
    const row: CustomerAgingBandRow = {
      bucket_no: LABELS.length + 1,
      currency_code: 'USD',
      txn_minor: '900',
      base_minor: '900',
      invoice_count: 1,
      open_debit_count: 3,
      open_credit_count: 1,
    };
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
      const one: CustomerAgingSqlRow[] = [
        { bucket_no: bucketNo, currency_code: 'USD', txn_minor: '11', base_minor: '11', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 },
      ];
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
      const one: CustomerAgingSqlRow[] = [
        { bucket_no: bucketNo, currency_code: 'USD', txn_minor: '13', base_minor: '13', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 },
      ];
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
    const row: CustomerAgingSqlRow = {
      bucket_no: 1,
      currency_code: 'USD',
      txn_minor: '55',
      base_minor: '55',
      invoice_count: 1,
      open_debit_count: 3,
      open_credit_count: 1,
    };

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
      const atBound = foldCustomerAging(
        [{ bucket_no: labels.length, currency_code: 'USD', txn_minor: '77', base_minor: '77', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 }],
        shape,
      );
      expect(atBound.totalBaseMinor, where).toBe('77');
      expect(atBound.buckets[labels.length - 1]?.baseMinor, where).toBe('77');
      expect(atBound.buckets[labels.length - 1]?.toDays, where).toBeNull();

      // One past it refuses — and 0 does too, at every shape.
      for (const bad of [0, labels.length + 1]) {
        const one = [{ bucket_no: bad, currency_code: 'USD', txn_minor: '77', base_minor: '77', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 }];
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
        const folded = foldCustomerAging(
          [{ bucket_no: bucketNo, currency_code: 'USD', txn_minor: '9', base_minor: '9', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 }],
          shape,
        );
        expect(BigInt(folded.totalBaseMinor), `${where}, band ${bucketNo} lost its row`).toBe(9n);
        const landed = folded.buckets.flatMap((b, i) => (b.baseMinor === '0' ? [] : [i]));
        expect(landed, `${where}, band ${bucketNo}`).toEqual([bucketNo - 1]);
      }

      // Every illegal ordinal refuses. Derived from the shape, so the sweep
      // widens with it rather than staying about three boundaries.
      for (const bad of [-1, 0, 0.5, labels.length + 1, labels.length + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
        const one = [{ bucket_no: bad, currency_code: 'USD', txn_minor: '9', base_minor: '9', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 }];
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
      const rows: CustomerAgingBandRow[] = labels.map((_, i) => ({
        bucket_no: i + 1,
        currency_code: 'USD',
        txn_minor: String((i + 1) * 100),
        base_minor: String((i + 1) * 100),
        invoice_count: i + 1,
        open_debit_count: 3,
        open_credit_count: 1,
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
      const one: CustomerAgingBandRow[] = [
        { bucket_no: bucketNo, currency_code: 'USD', txn_minor: '13', base_minor: '13', invoice_count: 1, open_debit_count: 3, open_credit_count: 1 },
      ];
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

// ─────────────────────────────────────────────────────────────────────────────
// §E DR-39 — THE TWO PER-CURRENCY DOCUMENT COUNTERS.
//
//    The owner's ruling: `open_debit_count` counts open documents whose
//    balance is `> 0`, `open_credit_count` those whose balance is `< 0`
//    (an overpayment's credit among them, DR-23), a document at exactly zero
//    is counted in NEITHER, both are distinct at the level of the CUSTOMER
//    AND THE CURRENCY and measured independently of the bands, and NO field
//    may add the two together.
//
//    WHAT §E CAN AND CANNOT MEASURE, STATED BEFORE THE CASES. The SIGN SPLIT
//    happens in SQL — `count(DISTINCT invoice_id) FILTER (WHERE … > 0)` and
//    `… < 0` — so "a credit document lands in the credit counter" is a
//    DATABASE claim and it is NOT_RUN here; the shipped predicates are held by
//    text law in `packages/shared-contracts/test/dr39-open-document-counts.test.ts`
//    §2. What §E measures is everything the FOLD is answerable for: that the
//    pair reaches the document unchanged and per currency, that a document
//    reaching several bands is counted ONCE and not once per band, that a
//    currency netting to zero still appears (DR-33), and that a row set which
//    contradicts itself is REFUSED rather than guessed at.
//
//    EVERY EXPECTED NUMBER BELOW IS WRITTEN BY HAND. None of them is produced
//    by calling `foldCustomerAging`, and none by calling the local wrong folds
//    either — those exist only to be shown FAILING.
// ─────────────────────────────────────────────────────────────────────────────

/** The DTO row shape §E asserts over, written out so the cases do not depend on an import. */
interface OpenCountsRow {
  currency: string;
  openDebitCount: number;
  openCreditCount: number;
}

/**
 * A customer with BOTH a debit and a credit document open in one currency, and
 * a second currency whose single document spans several bands.
 *
 * `JOD` is the NET-ZERO currency: `+4000` in band 1 and `-4000` in the oldest
 * band, so its contribution to `totalBaseMinor` is nil while it still has two
 * open documents — one debit, one credit. DR-33 says it must still appear.
 *
 * `KWD` is the SPANNING currency: one document, under an instalment plan,
 * whose money reaches THREE bands. Its per-band `invoice_count` is 1 in each,
 * summing to 3, while its `open_debit_count` is 1 — which is exactly the
 * difference DR-29 named and DR-39 keeps.
 *
 * TOTAL rows, for the reason given at `ROWS`. §E4 mutates them into the wire
 * type's orphans — `{ ...base, bucket_no: null }` and the rest — where the
 * literal is checked against `CustomerAgingSqlRow` and the null is the point.
 */
const DR39_ROWS: readonly CustomerAgingBandRow[] = Object.freeze([
  { bucket_no: 1, currency_code: 'JOD', txn_minor: '4000', base_minor: '4000', invoice_count: 1, open_debit_count: 1, open_credit_count: 1 },
  { bucket_no: 1, currency_code: 'KWD', txn_minor: '600', base_minor: '600', invoice_count: 1, open_debit_count: 1, open_credit_count: 0 },
  { bucket_no: 2, currency_code: 'KWD', txn_minor: '300', base_minor: '300', invoice_count: 1, open_debit_count: 1, open_credit_count: 0 },
  { bucket_no: 3, currency_code: 'KWD', txn_minor: '100', base_minor: '100', invoice_count: 1, open_debit_count: 1, open_credit_count: 0 },
  { bucket_no: OLDEST_BUCKET_NO, currency_code: 'JOD', txn_minor: '-4000', base_minor: '-4000', invoice_count: 1, open_debit_count: 1, open_credit_count: 1 },
]);

/**
 * The counters a row set declares for one currency, read straight off the
 * fixture.
 *
 * THE `?? -1` IS GONE, and that matters beyond the type. It was a SILENT
 * SUBSTITUTION with an unsigned direction: a fixture whose counter went
 * missing came back as `-1`, which made §E0's `toBeGreaterThan(0)` fail —
 * correctly — but made `expect(declaredPair(JOD)).not.toEqual(declaredPair(
 * KWD))` PASS for the wrong reason, since `-1` differs from anything. A guard
 * that reads an absence as a distinct value cannot tell "these two currencies
 * disagree" from "both forgot to answer". The row is total now, so there is no
 * absence to substitute for, and the figure is read rather than defaulted.
 */
function declaredPair(rows: readonly CustomerAgingBandRow[], currency: string): { debit: number; credit: number } {
  const first = rows.find((r) => r.currency_code === currency);
  if (first === undefined) throw new Error(`the fixture has no ${currency} row, so the case has no subject`);
  return { debit: first.open_debit_count, credit: first.open_credit_count };
}

/** Σ the per-band `invoice_count` of one currency — the figure DR-29 forbids as a document total. */
function bandCountsOf(rows: readonly CustomerAgingBandRow[], currency: string): number {
  return rows.filter((r) => r.currency_code === currency).reduce((acc, r) => acc + r.invoice_count, 0);
}

/**
 * WRONG FOLD 1 — IT COUNTS A DOCUMENT ONCE PER BAND.
 *
 * It differs from `foldCustomerAging` in exactly one respect: where the real
 * fold ASSERTS that every row of a currency carries the same pair, this one
 * ACCUMULATES the pair across rows. That is precisely the defect DR-39's
 * negative control names — "a document counted twice" — and it is the mistake
 * a hand reaches for naturally, because every other figure in that fold IS
 * accumulated.
 *
 * DELIBERATELY NOT SHARED, and deliberately NOT a mutation of the production
 * module. A red proof whose subject lives where the production code lives can
 * be made green by editing the production code, and then the proof and the
 * defect go green together and in silence.
 */
function doubleCountingFoldUnderTest(rows: readonly CustomerAgingSqlRow[]): OpenCountsRow[] {
  const byCurrency = new Map<string, OpenCountsRow>();
  for (const r of rows) {
    if (r.currency_code === null || r.open_debit_count === null || r.open_credit_count === null) continue;
    const seen = byCurrency.get(r.currency_code) ?? { currency: r.currency_code, openDebitCount: 0, openCreditCount: 0 };
    seen.openDebitCount += r.open_debit_count; // ← THE DEFECT: once per band.
    seen.openCreditCount += r.open_credit_count;
    byCurrency.set(r.currency_code, seen);
  }
  return [...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

/**
 * WRONG FOLD 2 — IT READS A CREDIT DOCUMENT AS A DEBIT ONE.
 *
 * The two counters arrive as two columns of one row, and nothing in the shape
 * of a row says which is which: swapping them is a one-token slip no type
 * catches, both figures stay non-negative integers, and their SUM — the number
 * DR-39 rule 5 forbids anyone from computing — is UNCHANGED. So a suite that
 * only checked a total, or only checked that both counters are present, would
 * be green on this. The case that catches it has to name the two figures
 * SEPARATELY, which is what `E1` does.
 */
function signSwappingFoldUnderTest(rows: readonly CustomerAgingSqlRow[]): OpenCountsRow[] {
  const byCurrency = new Map<string, OpenCountsRow>();
  for (const r of rows) {
    if (r.currency_code === null || r.open_debit_count === null || r.open_credit_count === null) continue;
    // ← THE DEFECT: the credit column is reported as the debit counter.
    byCurrency.set(r.currency_code, { currency: r.currency_code, openDebitCount: r.open_credit_count, openCreditCount: r.open_debit_count });
  }
  return [...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

describe('§E0 the DR-39 fixture has a subject', () => {
  it('the fixture really carries a debit side, a credit side, a net-zero currency and a spanning document', () => {
    // Without these, every §E claim is a negative assertion over an absent
    // subject and green about nothing.
    expect(DR39_ROWS.length).toBeGreaterThan(0);
    expect(new Set(DR39_ROWS.map((r) => r.currency_code)).size, 'the fixture must be multi-currency or per-currency distinctness is unfalsifiable').toBe(2);
    expect(declaredPair(DR39_ROWS, 'JOD').credit, 'JOD must really have a credit document').toBeGreaterThan(0);
    expect(declaredPair(DR39_ROWS, 'JOD').debit, 'and a debit one, so both counters are non-zero somewhere').toBeGreaterThan(0);
    // The net-zero fact, by hand: +4000 and −4000.
    expect(DR39_ROWS.filter((r) => r.currency_code === 'JOD').reduce((a, r) => a + BigInt(r.base_minor), 0n)).toBe(0n);
    // And the spanning fact: three bands, three per-band counts, ONE document.
    expect(DR39_ROWS.filter((r) => r.currency_code === 'KWD').length).toBe(3);
    expect(bandCountsOf(DR39_ROWS, 'KWD')).toBe(3);
    expect(declaredPair(DR39_ROWS, 'KWD').debit).toBe(1);
    expect(bandCountsOf(DR39_ROWS, 'KWD')).not.toBe(declaredPair(DR39_ROWS, 'KWD').debit);
    // The two currencies' pairs DIFFER, so a fold that collapsed the counters
    // across currencies could not produce this fixture's answer.
    expect(declaredPair(DR39_ROWS, 'JOD')).not.toEqual(declaredPair(DR39_ROWS, 'KWD'));
  });
});

describe('§E DR-39: the two counters, per currency, independent of the bands', () => {
  // E1 — the owner's first required case.
  it('E1 — a customer with BOTH a debit and a credit document reports them as TWO figures, by hand', () => {
    const { openCounts } = foldCustomerAging(DR39_ROWS, SHAPE);
    // Hand-written, in full, and ordered by currency so the answer is stable.
    expect(openCounts).toEqual([
      { currency: 'JOD', openDebitCount: 1, openCreditCount: 1 },
      { currency: 'KWD', openDebitCount: 1, openCreditCount: 0 },
    ]);
    // And the row carries NOTHING ELSE — rule 5: no combined field, however
    // named, may ride along beside the pair.
    for (const row of openCounts) {
      expect(Object.keys(row).sort(), `${row.currency} carries a field beyond the pair and its key`).toEqual(['currency', 'openCreditCount', 'openDebitCount']);
    }
  });

  // E2 — the owner's second required case, which is DR-33 seen from here.
  it('E2 — a currency whose open documents NET TO ZERO still appears, with both counters standing', () => {
    const jod = DR39_ROWS.filter((r) => r.currency_code === 'JOD');
    expect(
      jod.reduce((a, r) => a + BigInt(r.base_minor), 0n),
      'non-vacuity: the net really is zero',
    ).toBe(0n);
    const { openCounts, buckets } = foldCustomerAging(DR39_ROWS, SHAPE);
    const row = openCounts.find((c) => c.currency === 'JOD');
    expect(row, 'a net of zero must not delete the currency from the answer (DR-33)').toEqual({
      currency: 'JOD',
      openDebitCount: 1,
      openCreditCount: 1,
    });
    // And the money really did cancel in the bands, which is what makes the
    // appearance non-trivial: the currency is present with a nil contribution.
    const jodInBands = buckets.flatMap((b) => b.byCurrency).filter((c) => c.currency === 'JOD');
    expect(jodInBands.map((c) => c.txnMinor)).toEqual(['4000', '-4000']);
    expect(jodInBands.reduce((a, c) => a + BigInt(c.txnMinor), 0n)).toBe(0n);
  });

  // E3 — the owner's third required case.
  it('E3 — ONE document spanning several bands is counted ONCE, not once per band', () => {
    const spanned = bandCountsOf(DR39_ROWS, 'KWD');
    expect(spanned, 'non-vacuity: the document really does reach more than one band').toBe(3);
    const { openCounts, buckets } = foldCustomerAging(DR39_ROWS, SHAPE);
    const row = openCounts.find((c) => c.currency === 'KWD');
    expect(row?.openDebitCount, 'one document is one document, however many bands its money reaches').toBe(1);
    expect(row?.openCreditCount).toBe(0);
    // The DIFFERENCE is the point, so it is asserted and not left implied: the
    // per-band figures for this currency come to three while the number of
    // documents is one, and that sum is exactly what DR-29 forbids as a total.
    const fromBands = buckets.reduce((acc, b) => acc + b.byCurrency.filter((c) => c.currency === 'KWD').length, 0);
    expect(fromBands).toBe(3);
    expect(row?.openDebitCount).not.toBe(fromBands);
    expect(row?.openDebitCount).not.toBe(spanned);
  });

  // E4 — the refusals. A row the fold cannot place is a DEFECT and never a
  //      merchant outcome, so it leaves through the module's one refusal
  //      channel rather than as a clamp or a `continue`.
  it('E4 — a row set that contradicts itself about a currency is REFUSED, not reconciled', () => {
    const refuses = (rows: readonly CustomerAgingSqlRow[], why: string): void => {
      let thrown: unknown;
      try {
        foldCustomerAging(rows, SHAPE);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, why).toBeInstanceOf(AppError);
      expect((thrown as AppError).httpStatus, why).toBe(500);
      expect((thrown as AppError).details?.['sellingCode'], why).toBe('customer.aging_bucket_mapping_invalid');
    };

    const base = DR39_ROWS[1];
    if (base === undefined) throw new Error('the fixture lost its KWD row, so E4 has no subject');

    // (a) two bands of ONE currency disagreeing about the pair. Taking the
    //     first, the largest or the last would be inventing a figure a
    //     merchant reads next to a total out of a contradiction.
    refuses([base, { ...base, bucket_no: 2, open_debit_count: 9 }], 'two rows of one currency disagreeing about the debit counter must be refused');
    refuses([base, { ...base, bucket_no: 2, open_credit_count: 9 }], 'and about the credit counter');

    // (b) a counter that is not a count. A negative DOCUMENT COUNT is not a
    //     credit balance — it is a malformed answer.
    refuses([{ ...base, open_debit_count: -1 }], 'a negative debit counter is a defect');
    refuses([{ ...base, open_credit_count: -1 }], 'a negative credit counter is a defect');
    refuses([{ ...base, open_debit_count: 1.5 }], 'a fractional counter is a defect');

    // (c) a counter-bearing row with NO currency has no key, so it cannot be
    //     placed per currency, and a guess would file it under some other
    //     currency's name.
    refuses([{ ...base, currency_code: null }], 'a counter row without a currency is a defect');

    // (d) the FULL JOIN's orphans, in both directions. Impossible in a correct
    //     database, representable in a row set, and refused rather than
    //     dropped.
    refuses([{ ...base, bucket_no: null }], 'a counter row with no band is a defect');
    refuses([{ ...base, open_debit_count: null }], 'a band row with no counters is a defect');
    refuses([{ ...base, open_credit_count: null }], 'in either column');

    // (e) AND THE REMAINING THREE COLUMNS, so the boundary is measured over
    //     all SEVEN rather than over the four a reader happened to think of.
    //     `bandRowOrRefuse` is the single place a degenerate row is refused,
    //     and a boundary tested on a subset of its columns is a boundary with
    //     holes in the columns nobody tried.
    //
    //     `txn_minor` IS A CHANGE OF OUTCOME and is pinned here deliberately.
    //     The fold used to read it as `if (txn_minor !== null) push(...)`: a
    //     row missing only that column was ACCEPTED, its `base_minor` went
    //     into the band and into `totalBaseMinor`, and it simply contributed
    //     no line to `byCurrency`. So a merchant could be shown a band whose
    //     base figure no per-currency line accounts for — the two disagreeing
    //     on one document, silently, which is the shape of defect this whole
    //     function exists to refuse. It is now refused like its six siblings.
    refuses([{ ...base, txn_minor: null }], 'a band row with no transaction figure is a defect, not a row to count and not list');
    refuses([{ ...base, base_minor: null }], 'a band row with no base money is a defect');
    refuses([{ ...base, invoice_count: null }], 'a band row with no invoice count is a defect');

    // The POSITIVE control for the whole of E4: the UNMUTATED row is accepted,
    // or every refusal above would be a refusal of something else.
    expect(foldCustomerAging([base], SHAPE).openCounts).toEqual([{ currency: 'KWD', openDebitCount: 1, openCreditCount: 0 }]);
  });

  /**
   * E4b — THE REFUSAL NAMES THE ROW, AND NAMES IT WHERE THE MERCHANT CANNOT
   * SEE IT.
   *
   * `bandRowOrRefuse` is the single boundary, and a boundary that reports only
   * "one of these rows was malformed" sends whoever reads the log back to the
   * query. So it names the row's index and the missing column — on `cause`,
   * which `ApiErrorBody` has no field for.
   *
   * Both halves are asserted, because either alone is the wrong outcome: a
   * refusal that named nothing would be useless, and one that named the column
   * in `details` would ship this read's internal query shape to a browser.
   * `details` stays exactly `{ sellingCode }` and the message stays the
   * generic sentence — the wire answer is the one §A CASE 9 already pins.
   */
  it('E4b — a degenerate row names itself and its column on `cause`, while the client body stays exactly as it was', () => {
    const base = DR39_ROWS[1];
    if (base === undefined) throw new Error('the fixture lost its KWD row, so E4b has no subject');

    // The row index is the position in the SET, not in the band: the second
    // row here, so index 1, and a boundary that reported 0 for everything
    // would fail this.
    let thrown: unknown;
    try {
      foldCustomerAging([base, { ...base, bucket_no: 2, open_debit_count: null }], SHAPE);
    } catch (error) {
      thrown = error;
    }
    // Narrowed by `instanceof` and not by a cast: the assertion states the
    // claim for the report, and the guard is what lets the compiler read the
    // lines below. A cast would have asserted it twice and proved it once.
    expect(thrown).toBeInstanceOf(AppError);
    if (!(thrown instanceof AppError)) throw new Error('the refusal was not an AppError, so E4b has no subject');
    const refusal = thrown;

    // The client's answer: UNCHANGED, and asserted in full so a later edit
    // cannot widen it quietly.
    expect(refusal.httpStatus).toBe(500);
    expect(refusal.message).toBe('Internal error');
    expect(Object.keys(refusal.details ?? {})).toEqual(['sellingCode']);
    expect(refusal.details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');

    // The engineer's answer: the row and the column, by name.
    expect(typeof refusal.cause).toBe('string');
    expect(String(refusal.cause)).toContain('row 1');
    expect(String(refusal.cause)).toContain('open_debit_count');
    // And the column name went NOWHERE near the body.
    expect(JSON.stringify(refusal.details ?? {})).not.toContain('open_debit_count');

    // THE POSITIVE CONTROL, and it is what stops the two assertions above from
    // being satisfied by a `cause` that says the same thing for everything: a
    // refusal of a row that is COMPLETE and merely invalid does not come from
    // this boundary at all, so it carries no such naming.
    let other: unknown;
    try {
      foldCustomerAging([{ ...base, bucket_no: 0 }], SHAPE);
    } catch (error) {
      other = error;
    }
    expect(other).toBeInstanceOf(AppError);
    if (!(other instanceof AppError)) throw new Error('the ordinal refusal was not an AppError, so the control has no subject');
    expect(other.cause).toBeUndefined();
    expect(other.details?.['sellingCode']).toBe('customer.aging_bucket_mapping_invalid');
  });

  // E5 — the empty answer is a STATEMENT.
  it('E5 — no rows means no currency has an open document, stated as an empty list and not as a zero', () => {
    const { openCounts, buckets, totalBaseMinor } = foldCustomerAging([], SHAPE);
    expect(openCounts).toEqual([]);
    expect(totalBaseMinor).toBe('0');
    expect(buckets.length).toBe(LABELS.length);
    // `[]` and not a row of zeroes under the base currency: there is no
    // currency to name, and naming one would assert that the customer holds a
    // zero-count position in it, which is a different claim.
  });
});

describe('§E-RED DR-39: the two wrong folds, EXECUTED, going red under §E', () => {
  it('RED-E1 — the DOUBLE-COUNTING fold is caught by E3, with the actual numbers on both sides', () => {
    const right = foldCustomerAging(DR39_ROWS, SHAPE).openCounts;
    const wrong = doubleCountingFoldUnderTest(DR39_ROWS);
    // The defect, measured: the spanning document is counted once per band.
    expect(wrong.find((c) => c.currency === 'KWD')?.openDebitCount).toBe(3);
    expect(right.find((c) => c.currency === 'KWD')?.openDebitCount).toBe(1);
    // And E3's assertion really does fail against it.
    expect(() => expect(wrong.find((c) => c.currency === 'KWD')?.openDebitCount).toBe(1)).toThrow();
    // The credit side is hit too: JOD's credit counter doubles across its two
    // bands, so "a credit balance is counted once" fails as well.
    expect(wrong.find((c) => c.currency === 'JOD')).toEqual({ currency: 'JOD', openDebitCount: 2, openCreditCount: 2 });
    expect(() => expect(wrong).toEqual(right)).toThrow();
  });

  it('RED-E2 — the SIGN-SWAPPING fold is caught by E1, and is INVISIBLE to any law about the pair sum', () => {
    const right = foldCustomerAging(DR39_ROWS, SHAPE).openCounts;
    const wrong = signSwappingFoldUnderTest(DR39_ROWS);
    // KWD has one debit document and no credit one, so the swap is total: a
    // real receivable is reported as a credit balance.
    expect(wrong.find((c) => c.currency === 'KWD')).toEqual({ currency: 'KWD', openDebitCount: 0, openCreditCount: 1 });
    expect(right.find((c) => c.currency === 'KWD')).toEqual({ currency: 'KWD', openDebitCount: 1, openCreditCount: 0 });
    expect(() => expect(wrong).toEqual(right)).toThrow();
    // AND THE REASON RULE 5 IS A RULE, demonstrated rather than argued: the
    // SUM of the pair is IDENTICAL under the swap, currency by currency. A
    // client that had added the two together would see nothing wrong, while a
    // merchant would be chasing a customer who is in credit.
    for (const currency of ['JOD', 'KWD']) {
      const r = right.find((c) => c.currency === currency);
      const w = wrong.find((c) => c.currency === currency);
      expect((w?.openDebitCount ?? 0) + (w?.openCreditCount ?? 0)).toBe((r?.openDebitCount ?? 0) + (r?.openCreditCount ?? 0));
    }
    // JOD's pair is SYMMETRIC (1 and 1), so the swap is undetectable there —
    // which is why E1 names a currency whose counters DIFFER. Stated, so a
    // later hand does not "simplify" the fixture down to the symmetric case.
    expect(wrong.find((c) => c.currency === 'JOD')).toEqual(right.find((c) => c.currency === 'JOD'));
  });
});
