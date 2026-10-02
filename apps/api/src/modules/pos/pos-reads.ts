import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import type { LocaleCode, PosMatchKindDto, PosProductHitDto, PosProductSearchDto } from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { productNameSql, variantNameSql } from '../inventory/inventory-reads';
import { quantityText, reachableWarehouses, requireAnyPermission } from '../inventory/read-scope';
import { sellingRefusal } from '../selling/selling-errors';
import { POS_SEARCH_DEFAULT_LIMIT, type PosProductSearchQuery } from './pos-read.schemas';

/**
 * THE POS READ SURFACE — P4-S3. One read: the product type-ahead.
 *
 * This file is named `*-reads.ts` on purpose. `scripts/guards/read-surface.ts`
 * (G-6) matches `apps/api/src/modules/<context>/<name>-reads.ts`, so the POS
 * read is held, in CI, to the rules it should be held to without anyone having
 * to add `pos` to a list: no write of any kind, no `OFFSET`, no current
 * exchange-rate lookup, no `Number(` on a money or quantity value, no
 * persisted or materialized balance source, and no module-level result cache.
 * Naming the file anything else would have taken it off that surface.
 *
 * ── What the read is ────────────────────────────────────────────────────
 *
 * `GET /v1/pos/products?warehouseId=…&q=…` — the cashier types, or scans a
 * barcode, and gets the sellable units whose barcode, SKU or name STARTS WITH
 * what was typed, best first: barcode, then SKU, then name. P4-A measures
 * exactly this: "one 50-row page by name/SKU/barcode prefix, over HTTP",
 * p95 ≤ 150 ms.
 *
 * ── Why prefix and not substring ────────────────────────────────────────
 *
 * `inventory-reads.ts`'s stock page matches a substring (`name ILIKE '%x%'`),
 * which no btree index can serve: at the P4-AL-73 acceptance volume that is a
 * scan of every name in the business on every keystroke. A prefix is served by
 * five indexes that already exist, none of them added by this slice:
 *
 *   `product_translations_name_idx (business_id, lower(name))`      `0036:156`
 *   `products_sku_uq (business_id, lower(sku)) WHERE …`             `0005:33`
 *   `products_barcode_uq (business_id, barcode) WHERE …`            `0005:34`
 *   `variants_sku_uq (business_id, lower(sku)) WHERE …`             `0005:51`
 *   `variants_barcode_uq (business_id, barcode) WHERE …`            `0005:52`
 *
 * The four partial indexes are usable only by a query that repeats their
 * predicate, so each arm below carries `status <> 'archived'` and
 * `… IS NOT NULL` — not as belt and braces but because dropping either makes
 * the index unusable and the arm a sequential scan.
 *
 * ── `^@` and not `LIKE`, and the RLS fact that decided it ───────────────
 *
 * The arms use `x ^@ $n` (`starts_with`) rather than `x LIKE $n || '%'`, and
 * that is a MEASURED choice, not a stylistic one. Measured on this estate's
 * cluster (PostgreSQL 18.4, `datcollate = C`), the same statement as the two
 * principals that matter:
 *
 *   | predicate                      | as the owner | as `daftar_app` |
 *   |--------------------------------|--------------|-----------------|
 *   | `barcode LIKE $p \|\| '%'`     | index RANGE  | **no range**    |
 *   | `barcode ^@ $p`                | index RANGE  | **index RANGE** |
 *   | `lower(sku) ^@ $p`             | index RANGE  | **no range**    |
 *   | `lower(name) ^@ $p`            | index RANGE  | **no range**    |
 *
 * The owner bypasses row security; `daftar_app` does not. Under RLS these
 * relations carry a PERMISSIVE `tenant_membership` policy whose qual is a
 * SUBQUERY (`EXISTS (SELECT 1 FROM businesses …)`), which makes the scan a
 * security barrier — and a user qual may only be pushed below a security
 * barrier if it is LEAKPROOF. In `pg_proc` on this cluster: `uuid_eq` true,
 * `text_ge` true, `text_lt` true, `starts_with` true — and `textlike`
 * **false**, `like_escape` **false**, `lower` **false**.
 *
 * So: `LIKE` can never be an index condition here, which is why the barcode
 * arms use `^@` and get a real range on `products_barcode_uq` /
 * `variants_barcode_uq` — the scanner path, which is the one that matters most
 * at a till. And the SKU and NAME arms cannot be ranged by ANY predicate,
 * because the index expression is `lower(...)` and `lower` is not leakproof:
 * they reach their index for `business_id` and filter the prefix above the
 * barrier.
 *
 * `[[daftar-rls-policy-shape-is-a-cost]]`, measured rather than assumed. The
 * remedy is NOT another index — the five indexes are the right five. It is a
 * schema-level change (a normalized `*_norm` column with a plain btree, which
 * needs a `P4-AL-06` ruling on whether a normalized copy is stored derived
 * truth; or marking the comparison leakproof, which is a security decision).
 * Both are a migration, and a migration belongs to exactly one agent, so this
 * module MEASURES the fact and REPORTS it instead of acting on it.
 * `tests/performance/pos-s3-budgets.test.ts` holds both halves: the barcode
 * arms' range is a GATE, and the `lower` leakproofness fact is asserted by
 * name, so the day it changes the suite says the SKU and name arms can now be
 * ranged too.
 *
 * `^@` also removes the need to escape the prefix. A typed `%` or `_` — and a
 * scanner can send either — is a LITERAL character in a prefix; under `LIKE`
 * it is a wildcard that has to be escaped, and an escape that is ever
 * forgotten is a search that silently matches the wrong product.
 *
 * ── No page two, and why that is the design and not a gap ───────────────
 *
 * There is no cursor. `OFFSET` is forbidden (G-6) and right to forbid; a
 * keyset cursor would have to carry one position per arm, and would still
 * reorder under a catalogue edit between keystrokes. A type-ahead is narrowed
 * by typing, so the read answers the best `limit` matches and reports
 * `moreMatches: true` when it dropped any. Each arm is bounded by its own
 * `LIMIT`, so the final sort is over at most `5 × (limit + 1)` rows whatever
 * the business holds — the statement count and the sort width are both
 * independent of the row count, which is the P4-AL-72 plan property.
 *
 * ── What this read does NOT do ──────────────────────────────────────────
 *
 * It computes no line total, no discount and no tax. `unitPriceMinor` is the
 * catalogue's own figure, reported so the screen can show a price; every
 * figure that decides what the customer pays is recomputed server-side at
 * cart and sale time (P4-AL-18), and `OD-03` is OPEN so no tax is guessed
 * here or anywhere else in this slice. It stores nothing and caches nothing:
 * availability is read from `stock_levels` — the one named stock cache the
 * lock tolerates — at the moment it is asked for. An average-only cache of a
 * price or an availability figure would be a second truth that drifts, so if
 * this read ever needs caching that is a finding to report, not a thing to
 * build.
 *
 * ── Isolation ───────────────────────────────────────────────────────────
 *
 * Every statement runs through `db.scoped` as `daftar_app`, which sets
 * `app.tenant_id` and `app.business_id` transaction-locally and does NOT
 * bypass row security. `products`, `product_variants`, `product_translations`
 * (`0006:30-48`, `0036:134-151`) and `stock_levels` (`0059:313-335`) each
 * carry FORCE RLS with the two-policy layering: a PERMISSIVE
 * `tenant_membership` policy and a RESTRICTIVE `business_isolation` policy. So
 * a row of another business, or of another tenant's business, is not filtered
 * out by the predicates below — it is not visible to the connection at all.
 * The `business_id = $1` predicates are there to reach the indexes, never to
 * do the isolation, and `tests/integration/pos-s3-search.test.ts` proves that
 * by stripping them on a real `daftar_app` connection and finding zero rows.
 */

