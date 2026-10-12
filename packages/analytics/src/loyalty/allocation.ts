/**
 * P13-S6 — ALLOCATING A REDEMPTION ACROSS A SALE'S LINES.
 *
 * THE MEASURED LAW THIS FILE EXISTS TO SATISFY
 * --------------------------------------------
 * The canonical sale primitive enforces, at `93084f8`, in
 * `packages/inventory/src/sale-payloads.ts:317`:
 *
 *   > `if (nets !== input.subtotalTxnMinor - input.discountTxnMinor)`
 *   > `refuse('the line nets must add up to the discounted subtotal exactly');`
 *
 * i.e. **sum(line nets) === subtotal − header discount**, with the header
 * identities above it: `total === subtotal − discount + tax`
 * (`sale-payloads.ts:296-298`), `0 ≤ discount ≤ subtotal`
 * (`sale-payloads.ts:295` plus the non-negative loop at `:286-294`), and a
 * positive total (`sale-payloads.ts:299`, `sale.total_zero`).
 *
 * **What does NOT follow, and is not asserted anywhere in this file.** Nothing
 * pins `subtotalTxnMinor` to the sum of the line GROSSES — the validator sums
 * only the nets and the base shares — so "header discount === sum of line
 * discounts" does not follow from the code and must not be relied on.
 * `P13-LOYALTY-DESIGN §5.6` item 2 records this correction against its own
 * earlier wording: *the earlier wording here, "the header discount must equal
 * the sum of the line discounts", is not what the code says and does not
 * follow from it.* Each line discount is separately bounded by its own gross
 * (`sale_items_discount_ck`), which is a per-line bound and not a sum rule.
 *
 * THE CONSEQUENCE THIS FILE IMPLEMENTS
 * ------------------------------------
 * Because the line nets must add up to the discounted subtotal *exactly*, a
 * redemption worth `V` minor units cannot be taken at the header alone: it
 * must be **split across the sale's lines exactly, with no remainder**. That
 * is a conservation problem with a rounding decision inside it, and
 * `§5.6` item 3 records that PART 83 ruled the conversion *rate* to be
 * merchant configuration and ruled **neither** the rounding mode **nor** the
 * allocation rule.
 *
 * So the policy is a REQUIRED ARGUMENT here and this module exports no
 * default. `§5.6`: *whether the split is pro-rata by line net, or by quantity,
 * or first-line-first, is a policy, and the remainder's destination is part of
 * it.* Picking one silently would be this slice ruling a decision it was told
 * it does not own, and the remainder's destination would be ruled by
 * accident — which is the worse half, because the remainder is money.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is **not** the authoritative discount computation and must not be called
 * as one. `§5.5.2` item 5 and PART 83: *the discount's money value is computed
 * by the sale authority, never supplied by Phase 13 and never supplied by the
 * client*, and Phase 13 *does not compute authoritative financial total*. This
 * is a pure function over a value the authority already holds, written here so
 * the conservation law is executable and testable with no cluster — the same
 * posture `points.ts` takes toward `loyalty_points_balance/3`. It posts
 * nothing, reads no configuration, holds no rate and reads no clock.
 *
 * `bigint` THROUGHOUT
 * -------------------
 * Every money quantity in this file is a `bigint` in minor units and there is
 * no `Number` arithmetic on one anywhere: no `Math.round`, no `Math.floor`, no
 * `/` on a `number`, no `parseFloat`, no `toFixed`. `money.ts:9-13` at
 * `93084f8` — *no JS float ever touches money* — and
 * `receivables-reads.ts:28-31` — *10^18 minor units does not survive the round
 * trip, and `[[no float money]]` is not a style rule*. A float here would
 * produce an off-by-one minor unit, which PART 8 calls a DEFECT by name.
 */

import { refuseLoyalty } from './points';

/**
 * One line of the sale, carrying only what an allocation basis can read.
 *
 * `netTxnMinor` is the line's current net in the sale's own currency — the
 * quantity the validator sums. It is also the line's **absorption capacity**:
 * a line net may not go negative (`sale-payloads.ts:306-312` refuses a
 * negative net), so a line can absorb at most its own net.
 *
 * `qtyQ4` is the quantity in Q4 (qty × 10⁴), the sale payload's own fixed
 * point (`sale-payloads.ts:98`). It is a weight only, never money.
 */
export interface AllocatableLine {
  readonly lineId: string;
  readonly netTxnMinor: bigint;
  readonly qtyQ4: bigint;
}

/**
 * Where the indivisible remainder goes.
 *
 * `V × weight / totalWeight` almost never lands on a whole minor unit for
 * every line at once, so some minor units are left over after the proportional
 * pass. They are **money**, so their destination is part of the unruled policy
 * of `§5.6` and is named here rather than falling out of iteration order.
 */
