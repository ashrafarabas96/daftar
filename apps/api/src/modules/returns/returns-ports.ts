/**
 * The repository PORTS of P4-S5 (maturity level B).
 *
 * ## What a port is here, and what it is not
 *
 * Each interface below is the EXACT shape of a database interaction the S5
 * commands need, named so that an implementation can be written against the
 * sealed schema and an in-memory model can be written against the same
 * interface. No port has an implementation in this change, and that is
 * deliberate: the relations do not exist (`refunds`, `credit_notes`,
 * `credit_note_items` and `credit_note_applications` exist at no prefix
 * `0000`–`0086`), and S5 owns no migration number. A port is the honest way to
 * build at level B against schema that is not there yet; a placeholder table
 * would not be.
 *
 * **No port is a second writer of anything.** `lockSource` and
 * `decrementSource` name the ONE writer of a source's remaining pair, which
 * today is `customer_credit_consume` (`0081:1224`) — internal-owned
 * `SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC`, pinned `search_path`, R-90.
 * S5 adds no second one; it asks for that routine to be WIDENED, in
 * `PATCH-REQ-S5-003`. There is likewise no port that writes a stock movement:
 * `requestReturnMovements` asks the one accepted stock-movement authority and
 * reads back what it wrote.
 *
 * ## Three obligations every port carries, stated once
 *
 * 1. **The lock order is `RETURNS_LOCK_ORDER`** (`@daftar/domain-core`), and an
 *    implementation that takes locks in another order is a deadlock waiting for
 *    an S4 command to interleave with it. `isLawfulLockTrace` is the predicate a
 *    test drives a recorded trace through.
 * 2. **Every method here runs inside ONE transaction per command**
 *    (`RETURNS_TRANSACTION_BOUNDARY`). A port is not a unit of atomicity and
 *    must not open its own transaction: a refund that disbursed cash in one
 *    transaction and decremented its source in another is a refund that can pay
 *    twice.
 * 3. **Nothing here re-reads an FX rate.** A consumer computes from the source's
 *    OWN stored snapshot, and the disbursement's snapshot is BOUND by the
 *    command before any posting (A-15). `fxRateChanged` is therefore an
 *    optimistic refusal the port REPORTS, never a re-read it performs.
 */
import { S5_ACCOUNT } from '@daftar/domain-core';
import type { CreditNoteIntent, RefundIntent, RefundSourceKind, ReturnedMovementValue } from '@daftar/domain-core';
import { APPLICATION_LIABILITY_ACCOUNT, ReturnsPlanError } from './returns-settlement';
import type { ConsumableSource, CreditNoteApplicationPlan, ReturnsEntryLine, SourceConsumerRow } from './returns-settlement';

/** The tenancy and actor scope every port call carries. Never defaulted and never inferred from a connection. */
export interface ReturnsScope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly actorUserId: string;
  /** The one business transaction id the whole command shares, so every row it writes is attributable to it. */
  readonly businessTransactionId: string;
}

// ── The source port: the cap's home ─────────────────────────────────────

/**
 * The source of a refund, locked.
 *
 * `lockSource` is the ONLY way this slice learns a source's remaining, and it
 * returns it having taken `FOR UPDATE` on the source row. That is not a
 * convenience: **the cap is checked inside the source under `FOR UPDATE`**, so a
 * remaining obtained any other way is a remaining another transaction may
 * already have spent. There is deliberately no `readSource` beside it — an
 * unlocked read of a cap is the one thing this port must not make easy.
 *
 * `null` means the source does not exist, is another business's, or is another
 * customer's: all three answer `customer_refund.not_found` or
 * `customer_refund.customer_mismatch` and the port does not distinguish them to
 * the caller, because distinguishing them would confirm the existence of another
 * tenant's row.
 */
export interface RefundSourcePort {
  /**
   * Lock the one source named, and return its pair and its own snapshot.
   *
   * `kind` is passed, not guessed: `resolveRefundSource` has already established
   * which of the two ids is set, and a port that re-derived it would be a second
   * place where the XOR is decided.
   */
  lockSource(scope: ReturnsScope, kind: RefundSourceKind, sourceId: string, customerId: string): Promise<ConsumableSource | null>;

