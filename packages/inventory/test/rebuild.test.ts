import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import { foldMovements, type StoredMovement } from '../src/rebuild';
import { roundHalfEven } from '../src/rounding';
import { EMPTY_STOCK_STATE, simulateMovement, type MovementInput, type StockState } from '../src/valuation';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return undefined;
}

/** A deterministic 64-bit LCG over bigint — the stream is the same on every run and every machine. */
function rng(seed: bigint): (bound: bigint) => bigint {
  let s = seed;
  return (bound) => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return (s >> 33n) % bound;
  };
}

/**
 * The R5 definition, written independently of `applyMovement`: plain sums of
 * the stored columns, and the average from the running pair at the last
 * `stock_seq` whose running `on_hand` is non-zero.
 */
function r5(movements: readonly StoredMovement[]): StockState {
  let onHand = 0n;
  let valuation = 0n;
  let avg: bigint | null = null;
  for (const m of movements) {
    onHand += m.qtyQ4;
    valuation += m.value;
    if (onHand !== 0n) avg = roundHalfEven(valuation * 10n ** 14n, onHand);
  }
  return { onHand, valuation, avg, lastStockSeq: BigInt(movements.length) };
}

interface Stream {
  readonly finals: ReadonlyMap<string, StockState>;
  readonly stored: ReadonlyMap<string, readonly StoredMovement[]>;
  readonly count: number;
  readonly kinds: ReadonlySet<string>;
}

/**
 * T-06.1's pure half: ≥ 300 movements over K1/K2 and one variant — purchases
 * with 10-dp costs and 2-dp quantities, damages (partial and full),
 * adjustments of both signs, transfers, and value-only movements while
 * on_hand > 0 — each priced by `simulateMovement` exactly as the primitive
 * prices it, the stored rows kept per key.
 */
function generate(seed: bigint, target: number): Stream {
  const next = rng(seed);
  const keys = ['K1', 'K2'] as const;
  const states = new Map<string, StockState>(keys.map((k) => [k, EMPTY_STOCK_STATE]));
  const stored = new Map<string, StoredMovement[]>(keys.map((k) => [k, []]));
  const kinds = new Set<string>();
  let count = 0;

  const apply = (key: string, m: MovementInput): { value: bigint; unitCostSnapshot: bigint | null } => {
    const s = states.get(key) ?? EMPTY_STOCK_STATE;
    const r = simulateMovement(s, m);
    states.set(key, r.next);
    stored.get(key)?.push({ stockSeq: r.next.lastStockSeq, qtyQ4: m.qtyQ4, value: r.value });
    kinds.add(m.qtyQ4 === s.onHand * -1n && m.qtyQ4 < 0n ? `${m.kind}:flush` : m.kind);
    count += 1;
    // on_hand = 0 ⇒ valuation = 0 holds after every movement of this stream (A-22).
    if (r.next.onHand === 0n) expect(r.next.valuation).toBe(0n);
    return r;
  };

  while (count < target) {
    const key = keys[Number(next(2n))] ?? 'K1';
    const other = key === 'K1' ? 'K2' : 'K1';
    const s = states.get(key) ?? EMPTY_STOCK_STATE;
    const roll = next(100n);
    const qty2dp = (next(5000n) + 1n) * 100n; // 0.01 … 50.00 as Q4
    const cost10dp = next(10n ** 13n); // 0 … 999.9999999999 as C10
    if (s.onHand <= 0n || roll < 30n) {
      apply(key, { kind: 'purchase', qtyQ4: qty2dp, costC10: cost10dp, value: roll % 4n === 0n ? next(100000n) : null });
    } else if (roll < 45n) {
      // partial or full damage
      const q = roll % 3n === 0n ? s.onHand : 1n + next(s.onHand);
      apply(key, { kind: 'damage', qtyQ4: -q, costC10: null, value: null });
    } else if (roll < 55n) {
      apply(key, { kind: 'adjustment', qtyQ4: qty2dp, costC10: cost10dp, value: null });
    } else if (roll < 65n) {
      apply(key, { kind: 'adjustment', qtyQ4: -(1n + next(s.onHand)), costC10: null, value: null });
    } else if (roll < 80n) {
      const q = roll % 2n === 0n ? s.onHand : 1n + next(s.onHand);
      const out = apply(key, { kind: 'transfer_out', qtyQ4: -q, costC10: null, value: null });
      if (out.unitCostSnapshot === null) throw new Error('an outbound leg always has a snapshot');
      apply(other, { kind: 'transfer_in', qtyQ4: q, costC10: null, value: null, pairedOut: { value: out.value, costC10: out.unitCostSnapshot, qtyQ4: -q } });
    } else if (roll < 90n) {
      const v = next(2000n) - 1000n;
      if (v !== 0n) apply(key, { kind: 'negative_inventory_cost_adjustment', qtyQ4: 0n, costC10: null, value: v });
    } else {
      apply(key, { kind: 'stocktake', qtyQ4: qty2dp, costC10: cost10dp, value: null });
    }
  }
  return { finals: states, stored, count, kinds };
}

