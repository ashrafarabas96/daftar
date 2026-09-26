import { AppError } from '@daftar/domain-core';

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
 * - a target that does not exist in the business → 404;
 * - the state of existing truth forbids the change (an archived target, the
 *   home association, a locked unit, the hidden base variant) → 409;
 * - anything else is a refusal of the request itself → 400.
 */
export function inventoryRefusal(code: string): AppError {
  const details = { inventoryCode: code };
  if (
    code.includes('.assertion_') ||
    code.endsWith('.forbidden') ||
    code.endsWith('_authority_required') ||
    code.endsWith('_out_of_scope') ||
    code.endsWith('_scope_required')
  ) {
    return new AppError('FORBIDDEN', 'The inventory authority refused this command', 403, details);
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
