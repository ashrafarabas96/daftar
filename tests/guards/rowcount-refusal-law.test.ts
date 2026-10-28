import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE `ROW_COUNT` REFUSAL IN `invoice_outstanding(UUID, UUID[])`, AS A LAW.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * `0084`'s own comment hangs the correctness of a money count on a refusal:
 * one row per invoice found, compared against the distinct ids asked about,
 * and `invoice.not_found` raised when they differ. The DR-29 review found that
 * nothing read that body. MEASURED on the base commit: `v_found` had ZERO
 * occurrences in any `.ts` under `tests`, `scripts`, `packages` or `apps` —
 * a count this file itself now changes, so re-measure it on the base and not
 * on the tree. The refusal's BEHAVIOUR is covered — by
 * `tests/integration/sale-s2-error-contract.test.ts`,
 * `tests/performance/receivables-ar-setbased-equivalence.test.ts`,
 * `tests/security/p4s4-cross-tenant-command-refusal.test.ts` and
 * `tests/security/p4s4-rls-barrier-behaviour.test.ts` — but every one of those
 * needs PostgreSQL, and none of them runs on this lineage today. So this text
 * law is, for now, the only thing holding the refusal in CI.
 *
 * ── THE CLAIM, STATED SO IT CANNOT BE OVERSTATED LATER ───────────────────
 *
 * THE `ROW_COUNT` COMPARISON IS A DETECTOR AND NOT A PREVENTER. It reports; it
 * does not make a wrong row count impossible. What makes a wrong row count
 * unrepresentable is structural, and it has TWO HALVES, because the comparison
 * can go wrong in two directions:
 *
 *   NO INFLATION — the returned count can never EXCEED the distinct ids asked
 *   about. Four constraints:
 *     1. `invoices PRIMARY KEY (business_id, id)` — at most one driving row
 *        per id, since `business_id` is fixed by the predicate.
 *     2. `sales PRIMARY KEY (business_id, id)` — the inner
 *        `JOIN public.sales s ON s.business_id = i.business_id AND s.id =
 *        i.sale_id` is an equi-join onto that key, so it matches at most once.
 *     3. `GROUP BY d.invoice_id` in the reducer subquery — `r` holds at most
 *        one row per invoice, so the `LEFT JOIN` onto it matches at most once.
 *     4. The routine reads as INVOKER. Under `SECURITY DEFINER` it would see
 *        rows the caller may not, which raises the count and silences the
 *        report — and `0084`'s own text calls that out.
 *
 *   NO LOSS — the returned count can never fall SHORT for any reason other
 *   than an id that names no invoice this caller can see. That needs the inner
 *   join to be TOTAL:
 *     5. `invoices.sale_id UUID NOT NULL` together with the VALIDATED
 *        composite edge `invoices_sale_fk (business_id, sale_id) REFERENCES
 *        sales (business_id, id)`. `0080` asserts that edge is `convalidated`
 *        at migration time, and its refusal message says why in so many
 *        words: otherwise «the join below could lose a row».
 *
 * Both halves are load-bearing, and only together do they make
 * `v_found < v_asked` MEAN «some id named no invoice this caller can see».
 * Remove the comparison alone and no sum changes; what is lost is the report.
 * **THE REFUSAL DOES NOT PREVENT DUPLICATION.** It would catch duplication if
 * duplication were reachable, which is a different sentence, and this card was
 * opened because the stronger sentence had been written once already.
 *
 * ── TWO THINGS THE FIRST VERSION OF THIS FILE GOT WRONG ──────────────────
 *
 * Recorded rather than quietly corrected, because both are the same mistake
 * the file is about — a claim wider than its support.
 *
 * FIRST, it quantified over WHICH VARIABLE the governing comparison reads and
 * not over the comparison itself, and so it called itself a law that «goes red
 * when the refusal is weakened». MEASURED: rewriting the inner test to
 * `IF v_found > v_asked` left the suite GREEN at 11/11 while making the
 * refusal UNREACHABLE — because the four no-inflation constraints give
 * `v_found <= v_asked` on every path that reaches it, so the strict ordering
 * is never true. An id naming an invisible invoice then returns a short result
 * set in silence. `<=` and `IS NOT NULL` were green too, and both refuse a
 * VALID request. `rc_4b` closes that, and names the operator's direction as
 * the reason rather than pinning a spelling.
 *
 * SECOND, it listed three constraints and said they made a «wrong row count»
 * unrepresentable, when the three bound the count only from ABOVE. The
 * narrowing was never declared. MEASURED: deleting `invoices_sale_fk`, and
 * separately making `sale_id` nullable, both left the suite GREEN at 11/11.
 * `rc_11` closes that.
 *
 * ── WHY THE FILE IS NOT NAMED `p4…` ──────────────────────────────────────
 *
 * Deliberate, and please do not "fix" it. `scripts/phase4-s1-gate.ts` scans
 * for `/^(?:p4|phase4)-.*\.test\.ts$/` and `/^(?:p4|phase4)s\d+-.*\.test\.ts$/`
 * and FAILS on any match no slice roster lists. That roster lives in a file
 * this card does not own, in a tree that is frozen under double review. The
 * `GD-01` row of that same gate is a DIRECTORY row over `tests/guards`, so
 * this suite is executed regardless of its name. A Phase 4 prefix here would
 * buy nothing and would redden a gate.
 *
 * ── WHAT IS NOT_RUN, SAID HERE AND NOT ONLY IN A REPORT ──────────────────
 *
 * Every law below is over TEXT. None executes SQL and none opens a
 * connection. That the INSTALLED routine refuses what its source says it
 * refuses is a DATABASE claim and it is NOT_RUN here; it belongs to the four
 * suites named above. And one further limit, stated rather than left to be
 * discovered: these laws read migration SOURCE. A database migrated to some
 * earlier revision holds an earlier body, and nothing here measures which
 * revision any given database is at.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');

