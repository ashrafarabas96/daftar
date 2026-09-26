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
 */
import { checkInventoryDefinerContract, inventoryRoutineDefinitions } from './inventory-definer-contract';
import { QUALIFIED_NAME, balancedBody, unquote } from './sql-schema';

/** The stock tables whose writes need a verified assertion, bridges included. */
export const STOCK_WRITE_TABLES =
  /^(stock_movements|stock_levels|stock_source_bindings|negative_inventory_deficits|negative_deficit_coverages|stock_source_bridge_\w+)$/;

/** Single-quoted literals out, so a message that names a table is not a write. */
function stripLiterals(body: string): string {
  return body.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * The stock tables a body writes: `INSERT INTO t`, `UPDATE t` (not
 * `FOR [NO KEY] UPDATE`), `DELETE FROM t`, `MERGE INTO t`, `TRUNCATE t, …`
 * and `COPY t FROM`, with `t` bare, quoted or schema-qualified.
 */
export function stockTablesWritten(body: string): string[] {
  const text = stripLiterals(body);
  const found = new Set<string>();
  const add = (name: string) => {
    const t = unquote(name);
    if (STOCK_WRITE_TABLES.test(t)) found.add(t);
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
export function assertionFirstProblem(first: string): string | null {
  const m = ASSERTION_CALL.exec(first);
  if (!m) return 'its first statement is not inventory_assertion_consume( / inventory_assertion_current(';
  const open = m.index + m[0].length - 1;
  const args = balancedBody(first, open);
  if (args === null) return 'its first statement is not a complete assertion call';
  const calls = functionCalls(args);
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

export interface InventoryWriterReport {
  readonly violations: string[];
  /** `file: routine` for every definition that writes a stock table — the set the rule is watching. */
  readonly writers: string[];
}

export function checkInventoryWriterAuthority(migrations: Readonly<Record<string, string>>): InventoryWriterReport {
  const transferred = new Set(checkInventoryDefinerContract({ migrations }).transferred);
  const violations: string[] = [];
  const writers: string[] = [];
  for (const d of inventoryRoutineDefinitions(migrations)) {
    if (!transferred.has(d.name) || d.body === null) continue;
    const tables = stockTablesWritten(d.body);
    if (tables.length === 0) continue;
    writers.push(`${d.file}: ${d.name}`);
    const problems: string[] = [];
    const first = assertionFirstProblem(firstStatement(d.body));
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
  return { violations, writers };
}
