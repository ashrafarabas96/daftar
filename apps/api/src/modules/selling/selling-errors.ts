import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import { TransactionSeamError } from '../../infra/database';
import { inventoryRefusal, parseDatabaseInventoryCode } from '../inventory/inventory-errors';

/**
 * The stable refusal vocabulary of the Phase 4 customer and invoice surface
 * (P4-S1), as the merchant API reports it.
 *
 * Classified by an explicit table, never by the shape of a name — the accepted
 * `payment-method-errors.ts:18-34` model. A code that is not in the table is
 * not a selling refusal, and a caller that meets one has met a defect, never a
 * guessed status.
 *
 * Three project laws are visible in the table itself:
 *
 * - **P4-AL-54**: a refusal is a stable machine code plus a localized
 *   merchant-safe message. No message here carries a journal entry id, an
 *   account code, a journal line, a routine name, a GUC, a constraint name, an
 *   amount or the database's text after the colon;
 * - **P4-AL-44 / OD-03**: `sale.tax_policy_absent` is the whole of the tax
 *   vocabulary. There is no rate refusal, no exemption refusal and no
 *   registration refusal, because none of those concepts exists while sales tax
 *   is structurally zero;
 * - **OD-P4-05 OPTION A**: there is no `sale.oversell_*` and no
 *   `sale.stock_override_*`. The no-oversell refusal already exists as
 *   `inventory.insufficient_stock`, raised by the ONE stock writer under the
 *   level row's own `FOR UPDATE` (`0060:383`), and P4-S2 forwards it through
 *   `purchasingInventoryRefusal`'s sibling rather than inventing a second code
 *   for the same fact. A non-stock-tracked product never decrements a level
 *   and is simply sellable, which is the `(c)` clarification the ruling
 *   records — not an option and not a refusal;
 * - **OD-P4-02 / OD-P4-03**: there is no `customer.credit_limit_exceeded` and
 *   no `invoice.price_override_refused`, because neither a limit nor an
 *   override is representable. A refusal for a thing that cannot be asked for
 *   is a hint that it could be.
 *
 * Every code below needs `error.<code>` in `apps/web/src/messages/{ar,en,tr}.json`
 * before a merchant screen renders it; those catalogues are owned by the
 * localization owner of this slice, and `npm run check:localization` is what
 * proves all three exist.
 */
const SELLING_STATUS = {
  // ── Customers ───────────────────────────────────────────────────────────
  'customer.not_found': 404,
  'customer.idempotency_conflict': 409,
  'customer.revision_changed': 409,
  'customer.state_invalid': 409,
  /** A trigger refusal: no route deletes a customer (the `supplier.not_deletable` precedent). */
  'customer.not_deletable': 409,
  'customer.name_invalid': 400,
  'customer.phone_invalid': 400,
  'customer.email_invalid': 400,
  'customer.notes_invalid': 400,
  'customer.contacts_too_many': 400,
  'customer.contact_id_invalid': 400,
  'customer.contact_id_duplicate': 400,
  'customer.contact_name_invalid': 400,
  'customer.contact_phone_invalid': 400,
  'customer.contact_email_invalid': 400,
  'customer.contact_notes_invalid': 400,
  'customer.contact_reachability_missing': 400,
  'customer.contact_primary_ambiguous': 400,
  /** An aging or open-invoice read whose supplied as-of date is not a usable horizon. */
  'customer.as_of_invalid': 400,
  'customer.aging_buckets_invalid': 400,
  /** A read that sums across branches, asked by an actor limited to some of them. */
  'customer.business_wide_scope_required': 403,

  // ── Invoices ────────────────────────────────────────────────────────────
  'invoice.not_found': 404,
  /** A guard refusal no route can reach: an invoice is never edited (P4-AL-46). */
  'invoice.immutable': 500,
  /** A direct `UPDATE invoices SET status = …` refused by the transition trigger (P4-AL-24). */
  'invoice.status_not_writable': 409,
  'invoice.state_invalid': 409,
  /** The document series named by a read does not exist for this business. */
  'invoice.sequence_not_found': 404,
  'invoice.document_kind_unknown': 400,

  // ── The atomic sale commit (P4-S2) ──────────────────────────────────────
  //
  // Every code here is a refusal of a WHOLE sale: P4-AL-16 is one transaction
  // or no sale, so there is no partial outcome for a code to describe. There
  // is deliberately no `sale.partially_committed`, no `sale.stock_pending` and
  // no `sale.posting_deferred`, because a code for a state the law forbids is
  // a hint that the state exists.
  'sale.not_found': 404,
  /** The replay proof disagreed: this sale id already carries a DIFFERENT command (P4-AL-30). */
  'sale.idempotency_conflict': 409,
  'sale.state_invalid': 409,
  /** A trigger refusal no route can reach: a confirmed sale is corrected by a new document (P4-AL-46). */
  'sale.immutable': 500,
  'sale.lines_required': 400,
  'sale.lines_too_many': 400,
  'sale.duplicate_line': 400,
  'sale.quantity_invalid': 400,
  'sale.discount_invalid': 400,
  /** A discount was requested by an actor without `sales.discount`. Refused, never silently zeroed. */
  'sale.discount_not_permitted': 403,
  /** A credit sale asked by an actor without `receivables.view` — the second half of a credit sale (P4-AL-35). */
  'sale.credit_not_permitted': 403,
  'sale.notes_invalid': 400,
  'sale.document_date_in_future': 422,
  'sale.due_date_invalid': 400,
  'sale.customer_not_found': 404,
  'sale.customer_inactive': 409,
  /** A credit sale with no customer: a receivable owed by nobody, refused by the schema, the row CHECK and `invoices_walkin_no_ar`. */
  'sale.credit_requires_customer': 400,
  /** A due date behind a null customer or a cash sale — the `invoices_walkin_terms_ck` mirror (`0075:316`). */
  'sale.walkin_terms_forbidden': 400,
  'sale.warehouse_not_found': 404,
  'sale.product_not_found': 404,
  'sale.product_not_priced': 422,
  /** The whole sale was discounted to nothing: an invoice total of zero is not representable (`0075:260`). */
  'sale.total_zero': 422,
  'sale.currency_unknown': 422,
  'sale.fx_rate_missing': 422,
  /** The catalogue, the customer, the rate or the stock moved under the command's locks. Retryable BY THE CLIENT; there is no server retry. */
  'sale.state_changed': 409,

  // ── The tax boundary (P4-AL-44). The whole of it. ────────────────────────
  'sale.tax_policy_absent': 422,
} as const satisfies Readonly<Record<`${'customer' | 'invoice' | 'sale'}.${string}`, 400 | 403 | 404 | 409 | 422 | 500>>;

