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
 * FLOOR. `S4_ACCEPTED` is EMPTY because P4-S4 is a CANDIDATE, and everything
 * the accepted tense has no use for is fenced between
 * `CANDIDATE-TENSE (P4-AL-61)` markers — the candidate-tense block below and
 * that check's registration in `CHECKS` — so the acceptance commit can find
 * exactly what to delete and nothing it still needs.
 *
 * `selfClosureProblems` turns the forbidden shapes on THIS file, including the rule that a gate may not name a migration numbered
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
import { ACCEPTED as ACCEPTED_BUDGETS } from './phase4-budget-ratchet';
import { MIGRATIONS_SUBDIR, type LiveRelation, applierRelations, livePhase4Relations, phase4RlsForceStructuralProblems } from './guards/phase4-rls-force';
import {
  discoverSalesTables,
  findAuthoritativeSalesColumns,
  isAuthoritativeSalesColumn,
  isForbiddenSalesTable,
  isPhase4Relation,
  phase4InheritedPrefixRelations,
} from './guards/no-authoritative-balance';
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
 * THIS SLICE'S migrations, in whichever tense the slice is in — the ONE place
 * the tense decides a subject. While P4-S4 is a candidate `S4_ACCEPTED` is
 * empty and the subject is the files past the accepted head; the acceptance
 * commit fills `S4_ACCEPTED`, the accepted head MOVES to this slice's own last
 * migration, and the subject becomes exactly those accepted files rather than
 * the NEXT slice's. Both of this file's relation-level laws read it, so
 * forward evolution cannot make one of them judge an empty set while the other
 * judges the slice. `[[daftar-a-closure-rule-is-not-an-invariant]]`.
 */
export function sliceMigrations(root: string): string[] {
  const accepted = Object.keys(S4_ACCEPTED).sort();
  return accepted.length > 0 ? accepted : candidateMigrations(root);
}

// ───── CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────────
// P4-S4 is a CANDIDATE. `S4_ACCEPTED` is empty, this gate pins no digest and
// names no migration, and the slice's own migration is reached only through
// `candidateMigrations` — the files on disk numbered past the last ACCEPTED
// Phase 4 migration. The acceptance commit fills `S4_ACCEPTED` and
// `PHASE4_S4_PREFIX` together, deletes EVERY fenced block — this one and the
// one around this check's registration in `CHECKS` — and
// `closureRuleProblems` then refuses a tree in which a marker survived, so the
// transition cannot be left half done.
//
// What is fenced is only what the accepted tense has no use for: this prose,
// `candidateTenseProblems` and `candidateReport`. `S4_ACCEPTED`,
// `candidateMigrations` and `sliceMigrations` are PERMANENT machinery that the
// accepted tense still reads, and they sit above the fence for that reason: a
// fence that swallowed them would make the acceptance commit delete the very
// literal it had just filled, and the tree would not compile.

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
 * ── THE LIVE-CATALOGUE HALF OF THE SAME VOCABULARY (F-09) ────────────────
 *
 * `vocabularyProblems` above reads TEXT, and the reader it reads with
 * (`stripNonSchema`) discards dollar-quoted bodies and quoted literals BY
 * DESIGN — that is what keeps a comment or a PL/pgSQL body from being mistaken
 * for a column declaration. The cost is exact and was measured, not assumed: a
 * relation created by `DO $$ BEGIN EXECUTE 'CREATE TABLE …'; END $$` leaves
 * `stripNonSchema` with `DO ;`, so `discoverStoredRelations` returns nothing,
 * `discoverSalesTables` returns nothing, and the vocabulary law is SILENT about
 * a relation whose very NAME `isForbiddenSalesTable` calls derived truth. The
 * column half is blind twice over: even handed the name, the column text the
 * declaration is made of is inside the body the reader dropped.
 *
 * The RLS/FORCE law already closed exactly this hole, and it closed it the only
 * way a text parser's blindness can be closed — by asking the DATABASE what
 * relations and columns are actually there (`scripts/guards/phase4-rls-force.ts`
 * half (ii), `pg_class`/`pg_attribute`). This is that half, for the vocabulary:
 * same input shape (`LiveRelation`, supplied by the caller, so this law never
 * opens a connection and a fixture can stand in for a database), same shared
 * Phase 4 predicate, same applier subtraction, same canaries, and the same rule
 * that `live === null` is reported as HAVING JUDGED NOTHING rather than passing.
 *
 * It is deliberately NOT wired into `CHECKS`: the gate judges text and must not
 * come to need a cluster where it did not before, exactly as the RLS live half
 * stays with its suite. `tests/guards/p4s4-vocabulary-live-arm.test.ts` reaches
 * a real cluster through `ensurePostgres()` — which STARTS the embedded
 * PostgreSQL and throws when it cannot, so there is no path on which this half
 * silently skips.
 *
 * No vocabulary is copied here either: the words are `isForbiddenSalesTable`
 * and `isAuthoritativeSalesColumn`, the same two predicates the text half uses.
 */
export interface Phase4VocabularyInput {
  /** The applier's source text, from which the runner's own bookkeeping relations are discovered and subtracted. */
  readonly applierSource: string;
  /**
   * The live catalogue, or `null` when none was read. `null` is NOT a pass: a
   * law that judged no subject is reported as having judged no subject.
   */
  readonly live: readonly LiveRelation[] | null;
}

export interface Phase4VocabularyReport {
  /** The size of the digest-verified inherited prefix's relation set. Zero means the shared predicate is fail-empty. */
  readonly inheritedPrefixSize: number;
  /** The relations the applier's own source creates, subtracted from the surface. */
  readonly applierRelations: readonly string[];
  /** The Phase 4 relations present in the live catalogue, or `null` when none was read. */
  readonly liveSurface: readonly string[] | null;
  /** Exactly the relations whose name and columns were judged against the vocabulary. */
  readonly judged: readonly string[];
  readonly problems: readonly string[];
}

/** G-3's vocabulary over the LIVE catalogue: the half the text reader structurally cannot have. */
export function liveVocabularyReport(input: Phase4VocabularyInput): Phase4VocabularyReport {
  const problems: string[] = [];

  // ── Canary: the shared predicate is the complement of a set read from
  // digest-verified files, so an empty reading is a tampered prefix and not a
  // surface — every relation in the catalogue would read as Phase 4.
  const inheritedPrefixSize = phase4InheritedPrefixRelations().size;
  if (inheritedPrefixSize === 0)
    problems.push(
      'VACUOUS: the inherited-prefix reader returned no relation, so the Phase 4 predicate is the complement of the empty set and EVERY relation in the catalogue reads as Phase 4 — a missing or altered digest-verified prefix file, not a surface',
    );

  // ── Canary: the subtracted set is read from text, so an empty reading means
  // that text stopped declaring what it creates.
  const applier = applierRelations(input.applierSource);
  if (applier.length === 0)
    problems.push(
      `VACUOUS: no relation was discovered in the applier source handed to this law (${input.applierSource.length} characters), so the subtraction that keeps the runner's own bookkeeping out of this surface has no subject`,
    );

  const liveSurface = input.live === null ? null : livePhase4Relations(input.live, input.applierSource);

  if (input.live === null)
    problems.push(
      "VACUOUS: no live catalogue was read, so no relation had its name or its pg_attribute columns judged against G-3's vocabulary — NOT A PASS, and the text half cannot stand in for it, because a relation created from inside a dollar-quoted body is invisible to the text half by construction",
    );
  else if (liveSurface !== null && liveSurface.length === 0)
    problems.push(
      `VACUOUS: the live catalogue handed to this law holds no Phase 4 relation at all (${input.live.length} catalogue row(s) read), so this half has no subject and must not be read as a pass`,
    );

  // EVERY catalogue row of a name, not one. The live read now covers every
  // namespace PostgreSQL has not reserved, so two namespaces may hold a
  // relation of the same name — and a map keyed by name alone would let the
  // compliant `public.x` answer for a leaking `other.x`, whose authoritative
  // columns would then never be judged. The RLS law was corrected the same way
  // in `scripts/guards/phase4-rls-force.ts` (`liveRowsByName`); this is the
  // same correction in the vocabulary arm.
  const byName = new Map<string, { readonly name: string; readonly schema?: string; readonly columns: readonly string[] }[]>();
  for (const row of input.live ?? []) {
    const bucket = byName.get(row.name);
    if (bucket === undefined) byName.set(row.name, [row]);
    else bucket.push(row);
  }
  const judged = (liveSurface ?? []).filter((name) => byName.has(name));

  for (const name of judged) {
    if (isForbiddenSalesTable(name))
      problems.push(
        `${name} is PRESENT IN THE LIVE CATALOGUE and is a derived-truth relation name under G-3 — a balance, outstanding, receivables, summary, cache, snapshot or rollup relation is a second financial truth. No migration text this gate can read declares it that way, which is the hole this half exists to close`,
      );
    for (const row of byName.get(name) ?? [])
      for (const column of row.columns)
        if (isAuthoritativeSalesColumn(column))
          problems.push(
            `${row.schema === undefined ? name : `${row.schema}.${name}`}.${column} is a LIVE pg_attribute column claiming storage authority over a derived receivable, debt or stock quantity (G-3 / P4-AL-06) — the text half cannot read a column declared from inside a dollar-quoted body`,
          );
  }

  return { inheritedPrefixSize, applierRelations: applier, liveSurface, judged, problems };
}

