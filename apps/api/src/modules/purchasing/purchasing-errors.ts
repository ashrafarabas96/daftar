import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import { TransactionSeamError } from '../../infra/database';
import { inventoryRefusal, parseDatabaseInventoryCode } from '../inventory/inventory-errors';

/**
 * The stable refusal vocabulary of suppliers and purchases (PHASE_3_S4_CONTRACT
 * §3), of supplier returns, supplier credit notes and purchase reversals
 * (PHASE_3_S5_CONTRACT §3), as the merchant API reports it.
 *
 * Every code a supplier or purchase path can raise is CLASSIFIED here, by an
 * explicit table and never by the shape of its name:
 *
 * - `purchase.*` / `supplier.*` / `supplier_return.*` / `purchase_reversal.*`
 *   / `supplier_credit_note.*` → `PURCHASING_STATUS`, the two §3 tables word
 *   for word; the code travels in `details.purchasingCode`;
 * - `inventory.*` → the codes §3 names for S4 (`S4_INVENTORY_STATUS`), and
 *   every other code of the inventory vocabulary a purchasing path can meet
 *   (`S3_MAPPED_INVENTORY_CODES`) through `inventoryRefusal`, the accepted
 *   P3-S3 mapping, so that code keeps one HTTP contract wherever it comes
 *   from; the code travels in `details.inventoryCode`;
 * - `accounting.*` → the accepted accounting mapping (`AccountingError`).
 *
 * A code in none of them is not guessed at: it is an `UnclassifiedRefusalError`,
 * which the global filter logs and answers as an internal error — the
 * precedent of `inventory-errors` and of the seam, where anything that is not
 * a recognised refusal is a failure, never a refusal invented for it. A
 * message never carries an amount, and the database's text after the colon
 * is never forwarded.
 */

/** The refusal domains this module owns (S4 §3 and S5 §3). */
type PurchasingDomain = 'purchase' | 'supplier' | 'supplier_return' | 'purchase_reversal' | 'supplier_credit_note';

/**
 * The §3 tables: every `purchase.*`, `supplier.*` (S4), `supplier_return.*`,
 * `purchase_reversal.*` and `supplier_credit_note.*` (S5) code a service, a
 * DTO, a routine, a trigger or the package raises.
 */
const PURCHASING_STATUS = {
  'purchase.tax_policy_absent': 422,
  'purchase.not_found': 404,
  'purchase.state_invalid': 409,
  'purchase.draft_changed': 409,
  'purchase.supplier_changed': 409,
  'purchase.supplier_inactive': 409,
  'purchase.fx_rate_changed': 409,
  'purchase.fx_rate_missing': 422,
  'purchase.currency_unknown': 400,
  'purchase.document_date_in_future': 422,
  'purchase.duplicate_variant': 400,
  'purchase.lines_required': 400,
  'purchase.amount_precision_invalid': 400,
  'purchase.discount_invalid': 400,
  'purchase.landed_cost_invalid': 400,
  'purchase.landed_cost_denominator_zero': 422,
  'purchase.landed_cost_allocation_mismatch': 422,
  'purchase.total_zero': 422,
  'purchase.idempotency_conflict': 409,
  'supplier.not_found': 404,
  'supplier.idempotency_conflict': 409,
  'supplier.revision_changed': 409,
  'supplier.state_invalid': 409,
  // A trigger refusal; no route deletes a supplier (§3: 409-class).
  'supplier.not_deletable': 409,
  // P3-S5 (PHASE_3_S5_CONTRACT §3): the supplier return.
  'supplier_return.lines_invalid': 400,
  'supplier_return.quantity_exceeds_purchased': 422,
  'supplier_return.purchase_state_invalid': 409,
  'supplier_return.purchase_reversed': 409,
  'supplier_return.supplier_inactive': 409,
  'supplier_return.date_before_purchase': 422,
  'supplier_return.document_date_in_future': 422,
  'supplier_return.value_zero': 422,
  'supplier_return.amount_below_base_unit': 422,
  'supplier_return.idempotency_conflict': 409,
  // The credit-note guard: no route edits a credit note, so reaching it is a
  // defect (§3: 500-class from a routine), reported with its typed code.
  'supplier_credit_note.immutable': 500,
  // P3-S5 (PHASE_3_S5_CONTRACT §3): the purchase reversal.
  'purchase_reversal.payment_allocated': 409,
  'purchase_reversal.credit_allocated': 409,
  'purchase_reversal.returned': 409,
  'purchase_reversal.insufficient_stock': 409,
  'purchase_reversal.deficit_coverage_present': 409,
  'purchase_reversal.valuation_residue': 409,
  'purchase_reversal.already_reversed': 409,
  'purchase_reversal.purchase_changed': 409,
  'purchase_reversal.reason_required': 422,
  'purchase_reversal.date_before_purchase': 422,
  'purchase_reversal.date_in_future': 422,
} as const satisfies Readonly<Record<`${PurchasingDomain}.${string}`, 400 | 404 | 409 | 422 | 500>>;

