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
import { PHASE4_INHERITED_PREFIX } from '../phase4-prefix';
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

type AcceptedPrefix = readonly (readonly [name: string, sha256: string])[];

const prefixRelationCache = new Map<AcceptedPrefix, ReadonlySet<string>>();

/**
 * Every stored relation an ACCEPTED prefix creates, read from its
 * digest-verified files. One reader, so the Phase 3 anchor and the Phase 4
 * anchor below cannot drift apart: a file that is missing or differs from its
 * accepted digest yields an EMPTY set, which can only make the arms stricter.
 */
function acceptedPrefixRelations(prefix: AcceptedPrefix): ReadonlySet<string> {
  const cached = prefixRelationCache.get(prefix);
  if (cached !== undefined) return cached;
  const found = new Set<string>();
  for (const [name, sha256] of prefix) {
    const path = join(MIGRATIONS_DIR, name);
    const bytes = existsSync(path) ? readFileSync(path) : null;
    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      const empty: ReadonlySet<string> = new Set();
      prefixRelationCache.set(prefix, empty);
      return empty;
    }
    for (const relation of discoverStoredRelations(bytes.toString('utf8'))) found.add(relation);
  }
  prefixRelationCache.set(prefix, found);
  return found;
}

/** Every stored relation the accepted Phase 2 prefix creates, read from its digest-verified files. */
export function phase2PrefixRelations(): ReadonlySet<string> {
  return acceptedPrefixRelations(PHASE2_PREFIX);
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
export const SOURCE_DOCUMENT_TABLES: readonly string[] = ['accounting_opening_balances', 'accounting_opening_balance_lines'];

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
const NOT_A_QUANTITY = /_(id|ids|at|date|by|status|kind|type|code|name|currency)$/;

/**
 * …and an INSTANT is an instant whether it is spelled `_at` or `_date`. The
 * suffix list carried `_at` and not `_date`, which made `invoices.due_date`
 * — the payment term a merchant AGREES, an input to the aging computation
 * and not a derivation of anything — read as a claim of storage authority
 * over an amount due, under a rule whose own header says "only a stored
 * NUMBER can drift from the journal, so only a stored number is what this
 * rule is about" (`:211-212`). `_date` is therefore an instant here too, and
 * `due_date` is now exempt for exactly the reason the accepted `due_status`
 * already is: the word `due` is in the AP vocabulary, and a due DATE and a
 * due STATUS are both terms while a due AMOUNT is a balance. A date column
 * cannot hold money or a quantity, so it cannot drift from a sum, which is
 * the whole subject of this rule. `(^|_)due($|_)` on any numeric column is
 * untouched.
 *
 * ── AND WHAT THIS DELIBERATELY DOES NOT DO (P4-S1, TL-P4-S1-C11) ───────
 *
 * A first attempt consulted `DERIVED_SETTLEMENT_INSTANT` below BEFORE the
 * exemption, on the reasoning that "when this was settled" is read off the
 * allocations exactly as "how much is settled" is, and that `_at` being
 * blanket-exempt was therefore a hole. That reasoning is wrong here, and the
 * accepted tree says so: `tests/integration/accounting-guards.test.ts:272`
 * names `paid_at` in the list of columns this rule must ALLOW, beside
 * `paid_by`, under the heading "identities, actors, instants". It is a
 * deliberate decision, not an oversight, and it is right — on a payment
 * document, `paid_at` is a FACT OF THAT DOCUMENT, not a derivation of
 * anything.
 *
 * Which exposes what a column-name rule cannot express: whether a settlement
 * instant is derived depends on WHICH RELATION carries it. `paid_at` on a
 * payment is a fact; `settled_at` on an invoice is a second truth. The
 * vocabulary is tree-wide and relation-blind, so consulting the pattern here
 * would refuse the fact in order to refuse the derivation, and would reverse
 * an accepted decision to do it.
 *
 * So the pattern below is NOT consulted by the four predicates in this file.
 * It is exported for the RELATION-SCOPED surface that can express the
 * distinction: `0075-E`'s end-state block over the five Phase 4 relations,
 * and `tests/golden-regression/phase4/04-schema-lint.golden.test.ts`, which
 * apply it only where a settlement instant would in fact be derived. `due`
 * is absent from it for the same reason as above.
 */
export const DERIVED_SETTLEMENT_INSTANT = /(^|_)(settled|paid|collected|allocated|refunded)_(at|date)($|_)/;

/**
 * ── P4-S1: the derived-total vocabulary, on every relation the accepted
 * prefixes did not create (P4-AL-06; P4-AL-05 §4) ─────────────────────────
 *
 * `AP_BALANCE_COLUMN` was written in P3-S4 for supplier AP and wired to
 * `SUPPLIER_TABLE_NAME` alone. That wiring was a table-NAME rule wearing a
 * column rule's clothes, and it failed the moment a phase brought relations
 * under other names. Running this file's own discovery functions over scratch
 * Phase 4 DDL showed exactly that: the supplier arm saw only `purchases`, the
 * complement arm saw `customers`, `installments`, `invoices`, `sales` — and of
 * their columns only `customers.balance_minor` was caught, while
 * `invoices.paid_minor`, `invoices.outstanding_minor`,
 * `customers.amount_due_minor`, `installments.outstanding_minor`,
 * `installments.settled_minor` and `credit_notes.refunded_amount_minor` all
 * passed CI.
 *
 * The rewiring is neither a sales arm nor a Phase 4 table list: a list of
 * Phase 4 names would rebuild the very hole this file's header (`:33-38`)
 * exists to explain. The vocabulary below is carried by BOTH discovery arms,
 * and between them the two arms cover every relation the accepted Phase 2
 * prefix did not create (`isPhase3Relation`) — the complement arm takes every
 * such relation that is not a supplier / purchase / payment-method name, the
 * supplier arm takes the rest, and `tests/integration/phase3-s8-guards.test.ts`
 * pins that partition. So the rule follows the CATALOGUE, and a Phase 5
 * relation is covered the day it is written, not the day somebody remembers
 * this file.
 *
 * `receivable` joins the AP words for the AR direction. `refunded`,
 * `collected` and `allocated` join them because §4's matrix and P4-AL-14
 * forbid exactly those stored totals: a credit note's
 * `refunded_amount_minor`, an instalment plan's collected sum, an allocated
 * sum. `cogs` joins for P4-AL-05's reason — COGS is `journal_lines` on `5000`
 * and its input is `stock_movements.value_delta_base_minor`, so
 * `sale_items.cogs_minor` would be a second stored integer for the same money
 * with a second writer and nothing tying them.
 *
 * What deliberately does NOT join is a bare `cost`. P4-AL-06's prose asks for
 * it, and a bare `(^|_)costs?($|_)` flags eight ACCEPTED Phase 3 columns:
 * `stock_movements.unit_cost_base_minor`,
 * `purchase_lines.unit_cost_base_minor`, `stocktake_lines.unit_cost_base_minor`,
 * `inventory_adjustment_lines.unit_cost_base_minor`,
 * `inventory_opening_lines.unit_cost_base_minor`,
 * `negative_inventory_deficits.provisional_unit_cost_base_minor`,
 * `negative_deficit_coverages.provisional_unit_cost_base_minor` and
 * `negative_deficit_coverages.actual_unit_cost_base_minor` — every one a
 * per-unit INPUT frozen on its own source document, none of them a derived
 * total. Turning eight accepted rows red is how a guard gets relaxed instead of
 * obeyed. What P4-AL-05 actually forbids is a stored COGS or a stored cost
 * TOTAL, so that, and only that, is what `DERIVED_COST_COLUMN` matches.
 *
 * `remaining_*` stays permitted, for the reason the supplier arm documents
 * below: a credit note's remaining pair is part of the source document, and it
 * is what P4-AL-14 is built on.
 */
export const AP_BALANCE_COLUMN = /(^|_)(outstanding|paid|unpaid|due|owed|payable|receivable|settled|refunded|collected|allocated)($|_)/;

/** A stored COGS or a stored cost TOTAL — never a per-unit cost input on a source document. */
export const DERIVED_COST_COLUMN = /(^|_)(cogs|cost_of_goods|costs?_(total|totals|sum|sums)|(total|sum)_costs?)($|_)/;

/**
 * A stored DEBT truth: what a customer still owes, how much of it is late, or
 * an aging bucket of it.
 *
 * `AP_BALANCE_COLUMN` carries `outstanding`, `due` and `receivable`, and those
 * three words are not the whole of the law. `debt_minor` names the same
 * derived quantity in the merchant's own word and matches none of them, and
 * `overdue_amount_minor` matches none of them either — `(^|_)due($|_)` needs a
 * boundary before `due`, and `overdue` does not give it one. An aging bucket is
 * the §4 "materialised aging table" written as a column instead of a relation.
 * Each of those is a debt total that competes with the invoices and the
 * payments for being the truth, so each is refused by name.
 *
 * Token-bounded, like every pattern here: `overdueish`, `subpayables` and a
 * `managed`/`packaged` word are not debt columns and stay untouched.
 */
export const DERIVED_DEBT_COLUMN = /(^|_)(debts?|overdue|arrears|aging|ageing)($|_)/;

/** The derived-total column vocabulary that EVERY arm carries (P4-AL-06). */
const DERIVED_TOTAL_COLUMN_PATTERNS: readonly RegExp[] = [AP_BALANCE_COLUMN, DERIVED_COST_COLUMN, DERIVED_DEBT_COLUMN];

/**
 * A relation whose NAME is a stored balance, outstanding, payable,
 * receivable, cache, projection, summary, snapshot or rollup. P3-S4 wrote it
 * for supplier tables only; P4-S1 gives it to the complement arm too, so §4's
 * forbidden "materialised aging table", a `customer_balances` and an
 * `invoice_outstanding_cache` are refused by the same rule that already
 * refuses `supplier_balances`. No Phase 2/3 relation in either arm matches it.
 */
const DERIVED_TOTAL_TABLE =
  /(^|_)(balances?|outstanding|overdue|arrears|aging|ageing|payables?|receivables?|caches?|projections?|summar(y|ies)|snapshots?|rollups?)($|_)/;

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

const INVENTORY_FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [
  ...FORBIDDEN_COLUMN_PATTERNS,
  /(^|_)(on_hand|valuation|reserved|available)($|_)/,
  // P4-S1 (P4-AL-06): the derived-total words, on every relation the prefix did not create.
  ...DERIVED_TOTAL_COLUMN_PATTERNS,
];

/** Inventory tables only: an identity, actor, instant (`_at` or `_date`), classifier or ORDERING is not a stored quantity. */
export const INVENTORY_NOT_A_QUANTITY = /_(id|ids|at|date|by|status|kind|type|code|name|currency|seq)$/;

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

/**
 * A relation that IS derived truth, under ANY name: a stored stock or
 * accounting balance, an outstanding, an overdue or aging bucket, a cache, a
 * projection, a summary, a snapshot or a rollup.
 *
 * P4-S1: this is the ONE relation-name predicate, shared by every arm. It was
 * the body of `isForbiddenInventoryTable`, and a Phase 4 arm that copied it
 * would be a second copy free to drift from this one. A declared source
 * document keeps its AL-13 exemption (`SOURCE_DOCUMENT_TABLES`).
 */
export function isDerivedTruthRelation(table: string): boolean {
  const name = table.toLowerCase();
  if (SOURCE_DOCUMENT_TABLES.includes(name)) return false;
  return INVENTORY_FORBIDDEN_TABLE.test(name) || DERIVED_TOTAL_TABLE.test(name) || isForbiddenBalanceTable(name);
}

/** A table whose NAME is a stored inventory balance, summary, snapshot, rollup or cache — or a stored accounting balance. */
export function isForbiddenInventoryTable(table: string): boolean {
  return isDerivedTruthRelation(table);
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
const SUPPLIER_FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [...FORBIDDEN_COLUMN_PATTERNS, ...DERIVED_TOTAL_COLUMN_PATTERNS];

/** The two tables every other supplier or purchase table hangs from: if either is missing, this half is watching nothing. */
export const SUPPLIER_AUTHORITY_TABLES = ['suppliers', 'purchases'] as const;

/**
 * A supplier or purchase table whose NAME is a stored AP or supplier
 * balance, or a cache, projection, summary, snapshot or rollup of one
 * (L:851, L:1261). `supplier_balances` with an innocent `amount_minor` column
 * is the same second truth as `suppliers.balance`.
 */
const SUPPLIER_FORBIDDEN_TABLE = DERIVED_TOTAL_TABLE;

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

/**
 * ── P4-S1: the third arm, anchored on the INHERITED prefix (P4-AL-06, plan
 * action 2; P4-AL-05 §4, P4-AL-14) ───────────────────────────────────────
 *
 * The two arms above partition the Phase 3 surface — every relation the
 * accepted Phase 2 prefix (`0000`–`PHASE2_PREFIX_END`) did not create — and
 * `tests/integration/phase3-s8-guards.test.ts:108-111` pins that partition.
 * This arm adds nothing to it and takes nothing from it: its anchor is a
 * DIFFERENT, later prefix, so it is a third set beside the partition, not a
 * third piece of it.
 *
 * Its surface is every stored relation the accepted INHERITED prefix
 * (`0000`–`0073`, `PHASE4_INHERITED_PREFIX`, digest-verified by the same
 * reader) did not create. That is the catalogue definition of "Phase 4 and
 * later", the way `isPhase3Relation` is the catalogue definition of "Phase 3
 * and later", and it is why no Phase 4 name appears anywhere below. A list of
 * Phase 4 names — `customers`, `invoices`, `installments` — would rebuild
 * exactly the hole this file's header (`:33-38`) and P3-S8 exist to remove:
 * the relation that breaks the law is by definition the one nobody thought to
 * list. The one thing this arm keys on is SQL RELATION POSITION: which
 * accepted prefix created the relation, or none.
 *
 * Why a third arm rather than leaving the Phase 4 surface to the complement
 * arm. `discoverInventoryTables` reaches a Phase 4 relation today only as a
 * side effect of being anchored on the Phase 2 prefix while being named,
 * documented and tested as the INVENTORY vocabulary. That is an accident, and
 * the day a slice narrows the complement arm to the Phase 3 surface it was
 * written for, the Phase 4 surface would silently lose its cover. This arm
 * states the cover instead of inheriting it, and CI runs both
 * (`scripts/static-guards.ts` rule 15).
 *
 * The vocabulary is the SHARED one, not a fourth copy: the accounting
 * patterns (`FORBIDDEN_COLUMN_PATTERNS` — any balance, a running debit/credit
 * total, a stock level), the derived-total words every arm carries
 * (`DERIVED_TOTAL_COLUMN_PATTERNS` — the AP/AR words, a stored COGS or cost
 * total, and the debt/overdue/aging words `DERIVED_DEBT_COLUMN` adds), and
 * `NEVER_STORED` (`reserved`, `available`), because the law names available
 * and reserved stock and Phase 4 reserves nothing either.
 *
 * The exemptions are the shared ones too, `INVENTORY_NOT_A_QUANTITY`: an
 * identity, an actor, an instant, a classifier or an ORDERING (`*_seq`) is not
 * a stored quantity, whatever noun it is built from. There is no allowlist and
 * no name exemption — `remaining_*` needs none, because the remaining pair of
 * a credit note or a customer credit is a fact of the source document
 * (P4-AL-14) and matches no pattern above.
 */

/** Whether a relation belongs to the Phase 4 surface: the accepted inherited prefix (`0000`–`0073`) did not create it. */
export function isPhase4Relation(table: string): boolean {
  return !acceptedPrefixRelations(PHASE4_INHERITED_PREFIX).has(table.toLowerCase());
}

/** Every stored relation the accepted inherited prefix creates, read from its digest-verified files. */
export function phase4InheritedPrefixRelations(): ReadonlySet<string> {
  return acceptedPrefixRelations(PHASE4_INHERITED_PREFIX);
}

/**
 * The third arm's watched set: every stored relation one SQL text makes that
 * the accepted inherited prefix did not create — by any `CREATE TABLE` (bare,
 * quoted or schema-qualified), a materialized view, a `SELECT … INTO`, or as
 * the new name of `ALTER TABLE … RENAME TO`. Sorted.
 */
export function discoverSalesTables(sql: string): string[] {
  return discoverStoredRelations(sql).filter(isPhase4Relation);
}

/** A Phase 4 relation that IS derived truth — the same one predicate every arm uses. */
export function isForbiddenSalesTable(table: string): boolean {
  return isDerivedTruthRelation(table);
}

/** The shared vocabulary, carried by this arm: the accounting patterns, the derived-total words, and never a reservation. */
const SALES_FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [...FORBIDDEN_COLUMN_PATTERNS, ...DERIVED_TOTAL_COLUMN_PATTERNS, NEVER_STORED];

/** Whether `column` on a Phase 4 relation claims storage authority over a derived receivable, debt or stock quantity. */
export function isAuthoritativeSalesColumn(column: string): boolean {
  const name = column.toLowerCase();
  if (INVENTORY_NOT_A_QUANTITY.test(name)) return false;
  return SALES_FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(name));
}

/**
 * Authoritative derived-truth columns declared on any of `tables` in one SQL
 * text — CREATE TABLE bodies, ALTER TABLE … ADD COLUMN, and a column RENAMEd
 * to such a name. An empty array is a pass.
 */
export function findAuthoritativeSalesColumns(sql: string, tables: readonly string[]): BalanceColumnFinding[] {
  const watched = new Set(tables.map((t) => t.toLowerCase()));
  const declared = [...findColumnDeclarations(sql), ...findColumnRenames(sql).map((r) => ({ table: r.table, column: r.to }))];
  return declared.filter((d) => watched.has(d.table) && isAuthoritativeSalesColumn(d.column)).map((d) => ({ table: d.table, column: d.column }));
}
