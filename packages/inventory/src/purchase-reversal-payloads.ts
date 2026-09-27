/**
 * `invpl/1` builder and intent digest of `purchase.reverse`, and the stock
 * side of a purchase reversal (PHASE_3_S5_CONTRACT A-09, A-17; R-B1a, R-B2a;
 * TL-8).
 *
 * A reversal removes exactly what the receipt added (P3-AL-20, Must-prove
 * 6): one `purchase_reversal` movement per purchase line, `qty = −qty_i` and
 * `value = −s_i`, where `s_i` is the stored value of that line's `purchase`
 * movement — the exact negation of its pair (R-B1a), never the key's
 * average. Every bound value is therefore fixed at receipt: the builder binds
 * the purchase's warehouse, the original journal entry the Phase 2 reversal
 * mirrors (R-B2a), and each line's `(line_id, variant_id, qty, s_i)` in
 * `line_no` order, with `Σ s_i = B`.
 *
 * The intent (A-17) is `purchase_id`, `warehouse_id`, `reversal_date` and
 * the reason words: the lines are the purchase's, so the whole group is
 * derived. The reversal's identity IS the purchase id, so a second reversal
 * replays or is refused by that intent alone (A-09).
 */
import { InventoryError } from './errors';
import { MAX_DOCUMENT_LINES, yyyymmdd, type MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField } from './payload';
import { REASON_MAX_CHARS } from './reason-digest';
import { documentTextWords } from './supplier-payloads';
import { applyMovement, type StockState } from './valuation';

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const int = (value: bigint): InventoryPayloadField => ({ kind: 'integer', value });

/**
 * A reversal's reason: REQUIRED (`accounting_post_reversal` needs one),
 * already `normalizeDocumentText`-ed and 1..500 characters. NULL is
 * `inventory.reason_required`; the routine's own code for it is
 * `purchase_reversal.reason_required`.
 */
export function purchaseReversalReasonWords(reason: string | null): InventoryPayloadField[] {
  if (reason === null) throw new InventoryError('inventory.reason_required', 'a purchase reversal must state a reason');
  return documentTextWords(reason, 'reason', { min: 1, max: REASON_MAX_CHARS }).map((w): InventoryPayloadField => (w === null ? { kind: 'null' } : int(w)));
}

export interface PurchaseReverseIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  /** The purchase's stored warehouse: the scope that was checked (TL-4). */
  readonly warehouseId: string;
  /** `YYYY-MM-DD`, bound by the client (§0: no clock). */
  readonly reversalDate: string;
  readonly reason: string;
}

function intentFields(input: PurchaseReverseIntentInput): InventoryPayloadField[] {
  return [
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    int(yyyymmdd(input.reversalDate)),
    ...purchaseReversalReasonWords(input.reason),
  ];
}

/** The reversal's intent digest (A-17): the value `purchase_reversals.intent_sha256` stores, computable before any state is read. */
export function purchaseReverseIntentSha256(input: PurchaseReverseIntentInput): string {
  return inventoryIntentSha256('purchase.reverse', input.tenantId, input.businessId, intentFields(input));
}

export interface PurchaseReverseLine {
  /** The purchase line id — the reversal line's own id (`purchase_reversal_lines.id = purchase_line_id`). */
  readonly lineId: string;
  readonly variantId: string;
  /** `qty_i` of the purchase line, > 0. */
  readonly qtyQ4: bigint;
  /** `s_i`: the stored value of the line's `purchase` movement, ≥ 0. */
  readonly valueMinor: bigint;
}

export interface PurchaseReversePayloadInput extends PurchaseReverseIntentInput {
  /** `accounting_purchase_entry_id(business, purchase)`: the entry the Phase 2 reversal mirrors (R-B2a). */
  readonly originalEntryId: string;
  /** `purchases.total_base_minor` = `Σ s_i` > 0. */
  readonly totalValueMinor: bigint;
  /** Every purchase line, in `line_no` order. */
  readonly lines: readonly PurchaseReverseLine[];
}

