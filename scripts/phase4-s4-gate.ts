#!/usr/bin/env tsx
/**
 * PHASE 4 SLICE GATE — P4-S4 — `npm run gate:phase4:s4`
 *
 * P4-S4 is the customer-settlement slice: the received-money document, its
 * allocation onto invoices, and the customer credit a surplus becomes. This
 * gate is the slice's evidence, and it is written against the two defects the
 * Tech Lead's standing ruling was issued over — both of which a previous slice
 * actually shipped:
 *
 *   «A green workflow is not evidence for a gate the workflow never ran. A
 *    gate that checks test filenames but never executes the tests is not a
 *    gate. Do not weaken the product to obtain green. Fix the evidence so
 *    green means what it claims.»
 *
 *   1. THE ROSTER IS EXECUTED. `roster` answers "does the suite exist and can
 *      it go red"; it cannot answer "does it PASS". `roster-execution` hands
 *      every rostered file to ONE bounded Vitest run and reads the verdict off
 *      the spawn RESULT OBJECT — never through a pipe, because a pipeline's
 *      exit status is its LAST stage's and DAFTAR's runner has already exited 0
 *      over four failing tests. The executor is `executeSuites`, the one the
 *      P4-S2 and P4-S3 gates already use, so there is a single implementation
 *      of that verdict rather than a second one that can drift.
 *   2. THE GATE IS IN REQUIRED CI, STRUCTURALLY. A step of the required
 *      `backend` job runs this gate, with no `continue-on-error` and no `if:`,
 *      after the P4-S3 step — exactly the visible, unconditional shape of the
 *      steps around it. `requiredCiProblems` below PARSES
 *      `.github/workflows/ci.yml` and states that as a law; `check:required-ci`
 *      runs it here, and `tests/guards/p4s4-required-ci.test.ts` plants every
 *      way of breaking it on a MUTATED COPY of the workflow text and requires
 *      the law to go red on each. That suite is on this gate's roster, so the
 *      claim "this gate is in required CI" is executed by this gate itself.
 *
 * ── HOW THE CHAIN COMPOSES (TL-P4-S2-R3) ─────────────────────────────────
 *
 * This gate does not spawn `gate:phase4:s3`. TL-P4-S2-R3 authorized CHAIN
 * COMPOSITION INSIDE THE ONE REQUIRED JOB: the slice gates run sequentially
 * and visibly as separate steps of `backend`, so a delta gate need not
 * re-execute a ~50-minute predecessor inside itself. What IS composed here is
 * the predecessors' ASSERTIONS, by import, at no execution cost:
 * `prefixProblems`, all three predecessors' `boundaryProblems`, and the
 * composed `closureRuleProblems`, so the accepted tense of the slices behind
 * this one is re-asserted on every run.
 *
 * ── THE FROZEN PREFIX IS AN INVARIANT, NOT A CLOSURE RULE ────────────────
 *
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`. Nothing in this file says
 * "nothing after N" and nothing here pins a candidate: the frozen prefix is
 * asserted by DELEGATION to the accepted prefix modules, which compare each
 * accepted file against its accepted digest and treat `frozenThrough` as a
 * FLOOR. `S4_ACCEPTED` is EMPTY because P4-S4 is a CANDIDATE, and the
 * candidate-tense block below is fenced between two
 * `CANDIDATE-TENSE (P4-AL-61)` markers so the acceptance commit can find
 * exactly what to delete. `selfClosureProblems` turns the forbidden shapes on
 * THIS file, including the rule that a gate may not name a migration numbered
 * past the last ACCEPTED one — which is why no migration file name appears
 * anywhere below and the candidate surface is DISCOVERED instead.
 *
 * ── WHY THE NEW RELATIONS NEED NO REGISTRATION ───────────────────────────
 *
 * The RLS/FORCE discovery law (`scripts/guards/phase4-rls-force.ts`) and G-3's
 * Phase 4 arm (`scripts/guards/no-authoritative-balance.ts`) both define their
 * surface as *"the digest-verified inherited prefix did not create it"*, so a
 * relation this slice adds is judged by both on the day its migration lands,
 * with no allowlist and no registration. `new-relation-coverage` does not take
 * that on trust: it asserts the predicate admits each relation THE CONTRACT
 * names, and it applies the text-level half of the same two laws —
 * `tenant_id`, `business_id`, `ENABLE`, `FORCE`, `REVOKE … FROM PUBLIC`, and
 * the G-3 vocabulary — to every candidate migration on disk, over a surface
 * discovered from the text rather than listed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { testTitles } from './phase3-s8-gate';
import { MIGRATIONS_SUBDIR, phase4RlsForceStructuralProblems } from './guards/phase4-rls-force';
import { discoverSalesTables, findAuthoritativeSalesColumns, isForbiddenSalesTable, isPhase4Relation } from './guards/no-authoritative-balance';
import { PHASE4_S4_PREFIX, frozenThroughFloor, phase4MigrationsOnDisk, phase4PrefixEnd } from './phase4-prefix';
import { prefixProblems } from './phase4-s1-gate';
import { executeSuites, type SuiteExecution, type SuiteRow } from './phase4-s2-gate';
import {
  S3_ACCEPTED,
  acceptedTenseProblems as predecessorAcceptedTenseProblems,
  boundaryProblems as s3BoundaryProblems,
  closureRuleProblems as predecessorClosureRuleProblems,
} from './phase4-s3-gate';

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

/**
 * The SQL statement beginning at `from`, ending at the first semicolon that
 * actually TERMINATES it — never one inside a single-quoted literal or a
 * comment.
 *
 * Slicing SQL at the first `;` anywhere cuts a statement in half the moment
 * its own text contains a semicolon, and a DESCRIPTION column is English
 * prose. A multi-row INSERT whose first description carries a `;` was read as
 * its first row only, so the rows after it looked unregistered and the gate
 * reported a finding on a correct tree — the worst kind, because it teaches
 * the next reader to disbelieve the gate.
 *
 * Handled: single-quoted literals, including the doubled `''` that is a
 * literal's own escape for a quote; line comments and block comments, whose
 * prose may hold an apostrophe that would otherwise read as opening a
 * literal. NOT handled: dollar-quoting — nothing here slices a routine body,
 * which every other claim reads whole.
 *
 * Returns the statement INCLUDING its semicolon, or null when it is never
 * terminated. A caller that cannot read a statement must stay LOUD: null is
 * not "nothing to check".
 */
export function readSqlStatement(sql: string, from: number): string | null {
  let literal = false;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql[i];
    if (literal) {
      if (ch !== "'") continue;
      // `''` is an escaped quote WITHIN the literal, not its end.
      if (sql[i + 1] === "'") i += 1;
      else literal = false;
      continue;
    }
    if (ch === "'") {
      literal = true;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) return null;
      i = nl;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === ';') return sql.slice(from, i + 1);
  }
  return null;
}

/** This file, relative to a repository root: the subject of its own closure rules. */
export const SELF = 'scripts/phase4-s4-gate.ts';

// ───── CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────────
// P4-S4 is a CANDIDATE. `S4_ACCEPTED` is empty, this gate pins no digest and
// names no migration, and the slice's own migration is reached only through
// `candidateMigrations` — the files on disk numbered past the last ACCEPTED
// Phase 4 migration. The acceptance commit fills `S4_ACCEPTED` and
// `PHASE4_S4_PREFIX` together, deletes this fenced block, and
// `closureRuleProblems` then refuses a tree in which a marker survived, so the
// transition cannot be left half done.

/**
 * P4-S4's accepted migrations and their digests. EMPTY while the slice is a
 * candidate: only Tech Lead acceptance freezes a migration, and a gate that
 * digest-pinned its own candidate would make every later correction to that
 * file a gate failure.
 */
export const S4_ACCEPTED: Readonly<Record<string, string>> = {};

/**
 * The CANDIDATE surface: every Phase 4 migration on disk that the accepted
 * prefix does not already hold. Derived, never listed — this gate may not name
 * a migration past the accepted head (P4-AL-60), and the slice's migration is
 * being written in another worktree while this file is written.
 */
export function candidateMigrations(root: string): string[] {
  const dir = join(root, MIGRATIONS_SUBDIR);
  const head = phase4PrefixEnd() ?? '';
  return phase4MigrationsOnDisk(dir).filter((f) => f > head);
}

/**
 * The candidate tense, asserted rather than assumed: nothing of P4-S4 is
 * frozen yet, and the manifest's floor is still the accepted head. A manifest
 * frozen FURTHER ahead is a later slice doing its job and is not a finding
 * here — the one thing a successor gate must never turn red on.
 */
