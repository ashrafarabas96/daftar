/**
 * P4-S7 LEVEL C — THE SLICE'S LAWS, RUN THROUGH THE ESTATE'S OWN DETECTORS,
 * WITH EVERY ONE SHOWN ABLE TO GO RED.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. Every claim below is
 * evaluated by a detector THE ESTATE ALREADY OWNS — `compositeFkProblems`
 * (`scripts/phase4-s1-gate.ts`), `findReadSurfaceViolations`
 * (`scripts/guards/read-surface.ts`), `findAuthoritativeSalesColumns` and
 * `discoverSalesTables` (`scripts/guards/no-authoritative-balance.ts`) — and
 * never by a regex written here to agree with itself. A guard this slice
 * invented and then satisfied would prove nothing about the slice.
 *
 * Each claim is asked TWICE: once over the correct form, which must be clean,
 * and once over a PLANTED defect, which the detector must NAME. A plant whose
 * correct twin is not also run is a plant about a string.
 *
 * ── WHAT THE SUBJECT IS, AND WHAT IT IS NOT ──────────────────────────────
 *
 * **Nothing in this file writes to `infrastructure/database/migrations/` and
 * nothing allocates a migration number.** The DDL this suite evaluates is the
 * CANDIDATE SPECIFICATION of `docs/PHASE_4_S7_DDL_SPECIFICATION.md`, written
 * into a HARD-COPIED temp root under a name that carries no number at all
 * (`zz-p4s7-candidate-spec.sql`) — the `rootWith` discipline of
 * `tests/guards/phase4-composite-seam-guard.test.ts`, which copies the
 * migrations into `mkdtemp` and plants there. The checkout is never touched,
 * the real prefix stays unknown until the predecessors seal, and the one
 * migration owner of this phase is not this slice.
 *
 * The point of evaluating the specification rather than describing it is the
 * recorded lesson about proofs: a DDL spec that has never been run through the
 * gate that will judge it is a document, not a specification. Running it finds
 * the polymorphic-FK refusal, the balance-column refusal and the read-surface
 * refusal NOW, at level E, instead of on the day the migration owner writes
 * the file.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INSTALLMENT_ARITHMETIC_CODES } from '@daftar/domain-core';
import { FINANCIAL_CORE, compositeFkProblems } from '../../scripts/phase4-s1-gate';
import {
  DERIVED_SETTLEMENT_INSTANT,
  discoverSalesTables,
  findAuthoritativeSalesColumns,
  isAuthoritativeSalesColumn,
} from '../../scripts/guards/no-authoritative-balance';
import { findReadSurfaceViolations, readSurfaceFiles } from '../../scripts/guards/read-surface';
import { INSTALLMENTS_CODES, isInstallmentsCode } from '../../apps/api/src/modules/installments/installments-errors';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
/** No number: `phase4MigrationsOnDisk` takes it because it sorts after the inherited prefix's end. */
const CANDIDATE = 'zz-p4s7-candidate-spec.sql';
const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A hard copy of the tree's Phase 4 DDL plus `planted`, in a temp root. The checkout is never written. */
function rootWith(planted: string): string {
  const root = mkdtempSync(join(tmpdir(), 'p4s7-ddl-'));
  temporaries.push(root);
  mkdirSync(join(root, 'infrastructure/database/migrations'), { recursive: true });
  cpSync(MIGRATIONS, join(root, 'infrastructure/database/migrations'), { recursive: true });
  writeFileSync(join(root, 'infrastructure/database/migrations', CANDIDATE), planted);
  cpSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'));
  return root;
}

/** The problems a detector raises that name the candidate's own relations, so the tree's own verdict is not borrowed. */
const aboutOurs = (problems: readonly string[]): string[] => problems.filter((p) => /installment/i.test(p));

// ─────────────────────────────────────────────────────────────────────────
// 1. THE COMPOSITE BRIDGE — because `FINANCIAL_CORE` already names us
// ─────────────────────────────────────────────────────────────────────────

