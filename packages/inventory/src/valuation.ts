/**
 * Moving-weighted-average valuation under the exactness law
 * (P3-AL-08, P3-AL-14, P3-AL-49 §A–§C; PHASE_3_S2_CONTRACT §2.5 R3 step 6 and §4).
 *
 * This is the pure TypeScript twin of the database primitive's per-request
 * step, and it mirrors it exactly. Units: `onHand` and quantities are Q4,
 * `valuation` and values are integer base minor units, `avg` and unit costs
 * are C10 (see `fixed-point.ts`).
 *
 * - A movement's value is an INTEGER, produced by one HALF_EVEN at that
 *   movement, by a supplied document share, by the depletion flush, or by
 *   negating a paired `transfer_out` (§C).
 * - The cached valuation is only ever the SUM of stored values. The average
 *   is derived from (valuation, on_hand) and may price a later outbound
 *   movement, but it is never used to rebuild valuation (§B). Consequently,
 *   when an average does not terminate, a transfer changes the source key's
 *   average (N-01): vector F's 3.3333333333 becomes 3.5000000000.
 * - A key at zero keeps its last average as a cost reference and carries the
 *   valuation its movements left; the deferred database trigger, not this
 *   step, enforces `on_hand = 0 ⇒ valuation = 0` at COMMIT (A-22), because a
 *   receipt followed by its catch-up is transiently zero-with-value (GOLD-72).
 */
import { InventoryError, type InventoryErrorCode } from './errors';
import { COST_LIMIT_C10, QTY_LIMIT_Q4, VALUE_LIMIT_MINOR } from './fixed-point';
import { roundHalfEven } from './rounding';

export type MovementKind =
  | 'purchase'
  | 'supplier_return'
  | 'adjustment'
  | 'damage'
  | 'transfer_out'
  | 'transfer_in'
  | 'stocktake'
  | 'inventory_opening'
  | 'negative_inventory_cost_adjustment'
  | 'purchase_reversal';

