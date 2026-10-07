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
import type { CreditNoteLifecycleState, RefundIntent, RefundSourceKind, ReturnedMovementValue } from '@daftar/domain-core';
import type { ConsumableSource, SourceConsumerRow } from './returns-settlement';

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
export interface CreditNoteRow {
  readonly creditNoteId: string;
  readonly creditNoteNumber: string;
  readonly customerId: string;
  readonly status: CreditNoteLifecycleState;
  readonly currencyCode: string;
  readonly totalMinor: bigint;
  readonly remainingMinor: bigint;
  readonly remainingCarryingMinor: bigint;
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
  insertCreditNote(scope: ReturnsScope, row: CreditNoteRow, items: readonly CreditNoteItemWrite[]): Promise<void>;

  /**
   * Insert the applications that reduce AR — at most one per invoice, each at
   * the invoice's own AR level.
   *
   * **This is the ONE place AR falls in this slice**, and it falls once. The
   * level (`arReleasedBeforeTxnMinor`) is read under the invoice's lock in this
   * same transaction, and the level `UNIQUE` on the relation is the fast
   * per-relation backstop — not the invariant. The invariant is
   * `invoice_settlement_verify` at COMMIT (P4-AL-22).
   */
  insertApplications(scope: ReturnsScope, creditNoteId: string, applications: readonly CreditNoteApplicationWrite[]): Promise<void>;

  /** Lock a note and read its pair — the void command's first step. */
  lockCreditNote(scope: ReturnsScope, creditNoteId: string): Promise<CreditNoteRow | null>;

  /** Set the lifecycle. The enumerated transitions are the domain's; a port never decides one. */
  setLifecycle(scope: ReturnsScope, creditNoteId: string, to: CreditNoteLifecycleState): Promise<void>;
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

export interface CreditNoteApplicationWrite {
  readonly applicationId: string;
  readonly lineNo: number;
  readonly invoiceId: string;
  /** The invoice's AR released BEFORE this application — the level, read under the invoice's lock. */
  readonly arReleasedBeforeTxnMinor: bigint;
  readonly creditAmountConsumedMinor: bigint;
  readonly invoiceAmountAppliedMinor: bigint;
  readonly invoiceCarryingBaseReleasedMinor: bigint;
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

/** The whole port surface of the slice, in one place, so a composition root names one thing. */
export interface ReturnsPorts {
  readonly source: RefundSourcePort;
  readonly creditNotes: CreditNotePort;
  readonly refunds: RefundPort;
  readonly stock: ReturnStockPort;
  readonly reads: ReturnsReadPort;
}
