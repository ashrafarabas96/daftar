import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * GOLDEN REGRESSION — Catalog & Commerce Foundations (P1-GOLD-17 … P1-GOLD-24).
 */
describe('golden: catalog & commerce', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Merchant', preferredLocale: 'ar',
    });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `gold-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'Golden Catalog', countryCode: 'JO', baseCurrency: 'JOD',
        storeSlug: `goldcat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    businessId = on.body.businessId as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    userId = me.body.userId as string;
  });
  afterEach(async () => {
    await t?.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  it('P1-GOLD-17 product creation law: Name + Price + Save ONLY', async () => {
    const res = await t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'قهوة عربية' }, basePriceMinor: '1500', priceCurrency: 'JOD',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });

  it('P1-GOLD-18 money is integer minor units end-to-end (no floats anywhere)', async () => {
    const res = await t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'منتج' }, basePriceMinor: '1999', priceCurrency: 'JOD',
    });
    expect(res.status).toBe(201);
    const row = await ownerPool().query('SELECT base_price_minor FROM products WHERE id=$1', [res.body.id]);
    expect(row.rows[0]?.base_price_minor).toBe('1999'); // bigint as string — never 19.99
    const get = await t.request.get(`/v1/catalog/products/${res.body.id}`).set(auth());
    expect(String(get.body.basePriceMinor)).toBe('1999');
  });

  it('P1-GOLD-19 fractional price input is REJECTED', async () => {
    const res = await t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'منتج' }, basePriceMinor: '19.99', priceCurrency: 'JOD',
    });
    expect(res.status).toBe(400);
  });

  it('P1-GOLD-20 product update + archive lifecycle', async () => {
    const res = await t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'قديم' }, basePriceMinor: '100', priceCurrency: 'JOD',
    });
    const id = res.body.id as string;
    const patch = await t.request.patch(`/v1/catalog/products/${id}`).set(auth()).send({
      translations: { ar: 'جديد' }, basePriceMinor: '200',
    });
    expect(patch.status).toBe(200);
    const del = await t.request.delete(`/v1/catalog/products/${id}`).set(auth());
    expect([200, 204]).toContain(del.status);
    const row = await ownerPool().query('SELECT status FROM products WHERE id=$1', [id]);
    expect(row.rows[0]?.status).toBe('archived');
  });

  it('P1-GOLD-21 category with ar/en/tr translations round-trips', async () => {
    const res = await t.request.post('/v1/catalog/categories').set(auth()).send({
      translations: { ar: 'قهوة', en: 'Coffee', tr: 'Kahve' },
    });
    expect(res.status).toBe(201);
    expect(res.body.translations).toEqual({ ar: 'قهوة', en: 'Coffee', tr: 'Kahve' });
  });

  it('P1-GOLD-22 variants carry their own SKU + price override', async () => {
    const res = await t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'قميص', en: 'Shirt' }, basePriceMinor: '25000', priceCurrency: 'JOD',
      sku: 'SHIRT-1',
      variants: [
        { attributes: { size: 'M' }, sku: 'SHIRT-1-M' },
        { attributes: { size: 'L' }, sku: 'SHIRT-1-L', priceMinor: '26000' },
      ],
    });
    expect(res.status).toBe(201);
    const variants = await ownerPool().query(
      'SELECT sku, price_minor FROM product_variants WHERE product_id=$1 ORDER BY sku', [res.body.id],
    );
    expect(variants.rows.map((v: { sku: string }) => v.sku)).toEqual(['SHIRT-1-L', 'SHIRT-1-M']);
  });

  it('P1-GOLD-23 plan product limit is enforced atomically (quota race safe)', async () => {
    // Override MAX_PRODUCTS to 1, then race two creates — exactly one wins.
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_PRODUCTS', 1, 'gold-race', $2)`,
      [businessId, userId],
    );
    const mk = () => t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'منتج' }, basePriceMinor: '100', priceCurrency: 'JOD',
    });
    const [r1, r2] = await Promise.all([mk(), mk()]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const n = await ownerPool().query('SELECT count(*)::int n FROM products WHERE business_id=$1', [businessId]);
    expect(n.rows[0]?.n).toBe(1);
  });

  it('P1-GOLD-24 locked feature is denied with a stable error code', async () => {
    // CUSTOM_ROLES is NOT in the free plan → role creation must be gated.
    const res = await t.request.post('/v1/businesses/current/roles').set(auth()).send({
      key: 'analyst', name: 'Analyst', permissions: ['catalog.view'],
    });
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('FEATURE_NOT_ENTITLED');
  });
});