/** A classified `purchase.*` / `supplier.*` / `supplier_return.*` / `purchase_reversal.*` / `supplier_credit_note.*` refusal code. */
export type PurchasingCode = keyof typeof PURCHASING_STATUS;

/**
 * The `inventory.*` codes §3 names for the purchasing paths. `valuation_changed`
 * is the optimistic receipt's retryable conflict (A-07); every other one is a
 * guard that no correct command reaches — a deficit or source-document guard,
 * the append-only ledger, a bridge without its line — so it is 500-class: a
 * defect, reported with its typed code rather than as a refusal the client
 * could fix.
 */
const S4_INVENTORY_STATUS: Readonly<Record<string, 409 | 500>> = {
  'inventory.valuation_changed': 409,
  'inventory.deficit_state_invalid': 500,
  'inventory.deficit_immutable': 500,
  'inventory.deficit_coverage_mismatch': 500,
  'inventory.source_document_immutable': 500,
  'inventory.source_guard_missing': 500,
  'inventory.source_line_frozen': 500,
  'inventory.source_movement_set_incomplete': 500,
  'inventory.source_type_not_authorized': 500,
  'inventory.source_value_mismatch': 500,
  'inventory.ledger_immutable': 500,
  'inventory.stock_source_line_missing': 500,
  // P3-S5 (PHASE_3_S5_CONTRACT §3, §2.4): the replaced primitive's R-B1a
  // branch. A reversal the routine built from its purchase is always paired,
  // so a missing or mismatched pair is a defect; the residue is the
  // primitive's form of `purchase_reversal.valuation_residue` (TL-8), which
  // the reversal service reports under that code.
  'inventory.reversal_pair_missing': 500,
  'inventory.reversal_pair_mismatch': 500,
  'inventory.reversal_valuation_residue': 409,
};

/**
 * Every other `inventory.*` code a purchasing path can meet: the runtime
 * refusals of the inventory routines and guards (migrations 0059–0064, the
 * migration-time end-state and backfill checks excluded), the package's
 * `InventoryErrorCode`s and the API's own reads and authority checks. §3 does
 * not restate them, so each keeps the status of the accepted P3-S3 mapping.
 */
