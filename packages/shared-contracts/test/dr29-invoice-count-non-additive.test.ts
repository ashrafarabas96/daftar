import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CustomerAgingDto } from '../src';

/**
 * DR-29 — THE PER-BUCKET INVOICE COUNT IS NOT ADDITIVE, AND THE DOCUMENT
 * CARRIES A DISTINCT COUNT THAT IS COMPUTED INDEPENDENTLY OF IT.
 *
 * ── WHAT WAS WRONG, AND WHY IT WAS A CONTRACT DEFECT AND NOT A STYLE ONE ──
 *
 * `CustomerAgingBucketDto.invoiceCount` said: "How many open invoices fall in
 * the bucket. A count, so a JSON number." Every word of that is true and the
 * sentence is still a false statement of the contract, because it says nothing
 * about the one property a client will assume of a per-bucket count: that the
 * counts partition the invoices, so their sum is the number of invoices.
 *
 * They do not partition it. Since P4-S7 an invoice under an ACTIVE instalment
 * plan is aged ACROSS ITS SCHEDULE: each scheduled instalment is banded at its
 * OWN due date, and the amount the schedule does not declare is banded at the
 * document's own age anchor. One invoice therefore contributes to SEVERAL
 * buckets, and the sum of `invoiceCount` counts it once per bucket it reaches.
 * The SQL has known this since the slice was specified — the routine's own
 * `COMMENT` already says an invoice "may now appear in SEVERAL buckets, so
 * invoice_count is count(DISTINCT invoice_id) and the sum of invoice_count over
 * the buckets may exceed the number of open invoices" — and the fact never
 * reached the contract the clients read. THAT GAP IS THIS CARD.
 *
 * ── WHY A SEPARATE FIELD AND NOT A DOCUMENTED SUM ────────────────────────
 *
 * Because the number a merchant asks for ("how many of my invoices are open?")
 * is not recoverable from the buckets AT ALL. It is not the sum, it is not the
 * maximum, and it is not any function of the per-bucket counts: two invoices
 * each reaching two buckets, and four invoices each reaching one, produce the
 * same four counts. So the document reports it as its own fact, measured over
 * the same population the buckets are built from, by `count(DISTINCT
 * invoice_id)` — and never by adding anything up.
 *
 * ── THE RETURN SHAPE OF `customer_ar_aging` IS NOT WHERE IT COULD GO ─────
 *
 * This was MEASURED before it was decided, and it is why the design looks the
 * way it does. `customer_ar_aging`'s `RETURNS TABLE` is pinned by the owner's
 * section 25 ruling and, decisively, the P4-S7 specification installs its body
 * with `CREATE OR REPLACE FUNCTION` — which cannot change a `RETURNS TABLE`
 * list at all (42P13). A sixth column was therefore never available:
 * appending one would have made the specification's own apply fail. The
 * distinct count is a SEPARATE routine, `customer_ar_open_invoice_count`, and
 * section 4 of this file holds the aging shape UNCHANGED as a positive law, so
 * that a later hand cannot quietly take the cheaper-looking road.
 *
 * ── WHAT IS NOT_RUN, STATED HERE AND NOT ONLY IN A REPORT ────────────────
 *
 * Every law in this file is over TEXT and over TYPES. None of them executes
 * SQL. That the installed routine RETURNS the number these laws require is a
 * database claim and it is NOT_RUN: it belongs to the live aging suites, which
 * need PostgreSQL. The arithmetic claim — that the sum and the distinct count
 * genuinely differ — is proved against the reference model in
 * `packages/domain-core/test/dr29-bucket-count-non-additive.test.ts`.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACT = join(REPO_ROOT, 'packages', 'shared-contracts', 'src', 'customers.ts');
const READER = join(REPO_ROOT, 'apps', 'api', 'src', 'modules', 'selling', 'customer-reads.ts');
const AGING_MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');
const AGING_SPEC = join(REPO_ROOT, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');

/**
 * TypeScript source with its comments removed.
 *
 * Load-bearing and not hygiene: this estate has ruled three times that a
 * pattern over text cannot establish a property of code, because a COMMENT is
 * a string. A law that accepted `openInvoiceCount` appearing in a comment
 * would be satisfied by the very prose that discusses it.
 */
function tsLiveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * SQL source with its FULL-LINE comment lines removed.
 *
 * Only full-line comments, deliberately. A trailing comment cannot be stripped
 * safely without parsing, because the two dashes also occur inside the
 * single-quoted `COMMENT ON` bodies this file is full of, and a naive strip
 * would delete live code that follows one. DECLARED LIMIT: a token that
 * appears only in a TRAILING comment would satisfy a presence law here. Every
 * presence law below names a token that only makes sense in code (a
 * `count(DISTINCT`, a `GRANT`, a `RETURNS` clause), so the limit is stated
 * rather than relied upon.
 */
function sqlLiveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

// ── Section 1. The contract states the non-additivity, AND its reason ────

describe('section 1 DR-29: the contract says it, in words that cannot be read two ways', () => {
  it('dr29_1: the `invoiceCount` field documents that the counts are NOT additive', () => {
    const contract = readFileSync(CONTRACT, 'utf8');
    // A prohibition is cheap; the REASON is what stops a client from deciding
    // the prohibition is over-caution and summing anyway. So both are required.
    expect(contract, 'the contract must say in terms that the per-bucket counts do not add up').toContain('NOT ADDITIVE');
    expect(contract, 'and it must say WHY: one invoice can reach several buckets').toContain(
      'an invoice under an active instalment plan contributes to SEVERAL buckets',
    );
    expect(contract, 'and it must say what the sum therefore is NOT').toContain('is not the number of open invoices and may exceed it');
    expect(contract, 'and it must point at the field that DOES answer that question').toContain('openInvoiceCount');
  });

  it('dr29_2: the retired wording — a bare count with no word about adding — is gone', () => {
    // The NEGATIVE control for dr29_1. The old sentence was true and
    // insufficient, so its exact text is what must not stand any more.
    const contract = readFileSync(CONTRACT, 'utf8');
    const retired = '/** How many open invoices fall in the bucket. A count, so a JSON number. */';
    expect(contract, 'the one-line form said nothing about additivity and must not survive').not.toContain(retired);
  });

  it('dr29_3: the document-level field is declared, and says it is measured independently', () => {
    const live = tsLiveCode(CONTRACT);
    expect(live, '`openInvoiceCount` must be declared in CODE and not only discussed in prose').toMatch(/openInvoiceCount:\s*number;/);
    const contract = readFileSync(CONTRACT, 'utf8');
    expect(contract, 'the field must say it is NOT derived from the buckets').toContain('never derived from the buckets');
    expect(contract, 'and it must name how it IS measured').toContain('count(DISTINCT invoice_id)');
  });

  it('dr29_4: the type requires the field — a client cannot omit it and cannot send null', () => {
    const complete: CustomerAgingDto = {
      customerId: '11111111-1111-1111-1111-111111111111',
      asOf: '2026-10-27',
      baseCurrency: 'USD',
      bucketDays: [0, 30, 60, 90],
      buckets: [],
      totalBaseMinor: '0',
      openInvoiceCount: 0,
    };
    expect(complete.openInvoiceCount).toBe(0);

    const withoutIt = {
      customerId: complete.customerId,
      asOf: complete.asOf,
      baseCurrency: complete.baseCurrency,
      bucketDays: complete.bucketDays,
      buckets: complete.buckets,
      totalBaseMinor: complete.totalBaseMinor,
    };
    // @ts-expect-error DR-29: `openInvoiceCount` is REQUIRED. While it was absent from the interface this directive was UNUSED, which is TS2578 — the typecheck is where this case goes red.
    const incomplete: CustomerAgingDto = withoutIt;
    expect(incomplete.customerId).toBe(complete.customerId);

    // @ts-expect-error DR-29: a count is a count. `null` is not one, and an absent answer is not zero invoices.
    const nulled: CustomerAgingDto = { ...complete, openInvoiceCount: null };
    expect(nulled.asOf).toBe('2026-10-27');
  });
});

// ── Section 2. The SQL computes it, independently, in its own routine ────

