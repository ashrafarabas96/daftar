import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';

/**
 * The stable refusal vocabulary of the Phase 3 inventory authority, as the
 * merchant API reports it.
 *
 * Every refusal the database raises from an inventory routine, a column guard
 * or a structural trigger has the shape `<domain>.<code>: <safe text>`, the
 * convention the accounting routines established (`0045`, `0048`). This module
 * turns that prefix — and nothing else — into an `AppError` whose HTTP code
 * is one of the accepted API contracts and whose `details.inventoryCode` is
 * the database's own string, word for word. The client and the database share
 * one vocabulary, exactly as `details.accountingCode` does for the ledger.
 *
 * The message text after the colon is never forwarded: it is written for an
 * operator, and a future edit to a routine could widen it.
 *
 * Anything that does not carry a recognised prefix is NOT translated. It is
 * an infrastructure failure, and inventing a code for it would hide it.
 */
const DATABASE_CODE_RE = /^((?:inventory|catalog|structure)\.[a-z_]+)\b/;

/** The `inventory.*` / `catalog.*` / `structure.*` code a database refusal carries, or null. */
export function parseDatabaseInventoryCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  const m = DATABASE_CODE_RE.exec(message);
  return m?.[1] ?? null;
}

/**
 * Stable code → HTTP contract. Classified by what the refusal SAYS, so a code
 * a later slice adds lands somewhere sensible without an edit here:
 *
 * - authority (a missing, forged, expired, replayed or misdirected assertion,
 *   a write the column guards refuse, an actor outside scope) → 403;
 * - a conflict with a document or with stock that already exists (P3-S3,
 *   PHASE_3_S3_CONTRACT §3: an idempotency or document-id conflict, a state
 *   that changed under the command, a stocktake already open, an opening
 *   already posted, stock on an archive target, insufficient stock, an
 *   opening that does not match its position, a frozen line or document)
 *   → 409. This rule sits AFTER the authority rule, so
 *   `.assertion_payload_mismatch` stays 403;
 * - a target that does not exist in the business → 404;
 * - the state of existing truth forbids the change (an archived target, the
 *   home association, a locked unit, the hidden base variant) → 409;
 * - anything else is a refusal of the request itself → 400.
 *
 * `extra` carries typed, amount-free-by-default facts the contract names for a
 * specific refusal — the two totals of `inventory.opening_valuation_mismatch`,
 * the variants of `inventory.unit_cost_required` — beside the code. A message
 * never carries them.
 */
export function inventoryRefusal(code: string, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, inventoryCode: code };
  if (
    code.includes('.assertion_') ||
    code.endsWith('.forbidden') ||
    code.endsWith('_authority_required') ||
    code.endsWith('_out_of_scope') ||
    code.endsWith('_scope_required')
  ) {
    return new AppError('FORBIDDEN', 'The inventory authority refused this command', 403, details);
  }
  if (
    code.endsWith('_conflict') ||
    code.endsWith('_changed') ||
    code.endsWith('_state_invalid') ||
    code.endsWith('_already_open') ||
    code.endsWith('_already_posted') ||
    code.endsWith('_has_stock') ||
    code.endsWith('.insufficient_stock') ||
    code.endsWith('.opening_valuation_mismatch') ||
    code.endsWith('.source_line_frozen') ||
    code.endsWith('.source_document_immutable')
  ) {
    return new AppError('CONFLICT', 'The current state does not allow this change', 409, details);
  }
  if (code.endsWith('_not_found')) {
    return new AppError('NOT_FOUND', 'Resource not found', 404, details);
  }
  if (
    code.endsWith('_archived') ||
    code.endsWith('_locked') ||
    code.endsWith('_immutable') ||
    code.endsWith('_not_mutable') ||
    code.endsWith('.home_branch_association_required')
  ) {
    return new AppError('CONFLICT', 'The current state does not allow this change', 409, details);
  }
  return new AppError('VALIDATION_FAILED', 'Validation failed', 400, details);
}

/**
 * Re-throw a database refusal as its stable API error; re-throw anything else
 * untouched. Used in a `catch` that has nothing else to do, so no error is
 * ever swallowed.
 */
export function rethrowInventoryRefusal(error: unknown): never {
  const code = parseDatabaseInventoryCode(error);
  if (code === null) throw error;
  throw inventoryRefusal(code);
}

/** A refusal of the `@daftar/inventory` package, as its API error with its typed details. */
export function packageRefusal(error: InventoryError): AppError {
  return inventoryRefusal(error.code, error.details ?? {});
}

/**
 * The catch of a P3-S3 movement command (PHASE_3_S3_CONTRACT §3). Every
 * refusal leaves with its stable code, and nothing else is touched:
 *
 * - a package refusal (`InventoryError`: a builder, the valuation pre-read,
 *   the allocation) → its inventory code;
 * - an `inventory.*` database refusal → its inventory code;
 * - an `AccountingError` (the posting port's own translation) or an
 *   `AppError` → unchanged;
 * - an `accounting.*` database refusal raised at COMMIT, after the posting
 *   port returned (the deferred completeness triggers) → the same
 *   `AccountingError` the port would have raised, for the existing accounting
 *   mapping. There is no second mapping;
 * - anything else — an infrastructure failure, a seam defect — is re-thrown
 *   untouched.
 */
export function rethrowMovementRefusal(error: unknown): never {
  if (error instanceof InventoryError) throw packageRefusal(error);
  if (error instanceof AccountingError || error instanceof AppError) throw error;
  const inventoryCode = parseDatabaseInventoryCode(error);
  if (inventoryCode !== null) throw inventoryRefusal(inventoryCode);
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}