const S3_MAPPED_INVENTORY_CODES: ReadonlySet<string> = new Set([
  // Authority: the invctl/1 assertion, the permission and the scope (403).
  'inventory.assertion_expired',
  'inventory.assertion_invalid_signature',
  'inventory.assertion_key_conflict',
  'inventory.assertion_key_invalid',
  'inventory.assertion_key_unknown',
  'inventory.assertion_malformed',
  'inventory.assertion_missing',
  'inventory.assertion_not_consumed',
  'inventory.assertion_payload_mismatch',
  'inventory.assertion_replayed',
  'inventory.assertion_scope_mismatch',
  'inventory.assertion_ttl_exceeded',
  'inventory.assertion_wrong_operation',
  'inventory.forbidden',
  'inventory.configuration_authority_required',
  'inventory.business_wide_scope_required',
  'inventory.warehouse_out_of_scope',
  // Conflicts with existing documents or stock (409).
  'inventory.idempotency_conflict',
  'inventory.document_id_conflict',
  'inventory.movement_identity_conflict',
  'inventory.insufficient_stock',
  'inventory.opening_case_changed',
  'inventory.opening_already_posted',
  'inventory.opening_state_invalid',
  'inventory.opening_valuation_mismatch',
  'inventory.stocktake_changed',
  'inventory.stocktake_already_open',
  'inventory.stocktake_state_invalid',
  'inventory.variant_stock_identity_changed',
  'inventory.product_has_stock',
  'inventory.variant_has_stock',
  'inventory.warehouse_has_stock',
  // Targets that do not exist in the business (404).
  'inventory.product_not_found',
  'inventory.variant_not_found',
  'inventory.warehouse_not_found',
  'inventory.stocktake_not_found',
  // The state of existing truth forbids the change (409).
  'inventory.product_archived',
  'inventory.variant_archived',
  'inventory.warehouse_archived',
  'inventory.variant_stock_identity_locked',
  'inventory.unit_identity_locked',
  'inventory.warehouse_home_branch_immutable',
  'inventory.home_branch_association_required',
  // The request cannot be applied as stated (400).
  'inventory.allocation_invalid',
  'inventory.arithmetic_invalid',
  'inventory.authority_leak',
  'inventory.cost_invalid',
  'inventory.duplicate_line',
  'inventory.isolation_unsupported',
  'inventory.lines_required',
  'inventory.movement_kind_not_authorized',
  'inventory.movement_kind_unknown',
  'inventory.movement_request_invalid',
  'inventory.movement_shape_invalid',
  'inventory.payload_invalid',
  'inventory.product_not_tracked',
  'inventory.quantity_invalid',
  'inventory.quantity_out_of_range',
  'inventory.quantity_precision_invalid',
  'inventory.quantity_sign_invalid',
  'inventory.reason_required',
  'inventory.rebuild_sequence_invalid',
  'inventory.scope_mismatch',
  'inventory.stock_key_missing',
  'inventory.stock_level_not_deletable',
  'inventory.stocktake_empty',
  'inventory.trace_malformed',
  'inventory.trace_missing',
  'inventory.tracking_disable_requires_zero_stock',
  'inventory.transfer_pair_mismatch',
  'inventory.transfer_pair_missing',
  'inventory.transfer_same_warehouse',
  'inventory.unit_cost_not_applicable',
  'inventory.unit_cost_required',
  'inventory.unit_decimals_invalid',
  'inventory.unit_required',
  'inventory.unit_unknown',
  'inventory.value_out_of_range',
  'inventory.variant_not_stock_identity',
  'inventory.variant_required',
  'inventory.zero_stock_residual_value',
]);

/**
 * A refusal code no table classifies. It is a defect — a code a routine or a
 * caller raises that this module was never taught — so it is not rendered as
 * a refusal: it reaches the global filter as a failure, which logs it and
 * answers 500 without a body detail.
 */
export class UnclassifiedRefusalError extends Error {
  readonly refusalCode: string;

  constructor(refusalCode: string) {
    super(`${refusalCode}: this refusal code is not classified by the purchasing error model`);
    this.name = 'UnclassifiedRefusalError';
    this.refusalCode = refusalCode;
  }
}

const DATABASE_CODE_RE = /^((?:purchase|supplier|supplier_return|purchase_reversal|supplier_credit_note)\.[a-z_]+)\b/;

/** The `purchase.*` / `supplier.*` / `supplier_return.*` / `purchase_reversal.*` / `supplier_credit_note.*` code a database refusal carries, or null. */
export function parseDatabasePurchasingCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/** True iff `code` is a classified code of a purchasing domain. */
export function isPurchasingCode(code: string): code is PurchasingCode {
  return Object.hasOwn(PURCHASING_STATUS, code);
}

/**
 * A classified purchasing code → its §3 HTTP contract. `extra` carries
 * typed, amount-free facts beside the code; the message is generic. A
 * 500-class code is a defect reported with its typed code, never a refusal
 * the client could fix.
 */
export function purchasingRefusal(code: PurchasingCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, purchasingCode: code };
  const status = PURCHASING_STATUS[code];
  switch (status) {
    case 404:
      return new AppError('NOT_FOUND', 'Resource not found', 404, details);
    case 409:
      return new AppError('CONFLICT', 'The current state does not allow this change', 409, details);
    case 422:
      return new AppError('VALIDATION_FAILED', 'The command cannot be processed', 422, details);
    case 400:
      return new AppError('VALIDATION_FAILED', 'Validation failed', 400, details);
    case 500:
      return new AppError('INTERNAL_ERROR', 'Internal error', 500, details);
  }
}

