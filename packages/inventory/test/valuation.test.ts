import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import { COST_LIMIT_C10, QTY_LIMIT_Q4, VALUE_LIMIT_MINOR } from '../src/fixed-point';
import {
  applyMovement,
  averageUnitCost,
  catchUpValue,
  EMPTY_STOCK_STATE,
  inboundValue,
  MOVEMENT_KIND_QTY_SIGN,
  outboundValue,
  simulateMovement,
  transferInValue,
  type MovementInput,
  type StockState,
} from '../src/valuation';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return undefined;
}

const Q = (units: bigint): bigint => units * 10000n; // whole units → Q4
const C = (minor: bigint): bigint => minor * 10000000000n; // whole minor → C10

function state(onHand: bigint, valuation: bigint, avg: bigint | null, lastStockSeq = 1n): StockState {
  return { onHand, valuation, avg, lastStockSeq };
}

describe('EMPTY_STOCK_STATE and the kind registry mirror', () => {
  it('is 0 / 0 / null / 0 and frozen', () => {
    expect(EMPTY_STOCK_STATE).toEqual({ onHand: 0n, valuation: 0n, avg: null, lastStockSeq: 0n });
    expect(Object.isFrozen(EMPTY_STOCK_STATE)).toBe(true);
  });

  it('MOVEMENT_KIND_QTY_SIGN is exactly the §2.2 seed', () => {
    expect(MOVEMENT_KIND_QTY_SIGN).toEqual({
      purchase: 'positive',
      supplier_return: 'negative',
      adjustment: 'either',
      damage: 'negative',
      transfer_out: 'negative',
      transfer_in: 'positive',
      stocktake: 'either',
      inventory_opening: 'positive',
      negative_inventory_cost_adjustment: 'zero',
      purchase_reversal: 'negative',
    });
    expect(Object.isFrozen(MOVEMENT_KIND_QTY_SIGN)).toBe(true);
  });
});

describe('averageUnitCost', () => {
  it('derives HALF_EVEN(valuation / on_hand, 10), signs included', () => {
    expect(averageUnitCost(2500n, Q(15n), null)).toBe(1666666666667n);
    expect(averageUnitCost(-520n, Q(-6n), null)).toBe(866666666667n);
    expect(averageUnitCost(0n, Q(-5n), null)).toBe(0n);
    expect(averageUnitCost(1n, 300000000000000n, null)).toBe(0n); // R-19
    expect(averageUnitCost(-7n, Q(2n), null)).toBe(-35000000000n);
  });

  it('carries the previous average when on_hand is zero, whatever the valuation', () => {
    expect(averageUnitCost(0n, 0n, C(3n))).toBe(C(3n));
    expect(averageUnitCost(180n, 0n, C(100n))).toBe(C(100n));
    expect(averageUnitCost(0n, 0n, null)).toBeNull();
  });
});

describe('inboundValue', () => {
  it('is one HALF_EVEN of qty × cost at the movement', () => {
    expect(inboundValue(Q(1n), 6000000000n)).toBe(1n); // 0.6
    expect(inboundValue(Q(1n), 4000000000n)).toBe(0n); // 0.4
    expect(inboundValue(Q(1n), 5000000000n)).toBe(0n); // 0.5 → even
    expect(inboundValue(Q(1n), 15000000000n)).toBe(2n); // 1.5 → even
    expect(inboundValue(Q(1n), 25000000000n)).toBe(2n); // 2.5 → even
    expect(inboundValue(Q(3n), 1105000000000n)).toBe(332n); // 331.5 → even
    expect(inboundValue(Q(10n), C(200n))).toBe(2000n);
  });

  it('refuses a non-positive quantity, an invalid cost and an out-of-range quantity', () => {
    expect(codeOf(() => inboundValue(0n, C(1n)))).toBe('inventory.movement_shape_invalid');
    expect(codeOf(() => inboundValue(Q(-1n), C(1n)))).toBe('inventory.movement_shape_invalid');
    expect(codeOf(() => inboundValue(Q(1n), -1n))).toBe('inventory.cost_invalid');
    expect(codeOf(() => inboundValue(Q(1n), COST_LIMIT_C10))).toBe('inventory.cost_invalid');
    expect(codeOf(() => inboundValue(QTY_LIMIT_Q4, C(1n)))).toBe('inventory.quantity_out_of_range');
  });
});

