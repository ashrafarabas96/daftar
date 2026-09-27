/**
 * Rule 22 — inventory writer authority (P3-S2, contract §7.2; PM-44 static half, P3-AL-55 §G).
 *
 * Every stock mutation is internal DEFINER code that has VERIFIED an
 * `invctl/1` assertion before it decided anything (P3-AL-55 §G, L:173). A
 * routine owned by `daftar_inventory_internal` runs with the principal's
 * INSERT/UPDATE on the ledger, so a new one that writes a stock table without
 * first consuming or re-reading the verified assertion would be a writer
 * nobody authorized — callable by anyone who is ever granted EXECUTE on it.
 *
 * The rule, per DEFINITION (every `CREATE FUNCTION` of a routine handed to the
 * principal, in every file — the parsing of G-7): if its body INSERTs into,
 * UPDATEs or DELETEs from a stock table, its FIRST statement after `BEGIN`
 * must call `inventory_assertion_consume(` or `inventory_assertion_current(`.
 * "First" is literal: an assertion checked after a read or a lock has already
 * let an unauthorized caller observe or block the ledger.
 *
 * The live half is the PM-44 catalogue sweep over `pg_proc.prosrc`
 * (tests/security, contract §6 T-16); this half fails on a pull request.
 *
 * ── Hardened after the independent security review (L-1) ────────────────
 *
 * - A write is any `INSERT INTO`, `UPDATE`, `DELETE FROM`, `MERGE INTO`,
 *   `TRUNCATE` or `COPY … FROM` of a stock table, however the table is
 *   written: bare, quoted, or schema-qualified.
 * - "First" means nothing runs before the check: the first statement is the
 *   assertion call and nothing else, its arguments call no function, the
 *   DECLARE section's initialisers (evaluated BEFORE the first statement)
 *   call nothing and query nothing, and the body has no `EXCEPTION WHEN`
 *   handler that could swallow the assertion's refusal and write anyway.
 * - A PROCEDURE, an `ALTER ROUTINE … OWNER TO` and a quoted owner are
 *   handovers like any other; G-7 (`inventory-definer-contract.ts`) reads
 *   them, and this rule watches what G-7 reports as transferred.
 *
 * ── Widened in P3-S8 (contract A-04, A-18(e); the static analogue of T-02) ──
 *
 * - The table set is no longer a name list. It is the TRUTH SET: every table
 *   a migration after `PHASE2_PREFIX_END` grants INSERT, UPDATE or DELETE to
 *   `daftar_inventory_internal` (table or column level), minus the key
 *   domain and the side-effect logs (`TRUTH_TABLE_EXCLUSIONS`, L:1868) — and
 *   still every table `STOCK_WRITE_TABLES` names. A new Phase 3 table the
 *   principal may write is watched the day its grant is written.
 * - The routines watched are every routine handed to the principal (as
 *   before) AND every routine a migration after the prefix defines, of any
 *   owner: a migrator-owned definer that wrote a truth table would be a
 *   writer nobody authorized just the same.
 * - "Its arguments call no function" becomes "its arguments call only PURE
 *   functions" (A-04 clause 2): a routine handed to the principal whose every
 *   definition is declared IMMUTABLE or STABLE and whose body writes nothing
 *   (the digest helpers `inventory_claimed_payload_digest`,
 *   `inventory_fixed_text`, `inventory_reason_words`), or one of the exact
 *   built-ins `PURE_BUILTINS`, whose volatility T-02 proves live. Anything
 *   else — a VOLATILE helper, a writer, an unknown name — is still refused.
 * - The exception set is exact: `WRITER_AUTHORITY_EXCEPTIONS` =
 *   { warehouses_home_branch_maintain }, the derived home-association
 *   maintainer the frozen `provision_create_business` reaches (L:1837-1839,
 *   L:2161). An exception that no longer writes a truth table is reported,
 *   so the set cannot silently outlive its reason.
 */
import { PHASE2_PREFIX_END } from '../phase2-prefix';
import { checkInventoryDefinerContract, inventoryRoutineDefinitions, type InventoryRoutineDefinition } from './inventory-definer-contract';
import { QUALIFIED_NAME, balancedBody, stripComments, stripNonSchema, unquote } from './sql-schema';

