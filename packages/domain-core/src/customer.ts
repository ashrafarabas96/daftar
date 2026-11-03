/**
 * Phase 4 customer domain types and validation (P4-S1, lock P4-AL-08,
 * P4-AL-05, P4-AL-06, OD-P4-03).
 *
 * What this file is, and deliberately is not:
 *
 * - it is the CUSTOMER's shape and the pure rules over a customer statement:
 *   the lifecycle, the text bounds, the contact rules. Nothing here reads a
 *   database, mints anything or computes money;
 * - it holds **no balance, no amount due, no outstanding and no aging**. A
 *   customer's receivable is derived from `journal_lines` on the AR account
 *   through the product's own SQL function (`customer_ar_outstanding(...)`,
 *   lock §4 matrix at `docs/PHASE_4_ARCHITECTURE_LOCK.md:192`), and
 *   `customers.balance_minor` is refused by P4-AL-06 and by guard G-3 once
 *   P4-S1 extends it. A TypeScript copy of that arithmetic would be the
 *   second truth P4-AL-07 forbids, so there is none here either;
 * - it holds **no credit limit**. `OD-P4-03` is RULED OPTION A: there is no
 *   per-customer limit in Phase 4, so there is no field, no validation and no
 *   refusal that a limit could drive;
 * - it holds **no tax identifier and no registration flag**. The supplier
 *   mirror has `tax_identifier` (`0063:196`), but P4-AL-44 states that "a sale
 *   can be to a registered or an unregistered customer, and in some
 *   jurisdictions to an exempt one, and that distinction has no representation
 *   in the data model yet" — so giving the customer one would be the first
 *   representation of a registration rule, which P4-AL-45 forbids while OD-03
 *   is open. It is added by the Country Pack that enables non-zero tax.
 *
 * A customer is business-wide master data: every value below is per
 * `(tenant_id, business_id)` and nothing here is per branch or per warehouse.
 */

