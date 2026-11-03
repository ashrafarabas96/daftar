/**
 * THE PERCENTILE THE BUDGETS ARE JUDGED BY, SEPARATED SO IT CAN BE TESTED
 * (TL-P4-S3 performance-evidence directive §6).
 *
 * `tests/performance/accounting-budgets.test.ts` decides whether a budget was
 * met by comparing ONE number — `p95` — against a ceiling. That number is the
 * output of an index calculation over the sorted samples, and until now the
 * calculation lived inside the suite where nothing could assert on it: a
 * verdict was being read from arithmetic that had no test of its own.
 *
 * The arithmetic here is the arithmetic that was already in use, moved
 * unchanged, NOT a new method. §6 of the directive is explicit that the
 * percentile method may not be changed in this corrective path unless an
 * independent test proves a real arithmetic error, and the tests beside this
 * file (`tests/guards/accounting-budget-percentile-semantics.test.ts`) record
 * the exact index each quantile reads at n = 30, 100 and 200 rather than
 * asserting a preferred definition.
 *
 * WHAT THE INDEX IS. `index = min(n - 1, floor(q · n))`, zero-based, over the
 * samples sorted ascending. For a q·n that is not a whole number this is the
 * NEAREST-RANK percentile — the ⌈q·n⌉-th smallest sample, the inverse-CDF
 * definition — and for a whole q·n it reads one rank higher than the
 * inverse CDF would, which is stricter, never looser. Both cases are recorded
 * as tests.
 *
 * WHY THE SAMPLE COUNT MATTERS MORE THAN THE DEFINITION. At n = 30, `p95` is
 * index 28: the SECOND-WORST sample of thirty, so a single stalled iteration
 * decides the verdict. At n = 200 it is index 190, with ten samples above it,
 * so the figure is an actual tail estimate and a lone stall cannot carry it.
 * That is the whole reason the directive raises the count of the two short
 * percentile budgets and leaves the ceilings untouched.
 */

/** A sample series read out of bounds is a programming error, never a number. */
function at(sorted: readonly number[], index: number): number {
  const value = sorted[index];
  if (value === undefined) throw new Error(`percentile: no sample at index ${index} of ${sorted.length}`);
  return value;
}

/**
 * The zero-based index a quantile reads, for a series of `count` samples.
 *
 * Exported so a test can assert the POSITION and not only the value: a test
 * that checks the value can pass against a dataset whose neighbours happen to
 * be equal, and then say nothing about which rank was read.
 */
export function quantileIndex(count: number, q: number): number {
  if (!Number.isInteger(count) || count < 1) throw new Error(`percentile: ${count} is not a sample count`);
  return Math.min(count - 1, Math.floor(q * count));
}

/** The quantile of an UNSORTED series. Sorts a copy; the caller's array is untouched. */
export function quantile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return at(sorted, quantileIndex(sorted.length, q));
}

/**
 * Everything §7 of the directive requires printed beside a percentile
 * verdict, computed from the samples and from nothing else.
 *
 * DIAGNOSTIC DATA NEVER CHANGES THE VERDICT (§7). Nothing here removes,
 * trims, winsorises or re-weights a sample: every field is a description of
 * the complete series, and `orderedMs` is that complete series. The verdict
 * is still `quantile(samples, 0.95) <= threshold` over all of them.
 */
export interface Distribution {
  readonly iterations: number;
  readonly thresholdMs: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** The zero-based index each quantile above was read from. */
  readonly indices: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** Every sample, sorted ascending — the complete series, nothing dropped. */
  readonly orderedMs: readonly number[];
  readonly countAtOrBelowThreshold: number;
  readonly countAboveThreshold: number;
  /** Samples above the ceiling, as a share of all samples. */
  readonly shareAboveThreshold: number;
  /** above ÷ at-or-below, or `null` when nothing met the ceiling. */
  readonly slowToFastCountRatio: number | null;
  /** max ÷ min: how far the slow mode sits from the fast one. */
  readonly maxOverMinRatio: number | null;
  /** p95 ÷ p50: a bimodal series shows a large gap here, a uniform one does not. */
  readonly p95OverP50Ratio: number | null;
}

const round = (v: number): number => Number(v.toFixed(3));

export function distribution(samples: readonly number[], thresholdMs: number): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const indices = { p50: quantileIndex(n, 0.5), p95: quantileIndex(n, 0.95), p99: quantileIndex(n, 0.99) };
  const atOrBelow = sorted.filter((v) => v <= thresholdMs).length;
  const above = n - atOrBelow;
  const min = at(sorted, 0);
  const p50 = at(sorted, indices.p50);
  const p95 = at(sorted, indices.p95);
  return {
    iterations: n,
    thresholdMs,
    min: round(min),
    p50: round(p50),
    p95: round(p95),
    p99: round(at(sorted, indices.p99)),
    max: round(at(sorted, n - 1)),
    indices,
    orderedMs: sorted.map(round),
    countAtOrBelowThreshold: atOrBelow,
    countAboveThreshold: above,
    shareAboveThreshold: round(above / n),
    slowToFastCountRatio: atOrBelow === 0 ? null : round(above / atOrBelow),
    maxOverMinRatio: min === 0 ? null : round(at(sorted, n - 1) / min),
    p95OverP50Ratio: p50 === 0 ? null : round(p95 / p50),
  };
}
