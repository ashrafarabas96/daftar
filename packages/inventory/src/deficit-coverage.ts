/**
 * Deficit coverage inside a purchase receipt (PHASE_3_S4_CONTRACT A-16 (b)–(f);
 * L:476-512, L:1384-1386; IR §5أ).
 *
 * The pure TypeScript twin of `purchase_cover_deficits`. The service runs it
 * over the open layers and the `stock_levels` row it read (A-07) and BINDS the
 * result — each line's covered quantity and catch-up value — into the
 * `purchase.receive` payload; the routine recomputes the same plan under the
 * stock-key and layer locks and refuses any difference with
 * `inventory.valuation_changed`.
 *
 * Per line, in `line_no` order (one line per variant, L:767):
 *
 * 1. The open layers of the key, FIFO by `(deficit_seq, id)` (L:478), must
 *    hold exactly the key's deficit: `Σ uncovered = max(0, −on_hand)`, else
 *    `inventory.deficit_state_invalid` (a defect class).
 * 2. The purchase movement is applied first: `qty_i` at the supplied value
 *    `s_i` (A-16(f)). The actual cost is its unit-cost snapshot,
 *    `HALF_EVEN(s_i / qty_i, 10)`.
 * 3. Each layer is covered by `c_j = min(uncovered_j, remaining)` until the
 *    line's quantity or the layers run out, with the per-coverage value
 *    `value_j = −HALF_EVEN(c_j × (actual − provisional_j), 0)` (A-16(c)): an
 *    actual cost above the provisional one takes value OUT of Inventory.
 * 4. The zero-crossing flush (A-16(e), TL-6): when the line closes EVERY open
 *    layer of its key exactly (`qty_i = Σ uncovered`, so on-hand after the
 *    purchase movement is 0), its LAST coverage carries `−valuation` of the
 *    key immediately before it instead of the formula, so the key ends at
 *    zero stock with zero value. Without a residue the two are equal.
 * 5. A zero value (TL-5) records the coverage but writes no movement, because
 *    a zero value-only movement cannot exist (`stock_movements_value_only_ck`).
 *
 * The receipt's header total is `N = Σ` of the stored coverage values; a
 * header is written iff anything is covered, and the catch-up entry is posted
 * iff `N ≠ 0` (A-16(i)).
 */
import { InventoryError } from './errors';
import { COST_LIMIT_C10 } from './fixed-point';
import { unitCostC10 } from './purchase-shares';
import { applyMovement, catchUpValue, EMPTY_STOCK_STATE, type StockState } from './valuation';

/** One open deficit layer of the receipt's warehouse, as `negative_inventory_deficits` holds it. */
export interface DeficitLayer {
  readonly deficitId: string;
  readonly variantId: string;
  readonly deficitSeq: bigint;
  /** `uncovered_qty` in Q4; > 0 for an open or partially covered layer. */
  readonly uncoveredQ4: bigint;
  /** `provisional_unit_cost_base_minor` in C10; >= 0. */
  readonly provisionalC10: bigint;
}

/** One receipt line: its variant, quantity and base share. */
export interface CoverageLineInput {
  readonly lineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  readonly baseShareMinor: bigint;
}

/** One coverage row the receipt writes. */
export interface PlannedCoverage {
  readonly deficitId: string;
  readonly deficitSeq: bigint;
  readonly qtyCoveredQ4: bigint;
  readonly provisionalC10: bigint;
  readonly actualC10: bigint;
  /** `−HALF_EVEN(c × (actual − provisional), 0)`: the A-16(c) formula, whatever the stored value. */
  readonly formulaMinor: bigint;
  /** The stored value: the formula, or `−valuation` for the flush. */
  readonly valueMinor: bigint;
  /** True for the single flush-eligible coverage of the line (A-16(e)). */
  readonly flush: boolean;
  /** True iff a value-only movement is written: `valueMinor ≠ 0` (TL-5). */
  readonly movement: boolean;
  /** The layer after this coverage. */
  readonly uncoveredAfterQ4: bigint;
  readonly statusAfter: 'partially_covered' | 'closed';
}

/** One receipt line's plan: its purchase movement and its coverages, in movement order. */
export interface CoverageLinePlan {
  readonly lineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  readonly baseShareMinor: bigint;
  /** The purchase movement's unit-cost snapshot, and the coverages' actual cost. */
  readonly actualC10: bigint;
  /** `Σ qty_covered` of the line: `covered_q4` of the payload. */
  readonly coveredQ4: bigint;
  /** `Σ` of the line's stored coverage values: `catch_up_minor` of the payload. */
  readonly catchUpMinor: bigint;
  readonly coverages: readonly PlannedCoverage[];
  /** The key's state after the purchase movement and every coverage movement of the line. */
  readonly stateAfter: StockState;
}