describe('outboundValue', () => {
  const held = state(Q(2n), 7n, 35000000000n);

  it('prices a partial issue at −HALF_EVEN(|qty| × avg) with the average as snapshot', () => {
    expect(outboundValue(held, Q(-1n))).toEqual({ value: -4n, unitCostSnapshot: 35000000000n }); // 3.5 → 4
    expect(outboundValue(state(Q(3n), 10n, 33333333333n), Q(-1n))).toEqual({ value: -3n, unitCostSnapshot: 33333333333n });
  });

  it('flushes the entire remaining valuation when the issue empties the key', () => {
    expect(outboundValue(held, Q(-2n))).toEqual({ value: -7n, unitCostSnapshot: 35000000000n });
    expect(outboundValue(state(Q(1n), 3n, C(3n)), Q(-1n))).toEqual({ value: -3n, unitCostSnapshot: C(3n) });
  });

  it('refuses more than on hand, including any issue from a zero or negative key', () => {
    expect(codeOf(() => outboundValue(held, Q(-2n) - 1n))).toBe('inventory.insufficient_stock');
    expect(codeOf(() => outboundValue(state(0n, 0n, C(3n)), -1n))).toBe('inventory.insufficient_stock');
    expect(codeOf(() => outboundValue(state(Q(-5n), -500n, C(100n)), -1n))).toBe('inventory.insufficient_stock');
  });

  it('refuses a non-negative quantity and a missing average', () => {
    expect(codeOf(() => outboundValue(held, 0n))).toBe('inventory.movement_shape_invalid');
    expect(codeOf(() => outboundValue(held, 1n))).toBe('inventory.movement_shape_invalid');
    expect(codeOf(() => outboundValue(state(Q(2n), 7n, null), Q(-1n)))).toBe('inventory.arithmetic_invalid');
  });
});

describe('transferInValue and catchUpValue', () => {
  it('a transfer_in value is the exact negation of the stored transfer_out value', () => {
    expect(transferInValue(-7n)).toBe(7n);
    expect(transferInValue(-500n)).toBe(500n);
    expect(transferInValue(0n)).toBe(0n);
  });

  it('a catch-up is −HALF_EVEN(q × (actual − provisional)): out of inventory when actual > provisional, into it when below', () => {
    expect(catchUpValue(Q(5n), C(120n), C(100n))).toBe(-100n); // GOLD-54
    expect(catchUpValue(Q(5n), C(120n), 0n)).toBe(-600n); // GOLD-55
    expect(catchUpValue(Q(4n), C(120n), C(100n))).toBe(-80n); // GOLD-72
    expect(catchUpValue(Q(6n), C(130n), C(100n))).toBe(-180n); // GOLD-72
    expect(catchUpValue(Q(5n), C(100n), C(120n))).toBe(100n);
    expect(catchUpValue(Q(1n), C(7n), C(7n))).toBe(0n);
    // 1 × (0.5 − 0) = 0.5 → 0, and 1 × (0 − 0.5) = −0.5 → 0: symmetric ties
    expect(catchUpValue(Q(1n), 5000000000n, 0n)).toBe(0n);
    expect(catchUpValue(Q(1n), 0n, 5000000000n)).toBe(0n);
    expect(catchUpValue(Q(1n), 15000000000n, 0n)).toBe(-2n);
    expect(catchUpValue(Q(1n), 0n, 15000000000n)).toBe(2n);
  });

  it('refuses a non-positive covered quantity and an invalid cost', () => {
    expect(codeOf(() => catchUpValue(0n, C(1n), 0n))).toBe('inventory.movement_shape_invalid');
    expect(codeOf(() => catchUpValue(Q(1n), -1n, 0n))).toBe('inventory.cost_invalid');
    expect(codeOf(() => catchUpValue(Q(1n), 0n, COST_LIMIT_C10))).toBe('inventory.cost_invalid');
  });
});