/** The migration that declares `invoices`. Frozen; read only. */
const INVOICES_MIGRATION = '0075_phase4_customers_invoices_numbering.sql';
/** The migration that declares `sales` and the composite edge to it. Frozen; read only. */
const SALES_MIGRATION = '0077_phase4_sales_sale_items_sources.sql';
/** The migration whose `DO` block asserts that edge is validated. Frozen; read only. */
const VALIDATION_MIGRATION = '0080_phase4_cash_invoice_no_receivable.sql';

/**
 * The SET-BASED signature, matched as a SIGNATURE and not as a name.
 *
 * Load-bearing: `invoice_outstanding` is OVERLOADED. `0084` defines
 * `(UUID, UUID)` at its §4 — a thin `plpgsql` wrapper that holds no arithmetic
 * and no refusal — and `(UUID, UUID[])` at its §5, which is the one body that
 * holds both. A helper keyed on the NAME would have resolved to whichever
 * `CREATE FUNCTION invoice_outstanding` came first and could have asserted the
 * detector pair against a wrapper that has never contained it. Measured: the
 * name matches twenty-one lines across the Phase 4 migrations, and the wrapper
 * is written BEFORE the array form on purpose (`0084` §4's comment, R-100).
 */
const ARRAY_FORM = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+invoice_outstanding\s*\(\s*p_business_id\s+UUID\s*,\s*p_invoice_ids\s+UUID\[\]\s*\)/g;

/** Whitespace collapsed, so a claim is about the text and not about indentation. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * SQL with its FULL-LINE `--` comments removed, and only those.
 *
 * Only full-line, deliberately: two dashes also occur inside the single-quoted
 * `COMMENT ON` bodies these migrations are full of, and a greedier strip would
 * delete live code that follows one.
 *
 * DECLARED LIMIT: a token appearing only in a TRAILING comment would satisfy a
 * presence law here. Mitigated rather than ignored — every presence law below
 * pins a token that means nothing outside code, and the two whose token could
 * plausibly be written in prose (`rc_3`'s raise, `rc_11`'s edge) assert a full
 * STATEMENT shape first, which a trailing comment would have to reproduce
 * whole.
 */