export function candidateTenseProblems(root: string): string[] {
  const problems: string[] = [];
  if (Object.keys(S4_ACCEPTED).length > 0)
    problems.push(
      `${SELF}: S4_ACCEPTED holds a digest while the candidate-tense block is still here — acceptance fills the literal and deletes the block in one commit (P4-AL-61)`,
    );
  if (PHASE4_S4_PREFIX.length > 0)
    problems.push('PHASE4_S4_PREFIX in scripts/phase4-prefix.ts is not empty while P4-S4 is a candidate — only acceptance appends to it');
  const manifestRel = 'infrastructure/database/MIGRATION_MANIFEST.json';
  if (!has(root, manifestRel)) return [...problems, `${manifestRel} is missing`];
  const manifest = JSON.parse(read(root, manifestRel)) as {
    frozenThrough?: string;
    migrations?: readonly { readonly name: string; readonly sha256: string }[];
  };
  const floor = frozenThroughFloor();
  const frozenThrough = manifest.frozenThrough ?? '';
  // A FLOOR. `>=` on these names is an ordering on the zero-padded prefix.
  if (!(frozenThrough >= floor)) problems.push(`frozenThrough is ${frozenThrough || 'absent'} — it is a floor at ${floor}`);
  const recorded = new Set((manifest.migrations ?? []).map((e) => e.name));
  for (const file of candidateMigrations(root))
    if (recorded.has(file) && frozenThrough >= file)
      problems.push(
        `${file} is a candidate and the manifest already freezes it at or below frozenThrough — only Tech Lead acceptance freezes a migration (P4-AL-61)`,
      );
  return problems;
}

/** What the candidate surface is, printed on a PASS as well as on a FAIL. */
export function candidateReport(root: string): string {
  const files = candidateMigrations(root);
  return `${files.length} candidate migration(s) past the accepted head ${phase4PrefixEnd() ?? 'none'}: ${files.join(', ') || 'none'}`;
}

// ───── end CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────

// ───── THE NEW RELATIONS, AND THE LAWS THAT REACH THEM ────────────────────

/**
 * The four relations the BUILD CONTRACT commits this slice to. They are named
 * here, and nowhere inside either guard, for one reason: the claim being
 * checked is *"what the contract promised is what the discovery judges"*, and
 * that comparison is unstateable without the promise. Every law below is
 * universally quantified over a surface DISCOVERED from the text; this list is
 * only ever the left-hand side of the comparison, never the subject of a law.
 * `scripts/guards/phase4-rls-force.ts` still contains no relation name at all,
 * and `handwrittenListProblems` still refuses one mechanically.
 */
export const CONTRACT_RELATIONS: readonly string[] = ['payments', 'payment_allocations', 'customer_credits', 'customer_credit_applications'];

/**
 * The predicate both laws share is the complement of the digest-verified
 * inherited prefix, so a relation is covered iff that prefix did not create
 * it. Checked, not assumed: if any contract relation were already an inherited
 * name, BOTH the RLS/FORCE law and G-3's Phase 4 arm would silently skip it,
 * and that is a finding this gate must state rather than a thing to discover
 * at review.
 */
export function predicateCoverageProblems(): string[] {
  const problems: string[] = [];
  for (const name of CONTRACT_RELATIONS) {
    if (!isPhase4Relation(name))
      problems.push(
        `${name} is a relation the digest-verified inherited prefix already creates, so isPhase4Relation() excludes it — neither the RLS/FORCE discovery law nor G-3's Phase 4 arm would judge it, and the slice would carry an unjudged relation`,
      );
    if (isForbiddenSalesTable(name))
      problems.push(`${name} is a derived-truth relation name under G-3 (a balance, outstanding, summary, cache or rollup) and may not be created at all`);
  }
  return problems;
}

/**
 * THE TEXT-LEVEL HALF OF THE RLS/FORCE LAW, over a surface discovered from the
 * text. `discoverSalesTables` is G-3's own Phase 4 discovery — every stored
 * relation the text makes that the inherited prefix did not create — so this
 * law has no list and a relation added to the migration is judged the moment
 * it is written. The live half (`pg_class.relrowsecurity` /
 * `relforcerowsecurity`) stays with `tests/guards/phase4-rls-force-guard.test.ts`,
 * which this gate does not duplicate.
 *
 * `P4-AL-08` is why both dimensions are required and why neither is a
 * substitute for the flags: `ENABLE` + `FORCE` without a `business_id` is a
 * policy over a column that does not exist.
 */
export function relationRlsTextProblems(sql: string): string[] {
  const problems: string[] = [];
  for (const name of discoverSalesTables(sql)) {
    const body = createTableBody(sql, name);
    if (body === null) continue; // renamed or SELECT … INTO: the column text is not here to read
    for (const column of ['tenant_id', 'business_id']) {
      const declared = new RegExp(String.raw`(^|,|\()\s*${column}\s+uuid\b`, 'i').test(body);
      const notNull = new RegExp(String.raw`${column}\s+uuid\s+not\s+null`, 'i').test(body);
      if (!declared) problems.push(`${name} declares no ${column} column — P4-AL-08 requires both RLS dimensions as real columns on every Phase 4 relation`);
      else if (!notNull) problems.push(`${name}.${column} is nullable — a nullable RLS dimension is a row no policy constrains`);
    }
    if (!new RegExp(String.raw`alter\s+table\s+(?:public\.)?${name}\s+enable\s+row\s+level\s+security`, 'i').test(sql))
      problems.push(
        `${name} is never given ENABLE ROW LEVEL SECURITY — every policy written for it would be inert and a cross-tenant read served by the table itself (TL-P4-S1-R2)`,
      );
    if (!new RegExp(String.raw`alter\s+table\s+(?:public\.)?${name}\s+force\s+row\s+level\s+security`, 'i').test(sql))
      problems.push(`${name} is never given FORCE ROW LEVEL SECURITY — the relation's OWNER would bypass every policy on it (TL-P4-S1-R2)`);
    if (!new RegExp(String.raw`revoke\s+all\s+on\s+(?:table\s+)?(?:public\.)?${name}\s+from\s+public`, 'i').test(sql))
      problems.push(`${name} is never REVOKEd from PUBLIC — the house pattern grants nothing by default and this relation would be readable by every role`);
  }
  return problems;
}

/** The body of `CREATE TABLE <name> ( … )`, balanced on parentheses, or `null` when the text does not create it that way. */
export function createTableBody(sql: string, name: string): string | null {
  const head = new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?${name}"?\s*\(`, 'i').exec(sql);
  if (head === null) return null;
  let depth = 0;
  const start = head.index + head[0].length;
  for (let i = start - 1; i < sql.length; i += 1) {
    const c = sql.charAt(i);
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(start, i);
    }
  }
  return null;
}

/**
 * G-3's VOCABULARY, applied to one text over the same discovered surface. The
 * words are the shared ones (`scripts/guards/no-authoritative-balance.ts`) and
 * no copy of them is made here: a fourth copy of a vocabulary is a fourth
 * thing to keep in step.
 */
export function vocabularyProblems(sql: string): string[] {
  const problems: string[] = [];
  const watched = discoverSalesTables(sql);
  for (const table of watched)
    if (isForbiddenSalesTable(table))
      problems.push(
        `${table} is a derived-truth relation name under G-3 — a balance, outstanding, receivables, summary, cache, snapshot or rollup relation is a second financial truth`,
      );
  for (const hit of findAuthoritativeSalesColumns(sql, watched))
    problems.push(`${hit.table}.${hit.column} claims storage authority over a derived receivable, debt or stock quantity (G-3 / P4-AL-06)`);
  return problems;
}

