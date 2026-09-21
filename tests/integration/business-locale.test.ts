import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

/** §63–68 (Final Closure): business timezone, locale separation, country
 *  registry, default warehouse per branch. */
describe('business timezone / locale / country registry (§63–68)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function onboard(payload: Record<string, unknown> = {}): Promise<{ token: string; businessId: string }> {
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
        businessName: 'Z',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `tz-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ...payload,
      });
    return { token, businessId: on.body.businessId as string };
  }

  it('PS onboarding defaults timezone to Asia/Hebron; TR → Europe/Istanbul (pack suggestion)', async () => {
    const ps = await onboard();
    const psBiz = await t.request.get('/v1/businesses/current').set('Authorization', `Bearer ${ps.token}`).set('X-Business-Id', ps.businessId);
    expect(psBiz.body.timezone).toBe('Asia/Hebron');

    const tr = await onboard({ countryCode: 'TR', baseCurrency: 'TRY', preferredLocale: 'tr' });
    const trBiz = await t.request.get('/v1/businesses/current').set('Authorization', `Bearer ${tr.token}`).set('X-Business-Id', tr.businessId);
    expect(trBiz.body.timezone).toBe('Europe/Istanbul');
    expect(trBiz.body.storefrontLocale).toBe('tr');
    expect(trBiz.body.defaultLocale).toBe('tr');
  });

  it('timezone is user-editable (settings PATCH), invalid IANA rejected 400', async () => {
    const a = await onboard();
    const ok = await t.request
      .patch('/v1/businesses/current')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ timezone: 'Asia/Amman' });
    expect(ok.status).toBe(200);
    const bad = await t.request
      .patch('/v1/businesses/current')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ timezone: 'Mars/Olympus_Mons' });
    expect(bad.status).toBe(400);
    const cur = await t.request.get('/v1/businesses/current').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
    expect(cur.body.timezone).toBe('Asia/Amman');
  });

  it('DB boundary rejects invalid IANA timezone even via SQL (trigger)', async () => {
    const a = await onboard();
    await expect(ownerPool().query('UPDATE businesses SET timezone = $2 WHERE id = $1', [a.businessId, 'Not/AZone'])).rejects.toThrow(/invalid IANA timezone/);
  });

  it('arbitrary country codes rejected: API 400 + DB FK (§66)', async () => {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'O',
      preferredLocale: 'ar',
    });
    const res = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .send({ businessName: 'X', countryCode: 'XX', baseCurrency: 'ILS', storeSlug: `xx-${Date.now()}` });
    expect(res.status).toBe(400);
    await expect(
      ownerPool().query(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       SELECT tenant_id, 'x', $2, 'ZZ', 'ILS', 'Asia/Hebron' FROM businesses WHERE id = $1`,
        [(await onboard()).businessId, `zz-${Date.now()}`],
      ),
    ).rejects.toThrow(/country|foreign key/i);
  });

  it('every branch gets a default warehouse (§68); per-branch default uniqueness', async () => {
    const a = await onboard();
    // §23 fixture: enable MULTI_BRANCH + raise limit for a second branch.
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${a.token}`);
    const userId = me.body.userId as string;
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value, reason, actor_user_id)
       VALUES ($1, 'MULTI_BRANCH', true, 'tz-test', $2)`,
      [a.businessId, userId],
    );
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_BRANCHES', 5, 'tz-test', $2)`,
      [a.businessId, userId],
    );

    const br = await t.request
      .post('/v1/businesses/current/branches')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ name: 'Second' });
    expect(br.status).toBe(201);
    const wh = await t.request.get('/v1/businesses/current/warehouses').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
    const items = wh.body.items as { branchId: string; isDefault: boolean }[];
    const branches = new Set(items.map((w) => w.branchId));
    expect(branches.size).toBe(2);
    for (const b of branches) {
      expect(items.filter((w) => w.branchId === b && w.isDefault)).toHaveLength(1);
    }
  });

  it('locale separation: user UI locale vs business operational vs storefront (§64)', async () => {
    const a = await onboard({ preferredLocale: 'ar' });
    await t.request
      .patch('/v1/businesses/current')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ defaultLocale: 'en', storefrontLocale: 'ar', enabledLocales: ['ar', 'en'] });
    const biz = await t.request.get('/v1/businesses/current').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
    expect(biz.body.defaultLocale).toBe('en'); // operational
    expect(biz.body.storefrontLocale).toBe('ar'); // storefront
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${a.token}`);
    expect(must(me.body.preferredLocale ?? 'ar')).toBe('ar'); // user UI
  });
});
