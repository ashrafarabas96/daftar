import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

async function onboard(t: TestApp, slug?: string): Promise<{ token: string; businessId: string }> {
  const reg = await t.request.post('/v1/auth/register').send({
    email: uniqueEmail(),
    password: 'Str0ng!Passw0rd',
    displayName: 'O',
    preferredLocale: 'ar',
  });
  const token = reg.body.accessToken as string;
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', `pl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
    .send({
      businessName: 'B',
      countryCode: 'PS',
      baseCurrency: 'ILS',
      storeSlug: slug ?? `pl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
  return { token, businessId: on.body.businessId as string };
}

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

/**
 * §34–44 (Final Closure): plan version lifecycle DRAFT→PUBLISHED→SUNSET with
 * DB-enforced child immutability, and override DB integrity (strict XOR,
 * sane window, no overlapping active windows, audited revoke).
 */
describe('plan lifecycle & override integrity (§34–44)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function platformOwner(): Promise<{ token: string; userId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'P',
      preferredLocale: 'ar',
    });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken as string}`);
    const userId = me.body.userId as string;
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [userId]);
    return { token: reg.body.accessToken as string, userId };
  }

  async function businessOf(): Promise<string> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'M',
      preferredLocale: 'ar',
    });
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .send({ businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `pl-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    return on.body.businessId as string;
  }

  it('DRAFT is editable; PUBLISHED freezes the version AND its children; SUNSET only from PUBLISHED', async () => {
    const p = await platformOwner();
    const created = await t.request
      .post('/v1/admin/plan-versions')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ planKey: 'free', limits: { MAX_USERS: 3 } });
    expect(created.status).toBe(201);
    const pvId = (created.body as { id: string }).id;

    // DRAFT children remain editable.
    await ownerPool().query(`UPDATE plan_limits SET limit_value = 4 WHERE plan_version_id = $1 AND limit_key = 'MAX_USERS'`, [pvId]);

    // Publish → children freeze (DB trigger).
    const pub = await t.request.post(`/v1/admin/plan-versions/${pvId}/publish`).set('Authorization', `Bearer ${p.token}`);
    expect(pub.status).toBe(200);
    await expect(ownerPool().query(`UPDATE plan_limits SET limit_value = 9 WHERE plan_version_id = $1 AND limit_key = 'MAX_USERS'`, [pvId])).rejects.toThrow(
      /immutable/,
    );
    await expect(ownerPool().query(`UPDATE plan_versions SET version = 99 WHERE id = $1`, [pvId])).rejects.toThrow(/immutable/);

    // Sunset allowed from PUBLISHED; further transitions rejected.
    const sun = await t.request.post(`/v1/admin/plan-versions/${pvId}/sunset`).set('Authorization', `Bearer ${p.token}`);
    expect(sun.status).toBe(200);
    const resun = await t.request.post(`/v1/admin/plan-versions/${pvId}/sunset`).set('Authorization', `Bearer ${p.token}`);
    expect(resun.status).toBe(409);
  });

  it('a DRAFT version is NEVER assigned to a business (provisioning picks latest PUBLISHED)', async () => {
    const p = await platformOwner();
    // Create a DRAFT free-v2 with a giant limit; businesses must not see it.
    const created = await t.request
      .post('/v1/admin/plan-versions')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ planKey: 'free', limits: { MAX_USERS: 999 } });
    expect(created.status).toBe(201);
    const businessId = await businessOf();
    const row = must(
      (
        await ownerPool().query<{ version: number; state: string }>(
          `SELECT pv.version, pv.state FROM business_entitlements be JOIN plan_versions pv ON pv.id = be.plan_version_id
       WHERE be.business_id = $1`,
          [businessId],
        )
      ).rows[0],
    );
    expect(row.state).toBe('PUBLISHED');
    expect(row.version).toBe(1);
  });

  it('override strict XOR: both keys or neither → DB rejection', async () => {
    const b = await businessOf();
    const p = await platformOwner();
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'CUSTOM_ROLES', true, 'MAX_USERS', 5, 'xor-violation', $2)`,
        [b, p.userId],
      ),
    ).rejects.toThrow(/strict_xor|check/i);
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, reason, actor_user_id)
       VALUES ($1, 'neither', $2)`,
        [b, p.userId],
      ),
    ).rejects.toThrow(/strict_xor|check|null value/i);
  });

  it('ends_at must be after starts_at (§42)', async () => {
    const b = await businessOf();
    const p = await platformOwner();
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id, starts_at, ends_at)
       VALUES ($1, 'MAX_USERS', 5, 'bad-window', $2, now(), now() - interval '1 hour')`,
        [b, p.userId],
      ),
    ).rejects.toThrow(/window|check/i);
  });

  it('overlapping ACTIVE overrides for the same key are rejected (§43), sequential windows allowed', async () => {
    const b = await businessOf();
    const p = await platformOwner();
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_USERS', 5, 'first', $2)`,
      [b, p.userId],
    );
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_USERS', 6, 'overlap', $2)`,
        [b, p.userId],
      ),
    ).rejects.toThrow(/overlapping/);
    // Sequential window: first ends, second starts after — allowed.
    await ownerPool().query(
      `UPDATE entitlement_overrides SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
       WHERE business_id = $1 AND limit_key = 'MAX_USERS'`,
      [b],
    );
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_USERS', 6, 'second-window', $2)`,
      [b, p.userId],
    );
  });

  it('revoke command: audited, revoked override stops applying, re-revoke → 409', async () => {
    const b = await businessOf();
    const p = await platformOwner();
    const created = await t.request
      .post('/v1/admin/entitlement-overrides')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ businessId: b, featureKey: 'CUSTOM_ROLES', enabledValue: true, reason: 'comp grant' });
    expect(created.status).toBe(201);
    const overrideId = (created.body as { id: string }).id;

    const revoke = await t.request
      .post(`/v1/admin/entitlement-overrides/${overrideId}/revoke`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({ reason: 'no longer needed' });
    expect(revoke.status).toBe(200);

    // Revoked override no longer wins.
    const row = must(
      (await ownerPool().query<{ revoked_at: string | null }>('SELECT revoked_at FROM entitlement_overrides WHERE id = $1', [overrideId])).rows[0],
    );
    expect(row.revoked_at).not.toBeNull();

    const again = await t.request
      .post(`/v1/admin/entitlement-overrides/${overrideId}/revoke`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({ reason: 'again' });
    expect(again.status).toBe(409);

    const audit = await ownerPool().query(`SELECT 1 FROM audit_events WHERE action = 'admin.entitlement_override_revoked' AND entity_id = $1`, [overrideId]);
    expect(audit.rowCount).toBe(1);
  });
});

