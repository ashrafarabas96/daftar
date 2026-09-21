import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, raiseLimit, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

/**
 * §21–33 (Final Closure): capability features AND limits both govern behavior,
 * effective subscription state is time-computed, trial length is plan config.
 */
describe('feature gating + effective subscription state (§21–33)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function onboard(): Promise<{ token: string; businessId: string; userId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'O',
      preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'G',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `fg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, businessId: on.body.businessId as string, userId: me.body.userId as string };
  }

  const createRole = (a: { token: string; businessId: string }) =>
    t.request
      .post('/v1/businesses/current/roles')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ key: `r-${Math.floor(Math.random() * 1e6)}`, name: 'R', permissions: ['catalog.view'] });

  it('feature FALSE + high limit → still denied (capability gates, §23/§25)', async () => {
    const a = await onboard();
    await raiseLimit(a.businessId, a.userId, 'MAX_BRANCHES', 99);
    const res = await t.request
      .post('/v1/businesses/current/branches')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ name: 'Second' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FEATURE_NOT_ENTITLED');
  });

  it('custom roles on free plan → FEATURE_NOT_ENTITLED (§21–22); grant → success', async () => {
    const a = await onboard();
    const denied = await createRole(a);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('FEATURE_NOT_ENTITLED');
    await grantFeature(a.businessId, a.userId, 'CUSTOM_ROLES');
    const allowed = await createRole(a);
    expect(allowed.status).toBe(201);
  });

  it('feature TRUE + quota exhausted → PLAN_LIMIT_EXCEEDED (§25)', async () => {
    const a = await onboard();
    await grantFeature(a.businessId, a.userId, 'MULTI_BRANCH');
    // Free MAX_BRANCHES=1, default branch occupies it → next create hits the limit.
    const res = await t.request
      .post('/v1/businesses/current/branches')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ name: 'Second' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('override FALSE after the TRUE window closes → denied (no overlapping windows, §25/§43)', async () => {
    const a = await onboard();
    await grantFeature(a.businessId, a.userId, 'CUSTOM_ROLES', true);
    await ownerPool().query(
      `UPDATE entitlement_overrides
       SET starts_at = now() - interval '2 minutes', ends_at = now() - interval '1 minute'
       WHERE business_id = $1 AND feature_key = 'CUSTOM_ROLES' AND revoked_at IS NULL`,
      [a.businessId],
    );
    await grantFeature(a.businessId, a.userId, 'CUSTOM_ROLES', false);
    const res = await createRole(a);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FEATURE_NOT_ENTITLED');
  });

  it('expired TRIAL (time-computed, no scheduler) loses all features (§30–31)', async () => {
    const a = await onboard();
    await grantFeature(a.businessId, a.userId, 'CUSTOM_ROLES');
    await ownerPool().query(`UPDATE business_entitlements SET trial_ends_at = now() - interval '1 day' WHERE business_id = $1`, [a.businessId]);
    // Stored state still 'trial' — the EFFECTIVE state is expired.
    const summary = await t.request.get('/v1/businesses/current/entitlement').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
    expect(summary.body.state).toBe('trial');
    expect(summary.body.effectiveState).toBe('expired');
    // And commands are denied even with a positive override.
    const res = await createRole(a);
    expect(res.status).toBe(409);
  });

  it('cancel_at_period_end flips to cancelled when the period passes (§30)', async () => {
    const a = await onboard();
    await ownerPool().query(
      `UPDATE business_entitlements
       SET state = 'cancel_at_period_end', trial_ends_at = NULL, period_ends_at = now() - interval '1 hour'
       WHERE business_id = $1`,
      [a.businessId],
    );
    const summary = await t.request.get('/v1/businesses/current/entitlement').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
    expect(summary.body.effectiveState).toBe('cancelled');
  });

  it('trial length comes from the VERSIONED contract (§40–44): plan_versions.trial_days drives trial_ends_at', async () => {
    // DRAFT versions are editable; publish a 30-day free version and onboard.
    await ownerPool().query(
      `INSERT INTO plan_versions (plan_key, version, state, trial_days)
       SELECT 'free', max(version) + 1, 'DRAFT', 30 FROM plan_versions WHERE plan_key = 'free'`,
    );
    const { rows } = await ownerPool().query<{ id: string }>(`SELECT id FROM plan_versions WHERE plan_key = 'free' AND state = 'DRAFT'`, []);
    const draftId = must(rows[0]).id;
    // Draft children must exist for the version to be usable — clone from the
    // LATEST published version (idempotent across re-runs of this fixture).
    await ownerPool().query(
      `INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled)
       SELECT DISTINCT ON (pe.feature_key) $1, pe.feature_key, pe.enabled
       FROM plan_entitlements pe
       JOIN plan_versions pv ON pv.id = pe.plan_version_id
       WHERE pv.plan_key = 'free' AND pv.state = 'PUBLISHED'
       ORDER BY pe.feature_key, pv.version DESC
       ON CONFLICT DO NOTHING`,
      [draftId],
    );
    await ownerPool().query(
      `INSERT INTO plan_limits (plan_version_id, limit_key, limit_value)
       SELECT DISTINCT ON (pl.limit_key) $1, pl.limit_key, pl.limit_value
       FROM plan_limits pl
       JOIN plan_versions pv ON pv.id = pl.plan_version_id
       WHERE pv.plan_key = 'free' AND pv.state = 'PUBLISHED'
       ORDER BY pl.limit_key, pv.version DESC
       ON CONFLICT DO NOTHING`,
      [draftId],
    );
    await ownerPool().query(`UPDATE plan_versions SET state = 'PUBLISHED' WHERE id = $1`, [draftId]);
    const a = await onboard();
    const row = must(
      (
        await ownerPool().query<{ days: string }>(
          `SELECT round(extract(epoch FROM (trial_ends_at - started_at)) / 86400)::text AS days
       FROM business_entitlements WHERE business_id = $1`,
          [a.businessId],
        )
      ).rows[0],
    );
    expect(Number(row.days)).toBe(30);
  });

  it('limit registry rejects arbitrary limit keys (§28 FK)', async () => {
    const a = await onboard();
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'NO_SUCH_LIMIT', 5, 'bad-fixture', $2)`,
        [a.businessId, a.userId],
      ),
    ).rejects.toThrow(/limit_definitions|foreign key|violates/i);
  });
});