function sqlLiveCode(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

/** Every `NNNN_*.sql` under the migrations directory, in revision order. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

/**
 * The LAST migration that defines a signature, and its live code.
 *
 * It follows the SHIPPED body rather than naming a revision, and that is the
 * whole design. `0075`, `0080`, `0081`, `0083` and `0084` each define some
 * `invoice_outstanding`, and `CREATE OR REPLACE` means the LAST one applied is
 * the one a migrated database holds. A law pointed at a fixed revision would
 * keep passing against a body that had been superseded — which is exactly how
 * `0075` and `0083` came to carry a retired aging predicate in live code while
 * `0084` carried the corrected one. Pointing at the last definition means a
 * later slice that replaces this body inherits these laws with no edit here.
 */
function lastDefining(re: RegExp): { file: string; sql: string } {
  let found = { file: '', sql: '' };
  for (const file of migrationFiles()) {
    const sql = sqlLiveCode(join(MIGRATIONS, file));
    if (new RegExp(re.source).test(sql)) found = { file, sql };
  }
  return found;
}

/**
 * One routine's body, from the LAST occurrence of its signature to the `$fn$;`
 * that closes it.
 *
 * A SLICE and not a bounded lookahead: `/sig[\s\S]{0,2000}?token/` finds its
 * token in the NEXT routine once this one grows, and the law then passes by
 * reaching past its own subject. The LAST occurrence, because a file may
 * replace a routine it defined earlier in the same file. Returns `''` when the
 * signature is absent, which callers assert against rather than treating as a
 * vacuous pass.
 */
function signatureBody(sql: string, re: RegExp): string {
  const all = [...sql.matchAll(new RegExp(re.source, 'g'))];
  const last = all[all.length - 1];
  if (last?.index === undefined) return '';
  const end = sql.indexOf('$fn$;', last.index);
  return end === -1 ? '' : sql.slice(last.index, end + '$fn$;'.length);
}

/** A routine's header: everything before the dollar-quoted body opens. */
function routineHeader(body: string): string {
  const at = body.indexOf('AS $fn$');
  return at === -1 ? '' : body.slice(0, at);
}

/**
 * One table's `CREATE TABLE` block, from its header to the `);` in column one
 * that closes it.
 *
 * MEASURED NECESSITY, not tidiness. `PRIMARY KEY (business_id, id)` occurs
 * FOUR times in `0075` — `customers`, `customer_contacts`, `invoices`,
 * `invoice_items` — and TWICE in `0077`. A file-wide `toContain` for that
 * string is therefore satisfied by any one of them and guards NONE of them:
 * measured, with the key deleted from `invoices` the string still occurs three
 * times in `0075`, so a file-wide search stays green. This is `populationOf`'s
 * lesson one table later — membership is not location.
 */
function tableBlock(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE ${table} (`);
  if (start === -1) return '';
  const end = sql.indexOf('\n);', start);
  return end === -1 ? '' : sql.slice(start, end + '\n);'.length);
}

/**
 * The region of the body in which the refusal is decided: from the
 * `GET DIAGNOSTICS` that reads `ROW_COUNT` to the end of the body.
 *
 * Scoped, because the `IF` conditions this file reasons about are the ones
 * that govern the refusal. The `CASE WHEN` arms up in the `RETURN QUERY` are
 * arithmetic and have nothing to do with it.
 */
function refusalRegion(body: string): string {
  const start = body.search(/GET\s+DIAGNOSTICS/i);
  return start === -1 ? '' : body.slice(start);
}

/** Every `IF … THEN` condition in a region, as written, with its offset. */
function ifConditions(region: string): { at: number; cond: string }[] {
  return [...region.matchAll(/\bIF\s+([\s\S]*?)\s+THEN\b/gi)].map((m) => ({ at: m.index ?? -1, cond: collapse(m[1] ?? '') }));
}

/**
 * The condition that IMMEDIATELY governs the raise: the last `IF … THEN` that
 * opens before it.
 *
 * Positional and not nth, so that deleting the inner `IF` entirely — which
 * leaves the raise governed by the OUTER condition and therefore reachable on
 * any request with a repeated id — is caught by the same law rather than
 * needing its own.
 */
function governingCondition(region: string): string {
  const raise = region.indexOf('RAISE EXCEPTION');
  if (raise === -1) return '';
  const before = ifConditions(region).filter((c) => c.at !== -1 && c.at < raise);
  return before[before.length - 1]?.cond ?? '';
}

/**
 * Prose with its comment scaffolding removed, flattened to one line.
 *
 * MEASURED NECESSITY. The sentence this file is required to state —
 * «the refusal does not prevent duplication» — is WRAPPED across two comment
 * lines, so a line-by-line scan misses it, and the first version of the probe
 * below both missed the statement and, scanning unflattened, mis-read it. A
 * claim that spans a line break is still the claim.
 */
function flattenProse(text: string): string {
  return collapse(text.replace(/\n\s*\*\s?/g, ' '));
}

/**
 * The overstatement this card was opened to retire, as a probe.
 *
 * It matches a sentence that credits the `ROW_COUNT` check, or the
 * `invoice.not_found` refusal, with making duplicated rows impossible — the
 * claim the DR-29 review struck out.
 *
 * NOTE, and it is the law working rather than an inconvenience: the sentence
 * immediately above had to be written in this order because the natural order
 * — subject, verb, object — IS an instance of the forbidden shape, and `rc_10`
 * scans this file. A probe that forbids a claim has to forbid it in prose
 * about the probe too, or it is a probe with a hole shaped like itself.
 *
 * `overstates` and not the bare regular expression, for a reason worth
 * recording: the first version WAS the bare expression, and it flagged this
 * file's own header, because «does not prevent duplication» contains
 * «prevent … duplication». A probe that cannot tell a claim from its denial
 * would have forced the honest sentence out of the file to get green — the
 * exact inversion of the point. So a match is discarded when the span that
 * reaches the verb is negated, and `rc_10` controls BOTH directions: the
 * affirmative must be found, and the denial must not be.
 */
const OVERSTATEMENT_SHAPE =
  /(?:ROW_COUNT|row count|refusal|invoice\.not_found)([^.]{0,120}?)(?:prevents?|forbids?|makes? (?:it )?impossible|rules? out|stops?)[^.]{0,40}?(?:duplicat|inflat|multipl)/gi;

function overstates(text: string): boolean {
  for (const m of flattenProse(text).matchAll(OVERSTATEMENT_SHAPE)) {
    if (!/\b(?:not|never|cannot|can't|does ?n't|no)\b/i.test(m[1] ?? '')) return true;
  }
  return false;
}

const THIS_FILE = join(__dirname, 'rowcount-refusal-law.test.ts');
/** The sentence this file is required to state, in one piece. */
const REQUIRED_DENIAL = 'THE REFUSAL DOES NOT PREVENT DUPLICATION.';

type Role = 'detector' | 'preventer';
/** Which direction a preventer bounds the returned count in. */
type Bound = 'above' | 'below' | 'both';

interface Pin {
  /** The law in this file that holds it. */
  readonly law: string;
  readonly role: Role;
  /** Required on a preventer, absent on a detector. */
  readonly bound?: Bound;
  /** Where it lives — and the point of the table is that these differ. */
  readonly subject: string;
  readonly token: string;
}

/**
 * THE CLASSIFICATION, AS DATA THE LAWS CONSUME.
 *
 * Not prose. A role written in a comment is a role nobody can be held to; this
 * table is read by `rc_9`, which refuses a pin with no law, a law with no pin,
 * a role outside the vocabulary, a preventer that does not say which direction
 * it bounds, and — the one that matters — the detector relabelled as a
 * preventer.
 *
 * The `bound` column exists because its absence is how the first version of
 * this file came to call three constraints sufficient for a claim that needed
 * five. A preventer that cannot say which direction it bounds is a preventer
 * nobody can check the coverage of.
 */
const PINS: readonly Pin[] = [
  { law: 'rc_2', role: 'detector', subject: 'the array-form body', token: 'GET DIAGNOSTICS v_found = ROW_COUNT' },
  { law: 'rc_3', role: 'detector', subject: 'the array-form body', token: "RAISE EXCEPTION 'invoice.not_found … P0001" },
  { law: 'rc_4', role: 'detector', subject: 'the array-form body', token: 'every IF governing the refusal reads v_found' },
  { law: 'rc_4b', role: 'detector', subject: 'the refusal region of the array-form body', token: 'the governing comparison is v_found <> v_asked' },
  { law: 'rc_5', role: 'detector', subject: 'the refusal region of the array-form body', token: 'count(*) INTO v_asked over DISTINCT unnest(p_invoice_ids)' },
  { law: 'rc_6', role: 'preventer', bound: 'above', subject: 'the reducer subquery of the array-form body', token: 'GROUP BY d.invoice_id' },
  { law: 'rc_7', role: 'preventer', bound: 'above', subject: `CREATE TABLE invoices in ${INVOICES_MIGRATION}`, token: 'PRIMARY KEY (business_id, id)' },
  { law: 'rc_8', role: 'preventer', bound: 'above', subject: `CREATE TABLE sales in ${SALES_MIGRATION}`, token: 'PRIMARY KEY (business_id, id)' },
  {
    law: 'rc_11',
    role: 'preventer',
    bound: 'below',
    subject: `invoices.sale_id and invoices_sale_fk, ${INVOICES_MIGRATION} and ${SALES_MIGRATION}`,
    token: 'UUID NOT NULL + a VALIDATED composite edge',
  },
  { law: 'rc_12', role: 'preventer', bound: 'above', subject: 'the array-form routine header', token: 'no SECURITY DEFINER' },
  { law: 'rc_13', role: 'preventer', bound: 'both', subject: 'every migration', token: 'nothing later drops or invalidates the five' },
];

/** The laws that resolve the subject or audit the table, rather than pinning a constraint. */
const UNPINNED_LAWS = ['rc_1', 'rc_9', 'rc_10'];

// ── Section 1. The body these laws read is the body that ships ───────────

describe('section 1: the subject is resolved by signature, from the last migration that defines it', () => {
  it('rc_1: the array form resolves to a non-empty body from a migration no earlier than 0084', () => {
    const { file, sql } = lastDefining(ARRAY_FORM);
    expect(file, 'no migration defines invoice_outstanding(UUID, UUID[]) — every law below would have been vacuous').not.toBe('');
    // A FLOOR and not an equality. A later slice that replaces this body in
    // `0087` must inherit these laws, so pinning `0084` exactly would make a
    // legitimate replacement red. A floor instead blocks the failure that
    // matters: the resolver silently falling back to `0083`'s superseded body,
    // which would keep these laws green while `0084` lost its refusal.
    const revision = Number(file.slice(0, 4));
    expect(revision, `the array form resolved to ${file}, which is EARLIER than 0084 — this law would be reading a superseded body`).toBeGreaterThanOrEqual(84);

    const body = signatureBody(sql, ARRAY_FORM);
    expect(body, `the signature matched in ${file} but no $fn$; closed it, so the slice is empty`).not.toBe('');
    expect(body, 'the extracted slice must begin at the array-form signature').toMatch(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+invoice_outstanding/);
    expect(body.endsWith('$fn$;'), 'the slice must end at the terminator and not run into the next statement').toBe(true);
  });

  it('rc_1b: the array form and the scalar wrapper are DIFFERENT bodies, and only one holds the refusal', () => {
    // The positive control for `rc_1`'s whole premise. If both signatures
    // resolved to the same slice, every law below could be passing against the
    // wrapper, and a name-keyed helper is one edit away from doing exactly
    // that.
    const { sql } = lastDefining(ARRAY_FORM);
    const scalar = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+invoice_outstanding\s*\(\s*p_business_id\s+UUID\s*,\s*p_invoice_id\s+UUID\s*\)/g;
    const arrayBody = signatureBody(sql, ARRAY_FORM);
    const scalarBody = signatureBody(sql, scalar);
    expect(scalarBody, 'the scalar wrapper must be present, or this control proves nothing').not.toBe('');
    expect(scalarBody).not.toBe(arrayBody);
    expect(scalarBody, 'the wrapper holds no arithmetic and no refusal — if it did, the two would not be distinguishable by this means').not.toMatch(
      /ROW_COUNT/,
    );
    expect(arrayBody, 'and the array form is where the refusal lives').toMatch(/ROW_COUNT/);
  });
});

// ── Section 2. The DETECTOR: the pair, the variable, and the comparison ──

describe('section 2: the detector lives in the array-form body, and this is the comparison it makes', () => {
  const body = () => signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM);

  it('rc_2: the body READS ROW_COUNT into v_found, as the assignment itself', () => {
    // The assignment and not two co-occurring tokens. `GET DIAGNOSTICS` with
    // some other target, or a `v_found` assigned from somewhere else, would
    // satisfy a pair of `toContain`s and would not be this.
    expect(collapse(body()), 'GET DIAGNOSTICS must assign ROW_COUNT to v_found inside this body').toMatch(/GET DIAGNOSTICS v_found = ROW_COUNT\s*;/);
    expect(body(), 'and v_found must be DECLARED here, so the law is about this body and not an inherited name').toMatch(
      /DECLARE[\s\S]{0,200}?v_found\s+BIGINT\s*;/,
    );
  });

  it('rc_3: the body RAISES invoice.not_found as a whole statement, with the error code the contract names', () => {
    // The full statement shape FIRST, which is also what answers
    // `sqlLiveCode`'s declared trailing-comment limit: a comment would have to
    // reproduce the raise, its message and its error code to satisfy this.
    const collapsed = collapse(body());
    expect(collapsed, 'the refusal must be raised in this body, with P0001, as one statement').toMatch(
      /RAISE EXCEPTION 'invoice\.not_found[^']*'[^;]*USING ERRCODE = 'P0001'/,
    );
    expect(collapsed, "a caller-side check is not this routine's refusal").toContain("RAISE EXCEPTION 'invoice.not_found");
  });

  it('rc_4: EVERY IF in the refusal region reads v_found — the comparison cannot drift to another name', () => {
    const region = refusalRegion(body());
    expect(region, 'the refusal region is empty — GET DIAGNOSTICS was not found, so this law had no subject').not.toBe('');
    const conditions = ifConditions(region);
    expect(conditions.length, 'the refusal must be decided by at least one IF, or there is nothing here to quantify over').toBeGreaterThan(0);
    const blind = conditions.filter((c) => !/\bv_found\b/.test(c.cond));
    expect(
      blind.map((c) => c.cond),
      `every IF in the refusal region must read v_found; these do not: ${JSON.stringify(blind.map((c) => c.cond))}`,
    ).toEqual([]);
  });

  it('rc_4b: the comparison that governs the raise is v_found against v_asked, and its DIRECTION is the point', () => {
    // THE LAW THAT CATCHES WEAKENING RATHER THAN DELETION, and it exists
    // because the version of this file without it was GREEN at 11/11 against
    // three separate kills of the refusal. `rc_4`'s quantifier is over the
    // variable NAME; a name survives every one of them.
    //
    // Why the direction and not the spelling. The four no-inflation
    // constraints give `v_found <= v_asked` on every path that reaches here —
    // `0084`'s own comment states the chain, `ROW_COUNT <= distinct <=
    // cardinality`. So:
    //   `>`  or `>=`      — never true. The refusal becomes UNREACHABLE and an
    //                       id naming an invisible invoice returns a short
    //                       result set in silence. MEASURED green before this.
    //   `<=`, `IS NOT NULL`, or an unconditional raise inside the outer branch
    //                     — true when the counts AGREE, so a request with a
    //                       repeated id is REFUSED. Also measured green.
    //   `<>` or `<`       — true exactly when the count fell short, which with
    //                       the no-loss half means an id named no invoice this
    //                       caller can see. Both are correct and `<>` ships.
    // So the allowlist is a claim about meaning, and a later editor may move
    // between the two correct forms without touching this law.
    const region = refusalRegion(body());
    expect(region, 'the refusal region is empty, so this law had no subject').not.toBe('');
    const governing = governingCondition(region);
    expect(governing, 'no IF opens before the raise — it is unconditional inside the region, which refuses valid requests').not.toBe('');
    expect(
      governing,
      `the comparison governing the raise is \`${governing}\`. It must be \`v_found <> v_asked\` or \`v_found < v_asked\`: an ordering the other way is never true and kills the refusal silently, and anything weaker fires on a repeated id`,
    ).toMatch(/^v_found\s*(?:<>|!=|<)\s*v_asked$/);
  });

  it('rc_5: the count compared against is the DISTINCT ids asked about, so a repeated id is not a refusal', () => {
    // Money-adjacent and not cosmetic: compared against raw `cardinality`
    // alone, `invoice_outstanding(b, ARRAY[a, a])` returns one row for two
    // array entries and would be REFUSED — a valid request rejected, and the
    // open-invoice page is a caller that builds its array from a list.
    const region = collapse(refusalRegion(body()));
    expect(region, 'the distinct count must be taken over the array itself').toMatch(/SELECT DISTINCT x\.id FROM pg_catalog\.unnest\(p_invoice_ids\)/);
    expect(region, 'and it must be what the refusal compares against').toMatch(/count\(\*\) INTO v_asked/);
    // The fast path. `coalesce(…, 0)` is what makes a NULL array answer zero
    // rather than NULL, and a NULL array is a real caller shape:
    // `customer_ar_outstanding` passes `array_agg(...)`, which is NULL for a
    // customer with no open invoice.
    expect(region, 'with the raw cardinality used only as the fast path that cannot refuse on its own').toMatch(
      /IF v_found <> coalesce\(pg_catalog\.cardinality\(p_invoice_ids\), 0\) THEN/,
    );
  });
});

