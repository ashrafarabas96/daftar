import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findDefinerSearchPathViolations, skippedAsFrozen } from '../../scripts/guards/definer-search-path';
import {
  INVENTORY_TABLE_NAME,
  SUPPLIER_TABLE_NAME,
  discoverInventoryTables,
  discoverPhase3Relations,
  discoverPhase3RelationsByPosition,
  discoverSupplierTables,
  findAuthoritativeInventoryColumns,
  findAuthoritativeSupplierColumns,
  isPhase3Relation,
  phase2PrefixRelations,
} from '../../scripts/guards/no-authoritative-balance';
import { INVENTORY_TABLE_RE, findInventoryNumericViolations } from '../../scripts/guards/no-float-rate';
import { INVENTORY_PERIMETER, findInventoryPerimeterViolations, findPostingSurfaceViolations } from '../../scripts/guards/posting-surface';
import {
  PURE_BUILTINS,
  TRUTH_TABLE_EXCLUSIONS,
  WRITER_AUTHORITY_EXCEPTIONS,
  checkInventoryWriterAuthority,
  pureAssertionHelpers,
  truthTables,
} from '../../scripts/guards/inventory-writer-authority';
import { PHASE2_PREFIX_END } from '../../scripts/phase2-prefix';
import { deliveredFiles } from '../helpers/delivered-files';

/**
 * T-14 — P3-S8 contract A-18 (a)–(e): every widened guard FIRES on a planted
 * violation and is CLEAN on the real tree. Every plant is an in-memory string
 * or a file in a throwaway hard-linked copy of the tree; no real migration or
 * source file is ever written. A guard that cannot be made to fail is not a
 * guard, so each case below also shows the violation the pre-S8 rule MISSED
 * where that is the point of the widening.
 */

const ROOT = join(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'infrastructure/database/migrations');

/** Every migration, `file → text`, in order. */
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

/** The five Phase 3 tables that escaped the name-based discovery before S8 (Annex R #10). */
const ESCAPED = ['branch_warehouses', 'stocktake_lines', 'stocktakes', 'unit_names', 'units'];