/** A classified selling refusal code. */
export type SellingCode = keyof typeof SELLING_STATUS;

/** True iff `code` is a classified selling code. */
export function isSellingCode(code: string): code is SellingCode {
  return Object.hasOwn(SELLING_STATUS, code);
}

/**
 * Every classified selling code, in table order — the list a localization test
 * enumerates so that a code added here without its three catalogue entries
 * fails rather than ships.
 */
export const SELLING_CODES: readonly SellingCode[] = Object.keys(SELLING_STATUS).filter(isSellingCode);

const DATABASE_CODE_RE = /^((?:customer|invoice|sale)\.[a-z_]+)\b/;

/**
 * The selling code a database refusal carries, or null. Only the code is taken:
 * the routine's message after the colon is never forwarded, because it is
 * written for an engineer reading a log and not for a merchant reading a screen.
 */
export function parseDatabaseSellingCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/**
 * A classified selling code → its HTTP contract; the code travels in
 * `details.sellingCode`, and the generic sentence is a safe fallback the client
 * replaces with the localized message for that code. A 500-class code is a
 * defect reported with its typed code, never rendered as a business outcome.
 */
export function sellingRefusal(code: SellingCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, sellingCode: code };
  const status = SELLING_STATUS[code];
  switch (status) {
    case 404:
      return new AppError('NOT_FOUND', 'Resource not found', 404, details);
    case 403:
      return new AppError('FORBIDDEN', 'This operation is not permitted', 403, details);
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

/** The `customer.*` code for one statement problem — the domain vocabulary mapped onto the API's. */
export function customerStatementRefusal(problem: string): AppError {
  const code = `customer.${problem}`;
  return sellingRefusal(isSellingCode(code) ? code : 'customer.name_invalid');
}

/**
 * An `inventory.*` code met on the sale commit path → its HTTP contract,
 * through `inventoryRefusal`, the accepted P3-S3 mapping. The sale path meets
 * them because the stock identity resolution and the ONE stock writer are the
 * inventory module's, and a code keeps ONE HTTP contract wherever it is
 * raised: `inventory.insufficient_stock` is a 409 on a sale exactly as it is
 * on a transfer.
 *
 * **This is the whole of the no-oversell vocabulary** (OD-P4-05, ruled NO
 * OVERSELL). `inventory_apply_stock_movements` already raises
 * `inventory.insufficient_stock` for any outbound movement larger than the
 * level's `on_hand`, under that level row's own `FOR UPDATE` (`0060:383`),
 * which is also the last-item race mechanism. The sale invents no second code
 * for the same fact, adds no business flag and does not weaken the writer.
 */
export function sellingInventoryRefusal(code: string, extra: Readonly<Record<string, unknown>> = {}): AppError {
  return inventoryRefusal(code, extra);
}

/** A refusal of `@daftar/inventory` (the sale payload builder, the quantity precision check) as its API error. */
export function sellingPackageRefusal(error: InventoryError): AppError {
  if (isSellingCode(error.code)) return sellingRefusal(error.code, error.details ?? {});
  return inventoryRefusal(error.code, error.details ?? {});
}

/**
 * The catch of the atomic sale commit. Every refusal leaves with its stable
 * code and nothing is swallowed:
 *
 * - a package refusal (`InventoryError` from `saleCommitPayload` or the
 *   quantity precision check) → its `sale.*` code when the selling table
 *   classifies it, its inventory code otherwise;
 * - an `AccountingError`, an `AppError` or a `TransactionSeamError` → unchanged;
 * - a `sale.*` / `customer.*` / `invoice.*` database refusal → its selling code;
 * - an `inventory.*` database refusal (the stock writer's, raised inside the
 *   routine) → its inventory code;
 * - an `accounting.*` refusal raised at COMMIT, after the posting port
 *   returned — the deferred completeness triggers and the deferred binding FKs
 *   that ARE P4-AL-16's all-or-nothing mechanism → the same `AccountingError`
 *   the port would have raised. There is no second mapping;
 * - anything else — an infrastructure failure, a seam defect — is re-thrown
 *   untouched, because a failure answered as a business refusal is a sale the
 *   merchant thinks did not happen.
 */
export function rethrowSellingRefusal(error: unknown): never {
  if (error instanceof InventoryError) throw sellingPackageRefusal(error);
  if (error instanceof AccountingError || error instanceof AppError || error instanceof TransactionSeamError) throw error;
  const sellingCode = parseDatabaseSellingCode(error);
  if (sellingCode !== null && isSellingCode(sellingCode)) throw sellingRefusal(sellingCode);
  const inventoryCode = parseDatabaseInventoryCode(error);
  if (inventoryCode !== null) throw inventoryRefusal(inventoryCode);
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}
