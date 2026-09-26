import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';

/**
 * P3-S1 — THE INVENTORY PRINCIPAL AND ITS GRANT MATRIX (P3-AL-54 §A-§H).
 *
 * Every fact here is read from the live catalogue — pg_roles,
 * pg_auth_members, information_schema and pg_policy — or proven by a raw
 * connection trying the thing and being refused. Nothing goes through the
 * application.
 *
 * The routines themselves (assertion consumption, the three entry commands,
 * the warehouse lifecycle and TD-09) are proven in
 * tests/integration/inventory-db-routines.test.ts; the §D definer contract in
 * tests/security/search-path-shadowing.test.ts.
 */

const INTERNAL = 'daftar_inventory_internal';
const RUNTIME_ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
] as const;
const NEW_TABLES = ['units', 'unit_names', 'inventory_operation_kinds', 'inventory_assertion_keys', 'inventory_assertion_uses', 'branch_warehouses'] as const;

interface Fixture {
  tenantA: string;
  businessA: string;
  branchA: string;
  warehouseA: string;
  productA: string;
  tenantB: string;
  businessB: string;
  branchB: string;
  warehouseB: string;
}
let fx: Fixture;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ id: string }>(sql, params);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`fixture statement returned no id: ${sql}`);
  return id;
}

async function seedBusiness(slug: string): Promise<{ tenant: string; business: string; branch: string; warehouse: string }> {
  const tenant = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const business = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenant, `Inventory ${slug}`, `inv-auth-${slug}-${Date.now()}`],
  );
  const branch = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [business]);
  const warehouse = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
    business,
    branch,
  ]);
  return { tenant, business, branch, warehouse };
}

/** A committed, unconfigured product with its one required translation (the translation check is deferred). */
async function createProduct(business: string): Promise<string> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    const id = randomUUID();
    await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 1000, 'ILS')`, [business, id]);
    await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Inventory test product')`, [business, id]);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A raw connection as a runtime role, in one transaction with the given transaction-local GUCs, always rolled back. */