  /**
   * Decrement the source's remaining PAIR, through its one writer, backed by
   * the refund row this transaction has already inserted.
   *
   * Both halves move together or neither does. `remainingBeforeMinor` is passed
   * so the writer's optimistic `UPDATE … WHERE remaining_amount_minor = $level`
   * can refuse a lost update with its own `GET DIAGNOSTICS` row count — the
   * `0081:1239-1250` shape. A row count other than one is
   * `customer_refund.source_changed` and never a retry inside the port.
   */
  decrementSource(
    scope: ReturnsScope,
    kind: RefundSourceKind,
    sourceId: string,
    remainingBeforeMinor: bigint,
    consumedMinor: bigint,
    carryingReleasedMinor: bigint,
  ): Promise<void>;

  /**
   * Every stored consumer of the source — applications AND refunds, in ONE
   * array.
   *
   * The union is the whole point: a verifier that reads applications only leaves
   * `remaining = original − Σ(applications) − refunds` and refuses a lawful
   * state (`0081:877-878` says so in its own words). This port is what the
   * TypeScript twin `verifySourceConsumptionChain` is driven with, and
   * `PATCH-REQ-S5-003` asks for the SQL twin's `UNION ALL` branch.
   */
  listSourceConsumers(scope: ReturnsScope, kind: RefundSourceKind, sourceId: string): Promise<readonly SourceConsumerRow[]>;
}

// ── The credit-note port ────────────────────────────────────────────────

/** A credit note's row as the command reads it back, before any DTO is shaped. */
/**
 * A credit note as a READ returns it: the document and the remaining PAIR,
 * which is what a lock is taken for and what the cap is asked against. There is
 * no status: `CREDIT_NOTE_HAS_NO_LIFECYCLE`.
 *
 * It is NOT what an insert needs, and `CreditNoteWrite` below is. A read
 * projection doing double duty as a write shape is how a column that only a
 * write can supply — the origin invoice, the date, the FX snapshot, the intent
 * hash — ends up supplied by something other than the command.
 */
export interface CreditNoteRow {
  readonly creditNoteId: string;
  readonly creditNoteNumber: string;
  readonly customerId: string;
  readonly currencyCode: string;
  readonly totalMinor: bigint;
  readonly remainingMinor: bigint;
  readonly remainingCarryingMinor: bigint;
}

/**
 * One `credit_notes` row as the ISSUE command writes it.
 *
 * The three groups it carries that `CreditNoteRow` cannot:
 *
 * - **the provenance**: `invoiceId` is the ORIGIN of the return — the sale being
 *   reversed, which is what makes `quantity_exceeds_sold` answerable and what
 *   gives the COGS reversal its lineage. It is NOT an AR reduction; that is a
 *   `credit_note_applications` row (DDL spec section 1.5);
 * - **the FX snapshot**, bound once by the command and never re-read while
 *   posting, plus the base total it produced at the ONE conversion
 *   `planCreditNoteReversal` performs;
 * - **`intentSha256`**, the hash of `creditNoteIntentPreimage`, computed by the
 *   one hashing authority and never by this slice. Without it the row cannot
 *   answer a replay, and `credit_note.idempotency_conflict` would be a code with
 *   no mechanism behind it.
 *
 * The note is BORN at `remainingMinor = totalMinor` and
 * `remainingCarryingMinor = totalBaseMinor`, so `g(OA) = OB` holds at birth —
 * the condition `planCustomerCreditCreation` asserts for a customer credit
 * (`packages/inventory/src/customer-settlement.ts:562`) and the same one a note's
 * guard will assert. Those two fields are therefore NOT separately supplied
 * here: they are the pair the command computed, and a write shape that let a
 * caller name a remaining different from the total would let a note be born
 * already partly consumed.
 */
export interface CreditNoteWrite {
  readonly creditNoteId: string;
  readonly creditNoteNumber: string;
  readonly numberSeq: bigint;
  readonly customerId: string;
  /** The sale this return reverses. The ORIGIN, never the AR reduction. */
  readonly invoiceId: string;
  readonly creditNoteDate: string;
  readonly reference: string | null;
  readonly currencyCode: string;
  readonly totalMinor: bigint;
  /** The note's own stored snapshot: rate x 10^10, and the two exponents. */
  readonly sourceToBaseRateR10: bigint;
  /** The total at the note's ONE conversion. The note is born carrying exactly this. */
  readonly totalBaseMinor: bigint;
  /** Structural zero (OD-03 OPEN). The column exists under `CHECK (tax_minor = 0)`. */
  readonly taxMinor: 0n;
  /** The hash of `creditNoteIntentPreimage`. Computed by the one hashing authority, never by this slice. */
  readonly intentSha256: string;
}

