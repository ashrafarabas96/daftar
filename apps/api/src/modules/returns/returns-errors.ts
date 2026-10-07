import { AppError, RETURNS_REFUSAL_CODES, isReturnsRefusalCode, returnsRefusalMessageKey, type ReturnsRefusalCode } from '@daftar/domain-core';
import { ReturnsPlanError } from './returns-settlement';

/**
 * The stable refusal vocabulary of the P4-S5 returns surface — issuing and
 * voiding a credit note, and paying a refund out.
 *
 * Classified by an EXPLICIT TABLE, never by the shape of a name: the accepted
 * `receivables-errors.ts:9-13` / `payment-method-errors.ts` model. A code that
 * is not in the table is not a returns refusal, and a caller that meets one has
 * met a defect, never a guessed status.
 *
 * Four laws are visible in the table itself:
 *
 * - **P4-AL-54**: a refusal is a stable machine code plus a localized
 *   merchant-safe message. No message carries a journal entry id, an account
 *   code, a journal line, a routine name, a GUC, a constraint name, an amount or
 *   the database's text after the colon;
 * - **OD-03 / P4-AL-44**: there is exactly ONE tax code,
 *   `credit_note.tax_policy_absent`, and it refuses a non-zero tax. There is no
 *   rate, no jurisdiction, no exemption and no threshold anywhere on this path;
 * - **`TL-P4-S5-R1`**: there is no code about an invoice's outstanding on the
 *   REFUND side. `customer_refund.*` carries no
 *   `amount_exceeds_outstanding` and no `settlement_changed`, because a refund
 *   does not read an invoice's outstanding and cannot be invalidated by it
 *   moving. The credit-note side carries both, because the credit-note
 *   APPLICATION is the one AR reducer;
 * - **P4-S6 is not here.** There is no reversal code: reversing an S5 entry is
 *   S6's command under `payments.reverse`, and a code for a command that does
 *   not exist is a contract nobody can meet.
 *
 * ## The three vocabularies, and why they differ
 *
 * The same deliberate split S4 records (`receivables-errors.ts:36-47`, OQ-6
 * ruled):
 *
 * - accounting source types: `customer_credit_note`,
 *   `customer_credit_note_application`, `customer_refund` — the live registry's
 *   `customer_`-prefixed singular convention (`0081:2468-2472`), NOT
 *   `P4-AL-20`'s stale bare `credit_note` / `refund`;
 * - `invctl/1` operation codes: `customer.issue_credit_note`,
 *   `customer.void_credit_note`, `customer.refund` — because
 *   `inventory_operation_kinds.op_code` is `CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')`
 *   frozen inside `inventory_payload_digest` (`0054:229`), so the FIRST SEGMENT
 *   may hold no underscore and `customer_refund.pay` is unrepresentable;
 * - the REFUSAL prefixes below are a third thing again: `credit_note.*` and
 *   `customer_refund.*`, the domain the database routine raises them under.
 */
const RETURNS_STATUS = {
  // ── The credit note ─────────────────────────────────────────────────
  /**
   * The caller-supplied `creditNoteId` was seen and names a DIFFERENT command.
   * «An idempotency key is not permission»: a replay must prove WHICH command it
   * replays before it answers success, so a key reused over a different intent is
   * a conflict and never an acceptance.
   */
  'credit_note.idempotency_conflict': 409,
  /** The requested lifecycle transition is not one of the three the table permits. */
  'credit_note.lifecycle_invalid': 409,
  /** Some part of the note has been applied or refunded, so it is corrected by a NEW document, never voided. */
  'credit_note.already_consumed': 409,
  /** The returned-line list is not one the command could accept: too many lines, a repeated line, a non-positive quantity. */
  'credit_note.items_invalid': 400,
  /** More of a product is being returned than the invoice sold. */
  'credit_note.quantity_exceeds_sold': 409,
  'credit_note.amount_invalid': 400,
  'credit_note.amount_below_base_unit': 422,
  /** The application would leave the invoice or the note a remaining amount converting to less than one base minor unit. */
  'credit_note.residue_below_base_unit': 422,
  'credit_note.amount_mismatch': 422,
  'credit_note.customer_mismatch': 409,
  /** The invoice is a draft or void: neither owes anything, so neither can be credited. */
  'credit_note.invoice_state_invalid': 409,
  /** The invoice has no customer on it, so nobody holds a credit against it. */
  'credit_note.invoice_walkin': 409,
  /** Another settlement moved the invoice meanwhile. The client retries the SAME body; the cap is never silently adjusted to fit. */
  'credit_note.settlement_changed': 409,
  'credit_note.date_before_invoice': 422,
  'credit_note.date_in_future': 422,
  /**
   * The COGS reversal was not the sum of the stock writer's own stored value
   * deltas — an empty movement list, a repeated movement, or a non-positive
   * delta.
   *
   * It is a 500 and not a 400 because no merchant input can reach it: the
   * movements come from the one accepted stock-movement authority, inside the
   * command's own transaction. A caller that reaches this has met a defect on our
   * side, and telling them to fix their input would send them looking in the
   * wrong place.
   */
  'credit_note.cogs_not_exact': 500,
  /** A non-zero sales tax. OD-03 is OPEN and sales tax is structurally zero in this estate. */
  'credit_note.tax_policy_absent': 422,
  'credit_note.not_found': 404,
  /** The source's consumers do not chain from its original to its stored remaining pair. Ours, never theirs. */
  'credit_note.consumption_inconsistent': 500,

  // ── The refund ──────────────────────────────────────────────────────
  'customer_refund.idempotency_conflict': 409,
  /** Neither `creditNoteId` nor `customerCreditId` was given. A refund draws on exactly one source. */
  'customer_refund.source_absent': 400,
  /** BOTH were given. A different mistake from `source_absent`, and a different code, so the client knows which. */
  'customer_refund.source_ambiguous': 400,
  /** The source has nothing remaining at all. */
  'customer_refund.source_exhausted': 409,
  'customer_refund.amount_invalid': 400,
  /**
   * More than the source's remaining. **This is the cap**, and it is checked
   * against the remaining read under `FOR UPDATE` in the refund's own
   * transaction — never against a figure read earlier in the request, and never
   * against a stored consumption total, of which this slice has none.
   */
  'customer_refund.amount_exceeds_source': 409,
  'customer_refund.amount_below_base_unit': 422,
  'customer_refund.residue_below_base_unit': 422,
  /** A refund in the source's own currency pays out exactly what it consumes. */
  'customer_refund.amount_mismatch': 422,
  'customer_refund.customer_mismatch': 409,
  /** Another consumer moved the source meanwhile — another refund, or a credit application. The client retries the SAME body. */
  'customer_refund.source_changed': 409,
  'customer_refund.fx_rate_changed': 409,
  'customer_refund.date_before_source': 422,
  'customer_refund.date_in_future': 422,
  'customer_refund.reference_required': 400,
  'customer_refund.not_found': 404,

  // ── Ours, never theirs ──────────────────────────────────────────────
  /** An entry that does not balance, a line that is not positive, or an account outside the closed set. A defect here. */
  'customer_refund.arithmetic_invalid': 500,
  /** A source type, an operation kind or a journal shape S5 needs is not registered. A deployment defect. */
  'customer_refund.registry_incomplete': 500,
} as const satisfies Record<ReturnsRefusalCode, number>;

