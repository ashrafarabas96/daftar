import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import { roundHalfEven, roundHalfEvenDecimal } from '../src/rounding';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return undefined;
}

/**
 * An independent oracle: the integer k nearest to n/d, found by comparing
 * |n − k·d| for the two candidates around the exact quotient, ties to even.
 * It uses floor division (not truncation), so it shares no step with the
 * implementation's magnitude-then-sign approach.
 */
function nearestEven(n: bigint, d: bigint): bigint {
  const floorDiv = (a: bigint, b: bigint): bigint => {
    const q = a / b;
    return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
  };
  const lo = floorDiv(n, d);
  const hi = lo + 1n;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const dLo = abs(n - lo * d);
  const dHi = abs(n - hi * d);
  if (dLo < dHi) return lo;
  if (dHi < dLo) return hi;
  return lo % 2n === 0n ? lo : hi;
}

describe('roundHalfEven — exact and sign-symmetric', () => {
  it('sends every tie to the even neighbour, in both signs', () => {
    const ties: [bigint, bigint, bigint][] = [
      [1n, 2n, 0n],
      [3n, 2n, 2n],
      [5n, 2n, 2n],
      [7n, 2n, 4n],
      [-1n, 2n, 0n],
      [-3n, 2n, -2n],
      [-5n, 2n, -2n],
      [-7n, 2n, -4n],
      [1n, -2n, 0n],
      [-5n, -2n, 2n],
      [3315n, 10n, 332n],
      [-3325n, 10n, -332n],
      [25n, 10n, 2n],
      [35n, 10n, 4n],
    ];
    for (const [n, d, q] of ties) expect(roundHalfEven(n, d), `${n}/${d}`).toBe(q);
  });

  it('rounds non-ties to nearest', () => {
    expect(roundHalfEven(6n, 10n)).toBe(1n);
    expect(roundHalfEven(4n, 10n)).toBe(0n);
    expect(roundHalfEven(-6n, 10n)).toBe(-1n);
    expect(roundHalfEven(-4n, 10n)).toBe(0n);
    expect(roundHalfEven(0n, 7n)).toBe(0n);
    expect(roundHalfEven(-520n * 10n ** 10n, -6n)).toBe(866666666667n);
  });

  it('agrees with the independent oracle on a full grid, and is odd in each operand', () => {
    for (let n = -300n; n <= 300n; n += 1n) {
      for (let d = -17n; d <= 17n; d += 1n) {
        if (d === 0n) continue;
        const q = roundHalfEven(n, d);
        expect(q, `${n}/${d}`).toBe(nearestEven(n, d));
        expect(roundHalfEven(-n, d)).toBe(-q);
        expect(roundHalfEven(n, -d)).toBe(-q);
      }
    }
  });

  it('is exact far beyond 2^53 — no binary floating point anywhere', () => {
    const big = 10n ** 40n;
    expect(roundHalfEven(big + 5n, 10n)).toBe(10n ** 39n); // …0.5 → even
    expect(roundHalfEven(big + 15n, 10n)).toBe(10n ** 39n + 2n); // …1.5 → even
    expect(roundHalfEven(-(big + 15n), 10n)).toBe(-(10n ** 39n + 2n));
    expect(roundHalfEven(2n ** 64n + 1n, 2n)).toBe(2n ** 63n); // …0.5 → even
  });

  it('refuses a zero denominator with inventory.arithmetic_invalid', () => {
    expect(codeOf(() => roundHalfEven(1n, 0n))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => roundHalfEven(0n, 0n))).toBe('inventory.arithmetic_invalid');
  });
});

describe('roundHalfEvenDecimal — the TypeScript twin of inventory_half_even', () => {
  it('rounds n/d to scale 0 and scale 10', () => {
    expect(roundHalfEvenDecimal({ units: 10n, scale: 0 }, { units: 3n, scale: 0 }, 10)).toEqual({ units: 33333333333n, scale: 10 });
    expect(roundHalfEvenDecimal({ units: 20n, scale: 0 }, { units: 3n, scale: 0 }, 10)).toEqual({ units: 66666666667n, scale: 10 });
    expect(roundHalfEvenDecimal({ units: 1n, scale: 0 }, { units: 20000000000n, scale: 0 }, 10)).toEqual({ units: 0n, scale: 10 });
    expect(roundHalfEvenDecimal({ units: 3n, scale: 0 }, { units: 20000000000n, scale: 0 }, 10)).toEqual({ units: 2n, scale: 10 });
    expect(roundHalfEvenDecimal({ units: 3315n, scale: 0 }, { units: 10n, scale: 0 }, 0)).toEqual({ units: 332n, scale: 0 });
  });

  it('honours fractional operands exactly (the scales cancel, nothing is pre-rounded)', () => {
    // 0.6 / 1 → 1 ; 1.5 / 1.0 → 2 ; 2.5 / 1 → 2 ; 3.315 / 0.01 = 331.5 → 332
    expect(roundHalfEvenDecimal({ units: 6n, scale: 1 }, { units: 1n, scale: 0 }, 0).units).toBe(1n);
    expect(roundHalfEvenDecimal({ units: 15n, scale: 1 }, { units: 10n, scale: 1 }, 0).units).toBe(2n);
    expect(roundHalfEvenDecimal({ units: 25n, scale: 1 }, { units: 1n, scale: 0 }, 0).units).toBe(2n);
    expect(roundHalfEvenDecimal({ units: 3315n, scale: 3 }, { units: 1n, scale: 2 }, 0).units).toBe(332n);
    // −520 / −6.0000 at scale 10
    expect(roundHalfEvenDecimal({ units: -520n, scale: 0 }, { units: -60000n, scale: 4 }, 10).units).toBe(866666666667n);
  });

  it('refuses a zero denominator and an impossible operand scale with inventory.arithmetic_invalid', () => {
    expect(codeOf(() => roundHalfEvenDecimal({ units: 1n, scale: 0 }, { units: 0n, scale: 4 }, 0))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => roundHalfEvenDecimal({ units: 1n, scale: -1 }, { units: 1n, scale: 0 }, 0))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => roundHalfEvenDecimal({ units: 1n, scale: 0 }, { units: 1n, scale: 0.5 }, 10))).toBe('inventory.arithmetic_invalid');
  });
});
