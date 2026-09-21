import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * Wave 9 — Super Admin (§49–56): platform roles are a separate namespace,
 * plan versions immutable + copy-forward, overrides audited, feature flags
 * separate, and merchants are NEVER platform admins by default.
 */
describe('super admin', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function registerUser(): Promise<{ token: string; userId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'U',
      preferredLocale: 'ar',
    });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken as string}`);
    return { token: reg.body.accessToken as string, userId: me.body.userId as string };
  }

  async function makePlatformOwner(userId: string): Promise<void> {
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [userId]);
  }

  it('merchant without platform role is forbidden from every admin route', async () => {
    const u = await registerUser();
    for (const path of ['tenants', 'businesses', 'users', 'plans', 'audit-events']) {
      const res = await t.request.get(`/v1/admin/${path}`).set('Authorization', `Bearer ${u.token}`);
      expect(res.status).toBe(403);
    }
  });

  it('platform_owner can read tenants/users/plans; read_only_analyst cannot manage', async () => {
    const owner = await registerUser();
    await makePlatformOwner(owner.userId);
    const tenants = await t.request.get('/v1/admin/tenants').set('Authorization', `Bearer ${owner.token}`);
    expect(tenants.status).toBe(200);

    const analyst = await registerUser();
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'read_only_analyst')`, [analyst.userId]);
    const plans = await t.request.get('/v1/admin/plans').set('Authorization', `Bearer ${analyst.token}`);
    expect(plans.status).toBe(200);
    const denied = await t.request
      .post('/v1/admin/plan-versions')
      .set('Authorization', `Bearer ${analyst.token}`)
      .send({ planKey: 'free', limits: { MAX_USERS: 3 } });
    expect(denied.status).toBe(403);
    const flagsDenied = await t.request.post('/v1/admin/feature-flags').set('Authorization', `Bearer ${analyst.token}`).send({ key: 'x', enabled: true });
    expect(flagsDenied.status).toBe(403);
  });

  it('plan version creation copies forward and applies changes; prior version untouched', async () => {
    const owner = await registerUser();
    await makePlatformOwner(owner.userId);
    // Own plan key: plan versions are IMMUTABLE — a test must never mutate the
    // seeded free/starter/pro/business lineage other suites depend on, and
    // cannot delete its own versions either (unique key per run).
    const planKey = `testplan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await ownerPool().query(`INSERT INTO plans (key, name) VALUES ($1, 'Test Plan')`, [planKey]);
    const { rows: v1rows } = await ownerPool().query<{ id: string }>(`INSERT INTO plan_versions (plan_key, version) VALUES ($1, 1) RETURNING id`, [planKey]);
    const v1 = v1rows[0];
    if (!v1) throw new Error('fixture plan version insert failed');
    await ownerPool().query(`INSERT INTO plan_limits (plan_version_id, limit_key, limit_value) VALUES ($1, 'MAX_USERS', 2), ($1, 'MAX_BRANCHES', 1)`, [v1.id]);
    await ownerPool().query(`INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled) VALUES ($1, 'MULTI_BRANCH', false)`, [v1.id]);

    const res = await t.request
      .post('/v1/admin/plan-versions')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ planKey, limits: { MAX_USERS: 4 }, features: { MULTI_BRANCH: true } });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);

    const { rows: limits } = await ownerPool().query<{ limit_key: string; limit_value: string }>(
      `SELECT pl.limit_key, pl.limit_value::text FROM plan_limits pl
       JOIN plan_versions pv ON pv.id = pl.plan_version_id
       WHERE pv.plan_key = $1 AND pv.version = 2`,
      [planKey],
    );
    const map = Object.fromEntries(limits.map((l) => [l.limit_key, l.limit_value]));
    expect(map['MAX_USERS']).toBe('4'); // changed
    expect(map['MAX_BRANCHES']).toBe('1'); // copied forward
    // prior version untouched
    const { rows: v1limit } = await ownerPool().query<{ limit_value: string }>(
      `SELECT limit_value::text FROM plan_limits WHERE plan_version_id = $1 AND limit_key = 'MAX_USERS'`,
      [v1.id],
    );
    expect(v1limit[0]?.limit_value).toBe('2');
  });

  it('override requires exactly one of feature/limit (XOR) + reason; audited', async () => {
    const owner = await registerUser();
    await makePlatformOwner(owner.userId);
    // onboard a business to override
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        businessName: 'Biz',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `adm-${Date.now()}`,
      });
    const businessId = on.body.businessId as string;

    const both = await t.request
      .post('/v1/admin/entitlement-overrides')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ businessId, featureKey: 'MULTI_BRANCH', enabledValue: true, limitKey: 'MAX_USERS', limitValue: 9, reason: 'both' });
    expect(both.status).toBe(400);

    const ok = await t.request
      .post('/v1/admin/entitlement-overrides')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ businessId, limitKey: 'MAX_USERS', limitValue: 9, reason: 'vip customer' });
    expect(ok.status).toBe(201);

    const audit = await t.request.get('/v1/admin/audit-events').set('Authorization', `Bearer ${owner.token}`);
    const actions = (audit.body.items as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('admin.entitlement_override_created');
  });

  it('feature flag set is audited; platform_roles.manage is platform_owner-only', async () => {
    const owner = await registerUser();
    await makePlatformOwner(owner.userId);
    const flag = await t.request
      .post('/v1/admin/feature-flags')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ key: 'beta_checkout', enabled: true, description: 'beta' });
    expect(flag.status).toBe(200);

    const admin = await registerUser();
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_admin')`, [admin.userId]);
    const denied = await t.request
      .post('/v1/admin/platform-roles')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ userId: admin.userId, roleKey: 'platform_owner' });
    expect(denied.status).toBe(403);

    const granted = await t.request
      .post('/v1/admin/platform-roles')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: admin.userId, roleKey: 'security_admin' });
    expect(granted.status).toBe(200);
    const { rows } = await ownerPool().query<{ role_key: string }>('SELECT role_key FROM platform_role_memberships WHERE user_id = $1', [admin.userId]);
    expect(rows[0]?.role_key).toBe('security_admin');
  });

  it('FINANCIAL BOUNDARY: admin API exposes no merchant ledger/stock/payment routes', async () => {
    const owner = await registerUser();
    await makePlatformOwner(owner.userId);
    for (const path of ['ledger', 'stock', 'payments', 'journal', 'posting']) {
      const res = await t.request.get(`/v1/admin/${path}`).set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(404);
    }
  });
});
