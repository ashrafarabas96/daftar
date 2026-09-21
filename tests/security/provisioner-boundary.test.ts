import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, provisionerDbUrl, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * Ultimate Closure §15–21 — PROVISIONER NEGATIVE DB TESTS.
 * daftar_provisioner is NOT in app_bypass() and holds NO table CRUD. Its only
 * authority is EXECUTE on the narrow provisioning SECURITY DEFINER commands.
 * Every direct cross-tenant action below MUST fail at the database.
 */
describe('provisioner boundary (§15–21): no bypass, EXECUTE-only authority', () => {
  let t: TestApp;

  async function asProvisioner(fn: (c: Client) => Promise<unknown>): Promise<unknown> {
    const c = new Client({ connectionString: provisionerDbUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  it('app_bypass() names ONLY the platform principal (provisioner removed)', async () => {
    t = await createTestApp();
    await resetData();
    const { rows } = await ownerPool().query<{ def: string }>(`SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname = 'app_bypass'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.def).toContain('daftar_platform');
    expect(rows[0]?.def).not.toContain('daftar_provisioner');
    // and behaviorally: provisioner is not a bypass principal
    const bypass = await asProvisioner((c) => c.query('SELECT app_bypass() AS b'));
    expect((bypass as { rows: { b: boolean }[] }).rows[0]?.b).toBe(false);
    await t.close();
  });

  it('provisioner holds no table CRUD beyond the global slug directory', async () => {
    const { rows } = await ownerPool().query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'daftar_provisioner' ORDER BY table_name, privilege_type`,
    );
    const allowed = new Set(['reserved_store_slugs:SELECT']);
    for (const r of rows) {
      expect(allowed.has(`${r.table_name}:${r.privilege_type}`), `${r.table_name}:${r.privilege_type} must not be granted`).toBe(true);
    }
  });

  it('EXECUTE authority: exactly the provisioning commands, never PUBLIC', async () => {
    const { rows } = await ownerPool().query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'provision_%'
         AND has_function_privilege('daftar_provisioner', p.oid, 'EXECUTE')
       ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'provision_accept_invitation',
      'provision_assert_tenant_owner',
      'provision_create_business',
      'provision_create_tenant',
      'provision_expire_invitation',
      'provision_peek_invitation',
      'provision_persist_operation',
      'provision_replay_operation',
    ]);
    // PUBLIC EXECUTE is revoked: the function ACL contains no empty-name grant.
    const { rows: pub } = await ownerPool().query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'provision_%'
         AND p.proacl::text LIKE '%=%/daftar%' ESCAPE '' -- any grant entry
         AND p.proacl::text ~ '(^|{)='`, // grant to PUBLIC (empty grantee)
    );
    expect(pub).toEqual([]);
  });

  it('NEGATIVE: direct cross-tenant actions all FAIL at the DB (§21 matrix)', async () => {
    const errs: string[] = [];
    const attempt = async (label: string, sql: string): Promise<void> => {
      try {
        await asProvisioner((c) => c.query(sql));
        errs.push(`${label}: SUCCEEDED (must fail)`);
      } catch {
        // expected — permission denied / RLS violation
      }
    };
    // SELECT all tenants / arbitrary businesses / memberships
    await attempt('select tenants', 'SELECT * FROM tenants');
    await attempt('select businesses', 'SELECT * FROM businesses');
    await attempt('select memberships', 'SELECT * FROM memberships');
    // INSERT owner into an existing unrelated tenant
    await attempt(
      'insert owner into unrelated tenant',
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES (gen_random_uuid(), gen_random_uuid(), 'tenant_owner')`,
    );
    // DELETE unrelated membership
    await attempt('delete membership', 'DELETE FROM memberships WHERE true');
    // INSERT arbitrary owner role
    await attempt(
      'insert owner role',
      `INSERT INTO membership_roles (business_id, user_id, role_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    );
    // INSERT entitlement for unrelated business
    await attempt(
      'insert entitlement',
      `INSERT INTO business_entitlements (business_id, plan_version_id, state) VALUES (gen_random_uuid(), gen_random_uuid(), 'active')`,
    );
    // UPDATE unrelated invitation
    await attempt('update invitation', `UPDATE business_invitations SET status = 'cancelled' WHERE true`);
    // Read credential payload
    await attempt('read credential payload', 'SELECT secret_ciphertext FROM credential_deliveries');
    // Grant platform role
    await attempt('grant platform role', `INSERT INTO platform_role_memberships (user_id, role_key) VALUES (gen_random_uuid(), 'super_admin')`);
    // Modify feature flag / plan
    await attempt('modify feature flag', 'UPDATE feature_flags SET enabled = true WHERE true');
    await attempt('modify plan', `UPDATE plans SET name = 'hacked' WHERE true`);
    // Write catalog arbitrarily
    await attempt('write catalog', `INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES (gen_random_uuid(), 'X', '0', 'ILS')`);
    // audit/outbox injection
    await attempt('inject audit', `INSERT INTO audit_events (action, entity) VALUES ('x', 'x')`);
    await attempt('inject outbox', `INSERT INTO outbox_events (type, payload) VALUES ('x', '{}')`);
    expect(errs).toEqual([]);
  });

  it('POSITIVE: provisioning commands execute (peek round-trip through the API surface)', async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'P',
      preferredLocale: 'ar',
    });
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-prov`)
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .send({ businessName: 'Prov Co', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `prov-${Date.now()}` });
    // Onboarding itself ran entirely through provision_* EXECUTE authority.
    expect(on.status).toBe(201);
    // peek of a nonexistent token is an empty set, not a permission error
    const peek = await asProvisioner((c) => c.query(`SELECT * FROM provision_peek_invitation('nope')`));
    expect((peek as { rows: unknown[] }).rows).toEqual([]);
    await t.close();
  });
});
