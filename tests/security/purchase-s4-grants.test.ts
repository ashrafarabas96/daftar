/**
 * P3-S4 T-01 — GRANTS AND ACL OF THE S4 OBJECTS
 * (docs/PHASE_3_S4_CONTRACT.md A-18, A-14(d), §6 T-01).
 *
 * - `daftar_app` reads exactly the six S4 documents and the two S2 coverage
 *   tables and holds no DML anywhere: every INSERT, UPDATE and DELETE it
 *   attempts on a real connection is refused 42501, bridges included;
 * - every other runtime role holds nothing on any S4 relation, and a real
 *   SELECT through its own credential is refused 42501;
 * - `daftar_inventory_internal` holds the exact column UPDATE set of A-18,
 *   DELETE on the three draft-replaceable children only, and no UPDATE on the
 *   coverage header or the coverages (inserted complete, A-16(i));
 * - the seven entry routines are internal-owned SECURITY DEFINER with the
 *   pinned path, executable by `daftar_app` alone; the three receipt helpers
 *   and `accounting_purchase_fx_rate` are executable by no runtime role.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  RUNTIME_ROLES,
  attempt,
  expectAccepted,
  must,
  ownerClient,
  refusedWith,
  roleClient,
  seedS3World,
  settle,
  type S3World,
} from '../helpers/inventory-commands';
import { ROUTINE_OF, S4_BRIDGES, S4_HELPERS, S4_KINDS, S4_TABLES, honestS4, tryCommand } from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4grants');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** The two S2 relations S4 opens to `daftar_app` for reading (A-18). */
const S2_READ = ['negative_inventory_deficits', 'negative_deficit_coverages'] as const;
const ALL_S4 = [...S4_TABLES, ...S4_BRIDGES] as const;