/** The customer lifecycle. There is no delete, exactly as there is none for a supplier (`0063:201`). */
export const CUSTOMER_STATUSES = ['active', 'inactive'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/**
 * The enumerated lifecycle transitions. `archive` and `reactivate` are the two
 * commands; there is no path that deletes a customer and none that edits a
 * customer's history (P4-AL-46: a mistake is corrected by a new statement of
 * the whole customer, at the revision the client read).
 */
export const CUSTOMER_TRANSITIONS: readonly { readonly from: CustomerStatus; readonly to: CustomerStatus }[] = Object.freeze([
  Object.freeze({ from: 'active' as const, to: 'inactive' as const }),
  Object.freeze({ from: 'inactive' as const, to: 'active' as const }),
]);

/** Whether the enumerated table permits this transition. A same-state move is not a transition. */
export function isCustomerTransitionAllowed(from: CustomerStatus, to: CustomerStatus): boolean {
  return CUSTOMER_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/**
 * The text bounds, in characters after trimming, counted the way PostgreSQL's
 * `char_length` counts them (code points). They mirror the accepted supplier
 * bounds (`0063:194-199`) so that one merchant-facing form behaves the same on
 * both sides of the ledger.
 */
export const CUSTOMER_TEXT_BOUNDS = Object.freeze({
  name: Object.freeze({ min: 1, max: 200 }),
  phone: Object.freeze({ min: 1, max: 40 }),
  email: Object.freeze({ min: 3, max: 254 }),
  notes: Object.freeze({ min: 1, max: 1000 }),
  contactName: Object.freeze({ min: 1, max: 200 }),
  contactNotes: Object.freeze({ min: 1, max: 1000 }),
});

/**
 * Contacts per customer. A bound exists because an unbounded nested array in a
 * single statement is an unbounded transaction: the same reason a purchase is
 * capped at 200 lines (`purchasing.schemas.ts:40`).
 */
export const MAX_CUSTOMER_CONTACTS = 20;

/**
 * One contact of a customer, as a statement of the whole customer carries it.
 *
 * A contact is a person to reach, not a role in a workflow: no permission, no
 * authority and no notification policy hangs off it in Phase 4.
 */
export interface CustomerContactStatement {
  /** Client-chosen canonical lowercase uuid: the contact keeps its id across statements. */
  readonly contactId: string;
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
  /** Exactly one contact of a customer may be primary; none is also valid. */
  readonly isPrimary?: boolean;
}

/** A statement of the whole customer. An omitted optional field is CLEARED, never merged (the supplier rule, A-11). */
export interface CustomerStatement {
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
  readonly contacts?: readonly CustomerContactStatement[];
}

/**
 * Why a customer statement is refused. Each value is the suffix of a stable
 * `customer.*` refusal code; the merchant never reads one of these, they read
 * the localized sentence the API attaches to it.
 */
export type CustomerStatementProblem =
  | 'name_invalid'
  | 'phone_invalid'
  | 'email_invalid'
  | 'notes_invalid'
  | 'contacts_too_many'
  | 'contact_id_duplicate'
  | 'contact_id_invalid'
  | 'contact_name_invalid'
  | 'contact_phone_invalid'
  | 'contact_email_invalid'
  | 'contact_notes_invalid'
  | 'contact_reachability_missing'
  | 'contact_primary_ambiguous';

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A UTF-16 surrogate that is not half of a pair: such text has no exact UTF-8 bytes (the `supplier-payloads.ts:22` rule). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text as a customer row stores it: trimmed, and NULL when nothing is left. */
export function normalizeCustomerText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function textWithinBounds(text: string | null, bounds: { readonly min: number; readonly max: number }): boolean {
  if (text === null) return true;
  if (text !== text.trim() || text.includes('\u0000') || LONE_SURROGATE.test(text)) return false;
  const length = [...text].length;
  return length >= bounds.min && length <= bounds.max;
}

/** An address-shaped string, judged exactly as the accepted supplier email is (`purchasing.schemas.ts:100`). */
export function isCustomerEmailShaped(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email.trim());
}

/**
 * Every problem with a customer statement, in a stable order, or an empty
 * array when the statement is acceptable.
 *
 * It returns ALL of them rather than the first: a merchant filling a customer
 * form should see every field that needs fixing, and a caller that wants one
 * code takes the first element.
 *
 * This is a PURE function over the statement. It judges nothing that depends
 * on stored state — whether the customer exists, its revision, whether a
 * phone number is already used — because those are the routine's judgements
 * under its lock, and a copy of them here would disagree under concurrency.
 */
export function validateCustomerStatement(statement: CustomerStatement): readonly CustomerStatementProblem[] {
  const problems: CustomerStatementProblem[] = [];

  const name = normalizeCustomerText(statement.name);
  if (name === null || !textWithinBounds(name, CUSTOMER_TEXT_BOUNDS.name)) problems.push('name_invalid');

  const phone = normalizeCustomerText(statement.phone);
  if (!textWithinBounds(phone, CUSTOMER_TEXT_BOUNDS.phone)) problems.push('phone_invalid');

  const email = normalizeCustomerText(statement.email);
  if (!textWithinBounds(email, CUSTOMER_TEXT_BOUNDS.email) || (email !== null && !isCustomerEmailShaped(email))) problems.push('email_invalid');

  const notes = normalizeCustomerText(statement.notes);
  if (!textWithinBounds(notes, CUSTOMER_TEXT_BOUNDS.notes)) problems.push('notes_invalid');

  const contacts = statement.contacts ?? [];
  if (contacts.length > MAX_CUSTOMER_CONTACTS) problems.push('contacts_too_many');

  const seen = new Set<string>();
  let primaries = 0;
  let idInvalid = false;
  let idDuplicate = false;
  let contactNameInvalid = false;
  let contactPhoneInvalid = false;
  let contactEmailInvalid = false;
  let contactNotesInvalid = false;
  let unreachable = false;

  for (const contact of contacts) {
    if (typeof contact.contactId !== 'string' || !CANONICAL_UUID_RE.test(contact.contactId)) idInvalid = true;
    else if (seen.has(contact.contactId)) idDuplicate = true;
    else seen.add(contact.contactId);

    const contactName = normalizeCustomerText(contact.name);
    if (contactName === null || !textWithinBounds(contactName, CUSTOMER_TEXT_BOUNDS.contactName)) contactNameInvalid = true;

    const contactPhone = normalizeCustomerText(contact.phone);
    if (!textWithinBounds(contactPhone, CUSTOMER_TEXT_BOUNDS.phone)) contactPhoneInvalid = true;

    const contactEmail = normalizeCustomerText(contact.email);
    if (!textWithinBounds(contactEmail, CUSTOMER_TEXT_BOUNDS.email) || (contactEmail !== null && !isCustomerEmailShaped(contactEmail)))
      contactEmailInvalid = true;

    if (!textWithinBounds(normalizeCustomerText(contact.notes), CUSTOMER_TEXT_BOUNDS.contactNotes)) contactNotesInvalid = true;

    // A contact nobody can reach is a row that looks like contact information
    // and is not: at least one of the two reachability fields is stated.
    if (contactPhone === null && contactEmail === null) unreachable = true;

    if (contact.isPrimary === true) primaries += 1;
  }

  if (idInvalid) problems.push('contact_id_invalid');
  if (idDuplicate) problems.push('contact_id_duplicate');
  if (contactNameInvalid) problems.push('contact_name_invalid');
  if (contactPhoneInvalid) problems.push('contact_phone_invalid');
  if (contactEmailInvalid) problems.push('contact_email_invalid');
  if (contactNotesInvalid) problems.push('contact_notes_invalid');
  if (unreachable) problems.push('contact_reachability_missing');
  if (primaries > 1) problems.push('contact_primary_ambiguous');

  return Object.freeze(problems);
}
