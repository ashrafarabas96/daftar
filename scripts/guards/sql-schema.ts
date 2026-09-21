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

  const create = /CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s*\(/gi;
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

  const alter = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)([\s\S]*?);/gi;
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
