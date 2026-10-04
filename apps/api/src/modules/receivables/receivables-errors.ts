import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import { TransactionSeamError } from '../../infra/database';
import { ReceivableArithmeticError, type ReceivableArithmeticCode } from './customer-settlement';

/**
 * The stable refusal vocabulary of the P4-S4 receivables surface — collecting
 * a customer payment, and applying a customer credit to an invoice.
 *
 * Classified by an EXPLICIT TABLE, never by the shape of a name: the accepted
 * `payment-method-errors.ts:18-34` / `selling-errors.ts` model. A code that is
 * not in the table is not a receivables refusal, and a caller that meets one
 * has met a defect, never a guessed status.
 *
 * Three laws are visible in the table itself:
 *
 * - **P4-AL-54**: a refusal is a stable machine code plus a localized
 *   merchant-safe message. No message here carries a journal entry id, an
 *   account code, a journal line, a routine name, a GUC, a constraint name, an
 *   amount or the database's text after the colon;
 * - **OD-03 / P4-AL-44**: there is no tax code at all on this path. Sales tax
 *   is structurally zero and a settlement does not touch it;
 * - **P4-S5 and P4-S6 are not here.** There is no refund code, no credit-note
 *   code and no reversal code: `customer_refund_liability` (2200) is S5's and
 *   a reversal is S6's. A code for a command that does not exist is a contract
 *   nobody can meet.
 *
 * ## The two vocabularies, and why they differ
 *
 * The ROW's domain and the OPERATION CODE are deliberately different
 * namespaces (OQ-6, ruled):
 *
 * - accounting source types: `customer_payment_allocation`,
 *   `customer_credit_application`;
 * - `invctl/1` operation codes: `customer.collect_payment`,
 *   `customer.apply_credit` — because `inventory_operation_kinds.op_code` is
 *   `CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')`, frozen inside
 *   `inventory_payload_digest` (`0054:229`), so the FIRST SEGMENT may hold no
 *   underscore and `customer_payment.collect` is unrepresentable (`0074:62-70`
 *   proves both halves by probe);
 * - and the REFUSAL prefixes below are a third thing again:
 *   `customer_payment.*` and `customer_credit_application.*`, which is the
 *   domain the database routine raises them under. `supplier_payment.*` beside
 *   op code `supplier.pay` is the accepted precedent for exactly this
 *   three-way split.
 */
