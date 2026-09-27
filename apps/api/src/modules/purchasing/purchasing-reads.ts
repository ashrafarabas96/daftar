import { Inject, Injectable } from '@nestjs/common';
import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError, hasPermission, minorUnitsOf } from '@daftar/domain-core';
import { DOMESTIC_RATE_R10, parseUnitCost } from '@daftar/inventory';
import type {
  LocaleCode,
  Page,
  PurchaseDeficitCoverageDto,
  PurchaseDto,
  PurchaseLandedCostDto,
  PurchaseLineDto,
  PurchasePayableDto,
  PurchaseRateDto,
  PurchaseReceiptDto,
  PurchaseReturnBlockDto,
  PurchaseReturnOptionLineDto,
  PurchaseReturnOptionsDto,
  PurchaseReversalBlockDto,
  PurchaseReversalLineDto,
  PurchaseReversalResultDto,
  PurchaseSettlementsDto,
  PurchaseStatusDto,
  PurchaseSummaryDto,
  SettlementRateDto,
  SupplierCreditAllocationDto,
  SupplierCreditAllocationResultDto,
  SupplierCreditNoteDto,
  SupplierDto,
  SupplierPayableDto,
  SupplierPaymentAllocationDto,
  SupplierPaymentDto,
  SupplierPaymentResultDto,
  SupplierRefundDto,
  SupplierRefundResultDto,
  SupplierReturnDto,
  SupplierReturnLineDto,
  SupplierReturnResultDto,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { ReadScope } from '../inventory/inventory-stock-read';
import { assertBusinessWide, likeEscaped, quantityText, reachableWarehouses } from '../inventory/read-scope';
import { productNameSql, variantNameSql } from '../inventory/inventory-reads';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal } from './purchasing-errors';
import { payableSql, type PayableRow } from './supplier-balance-reads';
import type {
  PurchaseListQuery,
  SupplierCreditNoteListQuery,
  SupplierListQuery,
  SupplierPaymentListQuery,
  SupplierReturnListQuery,
} from './purchasing.schemas';

/**
 * The READS of suppliers and purchases (PHASE_3_S4_CONTRACT A-10(e), A-19,
 * A-20), all through `daftar_app` under row level security. Nothing here
 * writes: every write is an entry routine's or the accounting primitive's.
 *
 * The command services use the same functions for the idempotency proof (the
 * stored header and its intent digests) and for their answers, which are
 * always read back from stored rows — a replay never recomputes a value.
 *
 * A row of another business is invisible under RLS and reads as not found.
 * AP is derived on read from the ledger's `accounts_payable` lines; there is
 * no stored balance anywhere (A-20).
 */

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_PAGE_SIZE = 20;

export async function scopedRows<T extends QueryResultRow>(db: Database, scope: ReadScope, text: string, params: unknown[]): Promise<T[]> {
  return (await db.scoped<T>({ tenantId: scope.tenantId, businessId: scope.businessId }, text, params)).rows;
}

const iso = (d: Date): string => d.toISOString();
/** A second-precision instant as the ledger writes it: `YYYY-MM-DDTHH:MM:SSZ`. */
const isoSeconds = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;

/** A `NUMERIC` of minor units (up to 10 fraction digits) as MAJOR units of a currency, without trailing zeros. */
export function majorFromMinorText(minorText: string, minorUnits: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(minorText);
  if (m === null) throw new Error('a stored price is not a non-negative decimal');
  const fraction = m[2] ?? '';
  const scale = fraction.length + minorUnits;
  const digits = BigInt(`${m[1] ?? '0'}${fraction}`)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const rest = digits.slice(digits.length - scale).replace(/0+$/, '');
  return rest.length > 0 ? `${whole}.${rest}` : whole;
}

/** A stored rate `NUMERIC(20,10)` as text without trailing zeros (`"1"`, `"3.65"`). */
function rateText(stored: string): string {
  const [whole, fraction = ''] = stored.split('.');
  const rest = fraction.replace(/0+$/, '');
  return rest.length > 0 ? `${whole ?? '0'}.${rest}` : (whole ?? '0');
}

// ── Scope ────────────────────────────────────────────────────────────────

/**
 * The warehouse reach and the business-wide rule live in the shared read
 * scope (PHASE_3_S7_CONTRACT §4.2); `reachableWarehouses` is re-exported so
 * every S4/S5/S6 import keeps working.
 */
export { reachableWarehouses };

function requirePermission(m: MembershipContext, permission: 'suppliers.view' | 'purchases.view'): void {
  if (!hasPermission(m.roles, permission)) throw AppError.forbidden(`Missing permission: ${permission}`);
}

function cursorOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!CANONICAL_UUID_RE.test(value)) throw AppError.validation({ cursor: ['invalid'] });
  return value;
}

function page<T, R>(rows: readonly R[], limit: number, idOf: (r: R) => string, map: (r: R) => T): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: rows.length > limit && last !== undefined ? idOf(last) : null };
}

// ── Suppliers ────────────────────────────────────────────────────────────

export interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tax_identifier: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  revision: number;
  create_intent_sha256: string;
  last_intent_sha256: string;
  business_transaction_id: string;
  created_at: Date;
  updated_at: Date;
}

const SUPPLIER_COLUMNS = `id, name, phone, email, tax_identifier, notes, status, revision, create_intent_sha256, last_intent_sha256,
       business_transaction_id, created_at, updated_at`;

export async function findSupplier(db: Database, scope: ReadScope, supplierId: string): Promise<SupplierRow | null> {
  const [row] = await scopedRows<SupplierRow>(db, scope, `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE business_id = $1 AND id = $2`, [
    scope.businessId,
    supplierId,
  ]);
  return row ?? null;
}

