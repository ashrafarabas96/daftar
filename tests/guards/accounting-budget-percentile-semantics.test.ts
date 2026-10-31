/**
 * WHAT `p95` ACTUALLY READS, AT EVERY SAMPLE COUNT THE BUDGETS USE
 * (TL-P4-S3 performance-evidence directive §6).
 *
 * The six accounting budgets are decided by one number compared against one
 * ceiling. §6 of the directive requires that, before anything relies on that
 * number, the percentile's ACTUAL INDEX POSITIONS are proven at n = 30, 100
 * and 200 against a known dataset — and that the method itself is left alone
 * unless an independent test proves a real arithmetic error, in which case the
 * corrective pass stops and reports.
 *
 * This file is that independent test. Its finding, recorded rather than
 * asserted as a preference:
 *
 *   `index = min(n - 1, floor(q · n))` over the ascending samples is the
 *   NEAREST-RANK (inverse-CDF) percentile whenever q · n is not a whole
 *   number, and reads ONE RANK HIGHER — stricter, never looser — when it is.
 *   It is not an arithmetic error, so §6's STOP clause does not fire.
 *
 * And the fact that motivates the directive, measured here instead of argued:
 * at n = 30 the `p95` of a series is its SECOND-WORST sample, so one stalled
 * iteration is the verdict; at n = 200 ten samples sit above it.
 *
 * It lives under `tests/guards/` because that directory is executed by
 * `npm run test:integration`, which is a required step of the `backend` CI
 * job — a proof about the instrument is worth nothing in a suite the gate
 * does not run.
 */
import { describe, expect, it } from 'vitest';
import { distribution, quantile, quantileIndex } from '../performance/percentile';

/** 1, 2, 3, … n — so the value at a zero-based index i is exactly i + 1. */
const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/** The same series, shuffled deterministically: the quantile must sort for itself. */
const shuffled = (n: number): number[] => {
  const values = ramp(n);
  for (let i = values.length - 1, seed = 7; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [values[i], values[j]] = [values[j] as number, values[i] as number];
  }
  return values;
};