async function asRole<T>(url: string, gucs: Record<string, string>, run: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    return await run(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/** The superuser, `SET LOCAL ROLE` to the internal principal — how every entry routine's body runs — always rolled back. */
async function asInternal<T>(gucs: Record<string, string>, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    await c.query(`SET LOCAL ROLE ${INTERNAL}`);
    return await run(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** The error message of `run`, or null when it succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const scopeA = (): Record<string, string> => ({ 'app.tenant_id': fx.tenantA, 'app.business_id': fx.businessA });

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const a = await seedBusiness('a');
  const b = await seedBusiness('b');
  const productA = await createProduct(a.business);
  fx = {
    tenantA: a.tenant,
    businessA: a.business,
    branchA: a.branch,
    warehouseA: a.warehouse,
    productA,
    tenantB: b.tenant,
    businessB: b.business,
    branchB: b.branch,
    warehouseB: b.warehouse,
  };
});

describe('the inventory principal (P3-AL-54 §A, must-prove 5-7)', () => {
  it('is NOLOGIN NOINHERIT, has no password, and holds no role attribute', async () => {
    const r = await ownerPool().query(
      `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolpassword IS NULL AS no_password
       FROM pg_authid WHERE rolname = $1`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([
      {
        rolcanlogin: false,
        rolinherit: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        no_password: true,
      },
    ]);
  });

  it('has exactly one member — the migrator, WITH INHERIT FALSE, SET TRUE, no ADMIN — and is a member of nothing', async () => {
    const members = await ownerPool().query(
      `SELECT m.rolname AS member, a.inherit_option, a.set_option, a.admin_option
       FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
       WHERE r.rolname = $1`,
      [INTERNAL],
    );
    expect(members.rows).toEqual([{ member: 'daftar_migrator', inherit_option: false, set_option: true, admin_option: false }]);

    const memberOf = await ownerPool().query(
      `SELECT r.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = $1`,
      [INTERNAL],
    );
    expect(memberOf.rows).toEqual([]);
  });

  it.each(RUNTIME_ROLES)('%s cannot reach the principal by membership, inheritance or SET ROLE', async (role) => {
    const r = await ownerPool().query<{ member: boolean; usage: boolean; set: boolean }>(
      `SELECT pg_has_role($1, $2, 'MEMBER') AS member, pg_has_role($1, $2, 'USAGE') AS usage, pg_has_role($1, $2, 'SET') AS set`,
      [role, INTERNAL],
    );
    expect(r.rows[0]).toEqual({ member: false, usage: false, set: false });
  });

  it('a stolen daftar_app credential cannot SET ROLE to it', async () => {
    const message = await asRole(appDbUrl, {}, (c) => refusal(() => c.query(`SET ROLE ${INTERNAL}`)));
    expect(message).toMatch(/permission denied to set role/i);
  });

  it('holds no TEMPORARY and no CREATE on schema public, and USAGE only', async () => {
    const r = await ownerPool().query(
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
              has_database_privilege($1, current_database(), 'CREATE') AS dbcreate,
              has_schema_privilege($1, 'public', 'CREATE') AS create,
              has_schema_privilege($1, 'public', 'USAGE') AS usage`,
      [INTERNAL],
    );
    expect(r.rows[0]).toEqual({ temp: false, dbcreate: false, create: false, usage: true });
  });
});

describe('the §H grant matrix, from information_schema and pg_policy (P3-AL-54 §H)', () => {
  it('the internal principal holds exactly these table privileges', async () => {
    const r = await ownerPool().query<{ t: string; p: string }>(
      `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY table_name ORDER BY table_name`,
      [INTERNAL],
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.t, x.p]))).toEqual({
      audit_events: 'INSERT',
      branch_warehouses: 'DELETE,INSERT,SELECT',
      branches: 'SELECT',
      businesses: 'SELECT',
      inventory_assertion_keys: 'INSERT,SELECT,UPDATE',
      inventory_assertion_uses: 'DELETE,INSERT,SELECT',
      inventory_operation_kinds: 'SELECT',
      product_variants: 'SELECT',
      products: 'SELECT',
      units: 'SELECT',
      warehouses: 'SELECT',
    });
  });

  it('and exactly these column privileges beyond them: three products columns to UPDATE, four product_variants columns to INSERT', async () => {
    const r = await ownerPool().query<{ t: string; p: string; cols: string }>(
      `SELECT c.table_name AS t, c.privilege_type AS p, string_agg(c.column_name, ',' ORDER BY c.column_name) AS cols
       FROM information_schema.column_privileges c
       WHERE c.grantee = $1
         AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                          WHERE g.grantee = c.grantee AND g.table_name = c.table_name AND g.privilege_type = c.privilege_type)
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([
      { t: 'product_variants', p: 'INSERT', cols: 'business_id,id,is_base,product_id' },
      { t: 'products', p: 'UPDATE', cols: 'track_inventory,unit_code,unit_decimals' },
    ]);
  });

  it('on the six new tables, every grantee and privilege is exactly the matrix', async () => {
    const r = await ownerPool().query<{ g: string; t: string; p: string }>(
      `SELECT grantee AS g, table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants
       WHERE table_name = ANY ($1::text[])
         AND grantee <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = ('public.' || table_name)::regclass)
       GROUP BY 1, 2 ORDER BY 2, 1`,
      [NEW_TABLES],
    );
    expect(r.rows).toEqual([
      { g: 'daftar_app', t: 'branch_warehouses', p: 'SELECT' },
      { g: INTERNAL, t: 'branch_warehouses', p: 'DELETE,INSERT,SELECT' },
      { g: INTERNAL, t: 'inventory_assertion_keys', p: 'INSERT,SELECT,UPDATE' },
      { g: INTERNAL, t: 'inventory_assertion_uses', p: 'DELETE,INSERT,SELECT' },
      { g: INTERNAL, t: 'inventory_operation_kinds', p: 'SELECT' },
      { g: 'daftar_app', t: 'unit_names', p: 'SELECT' },
      { g: 'daftar_app', t: 'units', p: 'SELECT' },
      { g: INTERNAL, t: 'units', p: 'SELECT' },
    ]);
  });

  it('no runtime role holds any privilege on the key store or the replay registry', async () => {
    const r = await ownerPool().query<{ g: string; t: string }>(
      `SELECT grantee AS g, table_name AS t FROM information_schema.role_table_grants
       WHERE table_name IN ('inventory_assertion_keys', 'inventory_assertion_uses', 'inventory_operation_kinds') AND grantee = ANY ($1::text[])`,
      [[...RUNTIME_ROLES, 'PUBLIC']],
    );
    expect(r.rows).toEqual([]);
  });

  it('daftar_app keeps SELECT, INSERT, UPDATE on products and product_variants and gains no DELETE', async () => {
    const r = await ownerPool().query<{ t: string; p: string }>(
      `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
       WHERE grantee = 'daftar_app' AND table_name IN ('products', 'product_variants') GROUP BY 1 ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { t: 'product_variants', p: 'INSERT,SELECT,UPDATE' },
      { t: 'products', p: 'INSERT,SELECT,UPDATE' },
    ]);
  });

  it('routine EXECUTE grants on the internal routines are exactly the matrix', async () => {
    const r = await ownerPool().query<{ g: string; r: string }>(
      `SELECT g.grantee AS g, g.routine_name AS r
       FROM information_schema.role_routine_grants g
       JOIN pg_proc p ON p.proname = g.routine_name
       JOIN pg_roles o ON o.oid = p.proowner
       WHERE o.rolname = $1 AND g.privilege_type = 'EXECUTE' AND g.grantee <> $1
       ORDER BY 2, 1`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([
      { g: 'daftar_platform', r: 'inventory_assertion_key_install' },
      { g: 'daftar_platform', r: 'inventory_assertion_key_retire' },
      { g: 'daftar_app', r: 'inventory_configure_product' },
      { g: 'daftar_app', r: 'structure_associate_warehouse_branch' },
      { g: 'daftar_app', r: 'structure_dissociate_warehouse_branch' },
    ]);
  });

  it('branch_warehouses and warehouses ENABLE and FORCE row level security', async () => {
    const r = await ownerPool().query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('branch_warehouses', 'warehouses') AND relkind = 'r' ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { relname: 'branch_warehouses', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'warehouses', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('branch_warehouses carries exactly the accepted pair plus the internal read/insert admission', async () => {
    const r = await ownerPool().query(
      `SELECT polname, polpermissive, polcmd::text AS cmd,
              ARRAY(SELECT CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END FROM unnest(polroles) AS x ORDER BY 1)::text[] AS roles,
              pg_get_expr(polqual, polrelid) AS using, pg_get_expr(polwithcheck, polrelid) AS check
       FROM pg_policy WHERE polrelid = 'branch_warehouses'::regclass ORDER BY polname`,
    );
    const isolation = `(app_bypass() OR ((business_id)::text = app_business()) OR ((CURRENT_USER = '${INTERNAL}'::name) AND (COALESCE(app_business(), ''::text) = ''::text)))`;
    expect(r.rows.map((p: { polname: string }) => p.polname)).toEqual([
      'business_isolation',
      'inventory_internal_insert',
      'inventory_internal_read',
      'tenant_membership',
    ]);
    expect(r.rows[0]).toMatchObject({ polname: 'business_isolation', polpermissive: false, cmd: '*', roles: ['public'], using: isolation, check: isolation });
    expect(r.rows[1]).toMatchObject({ polname: 'inventory_internal_insert', polpermissive: true, cmd: 'a', roles: [INTERNAL], using: null, check: 'true' });
    expect(r.rows[2]).toMatchObject({ polname: 'inventory_internal_read', polpermissive: true, cmd: 'r', roles: [INTERNAL], using: 'true', check: null });
    expect(r.rows[3]).toMatchObject({ polname: 'tenant_membership', polpermissive: true, cmd: '*', roles: ['public'] });
    expect(String(r.rows[3]?.using)).toContain('app_tenant()');
  });
});

describe('branch_warehouses isolation of the internal principal (Agent 0 ruling on 0032:17 / 0052:244)', () => {
  const countRows = async (c: PoolClient, business: string): Promise<number> =>
    Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [business])).rows[0]?.n);

  it('inside an entry-routine scope of business A, it sees A and cannot see B', async () => {
    const [a, b] = await asInternal(scopeA(), async (c) => [await countRows(c, fx.businessA), await countRows(c, fx.businessB)]);
    expect(a).toBe(1);
    expect(b).toBe(0);
  });

  it('inside a scope of business A, it cannot insert a row for business B', async () => {
    const message = await asInternal(scopeA(), (c) =>
      refusal(() =>
        c.query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [fx.businessB, fx.branchB, fx.warehouseB]),
      ),
    );
    expect(message).toMatch(/row-level security policy/i);
  });

  it('inside a scope of business A, it cannot delete business B rows — they are not there to delete', async () => {
    const deleted = await asInternal(scopeA(), async (c) => (await c.query(`DELETE FROM branch_warehouses WHERE business_id = $1`, [fx.businessB])).rowCount);
    expect(deleted).toBe(0);
    const still = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [fx.businessB]);
    expect(still.rows[0]?.n).toBe('1');
  });

  it('a scope that names the tenant of B but the business of A still cannot reach B', async () => {
    const [b, message] = await asInternal({ 'app.tenant_id': fx.tenantB, 'app.business_id': fx.businessA }, async (c) => [
      await countRows(c, fx.businessB),
      await refusal(() =>
        c.query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
          fx.businessB,
          fx.branchB,
          fx.warehouseB,
        ]),
      ),
    ]);
    expect(b).toBe(0);
    expect(message).toMatch(/row-level security policy/i);
  });

  it('only with NO business scope is it admitted across businesses — the approved onboarding admission, and only for this principal', async () => {
    const [a, b] = await asInternal({}, async (c) => [await countRows(c, fx.businessA), await countRows(c, fx.businessB)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    // The same empty scope admits nothing to the merchant runtime.
    const app = await asRole(appDbUrl, {}, async (c) => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses`)).rows[0]?.n));
    expect(app).toBe(0);
  });

  it('daftar_app scoped to A reads A only and cannot write at all', async () => {
    const [a, b, ins, del] = await asRole(appDbUrl, scopeA(), async (c) => [
      Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [fx.businessA])).rows[0]?.n),
      Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [fx.businessB])).rows[0]?.n),
      await c
        .query('SAVEPOINT s')
        .then(() => refusal(() => c.query(`INSERT INTO branch_warehouses VALUES ($1, $2, $3)`, [fx.businessA, fx.branchA, fx.warehouseA]))),
      await c.query('ROLLBACK TO SAVEPOINT s').then(() => refusal(() => c.query(`DELETE FROM branch_warehouses WHERE business_id = $1`, [fx.businessA]))),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(ins).toMatch(/permission denied/i);
    expect(del).toMatch(/permission denied/i);
  });
});

