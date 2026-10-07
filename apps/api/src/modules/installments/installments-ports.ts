import type { CivilDate, Schedule } from '@daftar/domain-core';
import type { CustomerDebtsDto, CustomerStatementDto, InstallmentPageDto, InstallmentPlanAgingDto, InstallmentPlanDto } from './installments-contracts';
import type {
  CancelInstallmentPlanRequest,
  CreateInstallmentPlanRequest,
  CustomerDebtsQuery,
  CustomerStatementQuery,
  InstallmentPageQuery,
  InstallmentPlanAgingQuery,
  InstallmentPlanQuery,
  RescheduleInstallmentPlanRequest,
} from './installments.schemas';

/**
 * P4-S7 — THE REPOSITORY PORTS of the instalment slice.
 *
 * Maturity level B: interfaces. No implementation, no connection, no SQL. A
 * port is a contract against which level C can test the arithmetic and the
 * refusal set with an IN-MEMORY model, and against which level F will bind the
 * real relations the day S4, S5 and S6 seal and S7 is promoted.
 *
 * ── WHY PORTS AND NOT A SERVICE ─────────────────────────────────────────
 *
 * The owner's directive is explicit that interfaces, repository ports, test
 * fixtures, reference models and in-memory test models are allowed, and that
 * inventing production schema to make something runnable is not. A service
 * holding SQL against `installment_plans` would be the second thing: the
 * relation does not exist, there is exactly ONE migration owner in this phase
 * and it is not this slice, and the real migration prefix is unknown until the
 * predecessors seal. So the SQL lives in the DDL SPECIFICATION and the read
 * QUERY DESIGN of the contract pack, where it can be reviewed without being
 * executed, and these ports are the seam it will be bound behind.
 *
 * ── THE ONE SETTLEMENT FIGURE IS A PORT INPUT, NOT A PORT ───────────────
 *
 * `InstallmentSettlementPort.invoiceOutstanding` is the ONLY way any figure in
 * this slice gets a number, and its contract is written to be unimplementable
 * any other way: it names `invoice_outstanding(business, invoice)` as the body
 * that answers it. There is no `planOutstanding`, no `scheduleBalance` and no
 * `installmentPaid` port anywhere below, because every one of those would be a
 * second place a balance could come from — which is to say a second truth
 * (P4-AL-06, P4-AL-07).
 *
 * ── THE TRANSACTION BOUNDARY ────────────────────────────────────────────
 *
 * `InstallmentPlanWritePort`'s three commands are each ONE transaction, and
 * the transaction is the ROUTINE's, not this layer's: the accepted shape of
 * this estate is a single `SELECT` of a `plpgsql` command function that holds
 * its own advisory lock, does its own reads under row security, and commits or
 * rolls back as one. A service that opened a transaction, read, computed and
 * wrote would be a read-then-write race with a lock in the wrong place.
 *
 * The declared LOCK ORDER of this slice, which the contract pack records and
 * S8's static check will police, is:
 *
 *     advisory(plan id) → invoices → installment_plans → installments
 *
 * — the same direction the receivables commands take
 * (`advisory(payment id) → invoices → payment_allocations`), so the two can
 * never deadlock against each other by taking one pair in opposite orders.
 *
 * ── READS ARE READS ─────────────────────────────────────────────────────
 *
 * `InstallmentPlanReadPort` is separate from the write port, and the write
 * port's commands RETURN `InstallmentPlanDto` — the read port's own type,
 * produced by the read port's own projection. That is the recorded lesson «a
 * command's answer is not a read path» honoured in the type system: there is
 * no command-shaped plan view to drift from the read-shaped one, because there
 * is only one.
 */

/** The scope every port call runs in. Read as `daftar_app` under row level security — never an internal role, never a widened GUC. */
export interface InstallmentScope {
  readonly tenantId: string;
  readonly businessId: string;
  /** The acting member, for the refusal that is an authorization answer and for the audit row. */
  readonly actorId: string;
}

