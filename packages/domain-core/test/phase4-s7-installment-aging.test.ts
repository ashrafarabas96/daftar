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
 *  (3) «a law whose subject is a textual coincidence.» Proofs 6, 7 and 8 run
 *      the ESTATE'S OWN predicates
 *      (`scripts/guards/no-authoritative-balance.ts`) over the real
 *      specification file and the real shipped migration, never a regex
 *      invented here; and each carries a NON-COINCIDENCE arm asserting that
 *      the legitimate columns and the legitimate SQL are NOT flagged — so
 *      `due_date`, `down_payment_minor` and `installment_count` passing is
 *      part of the proof, not an assumption.
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
import { readFileSync } from 'node:fs';
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
  contributionsFor,
  CORRECT_POLICY,
  epochDay,
  POLICY_KNOBS,
  projectCustomerAging,
  projectInvoice,
  type AgingContribution,
  type InstallmentPlan,
  type OpenInvoiceRow,
  type ProjectionPolicy,
} from './phase4-s7-aging-reference-model';

const REPO = join(__dirname, '..', '..', '..');
const SPEC_PATH = join(REPO, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');
const ONE_DEFINITION_PATH = join(REPO, 'infrastructure', 'database', 'migrations', '0083_phase4_ar_outstanding_set_based.sql');
const SHIPPED_AGING_PATH = join(REPO, 'infrastructure', 'database', 'migrations', '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');

const SPEC = readFileSync(SPEC_PATH, 'utf8');
const ONE_DEFINITION = readFileSync(ONE_DEFINITION_PATH, 'utf8');

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
describe('PROOF 1 — the sum of the aging buckets equals the authoritative invoice outstanding', () => {
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
describe('PROOF 2 — no not-yet-due scheduled amount enters an overdue bucket', () => {
  // The SUBJECT is each contribution's own schedule date against `p_as_of`.
  // Bucket 1 is the non-overdue bucket because every threshold is >= 1
  // (`validateAgingBucketDays`, `packages/domain-core/src/invoice.ts:158`),
  // so `(as_of - date) > t` is false for a date at or after `as_of`.
  const notYetDue = (c: AgingContribution): boolean =>
    c.scheduleDate !== null && epochDay(c.scheduleDate) >= epochDay(AS_OF);

  it('every threshold the aging validator admits is at least 1, which is what makes bucket 1 the non-overdue bucket', () => {
    expect(Math.min(...THRESHOLDS)).toBeGreaterThanOrEqual(1);
    expect(bucketOf(AS_OF, AS_OF, THRESHOLDS)).toBe(1);
    expect(bucketOf(AS_OF, '2027-01-01', THRESHOLDS)).toBe(1);
  });

  it('holds: not-yet-due money is in bucket 1 and nowhere else', () => {
    const c = contributionsFor([PLANNED_INVOICE, SHORT_SCHEDULE_INVOICE], [PLAN, SHORT_PLAN], AS_OF, THRESHOLDS);
    const future = c.filter(notYetDue);
    expect(future.length).toBeGreaterThan(0); // the arm is not vacuous
    for (const f of future) expect(f.bucketNo).toBe(1);
    // And the amount is the real one: Oct/Nov/Dec of the plan plus both
    // instalments of the short plan.
    expect(sum(future)).toBe(500_000n);
  });

  it('FIRES under its mutation: bucketing by the invoice due date instead of the schedule date', () => {
    const c = contributionsFor(
      [PLANNED_INVOICE],
      [PLAN],
      AS_OF,
      THRESHOLDS,
      mutate('bucketBy', 'invoice_due_date'),
    );
    // Under the mutation the schedule dates are gone from the output, so the
    // law is re-asserted over the money that IS not yet due: 3,000.00 of
    // instalments dated after 2026-10-07.
    const notYetDueAmount = SCHEDULE.filter((s) => epochDay(s.dueDate) >= epochDay(AS_OF)).reduce(
      (a, s) => a + s.amountTxnMinor,
      0n,
    );
    expect(notYetDueAmount).toBe(300_000n);
    const overdueBuckets = c.filter((x) => x.bucketNo > 1);
    expect(sum(overdueBuckets)).toBe(900_000n);
    // 3,000.00 that has not fallen due is sitting in an overdue bucket.
    expect(sum(overdueBuckets)).toBeGreaterThanOrEqual(notYetDueAmount);
    expect(c.every((x) => x.bucketNo === 4)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 3 — no amount is counted twice', () => {
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
describe('PROOF 4 — no amount disappears', () => {
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

  it('the closed-form allocation agrees with an INDEPENDENT oldest-first simulation, over randomised schedules', () => {
    // A second implementation, written as a loop with an accumulator rather
    // than as a closed form. Agreement between two structurally different
    // implementations is not a comparison of an expression with itself.
    let rng = 0x9e3779b9;
    const next = (n: number): number => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng % n;
    };
    for (let trial = 0; trial < 400; trial += 1) {
      const n = 1 + next(14);
      const inst = Array.from({ length: n }, (_, k) => ({
        seqNo: k + 1,
        dueDate: `2026-${String(1 + next(12)).padStart(2, '0')}-${String(1 + next(28)).padStart(2, '0')}`,
        amountTxnMinor: BigInt(1 + next(90_000)),
      }));
      const down = BigInt(next(50_000));
      const total = down + inst.reduce((a, i) => a + i.amountTxnMinor, 0n);
      const O = BigInt(next(Number(total) + 40_000) - 10_000);
      const row: OpenInvoiceRow = { invoiceId: 'r', currencyCode: 'SAR', dueDate: '2026-06-01', outstandingTxnMinor: O };
      const plan: InstallmentPlan = {
        invoiceId: 'r',
        status: 'active',
        downPaymentMinor: down,
        downPaymentDueDate: '2026-01-02',
        installments: inst,
      };

      // The independent simulation: fill the LATEST row first.
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
      const simResidual = O - ((O > 0n ? O : 0n) - rem);

      const got = projectInvoice(row, plan, AS_OF, THRESHOLDS);
      const gotAlloc = new Map(got.filter((x) => x.origin !== 'residual').map((x) => [x.seqNo as number, x.txnMinor]));
      expect([...gotAlloc.entries()].sort((a, b) => a[0] - b[0])).toEqual(
        [...simAlloc.entries()].sort((a, b) => a[0] - b[0]),
      );
      expect(sum(got.filter((x) => x.origin === 'residual'))).toBe(simResidual);
      // And nothing is lost, on every one of the 400 shapes.
      expect(sum(got)).toBe(O);
    }
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
describe('PROOF 5 — a payment or a reversal changes the projection THROUGH the existing invoice settlement truth', () => {
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
describe('PROOF 6 — no installment journal', () => {
  // The SUBJECT is two real texts: the specification's own DDL, and the
  // shipped ONE DEFINITION of the settlement sum. Not a sentence about them.

  /** The reducer relations the one definition actually reads, discovered. */
  function reducerBranches(sql: string): string[] {
    const body = sql.slice(sql.indexOf('CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])'));
    const end = body.indexOf('REVOKE ALL ON FUNCTION invoice_outstanding(UUID, UUID[])');
    const inner = body.slice(0, end === -1 ? undefined : end);
    return [...inner.matchAll(/FROM\s+public\.([a-z_][a-z0-9_]*)\s+[a-z]\b/gi)]
      .map((m) => (m[1] as string).toLowerCase())
      .filter((t) => t !== 'invoices' && t !== 'sales')
      .filter((t, i, xs) => xs.indexOf(t) === i)
      .sort();
  }

  /** Does this SQL text create a journal-bearing relation? */
  function journalFindings(raw: string): string[] {
    const sql = sqlSchemaOnly(raw);
    const f: string[] = [];
    if (/accounting_source_type/i.test(sql)) f.push('declares an accounting_source_type');
    if (/INSERT\s+INTO\s+accounting_source_bindings/i.test(sql)) f.push('registers an accounting source binding');
    if (/INSERT\s+INTO\s+journal_(entries|lines)/i.test(sql)) f.push('posts a journal entry');
    for (const t of discoverSalesTables(sql)) if (/journal/.test(t)) f.push(`creates a journal relation: ${t}`);
    return f;
  }

  it('the one definition reads exactly the two accepted reducers, and S7 appends nothing', () => {
    expect(reducerBranches(ONE_DEFINITION)).toEqual(['customer_credit_applications', 'payment_allocations']);
    // And the specification does not redefine it at all.
    expect(SPEC).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+invoice_outstanding/i);
  });

  it('the specification creates installment_plans and installments, and neither is journal-bearing', () => {
    expect(discoverSalesTables(SPEC).sort()).toEqual(['installment_plans', 'installments']);
    expect(journalFindings(SPEC)).toEqual([]);
  });

  it('NON-COINCIDENCE: the checker flags the construct and not the word', () => {
    // The specification NAMES `accounting_source_type`,
    // `accounting_source_bindings` and the journal in prose, in order to
    // refuse them. A law whose subject were the text would flag it for that.
    expect(SPEC).toMatch(/accounting_source_type/);
    expect(SPEC).toMatch(/accounting_source_bindings/);
    expect(SPEC).toMatch(/journal/i);
    // The schema says none of it.
    expect(sqlSchemaOnly(SPEC)).not.toMatch(/accounting_source_type/);
    expect(journalFindings(SPEC)).toEqual([]);
    // And the stripper is not simply emptying the file: the DDL survives.
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

  it('FIRES under its mutation: a UNION ALL branch appended to the one definition', () => {
    const planted = ONE_DEFINITION.replace(
      /             WHERE c\.business_id = p_business_id AND c\.invoice_id = ANY\(p_invoice_ids\)\n/,
      `             WHERE c.business_id = p_business_id AND c.invoice_id = ANY(p_invoice_ids)
            UNION ALL
            SELECT n.invoice_id AS invoice_id, n.amount AS amount, n.rel AS rel
              FROM public.installment_collections n
             WHERE n.business_id = p_business_id AND n.invoice_id = ANY(p_invoice_ids)\n`,
    );
    expect(planted).not.toBe(ONE_DEFINITION); // the mutation really applied
    expect(reducerBranches(planted)).toEqual([
      'customer_credit_applications',
      'installment_collections',
      'payment_allocations',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 7 — no stored installment outstanding', () => {
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
describe('PROOF 8 — the clock guard, widened and red-capable (p_as_of is the protection, not IMMUTABLE)', () => {
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
    const sketch = projectionSketch(SPEC);
    // The subject is real and substantial, not an empty slice that would
    // pass any guard.
    expect(sketch).toMatch(/WITH open_invoice AS \(/);
    expect(sketch).toMatch(/invoice_outstanding\(p_business_id/);
    expect(sketch).toMatch(/p_as_of/);
    expect(sketch.split('\n').length).toBeGreaterThan(40);
    expect(FINANCIAL_TIME.test(sketch)).toBe(false);
    expect(SPEC).not.toMatch(/LANGUAGE\s+sql\s+IMMUTABLE/i);
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
describe('META — the proofs are not vacuous', () => {
  it('meta_1: every policy knob has a proof that exercises its defective value', () => {
    const exercised = new Map(MUTATIONS_EXERCISED.map((m) => [m.knob, m.to]));
    for (const k of POLICY_KNOBS) {
      expect(exercised.has(k.knob)).toBe(true);
      expect(k.defective).toContain(exercised.get(k.knob));
    }
    // ...and no proof claims a knob that does not exist.
    const known = new Set(POLICY_KNOBS.map((k) => k.knob));
    for (const m of MUTATIONS_EXERCISED) expect(known.has(m.knob)).toBe(true);
    expect(MUTATIONS_EXERCISED.length).toBe(POLICY_KNOBS.length);
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
    expect(CORRECT_POLICY).toEqual(
      Object.fromEntries(POLICY_KNOBS.map((k) => [k.knob, k.correct])),
    );
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
});
