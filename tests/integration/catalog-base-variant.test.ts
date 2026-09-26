import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDbUrl, createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * P3-AL-52 — the hidden base variant may not appear, and may not be touched.
 *
 * Rows 1–8 of the permanent proofs. Enabling inventory on a product must not
 * change a single byte of what the accepted catalog API returns for it: not
 * the product read, not the list, not name / SKU / barcode search.
 */
describe('P3-AL-52: the hidden base variant (P3-S1)', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;
  let tenantId: string;
  const appPool = new Pool({ connectionString: appDbUrl, max: 2 });

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request
      .post('/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Merchant', preferredLocale: 'ar' });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `base-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'Base Variant', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `basevar-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    businessId = on.body.businessId as string;
    tenantId = (await ownerPool().query<{ tenant_id: string }>('SELECT tenant_id FROM businesses WHERE id = $1', [businessId])).rows[0]?.tenant_id ?? '';
  });
  afterEach(async () => {
    await t?.close();
  });
  afterAll(async () => {
    await appPool.end();
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  async function create(body: Record<string, unknown>): Promise<string> {
    const res = await t.request.post('/v1/catalog/products').set(auth()).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function enable(productId: string, unitCode = 'piece') {
    const res = await t.request.put(`/v1/inventory/products/${productId}/configuration`).set(auth()).send({ trackInventory: true, unitCode });
    expect(res.status).toBe(200);
  }

  async function baseRows(productId: string) {
    return (await ownerPool().query<{ id: string }>('SELECT id FROM product_variants WHERE product_id = $1 AND is_base', [productId])).rows;
  }

  /**
   * The golden catalog fixtures (tests/golden-regression/phase1/03-catalog-
   * commerce.golden.test.ts, P1-GOLD-17 and P1-GOLD-22), plus a simple product
   * carrying its own SKU and barcode so identifier search has something to find.
   */
  async function goldenFixtures(): Promise<{ simple: string; identified: string; variant: string }> {
    const simple = await create({ translations: { ar: 'قهوة عربية' }, basePriceMinor: '1500', priceCurrency: 'JOD' });
    const identified = await create({
      translations: { ar: 'شاي', en: 'Tea' },
      basePriceMinor: '900',
      sku: 'TEA-1',
      barcode: '6250000000017',
      unit: 'علبة',
    });
    const variant = await create({
      translations: { ar: 'قميص', en: 'Shirt' },
      basePriceMinor: '25000',
      priceCurrency: 'JOD',
      sku: 'SHIRT-1',
      variants: [
        { attributes: { size: 'M' }, sku: 'SHIRT-1-M' },
        { attributes: { size: 'L' }, sku: 'SHIRT-1-L', priceMinor: '26000', barcode: '6250000000024' },
      ],
    });
    return { simple, identified, variant };
  }

  /** Everything the merchant catalog API says about the fixtures, as bytes. */
  async function catalogSnapshot(ids: readonly string[]): Promise<string> {
    const out: unknown[] = [];
    for (const id of ids) {
      for (const lang of ['ar', 'en']) {
        const r = await t.request.get(`/v1/catalog/products/${id}`).set(auth()).set('Accept-Language', lang);
        expect(r.status).toBe(200);
        out.push(r.body);
      }
    }
    for (const q of [
      '',
      '?search=قهوة',
      '?search=Tea',
      '?search=TEA-1',
      '?search=6250000000017',
      '?search=SHIRT-1-L',
      '?search=6250000000024',
      '?search=nothing',
    ]) {
      const r = await t.request.get(`/v1/catalog/products${q}`).set(auth());
      expect(r.status).toBe(200);
      out.push(r.body);
    }
    return JSON.stringify(out);
  }

  it('rows 1, 2, 3, 6: enabling tracking leaves every catalog read byte-identical — simple stays simple, search unchanged', async () => {
    const f = await goldenFixtures();
    const ids = [f.simple, f.identified, f.variant];
    const before = await catalogSnapshot(ids);

    for (const id of ids) await enable(id);

    // A product with no merchant variants received its base variant…
    expect(await baseRows(f.simple)).toHaveLength(1);
    expect(await baseRows(f.identified)).toHaveLength(1);
    // …and none of it is visible.
    const simple = await t.request.get(`/v1/catalog/products/${f.simple}`).set(auth());
    expect(simple.body.variants).toEqual([]);
    const variant = await t.request.get(`/v1/catalog/products/${f.variant}`).set(auth());
    expect((variant.body.variants as { sku: string }[]).map((v) => v.sku).sort()).toEqual(['SHIRT-1-L', 'SHIRT-1-M']);
    for (const b of await baseRows(f.identified)) {
      const got = await t.request.get(`/v1/catalog/products/${f.identified}`).set(auth());
      expect((got.body.variants as { id: string }[]).map((v) => v.id)).not.toContain(b.id);
    }

    expect(await catalogSnapshot(ids)).toBe(before);
  });

  it('row 4: a base variant carries NULL identifiers, which the partial unique indexes do not index — it cannot shadow the product', async () => {
    const f = await goldenFixtures();
    await enable(f.identified);
    const base = (
      await ownerPool().query<{ sku: string | null; barcode: string | null }>('SELECT sku, barcode FROM product_variants WHERE product_id = $1 AND is_base', [
        f.identified,
      ])
    ).rows;
    expect(base).toEqual([{ sku: null, barcode: null }]);
    const indexes = (
      await ownerPool().query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'product_variants' AND indexname IN ('variants_sku_uq', 'variants_barcode_uq') ORDER BY indexname`,
      )
    ).rows;
    expect(indexes.map((i) => i.indexname)).toEqual(['variants_barcode_uq', 'variants_sku_uq']);
    expect(indexes.find((i) => i.indexname === 'variants_sku_uq')?.indexdef).toMatch(/WHERE \(sku IS NOT NULL\)/);
    expect(indexes.find((i) => i.indexname === 'variants_barcode_uq')?.indexdef).toMatch(/WHERE \(barcode IS NOT NULL\)/);

    // The product keeps its identifiers, and the business's identifier space is unchanged:
    // a new product may not reuse them, exactly as before enablement.
    const clash = await t.request
      .post('/v1/catalog/products')
      .set(auth())
      .send({ translations: { ar: 'نسخة' }, basePriceMinor: '1', sku: 'TEA-1' });
    expect(clash.status).toBe(409);
    const fresh = await t.request
      .post('/v1/catalog/products')
      .set(auth())
      .send({ translations: { ar: 'جديد' }, basePriceMinor: '1', sku: 'TEA-2' });
    expect(fresh.status).toBe(201);
  });

  it('row 5: enabling tracking twice makes exactly one base variant, with no error', async () => {
    const f = await goldenFixtures();
    await enable(f.simple);
    const first = await baseRows(f.simple);
    await enable(f.simple);
    await enable(f.simple, 'kg');
    const after = await baseRows(f.simple);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first[0]?.id);
  });

  it('row 7 (command): no ordinary catalog command can reach a base variant', async () => {
    const f = await goldenFixtures();
    await enable(f.simple);
    // The product update command has no variant surface at all…
    const viaUpdate = await t.request
      .patch(`/v1/catalog/products/${f.simple}`)
      .set(auth())
      .send({ variants: [{ attributes: {}, sku: 'HIJACK' }] });
    expect(viaUpdate.status).toBe(400);
    // …and the create command cannot mint a base row.
    const viaCreate = await t.request
      .post('/v1/catalog/products')
      .set(auth())
      .send({ translations: { ar: 'مزيف' }, basePriceMinor: '1', variants: [{ attributes: {}, isBase: true }] });
    expect(viaCreate.status).toBe(400);
    // Archiving the product is a product write and leaves the base variant untouched.
    const archive = await t.request.delete(`/v1/catalog/products/${f.simple}`).set(auth());
    expect(archive.status).toBe(200);
    const base = (
      await ownerPool().query<{ status: string; sku: string | null }>('SELECT status, sku FROM product_variants WHERE product_id = $1 AND is_base', [f.simple])
    ).rows;
    expect(base).toEqual([{ status: 'active', sku: null }]);
  });

  it('row 7 (raw SQL as daftar_app): UPDATE of a base variant is refused with catalog.base_variant_not_mutable; DELETE by privilege', async () => {
    const f = await goldenFixtures();
    await enable(f.simple);
    const baseId = (await baseRows(f.simple))[0]?.id ?? '';

    async function asApp(sql: string, params: unknown[]): Promise<{ code?: string; message: string } | null> {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessId]);
        await c.query(sql, params);
        await c.query('ROLLBACK');
        return null;
      } catch (e) {
        await c.query('ROLLBACK');
        return e as { code?: string; message: string };
      } finally {
        c.release();
      }
    }

    for (const sql of [
      `UPDATE product_variants SET sku = 'HIJACK' WHERE id = $1`,
      `UPDATE product_variants SET barcode = '1234567890123' WHERE id = $1`,
      `UPDATE product_variants SET price_minor = 1 WHERE id = $1`,
      `UPDATE product_variants SET attributes = '{"size":"XL"}'::jsonb WHERE id = $1`,
      `UPDATE product_variants SET status = 'archived' WHERE id = $1`,
      `UPDATE product_variants SET is_base = false WHERE id = $1`,
    ]) {
      const err = await asApp(sql, [baseId]);
      expect(err?.message, sql).toMatch(/^catalog\.base_variant_not_mutable\b/);
    }
    const insert = await asApp(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, gen_random_uuid(), $2, true)`, [
      businessId,
      f.variant,
    ]);
    expect(insert?.message).toMatch(/^catalog\.base_variant_not_mutable\b/);
    const del = await asApp(`DELETE FROM product_variants WHERE id = $1`, [baseId]);
    expect(del?.code).toBe('42501');

    expect(await baseRows(f.simple)).toEqual([{ id: baseId }]);
  });

  it('row 8: a second base row is refused by the unique index, and a base row carrying a SKU by the CHECK', async () => {
    const f = await goldenFixtures();
    await enable(f.simple);
    // The authority trigger would refuse both first; replica mode silences
    // triggers only, so what answers here is the index and the CHECK themselves.
    async function asOwnerWithoutTriggers(sql: string, params: unknown[]): Promise<{ code?: string; constraint?: string } | null> {
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(sql, params);
        await c.query('ROLLBACK');
        return null;
      } catch (e) {
        await c.query('ROLLBACK');
        return e as { code?: string; constraint?: string };
      } finally {
        c.release();
      }
    }
    const second = await asOwnerWithoutTriggers(
      `INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, gen_random_uuid(), $2, true)`,
      [businessId, f.simple],
    );
    expect(second?.code).toBe('23505');
    const withSku = await asOwnerWithoutTriggers(
      `INSERT INTO product_variants (business_id, id, product_id, is_base, sku) VALUES ($1, gen_random_uuid(), $2, true, 'BASE-SKU')`,
      [businessId, f.identified],
    );
    expect(withSku?.code).toBe('23514');
  });
});
