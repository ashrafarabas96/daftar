import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { hasPermission } from '@daftar/domain-core';
import {
  PHASE3_PERMISSIONS,
  type InventoryAccessDto,
  type InventoryItemDto,
  type InventoryItemVariantDto,
  type InventoryStockPageDto,
  type InventoryStocktakeDetailDto,
  type InventoryStocktakeLineDto,
  type InventoryStocktakeSummaryDto,
  type InventoryUnitDto,
  type InventoryWarehouseDto,
  type LocaleCode,
  type Page,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { inventoryRefusal } from './inventory-errors';
import { assertWarehouseReachable, likeEscaped, quantityText, reachableWarehouses, requireAnyPermission } from './read-scope';

/**
 * The inventory READS of P3-S7 (PHASE_3_S7_CONTRACT A-05 … A-08): access,
 * warehouses, items, units, live stock and stocktakes.
 *
 * Every read is one statement through `daftar_app` under row level security
 * (`db.scoped`, tenant and business), at READ COMMITTED: it sees what was
 * committed when it started, and nothing is cached anywhere — no module
 * state, no memo, no stored copy (A-03). Stock is read from `stock_levels`,
 * the one named cache the lock tolerates (L:1256-1263), and nothing is
 * derived from it but the quantity itself: no value, no average, no sequence.
 *
 * The hidden base variant never leaves the server (P3-AL-52): its rows read
 * as `variantId: null`, and a cursor never carries its id.
 */

const DEFAULT_LIMIT = 20;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── Queries ──────────────────────────────────────────────────────────────

const uuid = z.string().regex(CANONICAL_UUID, 'a canonical lowercase uuid');
/** `limit` 1..50 as query text (the S7 routes' cap). */
const limit = z
  .string()
  .regex(/^\d{1,2}$/, 'a limit is 1..50')
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int().min(1).max(50));
const search = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(100));
const flag = z.enum(['true', 'false']).transform((s) => s === 'true');
/** `ids=a,b,c` (or the parameter repeated): 1..200 distinct canonical product ids. */
const idList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s, i, all) => all.indexOf(s) === i),
  )
  .pipe(z.array(uuid).min(1).max(200));

