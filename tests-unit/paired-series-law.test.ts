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
  medianOfRoundRatios,
  PAIRED_ROUNDS,
  pairOrder,
  ratioLimitProblems,
  ratioVerdict,
  type PairSide,
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
    it('negative: two BLOCKS (FM x half, then MF x half) are balanced but never alternate, so it turns red', () => {
      const half = N / 2;
      const planted: PairSide[] = [
        ...Array.from({ length: half }, () => ['F', 'M'] as PairSide[]).flat(),
        ...Array.from({ length: N - half }, () => ['M', 'F'] as PairSide[]).flat(),
      ];
      expect(planted.length).toBe(2 * N);
      expect(fingerprintProblems(planted, N).length).toBeGreaterThan(0);
    });
    it('negative: ONE swapped pair in the middle of the real alternation turns red', () => {
      const real = pairedRun(N);
      const planted = real.slice();
      const first = real[4] as PairSide;
      const second = real[5] as PairSide;
      planted[4] = second;
      planted[5] = first;
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

  describe('(f) the verdict is the MEDIAN of five paired rounds, not one reading (owner order 2026-11-22)', () => {
    const PER_ROUND = N / PAIRED_ROUNDS;
    /** fat = per-round scale x the base shape, med = the base shape: round r's ratio is exactly scales[r]. */
    function rounds(scales: readonly number[]): { fat: number[]; med: number[] } {
      return {
        fat: scales.flatMap((k) => series(k, PER_ROUND)),
        med: scales.flatMap(() => series(1, PER_ROUND)),
      };
    }
    it('the round count is five and the limit it is judged against is the ratchet limit 3', () => {
      expect(PAIRED_ROUNDS).toBe(5);
      expect(RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max).toBe(3);
    });
    it('positive: a healthy run (every round near 2.5x) is within 3', () => {
      const { fat, med } = rounds([2.5, 2.5, 2.5, 2.5, 2.5]);
      const v = medianOfRoundRatios(fat, med, PAIRED_ROUNDS, 3);
      expect(v.roundRatios).toHaveLength(5);
      expect(v.withinMax).toBe(true);
    });
    it('negative: a PLANTED 4x regression in the fat-tail read turns the verdict red (and the same run without it is green)', () => {
      const healthy = rounds([2.5, 2.5, 2.5, 2.5, 2.5]);
      const planted = { fat: healthy.fat.map((x) => x * 1.6), med: healthy.med };
      expect(medianOfRoundRatios(healthy.fat, healthy.med, PAIRED_ROUNDS, 3).withinMax).toBe(true);
      const v = medianOfRoundRatios(planted.fat, planted.med, PAIRED_ROUNDS, 3);
      expect(v.medianRatio).toBeGreaterThan(3.9);
      expect(v.withinMax).toBe(false);
    });
    it('positive: ONE bad round (the denominator shrinks for a stretch) does not turn a healthy run red', () => {
      const { fat, med } = rounds([2.5, 2.5, 3.6, 2.5, 2.5]);
      const v = medianOfRoundRatios(fat, med, PAIRED_ROUNDS, 3);
      expect(Math.max(...v.roundRatios.map((r) => r ?? 0))).toBeGreaterThan(3);
      expect(v.withinMax).toBe(true);
    });
    it('positive: TWO bad rounds of five still leave the median healthy (the tolerance is stated, not hidden)', () => {
      const { fat, med } = rounds([3.6, 2.5, 2.5, 3.6, 2.5]);
      expect(medianOfRoundRatios(fat, med, PAIRED_ROUNDS, 3).withinMax).toBe(true);
    });
    it('negative: THREE rounds of five above the limit is a regression, and one lucky round cannot hide it', () => {
      const { fat, med } = rounds([3.6, 2.2, 3.6, 3.6, 2.5]);
      expect(medianOfRoundRatios(fat, med, PAIRED_ROUNDS, 3).withinMax).toBe(false);
    });
    it('negative: a run whose every round is just above 3 stays red; the gate was not loosened', () => {
      const { fat, med } = rounds([3.05, 3.05, 3.05, 3.05, 3.05]);
      expect(medianOfRoundRatios(fat, med, PAIRED_ROUNDS, 3).withinMax).toBe(false);
    });
    it('negative: empty, unequal, or not divisible into five equal rounds fails and never passes as nothing', () => {
      const { fat, med } = rounds([2.5, 2.5, 2.5, 2.5, 2.5]);
      expect(medianOfRoundRatios([], [], PAIRED_ROUNDS, 3).withinMax).toBe(false);
      expect(medianOfRoundRatios(fat.slice(1), med.slice(1), PAIRED_ROUNDS, 3).withinMax).toBe(false);
      expect(medianOfRoundRatios(fat, med.slice(1), PAIRED_ROUNDS, 3).withinMax).toBe(false);
    });
    it('negative: a round whose denominator measured zero fails; a zero is not a pass', () => {
      const { fat, med } = rounds([2.5, 2.5, 2.5, 2.5, 2.5]);
      const zeroed = med.map((x, i) => (i < PER_ROUND ? 0 : x));
      expect(medianOfRoundRatios(fat, zeroed, PAIRED_ROUNDS, 3).withinMax).toBe(false);
    });
  });

  describe('the suite is wired to the paired helper (a text law, which proves writing, not behaviour)', () => {
    const src = readFileSync(join(__dirname, '..', 'tests', 'performance', 'receivables-s4-budgets.test.ts'), 'utf8');
    it('positive: the ratio denominator comes from the paired measurement and its fingerprint is asserted', () => {
      expect(src).toContain('measurePairedReceivable(');
      expect(src).toContain('fingerprintProblems(');
      expect(src).toContain('ratioVerdict(');
      expect(src).toContain('medianOfRoundRatios(');
    });
    it('negative: the gate no longer judges the single whole-run quotient', () => {
      expect(src).not.toMatch(/must\(ratio\),\s+`P4-AL-72/);
    });
    it('negative: the denominator is no longer a second, consecutive `measure(` series', () => {
      expect(src).not.toMatch(/medianReceivable = await measure\(/);
    });
  });
});
