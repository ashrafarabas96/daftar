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
 * migration declared the narrow `(business_id, invoice_id)` edge inside
 * `CREATE TABLE` while the ownership question was open, and the corrective
 * migration ADDS the three-column edge BESIDE it with
 * `ALTER TABLE … ADD CONSTRAINT` once the ruling closed it. A law that read
 * only the `CREATE TABLE` body would report the narrow shape alone and call
 * the estate unpinned when it is not — a gate describing a database that does
 * not exist.
 *
 * THE LAW IS A PRESENCE LAW, AND THAT FOLLOWS FROM THE ESTATE'S OWN RULE. A
 * Phase 4 migration never drops a composite seam (P2-S8's accepted rule, in
 * `compositeFkProblems`), so the corrective cannot replace the narrow edge and
 * does not try: both edges exist, the narrow one redundant under the wide one,
 * and NEITHER SUPERSEDES THE OTHER. There is therefore no "last declaration"
 * to read and no effective edge to compute — a reader that took the last
 * declaration in file order would be answering a question the surface no
 * longer asks, and would flip its verdict on the order two independent
 * `ALTER TABLE`s happen to be written in. `structuralPinEdge` below instead
 * asks whether the three-column edge IS PRESENT among the declarations of that
 * reducer, and the law requires it to be validated (never `NOT VALID`),
 * immediate (never `DEFERRABLE`) and `ON DELETE RESTRICT`, requires the key it
 * targets to be declared NON-PARTIALLY by the same surface, and requires each
 * reducer's `customer_id` to be `NOT NULL`. A narrow edge beside it is not a
 * finding: it is what the no-drop rule obliges.
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
 * EVERY invoice edge `child` declares across the surface, as a pair of column
 * lists plus the trailing option text of that declaration (`ON DELETE …`,
 * `NOT VALID`, `DEFERRABLE …`).
 *
 * Two declaration forms count, because the pin legitimately arrives in two
 * steps across two migrations:
 *   — inside `CREATE TABLE child (… CONSTRAINT … FOREIGN KEY (…) REFERENCES invoices (…) …)`;
 *   — in `ALTER TABLE child ADD CONSTRAINT … FOREIGN KEY (…) REFERENCES invoices (…)`.
 *
 * ALL of them are returned and none supersedes another, because the estate's
 * no-drop rule means none can: a corrective adds an edge beside the one an
 * earlier migration declared, so what a database applying this surface ends up
 * with is the UNION, not the last one written.
 *
 * Only `ALTER TABLE` statements naming THIS child are considered, so one
 * reducer's edge is never read as the other's.
 */
