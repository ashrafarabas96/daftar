import { AppError, type InstallmentArithmeticCode, InstallmentArithmeticError } from '@daftar/domain-core';

/**
 * P4-S7 — THE STABLE REFUSAL VOCABULARY of the instalment plan, the debt
 * reads and the statement.
 *
 * Maturity level B: a contract. Nothing here opens a connection, and no
 * controller in this directory mounts a route — the route surface is bound to
 * the schema this slice does not yet have, and
 * `tests/security/phase4-route-surface.test.ts` derives BOTH halves of
 * "declared = mounted" from the controllers that exist, so declaring a route
 * before it can answer is how that suite goes red. See the contract pack's
 * integration seams.
 *
 * Classified by an EXPLICIT TABLE, following `receivables-errors.ts` exactly:
 * a code that is not in the table is not an instalment refusal, and a caller
 * that meets one has met a defect, never a guessed status.
 *
 * ── THE THREE VOCABULARIES, KEPT APART (the accepted OQ-6 split) ─────────
 *
 * - the REFUSAL prefixes here are `installment_plan.*` and `installment.*` —
 *   the domain the database routine will raise them under;
 * - the `invctl/1` OPERATION CODE must satisfy the frozen
 *   `^[a-z]+(\.[a-z_]+)+$` (`0054:53`, duplicated at `0054:229` inside
 *   `inventory_payload_digest`), so the FIRST SEGMENT may hold no underscore:
 *   `installment_plan.create` is UNREPRESENTABLE and the op codes are
 *   `installments.plan`, `installments.reschedule`, `installments.cancel`;
 * - the PERMISSION is `installments.manage`, which already exists
 *   (`packages/domain-core/src/permissions.ts:88`) and is already SENSITIVE
 *   (`:144`). No new permission key is added by this slice, and under the
 *   `OD-P4-01` OPTION A ruling it is a default of no built-in role — not the
 *   manager's and not the cashier's.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────
 *
 * - **no interest, fee, penalty or late-charge code.** None is ruled and none
 *   is in P4-S7's scope. A code for a commercial term nobody authorized is
 *   worse than a gap: it is a contract a client will build against;
 * - **no tax code.** OD-03 keeps sales tax a structural zero (P4-AL-44) and a
 *   schedule does not touch it;
 * - **no collection code.** Collecting against a plan IS the ordinary
 *   customer payment, so it refuses with `customer_payment.*` from
 *   `receivables-errors.ts` and this table adds no second vocabulary for the
 *   same command. A duplicate code for one command is two HTTP contracts for
 *   one refusal;
 * - **no refund, credit-note or reversal code.** P4-S5's and P4-S6's;
 * - **no balance code.** There is no instalment balance to be wrong about.
 */
