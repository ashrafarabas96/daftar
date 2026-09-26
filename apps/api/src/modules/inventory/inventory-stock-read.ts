import { AppError } from '@daftar/domain-core';
import { assertQuantityRepresentable, EMPTY_STOCK_STATE, InventoryError, parseDecimal, parseMinor, parseQuantity, type StockState } from '@daftar/inventory';
import type { QueryResultRow } from 'pg';
import type { Database } from '../../infra/database';
import { inventoryRefusal } from './inventory-errors';

/**
 * The READS of the P3-S3 movement commands (PHASE_3_S3_CONTRACT A-07, A-10,
 * A-13, A-19, A-23), all through `daftar_app` under row level security. This
 * module writes nothing: every write is an entry routine's or the accounting
 * primitive's (L:1003, G-4).
 *
 * Three kinds of read live here, and a service calls them in the order A-10(c)
 * fixes:
 *
 * 1. identity — resolving a request line to its stock variant (A-23). Only
 *    immutable facts (the variant belongs to the product; it is or is not the
 *    base) decide the identity, so a replay resolves exactly as the original;
 * 2. the idempotency proof — the stored header and its intent digest, then,
 *    for a replay, the stored result (A-10(f)): stored rows only, never a
 *    recomputed value (L:1370);
 * 3. current state, only AFTER the proof — statuses, the stock levels the
 *    expected values are computed from (A-07), the opening position (A-13).
 *
 * A row of another business is invisible under RLS and reads as not found.
 */

/** The business a read runs in. Both halves are required by the RLS policies. */
export interface ReadScope {
  readonly tenantId: string;
  readonly businessId: string;
}

async function rows<T extends QueryResultRow>(db: Database, scope: ReadScope, text: string, params: unknown[]): Promise<T[]> {
  return (await db.scoped<T>({ tenantId: scope.tenantId, businessId: scope.businessId }, text, params)).rows;
}

// ── 1. Identity (A-23) ───────────────────────────────────────────────────

/** A request line's product and optional merchant variant. */
export interface VariantReference {
  readonly productId: string;
  readonly variantId?: string | null;
}

/** The stock identity a request line resolved to, with the facts later checks need. */
export interface ResolvedVariant {
  readonly productId: string;
  /** The variant the stock key and the payload carry — possibly the hidden base variant. */
  readonly variantId: string;
  /** The merchant variant the request named, or null for a simple product. The base variant never leaves the server (P3-AL-52). */
  readonly merchantVariantId: string | null;
  readonly productStatus: string;
  readonly variantStatus: string;
  readonly trackInventory: boolean;
  readonly unitDecimals: number | null;
  /** Active merchant variants of the product; a request naming none is valid only when this is 0. */
  readonly activeMerchantVariants: number;
}

interface VariantRow {
  product_id: string;
  product_status: string;
  track_inventory: boolean;
  unit_decimals: number | null;
  variant_id: string;
  is_base: boolean;
  variant_status: string;
}

/**
 * Resolves every line to its stock variant (A-23): with a `variantId`, a
 * NON-base variant of that product; without one, the product's base variant.
 * Refuses `inventory.product_not_found` / `inventory.variant_not_found`.
 * Statuses are returned, not judged: they are current state, checked after
 * the idempotency proof by `assertMovableVariant`.
 */
export async function resolveVariants(db: Database, scope: ReadScope, lines: readonly VariantReference[]): Promise<ResolvedVariant[]> {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const found =
    productIds.length === 0
      ? []
      : await rows<VariantRow>(
          db,
          scope,
          `SELECT p.id AS product_id, p.status AS product_status, p.track_inventory, p.unit_decimals,
                  v.id AS variant_id, v.is_base, v.status AS variant_status
             FROM products p
             JOIN product_variants v ON v.business_id = p.business_id AND v.product_id = p.id
            WHERE p.business_id = $1 AND p.id = ANY($2::uuid[])`,
          [scope.businessId, productIds],
        );
  return lines.map((line) => {
    const variants = found.filter((r) => r.product_id === line.productId);
    const product = variants[0];
    if (product === undefined) throw inventoryRefusal('inventory.product_not_found');
    const wanted = line.variantId ?? null;
    const row = wanted === null ? variants.find((r) => r.is_base) : variants.find((r) => r.variant_id === wanted && !r.is_base);
    if (row === undefined) throw inventoryRefusal('inventory.variant_not_found');
    return {
      productId: line.productId,
      variantId: row.variant_id,
      merchantVariantId: wanted,
      productStatus: product.product_status,
      variantStatus: row.variant_status,
      trackInventory: product.track_inventory,
      unitDecimals: product.unit_decimals,
      activeMerchantVariants: variants.filter((r) => !r.is_base && r.variant_status === 'active').length,
    };
  });
}