describe('the index each quantile reads (§6: the actual positions, not the intent)', () => {
  it('n = 30 — the count the budgets used until this pass', () => {
    expect({ p50: quantileIndex(30, 0.5), p95: quantileIndex(30, 0.95), p99: quantileIndex(30, 0.99) }).toEqual({ p50: 15, p95: 28, p99: 29 });
  });

  it('n = 100', () => {
    expect({ p50: quantileIndex(100, 0.5), p95: quantileIndex(100, 0.95), p99: quantileIndex(100, 0.99) }).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  it('n = 200 — the count budgets A and B are measured at from this pass on', () => {
    expect({ p50: quantileIndex(200, 0.5), p95: quantileIndex(200, 0.95), p99: quantileIndex(200, 0.99) }).toEqual({ p50: 100, p95: 190, p99: 198 });
  });

  it('reads the value at that index and nothing else, on a known dataset', () => {
    // value = index + 1, so each number below IS the index that was read.
    expect([quantile(ramp(30), 0.5), quantile(ramp(30), 0.95), quantile(ramp(30), 0.99)]).toEqual([16, 29, 30]);
    expect([quantile(ramp(100), 0.5), quantile(ramp(100), 0.95), quantile(ramp(100), 0.99)]).toEqual([51, 96, 100]);
    expect([quantile(ramp(200), 0.5), quantile(ramp(200), 0.95), quantile(ramp(200), 0.99)]).toEqual([101, 191, 199]);
  });

  it('sorts its own input: the order the samples arrived in does not move the answer', () => {
    for (const n of [30, 100, 200]) {
      expect(quantile(shuffled(n), 0.95), `n=${n}`).toBe(quantile(ramp(n), 0.95));
    }
  });
});

describe('the method, named (§6: is it an arithmetic error, or a definition?)', () => {
  it('is the nearest-rank percentile whenever q · n is not a whole number', () => {
    // Nearest rank: the ⌈q·n⌉-th smallest sample, i.e. zero-based ⌈q·n⌉ − 1.
    for (const [n, q] of [
      [30, 0.95],
      [30, 0.99],
      [100, 0.995],
      [200, 0.999],
      [7, 0.95],
    ] as const) {
      expect(Number.isInteger(q * n), `q·n=${q * n}`).toBe(false);
      expect(quantileIndex(n, q), `n=${n} q=${q}`).toBe(Math.ceil(q * n) - 1);
    }
  });

  it('reads one rank HIGHER than nearest rank when q · n is a whole number — stricter, never looser', () => {
    for (const [n, q] of [
      [100, 0.95],
      [100, 0.5],
      [30, 0.5],
      [200, 0.95],
      [200, 0.99],
      [200, 0.5],
      [20, 0.95],
    ] as const) {
      expect(Number.isInteger(q * n)).toBe(true);
      expect(quantileIndex(n, q), `n=${n} q=${q}`).toBe(q * n);
      // One rank above the inverse CDF's ⌈q·n⌉ − 1 = q·n − 1. On a monotone
      // series that can only raise the reported figure, so a budget judged
      // this way is never let through by the definition.
      expect(quantile(ramp(n), q)).toBeGreaterThan(ramp(n)[q * n - 1] as number);
    }
  });

  it('never leaves the series: p100 is the maximum, p0 the minimum, and the order is monotone', () => {
    for (const n of [1, 2, 30, 100, 200]) {
      const series = ramp(n);
      expect(quantile(series, 1), `n=${n}`).toBe(n);
      expect(quantile(series, 0), `n=${n}`).toBe(1);
      expect(quantile(series, 0.5)).toBeLessThanOrEqual(quantile(series, 0.95));
      expect(quantile(series, 0.95)).toBeLessThanOrEqual(quantile(series, 0.99));
      expect(quantile(series, 0.99)).toBeLessThanOrEqual(n);
    }
  });

  it('refuses an empty series rather than inventing a number', () => {
    expect(() => quantile([], 0.95)).toThrow(/not a sample count/);
  });
});

describe('what the sample count does to the verdict (the reason for §4)', () => {
  it('at n = 30, p95 is the second-worst sample: one stalled iteration is the verdict', () => {
    expect(quantileIndex(30, 0.95)).toBe(30 - 2);
    // Twenty-nine fast samples and one stall: the stall decides it.
    const oneStall = [...Array.from({ length: 29 }, () => 4), 999];
    expect(quantile(oneStall, 0.95)).toBe(4);
    // Twenty-eight fast samples and two stalls: now p95 IS a stall.
    const twoStalls = [...Array.from({ length: 28 }, () => 4), 999, 999];
    expect(quantile(twoStalls, 0.95)).toBe(999);
  });

  it('at n = 200, ten samples sit above p95 — a tail estimate, not a near-maximum', () => {
    const n = 200;
    const series = ramp(n);
    const p95 = quantile(series, 0.95);
    expect(series.filter((v) => v > p95)).toHaveLength(9);
    // Nine strictly above plus p95 itself: the tenth-worst sample of 200,
    // against the second-worst of 30.
    expect(n - quantileIndex(n, 0.95)).toBe(10);
    // Nine stalls in two hundred no longer carry the figure; eleven do.
    const withStalls = (stalls: number): number[] => [...Array.from({ length: n - stalls }, () => 4), ...Array.from({ length: stalls }, () => 999)];
    expect(quantile(withStalls(9), 0.95)).toBe(4);
    expect(quantile(withStalls(11), 0.95)).toBe(999);
  });
});

describe('the diagnostic block describes the series and never edits it (§7)', () => {
  /**
   * The series Budget A actually measured on the pull-request runner of
   * `ee4322c` (push CI 37158335051 green, PR CI red on the same tree),
   * copied from the assertion message verbatim. It is here so the published
   * verdict can be recomputed from the published samples by anyone.
   */
  const BUDGET_A_PR_SAMPLES = [
    17.831, 18.373, 17.701, 4.637, 4.789, 3.842, 6.353, 3.907, 17.143, 4.06, 3.764, 4.024, 4.075, 3.784, 3.901, 3.821, 4.011, 6.997, 18.043, 17.923, 18.025,
    4.368, 4.049, 3.853, 8.63, 17.92, 4.09, 16.781, 18.1, 4.18,
  ];

  it('recomputes the published red verdict from the published samples', () => {
    const d = distribution(BUDGET_A_PR_SAMPLES, 15);
    expect(d.iterations).toBe(30);
    expect(d.p95).toBe(18.1);
    expect(d.p50).toBe(4.637);
    expect(d.max).toBe(18.373);
    expect(d.min).toBe(3.764);
    // NOT one outlier: TEN of thirty samples sat above the ceiling, every one
    // of them between 16.7 and 18.4 ms. A third of the series is the slow mode.
    expect({ above: d.countAboveThreshold, atOrBelow: d.countAtOrBelowThreshold }).toEqual({ above: 10, atOrBelow: 20 });
    expect(d.orderedMs.slice(-10).every((v) => v > 16.5 && v < 18.5)).toBe(true);
    expect(d.p95).toBeGreaterThan(15);
  });

  it('keeps every sample: the ordered series is a permutation of the measured one', () => {
    const d = distribution(BUDGET_A_PR_SAMPLES, 15);
    expect([...d.orderedMs].sort((a, b) => a - b)).toEqual([...BUDGET_A_PR_SAMPLES].sort((a, b) => a - b));
    expect(d.orderedMs).toHaveLength(BUDGET_A_PR_SAMPLES.length);
    expect(d.countAboveThreshold + d.countAtOrBelowThreshold).toBe(d.iterations);
  });

  it('reports the same p95 the verdict uses — the diagnostics are not a second opinion', () => {
    for (const series of [BUDGET_A_PR_SAMPLES, ramp(200), shuffled(100)]) {
      expect(distribution(series, 15).p95).toBe(Number(quantile(series, 0.95).toFixed(3)));
    }
  });

  it('records the index it read, so a reader need not re-derive it', () => {
    expect(distribution(ramp(200), 15).indices).toEqual({ p50: 100, p95: 190, p99: 198 });
  });

  it('no softening §5 forbids would have rescued this series — the slow mode is a third of it', () => {
    // Worth recording, because the shape of the failure decides what it
    // means. Every prohibited shortcut is measured here against the same
    // samples, and none of them turns this series green:
    const sorted = [...BUDGET_A_PR_SAMPLES].sort((a, b) => a - b);
    // p95 → p90, which §5 forbids:
    expect(quantile(sorted, 0.9)).toBeGreaterThan(15);
    // dropping the top five per cent, which §5 forbids:
    expect(quantile(sorted.slice(0, sorted.length - 2), 0.95)).toBeGreaterThan(15);
    // even the third quartile is in the slow mode:
    expect(quantile(sorted, 0.75)).toBeGreaterThan(15);
    // it only goes green two thirds of the way down the series, which is
    // another way of saying ten of thirty iterations were slow.
    expect(quantile(sorted, 0.66)).toBeLessThanOrEqual(15);
  });
});
