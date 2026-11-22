/**
 * L1-PERF-AL72: the PAIRED measurement of P4-AL-72's ratio, as pure functions.
 *
 * Criteria (a)..(c) of `.local-context/cards/L1_PERF_AL72_DENOMINATOR_CARD_AR.md`
 * "معيار قبول القياس المتزاوج", each with a positive arm and a negative arm.
 * (d) is a property of the commit, (e) of the evidence file.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. It proves the helper's arithmetic and,
 * by reading the suite's source text, that the suite is wired to the helper.
 * It proves nothing about the 200-sample Postgres arm: that runs on CI Linux
 * only, and a text law proves writing, not behaviour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RATIOS } from '../scripts/phase4-budget-ratchet';
import {
  EXPECTED_RATIO_MAX,
  fingerprintOf,
  fingerprintProblems,
  pairOrder,
  ratioLimitProblems,
  ratioVerdict,
  type PairSide,
  MEDIAN_ROUNDS,
  medianRatioVerdict,
} from '../tests/performance/paired-series';

const N = 200;

/** The order a correct paired loop records: per iteration, both sides, the first alternating. */
function pairedRun(iterations: number): PairSide[] {
  const out: PairSide[] = [];
  for (let i = 0; i < iterations; i += 1) out.push(...pairOrder(i));
  return out;
}

/** Deterministic jitter, so the series have a tail without a random source. */
function series(base: number, n = N): number[] {
  return Array.from({ length: n }, (_, i) => base * (1 + (((i * 37) % 100) / 100) * 0.4));
}

