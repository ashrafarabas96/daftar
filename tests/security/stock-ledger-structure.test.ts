/**
 * P3-S2 — THE STOCK LEDGER'S STRUCTURAL INVARIANTS, AS THE SCHEMA OWNER
 * (docs/PHASE_3_S2_CONTRACT.md §6: T-01, T-13, T-14, T-15, T-20, and the
 * PM-44 live sweep — review finding M-2).
 *
 * Every refusal here is the DATABASE refusing a fact, not a credential being
 * declined: the cases run as the schema owner with raw SQL (H-1) or through
 * the fixture producer (H-2), inside transactions that are rolled back. Where
 * the refusal is deferred, the case says so and proves it at COMMIT — either
 * with a real COMMIT (which fails and takes the fixture with it) or with
 * `SET CONSTRAINTS ALL IMMEDIATE` — and never accepts "statement or commit".
 *
 * Every DENY group carries its negative control: the same probe with the
 * invariant removed inside a rolled-back savepoint must be ACCEPTED, so a
 * refusal that came from somewhere else would turn the control red.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  FIXTURE_OP,
  FIXTURE_SOURCE_TYPE,
  INTERNAL,
  SEEDED_KINDS,
  applyAsApp,
  applyOne,
  assertMigrationState,
  atCommit,
  attempt,
  expectAccepted,
  expectConstraint,
  expectRefused,
  fixtureDigest,
  installStockFixture,
  must,
  ownerClient,
  removeCommittedFixture,
  req,
  scratch,
  seedStockBusiness,
  setScope,
  settle,
  withRolledBackFixture,
  type Key,
  type Outcome,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

let biz: StockBusiness;
let K1: Key;
let K2: Key;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'struct');
  K1 = { warehouseId: biz.warehouse1, variantId: biz.piece.variantId };
  K2 = { warehouseId: biz.warehouse2, variantId: biz.piece.variantId };
});

const count = async (c: Queryable, sql: string, params: unknown[] = []): Promise<number> => must((await c.query<{ n: number }>(sql, params)).rows[0]).n;

/** The table an FK constraint points at, from pg_constraint. */
async function fkTarget(c: Queryable, table: string, conname: string): Promise<string> {
  const r = await c.query<{ t: string }>(
    `SELECT confrelid::regclass::text AS t FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2 AND contype = 'f'`,
    [table, conname],
  );
  return must(r.rows[0], `fk ${conname} on ${table}`).t;
}

/** The name of the one single-column CHECK on `table`.`column` (auto-generated names may be truncated at 63 bytes). */
async function checkOn(c: Queryable, table: string, column: string): Promise<string> {
  const r = await c.query<{ conname: string }>(
    `SELECT conname::text FROM pg_constraint k
     WHERE k.conrelid = $1::regclass AND k.contype = 'c'
       AND k.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)]::smallint[]`,
    [table, column],
  );
  expect(r.rows, `single-column CHECK on ${table}.${column}`).toHaveLength(1);
  return must(r.rows[0]).conname;
}

/** An empty cache row, owner-raw, so a raw movement's immediate level FK resolves. */
async function ownerLevel(c: Queryable, key: Key): Promise<void> {
  await c.query(
    `INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING`,
    [biz.tenantId, biz.businessId, key.warehouseId, key.variantId],
  );
}

interface RawMovement {
  key?: Key;
  sourceType?: string;
  sourceId?: string;
  sourceLineId?: string;
  kind?: string;
  seq?: number;
}

/** Owner-raw: one movement row and nothing else. */
async function ownerMovement(c: Queryable, m: RawMovement = {}): Promise<{ id: string; sourceId: string; sourceLineId: string }> {
  const id = randomUUID();
  const sourceId = m.sourceId ?? randomUUID();
  const sourceLineId = m.sourceLineId ?? randomUUID();
  const key = m.key ?? K1;
  await c.query(
    `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id,
                                  source_line_id, qty_delta, unit_cost_base_minor, value_delta_base_minor, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 1, 1, $11)`,
    [
      biz.tenantId,
      biz.businessId,
      id,
      key.warehouseId,
      key.variantId,
      m.seq ?? 1,
      m.kind ?? 'purchase',
      m.sourceType ?? FIXTURE_SOURCE_TYPE,
      sourceId,
      sourceLineId,
      biz.userId,
    ],
  );
  return { id, sourceId, sourceLineId };
}

async function ownerBinding(c: Queryable, sourceId: string, sourceLineId: string, kind = 'purchase', sourceType = FIXTURE_SOURCE_TYPE): Promise<void> {
  await c.query(
    `INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) VALUES ($1, $2, $3, $4, $5, $6)`,
    [biz.tenantId, biz.businessId, sourceType, sourceId, sourceLineId, kind],
  );
}

async function ownerLine(c: Queryable, sourceId: string, lineId: string, key: Key = K1): Promise<void> {
  await c.query(
    `INSERT INTO stock_fixture_lines (business_id, source_id, id, warehouse_id, variant_id, qty, unit_cost_base_minor) VALUES ($1, $2, $3, $4, $5, 1, 1)`,
    [biz.businessId, sourceId, lineId, key.warehouseId, key.variantId],
  );
}

async function ownerBridge(c: Queryable, sourceId: string, lineId: string, kind = 'purchase'): Promise<void> {
  await c.query(`INSERT INTO stock_source_bridge_fixture_line (business_id, source_id, source_line_id, movement_kind) VALUES ($1, $2, $3, $4)`, [
    biz.businessId,
    sourceId,
    lineId,
    kind,
  ]);
}

