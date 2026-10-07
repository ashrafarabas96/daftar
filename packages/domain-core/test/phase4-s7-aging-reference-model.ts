/**
 * P4-S7 — THE INSTALLMENT-AGING PROJECTION, AS A REFERENCE MODEL.
 *
 * THIS PROJECTION IS TRANSACTION-CURRENCY ONLY. It allocates
 * `outstanding_txn_minor` across the aging buckets and allocates NO base
 * figure. That is a RULING (coordinator, ruling 2) and not an oversight: the
 * base column cannot be split exactly from the inputs this design is
 * permitted, because `invoice_outstanding`'s `paid_base_minor` is the sum of
 * the carrying released and «never a conversion of the paid transaction
 * amount» (`0083:277-281`), so `outstanding_base / outstanding_txn` is not
 * the invoice's `source_to_base_rate` under realized FX. The two ways out —
 * reading that rate, or feeding the quotient back — are a widening of the
 * permitted input set and a forbidden rounded-quotient-as-input
 * respectively. The widening is with the owner; until he rules, no base
 * allocation is written. See the design document §5.
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
 * invoice outstanding from `invoice_outstanding(UUID, UUID[])`
 * (`infrastructure/database/migrations/0083_phase4_ar_outstanding_set_based.sql:295`
 * — «THE ONE DEFINITION of the settlement sum»). It stores nothing, caches
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
 * >= 0, which `validateAgingBucketDays` already enforces (`invoice.ts:158`
 * requires each day in 1..MAX). A NULL date lands in bucket 1, which is the
 * shipped behaviour (`due_date IS NOT NULL AND ...`).
 */
export function bucketOf(asOf: string, date: string | null, thresholds: readonly number[]): number {
  if (date === null) return 1;
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
  readonly outstandingTxnMinor: bigint;
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
  /** Correct: 'without_an_active_plan'. 'every_invoice' double-counts. */
  readonly planlessArm: 'without_an_active_plan' | 'every_invoice';
  /** Correct: true. False drops the residual and loses money. */
  readonly carryResidual: boolean;
  /** Correct: 'authoritative'. 'plan_local' is the parallel path. */
  readonly outstandingSource: 'authoritative' | 'plan_local';
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
  planlessArm: 'without_an_active_plan' as const,
  carryResidual: true,
  outstandingSource: 'authoritative' as const,
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
  Object.freeze({ knob: 'planlessArm' as const, correct: 'without_an_active_plan', defective: Object.freeze(['every_invoice']) }),
  Object.freeze({ knob: 'carryResidual' as const, correct: true, defective: Object.freeze([false]) }),
  Object.freeze({ knob: 'outstandingSource' as const, correct: 'authoritative', defective: Object.freeze(['plan_local']) }),
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
  /** Where this money came from, for the proofs. Not part of the SQL output. */
  readonly origin: 'down_payment' | 'installment' | 'residual' | 'whole_invoice';
  /** The schedule date this money was bucketed by; null for a NULL invoice due date. */
  readonly scheduleDate: string | null;
  /** `seq_no` for an instalment; 0 for the down payment; null otherwise. */
  readonly seqNo: number | null;
}

// ── The projection ────────────────────────────────────────────────────────

