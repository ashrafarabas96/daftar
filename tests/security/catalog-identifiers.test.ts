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

  /**
   * Final Release Blocker 2 — OWNER INTEGRITY. Every registry row must
   * reference exactly one REAL owner (product XOR variant) in the same
   * business, and the registry is internal: only the owner-row triggers may
   * write it. Raw SQL as the schema owner AND as daftar_app.
   */
  describe('owner integrity (Blocker 2, migration 0039)', () => {
    const rnd = () =>
      ownerPool()
        .query<{ u: string }>('SELECT gen_random_uuid()::text AS u')
        .then((r) => r.rows[0]?.u as string);

    it('a FAKE product owner uuid is rejected (composite FK)', async () => {
      const fake = await rnd();
      await expect(
        ownerPool().query(
          `INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id) VALUES ($1, 'sku', 'ghost-p', 'product', $2, $2)`,
          [businessA, fake],
        ),
      ).rejects.toThrow(/catalog_identifiers_product_fk|violates foreign key/);
    });

    it('a FAKE variant owner uuid is rejected (composite FK)', async () => {
      const fake = await rnd();
      await expect(
        ownerPool().query(
          `INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, variant_id) VALUES ($1, 'sku', 'ghost-v', 'variant', $2, $2)`,
          [businessA, fake],
        ),
      ).rejects.toThrow(/catalog_identifiers_variant_fk|violates foreign key/);
    });

    it('a CROSS-BUSINESS owner is rejected: business B cannot register an identifier owned by a product of business A', async () => {
      const pA = await rawProduct(businessA, null);
      await expect(
        ownerPool().query(
          `INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id) VALUES ($1, 'sku', 'stolen', 'product', $2, $2)`,
          [businessB, pA],
        ),
      ).rejects.toThrow(/violates foreign key/);
    });

    it('owner XOR: a row cannot claim both, neither, or a mismatching owner column', async () => {
      const p = await rawProduct(businessA, null);
      const v = await rawVariant(businessA, p, null);
      const cases: { label: string; sql: string; params: unknown[] }[] = [
        { label: 'both', sql: `'product', $2, $2, $3`, params: [businessA, p, v] },
        { label: 'neither', sql: `'product', $2, NULL, NULL`, params: [businessA, p] },
        { label: 'product typed, variant column', sql: `'product', $2, NULL, $3`, params: [businessA, p, v] },
        { label: 'variant typed, product column', sql: `'variant', $3, $2, NULL`, params: [businessA, p, v] },
      ];
      for (const c of cases) {
        await expect(
          ownerPool().query(
            `INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id, variant_id) VALUES ($1, 'sku', 'xor-${c.label.replace(/\W/g, '')}', ${c.sql})`,
            c.params,
          ),
          c.label,
        ).rejects.toThrow(/catalog_identifiers_owner_xor|check constraint/);
      }
    });

    it('the registry is INTERNAL: daftar_app cannot INSERT, UPDATE or DELETE registry rows directly (only owner-row triggers write it)', async () => {
      const p = await rawProduct(businessA, 'INTERNAL-1');
      const c = new Client({ connectionString: appDbUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessA]);
        await expect(
          c.query(
            `INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id) VALUES ($1, 'sku', 'reserved', 'product', $2, $2)`,
            [businessA, p],
          ),
        ).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessA]);
        await expect(c.query(`UPDATE catalog_identifiers SET value_norm = 'moved' WHERE business_id = $1`, [businessA])).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessA]);
        await expect(c.query(`DELETE FROM catalog_identifiers WHERE business_id = $1`, [businessA])).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
        // …but a legitimate product write (through the trigger) still registers, and reads stay scoped.
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessA]);
        await c.query(
          `WITH p AS (INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, 'APP-WRITES', 1, 'JOD') RETURNING id, business_id)
           INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'en', 'x' FROM p`,
          [businessA],
        );
        const seen = await c.query(`SELECT value_norm FROM catalog_identifiers WHERE value_norm = 'app-writes'`);
        expect(seen.rows).toHaveLength(1);
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });

    it('lifecycle: product and variant identifiers appear on create, follow SKU changes, vanish on archive and on hard delete (cascade)', async () => {
      const p = await rawProduct(businessA, 'LIFE-P', '5000000000001');
      const v = await rawVariant(businessA, p, 'LIFE-V', '5000000000002');
      const rows = async () =>
        (
          await ownerPool().query<{ value_norm: string; owner_type: string; product_id: string | null; variant_id: string | null }>(
            `SELECT value_norm, owner_type, product_id, variant_id FROM catalog_identifiers WHERE business_id = $1 AND value_norm LIKE 'life-%' OR value_norm LIKE '50000000%' ORDER BY value_norm`,
            [businessA],
          )
        ).rows;
      expect(await rows()).toEqual([
        { value_norm: '5000000000001', owner_type: 'product', product_id: p, variant_id: null },
        { value_norm: '5000000000002', owner_type: 'variant', product_id: null, variant_id: v },
        { value_norm: 'life-p', owner_type: 'product', product_id: p, variant_id: null },
        { value_norm: 'life-v', owner_type: 'variant', product_id: null, variant_id: v },
      ]);
      // SKU change moves the registration.
      await ownerPool().query(`UPDATE product_variants SET sku = 'LIFE-V2' WHERE id = $1`, [v]);
      expect((await rows()).map((r) => r.value_norm)).toEqual(['5000000000001', '5000000000002', 'life-p', 'life-v2']);
      // Archiving the variant releases its identifiers; the product keeps its own.
      await ownerPool().query(`UPDATE product_variants SET status = 'archived' WHERE id = $1`, [v]);
      expect((await rows()).map((r) => r.value_norm)).toEqual(['5000000000001', 'life-p']);
      // Hard delete of the product (domain never does it, but the FK must not leave orphans).
      await ownerPool().query(`DELETE FROM product_variants WHERE id = $1`, [v]);
      await ownerPool()
        .query(`DELETE FROM product_translations WHERE product_id = $1`, [p])
        .catch(() => undefined);
      await ownerPool().query(`DELETE FROM products WHERE id = $1`, [p]);
      expect(await rows()).toEqual([]);
      const orphans = await ownerPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM catalog_identifiers ci
         WHERE (ci.owner_type = 'product' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.business_id = ci.business_id AND p.id = ci.product_id))
            OR (ci.owner_type = 'variant' AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.business_id = ci.business_id AND v.id = ci.variant_id))`,
      );
      expect(orphans.rows[0]?.n).toBe('0');
    });

    it('product SKU X + variant SKU X (same business) → rejected; the sync routine is not callable directly', async () => {
      const p = await rawProduct(businessA, 'SAME-X');
      await expect(rawVariant(businessA, p, 'same-x')).rejects.toThrow(/duplicate key/);
      const c = new Client({ connectionString: appDbUrl });
      await c.connect();
      try {
        await expect(c.query('SELECT catalog_identifiers_sync()')).rejects.toThrow(/permission denied|trigger functions can only be called as triggers/);
      } finally {
        await c.end();
      }
    });
  });
});
