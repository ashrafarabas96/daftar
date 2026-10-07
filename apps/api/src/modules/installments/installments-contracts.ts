import type { InstallmentStatus, PlanStatus, RemainderPlacement } from '@daftar/domain-core';
import type { StatementEntryKind } from './installments.schemas';

/**
 * P4-S7 — THE RESPONSE CONTRACTS of the instalment plan, the debt reads and
 * the statement.
 *
 * Maturity level B. Types only: nothing here opens a connection and nothing
 * computes a figure.
 *
 * ── EVERY MONEY FIGURE IS A STRING ──────────────────────────────────────
 *
 * A decimal string of minor units, parsed from `bigint`. 10^18 minor units
 * does not survive a JSON number and `[[no float money]]` is not a style rule.
 * A field named `*Minor` is therefore always `string`, never `number`; a field
 * that is a `number` is always a bounded count — a sequence number, a day
 * difference, a row count.
 *
 * ── EVERY RESPONSE CARRIES THE `asOf` IT WAS COMPUTED AT ────────────────
 *
 * Not decoration. Every status and every day figure below is a function of a
 * supplied `asOf` (L2), so a response that does not echo it is a response
 * nobody can reproduce and a screen nobody can check. The echo is what lets a
 * client cache, a support engineer re-ask and a test assert.
 *
 * ── THE RECORDED LESSON THIS FILE IS SHAPED BY ──────────────────────────
 *
 * «A command's answer is not a read path. State whose only reader is its own
 * command's return value has NO read path: a client that reloads loses it.»
 *
 * So the plan a `POST` returns and the plan a `GET` returns are THE SAME TYPE,
 * `InstallmentPlanDto`, produced by the SAME projection over the SAME
 * settlement figure — not a command-shaped echo beside a read-shaped view.
 * `InstallmentPlanReadPort.plan` is what both go through, and the contract pack
 * records that as a binding integration seam rather than a convention.
 *
 * Two corollaries are written into the types:
 *
 * - the refusal set of the READ is NOT the refusal set of the WRITE. A read
 *   refuses `installment_plan.not_found` and `installment.cursor_invalid` and
 *   nothing else; it cannot refuse `schedule_sum_mismatch`, which is a
 *   judgement on a command;
 * - AN EMPTY COLLECTION IS NEVER A REFUSAL. A customer with no plan, a plan
 *   whose page is exhausted, a statement with no entry in range: each is
 *   `items: []` with `nextCursor: null`, a 200. `installment_plan.not_found`
 *   means the PLAN is not visible, never that its schedule is empty.
 */

/** One projected instalment. Every figure is derived from the ONE outstanding figure at `asOf`. */
export interface InstallmentDto {
  /** `1..n`, dense within the plan, and the keyset cursor of the instalment page. */
  readonly seqNo: number;
  readonly dueDate: string;
  readonly amountMinor: string;
  /** How much of the invoice's settled amount the waterfall places here. Projected, never stored. */
  readonly settledMinor: string;
  /** `amountMinor - settledMinor`. Projected, never stored. */
  readonly remainingMinor: string;
  /** Derived from `(amount, settled, dueDate, asOf)` and nothing else (L2). */
  readonly status: InstallmentStatus;
  /** `asOf - dueDate` in whole days; negative before the due date. */
  readonly daysPastDue: number;
}

/**
 * The plan, projected.
 *
 * `outstandingMinor` IS the invoice's own
 * `invoice_outstanding(business, invoice).outstanding_txn_minor` and is echoed
 * here unchanged. That is deliberate and is the field a reviewer should check
 * first: `Σ installments[].remainingMinor + (downPaymentMinor -
 * downPaymentSettledMinor) = outstandingMinor` exactly, so the response
 * carries its own proof that the schedule holds no money of its own.
 *
 * There is no `totalPaidMinor` and no `balanceMinor`. Both would be a second
 * name for a figure already here, and a second name for one figure is how two
 * screens come to disagree.
 */
export interface InstallmentPlanDto {
  readonly planId: string;
  readonly invoiceId: string;
  readonly customerId: string;
  /** The echoed as-of date every status and day figure below was derived at. */
  readonly asOf: string;
  /** The invoice's transaction currency. One plan, one currency: the invoice's. */
  readonly currency: string;
  readonly startDate: string;
  readonly totalMinor: string;
  readonly downPaymentMinor: string;
  readonly downPaymentSettledMinor: string;
  /** The ONE settlement figure, echoed. Not recomputed here and not reconciled against anything. */
  readonly outstandingMinor: string;
  readonly remainderPlacement: RemainderPlacement;
  readonly status: PlanStatus;
  /** `Σ` of the overdue instalments' remaining figures at `asOf`. Derived; recomputable; never a row. */
  readonly overdueMinor: string;
  readonly nextDueDate: string | null;
  /** The plan's lifecycle, which is NOT its settlement: `active` or `cancelled`, never `paid`. */
  readonly lifecycle: 'active' | 'cancelled';
  readonly installmentCount: number;
}

/**
 * The keyset page over one plan's instalments.
 *
 * `nextCursor` is the last emitted row's `seqNo` as a string, or `null` when
 * the page is the last one. It is decided by the `limit + 1` probe — the
 * accepted shape at `customer-reads.ts:396` — and never by comparing a count
 * against a total, which would need a `COUNT(*)` over the very set the page
 * exists to avoid walking.
 */
