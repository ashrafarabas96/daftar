import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, platformDbUrl, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

const execFileP = promisify(execFile);

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

async function platformUser(t: TestApp, role: string): Promise<{ token: string; userId: string }> {
  const reg = await t.request.post('/v1/auth/register').send({
    email: uniqueEmail(),
    password: 'Str0ng!Passw0rd',
    displayName: 'Agent',
    preferredLocale: 'en',
  });
  expect(reg.status).toBe(201);
  const userId = must((await ownerPool().query<{ id: string }>('SELECT id FROM users ORDER BY created_at DESC LIMIT 1')).rows[0]).id;
  await ownerPool().query('INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, $2)', [userId, role]);
  return { token: (reg.body as { accessToken: string }).accessToken, userId };
}

async function tenantWithBusiness(t: TestApp): Promise<string> {
  const reg = await t.request.post('/v1/auth/register').send({
    email: uniqueEmail(),
    password: 'Str0ng!Passw0rd',
    displayName: 'M',
    preferredLocale: 'en',
  });
  const token = (reg.body as { accessToken: string }).accessToken;
  const onb = await t.request
    .post('/v1/onboarding/complete')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', `onb-${Date.now()}-${Math.random()}`)
    .send({
      businessName: 'Support Test Co',
      countryCode: 'JO',
      baseCurrency: 'JOD',
      storeSlug: `sup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      timezone: 'Asia/Amman',
    });
  expect(onb.status).toBe(201);
  return must((await ownerPool().query<{ tenant_id: string }>('SELECT tenant_id FROM businesses ORDER BY created_at DESC LIMIT 1')).rows[0]).tenant_id;
}

describe('§LII–LIV: support sessions', () => {
  it('full lifecycle: create → banner access → revoke denies immediately → expired denies', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const tenantId = await tenantWithBusiness(t);
      const agent = await platformUser(t, 'support_agent');
      const auth = { Authorization: `Bearer ${agent.token}` };

      // No session → tenant detail denied.
      expect((await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth)).status).toBe(403);

      // Create session.
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const created = await t.request
        .post('/v1/admin/support-sessions')
        .set(auth)
        .send({ tenantId, reason: 'Customer ticket #12345 investigation', expiresAt });
      expect(created.status).toBe(201);
      const sessionId = (created.body as { id: string }).id;

      // Access with banner.
      const detail = await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth);
      expect(detail.status).toBe(200);
      const banner = (detail.body as { supportBanner: { sessionId: string; mode: string; message: string } }).supportBanner;
      expect(banner.sessionId).toBe(sessionId);
      expect(banner.mode).toBe('READ_ONLY');
      expect(banner.message).toContain('SUPPORT SESSION ACTIVE');

      // List shows the session.
      const list = await t.request.get('/v1/admin/support-sessions').set(auth);
      expect((list.body as { items: unknown[] }).items.length).toBe(1);

      // Revoke → denied IMMEDIATELY.
      const revoke = await t.request.post(`/v1/admin/support-sessions/${sessionId}/revoke`).set(auth).send({ reason: 'ticket resolved' });
      expect(revoke.status).toBe(200);
      expect((await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth)).status).toBe(403);

      // Expired session denies: insert one already expired (starts in the past).
      await ownerPool().query(
        `INSERT INTO support_sessions (reason, actor_user_id, tenant_id, starts_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour')`,
        ['Expired session test row', agent.userId, tenantId],
      );
      expect((await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth)).status).toBe(403);

      // Sessions are immutable except revocation.
      await expect(ownerPool().query(`UPDATE support_sessions SET reason = 'tampered reason' WHERE id = $1`, [sessionId])).rejects.toThrow(/immutable/);
    } finally {
      await t.close();
    }
  });

  it('RBAC: read_only_analyst cannot create sessions; merchant users get 403', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const tenantId = await tenantWithBusiness(t);
      const analyst = await platformUser(t, 'read_only_analyst');
      const res = await t.request
        .post('/v1/admin/support-sessions')
        .set('Authorization', `Bearer ${analyst.token}`)
        .send({ tenantId, reason: 'Should not be allowed at all', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      expect(res.status).toBe(403);

      const merchantReg = await t.request.post('/v1/auth/register').send({
        email: uniqueEmail(),
        password: 'Str0ng!Passw0rd',
        displayName: 'M',
        preferredLocale: 'en',
      });
      const denied = await t.request
        .get(`/v1/admin/tenants/${tenantId}`)
        .set('Authorization', `Bearer ${(merchantReg.body as { accessToken: string }).accessToken}`);
      expect(denied.status).toBe(403);
    } finally {
      await t.close();
    }
  });

  it('business scope must belong to the tenant (composite FK)', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const tenantId = await tenantWithBusiness(t);
      const agent = await platformUser(t, 'support_agent');
      const res = await t.request
        .post('/v1/admin/support-sessions')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({
          tenantId,
          businessId: '00000000-0000-0000-0000-000000000000',
          reason: 'Cross-tenant business scope attempt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await t.close();
    }
  });
});

