/**
 * P3-S6 T-01 — GRANTS, ACL AND ROW SECURITY OF THE S6 OBJECTS
 * (docs/PHASE_3_S6_CONTRACT.md A-14(d), A-17, §2.3, §2.6, §2.7, §6 T-01;
 * 0063 R-35; 0067 R-72; 0068 R-73).
 *
 * - `daftar_app` holds SELECT on the six tables and NO DML: every INSERT,
 *   UPDATE and DELETE on a real connection is 42501;
 * - `daftar_inventory_internal` holds exactly INSERT + SELECT on the six,
 *   the listed column UPDATEs on `payment_methods`, `UPDATE (display_name)`
 *   and DELETE on the names, and the remaining pair on the credit notes;
 *   `daftar_accounting_internal` reads the four settlement tables and the
 *   notes; every other runtime role, the migrator and PUBLIC hold nothing —
 *   a real SELECT through each credential is 42501;
 * - §2.7 exactly: ENABLE + FORCE RLS, the seven (five on the method tables)
 *   policies per table, the restrictive `_insert/_update/_delete` admit no
 *   principal (no `current_user`), `_read` admits the internal principals by
 *   name, and the credit-note read policy now admits the accounting one;
 * - row security in action: `daftar_app` scoped to A reads A's rows (ALLOW);
 *   scoped to A2 (the same owner, the same tenant) or to B it reads none of
 *   them (DENY); scoped to nothing it reads nothing; the internal principals
 *   read across businesses by their policies;
 * - the EXECUTE matrix: the seven entry routines are internal-owned definers
 *   with the pinned path executable by `daftar_app` alone; the credit-note
 *   writer, the verify helpers, the arithmetic and every guard function have
 *   no grantee; the eligibility function is the accounting principal's,
 *   executable by the inventory principal only; the two discoveries and the
 *   two extension points are migrator-owned invokers.
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
  refusedWith,
  roleClient,
  rolledBack,
  seedS3World,
  settle,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  S6_ACCOUNTING_FUNCTIONS,
  S6_ARITHMETIC,
  S6_KINDS,
  S6_ROUTINE_OF,
  S6_SETTLEMENT_TABLES,
  S6_TABLES,
  S6_TRIGGERS,
  S6_VERIFY,
  S6_WRITER,
  committed,
  createMethod,
  payInFull,
  prepareAllocate,
  prepareRefund,
  runS6,
  seedSettlementAccounts,
  sqlReturnToCredit,
} from '../helpers/supplier-settlement';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's6grants');
  // One row in every S6 table of A: a method (and its names), a payment, a credit allocation and a refund.
  const A = world.A;
  const acc = await seedSettlementAccounts(ownerPool(), A);
  await committed(async (c) => {
    const method = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
    const { creditNoteId, purchase } = await sqlReturnToCredit(c, A, method, { qty: '2', unitPriceMinor: '1000' });
    const target = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '1000' }], { supplierId: purchase.supplierId });
    await runS6(c, A, await prepareAllocate(c, A, { creditNoteId, purchaseId: target.purchaseId, consumedMinor: 400n }));
    await payInFull(c, A, target.purchaseId, target.supplierId, method);
    await runS6(c, A, await prepareRefund(c, A, { creditNoteId, paymentMethodId: method, consumedMinor: 100n }));
  });
});

afterAll(async () => {
  await resetData();
});

interface Privileges {
  readonly s: boolean;
  readonly i: boolean;
  readonly u: boolean;
  readonly d: boolean;
  readonly tr: boolean;
}

const NONE: Privileges = { s: false, i: false, u: false, d: false, tr: false };

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

async function updatableColumns(role: string, table: string): Promise<string[]> {
  const r = await ownerPool().query<{ a: string }>(
    `SELECT attname::text AS a FROM pg_attribute
      WHERE attrelid = $2::regclass AND attnum > 0 AND NOT attisdropped AND has_column_privilege($1, attrelid, attnum, 'UPDATE')
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
                   FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
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

/** The migrator: the owner of the S6 tables. */
async function tableOwner(): Promise<string> {
  return must((await ownerPool().query<{ o: string }>(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'payment_methods'::regclass`)).rows[0])
    .o;
}

const PINNED = ['search_path=pg_catalog, public, pg_temp'];

describe('T-01 A-17: the table grants', () => {
  it('daftar_app: SELECT on the six, no DML, no column UPDATE', async () => {
    for (const t of S6_TABLES) {
      expect(await tablePrivileges('daftar_app', t), t).toEqual({ ...NONE, s: true });
      expect(await updatableColumns('daftar_app', t), `${t} column UPDATE`).toEqual([]);
    }
    expect(await updatableColumns('daftar_app', 'supplier_credit_notes'), 'no UPDATE on the notes').toEqual([]);
  });

  it('daftar_inventory_internal: INSERT + SELECT on the six and exactly the guarded column UPDATEs', async () => {
    for (const t of S6_TABLES) {
      expect(await tablePrivileges('daftar_inventory_internal', t), t).toEqual({ ...NONE, s: true, i: true, d: t === 'payment_method_names' });
    }
    expect(await updatableColumns('daftar_inventory_internal', 'payment_methods')).toEqual(
      [
        'business_transaction_id',
        'is_active',
        'last_intent_sha256',
        'posting_account_id',
        'requires_reference',
        'revision',
        'sort_order',
        'updated_at',
        'updated_by',
      ].sort(),
    );
    expect(await updatableColumns('daftar_inventory_internal', 'payment_method_names')).toEqual(['display_name']);
    for (const t of S6_SETTLEMENT_TABLES) expect(await updatableColumns('daftar_inventory_internal', t), t).toEqual([]);
    expect(await updatableColumns('daftar_inventory_internal', 'supplier_credit_notes')).toEqual([
      'remaining_amount_minor',
      'remaining_carrying_base_amount_minor',
    ]);
    expect(await tablePrivileges('daftar_inventory_internal', 'supplier_credit_notes'), 'no table UPDATE or DELETE on the notes').toMatchObject({
      u: false,
      d: false,
      tr: false,
    });
  });

  it('daftar_accounting_internal: SELECT on the four settlement tables and the notes, nothing else', async () => {
    for (const t of S6_TABLES) {
      expect(await tablePrivileges('daftar_accounting_internal', t), t).toEqual({ ...NONE, s: (S6_SETTLEMENT_TABLES as readonly string[]).includes(t) });
    }
    expect(await tablePrivileges('daftar_accounting_internal', 'supplier_credit_notes')).toEqual({ ...NONE, s: true });
  });

  it('every other runtime role, the migrator and PUBLIC hold nothing; a real SELECT through each credential is 42501', async () => {
    for (const role of [...RUNTIME_ROLES.map((r) => r.role).filter((r) => r !== 'daftar_app'), 'daftar_migrator', 'public']) {
      for (const t of S6_TABLES) expect(await tablePrivileges(role, t), `${role} → ${t}`).toEqual(NONE);
    }
    for (const { role, url } of RUNTIME_ROLES) {
      if (role === 'daftar_app') continue;
      const rc = await roleClient(url);
      try {
        for (const t of S6_TABLES) refusedWith(await settle(() => rc.query(`SELECT count(*) FROM ${t}`)), '42501', null, `${role} SELECT ${t}`);
      } finally {
        await rc.end();
      }
    }
  });

  it('daftar_app on a real connection: every INSERT, UPDATE and DELETE on the six tables (and UPDATE of the notes) is 42501', async () => {
    const A = world.A;
    await rolledBack(async (c: Client) => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      const statements = S6_TABLES.flatMap((t) => [
        `INSERT INTO ${t} (tenant_id, business_id) VALUES ($1, $2)`,
        `UPDATE ${t} SET business_id = $2 WHERE tenant_id = $1`,
        `DELETE FROM ${t} WHERE tenant_id = $1 AND business_id = $2`,
      ]);
      statements.push(`UPDATE supplier_credit_notes SET remaining_amount_minor = 0 WHERE tenant_id = $1 AND business_id = $2`);
      for (const sql of statements) {
        const o = await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_app');
          await c.query(sql, [A.tenantId, A.businessId]);
        });
        refusedWith(o, '42501', null, sql);
      }
    });
  });
});

describe('T-01 §2.7: the policies, exactly', () => {
  interface PolicyRow {
    readonly name: string;
    readonly permissive: string;
    readonly roles: string[];
    readonly cmd: string;
    readonly qual: string | null;
    readonly check: string | null;
  }

  async function policies(table: string): Promise<PolicyRow[]> {
    const r = await ownerPool().query<PolicyRow>(
      `SELECT policyname::text AS name, permissive::text AS permissive, roles::text[] AS roles, cmd::text AS cmd, qual::text AS qual, with_check::text AS "check"
         FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
      [table],
    );
    return r.rows;
  }

  it('ENABLE + FORCE row security and the §2.7 set on each of the six tables; the restrictive writes admit no principal', async () => {
    for (const t of S6_TABLES) {
      const rls = must(
        (
          await ownerPool().query<{ on: boolean; forced: boolean }>(
            `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass`,
            [t],
          )
        ).rows[0],
      );
      expect(rls, t).toEqual({ on: true, forced: true });
      const settlement = (S6_SETTLEMENT_TABLES as readonly string[]).includes(t);
      const ps = await policies(t);
      expect(
        ps.map((p) => [p.name, p.permissive, p.roles.join(','), p.cmd]),
        t,
      ).toEqual([
        ...(settlement ? [['accounting_validator', 'PERMISSIVE', 'daftar_accounting_internal', 'SELECT']] : []),
        ['business_isolation_delete', 'RESTRICTIVE', 'public', 'DELETE'],
        ['business_isolation_insert', 'RESTRICTIVE', 'public', 'INSERT'],
        ['business_isolation_read', 'RESTRICTIVE', 'public', 'SELECT'],
        ['business_isolation_update', 'RESTRICTIVE', 'public', 'UPDATE'],
        ['inventory_internal_read', 'PERMISSIVE', 'daftar_inventory_internal', 'SELECT'],
        ['tenant_membership', 'PERMISSIVE', 'public', 'ALL'],
      ]);
      for (const p of ps.filter((x) => /^business_isolation_(insert|update|delete)$/.test(x.name))) {
        expect(`${p.qual ?? ''} ${p.check ?? ''}`, `${t}.${p.name} admits no principal`).not.toMatch(/current_user|daftar_/);
      }
      const read = must(ps.find((p) => p.name === 'business_isolation_read'));
      expect(read.qual, `${t} read admits the inventory principal`).toContain('daftar_inventory_internal');
      if (settlement) expect(read.qual, `${t} read admits the accounting principal`).toContain('daftar_accounting_internal');
      else expect(read.qual, `${t} read does not admit the accounting principal`).not.toContain('daftar_accounting_internal');
    }
  });

  it('supplier_credit_notes: the read policy admits the accounting principal, which has its own validator policy (A-14(d))', async () => {
    const ps = await policies('supplier_credit_notes');
    expect(must(ps.find((p) => p.name === 'business_isolation_read')).qual).toContain('daftar_accounting_internal');
    expect(ps.find((p) => p.name === 'accounting_validator')).toMatchObject({
      permissive: 'PERMISSIVE',
      roles: ['daftar_accounting_internal'],
      cmd: 'SELECT',
      qual: 'true',
    });
  });
});