export interface CreditNotePort {
  /**
   * Allocate the note's document number as `max + 1` under the sequence row's
   * lock, backed by a `UNIQUE`.
   *
   * The `invoice_sequences` mechanism, per G-07 and P4-AL-31: a per-business
   * counter row under a lock, NEVER a cluster-wide `CREATE SEQUENCE` and never a
   * `serial`. A sequence gaps on rollback and a document number may not gap. The
   * format is `invoice_sequences`' own stored one and the renderer is the
   * database's; this port returns what it rendered and computes no string.
   */
  allocateNumber(scope: ReturnsScope, period: string): Promise<{ readonly numberSeq: bigint; readonly documentNumber: string }>;

  /** Insert the note and its items, born whole in one statement set. A half-written document is never visible. */
  insertCreditNote(scope: ReturnsScope, row: CreditNoteWrite, items: readonly CreditNoteItemWrite[]): Promise<void>;

  /**
   * Insert the applications that reduce AR — at most one per invoice, each at
   * the invoice's own AR level.
   *
   * **This is the ONE place AR falls in this slice**, and it falls once — a
   * claim that is now true of the code and not only of this comment. The credit
   * note's OWN entry (`planCreditNoteReversal`) carries no `accounts_receivable`
   * line at all: it raises the liability for the note's whole total. Every
   * reduction of AR is a row of THIS relation, and every amount on that row is
   * produced by `planCreditNoteApplication`, which delegates to the canonical
   * `planCustomerCreditApplication` — so there is one algorithm for how far AR
   * falls, at the INVOICE's stored snapshot, with its dust line and its
   * realized-FX line, and not a second one at the note's snapshot.
   *
   * The level (`arReleasedBeforeTxnMinor`) is read under the invoice's lock in
   * this same transaction, and the level `UNIQUE` on the relation is the fast
   * per-relation backstop — not the invariant. The invariant is
   * `invoice_settlement_verify` at COMMIT (P4-AL-22).
   */
  insertApplications(scope: ReturnsScope, creditNoteId: string, applications: readonly CreditNoteApplicationWrite[]): Promise<void>;

  /**
   * Lock a note and read its remaining PAIR — a refund's first step, under
   * `FOR UPDATE`, in the refund's own transaction.
   *
   * It is no longer "the void command's first step": there is no void command.
   * See `CREDIT_NOTE_HAS_NO_LIFECYCLE` in `@daftar/domain-core` for why the
   * lifecycle, its states, its transitions, its two refusal codes and the
   * `setLifecycle` method that was here are all deleted.
   */
  lockCreditNote(scope: ReturnsScope, creditNoteId: string): Promise<CreditNoteRow | null>;

  /**
   * The intent stored under `creditNoteId`, or `null` if the key is unseen.
   *
   * The same seam the refund has, from the other side: `creditNoteReplayVerdict`
   * decides, this port only reports. It returns the INTENT and not the hash,
   * because the comparison is pre-image equality
   * (`isSameCreditNoteIntent`) — comparing hashes here would make this slice a
   * second place a fingerprint is computed, and
   * `packages/accounting/src/fingerprint.ts` is the one place.
   *
   * A caller that skips this and relies on the primary key alone gets a unique
   * violation for a replay, which is a 500 for what is a lawful 200 — and, worse,
   * answers nothing at all for a DIFFERENT command sent under the same key. «An
   * idempotency key is not permission.»
   */
  storedIntent(scope: ReturnsScope, creditNoteId: string): Promise<CreditNoteIntent | null>;
}

export interface CreditNoteItemWrite {
  readonly creditNoteItemId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly quantity: string;
  readonly unitPriceMinor: bigint;
  readonly netMinor: bigint;
  /** Structural zero (OD-03 OPEN). The column exists under `CHECK (tax_minor = 0)`. */
  readonly taxMinor: 0n;
  readonly cogsReversalBaseMinor: bigint;
}

