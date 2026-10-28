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
 * nothing read that body. MEASURED at the time this file was written:
 * `v_found` had ZERO occurrences in any `.ts` under `tests`, `scripts`,
 * `packages` or `apps`. The refusal's BEHAVIOUR is covered — by
 * `tests/integration/sale-s2-error-contract.test.ts`,
 * `tests/performance/receivables-ar-setbased-equivalence.test.ts`,
 * `tests/security/p4s4-cross-tenant-command-refusal.test.ts` and
 * `tests/security/p4s4-rls-barrier-behaviour.test.ts` — but every one of those
 * needs PostgreSQL. What was missing is a law that runs on text and goes red
 * when the refusal is WEAKENED, and that is all this file is.
 *
 * ── THE CLAIM, STATED SO IT CANNOT BE OVERSTATED LATER ───────────────────
 *
 * THE `ROW_COUNT` REFUSAL IS A DETECTOR AND NOT A PREVENTER. It reports; it
 * does not make a wrong row count impossible. What makes row inflation
 * UNREPRESENTABLE is structural, and it is three constraints and not one:
 *
 *   1. `invoices PRIMARY KEY (business_id, id)` — at most one `invoices` row
 *      per id asked about, so the driving relation cannot duplicate.
 *   2. `sales PRIMARY KEY (business_id, id)` — the body's inner
 *      `JOIN public.sales s ON s.business_id = i.business_id AND s.id =
 *      i.sale_id` is an equi-join onto that key, so it cannot multiply either.
 *   3. `GROUP BY d.invoice_id` in the reducer subquery — `r` holds at most one
 *      row per invoice, so the `LEFT JOIN` onto it cannot multiply.
 *
 * Remove the refusal alone and no sum changes: what is lost is the report that
 * an id named no invoice this caller can see. **THE REFUSAL DOES NOT PREVENT
 * DUPLICATION.** It would catch duplication if duplication were reachable,
 * which is a different sentence, and the DR-29 card was reopened precisely
 * because the stronger sentence had been written once already.
 *
 * Constraint 2 is NOT in the card that commissioned this law. It named the
 * `invoices` key and the `GROUP BY`. The `sales` key was found by measuring
 * the body's join chain, and it is pinned here because WITHOUT IT THE
 * "UNREPRESENTABLE" CLAIM IS INCOMPLETE — a duplicate `sales` row on the same
 * `(business_id, id)` would multiply every invoice row through that join, and
 * then `v_found` would exceed `v_asked` and the refusal would fire on a valid
 * request. A claim pinned at two thirds of its support is the shape of defect
 * this card was opened to retire, so it is pinned at three.
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
 * connection. That the INSTALLED routine refuses what these laws say its
 * source refuses is a DATABASE claim and it is NOT_RUN here; it belongs to the
 * four suites named above. And one further limit, stated rather than left to
 * be discovered: these laws read the migration SOURCE. A database migrated to
 * some earlier revision holds an earlier body, and nothing here measures which
 * revision any given database is at.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');

/** The migration that declares `invoices`. Frozen; read only. */
const INVOICES_MIGRATION = '0075_phase4_customers_invoices_numbering.sql';
/** The migration that declares `sales`. Frozen; read only. */
const SALES_MIGRATION = '0077_phase4_sales_sale_items_sources.sql';

/**
 * The SET-BASED signature, matched as a SIGNATURE and not as a name.
 *
 * Load-bearing: `invoice_outstanding` is OVERLOADED. `0084` defines
 * `(UUID, UUID)` at its §4 — a thin `plpgsql` wrapper that holds no arithmetic
 * and no refusal — and `(UUID, UUID[])` at its §5, which is the one body that
 * holds both. A helper keyed on the NAME would have resolved to whichever
 * `CREATE FUNCTION invoice_outstanding` came first and could have asserted the
 * refusal pair against a wrapper that has never contained it. Measured: the
 * name matches twenty-one lines across the Phase 4 migrations and the wrapper
 * is written BEFORE the array form on purpose (`0084` §4's comment, R-100).
 */
const ARRAY_FORM = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+invoice_outstanding\s*\(\s*p_business_id\s+UUID\s*,\s*p_invoice_ids\s+UUID\[\]\s*\)/g;

/**
 * SQL with its FULL-LINE `--` comments removed, and only those.
 *
 * Only full-line, deliberately: two dashes also occur inside the single-quoted
 * `COMMENT ON` bodies these migrations are full of, and a greedier strip would
 * delete live code that follows one. DECLARED LIMIT, which the presence laws
 * below are written around: a token appearing only in a TRAILING comment would
 * satisfy a presence law here. Every token pinned below is one that means
 * nothing outside code.
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

/**
 * One table's `CREATE TABLE` block, from its header to the `);` in column one
 * that closes it.
 *
 * MEASURED NECESSITY, not tidiness. `PRIMARY KEY (business_id, id)` occurs
 * FOUR times in `0075` — `customers`, `customer_contacts`, `invoices`,
 * `invoice_items` — and TWICE in `0077`. A file-wide `toContain` for that
 * string is therefore satisfied by any one of them and guards NONE of them:
 * drop the key from `invoices` and three other tables keep the law green. This
 * is `populationOf`'s lesson one table later — membership is not location.
 */
