/**
 * P3-S5 T-01 — GRANTS AND ACL OF THE S5 OBJECTS
 * (docs/PHASE_3_S5_CONTRACT.md A-18, A-15(d), A-16, §2.5, §6 T-01; 0066 R-55).
 *
 * - `daftar_app` reads exactly the five S5 documents and holds no DML
 *   anywhere: every INSERT, UPDATE and DELETE it attempts on a real
 *   connection is refused 42501, and it cannot read the two bridges;
 * - every other runtime role holds nothing on any S5 relation, and a real
 *   SELECT through its own credential is refused 42501; PUBLIC holds nothing;
 * - `daftar_inventory_internal` holds INSERT and SELECT on the five tables
 *   and the two bridges, and no UPDATE, DELETE or TRUNCATE;
 *   `daftar_accounting_internal` reads the two posting headers only;
 * - the two entry routines are internal-owned SECURITY DEFINER with the
 *   pinned path, executable by `daftar_app` alone; the four helpers (the
 *   R-55 credit-note writer included) are executable by no runtime role,
 *   the accounting principal or the migrator, and `daftar_app` calling one
 *   directly is refused 42501;
 * - the two read functions are SECURITY INVOKER, executable by `daftar_app`
 *   and `daftar_inventory_internal` only, and answer only what the caller's
 *   row security shows: A's purchase to A (ALLOW), `purchase.not_found` for
 *   the same owner's A2 and for another owner's B (DENY).
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
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import {
  S5_BRIDGES,
  S5_HELPERS,
  S5_KINDS,
  S5_READ_FUNCTIONS,
  S5_ROUTINE_OF,
  S5_TABLES,
  prepareReturn,
  receivedPurchase,
  tryReturn,
  type ReceivedPurchase,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5grants');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

const ALL_S5 = [...S5_TABLES, ...S5_BRIDGES] as const;

interface Privileges {
  readonly s: boolean;
  readonly i: boolean;
  readonly u: boolean;
  readonly d: boolean;
  readonly tr: boolean;
}

async function tablePrivileges(role: string, table: string): Promise<Privileges> {
  return must(
    (
      await ownerPool().query<Privileges>(
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

interface FunctionAcl {
  readonly owner: string;
  readonly secdef: boolean;
  readonly config: string[] | null;
  readonly grantees: string[] | null;
}

async function functionAcl(signature: string): Promise<FunctionAcl> {
  return must(
    (
      await ownerPool().query<FunctionAcl>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text)
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [signature],
      )
    ).rows[0],
    signature,
  );
}

async function canExecute(role: string, signature: string): Promise<boolean> {
  return must((await ownerPool().query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, signature])).rows[0]).ok;
}

describe('T-01 daftar_app: SELECT on the five documents, no DML', () => {
  it('the catalogue: SELECT on the five tables; nothing on the bridges; no DML anywhere', async () => {
    for (const t of ALL_S5) {
      expect(await tablePrivileges('daftar_app', t), t).toEqual({ s: (S5_TABLES as readonly string[]).includes(t), i: false, u: false, d: false, tr: false });
      expect(await updatableColumns('daftar_app', t), `${t} column UPDATE`).toEqual([]);
    }
  });

  it('on a real connection every INSERT, UPDATE and DELETE is refused 42501; the reads are accepted; the bridges are not readable', async () => {
    await inTx(async (c) => {
      const A = world.A;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      for (const t of ALL_S5) {
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
      for (const t of S5_TABLES) {
        expectAccepted(
          await attempt(c, async () => {
            await c.query('SET LOCAL ROLE daftar_app');
            return c.query(`SELECT count(*) FROM ${t}`);
          }),
          `SELECT ${t}`,
        );
      }
      for (const t of S5_BRIDGES) {
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
  it('no privilege of any kind on any S5 relation, from the catalogue and through its own credential', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      if (role === 'daftar_app') continue;
      for (const t of ALL_S5) {
        expect(await tablePrivileges(role, t), `${role} → ${t}`).toEqual({ s: false, i: false, u: false, d: false, tr: false });
      }
      const rc = await roleClient(url);
      try {
        for (const t of ALL_S5) {
          refusedWith(await settle(() => rc.query(`SELECT count(*) FROM ${t}`)), '42501', null, `${role} SELECT ${t}`);
        }
      } finally {
        await rc.end();
      }
    }
  });

  it('PUBLIC holds nothing on the S5 relations or functions (no ACL entry names PUBLIC)', async () => {
    const rel = await ownerPool().query<{ t: string }>(
      `SELECT c.relname::text AS t FROM pg_class c, aclexplode(c.relacl) a WHERE c.relname = ANY($1::text[]) AND a.grantee = 0`,
      [[...ALL_S5]],
    );
    expect(rel.rows).toEqual([]);
    const fns = [...S5_KINDS.map((k) => S5_ROUTINE_OF[k]), ...S5_HELPERS, ...S5_READ_FUNCTIONS];
    const fn = await ownerPool().query<{ f: string }>(
      `SELECT p.oid::regprocedure::text AS f FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = ANY($1::regprocedure[]) AND a.grantee = 0`,
      [fns],
    );
    expect(fn.rows).toEqual([]);
  });
});

describe('T-01 the internal principals: the exact A-18 grant', () => {
  it('daftar_inventory_internal: INSERT and SELECT on the five tables and the two bridges; no UPDATE, no DELETE, no TRUNCATE (P3-S6: but the two remaining columns of the credit note)', async () => {
    for (const t of ALL_S5) {
      expect(await tablePrivileges('daftar_inventory_internal', t), t).toEqual({ s: true, i: true, u: false, d: false, tr: false });
      expect(await updatableColumns('daftar_inventory_internal', t), `${t} column UPDATE`).toEqual(
        // P3-S6 (0067, docs/PHASE_3_S6_CONTRACT.md A-12, A-17): the credit note's
        // two remaining values, decremented by supplier_credit_note_consume only
        // (R-73); every other S5 relation still has no column UPDATE.
        t === 'supplier_credit_notes' ? ['remaining_amount_minor', 'remaining_carrying_base_amount_minor'] : [],
      );
    }
  });

  it('daftar_accounting_internal reads the two posting headers only (A-15(d); P3-S6: and the credit notes)', async () => {
    for (const t of ALL_S5) {
      expect(await tablePrivileges('daftar_accounting_internal', t), t).toEqual({
        // P3-S6 (0067, docs/PHASE_3_S6_CONTRACT.md A-14(d)): and the credit
        // notes, which the S6 completeness triggers read.
        s: t === 'supplier_returns' || t === 'purchase_reversals' || t === 'supplier_credit_notes',
        i: false,
        u: false,
        d: false,
        tr: false,
      });
    }
  });
});

describe('T-01 the EXECUTE matrix', () => {
  it('each entry routine is internal-owned SECURITY DEFINER with the pinned path, executable by daftar_app alone', async () => {
    for (const kind of S5_KINDS) {
      expect(await functionAcl(S5_ROUTINE_OF[kind]), kind).toEqual({
        owner: 'daftar_inventory_internal',
        secdef: true,
        config: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['daftar_app'],
      });
      for (const { role } of RUNTIME_ROLES) expect(await canExecute(role, S5_ROUTINE_OF[kind]), `${role} → ${kind}`).toBe(role === 'daftar_app');
    }
  });

  it('every other runtime role is refused EXECUTE on its own connection', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      if (role === 'daftar_app') continue;
      const rc = await roleClient(url);
      try {
        const o = await settle(() =>
          rc.query(
            `SELECT * FROM purchase_reverse($1::uuid, $2::uuid, current_date, 'x', $3::uuid, 1, '{}'::uuid[], '{}'::uuid[], '{}'::numeric[], '{}'::bigint[])`,
            [randomUUID(), randomUUID(), randomUUID()],
          ),
        );
        refusedWith(o, '42501', null, role);
      } finally {
        await rc.end();
      }
    }
  });

  it('the four helpers (R-55 included) are internal-owned definers with no grantee: no runtime role, the accounting principal or the migrator may execute one', async () => {
    expect(S5_HELPERS).toContain('purchase_bridge_credit_note(uuid)');
    for (const fn of S5_HELPERS) {
      expect(await functionAcl(fn), fn).toEqual({
        owner: 'daftar_inventory_internal',
        secdef: true,
        config: ['search_path=pg_catalog, public, pg_temp'],
        grantees: null,
      });
      for (const role of [...RUNTIME_ROLES.map((r) => r.role), 'daftar_accounting_internal', 'daftar_migrator']) {
        expect(await canExecute(role, fn), `${role} → ${fn}`).toBe(false);
      }
    }
  });

  it('daftar_app calling a helper directly is refused 42501', async () => {
    await inTx(async (c) => {
      const A = world.A;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      for (const sql of [
        { text: `SELECT purchase_bridge_return($1::uuid)`, params: [randomUUID()] },
        { text: `SELECT purchase_bridge_credit_note($1::uuid)`, params: [randomUUID()] },
        { text: `SELECT purchase_bridge_reversal($1::uuid)`, params: [randomUUID()] },
        { text: `SELECT purchase_lock_stock_keys($1::uuid, ARRAY[$2::uuid])`, params: [A.w1, A.piece.variantId] },
        { text: `SELECT accounting_purchase_entry_id($1::uuid, $2::uuid)`, params: [A.businessId, randomUUID()] },
      ]) {
        const o = await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_app');
          await c.query(sql.text, sql.params);
        });
        refusedWith(o, '42501', null, sql.text);
      }
    });
  });

  it('accounting_purchase_entry_id is an accounting-owned definer granted to the inventory principal alone', async () => {
    const fn = 'accounting_purchase_entry_id(uuid,uuid)';
    const acl = await functionAcl(fn);
    expect({ owner: acl.owner, secdef: acl.secdef, grantees: acl.grantees }).toEqual({
      owner: 'daftar_accounting_internal',
      secdef: true,
      grantees: ['daftar_inventory_internal'],
    });
    for (const role of [...RUNTIME_ROLES.map((r) => r.role), 'daftar_migrator']) expect(await canExecute(role, fn), `${role} → ${fn}`).toBe(false);
  });
});

describe('T-01 the two read functions: INVOKER, and only what row security shows', () => {
  it('SECURITY INVOKER, STABLE, pinned, not internal-owned; EXECUTE by daftar_app and daftar_inventory_internal only', async () => {
    for (const fn of S5_READ_FUNCTIONS) {
      const acl = await functionAcl(fn);
      expect({ secdef: acl.secdef, config: acl.config, grantees: acl.grantees }, fn).toEqual({
        secdef: false,
        config: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['daftar_app', 'daftar_inventory_internal'],
      });
      expect(['daftar_inventory_internal', 'daftar_accounting_internal', ...RUNTIME_ROLES.map((r) => r.role)], `${fn} owner`).not.toContain(acl.owner);
      const vol = must((await ownerPool().query<{ v: string }>(`SELECT provolatile::text AS v FROM pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0]).v;
      expect(vol, `${fn} is STABLE`).toBe('s');
      for (const { role } of RUNTIME_ROLES) expect(await canExecute(role, fn), `${role} → ${fn}`).toBe(role === 'daftar_app');
    }
  });

  /** Both read functions as `daftar_app` under `scope`'s GUCs, for `biz`'s purchase. */
  async function readAs(c: Client, scope: S3Business, biz: S3Business, purchaseId: string) {
    return attempt(c, async () => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
      await c.query('SET LOCAL ROLE daftar_app');
      const ap = must((await c.query<{ o: string }>(`SELECT purchase_ap_outstanding($1::uuid, $2::uuid)::text AS o`, [biz.businessId, purchaseId])).rows[0]).o;
      const st = must(
        (
          await c.query<{ p: boolean; c: boolean }>(`SELECT payment_allocated AS p, credit_allocated AS c FROM purchase_settlement_state($1::uuid, $2::uuid)`, [
            biz.businessId,
            purchaseId,
          ])
        ).rows[0],
      );
      await c.query('RESET ROLE');
      return { ap, state: [st.p, st.c] };
    });
  }

  it("A reads its own purchase (ALLOW); A2 (same owner) and B are purchase.not_found (DENY); an A return moves A's answer", async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p: ReceivedPurchase = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      const total = must(
        (await c.query<{ t: string }>(`SELECT total_txn_minor::text AS t FROM purchases WHERE business_id = $1 AND id = $2`, [A.businessId, p.purchaseId]))
          .rows[0],
      ).t;
      expect(expectAccepted(await readAs(c, A, A, p.purchaseId), 'A → A')).toEqual({ ap: total, state: [false, false] });
      for (const other of [world.A2, world.B]) {
        // Under the other business's scope, naming A's purchase: row security hides it.
        refusedWith(await readAs(c, other, A, p.purchaseId), 'P0001', 'purchase.not_found', 'another business naming A');
        // Under the other business's scope, naming the other business: A's purchase id is not there.
        refusedWith(await readAs(c, other, other, p.purchaseId), 'P0001', 'purchase.not_found', 'another business, its own id space');
      }
      // Under A's scope, naming A2 or B as the business: no row is visible.
      refusedWith(await readAs(c, A, world.A2, p.purchaseId), 'P0001', 'purchase.not_found', 'A scope naming A2');
      refusedWith(await readAs(c, A, world.B, p.purchaseId), 'P0001', 'purchase.not_found', 'A scope naming B');
      const ret = await prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
      expectAccepted(await tryReturn(c, A, ret));
      expect(expectAccepted(await readAs(c, A, A, p.purchaseId), 'after a return')).toEqual({
        ap: (BigInt(total) - ret.cmd.apTxnMinor).toString(10),
        state: [false, false],
      });
    });
  });
});