async function tablePrivileges(role: string, table: string): Promise<{ s: boolean; i: boolean; u: boolean; d: boolean; tr: boolean }> {
  return must(
    (
      await ownerPool().query<{ s: boolean; i: boolean; u: boolean; d: boolean; tr: boolean }>(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS s, has_table_privilege($1, $2, 'INSERT') AS i,
                has_table_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'DELETE') AS d,
                has_table_privilege($1, $2, 'TRUNCATE') AS tr`,
        [role, table],
      )
    ).rows[0],
  );
}

/** The columns of `table` the role may UPDATE (table-level or column-level). */
async function updatableColumns(role: string, table: string): Promise<string[]> {
  const r = await ownerPool().query<{ a: string }>(
    `SELECT attname::text AS a FROM pg_attribute
      WHERE attrelid = $2::regclass AND attnum > 0 AND NOT attisdropped
        AND has_column_privilege($1, attrelid, attnum, 'UPDATE')
      ORDER BY attname`,
    [role, table],
  );
  return r.rows.map((x) => x.a);
}

describe('T-01 daftar_app: SELECT per A-18, no DML', () => {
  it('the catalogue: SELECT on the six documents and the two S2 coverage tables; nothing on the bridges; no DML anywhere', async () => {
    for (const t of [...ALL_S4, ...S2_READ]) {
      const readable = (S4_TABLES as readonly string[]).includes(t) || (S2_READ as readonly string[]).includes(t);
      expect(await tablePrivileges('daftar_app', t), t).toEqual({ s: readable, i: false, u: false, d: false, tr: false });
    }
  });

  it('on a real connection every INSERT, UPDATE and DELETE is refused 42501; the reads are accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      for (const t of [...ALL_S4, ...S2_READ]) {
        for (const sql of [
          `INSERT INTO ${t} (business_id) VALUES ($1)`,
          `UPDATE ${t} SET business_id = $1 WHERE false`,
          `DELETE FROM ${t} WHERE business_id = $1`,
        ]) {
          const o = await attempt(c, async () => {
            await c.query('SET LOCAL ROLE daftar_app');
            await c.query(sql, [A.businessId]);
          });
          refusedWith(o, '42501', null, sql);
        }
      }
      for (const t of [...S4_TABLES, ...S2_READ]) {
        expectAccepted(
          await attempt(c, async () => {
            await c.query('SET LOCAL ROLE daftar_app');
            return c.query(`SELECT count(*) FROM ${t}`);
          }),
          `SELECT ${t}`,
        );
      }
      for (const t of S4_BRIDGES) {
        const o = await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_app');
          await c.query(`SELECT count(*) FROM ${t}`);
        });
        refusedWith(o, '42501', null, `SELECT ${t}`);
      }
    });
  });
});

describe('T-01 every other runtime role holds nothing', () => {
  it('no privilege of any kind on any S4 relation, from the catalogue and through its own credential', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      if (role === 'daftar_app') continue;
      for (const t of ALL_S4) {
        expect(await tablePrivileges(role, t), `${role} → ${t}`).toEqual({ s: false, i: false, u: false, d: false, tr: false });
      }
      const rc = await roleClient(url);
      try {
        for (const t of ALL_S4) {
          refusedWith(await settle(() => rc.query(`SELECT count(*) FROM ${t}`)), '42501', null, `${role} SELECT ${t}`);
        }
      } finally {
        await rc.end();
      }
    }
  });

  it('PUBLIC holds nothing on the S4 relations (no ACL entry names PUBLIC)', async () => {
    const r = await ownerPool().query<{ t: string }>(
      `SELECT c.relname::text AS t FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relname = ANY($1::text[]) AND a.grantee = 0`,
      [[...ALL_S4]],
    );
    expect(r.rows).toEqual([]);
  });
});

describe('T-01 daftar_inventory_internal: the exact A-18 grant', () => {
  it('SELECT and INSERT on the six documents, the two bridges and the coverages; DELETE on the three draft children only', async () => {
    for (const t of ALL_S4) {
      const p = await tablePrivileges('daftar_inventory_internal', t);
      expect({ s: p.s, i: p.i, tr: p.tr }, t).toEqual({ s: true, i: true, tr: false });
      expect(p.d, `DELETE ${t}`).toBe(['purchase_lines', 'purchase_landed_costs', 'purchase_landed_cost_allocations'].includes(t));
    }
    const cov = await tablePrivileges('daftar_inventory_internal', 'negative_deficit_coverages');
    expect({ s: cov.s, i: cov.i, u: cov.u, d: cov.d }).toEqual({ s: true, i: true, u: false, d: false });
    expect(
      must((await ownerPool().query<{ ok: boolean }>(`SELECT has_table_privilege('daftar_inventory_internal', 'currencies', 'SELECT') AS ok`)).rows[0]).ok,
    ).toBe(true);
  });

  it('column UPDATE is exactly the A-18 set; no UPDATE on the coverage header, the coverages, the allocations or the bridges', async () => {
    const R = 'daftar_inventory_internal';
    expect(await updatableColumns(R, 'suppliers')).toEqual(
      [
        'business_transaction_id',
        'email',
        'last_intent_sha256',
        'name',
        'notes',
        'phone',
        'revision',
        'status',
        'tax_identifier',
        'updated_at',
        'updated_by',
      ].sort(),
    );
    expect(await updatableColumns(R, 'purchases')).toEqual(
      [
        'supplier_id',
        'warehouse_id',
        'currency_code',
        'document_date',
        'supplier_reference',
        'notes',
        'revision',
        'draft_intent_sha256',
        'subtotal_txn_minor',
        'landed_cost_txn_minor',
        'tax_minor',
        'total_txn_minor',
        'business_transaction_id',
        'updated_at',
        'status',
        'receive_intent_sha256',
        'cancel_intent_sha256',
        'source_to_base_rate',
        'rate_source',
        'rate_timestamp',
        'fx_rate_id',
        'total_base_minor',
        'supplier_name_snapshot',
        'supplier_tax_identifier_snapshot',
        'supplier_phone_snapshot',
        'received_by',
        'received_at',
        'cancelled_by',
        'cancelled_at',
        'binding_source_id',
      ].sort(),
    );
    expect(await updatableColumns(R, 'purchase_lines')).toEqual(['base_share_minor', 'unit_cost_base_minor']);
    expect(await updatableColumns(R, 'negative_inventory_deficits')).toEqual(['status', 'uncovered_qty']);
    for (const t of [
      'negative_inventory_cost_adjustments',
      'negative_deficit_coverages',
      'purchase_landed_costs',
      'purchase_landed_cost_allocations',
      ...S4_BRIDGES,
    ]) {
      expect(await updatableColumns(R, t), t).toEqual([]);
    }
  });

  it('daftar_accounting_internal reads the two posting headers only (A-14(d))', async () => {
    for (const t of ALL_S4) {
      const p = await tablePrivileges('daftar_accounting_internal', t);
      expect(p, t).toEqual({ s: ['purchases', 'negative_inventory_cost_adjustments'].includes(t), i: false, u: false, d: false, tr: false });
    }
  });
});

describe('T-01 the EXECUTE matrix', () => {
  it('each entry routine is internal-owned SECURITY DEFINER with the pinned path, executable by daftar_app alone', async () => {
    for (const kind of S4_KINDS) {
      const r = must(
        (
          await ownerPool().query<{ owner: string; secdef: boolean; config: string[] | null; grantees: string[] | null }>(
            `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                    (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text)
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
               FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [ROUTINE_OF[kind]],
          )
        ).rows[0],
      );
      expect(r, kind).toEqual({
        owner: 'daftar_inventory_internal',
        secdef: true,
        config: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['daftar_app'],
      });
    }
  });

  it('every other runtime role is refused EXECUTE on every routine, from the catalogue and on its own connection', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      for (const kind of S4_KINDS) {
        const r = must((await ownerPool().query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, ROUTINE_OF[kind]])).rows[0]);
        expect(r.ok, `${role} → ${kind}`).toBe(role === 'daftar_app');
      }
      if (role === 'daftar_app') continue;
      const rc = await roleClient(url);
      try {
        const o = await settle(() => rc.query(`SELECT * FROM supplier_archive($1::uuid, 1)`, [randomUUID()]));
        refusedWith(o, '42501', null, role);
      } finally {
        await rc.end();
      }
    }
  });

  it('no runtime role, the accounting principal or the migrator may execute a receipt helper; the FX lookup is granted to the inventory principal alone', async () => {
    for (const fn of S4_HELPERS) {
      for (const role of [...RUNTIME_ROLES.map((r) => r.role), 'daftar_accounting_internal', 'daftar_migrator']) {
        const r = must((await ownerPool().query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).rows[0]);
        expect(r.ok, `${role} → ${fn}`).toBe(false);
      }
    }
    const FX = 'accounting_purchase_fx_rate(uuid,character,timestamp with time zone)';
    for (const role of [...RUNTIME_ROLES.map((r) => r.role), 'daftar_migrator']) {
      const r = must((await ownerPool().query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, FX])).rows[0]);
      expect(r.ok, `${role} → ${FX}`).toBe(false);
    }
    // Owned by the accounting principal (it reads the rate registry as definer); its one grantee is the receipt routine's owner.
    const fx = must(
      (
        await ownerPool().query<{ owner: string; secdef: boolean; grantees: string[] | null }>(
          `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
                  (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a
                    WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [FX],
        )
      ).rows[0],
    );
    expect(fx).toEqual({ owner: 'daftar_accounting_internal', secdef: true, grantees: ['daftar_inventory_internal'] });
  });

  it('daftar_app calling a helper directly is refused 42501; the entry routine it may call is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      for (const sql of [
        { text: `SELECT purchase_bridge_receipt($1::uuid, NULL)`, params: [randomUUID()] },
        { text: `SELECT purchase_lock_receipt_targets($1::uuid, ARRAY[$2::uuid])`, params: [A.w1, A.piece.variantId] },
        { text: `SELECT * FROM purchase_cover_deficits($1::uuid, NULL)`, params: [randomUUID()] },
        { text: `SELECT * FROM accounting_purchase_fx_rate($1::uuid, 'USD', now())`, params: [A.businessId] },
      ]) {
        const o = await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_app');
          await c.query(sql.text, sql.params);
        });
        refusedWith(o, '42501', null, sql.text);
      }
      expectAccepted(await tryCommand(c, A, await honestS4(c, A, 'supplier_create')));
    });
  });
});