function tableBlock(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE ${table} (`);
  if (start === -1) return '';
  const end = sql.indexOf('\n);', start);
  return end === -1 ? '' : sql.slice(start, end + '\n);'.length);
}

/** Whitespace collapsed, so a claim is about the text and not about indentation. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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

/** Every `IF … THEN` condition in a region, as written. */
function ifConditions(region: string): string[] {
  return [...region.matchAll(/\bIF\s+([\s\S]*?)\s+THEN\b/gi)].map((m) => collapse(m[1] ?? ''));
}

type Role = 'detector' | 'preventer';

interface Pin {
  /** The law in this file that holds it. */
  readonly law: string;
  readonly role: Role;
  /** Where it lives — and the point of the table is that these differ. */
  readonly subject: string;
  readonly token: string;
}

/**
 * THE CLASSIFICATION, AS DATA THE LAWS CONSUME.
 *
 * Not prose. A role written in a comment is a role nobody can be held to; this
 * table is read by `rc_9`, which refuses a pin with no law, a law with no pin,
 * a role outside the vocabulary, and — the one that matters — the refusal
 * tokens relabelled as preventers.
 */
const PINS: readonly Pin[] = [
  { law: 'rc_2', role: 'detector', subject: 'the array-form body', token: 'GET DIAGNOSTICS v_found = ROW_COUNT' },
  { law: 'rc_3', role: 'detector', subject: 'the array-form body', token: "RAISE EXCEPTION 'invoice.not_found" },
  { law: 'rc_4', role: 'detector', subject: 'the array-form body', token: 'every IF governing the refusal reads v_found' },
  { law: 'rc_5', role: 'detector', subject: 'the refusal region of the array-form body', token: 'count(*) INTO v_asked over DISTINCT unnest(p_invoice_ids)' },
  { law: 'rc_6', role: 'preventer', subject: 'the reducer subquery of the array-form body', token: 'GROUP BY d.invoice_id' },
  { law: 'rc_7', role: 'preventer', subject: `CREATE TABLE invoices in ${INVOICES_MIGRATION}`, token: 'PRIMARY KEY (business_id, id)' },
  { law: 'rc_8', role: 'preventer', subject: `CREATE TABLE sales in ${SALES_MIGRATION}`, token: 'PRIMARY KEY (business_id, id)' },
];

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

// ── Section 2. The DETECTOR: the pair, and the variable it compares ──────

describe('section 2: the detector pair lives in the array-form body, and compares v_found', () => {
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

  it('rc_3: the body RAISES invoice.not_found, with the error code the contract names', () => {
    const collapsed = collapse(body());
    expect(collapsed, "the refusal must be raised in this body — a caller-side check is not this routine's refusal").toContain(
      "RAISE EXCEPTION 'invoice.not_found",
    );
    expect(collapsed, 'and it must carry P0001, which is what the error contract matches on').toMatch(
      /RAISE EXCEPTION 'invoice\.not_found[^']*'[^;]*USING ERRCODE = 'P0001'/,
    );
  });

  it('rc_4: EVERY IF that governs the refusal reads v_found — the comparison cannot drift to another name', () => {
    // This is the law that catches WEAKENING rather than deletion. Both
    // tokens of `rc_2` and `rc_3` can stay exactly where they are while the
    // comparison is rewritten onto a variable that is always equal to its
    // counterpart, and the refusal then becomes unreachable with nothing
    // removed. So the claim is universally quantified over the conditions in
    // the refusal region, not existentially over one of them.
    const region = refusalRegion(body());
    expect(region, 'the refusal region is empty — GET DIAGNOSTICS was not found, so this law had no subject').not.toBe('');
    const conditions = ifConditions(region);
    expect(conditions.length, 'the refusal must be decided by at least one IF, or there is nothing here to quantify over').toBeGreaterThan(0);
    const blind = conditions.filter((c) => !/\bv_found\b/.test(c));
    expect(blind, `every IF governing the refusal must read v_found; these do not: ${JSON.stringify(blind)}`).toEqual([]);
    // And the refusal is INSIDE that governed region rather than beside it.
    expect(region.indexOf('RAISE EXCEPTION'), 'the RAISE must sit after the comparison it is governed by').toBeGreaterThan(region.search(/\bIF\s/));
  });

  it('rc_5: the count compared against is the DISTINCT ids asked about, so a repeated id is not a refusal', () => {
    // Money-adjacent and not cosmetic: compared against raw `cardinality`
    // alone, `invoice_outstanding(b, ARRAY[a, a])` returns one row for two
    // array entries and would be REFUSED — a valid request rejected, and the
    // open-invoice page is a caller that builds its array from a list.
    const region = collapse(refusalRegion(body()));
    expect(region, 'the distinct count must be taken over the array itself').toMatch(/SELECT DISTINCT x\.id FROM pg_catalog\.unnest\(p_invoice_ids\)/);
    expect(region, 'and it must be what the refusal compares against').toMatch(/count\(\*\) INTO v_asked/);
    expect(region, 'with the raw cardinality used only as the fast path that cannot refuse on its own').toMatch(
      /IF v_found <> coalesce\(pg_catalog\.cardinality\(p_invoice_ids\), 0\) THEN/,
    );
  });
});

// ── Section 3. The PREVENTERS, each read inside its own subject ──────────

describe('section 3: row inflation is unrepresentable, and these are the three constraints that make it so', () => {
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
    expect(tableBlock(sql, 'invoices'), 'and the block must stop before the next table, or the scoping is nominal').not.toContain('CREATE TABLE invoice_items');
  });

  it('rc_8: sales is keyed on (business_id, id) too — the join the card did not name', () => {
    const sql = sqlLiveCode(join(MIGRATIONS, SALES_MIGRATION));
    const block = tableBlock(sql, 'sales');
    expect(block, `CREATE TABLE sales was not found in ${SALES_MIGRATION} — this law had no subject`).not.toBe('');
    expect(collapse(block), 'the sales table must carry PRIMARY KEY (business_id, id), or the inner JOIN can multiply every invoice row').toContain(
      'PRIMARY KEY (business_id, id)',
    );
    expect(block, 'and the block must stop before the next table').not.toMatch(/CREATE TABLE (?!sales \()/);
    // The join this key answers for, read from the body rather than assumed.
    const body = collapse(signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM));
    expect(body, 'the body must join sales on exactly that key, or this key is not the one that matters here').toContain(
      'JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id',
    );
  });
});

// ── Section 4. The classification, and the overstatement probe ───────────

describe('section 4: which of these is a detector and which is a preventer, as a checkable table', () => {
  it('rc_9: every pin has a law, every law has a pin, and the refusal is labelled a DETECTOR', () => {
    const source = readFileSync(THIS_FILE, 'utf8');

    // A pin with no law is a claim; a law with no pin is a role nobody stated.
    for (const pin of PINS) {
      expect(source, `PINS names ${pin.law} but this file declares no such law`).toMatch(new RegExp(`it\\('${pin.law}:`));
      expect(['detector', 'preventer'], `${pin.law} carries a role outside the vocabulary`).toContain(pin.role);
    }
    const declared = [...source.matchAll(/it\('(rc_\d+)[b]?:/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    // The scan has to find the laws, or the two emptiness checks below are
    // both vacuously satisfied by a broken pattern. This is the positive
    // control for a probe whose output is consumed as a set difference.
    expect(declared.length, 'the law-declaration scan found nothing, so the completeness checks below measure nothing').toBeGreaterThanOrEqual(PINS.length);
    const pinned = new Set(PINS.map((p) => p.law));
    // `rc_1` resolves the subject, `rc_9` and `rc_10` are about the table
    // itself; the rest are the pins. Anything else is a law whose role was
    // never stated.
    const unroled = [...new Set(declared)].filter((l) => !pinned.has(l) && !['rc_1', 'rc_9', 'rc_10'].includes(l));
    expect(unroled, `these laws pin something whose role PINS does not state: ${JSON.stringify(unroled)}`).toEqual([]);

    // The labelling, which is the thing this card exists to keep honest.
    const roleOf = (law: string) => PINS.find((p) => p.law === law)?.role;
    expect(roleOf('rc_2'), 'reading ROW_COUNT is how the body DETECTS; it prevents nothing').toBe('detector');
    expect(roleOf('rc_3'), 'raising invoice.not_found is a report, not a constraint').toBe('detector');
    expect(roleOf('rc_4'), 'the comparison is part of the detector').toBe('detector');
    expect(roleOf('rc_5'), 'the count compared against is part of the detector too').toBe('detector');
    expect(roleOf('rc_6'), 'GROUP BY makes a second reducer row per invoice unrepresentable').toBe('preventer');
    expect(roleOf('rc_7'), 'the invoices key makes a duplicate driving row unrepresentable').toBe('preventer');
    expect(roleOf('rc_8'), 'the sales key makes a multiplying inner join unrepresentable').toBe('preventer');

    // And the two roles are held by DIFFERENT things, which is the whole
    // distinction: both groups non-empty, and no token in both columns.
    // The counts are MEASURED and pinned deliberately — four parts to the
    // detector (the read, the raise, the variable the comparison names, and
    // the count it is compared against) and three constraints behind the
    // "unrepresentable" claim. A new pin must move the number on purpose,
    // which is the only way a dropped pin is distinguishable from a renamed
    // one.
    expect(PINS.filter((p) => p.role === 'detector')).toHaveLength(4);
    expect(PINS.filter((p) => p.role === 'preventer')).toHaveLength(3);
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
    // makes the claim true is `rc_6`, `rc_7` and `rc_8` — three constraints in
    // three different places — and what makes the detector a detector is that
    // removing it changes no number. Neither of those is checkable from text,
    // and both are stated in this file's header rather than left implicit.
    expect(flattenProse(readFileSync(THIS_FILE, 'utf8')), 'the header must say out loud that the refusal does not prevent duplication').toContain(
      REQUIRED_DENIAL,
    );
  });
});
