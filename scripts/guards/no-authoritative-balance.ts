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
import {
  CONSTRAINT_OPENERS,
  balancedBody,
  discoverStoredRelations,
  findColumnDeclarations,
  findColumnRenames,
  stripNonSchema,
  topLevelItems,
  unquote,
} from './sql-schema';

/**
 * Accounting source-of-truth tables. The journal joined the list in P2-S2:
 * a stored balance on an entry or a line would be exactly the second truth
 * this rule exists to refuse.
 *
 * This is now the FLOOR, not the whole list. See `discoverAccountingTables`.
 */
export const ACCOUNTING_AUTHORITY_TABLES = ['accounts', 'journal_entries', 'journal_lines', 'accounting_source_bindings'] as const;

/**
 * ── Why this guard had to grow (P2-S7 §60) ───────────────────────────────
 *
 * Four names were honest while four tables held accounting state. They stop
 * being honest the moment a fifth exists: a rule keyed on a LIST protects a
 * list, and the table that breaks AL-15 is by definition the one nobody
 * thought to add to it. `accounting_balances`, `trial_balance_cache`,
 * `running_balances` — each of those would have sailed past the list version
 * of this rule while being exactly the thing the rule exists to refuse.
 *
 * So the watched set is DISCOVERED from the migrations: every table the
 * accounting domain owns, by the naming the domain actually uses. A new
 * accounting table is covered the day it is written, not the day somebody
 * remembers this file.
 *
 * What is still deliberately out of scope is vocabulary. This guard reads
 * SCHEMA — CREATE TABLE column lists and ALTER TABLE ... ADD COLUMN. A
 * response field named `balanceMinor`, a TypeScript interface, a SELECT alias
 * or a DTO is a DERIVED read model: it is computed from the journal at the
 * moment it is asked for, nothing keeps it, and nothing can drift from it.
 * Storage authority is the thing being refused, and only storage can have it.
 */
const ACCOUNTING_TABLE_NAME = /^(accounts|journal_[a-z0-9_]+|accounting_[a-z0-9_]+)$/;

/**
 * Every accounting-owned table the migrations create.
 *
 * Returned sorted, so a caller reporting on it is deterministic.
 */
export function discoverAccountingTables(sql: string): string[] {
  const found = new Set<string>();
  const create = /CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/gi;
  let m: RegExpExecArray | null;
  const schema = stripNonSchema(sql);
  while ((m = create.exec(schema)) !== null) {
    const table = unquote(m[1] ?? '');
    if (ACCOUNTING_TABLE_NAME.test(table)) found.add(table);
  }
  return [...found].sort();
}

/**
 * A table whose NAME alone announces a stored accounting balance.
 *
 * The column rule below catches `accounts.balance`. This catches the other
 * shape, where the balance is the whole table and its columns are innocently
 * named `amount` or `value` — `accounting_balances`, `trial_balance_cache`,
 * `ledger_cache`, `balance_snapshots`. AL-15 forbids both, so both are
 * checked (§11).
 */
const FORBIDDEN_TABLE_NAMES: readonly string[] = [
  'accounting_balances',
  'account_balances',
  'account_balance',
  'running_balances',
  'trial_balance_cache',
  'ledger_cache',
  'balance_snapshots',
];

/** …and the shapes those names are drawn from, for the ones not yet imagined. */
const FORBIDDEN_TABLE_PATTERNS: readonly RegExp[] = [
  /(^|_)(balance|balances|ledger|trial_balance)_(cache|caches|snapshot|snapshots|summary|summaries|rollup|rollups)($|_)/,
  /(^|_)running_balances?($|_)/,
];

/**
 * An opening balance is a SOURCE DOCUMENT, not a computed total.
 *
 * `accounting_opening_balances` and its lines record what the merchant
 * declared their position to be on a date, which is an input to the journal
 * and is posted through it like any other fact. Nothing recomputes it and
 * nothing can drift from it. It carries the word `balances` because that is
 * what the merchant calls it, and a guard that refused the word rather than
 * the property would be refusing AL-13.
 */