/** Non-test application sources, repository-relative, as static-guards.ts reads them. */
function appFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      if (['node_modules', '.next', 'dist', 'build', 'test'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) out[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  for (const surface of ['apps/api/src', 'apps/web/src', 'apps/admin/src', 'packages']) walk(join(ROOT, surface));
  return out;
}

// ── The shared discovery ─────────────────────────────────────────────────────
describe('the Phase 3 surface, discovered by migration position (A-18(a), TL-10)', () => {
  it('the prefix complement equals "created by a file after 0052" on the real tree: 47 relations, the five escapees among them', () => {
    const byComplement = discoverPhase3Relations(schema());
    const byPosition = discoverPhase3RelationsByPosition(migrations());
    expect(byComplement).toEqual(byPosition);
    expect(byComplement).toHaveLength(47);
    for (const t of ESCAPED) {
      expect(byComplement, t).toContain(t);
      // …and the pre-S8 name discovery missed each of them:
      expect(INVENTORY_TABLE_NAME.test(t) || SUPPLIER_TABLE_NAME.test(t), t).toBe(false);
      expect(INVENTORY_TABLE_RE.test(t), t).toBe(false);
    }
  });

  it('the prefix set is read from the digest-verified 0000–0052 files and holds the Phase 1/2 relations only', () => {
    const prefix = phase2PrefixRelations();
    for (const t of ['products', 'product_variants', 'accounts', 'journal_entries', 'journal_lines', 'businesses', 'warehouses']) {
      expect(prefix.has(t), t).toBe(true);
      expect(isPhase3Relation(t), t).toBe(false);
    }
    for (const t of discoverPhase3RelationsByPosition(migrations())) expect(prefix.has(t), t).toBe(false);
  });
});

// ── (a) G-3 ──────────────────────────────────────────────────────────────────
describe('A-18(a) — G-3 watches every Phase 3 relation; the names only choose the vocabulary', () => {
  it('the inventory vocabulary covers the five escapees; the supplier vocabulary is unchanged', () => {
    const inventory = discoverInventoryTables(schema());
    for (const t of ESCAPED) expect(inventory, t).toContain(t);
    for (const t of discoverSupplierTables(schema())) expect(inventory, t).not.toContain(t);
    // Every Phase 3 relation is watched by exactly one of the two halves.
    const supplier = discoverSupplierTables(schema());
    for (const t of discoverPhase3Relations(schema())) expect([inventory.includes(t), supplier.includes(t)].filter(Boolean), t).toHaveLength(1);
  });

  it('is clean on the real tree', () => {
    const inventory = discoverInventoryTables(schema());
    const supplier = discoverSupplierTables(schema());
    for (const [file, sql] of Object.entries(migrations())) {
      expect(findAuthoritativeInventoryColumns(sql, inventory), file).toEqual([]);
      expect(findAuthoritativeSupplierColumns(sql, supplier), file).toEqual([]);
    }
  });

  it('fires on a stored quantity or balance planted on each escapee (the pre-S8 discovery watched none of them)', () => {
    for (const [table, column] of [
      ['units', 'on_hand'],
      ['unit_names', 'stock_balance'],
      ['branch_warehouses', 'valuation_base_minor'],
      ['stocktakes', 'balance_minor'],
      ['stocktake_lines', 'available_qty'],
    ] as const) {
      const planted = `${schema()}\nALTER TABLE ${table} ADD COLUMN ${column} NUMERIC(18,4);`;
      expect(findAuthoritativeInventoryColumns(`ALTER TABLE ${table} ADD COLUMN ${column} NUMERIC(18,4);`, discoverInventoryTables(planted)), table).toEqual([
        { table, column },
      ]);
    }
  });

  it('fires on a stored balance planted on payment_methods (the S6 vocabulary, kept)', () => {
    expect(findAuthoritativeSupplierColumns('ALTER TABLE payment_methods ADD COLUMN balance_minor BIGINT;', discoverSupplierTables(schema()))).toEqual([
      { table: 'payment_methods', column: 'balance_minor' },
    ]);
  });

  it('a NEW Phase 3 table under any name is watched the day it is created', () => {
    const planted = 'CREATE TABLE shelf_counts (id UUID, on_hand NUMERIC(18,4));';
    expect(discoverInventoryTables(planted)).toEqual(['shelf_counts']);
    expect(findAuthoritativeInventoryColumns(planted, discoverInventoryTables(planted))).toEqual([{ table: 'shelf_counts', column: 'on_hand' }]);
    // A Phase 1/2 table keeps its Phase 1/2 treatment.
    expect(discoverInventoryTables('CREATE TABLE products (id UUID, on_hand NUMERIC(18,4));')).toEqual([]);
  });
});

// ── (b) G-2 ──────────────────────────────────────────────────────────────────
describe('A-18(b) — G-2 holds every Phase 3 relation to exact fixed point', () => {
  it('is clean on the real tree, file by file', () => {
    for (const [file, sql] of Object.entries(migrations())) expect(findInventoryNumericViolations(sql), file).toEqual([]);
  });

  it('fires on a REAL column planted on units and on a supplier settlement table', () => {
    expect(findInventoryNumericViolations('ALTER TABLE units ADD COLUMN factor REAL;')).toEqual([
      expect.objectContaining({ table: 'units', column: 'factor' }),
    ]);
    expect(findInventoryNumericViolations('ALTER TABLE stocktake_lines ALTER COLUMN counted_qty TYPE NUMERIC(18,2);')).toEqual([
      expect.objectContaining({ table: 'stocktake_lines', column: 'counted_qty' }),
    ]);
    expect(findInventoryNumericViolations('ALTER TABLE supplier_payments ADD COLUMN ratio DOUBLE PRECISION;')).toHaveLength(1);
    expect(findInventoryNumericViolations('CREATE TABLE shelf_counts (id UUID, weight FLOAT8);')).toHaveLength(1);
  });

  it('leaves a Phase 1/2 table where it was', () => {
    expect(findInventoryNumericViolations('ALTER TABLE products ADD COLUMN weight REAL;')).toEqual([]);
  });
});

// ── (c) G-4 ──────────────────────────────────────────────────────────────────
describe('A-18(c) — G-4 gains the inventory perimeter', () => {
  it('the perimeter is the G-3 discovery; the tree is clean, the S7 read modules included (Annex R #22)', () => {
    expect(INVENTORY_PERIMETER.tables(schema())).toEqual(discoverPhase3Relations(schema()));
    const files = appFiles();
    for (const read of [
      'apps/api/src/modules/inventory/inventory-reads.ts',
      'apps/api/src/modules/inventory/read-scope.ts',
      'apps/api/src/modules/purchasing/purchasing-reads.ts',
      'apps/api/src/modules/purchasing/supplier-balance-reads.ts',
    ]) {
      expect(Object.keys(files), read).toContain(read);
    }
    expect(findInventoryPerimeterViolations({ schema: schema(), appFiles: files })).toEqual([]);
    expect(findPostingSurfaceViolations({ schema: schema(), appFiles: files })).toEqual([]);
  });

  it('fires on an UPDATE of stock_levels in an apps/api file, and on each other DML shape', () => {
    for (const sql of [
      'UPDATE stock_levels SET on_hand = 0',
      'insert into public.suppliers (id) values ($1)',
      'DELETE FROM "stocktake_lines" WHERE id = $1',
      'MERGE INTO purchases p USING x ON false WHEN MATCHED THEN DELETE',
      'TRUNCATE TABLE branch_warehouses',
    ]) {
      const v = findPostingSurfaceViolations({
        schema: schema(),
        appFiles: { 'apps/api/src/modules/inventory/rogue.service.ts': `await c.query(\`${sql}\`);` },
      });
      expect(v, sql).toHaveLength(1);
      expect(v[0], sql).toMatch(/apps\/api\/src\/modules\/inventory\/rogue\.service\.ts issues .* — application code may only CALL the inventory commands/);
    }
    expect(
      findInventoryPerimeterViolations({
        schema: schema(),
        appFiles: { 'packages/inventory/src/rogue.ts': "export const q = 'UPDATE stock_movements SET qty_delta = 0';" },
      }),
    ).toHaveLength(1);
  });

  it('does not fire on a read, a row lock, a comment, or a file outside application code', () => {
    const files = {
      'apps/api/src/a.ts': "c.query('SELECT 1 FROM stock_levels WHERE id = $1 FOR UPDATE');",
      'apps/api/src/b.ts': '// never UPDATE stock_levels here — the primitive does\nexport const x = 1;',
      'scripts/tooling.ts': "c.query('UPDATE stock_levels SET on_hand = 0');",
      'apps/api/src/c.ts': "c.query('UPDATE products SET name = $1');",
    };
    expect(findInventoryPerimeterViolations({ schema: schema(), appFiles: files })).toEqual([]);
  });

  it('fires on a migration granting a runtime role or PUBLIC DML on a perimeter table, table- or column-level, or on ALL TABLES', () => {
    for (const grant of [
      'GRANT INSERT ON suppliers TO daftar_app;',
      'GRANT UPDATE (on_hand, valuation_base_minor) ON stock_levels TO daftar_worker;',
      'GRANT SELECT, DELETE ON TABLE public.units TO daftar_reconciler;',
      'GRANT ALL ON supplier_payments TO PUBLIC;',
      'GRANT TRUNCATE ON stocktakes TO daftar_platform;',
      'GRANT INSERT ON ALL TABLES IN SCHEMA public TO daftar_app;',
    ]) {
      const v = findPostingSurfaceViolations({ schema: `${schema()}\n${grant}`, appFiles: {} });
      expect(v, grant).toHaveLength(1);
      expect(v[0], grant).toMatch(/inside the inventory perimeter/);
    }
  });

  it('does not fire on the internal principals, on SELECT, or on a Phase 1/2 table', () => {
    for (const grant of [
      'GRANT INSERT, UPDATE ON suppliers TO daftar_inventory_internal;',
      'GRANT UPDATE ON supplier_credit_notes TO daftar_accounting_internal;',
      'GRANT SELECT ON stock_levels TO daftar_app;',
      'GRANT SELECT (system_key) ON accounts TO daftar_reconciler;',
    ]) {
      expect(findInventoryPerimeterViolations({ schema: `${schema()}\n${grant}`, appFiles: {} }), grant).toEqual([]);
    }
  });
});

// ── (d) G-5 ──────────────────────────────────────────────────────────────────
describe('A-18(d) — G-5 checks every file after the Phase 2 prefix forever, frozen or not', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as { migrations: { name: string }[] };
  const frozen = new Set(manifest.migrations.map((m) => m.name));
  const bootstrap = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
  const F68 = '0068_supplier_settlement_commands.sql';

  it('the skip ends at the prefix; the real tree is clean with every frozen Phase 3 file checked', () => {
    expect(frozen.has(F68)).toBe(true);
    expect(skippedAsFrozen(frozen, F68)).toBe(false);
    expect(skippedAsFrozen(frozen, PHASE2_PREFIX_END)).toBe(true);
    expect(findDefinerSearchPathViolations({ migrations: migrations(), bootstrap, frozen })).toEqual([]);
  });

  it('fires on a frozen Phase 3 definer with pg_temp first (the pre-S8 rule skipped the whole file)', () => {
    const tree = migrations();
    const before = tree[F68] ?? '';
    tree[F68] = before.replace('SET search_path = pg_catalog, public, pg_temp', 'SET search_path = pg_temp, pg_catalog, public');
    expect(tree[F68]).not.toBe(before);
    const v = findDefinerSearchPathViolations({ migrations: tree, bootstrap, frozen });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(new RegExp(`^${F68}: .* must be named LAST`));
  });

  it('fires on a frozen Phase 3 file that creates a TEMP relation', () => {
    const tree = migrations();
    tree[F68] = `${tree[F68] ?? ''}\nCREATE TEMP TABLE scratch (x INT);`;
    expect(findDefinerSearchPathViolations({ migrations: tree, bootstrap, frozen }).join('\n')).toMatch(/creates a TEMP relation/);
  });

  it('keeps the frozen Phase 2 skip exactly as it was', () => {
    const tree = migrations();
    const F45 = '0045_accounting_post_entry.sql';
    tree[F45] =
      `${tree[F45] ?? ''}\nCREATE FUNCTION zz_phase2_shape() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, public AS $$ SELECT 1 $$;`;
    expect(findDefinerSearchPathViolations({ migrations: tree, bootstrap, frozen })).toEqual([]);
  });
});

