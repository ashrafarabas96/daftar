/**
 * P4-S7 — THE SEVEN PROOFS THE OWNER REQUIRES, OVER THE INSTALLMENT-AGING
 * PROJECTION.
 *
 * HOW EACH PROOF IS WRITTEN, AND THE FOUR FAILURE SHAPES IT AVOIDS
 * ----------------------------------------------------------------
 * This estate's recurring failures are named, and each one is answered here
 * by construction rather than by care:
 *
 *  (1) «a test that compares an expression with itself.» Every money identity
 *      is asserted against a figure that does NOT come from the projection:
 *      proof 1 compares the bucket total against the AUTHORITATIVE
 *      `outstandingTxnMinor` of the fixture, and the residual is given its
 *      own closed form so the identity is a theorem about the telescoping
 *      clamp rather than a restatement of `O - Sum(alloc)`. `meta_2` further
 *      requires every mutant to CHANGE the output, so a mutation that proves
 *      nothing is itself red.
 *
 *  (2) «an exemption that is never evaluated.» `meta_1` enumerates
 *      `POLICY_KNOBS` and fails if any knob's defective value is not
 *      exercised by a named proof. A knob added without a proof turns this
 *      file red.
 *
 *  (3) «a law whose subject is a textual coincidence.» The subjects are real
 *      files, read with comments stripped, and each law carries a
 *      NON-COINCIDENCE arm asserting the legitimate text is NOT flagged — so
 *      `due_date` and `down_payment_minor` passing is part of proof 7, and a
 *      `DEFAULT now()` audit stamp not being a clock read is part of proof 8.
 *
 *      WHICH PREDICATES ARE THE ESTATE'S, EXACTLY. The first round claimed
 *      proofs 6, 7 and 8 all used the estate's own predicates and «never a
 *      regex invented here», and the challenger showed that was false for 6
 *      and 8 (H-6). The accurate statement:
 *        — proof 7 uses `isAuthoritativeSalesColumn` and
 *          `findAuthoritativeSalesColumns` from
 *          `scripts/guards/no-authoritative-balance.ts`, unmodified;
 *        — proof 6 uses the estate's `discoverSalesTables` for relation
 *          discovery, and a LOCAL `SETTLING_RELATION` vocabulary plus a
 *          LOCAL, alias-independent `relationsRead`. The vocabulary is copied
 *          from seam `S-P4-03`'s question in `scripts/phase4-s1-gate.ts`;
 *          it is not imported, because that gate exports no predicate for it;
 *        — proof 8's `FINANCIAL_TIME` is LOCAL, because the estate has no
 *          body-reading clock predicate yet. Supplying one is the whole point
 *          of patch request PR-3, and this is the predicate to transcribe.
 *      Where a predicate is local it is red-proved here and said to be local.
 *
 *  (4) «a gate that reads a verdict out of an exit status that can never say
 *      no.» Nothing here reads an exit status. Every proof is an `expect`
 *      over a value, and every proof is accompanied by the mutation that
 *      makes it fire, asserted red in the same `it` block. A proof whose
 *      mutant stays green fails.
 *
 * AND THE BOX. This file runs under `packages/domain-core/vitest.config.ts`,
 * which declares neither `globalSetup` nor `setupFiles`. It starts no
 * PostgreSQL cluster, creates no `/tmp/daftar-pg-*` directory and touches no
 * database: it is pure-function work over a reference model and over file
 * text.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverSalesTables,
  findAuthoritativeSalesColumns,
  isAuthoritativeSalesColumn,
  isForbiddenSalesTable,
} from '../../../scripts/guards/no-authoritative-balance';
import { agingBucketLabels } from '../src/invoice';
import {
  aggregate,
  bucketOf,
  DECLARED_SETTLEMENT_ORDER,
  SETTLEMENT_ORDERS,
  contributionsFor,
  CORRECT_POLICY,
  epochDay,
  POLICY_KNOBS,
  projectCustomerAging,
  projectInvoice,
  scheduleCoherenceFindings,
  scheduledDueBy,
  type AgingContribution,
  type InstallmentPlan,
  type OpenInvoiceRow,
  type ProjectionPolicy,
  type SettlementOrder,
} from './phase4-s7-aging-reference-model';

const REPO = join(__dirname, '..', '..', '..');
const SPEC_PATH = join(REPO, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');
const MIGRATIONS_DIR = join(REPO, 'infrastructure', 'database', 'migrations');
const SHIPPED_AGING_PATH = join(MIGRATIONS_DIR, '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');

const SPEC = readFileSync(SPEC_PATH, 'utf8');
const SELF = readFileSync(join(__dirname, 'phase4-s7-installment-aging.test.ts'), 'utf8');

/**
 * THE WHOLE MIGRATION TREE, in apply order. The first round of this file
 * pinned `0083` as "the one definition" of `invoice_outstanding(UUID, UUID[])`
 * and reasoned about a body the database does not hold: `0084:488` DROPs that
 * signature and `0084:593` recreates it with `currency_code, due_date`
 * appended (challenger C-1). A law about the live settlement sum must find the
 * LAST definition of that name across the tree, never a chosen file — so the
 * subject is discovered here and a later migration cannot escape it.
 */
