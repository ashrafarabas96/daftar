import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderAllocationVectors, type AllocationVectors } from '../scripts/s3-vector-cases';
import { allocateOpening, assertOpeningMatchesPosition, largestRemainder, openingDocumentTotal, openingLineWeight } from '../src/allocation';
import { InventoryError } from '../src/errors';
import { parseDecimal } from '../src/fixed-point';
import { toC10, toQ4 } from '../src/movement-payloads';

const FILE = join(__dirname, '..', 'vectors', 'allocation-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as AllocationVectors;

function refusal(fn: () => unknown): InventoryError | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e;
    throw e;
  }
  return null;
}

describe('vectors/allocation-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration', async () => {
    expect(await renderAllocationVectors()).toBe(committed);
  });

  it('covers ties, zero weights, all-zero W, one line, a residue of n - 1, a total >= 2^53 and Case B exact and off by one', () => {
    const ids = vectors.cases.map((c) => c.id);
    expect(ids).toEqual(['AL-01', 'AL-02', 'AL-03', 'AL-04', 'AL-05', 'AL-06', 'AL-07', 'AL-08', 'AL-09', 'AL-10', 'AL-11']);
    expect(vectors.cases.some((c) => BigInt(c.total) >= 2n ** 53n)).toBe(true);
    expect(vectors.openings.filter((o) => o.caseB?.outcome === 'match').length).toBeGreaterThanOrEqual(1);
    expect(
      vectors.openings
        .filter((o) => o.caseB?.outcome === 'inventory.opening_valuation_mismatch')
        .map((o) => BigInt(o.caseB?.positionMinor ?? '0') - BigInt(o.total)),
    ).toEqual([1n, -1n]);
  });
});

describe('largestRemainder — the vectors', () => {
  for (const c of vectors.cases) {
    it(`${c.id}: ${c.why}`, () => {
      const shares = largestRemainder(c.weights.map(parseDecimal), BigInt(c.total));
      expect(shares.map((s) => s.toString())).toEqual(c.shares);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(BigInt(c.total));
    });
  }
});

describe('opening valuation — the vectors', () => {
  for (const o of vectors.openings) {
    it(`${o.id}: ${o.why}`, () => {
      const lines = o.lines.map((l) => ({ qtyQ4: toQ4(l.qty), costC10: toC10(l.unitCost) }));
      const { total, shares } = allocateOpening(lines);
      expect(total.toString()).toBe(o.total);
      expect(shares.map((s) => s.toString())).toEqual(o.shares);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
      if (o.caseB !== null) {
        const e = refusal(() => assertOpeningMatchesPosition(total, BigInt(o.caseB?.positionMinor ?? '')));
        expect(e?.code ?? 'match').toBe(o.caseB.outcome);
        if (e !== null) {
          // Both totals travel in typed details, never in the message.
          expect(e.details).toEqual({ stockTotalMinor: o.total, openingPositionMinor: o.caseB.positionMinor });
          expect(e.message).not.toContain(o.total);
          expect(e.message).not.toContain(o.caseB.positionMinor);
        }
      }
    });
  }
});

describe('largestRemainder — properties and refusals', () => {
  it('always sums to the total and never moves more than one unit off the exact share', () => {
    // Deterministic pseudo-random weights (a linear congruential sequence), BigInt only.
    let seed = 12345n;
    const next = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return seed;
    };
    for (let round = 0; round < 200; round += 1) {
      const n = Number.parseInt(((next() % 7n) + 1n).toString(), 10);
      const weights = Array.from({ length: n }, () => ({ units: next() % 1000000n, scale: Number.parseInt((next() % 5n).toString(), 10) }));
      const total = next() % 10n ** 12n;
      const scale = Math.max(...weights.map((w) => w.scale));
      const units = weights.map((w) => w.units * 10n ** BigInt(scale - w.scale));
      const sum = units.reduce((a, b) => a + b, 0n);
      if (sum === 0n) continue;
      const shares = largestRemainder(weights, total);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
      shares.forEach((s, i) => {
        const floor = (total * (units[i] ?? 0n)) / sum;
        expect(s === floor || s === floor + 1n).toBe(true);
      });
    }
  });

  it('refuses an empty list, a negative weight or total, and a non-zero total over zero weights', () => {
    expect(refusal(() => largestRemainder([], 0n))?.code).toBe('inventory.allocation_invalid');
    expect(refusal(() => largestRemainder([{ units: -1n, scale: 0 }], 1n))?.code).toBe('inventory.allocation_invalid');
    expect(refusal(() => largestRemainder([{ units: 1n, scale: 0 }], -1n))?.code).toBe('inventory.allocation_invalid');
    expect(refusal(() => largestRemainder([{ units: 0n, scale: 0 }], 1n))?.code).toBe('inventory.allocation_invalid');
    expect(refusal(() => largestRemainder([{ units: 1n, scale: -1 }], 1n))?.code).toBe('inventory.allocation_invalid');
  });

  it('opening lines refuse a non-positive quantity and a negative cost; the total is bounded', () => {
    expect(refusal(() => openingLineWeight({ qtyQ4: 0n, costC10: 1n }))?.code).toBe('inventory.allocation_invalid');
    expect(refusal(() => openingLineWeight({ qtyQ4: 1n, costC10: -1n }))?.code).toBe('inventory.allocation_invalid');
    expect(refusal(() => openingDocumentTotal([]))?.code).toBe('inventory.allocation_invalid');
    expect(openingLineWeight({ qtyQ4: 3n, costC10: 7n })).toEqual({ units: 21n, scale: 14 });
    const huge = { qtyQ4: 10n ** 14n - 1n, costC10: 10n ** 28n - 1n };
    expect(refusal(() => openingDocumentTotal([huge]))?.code).toBe('inventory.value_out_of_range');
  });
});