/**
 * THE CONTRACT'S OWN STRUCTURAL RULINGS over the settlement text, applied only
 * to a text that actually creates one of the settlement relations — so a
 * candidate migration about something else is not judged against them.
 *
 * THE STRUCTURAL CUSTOMER PIN (what the slice's own migration called
 * "Departure A", now CLOSED by the Tech Lead's §23 ruling and by the
 * corrective migration that carries it). The invoice-side FK ends at the
 * THREE-column form
 * `(business_id, invoice_id, customer_id) → invoices (business_id, id, customer_id)`,
 * so a reducer naming one customer against another customer's invoice has no
 * foreign-key target at all, and a walk-in invoice — whose `customer_id` IS
 * NULL while every reducer's is `NOT NULL` — has no target for any reducer
 * either. Both laws are SHAPES, not checks a writer could get around.
 *
 * This law is quantified over the CANDIDATE SURFACE AS A WHOLE and not over
 * one file, because the pin arrived in two steps on purpose: the slice's own
 * migration declared the narrow edge inside `CREATE TABLE` while the ownership
 * question was open, and the corrective migration widens it with
 * `ALTER TABLE … DROP CONSTRAINT` / `ADD CONSTRAINT` once the ruling closed
 * it. A law that read only the `CREATE TABLE` body would report the SUPERSEDED
 * shape and call the estate narrow when it is not — a gate describing a
 * database that no longer exists. `effectiveInvoiceEdge` below therefore reads
 * the LAST declaration of each reducer's invoice edge across the surface in
 * file order, which is the shape a database applying that surface in order
 * actually ends up with, and the law additionally requires the key that
 * three-column edge targets to be declared by the same surface.
 *
 * `invoice_settlement_verify` and its two named refusals are still required.
 * The pin makes their customer and walk-in arms unreachable THROUGH THE
 * RELATIONS; it does not replace the routine, which also carries the R-83
 * chain arithmetic, and a corrective that deleted a subsumed check would be
 * trading defence in depth for tidiness.
 *
 * And the arithmetic is REUSED, never re-implemented: the three accepted
 * primitives are `IMMUTABLE`, take plain `BIGINT`, and carry nothing
 * supplier-specific but their names.
 */
export const SETTLEMENT_ARITHMETIC: readonly string[] = ['supplier_convert_base', 'supplier_ap_release', 'supplier_credit_remaining_carrying'];
export const SETTLEMENT_VERIFIER = 'invoice_settlement_verify';

/**
 * THE RULED ROUTINE NAMES. The map offered these as "Proposed"; the
 * coordinator has since RULED them, because the slice's shipped suites pin
 * them and the migration is written to match. A name is cheap to get wrong and
 * expensive to find wrong: a rename discovered at integration costs a round
 * trip through every suite that calls it, so it is a red gate here instead.
 *
 * `invoice_settlement_verify` is one of them and keeps its own diagnostics
 * below, because Departure A names it specifically as what replaces the key
 * `invoices` did not get.
 */
export const SETTLEMENT_ROUTINES: readonly string[] = [
  'customer_collect_payment',
  'customer_apply_credit',
  SETTLEMENT_VERIFIER,
  'customer_credit_verify',
  'customer_credit_consume',
];
export const SETTLEMENT_REFUSALS: readonly string[] = ['invoice_settlement.customer_mismatch', 'invoice_settlement.walkin_not_settleable'];

/**
 * THE RULED ACCOUNTING SOURCE TYPES — **three, not two**.
 *
 * `customer_payment_allocation` and `customer_credit_application` are the two
 * the map derived by symmetry with the supplier chain. The third,
 * `customer_credit` (`source_id` = the credit's id), carries the SURPLUS LEG of
 * a payment: the method's posting account debited, `customer_credit_liability`
 * (2210) credited. It is FORCED and not chosen, for two independent reasons,
 * and both are why a reader must not "simplify" it away:
 *
 *   — a payment with ZERO allocations is in scope (`allocation_count >= 0`),
 *     so the surplus leg has no allocation entry to ride in the first place;
 *   — an allocation entry's line multiset is pinned EXACTLY by the
 *     completeness validator, so the leg could not be folded into one even
 *     where an allocation exists.
 *
 * Registering a source type is three facts in the accepted precedent, and the
 * law below asks for all three per type (`0067:435`, `0067:2280-2287`): the
 * registry row, the owning `post` operation kind the `0046` rule requires, and
 * the type PINNED STRUCTURALLY on its carrier relation — a generated column or
 * a CHECK, never a value a caller supplies, because the composite binding FK
 * is only unspoofable while the type cannot be chosen per row.
 */
export const SETTLEMENT_SOURCE_TYPES: readonly string[] = ['customer_payment_allocation', 'customer_credit_application', 'customer_credit'];

/**
 * THE TABLES THE SETTLEMENT ROUTINES LOCK BUT MUST NEVER WRITE.
 *
 * `customer_collect_payment` and `customer_apply_credit` are SECURITY DEFINER
 * owned by `daftar_inventory_internal`, and their bodies take row locks on
 * `invoices` (`FOR UPDATE`, the cap lock) and `customers` (`FOR SHARE`).
 * PostgreSQL grants a locking clause only to a role holding SELECT **plus one
 * of** UPDATE/DELETE/TRUNCATE on the locked table, so `0081:660-661` gives the
 * role a one-column `GRANT UPDATE (status)` on each — `0075:495` already
 * supplied the SELECT half.
 *
 * That grant is SAFE ONLY BECAUSE NEITHER ROUTINE WRITES EITHER TABLE. The
 * invoice's status is advanced by the sale and void paths of `0078`, and a
 * customer's by `0075`; a settlement routine that began to UPDATE one would
 * be writing a lifecycle it does not own, and the ACL it was handed for a lock
 * would silently have become a write capability. The comment at `0081:620-659`
 * says so, and `[[a wrapper is not an invariant]]` applies to a comment just
 * as much: the claim is MACHINE-CHECKED here, over the routine bodies with
 * every SQL comment stripped, so neither the prose of the migration nor the
 * prose of this law can satisfy it or break it.
 */
export const ROW_LOCK_ONLY_TABLES: readonly string[] = ['invoices', 'customers'];

/** The routines whose bodies the law above is quantified over. */
export const ROW_LOCK_ONLY_ROUTINES: readonly string[] = ['customer_collect_payment', 'customer_apply_credit'];

/**
 * `sql` with every SQL comment removed and nothing else changed.
 *
 * A comment may hold an apostrophe, and a single-quoted literal may hold `--`,
 * so neither can be found by a plain regex over the other: the scanner tracks
 * which of the two it is inside. Each comment is replaced by ONE SPACE and not
 * by nothing, so stripping can never fuse two tokens into a third that was
 * never written (`UPDATE/*x*\/invoices` must not become `UPDATEinvoices`, and
 * must not become `UPDATE invoices` either — see the law below, which is why
 * the replacement is a space and the law then demands real whitespace).
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let literal = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (literal) {
      out += ch;
      if (ch !== "'") continue;
      if (sql[i + 1] === "'") {
        out += "'";
        i += 1;
      } else literal = false;
      continue;
    }
    if (ch === "'") {
      literal = true;
      out += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      out += ' ';
      // An unterminated line comment runs to the end of the text.
      if (nl < 0) return out;
      i = nl - 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      // An unterminated block comment runs to the end of the text.
      if (end < 0) return out;
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The dollar-quoted BODY of `fn` as the text declares it, or null when the
 * text declares no such routine (or leaves its body unterminated).
 *
 * `readSqlStatement` deliberately does not slice a routine body; this does the
 * opposite and reads nothing else. The opening tag is whatever the text used
 * (`$$`, `$func$`, …) and the body ends at the matching tag, so a `$$` inside
 * a nested literal cannot end it early. Returning null keeps a caller LOUD:
 * an unreadable body is never "nothing to check".
 */
export function routineBody(sql: string, fn: string): string | null {
  const head = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?${fn}\b`, 'i').exec(sql);
  if (head === null) return null;
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(head.index));
  if (open === undefined || open === null) return null;
  const tag = open[0];
  const from = head.index + open.index + tag.length;
  const end = sql.indexOf(tag, from);
  if (end < 0) return null;
  return sql.slice(from, end);
}

/**
 * The law: neither settlement routine issues an `UPDATE` of `invoices` or
 * `customers`.
 *
 * Robust to whitespace (`\s+` throughout, so a newline between the keyword and
 * the table reads the same as a space) and to the schema prefix (`public.`,
 * with or without spaces around the dot), and to `UPDATE ONLY t`. It cannot be
 * confused by a locking clause: `FOR UPDATE` is followed by `;`, `)`, `OF` or
 * `NOWAIT`, never by a bare table name, which is exactly what this demands.
 *
 * The subject is the ROUTINE BODY, comments stripped — not the file — so the
 * migration's own prose about the grant is outside the law's reach, and a
 * routine the text does not declare is reported rather than skipped.
 */
export function rowLockOnlyWriteProblems(sql: string): string[] {
  const problems: string[] = [];
  for (const fn of ROW_LOCK_ONLY_ROUTINES) {
    const raw = routineBody(sql, fn);
    if (raw === null) {
      problems.push(
        `${fn}'s body cannot be read from the settlement text (no CREATE [OR REPLACE] FUNCTION, or an unterminated dollar-quoted body) — the row-lock grant at 0081:660-661 is safe only while this routine writes neither ${ROW_LOCK_ONLY_TABLES.join(' nor ')}, and an unreadable body proves nothing`,
      );
      continue;
    }
    const body = stripSqlComments(raw);
    for (const table of ROW_LOCK_ONLY_TABLES) {
      const write = new RegExp(String.raw`\bupdate\s+(?:only\s+)?(?:public\s*\.\s*)?${table}\b`, 'i');
      if (write.test(body))
        problems.push(
          `${fn} issues an UPDATE of ${table} — it holds UPDATE (status) on that table for ONE reason, PostgreSQL's row-locking ACL (0081:620-659), and a routine that writes the table has turned a lock privilege into a write capability over a lifecycle it does not own`,
        );
    }
  }
  return problems;
}

