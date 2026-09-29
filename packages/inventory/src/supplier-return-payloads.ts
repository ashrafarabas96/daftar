/**
 * `invpl/1` builder and intent digest of `purchase.return`
 * (PHASE_3_S5_CONTRACT A-17, A-10, A-11, A-12).
 *
 * The builder takes the exact arguments the service passes to
 * `purchase_return(…)`, in routine order: quantities as Q4, every amount as
 * integer minor units (`*Txn*` in the purchase currency, the rest in base;
 * `ppv` signed), the date as the integer `YYYYMMDD` and the optional reason
 * as the eight words of its SHA-256 (eight NULLs for no reason). It refuses
 * a payload the routine could never accept — amounts that do not satisfy the
 * header CHECKs of §2.2, a credit note id bound without a credit or the
 * reverse, a zero-value return (TL-12) — so no assertion is minted for a
 * command that cannot succeed; the routine refuses all of it again.
 *
 * The intent (A-17) is `return_id`, `purchase_id`, `warehouse_id`,
 * `document_date`, the reason words, `line_count` and per line
 * `return_line_id`, `purchase_line_id`, `qty_q4`. Every amount, the credit
 * note id and the variants are derived, so `supplierReturnIntentSha256`
 * computes the intent before any state is read (A-17 application order).
 */
import { InventoryError } from './errors';
import { MAX_DOCUMENT_LINES, yyyymmdd, type MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField } from './payload';
import { REASON_MAX_CHARS } from './reason-digest';
import { documentTextWords } from './supplier-payloads';
import type { SupplierReturnAmounts } from './supplier-return';

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const int = (value: bigint): InventoryPayloadField => ({ kind: 'integer', value });

function amount(v: unknown, what: string, signed = false): bigint {
  if (typeof v !== 'bigint' || (!signed && v < 0n)) refuse(`${what} must be ${signed ? 'an' : 'a non-negative'} integer`);
  return v as bigint;
}

/** A return's reason: already `normalizeDocumentText`-ed, 1..500 characters, or NULL (A-17, §2.5 step 5). */
export function supplierReturnReasonWords(reason: string | null): InventoryPayloadField[] {
  return documentTextWords(reason, 'reason', { min: 1, max: REASON_MAX_CHARS }).map((w): InventoryPayloadField => (w === null ? { kind: 'null' } : int(w)));
}

export interface SupplierReturnIntentLine {
  /** Client-supplied, canonical. */
  readonly returnLineId: string;
  readonly purchaseLineId: string;
  /** `q_i` > 0. */
  readonly qtyQ4: bigint;
}

export interface SupplierReturnIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the stock `source_id` of the movements and the accounting `source_id` of the entry. */
  readonly returnId: string;
  readonly purchaseId: string;
  /** The warehouse the goods leave — the one scope target (A-13). */
  readonly warehouseId: string;
  /** `YYYY-MM-DD`, bound by the client (§0: no clock). */
  readonly documentDate: string;
  readonly reason: string | null;
  /** In `line_no` order. */
  readonly lines: readonly SupplierReturnIntentLine[];
}

function assertLines(lines: readonly { readonly returnLineId: string; readonly purchaseLineId: string; readonly qtyQ4: bigint }[]): void {
  if (lines.length === 0) throw new InventoryError('inventory.lines_required', 'a return needs at least one line');
  if (lines.length > MAX_DOCUMENT_LINES) refuse(`a return has at most ${MAX_DOCUMENT_LINES} lines`);
  if (new Set(lines.map((l) => l.returnLineId)).size !== lines.length || new Set(lines.map((l) => l.purchaseLineId)).size !== lines.length) {
    throw new InventoryError('inventory.duplicate_line', 'a return has one line per purchase line, each with its own id');
  }
  lines.forEach((l, i) => {
    if (typeof l.qtyQ4 !== 'bigint' || l.qtyQ4 <= 0n) refuse(`line ${i + 1} quantity must be positive`);
  });
}

function intentFields(input: SupplierReturnIntentInput): InventoryPayloadField[] {
  assertLines(input.lines);
  const fields: InventoryPayloadField[] = [
    uuid(input.returnId, 'return_id'),
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    int(yyyymmdd(input.documentDate)),
    ...supplierReturnReasonWords(input.reason),
    int(BigInt(input.lines.length)),
  ];
  for (const l of input.lines) fields.push(uuid(l.returnLineId, 'return_line_id'), uuid(l.purchaseLineId, 'purchase_line_id'), int(l.qtyQ4));
  return fields;
}

