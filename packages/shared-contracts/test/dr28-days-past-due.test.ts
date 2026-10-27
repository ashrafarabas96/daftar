import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CustomerOpenInvoiceDto } from '../src';

/**
 * DR-28 — `days_past_due` is measured from `coalesce(due_date, issue_date)`,
 * in EVERY interface and reader, and `NULL` is forbidden for an invoice that
 * is due.
 *
 * ── WHY THIS SUITE LIVES IN THE CONTRACTS PACKAGE ────────────────────────
 *
 * The figure is computed in SQL, inside `apps/api/.../customer-reads.ts`, so
 * that ONE date arithmetic serves the open-invoices page and the aging report
 * — this module adds no second copy of the formula to the product. But
 * `apps/api` has NO test runner of its own (measured: its `package.json`
 * declares no `test` script and the tree holds no vitest config for it), and
 * everything under `tests/**` reaches PostgreSQL through an unconditional
 * `ensurePostgres()`. `@daftar/shared-contracts` is in the root `test` script,
 * so a law written here actually RUNS. That is why a contracts suite reads a
 * reader's source text: it is the only runner that owns this contract and
 * executes without a database.
 *
 * ── WHAT IS PROVEN HERE, AND WHAT IS NOT ─────────────────────────────────
 *
 * PROVEN WITHOUT A DATABASE: the rule's own arithmetic over civil dates at
 * every boundary; that the reader's LIVE SQL anchors the age on
 * `coalesce(due_date, issue_date)` and carries the separate
 * `has_explicit_due_date` flag; that the retired `NULL`-producing form is
 * gone and that this check can SEE that form when it is present; that the
 * page and the aging routine (`0084`) anchor on the SAME expression; and that
 * the contract makes a null age UNREPRESENTABLE.
 *
 * NOT_RUN — needs a database: that PostgreSQL's `date - date` returns exactly
 * what the oracle below computes, and that the page and
 * `customer_ar_aging(...)` report the same age for the same termless invoice
 * on real rows. The agreement is asserted here at the level that is
 * available — the shared expression and the contract — and the live
 * cross-check is NOT_RUN, not assumed.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const READER = join(REPO_ROOT, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts');
const AGING_MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');
const SELLING_CORE_MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0075_phase4_customers_invoices_numbering.sql');

/**
 * The file's own doc comments quote SQL on purpose, and a check that cannot
 * tell a quotation from a live filter is worthless in both directions: it
 * would pass on prose and fail on prose. So every text law below reads the
 * source with block and line comments REMOVED, and nothing else removed.
 */
function liveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** The retired, defect-bearing form DR-28 replaces. */
const RETIRED = /due_date\s+IS\s+NULL\s+THEN\s+NULL/i;
/** The DR-28 anchor, as the page must write it. */
const ANCHOR = /\$3::date\s*-\s*coalesce\(\s*o\.due_date\s*,\s*o\.issue_date\s*\)/i;
/** The separate flag, derived from the column's presence and from nothing else. */
const FLAG = /\(\s*o\.due_date\s+IS\s+NOT\s+NULL\s*\)\s+AS\s+has_explicit_due_date/i;

// ── The rule, over civil dates ─────────────────────────────────────────────
//
// `YYYY-MM-DD` to a count of days with NO clock, NO local timezone and NO
// `Date` parsed from a string: the parts are read as integers and turned into
// a UTC epoch-day index, so this function returns the same number under
// `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Honolulu` (DR-20). A civil
// date minus a civil date has no zone, and neither does this.