const RECEIVABLES_STATUS = {
  // ── Collecting a customer payment ───────────────────────────────────
  /**
   * The caller-supplied `paymentId` was seen and names a DIFFERENT command.
   * «An idempotency key is not permission» — a replay must prove WHICH command
   * it is replaying before it answers "success", so a key reused over a
   * different intent is a conflict and never an acceptance.
   */
  'customer_payment.idempotency_conflict': 409,
  /**
   * The request's allocation list is not one the routine could accept: more
   * than 50 legs, a repeated allocation id or invoice, a non-positive amount,
   * a reference longer than its bound, or a total that exceeds the amount
   * received.
   *
   * It does NOT mean "unallocated": a payment with ZERO allocations is in
   * scope (OQ-4) and its whole amount becomes a customer credit.
   */
  'customer_payment.allocations_invalid': 400,
  /**
   * ONE allocation's applied amount is not positive.
   *
   * The sibling of `customer_credit_application.amount_invalid`, and a 400 for
   * the same reason: a non-positive amount is a MERCHANT INPUT ERROR, judged
   * per leg by `arSide`, where `allocations_invalid` is about the shape of the
   * list as a whole.
   *
   * It was missing, and its absence was a live defect rather than a gap in a
   * table: `arSide` raises `` `${domain}.amount_invalid` `` on both sides of
   * the invoice chain, only the credit side was registered, and the payment
   * side therefore fell through `receivablesPlanRefusal` to
   * `customer_payment.arithmetic_invalid` — a 500 telling the merchant OUR
   * arithmetic was broken for plainly their input, and telling us to go
   * looking at the server. `RECEIVABLES_PLAN_CODES_ARE_REGISTERED` below is
   * what makes the whole class of defect a compile error instead of a review
   * find.
   */
  'customer_payment.amount_invalid': 400,
  /**
   * An allocation id already stored under ANOTHER payment (R-74,
   * `0068:649-651`): a stable domain refusal, never a raw primary-key
   * violation. A child id is an idempotency key too.
   */
  'customer_payment.allocation_id_reused': 409,
  /** The payment names an invoice of another customer, or the stated customer is not the invoice's. */
  'customer_payment.customer_mismatch': 409,
  /** The invoice is a draft or void: neither owes anything, so neither can be settled. */
  'customer_payment.invoice_state_invalid': 409,
  /**
   * The invoice is a WALK-IN invoice (`customer_id IS NULL`), and nothing can
   * settle it.
   *
   * No composite edge makes the row unrepresentable: under Departure A the
   * reducers' edge to `invoices` is two columns (`0081:357`, `0081:493`),
   * because the three-column form needs a key on `invoices` that the frozen
   * `0075` does not carry. So this code and
   * `invoice_settlement.walkin_not_settleable` are the only two things
   * standing there — this one answering at the API, the other at COMMIT — and
   * neither is belt-and-braces over a structural guarantee. Deleting either as
   * redundant would open the hole.
   */
  'customer_payment.invoice_walkin': 409,
  /** More applied to an invoice than `invoice_outstanding` says it owes. */
  'customer_payment.amount_exceeds_outstanding': 409,
  /** An applied or payment amount that converts to less than one base minor unit: a line of base 0 is not writable. */
  'customer_payment.amount_below_base_unit': 422,
  /** The surplus becoming a credit converts to less than one base minor unit. */
  'customer_payment.credit_below_base_unit': 422,
  /** The allocation would strand a sub-unit residue on the invoice (R-77, R-78). */
  'customer_payment.residue_below_base_unit': 422,
  /** A payment in the invoice's own currency must pay exactly what it applies. */
  'customer_payment.amount_mismatch': 422,
  /**
   * OPTIMISTIC CONCURRENCY. The outstanding AR, a stored snapshot or a
   * remaining pair moved between the service's read and the routine's locks,
   * so a figure the caller computed no longer holds. The whole transaction
   * rolls back and the client retries the SAME body — the cap is never
   * silently adjusted to fit (`0068:761-765`).
   */
  'customer_payment.settlement_changed': 409,
  /** The payment's FX snapshot moved between the read and the routine. Retry the same body. */
  'customer_payment.fx_rate_changed': 409,
  'customer_payment.date_before_invoice': 422,
  'customer_payment.date_in_future': 422,
  'customer_payment.customer_inactive': 409,
  /** The method requires a reference and the request stated none. */
  'customer_payment.reference_required': 400,
  'customer_payment.not_found': 404,

  // ── Applying an existing customer credit ────────────────────────────
  'customer_credit_application.idempotency_conflict': 409,
  'customer_credit_application.amount_invalid': 400,
  'customer_credit_application.credit_exhausted': 409,
  'customer_credit_application.amount_exceeds_credit': 409,
  'customer_credit_application.amount_exceeds_outstanding': 409,
  'customer_credit_application.amount_below_base_unit': 422,
  'customer_credit_application.residue_below_base_unit': 422,
  'customer_credit_application.amount_mismatch': 422,
  'customer_credit_application.customer_mismatch': 409,
  'customer_credit_application.invoice_state_invalid': 409,
  'customer_credit_application.invoice_walkin': 409,
  'customer_credit_application.settlement_changed': 409,
  'customer_credit_application.date_before_source': 422,
  'customer_credit_application.date_in_future': 422,
  'customer_credit_application.not_found': 404,
  'customer_credit.not_found': 404,

  // ── INTERNAL invariants: 500, and never a merchant outcome ──────────
  //
  // Each says THIS SERVER'S OWN arithmetic or wiring is broken, and a merchant
  // has no vocabulary for "the plan did not balance". 500 is the only status
  // that says DEFECT; a 4xx would read as a merchant outcome, so nobody would
  // look at the server (the `pos.cart_*_invalid` precedent,
  // `selling-errors.ts`).
  /** A derived figure left the plan as something other than an exact integer count of minor units, or an entry did not balance. */
  'customer_payment.arithmetic_invalid': 500,
  /**
   * The slice's `invctl/1` operation kind or its accounting source type is not
   * registered yet — the one deliberate, loud seam between this agent's files
   * and the package / migration surfaces it depends on. See
   * `receivables-payload.ts`.
   */
  'customer_payment.registry_incomplete': 500,

  // ── The SHARED settlement verifier ──────────────────────────────────
  //
  // `invoice_settlement_verify` is one body called by BOTH reducers — a
  // payment allocation and a credit application — as a DEFERRED constraint
  // trigger at COMMIT. It therefore cannot speak in either document's domain:
  // by the time it runs, the rows it judges may come from both, and a refusal
  // labelled `customer_payment.*` would name the wrong document half the time.
  //
  // A shared, non-document prefix has precedent in the accepted mirror: that
  // module's recognizer lists `purchase_residue` beside the seven document
  // domains (`purchasing-errors.ts:329-330`). What has NO precedent, and was
  // the defect, is a prefix the database raises and the recognizer below does
  // not know: `rethrowReceivablesRefusal` fell through to `throw error` and the
  // raw PostgreSQL exception text escaped as an unhandled 500 — the P4-AL-54
  // leak this file's own header forbids. These five are every code
  // `invoice_settlement_verify` raises, enumerated from the migration, and the
  // recognizer and all three catalogues carry them.
  /** The invoice names no customer, so nothing can settle it: a walk-in sale was paid where it was issued. */
  'invoice_settlement.walkin_not_settleable': 409,
  /** A cash-settled invoice carries no receivable, so there is nothing to settle. */
  'invoice_settlement.cash_not_settleable': 409,
  /** A reducer row names a customer who is not the invoice's. Under Departure A no composite edge refuses this, so the verifier is where it is refused. */
  'invoice_settlement.customer_mismatch': 409,
  /** The invoice was not `open` when the settlement committed — a draft was never posted and a void document was reversed. */
  'invoice_settlement.invoice_state_invalid': 409,
  /** The settlement chain over the invoice does not close: an internal invariant, never a merchant's mistake and never an authorization answer. */
  'invoice_settlement.settlement_inconsistent': 500,
} as const satisfies Readonly<
  Record<`${'customer_payment' | 'customer_credit' | 'customer_credit_application' | 'invoice_settlement'}.${string}`, 400 | 404 | 409 | 422 | 500>