describe('T-01 row security in action', () => {
  async function visible(c: Client, role: string, scope: S3Business | null, table: string, owner: S3Business): Promise<number> {
    const o = await attempt(c, async () => {
      if (scope !== null)
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
      else await c.query(`SELECT set_config('app.tenant_id', '', true), set_config('app.business_id', '', true)`);
      await c.query(`SET LOCAL ROLE ${role}`);
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [owner.businessId]);
      await c.query('RESET ROLE');
      return must(r.rows[0]).n;
    });
    return expectAccepted(o, `${role} reads ${table}`);
  }

  it('daftar_app reads A’s rows in A (ALLOW) and none of them from A2, B or no scope (DENY); the internal principals read by their policies', async () => {
    const { A, A2, B } = world;
    await rolledBack(async (c) => {
      for (const t of S6_TABLES) {
        expect(await visible(c, 'daftar_app', A, t, A), `A reads its ${t}`).toBeGreaterThan(0);
        expect(await visible(c, 'daftar_app', A2, t, A), `A2 (same owner) reads A's ${t}`).toBe(0);
        expect(await visible(c, 'daftar_app', B, t, A), `B reads A's ${t}`).toBe(0);
        expect(await visible(c, 'daftar_app', null, t, A), `no scope reads A's ${t}`).toBe(0);
        expect(await visible(c, 'daftar_inventory_internal', null, t, A), `the inventory principal reads ${t}`).toBeGreaterThan(0);
      }
      for (const t of [...S6_SETTLEMENT_TABLES, 'supplier_credit_notes']) {
        expect(await visible(c, 'daftar_accounting_internal', null, t, A), `the accounting principal reads ${t}`).toBeGreaterThan(0);
      }
    });
  });
});