/**
 * THE CANDIDATE DDL of `installment_plans` and `installments`, in the shape
 * the specification requires.
 *
 * Two properties are what this section exists to evaluate:
 *
 *  1. `FINANCIAL_CORE` (`scripts/phase4-s1-gate.ts:504-505`) ALREADY NAMES
 *     `installment_plans` and `installments`, so a polymorphic foreign key on
 *     either is refused by G-19 before this slice writes a line. The source is
 *     therefore bound through the COMPOSITE BRIDGE: `installments` references
 *     `installment_plans (business_id, id)`, and `installment_plans`
 *     references `invoices (business_id, id, customer_id)` — the three-column
 *     edge `0082` created `invoices_customer_uq` for, so the customer on the
 *     plan cannot drift from the customer on the invoice. There is no
 *     `source_type`/`source_id` pair anywhere.
 *
 *  2. **A BUSINESS-OWNED ENTITY IS NEVER IDENTIFIED BY ONE COMPONENT OF ITS
 *     COMPOSITE KEY.** `installments` carries `business_id` and keys on
 *     `(business_id, plan_id, seq_no)`, and every edge it draws carries
 *     `business_id` with it. An edge on `plan_id` alone would let a row of
 *     one business point at a plan of another, which is the defect
 *     `compositeFkProblems` exists to refuse and which §1.2 plants.
 */
const CANDIDATE_DDL = `
CREATE TABLE installment_plans (
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  id            UUID NOT NULL,
  invoice_id    UUID NOT NULL,
  customer_id   UUID NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  start_date    DATE NOT NULL,
  down_payment_minor BIGINT NOT NULL DEFAULT 0,
  total_minor   BIGINT NOT NULL,
  installment_count INTEGER NOT NULL,
  remainder_placement TEXT NOT NULL DEFAULT 'first',
  lifecycle     TEXT NOT NULL DEFAULT 'active',
  intent_sha256 TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT installment_plans_pkey PRIMARY KEY (business_id, id),
  CONSTRAINT installment_plans_invoice_fk FOREIGN KEY (business_id, invoice_id, customer_id)
    REFERENCES invoices (business_id, id, customer_id) ON DELETE RESTRICT,
  CONSTRAINT installment_plans_customer_fk FOREIGN KEY (business_id, customer_id)
    REFERENCES customers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT installment_plans_invoice_uq UNIQUE (business_id, invoice_id, lifecycle),
  CONSTRAINT installment_plans_total_positive CHECK (total_minor > 0),
  CONSTRAINT installment_plans_down_bounded CHECK (down_payment_minor >= 0 AND down_payment_minor < total_minor),
  CONSTRAINT installment_plans_count_bounded CHECK (installment_count BETWEEN 1 AND 120),
  CONSTRAINT installment_plans_placement CHECK (remainder_placement IN ('first', 'last')),
  CONSTRAINT installment_plans_lifecycle CHECK (lifecycle IN ('active', 'cancelled'))
);

CREATE TABLE installments (
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  plan_id      UUID NOT NULL,
  seq_no       INTEGER NOT NULL,
  due_date     DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  CONSTRAINT installments_pkey PRIMARY KEY (business_id, plan_id, seq_no),
  CONSTRAINT installments_plan_fk FOREIGN KEY (business_id, plan_id)
    REFERENCES installment_plans (business_id, id) ON DELETE CASCADE,
  CONSTRAINT installments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT installments_seq_positive CHECK (seq_no BETWEEN 1 AND 120),
  CONSTRAINT installments_due_uq UNIQUE (business_id, plan_id, due_date)
);

CREATE INDEX installments_keyset_idx ON installments (business_id, plan_id, due_date, seq_no);
CREATE INDEX installment_plans_customer_idx ON installment_plans (business_id, customer_id, start_date, id);
`;

