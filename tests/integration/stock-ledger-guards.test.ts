import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_ARITHMETIC_WHY,
  findInventoryArithmeticViolations,
  isInventoryMigration,
  stripTsComments,
  type InventoryArithmeticSources,
} from '../../scripts/guards/inventory-arithmetic';
import { checkInventoryDefinerContract } from '../../scripts/guards/inventory-definer-contract';
import { checkInventoryWriterAuthority, firstStatement, stockTablesWritten } from '../../scripts/guards/inventory-writer-authority';
import {
  STOCK_CACHE_COLUMNS,
  STOCK_CACHE_EXCEPTION,
  checkStockCacheShape,
  discoverAccountingTables,
  discoverInventoryTables,
  findAuthoritativeBalanceColumns,
  findAuthoritativeInventoryColumns,
  isAuthoritativeBalanceColumn,
  isAuthoritativeInventoryColumn,
  isForbiddenInventoryTable,
} from '../../scripts/guards/no-authoritative-balance';
import { INVENTORY_TABLE_RE, findFloatRateColumns, findInventoryNumericViolations } from '../../scripts/guards/no-float-rate';

/**
 * P3-S2 guards (contract §7.2, §6 T-12): every new or extended guard is shown
 * RED on a planted violation — an in-memory string, never an edit of a real
 * migration — and GREEN on the real tree. A guard that cannot be made to fail
 * is not a guard.
 */

const ROOT = join(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'infrastructure/database/migrations');

