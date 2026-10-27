/**
 * P4-S7 — THE INSTALLMENT-AGING PROJECTION, AS A REFERENCE MODEL.
 *
 * IT ALLOCATES BOTH COLUMNS, AND THE BASE COLUMN COMES FROM A RULING.
 *
 * Round 2 allocated the transaction currency only and left the base figure
 * unallocated, on the coordinator's ruling 2, because the base column cannot
 * be split from a quotient: `invoice_outstanding`'s `paid_base_minor` is the
 * sum of the CARRYING RELEASED and never a conversion of the paid transaction
 * amount — read in the LIVE body at `0084:614` as
 * `pg_catalog.sum(d.rel) AS paid_base` over
 * `invoice_carrying_base_released_minor` — so `outstanding_base_minor /
 * outstanding_txn_minor` is NOT the invoice's `source_to_base_rate` under
 * realized FX. That measurement still stands.
 *
 * THE OWNER RULED (TL Ashraf, S7 §21). `source_to_base_rate` must NOT become
 * a second arithmetic authority and must NOT be injected into a signature to
 * reach this arithmetic. The invoice already carries an immutable
 * authoritative monetary PAIR, `total_txn_minor` and `total_base_minor`. The
 * base portion of a schedule boundary is THE CANONICAL CUMULATIVE
 * CARRYING-VALUE LAW over that pair, differenced between the schedule's
 * cumulative levels:
 *
 *     base_i = R(L_i) − R(L_{i−1})   where R(x) = HALF_EVEN(B·x, T)
 *            = apRelease(B, T, L_{i−1}, L_i − L_{i−1})               (R-61)
 *
 * The levels partition `[paid, T]`, so the portions telescope and
 *
 *     Σ base_i = R(T) − R(paid) = B − paid_base = outstanding_base_minor
 *
 * EXACTLY, because `R(T) = B` with no residue. §29's conservation law is
 * therefore a CONSEQUENCE of differencing one cumulative function and not a
 * coincidence anything polices — which is how the owner asked for it to be
 * proved, and proof 10 proves it that way, including against adversarial
 * rounding functions that show the property belongs to TELESCOPING and not to
 * HALF_EVEN.
 *
 * R-81 — THE ARITHMETIC IS REUSED, NEVER RE-IMPLEMENTED. This file IMPORTS
 * `apRelease` from `packages/inventory/src/supplier-settlement.ts:89` and the
 * SQL CALLS `public.supplier_ap_release` (`0067:683`). There is no third copy
 * and no `roundHalfEven` here: a third copy would be a third truth.
 *
 * §21 ASKED FOR A COUNTEREXAMPLE IF THE RAW RATE WERE REQUIRED. THERE IS
 * NONE. The only thing the allocation needs from the FX side is the RATIO
 * `B/T` of two stored authoritative integers, applied ONCE per cumulative
 * level inside ONE `HALF_EVEN`; no per-instalment conversion is performed, so
 * no per-instalment rate is referenced, and the endpoint identity `R(T) = B`
 * holds exactly, which no independent per-row conversion by a rate can
 * guarantee. A read creates no realized FX. See the design document §5.
 *
 * WHAT THIS FILE IS, AND DELIBERATELY IS NOT
 * ------------------------------------------
 * It is a REFERENCE MODEL under `test/`, imported by
 * `phase4-s7-installment-aging.test.ts` and by nothing else. It is NOT
 * exported from `packages/domain-core/src/index.ts`, is not in the package's
 * `main` or `types`, and no product code can reach it. That placement is the
 * point: `P4-AL-07` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:257-261`) states that
 * «a second copy of the arithmetic in TypeScript is a second truth with a
 * slower failure mode, because it disagrees only under the numbers nobody
 * tested». The authoritative implementation of this projection is the SQL
 * routine specified in `P4-S7-INSTALLMENT-AGING-DESIGN.md` §6. This file is
 * the thing the SQL is proved AGAINST, not a thing the API calls.
 *
 * THE DEFECT IT FIXES
 * -------------------
 * `customer_ar_aging(UUID, UUID, DATE, INTEGER[])`
 * (`infrastructure/database/migrations/0084_phase4_ar_fixed_cost_and_open_invoice_page.sql:699`)
 * buckets each open invoice's WHOLE outstanding by ONE date, `invoices.due_date`.
 * An invoice carries one due date; an installment plan carries `n` scheduled
 * dates (`P4-AL-13`, `docs/PHASE_4_ARCHITECTURE_LOCK.md:349-355`). So an
 * invoice with a plan reports its entire value in the bucket of that single
 * date while three quarters of it has not fallen due. The granularity is
 * wrong; the clock is not involved.
 *
 * NOT A CLOCK DEFECT, AND MEASURED SO. `customer_ar_aging` takes `p_as_of DATE`
 * from the caller and its body contains no `CURRENT_DATE`, `now()`,
 * `LOCALTIMESTAMP` or `transaction_timestamp()`. The previous round's
 * clock diagnosis was wrong and is not re-opened here. Separately: `IMMUTABLE`
 * is NOT a clock guard — PostgreSQL trusts the volatility label and does not
 * read the body — so nothing in this design leans on it. The protection is the
 * explicit `p_as_of` parameter plus the static guard widened in §8 of the
 * design document.
 *
 * NO SECOND AR LEDGER. The projection reads exactly four things: the schedule
 * dates, the schedule amounts, the supplied `p_as_of`, and the AUTHORITATIVE
 * invoice outstanding from `invoice_outstanding(UUID, UUID[])`.
 *
 * THE LIVE DEFINITION IS `0084:593`, NOT `0083:295`. `0083` created that
 * signature; `0084:488` DROPs it and `0084:593` recreates it with
 * `currency_code TEXT, due_date DATE` appended, and it is `0084:649`'s COMMENT
 * that carries the «appends one UNION ALL branch» licence. The first round of
 * this design cited `0083` throughout and therefore reasoned about a body the
 * database does not hold (challenger C-1). Every citation here now names the
 * body that is live after the last migration. It stores nothing, caches
 * nothing, and holds no plan-local balance. A payment or a reversal reaches it
 * only by changing that one authoritative figure.
 *
 * THE ROUNDING COUNT. The transaction-currency allocation performs ZERO
 * roundings: it is integer clamping of integer minor units, with no division,
 * no ratio and no proration. Pro-rata allocation (`O * a_i / T`) was
 * considered and REJECTED for exactly the reason the brief names: it rounds at
 * the instalment grain while the bucket total is asserted at the bucket grain,
 * so the two grains disagree by construction, and its rounded quotient would
 * be fed back as an authoritative input. See the design document §5 for the
 * base-currency column, which is the one place where a rounding is
 * structurally unavoidable and is therefore left OWED rather than guessed.
 */