// ── Section 3. NO INFLATION: the count cannot exceed the ids asked about ─

describe('section 3: the count cannot exceed the distinct ids asked about, and these are the four reasons', () => {
  it('rc_6: the reducer subquery groups by invoice, so the LEFT JOIN onto it cannot multiply', () => {
    const body = signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM);
    const collapsed = collapse(body);
    expect(collapsed, 'the reducer must be joined as a grouped subquery aliased r').toMatch(
      /LEFT JOIN \([\s\S]*?GROUP BY d\.invoice_id[\s\S]*?\) r ON r\.invoice_id = i\.id/,
    );
    expect(collapsed, 'and the two reducer relations must both be inside it, or the group is over the wrong set').toMatch(
      /payment_allocations[\s\S]*?UNION ALL[\s\S]*?customer_credit_applications[\s\S]*?GROUP BY d\.invoice_id/,
    );
  });

  it('rc_7: invoices is keyed on (business_id, id), asserted INSIDE its own CREATE TABLE block', () => {
    const sql = sqlLiveCode(join(MIGRATIONS, INVOICES_MIGRATION));
    const block = tableBlock(sql, 'invoices');
    expect(block, `CREATE TABLE invoices was not found in ${INVOICES_MIGRATION} — this law had no subject`).not.toBe('');
    expect(collapse(block), 'the invoices table itself must carry PRIMARY KEY (business_id, id)').toContain('PRIMARY KEY (business_id, id)');
    // The positive control for the LOCATION claim, which is what makes this
    // law worth more than a file-wide search: the same string really does
    // occur elsewhere in this file, so a file-wide search would have been
    // green with the key gone.
    const occurrences = sql.split('PRIMARY KEY (business_id, id)').length - 1;
    expect(occurrences, 'if this string occurred only once in the file, the block scoping would be untested decoration').toBeGreaterThan(1);
    // The boundary, as a UNIVERSAL pattern and not as a pinned neighbour name:
    // naming the next table would be silenced by reordering the file.
    expect(block, 'and the block must stop before the next table, or the scoping is nominal').not.toMatch(/CREATE TABLE (?!invoices \()/);
  });

  it('rc_8: sales is keyed on (business_id, id) too — the join the commissioning card did not name', () => {
    const sql = sqlLiveCode(join(MIGRATIONS, SALES_MIGRATION));
    const block = tableBlock(sql, 'sales');
    expect(block, `CREATE TABLE sales was not found in ${SALES_MIGRATION} — this law had no subject`).not.toBe('');
    expect(collapse(block), 'the sales table must carry PRIMARY KEY (business_id, id), or the inner JOIN can match more than once').toContain(
      'PRIMARY KEY (business_id, id)',
    );
    expect(block, 'and the block must stop before the next table').not.toMatch(/CREATE TABLE (?!sales \()/);
    const occurrences = sql.split('PRIMARY KEY (business_id, id)').length - 1;
    expect(occurrences, 'the same positive control for the location claim as rc_7').toBeGreaterThan(1);
    // The join this key answers for, read from the body rather than assumed.
    const body = collapse(signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM));
    expect(body, 'the body must join sales on exactly that key, or this key is not the one that matters here').toContain(
      'JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id',
    );
  });

  it('rc_12: the routine reads as INVOKER — a definer read would see rows the caller may not', () => {
    // `0084`'s own text calls this out. Under `SECURITY DEFINER` the scan
    // crosses the caller's row security, `v_found` rises to meet `v_asked`,
    // and the report falls silent — while the routine hands back settlement
    // figures for invoices of another business. MEASURED: planting
    // `SECURITY DEFINER` on this routine leaves
    // `scripts/guards/definer-search-path.ts` at exit 0, so nothing else in
    // the tree was holding this for this routine.
    const header = routineHeader(signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM));
    expect(header, 'the routine header is empty — AS $fn$ was not found, so this law had no subject').not.toBe('');
    const definer = /SECURITY\s+DEFINER/i;
    // Positive control: the probe must find it when it is there, or the
    // absence below is a measurement of nothing.
    expect(
      definer.test('LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog'),
      'the SECURITY DEFINER probe cannot see a definer header',
    ).toBe(true);
    expect(definer.test(header), `the array-form header declares SECURITY DEFINER: ${collapse(header).slice(-120)}`).toBe(false);
    expect(header, 'and it must still pin its search_path, which is the other half of a safe read').toMatch(
      /SET\s+search_path\s*=\s*pg_catalog,\s*public,\s*pg_temp/,
    );
  });
});