function epochDay(civil: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (m === null) throw new Error(`not a civil date: ${civil}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round(ms / 86_400_000);
}

/**
 * The oracle: the rule DR-28 states, independent of the SQL that implements
 * it. `dueDate` absent falls back to `issueDate` (DR-13, DR-21), so the
 * result is a number for every due invoice and never `null`.
 */
function daysPastDue(asOf: string, issueDate: string, dueDate: string | null): number {
  return epochDay(asOf) - epochDay(dueDate ?? issueDate);
}

describe('DR-28 — the age of a termless invoice is a number, measured from its issue date', () => {
  it('a TERMLESS invoice ages from its issue date, and is NOT null', () => {
    const age = daysPastDue('2027-01-02', '2025-11-28', null);
    expect(age).toBe(400);
    expect(age).not.toBeNull();
  });

  it('an invoice WITH a stated due date keeps exactly the figure it had before DR-28 (regression guard)', () => {
    // The pre-DR-28 expression was `as_of - due_date` whenever a due date
    // existed. DR-28 must not move a figure that was already correct, so the
    // guard states the OLD arithmetic explicitly and requires agreement.
    for (const c of [
      { asOf: '2026-08-31', issue: '2026-08-01', due: '2026-08-31' },
      { asOf: '2026-09-30', issue: '2026-08-01', due: '2026-08-31' },
      { asOf: '2026-08-01', issue: '2026-08-01', due: '2026-08-31' },
      { asOf: '2030-01-01', issue: '2026-08-01', due: '2026-08-31' },
    ]) {
      const preDr28 = epochDay(c.asOf) - epochDay(c.due);
      expect(daysPastDue(c.asOf, c.issue, c.due)).toBe(preDr28);
    }
  });

  it('the anchor is the due date WHENEVER one exists, even when it precedes nothing useful', () => {
    // A stated due date wins over the issue date, always: the fallback is a
    // fallback, not a preference.
    expect(daysPastDue('2026-03-01', '2026-01-01', '2026-02-01')).toBe(28);
    expect(daysPastDue('2026-03-01', '2026-01-01', null)).toBe(59);
  });

  it('the day boundaries hold on each side and ON the anchor itself', () => {
    expect(daysPastDue('2026-08-31', '2026-01-01', '2026-08-31')).toBe(0);
    expect(daysPastDue('2026-09-01', '2026-01-01', '2026-08-31')).toBe(1);
    expect(daysPastDue('2026-08-30', '2026-01-01', '2026-08-31')).toBe(-1);
    // The same three, with the anchor reached through the fallback.
    expect(daysPastDue('2026-08-31', '2026-08-31', null)).toBe(0);
    expect(daysPastDue('2026-09-01', '2026-08-31', null)).toBe(1);
    expect(daysPastDue('2026-08-30', '2026-08-31', null)).toBe(-1);
  });

  it('a date BEFORE the anchor is a signed negative, never clamped to zero and never null', () => {
    // Pinned by this suite, because a client that renders this figure has to
    // know which it is: the contract says negative before the anchor.
    const early = daysPastDue('2026-01-01', '2026-06-30', null);
    expect(early).toBe(-180);
    expect(early).toBeLessThan(0);
    expect(Object.is(early, -0)).toBe(false);
  });

  it('a FUTURE-dated issue on a termless invoice is negative, and the aging bands read it as not-yet-due', () => {
    expect(daysPastDue('2026-10-27', '2026-12-11', null)).toBe(-45);
  });

  it('the civil-date boundaries that break naive arithmetic hold', () => {
    // A leap day, both as the anchor and across it.
    expect(daysPastDue('2028-02-29', '2028-02-29', null)).toBe(0);
    expect(daysPastDue('2028-03-01', '2028-02-29', null)).toBe(1);
    expect(daysPastDue('2028-03-01', '2028-02-28', null)).toBe(2);
    // A non-leap year's end of February.
    expect(daysPastDue('2027-03-01', '2027-02-28', null)).toBe(1);
    // A year end.
    expect(daysPastDue('2027-01-01', '2026-12-31', null)).toBe(1);
    // A full leap year and a full common year.
    expect(daysPastDue('2029-01-01', '2028-01-01', null)).toBe(366);
    expect(daysPastDue('2028-01-01', '2027-01-01', null)).toBe(365);
    // The shortest and longest months.
    expect(daysPastDue('2026-03-01', '2026-02-01', null)).toBe(28);
    expect(daysPastDue('2026-02-01', '2026-01-01', null)).toBe(31);
    // A spring-forward and an autumn-back crossing in a DST-observing zone:
    // the count is the civil day count, so a 23-hour and a 25-hour day change
    // nothing.
    expect(daysPastDue('2026-03-29', '2026-03-28', null)).toBe(1);
    expect(daysPastDue('2026-10-26', '2026-10-25', null)).toBe(1);
  });

  it('the oracle reads no clock and no local zone — a civil subtraction has neither', () => {
    const source = daysPastDue.toString() + epochDay.toString();
    for (const forbidden of ['Date.now', 'getTimezoneOffset', 'toISOString', 'new Date(']) {
      expect(source).not.toContain(forbidden);
    }
    // `Date.UTC` is arithmetic on integers, not a reading of anything.
    expect(source).toContain('Date.UTC');
  });
});

describe('DR-28 — the reader that produces the figure says so in live SQL', () => {
  it('the open-invoices page anchors the age on coalesce(due_date, issue_date)', () => {
    expect(ANCHOR.test(liveCode(READER))).toBe(true);
  });

  it('the retired NULL-producing form is gone from the live code', () => {
    expect(RETIRED.test(liveCode(READER))).toBe(false);
  });

  it('this check can SEE the retired form when it is present (positive control)', () => {
    // A check that only ever asserts an absence proves nothing about itself.
    const asItWas = 'CASE WHEN o.due_date IS NULL THEN NULL ELSE ($3::date - o.due_date) END AS days_past_due';
    expect(RETIRED.test(asItWas)).toBe(true);
    expect(ANCHOR.test(asItWas)).toBe(false);
    expect(FLAG.test(asItWas)).toBe(false);
  });

  it('the no-stated-due-date display is a SEPARATE flag, derived from the column and from nothing else', () => {
    const code = liveCode(READER);
    expect(FLAG.test(code)).toBe(true);
    // The flag must not be inferred from the age, or the two would collide the
    // day the age legitimately reads zero or negative.
    expect(/has_explicit_due_date[^\n]*days_past_due/i.test(code)).toBe(false);
    expect(/days_past_due[^\n]*has_explicit_due_date/i.test(code)).toBe(false);
  });

  it('no arm of the age expression can yield NULL — structurally, not by example', () => {
    const code = liveCode(READER);
    // 1. The age is a plain subtraction, with no CASE and no NULLIF around it.
    expect(/CASE[^\n]*AS\s+days_past_due/i.test(code)).toBe(false);
    expect(/nullif[^\n]*AS\s+days_past_due/i.test(code)).toBe(false);
    // 2. `coalesce` makes the right operand total — PROVIDED the fallback
    //    column is itself never null. That is a schema fact, so it is measured
    //    in the schema, not assumed: `invoices.issue_date` is `DATE NOT NULL`,
    //    and the page reader RETURNS it, so no arm of the coalesce is null and
    //    the subtraction has no null operand.
    const schema = readFileSync(SELLING_CORE_MIGRATION, 'utf8');
    expect(/issue_date\s+DATE\s+NOT\s+NULL/i.test(schema)).toBe(true);
    // And the fallback is SIGNED: `invoices_due_date_ck` means a stated due
    // date is never EARLIER than the issue date, so substituting the issue
    // date can only ever make an invoice look as old or OLDER — never
    // younger. The safe direction for a receivable.
    expect(/invoices_due_date_ck\s+CHECK\s*\(\s*due_date\s+IS\s+NULL\s+OR\s+due_date\s*>=\s*issue_date\s*\)/i.test(schema)).toBe(true);
    const aging = readFileSync(AGING_MIGRATION, 'utf8');
    expect(/RETURNS\s+TABLE\s*\(invoice_id\s+UUID,\s*issue_date\s+DATE/i.test(aging)).toBe(true);
    // 3. And the row type the reader declares for the column is not nullable,
    //    so a null would not even typecheck through the mapping.
    expect(/days_past_due:\s*number;/.test(liveCode(READER))).toBe(true);
    expect(/days_past_due:\s*number\s*\|\s*null/.test(liveCode(READER))).toBe(false);
  });

  it('the page and the aging report measure the age from the SAME anchor (live cross-check NOT_RUN)', () => {
    // `customer_ar_aging` in `0084` buckets on `coalesce(o.due_date,
    // o.issue_date)` (DR-13/DR-21). The page must not anchor anywhere else,
    // or the merchant sees one age on the list and another in the report —
    // which is the defect DR-28 exists to close.
    const aging = readFileSync(AGING_MIGRATION, 'utf8');
    expect(/coalesce\(\s*o\.due_date\s*,\s*o\.issue_date\s*\)/i.test(aging)).toBe(true);
    const code = liveCode(READER);
    const pageAnchor = /coalesce\(\s*o\.due_date\s*,\s*o\.issue_date\s*\)/i;
    expect(pageAnchor.test(code)).toBe(true);
    // Agreement of the two EXPRESSIONS is what this runner can assert. That
    // the two SQL callables return the same number for the same stored row is
    // NOT_RUN here: it needs PostgreSQL.
  });
});