/**
 * The current-state checks of a resolved line, run only AFTER the
 * idempotency proof: the product is tracked, a request naming no variant is
 * for a product with no active merchant variant, the quantity is exact at the
 * unit's precision, and — for stock coming IN — neither the product nor the
 * variant is archived (A-19). The routines re-check all of it.
 */
export function assertMovableVariant(v: ResolvedVariant, qtyQ4: bigint | null, inbound: boolean): void {
  if (!v.trackInventory || v.unitDecimals === null) throw inventoryRefusal('inventory.product_not_tracked');
  if (v.merchantVariantId === null && v.activeMerchantVariants > 0) throw inventoryRefusal('inventory.variant_required');
  if (inbound && v.productStatus !== 'active') throw inventoryRefusal('inventory.product_archived');
  if (inbound && v.variantStatus !== 'active') throw inventoryRefusal('inventory.variant_archived');
  if (qtyQ4 !== null) {
    try {
      assertQuantityRepresentable(qtyQ4, v.unitDecimals);
    } catch (e) {
      if (e instanceof InventoryError) throw inventoryRefusal(e.code);
      throw e;
    }
  }
}

// ── 3. Current state ─────────────────────────────────────────────────────

export interface WarehouseFacts {
  readonly id: string;
  /** The home branch (immutable, L:595-596): the branch dimension of the warehouse's journal lines. */
  readonly branchId: string;
  readonly status: string;
}

/** Every named warehouse, or `inventory.warehouse_not_found`; `inbound` ones must be active (`inventory.warehouse_archived`). */
export async function readWarehouses(
  db: Database,
  scope: ReadScope,
  ids: readonly string[],
  inbound: readonly string[] = [],
): Promise<Map<string, WarehouseFacts>> {
  const unique = [...new Set(ids)];
  const found = await rows<{ id: string; branch_id: string; status: string }>(
    db,
    scope,
    'SELECT id, branch_id, status FROM warehouses WHERE business_id = $1 AND id = ANY($2::uuid[])',
    [scope.businessId, unique],
  );
  const out = new Map(found.map((w) => [w.id, { id: w.id, branchId: w.branch_id, status: w.status }]));
  for (const id of unique) {
    const w = out.get(id);
    if (w === undefined) throw inventoryRefusal('inventory.warehouse_not_found');
    if (inbound.includes(id) && w.status !== 'active') throw inventoryRefusal('inventory.warehouse_archived');
  }
  return out;
}

/** The business's base currency: the currency of every S3 journal line. */
export async function readBaseCurrency(db: Database, scope: ReadScope): Promise<string> {
  const [row] = await rows<{ base_currency: string }>(db, scope, 'SELECT base_currency FROM businesses WHERE id = $1', [scope.businessId]);
  if (row === undefined) throw AppError.forbidden('The business does not exist');
  return row.base_currency;
}

export const stockKey = (warehouseId: string, variantId: string): string => `${warehouseId}|${variantId}`;

/** A signed C10 from `NUMERIC(28,10)` text (an average may in principle be signed). */
function parseSignedC10(text: string): bigint {
  const d = parseDecimal(text);
  if (d.scale > 10) throw new Error('an average cost carries more than ten decimals');
  return d.units * 10n ** BigInt(10 - d.scale);
}

/**
 * The current `stock_levels` of the given keys (A-07 step 1): no lock, one
 * statement. A key with no row is the empty state. The values computed from
 * these are only a proposal the routine re-proves under the stock-key lock;
 * a difference is `inventory.valuation_changed`, never a wrong posting.
 */