/**
 * A REAL COMMIT of a fixture transaction that must be refused at COMMIT. The
 * failed COMMIT rolls the fixture back with everything else (A-11). Should it
 * ever be accepted, the committed fixture is removed before the case fails,
 * so a regression cannot leak into the suites that follow.
 */
async function commitOutcome(setup: (c: Client) => Promise<void>): Promise<Outcome<null>> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await installStockFixture(c);
    await setScope(c, biz);
    await setup(c);
    const o = await settle(async () => {
      await c.query('COMMIT');
      return null;
    });
    if (o.ok) await removeCommittedFixture();
    return o;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

describe('the harness itself (§5 H-2)', () => {
  it('the hand-built fixture digest is byte-identical to the database invpl/1 canonicalizer', async () => {
    const nonce = randomUUID();
    const r = await ownerPool().query<{ d: string }>(`SELECT inventory_payload_digest($1, $2::uuid, $3::uuid, ARRAY['uuid'], ARRAY[$4]) AS d`, [
      FIXTURE_OP,
      biz.tenantId,
      biz.businessId,
      nonce,
    ]);
    expect(must(r.rows[0]).d).toBe(fixtureDigest(FIXTURE_OP, biz.tenantId, biz.businessId, nonce));
  });

  it('the fixture source type is fully guarded by the template: inventory_stock_source_guard_gaps() reports nothing', async () => {
    await withRolledBackFixture(async (c) => {
      expect((await c.query(`SELECT * FROM inventory_stock_source_guard_gaps()`)).rows).toEqual([]);
    });
  });

  it('the migration state carries no fixture before this suite and none after a rolled-back one', async () => {
    await assertMigrationState();
    await withRolledBackFixture(async () => undefined);
    await assertMigrationState();
  });
});