describe('P4-S7 §1 — the DDL specification binds its source through the composite bridge', () => {
  it('the slice is already inside FINANCIAL_CORE, so a polymorphic FK is refused before we write a line', () => {
    // Measured against the real export, not quoted from the brief.
    expect(FINANCIAL_CORE.test('installment_plans')).toBe(true);
    expect(FINANCIAL_CORE.test('installments')).toBe(true);
  });

  it('CLEAN — the candidate DDL raises no composite-seam problem of its own', () => {
    const problems = compositeFkProblems(rootWith(CANDIDATE_DDL));
    expect(aboutOurs(problems), problems.join('\n')).toEqual([]);
  });

  it('RED PROOF — a single-column edge to a business-scoped parent IS NAMED', () => {
    // The plant: `installments.plan_id` referencing `installment_plans(id)`
    // alone. It is the shape that lets a row of one business point at a plan
    // of another, and it is the exact recorded lesson «never identify a
    // business-owned entity by one component of its composite key».
    const planted = CANDIDATE_DDL.replace(
      /CONSTRAINT installments_plan_fk FOREIGN KEY \(business_id, plan_id\)\s*\n\s*REFERENCES installment_plans \(business_id, id\)/,
      'CONSTRAINT installments_plan_fk FOREIGN KEY (plan_id)\n    REFERENCES installment_plans (id)',
    );
    expect(planted, 'the plant did not change the DDL, so the proof would pass vacuously').not.toBe(CANDIDATE_DDL);
    const problems = aboutOurs(compositeFkProblems(rootWith(planted)));
    expect(problems.join('\n')).toMatch(/installment/);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('RED PROOF — a single-column edge from the PLAN to the invoice IS NAMED', () => {
    const planted = CANDIDATE_DDL.replace(
      /CONSTRAINT installment_plans_invoice_fk FOREIGN KEY \(business_id, invoice_id, customer_id\)\s*\n\s*REFERENCES invoices \(business_id, id, customer_id\)/,
      'CONSTRAINT installment_plans_invoice_fk FOREIGN KEY (invoice_id)\n    REFERENCES invoices (id)',
    );
    expect(planted).not.toBe(CANDIDATE_DDL);
    expect(aboutOurs(compositeFkProblems(rootWith(planted))).length).toBeGreaterThan(0);
  });

  it('the specification carries NO polymorphic source pair, asserted over the text the gate read', () => {
    // G-19's subject is a `source_type`/`source_id` pair on a financial-core
    // relation. The absence is asserted rather than left to a reviewer,
    // because the pair is the ordinary way a schedule gets written over "any
    // document".
    expect(/\bsource_type\b/i.test(CANDIDATE_DDL)).toBe(false);
    expect(/\bsource_id\b/i.test(CANDIDATE_DDL)).toBe(false);
    expect(/\bdocument_type\b/i.test(CANDIDATE_DDL)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. NO AUTHORITATIVE BALANCE ON THE SCHEDULE
// ─────────────────────────────────────────────────────────────────────────

describe('P4-S7 §2 — the schedule stores no balance, judged by the estate’s own column guard', () => {
  it('the guard already refuses the two columns a schedule is most likely to grow', () => {
    // `scripts/guards/no-authoritative-balance.ts:272-274` names
    // `installments.outstanding_minor` and `installments.settled_minor`
    // explicitly as the shape it exists to refuse. Measured against the real
    // predicate, so the claim is about the guard and not about its comment.
    expect(isAuthoritativeSalesColumn('settled_minor')).toBe(true);
    expect(isAuthoritativeSalesColumn('outstanding_minor')).toBe(true);
    expect(isAuthoritativeSalesColumn('paid_minor')).toBe(true);
    expect(isAuthoritativeSalesColumn('collected_minor')).toBe(true);
    // And it does NOT refuse the two columns the schedule legitimately holds:
    // the amount that FALLS DUE and the total it closes against are terms of
    // the arrangement, not derived figures.
    expect(isAuthoritativeSalesColumn('amount_minor')).toBe(false);
    expect(isAuthoritativeSalesColumn('down_payment_minor')).toBe(false);
  });

  it('CLEAN — the candidate DDL holds no authoritative balance column on either relation', () => {
    const tables = discoverSalesTables(CANDIDATE_DDL);
    expect(tables, 'the guard must actually have found our relations, or it is watching nothing').toEqual(
      expect.arrayContaining(['installment_plans', 'installments']),
    );
    const findings = findAuthoritativeSalesColumns(CANDIDATE_DDL, tables);
    expect(findings, JSON.stringify(findings)).toEqual([]);
  });

  it('RED PROOF — a per-instalment settled column IS NAMED by the real guard', () => {
    // The plant is the SECOND LEDGER law 1 forbids, in its most tempting form:
    // one integer per instalment, maintained by whoever collects, so a page
    // can be rendered without the settlement sum. It is refused.
    const planted = CANDIDATE_DDL.replace('  amount_minor BIGINT NOT NULL,', '  amount_minor BIGINT NOT NULL,\n  settled_minor BIGINT NOT NULL DEFAULT 0,');
    expect(planted).not.toBe(CANDIDATE_DDL);
    const findings = findAuthoritativeSalesColumns(planted, discoverSalesTables(planted));
    expect(findings.map((f) => `${f.table}.${f.column}`)).toContain('installments.settled_minor');
  });

  it('RED PROOF — a plan-level outstanding column IS NAMED, and so is a derived debt column', () => {
    for (const column of ['outstanding_minor', 'total_paid_minor', 'overdue_minor', 'aging_bucket']) {
      const planted = CANDIDATE_DDL.replace('  total_minor   BIGINT NOT NULL,', `  total_minor   BIGINT NOT NULL,\n  ${column} BIGINT NOT NULL DEFAULT 0,`);
      expect(planted, column).not.toBe(CANDIDATE_DDL);
      const findings = findAuthoritativeSalesColumns(planted, discoverSalesTables(planted));
      expect(
        findings.map((f) => `${f.table}.${f.column}`),
        column,
      ).toContain(`installment_plans.${column}`);
    }
  });

  it('RED PROOF — a derived settlement INSTANT is refused by the OTHER half of the guard, measured', () => {
    // `settled_at` is NOT caught by the balance-column half, and that is a
    // measured fact about the real guard rather than a guess:
    // `INVENTORY_NOT_A_QUANTITY` (`no-authoritative-balance.ts:436`) excludes
    // every name ending in `_at`, deliberately, because a timestamp is not a
    // quantity. `DERIVED_SETTLEMENT_INSTANT` (`:258`) is the half that catches
    // it, and the two halves together are why a stored "when this instalment
    // was settled" cannot slip through: it is a second truth about WHEN, with
    // all the drift of a second truth about HOW MUCH and none of the
    // visibility.
    const planted = CANDIDATE_DDL.replace('  amount_minor BIGINT NOT NULL,', '  amount_minor BIGINT NOT NULL,\n  settled_at TIMESTAMPTZ,');
    expect(planted).not.toBe(CANDIDATE_DDL);
    // The balance half is silent — asserted, so the division of labour is a
    // fact of this suite and not an assumption of its reader.
    expect(findAuthoritativeSalesColumns(planted, discoverSalesTables(planted)).map((f) => f.column)).not.toContain('settled_at');
    // The instant half names it, and names no column the specification holds.
    expect(DERIVED_SETTLEMENT_INSTANT.test('settled_at')).toBe(true);
    expect(DERIVED_SETTLEMENT_INSTANT.test('paid_date')).toBe(true);
    expect(DERIVED_SETTLEMENT_INSTANT.test('collected_at')).toBe(true);
    for (const column of ['due_date', 'start_date', 'created_at', 'amount_minor', 'down_payment_minor']) {
      expect(DERIVED_SETTLEMENT_INSTANT.test(column), column).toBe(false);
    }
  });

  it('there is no MATERIALIZED VIEW and no aging table in the specification (law 5)', () => {
    expect(/CREATE\s+MATERIALIZED\s+VIEW/i.test(CANDIDATE_DDL)).toBe(false);
    expect(/CREATE\s+TABLE\s+\w*aging/i.test(CANDIDATE_DDL)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. THE KEYSET READS — judged by the real read-surface guard
// ─────────────────────────────────────────────────────────────────────────

/**
 * THE CANDIDATE READ MODULE of the slice, in the shape the specification
 * requires, as the text the estate's read-surface guard will judge.
 *
 * It is evaluated at the path the guard's own `READ_SURFACE` pattern matches —
 * `apps/api/src/modules/<context>/*-reads.ts` — so the verdict is the one the
 * real module will receive on the day it is written, and not a verdict about a
 * file nobody is watching.
 *
 * Four laws of this slice are visible in the text and are evaluated here: the
 * keyset continuation with no `OFFSET`, the supplied `asOf` reaching the SQL
 * as a parameter, the settlement figure coming from
 * `invoice_outstanding(...)` and nothing else, and no module-level cache.
 */
const CANDIDATE_READ = `
import { Database } from '../../infra/database';

const INSTALLMENT_PAGE_SQL = \`
  SELECT i.seq_no, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.amount_minor::text AS amount_minor,
         o.total_txn_minor::text AS total_txn_minor, o.outstanding_txn_minor::text AS outstanding_txn_minor
    FROM installments i
    JOIN installment_plans p ON p.business_id = i.business_id AND p.id = i.plan_id
    CROSS JOIN LATERAL invoice_outstanding(p.business_id, p.invoice_id) o
   WHERE i.business_id = $1 AND i.plan_id = $2 AND i.seq_no > coalesce($3::integer, 0)
   ORDER BY i.due_date, i.seq_no
   LIMIT $4\`;

const CUSTOMER_STATEMENT_SQL = \`
  SELECT e.entry_kind, e.entry_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.amount_minor::text AS amount_minor
    FROM customer_statement_entries($1, $2, $3::date, $4::date) e
   WHERE ($5::date IS NULL AND $6::text IS NULL AND $7::uuid IS NULL)
      OR (e.entry_date, e.entry_kind, e.entry_id) > ($5::date, $6::text, $7::uuid)
   ORDER BY e.entry_date, e.entry_kind, e.entry_id
   LIMIT $8\`;
`;

describe('P4-S7 §3 — the reads are keyset pages, judged by the real read-surface guard', () => {
  const path = 'apps/api/src/modules/installments/installments-reads.ts';

  it('the guard recognizes the slice’s read module as part of the read surface', () => {
    // A guard that does not see the file is a guard that passes on anything in
    // it, which is the exact hole P4-S3 fell into when the route-surface
    // derivation read one directory.
    expect(readSurfaceFiles({ [path]: CANDIDATE_READ })).toEqual([path]);
  });

  it('CLEAN — the candidate read module breaks none of the seven read-surface rules', () => {
    const violations = findReadSurfaceViolations({ [path]: CANDIDATE_READ });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('RED PROOF — an OFFSET page IS NAMED (law 5)', () => {
    // The plant is the ordinary way a history page gets written, and the one
    // this slice is forbidden: `OFFSET` reads and discards what it skips, and a
    // row appended mid-walk shifts every later page — in a ledger that is a
    // line nobody sees.
    const planted = CANDIDATE_READ.replace('   LIMIT $8`', '   LIMIT $8 OFFSET $9`');
    expect(planted).not.toBe(CANDIDATE_READ);
    const violations = findReadSurfaceViolations({ [path]: planted });
    expect(violations.map((v) => v.rule)).toContain('no OFFSET pagination');
  });

  it('RED PROOF — a stored balance relation in a FROM position IS NAMED', () => {
    const planted = CANDIDATE_READ.replace('FROM installments i', 'FROM installment_balances i');
    expect(planted).not.toBe(CANDIDATE_READ);
    const violations = findReadSurfaceViolations({ [path]: planted });
    expect(violations.map((v) => v.rule)).toContain('no persisted or materialized balance source');
  });

  it('RED PROOF — a write from a read module IS NAMED, so a read can never repair a schedule', () => {
    const planted = `${CANDIDATE_READ}\nconst REPAIR = \`UPDATE installments SET amount_minor = $1 WHERE business_id = $2\`;\n`;
    const violations = findReadSurfaceViolations({ [path]: planted });
    expect(violations.map((v) => v.rule)).toContain('no write to an accounting table');
  });

  it('RED PROOF — a module-level cache of a page IS NAMED', () => {
    const planted = `${CANDIDATE_READ}\nconst pageCache = new Map<string, unknown>();\n`;
    const violations = findReadSurfaceViolations({ [path]: planted });
    expect(violations.map((v) => v.rule)).toContain('no module-level result cache');
  });

  it('RED PROOF — a float parse of an amount IS NAMED, so no page can round a figure into a number', () => {
    const planted = `${CANDIDATE_READ}\nconst wrong = (r: { amount_minor: string }) => Number(r.amount_minor);\n`;
    const violations = findReadSurfaceViolations({ [path]: planted });
    expect(violations.map((v) => v.rule)).toContain('no floating-point parse of an amount');
  });

  it('the cursor comparison names EVERY component of the ordering key', () => {
    // A keyset whose key is not unique either repeats a row or skips one at
    // every page boundary. The statement's key is `(date, kind, id)` and all
    // three appear in the comparison and in the ORDER BY, in the same order.
    const comparison = /\(e\.entry_date, e\.entry_kind, e\.entry_id\) >/.test(CANDIDATE_READ);
    const order = /ORDER BY e\.entry_date, e\.entry_kind, e\.entry_id/.test(CANDIDATE_READ);
    expect(comparison && order).toBe(true);
  });

  it('every settlement figure in the read comes from invoice_outstanding and from nothing else', () => {
    // The ONE definition, reached by name. If a second source of a figure ever
    // appears in this text, the balance-source rule above names it; this
    // asserts the positive half, so a read that computes nothing at all cannot
    // pass by being empty.
    expect(/invoice_outstanding\(/.test(CANDIDATE_READ)).toBe(true);
    expect(/\bsum\s*\(\s*\w*amount/i.test(CANDIDATE_READ), 'a read may not aggregate a settlement figure itself').toBe(false);
  });

  it('every read takes its as-of date as a PARAMETER and never as CURRENT_DATE or now()', () => {
    expect(/\bCURRENT_DATE\b/i.test(CANDIDATE_READ)).toBe(false);
    expect(/\bnow\s*\(\s*\)/i.test(CANDIDATE_READ)).toBe(false);
    expect(/\$\d+::date/.test(CANDIDATE_READ)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. THE REFUSAL TABLE — the compile-time law, driven at runtime
// ─────────────────────────────────────────────────────────────────────────

describe('P4-S7 §4 — every code the arithmetic can raise is a code the API table classifies', () => {
  it('CLEAN — the arithmetic’s closed union is a subset of the API table', () => {
    const unregistered = INSTALLMENT_ARITHMETIC_CODES.filter((c) => !isInstallmentsCode(c));
    expect(unregistered, `unregistered: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('RED PROOF — REMOVING ONE CODE FROM THE TABLE makes the law name exactly that code', () => {
    // The plant is a real copy of the table's key set with one key removed, and
    // the law is re-evaluated over it. This is the runtime twin of the
    // compile-time `INSTALLMENT_PLAN_CODES_ARE_REGISTERED` device: that one
    // fails the build naming the missing property, and this one shows the
    // check is not vacuous when the set is complete.
    for (const victim of INSTALLMENT_ARITHMETIC_CODES) {
      const mutilated = new Set<string>(INSTALLMENTS_CODES.filter((c) => c !== victim));
      const unregistered = INSTALLMENT_ARITHMETIC_CODES.filter((c) => !mutilated.has(c));
      expect(unregistered, victim).toEqual([victim]);
    }
  });

  it('the API table carries no code for a command this slice does not have', () => {
    const forbidden = /interest|apr|\bfee\b|penalty|late_charge|tax|refund|reversal|credit_note|\bbalance\b/;
    for (const code of INSTALLMENTS_CODES) expect(forbidden.test(code), code).toBe(false);
  });

  it('every API code is under one of the two declared prefixes, and the set is deduplicated', () => {
    expect(new Set(INSTALLMENTS_CODES).size).toBe(INSTALLMENTS_CODES.length);
    for (const code of INSTALLMENTS_CODES) expect(/^installment(_plan)?\.[a-z_]+$/.test(code), code).toBe(true);
  });

  it('the op codes this slice needs satisfy the FROZEN operation-code regex', () => {
    // `inventory_operation_kinds.op_code` is `CHECK (op_code ~
    // '^[a-z]+(\\.[a-z_]+)+$')`, frozen inside `inventory_payload_digest`
    // (`0054:229`), so the FIRST SEGMENT may hold no underscore. That is why
    // the op codes are `installments.*` and not `installment_plan.*`, and the
    // claim is measured against the regex rather than remembered.
    const FROZEN = /^[a-z]+(\.[a-z_]+)+$/;
    for (const op of ['installments.plan', 'installments.reschedule', 'installments.cancel']) expect(FROZEN.test(op), op).toBe(true);
    expect(FROZEN.test('installment_plan.create'), 'the underscore-prefixed form is unrepresentable, which is why it is not used').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. L2 — THE SOURCE OF THE ARITHMETIC READS NO CLOCK
// ─────────────────────────────────────────────────────────────────────────

describe('P4-S7 §5 — the arithmetic module reads no clock (law 3, the static half)', () => {
  const SOURCE = readFileSync(join(REPO, 'packages/domain-core/src/installment-schedule.ts'), 'utf8');

  /**
   * The detector, applied to EXECUTABLE source only.
   *
   * Comments are stripped FIRST and the precondition is ASSERTED rather than
   * assumed — the device `scripts/phase4-s1-gate.ts:1413-1424` uses for the
   * same reason: a comment that mentions `Date.now()` can neither satisfy nor
   * fail a law about reading the clock, and a detector that cannot tell the
   * two apart is a detector that reddens on its own documentation.
   *
   * This half is LEXICAL, and that is stated rather than hidden: a module's
   * source is a lexical object and there is nothing semantic to evaluate about
   * "the text contains no clock read". The SEMANTIC half of law 3 is in
   * `packages/domain-core/test/installment-schedule.test.ts` §5, where a real
   * clock-reading implementation is planted and shown to give a DIFFERENT
   * ANSWER from the supplied-date one — a disagreement, not a grep.
   */
  const CLOCK =
    /\b(?:Date\s*\.\s*now|new\s+Date|performance\s*\.\s*now|hrtime|CURRENT_DATE|CURRENT_TIMESTAMP|localtime|clock_timestamp|statement_timestamp|now\s*\(\s*\))/;
  const stripProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

  it('the comment stripper really does remove prose, so the law cannot redden on its own documentation', () => {
    expect(stripProse('/* new Date() */ const a = 1;')).not.toMatch(CLOCK);
    expect(stripProse('// Date.now()\nconst a = 1;')).not.toMatch(CLOCK);
    expect(stripProse('const a = new Date();')).toMatch(CLOCK);
  });

  it('CLEAN — the executable body of the arithmetic names no clock', () => {
    const executable = stripProse(SOURCE);
    expect(executable.length, 'the stripper removed everything, so the law would pass vacuously').toBeGreaterThan(2000);
    const hit = CLOCK.exec(executable);
    expect(hit?.[0] ?? null, `the arithmetic may not read the clock; found ${String(hit?.[0])}`).toBeNull();
  });

  it('RED PROOF — a defaulted as-of date IS NAMED', () => {
    // The plant is the exact accident the project has already paid for: a
    // `new Date()` added to "default" the as-of date, which puts a
    // server-resolved date inside a financial command's fingerprint.
    const planted = SOURCE.replace(
      'export function installmentStatus(amountMinor: bigint, settledMinor: bigint, dueDate: CivilDate, asOf: CivilDate): InstallmentStatus {',
      'export function installmentStatus(amountMinor: bigint, settledMinor: bigint, dueDate: CivilDate, asOf?: CivilDate): InstallmentStatus {\n  asOf = asOf ?? new Date().toISOString().slice(0, 10);',
    );
    expect(planted, 'the plant did not change the source').not.toBe(SOURCE);
    expect(stripProse(planted)).toMatch(CLOCK);
  });

  it('RED PROOF — a SQL clock read in the same module IS NAMED', () => {
    const planted = `${SOURCE}\nexport const WRONG = 'SELECT CURRENT_DATE';\n`;
    expect(stripProse(planted)).toMatch(CLOCK);
  });

  it('the module’s every status entry point takes asOf as a REQUIRED argument', () => {
    // The positive half: a law that only forbids a clock is satisfied by a
    // module that derives no status at all.
    expect(/export function installmentStatus\([^)]*asOf: CivilDate\)/.test(SOURCE)).toBe(true);
    expect(/export function projectSchedule\(schedule: Schedule, outstandingMinor: bigint, asOf: CivilDate\)/.test(SOURCE)).toBe(true);
    // No optional as-of anywhere: `asOf?:` is the shape a default hides behind.
    expect(/asOf\?\s*:/.test(stripProse(SOURCE))).toBe(false);
  });
});