export interface CoveragePlan {
  readonly lines: readonly CoverageLinePlan[];
  /** `Σ` covered quantity over the receipt: a header is written iff it is positive. */
  readonly coveredQ4: bigint;
  /** `N = Σ` stored coverage values: the catch-up entry is posted iff it is non-zero. */
  readonly totalValueMinor: bigint;
}

function stateInvalid(message: string): never {
  throw new InventoryError('inventory.deficit_state_invalid', message);
}

/** FIFO: `(deficit_seq ASC, id ASC)`; canonical lowercase UUIDs order as text. */
function fifo(a: DeficitLayer, b: DeficitLayer): number {
  if (a.deficitSeq !== b.deficitSeq) return a.deficitSeq < b.deficitSeq ? -1 : 1;
  return a.deficitId < b.deficitId ? -1 : a.deficitId > b.deficitId ? 1 : 0;
}

/**
 * The coverage plan of one receipt. `layers` are the open layers of the
 * receipt's warehouse (any order; layers of variants the receipt does not
 * carry are ignored); `keyStates` the `stock_levels` state per variant (a
 * variant with no row is the empty state); `lines` the receipt lines in
 * `line_no` order.
 */
export function planCoverage(layers: readonly DeficitLayer[], keyStates: ReadonlyMap<string, StockState>, lines: readonly CoverageLineInput[]): CoveragePlan {
  if (new Set(lines.map((l) => l.variantId)).size !== lines.length) {
    throw new InventoryError('inventory.duplicate_line', 'a receipt carries one line per variant');
  }
  const planned = lines.map((line) => planLine(line, layers.filter((l) => l.variantId === line.variantId).sort(fifo), keyStates.get(line.variantId)));
  return {
    lines: planned,
    coveredQ4: planned.reduce((a, l) => a + l.coveredQ4, 0n),
    totalValueMinor: planned.reduce((a, l) => a + l.catchUpMinor, 0n),
  };
}

function planLine(line: CoverageLineInput, layers: readonly DeficitLayer[], before: StockState | undefined): CoverageLinePlan {
  let state = before ?? EMPTY_STOCK_STATE;
  for (const layer of layers) {
    if (typeof layer.uncoveredQ4 !== 'bigint' || layer.uncoveredQ4 <= 0n) stateInvalid('an open deficit layer must have an uncovered quantity');
    if (typeof layer.provisionalC10 !== 'bigint' || layer.provisionalC10 < 0n || layer.provisionalC10 >= COST_LIMIT_C10) {
      stateInvalid('a deficit layer must have a non-negative provisional cost');
    }
  }
  const deficitQ4 = layers.reduce((a, l) => a + l.uncoveredQ4, 0n);
  if (deficitQ4 !== (state.onHand < 0n ? -state.onHand : 0n)) stateInvalid('the open deficit layers do not hold the key deficit');

  // 2. The purchase movement first, at its supplied share.
  const actualC10 = unitCostC10(line.baseShareMinor, line.qtyQ4);
  state = applyMovement(state, line.qtyQ4, line.baseShareMinor);

  // 3–5. FIFO coverage, the flush on the last coverage of an exact close.
  const closesAll = deficitQ4 > 0n && line.qtyQ4 === deficitQ4;
  const coverages: PlannedCoverage[] = [];
  let remaining = line.qtyQ4;
  for (const layer of layers) {
    if (remaining === 0n) break;
    const c = layer.uncoveredQ4 < remaining ? layer.uncoveredQ4 : remaining;
    remaining -= c;
    const formulaMinor = catchUpValue(c, actualC10, layer.provisionalC10);
    const flush = closesAll && remaining === 0n;
    const valueMinor = flush ? -state.valuation : formulaMinor;
    if (valueMinor !== 0n) state = applyMovement(state, 0n, valueMinor);
    const uncoveredAfterQ4 = layer.uncoveredQ4 - c;
    coverages.push({
      deficitId: layer.deficitId,
      deficitSeq: layer.deficitSeq,
      qtyCoveredQ4: c,
      provisionalC10: layer.provisionalC10,
      actualC10,
      formulaMinor,
      valueMinor,
      flush,
      movement: valueMinor !== 0n,
      uncoveredAfterQ4,
      statusAfter: uncoveredAfterQ4 === 0n ? 'closed' : 'partially_covered',
    });
  }
  const coveredQ4 = coverages.reduce((a, c) => a + c.qtyCoveredQ4, 0n);
  if (closesAll && (state.onHand !== 0n || state.valuation !== 0n)) throw new Error('a zero-crossing flush left the key with value');
  return {
    lineId: line.lineId,
    variantId: line.variantId,
    qtyQ4: line.qtyQ4,
    baseShareMinor: line.baseShareMinor,
    actualC10,
    coveredQ4,
    catchUpMinor: coverages.reduce((a, c) => a + c.valueMinor, 0n),
    coverages,
    stateAfter: state,
  };
}