/**
 * The stock tables whose writes need a verified assertion, bridges included.
 *
 * P3-S4 (S4 contract §7.2): `negative_inventory_cost_adjustments`, the
 * coverage header whose value N the receipt posts against COGS, joins the
 * set. Its one writer, `purchase_cover_deficits`, already writes the deficits
 * and coverages and opens with `inventory_assertion_current(...)`, so the
 * writer list is unchanged; a new routine that inserted a header without
 * that check would not be.
 *
 * P3-S5 (S5 contract §7.2, TL-13, 0066 R-55): `supplier_credit_notes` joins
 * the set; its one writer is `purchase_bridge_credit_note`, which opens with
 * `inventory_assertion_current(...)`.
 */
export const STOCK_WRITE_TABLES =
  /^(stock_movements|stock_levels|stock_source_bindings|negative_inventory_deficits|negative_deficit_coverages|negative_inventory_cost_adjustments|supplier_credit_notes|stock_source_bridge_\w+)$/;

/**
 * P3-S8 (A-04, §0): tables the principal may write that are NOT domain truth
 * — the assertion key domain and the side-effect logs. Their writers are
 * governed by the key-domain contract (L:1868), not by this rule.
 */
export const TRUTH_TABLE_EXCLUSIONS: readonly string[] = ['inventory_assertion_keys', 'inventory_assertion_uses', 'audit_events', 'outbox_events'];

/** P3-S8 (A-04): the one routine that writes a truth table without an assertion, asserted exactly. */
export const WRITER_AUTHORITY_EXCEPTIONS: readonly string[] = ['warehouses_home_branch_maintain'];

/** P3-S8 (A-04 clause 2): the built-ins an assertion call's arguments may use; T-02 proves each is IMMUTABLE or STABLE live. */
export const PURE_BUILTINS: readonly string[] = ['unnest', 'cardinality', 'to_char', 'lower', 'extract', 'trunc', 'generate_series', 'array_fill'];

const INVENTORY_PRINCIPAL = 'daftar_inventory_internal';

/** Whether a migration path is after the Phase 2 prefix, i.e. a Phase 3 (or later) file. */
export function isAfterPhase2Prefix(path: string): boolean {
  return (path.split('/').pop() ?? path) > PHASE2_PREFIX_END;
}

/** Objects a GRANT can name that are not tables. */
const NOT_A_TABLE_GRANT = /^\s*(?:FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|SEQUENCE|LANGUAGE|TYPE|DOMAIN|FOREIGN|LARGE|TABLESPACE|PARAMETER|ALL\s)/i;

/**
 * The truth set of A-04, read statically: every table a migration after the
 * Phase 2 prefix grants INSERT, UPDATE or DELETE (or ALL) to the inventory
 * principal, at table or column level, minus `TRUTH_TABLE_EXCLUSIONS`.
 * Sorted.
 */
export function truthTables(migrations: Readonly<Record<string, string>>): string[] {
  const found = new Set<string>();
  const tableItem = new RegExp(String.raw`^\s*(?:ONLY\s+)?${QUALIFIED_NAME}\s*$`, 'i');
  for (const [path, sql] of Object.entries(migrations)) {
    if (!isAfterPhase2Prefix(path)) continue;
    for (const m of stripNonSchema(sql).matchAll(/\bGRANT\s+([^;]+?)\s+ON\s+([^;]+?)\s+TO\s+([^;]+?)\s*;/gi)) {
      const [, privText = '', objText = '', granteeText = ''] = m;
      if (NOT_A_TABLE_GRANT.test(objText)) continue;
      const grantees = granteeText
        .replace(/\s+WITH\s+GRANT\s+OPTION\s*$/i, '')
        .split(',')
        .map((g) => unquote(g.trim()));
      if (!grantees.includes(INVENTORY_PRINCIPAL)) continue;
      const privileges = privText
        .replace(/\([^)]*\)/g, ' ')
        .split(',')
        .map((p) => p.trim().toUpperCase());
      if (!privileges.some((p) => p === 'INSERT' || p === 'UPDATE' || p === 'DELETE' || p.startsWith('ALL'))) continue;
      for (const item of objText.replace(/^\s*TABLE\s+/i, '').split(',')) {
        const name = tableItem.exec(item);
        if (name) found.add(unquote(name[1] ?? ''));
      }
    }
  }
  for (const excluded of TRUTH_TABLE_EXCLUSIONS) found.delete(excluded);
  return [...found].sort();
}