/**
 * `purchase.reverse`: purchase_id, warehouse_id, reversal_date,
 * reason_w1..w8, original_entry_id, total_value, line_count, per line
 * (line_id, variant_id, qty_q4, value).
 */
export function purchaseReversePayload(input: PurchaseReversePayloadInput): MovementPayload {
  const lines = input.lines;
  if (lines.length === 0) throw new InventoryError('inventory.lines_required', 'a reversal carries every line of its purchase');
  if (lines.length > MAX_DOCUMENT_LINES) refuse(`a purchase has at most ${MAX_DOCUMENT_LINES} lines`);
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length || new Set(lines.map((l) => l.variantId)).size !== lines.length) {
    throw new InventoryError('inventory.duplicate_line', 'a purchase has one line per variant, each with its own id');
  }
  if (typeof input.totalValueMinor !== 'bigint' || input.totalValueMinor <= 0n) refuse('total_value must be a positive integer');
  let sum = 0n;
  lines.forEach((l, i) => {
    if (typeof l.qtyQ4 !== 'bigint' || l.qtyQ4 <= 0n) refuse(`line ${i + 1} quantity must be positive`);
    if (typeof l.valueMinor !== 'bigint' || l.valueMinor < 0n) refuse(`line ${i + 1} value must be a non-negative integer`);
    sum += l.valueMinor;
  });
  if (sum !== input.totalValueMinor) refuse('the line values must add up to the total value exactly');

  const fields: InventoryPayloadField[] = [
    ...intentFields(input),
    uuid(input.originalEntryId, 'original_entry_id'),
    int(input.totalValueMinor),
    int(BigInt(lines.length)),
  ];
  for (const l of lines) fields.push(uuid(l.lineId, 'line_id'), uuid(l.variantId, 'variant_id'), int(l.qtyQ4), int(l.valueMinor));
  return { payload: buildInventoryPayload('purchase.reverse', input.tenantId, input.businessId, fields), intentSha256: purchaseReverseIntentSha256(input) };
}

// ── The stock side of one reversal line (A-09 (d), (f); §2.4) ────────────

/**
 * The verdict of removing one purchase line's receipt from its key, as the
 * routine decides it after lock step 6 and the replaced primitive decides it
 * again:
 *
 * - `insufficient_stock` (A-09 (d)): the key holds less than `qty_i` (an
 *   absent key is `EMPTY_STOCK_STATE`) → `purchase_reversal.insufficient_stock`;
 * - `valuation_residue` (A-09 (f), TL-8): removing exactly `s_i` would leave
 *   `on_hand = 0` with a non-zero valuation, or a positive `on_hand` with a
 *   negative valuation → `purchase_reversal.valuation_residue`;
 * - `ok`: the movement is `(−qty_i, −s_i)` and `stateAfter` the key after it.
 *
 * A verdict, not a throw: the codes are the routine's `purchase_reversal.*`
 * codes, which the service raises from it.
 */
export type ReversalLineVerdict =
  | { readonly verdict: 'ok'; readonly valueMinor: bigint; readonly stateAfter: StockState }
  | { readonly verdict: 'insufficient_stock' }
  | { readonly verdict: 'valuation_residue' };

export function reversalLineVerdict(state: StockState, qtyQ4: bigint, purchaseValueMinor: bigint): ReversalLineVerdict {
  if (typeof qtyQ4 !== 'bigint' || qtyQ4 <= 0n) refuse('a reversed quantity must be positive');
  if (typeof purchaseValueMinor !== 'bigint' || purchaseValueMinor < 0n) refuse('a purchase movement value must be a non-negative integer');
  if (state.onHand < qtyQ4) return { verdict: 'insufficient_stock' };
  const onHandAfter = state.onHand - qtyQ4;
  const valuationAfter = state.valuation - purchaseValueMinor;
  if ((onHandAfter === 0n && valuationAfter !== 0n) || (onHandAfter > 0n && valuationAfter < 0n)) return { verdict: 'valuation_residue' };
  return { verdict: 'ok', valueMinor: -purchaseValueMinor, stateAfter: applyMovement(state, -qtyQ4, -purchaseValueMinor) };
}
