import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LandedCostVectors } from '../scripts/s4-vector-cases';
import { InventoryError } from '../src/errors';
import { parseMinor } from '../src/fixed-point';
import { toQ4 } from '../src/movement-payloads';
import { baseShares, unitCostC10 } from '../src/purchase-shares';

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'landed-cost-vectors.json'), 'utf8')) as LandedCostVectors;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

describe('base shares A-13 steps 7–8 — the shared vectors', () => {
  for (const v of vectors.purchases) {
    it(`${v.id}: Σ s_i = B exactly, and each unit cost is HALF_EVEN(s_i / qty_i, 10)`, () => {
      const B = parseMinor(v.expect.totalBaseMinor);
      const shares = baseShares(
        B,
        v.expect.lines.map((l) => parseMinor(l.totalMinor)),
      );
      expect(shares.map(String)).toEqual(v.expect.lines.map((l) => l.baseShareMinor));
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(B);
      shares.forEach((s, i) => {
        const [whole, frac] = (v.expect.lines[i]?.unitCostBaseMinor ?? '').split('.');
        expect(unitCostC10(s, toQ4(v.lines[i]?.qty ?? '0'))).toBe(BigInt(`${whole}${frac}`));
      });
    });
  }
});

describe('baseShares and unitCostC10', () => {
  it('ties go to the lower line; a zero-total line takes nothing', () => {
    expect(baseShares(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(baseShares(5n, [0n, 7n])).toEqual([0n, 5n]);
  });

  it('refuses a zero base total, zero line totals and a negative line total', () => {
    expect(codeOf(() => baseShares(0n, [1n]))).toBe('purchase.total_zero');
    expect(codeOf(() => baseShares(1n, [0n, 0n]))).toBe('purchase.total_zero');
    expect(codeOf(() => baseShares(1n, [-1n, 2n]))).toBe('inventory.allocation_invalid');
    expect(codeOf(() => baseShares(1n, []))).toBe('inventory.lines_required');
  });

  it('unit cost: HALF_EVEN at 10 decimals, exact', () => {
    expect(unitCostC10(1000n, toQ4('3'))).toBe(3333333333333n);
    expect(unitCostC10(30n, toQ4('2'))).toBe(150000000000n);
    expect(codeOf(() => unitCostC10(1n, 0n))).toBe('inventory.quantity_invalid');
  });
});