function clampLow(v: bigint): bigint {
  return v < 0n ? 0n : v;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * THE ALLOCATION RULE, in one sentence: an instalment schedule is settled
 * OLDEST SCHEDULED DATE FIRST, so the invoice's authoritative outstanding
 * occupies a SUFFIX of the schedule, and each schedule row's share is a
 * closed-form clamp of that outstanding against the amounts scheduled after
 * it.
 *
 * Write the schedule in ascending `(due_date, seq_no)` order as rows
 * `1..m` with amounts `a_1..a_m`, and let `s_i = Σ_{j >= i} a_j` be the
 * inclusive suffix sum, so `s_{m+1} = 0`. For authoritative outstanding `O`,
 * under the declared OLDEST-SCHEDULED-FIRST policy:
 *
 *     alloc_i = clamp(O − s_{i+1}, 0, a_i)
 *
 * and under the other convention, with `p_i = Σ_{j < i} a_j` the exclusive
 * prefix sum, `alloc_i = clamp(O − p_i, 0, a_i)`. BOTH telescope to
 * `min(O, T)` by the same algebra — `clamp(O − x_i, 0, x_{i+1} − x_i) =
 * min(O, x_{i+1}) − min(O, x_i)` over any monotone cut sequence — which is
 * why every money law below is convention-independent and `meta_6` can
 * assert it.
 *
 * Determinism. `(due_date, seq_no)` is a total order because
 * `installments_seq_uq UNIQUE (business_id, plan_id, seq_no)` makes `seq_no`
 * unique within the plan, and the down payment takes `seq_no = 0`. The
 * formula is CLOSED — no accumulator, no loop-carried state — so there is no
 * order of evaluation to get wrong and no partial-sum to depend on.
 *
 * Exactness. `clamp(O − s_{i+1}, 0, s_i − s_{i+1}) = min(O, s_i) − min(O, s_{i+1})`,
 * so the allocation TELESCOPES:
 *
 *     Σ_i alloc_i = min(O, s_1) − min(O, s_{m+1}) = min(O, T)   where T = s_1
 *
 * exactly, in integers, for every `O >= 0`. This is why proof 1 is a theorem
 * and not a hope, and why there is no residue to distribute: a pro-rata rule
 * would need one and would have to round it.
 *
 * Totality. The leftover is given its OWN CLOSED FORM
 *
 *     residual = O − min(max(O, 0), T)
 *
 * and NOT `O − Σ alloc_i`. Defining it as the difference against the realised
 * sum would make proof 1 compare an expression with itself and prove nothing;
 * defining it against `min(max(O,0), T)` leaves proof 1 a real claim about
 * the telescoping identity, which the `clampToRowAmount` mutant breaks.
 * `residual` carries the money the schedule does not account for — a broken
 * `Σ instalments + down = invoice total` (`P4-AL-13`, `R-SAL-06`), or a
 * negative outstanding — and is bucketed by `invoices.due_date`, which is the
 * only date with any authority over it. So the buckets total the authoritative
 * outstanding EVEN WHEN the sum law is violated, instead of silently losing
 * the difference.
 */
export function projectInvoice(
  row: OpenInvoiceRow,
  plan: InstallmentPlan | undefined,
  asOf: string,
  thresholds: readonly number[],
  policy: ProjectionPolicy = CORRECT_POLICY,
): readonly AgingContribution[] {
  const planApplies =
    plan !== undefined && plan.status === 'active' && plan.installments.length > 0;

  // The plan-less arm. Under the correct policy an invoice reaches it ONLY
  // when no active plan covers it, so the two arms PARTITION the open
  // invoices and no invoice is read by both. The 'every_invoice' mutant makes
  // the arms overlap, which is the double count proof 3 is about.
  const planlessReached = policy.planlessArm === 'every_invoice' || !planApplies;

  const out: AgingContribution[] = [];

  if (planlessReached) {
    if (row.outstandingTxnMinor !== 0n) {
      out.push({
        invoiceId: row.invoiceId,
        currencyCode: row.currencyCode,
        bucketNo: bucketOf(asOf, row.dueDate, thresholds),
        txnMinor: row.outstandingTxnMinor,
        origin: 'whole_invoice',
        scheduleDate: row.dueDate,
        seqNo: null,
      });
    }
    if (!planApplies) return out;
  }

  // From here the plan applies. `plan` is defined because `planApplies`.
  const p = plan as InstallmentPlan;

  // The ordered schedule: the down payment first at seq 0, then the
  // instalments, in ascending (due_date, seq_no).
  const rows: readonly { seqNo: number; dueDate: string; amount: bigint; origin: 'down_payment' | 'installment' }[] =
    [
      { seqNo: 0, dueDate: p.downPaymentDueDate, amount: p.downPaymentMinor, origin: 'down_payment' as const },
      ...p.installments.map((i) => ({
        seqNo: i.seqNo,
        dueDate: i.dueDate,
        amount: i.amountTxnMinor,
        origin: 'installment' as const,
      })),
    ].sort((x, y) => epochDay(x.dueDate) - epochDay(y.dueDate) || x.seqNo - y.seqNo);

  // THE AUTHORITATIVE OUTSTANDING, or the parallel path proof 5 refuses.
  const outstanding =
    policy.outstandingSource === 'authoritative'
      ? row.outstandingTxnMinor
      : // The second ledger: a plan-local collected total, which no payment
        // and no reversal updates, because nothing writes it.
        rows.reduce((a, r) => a + r.amount, 0n) - (p.planLocalCollectedMinor ?? 0n);

  // Inclusive suffix sums `s_i`, computed once. `suffixAfter[i] = s_{i+1}`.
  const suffixAfter: bigint[] = new Array<bigint>(rows.length + 1).fill(0n);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    suffixAfter[i] = (suffixAfter[i + 1] as bigint) + (rows[i] as { amount: bigint }).amount;
  }
  const scheduleTotal = suffixAfter[0] as bigint;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] as { seqNo: number; dueDate: string; amount: bigint; origin: 'down_payment' | 'installment' };
    // The amount that must be filled BEFORE this row takes any: the rows
    // scheduled strictly LATER under the declared oldest-first policy, or the
    // rows scheduled strictly EARLIER under the other convention.
    const filledFirst =
      policy.settlementOrder === 'oldest_scheduled_first'
        ? (suffixAfter[i + 1] as bigint)
        : scheduleTotal - (suffixAfter[i] as bigint);
    const headroom = clampLow(outstanding - filledFirst);
    const alloc = policy.clampToRowAmount ? minBig(headroom, r.amount) : headroom;
    if (alloc === 0n) continue;
    out.push({
      invoiceId: row.invoiceId,
      currencyCode: row.currencyCode,
      bucketNo: bucketOf(asOf, policy.bucketBy === 'schedule_date' ? r.dueDate : row.dueDate, thresholds),
      txnMinor: alloc,
      origin: r.origin,
      scheduleDate: policy.bucketBy === 'schedule_date' ? r.dueDate : row.dueDate,
      seqNo: r.seqNo,
    });
  }

  // The residual, by its own closed form — never `outstanding − Σ alloc`.
  if (policy.carryResidual) {
    const residual = outstanding - minBig(clampLow(outstanding), scheduleTotal);
    if (residual !== 0n) {
      out.push({
        invoiceId: row.invoiceId,
        currencyCode: row.currencyCode,
        bucketNo: bucketOf(asOf, row.dueDate, thresholds),
        txnMinor: residual,
        origin: 'residual',
        scheduleDate: row.dueDate,
        seqNo: null,
      });
    }
  }

  return out;
}

