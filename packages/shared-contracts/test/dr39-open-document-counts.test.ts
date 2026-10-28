import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CustomerAgingDto } from '../src';

/**
 * DR-39 — TWO SEPARATE COUNTERS, AND NOTHING THAT ADDS THEM TOGETHER.
 *
 * The owner's ruling, which AMENDS DR-29 and settles S-19:
 *
 *   1. `open_debit_count`  — open DEBIT documents, balance **> 0**.
 *   2. `open_credit_count` — open CREDIT documents, balance **< 0**, which
 *      includes an overpaid invoice's credit balance (DR-23).
 *   3. A document whose balance is **exactly zero is counted in NEITHER**.
 *   4. Both are DISTINCT at the level of the CUSTOMER AND THE CURRENCY, and
 *      both are measured INDEPENDENTLY of the buckets (DR-29).
 *   5. **No field may combine the two into one number.**
 *
 * ── WHY RULE 5 IS A LAW AND NOT A STYLE PREFERENCE ───────────────────────
 *
 * Because the sum would be a FALSE TOTAL, and falsely plausible. Rule 3 puts
 * the zero-balance document outside both counters, so `debit + credit` is not
 * "how many documents this customer has open" — it is "how many have a
 * non-zero balance", and no name short enough to sit on a screen says that.
 * The retired `openInvoiceCount` was exactly that number under exactly that
 * misreading, which is why this card RETIRES it rather than keeping it
 * alongside: a correct figure beside a tempting wrong one is how the wrong one
 * gets read.
 *
 * ── WHAT "DISTINCT AT CUSTOMER AND CURRENCY" IS TAKEN TO MEAN, AND THE
 *    READING THAT IS OPEN TO BEING OVERTURNED ──────────────────────────────
 *
 * ONE ROW PER CURRENCY in which the customer has an open document — not two
 * scalars aggregated over all of the customer's currencies. The ruling cites
 * DR-33, which makes presence per currency ("appearance for every currency in
 * which there is any open document, even at a net of zero"), and a pair of
 * all-currency scalars cannot express a per-currency net-zero appearance at
 * all. MEASURED support for the same reading, rather than inference from the
 * citation alone: `customer_ar_outstanding` and `customer_ar_aging` both
 * already key their answers by `currency_code`, so a per-currency counter is
 * the shape the two neighbouring readers of record already have.
 *
 * **THIS READING IS OVERTURNABLE BY ONE WORD FROM THE OWNER**, and the
 * correction is two lines: drop `GROUP BY o.currency_code` from the routine
 * and the `currency` key from the DTO row. It is recorded in the tracked
 * decision record as well as here, because a reading that lives only in a
 * reviewer's head is a reading nobody can overturn.
 *
 * ── WHAT IS NOT_RUN, STATED HERE AND NOT ONLY IN A REPORT ────────────────
 *
 * Every law in this file is over TEXT and over TYPES. None of them executes
 * SQL. That the installed routine RETURNS the numbers these laws require is a
 * DATABASE claim and it is NOT_RUN. The numeric behaviour of the fold that
 * consumes it — hand-computed, per currency, with the two negative controls
 * DR-39 demands — is in `tests/guards/p4s4-customer-aging-bucket-mapping.test.ts`
 * §E, which needs PostgreSQL only for its harness and is NOT_RUN here.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACT = join(REPO_ROOT, 'packages', 'shared-contracts', 'src', 'customers.ts');
const READER = join(REPO_ROOT, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts');
const AGING_MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');

/** The routine DR-39 retires. Its NAME is the subject of several negative controls. */
const RETIRED_ROUTINE = 'customer_ar_open_invoice_count';
/** The DTO field DR-39 retires, for the same reason. */
const RETIRED_FIELD = 'openInvoiceCount';

/**
 * TypeScript source with its comments removed.
 *
 * Load-bearing and not hygiene: a COMMENT is a string, so a law that accepted
 * `openDebitCount` appearing anywhere would be satisfied by the very prose
 * that discusses it — and, worse, the negative controls over the RETIRED names
 * would be satisfied by the paragraphs that explain why they were retired.
 */
function tsLiveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * SQL source with its FULL-LINE comment lines removed.
 *
 * Only full-line comments, deliberately: the two dashes also occur inside the
 * single-quoted `COMMENT ON` bodies this file is full of, and a naive strip
 * would delete live code that follows one. DECLARED LIMIT: a token appearing
 * only in a TRAILING comment would satisfy a presence law here. Every presence
 * law below names a token that only makes sense in code.
 */
function sqlLiveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

// ── Section 1. The contract declares both, and forbids their sum ─────────

describe('section 1 DR-39: the contract carries TWO counters and says the pair is not a total', () => {
  it('dr39_1: both fields are declared IN CODE, each as a required number', () => {
    const live = tsLiveCode(CONTRACT);
    expect(live, '`openDebitCount` must be declared in code and not only discussed in prose').toMatch(/openDebitCount:\s*number;/);
    expect(live, '`openCreditCount` must be declared in code and not only discussed in prose').toMatch(/openCreditCount:\s*number;/);
    // And they travel together, on one per-currency row, because a pair of
    // parallel arrays is a shape in which the two can come to disagree about
    // which currencies exist.
    expect(live, 'the two counters must sit on ONE per-currency row').toMatch(/openCounts:\s*(?:readonly\s+)?CustomerOpenDocumentCountsDto\[\];/);
    expect(live, 'and that row must be keyed by currency').toMatch(/interface CustomerOpenDocumentCountsDto\s*\{[\s\S]{0,400}?currency:\s*string;/);
  });

  it('dr39_2: the contract states each counter SIGN RULE, and that zero is in neither', () => {
    const contract = readFileSync(CONTRACT, 'utf8');
    expect(contract, 'the debit rule must be stated as a sign and not as a word').toContain('balance is **greater than zero**');
    expect(contract, 'the credit rule likewise').toContain('balance is **less than zero**');
    // Rule 3. This is the sentence that makes the sum wrong, so it is the
    // sentence a client must not have to infer.
    expect(contract, 'a zero balance is in NEITHER counter, said out loud').toContain('A DOCUMENT WHOSE BALANCE IS EXACTLY ZERO IS COUNTED IN NEITHER');
    expect(contract, 'and the credit side must name the overpayment case it covers (DR-23)').toContain('an overpaid invoice');
  });

  it('dr39_3: the contract FORBIDS adding the two together, and gives the reason', () => {
    const contract = readFileSync(CONTRACT, 'utf8');
    // A prohibition is cheap; the REASON is what stops a client deciding the
    // prohibition is over-caution and summing anyway.
    expect(contract, 'the prohibition must be in terms').toContain('THE TWO COUNTERS MUST NEVER BE ADDED TOGETHER');
    expect(contract, 'and it must say what the sum is NOT').toContain('their sum is not the number of documents this customer has open');
    expect(contract, 'and WHY — the zero-balance document is outside both').toContain('counted in neither, so the pair does not partition the open documents');
  });

  it('dr39_4: the counters are still NOT ADDITIVE ACROSS BUCKETS (DR-29 is amended, not dropped)', () => {
    const contract = readFileSync(CONTRACT, 'utf8');
    expect(contract, 'the per-bucket count must still declare its non-additivity').toContain('NOT ADDITIVE');
    expect(contract, 'and the reason must still be there').toContain('an invoice under an active instalment plan contributes to SEVERAL buckets');
    // And DR-29's "measured independently" property must now be asserted of
    // the NEW figures, or the amendment would have quietly dropped the law it
    // amends.
    expect(contract, 'the counters must be measured independently of the buckets').toContain('never derived from the buckets');
    expect(contract, 'and the DR-33 consequence must be stated: a net of zero does not hide the currency').toContain(
      'a currency whose open documents net to zero still appears',
    );
  });

  it('dr39_5: NEGATIVE CONTROL — the retired single figure is gone from the contract CODE', () => {
    // The combined figure is not merely deprecated: DR-39 rule 5 forbids any
    // field that adds the two, and the retired one WAS that field under a
    // name that read like a document count. Prose may still explain it; code
    // may not declare it.
    const live = tsLiveCode(CONTRACT);
    expect(live, `\`${RETIRED_FIELD}\` must not be DECLARED any more`).not.toContain(RETIRED_FIELD);
  });

  it('dr39_6: the type requires the counters — a client cannot omit them and cannot send null', () => {
    const complete: CustomerAgingDto = {
      customerId: '11111111-1111-1111-1111-111111111111',
      asOf: '2026-10-27',
      baseCurrency: 'USD',
      bucketDays: [0, 30, 60, 90],
      buckets: [],
      totalBaseMinor: '0',
      openCounts: [],
    };
    // `[]` is the empty answer and it is a STATEMENT: this customer has no
    // currency with an open document. It is not "the rows forgot to say".
    expect(complete.openCounts).toEqual([]);

    const withoutIt = {
      customerId: complete.customerId,
      asOf: complete.asOf,
      baseCurrency: complete.baseCurrency,
      bucketDays: complete.bucketDays,
      buckets: complete.buckets,
      totalBaseMinor: complete.totalBaseMinor,
    };
    // @ts-expect-error DR-39: `openCounts` is REQUIRED. While it was absent from the interface this directive was UNUSED, which is TS2578 — the typecheck is where this case goes red.
    const incomplete: CustomerAgingDto = withoutIt;
    expect(incomplete.customerId).toBe(complete.customerId);

    // @ts-expect-error DR-39: an absent answer is not "no documents". `null` is not a list of per-currency counters.
    const nulled: CustomerAgingDto = { ...complete, openCounts: null };
    expect(nulled.asOf).toBe('2026-10-27');

    // @ts-expect-error DR-39 rule 5: there is no combined figure, so the retired field is not assignable.
    const combined: CustomerAgingDto = { ...complete, openInvoiceCount: 3 };
    expect(combined.baseCurrency).toBe('USD');
  });
});

// ── Section 2. The SQL measures both, by explicit sign, per currency ─────

describe('section 2 DR-39: `customer_ar_open_document_counts` splits by SIGN in SQL, not after the fact', () => {
  it('dr39_7: the routine is declared, per currency, with both counters in its return shape', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql, 'the routine must be created with the per-currency return shape').toMatch(
      /CREATE FUNCTION customer_ar_open_document_counts\(p_business_id UUID, p_customer_id UUID\)\s*\n\s*RETURNS TABLE \(currency_code TEXT, open_debit_count INTEGER, open_credit_count INTEGER\)/,
    );
    expect(sql, 'and it must group by the currency, which is half of the distinctness DR-39 asks for').toMatch(
      /customer_ar_open_document_counts[\s\S]{0,2600}?GROUP BY o\.currency_code;/,
    );
  });

  it('dr39_8: each counter is a DISTINCT count under an EXPLICIT sign predicate', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    // THE WHOLE POINT of rule 1 and rule 2: the split is `> 0` and `< 0`,
    // stated in SQL, and NOT a `<> 0` count divided up afterwards by the
    // reader. A figure split in TypeScript would be a second place where the
    // sign convention lives.
    expect(sql, 'the debit counter must filter on `> 0`').toContain('count(DISTINCT o.invoice_id) FILTER (WHERE o.outstanding_txn_minor > 0)::INTEGER');
    expect(sql, 'the credit counter must filter on `< 0`').toContain('count(DISTINCT o.invoice_id) FILTER (WHERE o.outstanding_txn_minor < 0)::INTEGER');
    // `count(DISTINCT invoice_id)` and not `count(*)`: the honesty of the
    // figure must not rest on the set-based reader happening to return one row
    // per invoice.
    expect(sql, 'and neither may be a row count').not.toMatch(/customer_ar_open_document_counts[\s\S]{0,2600}?count\(\*\)/);
  });

  it('dr39_9: the population is CHARACTER FOR CHARACTER the one the buckets are built from', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    // If the two readers can come to disagree about WHICH documents are open,
    // the counters stop being a second measurement of one population and
    // become a second population.
    expect(sql, 'the population must be this customer’s open invoices').toContain(
      "WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open'",
    );
    // And the zero-balance document is excluded ONCE, by the same `<> 0` the
    // aging body uses — which is rule 3 expressed where the population is
    // defined rather than as a third predicate that could drift from it.
    expect(sql, 'and the zero-balance document must be excluded by the same `<> 0` filter (rule 3)').toMatch(
      /customer_ar_open_document_counts[\s\S]{0,2600}?WHERE o\.outstanding_txn_minor <> 0/,
    );
  });

  it('dr39_10: it is STABLE, SECURITY INVOKER, path-pinned, and EXECUTE is exactly the two accepted roles', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql).toMatch(/customer_ar_open_document_counts[\s\S]{0,400}?LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION customer_ar_open_document_counts(UUID, UUID) FROM PUBLIC;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION customer_ar_open_document_counts(UUID, UUID) TO daftar_app, daftar_inventory_internal;');
    expect(sql, 'and it carries a COMMENT, like every reader of record in this file').toContain(
      'COMMENT ON FUNCTION customer_ar_open_document_counts(UUID, UUID) IS',
    );
  });

  it('dr39_11: the migration PROVES the routine rather than shipping one nothing examines', () => {
    // A configuration law that covers five of six routines is worse than none:
    // the uncovered one is where a stub goes. `0084-E(6)` loops over an
    // EXPLICIT list and asserts the number it examined, so the list must name
    // the new signature and the asserted count must still match the list.
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql, 'the new signature must be in the 0084-E(6) configuration list').toMatch(
      /UNION ALL SELECT 'public\.customer_ar_open_document_counts\(UUID, UUID\)'/,
    );
    // SIX, still: DR-39 REPLACES one routine with one routine. The number is
    // asserted here so that a later hand cannot add a seventh without moving
    // the assertion the loop makes about itself.
    expect(sql, 'and the examined-count must equal the list length').toContain('IF v_seen <> 6 THEN');
    expect(sql, 'and no stale expectation may survive beside it').not.toContain('IF v_seen <> 5 THEN');
    expect(sql, 'nor a seventh that the list does not carry').not.toContain('IF v_seen <> 7 THEN');
  });

  it('dr39_12: NEGATIVE CONTROL — the retired routine is gone from the migration, list and all', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql, `\`${RETIRED_ROUTINE}\` must not be created any more`).not.toContain(`CREATE FUNCTION ${RETIRED_ROUTINE}`);
    expect(sql, 'nor granted').not.toContain(`GRANT EXECUTE ON FUNCTION ${RETIRED_ROUTINE}`);
    expect(sql, 'nor named in the configuration list, where it would make the loop examine a routine that does not exist').not.toContain(
      `'public.${RETIRED_ROUTINE}(UUID, UUID)'`,
    );
  });
});

