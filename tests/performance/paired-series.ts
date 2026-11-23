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
 * DR-175 — THE MEDIAN OF FIVE PAIRED ROUNDS. Pairing alone did not settle it:
 * measured on two heads that BOTH carry the pairing, the same gate read
 * `2.644` on `3c61ace8` and `3.023` on `fe9f78e8` (19.816 ms over 6.553 ms,
 * step 25 of run `44197016914`) — a 0.8% miss that failed a cart whose own
 * change was a dependency audit. So the ratio is now read FIVE times, each
 * read a complete paired round, and the gate judges the MEDIAN of the five.
 *
 * AND A CLAIM THIS FILE USED TO CARRY IS WITHDRAWN, not reworded. «The cart
 * that missed by 0.8% now passes» was never measured: the median of five has
 * never been read on `fe9f78e8`, that cart's own head. What IS measured is two
 * passing readings on OTHER heads — `[2.72, 2.586, 2.771, 2.816, 3.122]` with
 * median `2.771` (run `45068342721`) and `[2.728, 2.789, 2.815, 2.775, 2.814]`
 * with median `2.789` (run `45174469563`) — and those show the gate passing on
 * a real runner, not that it rescues that cart.
 *
 * WORSE, AND SAID HERE BECAUSE IT CUTS AGAINST THIS CHANGE: the ratio DRIFTS
 * UPWARD as a measurement proceeds. A different five-round implementation, on
 * `50ff72bb`, splits ONE pair of series into five ordered blocks and printed
 * `[1.824, 2.334, 3.028, 3.297, 3.523]` — a monotone ramp inside a single
 * measurement, which is a property of the workload and not of that
 * implementation. Rounds 2..5 here are measured LATER than round 1, so this
 * median is biased UPWARD relative to a single early round: the gate becomes
 * STRICTER, not looser. That is the opposite of a disguised relaxation, and it
 * is also the reason the withdrawn claim cannot be assumed.
 *
 * WHAT DR-175 DOES NOT CHANGE, and each of these is asserted, not promised:
 * the limit (3, `EXPECTED_RATIO_MAX`, and `ratioLimitProblems` reddens if the
 * ratchet ever disagrees), the samples per side per round (200), the
 * percentile (`p95(200)` is index 190, pinned in
 * `tests/guards/accounting-budget-percentile-semantics.test.ts`), and the
 * pair's alternation — which is now checked for EVERY round, not once.
 *
 * THE WARM-UP IS UNCHANGED TOO — and it is the one item on that list that NO
 * LAW ASSERTS, which is why it is named apart rather than beside the others.
 * `WARMUP` is defined once (`receivables-s4-budgets.test.ts:216`) and every
 * series takes it from that one constant, so it is held constant by SHARING A
 * CONSTANT: a code property. It has ZERO hits in `tests-unit/` and in
 * `tests/guards/`, measured — so listing it beside the limit and the
 * percentile under «asserted, not promised» claimed a pin that does not
 * exist, which is the exact failure this header was written to prevent,
 * committed in this header. The CLAIM is withdrawn; the warm-up itself is
 * still there, still shared, and still unchanged by DR-175. Dropping the
 * mention would have traded a false claim for a missing fact.
 *
 * AND WHAT IT DOES CHANGE, said here because a remedy that is quiet about its
 * own cost is the thing this project calls a disguised relaxation: a median of
 * five DISCARDS THE TWO EXTREMES. One hostile round no longer fails the gate;
 * three of five must miss for the verdict to miss. That is a deliberate trade
 * of sensitivity-to-one-round for independence-from-one-host, and it is the
 * owner's decision (DR-175), not this file's. What survives is the direction
 * the gate exists for: a read that is genuinely growing misses in every round,
 * so the median misses — `medianRatioVerdict` is pinned on exactly that in
 * `tests-unit/paired-series-law.test.ts`, including the arm where three of
 * five miss and the arm where one does.
 *
 * NOT RUN HERE: the 200-sample Postgres arm is CI-Linux-only. Its planted-delay
 * negative control needs a knob in `ci.yml`, which lane L2 owns — and measured
 * 2026-11-22, the two CI steps NAMED «Ratio negative control … P4-AL-72»
 * filter on `-t 'P4-AL-72, OD-P4-14'`, which is ANOTHER test's title, so THIS
 * gate has no red control in CI and did not have one before DR-175 either.
 * The unit arms cover the logic, and they are what holds the median honest
 * until that knob exists.
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

/** DR-175: how many complete paired rounds the verdict is the median of. */
export const MEDIAN_ROUNDS = 5;

export interface MedianRatioVerdict {
  /** Every round's ratio, in the order measured; a `null` is a round that produced none. */
  readonly ratios: readonly (number | null)[];
  /** The median of the rounds, or `null` if the rounds cannot yield one. */
  readonly median: number | null;
  readonly withinMax: boolean;
  /** Why this reading cannot be judged at all. Empty = it can. */
  readonly problems: readonly string[];
}

/**
 * The median of the rounds' ratios against `max`. FAILS CLOSED on every shape
 * that is not five readable ratios: a missing round, a round whose series was
 * empty, a zero denominator. None of those is a pass, and none of them is
 * silently dropped to make the median easier — a median taken over the rounds
 * that happened to work would be exactly the quiet relaxation this file
 * refuses.
 */
/**
 * The declared round count is `MEDIAN_ROUNDS` and NOTHING a caller passes can
 * change it. It used to be a third parameter defaulting to `MEDIAN_ROUNDS`,
 * and the independent review of this branch named what that bought: a call of
 * `medianRatioVerdict(rounds, max, rounds.length)` keeps every arm green,
 * removes the count check entirely, and leaves the printed message still
 * saying «the MEDIAN of 5 … rounds» — headroom widened at the same printed
 * number, which is the one shape this gate exists to refuse. The parameter is
 * gone, and an arm passes a third argument through a loosened type to prove
 * that no argument can buy the pass.
 */
export function medianRatioVerdict(rounds: readonly RatioVerdict[], max: number): MedianRatioVerdict {
  const expectedRounds = MEDIAN_ROUNDS;
  const ratios = rounds.map((r) => r.ratio);
  const problems: string[] = [];
  if (rounds.length !== expectedRounds) {
    problems.push(`${rounds.length} paired rounds were measured and ${expectedRounds} were declared (DR-175)`);
  }
  const missing = ratios.filter((r) => r === null).length;
  if (missing > 0)
    problems.push(`${missing} of ${rounds.length} rounds produced no ratio: an empty series or a zero denominator is a FAIL, never a dropped sample`);
  if (problems.length > 0) return { ratios, median: null, withinMax: false, problems };
  const sorted = [...(ratios as number[])].sort((a, b) => a - b);
  // An odd count has a true middle; an even one takes the mean of the two
  // middles, which is the ordinary definition and not a choice in our favour.
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { ratios, median, withinMax: median <= max, problems: [] };
}

/** Why the ratchet's declaration of the ratio is not the one this arm was accepted under. */
export function ratioLimitProblems(r: { readonly max: number; readonly provisional: boolean }): string[] {
  const problems: string[] = [];
  if (r.max !== EXPECTED_RATIO_MAX) problems.push(`the ratio limit is ${r.max}, not ${EXPECTED_RATIO_MAX}`);
  if (r.provisional !== false) problems.push('the ratio is declared provisional');
  return problems;
}