/** One aggregated bucket, the shape `customer_ar_aging` returns. */
export interface AgingBucket {
  readonly bucketNo: number;
  readonly currencyCode: string;
  readonly txnMinor: bigint;
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
): readonly AgingBucket[] {
  return aggregate(contributionsFor(rows, plans, asOf, thresholds, policy));
}

/** Every contribution, unaggregated — what the proofs assert over. */
export function contributionsFor(
  rows: readonly OpenInvoiceRow[],
  plans: readonly InstallmentPlan[],
  asOf: string,
  thresholds: readonly number[],
  policy: ProjectionPolicy = CORRECT_POLICY,
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
  return rows.flatMap((r) => projectInvoice(r, byInvoice.get(r.invoiceId), asOf, thresholds, policy));
}

/** Group contributions into buckets, counting distinct invoices. */
export function aggregate(contributions: readonly AgingContribution[]): readonly AgingBucket[] {
  const acc = new Map<string, { bucketNo: number; currencyCode: string; txnMinor: bigint; invoices: Set<string> }>();
  for (const c of contributions) {
    const key = `${c.bucketNo}\u0000${c.currencyCode}`;
    const cur = acc.get(key) ?? { bucketNo: c.bucketNo, currencyCode: c.currencyCode, txnMinor: 0n, invoices: new Set<string>() };
    cur.txnMinor += c.txnMinor;
    cur.invoices.add(c.invoiceId);
    acc.set(key, cur);
  }
  return [...acc.values()]
    .map((v) => ({ bucketNo: v.bucketNo, currencyCode: v.currencyCode, txnMinor: v.txnMinor, invoiceCount: v.invoices.size }))
    .sort((a, b) => a.bucketNo - b.bucketNo || a.currencyCode.localeCompare(b.currencyCode));
}