describe('T-01 — the ledger is append-only for every writer, the owner included (P:153)', () => {
  it('T-01.1 ALLOW: a fixture movement, its binding and its bridge row are accepted and survive the COMMIT-time checks', async () => {
    await withRolledBackFixture(async (c) => {
      const row = await applyOne(c, biz, req(K1, 'purchase', '5', { unitCost: '2' }));
      expect(row.stock_seq).toBe('1');
      expectAccepted(await atCommit(c), 'deferred checks');
      expect(await count(c, `SELECT count(*)::int AS n FROM stock_movements WHERE business_id = $1`, [biz.businessId])).toBe(1);
      expect(await count(c, `SELECT count(*)::int AS n FROM stock_source_bindings WHERE business_id = $1`, [biz.businessId])).toBe(1);
      expect(await count(c, `SELECT count(*)::int AS n FROM stock_source_bridge_fixture_line WHERE business_id = $1`, [biz.businessId])).toBe(1);
    });
  });

  /** A movement, its binding, a deficit and a coverage — one of each append-only row. */
  async function seedAll(c: Client): Promise<{ movementId: string; coverageId: string; deficitId: string; sourceId: string; lineId: string }> {
    const src = randomUUID();
    const line = randomUUID();
    const row = await applyOne(c, biz, req(K1, 'purchase', '5', { unitCost: '2', sourceId: src, sourceLineId: line }));
    const deficitId = randomUUID();
    await c.query(
      `INSERT INTO negative_inventory_deficits (tenant_id, business_id, id, warehouse_id, variant_id, source_stock_movement_id, deficit_seq,
                                                original_deficit_qty, uncovered_qty, provisional_unit_cost_base_minor, status)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 1, 0, 'open')`,
      [biz.tenantId, biz.businessId, deficitId, K1.warehouseId, K1.variantId, row.movement_id],
    );
    const coverageId = randomUUID();
    await c.query(
      `INSERT INTO negative_deficit_coverages (tenant_id, business_id, id, adjustment_id, deficit_id, variant_id, qty_covered,
                                               provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 0)`,
      [biz.tenantId, biz.businessId, coverageId, randomUUID(), deficitId, K1.variantId],
    );
    return { movementId: row.movement_id, coverageId, deficitId, sourceId: src, lineId: line };
  }

  async function columnsOf(c: Queryable, table: string): Promise<string[]> {
    const r = await c.query<{ a: string }>(
      `SELECT attname::text AS a FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
      [table],
    );
    return r.rows.map((x) => x.a);
  }

  it('T-01.2/T-01.3: as the owner, UPDATE of every stock_movements column and DELETE are refused with inventory.ledger_immutable', async () => {
    await withRolledBackFixture(async (c) => {
      const s = await seedAll(c);
      const cols = await columnsOf(c, 'stock_movements');
      expect(cols.length).toBeGreaterThanOrEqual(16);
      for (const col of cols) {
        expectRefused(
          await attempt(c, () => c.query(`UPDATE stock_movements SET ${col} = ${col} WHERE business_id = $1 AND id = $2`, [biz.businessId, s.movementId])),
          'P0001',
          'inventory.ledger_immutable',
          `UPDATE stock_movements.${col}`,
        );
      }
      expectRefused(
        await attempt(c, () => c.query(`DELETE FROM stock_movements WHERE business_id = $1 AND id = $2`, [biz.businessId, s.movementId])),
        'P0001',
        'inventory.ledger_immutable',
        'DELETE stock_movements',
      );
    });
  });

  it('T-01.4: bindings, coverages and the bridge refuse UPDATE/DELETE with inventory.ledger_immutable; a cache row refuses DELETE with inventory.stock_level_not_deletable', async () => {
    await withRolledBackFixture(async (c) => {
      const s = await seedAll(c);
      for (const col of await columnsOf(c, 'stock_source_bindings')) {
        expectRefused(
          await attempt(c, () =>
            c.query(`UPDATE stock_source_bindings SET ${col} = ${col} WHERE business_id = $1 AND source_id = $2`, [biz.businessId, s.sourceId]),
          ),
          'P0001',
          'inventory.ledger_immutable',
          `UPDATE stock_source_bindings.${col}`,
        );
      }
      expectRefused(
        await attempt(c, () => c.query(`DELETE FROM stock_source_bindings WHERE business_id = $1 AND source_id = $2`, [biz.businessId, s.sourceId])),
        'P0001',
        'inventory.ledger_immutable',
      );
      for (const col of await columnsOf(c, 'negative_deficit_coverages')) {
        expectRefused(
          await attempt(c, () =>
            c.query(`UPDATE negative_deficit_coverages SET ${col} = ${col} WHERE business_id = $1 AND id = $2`, [biz.businessId, s.coverageId]),
          ),
          'P0001',
          'inventory.ledger_immutable',
          `UPDATE negative_deficit_coverages.${col}`,
        );
      }
      expectRefused(
        await attempt(c, () => c.query(`DELETE FROM negative_deficit_coverages WHERE business_id = $1 AND id = $2`, [biz.businessId, s.coverageId])),
        'P0001',
        'inventory.ledger_immutable',
      );
      expectRefused(
        await attempt(c, () => c.query(`UPDATE stock_source_bridge_fixture_line SET movement_kind = movement_kind WHERE business_id = $1`, [biz.businessId])),
        'P0001',
        'inventory.ledger_immutable',
        'UPDATE bridge',
      );
      expectRefused(
        await attempt(c, () => c.query(`DELETE FROM stock_source_bridge_fixture_line WHERE business_id = $1`, [biz.businessId])),
        'P0001',
        'inventory.ledger_immutable',
        'DELETE bridge',
      );
      // The key with history, and a fresh key with none: the trigger, not a
      // foreign key, is what refuses — the fresh row has nothing pointing at it.
      expectRefused(
        await attempt(c, () => c.query(`DELETE FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2`, [biz.businessId, K1.warehouseId])),
        'P0001',
        'inventory.stock_level_not_deletable',
      );
      await ownerLevel(c, K2);
      expectRefused(
        await attempt(c, () => c.query(`DELETE FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2`, [biz.businessId, K2.warehouseId])),
        'P0001',
        'inventory.stock_level_not_deletable',
      );
    });
  });

  it('T-01.5: the same writes as daftar_app are refused by the ACL (42501) before any trigger is reached', async () => {
    await withRolledBackFixture(async (c) => {
      const s = await seedAll(c);
      await setScope(c, biz);
      const asApp = (sql: string, params: unknown[]) =>
        attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_app');
          return c.query(sql, params);
        });
      for (const [sql, params] of [
        [`UPDATE stock_movements SET reason = 'x' WHERE id = $1`, [s.movementId]],
        [`DELETE FROM stock_movements WHERE id = $1`, [s.movementId]],
        [`UPDATE stock_source_bindings SET source_id = source_id WHERE source_id = $1`, [s.sourceId]],
        [`DELETE FROM stock_source_bindings WHERE source_id = $1`, [s.sourceId]],
        [`UPDATE negative_deficit_coverages SET qty_covered = 2 WHERE id = $1`, [s.coverageId]],
        [`DELETE FROM negative_deficit_coverages WHERE id = $1`, [s.coverageId]],
        [`UPDATE stock_levels SET on_hand = 0 WHERE business_id = $1`, [biz.businessId]],
        [`DELETE FROM stock_levels WHERE business_id = $1`, [biz.businessId]],
      ] as const) {
        expectRefused(await asApp(sql, [...params]), '42501', null, sql);
      }
      // The writes were refused, not no-ops: every row is still there.
      expect(await count(c, `SELECT count(*)::int AS n FROM stock_movements WHERE id = $1`, [s.movementId])).toBe(1);
    });
  });

  it('T-01.6 NOTE: an owner TRUNCATE is NOT refused (E-24) — documented so no suite claims otherwise', async () => {
    await withRolledBackFixture(async (c) => {
      await seedAll(c);
      // TRUNCATE refuses while deferred checks are pending (55006), so they are
      // run first; they pass — the rows are complete.
      expectAccepted(await attempt(c, () => c.query('SET CONSTRAINTS ALL IMMEDIATE')), 'deferred checks');
      const o = await attempt(c, () =>
        c.query(
          `TRUNCATE stock_source_bridge_fixture_line, stock_source_bindings, negative_deficit_coverages, negative_inventory_deficits, stock_movements, stock_levels`,
        ),
      );
      expectAccepted(o, 'owner TRUNCATE');
      expect(await count(c, `SELECT count(*)::int AS n FROM stock_movements`)).toBe(0);
    });
  });

  it('T-01.N: with each append-only / retention trigger dropped in-transaction, the same UPDATE and DELETE go through', async () => {
    await withRolledBackFixture(async (c) => {
      const s = await seedAll(c);
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER stock_movements_append_only ON stock_movements`);
        const r = await c.query(`UPDATE stock_movements SET reason = 'rewritten' WHERE business_id = $1 AND id = $2`, [biz.businessId, s.movementId]);
        expect(r.rowCount).toBe(1);
      });
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER stock_source_bindings_append_only ON stock_source_bindings`);
        const r = await c.query(`UPDATE stock_source_bindings SET source_id = source_id WHERE business_id = $1 AND source_id = $2`, [
          biz.businessId,
          s.sourceId,
        ]);
        expect(r.rowCount).toBe(1);
      });
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER negative_deficit_coverages_append_only ON negative_deficit_coverages`);
        const r = await c.query(`DELETE FROM negative_deficit_coverages WHERE business_id = $1 AND id = $2`, [biz.businessId, s.coverageId]);
        expect(r.rowCount).toBe(1);
      });
      await scratch(c, async () => {
        await ownerLevel(c, K2);
        await c.query(`DROP TRIGGER stock_levels_retain ON stock_levels`);
        const r = await c.query(`DELETE FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2`, [biz.businessId, K2.warehouseId]);
        expect(r.rowCount).toBe(1);
      });
    });
  });
});

