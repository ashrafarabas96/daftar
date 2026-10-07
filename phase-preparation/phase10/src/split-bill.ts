/**
 * Phase 10 — split bill arithmetic. PREPARED / NOT PROMOTED.
 *
 * LAW 4 (P10-SCOPE-AND-LAWS.md): every split conserves the original total to
 * the minor unit. A split that cannot conserve is refused, never normalized.
 *
 * Money here is `bigint` minor units, matching `packages/domain-core/src/money.ts`.
 * No Number, no float, no division that discards a remainder silently.
 *
 * This module is pure. It touches no database, posts nothing, and knows nothing
 * about invoices — it answers one question: given a total, what are the parts?
 */

export type SplitRefusalCode =
  /** The caller asked for fewer than one part. */
  | 'restaurant.split.parts_not_positive'
  /** The total is negative; a bill total is never negative (a refund is a different command). */
  | 'restaurant.split.total_negative'
  /** An explicit-amount split whose parts do not sum to the total. */
  | 'restaurant.split.amounts_do_not_conserve'
  /** An explicit-amount split containing a negative part. */
  | 'restaurant.split.amount_negative'
  /** A by-line split that left a line unassigned or assigned it twice. */
  | 'restaurant.split.line_assignment_not_a_partition'
  /** A by-line split that produced an empty bill. */
  | 'restaurant.split.empty_bill';

export class SplitRefusal extends Error {
  constructor(
    readonly code: SplitRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SplitRefusal';
  }
}

/**
 * Split `totalMinor` into `parts` shares that sum to it exactly.
 *
 * The remainder is distributed one minor unit at a time to the FIRST `remainder`
 * shares, in index order. That rule is deterministic and stated, so two callers
 * splitting the same bill get the same answer and the receipt can explain why
 * share 1 is one fils larger than share 3.
 *
 * Returned shares therefore differ by at most one minor unit.
 */
export function splitEvenly(totalMinor: bigint, parts: number): readonly bigint[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new SplitRefusal('restaurant.split.parts_not_positive', `A bill splits into at least one part, not ${parts}`, { parts });
  }
  if (totalMinor < 0n) {
    throw new SplitRefusal('restaurant.split.total_negative', `A bill total is never negative: ${totalMinor}`, { totalMinor: totalMinor.toString() });
  }
  const n = BigInt(parts);
  const base = totalMinor / n;
  const remainder = totalMinor - base * n; // exact; never a float modulo
  const shares: bigint[] = [];
  for (let i = 0n; i < n; i += 1n) {
    shares.push(i < remainder ? base + 1n : base);
  }
  return shares;
}

/**
 * Accept an explicit-amount split only when it conserves exactly.
 *
 * This is the mode a waiter uses when guests say "I'll put 20 on mine". It is a
 * SETTLEMENT split, not a sale split: the bill stays one sale and the amounts
 * become several payments against it, which the Phase 4 payment/allocation
 * authority already supports. Splitting a sale into several sales is only
 * possible by LINE (`splitByLines`), because a sale is made of lines, not of
 * an arbitrary amount.
 */
export function assertAmountsConserve(totalMinor: bigint, amountsMinor: readonly bigint[]): void {
  if (totalMinor < 0n) {
    throw new SplitRefusal('restaurant.split.total_negative', `A bill total is never negative: ${totalMinor}`, { totalMinor: totalMinor.toString() });
  }
  if (amountsMinor.length < 1) {
    throw new SplitRefusal('restaurant.split.parts_not_positive', 'An amount split needs at least one amount', { parts: amountsMinor.length });
  }
  let sum = 0n;
  for (const [index, amount] of amountsMinor.entries()) {
    if (amount < 0n) {
      throw new SplitRefusal('restaurant.split.amount_negative', `Amount ${index} is negative: ${amount}`, { index, amount: amount.toString() });
    }
    sum += amount;
  }
  if (sum !== totalMinor) {
    throw new SplitRefusal('restaurant.split.amounts_do_not_conserve', `Amounts sum to ${sum} but the bill total is ${totalMinor}`, {
      sum: sum.toString(),
      totalMinor: totalMinor.toString(),
      differenceMinor: (totalMinor - sum).toString(),
    });
  }
}

export interface SplittableLine {
  readonly lineId: string;
  /** Line total in minor units, as the sale authority computed it. Never recomputed here. */
  readonly lineTotalMinor: bigint;
}

export interface LineSplitBill {
  readonly billIndex: number;
  readonly lineIds: readonly string[];
  readonly subtotalMinor: bigint;
}

/**
 * Split a bill by moving whole lines onto separate bills.
 *
 * `assignment` maps a lineId to a bill index. It must be a PARTITION of the
 * lines: every line assigned exactly once, no unknown line, no empty bill.
 * Anything else is refused — an unassigned line is a line nobody pays for, and
 * that is how a restaurant loses money quietly.
 */
export function splitByLines(lines: readonly SplittableLine[], assignment: ReadonlyMap<string, number>): readonly LineSplitBill[] {
  const seen = new Set<string>();
  const buckets = new Map<number, { lineIds: string[]; subtotalMinor: bigint }>();

  for (const line of lines) {
    const billIndex = assignment.get(line.lineId);
    if (billIndex === undefined) {
      throw new SplitRefusal('restaurant.split.line_assignment_not_a_partition', `Line ${line.lineId} is on no bill`, {
        lineId: line.lineId,
        reason: 'unassigned',
      });
    }
    if (!Number.isSafeInteger(billIndex) || billIndex < 0) {
      throw new SplitRefusal('restaurant.split.line_assignment_not_a_partition', `Line ${line.lineId} has a non-index bill ${String(billIndex)}`, {
        lineId: line.lineId,
        billIndex,
      });
    }
    seen.add(line.lineId);
    const bucket = buckets.get(billIndex) ?? { lineIds: [], subtotalMinor: 0n };
    bucket.lineIds.push(line.lineId);
    bucket.subtotalMinor += line.lineTotalMinor;
    buckets.set(billIndex, bucket);
  }

  for (const lineId of assignment.keys()) {
    if (!seen.has(lineId)) {
      throw new SplitRefusal('restaurant.split.line_assignment_not_a_partition', `Assignment names line ${lineId}, which is not on this bill`, {
        lineId,
        reason: 'unknown_line',
      });
    }
  }
  if (buckets.size === 0) {
    throw new SplitRefusal('restaurant.split.empty_bill', 'A split produced no bill at all', {});
  }

  const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  return ordered.map(([billIndex, bucket]) => {
    if (bucket.lineIds.length === 0) {
      throw new SplitRefusal('restaurant.split.empty_bill', `Bill ${billIndex} has no line`, { billIndex });
    }
    return Object.freeze({ billIndex, lineIds: Object.freeze([...bucket.lineIds]), subtotalMinor: bucket.subtotalMinor });
  });
}