/**
 * THE ROUTE THIS SERVICE ANSWERS, stated here and MOUNTED ELSEWHERE.
 *
 * P4-S3 deliberately contains no `*.controller.ts` of its own, and that is a
 * structural requirement rather than a convenience.
 * `discoverPhase4Routes` (`scripts/phase4-s1-gate.ts`) walks all of
 * `apps/api/src/modules` for `*.controller.ts`, extracts route paths from the
 * SOURCE TEXT and keeps everything under `PHASE4_ROUTE_PREFIXES` — which
 * includes `/v1/pos`. The sealed G-02 golden
 * (`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts`) asserts its
 * own route list EQUAL to that discovery, and
 * `tests/security/phase4-route-surface.test.ts` derives the declared Phase 4
 * surface from `modules/selling` alone while requiring every `/v1/pos` verb to
 * answer 404. So a controller file's MERE EXISTENCE — mounted or not — turns a
 * sealed P4-S1 golden red.
 *
 * The transport therefore lands once, from the slice coordinator, together
 * with the two golden updates and after migration `0079`. What this module
 * owns is the read, its authority, its refusals and its laws; what it hands
 * over is this table.
 *
 * The permission is `sales.view`, matching `pos-permissions.ts`'s
 * classification of every POS read: ORDINARY (`P4-AL-37`), held by the
 * built-in cashier by default (`permissions.ts`), and NOT `inventory.view` —
 * the cashier holds no inventory key at all, so gating the till's own search
 * on one would lock the cashier out of the till.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const POS_READ_ROUTE_AUTHORITY: readonly {
  readonly method: 'GET';
  readonly path: string;
  readonly permission: 'sales.view';
  readonly sensitive: false;
}[] = Object.freeze([Object.freeze({ method: 'GET' as const, path: '/v1/pos/products', permission: 'sales.view' as const, sensitive: false as const })]);

interface HitRow extends QueryResultRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  sku: string | null;
  barcode: string | null;
  unit_code: string | null;
  unit_decimals: number | null;
  unit_price_minor: string;
  on_hand: string | null;
  track_inventory: boolean;
  match_rank: number;
}

const MATCH_KIND: readonly PosMatchKindDto[] = ['barcode', 'sku', 'name'];

/**
 * The five prefix arms, each a range on one existing index, each bounded by
 * its own LIMIT.
 *
 * Every arm yields `(product_id, variant_id, match_rank, match_key)` and
 * nothing else: resolving the name, the variant name and the stock figure for
 * a whole prefix range would do that work for rows the page then throws away.
 * The survivors — at most `5 × (limit + 1)` of them — are resolved once, in
 * the outer query.
 *
 * `$1` business, `$2` the escaped prefix for the case-folded arms, `$3` the
 * raw prefix for the barcode arms (a barcode is matched byte for byte: a
 * scanner sends what is printed, and `variants_barcode_uq` is not case-folded),
 * `$4` the per-arm row cap.
 *
 * Why `variant_id` is the base variant's real id inside the arms and `NULL`
 * only in the projection: the base variant is what `stock_levels` is keyed on
 * (P3-AL-52 hides it from the client, not from the join).
 */