describe('DR-28 — the contract makes a null age unrepresentable', () => {
  const termless: CustomerOpenInvoiceDto = {
    invoiceId: '33333333-3333-4333-8333-333333333333',
    documentKind: 'invoice',
    documentNumber: 'INV-2026-000002',
    issueDate: '2025-11-28',
    dueDate: null,
    currency: 'JOD',
    totalTxnMinor: '100000',
    outstandingTxnMinor: '60000',
    outstandingBaseMinor: '60000',
    settlementState: 'partial',
    daysPastDue: 400,
    hasExplicitDueDate: false,
  };

  const withTerms: CustomerOpenInvoiceDto = {
    ...termless,
    documentNumber: 'INV-2026-000001',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    daysPastDue: 30,
    hasExplicitDueDate: true,
  };

  it('a termless row carries a real age and says the due date was not stated', () => {
    expect(termless.dueDate).toBeNull();
    expect(termless.hasExplicitDueDate).toBe(false);
    expect(termless.daysPastDue).toBe(daysPastDue('2027-01-02', termless.issueDate, termless.dueDate));
  });

  it('`hasExplicitDueDate` is true exactly when a due date is stated, on both rows', () => {
    for (const row of [termless, withTerms]) {
      expect(row.hasExplicitDueDate).toBe(row.dueDate !== null);
      expect(typeof row.daysPastDue).toBe('number');
    }
  });

  it('`hasExplicitDueDate` is a FIELD of its own, so the age and the display never collide', () => {
    const keys = Object.keys(withTerms);
    expect(keys).toContain('hasExplicitDueDate');
    expect(keys).toContain('daysPastDue');
    expect(keys).toContain('dueDate');
    // It is not a sentinel smuggled into the age, and not a renaming of
    // `dueDate`: all three are present together and independent.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('`daysPastDue: null` does not typecheck — the forbidden value is unrepresentable', () => {
    // @ts-expect-error DR-28: `null` is forbidden for an invoice that is due,
    // so the contract's field is `number`, not `number | null`. If this line
    // ever compiles, the ban has been lifted and this assertion fails.
    const illegal: CustomerOpenInvoiceDto = { ...withTerms, daysPastDue: null };
    expect(illegal).toBeTruthy();
  });
});
