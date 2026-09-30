/**
 * P4-S1 red proofs — Class II, the derived-truth guard (lock P4-AL-06,
 * P4-AL-05 §4, P4-AL-15b; plan P4-S1 actions 2).
 *
 * Every rule this slice adds or widens is planted here as the defect it exists
 * to refuse, and asserted to fail FOR THAT REASON — the named relation, the
 * named column, the named rule. A guard with no red proof is not a guard, and
 * DAFTAR has been burned by a runner that exited 0 over failing tests
 * (`tests/helpers/exit-code.ts`).
 *
 * The other half of each proof is the GREEN one, which is the harder claim: the
 * accepted Phase 2/3 tree, all 74 migrations of it, must give byte-identical
 * verdicts. Both halves are asserted below over the real migration directory.
 *
 * No migration is created or edited here. The Phase 4 DDL these tests plant is
 * a string in this file: it is never written to
 * `infrastructure/database/migrations` and never enters
 * `MIGRATION_MANIFEST.json`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AP_BALANCE_COLUMN,
  DERIVED_COST_COLUMN,
  STOCK_CACHE_COLUMNS,
  discoverInventoryTables,
  discoverSupplierTables,
  findAuthoritativeInventoryColumns,
  findAuthoritativeSupplierColumns,
  isAuthoritativeInventoryColumn,
  isAuthoritativeSupplierColumn,
  isForbiddenInventoryTable,
  isForbiddenSupplierTable,
  isPhase3Relation,
} from '../../scripts/guards/no-authoritative-balance';
import { INVENTORY_TYPE_PINS, findInventoryNumericViolations } from '../../scripts/guards/no-float-rate';
import { stripComments } from '../../scripts/guards/sql-schema';

const MIGRATIONS = join(__dirname, '../../infrastructure/database/migrations');
const files = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const schema = (): string =>
  files()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');

/** Rule 15 of `scripts/static-guards.ts`, as one function, so a proof reports what CI would report. */
function g3Failures(sql: string): string[] {
  const out: string[] = [];
  const inventory = discoverInventoryTables(sql);
  for (const h of findAuthoritativeInventoryColumns(sql, inventory)) out.push(`${h.table}.${h.column}`);
  for (const t of inventory) if (isForbiddenInventoryTable(t)) out.push(`table ${t}`);
  const supplier = discoverSupplierTables(sql);
  for (const h of findAuthoritativeSupplierColumns(sql, supplier)) out.push(`${h.table}.${h.column}`);
  for (const t of supplier) if (isForbiddenSupplierTable(t)) out.push(`table ${t}`);
  return [...new Set(out)].sort();
}

/**
 * Scratch Phase 4 DDL: the shape P4-AL-06 forbids, written the way a slice
 * would write it if nobody had extended the guard.
 */
const PHASE4_PLANTED_COLUMNS = `
CREATE TABLE customers (id UUID PRIMARY KEY, display_name TEXT NOT NULL, balance_minor BIGINT NOT NULL DEFAULT 0, amount_due_minor BIGINT NOT NULL DEFAULT 0);
CREATE TABLE invoices (id UUID PRIMARY KEY, total_txn_minor BIGINT NOT NULL, paid_minor BIGINT NOT NULL DEFAULT 0, outstanding_minor BIGINT NOT NULL DEFAULT 0);
CREATE TABLE installments (id UUID PRIMARY KEY, due_at TIMESTAMPTZ NOT NULL, outstanding_minor BIGINT NOT NULL DEFAULT 0, settled_minor BIGINT NOT NULL DEFAULT 0);
CREATE TABLE credit_notes (id UUID PRIMARY KEY, original_amount_minor BIGINT NOT NULL, remaining_amount_minor BIGINT NOT NULL, refunded_amount_minor BIGINT NOT NULL DEFAULT 0);
CREATE TABLE sale_items (id UUID PRIMARY KEY, quantity NUMERIC(18,4) NOT NULL, cogs_minor BIGINT NOT NULL);
`;

