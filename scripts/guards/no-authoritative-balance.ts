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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE2_PREFIX, PHASE2_PREFIX_END } from '../phase2-prefix';
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
 * ── P3-S8: the Phase 3 surface, discovered by migration position (A-18(a), TL-10) ──
 *
 * Until P3-S8 the inventory half below found its tables by NAME
 * (`INVENTORY_TABLE_NAME`, `SUPPLIER_TABLE_NAME`), and five Phase 3 tables
 * carry neither prefix: `units`, `unit_names`, `branch_warehouses`,
 * `stocktakes`, `stocktake_lines`. A rule keyed on a name protects a name.
 *
 * So the Phase 3 set is now "every stored relation that the accepted Phase 2
 * prefix (`0000`–`PHASE2_PREFIX_END`) did not create" — the static form of the
 * contract's catalogue definition (§0), and equal on the real tree to "every
 * relation a migration after `PHASE2_PREFIX_END` creates" (T-14 proves the
 * two agree). The prefix is frozen and digest-pinned
 * (`scripts/phase2-prefix.ts`), so its relation set is read once, from those
 * files, and verified against their accepted digests first. A prefix file
 * that is missing or differs yields an EMPTY prefix set: every relation is
 * then treated as Phase 3, which can only make the guards stricter.
 *
 * The names still choose the column VOCABULARY: supplier, purchase and
 * payment-method tables keep the AP words; every other Phase 3 relation gets
 * the inventory words (`STOCK_CACHE_EXCEPTION` stays the one named exception).
 */
const MIGRATIONS_DIR = join(__dirname, '../../infrastructure/database/migrations');

let prefixRelations: ReadonlySet<string> | null = null;

/** Every stored relation the accepted Phase 2 prefix creates, read from its digest-verified files. */
export function phase2PrefixRelations(): ReadonlySet<string> {
  if (prefixRelations !== null) return prefixRelations;
  const found = new Set<string>();
  for (const [name, sha256] of PHASE2_PREFIX) {
    const path = join(MIGRATIONS_DIR, name);
    const bytes = existsSync(path) ? readFileSync(path) : null;
    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      prefixRelations = new Set();
      return prefixRelations;
    }
    for (const relation of discoverStoredRelations(bytes.toString('utf8'))) found.add(relation);
  }
  prefixRelations = found;
  return prefixRelations;
}

/** Whether a relation belongs to the Phase 3 surface: the accepted Phase 2 prefix did not create it. */
export function isPhase3Relation(table: string): boolean {
  return !phase2PrefixRelations().has(table.toLowerCase());
}

/** Every Phase 3 relation one SQL text makes, sorted. */
export function discoverPhase3Relations(sql: string): string[] {
  return discoverStoredRelations(sql).filter(isPhase3Relation);
}

/** The positional form, over named migrations: every relation a file after `PHASE2_PREFIX_END` makes, sorted. */
export function discoverPhase3RelationsByPosition(migrations: Readonly<Record<string, string>>): string[] {
  const found = new Set<string>();
  for (const [path, sql] of Object.entries(migrations)) {
    if ((path.split('/').pop() ?? path) <= PHASE2_PREFIX_END) continue;
    for (const relation of discoverStoredRelations(sql)) found.add(relation);
  }
  return [...found].sort();
}

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
 *
 * P3-S8 (A-18(a)): and every other Phase 3 relation that is not a supplier,
 * purchase or payment-method table — `units`, `unit_names`,
 * `branch_warehouses`, `stocktakes`, `stocktake_lines` and whatever a later
 * slice adds under a name without the prefix.
 */