export type RemainderDestination =
  /** Largest basis weight first — the classic largest-remainder reading. Ties by input order. */
  | 'largest_basis_first'
  /** The first line in the supplied order, to its capacity, then the next. */
  | 'first_line_first'
  /** The last line in the supplied order, to its capacity, then the previous. */
  | 'last_line_first';

/**
 * The allocation policy. REQUIRED, with no default anywhere in this module.
 *
 * `first_line_first` carries no `remainderTo` because it cannot produce a
 * remainder: it is exact greedy consumption of capacity in order, so every
 * minor unit is placed by the basis itself. Giving it a `remainderTo` field
 * would be a required field that is never read, which is how a policy knob
 * comes to be believed in.
 */
export type AllocationPolicy =
  | { readonly basis: 'pro_rata_by_net'; readonly remainderTo: RemainderDestination }
  | { readonly basis: 'by_quantity'; readonly remainderTo: RemainderDestination }
  | { readonly basis: 'first_line_first' };

export interface LineAllocation {
  readonly lineId: string;
  /** What this line absorbs, in minor units. Never greater than the line's net. */
  readonly allocatedMinor: bigint;
  /** The line's net after absorbing it. Never negative, by construction. */
  readonly netAfterMinor: bigint;
}

/**
 * The result.
 *
 * `remainderMinor` is typed as the `bigint` LITERAL `0n`, not as `bigint`.
 * There is no inhabitant of this type carrying a non-zero remainder, so "the
 * remainder is zero" is checked by `tsc` at every construction site and is not
 * a property a reader has to trust the body for. The tests prove it for
 * awkward numbers as well, because a type is not a measurement.
 */
export interface AllocationResult {
  readonly policy: AllocationPolicy;
  readonly lines: readonly LineAllocation[];
  /** `=== V`, asserted before return. */
  readonly totalAllocatedMinor: bigint;
  readonly remainderMinor: 0n;
}

/** What the lines can absorb in total: the sum of their nets. */
export function absorptionCapacityMinor(lines: readonly AllocatableLine[]): bigint {
  let capacity = 0n;
  for (const line of lines) capacity += line.netTxnMinor;
  return capacity;
}

/**
 * Indexed access that narrows instead of asserting.
 *
 * `noUncheckedIndexedAccess` is on and the repository forbids the non-null
 * assertion, which is the right pair of rules: every index below is provably in
 * range (the arrays are built with one entry per line and every loop is bounded
 * by `lines.length`), but "provably" is a claim about today's code, and the
 * assertion would keep suppressing the check after someone changes a bound.
 * This refuses instead, with a 500-class code, because an out-of-range index
 * here means this module is wrong rather than that a caller asked for
 * something impossible.
 */
function atIndex<T>(xs: readonly T[], index: number): T {
  const value = xs[index];
  if (value === undefined) {
    refuseLoyalty('loyalty.allocation_index_out_of_range', 'an allocation indexed a line that is not there', {
      index: String(index),
      length: String(xs.length),
    });
  }
  return value;
}

/**
 * Splits a redemption worth `V` minor units across `lines`, exactly.
 *
 * Guarantees, every one of them by construction and all of them tested:
 *
 * 1. `sum(allocatedMinor) === V`. The remainder is zero and is typed `0n`.
 * 2. `0 ≤ allocatedMinor_i ≤ netTxnMinor_i` for every line, so no line net
 *    goes negative and the primitive's per-line non-negativity still holds.
 * 3. Therefore `sum(netAfterMinor) === sum(netTxnMinor) − V`, which is how the
 *    caller keeps `sale-payloads.ts:317` satisfied: the discounted subtotal
 *    falls by exactly `V` and the nets still add up to it.
 * 4. It is deterministic: the same inputs give byte-identical output, because
 *    every ordering used is a total order over the supplied sequence.
 *
 * It REFUSES rather than rounding a value into existence when `V` exceeds what
 * the lines can absorb. `§5.6`'s own statement of the live reading is that a
 * redemption covering the whole basket is not expressible — the sale total
 * must be positive — and `§5.5.2` item 8 leaves whether that is a refusal, a
 * clamp or a configuration bound to the sale authority, noting that **a clamp
 * in particular is a money computation Phase 13 may not perform**. So this
 * function refuses and clamps nothing.
 */