const SOURCE_DOCUMENT_TABLES: readonly string[] = ['accounting_opening_balances', 'accounting_opening_balance_lines'];

export function isForbiddenBalanceTable(table: string): boolean {
  const name = table.toLowerCase();
  if (SOURCE_DOCUMENT_TABLES.includes(name)) return false;
  return FORBIDDEN_TABLE_NAMES.includes(name) || FORBIDDEN_TABLE_PATTERNS.some((re) => re.test(name));
}

/**
 * Column names that would claim storage authority over a derived financial
 * quantity: any balance, a running debit/credit total, a stock level.
 */
const FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [/(^|_)balances?($|_)/, /(^|_)(debit|credit)_(total|totals|sum|sums)($|_)/, /(^|_)stock($|_)/];

/**
 * …but a column that names an IDENTITY, an ACTOR or an INSTANT is not a
 * quantity, whatever noun it is built from. `opening_balance_id` is the
 * foreign key of a source document; refusing it would be refusing AL-13's
 * own schema. Only a stored NUMBER can drift from the journal, so only a
 * stored number is what this rule is about.
 */
const NOT_A_QUANTITY = /_(id|ids|at|by|status|kind|type|code|name|currency)$/;

export interface BalanceColumnFinding {
  readonly table: string;
  readonly column: string;
}

export function isAuthoritativeBalanceColumn(column: string): boolean {
  const name = column.toLowerCase();
  if (NOT_A_QUANTITY.test(name)) return false;
  return FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(name));
}

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

/**
 * ── P3-S2: inventory storage (P3-AL-01, P3-AL-49 §A; contract §7.2) ───────
 *
 * The stock ledger is the inventory truth: `on_hand = Σ qty_delta` and
 * `valuation = Σ value_delta_base_minor`. Exactly ONE table may store those
 * sums, `stock_levels`, and only as a cache the exact rebuild proves
 * (P3-AL-42). Any other stored quantity, valuation, reservation or
 * availability on an inventory table is a second truth that can drift.
 *
 * The accounting half above is unchanged: its tables, patterns and
 * exemptions are exactly what they were. The inventory rules are separate
 * functions over separately discovered tables, and the one exemption that
 * differs — a `*_seq` column (`stock_seq`, `deficit_seq`) is an ordering, not
 * a quantity — applies to inventory tables only.
 */
export const INVENTORY_TABLE_NAME = /^(stock_[a-z0-9_]+|negative_[a-z0-9_]+|inventory_[a-z0-9_]+)$/;

/** The one cache the lock allows, and exactly the stock columns it may hold. */
export const STOCK_CACHE_EXCEPTION = 'stock_levels';
export const STOCK_CACHE_COLUMNS: readonly string[] = ['on_hand', 'valuation_base_minor', 'avg_unit_cost_base_minor', 'last_stock_seq'];

/** Never stored anywhere in inventory, the cache included: Phase 3 has no reservation (L:1274). */
const NEVER_STORED = /(^|_)(reserved|available)($|_)/;

const INVENTORY_FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [...FORBIDDEN_COLUMN_PATTERNS, /(^|_)(on_hand|valuation|reserved|available)($|_)/];

/** Inventory tables only: an identity, actor, instant, classifier or ORDERING is not a stored quantity. */
export const INVENTORY_NOT_A_QUANTITY = /_(id|ids|at|by|status|kind|type|code|name|currency|seq)$/;

const INVENTORY_FORBIDDEN_TABLE = /(^|_)(stock|inventory)_(balances?|summar(y|ies)|snapshots?|rollups?|caches?)($|_)/;

/**
 * Every inventory-owned table the migrations make, sorted: by any
 * `CREATE TABLE` — bare, quoted or schema-qualified, so
 * `public.stock_movements` is `stock_movements` — a materialized view, a
 * `SELECT … INTO`, or as the new name of `ALTER TABLE … RENAME TO`
 * (security review L-3).
 */