const INSTALLMENT_STATUS = {
  // ── Writing or rewriting a plan ─────────────────────────────────────
  /**
   * The caller-supplied `planId` was seen and names a DIFFERENT command.
   * «An idempotency key is not permission» — a replay proves WHICH command it
   * replays before it answers success, so a key reused over a changed economic
   * command is a CONFLICT and never an acceptance.
   */
  'installment_plan.idempotency_conflict': 409,
  /** `Σ instalments + down payment` is not the invoice total. The slice's headline law (L1). */
  'installment_plan.schedule_sum_mismatch': 422,
  /** The number of instalments is outside `1..120`. */
  'installment_plan.installment_count_invalid': 400,
  /** An instalment amount is not strictly positive, or the split would give one instalment nothing. */
  'installment_plan.amount_invalid': 400,
  /** The down payment is negative, or it leaves nothing to schedule. */
  'installment_plan.down_payment_invalid': 400,
  /** The invoice total is not strictly positive, so there is nothing to schedule. */
  'installment_plan.total_invalid': 422,
  /** A due date is malformed, or the due dates are not strictly ascending. */
  'installment_plan.due_dates_invalid': 400,
  /** An instalment falls due before the plan's own start date. */
  'installment_plan.due_date_before_start': 422,
  /** The sequence numbers are not `1..n` without a gap or a repeat. */
  'installment_plan.sequence_invalid': 400,
  /** The plan's start date falls before the invoice was issued. */
  'installment_plan.start_before_invoice': 422,
  /**
   * The plan's start date, or a supplied as-of date, is after the business's
   * own civil date as the CALLER stated it. There is no server-resolved
   * "today" behind this code (P4-AL-30): it compares two supplied dates.
   */
  'installment_plan.date_in_future': 422,

  // ── The invoice the plan is written over ────────────────────────────
  /** The invoice is a draft or void: neither owes anything, so neither can be scheduled. */
  'installment_plan.invoice_state_invalid': 409,
  /** The invoice names no customer, so there is no debtor to schedule against. */
  'installment_plan.invoice_walkin': 409,
  /**
   * The invoice was CASH settled, so it raises no receivable at all (`0080`)
   * and `invoice_outstanding` reports zero for it by law. A schedule over
   * nothing is a schedule whose every instalment is settled the moment it is
   * written, which is a screen that lies about a commitment.
   */
  'installment_plan.invoice_cash_settled': 409,
  /** The plan names an invoice of another customer, or the stated customer is not the invoice's. */
  'installment_plan.customer_mismatch': 409,
  'installment_plan.customer_inactive': 409,
  /** The invoice already carries an active plan. One receivable, one schedule. */
  'installment_plan.already_planned': 409,

  // ── Rewriting and ending a plan ─────────────────────────────────────
  'installment_plan.not_found': 404,
  /** The plan is already cancelled or already settled, so it is not the plan this command describes. */
  'installment_plan.state_invalid': 409,
  /** A reschedule moved or re-priced an instalment the one settlement figure reports as collected in full. */
  'installment_plan.settled_installment_immutable': 409,
  /**
   * OPTIMISTIC CONCURRENCY. The invoice's outstanding figure moved between
   * this service's read and the routine's locks, so the projection the caller
   * saw no longer holds. The whole transaction rolls back and the client
   * retries the SAME body — a schedule is never silently adjusted to fit a
   * figure that moved.
   */
  'installment_plan.settlement_changed': 409,

  // ── Reading ────────────────────────────────────────────────────────
  'installment.not_found': 404,
  /**
   * A keyset cursor that is not one this read issued.
   *
   * A 400 and not an empty page, which is the one place this slice departs
   * from `openInvoices`' behaviour and says why: that read's cursor is a bare
   * invoice id resolved through a primary key, so an unresolvable one is
   * indistinguishable from a row row security hides and an empty page is the
   * only safe answer. A statement cursor is a COMPOSITE `(date, kind, id)`
   * token, so a MALFORMED one — a token that is not of that shape at all — is
   * a client defect that no amount of row security can explain, and answering
   * it with an empty page tells the client its paging works.
   *
   * A WELL-FORMED cursor naming a row the caller cannot see still answers an
   * EMPTY PAGE, never a 404: the answer must not reveal whether the row exists
   * (G-02).
   */
  'installment.cursor_invalid': 400,

  // ── INTERNAL invariants: 500, and never a merchant outcome ──────────
  //
  // Each says THIS SERVER'S arithmetic or wiring is broken, and a merchant has
  // no vocabulary for "the waterfall left money unplaced". 500 is the only
  // status that says DEFECT; a 4xx would read as a merchant outcome, so
  // nobody would look at the server.
  /** A projected figure left the waterfall as something other than an exact partition of the one outstanding figure. */
  'installment_plan.arithmetic_invalid': 500,
  /**
   * The projection was handed an outstanding figure outside `0..total`. That
   * is not a merchant's mistake: it means the figure did not come from
   * `invoice_outstanding` for this invoice, or came from a read that has since
   * moved, and either is ours.
   */
  'installment_plan.settled_exceeds_total': 500,
  /**
   * The slice's `invctl/1` operation kind or its accounting source type is not
   * registered yet — the one deliberate, loud seam between this directory and
   * the migration surface it depends on, following
   * `customer_payment.registry_incomplete` exactly.
   *
   * Until S7 is promoted to level F this is the code the whole command surface
   * answers with, by construction: there is no plan relation to write to.
   */
  'installment_plan.registry_incomplete': 500,
} as const satisfies Readonly<Record<`${'installment_plan' | 'installment'}.${string}`, 400 | 404 | 409 | 422 | 500>>;

/** A classified instalment refusal code. */
export type InstallmentsCode = keyof typeof INSTALLMENT_STATUS;

/** True iff `code` is a classified instalment code. */
export function isInstallmentsCode(code: string): code is InstallmentsCode {
  return Object.hasOwn(INSTALLMENT_STATUS, code);
}

/**
 * Every classified instalment code, in table order — the list a localization
 * test enumerates, so a code added here without its three catalogue entries
 * fails rather than ships.
 */
export const INSTALLMENTS_CODES: readonly InstallmentsCode[] = Object.keys(INSTALLMENT_STATUS).filter(isInstallmentsCode);

/**
 * **EVERY CODE THE SCHEDULE ARITHMETIC CAN RAISE IS A CODE THIS TABLE
 * CLASSIFIES**, proved by the compiler and not by a test.
 *
 * The device is `receivables-errors.ts`' `RECEIVABLES_PLAN_CODES_ARE_REGISTERED`
 * and it is here for the incident that one records: a code the arithmetic
 * could raise was unregistered, so every merchant who sent that input was
 * answered with a 500 about OUR arithmetic. A `toEqual([])` in a suite cannot
 * offer the missing code as a property NAME; this does.
 *
 * `Exclude<InstallmentArithmeticCode, InstallmentsCode>` is `never` exactly
 * when the arithmetic's closed union is a subset of this table's keys, so
 * `Record<that, never>` is `Record<never, never>` and `{}` satisfies it.
 * Unregister one and the compiler fails naming it.
 */