const ARMS = `
  (SELECT v.product_id, v.id AS variant_id, 0 AS match_rank
     FROM product_variants v
    WHERE v.business_id = $1 AND v.barcode IS NOT NULL AND v.status <> 'archived' AND v.barcode ^@ $3
    ORDER BY v.barcode
    LIMIT $4)
  UNION ALL
  (SELECT p.id AS product_id, NULL::uuid AS variant_id, 0 AS match_rank
     FROM products p
    WHERE p.business_id = $1 AND p.barcode IS NOT NULL AND p.status <> 'archived' AND p.barcode ^@ $3
    ORDER BY p.barcode
    LIMIT $4)
  UNION ALL
  (SELECT v.product_id, v.id AS variant_id, 1 AS match_rank
     FROM product_variants v
    WHERE v.business_id = $1 AND v.sku IS NOT NULL AND v.status <> 'archived' AND lower(v.sku) ^@ $2
    ORDER BY lower(v.sku)
    LIMIT $4)
  UNION ALL
  (SELECT p.id AS product_id, NULL::uuid AS variant_id, 1 AS match_rank
     FROM products p
    WHERE p.business_id = $1 AND p.sku IS NOT NULL AND p.status <> 'archived' AND lower(p.sku) ^@ $2
    ORDER BY lower(p.sku)
    LIMIT $4)
  UNION ALL
  -- The name arm carries the active-product test itself: product_translations
  -- has no status, so without it a business with many archived products would
  -- spend this arm's whole LIMIT on rows the outer join then discards, and a
  -- real match would never be reached. It is a primary-key probe per candidate
  -- row, and the LIMIT still stops the index walk early.
  (SELECT t.product_id, NULL::uuid AS variant_id, 2 AS match_rank
     FROM product_translations t
    WHERE t.business_id = $1 AND lower(t.name) ^@ $2
      AND EXISTS (SELECT 1 FROM products ap WHERE ap.business_id = t.business_id AND ap.id = t.product_id AND ap.status = 'active')
    ORDER BY lower(t.name)
    LIMIT $4)`;

