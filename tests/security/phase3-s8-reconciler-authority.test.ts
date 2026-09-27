/**
 * P3-S8 T-16 — THE RECONCILER READS COLUMNS, NEVER TABLES, AND ONLY ITS
 * BUSINESS (docs/PHASE_3_S8_CONTRACT.md A-11, §2.2, §3; 0069 R-90).
 *
 * `tests/security/reconciler-authority-matrix.test.ts` compares the whole
 * model with the whole catalogue. This suite proves the S8 widening by USE,
 * as the `daftar_reconciler` credential itself:
 *
 *   - the model's S8 entries equal the live grants and the §2.2 constant, and
 *     the columns left out are exactly the ones the contract excludes
 *     (`reason`, `actor_user_id`, `unit_cost_base_minor`, `created_at`,
 *     `avg_unit_cost_base_minor`), computed from the catalogue;
 *   - under business scope every granted column is read for real (and returns
 *     that business's rows), every excluded column and `SELECT *` is refused
 *     with 42501, and no table-level SELECT exists;
 *   - cross-business: scoped to A the reconciler reads zero rows of B, and
 *     with no scope it reads nothing at all (fail-closed);
 *   - the A-11 `mustNotRead` additions are refused for real;
 *   - it writes no stock table;
 *   - at the S7 head (0068, before 0069) R-INV-01..05 are `unavailable` —
 *     never `ok` — while the nine R-ACC checks still run;
 *   - NEGATIVE CONTROL: with only `accounts.system_key` revoked in a scratch
 *     database, exactly the two checks that read it (R-INV-01, R-INV-04)
 *     become `unavailable`, naming the column: the probe is column-wise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { RECONCILIATION_CHECK_IDS } from '@daftar/accounting';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { must, seedS3World, type S3Business } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { expectAccepted, expectRefused, settle, type Outcome } from '../helpers/stock-ledger';
import { ensurePostgres, ownerPool, reconcilerDbUrl, resetData } from '../helpers/test-app';
import { R_INV, resultOf, runChecks, statuses } from '../helpers/inventory-reconciliation';

interface Model {
  role: string;
  selectColumns: Record<string, string[]>;
  writePrivileges: string[];
  executableRoutines: string[];
  mustNotRead: string[];
}

const model = JSON.parse(readFileSync(join(__dirname, '../../infrastructure/database/reconciler-privilege-model.json'), 'utf8')) as Model;

/** §2.2, as the contract states it (the gate's RECONCILER_S8_COLUMNS). */
const S8_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  stock_movements: [
    'business_id',
    'id',
    'movement_kind',
    'qty_delta',
    'source_id',
    'source_line_id',
    'source_type',
    'stock_seq',
    'tenant_id',
    'value_delta_base_minor',
    'variant_id',
    'warehouse_id',
  ],
  stock_levels: ['business_id', 'last_stock_seq', 'on_hand', 'tenant_id', 'valuation_base_minor', 'variant_id', 'warehouse_id'],
  stock_source_bindings: ['business_id', 'movement_kind', 'source_id', 'source_line_id', 'source_type', 'tenant_id'],
};
const STOCK_TABLES = Object.keys(S8_COLUMNS);
/** The columns A-02 excludes, by name. */
const EXCLUDED: Readonly<Record<string, readonly string[]>> = {
  stock_movements: ['actor_user_id', 'created_at', 'reason', 'unit_cost_base_minor'],
  stock_levels: ['avg_unit_cost_base_minor'],
  stock_source_bindings: [],
};
const MUST_NOT_READ_S8 = ['inventory_assertion_keys', 'inventory_assertion_uses', 'suppliers'];

let A: S3Business;
let B: S3Business;
let reconciler: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const w = await seedS3World(ownerPool(), 't16');
  A = w.A;
  B = w.B;
  for (const biz of [A, B]) {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '3', unitCost: '4' }]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  reconciler = new Client({ connectionString: reconcilerDbUrl });
  await reconciler.connect();
}, 300_000);

afterAll(async () => {
  await reconciler.end();
  await resetData();
});

/** Run `sql` as the reconciler in a transaction scoped to `biz` (or unscoped), always rolled back. */
async function asReconciler<T extends Record<string, unknown>>(biz: S3Business | null, sql: string, params: unknown[] = []): Promise<Outcome<T[]>> {
  await reconciler.query('BEGIN');
  try {
    if (biz !== null) {
      await reconciler.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [biz.tenantId, biz.businessId]);
    }
    return await settle(async () => (await reconciler.query<T>(sql, params)).rows);
  } finally {
    await reconciler.query('ROLLBACK');
  }
}