/** The Phase 4 rows the lock's §4 matrix says are legitimate, and which must keep passing. */
const PHASE4_LEGITIMATE = `
CREATE TABLE invoices (id UUID PRIMARY KEY, invoice_no BIGINT NOT NULL, total_txn_minor BIGINT NOT NULL, total_base_minor BIGINT NOT NULL, tax_minor BIGINT NOT NULL DEFAULT 0);
CREATE TABLE invoice_items (id UUID PRIMARY KEY, invoice_id UUID NOT NULL, quantity NUMERIC(18,4) NOT NULL, unit_price_minor BIGINT NOT NULL, tax_minor BIGINT NOT NULL DEFAULT 0);
CREATE TABLE credit_notes (id UUID PRIMARY KEY, original_amount_minor BIGINT NOT NULL, remaining_amount_minor BIGINT NOT NULL, remaining_carrying_base_amount_minor BIGINT NOT NULL);
CREATE TABLE customer_credits (id UUID PRIMARY KEY, original_amount_minor BIGINT NOT NULL, remaining_amount_minor BIGINT NOT NULL);
CREATE TABLE payments (id UUID PRIMARY KEY, payment_amount_minor BIGINT NOT NULL, received_at TIMESTAMPTZ NOT NULL, received_by UUID NOT NULL);
CREATE TABLE payment_allocations (id UUID PRIMARY KEY, payment_id UUID NOT NULL, invoice_amount_applied_minor BIGINT NOT NULL);
CREATE TABLE installments (id UUID PRIMARY KEY, due_at TIMESTAMPTZ NOT NULL, due_status TEXT NOT NULL, amount_minor BIGINT NOT NULL);
`;

