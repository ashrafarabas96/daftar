import { createHash } from 'node:crypto';
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
 *   than an id that names no invoice this caller can see. Four things:
 *     5. `invoices.sale_id UUID NOT NULL` together with the VALIDATED
 *        composite edge `invoices_sale_fk (business_id, sale_id) REFERENCES
 *        sales (business_id, id)`, which is what makes the inner join total.
 *        `0080` asserts that edge is `convalidated` at migration time, and its
 *        refusal message says why in so many words: otherwise «the join below
 *        could lose a row».
 *     6. The driving predicate selects on `business_id` and the id array and
 *        on NOTHING ELSE — and so does the `JOIN … ON` arm. A further conjunct
 *        in either place drops a document the merchant can see, and the
 *        routine then answers «does not exist in this business» about the
 *        merchant's own draft or cash sale.
 *     6b. The reducer join is a `LEFT` join. Narrowed to an inner join, every
 *        invoice with no payment allocation and no credit application falls
 *        out, and the merchant's own unpaid invoice comes back as missing.
 *        Named here because a review measured it green, and because `rc_6`'s
 *        `bound` said `above` while this is a bound from BELOW on the same
 *        subject. Both are now carried by the body digest.
 *     7. NOT GUARDED HERE, AND DECLARED FOR THAT REASON: visibility of the
 *        `sales` row must follow visibility of the `invoices` row, or the
 *        inner join is total in the tables and lossy in the slice this caller
 *        can see. It holds today, and by construction rather than by luck —
 *        the two `SELECT` policies are textually identical, the composite edge
 *        forces `s.business_id = i.business_id`, and both tenant edges point
 *        at `businesses (tenant_id, id)`, so `tenant_id` is determined by
 *        `business_id` and the two policy evaluations coincide. No law below
 *        reads any of that. `0086` is a CANDIDATE migration that already
 *        rewrites those policies on both tables, so a later one touching
 *        `sales` alone would break this with every law here green. A guard
 *        over row-security policy equality is a separate card; it is named
 *        here so it is not mistaken for covered.
 *
 * All of these are load-bearing, and only together do they make
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
 * A SECOND review round then found four more of the same kind, every one of
 * them GREEN at 15/15, and they are recorded beside their laws: a DEAD copy of
 * the blessed comparison satisfying a positional check while an `ELSE` arm
 * inverted the refusal (`rc_4b`); a longer `GROUP BY` key multiplying the
 * driving row so a fully paid invoice reappeared on the customer's
 * receivables at its full value (`rc_6`); an extra `WHERE` conjunct refusing a
 * visible document as missing (`rc_6b`); `v_asked` pinned at zero by a
 * `WHERE false` in a subquery whose link to it was never asserted (`rc_4b`);
 * and the honesty assertion itself passing with its sentence deleted, because
 * it searched the whole file for a string this file declares (`rc_10`).
 *
 * The pattern across all three rounds is one thing: each round pinned one more
 * FEATURE of a sequence and the unpinned remainder carried the kill. That is
 * why `rc_4b` is now a whole-shape pin and not a feature test.
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
const ARRAY_FORM =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\(\s*\w+\s+UUID\s*,\s*\w+\s+UUID\s*\[\s*\]\s*\)/gi;

/**
 * The SCALAR signature — the `(UUID, UUID)` wrapper.
 *
 * The two overloads are told apart by `UUID[]` against `UUID`, not by the
 * parameter NAMES, which is why both patterns take `\w+` there. Round five
 * measured why that matters: `CREATE OR REPLACE` cannot rename a parameter
 * (PostgreSQL refuses with `42P13`), so a rewrite has to DROP first — and a
 * recreate with renamed parameters then slipped past a resolver keyed on
 * `p_invoice_ids`, leaving every digest here measuring a body the database no
 * longer had. Measured: exactly one `CREATE` of each signature in `0084`.
 */
const SCALAR_FORM =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\(\s*\w+\s+UUID\s*,\s*\w+\s+UUID\s*\)/gi;

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
    const raw = readFileSync(join(MIGRATIONS, file), 'utf8');
    // The DECISION is made on the lexer's code view, where string bodies are
    // absent; the SLICE is taken from `sqlLiveCode`, which keeps the routine
    // body and its `$fn$;` terminator. The asymmetry is deliberate: a
    // `COMMENT ON` body that quotes a `CREATE FUNCTION invoice_outstanding(…)`
    // signature — ordinary prose, and this file is full of such comments —
    // used to move this resolver onto that migration and redden fifteen laws.
    // It failed closed, so it was safe, but a guard that reddens on a comment
    // is a guard someone turns off.
    if (new RegExp(re.source, re.flags).test(sqlCodeOnly(raw))) found = { file, sql: sqlLiveCode(join(MIGRATIONS, file)) };
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
  // `re.flags` and not a hard-coded `'g'`: dropping the pattern's own flags
  // is how the resolver came to be case-sensitive about a case-insensitive
  // language. `matchAll` requires `g`, which both patterns carry.
  const all = [...sql.matchAll(new RegExp(re.source, re.flags))];
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
 * The characters between the `$fn$` quotes, with comments stripped and
 * whitespace collapsed.
 *
 * Normalised and not raw, deliberately: reindenting the body or rewording a
 * comment inside it is not a money change and should not redden a money law,
 * while every change to the CODE does. Comments are stripped rather than kept
 * for the DR-13 reason — a rule left in a comment is not the rule.
 */
function normalisedBody(body: string): string {
  const open = body.indexOf('$fn$');
  if (open === -1) return '';
  const close = body.indexOf('$fn$', open + 4);
  if (close === -1) return '';
  return collapse(
    body
      .slice(open + 4, close)
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n'),
  );
}

/**
 * THE WHOLE BODY, PINNED BY DIGEST. Measured from the tree, not chosen.
 *
 * This is where three rounds of review end up, and the house already knew the
 * answer: `scripts/guards/p4s7-body-digests.ts` pins whole routine bodies by
 * `sha256`, and its own docstring states the lesson these rounds rediscovered
 * — «a digest list that covers some of the routines is worse than none: the
 * uncovered one can be replaced by a conforming stub.» MEASURED: that guard
 * covers the four installment triggers and `customer_ar_aging` and mentions
 * `invoice_outstanding` ZERO times, so nothing was pinning this body.
 *
 * Why a digest rather than one more feature. Rounds one and two each pinned
 * one more feature of the refusal tail; round three then found four kills
 * OUTSIDE the tail — a later migration redefining the routine under a
 * schema-qualified name, a conjunct appended to the `JOIN … ON` arm,
 * a `RETURN QUERY … WHERE false` inserted just above the `GET DIAGNOSTICS`
 * that counts its rows, and `LEFT JOIN` narrowed to `JOIN` so every invoice
 * with no payment allocation drops out. All four were GREEN. A digest has no
 * remainder to move into, and that is the only honest version of the claim the
 * previous commit message overstated.
 *
 * DECLARED COST, and it is larger than the tail-only pin's: ANY change to this
 * body's code reddens this law, INCLUDING the extension `0084`'s own comment
 * anticipates — «Replaced by the slice that adds a reducer relation, which
 * appends one UNION ALL branch.» That slice must come back here, re-pin the
 * digest and re-run the red proofs. For the one definition of the settlement
 * sum, in a candidate migration, that is the double review the governance
 * requires anyway; and it is exactly how the neighbouring digest guard already
 * behaves.
 */
const PINNED_BODY_SHA256 = '300725d4696a75cb38c71c817aa697368ddcf0b6c8bf7db9a1cd9a5f8da84ce7';
/** Its normalised length, so a digest mismatch can say whether the body grew or shrank. */
const PINNED_BODY_CHARS = 1885;

/**
 * THE DECLARATION, pinned the same way and for the same reason.
 *
 * The body digest was round three's answer and round four found its remainder:
 * `normalisedBody` slices BETWEEN the `$fn$` quotes, so the routine's header —
 * its `RETURNS TABLE` column list and its attributes — was outside the number.
 * MEASURED green at 17/17, each one on its own:
 *   — `paid_txn_minor` and `outstanding_txn_minor` swapped in `RETURNS TABLE`.
 *     Two columns of the same type, so nothing else complains, and every
 *     consumer reads BY NAME: a fully paid invoice then reports its full value
 *     as outstanding and an unpaid one reports zero. This is the same silent
 *     inversion as the `GROUP BY` hole, one line higher up.
 *   — `due_date` and `issue_date` swapped, so DR-13's
 *     `coalesce(o.due_date, o.issue_date)` ages every document by the wrong
 *     date.
 *   — `STABLE` weakened to `VOLATILE`.
 * So the pin is over the declaration as well as the body. Taken together they
 * are the whole `CREATE … $fn$;` statement, and THAT is the thing with no
 * remainder — not the body, which is what the previous commit claimed.
 */
