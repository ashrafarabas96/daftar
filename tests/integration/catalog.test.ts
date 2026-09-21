import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/** Catalog (§56–57, §93, §96–98): golden flows + adversarial + concurrency. */
describe('catalog', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'Merchant',
      preferredLocale: 'ar',
    });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'Catalog Co',
        countryCode: 'JO',
        baseCurrency: 'JOD',
        storeSlug: `cat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    businessId = on.body.businessId as string;
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  describe('golden', () => {
    it('category with 3 translations', async () => {
      const res = await t.request
        .post('/v1/catalog/categories')
        .set(auth())
        .send({
          translations: { ar: 'قهوة', en: 'Coffee', tr: 'Kahve' },
        });
      expect(res.status).toBe(201);
      expect(res.body.translations.tr).toBe('Kahve');
    });

    it('minimal product: Name + Price + Save ONLY (§57) + outbox event emitted', async () => {
      const res = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'قهوة عربية' },
          basePriceMinor: '1500',
          priceCurrency: 'JOD',
        });
      expect(res.status).toBe(201);
      const outbox = await ownerPool().query(`SELECT * FROM outbox_events WHERE business_id = $1 AND type = 'catalog.product_created'`, [businessId]);
      expect(outbox.rows.length).toBe(1);
      const audit = await ownerPool().query(`SELECT * FROM audit_events WHERE entity = 'product' AND entity_id = $1`, [res.body.id]);
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]?.request_id).toBeTruthy();
    });

    it('full product + variants + search by name/sku/barcode', async () => {
      const res = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'قميص', en: 'Shirt' },
          basePriceMinor: '25000',
          priceCurrency: 'JOD',
          sku: 'SHIRT-1',
          barcode: '6291234567890',
          unit: 'piece',
          variants: [
            { attributes: { size: 'M', color: 'black' }, sku: 'SHIRT-1-M' },
            { attributes: { size: 'L', color: 'black' }, sku: 'SHIRT-1-L', priceMinor: '26000' },
          ],
        });
      expect(res.status).toBe(201);

      const byName = await t.request.get('/v1/catalog/products?search=Shirt').set(auth());
      expect(byName.body.items.length).toBe(1);
      const bySku = await t.request.get('/v1/catalog/products?search=shirt-1-m').set(auth());
      expect(bySku.body.items.length).toBe(1);
      const byBarcode = await t.request.get('/v1/catalog/products?search=6291234567890').set(auth());
      expect(byBarcode.body.items.length).toBe(1);

      const detail = await t.request.get(`/v1/catalog/products/${res.body.id as string}`).set(auth());
      expect(detail.body.variants.length).toBe(2);
      expect(detail.body.basePriceMinor).toBe('25000');
      expect(typeof detail.body.basePriceMinor).toBe('string');
    });

    it('duplicate SKU in same business → 409; same SKU in ANOTHER business → allowed', async () => {
      const payload = { translations: { ar: 'أول' }, basePriceMinor: '100', priceCurrency: 'JOD', sku: 'DUP-1' };
      expect((await t.request.post('/v1/catalog/products').set(auth()).send(payload)).status).toBe(201);
      const dup = await t.request.post('/v1/catalog/products').set(auth()).send(payload);
      expect(dup.status).toBe(409);

      // other business, same SKU → OK
      const reg2 = await t.request.post('/v1/auth/register').send({
        email: uniqueEmail(),
        password: 'Str0ng!Passw0rd',
        displayName: 'Other',
        preferredLocale: 'en',
      });
      const token2 = reg2.body.accessToken as string;
      const on2 = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token2}`)
        .send({
          businessName: 'Other Biz',
          countryCode: 'TR',
          baseCurrency: 'TRY',
          storeSlug: `other-${Date.now()}`,
        });
      const ok = await t.request
        .post('/v1/catalog/products')
        .set({ Authorization: `Bearer ${token2}`, 'X-Business-Id': on2.body.businessId as string })
        .send({ ...payload, priceCurrency: 'TRY' }); // §36: currency must equal the business base currency
      expect(ok.status).toBe(201);
    });

    it('duplicate SKU inside one payload → 409', async () => {
      const res = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'داخلي' },
          basePriceMinor: '100',
          priceCurrency: 'JOD',
          sku: 'INNER-1',
          variants: [{ attributes: {}, sku: 'inner-1' }],
        });
      expect(res.status).toBe(409);
    });

    it('update + optimistic concurrency (§98): stale version rejected, no silent lost update', async () => {
      const created = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'منتج' },
          basePriceMinor: '100',
          priceCurrency: 'JOD',
        });
      const id = created.body.id as string;
      const upd1 = await t.request.patch(`/v1/catalog/products/${id}`).set(auth()).send({ basePriceMinor: '200', version: 1 });
      expect(upd1.status).toBe(200);
      // stale writer with version 1 again → 409
      const stale = await t.request.patch(`/v1/catalog/products/${id}`).set(auth()).send({ basePriceMinor: '300', version: 1 });
      expect(stale.status).toBe(409);
      // current state is upd1's
      const detail = await t.request.get(`/v1/catalog/products/${id}`).set(auth());
      expect(detail.body.basePriceMinor).toBe('200');
      expect(detail.body.version).toBe(2);
    });

    it('concurrent updates both apply, version ends at 3 (no lost update)', async () => {
      const created = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'تزامن' },
          basePriceMinor: '100',
          priceCurrency: 'JOD',
        });
      const id = created.body.id as string;
      const [r1, r2] = await Promise.all([
        t.request.patch(`/v1/catalog/products/${id}`).set(auth()).send({ unit: 'kg' }),
        t.request.patch(`/v1/catalog/products/${id}`).set(auth()).send({ sku: 'CONC-1' }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const detail = await t.request.get(`/v1/catalog/products/${id}`).set(auth());
      expect(detail.body.version).toBe(3);
      expect(detail.body.unit).toBe('kg');
      expect(detail.body.sku).toBe('CONC-1');
    });

    it('archive removes from list; audit has before/after trail', async () => {
      const created = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'أرشيف' },
          basePriceMinor: '100',
          priceCurrency: 'JOD',
        });
      const id = created.body.id as string;
      expect((await t.request.delete(`/v1/catalog/products/${id}`).set(auth())).status).toBe(200);
      const list = await t.request.get('/v1/catalog/products').set(auth());
      expect(list.body.items.length).toBe(0);
      const audit = await ownerPool().query(`SELECT action FROM audit_events WHERE entity = 'product' AND entity_id = $1 ORDER BY created_at`, [id]);
      expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(['catalog.product_created', 'catalog.product_archived']);
    });

    it('pagination: cursor pages, stable order, no duplicates', async () => {
      for (let i = 0; i < 5; i += 1) {
        await t.request
          .post('/v1/catalog/products')
          .set(auth())
          .send({
            translations: { ar: `منتج ${i}` },
            basePriceMinor: String(100 + i),
            priceCurrency: 'JOD',
          });
      }
      const p1 = await t.request.get('/v1/catalog/products?limit=2').set(auth());
      expect(p1.body.items.length).toBe(2);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await t.request.get(`/v1/catalog/products?limit=2&cursor=${p1.body.nextCursor as string}`).set(auth());
      expect(p2.body.items.length).toBe(2);
      const ids = [...p1.body.items, ...p2.body.items].map((x: { id: string }) => x.id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  describe('adversarial', () => {
    it('limit 9999 → 400 (max page size §96)', async () => {
      const res = await t.request.get('/v1/catalog/products?limit=9999').set(auth());
      expect(res.status).toBe(400);
    });

    it('invalid UUID path param → 400 not 500', async () => {
      const res = await t.request.get('/v1/catalog/products/not-a-uuid').set(auth());
      expect(res.status).toBe(400);
    });

    it('strict schema: unexpected field → 400 (§94)', async () => {
      const res = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'x' },
          basePriceMinor: '100',
          priceCurrency: 'JOD',
          business_id: 'injected',
          stock: 5,
        });
      expect(res.status).toBe(400);
    });

    it('unsupported currency → 400', async () => {
      const res = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'x' },
          basePriceMinor: '100',
          priceCurrency: 'BTC',
        });
      expect(res.status).toBe(400);
    });

    it('oversized SKU → 400', async () => {
      const res = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({
          translations: { ar: 'x' },
          basePriceMinor: '100',
          priceCurrency: 'JOD',
          sku: 'S'.repeat(65),
        });
      expect(res.status).toBe(400);
    });

    it('no product.stock / quantity columns exist (§56) — DB-level proof', async () => {
      const cols = await ownerPool().query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('products','product_variants') AND (column_name ILIKE '%stock%' OR column_name ILIKE '%quantity%')`,
      );
      expect(cols.rows).toEqual([]);
    });

    it('empty state: list returns empty page, not an error', async () => {
      const res = await t.request.get('/v1/catalog/products').set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });
  });
});