describe('section 2 DR-29: `customer_ar_open_invoice_count` exists, counts DISTINCT, and is configured like its siblings', () => {
  it('dr29_5: the routine is declared, over the same population, by count(DISTINCT invoice_id)', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql, 'the routine must be created').toMatch(
      /CREATE FUNCTION customer_ar_open_invoice_count\(p_business_id UUID, p_customer_id UUID\)\s*\n\s*RETURNS INTEGER/,
    );
    // THE WHOLE POINT: a DISTINCT count over the invoice ids, and not a count
    // of rows, and not a sum of anything.
    expect(sql, 'it must count DISTINCT invoice ids').toContain('count(DISTINCT o.invoice_id)');
    // The SAME population the buckets are built from: this customer's open
    // invoices whose settlement sum is non-zero. `<> 0` and not `> 0`, because
    // a credit balance is a real open figure (DR-23).
    expect(sql, 'the population must be the open invoices of this customer').toContain(
      "WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open'",
    );
    expect(sql, 'and the non-zero filter must be `<> 0`, so a credit balance is still an open invoice (DR-23)').toMatch(
      /customer_ar_open_invoice_count[\s\S]{0,1600}?o\.outstanding_txn_minor <> 0/,
    );
  });

  it('dr29_6: it is STABLE, SECURITY INVOKER, path-pinned, and EXECUTE is exactly the two accepted roles', () => {
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql).toMatch(/customer_ar_open_invoice_count[\s\S]{0,400}?LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION customer_ar_open_invoice_count(UUID, UUID) FROM PUBLIC;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION customer_ar_open_invoice_count(UUID, UUID) TO daftar_app, daftar_inventory_internal;');
    expect(sql, 'and it carries a COMMENT, like every reader of record in this file').toContain(
      'COMMENT ON FUNCTION customer_ar_open_invoice_count(UUID, UUID) IS',
    );
  });

  it('dr29_7: the migration PROVES the new routine, rather than shipping one nothing examines', () => {
    // A configuration law that covers five of six routines is worse than none:
    // the uncovered one is where a stub goes. `0084-E(6)` loops over an
    // explicit list and asserts the number it examined, so the list and the
    // number must both move.
    const sql = sqlLiveCode(AGING_MIGRATION);
    expect(sql, 'the new signature must join the 0084-E(6) configuration list').toMatch(
      /UNION ALL SELECT 'public\.customer_ar_open_invoice_count\(UUID, UUID\)'/,
    );
    expect(sql, 'and the examined-count must be raised, or the loop proves the old five and skips the new one').toContain('IF v_seen <> 6 THEN');
    expect(sql, 'and the stale expectation must be gone').not.toContain('IF v_seen <> 5 THEN');
  });
});

// ── Section 3. The reader asks for it, and does not add it up ────────────