export async function readStockStates(
  db: Database,
  scope: ReadScope,
  keys: readonly { readonly warehouseId: string; readonly variantId: string }[],
): Promise<Map<string, StockState>> {
  const out = new Map<string, StockState>();
  if (keys.length === 0) return out;
  const found = await rows<{
    warehouse_id: string;
    variant_id: string;
    on_hand: string;
    valuation_base_minor: string;
    avg_unit_cost_base_minor: string | null;
    last_stock_seq: string;
  }>(
    db,
    scope,
    `SELECT s.warehouse_id, s.variant_id, s.on_hand::text AS on_hand, s.valuation_base_minor::text AS valuation_base_minor,
            s.avg_unit_cost_base_minor::text AS avg_unit_cost_base_minor, s.last_stock_seq::text AS last_stock_seq
       FROM stock_levels s
       JOIN unnest($2::uuid[], $3::uuid[]) AS k(warehouse_id, variant_id) ON k.warehouse_id = s.warehouse_id AND k.variant_id = s.variant_id
      WHERE s.business_id = $1`,
    [scope.businessId, keys.map((k) => k.warehouseId), keys.map((k) => k.variantId)],
  );
  for (const k of keys) out.set(stockKey(k.warehouseId, k.variantId), EMPTY_STOCK_STATE);
  for (const r of found) {
    out.set(stockKey(r.warehouse_id, r.variant_id), {
      onHand: parseQuantity(r.on_hand),
      valuation: parseMinor(r.valuation_base_minor),
      avg: r.avg_unit_cost_base_minor === null ? null : parseSignedC10(r.avg_unit_cost_base_minor),
      lastStockSeq: BigInt(r.last_stock_seq),
    });
  }
  return out;
}

/** The posted opening balance's inventory position (A-13): its id and `Σ Dr − Σ Cr` on the business's `inventory` account. */
export interface OpeningPosition {
  readonly openingBalanceId: string;
  readonly positionMinor: bigint;
}

/**
 * The application's read of the opening position (TL-13), through
 * `daftar_app`'s accepted SELECT on the opening-balance tables. Lines resolve
 * to the `inventory` system account by its system key or by that account's
 * own code, as `0047` lets a position name it. Null when no opening balance is
 * posted or it has no inventory line. The routine re-reads the same answer
 * through `accounting_inventory_opening_position` under the shared advisory
 * lock and refuses a difference (`inventory.opening_case_changed`).
 */
export async function readOpeningPosition(db: Database, scope: ReadScope): Promise<OpeningPosition | null> {
  const found = await rows<{ id: string; net: string }>(
    db,
    scope,
    `SELECT ob.id, sum(CASE WHEN l.side = 'D' THEN l.base_amount_minor ELSE -l.base_amount_minor END)::text AS net
       FROM accounting_opening_balances ob
       JOIN accounting_opening_balance_lines l ON l.business_id = ob.business_id AND l.opening_balance_id = ob.id
      WHERE ob.business_id = $1
        AND ob.status = 'posted'
        AND (   (l.account_ref_kind = 'system' AND l.account_system_key = 'inventory')
             OR (l.account_ref_kind = 'code' AND l.account_code = (SELECT a.code FROM accounts a WHERE a.business_id = $1 AND a.system_key = 'inventory')))
      GROUP BY ob.id`,
    [scope.businessId],
  );
  if (found.length > 1) throw new Error('more than one posted opening balance holds inventory');
  const [row] = found;
  return row === undefined ? null : { openingBalanceId: row.id, positionMinor: BigInt(row.net) };
}

/** True when a posted inventory opening already exists (A-13, `inventory.opening_already_posted`). */
export async function postedOpeningExists(db: Database, scope: ReadScope): Promise<boolean> {
  return (await rows(db, scope, `SELECT 1 FROM inventory_openings WHERE business_id = $1 AND status = 'posted'`, [scope.businessId])).length > 0;
}

// ── 2. The idempotency proof and the stored result (A-10) ────────────────

export interface TransferHeader {
  readonly intentSha256: string;
  readonly businessTransactionId: string;
}