describe('foldMovements — the exact rebuild', () => {
  const stream = generate(20260926n, 400);

  it('the generator covers every class T-06.1 names, over at least 300 movements', () => {
    expect(stream.count).toBeGreaterThanOrEqual(300);
    for (const k of [
      'purchase',
      'damage',
      'damage:flush',
      'adjustment',
      'transfer_out',
      'transfer_out:flush',
      'transfer_in',
      'negative_inventory_cost_adjustment',
      'stocktake',
    ]) {
      expect(stream.kinds.has(k), k).toBe(true);
    }
  });

  it('folding the stored rows reproduces the live state of every key exactly, and so does the independent R5 definition', () => {
    for (const [key, rows] of stream.stored) {
      expect(foldMovements(rows), key).toEqual(stream.finals.get(key));
      expect(r5(rows), key).toEqual(stream.finals.get(key));
    }
  });

  it('every prefix folds to the state the simulation held at that stock_seq', () => {
    for (const rows of stream.stored.values()) {
      for (let n = 0; n <= rows.length; n += 1) {
        expect(foldMovements(rows.slice(0, n))).toEqual(r5(rows.slice(0, n)));
      }
    }
  });

  it('a key that empties and refills carries its average while at zero, then re-derives it (T-06.2)', () => {
    const rows: StoredMovement[] = [
      { stockSeq: 1n, qtyQ4: 30000n, value: 10n },
      { stockSeq: 2n, qtyQ4: -30000n, value: -10n },
    ];
    expect(foldMovements(rows)).toEqual({ onHand: 0n, valuation: 0n, avg: 33333333333n, lastStockSeq: 2n });
    rows.push({ stockSeq: 3n, qtyQ4: 10000n, value: 5n });
    expect(foldMovements(rows)).toEqual({ onHand: 10000n, valuation: 5n, avg: 50000000000n, lastStockSeq: 3n });
  });

  it('no movement folds to the empty state (T-06.3)', () => {
    expect(foldMovements([])).toEqual(EMPTY_STOCK_STATE);
  });

  it('refuses any sequence other than 1..n ascending with inventory.rebuild_sequence_invalid', () => {
    const m = (stockSeq: bigint): StoredMovement => ({ stockSeq, qtyQ4: 10000n, value: 1n });
    for (const seqs of [[2n], [0n], [1n, 3n], [1n, 1n], [2n, 1n], [1n, 2n, 2n], [-1n]]) {
      expect(
        codeOf(() => foldMovements(seqs.map(m))),
        seqs.join(','),
      ).toBe('inventory.rebuild_sequence_invalid');
    }
  });

  it('refuses a stored row that could not exist (qty 0 and value 0)', () => {
    expect(codeOf(() => foldMovements([{ stockSeq: 1n, qtyQ4: 0n, value: 0n }]))).toBe('inventory.movement_shape_invalid');
  });
});