export function allocateRedemption(valueMinor: bigint, lines: readonly AllocatableLine[], policy: AllocationPolicy): AllocationResult {
  if (typeof valueMinor !== 'bigint') {
    refuseLoyalty('loyalty.allocation_value_invalid', 'a redemption value is integer minor units as a bigint');
  }
  if (valueMinor < 0n) {
    refuseLoyalty('loyalty.allocation_value_invalid', 'a redemption value must not be negative', {
      valueMinor: valueMinor.toString(),
    });
  }
  if (lines.length === 0) {
    refuseLoyalty('loyalty.allocation_no_lines', 'there are no lines to split a redemption across');
  }
  for (const [index, line] of lines.entries()) {
    if (typeof line.netTxnMinor !== 'bigint' || typeof line.qtyQ4 !== 'bigint') {
      refuseLoyalty('loyalty.allocation_value_invalid', `line ${index + 1} must carry bigint net and quantity`, {
        lineId: String(line.lineId),
      });
    }
    if (line.netTxnMinor < 0n) {
      refuseLoyalty('loyalty.allocation_value_invalid', `line ${index + 1} net must not be negative`, {
        lineId: line.lineId,
        netTxnMinor: line.netTxnMinor.toString(),
      });
    }
    if (line.qtyQ4 < 0n) {
      refuseLoyalty('loyalty.allocation_value_invalid', `line ${index + 1} quantity must not be negative`, {
        lineId: line.lineId,
        qtyQ4: line.qtyQ4.toString(),
      });
    }
  }

  const capacity = absorptionCapacityMinor(lines);
  if (valueMinor > capacity) {
    // Refused, not rounded into existence and not clamped. A clamp is a money
    // computation (§5.5.2 item 8) and it would also silently change the
    // redemption the customer was quoted.
    refuseLoyalty('loyalty.allocation_exceeds_capacity', 'the redemption exceeds what the sale lines can absorb', {
      valueMinor: valueMinor.toString(),
      capacityMinor: capacity.toString(),
    });
  }

  const allocated: bigint[] = lines.map(() => 0n);
  const capacityOf = (index: number): bigint => atIndex(lines, index).netTxnMinor;
  const slackOf = (index: number): bigint => capacityOf(index) - atIndex(allocated, index);

  let remaining = valueMinor;

  if (policy.basis === 'first_line_first') {
    // Exact greedy, in the supplied order. No proportional pass, so no
    // remainder can arise: each line takes min(slack, remaining).
    for (let i = 0; i < lines.length && remaining > 0n; i += 1) {
      const take = slackOf(i) < remaining ? slackOf(i) : remaining;
      allocated[i] = atIndex(allocated, i) + take;
      remaining -= take;
    }
  } else {
    const weights = lines.map((line) => (policy.basis === 'pro_rata_by_net' ? line.netTxnMinor : line.qtyQ4));

    /*
     * WATER-FILLING, and why the loop is here rather than a single pass.
     *
     * Under `pro_rata_by_net` the weight IS the capacity, so a floored
     * proportional share can never exceed it. Under `by_quantity` it can: a
     * cheap line with a large quantity draws a share bigger than its own net.
     * A single pass would then have to drop the excess, and a dropped minor
     * unit is PART 8's defect. So the pass is repeated over the lines that
     * still have slack, with the weights of the saturated ones removed, until
     * the value is placed. Each round either places something or places
     * nothing; the first case strictly reduces `remaining`, and the second
     * exits to the remainder phase. Termination is therefore immediate and
     * does not depend on the numbers.
     */
    for (;;) {
      if (remaining === 0n) break;
      let totalWeight = 0n;
      for (let i = 0; i < lines.length; i += 1) {
        if (slackOf(i) > 0n) totalWeight += atIndex(weights, i);
      }
      if (totalWeight === 0n) break;
      const snapshot = remaining;
      let placed = 0n;
      for (let i = 0; i < lines.length; i += 1) {
        const slack = slackOf(i);
        if (slack === 0n) continue;
        // Floor division on non-negative bigints. Exact; no float, no Number.
        const share = (snapshot * atIndex(weights, i)) / totalWeight;
        const take = share > slack ? slack : share;
        if (take === 0n) continue;
        allocated[i] = atIndex(allocated, i) + take;
        placed += take;
      }
      remaining -= placed;
      if (placed === 0n) break;
    }

    /*
     * THE REMAINDER PHASE, and the proof that it always completes.
     *
     * After the proportional rounds the value still unplaced is strictly less
     * than the number of lines that had slack (each such line's floored share
     * lost less than one minor unit), and the slack remaining across all lines
     * is at least that amount: total slack === capacity − placed ≥ V − placed
     * === remaining, because V ≤ capacity was checked above. So a single pass
     * giving one minor unit to each eligible line in the policy's order
     * suffices, and the loop below is written to repeat only so that the
     * `placed === 0n` break above cannot leave a unit stranded. If a pass ever
     * places nothing while `remaining > 0n`, capacity was exhausted — which
     * the `V > capacity` refusal above has already excluded — and the function
     * refuses rather than dropping the unit.
     */
    const order = remainderOrder(lines, weights, policy.remainderTo);
    while (remaining > 0n) {
      let placed = 0n;
      for (const i of order) {
        if (remaining === 0n) break;
        if (slackOf(i) === 0n) continue;
        allocated[i] = atIndex(allocated, i) + 1n;
        remaining -= 1n;
        placed += 1n;
      }
      if (placed === 0n) break;
    }
  }

  if (remaining !== 0n) {
    // Unreachable given `V ≤ capacity`. An unreachable refusal is still better
    // than a silently dropped minor unit: PART 8, one unexplained minor unit
    // is a DEFECT, and this is the only other place one could go.
    refuseLoyalty('loyalty.allocation_remainder_unplaceable', 'the redemption could not be split without a remainder', {
      valueMinor: valueMinor.toString(),
      unplacedMinor: remaining.toString(),
    });
  }

  const result: LineAllocation[] = lines.map((line, index) => ({
    lineId: line.lineId,
    allocatedMinor: atIndex(allocated, index),
    netAfterMinor: line.netTxnMinor - atIndex(allocated, index),
  }));

  // The conservation check, re-derived from the output rather than tracked
  // alongside it, so a bug in the loops above cannot agree with itself.
  let total = 0n;
  for (const line of result) {
    total += line.allocatedMinor;
    if (line.allocatedMinor < 0n || line.netAfterMinor < 0n) {
      refuseLoyalty('loyalty.allocation_remainder_unplaceable', 'an allocation drove a line net negative', {
        lineId: line.lineId,
      });
    }
  }
  if (total !== valueMinor) {
    refuseLoyalty('loyalty.allocation_remainder_unplaceable', 'the allocated total does not equal the redemption', {
      valueMinor: valueMinor.toString(),
      totalAllocatedMinor: total.toString(),
    });
  }

  return { policy, lines: result, totalAllocatedMinor: total, remainderMinor: 0n };
}