describe('§7–12 (Final Enforcement): business-scoped support sessions', () => {
  async function tenantWithTwoBusinesses(t: TestApp): Promise<{ tenantId: string; businessA: string; businessB: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'M',
      preferredLocale: 'en',
    });
    const token = (reg.body as { accessToken: string }).accessToken;
    const onb = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `onb-${Date.now()}-${Math.random()}`)
      .send({
        businessName: 'Business A',
        countryCode: 'JO',
        baseCurrency: 'JOD',
        storeSlug: `ba-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        timezone: 'Asia/Amman',
      });
    expect(onb.status).toBe(201);
    const tenantId = must(
      (await ownerPool().query<{ tenant_id: string }>('SELECT tenant_id FROM businesses ORDER BY created_at DESC LIMIT 1')).rows[0],
    ).tenant_id;
    const second = await t.request
      .post(`/v1/tenants/${tenantId}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `biz2-${Date.now()}-${Math.random()}`)
      .send({
        businessName: 'Business B',
        countryCode: 'JO',
        baseCurrency: 'JOD',
        storeSlug: `bb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        timezone: 'Asia/Amman',
      });
    expect(second.status).toBe(201);
    const ids = (await ownerPool().query<{ id: string }>('SELECT id FROM businesses WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId])).rows.map(
      (r) => r.id,
    );
    expect(ids.length).toBe(2);
    return { tenantId, businessA: must(ids[0]), businessB: must(ids[1]) };
  }

  it('business-scoped session reveals ONLY that business; every access is audited', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const { tenantId, businessA, businessB } = await tenantWithTwoBusinesses(t);
      const agent = await platformUser(t, 'support_agent');
      const auth = { Authorization: `Bearer ${agent.token}` };

      const created = await t.request
        .post('/v1/admin/support-sessions')
        .set(auth)
        .send({
          tenantId,
          businessId: businessA,
          reason: 'Investigating Business A order issue',
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      expect(created.status).toBe(201);
      const sessionId = (created.body as { id: string }).id;

      const detail = await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth);
      expect(detail.status).toBe(200);
      const body = detail.body as {
        tenant: { businesses: { id: string }[] };
        supportBanner: { businessId: string | null; message: string };
      };
      const visible = body.tenant.businesses.map((b) => b.id);
      expect(visible).toContain(businessA);
      expect(visible).not.toContain(businessB);
      expect(body.supportBanner.businessId).toBe(businessA);
      expect(body.supportBanner.message).toContain('business-scoped');

      // §10: per-access audit — second access writes a SECOND row.
      await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth);
      const audit = await ownerPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
         WHERE action = 'admin.support_access' AND entity_id = $1 AND tenant_id = $2 AND business_id = $3`,
        [sessionId, tenantId, businessA],
      );
      expect(Number(must(audit.rows[0]).n)).toBe(2);
    } finally {
      await t.close();
    }
  });

  it('tenant-scoped session still sees all businesses; audit has no business_id', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const { tenantId, businessA, businessB } = await tenantWithTwoBusinesses(t);
      const agent = await platformUser(t, 'support_agent');
      const auth = { Authorization: `Bearer ${agent.token}` };
      const created = await t.request
        .post('/v1/admin/support-sessions')
        .set(auth)
        .send({ tenantId, reason: 'Whole-tenant support review', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
      expect(created.status).toBe(201);
      const sessionId = (created.body as { id: string }).id;
      const detail = await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth);
      const visible = (detail.body as { tenant: { businesses: { id: string }[] } }).tenant.businesses.map((b) => b.id);
      expect(visible).toEqual(expect.arrayContaining([businessA, businessB]));
      const audit = await ownerPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
         WHERE action = 'admin.support_access' AND entity_id = $1 AND business_id IS NULL`,
        [sessionId],
      );
      expect(Number(must(audit.rows[0]).n)).toBe(1);
    } finally {
      await t.close();
    }
  });

  it('§11: expiry beyond the server-side maximum is rejected', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const tenantId = await tenantWithBusiness(t);
      const agent = await platformUser(t, 'support_agent');
      const res = await t.request
        .post('/v1/admin/support-sessions')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({
          tenantId,
          reason: 'Far-future expiry must be rejected',
          expiresAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(), // 5h > 4h cap
        });
      expect(res.status).toBe(400);
      const past = await t.request
        .post('/v1/admin/support-sessions')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({
          tenantId,
          reason: 'Past expiry must be rejected',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
      expect(past.status).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('§12: concurrent revoke — exactly one succeeds; access after revoke denies', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const tenantId = await tenantWithBusiness(t);
      const agent = await platformUser(t, 'support_agent');
      const auth = { Authorization: `Bearer ${agent.token}` };
      const created = await t.request
        .post('/v1/admin/support-sessions')
        .set(auth)
        .send({ tenantId, reason: 'Concurrent revoke boundary', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
      const sessionId = (created.body as { id: string }).id;

      const [r1, r2] = await Promise.all([
        t.request.post(`/v1/admin/support-sessions/${sessionId}/revoke`).set(auth).send({ reason: 'revoke A' }),
        t.request.post(`/v1/admin/support-sessions/${sessionId}/revoke`).set(auth).send({ reason: 'revoke B' }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 404]);
      expect((await t.request.get(`/v1/admin/tenants/${tenantId}`).set(auth)).status).toBe(403);
    } finally {
      await t.close();
    }
  });
});

describe('§LIV: platform owner bootstrap CLI', () => {
  it('creates the first owner, prints a one-time password, refuses to run twice', async () => {
    await resetData();
    const env = { ...process.env, BOOTSTRAP_DATABASE_URL: platformDbUrl };
    const first = await execFileP(
      process.execPath,
      ['--import', 'tsx', 'scripts/bootstrap-platform-owner.ts', `--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'],
      { env, cwd: process.cwd() },
    );
    expect(first.stdout).toContain('Platform owner created');
    expect(first.stdout).toContain('One-time password: Daftar-');

    await expect(
      execFileP(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-platform-owner.ts', `--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'], {
        env,
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/already exists/);

    const audit = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'platform.owner_bootstrapped'`);
    expect(Number(must(audit.rows[0]).n)).toBe(1);
  }, 60_000);
});
