/**
 * Guard G-3 (Architecture Lock, slice P2-S1; extended in P2-S7).
 *
 * Refuses an authoritative mutable balance column on an accounting
 * source-of-truth table. AL-15's failure mode is a stored number that
 * competes with the journal for being the truth: once `accounts.balance`
 * exists, something has to keep it right, and the day it drifts the ledger
 * and the column disagree with no way to tell which lied.
 *
 * The guard is about STORAGE AUTHORITY, not vocabulary. It reads schema only
 * — CREATE TABLE column lists and ALTER TABLE ... ADD COLUMN — for the tables
 * declared authoritative below. A report DTO, a query result or a TypeScript
 * field named `balance` is a read model and is none of this guard's business.
 */

/** Accounting source-of-truth tables. P2-S7 adds any read-model table it introduces. */
export const ACCOUNTING_AUTHORITY_TABLES = ['accounts'] as const;

/**
 * Column names that would claim storage authority over a derived financial
 * quantity: any balance, a running debit/credit total, a stock level.
 */
const FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [/(^|_)balances?($|_)/, /(^|_)(debit|credit)_(total|totals|sum|sums)($|_)/, /(^|_)stock($|_)/];

/** Table-level constraint openers — these are never column definitions. */
const CONSTRAINT_OPENERS = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE|DEFERRABLE)\b/i;

export interface BalanceColumnFinding {
  readonly table: string;
  readonly column: string;
}

export function isAuthoritativeBalanceColumn(column: string): boolean {
  const name = column.toLowerCase();
  return FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(name));
}

/**
 * Strip what is not schema: line comments, block comments, single-quoted
 * literals and dollar-quoted bodies. A comment that NAMES the anti-pattern
 * (as 0040 does, to say the column is deliberately absent) must not trip the
 * guard, and neither must a function body that happens to contain the word.
 */
function stripNonSchema(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += ' ';
      continue;
    }
    if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      i = j + 1;
      out += " '' ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Read the balanced parenthesised body that starts at `open`. */
function balancedBody(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/** Split a CREATE TABLE body on top-level commas only. */
function topLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) items.push(current);
  return items;
}

const unquote = (ident: string): string => ident.replace(/^"(.*)"$/, '$1').toLowerCase();

/**
 * Find authoritative balance columns declared on any of `tables` in one SQL
 * text. Returns every offending (table, column) pair; an empty array is a pass.
 */
export function findAuthoritativeBalanceColumns(sql: string, tables: readonly string[] = ACCOUNTING_AUTHORITY_TABLES): BalanceColumnFinding[] {
  const watched = new Set(tables.map((t) => t.toLowerCase()));
  const schema = stripNonSchema(sql);
  const findings: BalanceColumnFinding[] = [];

  // CREATE TABLE <name> ( ... )
  const create = /CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = create.exec(schema)) !== null) {
    const table = unquote(m[1] ?? '');
    if (!watched.has(table)) continue;
    const body = balancedBody(schema, create.lastIndex - 1);
    if (body === null) continue;
    for (const item of topLevelItems(body)) {
      const trimmed = item.trim();
      if (trimmed.length === 0 || CONSTRAINT_OPENERS.test(trimmed)) continue;
      const column = unquote(/^("[^"]+"|[A-Za-z_][\w$]*)/.exec(trimmed)?.[1] ?? '');
      if (column && isAuthoritativeBalanceColumn(column)) findings.push({ table, column });
    }
  }

  // ALTER TABLE <name> ... ADD [COLUMN] <name>
  const alter = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)([\s\S]*?);/gi;
  while ((m = alter.exec(schema)) !== null) {
    const table = unquote(m[1] ?? '');
    if (!watched.has(table)) continue;
    const addColumn = /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/gi;
    let a: RegExpExecArray | null;
    while ((a = addColumn.exec(m[2] ?? '')) !== null) {
      const column = unquote(a[1] ?? '');
      if (CONSTRAINT_OPENERS.test(column)) continue;
      if (isAuthoritativeBalanceColumn(column)) findings.push({ table, column });
    }
  }

  return findings;
}