const INSTALLMENT_PLAN_CODES_ARE_REGISTERED: Record<Exclude<InstallmentArithmeticCode, InstallmentsCode>, never> = Object.freeze({});
void INSTALLMENT_PLAN_CODES_ARE_REGISTERED;

/**
 * The PUBLIC merchant prefixes of this module, and only those.
 *
 * Widening a recognizer to an internal invariant vocabulary is how a broken
 * invariant comes to be rendered as a merchant outcome; `selling-errors.ts`
 * records that as a real incident. `customer_payment.*` is deliberately NOT
 * recognized here: a collection against a plan is the P4-S4 command and is
 * recognized by P4-S4's recognizer, in P4-S4's module.
 */
const DATABASE_CODE_RE = /^((?:installment_plan|installment)\.[a-z_]+)\b/;

/**
 * The instalment code a database refusal carries, or null. Only the CODE is
 * taken: the routine's text after the colon is written for an engineer reading
 * a log and never for a merchant reading a screen (P4-AL-54).
 */
export function parseDatabaseInstallmentsCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/**
 * A classified code → its HTTP contract.
 *
 * The code travels in `details.installmentsCode`, which **must be declared in
 * `apps/web/src/lib/client.ts`' `DOMAIN_CODE_FIELDS`** or every refusal
 * carrying it renders the generic fallback.
 * `apps/web/test/domain-code-fields.test.ts` DERIVES the required field names
 * from these modules and fails on any the client does not read; it was written
 * after exactly that defect shipped with P4-S2 and was found in P4-S3, where a
 * whole family of localized error strings was present, translated three times,
 * and unreachable on a screen. The one-name addition to that list is made
 * beside this module for that reason.
 *
 * A dedicated field rather than borrowing `receivablesCode`: the two tables
 * have separate prefixes, and one channel carrying two tables' codes is how a
 * code comes to have two HTTP contracts.
 */
export function installmentsRefusal(code: InstallmentsCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, installmentsCode: code };
  const status: 400 | 404 | 409 | 422 | 500 = INSTALLMENT_STATUS[code];
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
 * A refusal of the schedule arithmetic as its API error. An unclassified code
 * is a DEFECT and is reported as one rather than guessed into a 4xx: the
 * arithmetic raises only codes this table holds, so an unknown one means the
 * two lists drifted.
 */
export function installmentsPlanRefusal(error: InstallmentArithmeticError): AppError {
  if (isInstallmentsCode(error.code)) return installmentsRefusal(error.code);
  return installmentsRefusal('installment_plan.arithmetic_invalid', { unclassified: error.code });
}

/**
 * The catch of every instalment command and read. Every refusal leaves with
 * its stable code and nothing is swallowed:
 *
 * - an `InstallmentArithmeticError` → its classified code, or a 500 when
 *   unclassified;
 * - an `AppError` → unchanged, so a refusal raised by the receivables or
 *   selling surface keeps ONE HTTP contract wherever it is raised. A
 *   collection against a plan refuses as `customer_payment.*` and is passed
 *   through untouched: there is no second mapping and no re-labelling;
 * - an `installment_plan.*` / `installment.*` database refusal → its code;
 * - anything else — an infrastructure failure, a seam defect — is re-thrown
 *   UNTOUCHED, because a failure answered as a business refusal is a debt the
 *   merchant thinks was rescheduled.
 *
 * The arithmetic-code check is made BEFORE the generic `AppError` arm on
 * purpose: `InstallmentArithmeticError` extends `Error` and not `AppError`, so
 * order is not load-bearing today — but it would be the day somebody makes it
 * one, and a classification that depends on an invisible subclass ordering is
 * a classification nobody can read.
 */
export function rethrowInstallmentsRefusal(error: unknown): never {
  if (error instanceof InstallmentArithmeticError) throw installmentsPlanRefusal(error);
  if (error instanceof AppError) throw error;
  const code = parseDatabaseInstallmentsCode(error);
  if (code !== null && isInstallmentsCode(code)) throw installmentsRefusal(code);
  throw error;
}

/**
 * The code every command of this surface answers with while S7 is at maturity
 * level E — a DDL *specification* and no schema.
 *
 * It is named rather than left to a raw `relation "installment_plans" does not
 * exist` for the P4-AL-54 reason: a database's own text is written for an
 * engineer, and a merchant meeting it has met a leak. The seam is LOUD by
 * design, a 500 and never a 4xx, because "the slice is not promoted yet" is
 * not a merchant outcome.
 */
export const INSTALLMENTS_UNPROMOTED_CODE: InstallmentsCode = 'installment_plan.registry_incomplete';
