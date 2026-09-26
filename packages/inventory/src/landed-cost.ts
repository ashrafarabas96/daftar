/**
 * Purchase arithmetic in transaction minor units (PHASE_3_S4_CONTRACT A-13
 * steps 1–5; L:775-791).
 *
 * Every amount here is an exact integer of the purchase currency's minor
 * unit, until the single conversion to base (step 6), which is
 * `@daftar/accounting`'s `convertToBaseMinor` and not this package's.
 *
 * 1. `gross_i = HALF_EVEN(qty_i × unit_price_i, 0)`: a Q4 quantity times a
 *    C10 unit price (C10 of a txn MINOR unit) is 10^-14 minor units, rounded
 *    once to an integer.
 * 2. `net_i = gross_i − discount_i`, with `0 ≤ discount_i ≤ gross_i`, else
 *    `purchase.discount_invalid`.
 * 3. Each landed cost k is allocated on its own:
 *    - `by_value`: `alloc_{k,i} = LR(amount_k; weights net_i)`, ties to the
 *      lower `line_no` — the largest remainder of `allocation.ts`, the twin of
 *      `inventory_largest_remainder`. `Σ net_i = 0` is
 *      `purchase.landed_cost_denominator_zero`; there is no equal split;
 *    - `manual`: one non-negative amount per line whose sum is the amount
 *      EXACTLY, else `purchase.landed_cost_allocation_mismatch` — a single
 *      minor unit off refuses (P:212).
 * 4. `t_i = net_i + Σ_k alloc_{k,i}`.
 * 5. `T = Σ t_i + tax (= 0)`; `T = 0` is `purchase.total_zero` (TL-8).
 *
 * BigInt only; nothing passes through binary floating point.
 */
import { largestRemainder } from './allocation';
import { InventoryError, type InventoryErrorCode } from './errors';
import { COST_LIMIT_C10, QTY_LIMIT_Q4, VALUE_LIMIT_MINOR } from './fixed-point';
import { roundHalfEven } from './rounding';

export type LandedCostMode = 'by_value' | 'manual';

export const LANDED_COST_MODES: readonly LandedCostMode[] = ['by_value', 'manual'];

/** A purchase has at most ten landed costs (A-19). */
export const MAX_LANDED_COSTS = 10;

/** Q4 × C10 = 10^-14 minor units. */
const Q4_TIMES_C10 = 10n ** 14n;

function refuse(code: InventoryErrorCode, message: string): never {
  throw new InventoryError(code, message);
}

function isBigint(v: unknown): v is bigint {
  return typeof v === 'bigint';
}

/** One purchase line's financial inputs, in `line_no` order. */
export interface PurchaseLineInput {
  /** Quantity in Q4; > 0. */
  readonly qtyQ4: bigint;
  /** Unit price as the C10 of a txn MINOR unit; >= 0. */
  readonly unitPriceC10: bigint;
  /** Discount in txn minor units; 0..gross. */
  readonly discountMinor: bigint;
}

/** One landed cost: a positive amount and, for `manual`, one allocation per line in line order. */
export interface LandedCostInput {
  readonly mode: LandedCostMode;
  readonly amountMinor: bigint;
  /** `manual`: exactly one amount per line; `by_value`: null. */
  readonly allocations: readonly bigint[] | null;
}

/** Step 1: `HALF_EVEN(qty × unit_price, 0)`, in txn minor units. */
export function lineGross(qtyQ4: bigint, unitPriceC10: bigint): bigint {
  if (!isBigint(qtyQ4) || qtyQ4 <= 0n || qtyQ4 >= QTY_LIMIT_Q4) refuse('inventory.quantity_invalid', 'a purchase quantity must be positive and within range');
  if (!isBigint(unitPriceC10) || unitPriceC10 < 0n || unitPriceC10 >= COST_LIMIT_C10) {
    refuse('inventory.cost_invalid', 'a unit price must be non-negative and within range');
  }
  return roundHalfEven(qtyQ4 * unitPriceC10, Q4_TIMES_C10);
}

/** Step 2: `gross − discount`, the discount within `0..gross`. */
export function lineNet(grossMinor: bigint, discountMinor: bigint): bigint {
  if (!isBigint(discountMinor) || discountMinor < 0n || discountMinor > grossMinor) {
    refuse('purchase.discount_invalid', 'a line discount must be between zero and the line gross');
  }
  return grossMinor - discountMinor;
}

/**
 * Step 3, `by_value`: the amount split over the line nets by largest
 * remainder, ties to the lower line. A zero denominator is refused: there is
 * no equal split to fall back on (A-13).
 */
export function allocateByValue(amountMinor: bigint, netsMinor: readonly bigint[]): bigint[] {
  assertLandedAmount(amountMinor);
  if (netsMinor.length === 0) refuse('purchase.landed_cost_invalid', 'a landed cost needs at least one line');
  if (netsMinor.some((n) => !isBigint(n) || n < 0n)) refuse('purchase.landed_cost_invalid', 'a line net must be a non-negative integer');
  if (netsMinor.reduce((a, b) => a + b, 0n) === 0n) {
    refuse('purchase.landed_cost_denominator_zero', 'a by-value landed cost needs lines whose nets are not all zero');
  }
  return largestRemainder(
    netsMinor.map((units) => ({ units, scale: 0 })),
    amountMinor,
  );
}

