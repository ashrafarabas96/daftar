/**
 * The receipt's base split (PHASE_3_S4_CONTRACT A-13 steps 7–8).
 *
 * The purchase total T is converted to base ONCE, `B = convert(T)`, by
 * `@daftar/accounting`'s `convertToBaseMinor` (the 0043 law) — that
 * conversion is not this package's, which imports nothing but itself, so B
 * is an INPUT here. B is then split over the line totals `t_i` by largest
 * remainder, ties to the lower `line_no`, so `Σ s_i = B` exactly: the AP line
 * and the Inventory line carry the same B and no rounding or variance line
 * (6100, 6200) is ever needed (P:207, L:1384).
 *
 * Each line's purchase movement then carries `s_i` as its supplied value and
 * `HALF_EVEN(s_i / qty_i, 10)` as its unit-cost snapshot (R3), which is also
 * the ACTUAL cost a deficit coverage uses (A-16(c)).
 */
import { largestRemainder } from './allocation';
import { InventoryError } from './errors';
import { QTY_LIMIT_Q4, VALUE_LIMIT_MINOR } from './fixed-point';
import { averageUnitCost } from './valuation';

/** Step 7: `s_i = LR(B; weights t_i)`, ties to the lower line; `Σ s_i = B`. */
export function baseShares(baseTotalMinor: bigint, lineTotalsMinor: readonly bigint[]): bigint[] {
  if (typeof baseTotalMinor !== 'bigint' || baseTotalMinor <= 0n || baseTotalMinor > VALUE_LIMIT_MINOR) {
    throw new InventoryError('purchase.total_zero', 'a purchase base total must be positive and within range');
  }
  if (lineTotalsMinor.length === 0) throw new InventoryError('inventory.lines_required', 'a purchase needs at least one line');
  if (lineTotalsMinor.some((t) => typeof t !== 'bigint' || t < 0n)) {
    throw new InventoryError('inventory.allocation_invalid', 'a line total must be a non-negative integer');
  }
  if (lineTotalsMinor.reduce((a, b) => a + b, 0n) === 0n) throw new InventoryError('purchase.total_zero', 'a purchase total must be positive');
  return largestRemainder(
    lineTotalsMinor.map((units) => ({ units, scale: 0 })),
    baseTotalMinor,
  );
}

/** Step 8: the unit-cost snapshot `HALF_EVEN(s / qty, 10)` in C10, from a base share and a Q4 quantity. */
export function unitCostC10(baseShareMinor: bigint, qtyQ4: bigint): bigint {
  if (typeof qtyQ4 !== 'bigint' || qtyQ4 <= 0n || qtyQ4 >= QTY_LIMIT_Q4)
    throw new InventoryError('inventory.quantity_invalid', 'a purchase quantity must be positive');
  if (typeof baseShareMinor !== 'bigint' || baseShareMinor < 0n || baseShareMinor > VALUE_LIMIT_MINOR) {
    throw new InventoryError('inventory.value_out_of_range', 'a base share must be a non-negative integer within range');
  }
  const avg = averageUnitCost(baseShareMinor, qtyQ4, null);
  if (avg === null) throw new InventoryError('inventory.arithmetic_invalid', 'no unit cost for a zero quantity');
  return avg;
}
