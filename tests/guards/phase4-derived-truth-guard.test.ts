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
  DERIVED_DEBT_COLUMN,
  STOCK_CACHE_COLUMNS,
  discoverInventoryTables,
  discoverPhase3Relations,
  discoverSalesTables,
  discoverSupplierTables,
  findAuthoritativeInventoryColumns,
  findAuthoritativeSalesColumns,
  findAuthoritativeSupplierColumns,
  isAuthoritativeInventoryColumn,
  isAuthoritativeSalesColumn,
  isAuthoritativeSupplierColumn,
  isForbiddenInventoryTable,
  isForbiddenSalesTable,
  isForbiddenSupplierTable,
  isPhase3Relation,
  isPhase4Relation,
  phase4InheritedPrefixRelations,
} from '../../scripts/guards/no-authoritative-balance';
import { INVENTORY_TYPE_PINS, findInventoryNumericViolations } from '../../scripts/guards/no-float-rate';
import { PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';
import { discoverStoredRelations, stripComments } from '../../scripts/guards/sql-schema';

const MIGRATIONS = join(__dirname, '../../infrastructure/database/migrations');
const files = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const schema = (): string =>
  files()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');

/** The FROZEN inherited prefix alone (`0000`-`0073`): the only tree over which a partition claim can be permanent. */
const inheritedSchema = (): string =>
  files()
    .filter((f) => f <= PHASE4_INHERITED_PREFIX_END)
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');

/** The Phase 4 migrations alone: everything after the inherited prefix. */
const phase4Schema = (): string =>
  files()
    .filter((f) => f > PHASE4_INHERITED_PREFIX_END)
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
  // P4-S1: the third arm, wired into rule 15 beside the two above.
  const phase4 = discoverSalesTables(sql);
  for (const h of findAuthoritativeSalesColumns(sql, phase4)) out.push(`${h.table}.${h.column}`);
  for (const t of phase4) if (isForbiddenSalesTable(t)) out.push(`table ${t}`);
  return [...new Set(out)].sort();
}