/**
 * Gate A §43–51: published trial immutability, override strict value shape,
 * audit/outbox tenant↔business ownership integrity.
 */
describe('Gate A contract integrity (§43–51)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  it('§43: trial_days on a PUBLISHED version is immutable (row freeze covers the new column)', async () => {
    const { rows } = await ownerPool().query<{ id: string }>(`SELECT id FROM plan_versions WHERE state = 'PUBLISHED' LIMIT 1`, []);
    await expect(ownerPool().query('UPDATE plan_versions SET trial_days = 99 WHERE id = $1', [must(rows[0]).id])).rejects.toThrow();
  });

  it('§48 DB: override value shape — feature+NULL enabled / feature+limit_value / limit+enabled_value all rejected', async () => {
    const a = await onboard(t);
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${a.token}`);
    const uid = me.body.userId as string;
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, feature_key, reason, actor_user_id)
       VALUES ($1, 'CUSTOM_ROLES', 'shape-a', $2)`,
        [a.businessId, uid],
      ),
    ).rejects.toThrow();
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value, limit_value, reason, actor_user_id)
       VALUES ($1, 'CUSTOM_ROLES', true, 5, 'shape-b', $2)`,
        [a.businessId, uid],
      ),
    ).rejects.toThrow();
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, enabled_value, reason, actor_user_id)
       VALUES ($1, 'MAX_BRANCHES', 5, true, 'shape-c', $2)`,
        [a.businessId, uid],
      ),
    ).rejects.toThrow();
  });

  it('§50–51: audit + outbox rows with mismatched tenant/business are REJECTED; platform NULL business allowed', async () => {
    const a = await onboard(t, `owna-${Date.now()}`);
    const b = await onboard(t, `ownb-${Date.now()}`);
    const tA = must((await ownerPool().query<{ tenant_id: string }>('SELECT tenant_id FROM businesses WHERE id = $1', [a.businessId])).rows[0]).tenant_id;
    // Mismatched pair: tenant A with business B.
    await expect(
      ownerPool().query(`INSERT INTO audit_events (tenant_id, business_id, action, entity) VALUES ($1, $2, 'x', 'y')`, [tA, b.businessId]),
    ).rejects.toThrow();
    await expect(
      ownerPool().query(`INSERT INTO outbox_events (tenant_id, business_id, type, payload) VALUES ($1, $2, 'x', '{}')`, [tA, b.businessId]),
    ).rejects.toThrow();
    // Matching pair passes; platform event with NULL business passes.
    await ownerPool().query(`INSERT INTO audit_events (tenant_id, business_id, action, entity) VALUES ($1, $2, 'ok', 'y')`, [tA, a.businessId]);
    await ownerPool().query(`INSERT INTO outbox_events (tenant_id, business_id, type, payload) VALUES (NULL, NULL, 'platform.event', '{}')`, []);
  });
});

