import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import {
  appDbUrl,
  createTestApp,
  identityDbUrl,
  mintTestAssertion,
  ownerPool,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  uniqueEmail,
  workerDbUrl,
  type TestApp,
} from '../helpers/test-app';

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
      'provision_create_business',
      'provision_create_tenant',
      'provision_expire_invitation',
      'provision_peek_invitation',
      'provision_persist_operation',
      'provision_replay_operation',
    ]);
    // Directive §11: there is NO separable assert command any more — authority
    // is verified inside the mutation itself (0033).
    const { rows: assertFn } = await ownerPool().query(`SELECT 1 FROM pg_proc WHERE proname = 'provision_assert_tenant_owner'`);
    expect(assertFn).toEqual([]);
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

  /**
   * Directive §14 — DIRECT DB ATTACK TESTS. Connect as daftar_provisioner (the
   * credential the merchant process holds) and call the provisioning commands
   * DIRECTLY, bypassing the API. Every attempt to escalate must fail INSIDE
   * the command: the authority check and the mutation are one atomic unit.
   */
  /**
   * Directive §14 + Final Release Blocker 1 — DIRECT DB ATTACK TESTS. Connect
   * as daftar_provisioner (the credential the merchant process holds) and call
   * the provisioning commands DIRECTLY, bypassing the API. The actor is a
   * server-MINTED assertion verified by provision_actor() (migration 0038):
   * a caller-settable GUC, a forged or tampered signature, an expired or
   * replayed assertion, or one minted for another operation kind must all be
   * refused INSIDE the command — and with a VALID assertion the 0033
   * authority checks (tenant ownership, invitation addressee, actor-scoped
   * idempotency) still hold. Authorization and mutation stay one atomic unit.
   */
  describe('direct EXECUTE attacks as daftar_provisioner (§10–14, Blocker 1)', () => {
    const ROLE_PERMS = JSON.stringify({ owner: ['business.view'], manager: [], cashier: [] });
    const createBusinessSql = (tenantId: string) =>
      `SELECT provision_create_business('${tenantId}', gen_random_uuid(), 'Attack Co', 'attack-${Date.now()}', 'JO', 'JOD', 'general', 'ar', ARRAY['ar'], 'Asia/Amman', '${ROLE_PERMS}'::jsonb, 'tenancy.business_created')`;

    async function fixture(): Promise<{ tenantId: string; businessId: string; ownerId: string; strangerId: string; strangerToken: string }> {
      t = await createTestApp();
      await resetData();
      const reg = async () =>
        t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'X', preferredLocale: 'en' });
      const owner = await reg();
      const stranger = await reg();
      const ownerToken = owner.body.accessToken as string;
      const on = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `atk-${Date.now()}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ businessName: 'Victim Co', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `victim-${Date.now()}` });
      expect(on.status).toBe(201);
      const me = async (token: string) => (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.userId as string;
      return {
        tenantId: on.body.tenantId as string,
        businessId: on.body.businessId as string,
        ownerId: await me(ownerToken),
        strangerId: await me(stranger.body.accessToken as string),
        strangerToken: stranger.body.accessToken as string,
      };
    }

    /** Run `sql` in one provisioner transaction with the given GUC context; always rolls back. */
    async function attempt(ctx: Record<string, string>, sql: string): Promise<unknown[]> {
      return asProvisioner(async (c) => {
        await c.query('BEGIN');
        try {
          for (const [k, v] of Object.entries(ctx)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
          return (await c.query(sql)).rows as unknown[];
        } finally {
          await c.query('ROLLBACK');
        }
      });
    }
    const forge = (actorId: string, kind: string, exp: number, kid = 'v1'): string => {
      const claims = ['v1', kid, actorId, kind, String(exp), randomUUID()].join('.');
      return `${claims}.${createHmac('sha256', Buffer.from('attacker-guess-of-the-key-32-bytes!!')).update(claims).digest('hex')}`;
    };
    const futureExp = () => Math.floor(Date.now() / 1000) + 60;

    async function expectNoDamage(fx: { tenantId: string; strangerId: string; ownerId: string }): Promise<void> {
      const n = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses WHERE tenant_id = $1`, [fx.tenantId]);
      expect(n.rows[0]?.n).toBe('1');
      const m = await ownerPool().query(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [fx.tenantId, fx.strangerId]);
      expect(m.rows).toEqual([]);
      const owners = await ownerPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tenant_memberships WHERE tenant_id = $1 AND role_key = 'tenant_owner'`,
        [fx.tenantId],
      );
      expect(owners.rows[0]?.n).toBe('1');
    }

    it('no assertion at all → refused (no caller-chosen user id exists anywhere)', async () => {
      const fx = await fixture();
      await expect(attempt({}, createBusinessSql(fx.tenantId))).rejects.toThrow(/PROV:FORBIDDEN.*assertion/);
      await expectNoDamage(fx);
    });

    it('ATTACK: spoofing the VICTIM OWNER through the old GUC (app.actor_user_id) is refused', async () => {
      const fx = await fixture();
      await expect(attempt({ 'app.actor_user_id': fx.ownerId }, createBusinessSql(fx.tenantId))).rejects.toThrow(/PROV:FORBIDDEN/);
      await expect(attempt({ 'app.actor_user_id': fx.ownerId }, `SELECT provision_create_tenant(gen_random_uuid())`)).rejects.toThrow(/PROV:FORBIDDEN/);
      await expect(attempt({ 'app.actor_user_id': fx.ownerId }, `SELECT * FROM provision_accept_invitation('x')`)).rejects.toThrow(/PROV:FORBIDDEN/);
      await expectNoDamage(fx);
    });

    it('ATTACK: a FORGED assertion for the victim owner (attacker-chosen key) is refused', async () => {
      const fx = await fixture();
      await expect(
        attempt({ 'app.provisioning_assertion': forge(fx.ownerId, 'create_business', futureExp()) }, createBusinessSql(fx.tenantId)),
      ).rejects.toThrow(/PROV:FORBIDDEN.*signature/);
      // unknown kid
      await expect(
        attempt({ 'app.provisioning_assertion': forge(fx.ownerId, 'create_business', futureExp(), 'zz') }, createBusinessSql(fx.tenantId)),
      ).rejects.toThrow(/PROV:FORBIDDEN.*key/);
      await expectNoDamage(fx);
    });

    it('ATTACK: TAMPERED claims under a genuine signature (actor swapped to the victim owner) are refused', async () => {
      const fx = await fixture();
      const genuine = mintTestAssertion(fx.strangerId, 'create_business');
      const tampered = genuine.replace(fx.strangerId, fx.ownerId);
      expect(tampered).not.toBe(genuine);
      await expect(attempt({ 'app.provisioning_assertion': tampered }, createBusinessSql(fx.tenantId))).rejects.toThrow(/PROV:FORBIDDEN.*signature/);
      await expectNoDamage(fx);
    });

    it('ATTACK: an EXPIRED assertion is refused', async () => {
      const fx = await fixture();
      const stale = mintTestAssertion(fx.ownerId, 'create_business', new Date(Date.now() - 5 * 60_000));
      await expect(attempt({ 'app.provisioning_assertion': stale }, createBusinessSql(fx.tenantId))).rejects.toThrow(/PROV:FORBIDDEN.*expired/);
      await expectNoDamage(fx);
    });

    it('ATTACK: an assertion minted for ANOTHER operation kind is refused (kind binding)', async () => {
      const fx = await fixture();
      const acceptOnly = mintTestAssertion(fx.ownerId, 'accept_invitation');
      await expect(attempt({ 'app.provisioning_assertion': acceptOnly }, createBusinessSql(fx.tenantId))).rejects.toThrow(
        /PROV:FORBIDDEN.*different operation/,
      );
      const createOnly = mintTestAssertion(fx.ownerId, 'create_business');
      await expect(attempt({ 'app.provisioning_assertion': createOnly }, `SELECT provision_create_tenant(gen_random_uuid())`)).rejects.toThrow(
        /PROV:FORBIDDEN.*different operation/,
      );
      await expectNoDamage(fx);
    });

    it('ATTACK: a CAPTURED assertion cannot be replayed in a second transaction (single use)', async () => {
      const fx = await fixture();
      const captured = mintTestAssertion(fx.strangerId, 'create_business');
      // First (legitimate) use inside one transaction: several commands share it.
      await asProvisioner(async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [captured]);
        await c.query(`SELECT * FROM provision_replay_operation('any-key')`);
        await c.query(`SELECT * FROM provision_replay_operation('any-key')`);
        await c.query('COMMIT');
      });
      // Replay in a NEW transaction: refused.
      await expect(attempt({ 'app.provisioning_assertion': captured }, `SELECT * FROM provision_replay_operation('any-key')`)).rejects.toThrow(
        /PROV:FORBIDDEN.*already used/,
      );
    });

    it('with a VALID assertion, a NON-OWNER still cannot create a business in the victim tenant (authority check inside the command)', async () => {
      const fx = await fixture();
      const valid = mintTestAssertion(fx.strangerId, 'create_business');
      await expect(attempt({ 'app.provisioning_assertion': valid }, createBusinessSql(fx.tenantId))).rejects.toThrow(/PROV:FORBIDDEN.*tenant owner/);
      await expectNoDamage(fx);
    });

    it("with a VALID assertion, accepting SOMEONE ELSE's invitation is refused inside the command", async () => {
      const fx = await fixture();
      const roleId = (await ownerPool().query<{ id: string }>(`SELECT id FROM business_roles WHERE business_id = $1 AND key = 'cashier'`, [fx.businessId]))
        .rows[0]?.id as string;
      await ownerPool().query(
        `INSERT INTO business_invitations (business_id, email, role_id, token_hash, invited_by, expires_at)
         VALUES ($1, 'someone-else@test.daftar.local', $2, 'attack-token-hash', $3, now() + interval '1 day')`,
        [fx.businessId, roleId, fx.ownerId],
      );
      const valid = mintTestAssertion(fx.strangerId, 'accept_invitation');
      await expect(attempt({ 'app.provisioning_assertion': valid }, `SELECT * FROM provision_accept_invitation('attack-token-hash')`)).rejects.toThrow(
        /PROV:FORBIDDEN.*different email/,
      );
      const inv = await ownerPool().query<{ status: string }>(`SELECT status FROM business_invitations WHERE token_hash = 'attack-token-hash'`);
      expect(inv.rows[0]?.status).toBe('pending');
      await expectNoDamage(fx);
    });

    it('idempotency records are actor-scoped: another actor cannot replay or forge them', async () => {
      const fx = await fixture();
      const ownerKey = (
        await ownerPool().query<{ idempotency_key: string }>(`SELECT idempotency_key FROM onboarding_operations WHERE user_id = $1`, [fx.ownerId])
      ).rows[0]?.idempotency_key as string;
      expect(ownerKey).toBeTruthy();
      const replay = await attempt(
        { 'app.provisioning_assertion': mintTestAssertion(fx.strangerId, 'create_business') },
        `SELECT * FROM provision_replay_operation('${ownerKey}')`,
      );
      expect(replay).toEqual([]);
      // Persisting a record for ANOTHER user is impossible: the command has no
      // user-id parameter — the actor comes from the verified assertion only.
      await asProvisioner(async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [mintTestAssertion(fx.strangerId, 'create_business')]);
        await c.query(`SELECT provision_persist_operation('forged-key-12345', 'create_business', 'hash', $1, NULL)`, [fx.tenantId]);
        await c.query('COMMIT');
      });
      const owned = await ownerPool().query<{ user_id: string }>(`SELECT user_id FROM onboarding_operations WHERE idempotency_key = 'forged-key-12345'`);
      expect(owned.rows[0]?.user_id).toBe(fx.strangerId);
    });

    it('the assertion key is unreachable: no runtime role can read, install or retire keys, or touch the jti registry', async () => {
      await fixture();
      const attempts: Promise<unknown>[] = [
        asProvisioner((c) => c.query('SELECT * FROM provisioning_assertion_keys')),
        asProvisioner((c) => c.query(`SELECT provision_assertion_key_install('evil', decode($1, 'base64'))`, [Buffer.alloc(32, 1).toString('base64')])),
        asProvisioner((c) => c.query(`SELECT provision_assertion_key_retire('v1')`)),
        asProvisioner((c) => c.query('SELECT * FROM provisioning_assertion_uses')),
        asProvisioner((c) => c.query('DELETE FROM provisioning_assertion_uses')),
        asProvisioner((c) => c.query(`SELECT provision_actor(ARRAY['onboarding'])`)),
      ];
      for (const a of attempts) await expect(a).rejects.toThrow(/permission denied|PROV:FORBIDDEN/);
      for (const url of [appDbUrl, workerDbUrl, identityDbUrl, resolverDbUrl]) {
        const c = new Client({ connectionString: url });
        await c.connect();
        try {
          await expect(c.query('SELECT * FROM provisioning_assertion_keys')).rejects.toThrow(/permission denied/);
          await expect(
            c.query(`SELECT provision_assertion_key_install('evil', decode($1, 'base64'))`, [Buffer.alloc(32, 1).toString('base64')]),
          ).rejects.toThrow(/permission denied/);
        } finally {
          await c.end();
        }
      }
    });
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
