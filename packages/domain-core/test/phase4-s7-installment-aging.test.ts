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
import { bodyDigests, declaredBodyDigests } from '../../../scripts/guards/p4s7-body-digests';
import { agingBucketLabels } from '../src/invoice';
import { apRelease } from '../../inventory/src/supplier-settlement';
import {
  aggregate,
  CANONICAL_RELEASE,
  bucketOf,
  DECLARED_SETTLEMENT_ORDER,
  SETTLEMENT_ORDERS,
  contributionsFor,
  CORRECT_POLICY,
  epochDay,
  POLICY_KNOBS,
  projectCustomerAging,
  projectInvoice,
  scheduledDueBy,
  type AgingContribution,
  type InstallmentPlan,
  type OpenInvoiceRow,
  type ProjectionPolicy,
  type ReleaseFn,
} from './phase4-s7-aging-reference-model';

const REPO = join(__dirname, '..', '..', '..');
const SPEC_PATH = join(REPO, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');
const MIGRATIONS_DIR = join(REPO, 'infrastructure', 'database', 'migrations');
const SHIPPED_AGING_PATH = join(MIGRATIONS_DIR, '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');

const SPEC = readFileSync(SPEC_PATH, 'utf8');
/**
 * THE ADOPTED ORACLE AND READER — the S7 proof engineer's module, consumed
 * rather than re-implemented.
 *
 * The coordinator's instruction was «adopt its reader and its oracle rather
 * than patching yours — it has measured recall over 17 forms and precision
 * over 11 decoys, and yours has four shapes that all spell `public.`». So:
 *
 *   * `bucketIndexByBand` replaces this file's use of `bucketOf` as proof 2's
 *     EXPECTED value. The old form asserted `x.bucketNo === bucketOf(...)`
 *     while the projection produced `bucketNo` BY CALLING `bucketOf` — over
 *     the banding the law said `f(x) === f(x)` and its refusal was
 *     unreachable. The band oracle is derived from `agingBucketLabels`, which
 *     is PRODUCT code, by interval containment: a different algorithmic path
 *     to the same answer.
 *   * `relationReferences` / `relationsTouched` replace `relationsRead`'s
 *     `public.`-qualified-only scan, which missed five legitimate SQL forms
 *     (unqualified, unqualified-unaliased, quoted identifiers, a space around
 *     the dot, and CTE wrapping) — and this file's own mutation matrix wrote
 *     `public.` in all four of its shapes, so the gap was UNTESTED rather
 *     than tested and tolerated.
 *   * `canonicalReducerRegistry` replaces `REDUCER_COLUMN`, which was an
 *     UNANCHORED substring: `bill_invoice_amount_applied_minor` would have
 *     made an unrelated relation an invoice reducer.
 *   * `lastEffectiveRoutineDefinition` replaces `liveDefinition`, whose
 *     dollar-tag selection took the first `$fn$` ANYWHERE later in the file
 *     and preferred `$fn$` even when a `$$` opened first. It was right today
 *     BY LUCK, and `0084` is the only Phase 4 migration using `$fn$`, so the
 *     luck was load-bearing.
 */
import type { MandatoryProof } from './phase4-s7-proof-oracles';
import {
  BUCKET_MUTANTS,
  INVOICE_REDUCER_COLUMN,
  ONE_SIDED_INVARIANTS,
  PURCHASE_REDUCER_COLUMN,
  bucketIndexByBand,
  bucketIndexByBinarySearch,
  auditProofFile,
  alterDropColumns,
  canonicalReducerRegistry,
  lastEffectiveRoutineDefinition,
  proofLedger,
  recordProof,
  relationsTouched,
  scheduleInvariantAccepts,
  scheduleInvariantVerdict,
  unpaidDuePortion,
} from './phase4-s7-proof-oracles';

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
function stripCommentsQuoteAware(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      // A single-quoted literal is DATA. A `--` inside it is two hyphens, not
      // a comment, and the old stripper ate the rest of the line INCLUDING
      // the closing quote -- which is the inversion this function exists to
      // refuse. The literal is copied through, quote doubling and all.
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (s[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (s[i] === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl; // the newline itself is kept
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * ONE LEXER, TWO SUBJECTS. Both extractors are projections of a SINGLE
 * left-to-right pass that knows where it is, because round 11's challenger
 * (F-8) showed that two independent regex passes cannot: `sqlSchemaOnly` used
 * to strip `--.*$` over the RAW file, before anything knew about quoting, so a
 * `--` planted inside a `COMMENT ... IS '...'` literal deleted that literal's
 * CLOSING QUOTE, and from that character on every literal and every stretch of
 * code in the file swapped places in `sqlCodeOnly`'s parse. The fault was not
 * that the strippers blanked too much; it was that they INVERTED, which can
 * turn a shipped law green over text that is not its subject.
 *
 * So quoting is decided first and comments second, never the other way round:
 *   - a dollar-quoted body is executable SQL, so it is kept, with comments
 *     stripped INSIDE it by the quote-aware stripper above;
 *   - a top-level single-quoted literal is data: blanked to `''` for a code
 *     law, passed through verbatim for a schema law;
 *   - `--` and block comments are removed only where the lexer is in neither.
 */
function lexSql(sql: string, blankLiterals: boolean): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (tag !== null) {
      const close = sql.indexOf(tag[0], i + tag[0].length);
      const stop = close === -1 ? sql.length : close + tag[0].length;
      out += stripCommentsQuoteAware(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += blankLiterals ? "''" : sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function sqlSchemaOnly(sql: string): string {
  return lexSql(sql, false);
}

/**
 * THE SUBJECT OF A CODE LAW IS CODE, AND A STRING LITERAL IS NOT CODE.
 *
 * THE FIFTH OCCURRENCE OF THE SAME LESSON, and it is kept in the file for the
 * same reason the coordinator kept the first: the next author will write the
 * same prose. Rounds 1 and 2 saw proofs 6 and 8 go red on the specification's
 * own `--` sentences (twice) and then on the sketch's inline comments. Round 3
 * saw it again from a new direction: `COMMENT ON FUNCTION ... IS '...'` is
 * REAL DDL, so `sqlSchemaOnly` correctly keeps it — and the documentation
 * string says «an invoice may now appear in SEVERAL buckets» and names
 * `source_to_base_rate` as metadata, which made the clock law and proof 10's
 * rate law both go red on a COMMENT.
 *
 * Ducking it by rewording the COMMENT would leave the trap armed. So the
 * subject is refined instead: single-quoted literals outside a dollar-quoted
 * body are DATA and are blanked, while the dollar-quoted function body — the
 * thing a code law is actually about — is passed through untouched.
 * `meta_8` proves this function is not simply deleting everything.
 */
function sqlCodeOnly(sql: string): string {
  return lexSql(sql, true);
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
/**
 * THE MANDATORY PROOF TABLE — the registry the meta gate READS.
 *
 * It is not prose and it is not a comment. Every field is consumed by
 * `auditProofFile` and by `meta_1a`'s ledger check, and `meta_9` proves each
 * way of hollowing a proof out is refused.
 *
 * WHY IT IS KEYED ON THE PROOF AND NOT ON THE KNOB. `MUTATIONS_EXERCISED` is
 * keyed on the policy knob, so proofs 6, 7, 8 and 9 — whose mutations are
 * planted into SQL text rather than reached through a knob — were outside
 * every meta law. Deleting proof 6 or proof 9 outright left the whole file
 * green. "Remove proof A" had no coverage for four of the seven required
 * proofs.
 *
 * `arms` IS DECLARED AND NOT COUNTED, because a proof with three red arms
 * that loses one is a proof that lost a mutation, and an auditor that read
 * only the first matching arm was measured green on exactly that.
 *
 * IF YOU RENAME AN `it` OR A TAG, UPDATE THIS TABLE IN THE SAME CHANGE. The
 * gate is fail-closed by design; a red here after a rename is the coupling
 * working, not a defect in the proof.
 */
const MANDATORY: readonly MandatoryProof[] = Object.freeze([
  Object.freeze({
    id: 'proof_1',
    armTitleContains: 'FIRES',
    arms: 2,
    requiresInArm: ["mutate('clampToRowAmount'"],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_2',
    armTitleContains: 'FIRES',
    arms: 3,
    requiresInArm: ["mutate('bucketBy'", 'BUCKET_MUTANTS'],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_3',
    armTitleContains: 'FIRES',
    arms: 1,
    requiresInArm: ["mutate('planlessArm'"],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_4',
    armTitleContains: 'FIRES',
    arms: 1,
    requiresInArm: ["mutate('carryResidual'"],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_5',
    armTitleContains: 'FIRES',
    arms: 1,
    requiresInArm: ["mutate('outstandingSource'"],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_6',
    armTitleContains: 'FIRES',
    arms: 4,
    requiresInArm: ['journalFindings(', 'relationsRead(', 'canonicalReducerRegistry('],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_7',
    armTitleContains: 'FIRES',
    arms: 2,
    requiresInArm: ['findAuthoritativeSalesColumns('],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_8',
    armTitleContains: 'FIRES',
    arms: 1,
    requiresInArm: ['FINANCIAL_TIME'],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_9',
    armTitleContains: 'FIRES',
    arms: 2,
    requiresInArm: ['OVER_SCHEDULED', 'unpaidDuePortion('],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
  Object.freeze({
    id: 'proof_10',
    armTitleContains: 'FIRES',
    arms: 1,
    requiresInArm: ["mutate('baseAllocation'"],
    minAssertions: 3,
    file: 'phase4-s7-installment-aging.test.ts',
  }),
]);

const MUTATIONS_EXERCISED: readonly { readonly proof: string; readonly knob: keyof ProjectionPolicy; readonly to: unknown }[] = Object.freeze([
  Object.freeze({ proof: 'proof_1', knob: 'clampToRowAmount' as const, to: false }),
  Object.freeze({ proof: 'proof_2', knob: 'bucketBy' as const, to: 'invoice_due_date' }),
  Object.freeze({ proof: 'proof_3', knob: 'planlessArm' as const, to: 'every_invoice' }),
  Object.freeze({ proof: 'proof_4', knob: 'carryResidual' as const, to: false }),
  Object.freeze({ proof: 'proof_5', knob: 'outstandingSource' as const, to: 'plan_local' }),
  Object.freeze({ proof: 'proof_2', knob: 'scheduleDateShiftDays' as const, to: -200 }),
  Object.freeze({ proof: 'proof_10', knob: 'baseAllocation' as const, to: 'per_row_conversion' }),
]);

function mutate(knob: keyof ProjectionPolicy, to: unknown): ProjectionPolicy {
  return { ...CORRECT_POLICY, [knob]: to } as ProjectionPolicy;
}

const THRESHOLDS = [30, 60, 90] as const;
const AS_OF = '2026-10-07';

/** A civil date `n` days before `AS_OF`, so every age below is DERIVED. */
const daysBefore = (n: number): string => new Date((epochDay(AS_OF) - n) * 86_400_000).toISOString().slice(0, 10);

/**
 * THE BOUNDARY SCHEDULE — the finding inside the finding, and the better
 * lesson of the two.
 *
 * The design fixture is a round monthly schedule, so it touches NO band
 * boundary: 175, 145, 114, 84, 53, 22 days and the future ones. The `>` to
 * `>=` mutant is therefore INERT on it — proof 2 would have been green FOR
 * WANT OF A CASE, not for want of a check, and no amount of repairing the
 * law's subject would have found that.
 *
 * This schedule puts a scheduled date on EVERY boundary, on both sides of
 * every boundary, and one day off each: ages 0, 30, 31, 60, 61, 90, 91 and a
 * future date. Twelve rows of 100 000 against the same authoritative pair as
 * the design fixture, so the sum law and the base law hold over it unchanged.
 */
const BOUNDARY_AGES = [-30, 0, 29, 30, 31, 60, 61, 90, 91, 200, 300, 400] as const;

const BOUNDARY_INVOICE: OpenInvoiceRow = Object.freeze({
  invoiceId: 'inv-boundary',
  currencyCode: 'SAR',
  dueDate: daysBefore(200),
  outstandingTxnMinor: 900_000n,
  paidTxnMinor: 300_000n,
  paidBaseMinor: 253_750n,
  outstandingBaseMinor: 761_251n,
});

const BOUNDARY_PLAN: InstallmentPlan = Object.freeze({
  planId: 'plan-boundary',
  invoiceId: 'inv-boundary',
  status: 'active',
  downPaymentMinor: 0n,
  downPaymentDueDate: daysBefore(401),
  installments: Object.freeze(
    // Ascending by date, so `seq_no` and `due_date` agree and the settlement
    // order is unambiguous: the oldest ages first.
    [...BOUNDARY_AGES].sort((a, b) => b - a).map((age, i) => Object.freeze({ seqNo: i + 1, dueDate: daysBefore(age), amountTxnMinor: 100_000n })),
  ),
});

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
  // The other halves of the SAME authoritative row: three instalments
  // collected, and the carrying released for them. `total_base_minor` is
  // 1 015 001 against a `total_txn_minor` of 1 200 000 — deliberately not a
  // round ratio, so the HALF_EVEN cumulative law does real rounding:
  // `R(300 000) = HALF_EVEN(1 015 001 x 300 000 / 1 200 000)
  //            = HALF_EVEN(253 750.25) = 253 750`.
  paidTxnMinor: 300_000n,
  paidBaseMinor: 253_750n,
  outstandingBaseMinor: 761_251n,
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
  paidBaseMinor: 0n,
  outstandingBaseMinor: 211_251n,
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
  paidBaseMinor: 0n,
  outstandingBaseMinor: 845_003n,
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
  paidBaseMinor: 0n,
  outstandingBaseMinor: 760_501n,
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
    const today = aggregate(contributionsFor([PLANNED_INVOICE], [PLAN], AS_OF, THRESHOLDS, mutate('bucketBy', 'invoice_due_date')));
    expect(today).toEqual([{ bucketNo: 4, currencyCode: 'SAR', txnMinor: 900_000n, baseMinor: 761_251n, invoiceCount: 1 }]);

    // The fix. Each instalment ages on its own date — and the base carrying
    // portion travels with it, by the canonical cumulative law (proof 10).
    // 338 334 + 84 583 + 84 584 + 253 750 = 761 251, the authoritative
    // outstanding base, EXACTLY: the sum is unchanged by the regrouping
    // because the four figures are differences of ONE cumulative function.
    expect(projectCustomerAging([PLANNED_INVOICE], [PLAN], AS_OF, THRESHOLDS)).toEqual([
      { bucketNo: 1, currencyCode: 'SAR', txnMinor: 400_000n, baseMinor: 338_334n, invoiceCount: 1 },
      { bucketNo: 2, currencyCode: 'SAR', txnMinor: 100_000n, baseMinor: 84_583n, invoiceCount: 1 },
      { bucketNo: 3, currencyCode: 'SAR', txnMinor: 100_000n, baseMinor: 84_584n, invoiceCount: 1 },
      { bucketNo: 4, currencyCode: 'SAR', txnMinor: 300_000n, baseMinor: 253_750n, invoiceCount: 1 },
    ]);
    // The regrouping is value-preserving on BOTH columns, which is the
    // granularity claim stated as an equation rather than as a picture.
    const onlyBand = today[0];
    expect(onlyBand, 'the defect reading produced NO bucket, so the equation below has no subject').toBeDefined();
    expect(onlyBand?.txnMinor).toBe(900_000n);
    expect(onlyBand?.baseMinor).toBe(761_251n);
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
      // The base is the AUTHORITATIVE `outstanding_base_minor` passed through,
      // not a recomputation of it: the plan-less arm performs no arithmetic.
      { bucketNo: 4, currencyCode: 'SAR', txnMinor: 250_000n, baseMinor: 211_251n, invoiceCount: 1 },
    ]);
    expect(PLAINLESS_INVOICE.outstandingBaseMinor).toBe(211_251n);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('PROOF 1 [proof_1] — the sum of the aging buckets equals the authoritative invoice outstanding', () => {
  // The SUBJECT is the authoritative figure, taken from the fixture and never
  // from the projection, over a portfolio that mixes a planned invoice, a
  // plan-less invoice and a broken sum law.
  // The portfolio spans all three schedule shapes: well-formed, UNDER-scheduled
  // and OVER-scheduled. The over-scheduled one is what makes the upper clamp
  // bite — without it the `clampToRowAmount` mutation is INERT, which `meta_2`
  // would then catch as a mutation that proves nothing.
  const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE, OVER_SCHEDULED_INVOICE];
  const plans = [PLAN, SHORT_PLAN, OVER_SCHEDULED_PLAN];
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

  it('FIRES under its mutation: THE CANONICAL LAW ITSELF REFUSES a level past the invoice total', () => {
    // The strongest outcome available: removing the upper clamp lets a
    // cumulative level run past the invoice total, and `apRelease`'s own
    // guard — «an AP release exceeds the purchase total»
    // (`supplier-settlement.ts:94`) — refuses it. The defect cannot even
    // produce a number.
    expect(() => projectCustomerAging(rows, plans, AS_OF, THRESHOLDS, mutate('clampToRowAmount', false))).toThrow(/AP release exceeds the purchase total/);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: the UNMUTATED configuration does not throw, so the
    // refusal belongs to the mutation and not to the fixture.
    expect(() => projectCustomerAging(rows, plans, AS_OF, THRESHOLDS)).not.toThrow();
    // ...and the unmutated answer still totals the authoritative figure, so
    // this arm is not taking credit for a refusal proof 1 would have raised.
    expect(projectCustomerAging(rows, plans, AS_OF, THRESHOLDS).reduce((a, b) => a + b.txnMinor, 0n)).toBe(
      rows.reduce((a, r) => a + r.outstandingTxnMinor, 0n),
    );
    recordProof('proof_1', 3, 'FIRES arm ran: the canonical law refuses an over-total level; unmutated does not throw');
  });

  it('FIRES under its mutation: and the overshoot is MEASURED, with the guard stood down', () => {
    // A permissive release, so the arithmetic proceeds and the damage is a
    // number rather than an exception. This is what proof 1 would have been
    // asserting if the canonical law carried no guard — so the law is shown
    // to be red-capable on its own terms, not only via someone else's throw.
    const permissive: ReleaseFn = (B, T, X, a) => (T === 0n ? 0n : (B * (X + a)) / T - (B * X) / T);
    const good = rows.flatMap((r) =>
      projectInvoice(
        r,
        plans.find((p) => p.invoiceId === r.invoiceId),
        AS_OF,
        THRESHOLDS,
        CORRECT_POLICY,
        permissive,
      ),
    );
    expect(sum(good)).toBe(authoritative);
    const bad = rows.flatMap((r) =>
      projectInvoice(
        r,
        plans.find((p) => p.invoiceId === r.invoiceId),
        AS_OF,
        THRESHOLDS,
        mutate('clampToRowAmount', false),
        permissive,
      ),
    );
    expect(sum(bad)).not.toBe(authoritative);
    // The overshoot is exactly the over-scheduled excess: 1 800 000 − 900 000.
    expect(sum(bad) - authoritative).toBe(900_000n);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_1', 3, 'FIRES arm ran: FIRES under its mutation: and the overshoot is MEASURED, wit');
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
  function notYetDueByPlan(cs: readonly AgingContribution[], plan: InstallmentPlan, row: OpenInvoiceRow): readonly AgingContribution[] {
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
      // THE EXPECTED VALUE IS THE INDEPENDENT ORACLE, never `bucketOf`.
      // `bucketIndexByBand` parses `agingBucketLabels` — PRODUCT code — back
      // into intervals and asks which interval contains the age. The
      // projection counts thresholds. Two algorithmic paths; the law is a
      // claim again instead of `f(x) === f(x)`.
      expect(x.bucketNo, `seq ${String(x.seqNo)}`).toBe(bucketIndexByBand(AS_OF, declaredDate(x, PLAN, PLANNED_INVOICE), THRESHOLDS));
    }
    // And the law really does range over several distinct buckets, so it is
    // not satisfied by everything landing in one.
    expect(new Set(c.map((x) => x.bucketNo)).size).toBeGreaterThan(1);
  });

  it('THE BOUNDARY FIXTURE: the strong law holds where the bands actually meet', () => {
    // The design fixture is round monthly and touches no boundary, so the
    // `>=` mutant below is INERT on it. This one sits on every boundary.
    const c = projectInvoice(BOUNDARY_INVOICE, BOUNDARY_PLAN, AS_OF, THRESHOLDS);
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) {
      expect(x.bucketNo, `seq ${String(x.seqNo)}`).toBe(bucketIndexByBand(AS_OF, declaredDate(x, BOUNDARY_PLAN, BOUNDARY_INVOICE), THRESHOLDS));
    }
    // Every band is reached, so no band is asserted vacuously. The three
    // oldest rows (400, 300, 200 days) are what the 300 000 already paid
    // settles, which is why the fixture carries them: without rows older than
    // the paid prefix, band 4 would be empty and the law vacuous there.
    expect(new Set(c.map((x) => x.bucketNo))).toEqual(new Set([1, 2, 3, 4]));
    // The money laws still hold on it, so the fixture is not a special case
    // that only the banding sees.
    expect(sum(c)).toBe(BOUNDARY_INVOICE.outstandingTxnMinor);
    // And a date really does sit ON each boundary, which is the whole point.
    const ages = BOUNDARY_PLAN.installments.map((i) => epochDay(AS_OF) - epochDay(i.dueDate));
    for (const t of THRESHOLDS) expect(ages, `no date at exactly ${String(t)} days`).toContain(t);
    recordProof('proof_2', 7, 'boundary fixture: every band reached, a date on each threshold');
  });

  it('FIRES: FIVE mutants of the BANDING that the old self-referential form could not refuse', () => {
    // Each one leaves the surrounding structure entirely valid — money
    // untouched, indices in range, the sum law still holding, the output
    // self-consistent — which is exactly why an oracle that calls `bucketOf`
    // cannot refuse any of them. They are injected into the real projection.
    expect(BUCKET_MUTANTS.length).toBe(5);
    const victims: readonly { readonly row: OpenInvoiceRow; readonly plan: InstallmentPlan }[] = [
      { row: BOUNDARY_INVOICE, plan: BOUNDARY_PLAN },
      { row: PLANNED_INVOICE, plan: PLAN },
    ];
    for (const { name, fn } of BUCKET_MUTANTS) {
      let disagreements = 0;
      let moneyMoved = false;
      for (const { row, plan } of victims) {
        const c = projectInvoice(row, plan, AS_OF, THRESHOLDS, CORRECT_POLICY, CANONICAL_RELEASE, fn);
        // THE SURROUNDING STRUCTURE IS STILL VALID. If the mutant broke the
        // money too, the law would be caught by proof 1 and this one would be
        // taking credit for someone else's refusal.
        expect(sum(c), `${name}: the money moved`).toBe(row.outstandingTxnMinor);
        for (const x of c) {
          expect(x.bucketNo, `${name}: out of range`).toBeGreaterThanOrEqual(1);
          expect(x.bucketNo, `${name}: out of range`).toBeLessThanOrEqual(THRESHOLDS.length + 1);
        }
        if (sum(c) !== row.outstandingTxnMinor) moneyMoved = true;
        disagreements += c.filter((x) => x.bucketNo !== bucketIndexByBand(AS_OF, declaredDate(x, plan, row), THRESHOLDS)).length;
      }
      expect(moneyMoved).toBe(false);
      // ...and the band oracle refuses it. A non-zero count is the proof that
      // the law's refusal is REACHABLE, which it was not before.
      expect(disagreements, `${name} was INERT — the law cannot refuse it`).toBeGreaterThan(0);
    }
    // THE INERTNESS THE PROOF ENGINEER FOUND, reproduced rather than
    // described: the `>=` mutant disagrees on the BOUNDARY fixture and NOT on
    // the round monthly one, so on the design fixture alone this law would
    // have been green for want of a case.
    const inclusive = BUCKET_MUTANTS.find((m) => m.name === 'boundary_inclusive');
    // A `??` FALLBACK HERE WOULD BE THE DEFECT. Substituting the correct
    // bucket function for a missing mutant makes the two readings below agree
    // and the arm green for want of a mutant. So: refuse, loudly.
    if (inclusive === undefined) throw new Error('NO SUBJECT: BUCKET_MUTANTS no longer carries boundary_inclusive');
    const onRound = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS, CORRECT_POLICY, CANONICAL_RELEASE, inclusive.fn);
    expect(onRound.filter((x) => x.bucketNo !== bucketIndexByBand(AS_OF, declaredDate(x, PLAN, PLANNED_INVOICE), THRESHOLDS))).toHaveLength(0);
    const onBoundary = projectInvoice(BOUNDARY_INVOICE, BOUNDARY_PLAN, AS_OF, THRESHOLDS, CORRECT_POLICY, CANONICAL_RELEASE, inclusive.fn);
    expect(
      onBoundary.filter((x) => x.bucketNo !== bucketIndexByBand(AS_OF, declaredDate(x, BOUNDARY_PLAN, BOUNDARY_INVOICE), THRESHOLDS)).length,
    ).toBeGreaterThan(0);
    recordProof('proof_2', 5, 'five banding mutants refused; `>=` shown inert on the round fixture');
  });

  it('THE ORACLE IS CALIBRATED AGAINST ITSELF, so it is evidence and not an assertion', () => {
    // Two independent derivations that agree are evidence the oracle is
    // right; one is an assertion. Interval containment and binary search
    // agree with the shipped counting expression on every age in range.
    for (let age = -5; age <= 200; age += 1) {
      const d = daysBefore(age);
      const band = bucketIndexByBand(AS_OF, d, THRESHOLDS);
      expect(bucketIndexByBinarySearch(AS_OF, d, THRESHOLDS), `age ${String(age)}`).toBe(band);
      expect(bucketOf(AS_OF, d, THRESHOLDS), `age ${String(age)}`).toBe(band);
    }
    expect(bucketIndexByBand(AS_OF, null, THRESHOLDS)).toBe(1);
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
    expect(residual[0]?.bucketNo).toBe(bucketIndexByBand(AS_OF, SHORT_SCHEDULE_INVOICE.dueDate, THRESHOLDS));
    expect(residual[0]?.bucketNo).toBeGreaterThan(1);
    for (const i of SHORT_PLAN.installments) expect(epochDay(i.dueDate)).toBeGreaterThan(epochDay(AS_OF));
    // The honest reading: a sum-law VIOLATION signal, aged conservatively at
    // the invoice's own date. The violation itself is bounded by the DEFERRED
    // verifier (proof 9), which is now its only home.
    expect(SHORT_PLAN.installments.reduce((a, i) => a + i.amountTxnMinor, 0n)).toBe(200_000n);
    expect(SHORT_SCHEDULE_INVOICE.paidTxnMinor + SHORT_SCHEDULE_INVOICE.outstandingTxnMinor).toBe(1_000_000n);
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
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_2', 4, 'FIRES arm ran: FIRES under its mutation: bucketing by the invoice due date ');
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
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_2', 4, 'FIRES arm ran: FIRES under its mutation: every schedule date shifted 200 da');
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
      paidBaseMinor: 0n,
      outstandingBaseMinor: 338n,
    });
    const c = projectInvoice(row, emptyPlan, AS_OF, THRESHOLDS);
    // The PLAN arm: the down payment at its own future date, bucket 1.
    expect(c.map((x) => [x.origin, x.seqNo, x.scheduleDate, x.bucketNo, x.txnMinor])).toEqual([['down_payment', 0, '2027-06-01', 1, 400n]]);
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
    // ROUND 7 F1: arm (c) is no longer keyed on what the caller can SEE in
    // `installment_plans`. It is keyed on the invoice's own column, so the
    // partition of the open invoices is now between flagged and unflagged.
    expect(sketch).toMatch(/FROM open_invoice oi\n\s*WHERE NOT oi\.flagged/);
    expect(sketch).toMatch(/FROM public\.installment_plans p/);
    // The state is ALSO made unreachable at commit, so this is closed from
    // both ends rather than only from the model's.
    expect(SPEC).toMatch(/AT LEAST ONE `installments` row per active plan/);
  });

  it('two active plans on one invoice are REFUSED rather than silently counted twice', () => {
    const twin: InstallmentPlan = { ...PLAN, invoiceId: 'inv-plan' };
    expect(() => contributionsFor([PLANNED_INVOICE], [PLAN, twin], AS_OF, THRESHOLDS)).toThrow(/installment_plan\.more_than_one_active/);
  });

  it('the specification forbids it structurally, with a partial unique index', () => {
    expect(SPEC).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+installment_plans\s*\(\s*business_id\s*,\s*invoice_id\s*\)\s*WHERE\s+status\s*=\s*'active'/i);
  });

  it('FIRES under its mutation: the plan-less arm stops excluding planned invoices', () => {
    const authoritative = rows.reduce((a, r) => a + r.outstandingTxnMinor, 0n);
    const got = sum(projectCustomerAging(rows, plans, AS_OF, THRESHOLDS, mutate('planlessArm', 'every_invoice')));
    expect(got).not.toBe(authoritative);
    // The two planned invoices are counted twice over.
    expect(got).toBe(authoritative + PLANNED_INVOICE.outstandingTxnMinor + SHORT_SCHEDULE_INVOICE.outstandingTxnMinor);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: the unmutated portfolio totals the authoritative
    // figure exactly, so the overcount is the mutation's and not the
    // fixture's.
    expect(sum(contributionsFor(rows, plans, AS_OF, THRESHOLDS))).toBe(authoritative);
    recordProof('proof_3', 3, 'FIRES arm ran: the plan-less arm stops excluding planned invoices; unmutated is exact');
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
    const over: OpenInvoiceRow = {
      ...PLANNED_INVOICE,
      outstandingTxnMinor: -5_000n,
      outstandingBaseMinor: -4_200n,
    };
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
    // Every inclusive PREFIX sum of the ordered schedule, plus the endpoints.
    // Prefix and not suffix: the cumulative levels are anchored at the PAID
    // level and run forward, so these are the points at which the cut falls
    // BETWEEN rows and no row is partially allocated.
    const boundaries: readonly bigint[] = [0n, 50_000n, 150_000n, 350_000n, T, T + 1n, -1n];
    for (const O of boundaries) {
      const row: OpenInvoiceRow = {
        invoiceId: 'inv-b',
        currencyCode: 'SAR',
        dueDate: '2026-02-01',
        outstandingTxnMinor: O,
        paidTxnMinor: 0n,
        paidBaseMinor: 0n,
        outstandingBaseMinor: O > 0n ? O - O / 8n : O,
      };
      const c = projectInvoice(row, plan, AS_OF, THRESHOLDS);
      expect(sum(c), `boundary O=${String(O)}`).toBe(O);
      // At an exact suffix sum the cut falls BETWEEN rows, so no row is
      // partially allocated — the case a pro-rata rule would have to round.
      if (O === 50_000n || O === 150_000n || O === 350_000n || O === T || O === 0n) {
        for (const x of c) {
          if (x.origin === 'residual') continue;
          const declared = x.origin === 'down_payment' ? plan.downPaymentMinor : (inst.find((i) => i.seqNo === x.seqNo)?.amountTxnMinor as bigint);
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
        paidBaseMinor: 0n,
        outstandingBaseMinor: BigInt(n) * 42_131n,
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
      paidBaseMinor: 0n,
      outstandingBaseMinor: 84_503n,
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
      return (((rng >>> 1) % n) + n) % n;
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
      const P = BigInt(next(20_000));
      const totalTxn = P + O;
      const row: OpenInvoiceRow = {
        invoiceId: 'r',
        currencyCode: 'SAR',
        dueDate: '2026-06-01',
        outstandingTxnMinor: O,
        paidTxnMinor: P,
        paidBaseMinor: P > 0n ? P - P / 8n : 0n,
        outstandingBaseMinor: O > 0n ? O - O / 8n : O,
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
      // PREFIX-ANCHORED, matching the paid-anchored levels: skip the part of
      // the schedule the payment covers, then fill forward while outstanding
      // capacity remains. A loop with two accumulators, structurally unlike
      // the closed form.
      let skip = P;
      let capacity = totalTxn - P;
      const simAlloc = new Map<number, bigint>();
      for (const r of ordered) {
        const covered = skip < r.amount ? skip : r.amount;
        skip -= covered;
        const free = r.amount - covered;
        const a = free < capacity ? free : capacity;
        if (a > 0n) simAlloc.set(r.seqNo, a);
        capacity -= a;
      }

      // M-8: THE RESIDUAL GETS AN INDEPENDENT COMPUTATION. A CASE ANALYSIS
      // over where the schedule's last level falls, mentioning neither
      // `capacity` nor `simAlloc`, so the law is not `O − Σ alloc` restated.
      const lastLevel = total > P ? (total < totalTxn ? total : totalTxn) : P;
      // The degenerate branch: nothing outstanding, or an outstanding no
      // CHECK permits, carries wholly as residual and allocates nothing.
      const degenerate = O <= 0n || totalTxn <= 0n;
      const simResidual = degenerate ? O : totalTxn - lastLevel;
      if (degenerate) simAlloc.clear();

      const got = projectInvoice(row, plan, AS_OF, THRESHOLDS);
      const gotAlloc = new Map(got.filter((x) => x.origin !== 'residual').map((x) => [x.seqNo as number, x.txnMinor]));
      expect([...gotAlloc.entries()].sort((a, b) => a[0] - b[0])).toEqual([...simAlloc.entries()].sort((a, b) => a[0] - b[0]));
      expect(sum(got.filter((x) => x.origin === 'residual'))).toBe(simResidual);
      expect(sum(got)).toBe(O);
    }
    // THE GENERATOR IS NOT DEGENERATE, asserted rather than hoped.
    expect(seenN.size, 'schedule length barely varies').toBeGreaterThanOrEqual(12);
    expect(seenMonth.size, 'month barely varies').toBe(12);
    for (const n of [2, 4]) expect(seenN, `n=${n} never generated`).toContain(n);
  });

  it('FIRES under its mutation: the residual is dropped', () => {
    const got = sum(projectInvoice(SHORT_SCHEDULE_INVOICE, SHORT_PLAN, AS_OF, THRESHOLDS, mutate('carryResidual', false)));
    expect(got).not.toBe(SHORT_SCHEDULE_INVOICE.outstandingTxnMinor);
    expect(got).toBe(200_000n); // 8,000.00 has vanished
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: unmutated, the same fixture loses nothing.
    expect(sum(contributionsFor([SHORT_SCHEDULE_INVOICE], [SHORT_PLAN], AS_OF, THRESHOLDS))).toBe(SHORT_SCHEDULE_INVOICE.outstandingTxnMinor);
    recordProof('proof_4', 3, 'FIRES arm ran: the residual is dropped and 8,000.00 vanishes; unmutated loses nothing');
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
  const READ_SURFACE = readFileSync(join(REPO, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts'), 'utf8');
  const DAYS = [30, 60, 90] as const;

  /** A civil date `n` days before `AS_OF`, so the ages are derived and not hand-picked. */
  const daysBefore = (n: number): string => new Date((epochDay(AS_OF) - n) * 86_400_000).toISOString().slice(0, 10);

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
  const afterPayment: OpenInvoiceRow = {
    ...PLANNED_INVOICE,
    outstandingTxnMinor: 800_000n,
    paidTxnMinor: 400_000n,
    // `R(400 000) = HALF_EVEN(1 015 001 x 400 000 / 1 200 000)
    //            = HALF_EVEN(338 333.67) = 338 334`.
    paidBaseMinor: 338_334n,
    outstandingBaseMinor: 676_667n,
  };

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
    const bucket4 = (x: readonly { bucketNo: number; txnMinor: bigint }[]): bigint => x.filter((y) => y.bucketNo === 4).reduce((s, y) => s + y.txnMinor, 0n);
    expect(bucket4(b) - bucket4(a)).toBe(100_000n);
  });

  it('a reversal returns the projection EXACTLY to where it was', () => {
    const b = projectCustomerAging([before], [PLAN], AS_OF, THRESHOLDS);
    const reversed = projectCustomerAging([{ ...PLANNED_INVOICE }], [PLAN], AS_OF, THRESHOLDS);
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
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_5', 3, 'FIRES arm ran: FIRES under its mutation: a plan-local collected total is a ');
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

  /**
   * The last EFFECTIVE definition of a routine across the tree, delegated to
   * the adopted mechanism. This file's own version picked the first `$fn$`
   * anywhere later in the FILE — past the end of the definition — and
   * preferred `$fn$` even when a `$$` opened first. It was right today by
   * luck, and `0084` is the only Phase 4 migration using `$fn$`, so the luck
   * was load-bearing. The adopted one takes the FIRST dollar tag after the
   * header whatever it is spelled, and interleaves DROP and CREATE by
   * POSITION inside the file, because `0084` drops at :488 and recreates at
   * :593 and the order is what decides.
   */
  function liveDefinition(header: string): { migration: string; body: string; line: number } {
    const sig = /customer_ar_aging/.test(header)
      ? String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?customer_ar_aging`
      : String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?invoice_outstanding`;
    const h = lastEffectiveRoutineDefinition(MIGRATIONS, header, new RegExp(sig, 'i'));
    if (h.live === null) throw new Error(`no live definition of: ${header}`);
    return { migration: h.live.migration, body: h.live.body, line: h.live.line };
  }

  /**
   * Every relation a body touches, by the ADOPTED reader. It excludes aliases
   * STRUCTURALLY — only post-introducer positions are ever read — rather than
   * by a `public.` spelling, so an unqualified table, a quoted identifier, a
   * space around the dot and a CTE-wrapped unqualified source are all seen.
   */
  function relationsRead(body: string): string[] {
    return [...relationsTouched(body)];
  }

  /**
   * WHAT MAKES A RELATION AN INVOICE REDUCER — canonically, and by the
   * ADOPTED registry rather than by this file's own regex.
   *
   * A name list would be a textual coincidence and would miss the next
   * reducer whatever it is called. Seam `S-P4-03` asks which relations settle
   * an invoice, and the answer has a SHAPE: a relation that reduces an
   * invoice declares a column named EXACTLY `invoice_amount_applied_minor`.
   *
   * EXACT equality, through the estate's own `findColumnDeclarations`, and
   * `DROP TABLE` honoured. Round 3 shipped `/invoice_amount_applied_minor/i`
   * — an UNANCHORED SUBSTRING — so `bill_invoice_amount_applied_minor` or
   * `invoice_amount_applied_minor_cents` would have made an unrelated
   * relation an invoice reducer and could have pulled the SUPPLIER side into
   * a customer-side law. A law about a column must say which column.
   */
  function reducerRelationsInTree(): string[] {
    return [...canonicalReducerRegistry(MIGRATIONS)];
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
    expect(journalFindings(planted)).toEqual(['declares an accounting_source_type', 'registers an accounting source binding']);
    const plantedRelation = `${SPEC}\nCREATE TABLE installment_journal_lines (business_id UUID NOT NULL, id UUID NOT NULL);\n`;
    expect(journalFindings(plantedRelation)).toContain('creates a journal relation: installment_journal_lines');
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: the real specification is NOT flagged, so the
    // detector is discriminating and not merely alarming.
    expect(journalFindings(SPEC)).toEqual([]);
    recordProof('proof_6', 3, 'FIRES arm ran: journal planted and flagged; the real specification is clean');
  });

  it('FIRES under its mutation: a reducer branch planted in NINE legitimate SQL forms, five of which used to pass', () => {
    // ROUND 4: THE FOUR SHAPES ALL SPELLED `public.`, SO THE GAP WAS
    // UNTESTED RATHER THAN TESTED AND TOLERATED.
    //
    // Round 3 planted the branch four ways and caught all four — but every
    // one of them wrote `public.installment_collections`, which is the ONE
    // thing the old `/\bpublic\.(...)/` reader could see. The proof engineer
    // planted 17 legitimate forms into the real live body and measured FIVE
    // misses: an unqualified table, unqualified with no alias, quoted
    // identifiers, a space around the dot, and CTE wrapping with an
    // unqualified source inside. A new reducer branch written in any of the
    // five would have appended silently to the settlement sum with proof 6
    // GREEN.
    //
    // The adopted reader excludes aliases STRUCTURALLY — only
    // post-introducer positions are ever read — so the five are now shapes of
    // the same law rather than holes beside it. All nine are asserted here,
    // and the five that used to pass are named as such.
    const live = liveDefinition(HEADER);
    const shapes: readonly { readonly name: string; readonly sql: string }[] = [
      { name: 'one-letter alias', sql: 'FROM public.installment_collections n WHERE n.business_id = x' },
      { name: 'two-letter alias', sql: 'FROM public.installment_collections ic WHERE ic.business_id = x' },
      { name: 'AS alias', sql: 'FROM public.installment_collections AS coll WHERE coll.business_id = x' },
      { name: 'no alias', sql: 'FROM public.installment_collections WHERE business_id = x' },
      // ── THE FIVE THAT USED TO PASS ──────────────────────────────────
      { name: 'UNQUALIFIED, aliased', sql: 'FROM installment_collections n WHERE n.business_id = x' },
      { name: 'UNQUALIFIED, no alias', sql: 'FROM installment_collections WHERE business_id = x' },
      { name: 'QUOTED identifiers', sql: 'FROM "public"."installment_collections" n WHERE n.business_id = x' },
      { name: 'SPACE around the dot', sql: 'FROM public . installment_collections n WHERE n.business_id = x' },
      { name: 'JOINed rather than FROMed', sql: 'FROM public.invoices i JOIN installment_collections n ON n.invoice_id = i.id WHERE x' },
    ];
    for (const shape of shapes) {
      const planted = `${live.body}\n            UNION ALL\n            SELECT invoice_id, amount, rel ${shape.sql}\n`;
      expect(planted).not.toBe(live.body);
      const reducers = relationsRead(planted).filter((t) => SETTLING_RELATION.test(t) || t === 'installment_collections');
      expect(reducers, `missed with ${shape.name}`).toContain('installment_collections');
    }
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: the LIVE body's own reducer set is exactly the two
    // canonical ones, so a planted third is a real change and not noise.
    expect(
      relationsRead(live.body)
        .filter((t) => reducerRelationsInTree().includes(t))
        .sort(),
    ).toEqual([...reducerRelationsInTree()].sort());
    recordProof('proof_6', 3, 'FIRES arm ran: a planted reducer branch is seen in every shape; the live set is exactly two');
  });

  it('FIRES under its mutation: S7-5 — RENAME COLUMN, RENAME TABLE and DROP COLUMN, the four shapes that escaped', () => {
    // CHALLENGER S7-5. The registry consumed `findColumnDeclarations` and
    // honoured `DROP TABLE`, and nothing else — one of five mutating
    // statements. Four escapes remained, using readers the same file already
    // imported:
    //
    //   RENAME COLUMN x TO invoice_amount_applied_minor  — RECALL
    //   RENAME COLUMN invoice_amount_applied_minor TO y  — PRECISION
    //   DROP COLUMN invoice_amount_applied_minor         — PRECISION
    //   ALTER TABLE t RENAME TO u                        — RECALL
    //
    // AND THE MATRIX VARIES THE STATEMENT SHAPE, which is what the detector
    // now depends on — not the alias and not the qualification, which §7.0 of
    // the design document records it demonstrably no longer does. A matrix
    // shaped to the detector is how the `public.` hole survived a four-way
    // matrix for two rounds.
    const base = canonicalReducerRegistry(MIGRATIONS);
    expect([...base]).toEqual(['customer_credit_applications', 'payment_allocations']);

    const synthetic = (sql: string): readonly { readonly name: string; readonly sql: string }[] => [...MIGRATIONS, { name: '9999_synthetic.sql', sql }];

    // (1) RECALL — a relation that NEVER declares the column at CREATE time
    //     and acquires it by rename. Under the old registry it never entered.
    const renamedIn = canonicalReducerRegistry(
      synthetic(
        'CREATE TABLE sale_installment_collections (business_id UUID NOT NULL, invoice_id UUID NOT NULL, applied_minor BIGINT NOT NULL);\n' +
          'ALTER TABLE sale_installment_collections RENAME COLUMN applied_minor TO invoice_amount_applied_minor;\n',
      ),
    );
    expect(renamedIn, 'RENAME COLUMN into the reducer column still escapes').toContain('sale_installment_collections');

    // (2) PRECISION — a real reducer renames the column AWAY, so it is no
    //     longer a reducer and must leave the registry.
    const renamedOut = canonicalReducerRegistry(
      synthetic('ALTER TABLE payment_allocations RENAME COLUMN invoice_amount_applied_minor TO legacy_applied_minor;\n'),
    );
    expect(renamedOut, 'RENAME COLUMN out of the reducer column still escapes').not.toContain('payment_allocations');
    // ...and the OTHER reducer is untouched, so the removal is targeted.
    expect(renamedOut).toContain('customer_credit_applications');

    // (3) PRECISION — the column is dropped outright.
    const dropped = canonicalReducerRegistry(synthetic('ALTER TABLE customer_credit_applications DROP COLUMN invoice_amount_applied_minor;\n'));
    expect(dropped, 'DROP COLUMN still escapes').not.toContain('customer_credit_applications');
    expect(dropped).toContain('payment_allocations');

    // (4) RECALL — the relation is renamed, so the registry would otherwise
    //     hold a name no `CREATE TABLE` ever wrote again (`sql-schema.ts`'s
    //     own L-3 lesson). Membership is CARRIED, not dropped.
    const tableRenamed = canonicalReducerRegistry(synthetic('ALTER TABLE payment_allocations RENAME TO invoice_payment_allocations;\n'));
    expect(tableRenamed).toContain('invoice_payment_allocations');
    expect(tableRenamed).not.toContain('payment_allocations');

    // (5) THE EXEMPTION IS EVALUATED, NOT DECLARED. The real tree contains
    //     ZERO `RENAME COLUMN` and ZERO `ALTER TABLE … RENAME TO`, and its
    //     only `DROP COLUMN`s touch relations that never declared the reducer
    //     column — so the four passes are INERT on the shipped tree, which is
    //     exactly the «exemption that is never evaluated» trap. The synthetic
    //     migrations above are what evaluate them, and this arm asserts the
    //     inertness is a FACT about the tree rather than an assumption.
    const tree = MIGRATIONS.map((m) => m.sql).join('\n');
    expect(tree).not.toMatch(/RENAME\s+COLUMN/i);
    expect(tree).not.toMatch(/ALTER\s+TABLE[^;]*?\bRENAME\s+TO\b/i);
    const treeDrops = MIGRATIONS.flatMap((m) => alterDropColumns(m.sql));
    expect(treeDrops.length, 'the tree has no DROP COLUMN at all — then this check is vacuous').toBeGreaterThan(0);
    expect(treeDrops.filter((d) => d.column === 'invoice_amount_applied_minor')).toEqual([]);

    // (6) PRECISION against the near-miss statement: `DROP CONSTRAINT` is not
    //     a column drop, and a reader that read the next identifier would
    //     think a column named `CONSTRAINT` had been dropped.
    expect(alterDropColumns('ALTER TABLE t DROP CONSTRAINT t_pk;')).toEqual([]);
    expect(alterDropColumns('ALTER TABLE t ALTER COLUMN c DROP NOT NULL;')).toEqual([]);
    expect(alterDropColumns('ALTER TABLE t DROP COLUMN IF EXISTS "c" CASCADE;')).toEqual([{ table: 't', column: 'c' }]);
    // ...and the supplier side is still a different side.
    expect(base).not.toContain('purchase_payment_allocations');
    expect(PURCHASE_REDUCER_COLUMN).not.toBe(INVOICE_REDUCER_COLUMN);

    recordProof('proof_6', 16, 'FIRES arm ran: S7-5 four statement-shape escapes closed, recall and precision both');
  });

  it('FIRES under its mutation: a NEW reducer relation, discovered by its SHAPE and not its name', () => {
    // A later slice's reducer, named nothing this file could have guessed.
    const planted = `CREATE TABLE zzz_whatever_we_call_it_next (
      business_id UUID NOT NULL, id UUID NOT NULL, invoice_id UUID NOT NULL,
      invoice_amount_applied_minor BIGINT NOT NULL,
      invoice_carrying_base_released_minor BIGINT NOT NULL);`;
    // The discovery finds it by the reducer column, with no name list.
    expect(planted).toContain(INVOICE_REDUCER_COLUMN);
    expect(discoverSalesTables(planted)).toContain('zzz_whatever_we_call_it_next');
    // And the live settlement sum does not read it, which is the violation.
    expect(relationsRead(liveDefinition(HEADER).body)).not.toContain('zzz_whatever_we_call_it_next');
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_6', 3, 'FIRES arm ran: FIRES under its mutation: a NEW reducer relation, discovered');
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
    for (const ok of ['down_payment_minor', 'down_payment_due_date', 'installment_count', 'amount_txn_minor', 'due_date', 'seq_no', 'status', 'plan_id']) {
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
      / {2}amount_txn_minor BIGINT NOT NULL CHECK \(amount_txn_minor >= 1\),/,
      '  amount_txn_minor BIGINT NOT NULL CHECK (amount_txn_minor >= 1),\n  outstanding_minor BIGINT NOT NULL DEFAULT 0,\n  settled_minor    BIGINT NOT NULL DEFAULT 0,',
    );
    expect(planted).not.toBe(SPEC); // the mutation really applied
    expect(findAuthoritativeSalesColumns(planted, WATCHED)).toEqual([
      { table: 'installments', column: 'outstanding_minor' },
      { table: 'installments', column: 'settled_minor' },
    ]);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: the real specification declares none of them.
    expect(findAuthoritativeSalesColumns(SPEC, WATCHED)).toEqual([]);
    recordProof('proof_7', 3, 'FIRES arm ran: the two P4-AL-06 columns planted and named; the real spec declares none');
  });

  it('FIRES under its mutation: a plan-level remaining added by ALTER', () => {
    const planted = `${SPEC}\nALTER TABLE installment_plans ADD COLUMN outstanding_txn_minor BIGINT NOT NULL DEFAULT 0;\n`;
    expect(findAuthoritativeSalesColumns(planted, WATCHED)).toEqual([{ table: 'installment_plans', column: 'outstanding_txn_minor' }]);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: without the ALTER, nothing is named — and the ALTER
    // really did change the text it was applied to.
    expect(planted).not.toBe(SPEC);
    expect(findAuthoritativeSalesColumns(SPEC, WATCHED)).toEqual([]);
    recordProof('proof_7', 3, 'FIRES arm ran: a plan-level remaining added by ALTER is named; the unaltered spec is clean');
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
    const body = routineBody(shipped, 'CREATE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])');
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
    expect(sketch).toMatch(/WITH invoice_fact AS \(/);
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
    expect(sketch).toMatch(/RETURNS TABLE \(bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER\)/);
    const shipped = readFileSync(SHIPPED_AGING_PATH, 'utf8');
    expect(shipped).toMatch(/RETURNS TABLE \(bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER\)/);
  });

  it('C-2: the DDL is complete and transcribable, and the structural block is LIFTED BY A RULING', () => {
    // Round 2's block was a token that is not valid SQL — `LANGUAGE sql`
    // bodies are parsed at CREATE time, so the definition could not be
    // applied by accident. It held the hole open for a ruling instead of
    // guessing. THE RULING CAME (owner §21), so the token is GONE and the
    // expression it stood in for is the canonical cumulative law.
    const sketch = sqlCodeOnly(projectionSketch(SPEC));
    expect(sketch).not.toMatch(/__OWED_BASE_ALLOCATION__/);
    expect(sketch).toMatch(/public\.supplier_ap_release\(/);
    expect(SPEC).not.toMatch(/THIS SLICE CANNOT SHIP AS IT STANDS/);
    // All five columns, in the shipped order and with the shipped types —
    // §25 requires the return shape be KEPT, and `CREATE OR REPLACE FUNCTION`
    // cannot change a `RETURNS TABLE` list at all (42P13), so a design that
    // dropped `base_minor` was never available.
    expect(sketch).toMatch(/RETURNS TABLE \(bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER\)/);
    // ...and the shape is read off the LIVE shipped definition rather than
    // retyped from memory — the shape of the LAST `customer_ar_aging` in the
    // tree, which is the one the database holds (challenger C-1).
    // The LAST definition across the whole tree in apply order — `0075`
    // created it, `0083` replaced it and `0084:488` DROPs `0083`'s and
    // recreates it with a bare `CREATE FUNCTION`, so neither a chosen file nor
    // a fixed `CREATE OR REPLACE` spelling is a safe subject (challenger C-1).
    const defs = MIGRATIONS.flatMap((m) =>
      [...m.sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+customer_ar_aging\(/gi)].map((x) => ({
        name: m.name,
        // `matchAll` always sets `index`; a 0 fallback would silently make the
        // tail the WHOLE FILE and the return shape below the first one in it.
        tail: x.index === undefined ? '' : m.sql.slice(x.index),
      })),
    );
    expect(defs.length, 'no customer_ar_aging definition in the tree').toBeGreaterThan(0);
    expect(
      defs.every((d) => d.tail !== ''),
      'a match without an index — the tail would be the wrong body',
    ).toBe(true);
    const live = defs.at(-1);
    if (live === undefined) throw new Error('NO SUBJECT: no customer_ar_aging definition in the tree');
    expect(live.name).toBe('0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');
    const shape = /RETURNS TABLE \(([^)]*)\)/.exec(live.tail)?.[1];
    expect(shape, 'the shipped return shape was not found').toBeDefined();
    if (shape === undefined) throw new Error('NO SUBJECT: the shipped return shape was not found');
    expect(sketch).toContain(`RETURNS TABLE (${shape})`);
    // And the DDL a migration owner needs really is here — `LANGUAGE`,
    // `RETURNS`, `GRANT`, `REVOKE` each appeared ZERO times in the first
    // round, so there was no function DDL to transcribe at all.
    for (const token of ['LANGUAGE', 'RETURNS TABLE', 'GRANT EXECUTE', 'REVOKE ALL', 'COMMENT ON FUNCTION']) {
      expect(SPEC, `the spec has no ${token}`).toContain(token);
    }
    // WHAT STILL BLOCKS IT, named rather than left to be discovered: no
    // migration number, not in `migrations/`, not in the manifest, and one
    // authority change that is not the author's to make.
    expect(SPEC_PATH).not.toMatch(/\/migrations\//);
    const specBasename = SPEC_PATH.split('/').pop() ?? '';
    expect(specBasename, 'the specification path has no basename, so the numbering law has no subject').not.toBe('');
    expect(/^\d{4}_/.test(specBasename)).toBe(false);
    expect(SPEC).toMatch(/PR-6/);
    expect(SPEC).toMatch(/GRANT EXECUTE ON FUNCTION supplier_ap_release\(BIGINT, BIGINT, BIGINT, BIGINT\) TO daftar_app/);
  });

  it('M-12: the projection reads currency and due date OFF THE CALL, and joins invoices back on nowhere', () => {
    // `0084:593-596` appended `currency_code, due_date` to
    // `invoice_outstanding` precisely so the AR readers stop joining
    // `invoices` back onto the call; the first round's sketch joined it back
    // on and undid a measured optimisation on the `P4-D` path.
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    expect(sketch).toMatch(/SELECT o\.invoice_id, o\.currency_code, o\.due_date,/);
    // And the authoritative PAIR is recomposed from the same call, which is
    // what lets the base allocation need no `invoices` join either.
    expect(sketch).toMatch(/o\.paid_txn_minor \+ o\.outstanding_txn_minor/);
    expect(sketch).toMatch(/o\.paid_base_minor \+ o\.outstanding_base_minor/);
    expect(sketch).not.toMatch(/JOIN\s+public\.invoices/i);
    // The shipped routine does the same, which is the precedent.
    expect(readFileSync(SHIPPED_AGING_PATH, 'utf8')).toMatch(/o\.due_date IS NOT NULL/);
    // The only `public.invoices` reference is the id list, as shipped.
    expect([...sketch.matchAll(/public\.invoices\b/g)]).toHaveLength(1);
  });

  it('L-16: catalogue FUNCTIONS are pg_catalog-qualified; SQL CONSTRUCTS cannot be, and are not', () => {
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    // ROUND 3 CORRECTION, AND IT WAS A REAL DEFECT IN THIS FILE'S OWN LAW.
    // Round 2 listed `coalesce` here, and the sketch duly wrote
    // `pg_catalog.coalesce(...)`. `COALESCE` is SQL SYNTAX, not a catalogue
    // function, and cannot be schema-qualified at all — so the law was
    // DEMANDING A SYNTAX ERROR, and the body it certified could never have
    // been created. Measured rather than recalled: `pg_catalog.coalesce`
    // appears ZERO times in the whole migration tree and `0084` alone writes
    // bare `coalesce(` seven times, and `0084:810` states the rule outright
    // for `GREATEST`. The same holds for `least`, `greatest` and `nullif`,
    // which is why they were never in the list.
    const CONSTRUCTS = ['coalesce', 'least', 'greatest', 'nullif'];
    for (const c of CONSTRUCTS) {
      const qualified = new RegExp(`pg_catalog\\.${c}\\s*\\(`, 'gi');
      expect([...sketch.matchAll(qualified)], `pg_catalog.${c}( is not creatable SQL`).toHaveLength(0);
      // Over SCHEMA, not prose — this very check first went red on
      // `0084:810`'s own comment, which is the estate recording the SAME
      // lesson in words: «`GREATEST` is a SQL CONSTRUCT and not a function,
      // so it is NOT schema qualified: `pg_catalog.greatest(...)` does not
      // resolve». The exemption is therefore not the author's invention.
      const treeUses = MIGRATIONS.reduce((a, m) => a + [...sqlSchemaOnly(m.sql).matchAll(qualified)].length, 0);
      expect(treeUses, `the tree qualifies ${c}, so this exemption is wrong`).toBe(0);
    }
    // At least one of them really is used bare in the projection, so the
    // exemption above is EVALUATED and not merely declared.
    expect(sketch).toMatch(/(?<![.\w])coalesce\s*\(/);
    for (const fn of ['sum', 'count', 'unnest', 'array_agg', 'max']) {
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
    const schema = sqlCodeOnly(SPEC);
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
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    // THE DISCRIMINATION: the real projection sketch reads no clock, so the
    // guard is distinguishing and not simply matching everything.
    expect(FINANCIAL_TIME.test(sqlCodeOnly(projectionSketch(SPEC)).replace(/DEFAULT now\(\)/g, ''))).toBe(false);
    recordProof('proof_8', 3, 'FIRES arm ran: a planted clock read is flagged under any volatility label; the sketch is clean');
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

  it('THE 265-DAY GOLDEN: the over-scheduled case is now allocated to the EARLIEST UNPAID row, and reports as overdue', () => {
    // The challenger's PROBE D, kept as a PERMANENT DETERMINISTIC GOLDEN
    // (owner §26: never replaced by random-only coverage).
    //
    // In round 2 this input put the whole 900 000 on instalment 2, dated
    // 2027-01-15, and reported a 265-day-overdue receivable as ENTIRELY NOT
    // YET DUE. Anchoring the cumulative levels at the PAID level — which the
    // base ruling forces — allocates to the earliest UNPAID row instead, so
    // the understatement is no longer EXPRESSIBLE rather than merely
    // signalled.
    expect(epochDay(AS_OF) - epochDay('2026-01-15')).toBe(265);
    const c = projectInvoice(OVER_SCHEDULED_INVOICE, OVER_SCHEDULED_PLAN, AS_OF, THRESHOLDS);
    expect(c.map((x) => [x.origin, x.seqNo, x.scheduleDate, x.bucketNo, x.txnMinor])).toEqual([['installment', 1, '2026-01-15', 4, 900_000n]]);
    // The whole balance is in the OLDEST bucket, where a 265-day-overdue
    // receivable belongs, and nothing is in the not-yet-due bucket.
    expect(sum(c.filter((x) => x.bucketNo === 1))).toBe(0n);
    expect(sum(c)).toBe(OVER_SCHEDULED_INVOICE.outstandingTxnMinor);
    // Nothing paid, so nothing may be treated as settled.
    expect(OVER_SCHEDULED_INVOICE.paidTxnMinor).toBe(0n);
  });

  it('FIRES: the round-2 anchor is what produced the understatement, and it no longer exists', () => {
    // The old form anchored on the OUTSTANDING against the schedule's SUFFIX.
    // Reconstructed here from the fixture alone, to show the repair is a real
    // change of answer and not a re-labelling.
    const T = OVER_SCHEDULED_PLAN.installments.reduce((a, i) => a + i.amountTxnMinor, 0n);
    const O = OVER_SCHEDULED_INVOICE.outstandingTxnMinor;
    expect(T).toBe(1_800_000n);
    // Suffix-anchored: instalment 2's share was `clamp(O - 0, 0, a_2)` = all of it.
    const suffixAnchoredSeq2 = O < 1_800_000n - 900_000n ? O : 900_000n;
    expect(suffixAnchoredSeq2).toBe(900_000n);
    expect(bucketOf(AS_OF, '2027-01-15', THRESHOLDS)).toBe(1); // ...in bucket 1
    // Paid-anchored puts it in bucket 4 instead.
    const got = projectInvoice(OVER_SCHEDULED_INVOICE, OVER_SCHEDULED_PLAN, AS_OF, THRESHOLDS);
    expect(got.every((x) => x.bucketNo === 4)).toBe(true);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_9', 4, 'FIRES arm ran: FIRES: the round-2 anchor is what produced the understatemen');
  });

  it('FIRES: the INDEPENDENT OVERDUE ORACLE agrees exactly where the sum law holds, and overstates where it is broken', () => {
    // THE SECOND MEASUREMENT OF THE OVERDUE COLUMN, and it is a second
    // IMPLEMENTATION rather than `f(x) === f(x)`. `unpaidDuePortion` is
    // `max(0, D - P)` over a PREFIX of the declared schedule with ONE clamp;
    // the projection is a per-row suffix-telescoping allocation with a clamp
    // per level. They share no code path, no intermediate and no helper, and
    // the projection never calls the oracle.
    //
    // WHERE THE SCHEDULE OBEYS THE SUM LAW, the telescoping identity makes the
    // two provably identical, so this is an equality and not a tolerance.
    for (const [label, invoice, plan] of [
      ['the design fixture', PLANNED_INVOICE, PLAN],
      ['the boundary fixture', BOUNDARY_INVOICE, BOUNDARY_PLAN],
    ] as const) {
      const scheduled = plan.downPaymentMinor + plan.installments.reduce((a, i) => a + i.amountTxnMinor, 0n);
      // NON-VACUITY: the equality below is only a theorem while this holds, so
      // the premise is measured and not assumed.
      expect(scheduled, `${label} must obey the sum law, or the oracle is not exact on it`).toBe(invoice.paidTxnMinor + invoice.outstandingTxnMinor);
      const contributions = projectInvoice(invoice, plan, AS_OF, THRESHOLDS);
      // THE SUBJECT IS THE SCHEDULE DATE, NOT THE BUCKET ORDINAL — and that
      // distinction is a finding this arm made on its first run. Bucket 1 is
      // the `0-30` band: it holds the NOT-YET-DUE rows AND the rows up to
      // thirty days past due, so `bucketNo > 1` is not «overdue» and summing
      // it against `max(0, D - P)` compared two different quantities (500 000
      // against 600 000 on the design fixture). The oracle's subject is money
      // whose DECLARED DATE has arrived, so the projection's matching subject
      // is its contributions' own `scheduleDate` — which also keeps this law
      // independent of `bucketOf` entirely.
      const projectedDue = sum(contributions.filter((x) => x.scheduleDate !== null && x.scheduleDate <= AS_OF));
      const oracle = unpaidDuePortion(plan, AS_OF, invoice.paidTxnMinor);
      expect(projectedDue, `${label}: the fallen-due allocation must equal max(0, D - P)`).toBe(oracle);
      // ...and the oracle is not trivially zero, or the equality is 0 === 0.
      expect(oracle > 0n, `${label}: NO SUBJECT — nothing has fallen due`).toBe(true);
      // THE BAND-LEVEL CONSEQUENCE, which is the half a reader cares about:
      // everything in an OVERDUE band is fallen-due money, so it cannot
      // exceed the fallen-due total. This is the one-sided reading of
      // proof 2's law, measured against a second implementation.
      expect(sum(contributions.filter((x) => x.bucketNo > 1)) <= oracle, `${label}: an overdue band carries more than has fallen due`).toBe(true);
    }

    // WHERE THE SUM LAW IS BROKEN ABOVE, AND THE OVER-SCHEDULED MONEY HAS
    // FALLEN DUE, the two part company — and they must. The oracle counts the
    // DECLARED dates and is bounded by nothing; the projection is bounded by
    // the authoritative outstanding and cannot report money the invoice does
    // not owe. So the disagreement is the DETECTOR of a broken schedule, and
    // the database-level verifier is what makes the state unreachable rather
    // than merely detectable (obligation (a), measured firing in
    // tests/integration/phase4-s7-installment-aging-live.test.ts §B).
    const bothOverdue: InstallmentPlan = Object.freeze({
      ...OVER_SCHEDULED_PLAN,
      installments: Object.freeze([
        Object.freeze({ seqNo: 1, dueDate: '2026-01-15', amountTxnMinor: 900_000n }),
        Object.freeze({ seqNo: 2, dueDate: '2026-02-15', amountTxnMinor: 900_000n }),
      ]),
    });
    const brokenOracle = unpaidDuePortion(bothOverdue, AS_OF, OVER_SCHEDULED_INVOICE.paidTxnMinor);
    const brokenProjected = sum(
      projectInvoice(OVER_SCHEDULED_INVOICE, bothOverdue, AS_OF, THRESHOLDS).filter((x) => x.scheduleDate !== null && x.scheduleDate <= AS_OF),
    );
    expect(brokenOracle).toBe(1_800_000n);
    // The projection reports the AUTHORITATIVE outstanding and not a penny more.
    expect(brokenProjected).toBe(OVER_SCHEDULED_INVOICE.outstandingTxnMinor);
    expect(brokenProjected).toBe(900_000n);
    expect(brokenOracle === brokenProjected, 'a broken schedule must be VISIBLE as a disagreement, not absorbed').toBe(false);
    // and conservation is NOT sacrificed to make the oracle happy: proof 1's
    // law still holds on the broken input, which is the whole reason the
    // overstatement lands on the oracle rather than on the projection.
    expect(sum(projectInvoice(OVER_SCHEDULED_INVOICE, bothOverdue, AS_OF, THRESHOLDS))).toBe(OVER_SCHEDULED_INVOICE.outstandingTxnMinor);
    recordProof('proof_9', 14, 'FIRES arm ran: the independent overdue oracle agrees where the sum law holds');
  });

  it('the two anchors AGREE exactly wherever the sum law holds, so the repair costs nothing', () => {
    // The design fixture obeys the sum law: 300 000 paid + 900 000 outstanding
    // = 1 200 000 = 12 x 100 000.
    expect(PLANNED_INVOICE.paidTxnMinor + PLANNED_INVOICE.outstandingTxnMinor).toBe(1_200_000n);
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS);
    // Instalments 4..12 outstanding, 1..3 settled — the same answer round 1
    // and round 2 gave, reached from the other end.
    expect(c.filter((x) => x.origin === 'installment').map((x) => x.seqNo)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('PR-5 RESOLVED BY DELETION: the unwired signal is gone and the verifier is the whole bound', () => {
    // The coordinator's objection was this estate's recorded defect class — a
    // name existed and no evidence read it — and it was worse than usual
    // because the unwired function was offered as the bound on ruling 1.
    // Two homes for a bound, one of them believed. Now one.
    const model = readFileSync(join(__dirname, 'phase4-s7-aging-reference-model.ts'), 'utf8');
    const code = model
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/scheduleCoherenceFindings/);
    expect(model).toMatch(/PR-5, RESOLVED BY DELETION/);
    // And the bound that remains is a DEFERRED constraint trigger, which fires
    // at COMMIT whoever writes.
    expect(SPEC).toMatch(/installment_plans_schedule_complete/);
    expect(SPEC).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    expect(SPEC).toMatch(/R-SAL-06/);
  });

  it('the sum law is owed AT DB LEVEL in all three directions, and the specification says which', () => {
    // Owner §26: below total refused, equal accepted, above total refused —
    // not TypeScript-only and not UI-only. It is a cluster run, so it is OWED
    // and named rather than asserted here.
    expect(SPEC).toMatch(/below total REFUSED/);
    expect(SPEC).toMatch(/equal to total ACCEPTED/);
    expect(SPEC).toMatch(/above total REFUSED/);
    expect(SPEC).toMatch(/OWED TO THE BOX/);
    // ...and the part that is NOT prose. A prose sentence is the failure shape
    // this estate is named for, so the reachability of both directions is
    // asserted over the DDL: a schedule can be pushed below the total by
    // DELETING a row, so a verifier that fired only on INSERT and UPDATE would
    // make one of the three directions unenforceable whatever the prose says.
    const ddl = sqlSchemaOnly(SPEC);
    const allConstraintTriggers = [...ddl.matchAll(/CREATE CONSTRAINT TRIGGER\s+(\w+)\s+([\s\S]*?)EXECUTE FUNCTION\s+(\w+)/gi)];
    // ROUND 7 F1 added two MORE deferred constraint triggers, for the invoice-
    // borne fact (specification §3a). THIS law is about the SCHEDULE verifier's
    // pair, so it selects them by the function they execute rather than by
    // counting every constraint trigger in the file — which would otherwise
    // turn a later slice's trigger into a failure of the sum law.
    const triggers = allConstraintTriggers.filter((t) => (t[3] ?? '') === 'installment_schedule_verify');
    // THREE, NOT TWO, SINCE `TL-P4-COORD-R43` F1-d. The equality reads THREE
    // relations and its RIGHT-HAND SIDE is `invoices.total_txn_minor`, which
    // `0075:561` leaves MUTABLE while the invoice is a draft. With the two
    // plan-side triggers alone the equality could be falsified from the right
    // — build a lawful schedule against a draft invoice, bump its total,
    // promote it — and the reader then refuses that receivable for ever.
    expect(triggers.length).toBe(3);
    // ...and the fact's own pair is there too, so this selection is a filter
    // and not a way of not looking.
    expect(allConstraintTriggers.filter((t) => (t[3] ?? '') === 'installment_plan_fact_verify')).toHaveLength(2);
    const onRelation = new Map(triggers.map((t) => [/\bON\s+(\w+)/i.exec(t[2] ?? '')?.[1] ?? '?', { events: t[2] ?? '', fn: t[3] ?? '' }]));
    // Both relations of the schedule, both judged by the ONE verifier.
    expect([...onRelation.keys()].sort()).toEqual(['installment_plans', 'installments', 'invoices']);
    for (const [rel, t] of onRelation) {
      expect(t.fn, rel).toBe('installment_schedule_verify');
      expect(t.events, rel).toMatch(/DEFERRABLE INITIALLY DEFERRED/i);
      expect(t.events, rel).toMatch(/AFTER[\s\S]*UPDATE/i);
      // The two SCHEDULE relations carry the INSERT arm. The `invoices` arm is
      // `UPDATE OF total_txn_minor` and NOTHING else: that one column is the
      // whole of what this relation contributes to the equality, and no plan
      // can exist for an invoice being INSERTed (`installment_plans_invoice_fk`).
      if (rel === 'invoices') {
        expect(t.events, rel).toMatch(/UPDATE\s+OF\s+total_txn_minor/i);
        expect(t.events, rel).not.toMatch(/INSERT/i);
      } else {
        expect(t.events, rel).toMatch(/AFTER[\s\S]*INSERT/i);
      }
    }
    // The row relation must also fire on DELETE — that is the direction a
    // prose-only law would have left open.
    const rowTrigger = onRelation.get('installments');
    expect(rowTrigger, 'there is no constraint trigger on installments at all').toBeDefined();
    expect(rowTrigger?.events).toMatch(/DELETE/i);
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
describe('PROOF 10 [proof_10] — the base conservation law, as a CONSEQUENCE of differencing one cumulative function', () => {
  // THE OWNER'S RULING (TL, S7 §21/§25). `source_to_base_rate` must NOT become
  // a second arithmetic authority. The base portion of a schedule boundary is
  // the canonical cumulative carrying-value law over the invoice's stored
  // monetary PAIR, differenced between the schedule's cumulative levels:
  //
  //     base_i = R(L_i) − R(L_{i−1}) = apRelease(B, Tot, L_{i−1}, alloc_i)
  //
  // The owner named the property this buys and asked for it to be proved that
  // way: the levels telescope, so
  //
  //     Σ base_i + residual_base = R(Tot) − R(P) = B − paid_base
  //                              = outstanding_base_minor
  //
  // EXACTLY — and not as a coincidence anyone has to police.
  const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE, OVER_SCHEDULED_INVOICE];
  const plans = [PLAN, SHORT_PLAN, OVER_SCHEDULED_PLAN];
  const sumBase = (xs: readonly AgingContribution[]): bigint => xs.reduce((a, x) => a + x.baseMinor, 0n);

  it('holds EXACTLY, per invoice and over the portfolio, against the authoritative base', () => {
    for (const r of rows) {
      const plan = plans.find((p) => p.invoiceId === r.invoiceId);
      expect(sumBase(projectInvoice(r, plan, AS_OF, THRESHOLDS)), r.invoiceId).toBe(r.outstandingBaseMinor);
    }
    expect(sumBase(contributionsFor(rows, plans, AS_OF, THRESHOLDS))).toBe(rows.reduce((a, r) => a + r.outstandingBaseMinor, 0n));
  });

  it('the rounding is REAL on these fixtures, so the law is not passing on exact ratios', () => {
    // `total_base 1 015 001` against `total_txn 1 200 000` is deliberately not
    // a round ratio. If it were, every per-row figure would come out exact and
    // the conservation law would hold for the WRONG reason.
    const B = PLANNED_INVOICE.paidBaseMinor + PLANNED_INVOICE.outstandingBaseMinor;
    const T = PLANNED_INVOICE.paidTxnMinor + PLANNED_INVOICE.outstandingTxnMinor;
    expect(B).toBe(1_015_001n);
    expect(T).toBe(1_200_000n);
    expect((B * 100_000n) % T).not.toBe(0n); // a per-instalment conversion rounds
    // And the paid level really is the cumulative release of the paid amount,
    // which is the identity the writers enforce (`0084`'s own note).
    expect(apRelease(B, T, 0n, PLANNED_INVOICE.paidTxnMinor)).toBe(PLANNED_INVOICE.paidBaseMinor);
    // R(Tot) = B exactly: the final cumulative release is the whole base.
    expect(apRelease(B, T, 0n, T)).toBe(B);
  });

  it('IT IS A PROPERTY OF TELESCOPING, NOT OF HALF_EVEN — proved with adversarial rounding functions', () => {
    // The owner asked for it this way. Any cumulative `R` differenced between
    // the same levels conserves, so the law does not depend on the canonical
    // law's rounding at all — which is why the canonical law can be CONSUMED
    // rather than re-stated, and why no counterexample requiring the raw rate
    // exists (§21).
    const adversarial: readonly { readonly name: string; readonly fn: ReleaseFn }[] = [
      { name: 'floor', fn: (B, T, X, a) => (B * (X + a)) / T - (B * X) / T },
      { name: 'ceil-ish', fn: (B, T, X, a) => (B * (X + a) + T - 1n) / T - (B * X + T - 1n) / T },
      { name: 'always zero', fn: () => 0n },
      { name: 'wildly nonlinear', fn: (B, T, X, a) => ((X + a) * (X + a)) / (T === 0n ? 1n : T) - (X * X) / (T === 0n ? 1n : T) },
    ];
    for (const { name, fn } of adversarial) {
      for (const r of rows) {
        const plan = plans.find((p) => p.invoiceId === r.invoiceId);
        const c = projectInvoice(r, plan, AS_OF, THRESHOLDS, CORRECT_POLICY, fn);
        const B = r.paidBaseMinor + r.outstandingBaseMinor;
        const Tot = r.paidTxnMinor + r.outstandingTxnMinor;
        // Conservation against THAT R's own endpoints: R(Tot) − R(P).
        const expected = plan === undefined || r.outstandingTxnMinor <= 0n ? r.outstandingBaseMinor : fn(B, Tot, 0n, Tot) - fn(B, Tot, 0n, r.paidTxnMinor);
        expect(sumBase(c), `${name} / ${r.invoiceId}`).toBe(expected);
      }
    }
    // ...and with the CANONICAL law those endpoints ARE the authoritative
    // figures, which is the whole point of the ruling.
    const B = PLANNED_INVOICE.paidBaseMinor + PLANNED_INVOICE.outstandingBaseMinor;
    const Tot = PLANNED_INVOICE.paidTxnMinor + PLANNED_INVOICE.outstandingTxnMinor;
    expect(apRelease(B, Tot, 0n, Tot) - apRelease(B, Tot, 0n, PLANNED_INVOICE.paidTxnMinor)).toBe(PLANNED_INVOICE.outstandingBaseMinor);
  });

  it('`source_to_base_rate` appears in NO arithmetic, anywhere in this design', () => {
    const model = readFileSync(join(__dirname, 'phase4-s7-aging-reference-model.ts'), 'utf8');
    const code = model
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/source_to_base_rate|sourceToBaseRate/);
    expect(sqlCodeOnly(SPEC)).not.toMatch(/source_to_base_rate/);
    // It is named in prose only — valid immutable invoice metadata for
    // display, audit and traceability, and never a carrying-allocation
    // primitive.
    expect(SPEC).toMatch(/source_to_base_rate/);
  });

  it('the canonical law is CONSUMED, never re-implemented — R-81, and the owner said so', () => {
    expect(CANONICAL_RELEASE).toBe(apRelease);
    const model = readFileSync(join(__dirname, 'phase4-s7-aging-reference-model.ts'), 'utf8');
    expect(model).not.toMatch(/function\s+roundHalfEven/);
    // And the SQL calls the SQL twin rather than restating it.
    const sketch = sqlSchemaOnly(projectionSketch(SPEC));
    expect(sketch).toMatch(/public\.supplier_ap_release\(/);
    expect(sketch).not.toMatch(/inventory_half_even/);
    expect(SPEC).toMatch(/0067:683/);
  });

  it('FIRES under its mutation: each row converted on its own, at the row grain', () => {
    // The second rounding at the second grain this design exists to refuse.
    const m = mutate('baseAllocation', 'per_row_conversion');
    const c = projectInvoice(PLANNED_INVOICE, PLAN, AS_OF, THRESHOLDS, m);
    expect(sumBase(c)).not.toBe(PLANNED_INVOICE.outstandingBaseMinor);
    // Nine instalments, each rounded down by the same fraction: the drift is
    // small, which is exactly why a law that did not assert EXACT equality
    // would never have found it.
    expect(PLANNED_INVOICE.outstandingBaseMinor - sumBase(c)).toBe(4n);
    // The txn side is untouched, so only the base law can see this.
    expect(sum(c)).toBe(PLANNED_INVOICE.outstandingTxnMinor);
    // THE DATA FLOW TO THE META GATE: recorded AFTER the assertions, so a
    // proof that does not RUN does not record and the gate goes red. A tag in
    // a comment cannot satisfy this; `describe.skip` cannot satisfy it.
    recordProof('proof_10', 3, 'FIRES arm ran: FIRES under its mutation: each row converted on its own, at ');
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

    // ── (a) WHAT WAS WRONG WITH (a), AND IT WAS WRONG TWICE ────────────
    //
    // Round 2's version wrote `proof:` and never read it (challenger H-4).
    // Round 3's version READ it — `expect(SELF).toContain(\`[${'$'}{m.proof}]\`)` —
    // and that is still only a TEXTUAL relationship. The proof engineer
    // measured it: delete the whole FIRES block for `proof_4`, append a
    // comment naming it, and both assertions pass. `describe.skip` passes. A
    // body replaced by `expect(true).toBe(true)` passes. That is this
    // estate's «a comment is not evidence» trap, live, in the gate that
    // exists to prevent it.
    //
    // It is replaced by TWO relationships, neither of them prose, and
    // `meta_9` proves both are red-capable.
    for (const m of MUTATIONS_EXERCISED) {
      expect(
        MANDATORY.some((x) => x.id === m.proof),
        `proof ${m.proof} is not declared mandatory`,
      ).toBe(true);
    }

    // ── (b) EACH KNOB IS ACTUALLY MUTATED SOMEWHERE IN THIS FILE ────────
    for (const k of POLICY_KNOBS) {
      expect(SELF, `knob ${k.knob} is never passed to mutate()`).toContain(`mutate('${k.knob}'`);
    }

    // ── (c) AND NO MORE KNOBS ARE MUTATED THAN ARE REGISTERED ───────────
    const mutatedInSource = new Set([...SELF.matchAll(/mutate\('([A-Za-z]+)'/g)].map((x) => x[1] as string));
    expect([...mutatedInSource].sort()).toEqual([...known].sort());

    // ── (d) Every proof claims a DISTINCT knob ─────────────────────────
    expect(new Set(MUTATIONS_EXERCISED.map((m) => m.knob)).size).toBe(MUTATIONS_EXERCISED.length);

    // ── (e) AND THE REGISTRY COVERS THE PROOFS THAT HAVE NO KNOB ────────
    //
    // Proofs 6, 7, 8 and 9 were OUTSIDE `MUTATIONS_EXERCISED` entirely,
    // because their mutations are planted into SQL text rather than reached
    // through a policy knob. So «remove proof A» had NO COVERAGE for four of
    // the seven required proofs: deleting proof 6 or proof 9 outright left
    // every `meta_*` test green. The mandatory table below is keyed on the
    // PROOF, not on the knob, so a proof without a knob is covered too.
    const knobbed = new Set(MUTATIONS_EXERCISED.map((m) => m.proof));
    const knobless = MANDATORY.filter((m) => !knobbed.has(m.id)).map((m) => m.id);
    expect(knobless.sort()).toEqual(['proof_6', 'proof_7', 'proof_8', 'proof_9']);
  });

  it('meta_1a: THE RUNTIME LEDGER — a proof that did not RUN did not record, and the gate reads the record', () => {
    // A DATA FLOW, not a string search. `recordProof` is called from inside
    // each mandatory proof's mutation arm AFTER its assertions, so the entry
    // exists only if those assertions passed. This test runs last in the
    // file, so every arm has had its chance.
    const led = proofLedger();
    for (const m of MANDATORY) {
      const entry = led.get(m.id);
      expect(entry, `${m.id} never recorded — it did not run, or it did not reach its record`).toBeDefined();
      if (entry === undefined) throw new Error(`${m.id} never recorded — it did not run, or it did not reach its record`);
      expect(entry.assertions, `${m.id} recorded ${String(entry.assertions)} assertions`).toBeGreaterThanOrEqual(m.minAssertions);
      expect(entry.detail.length).toBeGreaterThan(10);
    }
    // Every ledger entry belongs to a declared proof, so a proof cannot
    // record itself into existence under a name nothing requires.
    for (const id of led.keys()) {
      expect(
        MANDATORY.some((m) => m.id === id),
        `${id} recorded but is not mandatory`,
      ).toBe(true);
    }
    expect(led.size).toBeGreaterThanOrEqual(MANDATORY.length);
  });

  it('meta_1b: THE STRUCTURAL AUDIT — the describe, the arms, the arm COUNT, the call sites and the floor', () => {
    // The second relationship, and the one that survives a file that fails to
    // load: the auditor masks comments AND regex literals while preserving
    // string contents, locates `describe`/`it` by BALANCED call rather than
    // by indentation, and detects `skip`/`todo`/`xit`/`skipIf`.
    const findings = auditProofFile(SELF, MANDATORY);
    expect(findings.map((f) => `${f.proof}/${f.kind}: ${f.detail}`)).toEqual([]);
  });

  it('meta_9: THE GATE IS RED-CAPABLE — every way of hollowing out a proof is refused', () => {
    // «A green gate with no authority» is this estate's named failure, and a
    // gate nobody has seen go red is one. Each case below is the gate's own
    // subject, mutated in memory; the file on disk is untouched.
    const target = 'proof_4';
    const decl = MANDATORY.find((m) => m.id === target);
    expect(decl).toBeDefined();

    const describeAt = SELF.indexOf(`describe('PROOF 4 [${target}]`);
    expect(describeAt).toBeGreaterThan(-1);

    // (i) THE COMMENT CASE, exactly as the proof engineer measured it: delete
    //     the whole mutation arm and append a comment naming the proof. The
    //     old textual gate passed this.
    const armAt = SELF.indexOf("  it('FIRES under its mutation: the residual is dropped'", describeAt);
    expect(armAt).toBeGreaterThan(describeAt);
    const armEnd = SELF.indexOf('\n  });', armAt) + '\n  });'.length;
    const armDeleted = `${SELF.slice(0, armAt)}${SELF.slice(armEnd)}\n// a comment naming [${target}] and mutate('carryResidual'\n`;
    expect(armDeleted).toContain(`[${target}]`); // the OLD gate's test, still green
    expect(armDeleted).toContain("mutate('carryResidual'"); // and this one too
    expect(auditProofFile(armDeleted, MANDATORY).map((f) => f.kind)).toContain('arm_missing');

    // (ii) `describe.skip` — the tag is still in the file, so the textual
    //      gate is still green and the proof still does not run.
    const skipped = SELF.replace(`describe('PROOF 4 [${target}]`, `describe.skip('PROOF 4 [${target}]`);
    expect(skipped).toContain(`[${target}]`);
    expect(auditProofFile(skipped, MANDATORY).map((f) => f.kind)).toContain('disabled');

    // (iii) THE HOLLOWED BODY: the arm exists, is live, is named right, and
    //       asserts only literals.
    const hollow =
      SELF.slice(0, armAt) + "  it('FIRES under its mutation: the residual is dropped', () => {\n    expect(true).toBe(true);\n  });" + SELF.slice(armEnd);
    const hollowKinds = auditProofFile(hollow, MANDATORY).map((f) => f.kind);
    expect(hollowKinds.some((k) => k === 'unconditional_pass' || k === 'too_few_assertions' || k === 'call_site_missing')).toBe(true);

    // (iv) THE ARM COUNT. An auditor reading only the FIRST matching arm
    //      stayed green when one of proof_6's three arms was deleted —
    //      measured, and the reason the count is DECLARED rather than
    //      counted. Losing one red arm is losing one mutation.
    const six = MANDATORY.find((m) => m.id === 'proof_6');
    // FOUR since the S7-5 repair added a fourth statement-shape arm. The
    // declared count moves with the file IN THE SAME CHANGE, which is the
    // discipline the fail-closed coupling requires (design document §17.8).
    expect(six?.arms).toBe(4);
    const sixArm = SELF.indexOf("  it('FIRES under its mutation: a NEW reducer relation, discovered by its SHAPE and not its name'");
    expect(sixArm).toBeGreaterThan(-1);
    const sixEnd = SELF.indexOf('\n  });', sixArm) + '\n  });'.length;
    const oneArmGone = SELF.slice(0, sixArm) + SELF.slice(sixEnd);
    expect(auditProofFile(oneArmGone, MANDATORY).map((f) => f.kind)).toContain('arm_count_short');

    // (v) AND THE UNMUTATED FILE IS CLEAN, so none of the above passes for
    //     want of a working auditor.
    expect(auditProofFile(SELF, MANDATORY)).toEqual([]);
  });

  it('meta_2: every mutation actually CHANGES the output — an inert mutation proves nothing', () => {
    const rows = [PLANNED_INVOICE, PLAINLESS_INVOICE, SHORT_SCHEDULE_INVOICE, OVER_SCHEDULED_INVOICE];
    const plans = [PLAN, SHORT_PLAN, OVER_SCHEDULED_PLAN];
    // The over-scheduled fixture is in the portfolio because it is what makes
    // the upper-clamp mutation bite at all; without it that mutation is
    // measurably INERT, which is this very law's job to catch.
    const baseline = JSON.stringify(
      projectCustomerAging(rows, plans, AS_OF, THRESHOLDS).map((b) => [b.bucketNo, b.currencyCode, String(b.txnMinor), b.invoiceCount, String(b.baseMinor)]),
    );
    for (const m of MUTATIONS_EXERCISED) {
      const plan5 = m.knob === 'outstandingSource' ? [{ ...PLAN, planLocalCollectedMinor: 300_000n }, SHORT_PLAN, OVER_SCHEDULED_PLAN] : plans;
      // A mutation that REFUSES has changed the output as surely as one that
      // returns different numbers — `clampToRowAmount` is refused by the
      // canonical release law's own guard (proof 1).
      let got: string;
      try {
        got = JSON.stringify(
          projectCustomerAging(rows, plan5, AS_OF, THRESHOLDS, mutate(m.knob, m.to)).map((b) => [
            b.bucketNo,
            b.currencyCode,
            String(b.txnMinor),
            b.invoiceCount,
            String(b.baseMinor),
          ]),
        );
      } catch {
        got = 'REFUSED';
      }
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
    const tiedRow: OpenInvoiceRow = {
      invoiceId: 'inv-tie',
      currencyCode: 'SAR',
      dueDate: '2026-03-01',
      outstandingTxnMinor: 50_000n,
      paidTxnMinor: 50_000n,
      paidBaseMinor: 42_251n,
      outstandingBaseMinor: 42_252n,
    };
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
    expect(allocation).toMatch(/cumulative \+= r\.amount/); // really the allocation
    expect(allocation).not.toMatch(/Math\.(round|floor|ceil|trunc)/);
    expect(allocation).not.toMatch(/\btoFixed\b/);
    expect(allocation).not.toMatch(/Number\(/);
    // No division at all over money in the TXN allocation: no ratio, no
    // proration, no residue to distribute, no quotient to round.
    expect([...allocation.matchAll(/[^*/\n]\/[^*/\n]/g)].map((m) => m[0])).toEqual([]);

    // THE BASE SIDE HAS EXACTLY ONE ROUNDING AND THIS FILE DOES NOT WRITE IT.
    // It is `apRelease`'s HALF_EVEN, consumed from
    // `packages/inventory/src/supplier-settlement.ts:89` — «the twin of
    // `supplier_ap_release`» — because a second body would be a second
    // financial truth (R-81, and the owner's ruling). The allocation calls
    // `release(...)` and states no rounding of its own.
    expect(allocation).toMatch(/release\(totalBase, totalTxn,/);
    expect(model).toMatch(/import \{ apRelease \} from '\.\.\/\.\.\/inventory\/src\/supplier-settlement'/);
    const modelCode = strip(model);
    expect(modelCode).not.toMatch(/function\s+roundHalfEven/);
    // THE SIXTH OCCURRENCE OF THE SAME LESSON, kept for the same reason as the
    // other five: this assertion read the WHOLE FILE, so the moment the
    // header stated the law as `R(x) = HALF_EVEN(B·x, T)` — which is what
    // documenting a consumed law looks like — a law about implementation went
    // red on a definition. The subject is CODE. Prose may name the law; code
    // may not restate it.
    expect(modelCode).not.toMatch(/HALF_EVEN/);
    expect(model).toMatch(/HALF_EVEN\(B/); // and the prose really does name it
    expect(CANONICAL_RELEASE).toBe(apRelease);

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

  it('meta_8: the SUBJECT EXTRACTORS are not quietly deleting the evidence', () => {
    // A law whose subject extractor returns nothing passes for free, and this
    // file now has three extractors. Each is measured against a fixture whose
    // answer is known, so a future "fix" that widens the stripping is caught
    // here rather than by a green proof over an empty string.
    const fixture = [
      '-- a comment naming accounting_source_type and now() and source_to_base_rate',
      'CREATE TABLE t (created_at TIMESTAMPTZ NOT NULL DEFAULT now());',
      "COMMENT ON TABLE t IS 'prose naming accounting_source_type, now() and source_to_base_rate; it''s data.';",
      'CREATE FUNCTION f() RETURNS BIGINT LANGUAGE sql AS $fn$ SELECT public.supplier_ap_release(1, 2, 0, 1) $fn$;',
    ].join('\n');

    // ROUND 11 F-8, THE INVERSION, ANSWERED BY A FIXTURE WHOSE ANSWER IS
    // KNOWN. One `--` inside a `COMMENT ... IS '...'` literal used to delete
    // that literal's closing quote, and from there the quote parse was one
    // literal out of step for the rest of the file: the `CREATE INDEX` below
    // was read as the INSIDE of a string and blanked, so a law naming it went
    // green over nothing. The hazard is a PARITY hazard, so it is measured as
    // one: the statement AFTER the planted comment must survive both
    // extractors, and the prose before it must survive neither.
    const planted = [
      "COMMENT ON TABLE t IS 'this literal contains -- two hyphens and then more prose';",
      'CREATE UNIQUE INDEX t_live_uq ON t (id) WHERE status = 1;',
      "COMMENT ON INDEX t_live_uq IS 'another literal -- with another pair';",
      'CREATE INDEX t_other_ix ON t (created_at);',
    ].join('\n');
    const plantedCode = sqlCodeOnly(planted);
    const plantedSchema = sqlSchemaOnly(planted);
    for (const [name, projected] of [
      ['sqlCodeOnly', plantedCode],
      ['sqlSchemaOnly', plantedSchema],
    ] as const) {
      expect(projected, `${name} lost a statement to a -- inside a literal`).toContain(
        'CREATE UNIQUE INDEX t_live_uq ON t (id) WHERE status = 1;',
      );
      expect(projected, `${name} lost the statement after the second literal`).toContain(
        'CREATE INDEX t_other_ix ON t (created_at);',
      );
    }
    // ...and the literal's prose is still DATA to a code law, which is the
    // property the inversion silently took away.
    expect(plantedCode).not.toMatch(/two hyphens and then more prose/);
    expect(plantedCode).not.toMatch(/with another pair/);
    expect(plantedCode).toMatch(/COMMENT ON TABLE t IS ''/);
    expect(plantedCode).toMatch(/COMMENT ON INDEX t_live_uq IS ''/);
    // A schema law keeps the literal, and keeps ALL of it -- the old stripper
    // truncated it at the hyphens, which is how the closing quote went.
    expect(plantedSchema).toContain("'this literal contains -- two hyphens and then more prose'");

    // `sqlSchemaOnly` drops the `--` comment and keeps both statements.
    const schema = sqlSchemaOnly(fixture);
    expect(schema).not.toMatch(/a comment naming/);
    expect(schema).toMatch(/DEFAULT now\(\)/);
    expect(schema).toMatch(/COMMENT ON TABLE/); // the literal is still there

    // `sqlCodeOnly` additionally blanks the literal — and KEEPS the
    // dollar-quoted body, which is the half that matters.
    const code = sqlCodeOnly(fixture);
    expect(code).not.toMatch(/prose naming/);
    expect(code).not.toMatch(/source_to_base_rate/);
    expect(code).not.toMatch(/accounting_source_type/);
    expect(code).toMatch(/COMMENT ON TABLE t IS ''/); // the SHAPE survives
    expect(code).toMatch(/DEFAULT now\(\)/); // real DDL outside a literal
    expect(code).toMatch(/SELECT public\.supplier_ap_release\(1, 2, 0, 1\)/);
    expect(code).toMatch(/\$fn\$/);
    // It is not a `.replace(/.*/, '')`. The specification is mostly `--`
    // prose, so a FRACTION of the file is the wrong measure; the right one is
    // that every executable statement survives intact.
    const specCode = sqlCodeOnly(SPEC);
    expect(sqlCodeOnly(projectionSketch(SPEC))).toContain('public.supplier_ap_release(');
    for (const stmt of [
      'CREATE OR REPLACE FUNCTION customer_ar_aging',
      'public.supplier_ap_release(',
      'CREATE TABLE installment_plans',
      'CREATE TABLE installments',
      'CREATE UNIQUE INDEX installment_plans_one_active_per_invoice_uq',
      'CREATE CONSTRAINT TRIGGER installments_schedule_complete',
      'ALTER TABLE installments ENABLE ROW LEVEL SECURITY',
      'GRANT EXECUTE ON FUNCTION customer_ar_aging',
    ]) {
      expect(specCode, `sqlCodeOnly dropped ${stmt}`).toContain(stmt);
    }

    // `projectionSketch` returns the whole delimited body and nothing else.
    const sketch = projectionSketch(SPEC);
    expect(sketch).toMatch(/^\s*CREATE OR REPLACE FUNCTION customer_ar_aging/);
    expect(sketch.trimEnd()).toMatch(/\$fn\$;$/);
    expect(sketch).not.toMatch(/CREATE TABLE/); // the DDL above the markers
    expect(sketch).not.toMatch(/COMMENT ON FUNCTION/); // the prose below them
    expect(sketch.length).toBeGreaterThan(2_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('ROUND-5 CHALLENGE C1 / H4 / H6 — the policy set, the fail-closed arm, and the ORDER law', () => {
  /** `0075`'s own declared policy-name sets, PARSED OUT OF `0075`, never typed here. */
  function declaredPolicySets(): { readonly ordinary: readonly string[]; readonly source: readonly string[] } {
    const predecessor = MIGRATIONS.find((m) => m.name.startsWith('0075_'));
    expect(predecessor, 'NO SUBJECT: 0075 is not on disk, so there is nothing to derive from').toBeDefined();
    const sql = predecessor?.sql ?? '';
    const grab = (name: string): readonly string[] => {
      const m = new RegExp(`${name}\\s+CONSTANT TEXT\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(sql);
      expect(m, `0075 no longer declares ${name}, so this law has lost its oracle`).not.toBeNull();
      return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort();
    };
    return { ordinary: grab('c_ordinary'), source: grab('c_source') };
  }

  it("C1.b THE POLICY-NAME SET IS `0075`'s OWN `c_source`, DERIVED AND NOT ENUMERATED, on BOTH relations", () => {
    // THE DEFECT THIS ARM EXISTS FOR. The first version of §2a shipped SIX
    // policies per relation — `c_source` minus `inventory_internal_read` — a
    // set matching NEITHER shape `0075` declares, with the omitted name taken
    // from INSIDE the range §2a cites and immediately above the one it copied.
    // Three readers compared the block against prose. Nothing compared it
    // against `0075`'s own constant, which is what this does.
    const { ordinary, source } = declaredPolicySets();
    expect(source.length).toBe(7);
    expect(ordinary.length).toBe(6);
    // NON-VACUITY: the two sets really differ by the one name, or "equals
    // c_source" would be satisfied by "equals c_ordinary" too.
    expect(source.filter((n) => !ordinary.includes(n))).toEqual(['accounting_validator']);
    expect(ordinary.filter((n) => !source.includes(n))).toEqual([]);

    const ddl = sqlSchemaOnly(SPEC);
    for (const relation of ['installment_plans', 'installments']) {
      const names = [...ddl.matchAll(new RegExp(`CREATE POLICY\\s+(\\w+)\\s+ON\\s+${relation}\\b`, 'g'))].map((m) => m[1] as string).sort();
      expect(names, `the policies on ${relation} are not 0075's declared c_source set`).toEqual([...source]);
    }
  });

  it('C1.c the two UNCONDITIONAL reads name their own roles, so no principal is left asymmetric', () => {
    const ddl = sqlSchemaOnly(SPEC);
    // A policy of the right NAME granted to the wrong role satisfies the
    // inventory above and leaves the asymmetry the inventory exists to close.
    for (const [policy, role] of [
      ['inventory_internal_read', 'daftar_inventory_internal'],
      ['accounting_validator', 'daftar_accounting_internal'],
    ] as const) {
      const hits = [...ddl.matchAll(new RegExp(`CREATE POLICY\\s+${policy}\\s+ON\\s+(\\w+)\\s+FOR SELECT TO\\s+(\\w+)\\s+USING \\(true\\)`, 'g'))];
      expect(hits.map((m) => m[1]).sort(), `${policy} is not on both relations in the unconditional form`).toEqual(['installment_plans', 'installments']);
      for (const m of hits) expect(m[2], `${policy} names the wrong role`).toBe(role);
    }
  });

  it('C1.a THE NO-PLAN ARM IS KEYED ON THE INVOICE ROW, and no routine certifies its own read reach (round 7 F1)', () => {
    // THIRD ROUND OF ONE DEFECT. `NOT EXISTS` through the caller's row
    // security; then a `SECURITY DEFINER` count whose own blindness read as
    // zero; then a `pg_policy` assertion whose checked properties were not the
    // properties that decide whether a role can see a row — satisfied by
    // `tenant_membership` re-created with every token it looked for plus one
    // extra conjunct, which excluded every row.
    //
    // `TL-P4-COORD-R38`: A READER CANNOT CERTIFY ITS OWN VISIBILITY. So the
    // fact lives on the invoice row (specification §2c) and the arm reads it
    // from there. The DATABASE half of this law — the three attacks
    // reproduced and then closed on one fixture — is
    // `tests/integration/phase4-s7-installment-fact-db.test.ts` §E. This is
    // its text-level twin, and the text is the subject that can be edited
    // without a database.
    const sketch = projectionSketch(SPEC);
    const code = sqlCodeOnly(SPEC);

    // THE RETIRED GUARD IS DELETED, not weakened and not kept beside the
    // column: a retired guard left in place is a second answer to a question
    // with one answer, and the next author would believe the wrong one.
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION installment_plan_visibility_assert/);
    expect(code).not.toContain('installment.plan_guard_blind');
    expect(code).not.toContain('installment_plan_absence_guard');
    expect(code).not.toContain('installment.plan_invisible');
    // AND NOTHING READS `pg_policy` AT READ TIME ANY MORE. The whole family of
    // repairs this closes is "inspect the policy catalogue from inside the
    // reader", so its absence from the read path is the law.
    // ...and the absence is judged over CODE. `projectionSketch` strips only a
    // comment that starts at column 0, so the body's own indented `--`
    // sentences survive — and this law's first version went red on its own
    // explanation of why there is no `pg_policy` read. The subject of a code
    // law is code: the fifth occurrence of this file's oldest lesson, now in a
    // law written to retire a guard.
    const sketchCode = sketch
      .split('\n')
      .map((l) => l.replace(/^\s*--.*$/, ''))
      .join('\n');
    expect(sketchCode).toContain('customer_ar_aging');
    expect(sketchCode).not.toContain('pg_policy');
    expect(sketchCode).not.toContain('polroles');
    expect(sketchCode).not.toContain('has_table_privilege(');

    // THE ARM IS KEYED ON THE COLUMN, and the `NOT EXISTS` it replaced is gone
    // from the arm. Keeping both would reintroduce the relation whose
    // invisibility is the defect.
    expect(sketchCode).toContain('WHERE NOT oi.flagged');
    expect(sketchCode).toContain('x.has_active_installment_plan AS flagged');
    // ...over CODE again, and this is the SECOND time inside this one law: the
    // `no_plan` CTE's own comment QUOTES the `NOT EXISTS` it replaced, because
    // recording what was removed is how the next author learns not to put it
    // back. A law that read that sentence as the thing itself would force the
    // explanation out of the file.
    expect(sketchCode).not.toMatch(/NOT EXISTS \(SELECT 1 FROM active_plan/);

    // THE FIVE REFUSALS THAT REMAIN, each with its own name — a law that
    // asserts "it refused" rather than "it refused THIS" is satisfied by a
    // routine that refuses everything.
    //
    // THREE OF THEM UNTIL `TL-P4-COORD-R50`, AND THREE WAS NOT ENOUGH. The
    // fourth is the bound the reader's own arithmetic is predicated on — at
    // most one active plan per invoice — measured as a COUNT over the rows
    // the caller can see, because with the partial unique index present but
    // `indisvalid`/`indisready` false two ORDINARY CONCURRENT plan creations
    // committed two active plans and this reader then served the
    // pre-installment figure byte-identical to the no-plan answer with no
    // refusal at all. The fifth is `pg_trigger.tgenabled` over the seven
    // triggers that maintain the fact and judge obligation (a): that column
    // occurred ZERO times in this specification, so all seven could be
    // disabled with the apply-time ratchet still reporting OK.
    expect(code).toContain('installment.plan_fact_unreadable');
    expect(code).toContain('installment.plan_fact_unflagged');
    expect(code).toContain('installment.plan_schedule_unreadable');
    expect(code).toContain('installment.plan_active_unbounded');
    expect(code).toContain('installment.plan_fact_untrusted');
    expect(sketch).toContain('installment_plan_fact_assert(');

    // AND THE REFUSAL IS TOLD FIVE NUMBERS, never asked about a row. Round 6
    // pinned `pronargs = 0` for that reason; this pins the TYPES instead,
    // because five `bigint`s name no row, no business and no tenant.
    expect(code).toMatch(
      /CREATE OR REPLACE FUNCTION installment_plan_fact_assert\(p_unreadable_plan BIGINT,\s*p_unflagged_plan BIGINT,\s*p_unreadable_schedule BIGINT,\s*p_unbounded_plan BIGINT,\s*p_untrusted_fact BIGINT\)\s*RETURNS BOOLEAN\s*LANGUAGE plpgsql STABLE SECURITY INVOKER/,
    );
    expect(code).not.toMatch(/installment_plan_fact_assert\s*\([^)]*UUID/);
    expect(code).toContain(
      "p.proargtypes = ARRAY['bigint'::regtype, 'bigint'::regtype, 'bigint'::regtype,\n                                 'bigint'::regtype, 'bigint'::regtype]::oidvector",
    );

    // THE FOURTH COUNT IS A `count(*)` GROUPED PER INVOICE AND NOT A `FILTER`
    // OVER THE JOIN, because the join is exactly what multiplies in the state
    // it measures: a `FILTER` would count the invoice once per active plan
    // and the number in the refusal would be the harm's own doubling.
    expect(sketchCode).toMatch(/GROUP BY v2\.invoice_id\s*HAVING pg_catalog\.count\(\*\) > 1/);
    // AND THE FIFTH READS `tgenabled` FROM `pg_trigger`, joined through
    // `pg_proc` BY NAME: a `::regprocedure` cast RAISES when the routine is
    // absent, which would turn a missing routine into an unrelated 42883 from
    // the middle of an arithmetic CTE.
    expect(sketchCode).toContain("t.tgenabled = 'O'");
    expect(sketchCode).toContain('pg_catalog.pg_trigger');
    expect(sketchCode).not.toMatch(/installment_plan_fact_sync\(\)'::regprocedure[\s\S]{0,80}tgfoid/);
    // `GREATEST` IS SYNTAX AND NOT A FUNCTION, exactly like `COALESCE`, so it
    // may not be schema-qualified — the one trap this estate records about the
    // pinned-search_path idiom, and the reason this law exists beside the one
    // above it.
    expect(sketchCode).not.toContain('pg_catalog.greatest');
    expect(sketchCode).toContain('greatest(0, 7 -');

    // THE FACT IS MAINTAINED AND VERIFIED BY THIS SLICE, on both sides, and
    // the verifier is DEFERRED while the writer is NOT.
    expect(code).toMatch(/CREATE TRIGGER installment_plans_fact_sync\s+AFTER INSERT OR UPDATE OR DELETE ON installment_plans\s+FOR EACH ROW/);
    expect(code).toMatch(/CREATE CONSTRAINT TRIGGER installment_plans_fact_agrees[\s\S]{0,200}DEFERRABLE INITIALLY DEFERRED/);
    expect(code).toMatch(/CREATE CONSTRAINT TRIGGER invoices_installment_fact_agrees\s+AFTER INSERT OR UPDATE OF has_active_installment_plan ON invoices/);
    expect(code).toContain('installment.plan_fact_desynchronised');
    expect(code).toContain('installment.plan_fact_unwritable');

    // THE WRITE AUTHORITY IS ONE COLUMN AND ONE PRINCIPAL.
    expect(code).toContain('GRANT UPDATE (has_active_installment_plan) ON invoices TO daftar_accounting_internal;');
    expect(code).not.toMatch(/GRANT UPDATE ON invoices/);

    // ...and the projection ITSELF stays INVOKER and STABLE: R-P4-07 makes a
    // reader run as its caller, and making the reader a DEFINER would have
    // been the other, worse repair.
    expect(sketch).toMatch(/customer_ar_aging\([\s\S]*?LANGUAGE sql STABLE/);
    expect(sketch).not.toContain('SECURITY DEFINER');
  });

  it('C1.b THE SCHEDULE RELATION IS JUDGED BY ARITHMETIC, not by existence (round 8 F1-a)', () => {
    const code = sqlCodeOnly(SPEC);
    const sketch = projectionSketch(SPEC);
    const sketchCode = sketch
      .split('\n')
      .map((l) => l.replace(/^\s*--.*$/, ''))
      .join('\n');

    // `TL-P4-COORD-R41`: direction (d) was applied to ONE of the TWO second
    // relations. `installments` is the other one, and its PARTIAL invisibility
    // was invisible to a `NOT EXISTS` — which fires only when EVERY row is
    // hidden. The replacement is section 3 obligation (a) read backwards: the
    // declared schedule of an active plan sums EXACTLY to the invoice's own
    // stored total, so a visible sum that differs is proof of hidden rows.
    expect(sketchCode).toContain('visible_schedule AS (');
    expect(sketchCode).toContain('x.total_txn_minor AS declared_total');
    expect(sketchCode).toMatch(/AND \(s\.visible_rows = 0\s*\n\s*OR s\.visible_total <> i\.declared_total\)/);
    // THE OPERAND COMES OFF THE GOVERNING ROW, not from the money call. The
    // obligation is written against the COLUMN and the constraint trigger
    // judges the COLUMN, so comparing against `paid + outstanding` would make
    // two correct figures disagreeing look like a hidden row.
    expect(sketchCode).not.toMatch(/visible_total <> oi\.total_txn_minor/);
    // AND THE RETIRED EXISTENCE TEST IS GONE FROM THE CODE. Judged over code,
    // because the CTE's own comment DESCRIBES the retired shape — it must not
    // QUOTE it, since section 2b's ratchet searches `prosrc` and `prosrc`
    // holds comments too. Sixth occurrence of this file's oldest lesson.
    expect(sketchCode).not.toMatch(/NOT EXISTS \(SELECT 1 FROM public\.installments/);

    // THE RATCHET IS NO LONGER A SUBSTRING TEST AT ALL, and this is where the
    // change lands (`TL-P4-COORD-R46`, extended by `TL-P4-COORD-R50` ordered
    // item 4). The previous version of this law pinned
    // `c.code LIKE '%visible_schedule%'` and friends — a comment-stripped
    // `prosrc` search — and the round-11 challenger defeated the stripped
    // version too, with no comment and no dead code: a VARIABLE RENAME. The
    // binding law is that a `LIKE` cannot establish a property of code and a
    // `NOT LIKE` cannot establish the ABSENCE of one, because an identifier is
    // also a string, and no amount of stripping repairs that.
    //
    // So the apply-time instrument is now a BODY IDENTITY over catalogue DATA:
    // `sha256(convert_to(p.prosrc, 'UTF8'))` compared against the digest this
    // migration ships, for each of the five routines. A renamed body has a
    // different digest whatever it is named, and the property the old ratchet
    // was reaching for is proved BY EXECUTION in
    // `tests/integration/phase4-s7-installment-fact-db.test.ts` §F6 and
    // `tests/integration/phase4-s7-installment-concurrency-db.test.ts` §C.
    // H7 below holds the digests current; this law holds the SHAPE present.
    expect(code).toContain("pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8'))");
    expect(code).toContain('c_bodies');
    expect(code, 'a substring ratchet came back').not.toMatch(/\bcode\s+(NOT\s+)?LIKE\s+'%/);
    expect(code, 'a raw prosrc substring law came back').not.toMatch(/\bprosrc\s+(NOT\s+)?LIKE\s+'/);

    // AND THE COMPLETENESS THE TEST RESTS ON IS DECLARED, not assumed: every
    // hidden row moves the sum only because no instalment may be worth zero.
    expect(code).toContain('CHECK (amount_txn_minor >= 1)');
  });

  it("C1.c THE FACT'S WRITER DOES NOT DECIDE IT BY A READ THAT CAN BE BLINDED (round 8 F1-b)", () => {
    const code = sqlCodeOnly(SPEC);

    // `TL-P4-COORD-R41`: the sync decided the fact with a `SECURITY DEFINER`
    // `EXISTS` over `installment_plans`, and the verifier repeated the
    // IDENTICAL read — so the COMMIT-time check compared a blinded reading
    // against a column written from the same blinded reading, and the two
    // could not disagree. `installment_plans` is FORCE ROW LEVEL SECURITY, so
    // no principal short of `rolbypassrls` has an unblindable read of it.
    expect(code).toContain('ALTER TABLE installment_plans FORCE ROW LEVEL SECURITY;');

    // ROUND 9'S FLOOR IS GONE, AND THAT IS THE SUBJECT OF THIS LAW NOW
    // (`TL-P4-COORD-R43`, F1-c). `v_asserted` was scoped to «the handed row
    // asserts an ACTIVE plan on this invoice» while the write it guarded was
    // scoped to the invoice, so a NON-ACTIVE plan write carried NO floor and
    // still took its value from the blindable recomputation. The challenger
    // committed `{flag: false, truth: true, plans: 2}` through it with an
    // ordinary cancelled plan, which the PARTIAL unique index permits.
    const sync = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION installment_plan_fact_sync()'));
    const syncBody = sync.slice(0, sync.indexOf('CREATE OR REPLACE FUNCTION installment_plan_fact_verify()'));
    expect(syncBody, 'round 9 floor still present').not.toContain('v_asserted');

    // THE WRITE SET IS DERIVED FROM THE TRANSITION, from `NEW.status` and
    // `OLD.status` and nothing read, and it is EMPTY for a transition that
    // determines nothing.
    expect(syncBody).toMatch(/v_is\s*:=\s*\(NEW\.status = 'active'\);/);
    expect(syncBody).toMatch(/v_was\s*:=\s*\(OLD\.status = 'active'\);/);
    expect(syncBody).toMatch(/v_invoices UUID\[\]\s*:= ARRAY\[\]::UUID\[\];/);
    // The value written is `v_value`, taken from the derived array, and never
    // `v_state` — which is what makes the recomputation unable to decide.
    expect(syncBody).toMatch(/SET has_active_installment_plan = v_value/);
    expect(syncBody, 'the recomputation is still writing the fact').not.toMatch(/SET has_active_installment_plan = v_state/);

    // THE RECOMPUTATION SURVIVES AS A CROSS-CHECK THAT MAY ONLY REFUSE, AND
    // ITS TWO DIRECTIONS NOW CARRY DIFFERENT NAMES (`TL-P4-COORD-R46`, F-4).
    // One `IS DISTINCT FROM` under one name was a FALSE DIAGNOSIS in one of
    // the two directions, because a blinded `EXISTS` can only read `false`:
    // «derived false, recomputed true» is therefore never blindness and is
    // always another active plan, so it raises `plan_active_conflict`, while
    // «derived true, recomputed false» is the blind one and keeps
    // `plan_fact_blind`. Asserted as the two branches, because a single
    // branch is exactly what this law is now against.
    // AND IT IS A `count(*)`, NOT AN `EXISTS` (`TL-P4-COORD-R50` ordered item
    // 1). `EXISTS` collapses ONE active plan and TWO into one answer, and «at
    // most one» is precisely the premise that makes the derivation above
    // total — so for eleven rounds the writer could not tell the state its
    // premise forbids from the state its premise asserts, and with the index
    // not enforcing two concurrent writers committed and the reader served
    // the no-plan figure in silence. The count can tell them apart, and it is
    // taken AFTER the invoice row is locked, because a count taken before the
    // lock is a count taken on the snapshot the statement started with.
    expect(syncBody).toMatch(/SELECT pg_catalog\.count\(\*\) INTO v_active[\s\S]{0,300}AND p\.status = 'active';/);
    expect(syncBody).toMatch(/v_state := \(v_active > 0\);/);
    expect(syncBody, 'the blindable EXISTS came back').not.toMatch(
      /SELECT EXISTS \(SELECT 1 FROM public\.installment_plans p[\s\S]{0,200}INTO v_state;/,
    );
    // THE LOCK PRECEDES THE COUNT, in this body, in this order.
    const lockAt = syncBody.indexOf('FOR NO KEY UPDATE');
    const countAt = syncBody.indexOf('SELECT pg_catalog.count(*) INTO v_active');
    expect(lockAt, 'the sync takes no invoice row lock of its own').toBeGreaterThan(-1);
    expect(lockAt, 'the count precedes the lock, so it reads the pre-wait snapshot').toBeLessThan(countAt);
    expect(syncBody).toContain('installment.plan_active_unbounded');
    expect(syncBody, 'the two directions are back under one name').not.toMatch(/IF v_state IS DISTINCT FROM v_value THEN/);
    expect(syncBody).toMatch(/IF v_state AND NOT v_value THEN/);
    expect(syncBody).toMatch(/IF v_value AND NOT v_state THEN/);
    expect(code).toContain('installment.plan_fact_blind');
    expect(code).toContain('installment.plan_active_conflict');
    // AND THE EXCLUSION IS JUDGED BEFORE THE ROW IS WRITTEN, which is the half
    // of F-4's repair that makes the OTHER heap order give the same name.
    expect(code).toMatch(/CREATE TRIGGER installment_plans_active_exclusive\s*\n\s*BEFORE INSERT OR UPDATE ON installment_plans/);
    expect(code).toContain('CREATE OR REPLACE FUNCTION installment_plan_active_exclusive() RETURNS TRIGGER');

    // AND THE WRITER DETECTS ITS OWN BLINDNESS (F1-c prime): it reads the row
    // it was HANDED, by primary key, on every INSERT and UPDATE. That row
    // exists in this snapshot, so «I cannot find it» has a known wrong answer.
    expect(syncBody).toMatch(/WHERE p\.business_id = NEW\.business_id AND p\.id = NEW\.id/);
    expect(syncBody).toMatch(/IF TG_OP <> 'DELETE' THEN/);

    // THE DERIVATION RESTS ON THE PARTIAL UNIQUE INDEX, and the apply-time
    // block refuses the migration unless that index is there in that shape.
    expect(code).toContain("c.relname = 'installment_plans_one_active_per_invoice_uq'");
    expect(code).toContain("pg_get_expr(x.indpred, x.indrelid) = '(status = ''active''::text)'");

    // AND THE DEFERRED VERIFIER CARRIES NO HANDED-ROW FLOOR, because deferral
    // makes the handed row stale: an INSERT-then-DELETE in one transaction
    // still fires the INSERT's event with `NEW.status = 'active'` against a
    // correctly-false flag. The stale case and the blinded case cannot be told
    // apart without asking the forbidden question, so the floor lives on the
    // IMMEDIATE writer and this is recorded rather than papered over.
    const verify = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION installment_plan_fact_verify()'));
    const verifyBody = verify.slice(0, verify.indexOf('CREATE TRIGGER'));
    expect(verifyBody).not.toContain('v_asserted');
    expect(verifyBody).toContain('installment.plan_fact_desynchronised');

    // THE RATCHET FOR THE WRITE SIDE IS NO LONGER A SUBSTRING TEST
    // (`TL-P4-COORD-R46` F-1, extended by `TL-P4-COORD-R50` ordered item 4).
    //
    // THE HISTORY, BECAUSE IT IS THE ARGUMENT. Round 10's challenger
    // satisfied the raw version of these four tests with `NEW.status`,
    // `OLD.status` and `plan_fact_blind` appearing only INSIDE COMMENTS of an
    // otherwise round-9 body. Round 11 stripped the comments first — and was
    // then defeated AGAIN, with no comment and no dead code at all: a
    // VARIABLE RENAME (`v_asserted` to `v_floor`, plus one live `OLD.status`
    // assignment) installs round 9's behaviour and satisfies every one of
    // these four. That is not a gap to patch; it is the ruling: an identifier
    // is a string, so a `LIKE` establishes nothing about code and a
    // `NOT LIKE` establishes nothing about its absence, under any amount of
    // stripping.
    //
    // THE TWO HONEST INSTRUMENTS REPLACE IT, and both are now in the tree:
    //   * CATALOGUE DATA — `sha256(convert_to(p.prosrc, 'UTF8'))` against the
    //     digest `c_bodies` ships, which no rename survives (§C1 of
    //     `tests/integration/phase4-s7-installment-concurrency-db.test.ts`
    //     plants the renamed body and measures the refusal);
    //   * EXECUTION — §F1-b, §F1-c, §F1-c′, §F5 and the new §F6 of
    //     `tests/integration/phase4-s7-installment-fact-db.test.ts`, which
    //     INSTALL the pre-repair bodies, including the renamed one, and
    //     require the refusal from the running database.
    // So what this law now asserts is that the substring instrument is GONE
    // and the digest instrument is present.
    expect(code, 'a code-substring ratchet came back on the write side').not.toMatch(
      /\bcode\s+(NOT\s+)?LIKE\s+'%/,
    );
    // SCOPED TO THE OPERATOR WITH ITS PATTERN, NOT TO THE WORDS -- the EIGHTH
    // time in this slice that explaining a removal has tripped the test for
    // the removal, and measured here rather than guessed: the digest law's own
    // `RAISE` message explains, in prose inside a dollar-quoted body that
    // `sqlCodeOnly` correctly passes through, that «a prosrc LIKE cannot
    // establish a property of code». A bare `/prosrc LIKE/` therefore reds on
    // the very statement that enforces the absence. A real substring test is
    // `prosrc LIKE '...'` -- the operator followed by a LITERAL -- so that is
    // what is forbidden, and the explanation may say the words.
    expect(code, 'a raw prosrc substring law is back on the write side').not.toMatch(
      /\bprosrc\s+(NOT\s+)?LIKE\s+'/,
    );
    expect(code).toContain("pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8'))");
    expect(code).toContain("['public.installment_plan_fact_sync()',");
    // AND THE SPECIFICATION SAYS WHAT THE INSTRUMENT IS AND WHAT IT COSTS, in
    // the refusal a future applier reads, so the limit travels with the law.
    expect(SPEC).toContain('THE DIGEST COUPLING');

    // AND THE ENUMERATION `R41` ORDERED IS IN THE FILE, with the one relation
    // whose invisibility is NOT observable named as such rather than given an
    // invented check.
    expect(SPEC).toContain('THE COMPLETENESS ENUMERATION');
    expect(SPEC).toContain('SAID PLAINLY: THIS SLICE DOES NOT DETECT IT.');
  });

  it("C1 the tenant divergence is now UNREACHABLE, and obligation (e)'s stated reason was measurably false (TL-P4-COORD-R43, F2)", () => {
    const code = sqlCodeOnly(SPEC);

    // OBLIGATION (e) WAS A DEFERRED COMPARISON, justified by the claim that no
    // composite key existed for a foreign key to name. THE CLAIM WAS FALSE,
    // and it is false in the FROZEN estate, which is read here rather than
    // cited: `0016` makes `businesses (tenant_id, id)` UNIQUE, and the edge
    // onto it is already carried by dozens of relations including `invoices`.
    const uq = MIGRATIONS.filter((m) => /ADD CONSTRAINT businesses_tenant_id_uq UNIQUE \(tenant_id, id\)/.test(m.sql));
    expect(uq.length, 'the composite key obligation (e) said did not exist is not in the tree after all').toBe(1);
    const edges = MIGRATIONS.reduce(
      (n, m) => n + [...m.sql.matchAll(/FOREIGN KEY \(tenant_id, business_id\) REFERENCES businesses \(tenant_id, id\)/g)].length,
      0,
    );
    expect(edges, 'the tenant edge is not an estate-wide pattern').toBeGreaterThan(50);
    expect(
      MIGRATIONS.some((m) => /CONSTRAINT invoices_tenant_fk FOREIGN KEY \(tenant_id, business_id\) REFERENCES businesses \(tenant_id, id\)/.test(m.sql)),
    ).toBe(true);

    // SO THE EDGE IS CARRIED, BY BOTH RELATIONS, and the plan's tenant is the
    // invoice's by construction: `business_id` is already pinned to the
    // invoice's, and one `business_id` has exactly one `tenant_id`.
    expect(code).toContain('CONSTRAINT installment_plans_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)');
    expect(code).toContain('CONSTRAINT installments_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)');

    // AND THE LATE CHECK IS DELETED RATHER THAN KEPT BESIDE THE CONSTRAINT
    // THAT SUBSUMES IT, for the reason this file states about the retired
    // visibility guard: a check that can no longer fire is a second answer.
    //
    // SCOPED TO THE VERIFIER'S OWN BODY, because the apply-time block's RATCHET
    // quotes the retired message in order to refuse it, and that quotation
    // lives inside a dollar-quoted body that `sqlCodeOnly` passes through
    // verbatim. Asserting the absence over the whole file would be refuted by
    // the very statement that enforces the absence — the seventh time in this
    // slice that explaining a removal has tripped the test for the removal.
    const verifier = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION installment_schedule_verify()'));
    const verifierBody = verifier.slice(0, verifier.indexOf('CREATE CONSTRAINT TRIGGER'));
    expect(verifierBody).not.toContain('(e) the plan tenant');
    expect(verifierBody).not.toContain('v_plan_tenant');
    expect(verifierBody).not.toContain('v_tenant_mismatch');
    // ...and the apply-time block refuses a tree where any of them comes back
    // — BY BODY IDENTITY and no longer by `p.prosrc LIKE '%(e) the plan
    // tenant%'`, which `TL-P4-COORD-R50` ordered item 4 retires: a `NOT LIKE`
    // cannot establish the absence of a property, since the absent thing can
    // be spelled another way, and a `LIKE` for the ratchet's own token can be
    // satisfied by a body that does nothing. The digest of
    // `installment_schedule_verify()` is pinned in `c_bodies`, so ANY body
    // other than the one shipped here — including one that brings the retired
    // guard back under any spelling — refuses the migration.
    expect(code).toContain("['public.installment_schedule_verify()',");
    expect(code).toContain("pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8'))");
  });

  it('H6 THE ORDER LAW IS EXECUTABLE — the verifier is DEFINED ABOVE the triggers that execute it', () => {
    // §20.1 claimed an `ORDER_NOTE` comment meant "the next editor cannot
    // reorder them back". A comment cannot do that. `CREATE CONSTRAINT
    // TRIGGER` resolves `EXECUTE FUNCTION` AT CREATE TIME and the file is one
    // implicit transaction, so the reversed order applied NOTHING (42883).
    //
    // ROUND 6, F4, AND IT IS THE SAME LESSON A SIXTH TIME. This law was
    // written over the RAW SPEC, so the challenger satisfied it with a
    // COMMENT: plant a mention of the `CREATE` above, move the real `CREATE`
    // below its triggers, and all 94 cases passed — a law written to refuse
    // "a comment cannot do that" was itself satisfied by a comment.
    //
    // THE SUBJECT OF A CODE LAW IS CODE. `sqlCodeOnly` is this file's OWN
    // extractor, already used by every other code law here and already
    // mutation-tested: `sqlSchemaOnly` strips `--` and `/* */` EVERYWHERE,
    // dollar-quoted bodies included, and `sqlCodeOnly` then blanks the
    // single-quoted literals, so a mention planted in a comment and a mention
    // planted in a `COMMENT ON ... IS '...'` string both disappear.
    //
    // THE BOUND, STATED. A mention inside a DOLLAR-QUOTED BODY survives, because
    // `sqlCodeOnly` keeps those bodies verbatim so the projection can still be
    // judged in full. That residue is a string literal inside plpgsql — e.g. a
    // `RAISE EXCEPTION` text — and §2b's end-state block is what closes it for
    // real: it reads `pg_trigger` and `pg_proc` from the LIVE CATALOGUE, where
    // no arrangement of comments or literals can put a trigger before the
    // function it executes.
    const code = sqlCodeOnly(SPEC);
    const fn = code.indexOf('CREATE OR REPLACE FUNCTION installment_schedule_verify()');
    const trg = code.indexOf('CREATE CONSTRAINT TRIGGER');
    const own = code.indexOf('ALTER FUNCTION installment_schedule_verify() OWNER TO');
    expect(fn, 'the verifier definition is not in the specification at all').toBeGreaterThan(-1);
    expect(trg, 'no constraint trigger is in the specification at all').toBeGreaterThan(-1);
    expect(own, 'the authority transfer is not in the specification at all').toBeGreaterThan(-1);
    // function, THEN triggers, THEN the authority transfer — `0075:632-634`.
    expect(fn).toBeLessThan(trg);
    expect(trg).toBeLessThan(own);
    // and the note that explains why is still there, as documentation of a
    // law that is now asserted rather than as the law itself.
    expect(SPEC).toContain('ORDER_NOTE');
  });

  it('THE ADOPTED ONE-SIDED MUTANTS ARE EVALUATED — the exact invariant refuses what each half accepts', () => {
    // FOUND BY LINT, WHICH IS WHY THE RULE IS NOT NOISE.
    // `@typescript-eslint/no-unused-vars` reported `ONE_SIDED_INVARIANTS` and
    // `scheduleInvariantVerdict` imported and never used: an oracle ADOPTED
    // from the proof engineer and never wired. That is the estate's named
    // failure shape — AN EXEMPTION THAT IS NEVER EVALUATED — sitting in an
    // import list, and silencing it with a `_` prefix would have preserved it
    // exactly. So it is wired, not quieted.
    //
    // The DATABASE half of this law is the one that matters and it is measured
    // in `tests/integration/phase4-s7-installment-aging-live.test.ts` §B1/§B2,
    // where the real verifier's single `<>` refuses below and above at COMMIT.
    // This is its model-level twin: the two one-directional verifiers each
    // accept a case the exact one refuses, in OPPOSITE directions, so neither
    // inequality can be relaxed without a case going green.
    expect(ONE_SIDED_INVARIANTS.map((m) => m.name)).toEqual(['at_most_total', 'at_least_total']);

    const exactTotal = PLANNED_INVOICE.paidTxnMinor + PLANNED_INVOICE.outstandingTxnMinor;
    // THE EXACT CASE: everything accepts it, which is precisely why a one-sided
    // verifier looks correct on every well-formed fixture.
    expect(scheduleInvariantVerdict(PLAN, exactTotal).verdict).toBe('exact');
    expect(scheduleInvariantVerdict(PLAN, exactTotal).excessTxnMinor).toBe(0n);
    for (const m of ONE_SIDED_INVARIANTS) expect(m.fn(PLAN, exactTotal), `${m.name} refuses the exact schedule`).toBe(true);
    expect(scheduleInvariantAccepts(PLAN, exactTotal)).toBe(true);

    // ABOVE: the challenger's own counterexample. `at_most_total` refuses it;
    // `at_least_total` ACCEPTS it, and that acceptance is the defect.
    const overTotal = OVER_SCHEDULED_INVOICE.paidTxnMinor + OVER_SCHEDULED_INVOICE.outstandingTxnMinor;
    const above = scheduleInvariantVerdict(OVER_SCHEDULED_PLAN, overTotal);
    expect(above.verdict).toBe('above');
    expect(above.excessTxnMinor).toBe(900_000n);
    expect(scheduleInvariantAccepts(OVER_SCHEDULED_PLAN, overTotal), 'the EXACT invariant must refuse it').toBe(false);
    expect(ONE_SIDED_INVARIANTS[1]?.fn(OVER_SCHEDULED_PLAN, overTotal), 'at_least_total must ACCEPT the over-scheduled plan').toBe(true);
    expect(ONE_SIDED_INVARIANTS[0]?.fn(OVER_SCHEDULED_PLAN, overTotal)).toBe(false);

    // BELOW: the mirror. `at_least_total` refuses it; `at_most_total` ACCEPTS
    // it, and the shortfall is then carried silently as residual.
    const under: InstallmentPlan = Object.freeze({
      ...PLAN,
      installments: Object.freeze(PLAN.installments.slice(0, -1)),
    });
    const below = scheduleInvariantVerdict(under, exactTotal);
    expect(below.verdict).toBe('below');
    expect(below.excessTxnMinor).toBe(-100_000n);
    expect(scheduleInvariantAccepts(under, exactTotal), 'the EXACT invariant must refuse it').toBe(false);
    expect(ONE_SIDED_INVARIANTS[0]?.fn(under, exactTotal), 'at_most_total must ACCEPT the under-scheduled plan').toBe(true);
    expect(ONE_SIDED_INVARIANTS[1]?.fn(under, exactTotal)).toBe(false);

    // AND THE TWO DIRECTIONS ARE REALLY OPPOSITE — each mutant is defeated by
    // exactly one of the two cases, so one comparison cannot cover both and
    // the verifier's `<>` is load-bearing rather than stylistic.
    const defeatedBy = ONE_SIDED_INVARIANTS.map((m) => [m.fn(OVER_SCHEDULED_PLAN, overTotal), m.fn(under, exactTotal)].filter((ok) => !ok).length);
    expect(defeatedBy).toEqual([1, 1]);
  });

  it('H3 THE CREATE BRACKET IS PRESENT AND BALANCED, and the owner transfer is LAST', () => {
    // TWO MORE DEFECTS THE EXECUTOR FOUND, and neither is visible to a
    // superuser — which is the whole of challenger H3. Applied by the real
    // deployment principal `daftar_migrator`:
    //   * `ALTER FUNCTION ... OWNER TO r` requires `r` to hold CREATE on the
    //     schema, and `daftar_accounting_internal` holds only USAGE
    //     (`bootstrap.sql:198`) -> `42501 permission denied for schema public`;
    //   * and with the transfer issued BEFORE the function's own `REVOKE` and
    //     `COMMENT`, the applier is no longer the owner and may not issue them
    //     -> `42501 must be owner of function installment_schedule_verify`.
    // Three rounds of applying this file as `postgres` could not see either.
    const code = sqlCodeOnly(SPEC);
    const lends = [...code.matchAll(/GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;/g)];
    const takebacks = [...code.matchAll(/REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;/g)];
    const transfers = [...code.matchAll(/ALTER FUNCTION (\w+)\([^)]*\) OWNER TO daftar_accounting_internal;/g)];
    // Every transfer is bracketed, and a bracket that only opens is a
    // permanent widening of a role's authority over the schema.
    expect(transfers.length, 'no owner transfer in the specification at all').toBeGreaterThan(0);
    expect(lends.length, 'the lends and the take-backs are not balanced').toBe(takebacks.length);
    // ROUND 7 F1: ONE bracket may now hold SEVERAL transfers — §3a lends once
    // and hands over both fact routines — so the k-th transfer is no longer
    // the k-th bracket. The law's content is unchanged and is asserted
    // directly instead of through that coincidence: every transfer is inside
    // an OPEN bracket (the nearest lend before it is later than the nearest
    // take-back before it) and that bracket is closed afterwards.
    expect(lends.length, 'a bracket holds no transfer at all').toBeLessThanOrEqual(transfers.length);
    const lendIdx = lends.map((m) => m.index ?? -1);
    const backIdx = takebacks.map((m) => m.index ?? -1);
    for (let k = 0; k < transfers.length; k += 1) {
      const t = transfers[k]?.index ?? -1;
      const open = Math.max(...lendIdx.filter((x) => x < t), -1);
      const closedBefore = Math.max(...backIdx.filter((x) => x < t), -1);
      const close = Math.min(...backIdx.filter((x) => x > t), Number.MAX_SAFE_INTEGER);
      const name = transfers[k]?.[1] ?? '?';
      expect(open, `${name}'s transfer is not inside a lend`).toBeLessThan(t);
      expect(closedBefore, `${name}'s transfer sits outside its bracket — the lend before it was already taken back`).toBeLessThan(open);
      expect(close, `${name}'s lend is never taken back after the transfer`).toBeGreaterThan(t);
      const revoke = code.indexOf(`REVOKE ALL ON FUNCTION ${name}(`);
      const comment = code.indexOf(`COMMENT ON FUNCTION ${name}(`);
      expect(revoke, `${name} has no REVOKE ALL ... FROM PUBLIC`).toBeGreaterThan(-1);
      expect(comment, `${name} has no COMMENT`).toBeGreaterThan(-1);
      expect(revoke, `${name}'s REVOKE is after its owner transfer, which the applier may not issue`).toBeLessThan(t);
      expect(comment, `${name}'s COMMENT is after its owner transfer, which the applier may not issue`).toBeLessThan(t);
    }
  });

  it('H4 THE END-STATE BLOCK IS PRESENT and reads the LIVE CATALOGUE, not this file', () => {
    // Eleven predecessors ship one; `0075:838-945` is the worked example. A
    // `DO $end$` block travels inside the migration: no gate row, no CI step,
    // no roster entry, no runner window — it refuses at apply time.
    expect(SPEC).toContain('DO $end$');
    const block = SPEC.slice(SPEC.indexOf('DO $end$'));
    expect(block).toContain('migration_end_state_invalid');
    // It must read catalogues. A block that re-read this file's own statements
    // would be the file agreeing with itself.
    for (const cat of ['pg_class', 'pg_attribute', 'pg_policy', 'pg_trigger', 'pg_proc', 'has_table_privilege']) {
      expect(block, `the end-state block never consults ${cat}`).toContain(cat);
    }
    // H5: the closed lists are the PREDECESSOR'S, not this file's idea of them.
    const predecessor = MIGRATIONS.find((m) => m.name.startsWith('0075_'))?.sql ?? '';
    for (const name of ['c_runtime', 'c_dml', 'c_column_dml']) {
      const mine = new RegExp(`${name}\\s+CONSTANT TEXT\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(block);
      const theirs = new RegExp(`${name}\\s+CONSTANT TEXT\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(predecessor);
      expect(mine, `the end-state block does not declare ${name}`).not.toBeNull();
      expect(theirs, `0075 no longer declares ${name}`).not.toBeNull();
      const words = (m: RegExpExecArray | null): readonly string[] => [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort();
      expect(words(mine), `${name} diverges from 0075's own declared list`).toEqual([...words(theirs)]);
    }
    // 8 runtime principals x 6 privileges, not the 3 x 3 the first version
    // hand-wrote — and `TRIGGER` is in it, which is the privilege the design's
    // own "the verifier cannot be bypassed" argument depends on.
    const runtime = [...(/c_runtime\s+CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/.exec(block)?.[1] ?? '').matchAll(/'([^']+)'/g)];
    const dml = [...(/c_dml\s+CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/.exec(block)?.[1] ?? '').matchAll(/'([^']+)'/g)];
    expect(runtime.length).toBe(8);
    expect(dml.length).toBe(6);
    expect(dml.map((m) => m[1])).toContain('TRIGGER');
    expect(runtime.map((m) => m[1])).toContain('public');
  });

  /**
   * ── THE BODY DIGESTS, CHECKED IN BOTH DIRECTIONS
   *    (`TL-P4-COORD-R46`'s structural ruling; `TL-P4-COORD-R50` §5 and
   *     ordered item 4) ─────────────────────────────────────────────────────
   *
   * The end-state block's `c_bodies` array pins `sha256` of each routine's
   * dollar-quoted body. The CONSTANTS live in the file and the SUBJECT is
   * what a cluster installs, which is what makes the comparison a law rather
   * than the file agreeing with itself — but it is also a maintenance
   * coupling, and a coupling whose only alarm is a failed deployment is a
   * trap. This is the alarm. It computes the digests from the file and
   * requires the declared constants to equal them, so a body edited without
   * its constant reds HERE.
   */
  it('H7 THE FIVE BODY DIGESTS ARE CURRENT, and no prosrc substring test is left behind', () => {
    const computed = bodyDigests(SPEC);
    const declared = declaredBodyDigests(SPEC);
    expect(declared.map((d) => d.signature)).toEqual(computed.map((d) => d.signature));
    for (const [i, c] of computed.entries()) {
      // A placeholder that was never filled is the failure mode this catches
      // first, so it is named rather than left to a hex mismatch.
      expect(declared[i]?.sha256, `${c.signature}: the end-state block still carries an unfilled placeholder`).toMatch(/^[0-9a-f]{64}$/);
      expect(declared[i]?.sha256, `${c.signature}: the declared digest is stale — run scripts/guards/p4s7-body-digests.ts`).toBe(c.sha256);
      // AND THE SLICE IS NON-EMPTY, so a digest of nothing cannot pass.
      expect(c.length, `${c.signature}: the body sliced to ${c.length} characters`).toBeGreaterThan(1000);
    }
    expect(computed).toHaveLength(5);

    // THE RULING'S OTHER HALF: the instruments it forbids are GONE from the
    // end-state block. The subject is the block's SQL and not its prose — a
    // line that is a comment is not a law, and the refusal messages quote the
    // ruling by name — so comment lines and `RAISE` lines are removed before
    // the search, and the search is for the TEST SYNTAX rather than for the
    // words.
    const block = SPEC.slice(SPEC.indexOf('\nDO $end$'));
    const sql = block
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .filter((l) => !l.includes('RAISE EXCEPTION') && !l.trimStart().startsWith("'"))
      .join('\n');
    expect(sql).not.toMatch(/prosrc\s+(NOT\s+)?LIKE/i);
    expect(sql).not.toMatch(/\bc?\.?code\s+(NOT\s+)?LIKE/i);
    // and the digest instrument IS there, named.
    expect(sql).toContain('pg_catalog.sha256');
    expect(sql).toContain('c_bodies');
  });

  /**
   * ── THE THREE ENFORCEMENT FLAGS AND `tgenabled`, AS CATALOGUE DATA
   *    (`TL-P4-COORD-R50` ordered items 2 and 3) ──────────────────────────
   *
   * All four strings occurred ZERO times in this specification before this
   * round. Part 9 read every property of the index's DEFINITION and none of
   * its ENFORCEMENT, so an index left present-but-unenforcing satisfied it
   * while bounding nothing; and nothing anywhere read whether a trigger
   * FIRES, so all seven could be disabled with the block still reporting OK.
   */
  it('H8 THE END-STATE BLOCK READS THE ENFORCEMENT FLAGS IT NAMES, and the reader reads tgenabled too', () => {
    const block = SPEC.slice(SPEC.indexOf('\nDO $end$'));
    const sql = block
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .filter((l) => !l.includes('RAISE EXCEPTION') && !l.trimStart().startsWith("'"))
      .join('\n');
    // the index's three flags, in the SQL and not only in the prose
    for (const flag of ['indisvalid', 'indisready', 'indislive']) {
      expect(sql, `the end-state block never reads ${flag}`).toContain(`x.${flag}`);
    }
    // `tgenabled` pinned to the one value this file installs — not «not D»,
    // because `R` (replica only) would make these triggers silent in every
    // ordinary session, which is the harm with a different letter.
    expect(sql).toContain("t.tgenabled <> 'O'");
    expect(sql).not.toMatch(/tgenabled\s*<>\s*'D'/);
    // and the READ-TIME half is in the projection, which is a different
    // instrument in a different path: the apply-time block answers once.
    const sketchCode = sqlCodeOnly(SPEC.slice(SPEC.indexOf('>>> P4S7 PROJECTION SKETCH BEGIN'), SPEC.indexOf('<<< P4S7 PROJECTION SKETCH END')));
    expect(sketchCode).toContain("t.tgenabled = 'O'");
    expect(sketchCode).toContain('untrusted_fact');
    expect(sketchCode).toContain('unbounded_plan');
  });

  /**
   * ── THE LOCK ORDER IS DECLARED, AND IT AGREES WITH `P4-AL-41`
   *    (`TL-P4-COORD-R50` ordered item 5) ─────────────────────────────────
   *
   * The slice declared no lock order and took one — plan row, then index
   * entry, then the invoice row from the sync's `UPDATE`. `P4-AL-41` ranks
   * `invoices` THIRD and `installment_plans` SIXTH, so every plan write was
   * taking rank 6 before rank 3, and two transactions creating plans on two
   * invoices in opposite order deadlocked `40P01`. The order is now taken in
   * the BEFORE trigger, which is the only point that runs before the plan row
   * exists, and it is DECLARED in the file.
   */
  it('H9 THE LOCK ORDER IS DECLARED AND TAKEN, invoice row first, ascending by id', () => {
    expect(SPEC).toContain('3a-ter');
    expect(SPEC).toContain('P4-AL-41');
    const code = sqlCodeOnly(SPEC);
    // taken, in the BEFORE trigger's body, on `invoices`, with the ordering
    expect(code).toMatch(/FROM public\.invoices i\s*\n\s*WHERE i\.business_id = NEW\.business_id AND i\.id = ANY \(v_locks\)\s*\n\s*ORDER BY i\.id\s*\n\s*FOR NO KEY UPDATE/);
    // `FOR NO KEY UPDATE` and not `FOR UPDATE`: it is the strength a plain
    // UPDATE of a non-key column takes and it does not block the `FOR KEY
    // SHARE` an ordinary foreign-key check takes against the same invoice.
    expect(code).not.toContain('FOR UPDATE;');
    // and the DECLARED exceptions are declared rather than left to a twelfth
    // challenger to re-measure: the DELETE arm takes no BEFORE trigger.
    expect(SPEC).toContain('BEFORE DELETE');
    // the determinism claim is SCOPED and names the three outcomes it is not
    for (const token of ['40001', '40P01', 'REPEATABLE READ', 'SERIALIZABLE']) {
      expect(SPEC, `section 3a-ter does not name ${token}`).toContain(token);
    }
  });
});