describe('the column guards (P3-AL-54 §F, P3-AL-52)', () => {
  const app = <T>(run: (c: Client) => Promise<T>): Promise<T> => asRole(appDbUrl, scopeA(), run);

  it('daftar_app cannot turn tracking on, set a unit or set a precision on an existing product', async () => {
    for (const set of [`track_inventory = true`, `unit_code = 'piece'`, `unit_decimals = 0`]) {
      const message = await app((c) => refusal(() => c.query(`UPDATE products SET ${set} WHERE id = $1`, [fx.productA])));
      expect(message, set).toMatch(/inventory\.configuration_authority_required/);
    }
  });

  it('daftar_app cannot insert a product that is already configured', async () => {
    const message = await app((c) =>
      refusal(() => c.query(`INSERT INTO products (business_id, base_price_minor, price_currency, unit_code) VALUES ($1, 1, 'ILS', 'piece')`, [fx.businessA])),
    );
    expect(message).toMatch(/inventory\.configuration_authority_required/);
  });

  it('daftar_app still edits every other products column, and inserts an unconfigured product', async () => {
    const updated = await app(async (c) => (await c.query(`UPDATE products SET base_price_minor = 2000 WHERE id = $1`, [fx.productA])).rowCount);
    expect(updated).toBe(1);
    const inserted = await app(
      async (c) => (await c.query(`INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ($1, 1, 'ILS')`, [fx.businessA])).rowCount,
    );
    expect(inserted).toBe(1);
  });

  it('the schema owner is held to the same rule — the guard is not an ACL', async () => {
    const message = await refusal(() =>
      ownerPool().query(`UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE id = $1`, [fx.productA]),
    );
    expect(message).toMatch(/inventory\.configuration_authority_required/);
  });

  it('daftar_app cannot insert a base variant', async () => {
    const message = await app((c) =>
      refusal(() => c.query(`INSERT INTO product_variants (business_id, product_id, is_base) VALUES ($1, $2, true)`, [fx.businessA, fx.productA])),
    );
    expect(message).toMatch(/catalog\.base_variant_not_mutable/);
  });

  it('daftar_app cannot update a base variant, nor turn a merchant variant into one', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [fx.tenantA, fx.businessA]);
      await c.query(`SET LOCAL ROLE ${INTERNAL}`);
      const base = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [fx.businessA, base, fx.productA]);
      await c.query(`RESET ROLE`);
      // Now as daftar_app itself, with the same scope: the guard decides by
      // current_user, and anyone but the internal principal is refused.
      await c.query(`SET LOCAL ROLE daftar_app`);
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE product_variants SET sku = sku WHERE id = $1`, [base])).rejects.toThrow(/catalog\.base_variant_not_mutable/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      const merchant = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id) VALUES ($1, $2, $3)`, [fx.businessA, merchant, fx.productA]);
      await expect(c.query(`UPDATE product_variants SET is_base = true WHERE id = $1`, [merchant])).rejects.toThrow(/catalog\.base_variant_not_mutable/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('daftar_app still inserts and updates merchant variants', async () => {
    const n = await app(async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, sku) VALUES ($1, $2, $3, $4)`, [
        fx.businessA,
        id,
        fx.productA,
        `SKU-${id.slice(0, 8)}`,
      ]);
      return (await c.query(`UPDATE product_variants SET sku = $2 WHERE id = $1`, [id, `SKU2-${id.slice(0, 8)}`])).rowCount;
    });
    expect(n).toBe(1);
  });

  it('the internal principal writes base variants only, never a merchant one', async () => {
    const message = await asInternal(scopeA(), (c) =>
      refusal(() =>
        c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, false)`, [fx.businessA, randomUUID(), fx.productA]),
      ),
    );
    expect(message).toMatch(/catalog\.base_variant_not_mutable: the inventory principal writes base variants only/);
  });

  it('the internal principal holds no UPDATE or DELETE on variants and no UPDATE of any other products column', async () => {
    for (const sql of [
      `UPDATE product_variants SET sku = NULL WHERE product_id = '${fx.productA}'`,
      `DELETE FROM product_variants WHERE product_id = '${fx.productA}'`,
      `UPDATE products SET base_price_minor = 1 WHERE id = '${fx.productA}'`,
      `DELETE FROM products WHERE id = '${fx.productA}'`,
      `INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ('${fx.businessA}', 1, 'ILS')`,
    ]) {
      const message = await asInternal(scopeA(), (c) => refusal(() => c.query(sql)));
      expect(message, sql).toMatch(/permission denied/i);
    }
  });

  it('a tracked product needs a unit, even for the principal allowed to write the columns', async () => {
    const message = await asInternal(scopeA(), (c) => refusal(() => c.query(`UPDATE products SET track_inventory = true WHERE id = $1`, [fx.productA])));
    expect(message).toMatch(/products_tracked_requires_unit_ck/);
  });

  it('a base variant can hold no merchant identity — the CHECK holds even with the guard trigger switched off', async () => {
    // No writer can reach this CHECK with the guard in place (daftar_app is
    // refused by the guard, the internal principal cannot name sku at all),
    // so the guard is disabled inside a rolled-back transaction to prove the
    // constraint underneath it is real, not decorative.
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE product_variants DISABLE TRIGGER product_variants_10_base_variant_authority`);
      const message = await refusal(() =>
        c.query(`INSERT INTO product_variants (business_id, product_id, is_base, sku) VALUES ($1, $2, true, 'MERCHANT-SKU')`, [fx.businessA, fx.productA]),
      );
      expect(message).toMatch(/product_variants_base_shape_ck/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('a product has at most one base variant', async () => {
    const message = await asInternal(scopeA(), async (c) => {
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [fx.businessA, randomUUID(), fx.productA]);
      return refusal(() =>
        c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [fx.businessA, randomUUID(), fx.productA]),
      );
    });
    expect(message).toMatch(/product_variants_one_base_uq/);
  });
});

describe('invctl/1 key management through daftar_platform (P3-AL-55 §C)', () => {
  const platform = async <T>(run: (c: Client) => Promise<T>): Promise<T> => {
    const c = new Client({ connectionString: platformDbUrl });
    await c.connect();
    try {
      return await run(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  };
  const kid = `authz-${randomUUID().slice(0, 8)}`;
  const secret = randomBytes(32);

  it('installs a key, and the same kid with the same secret is idempotent', async () => {
    await platform(async (c) => {
      await c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret]);
      await c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret]);
    });
    const r = await ownerPool().query(`SELECT status, secret = $2 AS same FROM inventory_assertion_keys WHERE kid = $1`, [kid, secret]);
    expect(r.rows).toEqual([{ status: 'active', same: true }]);
  });

  it('the same kid with a different secret raises inventory.assertion_key_conflict and changes nothing', async () => {
    const message = await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, randomBytes(32)])));
    expect(message).toMatch(/inventory\.assertion_key_conflict/);
    expect(message).not.toContain(secret.toString('hex'));
    const r = await ownerPool().query(`SELECT secret = $2 AS same FROM inventory_assertion_keys WHERE kid = $1`, [kid, secret]);
    expect(r.rows).toEqual([{ same: true }]);
  });

  it('refuses a short secret or a malformed kid', async () => {
    expect(await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [`${kid}x`, randomBytes(31)])))).toMatch(
      /inventory\.assertion_key_invalid/,
    );
    expect(await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, ['bad kid!', randomBytes(32)])))).toMatch(
      /inventory\.assertion_key_invalid/,
    );
  });

  it('the platform cannot read the keys back, nor write them directly', async () => {
    for (const sql of [
      `SELECT secret FROM inventory_assertion_keys`,
      `SELECT count(*) FROM inventory_assertion_keys`,
      `SELECT * FROM inventory_assertion_uses`,
      `INSERT INTO inventory_assertion_keys (kid, secret) VALUES ('direct', decode(repeat('00', 32), 'hex'))`,
      `UPDATE inventory_assertion_keys SET status = 'retired'`,
      `DELETE FROM inventory_assertion_keys`,
    ]) {
      const message = await platform((c) => refusal(() => c.query(sql)));
      expect(message, sql).toMatch(/permission denied/i);
    }
  });

  it.each([
    ['daftar_app', appDbUrl],
    ['daftar_worker', workerDbUrl],
    ['daftar_identity', identityDbUrl],
    ['daftar_resolver', resolverDbUrl],
    ['daftar_provisioner', provisionerDbUrl],
  ])('%s cannot install or retire a key', async (_role, url) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      expect(await refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [`${kid}y`, randomBytes(32)]))).toMatch(/permission denied/i);
      expect(await refusal(() => c.query(`SELECT inventory_assertion_key_retire($1)`, [kid]))).toMatch(/permission denied/i);
    } finally {
      await c.end().catch(() => undefined);
    }
  });

  it('retire is terminal and idempotent, and a retired kid is never reinstated', async () => {
    await platform(async (c) => {
      await c.query(`SELECT inventory_assertion_key_retire($1)`, [kid]);
      await c.query(`SELECT inventory_assertion_key_retire($1)`, [kid]);
    });
    const r = await ownerPool().query(`SELECT status, retired_at IS NOT NULL AS stamped FROM inventory_assertion_keys WHERE kid = $1`, [kid]);
    expect(r.rows).toEqual([{ status: 'retired', stamped: true }]);
    const message = await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret])));
    expect(message).toMatch(/inventory\.assertion_key_conflict/);
  });
});