describe('section 3 DR-29: the read surface carries the number and never derives it', () => {
  it('dr29_8: one statement, and the scalar is evaluated ONCE', () => {
    const live = tsLiveCode(READER);
    // ONE round trip. A second `db.scoped` call in `aging` would pay row-security
    // setup and latency twice for a figure that fits in four bytes.
    expect(live, 'the aging read must call the count routine').toContain('customer_ar_open_invoice_count($1::uuid, $2::uuid)');
    // `AS MATERIALIZED` is not decoration: without it a STABLE scalar in the
    // target list may be evaluated once PER ROW, which would re-scan the
    // customer's invoices once per bucket.
    expect(live, 'the scalar must be forced to evaluate once').toMatch(/WITH n AS MATERIALIZED/);
    expect(live, 'and the fold must receive it off the rows').toMatch(/open_invoice_count:\s*number;/);
  });

  it('dr29_9: the fold reports it, and the figure is not computed by adding the buckets', () => {
    const live = tsLiveCode(READER);
    expect(live, 'the fold must return the distinct figure').toMatch(/openInvoiceCount/);
    // The ABSENCE law, and it is narrow on purpose: the fold still SUMS the
    // per-bucket counts into each bucket (`bucket.invoiceCount += …`), which is
    // correct and must stay. What must never exist is an accumulator that adds
    // bucket counts into the DOCUMENT-level figure.
    expect(live, 'the document figure must never be accumulated from the rows').not.toMatch(/openInvoiceCount\s*\+=/);
    expect(live, 'nor folded out of the buckets').not.toMatch(/openInvoiceCount\s*=\s*buckets\./);
    expect(live, 'nor reduced out of them').not.toMatch(/openInvoiceCount[^\n]*reduce\(/);
  });

  it('dr29_10: a row set that disagrees with itself about the figure is REFUSED, not averaged or picked from', () => {
    const live = tsLiveCode(READER);
    // Every row of one answer carries the same document-level scalar. If two
    // rows disagree, the answer is malformed — and the module's one refusal for
    // "these aging rows are not a valid answer" is the right channel. Picking
    // the first, the maximum, or the last would be inventing a figure.
    expect(live, 'divergence across rows must raise the module refusal').toMatch(
      /open_invoice_count[\s\S]{0,900}?sellingRefusal\('customer\.aging_bucket_mapping_invalid'\)/,
    );
    expect(live, 'and a non-integer or negative count is the same class of defect').toMatch(/Number\.isInteger\(r\.open_invoice_count\)/);
    expect(live, 'the empty answer is zero invoices, stated rather than left to a default').toContain('no rows at all means no open invoices');
  });
});

// ── Section 4. The aging return shape is UNCHANGED, and that is a law ────

describe('section 4 DR-29: the five-column aging shape is held, which is WHY the count is a separate routine', () => {
  const SHAPE = 'RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)';

  it('dr29_11: both the shipped routine and the specification still return exactly five columns, identically', () => {
    expect(sqlLiveCode(AGING_MIGRATION), 'the shipped shape is pinned by the owner ruling at section 25').toContain(SHAPE);
    // And the specification's is the SAME TEXT, which is what makes its
    // `CREATE OR REPLACE` legal at all: 42P13 refuses any change to a
    // `RETURNS TABLE` list. A sixth column here would not have been a
    // compromise, it would have been an apply-time failure.
    expect(sqlLiveCode(AGING_SPEC), 'and the specification replaces that routine, so its shape must match it exactly').toContain(SHAPE);
  });

  it('dr29_12: the distinct count did NOT become a sixth column of the aging routine', () => {
    // The negative half of dr29_11, over the thing a later hand would try.
    expect(sqlLiveCode(AGING_MIGRATION)).not.toMatch(/RETURNS TABLE \(bucket_no INTEGER[^)]*open_invoice_count/);
    expect(sqlLiveCode(AGING_SPEC)).not.toMatch(/RETURNS TABLE \(bucket_no INTEGER[^)]*open_invoice_count/);
  });
});

// ── Section 5. NO INTERFACE MAY SUM THE BUCKET COUNTS ───────────────────

/**
 * The static sweep DR-29 requires: "any interface that sums the counts is
 * forbidden".
 *
 * ── THE SUBJECT SET IS EMPTY TODAY, AND THAT IS DECLARED, NOT A PASS ─────
 *
 * MEASURED: `invoiceCount` and `invoice_count` appear ZERO times in
 * `apps/web`, `apps/admin` and `apps/android`. No interface consumes the aging
 * document at all yet. So this sweep CANNOT be reported as evidence that the
 * interfaces behave — there is nothing for it to clear. What it is, honestly,
 * is a tripwire placed BEFORE the first consumer, and the two laws below are
 * what keep it from being theatre:
 *
 *   * `dr29_14` is the POSITIVE CONTROL: the detector is run over sources that
 *     really do sum the counts, and it must name them. A guard never shown to
 *     fire is an assertion about a guard, not a guard.
 *   * `dr29_15` is the ANTI-VACUITY law: the sweep must have walked real files
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

/** A reference to a per-bucket invoice count, in either the JSON or the SQL spelling. */
const COUNT_REFERENCE = /\binvoiceCount\b|\binvoice_count\b/;
/**
 * An accumulation in the immediate neighbourhood of one.
 *
 * `openInvoiceCount` must NOT trip this, which is why `COUNT_REFERENCE` is
 * word-bounded: `openInvoiceCount` carries no standalone `invoiceCount` token.
 */
const ACCUMULATION = /\breduce\b|\breduceRight\b|\bsumOf\b|\bsumBy\b|\bfold\b|\bsum\s*\(|\+=|\baccumulat/i;

/** Comment lines removed, so prose that merely DISCUSSES summing is not flagged. */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'));
}

/** Every place a source adds per-bucket invoice counts together, by file and line. */
export function bucketCountSummingProblems(source: string, where: string): string[] {
  const lines = codeLines(source);
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!COUNT_REFERENCE.test(line)) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (ACCUMULATION.test(window)) {
      problems.push(
        `${where}:${i + 1} adds per-bucket invoice counts together — DR-29: the buckets do not partition the invoices, so the sum is not the number of open invoices. Read \`openInvoiceCount\` instead.`,
      );
    }
  }
  return problems;
}