export function declaredInvoiceEdges(sql: string, child: string): { child: string[]; parent: string[]; options: string }[] {
  const cols = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''))
      .filter((c) => c !== '');
  // The trailing group stops at the first `,`, `)` or `;`, which is where a
  // constraint's own clause ends in both declaration forms — so `ON DELETE
  // RESTRICT`, `NOT VALID` and `DEFERRABLE INITIALLY DEFERRED` are read, and
  // the NEXT constraint's text is not.
  const pattern = /foreign\s+key\s*\(([^)]*invoice_id[^)]*)\)\s*references\s+(?:public\.)?"?invoices"?\s*\(([^)]*)\)([^,;)]*)/gi;
  const edgesIn = (text: string): { child: string[]; parent: string[]; options: string }[] =>
    [...text.matchAll(pattern)].map((m) => ({ child: cols(m[1]), parent: cols(m[2]), options: (m[3] ?? '').trim() }));
  const found = edgesIn(createTableBody(sql, child) ?? '');
  const alter = new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:public\.)?"?${child}"?\b`, 'gi');
  for (const hit of sql.matchAll(alter)) found.push(...edgesIn(readSqlStatement(sql, hit.index) ?? ''));
  return found;
}

/** The three-column structural pin among `child`'s invoice edges, or null if the surface declares none. */
export function structuralPinEdge(sql: string, child: string): { child: string[]; parent: string[]; options: string } | null {
  return (
    declaredInvoiceEdges(sql, child).find(
      (e) => e.child.join(',') === 'business_id,invoice_id,customer_id' && e.parent.join(',') === 'business_id,id,customer_id',
    ) ?? null
  );
}

export function settlementContractProblems(sql: string): string[] {
  const declared = discoverSalesTables(sql);
  const settlement = CONTRACT_RELATIONS.filter((r) => declared.includes(r));
  if (settlement.length === 0) return [];
  const problems: string[] = [];

  // The structural customer pin: each reducer's three-column invoice edge is
  // PRESENT and has the standing the pin needs, the key it targets is declared
  // and non-partial, and the NOT NULL that makes the edge fire on every row is
  // there. Presence, not supersession — the no-drop rule means the narrow edge
  // stays beside it and neither replaces the other.
  for (const child of ['payment_allocations', 'customer_credit_applications'].filter((r) => settlement.includes(r))) {
    const edges = declaredInvoiceEdges(sql, child);
    if (edges.length === 0) {
      problems.push(
        `${child} declares no composite FOREIGN KEY … REFERENCES invoices (…) — cross-business linkage and the customer pin must be unrepresentable, not refused by the application layer`,
      );
      continue;
    }
    const pin = structuralPinEdge(sql, child);
    if (pin === null)
      problems.push(
        `${child} declares ${edges.length} invoice edge(s) — ${edges.map((e) => `(${e.child.join(', ')}) → invoices (${e.parent.join(', ')})`).join('; ')} — and none of them is ` +
          `the structural pin, which is (business_id, invoice_id, customer_id) → invoices (business_id, id, customer_id). That edge is what makes a ` +
          `cross-customer allocation and a settled walk-in invoice unrepresentable rather than refused. Without it both laws rest on ` +
          `${SETTLEMENT_VERIFIER}, which any writer that skips the routine gets past. It is ADDED BESIDE the narrow edge, never in place of it: ` +
          `a composite seam is never dropped`,
      );
    else {
      // The three facts that make a present edge an actual pin. Each one is a
      // way the edge reads correctly in the catalogue and holds less than it
      // appears to.
      if (/\bnot\s+valid\b/i.test(pin.options))
        problems.push(
          `${child}'s three-column invoice edge is added NOT VALID — an unvalidated edge pins the rows written after it and none of the rows ` +
            `already there, so a cross-customer settlement already on disk survives the pin that was supposed to make it unrepresentable`,
        );
      if (/\bdeferrable\b/i.test(pin.options) && !/\bnot\s+deferrable\b/i.test(pin.options))
        problems.push(
          `${child}'s three-column invoice edge is DEFERRABLE — a deferred edge makes the mismatch refusable at COMMIT, which is what ` +
            `${SETTLEMENT_VERIFIER} already did; the pin is worth adding only because it is IMMEDIATE and makes the row unrepresentable at the statement`,
        );
      if (!/\bon\s+delete\s+restrict\b/i.test(pin.options))
        problems.push(
          `${child}'s three-column invoice edge does not carry ON DELETE RESTRICT — the child-side action 0081 declared is carried over unchanged, ` +
            `and a CASCADE or SET NULL here would delete or blank a settlement row behind the ledger's back`,
        );
    }
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
  // The key the three-column edges target. PostgreSQL will not accept a PARTIAL
  // unique index as a foreign-key target, and the walk-in invoice carries a
  // NULL `customer_id` — which is why this key is declared NON-PARTIALLY and
  // needs no `WHERE`: it contains the primary key `(business_id, id)`, so it
  // is unique whatever the third column holds and validates on any data. A
  // surface that widened the edges without declaring the key could not apply.
  if (!/alter\s+table\s+(?:only\s+)?(?:public\.)?invoices\s+add\s+constraint\s+\w+\s+unique\s*\(\s*business_id\s*,\s*id\s*,\s*customer_id\s*\)/i.test(sql))
    problems.push(
      `the settlement surface pins the reducer edges onto invoices (business_id, id, customer_id) but never declares that key — ` +
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
 * THE MEASURED EVIDENCE STEPS, pinned exactly as the gate step is.
 *
 * The gate step was pinned and these were not, and the hole is the same one
 * TL-P4-S2-R1 ruled on one level up: a law that lives in a workflow step
 * nothing parses is a law anybody can delete, condition or neuter without a
 * single check going red. These two steps are where P4-D, P4-F and the AR
 * answer-equivalence verdicts come from, so a workflow that silently stops
 * running them is a workflow whose green tick carries no budget evidence at
 * all — and a budget nothing measured is indistinguishable from a budget that
 * passed.
 *
 * They must also run BEFORE the gate step, because a failing step skips every
 * step after it: measured first, then the equivalence, then the gate, which is
 * the order `ci.yml` already carries and the order the slice is measured in.
 */
export const S4_EVIDENCE_STEPS: readonly {
  readonly label: string;
  readonly script: string;
  readonly command: string;
  readonly name: string;
  /**
   * When the step runs `npm run <script>`, the workflow text is only HALF the
   * truth: the measurement is whatever `package.json` resolves that script to,
   * and that file is not the workflow. Pinning the step's `run:` and leaving
   * the script body free is the very defect this law was written to close, one
   * indirection down — `-t "P4-D"` inside the body deletes the P4-F
   * measurement with the workflow untouched. So a step that goes through npm
   * states the body it is allowed to have, exactly.
   */
  readonly scriptBody?: string;
}[] = [
  {
    label: 'the P4-D/P4-F measured budgets',
    script: 'perf:phase4:s4',
    command: 'npm run perf:phase4:s4',
    name: 'Receivables read budgets — P4-D and P4-F, measured',
    scriptBody: 'vitest run --reporter=verbose tests/performance/receivables-s4-budgets.test.ts',
  },
  {
    label: 'the set-based AR answer equivalence',
    script: 'tests/performance/receivables-ar-setbased-equivalence.test.ts',
    command: 'npx vitest run tests/performance/receivables-ar-setbased-equivalence.test.ts',
    name: 'Set-based AR answer equivalence — the 0083/0084 readers against the per-invoice original',
  },
];

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
  const mine = here[0];
  // The measured evidence steps carry this slice's budget and equivalence
  // verdicts, so each is pinned the same way the gate step above is: present
  // exactly once in the required job, unconditional, unable to fail silently,
  // exact command, exact name, and ahead of the gate.
  for (const ev of S4_EVIDENCE_STEPS) {
    const found = running(ev.script);
    if (found.length === 0) {
      problems.push(
        `no step of ${WORKFLOW} runs ${ev.label} (${ev.script}) — a green workflow is not evidence for a measurement the workflow never took, and a budget nothing measured is indistinguishable from a budget that passed`,
      );
      continue;
    }
    for (const stray of found.filter((s) => s.job !== REQUIRED_JOB))
      problems.push(`${ev.label} runs in the \`${stray.job}\` job, which is not the required \`${REQUIRED_JOB}\` job`);
    const inJob = found.filter((s) => s.job === REQUIRED_JOB);
    if (inJob.length === 0) {
      problems.push(`${ev.label} is in ${WORKFLOW} but not in the required \`${REQUIRED_JOB}\` job, so it measures nothing the repository requires`);
      continue;
    }
    if (inJob.length > 1)
      problems.push(`the \`${REQUIRED_JOB}\` job runs ${ev.label} ${inJob.length} times — which of them the verdict rests on is undecidable`);
    for (const step of inJob) {
      if (step.continueOnError)
        problems.push(`${ev.label} (step #${step.index + 1}) carries continue-on-error, so a missed budget leaves the required job green`);
      if (step.conditional) problems.push(`${ev.label} (step #${step.index + 1}) is conditional, so an ordinary push or pull_request can skip the measurement`);
      if ((step.run ?? '').trim() !== ev.command) problems.push(`${ev.label} runs \`${(step.run ?? '').trim()}\`, not exactly \`${ev.command}\``);
      if (step.name !== ev.name)
        problems.push(
          `${ev.label} (step #${step.index + 1}) is named \`${String(step.name)}\`, not \`${ev.name}\` — a renamed measured step is one a reader of the required job's log cannot identify as this slice's evidence`,
        );
      if (mine !== undefined && step.index >= mine.index)
        problems.push(
          `${ev.label} (step #${step.index + 1}) does not come before the P4-S4 gate step (#${mine.index + 1}) — a failing step skips every step after it, so the measurement has to be taken first`,
        );
    }
  }
  // Chain composition IS the order: the predecessor runs first, in the same job.
  const predecessor = running(S3_SCRIPT).filter((s) => s.job === REQUIRED_JOB)[0];
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

/**
 * The OTHER half of pinning a measured step: the npm script it runs through.
 *
 * `requiredCiProblems` reads `.github/workflows/ci.yml` and can only pin what
 * the workflow says. A step whose `run:` is `npm run perf:phase4:s4` measures
 * whatever `package.json` resolves that name to, and nothing in the workflow
 * constrains it. Adding `-t "P4-D"` to the body there leaves the workflow
 * byte-identical, every assertion of `tests/guards/p4s4-required-ci.test.ts`
 * green, and the P4-F budget unmeasured — a budget nothing measured being
 * indistinguishable from a budget that passed.
 */
export function evidenceScriptBodyProblems(root: string): string[] {
  const problems: string[] = [];
  const MANIFEST = 'package.json';
  if (!has(root, MANIFEST)) return [`${MANIFEST} is missing, so the body of every measured npm script is unstated`];
  let scripts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(read(root, MANIFEST));
    const bag = (parsed as { scripts?: unknown }).scripts;
    scripts = typeof bag === 'object' && bag !== null ? (bag as Record<string, unknown>) : {};
  } catch (e) {
    return [`${MANIFEST} does not parse, so the body of every measured npm script is unstated: ${String(e)}`];
  }
  for (const ev of S4_EVIDENCE_STEPS) {
    if (ev.scriptBody === undefined) continue;
    const body = scripts[ev.script];
    if (body === undefined) {
      problems.push(
        `${MANIFEST} declares no \`${ev.script}\` script, so the required step \`${ev.command}\` runs nothing — ${ev.label} would not be measured at all`,
      );
      continue;
    }
    if (typeof body !== 'string') {
      problems.push(`${MANIFEST}'s \`${ev.script}\` is not a string, so what ${ev.label} runs is undecidable`);
      continue;
    }
    if (body.trim() !== ev.scriptBody)
      problems.push(
        `${MANIFEST}'s \`${ev.script}\` is \`${body.trim()}\`, not exactly \`${ev.scriptBody}\` — the workflow pins the step and this pins what the step runs, so a filter, a renamed suite or a narrowed path cannot delete ${ev.label} behind an unchanged workflow`,
      );
  }
  return problems;
}