export function supplierDto(r: SupplierRow): SupplierDto {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    taxIdentifier: r.tax_identifier,
    notes: r.notes,
    status: r.status,
    revision: r.revision,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// ── Purchases ────────────────────────────────────────────────────────────

export interface PurchaseHeaderRow {
  id: string;
  supplier_id: string;
  warehouse_id: string;
  currency_code: string;
  document_date: string;
  supplier_reference: string | null;
  notes: string | null;
  status: 'draft' | 'received' | 'cancelled';
  revision: number;
  draft_intent_sha256: string;
  receive_intent_sha256: string | null;
  cancel_intent_sha256: string | null;
  subtotal_txn_minor: string;
  landed_cost_txn_minor: string;
  tax_minor: string;
  total_txn_minor: string;
  total_base_minor: string | null;
  fx_rate_id: string | null;
  source_to_base_rate: string | null;
  rate_source: 'base' | 'manual' | null;
  rate_timestamp: Date | null;
  supplier_name_snapshot: string | null;
  supplier_tax_identifier_snapshot: string | null;
  supplier_phone_snapshot: string | null;
  received_at: Date | null;
  cancelled_at: Date | null;
  business_transaction_id: string;
  created_at: Date;
  updated_at: Date;
  /** The derived `reversed` state (PHASE_3_S5_CONTRACT A-04, TL-2); `status` stays the stored one. */
  reversed: boolean;
}

/**
 * The derived `reversed` state (PHASE_3_S5_CONTRACT A-04, TL-2) as a SQL
 * predicate over `p`: the purchase's entry has its Phase 2 reversal — the
 * AL-12 join (`0046:151-165`) Phase 2 itself answers "is this entry
 * reversed?" with. It holds exactly when a `purchase_reversals` row exists:
 * the reversal guard admits the reversal of a purchase entry only beside its
 * paired row in the same transaction (A-15(b)), that row cannot commit
 * without the reversal's binding (its deferred binding FK, §2.2), and both
 * are insert-only. Reading the pairing on the accounting side keeps the S4
 * reads free of S5 relations. `purchases.status` stays `received`.
 */
const REVERSED_SQL = `EXISTS (SELECT 1
                FROM accounting_source_bindings rb
                JOIN accounting_reversals ar ON ar.business_id = rb.business_id AND ar.original_entry_id = rb.journal_entry_id
               WHERE rb.business_id = p.business_id AND rb.source_type = 'purchase' AND rb.source_id = p.id)`;

const PURCHASE_COLUMNS = `p.id, p.supplier_id, p.warehouse_id, p.currency_code::text AS currency_code, p.document_date::text AS document_date,
       p.supplier_reference, p.notes, p.status, p.revision, p.draft_intent_sha256, p.receive_intent_sha256, p.cancel_intent_sha256,
       p.subtotal_txn_minor::text AS subtotal_txn_minor, p.landed_cost_txn_minor::text AS landed_cost_txn_minor, p.tax_minor::text AS tax_minor,
       p.total_txn_minor::text AS total_txn_minor, p.total_base_minor::text AS total_base_minor, p.fx_rate_id,
       p.source_to_base_rate::text AS source_to_base_rate, p.rate_source, p.rate_timestamp, p.supplier_name_snapshot,
       p.supplier_tax_identifier_snapshot, p.supplier_phone_snapshot, p.received_at, p.cancelled_at, p.business_transaction_id,
       p.created_at, p.updated_at, ${REVERSED_SQL} AS reversed`;

/** The status a purchase reports: the stored one, or the derived `reversed` (TL-2). */
function reportedStatus(r: PurchaseHeaderRow): PurchaseStatusDto {
  return r.reversed ? 'reversed' : r.status;
}

export async function findPurchaseHeader(db: Database, scope: ReadScope, purchaseId: string): Promise<PurchaseHeaderRow | null> {
  const [row] = await scopedRows<PurchaseHeaderRow>(db, scope, `SELECT ${PURCHASE_COLUMNS} FROM purchases p WHERE p.business_id = $1 AND p.id = $2`, [
    scope.businessId,
    purchaseId,
  ]);
  return row ?? null;
}

function summaryDto(r: PurchaseHeaderRow): PurchaseSummaryDto {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    warehouseId: r.warehouse_id,
    currency: r.currency_code,
    documentDate: r.document_date,
    supplierReference: r.supplier_reference,
    status: reportedStatus(r),
    revision: r.revision,
    totalTxnMinor: r.total_txn_minor,
    totalBaseMinor: r.total_base_minor,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function rateDto(r: PurchaseHeaderRow): PurchaseRateDto | null {
  if (r.source_to_base_rate === null || r.rate_source === null || r.rate_timestamp === null) return null;
  return { rateId: r.fx_rate_id, rate: rateText(r.source_to_base_rate), source: r.rate_source, at: isoSeconds(r.rate_timestamp) };
}

/** One stored purchase line with its stock identity. */
export interface PurchaseLineRow {
  id: string;
  line_no: number;
  product_id: string;
  variant_id: string;
  is_base: boolean;
  qty: string;
  unit_price_txn_minor: string;
  gross_txn_minor: string;
  discount_txn_minor: string;
  net_txn_minor: string;
  landed_cost_txn_minor: string;
  base_share_minor: string | null;
  unit_cost_base_minor: string | null;
}

export async function readPurchaseLines(db: Database, scope: ReadScope, purchaseId: string): Promise<PurchaseLineRow[]> {
  return scopedRows<PurchaseLineRow>(
    db,
    scope,
    `SELECT l.id, l.line_no, v.product_id, v.id AS variant_id, v.is_base, l.qty::text AS qty, l.unit_price_txn_minor::text AS unit_price_txn_minor,
            l.gross_txn_minor::text AS gross_txn_minor, l.discount_txn_minor::text AS discount_txn_minor, l.net_txn_minor::text AS net_txn_minor,
            l.landed_cost_txn_minor::text AS landed_cost_txn_minor, l.base_share_minor::text AS base_share_minor,
            l.unit_cost_base_minor::text AS unit_cost_base_minor
       FROM purchase_lines l
       JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
      WHERE l.business_id = $1 AND l.purchase_id = $2
      ORDER BY l.line_no`,
    [scope.businessId, purchaseId],
  );
}

/** One stored landed cost, with its allocation to every line in line order (a missing allocation reads 0). */
export interface LandedCostRow {
  id: string;
  cost_no: number;
  mode: 'by_value' | 'manual';
  amount_txn_minor: string;
  description: string | null;
  allocations: string[];
}

export async function readLandedCosts(db: Database, scope: ReadScope, purchaseId: string, lines: readonly PurchaseLineRow[]): Promise<LandedCostRow[]> {
  const costs = await scopedRows<Omit<LandedCostRow, 'allocations'>>(
    db,
    scope,
    `SELECT id, cost_no, mode, amount_txn_minor::text AS amount_txn_minor, description
       FROM purchase_landed_costs WHERE business_id = $1 AND purchase_id = $2 ORDER BY cost_no`,
    [scope.businessId, purchaseId],
  );
  const allocations = await scopedRows<{ landed_cost_id: string; purchase_line_id: string; amount_txn_minor: string }>(
    db,
    scope,
    `SELECT landed_cost_id, purchase_line_id, amount_txn_minor::text AS amount_txn_minor
       FROM purchase_landed_cost_allocations WHERE business_id = $1 AND purchase_id = $2`,
    [scope.businessId, purchaseId],
  );
  const byKey = new Map(allocations.map((a) => [`${a.landed_cost_id}|${a.purchase_line_id}`, a.amount_txn_minor]));
  return costs.map((c) => ({ ...c, allocations: lines.map((l) => byKey.get(`${c.id}|${l.id}`) ?? '0') }));
}

/** A purchase as stored, and the trace of the operation that last changed it. */
export async function readPurchase(
  db: Database,
  scope: ReadScope,
  purchaseId: string,
): Promise<{ readonly dto: PurchaseDto; readonly header: PurchaseHeaderRow } | null> {
  const header = await findPurchaseHeader(db, scope, purchaseId);
  if (header === null) return null;
  const lines = await readPurchaseLines(db, scope, purchaseId);
  const landed = await readLandedCosts(db, scope, purchaseId, lines);
  const minorUnits = minorUnitsOf(header.currency_code);
  const lineDtos: PurchaseLineDto[] = lines.map((l) => ({
    lineId: l.id,
    lineNo: l.line_no,
    productId: l.product_id,
    variantId: l.is_base ? null : l.variant_id,
    qty: l.qty,
    unitPrice: majorFromMinorText(l.unit_price_txn_minor, minorUnits),
    grossTxnMinor: l.gross_txn_minor,
    discountTxnMinor: l.discount_txn_minor,
    netTxnMinor: l.net_txn_minor,
    landedCostTxnMinor: l.landed_cost_txn_minor,
    baseShareMinor: l.base_share_minor,
    unitCostBaseMinor: l.unit_cost_base_minor,
  }));
  const landedDtos: PurchaseLandedCostDto[] = landed.map((c) => ({
    landedCostId: c.id,
    costNo: c.cost_no,
    mode: c.mode,
    amountTxnMinor: c.amount_txn_minor,
    description: c.description,
    allocations: lines.map((l, i) => ({ lineId: l.id, amountTxnMinor: c.allocations[i] ?? '0' })),
  }));
  const dto: PurchaseDto = {
    ...summaryDto(header),
    notes: header.notes,
    subtotalTxnMinor: header.subtotal_txn_minor,
    landedCostTxnMinor: header.landed_cost_txn_minor,
    taxMinor: header.tax_minor,
    rate: rateDto(header),
    supplierSnapshot:
      header.supplier_name_snapshot === null
        ? null
        : { name: header.supplier_name_snapshot, taxIdentifier: header.supplier_tax_identifier_snapshot, phone: header.supplier_phone_snapshot },
    receivedAt: header.received_at === null ? null : iso(header.received_at),
    cancelledAt: header.cancelled_at === null ? null : iso(header.cancelled_at),
    lines: lineDtos,
    landedCosts: landedDtos,
  };
  return { dto, header };
}

async function entryOf(db: Database, scope: ReadScope, sourceType: string, sourceId: string): Promise<string | null> {
  const [row] = await scopedRows<{ journal_entry_id: string }>(
    db,
    scope,
    'SELECT journal_entry_id FROM accounting_source_bindings WHERE business_id = $1 AND source_type = $2 AND source_id = $3',
    [scope.businessId, sourceType, sourceId],
  );
  return row?.journal_entry_id ?? null;
}

/**
 * The stored result of a receipt (A-10(e)): the header, the lines with their
 * movements, the coverages with theirs, and both entry ids through
 * `accounting_source_bindings`. Stored rows only, for a first answer and for a
 * replay alike.
 */
export async function readReceipt(db: Database, scope: ReadScope, purchaseId: string, replayed: boolean): Promise<PurchaseReceiptDto> {
  const header = await findPurchaseHeader(db, scope, purchaseId);
  const rate = header === null ? null : rateDto(header);
  if (header === null || header.status !== 'received' || header.total_base_minor === null || rate === null) {
    throw new Error('a receipt was read back from a purchase that is not received');
  }
  const lines = await scopedRows<{
    id: string;
    product_id: string;
    variant_id: string;
    is_base: boolean;
    qty: string;
    base_share_minor: string | null;
    unit_cost_base_minor: string | null;
    movement_id: string | null;
  }>(
    db,
    scope,
    `SELECT l.id, v.product_id, v.id AS variant_id, v.is_base, l.qty::text AS qty, l.base_share_minor::text AS base_share_minor,
            l.unit_cost_base_minor::text AS unit_cost_base_minor, m.id AS movement_id
       FROM purchase_lines l
       JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
       LEFT JOIN stock_movements m
         ON m.business_id = l.business_id AND m.source_type = 'purchase' AND m.source_id = l.purchase_id AND m.source_line_id = l.id
      WHERE l.business_id = $1 AND l.purchase_id = $2
      ORDER BY l.line_no`,
    [scope.businessId, purchaseId],
  );
  const [adjustment] = await scopedRows<{ id: string; total_value_base_minor: string }>(
    db,
    scope,
    `SELECT id, total_value_base_minor::text AS total_value_base_minor
       FROM negative_inventory_cost_adjustments
      WHERE business_id = $1 AND origin_source_type = 'purchase' AND origin_source_id = $2`,
    [scope.businessId, purchaseId],
  );
  const coverages =
    adjustment === undefined
      ? []
      : await scopedRows<{
          id: string;
          deficit_id: string;
          qty_covered: string;
          provisional: string;
          actual: string;
          value: string | null;
        }>(
          db,
          scope,
          `SELECT c.id, c.deficit_id, c.qty_covered::text AS qty_covered, c.provisional_unit_cost_base_minor::text AS provisional,
                  c.actual_unit_cost_base_minor::text AS actual, m.value_delta_base_minor::text AS value
             FROM negative_deficit_coverages c
             JOIN negative_inventory_deficits d ON d.business_id = c.business_id AND d.id = c.deficit_id
             JOIN purchase_lines l ON l.business_id = c.business_id AND l.purchase_id = $3 AND l.variant_id = c.variant_id
             LEFT JOIN stock_movements m
               ON m.business_id = c.business_id AND m.source_type = 'negative_inventory_cost_adjustment'
              AND m.source_id = c.adjustment_id AND m.source_line_id = c.id
            WHERE c.business_id = $1 AND c.adjustment_id = $2
            ORDER BY l.line_no, d.deficit_seq, d.id`,
          [scope.businessId, adjustment.id, purchaseId],
        );
  const purchaseEntryId = await entryOf(db, scope, 'purchase', purchaseId);
  if (purchaseEntryId === null) throw new Error('a received purchase has no journal entry');
  const catchUpEntryId = adjustment === undefined ? null : await entryOf(db, scope, 'negative_inventory_cost_adjustment', adjustment.id);
  return {
    purchaseId,
    replayed,
    businessTransactionId: header.business_transaction_id,
    currency: header.currency_code,
    totalTxnMinor: header.total_txn_minor,
    totalBaseMinor: header.total_base_minor,
    rate,
    lines: lines.map((l) => {
      if (l.base_share_minor === null || l.unit_cost_base_minor === null || l.movement_id === null) {
        throw new Error('a received purchase line has no stored share or movement');
      }
      return {
        lineId: l.id,
        productId: l.product_id,
        variantId: l.is_base ? null : l.variant_id,
        qty: l.qty,
        baseShareMinor: l.base_share_minor,
        unitCostBaseMinor: l.unit_cost_base_minor,
        movementId: l.movement_id,
      };
    }),
    coverage:
      adjustment === undefined
        ? null
        : {
            adjustmentId: adjustment.id,
            totalValueBaseMinor: adjustment.total_value_base_minor,
            coverages: coverages.map(
              (c): PurchaseDeficitCoverageDto => ({
                coverageId: c.id,
                deficitId: c.deficit_id,
                qtyCovered: c.qty_covered,
                provisional: c.provisional,
                actual: c.actual,
                valueDeltaBaseMinor: c.value,
              }),
            ),
          },
    purchaseEntryId,
    catchUpEntryId,
  };
}

// ── Supplier returns, credit notes, reversals (P3-S5) ───────────────────
//
// PHASE_3_S5_CONTRACT A-04, A-11, A-17, A-19. Every answer is read back from
// stored rows — a replay never recomputes a value — and every read runs as
// `daftar_app` under row level security. The response shapes are the shared
// contracts (`@daftar/shared-contracts`, purchasing.ts).

/**
 * The settlement state of a received purchase (A-16, A-19): the two S6
 * extension points as the database answers them, and the ledger-derived AP
 * the entries left, side by side. In S5 `outstandingTxnMinor` equals
 * `ledgerOutstandingTxnMinor`, and `ledgerOutstandingBaseMinor` equals
 * `totalBaseMinor − releasedBaseMinor` (T-12). Nothing here is stored
 * (L:1260): every figure is derived on read.
 */
export interface PurchaseSettlementResult {
  purchaseId: string;
  currency: string;
  /** The derived `reversed` state (TL-2). */
  reversed: boolean;
  paymentAllocated: boolean;
  creditAllocated: boolean;
  /** `purchase_ap_outstanding(business, purchase)`, purchase currency. */
  outstandingTxnMinor: string;
  totalTxnMinor: string;
  totalBaseMinor: string;
  /**
   * `Σ rel` over every AP reducer of the purchase: `ap_base_minor` of its
   * returns and `purchase_carrying_base_released_minor` of its S6 payment and
   * credit allocations (A-08, T-19: ledger base AP = `B − Σ rel`).
   */
  releasedBaseMinor: string;
  /** Ledger AP of the purchase in the purchase currency (purchase-currency AP lines only). */
  ledgerOutstandingTxnMinor: string;
  /** Ledger AP of the purchase in base (every AP line, the dust included). */
  ledgerOutstandingBaseMinor: string;
}

interface SupplierReturnHeaderRow {
  id: string;
  purchase_id: string;
  supplier_id: string;
  warehouse_id: string;
  currency_code: string;
  document_date: string;
  reason: string | null;
  credit_note_id: string | null;
  carrying_txn_minor: string;
  ap_txn_minor: string;
  ap_base_minor: string;
  credit_txn_minor: string;
  credit_base_minor: string;
  inventory_value_base_minor: string;
  ppv_base_minor: string;
  business_transaction_id: string;
  created_at: Date;
}

const SUPPLIER_RETURN_COLUMNS = `r.id, r.purchase_id, r.supplier_id, r.warehouse_id, r.currency_code::text AS currency_code,
       r.document_date::text AS document_date, r.reason, r.credit_note_id,
       r.carrying_txn_minor::text AS carrying_txn_minor, r.ap_txn_minor::text AS ap_txn_minor, r.ap_base_minor::text AS ap_base_minor,
       r.credit_txn_minor::text AS credit_txn_minor, r.credit_base_minor::text AS credit_base_minor,
       r.inventory_value_base_minor::text AS inventory_value_base_minor, r.ppv_base_minor::text AS ppv_base_minor,
       r.business_transaction_id, r.created_at`;

/** A stored return's identity for the A-17 proof and the read scope. */
export interface SupplierReturnIdentity {
  readonly purchaseId: string;
  /** The warehouse the goods left. */
  readonly warehouseId: string;
  readonly purchaseWarehouseId: string;
  readonly intentSha256: string;
}

/** A stored return's identity, or null when no return has this id in the business. */
export async function findSupplierReturn(db: Database, scope: ReadScope, returnId: string): Promise<SupplierReturnIdentity | null> {
  const [row] = await scopedRows<{ purchase_id: string; warehouse_id: string; purchase_warehouse_id: string; intent_sha256: string }>(
    db,
    scope,
    `SELECT r.purchase_id, r.warehouse_id, p.warehouse_id AS purchase_warehouse_id, r.intent_sha256
       FROM supplier_returns r
       JOIN purchases p ON p.business_id = r.business_id AND p.id = r.purchase_id
      WHERE r.business_id = $1 AND r.id = $2`,
    [scope.businessId, returnId],
  );
  return row === undefined
    ? null
    : { purchaseId: row.purchase_id, warehouseId: row.warehouse_id, purchaseWarehouseId: row.purchase_warehouse_id, intentSha256: row.intent_sha256 };
}

interface CreditNoteRow {
  id: string;
  supplier_id: string;
  supplier_return_id: string;
  purchase_id: string;
  currency_code: string;
  original_amount_minor: string;
  remaining_amount_minor: string;
  original_carrying_base_amount_minor: string;
  remaining_carrying_base_amount_minor: string;
  source_to_base_rate: string;
  rate_source: 'base' | 'manual';
  rate_timestamp: Date;
  issued_on: string;
  created_at: Date;
}

const CREDIT_NOTE_SELECT = `SELECT n.id, n.supplier_id, n.supplier_return_id, r.purchase_id, n.currency_code::text AS currency_code,
            n.original_amount_minor::text AS original_amount_minor, n.remaining_amount_minor::text AS remaining_amount_minor,
            n.original_carrying_base_amount_minor::text AS original_carrying_base_amount_minor,
            n.remaining_carrying_base_amount_minor::text AS remaining_carrying_base_amount_minor,
            n.source_to_base_rate::text AS source_to_base_rate, n.rate_source, n.rate_timestamp, n.issued_on::text AS issued_on,
            n.created_at
       FROM supplier_credit_notes n
       JOIN supplier_returns r ON r.business_id = n.business_id AND r.id = n.supplier_return_id`;

/** A stored credit note, remaining values as stored (TL-13). A note has no registry rate id: `rateId` is null. */
function creditNoteDto(n: CreditNoteRow): SupplierCreditNoteDto {
  return {
    creditNoteId: n.id,
    supplierId: n.supplier_id,
    returnId: n.supplier_return_id,
    purchaseId: n.purchase_id,
    currency: n.currency_code,
    originalTxnMinor: n.original_amount_minor,
    remainingTxnMinor: n.remaining_amount_minor,
    originalCarryingBaseMinor: n.original_carrying_base_amount_minor,
    remainingCarryingBaseMinor: n.remaining_carrying_base_amount_minor,
    rate: { rateId: null, rate: rateText(n.source_to_base_rate), source: n.rate_source, at: isoSeconds(n.rate_timestamp) },
    issuedOn: n.issued_on,
    createdAt: iso(n.created_at),
  };
}

/** The stored return `returnId` as its read DTO, and its trace id; the answer of a first command, a replay and a read alike. */
async function readSupplierReturnRows(db: Database, scope: ReadScope, returnId: string): Promise<{ readonly dto: SupplierReturnDto; readonly btx: string }> {
  const [header] = await scopedRows<SupplierReturnHeaderRow>(
    db,
    scope,
    `SELECT ${SUPPLIER_RETURN_COLUMNS} FROM supplier_returns r WHERE r.business_id = $1 AND r.id = $2`,
    [scope.businessId, returnId],
  );
  if (header === undefined) throw new Error('a supplier return was read back that is not stored');
  const lines = await scopedRows<{
    id: string;
    line_no: number;
    purchase_line_id: string;
    product_id: string;
    variant_id: string;
    is_base: boolean;
    qty: string;
    carrying_txn_minor: string;
    value_out_base_minor: string;
    movement_id: string | null;
  }>(
    db,
    scope,
    `SELECT l.id, l.line_no, l.purchase_line_id, v.product_id, v.id AS variant_id, v.is_base, l.qty::text AS qty,
            l.carrying_txn_minor::text AS carrying_txn_minor, l.value_out_base_minor::text AS value_out_base_minor, m.id AS movement_id
       FROM supplier_return_lines l
       JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
       LEFT JOIN stock_movements m
         ON m.business_id = l.business_id AND m.source_type = 'supplier_return' AND m.source_id = l.return_id
        AND m.source_line_id = l.id AND m.movement_kind = 'supplier_return'
      WHERE l.business_id = $1 AND l.return_id = $2
      ORDER BY l.line_no`,
    [scope.businessId, returnId],
  );
  const [note] =
    header.credit_note_id === null
      ? []
      : await scopedRows<CreditNoteRow>(db, scope, `${CREDIT_NOTE_SELECT} WHERE n.business_id = $1 AND n.id = $2`, [scope.businessId, header.credit_note_id]);
  if (header.credit_note_id !== null && note === undefined) throw new Error('a supplier return names a credit note that is not stored');
  const entryId = await entryOf(db, scope, 'supplier_return', returnId);
  if (entryId === null) throw new Error('a supplier return has no journal entry');
  const dto: SupplierReturnDto = {
    returnId: header.id,
    purchaseId: header.purchase_id,
    supplierId: header.supplier_id,
    warehouseId: header.warehouse_id,
    documentDate: header.document_date,
    reason: header.reason,
    currency: header.currency_code,
    carryingTxnMinor: header.carrying_txn_minor,
    apTxnMinor: header.ap_txn_minor,
    apBaseMinor: header.ap_base_minor,
    creditTxnMinor: header.credit_txn_minor,
    creditBaseMinor: header.credit_base_minor,
    inventoryValueBaseMinor: header.inventory_value_base_minor,
    purchasePriceVarianceBaseMinor: header.ppv_base_minor,
    lines: lines.map((l): SupplierReturnLineDto => {
      if (l.movement_id === null) throw new Error('a supplier return line has no movement');
      return {
        lineId: l.id,
        lineNo: l.line_no,
        purchaseLineId: l.purchase_line_id,
        productId: l.product_id,
        variantId: l.is_base ? null : l.variant_id,
        qty: l.qty,
        carryingTxnMinor: l.carrying_txn_minor,
        valueOutBaseMinor: l.value_out_base_minor,
        movementId: l.movement_id,
      };
    }),
    creditNote: note === undefined ? null : creditNoteDto(note),
    entryId,
    createdAt: iso(header.created_at),
  };
  return { dto, btx: header.business_transaction_id };
}

/**
 * The stored result of a supplier return command (A-17): the header, the
 * lines with their `supplier_return` movements, the credit note, and the
 * entry id through `accounting_source_bindings`. Stored rows only, for a
 * first answer and for a replay alike.
 */
export async function readSupplierReturnResult(db: Database, scope: ReadScope, returnId: string, replayed: boolean): Promise<SupplierReturnResultDto> {
  const { dto, btx } = await readSupplierReturnRows(db, scope, returnId);
  return { ...dto, replayed, businessTransactionId: btx };
}

/** The stored intent of a purchase's reversal, for the A-17 proof, or null when the purchase is not reversed. */
export async function findPurchaseReversalIntent(db: Database, scope: ReadScope, purchaseId: string): Promise<string | null> {
  const [row] = await scopedRows<{ intent_sha256: string }>(db, scope, 'SELECT intent_sha256 FROM purchase_reversals WHERE business_id = $1 AND id = $2', [
    scope.businessId,
    purchaseId,
  ]);
  return row?.intent_sha256 ?? null;
}

/**
 * The stored result of a purchase reversal (A-17): the header, the lines with
 * their `purchase_reversal` movements in purchase `line_no` order, and the
 * Phase 2 `reversal` entry through `accounting_reversals` (R-B2a).
 */
export async function readPurchaseReversalResult(db: Database, scope: ReadScope, purchaseId: string, replayed: boolean): Promise<PurchaseReversalResultDto> {
  const [header] = await scopedRows<{
    warehouse_id: string;
    reversal_date: string;
    reason: string;
    original_entry_id: string;
    total_value_base_minor: string;
    business_transaction_id: string;
    created_at: Date;
    reversal_entry_id: string | null;
  }>(
    db,
    scope,
    `SELECT r.warehouse_id, r.reversal_date::text AS reversal_date, r.reason, r.original_entry_id,
            r.total_value_base_minor::text AS total_value_base_minor, r.business_transaction_id, r.created_at,
            ar.journal_entry_id AS reversal_entry_id
       FROM purchase_reversals r
       LEFT JOIN accounting_reversals ar ON ar.business_id = r.business_id AND ar.original_entry_id = r.original_entry_id
      WHERE r.business_id = $1 AND r.id = $2`,
    [scope.businessId, purchaseId],
  );
  if (header === undefined) throw new Error('a purchase reversal was read back that is not stored');
  if (header.reversal_entry_id === null) throw new Error('a purchase reversal has no reversal entry');
  const lines = await scopedRows<{
    id: string;
    product_id: string;
    variant_id: string;
    is_base: boolean;
    qty: string;
    value_base_minor: string;
    movement_id: string | null;
  }>(
    db,
    scope,
    `SELECT l.id, v.product_id, v.id AS variant_id, v.is_base, l.qty::text AS qty, l.value_base_minor::text AS value_base_minor, m.id AS movement_id
       FROM purchase_reversal_lines l
       JOIN purchase_lines pl ON pl.business_id = l.business_id AND pl.purchase_id = l.purchase_id AND pl.id = l.id
       JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
       LEFT JOIN stock_movements m
         ON m.business_id = l.business_id AND m.source_type = 'purchase_reversal' AND m.source_id = l.reversal_id
        AND m.source_line_id = l.id AND m.movement_kind = 'purchase_reversal'
      WHERE l.business_id = $1 AND l.reversal_id = $2
      ORDER BY pl.line_no`,
    [scope.businessId, purchaseId],
  );
  return {
    purchaseId,
    warehouseId: header.warehouse_id,
    reversalDate: header.reversal_date,
    reason: header.reason,
    totalValueBaseMinor: header.total_value_base_minor,
    lines: lines.map((l): PurchaseReversalLineDto => {
      if (l.movement_id === null) throw new Error('a purchase reversal line has no movement');
      return {
        lineId: l.id,
        productId: l.product_id,
        variantId: l.is_base ? null : l.variant_id,
        qty: l.qty,
        valueBaseMinor: l.value_base_minor,
        movementId: l.movement_id,
      };
    }),
    originalEntryId: header.original_entry_id,
    reversalEntryId: header.reversal_entry_id,
    createdAt: iso(header.created_at),
    replayed,
    businessTransactionId: header.business_transaction_id,
  };
}

/**
 * The ledger AP of received purchases (S4 A-20, S5 A-19, S6 A-18) is
 * `payableSql` (`supplier-balance-reads.ts`, PHASE_3_S7_CONTRACT A-09(a)):
 * one text for the per-supplier and per-purchase payables, the settlement
 * read and the supplier-balance list, so they cannot diverge (T-05).
 */
const SUPPLIER_PAYABLE_SQL = payableSql({ groupBy: 'currency', filter: 'p.supplier_id = $2' });
const PURCHASE_PAYABLE_SQL = payableSql({ groupBy: 'currency', filter: 'p.id = $2' });

// ── Supplier settlement (P3-S6) ──────────────────────────────────────────
//
// PHASE_3_S6_CONTRACT A-16, A-18. Stored rows only: a first answer, a replay
// and a read are built the same way, and each entry id comes through
// `accounting_source_bindings` (one entry per allocation, credit allocation
// and refund, A-05).

/** `NUMERIC(20,10)` text of a rate of exactly 1: the domestic snapshot. */
const DOMESTIC_RATE_TEXT = '1.0000000000';

/** The FX snapshot a payment or refund binds (A-15), in the payload's and the posting's forms. */
export interface SettlementFx {
  readonly rateId: string | null;
  /** `NUMERIC(20,10)` text. */
  readonly rate: string;
  readonly rateR10: bigint;
  readonly source: 'base' | 'manual';
  /** Second precision: `<date>T00:00:00Z` when domestic, the registry row's `effective_at` otherwise. */
  readonly at: Date;
}

/**
 * The FX snapshot of a payment or a refund at its date (A-15, the S4 A-17
 * rule). Domestic: `(NULL, 1, 'base', <date>T00:00:00Z)`, and the registry is
 * never consulted. Foreign: the registry row `accounting_fx_rate_lookup`
 * returns for `(currency → base)` at the last second of the date in the
 * business's timezone — computed in SQL from the date alone, the instant the
 * routine's `accounting_purchase_fx_rate` reads. An unregistered currency is
 * `purchase.currency_unknown` (§2.6 step 10); a missing rate keeps its
 * accepted accounting code (`accounting.fx_rate_missing`, §3).
 */
export async function readSettlementFx(db: Database, scope: ReadScope, currency: string, baseCurrency: string, date: string): Promise<SettlementFx> {
  if (currency.toUpperCase() === baseCurrency.toUpperCase()) {
    return { rateId: null, rate: DOMESTIC_RATE_TEXT, rateR10: DOMESTIC_RATE_R10, source: 'base', at: new Date(`${date}T00:00:00Z`) };
  }
  let row: { rate_id: string; rate: string; source: string; effective_at: Date } | undefined;
  try {
    [row] = await scopedRows<{ rate_id: string; rate: string; source: string; effective_at: Date }>(
      db,
      scope,
      `SELECT r.rate_id, r.rate::text AS rate, r.source, r.effective_at
         FROM businesses b
        CROSS JOIN LATERAL accounting_fx_rate_lookup(
                b.id, $2, b.base_currency, ((($3::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) r
        WHERE b.id = $1`,
      [scope.businessId, currency, date],
    );
  } catch (e) {
    const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
    if (code === 'accounting.fx_currency_unknown') throw purchasingRefusal('purchase.currency_unknown');
    if (code !== null) throw new AccountingError(code, 'the accounting authority refused this rate lookup', { businessId: scope.businessId });
    throw e;
  }
  if (row === undefined) throw new Error('the FX rate lookup returned no row');
  if (row.source !== 'manual' && row.source !== 'base') throw new Error('a registry rate has a source a settlement cannot snapshot');
  if (row.effective_at.getTime() % 1000 !== 0) throw new Error('a registry rate instant is not at second precision');
  return { rateId: row.rate_id, rate: row.rate, rateR10: parseUnitCost(row.rate), source: row.source, at: row.effective_at };
}

/** A stored `payment_to_base_rate` / `…_to_base_rate` snapshot as the API reports it. */
function settlementRateDto(rate: string, source: 'base' | 'manual', at: Date, rateId: string | null): SettlementRateDto {
  return { rateId, rate: rateText(rate), source, at: isoSeconds(at) };
}

/** The entry of one settlement row, which the completeness trigger guarantees exists once committed. */
async function requiredEntryOf(db: Database, scope: ReadScope, sourceType: string, sourceId: string): Promise<string> {
  const entryId = await entryOf(db, scope, sourceType, sourceId);
  if (entryId === null) throw new Error(`a committed ${sourceType} row has no journal entry`);
  return entryId;
}

interface PaymentAllocationRow {
  id: string;
  payment_id: string;
  line_no: number;
  purchase_id: string;
  warehouse_id: string;
  payment_currency: string;
  payment_amount_minor: string;
  payment_base_amount_minor: string;
  purchase_currency: string;
  purchase_amount_applied_minor: string;
  ap_released_before_txn_minor: string;
  purchase_carrying_base_released_minor: string;
  ap_dust_base_minor: string;
  realized_fx_gain_loss_minor: string;
  payment_date: string;
  journal_entry_id: string | null;
}

const PAYMENT_ALLOCATION_SELECT = `SELECT a.id, a.payment_id, a.line_no, a.purchase_id, p.warehouse_id, a.payment_currency::text AS payment_currency,
            a.payment_amount_minor::text AS payment_amount_minor, a.payment_base_amount_minor::text AS payment_base_amount_minor,
            a.purchase_currency::text AS purchase_currency, a.purchase_amount_applied_minor::text AS purchase_amount_applied_minor,
            a.ap_released_before_txn_minor::text AS ap_released_before_txn_minor,
            a.purchase_carrying_base_released_minor::text AS purchase_carrying_base_released_minor,
            a.ap_dust_base_minor::text AS ap_dust_base_minor, a.realized_fx_gain_loss_minor::text AS realized_fx_gain_loss_minor,
            sp.payment_date::text AS payment_date, b.journal_entry_id
       FROM supplier_payment_allocations a
       JOIN supplier_payments sp ON sp.business_id = a.business_id AND sp.id = a.payment_id
       JOIN purchases p ON p.business_id = a.business_id AND p.id = a.purchase_id
       LEFT JOIN accounting_source_bindings b ON b.business_id = a.business_id AND b.source_type = 'supplier_payment' AND b.source_id = a.id`;

function paymentAllocationDto(a: PaymentAllocationRow): SupplierPaymentAllocationDto {
  if (a.journal_entry_id === null) throw new Error('a committed supplier payment allocation has no journal entry');
  return {
    allocationId: a.id,
    lineNo: a.line_no,
    purchaseId: a.purchase_id,
    paymentCurrency: a.payment_currency,
    paymentAmountMinor: a.payment_amount_minor,
    paymentBaseMinor: a.payment_base_amount_minor,
    purchaseCurrency: a.purchase_currency,
    purchaseAmountAppliedMinor: a.purchase_amount_applied_minor,
    apReleasedBeforeTxnMinor: a.ap_released_before_txn_minor,
    carryingBaseReleasedMinor: a.purchase_carrying_base_released_minor,
    apDustBaseMinor: a.ap_dust_base_minor,
    realizedFxMinor: a.realized_fx_gain_loss_minor,
    entryId: a.journal_entry_id,
  };
}

interface PaymentHeaderRow {
  id: string;
  supplier_id: string;
  payment_method_id: string;
  currency_code: string;
  amount_minor: string;
  base_amount_minor: string;
  payment_to_base_rate: string;
  rate_source: 'base' | 'manual';
  rate_timestamp: Date;
  fx_rate_id: string | null;
  payment_date: string;
  reference: string | null;
  intent_sha256: string;
  business_transaction_id: string;
  created_at: Date;
}

const PAYMENT_HEADER_SELECT = `SELECT sp.id, sp.supplier_id, sp.payment_method_id, sp.currency_code::text AS currency_code, sp.amount_minor::text AS amount_minor,
            sp.base_amount_minor::text AS base_amount_minor, sp.payment_to_base_rate::text AS payment_to_base_rate, sp.rate_source,
            sp.rate_timestamp, sp.fx_rate_id, sp.payment_date::text AS payment_date, sp.reference, sp.intent_sha256,
            sp.business_transaction_id, sp.created_at
       FROM supplier_payments sp`;

/** The stored payment's intent and the warehouses of its purchases (the scope targets, AL-39), or null. */
export async function findSupplierPayment(
  db: Database,
  scope: ReadScope,
  paymentId: string,
): Promise<{ readonly intentSha256: string; readonly warehouseIds: readonly string[] } | null> {
  const [row] = await scopedRows<{ intent_sha256: string; warehouse_ids: string[] }>(
    db,
    scope,
    `SELECT sp.intent_sha256,
            ARRAY(SELECT DISTINCT p.warehouse_id FROM supplier_payment_allocations a
                    JOIN purchases p ON p.business_id = a.business_id AND p.id = a.purchase_id
                   WHERE a.business_id = sp.business_id AND a.payment_id = sp.id)::text[] AS warehouse_ids
       FROM supplier_payments sp
      WHERE sp.business_id = $1 AND sp.id = $2`,
    [scope.businessId, paymentId],
  );
  return row === undefined ? null : { intentSha256: row.intent_sha256, warehouseIds: row.warehouse_ids };
}

/** A stored supplier payment with its allocations in `line_no` order, and its trace id; null when not visible. */
async function readSupplierPaymentRows(
  db: Database,
  scope: ReadScope,
  paymentId: string,
): Promise<{ readonly dto: SupplierPaymentDto; readonly btx: string; readonly warehouseIds: readonly string[] } | null> {
  const [h] = await scopedRows<PaymentHeaderRow>(db, scope, `${PAYMENT_HEADER_SELECT} WHERE sp.business_id = $1 AND sp.id = $2`, [scope.businessId, paymentId]);
  if (h === undefined) return null;
  const allocations = await scopedRows<PaymentAllocationRow>(
    db,
    scope,
    `${PAYMENT_ALLOCATION_SELECT} WHERE a.business_id = $1 AND a.payment_id = $2 ORDER BY a.line_no`,
    [scope.businessId, paymentId],
  );
  const dto: SupplierPaymentDto = {
    paymentId: h.id,
    supplierId: h.supplier_id,
    paymentMethodId: h.payment_method_id,
    currency: h.currency_code,
    amountMinor: h.amount_minor,
    baseAmountMinor: h.base_amount_minor,
    rate: settlementRateDto(h.payment_to_base_rate, h.rate_source, h.rate_timestamp, h.fx_rate_id),
    paymentDate: h.payment_date,
    reference: h.reference,
    allocations: allocations.map(paymentAllocationDto),
    createdAt: iso(h.created_at),
  };
  return { dto, btx: h.business_transaction_id, warehouseIds: [...new Set(allocations.map((a) => a.warehouse_id))] };
}

/** The answer of `POST /v1/supplier-payments` (and of the payment half of receive-and-pay): stored rows only. */
export async function readSupplierPaymentResult(db: Database, scope: ReadScope, paymentId: string, replayed: boolean): Promise<SupplierPaymentResultDto> {
  const found = await readSupplierPaymentRows(db, scope, paymentId);
  if (found === null) throw new Error('a supplier payment the routine wrote is not readable');
  return { ...found.dto, replayed, businessTransactionId: found.btx };
}

interface CreditAllocationRow {
  id: string;
  supplier_id: string;
  credit_note_id: string;
  purchase_id: string;
  allocation_date: string;
  credit_currency: string;
  credit_amount_consumed_minor: string;
  credit_remaining_before_minor: string;
  credit_carrying_base_released_minor: string;
  credit_dust_base_minor: string;
  purchase_currency: string;
  purchase_amount_applied_minor: string;
  ap_released_before_txn_minor: string;
  purchase_carrying_base_released_minor: string;
  ap_dust_base_minor: string;
  realized_fx_gain_loss_minor: string;
  intent_sha256: string;
  business_transaction_id: string;
  created_at: Date;
}

const CREDIT_ALLOCATION_SELECT = `SELECT c.id, c.supplier_id, c.credit_note_id, c.purchase_id, c.allocation_date::text AS allocation_date,
            c.credit_currency::text AS credit_currency, c.credit_amount_consumed_minor::text AS credit_amount_consumed_minor,
            c.credit_remaining_before_minor::text AS credit_remaining_before_minor,
            c.credit_carrying_base_released_minor::text AS credit_carrying_base_released_minor,
            c.credit_dust_base_minor::text AS credit_dust_base_minor, c.purchase_currency::text AS purchase_currency,
            c.purchase_amount_applied_minor::text AS purchase_amount_applied_minor,
            c.ap_released_before_txn_minor::text AS ap_released_before_txn_minor,
            c.purchase_carrying_base_released_minor::text AS purchase_carrying_base_released_minor,
            c.ap_dust_base_minor::text AS ap_dust_base_minor, c.realized_fx_gain_loss_minor::text AS realized_fx_gain_loss_minor,
            c.intent_sha256, c.business_transaction_id, c.created_at
       FROM supplier_credit_allocations c`;

function creditAllocationDto(c: CreditAllocationRow, entryId: string): SupplierCreditAllocationDto {
  return {
    allocationId: c.id,
    supplierId: c.supplier_id,
    creditNoteId: c.credit_note_id,
    purchaseId: c.purchase_id,
    allocationDate: c.allocation_date,
    creditCurrency: c.credit_currency,
    creditAmountConsumedMinor: c.credit_amount_consumed_minor,
    creditRemainingBeforeMinor: c.credit_remaining_before_minor,
    creditCarryingBaseReleasedMinor: c.credit_carrying_base_released_minor,
    creditDustBaseMinor: c.credit_dust_base_minor,
    purchaseCurrency: c.purchase_currency,
    purchaseAmountAppliedMinor: c.purchase_amount_applied_minor,
    apReleasedBeforeTxnMinor: c.ap_released_before_txn_minor,
    carryingBaseReleasedMinor: c.purchase_carrying_base_released_minor,
    apDustBaseMinor: c.ap_dust_base_minor,
    realizedFxMinor: c.realized_fx_gain_loss_minor,
    entryId,
    createdAt: iso(c.created_at),
  };
}

/** The stored credit allocation's intent, or null. */
export async function findCreditAllocationIntent(db: Database, scope: ReadScope, allocationId: string): Promise<string | null> {
  const [row] = await scopedRows<{ intent_sha256: string }>(
    db,
    scope,
    'SELECT intent_sha256 FROM supplier_credit_allocations WHERE business_id = $1 AND id = $2',
    [scope.businessId, allocationId],
  );
  return row?.intent_sha256 ?? null;
}

/** The answer of `POST /v1/supplier-credit-allocations`: stored rows only. */
export async function readCreditAllocationResult(
  db: Database,
  scope: ReadScope,
  allocationId: string,
  replayed: boolean,
): Promise<SupplierCreditAllocationResultDto> {
  const [row] = await scopedRows<CreditAllocationRow>(db, scope, `${CREDIT_ALLOCATION_SELECT} WHERE c.business_id = $1 AND c.id = $2`, [
    scope.businessId,
    allocationId,
  ]);
  if (row === undefined) throw new Error('a supplier credit allocation the routine wrote is not readable');
  const entryId = await requiredEntryOf(db, scope, 'supplier_credit_allocation', allocationId);
  return { ...creditAllocationDto(row, entryId), replayed, businessTransactionId: row.business_transaction_id };
}

interface RefundRow {
  id: string;
  supplier_id: string;
  credit_note_id: string;
  payment_method_id: string;
  refund_date: string;
  reference: string | null;
  source_currency: string;
  source_amount_consumed_minor: string;
  credit_remaining_before_minor: string;
  source_carrying_base_released_minor: string;
  source_dust_base_minor: string;
  receipt_currency: string;
  receipt_amount_minor: string;
  receipt_to_base_rate: string;
  receipt_base_amount_minor: string;
  rate_source: 'base' | 'manual';
  rate_timestamp: Date;
  fx_rate_id: string | null;
  realized_fx_gain_loss_minor: string;
  intent_sha256: string;
  business_transaction_id: string;
  created_at: Date;
}

/** The stored refund's intent, or null. */
export async function findRefundIntent(db: Database, scope: ReadScope, refundId: string): Promise<string | null> {
  const [row] = await scopedRows<{ intent_sha256: string }>(db, scope, 'SELECT intent_sha256 FROM supplier_refunds WHERE business_id = $1 AND id = $2', [
    scope.businessId,
    refundId,
  ]);
  return row?.intent_sha256 ?? null;
}

/** The answer of `POST /v1/supplier-refunds`: stored rows only. */
export async function readRefundResult(db: Database, scope: ReadScope, refundId: string, replayed: boolean): Promise<SupplierRefundResultDto> {
  const [r] = await scopedRows<RefundRow>(
    db,
    scope,
    `SELECT f.id, f.supplier_id, f.credit_note_id, f.payment_method_id, f.refund_date::text AS refund_date, f.reference,
            f.source_currency::text AS source_currency, f.source_amount_consumed_minor::text AS source_amount_consumed_minor,
            f.credit_remaining_before_minor::text AS credit_remaining_before_minor,
            f.source_carrying_base_released_minor::text AS source_carrying_base_released_minor,
            f.source_dust_base_minor::text AS source_dust_base_minor, f.receipt_currency::text AS receipt_currency,
            f.receipt_amount_minor::text AS receipt_amount_minor, f.receipt_to_base_rate::text AS receipt_to_base_rate,
            f.receipt_base_amount_minor::text AS receipt_base_amount_minor, f.rate_source, f.rate_timestamp, f.fx_rate_id,
            f.realized_fx_gain_loss_minor::text AS realized_fx_gain_loss_minor, f.intent_sha256, f.business_transaction_id, f.created_at
       FROM supplier_refunds f
      WHERE f.business_id = $1 AND f.id = $2`,
    [scope.businessId, refundId],
  );
  if (r === undefined) throw new Error('a supplier refund the routine wrote is not readable');
  const dto: SupplierRefundDto = {
    refundId: r.id,
    supplierId: r.supplier_id,
    creditNoteId: r.credit_note_id,
    paymentMethodId: r.payment_method_id,
    refundDate: r.refund_date,
    reference: r.reference,
    sourceCurrency: r.source_currency,
    sourceAmountConsumedMinor: r.source_amount_consumed_minor,
    creditRemainingBeforeMinor: r.credit_remaining_before_minor,
    sourceCarryingBaseReleasedMinor: r.source_carrying_base_released_minor,
    sourceDustBaseMinor: r.source_dust_base_minor,
    receiptCurrency: r.receipt_currency,
    receiptAmountMinor: r.receipt_amount_minor,
    receiptBaseMinor: r.receipt_base_amount_minor,
    rate: settlementRateDto(r.receipt_to_base_rate, r.rate_source, r.rate_timestamp, r.fx_rate_id),
    realizedFxMinor: r.realized_fx_gain_loss_minor,
    entryId: await requiredEntryOf(db, scope, 'supplier_refund', refundId),
    createdAt: iso(r.created_at),
  };
  return { ...dto, replayed, businessTransactionId: r.business_transaction_id };
}

// ── Return options (P3-S7) ───────────────────────────────────────────────

/** Whether anything can go back to the supplier, and if not why: the S5 refusals in their order. */
function returnVerdict(
  header: PurchaseHeaderRow,
  supplierActive: boolean,
  nothingLeft: boolean,
): { readonly returnable: boolean; readonly reason: PurchaseReturnBlockDto | null } {
  let reason: PurchaseReturnBlockDto | null = null;
  if (header.status !== 'received') reason = 'not_received';
  else if (header.reversed) reason = 'reversed';
  else if (!supplierActive) reason = 'supplier_inactive';
  else if (nothingLeft) reason = 'nothing_left';
  return { returnable: reason === null, reason };
}

/** Whether the receipt can be undone, and if not why: the reversal's pre-checks in the service's order. */
function reversalVerdict(
  header: PurchaseHeaderRow,
  state: {
    readonly payment_allocated: boolean;
    readonly credit_allocated: boolean;
    readonly returned: boolean;
    readonly coverage_present: boolean;
    readonly short: boolean;
  },
): { readonly reversible: boolean; readonly reversalReason: PurchaseReversalBlockDto | null } {
  let reason: PurchaseReversalBlockDto | null = null;
  if (header.status !== 'received') reason = 'not_received';
  else if (header.reversed) reason = 'reversed';
  else if (state.payment_allocated) reason = 'payment_allocated';
  else if (state.credit_allocated) reason = 'credit_allocated';
  else if (state.returned) reason = 'returned';
  else if (state.coverage_present) reason = 'deficit_coverage_present';
  else if (state.short) reason = 'insufficient_stock';
  return { reversible: reason === null, reversalReason: reason };
}

// ── The read service ─────────────────────────────────────────────────────

/**
 * `GET /v1/suppliers…` and `GET /v1/purchases…` (A-19, A-20). The route guard
 * has already required the view permission; it is re-checked here, and each
 * read applies its own scope rule:
 *
 * - suppliers are business-wide master data: `suppliers.view` reads them all;
 * - the supplier payable sums every warehouse, so it requires business-wide
 *   branch scope as well (TL-4), enforced here again whatever the caller did;
 * - an assigned-scope member reads only purchases of warehouses they reach;
 *   another purchase reads as not found, so the answer does not reveal it.
 */
@Injectable()
export class PurchasingReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * `GET /v1/suppliers`. P3-S7 (PHASE_3_S7_CONTRACT A-09(d)) adds an optional
   * `search`: an escaped case-insensitive substring of the name, for the
   * supplier picker and the duplicate-name hint. The keyset is unchanged.
   */
  async listSuppliers(m: MembershipContext, q: SupplierListQuery & { readonly search?: string }): Promise<Page<SupplierDto>> {
    requirePermission(m, 'suppliers.view');
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await scopedRows<SupplierRow>(
      this.db,
      m,
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers s
        WHERE s.business_id = $1
          AND ($2::text IS NULL OR s.status = $2)
          AND ($3::uuid IS NULL OR (s.created_at, s.id) < (SELECT c.created_at, c.id FROM suppliers c WHERE c.business_id = $1 AND c.id = $3::uuid))
          AND ($5::text IS NULL OR s.name ILIKE '%' || $5 || '%' ESCAPE '\\')
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [m.businessId, q.status ?? null, cursorOf(q.cursor), limit + 1, q.search === undefined ? null : likeEscaped(q.search)],
    );
    return page(rows, limit, (r) => r.id, supplierDto);
  }

  async getSupplier(m: MembershipContext, id: string): Promise<SupplierDto> {
    requirePermission(m, 'suppliers.view');
    const row = await findSupplier(this.db, m, id);
    if (row === null) throw purchasingRefusal('supplier.not_found');
    return supplierDto(row);
  }

  async supplierPayable(m: MembershipContext, id: string): Promise<SupplierPayableDto> {
    requirePermission(m, 'suppliers.view');
    assertBusinessWide(m);
    if ((await findSupplier(this.db, m, id)) === null) throw purchasingRefusal('supplier.not_found');
    const rows = await scopedRows<PayableRow>(this.db, m, SUPPLIER_PAYABLE_SQL, [m.businessId, id]);
    const base = rows.reduce((a, r) => a + BigInt(r.base_minor), 0n);
    return { supplierId: id, baseMinor: base.toString(10), byCurrency: rows.map((r) => ({ currency: r.currency_code, txnMinor: r.txn_minor })) };
  }

  async listPurchases(m: MembershipContext, q: PurchaseListQuery): Promise<Page<PurchaseSummaryDto>> {
    requirePermission(m, 'purchases.view');
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const reachable = await reachableWarehouses(this.db, m);
    const rows = await scopedRows<PurchaseHeaderRow>(
      this.db,
      m,
      `SELECT ${PURCHASE_COLUMNS} FROM purchases p
        WHERE p.business_id = $1
          AND ($2::text IS NULL OR (CASE WHEN ${REVERSED_SQL} THEN 'reversed' ELSE p.status END) = $2)
          AND ($3::uuid IS NULL OR p.supplier_id = $3::uuid)
          AND ($4::uuid IS NULL OR p.warehouse_id = $4::uuid)
          AND ($5::uuid[] IS NULL OR p.warehouse_id = ANY($5::uuid[]))
          AND ($6::uuid IS NULL OR (p.created_at, p.id) < (SELECT c.created_at, c.id FROM purchases c WHERE c.business_id = $1 AND c.id = $6::uuid))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $7`,
      [m.businessId, q.status ?? null, q.supplierId ?? null, q.warehouseId ?? null, reachable === null ? null : [...reachable], cursorOf(q.cursor), limit + 1],
    );
    return page(rows, limit, (r) => r.id, summaryDto);
  }

  async getPurchase(m: MembershipContext, id: string): Promise<PurchaseDto> {
    requirePermission(m, 'purchases.view');
    const found = await readPurchase(this.db, m, id);
    if (found === null || !(await this.inScope(m, found.header.warehouse_id))) throw purchasingRefusal('purchase.not_found');
    return found.dto;
  }

  async purchasePayable(m: MembershipContext, id: string): Promise<PurchasePayableDto> {
    requirePermission(m, 'purchases.view');
    const header = await findPurchaseHeader(this.db, m, id);
    if (header === null || !(await this.inScope(m, header.warehouse_id))) throw purchasingRefusal('purchase.not_found');
    const rows = await scopedRows<PayableRow>(this.db, m, PURCHASE_PAYABLE_SQL, [m.businessId, id]);
    const [row] = rows;
    if (rows.length > 1 || (row !== undefined && row.currency_code !== header.currency_code)) {
      throw new Error("a purchase's payable was not read in the purchase currency");
    }
    return { purchaseId: id, currency: header.currency_code, outstandingBaseMinor: row?.base_minor ?? '0', outstandingTxnMinor: row?.txn_minor ?? '0' };
  }

  // ── P3-S5 (PHASE_3_S5_CONTRACT A-11, A-16, A-19) ──────────────────────

  /**
   * `GET /v1/purchases/:purchaseId/returns`: the purchase's returns as
   * stored, newest first. `purchases.view` and the purchase's warehouse in
   * scope; an out-of-scope purchase reads as `purchase.not_found`.
   */
  async listPurchaseReturns(m: MembershipContext, purchaseId: string, q: SupplierReturnListQuery): Promise<Page<SupplierReturnDto>> {
    requirePermission(m, 'purchases.view');
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null || !(await this.inScope(m, header.warehouse_id))) throw purchasingRefusal('purchase.not_found');
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await scopedRows<{ id: string }>(
      this.db,
      m,
      `SELECT r.id FROM supplier_returns r
        WHERE r.business_id = $1 AND r.purchase_id = $2
          AND ($3::uuid IS NULL OR (r.created_at, r.id) < (SELECT c.created_at, c.id FROM supplier_returns c WHERE c.business_id = $1 AND c.id = $3::uuid))
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $4`,
      [m.businessId, purchaseId, cursorOf(q.cursor), limit + 1],
    );
    const items: SupplierReturnDto[] = [];
    for (const r of rows.slice(0, limit)) items.push((await readSupplierReturnRows(this.db, m, r.id)).dto);
    const last = rows.slice(0, limit).at(-1);
    return { items, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
  }

  /**
   * `GET /v1/supplier-returns/:returnId`: `purchases.view` and the return's
   * warehouse or the purchase's in scope (A-19). An unknown or out-of-scope
   * return reads as not found, so the answer does not reveal it.
   */
  async getSupplierReturn(m: MembershipContext, returnId: string): Promise<SupplierReturnDto> {
    requirePermission(m, 'purchases.view');
    const found = await findSupplierReturn(this.db, m, returnId);
    const reachable = found === null ? null : await reachableWarehouses(this.db, m);
    if (found === null || (reachable !== null && !reachable.has(found.warehouseId) && !reachable.has(found.purchaseWarehouseId))) {
      throw AppError.notFound();
    }
    return (await readSupplierReturnRows(this.db, m, returnId)).dto;
  }

  /**
   * `GET /v1/suppliers/:supplierId/credit-notes`: the supplier's credit notes
   * as stored, remaining values as stored (TL-13), newest first.
   * `suppliers.view` AND business-wide branch scope (the S4 TL-4 precedent),
   * enforced here whatever the caller did.
   */
  async listSupplierCreditNotes(m: MembershipContext, supplierId: string, q: SupplierCreditNoteListQuery): Promise<Page<SupplierCreditNoteDto>> {
    requirePermission(m, 'suppliers.view');
    assertBusinessWide(m);
    if ((await findSupplier(this.db, m, supplierId)) === null) throw purchasingRefusal('supplier.not_found');
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await scopedRows<CreditNoteRow>(
      this.db,
      m,
      `${CREDIT_NOTE_SELECT}
        WHERE n.business_id = $1 AND n.supplier_id = $2
          AND ($3::uuid IS NULL OR (n.created_at, n.id) < (SELECT c.created_at, c.id FROM supplier_credit_notes c WHERE c.business_id = $1 AND c.id = $3::uuid))
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $4`,
      [m.businessId, supplierId, cursorOf(q.cursor), limit + 1],
    );
    return page(rows, limit, (r) => r.id, creditNoteDto);
  }

  /**
   * The settlement state of a purchase (A-16, A-19, T-12): the two S6
   * extension points, the derived `reversed` state and the ledger AP, side
   * by side. `purchases.view` and the purchase's warehouse in scope.
   */
  async purchaseSettlement(m: MembershipContext, purchaseId: string): Promise<PurchaseSettlementResult> {
    requirePermission(m, 'purchases.view');
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null || !(await this.inScope(m, header.warehouse_id))) throw purchasingRefusal('purchase.not_found');
    const [state] = await scopedRows<{ outstanding: string; payment_allocated: boolean; credit_allocated: boolean; released_base: string }>(
      this.db,
      m,
      `SELECT purchase_ap_outstanding($1, $2)::text AS outstanding, s.payment_allocated, s.credit_allocated,
              ((SELECT coalesce(sum(r.ap_base_minor), 0) FROM supplier_returns r WHERE r.business_id = $1 AND r.purchase_id = $2)
               + (SELECT coalesce(sum(a.purchase_carrying_base_released_minor), 0) FROM supplier_payment_allocations a
                   WHERE a.business_id = $1 AND a.purchase_id = $2)
               + (SELECT coalesce(sum(c.purchase_carrying_base_released_minor), 0) FROM supplier_credit_allocations c
                   WHERE c.business_id = $1 AND c.purchase_id = $2))::text AS released_base
         FROM purchase_settlement_state($1, $2) s`,
      [m.businessId, purchaseId],
    );
    if (state === undefined) throw new Error('the settlement state read returned no row');
    const ledger = await scopedRows<PayableRow>(this.db, m, PURCHASE_PAYABLE_SQL, [m.businessId, purchaseId]);
    const [row] = ledger;
    if (ledger.length > 1 || (row !== undefined && row.currency_code !== header.currency_code)) {
      throw new Error("a purchase's payable was not read in the purchase currency");
    }
    return {
      purchaseId,
      currency: header.currency_code,
      reversed: header.reversed,
      paymentAllocated: state.payment_allocated,
      creditAllocated: state.credit_allocated,
      outstandingTxnMinor: state.outstanding,
      totalTxnMinor: header.total_txn_minor,
      totalBaseMinor: header.total_base_minor ?? '0',
      releasedBaseMinor: state.released_base,
      ledgerOutstandingTxnMinor: row?.txn_minor ?? '0',
      ledgerOutstandingBaseMinor: row?.base_minor ?? '0',
    };
  }

  // ── P3-S6 (PHASE_3_S6_CONTRACT A-18) ─────────────────────────────────

  /**
   * `GET /v1/supplier-payments/:paymentId`: `suppliers.view` and EVERY
   * allocated purchase's warehouse in scope (AL-39). An unknown or partly
   * out-of-scope payment reads as not found, so the answer does not reveal it.
   */
  async getSupplierPayment(m: MembershipContext, paymentId: string): Promise<SupplierPaymentDto> {
    requirePermission(m, 'suppliers.view');
    const found = await readSupplierPaymentRows(this.db, m, paymentId);
    const reachable = found === null ? null : await reachableWarehouses(this.db, m);
    if (found === null || (reachable !== null && found.warehouseIds.some((w) => !reachable.has(w)))) throw AppError.notFound();
    return found.dto;
  }

  /**
   * `GET /v1/suppliers/:supplierId/payments`: the supplier's payments as
   * stored, newest first. They span every warehouse, so `suppliers.view` AND
   * business-wide branch scope (the S5 credit-note precedent).
   */
  async listSupplierPayments(m: MembershipContext, supplierId: string, q: SupplierPaymentListQuery): Promise<Page<SupplierPaymentDto>> {
    requirePermission(m, 'suppliers.view');
    assertBusinessWide(m);
    if ((await findSupplier(this.db, m, supplierId)) === null) throw purchasingRefusal('supplier.not_found');
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await scopedRows<{ id: string }>(
      this.db,
      m,
      `SELECT sp.id FROM supplier_payments sp
        WHERE sp.business_id = $1 AND sp.supplier_id = $2
          AND ($3::uuid IS NULL OR (sp.created_at, sp.id) < (SELECT c.created_at, c.id FROM supplier_payments c WHERE c.business_id = $1 AND c.id = $3::uuid))
        ORDER BY sp.created_at DESC, sp.id DESC
        LIMIT $4`,
      [m.businessId, supplierId, cursorOf(q.cursor), limit + 1],
    );
    const items: SupplierPaymentDto[] = [];
    for (const r of rows.slice(0, limit)) {
      const found = await readSupplierPaymentRows(this.db, m, r.id);
      if (found === null) throw new Error('a listed supplier payment is not readable');
      items.push(found.dto);
    }
    const last = rows.slice(0, limit).at(-1);
    return { items, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
  }

  /**
   * `GET /v1/purchases/:purchaseId/settlements`: the payment allocations and
   * credit allocations applied to the purchase, oldest first (the order of
   * the R-62 chain). `suppliers.view` and the purchase's warehouse in scope.
   */
  async purchaseSettlements(m: MembershipContext, purchaseId: string): Promise<PurchaseSettlementsDto> {
    requirePermission(m, 'suppliers.view');
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null || !(await this.inScope(m, header.warehouse_id))) throw purchasingRefusal('purchase.not_found');
    const payments = await scopedRows<PaymentAllocationRow>(
      this.db,
      m,
      `${PAYMENT_ALLOCATION_SELECT} WHERE a.business_id = $1 AND a.purchase_id = $2 ORDER BY a.ap_released_before_txn_minor, a.id`,
      [m.businessId, purchaseId],
    );
    const credits = await scopedRows<CreditAllocationRow & { journal_entry_id: string | null }>(
      this.db,
      m,
      `SELECT x.*, b.journal_entry_id
         FROM (${CREDIT_ALLOCATION_SELECT} WHERE c.business_id = $1 AND c.purchase_id = $2) x
         LEFT JOIN accounting_source_bindings b ON b.business_id = $1 AND b.source_type = 'supplier_credit_allocation' AND b.source_id = x.id
        ORDER BY x.ap_released_before_txn_minor::numeric, x.id`,
      [m.businessId, purchaseId],
    );
    return {
      purchaseId,
      currency: header.currency_code,
      payments: payments.map((a) => ({ ...paymentAllocationDto(a), paymentId: a.payment_id, paymentDate: a.payment_date })),
      creditAllocations: credits.map((c) => {
        if (c.journal_entry_id === null) throw new Error('a committed supplier credit allocation has no journal entry');
        return creditAllocationDto(c, c.journal_entry_id);
      }),
    };
  }

  // ── P3-S7 (PHASE_3_S7_CONTRACT A-09(c), Annex R #21) ──────────────────

  /**
   * `GET /v1/purchases/:purchaseId/return-options`: what can still go back to
   * the supplier, per line, and whether the receipt can be undone, so the
   * screen can say why before the merchant fills anything in.
   * `purchases.view` and the purchase's warehouse in scope; an out-of-scope
   * purchase reads as `purchase.not_found`. Everything is derived live, in
   * SQL numeric:
   *
   * - `returnedQty` = Σ the line's supplier return lines;
   * - `returnableQty` = `max(0, min(purchased − returned, on hand))`, on hand
   *   in the purchase's warehouse: the two S5 bounds (S5 A-12). A purchase
   *   that is not received, or is reversed, returns nothing: every line reads 0;
   * - `reason` mirrors the S5 refusals in their order: not received,
   *   reversed, supplier inactive, then nothing left on any line;
   * - `reversalReason` mirrors the reversal's pre-checks in the service's
   *   order (S5 A-09, S6 `purchase_settlement_state()`): not received,
   *   reversed, a payment or a credit allocated, returned, a deficit
   *   coverage, then stock short of the purchase in its warehouse. The
   *   reversal command stays the authority; its valuation-residue check is
   *   not anticipated here.
   */
  async returnOptions(m: MembershipContext, purchaseId: string, locale: LocaleCode): Promise<PurchaseReturnOptionsDto> {
    requirePermission(m, 'purchases.view');
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null || !(await this.inScope(m, header.warehouse_id))) throw purchasingRefusal('purchase.not_found');
    const [state] = await scopedRows<{
      supplier_active: boolean;
      payment_allocated: boolean;
      credit_allocated: boolean;
      returned: boolean;
      coverage_present: boolean;
      short: boolean;
    }>(
      this.db,
      m,
      `SELECT s.status = 'active' AS supplier_active, st.payment_allocated, st.credit_allocated,
              EXISTS (SELECT 1 FROM supplier_return_lines rl WHERE rl.business_id = p.business_id AND rl.purchase_id = p.id) AS returned,
              EXISTS (SELECT 1 FROM negative_inventory_cost_adjustments a
                       WHERE a.business_id = p.business_id AND a.origin_source_type = 'purchase' AND a.origin_source_id = p.id) AS coverage_present,
              EXISTS (SELECT 1
                        FROM (SELECT l.variant_id, sum(l.qty) AS qty FROM purchase_lines l
                               WHERE l.business_id = p.business_id AND l.purchase_id = p.id GROUP BY l.variant_id) q
                        LEFT JOIN stock_levels sl ON sl.business_id = p.business_id AND sl.warehouse_id = p.warehouse_id AND sl.variant_id = q.variant_id
                       WHERE coalesce(sl.on_hand, 0) < q.qty) AS short
         FROM purchases p
         JOIN suppliers s ON s.business_id = p.business_id AND s.id = p.supplier_id
        CROSS JOIN LATERAL purchase_settlement_state(p.business_id, p.id) st
        WHERE p.business_id = $1 AND p.id = $2`,
      [m.businessId, purchaseId],
    );
    if (state === undefined) throw purchasingRefusal('purchase.not_found');
    const open = header.status === 'received' && !header.reversed;
    const lines = await scopedRows<{
      id: string;
      product_id: string;
      variant_id: string;
      is_base: boolean;
      name: string;
      variant_name: string | null;
      unit_code: string | null;
      unit_decimals: number | null;
      purchased: string;
      returned: string;
      returnable: string;
      on_hand: string;
      nothing: boolean;
    }>(
      this.db,
      m,
      `SELECT x.id, x.product_id, x.variant_id, x.is_base, x.name, x.variant_name, x.unit_code, x.unit_decimals,
              x.purchased::text AS purchased, x.returned::text AS returned, x.on_hand::text AS on_hand,
              greatest(0, least(x.purchased - x.returned, x.on_hand))::text AS returnable,
              greatest(0, least(x.purchased - x.returned, x.on_hand)) = 0 AS nothing
         FROM (SELECT l.id, v.product_id, v.id AS variant_id, v.is_base, l.line_no,
                      ${productNameSql('pr', '$4::text')} AS name,
                      CASE WHEN v.is_base THEN NULL ELSE ${variantNameSql('v')} END AS variant_name,
                      pr.unit_code, pr.unit_decimals, l.qty AS purchased,
                      coalesce((SELECT sum(rl.qty) FROM supplier_return_lines rl
                                 WHERE rl.business_id = l.business_id AND rl.purchase_line_id = l.id), 0) AS returned,
                      coalesce(sl.on_hand, 0) AS on_hand
                 FROM purchase_lines l
                 JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
                 JOIN products pr ON pr.business_id = v.business_id AND pr.id = v.product_id
                 LEFT JOIN stock_levels sl ON sl.business_id = l.business_id AND sl.warehouse_id = $3 AND sl.variant_id = l.variant_id
                WHERE l.business_id = $1 AND l.purchase_id = $2) x
        ORDER BY x.line_no`,
      [m.businessId, purchaseId, header.warehouse_id, locale],
    );
    const lineDtos = lines.map((l): PurchaseReturnOptionLineDto => {
      const decimals = l.unit_decimals ?? 0;
      return {
        lineId: l.id,
        productId: l.product_id,
        variantId: l.is_base ? null : l.variant_id,
        name: l.name,
        variantName: l.variant_name,
        unitCode: l.unit_code,
        unitDecimals: decimals,
        purchasedQty: quantityText(l.purchased, decimals),
        returnedQty: quantityText(l.returned, decimals),
        returnableQty: quantityText(open ? l.returnable : '0', decimals),
        onHandQty: quantityText(l.on_hand, decimals),
      };
    });
    return {
      purchaseId,
      status: reportedStatus(header),
      reversed: header.reversed,
      supplierActive: state.supplier_active,
      ...returnVerdict(
        header,
        state.supplier_active,
        lines.every((l) => l.nothing),
      ),
      ...reversalVerdict(header, state),
      lines: lineDtos,
    };
  }

  private async inScope(m: MembershipContext, warehouseId: string): Promise<boolean> {
    const reachable = await reachableWarehouses(this.db, m);
    return reachable === null || reachable.has(warehouseId);
  }
}
