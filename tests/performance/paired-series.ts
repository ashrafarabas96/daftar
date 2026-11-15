/**
 * THE PAIRED MEASUREMENT OF `P4-AL-72`'s RATIO, SEPARATED SO IT CAN BE TESTED.
 *
 * The ratio is p95(fat-tail) / p95(median), each over its own 200 samples. It
 * used to be taken from two CONSECUTIVE series, so a phase change of the host
 * between the two (measured: the denominator moved 1.99x across seven runs
 * while the numerator moved 1.59x) became a change in the quotient. The pair
 * is now read on the SAME iteration loop, and the order inside each pair
 * alternates so neither side is always first.
 *
 * What this does NOT change: the limit, the sample count (200 per side), the
 * warm-up, the percentile (`percentile.ts`) or what the arm accepts.
 *
 * THE MEASUREMENT THIS RESTS ON (CI run id: fat-tail p95 / median p95 = ratio,
 * ms; the seven readable `RATIO — P4-D fat-tail over median` lines of step 25
 * of `backend-work`, read from each job log with a grep, none of them empty):
 *   43676171046 (FAILED)  15.063 / 4.666 = 3.228
 *   43661612247 (FAILED)  16.508 / 5.073 = 3.254
 *   43667347473           15.577 / 6.331 = 2.461
 *   43667335514           16.891 / 6.986 = 2.418
 *   43662919564           17.797 / 8.058 = 2.209
 *   43667555629           18.764 / 8.228 = 2.280
 *   43639495189 (main)    23.949 / 9.279 = 2.581
 * Denominator spread 9.279/4.666 = 1.99x; numerator spread 23.949/15.063 =
 * 1.59x; the two failures are the two smallest denominators while their
 * numerators are not elevated. n = 7: this is a reading, not a proof.
 *
 * ACCEPTANCE (e): after this lands, publish the new CI values and compare the
 * denominator spread with 1.99x. If it does not narrow, the diagnosis was
 * wrong and the remedy is NOT declared successful.
 *
 * NOT RUN: the 200-sample Postgres arm (CI Linux only) and its planted-delay
 * negative control (needs a new knob in `ci.yml`, owned by lane L2). The unit
 * arms in `tests-unit/paired-series-law.test.ts` cover the logic only.
 */
import { quantile } from './percentile';

/** `F` = the fat-tail read, `M` = the median read. */
export type PairSide = 'F' | 'M';

/** The ratio's limit as the ratchet declares it today; a change is the owner's decision. */
export const EXPECTED_RATIO_MAX = 3;

/** The order of the two reads inside iteration `iteration`: the first side alternates. */
export function pairOrder(iteration: number): readonly [PairSide, PairSide] {
  return iteration % 2 === 0 ? ['F', 'M'] : ['M', 'F'];
}

export function fingerprintOf(order: readonly PairSide[]): string {
  return order.join('');
}

/**
 * Why a recorded read order is NOT the paired alternation. Empty list = it is.
 * An empty fingerprint is a problem, never a pass.
 */
export function fingerprintProblems(order: readonly PairSide[], iterationsPerSide: number): string[] {
  const problems: string[] = [];
  if (order.length === 0) return ['the order fingerprint is empty: nothing was recorded, so nothing was paired'];
  if (order.length !== 2 * iterationsPerSide) {
    problems.push(`the fingerprint holds ${order.length} reads and ${2 * iterationsPerSide} were declared (${iterationsPerSide} per side)`);
  }
  if (order.some((s) => s !== 'F' && s !== 'M')) problems.push('the fingerprint holds a symbol that is neither F nor M');
  const count = (side: PairSide): number => order.filter((s) => s === side).length;
  if (count('F') !== iterationsPerSide || count('M') !== iterationsPerSide) {
    problems.push(`the sides are not balanced: F=${count('F')} M=${count('M')} of ${iterationsPerSide} each`);
  }
  let run = 1;
  let longest = 1;
  for (let i = 1; i < order.length; i += 1) {
    run = order[i] === order[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  // FM|MF puts at most two equal reads side by side; AAA..BBB is a run of the whole series.
  if (longest > 2) problems.push(`the longest run of one side is ${longest} reads; a paired alternation never exceeds 2`);
  let fatFirst = 0;
  let mixedPairs = 0;
  for (let i = 0; i + 1 < order.length; i += 2) {
    if (order[i] !== order[i + 1]) mixedPairs += 1;
    if (order[i] === 'F') fatFirst += 1;
  }
  if (mixedPairs !== Math.floor(order.length / 2)) problems.push('some iteration did not read both sides exactly once');
  if (Math.abs(fatFirst - (order.length / 2 - fatFirst)) > 1) {
    problems.push(`the order inside the pair does not alternate: the fat-tail read was first in ${fatFirst} of ${order.length / 2} iterations`);
  }
  return problems;
}

export interface RatioVerdict {
  readonly fatP95: number | null;
  readonly medP95: number | null;
  readonly ratio: number | null;
  readonly withinMax: boolean;
}

/** p95/p95 against `max`. An empty series or a zero denominator is a FAIL, never a pass. */
export function ratioVerdict(fat: readonly number[], med: readonly number[], max: number): RatioVerdict {
  if (fat.length === 0 || med.length === 0) return { fatP95: null, medP95: null, ratio: null, withinMax: false };
  const fatP95 = quantile(fat, 0.95);
  const medP95 = quantile(med, 0.95);
  const ratio = medP95 === 0 ? null : fatP95 / medP95;
  return { fatP95, medP95, ratio, withinMax: ratio !== null && ratio <= max };
}

/** Why the ratchet's declaration of the ratio is not the one this arm was accepted under. */
export function ratioLimitProblems(r: { readonly max: number; readonly provisional: boolean }): string[] {
  const problems: string[] = [];
  if (r.max !== EXPECTED_RATIO_MAX) problems.push(`the ratio limit is ${r.max}, not ${EXPECTED_RATIO_MAX}`);
  if (r.provisional !== false) problems.push('the ratio is declared provisional');
  return problems;
}
