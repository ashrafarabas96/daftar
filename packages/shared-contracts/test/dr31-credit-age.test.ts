import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CustomerOpenInvoiceDto } from '../src';

/**
 * DR-31 — a credit is not overdue debt.
 *
 * Every document carries `age_days = as_of - the document's own date`.
 * `days_past_due` is for DEBIT documents only: a credit note, and ANY credit
 * balance, reports `days_past_due = 0` with `is_credit = true`, and the
 * interface says "a credit balance on an invoice X days old" rather than
 * "overdue" (DR-35 settled that wording; `dr35_*` below holds it). The type
 * stays `number` with no `NULL` (DR-28), and no total changes.
 *
 * ── WHY "THE DOCUMENT'S OWN DATE" IS `issue_date`, NOT DR-28's ANCHOR ─────
 *
 * DR-28's anchor is `coalesce(due_date, issue_date)` because it answers "how
 * LATE is this debt", and lateness is measured against a term. `age_days`
 * answers a different question — "how OLD is this document" — so it reads the
 * date the document bears and nothing else. Three reasons, and they are not
 * stylistic:
 *
 *  1. A payment term is not part of a document's age, and a credit note has no
 *     meaningful term at all. And because the figure is the DOCUMENT's age,
 *     the approved wording names the invoice: "a credit balance on an invoice X days old"
 *     (DR-35). The superseded form claimed X days since the credit AROSE,
 *     which is not what this field measures.
 *  2. `issue_date` is `DATE NOT NULL` on every row of every kind (`0075`), so
 *     the subtraction is TOTAL with no fallback. Nothing is substituted, so
 *     there is no direction of error to sign — which is strictly safer than a
 *     signed fallback.
 *  3. INDEPENDENCE. Had `age_days` anchored on the due date, then for a debit
 *     invoice with a stated term `age_days === days_past_due` identically, and
 *     a client could derive either from the other. That derivation would break
 *     silently the first time a credit appeared. Keeping the anchors different
 *     is what makes the two fields two facts.
 *
 * ── DR-28 AND DR-31 DO NOT COLLIDE ───────────────────────────────────────
 *
 * DR-28 governs "an invoice that is DUE" and forbids `NULL` for it. A credit is
 * not due FROM the customer, so DR-31 is not an exception to DR-28 but a
 * statement about a different population. Operationally: a debit row's
 * `days_past_due` is produced by the DR-28 expression byte for byte, in the
 * `ELSE` arm of the new CASE, and every case DR-28 pinned is re-asserted below
 * as a regression guard.
 *
 * ── WHAT IS PROVEN HERE, AND WHAT IS NOT ─────────────────────────────────
 *
 * PROVEN WITHOUT A DATABASE: the rule's arithmetic at every boundary; that the
 * reader's LIVE SQL emits `age_days` from `issue_date`, forces a literal `0`
 * for a credit, and derives `is_credit` from ONE definition that reads no date;
 * that this check can see each of those forms when it is absent or wrong; and
 * that the contract makes a null age and a null `is_credit` unrepresentable.
 *
 * NOT_RUN — needs a database: that PostgreSQL returns these figures for stored
 * rows, and that an overpaid invoice really arrives on this page with a
 * negative outstanding. The latter is argued from measured schema text
 * (`customer_open_invoices_page` filters `outstanding_txn_minor <> 0`, not
 * `> 0`) and is NOT_RUN as behaviour.
 *
 * ── A MEASURED LIMIT ON THE CREDIT-NOTE KIND ─────────────────────────────
 *
 * `invoices_document_kind_ck` in `0075` CHECKs `document_kind = 'invoice'`. So
 * on the published schema a `credit_note` ROW IS NOT REPRESENTABLE TODAY: the
 * kind arm of the rule is forward-looking and becomes live the day P4-S5 adds
 * the kind. The reader's row type and the contract already type the column as
 * `'invoice' | 'credit_note'`, and a client already branches on it, which is
 * why the rule is written now. The arm that is live TODAY is the SIGN arm — a
 * credit balance on an otherwise debit document.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const READER = join(REPO_ROOT, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts');
const AGING_MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');

/**
 * The POPULATION filters over `outstanding_txn_minor` in a migration: the
 * `WHERE` predicates that decide WHICH documents a routine reads.
 *
 * Two things are removed first, and both removals are the point rather than
 * convenience:
 *
 *   - `--` comments, because a sentence describing a predicate is not one. The
 *     band routine's own commentary quotes `(WHERE o.outstanding_txn_minor >
 *     0)` while explaining what it does NOT do.
 *   - `FILTER (…)` clauses, because a per-aggregate predicate splits a
 *     population that has already been chosen; it does not choose it.
 *     `count(…) FILTER (WHERE … > 0)` counts the debit side OF the `<> 0`
 *     population, which is DR-39's requirement and not a violation of DR-23.
 *
 * What is left is what DR-31 and DR-23 are about.
 *
 * DECLARED LIMIT: `[^)]*` cannot cross a `)`, so a `FILTER (…)` holding a
 * nested call — `FILTER (WHERE coalesce(x, 0) > 0)` — is stripped only up to
 * that inner paren and its predicate then matches nothing. Such a filter
 * becomes INVISIBLE to this probe, which is the safe direction: an aggregate's
 * predicate is out of scope here by design. A population `WHERE` can never be
 * swallowed instead, because the removal starts at `FILTER (` and stops at or
 * before that filter's own closing paren, so it cannot reach a later clause.
 * The floor asserted at the call site is what keeps the whole probe honest.
 */