// ── (e) Rule 22 ─────────────────────────────────────────────────────────────
describe('A-18(e) — rule 22 widens to the truth set with argument purity', () => {
  const PATH = 'SET search_path = pg_catalog, public, pg_temp';
  /** The real tree plus one file; `handover` false leaves the routine migrator-owned. */
  const planted = (lines: readonly string[]): Record<string, string> => ({ ...migrations(), '0099_planted.sql': lines.join('\n') });
  const internalRoutine = (name: string, header: string, body: string): string[] => [
    'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
    `CREATE FUNCTION ${name} ${header} ${PATH} AS $$`,
    body,
    '$$;',
    `REVOKE ALL ON FUNCTION ${name.replace(/\(.*$/, '')} FROM PUBLIC;`,
    `ALTER FUNCTION ${name.replace(/\(.*$/, '')} OWNER TO daftar_inventory_internal;`,
    'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
  ];

  it('the truth set is every table granted to the principal after 0052 for writing, minus the key domain and the logs', () => {
    const truth = truthTables(migrations());
    for (const t of ['purchases', 'suppliers', 'payment_methods', 'supplier_payments', 'stocktakes', 'branch_warehouses', 'stock_levels']) {
      expect(truth, t).toContain(t);
    }
    for (const t of TRUTH_TABLE_EXCLUSIONS) expect(truth, t).not.toContain(t);
    expect([...WRITER_AUTHORITY_EXCEPTIONS]).toEqual(['warehouses_home_branch_maintain']);
    expect(checkInventoryWriterAuthority(migrations()).violations).toEqual([]);
  });

  it('the pure helpers are the declared IMMUTABLE/STABLE, non-writing internal routines and the exact built-ins', () => {
    const pure = pureAssertionHelpers(migrations());
    for (const name of ['inventory_claimed_payload_digest', 'inventory_fixed_text', 'inventory_reason_words', ...PURE_BUILTINS])
      expect(pure, name).toContain(name);
    for (const name of ['inventory_apply_stock_movements', 'inventory_assertion_consume', 'supplier_credit_note_consume', 'inventory_next_deficit_seq']) {
      expect(pure, name).not.toContain(name);
    }
  });

  it('fires on a routine writing purchases without an assertion (the pre-S8 table set did not name purchases)', () => {
    const v = checkInventoryWriterAuthority(
      planted(
        internalRoutine(
          'purchase_sneaky_writer()',
          'RETURNS void LANGUAGE plpgsql SECURITY DEFINER',
          'BEGIN\n  UPDATE purchases SET status = status WHERE false;\nEND;',
        ),
      ),
    ).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/0099_planted\.sql: purchase_sneaky_writer writes purchases but its first statement is not inventory_assertion_consume/);
  });

  it('fires on a consume argument calling a VOLATILE helper, and on a STABLE helper that writes', () => {
    const helper = (name: string, volatility: string, body: string) =>
      internalRoutine(`${name}(p TEXT)`, `RETURNS TEXT LANGUAGE plpgsql ${volatility} SECURITY DEFINER`, body);
    const writer = (callee: string) =>
      internalRoutine(
        `supplier_digest_writer_${callee}()`,
        'RETURNS void LANGUAGE plpgsql SECURITY DEFINER',
        `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  v_actor := inventory_assertion_consume('supplier.update', ${callee}('x'));\n  UPDATE suppliers SET name = name WHERE false;\nEND;`,
      );
    const volatile = checkInventoryWriterAuthority(
      planted([...helper('inventory_volatile_digest', 'VOLATILE', 'BEGIN RETURN p; END;'), ...writer('inventory_volatile_digest')]),
    ).violations;
    expect(volatile).toHaveLength(1);
    expect(volatile[0]).toContain("assertion call's arguments call inventory_volatile_digest");
    const writing = checkInventoryWriterAuthority(
      planted([
        ...helper('inventory_writing_digest', 'STABLE', 'BEGIN DELETE FROM audit_events WHERE false; RETURN p; END;'),
        ...writer('inventory_writing_digest'),
      ]),
    ).violations;
    expect(writing).toHaveLength(1);
    expect(writing[0]).toContain("assertion call's arguments call inventory_writing_digest");
    // The positive control: the same writer over a declared-STABLE, non-writing helper passes.
    expect(
      checkInventoryWriterAuthority(planted([...helper('inventory_stable_digest', 'STABLE', 'BEGIN RETURN p; END;'), ...writer('inventory_stable_digest')]))
        .violations,
    ).toEqual([]);
  });

  it('the real digest helper made VOLATILE turns every entry routine that digests its consume arguments red', () => {
    const tree = migrations();
    const F54 = '0054_inventory_assertion_authority.sql';
    const before = tree[F54] ?? '';
    tree[F54] = before.replace(/(inventory_claimed_payload_digest\([\s\S]*?LANGUAGE plpgsql )STABLE/, '$1VOLATILE');
    expect(tree[F54]).not.toBe(before);
    const v = checkInventoryWriterAuthority(tree).violations;
    expect(v.length).toBeGreaterThanOrEqual(20);
    expect(v.every((m) => m.includes('arguments call inventory_claimed_payload_digest'))).toBe(true);
  });

  it('fires on a migrator-owned Phase 3 definer that writes a truth table (A-04: of any owner)', () => {
    const v = checkInventoryWriterAuthority(
      planted([
        `CREATE FUNCTION migrator_owned_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER ${PATH} AS $$`,
        'BEGIN\n  INSERT INTO supplier_refunds DEFAULT VALUES;\nEND;',
        '$$;',
        'REVOKE ALL ON FUNCTION migrator_owned_writer() FROM PUBLIC;',
      ]),
    ).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/migrator_owned_writer writes supplier_refunds/);
  });

  it('the exception set is exact: the maintainer is exempt, and an exception that stops writing is reported', () => {
    expect(checkInventoryWriterAuthority(migrations()).exempt).toEqual(['0056_inventory_branch_warehouses.sql: warehouses_home_branch_maintain']);
    const tree = migrations();
    const F56 = '0056_inventory_branch_warehouses.sql';
    const before = tree[F56] ?? '';
    tree[F56] = before.replace(
      /(FUNCTION warehouses_home_branch_maintain\(\)[\s\S]*?BEGIN\n)\s*INSERT INTO branch_warehouses[\s\S]*?ON CONFLICT DO NOTHING;/,
      '$1  PERFORM 1;',
    );
    expect(tree[F56]).not.toBe(before);
    const v = checkInventoryWriterAuthority(tree).violations;
    expect(v).toEqual([expect.stringContaining('warehouses_home_branch_maintain is a rule-22 exception but writes no truth table')]);
  });
});