const PINNED_HEADER_SHA256 = '889b888328b293de908eae6050a39193d3e50fa982a4345a12eade635ec9371a';

/**
 * THE SCALAR WRAPPER'S OWN DECLARATION, pinned for the third time in the same
 * shape — and the reason is the same defect at one more remove.
 *
 * Round four pinned the array form's header after `paid_txn_minor` and
 * `outstanding_txn_minor` exchanged places in its `RETURNS TABLE` went green.
 * Round five found the wrapper's `RETURNS TABLE` unpinned and did exactly the
 * same thing to it — MEASURED green at 17/17 — and the wrapper is the form
 * PRODUCTION calls: `receivables-reads.ts:86`, `invoice-reads.ts:249` and
 * `customer-reads.ts:792` all read it as
 * `JOIN LATERAL invoice_outstanding(i.business_id, i.id) o`, BY NAME. One
 * comment there calls it «the ONE definition». So a fully paid invoice would
 * report its full value as outstanding on the path the merchant actually sees,
 * and the wrapper's body — which projects POSITIONALLY — would not notice.
 *
 * `rc_1b` asserts the wrapper DELEGATES; that is a different claim from its
 * columns meaning what they are named.
 */
const PINNED_WRAPPER_HEADER_SHA256 = 'fadca39c3885a9930cab6ef7a7227c06b66ec434c10649db8c25f4f5131ae994';
const PINNED_WRAPPER_HEADER_CHARS = 278;
const PINNED_WRAPPER_BODY_SHA256 = '424e9bfe93072d9be3a18ade7207af6c05b6912c1c792d0905c0c69440e93fd1';
const PINNED_WRAPPER_BODY_CHARS = 188;
/** Its normalised length. */
const PINNED_HEADER_CHARS = 339;

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

// A `governingCondition` helper stood here, resolving the condition that
// governs the raise as the last `IF … THEN` opened before it. It is DELETED
// rather than kept unused, because it was the second round's hole: positional
// resolution is blind to block structure, so a DEAD copy of the blessed
// condition satisfied it while an `ELSE` arm inverted the refusal. `rc_4b`
// pins the tail whole instead, and a helper that cannot express the claim is
// better gone than left for someone to reach for again.

/**
 * ONE STATEMENT OF SQL, as a lexer sees it rather than as a regex guesses it.
 *
 * `code` is the statement with comments blanked and string BODIES removed, so
 * a probe reads code and never prose. `strings` carries those bodies, so DDL
 * built inside `EXECUTE '…'` can be read as SQL in its own right.
 */
interface SqlStatement {
  readonly code: string;
  readonly strings: readonly string[];
}

/**
 * THE SQL SCANNER, AND WHY IT IS A WALKER AND NOT A PATTERN.
 *
 * Rounds seven and eight ended with probes that stripped comments with a
 * regular expression and split on `;`. Round nine measured two ways that reads
 * this project's SQL WRONGLY, on legal input, and one of them needs nothing
 * written by an attacker at all:
 *
 *   1. PostgreSQL NESTS block comments. A non-greedy `/*…*\/` strip stops at
 *      the first close, so `/* a /* b *\/ c *\/` leaves ` c *\/` between the
 *      keyword and the name: every probe blind, every digest still matching,
 *      and the one definition of the settlement sum replaced by a body with no
 *      refusal. Verified legal on PostgreSQL 16.15, where the replacement won.
 *   2. Stripping `--` to end of line deletes the `;` that ENDS a statement when
 *      the `--` sits inside a quoted string. `0085` ALREADY SHIPS
 *      `E'\n--8<--\n'` followed by `;`, so a later `DROP` was glued onto the
 *      previous fragment and no longer began with `DROP`. No comment of the
 *      attacker's own was required.
 *
 * Both are one mistake: reasoning about characters instead of lexical state.
 * So this walks the text once, in states — line comments, NESTED block
 * comments, single quotes with `''`, `E'…'` backslash escapes, double-quoted
 * identifiers, and dollar quoting with any tag, whose bodies contain `;`
 * freely.
 *
 * AND IT REPORTS WHAT IT CANNOT TOKENIZE. That is the part that makes this the
 * end of the regress rather than one more round of it: an unbalanced comment or
 * an unterminated literal is NAMED, and `rc_13` fails on it, because a file
 * this cannot read is a file whose statements it must not pretend to know. Nine
 * rounds of this card were spent discovering that a scanner which guesses on
 * input it does not understand will always have one more spelling left.
 */
function scanSql(sql: string): { statements: readonly SqlStatement[]; problems: readonly string[] } {
  const statements: SqlStatement[] = [];
  const problems: string[] = [];
  let code = '';
  let strings: string[] = [];

  const flush = () => {
    if (code.trim() !== '' || strings.length > 0) statements.push({ code, strings });
    code = '';
    strings = [];
  };

  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);

    // A line comment runs to the end of the line — and the newline is LEFT for
    // the default branch, so a `;` on a later line still ends its statement.
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      code += ' ';
      i = nl;
      continue;
    }

    // A block comment, counted by DEPTH, because PostgreSQL nests them.
    if (two === '/*') {
      const start = i;
      let depth = 0;
      while (i < n) {
        if (sql.slice(i, i + 2) === '/*') {
          depth += 1;
          i += 2;
        } else if (sql.slice(i, i + 2) === '*/') {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      if (depth !== 0) {
        problems.push(`an unterminated block comment opens at offset ${start}`);
        break;
      }
      code += ' ';
      continue;
    }

    // Dollar quoting, with any tag. Its body may hold `;`, `--` and `/*`.
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) {
        problems.push(`an unterminated dollar-quoted string ${JSON.stringify(tag)} opens at offset ${i}`);
        break;
      }
      strings.push(sql.slice(i + tag.length, end));
      code += "''";
      i = end + tag.length;
      continue;
    }

    // A single-quoted string: `''` is an escaped quote, and in `E'…'` a
    // backslash escapes the next character.
    if (sql[i] === "'") {
      const isEscapeString = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? ' ');
      let j = i + 1;
      let body = '';
      let closed = false;
      while (j < n) {
        if (isEscapeString && sql[j] === '\\') {
          body += sql[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            body += "'";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        body += sql[j];
        j += 1;
      }
      if (!closed) {
        problems.push(`an unterminated string literal opens at offset ${i}`);
        break;
      }
      strings.push(body);
      code += "''";
      i = j;
      continue;
    }

    // A double-quoted identifier is KEPT in `code`: the name is the subject.
    if (sql[i] === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) {
        problems.push(`an unterminated quoted identifier opens at offset ${i}`);
        break;
      }
      code += sql.slice(i, j);
      i = j;
      continue;
    }

    if (sql[i] === ';') {
      flush();
      i += 1;
      continue;
    }

    code += sql[i];
    i += 1;
  }
  flush();
  return { statements, problems };
}

/**
 * Every statement of a migration, plus the statements of any SQL it BUILDS AS
 * A STRING — one level of `EXECUTE '…'`.
 *
 * Measured necessity: `DO $m$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION
 * public.invoice_outstanding(…)'; END $m$;` replaced the routine with the suite
 * green, because the outer statement begins with `DO` and the DDL lives in a
 * string. One level, and the limit is declared rather than left to be found:
 * `EXECUTE format('… %I …', 'invoice_outstanding')` assembles the name at RUN
 * time and no text scanner can see it. `rc_13` says so in its own comment.
 */