>;

/** A classified receivables refusal code. */
export type ReceivablesCode = keyof typeof RECEIVABLES_STATUS;

/** True iff `code` is a classified receivables code. */
export function isReceivablesCode(code: string): code is ReceivablesCode {
  return Object.hasOwn(RECEIVABLES_STATUS, code);
}

/**
 * Every classified receivables code, in table order — the list a localization
 * test enumerates, so a code added here without its catalogue entries fails
 * rather than ships.
 */
export const RECEIVABLES_CODES: readonly ReceivablesCode[] = Object.keys(RECEIVABLES_STATUS).filter(isReceivablesCode);

/**
 * **EVERY CODE THE AR ARITHMETIC CAN RAISE IS A CODE THIS TABLE CLASSIFIES**,
 * proved by the compiler and not by a test.
 *
 * `customer-settlement.ts` raises three of its codes through a
 * `` `${domain}.…` `` template, once per side of the invoice chain, so each
 * site produces two codes and it is easy to register one and forget the other.
 * That is not hypothetical: `customer_payment.amount_invalid` was reachable
 * and unregistered, and every merchant who sent a non-positive applied amount
 * was answered with a 500 about our own arithmetic.
 *
 * `Exclude<ReceivableArithmeticCode, ReceivablesCode>` is `never` exactly when
 * the plan's closed union is a subset of this table's keys, so
 * `Record<that, never>` is `Record<never, never>` and `{}` satisfies it.
 * Leave a code unregistered and the empty object is missing a required
 * property, so the compiler fails with **the missing code as the property
 * name** — measured, not assumed: unregistering
 * `customer_payment.amount_invalid` produces
 *
 *     TS2741: Property '"customer_payment.amount_invalid"' is missing in type
 *     'Readonly<{}>' but required in type
 *     'Record<"customer_payment.amount_invalid", never>'.
 *
 * That is the property a `toEqual([])` assertion in a suite cannot offer, and
 * it is the whole reason this is a `Record` and not the shorter
 * `extends never ? true : never`, which fires but says only "Type 'true' is
 * not assignable to type 'never'" and sends the reader hunting.
 *
 * It costs nothing at runtime — one frozen empty object, kept alive by the
 * `void` so no lint rule prunes it.
 *
 * `RECEIVABLE_ARITHMETIC_CODES` is the same union as a runtime list, for a
 * suite that would rather drive all fifteen codes than trust the type. The two
 * are held to each other inside that module.
 */