describe('T-13 — the closed source registry (P:165)', () => {
  it('T-13.1: an unregistered source_type string is refused by the foreign key AT THE STATEMENT, on the binding and on the movement', async () => {
    await withRolledBackFixture(
      async (c) => {
        await ownerLevel(c, K1);
        for (const bad of ['purchase ', 'Purchase', 'sale', FIXTURE_SOURCE_TYPE]) {
          const b = await attempt(c, () => ownerBinding(c, randomUUID(), randomUUID(), 'purchase', bad));
          const m = await attempt(c, () => ownerMovement(c, { sourceType: bad }));
          for (const o of [b, m]) {
            if (o.ok) throw new Error(`source_type ${JSON.stringify(bad)} was accepted`);
            expect(o.sqlstate, o.message).toBe('23503');
          }
          if (!b.ok) expect(await fkTarget(c, 'stock_source_bindings', must(b.constraint))).toBe('stock_source_types');
          if (!m.ok) expect(await fkTarget(c, 'stock_movements', must(m.constraint))).toBe('stock_source_types');
        }
      },
      { install: false },
    );
  });

  it('T-13.2: the registered fixture type is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(K1, 'purchase', '1', { unitCost: '1' }));
      expectAccepted(await atCommit(c));
    });
  });

  it('T-13.3: at the migration state the source registry and the op→kind mapping are empty, and the kinds are exactly the ten seeds', async () => {
    const r = await ownerPool().query<{ types: number; mapping: number }>(
      `SELECT (SELECT count(*)::int FROM stock_source_types) AS types, (SELECT count(*)::int FROM inventory_operation_movement_kinds) AS mapping`,
    );
    expect(r.rows[0]).toEqual({ types: 0, mapping: 0 });
    const k = await ownerPool().query<{ kind: string; qtySign: string; requiresReason: boolean; by: string }>(
      `SELECT movement_kind AS kind, qty_sign AS "qtySign", requires_reason AS "requiresReason", registered_by AS by FROM stock_movement_kinds ORDER BY movement_kind`,
    );
    expect(k.rows).toEqual(SEEDED_KINDS.map((x) => ({ ...x, by: 'P3-S2' })));
  });
});