function sqlStatementsDeep(sql: string, depth = 0): { statements: readonly SqlStatement[]; problems: readonly string[] } {
  const top = scanSql(sql);
  const statements = [...top.statements];
  const problems = [...top.problems];
  // Three levels, because the real shape is two deep and one spare is cheap:
  // `DO $mig$ BEGIN EXECUTE 'DROP FUNCTION …'; END $mig$;` puts the DDL inside
  // a single-quoted string inside a dollar-quoted body. Measured: with one
  // level, that drop was green.
  if (depth >= 3) return { statements, problems };
  for (const statement of top.statements) {
    for (const body of statement.strings) {
      // ONLY strings on an EXECUTE path, and the test is on the BODY as well as
      // on the parent, because the two levels differ: in
      // `DO $mig$ BEGIN EXECUTE '…'; END $mig$;` the outer statement's code is
      // just `DO ''` — the `EXECUTE` is inside the dollar-quoted body — while
      // one level down the parent code is the `EXECUTE` and the body is the DDL.
      //
      // Descending into every string that merely mentions `CREATE` was the
      // first attempt and it CRIED WOLF: a `COMMENT ON` body saying «CREATE
      // FUNCTION invoice_outstanding(…) was retired» became a phantom
      // statement and reddened fifteen laws. Prose about a routine is not a
      // change to it, and a guard that cannot tell the difference is one that
      // gets switched off. Neither that body nor its parent says `EXECUTE`.
      // Descend when the PARENT is an executable statement, not when the
      // word `EXECUTE` happens to appear. PL/pgSQL runs DDL inside
      // `DO $$ … $$;` with no `EXECUTE` keyword at all, and `0073` ALREADY
      // SHIPS `ALTER TABLE … FORCE ROW LEVEL SECURITY;` that way — so the
      // `EXECUTE` gate missed the SIMPLEST form of the kill while closing the
      // more elaborate one. Measured: a `DO $mig$ … $mig$;` dropping and
      // re-creating the routine in plain text was green at 19/19.
      //
      // The cry-wolf case is told apart by the parent's VERB, which is what it
      // always was: `DO` executes its body, `COMMENT ON` describes something.
      // A comment body quoting `CREATE FUNCTION invoice_outstanding(…)` has a
      // parent of `COMMENT ON` and is still not descended.
      const executableParent = /^\s*DO\b/i.test(statement.code) || /\bEXECUTE\b/i.test(statement.code) || /\bEXECUTE\b/i.test(body);
      if (!executableParent) continue;
      if (!/\b(?:CREATE|DROP|ALTER|EXECUTE)\b/i.test(body)) continue;
      const inner = sqlStatementsDeep(body, depth + 1);
      statements.push(...inner.statements);
      // An unparsable inner string is prose, not a defect in the migration, so
      // its problems are not escalated — the outer scan is what must be sound.
    }
  }
  return { statements, problems };
}

