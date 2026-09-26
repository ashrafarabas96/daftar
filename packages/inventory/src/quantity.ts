/**
 * Quantity precision is exact representability at the product's frozen
 * `unit_decimals`, tested on the VALUE and never on a declared scale
 * (P3-AL-05; PHASE_3_S2_CONTRACT §2.5 R2 and §4).
 *
 *   abs(qty) = trunc(abs(qty), unit_decimals)
 *
 * In Q4 that is: `abs(q4)` is a multiple of `10^(4 - unit_decimals)`. It is
 * stated on the absolute value, so `+3.0000` and `-3.0000` obey one law.
 */
import { InventoryError } from './errors';

/** 10^(4 - d) for d = 0..4 — the Q4 step of a quantity with d decimals. */
const Q4_STEP: readonly bigint[] = [10000n, 1000n, 100n, 10n, 1n];

/** Whether a Q4 quantity is exactly representable with `unitDecimals` decimals; `unitDecimals` outside 0..4 is `inventory.unit_decimals_invalid`. */
export function isQuantityRepresentable(q4: bigint, unitDecimals: number): boolean {
  const step = Number.isInteger(unitDecimals) ? Q4_STEP[unitDecimals] : undefined;
  if (step === undefined) throw new InventoryError('inventory.unit_decimals_invalid', 'unit_decimals must be an integer from 0 to 4');
  return (q4 < 0n ? -q4 : q4) % step === 0n;
}

/** Throws `inventory.quantity_precision_invalid` when the quantity is not representable at `unitDecimals`. */
export function assertQuantityRepresentable(q4: bigint, unitDecimals: number): void {
  if (!isQuantityRepresentable(q4, unitDecimals)) {
    throw new InventoryError('inventory.quantity_precision_invalid', 'quantity is not representable at the product unit precision');
  }
}