/** What each measured npm script resolves to, printed on a pass as well as a failure. */
export function evidenceScriptBodyReport(root: string): string {
  if (!has(root, 'package.json')) return 'package.json is missing';
  let scripts: Record<string, unknown> = {};
  try {
    const bag = (JSON.parse(read(root, 'package.json')) as { scripts?: unknown }).scripts;
    if (typeof bag === 'object' && bag !== null) scripts = bag as Record<string, unknown>;
  } catch {
    return 'package.json does not parse';
  }
  const pinned = S4_EVIDENCE_STEPS.filter((e) => e.scriptBody !== undefined);
  return `${pinned.length} measured npm script(s) pinned: ${pinned.map((e) => `${e.script} → ${String(scripts[e.script] ?? 'ABSENT')}`).join('; ')}`;
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

// ───── THE REFUSAL-AUDIT LAW (P4-AL-48) ───────────────────────────────────
//
// «A refusal is audited as heavily as a success, because the forged-total and
// over-cap attempts are the ones worth seeing.» Until P4-S4 only the
// RECEIVABLES commands obeyed it, and the reason was structural rather than an
// oversight: every Phase 4 audit row is written by the SQL routine itself, as
// its LAST step, after every one of its `RAISE EXCEPTION`s — `0078:1002` for
// `sale_commit` (after 33 raises), `0079:954` and `0079:1022` for the two ends
// of a till session (after 7 and 6). A `RAISE` aborts the transaction, so a
// refused command persisted no evidence at all.
//
// THIS LAW IS A DISCOVERY AND NOT A LIST. It finds the Phase 4 commands in the
// code — the service methods that exercise a Phase 4 `invctl/1` operation —
// and requires each one's refusal path to reach the ONE refusal-audit
// composer. A later slice that adds a command is covered by the law on the day
// it lands, with no registration here; a check that enumerated what this slice
// happened to see would go quietly vacuous the moment P4-S5 adds a refund.
//
// It is LOUD when it finds nothing. A derived law with no subject is not a
// pass, and «the discovery found no command» is the way this check fails most
// dangerously — it would be the only failure that looks like success.

/** Where the API's services live. The law reads this tree and nothing else. */
export const API_MODULES = 'apps/api/src/modules';
/** The DECLARED Phase 4 operation vocabulary, which is where the subject set comes from. */
export const OPERATION_VOCABULARY = 'packages/inventory/src/payload.ts';
/** The ONE composer. Every surface's `auditThenRethrow…` must be a binding of it. */
export const REFUSAL_AUDIT_MODULE = `${API_MODULES}/audit/refusal-audit.ts`;

/**
 * Every character inside a comment, a string or a template literal, blanked —
 * newlines kept, so indices and line numbers still line up with the original.
 *
 * Brace- and paren-matching over raw TypeScript is wrong the moment a SQL
 * template holds a `{`, and `'sale.commit'` inside a comment is not an
 * authorization. Everything structural below reads the MASK and everything
 * textual reads the ORIGINAL at the mask's indices, so neither question is
 * answered with the other's text.
 */
export function maskLiterals(text: string): string {
  const out = text.split('');
  const n = text.length;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** The index just past the `)` that closes the `(` at `open`, or null. */
function closeParen(mask: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    if (mask[i] === '(') depth += 1;
    else if (mask[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** The index just past the `}` that closes the `{` at `open`, or null. */
function closeBrace(mask: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    if (mask[i] === '{') depth += 1;
    else if (mask[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** The `{` that opens a CLASS METHOD's body, starting the scan after its parameter list. */
function bodyBrace(mask: string, after: number): number | null {
  let angle = 0;
  for (let i = after; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === ';' && angle === 0)
      return null; // an interface's method SIGNATURE: no body at all.
    else if (ch === '{' && angle === 0) {
      const end = closeBrace(mask, i);
      if (end === null) return null;
      // The body's `}` closes at column 2 in this tree's formatting; a return
      // type's (`): { readonly a: string } {`) closes mid-line. That is what
      // tells a body brace from a type brace without parsing types.
      if (mask.slice(Math.max(0, end - 4), end).endsWith('\n  }')) return i;
    }
  }
  return null;
}

/** One method of one file: its name and the ORIGINAL and MASKED text of its body. */
export interface MethodBody {
  readonly name: string;
  readonly body: string;
  readonly mask: string;
}

const METHOD_SIGNATURE = /^ {2}(?:(?:public|private|protected) )?(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\(/gm;

/**
 * The class methods of one file — every one of them, whichever class it
 * belongs to, because a file's methods are what the reachability below walks
 * and a `this.x(` call cannot cross a file.
 */
export function methodBodies(text: string): MethodBody[] {
  const mask = maskLiterals(text);
  const out: MethodBody[] = [];
  for (const m of mask.matchAll(METHOD_SIGNATURE)) {
    const name = m[1] as string;
    if (name === 'constructor' || name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch') continue;
    const open = m.index + m[0].length - 1;
    const params = closeParen(mask, open);
    if (params === null) continue;
    const brace = bodyBrace(mask, params);
    if (brace === null) continue;
    const end = closeBrace(mask, brace);
    if (end === null) continue;
    out.push({ name, body: text.slice(brace, end), mask: mask.slice(brace, end) });
  }
  return out;
}

/**
 * The DECLARED Phase 4 operation vocabulary, read off its own type unions.
 *
 * `InventoryP4S2OperationCode`, `…S3…`, `…S4…` — and whatever a later slice
 * declares, because the pattern is the slice number and not a list. This is
 * the one place the law learns which operations are Phase 4's, so adding
 * `customer.refund` to the vocabulary adds it to this law's subject.
 */
export function phase4OperationCodes(root: string): string[] {
  if (!has(root, OPERATION_VOCABULARY)) return [];
  const text = read(root, OPERATION_VOCABULARY);
  const codes = new Set<string>();
  for (const m of text.matchAll(/export type InventoryP4S\d+OperationCode\s*=([^;]+);/g))
    for (const q of (m[1] as string).matchAll(/'([a-z]+\.[a-z_]+)'/g)) codes.add(q[1] as string);
  return [...codes].sort();
}

/** Every `.ts` file directly under `dir`, as repo-relative paths. */
function filesIn(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((e) => e.endsWith('.ts') && statSync(join(absolute, e)).isFile())
    .sort()
    .map((e) => `${dir}/${e}`);
}

/** The module directories of the API, discovered. */
export function apiModuleDirs(root: string): string[] {
  const absolute = join(root, API_MODULES);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((e) => statSync(join(absolute, e)).isDirectory())
    .sort()
    .map((e) => `${API_MODULES}/${e}`);
}

/**
 * The Phase 4 operations an `authorize(…)` argument names.
 *
 * A literal answers itself. Anything else — `PosCartService.OP_CODE[command]`,
 * `receivablesOperationCode(CUSTOMER_COLLECT_PAYMENT_OP)` — is resolved
 * through the constants of its own MODULE DIRECTORY, which is where this
 * tree's operation constants live. Scoped to the directory on purpose: a
 * global name table would let one module's constant answer another module's
 * identifier.
 */
function resolveOperations(argument: string, ops: readonly string[], constants: ReadonlyMap<string, readonly string[]>): string[] {
  const found = new Set<string>();
  for (const q of argument.matchAll(/'([a-z]+\.[a-z_]+)'/g)) if (ops.includes(q[1] as string)) found.add(q[1] as string);
  for (const id of argument.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) for (const op of constants.get(id[1] as string) ?? []) found.add(op);
  return [...found].sort();
}

/** `name → the Phase 4 operations its declaration mentions`, over one directory. */
function directoryConstants(root: string, dir: string, ops: readonly string[]): Map<string, readonly string[]> {
  const table = new Map<string, readonly string[]>();
  for (const file of filesIn(root, dir)) {
    const text = read(root, file);
    for (const m of text.matchAll(/(?:const|readonly)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*([^;]{0,4000})/g)) {
      const named: string[] = [];
      for (const q of (m[2] as string).matchAll(/'([a-z]+\.[a-z_]+)'/g)) if (ops.includes(q[1] as string)) named.push(q[1] as string);
      if (named.length > 0) table.set(m[1] as string, [...new Set(named)].sort());
    }
  }
  return table;
}

/** One discovered Phase 4 command path. */
export interface CommandPath {
  readonly file: string;
  /** The entry method a route calls — the command itself. */
  readonly method: string;
  /** The Phase 4 operations it exercises, directly or through its own private helpers. */
  readonly operations: readonly string[];
  /** Whether its refusal path reaches the one composer. */
  readonly audits: boolean;
}

/** The pattern of the ONE composer family. `refusal-audit.ts` defines it; each surface binds it under its own name. */
const COMPOSER_CALL = /\bauditThenRethrow[A-Za-z]*\s*\(/;

/**
 * THE DISCOVERY.
 *
 * A **Phase 4 command** is an ENTRY method of an API service — one no other
 * method of its own file calls, so a route is the only thing that can reach it
 * — whose own body or that of a helper it calls exercises a Phase 4 `invctl/1`
 * operation. That is the definition the code already carries: a command is the
 * thing that authorizes an operation, and a READ authorizes none, which is why
 * `TillSessionService.read` and `PosCartService.readCart` are not subjects
 * here without being named as exceptions.
 */
export function discoverPhase4Commands(
  ops: readonly string[],
  sources: readonly { readonly file: string; readonly text: string }[],
  constantsFor: (file: string) => ReadonlyMap<string, readonly string[]>,
): CommandPath[] {
  const commands: CommandPath[] = [];
  for (const { file, text } of sources) {
    const methods = methodBodies(text);
    if (methods.length === 0) continue;
    const constants = constantsFor(file);
    const byName = new Map<string, MethodBody>(methods.map((m) => [m.name, m]));
    const callees = new Map<string, string[]>();
    const called = new Set<string>();
    const operations = new Map<string, string[]>();
    const audits = new Set<string>();
    for (const m of methods) {
      const names: string[] = [];
      for (const c of m.mask.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        names.push(c[1] as string);
        called.add(c[1] as string);
      }
      callees.set(m.name, names);
      const own: string[] = [];
      for (const a of m.mask.matchAll(/\bauthorize\s*\(/g)) {
        const end = closeParen(m.mask, a.index + a[0].length - 1);
        if (end === null) continue;
        own.push(...resolveOperations(m.body.slice(a.index, end), ops, constants));
      }
      operations.set(m.name, own);
      if (COMPOSER_CALL.test(m.mask)) audits.add(m.name);
    }
    for (const m of methods) {
      if (called.has(m.name)) continue; // not an entry: its own file reaches it.
      // Everything this entry can reach inside its own file, which is the
      // whole of one command: a service's private helpers are where the
      // authorization and the catch actually sit.
      const seen = new Set<string>([m.name]);
      const queue = [m.name];
      while (queue.length > 0) {
        for (const next of callees.get(queue.pop() as string) ?? []) {
          if (seen.has(next) || !byName.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      const exercised = [...new Set([...seen].flatMap((n) => operations.get(n) ?? []))].sort();
      if (exercised.length === 0) continue;
      commands.push({ file, method: m.name, operations: exercised, audits: [...seen].some((n) => audits.has(n)) });
    }
  }
  return commands.sort((a, b) => `${a.file}#${a.method}`.localeCompare(`${b.file}#${b.method}`));
}

/** The discovery, applied to a tree. */
export function phase4Commands(root: string): CommandPath[] {
  const ops = phase4OperationCodes(root);
  if (ops.length === 0) return [];
  const sources: { file: string; text: string }[] = [];
  const constants = new Map<string, ReadonlyMap<string, readonly string[]>>();
  for (const dir of apiModuleDirs(root)) {
    const table = directoryConstants(root, dir, ops);
    for (const file of filesIn(root, dir)) {
      if (!file.endsWith('.service.ts')) continue;
      sources.push({ file, text: read(root, file) });
      constants.set(file, table);
    }
  }
  return discoverPhase4Commands(ops, sources, (file) => constants.get(file) ?? new Map());
}

/**
 * Every `auditThenRethrow…` in the API, and the module it is defined in.
 *
 * The law's second half: there is ONE composer. A surface may bind it under
 * its own name — `auditThenRethrowSellingRefusal`,
 * `auditThenRethrowReceivablesRefusal` — but a binding that does not go
 * through `refusal-audit.ts` is a second mechanism with a second order of
 * operations, and the thing P4-AL-48(a) promises is a property of that order.
 */
export function composerDefinitions(root: string): { readonly file: string; readonly delegates: boolean }[] {
  const out: { file: string; delegates: boolean }[] = [];
  for (const dir of apiModuleDirs(root))
    for (const file of filesIn(root, dir)) {
      if (file === REFUSAL_AUDIT_MODULE) continue;
      const text = read(root, file);
      if (!/export\s+(?:async\s+)?function\s+auditThenRethrow[A-Za-z]*\s*\(/.test(text)) continue;
      out.push({ file, delegates: /from '(?:\.\.?\/)+audit\/refusal-audit'/.test(text) && COMPOSER_CALL.test(maskLiterals(text)) });
    }
  return out;
}

/** Everything the law judges, as a value — so a test can plant a defect in it without mutating the tree. */
export interface RefusalAuditSubject {
  /** The declared Phase 4 operation vocabulary. */
  readonly ops: readonly string[];
  /** Whether the ONE composer module is in the tree at all. */
  readonly composerModule: boolean;
  /** The discovered command paths. */
  readonly commands: readonly CommandPath[];
  /** The surface bindings of the composer, and whether each delegates to it. */
  readonly bindings: readonly { readonly file: string; readonly delegates: boolean }[];
}

/**
 * The law, and the four ways it can be broken: the vocabulary is unreadable,
 * the composer is gone, the discovery has NO SUBJECT, or a discovered command
 * does not audit — plus the second-mechanism arm.
 *
 * It is a pure function of the subject so that
 * `tests/guards/p4s4-command-refusal-audit-law.test.ts` can plant each defect
 * and require the law to name it. A law whose only entry point reads the real
 * tree can be proved green and never proved capable of red.
 */
export function refusalAuditProblems(subject: RefusalAuditSubject): string[] {
  const problems: string[] = [];
  if (subject.ops.length === 0)
    problems.push(
      `${OPERATION_VOCABULARY} declares no InventoryP4S<n>OperationCode union — the law cannot learn which operations are Phase 4's, so it has no subject and that is not a pass`,
    );
  if (!subject.composerModule) problems.push(`${REFUSAL_AUDIT_MODULE} is missing — there is then no ONE composer for a command's refusal path to reach`);
  if (subject.commands.length === 0)
    problems.push(
      'the Phase 4 command discovery matched no service method — a derived law with no subject is not a pass (the rule is: an entry method of a *.service.ts under apps/api/src/modules that authorizes an operation of a declared InventoryP4S<n>OperationCode union, directly or through a helper of its own file)',
    );
  for (const c of subject.commands)
    if (!c.audits)
      problems.push(
        `${c.file}: ${c.method} exercises Phase 4 operation(s) ${c.operations.join(', ')} and its refusal path reaches no auditThenRethrow… composer — a refused ${c.operations[0] ?? 'command'} would persist no audit evidence (P4-AL-48)`,
      );
  for (const d of subject.bindings)
    if (!d.delegates)
      problems.push(
        `${d.file} declares its own auditThenRethrow… and does not delegate to ${REFUSAL_AUDIT_MODULE} — that is a second refusal-audit mechanism (P4-AL-48(a))`,
      );
  return problems;
}

/** The subject, read off a tree. */
export function refusalAuditSubject(root: string): RefusalAuditSubject {
  return {
    ops: phase4OperationCodes(root),
    composerModule: has(root, REFUSAL_AUDIT_MODULE),
    commands: phase4Commands(root),
    bindings: composerDefinitions(root),
  };
}

/** The law, applied to a tree. */
export function commandRefusalAuditProblems(root: string): string[] {
  return refusalAuditProblems(refusalAuditSubject(root));
}

/** What the discovery found, printed on a PASS as well as on a FAIL. */
export function commandRefusalAuditReport(root: string): string {
  const ops = phase4OperationCodes(root);
  const commands = phase4Commands(root);
  const bindings = composerDefinitions(root);
  return `${ops.length} declared Phase 4 operation(s) (${ops.join(', ') || 'none'}); ${commands.length} command path(s) discovered: ${
    commands.map((c) => `${c.file.slice(c.file.lastIndexOf('/') + 1)}#${c.method} [${c.operations.join('+')}]${c.audits ? '' : ' NOT AUDITED'}`).join(', ') ||
    'none'
  }; ${bindings.length} surface binding(s) of the one composer: ${bindings.map((b) => b.file.slice(b.file.lastIndexOf('/') + 1)).join(', ') || 'none'}`;
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
    id: 'evidence-script-bodies',
    title: 'what each measured step actually runs, pinned where the step goes through npm',
    run: evidenceScriptBodyProblems,
    note: evidenceScriptBodyReport,
    ok: 'every measured step that runs `npm run <script>` resolves to exactly the body it is ruled to have, so a filter or a narrowed path inside `package.json` cannot delete a measurement behind an unchanged workflow',
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
    id: 'command-refusal-audit',
    title: 'every Phase 4 command audits its refusals, over a DISCOVERED set of commands (P4-AL-48)',
    run: commandRefusalAuditProblems,
    note: commandRefusalAuditReport,
    ok: "the Phase 4 operation vocabulary was read off its own type unions, at least one command path was discovered from the code, every discovered command's refusal path reaches the one `auditThenRethrow…` composer, and every surface binding of that composer delegates to the single refusal-audit module",
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
