import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { appDbUrl, createTestApp, ensurePostgres, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * Completion Directive §39–40 — IDENTIFIER REGISTRY, DB-ENFORCED.
 * catalog_identifiers guarantees business-wide uniqueness of SKU and barcode
 * ACROSS products and variants. Every path below bypasses the API and writes
 * raw SQL (as the schema owner and as daftar_app): a collision must fail at
 * the database, never only in application code.
 */
describe('catalog identifier registry (§39–40)', () => {
  let t: TestApp;
  let tenantId = '';
  let businessA = '';
  let businessB = '';

  beforeAll(async () => {
    await ensurePostgres();
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'I', preferredLocale: 'en' });
    const token = (reg.body as { accessToken: string }).accessToken;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `ids-${Date.now()}`)
      .send({ businessName: 'Ids A', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `ids-a-${Date.now()}` });
    tenantId = (on.body as { tenantId: string }).tenantId;
    businessA = (on.body as { businessId: string }).businessId;
    const on2 = await t.request
      .post(`/v1/tenants/${tenantId}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `ids2-${Date.now()}`)
      .send({ businessName: 'Ids B', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `ids-b-${Date.now()}` });
    businessB = (on2.body as { businessId: string }).businessId;
  });

  async function rawProduct(businessId: string, sku: string | null, barcode: string | null = null): Promise<string> {
    const { rows } = await ownerPool().query<{ id: string }>(
      `WITH p AS (INSERT INTO products (business_id, sku, barcode, base_price_minor, price_currency) VALUES ($1, $2, $3, 100, 'JOD') RETURNING id, business_id)
       INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'en', 'raw' FROM p RETURNING product_id AS id`,
      [businessId, sku, barcode],
    );
    return rows[0]?.id as string;
  }
  async function rawVariant(businessId: string, productId: string, sku: string | null, barcode: string | null = null): Promise<string> {
    const { rows } = await ownerPool().query<{ id: string }>(
      `INSERT INTO product_variants (business_id, product_id, sku, barcode) VALUES ($1, $2, $3, $4) RETURNING id`,
      [businessId, productId, sku, barcode],
    );
    return rows[0]?.id as string;
  }

  it("product SKU vs another product's VARIANT SKU (case-insensitive) collides at the DB", async () => {
    const p1 = await rawProduct(businessA, 'ROOT-1');
    await rawVariant(businessA, p1, 'Var-Blue');
    await expect(rawProduct(businessA, 'var-blue')).rejects.toThrow(/catalog_identifiers_pkey|duplicate key/);
    // registry holds exactly the live identifiers
    const reg = await ownerPool().query<{ kind: string; value_norm: string; owner_type: string }>(
      `SELECT kind, value_norm, owner_type FROM catalog_identifiers WHERE business_id = $1 ORDER BY value_norm`,
      [businessA],
    );
    expect(reg.rows).toEqual([
      { kind: 'sku', value_norm: 'root-1', owner_type: 'product' },
      { kind: 'sku', value_norm: 'var-blue', owner_type: 'variant' },
    ]);
  });

  it('variant SKU vs an existing PRODUCT SKU collides; barcode collisions collide exactly', async () => {
    const p = await rawProduct(businessA, 'PROD-X', '6291041500213');
    await expect(rawVariant(businessA, p, 'prod-x')).rejects.toThrow(/duplicate key/);
    await expect(rawVariant(businessA, p, null, '6291041500213')).rejects.toThrow(/duplicate key/);
    await expect(rawProduct(businessA, null, '6291041500213')).rejects.toThrow(/duplicate key/);
  });

  it('the same SKU in ANOTHER business is allowed (business-wide scope, not global)', async () => {
    await rawProduct(businessB, 'ROOT-1');
    const n = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM catalog_identifiers WHERE kind = 'sku' AND value_norm = 'root-1'`);
    expect(n.rows[0]?.n).toBe('2');
  });

  it('archiving releases the identifier; un-archiving re-registers and can collide again', async () => {
    const p = await rawProduct(businessA, 'RELEASE-ME');
    await ownerPool().query(`UPDATE products SET status = 'archived' WHERE id = $1`, [p]);
    expect((await ownerPool().query(`SELECT 1 FROM catalog_identifiers WHERE business_id = $1 AND value_norm = 'release-me'`, [businessA])).rows).toEqual([]);
    const p2 = await rawProduct(businessA, 'release-me'); // free again
    await expect(ownerPool().query(`UPDATE products SET status = 'active' WHERE id = $1`, [p])).rejects.toThrow(/duplicate key/);
    await ownerPool().query(`UPDATE products SET sku = NULL WHERE id = $1`, [p2]);
    await ownerPool().query(`UPDATE products SET status = 'active' WHERE id = $1`, [p]); // now possible
  });

  it('as daftar_app (RLS scope): a cross-table collision still fails inside the business scope', async () => {
    const p = await rawProduct(businessA, 'APP-1');
    await rawVariant(businessA, p, 'APP-VAR');
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessA]);
      await expect(
        c.query(`INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, 'app-var', 1, 'JOD')`, [businessA]),
      ).rejects.toThrow(/duplicate key/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('§37 normalized translations: JSONB columns are gone and a product cannot exist without a translation', async () => {
    const cols = await ownerPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_name IN ('products','categories') AND column_name = 'translations'`,
    );
    expect(cols.rows).toEqual([]);
    await expect(ownerPool().query(`INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ($1, 1, 'JOD')`, [businessA])).rejects.toThrow(
      /requires at least one translation/,
    );
    // The last translation of a product cannot be deleted.
    const p = await rawProduct(businessA, null);
    await expect(ownerPool().query(`DELETE FROM product_translations WHERE product_id = $1`, [p])).rejects.toThrow(/requires at least one translation/);
  });
});