export async function findTransfer(db: Database, scope: ReadScope, id: string): Promise<TransferHeader | null> {
  const [r] = await rows<{ intent_sha256: string; business_transaction_id: string }>(
    db,
    scope,
    'SELECT intent_sha256, business_transaction_id FROM inventory_transfers WHERE business_id = $1 AND id = $2',
    [scope.businessId, id],
  );
  return r === undefined ? null : { intentSha256: r.intent_sha256, businessTransactionId: r.business_transaction_id };
}

export interface AdjustmentHeader {
  readonly kind: 'adjustment' | 'damage';
  readonly intentSha256: string;
  readonly businessTransactionId: string;
}

export async function findAdjustment(db: Database, scope: ReadScope, id: string): Promise<AdjustmentHeader | null> {
  const [r] = await rows<{ kind: 'adjustment' | 'damage'; intent_sha256: string; business_transaction_id: string }>(
    db,
    scope,
    'SELECT kind, intent_sha256, business_transaction_id FROM inventory_adjustments WHERE business_id = $1 AND id = $2',
    [scope.businessId, id],
  );
  return r === undefined ? null : { kind: r.kind, intentSha256: r.intent_sha256, businessTransactionId: r.business_transaction_id };
}

export interface StocktakeHeader {
  readonly id: string;
  readonly warehouseId: string;
  readonly status: 'draft' | 'finalized' | 'cancelled';
  readonly intentSha256: string;
  readonly finalizeIntentSha256: string | null;
}

export async function findStocktake(db: Database, scope: ReadScope, id: string): Promise<StocktakeHeader | null> {
  const [r] = await rows<{ warehouse_id: string; status: 'draft' | 'finalized' | 'cancelled'; intent_sha256: string; finalize_intent_sha256: string | null }>(
    db,
    scope,
    'SELECT warehouse_id, status, intent_sha256, finalize_intent_sha256 FROM stocktakes WHERE business_id = $1 AND id = $2',
    [scope.businessId, id],
  );
  return r === undefined
    ? null
    : { id, warehouseId: r.warehouse_id, status: r.status, intentSha256: r.intent_sha256, finalizeIntentSha256: r.finalize_intent_sha256 };
}

/** True when the warehouse already has a draft stocktake (A-11, `inventory.stocktake_already_open`). */
export async function draftStocktakeExists(db: Database, scope: ReadScope, warehouseId: string): Promise<boolean> {
  return (
    (await rows(db, scope, `SELECT 1 FROM stocktakes WHERE business_id = $1 AND warehouse_id = $2 AND status = 'draft'`, [scope.businessId, warehouseId]))
      .length > 0
  );
}

/** One stored stocktake line: its variant, its product, and the capture it holds. */
export interface StocktakeLineRow {
  readonly lineId: string;
  readonly variantId: string;
  readonly productId: string;
  readonly isBase: boolean;
  readonly expectedQtyAtCapture: string;
  readonly capturedAtStockSeq: string;
  readonly countedQty: string;
  readonly varianceQty: string;
}

/** Every line of a stocktake, in ascending `variant_id` order — the canonical order of its finalize payload (A-09). */
export async function readStocktakeLines(db: Database, scope: ReadScope, stocktakeId: string): Promise<StocktakeLineRow[]> {
  const found = await rows<{
    id: string;
    variant_id: string;
    product_id: string;
    is_base: boolean;
    expected_qty_at_capture: string;
    captured_at_stock_seq: string;
    counted_qty: string;
    variance_qty: string;
  }>(
    db,
    scope,
    `SELECT l.id, l.variant_id, v.product_id, v.is_base, l.expected_qty_at_capture::text AS expected_qty_at_capture,
            l.captured_at_stock_seq::text AS captured_at_stock_seq, l.counted_qty::text AS counted_qty, l.variance_qty::text AS variance_qty
       FROM stocktake_lines l
       JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
      WHERE l.business_id = $1 AND l.stocktake_id = $2
      ORDER BY l.variant_id`,
    [scope.businessId, stocktakeId],
  );
  return found.map((r) => ({
    lineId: r.id,
    variantId: r.variant_id,
    productId: r.product_id,
    isBase: r.is_base,
    expectedQtyAtCapture: r.expected_qty_at_capture,
    capturedAtStockSeq: r.captured_at_stock_seq,
    countedQty: r.counted_qty,
    varianceQty: r.variance_qty,
  }));
}