export type ReturnsCode = keyof typeof RETURNS_STATUS;

/**
 * Every code of the domain's closed vocabulary is classified above — a COMPILE
 * ERROR when one is not.
 *
 * `satisfies Record<ReturnsRefusalCode, number>` on the table catches a MISSING
 * code; this line catches the other direction, a code in the table that the
 * domain vocabulary does not declare. Between them the two make the whole class
 * of defect S4 paid for — "a live raise site whose code no status table
 * classifies", which turned a merchant's input error into a 500 blaming our
 * arithmetic — a type error rather than a review find. That is strictly stronger
 * than a test: it cannot go stale and it cannot be skipped.
 */
const RETURNS_CODES_ARE_DECLARED: Record<Exclude<ReturnsCode, ReturnsRefusalCode>, never> = Object.freeze({});
void RETURNS_CODES_ARE_DECLARED;

/** The table as a runtime list, for a suite that drives every code. Sorted by the domain's own order. */
export const RETURNS_CODES: readonly ReturnsCode[] = Object.freeze([...RETURNS_REFUSAL_CODES]);

/** The HTTP status a returns refusal carries. */
export function returnsStatus(code: ReturnsCode): number {
  return RETURNS_STATUS[code];
}

/**
 * The PUBLIC merchant prefixes of this module, and only those.
 *
 * A database refusal is recognized by this recognizer alone. Widening it to an
 * internal invariant vocabulary is how a broken invariant comes to be rendered
 * as a 403, which `selling-errors.ts` records as a real incident.
 */
const DATABASE_CODE_RE = /^((?:credit_note|customer_refund)\.[a-z_]+)\b/;

/**
 * The returns code a database refusal carries, or `null`.
 *
 * Only the CODE is taken. The database's text after the colon never reaches a
 * client: it names routines, constraints and amounts, and P4-AL-54 forbids all
 * three in a merchant-facing message.
 */
export function databaseReturnsCode(message: string): ReturnsCode | null {
  const m = DATABASE_CODE_RE.exec(message);
  if (m === null) return null;
  const code = m[1] as string;
  return isReturnsRefusalCode(code) && code in RETURNS_STATUS ? (code as ReturnsCode) : null;
}

/**
 * A returns refusal as the API error model carries it.
 *
 * The `message` is the LOCALIZATION KEY, not a sentence: the three catalogues
 * hold `error.credit_note.*` and `error.customer_refund.*`, and the merchant
 * reads the catalogue's words in their own locale. A sentence here would be an
 * English string shipped to an Arabic merchant.
 */
export function returnsAppError(code: ReturnsCode, details?: Record<string, unknown>): AppError {
  const status = returnsStatus(code);
  const apiCode =
    status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : status >= 500 ? 'INTERNAL_ERROR' : status === 422 ? 'VALIDATION_FAILED' : 'VALIDATION_FAILED';
  return new AppError(apiCode, returnsRefusalMessageKey(code), status, details);
}

/**
 * A plan-layer refusal, translated. Anything that is not a `ReturnsPlanError`
 * is re-thrown untouched: a module that converts an unknown throw into a
 * merchant refusal is a module that hides its own defects.
 */
export function returnsPlanRefusal(e: unknown): AppError {
  if (e instanceof ReturnsPlanError) return returnsAppError(e.code);
  throw e;
}