export interface InstallmentPageDto {
  readonly planId: string;
  readonly asOf: string;
  readonly items: readonly InstallmentDto[];
  readonly nextCursor: string | null;
}

/**
 * ONE ENTRY of a customer statement.
 *
 * ── WHAT A STATEMENT IS, HERE ───────────────────────────────────────────
 *
 * A statement is a READ OVER DOCUMENTS THAT ALREADY EXIST — invoices,
 * payments, credit applications — plus the SCHEDULE's own due dates as
 * informational rows. It is not a ledger of its own, it stores nothing, and it
 * has no row that exists only because the statement wanted one.
 *
 * `installment_due` is the one entry kind that is not a document, and it is
 * the one to be most careful about: it carries `amountMinor` (what falls due)
 * and `remainingMinor` (what is still owed against it at `asOf`), and it
 * carries NO `runningBalanceMinor`. A running balance over a mixed stream is a
 * second balance with a second ordering, and two orderings of one stream
 * disagree the first time two rows share a date.
 *
 * So there is **no `runningBalanceMinor` anywhere in this file.** The
 * customer's balance is `customer_ar_outstanding(business, customer)` and the
 * aging is `customer_ar_aging(business, customer, as_of, bucket_days)` — both
 * of record, both already in the tree (`0084:678`, `0084:699`), and neither
 * re-derived here.
 */
export interface StatementEntryDto {
  readonly entryKind: StatementEntryKind;
  /** The row's own id, and the third component of the keyset cursor. */
  readonly entryId: string;
  /** The civil date the entry is ordered by: a document's own date, or an instalment's due date. */
  readonly entryDate: string;
  readonly currency: string;
  /** What the entry is for: an invoice total, an amount received, a credit applied, an instalment falling due. */
  readonly amountMinor: string;
  /**
   * What is still owed against this entry at `asOf`, where the question means
   * anything — an invoice and an instalment have one, a payment does not.
   * `null` rather than `'0'` for the kinds where it is meaningless: `'0'` would
   * read as "settled".
   */
  readonly remainingMinor: string | null;
  /** The merchant-facing document number, when the entry is a numbered document. */
  readonly documentNumber: string | null;
  /** The plan an `installment_due` entry belongs to; `null` on every other kind. */
  readonly planId: string | null;
  /** The instalment's sequence number on an `installment_due` entry; `null` otherwise. */
  readonly seqNo: number | null;
}

/**
 * The keyset page of a statement.
 *
 * `nextCursor` carries all three ordering components, so the continuation is
 * exact over a stream whose dates and kinds both repeat. There is no `total`,
 * no `pageCount` and no `hasMore` boolean beside the cursor: a count over a
 * customer's whole history is the walk the keyset exists to avoid, and
 * `nextCursor === null` already says "this was the last page".
 */
export interface CustomerStatementDto {
  readonly customerId: string;
  readonly asOf: string;
  readonly from: string | null;
  readonly items: readonly StatementEntryDto[];
  readonly nextCursor: string | null;
}

/** One open debt of a customer: an invoice that still owes something, with its plan when it has one. */
export interface CustomerDebtDto {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly totalMinor: string;
  /** The one settlement figure for this invoice, echoed off `invoice_outstanding`. */
  readonly outstandingTxnMinor: string;
  readonly outstandingBaseMinor: string;
  /** The plan over this debt, when there is an active one. `null` is an ordinary credit invoice with no schedule. */
  readonly planId: string | null;
  readonly planStatus: PlanStatus | null;
  readonly nextDueDate: string | null;
  /** `asOf - dueDate` in whole days, measured against the SUPPLIED date; `null` when the invoice carries no due date. */
  readonly daysPastDue: number | null;
}

export interface CustomerDebtsDto {
  readonly customerId: string;
  readonly asOf: string;
  readonly items: readonly CustomerDebtDto[];
  readonly nextCursor: string | null;
}

/** One schedule-grain aging bucket of ONE plan. Not a customer figure and not summable into one. */
export interface InstallmentPlanAgingBucketDto {
  readonly bucketNo: number;
  readonly fromDays: number;
  readonly toDays: number | null;
  readonly remainingMinor: string;
  readonly installmentCount: number;
}

/**
 * The schedule-grain aging of ONE plan.
 *
 * It carries `agingOfRecord: 'customer_ar_aging'` as a literal, which is not
 * decoration either: a client that renders this beside a customer balance must
 * be able to see, from the payload, that this is NOT the aging of record and
 * which read is.
 */
export interface InstallmentPlanAgingDto {
  readonly planId: string;
  readonly asOf: string;
  readonly currency: string;
  readonly bucketDays: readonly number[];
  readonly buckets: readonly InstallmentPlanAgingBucketDto[];
  /** `Σ buckets[].remainingMinor`, which equals the plan's own unsettled part and nothing wider. */
  readonly scheduleRemainingMinor: string;
  /** The read that IS authoritative for a customer's aging. A literal, so the payload names it. */
  readonly agingOfRecord: 'customer_ar_aging';
}
