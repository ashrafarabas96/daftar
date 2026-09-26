import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCoverageVectors, type CoverageVectors } from '../scripts/s4-vector-cases';
import { planCoverage, type DeficitLayer } from '../src/deficit-coverage';
import { InventoryError } from '../src/errors';
import { formatMinor, formatQuantity, formatUnitCost, parseMinor } from '../src/fixed-point';
import { toC10, toQ4 } from '../src/movement-payloads';
import { averageUnitCost, type StockState } from '../src/valuation';

const FILE = join(__dirname, '..', 'vectors', 'coverage-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as CoverageVectors;
const valuation = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'valuation-vectors.json'), 'utf8')) as {
  scenarios: { id: string; steps: { kind: string; value: string | null; expect: { value: string } }[] }[];
};

const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const L1 = 'b0000000-0000-4000-8000-000000000001';
const D1 = 'f0000000-0000-4000-8000-000000000001';
const D2 = 'f0000000-0000-4000-8000-000000000002';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

const state = (onHand: string, value: string): StockState => {
  const q = toQ4(onHand);
  const v = parseMinor(value);
  return { onHand: q, valuation: v, avg: averageUnitCost(v, q, null), lastStockSeq: 1n };
};

describe('vectors/coverage-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration', async () => {
    expect(await renderCoverageVectors()).toBe(committed);
  });

  it('carries the case ids the gate requires', () => {
    const ids = vectors.cases.map((c) => c.id);
    for (const id of ['GOLD54', 'GOLD55', 'GOLD72', 'THREE-LAYERS', 'ZERO-CATCHUP', 'FLUSH-RESIDUE', 'MIXED-N0']) expect(ids).toContain(id);
  });

  it('restates no GOLD number: each GOLD case`s catch-ups are the valuation vectors` own (L:390)', () => {
    for (const [cov, val] of [
      ['GOLD54', 'AL08-CATCHUP-GOLD54'],
      ['GOLD55', 'AL08-CATCHUP-GOLD55'],
      ['GOLD72', 'AL08-CATCHUP-GOLD72'],
    ] as const) {
      const fromValuation = (valuation.scenarios.find((s) => s.id === val)?.steps ?? [])
        .filter((s) => s.kind === 'negative_inventory_cost_adjustment')
        .map((s) => s.expect.value);
      const fromCoverage = (vectors.cases.find((c) => c.id === cov)?.receipts ?? []).flatMap((r) =>
        r.expect.lines.flatMap((l) => l.coverages.map((x) => x.valueMinor)),
      );
      expect(fromCoverage).toEqual(fromValuation);
      expect(fromCoverage.length).toBeGreaterThan(0);
    }
  });
});

describe('deficit coverage A-16 — the shared vectors', () => {
  for (const c of vectors.cases) {
    it(`${c.id}`, () => {
      const states = new Map<string, StockState>(
        c.seed.map((k) => {
          const s = state(k.state.onHand, k.state.valuation);
          expect(s.avg === null ? null : formatUnitCost(s.avg)).toBe(k.state.avg);
          return [k.variantId, s];
        }),
      );
      let layers: DeficitLayer[] = c.seed.flatMap((k) =>
        k.layers.map((l) => ({
          deficitId: l.deficitId,
          variantId: k.variantId,
          deficitSeq: BigInt(l.deficitSeq),
          uncoveredQ4: toQ4(l.uncovered),
          provisionalC10: toC10(l.provisional),
        })),
      );
      for (const r of c.receipts) {
        const plan = planCoverage(
          layers,
          states,
          r.lines.map((l) => ({ lineId: l.lineId, variantId: l.variantId, qtyQ4: toQ4(l.qty), baseShareMinor: parseMinor(l.baseShareMinor) })),
        );
        expect(
          plan.lines.map((l) => ({
            lineId: l.lineId,
            actual: formatUnitCost(l.actualC10),
            covered: formatQuantity(l.coveredQ4),
            catchUpMinor: formatMinor(l.catchUpMinor),
            coverages: l.coverages.map((x) => ({
              deficitId: x.deficitId,
              qtyCovered: formatQuantity(x.qtyCoveredQ4),
              provisional: formatUnitCost(x.provisionalC10),
              actual: formatUnitCost(x.actualC10),
              formulaMinor: formatMinor(x.formulaMinor),
              valueMinor: formatMinor(x.valueMinor),
              flush: x.flush,
              movement: x.movement,
              uncoveredAfter: formatQuantity(x.uncoveredAfterQ4),
              statusAfter: x.statusAfter,
            })),
            stateAfter: {
              onHand: formatQuantity(l.stateAfter.onHand),
              valuation: formatMinor(l.stateAfter.valuation),
              avg: l.stateAfter.avg === null ? null : formatUnitCost(l.stateAfter.avg),
            },
          })),
        ).toEqual(r.expect.lines);
        expect(formatMinor(plan.totalValueMinor)).toBe(r.expect.totalValueBaseMinor);
        expect(plan.coveredQ4 > 0n).toBe(r.expect.header);
        // N is the sum of the STORED values, never of anything else (A-16(i)).
        expect(plan.totalValueMinor).toBe(plan.lines.flatMap((l) => l.coverages).reduce((a, x) => a + x.valueMinor, 0n));
        for (const l of plan.lines) states.set(l.variantId, l.stateAfter);
        const after = new Map(plan.lines.flatMap((l) => l.coverages.map((x) => [x.deficitId, x.uncoveredAfterQ4] as const)));
        layers = layers.map((l) => ({ ...l, uncoveredQ4: after.get(l.deficitId) ?? l.uncoveredQ4 })).filter((l) => l.uncoveredQ4 > 0n);
      }
    });
  }
});

