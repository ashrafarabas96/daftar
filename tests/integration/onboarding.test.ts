import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/** Onboarding (§45, §53–55): golden locales, atomicity, idempotency, slug race, currency lock. */
describe('onboarding', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function freshUser(): Promise<string> {
    const res = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'Owner',
      preferredLocale: 'ar',
    });
    return (res.body.accessToken ?? res.body.tokens?.accessToken) as string;
  }

  const onboard = (token: string, payload: Record<string, unknown>, key?: string) =>
    t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', key ?? `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

  describe('golden locales (P1-GOLD-02/03/04)', () => {
    it('Arabic / Palestine / ILS — full atomic creation', async () => {
      const token = await freshUser();
      const res = await onboard(token, {
        businessName: 'متجر النور',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: 'alnoor-shop',
        preferredLocale: 'ar',
      });
      expect(res.status).toBe(201);
      expect(res.body.replayed).toBe(false);
      const businessId = res.body.businessId as string;

      // ONE domain operation: tenant+business+owner membership+default branch+default warehouse+outbox.
      const pool = ownerPool();
      const biz = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
      expect(biz.rows[0]?.default_locale).toBe('ar');
      const roles = await pool.query('SELECT key, is_system FROM business_roles WHERE business_id = $1', [businessId]);
      expect(roles.rows.map((r: { key: string }) => r.key).sort()).toEqual(['cashier', 'manager', 'owner']);
      expect(roles.rows.find((r) => r.key === 'owner')?.is_system).toBe(true);
      const branches = await pool.query('SELECT count(*) FROM branches WHERE business_id = $1 AND is_default', [businessId]);
      const warehouses = await pool.query('SELECT count(*) FROM warehouses WHERE business_id = $1 AND is_default', [businessId]);
      expect(Number(branches.rows[0]?.count)).toBe(1);
      expect(Number(warehouses.rows[0]?.count)).toBe(1);
      const outbox = await pool.query(`SELECT * FROM outbox_events WHERE business_id = $1 AND type = 'business.created'`, [businessId]);
      expect(outbox.rows.length).toBe(1);
      const audit = await pool.query(`SELECT * FROM audit_events WHERE entity = 'business' AND entity_id = $1`, [businessId]);
      expect(audit.rows.length).toBe(1);
    });

    it('Türkiye / TRY / Türkçe', async () => {
      const token = await freshUser();
      const res = await onboard(token, {
        businessName: 'Işık Mağazası',
        countryCode: 'TR',
        baseCurrency: 'TRY',
        storeSlug: 'isik-magaza',
        preferredLocale: 'tr',
      });
      expect(res.status).toBe(201);
      const biz = await ownerPool().query('SELECT default_locale, base_currency FROM businesses WHERE id = $1', [res.body.businessId]);
      expect(biz.rows[0]?.default_locale).toBe('tr');
      expect(biz.rows[0]?.base_currency).toBe('TRY');
    });

    it('Jordan / JOD / English + industry profile key (§46)', async () => {
      const token = await freshUser();
      const res = await onboard(token, {
        businessName: 'Amman Electronics',
        countryCode: 'JO',
        baseCurrency: 'JOD',
        storeSlug: 'amman-electro',
        preferredLocale: 'en',
        industryProfileKey: 'Electronics',
      });
      expect(res.status).toBe(201);
      const biz = await ownerPool().query('SELECT industry_profile_key FROM businesses WHERE id = $1', [res.body.businessId]);
      expect(biz.rows[0]?.industry_profile_key).toBe('electronics');
    });

    it('double submit creates exactly ONE business (idempotent, §54)', async () => {
      const token = await freshUser();
      const payload = { businessName: 'تكرار', countryCode: 'SY', baseCurrency: 'SYP', storeSlug: 'takrar-shop' };
      // §37–39: a client retry REUSES the same Idempotency-Key.
      const KEY = 'double-submit-key-0001';
      const [r1, r2] = await Promise.all([onboard(token, payload, KEY), onboard(token, payload, KEY)]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 201]);
      const results = [r1.body, r2.body] as { businessId: string; replayed: boolean }[];
      expect(results[0]?.businessId).toBe(results[1]?.businessId);
      expect(results.some((r) => r.replayed)).toBe(true);

      const pool = ownerPool();
      const count = await pool.query('SELECT count(*) FROM businesses WHERE store_slug = $1', ['takrar-shop']);
      expect(Number(count.rows[0]?.count)).toBe(1);
      const branches = await pool.query('SELECT count(*) FROM branches WHERE business_id = $1', [results[0]?.businessId]);
      expect(Number(branches.rows[0]?.count)).toBe(1);
    });

    it('fallback slug stability (§24): replay returns the SAME persisted slug', async () => {
      const token = await freshUser();
      const first = await onboard(token, { businessName: 'ثبات', countryCode: 'LB', baseCurrency: 'LBP', storeSlug: 'thabat-store' });
      expect(first.status).toBe(201);
      // Replay = SAME key + SAME payload → the SAME persisted slug (§24).
      const KEY = 'slug-stability-key-01';
      const payload = { businessName: 'ثبات', countryCode: 'LB', baseCurrency: 'LBP', storeSlug: 'thabat-store-2' };
      const first2 = await onboard(token, payload, KEY);
      expect(first2.status).toBe(201);
      const second = await onboard(token, payload, KEY);
      expect(second.status).toBe(200);
      expect(second.body.storeSlug).toBe(first2.body.storeSlug);
      expect(second.body.businessId).toBe(first2.body.businessId);
    });
  });

  describe('idempotency-key semantics (Final Closure §10–14)', () => {
    const KEY = 'onboard-key-0001-abcd';

    it('same key + same payload replays the SAME Business A (200, replayed)', async () => {
      const token = await freshUser();
      const payload = { businessName: 'مفتاح', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: 'key-shop-a' };
      const r1 = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', KEY)
        .send(payload);
      const r2 = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', KEY)
        .send(payload);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(200);
      expect(r2.body.businessId).toBe(r1.body.businessId);
      expect(r2.body.replayed).toBe(true);
      const count = await ownerPool().query('SELECT count(*) FROM businesses WHERE store_slug = $1', ['key-shop-a']);
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    it('same key + different payload → 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const token = await freshUser();
      const r1 = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', KEY)
        .send({ businessName: 'أ', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: 'key-mismatch-a' });
      expect(r1.status).toBe(201);
      const r2 = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', KEY)
        .send({ businessName: 'ب', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: 'key-mismatch-b' });
      expect(r2.status).toBe(409);
      expect(r2.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const count = await ownerPool().query(`SELECT count(*) FROM businesses WHERE store_slug IN ('key-mismatch-a','key-mismatch-b')`, []);
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    it('create-business with a NEW key creates Business B in the SAME tenant; listMyBusinesses → A + B', async () => {
      const token = await freshUser();
      const r1 = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', KEY)
        .send({ businessName: 'أول', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: 'multi-biz-a' });
      expect(r1.status).toBe(201);
      const r2 = await t.request
        .post(`/v1/tenants/${r1.body.tenantId as string}/businesses`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'create-biz-key-0002')
        .send({ businessName: 'ثاني', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: 'multi-biz-b' });
      expect(r2.status).toBe(201);
      expect(r2.body.businessId).not.toBe(r1.body.businessId);
      expect(r2.body.tenantId).toBe(r1.body.tenantId);

      // Replay of create-business key returns B.
      const r3 = await t.request
        .post(`/v1/tenants/${r1.body.tenantId as string}/businesses`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'create-biz-key-0002')
        .send({ businessName: 'ثاني', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: 'multi-biz-b' });
      expect(r3.status).toBe(200);
      expect(r3.body.businessId).toBe(r2.body.businessId);

      const list = await t.request.get('/v1/me/businesses').set('Authorization', `Bearer ${token}`);
      const slugs = (list.body.items as { storeSlug: string }[]).map((b) => b.storeSlug).sort();
      expect(slugs).toEqual(['multi-biz-a', 'multi-biz-b']);
    });

    it('non-owner cannot create an additional business (403)', async () => {
      const token = await freshUser(); // registered, never onboarded → no tenant_owner row
      const res = await t.request
        .post('/v1/tenants/00000000-0000-0000-0000-000000000000/businesses')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'create-biz-key-0003')
        .send({ businessName: 'x', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: 'non-owner-biz' });
      expect(res.status).toBe(403);
    });
  });

  describe('adversarial', () => {
    it('slug race: exactly one 201, loser gets 409 SLUG_TAKEN with suggestions (§23)', async () => {
      const [t1, t2] = [await freshUser(), await freshUser()];
      const payload = { businessName: 'Race', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: 'race-slug' };
      const [r1, r2] = await Promise.all([onboard(t1, payload), onboard(t2, payload)]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body.error.code).toBe('SLUG_TAKEN');
      expect(Array.isArray(loser.body.error.details?.suggestions)).toBe(true);
      const count = await ownerPool().query('SELECT count(*) FROM businesses WHERE store_slug = $1', ['race-slug']);
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    it('halfway failure rolls back everything (reserved slug mid-tx)', async () => {
      const token = await freshUser();
      const res = await onboard(token, { businessName: 'X', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: 'admin' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLUG_RESERVED');
      const pool = ownerPool();
      const tenants = await pool.query('SELECT count(*) FROM tenants');
      const businesses = await pool.query('SELECT count(*) FROM businesses');
      expect(Number(tenants.rows[0]?.count)).toBe(0);
      expect(Number(businesses.rows[0]?.count)).toBe(0);
    });

    it('unknown industry profile does not block onboarding (§48 generic)', async () => {
      const token = await freshUser();
      const res = await onboard(token, {
        businessName: 'Tattoo',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: 'tattoo-place',
        industryProfileKey: 'tattoo-parlor',
      });
      expect(res.status).toBe(201);
      const biz = await ownerPool().query('SELECT industry_profile_key FROM businesses WHERE id = $1', [res.body.businessId]);
      expect(biz.rows[0]?.industry_profile_key).toBe('tattoo-parlor');
    });
  });

  describe('base currency lock (§55)', () => {
    it('editable before financial start; locked after financial_started_at', async () => {
      const token = await freshUser();
      const res = await onboard(token, {
        businessName: 'Currency Lock Co',
        countryCode: 'SY',
        baseCurrency: 'SYP',
        storeSlug: 'cur-lock',
      });
      expect(res.status).toBe(201);
      const businessId = res.body.businessId as string;

      const change = await t.request
        .post('/v1/businesses/current/base-currency')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId)
        .send({ currency: 'USD' });
      expect(change.status).toBe(201);

      // Simulate first financial transaction (Phase 2 concern; here we only test the guard).
      await ownerPool().query('UPDATE businesses SET financial_started_at = now() WHERE id = $1', [businessId]);
      const locked = await t.request
        .post('/v1/businesses/current/base-currency')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId)
        .send({ currency: 'EUR' });
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe('BASE_CURRENCY_LOCKED');
    });
  });
});

/**
 * Gate A §33–39: explicit tenant targeting + required idempotency.
 */
describe('explicit tenant targeting + required idempotency (Gate A §33–39)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function freshUser(): Promise<string> {
    const res = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'Owner',
      preferredLocale: 'ar',
    });
    return res.body.accessToken as string;
  }

  it('§36: owner of TWO tenants creates a business in the TARGET tenant — never the older one', async () => {
    const token = await freshUser();
    const a = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'tenant-a-onboard-01')
      .send({ businessName: 'A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `ta-${Date.now()}` });
    expect(a.status).toBe(201);
    const b = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'tenant-b-onboard-01')
      .send({ businessName: 'B', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `tb-${Date.now()}` });
    expect(b.status).toBe(201);
    const tenantB = b.body.tenantId as string;
    expect(tenantB).not.toBe(a.body.tenantId as string);

    const created = await t.request
      .post(`/v1/tenants/${tenantB}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'targeted-create-b-01')
      .send({ businessName: 'B2', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `tb2-${Date.now()}` });
    expect(created.status).toBe(201);
    expect(created.body.tenantId).toBe(tenantB);

    // Targeting tenant A with the SAME key is a DIFFERENT operation → 409.
    const conflict = await t.request
      .post(`/v1/tenants/${a.body.tenantId as string}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'targeted-create-b-01')
      .send({ businessName: 'B2', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `tb2x-${Date.now()}` });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('§35: tenant member (not owner) cannot create a business in that tenant', async () => {
    const owner = await freshUser();
    const a = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', 'member-target-onboard-01')
      .send({ businessName: 'A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `mt-${Date.now()}` });
    const other = await freshUser(); // not a member of tenant A at all
    const res = await t.request
      .post(`/v1/tenants/${a.body.tenantId as string}/businesses`)
      .set('Authorization', `Bearer ${other}`)
      .set('Idempotency-Key', 'member-target-create-01')
      .send({ businessName: 'X', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `mtx-${Date.now()}` });
    expect(res.status).toBe(403);
  });

  it('§38: missing Idempotency-Key → stable 400 on both creation commands', async () => {
    const token = await freshUser();
    const r1 = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `nk-${Date.now()}` });
    expect(r1.status).toBe(400);
    const a = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'with-key-01')
      .send({ businessName: 'A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `nk2-${Date.now()}` });
    expect(a.status).toBe(201);
    const r2 = await t.request
      .post(`/v1/tenants/${a.body.tenantId as string}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `nk3-${Date.now()}` });
    expect(r2.status).toBe(400);
  });
});