export interface OpeningHeader {
  readonly intentSha256: string;
  readonly businessTransactionId: string;
  readonly caseKind: 'ledger_posting' | 'opening_balance_bound';
  readonly openingBalanceId: string | null;
  readonly matchedAmountMinor: string | null;
}

export async function findOpening(db: Database, scope: ReadScope, id: string): Promise<OpeningHeader | null> {
  const [r] = await rows<{
    intent_sha256: string;
    business_transaction_id: string;
    case_kind: 'ledger_posting' | 'opening_balance_bound';
    opening_balance_id: string | null;
    matched_amount_base_minor: string | null;
  }>(
    db,
    scope,
    `SELECT intent_sha256, business_transaction_id, case_kind, opening_balance_id, matched_amount_base_minor::text AS matched_amount_base_minor
       FROM inventory_openings WHERE business_id = $1 AND id = $2`,
    [scope.businessId, id],
  );
  return r === undefined
    ? null
    : {
        intentSha256: r.intent_sha256,
        businessTransactionId: r.business_transaction_id,
        caseKind: r.case_kind,
        openingBalanceId: r.opening_balance_id,
        matchedAmountMinor: r.matched_amount_base_minor,
      };
}

/**
 * A-10(e): adjustments and stocktakes share the accounting source
 * `inventory_adjustment`, so an id used by one may not be used by the other.
 * The routines refuse it too (`inventory.document_id_conflict`).
 */
export async function adjustmentSourceIdTaken(db: Database, scope: ReadScope, id: string, by: 'inventory_adjustments' | 'stocktakes'): Promise<boolean> {
  const sql =
    by === 'inventory_adjustments'
      ? 'SELECT 1 FROM inventory_adjustments WHERE business_id = $1 AND id = $2'
      : 'SELECT 1 FROM stocktakes WHERE business_id = $1 AND id = $2';
  return (await rows(db, scope, sql, [scope.businessId, id])).length > 0;
}

/** One stored stock movement of a document, as a command reports it. Money and quantities are strings. */
export interface MovementLineResult {
  readonly lineId: string;
  readonly productId: string;
  /** The merchant variant, or null for a simple product: the hidden base variant never leaves the server (P3-AL-52). */
  readonly variantId: string | null;
  readonly warehouseId: string;
  readonly qtyDelta: string;
  readonly valueDeltaBaseMinor: string;
}

/** What every P3-S3 posting or moving command answers, from stored rows only (A-10(f), A-21). */
export interface MovementDocumentResult {
  readonly id: string;
  /** True when this answer is the stored result of an earlier identical command. */
  readonly replayed: boolean;
  /** The trace id of the operation that produced the document (P3-AL-35). */
  readonly businessTransactionId: string;
  readonly lines: readonly MovementLineResult[];
  readonly journalEntryId: string | null;
}

export type StockSourceType = 'inventory_transfer' | 'inventory_adjustment' | 'stocktake' | 'inventory_opening';

/**
 * The document's movements in line order, found by the movement's own source
 * identity (`stock_movements` carries it; `daftar_app` reads no bridge). A
 * transfer line's `transfer_out` precedes its `transfer_in`.
 */