/** Single-quoted literals out, so a message that names a table is not a write. */
function stripLiterals(body: string): string {
  return body.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * The stock tables a body writes: `INSERT INTO t`, `UPDATE t` (not
 * `FOR [NO KEY] UPDATE`), `DELETE FROM t`, `MERGE INTO t`, `TRUNCATE t, …`
 * and `COPY t FROM`, with `t` bare, quoted or schema-qualified.
 */
export function stockTablesWritten(body: string, watched: (table: string) => boolean = (t) => STOCK_WRITE_TABLES.test(t)): string[] {
  const text = stripLiterals(body);
  const found = new Set<string>();
  const add = (name: string) => {
    const t = unquote(name);
    if (watched(t)) found.add(t);
  };
  const patterns = [
    new RegExp(String.raw`\bINSERT\s+INTO\s+${QUALIFIED_NAME}`, 'gi'),
    new RegExp(String.raw`(?<!\bFOR\s+(?:NO\s+KEY\s+)?)\bUPDATE\s+(?:ONLY\s+)?${QUALIFIED_NAME}`, 'gi'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${QUALIFIED_NAME}`, 'gi'),
    new RegExp(String.raw`\bMERGE\s+INTO\s+(?:ONLY\s+)?${QUALIFIED_NAME}`, 'gi'),
    new RegExp(String.raw`\bCOPY\s+${QUALIFIED_NAME}\s*(?:\([^)]*\)\s*)?FROM\b`, 'gi'),
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) add(m[1] ?? '');
  // TRUNCATE takes a list: every table in it is written.
  for (const m of text.matchAll(/\bTRUNCATE\b(?:\s+TABLE\b)?([^;]*)/gi)) {
    for (const item of (m[1] ?? '').split(',')) {
      const name = new RegExp(String.raw`^\s*(?:ONLY\s+)?${QUALIFIED_NAME}`, 'i').exec(item);
      if (name) add(name[1] ?? '');
    }
  }
  return [...found].sort();
}

/** Where the executable part of a body starts: just after its first `BEGIN` (or `BEGIN ATOMIC`), or 0 for a `LANGUAGE sql` body. */
function statementsStart(text: string): number {
  const begin = /\bBEGIN\b(?:\s+ATOMIC\b)?/i.exec(text);
  return begin ? begin.index + begin[0].length : 0;
}

/**
 * The first statement of a routine body: the text after the first `BEGIN` up
 * to its `;` (a `LANGUAGE sql` body has no `BEGIN`, so its first statement
 * is the body's first). Literals are blanked first; comments are already
 * gone.
 */
export function firstStatement(body: string): string {
  const text = stripLiterals(body);
  const from = statementsStart(text);
  const end = text.indexOf(';', from);
  return text.slice(from, end < 0 ? text.length : end).trim();
}

/**
 * The words that open a parenthesis without calling a function: SQL syntax
 * (`ARRAY(`, `EXISTS (`, `IN (`, `FROM (`…) and the conditional expressions
 * PostgreSQL evaluates itself. Everything else followed by `(` is a call.
 */
const NOT_A_CALL = new Set([
  'array',
  'row',
  'in',
  'any',
  'some',
  'all',
  'exists',
  'values',
  'cast',
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'from',
  'join',
  'where',
  'and',
  'or',
  'not',
  'on',
  'select',
  'as',
  'by',
  'when',
  'then',
  'else',
  'is',
  'distinct',
  'lateral',
  'case',
  'with',
  'union',
  'intersect',
  'except',
  'using',
  'between',
  'like',
  'ilike',
  'into',
]);

/** The functions an expression calls, by bare name: `f(`, `public.f(`, `"f"(` — never a `::type(p,s)` modifier. */
export function functionCalls(expression: string): string[] {
  const text = stripLiterals(expression);
  const calls: string[] = [];
  const re = new RegExp(String.raw`(?<!::\s*)(?<!\bAS\s+)${QUALIFIED_NAME}\s*\(`, 'gi');
  for (const m of text.matchAll(re)) {
    const name = unquote(m[1] ?? '');
    if (!NOT_A_CALL.has(name)) calls.push(name);
  }
  return calls;
}

const ASSERTION_CALL = /^(?:[A-Za-z_][A-Za-z0-9_.]*\s*:?=\s*|SELECT\s+|PERFORM\s+)?(?:"?public"?\s*\.\s*)?"?inventory_assertion_(?:consume|current)"?\s*\(/i;

/**
 * Why a first statement is not exactly one assertion call, or null when it
 * is: the call must open the statement, its arguments must call nothing, and
 * nothing may follow it but `INTO <target>`.
 */
export function assertionFirstProblem(first: string, isPure: (name: string) => boolean = () => false): string | null {
  const m = ASSERTION_CALL.exec(first);
  if (!m) return 'its first statement is not inventory_assertion_consume( / inventory_assertion_current(';
  const open = m.index + m[0].length - 1;
  const args = balancedBody(first, open);
  if (args === null) return 'its first statement is not a complete assertion call';
  // P3-S8 (A-04 clause 2): a pure call computes the claimed digest; anything else could act before the assertion runs.
  const calls = functionCalls(args).filter((name) => !isPure(name));
  if (calls.length > 0) return `its assertion call's arguments call ${calls.join(', ')} before the assertion runs`;
  const tail = first.slice(open + args.length + 2);
  if (!/^\s*(?:INTO\s+(?:STRICT\s+)?[A-Za-z_][\w$.]*(?:\s*,\s*[A-Za-z_][\w$.]*)*)?\s*$/i.test(tail)) {
    return 'its first statement does more than call the assertion';
  }
  return null;
}

/**
 * What a body's DECLARE section runs before its first statement: every
 * initialiser (`:=`, `=` or `DEFAULT`) that calls a function or runs a query.
 * A bound cursor's query runs at OPEN, not here, so it is not an initialiser.
 */
export function declareInitialiserProblems(body: string): string[] {
  const text = stripLiterals(body);
  const begin = /\bBEGIN\b/i.exec(text);
  if (!begin) return [];
  const problems: string[] = [];
  for (const item of text.slice(0, begin.index).split(';')) {
    if (/\bCURSOR\b[\s\S]*\b(?:FOR|IS)\b/i.test(item)) continue;
    const init = /(?::=|=|\bDEFAULT\b)([\s\S]*)$/i.exec(item);
    if (!init) continue;
    const expression = init[1] ?? '';
    const calls = functionCalls(expression);
    if (calls.length > 0) problems.push(`a DECLARE initialiser calls ${calls.join(', ')} before the assertion runs`);
    if (/\bSELECT\b/i.test(expression)) problems.push('a DECLARE initialiser runs a query before the assertion runs');
  }
  return problems;
}

/** Any write to any table: the "writes nothing" half of purity. */
const ANY_WRITE =
  /\bINSERT\s+INTO\b|(?<!\bFOR\s+(?:NO\s+KEY\s+)?)\bUPDATE\s+(?:ONLY\s+)?(?:"[^"]+"|[A-Za-z_][\w$.]*)\s+(?:(?:AS\s+)?[A-Za-z_]\w*\s+)?SET\b|\bDELETE\s+FROM\b|\bMERGE\s+INTO\b|\bTRUNCATE\b|\bCOPY\b[^;]*\bFROM\b/i;

/**
 * The options of one definition: the text from its `CREATE` to its body
 * delimiter, in the comment-stripped file (`stripped`: file → text, filled
 * lazily so each file is stripped once).
 */
function definitionHeader(migrations: Readonly<Record<string, string>>, stripped: Map<string, string>, d: InventoryRoutineDefinition): string {
  let text = stripped.get(d.file);
  if (text === undefined) {
    const path = Object.keys(migrations).find((p) => (p.split('/').pop() ?? p) === d.file) ?? d.file;
    text = stripComments(migrations[path] ?? '');
    stripped.set(d.file, text);
  }
  const rest = text.slice(d.offset, d.end);
  const start = /\$[A-Za-z_]*\$|\bAS\s+'|\bRETURN\b|\bBEGIN\s+ATOMIC\b/i.exec(rest);
  return rest.slice(0, start?.index ?? rest.length);
}

/**
 * The routines an assertion call's arguments may call (A-04 clause 2): every
 * routine handed to the principal whose EVERY definition is declared
 * IMMUTABLE or STABLE and writes nothing, plus `PURE_BUILTINS`. Sorted.
 * `definitions` and `transferred` default to a fresh parse of `migrations`.
 */
export function pureAssertionHelpers(
  migrations: Readonly<Record<string, string>>,
  definitions: readonly InventoryRoutineDefinition[] = inventoryRoutineDefinitions(migrations),
  transferred: ReadonlySet<string> = new Set(checkInventoryDefinerContract({ migrations }).transferred),
): string[] {
  const byName = new Map<string, InventoryRoutineDefinition[]>();
  for (const d of definitions) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const stripped = new Map<string, string>();
  const pure: string[] = [];
  for (const [name, defs] of byName) {
    if (!transferred.has(name)) continue;
    const everyDefinitionPure = defs.every((d) => {
      const header = definitionHeader(migrations, stripped, d);
      const declared = /\b(IMMUTABLE|STABLE)\b/i.test(header) && !/\bVOLATILE\b/i.test(header);
      return declared && d.body !== null && !ANY_WRITE.test(stripLiterals(d.body));
    });
    if (everyDefinitionPure) pure.push(name);
  }
  return [...pure, ...PURE_BUILTINS].sort();
}

export interface InventoryWriterReport {
  readonly violations: string[];
  /** `file: routine` for every definition that writes a stock or truth table — the set the rule is watching. */
  readonly writers: string[];
  /** `file: routine` for the definitions `WRITER_AUTHORITY_EXCEPTIONS` exempts (P3-S8, A-04). */
  readonly exempt: string[];
  /** The truth set watched beside the `STOCK_WRITE_TABLES` names (P3-S8, A-04). */
  readonly truthTables: string[];
}

export function checkInventoryWriterAuthority(migrations: Readonly<Record<string, string>>): InventoryWriterReport {
  const transferred = new Set(checkInventoryDefinerContract({ migrations }).transferred);
  const definitions = inventoryRoutineDefinitions(migrations);
  const truth = truthTables(migrations);
  const truthSet = new Set(truth);
  const watched = (t: string): boolean => STOCK_WRITE_TABLES.test(t) || truthSet.has(t);
  const pure = new Set(pureAssertionHelpers(migrations, definitions, transferred));
  const violations: string[] = [];
  const writers: string[] = [];
  const exempt: string[] = [];
  for (const d of definitions) {
    if (d.body === null) continue;
    // Handed to the principal (in any file), or defined after the prefix (of any owner): P3-S8, A-04.
    if (!transferred.has(d.name) && !isAfterPhase2Prefix(d.file)) continue;
    const tables = stockTablesWritten(d.body, watched);
    if (tables.length === 0) continue;
    if (WRITER_AUTHORITY_EXCEPTIONS.includes(d.name)) {
      exempt.push(`${d.file}: ${d.name}`);
      continue;
    }
    writers.push(`${d.file}: ${d.name}`);
    const problems: string[] = [];
    const first = assertionFirstProblem(firstStatement(d.body), (name) => pure.has(name));
    if (first !== null) problems.push(first);
    problems.push(...declareInitialiserProblems(d.body));
    if (/\bEXCEPTION\s+WHEN\b/i.test(stripLiterals(d.body))) {
      problems.push('it has an EXCEPTION WHEN handler, which could swallow the assertion refusal and write anyway');
    }
    for (const problem of problems) {
      violations.push(
        `${d.file}: ${d.name} writes ${tables.join(', ')} but ${problem} — every stock writer verifies invctl/1 before anything else (PM-44, rule 22)`,
      );
    }
  }
  // The exception set is exact (A-04): an exception that writes no truth table any more has outlived its reason.
  for (const name of WRITER_AUTHORITY_EXCEPTIONS) {
    if (truth.length > 0 && !exempt.some((e) => e.endsWith(`: ${name}`))) {
      violations.push(`${name} is a rule-22 exception but writes no truth table — the exception set is exact and must shrink with it (A-04)`);
    }
  }
  return { violations, writers, exempt, truthTables: truth };
}
