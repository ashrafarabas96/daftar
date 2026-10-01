import { Inject, Injectable } from '@nestjs/common';
import type { SaleDto, SaleInvoiceRefDto, SaleLineDto } from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { ReadScope } from '../inventory/inventory-stock-read';
import { sellingRefusal } from './selling-errors';

/**
 * The reads the atomic sale commit needs, and the read of what it wrote —
 * P4-S2 (docs/PHASE_4_S2_CONTRACT.md A-03, A-04, A-11).
 *
 * Three rules hold for every function here:
 *
 * - **no write, ever.** This module is a reader; the ONE writer of a sale is
 *   `sale_commit`, and the ONE writer of `stock_movements` is
 *   `inventory_apply_stock_movements`;
 * - **RLS, not a filter.** Every statement runs through `db.scoped`, which
 *   sets the tenant and business GUCs the policies read. The
 *   `business_id = $1` predicate in each statement is an index predicate, not
 *   the isolation: a row of another business is invisible and reads as not
 *   found (P4-AL-40);
 * - **no clock and no current rate.** Nothing here calls `now()` and nothing
 *   looks up a live exchange rate. The rate a sale reports is the rate it was
 *   POSTED at, read off the document (P4-AL-10).
 *
 * `readSaleHeader` is the one that carries a law. It is the FIRST read of the
 * commit path, and it reads the stored `commit_intent_sha256` and nothing
 * else that the handler could act on: the proof comes before current state
 * (`[[daftar-registry-before-state]]`), because a stale request replayed
 * after a later transition, whose handler reads state first, performs a second
 * real change. The pre-read is a fast path only — `sale_commit` takes the
 * per-document advisory lock and repeats the proof under it (C-09), so two
 * concurrent identical commits serialize in the routine, not here.
 */

async function rows<T extends QueryResultRow>(db: Database, scope: ReadScope, text: string, params: unknown[]): Promise<T[]> {
  return (await db.scoped<T>({ tenantId: scope.tenantId, businessId: scope.businessId }, text, params)).rows;
}

/** The scoped read every selling command uses; exported so one connection discipline covers the module. */
export async function scopedSellingRows<T extends QueryResultRow>(db: Database, scope: ReadScope, text: string, params: unknown[]): Promise<T[]> {
  return rows<T>(db, scope, text, params);
}

// ── 1. The idempotency proof (P4-AL-30) ──────────────────────────────────

/** The stored sale header the replay proof is made of. Deliberately minimal. */
export interface StoredSaleHeader {
  /** The 64-hex digest of the command that wrote this sale — the proof, not the key. */
  readonly commit_intent_sha256: string;
  readonly status: string;
}

/**
 * The stored sale for a caller-supplied `saleId`, or null when the id is
 * unseen. It selects the intent digest and the state, so a replay is decided
 * on the PROOF and never on the mere existence of the row: an idempotency key
 * is not permission (`[[daftar-idempotency-key-is-not-permission]]`).
 *
 * There is no `idempotency_key` column to read, in this table or anywhere in
 * Phase 4 (P4-AL-30): the document's own UUID is the key and the stored digest
 * is what makes it a proof.
 */
export async function readSaleHeader(db: Database, scope: ReadScope, saleId: string): Promise<StoredSaleHeader | null> {
  const [row] = await rows<{ commit_intent_sha256: string; status: string }>(
    db,
    scope,
    `SELECT s.commit_intent_sha256, s.status FROM sales s WHERE s.business_id = $1 AND s.id = $2`,
    [scope.businessId, saleId],
  );
  return row === undefined ? null : { commit_intent_sha256: row.commit_intent_sha256, status: row.status };
}

// ── 2. The catalogue facts the server prices from (P4-AL-18) ─────────────

/**
 * Everything the server needs to price ONE line, all of it read from the
 * catalogue and none of it from the request.
 *
 * `priceMinor` is an integer count of MINOR units of `priceCurrency` —
 * `products.base_price_minor`, overridden by `product_variants.price_minor`
 * when the named variant carries one (`0005:44`: NULL inherits the product's
 * price). It is never a float and never a rounded quotient.
 *
 * `nameSnapshot` is resolved by a FIXED locale order and not by the caller's
 * locale: a document snapshot that depended on who rang up the sale would
 * make two identical requests store two different histories, and the snapshot
 * is history the moment it is written.
 */