/**
 * The invoice edge `child` ACTUALLY ENDS UP WITH after the whole surface is
 * applied in order, as a pair of column lists: the referencing columns and the
 * referenced ones.
 *
 * Two declaration forms count, because the pin legitimately arrives in two
 * steps across two migrations:
 *   — inside `CREATE TABLE child (… CONSTRAINT … FOREIGN KEY (…) REFERENCES invoices (…) …)`;
 *   — in `ALTER TABLE child ADD CONSTRAINT … FOREIGN KEY (…) REFERENCES invoices (…)`.
 * The LAST one in the text wins, which is the shape a database that applies
 * the files in order holds — a `DROP CONSTRAINT` before it needs no special
 * handling, because what matters is the final `ADD`, and a surface that
 * dropped the edge without re-adding it leaves the last match stale. That one
 * case is caught by the apply itself, not by this reader: the corrective
 * migration's own end-state assertion reads the live catalogue and refuses to
 * commit unless the three-column edge is present and validated.
 *
 * Only `ALTER TABLE` statements naming THIS child are considered, so one
 * reducer's widening is never read as the other's.
 */
export function effectiveInvoiceEdge(sql: string, child: string): { child: string[]; parent: string[] } | null {
  const cols = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''))
      .filter((c) => c !== '');
  const edgeIn = (text: string): { child: string[]; parent: string[] } | null => {
    let last: { child: string[]; parent: string[] } | null = null;
    const pattern = /foreign\s+key\s*\(([^)]*invoice_id[^)]*)\)\s*references\s+(?:public\.)?"?invoices"?\s*\(([^)]*)\)/gi;
    for (const m of text.matchAll(pattern)) last = { child: cols(m[1]), parent: cols(m[2]) };
    return last;
  };
  let effective = edgeIn(createTableBody(sql, child) ?? '');
  const alter = new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:public\.)?"?${child}"?\b`, 'gi');
  for (const hit of sql.matchAll(alter)) {
    const statement = readSqlStatement(sql, hit.index) ?? '';
    const found = edgeIn(statement);
    if (found !== null) effective = found;
  }
  return effective;
}

export function settlementContractProblems(sql: string): string[] {
  const declared = discoverSalesTables(sql);
  const settlement = CONTRACT_RELATIONS.filter((r) => declared.includes(r));
  if (settlement.length === 0) return [];
  const problems: string[] = [];

  // The structural customer pin, all three halves: each reducer's EFFECTIVE
  // invoice edge, the key that edge targets, and the NOT NULL that makes the
  // edge fire on every row.
  for (const child of ['payment_allocations', 'customer_credit_applications'].filter((r) => settlement.includes(r))) {
    const edge = effectiveInvoiceEdge(sql, child);
    if (edge === null) {
      problems.push(
        `${child} declares no composite FOREIGN KEY … REFERENCES invoices (…) — cross-business linkage and the customer pin must be unrepresentable, not refused by the application layer`,
      );
      continue;
    }
    if (edge.child.join(',') !== 'business_id,invoice_id,customer_id' || edge.parent.join(',') !== 'business_id,id,customer_id')
      problems.push(
        `${child}'s effective invoice edge is (${edge.child.join(', ')}) → invoices (${edge.parent.join(', ')}) — the structural pin is ` +
          `(business_id, invoice_id, customer_id) → invoices (business_id, id, customer_id), which is what makes a cross-customer allocation ` +
          `and a settled walk-in invoice unrepresentable rather than refused. A narrower edge leaves both laws resting on ` +
          `${SETTLEMENT_VERIFIER}, which any writer that skips the routine gets past`,
      );
    // The pin holds on nothing unless the referencing column is NOT NULL:
    // under MATCH SIMPLE a referencing tuple holding any NULL skips the check
    // entirely, so a nullable `customer_id` would leave every constraint
    // definition reading correctly and pin no row at all.
    const body = createTableBody(sql, child) ?? '';
    if (!/\bcustomer_id\s+uuid\s+not\s+null/i.test(body))
      problems.push(
        `${child}.customer_id is not declared UUID NOT NULL — under MATCH SIMPLE the three-column invoice edge is skipped on any row holding a ` +
          `NULL in it, so the pin would read correctly in the catalogue and hold on nothing`,
      );
  }
  // The key the widened edges target. PostgreSQL will not accept a PARTIAL
  // unique index as a foreign-key target, and the walk-in invoice carries a
  // NULL `customer_id` — which is why this key is declared NON-PARTIALLY and
  // needs no `WHERE`: it contains the primary key `(business_id, id)`, so it
  // is unique whatever the third column holds and validates on any data. A
  // surface that widened the edges without declaring the key could not apply.
  if (!/alter\s+table\s+(?:only\s+)?(?:public\.)?invoices\s+add\s+constraint\s+\w+\s+unique\s*\(\s*business_id\s*,\s*id\s*,\s*customer_id\s*\)/i.test(sql))
    problems.push(
      `the settlement surface widens the reducer edges onto invoices (business_id, id, customer_id) but never declares that key — ` +
        `ALTER TABLE invoices ADD CONSTRAINT … UNIQUE (business_id, id, customer_id), non-partial, is what the edges target`,
    );
  if (/unique\s*\(\s*business_id\s*,\s*id\s*,\s*customer_id\s*\)\s*where\b/i.test(sql))
    problems.push(
      `the invoices customer key is declared PARTIAL (… WHERE …) — PostgreSQL does not accept a partial unique index as a foreign-key ` +
        `target, and the key does not need to be partial: containing the primary key makes it unique on walk-in rows too`,
    );
  // The RULED routine names. Universally quantified over the ruling, so a
  // name added to the ruling is checked without another claim being written.
  const declares = (fn: string): boolean => new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?${fn}\b`, 'i').test(sql);
  for (const fn of SETTLEMENT_ROUTINES) {
    if (fn === SETTLEMENT_VERIFIER || declares(fn)) continue;
    problems.push(
      `${fn} is not declared in the text that creates ${settlement.join(', ')} — it is a RULED name of this slice, the suites and the command surface call it by that name, and a rename is a red gate here rather than a surprise at integration`,
    );
  }
  if (!declares(SETTLEMENT_VERIFIER))
    problems.push(
      `${SETTLEMENT_VERIFIER} is not declared in the text that creates ${settlement.join(', ')} — since 0082 the three-column edge onto invoices_customer_uq proves the customer identity pin and the walk-in law, and this verifier is the defence in depth behind that shape plus the carrier of the R-83 chain arithmetic, so neither law may be left to the application layer`,
    );
  else if (!/create\s+constraint\s+trigger[\s\S]{0,400}?deferrable\s+initially\s+deferred/i.test(sql))
    problems.push(
      `${SETTLEMENT_VERIFIER} is declared and no CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED wires it — a verifier nothing fires at COMMIT verifies nothing`,
    );
  // The RULED source types, in the same universally-quantified shape: a type
  // added to the ruling is checked without another claim being written.
  const insertRows = (table: string): string => {
    // The statement is found by its HEAD and then read to its real end by
    // `readSqlStatement`, so a semicolon inside a description does not end it.
    const hit = new RegExp(String.raw`insert\s+into\s+(?:public\.)?${table}\b`, 'i').exec(sql);
    if (hit === null) return '';
    // An unterminated statement reads as NO rows, which leaves the
    // registration claims below to report every type — loud, not silent.
    return readSqlStatement(sql, hit.index) ?? '';
  };
  const registry = insertRows('accounting_source_types');
  const kinds = insertRows('accounting_operation_kinds');
  for (const type of SETTLEMENT_SOURCE_TYPES) {
    const literal = new RegExp(String.raw`'${type}'`);
    if (!literal.test(registry))
      problems.push(
        `the source type '${type}' is not registered in accounting_source_types by the settlement text — it is one of the ${SETTLEMENT_SOURCE_TYPES.length} RULED source types of this slice, and an entry bound to an unregistered type is an entry no validator owns`,
      );
    if (!literal.test(kinds))
      problems.push(
        `the source type '${type}' has no owning operation kind in accounting_operation_kinds — the 0046 rule gives every source type one, and the accepted precedent registers both in the same migration (0067:2280-2287)`,
      );
    const pinned =
      new RegExp(String.raw`generated\s+always\s+as\s*\(\s*'${type}'\s*\)\s*stored`, 'i').test(sql) ||
      new RegExp(String.raw`check\s*\(\s*accounting_source_type\s*=\s*'${type}'\s*\)`, 'i').test(sql);
    if (!pinned)
      problems.push(
        `the source type '${type}' is nowhere PINNED on its carrier relation (no GENERATED ALWAYS AS ('${type}') STORED column and no CHECK fixing it) — a type a caller can supply per row makes the composite binding FK spoofable (0067:435)`,
      );
  }

  for (const code of SETTLEMENT_REFUSALS)
    if (!sql.includes(code))
      problems.push(
        `the refusal ${code} appears nowhere in the settlement text — it is the refusal the deferred verifier raises, kept as defence in depth behind the 0082 edge that now refuses the row outright, and a refusal with no RAISE is a sentence in a document`,
      );

  // The arithmetic: called, and never a second body of it.
  for (const fn of SETTLEMENT_ARITHMETIC) {
    if (new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?${fn}\b`, 'i').test(sql))
      problems.push(
        `${fn} is DEFINED again in the settlement text — the accepted body is reused, and a second body of the settlement arithmetic is a duplicate financial truth`,
      );
    if (!new RegExp(String.raw`\b${fn}\s*\(`, 'i').test(sql))
      problems.push(
        `${fn} is never called in the settlement text — the accepted primitive is reused by name (its name is historical; the arithmetic is general), never re-implemented`,
      );
  }

  // The row-lock grant's standing precondition. Stated here so the gate
  // applies it to whatever candidate settlement text the tree holds, with no
  // second call site to keep in step.
  problems.push(...rowLockOnlyWriteProblems(sql));
  return problems;
}