async function liveColumns(table: string): Promise<string[]> {
  return (
    await ownerPool().query<{ c: string }>(
      `SELECT a.attname::text AS c FROM pg_attribute a
        WHERE a.attrelid = to_regclass('public.' || $1) AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('daftar_reconciler', a.attrelid, a.attnum, 'SELECT')
        ORDER BY 1`,
      [table],
    )
  ).rows.map((x) => x.c);
}

async function allColumns(table: string): Promise<string[]> {
  return (
    await ownerPool().query<{ c: string }>(
      `SELECT a.attname::text AS c FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || $1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
      [table],
    )
  ).rows.map((x) => x.c);
}

describe('T-16 — the model, the catalogue and §2.2 agree on the S8 widening (A-11)', () => {
  it('the model names exactly the §2.2 columns for the three stock tables and system_key on accounts; the live grants are the same', async () => {
    for (const t of STOCK_TABLES) {
      expect([...(model.selectColumns[t] ?? [])].sort(), `model ${t}`).toEqual([...(S8_COLUMNS[t] ?? [])]);
      expect(await liveColumns(t), `live ${t}`).toEqual([...(S8_COLUMNS[t] ?? [])]);
    }
    expect(model.selectColumns.accounts).toContain('system_key');
    expect(await liveColumns('accounts')).toEqual([...(model.selectColumns.accounts ?? [])].sort());
  });

  it('what is left out is exactly what the contract excludes, computed from the catalogue', async () => {
    for (const t of STOCK_TABLES) {
      const granted = new Set(S8_COLUMNS[t]);
      expect(
        (await allColumns(t)).filter((c) => !granted.has(c)),
        t,
      ).toEqual([...(EXCLUDED[t] ?? [])]);
    }
  });

  it('no table-level SELECT on any stock table; mustNotRead holds the A-11 additions; one routine; no write', async () => {
    for (const t of [...STOCK_TABLES, 'accounts']) {
      expect(must((await ownerPool().query<{ s: boolean }>(`SELECT has_table_privilege('daftar_reconciler', $1, 'SELECT') AS s`, [t])).rows[0]).s, t).toBe(
        false,
      );
    }
    for (const t of MUST_NOT_READ_S8) expect(model.mustNotRead).toContain(t);
    expect(model.executableRoutines).toHaveLength(1);
    expect(model.writePrivileges).toEqual([]);
  });
});

describe('T-16 — per-column reads as the reconciler, under business scope (A-11)', () => {
  for (const [table, columns] of Object.entries(S8_COLUMNS)) {
    it(`${table}: count(*), every granted column one by one and all of them together are read; A's rows are there`, async () => {
      const n = expectAccepted(await asReconciler<{ n: number }>(A, `SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [A.businessId]), 'count');
      expect(must(n[0]).n, `${table}: A has rows`).toBeGreaterThan(0);
      for (const col of columns) {
        const rows = expectAccepted(await asReconciler(A, `SELECT ${col} FROM ${table} WHERE business_id = $1`, [A.businessId]), `${table}.${col}`);
        expect(rows.length, `${table}.${col}`).toBe(must(n[0]).n);
      }
      expectAccepted(await asReconciler(A, `SELECT ${columns.join(', ')} FROM ${table}`), `${table}: all granted columns`);
    });

    it(`${table}: every excluded column and SELECT * are refused with 42501; INSERT, UPDATE and DELETE are refused with 42501`, async () => {
      for (const col of EXCLUDED[table] ?? []) expectRefused(await asReconciler(A, `SELECT ${col} FROM ${table}`), '42501', null, `${table}.${col}`);
      if ((EXCLUDED[table] ?? []).length > 0) expectRefused(await asReconciler(A, `SELECT * FROM ${table}`), '42501', null, `${table}: *`);
      expectRefused(await asReconciler(A, `DELETE FROM ${table}`), '42501', null, `${table}: DELETE`);
      expectRefused(await asReconciler(A, `UPDATE ${table} SET business_id = business_id`), '42501', null, `${table}: UPDATE`);
      expectRefused(await asReconciler(A, `INSERT INTO ${table} (business_id) SELECT business_id FROM ${table} LIMIT 0`), '42501', null, `${table}: INSERT`);
    });
  }

  it('accounts.system_key is read under business scope; the Inventory system account of A is there', async () => {
    const rows = expectAccepted(
      await asReconciler<{ id: string }>(A, `SELECT id FROM accounts WHERE business_id = $1 AND system_key = 'inventory'`, [A.businessId]),
      'system_key',
    );
    expect(rows).toHaveLength(1);
  });
});

describe('T-16 — cross-business: the reconciler scoped to A reads zero rows of B (A-11)', () => {
  for (const table of [...STOCK_TABLES, 'accounts']) {
    it(`${table}: scoped to A, B's rows are invisible; scoped to B they are there; unscoped nothing is`, async () => {
      const count = async (scope: S3Business | null, of: S3Business): Promise<number> =>
        must(
          expectAccepted(await asReconciler<{ n: number }>(scope, `SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [of.businessId]), table)[0],
        ).n;
      expect(await count(A, B), `${table}: A reads B`).toBe(0);
      expect(await count(B, B), `${table}: B reads B`).toBeGreaterThan(0);
      expect(await count(null, A), `${table}: unscoped reads A`).toBe(0);
      expect(await count(null, B), `${table}: unscoped reads B`).toBe(0);
    });
  }
});

describe('T-16 — mustNotRead, by use (A-11)', () => {
  for (const table of MUST_NOT_READ_S8) {
    it(`${table}: refused with 42501 even under business scope`, async () => {
      expectRefused(await asReconciler(A, `SELECT count(*) FROM ${table}`), '42501', null, table);
      expectRefused(await asReconciler(A, `SELECT * FROM ${table}`), '42501', null, table);
    });
  }
});

describe('T-16 — at the S7 head the inventory checks are unavailable, never ok (§3)', () => {
  let s7: ScratchDb;
  let S: S3Business;

  beforeAll(async () => {
    s7 = await createScratchDb('daftar_p3s8_t16_s7head', { upTo: '0068_supplier_settlement_commands.sql' });
    S = (await seedS3World(s7.pool, 't16-s7')).A;
    const c = await s7.pool.connect();
    try {
      await c.query('BEGIN');
      await stockUp(c, S, S.w1, [{ variantId: S.piece.variantId, qty: '2', unitCost: '5' }]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }, 300_000);

  afterAll(async () => {
    await s7.drop();
  });

  it('R-INV-01..05 are unavailable and name what they cannot read; the nine R-ACC checks still run', async () => {
    const run = await runChecks(s7.poolAs('daftar_reconciler'), { tenantId: S.tenantId, businessId: S.businessId }, [...R_INV, ...RECONCILIATION_CHECK_IDS]);
    const s = statuses(run);
    for (const id of R_INV) {
      expect(s[id], id).toBe('unavailable');
      expect(resultOf(run, id).errorCode, id).toMatch(/^accounting\.reconciliation_unavailable:/);
    }
    expect(resultOf(run, 'R-INV-01').errorCode).toMatch(/stock_movements/);
    for (const id of RECONCILIATION_CHECK_IDS) expect(s[id], id).not.toBe('unavailable');
  });
});

describe('T-16 NEGATIVE CONTROL — revoke only accounts.system_key: exactly the checks that read it become unavailable', () => {
  let scratch: ScratchDb;
  let S: S3Business;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t16_nc');
    S = (await seedS3World(scratch.pool, 't16-nc')).A;
    const c = await scratch.pool.connect();
    try {
      await c.query('BEGIN');
      await stockUp(c, S, S.w1, [{ variantId: S.piece.variantId, qty: '2', unitCost: '5' }]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('as shipped every R-INV check is ok; with system_key revoked R-INV-01 and R-INV-04 are unavailable naming the column, the rest stay ok', async () => {
    const target = { tenantId: S.tenantId, businessId: S.businessId };
    expect(statuses(await runChecks(scratch.poolAs('daftar_reconciler'), target))).toEqual({
      'R-INV-01': 'ok',
      'R-INV-02': 'ok',
      'R-INV-03': 'ok',
      'R-INV-04': 'ok',
      'R-INV-05': 'ok',
    });
    await scratch.pool.query(`REVOKE SELECT (system_key) ON accounts FROM daftar_reconciler`);
    const run = await runChecks(scratch.poolAs('daftar_reconciler'), target);
    expect(statuses(run)).toEqual({ 'R-INV-01': 'unavailable', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'unavailable', 'R-INV-05': 'ok' });
    for (const id of ['R-INV-01', 'R-INV-04'] as const) expect(resultOf(run, id).errorCode, id).toMatch(/accounts\.system_key/);
  });
});