/**
 * THE ONE SETTLEMENT FIGURE.
 *
 * `invoiceOutstanding` must be implemented as
 * `invoice_outstanding(p_business_id, p_invoice_id)` — `0084:§5`'s one
 * definition, reached through its wrapper — and as nothing else. Not a stored
 * column (P4-AL-06 refuses one), not a sum computed in TypeScript (P4-AL-07
 * calls that "a second truth with a slower failure mode, because it disagrees
 * only under the numbers nobody tested"), and not the journal.
 *
 * It returns the TRANSACTION-currency figure only. The base figure is
 * deliberately not plumbed through this slice: converting at the instalment
 * grain would be a second rounding over the same money at a second
 * aggregation grain, which is exactly the defect the recorded lesson names. A
 * caller that needs base minor units reads them off the one definition for the
 * INVOICE, where they are computed once.
 */
export interface InstallmentSettlementPort {
  /**
   * The invoice's total and its outstanding figure, in the invoice's own
   * transaction currency, both from the one definition.
   *
   * Returns `null` when the invoice is not visible to this scope — including
   * an invoice of another business, which row security hides. The caller
   * answers that with `installment_plan.not_found`, never with a forbidden:
   * the answer must not reveal whether the row exists (G-02).
   */
  invoiceOutstanding(
    scope: InstallmentScope,
    invoiceId: string,
  ): Promise<{
    readonly currency: string;
    readonly totalTxnMinor: bigint;
    readonly outstandingTxnMinor: bigint;
    readonly issueDate: CivilDate;
    readonly dueDate: CivilDate | null;
    readonly customerId: string | null;
    readonly lifecycle: 'draft' | 'open' | 'void';
    /** `0080`: a cash-settled invoice raises no receivable, so it may carry no schedule. */
    readonly settlementMode: 'cash' | 'credit';
  } | null>;
}

/** The stored half of a plan: its identity, its dates and its lines. No status and no balance — both are derived. */
export interface StoredPlan {
  readonly planId: string;
  readonly invoiceId: string;
  readonly customerId: string;
  readonly currency: string;
  readonly lifecycle: 'active' | 'cancelled';
  /** The schedule as a value, exactly as `installment-schedule.ts` models it. */
  readonly schedule: Schedule;
}

/**
 * THE READS. Every one takes a SUPPLIED `asOf` and derives every status from
 * it (L2); none reads the clock, and none is allowed a default.
 *
 * Each is a READ PATH in the full sense the recorded lesson demands: the same
 * projection as the write, its own refusal set, and an empty collection
 * answered as an empty collection.
 *
 * `statement` and `debts` are KEYSET pages (law 5): the cursor carries every
 * component of the ordering key, there is no `OFFSET`, and
 * `scripts/guards/read-surface.ts`' `no OFFSET pagination` rule polices the
 * implementing module statically the day it is written at
 * `apps/api/src/modules/installments/installments-reads.ts`.
 */
export interface InstallmentPlanReadPort {
  /** One plan, projected at `query.asOf`. `null` when the plan is not visible to this scope. */
  plan(scope: InstallmentScope, planId: string, query: InstallmentPlanQuery): Promise<InstallmentPlanDto | null>;
  /** The keyset page over one plan's instalments, ordered `(due_date, seq_no)`. An exhausted page is `items: []`, never a refusal. */
  installments(scope: InstallmentScope, planId: string, query: InstallmentPageQuery): Promise<InstallmentPageDto | null>;
  /** The keyset page over a customer's debt history, ordered `(entry_date, entry_kind, entry_id)`. */
  statement(scope: InstallmentScope, customerId: string, query: CustomerStatementQuery): Promise<CustomerStatementDto | null>;
  /** The keyset page over a customer's open debts at `query.asOf`. */
  debts(scope: InstallmentScope, customerId: string, query: CustomerDebtsQuery): Promise<CustomerDebtsDto | null>;
  /**
   * The SCHEDULE-GRAIN aging of ONE plan, over supplied boundaries.
   *
   * Scoped to one plan by its signature: there is no customer-level overload,
   * so this cannot be summed into a competing customer aging. The aging of
   * record stays `customer_ar_aging(business, customer, as_of, bucket_days)`
   * and this slice does not change it (`PATCH-REQ-S7-001` is where the grain
   * question is raised for the owner).
   */
  aging(scope: InstallmentScope, planId: string, query: InstallmentPlanAgingQuery): Promise<InstallmentPlanAgingDto | null>;
}