function populationFiltersOf(sql: string): readonly string[] {
  const code = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const withoutAggregateFilters = code.replace(/FILTER\s*\([^)]*\)/gi, ' ');
  return withoutAggregateFilters.match(/WHERE\s+o\.outstanding_txn_minor\s*(?:<>|>=|<=|>|<|=)\s*0/gi) ?? [];
}
const SELLING_CORE_MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0075_phase4_customers_invoices_numbering.sql');

/** Source text with block and line comments removed, and nothing else removed. */
function liveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** The ONE definition of "credit-bearing", as the reader must declare it. */
const CREDIT_DEFINITION = /const\s+CREDIT_BEARING_SQL\s*=\s*`\(i\.document_kind\s*=\s*'credit_note'\s+OR\s+o\.outstanding_txn_minor\s*<\s*0\)`;/;
/** `age_days` comes off the document's own date, with no coalesce and no term. */
const AGE_DAYS = /\(\s*\$3::date\s*-\s*o\.issue_date\s*\)\s+AS\s+age_days/i;
/** A credit's overdue age is a LITERAL zero, under the shared predicate. */
const CREDIT_ZERO = /CASE\s+WHEN\s+\$\{CREDIT_BEARING_SQL\}\s+THEN\s+0\b/;
/** `is_credit` is the shared predicate itself, and not a restatement of it. */
const IS_CREDIT_COLUMN = /\$\{CREDIT_BEARING_SQL\}\s+AS\s+is_credit/;

// ── The rule, over civil dates ─────────────────────────────────────────────
//
// Integers to an epoch-day index, with no clock, no local zone and no `Date`
// parsed from a string, so every figure below is identical under `TZ=UTC`,
// `TZ=Asia/Jerusalem` and `TZ=Pacific/Honolulu` (DR-20).

