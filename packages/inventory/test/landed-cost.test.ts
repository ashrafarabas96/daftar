import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderLandedCostVectors, type LandedCostVectors } from '../scripts/s4-vector-cases';
import { InventoryError } from '../src/errors';
import { parseMinor } from '../src/fixed-point';
import { allocateByValue, lineGross, lineNet, lineTotals, validateManual, type LandedCostInput } from '../src/landed-cost';
import { toC10, toQ4 } from '../src/movement-payloads';

const FILE = join(__dirname, '..', 'vectors', 'landed-cost-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as LandedCostVectors;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

describe('vectors/landed-cost-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration', async () => {
    expect(await renderLandedCostVectors()).toBe(committed);
  });

  it('covers the §4.1 cases: an uneven by_value split with the line_no tie-break, a zero denominator, manual off by +1 and -1', () => {
    const ids = vectors.splits.map((s) => s.id);
    for (const id of ['LC-BYVALUE-TIE', 'LC-BYVALUE-UNEVEN', 'LC-BYVALUE-DENOMINATOR-ZERO', 'LC-MANUAL-PLUS-1', 'LC-MANUAL-MINUS-1']) expect(ids).toContain(id);
  });
});

describe('landed-cost splits — the shared vectors', () => {
  for (const v of vectors.splits) {
    it(`${v.id}: ${v.outcome}`, () => {
      const inputs = v.inputs.map(parseMinor);
      const amount = parseMinor(v.amountMinor);
      const run = () => (v.kind === 'by_value' ? allocateByValue(amount, inputs) : validateManual(amount, inputs, inputs.length));
      expect(codeOf(run)).toBe(v.outcome);
      if (v.allocations !== null) {
        const got = run();
        expect(got.map(String)).toEqual(v.allocations);
        expect(got.reduce((a, b) => a + b, 0n)).toBe(amount);
      }
    });
  }
});

describe('purchase arithmetic A-13 steps 1–5 — the shared vectors', () => {
  for (const v of vectors.purchases) {
    it(`${v.id}`, () => {
      const t = lineTotals(
        v.lines.map((l) => ({ qtyQ4: toQ4(l.qty), unitPriceC10: toC10(l.unitPriceTxnMinor), discountMinor: parseMinor(l.discountMinor) })),
        v.landedCosts.map(
          (c): LandedCostInput => ({ mode: c.mode, amountMinor: parseMinor(c.amountMinor), allocations: c.allocations?.map(parseMinor) ?? null }),
        ),
      );
      expect(t.lines.map((l) => [l.grossMinor, l.netMinor, l.landedMinor, l.totalMinor].map(String))).toEqual(
        v.expect.lines.map((l) => [l.grossMinor, l.netMinor, l.landedMinor, l.totalMinor]),
      );
      expect(t.allocations.map((r) => r.map(String))).toEqual(v.expect.allocations);
      expect(String(t.subtotalMinor)).toBe(v.expect.subtotalMinor);
      expect(String(t.landedMinor)).toBe(v.expect.landedMinor);
      expect(String(t.totalMinor)).toBe(v.expect.totalTxnMinor);
      // Σ allocations per cost = its amount; Σ t_i = T (the deferred allocation trigger's facts, A-15(h)).
      t.allocations.forEach((row, k) => expect(row.reduce((a, b) => a + b, 0n)).toBe(parseMinor(v.landedCosts[k]?.amountMinor ?? '0')));
      expect(t.lines.reduce((a, l) => a + l.totalMinor, 0n)).toBe(t.totalMinor);
    });
  }

  for (const v of vectors.refusals) {
    it(`${v.id}: ${v.outcome}`, () => {
      const run = () =>
        lineTotals(
          v.lines.map((l) => ({ qtyQ4: toQ4(l.qty), unitPriceC10: toC10(l.unitPriceTxnMinor), discountMinor: parseMinor(l.discountMinor) })),
          v.landedCosts.map(
            (c): LandedCostInput => ({ mode: c.mode, amountMinor: parseMinor(c.amountMinor), allocations: c.allocations?.map(parseMinor) ?? null }),
          ),
        );
      expect(codeOf(run)).toBe(v.outcome);
    });
  }
});

describe('landed-cost primitives', () => {
  it('gross is one HALF_EVEN at the line: a tie goes to the even neighbour', () => {
    expect(lineGross(toQ4('2.5'), toC10('1'))).toBe(2n);
    expect(lineGross(toQ4('3.5'), toC10('1'))).toBe(4n);
    expect(lineGross(toQ4('3'), toC10('333.3333'))).toBe(1000n);
    expect(lineGross(toQ4('0.0001'), toC10('0.0000000001'))).toBe(0n);
    expect(codeOf(() => lineGross(0n, 1n))).toBe('inventory.quantity_invalid');
    expect(codeOf(() => lineGross(1n, -1n))).toBe('inventory.cost_invalid');
  });

  it('a discount is between zero and the gross', () => {
    expect(lineNet(100n, 100n)).toBe(0n);
    expect(codeOf(() => lineNet(100n, 101n))).toBe('purchase.discount_invalid');
    expect(codeOf(() => lineNet(100n, -1n))).toBe('purchase.discount_invalid');
  });

  it('refuses a non-positive landed amount, a negative or wrongly counted manual allocation, and a mode mismatch', () => {
    expect(codeOf(() => allocateByValue(0n, [1n]))).toBe('purchase.landed_cost_invalid');
    expect(codeOf(() => validateManual(5n, [6n, -1n], 2))).toBe('purchase.landed_cost_invalid');
    expect(codeOf(() => validateManual(5n, [5n], 2))).toBe('purchase.landed_cost_invalid');
    const line = [{ qtyQ4: toQ4('1'), unitPriceC10: toC10('10'), discountMinor: 0n }];
    expect(codeOf(() => lineTotals(line, [{ mode: 'by_value', amountMinor: 1n, allocations: [1n] }]))).toBe('purchase.landed_cost_invalid');
    expect(codeOf(() => lineTotals(line, [{ mode: 'manual', amountMinor: 1n, allocations: null }]))).toBe('purchase.landed_cost_invalid');
    expect(codeOf(() => lineTotals(line, [], 1n))).toBe('inventory.payload_invalid');
    expect(codeOf(() => lineTotals([], []))).toBe('inventory.lines_required');
  });

  it('is exact above 2^53', () => {
    const big = 2n ** 59n + 1n;
    expect(allocateByValue(big, [1n, 1n])).toEqual([2n ** 58n + 1n, 2n ** 58n]);
  });
});
