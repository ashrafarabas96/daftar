import { AppError } from '@daftar/domain-core';

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
      return new AppError('FORBIDDEN', 'This read requires business-wide branch scope', 403, details);
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
