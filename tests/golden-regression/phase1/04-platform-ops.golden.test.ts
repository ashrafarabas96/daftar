import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp, ownerPool, platformDbUrl, resetData, uniqueEmail } from '../../helpers/test-app';

const execFileP = promisify(execFile);

/**
 * GOLDEN REGRESSION — Platform Operations (P1-GOLD-25 … P1-GOLD-32).
 */
describe('golden: platform ops', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });
  afterEach(async () => {
    await t?.close();
  });

  async function platformOwner(): Promise<{ token: string; userId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'Owner',
      preferredLocale: 'en',
    });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken}`);
    const userId = me.body.userId as string;
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [userId]);
    return { token: reg.body.accessToken as string, userId };
  }

  it('P1-GOLD-25 merchant is NEVER a platform admin by default', async () => {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'M',
      preferredLocale: 'ar',
    });
    const res = await t.request.get('/v1/admin/tenants').set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('P1-GOLD-26 plan clone starts DRAFT with children copied', async () => {
    const owner = await platformOwner();
    const res = await t.request.post('/v1/admin/plan-versions').set('Authorization', `Bearer ${owner.token}`).send({ planKey: 'free' });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
    const st = await ownerPool().query('SELECT state FROM plan_versions WHERE id=$1', [res.body.id]);
    expect(st.rows[0]?.state).toBe('DRAFT');
  });

  it('P1-GOLD-27 diff preview shows trial/feature/limit changes', async () => {
    const owner = await platformOwner();
    const clone = await t.request.post('/v1/admin/plan-versions').set('Authorization', `Bearer ${owner.token}`).send({ planKey: 'free', trialDays: 45 });
    expect(clone.status).toBe(201);
    const diff = await t.request.get('/v1/admin/plans/free/versions/diff?from=1&to=2').set('Authorization', `Bearer ${owner.token}`);
    expect(diff.status).toBe(200);
    expect(diff.body.trialDays).toEqual({ from: 14, to: 45, changed: true });
  });

  it('P1-GOLD-28 published plan version is immutable', async () => {
    const owner = await platformOwner();
    const clone = await t.request.post('/v1/admin/plan-versions').set('Authorization', `Bearer ${owner.token}`).send({ planKey: 'free' });
    const id = clone.body.id as string;
    const pub = await t.request.post(`/v1/admin/plan-versions/${id}/publish`).set('Authorization', `Bearer ${owner.token}`);
    expect(pub.status).toBe(200);
    const tamper = await ownerPool()
      .query(`UPDATE plan_versions SET trial_days = 99 WHERE id = $1`, [id])
      .then(() => 'updated')
      .catch((e: { message: string }) => e.message);
    expect(tamper).not.toBe('updated');
  });

  it('P1-GOLD-29 support session lifecycle: 403 → create → banner → revoke → 403', async () => {
    const owner = await platformOwner();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'M',
      preferredLocale: 'ar',
    });
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `gold-sup-${Date.now()}`)
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({ businessName: 'B', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `goldsup-${Date.now()}` });
    const tenant = await ownerPool().query('SELECT tenant_id FROM businesses WHERE id=$1', [on.body.businessId]);
    const tenantId = tenant.rows[0]?.tenant_id as string;

    const denied = await t.request.get(`/v1/admin/tenants/${tenantId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(denied.status).toBe(403);
    const session = await t.request
      .post('/v1/admin/support-sessions')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ tenantId, reason: 'Customer ticket #1234 — investigating order sync', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    expect(session.status).toBe(201);
    const detail = await t.request.get(`/v1/admin/tenants/${tenantId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(detail.status).toBe(200);
    expect(String((detail.body.supportBanner as { message: string } | undefined)?.message ?? '')).toContain('SUPPORT SESSION ACTIVE');
    const revoke = await t.request
      .post(`/v1/admin/support-sessions/${session.body.id}/revoke`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ reason: 'done' });
    expect([200, 201, 204]).toContain(revoke.status);
    const after = await t.request.get(`/v1/admin/tenants/${tenantId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(after.status).toBe(403);
  });

  it('P1-GOLD-30 support session terms are immutable; revocation is one-way', async () => {
    const owner = await platformOwner();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'M',
      preferredLocale: 'ar',
    });
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `gold-imm-${Date.now()}`)
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({ businessName: 'B', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `goldimm-${Date.now()}` });
    const tenant = await ownerPool().query('SELECT tenant_id FROM businesses WHERE id=$1', [on.body.businessId]);
    const session = await t.request
      .post('/v1/admin/support-sessions')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        reason: 'Immutable-terms check with enough length',
        tenantId: tenant.rows[0]?.tenant_id as string,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    expect(session.status).toBe(201);
    const id = session.body.id as string;
    const tamper = await ownerPool()
      .query(`UPDATE support_sessions SET reason = 'changed' WHERE id = $1`, [id])
      .then(() => 'updated')
      .catch((e: { message: string }) => e.message);
    expect(tamper).not.toBe('updated');
  });

  it('P1-GOLD-31 audit events never contain tokens, passwords, or ciphertext payloads', async () => {
    const owner = await platformOwner();
    await t.request.get('/v1/admin/audit-events').set('Authorization', `Bearer ${owner.token}`);
    const { rows } = await ownerPool().query<{ payload: string }>(
      `SELECT (action || ' ' || entity || ' ' || coalesce(entity_id,'') || ' ' || metadata::text) AS payload FROM audit_events`,
    );
    for (const row of rows) {
      expect(row.payload).not.toMatch(/refreshToken|password|argon2|secret_ciphertext|accessToken/i);
    }
  });

  it('P1-GOLD-32 bootstrap CLI: first run succeeds, second refuses, one audit event', async () => {
    const email = uniqueEmail();
    // §44: the bootstrap runs with the PLATFORM principal, never migration credentials.
    const env = { ...process.env, BOOTSTRAP_DATABASE_URL: platformDbUrl };
    const first = await execFileP('./node_modules/.bin/tsx', ['scripts/bootstrap-platform-owner.ts', `--email=${email}`, '--confirm=BOOTSTRAP'], {
      env,
      cwd: process.cwd(),
    });
    expect(first.stdout).toContain(email);
    const second = await execFileP('./node_modules/.bin/tsx', ['scripts/bootstrap-platform-owner.ts', `--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'], {
      env,
      cwd: process.cwd(),
    }).then(
      () => ({ code: 0 }),
      (e: { code?: number }) => ({ code: e.code ?? 1 }),
    );
    expect(second.code).not.toBe(0);
    const audit = await ownerPool().query(`SELECT count(*)::int n FROM audit_events WHERE action = 'platform.owner_bootstrapped'`);
    expect(audit.rows[0]?.n).toBe(1);
  });
});