/** The last dotted segment of a possibly-qualified, possibly-quoted identifier. */
function bareName(ident: string): string {
  const last = ident.split('.').pop() ?? '';
  return last.replace(/"/g, '').trim().toLowerCase();
}

/**
 * Does any statement CREATE a routine whose own name is `routine`?
 *
 * The NAME BEING CREATED, parsed, and not mere containment — this is the one
 * place where containment would cry wolf, and that is measured, not feared:
 * SEVEN statements in `0075`, `0083` and `0084` create `customer_ar_outstanding`,
 * `customer_ar_aging` and `customer_ar_open_document_counts`, each of which
 * READS `invoice_outstanding` in its body. A later slice adding another such
 * reader is ordinary work — DR-29 added the third — and a guard that reddened
 * on it would be switched off within a week. `rc_13` asserts that negative
 * control directly.
 *
 * The qualified name tolerates whitespace around its dots, because
 * `public . invoice_outstanding` is one legal identifier and round nine
 * measured the tighter `[\w".]+` capturing `public` and never seeing the name.
 */
function createsRoutineNamed(sql: string, routine: string): boolean {
  const header = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|ROUTINE|PROCEDURE)\s+((?:[\w"]+\s*\.\s*)*[\w"]+)/i;
  return sqlStatementsDeep(sql).statements.some((statement) => {
    const m = header.exec(statement.code);
    return m?.[1] !== undefined && bareName(m[1]) === routine;
  });
}

/**
 * Does any statement of `verb` NAME this routine anywhere in itself?
 *
 * Containment is safe for `DROP` and `ALTER` and only for them: neither carries
 * a routine body, so the only identifiers in such a statement are its targets.
 * That is what lets one probe cover a multi-target drop, a quoted name,
 * argument names in the signature, and any type spelling at once.
 */
function statementTouchesRoutine(sql: string, verb: RegExp, routine: string): boolean {
  const named = new RegExp(`\\b${routine}\\b`, 'i');
  return sqlStatementsDeep(sql).statements.some((statement) => verb.test(statement.code) && named.test(statement.code));
}

/**
 * Every statement's CODE, joined — the successor to the regex comment strip the
 * message-provider rows used to read.
 *
 * Built on the lexer for the same reason those rows existed to be fixed: a
 * block comment with a parenthesis in it, or a nested one, or a `--` inside a
 * shipped string literal, all read wrongly without lexical state. String
 * bodies are absent from this view, so a `COMMENT ON` body can neither
 * trigger a probe nor hide one.
 */
function sqlCodeOnly(sql: string): string {
  return sqlStatementsDeep(sql)
    .statements.map((statement) => statement.code)
    .join(';');
}

/** Everything the scanner could not tokenize, which `rc_13` refuses to scan past. */
function sqlScanProblems(sql: string): readonly string[] {
  return sqlStatementsDeep(sql).problems;
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

/**
 * This file's opening comment block, and nothing after it.
 *
 * `rc_10` has to read the HEADER rather than the source, because the sentence
 * it requires is also a string constant declared below — so a search of the
 * whole file is satisfied by the declaration and passes with the header
 * deleted. Measured: it did.
 */
function fileHeader(): string {
  const src = readFileSync(THIS_FILE, 'utf8');
  // THE FIRST BLOCK COMMENT, and nothing else. Slicing at `const REPO_ROOT`
  // was the previous attempt and a review walked through it: declare
  // `const DENIAL_TEXT = '…';` ABOVE that line and the slice contains the
  // sentence again, so the honesty law passes with the prose deleted. The
  // first `*/` is a boundary nothing can be declared inside.
  const open = src.indexOf('/**');
  if (open === -1) return '';
  const close = src.indexOf('*/', open);
  return close === -1 ? '' : src.slice(open, close + 2);
}

type Role = 'detector' | 'preventer' | 'backstop';
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
  // The backstop. It pins no single constraint — it pins the whole
  // declaration, header and body, so MOST of the entries below are
  // consequences of it. Not all, and the earlier wording «every other entry
  // below is a CONSEQUENCE of it» was measured false, but so was this
  // paragraph's first correction of it: `rc_12` IS a consequence — planting
  // `SECURITY DEFINER` in `0084`'s header reddens `rc_4c` and `rc_12`
  // together. What sees a LATER `ALTER` is `rc_13`, whose rows read other
  // files, as do `rc_7`, `rc_8` and `rc_11`. Those four are the exceptions.
  // Recorded rather than quietly rewritten because the wrong version invited
  // a reader to delete `rc_13`'s routine rows as duplicates of a law that
  // cannot see what they see. The consequences are kept for
  // their failure messages: a digest mismatch says the declaration moved, and
  // they say which part. Counted as its own role rather than squeezed into
  // the other two, because calling a digest a `detector` or a `preventer`
  // would be the kind of imprecision this table exists to prevent.
  { law: 'rc_4c', role: 'backstop', subject: 'the whole array-form declaration', token: 'sha256 of the normalised header and body' },
  { law: 'rc_2', role: 'detector', subject: 'the array-form body', token: 'GET DIAGNOSTICS v_found = ROW_COUNT' },
  { law: 'rc_3', role: 'detector', subject: 'the array-form body', token: "RAISE EXCEPTION 'invoice.not_found … P0001" },
  { law: 'rc_4', role: 'detector', subject: 'the array-form body', token: 'every IF governing the refusal reads v_found' },
  { law: 'rc_4b', role: 'detector', subject: 'the refusal region of the array-form body', token: 'the whole refusal tail, pinned as one statement sequence' },
  { law: 'rc_5', role: 'detector', subject: 'the refusal region of the array-form body', token: 'count(*) INTO v_asked over DISTINCT unnest(p_invoice_ids)' },
  {
    law: 'rc_6',
    role: 'preventer',
    bound: 'both',
    subject: 'the reducer subquery of the array-form body',
    token: 'GROUP BY d.invoice_id, and LEFT, and nothing else',
  },
  {
    law: 'rc_6b',
    role: 'preventer',
    bound: 'below',
    subject: 'the driving predicate of the array-form body',
    token: 'WHERE business_id and the id array alone',
  },
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
  {
    law: 'rc_13',
    role: 'preventer',
    bound: 'both',
    subject: 'every migration the lexer can read',
    token: 'nothing later drops, renames or redefines, bar a run-time-assembled name',
  },
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
    const arrayBody = signatureBody(sql, ARRAY_FORM);
    const scalarBody = signatureBody(sql, SCALAR_FORM);
    expect(scalarBody, 'the scalar wrapper must be present, or this control proves nothing').not.toBe('');
    expect(scalarBody).not.toBe(arrayBody);
    expect(scalarBody, 'the wrapper holds no arithmetic and no refusal — if it did, the two would not be distinguishable by this means').not.toMatch(
      /ROW_COUNT/,
    );
    expect(arrayBody, 'and the array form is where the refusal lives').toMatch(/ROW_COUNT/);
    // AND THE WRAPPER MUST DELEGATE. Round four measured why: re-creating the
    // scalar form in a later migration with its own inline query — no call to
    // the array form, no refusal — left the suite GREEN at 17/17, and the
    // scalar form is the one three production readers call, by
    // `JOIN LATERAL invoice_outstanding(i.business_id, i.id)`. Its refusal is
    // entirely BORROWED from this delegation, so the delegation is the law.
    expect(collapse(scalarBody), 'the scalar wrapper must delegate to the array form — its refusal is borrowed, not its own').toMatch(
      /FROM public\.invoice_outstanding\(p_business_id, ARRAY\[p_invoice_id\]\)/,
    );
  });

  it('rc_1c: the wrapper DECLARATION is pinned by digest too — it is the form production calls', () => {
    // Round five's blocker. The array form's header was pinned in round four
    // because two same-typed columns exchanged in its `RETURNS TABLE` invert
    // paid and outstanding for every consumer that reads by name. The wrapper
    // has a `RETURNS TABLE` of its own, it was unpinned, and the same swap on
    // it was MEASURED green at 17/17 — on the form three production readers
    // actually call. Its body projects POSITIONALLY
    // (`SELECT o.paid_txn_minor, …`), so the body notices nothing.
    const wrapper = signatureBody(lastDefining(ARRAY_FORM).sql, SCALAR_FORM);
    expect(wrapper, 'the scalar wrapper did not slice, so both digests below would be of empty strings').not.toBe('');

    const header = collapse(routineHeader(wrapper));
    expect(header.startsWith('CREATE'), 'the wrapper header slice must start at its CREATE').toBe(true);
    expect(
      createHash('sha256').update(header, 'utf8').digest('hex'),
      `the wrapper DECLARATION changed. Normalised length ${header.length} against the pinned ${PINNED_WRAPPER_HEADER_CHARS}.
` +
        `It reads: ${header}
` +
        `Three API readers select from this by column NAME, so exchanging two same-typed columns here inverts paid and outstanding for the merchant.`,
    ).toBe(PINNED_WRAPPER_HEADER_SHA256);
    expect(header.length, 'the wrapper header length must match the pinned one').toBe(PINNED_WRAPPER_HEADER_CHARS);

    const body = normalisedBody(wrapper);
    expect(body, 'the wrapper body did not slice between its $fn$ quotes').not.toBe('');
    expect(
      createHash('sha256').update(body, 'utf8').digest('hex'),
      `the wrapper BODY changed. Normalised length ${body.length} against the pinned ${PINNED_WRAPPER_BODY_CHARS}.
` +
        `It reads: ${body}
` +
        `This body projects positionally, so a reordering here is invisible to its own column names.`,
    ).toBe(PINNED_WRAPPER_BODY_SHA256);
    expect(body.length, 'the wrapper body length must match the pinned one').toBe(PINNED_WRAPPER_BODY_CHARS);
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

  it('rc_4b: the whole refusal tail is pinned as ONE statement sequence, because every looser form was evaded', () => {
    // THIS LAW IS A WHOLE-SHAPE PIN, AND IT GOT THERE BY LOSING TWICE.
    //
    // Round one quantified over WHICH VARIABLE the governing comparison reads.
    // `IF v_found > v_asked` stayed green and made the refusal unreachable;
    // `<=` and `IS NOT NULL` stayed green and made it refuse a repeated id.
    //
    // Round two quantified over the OPERATOR, resolving the governing
    // condition positionally as the last `IF` opened before the raise. That is
    // blind to block structure, so a DEAD copy of the blessed condition
    // satisfied it. Both of these were MEASURED green at 15/15:
    //   IF v_found <> v_asked THEN NULL; ELSE RAISE …; END IF;
    //   IF v_found <> v_asked THEN NULL; END IF; RAISE …;
    // The first inverts the refusal — a repeated id is rejected AND a missing
    // id passes in silence. The second raises unconditionally.
    // And a third, `rc_5`'s half: the distinct subquery and the assignment to
    // `v_asked` were asserted as two independent fragments, never as one
    // statement, so `… AS x(id) WHERE false) k;` stayed green with `v_asked`
    // pinned at zero — losing the refusal in exactly the case it exists for.
    //
    // Round three then showed that pinning the TAIL was still a feature pin,
    // because the tail is not the routine. Four more kills, all GREEN at
    // 16/16, all OUTSIDE the pinned region:
    //   — a later migration redefining the routine as
    //     `CREATE FUNCTION public.invoice_outstanding(…)`, which the resolver's
    //     unqualified pattern did not see, so all sixteen laws went on reading
    //     `0084`'s superseded body;
    //   — `AND s.settlement_mode <> 'cash'` appended to the `JOIN … ON` arm,
    //     which drops a visible document and refuses it as missing;
    //   — `RETURN QUERY SELECT … WHERE false;` inserted immediately above the
    //     `GET DIAGNOSTICS` that counts its rows, so `v_found` is zero and
    //     every non-empty call raises;
    //   — `LEFT JOIN (` narrowed to `JOIN (`, so every invoice with no payment
    //     allocation and no credit application falls out of the result and the
    //     merchant's own unpaid invoice comes back «does not exist».
    //
    // THE LESSON, and it is the honest version of what the previous commit
    // message overstated. Pinning the tail did not remove the remainder; it
    // MOVED it. Each round pinned one more feature and the unpinned rest
    // carried the next kill. What has no remainder is a digest of the whole
    // body — which is what `PINNED_BODY_SHA256` is, and what the neighbouring
    // `p4s7-body-digests` guard already does for five other routines.
    //
    // This law is now the READABLE half of that pin: it keeps the tail's shape
    // so that a mismatch says WHAT changed rather than only that something
    // did. `rc_4c` is the half that cannot be evaded. Both are kept on purpose
    // — the digest is the law, this is the error message.
    const region = collapse(refusalRegion(body()));
    expect(region, 'the refusal region is empty, so this law had no subject').not.toBe('');
    expect(
      region,
      `the refusal tail does not match its pinned shape. It reads:\n  ${region}\nEvery looser form of this law was evaded by an edit that left the refusal unreachable or firing on a valid request, so the sequence is pinned whole`,
    ).toMatch(
      /^GET DIAGNOSTICS v_found = ROW_COUNT; IF v_found <> coalesce\(pg_catalog\.cardinality\(p_invoice_ids\), 0\) THEN SELECT pg_catalog\.count\(\*\) INTO v_asked FROM \(SELECT DISTINCT x\.id FROM pg_catalog\.unnest\(p_invoice_ids\) AS x\(id\)\) k; IF v_found (?:<>|!=) v_asked THEN RAISE EXCEPTION 'invoice\.not_found[^']*' USING ERRCODE = 'P0001'; END IF; END IF; END; \$fn\$;$/,
    );
  });

  it('rc_4c: the WHOLE declaration is pinned by digest — header and body, so nothing inside the RESOLVED declaration is left unpinned', () => {
    // The law with no remainder INSIDE the declaration it resolves, now over
    // the whole `CREATE … $fn$;` and not only the part between the dollar
    // quotes. The qualifier is load-bearing and was added after a review
    // measured the obvious gap in the stronger claim: a digest says nothing
    // about a LATER migration replacing the routine, so resolution is its own
    // remainder and `rc_13`'s routine rows are what cover it — not this law. Most of what `rc_2` through
    // `rc_6b` and `rc_12` assert is a consequence of this; they exist for
    // their failure messages. `rc_7`, `rc_8`, `rc_11` and `rc_13` are NOT
    // consequences — they read other files. `rc_12` IS one, and the previous
    // wording that said otherwise was measured false: planting
    // `SECURITY DEFINER` in `0084`'s header reddens `rc_4c` AND `rc_12`
    // together, while a later `ALTER FUNCTION … SECURITY DEFINER` reddens
    // `rc_13` ALONE and leaves `rc_12` green. What sees a later `ALTER` is
    // `rc_13`, not `rc_12` — and saying otherwise invited a future reader to
    // delete those rows as duplicates of a law that cannot see what they see.
    //
    // THE HEADER FIRST, because it is the remainder round four found.
    const header = collapse(routineHeader(body()));
    expect(header, 'the routine header did not slice, so the digest below would be of an empty string').not.toBe('');
    expect(header.startsWith('CREATE'), 'the header slice must start at the CREATE, or it is not the declaration').toBe(true);
    const headerDigest = createHash('sha256').update(header, 'utf8').digest('hex');
    expect(
      headerDigest,
      `the DECLARATION of invoice_outstanding(UUID, UUID[]) changed. Normalised length ${header.length} against the pinned ${PINNED_HEADER_CHARS}.
` +
        `It reads: ${header}
` +
        `This covers the RETURNS TABLE column list and the routine's attributes. Two columns of the same type swapped here invert paid and outstanding for every consumer that reads by name, and nothing else in the tree complains.`,
    ).toBe(PINNED_HEADER_SHA256);
    expect(header.length, 'the normalised header length must match the pinned one').toBe(PINNED_HEADER_CHARS);

    const normalised = normalisedBody(body());
    expect(normalised, 'the body did not slice between its $fn$ quotes, so the digest below would be of an empty string').not.toBe('');
    expect(normalised.length, 'the normalised body is too short to be this routine — the slice is wrong, not the routine').toBeGreaterThan(800);

    const digest = createHash('sha256').update(normalised, 'utf8').digest('hex');
    expect(
      digest,
      `the body of invoice_outstanding(UUID, UUID[]) CHANGED. Normalised length ${normalised.length} against the pinned ${PINNED_BODY_CHARS}.\n` +
        `This is the one definition of the settlement sum, so the change is a money change: re-read it, re-pin the digest here, and re-run this file's red proofs.\n` +
        `Comments and indentation inside the body are stripped before hashing, so this did not fire for a reformatting.`,
    ).toBe(PINNED_BODY_SHA256);
    // The length is pinned beside the digest for the same reason the
    // neighbouring guard pins it: a digest tells you something moved, a length
    // tells you whether the body grew or shrank, and the two together make a
    // failure diagnosable rather than merely alarming.
    expect(normalised.length, 'the normalised length must match the pinned one').toBe(PINNED_BODY_CHARS);
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

describe('section 3: the count cannot exceed the distinct ids asked about, and these are the reasons', () => {
  it('rc_6: the reducer groups by invoice and by NOTHING ELSE, so the LEFT JOIN onto it cannot multiply', () => {
    const body = signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM);
    const collapsed = collapse(body);
    // THE GROUP KEY IS PINNED EXACTLY, and the earlier form that merely
    // CONTAINED `GROUP BY d.invoice_id` was the worst hole an independent
    // review found in this file. MEASURED green at 15/15:
    // `GROUP BY d.invoice_id, d.amount`. One extra column and `r` holds a row
    // per ALLOCATION, so the LEFT JOIN multiplies the driving row: an invoice
    // of 1,000 with allocations of 300 and 700 returns TWO rows, outstanding
    // 700 and 300. `customer_ar_outstanding` sums them to 1,000, so a FULLY
    // PAID invoice reappears on the customer's receivables at its full value,
    // `HAVING sum <> 0` does not hide it, and conservation breaks —
    // paid 1,000 + outstanding 1,000 against a total of 1,000.
    // It was silent, too: `v_found` exceeds `v_asked`, which the refusal
    // reports only because its operator is `<>` and not `<`. That is the
    // other half of why `rc_4b` no longer accepts `<`.
    expect(collapsed, 'the group key must be d.invoice_id alone — an extra column makes r a row per reducer and the LEFT JOIN multiplies').toMatch(
      /GROUP BY d\.invoice_id \) r ON r\.invoice_id = i\.id/,
    );
    // The `LEFT`, asserted here and not only carried by the digest. A review
    // measured that this law's `token` and its `bound: 'both'` both CLAIMED
    // the `LEFT` while no matcher here read it — the word appeared only in a
    // failure message. Narrowed to an inner join, every invoice with no
    // reducer row drops out and the merchant's own unpaid invoice comes back
    // as missing: a bound from BELOW, on this law's own subject.
    expect(collapsed, 'the reducer join must be a LEFT join, or an invoice with no allocation and no credit falls out of the result').toContain('LEFT JOIN (');
    expect(collapsed, 'and the two reducer relations must both be inside it, or the group is over the wrong set').toMatch(
      /payment_allocations[\s\S]*?UNION ALL[\s\S]*?customer_credit_applications[\s\S]*?GROUP BY d\.invoice_id/,
    );
  });

  it('rc_6b: the driving predicate selects on business and id and on NOTHING ELSE', () => {
    // The route into the no-loss half that the first two rounds of this file
    // did not read at all: `WHERE`. MEASURED green at 15/15, both of them:
    //   … AND i.status = 'open'
    //   … AND s.settlement_mode <> 'cash'
    // Either one drops a document the merchant can SEE out of the result set,
    // so `v_found` falls short of `v_asked` and the routine answers
    // «the invoice does not exist in this business» about the merchant's own
    // draft, or their own cash sale. And it is not a contrived edit: both
    // predicates already exist as `CASE` arms a few lines above, where they
    // decide that such a document reports ZEROS rather than being dropped.
    // Moving them into `WHERE` looks like tidying to anyone who has not read
    // the refusal.
    const collapsed = collapse(signatureBody(lastDefining(ARRAY_FORM).sql, ARRAY_FORM));
    expect(collapsed, 'the driving WHERE must select on business_id and the id array alone, or a visible document is refused as missing').toContain(
      'WHERE i.business_id = p_business_id AND i.id = ANY(p_invoice_ids);',
    );
    // And the status and settlement arms must still be where they belong — in
    // the projection, reporting zeros. A positive control for the claim above:
    // if these had moved, the law would be forbidding something absent.
    expect(collapsed, 'a non-open document must report zeros in the projection, not vanish from it').toMatch(/CASE WHEN i\.status <> 'open'/);
    expect(collapsed, 'and a cash-settled one likewise').toMatch(/WHEN s\.settlement_mode = 'cash'/);
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

  it('rc_13: no later migration this scanner can read drops, renames, redefines or invalidates any of the pinned constraints', () => {
    // The asymmetry an independent review named: the ROUTINE is resolved by
    // «last definition wins», but the TABLES are read from pinned revision
    // numbers. `0075` and `0077` are below `frozenThrough`, so their own text
    // cannot change — but a LATER candidate migration can `ALTER TABLE … DROP
    // CONSTRAINT`, and `rc_7`, `rc_8` and `rc_11` would stay green reading
    // text that no longer describes the database.
    // Each probe CARRIES its own planted statement, rather than the two being
    // two lists paired by index. The paired form was here first and it failed
    // honestly on the next edit: adding two probes without adding their plants
    // left `plants[i]` undefined and the positive control said so by name. The
    // structure that cannot drift is the structure where there is nothing to
    // keep in step.
    //
    // The constraint names are matched with the optional double quotes
    // PostgreSQL accepts, because `DROP CONSTRAINT "invoices_sale_fk"` is the
    // same statement and an independent review measured the unquoted-only form
    // green against it. `RENAME CONSTRAINT` is here for the same reason: a
    // renamed constraint is a dropped one as far as `rc_11`'s text pin is
    // concerned.
    const undo: { name: string; re: RegExp; plant: string; afterResolved?: true; scan?: (sql: string) => boolean }[] = [
      {
        name: 'the invoices primary key',
        re: /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?invoices_pkey"?/i,
        plant: 'ALTER TABLE invoices DROP CONSTRAINT invoices_pkey;',
      },
      { name: 'the sales primary key', re: /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?sales_pkey"?/i, plant: 'ALTER TABLE sales DROP CONSTRAINT "sales_pkey";' },
      {
        name: 'the composite edge to sales',
        re: /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?invoices_sale_fk"?/i,
        plant: 'ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_sale_fk;',
      },
      {
        name: 'the edge, by renaming it',
        re: /RENAME\s+CONSTRAINT\s+"?invoices_sale_fk"?/i,
        plant: 'ALTER TABLE invoices RENAME CONSTRAINT invoices_sale_fk TO invoices_sale_fk_old;',
      },
      {
        name: "invoices.sale_id's NOT NULL",
        re: /ALTER\s+COLUMN\s+"?sale_id"?\s+DROP\s+NOT\s+NULL/i,
        plant: 'ALTER TABLE invoices ALTER COLUMN sale_id DROP NOT NULL;',
      },
      // The one a reviewer called the most dangerous, and rightly: `0075` is
      // below `frozenThrough`, so its text keeps describing a NOT NULL column
      // truthfully while the database no longer has the column at all.
      {
        name: 'invoices.sale_id itself',
        re: /ALTER\s+TABLE\s+(?:public\.)?invoices\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?sale_id"?/i,
        plant: 'ALTER TABLE public.invoices DROP COLUMN IF EXISTS sale_id;',
      },
      // Anchored, for the reason `rc_11` records: the unanchored form fired on
      // `0077`'s own refusal message, «invoices_sale_fk would not validate».
      {
        name: 'the edge validation',
        re: /ADD\s+CONSTRAINT\s+invoices_sale_fk[^;]{0,200}?\bNOT\s+VALID\b/i,
        plant: 'ALTER TABLE invoices ADD CONSTRAINT invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) NOT VALID;',
      },
      // THE ROUTINE ITSELF, which this law did not look at and should have.
      // A review measured the consequence: a later migration that writes
      // `DROP FUNCTION public.invoice_outstanding(UUID, UUID[]);` and then
      // re-creates it WITHOUT the refusal left every law here green, because
      // the resolver did not recognise the schema-qualified name and went on
      // reading `0084`. The resolver now accepts the qualification; this row
      // is the other half, because a redefinition ANYWHERE after the resolved
      // file is a change to the subject of all sixteen laws, whether the
      // resolver follows it or not.
      // `ROUTINE` is matched beside `FUNCTION` in every row below that names a
      // routine. They are exact synonyms in PostgreSQL 11+ and this project
      // runs `postgres:16`; round five measured `DROP ROUTINE` and
      // `ALTER ROUTINE … SECURITY DEFINER` sailing past all three rows while
      // the suite stayed green. And it catches nothing legitimate: `DROP
      // ROUTINE` and `ALTER ROUTINE` occur ZERO times in all 87 migrations.
      // These two are UNSCOPED, unlike the rows below: measured, `ALTER
      // FUNCTION … invoice_outstanding` occurs ZERO times in all 87
      // migrations, so every file can be scanned and nothing legitimate is
      // caught. Scoping is used only where a probe matches inside the
      // resolved file and therefore has to be — which the positive control
      // below asserts row by row, and which is how this distinction was found.
      // ─── BY NAME, NOT BY SIGNATURE ─────────────────────────────────────
      //
      // These three rows are the ones that matter, and the rows below them
      // are now message-providers rather than coverage. Six rounds of review
      // each enumerated one more SPELLING of a statement and the unenumerated
      // rest carried the next kill; round seven measured nine legal spellings
      // of one in-place replacement of this signature — `IN p_business_id`,
      // `"public".invoice_outstanding`, `UUID[] DEFAULT NULL`, `UUID ARRAY`,
      // `pg_catalog.uuid[]`, `UUID[5]`, a comment inside the parameter list —
      // of which SEVEN left all eighteen laws green, one of them replacing the
      // wrapper that production calls. That reviewer stood up a PostgreSQL
      // 16 cluster and confirmed each spelling is accepted and that the stub
      // body wins, so these are legal SQL and not word games.
      //
      // Enumerating spellings is the feature pin again. The question is asked
      // PER STATEMENT, on text a lexer tokenized, and about the NAME: whatever
      // types, modes, defaults, quoting, case, comments or extra drop targets
      // a later migration writes, the name is still the name.
      //
      // THE CLAIM, AND ITS TWO DECLARED LIMITS, because an earlier version of
      // this comment said «stopping at the first `(` or `;`» — the mechanism
      // round ten deleted — and a commit message claimed to have narrowed it
      // without doing so. Both reviewers caught that, and it is exactly the
      // defect this file exists to retire.
      //
      // What IS reported: any `CREATE`, `DROP` or `ALTER` of a routine named
      // `invoice_outstanding`, in any spelling, in any migration after the one
      // these laws read — including inside `DO … END` and inside
      // `EXECUTE '…'`, to three levels — and any migration the lexer cannot
      // tokenize at all, which fails this law by file name rather than being
      // skimmed.
      //
      // What is NOT, and is declared rather than discovered: DDL whose routine
      // NAME is assembled at run time, `EXECUTE format('… %I …', …)` or
      // `EXECUTE 'DROP … ' || 'invoice_outstanding(…)'`. No text scanner can
      // read a name that does not exist until the statement runs. Measured:
      // neither form occurs in any of the 87 migrations today.
      //
      // The slice that legitimately replaces this routine comes back here and
      // re-pins the digests, which is the review it owes anyway.
      //
      // Measured clean on the tree: the CREATE probe matches `0075`, `0080`,
      // `0081`, `0083` and `0084` and nothing after them; the DROP probe only
      // `0084`, which drops the array form itself; the ALTER probe nothing at
      // all, which is why it alone is unscoped.
      {
        name: 'either form, by CREATING it under any signature spelling after the file these laws read',
        re: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|ROUTINE)/i,
        scan: (sql) => createsRoutineNamed(sql, 'invoice_outstanding'),
        plant: 'CREATE OR REPLACE FUNCTION "public".invoice_outstanding(IN p_business_id pg_catalog.uuid, IN p_invoice_ids uuid ARRAY)',
        afterResolved: true,
      },
      {
        name: 'either form, by DROPPING it under any signature spelling after the file these laws read',
        re: /DROP\s+(?:FUNCTION|ROUTINE)/i,
        scan: (sql) => statementTouchesRoutine(sql, /^\s*DROP\s+(?:FUNCTION|ROUTINE)\b/i, 'invoice_outstanding'),
        plant: 'DROP FUNCTION IF EXISTS "public"."invoice_outstanding"(p_business_id uuid, p_invoice_ids uuid ARRAY) CASCADE;',
        afterResolved: true,
      },
      {
        name: 'either form, by ALTERING it under any signature spelling',
        re: /ALTER\s+(?:FUNCTION|ROUTINE)/i,
        scan: (sql) => statementTouchesRoutine(sql, /^\s*ALTER\s+(?:FUNCTION|ROUTINE)\b/i, 'invoice_outstanding'),
        plant: 'ALTER ROUTINE "public"."invoice_outstanding"(p_business_id uuid, p_invoice_ids uuid ARRAY) SECURITY DEFINER;',
      },

      // ATTRIBUTES, as a later `ALTER` can leave them. These are the rows no
      // digest of this file's text can replace: `ALTER FUNCTION … SECURITY
      // DEFINER;` in a later migration leaves `0084` byte-identical, so every
      // digest here still matches, while the installed routine crosses the
      // caller's row security — `v_found` rises to meet `v_asked`, the report
      // falls silent, and the routine hands back another business's settlement
      // figures. MEASURED green before this row, and `definer-search-path.ts`
      // does not catch it either: it permits a definer whose `search_path` is
      // pinned, and `ALTER … SECURITY DEFINER` keeps the `SET` from the CREATE.
      {
        name: "the routine's INVOKER reads, by altering it later",
        re: /ALTER (?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\([^)]*\)[^;]*SECURITY\s+DEFINER/i,
        plant: 'ALTER FUNCTION public.invoice_outstanding(UUID, UUID[]) SECURITY DEFINER;',
      },
      {
        name: "the routine's pinned search_path, by altering it later",
        re: /ALTER (?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\([^)]*\)[^;]*(?:RESET|SET)\s+search_path/i,
        plant: 'ALTER FUNCTION public.invoice_outstanding(UUID, UUID[]) RESET search_path;',
      },
      // THE ARRAY SIGNATURE'S OWN REDEFINITION, which no row covered either —
      // and it is the overload that matters most. The thin wrapper had this
      // row; the ONE DEFINITION OF THE SETTLEMENT SUM did not. A later
      // `CREATE OR REPLACE` needs no `DROP` when the return type and the
      // parameter names are unchanged, so nothing here saw it, and the
      // resolver's own flags made it worse: measured, the SAME replacement
      // written `uuid`/`uuid[]` instead of `UUID`/`UUID[]` left all eighteen
      // laws green while an upper-case spelling of it reddened fourteen. SQL
      // is case-insensitive and lower-case `uuid` already ships in `0032`,
      // `0033` and `0038`, so that is a house style and not a contrivance.
      {
        name: 'the set-based form, by redefining it after the file these laws read',
        re: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\(\s*\w+\s+UUID\s*,\s*\w+\s+UUID\s*\[\s*\]\s*\)/i,
        plant: 'CREATE OR REPLACE FUNCTION public.invoice_outstanding(p_business_id uuid, p_invoice_ids uuid[])',
        afterResolved: true,
      },
      // And renaming it away, which leaves no `DROP` and no `CREATE` to find.
      {
        name: 'either form, by renaming it out from under these laws',
        re: /ALTER\s+(?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\([^)]*\)\s+RENAME\s+TO/i,
        plant: 'ALTER FUNCTION public.invoice_outstanding(UUID, UUID[]) RENAME TO invoice_outstanding_v1;',
      },
      // THE SCALAR SIGNATURE'S OWN DROP, which no row covered: the drop row
      // below names `(UUID, UUID[])` only. Round five's route in was exactly
      // this — drop the wrapper, recreate it with renamed parameters and no
      // delegation. `CREATE OR REPLACE` cannot rename a parameter (`42P13`),
      // so the drop is the necessary first step and catching it closes the
      // route rather than one spelling of it. UNSCOPED, and the row-by-row
      // control is how that was settled: the scalar signature is dropped by
      // NO migration (measured, zero files), unlike the array signature which
      // `0084` drops itself — so this row can read every file and the array
      // row cannot.
      {
        name: 'the scalar wrapper, by dropping it',
        re: /DROP (?:FUNCTION|ROUTINE)\s+(?:IF EXISTS\s+)?(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\(\s*(?:\w+\s+)?UUID\s*,\s*(?:\w+\s+)?UUID\s*\)/i,
        plant: 'DROP FUNCTION IF EXISTS public.invoice_outstanding(UUID, UUID);',
      },
      // THE SCALAR WRAPPER, which `rc_1b` reads only inside the resolved file.
      // `CREATE OR REPLACE` with the same argument names is legal and needs no
      // `DROP`, so a later migration can give the wrapper its own inline query
      // and drop the delegation that lends it its refusal — and the wrapper is
      // the form three production readers call. MEASURED green before this row.
      {
        name: 'the scalar wrapper, by redefining it after the file these laws read',
        re: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|ROUTINE)\s+(?:(?:public|app)\.)?invoice_outstanding\s*\(\s*\w+\s+UUID\s*,\s*\w+\s+UUID\s*\)/i,
        plant: 'CREATE OR REPLACE FUNCTION public.invoice_outstanding(p_business_id UUID, p_invoice_id UUID)',
        afterResolved: true,
      },
      // Scoped to migrations AFTER the resolved file, and that scoping is not
      // a convenience: `0084` itself drops this signature three lines above
      // re-creating it — it has to, because the return type changed and
      // `CREATE OR REPLACE` cannot change a return type. An unscoped probe
      // fires on the subject it is meant to protect.
      {
        name: 'the routine, by dropping it after the file these laws read',
        re: /DROP (?:FUNCTION|ROUTINE)\s+(?:IF EXISTS\s+)?(?:(?:public|app)\.)?"?invoice_outstanding"?\s*\(\s*(?:\w+\s+)?UUID\s*,\s*(?:\w+\s+)?UUID\s*\[\s*\]\s*\)/i,
        plant: 'DROP FUNCTION IF EXISTS public.invoice_outstanding(UUID, UUID[]);',
        afterResolved: true,
      },
    ];
    // EVERY row reads comment-stripped text, not only the name-level ones.
    // Measured: the same blocking character voided the CONSTRAINT rows just as
    // it voided the routine rows —
    //   ALTER TABLE invoices DROP CONSTRAINT /* retire (R-100) */ invoices_sale_fk;
    //   ALTER TABLE invoices ALTER COLUMN /* nullable (R-100) */ sale_id DROP NOT NULL;
    // were both green while a probe named exactly that act. Stripping once,
    // here, closes the class instead of its two instances. One named helper so
    // the controls and the scan cannot drift apart — two call sites that must
    // agree are two call sites that will not.
    const hitsIn = (u: (typeof undo)[number], sql: string) => (u.scan ? u.scan(sql) : new RegExp(u.re.source, u.re.flags).test(collapse(sqlCodeOnly(sql))));

    // POSITIVE CONTROL FIRST: each probe must match its own planted statement,
    // or a clean scan below means nothing at all.
    for (const u of undo) {
      expect(hitsIn(u, u.plant), `the probe for ${u.name} cannot find its own planted statement`).toBe(true);
    }

    // THE NEGATIVE CONTROL FOR THE CREATE PROBE, which is the one that could
    // cry wolf. Containment would have fired on seven statements in `0075`,
    // `0083` and `0084` that create `customer_ar_outstanding`,
    // `customer_ar_aging` and `customer_ar_open_document_counts` — readers
    // whose BODIES call `invoice_outstanding`, which is ordinary work; DR-29
    // added the third. The probe parses the name being CREATED instead, and
    // this asserts that distinction rather than trusting it.
    const reader = [
      'CREATE OR REPLACE FUNCTION public.customer_ar_rollup(p_business_id UUID)',
      'RETURNS TABLE (total BIGINT) LANGUAGE sql STABLE AS $fn$',
      '  SELECT sum(o.outstanding_txn_minor) FROM public.invoice_outstanding(p_business_id, ARRAY[]::UUID[]) o;',
      '$fn$;',
    ].join('\n');
    expect(
      createsRoutineNamed(reader, 'invoice_outstanding'),
      'the CREATE probe fires on a routine that merely READS this one — it would be switched off within a week',
    ).toBe(false);
    expect(
      createsRoutineNamed(reader, 'customer_ar_rollup'),
      'and the same probe must still see the routine that statement does create, or it is simply blind',
    ).toBe(true);
    // And a comment mentioning the routine is not a redefinition of it.
    expect(
      createsRoutineNamed('-- CREATE FUNCTION invoice_outstanding(a UUID, b UUID[]) was replaced in 0084\n', 'invoice_outstanding'),
      'a commented-out statement must not count as one',
    ).toBe(false);

    const files = migrationFiles();
    expect(files.length, 'the migration scan found no files, so the clean result below is a broken path and not a measurement').toBeGreaterThan(10);
    const resolved = lastDefining(ARRAY_FORM).file;
    expect(resolved, 'the resolved file is unknown, so the after-resolved scoping below has no reference point').not.toBe('');
    // Positive control for the SCOPING, not just for the probes: the
    // after-resolved rows must have something to be scoped away from, or the
    // scoping is untested and an unscoped probe would look identical.
    const resolvedSql = sqlLiveCode(join(MIGRATIONS, resolved));
    for (const u of undo.filter((x) => x.afterResolved)) {
      expect(
        hitsIn(u, resolvedSql),
        `the probe for ${u.name} does not match inside ${resolved}, so scoping it after that file proves nothing — either the scoping is unnecessary or the probe is wrong`,
      ).toBe(true);
    }

    // FAIL CLOSED ON ANYTHING THE SCANNER CANNOT READ. This is what makes the
    // scan a measurement rather than an optimistic guess, and it is the lesson
    // of nine rounds: a scanner that proceeds on input it does not understand
    // always has one more spelling left. An unbalanced block comment or an
    // unterminated literal in ANY migration is reported here by file name, and
    // this law fails — the file is quarantined rather than skimmed.
    // THE QUARANTINE AND THE ROWS MUST READ THE SAME STRING. They did not:
    // the quarantine read the raw file while the rows read `sqlLiveCode`'s
    // output, and `sqlLiveCode` drops every whole-line `--` — including a line
    // that carries a block comment's terminator. The lexer then correctly
    // reported an unterminated comment on the text the ROWS read, their code
    // view collapsed to the empty string so EVERY row went silent for that
    // file, and the quarantine reported nothing because it had asked a
    // different question of a different text. Measured, on two fixtures
    // differing by exactly two comment lines: without them `rc_13` was red,
    // with them the suite was green at 19/19 while the one definition of the
    // settlement sum was replaced by a body with no refusal.
    //
    // Both now read the RAW file. The lexer handles comments itself, so
    // `sqlLiveCode` was not merely redundant here — it was destructive.
    const migrationText = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
    const unscannable = files.flatMap((f) => sqlScanProblems(migrationText(f)).map((p) => `${f}: ${p}`));
    expect(unscannable, `a migration cannot be tokenized, so no claim below about it is measured: ${JSON.stringify(unscannable)}`).toEqual([]);
    // Positive control: the quarantine must actually trigger, or the clean
    // result above is a broken probe reporting nothing.
    expect(sqlScanProblems('CREATE FUNCTION /* unbalanced public.f()').length, 'the scanner does not notice an unbalanced block comment').toBeGreaterThan(0);
    expect(sqlScanProblems("SELECT 'unterminated").length, 'the scanner does not notice an unterminated string').toBeGreaterThan(0);
    expect(sqlScanProblems('SELECT 1;').length, 'and it must not report a problem in ordinary SQL').toBe(0);

    const found: string[] = [];
    for (const f of files) {
      const sql = migrationText(f);
      for (const u of undo) {
        if (u.afterResolved && f <= resolved) continue;
        if (hitsIn(u, sql)) found.push(`${f} undoes ${u.name}`);
      }
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
      expect(['detector', 'preventer', 'backstop'], `${pin.law} carries a role outside the vocabulary`).toContain(pin.role);
      // A preventer that cannot say which direction it bounds is how three
      // constraints came to be called sufficient for a claim needing five.
      if (pin.role === 'preventer') {
        expect(['above', 'below', 'both'], `${pin.law} is a preventer but states no bound`).toContain(pin.bound);
      } else {
        expect(pin.bound, `${pin.law} is a ${pin.role}; it bounds nothing`).toBeUndefined();
      }
    }
    const declared = [...source.matchAll(/it\('(rc_\d+)[a-z]?:/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
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
    for (const law of ['rc_6', 'rc_6b', 'rc_7', 'rc_8', 'rc_11', 'rc_12', 'rc_13']) {
      expect(roleOf(law), `${law} makes a wrong count unrepresentable, which is a different role`).toBe('preventer');
    }

    // BOTH DIRECTIONS must be covered. This is the assertion whose absence let
    // the first version of this file claim a two-sided property from
    // one-sided support.
    //
    // Counted over pins that bound a direction EXPLICITLY, and not over
    // `'both'`. The earlier form folded `'both'` into each side, and a
    // reviewer measured the consequence: relabelling `rc_11` — then the only
    // `'below'` pin — left this check satisfied by `rc_13`'s `'both'` alone.
    // A coverage check that one meta-pin can satisfy is not a coverage check.
    for (const direction of ['above', 'below'] as const) {
      const explicit = PINS.filter((p) => p.role === 'preventer' && p.bound === direction);
      expect(explicit.length, `no preventer bounds the count from ${direction} explicitly, so that half of the claim rests on nothing`).toBeGreaterThan(0);
    }

    // AND EACH BOUND IS PINNED INDIVIDUALLY, not just covered collectively.
    // Measured, and it is why this block exists: with coverage alone,
    // relabelling `rc_11` from `'below'` to `'above'` stayed GREEN at 16/16,
    // because `rc_6b` also bounds below and the coverage check was satisfied
    // without it. A table that may hold a wrong entry as long as some other
    // entry is right is a table that can lie about which constraint does what
    // — and «which constraint does what» is the whole subject of this file.
    const boundOf = (law: string) => PINS.find((p) => p.law === law)?.bound;
    expect(boundOf('rc_6'), 'the reducer bounds BOTH ways: extra key columns multiply rows, and losing LEFT drops rows').toBe('both');
    expect(boundOf('rc_6b'), 'the driving predicate bounds from BELOW: an extra conjunct drops a visible row').toBe('below');
    expect(boundOf('rc_7'), 'the invoices key bounds from above').toBe('above');
    expect(boundOf('rc_8'), 'the sales key bounds from above').toBe('above');
    expect(boundOf('rc_11'), 'join totality bounds from BELOW: a lost row makes the count fall short').toBe('below');
    expect(boundOf('rc_12'), 'an invoker read bounds from above: a definer read sees more rows, not fewer').toBe('above');
    expect(boundOf('rc_13'), 'the no-undo scan protects pins on both sides').toBe('both');

    // Counts are MEASURED and pinned deliberately, so that a dropped pin is
    // distinguishable from a renamed one. A new pin must move the number on
    // purpose.
    expect(PINS.filter((p) => p.role === 'detector')).toHaveLength(5);
    expect(PINS.filter((p) => p.role === 'preventer')).toHaveLength(7);
    // Exactly one backstop, and it is the body digest. More than one would
    // mean two things claim to have no remainder, and then neither does.
    const backstops = PINS.filter((p) => p.role === 'backstop');
    expect(
      backstops.map((p) => p.law),
      'there must be exactly one backstop and it must be the body digest',
    ).toEqual(['rc_4c']);
    expect(backstops[0]?.bound, 'the backstop bounds nothing; it pins the body').toBeUndefined();
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
  it('rc_9b: this file contains no stray control characters, because one silently disarmed a law three times', () => {
    // MEASURED, AND ON THIS FILE. Writing a regex through a shell heredoc
    // into a script turned `\b` into a literal BACKSPACE (U+0008), so
    // `/\bEXECUTE\b/` became `/<BS>EXECUTE<BS>/` and matched nothing. The
    // suite stayed green, `grep` printed the pattern as if it were correct
    // because the byte is invisible, and the law it gated simply never fired.
    // That is the worst failure mode a guard has: not red, not green-for-a-
    // reason, but absent while looking present. It happened three times on
    // this card before it was caught by reading bytes instead of characters.
    const source = readFileSync(THIS_FILE, 'utf8');
    const strays = [...source].reduce<string[]>((acc, ch, at) => {
      const code = ch.codePointAt(0) ?? 0;
      // Tab, newline and carriage return are the only control characters a
      // source file has any business containing.
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) acc.push(`U+${code.toString(16).padStart(4, '0')} at ${at}`);
      return acc;
    }, []);
    expect(strays, `this file holds control characters, which is how an escape becomes an invisible no-op: ${JSON.stringify(strays)}`).toEqual([]);
    // Positive control: the probe must see one when it is there, or the empty
    // list above is a measurement of nothing.
    const planted = `a${String.fromCharCode(8)}b`;
    expect(
      [...planted].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20),
      'the control-character probe cannot see a planted backspace',
    ).toBe(true);
  });

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

    // THE HEADER, AND ONLY THE HEADER.
    //
    // This slice is not tidiness, it is the whole assertion. The earlier form
    // scanned the WHOLE SOURCE for `REQUIRED_DENIAL` — and `REQUIRED_DENIAL`
    // is a string constant DECLARED in this file, so its own declaration
    // satisfied the search. MEASURED by an independent review: deleting the
    // sentence from the header left this law GREEN. A tautology, on the one
    // assertion that holds this file to its own honesty, five screens after
    // the probe's docstring warns about «a probe with a hole shaped like
    // itself».
    // The STRUCTURE of the slice is asserted on the raw text and its CONTENT
    // on the flattened text, because `flattenProse` removes the ` * `
    // scaffolding and with it the closing `*/` — asserting both on the
    // flattened string is how the first attempt at this failed.
    const raw = fileHeader();
    expect(raw, 'the header slice is empty, so the assertion below would be vacuous again').not.toBe('');
    // The slice must be a COMMENT and must stop there. `const` cannot occur
    // inside it, so no declaration can satisfy the assertion that follows —
    // which is the hole the previous, line-based slice still had.
    expect(raw.startsWith('/**'), 'the header slice must begin at the opening of a block comment').toBe(true);
    expect(raw.endsWith('*/'), 'and must end at its close, so nothing declared below is inside it').toBe(true);
    expect(raw, 'the header slice must contain no declaration at all').not.toMatch(/\bconst\s+\w+\s*=/);
    expect(flattenProse(raw), 'the header must say out loud that the refusal does not prevent duplication').toContain(REQUIRED_DENIAL);

    // DECLARED LIMIT: this pins the WORDING of the claim, not its truth. What
    // makes the claim true is the constraint laws above, in both directions,
    // and what makes the detector a detector is that removing it changes no
    // number. Neither is checkable from text, and both are stated in the
    // header rather than left implicit.
  });
});