// ───────────────────────────────────────────────────────────────────────────
describe('P4-S1 action 2 — G-3 refuses a stored Phase 4 balance, paid, outstanding, due or settled column (P4-AL-06)', () => {
  it('the six columns the lock reproduced as PASSING are each refused, by name', () => {
    const failures = g3Failures(PHASE4_PLANTED_COLUMNS);
    for (const planted of [
      'invoices.paid_minor',
      'invoices.outstanding_minor',
      'customers.amount_due_minor',
      'installments.outstanding_minor',
      'installments.settled_minor',
      'credit_notes.refunded_amount_minor',
      // the one the Phase 3 guard already caught, which must not stop being caught
      'customers.balance_minor',
      // P4-AL-05: COGS is the journal on 5000, never a stored per-line integer
      'sale_items.cogs_minor',
    ]) {
      expect(failures, `${planted} must be refused by G-3`).toContain(planted);
    }
  });

  it('the rule is the relation COMPLEMENT, not a Phase 4 table list: an unnamed future relation is covered too', () => {
    // Nothing in the guard mentions `layaway_plans`; it is refused because the
    // accepted Phase 2 prefix did not create it. This is the assertion that a
    // table list would fail.
    const planted = 'CREATE TABLE layaway_plans (id UUID, outstanding_minor BIGINT NOT NULL DEFAULT 0);';
    expect(isPhase3Relation('layaway_plans')).toBe(true);
    expect(g3Failures(planted)).toEqual(['layaway_plans.outstanding_minor']);
    // …and no Phase 4 table name is in the guard's CODE. The prose explains the
    // probe in the names it found, so the comments are stripped first.
    const code = stripComments(readFileSync(join(__dirname, '../../scripts/guards/no-authoritative-balance.ts'), 'utf8'));
    for (const phase4Name of ['invoices', 'customers', 'installments', 'credit_notes', 'sale_items', 'sales', 'layaway_plans']) {
      expect(code.includes(phase4Name), `${phase4Name} must not be named in the guard's code`).toBe(false);
    }
  });

  it('a Phase 4 RELATION that is itself a stored balance, cache, projection, summary, snapshot or rollup is refused', () => {
    for (const table of [
      'customer_balances',
      'sales_summary',
      'invoice_cache',
      'ar_aging_summary',
      'customer_ar_projection',
      'invoice_outstanding_cache',
      'receivables_rollup',
      'invoice_balance_snapshots',
    ]) {
      const planted = `CREATE TABLE ${table} (id UUID, amount_minor BIGINT NOT NULL);`;
      expect(g3Failures(planted), `${table} must be refused by G-3`).toContain(`table ${table}`);
    }
  });

  it('a column RENAMEd into the AP/AR vocabulary is refused: the rename is the declaration', () => {
    expect(g3Failures('CREATE TABLE invoices (id UUID, note TEXT); ALTER TABLE public.invoices RENAME COLUMN note TO paid_minor;')).toContain(
      'invoices.paid_minor',
    );
  });

  it('the vocabulary is the one the lock names, and a bare `cost` is deliberately not in it', () => {
    for (const c of [
      'paid_minor',
      'outstanding_minor',
      'amount_due_minor',
      'settled_minor',
      'refunded_amount_minor',
      'collected_minor',
      'allocated_minor',
      'ar_receivable_minor',
    ])
      expect(AP_BALANCE_COLUMN.test(c), c).toBe(true);
    for (const c of ['cogs_minor', 'cost_of_goods_minor', 'cost_total_minor', 'total_cost_minor']) expect(DERIVED_COST_COLUMN.test(c), c).toBe(true);
    // The eight accepted Phase 3 per-unit cost INPUTS a bare `cost` pattern would have turned red.
    for (const c of [
      'unit_cost_base_minor',
      'avg_unit_cost_base_minor',
      'provisional_unit_cost_base_minor',
      'actual_unit_cost_base_minor',
      'landed_cost_txn_minor',
    ])
      expect(DERIVED_COST_COLUMN.test(c), c).toBe(false);
  });

  it('the legitimate Phase 4 rows of the §4 matrix stay legitimate', () => {
    expect(g3Failures(PHASE4_LEGITIMATE)).toEqual([]);
    // P4-AL-14's remaining pair, and the `_seq` precedent of the one allowed per-key cache.
    for (const c of ['remaining_amount_minor', 'remaining_carrying_base_amount_minor', 'invoice_amount_applied_minor', 'due_status', 'due_at', 'received_by'])
      expect(isAuthoritativeInventoryColumn('credit_notes', c), c).toBe(false);
    for (const c of STOCK_CACHE_COLUMNS) expect(isAuthoritativeInventoryColumn('stock_levels', c), c).toBe(false);
    expect(isAuthoritativeInventoryColumn('stocktake_lines', 'captured_at_stock_seq')).toBe(false);
  });

  it('GREEN HALF — every accepted Phase 2/3 verdict is unchanged, over all 74 migrations', () => {
    expect(files().length).toBeGreaterThanOrEqual(74);
    expect(g3Failures(schema())).toEqual([]);
    for (const f of files()) expect(g3Failures(readFileSync(join(MIGRATIONS, f), 'utf8')), f).toEqual([]);
    // The two arms still partition the Phase 3 surface exactly as P3-S8 pinned it.
    const inventory = discoverInventoryTables(schema());
    const supplier = discoverSupplierTables(schema());
    for (const t of supplier) expect(inventory, t).not.toContain(t);
    // and the supplier arm's own accepted negative cases still pass.
    for (const c of ['purchase_amount_applied_minor', 'ap_released_before_txn_minor', 'unsettled_note_text', 'repaid_flag_text', 'overdueish', 'subpayables'])
      expect(isAuthoritativeSupplierColumn(c), c).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('P4-S1 — G-2 pins a Phase 4 `quantity` to the accepted precision (P4-AL-15b)', () => {
  it('a bare `quantity NUMERIC(18,2)` on a Phase 4 line table is refused, and says it must be NUMERIC(18,4)', () => {
    const hits = findInventoryNumericViolations('CREATE TABLE invoice_items (id UUID, quantity NUMERIC(18,2) NOT NULL);');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.table).toBe('invoice_items');
    expect(hits[0]?.column).toBe('quantity');
    expect(hits[0]?.detail).toContain('must be NUMERIC(18,4)');
  });

  it('`*_quantity`, `quantity_*` and an ALTER … TYPE are covered, and the accepted precision passes', () => {
    for (const planted of [
      'CREATE TABLE sale_items (line_quantity NUMERIC(18,2));',
      'CREATE TABLE sale_items (quantity_ordered NUMERIC(12,3));',
      'ALTER TABLE sale_items ALTER COLUMN quantity TYPE NUMERIC(18,2);',
      'CREATE TABLE sale_items (quantity DOUBLE PRECISION);',
    ]) {
      expect(findInventoryNumericViolations(planted), planted).toHaveLength(1);
    }
    expect(findInventoryNumericViolations('CREATE TABLE sale_items (quantity NUMERIC(18,4), line_quantity NUMERIC(18,4), quantity_kind TEXT);')).toEqual([]);
    expect(INVENTORY_TYPE_PINS[0]?.describe).toContain('quantity');
  });

  it('GREEN HALF — the accepted tree declares no quantity in the word form, so no verdict moved', () => {
    for (const f of files()) expect(findInventoryNumericViolations(readFileSync(join(MIGRATIONS, f), 'utf8')), f).toEqual([]);
  });
});