/**
 * THE WRITES. Three commands, each one transaction, each idempotent on a
 * caller-chosen id plus a server-computed intent digest (P4-AL-30).
 *
 * ── IDEMPOTENCY, STATED PRECISELY (law 9) ───────────────────────────────
 *
 * Same identity + same intent hash → EXACT REPLAY: the stored plan is
 * returned, projected afresh at the NEW request's `asOf`, and nothing is
 * written. Same identity + a CHANGED intent hash →
 * `installment_plan.idempotency_conflict`, a 409. No key may silently accept a
 * different economic command.
 *
 * The intent digest covers every economically meaningful field of the request,
 * and it covers the SUPPLIED DATES — which is the whole reason the dates are
 * supplied. A digest over a server-resolved date is not a digest: the same
 * retry sent either side of local midnight hashes differently, so an exact
 * replay is reported as a conflict and a client that retries correctly is
 * refused. That is the seam this slice's law 3 exists to keep closed, and the
 * contract pack records that closing it at the VALIDATION layer alone is not
 * closing it: if the trusted database routine still resolves "today" itself,
 * the seam is open whatever the schema refuses.
 *
 * ── COLLECTION IS NOT HERE (law 4) ──────────────────────────────────────
 *
 * There is no `collect`, no `payInstallment` and no `settleInstallment` port.
 * Collecting against a plan is the ORDINARY customer payment of P4-S4,
 * allocated to the INVOICE through `customer_collect_payment`, and this slice
 * writes no second collection mechanism. The plan's figures move because the
 * one settlement figure moved; nothing in this interface is called.
 */
export interface InstallmentPlanWritePort {
  /**
   * Write a plan over an existing receivable.
   *
   * Posts NOTHING. There is no journal entry, no accounting source type and no
   * account: the receivable was posted by the sale, and a schedule over it
   * moves no money. That is why this is the one Phase 4 command of its kind
   * with no `accounting source type` in the contract pack's table, and the
   * contract pack says so rather than leaving the omission to be noticed.
   */
  create(scope: InstallmentScope, request: CreateInstallmentPlanRequest): Promise<InstallmentPlanDto>;
  /** Replace the plan's unsettled tail. Refuses `settled_installment_immutable` for any collected instalment it would move or re-price. */
  reschedule(scope: InstallmentScope, planId: string, request: RescheduleInstallmentPlanRequest): Promise<InstallmentPlanDto>;
  /**
   * End the schedule. The receivable is UNCHANGED: after this command
   * `invoice_outstanding` returns exactly what it returned before, which is
   * the clearest statement of law 1 the slice can make and is owed its own
   * golden test.
   */
  cancel(scope: InstallmentScope, planId: string, request: CancelInstallmentPlanRequest): Promise<InstallmentPlanDto>;
}

/**
 * The ONE place this slice's `asOf` may come from: the CALLER.
 *
 * A port rather than a parameter convention, because a convention is what the
 * next author does not know about. An implementation that resolves the date
 * from the server cannot satisfy this interface without saying so in its own
 * name, and the contract pack's test hooks require the implementation to be
 * the identity function over the request's field.
 */
export interface AsOfPort {
  /** The as-of date for this request, which is the one the caller supplied and nothing else. */
  asOf(supplied: CivilDate): CivilDate;
}