describe('applyMovement', () => {
  it('adds stored values, derives the average and advances the sequence', () => {
    const s1 = applyMovement(EMPTY_STOCK_STATE, Q(10n), 1000n);
    expect(s1).toEqual({ onHand: Q(10n), valuation: 1000n, avg: C(100n), lastStockSeq: 1n });
    const s2 = applyMovement(s1, Q(-10n), -1000n);
    expect(s2).toEqual({ onHand: 0n, valuation: 0n, avg: C(100n), lastStockSeq: 2n });
    const s3 = applyMovement(s2, 0n, 5n); // value-only at zero: transient zero-with-value (A-22 owns the COMMIT check)
    expect(s3).toEqual({ onHand: 0n, valuation: 5n, avg: C(100n), lastStockSeq: 3n });
  });

  it('keeps the A-26 bounds', () => {
    expect(applyMovement(EMPTY_STOCK_STATE, 1n, VALUE_LIMIT_MINOR).valuation).toBe(VALUE_LIMIT_MINOR);
    expect(codeOf(() => applyMovement(EMPTY_STOCK_STATE, 1n, VALUE_LIMIT_MINOR + 1n))).toBe('inventory.value_out_of_range');
    expect(codeOf(() => applyMovement(EMPTY_STOCK_STATE, 1n, -VALUE_LIMIT_MINOR - 1n))).toBe('inventory.value_out_of_range');
    expect(codeOf(() => applyMovement(state(1n, VALUE_LIMIT_MINOR, 0n), 1n, 1n))).toBe('inventory.value_out_of_range');
    expect(applyMovement(EMPTY_STOCK_STATE, QTY_LIMIT_Q4 - 1n, 1n).onHand).toBe(QTY_LIMIT_Q4 - 1n);
    expect(codeOf(() => applyMovement(EMPTY_STOCK_STATE, QTY_LIMIT_Q4, 1n))).toBe('inventory.quantity_out_of_range');
    expect(codeOf(() => applyMovement(state(QTY_LIMIT_Q4 - 1n, 1n, 0n), 1n, 0n))).toBe('inventory.quantity_out_of_range');
  });

  it('refuses a movement that changes neither quantity nor value', () => {
    expect(codeOf(() => applyMovement(EMPTY_STOCK_STATE, 0n, 0n))).toBe('inventory.movement_shape_invalid');
  });
});