/** The three laws above over every candidate migration on disk, plus the predicate check. */
export function newRelationCoverageProblems(root: string): string[] {
  const problems = [...predicateCoverageProblems(), ...phase4RlsForceStructuralProblems(root)];
  const files = candidateMigrations(root);
  const surface = files.map((f) => read(root, `${MIGRATIONS_SUBDIR}/${f}`)).join('\n');

  // ── NON-VACUITY, ASSERTED BEFORE ANY PROPERTY IS ─────────────────────
  //
  // Every law below has the shape "discover the relations this text declares,
  // then judge each one", and a law of that shape PASSES over an empty set.
  // So a tree with no candidate migration — or one declaring none of this
  // slice's relations — would report `ok` for a surface that is merely
  // ABSENT, which is the one verdict a gate must never give. The subject is
  // derived from the contract and from the migration text; nothing here is a
  // count written down that a later slice would have to bump.
  if (CONTRACT_RELATIONS.length === 0)
    problems.push('CONTRACT_RELATIONS is empty — the predicate-coverage law has no subject at all and could not refuse anything');
  if (files.length === 0)
    problems.push(
      `no candidate migration is on disk, so every relation law below judged an empty set — this slice's surface is ${CONTRACT_RELATIONS.join(', ')}, and a check that discovers none of it is reporting ABSENCE, not correctness`,
    );
  else {
    const declared = discoverSalesTables(surface);
    const found = CONTRACT_RELATIONS.filter((r) => declared.includes(r));
    if (found.length === 0)
      problems.push(
        `the candidate surface (${files.join(', ')}) declares none of ${CONTRACT_RELATIONS.join(', ')} — the RLS/FORCE, G-3 vocabulary and settlement-contract laws below all judged an empty set, so their silence is not evidence`,
      );
  }

  for (const file of files) {
    const sql = read(root, `${MIGRATIONS_SUBDIR}/${file}`);
    // Per FILE: the relation-level laws, so the diagnostic names the file the
    // relation is declared in.
    for (const p of [...relationRlsTextProblems(sql), ...vocabularyProblems(sql)]) problems.push(`${file}: ${p}`);
  }
  // Across the candidate surface AS A WHOLE: the contract's structural
  // rulings. The accepted precedent split the supplier chain over two
  // migrations — the relations and guards in `0067`, the commands in `0068` —
  // so a ruled routine living in a different candidate file than the relation
  // it serves is a lawful shape, and judging each file alone would refuse it.
  for (const p of settlementContractProblems(surface)) problems.push(`the candidate settlement surface (${files.join(', ') || 'none'}): ${p}`);
  return problems;
}

/** Which relations of the contract are on disk yet, and which laws therefore had a subject. */
export function newRelationReport(root: string): string {
  const declared = new Set<string>();
  for (const file of candidateMigrations(root)) for (const r of discoverSalesTables(read(root, `${MIGRATIONS_SUBDIR}/${file}`))) declared.add(r);
  const found = CONTRACT_RELATIONS.filter((r) => declared.has(r));
  const missing = CONTRACT_RELATIONS.filter((r) => !declared.has(r));
  return `${CONTRACT_RELATIONS.length} contract relation(s), all ${CONTRACT_RELATIONS.filter(isPhase4Relation).length} admitted by isPhase4Relation(); ${found.length} declared by a candidate migration (${found.join(', ') || 'none'})${
    missing.length === 0 ? '' : `; NOT YET ON DISK and therefore not yet judged by the text-level laws: ${missing.join(', ')}`
  }`;
}

// ───── REQUIRED CI ────────────────────────────────────────────────────────

/** The job the repository's required-checks configuration matches on. */
export const REQUIRED_JOB = 'backend';
export const WORKFLOW = '.github/workflows/ci.yml';
/** The exact command, the exact step name, and the predecessor step this one must follow. */
export const S4_SCRIPT = 'gate:phase4:s4';
export const S4_COMMAND = 'npm run gate:phase4:s4';
export const S4_STEP_NAME = 'Phase 4 slice gate — P4-S4';
export const S3_SCRIPT = 'gate:phase4:s3';

/**
 * The workflow, as nested mappings and sequences. A check that GREPS the
 * workflow for a line is a check about that line's text: it cannot see two
 * steps swapped, a step moved into another job, a step re-indented into some
 * other mapping, or `continue-on-error` landing on the job instead of the
 * step — and it CAN be satisfied by a comment. So the document is parsed,
 * comments are discarded before any claim is asked, and every claim is a claim
 * about a key's value at a position in the tree.
 *
 * Only the shape GitHub Actions workflows are written in is read, and the
 * reader is STRICT about the one thing that matters here: a `run:` is only
 * ever found inside `jobs.<job>.steps[]`. The repository declares no YAML
 * dependency (`js-yaml` is a transitive ESLint dev-dependency with no types),
 * and a permanent law may not rest on a package nothing declares.
 */
export interface WorkflowStep {
  readonly job: string;
  /** 0-based position in the job's `steps` sequence. */
  readonly index: number;
  readonly name: string | null;
  readonly run: string | null;
  readonly conditional: boolean;
  readonly continueOnError: boolean;
}

export interface WorkflowRead {
  readonly triggers: readonly string[];
  readonly jobs: readonly string[];
  readonly steps: readonly WorkflowStep[];
  /** Job-level `if:` / `continue-on-error`, by job. */
  readonly jobConditional: readonly string[];
  readonly jobContinueOnError: readonly string[];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Drop a trailing `#` comment. A `#` opens one only outside quotes and only at the start of a line or after whitespace. */
function stripComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === '#' && !single && !double && (i === 0 || /\s/.test(line.charAt(i - 1)))) return line.slice(0, i);
  }
  return line;
}

const unquote = (raw: string): string => {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
};

/**
 * The workflow's jobs, their steps and the two keys that can neuter a step.
 * Positional: a job is a key at indent 2 under `jobs:`, a step is a `- ` at
 * indent 6 inside that job's `steps:`, and a step's own keys are at indent 8.
 * An indentation the reader cannot account for inside a step is an ERROR, not
 * a silently dropped key — a dropped key is how a structural check turns into
 * a vacuous one.
 */