import { apRelease } from '../../inventory/src/supplier-settlement';

/**
 * The cumulative carrying-value law, as a seam. The DEFAULT is the canonical
 * `apRelease` and nothing else is used in anger; proof 10 injects adversarial
 * alternatives to show the conservation law is a property of DIFFERENCING one
 * function and not of HALF_EVEN.
 */
export type ReleaseFn = (totalBase: bigint, totalTxn: bigint, before: bigint, applied: bigint) => bigint;
export const CANONICAL_RELEASE: ReleaseFn = apRelease;

// ── Civil dates ───────────────────────────────────────────────────────────
//
// `G-13` requires a civil DATE and never a timestamp, so a date here is
// 'YYYY-MM-DD' and a difference is a whole number of days. `epochDay` parses
// at UTC midnight so no host offset can move a boundary.

/** Whole days since 1970-01-01 for a 'YYYY-MM-DD' civil date. */
export function epochDay(civil: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civil)) throw new Error(`not a civil date: ${civil}`);
  const ms = Date.UTC(Number(civil.slice(0, 4)), Number(civil.slice(5, 7)) - 1, Number(civil.slice(8, 10)));
  if (!Number.isFinite(ms)) throw new Error(`not a civil date: ${civil}`);
  return Math.round(ms / 86_400_000);
}

/**
 * The bucket index of one date, in EXACTLY the shipped expression's shape
 * (`0084:708-710`): `1 + count(t in thresholds where (as_of - date) > t)`.
 *
 * Bucket 1 is therefore the not-yet-due bucket whenever every threshold is
 * >= 0, which `validateAgingBucketDays` already enforces.
 *
 * THE DATE IS NOT NULLABLE, AND THAT IS THE DR-13 REPAIR EXPRESSED IN THE TYPE
 * (DR-13, DR-21). This function used to take `string | null` and answer bucket
 * 1 for a NULL, mirroring the retired `due_date IS NOT NULL AND …` guard — so
 * a receivable with no stated term exceeded no threshold however old it got
 * and sat in the first band for ever. A nullable parameter here is what made
 * that expressible, so the parameter is TOTAL now: every caller resolves its
 * bucket date FIRST, through `termlessBucketDate` for the two arms that age at
 * the document's own date, and the compiler refuses a caller that does not.
 * A guard inside this function could only pick a band for a date nobody owns;
 * refusing the input at the type is the stronger statement.
 */
export type BucketFn = (asOf: string, date: string, thresholds: readonly number[]) => number;

export function bucketOf(asOf: string, date: string, thresholds: readonly number[]): number {
  const overdueDays = epochDay(asOf) - epochDay(date);
  return 1 + thresholds.filter((t) => overdueDays > t).length;
}

// ── Inputs ────────────────────────────────────────────────────────────────

/**
 * One row as `invoice_outstanding(business, invoice_id[])` returns it, joined
 * to the invoice's own currency and due date. `outstandingTxnMinor` is THE
 * AUTHORITATIVE FIGURE and the only money this projection may take from
 * outside the schedule.
 */
export interface OpenInvoiceRow {
  readonly invoiceId: string;
  readonly currencyCode: string;
  /** `invoices.due_date`; NULL is permitted by the shipped column. */
  readonly dueDate: string | null;
  /**
   * `invoices.issue_date`, read off the SAME authoritative row
   * (`0084:593-596` appends it to `invoice_outstanding`, so this is NOT a
   * second visit to `invoices`). It is `NOT NULL` on the shipped column and
   * `invoices_due_date_ck` enforces `due_date >= issue_date`, which is what
   * makes it a TOTAL substitute for a missing term and makes the substitution
   * one-directional: it can only ever make a receivable MORE overdue than the
   * absent date did, never less (DR-13, DR-21).
   */
  readonly issueDate: string;
  readonly outstandingTxnMinor: bigint;
  /**
   * `paid_txn_minor` from the SAME row of the SAME authoritative reader
   * (`0084:593`). It is NOT a new input and NOT a second truth: it is the
   * other half of the pair `invoice_outstanding` already returns, and
   * `paid + outstanding = total` (`R-SAL-02`, `P4-AL-26`).
   *
   * IT IS NOW LOAD-BEARING FOR THE ALLOCATION, and that is forced by the
   * ruling rather than chosen: the base levels must be anchored at the PAID
   * level, because `outstanding_base = R(Tot) − R(P)`. Anchoring there also
   * repairs the SUBSTANCE of the challenger's M-11 — see `projectInvoice`.
   */
  readonly paidTxnMinor: bigint;
  /** `paid_base_minor` from the same authoritative row: the carrying released. */
  readonly paidBaseMinor: bigint;
  /** `outstanding_base_minor` from the same authoritative row. */
  readonly outstandingBaseMinor: bigint;
}