function readTree(dir: string, ext: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (ext.test(e)) out[relative(ROOT, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const migrations = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    out[f] = readFileSync(join(MIGRATIONS, f), 'utf8');
  }
  return out;
};
const schema = (): string => Object.values(migrations()).join('\n');

const realArithmeticSources = (): InventoryArithmeticSources => ({
  migrations: migrations(),
  packageFiles: readTree(join(ROOT, 'packages/inventory/src'), /\.ts$/),
  apiInventoryFiles: readTree(join(ROOT, 'apps/api/src/modules/inventory'), /\.ts$/),
});

const EMPTY: InventoryArithmeticSources = { migrations: {}, packageFiles: {}, apiInventoryFiles: {} };
const rulesOf = (src: Partial<InventoryArithmeticSources>): string[] => findInventoryArithmeticViolations({ ...EMPTY, ...src }).map((f) => f.rule);

// ───────────────────────────────────────────────────────────────────────────
describe('rule 21 — inventory arithmetic (T-12)', () => {
  it('the real tree is clean, and the rule is watching the package and the inventory migrations', () => {
    const src = realArithmeticSources();
    expect(findInventoryArithmeticViolations(src)).toEqual([]);
    expect(Object.keys(src.packageFiles)).toEqual(
      expect.arrayContaining([
        'packages/inventory/src/fixed-point.ts',
        'packages/inventory/src/rounding.ts',
        'packages/inventory/src/valuation.ts',
        'packages/inventory/src/rebuild.ts',
      ]),
    );
    expect(Object.keys(src.migrations).filter(isInventoryMigration)).toEqual(
      expect.arrayContaining(['0059_inventory_stock_ledger.sql', '0060_inventory_stock_primitive.sql']),
    );
  });

  it('T-12.1: fires on on_hand × avg in SQL and onHand * avg in TypeScript', () => {
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'SELECT on_hand * avg_unit_cost_base_minor FROM stock_levels;' } })).toEqual([
      'no-on-hand-times-avg',
    ]);
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'v := v_avg * v_on_hand;' } })).toEqual(['no-on-hand-times-avg']);
    expect(rulesOf({ packageFiles: { 'packages/inventory/src/x.ts': 'export const v = (s: S) => s.onHand * avg;' } })).toEqual(['no-on-hand-times-avg']);
    expect(rulesOf({ packageFiles: { 'packages/inventory/src/x.ts': 'const v = avgC10 * onHand;' } })).toEqual(['no-on-hand-times-avg']);
  });

  it('T-12.2: fires on round( and scale( in inventory SQL, even in a body or a literal', () => {
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'CREATE FUNCTION f() RETURNS numeric AS $$ SELECT round(1.5) $$ LANGUAGE sql;' } })).toEqual([
      'no-sql-round',
    ]);
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'SELECT 1 WHERE scale(q) <= 0;' } })).toEqual(['no-sql-scale']);
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': "SELECT 'round(x)';" } })).toEqual(['no-sql-round']);
  });

  it('T-12.3: fires on created_at ordering over the ledger or the deficits, and on deadlock handling', () => {
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'SELECT id FROM stock_movements ORDER BY created_at;' } })).toEqual(['no-created-at-ordering']);
    expect(
      rulesOf({ migrations: { '9999_inventory_x.sql': 'SELECT id FROM negative_inventory_deficits d ORDER BY d.deficit_seq, d.created_at DESC;' } }),
    ).toEqual(['no-created-at-ordering']);
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': "EXCEPTION WHEN SQLSTATE '40P01' THEN RETRY;" } })).toEqual(['no-deadlock-handling']);
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'EXCEPTION WHEN deadlock_detected THEN NULL;' } })).toEqual(['no-deadlock-handling']);
    expect(rulesOf({ apiInventoryFiles: { 'apps/api/src/modules/inventory/x.ts': "if (e.code === '40P01') return retry();" } })).toEqual([
      'no-deadlock-handling',
    ]);
  });

  it('fires on binary floating point in the arithmetic package', () => {
    for (const planted of ['Math.round(x)', 'x.toFixed(2)', "parseFloat('1.5')", 'Number(q4)']) {
      expect(rulesOf({ packageFiles: { 'packages/inventory/src/x.ts': `export const y = ${planted};` } }), planted).toEqual(['no-float-arithmetic']);
    }
  });

  it('T-12.N: every rule has its own planted violation, and each carries a reason', () => {
    const planted = findInventoryArithmeticViolations({
      migrations: {
        '9999_inventory_x.sql': [
          'SELECT on_hand * avg FROM stock_levels;',
          'SELECT round(1.5);',
          'SELECT scale(1.50);',
          'SELECT 1 FROM stock_movements ORDER BY created_at;',
          "SELECT '40P01';",
        ].join('\n'),
      },
      packageFiles: { 'packages/inventory/src/x.ts': 'export const y = Math.round(1);' },
      apiInventoryFiles: {},
    });
    const rules = [...new Set(planted.map((f) => f.rule))].sort();
    expect(rules).toEqual(Object.keys(INVENTORY_ARITHMETIC_WHY).sort());
    for (const f of planted) expect(f.evidence).toMatch(/^line \d+: /);
  });

  it('is scoped: comments may name the anti-pattern, other tables may order by created_at, and non-inventory files are not read', () => {
    expect(
      rulesOf({ migrations: { '9999_inventory_x.sql': '-- never round( and never on_hand * avg\n/* ORDER BY created_at over stock_movements */ SELECT 1;' } }),
    ).toEqual([]);
    expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'SELECT jti FROM inventory_assertion_uses ORDER BY created_at;' } })).toEqual([]);
    expect(rulesOf({ migrations: { '9999_accounting_x.sql': 'SELECT round(1.5) FROM stock_movements ORDER BY created_at;' } })).toEqual([]);
    expect(rulesOf({ packageFiles: { 'packages/inventory/src/x.ts': '// Math.round is forbidden\n/* Number( too */ export const u = "https://x";' } })).toEqual(
      [],
    );
    expect(stripTsComments('a; // gone\nconst s = "http://kept";')).toBe('a; \nconst s = "http://kept";');
  });

  it('control: the real package with one planted Number( goes red', () => {
    const src = realArithmeticSources();
    const file = 'packages/inventory/src/rounding.ts';
    const before = src.packageFiles[file] ?? '';
    expect(before.length).toBeGreaterThan(0);
    const findings = findInventoryArithmeticViolations({
      ...src,
      packageFiles: { ...src.packageFiles, [file]: `${before}\nexport const leak = Number(1n);\n` },
    });
    expect(findings.map((f) => [f.file, f.rule])).toEqual([[file, 'no-float-arithmetic']]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('rule 16 extended — inventory storage is exact fixed point (G-2)', () => {
  const t = (cols: string, table = 'stock_movements') => `CREATE TABLE ${table} (id UUID, ${cols});`;

  it('the real tree is clean, and stock_movements exists for the rule to watch', () => {
    for (const [file, sql] of Object.entries(migrations())) expect(findInventoryNumericViolations(sql), file).toEqual([]);
    expect(schema()).toMatch(/CREATE\s+TABLE\s+stock_movements\b/);
  });

  it('refuses a floating-point column on any inventory table, in CREATE or ALTER', () => {
    for (const type of ['REAL', 'FLOAT', 'FLOAT8', 'FLOAT(53)', 'DOUBLE PRECISION']) {
      expect(findInventoryNumericViolations(t(`weight ${type}`)), type).toHaveLength(1);
    }
    expect(findInventoryNumericViolations(t('ratio DOUBLE PRECISION', 'negative_future_things'))).toHaveLength(1);
    expect(findInventoryNumericViolations(t('ratio REAL', 'inventory_future_things'))).toHaveLength(1);
    expect(findInventoryNumericViolations('ALTER TABLE stock_levels ADD COLUMN drift REAL;')).toHaveLength(1);
  });

  it('pins quantities to NUMERIC(18,4), costs to NUMERIC(28,10) and values to BIGINT', () => {
    const bad = [
      'qty_delta NUMERIC(18,2)',
      'on_hand NUMERIC',
      'original_deficit_qty NUMERIC(20,4)',
      'qty_covered TEXT',
      'unit_cost_base_minor NUMERIC(28,4)',
      'avg_unit_cost_base_minor NUMERIC(18,4)',
      'value_delta_base_minor NUMERIC(28,10)',
      'valuation_base_minor INTEGER',
    ];
    for (const col of bad) expect(findInventoryNumericViolations(t(col)), col).toHaveLength(1);
    const good = [
      'qty_delta NUMERIC(18,4) NOT NULL',
      'on_hand NUMERIC(18, 4)',
      'uncovered_qty NUMERIC(18,4)',
      'qty_covered NUMERIC(18,4) NOT NULL CHECK (qty_covered > 0)',
      'unit_cost_base_minor NUMERIC(28,10) NULL',
      'value_delta_base_minor BIGINT NOT NULL',
      'valuation_base_minor BIGINT NOT NULL DEFAULT 0',
      "qty_sign TEXT NOT NULL CHECK (qty_sign IN ('positive','negative','either','zero'))",
    ];
    for (const col of good) expect(findInventoryNumericViolations(t(col)), col).toEqual([]);
  });

  it('is scoped to inventory tables, and the accounting half is unchanged', () => {
    expect(INVENTORY_TABLE_RE.test('stock_movements')).toBe(true);
    expect(INVENTORY_TABLE_RE.test('products')).toBe(false);
    expect(findInventoryNumericViolations('CREATE TABLE products (qty_delta REAL, on_hand NUMERIC);')).toEqual([]);
    // The accounting rate rule does not start watching inventory tables…
    expect(findFloatRateColumns('CREATE TABLE stock_movements (fx_rate REAL);')).toEqual([]);
    // …and still watches its own.
    expect(findFloatRateColumns('CREATE TABLE journal_lines (fx_rate REAL);')).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('rule 15 extended — one stock cache, no second truth (G-3)', () => {
  it('the real tree is clean, and the rule watches every S2 table', () => {
    const tables = discoverInventoryTables(schema());
    expect(tables).toEqual(
      expect.arrayContaining([
        'negative_deficit_coverages',
        'negative_inventory_deficits',
        'stock_levels',
        'stock_movement_kinds',
        'stock_movements',
        'stock_source_bindings',
        'stock_source_types',
        'inventory_operation_movement_kinds',
      ]),
    );
    for (const [file, sql] of Object.entries(migrations())) expect(findAuthoritativeInventoryColumns(sql, tables), file).toEqual([]);
    for (const table of tables) expect(isForbiddenInventoryTable(table), table).toBe(false);
    expect(checkStockCacheShape(schema())).toEqual([]);
    expect(STOCK_CACHE_EXCEPTION).toBe('stock_levels');
    expect([...STOCK_CACHE_COLUMNS]).toEqual(['on_hand', 'valuation_base_minor', 'avg_unit_cost_base_minor', 'last_stock_seq']);
  });

  it('refuses reserved / available anywhere, the cache included (P3-AL-01)', () => {
    for (const [table, column] of [
      ['stock_levels', 'reserved'],
      ['stock_levels', 'available'],
      ['stock_levels', 'qty_reserved'],
      ['stock_movements', 'available_qty'],
    ]) {
      expect(findAuthoritativeInventoryColumns(`CREATE TABLE ${table} (id UUID, ${column} NUMERIC(18,4));`, [table ?? '']), `${table}.${column}`).toHaveLength(
        1,
      );
    }
    expect(
      checkStockCacheShape(
        'CREATE TABLE stock_levels (on_hand NUMERIC(18,4), valuation_base_minor BIGINT, avg_unit_cost_base_minor NUMERIC(28,10), last_stock_seq BIGINT, reserved NUMERIC(18,4));',
      ),
    ).toHaveLength(1);
  });

  it('refuses a stored quantity or valuation outside the four cache columns', () => {
    const cases: [string, string][] = [
      ['stock_movements', 'on_hand'],
      ['stock_movements', 'running_valuation'],
      ['negative_inventory_deficits', 'valuation_base_minor'],
      ['stock_levels', 'on_hand_total'],
      ['stock_levels', 'stock_balance'],
      ['inventory_future_things', 'stock'],
    ];
    for (const [table, column] of cases) {
      expect(isAuthoritativeInventoryColumn(table, column), `${table}.${column}`).toBe(true);
    }
    expect(findAuthoritativeInventoryColumns('ALTER TABLE stock_movements ADD COLUMN on_hand NUMERIC(18,4);', ['stock_movements'])).toEqual([
      { table: 'stock_movements', column: 'on_hand' },
    ]);
  });

  it('allows the cache its four columns, and an ordering or identity column anywhere', () => {
    for (const c of STOCK_CACHE_COLUMNS) expect(isAuthoritativeInventoryColumn('stock_levels', c), c).toBe(false);
    for (const [table, column] of [
      ['stock_movements', 'stock_seq'],
      ['negative_inventory_deficits', 'deficit_seq'],
      ['negative_inventory_deficits', 'source_stock_movement_id'],
      ['stock_movement_kinds', 'movement_kind'],
    ]) {
      expect(isAuthoritativeInventoryColumn(table ?? '', column ?? ''), `${table}.${column}`).toBe(false);
    }
  });

  it('refuses a table that IS a stock balance, summary, snapshot, rollup or cache', () => {
    for (const name of [
      'stock_balances',
      'stock_balance',
      'inventory_summary',
      'inventory_summaries',
      'stock_snapshots',
      'inventory_rollups',
      'stock_cache',
      'inventory_running_balances',
    ]) {
      expect(isForbiddenInventoryTable(name), name).toBe(true);
    }
    expect(discoverInventoryTables('CREATE TABLE stock_summary (id UUID); CREATE TABLE products (id UUID);')).toEqual(['stock_summary']);
  });

  it('a missing cache, or a cache missing a column, means the rule is watching nothing or the wrong thing', () => {
    expect(checkStockCacheShape('CREATE TABLE stock_movements (id UUID);')[0]).toMatch(/watching nothing/);
    expect(
      checkStockCacheShape('CREATE TABLE stock_levels (on_hand NUMERIC(18,4), valuation_base_minor BIGINT, avg_unit_cost_base_minor NUMERIC(28,10));'),
    ).toEqual([expect.stringContaining('last_stock_seq is missing')]);
  });

  it('accounting behaviour is unchanged: its tables, its column rule and its exemptions', () => {
    expect(discoverAccountingTables(schema()).some((t) => /^(stock_|negative_|inventory_)/.test(t))).toBe(false);
    // `stock_seq` is exempt for inventory tables ONLY — the accounting rule still refuses it.
    expect(isAuthoritativeBalanceColumn('stock_seq')).toBe(true);
    expect(isAuthoritativeBalanceColumn('on_hand')).toBe(false);
    expect(findAuthoritativeBalanceColumns('CREATE TABLE accounts (id UUID, balance BIGINT);')).toEqual([{ table: 'accounts', column: 'balance' }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('G-7 strengthened and rule 22, in brief (the full mutation suite is inventory-db-guard.test.ts)', () => {
  it('G-7 still sees a broken 0055 definition although 0060 replaces the routine correctly', () => {
    const tree = migrations();
    const f55 = '0055_inventory_configure_product.sql';
    const before = tree[f55] ?? '';
    tree[f55] = before.replace(/(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER');
    expect(tree[f55]).not.toBe(before);
    const v = checkInventoryDefinerContract({ migrations: tree }).violations;
    expect(v.some((m) => m.startsWith(f55) && m.includes('not SECURITY DEFINER'))).toBe(true);
  });

  it('rule 22 reads writes and first statements precisely', () => {
    expect(stockTablesWritten('WITH mv AS (INSERT INTO stock_movements VALUES (1) RETURNING 1) UPDATE stock_levels l SET on_hand = 0;')).toEqual([
      'stock_levels',
      'stock_movements',
    ]);
    expect(stockTablesWritten('SELECT 1 FROM stock_levels FOR UPDATE; SELECT 1 FROM stock_levels FOR NO KEY UPDATE;')).toEqual([]);
    expect(stockTablesWritten('DELETE FROM stock_source_bridge_purchase WHERE false;')).toEqual(['stock_source_bridge_purchase']);
    expect(firstStatement("DECLARE v int; BEGIN v := inventory_assertion_consume('x', 'y'); INSERT INTO stock_levels VALUES (1); END;")).toBe(
      "v := inventory_assertion_consume('', '')",
    );
    expect(checkInventoryWriterAuthority(migrations()).violations).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('scripts/static-guards.ts wiring', () => {
  const guards = readFileSync(join(ROOT, 'scripts/static-guards.ts'), 'utf8');

  it('rule 6b covers the inventory package; rules 15, 16, 21 and 22 carry their inventory halves and watch-nothing checks', () => {
    expect(guards).toMatch(/'packages\/inventory\/src',\n\]\)/);
    expect(guards).toMatch(/findAuthoritativeInventoryColumns/);
    expect(guards).toMatch(/checkStockCacheShape/);
    expect(guards).toMatch(/findInventoryNumericViolations/);
    expect(guards).toMatch(/stock_movements does not exist/);
    expect(guards).toMatch(/findInventoryArithmeticViolations/);
    expect(guards).toMatch(/rule 21 is watching nothing/);
    expect(guards).toMatch(/checkInventoryWriterAuthority/);
    expect(guards).toMatch(/rule 22 is watching nothing/);
    expect(guards).toMatch(/STATIC GUARDS: PASS \(22 rules\)/);
  });

  it('passes all 22 rules on the real tree', () => {
    const tsx = join(ROOT, 'node_modules/.bin/tsx');
    const out = execFileSync(tsx, [join(ROOT, 'scripts/static-guards.ts')], { cwd: ROOT, encoding: 'utf8' });
    expect(out.trim().split('\n').pop()).toBe('STATIC GUARDS: PASS (22 rules)');
  });
});