export function readWorkflow(text: string): WorkflowRead {
  const lines = text.split('\n');
  const steps: WorkflowStep[] = [];
  const jobs: string[] = [];
  const triggers: string[] = [];
  const jobConditional: string[] = [];
  const jobContinueOnError: string[] = [];
  let section: 'none' | 'on' | 'jobs' = 'none';
  let job: string | null = null;
  let inSteps = false;
  let current: { name: string | null; run: string | null; conditional: boolean; continueOnError: boolean } | null = null;
  let index = -1;
  let blockKey: { indent: number; key: string } | null = null;
  const block: string[] = [];

  const closeStep = (): void => {
    if (job !== null && current !== null) steps.push({ job, index, ...current });
    current = null;
  };
  const closeBlock = (): void => {
    if (blockKey !== null && current !== null && blockKey.key === 'run') current.run = block.join('\n').trim();
    blockKey = null;
    block.length = 0;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (blockKey !== null) {
      if (line.trim() === '' || indentOf(line) > blockKey.indent) {
        block.push(line.trim());
        continue;
      }
      closeBlock();
    }
    const bare = stripComment(line);
    if (bare.trim() === '') continue;
    const indent = indentOf(bare);
    const body = bare.trim();
    if (indent === 0) {
      closeStep();
      inSteps = false;
      job = null;
      section = body.startsWith('on:') ? 'on' : body.startsWith('jobs:') ? 'jobs' : 'none';
      continue;
    }
    if (section === 'on' && indent === 2) {
      const key = /^([A-Za-z_][\w-]*):/.exec(body);
      if (key !== null) triggers.push(key[1] as string);
      continue;
    }
    if (section !== 'jobs') continue;
    if (indent === 2) {
      closeStep();
      inSteps = false;
      const key = /^([A-Za-z_][\w-]*):/.exec(body);
      job = key === null ? null : (key[1] as string);
      // The position is the step's place in ITS OWN job's `steps` sequence,
      // which is what a reader of the job's log counts.
      index = -1;
      if (job !== null) jobs.push(job);
      continue;
    }
    if (job === null) continue;
    if (indent === 4) {
      closeStep();
      inSteps = /^steps:/.test(body);
      if (/^if:/.test(body)) jobConditional.push(job);
      if (/^continue-on-error:/.test(body)) jobContinueOnError.push(job);
      continue;
    }
    if (!inSteps) continue;
    if (indent === 6 && body.startsWith('- ')) {
      closeStep();
      index += 1;
      current = { name: null, run: null, conditional: false, continueOnError: false };
    }
    if (current === null) continue;
    const entry = /^(?:-\s+)?([A-Za-z_][\w-]*):(.*)$/.exec(body);
    if (entry === null) continue;
    const key = entry[1] as string;
    const rest = (entry[2] ?? '').trim();
    if (key === 'if') current.conditional = true;
    if (key === 'continue-on-error') current.continueOnError = true;
    if (key === 'name' && rest !== '') current.name = unquote(rest);
    if (key === 'run') {
      if (/^[|>][+-]?\d*$/.test(rest)) blockKey = { indent, key: 'run' };
      else current.run = unquote(rest);
    }
  }
  closeBlock();
  closeStep();
  return { triggers, jobs, steps, jobConditional, jobContinueOnError };
}

/**
 * THE LAW: this gate is in required CI in the same visible, unconditional way
 * the gate steps around it are. Empty means the step really does gate every
 * push and pull request.
 *
 * A previous slice shipped a gate that was in no required job at all, so every
 * green tick reported for it was green for a workflow that never ran it. Each
 * claim below is one of the ways that can be true again.
 */
export function requiredCiProblems(text: string): string[] {
  const problems: string[] = [];
  const doc = readWorkflow(text);
  for (const event of ['push', 'pull_request'])
    if (!doc.triggers.includes(event)) problems.push(`${WORKFLOW} does not trigger on ${event} — a step inside it could not gate an ordinary ${event}`);
  if (!doc.jobs.includes(REQUIRED_JOB)) return [...problems, `${WORKFLOW} has no \`${REQUIRED_JOB}\` job — the required job is where every slice gate runs`];
  if (doc.jobConditional.includes(REQUIRED_JOB)) problems.push(`the \`${REQUIRED_JOB}\` job is conditional, so the whole chain can be skipped`);
  if (doc.jobContinueOnError.includes(REQUIRED_JOB))
    problems.push(`the \`${REQUIRED_JOB}\` job carries continue-on-error, so every gate inside it can fail without failing the job`);

  const running = (script: string): WorkflowStep[] => doc.steps.filter((s) => s.run !== null && s.run.includes(script));
  const all = running(S4_SCRIPT);
  if (all.length === 0)
    return [
      ...problems,
      `no step of ${WORKFLOW} runs the P4-S4 gate (${S4_SCRIPT}) — a green workflow is not evidence for a gate the workflow never ran, and this is one of the two defects this slice is correcting`,
    ];
  for (const stray of all.filter((s) => s.job !== REQUIRED_JOB))
    problems.push(`the P4-S4 gate runs in the \`${stray.job}\` job, which is not the required \`${REQUIRED_JOB}\` job`);
  const here = all.filter((s) => s.job === REQUIRED_JOB);
  if (here.length === 0) return [...problems, `the P4-S4 gate is in ${WORKFLOW} but not in the required \`${REQUIRED_JOB}\` job, so it gates nothing`];
  if (here.length > 1)
    problems.push(`the \`${REQUIRED_JOB}\` job runs the P4-S4 gate ${here.length} times — which of them the verdict rests on is undecidable`);
  for (const step of here) {
    if (step.continueOnError) problems.push(`the P4-S4 gate step (#${step.index + 1}) carries continue-on-error, so a red gate leaves the required job green`);
    if (step.conditional) problems.push(`the P4-S4 gate step (#${step.index + 1}) is conditional, so an ordinary push or pull_request can skip it`);
    if ((step.run ?? '').trim() !== S4_COMMAND) problems.push(`the P4-S4 gate step runs \`${(step.run ?? '').trim()}\`, not exactly \`${S4_COMMAND}\``);
    if (step.name !== S4_STEP_NAME)
      problems.push(
        `the P4-S4 gate step (#${step.index + 1}) is named \`${String(step.name)}\`, not \`${S4_STEP_NAME}\` — a renamed gate step is one a reader of the required job's log cannot identify as this slice's`,
      );
  }
  // Chain composition IS the order: the predecessor runs first, in the same job.
  const predecessor = running(S3_SCRIPT).filter((s) => s.job === REQUIRED_JOB)[0];
  const mine = here[0];
  if (predecessor === undefined)
    problems.push(
      `no step of the required \`${REQUIRED_JOB}\` job runs ${S3_SCRIPT} — chain composition inside the one required job is what TL-P4-S2-R3 authorized in place of a delta gate re-executing its predecessor`,
    );
  else if (mine !== undefined && mine.index <= predecessor.index)
    problems.push(
      `the P4-S4 gate step (#${mine.index + 1}) does not come after the P4-S3 gate step (#${predecessor.index + 1}) — chain composition requires the predecessor to run first`,
    );
  return problems;
}

/** The measured position, on a pass as well as on a failure. */
export function requiredCiReport(root: string): string {
  if (!has(root, WORKFLOW)) return `${WORKFLOW} is missing`;
  const doc = readWorkflow(read(root, WORKFLOW));
  const mine = doc.steps.filter((s) => s.job === REQUIRED_JOB && (s.run ?? '').includes(S4_SCRIPT))[0];
  const pred = doc.steps.filter((s) => s.job === REQUIRED_JOB && (s.run ?? '').includes(S3_SCRIPT))[0];
  const total = doc.steps.filter((s) => s.job === REQUIRED_JOB).length;
  return `${doc.jobs.length} job(s), ${total} step(s) in \`${REQUIRED_JOB}\`; P4-S3 at step ${pred === undefined ? 'absent' : String(pred.index + 1)}, P4-S4 at step ${
    mine === undefined ? 'ABSENT' : String(mine.index + 1)
  }; continue-on-error: ${String(mine?.continueOnError ?? 'n/a')}, if: ${String(mine?.conditional ?? 'n/a')}`;
}

// ───── THE ROSTER, DERIVED FROM THE TREE ──────────────────────────────────
// A hand-written list silently misses the suite a sibling adds — and five
// agents are writing P4-S4 in five worktrees while this gate is written. So
// the roster is DERIVED, by one stated rule, and the derived set is required to
// be non-empty and is printed on every run.

/** The root Vitest config's `include` is `tests/**\/*.test.ts`: a file that does not match it is a suite nothing executes. */
const RUNNABLE = /\.test\.ts$/;
/** Anything the runner could plausibly be meant to pick up, so a near-miss (`.spec.ts`, `.test.tsx`) is a finding rather than a silent drop. */
const SUITE_LIKE = /\.(?:test|spec)\.[tj]sx?$/;