// ── End to end: the real static-guards.ts, run in a throwaway copy of the tree ─
/**
 * The library calls above prove each rule; this proves the WIRING — that
 * `npm run check:guards` reaches each widened rule (the static-guards.ts
 * wiring is unchanged by S8; only the guard modules grew). Each case plants
 * one migration or source file in a hard-linked copy and runs the copy's own
 * static-guards.ts, whose `__dirname` makes the copy its root.
 */
describe('end to end: check:guards refuses each planted violation, and passes the untouched copy', () => {
  const temporaries: string[] = [];
  afterAll(() => {
    for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
  });
  const files = (): string[] =>
    deliveredFiles(ROOT).filter(
      (rel) => rel !== '' && (rel.startsWith('scripts/') || rel.startsWith('infrastructure/') || rel.startsWith('apps/') || rel.startsWith('packages/')),
    );
  const copy = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'p3s8-guards-'));
    temporaries.push(root);
    for (const rel of files()) {
      const source = join(ROOT, rel);
      if (!existsSync(source) || statSync(source).isDirectory()) continue;
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      linkSync(source, target);
    }
    return root;
  };
  const plant = (root: string, rel: string, contents: string): void => {
    const target = join(root, rel);
    rmSync(target, { force: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const guards = (root: string): { status: number | null; output: string } => {
    const res = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), [join(root, 'scripts/static-guards.ts')], { cwd: root, encoding: 'utf8' });
    return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };

  it('the untouched copy passes all 23 rules', () => {
    const run = guards(copy());
    expect(run.output).toContain('STATIC GUARDS: PASS (23 rules)');
    expect(run.status).toBe(0);
  }, 120_000);

  it.each([
    ['no-authoritative-balance', 'infrastructure/database/migrations/0099_planted.sql', 'ALTER TABLE stocktakes ADD COLUMN on_hand NUMERIC(18,4);\n'],
    ['no-float-rate', 'infrastructure/database/migrations/0099_planted.sql', 'ALTER TABLE units ADD COLUMN factor REAL;\n'],
    ['posting-surface', 'infrastructure/database/migrations/0099_planted.sql', 'GRANT INSERT ON suppliers TO daftar_app;\n'],
    ['posting-surface', 'apps/api/src/modules/inventory/rogue.service.ts', "export const q = 'UPDATE stock_levels SET on_hand = 0';\n"],
    [
      // Into the FROZEN 0068: before S8 the whole file was skipped.
      'definer-search-path',
      'infrastructure/database/migrations/0068_supplier_settlement_commands.sql',
      readFileSync(join(MIGRATIONS, '0068_supplier_settlement_commands.sql'), 'utf8').replace(
        'SET search_path = pg_catalog, public, pg_temp',
        'SET search_path = pg_temp, pg_catalog, public',
      ),
    ],
    [
      'inventory-writer-authority',
      'infrastructure/database/migrations/0099_planted.sql',
      'CREATE FUNCTION planted_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$\nBEGIN\n  UPDATE purchases SET status = status WHERE false;\nEND;\n$$;\nREVOKE ALL ON FUNCTION planted_writer() FROM PUBLIC;\n',
    ],
  ])(
    '%s refuses %s',
    (rule, rel, contents) => {
      const root = copy();
      plant(root, rel, contents);
      const run = guards(root);
      expect(run.output, run.output.slice(-3000)).toContain(`FAIL [${rule}]`);
      expect(run.status).not.toBe(0);
    },
    120_000,
  );
});