/**
 * One `credit_note_applications` row.
 *
 * **Every operand of `credit_note_applications_realized_ck` is here**, which is
 * the point: the CHECK is
 *
 *     realized_fx_gain_loss_minor
 *       = credit_carrying_base_released_minor − invoice_carrying_base_released_minor
 *
 * so a write shape missing either carrying column, or the realized column,
 * cannot satisfy a constraint it cannot address — the row would have to be
 * completed by something other than the plan, which is a second place the
 * number is decided. All seven come out of `planCreditNoteApplication`, which
 * is `planCustomerCreditApplication` relabelled, so they come out of the ONE
 * canonical AR algorithm and are consistent by construction rather than by a
 * caller remembering to subtract.
 *
 * The two level columns are the pair P4-AL-22's chain verifier walks:
 * `arReleasedBeforeTxnMinor` is the invoice's `X = T − O` and
 * `creditRemainingBeforeMinor` is the note's `rb`. Neither is derivable after
 * the fact, which is why both are stored.
 */
export interface CreditNoteApplicationWrite {
  readonly applicationId: string;
  readonly lineNo: number;
  /**
   * The IDENTITY columns. `customer_id` is `NOT NULL` on the relation and is an
   * operand of both composite FK edges (§3.2), which is why it is named here and
   * not inferred by the port from a join: a port that filled it by reading
   * `credit_notes.customer_id` would make the row's customer a second read
   * nobody planned, and the identity pin is the command's, taken under the
   * `customers` lock at rank 1.
   *
   * `creditNoteId` is here for the same reason and was missed twice: the first
   * draft omitted it with the three carrying columns, and round 3's widening
   * added the four columns the challenger named while leaving this one out. It
   * was found by DERIVING the mandatory set from §3 of the DDL specification
   * rather than restating it in a test — which is the whole argument for
   * deriving an expected quantity from something other than the expression
   * under test.
   */
  readonly creditNoteId: string;
  readonly customerId: string;
  readonly invoiceId: string;
  /**
   * `application_date DATE NOT NULL`.
   *
   * **This field's VALIDITY is the COMMAND's, not this type's and not the
   * mapper's.** `creditNoteApplicationRow` asserts PRESENCE only — a non-empty
   * string — because a `NOT NULL` column with no default and an empty string are
   * the same defect arriving at different layers. It does NOT judge the date:
   * `'2026-13-45'` passes the mapper and is refused earlier, by
   * `returnsDateRefusal` in `@daftar/domain-core`, which compares the document
   * date against the origin date and the business's today and raises
   * `credit_note.date_invalid`, `date_before_invoice` or `date_in_future`.
   *
   * Said explicitly because an earlier version of this comment claimed the date
   * was "judged by `returnsDateRefusal`" HERE, which is the same overclaim as a
   * guard that reads its expected value off its own subject. The judgment belongs
   * in the command, where the origin date and the business day are in scope; it
   * is never `now()` (`[[daftar-a-command-must-not-read-the-clock]]`).
   */
  readonly applicationDate: string;
  /**
   * The two CURRENCY columns, `NOT NULL` on the relation and **the two operands
   * of `credit_note_applications_same_currency_ck`**:
   *
   *     CHECK (credit_currency <> invoice_currency
   *            OR credit_amount_consumed_minor = invoice_amount_applied_minor)
   *
   * They are here because a CHECK whose operands the legitimate command cannot
   * address is an invalid design. They are also already KNOWN to the command:
   * `planCreditNoteApplication` takes `sameCurrency` as an INPUT, so the pair is
   * a decision the plan was handed, not a fact to be rediscovered by joining the
   * note and the invoice after the fact.
   */
  readonly creditCurrencyCode: string;
  readonly invoiceCurrencyCode: string;
  /** The invoice's AR released BEFORE this application — the level, read under the invoice's lock. */
  readonly arReleasedBeforeTxnMinor: bigint;
  /** The note's remaining BEFORE this application — the note's own level, read under the note's lock. */
  readonly creditRemainingBeforeMinor: bigint;
  readonly creditAmountConsumedMinor: bigint;
  /** `cr_rel = g(rb) − g(rb − c)`: the carrying base the NOTE gives up. */
  readonly creditCarryingBaseReleasedMinor: bigint;
  readonly invoiceAmountAppliedMinor: bigint;
  /** `rel = R(X + a) − R(X)`: the carrying base the INVOICE releases. */
  readonly invoiceCarryingBaseReleasedMinor: bigint;
  /** `cr_rel − rel`, signed: > 0 a gain (4900), < 0 a loss (6900). Never recomputed by the port. */
  readonly realizedFxGainLossMinor: bigint;
}