/**
 * Step 3, `manual`: the supplied allocations, one per line and each >= 0,
 * must add up to the amount exactly. Returned unchanged.
 */
export function validateManual(amountMinor: bigint, allocationsMinor: readonly bigint[], lineCount: number): bigint[] {
  assertLandedAmount(amountMinor);
  if (allocationsMinor.length !== lineCount || lineCount === 0) refuse('purchase.landed_cost_invalid', 'a manual landed cost allocates one amount per line');
  if (allocationsMinor.some((a) => !isBigint(a) || a < 0n)) refuse('purchase.landed_cost_invalid', 'a manual allocation must be a non-negative integer');
  if (allocationsMinor.reduce((a, b) => a + b, 0n) !== amountMinor) {
    refuse('purchase.landed_cost_allocation_mismatch', 'the manual allocations do not add up to the landed cost exactly');
  }
  return [...allocationsMinor];
}

function assertLandedAmount(amountMinor: bigint): void {
  if (!isBigint(amountMinor) || amountMinor <= 0n || amountMinor > VALUE_LIMIT_MINOR) {
    refuse('purchase.landed_cost_invalid', 'a landed cost amount must be a positive integer within range');
  }
}

/** One line's amounts after steps 1–4. */
export interface PurchaseLineTotals {
  readonly grossMinor: bigint;
  readonly discountMinor: bigint;
  readonly netMinor: bigint;
  /** `Σ_k alloc_{k,i}`. */
  readonly landedMinor: bigint;
  /** `t_i = net_i + landed_i`. */
  readonly totalMinor: bigint;
}

/** The whole purchase after steps 1–5, in txn minor units. */
export interface PurchaseTotals {
  readonly lines: readonly PurchaseLineTotals[];
  /** `allocations[k][i]`: landed cost k's share of line i, in line order. */
  readonly allocations: readonly (readonly bigint[])[];
  /** `Σ net_i`. */
  readonly subtotalMinor: bigint;
  /** `Σ_k amount_k`. */
  readonly landedMinor: bigint;
  readonly taxMinor: bigint;
  /** `T = subtotal + landed + tax`. */
  readonly totalMinor: bigint;
}

/**
 * A-13 steps 1–5 over a whole purchase. The tax is carried as an input only so
 * the equation `T = Σ t_i + tax` is the lock's; a non-zero tax is refused
 * before this is ever called (A-12, `purchase.tax_policy_absent`), so here it
 * must be 0.
 */
export function lineTotals(lines: readonly PurchaseLineInput[], landedCosts: readonly LandedCostInput[], taxMinor = 0n): PurchaseTotals {
  if (lines.length === 0) refuse('inventory.lines_required', 'a purchase needs at least one line');
  if (landedCosts.length > MAX_LANDED_COSTS) refuse('purchase.landed_cost_invalid', `a purchase has at most ${MAX_LANDED_COSTS} landed costs`);
  if (taxMinor !== 0n) refuse('inventory.payload_invalid', 'a purchase tax other than zero is not supported (OD-03)');
  const partial = lines.map((l) => {
    const grossMinor = lineGross(l.qtyQ4, l.unitPriceC10);
    return { grossMinor, discountMinor: l.discountMinor, netMinor: lineNet(grossMinor, l.discountMinor) };
  });
  const nets = partial.map((l) => l.netMinor);
  const allocations = landedCosts.map((c) => {
    if (c.mode === 'by_value') {
      if (c.allocations !== null) refuse('purchase.landed_cost_invalid', 'a by-value landed cost carries no allocations');
      return allocateByValue(c.amountMinor, nets);
    }
    if (c.mode === 'manual') {
      if (c.allocations === null) refuse('purchase.landed_cost_invalid', 'a manual landed cost states its allocations');
      return validateManual(c.amountMinor, c.allocations, lines.length);
    }
    return refuse('purchase.landed_cost_invalid', 'a landed cost is by_value or manual');
  });
  const out: PurchaseLineTotals[] = partial.map((l, i) => {
    const landedMinor = allocations.reduce((a, row) => a + (row[i] ?? 0n), 0n);
    return { ...l, landedMinor, totalMinor: l.netMinor + landedMinor };
  });
  const subtotalMinor = nets.reduce((a, b) => a + b, 0n);
  const landedMinor = landedCosts.reduce((a, c) => a + c.amountMinor, 0n);
  const totalMinor = subtotalMinor + landedMinor + taxMinor;
  if (totalMinor !== out.reduce((a, l) => a + l.totalMinor, 0n) + taxMinor) throw new Error('purchase totals do not add up');
  if (totalMinor === 0n) refuse('purchase.total_zero', 'a purchase total must be positive');
  if (totalMinor > VALUE_LIMIT_MINOR) refuse('inventory.value_out_of_range', 'the purchase total is out of range');
  return { lines: out, allocations, subtotalMinor, landedMinor, taxMinor, totalMinor };
}