export interface SalePriceFacts {
  readonly productId: string;
  readonly variantId: string;
  readonly productStatus: string;
  readonly variantStatus: string;
  readonly trackInventory: boolean;
  readonly unitDecimals: number | null;
  readonly priceMinor: bigint | null;
  readonly priceCurrency: string | null;
  readonly nameSnapshot: string;
}

interface PriceFactRow extends QueryResultRow {
  product_id: string;
  variant_id: string;
  product_status: string;
  variant_status: string;
  track_inventory: boolean;
  unit_decimals: number | null;
  price_minor: string | null;
  price_currency: string | null;
  name_snapshot: string | null;
}

/**
 * The catalogue facts for every resolved stock variant of the request, keyed
 * by that variant. A variant the business does not hold is simply absent, and
 * the caller refuses `sale.product_not_found` — never a filter that silently
 * drops a line, because a sale missing a line is a different sale.
 */
export async function readSalePriceFacts(db: Database, scope: ReadScope, variantIds: readonly string[]): Promise<ReadonlyMap<string, SalePriceFacts>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const found = await rows<PriceFactRow>(
    db,
    scope,
    `SELECT p.id AS product_id, v.id AS variant_id, p.status AS product_status, v.status AS variant_status,
            p.track_inventory, p.unit_decimals,
            coalesce(v.price_minor, p.base_price_minor)::text AS price_minor, p.price_currency,
            coalesce(p.translations ->> 'ar', p.translations ->> 'en', p.translations ->> 'tr') AS name_snapshot
       FROM product_variants v
       JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
      WHERE v.business_id = $1 AND v.id = ANY($2::uuid[])`,
    [scope.businessId, ids],
  );
  const out = new Map<string, SalePriceFacts>();
  for (const r of found) {
    out.set(r.variant_id, {
      productId: r.product_id,
      variantId: r.variant_id,
      productStatus: r.product_status,
      variantStatus: r.variant_status,
      trackInventory: r.track_inventory,
      unitDecimals: r.unit_decimals,
      priceMinor: r.price_minor === null ? null : BigInt(r.price_minor),
      priceCurrency: r.price_currency,
      // A product with no readable name in any of the three locales has no
      // snapshot to store, and `invoice_items.name_snapshot` is NOT NULL, so
      // the sale is refused here rather than at the insert.
      nameSnapshot: r.name_snapshot ?? '',
    });
  }
  return out;
}

// ── 3. The committed sale, read back (A-11) ──────────────────────────────

interface SaleRow extends QueryResultRow {
  id: string;
  status: string;
  settlement_mode: 'credit' | 'cash';
  customer_id: string | null;
  branch_id: string;
  warehouse_id: string;
  document_date: string;
  currency_code: string;
  subtotal_txn_minor: string;
  discount_txn_minor: string;
  tax_minor: string;
  total_txn_minor: string;
  total_base_minor: string;
  source_to_base_rate: string;
  rate_source: 'base' | 'manual' | 'provider';
  rate_timestamp: Date;
  cogs_base_minor: string;
  invoice_id: string;
  invoice_number: string;
  invoice_number_seq: string;
  invoice_period: string;
  invoice_kind: 'invoice' | 'credit_note';
  issue_date: string;
  due_date: string | null;
  invoice_status: string;
  invoice_total_txn_minor: string;
  invoice_total_base_minor: string;
}

interface SaleItemRow extends QueryResultRow {
  id: string;
  line_no: number;
  product_id: string;
  variant_id: string | null;
  name_snapshot: string;
  quantity: string;
  unit_price_txn_minor: string;
  gross_txn_minor: string;
  discount_txn_minor: string;
  net_txn_minor: string;
  tax_minor: string;
  base_share_minor: string;
}

/**
 * The committed sale, its lines and its invoice, read back from the stored
 * rows — never from anything the service remembered.
 *
 * Two figures are derived rather than stored, each because storing it would
 * create a second truth:
 *
 * - **the COGS** is the SUM of the debits on the `cogs` system account of the
 *   entry bound to this sale (P4-AL-25). `sales` carries no `cogs_*` column
 *   and `sale_items` carries no `cogs_minor` — the lock's §4 matrix names that
 *   column the forbidden second truth. `0` is a legitimate answer: stock whose
 *   average cost is zero leaves the shelf at no value, and no COGS entry is
 *   posted for it, so the `LEFT JOIN` returning nothing reads as zero;
 * - **nothing about settlement.** No paid total, no outstanding total and no
 *   settlement state (P4-AL-06, P4-AL-26): the invoice surface derives those
 *   through `invoice_outstanding(...)` and `invoice_settlement_state(...)` at
 *   read time, and a freshly committed invoice's settlement is a question for
 *   that surface rather than an answer this read caches.
 */