describe('§19–22: future-safe plan version immutability + clone (Terminal Closure)', () => {
  it('published version: trial_days/feature/limit changes reject; pure sunset allowed; sunset+mutation rejects', async () => {
    const { rows } = await ownerPool().query<{ id: string }>(`SELECT id FROM plan_versions WHERE state = 'PUBLISHED' LIMIT 1`, []);
    const pvId = must(rows[0]).id;

    // change trial_days → reject
    await expect(ownerPool().query('UPDATE plan_versions SET trial_days = 7 WHERE id = $1', [pvId])).rejects.toThrow(/immutable/);
    // change feature (child) → reject
    await expect(
      ownerPool().query(
        `UPDATE plan_entitlements SET enabled = NOT enabled
       WHERE plan_version_id = $1 AND feature_key = (SELECT feature_key FROM plan_entitlements WHERE plan_version_id = $1 ORDER BY feature_key LIMIT 1)`,
        [pvId],
      ),
    ).rejects.toThrow(/immutable/);
    // change limit (child) → reject
    await expect(
      ownerPool().query(
        `UPDATE plan_limits SET limit_value = limit_value + 1
       WHERE plan_version_id = $1 AND limit_key = (SELECT limit_key FROM plan_limits WHERE plan_version_id = $1 ORDER BY limit_key LIMIT 1)`,
        [pvId],
      ),
    ).rejects.toThrow(/immutable/);
    // sunset + trial_days mutation → reject (future-safe whole-row check)
    await expect(ownerPool().query(`UPDATE plan_versions SET state = 'SUNSET', trial_days = 7 WHERE id = $1`, [pvId])).rejects.toThrow(/immutable/);
    // pure sunset → allow
    await ownerPool().query(`UPDATE plan_versions SET state = 'SUNSET' WHERE id = $1`, [pvId]);
    const after = must((await ownerPool().query<{ state: string }>('SELECT state FROM plan_versions WHERE id = $1', [pvId])).rows[0]);
    expect(after.state).toBe('SUNSET');
    // SUNSET is terminal.
    await expect(ownerPool().query(`UPDATE plan_versions SET state = 'PUBLISHED' WHERE id = $1`, [pvId])).rejects.toThrow(/immutable/);
  });

  it('cloning a version copies trial_days (and features/limits) into the new DRAFT', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const reg = await t.request.post('/v1/auth/register').send({
        email: uniqueEmail(),
        password: 'Str0ng!Passw0rd',
        displayName: 'P',
        preferredLocale: 'ar',
      });
      expect(reg.status).toBe(201);
      const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken as string}`);
      expect(me.status).toBe(200);
      const ins = await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [me.body.userId]);
      expect(ins.rowCount).toBe(1);
      expect(
        must((await ownerPool().query<{ role_key: string }>('SELECT role_key FROM platform_role_memberships WHERE user_id = $1', [me.body.userId])).rows[0])
          .role_key,
      ).toBe('platform_owner');
      const created = await t.request
        .post('/v1/admin/plan-versions')
        .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
        .send({ planKey: 'free', trialDays: 30 });
      expect(created.status).toBe(201);
      const pvId = (created.body as { id: string }).id;
      const row = must(
        (await ownerPool().query<{ trial_days: number; state: string }>('SELECT trial_days, state FROM plan_versions WHERE id = $1', [pvId])).rows[0],
      );
      expect(row.state).toBe('DRAFT');
      expect(row.trial_days).toBe(30); // cloned base (14) then draft trial override applied
      const children = must(
        (
          await ownerPool().query<{ n: number }>(
            `SELECT (SELECT count(*) FROM plan_entitlements WHERE plan_version_id = $1)
              + (SELECT count(*) FROM plan_limits WHERE plan_version_id = $1) AS n`,
            [pvId],
          )
        ).rows[0],
      );
      expect(Number(children.n)).toBeGreaterThan(0);
    } finally {
      await t.close();
    }
  });

  it('§XLVII: plan version diff preview — features/limits/trial changes visible between versions', async () => {
    await resetData();
    const t = await createTestApp();
    try {
      const reg = await t.request.post('/v1/auth/register').send({
        email: uniqueEmail(),
        password: 'Str0ng!Passw0rd',
        displayName: 'P',
        preferredLocale: 'ar',
      });
      const token = reg.body.accessToken as string;
      const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
      await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [me.body.userId]);
      const auth = { Authorization: `Bearer ${token}` };

      const before = must(
        (
          await ownerPool().query<{ feature_key: string }>(
            `SELECT feature_key FROM plan_entitlements pe JOIN plan_versions pv ON pv.id = pe.plan_version_id
         WHERE pv.plan_key = 'free' ORDER BY pv.version DESC, pe.feature_key LIMIT 1`,
          )
        ).rows[0],
      );
      const flip = must(
        (
          await ownerPool().query<{ enabled: boolean }>(
            `SELECT pe.enabled FROM plan_entitlements pe JOIN plan_versions pv ON pv.id = pe.plan_version_id
         WHERE pv.plan_key = 'free' AND pe.feature_key = $1 ORDER BY pv.version DESC LIMIT 1`,
            [before.feature_key],
          )
        ).rows[0],
      );
      const created = await t.request
        .post('/v1/admin/plan-versions')
        .set(auth)
        .send({ planKey: 'free', trialDays: 45, features: { [before.feature_key]: !flip.enabled }, limits: { MAX_USERS: 99 } });
      expect(created.status).toBe(201);
      const newVersion = (created.body as { version: number }).version;

      const diff = await t.request.get(`/v1/admin/plans/free/versions/diff?from=${newVersion - 1}&to=${newVersion}`).set(auth);
      expect(diff.status).toBe(200);
      const d = diff.body as {
        trialDays: { from: number | null; to: number | null; changed: boolean };
        features: { key: string; from: boolean | null; to: boolean | null }[];
        limits: { key: string; from: number | null; to: number | null }[];
      };
      expect(d.trialDays).toEqual({ from: 14, to: 45, changed: true });
      expect(d.features).toContainEqual({ key: before.feature_key, from: flip.enabled, to: !flip.enabled });
      expect(d.limits).toContainEqual({ key: 'MAX_USERS', from: 2, to: 99 });

      const same = await t.request.get(`/v1/admin/plans/free/versions/diff?from=${newVersion}&to=${newVersion}`).set(auth);
      expect(same.status).toBe(200);
      expect((same.body as { features: unknown[] }).features).toHaveLength(0);
      expect((same.body as { limits: unknown[] }).limits).toHaveLength(0);
      expect((same.body as { trialDays: { changed: boolean } }).trialDays.changed).toBe(false);

      expect((await t.request.get('/v1/admin/plans/free/versions/diff?from=1&to=999').set(auth)).status).toBe(404);
      expect((await t.request.get('/v1/admin/plans/free/versions/diff?from=abc&to=1').set(auth)).status).toBe(400);
    } finally {
      await t.close();
    }
  });
});