/** The return's intent digest (A-17): the value `supplier_returns.intent_sha256` stores, computable before any state is read. */
export function supplierReturnIntentSha256(input: SupplierReturnIntentInput): string {
  return inventoryIntentSha256('purchase.return', input.tenantId, input.businessId, intentFields(input));
}

export interface SupplierReturnPayloadLine extends SupplierReturnIntentLine {
  /** The purchase line's variant (the composite FK of §2.2). */
  readonly variantId: string;
  /** A-10(a), ≥ 0. */
  readonly carryingTxnMinor: bigint;
  /** `−` the movement value at the return key's average, ≥ 0. */
  readonly valueOutMinor: bigint;
}

export interface SupplierReturnPayloadInput extends SupplierReturnIntentInput, SupplierReturnAmounts {
  /** Service-minted (A-11(b)); NULL iff `creditTxnMinor = 0`. Not part of the intent. */
  readonly creditNoteId: string | null;
  readonly lines: readonly SupplierReturnPayloadLine[];
}

/**
 * `purchase.return`: return_id, purchase_id, warehouse_id, document_date,
 * reason_w1..w8, credit_note_id, carrying_txn, ap_txn, ap_base, credit_txn,
 * credit_base, inventory_value, ppv, line_count, per line (return_line_id,
 * purchase_line_id, variant_id, qty_q4, carrying_txn, value_out).
 */
export function supplierReturnPayload(input: SupplierReturnPayloadInput): MovementPayload {
  assertLines(input.lines);
  const carrying = amount(input.carryingTxnMinor, 'carrying_txn');
  const apTxn = amount(input.apTxnMinor, 'ap_txn');
  const apBase = amount(input.apBaseMinor, 'ap_base');
  const creditTxn = amount(input.creditTxnMinor, 'credit_txn');
  const creditBase = amount(input.creditBaseMinor, 'credit_base');
  const inventory = amount(input.inventoryValueMinor, 'inventory_value');
  const ppvMinor = amount(input.ppvMinor, 'ppv', true);
  let lineCarrying = 0n;
  let lineValues = 0n;
  input.lines.forEach((l, i) => {
    lineCarrying += amount(l.carryingTxnMinor, `line ${i + 1} carrying_txn`);
    lineValues += amount(l.valueOutMinor, `line ${i + 1} value_out`);
  });
  // The header CHECKs of §2.2, before the signature.
  if (lineCarrying !== carrying) refuse('the header carrying value must be the sum of the line carrying values');
  if (apTxn + creditTxn !== carrying) refuse('the carrying value must be the AP release plus the credit');
  if ((creditTxn === 0n) !== (creditBase === 0n)) refuse('a credit has a txn and a base amount, or neither');
  if ((creditTxn === 0n) !== (input.creditNoteId === null)) refuse('a credit note id is bound iff the return issues a credit');
  if (apTxn === 0n && apBase !== 0n) refuse('no base AP is released without a txn AP release');
  if (lineValues !== inventory) refuse('the inventory value must be the sum of the line values out');
  if (ppvMinor !== apBase + creditBase - inventory) refuse('ppv must be ap_base + credit_base - inventory_value');
  if (carrying === 0n && inventory === 0n)
    throw new InventoryError('supplier_return.value_zero', 'a return with no carrying value and no inventory value posts nothing');

  const fields: InventoryPayloadField[] = [
    uuid(input.returnId, 'return_id'),
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    int(yyyymmdd(input.documentDate)),
    ...supplierReturnReasonWords(input.reason),
    input.creditNoteId === null ? { kind: 'null' } : uuid(input.creditNoteId, 'credit_note_id'),
    int(carrying),
    int(apTxn),
    int(apBase),
    int(creditTxn),
    int(creditBase),
    int(inventory),
    int(ppvMinor),
    int(BigInt(input.lines.length)),
  ];
  for (const l of input.lines) {
    fields.push(
      uuid(l.returnLineId, 'return_line_id'),
      uuid(l.purchaseLineId, 'purchase_line_id'),
      uuid(l.variantId, 'variant_id'),
      int(l.qtyQ4),
      int(l.carryingTxnMinor),
      int(l.valueOutMinor),
    );
  }
  return { payload: buildInventoryPayload('purchase.return', input.tenantId, input.businessId, fields), intentSha256: supplierReturnIntentSha256(input) };
}