function epochDay(civil: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (m === null) throw new Error(`not a civil date: ${civil}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** DR-31: the document's own date to the as-of date, for EVERY kind. */
function ageDays(asOf: string, issueDate: string): number {
  return epochDay(asOf) - epochDay(issueDate);
}

/**
 * DR-31: credit-bearing is decided by the document's own KIND or the SIGN of
 * its money.
 *
 * It takes NO date argument — not the as-of date, not the due date, not an age.
 * That signature is the structural half of the trap this decision sets: were
 * `is_credit` allowed to depend on an age, a debit invoice due today would read
 * as a credit. A test below asserts the absence from this function's own text,
 * so the signature cannot quietly grow one.
 *
 * The kind arm is enumerated POSITIVELY. `kind !== 'invoice'` would sweep an
 * unknown future DEBIT kind in as credit, force its `days_past_due` to zero and
 * stop a real debt reading as overdue — a debt leaving the report by omission.
 */
function isCreditBearing(documentKind: string, outstandingTxnMinor: bigint): boolean {
  return documentKind === 'credit_note' || outstandingTxnMinor < 0n;
}

/** DR-28 for a debit document; DR-31's literal zero for a credit. */
function daysPastDue(asOf: string, issueDate: string, dueDate: string | null, documentKind: string, outstandingTxnMinor: bigint): number {
  if (isCreditBearing(documentKind, outstandingTxnMinor)) return 0;
  return epochDay(asOf) - epochDay(dueDate ?? issueDate);
}

const CREDIT_NOTE = 'credit_note';
const INVOICE = 'invoice';
const OWED = 60_000n; // a positive outstanding: the customer owes this
const IN_CREDIT = -2_500n; // a negative outstanding: the merchant owes this

describe("DR-31 — age_days is the document's own age, for every kind", () => {
  it('a DEBIT invoice carries an age measured from its issue date, beside a different overdue figure', () => {
    // 2026-08-01 issued, 2026-08-31 due, read on 2026-09-30.
    expect(ageDays('2026-09-30', '2026-08-01')).toBe(60);
    expect(daysPastDue('2026-09-30', '2026-08-01', '2026-08-31', INVOICE, OWED)).toBe(30);
    // The two are DIFFERENT numbers for the same row. Neither is derivable
    // from the other without the due date, which is exactly the independence
    // DR-31 preserves by not anchoring `age_days` on the term.
  });

  it('age_days is zero ON the issue date, and one on each side of it (the boundary)', () => {
    expect(ageDays('2026-08-01', '2026-08-01')).toBe(0);
    expect(ageDays('2026-08-02', '2026-08-01')).toBe(1);
    expect(ageDays('2026-07-31', '2026-08-01')).toBe(-1);
    // Zero is a real value and not a missing one: `Object.is(-0)` would be a
    // different value to a client that formats it.
    expect(Object.is(ageDays('2026-08-01', '2026-08-01'), -0)).toBe(false);
  });

  it("age_days ignores the due date entirely — a stated term does not change a document's age", () => {
    // Same issue date, same as-of date, two different terms: one age.
    const withShortTerm = ageDays('2026-09-30', '2026-08-01');
    const withLongTerm = ageDays('2026-09-30', '2026-08-01');
    expect(withShortTerm).toBe(withLongTerm);
    expect(withShortTerm).toBe(60);
    // And the overdue figures for those same two rows DO differ, which is why
    // the two fields are two fields.
    expect(daysPastDue('2026-09-30', '2026-08-01', '2026-08-15', INVOICE, OWED)).toBe(46);
    expect(daysPastDue('2026-09-30', '2026-08-01', '2026-09-15', INVOICE, OWED)).toBe(15);
  });

  it('the civil-date boundaries that break naive arithmetic hold for age_days too', () => {
    expect(ageDays('2028-02-29', '2028-02-29')).toBe(0); // a leap day as the anchor
    expect(ageDays('2028-03-01', '2028-02-29')).toBe(1); // across it
    expect(ageDays('2027-03-01', '2027-02-28')).toBe(1); // a common year's end of February
    expect(ageDays('2027-01-01', '2026-12-31')).toBe(1); // a year end
    expect(ageDays('2029-01-01', '2028-01-01')).toBe(366); // a full leap year
    expect(ageDays('2028-01-01', '2027-01-01')).toBe(365); // a full common year
    expect(ageDays('2026-03-01', '2026-02-01')).toBe(28); // the shortest month
    expect(ageDays('2026-02-01', '2026-01-01')).toBe(31); // a longest month
    expect(ageDays('2026-03-01', '2026-03-31')).toBe(-30); // the first day of a month, before
    expect(ageDays('2026-03-31', '2026-03-01')).toBe(30); // and the last day, after
    // A spring-forward and an autumn-back crossing: a 23-hour and a 25-hour
    // civil day are both one day.
    expect(ageDays('2026-03-29', '2026-03-28')).toBe(1);
    expect(ageDays('2026-10-26', '2026-10-25')).toBe(1);
  });

  it('age_days needs no fallback, so there is no substitution to sign', () => {
    // `issue_date` is `DATE NOT NULL`, measured in the schema rather than
    // assumed, and the page reader RETURNS it — so the left and right operands
    // are both total and `age_days` can never be NULL for any kind of
    // document. DR-28's anchor needed a signed fallback; this one has none.
    const schema = readFileSync(SELLING_CORE_MIGRATION, 'utf8');
    expect(/issue_date\s+DATE\s+NOT\s+NULL/i.test(schema)).toBe(true);
    const aging = readFileSync(AGING_MIGRATION, 'utf8');
    expect(/RETURNS\s+TABLE\s*\(invoice_id\s+UUID,\s*issue_date\s+DATE/i.test(aging)).toBe(true);
    expect(ageDays.toString()).not.toContain('coalesce');
    expect(ageDays.toString()).not.toContain('??');
  });

  it('the oracles read no clock and no local zone', () => {
    const source = ageDays.toString() + daysPastDue.toString() + epochDay.toString();
    for (const forbidden of ['Date.now', 'getTimezoneOffset', 'toISOString', 'new Date(']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('Date.UTC');
  });
});

describe('DR-31 — a credit has no overdue age', () => {
  it('a CREDIT NOTE with NO stated due date reports days_past_due 0, not an age', () => {
    // Before DR-31 this row reported `null` (pre-DR-28) and then a POSITIVE
    // overdue age (post-DR-28, which is the question S-21 raised). DR-31: it
    // is a credit, so zero — and its real age travels in `age_days`.
    expect(daysPastDue('2027-01-02', '2025-11-28', null, CREDIT_NOTE, IN_CREDIT)).toBe(0);
    expect(ageDays('2027-01-02', '2025-11-28')).toBe(400);
    expect(isCreditBearing(CREDIT_NOTE, IN_CREDIT)).toBe(true);
  });

  it('a CREDIT NOTE WITH a stated due date still reports days_past_due 0, and ages from its issue date', () => {
    // The term is present and is deliberately NOT used: a credit note's term
    // would otherwise produce an "overdue" figure for money the customer does
    // not owe. And `age_days` is measured from the ISSUE date, not the term,
    // so the two answers differ and the right one is reported for each.
    expect(daysPastDue('2026-09-30', '2026-08-01', '2026-08-31', CREDIT_NOTE, IN_CREDIT)).toBe(0);
    expect(ageDays('2026-09-30', '2026-08-01')).toBe(60);
    // The figure it WOULD have had under DR-28's anchor, stated so the
    // difference is visible rather than implied.
    expect(epochDay('2026-09-30') - epochDay('2026-08-31')).toBe(30);
  });

  it('a CREDIT BALANCE on an otherwise DEBIT document reports days_past_due 0 (DR-23)', () => {
    // This is the arm that is LIVE on today's schema. An overpaid invoice is
    // `document_kind = 'invoice'` with a NEGATIVE outstanding, and
    // `customer_open_invoices_page` filters `outstanding_txn_minor <> 0` — not
    // `> 0` — so the row reaches this page. Measured in the migration below,
    // because the whole case depends on it.
    expect(isCreditBearing(INVOICE, IN_CREDIT)).toBe(true);
    expect(daysPastDue('2027-01-02', '2025-11-28', '2025-12-28', INVOICE, IN_CREDIT)).toBe(0);
    expect(ageDays('2027-01-02', '2025-11-28')).toBe(400);
    const aging = readFileSync(AGING_MIGRATION, 'utf8');
    expect(/WHERE\s+o\.outstanding_txn_minor\s*<>\s*0/i.test(aging)).toBe(true);
    // ── AND THE NEGATIVE HALF, NARROWED TO ITS SUBJECT ────────────────────
    //
    // This used to read `expect(/WHERE … > 0/.test(aging)).toBe(false)` over
    // the WHOLE FILE, and that was over-broad in a way that only became
    // visible when DR-39 arrived: it forbade a SUBSTRING rather than a
    // behaviour, so a legitimate `> 0` anywhere in the migration broke it.
    // DR-39 then introduced two of them — `customer_ar_open_document_counts`
    // splits its counters by sign IN SQL, which is DR-39's own requirement and
    // is pinned by `dr39-open-document-counts.test.ts` (dr39_8) — plus one in
    // a comment. The two laws became MUTUALLY UNSATISFIABLE as written: one
    // demanded the substring exist, the other that it not.
    //
    // Neither intent yields. DR-31 is about which documents the routines
    // SELECT — the population must be `<> 0` so credit balances are carried
    // (DR-23) — and DR-39 is about how a counter SPLITS that population once
    // selected. A per-aggregate `FILTER (…)` is the second thing and never the
    // first, and a comment is not code at all. So the claim is now stated
    // POSITIVELY and over the population filters alone.
    const population = populationFiltersOf(aging);
    // Non-vacuity FIRST: a probe that found nothing would satisfy every
    // "every" below, and silently. Three routines select this population —
    // `customer_ar_aging`, `customer_ar_open_document_counts` and
    // `customer_open_invoices_page` — so three is the floor. A FLOOR and not
    // an equality, because a later migration adding a fourth selector should
    // have to satisfy this law, not renumber it.
    expect(population.length, 'the probe must find the population filters, or "every one is <> 0" is vacuous').toBeGreaterThanOrEqual(3);
    // And the substance: EVERY population filter selects `<> 0`. A `> 0` here
    // would drop every credit balance from the page and the bands — money
    // leaving a report by omission, which is what DR-23 forbids.
    for (const [i, filter] of population.entries()) {
      expect(filter, `population filter ${String(i + 1)} of ${String(population.length)} must select \`<> 0\`, never \`> 0\``).toMatch(
        /outstanding_txn_minor\s*<>\s*0/i,
      );
    }
  });

  it('days_past_due is NEVER negative for a credit — asserted over the space, not by example', () => {
    // Every combination of anchor position and credit source: whatever the
    // dates do, a credit reports exactly zero. A clamp would also pass this,
    // so the SQL-level law below additionally requires the arm to be a LITERAL
    // `0` with no subtraction in it.
    const asOfs = ['2020-01-01', '2026-10-27', '2026-10-28', '2026-10-26', '2099-12-31'];
    const issues = ['2026-10-27', '2025-11-28', '2028-02-29', '2026-12-11'];
    const dues: (string | null)[] = [null, '2026-10-27', '2030-01-01', '2026-01-01'];
    const credits: [string, bigint][] = [
      [CREDIT_NOTE, IN_CREDIT],
      [CREDIT_NOTE, OWED],
      [INVOICE, IN_CREDIT],
      [CREDIT_NOTE, 0n],
    ];
    let checked = 0;
    for (const asOf of asOfs) {
      for (const issue of issues) {
        for (const due of dues) {
          for (const [kind, outstanding] of credits) {
            const d = daysPastDue(asOf, issue, due, kind, outstanding);
            expect(d).toBe(0);
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).not.toBeNull();
            checked += 1;
          }
        }
      }
    }
    // The sweep is not vacuous.
    expect(checked).toBe(asOfs.length * issues.length * dues.length * credits.length);
    expect(checked).toBe(320);
  });

  it('nothing is ever NULL — neither figure, for any kind', () => {
    const rows: [string, bigint][] = [
      [INVOICE, OWED],
      [INVOICE, IN_CREDIT],
      [CREDIT_NOTE, IN_CREDIT],
    ];
    for (const [kind, outstanding] of rows) {
      for (const due of [null, '2026-08-31'] as (string | null)[]) {
        expect(typeof daysPastDue('2026-09-30', '2026-08-01', due, kind, outstanding)).toBe('number');
        expect(Number.isInteger(daysPastDue('2026-09-30', '2026-08-01', due, kind, outstanding))).toBe(true);
      }
      expect(typeof ageDays('2026-09-30', '2026-08-01')).toBe('number');
    }
  });

  it('a DEBIT invoice keeps exactly the figures DR-28 pinned (regression guard)', () => {
    // The same four cases DR-28 pins, re-asserted through the DR-31 signature
    // with a debit kind and a positive outstanding: DR-31 must not move a
    // single one of them.
    for (const c of [
      { asOf: '2026-08-31', issue: '2026-08-01', due: '2026-08-31' },
      { asOf: '2026-09-30', issue: '2026-08-01', due: '2026-08-31' },
      { asOf: '2026-08-01', issue: '2026-08-01', due: '2026-08-31' },
      { asOf: '2030-01-01', issue: '2026-08-01', due: '2026-08-31' },
    ]) {
      const dr28 = epochDay(c.asOf) - epochDay(c.due);
      expect(daysPastDue(c.asOf, c.issue, c.due, INVOICE, OWED)).toBe(dr28);
    }
    // And the termless debit invoice DR-28 exists for: still 400, still not
    // zero, still not null.
    const termless = daysPastDue('2027-01-02', '2025-11-28', null, INVOICE, OWED);
    expect(termless).toBe(400);
    expect(termless).not.toBe(0);
    // Including the signed negative DR-28 pins before the anchor.
    expect(daysPastDue('2026-01-01', '2026-06-30', null, INVOICE, OWED)).toBe(-180);
    expect(daysPastDue('2026-10-27', '2026-12-11', null, INVOICE, OWED)).toBe(-45);
  });
});