/**
 * An `inventory.*` code met on a purchasing path → its HTTP contract: the §3
 * status when §3 names it, the accepted P3-S3 mapping otherwise. An
 * unclassified code is an `UnclassifiedRefusalError`.
 */
export function purchasingInventoryRefusal(code: string, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const s4 = Object.hasOwn(S4_INVENTORY_STATUS, code) ? S4_INVENTORY_STATUS[code] : undefined;
  if (s4 === 500) return new AppError('INTERNAL_ERROR', 'Internal error', 500, { ...extra, inventoryCode: code });
  if (s4 === 409) return new AppError('CONFLICT', 'The current state does not allow this change', 409, { ...extra, inventoryCode: code });
  if (S3_MAPPED_INVENTORY_CODES.has(code)) return inventoryRefusal(code, extra);
  throw new UnclassifiedRefusalError(code);
}

/** Any refusal code a purchasing path can meet → its API error; an unclassified code is an `UnclassifiedRefusalError`. */
export function classifiedRefusal(code: string, extra: Readonly<Record<string, unknown>> = {}): AppError {
  if (isPurchasingCode(code)) return purchasingRefusal(code, extra);
  if (code.startsWith('inventory.')) return purchasingInventoryRefusal(code, extra);
  throw new UnclassifiedRefusalError(code);
}

/** A refusal of `@daftar/inventory` (a builder, the landed-cost or coverage arithmetic) as its API error. */
export function purchasingPackageRefusal(error: InventoryError): AppError {
  return classifiedRefusal(error.code, error.details ?? {});
}

/**
 * The SQLSTATEs a foreign key raises when its row is refused: PostgreSQL 18
 * reports `23001` (restrict_violation) for `ON DELETE RESTRICT`, 16 and 17
 * report `23503`; a deferred FK checked at COMMIT reports `23503`. Both are
 * matched, never one assumed.
 */
const FOREIGN_KEY_SQLSTATES = new Set(['23001', '23503']);

/** The constraint a foreign-key refusal names, or null for any other error. */
function refusedForeignKey(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = 'code' in error ? error.code : undefined;
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return typeof code === 'string' && FOREIGN_KEY_SQLSTATES.has(code) && typeof constraint === 'string' ? constraint : null;
}

/**
 * The deferred binding FKs of 0063 (A-14(a), A-15) and 0065 (S5 §2.2): a
 * received purchase, a coverage header whose catch-up is non-zero, a supplier
 * return and a purchase reversal reference the `accounting_source_bindings`
 * row their journal entry creates. A refusal at
 * COMMIT means the document owes an entry the transaction did not post: the
 * reverse direction of the entry-completeness trigger, so it carries that
 * trigger's code for the accepted accounting mapping, with the source type as
 * its only context.
 */
const BINDING_FOREIGN_KEYS: Readonly<Record<string, 'purchase' | 'negative_inventory_cost_adjustment' | 'supplier_return' | 'reversal'>> = {
  purchases_binding_fk: 'purchase',
  negative_inventory_cost_adjustments_binding_fk: 'negative_inventory_cost_adjustment',
  // P3-S5 (PHASE_3_S5_CONTRACT §2.2): a return owes its `supplier_return`
  // entry, and a purchase reversal its Phase 2 `reversal` entry (R-B2a).
  supplier_returns_binding_fk: 'supplier_return',
  purchase_reversals_binding_fk: 'reversal',
};

/** The `accounting.inventory_detail_missing` refusal of a document whose binding FK was refused at COMMIT. */
function bindingRefusal(sourceType: string): AccountingError | null {
  const code = parseDatabaseAccountingError('accounting.inventory_detail_missing: a document owes a journal entry the transaction did not post');
  return code === null ? null : new AccountingError(code, 'the posting was refused by the accounting authority', { sourceType });
}