const RECEIVABLES_PLAN_CODES_ARE_REGISTERED: Record<Exclude<ReceivableArithmeticCode, ReceivablesCode>, never> = Object.freeze({});
void RECEIVABLES_PLAN_CODES_ARE_REGISTERED;

/**
 * The PUBLIC merchant prefixes of this module, and only those. A database
 * refusal is recognized by this recognizer alone: widening it to the internal
 * `selling.*` invariant vocabulary is how a broken invariant comes to be
 * rendered as a 403, which `selling-errors.ts` records as a real incident.
 */
const DATABASE_CODE_RE = /^((?:customer_payment|customer_credit|customer_credit_application|invoice_settlement)\.[a-z_]+)\b/;

/**
 * The receivables code a database refusal carries, or null. Only the CODE is
 * taken: the routine's text after the colon is written for an engineer reading
 * a log and never for a merchant reading a screen.
 */
export function parseDatabaseReceivablesCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/**
 * A classified code → its HTTP contract.
 *
 * The code travels in `details.receivablesCode`, which **must be declared in
 * `apps/web/src/lib/client.ts`' `DOMAIN_CODE_FIELDS` (`:180`)** or every
 * refusal carrying it renders the generic fallback.
 * `apps/web/test/domain-code-fields.test.ts` DERIVES the required field names
 * from these very modules and fails on any the client does not read — it was
 * written after exactly that defect shipped with P4-S2 and was found in
 * P4-S3, where the whole `error.sale.*` and `error.pos.*` families were dead
 * strings: present, translated in three locales, and unreachable on a screen.
 * The one-name addition to that list is made beside this module for that
 * reason and is recorded in `P4_S4_REQUIRED_WIRING`, together with the three
 * locale catalogues these codes still owe.
 *
 * A dedicated field rather than borrowing `sellingCode`: the two registries
 * are separate tables with separate prefixes, and one channel carrying two
 * tables' codes is how a code comes to have two HTTP contracts.
 *
 * The generic sentence is the safe fallback the client replaces with the
 * localized message for that code. A 500-class code is a DEFECT reported with
 * its typed code, never rendered as a business outcome.
 */
export function receivablesRefusal(code: ReceivablesCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, receivablesCode: code };
  const status: 400 | 404 | 409 | 422 | 500 = RECEIVABLES_STATUS[code];
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
 * A refusal of the AR plan arithmetic (`customer-settlement.ts`) as its API
 * error. An unclassified code is a DEFECT and is reported as one rather than
 * guessed into a 4xx: the plan raises only codes this table holds, so an
 * unknown one means the two lists drifted.
 */
export function receivablesPlanRefusal(error: ReceivableArithmeticError): AppError {
  if (isReceivablesCode(error.code)) return receivablesRefusal(error.code);
  return receivablesRefusal('customer_payment.arithmetic_invalid', { unclassified: error.code });
}

/**
 * The catch of both receivables commands. Every refusal leaves with its stable
 * code and nothing is swallowed:
 *
 * - a plan refusal → its classified code, or a 500 when unclassified;
 * - an `InventoryError` (the four accepted arithmetic primitives, the payload
 *   canonicalizer) → unchanged, so `inventory.*` keeps ONE HTTP contract
 *   wherever it is raised;
 * - an `AccountingError`, an `AppError` or a `TransactionSeamError` →
 *   unchanged;
 * - a `customer_payment.*` / `customer_credit*.*` database refusal → its
 *   receivables code;
 * - an `accounting.*` refusal raised at COMMIT, after the posting port
 *   returned — the deferred completeness validators and the deferred binding
 *   FKs that ARE the all-or-nothing mechanism (P4-AL-16) → the same
 *   `AccountingError` the port would have raised. There is no second mapping;
 * - anything else — an infrastructure failure, a seam defect — is re-thrown
 *   UNTOUCHED, because a failure answered as a business refusal is money the
 *   merchant thinks did not arrive.
 */
export function rethrowReceivablesRefusal(error: unknown): never {
  if (error instanceof ReceivableArithmeticError) throw receivablesPlanRefusal(error);
  if (error instanceof InventoryError || error instanceof AccountingError || error instanceof AppError || error instanceof TransactionSeamError) throw error;
  const code = parseDatabaseReceivablesCode(error);
  if (code !== null && isReceivablesCode(code)) throw receivablesRefusal(code);
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}