const MIGRATIONS: readonly { readonly name: string; readonly sql: string }[] = Object.freeze(
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => Object.freeze({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') })),
);

/**
 * THE SUBJECT OF A SCHEMA LAW IS SCHEMA, NEVER PROSE. The specification
 * explains at length which columns and which source types it refuses, so a
 * checker run over the whole file flags the file for saying what it will not
 * do. This was not predicted — it was MEASURED: the first run of proofs 6
 * and 8 went red on the specification's own `-- ... accounting_source_type`
 * and `-- ... now()` sentences, which is precisely the «law whose subject is
 * a textual coincidence» failure, caught in the author's own checker. Both
 * laws now read schema. (The estate's own `findAuthoritativeSalesColumns`
 * already strips non-schema internally, which is why proof 7 was green from
 * the first run.)
 */
function sqlSchemaOnly(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

/**
 * The projection SQL the specification is judged on: the block between its
 * two explicit markers, with the comment prefix removed. The sketch lives
 * inside comments because this slice writes no migration, so the block must
 * be DELIMITED and de-commented deliberately rather than hunted for.
 */
function projectionSketch(sql: string): string {
  const begin = '>>> P4S7 PROJECTION SKETCH BEGIN';
  const end = '<<< P4S7 PROJECTION SKETCH END';
  const a = sql.indexOf(begin);
  const b = sql.indexOf(end);
  if (a === -1 || b === -1) throw new Error('the projection sketch markers are missing from the specification');
  return sql
    .slice(a + begin.length, b)
    .split('\n')
    .map((l) => l.replace(/^--\s?/, ''))
    .join('\n');
}

/** Which knob each proof mutates — read by `meta_1`. */
const MUTATIONS_EXERCISED: readonly { readonly proof: string; readonly knob: keyof ProjectionPolicy; readonly to: unknown }[] =
  Object.freeze([
    Object.freeze({ proof: 'proof_1', knob: 'clampToRowAmount' as const, to: false }),
    Object.freeze({ proof: 'proof_2', knob: 'bucketBy' as const, to: 'invoice_due_date' }),
    Object.freeze({ proof: 'proof_3', knob: 'planlessArm' as const, to: 'every_invoice' }),
    Object.freeze({ proof: 'proof_4', knob: 'carryResidual' as const, to: false }),
    Object.freeze({ proof: 'proof_5', knob: 'outstandingSource' as const, to: 'plan_local' }),
    Object.freeze({ proof: 'proof_2', knob: 'scheduleDateShiftDays' as const, to: -200 }),
  ]);

function mutate(knob: keyof ProjectionPolicy, to: unknown): ProjectionPolicy {
  return { ...CORRECT_POLICY, [knob]: to } as ProjectionPolicy;
}

const THRESHOLDS = [30, 60, 90] as const;
const AS_OF = '2026-10-07';

// ── THE DEFECT FIXTURE ────────────────────────────────────────────────────
//
// Exactly the owner's complaint. A 12,000.00 invoice, billed on terms whose
// invoice-level `due_date` is the ORIGINAL first-payment date, carrying a
// 12-month plan of 1,000.00 a month. Three instalments have been collected,
// so the AUTHORITATIVE outstanding is 9,000.00. As of 2026-10-07 only six of
// the twelve dates have passed and 3,000.00 has not fallen due at all — yet
// the shipped routine reports the whole 9,000.00 in the over-90 bucket.

const PLANNED_INVOICE: OpenInvoiceRow = Object.freeze({
  invoiceId: 'inv-plan',
  currencyCode: 'SAR',
  dueDate: '2026-01-15',
  outstandingTxnMinor: 900_000n,
  // The other half of the same authoritative row: three instalments collected.
  paidTxnMinor: 300_000n,
});

const SCHEDULE = Object.freeze(
  Array.from({ length: 12 }, (_, k) =>
    Object.freeze({
      seqNo: k + 1,
      dueDate: `2026-${String(k + 1).padStart(2, '0')}-15`,
      amountTxnMinor: 100_000n,
    }),
  ),
);

const PLAN: InstallmentPlan = Object.freeze({
  invoiceId: 'inv-plan',
  status: 'active' as const,
  downPaymentMinor: 0n,
  downPaymentDueDate: '2026-01-01',
  installments: SCHEDULE,
});

/** An invoice with NO plan: the arm whose behaviour must not change. */
const PLAINLESS_INVOICE: OpenInvoiceRow = Object.freeze({
  invoiceId: 'inv-plain',
  currencyCode: 'SAR',
  dueDate: '2026-05-01',
  outstandingTxnMinor: 250_000n,
  paidTxnMinor: 0n,
});

/**
 * A SUM-LAW VIOLATION: `Sum instalments + down = invoice total` (`P4-AL-13`,
 * `R-SAL-06`) is broken, so the schedule accounts for only 2,000.00 of a
 * 10,000.00 outstanding. The projection must still total the authoritative
 * figure rather than silently losing 8,000.00.
 */
const SHORT_SCHEDULE_INVOICE: OpenInvoiceRow = Object.freeze({
  invoiceId: 'inv-short',
  currencyCode: 'SAR',
  dueDate: '2026-02-01',
  outstandingTxnMinor: 1_000_000n,
  paidTxnMinor: 0n,
});
const SHORT_PLAN: InstallmentPlan = Object.freeze({
  invoiceId: 'inv-short',
  status: 'active' as const,
  downPaymentMinor: 0n,
  downPaymentDueDate: '2026-01-20',
  installments: Object.freeze([
    Object.freeze({ seqNo: 1, dueDate: '2026-11-01', amountTxnMinor: 100_000n }),
    Object.freeze({ seqNo: 2, dueDate: '2026-12-01', amountTxnMinor: 100_000n }),
  ]),
});

/**
 * THE OVER-SCHEDULED DIRECTION (challenger M-11). The sum law is broken the
 * other way: `Σ instalments = 1 800 000` against an invoice total of
 * `paid + outstanding = 900 000`. Every fixture in the first round was on the
 * UNDER-scheduled side, and the seven laws all hold here while the aging
 * reports a 265-day-overdue receivable as entirely not yet due.
 */
const OVER_SCHEDULED_INVOICE: OpenInvoiceRow = Object.freeze({
  invoiceId: 'inv-over',
  currencyCode: 'SAR',
  dueDate: '2026-01-15',
  outstandingTxnMinor: 900_000n,
  paidTxnMinor: 0n,
});
const OVER_SCHEDULED_PLAN: InstallmentPlan = Object.freeze({
  invoiceId: 'inv-over',
  status: 'active' as const,
  downPaymentMinor: 0n,
  downPaymentDueDate: '2026-01-10',
  installments: Object.freeze([
    Object.freeze({ seqNo: 1, dueDate: '2026-01-15', amountTxnMinor: 900_000n }),
    Object.freeze({ seqNo: 2, dueDate: '2027-01-15', amountTxnMinor: 900_000n }),
  ]),
});

function sum(xs: readonly { readonly txnMinor: bigint }[]): bigint {
  return xs.reduce((a, x) => a + x.txnMinor, 0n);
}

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S7 the defect, stated and fixed', () => {
  it('the shipped granularity really is the defect: one invoice, one date, the whole value over 90 days', () => {
    // The status-quo behaviour, reached by the `invoice_due_date` knob.
    const today = aggregate(
      contributionsFor([PLANNED_INVOICE], [PLAN], AS_OF, THRESHOLDS, mutate('bucketBy', 'invoice_due_date')),
    );
    expect(today).toEqual([{ bucketNo: 4, currencyCode: 'SAR', txnMinor: 900_000n, invoiceCount: 1 }]);

    // The fix. Each instalment ages on its own date.
    expect(projectCustomerAging([PLANNED_INVOICE], [PLAN], AS_OF, THRESHOLDS)).toEqual([
      { bucketNo: 1, currencyCode: 'SAR', txnMinor: 400_000n, invoiceCount: 1 },
      { bucketNo: 2, currencyCode: 'SAR', txnMinor: 100_000n, invoiceCount: 1 },
      { bucketNo: 3, currencyCode: 'SAR', txnMinor: 100_000n, invoiceCount: 1 },
      { bucketNo: 4, currencyCode: 'SAR', txnMinor: 300_000n, invoiceCount: 1 },
    ]);
  });

  it('settlement is oldest-scheduled-first, so the three collected instalments are the three earliest', () => {
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS);
    const outstandingSeqs = c.filter((x) => x.origin === 'installment').map((x) => x.seqNo);
    expect(outstandingSeqs).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // January, February and March are settled and contribute nothing.
    expect(outstandingSeqs).not.toContain(1);
  });

  it('an invoice with no plan is bucketed exactly as before', () => {
    expect(projectCustomerAging([PLAINLESS_INVOICE], [], AS_OF, THRESHOLDS)).toEqual([
      { bucketNo: 4, currencyCode: 'SAR', txnMinor: 250_000n, invoiceCount: 1 },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 1 [proof_1] — the sum of the aging buckets equals the authoritative invoice outstanding', () => {
  // The SUBJECT is the authoritative figure, taken from the fixture and never
  // from the projection, over a portfolio that mixes a planned invoice, a
  // plan-less invoice and a broken sum law.
  const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE];
  const plans = [PLAN, SHORT_PLAN];
  const authoritative = rows.reduce((a, r) => a + r.outstandingTxnMinor, 0n);

  it('holds over the portfolio, and per invoice', () => {
    expect(sum(projectCustomerAging(rows, plans, AS_OF, THRESHOLDS))).toBe(authoritative);
    for (const r of rows) {
      const plan = plans.find((p) => p.invoiceId === r.invoiceId);
      expect(sum(projectInvoice(r, plan, AS_OF, THRESHOLDS))).toBe(r.outstandingTxnMinor);
    }
  });

  it('holds at every as-of date, because the allocation does not depend on as-of at all', () => {
    for (const asOf of ['2025-12-31', '2026-01-15', '2026-06-30', '2026-10-07', '2027-06-01']) {
      expect(sum(projectCustomerAging(rows, plans, asOf, THRESHOLDS))).toBe(authoritative);
    }
  });

  it('FIRES under its mutation: a schedule row allowed to absorb more than its own amount', () => {
    const got = sum(projectCustomerAging(rows, plans, AS_OF, THRESHOLDS, mutate('clampToRowAmount', false)));
    expect(got).not.toBe(authoritative);
    expect(got).toBeGreaterThan(authoritative);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 2 [proof_2] — no not-yet-due scheduled amount enters an overdue bucket', () => {
  // THE SUBJECT IS THE PLAN, NOT THE OUTPUT.
  //
  // The first round judged each contribution's bucket against the contribution's
  // OWN `scheduleDate`. One ternary in the model set both fields, so
  // `bucketNo === bucketOf(asOf, scheduleDate)` held BY CONSTRUCTION under
  // both values of the knob, and the law could only ever re-test `bucketOf`
  // (challenger H-3). It could not see a wrong date chosen, a wrong row
  // allocated, or an off-by-a-day boundary — and under its own mutant the
  // not-yet-due set was EMPTY, so the law iterated over nothing while the
  // whole 900 000 aged too old.
  //
  // The bucket is now judged against the date THE PLAN DECLARES, found by
  // `seq_no`, which the projection does not rewrite. The non-vacuity canary
  // is in the mutant arm as well as the holds arm.

  /** The date the PLAN declares for this contribution, read from the plan. */
  function declaredDate(c: AgingContribution, plan: InstallmentPlan, row: OpenInvoiceRow): string | null {
    if (c.origin === 'down_payment') return plan.downPaymentDueDate;
    if (c.origin === 'installment') {
      const i = plan.installments.find((x) => x.seqNo === c.seqNo);
      if (i === undefined) throw new Error(`no declared instalment for seq ${String(c.seqNo)}`);
      return i.dueDate;
    }
    // `residual` and `whole_invoice` are money the schedule never named, and
    // `invoices.due_date` is the only date with authority over it.
    return row.dueDate;
  }

  /** Contributions whose DECLARED date has not arrived at `p_as_of`. */
  function notYetDueByPlan(
    cs: readonly AgingContribution[],
    plan: InstallmentPlan,
    row: OpenInvoiceRow,
  ): readonly AgingContribution[] {
    return cs.filter((c) => {
      const d = declaredDate(c, plan, row);
      return d !== null && epochDay(d) >= epochDay(AS_OF);
    });
  }

  it('every threshold the aging validator admits is at least 1, which is what makes bucket 1 the non-overdue bucket', () => {
    expect(Math.min(...THRESHOLDS)).toBeGreaterThanOrEqual(1);
    expect(bucketOf(AS_OF, AS_OF, THRESHOLDS)).toBe(1);
    expect(bucketOf(AS_OF, '2027-01-01', THRESHOLDS)).toBe(1);
  });

  it('THE STRONG LAW: every contribution sits in the bucket of the date the PLAN declares for it', () => {
    // This implies proof 2 AND its converse (challenger M-11): a bucket may be
    // neither too old nor too young for its own declared date.
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS);
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) {
      expect(x.bucketNo, `seq ${String(x.seqNo)}`).toBe(
        bucketOf(AS_OF, declaredDate(x, PLAN, PLANNED_INVOICE), THRESHOLDS),
      );
    }
    // And the law really does range over several distinct buckets, so it is
    // not satisfied by everything landing in one.
    expect(new Set(c.map((x) => x.bucketNo)).size).toBeGreaterThan(1);
  });

  it('holds: money whose DECLARED date has not arrived is in bucket 1 and nowhere else', () => {
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS);
    const future = notYetDueByPlan(c, PLAN, PLANNED_INVOICE);
    expect(future.length, 'the law arm is vacuous').toBeGreaterThan(0);
    for (const f of future) expect(f.bucketNo).toBe(1);
    expect(sum(future)).toBe(300_000n); // October, November, December
  });

  it('THE CONVERSE: money whose DECLARED date is long past may not sit in the not-yet-due bucket', () => {
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS);
    const longPast = c.filter((x) => {
      const d = declaredDate(x, PLAN, PLANNED_INVOICE);
      return d !== null && epochDay(AS_OF) - epochDay(d) > Math.max(...THRESHOLDS);
    });
    expect(longPast.length, 'the converse arm is vacuous').toBeGreaterThan(0);
    for (const x of longPast) expect(x.bucketNo).toBe(THRESHOLDS.length + 1);
  });

  it('KNOWN SOFT SPOT, declared: the residual is bucketed by invoices.due_date, which the strong law treats as its declared date', () => {
    // Stated rather than left for a challenger to find that the author knew.
    // The residual is money the schedule never named, so the plan declares no
    // date for it and `invoices.due_date` is the only date with authority.
    // That is now INSIDE the strong law rather than an exception to it:
    // `declaredDate` returns the invoice's date for `residual`, so the
    // residual's bucket is asserted too, against a date the projection does
    // not choose.
    const c = contributionsFor([SHORT_SCHEDULE_INVOICE], [SHORT_PLAN], AS_OF, THRESHOLDS);
    const residual = c.filter((x) => x.origin === 'residual');
    expect(residual).toHaveLength(1);
    expect(residual[0]?.bucketNo).toBe(bucketOf(AS_OF, SHORT_SCHEDULE_INVOICE.dueDate, THRESHOLDS));
    expect(residual[0]?.bucketNo).toBeGreaterThan(1);
    for (const i of SHORT_PLAN.installments) expect(epochDay(i.dueDate)).toBeGreaterThan(epochDay(AS_OF));
    // The honest reading: a sum-law VIOLATION signal, aged conservatively at
    // the invoice's own date. The violation itself is now SIGNALLED too —
    // proof 9.
    expect(scheduleCoherenceFindings([SHORT_SCHEDULE_INVOICE], [SHORT_PLAN])).toEqual([
      { invoiceId: 'inv-short', kind: 'under_scheduled', excessTxnMinor: -800_000n },
    ]);
  });

  it('FIRES under its mutation: bucketing by the invoice due date instead of the schedule date', () => {
    const c = contributionsFor([PLANNED_INVOICE], [PLAN], AS_OF, THRESHOLDS, mutate('bucketBy', 'invoice_due_date'));
    // THE CANARY IS IN THE MUTANT ARM TOO: the not-yet-due set is computed
    // from the PLAN, so it is non-empty whatever the projection relabels.
    const future = notYetDueByPlan(c, PLAN, PLANNED_INVOICE);
    expect(future.length, 'the mutant arm is vacuous — the law saw nothing').toBeGreaterThan(0);
    expect(sum(future)).toBe(300_000n);
    // ...and that money is now in an overdue bucket.
    for (const f of future) expect(f.bucketNo).toBeGreaterThan(1);
    expect(c.every((x) => x.bucketNo === 4)).toBe(true);
  });

  it('FIRES under its mutation: every schedule date shifted 200 days earlier inside the allocation', () => {
    // The defect the challenger demonstrated no knob could reach. The output
    // stays self-consistent — each contribution reports the shifted date it
    // used — so a law judging the bucket against the output cannot see it.
    const m = mutate('scheduleDateShiftDays', -200);
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS, m);
    // Self-consistent, which is why the old law stayed green:
    for (const x of c) {
      expect(x.bucketNo).toBe(bucketOf(AS_OF, x.scheduleDate, THRESHOLDS));
    }
    // The plan-subject law sees it.
    const wrong = c.filter((x) => x.bucketNo !== bucketOf(AS_OF, declaredDate(x, PLAN, PLANNED_INVOICE), THRESHOLDS));
    expect(wrong.length).toBeGreaterThan(0);
    // And the canary holds while the law fires: real not-yet-due money has
    // been aged into overdue buckets.
    const future = notYetDueByPlan(c, PLAN, PLANNED_INVOICE);
    expect(future.length).toBeGreaterThan(0);
    expect(future.some((f) => f.bucketNo > 1)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 3 [proof_3] — no amount is counted twice', () => {
  const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE];
  const plans = [PLAN, SHORT_PLAN];

  it('the plan-aware arm and the plan-less arm PARTITION the open invoices', () => {
    const c = contributionsFor(rows, plans, AS_OF, THRESHOLDS);
    const planned = new Set(plans.filter((p) => p.status === 'active').map((p) => p.invoiceId));
    for (const r of rows) {
      const mine = c.filter((x) => x.invoiceId === r.invoiceId);
      const origins = new Set(mine.map((x) => x.origin));
      if (planned.has(r.invoiceId)) {
        expect(origins.has('whole_invoice')).toBe(false);
      } else {
        expect([...origins]).toEqual(['whole_invoice']);
      }
    }
  });

  it('each schedule row contributes at most once, and the keys are unique', () => {
    const c = contributionsFor(rows, plans, AS_OF, THRESHOLDS);
    const keys = c.map((x) => `${x.invoiceId}|${x.origin}|${String(x.seqNo)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('M-9: an ACTIVE PLAN WITH NO INSTALMENT ROWS takes the PLAN arm, as the SQL does — the row count is not consulted', () => {
    // The challenger measured the model and the SQL taking OPPOSITE arms here
    // and giving opposite buckets on one input: the model required
    // `installments.length > 0`, the SQL's plan-less arm is
    // `NOT EXISTS (… active_plan …)` and `active_plan` is built from
    // `installment_plans` alone. The SQL is right — an active plan is a plan,
    // and its down payment is a schedule row with a date of its own — so the
    // model no longer consults the row count, and THIS LAW is what stops the
    // condition being reinstated.
    const emptyPlan: InstallmentPlan = Object.freeze({
      invoiceId: 'inv-empty',
      status: 'active' as const,
      downPaymentMinor: 400n,
      downPaymentDueDate: '2027-06-01', // future
      installments: Object.freeze([]),
    });
    const row: OpenInvoiceRow = Object.freeze({
      invoiceId: 'inv-empty',
      currencyCode: 'SAR',
      dueDate: '2026-01-15', // long past
      outstandingTxnMinor: 400n,
      paidTxnMinor: 0n,
    });
    const c = projectInvoice(row, emptyPlan, AS_OF, THRESHOLDS);
    // The PLAN arm: the down payment at its own future date, bucket 1.
    expect(c.map((x) => [x.origin, x.seqNo, x.scheduleDate, x.bucketNo, x.txnMinor])).toEqual([
      ['down_payment', 0, '2027-06-01', 1, 400n],
    ]);
    // NOT the plan-less arm, which would put the whole 400 at the invoice's
    // long-past due date in the oldest bucket — the opposite end of the aging.
    expect(c.some((x) => x.origin === 'whole_invoice')).toBe(false);
    expect(bucketOf(AS_OF, row.dueDate, THRESHOLDS)).toBe(THRESHOLDS.length + 1);
    // Totality is unaffected either way, which is why proofs 1 and 4 could
    // not see this.
    expect(sum(c)).toBe(row.outstandingTxnMinor);
    // And the SQL agrees by construction: its plan-less arm keys off the PLAN
    // row's existence, not the instalment rows'.
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    expect(sketch).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM active_plan ap WHERE ap\.invoice_id = oi\.invoice_id\)/);
    expect(sketch).toMatch(/FROM public\.installment_plans p/);
    // The state is ALSO made unreachable at commit, so this is closed from
    // both ends rather than only from the model's.
    expect(SPEC).toMatch(/AT LEAST ONE `installments` row per active plan/);
  });

  it('two active plans on one invoice are REFUSED rather than silently counted twice', () => {
    const twin: InstallmentPlan = { ...PLAN, invoiceId: 'inv-plan' };
    expect(() => contributionsFor([PLANNED_INVOICE], [PLAN, twin], AS_OF, THRESHOLDS)).toThrow(
      /installment_plan\.more_than_one_active/,
    );
  });

  it('the specification forbids it structurally, with a partial unique index', () => {
    expect(SPEC).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+installment_plans\s*\(\s*business_id\s*,\s*invoice_id\s*\)\s*WHERE\s+status\s*=\s*'active'/i,
    );
  });

  it('FIRES under its mutation: the plan-less arm stops excluding planned invoices', () => {
    const authoritative = rows.reduce((a, r) => a + r.outstandingTxnMinor, 0n);
    const got = sum(projectCustomerAging(rows, plans, AS_OF, THRESHOLDS, mutate('planlessArm', 'every_invoice')));
    expect(got).not.toBe(authoritative);
    // The two planned invoices are counted twice over.
    expect(got).toBe(authoritative + PLANNED_INVOICE.outstandingTxnMinor + SHORT_SCHEDULE_INVOICE.outstandingTxnMinor);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 4 [proof_4] — no amount disappears', () => {
  // A DIFFERENT SUBJECT from proof 1. Proof 1 is about the total being right
  // when the schedule is well formed; this is about money the SCHEDULE DOES
  // NOT ACCOUNT FOR still reaching a bucket. A projection that totals
  // correctly on good data and loses the difference on bad data passes
  // proof 1 and fails here, which is why the two mutations are different.

  it('a broken sum law does not lose the difference: the residual reaches a bucket', () => {
    const c = projectInvoice(SHORT_SCHEDULE_INVOICE, SHORT_PLAN, AS_OF, THRESHOLDS);
    expect(sum(c)).toBe(SHORT_SCHEDULE_INVOICE.outstandingTxnMinor);
    const residual = c.filter((x) => x.origin === 'residual');
    expect(sum(residual)).toBe(800_000n);
    // And it is bucketed at the invoice's own due date, the only date with
    // any authority over money the schedule never named.
    expect(residual.map((x) => x.scheduleDate)).toEqual([SHORT_SCHEDULE_INVOICE.dueDate]);
  });

  it('a negative outstanding is carried too, rather than clamped away', () => {
    const over: OpenInvoiceRow = { ...PLANNED_INVOICE, outstandingTxnMinor: -5_000n };
    expect(sum(projectInvoice(over, PLAN, AS_OF, THRESHOLDS))).toBe(-5_000n);
  });

  it('the named BOUNDARIES are explicit fixtures, not left to chance', () => {
    // The first round hoped 400 random cases would reach these. The
    // challenger measured that `O = 0`, `O = T`, `O` equal to a suffix sum and
    // a zero-amount row were each ZERO of 400, and that `n` was never 2 or 4,
    // because `rng * 1103515245` exceeds 2^53 and the low bits rounded away.
    // They are fixtures now. The challenger checked the form by hand at each
    // one and found it exact, so this pins behaviour rather than hunting a
    // bug.
    const inst = [
      { seqNo: 1, dueDate: '2026-03-01', amountTxnMinor: 100_000n },
      { seqNo: 2, dueDate: '2026-06-01', amountTxnMinor: 200_000n },
      { seqNo: 3, dueDate: '2026-09-01', amountTxnMinor: 300_000n },
    ];
    const plan: InstallmentPlan = {
      invoiceId: 'inv-b',
      status: 'active',
      downPaymentMinor: 50_000n,
      downPaymentDueDate: '2026-01-05',
      installments: inst,
    };
    const T = 650_000n; // 50 000 + 100 000 + 200 000 + 300 000
    // Every inclusive suffix sum of the ordered schedule, plus the endpoints.
    const boundaries: readonly bigint[] = [0n, 300_000n, 500_000n, 600_000n, T, T + 1n, -1n];
    for (const O of boundaries) {
      const row: OpenInvoiceRow = {
        invoiceId: 'inv-b',
        currencyCode: 'SAR',
        dueDate: '2026-02-01',
        outstandingTxnMinor: O,
        paidTxnMinor: 0n,
      };
      const c = projectInvoice(row, plan, AS_OF, THRESHOLDS);
      expect(sum(c), `boundary O=${String(O)}`).toBe(O);
      // At an exact suffix sum the cut falls BETWEEN rows, so no row is
      // partially allocated — the case a pro-rata rule would have to round.
      if (O === 300_000n || O === 500_000n || O === 600_000n || O === T || O === 0n) {
        for (const x of c) {
          if (x.origin === 'residual') continue;
          const declared =
            x.origin === 'down_payment'
              ? plan.downPaymentMinor
              : (inst.find((i) => i.seqNo === x.seqNo)?.amountTxnMinor as bigint);
          expect(x.txnMinor, `partial row at exact boundary O=${String(O)}`).toBe(declared);
        }
      }
    }
    // `n = 2` and `n = 4`, which the generator never produced.
    for (const n of [1, 2, 3, 4, 5]) {
      const rows = Array.from({ length: n }, (_, k) => ({
        seqNo: k + 1,
        dueDate: `2026-0${k + 1}-01`,
        amountTxnMinor: 100_000n,
      }));
      const pl: InstallmentPlan = { ...plan, installments: rows, downPaymentMinor: 0n };
      const row: OpenInvoiceRow = {
        invoiceId: 'inv-b',
        currencyCode: 'SAR',
        dueDate: '2026-02-01',
        outstandingTxnMinor: BigInt(n) * 50_000n,
        paidTxnMinor: 0n,
      };
      expect(sum(projectInvoice(row, pl, AS_OF, THRESHOLDS)), `n=${n}`).toBe(BigInt(n) * 50_000n);
    }
    // A ZERO-amount schedule row. `amount_txn_minor >= 1` forbids it in the
    // database, so this is a model-level robustness case, named as such.
    const withZero: InstallmentPlan = {
      ...plan,
      downPaymentMinor: 0n,
      installments: [
        { seqNo: 1, dueDate: '2026-03-01', amountTxnMinor: 0n },
        { seqNo: 2, dueDate: '2026-06-01', amountTxnMinor: 100_000n },
      ],
    };
    const zrow: OpenInvoiceRow = {
      invoiceId: 'inv-b',
      currencyCode: 'SAR',
      dueDate: '2026-02-01',
      outstandingTxnMinor: 100_000n,
      paidTxnMinor: 0n,
    };
    const zc = projectInvoice(zrow, withZero, AS_OF, THRESHOLDS);
    expect(sum(zc)).toBe(100_000n);
    expect(zc.every((x) => x.txnMinor !== 0n)).toBe(true); // a zero row emits nothing
  });

  it('the closed-form allocation agrees with an INDEPENDENT oldest-first simulation, over randomised schedules', () => {
    // A second implementation, a loop with an accumulator rather than a closed
    // form. The generator is fixed: the first round's `rng * 1103515245`
    // exceeded 2^53 so the low bits rounded away and `next(12)` yielded only
    // six distinct values (challenger M-7). `Math.imul` keeps the multiply in
    // 32 bits exactly, and the spread is ASSERTED below rather than assumed.
    let rng = 0x9e3779b9 | 0;
    const next = (n: number): number => {
      rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
      return ((rng >>> 1) % n + n) % n;
    };
    const seenN = new Set<number>();
    const seenMonth = new Set<number>();
    for (let trial = 0; trial < 400; trial += 1) {
      const n = 1 + next(14);
      seenN.add(n);
      const inst = Array.from({ length: n }, (_, k) => {
        const month = 1 + next(12);
        seenMonth.add(month);
        return {
          seqNo: k + 1,
          dueDate: `2026-${String(month).padStart(2, '0')}-${String(1 + next(28)).padStart(2, '0')}`,
          amountTxnMinor: BigInt(1 + next(90_000)),
        };
      });
      const down = BigInt(next(50_000));
      const total = down + inst.reduce((a, i) => a + i.amountTxnMinor, 0n);
      // Reach past both ends, so over- and under-coverage both occur.
      const O = BigInt(next(Number(total) + 40_000) - 10_000);
      const row: OpenInvoiceRow = {
        invoiceId: 'r',
        currencyCode: 'SAR',
        dueDate: '2026-06-01',
        outstandingTxnMinor: O,
        paidTxnMinor: 0n,
      };
      const plan: InstallmentPlan = {
        invoiceId: 'r',
        status: 'active',
        downPaymentMinor: down,
        downPaymentDueDate: '2026-01-02',
        installments: inst,
      };

      const ordered = [
        { seqNo: 0, dueDate: '2026-01-02', amount: down },
        ...inst.map((i) => ({ seqNo: i.seqNo, dueDate: i.dueDate, amount: i.amountTxnMinor })),
      ].sort((a, b) => epochDay(a.dueDate) - epochDay(b.dueDate) || a.seqNo - b.seqNo);
      let rem = O > 0n ? O : 0n;
      const simAlloc = new Map<number, bigint>();
      for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const r = ordered[i] as { seqNo: number; amount: bigint };
        const a = rem < r.amount ? rem : r.amount;
        if (a !== 0n) simAlloc.set(r.seqNo, a);
        rem -= a;
      }

      // M-8: THE RESIDUAL GETS AN INDEPENDENT COMPUTATION. The first round's
      // `O − (max(O,0) − rem)` was algebraically `O − Σ alloc`, and the
      // allocations were asserted equal the line before, so the residual line
      // was implied and proved nothing. This is a CASE ANALYSIS — structurally
      // different from the model's clamp `O − min(max(O,0), T)` — and it
      // mentions neither `rem` nor `simAlloc`.
      const simResidual = O > total ? O - total : O < 0n ? O : 0n;

      const got = projectInvoice(row, plan, AS_OF, THRESHOLDS);
      const gotAlloc = new Map(got.filter((x) => x.origin !== 'residual').map((x) => [x.seqNo as number, x.txnMinor]));
      expect([...gotAlloc.entries()].sort((a, b) => a[0] - b[0])).toEqual(
        [...simAlloc.entries()].sort((a, b) => a[0] - b[0]),
      );
      expect(sum(got.filter((x) => x.origin === 'residual'))).toBe(simResidual);
      expect(sum(got)).toBe(O);
    }
    // THE GENERATOR IS NOT DEGENERATE, asserted rather than hoped.
    expect(seenN.size, 'schedule length barely varies').toBeGreaterThanOrEqual(12);
    expect(seenMonth.size, 'month barely varies').toBe(12);
    for (const n of [2, 4]) expect(seenN, `n=${n} never generated`).toContain(n);
  });

  it('FIRES under its mutation: the residual is dropped', () => {
    const got = sum(
      projectInvoice(SHORT_SCHEDULE_INVOICE, SHORT_PLAN, AS_OF, THRESHOLDS, mutate('carryResidual', false)),
    );
    expect(got).not.toBe(SHORT_SCHEDULE_INVOICE.outstandingTxnMinor);
    expect(got).toBe(200_000n); // 8,000.00 has vanished
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 4(b) — no amount disappears AT THE API READ EITHER (a defect found while proving this)', () => {
  // Proof 4 is about the SQL projection totalling the authoritative figure.
  // Asserting it there and stopping would have left the law true of the
  // routine and false of the number the merchant sees, so the same law was
  // carried one layer out — and it fired.
  //
  // `customer_ar_aging` returns a ONE-BASED `bucket_no`: the shipped body is
  // `1 + (SELECT count(*) ... WHERE (p_as_of - due_date) > t.threshold)`
  // (`0084:707-710`), so for `k` supplied boundaries it ranges over `1..k+1`.
  // `agingBucketLabels` returns `k+1` labels at indices `0..k`
  // (`packages/domain-core/src/invoice.ts:169-180`). The read surface indexes
  // the label array with the raw bucket number.
  const READ_SURFACE = readFileSync(
    join(REPO, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts'),
    'utf8',
  );
  const DAYS = [30, 60, 90] as const;

  /** A civil date `n` days before `AS_OF`, so the ages are derived and not hand-picked. */
  const daysBefore = (n: number): string =>
    new Date((epochDay(AS_OF) - n) * 86_400_000).toISOString().slice(0, 10);

  it('the SQL bucket number is one-based and tops out at k+1', () => {
    expect(bucketOf(AS_OF, daysBefore(0), DAYS)).toBe(1); // not yet due / due today
    expect(bucketOf(AS_OF, daysBefore(30), DAYS)).toBe(1); // the band is `> t`, so 30 is still bucket 1
    expect(bucketOf(AS_OF, daysBefore(31), DAYS)).toBe(2);
    expect(bucketOf(AS_OF, daysBefore(61), DAYS)).toBe(3);
    expect(bucketOf(AS_OF, daysBefore(91), DAYS)).toBe(4);
    expect(bucketOf(AS_OF, daysBefore(4000), DAYS)).toBe(DAYS.length + 1);
    // Faithful to the shipped expression: a NULL due date is bucket 1.
    expect(bucketOf(AS_OF, null, DAYS)).toBe(1);
  });

  it('the label array is zero-based and has exactly k+1 slots, so the top bucket has no slot at its own number', () => {
    expect(agingBucketLabels(DAYS)).toEqual(['0-30', '31-60', '61-90', 'over-90']);
    expect(agingBucketLabels(DAYS).length).toBe(DAYS.length + 1);
    // The index the read surface uses for the oldest bucket does not exist.
    expect(agingBucketLabels(DAYS)[DAYS.length + 1]).toBeUndefined();
  });

  it('MEASURED: the shipped read surface indexes the labels with the raw bucket number, so the oldest bucket is dropped', () => {
    // The exact shipped text, so this law is about the code and not about a
    // description of it. When the repair lands this assertion turns red and
    // points at itself to be retired.
    expect(READ_SURFACE).toMatch(/const bucket = buckets\[r\.bucket_no\];/);
    expect(READ_SURFACE).toMatch(/if \(bucket === undefined\) continue;/);
    // `continue` on an undefined slot means the oldest bucket's money is
    // dropped from `baseMinor`, from `invoiceCount` AND from
    // `totalBaseMinor`, which is the one figure the screen shows as the
    // customer's aged debt. The remaining three are reported one band too
    // old: bucket 1 (not yet due) is labelled '31-60'.
    const shifted = (bucketNo: number): string | undefined => agingBucketLabels(DAYS)[bucketNo];
    expect(shifted(1)).toBe('31-60'); // the NOT-YET-DUE money, labelled overdue
    expect(shifted(4)).toBeUndefined(); // the over-90 money, labelled nothing and dropped
  });

  it('the correct mapping is total and order-preserving, and loses nothing', () => {
    const correct = (bucketNo: number): string | undefined => agingBucketLabels(DAYS)[bucketNo - 1];
    expect(correct(1)).toBe('0-30');
    expect(correct(2)).toBe('31-60');
    expect(correct(3)).toBe('61-90');
    expect(correct(4)).toBe('over-90');
    for (let b = 1; b <= DAYS.length + 1; b += 1) expect(correct(b)).toBeDefined();
  });

  it('and the granularity fix makes the defect WORSE, which is why it is raised now and not later', () => {
    // Today an invoice contributes to ONE bucket, so a merchant with no
    // over-90 debt never sees the loss. After this slice a single invoice
    // contributes to several buckets, so the dropped top bucket takes a
    // slice out of almost every planned invoice's aging.
    const c = projectCustomerAging([PLANNED_INVOICE], [PLAN], AS_OF, THRESHOLDS);
    expect(c.map((b) => b.bucketNo)).toEqual([1, 2, 3, 4]);
    const dropped = c.filter((b) => b.bucketNo === DAYS.length + 1);
    expect(sum(dropped)).toBe(300_000n); // silently lost by the shipped read
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 5 [proof_5] — a payment or a reversal changes the projection THROUGH the existing invoice settlement truth', () => {
  // The three states are the SAME invoice at three settlement positions. A
  // payment and its reversal are expressed ONLY as a change in
  // `outstandingTxnMinor`, which is what `invoice_outstanding` returns
  // (`0083:295`) — there is no other input to move.
  const before: OpenInvoiceRow = PLANNED_INVOICE; // 9,000.00 outstanding
  const afterPayment: OpenInvoiceRow = { ...PLANNED_INVOICE, outstandingTxnMinor: 800_000n };

  /** The plan, with the forbidden plan-local field made COUNTABLE. */
  function countingPlan(): { plan: InstallmentPlan; reads: () => number } {
    let n = 0;
    const p = { ...PLAN } as Record<string, unknown>;
    Object.defineProperty(p, 'planLocalCollectedMinor', {
      get: () => {
        n += 1;
        return 300_000n;
      },
      enumerable: true,
    });
    return { plan: p as unknown as InstallmentPlan, reads: () => n };
  }

  it('a payment moves the projection, and moves it by exactly the payment', () => {
    const b = projectCustomerAging([before], [PLAN], AS_OF, THRESHOLDS);
    const a = projectCustomerAging([afterPayment], [PLAN], AS_OF, THRESHOLDS);
    expect(sum(b) - sum(a)).toBe(100_000n);
    // And it settles the OLDEST outstanding instalment, April, which was in
    // the over-90 bucket — so the over-90 bucket is what shrinks.
    const bucket4 = (x: readonly { bucketNo: number; txnMinor: bigint }[]): bigint =>
      x.filter((y) => y.bucketNo === 4).reduce((s, y) => s + y.txnMinor, 0n);
    expect(bucket4(b) - bucket4(a)).toBe(100_000n);
  });

  it('a reversal returns the projection EXACTLY to where it was', () => {
    const b = projectCustomerAging([before], [PLAN], AS_OF, THRESHOLDS);
    const reversed = projectCustomerAging(
      [{ ...PLANNED_INVOICE, outstandingTxnMinor: 900_000n }],
      [PLAN],
      AS_OF,
      THRESHOLDS,
    );
    expect(reversed).toEqual(b);
  });

  it('the projection READS NO plan-local settlement figure — counted, not asserted', () => {
    const { plan, reads } = countingPlan();
    projectInvoice(before, plan, AS_OF, THRESHOLDS);
    expect(reads()).toBe(0);
  });

  it('FIRES under its mutation: a plan-local collected total is a parallel path that a payment does not move', () => {
    const { plan, reads } = countingPlan();
    const m = mutate('outstandingSource', 'plan_local');
    const b = sum(projectInvoice(before, plan, AS_OF, THRESHOLDS, m));
    const a = sum(projectInvoice(afterPayment, plan, AS_OF, THRESHOLDS, m));
    // The mutant really did read the forbidden field...
    expect(reads()).toBeGreaterThan(0);
    // ...and the payment changed nothing, which is the harm.
    expect(a).toBe(b);
    expect(a).not.toBe(afterPayment.outstandingTxnMinor);
  });

  it('the specification adds no reducer and no second settlement path', () => {
    expect(SPEC).toMatch(/NO reducer relation/);
    expect(SPEC).not.toMatch(/INSERT\s+INTO\s+(payment_allocations|customer_credit_applications)/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 6 [proof_6] — no installment journal, and no new reducer branch in the LIVE settlement sum', () => {
  // THE SUBJECT IS THE LAST DEFINITION IN THE TREE, NOT A FILE (C-1), AND THE
  // DETECTOR IS ALIAS-INDEPENDENT (H-5). The first round pinned `0083` and
  // required a ONE-LETTER alias, so a branch planted with a two-letter alias,
  // no alias, or unqualified was invisible — and the author's own mutation
  // used `n` while the two real reducers happen to use `a` and `c`, so the
  // detector was tailored to itself.

  /** The last definition of a routine signature across the tree, in apply order. */
  function liveDefinition(header: string): { migration: string; body: string } {
    let found: { migration: string; body: string } | null = null;
    for (const m of MIGRATIONS) {
      let at = -1;
      for (;;) {
        at = m.sql.indexOf(header, at + 1);
        if (at === -1) break;
        const open = m.sql.indexOf('$fn$', at) === -1 ? m.sql.indexOf('$$', at) : m.sql.indexOf('$fn$', at);
        const tag = m.sql.startsWith('$fn$', open) ? '$fn$' : '$$';
        const close = m.sql.indexOf(tag, open + tag.length);
        found = { migration: m.name, body: m.sql.slice(open + tag.length, close) };
      }
    }
    if (found === null) throw new Error(`no definition of: ${header}`);
    return found;
  }

  /**
   * Every relation a body reads, by `public.`-qualified name — no alias
   * pattern at all, so an alias of any length, or none, is seen alike.
   */
  function relationsRead(body: string): string[] {
    return [...body.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)/gi)]
      .map((m) => (m[1] as string).toLowerCase())
      .filter((t, i, xs) => xs.indexOf(t) === i)
      .sort();
  }

  /**
   * WHAT MAKES A RELATION AN INVOICE REDUCER — STRUCTURALLY, NOT BY NAME.
   *
   * A name list would be a textual coincidence and would miss the next
   * reducer whatever it is called. Seam `S-P4-03` asks which relations settle
   * an invoice, and the answer has a SHAPE: a relation that reduces an
   * invoice declares `invoice_amount_applied_minor`. Exactly two relations in
   * the tree do — `payment_allocations` (`0081:314`) and
   * `customer_credit_applications` (`0081:455`) — and a later slice's reducer
   * will declare it too, because that is the column the one definition sums.
   *
   * So the watched set is DISCOVERED from the schema and a new reducer cannot
   * escape it by being named something unexpected.
   */
  const REDUCER_COLUMN = /invoice_amount_applied_minor/i;

  /** Every relation in the tree whose CREATE TABLE declares the reducer column. */
  function reducerRelationsInTree(): string[] {
    const out = new Set<string>();
    const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?("[^"]+"|[A-Za-z_][\w$]*)\s*\(/gi;
    for (const m of MIGRATIONS) {
      const schema = sqlSchemaOnly(m.sql);
      let x: RegExpExecArray | null;
      const re = new RegExp(create.source, create.flags);
      while ((x = re.exec(schema)) !== null) {
        const name = (x[1] ?? '').replace(/"/g, '').toLowerCase();
        // The balanced CREATE TABLE body, taken to the matching paren.
        let depth = 0;
        let end = re.lastIndex - 1;
        for (let i = re.lastIndex - 1; i < schema.length; i += 1) {
          const ch = schema[i];
          if (ch === '(') depth += 1;
          else if (ch === ')') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (REDUCER_COLUMN.test(schema.slice(re.lastIndex, end))) out.add(name);
      }
    }
    return [...out].sort();
  }

  const SETTLING_RELATION = new RegExp(`^(${reducerRelationsInTree().join('|')})$`);

  function journalFindings(raw: string): string[] {
    const sql = sqlSchemaOnly(raw);
    const f: string[] = [];
    if (/accounting_source_type/i.test(sql)) f.push('declares an accounting_source_type');
    if (/INSERT\s+INTO\s+(public\.)?accounting_source_bindings/i.test(sql)) f.push('registers an accounting source binding');
    if (/INSERT\s+INTO\s+(public\.)?journal_(entries|lines)/i.test(sql)) f.push('posts a journal entry');
    for (const t of discoverSalesTables(sql)) if (/journal/.test(t)) f.push(`creates a journal relation: ${t}`);
    return f;
  }

  const HEADER = 'CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])';

  it('the LIVE definition is in 0084, not 0083 — the subject is discovered, not chosen', () => {
    const live = liveDefinition(HEADER);
    expect(live.migration).toBe('0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');
    // And 0083's body really is gone: 0084 drops that signature.
    const dropper = MIGRATIONS.find((m) => /DROP FUNCTION public\.invoice_outstanding\(UUID, UUID\[\]\)/.test(m.sql));
    expect(dropper?.name).toBe('0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');
  });

  it('the live settlement sum reads exactly the accepted reducers, and S7 appends nothing', () => {
    const live = liveDefinition(HEADER);
    const read = relationsRead(live.body);
    const reducersRead = read.filter((t) => SETTLING_RELATION.test(t));
    expect(reducersRead).toEqual(['customer_credit_applications', 'payment_allocations']);
    // EVERY settling relation the tree creates is read by that body: a new
    // one that is not read would be a second copy of the settlement sum.
    // Discovered structurally: exactly the two relations that declare
    // `invoice_amount_applied_minor`, and the live body reads BOTH.
    expect(reducerRelationsInTree()).toEqual(['customer_credit_applications', 'payment_allocations']);
    expect(reducerRelationsInTree().filter((t) => !read.includes(t))).toEqual([]);
    // And the specification does not redefine it at all.
    expect(sqlSchemaOnly(SPEC)).not.toMatch(/FUNCTION\s+invoice_outstanding/i);
  });

  it('the specification creates installment_plans and installments, and neither is journal-bearing', () => {
    expect(discoverSalesTables(SPEC).sort()).toEqual(['installment_plans', 'installments']);
    expect(journalFindings(SPEC)).toEqual([]);
    // Neither is of the settlement vocabulary, so neither owes a branch.
    for (const t of discoverSalesTables(SPEC)) expect(SETTLING_RELATION.test(t)).toBe(false);
  });

  it('NON-COINCIDENCE: the checker flags the construct and not the word', () => {
    expect(SPEC).toMatch(/accounting_source_type/);
    expect(SPEC).toMatch(/accounting_source_bindings/);
    expect(SPEC).toMatch(/journal/i);
    expect(sqlSchemaOnly(SPEC)).not.toMatch(/accounting_source_type/);
    expect(journalFindings(SPEC)).toEqual([]);
    expect(sqlSchemaOnly(SPEC)).toMatch(/CREATE TABLE installments/);
    expect(sqlSchemaOnly(SPEC)).toMatch(/amount_txn_minor/);
  });

  it('FIRES under its mutation: an installment journal planted into the specification', () => {
    const planted = `${SPEC}\nALTER TABLE installments ADD COLUMN accounting_source_type TEXT GENERATED ALWAYS AS ('installment') STORED;\nINSERT INTO accounting_source_bindings (source_type) VALUES ('installment');\n`;
    expect(journalFindings(planted)).toEqual([
      'declares an accounting_source_type',
      'registers an accounting source binding',
    ]);
    const plantedRelation = `${SPEC}\nCREATE TABLE installment_journal_lines (business_id UUID NOT NULL, id UUID NOT NULL);\n`;
    expect(journalFindings(plantedRelation)).toContain('creates a journal relation: installment_journal_lines');
  });

  it('FIRES under its mutation: a reducer branch planted with ANY alias shape, measured four ways', () => {
    // The challenger planted a branch three ways the first detector could not
    // see. All four shapes must now be caught, and the two-letter and
    // no-alias forms are the ones that used to pass.
    const live = liveDefinition(HEADER);
    const shapes: readonly { readonly name: string; readonly sql: string }[] = [
      { name: 'one-letter alias', sql: 'FROM public.installment_collections n WHERE n.business_id = x' },
      { name: 'two-letter alias', sql: 'FROM public.installment_collections ic WHERE ic.business_id = x' },
      { name: 'AS alias', sql: 'FROM public.installment_collections AS coll WHERE coll.business_id = x' },
      { name: 'no alias', sql: 'FROM public.installment_collections WHERE business_id = x' },
    ];
    for (const shape of shapes) {
      const planted = `${live.body}\n            UNION ALL\n            SELECT invoice_id, amount, rel ${shape.sql}\n`;
      expect(planted).not.toBe(live.body);
      const reducers = relationsRead(planted).filter(
        (t) => SETTLING_RELATION.test(t) || t === 'installment_collections',
      );
      expect(reducers, `missed with ${shape.name}`).toContain('installment_collections');
    }
  });

  it('FIRES under its mutation: a NEW reducer relation, discovered by its SHAPE and not its name', () => {
    // A later slice's reducer, named nothing this file could have guessed.
    const planted = `CREATE TABLE zzz_whatever_we_call_it_next (
      business_id UUID NOT NULL, id UUID NOT NULL, invoice_id UUID NOT NULL,
      invoice_amount_applied_minor BIGINT NOT NULL,
      invoice_carrying_base_released_minor BIGINT NOT NULL);`;
    // The discovery finds it by the reducer column, with no name list.
    expect(REDUCER_COLUMN.test(planted)).toBe(true);
    expect(discoverSalesTables(planted)).toContain('zzz_whatever_we_call_it_next');
    // And the live settlement sum does not read it, which is the violation.
    expect(relationsRead(liveDefinition(HEADER).body)).not.toContain('zzz_whatever_we_call_it_next');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 7 [proof_7] — no stored installment outstanding', () => {
  // The SUBJECT is the specification's CREATE TABLE column lists, read by the
  // ESTATE'S OWN predicate — `isAuthoritativeSalesColumn` /
  // `findAuthoritativeSalesColumns` in
  // `scripts/guards/no-authoritative-balance.ts` — and not by any pattern
  // invented in this file.
  const WATCHED = ['installment_plans', 'installments'];

  it('neither relation is itself derived truth', () => {
    for (const t of WATCHED) expect(isForbiddenSalesTable(t)).toBe(false);
  });

  it('holds: the specification declares no authoritative balance column on either relation', () => {
    expect(findAuthoritativeSalesColumns(SPEC, WATCHED)).toEqual([]);
  });

  it('NON-COINCIDENCE: the legitimate columns are not flagged, and the forbidden ones are', () => {
    // If this arm were missing, proof 7 could be passing because the
    // predicate flags nothing at all.
    for (const ok of [
      'down_payment_minor',
      'down_payment_due_date',
      'installment_count',
      'amount_txn_minor',
      'due_date',
      'seq_no',
      'status',
      'plan_id',
    ]) {
      expect(isAuthoritativeSalesColumn(ok)).toBe(false);
    }
    for (const bad of [
      'outstanding_minor',
      'settled_minor',
      'collected_minor',
      'paid_minor',
      'balance_minor',
      'due_minor',
      'overdue_minor',
      'aging_minor',
      'allocated_minor',
    ]) {
      expect(isAuthoritativeSalesColumn(bad)).toBe(true);
    }
  });

  it('FIRES under its mutation: the two columns P4-AL-06 names planted into the specification', () => {
    const planted = SPEC.replace(
      /  amount_txn_minor BIGINT NOT NULL CHECK \(amount_txn_minor >= 1\),/,
      '  amount_txn_minor BIGINT NOT NULL CHECK (amount_txn_minor >= 1),\n  outstanding_minor BIGINT NOT NULL DEFAULT 0,\n  settled_minor    BIGINT NOT NULL DEFAULT 0,',
    );
    expect(planted).not.toBe(SPEC); // the mutation really applied
    expect(findAuthoritativeSalesColumns(planted, WATCHED)).toEqual([
      { table: 'installments', column: 'outstanding_minor' },
      { table: 'installments', column: 'settled_minor' },
    ]);
  });

  it('FIRES under its mutation: a plan-level remaining added by ALTER', () => {
    const planted = `${SPEC}\nALTER TABLE installment_plans ADD COLUMN outstanding_txn_minor BIGINT NOT NULL DEFAULT 0;\n`;
    expect(findAuthoritativeSalesColumns(planted, WATCHED)).toEqual([
      { table: 'installment_plans', column: 'outstanding_txn_minor' },
    ]);
  });

  it('the reference model carries no plan-local balance either, and names the one field it refuses', () => {
    // `planLocalCollectedMinor` exists ONLY so proof 5 can mutate into it,
    // and proof 5 asserts the correct path never reads it.
    expect(Object.keys(PLAN)).not.toContain('planLocalCollectedMinor');
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 8 [proof_8] — the clock guard, widened and red-capable (p_as_of is the protection, not IMMUTABLE)', () => {
  // The previous round MEASURED that a function declared `IMMUTABLE` may read
  // `CURRENT_DATE` and PostgreSQL will accept it, because the label is
  // trusted and the body is never read. So the guard below never consults a
  // volatility label: it reads the BODY for financial time functions.
  const FINANCIAL_TIME =
    /\b(current_date|current_time|current_timestamp|localtime|localtimestamp|now|transaction_timestamp|statement_timestamp|clock_timestamp|timeofday)\b/i;

  /** The body of one routine, by name, from a migration text. */
  function routineBody(sql: string, header: string): string {
    const at = sql.indexOf(header);
    expect(at).toBeGreaterThan(-1);
    const open = sql.indexOf('$fn$', at);
    const close = sql.indexOf('$fn$', open + 4);
    return sql.slice(open + 4, close);
  }

  it('the SHIPPED aging routine reads p_as_of and no clock — the previous round diagnosis was wrong and is not reopened', () => {
    const shipped = readFileSync(SHIPPED_AGING_PATH, 'utf8');
    const body = routineBody(
      shipped,
      'CREATE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])',
    );
    expect(body).toMatch(/p_as_of/);
    expect(FINANCIAL_TIME.test(body)).toBe(false);
  });

  it('the specification asks for no IMMUTABLE label and reads no clock in the projection it specifies', () => {
    // THE SUBJECT IS EXECUTABLE SQL, NOT THE SKETCH'S OWN PROSE. This caught
    // itself a THIRD time: the sketch's inline comments say «NEVER
    // `outstanding - sum(alloc)`» and «the reference model now agrees», and
    // the bare-`sum(` and `\bnow\b` guards both fired on those sentences.
    // Same lesson as proofs 6 and 8 in round 1, one level deeper — a guard
    // over SQL must read SQL. Recorded rather than quietly fixed, because the
    // next author will write the same prose.
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    // The subject is real and substantial, not an empty slice that would pass
    // any guard. It is now REAL function DDL rather than a commented sketch
    // (challenger C-2), so the guard reads the SQL that will be transcribed.
    expect(sketch).toMatch(/CREATE OR REPLACE FUNCTION customer_ar_aging/);
    expect(sketch).toMatch(/WITH open_invoice AS \(/);
    expect(sketch).toMatch(/public\.invoice_outstanding\(/);
    expect(sketch).toMatch(/p_as_of/);
    expect(sketch.split('\n').length).toBeGreaterThan(40);
    expect(FINANCIAL_TIME.test(sketch)).toBe(false);
  });

  it('L-15: the IMMUTABLE arm has a REAL subject now — the spec declares a volatility and it is STABLE', () => {
    // The first round asserted `not.toMatch(/LANGUAGE\s+sql\s+IMMUTABLE/)`
    // over a file containing `LANGUAGE` zero times: a negative assertion over
    // an absent subject, inside the very proof whose job is to show
    // `IMMUTABLE` is not leaned on (challenger L-15). The specification now
    // carries real function DDL, so the subject exists and is asserted
    // POSITIVELY first.
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    expect(sketch).toMatch(/LANGUAGE\s+sql\s+STABLE\b/); // the subject exists
    expect(sketch).not.toMatch(/\bIMMUTABLE\b/); // and it is not that
    // The signature really is unchanged, which is what makes CREATE OR
    // REPLACE legal: all five shipped columns, in order (challenger C-2).
    expect(sketch).toMatch(
      /RETURNS TABLE \(bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER\)/,
    );
    const shipped = readFileSync(SHIPPED_AGING_PATH, 'utf8');
    expect(shipped).toMatch(
      /RETURNS TABLE \(bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER\)/,
    );
  });

  it('C-2: the specification CANNOT be transcribed while base is unallocated, and the block is structural', () => {
    // Not a sentence asking a reader to remember: the body carries a token
    // that is not valid SQL, and `LANGUAGE sql` bodies are parsed at CREATE
    // time, so the definition cannot be applied by accident.
    expect(sqlSchemaOnly(projectionSketch(SPEC))).toMatch(/__OWED_BASE_ALLOCATION__ AS base_minor/);
    expect(SPEC).toMatch(/THIS SLICE CANNOT SHIP AS IT STANDS/);
    // And the DDL a migration owner needs really is here now — `LANGUAGE`,
    // `RETURNS`, `GRANT`, `REVOKE` each appeared ZERO times in the first
    // round, so there was no function DDL to transcribe at all.
    for (const token of ['LANGUAGE', 'RETURNS TABLE', 'GRANT EXECUTE', 'REVOKE ALL', 'COMMENT ON FUNCTION']) {
      expect(SPEC, `the spec has no ${token}`).toContain(token);
    }
  });

  it('M-12: the projection reads currency and due date OFF THE CALL, and joins invoices back on nowhere', () => {
    // `0084:593-596` appended `currency_code, due_date` to
    // `invoice_outstanding` precisely so the AR readers stop joining
    // `invoices` back onto the call; the first round's sketch joined it back
    // on and undid a measured optimisation on the `P4-D` path.
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    expect(sketch).toMatch(/SELECT o\.invoice_id, o\.currency_code, o\.due_date, o\.outstanding_txn_minor/);
    expect(sketch).not.toMatch(/JOIN\s+public\.invoices/i);
    // The shipped routine does the same, which is the precedent.
    expect(readFileSync(SHIPPED_AGING_PATH, 'utf8')).toMatch(/o\.due_date IS NOT NULL/);
    // The only `public.invoices` reference is the id list, as shipped.
    expect([...sketch.matchAll(/public\.invoices\b/g)]).toHaveLength(1);
  });

  it('L-16: catalogue functions are pg_catalog-qualified, as every shipped AR routine qualifies them', () => {
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    for (const fn of ['sum', 'count', 'unnest', 'array_agg', 'max', 'coalesce']) {
      const bare = new RegExp(`(?<![.\\w])${fn}\\s*\\(`, 'g');
      expect([...sketch.matchAll(bare)], `bare ${fn}( is unqualified`).toHaveLength(0);
      expect(sketch, `${fn} is never used`).toContain(`pg_catalog.${fn}(`);
    }
  });

  it('NON-COINCIDENCE: a DEFAULT now() audit stamp is not a financial time read, and the guard says so', () => {
    // The specification's DDL does carry `created_at ... DEFAULT now()`, as
    // every accepted Phase 4 relation does. That is a row-creation stamp and
    // not a figure the aging reads, so the law is scoped to the PROJECTION
    // and the DDL arm is asserted separately: the only clock use in the
    // schema is a DEFAULT on an `_at` column.
    const schema = sqlSchemaOnly(SPEC);
    expect(schema).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    const clockLines = schema.split('\n').filter((l) => FINANCIAL_TIME.test(l));
    expect(clockLines.length).toBeGreaterThan(0);
    for (const l of clockLines) expect(l).toMatch(/_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  });

  it('FIRES under its mutation: a clock read planted into the projection, and IMMUTABLE does not save it', () => {
    const planted = 'SELECT 1 + count(*) FROM unnest(p_bucket_days) t WHERE (CURRENT_DATE - c.bucket_date) > t.threshold';
    expect(FINANCIAL_TIME.test(planted)).toBe(true);
    // And the label is explicitly NOT the guard: a body that reads the clock
    // is caught whatever it is labelled.
    const labelled = `CREATE FUNCTION f() RETURNS DATE LANGUAGE sql IMMUTABLE AS $fn$ SELECT CURRENT_DATE $fn$;`;
    expect(FINANCIAL_TIME.test(labelled)).toBe(true);
  });

  it('NON-COINCIDENCE: a column or parameter that merely contains a time word is not a clock read', () => {
    for (const ok of ['p_as_of', 'due_date', 'rate_timestamp', 'created_at', 'down_payment_due_date']) {
      expect(FINANCIAL_TIME.test(ok)).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 9 [proof_9] — a broken sum law is SIGNALLED in both directions, not absorbed silently', () => {
  // Challenger M-11. The projection must total the authoritative outstanding
  // whatever the data says, which is right for proofs 1 and 4 and leaves a
  // hole: UNDER-scheduled surfaces as a non-zero residual, OVER-scheduled
  // surfaces as nothing at all.

  it('the over-scheduled case really does report a fully overdue receivable as not yet due', () => {
    // Reproduced from the challenger's PROBE D, as a permanent fixture so the
    // behaviour cannot drift back to being undocumented.
    const c = projectInvoice(OVER_SCHEDULED_INVOICE, OVER_SCHEDULED_PLAN, AS_OF, THRESHOLDS);
    expect(c.map((x) => [x.origin, x.seqNo, x.scheduleDate, x.bucketNo, x.txnMinor])).toEqual([
      ['installment', 2, '2027-01-15', 1, 900_000n],
    ]);
    // Instalment 1 — 900 000, due 2026-01-15, 265 days before as-of — got
    // nothing, because the declared oldest-first policy deems the implied
    // payment to have settled it. The merchant sees ZERO overdue.
    expect(sum(c.filter((x) => x.bucketNo > 1))).toBe(0n);
    expect(epochDay(AS_OF) - epochDay('2026-01-15')).toBe(265);
    // And every one of the seven laws still holds, which is exactly why a
    // law over the projection's own output cannot catch this.
    expect(sum(c)).toBe(OVER_SCHEDULED_INVOICE.outstandingTxnMinor);
  });

  it('and it CANNOT be detected from the outstanding figure alone — which is why the signal reads the authoritative pair', () => {
    // `Σ schedule = 1 800 000` with `O = 900 000` is indistinguishable from a
    // legitimate plan half paid. Same schedule, same outstanding, different
    // `paid`: one is a violation and one is not.
    const legitimate: OpenInvoiceRow = { ...OVER_SCHEDULED_INVOICE, invoiceId: 'inv-ok', paidTxnMinor: 900_000n };
    const legitimatePlan: InstallmentPlan = { ...OVER_SCHEDULED_PLAN, invoiceId: 'inv-ok' };
    expect(legitimate.outstandingTxnMinor).toBe(OVER_SCHEDULED_INVOICE.outstandingTxnMinor);
    expect(scheduleCoherenceFindings([legitimate], [legitimatePlan])).toEqual([]);
    expect(scheduleCoherenceFindings([OVER_SCHEDULED_INVOICE], [OVER_SCHEDULED_PLAN])).toEqual([
      { invoiceId: 'inv-over', kind: 'over_scheduled', excessTxnMinor: 900_000n },
    ]);
  });

  it('the signal is clean on a well-formed plan, so it is not simply always firing', () => {
    // NON-VACUITY, the other way round: the design fixture obeys the sum law
    // (`300 000 paid + 900 000 outstanding = 1 200 000 = 12 x 100 000`).
    expect(PLANNED_INVOICE.paidTxnMinor + PLANNED_INVOICE.outstandingTxnMinor).toBe(1_200_000n);
    expect(scheduleCoherenceFindings([PLANNED_INVOICE], [PLAN])).toEqual([]);
    // And an invoice with no plan is not judged at all.
    expect(scheduleCoherenceFindings([PLAINLESS_INVOICE], [])).toEqual([]);
  });

  it('the ALLOCATION never reads `paid` — counted, so the signal cannot leak into the money', () => {
    let reads = 0;
    const row = { ...PLANNED_INVOICE } as Record<string, unknown>;
    Object.defineProperty(row, 'paidTxnMinor', {
      get: () => {
        reads += 1;
        return 300_000n;
      },
      enumerable: true,
    });
    projectInvoice(row as unknown as OpenInvoiceRow, PLAN, AS_OF, THRESHOLDS);
    expect(reads).toBe(0);
    // ...and the signal does read it, so the counter is live.
    scheduleCoherenceFindings([row as unknown as OpenInvoiceRow], [PLAN]);
    expect(reads).toBeGreaterThan(0);
  });

  it('the DECLARED schedule that has fallen due is read from the plan, never from the projection', () => {
    expect(scheduledDueBy(PLAN, AS_OF)).toBe(900_000n); // Jan..Sep, down payment 0
    expect(scheduledDueBy(OVER_SCHEDULED_PLAN, AS_OF)).toBe(900_000n); // instalment 1 only
    expect(scheduledDueBy(SHORT_PLAN, AS_OF)).toBe(0n); // both instalments future
  });

  it('the real repair is in the DDL: a DEFERRED verifier makes both directions unreachable at commit', () => {
    expect(SPEC).toMatch(/installment_plans_schedule_complete/);
    expect(SPEC).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    expect(SPEC).toMatch(/R-SAL-06/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('META — the proofs are not vacuous', () => {
  it('meta_1: every knob has a proof that exercises its defective value, AND that proof exists in this file', () => {
    // The first round wrote `proof:` five times and read it zero times, so
    // deleting every "FIRES under its mutation" block left both meta tests
    // green (challenger H-4). The field is now READ, and read against this
    // file's own source, so a law with no proof behind it cannot pass.
    const exercised = new Map(MUTATIONS_EXERCISED.map((m) => [m.knob, m.to]));
    for (const k of POLICY_KNOBS) {
      expect(exercised.has(k.knob), `knob ${k.knob} has no proof`).toBe(true);
      expect(k.defective).toContain(exercised.get(k.knob));
    }
    const known = new Set(POLICY_KNOBS.map((k) => k.knob));
    for (const m of MUTATIONS_EXERCISED) expect(known.has(m.knob)).toBe(true);
    expect(MUTATIONS_EXERCISED.length).toBe(POLICY_KNOBS.length);

    // (a) THE `proof` FIELD IS READ: each named proof must exist as a tagged
    //     `describe` in this file. A renamed or deleted proof turns this red.
    for (const m of MUTATIONS_EXERCISED) {
      expect(SELF, `no describe tagged [${m.proof}]`).toContain(`[${m.proof}]`);
    }

    // (b) EACH KNOB IS ACTUALLY MUTATED SOMEWHERE IN THIS FILE. Deleting the
    //     "FIRES under its mutation" blocks removes these call sites and this
    //     assertion goes red — which is exactly what the challenger showed the
    //     first version could not do.
    for (const k of POLICY_KNOBS) {
      expect(SELF, `knob ${k.knob} is never passed to mutate()`).toContain(`mutate('${k.knob}'`);
    }

    // (c) AND NO MORE KNOBS ARE MUTATED THAN ARE REGISTERED, so a knob
    //     exercised without being declared is caught too.
    const mutatedInSource = new Set([...SELF.matchAll(/mutate\('([A-Za-z]+)'/g)].map((x) => x[1] as string));
    expect([...mutatedInSource].sort()).toEqual([...known].sort());

    // (d) Every proof claims a DISTINCT knob, so one proof cannot stand in
    //     for the whole registry.
    expect(new Set(MUTATIONS_EXERCISED.map((m) => m.knob)).size).toBe(MUTATIONS_EXERCISED.length);
  });

  it('meta_2: every mutation actually CHANGES the output — an inert mutation proves nothing', () => {
    const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE];
    const plans = [PLAN, SHORT_PLAN];
    const baseline = JSON.stringify(
      projectCustomerAging(rows, plans, AS_OF, THRESHOLDS).map((b) => [b.bucketNo, b.currencyCode, String(b.txnMinor), b.invoiceCount]),
    );
    for (const m of MUTATIONS_EXERCISED) {
      const plan5 = m.knob === 'outstandingSource' ? [{ ...PLAN, planLocalCollectedMinor: 300_000n }, SHORT_PLAN] : plans;
      const got = JSON.stringify(
        projectCustomerAging(rows, plan5, AS_OF, THRESHOLDS, mutate(m.knob, m.to)).map((b) => [
          b.bucketNo,
          b.currencyCode,
          String(b.txnMinor),
          b.invoiceCount,
        ]),
      );
      expect(got, `mutation ${m.knob} -> ${String(m.to)} was inert`).not.toBe(baseline);
    }
  });

  it('meta_3: the correct policy is the one the model ships, and nothing silently differs', () => {
    // Every DEFECT knob is at its correct value, and the DECLARED POLICY is
    // at the ruled one. Both halves, so neither a silently flipped defect
    // knob nor a silently changed convention can pass.
    expect(CORRECT_POLICY).toEqual({
      ...Object.fromEntries(POLICY_KNOBS.map((k) => [k.knob, k.correct])),
      settlementOrder: DECLARED_SETTLEMENT_ORDER,
    });
  });

  it('meta_4: DETERMINISM — the answer does not depend on the order the schedule or the invoices arrive in', () => {
    const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE];
    const expected = projectCustomerAging(rows, [PLAN, SHORT_PLAN], AS_OF, THRESHOLDS);
    const shuffledPlan: InstallmentPlan = { ...PLAN, installments: [...SCHEDULE].reverse() };
    expect(projectCustomerAging([...rows].reverse(), [SHORT_PLAN, shuffledPlan], AS_OF, THRESHOLDS)).toEqual(expected);
    // Two instalments on the SAME date: `seq_no` breaks the tie, so the
    // allocation is still a total order and still deterministic.
    const tied: InstallmentPlan = {
      invoiceId: 'inv-tie',
      status: 'active',
      downPaymentMinor: 0n,
      downPaymentDueDate: '2026-01-01',
      installments: [
        { seqNo: 1, dueDate: '2026-03-01', amountTxnMinor: 60_000n },
        { seqNo: 2, dueDate: '2026-03-01', amountTxnMinor: 40_000n },
      ],
    };
    const tiedRow: OpenInvoiceRow = { invoiceId: 'inv-tie', currencyCode: 'SAR', dueDate: '2026-03-01', outstandingTxnMinor: 50_000n };
    const a = projectInvoice(tiedRow, tied, AS_OF, THRESHOLDS);
    const b = projectInvoice(tiedRow, { ...tied, installments: [...tied.installments].reverse() }, AS_OF, THRESHOLDS);
    expect(a).toEqual(b);
    // seq 2 is the later row, so it absorbs the outstanding first.
    expect(a.map((x) => [x.seqNo, x.txnMinor])).toEqual([
      [1, 10_000n],
      [2, 40_000n],
    ]);
  });

  it('meta_5: the allocation performs ZERO roundings — every figure is an exact integer of minor units', () => {
    // There is no division, no ratio and no proration anywhere in the model,
    // so this is checkable by construction: the source contains no `/`
    // arithmetic over money and no rounding call.
    const model = readFileSync(join(__dirname, 'phase4-s7-aging-reference-model.ts'), 'utf8');
    const strip = (src: string): string =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
        .join('\n');

    // THE ALLOCATION. The subject is `projectInvoice`'s body — the function
    // that turns an authoritative outstanding into per-bucket amounts — and
    // not the whole file, because the whole file also converts DATES.
    const from = model.indexOf('export function projectInvoice(');
    const to = model.indexOf('/** One aggregated bucket');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const allocation = strip(model.slice(from, to));
    expect(allocation).toMatch(/suffixAfter/); // the subject is really the allocation
    expect(allocation).not.toMatch(/Math\.(round|floor|ceil|trunc)/);
    expect(allocation).not.toMatch(/\btoFixed\b/);
    expect(allocation).not.toMatch(/Number\(/);
    // No division at all over money: there is no ratio, no proration and so
    // no residue to distribute and no quotient to round.
    expect([...allocation.matchAll(/[^*/\n]\/[^*/\n]/g)].map((m) => m[0])).toEqual([]);

    // The ONE rounding in the file, stated rather than hidden: `epochDay`
    // normalises a civil date to whole days. It rounds a DATE and never an
    // amount, and `Date.UTC` of a date-only triple is already an exact
    // multiple of 86_400_000, so it is defensive and not load-bearing.
    const dateFrom = model.indexOf('export function epochDay(');
    const dateTo = model.indexOf('export function bucketOf(');
    const dateCode = strip(model.slice(dateFrom, dateTo));
    expect(dateCode).toMatch(/Math\.round\(ms \/ 86_400_000\)/);
    const allRoundings = [...strip(model).matchAll(/Math\.(round|floor|ceil|trunc)/g)];
    expect(allRoundings.length).toBe(1);
    // Every amount the projection emits is a bigint, so no float can enter.
    const emitted = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS);
    for (const c of emitted) expect(typeof c.txnMinor).toBe('bigint');
  });

  it('meta_6: CONVENTION-INDEPENDENCE — every money law holds under BOTH settlement orders', () => {
    // The claim «the seven proofs hold under either convention» is the reason
    // the settlement order can be a DECLARED POLICY rather than a derivation
    // (coordinator ruling 1). It is asserted here rather than stated, so that
    // overturning the ruling is a one-constant change whose proofs still run.
    const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE];
    const plans = [PLAN, SHORT_PLAN];
    const authoritative = rows.reduce((a, r) => a + r.outstandingTxnMinor, 0n);

    expect(SETTLEMENT_ORDERS.length).toBe(2);
    for (const order of SETTLEMENT_ORDERS) {
      const policy = { ...CORRECT_POLICY, settlementOrder: order };
      const c = contributionsFor(rows, plans, AS_OF, THRESHOLDS, policy);
      const where = `settlementOrder=${order}`;

      // PROOF 1 — the buckets total the authoritative outstanding.
      expect(sum(c), where).toBe(authoritative);
      for (const r of rows) {
        const plan = plans.find((p) => p.invoiceId === r.invoiceId);
        expect(sum(projectInvoice(r, plan, AS_OF, THRESHOLDS, policy)), where).toBe(r.outstandingTxnMinor);
      }

      // PROOF 2 — no not-yet-due scheduled amount in an overdue bucket. This
      // holds under either order because a row is bucketed by ITS OWN date,
      // whichever rows the convention leaves outstanding.
      for (const x of c) {
        if (x.scheduleDate !== null && epochDay(x.scheduleDate) >= epochDay(AS_OF)) {
          expect(x.bucketNo, where).toBe(1);
        }
      }

      // PROOF 3 — nothing counted twice: the keys stay unique and the arms
      // stay a partition.
      const keys = c.map((x) => `${x.invoiceId}|${x.origin}|${String(x.seqNo)}`);
      expect(new Set(keys).size, where).toBe(keys.length);
      const planned = new Set(plans.map((p) => p.invoiceId));
      for (const x of c) if (planned.has(x.invoiceId)) expect(x.origin, where).not.toBe('whole_invoice');

      // PROOF 4 — nothing disappears, including the broken sum law.
      expect(sum(c.filter((x) => x.invoiceId === 'inv-short')), where).toBe(1_000_000n);
      expect(sum(c.filter((x) => x.origin === 'residual')), where).toBe(800_000n);
    }

    // And the two conventions really are DIFFERENT, so this is not two runs
    // of one thing: under newest-first the outstanding sits on the OLDEST
    // instalments instead of the newest.
    const oldestFirst = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS, {
      ...CORRECT_POLICY,
      settlementOrder: 'oldest_scheduled_first',
    });
    const newestFirst = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS, {
      ...CORRECT_POLICY,
      settlementOrder: 'newest_scheduled_first',
    });
    expect(oldestFirst.filter((x) => x.origin === 'installment').map((x) => x.seqNo)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(newestFirst.filter((x) => x.origin === 'installment').map((x) => x.seqNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Which is exactly reason 3 of the ruling, measured: the declared order
    // reports LESS delinquency than the alternative.
    const overdue = (x: readonly AgingContribution[]): bigint => sum(x.filter((y) => y.bucketNo > 1));
    expect(overdue(oldestFirst)).toBeLessThan(overdue(newestFirst));
  });

  it('meta_7: the declared policy is declared, and the defect registry cannot grow an unevaluable knob', () => {
    // The ruling's constant is the one place the convention lives.
    expect(DECLARED_SETTLEMENT_ORDER).toBe('oldest_scheduled_first');
    expect(CORRECT_POLICY.settlementOrder).toBe(DECLARED_SETTLEMENT_ORDER);

    // `settlementOrder` is EXCLUDED from the defect registry on purpose,
    // because its other value is a legitimate convention and not a defect.
    // The exclusion is asserted so it reads as deliberate rather than as an
    // omission, and `meta_6` is what earns it.
    const defectKnobs = POLICY_KNOBS.map((k) => k.knob);
    expect(defectKnobs).not.toContain('settlementOrder');

    // Every knob in the registry HAS a defective value. A knob added later
    // with an empty defective list is an exemption that can never be
    // evaluated, so it fails here rather than passing silently.
    for (const k of POLICY_KNOBS) {
      expect(k.defective.length, `knob ${k.knob} has no defective value`).toBeGreaterThan(0);
      expect(k.defective, `knob ${k.knob} lists its correct value as defective`).not.toContain(k.correct);
    }

    // And the registry covers every field of the policy record except the
    // declared policy, so a NEW field cannot be added without either a
    // defective value or a deliberate, asserted exclusion.
    const policyFields = Object.keys(CORRECT_POLICY).sort();
    expect(policyFields).toEqual([...defectKnobs, 'settlementOrder'].sort());
  });
});