/**
 * THE RULE: a file under `tests/` whose BASENAME begins `p4s4-`,
 * `customer-s4-` or `phase4-customer-`. Anchored at the basename, so no other
 * slice's suites are swept in and the directory a sibling chooses does not
 * matter.
 */
const S4_BASENAME = /^(?:p4s4-|customer-s4-|phase4-customer-)/;

/** Plus this slice's golden directory, whatever its files are called: goldens are named by position, not by slice prefix. */
export const S4_GOLDEN_DIR = 'tests/golden-regression/phase4-s4';

/**
 * Plus ONE named row that no naming rule would find: the suite that asserts —
 * by parsing the workflow — that the required `backend` job really runs the
 * slice gates of the chain behind this one, in order. This gate's own place in
 * that job is asserted by `check:required-ci` here and by
 * `tests/guards/p4s4-required-ci.test.ts`, which the basename rule finds.
 */
export const CI_COMPOSITION_SUITE = 'tests/guards/required-ci-chain-composition.test.ts';

/** Every file under `dir`, recursively, as repo-relative paths. */
function walk(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absolute).sort()) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

export interface Discovery {
  /** The files the rule matched and the runner would execute. */
  readonly suites: readonly string[];
  /** Suite-like files the rule matched that the ROOT runner would never pick up — a finding, never an omission. A non-suite helper is not one of these. */
  readonly unrunnable: readonly string[];
}

/** The rule, applied. Nothing here is written down: the set is whatever the tree holds today. */
export function discoverS4Suites(root: string): Discovery {
  const matched = new Set<string>();
  const unrunnable: string[] = [];
  for (const file of walk(root, 'tests')) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    const inGoldenDir = file.startsWith(`${S4_GOLDEN_DIR}/`);
    if (!S4_BASENAME.test(base) && !inGoldenDir) continue;
    if (RUNNABLE.test(base)) matched.add(file);
    // A matched file the runner would not execute is a finding only when it
    // LOOKS LIKE A SUITE (`.spec.ts`, `.test.tsx`, …): that is a suite the
    // runner silently drops. A plain `.ts` in the golden directory is a
    // SHARED HELPER, which is the accepted pattern there — the P4-S2 goldens
    // keep `harness.ts`, `sale-path.ts` and `atomic-sale-law.ts` beside their
    // suites and import from them. The test is still derived from the tree:
    // it asks what the file is NAMED, never which names are allowed.
    else if (SUITE_LIKE.test(base)) unrunnable.push(file);
  }
  return { suites: [...matched].sort(), unrunnable: unrunnable.sort() };
}

/** The roster the runner is handed: the derived set, plus the one named CI-composition row. */
export function rosterFiles(root: string): string[] {
  return [...new Set([...discoverS4Suites(root).suites, CI_COMPOSITION_SUITE])].sort();
}

/** The derived roster as rows for the P4-S2 executor. */
export function rosterRows(root: string): readonly SuiteRow[] {
  return rosterFiles(root).map((file) => ({
    id: file,
    file,
    claim: `a P4-S4 suite discovered by the roster rule: ${file}`,
    proof: file,
  }));
}

/** The derivation, and the three ways it can be wrong: it found nothing, it found a suite nothing runs, or the named row is gone. */
export function rosterProblems(root: string): string[] {
  const problems: string[] = [];
  const { suites, unrunnable } = discoverS4Suites(root);
  for (const file of unrunnable)
    problems.push(`${file} matches the P4-S4 roster rule but not the root runner's include (tests/**/*.test.ts) — it would be committed and never executed`);
  if (suites.length === 0)
    problems.push(
      'the P4-S4 roster rule matched no suite — a derived roster with no subject is not a pass (the rule is: a file under tests/ whose basename begins `p4s4-`, `customer-s4-` or `phase4-customer-`, plus every test file in tests/golden-regression/phase4-s4)',
    );
  if (!has(root, CI_COMPOSITION_SUITE))
    problems.push(`${CI_COMPOSITION_SUITE} is missing — nothing would then assert that the chain behind this gate is in the required job at all`);
  return problems;
}

/** What the derivation found, printed on a PASS as well as on a FAIL: a roster nobody can read is a roster nobody can audit. */
export function rosterReport(root: string): string {
  const { suites, unrunnable } = discoverS4Suites(root);
  return `${suites.length} derived + 1 named (${CI_COMPOSITION_SUITE}) = ${rosterFiles(root).length} file(s): ${rosterFiles(root).join(', ') || 'none'}${
    unrunnable.length === 0 ? '' : `; ${unrunnable.length} matched file(s) the runner would NOT execute: ${unrunnable.join(', ')}`
  }`;
}

/** A rostered file that is a LAW: it reads the tree and must prove it can refuse one. */
const isLaw = (file: string): boolean => file.startsWith('tests/guards/');

/**
 * The shapes this repository's laws actually announce a planted defect in, read
 * off the suites rather than prescribed to them (the correction the coordinator
 * made to the same check on the P4-S3 gate): `RED:` / `red:` and `PLANTED`,
 * and the numbered-rule form the refusal catalogue uses throughout.
 */
const PLANTED_DEFECT_TITLE = /\b(?:red|planted)\b|\brule\s+\d+[a-z]?\b.*\b(?:names|name|fire|fires|satisfied|cannot)\b/i;

/**
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. A law with no planted
 * defect asserts something nobody has shown is falsifiable. Scoped to
 * `tests/guards/`: an integration suite exercises a route and a performance
 * suite measures a budget, and neither plants a defect in the tree at all.
 */
export function rosterRedProofProblems(root: string): string[] {
  const problems: string[] = [];
  for (const file of rosterFiles(root)) {
    if (!has(root, file)) {
      problems.push(`${file} is on the roster and does not exist`);
      continue;
    }
    const titles = testTitles(read(root, file));
    if (titles.length === 0) {
      problems.push(`${file} holds no runnable it( title — a file the runner opens and finds nothing in is not evidence`);
      continue;
    }
    if (!isLaw(file)) continue;
    if (!titles.some((t) => PLANTED_DEFECT_TITLE.test(t)))
      problems.push(
        `${file} is a law on this roster and no it( title announces a planted defect — a law with no demonstrated red is a law nobody has shown can refuse anything`,
      );
  }
  return problems;
}

// ───── EXECUTION ──────────────────────────────────────────────────────────

/** One execution per root per process: the check reads the verdict, the report line reads the numbers. */
const executions = new Map<string, SuiteExecution>();
export function s4Execution(root: string): SuiteExecution {
  const cached = executions.get(root);
  if (cached !== undefined) return cached;
  // `executeSuites` spawns ONE bounded Vitest run with `stdio: 'pipe'` and
  // reads `status`, `signal` and `error` off the RESULT OBJECT. No shell, no
  // pipeline, no `tee`: the verdict cannot come from the last stage of
  // anything. It also refuses a skipped, todo or only-marked test, a run that
  // found no files, and a tally it could not read.
  const fresh = executeSuites(root, rosterRows(root));
  executions.set(root, fresh);
  return fresh;
}

const n = (v: number | null): string => (v === null ? 'unavailable' : String(v));

/** The measured numbers, on a pass as well as on a failure. */
export function executionReport(root: string): string {
  const e = s4Execution(root);
  const exit = e.error !== null ? `did not start (${e.error})` : e.signal !== null ? `killed by ${e.signal}` : e.ran ? `exited ${n(e.status)}` : 'was not run';
  return `${e.claimed} suite(s) claimed → ${e.resolved.length} file(s) resolved; the test process ${exit}; tests: ${n(e.tally.passed)} passed, ${n(e.tally.failed)} failed, ${n(e.tally.skipped)} skipped, ${n(e.tally.todo)} todo of ${n(e.tally.total)} across ${n(e.tally.files)} file(s) reported`;
}

/**
 * `executeSuites` labels its run-level findings `the P4-S2 roster (n file(s))`
 * — the label is a literal inside the predecessor gate and that file is not
 * this slice's to change. Relabel here rather than print a P4-S2 verdict out
 * of the P4-S4 gate: a reader who cannot tell which roster refused the tree
 * cannot act on the refusal.
 */
const relabel = (problem: string): string => problem.replace(/^the P4-S2 roster \((\d+) file\(s\)\)/, 'the P4-S4 roster ($1 file(s))');