/**
 * THE DATE AN AMOUNT WITH NO STATED TERM AGES FROM (DR-13, DR-21).
 *
 * `coalesce(due_date, issue_date)`, and it is TOTAL: `invoices.issue_date` is
 * `NOT NULL`, so this never returns a null. The direction of the substitution
 * is SIGNED and it is the safe one — `invoices_due_date_ck` enforces
 * `due_date >= issue_date`, so the substitute can only ever make a receivable
 * MORE overdue than the absent date did, never less.
 *
 * It governs the TWO arms that age at the document's own date: the whole
 * figure of an invoice with no active plan, and the RESIDUAL an installment
 * schedule does not declare. It does NOT govern a scheduled instalment, which
 * ages at its own `installments.due_date` and at nothing else: the two arms
 * are deliberately not levelled.
 */
export function termlessBucketDate(row: OpenInvoiceRow, policy: ProjectionPolicy = CORRECT_POLICY): string | null {
  if (row.dueDate !== null) return row.dueDate;
  // THE DEFECT KNOB, and it is the retired rule itself: `none` reproduces the
  // pre-DR-13 behaviour, where a termless receivable had no bucket date at all
  // and the band arithmetic therefore counted zero thresholds for it.
  return policy.termlessFallback === 'issue_date' ? row.issueDate : null;
}

/** One scheduled instalment: a date and an amount, and nothing derived. */
export interface ScheduledInstallment {
  /** `installments.seq_no`, >= 1 and unique within the plan. */
  readonly seqNo: number;
  readonly dueDate: string;
  readonly amountTxnMinor: bigint;
}

/**
 * One installment plan. It carries NO outstanding, NO settled and NO
 * collected figure: `installments.outstanding_minor` and
 * `installments.settled_minor` are columns `P4-AL-06` forbids by name, and
 * `tests/guards/phase4-derived-truth-guard.test.ts` already plants both as
 * defects, so the guard is red-capable for these relations before they exist.
 *
 * `planLocalCollectedMinor` is the SECOND LEDGER THIS DESIGN REFUSES. It is
 * present only so proof 5 can mutate the projection into reading it and show
 * the resulting parallel path fail. It is declared as an accessor so the test
 * can COUNT reads of it and assert the correct code path never touches it.
 */
export interface InstallmentPlan {
  readonly invoiceId: string;
  readonly status: 'active' | 'completed' | 'cancelled';
  readonly downPaymentMinor: bigint;
  /** The down payment's own schedule date — see design document §4.3. */
  readonly downPaymentDueDate: string;
  readonly installments: readonly ScheduledInstallment[];
  /** FORBIDDEN INPUT. Read by the proof-5 mutant only. */
  readonly planLocalCollectedMinor?: bigint;
}

// ── THE SETTLEMENT ORDER: A DECLARED POLICY, NOT A DERIVATION ────────────
//
// `payment_allocations` carries `invoice_id` and NO instalment reference, and
// under «no second AR ledger» there cannot be one. So NOTHING STORED RECORDS
// WHICH INSTALMENT A PAYMENT SETTLED, and the order in which the schedule is
// considered settled is a POLICY THIS PROJECTION DECLARES. It is written here
// as one named constant, with its reasoning, so that whoever changes it later
// changes THIS CONSTANT and re-runs the proofs, rather than discovering the
// convention by reading the arithmetic.
//
// RULED (coordinator, ruling 1) — OLDEST SCHEDULED DATE FIRST. A default the
// coordinator is SETTING, not a fact inherited from the author, and one the
// owner may overturn. Three reasons, recorded with it:
//
//   1. it is the ordinary AR convention a merchant expects;
//   2. `installments_seq_uq UNIQUE (business_id, plan_id, seq_no)` already
//      makes `(due_date, seq_no)` a total order, so it is the only order the
//      schema can reproduce DETERMINISTICALLY without new state;
//   3. it minimises reported delinquency, so if it is wrong it errs toward
//      understating what a customer owes rather than toward accusing them.
//
// AND THE PROPERTY IS ASSERTED, NOT MERELY STATED: `meta_6` re-runs every
// money law under BOTH conventions and requires all of them to hold, so the
// claim «the seven proofs hold under either convention» is a test and not a
// sentence. `newest_scheduled_first` is therefore NOT a defect value and is
// deliberately absent from `POLICY_KNOBS`; `meta_7` asserts that absence is
// intentional.

export const SETTLEMENT_ORDERS = ['oldest_scheduled_first', 'newest_scheduled_first'] as const;
export type SettlementOrder = (typeof SETTLEMENT_ORDERS)[number];

/** THE ONE CONSTANT TO CHANGE if the ruling is overturned. */
export const DECLARED_SETTLEMENT_ORDER: SettlementOrder = 'oldest_scheduled_first';