describe('P4-AL-72 paired measurement', () => {
  describe('(a) the limit and provisional:false are untouched', () => {
    it('positive: the ratchet holds the limit 3 and provisional:false', () => {
      expect(EXPECTED_RATIO_MAX).toBe(3);
      expect(ratioLimitProblems(RATIOS.BALANCE_FATTAIL_OVER_MEDIAN)).toEqual([]);
    });
    it('negative: a limit of 4 turns the check red on its own', () => {
      expect(ratioLimitProblems({ max: 4, provisional: false }).length).toBe(1);
    });
    it('negative: provisional:true turns the check red on its own', () => {
      expect(ratioLimitProblems({ max: 3, provisional: true }).length).toBe(1);
    });
  });

  describe('(b) a planted disparity in the numerator', () => {
    const med = series(5);
    it('positive: a real disparity (double the numerator time) turns the ratio red', () => {
      const honest = series(10);
      expect(ratioVerdict(honest, med, EXPECTED_RATIO_MAX).withinMax).toBe(true);
      const planted = honest.map((x) => x * 2);
      const verdict = ratioVerdict(planted, med, EXPECTED_RATIO_MAX);
      expect(verdict.ratio).toBeGreaterThan(EXPECTED_RATIO_MAX);
      expect(verdict.withinMax).toBe(false);
    });
    it('negative: two identical series pass (no false failure)', () => {
      const verdict = ratioVerdict(series(7), series(7), EXPECTED_RATIO_MAX);
      expect(verdict.ratio).toBe(1);
      expect(verdict.withinMax).toBe(true);
    });
    it('negative: an empty series or a zero denominator fails, it never passes empty', () => {
      expect(ratioVerdict([], series(5), 3).withinMax).toBe(false);
      expect(ratioVerdict(series(5), [], 3).withinMax).toBe(false);
      expect(ratioVerdict(series(5), series(0), 3).withinMax).toBe(false);
      expect(ratioVerdict(series(5), series(0), 3).ratio).toBeNull();
    });
  });

  describe('(c) the alternation really happened', () => {
    it('positive: the recorded order alternates ABAB-wise inside the run', () => {
      const fp = pairedRun(N);
      expect(fp.length).toBe(2 * N);
      expect(fingerprintProblems(fp, N)).toEqual([]);
      // the first side flips every iteration, so neither side is always first
      expect(fingerprintOf(fp).startsWith('FMMFFMMF')).toBe(true);
    });
    it('negative: a planted AAA..BBB order (two consecutive series) turns the fingerprint red', () => {
      const planted: PairSide[] = [...Array<PairSide>(N).fill('F'), ...Array<PairSide>(N).fill('M')];
      expect(fingerprintProblems(planted, N).length).toBeGreaterThan(0);
    });
    it('negative: a planted FM,FM,FM order (neither side ever goes second-then-first) turns red', () => {
      const planted: PairSide[] = Array.from({ length: N }, () => ['F', 'M'] as PairSide[]).flat();
      expect(fingerprintProblems(planted, N).length).toBeGreaterThan(0);
    });
    it('negative: an EMPTY fingerprint fails and does not pass as nothing', () => {
      expect(fingerprintProblems([], N).length).toBeGreaterThan(0);
    });
    it('negative: a fingerprint of the wrong length or a foreign symbol fails', () => {
      expect(fingerprintProblems(pairedRun(N - 1), N).length).toBeGreaterThan(0);
      expect(fingerprintProblems(['X' as PairSide, ...pairedRun(N).slice(1)], N).length).toBeGreaterThan(0);
    });
  });

  /**
   * DR-175 — THE MEDIAN OF FIVE ROUNDS. Every input here has an answer known
   * before the function is called: the limit is 3, and the medians below are
   * read off the sorted list by hand. Nothing in this block is derived from
   * the implementation, which is the only way an arm about a statistic can
   * fail honestly.
   */
  describe('DR-175: the verdict is the median of five rounds, and it still misses when the read grows', () => {
    const v = (ratio: number | null) => ({
      fatP95: ratio === null ? null : 10,
      medP95: ratio === null ? null : 10 / (ratio || 1),
      ratio,
      withinMax: ratio !== null && ratio <= 3,
    });

    it('positive: the median of five is the middle of the SORTED rounds, not the last or the mean', () => {
      // sorted: 1, 2, 3, 4, 90 -> 3. A mean would be 20 and would fail; the
      // last would be 90. The arm is written so those two answers are visibly
      // different from the right one.
      const r = medianRatioVerdict([v(2), v(90), v(1), v(4), v(3)], 3);
      expect(r.problems).toEqual([]);
      expect(r.median).toBe(3);
      expect(r.withinMax).toBe(true);
    });

    it('positive: ONE hostile round does not fail the gate — the trade DR-175 makes, stated as an arm', () => {
      // four rounds at 2.6 (the value measured on `3c61ace8`) and one at 3.02
      // (the value measured on `fe9f78e8`): median 2.6, so the cart that failed
      // on a 0.8% miss would now pass.
      const r = medianRatioVerdict([v(2.6), v(2.6), v(3.02), v(2.6), v(2.6)], 3);
      expect(r.median).toBe(2.6);
      expect(r.withinMax).toBe(true);
    });

    it('NEGATIVE CONTROL: three of five over the limit MISSES — a growing read is still refused', () => {
      // This is the direction the gate exists for: a read that is genuinely
      // slower misses in most rounds, so the median misses. Without this arm
      // the median would be a relaxation with no floor.
      const r = medianRatioVerdict([v(3.4), v(2.9), v(3.6), v(2.8), v(3.5)], 3);
      expect(r.median).toBe(3.4);
      expect(r.withinMax).toBe(false);
    });

    it('NEGATIVE CONTROL: a planted delay in EVERY round misses, which is what the CI control plants', () => {
      const r = medianRatioVerdict([v(7), v(8), v(9), v(7.5), v(8.5)], 3);
      expect(r.withinMax).toBe(false);
      expect(r.median).toBe(8);
    });

    it('fails CLOSED on a round that produced no ratio — it is never dropped to make a median', () => {
      const r = medianRatioVerdict([v(2), v(null), v(2), v(2), v(2)], 3);
      expect(r.median).toBeNull();
      expect(r.withinMax).toBe(false);
      expect(r.problems.join(' ')).toMatch(/no ratio/);
      // and the surviving four would have had a median of 2, which is exactly
      // the pass this must not give.
      expect(medianRatioVerdict([v(2), v(2), v(2), v(2)], 3, 4).withinMax).toBe(true);
    });

    it('fails CLOSED on the wrong number of rounds, in both directions', () => {
      expect(medianRatioVerdict([v(2), v(2), v(2), v(2)], 3).problems.length).toBeGreaterThan(0);
      expect(medianRatioVerdict([v(2), v(2), v(2), v(2), v(2), v(2)], 3).problems.length).toBeGreaterThan(0);
      expect(medianRatioVerdict([], 3).problems.length).toBeGreaterThan(0);
    });

    it('the exact limit passes and a hair above it misses, so `<=` is the comparison', () => {
      expect(medianRatioVerdict([v(3), v(3), v(3), v(3), v(3)], 3).withinMax).toBe(true);
      expect(medianRatioVerdict([v(3.001), v(3.001), v(3.001), v(3.001), v(3.001)], 3).withinMax).toBe(false);
    });

    it('MEDIAN_ROUNDS is five, and the suite reads its rounds through this helper', () => {
      expect(MEDIAN_ROUNDS).toBe(5);
      const src = readFileSync(join(__dirname, '..', 'tests', 'performance', 'receivables-s4-budgets.test.ts'), 'utf8');
      expect(src).toContain('medianRatioVerdict(');
      // and the judged quantity is the median, not round 1's ratio
      expect(src).toContain('must(verdict.median)');
    });
  });

  describe('the suite is wired to the paired helper (a text law, which proves writing, not behaviour)', () => {
    const src = readFileSync(join(__dirname, '..', 'tests', 'performance', 'receivables-s4-budgets.test.ts'), 'utf8');
    it('positive: the ratio denominator comes from the paired measurement and its fingerprint is asserted', () => {
      expect(src).toContain('measurePairedReceivable(');
      expect(src).toContain('fingerprintProblems(');
      expect(src).toContain('ratioVerdict(');
    });
    it('negative: the denominator is no longer a second, consecutive `measure(` series', () => {
      expect(src).not.toMatch(/medianReceivable = await measure\(/);
    });
  });
});
