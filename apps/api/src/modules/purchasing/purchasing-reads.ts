import { Inject, Injectable } from '@nestjs/common';
import { AppError, hasPermission, minorUnitsOf } from '@daftar/domain-core';
import type {
  Page,
  PurchaseDeficitCoverageDto,
  PurchaseDto,
  PurchaseLandedCostDto,
  PurchaseLineDto,
  PurchasePayableDto,
  PurchaseRateDto,
  PurchaseReceiptDto,
  PurchaseSummaryDto,
  SupplierDto,
  SupplierPayableDto,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal } from './purchasing-errors';
import type { PurchaseListQuery, SupplierListQuery } from './purchasing.schemas';

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
 * The warehouses an assigned-scope member reaches (P3-AL-15/39: through
 * `branch_warehouses`, from an ACTIVE branch in their set), or null for a
 * business-wide member. The same rule the command authority applies.
 */
export async function reachableWarehouses(db: Database, m: MembershipContext): Promise<ReadonlySet<string> | null> {
  if (m.branchScopeMode === 'all') return null;
  const branches = [...m.allowedBranchIds];
  if (branches.length === 0) return new Set();
  const found = await scopedRows<{ warehouse_id: string }>(
    db,
    m,
    `SELECT DISTINCT bw.warehouse_id
       FROM branch_warehouses bw
       JOIN branches b ON b.business_id = bw.business_id AND b.id = bw.branch_id AND b.status = 'active'
      WHERE bw.business_id = $1 AND bw.branch_id = ANY($2::uuid[])`,
    [m.businessId, branches],
  );
  return new Set(found.map((r) => r.warehouse_id));
}

function assertBusinessWide(m: MembershipContext): void {
  if (m.branchScopeMode !== 'all') {
    throw new AppError('FORBIDDEN', 'This read requires business-wide branch scope', 403, { inventoryCode: 'inventory.business_wide_scope_required' });
  }
}

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
}

const PURCHASE_COLUMNS = `p.id, p.supplier_id, p.warehouse_id, p.currency_code::text AS currency_code, p.document_date::text AS document_date,
       p.supplier_reference, p.notes, p.status, p.revision, p.draft_intent_sha256, p.receive_intent_sha256, p.cancel_intent_sha256,
       p.subtotal_txn_minor::text AS subtotal_txn_minor, p.landed_cost_txn_minor::text AS landed_cost_txn_minor, p.tax_minor::text AS tax_minor,
       p.total_txn_minor::text AS total_txn_minor, p.total_base_minor::text AS total_base_minor, p.fx_rate_id,
       p.source_to_base_rate::text AS source_to_base_rate, p.rate_source, p.rate_timestamp, p.supplier_name_snapshot,
       p.supplier_tax_identifier_snapshot, p.supplier_phone_snapshot, p.received_at, p.cancelled_at, p.business_transaction_id,
       p.created_at, p.updated_at`;

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
    status: r.status,
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

/** `Σ credit − Σ debit` in base, and signed txn per currency, over the AP lines of the purchases' `purchase` entries (A-20). */
const PAYABLE_SQL = `SELECT jl.txn_currency, sum(jl.credit_minor - jl.debit_minor)::text AS base_minor,
            sum(CASE WHEN jl.credit_minor > 0 THEN jl.txn_amount_minor ELSE -jl.txn_amount_minor END)::text AS txn_minor
       FROM purchases p
       JOIN accounting_source_bindings b ON b.business_id = p.business_id AND b.source_type = 'purchase' AND b.source_id = p.id
       JOIN journal_lines jl ON jl.business_id = b.business_id AND jl.journal_entry_id = b.journal_entry_id
       JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id AND a.system_key = 'accounts_payable'
      WHERE p.business_id = $1 AND p.status = 'received' AND %FILTER%
      GROUP BY jl.txn_currency
      ORDER BY jl.txn_currency`;

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

  async listSuppliers(m: MembershipContext, q: SupplierListQuery): Promise<Page<SupplierDto>> {
    requirePermission(m, 'suppliers.view');
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await scopedRows<SupplierRow>(
      this.db,
      m,
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers s
        WHERE s.business_id = $1
          AND ($2::text IS NULL OR s.status = $2)
          AND ($3::uuid IS NULL OR (s.created_at, s.id) < (SELECT c.created_at, c.id FROM suppliers c WHERE c.business_id = $1 AND c.id = $3::uuid))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [m.businessId, q.status ?? null, cursorOf(q.cursor), limit + 1],
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
    const rows = await scopedRows<{ txn_currency: string; base_minor: string; txn_minor: string }>(
      this.db,
      m,
      PAYABLE_SQL.replace('%FILTER%', 'p.supplier_id = $2'),
      [m.businessId, id],
    );
    const base = rows.reduce((a, r) => a + BigInt(r.base_minor), 0n);
    return { supplierId: id, baseMinor: base.toString(10), byCurrency: rows.map((r) => ({ currency: r.txn_currency, txnMinor: r.txn_minor })) };
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
          AND ($2::text IS NULL OR p.status = $2)
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
    const rows = await scopedRows<{ txn_currency: string; base_minor: string; txn_minor: string }>(this.db, m, PAYABLE_SQL.replace('%FILTER%', 'p.id = $2'), [
      m.businessId,
      id,
    ]);
    const [row] = rows;
    if (rows.length > 1 || (row !== undefined && row.txn_currency !== header.currency_code)) {
      throw new Error("a purchase's payable lines are not in the purchase currency");
    }
    return { purchaseId: id, currency: header.currency_code, outstandingBaseMinor: row?.base_minor ?? '0', outstandingTxnMinor: row?.txn_minor ?? '0' };
  }

  private async inScope(m: MembershipContext, warehouseId: string): Promise<boolean> {
    const reachable = await reachableWarehouses(this.db, m);
    return reachable === null || reachable.has(warehouseId);
  }
}
