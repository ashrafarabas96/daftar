/**
 * Minimal, deliberately boring SQL schema reading, shared by the static
 * guards that need to look at column declarations (G-2, G-3).
 *
 * These guards run before any database exists, so they read migration TEXT.
 * That means they must not be fooled by a comment that names the very
 * anti-pattern it is documenting, by a string literal, or by a PL/pgSQL body
 * that happens to contain the word — which is what `stripNonSchema` is for.
 */

/**
 * Strip ONLY comments, keeping literals and dollar-quoted bodies.
 *
 * `stripNonSchema` is the right reader for a column declaration, but it also
 * discards PL/pgSQL bodies — and some rules are precisely about what a body
 * does (does 0043 call ROUND()? does anything set session_replication_role?).
 * For those, a comment that names the anti-pattern it forbids must not be
 * mistaken for the anti-pattern itself, and nothing else may be dropped.
 */
export function stripComments(sql: string): string {
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
      out += ' ';
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * Strip what is not schema: line comments, block comments, single-quoted
 * literals and dollar-quoted bodies.
 */
export function stripNonSchema(sql: string): string {
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
export function balancedBody(sql: string, open: number): string | null {
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
export function topLevelItems(body: string): string[] {
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

export const unquote = (ident: string): string => ident.replace(/^"(.*)"$/, '$1').toLowerCase();

/**
 * A relation name as a migration may write it: bare, quoted, or qualified by
 * a schema that is itself bare or quoted, with optional space around the dot
 * — `stock_levels`, `"stock_levels"`, `public.stock_levels`,
 * `"public" . "stock_levels"`. Capture group 1 is the relation; `unquote` it.
 * A reader that took the first identifier would read `public` and see
 * nothing (P3-S2 security review, L-3).
 */
export const QUALIFIED_NAME = String.raw`(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?("[^"]+"|[A-Za-z_][\w$]*)`;

/** `ALTER TABLE [IF EXISTS] [ONLY] <name> [*] <actions>;`, either modifier order. Group 1: the table; group 2: the actions. */
const ALTER_TABLE = String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED_NAME}\s*\*?([\s\S]*?);`;

/** Table-level constraint openers — these are never column definitions. */
export const CONSTRAINT_OPENERS = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE|DEFERRABLE)\b/i;

export interface ColumnDeclaration {
  readonly table: string;
  readonly column: string;
  /** Everything after the column name, as written (type plus modifiers). */
  readonly rest: string;
}

/**
 * Every column declaration in one SQL text, from `CREATE TABLE` bodies and
 * from `ALTER TABLE ... ADD [COLUMN]`, restricted to `tables` when given.
 */
export function findColumnDeclarations(sql: string, tables?: readonly string[]): ColumnDeclaration[] {
  const watched = tables ? new Set(tables.map((t) => t.toLowerCase())) : null;
  const schema = stripNonSchema(sql);
  const out: ColumnDeclaration[] = [];

  const create = new RegExp(String.raw`CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED_NAME}\s*\(`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = create.exec(schema)) !== null) {
    const table = unquote(m[1] ?? '');
    if (watched && !watched.has(table)) continue;
    const body = balancedBody(schema, create.lastIndex - 1);
    if (body === null) continue;
    for (const item of topLevelItems(body)) {
      const trimmed = item.trim();
      if (trimmed.length === 0 || CONSTRAINT_OPENERS.test(trimmed)) continue;
      const nameMatch = /^("[^"]+"|[A-Za-z_][\w$]*)/.exec(trimmed);
      if (!nameMatch) continue;
      out.push({ table, column: unquote(nameMatch[1] ?? ''), rest: trimmed.slice(nameMatch[0].length).trim() });
    }
  }

  const alter = new RegExp(ALTER_TABLE, 'gi');
  while ((m = alter.exec(schema)) !== null) {
    const table = unquote(m[1] ?? '');
    if (watched && !watched.has(table)) continue;
    const addColumn = /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)([^,;]*)/gi;
    let a: RegExpExecArray | null;
    while ((a = addColumn.exec(m[2] ?? '')) !== null) {
      const column = unquote(a[1] ?? '');
      if (CONSTRAINT_OPENERS.test(column)) continue;
      out.push({ table, column, rest: (a[2] ?? '').trim() });
    }
  }

  return out;
}

/**
 * Every column type change — `ALTER TABLE t ALTER [COLUMN] c [SET DATA] TYPE x`
 * — as a declaration whose `rest` is the new type as written (with any
 * `USING`). A type change re-declares the column, so a rule on declared types
 * that did not read it could be undone one statement later (L-3).
 */
export function findColumnTypeChanges(sql: string, tables?: readonly string[]): ColumnDeclaration[] {
  const watched = tables ? new Set(tables.map((t) => t.toLowerCase())) : null;
  const out: ColumnDeclaration[] = [];
  for (const m of stripNonSchema(sql).matchAll(new RegExp(ALTER_TABLE, 'gi'))) {
    const table = unquote(m[1] ?? '');
    if (watched && !watched.has(table)) continue;
    const actions = m[2] ?? '';
    const change = /\bALTER\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+(?:SET\s+DATA\s+)?TYPE\s+/gi;
    for (const a of actions.matchAll(change)) {
      // The new type runs to the next top-level comma: `NUMERIC(18,4)` keeps its own.
      const from = (a.index ?? 0) + a[0].length;
      let depth = 0;
      let to = from;
      for (; to < actions.length; to += 1) {
        const ch = actions[to];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        else if (ch === ',' && depth === 0) break;
      }
      out.push({ table, column: unquote(a[1] ?? ''), rest: actions.slice(from, to).trim() });
    }
  }
  return out;
}

export interface ColumnRename {
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

/** Every `ALTER TABLE t RENAME [COLUMN] a TO b` — never `RENAME CONSTRAINT`, never the table's own `RENAME TO`. */
export function findColumnRenames(sql: string, tables?: readonly string[]): ColumnRename[] {
  const watched = tables ? new Set(tables.map((t) => t.toLowerCase())) : null;
  const out: ColumnRename[] = [];
  for (const m of stripNonSchema(sql).matchAll(new RegExp(ALTER_TABLE, 'gi'))) {
    const table = unquote(m[1] ?? '');
    if (watched && !watched.has(table)) continue;
    const actions = m[2] ?? '';
    if (/^\s*RENAME\s+CONSTRAINT\b/i.test(actions)) continue;
    const rename = /^\s*RENAME\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+TO\s+("[^"]+"|[A-Za-z_][\w$]*)\s*$/i.exec(actions);
    if (rename) out.push({ table, from: unquote(rename[1] ?? ''), to: unquote(rename[2] ?? '') });
  }
  return out;
}

export interface TableRename {
  readonly from: string;
  readonly to: string;
}

/** Every `ALTER TABLE t RENAME TO b`: a rename makes a table name that no `CREATE TABLE` ever wrote (L-3). */
export function findTableRenames(sql: string): TableRename[] {
  const out: TableRename[] = [];
  for (const m of stripNonSchema(sql).matchAll(new RegExp(ALTER_TABLE, 'gi'))) {
    const rename = /^\s*RENAME\s+TO\s+("[^"]+"|[A-Za-z_][\w$]*)\s*$/i.exec(m[2] ?? '');
    if (rename) out.push({ from: unquote(m[1] ?? ''), to: unquote(rename[1] ?? '') });
  }
  return out;
}

/**
 * Every relation name the SQL makes that STORES rows: `CREATE TABLE` (any
 * modifier), `CREATE MATERIALIZED VIEW`, a top-level `SELECT … INTO`, and the
 * target of `ALTER TABLE … RENAME TO` — each bare, quoted or
 * schema-qualified. Sorted, unquoted, lower-case.
 */
export function discoverStoredRelations(sql: string): string[] {
  const schema = stripNonSchema(sql);
  const found = new Set<string>();
  const creators = [
    new RegExp(String.raw`CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED_NAME}`, 'gi'),
    new RegExp(String.raw`CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED_NAME}`, 'gi'),
    new RegExp(String.raw`\bSELECT\b[^;]*?\bINTO\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE\s+)?${QUALIFIED_NAME}`, 'gi'),
  ];
  for (const re of creators) for (const m of schema.matchAll(re)) found.add(unquote(m[1] ?? ''));
  for (const r of findTableRenames(sql)) found.add(r.to);
  return [...found].sort();
}