export async function readSaleDto(db: Database, scope: ReadScope, saleId: string, replayed: boolean): Promise<SaleDto> {
  const [row] = await rows<SaleRow>(
    db,
    scope,
    `SELECT s.id, s.status, s.settlement_mode, s.customer_id, s.branch_id, s.warehouse_id,
            to_char(s.document_date, 'YYYY-MM-DD') AS document_date,
            s.currency_code, s.subtotal_txn_minor::text AS subtotal_txn_minor, s.discount_txn_minor::text AS discount_txn_minor,
            s.tax_minor::text AS tax_minor, s.total_txn_minor::text AS total_txn_minor, s.total_base_minor::text AS total_base_minor,
            s.source_to_base_rate::text AS source_to_base_rate, s.rate_source, s.rate_timestamp,
            coalesce(cogs.amount, 0)::text AS cogs_base_minor,
            i.id AS invoice_id, i.document_number AS invoice_number, i.number_seq::text AS invoice_number_seq,
            i.period AS invoice_period, i.document_kind AS invoice_kind,
            to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
            i.status AS invoice_status, i.total_txn_minor::text AS invoice_total_txn_minor,
            i.total_base_minor::text AS invoice_total_base_minor
       FROM sales s
       JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id AND i.document_kind = 'invoice'
       LEFT JOIN LATERAL (
              SELECT sum(jl.base_amount_minor) AS amount
                FROM journal_entries je
                JOIN journal_lines jl ON jl.business_id = je.business_id AND jl.journal_entry_id = je.id
                JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id
               WHERE je.business_id = s.business_id AND je.source_type = 'sale' AND je.source_id = s.id
                 AND a.system_key = 'cogs' AND jl.debit_minor > 0
            ) cogs ON true
      WHERE s.business_id = $1 AND s.id = $2`,
    [scope.businessId, saleId],
  );
  if (row === undefined) throw sellingRefusal('sale.not_found');
  const items = await rows<SaleItemRow>(
    db,
    scope,
    `SELECT it.id, it.line_no, it.product_id, it.variant_id, it.name_snapshot,
            it.quantity::text AS quantity, it.unit_price_txn_minor::text AS unit_price_txn_minor,
            it.gross_txn_minor::text AS gross_txn_minor, it.discount_txn_minor::text AS discount_txn_minor,
            it.net_txn_minor::text AS net_txn_minor, it.tax_minor::text AS tax_minor,
            it.base_share_minor::text AS base_share_minor
       FROM sale_items it
      WHERE it.business_id = $1 AND it.sale_id = $2
      ORDER BY it.line_no`,
    [scope.businessId, saleId],
  );
  const lines: SaleLineDto[] = items.map((r) => ({
    lineId: r.id,
    lineNo: r.line_no,
    productId: r.product_id,
    variantId: r.variant_id,
    nameSnapshot: r.name_snapshot,
    quantity: r.quantity,
    unitPriceTxnMinor: r.unit_price_txn_minor,
    grossTxnMinor: r.gross_txn_minor,
    discountTxnMinor: r.discount_txn_minor,
    netTxnMinor: r.net_txn_minor,
    taxMinor: r.tax_minor,
    baseShareMinor: r.base_share_minor,
  }));
  if (row.invoice_status !== 'open') {
    // The commit writes the invoice directly as `open` (`0075`'s lifecycle
    // guard is BEFORE UPDATE only, so an INSERT as `open` is permitted), and
    // this read is the commit's own answer. Anything else is a defect, not an
    // outcome, and it is reported as one.
    throw sellingRefusal('sale.immutable');
  }
  const invoice: SaleInvoiceRefDto = {
    invoiceId: row.invoice_id,
    number: { documentKind: row.invoice_kind, period: row.invoice_period, numberSeq: row.invoice_number_seq, documentNumber: row.invoice_number },
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: 'open',
    totalTxnMinor: row.invoice_total_txn_minor,
    totalBaseMinor: row.invoice_total_base_minor,
  };
  return {
    saleId: row.id,
    status: row.status as SaleDto['status'],
    settlementMode: row.settlement_mode,
    customerId: row.customer_id,
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
    documentDate: row.document_date,
    currencyCode: row.currency_code,
    subtotalTxnMinor: row.subtotal_txn_minor,
    discountTxnMinor: row.discount_txn_minor,
    taxMinor: row.tax_minor,
    totalTxnMinor: row.total_txn_minor,
    totalBaseMinor: row.total_base_minor,
    sourceToBaseRate: row.source_to_base_rate,
    rateSource: row.rate_source,
    rateTimestamp: `${row.rate_timestamp.toISOString().slice(0, 19)}Z`,
    lines,
    invoice,
    cogsBaseMinor: row.cogs_base_minor,
    replayed,
  };
}

