import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import type { AuditService } from '../audit/audit.service';
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
  /** The payment names an invoice of another customer, or the stated customer is not the invoice's. */
  'customer_payment.customer_mismatch': 409,
  /** The invoice is a draft or void: neither owes anything, so neither can be settled. */
  'customer_payment.invoice_state_invalid': 409,
  /**
   * The invoice is a WALK-IN invoice (`customer_id IS NULL`), and nothing can
   * settle it.
   *
   * A composite edge now DOES make the row unrepresentable, and this comment
   * used to say the opposite. `0082` added
   * `invoices_customer_uq UNIQUE (business_id, id, customer_id)` — non-partial,
   * so it validates on data that already holds NULL customers — and widened
   * both reducers' edges to `invoices` onto it (`0082:187-203`, superseding the
   * two-column `0081:357` and `0081:493`). Each reducer's `customer_id` is
   * `NOT NULL`, so all three referencing columns are non-null, so the edge is
   * checked on every row, and a non-null triple has no target in a walk-in
   * invoice's NULL-customer row. The INSERT is refused with `23503`.
   *
   * So the standing of the three answers has changed, and only their standing:
   * this code still answers at the API with a sentence a merchant can read,
   * `invoice_settlement.walkin_not_settleable` still answers at COMMIT, and
   * both are now defence in depth behind a shape rather than the only things
   * standing there. They stay: a 409 naming the walk-in invoice is a better
   * answer to a merchant than a raw foreign-key violation, and an arm that
   * cannot be reached is not an arm that may be deleted — the shape is what
   * holds, and a later slice that changes the shape would silently remove the
   * law with it.
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
  /**
   * A reducer row names a customer who is not the invoice's. Since `0082` the
   * three-column edge onto `invoices_customer_uq` refuses the INSERT itself
   * (`23503`), so this arm of `invoice_settlement_verify` is defence in depth
   * rather than the mechanism — unreachable through the relations, kept
   * because a shape that is changed must not take the law with it silently.
   */
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
 * The unique keys a client-chosen id of this slice can collide on in a RACE,
 * each mapped to the refusal `customer_collect_payment` raises for the same
 * collision when it sees it committed — the `UNIQUE_KEY_REFUSALS` law of the
 * mirror (`purchasing-errors.ts:470-506`), which this table follows exactly:
 * «the loser must see the refusal it would have seen a moment later», never a
 * generic duplicate that names the constraint.
 *
 * The routine's pre-check at `0081:1932-1937` reads WITHOUT a lock, and the
 * advisory key it holds is `hashtext(p_payment_id::text)` (`0081:1850`) — the
 * PAYMENT's id, not the children's. So two concurrent collections of
 * DIFFERENT payments that name one allocation id, or one credit id, take
 * different advisory keys, both pass the unlocked `EXISTS`, and the loser's
 * INSERT meets the winner's key once the winner commits. The routine refuses
 * the committed collision as `customer_payment.allocations_invalid`
 * (`0081:1936`, mirroring `0068:650`), so that is what the key maps to:
 *
 * - `payment_allocations_pkey` — an allocation id is the client's and
 *   business-wide (`PRIMARY KEY (business_id, id)`, `0081:324`);
 * - `customer_credits_pkey` — the surplus credit's id, checked by the same
 *   unlocked read in the same statement.
 *
 * `customer_apply_credit` needs no row here: its advisory key IS its only
 * client-chosen id (`pg_advisory_xact_lock(hashtext('daftar.customer_credit_application_id'), …)`),
 * so the reuse check at that point is serialised and the loser is refused
 * `customer_credit_application.idempotency_conflict` by the routine rather
 * than by the key. Every other unique refusal is re-thrown UNTOUCHED.
 */
const UNIQUE_KEY_REFUSALS: Readonly<Record<string, ReceivablesCode>> = {
  payment_allocations_pkey: 'customer_payment.allocations_invalid',
  customer_credits_pkey: 'customer_payment.allocations_invalid',
};

