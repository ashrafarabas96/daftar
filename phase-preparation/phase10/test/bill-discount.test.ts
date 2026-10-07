import { describe, expect, it } from 'vitest';
import { at } from './at';
import { BillDiscountRefusal, distributeBillDiscount, type DiscountableLine } from '../src/bill-discount';

const lines = (...gross: bigint[]): readonly DiscountableLine[] => gross.map((g, i) => ({ lineId: `l${i}`, grossTxnMinor: g }));

describe('distributeBillDiscount — a whole-bill discount becomes line discounts that add up', () => {
  it('conserves the discount exactly and never exceeds a line gross, over a wide grid', () => {
    const shapes: readonly (readonly bigint[])[] = [
      [1000n],
      [1000n, 1000n],
      [333n, 333n, 334n],
      [1n, 1n, 1n, 1n, 1n, 1n, 1n],
      [10n, 0n, 90n],
      [999_999_999n, 1n],
      [7n, 11n, 13n, 17n, 19n, 23n],
    ];
    let cases = 0;
    for (const shape of shapes) {
      const subtotal = shape.reduce((a, b) => a + b, 0n);
      for (let d = 0n; d <= subtotal; d += subtotal / 17n + 1n) {
        const parts = distributeBillDiscount(lines(...shape), d);
        expect(parts.reduce((a, p) => a + p.discountTxnMinor, 0n)).toBe(d);
        for (const [i, part] of parts.entries()) {
          expect(part.discountTxnMinor >= 0n).toBe(true);
          // sale_items_discount_ck: a line discount never exceeds its gross.
          expect(part.discountTxnMinor <= at(shape, i)).toBe(true);
        }
        cases += 1;
      }
      // The full-discount edge must be in the grid for every shape.
      const full = distributeBillDiscount(lines(...shape), subtotal);
      expect(full.reduce((a, p) => a + p.discountTxnMinor, 0n)).toBe(subtotal);
      for (const [i, part] of full.entries()) expect(part.discountTxnMinor).toBe(at(shape, i));
      cases += 1;
    }
    expect(cases).toBeGreaterThan(50);
  });

  it('gives a zero-gross line nothing — it cannot carry a discount', () => {
    const parts = distributeBillDiscount(lines(100n, 0n, 100n), 50n);
    expect(at(parts, Number(1)).discountTxnMinor).toBe(0n);
    expect(parts.reduce((a, p) => a + p.discountTxnMinor, 0n)).toBe(50n);
  });

  it('breaks a remainder tie on the lower line index, so the receipt is explainable', () => {
    // 10 split over three equal lines: 3,3,3 with 1 left over -> the first line.
    const parts = distributeBillDiscount(lines(100n, 100n, 100n), 10n);
    expect(parts.map((p) => p.discountTxnMinor)).toEqual([4n, 3n, 3n]);
  });

  it('is deterministic', () => {
    const a = distributeBillDiscount(lines(17n, 29n, 41n, 53n), 61n);
    const b = distributeBillDiscount(lines(17n, 29n, 41n, 53n), 61n);
    expect(a).toEqual(b);
  });

  it('returns all zeros for a zero discount without inventing a remainder', () => {
    const parts = distributeBillDiscount(lines(10n, 20n), 0n);
    expect(parts.map((p) => p.discountTxnMinor)).toEqual([0n, 0n]);
  });

  it('proves the per-line cap can never block placement — so it is a bound, not a law with a red proof', () => {
    // The distribution gives each line floor(gross x d / subtotal) and then
    // places `leftover` single units on the largest remainders. The cap
    // `amount < gross` exists so a zero-gross line is never handed a unit. This
    // enumerates every shape of up to four lines with grosses 0..4 and every
    // discount 0..subtotal, and measures that the cap NEVER has to refuse a
    // placement: every line with a positive gross has floor < gross whenever
    // d < subtotal, and `leftover` never exceeds the number of such lines.
    // That is why no mutation of the cap turns this suite red, and why the
    // guard is recorded as unreachable instead of claimed as a proven law.
    let shapes = 0;
    let cases = 0;
    let everBlocked = 0;
    const grosses = [0n, 1n, 2n, 3n, 4n];
    const build = (depth: number, acc: bigint[]): void => {
      if (depth === 0) {
        if (acc.length === 0) return;
        shapes += 1;
        const subtotal = acc.reduce((a, b) => a + b, 0n);
        for (let d = 0n; d <= subtotal; d += 1n) {
          cases += 1;
          if (d === 0n || subtotal === 0n) continue;
          let distributed = 0n;
          let placeable = 0;
          for (const gross of acc) {
            const floor = (gross * d) / subtotal;
            distributed += floor;
            if (floor < gross) placeable += 1;
          }
          const leftover = d - distributed;
          if (leftover > BigInt(placeable)) everBlocked += 1;
        }
        return;
      }
      for (const g of grosses) build(depth - 1, [...acc, g]);
      build(0, acc);
    };
    for (let width = 1; width <= 4; width += 1) build(width, []);
    expect(shapes).toBeGreaterThan(500);
    expect(cases).toBeGreaterThan(2000);
    expect(everBlocked).toBe(0);
  });

  it('refuses a discount above the subtotal by code, rather than clamping it', () => {
    try {
      distributeBillDiscount(lines(100n, 100n), 201n);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BillDiscountRefusal);
      const refusal = error as BillDiscountRefusal;
      expect(refusal.code).toBe('restaurant.bill_discount.exceeds_subtotal');
      expect(refusal.details?.subtotalTxnMinor).toBe('200');
    }
  });

  it('refuses a negative discount by its own code', () => {
    expect(() => distributeBillDiscount(lines(100n), -1n)).toThrowError(expect.objectContaining({ code: 'restaurant.bill_discount.negative' }));
  });

  it('refuses a bill with no line', () => {
    expect(() => distributeBillDiscount([], 0n)).toThrowError(expect.objectContaining({ code: 'restaurant.bill_discount.no_lines' }));
  });

  it('refuses a negative line gross by its own code', () => {
    expect(() => distributeBillDiscount(lines(100n, -5n), 10n)).toThrowError(expect.objectContaining({ code: 'restaurant.bill_discount.line_gross_negative' }));
  });

  it('refuses a discount over a zero-gross bill rather than dividing by zero', () => {
    expect(() => distributeBillDiscount(lines(0n, 0n), 1n)).toThrowError(expect.objectContaining({ code: 'restaurant.bill_discount.exceeds_subtotal' }));
  });
});