/** Nest's handle on the reads, for the controller; the functions above stay usable without it. */
@Injectable()
export class SaleReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async read(scope: ReadScope, saleId: string): Promise<SaleDto> {
    return readSaleDto(this.db, scope, saleId, true);
  }
}

// ── 4. The COGS prediction (A-08) ────────────────────────────────────────

/** One stock key's current valuation, as the prediction reads it before any lock. */
export interface SaleStockLevel {
  readonly onHandQ4: bigint;
  readonly valuationBaseMinor: bigint;
  /** `avg_unit_cost_base_minor` as C10 (x 10^10), or null for a key with no stock. */
  readonly avgUnitCostC10: bigint | null;
}

/**
 * The `stock_levels` rows of the keys this sale will touch — read BEFORE the
 * transaction and therefore before the stock key's `FOR UPDATE`.
 *
 * It exists for exactly one reason. The accounting assertions of a sale are
 * minted before the seam opens (the seam's own contract), so the COGS figure
 * they are signed over is a PREDICTION of what the stock writer will compute
 * inside the lock. `packages/accounting/src/sale-posting.ts`'s header states
 * why that is safe: a concurrent movement on the same key makes the prediction
 * stale, and three mechanisms make the disagreement loud rather than silent —
 * `accounting_post_entry` recomputes `acctfp/1` from the lines it received and
 * refuses a mismatch before any write; the deferred
 * `accounting_sale_entry_complete` trigger re-derives the expected COGS line
 * from the PERSISTED `stock_movements`; and the sale's own deferred binding FK
 * fails the COMMIT if the entry never happened. A stale prediction costs a
 * refused sale the till retries, never a misstated cost.
 *
 * **It is NOT a stock check.** Nothing here decides whether there is enough
 * stock: `inventory_apply_stock_movements` raises
 * `inventory.insufficient_stock` under the level row's own `FOR UPDATE`
 * (`0060:383`), which is also the last-item race mechanism, and that stays
 * the only answer (OD-P4-05, NO OVERSELL). A pre-read that refused early
 * would be a second oversell rule racing the real one.
 */
export async function readSaleStockLevels(
  db: Database,
  scope: ReadScope,
  warehouseId: string,
  variantIds: readonly string[],
): Promise<ReadonlyMap<string, SaleStockLevel>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const found = await rows<{ variant_id: string; on_hand_q4: string; valuation_base_minor: string; avg_c10: string | null }>(
    db,
    scope,
    `SELECT l.variant_id,
            (l.on_hand * 10000)::numeric(22,0)::text AS on_hand_q4,
            l.valuation_base_minor::text AS valuation_base_minor,
            (l.avg_unit_cost_base_minor * 10000000000)::numeric(40,0)::text AS avg_c10
       FROM stock_levels l
      WHERE l.business_id = $1 AND l.warehouse_id = $2 AND l.variant_id = ANY($3::uuid[])`,
    [scope.businessId, warehouseId, ids],
  );
  const out = new Map<string, SaleStockLevel>();
  for (const r of found) {
    out.set(r.variant_id, {
      onHandQ4: BigInt(r.on_hand_q4),
      valuationBaseMinor: BigInt(r.valuation_base_minor),
      avgUnitCostC10: r.avg_c10 === null ? null : BigInt(r.avg_c10),
    });
  }
  return out;
}