export function discoverInventoryTables(sql: string): string[] {
  return discoverStoredRelations(sql).filter((table) => INVENTORY_TABLE_NAME.test(table));
}

/**
 * Every stored relation, under ANY name, whose name is a stock or inventory
 * balance, summary, snapshot, rollup or cache. `warehouse_stock_balances`
 * carries no inventory prefix, so discovery by prefix alone never asked
 * (L-3). Sorted.
 */
export function findForbiddenInventoryRelations(sql: string): string[] {
  return discoverStoredRelations(sql).filter((table) => INVENTORY_FORBIDDEN_TABLE.test(table));
}

/** A table whose NAME is a stored inventory balance, summary, snapshot, rollup or cache — or a stored accounting balance. */
export function isForbiddenInventoryTable(table: string): boolean {
  const name = table.toLowerCase();
  return INVENTORY_FORBIDDEN_TABLE.test(name) || isForbiddenBalanceTable(name);
}

/** Whether `column` on inventory table `table` claims storage authority over a derived stock quantity. */
export function isAuthoritativeInventoryColumn(table: string, column: string): boolean {
  const name = column.toLowerCase();
  if (NEVER_STORED.test(name) && !INVENTORY_NOT_A_QUANTITY.test(name)) return true;
  if (table.toLowerCase() === STOCK_CACHE_EXCEPTION && STOCK_CACHE_COLUMNS.includes(name)) return false;
  if (INVENTORY_NOT_A_QUANTITY.test(name)) return false;
  return INVENTORY_FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(name));
}

/**
 * Authoritative stock columns declared on any of `tables` in one SQL text,
 * from CREATE TABLE bodies and ALTER TABLE … ADD COLUMN. An empty array is a
 * pass.
 */
export function findAuthoritativeInventoryColumns(sql: string, tables: readonly string[]): BalanceColumnFinding[] {
  const watched = new Set(tables.map((t) => t.toLowerCase()));
  // A column RENAMEd to a stock quantity is declared by the rename (L-3).
  const declared = [...findColumnDeclarations(sql), ...findColumnRenames(sql).map((r) => ({ table: r.table, column: r.to }))];
  return declared.filter((d) => watched.has(d.table) && isAuthoritativeInventoryColumn(d.table, d.column)).map((d) => ({ table: d.table, column: d.column }));
}

/**
 * The cache's own shape: `stock_levels` must declare all four cache columns
 * (a cache missing one is not the cache the rebuild verifies) and nothing
 * named `reserved` / `available`. Returns problems as text; empty is a pass.
 */
export function checkStockCacheShape(sql: string): string[] {
  const declared = findColumnDeclarations(sql, [STOCK_CACHE_EXCEPTION]).map((d) => d.column);
  if (declared.length === 0) return [`${STOCK_CACHE_EXCEPTION} does not exist — the inventory half of G-3 is watching nothing`];
  // Renames apply in order: a cache column renamed away is missing, and its new name is a column (L-3).
  const renamed = new Set(declared);
  for (const r of findColumnRenames(sql, [STOCK_CACHE_EXCEPTION])) {
    renamed.delete(r.from);
    renamed.add(r.to);
  }
  const columns = [...renamed];
  const problems: string[] = [];
  for (const c of STOCK_CACHE_COLUMNS) {
    if (!columns.includes(c)) problems.push(`${STOCK_CACHE_EXCEPTION}.${c} is missing — the cache must hold exactly ${STOCK_CACHE_COLUMNS.join(', ')}`);
  }
  for (const c of columns) {
    if (/(^|_)(reserved|available)($|_)/.test(c)) problems.push(`${STOCK_CACHE_EXCEPTION}.${c} — Phase 3 stores no reservation or availability (P3-AL-01)`);
  }
  return problems;
}