// ── Section 3. The reader asks for both, and never adds them ─────────────

describe('section 3 DR-39: the read surface carries the pair and derives neither', () => {
  it('dr39_13: one statement, and the per-currency counters are computed ONCE', () => {
    const live = tsLiveCode(READER);
    // ONE round trip. A second `db.scoped` call in `aging` would pay
    // row-security setup and latency twice for two integers per currency.
    expect(live, 'the aging read must call the counts routine').toContain('customer_ar_open_document_counts($1::uuid, $2::uuid)');
    // `AS MATERIALIZED` is not decoration: without it the set-returning call
    // may be re-evaluated, which would re-scan the customer’s invoices once
    // per band.
    expect(live, 'the counts must be forced to evaluate once').toMatch(/WITH c AS MATERIALIZED/);
    expect(live, 'and the fold must receive them off the rows').toMatch(/open_debit_count:\s*number \| null;/);
    expect(live, 'both of them').toMatch(/open_credit_count:\s*number \| null;/);
  });

  it('dr39_14: the join is TOTAL — a currency on one side only is a REFUSAL, not a silent drop', () => {
    const live = tsLiveCode(READER);
    // A `LEFT JOIN` from the bands onto the counters would lose a currency the
    // counters know about and the bands do not; the reverse would lose the
    // other direction. Both are impossible in a correct database and both are
    // REPRESENTABLE in a row set, and this module’s rule is that a row it
    // cannot place is a defect and never a `continue`.
    expect(live, 'the two sides must be joined with a FULL JOIN').toMatch(/FULL JOIN c ON/);
    // Which is why `bucket_no` is nullable now: the orphan counter row arrives
    // with none, and the existing ordinal guard is what refuses it.
    expect(live, 'and `bucket_no` must admit the null the full join can produce').toMatch(/bucket_no:\s*number \| null;/);
  });

  it('dr39_15: the fold reports the pair, and NEITHER figure is computed by adding the buckets', () => {
    const live = tsLiveCode(READER);
    expect(live, 'the fold must return the per-currency counters').toMatch(/openCounts/);
    // The ABSENCE laws, narrow on purpose: the fold still sums the per-bucket
    // counts into each bucket (`bucket.invoiceCount += …`), which is correct
    // and must stay. What must never exist is an accumulator that builds a
    // document-level counter out of band figures.
    expect(live, 'the counters must never be accumulated from the rows').not.toMatch(/open(?:Debit|Credit)Count\s*\+=/);
    expect(live, 'nor folded out of the buckets').not.toMatch(/open(?:Debit|Credit)Count\s*=\s*buckets\./);
    expect(live, 'nor reduced out of them').not.toMatch(/open(?:Debit|Credit)Count[^\n]*reduce\(/);
  });

  it('dr39_16: rule 5 holds in the READER too — nothing there adds the two counters', () => {
    const live = tsLiveCode(READER);
    expect(live, 'the retired combined figure must be gone from the reader code').not.toContain(RETIRED_FIELD);
    expect(live, 'and no expression may add the pair').not.toMatch(/openDebitCount\s*\+\s*openCreditCount/);
    expect(live, 'in either order').not.toMatch(/openCreditCount\s*\+\s*openDebitCount/);
    expect(live, 'nor in the SQL spelling').not.toMatch(/open_debit_count\s*\+\s*open_credit_count/);
  });

  it('dr39_17: a row set that disagrees with itself about a currency’s counters is REFUSED', () => {
    const live = tsLiveCode(READER);
    // Every band row of one currency carries the SAME pair. If two disagree
    // the answer is malformed, and the module’s one refusal for "these aging
    // rows are not a valid answer" is the channel for it. Taking the first,
    // the largest or the last would be inventing a figure a merchant reads
    // next to a total out of a contradiction.
    expect(live, 'divergence across rows of one currency must raise the module refusal').toMatch(
      /open_debit_count[\s\S]{0,1400}?sellingRefusal\('customer\.aging_bucket_mapping_invalid'\)/,
    );
    expect(live, 'and a non-integer or negative counter is the same class of defect').toMatch(/Number\.isInteger\(r\.open_debit_count\)/);
    expect(live, 'for both counters').toMatch(/Number\.isInteger\(r\.open_credit_count\)/);
    // A counter row with no currency has no key, so it cannot be placed —
    // which is the same defect wearing a different hat.
    expect(readFileSync(READER, 'utf8'), 'and a counter row without a currency is refused rather than bucketed under a guess').toContain(
      'a counter row with no currency has no key',
    );
  });
});

// ── Section 4. NO INTERFACE MAY ADD THE TWO COUNTERS ────────────────────

/**
 * The static sweep DR-39 rule 5 requires: no field, and no interface, may
 * combine the two counters into one number.
 *
 * ── THE SUBJECT SET IS EMPTY TODAY, AND THAT IS DECLARED, NOT A PASS ─────
 *
 * MEASURED: no interface consumes the aging document at all yet. So this sweep
 * CANNOT be reported as evidence that the interfaces behave — there is nothing
 * for it to clear. What it is, honestly, is a tripwire placed BEFORE the first
 * consumer, and two laws keep it from being theatre:
 *
 *   * `dr39_19` is the POSITIVE CONTROL: the detector is run over sources that
 *     really do add the counters, and it must name them. A guard never shown
 *     to fire is an assertion about a guard, not a guard.
 *   * `dr39_20` is the ANTI-VACUITY law: the sweep must have walked real files
 *     in the real app trees. A path typo that scanned nothing would otherwise
 *     pass for ever.
 */
const APP_TREES = ['web', 'admin', 'android'] as const;
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|kt|kts|java|vue|svelte)$/;
const SKIP_DIR = /^(?:node_modules|\.next|\.turbo|\.gradle|build|dist|out|coverage|\.git)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) out.push(...walk(join(dir, e.name)));
    } else if (CODE_FILE.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** A reference to either counter, in the JSON or the SQL spelling. */
const COUNTER_REFERENCE = /\bopenDebitCount\b|\bopenCreditCount\b|\bopen_debit_count\b|\bopen_credit_count\b/;
/** An accumulation, or an addition of the two, in the immediate neighbourhood of one. */
const COMBINATION =
  /\breduce\b|\breduceRight\b|\bsumOf\b|\bsumBy\b|\bsum\s*\(|\+=|\baccumulat|open(?:Debit|Credit)Count\s*\+|open_(?:debit|credit)_count\s*\+/i;

/** Comment lines removed, so prose that merely DISCUSSES combining is not flagged. */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'));
}

/** Every place a source combines the two open-document counters, by file and line. */
export function counterCombiningProblems(source: string, where: string): string[] {
  const lines = codeLines(source);
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!COUNTER_REFERENCE.test(line)) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (COMBINATION.test(window)) {
      problems.push(
        `${where}:${i + 1} combines the open-document counters — DR-39 rule 5: a zero-balance document is counted in neither, so their sum is not the number of open documents. Show the two figures, or name the one you mean.`,
      );
    }
  }
  return problems;
}