/** The `qty_sign` of each kind, exactly as `stock_movement_kinds` is seeded (§2.2). */
export const MOVEMENT_KIND_QTY_SIGN: Readonly<Record<MovementKind, 'positive' | 'negative' | 'either' | 'zero'>> = Object.freeze({
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

export interface StockState {
  readonly onHand: bigint;
  readonly valuation: bigint;
  readonly avg: bigint | null;
  readonly lastStockSeq: bigint;
}

export const EMPTY_STOCK_STATE: StockState = Object.freeze({ onHand: 0n, valuation: 0n, avg: null, lastStockSeq: 0n });

/** 10^14 = Q4 scale (10^4) × C10 scale (10^10): the denominator that takes `q4 × c10` to minor units. */
const Q4_TIMES_C10 = 10n ** 14n;

function refuse(code: InventoryErrorCode, message: string): never {
  throw new InventoryError(code, message);
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function assertCost(costC10: bigint): void {
  if (costC10 < 0n || costC10 >= COST_LIMIT_C10) refuse('inventory.cost_invalid', 'unit cost is negative or out of range');
}

function assertQuantityInRange(q4: bigint): void {
  if (absBig(q4) >= QTY_LIMIT_Q4) refuse('inventory.quantity_out_of_range', 'quantity is out of range');
}

function assertValueInRange(value: bigint): void {
  if (absBig(value) > VALUE_LIMIT_MINOR) refuse('inventory.value_out_of_range', 'value is out of range');
}

/**
 * The derived average in C10: `HALF_EVEN(valuation / on_hand, 10)` when
 * `on_hand ≠ 0`, else the carried average unchanged.
 */
export function averageUnitCost(valuation: bigint, onHandQ4: bigint, carried: bigint | null): bigint | null {
  // valuation / (onHandQ4 · 10^-4) in units of 10^-10  =  valuation · 10^14 / onHandQ4
  return onHandQ4 !== 0n ? roundHalfEven(valuation * Q4_TIMES_C10, onHandQ4) : carried;
}

/** An inbound movement's value with no supplied share: `HALF_EVEN(qty × cost, 0)`. */
export function inboundValue(qtyQ4: bigint, costC10: bigint): bigint {
  if (qtyQ4 <= 0n) refuse('inventory.movement_shape_invalid', 'an inbound quantity must be positive');
  assertQuantityInRange(qtyQ4);
  assertCost(costC10);
  return roundHalfEven(qtyQ4 * costC10, Q4_TIMES_C10);
}

/**
 * An outbound movement (`qty < 0`) priced at the key's current average:
 * - more than on hand is `inventory.insufficient_stock`;
 * - no average, or a negative one, is `inventory.arithmetic_invalid` (R3's
 *   defensive refusal, before the flush exactly as in the database);
 * - exactly on hand is the flush, `−valuation` — the entire remaining value;
 * - otherwise `−HALF_EVEN(|qty| × avg, 0)`.
 * The snapshot is the current average in every case.
 */
export function outboundValue(state: StockState, qtyQ4: bigint): { value: bigint; unitCostSnapshot: bigint } {
  if (qtyQ4 >= 0n) refuse('inventory.movement_shape_invalid', 'an outbound quantity must be negative');
  assertQuantityInRange(qtyQ4);
  const taken = -qtyQ4;
  if (taken > state.onHand) refuse('inventory.insufficient_stock', 'outbound quantity exceeds the quantity on hand');
  const avg = state.avg;
  // R3: `IF v_level_avg IS NULL OR v_level_avg < 0` — checked before the flush, as there.
  if (avg === null || avg < 0n) refuse('inventory.arithmetic_invalid', 'no usable average to price an outbound movement');
  if (taken === state.onHand) return { value: -state.valuation, unitCostSnapshot: avg };
  return { value: -roundHalfEven(taken * avg, Q4_TIMES_C10), unitCostSnapshot: avg };
}

/** A `transfer_in` value is the exact negation of its paired stored `transfer_out` value — copied, never recomputed (P3-AL-14). */
export function transferInValue(transferOutValue: bigint): bigint {
  return -transferOutValue;
}

/**
 * The value-only deficit catch-up, per coverage:
 * `−HALF_EVEN(qty_covered × (actual − provisional), 0)`. An actual cost above
 * the provisional one takes value OUT of inventory (`Dr COGS / Cr Inventory`,
 * GOLD-54), hence the sign.
 */
export function catchUpValue(qtyCoveredQ4: bigint, actualC10: bigint, provisionalC10: bigint): bigint {
  if (qtyCoveredQ4 <= 0n) refuse('inventory.movement_shape_invalid', 'a covered quantity must be positive');
  assertQuantityInRange(qtyCoveredQ4);
  assertCost(actualC10);
  assertCost(provisionalC10);
  return -roundHalfEven(qtyCoveredQ4 * (actualC10 - provisionalC10), Q4_TIMES_C10);
}

/**
 * Adds one stored movement to a key: `on_hand += qty`, `valuation += value`,
 * the average re-derived (or carried at zero), `last_stock_seq + 1`, with the
 * A-26 bounds, the derived average's included (|avg| < 10^18, as R3). A
 * movement with both quantity and value zero cannot exist
 * (`stock_movements_value_only_ck`).
 */
export function applyMovement(state: StockState, qtyQ4: bigint, value: bigint): StockState {
  if (qtyQ4 === 0n && value === 0n) refuse('inventory.movement_shape_invalid', 'a movement must change quantity or value');
  assertQuantityInRange(qtyQ4);
  assertValueInRange(value);
  const onHand = state.onHand + qtyQ4;
  const valuation = state.valuation + value;
  assertValueInRange(valuation);
  assertQuantityInRange(onHand);
  const avg = averageUnitCost(valuation, onHand, state.avg);
  // R3: `abs(v_next_avg) >= c_value_limit` — an average of 10^18 or more is out of range.
  if (avg !== null && absBig(avg) >= COST_LIMIT_C10) refuse('inventory.value_out_of_range', 'the resulting average cost is out of range');
  return { onHand, valuation, avg, lastStockSeq: state.lastStockSeq + 1n };
}

export interface MovementInput {
  kind: MovementKind;
  qtyQ4: bigint;
  /** The request's unit cost: required inbound (other than `transfer_in`), NULL otherwise. */
  costC10: bigint | null;
  /** A supplied value: a document share (`purchase` / `inventory_opening` only) or a value-only amount; NULL otherwise. */
  value: bigint | null;
  /** For `transfer_in` only: the stored `transfer_out` leg it negates. */
  pairedOut?: { value: bigint; costC10: bigint; qtyQ4: bigint };
}

/**
 * One request through R3 step 6 b–d: the kind's quantity sign, the value by
 * class, then the bounds and the next state. The movement kind's reason and
 * the key's identity are the database's concern and are not modelled here.
 *
 * The package has no `quantity_sign_invalid` / `transfer_pair_missing` code;
 * a sign violation and a missing pair are refused as
 * `inventory.movement_shape_invalid`.
 */
export function simulateMovement(state: StockState, m: MovementInput): { value: bigint; unitCostSnapshot: bigint | null; next: StockState } {
  const q = m.qtyQ4;
  assertQuantityInRange(q);
  const sign = MOVEMENT_KIND_QTY_SIGN[m.kind];
  const signOk = sign === 'positive' ? q > 0n : sign === 'negative' ? q < 0n : sign === 'either' ? q !== 0n : sign === 'zero' ? q === 0n : false;
  if (!signOk) refuse('inventory.movement_shape_invalid', 'quantity sign is not allowed for this movement kind');

  let value: bigint;
  let unitCostSnapshot: bigint | null;
  if (q === 0n) {
    // Value-only: no cost, a supplied non-zero value, no snapshot.
    if (m.costC10 !== null || m.value === null || m.value === 0n) refuse('inventory.movement_shape_invalid', 'a value-only movement needs a value and no cost');
    value = m.value;
    unitCostSnapshot = null;
  } else if (m.kind === 'transfer_in') {
    if (m.costC10 !== null || m.value !== null) refuse('inventory.movement_shape_invalid', 'a transfer_in carries no cost or value of its own');
    const out = m.pairedOut;
    if (out === undefined) refuse('inventory.movement_shape_invalid', 'a transfer_in needs its paired transfer_out');
    if (out.qtyQ4 !== -q) refuse('inventory.transfer_pair_mismatch', 'transfer legs do not carry opposite quantities');
    value = transferInValue(out.value);
    unitCostSnapshot = out.costC10;
  } else if (q < 0n) {
    if (m.costC10 !== null || m.value !== null) refuse('inventory.movement_shape_invalid', 'an outbound movement is priced at the average');
    ({ value, unitCostSnapshot } = outboundValue(state, q));
  } else {
    if (m.costC10 === null) refuse('inventory.movement_shape_invalid', 'an inbound movement needs a unit cost');
    assertCost(m.costC10);
    if (m.value !== null) {
      if (m.kind !== 'purchase' && m.kind !== 'inventory_opening') refuse('inventory.movement_shape_invalid', 'only a priced document supplies a value');
      if (m.value < 0n) refuse('inventory.movement_shape_invalid', 'a supplied inbound value must not be negative');
      value = m.value;
    } else {
      value = inboundValue(q, m.costC10);
    }
    unitCostSnapshot = m.costC10;
  }

  return { value, unitCostSnapshot, next: applyMovement(state, q, value) };
}
