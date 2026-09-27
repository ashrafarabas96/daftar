import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { convertToBaseMinor, mintDomainPostingAssertion } from '@daftar/accounting';
import {
  assertQuantityRepresentable,
  EMPTY_STOCK_STATE,
  formatQuantity,
  InventoryError,
  MAX_DOCUMENT_LINES,
  normalizeDocumentText,
  parseDecimal,
  parseMinor,
  parseQuantity,
  planSupplierReturn,
  supplierReturnIntentSha256,
  supplierReturnPayload,
  type StockState,
  type SupplierReturnIntentLine,
} from '@daftar/inventory';
import type { SupplierReturnResultDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { supplierReturnPostingCommand } from './purchase-return-posting';
import { purchasingInventoryRefusal, purchasingPackageRefusal, purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findSupplierReturn, readSupplierReturnResult, scopedRows } from './purchasing-reads';
import type { SupplierReturnRequest } from './purchasing.schemas';

/** A reason's bound, in characters after trimming (`char_length`, §2.5 step 5). */
const REASON_MAX_CHARS = 500;

/** One purchase line of the state read, numerics as text. */
interface ReturnStateLine {
  id: string;
  line_no: number;
  variant_id: string;
  qty: string;
  net: string;
  landed: string;
  /** `Q_i`: Σ of the line's quantity earlier returns took. */
  returned: string;
  track_inventory: boolean;
  unit_decimals: number | null;
  product_status: string;
  variant_status: string;
}

/** One `stock_levels` row of the return warehouse, numerics as text. */
interface ReturnStateLevel {
  variant_id: string;
  on_hand: string;
  valuation: string;
  avg: string | null;
  last_stock_seq: string;
}

/** Everything a return binds, read in ONE statement (one snapshot, review L3). */
interface ReturnState {
  status: string;
  reversed: boolean;
  supplier_status: string;
  currency_code: string;
  document_date: string;
  total_txn_minor: string;
  total_base_minor: string | null;
  rate: string | null;
  rate_source: 'base' | 'manual' | null;
  rate_timestamp: Date | null;
  base_currency: string;
  future: boolean;
  purchase_branch_id: string;
  return_branch_id: string | null;
  return_warehouse_status: string | null;
  outstanding: string;
  lines: ReturnStateLine[];
  levels: ReturnStateLevel[];
}

/** A signed `NUMERIC(28,10)` average cost as C10 (the `stock_levels` reading of `inventory-stock-read`). */
function parseSignedC10(text: string): bigint {
  const d = parseDecimal(text);
  if (d.scale > 10) throw new Error('an average cost carries more than ten decimals');
  return d.units * 10n ** BigInt(10 - d.scale);
}

/**
 * `POST /v1/purchases/:purchaseId/returns` (PHASE_3_S5_CONTRACT A-04, A-05 –
 * A-08, A-10 – A-13, A-17, A-20; §2.5).
 *
 * The flow is §4.3's, with the A-07 binding:
 *
 * 1. authority: `purchases.return` over the RETURN warehouse only — the one
 *    the goods leave (TL-5). It reads membership, never document or stock
 *    state, and refuses with 403 before anything is minted (Must-prove 3);
 * 2. the client intent (`return_id`, `purchase_id`, `warehouse_id`,
 *    `document_date`, the reason, the lines) and the idempotency proof
 *    against the stored return — a replay answers its stored rows, a
 *    different intent is `supplier_return.idempotency_conflict` — BEFORE any
 *    state read (A-17);
 * 3. current state in ONE statement: the purchase, its lines with the
 *    quantity earlier returns took, `purchase_ap_outstanding` (A-16), the
 *    supplier, the business's base currency and "today", both warehouses and
 *    the return warehouse's `stock_levels` — one snapshot, so the AP and the
 *    levels the amounts are bound from are of the same committed state (the
 *    S4 receipt's review L3);
 * 4. every amount the database will store, bound: `planSupplierReturn` (the
 *    cumulative carrying value, AP first, the base release and the TL-3 dust,
 *    the values out at the return key's average, PPV), with the 0043
 *    conversion (`convertToBaseMinor`) at the purchase's snapshot rate — never
 *    a new lookup; a credit-note id is minted here iff a credit is issued;
 * 5. the `invctl/1` assertion over the `purchase.return` payload and ONE
 *    accounting assertion over the `supplier_return` entry, both minted
 *    BEFORE seam 2 opens (A-07, A-08);
 * 6. seam 2: the routine, then — unless it answered a replay — the entry,
 *    then COMMIT with the deferred guards.
 *
 * The return is optimistic: if the average or the AP moved between the read
 * and the routine's locks, the routine refuses `inventory.valuation_changed`
 * (409, retry the same body) and nothing commits. There is no server retry.
 */
@Injectable()
export class PurchaseReturnService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async createReturn(m: MembershipContext, purchaseId: string, input: SupplierReturnRequest, btx: BusinessTransactionId): Promise<SupplierReturnResultDto> {
    try {
      return await this.run(m, purchaseId, input, btx);
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async run(m: MembershipContext, purchaseId: string, input: SupplierReturnRequest, btx: BusinessTransactionId): Promise<SupplierReturnResultDto> {
    const { returnId, warehouseId, documentDate } = input;

    // 1. Authority over the warehouse the goods leave, and over it only (TL-5).
    const authority = await this.authorization.authorize(m, 'purchase.return', btx, [warehouseId]);

    // 2. The client intent, then the idempotency proof — before any state read.
    const reason = normalizeDocumentText(input.reason);
    if (reason !== null && [...reason].length > REASON_MAX_CHARS) throw purchasingRefusal('supplier_return.lines_invalid');
    const intentLines = this.intentLines(input);
    const intentSha256 = supplierReturnIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      returnId,
      purchaseId,
      warehouseId,
      documentDate,
      reason,
      lines: intentLines,
    });
    const existing = await findSupplierReturn(this.db, m, returnId);
    if (existing !== null) {
      if (existing.intentSha256 === intentSha256) return readSupplierReturnResult(this.db, m, returnId, true);
      throw purchasingRefusal('supplier_return.idempotency_conflict');
    }

    // 3. Current state, in one snapshot, and the routine's refusals in its order (§2.5 steps 6–9).
    const state = await this.readState(m, purchaseId, warehouseId, documentDate);
    if (state === null) throw purchasingRefusal('purchase.not_found');
    if (state.status !== 'received') throw purchasingRefusal('supplier_return.purchase_state_invalid');
    if (state.reversed) throw purchasingRefusal('supplier_return.purchase_reversed');
    if (state.total_base_minor === null || state.rate === null || state.rate_source === null || state.rate_timestamp === null) {
      throw new Error('a received purchase has no stored base total or FX snapshot');
    }
    if (documentDate < state.document_date) throw purchasingRefusal('supplier_return.date_before_purchase');
    if (state.future) throw purchasingRefusal('supplier_return.document_date_in_future');
    if (state.return_branch_id === null) throw purchasingInventoryRefusal('inventory.warehouse_not_found');
    if (state.return_warehouse_status !== 'active') throw purchasingInventoryRefusal('inventory.warehouse_archived');
    const byLine = new Map(state.lines.map((l) => [l.id, l]));
    const lines = intentLines.map((l) => {
      const line = byLine.get(l.purchaseLineId);
      if (line === undefined) throw purchasingRefusal('supplier_return.lines_invalid');
      return { intent: l, line };
    });
    for (const { intent, line } of lines) this.assertLeavable(line, intent.qtyQ4);

    // 4. Every stored amount, bound (A-07, A-10).
    const levels = new Map(state.levels.map((l) => [l.variant_id, l]));
    const currency = state.currency_code;
    const baseCurrency = state.base_currency;
    const rate = state.rate;
    const plan = planSupplierReturn({
      totalTxnMinor: parseMinor(state.total_txn_minor),
      totalBaseMinor: parseMinor(state.total_base_minor),
      outstandingTxnMinor: parseMinor(state.outstanding),
      convert: (txnAmountMinor) => convertToBaseMinor({ txnAmountMinor, txnCurrency: currency, baseCurrency, fxRate: rate }),
      lines: lines.map(({ intent, line }) => ({
        lineTotalTxnMinor: parseMinor(line.net) + parseMinor(line.landed),
        purchasedQ4: parseQuantity(line.qty),
        returnedBeforeQ4: parseQuantity(line.returned),
        returnQ4: intent.qtyQ4,
        stock: this.stockState(levels.get(line.variant_id)),
      })),
    });
    // TL-14: an inactive supplier may take goods back against AP, never a new credit (AL-40).
    if (state.supplier_status !== 'active' && plan.creditTxnMinor > 0n) throw purchasingRefusal('supplier_return.supplier_inactive');
    const creditNoteId = plan.creditNote ? randomUUID() : null;
    const payloadLines = lines.map(({ intent, line }, i) => {
      const planned = plan.lines[i];
      if (planned === undefined) throw new Error('the return plan lost a line');
      return { ...intent, variantId: line.variant_id, carryingTxnMinor: planned.carryingTxnMinor, valueOutMinor: planned.valueOutMinor };
    });
    const built = supplierReturnPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      returnId,
      purchaseId,
      warehouseId,
      documentDate,
      reason,
      creditNoteId,
      carryingTxnMinor: plan.carryingTxnMinor,
      apTxnMinor: plan.apTxnMinor,
      apBaseMinor: plan.apBaseMinor,
      creditTxnMinor: plan.creditTxnMinor,
      creditBaseMinor: plan.creditBaseMinor,
      inventoryValueMinor: plan.inventoryValueMinor,
      ppvMinor: plan.ppvMinor,
      lines: payloadLines,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound return payload does not carry the proven intent');

    // 5. Mint both assertions before the seam opens (A-07, A-08): one entry, one accounting assertion.
    const command = supplierReturnPostingCommand({
      tenantId: m.tenantId,
      businessId: m.businessId,
      returnId,
      documentDate,
      currency,
      baseCurrency,
      fx: { rate, source: state.rate_source, at: state.rate_timestamp },
      purchaseBranchId: state.purchase_branch_id,
      returnWarehouseId: warehouseId,
      returnBranchId: state.return_branch_id,
      lines: plan.entryLines,
      businessTransactionId: btx,
    });
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const accountingAssertion = mintDomainPostingAssertion(this.accountingMinter, command, m.userId);

    // 6. One transaction: the routine, the entry, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, [accountingAssertion], async (tx) => {
      const r = await tx.query<{ replayed: boolean }>(
        `SELECT replayed FROM purchase_return(
           $1::uuid, $2::uuid, $3::uuid, $4::date, $5::text, $6::uuid, $7::bigint, $8::bigint, $9::bigint, $10::bigint,
           $11::bigint, $12::bigint, $13::bigint, $14::uuid[], $15::uuid[], $16::uuid[], $17::numeric[], $18::bigint[], $19::bigint[])`,
        [
          returnId,
          purchaseId,
          warehouseId,
          documentDate,
          reason,
          creditNoteId,
          plan.carryingTxnMinor.toString(10),
          plan.apTxnMinor.toString(10),
          plan.apBaseMinor.toString(10),
          plan.creditTxnMinor.toString(10),
          plan.creditBaseMinor.toString(10),
          plan.inventoryValueMinor.toString(10),
          plan.ppvMinor.toString(10),
          payloadLines.map((l) => l.returnLineId),
          payloadLines.map((l) => l.purchaseLineId),
          payloadLines.map((l) => l.variantId),
          payloadLines.map((l) => formatQuantity(l.qtyQ4)),
          payloadLines.map((l) => l.carryingTxnMinor.toString(10)),
          payloadLines.map((l) => l.valueOutMinor.toString(10)),
        ],
      );
      const [first] = r.rows;
      if (first === undefined) throw new Error('purchase_return returned no row');
      // A replay inside the routine (a concurrent identical return won the
      // key) commits no entry; its minted assertion expires unused (A-08).
      if (first.replayed) return true;
      await this.posting.postEntryInTransaction(tx.accounting, { command });
      return false;
    });
    return readSupplierReturnResult(this.db, m, returnId, replayed);
  }

  /**
   * The request's lines as the intent binds them, in request order (the
   * return's `line_no`), after the §2.5 step 5 shape rule: 1..200 lines,
   * distinct line ids and purchase lines, positive quantities — else
   * `supplier_return.lines_invalid`, before anything is digested.
   */
  private intentLines(input: SupplierReturnRequest): SupplierReturnIntentLine[] {
    const lines = input.lines;
    if (lines.length === 0 || lines.length > MAX_DOCUMENT_LINES) throw purchasingRefusal('supplier_return.lines_invalid');
    if (new Set(lines.map((l) => l.lineId)).size !== lines.length || new Set(lines.map((l) => l.purchaseLineId)).size !== lines.length) {
      throw purchasingRefusal('supplier_return.lines_invalid');
    }
    return lines.map((l) => {
      const qtyQ4 = parseQuantity(l.quantity);
      if (qtyQ4 <= 0n) throw purchasingRefusal('supplier_return.lines_invalid');
      return { returnLineId: l.lineId, purchaseLineId: l.purchaseLineId, qtyQ4 };
    });
  }

  /**
   * The S3 A-19 re-checks of stock going OUT that the routine's lock step 6
   * repeats (`inventory.variant_archived` for the variant or its product,
   * `inventory.product_not_tracked`), and the unit precision the primitive
   * checks (`inventory.quantity_precision_invalid`), as clean refusals before
   * anything is minted.
   */
  private assertLeavable(line: ReturnStateLine, qtyQ4: bigint): void {
    if (line.product_status !== 'active' || line.variant_status !== 'active') throw purchasingInventoryRefusal('inventory.variant_archived');
    if (!line.track_inventory || line.unit_decimals === null) throw purchasingInventoryRefusal('inventory.product_not_tracked');
    try {
      assertQuantityRepresentable(qtyQ4, line.unit_decimals);
    } catch (e) {
      if (e instanceof InventoryError) throw purchasingPackageRefusal(e);
      throw e;
    }
  }

  /** A `stock_levels` row as the package's state; a key with no row is the empty state. */
  private stockState(level: ReturnStateLevel | undefined): StockState {
    if (level === undefined) return EMPTY_STOCK_STATE;
    return {
      onHand: parseQuantity(level.on_hand),
      valuation: parseMinor(level.valuation),
      avg: level.avg === null ? null : parseSignedC10(level.avg),
      lastStockSeq: BigInt(level.last_stock_seq),
    };
  }

  /**
   * The purchase, its lines with `Q_i`, `purchase_ap_outstanding` (A-16), the
   * supplier's status, the business's base currency and "today", the purchase
   * warehouse's home branch, the return warehouse and its `stock_levels` for
   * the purchase's variants — in ONE statement, read by `daftar_app` under
   * RLS. Under READ COMMITTED a statement reads one snapshot, so the AP and
   * the averages the amounts are bound from belong to one committed state; a
   * change after this read is the routine's to refuse under its locks. Null
   * when the purchase is not visible.
   */
  private async readState(scope: ReadScope, purchaseId: string, warehouseId: string, documentDate: string): Promise<ReturnState | null> {
    const [row] = await scopedRows<ReturnState>(
      this.db,
      scope,
      `SELECT p.status, EXISTS (SELECT 1 FROM purchase_reversals x WHERE x.business_id = p.business_id AND x.id = p.id) AS reversed,
              s.status AS supplier_status, p.currency_code::text AS currency_code, p.document_date::text AS document_date,
              p.total_txn_minor::text AS total_txn_minor, p.total_base_minor::text AS total_base_minor,
              p.source_to_base_rate::text AS rate, p.rate_source, p.rate_timestamp,
              b.base_currency, ($4::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              pw.branch_id AS purchase_branch_id, rw.branch_id AS return_branch_id, rw.status AS return_warehouse_status,
              purchase_ap_outstanding(p.business_id, p.id)::text AS outstanding,
              (SELECT coalesce(json_agg(json_build_object(
                        'id', l.id, 'line_no', l.line_no, 'variant_id', l.variant_id, 'qty', l.qty::text,
                        'net', l.net_txn_minor::text, 'landed', l.landed_cost_txn_minor::text,
                        'returned', (SELECT coalesce(sum(rl.qty), 0)::text FROM supplier_return_lines rl
                                      WHERE rl.business_id = l.business_id AND rl.purchase_id = l.purchase_id AND rl.purchase_line_id = l.id),
                        'track_inventory', pr.track_inventory, 'unit_decimals', pr.unit_decimals,
                        'product_status', pr.status, 'variant_status', v.status) ORDER BY l.line_no), '[]'::json)
                 FROM purchase_lines l
                 JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
                 JOIN products pr ON pr.business_id = v.business_id AND pr.id = v.product_id
                WHERE l.business_id = p.business_id AND l.purchase_id = p.id) AS lines,
              (SELECT coalesce(json_agg(json_build_object(
                        'variant_id', sl.variant_id, 'on_hand', sl.on_hand::text, 'valuation', sl.valuation_base_minor::text,
                        'avg', sl.avg_unit_cost_base_minor::text, 'last_stock_seq', sl.last_stock_seq::text)), '[]'::json)
                 FROM stock_levels sl
                WHERE sl.business_id = p.business_id AND sl.warehouse_id = $3
                  AND sl.variant_id IN (SELECT l.variant_id FROM purchase_lines l WHERE l.business_id = p.business_id AND l.purchase_id = p.id)) AS levels
         FROM purchases p
         JOIN businesses b ON b.id = p.business_id
         JOIN suppliers s ON s.business_id = p.business_id AND s.id = p.supplier_id
         JOIN warehouses pw ON pw.business_id = p.business_id AND pw.id = p.warehouse_id
         LEFT JOIN warehouses rw ON rw.business_id = p.business_id AND rw.id = $3
        WHERE p.business_id = $1 AND p.id = $2`,
      [scope.businessId, purchaseId, warehouseId, documentDate],
    );
    return row ?? null;
  }
}
