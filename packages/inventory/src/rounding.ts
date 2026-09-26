/**
 * The one rounding boundary: HALF_EVEN, exact and sign-symmetric
 * (P3-AL-08; P3-AL-49 §C; PHASE_3_S2_CONTRACT §2.5 R1 and §4).
 *
 * This generalizes the positive-only HALF_EVEN of
 * `packages/accounting/src/fx.ts` to signed operands. The rule is applied to
 * the magnitudes and the sign is restored afterwards, so
 * `roundHalfEven(-n, d) === -roundHalfEven(n, d)`: a tie always goes to the
 * even neighbour, never "up" and never "toward +∞". PostgreSQL's `round()` is
 * HALF_UP (away from zero), which is why neither side ever calls it; the SQL
 * twin `inventory_half_even` is the same algorithm in `NUMERIC`.
 */
import { InventoryError } from './errors';
import type { ExactDecimal } from './fixed-point';

function refuseArithmetic(message: string): never {
  throw new InventoryError('inventory.arithmetic_invalid', message);
}

function pow10(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) refuseArithmetic('decimal scale must be a non-negative integer');
  return 10n ** BigInt(exponent);
}

/**
 * `numerator / denominator` rounded HALF_EVEN to an integer, exactly.
 * A zero denominator is `inventory.arithmetic_invalid`.
 */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) refuseArithmetic('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  // Both operands are non-negative here, so bigint division is floor — the
  // same quotient PostgreSQL's div() returns for them.
  let q = n / d;
  const twice = 2n * (n - q * d);
  if (twice > d || (twice === d && q % 2n !== 0n)) q += 1n;
  return negative ? -q : q;
}

/**
 * `n / d` rounded HALF_EVEN to `scale` fraction digits, exactly — the TypeScript
 * twin of `inventory_half_even(p_numerator, p_denominator, p_scale)`. Only the
 * two scales the lock uses exist: 0 (values) and 10 (costs and averages).
 */
export function roundHalfEvenDecimal(n: ExactDecimal, d: ExactDecimal, scale: 0 | 10): ExactDecimal {
  if (scale !== 0 && scale !== 10) refuseArithmetic('rounding scale must be 0 or 10');
  // n.units·10^-ns / (d.units·10^-ds) · 10^scale  =  (n.units · 10^(ds+scale)) / (d.units · 10^ns)
  const units = roundHalfEven(n.units * pow10(d.scale) * pow10(scale), d.units * pow10(n.scale));
  return { units, scale };
}