describe('planCoverage', () => {
  const layer = (deficitId: string, seq: bigint, uncovered: string, provisional: string): DeficitLayer => ({
    deficitId,
    variantId: V1,
    deficitSeq: seq,
    uncoveredQ4: toQ4(uncovered),
    provisionalC10: toC10(provisional),
  });

  it('consumes FIFO by deficit_seq whatever order the layers arrive in', () => {
    const plan = planCoverage([layer(D2, 2n, '1', '10'), layer(D1, 1n, '1', '10')], new Map([[V1, state('-2', '-20')]]), [
      { lineId: L1, variantId: V1, qtyQ4: toQ4('1'), baseShareMinor: 12n },
    ]);
    expect(plan.lines[0]?.coverages.map((c) => [c.deficitId, c.statusAfter])).toEqual([[D1, 'closed']]);
  });

  it('a partial cover leaves the layer partially covered and is never a flush', () => {
    const plan = planCoverage([layer(D1, 1n, '3', '10')], new Map([[V1, state('-3', '-30')]]), [
      { lineId: L1, variantId: V1, qtyQ4: toQ4('1'), baseShareMinor: 12n },
    ]);
    expect(plan.lines[0]?.coverages[0]).toMatchObject({ statusAfter: 'partially_covered', flush: false, valueMinor: -2n });
  });

  it('a receipt beyond the deficit closes every layer without a flush', () => {
    const plan = planCoverage([layer(D1, 1n, '1', '10.5')], new Map([[V1, state('-1', '-10')]]), [
      { lineId: L1, variantId: V1, qtyQ4: toQ4('2'), baseShareMinor: 30n },
    ]);
    expect(plan.lines[0]?.coverages[0]).toMatchObject({ flush: false, valueMinor: -4n });
  });

  it('a key with no deficit plans nothing', () => {
    const plan = planCoverage([], new Map(), [{ lineId: L1, variantId: V1, qtyQ4: toQ4('2'), baseShareMinor: 30n }]);
    expect(plan).toMatchObject({ coveredQ4: 0n, totalValueMinor: 0n });
    expect(plan.lines[0]?.coverages).toEqual([]);
  });

  it('refuses layers that do not hold the key deficit, a closed layer and a repeated variant', () => {
    const line = [{ lineId: L1, variantId: V1, qtyQ4: toQ4('1'), baseShareMinor: 10n }];
    expect(codeOf(() => planCoverage([layer(D1, 1n, '1', '10')], new Map([[V1, state('-2', '-20')]]), line))).toBe('inventory.deficit_state_invalid');
    expect(codeOf(() => planCoverage([], new Map([[V1, state('-2', '-20')]]), line))).toBe('inventory.deficit_state_invalid');
    expect(codeOf(() => planCoverage([layer(D1, 1n, '1', '10')], new Map(), line))).toBe('inventory.deficit_state_invalid');
    expect(codeOf(() => planCoverage([{ ...layer(D1, 1n, '1', '10'), uncoveredQ4: 0n }], new Map([[V1, state('0', '0')]]), line))).toBe(
      'inventory.deficit_state_invalid',
    );
    expect(codeOf(() => planCoverage([], new Map(), [...line, ...line]))).toBe('inventory.duplicate_line');
  });
});