describe('T-14 — source completeness: movement ⇄ binding → bridge → real line (P:166)', () => {
  it('T-14.1: a movement without its binding does not survive COMMIT (23503, stock_movements_binding_fk)', async () => {
    const o = await commitOutcome(async (c) => {
      await ownerLevel(c, K1);
      await ownerMovement(c);
    });
    expectConstraint(o, '23503', 'stock_movements_binding_fk');
    await assertMigrationState();
  });

  it('T-14.1 (statement): the same movement is ACCEPTED at the statement — the refusal is COMMIT-time, not earlier', async () => {
    await withRolledBackFixture(async (c) => {
      await ownerLevel(c, K1);
      expectAccepted(await attempt(c, () => ownerMovement(c)));
      expectConstraint(await atCommit(c), '23503', 'stock_movements_binding_fk');
    });
  });

  it('T-14.2: a binding without its movement does not survive COMMIT (23503, stock_source_bindings_movement_fk)', async () => {
    const o = await commitOutcome(async (c) => {
      const src = randomUUID();
      const line = randomUUID();
      await ownerLine(c, src, line);
      await ownerBinding(c, src, line);
      await ownerBridge(c, src, line);
    });
    expectConstraint(o, '23503', 'stock_source_bindings_movement_fk');
    await assertMigrationState();
  });

  it('T-14.3: a fixture call with p_bridge = false (movement + binding, no bridge row) does not survive COMMIT: inventory.stock_source_line_missing', async () => {
    const o = await commitOutcome(async (c) => {
      const rows = await applyAsApp(c, biz, [req(K1, 'purchase', '1', { unitCost: '1' })], { bridge: false });
      expect(rows).toHaveLength(1);
    });
    expectRefused(o, 'P0001', 'inventory.stock_source_line_missing');
    await assertMigrationState();
  });

  it('T-14.3: a movement + binding pair whose source line NEVER existed does not survive COMMIT: inventory.stock_source_line_missing', async () => {
    const o = await commitOutcome(async (c) => {
      await ownerLevel(c, K1);
      const m = await ownerMovement(c);
      await ownerBinding(c, m.sourceId, m.sourceLineId);
    });
    expectRefused(o, 'P0001', 'inventory.stock_source_line_missing');
    await assertMigrationState();
  });

  it('T-14.3: a bridge row naming a line that does not exist is refused by the bridge line FK at the statement (23503)', async () => {
    await withRolledBackFixture(async (c) => {
      await ownerLevel(c, K1);
      const m = await ownerMovement(c);
      await ownerBinding(c, m.sourceId, m.sourceLineId);
      expectConstraint(await attempt(c, () => ownerBridge(c, m.sourceId, m.sourceLineId)), '23503', 'bridge_fixture_line_line_fk');
    });
  });

  // §5 H-2 item 4 fixes the bridge's line FK as ON DELETE RESTRICT, which the
  // source-guard discovery requires (confdeltype 'r'). PostgreSQL 18 reports a
  // RESTRICT violation as 23001 (restrict_violation); PostgreSQL 16 and 17
  // report it as 23503, the same as NO ACTION. The expected code is derived from
  // the server that answered, never widened to "either".
  it('T-14.4: a bound source line cannot be deleted (RESTRICT on bridge_fixture_line_line_fk; 23001 from PostgreSQL 18, 23503 before)', async () => {
    await withRolledBackFixture(async (c) => {
      const src = randomUUID();
      const line = randomUUID();
      await applyOne(c, biz, req(K1, 'purchase', '1', { unitCost: '1', sourceId: src, sourceLineId: line }));
      const version = Number(must((await c.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0]).v);
      expectConstraint(
        await attempt(c, () => c.query(`DELETE FROM stock_fixture_lines WHERE business_id = $1 AND source_id = $2 AND id = $3`, [biz.businessId, src, line])),
        version >= 180000 ? '23001' : '23503',
        'bridge_fixture_line_line_fk',
      );
      // The line is not held by some other reference: an unbound line deletes.
      const free = randomUUID();
      await ownerLine(c, src, free);
      expectAccepted(await attempt(c, () => c.query(`DELETE FROM stock_fixture_lines WHERE business_id = $1 AND id = $2`, [biz.businessId, free])));
    });
  });

  it('T-14.5: a bound line’s quantity, cost, variant and warehouse are frozen (inventory.source_line_frozen); an unbound line is editable', async () => {
    await withRolledBackFixture(async (c) => {
      const src = randomUUID();
      const line = randomUUID();
      await applyOne(c, biz, req(K1, 'purchase', '1', { unitCost: '1', sourceId: src, sourceLineId: line }));
      for (const set of [`qty = qty + 1`, `unit_cost_base_minor = 9`, `variant_id = '${biz.dec2.variantId}'`, `warehouse_id = '${K2.warehouseId}'`]) {
        expectRefused(
          await attempt(c, () =>
            c.query(`UPDATE stock_fixture_lines SET ${set} WHERE business_id = $1 AND source_id = $2 AND id = $3`, [biz.businessId, src, line]),
          ),
          'P0001',
          'inventory.source_line_frozen',
          set,
        );
      }
      const free = randomUUID();
      await ownerLine(c, src, free);
      expectAccepted(await attempt(c, () => c.query(`UPDATE stock_fixture_lines SET qty = 7 WHERE business_id = $1 AND id = $2`, [biz.businessId, free])));
    });
  });

  it('T-14.6: registering a source type with no guards is refused by the registering migration’s end-state assertion (inventory.source_guard_missing)', async () => {
    const endState = `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
          RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks its bridge or binding guard';
        END IF;
      END $$`;
    await withRolledBackFixture(async (c) => {
      // Fully guarded: the end state passes.
      expectAccepted(await attempt(c, () => c.query(endState)));
      await c.query(`INSERT INTO stock_source_types (source_type, registered_by) VALUES ('fixture_orphan', 'P3-S2')`);
      const gaps = await c.query<{ source_type: string; missing: string }>(
        `SELECT source_type, missing FROM inventory_stock_source_guard_gaps() ORDER BY 1, 2`,
      );
      expect(gaps.rows.every((g) => g.source_type === 'fixture_orphan')).toBe(true);
      expect(gaps.rows.map((g) => g.missing)).toEqual(expect.arrayContaining(['binding_trigger', 'bridge']));
      expectRefused(await attempt(c, () => c.query(endState)), 'P0001', 'inventory.source_guard_missing');
    });
  });

  it('T-14.6: each missing guard of a registered type is discovered from the catalogue by name', async () => {
    await withRolledBackFixture(async (c) => {
      const gaps = async (): Promise<string[]> =>
        (
          await c.query<{ missing: string }>(`SELECT missing FROM inventory_stock_source_guard_gaps() WHERE source_type = $1 ORDER BY 1`, [FIXTURE_SOURCE_TYPE])
        ).rows.map((g) => g.missing);
      expect(await gaps()).toEqual([]);
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER stock_bridge_immutable_fixture_line ON stock_source_bridge_fixture_line`);
        expect(await gaps()).toEqual(['bridge_immutable']);
      });
      await scratch(c, async () => {
        await c.query(`ALTER TABLE stock_source_bridge_fixture_line DROP CONSTRAINT bridge_fixture_line_line_fk`);
        expect(await gaps()).toEqual(['bridge_line_fk']);
      });
      await scratch(c, async () => {
        await c.query(`ALTER TABLE stock_source_bridge_fixture_line DROP CONSTRAINT bridge_fixture_line_binding_fk`);
        expect(await gaps()).toEqual(['bridge_binding_fk']);
      });
      await scratch(c, async () => {
        await c.query(`ALTER FUNCTION stock_binding_requires_fixture_line() SECURITY INVOKER`);
        expect(await gaps()).toEqual(['binding_trigger']);
      });
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER stock_binding_requires_fixture_line ON stock_source_bindings`);
        expect(await gaps()).toEqual(['binding_trigger']);
      });
    });
  });

  it('T-14.N: with the binding-side trigger replaced by a SOURCE-side one, the fake pair with no source line COMMITS — the source-side trigger never fires', async () => {
    await withRolledBackFixture(async (c) => {
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER stock_binding_requires_fixture_line ON stock_source_bindings`);
        await c.query(`
          CREATE FUNCTION pg_temp.fixture_line_requires_bridge() RETURNS trigger LANGUAGE plpgsql AS $fx$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_fixture_line b WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id AND b.source_line_id = NEW.id) THEN
              RAISE EXCEPTION 'inventory.stock_source_line_missing: source-side check' USING ERRCODE = 'P0001';
            END IF;
            RETURN NULL;
          END $fx$`);
        await c.query(`CREATE CONSTRAINT TRIGGER fixture_line_requires_bridge AFTER INSERT OR UPDATE ON stock_fixture_lines
                       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.fixture_line_requires_bridge()`);
        await ownerLevel(c, K1);
        const m = await ownerMovement(c);
        await ownerBinding(c, m.sourceId, m.sourceLineId);
        expectAccepted(await atCommit(c), 'the fake pair passes every deferred check once the binding-side trigger is gone');
      });
      // And with the real binding-side trigger in place, the identical pair is refused.
      await ownerLevel(c, K1);
      const m = await ownerMovement(c);
      await ownerBinding(c, m.sourceId, m.sourceLineId);
      expectRefused(await atCommit(c), 'P0001', 'inventory.stock_source_line_missing');
    });
  });
});

describe('T-15 — binding cardinality: movement-grained (P:167)', () => {
  it('T-15.1: one transfer line carries two bindings (transfer_out, transfer_in) and both directional FKs resolve', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(K1, 'purchase', '5', { unitCost: '3' }));
      const src = randomUUID();
      const line = randomUUID();
      const rows = await applyAsApp(c, biz, [
        req(K1, 'transfer_out', '-2', { sourceId: src, sourceLineId: line }),
        req(K2, 'transfer_in', '2', { sourceId: src, sourceLineId: line }),
      ]);
      expect(rows.map((r) => r.movement_kind)).toEqual(['transfer_out', 'transfer_in']);
      expectAccepted(await atCommit(c));
      const b = await c.query<{ kind: string }>(
        `SELECT movement_kind AS kind FROM stock_source_bindings WHERE business_id = $1 AND source_id = $2 AND source_line_id = $3 ORDER BY 1`,
        [biz.businessId, src, line],
      );
      expect(b.rows.map((x) => x.kind)).toEqual(['transfer_in', 'transfer_out']);
      expect(
        await count(
          c,
          `SELECT count(*)::int AS n FROM stock_movements m JOIN stock_source_bindings b USING (business_id, source_type, source_id, source_line_id, movement_kind)
           WHERE m.business_id = $1 AND m.source_id = $2`,
          [biz.businessId, src],
        ),
      ).toBe(2);
      expect(
        await count(c, `SELECT count(*)::int AS n FROM stock_source_bridge_fixture_line WHERE business_id = $1 AND source_id = $2 AND source_line_id = $3`, [
          biz.businessId,
          src,
          line,
        ]),
      ).toBe(2);
    });
  });

  it('T-15.2: a third binding for the same line and kind is refused (23505); so is a third movement', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(K1, 'purchase', '5', { unitCost: '3' }));
      const src = randomUUID();
      const line = randomUUID();
      await applyAsApp(c, biz, [
        req(K1, 'transfer_out', '-2', { sourceId: src, sourceLineId: line }),
        req(K2, 'transfer_in', '2', { sourceId: src, sourceLineId: line }),
      ]);
      expectConstraint(await attempt(c, () => ownerBinding(c, src, line, 'transfer_out')), '23505', 'stock_source_bindings_pkey');
      expectConstraint(
        await attempt(c, () => ownerMovement(c, { sourceId: src, sourceLineId: line, kind: 'transfer_out', seq: 99 })),
        '23505',
        'stock_movements_identity_uq',
      );
      // Negative control: without the binding key, the third binding is accepted.
      await scratch(c, async () => {
        // ALTER TABLE refuses while deferred checks are pending; they pass, so run them first.
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query(`ALTER TABLE stock_source_bindings DROP CONSTRAINT stock_source_bindings_pkey CASCADE`);
        expectAccepted(await attempt(c, () => ownerBinding(c, src, line, 'transfer_out')));
      });
    });
  });

  it('T-15.3: pg_constraint shows both FKs over the five-part key, DEFERRABLE INITIALLY DEFERRED, and the identity UNIQUE is immediate', async () => {
    const r = await ownerPool().query<{ conname: string; from: string; to: string; cols: string[]; deferrable: boolean; deferred: boolean }>(
      `SELECT conname, conrelid::regclass::text AS from, confrelid::regclass::text AS to,
              ARRAY(SELECT a.attname::text FROM unnest(conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
              condeferrable AS deferrable, condeferred AS deferred
       FROM pg_constraint WHERE conname IN ('stock_movements_binding_fk', 'stock_source_bindings_movement_fk') ORDER BY conname`,
    );
    const five = ['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind'];
    expect(r.rows).toEqual([
      { conname: 'stock_movements_binding_fk', from: 'stock_movements', to: 'stock_source_bindings', cols: five, deferrable: true, deferred: true },
      { conname: 'stock_source_bindings_movement_fk', from: 'stock_source_bindings', to: 'stock_movements', cols: five, deferrable: true, deferred: true },
    ]);
    const u = await ownerPool().query<{ contype: string; deferrable: boolean; n: number }>(
      `SELECT contype::text, condeferrable AS deferrable, cardinality(conkey)::int AS n FROM pg_constraint WHERE conname = 'stock_movements_identity_uq'`,
    );
    expect(u.rows).toEqual([{ contype: 'u', deferrable: false, n: 5 }]);
  });
});

describe('T-20 — deficit and coverage entities, ordering only', () => {
  async function movementOnK1(c: Client): Promise<string> {
    return (await applyOne(c, biz, req(K1, 'purchase', '5', { unitCost: '1' }))).movement_id;
  }

  const deficit = (
    c: Queryable,
    movementId: string,
    v: { seq?: number; original?: string; uncovered?: string; status?: string; provisional?: string; id?: string },
  ) =>
    c.query(
      `INSERT INTO negative_inventory_deficits (tenant_id, business_id, id, warehouse_id, variant_id, source_stock_movement_id, deficit_seq,
                                                original_deficit_qty, uncovered_qty, provisional_unit_cost_base_minor, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11)`,
      [
        biz.tenantId,
        biz.businessId,
        v.id ?? randomUUID(),
        K1.warehouseId,
        K1.variantId,
        movementId,
        v.seq ?? 1,
        v.original ?? '2',
        v.uncovered ?? v.original ?? '2',
        v.provisional ?? '0',
        v.status ?? 'open',
      ],
    );

  it('T-20.1: the deficit CHECKs refuse every inconsistent row (23514), and a consistent row in each status is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      const m = await movementOnK1(c);
      const only = async (v: Parameters<typeof deficit>[2], names: string[]) => {
        const o = await attempt(c, () => deficit(c, m, v));
        if (o.ok) throw new Error(`accepted: ${JSON.stringify(v)}`);
        expect(o.sqlstate, o.message).toBe('23514');
        expect(names, `${JSON.stringify(v)} violated ${String(o.constraint)}`).toContain(o.constraint);
      };
      await only({ original: '0', uncovered: '0', status: 'closed' }, ['negative_inventory_deficits_original_ck']);
      await only({ original: '-1', uncovered: '0', status: 'closed' }, ['negative_inventory_deficits_original_ck', 'negative_inventory_deficits_uncovered_ck']);
      await only({ original: '2', uncovered: '-1', status: 'open' }, ['negative_inventory_deficits_uncovered_ck', 'negative_inventory_deficits_status_ck']);
      await only({ original: '1', uncovered: '2', status: 'partially_covered' }, [
        'negative_inventory_deficits_uncovered_ck',
        'negative_inventory_deficits_status_ck',
      ]);
      await only({ original: '2', uncovered: '1', status: 'open' }, ['negative_inventory_deficits_status_ck']);
      await only({ original: '2', uncovered: '1', status: 'closed' }, ['negative_inventory_deficits_status_ck']);
      await only({ original: '2', uncovered: '2', status: 'partially_covered' }, ['negative_inventory_deficits_status_ck']);
      await only({ original: '2', uncovered: '0', status: 'partially_covered' }, ['negative_inventory_deficits_status_ck']);
      await only({ original: '2', status: 'unknown' }, [await checkOn(c, 'negative_inventory_deficits', 'status'), 'negative_inventory_deficits_status_ck']);
      await only({ seq: 0 }, [await checkOn(c, 'negative_inventory_deficits', 'deficit_seq')]);
      await only({ provisional: '-0.0000000001' }, [await checkOn(c, 'negative_inventory_deficits', 'provisional_unit_cost_base_minor')]);
      expectAccepted(await attempt(c, () => deficit(c, m, { seq: 1, original: '2', uncovered: '2', status: 'open' })));
      expectAccepted(await attempt(c, () => deficit(c, m, { seq: 2, original: '2', uncovered: '1', status: 'partially_covered' })));
      expectAccepted(await attempt(c, () => deficit(c, m, { seq: 3, original: '2', uncovered: '0', status: 'closed' })));
    });
  });

  it('T-20.1.N: with the status CHECK dropped in-transaction, an open deficit whose uncovered quantity differs is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      const m = await movementOnK1(c);
      await scratch(c, async () => {
        await c.query(`ALTER TABLE negative_inventory_deficits DROP CONSTRAINT negative_inventory_deficits_status_ck`);
        expectAccepted(await attempt(c, () => deficit(c, m, { original: '2', uncovered: '1', status: 'open' })));
      });
    });
  });

  it('T-20.2: a duplicate deficit_seq on one key is refused (23505); with the UNIQUE dropped in-transaction it is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      const m = await movementOnK1(c);
      await deficit(c, m, { seq: 1 });
      expectConstraint(await attempt(c, () => deficit(c, m, { seq: 1 })), '23505', 'negative_inventory_deficits_seq_uq');
      await scratch(c, async () => {
        await c.query(`ALTER TABLE negative_inventory_deficits DROP CONSTRAINT negative_inventory_deficits_seq_uq`);
        expectAccepted(await attempt(c, () => deficit(c, m, { seq: 1 })));
      });
    });
  });

  it('T-20.3: deficits with equal created_at read back deterministically by (deficit_seq, id); R4 answers max + 1 under the key lock', async () => {
    await withRolledBackFixture(async (c) => {
      const m = await movementOnK1(c);
      // Inserted out of order, in one transaction: created_at is equal for both.
      await deficit(c, m, { seq: 2, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
      await deficit(c, m, { seq: 1, id: '00000000-0000-4000-8000-000000000000' });
      const r = await c.query<{ seq: string; same: boolean }>(
        `SELECT deficit_seq::text AS seq, created_at = min(created_at) OVER () AS same FROM negative_inventory_deficits
         WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 ORDER BY deficit_seq, id`,
        [biz.businessId, K1.warehouseId, K1.variantId],
      );
      expect(r.rows).toEqual([
        { seq: '1', same: true },
        { seq: '2', same: true },
      ]);
      await setScope(c, biz);
      const next = await c.query<{ n: string }>(`SELECT inventory_next_deficit_seq($1, $2, $3)::text AS n`, [biz.businessId, K1.warehouseId, K1.variantId]);
      expect(must(next.rows[0]).n).toBe('3');
      // It wrote nothing.
      expect(await count(c, `SELECT count(*)::int AS n FROM negative_inventory_deficits WHERE business_id = $1`, [biz.businessId])).toBe(2);
      // A key with no cache row, and a key outside the scope.
      expectRefused(
        await attempt(c, () => c.query(`SELECT inventory_next_deficit_seq($1, $2, $3)`, [biz.businessId, K2.warehouseId, K2.variantId])),
        'P0001',
        'inventory.stock_key_missing',
      );
      expectRefused(
        await attempt(c, () =>
          c.query(`SELECT inventory_next_deficit_seq($1, $2, $3)`, [biz.other.businessId, biz.other.warehouseId, biz.other.piece.variantId]),
        ),
        'P0001',
        'inventory.scope_mismatch',
      );
    });
  });

  it('T-20.4: a coverage with qty_covered <= 0 or a negative cost is refused (23514)', async () => {
    await withRolledBackFixture(async (c) => {
      const m = await movementOnK1(c);
      const d = randomUUID();
      await deficit(c, m, { id: d });
      const coverage = (qty: string, prov = '0', actual = '0') =>
        attempt(c, () =>
          c.query(
            `INSERT INTO negative_deficit_coverages (tenant_id, business_id, adjustment_id, deficit_id, variant_id, qty_covered,
                                                     provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric)`,
            [biz.tenantId, biz.businessId, randomUUID(), d, K1.variantId, qty, prov, actual],
          ),
        );
      for (const [q, p, a] of [
        ['0', '0', '0'],
        ['-1', '0', '0'],
        ['1', '-1', '0'],
        ['1', '0', '-1'],
      ] as const) {
        expectRefused(await coverage(q, p, a), '23514', null, `coverage ${q} ${p} ${a}`);
      }
      expectAccepted(await coverage('1'));
      // Negative control: with the CHECK dropped, a zero coverage is accepted.
      await scratch(c, async () => {
        await c.query(`ALTER TABLE negative_deficit_coverages DROP CONSTRAINT ${await checkOn(c, 'negative_deficit_coverages', 'qty_covered')}`);
        expectAccepted(await coverage('0'));
      });
    });
  });
});

describe('PM-44 (M-2) — the live writer sweep over pg_proc', () => {
  const STOCK_DML =
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(stock_movements|stock_levels|stock_source_bindings|negative_inventory_deficits|negative_deficit_coverages)\b/i;
  const FIRST_IS_ASSERTION = /^(?:\w+\s*:=\s*|PERFORM\s+)inventory_assertion_(?:consume|current)\(/i;

  /** Every internal-owned routine that writes a stock table, and whether its first statement is the assertion. */
  async function writers(q: Queryable): Promise<{ fn: string; assertedFirst: boolean }[]> {
    const r = await q.query<{ fn: string; src: string }>(
      `SELECT p.oid::regprocedure::text AS fn, p.prosrc AS src FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname = $1 ORDER BY 1`,
      [INTERNAL],
    );
    return r.rows
      .map((x) => ({ fn: x.fn, src: x.src.replace(/--[^\n]*/g, '') }))
      .filter((x) => STOCK_DML.test(x.src))
      .map((x) => {
        const at = /\bBEGIN\b/i.exec(x.src);
        const body = at ? x.src.slice(at.index + at[0].length).trimStart() : '';
        return { fn: x.fn, assertedFirst: FIRST_IS_ASSERTION.test(body) };
      });
  }

  it('the only internal-owned stock writer is R3, and its first statement is inventory_assertion_current(', async () => {
    expect(await writers(ownerPool())).toEqual([{ fn: 'inventory_apply_stock_movements(inventory_movement_request[])', assertedFirst: true }]);
  });

  it('control: an internal-owned writer without the assertion, or with it after the write, is flagged', async () => {
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE FUNCTION pm44_violator_a() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
                     AS $f$ BEGIN UPDATE stock_levels SET on_hand = on_hand WHERE false; END $f$`);
      await c.query(`CREATE FUNCTION pm44_violator_b() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
                     AS $f$ BEGIN INSERT INTO negative_deficit_coverages SELECT * FROM negative_deficit_coverages WHERE false;
                     PERFORM inventory_assertion_current(ARRAY['x']); END $f$`);
      await c.query(`ALTER FUNCTION pm44_violator_a() OWNER TO ${INTERNAL}`);
      await c.query(`ALTER FUNCTION pm44_violator_b() OWNER TO ${INTERNAL}`);
      expect(await writers(c)).toEqual([
        { fn: 'inventory_apply_stock_movements(inventory_movement_request[])', assertedFirst: true },
        { fn: 'pm44_violator_a()', assertedFirst: false },
        { fn: 'pm44_violator_b()', assertedFirst: false },
      ]);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
});

it('leaves the registries in the migration state', async () => {
  await assertMigrationState();
});