export const InventoryItemsQuerySchema = z
  .object({
    search: search.optional(),
    ids: idList.optional(),
    trackedOnly: flag.optional(),
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict()
  .refine((q) => q.ids === undefined || q.search === undefined, { message: 'ids and search are mutually exclusive', path: ['ids'] });

/** A stock cursor: the row's product, and its merchant variant when it has one. Never the base variant. */
const stockCursor = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/, 'a stock cursor');

export const InventoryStockQuerySchema = z
  .object({
    warehouseId: uuid,
    search: search.optional(),
    status: z.enum(['in_stock', 'out_of_stock', 'negative']).optional(),
    cursor: stockCursor.optional(),
    limit: limit.optional(),
  })
  .strict();

export const InventoryStocktakesQuerySchema = z
  .object({
    warehouseId: uuid.optional(),
    status: z.enum(['draft', 'finalized', 'cancelled']).optional(),
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict();

export type InventoryItemsQuery = z.infer<typeof InventoryItemsQuerySchema>;
export type InventoryStockQuery = z.infer<typeof InventoryStockQuerySchema>;
export type InventoryStocktakesQuery = z.infer<typeof InventoryStocktakesQuerySchema>;

// ── Name resolution (the Phase 1 rule, `catalog.service.ts`) ─────────────

/** A product's name in `locale`, then `ar`, then any (by locale order), over `product_translations`. */
export function productNameSql(alias: string, locale: string): string {
  return `coalesce((SELECT t.name FROM product_translations t
                     WHERE t.business_id = ${alias}.business_id AND t.product_id = ${alias}.id
                     ORDER BY (t.locale = ${locale}) DESC, (t.locale = 'ar') DESC, t.locale LIMIT 1), '')`;
}

/** A merchant variant's display name: its attribute values by key, joined " / ", else its SKU, else its barcode. */
export function variantNameSql(alias: string): string {
  return `coalesce(nullif((SELECT string_agg(e.value, ' / ' ORDER BY e.key) FROM jsonb_each_text(${alias}.attributes) e), ''),
                   ${alias}.sku, ${alias}.barcode, '')`;
}

// ── Rows ─────────────────────────────────────────────────────────────────

interface ItemRow {
  id: string;
  status: 'active' | 'archived';
  track_inventory: boolean;
  unit_code: string | null;
  unit_decimals: number | null;
  name: string;
  holds_stock: boolean;
  variants: InventoryItemVariantDto[];
}

interface StockRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  unit_code: string;
  unit_decimals: number;
  on_hand: string;
}

interface StocktakeRow {
  id: string;
  warehouse_id: string;
  status: 'draft' | 'finalized' | 'cancelled';
  created_at: Date;
  closed_at: Date | null;
  line_count: number;
}

const STOCKTAKE_SELECT = `SELECT st.id, st.warehouse_id, st.status, st.created_at, coalesce(st.finalized_at, st.cancelled_at) AS closed_at,
            (SELECT count(*) FROM stocktake_lines l WHERE l.business_id = st.business_id AND l.stocktake_id = st.id)::int AS line_count
       FROM stocktakes st`;

function stocktakeSummary(r: StocktakeRow): InventoryStocktakeSummaryDto {
  return {
    stocktakeId: r.id,
    warehouseId: r.warehouse_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    closedAt: r.closed_at === null ? null : r.closed_at.toISOString(),
    lineCount: r.line_count,
  };
}

/**
 * `GET /v1/inventory/{access,warehouses,items,units,stock,stocktakes…}`. The
 * route guard has already required membership; each read re-checks its own
 * permission and applies its scope rule (A-04):
 *
 * - access and units: any member;
 * - warehouses, stock, stocktakes: `warehouse` scope — an unreachable row is
 *   absent, and a named unreachable warehouse is refused;
 * - items: `master` (business-wide catalogue data).
 */
@Injectable()
export class InventoryReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async rows<T extends QueryResultRow>(m: MembershipContext, text: string, params: unknown[]): Promise<T[]> {
    return (await this.db.scoped<T>({ tenantId: m.tenantId, businessId: m.businessId }, text, params)).rows;
  }

  /** The caller's own Phase 3 grants and scope (A-05). Advisory: every command still enforces its own authority. */
  access(m: MembershipContext): InventoryAccessDto {
    return { businessWide: m.branchScopeMode === 'all', permissions: PHASE3_PERMISSIONS.filter((p) => hasPermission(m.roles, p)) };
  }

  /** The warehouses the caller reaches (P3-AL-15), each with the branches it serves, by name. */
  async warehouses(m: MembershipContext): Promise<{ items: InventoryWarehouseDto[] }> {
    requireAnyPermission(m, ['warehouse.view', 'inventory.view', 'purchases.view']);
    const reachable = await reachableWarehouses(this.db, m);
    const found = await this.rows<{ id: string; name: string; status: 'active' | 'archived'; branch_id: string; branch_ids: string[] }>(
      m,
      `SELECT w.id, w.name, w.status, w.branch_id,
              ARRAY(SELECT bw.branch_id FROM branch_warehouses bw
                     WHERE bw.business_id = w.business_id AND bw.warehouse_id = w.id ORDER BY bw.branch_id)::text[] AS branch_ids
         FROM warehouses w
        WHERE w.business_id = $1 AND ($2::uuid[] IS NULL OR w.id = ANY($2::uuid[]))
        ORDER BY w.name, w.id`,
      [m.businessId, reachable === null ? null : [...reachable]],
    );
    return {
      items: found.map((w) => ({ warehouseId: w.id, name: w.name, status: w.status, homeBranchId: w.branch_id, branchIds: w.branch_ids })),
    };
  }

  /**
   * Products with their inventory configuration and merchant variants (A-06).
   * `ids` resolves names of any product of the business, archived and
   * untracked included, and refuses an unknown id; otherwise active products
   * only, keyset-paged on (resolved name, id).
   */
  async items(m: MembershipContext, q: InventoryItemsQuery, locale: LocaleCode): Promise<Page<InventoryItemDto>> {
    requireAnyPermission(m, ['inventory.view', 'purchases.view', 'purchases.manage', 'inventory.adjust']);
    const ids = q.ids ?? null;
    const size = ids === null ? (q.limit ?? DEFAULT_LIMIT) : ids.length;
    const trackedOnly = q.trackedOnly ?? ids === null;
    const found = await this.rows<ItemRow>(
      m,
      `WITH item AS (
         SELECT p.business_id, p.id, p.status, p.track_inventory, p.unit_code, p.unit_decimals, p.sku, p.barcode,
                ${productNameSql('p', '$2::text')} AS name
           FROM products p
          WHERE p.business_id = $1
            AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))
            AND ($3::uuid[] IS NOT NULL OR p.status = 'active')
            AND (NOT $4::boolean OR p.track_inventory)
       ), page AS (
         SELECT i.* FROM item i
          WHERE ($5::text IS NULL
                 OR i.name ILIKE '%' || $5 || '%' ESCAPE '\\'
                 OR lower(i.sku) = lower($6::text) OR i.barcode = $6::text
                 OR EXISTS (SELECT 1 FROM product_variants v
                             WHERE v.business_id = i.business_id AND v.product_id = i.id AND NOT v.is_base
                               AND (lower(v.sku) = lower($6::text) OR v.barcode = $6::text)))
            AND ($7::uuid IS NULL
                 OR (i.name, i.id) > (SELECT ${productNameSql('c', '$2::text')}, c.id FROM products c WHERE c.business_id = $1 AND c.id = $7::uuid))
          ORDER BY i.name, i.id
          LIMIT $8
       )
       SELECT pg.id, pg.status, pg.track_inventory, pg.unit_code, pg.unit_decimals, pg.name,
              (EXISTS (SELECT 1 FROM stock_levels s
                         JOIN product_variants v ON v.business_id = s.business_id AND v.id = s.variant_id
                        WHERE s.business_id = pg.business_id AND v.product_id = pg.id AND s.on_hand <> 0)
               OR EXISTS (SELECT 1 FROM stock_movements mv
                            JOIN product_variants v ON v.business_id = mv.business_id AND v.id = mv.variant_id
                           WHERE mv.business_id = pg.business_id AND v.product_id = pg.id
                           GROUP BY mv.warehouse_id, mv.variant_id
                          HAVING sum(mv.qty_delta) <> 0)) AS holds_stock,
              coalesce((SELECT json_agg(json_build_object('variantId', v.id, 'name', ${variantNameSql('v')}, 'status', v.status)
                                        ORDER BY v.created_at, v.id)
                          FROM product_variants v
                         WHERE v.business_id = pg.business_id AND v.product_id = pg.id AND NOT v.is_base), '[]'::json) AS variants
         FROM page pg
        ORDER BY pg.name, pg.id`,
      [
        m.businessId,
        locale,
        ids,
        trackedOnly,
        q.search === undefined ? null : likeEscaped(q.search),
        q.search ?? null,
        ids === null ? (q.cursor ?? null) : null,
        size + 1,
      ],
    );
    if (ids !== null && found.length !== ids.length) throw inventoryRefusal('inventory.product_not_found');
    const items = found.slice(0, size);
    const last = items.at(-1);
    return {
      items: items.map((r) => ({
        productId: r.id,
        name: r.name,
        status: r.status,
        trackInventory: r.track_inventory,
        unitCode: r.unit_code,
        unitDecimals: r.unit_decimals,
        holdsStock: r.holds_stock,
        variants: r.variants,
      })),
      nextCursor: found.length > size && last !== undefined ? last.id : null,
    };
  }

  /** The unit registry with resolved names, in registry order (A-06). Any member. */
  async units(m: MembershipContext, locale: LocaleCode): Promise<{ items: InventoryUnitDto[] }> {
    const found = await this.rows<{ unit_code: string; default_decimals: number; name: string }>(
      m,
      `SELECT u.unit_code, u.default_decimals,
              coalesce((SELECT n.display_name FROM unit_names n WHERE n.unit_code = u.unit_code
                         ORDER BY (n.locale = $1::text) DESC, (n.locale = 'ar') DESC, n.locale LIMIT 1), u.unit_code) AS name
         FROM units u
        ORDER BY u.sort_order`,
      [locale],
    );
    return { items: found.map((u) => ({ unitCode: u.unit_code, name: u.name, defaultDecimals: u.default_decimals })) };
  }

  /**
   * The live stock of one warehouse (A-07): every tracked, active product
   * LEFT JOINed to `stock_levels` — a key without a row reads zero. A simple
   * product is one `variantId: null` row; a product with merchant variants
   * is one row per merchant variant (an archived one only while it holds
   * stock), plus its base-variant row only while that is non-zero.
   * Keyset-paged on (name, product, base first, variant).
   */
  async stock(m: MembershipContext, q: InventoryStockQuery, locale: LocaleCode): Promise<InventoryStockPageDto> {
    requireAnyPermission(m, ['inventory.view']);
    await this.assertWarehouse(m, q.warehouseId);
    const size = q.limit ?? DEFAULT_LIMIT;
    const [cursorProduct, cursorVariant] = q.cursor === undefined ? [null, null] : q.cursor.split(':');
    const found = await this.rows<StockRow>(
      m,
      `WITH prod AS (
         SELECT p.business_id, p.id, p.unit_code, p.unit_decimals, p.sku, p.barcode, ${productNameSql('p', '$3::text')} AS name
           FROM products p
          WHERE p.business_id = $1 AND p.track_inventory AND p.status = 'active'
       ), stock AS (
         SELECT pr.id AS product_id, pr.name, pr.unit_code, pr.unit_decimals, pr.sku AS product_sku, pr.barcode AS product_barcode,
                v.id AS variant_id, v.is_base, v.sku, v.barcode,
                CASE WHEN v.is_base THEN NULL ELSE ${variantNameSql('v')} END AS variant_name,
                coalesce(s.on_hand, 0) AS on_hand,
                CASE WHEN v.is_base THEN 0 ELSE 1 END AS ord,
                CASE WHEN v.is_base THEN '${NIL_UUID}'::uuid ELSE v.id END AS vkey
           FROM prod pr
           JOIN product_variants v ON v.business_id = pr.business_id AND v.product_id = pr.id
           LEFT JOIN stock_levels s ON s.business_id = pr.business_id AND s.warehouse_id = $2::uuid AND s.variant_id = v.id
          WHERE CASE WHEN v.is_base
                     THEN coalesce(s.on_hand, 0) <> 0
                          OR NOT EXISTS (SELECT 1 FROM product_variants mv
                                          WHERE mv.business_id = pr.business_id AND mv.product_id = pr.id AND NOT mv.is_base AND mv.status = 'active')
                     ELSE v.status = 'active' OR coalesce(s.on_hand, 0) <> 0 END
       )
       SELECT st.product_id, CASE WHEN st.is_base THEN NULL ELSE st.variant_id END AS variant_id, st.name, st.variant_name,
              st.unit_code, st.unit_decimals, st.on_hand::text AS on_hand
         FROM stock st
        WHERE ($4::text IS NULL
               OR st.name ILIKE '%' || $4 || '%' ESCAPE '\\'
               OR lower(st.product_sku) = lower($5::text) OR st.product_barcode = $5::text
               OR (NOT st.is_base AND (lower(st.sku) = lower($5::text) OR st.barcode = $5::text)))
          AND ($6::text IS NULL
               OR ($6 = 'in_stock' AND st.on_hand > 0)
               OR ($6 = 'out_of_stock' AND st.on_hand = 0)
               OR ($6 = 'negative' AND st.on_hand < 0))
          AND ($7::uuid IS NULL
               OR (st.name, st.product_id, st.ord, st.vkey)
                  > (SELECT ${productNameSql('c', '$3::text')}, c.id,
                            CASE WHEN $8::uuid IS NULL THEN 0 ELSE 1 END, coalesce($8::uuid, '${NIL_UUID}'::uuid)
                       FROM products c WHERE c.business_id = $1 AND c.id = $7::uuid))
        ORDER BY st.name, st.product_id, st.ord, st.vkey
        LIMIT $9`,
      [
        m.businessId,
        q.warehouseId,
        locale,
        q.search === undefined ? null : likeEscaped(q.search),
        q.search ?? null,
        q.status ?? null,
        cursorProduct ?? null,
        cursorVariant ?? null,
        size + 1,
      ],
    );
    const items = found.slice(0, size);
    const last = items.at(-1);
    return {
      items: items.map((r) => ({
        productId: r.product_id,
        variantId: r.variant_id,
        name: r.name,
        variantName: r.variant_name,
        unitCode: r.unit_code,
        unitDecimals: r.unit_decimals,
        onHand: quantityText(r.on_hand, r.unit_decimals),
      })),
      nextCursor: found.length > size && last !== undefined ? (last.variant_id === null ? last.product_id : `${last.product_id}:${last.variant_id}`) : null,
    };
  }

  /** Stocktakes of reachable warehouses, newest first (A-08). */
  async stocktakes(m: MembershipContext, q: InventoryStocktakesQuery): Promise<Page<InventoryStocktakeSummaryDto>> {
    requireAnyPermission(m, ['inventory.view', 'inventory.stocktake']);
    const reachable = await reachableWarehouses(this.db, m);
    if (q.warehouseId !== undefined) assertWarehouseReachable(reachable, q.warehouseId);
    const size = q.limit ?? DEFAULT_LIMIT;
    const found = await this.rows<StocktakeRow>(
      m,
      `${STOCKTAKE_SELECT}
        WHERE st.business_id = $1
          AND ($2::uuid IS NULL OR st.warehouse_id = $2::uuid)
          AND ($3::uuid[] IS NULL OR st.warehouse_id = ANY($3::uuid[]))
          AND ($4::text IS NULL OR st.status = $4::text)
          AND ($5::uuid IS NULL OR (st.created_at, st.id) < (SELECT c.created_at, c.id FROM stocktakes c WHERE c.business_id = $1 AND c.id = $5::uuid))
        ORDER BY st.created_at DESC, st.id DESC
        LIMIT $6`,
      [m.businessId, q.warehouseId ?? null, reachable === null ? null : [...reachable], q.status ?? null, q.cursor ?? null, size + 1],
    );
    const items = found.slice(0, size);
    const last = items.at(-1);
    return { items: items.map(stocktakeSummary), nextCursor: found.length > size && last !== undefined ? last.id : null };
  }

  /**
   * One stocktake with its lines and names (A-08). An unknown or unreachable
   * stocktake is `inventory.stocktake_not_found`. Until it is finalized, the
   * expected and variance quantities are withheld unless the caller holds
   * `inventory.adjust` (blind count, TL-8). R-S7-1: "until finalized"
   * includes a CANCELLED stocktake — a counter who could cancel a draft and
   * read it back would otherwise see what the draft withheld.
   */
  async stocktake(m: MembershipContext, stocktakeId: string, locale: LocaleCode): Promise<InventoryStocktakeDetailDto> {
    requireAnyPermission(m, ['inventory.view', 'inventory.stocktake']);
    const [header] = await this.rows<StocktakeRow>(m, `${STOCKTAKE_SELECT} WHERE st.business_id = $1 AND st.id = $2`, [m.businessId, stocktakeId]);
    const reachable = header === undefined ? null : await reachableWarehouses(this.db, m);
    if (header === undefined || (reachable !== null && !reachable.has(header.warehouse_id))) throw inventoryRefusal('inventory.stocktake_not_found');
    const blind = header.status !== 'finalized' && !hasPermission(m.roles, 'inventory.adjust');
    const lines = await this.rows<{
      id: string;
      product_id: string;
      variant_id: string;
      is_base: boolean;
      name: string;
      variant_name: string | null;
      unit_code: string | null;
      unit_decimals: number | null;
      counted_qty: string;
      expected_qty: string;
      variance_qty: string;
    }>(
      m,
      `SELECT l.id, v.product_id, v.id AS variant_id, v.is_base, ${productNameSql('p', '$3::text')} AS name,
              CASE WHEN v.is_base THEN NULL ELSE ${variantNameSql('v')} END AS variant_name,
              p.unit_code, p.unit_decimals, l.counted_qty::text AS counted_qty,
              l.expected_qty_at_capture::text AS expected_qty, l.variance_qty::text AS variance_qty
         FROM stocktake_lines l
         JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
         JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
        WHERE l.business_id = $1 AND l.stocktake_id = $2
        ORDER BY 5, v.product_id, v.is_base DESC, v.id`,
      [m.businessId, stocktakeId, locale],
    );
    return {
      ...stocktakeSummary(header),
      lines: lines.map((l): InventoryStocktakeLineDto => {
        const decimals = l.unit_decimals ?? 0;
        return {
          lineId: l.id,
          productId: l.product_id,
          variantId: l.is_base ? null : l.variant_id,
          name: l.name,
          variantName: l.variant_name,
          unitCode: l.unit_code,
          unitDecimals: decimals,
          countedQty: quantityText(l.counted_qty, decimals),
          expectedQty: blind ? null : quantityText(l.expected_qty, decimals),
          varianceQty: blind ? null : quantityText(l.variance_qty, decimals),
        };
      }),
    };
  }

  /**
   * A warehouse a read names: unreachable for an assigned-scope member is
   * `inventory.warehouse_out_of_scope` (existence is not disclosed); unknown
   * to a business-wide member is `inventory.warehouse_not_found`.
   */
  private async assertWarehouse(m: MembershipContext, warehouseId: string): Promise<void> {
    const reachable = await reachableWarehouses(this.db, m);
    assertWarehouseReachable(reachable, warehouseId);
    const [found] = await this.rows<{ id: string }>(m, 'SELECT id FROM warehouses WHERE business_id = $1 AND id = $2', [m.businessId, warehouseId]);
    if (found === undefined) throw inventoryRefusal('inventory.warehouse_not_found');
  }
}