// ── The policy knobs, and the one correct configuration ───────────────────
//
// There is ONE implementation below. Every defect the seven proofs are
// written against is reached by flipping one of these knobs, so a mutant runs
// through the same code as the real algorithm rather than through a
// copy-pasted lookalike. `CORRECT_POLICY` is the algorithm of record.
//
// A knob that no proof ever flips is an exemption that is never evaluated, so
// the test file enumerates `POLICY_KNOBS` and fails if any knob has no proof
// exercising its defective value.

export interface ProjectionPolicy {
  /** Correct: true. False lets a schedule row absorb more than its amount. */
  readonly clampToRowAmount: boolean;
  /** Correct: 'schedule_date'. 'invoice_due_date' is the shipped defect. */
  readonly bucketBy: 'schedule_date' | 'invoice_due_date';
  /**
   * Correct: 'issue_date' — an amount with no stated term ages from the
   * document's own issue date (DR-13, DR-21). 'none' is THE DEFECT THIS
   * SPECIFICATION SHIPPED: no bucket date at all for a termless receivable,
   * which the band arithmetic then counts zero thresholds for, so the whole
   * figure sits in the first band however old it gets. Every money law in the
   * suite holds IDENTICALLY under it — the totals never move, only the band —
   * which is why nothing caught it for the life of the slice.
   */
  readonly termlessFallback: 'issue_date' | 'none';
  /** Correct: 'without_an_active_plan'. 'every_invoice' double-counts. */
  readonly planlessArm: 'without_an_active_plan' | 'every_invoice';
  /** Correct: true. False drops the residual and loses money. */
  readonly carryResidual: boolean;
  /** Correct: 'authoritative'. 'plan_local' is the parallel path. */
  readonly outstandingSource: 'authoritative' | 'plan_local';
  /**
   * Correct: 'cumulative_difference' — `R(L_i) − R(L_{i−1})`, which
   * telescopes. 'per_row_conversion' converts each row independently, which
   * is the second rounding at the second grain this design exists to refuse:
   * the per-row figures do not sum to the authoritative base.
   */
  readonly baseAllocation: 'cumulative_difference' | 'per_row_conversion';
  /**
   * Correct: 0. A non-zero value shifts every schedule date by that many days
   * INSIDE the allocation and reports the shifted date as the contribution's
   * own, so the output stays self-consistent while every instalment ages
   * wrongly. The challenger demonstrated this defect was reachable by no knob
   * (H-3) and that proof 2 stayed green under it, because proof 2 judged the
   * bucket against the date the projection said it used. Proof 2's subject is
   * now the PLAN's declared dates and this knob is what proves it.
   */
  readonly scheduleDateShiftDays: number;
  /**
   * The DECLARED POLICY, not a defect knob: both values are legitimate
   * conventions and `meta_6` proves every money law under each. It lives in
   * the policy record so a reviewer can re-run the whole suite under the
   * other convention by changing `DECLARED_SETTLEMENT_ORDER` alone.
   */
  readonly settlementOrder: SettlementOrder;
}

export const CORRECT_POLICY: ProjectionPolicy = Object.freeze({
  clampToRowAmount: true,
  bucketBy: 'schedule_date' as const,
  termlessFallback: 'issue_date' as const,
  planlessArm: 'without_an_active_plan' as const,
  carryResidual: true,
  outstandingSource: 'authoritative' as const,
  baseAllocation: 'cumulative_difference' as const,
  scheduleDateShiftDays: 0,
  settlementOrder: DECLARED_SETTLEMENT_ORDER,
});

/**
 * Every DEFECT knob, with its correct value and its defective value(s).
 *
 * `settlementOrder` is deliberately NOT here: it is a declared policy whose
 * other value is a legitimate convention, not a defect, and `meta_6` proves
 * the money laws under both. `meta_7` asserts that exclusion is deliberate
 * and that every knob listed here HAS a defective value — a knob added later
 * with an empty defective list is itself a failure, because an exemption
 * that cannot be evaluated is the failure shape this registry exists to
 * prevent.
 */
export const POLICY_KNOBS: readonly {
  readonly knob: keyof ProjectionPolicy;
  readonly correct: unknown;
  readonly defective: readonly unknown[];
}[] = Object.freeze([
  Object.freeze({ knob: 'clampToRowAmount' as const, correct: true, defective: Object.freeze([false]) }),
  Object.freeze({ knob: 'bucketBy' as const, correct: 'schedule_date', defective: Object.freeze(['invoice_due_date']) }),
  Object.freeze({ knob: 'termlessFallback' as const, correct: 'issue_date', defective: Object.freeze(['none']) }),
  Object.freeze({ knob: 'planlessArm' as const, correct: 'without_an_active_plan', defective: Object.freeze(['every_invoice']) }),
  Object.freeze({ knob: 'carryResidual' as const, correct: true, defective: Object.freeze([false]) }),
  Object.freeze({ knob: 'outstandingSource' as const, correct: 'authoritative', defective: Object.freeze(['plan_local']) }),
  Object.freeze({ knob: 'scheduleDateShiftDays' as const, correct: 0, defective: Object.freeze([-200]) }),
  Object.freeze({
    knob: 'baseAllocation' as const,
    correct: 'cumulative_difference',
    defective: Object.freeze(['per_row_conversion']),
  }),
]);

// ── Output ────────────────────────────────────────────────────────────────

/**
 * One contribution of money to one bucket, BEFORE aggregation. The proofs
 * work on these rather than on the aggregated buckets, because an identity
 * asserted only after a `GROUP BY` cannot say WHICH row broke it, and
 * because `origin` and `scheduleDate` are what proofs 2, 3 and 4 are about.
 */
