import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import type { CategoryDto, LocaleCode, Page, ProductDto, ProductListItemDto, VariantDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AuditService, OutboxService, newId } from '../audit/audit.service';
import { EntitlementService } from '../entitlements/entitlements.service';
import { parsePagination, toPage } from '../../common/validation';
import type { MembershipContext } from '../tenancy/tenancy.service';
import type { z } from 'zod';
import type { CategoryCreateSchema, ProductCreateSchema, ProductUpdateSchema } from './catalog.schemas';

/**
 * Catalog (§56–58): industry-neutral. No stock quantity fields, no COGS, no
 * dependency on Accounting/Ledger/Sales/Payments/Inventory (architecture guard
 * enforced by static CI checks §114). SKU/barcode uniqueness scope = business.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
  ) {}

  private scope(m: MembershipContext): { tenantId: string; businessId: string } {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  async listCategories(m: MembershipContext): Promise<CategoryDto[]> {
    const rows = (
      await this.db.scoped<{ id: string; parent_id: string | null; translations: Record<string, string> }>(
        this.scope(m),
        `SELECT id, parent_id, translations FROM categories
         WHERE business_id = $1 AND status = 'active' ORDER BY created_at`,
        [m.businessId],
      )
    ).rows;
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, translations: r.translations }));
  }

  async createCategory(m: MembershipContext, input: z.infer<typeof CategoryCreateSchema>): Promise<CategoryDto> {
    const id = newId();
    try {
      await this.db.withTransaction(this.scope(m), async (c) => {
        await c.query('INSERT INTO categories (business_id, id, parent_id, translations) VALUES ($1, $2, $3, $4)', [
          m.businessId,
          id,
          input.parentId ?? null,
          JSON.stringify(input.translations),
        ]);
        await this.audit.recordTx(c, { action: 'catalog.category_created', entity: 'category', entityId: id });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw AppError.validation({ parentId: ['category_not_in_business'] });
      throw e;
    }
    return { id, parentId: input.parentId ?? null, translations: input.translations };
  }

  /** Cursor-paginated product list (§96): stable ordering, max page size, no unbounded queries. */
  async listProducts(m: MembershipContext, query: Record<string, unknown>, locale: LocaleCode): Promise<Page<ProductListItemDto>> {
    let pagination;
    try {
      pagination = parsePagination(query);
    } catch {
      throw AppError.validation({ limit: ['must_be_1_to_100'] });
    }
    const search = typeof query.search === 'string' && query.search.trim().length > 0 ? query.search.trim() : null;

    const rows = (
      await this.db.scoped<{
        id: string;
        translations: Record<string, string>;
        sku: string | null;
        base_price_minor: string;
        price_currency: string;
        status: string;
        created_at: Date;
      }>(
        this.scope(m),
        `SELECT p.id, p.translations, p.sku, p.base_price_minor::text, p.price_currency, p.status, p.created_at
         FROM products p
         WHERE p.business_id = $1 AND p.status <> 'archived'
           AND ($2::text IS NULL OR
                p.translations::text ILIKE '%' || $2 || '%' OR
                p.sku ILIKE '%' || $2 || '%' OR
                p.barcode ILIKE '%' || $2 || '%' OR
                EXISTS (SELECT 1 FROM product_variants v
                        WHERE v.business_id = p.business_id AND v.product_id = p.id
                          AND (v.sku ILIKE '%' || $2 || '%' OR v.barcode ILIKE '%' || $2 || '%')))
           AND ($3::text IS NULL OR (p.created_at, p.id) < (SELECT created_at, id FROM products WHERE business_id = $1 AND id = $3::uuid))
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT $4`,
        [m.businessId, search, pagination.cursor ?? null, pagination.limit + 1],
      )
    ).rows;

    const page = toPage(rows, pagination.limit, (r) => r.id);
    return {
      items: page.items.map((r) => ({
        id: r.id,
        name: r.translations[locale] ?? r.translations['ar'] ?? Object.values(r.translations)[0] ?? '',
        sku: r.sku,
        basePriceMinor: r.base_price_minor,
        priceCurrency: r.price_currency,
        status: r.status as 'active' | 'archived',
      })),
      nextCursor: page.nextCursor,
    };
  }

  async getProduct(m: MembershipContext, id: string, locale: LocaleCode): Promise<ProductDto> {
    const p = (
      await this.db.scoped<{
        id: string;
        category_id: string | null;
        translations: Record<string, string>;
        sku: string | null;
        barcode: string | null;
        unit: string | null;
        base_price_minor: string;
        price_currency: string;
        version: number;
        status: string;
      }>(
        this.scope(m),
        `SELECT id, category_id, translations, sku, barcode, unit, base_price_minor::text, price_currency, version, status
         FROM products WHERE business_id = $1 AND id = $2`,
        [m.businessId, id],
      )
    ).rows[0];
    if (!p) throw AppError.notFound('Product not found');

    const variants = (
      await this.db.scoped<{ id: string; attributes: Record<string, string>; sku: string | null; barcode: string | null; price_minor: string | null }>(
        this.scope(m),
        `SELECT id, attributes, sku, barcode, price_minor::text
         FROM product_variants WHERE business_id = $1 AND product_id = $2 AND status <> 'archived' ORDER BY created_at`,
        [m.businessId, id],
      )
    ).rows;
    const media = (
      await this.db.scoped<{ id: string; storage_key: string; variants: { size: number; storage_key: string; width: number; height: number }[] }>(
        this.scope(m),
        `SELECT md.id, md.storage_key, md.variants
         FROM product_media pm JOIN media md ON md.business_id = pm.business_id AND md.id = pm.media_id
         WHERE pm.business_id = $1 AND pm.product_id = $2 ORDER BY pm.position`,
        [m.businessId, id],
      )
    ).rows;

    return {
      id: p.id,
      name: p.translations[locale] ?? p.translations['ar'] ?? Object.values(p.translations)[0] ?? '',
      translations: p.translations,
      sku: p.sku,
      barcode: p.barcode,
      unit: p.unit,
      categoryId: p.category_id,
      basePriceMinor: p.base_price_minor,
      priceCurrency: p.price_currency,
      version: p.version,
      status: p.status as 'active' | 'archived',
      variants: variants.map(
        (v): VariantDto => ({
          id: v.id,
          attributes: v.attributes,
          sku: v.sku,
          barcode: v.barcode,
          priceMinor: v.price_minor,
        }),
      ),
      media: media.map((md) => ({
        id: md.id,
        url: `/media/${md.storage_key}`,
        variants: md.variants.map((vv) => ({ size: vv.size, url: `/media/${vv.storage_key}`, width: vv.width, height: vv.height })),
      })),
    };
  }

  /**
   * Create product (§57). SKU/barcode uniqueness is DB-arbitrated per business
   * (partial unique indexes); an advisory xact lock serializes the pre-check
   * so concurrent creates fail clean with 409 instead of racing the index.
   */
  async createProduct(m: MembershipContext, input: z.infer<typeof ProductCreateSchema>): Promise<{ id: string }> {
    const id = newId();
    // Payload-internal duplicates (same SKU twice in one payload) rejected before touching the DB.
    const skus = [input.sku, ...(input.variants ?? []).map((v) => v.sku)].filter((s): s is string => typeof s === 'string');
    const barcodes = [input.barcode, ...(input.variants ?? []).map((v) => v.barcode)].filter((s): s is string => typeof s === 'string');
    if (new Set(skus.map((s) => s.toLowerCase())).size !== skus.length) throw AppError.conflict('CONFLICT', 'Duplicate SKU in payload');
    if (new Set(barcodes).size !== barcodes.length) throw AppError.conflict('CONFLICT', 'Duplicate barcode in payload');

    try {
      await this.db.withTransaction(this.scope(m), async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [m.businessId]);
        await this.entitlements.assertCanConsume(c, m.businessId, 'MAX_PRODUCTS');
        const clash = await this.uniquenessClash(c, m.businessId, skus, barcodes, null);
        if (clash) throw AppError.conflict('CONFLICT', `${clash} already exists in this business`);

        // §36–37: price currency = the BUSINESS BASE CURRENCY, always. A
        // client-sent currency that disagrees is rejected (400) — the server
        // never trusts the client for money context.
        const { rows: biz } = await c.query<{ base_currency: string }>('SELECT base_currency FROM businesses WHERE id = $1', [m.businessId]);
        const baseCurrency = biz[0]?.base_currency;
        if (!baseCurrency) throw AppError.notFound('Business not found');
        if (input.priceCurrency && input.priceCurrency !== baseCurrency) {
          throw AppError.validation({
            priceCurrency: [`must equal the business base currency (${baseCurrency})`],
          });
        }

        await c.query(
          `INSERT INTO products (business_id, id, category_id, translations, sku, barcode, base_price_minor, price_currency, unit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            m.businessId,
            id,
            input.categoryId ?? null,
            JSON.stringify(input.translations),
            input.sku ?? null,
            input.barcode ?? null,
            input.basePriceMinor.toString(),
            baseCurrency,
            input.unit ?? null,
          ],
        );
        for (const v of input.variants ?? []) {
          await c.query(
            `INSERT INTO product_variants (business_id, id, product_id, attributes, sku, barcode, price_minor)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [m.businessId, newId(), id, JSON.stringify(v.attributes), v.sku ?? null, v.barcode ?? null, v.priceMinor?.toString() ?? null],
          );
        }
        await this.outbox.emitTx(c, {
          type: 'catalog.product_created',
          tenantId: m.tenantId,
          businessId: m.businessId,
          payload: { productId: id },
        });
        await this.audit.recordTx(c, { action: 'catalog.product_created', entity: 'product', entityId: id });
      });
    } catch (e) {
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23503') throw AppError.validation({ categoryId: ['category_not_in_business'] });
      if (pg.code === '23505') throw AppError.conflict('CONFLICT', 'SKU or barcode already exists in this business');
      throw e;
    }
    return { id };
  }

  /**
   * Update product (§98 optimistic concurrency): when the client sends
   * `version`, a mismatch fails with 409 — a stale request never silently
   * overwrites a newer edit. Row lock (FOR UPDATE) serializes the write.
   */
  async updateProduct(m: MembershipContext, id: string, input: z.infer<typeof ProductUpdateSchema>): Promise<void> {
    await this.db.withTransaction(this.scope(m), async (c) => {
      const current = (
        await c.query<{ version: number; status: string; sku: string | null; barcode: string | null; price_currency: string }>(
          'SELECT version, status, sku, barcode, price_currency FROM products WHERE business_id = $1 AND id = $2 FOR UPDATE',
          [m.businessId, id],
        )
      ).rows[0];
      if (!current) throw AppError.notFound('Product not found');
      if (current.status === 'archived') throw AppError.conflict('CONFLICT', 'Archived products cannot be edited');
      if (input.version !== undefined && input.version !== current.version) {
        throw AppError.conflict('CONFLICT', 'Product was edited by someone else — refresh and retry', {
          currentVersion: current.version,
        });
      }
      const nextSku = input.sku === undefined ? current.sku : input.sku;
      const nextBarcode = input.barcode === undefined ? current.barcode : input.barcode;
      const clash = await this.uniquenessClash(c, m.businessId, nextSku ? [nextSku] : [], nextBarcode ? [nextBarcode] : [], id);
      if (clash) throw AppError.conflict('CONFLICT', `${clash} already exists in this business`);

      // §37: price currency is immutable business context — an update may
      // never move a product to a currency ≠ business.base_currency.
      if (input.priceCurrency !== undefined && input.priceCurrency !== current.price_currency) {
        throw AppError.validation({ priceCurrency: ['is fixed to the business base currency'] });
      }

      await c.query(
        `UPDATE products SET
           translations = coalesce($3, translations),
           base_price_minor = coalesce($4, base_price_minor),
           price_currency = coalesce($5, price_currency),
           category_id = CASE WHEN $6 THEN $7 ELSE category_id END,
           sku = CASE WHEN $8 THEN $9 ELSE sku END,
           barcode = CASE WHEN $10 THEN $11 ELSE barcode END,
           unit = CASE WHEN $12 THEN $13 ELSE unit END,
           version = version + 1,
           updated_at = now()
         WHERE business_id = $1 AND id = $2`,
        [
          m.businessId,
          id,
          input.translations ? JSON.stringify(input.translations) : null,
          input.basePriceMinor?.toString() ?? null,
          input.priceCurrency ?? null,
          input.categoryId !== undefined,
          input.categoryId ?? null,
          input.sku !== undefined,
          nextSku,
          input.barcode !== undefined,
          nextBarcode,
          input.unit !== undefined,
          input.unit ?? null,
        ],
      );
      await this.audit.recordTx(c, {
        action: 'catalog.product_updated',
        entity: 'product',
        entityId: id,
        metadata: { fromVersion: current.version },
      });
    });
  }

  async archiveProduct(m: MembershipContext, id: string): Promise<void> {
    await this.db.withTransaction(this.scope(m), async (c) => {
      const r = await c.query(
        `UPDATE products SET status = 'archived', updated_at = now()
         WHERE business_id = $1 AND id = $2 AND status <> 'archived'`,
        [m.businessId, id],
      );
      if (r.rowCount !== 1) throw AppError.notFound('Product not found');
      await this.audit.recordTx(c, { action: 'catalog.product_archived', entity: 'product', entityId: id });
    });
  }

  /** Cross-table SKU/barcode clash check within the business scope. */
  private async uniquenessClash(
    c: import('pg').PoolClient,
    businessId: string,
    skus: string[],
    barcodes: string[],
    excludeProductId: string | null,
  ): Promise<string | null> {
    if (skus.length > 0) {
      const r = await c.query(
        `SELECT 'SKU' AS what FROM products
           WHERE business_id = $1 AND status <> 'archived' AND lower(sku) = ANY($2)
             AND ($3::uuid IS NULL OR id <> $3)
         UNION ALL
         SELECT 'SKU' FROM product_variants
           WHERE business_id = $1 AND status <> 'archived' AND lower(sku) = ANY($2)
         LIMIT 1`,
        [businessId, skus.map((s) => s.toLowerCase()), excludeProductId],
      );
      if ((r.rowCount ?? 0) > 0) return 'SKU';
    }
    if (barcodes.length > 0) {
      const r = await c.query(
        `SELECT 'barcode' AS what FROM products
           WHERE business_id = $1 AND status <> 'archived' AND barcode = ANY($2)
             AND ($3::uuid IS NULL OR id <> $3)
         UNION ALL
         SELECT 'barcode' FROM product_variants
           WHERE business_id = $1 AND status <> 'archived' AND barcode = ANY($2)
         LIMIT 1`,
        [businessId, barcodes, excludeProductId],
      );
      if ((r.rowCount ?? 0) > 0) return 'barcode';
    }
    return null;
  }
}