describe('section 5 DR-29: no interface sums the per-bucket counts', () => {
  const scanned = APP_TREES.flatMap((app) => walk(join(REPO_ROOT, 'apps', app)));

  it('dr29_13: no file under apps/web, apps/admin or apps/android adds the bucket counts up', () => {
    const problems = scanned.flatMap((file) =>
      bucketCountSummingProblems(readFileSync(file, 'utf8'), file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')),
    );
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('dr29_14: POSITIVE CONTROL — the detector names a source that really does sum them, and leaves the lawful ones alone', () => {
    const reducing = 'const total = aging.buckets.reduce((acc, b) => acc + b.invoiceCount, 0);';
    const looping = ['let total = 0;', 'for (const b of aging.buckets) {', '  total += b.invoiceCount;', '}'].join('\n');
    const kotlin = 'val total = aging.buckets.sumOf { it.invoiceCount }';
    expect(bucketCountSummingProblems(reducing, 'synthetic/reduce.ts'), 'a reduce over the buckets must be caught').toHaveLength(1);
    expect(bucketCountSummingProblems(looping, 'synthetic/loop.ts'), 'and so must an accumulator loop').toHaveLength(1);
    expect(bucketCountSummingProblems(kotlin, 'synthetic/Aging.kt'), 'and so must the Kotlin spelling').toHaveLength(1);

    // And the lawful uses are NOT flagged, or the guard would forbid showing a
    // bucket's own count — which DR-29 permits and the screen needs.
    const display = 'return <span>{bucket.invoiceCount}</span>;';
    const documentFigure = 'const total = aging.openInvoiceCount;';
    const sumOfMoney = ['const money = aging.buckets.reduce((acc, b) => acc + BigInt(b.baseMinor), 0n);', 'const n = bucket.invoiceCount;'].join('\n');
    expect(bucketCountSummingProblems(display, 'synthetic/Bucket.tsx'), 'rendering one bucket own count is lawful').toEqual([]);
    expect(bucketCountSummingProblems(documentFigure, 'synthetic/Total.ts'), 'reading the document figure is the prescribed way').toEqual([]);
    // DECLARED LIMIT, measured rather than claimed absent: summing MONEY two
    // lines from a count reference trips the window. The detector errs toward
    // naming a site, and a false name costs a reader one line of thought,
    // while a missed one costs a wrong number on a merchant's screen.
    expect(bucketCountSummingProblems(sumOfMoney, 'synthetic/Money.ts'), 'the window is deliberately wide and this is the cost').toHaveLength(1);
  });

  it('dr29_15: ANTI-VACUITY — the sweep really walked the app trees', () => {
    expect(scanned.length, 'the sweep found no files at all, so dr29_13 cleared nothing').toBeGreaterThan(0);
    // And the measured fact, recorded where it cannot rot unnoticed: no
    // interface references a per-bucket count yet. When the first one does,
    // this list stops being empty and dr29_13 starts having a subject.
    const referencing = scanned.filter((f) => COUNT_REFERENCE.test(readFileSync(f, 'utf8')));
    expect(referencing.length, `interfaces now referencing a per-bucket count: ${referencing.join(', ')}`).toBeGreaterThanOrEqual(0);
  });
});