describe('T-01 the EXECUTE matrix', () => {
  it('the seven entry routines: internal-owned definers, pinned, executable by daftar_app alone', async () => {
    for (const kind of S6_KINDS) {
      const fn = S6_ROUTINE_OF[kind];
      expect(await functionAcl(fn), fn).toEqual({ owner: 'daftar_inventory_internal', secdef: true, config: PINNED, grantees: ['daftar_app'] });
      for (const { role } of RUNTIME_ROLES) expect(await canExecute(role, fn), `${role} → ${kind}`).toBe(role === 'daftar_app');
      for (const role of ['daftar_accounting_internal', 'daftar_migrator', 'public']) expect(await canExecute(role, fn), `${role} → ${kind}`).toBe(false);
    }
  });

  it('every other runtime role is refused EXECUTE on its own connection', async () => {
    for (const { role, url } of RUNTIME_ROLES) {
      if (role === 'daftar_app') continue;
      const rc = await roleClient(url);
      try {
        refusedWith(await settle(() => rc.query(`SELECT * FROM payment_method_deactivate($1::uuid, 1)`, [randomUUID()])), '42501', null, role);
      } finally {
        await rc.end();
      }
    }
  });

  it('the credit-note writer, the verify helpers, the arithmetic and every guard function: internal-owned definers with no grantee', async () => {
    const guardFunctions = [...new Set(S6_TRIGGERS.map((r) => r[4]))];
    for (const fn of [S6_WRITER, ...S6_VERIFY, ...S6_ARITHMETIC, ...guardFunctions]) {
      expect(await functionAcl(fn), fn).toEqual({ owner: 'daftar_inventory_internal', secdef: true, config: PINNED, grantees: null });
      for (const role of [...RUNTIME_ROLES.map((r) => r.role), 'daftar_accounting_internal', 'daftar_migrator']) {
        expect(await canExecute(role, fn), `${role} → ${fn}`).toBe(false);
      }
    }
    await rolledBack(async (c) => {
      const o = await attempt(c, async () => {
        await c.query('SET LOCAL ROLE daftar_app');
        await c.query(`SELECT supplier_credit_note_consume($1::uuid, 1, 1)`, [randomUUID()]);
      });
      refusedWith(o, '42501', null, 'daftar_app calls the writer directly');
    });
  });

  it('the accounting functions: the eligibility is executable by the inventory principal only; the three completeness functions by nobody', async () => {
    const [eligibility, ...completeness] = S6_ACCOUNTING_FUNCTIONS;
    expect(await functionAcl(must(eligibility))).toEqual({
      owner: 'daftar_accounting_internal',
      secdef: true,
      config: PINNED,
      grantees: ['daftar_inventory_internal'],
    });
    for (const fn of completeness)
      expect(await functionAcl(fn), fn).toEqual({ owner: 'daftar_accounting_internal', secdef: true, config: PINNED, grantees: null });
    for (const { role } of RUNTIME_ROLES) expect(await canExecute(role, must(eligibility)), role).toBe(false);
  });

  it('the two discoveries (no grantee) and the two extension points (daftar_app and the inventory principal) are migrator-owned invokers', async () => {
    const migrator = await tableOwner();
    for (const fn of ['supplier_settlement_guard_gaps()', 'inventory_stock_source_guard_gaps()']) {
      expect(await functionAcl(fn), fn).toMatchObject({ owner: migrator, secdef: false, grantees: null });
    }
    for (const fn of ['purchase_ap_outstanding(uuid,uuid)', 'purchase_settlement_state(uuid,uuid)']) {
      expect(await functionAcl(fn), fn).toMatchObject({ owner: migrator, secdef: false, grantees: ['daftar_app', 'daftar_inventory_internal'] });
    }
  });
});