// ── Section 4. NO LOSS: the count cannot fall short for any other reason ─

describe('section 4: the count cannot fall short except for an id that names no visible invoice', () => {
  it('rc_11: the inner join is TOTAL — sale_id is NOT NULL and the composite edge to sales is VALIDATED', () => {
    // The half the first version of this file left out, and the repo says it
    // in so many words: `0080` refuses to finish unless that edge is
    // `convalidated`, because otherwise «the join below could lose a row». A
    // lost row drives `v_found` below `v_asked` for a reason that is NOT an
    // absent id, and the refusal then rejects a valid request.
    const invoices = sqlLiveCode(join(MIGRATIONS, INVOICES_MIGRATION));
    const block = tableBlock(invoices, 'invoices');
    expect(block, `CREATE TABLE invoices was not found in ${INVOICES_MIGRATION}`).not.toBe('');
    expect(collapse(block), 'invoices.sale_id must be NOT NULL, or an invoice can exist with no sale to join to').toMatch(/sale_id\s+UUID NOT NULL,/);

    // The edge itself, as a whole statement on the composite key.
    const sales = sqlLiveCode(join(MIGRATIONS, SALES_MIGRATION));
    expect(collapse(sales), 'the composite edge to sales must be declared as a whole statement').toMatch(
      /ALTER TABLE invoices ADD CONSTRAINT invoices_sale_fk FOREIGN KEY \(business_id, sale_id\) REFERENCES sales \(business_id, id\);/,
    );
    // Anchored on `ADD CONSTRAINT` and on a whole-word `NOT VALID`, because
    // the first version was a proximity probe and it FIRED on this very file:
    // `0077`'s own refusal message says «invoices_sale_fk would not validate
    // over an empty table», and `sqlLiveCode` strips comment LINES but not
    // string literals. A probe over SQL prose has to be anchored to a
    // statement, or the database's own explanations set it off.
    expect(collapse(sales), 'and it must not be added NOT VALID, which would let an orphan row through').not.toMatch(
      /ADD CONSTRAINT\s+invoices_sale_fk[^;]{0,200}?\bNOT VALID\b/i,
    );

    // And that the edge is asserted VALIDATED at migration time. A FOREIGN KEY
    // that exists but was never validated does not make the join total, which
    // is why the repo checks `convalidated` rather than mere existence.
    const validation = sqlLiveCode(join(MIGRATIONS, VALIDATION_MIGRATION));
    expect(collapse(validation), `${VALIDATION_MIGRATION} must assert the edge is convalidated`).toMatch(/conname = 'invoices_sale_fk'[^;]*c\.convalidated/);
  });

  it('rc_13: no migration later than the ones read here drops or invalidates any of the five', () => {
    // The asymmetry an independent review named: the ROUTINE is resolved by
    // «last definition wins», but the TABLES are read from pinned revision
    // numbers. `0075` and `0077` are below `frozenThrough`, so their own text
    // cannot change — but a LATER candidate migration can `ALTER TABLE … DROP
    // CONSTRAINT`, and `rc_7`, `rc_8` and `rc_11` would stay green reading
    // text that no longer describes the database.
    const undo: { name: string; re: RegExp }[] = [
      { name: 'the invoices primary key', re: /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?invoices_pkey/i },
      { name: 'the sales primary key', re: /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?sales_pkey/i },
      { name: 'the composite edge to sales', re: /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?invoices_sale_fk/i },
      { name: "invoices.sale_id's NOT NULL", re: /ALTER COLUMN\s+sale_id\s+DROP NOT NULL/i },
      // Anchored, for the reason `rc_11` records: the unanchored form fired on
      // `0077`'s own refusal message, «invoices_sale_fk would not validate».
      { name: 'the edge validation', re: /ADD CONSTRAINT\s+invoices_sale_fk[^;]{0,200}?\bNOT VALID\b/i },
    ];
    // POSITIVE CONTROL FIRST: each probe must match a planted statement, or a
    // clean scan below means nothing at all.
    const plants = [
      'ALTER TABLE invoices DROP CONSTRAINT invoices_pkey;',
      'ALTER TABLE sales DROP CONSTRAINT sales_pkey;',
      'ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_sale_fk;',
      'ALTER TABLE invoices ALTER COLUMN sale_id DROP NOT NULL;',
      'ALTER TABLE invoices ADD CONSTRAINT invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) NOT VALID;',
    ];
    undo.forEach((u, i) => {
      expect(new RegExp(u.re.source, 'i').test(plants[i] ?? ''), `the probe for ${u.name} cannot find its own planted statement`).toBe(true);
    });

    const files = migrationFiles();
    expect(files.length, 'the migration scan found no files, so the clean result below is a broken path and not a measurement').toBeGreaterThan(10);
    const found: string[] = [];
    for (const f of files) {
      const sql = sqlLiveCode(join(MIGRATIONS, f));
      for (const u of undo) if (new RegExp(u.re.source, 'i').test(sql)) found.push(`${f} undoes ${u.name}`);
    }
    // DECLARED LIMIT: a legitimate later slice may need to drop and re-add one
    // of these in one migration. That is exactly the change that should be
    // reviewed rather than waved through, so it is required to come back here
    // and say so.
    expect(found, `a later migration undoes a constraint this file's claim rests on: ${JSON.stringify(found)}`).toEqual([]);
  });
});