/**
 * The facts a `credit_note_applications` row needs that the PLAN cannot supply:
 * identities, a date and the two currency codes.
 *
 * It exists so that `creditNoteApplicationRow` can take exactly two arguments —
 * these, and the plan — and so that the boundary between "what the command
 * decided" and "what the arithmetic computed" is a type and not a convention.
 */
export interface CreditNoteApplicationIdentity {
  readonly applicationId: string;
  readonly lineNo: number;
  readonly creditNoteId: string;
  readonly customerId: string;
  readonly invoiceId: string;
  readonly applicationDate: string;
  readonly creditCurrencyCode: string;
  readonly invoiceCurrencyCode: string;
}

// ── The refund port ─────────────────────────────────────────────────────

export interface RefundWrite {
  readonly refundId: string;
  readonly customerId: string;
  /** Exactly one of the two is non-null. The row's `CHECK (num_nonnulls(...) = 1)` is the other half of this. */
  readonly creditNoteId: string | null;
  readonly customerCreditId: string | null;
  readonly paymentMethodId: string;
  readonly postingAccountId: string;
  readonly refundDate: string;
  readonly reference: string | null;
  readonly sourceCurrencyCode: string;
  readonly sourceAmountConsumedMinor: bigint;
  /** The LEVEL: the source's remaining as the lock returned it. */
  readonly sourceRemainingBeforeMinor: bigint;
  readonly sourceCarryingBaseReleasedMinor: bigint;
  readonly sourceDustBaseMinor: bigint;
  readonly disbursementCurrencyCode: string;
  readonly disbursementAmountMinor: bigint;
  readonly disbursementBaseAmountMinor: bigint;
  readonly realizedFxGainLossMinor: bigint;
  /** The hash of `refundIntentPreimage`. Computed by the one hashing authority, never by this slice. */
  readonly intentSha256: string;
}

export interface RefundPort {
  /**
   * Insert the refund row at the locked level.
   *
   * It is inserted BEFORE the source is decremented, so the decrement's guard
   * finds exactly one backing row for it — the `customer_credit_guard`
   * (`0081:1107-1114`) condition, `count(*) = 1` over the union of consumer
   * relations, never `>= 1` and never one count per relation. Two backing rows
   * for one decrement is the double consumption that guard exists to refuse.
   */
  insertRefund(scope: ReturnsScope, row: RefundWrite): Promise<void>;

  /**
   * The stored intent of `refundId`, or `null` when the key is fresh.
   *
   * It returns the INTENT and not a boolean, because the verdict is
   * `refundReplayVerdict(stored, incoming)` and a port that answered
   * "already seen" would let a different economic command reuse a key. Law 8: no
   * key may silently accept a different economic command.
   */
  storedIntent(scope: ReturnsScope, refundId: string): Promise<RefundIntent | null>;
}

// ── The stock-movement seam ─────────────────────────────────────────────

/**
 * The return's stock movements, requested from the ONE accepted
 * stock-movement authority and read back.
 *
 * This port WRITES NOTHING. It asks `inventory_apply_stock_movements` — which
 * computes an outbound or inbound movement's value itself and REFUSES a caller
 * that supplies one (`0060:376-394`) — and returns the stored
 * `value_delta_base_minor` of each movement it made. There is no second stock
 * writer in this slice, and the COGS reversal's amount is the sum of exactly
 * these integers.
 */
export interface ReturnStockPort {
  requestReturnMovements(
    scope: ReturnsScope,
    creditNoteId: string,
    lines: readonly { readonly productId: string; readonly quantity: string; readonly warehouseId: string }[],
  ): Promise<readonly ReturnedMovementValue[]>;
}

// ── The read ports (the read-path obligation) ───────────────────────────

/**
 * The reads of what the commands wrote.
 *
 * A credit note and a refund each get a REAL read path: "state whose only
 * reader is its own commands' return value has NO read path", the recorded
 * lesson being the POS basket whose rows sat in `pos_cart_lines` while a
 * reloaded till screen lost them.
 *
 * Three rules these ports are shaped by:
 *
 * - a derived figure is read through a FUNCTION in a `FROM` — the CORRECT read
 *   path (P4-AL-07, `tests/guards/phase4-read-surface-guard.test.ts:162`) — and
 *   never recomputed in TypeScript;
 * - **no read module writes anything.** `scripts/guards/read-surface.ts:166-167`
 *   refuses any DML statement shape in a `*-reads.ts` module whatever the
 *   relation is called, and `:174-175` refuses a module-level result cache. So
 *   the implementation of these ports goes in `returns-reads.ts` and holds no
 *   module-level state;
 * - `cursor` is opaque and keyset-based, the `customer_open_invoices_page`
 *   (`0084:795`) shape. An OFFSET page over a growing collection re-reads and
 *   skips rows, and its cost grows with the offset.
 */
