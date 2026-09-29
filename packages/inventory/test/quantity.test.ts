import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import { formatQuantity, parseQuantity } from '../src/fixed-point';
import { assertQuantityRepresentable, isQuantityRepresentable } from '../src/quantity';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return undefined;
}

describe('quantity precision is the VALUE at the frozen unit_decimals (P3-AL-05)', () => {
  it('matches the lock table, including the rows the withdrawn scale() rule got wrong', () => {
    // scale() of every one of these as NUMERIC(18,4) is 4; the value law differs.
    expect(isQuantityRepresentable(parseQuantity('1'), 0)).toBe(true);
    expect(isQuantityRepresentable(parseQuantity('1.0000'), 0)).toBe(true);
    expect(isQuantityRepresentable(parseQuantity('-3.0000'), 0)).toBe(true);
    expect(isQuantityRepresentable(parseQuantity('0.5'), 0)).toBe(false);
    expect(isQuantityRepresentable(parseQuantity('0.5'), 2)).toBe(true);
    expect(isQuantityRepresentable(parseQuantity('1.0001'), 0)).toBe(false);
    expect(isQuantityRepresentable(parseQuantity('1.0001'), 2)).toBe(false);
    expect(isQuantityRepresentable(parseQuantity('1.0001'), 4)).toBe(true);
  });

  it('agrees on a full grid with a digit oracle: the fraction digits beyond d are all zero, for both signs', () => {
    for (let d = 0; d <= 4; d += 1) {
      for (let q4 = -25000n; q4 <= 25000n; q4 += 7n) {
        const fraction = formatQuantity(q4).split('.')[1] ?? '';
        const oracle = /^0*$/.test(fraction.slice(d));
        expect(isQuantityRepresentable(q4, d), `${q4} @ ${d}`).toBe(oracle);
        expect(isQuantityRepresentable(-q4, d)).toBe(oracle);
        expect(codeOf(() => assertQuantityRepresentable(q4, d))).toBe(oracle ? undefined : 'inventory.quantity_precision_invalid');
      }
    }
  });

  it('refuses unit_decimals outside the integers 0..4 with inventory.unit_decimals_invalid', () => {
    for (const d of [-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        codeOf(() => isQuantityRepresentable(1n, d)),
        String(d),
      ).toBe('inventory.unit_decimals_invalid');
      expect(
        codeOf(() => assertQuantityRepresentable(1n, d)),
        String(d),
      ).toBe('inventory.unit_decimals_invalid');
    }
  });
});