/** The constraint a unique-key refusal (`23505`) names, or null for any other error. */
function refusedUniqueKey(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = 'code' in error ? error.code : undefined;
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return code === '23505' && typeof constraint === 'string' ? constraint : null;
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
 * - a `23505` on a client-chosen child id (`UNIQUE_KEY_REFUSALS`) → the code
 *   the routine raises for the same collision, committed;
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
  const uniqueKey = refusedUniqueKey(error);
  const uniqueCode = uniqueKey !== null && Object.hasOwn(UNIQUE_KEY_REFUSALS, uniqueKey) ? UNIQUE_KEY_REFUSALS[uniqueKey] : undefined;
  if (uniqueCode !== undefined) throw receivablesRefusal(uniqueCode);
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE REFUSAL AUDIT (P4-AL-48)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * «A refusal is audited as heavily as a success.» Before this, it was not
 * audited AT ALL, and the reason was structural rather than an oversight:
 *
 * - no Phase 4 module calls `AuditService` — `recordTx`'s only callers are
 *   `catalog`, `admin`, `tenancy`, `auth` and `media`, so every Phase 4 audit
 *   row is written by the SQL routine itself;
 * - and the routine's audit INSERT is its LAST step (`0081:2170` for
 *   `customer_collect_payment`, `0081:2420` for `customer_apply_credit`),
 *   after all 33 and all 23 of their `RAISE EXCEPTION`s. A `RAISE` aborts the
 *   transaction, so a row written earlier would not survive either. A refused
 *   customer payment persisted NO audit evidence whatsoever.
 *
 * The fix is NOT a new transaction model. It is `OutboxService.emit`'s
 * already-accepted own-transaction shape, applied to the one row an abort
 * cannot carry: `AuditService.recordRefusal` opens a second business-scoped
 * `daftar_app` transaction after the first has rolled back. A refusal
 * describes an ATTEMPT, not an effect, so there is no effect for it to be
 * atomic with — and `AuditService`'s documented invariant is re-worded in the
 * same change to say so, instead of continuing to claim one contract for two
 * different durability guarantees.
 *
 * **Every claim P4-AL-48 makes is carried in the ROW'S OWN metadata, not
 * recovered by join.** For a success, the operation exercised IS recoverable —
 * `audit_events.metadata->>'assertionJti'` (`0081:2173`) joins
 * `inventory_assertion_uses`, which stores `op_code` (`0054:88-94`) — and
 * `intent_sha256` is on the `payments` row. For a REFUSAL neither join
 * exists: the assertion's consume INSERT (`0054:450-451`) and the document row
 * both rolled back. So recoverable-by-join is not available on this path at
 * all, and the row carries the operation, the intent digest, the branch, the
 * till session, the refusal code and the figures literally. That is the F-3
 * answer, recorded in `docs/PHASE_4_DECISION_REGISTER.md`.
 */

/** What a command knows about itself by the time it is refused. It is filled as the command learns it. */
export interface ReceivablesAttempt {
  /** The `invctl/1` operation code — the permission exercised. */
  readonly operation: string;
  /** `payment` or `customer_credit_application`. */
  readonly entity: string;
  /** The caller-supplied document id. Known from the request, so always present. */
  readonly entityId: string;
  /** Known once the digest is computed, which is before any state is bound. */
  intentSha256?: string;
  /** Known once an invoice is bound; a surplus-credit-only payment has none. */
  branchId?: string | null;
  /** Non-null only on a POS path. Receivables is not one, and NULL here is the truth rather than a gap. */
  tillSessionId?: string | null;
  /** The figures that caused it, minor units as decimal strings. */
  figures: Record<string, string | boolean | null>;
}

/**
 * The stable refusal code of an error THAT HAS ALREADY BEEN THROUGH
 * `rethrowReceivablesRefusal`, or null when it is not a refusal at all.
 *
 * It reads `details.receivablesCode`, which is the channel `receivablesRefusal`
 * writes and the web client reads, so the code that is audited is by
 * construction the code the merchant was answered with; an `InventoryError` or
 * an `AccountingError` carries its own `code`.
 *
 * **It is deliberately NOT a second classifier.** The first draft of this
 * function classified the RAW error and it was measurably wrong: a
 * `ReceivableArithmeticError` from the plan layer is neither an `AppError` nor
 * a database message, so it returned null and the refusal
 * `customer_payment.amount_exceeds_outstanding` — a 409 the merchant did
 * receive — was not audited. Classifying what the rethrow produced, instead of
 * guessing at what it will produce, makes that class of drift unrepresentable.
 *
 * Anything else — an infra failure, a seam defect, a bug — is NOT a refusal
 * and gets no refusal row: auditing a crash as a merchant refusal is the same
 * lie as answering one as a 409.
 */
export function refusedCode(error: unknown): string | null {
  if (error instanceof AppError) {
    const code = error.details?.['receivablesCode'];
    return typeof code === 'string' ? code : null;
  }
  if (error instanceof InventoryError || error instanceof AccountingError) return error.code;
  return parseDatabaseReceivablesCode(error);
}

/**
 * Audit a refused receivables command, then re-throw it through
 * `rethrowReceivablesRefusal` exactly as before.
 *
 * The ORDER matters and is the one this body forces: the refusal that WILL
 * leave is produced first, it is classified second, the audit row is written
 * third, and that same refusal is thrown last. So the audit can never change
 * which refusal leaves, and the code in the row can never be a different
 * classification from the code on the response — they are the same object.
 * `recordRefusal` itself never throws (its own contract), so this function's
 * only exit is that refusal.
 */
export async function auditThenRethrowReceivablesRefusal(
  audit: AuditService,
  scope: { tenantId: string; businessId: string; userId: string },
  attempt: ReceivablesAttempt,
  error: unknown,
): Promise<never> {
  // `rethrowReceivablesRefusal` always throws. Capturing what it throws is how
  // the audited code is the ANSWERED code by construction rather than by a
  // second, drift-prone classification of the raw error.
  let refusal: unknown = error;
  try {
    rethrowReceivablesRefusal(error);
  } catch (e) {
    refusal = e;
  }
  const code = refusedCode(refusal);
  if (code !== null) {
    await audit.recordRefusal(
      { tenantId: scope.tenantId, businessId: scope.businessId },
      {
        operation: attempt.operation,
        refusalCode: code,
        entity: attempt.entity,
        entityId: attempt.entityId,
        actorUserId: scope.userId,
        intentSha256: attempt.intentSha256,
        branchId: attempt.branchId ?? null,
        tillSessionId: attempt.tillSessionId ?? null,
        figures: attempt.figures,
      },
    );
  }
  throw refusal;
}