export interface ReturnsReadPort {
  creditNote(scope: ReturnsScope, creditNoteId: string): Promise<CreditNoteRow | null>;
  customerCreditNotesPage(
    scope: ReturnsScope,
    customerId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ readonly rows: readonly CreditNoteRow[]; readonly nextCursor: string | null }>;
  refund(scope: ReturnsScope, refundId: string): Promise<RefundWrite | null>;
  customerRefundsPage(
    scope: ReturnsScope,
    customerId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ readonly rows: readonly RefundWrite[]; readonly nextCursor: string | null }>;
}

// -- H2: the one mapper from a PLAN to a lawful application ROW ---------

/**
 * `TL-P4-S5-R2`: **"A relation with required financial columns that the
 * legitimate command cannot populate is an invalid design. Fix the type/port
 * before promotion."**
 *
 * The first draft of `CreditNoteApplicationWrite` named SEVEN fields while
 * `credit_note_applications` declares TWENTY `NOT NULL` columns with no default
 * and no `GENERATED` clause — fifteen of them the command's, and nothing in the slice turned a plan into a row — so the write
 * shape was not merely narrow, it was NEVER EXERCISED: no code path existed in
 * which the four missing columns could be noticed as missing. The type is
 * widened above; this function is the other half, and it is what makes the
 * widening load-bearing rather than decorative.
 *
 * **The amount fields come from the PLAN by construction.** The command does
 * not get to pass them. A command that could pass its own
 * `realizedFxGainLossMinor` would be a second place where realized FX is
 * decided, which is the defect `TL-P4-S5-R2` forbids one level down from where
 * it forbade a second AR reduction.
 *
 * The identity fields come from the COMMAND, because they are not arithmetic:
 * the ids are pinned under the `customers` lock at rank 1, the date is the
 * command's date — ALREADY judged by `returnsDateRefusal` before it reaches
 * here, since this function asserts its PRESENCE and not its validity (see
 * `applicationDate` on the write shape above) — and the two currency codes
 * are the operands of `credit_note_applications_same_currency_ck`, already
 * known to the command because `sameCurrency` is an INPUT to
 * `planCreditNoteApplication`.
 */
export function creditNoteApplicationRow(identity: CreditNoteApplicationIdentity, plan: CreditNoteApplicationPlan): CreditNoteApplicationWrite {
  for (const [name, value] of Object.entries(identity)) {
    // A `NOT NULL` column with no default and an empty string are the same
    // defect arriving at different layers. This refusal IS reachable from a
    // legitimate command path: a handler that forgot to pin `customerId` under
    // the rank-1 lock reaches it with `''`, which is exactly the mistake the
    // composite FK edges of §3.2 would otherwise report as a foreign-key
    // violation at COMMIT, far from its cause.
    if (name === 'lineNo') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new ReturnsPlanError('customer_refund.arithmetic_invalid', 'an application line number is a positive integer');
      }
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new ReturnsPlanError('customer_refund.arithmetic_invalid', `an application row needs its ${name}; a NOT NULL column is not a convention`);
    }
  }
  return Object.freeze({
    applicationId: identity.applicationId,
    lineNo: identity.lineNo,
    creditNoteId: identity.creditNoteId,
    customerId: identity.customerId,
    invoiceId: identity.invoiceId,
    applicationDate: identity.applicationDate,
    creditCurrencyCode: identity.creditCurrencyCode,
    invoiceCurrencyCode: identity.invoiceCurrencyCode,
    arReleasedBeforeTxnMinor: plan.arReleasedBeforeMinor,
    creditRemainingBeforeMinor: plan.creditRemainingBeforeMinor,
    creditAmountConsumedMinor: plan.creditAmountConsumedMinor,
    creditCarryingBaseReleasedMinor: plan.creditCarryingReleasedMinor,
    invoiceAmountAppliedMinor: plan.invoiceAmountAppliedMinor,
    invoiceCarryingBaseReleasedMinor: plan.invoiceCarryingReleasedMinor,
    realizedFxGainLossMinor: plan.realizedFxMinor,
  });
}

