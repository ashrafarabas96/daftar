/**
 * The exact rebuild of a stock key from its stored movements
 * (P3-AL-42; P3-AL-49 §E; PHASE_3_S2_CONTRACT §2.5 R5 and §4).
 *
 * `on_hand = Σ qty_delta` and `valuation = Σ value_delta_base_minor`, in
 * `stock_seq` order, both additions of STORED values — no multiplication, no
 * division and no rounding in either sum. The average is derived afterwards
 * from the running pair at the last non-zero `on_hand` and is never an input
 * to the fold. Ordering is `stock_seq` only, which must be exactly 1..n.
 */
import { InventoryError } from './errors';
import { applyMovement, EMPTY_STOCK_STATE, type StockState } from './valuation';

export interface StoredMovement {
  readonly stockSeq: bigint;
  readonly qtyQ4: bigint;
  readonly value: bigint;
}

/** Folds movements given in `stock_seq` order 1..n; any other sequence is `inventory.rebuild_sequence_invalid`. */
export function foldMovements(movements: readonly StoredMovement[]): StockState {
  let state = EMPTY_STOCK_STATE;
  for (const m of movements) {
    if (m.stockSeq !== state.lastStockSeq + 1n) {
      throw new InventoryError('inventory.rebuild_sequence_invalid', 'stock_seq is not gapless and ascending from 1');
    }
    state = applyMovement(state, m.qtyQ4, m.value);
  }
  return state;
}