describe('DR-31 — is_credit is driven by the document, never by the age', () => {
  it('THE TRAP: a DEBIT invoice due TODAY has days_past_due 0 and is NOT a credit', () => {
    // The as-of date IS the anchor, so the overdue figure is legitimately
    // zero. If `is_credit` were inferred from `days_past_due === 0`, this
    // ordinary invoice — money the customer owes, due today — would be
    // presented to the merchant as "a credit balance". It is the one case that
    // makes the two facts inseparable in a wrong implementation and separate
    // in a right one.
    const dueToday = daysPastDue('2026-08-31', '2026-08-01', '2026-08-31', INVOICE, OWED);
    expect(dueToday).toBe(0);
    expect(isCreditBearing(INVOICE, OWED)).toBe(false);
    // The same trap through the fallback: a termless invoice issued today.
    const issuedToday = daysPastDue('2026-08-31', '2026-08-31', null, INVOICE, OWED);
    expect(issuedToday).toBe(0);
    expect(isCreditBearing(INVOICE, OWED)).toBe(false);
    // And a zero age is not credit either.
    expect(ageDays('2026-08-31', '2026-08-31')).toBe(0);
  });

  it('is_credit cannot depend on an age — it takes no date, and its text names none', () => {
    // Structural, not by example: the decision function has no date parameter
    // and no date word in its body, so no age can reach it.
    expect(isCreditBearing.length).toBe(2);
    const source = isCreditBearing.toString();
    for (const forbidden of ['daysPastDue', 'days_past_due', 'ageDays', 'age_days', 'asOf', 'due', 'epochDay']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('credit_note');
    expect(/<\s*0n/.test(source)).toBe(true);
  });

  it('an unknown future DEBIT kind is NOT swept in as credit (the signed direction)', () => {
    // The kind arm is enumerated positively. A kind nobody has named yet —
    // say a debit note — keeps its overdue age rather than being silenced to
    // zero, because losing a debt is the failure DR-13/DR-21/DR-30 forbid and
    // mislabelling a credit is not.
    expect(isCreditBearing('debit_note', OWED)).toBe(false);
    expect(daysPastDue('2027-01-02', '2025-11-28', null, 'debit_note', OWED)).toBe(400);
    // And a credit BALANCE is still caught, whatever the kind is called: the
    // sign arm is kind-agnostic, which is what keeps the positive enumeration
    // from under-reporting credit.
    expect(isCreditBearing('debit_note', IN_CREDIT)).toBe(true);
    expect(daysPastDue('2027-01-02', '2025-11-28', null, 'debit_note', IN_CREDIT)).toBe(0);
  });

  it('a zero outstanding is not a credit, and never reaches this page anyway', () => {
    // `0n < 0n` is false, so a settled document is debit-shaped; and the page
    // filters `<> 0`, so it is not emitted at all. Both are stated because a
    // `<= 0` here would turn every settled invoice into a credit.
    expect(isCreditBearing(INVOICE, 0n)).toBe(false);
    expect(/<=\s*0n/.test(isCreditBearing.toString())).toBe(false);
  });

  it('the sign test holds beyond 2^53, so a large credit is still a credit', () => {
    // Outstanding figures are minor units in BIGINT, and the reader returns
    // them as text for exactly this reason. The decision is made on a bigint,
    // so no rounding can flip its sign.
    const huge = -(2n ** 53n + 1n);
    expect(isCreditBearing(INVOICE, huge)).toBe(true);
    expect(Number(huge) === Number(huge + 1n)).toBe(true); // a double cannot tell them apart
    expect(huge === huge + 1n).toBe(false); // a bigint can
    expect(daysPastDue('2027-01-02', '2025-11-28', null, INVOICE, huge)).toBe(0);
    expect(isCreditBearing(INVOICE, 2n ** 53n + 1n)).toBe(false);
  });
});

describe('DR-31 — the reader says all of this in live SQL', () => {
  it('there is ONE definition of credit-bearing, and it reads no date', () => {
    const code = liveCode(READER);
    expect(CREDIT_DEFINITION.test(code)).toBe(true);
    const definition = CREDIT_DEFINITION.exec(code)?.[0] ?? '';
    expect(definition).not.toMatch(/date|due|age/i);
  });

  it('that one definition is what BOTH the column and the CASE use — no second copy', () => {
    const code = liveCode(READER);
    expect(IS_CREDIT_COLUMN.test(code)).toBe(true);
    expect(CREDIT_ZERO.test(code)).toBe(true);
    // Both sites interpolate the constant, so they cannot drift: exactly two
    // interpolations, and no literal restatement of the predicate anywhere
    // else in the file.
    expect(code.match(/\$\{CREDIT_BEARING_SQL\}/g)?.length).toBe(2);
    const literalRestatements = code.match(/document_kind\s*=\s*'credit_note'/g) ?? [];
    expect(literalRestatements.length).toBe(1); // the definition itself, and nowhere else
  });

  it("age_days is emitted from the document's own date, with no coalesce in it", () => {
    const code = liveCode(READER);
    expect(AGE_DAYS.test(code)).toBe(true);
    // Not anchored on the term: there is no `coalesce` on the `age_days` line.
    const line = code.split('\n').find((l) => /AS\s+age_days/i.test(l)) ?? '';
    expect(line).not.toMatch(/coalesce/i);
    expect(line).not.toMatch(/due_date/i);
    expect(line).not.toMatch(/CASE/i);
  });

  it("a credit's overdue figure is a LITERAL zero — no subtraction, no clamp, no negation", () => {
    const code = liveCode(READER);
    expect(CREDIT_ZERO.test(code)).toBe(true);
    // A clamp would satisfy "never negative" while still computing an age and
    // hiding it; the literal cannot.
    expect(/THEN\s+greatest\s*\(/i.test(code)).toBe(false);
    expect(/THEN\s+abs\s*\(/i.test(code)).toBe(false);
    expect(/THEN\s+-/.test(code)).toBe(false);
    // And the DEBIT arm is the DR-28 expression, unchanged.
    expect(/ELSE\s*\(\s*\$3::date\s*-\s*coalesce\(\s*o\.due_date\s*,\s*o\.issue_date\s*\)\s*\)\s*END\s+AS\s+days_past_due/i.test(code)).toBe(true);
  });

  it('is_credit is not derived from the age, in the SQL either', () => {
    const code = liveCode(READER);
    // The `is_credit` column's own line mentions neither figure.
    const line = code.split('\n').find((l) => /AS\s+is_credit/i.test(l)) ?? '';
    expect(line).not.toMatch(/days_past_due|age_days/i);
    // And not through the age's EXPRESSION either, which is how the
    // derivation would actually be written: no as-of parameter, no date cast
    // and no anchor on that line at all. Without this, a mutation that spells
    // `CASE WHEN ($3::date - coalesce(...)) = 0 THEN true END AS is_credit`
    // would satisfy the name-level check above and pass.
    expect(line).not.toMatch(/\$3/);
    expect(line).not.toMatch(/::date/i);
    expect(line).not.toMatch(/coalesce/i);
    // The one definition is clean of the same three, so neither site can.
    const definition = CREDIT_DEFINITION.exec(code)?.[0] ?? '';
    expect(definition).not.toMatch(/\$3|::date|coalesce/i);
    // And nothing anywhere builds one from the other.
    expect(/is_credit[^\n]*days_past_due/i.test(code)).toBe(false);
    expect(/days_past_due\s*=\s*0/i.test(code)).toBe(false);
    expect(/age_days\s*=\s*0/i.test(code)).toBe(false);
  });

  it('these checks can SEE each form when it is wrong (positive controls)', () => {
    // A suite of absences proves nothing about itself.
    const derivedFromAge = 'CASE WHEN days_past_due = 0 THEN true ELSE false END AS is_credit';
    expect(IS_CREDIT_COLUMN.test(derivedFromAge)).toBe(false);
    expect(/days_past_due\s*=\s*0/i.test(derivedFromAge)).toBe(true);
    // The same derivation written with the age's EXPRESSION instead of its
    // name — the form a mutation would actually take — is caught by the three
    // bans on the `is_credit` line rather than by the name check.
    const derivedFromExpression = 'CASE WHEN ($3::date - coalesce(o.due_date, o.issue_date)) = 0 THEN true ELSE false END AS is_credit';
    expect(IS_CREDIT_COLUMN.test(derivedFromExpression)).toBe(false);
    expect(/days_past_due/i.test(derivedFromExpression)).toBe(false); // the name check alone would miss it
    expect(/\$3/.test(derivedFromExpression)).toBe(true);
    expect(/::date/i.test(derivedFromExpression)).toBe(true);
    expect(/coalesce/i.test(derivedFromExpression)).toBe(true);
    const sweptKind = "const CREDIT_BEARING_SQL = `(i.document_kind <> 'invoice' OR o.outstanding_txn_minor < 0)`;";
    expect(CREDIT_DEFINITION.test(sweptKind)).toBe(false);
    const termAnchoredAge = '($3::date - coalesce(o.due_date, o.issue_date)) AS age_days';
    expect(AGE_DAYS.test(termAnchoredAge)).toBe(false);
    const clampedCredit = 'CASE WHEN ${CREDIT_BEARING_SQL} THEN greatest(0, ($3::date - o.issue_date))';
    expect(CREDIT_ZERO.test(clampedCredit)).toBe(false);
  });

  it('no amount expression changed — DR-31 moves no money (conservation)', () => {
    const code = liveCode(READER);
    // The three money columns are the same passthrough they were before
    // DR-31: the decision changes what a DATE column reports, not what the
    // customer owes. The credit predicate READS the outstanding figure and
    // emits none of its own.
    expect(/i\.total_txn_minor::text\s+AS\s+total_txn_minor/.test(code)).toBe(true);
    expect(/o\.outstanding_txn_minor::text\s+AS\s+outstanding_txn_minor/.test(code)).toBe(true);
    expect(/o\.outstanding_base_minor::text\s+AS\s+outstanding_base_minor/.test(code)).toBe(true);
    // No new arithmetic on an amount, anywhere in the page query.
    expect(/outstanding_txn_minor\s*(?:\+|-|\*|\/)/.test(code)).toBe(false);
    // The page's eligibility filter is still the migration's, not the
    // reader's: nothing was added to or removed from what the page emits.
    expect(/customer_open_invoices_page\(\$1, \$2, NULL::date, \$4::uuid, \$5\)/.test(code)).toBe(true);
  });

  it('this page is the only reader that reports a per-document overdue age', () => {
    // DR-31 is a document-level rule. The aging reader answers in BANDS and
    // reports no per-document age at all, so there is no second place for the
    // rule to be stated inconsistently. Measured, because "every interface"
    // is only checkable if the set of interfaces is known.
    const code = liveCode(READER);
    expect(code.match(/AS\s+days_past_due/gi)?.length).toBe(1);
    expect(code.match(/AS\s+age_days/gi)?.length).toBe(1);
    expect(code.match(/AS\s+is_credit/gi)?.length).toBe(1);
  });

  it("the credit-note KIND is not representable on today's schema (a stated limit, not a claim)", () => {
    // So the kind arm is forward-looking and the sign arm is what is live.
    // This is asserted rather than remarked, so the day P4-S5 lifts the CHECK
    // this test fails and the limit is revisited deliberately.
    const schema = readFileSync(SELLING_CORE_MIGRATION, 'utf8');
    expect(/invoices_document_kind_ck\s+CHECK\s*\(\s*document_kind\s*=\s*'invoice'\s*\)/i.test(schema)).toBe(true);
    // And the read surface types the column for both kinds regardless, which
    // is why the rule is written now.
    expect(/document_kind:\s*'invoice'\s*\|\s*'credit_note'/.test(liveCode(READER))).toBe(true);
  });
});

describe('DR-31 — the contract carries both facts, and neither can be null', () => {
  const creditNote: CustomerOpenInvoiceDto = {
    invoiceId: '44444444-4444-4444-8444-444444444444',
    documentKind: 'credit_note',
    documentNumber: 'CN-2026-000001',
    issueDate: '2025-11-28',
    dueDate: null,
    currency: 'JOD',
    totalTxnMinor: '2500',
    outstandingTxnMinor: '-2500',
    outstandingBaseMinor: '-2113',
    settlementState: 'unpaid',
    daysPastDue: 0,
    hasExplicitDueDate: false,
    ageDays: 400,
    isCredit: true,
  };

  const overpaidInvoice: CustomerOpenInvoiceDto = {
    ...creditNote,
    invoiceId: '55555555-5555-4555-8555-555555555555',
    documentKind: 'invoice',
    documentNumber: 'INV-2026-000009',
    dueDate: '2025-12-28',
    hasExplicitDueDate: true,
    // A credit balance on a debit document: zero overdue age, 400 days old.
    daysPastDue: 0,
    isCredit: true,
  };

  const dueToday: CustomerOpenInvoiceDto = {
    ...creditNote,
    invoiceId: '66666666-6666-4666-8666-666666666666',
    documentKind: 'invoice',
    documentNumber: 'INV-2026-000010',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    outstandingTxnMinor: '60000',
    outstandingBaseMinor: '60000',
    hasExplicitDueDate: true,
    daysPastDue: 0, // read on 2026-08-31: due today
    ageDays: 30,
    isCredit: false,
  };

  it('a credit note states a zero overdue age, a real document age, and is_credit', () => {
    expect(creditNote.daysPastDue).toBe(0);
    expect(creditNote.isCredit).toBe(true);
    expect(creditNote.ageDays).toBe(ageDays('2027-01-02', creditNote.issueDate));
    expect(creditNote.ageDays).toBe(400);
  });

  it('an overpaid invoice is a credit by SIGN while its kind stays `invoice`', () => {
    expect(overpaidInvoice.documentKind).toBe('invoice');
    expect(BigInt(overpaidInvoice.outstandingTxnMinor) < 0n).toBe(true);
    expect(overpaidInvoice.isCredit).toBe(true);
    expect(overpaidInvoice.daysPastDue).toBe(0);
    expect(overpaidInvoice.ageDays).toBe(400);
  });

  it('a debit invoice due TODAY has the same zero overdue age and is NOT a credit', () => {
    expect(dueToday.daysPastDue).toBe(0);
    expect(dueToday.isCredit).toBe(false);
    expect(BigInt(dueToday.outstandingTxnMinor) > 0n).toBe(true);
    // Same `daysPastDue`, opposite `isCredit`: the field is not a function of
    // the figure, in the contract's own data.
    expect(dueToday.daysPastDue).toBe(creditNote.daysPastDue);
    expect(dueToday.isCredit).not.toBe(creditNote.isCredit);
  });

  it('is_credit agrees with the document itself on every row, and is its own field', () => {
    for (const row of [creditNote, overpaidInvoice, dueToday]) {
      expect(row.isCredit).toBe(isCreditBearing(row.documentKind, BigInt(row.outstandingTxnMinor)));
      expect(typeof row.ageDays).toBe('number');
      expect(typeof row.daysPastDue).toBe('number');
      if (row.isCredit) expect(row.daysPastDue).toBe(0);
    }
    const keys = Object.keys(dueToday);
    for (const k of ['ageDays', 'isCredit', 'daysPastDue', 'hasExplicitDueDate', 'dueDate']) {
      expect(keys).toContain(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('`ageDays: null` does not typecheck — the forbidden value is unrepresentable', () => {
    // @ts-expect-error DR-31: every document has an age, so the field is
    // `number`, not `number | null`. If this compiles, the ban has been
    // lifted and this assertion fails with TS2578.
    const illegal: CustomerOpenInvoiceDto = { ...dueToday, ageDays: null };
    expect(illegal).toBeTruthy();
  });

  it('`isCredit: null` does not typecheck either', () => {
    // @ts-expect-error DR-31: `is_credit` is a boolean for every row; a
    // nullable flag would let a client read "unknown" as "not a credit".
    const illegal: CustomerOpenInvoiceDto = { ...dueToday, isCredit: null };
    expect(illegal).toBeTruthy();
  });
});

/**
 * ── DR-35: THE WORDING IS PART OF THE DECISION, SO THE BUILD HOLDS IT ──────
 *
 * DR-31 was implemented before DR-35 settled how a credit row reads, and the
 * contract comment, the reader's comment, this file's own header and the
 * decisions record all went on prescribing the superseded form. Nothing
 * failed, because a prescription written in prose is enforced by whoever
 * happens to reread it. That is the gap these cases close.
 *
 * The approved form names the INVOICE, because `ageDays` measures the
 * DOCUMENT's age and not the credit's: for an overpaid invoice the credit
 * arose on the day of the overpayment, which is later than the invoice's own
 * date, so the superseded form OVERSTATES the credit's age by construction.
 * The forbidden form is therefore not a style preference; it is a claim the
 * number does not support.
 *
 * ── WHY A SENTINEL AND NOT A PROXIMITY WINDOW ──────────────────────────────
 *
 * A ban has to be writable, so the forbidden strings cannot simply be absent.
 * The first form of this law allowed an occurrence that sat within three lines
 * of a banning word, and it was MEASURED to launder two of the five sites in
 * this very tree: the contract's prescription stood two lines from a `never`
 * that banned something else entirely, so the window swallowed it. A marker
 * that need only be NEARBY is satisfied by coincidence.
 *
 * So the law is a sentinel on the occurrence's OWN LINE. It cannot be met by
 * accident, it cannot be met by a neighbour, and writing a ban costs one
 * deliberate token.
 *
 * ── AND A SECOND HALF, BECAUSE A LINE LAW MISSES A WRAPPED PHRASE ──────────
 *
 * The line law was MEASURED to miss two sites of this tree where the phrase
 * had wrapped across a comment break, which is the ordinary fate of any
 * sentence in a wrapped comment. So each file is also read with its comment
 * leaders and line breaks collapsed, and in that reading the phrase may appear
 * only in a file that states the ban at all.
 *
 * STATED LIMIT, not a claim of completeness: a file that both states the ban
 * and wraps a prescription across a line break passes both halves. Two files
 * in the tree state the ban — the decisions record and this one — so the hole
 * is two files wide and it is written down here rather than discovered later.
 * Closing it needs a parser, which this law is not.
 */
describe('DR-35 the approved wording, enforced by the build rather than by memory', () => {
  const REQUIRED_AR = 'رصيد دائن على فاتورة عمرها X يومًا';
  const REQUIRED_EN = 'a credit balance on an invoice X days old';
  const FORBIDDEN = ['رصيد دائن منذ X يومًا', 'a credit balance for X days'] as const; // DR-35-FORBIDDEN-FORM
  /** The one token that makes an occurrence lawful, and only on its own line. */
  const SENTINEL = ['DR', '35', 'FORBIDDEN', 'FORM'].join('-');

  const ROOT = join(__dirname, '..', '..', '..');
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'graphify-out', '.next', '.turbo', 'release']);
  const TEXT_EXT = ['.ts', '.tsx', '.js', '.jsx', '.md', '.sql', '.json', '.kt', '.yml', '.yaml', '.html', '.txt'];

  /** Every text file of the tree, so a prescription cannot hide in a corner nobody listed. */
  function textFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) textFiles(join(dir, e.name), out);
      } else if (TEXT_EXT.some((x) => e.name.endsWith(x))) {
        out.push(join(dir, e.name));
      }
    }
    return out;
  }

  /** An occurrence is lawful only if its OWN line carries the sentinel. */
  function unlawfulOccurrences(text: string): string[] {
    return text
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => FORBIDDEN.some((f) => line.includes(f)) && !line.includes(SENTINEL))
      .map(({ line, n }) => `${n}: ${line.trim()}`);
  }

  /**
   * The same text with comment leaders and line breaks collapsed, so a phrase
   * that wrapped is read as the phrase it is.
   */
  function flattened(text: string): string {
    const LEADER = /^[ \t]*(?:[*]+|[/]{2,}|#+)?[ \t]*/;
    return text
      .split('\n')
      .map((line) => line.replace(LEADER, ''))
      .join(' ');
  }

  it('dr35_1: the approved form is the one the contract and the reader prescribe', () => {
    const contract = readFileSync(join(ROOT, 'packages', 'shared-contracts', 'src', 'customers.ts'), 'utf8');
    const reader = readFileSync(join(ROOT, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts'), 'utf8');
    expect(contract, 'the contract must prescribe the Arabic form DR-35 approved').toContain(REQUIRED_AR);
    expect(contract, 'and its English counterpart').toContain(REQUIRED_EN);
    expect(reader, 'the reader comment prescribes the same form, so the two cannot drift').toContain(REQUIRED_EN);
  });

  it('dr35_2: nowhere in the tree does the forbidden form stand on a line that is not banning it', () => {
    const offenders: string[] = [];
    for (const file of textFiles(ROOT)) {
      const bad = unlawfulOccurrences(readFileSync(file, 'utf8'));
      if (bad.length > 0) offenders.push(`${file.slice(ROOT.length + 1)}\n    ${bad.join('\n    ')}`);
    }
    expect(
      offenders,
      `DR-35 forbids these forms in any language. Each line below carries one without the sentinel that marks a ban:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('dr35_2b: nor does it appear WRAPPED across a comment break in a file that never states the ban', () => {
    const offenders: string[] = [];
    for (const file of textFiles(ROOT)) {
      const raw = readFileSync(file, 'utf8');
      if (raw.includes(SENTINEL)) continue;
      const hits = FORBIDDEN.filter((f) => flattened(raw).includes(f));
      if (hits.length > 0) offenders.push(`${file.slice(ROOT.length + 1)} :: ${hits.join(' | ')}`);
    }
    expect(offenders, `a wrapped prescription is still a prescription:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('dr35_3: THE POSITIVE CONTROL — the same predicates reject a prescription, so neither case above is vacuous', () => {
    const prescription = ' * An interface renders such a row as "a credit balance for X days".'; // DR-35-FORBIDDEN-FORM
    expect(unlawfulOccurrences(prescription), 'a prescription with no sentinel must be caught').toHaveLength(1);

    expect(unlawfulOccurrences(`${prescription} // ${SENTINEL}`), 'and a ban must be writable, or the law could not be stated').toEqual([]);

    const laundered = ['**never** as "overdue"', '', prescription].join('\n');
    expect(
      unlawfulOccurrences(laundered),
      'the case the proximity window passed and this law must not: a banning word two lines away bans something else',
    ).toHaveLength(1);

    // AND THE WRAPPED CASE, which the line law alone was MEASURED to miss.
    const wrapped = ['   * - the figure a client renders for a credit as "a credit balance for', '   *   X days".'].join('\n'); // DR-35-FORBIDDEN-FORM
    expect(unlawfulOccurrences(wrapped), 'the line law cannot see a wrapped phrase — this is exactly why dr35_2b exists').toEqual([]);
    expect(flattened(wrapped), 'and flattening restores the phrase, so dr35_2b does see it').toContain(FORBIDDEN[1]);
  });
});