/** A total order over the line indices, so the remainder's destination is deterministic. */
function remainderOrder(lines: readonly AllocatableLine[], weights: readonly bigint[], destination: RemainderDestination): readonly number[] {
  const indices = lines.map((_, index) => index);
  switch (destination) {
    case 'first_line_first':
      return indices;
    case 'last_line_first':
      return indices.slice().reverse();
    case 'largest_basis_first':
      // Ties fall to the earlier line, so the order is total and the output is
      // byte-identical across runs — `T2-EXP-ORDER`'s standard, applied here.
      return indices.slice().sort((a, b) => (atIndex(weights, a) > atIndex(weights, b) ? -1 : atIndex(weights, a) < atIndex(weights, b) ? 1 : a - b));
  }
}

/**
 * Re-derives the header identity the caller must still satisfy, from the
 * allocation, so a caller cannot forget which figure moved.
 *
 * `sale-payloads.ts:317` is satisfied when the line nets add up to
 * `subtotal − discount`. A redemption worth `V` therefore raises the header
 * discount by `V` and lowers the total by `V`, while the subtotal and the tax
 * base are the sale authority's own business — this function computes neither
 * a tax nor a total and returns the two figures that the law above constrains,
 * labelled, for the authority to use or to refuse.
 *
 * It is a REPORT of an identity, not an authoritative figure: PART 83 forbids
 * Phase 13 the authoritative financial total and `§5.5.2` item 5 puts the
 * money computation inside the sale's own commit.
 */
export interface RedemptionHeaderEffect {
  /** `sum(netAfterMinor)` — what `sale-payloads.ts:317` will compare against. */
  readonly lineNetsAfterMinor: bigint;
  /** The discounted subtotal the nets must equal: `subtotal − (discount + V)`. */
  readonly discountedSubtotalAfterMinor: bigint;
  /** `true` when the two agree exactly. The only acceptable value. */
  readonly identityHolds: boolean;
}

export function redemptionHeaderEffect(subtotalTxnMinor: bigint, discountTxnMinorBefore: bigint, allocation: AllocationResult): RedemptionHeaderEffect {
  let netsAfter = 0n;
  for (const line of allocation.lines) netsAfter += line.netAfterMinor;
  const discountedSubtotalAfter = subtotalTxnMinor - (discountTxnMinorBefore + allocation.totalAllocatedMinor);
  return {
    lineNetsAfterMinor: netsAfter,
    discountedSubtotalAfterMinor: discountedSubtotalAfter,
    identityHolds: netsAfter === discountedSubtotalAfter,
  };
}
