/**
 * P3-S2 — WHO MAY TOUCH THE STOCK LEDGER (docs/PHASE_3_S2_CONTRACT.md §6:
 * T-02, T-16, T-18 and the §2.4 trigger catalogue; the PM-44 live sweep
 * lives in stock-ledger-structure.test.ts).
 *
 * Every claim is read from the LIVE catalogue (`has_*_privilege`,
 * `pg_has_role`, `pg_proc`, `pg_trigger`) and then exercised with a real
 * statement on a real connection of the role in question, so a grant that
 * the catalogue query missed still turns a case red. Every DENY group has a
 * negative control that re-opens the hole inside a rolled-back transaction
 * and shows the checker or the probe going red.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  FIXTURE_OP,
  INTERNAL,
  RUNTIME_ROLES,
  S2_RELATIONS,
  S2_ROUTINES,
  applyOne,
  assertMigrationState,
  attempt,
  expectAccepted,
  expectConstraint,
  expectRefused,
  mintFixtureAssertion,
  must,
  ownerClient,
  req,
  requestsJson,
  requestsParam,
  roleClient,
  scratch,
  seedStockBusiness,
  setScope,
  settle,
  tryApply,
  withRolledBackFixture,
  withoutRefusal,
  type Key,
  type MovementRequest,
  type MovementRow,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

let biz: StockBusiness;
let K1: Key;
let KB: Key;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'auth');
  K1 = { warehouseId: biz.warehouse1, variantId: biz.piece.variantId };
  KB = { warehouseId: biz.other.warehouseId, variantId: biz.other.piece.variantId };
});

afterAll(async () => {
  await assertMigrationState();
});

const ROLES_AND_PUBLIC = [...RUNTIME_ROLES.map((r) => r.role), 'public'];
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const COLUMN_PRIVS = ['INSERT', 'UPDATE', 'REFERENCES'] as const;
const APP_READABLE = new Set(['stock_movements', 'stock_levels']);
const PINNED = ['search_path=pg_catalog, public, pg_temp'];

/**
 * THE CHECKER (T-02.1): every deviation of the live runtime matrix from the
 * contract, as `<role> <privilege> <relation>` strings. Empty means exact.
 */
async function runtimeMatrixDeviations(q: Queryable): Promise<string[]> {
  const r = await q.query<{ role: string; rel: string; priv: string; level: string; held: boolean }>(
    `SELECT role, rel, priv, 'table' AS level, has_table_privilege(role, rel, priv) AS held
       FROM unnest($1::text[]) role, unnest($2::text[]) rel, unnest($3::text[] || ARRAY['SELECT']) priv
     UNION ALL
     SELECT role, rel, priv, 'column', has_any_column_privilege(role, rel, priv)
       FROM unnest($1::text[]) role, unnest($2::text[]) rel, unnest($4::text[] || ARRAY['SELECT']) priv`,
    [ROLES_AND_PUBLIC, [...S2_RELATIONS], [...WRITE_PRIVS], [...COLUMN_PRIVS]],
  );
  const out: string[] = [];
  for (const x of r.rows) {
    const expected = x.priv === 'SELECT' && x.role === 'daftar_app' && APP_READABLE.has(x.rel);
    if (x.held !== expected) out.push(`${x.role} ${x.priv}${x.level === 'column' ? '(column)' : ''} ${x.rel}${expected ? ' MISSING' : ''}`);
  }
  return out.sort();
}

/** The A-01 set, exactly: table-level privileges and the four UPDATE columns. */
const A01: Record<string, readonly string[]> = {
  stock_movements: ['INSERT', 'SELECT'],
  stock_levels: ['INSERT', 'SELECT'],
  stock_source_bindings: ['INSERT'],
  stock_movement_kinds: ['SELECT'],
  inventory_operation_movement_kinds: ['SELECT'],
  negative_inventory_deficits: ['SELECT'],
  negative_deficit_coverages: [],
  stock_source_types: [],
};
const A01_UPDATE_COLUMNS = ['avg_unit_cost_base_minor', 'last_stock_seq', 'on_hand', 'valuation_base_minor'];