function executionProblems(root: string): string[] {
  const e = s4Execution(root);
  // The roster must not shrink between the derivation and the run: a row that
  // resolved to nothing would leave the verdict standing on fewer files than
  // the report names.
  const missing = rosterFiles(root).filter((f) => !e.resolved.includes(f));
  return [...e.problems.map(relabel), ...missing.map((f) => `${f} was on the roster and was not handed to the runner`)];
}

// ───── TENSE AND CLOSURE ──────────────────────────────────────────────────

/** The slices BEHIND this one are accepted, and are asserted in that tense. All three boundaries are FLOORS by construction. */
export function acceptedTenseProblems(root: string): string[] {
  const problems = [...predecessorAcceptedTenseProblems(root)];
  if (Object.keys(S3_ACCEPTED).length === 0) problems.push('P4-S3 is accepted but S3_ACCEPTED is empty — the predecessor tense cannot be read');
  problems.push(...s3BoundaryProblems(root).map((p) => `P4-S3 boundary: ${p}`));
  return problems;
}

/** The two shapes a permanent Phase 4 module may never contain, turned on THIS file. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\.sql['"`]\s*\)\s*\)?\s*\.length\s*[=!<>]==?\s*\d+/, 'a count of .sql files compared with a literal'],
  [/frozenThrough\s*[=!]==/, 'a frozenThrough equality (it is a floor)'],
];
const stripProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/**
 * The closure rules, composed, plus this gate's own tense.
 *
 * The permanent-module sweep is DELEGATED to the P4-S3 gate, which delegates
 * P4-S2's and P4-S1's in turn — so the whole accepted chain's closure rules are
 * asserted here without a second copy of any of them. What is added is this
 * file's own obligations: it contains neither forbidden shape, names NO
 * migration numbered past the last ACCEPTED one (which is why the candidate
 * surface is discovered), and carries its candidate fence while `S4_ACCEPTED`
 * is empty.
 */
export function closureRuleProblems(root: string): string[] {
  const problems = [...predecessorClosureRuleProblems(root)];
  if (!has(root, SELF)) return [...problems, `${SELF} is missing`];
  const text = read(root, SELF);
  const code = stripProse(text);
  for (const [shape, why] of FORBIDDEN)
    if (shape.test(code)) problems.push(`${SELF} contains ${why} — a permanent invariant never bounds the future (P4-AL-60)`);
  const acceptedHead = Number((phase4PrefixEnd() ?? '0000').slice(0, 4));
  for (const m of code.matchAll(/['"`](\d{4})_[a-z0-9_]+\.sql['"`]/g))
    if (Number(m[1]) > acceptedHead)
      problems.push(
        `${SELF} names the migration ${m[0]}, which is past the last ACCEPTED migration — a gate does not pin a candidate, and only Tech Lead acceptance freezes one (P4-AL-60/61)`,
      );
  // The FENCE COMMENTS, not every mention: the diagnostics name the marker
  // too, and a function that counted its own error message would report a
  // surviving fence in the accepted tense for ever.
  const fences = text.split('\n').filter((l) => /^\s*\/\/\s*[─-]+\s*(?:end\s+)?CANDIDATE-TENSE \(P4-AL-61\)/.test(l)).length;
  const candidate = Object.keys(S4_ACCEPTED).length === 0;
  if (candidate && fences < 2)
    problems.push(
      `${SELF}: the candidate-tense block is not fenced between two "CANDIDATE-TENSE (P4-AL-61)" markers, so the acceptance commit cannot find what to delete`,
    );
  if (!candidate && fences > 0)
    problems.push(`${SELF}: P4-S4 is accepted and the candidate-tense block is still here — the acceptance commit deletes it (P4-AL-61)`);
  return problems;
}

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly run: (root: string) => string[];
  readonly ok: string;
  /** Measured numbers this check must report on a PASS as well as on a FAIL. */
  readonly note?: (root: string) => string;
}

export const CHECKS: readonly Check[] = [
  {
    id: 'frozen-prefix',
    title: 'the frozen migration prefix, by delegation to the accepted prefix modules',
    run: prefixProblems,
    ok: 'every accepted migration is intact byte for byte at its accepted digest, the manifest records the same digests, and frozenThrough is a floor — nothing is asserted about a candidate numbered past the accepted head',
  },
  {
    id: 'accepted-tense',
    title: 'the three slices behind this one, in the ACCEPTED tense (P4-AL-61)',
    run: acceptedTenseProblems,
    ok: 'P4-S1, P4-S2 and P4-S3 all hold their accepted digests, each accepted file still hashes to its accepted digest in the manifest and in the permanent prefix module, and frozenThrough has reached every slice head',
  },
  {
    id: 'candidate-tense',
    title: 'P4-S4 in the CANDIDATE tense (P4-AL-61)',
    run: candidateTenseProblems,
    note: candidateReport,
    ok: 'nothing of P4-S4 is digest-pinned by this gate or by the permanent prefix module, and the manifest freezes no candidate',
  },
  {
    id: 'new-relation-coverage',
    title: "the RLS/FORCE discovery law and G-3's vocabulary over the relations this slice adds",
    run: newRelationCoverageProblems,
    note: newRelationReport,
    ok: "every contract relation is admitted by the shared Phase 4 predicate with no registration, the discovery law's structural half is silent, every relation a candidate migration declares carries tenant_id, business_id, ENABLE, FORCE and REVOKE … FROM PUBLIC and clears the G-3 vocabulary, and both reducers' effective invoice edge is the three-column structural customer pin onto a non-partial invoices (business_id, id, customer_id)",
  },
  {
    id: 'required-ci',
    title: 'this gate is REQUIRED in CI, structurally',
    run: (root) => (has(root, WORKFLOW) ? requiredCiProblems(read(root, WORKFLOW)) : [`${WORKFLOW} is missing`]),
    note: requiredCiReport,
    ok: 'a step of the required `backend` job runs exactly `npm run gate:phase4:s4` under its ruled name, after the P4-S3 step, with no continue-on-error and no if:, on every push and pull request',
  },
  {
    id: 'roster',
    title: "P4-S4's suite roster, DERIVED from the tree by one stated rule",
    run: rosterProblems,
    note: rosterReport,
    ok: 'the rule matched at least one suite, every matched file is one the root runner executes, and the CI-composition suite is present',
  },
  {
    id: 'roster-red-proofs',
    title: 'every rostered law carries a planted-defect proof',
    run: rosterRedProofProblems,
    ok: 'every rostered file holds runnable it( titles and every rostered law has at least one announcing the planted defect it is proved red on',
  },
  {
    id: 'roster-execution',
    title: "P4-S4's suite roster, EXECUTED",
    run: executionProblems,
    note: executionReport,
    ok: 'every rostered file was handed to one bounded Vitest run whose exit status was read off the spawn result and not through a pipe, the process exited 0 without a signal, it found test files, and nothing failed, skipped or was left todo',
  },
  {
    id: 'closure-and-tense',
    title: 'the closure rules, composed, and this gate under its own (P4-AL-60 / P4-AL-61)',
    run: closureRuleProblems,
    ok: 'no permanent module bounds the future, this gate names no migration past the last accepted one, and its candidate-tense block is fenced for the acceptance commit to delete',
  },
];

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  const structuralOnly = args.includes('--structural-only');
  // The one RUNTIME check needs a cluster and a resolvable Vitest.
  // `--structural-only` suppresses it and the verdict below says it did NOT
  // run, which is not a pass.
  const RUNTIME = new Set(['roster-execution']);
  const checks = structuralOnly ? CHECKS.filter((c) => !RUNTIME.has(c.id)) : CHECKS;
  let failed = 0;
  for (const check of checks) {
    const problems = check.run(root);
    if (problems.length === 0) console.log(`ok   ${check.id} — ${check.title}: ${check.ok}`);
    else {
      failed += 1;
      console.error(`FAIL ${check.id} — ${check.title}\n  ${problems.join('\n  ')}`);
    }
    // The measured numbers, on both branches: a check that reports a tally only
    // when it is happy is a check nobody can audit.
    if (check.note !== undefined) console.log(`     ${check.id} measured: ${check.note(root)}`);
  }
  const skipped = CHECKS.length - checks.length;
  console.log(
    failed === 0
      ? `PASS gate:phase4:s4 at ${root}: ${checks.length} check(s) ok${skipped > 0 ? `; ${skipped} runtime check(s) NOT RUN (--structural-only) — not a pass` : ''}`
      : `FAIL gate:phase4:s4 at ${root}: ${failed} of ${checks.length} check(s) refuse this tree`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