export function discoverInventoryTables(sql: string): string[] {
  return discoverStoredRelations(sql).filter((table) => INVENTORY_TABLE_NAME.test(table) || (isPhase3Relation(table) && !SUPPLIER_TABLE_NAME.test(table)));
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

/**
 * ── P3-S4: supplier and purchase storage (P3-AL-26 L:843-854, P3-AL-44 L:1261; S4 contract §7.2) ──
 *
 * "`suppliers.balance` does not exist and may never be added" (L:847).
 * Supplier AP and supplier credit are DERIVED live from their source
 * documents — received purchases, returns, credit notes, allocations — and
 * Phase 3 ships no cache, projection or summary table for them (L:851-852,
 * L:1261). A stored payable, outstanding, paid or due amount on a supplier or
 * purchase table is a second truth beside the journal, and this half of G-3
 * is how L:852 is "enforced in CI rather than remembered".
 *
 * The watched set is DISCOVERED, like the inventory half: every stored
 * relation the migrations make whose name is a supplier or purchase table —
 * `supplier_returns`, `supplier_credit_notes` and `purchase_reversals` are
 * covered because of their names, not because anybody listed them.
 *
 * The column rule is the accounting one plus the AP vocabulary. Its only
 * exemption is the accounting one: a column that names an identity, an actor
 * or an instant (`NOT_A_QUANTITY`) is not a stored number. The inventory
 * `_seq` exemption does NOT apply here.
 *
 * What is deliberately NOT forbidden, and why:
 * - `remaining_*` (`supplier_credit_notes.remaining_amount_minor`,
 *   `remaining_carrying_base_amount_minor`). A credit note is a SOURCE
 *   DOCUMENT whose remaining value is part of the document itself, moved
 *   only under the row lock of P3-AL-31 (L:938-947) and insert-only in S5
 *   (S5 contract A-11(e), TL-13). DM §7ج names it; the S5 contract (§2.2
 *   Naming) records that it is not forbidden. It needs no exemption: no
 *   pattern below matches it.
 * - `ap_*` (`supplier_returns.ap_txn_minor`, `ap_base_minor`,
 *   `ap_released_before_txn_minor`). These are the AP EFFECT of one return,
 *   frozen on an append-only row (`supplier_returns_immutable`, no UPDATE
 *   grant) and posted to the journal by that return — a fact of the
 *   document, not a running total of the supplier. `ap_released_before_*`
 *   is the X = T − O snapshot that lets the COMMIT-time value guard verify
 *   the base release (0065 R-43); nothing ever rewrites it.
 *
 * P3-S6 (S6 contract §7.2): the discovery also covers `payment_methods` and
 * `payment_method_*`, and `settled` joins the AP words. A payment method or a
 * settlement row never stores how much has been settled: the allocations are
 * the source documents, and the settled amount is their live sum.
 * `purchase_amount_applied_minor` (one allocation's own amount) and the
 * credit note's `remaining_*` pair (moved only under the P3-AL-31 row lock)
 * match no pattern.
 */
export const SUPPLIER_TABLE_NAME = /^(suppliers|supplier_[a-z0-9_]+|purchases|purchase_[a-z0-9_]+|payment_methods|payment_method_[a-z0-9_]+)$/;

/** The AP words: a column carrying one claims to be what the supplier is owed or has been paid (L:847-850). */
const AP_BALANCE_COLUMN = /(^|_)(outstanding|paid|unpaid|due|owed|payable|settled)($|_)/;

const SUPPLIER_FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [...FORBIDDEN_COLUMN_PATTERNS, AP_BALANCE_COLUMN];

/** The two tables every other supplier or purchase table hangs from: if either is missing, this half is watching nothing. */
export const SUPPLIER_AUTHORITY_TABLES = ['suppliers', 'purchases'] as const;

/**
 * A supplier or purchase table whose NAME is a stored AP or supplier
 * balance, or a cache, projection, summary, snapshot or rollup of one
 * (L:851, L:1261). `supplier_balances` with an innocent `amount_minor` column
 * is the same second truth as `suppliers.balance`.
 */
const SUPPLIER_FORBIDDEN_TABLE = /(^|_)(balances?|outstanding|payables?|caches?|projections?|summar(y|ies)|snapshots?|rollups?)($|_)/;

/**
 * Every supplier- or purchase-owned relation the migrations make, sorted: by
 * any `CREATE TABLE` (bare, quoted or schema-qualified), a materialized
 * view, a `SELECT … INTO`, or as the new name of `ALTER TABLE … RENAME TO`.
 */
export function discoverSupplierTables(sql: string): string[] {
  return discoverStoredRelations(sql).filter((table) => SUPPLIER_TABLE_NAME.test(table));
}

/** A supplier or purchase table whose name is a stored balance or a cache of one — or a stored accounting balance. */
export function isForbiddenSupplierTable(table: string): boolean {
  const name = table.toLowerCase();
  return SUPPLIER_FORBIDDEN_TABLE.test(name) || isForbiddenBalanceTable(name);
}

/** Whether `column` on a supplier or purchase table claims storage authority over a derived AP or supplier quantity. */
export function isAuthoritativeSupplierColumn(column: string): boolean {
  const name = column.toLowerCase();
  if (NOT_A_QUANTITY.test(name)) return false;
  return SUPPLIER_FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(name));
}

/**
 * Authoritative AP or supplier-balance columns declared on any of `tables` in
 * one SQL text — CREATE TABLE bodies, ALTER TABLE … ADD COLUMN, and a column
 * RENAMEd to such a name. An empty array is a pass.
 */
export function findAuthoritativeSupplierColumns(sql: string, tables: readonly string[]): BalanceColumnFinding[] {
  const watched = new Set(tables.map((t) => t.toLowerCase()));
  const declared = [...findColumnDeclarations(sql), ...findColumnRenames(sql).map((r) => ({ table: r.table, column: r.to }))];
  return declared.filter((d) => watched.has(d.table) && isAuthoritativeSupplierColumn(d.column)).map((d) => ({ table: d.table, column: d.column }));
}
