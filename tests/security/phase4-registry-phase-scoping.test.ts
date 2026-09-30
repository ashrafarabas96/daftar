/**
 * P4-S1 — RED PROOF FOR THE PHASE-SCOPED REGISTRY ASSERTIONS (plan action 7).
 *
 * `assertMigrationState()` (`tests/helpers/stock-ledger.ts`) and
 * `assertS4MigrationState()` (`tests/helpers/purchase-deficits.ts`) used to
 * assert the COMPLETE contents of `stock_source_types`,
 * `inventory_operation_movement_kinds` and `inventory_operation_kinds` with one
 * `toEqual` over hard-coded `S1_/S3_/S4_/S5_/S6_/P3C_` arrays. Between them they
 * are called from 13 sites across four permanent Phase 3 suites
 * (`stock-ledger-concurrency`, `stock-ledger-same-owner`,
 * `stock-ledger-authority`, `stock-ledger-structure`), so registering a single
 * Phase 4 operation kind or stock source type would have turned all of them red.
 *
 * P4-S1 scoped the three reads to the registries' own provenance column,
 * `registered_by ~ '^P3-'`. This suite is the proof that the scoping is a
 * RE-EXPRESSION and not a loosening. Each case plants a defect inside a
 * transaction that is always rolled back, and requires the helper to raise:
 *
 *   1. a MISSING Phase 3 registration is still caught;
 *   2. an EXTRA row claiming Phase 3 provenance is still caught, so the scoping
 *      cannot be dodged by mislabelling a later phase's row as a Phase 3 one;
 *   3. a row a later phase legitimately registers is OUT of scope, which is the
 *      property the re-expression exists to buy.
 *
 * Nothing here is committed: every case runs inside `BEGIN … ROLLBACK`, so the
 * shared cluster is unchanged whether the case passes or fails.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool } from '../helpers/test-app';
import { assertMigrationState } from '../helpers/stock-ledger';
import { assertS4MigrationState } from '../helpers/purchase-deficits';

let pool: Pool;

beforeAll(async () => {
  await ensurePostgres();
  pool = ownerPool();
});

afterAll(async () => {
  // `ownerPool()` is the shared pool; nothing to close here.
});

/** Run `fn` against a client inside a transaction that is ALWAYS rolled back. */
async function inRolledBackTx(fn: (c: { query: Pool['query'] }) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c as unknown as { query: Pool['query'] });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

describe('P4-S1 the phase-scoped registry assertions are no weaker (plan action 7)', () => {
  it('both helpers are green on the untouched database, so the red proofs below mean something', async () => {
    await assertMigrationState();
    await assertS4MigrationState();
  });

  it('the scope is exactly the Phase 3 provenance family, and a later phase falls outside it', async () => {
    const r = await pool.query<{ p3s1: boolean; p3s6: boolean; p3c: boolean; p4s1: boolean; p4s2: boolean }>(
      `SELECT 'P3-S1' ~ '^P3-' AS p3s1, 'P3-S6' ~ '^P3-' AS p3s6, 'P3-C' ~ '^P3-' AS p3c,
              'P4-S1' ~ '^P3-' AS p4s1, 'P4-S2' ~ '^P3-' AS p4s2`,
    );
    expect(r.rows[0]).toEqual({ p3s1: true, p3s6: true, p3c: true, p4s1: false, p4s2: false });
    // And every row in all three registries today carries Phase 3 provenance,
    // so the scoped read and the old absolute read agree exactly right now.
    for (const table of ['stock_source_types', 'inventory_operation_movement_kinds', 'inventory_operation_kinds']) {
      const all = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      const scoped = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE registered_by ~ '^P3-'`);
      expect(scoped.rows[0]?.n, table).toBe(all.rows[0]?.n);
      expect(all.rows[0]?.n ?? 0, table).toBeGreaterThan(0);
    }
  });

  it('RED PROOF 1: a MISSING Phase 3 operation kind is still caught', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`DELETE FROM inventory_operation_movement_kinds WHERE op_code = 'inventory.transfer'`);
      await c.query(`DELETE FROM inventory_operation_kinds WHERE op_code = 'inventory.transfer'`);
      await expect(assertMigrationState(c)).rejects.toThrow();
      await expect(assertS4MigrationState(c)).rejects.toThrow();
    });
  });

  it('RED PROOF 2: a MISSING Phase 3 stock source type is still caught', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`DELETE FROM inventory_operation_movement_kinds WHERE registered_by = 'P3-S5'`);
      await c.query(`DELETE FROM stock_source_types WHERE registered_by = 'P3-S5'`);
      await expect(assertMigrationState(c)).rejects.toThrow();
      await expect(assertS4MigrationState(c)).rejects.toThrow();
    });
  });

  it('RED PROOF 3: an EXTRA operation kind mislabelled with Phase 3 provenance is still caught', async () => {
    await inRolledBackTx(async (c) => {
      // `P3-S7` satisfies the accepted CHECK (`^P3-S[0-9]+$`), so this is the
      // exact shape a later phase would use to smuggle a row into scope.
      await c.query(`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.commit', 'P3-S7')`);
      await expect(assertMigrationState(c)).rejects.toThrow();
      await expect(assertS4MigrationState(c)).rejects.toThrow();
    });
  });

  it('RED PROOF 4: an EXTRA stock source type mislabelled with Phase 3 provenance is still caught', async () => {
    await inRolledBackTx(async (c) => {
      const cols = await c.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'stock_source_types' ORDER BY ordinal_position`,
      );
      // Insert naming only the columns that exist, so the proof does not depend
      // on the table's full shape.
      expect(cols.rows.map((x) => x.c)).toContain('source_type');
      expect(cols.rows.map((x) => x.c)).toContain('registered_by');
      await c.query(`INSERT INTO stock_source_types (source_type, registered_by) VALUES ('sale', 'P3-S7')`);
      await expect(assertMigrationState(c)).rejects.toThrow();
      await expect(assertS4MigrationState(c)).rejects.toThrow();
    });
  });

  it('and the database is untouched afterwards: both helpers are green again', async () => {
    await assertMigrationState();
    await assertS4MigrationState();
  });
});