/** The live half as the estate's universal guard contract: `string[]`, empty meaning silent. */
export function liveVocabularyProblems(input: Phase4VocabularyInput): string[] {
  return [...liveVocabularyReport(input).problems];
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
  // THE SUBJECT IS THIS SLICE'S MIGRATIONS, IN WHICHEVER TENSE THEY ARE IN.
  //
  // While P4-S4 is a candidate, its migrations are exactly the files past the
  // accepted head, so `candidateMigrations` names them. The moment acceptance
  // fills `S4_ACCEPTED`, the accepted head MOVES to this slice's own last
  // migration and `candidateMigrations` stops naming them — it names the NEXT
  // slice's file instead, which declares none of this slice's relations, and
  // the non-vacuity guard below then refuses a tree for the sin of having
  // moved on. That is the `gate:phase2:release` lesson exactly: a device built
  // to refuse a vacuous pass became a device that refused forward evolution,
  // and this block sits OUTSIDE the candidate-tense fence, so deleting the
  // fence at acceptance would not have fixed it.
  //
  // So the tense decides the subject, and the tense is a fact about this file:
  // `S4_ACCEPTED` is empty while the slice is a candidate and holds its
  // migrations afterwards. `sliceMigrations` is that one decision, and the
  // report below reads the same function — a report that said "none declared"
  // on a PASS, because it had kept reading the candidate head, would be a
  // false negative printed next to a green verdict.
  const files = sliceMigrations(root);
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
      `none of this slice's migrations is on disk, so every relation law below judged an empty set — this slice's surface is ${CONTRACT_RELATIONS.join(', ')}, and a check that discovers none of it is reporting ABSENCE, not correctness`,
    );
  else {
    const declared = discoverSalesTables(surface);
    const found = CONTRACT_RELATIONS.filter((r) => declared.includes(r));
    if (found.length === 0)
      problems.push(
        `this slice's migration surface (${files.join(', ')}) declares none of ${CONTRACT_RELATIONS.join(', ')} — the RLS/FORCE, G-3 vocabulary and settlement-contract laws below all judged an empty set, so their silence is not evidence`,
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
  for (const file of sliceMigrations(root)) for (const r of discoverSalesTables(read(root, `${MIGRATIONS_SUBDIR}/${file}`))) declared.add(r);
  const found = CONTRACT_RELATIONS.filter((r) => declared.has(r));
  const missing = CONTRACT_RELATIONS.filter((r) => !declared.has(r));
  return `${CONTRACT_RELATIONS.length} contract relation(s), all ${CONTRACT_RELATIONS.filter(isPhase4Relation).length} admitted by isPhase4Relation(); ${found.length} declared by this slice's migrations (${found.join(', ') || 'none'})${
    missing.length === 0 ? '' : `; NOT declared by this slice's migrations and therefore not judged by the text-level laws: ${missing.join(', ')}`
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
  /**
   * The suite file the step runs. The step being pinned says the command ran;
   * this says WHAT it ran, so a `describe.skip` inside the file, or a root
   * config that excludes its directory and passes with no tests, cannot leave
   * the budget unmeasured behind a green step.
   */
  readonly suite: string;
}[] = [
  {
    label: 'the P4-D/P4-F measured budgets',
    script: 'perf:phase4:s4',
    command: 'npm run perf:phase4:s4',
    name: 'Receivables read budgets — P4-D and P4-F, measured',
    scriptBody: 'vitest run --reporter=verbose tests/performance/receivables-s4-budgets.test.ts',
    suite: 'tests/performance/receivables-s4-budgets.test.ts',
  },
  {
    label: 'the set-based AR answer equivalence',
    script: 'tests/performance/receivables-ar-setbased-equivalence.test.ts',
    command: 'npx vitest run tests/performance/receivables-ar-setbased-equivalence.test.ts',
    name: 'Set-based AR answer equivalence — the 0083/0084 readers against the per-invoice original',
    suite: 'tests/performance/receivables-ar-setbased-equivalence.test.ts',
  },
  {
    // Added because `evidence-coverage` refused the tree without it: this
    // suite — the open-invoice page reader's equivalence claim, 40 KB of it —
    // was in no step of the required job and in no `test*` script CI runs, so
    // it had never been executed anywhere. The law found it; reading did not.
    label: 'the open-invoice page answer equivalence',
    script: 'tests/performance/receivables-open-page-equivalence.test.ts',
    command: 'npx vitest run tests/performance/receivables-open-page-equivalence.test.ts',
    name: 'Open-invoice page equivalence — the 0084 page reader against the per-invoice original',
    suite: 'tests/performance/receivables-open-page-equivalence.test.ts',
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

/**
 * WHAT THE MEASURED STEP ACTUALLY EXECUTES.
 *
 * The step is pinned, and so is the npm script body it resolves to. Neither
 * says the measurement RAN. Three ways to delete it while every other law
 * stays silent, each found by attacking this file rather than by reading it:
 *
 *  - `describe.skip(` on the P4-F block inside the suite. The suite matches no
 *    roster rule, so the gate reads none of its bytes, and `vitest run` exits
 *    0 over a skipped block. `.skip` shifts no lines, so even the
 *    line-quoted plan-claim inventory stays fresh.
 *  - `exclude: ['tests/performance/**']` with `passWithNoTests: true` in the
 *    root config: `vitest run <that path>` then exits 0 having run nothing.
 *  - a `pre<script>` npm hook, which runs before the pinned body and is not
 *    the pinned body.
 *
 * So each evidence step names its SUITE, and this law asks of the suite what
 * the other two ask of the step.
 */
export function evidenceIntegrityProblems(root: string): string[] {
  const problems: string[] = [];
  // THE SKIP SURFACE, BY MEMBER ACCESS RATHER THAN BY CALL.
  //
  // These were three regexes of the shape `describe\s*\.\s*skip\s*\(`, and four
  // spellings walked straight through all three while really skipping the
  // block:
  //
  //   describe['skip'](…)            — a member access, not a `.skip` token
  //   describe.skipIf(true)(…)       — `skip` is not followed by `(`
  //   describe.runIf(false)(…)       — never mentioned at all
  //   const d = describe.skip; d(…)  — the call site is not the member access
  //
  // So the subject is the MEMBER, however it is spelled and whatever is done
  // with it afterwards: dotted or bracketed, through any number of intermediate
  // modifiers (`describe.concurrent.skip`), called immediately or bound to a
  // name first. `skipIf`/`runIf` are included unconditionally, because a
  // measured step must take its measurement on every run and a CONDITIONALLY
  // skipped measurement is the same hole as a skipped one; `fails` is included
  // because a budget that is expected to fail is not a budget that passed.
  const SKIPPERS = [
    /\b(?:describe|it|test|suite)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*(?:skip|only|todo|skipIf|runIf|fails)\b/,
    /\b(?:describe|it|test|suite)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\[\s*(['"`])(?:skip|only|todo|skipIf|runIf|fails)\1\s*\]/,
  ];
  for (const ev of S4_EVIDENCE_STEPS) {
    if (!has(root, ev.suite)) {
      problems.push(`${ev.label} names the suite ${ev.suite}, which is not in the tree — the step would run nothing`);
      continue;
    }
    // COMMENTS ARE NOT CODE. `receivables-s4-budgets.test.ts` carries the
    // literal text `describe('P4-D …')` inside its own doc comment at line 98,
    // 1 000 lines above the first executed block — so a law reading the raw
    // bytes can fire on PROSE, which is both a false refusal of an honest tree
    // and the reason RP-EI-A's plant was vacuous: it mutated the comment and
    // the law dutifully reported it. The claim is about the block the runner
    // executes, so the prose goes first, exactly as `closureRuleProblems` does
    // it for the forbidden shapes.
    const text = stripProse(read(root, ev.suite));
    for (const shape of SKIPPERS)
      if (shape.test(text))
        problems.push(
          `${ev.suite} carries ${String(shape.exec(text)?.[0]).trim()} — a skipped, exclusive or todo block leaves the step green over a measurement it did not take, and a budget nothing measured is indistinguishable from a budget that passed`,
        );
    if (ev.command.startsWith('npm run ') && ev.scriptBody === undefined)
      problems.push(`${ev.label} runs through npm and states no script body, so what it runs is pinned only by its name`);
    if (ev.scriptBody !== undefined && !ev.scriptBody.includes(ev.suite))
      problems.push(`${ev.label}'s pinned script body does not name ${ev.suite}, so the body and the suite this law judges are not the same thing`);
    // ── AND WHETHER THE SUITE CONTAINS THE MEASUREMENT AT ALL ────────────
    //
    // Everything above is about the step, the body, the file and its skip
    // markers. None of it asks whether the suite still holds the measurement.
    // Deleting both `it('MEASUREMENT: … P4-F …')` cases leaves this gate green,
    // `p4s4-required-ci` green and `p4s4-budget-ratchet-law` green: the file is
    // present, unskipped, named by the body and run by the step, and the P4-F
    // budget is simply no longer measured — a budget nothing measured being
    // indistinguishable from a budget that passed.
    //
    // So each row's own text is asked which budgets it measures, and the ids it
    // cites are kept only where the ACCEPTED ratchet table knows them (by
    // equality, or as the prefix of a key: `P4-F` covers `P4-F-TXN` and
    // `P4-F-HTTP`). Nothing is listed here — the ids come from the row, the
    // vocabulary from the budget table, and `testTitles` reads only RUNNABLE
    // titles, so a `.skip`-ed measurement does not satisfy this either.
    const cited = [...new Set([...`${ev.label} ${ev.name}`.matchAll(/\bP4-[A-Z](?:-[A-Z]+)?\b/g)].map((m) => m[0]))];
    const known = cited.filter((id) => Object.keys(ACCEPTED_BUDGETS).some((k) => k === id || k.startsWith(`${id}-`)));
    if (cited.length > 0 && known.length === 0)
      problems.push(
        `${ev.label} cites ${cited.join(', ')} and the accepted budget table knows none of them, so this law would judge no measurement for that row`,
      );
    const suiteTitles = has(root, ev.suite) ? testTitles(read(root, ev.suite)) : [];
    for (const id of known)
      if (!suiteTitles.some((t) => t.includes(id)))
        problems.push(
          `${ev.suite} holds no RUNNABLE it( title naming ${id}, which ${ev.label} says it measures — the step still runs, the file is still there and nothing is skipped, so deleting the ${id} case leaves a green step over a budget that was never measured`,
        );
  }
  // No `pre`/`post` npm hook may wrap a pinned script: a hook runs before or
  // after the pinned body and is not the pinned body.
  const MANIFEST = 'package.json';
  if (!has(root, MANIFEST)) problems.push(`${MANIFEST} is missing, so no hook around a measured script can be ruled out`);
  else {
    let scripts: Record<string, unknown> = {};
    try {
      const bag = (JSON.parse(read(root, MANIFEST)) as { scripts?: unknown }).scripts;
      if (typeof bag === 'object' && bag !== null) scripts = bag as Record<string, unknown>;
    } catch (e) {
      problems.push(`${MANIFEST} does not parse: ${String(e)}`);
    }
    for (const ev of S4_EVIDENCE_STEPS)
      for (const hook of [`pre${ev.script}`, `post${ev.script}`])
        if (scripts[hook] !== undefined)
          problems.push(
            `${MANIFEST} declares \`${hook}\`, which npm runs around the pinned \`${ev.script}\` — a hook can rewrite the config the measurement reads`,
          );
  }
  // The root runner config must not be able to turn a named suite into
  // nothing. `exclude` plus `passWithNoTests` is the shape that does it.
  const CONFIG = 'vitest.config.ts';
  if (!has(root, CONFIG)) problems.push(`${CONFIG} is missing, so what the measured step's runner collects is unstated`);
  else {
    const cfg = read(root, CONFIG);
    if (/passWithNoTests\s*:\s*true/.test(cfg))
      problems.push(
        `${CONFIG} sets passWithNoTests: true — a run that collected no test then exits 0, and every measured step becomes satisfiable by running nothing`,
      );
    if (/\bexclude\s*:/.test(cfg))
      problems.push(
        `${CONFIG} carries an \`exclude\` — a measured suite's directory can be excluded with the step, the body and the file all unchanged; a slice that genuinely needs one changes this law deliberately`,
      );
    // THE CONFIG MUST BE READABLE AS A LITERAL.
    //
    // The two claims above are claims about TEXT. A config that computes its
    // options defeats both without matching either:
    //
    //   const S = JSON.parse('{"exclude":["tests/**"],"passWithNoTests":true}');
    //   export default defineConfig({ test: { ...S, include: [...] } });
    //
    // There is no `exclude:` and no `passWithNoTests: true` anywhere in that
    // file, every regex above is silent, and `vitest run tests/performance/…`
    // then exits 0 having collected nothing. A permanent law may not rest on a
    // config whose options it cannot read, so a config that hides them is a
    // finding in itself — the repository's own config states every option as a
    // literal, so this costs it nothing.
    for (const [shape, what] of [
      [/\.\.\./, 'a spread, so an option can arrive from a value this law cannot read'],
      [/\bJSON\s*\.\s*parse\s*\(/, 'a JSON.parse, so its options are a string this law cannot read'],
      [/\bObject\s*\.\s*assign\s*\(/, 'an Object.assign, so an option can be merged in from a value this law cannot read'],
      [/\brequire\s*\(|\bawait\s+import\s*\(/, 'a runtime import, so its options can come from another file entirely'],
    ] as const)
      if (shape.test(cfg))
        problems.push(
          `${CONFIG} carries ${what} — \`exclude\` and \`passWithNoTests\` are judged as TEXT above, and a computed option satisfies neither regex while still turning every measured suite into a run that collects nothing and exits 0`,
        );
    for (const ev of S4_EVIDENCE_STEPS) {
      const dir = ev.suite.slice(0, ev.suite.indexOf('/', 'tests/'.length));
      if (!/include\s*:\s*\[\s*'tests\/\*\*\/\*\.test\.ts'\s*\]/.test(cfg))
        problems.push(`${CONFIG}'s \`include\` is not the ruled \`['tests/**/*.test.ts']\`, so whether ${dir} is collected at all is unstated`);
      break;
    }
  }
  return problems;
}

/**
 * ── GAP V3: THE TABLE WAS THE WHOLE SUBJECT, AND NOTHING DERIVED IT ───────
 *
 * `S4_EVIDENCE_STEPS` is the entire subject of `required-ci`,
 * `evidence-script-bodies` and `evidence-integrity`. Nothing above derives it,
 * and the guard suite's only floor on it was that it holds at least one row.
 * So a slice that adds a THIRD measured step and forgets the row gets three
 * green checks over two steps: the two rows it does hold are checked
 * exhaustively and the third measurement is invisible to every one of them.
 *
 * ── CAN THE TABLE BE DERIVED? HONESTLY: ITS MEMBERSHIP CAN, ITS PINS CANNOT ─
 *
 * The per-row facts — the exact step `name`, the exact `command`, the pinned
 * `scriptBody` — are the PINS. Deriving them from the workflow would make
 * `required-ci` judge the workflow against itself: a renamed step would rename
 * the expectation and the check would stay green, which is the vacuity the pins
 * exist to prevent. Those stay written down, and they must.
 *
 * MEMBERSHIP is a different question, and it is fully derivable. A measured
 * suite of THIS slice is discovered from the tree:
 *
 *   a runnable test file in a directory the table's own rows live in, whose
 *   text names a CANDIDATE MIGRATION — one on disk past the accepted Phase 4
 *   head, which `candidateMigrations` already derives.
 *
 * No prefix is written here, no migration number, no file name. The
 * discriminator is the slice's own candidate surface, so it moves when the
 * slice does, and it attributes a measurement to this slice without a list:
 * measured on this tree it selects exactly the three receivables suites and
 * none of the nine inherited performance suites, whose budgets belong to the
 * accepted phases behind this one.
 *
 * ── THE CROSS-CHECK ──────────────────────────────────────────────────────
 *
 * Both directions, because both are real:
 *
 *  - a derived measured suite the TABLE does not name is a measurement three
 *    checks cannot see;
 *  - a derived measured suite the REQUIRED JOB cannot reach is a measurement
 *    the repository carries and never takes — and a budget nothing measured is
 *    indistinguishable from a budget that passed;
 *  - a TABLE row whose suite the derivation does not find is a row about a
 *    measurement this slice does not carry, so the pins guard nothing.
 *
 * Reachability is read off the parsed workflow, not grepped: a step of the
 * required job reaches a suite when its `run:` names the path, or runs an npm
 * script whose body names the path, or runs an npm script whose body names a
 * `tests/<dir>` the suite is under.
 */

/** The directories the table's own rows live in — derived from the table, so no performance path is written down here. */
function measuredDirs(): string[] {
  return [...new Set(S4_EVIDENCE_STEPS.map((e) => e.suite.slice(0, e.suite.lastIndexOf('/'))).filter((d) => d.length > 0))].sort();
}

/**
 * THIS SLICE'S MEASURED SUITES, DISCOVERED FROM THE TREE: a runnable test file
 * in a measured directory whose text names a candidate migration.
 */
export function measuredCandidateSuites(root: string): string[] {
  const numbers = candidateMigrations(root)
    .map((f) => /^(\d+)/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined);
  if (numbers.length === 0) return [];
  const shapes = numbers.map((n) => new RegExp(`\\b${n}\\b`));
  const out = new Set<string>();
  for (const dir of measuredDirs())
    for (const file of walk(root, dir)) {
      if (!RUNNABLE.test(file.slice(file.lastIndexOf('/') + 1))) continue;
      const text = read(root, file);
      if (shapes.some((re) => re.test(text))) out.add(file);
    }
  return [...out].sort();
}

/** Every suite path a step of the required job reaches, directly or through an npm script body. */
export function requiredJobReach(root: string): { readonly paths: readonly string[]; readonly dirs: readonly string[] } {
  if (!has(root, WORKFLOW)) return { paths: [], dirs: [] };
  let scripts: Record<string, unknown> = {};
  if (has(root, 'package.json'))
    try {
      const bag = (JSON.parse(read(root, 'package.json')) as { scripts?: unknown }).scripts;
      if (typeof bag === 'object' && bag !== null) scripts = bag as Record<string, unknown>;
    } catch {
      scripts = {};
    }
  const paths = new Set<string>();
  const dirs = new Set<string>();
  const harvest = (text: string): void => {
    for (const m of text.matchAll(/\btests\/[A-Za-z0-9._/-]*\.test\.ts\b/g)) paths.add(m[0]);
    for (const m of text.matchAll(/\btests\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?![A-Za-z0-9._/-])/g)) dirs.add(m[0]);
  };
  for (const step of readWorkflow(read(root, WORKFLOW)).steps) {
    if (step.job !== REQUIRED_JOB) continue;
    const run = step.run ?? '';
    harvest(run);
    for (const m of run.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      const body = scripts[m[1] ?? ''];
      if (typeof body === 'string') harvest(body);
    }
  }
  return { paths: [...paths].sort(), dirs: [...dirs].sort() };
}

/**
 * EVERY SUITE PATH A STEP OF THE REQUIRED JOB ACTUALLY NAMES, resolved through
 * the npm script bodies the gate already reads.
 *
 * `requiredJobReach` answers the weaker question "could the runner get there",
 * which a directory-covering `test*` script satisfies. For a MEASURED step that
 * is not enough: `perf:phase2:s8` covers the whole of `tests/performance` and
 * no step of any job runs it, so directory coverage would call an unmeasured
 * budget measured. This answers the exact question instead — which suite FILES
 * the required job names — so the table can be compared with it as a SET.
 */
export function workflowNamedSuites(root: string): string[] {
  if (!has(root, WORKFLOW)) return [];
  let scripts: Record<string, unknown> = {};
  if (has(root, 'package.json'))
    try {
      const bag = (JSON.parse(read(root, 'package.json')) as { scripts?: unknown }).scripts;
      if (typeof bag === 'object' && bag !== null) scripts = bag as Record<string, unknown>;
    } catch {
      scripts = {};
    }
  const out = new Set<string>();
  for (const step of readWorkflow(read(root, WORKFLOW)).steps) {
    if (step.job !== REQUIRED_JOB) continue;
    let text = step.run ?? '';
    for (const m of (step.run ?? '').matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      const body = scripts[m[1] ?? ''];
      if (typeof body === 'string') text += `\n${body}`;
    }
    for (const m of text.matchAll(/\btests\/[A-Za-z0-9._/-]*\.test\.ts\b/g)) out.add(m[0]);
  }
  return [...out].sort();
}

/** The cross-check: the table's membership against the measurements the tree carries and the required job takes. */
export function evidenceCoverageProblems(root: string): string[] {
  const problems: string[] = [];
  const derived = measuredCandidateSuites(root);
  const named = new Set(S4_EVIDENCE_STEPS.map((e) => e.suite));
  if (S4_EVIDENCE_STEPS.length === 0)
    problems.push('S4_EVIDENCE_STEPS is empty, so `required-ci`, `evidence-script-bodies` and `evidence-integrity` all have no subject');
  if (derived.length === 0)
    problems.push(
      `no runnable test file in ${measuredDirs().join(', ') || 'any measured directory'} names a candidate migration, so this cross-check derived an empty set and would be vacuous — the candidate surface is ${
        candidateMigrations(root).join(', ') || 'empty'
      }`,
    );
  const reach = requiredJobReach(root);
  const reached = (file: string): boolean => reach.paths.includes(file) || reach.dirs.some((d) => file === d || file.startsWith(`${d}/`));
  for (const file of derived) {
    if (!named.has(file))
      problems.push(
        `${file} is a measured suite of this slice — it is a runnable test in ${file.slice(0, file.lastIndexOf('/'))} and names a candidate migration — and S4_EVIDENCE_STEPS does not name it, so \`required-ci\`, \`evidence-script-bodies\` and \`evidence-integrity\` all judge a table that cannot see it`,
      );
    if (!reached(file))
      problems.push(
        `${file} is a measured suite of this slice and NO step of the required \`${REQUIRED_JOB}\` job reaches it, directly or through an npm script body — a measurement the repository carries and never takes, and a budget nothing measured is indistinguishable from a budget that passed`,
      );
  }
  for (const ev of S4_EVIDENCE_STEPS)
    if (!derived.includes(ev.suite))
      problems.push(
        `S4_EVIDENCE_STEPS names ${ev.suite} for ${ev.label} and the derivation does not find it among this slice's measured suites — either it is gone from the tree or it names no candidate migration, so the pins on that row guard nothing`,
      );
  // ── AND SET EQUALITY WITH THE WORKFLOW ITSELF ───────────────────────────
  //
  // The second derivation, from the other side. The required job's own steps
  // name suite files; restricted to the ones the candidate surface attributes
  // to THIS slice, that set must EQUAL the table.
  //
  // The restriction is not a softening and it is not a list: the required job
  // also runs the PREDECESSOR slices' measured steps — `pos-s3-budgets` is
  // P4-A/P4-B's budget and `plan-evidence-contract` is TL-P4-S3-R4's — and
  // neither names a candidate migration. A gate that demanded unrestricted
  // equality would pin its predecessor's steps as its own evidence and would
  // red the moment P4-S5 added one of its own. The attribution is what makes
  // the equality a statement about this slice.
  const attributed = workflowNamedSuites(root).filter((f) => derived.includes(f));
  for (const file of attributed)
    if (!named.has(file))
      problems.push(
        `a step of the required \`${REQUIRED_JOB}\` job names ${file}, the candidate surface attributes it to this slice, and S4_EVIDENCE_STEPS does not name it — the workflow measures something the table cannot see, so none of its pins apply to it`,
      );
  for (const ev of S4_EVIDENCE_STEPS)
    if (!attributed.includes(ev.suite))
      problems.push(
        `S4_EVIDENCE_STEPS names ${ev.suite} for ${ev.label} and NO step of the required \`${REQUIRED_JOB}\` job names that file, directly or through an npm script body — being reachable through a directory-covering \`test*\` script is not enough for a measured step, because \`perf:phase2:s8\` covers the whole directory and no step of any job runs it`,
      );
  return problems;
}

/** The two sides of the cross-check, printed on a PASS as well as on a FAIL. */
export function evidenceCoverageReport(root: string): string {
  const derived = measuredCandidateSuites(root);
  const named = new Set(S4_EVIDENCE_STEPS.map((e) => e.suite));
  const reach = requiredJobReach(root);
  const reached = (f: string): boolean => reach.paths.includes(f) || reach.dirs.some((d) => f === d || f.startsWith(`${d}/`));
  const attributed = workflowNamedSuites(root).filter((f) => derived.includes(f));
  return `${derived.length} derived from the tree (${measuredDirs().join(', ')} ∩ the candidate surface), ${attributed.length} named by the required \`${REQUIRED_JOB}\` job and attributed to this slice, ${S4_EVIDENCE_STEPS.length} table row(s): ${
    derived
      .map(
        (f) =>
          `${f.slice(f.lastIndexOf('/') + 1)}${named.has(f) ? '' : ' NOT IN TABLE'}${attributed.includes(f) ? '' : ' NOT NAMED BY ' + REQUIRED_JOB}${reached(f) ? '' : ' UNREACHABLE'}`,
      )
      .join('; ') || 'none'
  }`;
}

/** What the measured suites are, and what the runner config says, on a pass as well as a failure. */
export function evidenceIntegrityReport(root: string): string {
  return `${S4_EVIDENCE_STEPS.length} measured suite(s): ${S4_EVIDENCE_STEPS.map((e) => `${e.suite}${has(root, e.suite) ? '' : ' (ABSENT)'}`).join('; ')}`;
}

/**
 * EVERY ROSTERED SUITE IS SOMEWHERE THE RUNNER GOES.
 *
 * The roster is derived by basename, and the only floor is that it matched at
 * least one file. So moving a rostered suite into a directory no runner script
 * covers drops it from the roster AND from CI, and no check names the loss:
 * `test:integration` covers three directories and `test:golden` one, both by
 * path. The covered directories are read out of those scripts rather than
 * listed here, so a slice that adds a directory to the runner widens this law
 * by widening the runner.
 */
export function rosterRunnerProblems(root: string): string[] {
  const MANIFEST = 'package.json';
  if (!has(root, MANIFEST)) return [`${MANIFEST} is missing, so the directories the runner covers are unstated`];
  let scripts: Record<string, unknown> = {};
  try {
    const bag = (JSON.parse(read(root, MANIFEST)) as { scripts?: unknown }).scripts;
    if (typeof bag === 'object' && bag !== null) scripts = bag as Record<string, unknown>;
  } catch (e) {
    return [`${MANIFEST} does not parse: ${String(e)}`];
  }
  const covered = new Set<string>();
  for (const [name, body] of Object.entries(scripts)) {
    if (!name.startsWith('test')) continue;
    if (typeof body !== 'string') continue;
    for (const m of body.matchAll(/\btests\/[A-Za-z0-9_-]+/g)) covered.add(m[0]);
  }
  if (covered.size === 0) return [`no \`test*\` script of ${MANIFEST} names a \`tests/\` directory, so this law would be vacuous`];
  const problems: string[] = [];
  const files = rosterFiles(root);
  if (files.length === 0) return [...problems, 'the roster matched no suite, so this law would be vacuous'];
  for (const file of files)
    if (![...covered].some((dir) => file.startsWith(`${dir}/`)))
      problems.push(
        `the rostered suite ${file} is in no directory any \`test*\` script of ${MANIFEST} runs (${[...covered].sort().join(', ')}) — a rostered file the runner never reaches is a law that is in the roster and out of CI`,
      );
  return problems;
}

/** Which directories the runner covers, and how many rostered suites fall in them. */
export function rosterRunnerReport(root: string): string {
  if (!has(root, 'package.json')) return 'package.json is missing';
  let scripts: Record<string, unknown> = {};
  try {
    const bag = (JSON.parse(read(root, 'package.json')) as { scripts?: unknown }).scripts;
    if (typeof bag === 'object' && bag !== null) scripts = bag as Record<string, unknown>;
  } catch {
    return 'package.json does not parse';
  }
  const covered = new Set<string>();
  for (const [name, body] of Object.entries(scripts))
    if (name.startsWith('test') && typeof body === 'string') for (const m of body.matchAll(/\btests\/[A-Za-z0-9_-]+/g)) covered.add(m[0]);
  const files = rosterFiles(root);
  return `${files.length} rostered suite(s) against ${covered.size} runner directory/ies (${[...covered].sort().join(', ')})`;
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

/**
 * THE NON-SHRINKING RATCHET ON THE DERIVED MATCH SET.
 *
 * `roster-runner` constrains only files ALREADY on the roster — it iterates
 * `rosterFiles(root)` — so it cannot see a suite leave. A rostered suite moved
 * AND renamed out of the basename rule drops off the roster entirely: measured
 * on this tree, renaming `tests/security/p4s4-rls-quals-once-per-query.test.ts`
 * takes the roster from 26 files to 25, every check stays green, and nothing in
 * `ci.yml` executes it afterwards — `test:integration` covers three directories
 * and the measured steps name files.
 *
 * A FLOOR, never an equality: the roster grows as this slice is written in
 * several worktrees at once, and an equality against today's count is exactly
 * the P4-AL-88 defect. A slice that legitimately retires a suite lowers this
 * number in the same commit, deliberately and visibly, which is the whole
 * point of a ratchet.
 *
 * This is the ONE hand-written number this law carries, and it is here because
 * the alternative was measured and rejected: an INVERSE content derivation —
 * "every runnable test in a covered directory that cites a P4-S4 subject the
 * gate discovers must be rostered" — sweeps in the estate's standing
 * phase-wide suites. Measured against the candidate migrations it claims 6
 * files that are not this slice's (`tests/integration/migration-portability.test.ts`,
 * `tests/guards/phase4-deferred-seam-guard.test.ts`,
 * `tests/guards/phase4-refund-not-a-reducer-guard.test.ts` and three goldens of
 * the `phase2`/`phase4` directories); measured against the four contract
 * relations it claims more than twenty, including every `settlement-s6-*`
 * suite. Rostering those would make THIS gate execute and own suites belonging
 * to the phase and to slices behind it, which is a worse defect than the one it
 * would close. So the ratchet is a floor, and the gap it does not close is
 * stated here rather than left to be discovered.
 */
// The ratchet's recorded count. It moves in BOTH directions and only in the
// commit that moves the roster: lower it when a suite is retired deliberately,
// RAISE it when one is added — a floor left behind a grown roster goes slack,
// because a later loss then lands above it and is never reported.
// `p4s4-required-ci` asserts this equals the derived count, so forgetting is a
// failure rather than a silent relaxation.
/**
 * THE ROSTER AS IT STOOD WHEN THIS LAW WAS LAST MOVED — a RECORD, never the
 * subject. The subject is still `rosterFiles`, derived from the tree; this list
 * exists because a COUNT cannot see a SWAP.
 *
 * Measured by an independent challenge round: move and rename one rostered
 * suite out of the basename rule and add one new suite in the SAME directory in
 * the same commit, and every arm of this ratchet stays silent — the total is
 * still 32, the floor equality still holds, and the per-directory arm only
 * asserts non-emptiness, so a directory that loses one and gains one looks
 * untouched. The suite it removed (`p4s4-migration-self-capture-law.test.ts`)
 * is referenced by name nowhere else in the repository, so nothing else would
 * have named the loss either.
 *
 * So MEMBERSHIP is recorded, and the arm below is a SUBSET assertion: every
 * recorded file must still be derived. Additions stay free — a new suite is
 * never a finding — and a deliberate retirement removes its line here in the
 * same commit, which is the one place a reviewer then sees it.
 */
export const ROSTER_RECORDED: readonly string[] = [
  'tests/golden-regression/phase4-s4/09-settlement-last-amount-race.golden.test.ts',
  'tests/golden-regression/phase4-s4/10-settlement-cross-currency.golden.test.ts',
  'tests/guards/p4s4-budget-ratchet-law.test.ts',
  'tests/guards/p4s4-command-refusal-audit-law.test.ts',
  'tests/guards/p4s4-gate-execution.test.ts',
  'tests/guards/p4s4-migration-self-capture-law.test.ts',
  'tests/guards/p4s4-new-relation-coverage.test.ts',
  'tests/guards/p4s4-payment-method-account-gap.test.ts',
  'tests/guards/p4s4-required-ci.test.ts',
  'tests/guards/p4s4-settlement-surface-laws.test.ts',
  'tests/guards/p4s4-vocabulary-live-arm.test.ts',
  'tests/guards/required-ci-chain-composition.test.ts',
  'tests/integration/p4s4-allocation-journal-binding.test.ts',
  'tests/integration/p4s4-cash-invoice-ar.test.ts',
  'tests/integration/p4s4-checkout-owner-replay.test.ts',
  'tests/integration/p4s4-checkout-permission-replay.test.ts',
  'tests/integration/p4s4-credit-application-customer-replay.test.ts',
  'tests/integration/p4s4-customer-identity-pin.test.ts',
  'tests/integration/p4s4-departure-b-method-account-mutability.test.ts',
  'tests/integration/p4s4-intent-replay.test.ts',
  'tests/integration/p4s4-invoice-settlement-chain.test.ts',
  'tests/integration/p4s4-nondigested-argument-controls.test.ts',
  'tests/integration/p4s4-open-invoice-page-rows-estimate.test.ts',
  'tests/integration/p4s4-payment-closure.test.ts',
  'tests/integration/p4s4-payment-method-posting-lock.test.ts',
  'tests/integration/p4s4-pos-sale-refusal-audit.test.ts',
  'tests/integration/p4s4-refusal-audit-never-throws.test.ts',
  'tests/integration/p4s4-refusal-audit.test.ts',
  'tests/integration/p4s4-request-boundary.test.ts',
  'tests/integration/p4s4-sale-commit-permission-replay.test.ts',
  'tests/security/p4s4-rls-barrier-behaviour.test.ts',
  'tests/security/p4s4-rls-quals-once-per-query.test.ts',
];

/** The ratchet's total floor, DERIVED from the record so one list is the single fact. */
export const ROSTER_FLOOR = ROSTER_RECORDED.length;

/**
 * The directories the roster occupied when this ratchet was written, each its
 * own FLOOR. `tests/security` holds exactly one rostered suite, so the total
 * floor above cannot see it leave on a day a sibling adds a suite elsewhere.
 * A slice that deliberately empties a directory removes its row here.
 */
const ROSTER_DIRECTORY_FLOOR: readonly string[] = ['tests/golden-regression/phase4-s4', 'tests/guards', 'tests/integration', 'tests/security'];

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

/**
 * THE RATCHET, AS ITS OWN CHECK AND NOT AS PART OF `rosterProblems`.
 *
 * Its subject is THE CHECKOUT — "has this repository lost a suite it had" — and
 * that is a different claim from "is this root's derived roster coherent",
 * which is what `rosterProblems` asks and which sibling proofs legitimately ask
 * of two-file scratch roots. Putting the floor inside `rosterProblems` made it
 * refuse every minimal synthetic root, including the one
 * `tests/guards/p4s4-gate-execution.test.ts:126` builds; the claims are
 * separate, so the checks are separate.
 */
export function rosterRatchetProblems(root: string): string[] {
  const problems: string[] = [];
  const files = rosterFiles(root);
  const total = files.length;
  if (total < ROSTER_FLOOR)
    problems.push(
      `the P4-S4 roster holds ${total} file(s) and the ratchet floor is ${ROSTER_FLOOR} — a rostered suite has left the derived set, which is exactly what a move AND rename out of the basename rule does: the file stops being rostered, stops being executed by this gate, and no other check names the loss. If a suite was retired deliberately, lower ROSTER_FLOOR in the same commit`,
    );
  // AND BY MEMBERSHIP: a count cannot see a SWAP. Every file the record names
  // must still be derived; a file the record does not name is free to join.
  const derived = new Set(files);
  const gone = ROSTER_RECORDED.filter((f) => !derived.has(f));
  if (gone.length > 0)
    problems.push(
      `${gone.length} recorded P4-S4 suite(s) are no longer derived by the roster rule and this gate therefore no longer executes them: ${gone.join(', ')} — a move AND rename out of the basename rule looks like nothing to a count, because a sibling's new file holds the total up. If one was retired deliberately, remove its line from ROSTER_RECORDED in the same commit`,
    );
  if (ROSTER_RECORDED.length === 0) problems.push('ROSTER_RECORDED is empty, so the membership arm above judged nothing and its silence is not evidence');

  // AND PER DIRECTORY: the last suite of a directory can leave while the total
  // is held up by a sibling's new file. `tests/security` holds exactly one.
  const occupied = new Set(files.map((f) => f.slice(0, f.lastIndexOf('/'))));
  for (const dir of ROSTER_DIRECTORY_FLOOR)
    if (!occupied.has(dir))
      problems.push(
        `the P4-S4 roster no longer holds a single suite under ${dir}, and it did when this law was written — the last suite of a directory can leave while the total is held up by a sibling's new file, so each occupied directory is its own floor`,
      );
  return problems;
}

/** The ratchet's two floors against what the tree holds today, on a PASS as well as a FAIL. */
export function rosterRatchetReport(root: string): string {
  const files = rosterFiles(root);
  const occupied = new Set(files.map((f) => f.slice(0, f.lastIndexOf('/'))));
  const derived = new Set(files);
  const kept = ROSTER_RECORDED.filter((f) => derived.has(f)).length;
  return `${files.length} rostered file(s) against a floor of ${ROSTER_FLOOR}; ${kept} of ${ROSTER_RECORDED.length} recorded file(s) still derived; ${ROSTER_DIRECTORY_FLOOR.filter((d) => occupied.has(d)).length} of ${
    ROSTER_DIRECTORY_FLOOR.length
  } floored directory/ies still occupied (${ROSTER_DIRECTORY_FLOOR.map((d) => `${d}${occupied.has(d) ? '' : ' EMPTY'}`).join(', ')})`;
}

/** What the derivation found, printed on a PASS as well as on a FAIL: a roster nobody can read is a roster nobody can audit. */
export function rosterReport(root: string): string {
  const { suites, unrunnable } = discoverS4Suites(root);
  return `${suites.length} derived + 1 named (${CI_COMPOSITION_SUITE}) = ${rosterFiles(root).length} file(s): ${rosterFiles(root).join(', ') || 'none'}${
    unrunnable.length === 0 ? '' : `; ${unrunnable.length} matched file(s) the runner would NOT execute: ${unrunnable.join(', ')}`
  }`;
}

/**
 * ── WHAT MAKES A ROSTERED FILE A *LAW*, AND WHY A DIRECTORY IS ONLY A FLOOR ─
 *
 * This predicate used to be exactly `file.startsWith('tests/guards/')`, and
 * that is a claim about where an author chose to put a file, not about what the
 * file does. Measured on this roster it left the law half ABSENT for 17 of 26
 * rostered files — `tests/security/p4s4-rls-quals-once-per-query.test.ts`
 * among them, which reads the tree, judges it, and was the subject of this
 * slice's own corrective commit. A law moved one directory sideways stopped
 * being a law.
 *
 * So the guard directory is kept as a FLOOR — a file an author put there
 * declares itself a guard, and this gate's own named CI-composition row is what
 * states which directory that is, so no path is written down twice — and it is
 * UNIONED with a derived property: a suite whose SUBJECT IS THE REPOSITORY. It
 * imports a gate module out of `scripts/`, or it reads the tree itself through
 * `node:fs`. Such a suite can construct a MUTATED COPY of its subject and feed
 * it to the law, so nothing stops it proving it can refuse one, and it owes
 * that proof wherever its author put it.
 *
 * A suite whose subject is the RUNNING SYSTEM cannot: there is no tree artifact
 * for it to plant a defect in, and asking it for one would be asking for a
 * token assertion rather than for evidence.
 */
const JUDGES_THE_TREE: readonly RegExp[] = [
  /\bfrom\s+['"](?:\.\.\/)+scripts\/[A-Za-z0-9._-]+['"]/,
  /\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync)\s*\(/,
];

/**
 * The shapes this repository's laws actually announce a planted defect in, read
 * off the suites rather than prescribed to them (the correction the coordinator
 * made to the same check on the P4-S3 gate): `RED:` / `red:` and `PLANTED`,
 * and the numbered-rule form the refusal catalogue uses throughout.
 */
const PLANTED_DEFECT_TITLE = /\b(?:red|planted)\b|\brule\s+\d+[a-z]?\b.*\b(?:names|name|fire|fires|satisfied|cannot)\b/i;

/** The guard directory, read off this gate's own named CI-composition row rather than written down a second time. */
const GUARD_DIR = CI_COMPOSITION_SUITE.slice(0, CI_COMPOSITION_SUITE.lastIndexOf('/'));

/** The three kinds this roster actually holds, each read off the file rather than prescribed to it. */
export type RosterKind = 'law' | 'golden' | 'behaviour';

/**
 * A rostered file's KIND.
 *
 *  - `law`       — it is in the guard directory, OR its subject is the
 *                  repository (above). It owes a planted defect, and every
 *                  block that announces one owes an EXECUTED refusal.
 *  - `golden`    — it is in this slice's golden directory, which the roster
 *                  rule already derives. Its claim is that a RECORDED world
 *                  still holds, so what it can lose is not a refusal but the
 *                  comparison itself: a golden read over an empty world
 *                  compares nothing to nothing and passes.
 *  - `behaviour` — it exercises the running system through the real command or
 *                  route.
 */
export function rosterSuiteKind(source: string, file: string): RosterKind {
  if (file.startsWith(`${GUARD_DIR}/`) || JUDGES_THE_TREE.some((re) => re.test(source))) return 'law';
  if (file.startsWith(`${S4_GOLDEN_DIR}/`)) return 'golden';
  return 'behaviour';
}

/**
 * THE SHAPE OF AN EXECUTED RED.
 *
 * A law announces its planted defect in an `it(` title, and a title is PROSE:
 * `PLANTED_DEFECT_TITLE` alone was satisfiable by writing the word "red", and
 * ONE matching title satisfied the whole file however many blocks it held.
 * `p4s4-command-refusal-audit-law.test.ts` carries 15 titles of which exactly
 * one matches, and under the old law that passed exactly as 15 of 15 would.
 *
 * The half a title cannot fake is an assertion that the law ACTUALLY REFUSED
 * the plant: that its problem list came back non-empty, that a satisfaction
 * predicate came back false, that the refusal's own message matched, or that
 * the planted subject differs from the real one. Each shape here is read off
 * this estate's own planted-defect blocks rather than prescribed to them — the
 * budget ratchet's plant refuses through `toBe(false)` and `toMatch(/is
 * missing/)`, the workflow plants through `not.toEqual([])`, the evidence
 * plants through `toContain(`.
 *
 * What is deliberately NOT here is the assertion of SILENCE (`toEqual([])`),
 * which is the whole point: a law that only ever asserts its problem list is
 * empty has executed its silence and never once executed its refusal.
 */
const EXECUTED_RED =
  /\bnot\s*\.\s*to(?:Strict)?Equal\s*\(|\bnot\s*\.\s*toHaveLength\s*\(\s*0\s*\)|\bnot\s*\.\s*toBe\w*\s*\(|\btoBeGreaterThan\s*\(\s*0\s*\)|\btoBeGreaterThanOrEqual\s*\(\s*1\s*\)|\btoContain\w*\s*\(|\btoMatch\w*\s*\(|\btoBe\s*\(\s*false\s*\)|\btoBeFalsy\s*\(|\btoThrow\w*\s*\(|\.rejects\b/;

/**
 * THE TOP-LEVEL `describe(` BLOCKS OF A SUITE, as title and body.
 *
 * The SUBJECT of the planted-defect obligation is the BLOCK, not the file.
 * Anchored at column 0 (`^describe`), which is where this estate's suites put
 * their top-level blocks, so a nested `describe` inside one belongs to its
 * parent's body and is judged together with it.
 */
export function describeBlocks(source: string): readonly { readonly title: string; readonly body: string }[] {
  const marks: { at: number; title: string }[] = [];
  for (const m of source.matchAll(/^describe(?:\.\w+)?\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gm))
    marks.push({ at: m.index ?? 0, title: (m[2] ?? '').replace(/\\([\s\S])/g, '$1') });
  return marks.map((mark, i) => ({
    title: mark.title,
    body: source.slice(mark.at, i + 1 < marks.length ? (marks[i + 1]?.at ?? source.length) : source.length),
  }));
}

/**
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`, applied to EVERY
 * rostered file and not only to the ones in one directory.
 *
 * WHAT EACH KIND OWES, and why the three are not the same:
 *
 *  - EVERY kind owes a runnable `it(` title, and at least one DISCRIMINATING
 *    ASSERTION (above). A file the runner opens and finds nothing in is not
 *    evidence, and a file whose every assertion is a bare positive equality is
 *    green when the thing it is about is deleted.
 *
 *  - A LAW owes, on top of that, BOTH halves of a planted-defect proof: a
 *    title that announces the plant, so a reader of the run's log can find it,
 *    AND an EXECUTED RED — an assertion that the law's refusal came back
 *    non-empty. The title alone was the hole: it is prose.
 *
 *  - A GOLDEN suite owes, on top of the universal floor, a NON-VACUITY floor
 *    on its own subject: a golden comparison over an empty recorded world
 *    compares nothing to nothing. It does NOT owe a planted defect, and this
 *    law says so rather than falling silent: its subject is a recorded run of
 *    the real system, not a file on disk, so there is nothing in it to plant a
 *    defect in. Both of this slice's goldens carry the estate's own idiom for
 *    the thing they owe instead — `that law can say no: …`.
 *
 *  - A BEHAVIOUR suite owes the universal floor and NOTHING FURTHER, and this
 *    law states that too. It drives the real command or route against a real
 *    database; its subject exists only while it runs. Its falsifiability is
 *    demonstrated by `check:roster-execution`, which hands it to a bounded
 *    Vitest run and refuses a skipped, todo, only-marked or absent test —
 *    not by a mutation this gate could apply to a file.
 *
 * Nothing here is a list of exceptions: the kind is computed from the file's
 * own bytes and from the golden directory the roster rule already derives.
 */
export function rosterRedProofProblems(root: string): string[] {
  const problems: string[] = [];
  for (const file of rosterFiles(root)) {
    if (!has(root, file)) {
      problems.push(`${file} is on the roster and does not exist`);
      continue;
    }
    const source = read(root, file);
    const titles = testTitles(source);
    if (titles.length === 0) {
      problems.push(`${file} holds no runnable it( title — a file the runner opens and finds nothing in is not evidence`);
      continue;
    }
    const kind = rosterSuiteKind(source, file);
    if (kind === 'law') {
      if (!titles.some((t) => PLANTED_DEFECT_TITLE.test(t)))
        problems.push(
          `${file} judges the repository and no it( title announces a planted defect — a law with no demonstrated red is a law nobody has shown can refuse anything`,
        );
      // EVERY block that announces a plant owes an EXECUTED refusal. This is
      // what stops ONE matching title from satisfying a whole file, and what
      // stops the word "red" in prose from satisfying even one block.
      for (const block of describeBlocks(source)) {
        const announces = PLANTED_DEFECT_TITLE.test(block.title) || testTitles(block.body).some((t) => PLANTED_DEFECT_TITLE.test(t));
        if (announces && !EXECUTED_RED.test(block.body))
          problems.push(
            `${file} — the block \`${block.title}\` announces a planted defect and asserts no refusal anywhere inside it: it never asserts the law's problem list came back non-empty, nor that a satisfaction predicate came back false, nor that the refusal's own message matched, nor that the planted subject differs from the real one. A title carrying the word "red" is prose; a block that only ever asserts silence has executed its silence and never once executed its refusal`,
          );
      }
    }
    if (
      kind === 'golden' &&
      !/\btoBeGreaterThan(?:OrEqual)?\s*\(|\bnot\s*\.\s*toHaveLength\s*\(\s*0\s*\)|\bnot\s*\.\s*to(?:Strict)?Equal\s*\(\s*\[\s*\]\s*\)/.test(source)
    )
      problems.push(
        `${file} is a golden suite and asserts no floor on its own subject — a golden comparison over an empty recorded world compares nothing to nothing and passes, so the recorded world has to be shown to be there`,
      );
  }
  return problems;
}

/** WHICH KIND EVERY ROSTERED FILE WAS JUDGED AS, printed on a PASS as well as on a FAIL: a law nobody can see the scope of is a law nobody can audit. */
export function rosterRedProofReport(root: string): string {
  const byKind: Record<RosterKind, string[]> = { law: [], golden: [], behaviour: [] };
  for (const file of rosterFiles(root)) {
    if (!has(root, file)) continue;
    byKind[rosterSuiteKind(read(root, file), file)].push(file.slice(file.lastIndexOf('/') + 1));
  }
  let announcing = 0;
  for (const file of rosterFiles(root)) {
    if (!has(root, file)) continue;
    const source = read(root, file);
    if (rosterSuiteKind(source, file) !== 'law') continue;
    for (const block of describeBlocks(source))
      if (PLANTED_DEFECT_TITLE.test(block.title) || testTitles(block.body).some((t) => PLANTED_DEFECT_TITLE.test(t))) announcing += 1;
  }
  return `${(['law', 'golden', 'behaviour'] as const)
    .map((k) => `${byKind[k].length} ${k}${k === 'behaviour' ? '' : '(s)'}: ${byKind[k].join(', ') || 'none'}`)
    .join('; ')}; ${announcing} plant-announcing describe( block(s), each required to execute a refusal`;
}

// ───── THE ACCEPTANCE TRANSITION ITSELF ───────────────────────────────────

/**
 * The permanent machinery: the names the ACCEPTED tense still reads, and which
 * therefore may not be declared inside a fenced region. `S4_ACCEPTED` is the
 * sharpest case — acceptance FILLS it and then deletes the fences, so a fence
 * that contained it would delete the literal that had just been filled.
 */
export const PERMANENT_TENSE_NAMES = ['S4_ACCEPTED', 'candidateMigrations', 'sliceMigrations'] as const;

/** One fenced region of this file's text, as the markers delimit it. */
interface Fence {
  readonly start: number;
  readonly end: number;
}

/** Every `CANDIDATE-TENSE (P4-AL-61)` fenced region of a text, paired opening to closing. */
export function tenseFences(text: string): { readonly fences: readonly Fence[]; readonly problems: readonly string[] } {
  const opens = [...text.matchAll(/^[ \t]*\/\/ ─+ CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/gm)];
  const closes = [...text.matchAll(/^[ \t]*\/\/ ─+ end CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/gm)];
  if (opens.length !== closes.length)
    return {
      fences: [],
      problems: [
        `${SELF}: the candidate-tense fences are not paired — ${opens.length} opening marker(s) and ${closes.length} closing, so the acceptance commit cannot know what to delete`,
      ],
    };
  const fences: Fence[] = [];
  const problems: string[] = [];
  for (let k = 0; k < opens.length; k += 1) {
    const o = opens[k];
    const c = closes[k];
    if (o?.index === undefined || c?.index === undefined) continue;
    if (c.index < o.index) {
      problems.push(`${SELF}: a candidate-tense fence closes at offset ${c.index} before it opens at ${o.index}`);
      continue;
    }
    fences.push({ start: o.index, end: c.index + c[0].length });
  }
  return { fences, problems };
}

/**
 * THE ACCEPTANCE COMMIT MUST LEAVE A TREE THAT COMPILES.
 *
 * `selfClosureProblems` already requires the candidate-tense material to be
 * FENCED, so acceptance can find what to delete. That is only half the
 * property: a fence is safe to delete only if nothing OUTSIDE it reads a name
 * declared INSIDE it. Nothing asserted that, and nothing was going to notice,
 * because every check in this file runs in the candidate tense where the fence
 * is still there. The defect was real and was found by rehearsing the
 * transition on a scratch tree: `S4_ACCEPTED` itself, `candidateMigrations`
 * and the `CHECKS` entry registering the two candidate-only functions were all
 * on the wrong side of the one fence, and the sealed tree did not compile —
 * fifteen TypeScript errors, in the one commit that is required to be green.
 *
 * So this law reads the transition rather than the tense: it DELETES every
 * fenced region from the text in memory, and then asks whether the remainder
 * still names anything the deletion removed. It is universally quantified over
 * whatever fences the file holds and whatever they declare; nothing is listed
 * but `PERMANENT_TENSE_NAMES`, which is the comparison's left-hand side and
 * not the subject of a law.
 *
 * In the ACCEPTED tense there is no fence, the question is vacuous by
 * construction and `selfClosureProblems` owns the "no marker survived"
 * assertion. Saying so is the one correct verdict then — the forward-evolution
 * trap this very slice closed in `newRelationCoverageProblems`.
 */
export function fenceDeletionProblems(root: string): string[] {
  return fenceDeletionProblemsIn(read(root, SELF), S4_ACCEPTED);
}

/**
 * The law itself, over a TEXT and a TENSE, so a fixture can plant each defect
 * and require it to be named. A law whose only entry point reads the real tree
 * can be proved green and never proved capable of red — which is exactly how
 * the defect this law exists for survived.
 */
export function fenceDeletionProblemsIn(text: string, accepted: Readonly<Record<string, string>>): string[] {
  const { fences, problems } = tenseFences(text);
  const out = [...problems];
  const candidate = Object.keys(accepted).length === 0;
  if (fences.length === 0) {
    // Vacuous in the accepted tense, and a finding in the candidate one.
    if (candidate && out.length === 0)
      out.push(
        `${SELF}: P4-S4 is a candidate and this file holds no candidate-tense fenced region at all — there is then nothing for the acceptance commit to delete`,
      );
    return out;
  }
  // The names each fenced region declares, discovered from its own text.
  const declared = new Map<string, number>();
  for (const [k, f] of fences.entries())
    for (const m of text.slice(f.start, f.end).matchAll(/^\s*export (?:async function|function|const|class|type|interface) (\w+)/gm))
      if (m[1] !== undefined) declared.set(m[1], k);
  // The remainder, with every fenced region blanked so offsets and line
  // numbers still line up, and with comments and literals masked so a name
  // inside explanatory prose is not read as a reference to it.
  const chars = maskLiterals(text).split('');
  for (const f of fences) for (let i = f.start; i < f.end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  const remainder = chars.join('');
  for (const [name, k] of [...declared.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hit = new RegExp(String.raw`\b${name}\b`).exec(remainder);
    if (hit === null) continue;
    const line = remainder.slice(0, hit.index).split('\n').length;
    out.push(
      `${SELF}:${line}: ${name} is declared inside candidate-tense fenced region ${k + 1} and read outside it — the acceptance commit deletes that region, so the sealed tree would not compile. Move ${name} above the fence if the accepted tense still reads it, or move its reader inside the fence with it`,
    );
  }
  for (const name of PERMANENT_TENSE_NAMES) {
    const where = declared.get(name);
    if (where !== undefined)
      out.push(
        `${SELF}: ${name} is declared inside candidate-tense fenced region ${where + 1} — it is permanent machinery the ACCEPTED tense reads, and acceptance fills ${name === 'S4_ACCEPTED' ? 'it and then deletes that region, which would delete the literal it had just filled' : 'the tense it serves'}`,
      );
    else if (!new RegExp(String.raw`export (?:function|const) ${name}\b`).test(text))
      out.push(`${SELF}: ${name} is not declared at all, so this law cannot tell which side of the fence it is on`);
  }
  // NON-VACUITY: a fenced region that declares nothing would make the
  // reference sweep above pass over an empty set of names.
  if (declared.size === 0)
    out.push(
      `${SELF}: ${fences.length} candidate-tense fenced region(s) declare no exported name between them, so the reference sweep judged nothing and its silence is not evidence`,
    );
  return out;
}

/** What the transition law looked at, printed on a PASS as well as on a FAIL. */
export function fenceDeletionReport(root: string): string {
  const text = read(root, SELF);
  const { fences } = tenseFences(text);
  if (fences.length === 0) return 'no candidate-tense fenced region: the accepted tense has none, and selfClosureProblems owns that assertion';
  const names: string[] = [];
  for (const f of fences)
    for (const m of text.slice(f.start, f.end).matchAll(/^\s*export (?:async function|function|const|class|type|interface) (\w+)/gm))
      if (m[1] !== undefined) names.push(m[1]);
  return `${fences.length} fenced region(s) declaring ${names.length} exported name(s) (${names.join(', ') || 'none'}), none of them read outside the fences; ${PERMANENT_TENSE_NAMES.length} permanent name(s) all declared outside`;
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
    id: 'acceptance-transition',
    title: 'the acceptance commit leaves a tree that compiles (P4-AL-61)',
    run: fenceDeletionProblems,
    note: fenceDeletionReport,
    ok: 'every candidate-tense fenced region is paired, nothing outside a fence reads a name declared inside one, and S4_ACCEPTED, candidateMigrations and sliceMigrations are all declared outside every fence',
  },
  // ───── CANDIDATE-TENSE (P4-AL-61) — the registration ──────────────────
  // Fenced with the block it registers: a check whose two functions the
  // acceptance commit deletes cannot keep its entry here, and an entry left
  // behind would not compile.
  {
    id: 'candidate-tense',
    title: 'P4-S4 in the CANDIDATE tense (P4-AL-61)',
    run: candidateTenseProblems,
    note: candidateReport,
    ok: 'nothing of P4-S4 is digest-pinned by this gate or by the permanent prefix module, and the manifest freezes no candidate',
  },
  // ───── end CANDIDATE-TENSE (P4-AL-61) — the registration ──────────────
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
    id: 'evidence-integrity',
    title: 'what the measured steps EXECUTE, not only what they are named',
    run: evidenceIntegrityProblems,
    note: evidenceIntegrityReport,
    ok: 'every measured suite is in the tree, carries no skipped, exclusive or todo block, is named by the script body that runs it, is wrapped by no npm pre/post hook, and is collected by a root config that neither excludes a directory nor passes with no tests',
  },
  {
    id: 'evidence-coverage',
    title: "the evidence table's MEMBERSHIP, cross-checked against the measurements the tree carries",
    run: evidenceCoverageProblems,
    note: evidenceCoverageReport,
    ok: "the table equals the measured suites on BOTH derivations: every runnable test file in the table's own directories that names a candidate migration is named by S4_EVIDENCE_STEPS and reached by the required `backend` job, and the suite files that job itself names, restricted to the ones the candidate surface attributes to this slice, are exactly the table's rows — so a measured suite cannot be added to this slice, or dropped from the workflow, and stay invisible to the three checks whose only subject the table is",
  },
  {
    id: 'roster-runner',
    title: 'every rostered suite is in a directory the runner actually runs',
    run: rosterRunnerProblems,
    note: rosterRunnerReport,
    ok: 'every rostered file falls under a `tests/` directory named by a `test*` script, so a suite cannot be dropped from CI by moving it while staying out of the roster',
  },
  {
    id: 'roster',
    title: "P4-S4's suite roster, DERIVED from the tree by one stated rule",
    run: rosterProblems,
    note: rosterReport,
    ok: 'the rule matched at least one suite, every matched file is one the root runner executes, and the CI-composition suite is present',
  },
  {
    id: 'roster-ratchet',
    title: 'the roster may GROW and may not silently shrink',
    run: rosterRatchetProblems,
    note: rosterRatchetReport,
    ok: "the derived roster is at or above its floor and every floored directory still holds a suite, so a rostered file cannot leave the roster — and this gate's execution — by being moved and renamed out of the basename rule while every per-file check stays green",
  },
  {
    id: 'roster-red-proofs',
    title: 'every rostered file carries the falsifiability proof ITS KIND owes',
    run: rosterRedProofProblems,
    note: rosterRedProofReport,
    ok: 'every rostered file holds a runnable it( title; every file whose subject is the REPOSITORY — the guard directory as a floor, UNIONED with what the file actually reads — announces a planted defect in a title AND executes a refusal in every block that announces one, so one title cannot satisfy a whole file and the word red cannot satisfy a block; every golden suite asserts a floor on its own recorded world; and a behaviour suite owes nothing further, because its subject exists only while it runs and `roster-execution` is what demonstrates it',
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
