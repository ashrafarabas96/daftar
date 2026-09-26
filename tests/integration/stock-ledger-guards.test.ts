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
  findForbiddenInventoryRelations,
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

  describe('L-2: the same forbidden use behind a cast, a quote or a parenthesis', () => {
    const sqlRules = (sql: string): string[] => [...new Set(rulesOf({ migrations: { '9999_inventory_x.sql': sql } }))];
    const tsRules = (ts: string): string[] => [...new Set(rulesOf({ packageFiles: { 'packages/inventory/src/x.ts': ts } }))];

    it('fires on HALF_UP rounding behind a quote, a parenthesis or a NUMERIC type-modifier cast', () => {
      for (const planted of [
        'SELECT round((v_value));',
        'SELECT "round"(v_value);',
        'SELECT pg_catalog."round"(v_value, 0);',
        'SELECT (round)(v_value);',
        'SELECT ( pg_catalog.round )(v_value);',
        'SELECT v_value::numeric(18,4);',
        'SELECT v_value :: NUMERIC ( 28 , 10 );',
        'SELECT v_value::numeric(18);',
        'SELECT v_value::pg_catalog.numeric(18,0);',
        'SELECT CAST(v_value AS numeric(28,10));',
        'SELECT CAST(v_value AS DECIMAL(18,4));',
      ]) {
        expect(sqlRules(planted), planted).toEqual(['no-sql-round']);
      }
      for (const planted of ['SELECT "scale"(q);', 'SELECT (scale)(q);', 'SELECT (pg_catalog.scale)(q);']) {
        expect(sqlRules(planted), planted).toEqual(['no-sql-scale']);
      }
    });

    it('fires on binary floating point in inventory SQL: a cast, a CAST, a function-style cast, a declaration, a result or a literal', () => {
      for (const planted of [
        'SELECT (q * c)::float8;',
        'SELECT q::real;',
        'SELECT q :: "float4";',
        'SELECT q::pg_catalog.float8;',
        'SELECT q::FLOAT;',
        'SELECT CAST(q AS double precision);',
        'SELECT CAST(q AS float);',
        'SELECT CAST(q AS REAL);',
        'SELECT float8(q);',
        'SELECT "float8"(q);',
        "SELECT real '1.5';",
        'DECLARE v_ratio real; BEGIN NULL; END;',
        'DECLARE v_ratio FLOAT := 0; BEGIN NULL; END;',
        'CREATE FUNCTION f(p_q real) RETURNS numeric AS $$ SELECT 1 $$ LANGUAGE sql;',
        'CREATE FUNCTION f() RETURNS real AS $$ SELECT 1 $$ LANGUAGE sql;',
      ]) {
        expect(sqlRules(planted), planted).toEqual(['no-sql-float']);
      }
    });

    it('is still scoped: exact casts, words and identifiers that only contain the type names pass', () => {
      for (const clean of [
        'SELECT 10000000000::numeric, v_value::bigint, p_unit_decimals::integer;',
        'SELECT v_real, real_cost, unreal FROM stock_levels;',
        "RAISE EXCEPTION 'inventory.x: a real quantity is required' USING ERRCODE = 'P0001';",
        'SELECT trunc(abs(q), 4), mod(q, 2::numeric);',
      ]) {
        expect(sqlRules(clean), clean).toEqual([]);
      }
    });

    it('fires on binary floating point in the package however it is reached', () => {
      for (const planted of [
        "export const y = Math['round'](x);",
        'export const y = Math?.round(x);',
        'export const y = Math . round(x);',
        'const { round } = Math;',
        'const M = Math;',
        'export const y = Number (q4);',
        'export const y = (Number)(q4);',
        'const N = Number;',
        "export const y = Number.parseFloat('1');",
        "export const y = Number['parseFloat']('1');",
        "export const y = x['toFixed'](2);",
        'export const y = x?.toFixed(2);',
        "export const y = globalThis.parseFloat('1');",
      ]) {
        expect(tsRules(planted), planted).toEqual(['no-float-arithmetic']);
      }
      // A digit count may be a number: the Number predicates and a time stamp's Math.floor are not arithmetic on a quantity.
      expect(tsRules('const ok = Number.isInteger(d) && Number.isSafeInteger(e) && !Number.isNaN(t) && Math.floor(t) > 0;')).toEqual([]);
    });

    it('reports a spelling both patterns match once', () => {
      expect(rulesOf({ migrations: { '9999_inventory_x.sql': 'SELECT round(1.5);' } })).toEqual(['no-sql-round']);
      expect(rulesOf({ packageFiles: { 'packages/inventory/src/x.ts': 'export const y = Math.round(x) + Number(q);' } })).toEqual([
        'no-float-arithmetic',
        'no-float-arithmetic',
      ]);
    });
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
          'SELECT q::float8;',
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

  it('L-3: a type change re-declares the column — ALTER COLUMN … TYPE cannot undo a pin or bring a float in', () => {
    for (const planted of [
      'ALTER TABLE stock_movements ALTER COLUMN qty_delta TYPE double precision;',
      'ALTER TABLE stock_levels ALTER on_hand SET DATA TYPE NUMERIC(18,2);',
      'ALTER TABLE public.stock_levels ALTER COLUMN valuation_base_minor TYPE numeric USING valuation_base_minor::numeric;',
      'ALTER TABLE "public"."stock_movements" ALTER COLUMN "unit_cost_base_minor" TYPE NUMERIC(28,4);',
      'ALTER TABLE IF EXISTS ONLY negative_inventory_deficits ALTER COLUMN drift TYPE REAL;',
      'ALTER TABLE stock_levels ADD COLUMN note TEXT, ALTER COLUMN avg_unit_cost_base_minor TYPE FLOAT8;',
    ]) {
      expect(findInventoryNumericViolations(planted), planted).toHaveLength(1);
    }
    expect(findInventoryNumericViolations('ALTER TABLE stock_movements ALTER COLUMN qty_delta TYPE NUMERIC(18,4);')).toEqual([]);
    expect(findInventoryNumericViolations('ALTER TABLE products ALTER COLUMN weight TYPE REAL;')).toEqual([]);
  });

  it('L-3: a quoted or schema-qualified inventory table is read as that table', () => {
    for (const planted of [
      'CREATE TABLE public.stock_movements (id UUID, weight REAL);',
      'CREATE TABLE "public"."stock_levels" (id UUID, on_hand NUMERIC(18,2));',
      'CREATE TABLE IF NOT EXISTS public . "inventory_future_things" (ratio DOUBLE PRECISION);',
      'ALTER TABLE public.stock_levels ADD COLUMN drift REAL;',
      'ALTER TABLE IF EXISTS ONLY stock_levels ADD COLUMN drift REAL;',
    ]) {
      expect(findInventoryNumericViolations(planted), planted).toHaveLength(1);
    }
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

  describe('L-3: renames, quoted and schema-qualified names, and relations without the prefix', () => {
    const CACHE =
      'CREATE TABLE stock_levels (on_hand NUMERIC(18,4), valuation_base_minor BIGINT, avg_unit_cost_base_minor NUMERIC(28,10), last_stock_seq BIGINT);';

    it('discovers quoted and schema-qualified tables, materialized views, SELECT … INTO and RENAME TO targets', () => {
      expect(
        discoverInventoryTables(
          [
            'CREATE TABLE public.stock_balances (id UUID);',
            'CREATE TABLE "public"."stock_snapshots" (id UUID);',
            'CREATE UNLOGGED TABLE IF NOT EXISTS public . "inventory_rollups" (id UUID);',
            'CREATE MATERIALIZED VIEW public.stock_cache AS SELECT 1;',
            'SELECT * INTO stock_summary FROM stock_levels;',
            'ALTER TABLE products RENAME TO inventory_summaries;',
            'CREATE TABLE products (id UUID);',
          ].join('\n'),
        ),
      ).toEqual(['inventory_rollups', 'inventory_summaries', 'stock_balances', 'stock_cache', 'stock_snapshots', 'stock_summary']);
      for (const t of ['inventory_rollups', 'inventory_summaries', 'stock_balances', 'stock_cache', 'stock_snapshots', 'stock_summary']) {
        expect(isForbiddenInventoryTable(t), t).toBe(true);
      }
    });

    it('a table RENAMEd into a stock balance is refused, prefix or not', () => {
      expect(discoverInventoryTables('ALTER TABLE stock_levels RENAME TO stock_balances;')).toEqual(['stock_balances']);
      expect(findForbiddenInventoryRelations('ALTER TABLE IF EXISTS public.stock_levels RENAME TO "warehouse_stock_balances";')).toEqual([
        'warehouse_stock_balances',
      ]);
      expect(
        findForbiddenInventoryRelations(
          'CREATE TABLE warehouse_stock_balances (id UUID); CREATE TABLE products (id UUID); CREATE TABLE branch_inventory_cache (x INT);',
        ),
      ).toEqual(['branch_inventory_cache', 'warehouse_stock_balances']);
      expect(findForbiddenInventoryRelations(schema())).toEqual([]);
    });

    it('a column RENAMEd to reserved / available or to a stored quantity is refused', () => {
      expect(findAuthoritativeInventoryColumns('ALTER TABLE stock_levels RENAME COLUMN last_stock_seq TO reserved;', ['stock_levels'])).toEqual([
        { table: 'stock_levels', column: 'reserved' },
      ]);
      expect(findAuthoritativeInventoryColumns('ALTER TABLE public.stock_movements RENAME qty_delta TO "available_qty";', ['stock_movements'])).toEqual([
        { table: 'stock_movements', column: 'available_qty' },
      ]);
      expect(findAuthoritativeInventoryColumns('ALTER TABLE stock_movements RENAME COLUMN note TO on_hand;', ['stock_movements'])).toEqual([
        { table: 'stock_movements', column: 'on_hand' },
      ]);
      // Renaming a constraint or the table itself is not a column.
      expect(findAuthoritativeInventoryColumns('ALTER TABLE stock_levels RENAME CONSTRAINT c TO reserved;', ['stock_levels'])).toEqual([]);
    });

    it('the cache shape follows renames: a cache column renamed away is missing, and a reserved column is refused', () => {
      const shape = checkStockCacheShape(`${CACHE}\nALTER TABLE "stock_levels" RENAME COLUMN last_stock_seq TO reserved;`);
      expect(shape).toEqual([expect.stringContaining('last_stock_seq is missing'), expect.stringContaining('stock_levels.reserved')]);
      expect(checkStockCacheShape(CACHE)).toEqual([]);
    });

    it('a quoted or schema-qualified cache or ledger declares its columns like any other', () => {
      expect(findAuthoritativeInventoryColumns('CREATE TABLE public.stock_levels (id UUID, reserved NUMERIC(18,4));', ['stock_levels'])).toHaveLength(1);
      expect(findAuthoritativeInventoryColumns('ALTER TABLE "public"."stock_levels" ADD COLUMN available NUMERIC(18,4);', ['stock_levels'])).toHaveLength(1);
      expect(
        findAuthoritativeInventoryColumns('ALTER TABLE IF EXISTS ONLY stock_movements ADD COLUMN on_hand NUMERIC(18,4);', ['stock_movements']),
      ).toHaveLength(1);
      expect(checkStockCacheShape(CACHE.replace('stock_levels', 'public.stock_levels'))).toEqual([]);
    });
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
    expect(guards).toMatch(/discoverInventoryTables\(schema\)\.includes\('stock_movements'\)/);
    expect(guards).toMatch(/findForbiddenInventoryRelations\(schema\)/);
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