const MOVEMENTS_SQL: Readonly<Record<StockSourceType, string>> = {
  inventory_transfer: `SELECT m.source_line_id, v.product_id, v.id AS variant_id, v.is_base, m.warehouse_id, m.qty_delta::text AS qty_delta, m.value_delta_base_minor::text AS value
       FROM stock_movements m
       JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
       JOIN inventory_transfer_lines l ON l.business_id = m.business_id AND l.transfer_id = m.source_id AND l.id = m.source_line_id
      WHERE m.business_id = $1 AND m.source_type = 'inventory_transfer' AND m.source_id = $2
      ORDER BY l.line_no, m.qty_delta`,
  inventory_adjustment: `SELECT m.source_line_id, v.product_id, v.id AS variant_id, v.is_base, m.warehouse_id, m.qty_delta::text AS qty_delta, m.value_delta_base_minor::text AS value
       FROM stock_movements m
       JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
       JOIN inventory_adjustment_lines l ON l.business_id = m.business_id AND l.adjustment_id = m.source_id AND l.id = m.source_line_id
      WHERE m.business_id = $1 AND m.source_type = 'inventory_adjustment' AND m.source_id = $2
      ORDER BY l.line_no`,
  stocktake: `SELECT m.source_line_id, v.product_id, v.id AS variant_id, v.is_base, m.warehouse_id, m.qty_delta::text AS qty_delta, m.value_delta_base_minor::text AS value
       FROM stock_movements m
       JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
      WHERE m.business_id = $1 AND m.source_type = 'stocktake' AND m.source_id = $2
      ORDER BY m.variant_id`,
  inventory_opening: `SELECT m.source_line_id, v.product_id, v.id AS variant_id, v.is_base, m.warehouse_id, m.qty_delta::text AS qty_delta, m.value_delta_base_minor::text AS value
       FROM stock_movements m
       JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
       JOIN inventory_opening_lines l ON l.business_id = m.business_id AND l.opening_id = m.source_id AND l.id = m.source_line_id
      WHERE m.business_id = $1 AND m.source_type = 'inventory_opening' AND m.source_id = $2
      ORDER BY l.line_no`,
};

/** The accounting source a stock source posts under, when it posts at all (A-05). */
const ACCOUNTING_SOURCE: Readonly<Record<StockSourceType, string | null>> = {
  inventory_transfer: null,
  inventory_adjustment: 'inventory_adjustment',
  stocktake: 'inventory_adjustment',
  inventory_opening: 'inventory_opening',
};

/** The stored result of a document: its movements and its journal entry, never a recomputed value (A-10(f)). */
export async function readStoredResult(
  db: Database,
  scope: ReadScope,
  sourceType: StockSourceType,
  id: string,
  replayed: boolean,
  businessTransactionId: string,
): Promise<MovementDocumentResult> {
  const movements = await rows<{
    source_line_id: string;
    product_id: string;
    variant_id: string;
    is_base: boolean;
    warehouse_id: string;
    qty_delta: string;
    value: string;
  }>(db, scope, MOVEMENTS_SQL[sourceType], [scope.businessId, id]);
  const accountingSource = ACCOUNTING_SOURCE[sourceType];
  const [binding] =
    accountingSource === null
      ? []
      : await rows<{ journal_entry_id: string }>(
          db,
          scope,
          'SELECT journal_entry_id FROM accounting_source_bindings WHERE business_id = $1 AND source_type = $2 AND source_id = $3',
          [scope.businessId, accountingSource, id],
        );
  return {
    id,
    replayed,
    businessTransactionId,
    lines: movements.map((r) => ({
      lineId: r.source_line_id,
      productId: r.product_id,
      variantId: r.is_base ? null : r.variant_id,
      warehouseId: r.warehouse_id,
      qtyDelta: r.qty_delta,
      valueDeltaBaseMinor: r.value,
    })),
    journalEntryId: binding?.journal_entry_id ?? null,
  };
}

// ── P3-AL-41: the catalog's typed archive pre-check (A-19) ───────────────

/** The minimal query surface the pre-check needs: the catalog's own transaction client. */
export interface StockReadClient {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * True when any variant of the product holds stock in any warehouse — a
 * non-zero `on_hand`, or movements whose quantities do not sum to zero (the
 * movement ledger re-check of L:1206). Run inside the caller's transaction.
 * The `products_30_archive_requires_zero_stock` trigger stays the invariant;
 * this only turns its refusal into a typed one before the write.
 */
export async function productHoldsStock(client: StockReadClient, businessId: string, productId: string): Promise<boolean> {
  const r = await client.query<{ holds: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM stock_levels s
                JOIN product_variants v ON v.business_id = s.business_id AND v.id = s.variant_id
               WHERE s.business_id = $1 AND v.product_id = $2 AND s.on_hand <> 0)
         OR EXISTS (
              SELECT 1 FROM stock_movements m
                JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
               WHERE m.business_id = $1 AND v.product_id = $2
               GROUP BY m.warehouse_id, m.variant_id
              HAVING sum(m.qty_delta) <> 0) AS holds`,
    [businessId, productId],
  );
  return r.rows[0]?.holds === true;
}