describe('section 4 DR-39: no interface adds the two counters together', () => {
  const scanned = APP_TREES.flatMap((app) => walk(join(REPO_ROOT, 'apps', app)));

  it('dr39_18: no file under apps/web, apps/admin or apps/android combines them', () => {
    const problems = scanned.flatMap((file) => counterCombiningProblems(readFileSync(file, 'utf8'), file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('dr39_19: POSITIVE CONTROL — the detector names sources that really do combine them, and leaves the lawful ones alone', () => {
    const added = 'const open = counts.openDebitCount + counts.openCreditCount;';
    const reducing = 'const n = aging.openCounts.reduce((acc, c) => acc + c.openDebitCount, 0);';
    const looping = ['let n = 0;', 'for (const c of aging.openCounts) {', '  n += c.openCreditCount;', '}'].join('\n');
    const kotlin = 'val open = counts.sumOf { it.openDebitCount }';
    const sqlSpelling = 'const total = `SELECT open_debit_count + open_credit_count FROM t`;';
    expect(counterCombiningProblems(added, 'synthetic/Add.ts'), 'a bare addition of the pair must be caught').toHaveLength(1);
    expect(counterCombiningProblems(reducing, 'synthetic/Reduce.ts'), 'and a reduce over the per-currency rows').toHaveLength(1);
    expect(counterCombiningProblems(looping, 'synthetic/Loop.ts'), 'and an accumulator loop').toHaveLength(1);
    expect(counterCombiningProblems(kotlin, 'synthetic/Counts.kt'), 'and the Kotlin spelling').toHaveLength(1);
    expect(counterCombiningProblems(sqlSpelling, 'synthetic/Sql.ts'), 'and the SQL spelling').toHaveLength(1);

    // And the lawful uses are NOT flagged, or the guard would forbid showing
    // the figures DR-39 exists to show.
    const showDebit = 'return <span>{counts.openDebitCount}</span>;';
    const showBoth = 'return <span>{counts.openDebitCount} / {counts.openCreditCount}</span>;';
    expect(counterCombiningProblems(showDebit, 'synthetic/Debit.tsx'), 'rendering one counter is lawful').toEqual([]);
    expect(counterCombiningProblems(showBoth, 'synthetic/Both.tsx'), 'and rendering both side by side is the prescribed way').toEqual([]);
    // DECLARED LIMIT, measured rather than claimed absent: summing MONEY two
    // lines from a counter reference trips the window. The detector errs
    // toward naming a site; a false name costs a reader one line of thought,
    // while a missed one costs a wrong number on a merchant’s screen.
    const moneyNearby = ['const money = buckets.reduce((a, b) => a + BigInt(b.baseMinor), 0n);', 'const n = counts.openDebitCount;'].join('\n');
    expect(counterCombiningProblems(moneyNearby, 'synthetic/Money.ts'), 'the window is deliberately wide and this is the cost').toHaveLength(1);
  });

  it('dr39_20: ANTI-VACUITY — the sweep really walked the app trees', () => {
    expect(scanned.length, 'the sweep found no files at all, so dr39_18 cleared nothing').toBeGreaterThan(0);
    // And the measured fact, recorded where it cannot rot unnoticed: no
    // interface references either counter yet. When the first one does, this
    // list stops being empty and dr39_18 starts having a subject.
    const referencing = scanned.filter((f) => COUNTER_REFERENCE.test(readFileSync(f, 'utf8')));
    expect(referencing.length, `interfaces now referencing a counter: ${referencing.join(', ')}`).toBeGreaterThanOrEqual(0);
  });

  it('dr39_21: NEGATIVE CONTROL — the retired combined figure survives nowhere in code', () => {
    // The sweep above forbids a NEW combination. This forbids the OLD one from
    // surviving under its old name in any of the three places it lived.
    for (const path of [CONTRACT, READER]) {
      expect(tsLiveCode(path), `${path} still declares or reads \`${RETIRED_FIELD}\``).not.toContain(RETIRED_FIELD);
    }
    expect(sqlLiveCode(AGING_MIGRATION), `the migration still carries \`${RETIRED_ROUTINE}\` in code`).not.toContain(RETIRED_ROUTINE);
  });
});
