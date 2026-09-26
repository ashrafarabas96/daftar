import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderValuationVectors, type Scenario, type ValuationVectors } from '../scripts/valuation-vector-cases';
import { InventoryError } from '../src/errors';
import { formatMinor, formatQuantity, formatUnitCost, parseDecimal, parseMinor, parseQuantity, parseUnitCost } from '../src/fixed-point';
import { assertQuantityRepresentable, isQuantityRepresentable } from '../src/quantity';
import { foldMovements, type StoredMovement } from '../src/rebuild';
import { roundHalfEven, roundHalfEvenDecimal } from '../src/rounding';
import { applyMovement, averageUnitCost, catchUpValue, EMPTY_STOCK_STATE, simulateMovement, type MovementInput, type StockState } from '../src/valuation';

const FILE = join(__dirname, '..', 'vectors', 'valuation-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as ValuationVectors;

const Q4_TIMES_C10 = 10n ** 14n;

/** HALF_UP as PostgreSQL's round() does it: ties away from zero. Test-only oracle for the `halfUp` column. */
function halfUp(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if (2n * (an - q * ad) >= ad) q += 1n;
  return negative ? -q : q;
}

function isTie(n: bigint, d: bigint): boolean {
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  return 2n * (an % ad) === ad;
}

function fmtScale(units: bigint, scale: 0 | 10): string {
  return scale === 0 ? formatMinor(units) : formatUnitCost(units);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return undefined;
}

describe('vectors/valuation-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-valuation-vectors.ts after a SPEC change only)', () => {
    expect(renderValuationVectors()).toBe(committed);
  });

  it('has exactly the §4 top-level shape and version', () => {
    expect(Object.keys(vectors)).toEqual(['version', 'precision', 'rounding', 'scenarios', 'controls']);
    expect(vectors.version).toBe('invval/1');
  });

  it('ships exactly P-01…P-10, R-01…R-19, the nine §D and seven P3-AL-08 scenarios, and CTRL-FLUSH', () => {
    const range = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}-${String(i + 1).padStart(2, '0')}`);
    expect(vectors.precision.map((p) => p.id)).toEqual(range('P', 10));
    expect(vectors.rounding.map((r) => r.id)).toEqual(range('R', 19));
    expect(vectors.scenarios.map((s) => s.id)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
      'AL08-RECEIPT',
      'AL08-TRANSFER-GOLD44',
      'AL08-ADJ-POS',
      'AL08-ADJ-NEG',
      'AL08-CATCHUP-GOLD54',
      'AL08-CATCHUP-GOLD55',
      'AL08-CATCHUP-GOLD72',
    ]);
    expect(vectors.scenarios.filter((s) => s.group === 'P3-AL-49-D')).toHaveLength(9);
    expect(vectors.scenarios.filter((s) => s.group === 'P3-AL-08')).toHaveLength(7);
    expect(vectors.controls.map((s) => s.id)).toEqual(['CTRL-FLUSH']);
  });
});

describe('precision vectors P-01…P-10 (P3-AL-05)', () => {
  for (const p of vectors.precision) {
    it(`${p.id}: ${p.qty} at unit_decimals ${p.unitDecimals} is ${p.valid ? 'VALID' : 'INVALID'}`, () => {
      const q4 = parseQuantity(p.qty);
      expect(isQuantityRepresentable(q4, p.unitDecimals)).toBe(p.valid);
      expect(codeOf(() => assertQuantityRepresentable(q4, p.unitDecimals))).toBe(p.valid ? undefined : 'inventory.quantity_precision_invalid');
    });
  }
});

describe('rounding vectors R-01…R-19 (HALF_EVEN, sign-symmetric)', () => {
  for (const r of vectors.rounding) {
    it(`${r.id}: ${r.numerator} / ${r.denominator} at scale ${r.scale} is ${r.halfEven}`, () => {
      const n = parseDecimal(r.numerator);
      const d = parseDecimal(r.denominator);
      const he = roundHalfEvenDecimal(n, d, r.scale);
      expect(he.scale).toBe(r.scale);
      expect(fmtScale(he.units, r.scale)).toBe(r.halfEven);
      // Sign symmetry: negating either operand negates the result.
      expect(roundHalfEvenDecimal({ units: -n.units, scale: n.scale }, d, r.scale).units).toBe(-he.units);
      expect(roundHalfEvenDecimal(n, { units: -d.units, scale: d.scale }, r.scale).units).toBe(-he.units);

      // The HALF_UP column: given exactly when HALF_UP differs or the case is a tie.
      const num = n.units * 10n ** BigInt(d.scale + r.scale);
      const den = d.units * 10n ** BigInt(n.scale);
      const up = fmtScale(halfUp(num, den), r.scale);
      const listed = up !== r.halfEven || isTie(num, den);
      expect(r.halfUp).toBe(listed ? up : null);
    });
  }

  it('R-01…R-06 and R-14 are the ties the parity suite pins (T-05.2)', () => {
    const ties = vectors.rounding.filter((r) => {
      const n = parseDecimal(r.numerator);
      const d = parseDecimal(r.denominator);
      return isTie(n.units * 10n ** BigInt(d.scale + r.scale), d.units * 10n ** BigInt(n.scale));
    });
    expect(ties.map((r) => r.id)).toEqual(expect.arrayContaining(['R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06', 'R-14']));
    expect(ties.every((r) => r.halfUp !== null)).toBe(true);
  });
});

/**
 * R3 step 6's arithmetic for a priced inbound or an outbound movement, with no
 * A-26 quantity bound. CTRL-FLUSH lies outside the primitive's domain
 * (|q| >= 10^10, A-26 as amended), so R3 refuses it and the database suites
 * seed it raw; this is the twin of that raw seed, and it still predicts the
 * residual the flush takes (§4, T-10.N).
 */
function unboundedStep(state: StockState, m: MovementInput): { value: bigint; unitCostSnapshot: bigint | null; next: StockState } {
  let value: bigint;
  let unitCostSnapshot: bigint;
  if (m.qtyQ4 > 0n && m.costC10 !== null) {
    value = m.value ?? roundHalfEven(m.qtyQ4 * m.costC10, Q4_TIMES_C10);
    unitCostSnapshot = m.costC10;
  } else if (m.qtyQ4 < 0n && m.costC10 === null && m.value === null && state.avg !== null && -m.qtyQ4 <= state.onHand) {
    const taken = -m.qtyQ4;
    value = taken === state.onHand ? -state.valuation : -roundHalfEven(taken * state.avg, Q4_TIMES_C10);
    unitCostSnapshot = state.avg;
  } else {
    throw new Error('a control uses only priced inbound and covered outbound steps');
  }
  const onHand = state.onHand + m.qtyQ4;
  const valuation = state.valuation + value;
  return { value, unitCostSnapshot, next: { onHand, valuation, avg: averageUnitCost(valuation, onHand, state.avg), lastStockSeq: state.lastStockSeq + 1n } };
}

interface Replayed {
  readonly values: readonly bigint[];
  readonly finals: ReadonlyMap<string, StockState>;
  readonly stored: ReadonlyMap<string, readonly StoredMovement[]>;
  readonly before: readonly StockState[];
}

/**
 * Replays a scenario through the package, asserting every step's expectation
 * as text. A control (`bounded = false`) goes through `unboundedStep`.
 */
function replay(sc: Scenario, bounded = true): Replayed {
  const states = new Map<string, StockState>(sc.keys.map((k) => [k, EMPTY_STOCK_STATE]));
  const stored = new Map<string, StoredMovement[]>(sc.keys.map((k) => [k, []]));
  const values: bigint[] = [];
  const snapshots: (bigint | null)[] = [];
  const before: StockState[] = [];
  sc.steps.forEach((s, i) => {
    const where = `${sc.id} step ${i + 1}`;
    const state = states.get(s.key);
    if (state === undefined) throw new Error(`${where}: unknown key`);
    before.push(state);
    const qty = parseQuantity(s.qty);
    const cost = s.unitCost === null ? null : parseUnitCost(s.unitCost);
    const supplied = s.value === null ? null : parseMinor(s.value);

    let value: bigint;
    let snapshot: bigint | null;
    let next: StockState;
    if (s.seededByOwner === true) {
      // An owner seed stands in for a Phase 4 oversell: its stored value and snapshot are given, not derived.
      expect(s.kind, where).toBe('adjustment');
      expect(s.reason, where).toBe('seed');
      if (supplied === null || cost === null) throw new Error(`${where}: a seed states its value and cost`);
      value = supplied;
      snapshot = cost;
      next = applyMovement(state, qty, value);
    } else {
      if (s.catchUp !== undefined) {
        expect(s.kind, where).toBe('negative_inventory_cost_adjustment');
        const c = s.catchUp;
        expect(catchUpValue(parseQuantity(c.qtyCovered), parseUnitCost(c.actual), parseUnitCost(c.provisional)), where).toBe(supplied);
      }
      let pairedOut: { value: bigint; costC10: bigint; qtyQ4: bigint } | undefined;
      if (s.pairOf !== undefined) {
        expect(s.kind, where).toBe('transfer_in');
        const idx = s.pairOf - 1;
        const out = sc.steps[idx];
        const outValue = values[idx];
        const outSnapshot = snapshots[idx];
        if (out === undefined || outValue === undefined || outSnapshot === undefined || outSnapshot === null)
          throw new Error(`${where}: pairOf names no stored leg`);
        expect(idx, where).toBeLessThan(i);
        expect(out.kind, where).toBe('transfer_out');
        expect(out.key, where).not.toBe(s.key);
        pairedOut = { value: outValue, costC10: outSnapshot, qtyQ4: parseQuantity(out.qty) };
      }
      const input: MovementInput = { kind: s.kind, qtyQ4: qty, costC10: cost, value: supplied, pairedOut };
      const r = bounded ? simulateMovement(state, input) : unboundedStep(state, input);
      value = r.value;
      snapshot = r.unitCostSnapshot;
      next = r.next;
    }
    if (s.kind === 'damage' || (s.kind === 'adjustment' && s.seededByOwner !== true)) expect(s.reason, where).toBe('vector');

    expect(
      {
        value: formatMinor(value),
        unitCostSnapshot: snapshot === null ? null : formatUnitCost(snapshot),
        onHand: formatQuantity(next.onHand),
        valuation: formatMinor(next.valuation),
        avg: next.avg === null ? null : formatUnitCost(next.avg),
        stockSeq: next.lastStockSeq,
      },
      where,
    ).toEqual({ ...s.expect, stockSeq: BigInt(s.expect.stockSeq) });

    values.push(value);
    snapshots.push(snapshot);
    stored.get(s.key)?.push({ stockSeq: next.lastStockSeq, qtyQ4: qty, value });
    states.set(s.key, next);
  });
  return { values, finals: states, stored, before };
}

function sum(xs: readonly bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}

describe.each([...vectors.scenarios.map((sc) => [sc.id, sc, true] as const), ...vectors.controls.map((sc) => [sc.id, sc, false] as const)])(
  'scenario %s',
  (_id, sc, bounded) => {
    it(
      bounded
        ? 'every stored value, snapshot, cache state and stock_seq equals the TypeScript simulation'
        : 'every stored value, snapshot, cache state and stock_seq equals the unbounded TypeScript twin of the raw seed',
      () => {
        replay(sc, bounded);
      },
    );

    if (bounded) {
      it('the rebuild (Σ stored values in stock_seq order) equals the cache of every key', () => {
        const { finals, stored } = replay(sc);
        for (const k of sc.keys) {
          expect(foldMovements(stored.get(k) ?? []), `${sc.id} ${k}`).toEqual(finals.get(k));
        }
      });
    } else {
      it('lies outside the A-26 domain: every step and the rebuild refuse with inventory.quantity_out_of_range, as R3 does', () => {
        const { before, stored } = replay(sc, false);
        sc.steps.forEach((s, i) => {
          const state = before[i];
          if (state === undefined) throw new Error('missing state');
          const input: MovementInput = {
            kind: s.kind,
            qtyQ4: parseQuantity(s.qty),
            costC10: s.unitCost === null ? null : parseUnitCost(s.unitCost),
            value: s.value === null ? null : parseMinor(s.value),
          };
          expect(
            codeOf(() => simulateMovement(state, input)),
            `${sc.id} step ${i + 1}`,
          ).toBe('inventory.quantity_out_of_range');
        });
        for (const k of sc.keys) expect(codeOf(() => foldMovements(stored.get(k) ?? []))).toBe('inventory.quantity_out_of_range');
      });
    }

    it('journal, GL and reconciliation are integer equalities with no rounding and no 6100 line', () => {
      const { values, finals } = replay(sc, bounded);
      const movementSum = sum(values);
      const cacheSum = sum(sc.keys.map((k) => finals.get(k)?.valuation ?? 0n));
      expect(formatMinor(movementSum)).toBe(sc.reconciliation.sumMovementValues);
      expect(formatMinor(cacheSum)).toBe(sc.reconciliation.sumCacheValuation);
      expect(movementSum).toBe(cacheSum);

      expect('none' in sc.journal).toBe(false);
      if ('none' in sc.journal) return;
      // A transfer posts no entry (P3-AL-14); every other movement's line IS its stored integer.
      const posting = values.filter((_, i) => {
        const kind = sc.steps[i]?.kind;
        return kind !== 'transfer_out' && kind !== 'transfer_in';
      });
      expect(sc.journal.inventoryLineAmounts).toEqual(posting.map(formatMinor));
      expect(sc.journal.postedLineCount).toBe(posting.filter((v) => v !== 0n).length);
      expect(sc.journal.rounding6100Lines).toBe(0);
      expect(formatMinor(sum(posting))).toBe(sc.journal.glInventory);
      // GL = Σ movements = Σ cache: transfer legs cancel exactly.
      expect(sum(posting)).toBe(movementSum);
    });

    if (sc.withdrawnAggregate !== undefined) {
      const agg = sc.withdrawnAggregate;
      it('the withdrawn aggregate rule rounds Σ exact values once, and is recorded, not used', () => {
        let exact = 0n; // Σ qty × cost at scale 14
        for (const s of sc.steps) {
          if (s.unitCost === null || s.value !== null) throw new Error('aggregate scenarios are computed purchases only');
          exact += parseQuantity(s.qty) * parseUnitCost(s.unitCost);
        }
        const recorded = parseDecimal(agg.exact);
        expect(recorded.units * 10n ** BigInt(14 - recorded.scale)).toBe(exact);
        expect(formatMinor(roundHalfEven(exact, Q4_TIMES_C10))).toBe(agg.roundedHalfEven);
      });
    }

    if (sc.cycle !== undefined) {
      const cycle = sc.cycle;
      it('over a full receive-then-deplete cycle, total outbound equals total inbound', () => {
        const { values, finals } = replay(sc, bounded);
        const inbound = sum(values.filter((v) => v > 0n));
        const outbound = -sum(values.filter((v) => v < 0n));
        expect(formatMinor(inbound)).toBe(cycle.totalInbound);
        expect(formatMinor(outbound)).toBe(cycle.totalOutbound);
        expect(inbound).toBe(outbound);
        for (const k of sc.keys) expect(finals.get(k)?.onHand).toBe(0n);
      });
    }

    if (sc.cogs !== undefined) {
      const cogs = sc.cogs;
      it('COGS is the provisional (seed) cost plus every catch-up', () => {
        const { values } = replay(sc, bounded);
        const cost = -sum(values.filter((_, i) => sc.steps[i]?.seededByOwner === true || sc.steps[i]?.catchUp !== undefined));
        expect(formatMinor(cost)).toBe(cogs);
      });
    }
  },
);

describe('what the vectors prove together (T-09, T-10, T-06.N)', () => {
  const byId = (id: string): Scenario => {
    const sc = [...vectors.scenarios, ...vectors.controls].find((s) => s.id === id);
    if (sc === undefined) throw new Error(`no scenario ${id}`);
    return sc;
  };
  const gl = (id: string): string => {
    const j = byId(id).journal;
    if ('none' in j) throw new Error('no journal');
    return j.glInventory;
  };

  it('B and C: per-operation rounding and the withdrawn aggregate genuinely disagree (1 ≠ 2, 1 ≠ 0); I coincides', () => {
    expect(byId('B').withdrawnAggregate?.roundedHalfEven).toBe('1');
    expect(gl('B')).toBe('2');
    expect(byId('C').withdrawnAggregate?.roundedHalfEven).toBe('1');
    expect(gl('C')).toBe('0');
    expect(byId('I').withdrawnAggregate?.roundedHalfEven).toBe(gl('I'));
  });

  it("D and E: ties go to even, where PostgreSQL's round() would give 1 and 2", () => {
    for (const [id, stored, up] of [
      ['D', 0n, 1n],
      ['E', 2n, 2n],
    ] as const) {
      const s = byId(id).steps[0];
      if (s === undefined || s.unitCost === null) throw new Error('missing step');
      const exact = parseQuantity(s.qty) * parseUnitCost(s.unitCost);
      expect(isTie(exact, Q4_TIMES_C10)).toBe(true);
      expect(roundHalfEven(exact, Q4_TIMES_C10)).toBe(stored);
      expect(halfUp(exact, Q4_TIMES_C10)).toBe(up);
    }
  });

  it('H: the transfer legs cancel exactly, so business valuation is unchanged by the transfer', () => {
    const { values } = replay(byId('H'));
    expect(values.slice(2)).toEqual([-7n, 7n]);
    expect(sum(values.slice(2))).toBe(0n);
  });

  it('N-01: under the derived-average law a transfer that does not terminate the average changes it (F: 3.3333333333 → 3.5000000000)', () => {
    const f = byId('F').steps;
    expect(f[0]?.expect.avg).toBe('3.3333333333');
    expect(f[1]?.expect.avg).toBe('3.5000000000');
  });

  it('GOLD-72: the key is transiently zero-with-value between the receipt and its catch-up, and ends at zero/zero', () => {
    const steps = byId('AL08-CATCHUP-GOLD72').steps;
    expect([steps[3]?.expect.onHand, steps[3]?.expect.valuation]).toEqual(['0.0000', '180']);
    expect([steps[4]?.expect.onHand, steps[4]?.expect.valuation, steps[4]?.expect.avg]).toEqual(['0.0000', '0', '100.0000000000']);
  });

  it('CTRL-FLUSH: the flush takes the residual 1 that HALF_EVEN(q × avg) cannot see — the forbidden reconstruction gives 0 ≠ 1', () => {
    const sc = byId('CTRL-FLUSH');
    const { before, values } = replay(sc, false);
    const held = before[1];
    const damage = sc.steps[1];
    if (held === undefined || held.avg === null || damage === undefined) throw new Error('missing state');
    expect(held.valuation).toBe(1n);
    expect(held.avg).toBe(0n);
    const withdrawn = roundHalfEven(-parseQuantity(damage.qty) * held.avg, Q4_TIMES_C10);
    expect(withdrawn).toBe(0n);
    expect(values[1]).toBe(-1n);
    expect(withdrawn).not.toBe(held.valuation);
  });
});