async function internalDeviations(q: Queryable): Promise<string[]> {
  const r = await q.query<{ rel: string; priv: string; held: boolean }>(
    `SELECT rel, priv, has_table_privilege($1, rel, priv) AS held
       FROM unnest($2::text[]) rel, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) priv`,
    [INTERNAL, [...S2_RELATIONS]],
  );
  const out: string[] = [];
  for (const x of r.rows) {
    const expected = (A01[x.rel] ?? []).includes(x.priv);
    if (x.held !== expected) out.push(`${INTERNAL} ${x.priv} ${x.rel}${expected ? ' MISSING' : ''}`);
  }
  const cols = await q.query<{ rel: string; col: string; held: boolean }>(
    `SELECT c.relname::text AS rel, a.attname::text AS col, has_column_privilege($1, c.oid, a.attnum, 'UPDATE') AS held
       FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($2::text[])`,
    [INTERNAL, [...S2_RELATIONS]],
  );
  for (const x of cols.rows) {
    const expected = x.rel === 'stock_levels' && A01_UPDATE_COLUMNS.includes(x.col);
    if (x.held !== expected) out.push(`${INTERNAL} UPDATE(${x.col}) ${x.rel}${expected ? ' MISSING' : ''}`);
  }
  return out.sort();
}

/** The 0059 / 0060 end-state blocks, as committed in the migration files. */
function endStateBlock(file: string): string {
  const sql = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations', file), 'utf8');
  const start = sql.lastIndexOf('\nDO $$');
  const end = sql.indexOf('END $$;', start);
  if (start < 0 || end < 0) throw new Error(`no end-state block in ${file}`);
  return sql.slice(start + 1, end + 'END $$;'.length);
}