@Injectable()
export class PosReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private scope(m: MembershipContext): { tenantId: string; businessId: string } {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  /**
   * The POS product type-ahead.
   *
   * Permission: `sales.view`, the key `pos-permissions.ts` gives every POS
   * read. Deliberately NOT
   * `inventory.view` — the built-in cashier role holds `catalog.view`,
   * `sales.view`, `sales.create`, `customers.view` and `payments.collect` and
   * no inventory key at all (`permissions.ts:214`), so gating the POS search
   * on `inventory.view` would lock the cashier out of the till. The
   * availability figure travels with the row for the same reason `OD-P4-05`
   * ruled OPTION A (no oversell, atomic refusal): a cashier who cannot see
   * that a line is out of stock can only discover it when the sale is refused.
   *
   * Scope: the till names its warehouse, and the P3 read rule applies
   * unchanged — an assigned-scope member who names a warehouse they do not
   * reach is REFUSED (`pos.warehouse_out_of_scope`, 403), and a warehouse this
   * transaction cannot see at all is REFUSED too (`pos.warehouse_not_found`,
   * 404) — never answered with an empty page. An empty page would read as
   * "nothing in stock", which is a different and wrong answer, and a cashier
   * acting on it refuses a sale of stock that is on the shelf.
   */
  async searchProducts(m: MembershipContext, q: PosProductSearchQuery, locale: LocaleCode): Promise<PosProductSearchDto> {
    requireAnyPermission(m, ['sales.view']);
    const reachable = await reachableWarehouses(this.db, m);
    if (reachable !== null && !reachable.has(q.warehouseId)) throw sellingRefusal('pos.warehouse_out_of_scope');

    const size = q.limit ?? POS_SEARCH_DEFAULT_LIMIT;
    const prefix = q.q.toLowerCase();

    /**
     * The business's currency and the existence of the named warehouse, in one
     * statement.
     *
     * The existence check is the P3-S7 rule (`inventory-reads.ts`'s
     * `assertWarehouse`) and it is not redundant beside the reach check. A
     * BUSINESS-WIDE member reaches every warehouse of their own business, so
     * the reach check passes for any id at all — and a till that named another
     * business's warehouse would then get a 200 whose every `onHand` is `0`,
     * because the stock join simply finds nothing under row security. "Zero of
     * everything" is a different and wrong answer from "that is not your
     * warehouse": it reads as an empty shop and would have a cashier refuse a
     * sale of stock that is on the shelf. So an unknown warehouse is REFUSED.
     *
     * It is folded into the currency read rather than added beside it because
     * a type-ahead runs on every keystroke, and three round trips per
     * keystroke is the kind of cost that only shows up at the till.
     */
    const facts = await this.db.scoped<{ base_currency: string; warehouse_exists: boolean }>(
      this.scope(m),
      `SELECT b.base_currency,
              EXISTS (SELECT 1 FROM warehouses w WHERE w.business_id = b.id AND w.id = $2::uuid) AS warehouse_exists
         FROM businesses b
        WHERE b.id = $1`,
      [m.businessId, q.warehouseId],
    );
    const row = facts.rows[0];
    if (row === undefined) throw AppError.forbidden('The business does not exist');
    if (!row.warehouse_exists) throw sellingRefusal('pos.warehouse_not_found');
    const currency = row.base_currency;

    const found = await this.db.scoped<HitRow>(
      this.scope(m),
      `WITH hit AS (${ARMS}
       ), unit AS (
         SELECT h.product_id, min(h.match_rank) AS match_rank,
                -- A product matched by one of its variants keeps that variant;
                -- a product matched by its own name, SKU or barcode offers
                -- every sellable unit it has, so the variant is resolved below.
                bool_or(h.variant_id IS NOT NULL) AS variant_matched,
                array_remove(array_agg(DISTINCT h.variant_id), NULL) AS variant_ids
           FROM hit h
          GROUP BY h.product_id
       )
       SELECT u.product_id,
              CASE WHEN v.is_base THEN NULL ELSE v.id END AS variant_id,
              ${productNameSql('p', '$5::text')} AS name,
              CASE WHEN v.is_base THEN NULL ELSE ${variantNameSql('v')} END AS variant_name,
              coalesce(v.sku, p.sku) AS sku,
              coalesce(v.barcode, p.barcode) AS barcode,
              p.unit_code, p.unit_decimals,
              coalesce(v.price_minor, p.base_price_minor)::text AS unit_price_minor,
              CASE WHEN p.track_inventory THEN coalesce(s.on_hand, 0)::text ELSE NULL END AS on_hand,
              p.track_inventory,
              u.match_rank
         FROM unit u
         JOIN products p ON p.business_id = $1 AND p.id = u.product_id AND p.status = 'active'
         JOIN product_variants v ON v.business_id = p.business_id AND v.product_id = p.id
         LEFT JOIN stock_levels s ON s.business_id = p.business_id AND s.warehouse_id = $6::uuid AND s.variant_id = v.id
        WHERE (CASE WHEN u.variant_matched THEN v.id = ANY (u.variant_ids) ELSE TRUE END)
          -- Sellable units only: an active merchant variant, or the hidden base
          -- variant of a product that has no active merchant variant.
          AND (CASE WHEN v.is_base
                    THEN NOT EXISTS (SELECT 1 FROM product_variants mv
                                      WHERE mv.business_id = p.business_id AND mv.product_id = p.id
                                        AND NOT mv.is_base AND mv.status = 'active')
                    ELSE v.status = 'active' END)
        ORDER BY u.match_rank, ${productNameSql('p', '$5::text')}, u.product_id,
                 CASE WHEN v.is_base THEN 0 ELSE 1 END,
                 CASE WHEN v.is_base THEN '' ELSE ${variantNameSql('v')} END,
                 CASE WHEN v.is_base THEN '${NIL_UUID}'::uuid ELSE v.id END
        LIMIT $7`,
      [m.businessId, prefix, q.q, size + 1, locale, q.warehouseId, size + 1],
    );

    const page = found.rows.slice(0, size);
    const items: PosProductHitDto[] = page.map((r) => ({
      productId: r.product_id,
      variantId: r.variant_id,
      name: r.name,
      variantName: r.variant_name === '' ? null : r.variant_name,
      sku: r.sku,
      barcode: r.barcode,
      unitCode: r.unit_code,
      unitDecimals: r.unit_decimals,
      unitPriceMinor: r.unit_price_minor,
      currency,
      onHand: r.on_hand === null ? null : quantityText(r.on_hand, r.unit_decimals ?? 0),
      trackInventory: r.track_inventory,
      matchedOn: MATCH_KIND[r.match_rank] ?? 'name',
    }));
    return { query: prefix, warehouseId: q.warehouseId, items, moreMatches: found.rows.length > size };
  }
}