describe('simulateMovement — R3 step 6 b–d', () => {
  const held = state(Q(2n), 7n, 35000000000n, 2n);
  const base: MovementInput = { kind: 'purchase', qtyQ4: Q(1n), costC10: C(1n), value: null };

  it('prices each class as §2.5 R3 states', () => {
    // inbound computed, inbound supplied share, outbound, value-only
    expect(simulateMovement(held, base)).toEqual({ value: 1n, unitCostSnapshot: C(1n), next: state(Q(3n), 8n, 26666666667n, 3n) });
    expect(simulateMovement(held, { ...base, kind: 'inventory_opening', value: 9n }).value).toBe(9n);
    expect(simulateMovement(held, { ...base, kind: 'stocktake' }).value).toBe(1n);
    expect(simulateMovement(held, { kind: 'supplier_return', qtyQ4: Q(-1n), costC10: null, value: null })).toEqual({
      value: -4n,
      unitCostSnapshot: 35000000000n,
      next: state(Q(1n), 3n, C(3n), 3n),
    });
    expect(simulateMovement(held, { kind: 'negative_inventory_cost_adjustment', qtyQ4: 0n, costC10: null, value: -2n })).toEqual({
      value: -2n,
      unitCostSnapshot: null,
      next: state(Q(2n), 5n, 25000000000n, 3n),
    });
    expect(
      simulateMovement(EMPTY_STOCK_STATE, {
        kind: 'transfer_in',
        qtyQ4: Q(2n),
        costC10: null,
        value: null,
        pairedOut: { value: -7n, costC10: 35000000000n, qtyQ4: Q(-2n) },
      }),
    ).toEqual({ value: 7n, unitCostSnapshot: 35000000000n, next: state(Q(2n), 7n, 35000000000n, 1n) });
  });

  it('refuses a quantity sign the kind does not allow', () => {
    const cases: MovementInput[] = [
      { kind: 'purchase', qtyQ4: Q(-1n), costC10: null, value: null },
      { kind: 'damage', qtyQ4: Q(1n), costC10: C(1n), value: null },
      { kind: 'transfer_out', qtyQ4: 0n, costC10: null, value: 1n },
      { kind: 'adjustment', qtyQ4: 0n, costC10: null, value: 1n },
      { kind: 'stocktake', qtyQ4: 0n, costC10: null, value: 1n },
      { kind: 'negative_inventory_cost_adjustment', qtyQ4: Q(1n), costC10: C(1n), value: null },
      { kind: 'negative_inventory_cost_adjustment', qtyQ4: Q(-1n), costC10: null, value: null },
    ];
    for (const m of cases)
      expect(
        codeOf(() => simulateMovement(held, m)),
        m.kind,
      ).toBe('inventory.movement_shape_invalid');
  });

  it('refuses cost/value presence against the class', () => {
    const cases: MovementInput[] = [
      { kind: 'negative_inventory_cost_adjustment', qtyQ4: 0n, costC10: C(1n), value: 1n },
      { kind: 'negative_inventory_cost_adjustment', qtyQ4: 0n, costC10: null, value: null },
      { kind: 'negative_inventory_cost_adjustment', qtyQ4: 0n, costC10: null, value: 0n },
      { kind: 'damage', qtyQ4: Q(-1n), costC10: C(1n), value: null },
      { kind: 'damage', qtyQ4: Q(-1n), costC10: null, value: -4n },
      { kind: 'purchase', qtyQ4: Q(1n), costC10: null, value: 1n },
      { kind: 'adjustment', qtyQ4: Q(1n), costC10: C(1n), value: 1n },
      { kind: 'stocktake', qtyQ4: Q(1n), costC10: C(1n), value: 1n },
      { kind: 'purchase', qtyQ4: Q(1n), costC10: C(1n), value: -1n },
      { kind: 'transfer_in', qtyQ4: Q(1n), costC10: C(1n), value: null, pairedOut: { value: -1n, costC10: C(1n), qtyQ4: Q(-1n) } },
      { kind: 'transfer_in', qtyQ4: Q(1n), costC10: null, value: 1n, pairedOut: { value: -1n, costC10: C(1n), qtyQ4: Q(-1n) } },
      { kind: 'transfer_in', qtyQ4: Q(1n), costC10: null, value: null },
    ];
    for (const m of cases)
      expect(
        codeOf(() => simulateMovement(held, m)),
        JSON.stringify(m, (_, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
      ).toBe('inventory.movement_shape_invalid');
  });

  it('refuses a transfer pair whose quantities are not opposite', () => {
    const m: MovementInput = { kind: 'transfer_in', qtyQ4: Q(2n), costC10: null, value: null, pairedOut: { value: -7n, costC10: C(3n), qtyQ4: Q(-1n) } };
    expect(codeOf(() => simulateMovement(EMPTY_STOCK_STATE, m))).toBe('inventory.transfer_pair_mismatch');
  });

  it('refuses an invalid cost, insufficient stock and out-of-range quantities and values', () => {
    expect(codeOf(() => simulateMovement(held, { ...base, costC10: -1n }))).toBe('inventory.cost_invalid');
    expect(codeOf(() => simulateMovement(held, { ...base, costC10: COST_LIMIT_C10 }))).toBe('inventory.cost_invalid');
    expect(codeOf(() => simulateMovement(held, { kind: 'damage', qtyQ4: Q(-3n), costC10: null, value: null }))).toBe('inventory.insufficient_stock');
    expect(codeOf(() => simulateMovement(held, { ...base, qtyQ4: QTY_LIMIT_Q4 }))).toBe('inventory.quantity_out_of_range');
    expect(codeOf(() => simulateMovement(held, { ...base, value: VALUE_LIMIT_MINOR + 1n }))).toBe('inventory.value_out_of_range');
  });

  it('never rounds valuation away: a partial issue plus the flush remove exactly what was received', () => {
    let s = EMPTY_STOCK_STATE;
    s = simulateMovement(s, { kind: 'purchase', qtyQ4: Q(3n), costC10: 33333333333n, value: 10n }).next;
    let out = 0n;
    for (const q of [Q(-1n), Q(-1n), Q(-1n)]) {
      const r = simulateMovement(s, { kind: 'damage', qtyQ4: q, costC10: null, value: null });
      out += r.value;
      s = r.next;
    }
    expect(out).toBe(-10n);
    expect(s).toEqual({ onHand: 0n, valuation: 0n, avg: C(3n), lastStockSeq: 4n });
  });
});
