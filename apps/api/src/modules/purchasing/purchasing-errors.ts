import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import { TransactionSeamError } from '../../infra/database';
import { inventoryRefusal, packageRefusal, parseDatabaseInventoryCode } from '../inventory/inventory-errors';

/**
 * The stable refusal vocabulary of suppliers and purchases (PHASE_3_S4_CONTRACT
 * §3), as the merchant API reports it.
 *
 * `purchase.*` and `supplier.*` codes are mapped here; `inventory.*` (and the
 * catalog/structure codes a shared helper can raise) are delegated to
 * `inventoryRefusal`, so one code has one HTTP contract wherever it comes
 * from. The code travels word for word in `details.purchasingCode` (or
 * `details.inventoryCode` for a delegated one); a message never carries an
 * amount, and the database's text after the colon is never forwarded.
 */

/** Refusals the request cannot fix by re-reading: a rule of the domain the command breaks (§3, 422). */
const UNPROCESSABLE = new Set([
  'purchase.tax_policy_absent',
  'purchase.fx_rate_missing',
  'purchase.document_date_in_future',
  'purchase.landed_cost_denominator_zero',
  'purchase.landed_cost_allocation_mismatch',
  'purchase.total_zero',
]);

/** Conflicts with a document that exists (§3, 409). */
const CONFLICT_SUFFIXES = ['_state_invalid', '_changed', '_conflict', '.supplier_inactive', '.not_deletable'] as const;

const DATABASE_CODE_RE = /^((?:purchase|supplier)\.[a-z_]+)\b/;

/** The `purchase.*` / `supplier.*` code a database refusal carries, or null. */
export function parseDatabasePurchasingCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

const isPurchasingCode = (code: string): boolean => code.startsWith('purchase.') || code.startsWith('supplier.');

/**
 * Stable code → HTTP contract (§3). `extra` carries typed, amount-free facts
 * beside the code; the message is generic.
 */
export function purchasingRefusal(code: string, extra: Readonly<Record<string, unknown>> = {}): AppError {
  if (!isPurchasingCode(code)) return inventoryRefusal(code, extra);
  const details = { ...extra, purchasingCode: code };
  if (UNPROCESSABLE.has(code)) return new AppError('VALIDATION_FAILED', 'The command cannot be processed', 422, details);
  if (code.endsWith('_not_found')) return new AppError('NOT_FOUND', 'Resource not found', 404, details);
  if (CONFLICT_SUFFIXES.some((s) => code.endsWith(s))) return new AppError('CONFLICT', 'The current state does not allow this change', 409, details);
  return new AppError('VALIDATION_FAILED', 'Validation failed', 400, details);
}

/** A refusal of `@daftar/inventory` (a builder, the landed-cost or coverage arithmetic) as its API error. */
export function purchasingPackageRefusal(error: InventoryError): AppError {
  return isPurchasingCode(error.code) ? purchasingRefusal(error.code, error.details ?? {}) : packageRefusal(error);
}

/**
 * The SQLSTATEs a foreign key raises when its row is refused: PostgreSQL 18
 * reports `23001` (restrict_violation) for `ON DELETE RESTRICT`, 16 and 17
 * report `23503`. Both are matched, never one assumed.
 */
const FOREIGN_KEY_SQLSTATES = new Set(['23001', '23503']);

/** A stock-source bridge's foreign key (A-15(a)): the line is bound to its movement. */
function isBridgeForeignKeyRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? error.code : undefined;
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return typeof code === 'string' && FOREIGN_KEY_SQLSTATES.has(code) && typeof constraint === 'string' && constraint.startsWith('stock_source_bridge_');
}

/**
 * The catch of every supplier and purchase command. Every refusal leaves with
 * its stable code, and nothing else is touched:
 *
 * - a package refusal → its code;
 * - a `purchase.*` / `supplier.*` database refusal → its code (§3);
 * - an `inventory.*` database refusal → the inventory mapping;
 * - a stock-source bridge's foreign key (`23001` or `23503`) →
 *   `inventory.source_line_frozen`: a received line is bound to its movement;
 * - an `AccountingError`, an `AppError` or a seam refusal → unchanged;
 * - an `accounting.*` database refusal raised at COMMIT (the deferred
 *   completeness triggers) → the `AccountingError` the posting port would
 *   have raised, for the accepted accounting mapping;
 * - anything else — an infrastructure failure — is re-thrown untouched.
 */
export function rethrowPurchasingRefusal(error: unknown): never {
  if (error instanceof InventoryError) throw purchasingPackageRefusal(error);
  if (error instanceof AccountingError || error instanceof AppError || error instanceof TransactionSeamError) throw error;
  const purchasingCode = parseDatabasePurchasingCode(error);
  if (purchasingCode !== null) throw purchasingRefusal(purchasingCode);
  const inventoryCode = parseDatabaseInventoryCode(error);
  if (inventoryCode !== null) throw inventoryRefusal(inventoryCode);
  if (isBridgeForeignKeyRefusal(error)) throw inventoryRefusal('inventory.source_line_frozen');
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}