/**
 * The unique keys a client-chosen id can collide on in a race, each with the
 * refusal the routine raises for the same collision when it sees it
 * committed (PHASE_3_S5_CONTRACT §2.5 step 9, R-50). The routine's pre-check
 * reads without a lock: two concurrent returns of different purchases that
 * name one return line id both pass it, and the loser's INSERT meets the
 * winner's key (`23505`) once the winner commits. The loser must see the
 * refusal it would have seen a moment later, never a generic duplicate that
 * names the constraint.
 *
 * - `supplier_return_lines_pkey` — a return line id is the client's, and
 *   business-wide (not scoped by the return, whose advisory key serialises
 *   every other key of the return);
 * - `supplier_credit_notes_pkey` — the credit note id the service draws,
 *   checked by the routine with the same unlocked read.
 *
 * The reversal has no such key: its header and line ids are the purchase's
 * and its purchase lines', and its original-entry key is the purchase's own
 * entry, all taken under the purchase's advisory key and row lock (§2.5), so
 * no concurrent reversal reaches them uncommitted. Every other unique
 * refusal is re-thrown untouched.
 */
const UNIQUE_KEY_REFUSALS: Readonly<Record<string, PurchasingCode | `inventory.${string}`>> = {
  supplier_return_lines_pkey: 'supplier_return.lines_invalid',
  supplier_credit_notes_pkey: 'inventory.payload_invalid',
};

/** The constraint a unique-key refusal (`23505`) names, or null for any other error. */
function refusedUniqueKey(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = 'code' in error ? error.code : undefined;
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return code === '23505' && typeof constraint === 'string' ? constraint : null;
}

/**
 * The catch of every supplier and purchase command. Every refusal leaves with
 * its stable code, and nothing else is touched:
 *
 * - a package refusal → its code;
 * - a database refusal of a purchasing domain (`purchase.*`, `supplier.*`,
 *   `supplier_return.*`, `purchase_reversal.*`, `supplier_credit_note.*`) or
 *   an `inventory.*` one, raised by a routine or by a deferred guard at
 *   COMMIT → its code (§3);
 * - a deferred binding FK refused at COMMIT (`23001` or `23503`) →
 *   `accounting.inventory_detail_missing` (A-14(a));
 * - a stock-source bridge's foreign key (`23001` or `23503`) →
 *   `inventory.source_line_frozen`: a received line is bound to its movement;
 * - a unique key a client-chosen id lost a race on (`23505`,
 *   `UNIQUE_KEY_REFUSALS`) → the code the routine raises for the same
 *   collision, through the same table as every other code;
 * - an `AccountingError`, an `AppError` or a seam refusal → unchanged;
 * - an `accounting.*` database refusal raised at COMMIT (the deferred
 *   completeness triggers) → the `AccountingError` the posting port would
 *   have raised, for the accepted accounting mapping;
 * - anything else — an infrastructure failure — is re-thrown untouched.
 */
export function rethrowPurchasingRefusal(error: unknown): never {
  if (error instanceof InventoryError) throw purchasingPackageRefusal(error);
  if (error instanceof AccountingError || error instanceof AppError || error instanceof TransactionSeamError || error instanceof UnclassifiedRefusalError) {
    throw error;
  }
  const purchasingCode = parseDatabasePurchasingCode(error);
  if (purchasingCode !== null) throw classifiedRefusal(purchasingCode);
  const inventoryCode = parseDatabaseInventoryCode(error);
  if (inventoryCode !== null) throw classifiedRefusal(inventoryCode);
  const foreignKey = refusedForeignKey(error);
  if (foreignKey !== null) {
    const sourceType = Object.hasOwn(BINDING_FOREIGN_KEYS, foreignKey) ? BINDING_FOREIGN_KEYS[foreignKey] : undefined;
    const binding = sourceType === undefined ? null : bindingRefusal(sourceType);
    if (binding !== null) throw binding;
    if (foreignKey.startsWith('stock_source_bridge_')) throw purchasingInventoryRefusal('inventory.source_line_frozen');
  }
  const uniqueKey = refusedUniqueKey(error);
  const uniqueCode = uniqueKey !== null && Object.hasOwn(UNIQUE_KEY_REFUSALS, uniqueKey) ? UNIQUE_KEY_REFUSALS[uniqueKey] : undefined;
  if (uniqueCode !== undefined) throw classifiedRefusal(uniqueCode);
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}