// ── Section 5. The classification, and the overstatement probe ───────────

describe('section 5: which of these is a detector and which is a preventer, as a checkable table', () => {
  it('rc_9: every pin has a law, every law has a pin, and the refusal is labelled a DETECTOR', () => {
    const source = readFileSync(THIS_FILE, 'utf8');

    // A pin with no law is a claim; a law with no pin is a role nobody stated.
    for (const pin of PINS) {
      expect(source, `PINS names ${pin.law} but this file declares no such law`).toMatch(new RegExp(`it\\('${pin.law}:`));
      expect(['detector', 'preventer'], `${pin.law} carries a role outside the vocabulary`).toContain(pin.role);
      // A preventer that cannot say which direction it bounds is how three
      // constraints came to be called sufficient for a claim needing five.
      if (pin.role === 'preventer') {
        expect(['above', 'below', 'both'], `${pin.law} is a preventer but states no bound`).toContain(pin.bound);
      } else {
        expect(pin.bound, `${pin.law} is a detector; it bounds nothing`).toBeUndefined();
      }
    }
    const declared = [...source.matchAll(/it\('(rc_\d+b?):/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    // The scan has to find the laws, or the emptiness check below is
    // vacuously satisfied by a broken pattern. This is the positive control
    // for a probe whose output is consumed as a set difference.
    expect(declared.length, 'the law-declaration scan found nothing, so the completeness check below measures nothing').toBeGreaterThanOrEqual(PINS.length);
    const pinned = new Set(PINS.map((p) => p.law));
    const unroled = [...new Set(declared)].filter((l) => !pinned.has(l) && !UNPINNED_LAWS.includes(l.replace(/b$/, '')));
    expect(unroled, `these laws pin something whose role PINS does not state: ${JSON.stringify(unroled)}`).toEqual([]);

    // The labelling, which is the thing this card exists to keep honest.
    const roleOf = (law: string) => PINS.find((p) => p.law === law)?.role;
    expect(roleOf('rc_2'), 'reading ROW_COUNT is how the body DETECTS; it bounds nothing').toBe('detector');
    expect(roleOf('rc_3'), 'raising invoice.not_found is a report, not a constraint').toBe('detector');
    expect(roleOf('rc_4'), 'the variable the comparison names is part of the detector').toBe('detector');
    expect(roleOf('rc_4b'), 'and so is the comparison itself').toBe('detector');
    expect(roleOf('rc_5'), 'and the count it is compared against').toBe('detector');
    for (const law of ['rc_6', 'rc_7', 'rc_8', 'rc_11', 'rc_12', 'rc_13']) {
      expect(roleOf(law), `${law} makes a wrong count unrepresentable, which is a different role`).toBe('preventer');
    }

    // BOTH DIRECTIONS must be covered. This is the assertion whose absence let
    // the first version of this file claim a two-sided property from
    // one-sided support.
    const bounds = new Set(PINS.filter((p) => p.role === 'preventer').flatMap((p) => (p.bound === 'both' ? ['above', 'below'] : [p.bound])));
    expect([...bounds].sort(), 'the preventers must bound the count in BOTH directions, or the claim is one-sided').toEqual(['above', 'below']);

    // Counts are MEASURED and pinned deliberately, so that a dropped pin is
    // distinguishable from a renamed one. A new pin must move the number on
    // purpose.
    expect(PINS.filter((p) => p.role === 'detector')).toHaveLength(5);
    expect(PINS.filter((p) => p.role === 'preventer')).toHaveLength(6);
    const detectorTokens = new Set(PINS.filter((p) => p.role === 'detector').map((p) => p.token));
    expect(
      PINS.filter((p) => p.role === 'preventer').filter((p) => detectorTokens.has(p.token)),
      'a token cannot be both',
    ).toEqual([]);
  });

  // The title is phrased «credits … with making … impossible» and not the
  // natural way round for the same reason the probe's own docstring is: the
  // natural phrasing is an instance, and this file is one of the files the
  // probe reads. Two of these rewordings were FORCED by a red run, not
  // foreseen.
  it('rc_10: neither this file nor the migration credits the refusal with making duplication impossible — and the probe finds that claim when it is there', () => {
    // POSITIVE CONTROL FIRST, so the absence below is a measurement and not a
    // broken regular expression reporting zero. These are the sentences the
    // DR-29 review struck out; if the probe cannot see them, the rest of this
    // law is worth nothing.
    const planted = 'The ROW_COUNT check prevents duplicated rows from ever being returned.';
    expect(overstates(planted), 'the probe cannot find the overstatement it exists to forbid — every absence below is vacuous').toBe(true);
    const plantedTwo = 'The invoice.not_found refusal makes it impossible for a row to be multiplied.';
    expect(overstates(plantedTwo), 'and it must find the other phrasing of the same claim').toBe(true);

    // CONTROL IN THE OTHER DIRECTION. The probe must not flag the DENIAL, or
    // the only way to pass this law would be to delete the honest sentence.
    expect(
      overstates('The refusal does not prevent duplication.'),
      'the probe flags a denial as a claim, so it would forbid the sentence this law requires',
    ).toBe(false);

    // Now the absence, in this file's own claim and in the migration.
    const source = readFileSync(THIS_FILE, 'utf8').split(planted).join(' ').split(plantedTwo).join(' ');
    expect(overstates(source), "this file's own prose overstates the refusal — that is the defect this card retired").toBe(false);
    const { file, sql } = lastDefining(ARRAY_FORM);
    expect(overstates(readFileSync(join(MIGRATIONS, file), 'utf8')), `${file} credits the refusal with making duplication impossible`).toBe(false);
    expect(sql, 'and the body must still be the one this law read').toMatch(/ROW_COUNT/);

    // DECLARED LIMIT: this pins the WORDING of the claim, not its truth. What
    // makes the claim true is the ten constraint laws above, in both
    // directions, and what makes the detector a detector is that removing it
    // changes no number. Neither of those is checkable from text, and both are
    // stated in this file's header rather than left implicit.
    expect(flattenProse(readFileSync(THIS_FILE, 'utf8')), 'the header must say out loud that the refusal does not prevent duplication').toContain(
      REQUIRED_DENIAL,
    );
  });
});