describe('T-02 — the live grant matrix (P:154)', () => {
  it('T-02.1: the S2 relations discovered from pg_class are exactly the eight the contract names', async () => {
    const r = await ownerPool().query<{ relname: string }>(
      `SELECT relname::text FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (relname LIKE 'stock\\_%' OR relname LIKE 'negative\\_%' OR relname = 'inventory_operation_movement_kinds')
        ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([...S2_RELATIONS]);
  });

  it('T-02.1: for every runtime role and PUBLIC, every write privilege (table and column level) is absent; daftar_app reads exactly stock_movements and stock_levels', async () => {
    expect(await runtimeMatrixDeviations(ownerPool())).toEqual([]);
  });

  it('T-02.1: real DML on every S2 relation from every runtime credential is refused by the ACL (42501); SELECT only where granted', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      const c = await roleClient(url);
      try {
        for (const rel of S2_RELATIONS) {
          const col = must(
            (await ownerPool().query<{ a: string }>(`SELECT attname::text AS a FROM pg_attribute WHERE attrelid = $1::regclass AND attnum = 1`, [rel])).rows[0],
          ).a;
          for (const sql of [
            `INSERT INTO ${rel} DEFAULT VALUES`,
            `UPDATE ${rel} SET ${col} = ${col} WHERE false`,
            `DELETE FROM ${rel} WHERE false`,
            `TRUNCATE ${rel}`,
          ]) {
            expectRefused(await settle(() => c.query(sql)), '42501', null, `${role}: ${sql}`);
          }
          const read = await settle(() => c.query(`SELECT count(*) FROM ${rel}`));
          if (role === 'daftar_app' && APP_READABLE.has(rel)) expectAccepted(read, `${role} reads ${rel}`);
          else expectRefused(read, '42501', null, `${role}: SELECT ${rel}`);
        }
      } finally {
        await c.end();
      }
    }
  });

  it('T-02.2: EXECUTE on R1–R9 is false for every runtime role and PUBLIC, and a real call from each runtime credential is refused (42501)', async () => {
    const r = await ownerPool().query<{ role: string; fn: string }>(
      `SELECT role, fn FROM unnest($1::text[]) role, unnest($2::text[]) fn WHERE has_function_privilege(role, fn::regprocedure, 'EXECUTE')`,
      [ROLES_AND_PUBLIC, [...S2_ROUTINES]],
    );
    expect(r.rows).toEqual([]);
    const calls = [
      `SELECT inventory_half_even(1, 2, 0)`,
      `SELECT inventory_quantity_is_representable(1, 0::smallint)`,
      `SELECT * FROM inventory_apply_stock_movements(NULL::inventory_movement_request[])`,
      `SELECT inventory_next_deficit_seq(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      `SELECT * FROM inventory_stock_fold(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      `SELECT * FROM inventory_stock_verify(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    ];
    for (const { role, url } of RUNTIME_ROLES) {
      const c = await roleClient(url);
      try {
        for (const sql of calls) expectRefused(await settle(() => c.query(sql)), '42501', null, `${role}: ${sql}`);
      } finally {
        await c.end();
      }
    }
  });

  it('T-02.4: no runtime role is a member of the internal role, directly or transitively, with any option', async () => {
    const r = await ownerPool().query<{ role: string; opt: string }>(
      `SELECT role, opt FROM unnest($1::text[]) role, unnest(ARRAY['MEMBER', 'USAGE', 'SET']) opt WHERE pg_has_role(role, $2, opt)`,
      [RUNTIME_ROLES.map((x) => x.role), INTERNAL],
    );
    expect(r.rows).toEqual([]);
    for (const { role, url } of RUNTIME_ROLES) {
      const c = await roleClient(url);
      try {
        expectRefused(await settle(() => c.query(`SET ROLE ${INTERNAL}`)), '42501', null, `${role}: SET ROLE internal`);
      } finally {
        await c.end();
      }
    }
  });

  it('T-02.5: every internal-owned S2 routine is DEFINER with the pinned path and no PUBLIC EXECUTE; its owner cannot log in; the 0059 trigger/discovery functions are non-internal INVOKER, pinned, not PUBLIC', async () => {
    const internal = await ownerPool().query<{ fn: string; owner: string; secdef: boolean; config: string[] | null; pub: boolean; login: boolean }>(
      `SELECT p.oid::regprocedure::text AS fn, r.rolname::text AS owner, p.prosecdef AS secdef, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub, r.rolcanlogin AS login
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = ANY ($1::text[]::regprocedure[]) ORDER BY 1`,
      [[...S2_ROUTINES, 'inventory_configure_product(uuid,boolean,text,smallint)']],
    );
    expect(internal.rows).toHaveLength(10);
    for (const x of internal.rows) {
      expect({ fn: x.fn, owner: x.owner, secdef: x.secdef, config: x.config, pub: x.pub, login: x.login }).toEqual({
        fn: x.fn,
        owner: INTERNAL,
        secdef: true,
        config: PINNED,
        pub: false,
        login: false,
      });
    }
    const migrator = await ownerPool().query<{ fn: string; owner: string; secdef: boolean; config: string[] | null; pub: boolean }>(
      `SELECT p.oid::regprocedure::text AS fn, r.rolname::text AS owner, p.prosecdef AS secdef, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = ANY (ARRAY['stock_ledger_append_only()', 'stock_levels_retain()', 'inventory_stock_source_guard_gaps()']::regprocedure[]) ORDER BY 1`,
    );
    expect(migrator.rows).toHaveLength(3);
    for (const x of migrator.rows) {
      expect(x.owner, x.fn).not.toBe(INTERNAL);
      expect(
        RUNTIME_ROLES.map((y) => y.role),
        x.fn,
      ).not.toContain(x.owner);
      expect({ secdef: x.secdef, config: x.config, pub: x.pub }, x.fn).toEqual({ secdef: false, config: PINNED, pub: false });
    }
  });

  it('T-02.5: the internal role holds exactly the A-01 set (no DELETE/TRUNCATE anywhere, UPDATE of exactly four cache columns) and no CREATE on public', async () => {
    expect(await internalDeviations(ownerPool())).toEqual([]);
    const r = await ownerPool().query<{ create: boolean; login: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS create, rolcanlogin AS login FROM pg_roles WHERE rolname = $1`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([{ create: false, login: false }]);
  });

  it('T-02.N: an in-transaction GRANT INSERT ON stock_levels TO daftar_app is reported by the checker, the 0059 end-state block refuses it, and the grant really writes', async () => {
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      expect(await runtimeMatrixDeviations(c)).toEqual([]);
      expectAccepted(await attempt(c, () => c.query(endStateBlock('0059_inventory_stock_ledger.sql'))), '0059-E at the migration state');
      await c.query('GRANT INSERT ON stock_levels TO daftar_app');
      expect(await runtimeMatrixDeviations(c)).toEqual(['daftar_app INSERT stock_levels', 'daftar_app INSERT(column) stock_levels']);
      expectRefused(await attempt(c, () => c.query(endStateBlock('0059_inventory_stock_ledger.sql'))), 'P0001', 'inventory.authority_leak', '0059-E');
      // The reported leak is a real write path: daftar_app, in scope, inserts a cache row.
      await setScope(c, biz);
      const w = await attempt(c, async () => {
        await c.query('SET LOCAL ROLE daftar_app');
        return c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
          biz.tenantId,
          biz.businessId,
          K1.warehouseId,
          K1.variantId,
        ]);
      });
      expectAccepted(w, 'the leaked grant writes');
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  it('T-02.N: an in-transaction extra grant to the internal role (DELETE on stock_movements) is reported by the A-01 checker', async () => {
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await c.query(`GRANT DELETE ON stock_movements TO ${INTERNAL}`);
      await c.query(`GRANT UPDATE (tenant_id) ON stock_levels TO ${INTERNAL}`);
      expect(await internalDeviations(c)).toEqual([`${INTERNAL} DELETE stock_movements`, `${INTERNAL} UPDATE(tenant_id) stock_levels`]);
      expectRefused(await attempt(c, () => c.query(endStateBlock('0059_inventory_stock_ledger.sql'))), 'P0001', 'inventory.authority_leak', '0059-E');
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
});

describe('T-02.3 / T-18 — tenant and business isolation', () => {
  /** Movements in business A and in business B, in the caller's transaction. */
  async function twoBusinesses(c: Client): Promise<void> {
    await applyOne(c, biz, req(K1, 'purchase', '4', { unitCost: '2' }));
    await applyOne(
      c,
      { tenantId: biz.other.tenantId, businessId: biz.other.businessId, userId: biz.other.userId },
      req(KB, 'purchase', '7', { unitCost: '3' }),
    );
  }

  async function asAppSees(c: Client, scope: { tenantId: string; businessId: string }, rel: string, gucs: Record<string, string> = {}): Promise<string[]> {
    await setScope(c, scope);
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    await c.query('SET LOCAL ROLE daftar_app');
    const r = await c.query<{ b: string }>(`SELECT DISTINCT business_id::text AS b FROM ${rel} ORDER BY 1`);
    await c.query('RESET ROLE');
    return r.rows.map((x) => x.b);
  }

  it('T-02.3 / T-18.1: daftar_app scoped to A reads only A’s movements and cache rows; scoped to B only B’s; a split scope reads nothing', async () => {
    await withRolledBackFixture(async (c) => {
      await twoBusinesses(c);
      const A = { tenantId: biz.tenantId, businessId: biz.businessId };
      const B = { tenantId: biz.other.tenantId, businessId: biz.other.businessId };
      for (const rel of ['stock_movements', 'stock_levels']) {
        expect(await asAppSees(c, A, rel)).toEqual([biz.businessId]);
        expect(await asAppSees(c, B, rel)).toEqual([biz.other.businessId]);
        expect(await asAppSees(c, { tenantId: biz.tenantId, businessId: biz.other.businessId }, rel)).toEqual([]);
        expect(await asAppSees(c, { tenantId: '', businessId: '' }, rel)).toEqual([]);
      }
    });
  });

  it('T-18.2: app.bypass_rls = true (and every look-alike GUC) does not widen daftar_app’s read', async () => {
    await withRolledBackFixture(async (c) => {
      await twoBusinesses(c);
      const A = { tenantId: biz.tenantId, businessId: biz.businessId };
      for (const rel of ['stock_movements', 'stock_levels']) {
        expect(await asAppSees(c, A, rel, { 'app.bypass_rls': 'true', 'app.bypass': 'true', 'app.role': 'daftar_platform' })).toEqual([biz.businessId]);
      }
    });
  });

  it('T-18.1.N: with row security disabled on the table in-transaction, the same read as A sees B — the policy is what isolates', async () => {
    await withRolledBackFixture(async (c) => {
      await twoBusinesses(c);
      const A = { tenantId: biz.tenantId, businessId: biz.businessId };
      for (const rel of ['stock_movements', 'stock_levels']) {
        await scratch(c, async () => {
          // ALTER TABLE refuses while deferred checks are pending; they pass, so run them first.
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          await c.query(`ALTER TABLE ${rel} DISABLE ROW LEVEL SECURITY`);
          expect(await asAppSees(c, A, rel)).toEqual([biz.businessId, biz.other.businessId].sort());
        });
      }
    });
  });

  it('T-18.3: a cache row whose tenant is not its business’s tenant is refused (23503, stock_levels_tenant_fk); likewise a movement and a binding', async () => {
    await withRolledBackFixture(async (c) => {
      expectConstraint(
        await attempt(c, () =>
          c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
            biz.other.tenantId,
            biz.businessId,
            K1.warehouseId,
            K1.variantId,
          ]),
        ),
        '23503',
        'stock_levels_tenant_fk',
      );
      expectConstraint(
        await attempt(c, () =>
          c.query(
            `INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) VALUES ($1, $2, 'fixture_line', $3, $4, 'purchase')`,
            [biz.other.tenantId, biz.businessId, randomUUID(), randomUUID()],
          ),
        ),
        '23503',
        'stock_source_bindings_tenant_fk',
      );
      await c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
        biz.tenantId,
        biz.businessId,
        K1.warehouseId,
        K1.variantId,
      ]);
      expectConstraint(
        await attempt(c, () =>
          c.query(
            `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id,
                                          qty_delta, unit_cost_base_minor, value_delta_base_minor, actor_user_id)
             VALUES ($1, $2, gen_random_uuid(), $3, $4, 1, 'purchase', 'fixture_line', gen_random_uuid(), gen_random_uuid(), 1, 1, 1, $5)`,
            [biz.other.tenantId, biz.businessId, K1.warehouseId, K1.variantId, biz.userId],
          ),
        ),
        '23503',
        'stock_movements_tenant_fk',
      );
    });
  });

  it('T-18.4 / T-16.6 (raw): a split pair — A’s business with B’s warehouse or B’s variant — is refused (23503) on the cache row and on the movement', async () => {
    await withRolledBackFixture(async (c) => {
      const row = (wh: string, va: string) =>
        attempt(c, () =>
          c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
            biz.tenantId,
            biz.businessId,
            wh,
            va,
          ]),
        );
      expectConstraint(await row(KB.warehouseId, K1.variantId), '23503', 'stock_levels_warehouse_fk');
      expectConstraint(await row(K1.warehouseId, KB.variantId), '23503', 'stock_levels_variant_fk');
      expectConstraint(
        await attempt(c, () =>
          c.query(
            `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id,
                                          qty_delta, unit_cost_base_minor, value_delta_base_minor, actor_user_id)
             VALUES ($1, $2, gen_random_uuid(), $3, $4, 1, 'purchase', 'fixture_line', gen_random_uuid(), gen_random_uuid(), 1, 1, 1, $5)`,
            [biz.tenantId, biz.businessId, KB.warehouseId, KB.variantId, biz.userId],
          ),
        ),
        '23503',
        'stock_movements_level_fk',
      );
      // Control: the same statement with A's own key is accepted.
      expectAccepted(await row(K1.warehouseId, K1.variantId));
    });
  });

  it('T-18.5: the internal role, scoped to A, cannot write a B row: the restrictive WITH CHECK omits the internal admission (42501)', async () => {
    await withRolledBackFixture(async (c) => {
      const insertB = () =>
        attempt(c, async () => {
          await setScope(c, biz);
          await c.query(`SET LOCAL ROLE ${INTERNAL}`);
          return c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
            biz.other.tenantId,
            biz.other.businessId,
            KB.warehouseId,
            KB.variantId,
          ]);
        });
      expectRefused(await insertB(), '42501', null, 'internal writes B under scope A');
      // The internal role CAN read B (the identity read), which is why the write side must refuse.
      await setScope(c, biz);
      await c.query(`SET LOCAL ROLE ${INTERNAL}`);
      await c.query('SELECT count(*) FROM stock_levels');
      await c.query('RESET ROLE');
      // Control: with the internal admission added to both WITH CHECKs in-transaction, the same insert is accepted.
      await scratch(c, async () => {
        await c.query(
          `ALTER POLICY tenant_membership ON stock_levels WITH CHECK (app_bypass() OR current_user = '${INTERNAL}' OR tenant_id = nullif(app_tenant(), '')::uuid)`,
        );
        await c.query(
          `ALTER POLICY business_isolation ON stock_levels WITH CHECK (app_bypass() OR current_user = '${INTERNAL}' OR business_id = nullif(app_business(), '')::uuid)`,
        );
        expectAccepted(await insertB(), 'relaxed WITH CHECK');
      });
    });
  });

  it('T-18.6: R4, R5 and R6 for B’s key under scope A refuse with inventory.scope_mismatch; control: without the check, R5 answers', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(
        c,
        { tenantId: biz.other.tenantId, businessId: biz.other.businessId, userId: biz.other.userId },
        req(KB, 'purchase', '7', { unitCost: '3' }),
      );
      await setScope(c, biz);
      for (const sql of [
        `SELECT inventory_next_deficit_seq($1, $2, $3)`,
        `SELECT * FROM inventory_stock_fold($1, $2, $3)`,
        `SELECT * FROM inventory_stock_verify($1, $2, $3)`,
      ]) {
        expectRefused(await attempt(c, () => c.query(sql, [biz.other.businessId, KB.warehouseId, KB.variantId])), 'P0001', 'inventory.scope_mismatch', sql);
      }
      await scratch(c, async () => {
        await withoutRefusal(c, 'inventory_stock_fold(uuid,uuid,uuid)', 'inventory.scope_mismatch');
        const r = await c.query<{ on_hand: string }>(`SELECT on_hand::text FROM inventory_stock_fold($1, $2, $3)`, [
          biz.other.businessId,
          KB.warehouseId,
          KB.variantId,
        ]);
        expect(r.rows).toEqual([{ on_hand: '7.0000' }]);
      });
    });
  });
});

describe('T-16 — primitive authority (P:168)', () => {
  /** Call R3 DIRECTLY as the superuser, with whatever carrier and scope the case set. */
  const callR3 = (c: Queryable, requests: readonly MovementRequest[]) =>
    attempt(c, async () => (await c.query<MovementRow>(`SELECT * FROM inventory_apply_stock_movements(${requestsParam(1)})`, [requestsJson(requests)])).rows);

  const carrier = async (c: Queryable, value: string) => {
    await c.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [value]);
  };

  it('T-16.1: each runtime role calling R3 is refused by the ACL (42501), even with a valid carrier and scope', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      const c = await roleClient(url);
      try {
        await c.query('BEGIN');
        await setScope(c, biz);
        await carrier(
          c,
          mintFixtureAssertion({ opCode: FIXTURE_OP, actorUserId: biz.userId, tenantId: biz.tenantId, businessId: biz.businessId, nonce: randomUUID() }),
        );
        expectRefused(await callR3(c, [req(K1, 'purchase', '1', { unitCost: '1' })]), '42501', null, role);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    }
  });

  it('T-16 ALLOW: the fixture entry routine, with its consumed assertion, writes through R3', async () => {
    await withRolledBackFixture(async (c) => {
      const row = await applyOne(c, biz, req(K1, 'purchase', '3', { unitCost: '2' }));
      expect({ kind: row.movement_kind, seq: row.stock_seq, value: row.value_delta_base_minor }).toEqual({ kind: 'purchase', seq: '1', value: '6' });
    });
  });

  it('T-16.2 / T-16.N: the owner calling R3 with a valid, UNCONSUMED fixture carrier is refused (inventory.assertion_not_consumed); with inventory_assertion_current stubbed in-transaction the same call writes', async () => {
    await withRolledBackFixture(async (c) => {
      const jti = randomUUID();
      await setScope(c, biz);
      await carrier(
        c,
        mintFixtureAssertion({ opCode: FIXTURE_OP, actorUserId: biz.userId, tenantId: biz.tenantId, businessId: biz.businessId, nonce: randomUUID(), jti }),
      );
      const requests = [req(K1, 'purchase', '1', { unitCost: '1' })];
      expectRefused(await callR3(c, requests), 'P0001', 'inventory.assertion_not_consumed');
      await scratch(c, async () => {
        await c.query(`CREATE OR REPLACE FUNCTION inventory_assertion_current(p_allowed_op_codes TEXT[]) RETURNS inventory_verified_actor
                       LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
                       AS $stub$ SELECT ROW('${biz.userId}'::uuid, '${biz.tenantId}'::uuid, '${biz.businessId}'::uuid, '${FIXTURE_OP}', '${jti}'::uuid)::inventory_verified_actor $stub$`);
        const rows = expectAccepted(await callR3(c, requests), 'stubbed verifier');
        expect(rows).toHaveLength(1);
      });
    });
  });

  it('T-16.3: no carrier → inventory.assertion_missing, at R3 directly and at the entry routine', async () => {
    await withRolledBackFixture(async (c) => {
      await setScope(c, biz);
      await carrier(c, '');
      expectRefused(await callR3(c, [req(K1, 'purchase', '1', { unitCost: '1' })]), 'P0001', 'inventory.assertion_missing', 'R3');
      expectRefused(await tryApply(c, biz, [req(K1, 'purchase', '1', { unitCost: '1' })], { assertion: '' }), 'P0001', 'inventory.assertion_missing', 'entry');
    });
  });

  it('T-16.4: an assertion for the _other operation (mapped to purchase_reversal only) requesting purchase → inventory.movement_kind_not_authorized', async () => {
    await withRolledBackFixture(async (c) => {
      expectRefused(await tryApply(c, biz, [req(K1, 'purchase', '1', { unitCost: '1' })], { other: true }), 'P0001', 'inventory.movement_kind_not_authorized');
      // Its own mapped kind passes the authority step (and is then judged on stock).
      await applyOne(c, biz, req(K1, 'purchase', '2', { unitCost: '1' }));
      const row = await applyOne(c, biz, req(K1, 'purchase_reversal', '-1'), { other: true });
      expect(row.movement_kind).toBe('purchase_reversal');
      // And the main fixture op is not mapped to purchase_reversal.
      expectRefused(await tryApply(c, biz, [req(K1, 'purchase_reversal', '-1')]), 'P0001', 'inventory.movement_kind_not_authorized');
    });
  });

  it('T-16.5: an assertion for business B used under scope A → inventory.assertion_scope_mismatch (entry routine, and R3 with a uses row for this transaction)', async () => {
    await withRolledBackFixture(async (c) => {
      const nonce = randomUUID();
      const forB = mintFixtureAssertion({
        opCode: FIXTURE_OP,
        actorUserId: biz.other.userId,
        tenantId: biz.other.tenantId,
        businessId: biz.other.businessId,
        nonce,
      });
      expectRefused(
        await tryApply(c, biz, [req(K1, 'purchase', '1', { unitCost: '1' })], { assertion: forB, nonce }),
        'P0001',
        'inventory.assertion_scope_mismatch',
        'entry',
      );
      const jti = randomUUID();
      const forB2 = mintFixtureAssertion({
        opCode: FIXTURE_OP,
        actorUserId: biz.other.userId,
        tenantId: biz.other.tenantId,
        businessId: biz.other.businessId,
        nonce,
        jti,
      });
      await c.query(`INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id) VALUES ($1, pg_current_xact_id(), $2, $3)`, [
        jti,
        FIXTURE_OP,
        biz.other.businessId,
      ]);
      await setScope(c, biz);
      await carrier(c, forB2);
      expectRefused(await callR3(c, [req(K1, 'purchase', '1', { unitCost: '1' })]), 'P0001', 'inventory.assertion_scope_mismatch', 'R3');
    });
  });

  it('T-16.6: verified A naming B’s warehouse → inventory.warehouse_not_found; B’s variant → inventory.variant_not_found', async () => {
    await withRolledBackFixture(async (c) => {
      expectRefused(
        await tryApply(c, biz, [req({ warehouseId: KB.warehouseId, variantId: K1.variantId }, 'purchase', '1', { unitCost: '1' })]),
        'P0001',
        'inventory.warehouse_not_found',
      );
      expectRefused(
        await tryApply(c, biz, [req({ warehouseId: K1.warehouseId, variantId: KB.variantId }, 'purchase', '1', { unitCost: '1' })]),
        'P0001',
        'inventory.variant_not_found',
      );
      expect(must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_levels WHERE business_id = $1`, [biz.businessId])).rows[0]).n).toBe(0);
    });
  });

  it('T-16.7: a uses row for the carrier’s jti from ANOTHER transaction (xact = 1) → inventory.assertion_not_consumed; control: this transaction’s xact is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      const jti = randomUUID();
      await setScope(c, biz);
      await carrier(
        c,
        mintFixtureAssertion({ opCode: FIXTURE_OP, actorUserId: biz.userId, tenantId: biz.tenantId, businessId: biz.businessId, nonce: randomUUID(), jti }),
      );
      const requests = [req(K1, 'purchase', '1', { unitCost: '1' })];
      await scratch(c, async () => {
        await c.query(`INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id) VALUES ($1, '1'::xid8, $2, $3)`, [
          jti,
          FIXTURE_OP,
          biz.businessId,
        ]);
        expectRefused(await callR3(c, requests), 'P0001', 'inventory.assertion_not_consumed');
      });
      await scratch(c, async () => {
        await c.query(`INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id) VALUES ($1, pg_current_xact_id(), $2, $3)`, [
          jti,
          FIXTURE_OP,
          biz.businessId,
        ]);
        expect(expectAccepted(await callR3(c, requests), 'consumed in this transaction')).toHaveLength(1);
      });
    });
  });

  it('T-16.8: the stored kind is the requested (mapped) kind and actor_user_id is the SIGNED actor, even with app.actor_user_id spoofed', async () => {
    await withRolledBackFixture(async (c) => {
      const row = await applyOne(c, biz, req(K1, 'purchase', '2', { unitCost: '5' }), {
        gucs: { 'app.actor_user_id': biz.otherUserId, 'app.user_id': biz.otherUserId },
      });
      const m = await c.query<{ actor: string; kind: string }>(
        `SELECT actor_user_id::text AS actor, movement_kind AS kind FROM stock_movements WHERE business_id = $1 AND id = $2`,
        [biz.businessId, row.movement_id],
      );
      expect(m.rows).toEqual([{ actor: biz.userId, kind: 'purchase' }]);
    });
  });

  it('T-16.9: with the op→kind mapping empty (the end-of-migration state), a consumed fixture op → inventory.assertion_wrong_operation', async () => {
    await withRolledBackFixture(async (c) => {
      // Control first: with the mapping present the same call writes.
      expectAccepted(await tryApply(c, biz, [req(K1, 'purchase', '1', { unitCost: '1' })]), 'mapping present');
      await c.query(`DELETE FROM inventory_operation_movement_kinds WHERE op_code LIKE 'fixture.%'`);
      expect(must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_operation_movement_kinds`)).rows[0]).n).toBe(0);
      expectRefused(await tryApply(c, biz, [req(K1, 'purchase', '1', { unitCost: '1' })]), 'P0001', 'inventory.assertion_wrong_operation');
    });
  });

  it('T-16.9: an S1 operation’s consumed assertion (inventory.configure_product) cannot drive R3 either', async () => {
    await withRolledBackFixture(async (c) => {
      const jti = randomUUID();
      await c.query(
        `INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id) VALUES ($1, pg_current_xact_id(), 'inventory.configure_product', $2)`,
        [jti, biz.businessId],
      );
      await setScope(c, biz);
      await carrier(
        c,
        mintFixtureAssertion({
          opCode: 'inventory.configure_product',
          actorUserId: biz.userId,
          tenantId: biz.tenantId,
          businessId: biz.businessId,
          nonce: randomUUID(),
          jti,
        }),
      );
      expectRefused(await callR3(c, [req(K1, 'purchase', '1', { unitCost: '1' })]), 'P0001', 'inventory.assertion_wrong_operation');
    });
  });
});

describe('§2.4 — the complete S2 trigger set, from pg_trigger', () => {
  it('the S2 tables carry exactly the four append/retain triggers and the deferred zero-value constraint trigger; products carries products_20_unit_history_lock and product_variants carries product_variants_20_stock_identity_lock', async () => {
    const r = await ownerPool().query<{
      tg: string;
      rel: string;
      fn: string;
      type: number;
      enabled: string;
      constraint: boolean;
      deferrable: boolean;
      deferred: boolean;
      owner: string;
      secdef: boolean;
    }>(
      `SELECT g.tgname::text AS tg, g.tgrelid::regclass::text AS rel, g.tgfoid::regprocedure::text AS fn, g.tgtype::int AS type, g.tgenabled::text AS enabled,
              g.tgconstraint <> 0 AS constraint, g.tgdeferrable AS deferrable, g.tginitdeferred AS deferred, r.rolname::text AS owner, p.prosecdef AS secdef
         FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid JOIN pg_roles r ON r.oid = p.proowner
        WHERE NOT g.tgisinternal AND (g.tgrelid = ANY ($1::text[]::regclass[]) OR g.tgname IN ('products_20_unit_history_lock', 'product_variants_20_stock_identity_lock'))
        ORDER BY 1`,
      [[...S2_RELATIONS]],
    );
    const migratorOwner = must(r.rows.find((x) => x.tg === 'stock_levels_retain')).owner;
    expect(migratorOwner).not.toBe(INTERNAL);
    // tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
    const invoker = { enabled: 'O', constraint: false, deferrable: false, deferred: false, owner: migratorOwner, secdef: false };
    expect(r.rows).toEqual([
      { tg: 'negative_deficit_coverages_append_only', rel: 'negative_deficit_coverages', fn: 'stock_ledger_append_only()', type: 1 + 2 + 8 + 16, ...invoker },
      {
        tg: 'product_variants_20_stock_identity_lock',
        rel: 'product_variants',
        fn: 'product_variants_20_stock_identity_lock()',
        type: 1 + 2 + 16,
        enabled: 'O',
        constraint: false,
        deferrable: false,
        deferred: false,
        owner: INTERNAL,
        secdef: true,
      },
      {
        tg: 'products_20_unit_history_lock',
        rel: 'products',
        fn: 'products_20_unit_history_lock()',
        type: 1 + 2 + 16,
        enabled: 'O',
        constraint: false,
        deferrable: false,
        deferred: false,
        owner: INTERNAL,
        secdef: true,
      },
      { tg: 'stock_levels_retain', rel: 'stock_levels', fn: 'stock_levels_retain()', type: 1 + 2 + 8, ...invoker },
      {
        tg: 'stock_levels_zero_on_hand_zero_value',
        rel: 'stock_levels',
        fn: 'stock_levels_zero_on_hand_zero_value()',
        type: 1 + 4 + 16,
        enabled: 'O',
        constraint: true,
        deferrable: true,
        deferred: true,
        owner: INTERNAL,
        secdef: true,
      },
      { tg: 'stock_movements_append_only', rel: 'stock_movements', fn: 'stock_ledger_append_only()', type: 1 + 2 + 8 + 16, ...invoker },
      { tg: 'stock_source_bindings_append_only', rel: 'stock_source_bindings', fn: 'stock_ledger_append_only()', type: 1 + 2 + 8 + 16, ...invoker },
    ]);
  });

  it('the 0060 end-state block passes at the migration state and refuses a zero-value trigger that is no longer deferred (control)', async () => {
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      expectAccepted(await attempt(c, () => c.query(endStateBlock('0060_inventory_stock_primitive.sql'))), '0060-E');
      await c.query(`DROP TRIGGER stock_levels_zero_on_hand_zero_value ON stock_levels`);
      await c.query(
        `CREATE TRIGGER stock_levels_zero_on_hand_zero_value AFTER INSERT OR UPDATE ON stock_levels FOR EACH ROW EXECUTE FUNCTION stock_levels_zero_on_hand_zero_value()`,
      );
      expectRefused(await attempt(c, () => c.query(endStateBlock('0060_inventory_stock_primitive.sql'))), 'P0001', 'inventory.authority_leak', '0060-E');
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
});

it('the fixture only ever ran in rolled-back transactions: the registries are in the migration state', async () => {
  await assertMigrationState();
});