/** The third arm ALONE, so a proof shows what the Phase 4 arm itself refuses rather than what some arm refuses. */
function salesArmFailures(sql: string): string[] {
  const watched = discoverSalesTables(sql);
  const out = findAuthoritativeSalesColumns(sql, watched).map((h) => `${h.table}.${h.column}`);
  for (const t of watched) if (isForbiddenSalesTable(t)) out.push(`table ${t}`);
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

// ───────────────────────────────────────────────────────────────────────────
/**
 * P4-S1 action 2 — the G-3 SALES ARM (`findAuthoritativeSalesColumns`).
 *
 * The gate (`scripts/phase4-s1-gate.ts`, `guardProblems`) demands this arm as
 * a BEHAVIOUR: run over Phase 4 DDL it must name every derived total and none
 * of the document's own facts. Each rule below is planted as the defect it
 * refuses and asserted to fail for that reason, and then the accepted tree is
 * shown clean. The arm's surface is the relation COMPLEMENT of the accepted
 * inherited prefix (`0000`–`0073`), never a Phase 4 table list.
 */
describe('P4-S1 action 2 — the G-3 sales arm refuses derived truth on the Phase 4 surface (P4-AL-06)', () => {
  it('the arm is anchored on SQL RELATION POSITION: the accepted inherited prefix created it, or the arm watches it', () => {
    // A relation the inherited prefix created is not this arm's business, whatever it is called.
    for (const t of ['products', 'accounts', 'journal_lines', 'stock_movements', 'stock_levels', 'suppliers', 'purchases', 'stocktake_lines', 'units']) {
      expect(phase4InheritedPrefixRelations().has(t), t).toBe(true);
      expect(isPhase4Relation(t), t).toBe(false);
    }
    // …and a relation it did not create is, under ANY name — no list anywhere.
    for (const t of ['customers', 'invoices', 'installments', 'credit_notes', 'sale_items', 'layaway_plans', 'wedding_deposit_books']) {
      expect(isPhase4Relation(t), t).toBe(true);
    }
    // The plant is caught on the Phase 4 side of that line and NOT on the inherited side.
    expect(salesArmFailures('CREATE TABLE layaway_plans (id UUID, debt_minor BIGINT NOT NULL);')).toEqual(['layaway_plans.debt_minor']);
    expect(salesArmFailures('CREATE TABLE products (id UUID, debt_minor BIGINT NOT NULL);')).toEqual([]);
    expect(discoverSalesTables('CREATE TABLE stock_movements (id UUID, overdue_minor BIGINT);')).toEqual([]);
  });

  it('RED — every column of the lock’s reproduced fixture is named by the sales arm itself', () => {
    const failures = salesArmFailures(PHASE4_PLANTED_COLUMNS);
    for (const planted of [
      'customers.balance_minor',
      'customers.amount_due_minor',
      'invoices.paid_minor',
      'invoices.outstanding_minor',
      'installments.outstanding_minor',
      'installments.settled_minor',
      'credit_notes.refunded_amount_minor',
      'sale_items.cogs_minor',
    ]) {
      expect(failures, `${planted} must be refused by the G-3 sales arm`).toContain(planted);
    }
    // …and it names nothing else in that DDL: the document's own facts stay facts.
    for (const fact of ['invoices.total_txn_minor', 'credit_notes.original_amount_minor', 'credit_notes.remaining_amount_minor', 'sale_items.quantity'])
      expect(failures, fact).not.toContain(fact);
  });

  it('RED — a stored DEBT truth: `debt`, `overdue`, `arrears` and an aging bucket, none of which the AP/AR words reach', () => {
    // The hole this rule closes: `(^|_)due($|_)` needs a boundary before `due`,
    // so `overdue_amount_minor` passed AP_BALANCE_COLUMN, and `debt_minor`
    // names the quantity in a word no earlier pattern carried at all.
    for (const c of ['debt_minor', 'total_debt_minor', 'overdue_amount_minor', 'overdue_minor', 'arrears_minor', 'aging_bucket_minor', 'ageing_30_minor']) {
      expect(AP_BALANCE_COLUMN.test(c) || DERIVED_COST_COLUMN.test(c), `${c} escaped the pre-P4 vocabulary`).toBe(false);
      expect(DERIVED_DEBT_COLUMN.test(c), c).toBe(true);
      expect(isAuthoritativeSalesColumn(c), c).toBe(true);
    }
    const planted =
      'CREATE TABLE customers (id UUID, debt_minor BIGINT NOT NULL DEFAULT 0, overdue_amount_minor BIGINT NOT NULL DEFAULT 0, aging_bucket_minor BIGINT NOT NULL DEFAULT 0);';
    expect(salesArmFailures(planted)).toEqual(['customers.aging_bucket_minor', 'customers.debt_minor', 'customers.overdue_amount_minor']);
    // The vocabulary is SHARED, so the same word is refused on the Phase 3 arms
    // too — planted on the real tree, which is what gives those arms their
    // watched set (a bare ALTER creates no relation to discover).
    expect(g3Failures(`${schema()}\nALTER TABLE suppliers ADD COLUMN overdue_amount_minor BIGINT;`)).toEqual(['suppliers.overdue_amount_minor']);
    expect(g3Failures(`${schema()}\nALTER TABLE stocktake_lines ADD COLUMN debt_minor BIGINT;`)).toEqual(['stocktake_lines.debt_minor']);
    // …and it is token-bounded: a word that merely CONTAINS one of them is not a debt column.
    for (const c of ['overdueish', 'packaged_qty', 'managed_by', 'indebtedness_note_text', 'imaging_ref_id'])
      expect(isAuthoritativeSalesColumn(c), c).toBe(false);
  });

  it('RED — a reservation or an availability is never stored on the Phase 4 surface either', () => {
    const planted = 'CREATE TABLE sale_holds (id UUID, reserved_qty NUMERIC(18,4) NOT NULL, available_qty NUMERIC(18,4) NOT NULL, reserved_at TIMESTAMPTZ);';
    expect(salesArmFailures(planted)).toEqual(['sale_holds.available_qty', 'sale_holds.reserved_qty']);
    // `reserved_at` is an instant, not a quantity, and is deliberately untouched.
    expect(isAuthoritativeSalesColumn('reserved_at')).toBe(false);
  });

  it('RED — a Phase 4 RELATION that IS derived truth is refused under any name, aging and overdue included', () => {
    for (const table of [
      'customer_balances',
      'customer_ar_aging',
      'invoice_overdue_buckets',
      'debt_arrears_table',
      'sales_summary',
      'invoice_outstanding_cache',
      'receivables_rollup',
      'invoice_balance_snapshots',
      'customer_ar_projection',
    ]) {
      const planted = `CREATE TABLE ${table} (id UUID, amount_minor BIGINT NOT NULL);`;
      expect(salesArmFailures(planted), `${table} must be refused by the G-3 sales arm`).toContain(`table ${table}`);
      expect(isForbiddenSalesTable(table), table).toBe(true);
    }
  });

  it('RED — a column RENAMEd into the vocabulary is refused: the rename is the declaration', () => {
    expect(salesArmFailures('CREATE TABLE invoices (id UUID, note TEXT); ALTER TABLE public.invoices RENAME COLUMN note TO overdue_minor;')).toContain(
      'invoices.overdue_minor',
    );
    expect(salesArmFailures('CREATE TABLE customers (id UUID); ALTER TABLE customers ADD COLUMN balance_minor BIGINT;')).toEqual(['customers.balance_minor']);
  });

  it('the legitimate §4 rows stay legitimate under the sales arm, and no allowlist is what keeps them so', () => {
    expect(salesArmFailures(PHASE4_LEGITIMATE)).toEqual([]);
    // P4-AL-14's remaining pair, an allocation's own amount, a policy input, an ordering, an identity, an actor, an instant.
    for (const c of [
      'remaining_amount_minor',
      'remaining_carrying_base_amount_minor',
      'invoice_amount_applied_minor',
      'credit_limit_minor',
      'total_minor',
      'total_txn_minor',
      'tax_minor',
      'unit_price_minor',
      'invoice_seq',
      'due_at',
      'due_status',
      'received_by',
      'balance_id',
    ])
      expect(isAuthoritativeSalesColumn(c), c).toBe(false);
    // Nothing named those columns: each passes because no pattern matches it.
    const code = stripComments(readFileSync(join(__dirname, '../../scripts/guards/no-authoritative-balance.ts'), 'utf8'));
    for (const allowed of ['remaining', 'credit_limit', 'amount_applied']) expect(code.includes(allowed), allowed).toBe(false);
  });

  /**
   * P4-S1: re-expressed, and tense-independent (P4-AL-88).
   *
   * This used to read the WHOLE migration directory and end with
   * `expect(discoverSalesTables(schema())).toEqual([])`. That is a claim about
   * the phase that follows, written while the phase that follows had created
   * nothing: the sales arm is DEFINED as "every stored relation the accepted
   * inherited prefix did not create", so the first Phase 4 relation makes the
   * assertion false by construction, and an accepted suite that goes red
   * because the next migration exists is a suite that FORBIDS the next
   * migration — exactly what `P4-AL-88` refuses.
   *
   * There is a second thing the old form got wrong, and it is the more
   * interesting one. The partition it asserts cannot hold over a tree that has
   * Phase 4 relations in it, because `isPhase3Relation` means "the Phase 2
   * prefix did not create it" and `discoverInventoryTables` takes, as its
   * complement clause, every such relation that is not supplier-named. A Phase
   * 4 relation satisfies both, so the inherited inventory arm claims it TOO.
   * That overlap is not a defect and must not be papered over: a Phase 4
   * relation watched by two arms is watched more strictly, never less. The
   * honest form asserts it as the fact it is, rather than denying it.
   *
   * So the partition claim is made where it is true and permanent — over the
   * ACCEPTED INHERITED PREFIX, whose contents are frozen — and the Phase 4
   * half is made positively, over the Phase 4 files alone. Both halves hold
   * today and after every later Phase 4 migration, and a Phase 3 relation
   * quietly leaving one of the two inherited arms is still red.
   */
  it('the arm is a third SET beside the Phase 3 partition, over the frozen prefix where that claim is permanent', () => {
    const inherited = inheritedSchema();
    const inventory = discoverInventoryTables(inherited);
    const supplier = discoverSupplierTables(inherited);
    // Every relation of the FROZEN inherited prefix is watched by exactly one
    // of the two inherited arms. Unchanged, and it cannot drift: the prefix is
    // byte-frozen and the gate proves it.
    for (const t of discoverPhase3Relations(inherited)) expect([inventory.includes(t), supplier.includes(t)].filter(Boolean), t).toHaveLength(1);
    // The sales arm claims NOTHING the inherited prefix created — permanently
    // true, because that prefix is the arm's own definition.
    expect(discoverSalesTables(inherited)).toEqual([]);
    for (const t of [...inventory, ...supplier]) expect(isPhase4Relation(t), t).toBe(false);
    // And positively: the sales arm claims every relation the Phase 4
    // migrations create, and only those.
    const phase4Relations = discoverSalesTables(phase4Schema());
    expect(phase4Relations).toEqual(discoverStoredRelations(phase4Schema()));
    for (const t of phase4Relations) expect(isPhase4Relation(t), t).toBe(true);
    // The deliberate overlap, asserted rather than denied: the inherited
    // inventory arm's complement clause also claims each Phase 4 relation, so
    // each is watched by TWO arms. Stricter, never looser — and a Phase 4
    // relation that fell out of BOTH would be watched by neither.
    const inventoryOverWholeTree = discoverInventoryTables(schema());
    for (const t of phase4Relations) {
      expect(inventoryOverWholeTree, `${t} is watched by the inherited inventory arm too`).toContain(t);
      expect(discoverSalesTables(schema()), `${t} is watched by the sales arm`).toContain(t);
    }
  });

  it('GREEN HALF — the sales arm is silent on the accepted tree, all 74 migrations of it, file by file', () => {
    expect(files().length).toBeGreaterThanOrEqual(74);
    expect(salesArmFailures(schema())).toEqual([]);
    for (const f of files()) expect(salesArmFailures(readFileSync(join(MIGRATIONS, f), 'utf8')), f).toEqual([]);
    // …and rule 15 as a whole, with the third arm wired in, is unchanged on it.
    expect(g3Failures(schema())).toEqual([]);
  });
});