/** The net BASE movement on one account across an entry, debits positive. Written here, not imported, so the two expressions are genuinely two. */
function netBaseOnLines(lines: readonly ReturnsEntryLine[], account: string): bigint {
  let net = 0n;
  for (const l of lines) {
    if (l.account !== account) continue;
    net += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  return net;
}

/**
 * The row and the ENTRY are the same application, so the row's financial
 * columns must agree with the entry's lines.
 *
 * **Why this is not circular.** `assertApplicationEntryComplete` reads the
 * plan's AMOUNT fields and checks the LINES; this reads the ROW's columns and
 * checks them against the same lines by a different expression — a per-account
 * net over the entry, summed here from `side` and `baseAmountMinor`, not read
 * off the plan. So the expected quantity for each of the three money columns is
 * derived from something other than the field under test:
 *
 * - `invoice_carrying_base_released_minor` = the net CREDIT on `1100`, which is
 *   the principal line `conv_R(a)` PLUS its dust and therefore `rel` — the
 *   dust decomposition is why this is a different expression and not the same
 *   number spelled twice;
 * - `credit_carrying_base_released_minor` = the net DEBIT on the application's
 *   liability account, likewise principal plus dust;
 * - `realized_fx_gain_loss_minor` = the net on `4900`/`6900`, signed as a
 *   credit-positive gain.
 *
 * A mapper that crossed the two carrying columns — the single most likely
 * hand-wiring mistake, since both are `BIGINT NOT NULL` and adjacent — passes
 * every `NOT NULL`, passes the same-currency `CHECK` whenever the codes differ,
 * and is caught here and only here.
 */
export function assertApplicationRowAgreesWithEntry(row: CreditNoteApplicationWrite, plan: CreditNoteApplicationPlan): void {
  const lines = plan.entryLines;
  const arNetCredit = -netBaseOnLines(lines, S5_ACCOUNT.ACCOUNTS_RECEIVABLE);
  // The account is READ from the one constant that names it, never spelled here:
  // a literal in this file would survive `PATCH-REQ-S5-008` moving the constant
  // and would then net an account no line names.
  const liabilityNetDebit = netBaseOnLines(lines, APPLICATION_LIABILITY_ACCOUNT);
  // A gain is a CREDIT and a loss a DEBIT, so the realized amount is the
  // negation of the SUM of both accounts' nets.
  //
  // Unconditional, and deliberately so. An earlier version read whichever
  // account was non-zero, which is correct in three of the four cases and wrong
  // in the fourth: an entry that posted BOTH a gain and a loss line dropped the
  // loss from the expression entirely and attributed a gain the entry had not
  // netted. `assertApplicationEntryComplete` sums both and would catch it, so
  // the slice had no hole — but a second expression of one quantity that is less
  // faithful than the first is the opposite of what this function claims for
  // itself, and the sum is correct in all four cases and shorter.
  const realizedFromLines = -(netBaseOnLines(lines, S5_ACCOUNT.FX_GAIN) + netBaseOnLines(lines, S5_ACCOUNT.FX_LOSS));
  const bad = (message: string): never => {
    throw new ReturnsPlanError('credit_note.posting_incomplete', message);
  };
  if (row.invoiceCarryingBaseReleasedMinor !== arNetCredit) {
    bad('the row’s invoice carrying release must equal the receivable the entry releases');
  }
  if (row.creditCarryingBaseReleasedMinor !== liabilityNetDebit) {
    bad('the row’s credit carrying release must equal the liability the entry discharges');
  }
  if (row.realizedFxGainLossMinor !== realizedFromLines) {
    bad('the row’s realized FX must equal the realized FX the entry posts');
  }
  // The four-term identity of `TL-P4-S5-R2`, over the ROW's own columns, in
  // integer minor units: what the liability gives up is what the receivable
  // releases plus what was realized. No unexplained one-minor drift is
  // admitted, and there is no rounding account to absorb one.
  if (row.creditCarryingBaseReleasedMinor !== row.invoiceCarryingBaseReleasedMinor + row.realizedFxGainLossMinor) {
    bad('the row’s carrying releases and realized FX must reconcile exactly');
  }
}

/** The whole port surface of the slice, in one place, so a composition root names one thing. */
export interface ReturnsPorts {
  readonly source: RefundSourcePort;
  readonly creditNotes: CreditNotePort;
  readonly refunds: RefundPort;
  readonly stock: ReturnStockPort;
  readonly reads: ReturnsReadPort;
}