export interface AgingContribution {
  readonly invoiceId: string;
  readonly currencyCode: string;
  readonly bucketNo: number;
  readonly txnMinor: bigint;
  /** The carrying portion, by the canonical cumulative law. */
  readonly baseMinor: bigint;
  /** Where this money came from, for the proofs. Not part of the SQL output. */
  readonly origin: 'down_payment' | 'installment' | 'residual' | 'whole_invoice';
  /** The schedule date this money was bucketed by; null for a NULL invoice due date. */
  readonly scheduleDate: string | null;
  /** `seq_no` for an instalment; 0 for the down payment; null otherwise. */
  readonly seqNo: number | null;
}

// ── The projection ────────────────────────────────────────────────────────

/** A civil date moved by whole days. Used only by the `scheduleDateShiftDays` defect knob. */
function shiftDate(civil: string, days: number): string {
  if (days === 0) return civil;
  return new Date((epochDay(civil) + days) * 86_400_000).toISOString().slice(0, 10);
}

function clampLow(v: bigint): bigint {
  return v < 0n ? 0n : v;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * THE ALLOCATION RULE, in one sentence: an instalment schedule is settled
 * OLDEST SCHEDULED DATE FIRST out of the money ALREADY COLLECTED, so the
 * authoritative paid figure consumes a PREFIX of the schedule and each row's
 * share is the step the cumulative settlement level takes across it.
 *
 * Write the schedule in ascending `(due_date, seq_no)` order as rows `1..m`
 * with amounts `a_1..a_m`, and let `c_i = Σ_{j <= i} a_j` be the inclusive
 * PREFIX sum, `c_0 = 0`. Let `P = paid_txn_minor`, `O =
 * outstanding_txn_minor`, `T = P + O` — all three authoritative, read from
 * `invoice_outstanding` and never recomputed. The SETTLEMENT LEVEL is
 *
 *     L(x) = min(max(x, P), T)        so L(c_0) = P and L(c_m) <= T
 *
 * and the share is `alloc_i = L(c_i) − L(c_{i−1})`.
 *
 * WHY ANCHORED AT `P` AND NOT AT `O`. Round 2 anchored on the outstanding
 * against the schedule's SUFFIX — `alloc_i = clamp(O − s_{i+1}, 0, a_i)` —
 * which is the same arithmetic wherever `Σ a_i = T`, and the two agree
 * exactly on every schedule that obeys `R-SAL-06` (a law asserts this). They
 * disagree where the sum law is broken, and the challenger's M-11 is where:
 * an OVER-scheduled plan put an unpaid balance in the LATEST row, reporting a
 * 265-day-overdue receivable as not yet due, with no bound on the
 * understatement. Anchoring at the paid figure makes that answer
 * INEXPRESSIBLE rather than merely signalled — the earliest rows are the ones
 * nothing has paid for — and the 265-day case is a permanent deterministic
 * golden, never replaced by random coverage.
 *
 * Both anchors are instances of one identity,
 *
 *     clamp(V − x_i, 0, x_{i+1} − x_i) = min(V, x_{i+1}) − min(V, x_i)
 *
 * over any monotone cut sequence, which is why every money law below is
 * convention-independent and `meta_6` can ASSERT that rather than state it:
 * the other settlement convention is this ordering reversed and nothing else.
 *
 * Determinism. `(due_date, seq_no)` is a total order because
 * `installments_seq_uq UNIQUE (business_id, plan_id, seq_no)` makes `seq_no`
 * unique within the plan, and the down payment takes `seq_no = 0`. `L` is a
 * closed form of one cut point, so a row's share depends on nothing but the
 * two cut points beside it — no accumulator whose order of evaluation could
 * be got wrong.
 *
 * Exactness, transaction side. The levels telescope:
 *
 *     Σ_i alloc_i = L(c_m) − L(c_0) = L(c_m) − P
 *
 * exactly, in integers, for every input. ZERO roundings are performed here.
 *
 * Exactness, base side. EXACTLY ONE rounding, and it is not this file's: the
 * base share is `apRelease(B, T, L(c_{i−1}), alloc_i)` = `R(L(c_i)) −
 * R(L(c_{i−1}))`, consumed from the canonical law. Rounding is not additive,
 * so the count matters: one rounding at one grain, never a second at a second
 * grain to be reconciled with the first. Proof 10's mutant converts each row
 * on its own and drifts by 4 minor units on the design fixture — small, which
 * is exactly why a law that did not assert EXACT equality would never have
 * found it.
 *
 * Totality. The leftover is given its OWN CLOSED FORM, anchored on the
 * DECLARED schedule sum `S = Σ a_i`:
 *
 *     residual = T − L(S)        and base = apRelease(B, T, L(S), residual)
 *
 * and NOT `O − Σ alloc_i`, and NOT `T − L(c_m)`. ROUND 3 CAUGHT ITSELF HERE:
 * the first draft anchored the residual on the REALISED last level, which made
 * `Σ alloc + residual = (L − P) + (T − L) = T − P = O` hold IDENTICALLY
 * whatever the allocation did. Proof 1 was a tautology and the
 * `clampToRowAmount` mutation was measurably INERT — `meta_2` is what caught
 * it. Anchored on the DECLARED sum, `L(S) = L(c_m)` only when the schedule is
 * complete, so proof 1 is a real claim about the telescoping identity again
 * and the mutant breaks it.
 *
 * `residual` carries the money the schedule does not account for — a broken
 * `Σ instalments + down = invoice total` (`P4-AL-13`, `R-SAL-06`), or a
 * negative outstanding — and is bucketed by `coalesce(due_date, issue_date)`,
 * the only date with any authority over an amount the schedule never declared
 * (DR-13, DR-21). So the
 * buckets total the authoritative outstanding EVEN WHEN the sum law is
 * violated, instead of silently losing the difference.
 */
export function projectInvoice(
  row: OpenInvoiceRow,
  plan: InstallmentPlan | undefined,
  asOf: string,
  thresholds: readonly number[],
  policy: ProjectionPolicy = CORRECT_POLICY,
  release: ReleaseFn = CANONICAL_RELEASE,
  // THE BANDING IS INJECTABLE, and that is a repair, not a convenience. Proof
  // 2's round-3 form asserted `bucketNo === bucketOf(...)` while the
  // projection produced `bucketNo` BY CALLING `bucketOf`, so over the banding
  // the law stated `f(x) === f(x)` and its refusal was unreachable — the
  // estate's first named failure shape, found by the proof engineer in the
  // one law that had already been repaired once for being true by
  // construction. The law now compares against an INDEPENDENT oracle derived
  // from `agingBucketLabels` by interval containment, and the five planted
  // mutants of the banding are injected HERE so they run through the real
  // projection rather than through a lookalike.
  bucket: BucketFn = bucketOf,
): readonly AgingContribution[] {
  const planApplies = plan !== undefined && plan.status === 'active';
  const planlessReached = policy.planlessArm === 'every_invoice' || !planApplies;

  const O = row.outstandingTxnMinor;
  const out: AgingContribution[] = [];

  // THE WHOLE FIGURE AGES AT THE DOCUMENT'S OWN DATE, and that date is
  // `coalesce(due_date, issue_date)` (DR-13, DR-21). The `null` arm below is
  // reachable ONLY through the `termlessFallback: 'none'` knob and it is the
  // retired behaviour itself: no bucket date, zero thresholds exceeded, the
  // first band for ever.
  const documentDate = termlessBucketDate(row, policy);
  const bandOfDocument = documentDate === null ? 1 : bucket(asOf, documentDate, thresholds);

  if (planlessReached) {
    if (O !== 0n) {
      out.push({
        invoiceId: row.invoiceId,
        currencyCode: row.currencyCode,
        bucketNo: bandOfDocument,
        txnMinor: O,
        baseMinor: row.outstandingBaseMinor,
        origin: 'whole_invoice',
        scheduleDate: documentDate,
        seqNo: null,
      });
    }
    if (!planApplies) return out;
  }

  const p = plan as InstallmentPlan;

  // THE AUTHORITATIVE PAIR, or the parallel path proof 5 refuses. `P` is the
  // settled level and `totalTxn`/`totalBase` the invoice's immutable pair —
  // all three off the SAME row of the SAME reader (`0084:593`). The
  // 'plan_local' mutant replaces them with a plan-local collected total that
  // no payment and no reversal updates, because nothing writes it.
  const scheduleSum = p.downPaymentMinor + p.installments.reduce((a, i) => a + i.amountTxnMinor, 0n);
  const authoritative = policy.outstandingSource === 'authoritative';
  const P = authoritative ? row.paidTxnMinor : (p.planLocalCollectedMinor ?? 0n);
  const totalTxn = authoritative ? row.paidTxnMinor + O : scheduleSum;
  const totalBase = authoritative ? row.paidBaseMinor + row.outstandingBaseMinor : scheduleSum;

  const rows: readonly { seqNo: number; dueDate: string; amount: bigint; origin: 'down_payment' | 'installment' }[] = [
    {
      seqNo: 0,
      dueDate: shiftDate(p.downPaymentDueDate, policy.scheduleDateShiftDays),
      amount: p.downPaymentMinor,
      origin: 'down_payment' as const,
    },
    ...p.installments.map((i) => ({
      seqNo: i.seqNo,
      dueDate: shiftDate(i.dueDate, policy.scheduleDateShiftDays),
      amount: i.amountTxnMinor,
      origin: 'installment' as const,
    })),
  ].sort((x, y) => epochDay(x.dueDate) - epochDay(y.dueDate) || x.seqNo - y.seqNo);

  // A degenerate invoice (nothing outstanding, or a negative outstanding that
  // no CHECK permits) carries wholly as residual. Totality before cleverness.
  if (O <= 0n || totalTxn <= 0n || totalBase <= 0n) {
    if (O !== 0n) {
      out.push({
        invoiceId: row.invoiceId,
        currencyCode: row.currencyCode,
        bucketNo: bandOfDocument,
        txnMinor: O,
        baseMinor: row.outstandingBaseMinor,
        origin: 'residual',
        scheduleDate: documentDate,
        seqNo: null,
      });
    }
    return out;
  }

  // The order in which the schedule is CONSIDERED SETTLED. Oldest-scheduled-
  // first means the paid amount covers the earliest rows, so the cumulative
  // levels run in ascending schedule order (ruling 1).
  const levelOrder = policy.settlementOrder === 'oldest_scheduled_first' ? rows : [...rows].reverse();

  // THE CUMULATIVE LEVELS, CLAMPED INTO THE SETTLED-TO-TOTAL WINDOW.
  //
  //     c_i = Σ_{j ≤ i} a_j            (inclusive, in settlement order)
  //     L_i = min(max(c_i, P), Tot)
  //     alloc_i  = L_i − L_{i−1}
  //     base_i   = R(L_i) − R(L_{i−1}) = release(B, Tot, L_{i−1}, alloc_i)
  //
  // ANCHORING AT `P` IS FORCED BY THE RULING, because the conservation law is
  // `Σ base = R(Tot) − R(P) = total_base − paid_base = outstanding_base`, and
  // that only telescopes if the first level IS `P`.
  //
  // IT ALSO REPAIRS THE SUBSTANCE OF THE CHALLENGER'S M-11. The previous form
  // anchored on the OUTSTANDING against the schedule's suffix, so an
  // OVER-SCHEDULED plan pushed the whole balance onto the latest row and
  // reported a 265-day-overdue receivable as entirely not yet due. Anchored at
  // what was actually PAID, the same input allocates to the earliest UNPAID
  // row, which is the overdue one — so the understatement is no longer
  // expressible, rather than merely signalled. The two forms agree exactly
  // wherever `Σ instalments + down = invoice total` holds.
  let prevLevel = minBig(clampLow(P), totalTxn);
  const firstLevel = prevLevel;
  const alloc = new Map<number, { txn: bigint; base: bigint }>();
  let cumulative = 0n;
  for (const r of levelOrder) {
    cumulative += r.amount;
    const raw = clampLow(cumulative < P ? P : cumulative);
    // The upper clamp at the invoice total. Without it a schedule row absorbs
    // past the end of the invoice and the buckets overshoot the authoritative
    // outstanding, which is the defect proof 1 is about.
    const level = policy.clampToRowAmount ? minBig(raw, totalTxn) : raw;
    const txn = level - prevLevel;
    if (txn > 0n) {
      const base =
        policy.baseAllocation === 'cumulative_difference'
          ? release(totalBase, totalTxn, prevLevel, txn)
          : // The refused form: each row converted on its own, at the row
            // grain, so the per-row figures do not sum to the authoritative
            // base. Two grains, two roundings, disagreement by construction.
            release(totalBase, totalTxn, 0n, txn);
      alloc.set(r.seqNo, { txn, base });
    }
    prevLevel = level;
  }
  const lastLevel = prevLevel;

  for (const r of rows) {
    const a = alloc.get(r.seqNo);
    if (a === undefined) continue;
    out.push({
      invoiceId: row.invoiceId,
      currencyCode: row.currencyCode,
      // A SCHEDULED instalment ages at ITS OWN date and at nothing else
      // (DR-21): the two arms are deliberately not levelled, so no fallback
      // reaches here. `invoice_due_date` is the defect knob.
      bucketNo: policy.bucketBy === 'schedule_date' ? bucket(asOf, r.dueDate, thresholds) : bandOfDocument,
      txnMinor: a.txn,
      baseMinor: a.base,
      origin: r.origin,
      scheduleDate: policy.bucketBy === 'schedule_date' ? r.dueDate : documentDate,
      seqNo: r.seqNo,
    });
  }

  // THE RESIDUAL, BY ITS OWN CLOSED FORM OVER THE *DECLARED* SCHEDULE SUM —
  // not over the level the loop happened to reach.
  //
  //     residual = Tot − min(max(scheduleSum, P), Tot)
  //
  // This matters and it was caught by `meta_2`. Anchoring the residual on
  // `lastLevel` made `Σ alloc + residual = (lastLevel − P) + (Tot − lastLevel)
  // = Tot − P = O` hold IDENTICALLY, whatever the allocation did — a
  // tautology, and proof 1 would have proved nothing while reading as though
  // it did. The `clampToRowAmount` mutation was measurably INERT under it,
  // because the residual silently absorbed the overshoot.
  //
  // Anchored on the DECLARED schedule sum, proof 1 is a theorem again: it
  // holds only because `lastLevel` really does equal
  // `min(max(scheduleSum, P), Tot)`, which is exactly the clamp's
  // correctness. Remove the clamp and the buckets overshoot by the whole
  // over-scheduled excess.
  if (policy.carryResidual) {
    const declaredEnd = minBig(maxBig(scheduleSum, P), totalTxn);
    const residualTxn = totalTxn - declaredEnd;
    if (residualTxn !== 0n) {
      out.push({
        invoiceId: row.invoiceId,
        currencyCode: row.currencyCode,
        // DR-21: the unscheduled remainder ages at the document's own date,
        // and at the ISSUE date when the document states no term. It is the
        // same decision as the no-plan arm, applied to the one other arm that
        // ages at a date the schedule never gave it.
        bucketNo: bandOfDocument,
        txnMinor: residualTxn,
        baseMinor: release(totalBase, totalTxn, declaredEnd, residualTxn),
        origin: 'residual',
        scheduleDate: documentDate,
        seqNo: null,
      });
    }
    void firstLevel;
    void lastLevel;
  }

  return out;
}

// ── PR-5, RESOLVED BY DELETION: THE VERIFIER IS THE WHOLE BOUND ─────────
//
// Round 2 added `scheduleCoherenceFindings`, a pure function that detected a
// broken `Σ instalments + down = invoice total` in both directions. The
// coordinator's objection was exact and is this estate's recorded defect
// class: A NAME EXISTED AND NO EVIDENCE READ IT. Nothing called it, and it was
// offered as the bound on ruling 1 — so there were two homes for the bound and
// the unwired one was the one being believed.
//
// It is DELETED, and the DEFERRED SCHEDULE VERIFIER is the whole bound. Two
// things make that sound rather than merely tidy:
//
//   * a DEFERRABLE INITIALLY DEFERRED constraint trigger fires at COMMIT on
//     every INSERT, UPDATE and DELETE whoever writes, so a direct write does
//     not bypass it — only disabling triggers or `session_replication_role`
//     does, and neither is reachable by `daftar_app`; and
//   * the allocation no longer DEPENDS on the sum law for a sane answer.
//     Anchoring the cumulative levels at the paid level means an
//     over-scheduled plan allocates to the earliest unpaid row, so the
//     unbounded understatement M-11 found is no longer expressible. The
//     verifier bounds the DATA; it is no longer propping up the ARITHMETIC.
//
// Per the owner's §26 the sum law is owed AT DB LEVEL in all three directions
// — below total refused, equal accepted, above total refused — which is a
// cluster run and is owed to the box, not asserted here in TypeScript.

/**
 * The amount of the DECLARED schedule that had fallen due at `asOf`, read from
 * the plan and not from the projection. The converse law of proof 2 is stated
 * against this (`test`: proof 2's plan-subject arm), so a projection cannot
 * satisfy the law by relabelling its own output.
 */
export function scheduledDueBy(plan: InstallmentPlan, asOf: string): bigint {
  const rows = [
    { dueDate: plan.downPaymentDueDate, amount: plan.downPaymentMinor },
    ...plan.installments.map((i) => ({ dueDate: i.dueDate, amount: i.amountTxnMinor })),
  ];
  return rows.filter((r) => epochDay(r.dueDate) <= epochDay(asOf)).reduce((a, r) => a + r.amount, 0n);
}

/** One aggregated bucket, the shape `customer_ar_aging` returns. */
export interface AgingBucket {
  readonly bucketNo: number;
  readonly currencyCode: string;
  readonly txnMinor: bigint;
  /**
   * The base-currency carrying portion of the bucket (R-61 / Ashraf's §21
   * ruling). It is the sum of differences of ONE cumulative function, so the
   * buckets total `outstanding_base_minor` exactly by telescoping rather than
   * by a residue someone distributes. Column four of the shipped return
   * shape, which §25 requires be kept.
   */
  readonly baseMinor: bigint;
  readonly invoiceCount: number;
}

/**
 * The whole customer projection: every open invoice, its plan if it has an
 * active one, flattened to contributions and then grouped.
 *
 * `invoiceCount` counts DISTINCT invoices in the bucket, not contributions.
 * The shipped routine's `count(*)` counted one row per invoice because one
 * invoice made one row; now an invoice makes several, so `count(*)` would
 * report a count of instalments under a column named `invoice_count`. That
 * correction is part of this design (design document §6.4).
 */
export function projectCustomerAging(
  rows: readonly OpenInvoiceRow[],
  plans: readonly InstallmentPlan[],
  asOf: string,
  thresholds: readonly number[],
  policy: ProjectionPolicy = CORRECT_POLICY,
  release: ReleaseFn = CANONICAL_RELEASE,
  bucket: BucketFn = bucketOf,
): readonly AgingBucket[] {
  return aggregate(contributionsFor(rows, plans, asOf, thresholds, policy, release, bucket));
}

/** Every contribution, unaggregated — what the proofs assert over. */
export function contributionsFor(
  rows: readonly OpenInvoiceRow[],
  plans: readonly InstallmentPlan[],
  asOf: string,
  thresholds: readonly number[],
  policy: ProjectionPolicy = CORRECT_POLICY,
  release: ReleaseFn = CANONICAL_RELEASE,
  bucket: BucketFn = bucketOf,
): readonly AgingContribution[] {
  const byInvoice = new Map<string, InstallmentPlan>();
  for (const p of plans) {
    if (p.status !== 'active') continue;
    if (byInvoice.has(p.invoiceId)) {
      // Two active plans on one invoice would double-count the invoice. The
      // DDL specification forbids it with a partial unique index (design
      // document §4.2); the model refuses it rather than choosing silently.
      throw new Error(`installment_plan.more_than_one_active: ${p.invoiceId}`);
    }
    byInvoice.set(p.invoiceId, p);
  }
  return rows.flatMap((r) => projectInvoice(r, byInvoice.get(r.invoiceId), asOf, thresholds, policy, release, bucket));
}

/** Group contributions into buckets, counting distinct invoices. */
export function aggregate(contributions: readonly AgingContribution[]): readonly AgingBucket[] {
  const acc = new Map<string, { bucketNo: number; currencyCode: string; txnMinor: bigint; baseMinor: bigint; invoices: Set<string> }>();
  for (const c of contributions) {
    const key = `${c.bucketNo}\u0000${c.currencyCode}`;
    const cur = acc.get(key) ?? { bucketNo: c.bucketNo, currencyCode: c.currencyCode, txnMinor: 0n, baseMinor: 0n, invoices: new Set<string>() };
    cur.txnMinor += c.txnMinor;
    cur.baseMinor += c.baseMinor;
    cur.invoices.add(c.invoiceId);
    acc.set(key, cur);
  }
  return [...acc.values()]
    .map((v) => ({ bucketNo: v.bucketNo, currencyCode: v.currencyCode, txnMinor: v.txnMinor, baseMinor: v.baseMinor, invoiceCount: v.invoices.size }))
    .sort((a, b) => a.bucketNo - b.bucketNo || a.currencyCode.localeCompare(b.currencyCode));
}
