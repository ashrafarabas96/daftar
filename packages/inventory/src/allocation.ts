/**
 * The inventory opening's valuation: one HALF_EVEN at the document, then a
 * largest-remainder split (PHASE_3_S3_CONTRACT A-13; L:715, L:785, L:1382).
 *
 * - The weight of line i is `w_i = qty_i × cost_i`, exact, never rounded.
 * - The document total is `T = HALF_EVEN(Σ w_i)` in minor units.
 * - The shares are `s_i = floor(T·w_i / W)`, then the residue `T − Σ s_i`
 *   goes one unit at a time to the largest fractional parts, ties to the
 *   lower index (`line_no ASC`). When `W = 0` every share is 0.
 *
 * So `Σ s_i = T` exactly, and each opening movement carries its share as its
 * supplied value. The SQL twin is `inventory_largest_remainder(numeric[],
 * bigint)`, held to this module by `vectors/allocation-vectors.json`.
 *
 * BigInt only: a weight is an `ExactDecimal`, every product and quotient is an
 * integer operation, and nothing here passes through binary floating point.
 */
import { InventoryError } from './errors';
import { COST_LIMIT_C10, QTY_LIMIT_Q4, VALUE_LIMIT_MINOR, type ExactDecimal } from './fixed-point';
import { roundHalfEven } from './rounding';

/** Q4 × C10 = 10^-14 units of minor: the scale of an opening line's exact weight. */
export const OPENING_WEIGHT_SCALE = 14;

function refuse(message: string): never {
  throw new InventoryError('inventory.allocation_invalid', message);
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 64) refuse('a weight scale must be an integer from 0 to 64');
}

/**
 * Splits `total` over `weights` by largest remainder, ties to the lower index.
 *
 * Refused (`inventory.allocation_invalid`): an empty weight list, a negative
 * weight or total, and a non-zero total over weights that sum to zero (no
 * split can then add up to it).
 */
export function largestRemainder(weights: readonly ExactDecimal[], total: bigint): bigint[] {
  if (weights.length === 0) refuse('an allocation needs at least one weight');
  if (typeof total !== 'bigint' || total < 0n) refuse('an allocated total must be a non-negative integer');
  let scale = 0;
  for (const w of weights) {
    if (typeof w.units !== 'bigint' || w.units < 0n) refuse('a weight must be a non-negative exact decimal');
    assertScale(w.scale);
    if (w.scale > scale) scale = w.scale;
  }
  // One common scale, so every weight is an integer of the same unit.
  const units = weights.map((w) => w.units * 10n ** BigInt(scale - w.scale));
  const sum = units.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    if (total !== 0n) refuse('a non-zero total cannot be split over weights that sum to zero');
    return units.map(() => 0n);
  }

  const shares = units.map((u) => (total * u) / sum);
  const remainders = units.map((u) => (total * u) % sum);
  let residue = total - shares.reduce((a, b) => a + b, 0n);
  // 0 <= residue < n, because each floor loses less than one unit.
  const order = units
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a] ?? 0n;
      const rb = remainders[b] ?? 0n;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
  for (const i of order) {
    if (residue === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    residue -= 1n;
  }
  if (residue !== 0n) refuse('the residue exceeded the number of lines');
  return shares;
}

/** One opening line in fixed point: quantity in Q4 (> 0) and unit cost in C10 (>= 0). */
export interface OpeningLineValue {
  readonly qtyQ4: bigint;
  readonly costC10: bigint;
}

/** The exact weight `qty × cost` of an opening line, at scale 14. */
export function openingLineWeight(line: OpeningLineValue): ExactDecimal {
  if (typeof line.qtyQ4 !== 'bigint' || line.qtyQ4 <= 0n || line.qtyQ4 >= QTY_LIMIT_Q4) refuse('an opening quantity must be positive and within range');
  if (typeof line.costC10 !== 'bigint' || line.costC10 < 0n || line.costC10 >= COST_LIMIT_C10)
    refuse('an opening unit cost must be non-negative and within range');
  return { units: line.qtyQ4 * line.costC10, scale: OPENING_WEIGHT_SCALE };
}

/** `T = HALF_EVEN(Σ qty × cost)` in minor units — the one rounding of an opening document. */
export function openingDocumentTotal(lines: readonly OpeningLineValue[]): bigint {
  if (lines.length === 0) refuse('an opening needs at least one line');
  const w = lines.reduce((acc, l) => acc + openingLineWeight(l).units, 0n);
  const total = roundHalfEven(w, 10n ** BigInt(OPENING_WEIGHT_SCALE));
  if (total > VALUE_LIMIT_MINOR) throw new InventoryError('inventory.value_out_of_range', 'the opening total is out of range');
  return total;
}

/** The whole opening valuation: the document total and each line's share, in line order; `Σ shares = total`. */
export function allocateOpening(lines: readonly OpeningLineValue[]): { readonly total: bigint; readonly shares: readonly bigint[] } {
  const total = openingDocumentTotal(lines);
  return { total, shares: largestRemainder(lines.map(openingLineWeight), total) };
}

/**
 * Case B (A-13): stock may only be decomposed against an opening position
 * that holds exactly its total. Refused with both totals in the typed
 * details — never in the message.
 */
export function assertOpeningMatchesPosition(stockTotalMinor: bigint, openingPositionMinor: bigint): void {
  if (stockTotalMinor !== openingPositionMinor) {
    throw new InventoryError('inventory.opening_valuation_mismatch', 'the opening stock total does not equal the opening position', {
      stockTotalMinor: stockTotalMinor.toString(10),
      openingPositionMinor: openingPositionMinor.toString(10),
    });
  }
}
