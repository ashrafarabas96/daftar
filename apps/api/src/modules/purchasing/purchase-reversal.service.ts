import { Inject, Injectable } from '@nestjs/common';
import { mintDomainReversalAssertion } from '@daftar/accounting';
import {
  EMPTY_STOCK_STATE,
  formatQuantity,
  InventoryError,
  normalizeDocumentText,
  parseDecimal,
  parseMinor,
  parseQuantity,
  purchaseReverseIntentSha256,
  purchaseReversePayload,
  reversalLineVerdict,
  type PurchaseReverseLine,
  type StockState,
} from '@daftar/inventory';
import type { PurchaseReversalResultDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingLedgerReader } from '../accounting/accounting-ledger.reader';
import { DatabaseAccountingSourcesAdapter } from '../accounting/accounting-sources.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { parseDatabaseInventoryCode } from '../inventory/inventory-errors';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findPurchaseHeader, findPurchaseReversalIntent, readPurchaseReversalResult, scopedRows } from './purchasing-reads';
import type { PurchaseReversalRequest } from './purchasing.schemas';

/** A reason's bound, in characters after trimming (`char_length`, §2.5 step 5). */
const REASON_MAX_CHARS = 500;

/** One purchase line with its stored `purchase` movement, numerics as text. */
interface ReversalStateLine {
  id: string;
  variant_id: string;
  qty: string;
  /** `s_i`: the stored value of the line's `purchase` movement; null if the movement is missing. */
  value: string | null;
  movement_qty: string | null;
}

/** One `stock_levels` row of the purchase warehouse, numerics as text. */
interface ReversalStateLevel {
  variant_id: string;
  on_hand: string;
  valuation: string;
  avg: string | null;
  last_stock_seq: string;
}

/** Everything a reversal checks and binds, read in ONE statement (one snapshot). */
interface ReversalState {
  future: boolean;
  payment_allocated: boolean;
  credit_allocated: boolean;
  returned: boolean;
  coverage_present: boolean;
  original_entry_id: string | null;
  lines: ReversalStateLine[];
  levels: ReversalStateLevel[];
}

/** A signed `NUMERIC(28,10)` average cost as C10 (the `stock_levels` reading of `inventory-stock-read`). */
function parseSignedC10(text: string): bigint {
  const d = parseDecimal(text);
  if (d.scale > 10) throw new Error('an average cost carries more than ten decimals');
  return d.units * 10n ** BigInt(10 - d.scale);
}

/**
 * The catch of the reversal: the purchasing refusal model, plus the two codes
 * the contract names under `purchase_reversal.*` although another layer
 * raises them first (§3):
 *
 * - the package's `inventory.reason_required` (a missing reason, the payload
 *   builder) is `purchase_reversal.reason_required` (422);
 * - the replaced primitive's `inventory.reversal_valuation_residue` (§2.4) is
 *   `purchase_reversal.valuation_residue` (409, TL-8).
 */
function rethrowReversalRefusal(error: unknown): never {
  if (error instanceof InventoryError && error.code === 'inventory.reason_required') throw purchasingRefusal('purchase_reversal.reason_required');
  if (!(error instanceof InventoryError) && parseDatabaseInventoryCode(error) === 'inventory.reversal_valuation_residue') {
    throw purchasingRefusal('purchase_reversal.valuation_residue');
  }
  return rethrowPurchasingRefusal(error);
}

/**
 * `POST /v1/purchases/:purchaseId/reversal` (PHASE_3_S5_CONTRACT A-04 –
 * A-09, A-17, A-20; §2.5; R-B1a, R-B2a).
 *
 * The flow is §4.3's:
 *
 * 1. the stored header — a document read, needed because the scope is the
 *    purchase's warehouse — then authority: `purchases.receive` over that
 *    warehouse (TL-4), before anything is minted;
 * 2. the client intent (`purchase_id`, `warehouse_id`, `reversal_date`, the
 *    reason) and the idempotency proof: the reversal's identity IS the
 *    purchase, so an equal stored intent answers the stored reversal and a
 *    different one is `purchase_reversal.already_reversed` — BEFORE any state
 *    read (A-17);
 * 3. the A-09 pre-checks, in the routine's order, for clean refusals — the
 *    purchase is received, the dates, then (a) payment allocated, (b) credit
 *    allocated, (c) returned, (e) deficit coverage, then per line (d)
 *    insufficient stock and (f) the valuation residue — over one snapshot;
 * 4. the bound values, all fixed at receipt: the original entry, each line's
 *    `(line, variant, qty, s_i)` from its stored `purchase` movement, and
 *    `B`;
 * 5. the original entry read back (`AccountingLedgerReader.readEntry`) and
 *    the Phase 2 reversal assertion minted over its mirror
 *    (`mintDomainReversalAssertion`, R-B2a), with the `invctl/1` assertion
 *    over the `purchase.reverse` payload — both BEFORE seam 2 opens;
 * 6. seam 2: the routine (which writes the paired `purchase_reversals` row
 *    and the inverse movements at `−s_i`), then — unless it answered a
 *    replay — `accounting_post_reversal` through `postReversalInTransaction`,
 *    which the owner-replaced reversal guard admits because the paired row
 *    exists in this transaction (A-15(b)); then COMMIT.
 *
 * A reversal's values cannot race: only its preconditions can change, and
 * the routine refuses each under its lock with its own code, before any
 * write (A-09: never partially unwinds).
 */
@Injectable()
export class PurchaseReversalService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingLedgerReader) private readonly ledger: DatabaseAccountingLedgerReader,
    @Inject(DatabaseAccountingSourcesAdapter) private readonly sources: DatabaseAccountingSourcesAdapter,
  ) {}

  async reverse(m: MembershipContext, purchaseId: string, input: PurchaseReversalRequest, btx: BusinessTransactionId): Promise<PurchaseReversalResultDto> {
    try {
      return await this.run(m, purchaseId, input, btx);
    } catch (e) {
      return rethrowReversalRefusal(e);
    }
  }

  private async run(m: MembershipContext, purchaseId: string, input: PurchaseReversalRequest, btx: BusinessTransactionId): Promise<PurchaseReversalResultDto> {
    const { reversalDate } = input;

    // 1. The document, then authority over its warehouse (TL-4).
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null) throw purchasingRefusal('purchase.not_found');
    const warehouseId = header.warehouse_id;
    const authority = await this.authorization.authorize(m, 'purchase.reverse', btx, [warehouseId]);

    // 2. The client intent, then the idempotency proof — before any state read.
    const reason = normalizeDocumentText(input.reason);
    if (reason === null || [...reason].length > REASON_MAX_CHARS) throw purchasingRefusal('purchase_reversal.reason_required');
    const intentSha256 = purchaseReverseIntentSha256({ tenantId: m.tenantId, businessId: m.businessId, purchaseId, warehouseId, reversalDate, reason });
    const stored = await findPurchaseReversalIntent(this.db, m, purchaseId);
    if (stored !== null) {
      if (stored === intentSha256) return readPurchaseReversalResult(this.db, m, purchaseId, true);
      throw purchasingRefusal('purchase_reversal.already_reversed');
    }

    // 3. The A-09 pre-checks, in the routine's order (§2.5 steps 4–8).
    if (header.status !== 'received' || header.total_base_minor === null) throw purchasingRefusal('purchase.state_invalid');
    if (reversalDate < header.document_date) throw purchasingRefusal('purchase_reversal.date_before_purchase');
    const state = await this.readState(m, purchaseId, warehouseId, reversalDate);
    if (state.future) throw purchasingRefusal('purchase_reversal.date_in_future');
    if (state.payment_allocated) throw purchasingRefusal('purchase_reversal.payment_allocated');
    if (state.credit_allocated) throw purchasingRefusal('purchase_reversal.credit_allocated');
    if (state.returned) throw purchasingRefusal('purchase_reversal.returned');
    if (state.coverage_present) throw purchasingRefusal('purchase_reversal.deficit_coverage_present');
    if (state.original_entry_id === null) throw new Error('a received purchase has no journal entry');
    const originalEntryId = state.original_entry_id;

    // 4. The bound lines: each purchase line and its stored receipt value s_i (R-B1a).
    const lines = state.lines.map((l): PurchaseReverseLine => {
      if (l.value === null || l.movement_qty === null) throw new Error('a received purchase line has no purchase movement');
      const qtyQ4 = parseQuantity(l.qty);
      if (parseQuantity(l.movement_qty) !== qtyQ4) throw new Error("a purchase movement does not carry its line's quantity");
      return { lineId: l.id, variantId: l.variant_id, qtyQ4, valueMinor: parseMinor(l.value) };
    });
    const totalValueMinor = parseMinor(header.total_base_minor);
    if (lines.reduce((a, l) => a + l.valueMinor, 0n) !== totalValueMinor) throw new Error("a purchase's movement values do not add up to its base total");
    const levels = new Map(state.levels.map((l) => [l.variant_id, l]));
    for (const l of lines) {
      const verdict = reversalLineVerdict(this.stockState(levels.get(l.variantId)), l.qtyQ4, l.valueMinor);
      if (verdict.verdict === 'insufficient_stock') throw purchasingRefusal('purchase_reversal.insufficient_stock');
      if (verdict.verdict === 'valuation_residue') throw purchasingRefusal('purchase_reversal.valuation_residue');
    }
    const built = purchaseReversePayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      purchaseId,
      warehouseId,
      reversalDate,
      reason,
      originalEntryId,
      totalValueMinor,
      lines,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound reversal payload does not carry the proven intent');

    // 5. The original entry as persisted, and both assertions, before the seam opens (A-06, A-08).
    const original = await this.ledger.readEntry({ tenantId: m.tenantId, businessId: m.businessId }, originalEntryId);
    if (original === null) throw new Error("a received purchase's journal entry is not readable");
    const reversalAssertion = mintDomainReversalAssertion(this.accountingMinter, original, reversalDate, m.userId);
    const inventoryAssertion = this.authorization.mint(authority, built.payload);

    // 6. One transaction: the routine, the Phase 2 reversal, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, [reversalAssertion], async (tx) => {
      const r = await tx.query<{ replayed: boolean }>(
        `SELECT replayed FROM purchase_reverse(
           $1::uuid, $2::uuid, $3::date, $4::text, $5::uuid, $6::bigint, $7::uuid[], $8::uuid[], $9::numeric[], $10::bigint[])`,
        [
          purchaseId,
          warehouseId,
          reversalDate,
          reason,
          originalEntryId,
          totalValueMinor.toString(10),
          lines.map((l) => l.lineId),
          lines.map((l) => l.variantId),
          lines.map((l) => formatQuantity(l.qtyQ4)),
          lines.map((l) => l.valueMinor.toString(10)),
        ],
      );
      const [first] = r.rows;
      if (first === undefined) throw new Error('purchase_reverse returned no row');
      // A replay inside the routine (a concurrent identical reversal won the
      // purchase key) commits no entry; its minted assertion expires unused (A-08).
      if (first.replayed) return true;
      await this.sources.postReversalInTransaction(tx.accounting, {
        businessId: m.businessId,
        originalEntryId,
        entryDate: reversalDate,
        reason,
        requestId: btx,
      });
      return false;
    });
    return readPurchaseReversalResult(this.db, m, purchaseId, replayed);
  }

  /** A `stock_levels` row as the package's state; a key with no row is the empty state. */
  private stockState(level: ReversalStateLevel | undefined): StockState {
    if (level === undefined) return EMPTY_STOCK_STATE;
    return {
      onHand: parseQuantity(level.on_hand),
      valuation: parseMinor(level.valuation),
      avg: level.avg === null ? null : parseSignedC10(level.avg),
      lastStockSeq: BigInt(level.last_stock_seq),
    };
  }

  /**
   * The A-09 state of a received purchase in ONE statement, read by
   * `daftar_app` under RLS: whether the reversal date is after today in the
   * business's timezone, the two S6 extension points
   * (`purchase_settlement_state`, A-16), whether a return or a deficit
   * coverage references it, its journal entry, its lines with their stored
   * `purchase` movements in `line_no` order, and the purchase warehouse's
   * `stock_levels` of its variants.
   */
  private async readState(scope: ReadScope, purchaseId: string, warehouseId: string, reversalDate: string): Promise<ReversalState> {
    const [row] = await scopedRows<ReversalState>(
      this.db,
      scope,
      `SELECT ($4::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              st.payment_allocated, st.credit_allocated,
              EXISTS (SELECT 1 FROM supplier_return_lines rl WHERE rl.business_id = p.business_id AND rl.purchase_id = p.id) AS returned,
              EXISTS (SELECT 1 FROM negative_inventory_cost_adjustments a
                       WHERE a.business_id = p.business_id AND a.origin_source_type = 'purchase' AND a.origin_source_id = p.id) AS coverage_present,
              (SELECT sb.journal_entry_id FROM accounting_source_bindings sb
                WHERE sb.business_id = p.business_id AND sb.source_type = 'purchase' AND sb.source_id = p.id) AS original_entry_id,
              (SELECT coalesce(json_agg(json_build_object(
                        'id', l.id, 'variant_id', l.variant_id, 'qty', l.qty::text,
                        'value', mv.value_delta_base_minor::text, 'movement_qty', mv.qty_delta::text) ORDER BY l.line_no), '[]'::json)
                 FROM purchase_lines l
                 LEFT JOIN stock_movements mv
                   ON mv.business_id = l.business_id AND mv.source_type = 'purchase' AND mv.source_id = l.purchase_id
                  AND mv.source_line_id = l.id AND mv.movement_kind = 'purchase'
                WHERE l.business_id = p.business_id AND l.purchase_id = p.id) AS lines,
              (SELECT coalesce(json_agg(json_build_object(
                        'variant_id', sl.variant_id, 'on_hand', sl.on_hand::text, 'valuation', sl.valuation_base_minor::text,
                        'avg', sl.avg_unit_cost_base_minor::text, 'last_stock_seq', sl.last_stock_seq::text)), '[]'::json)
                 FROM stock_levels sl
                WHERE sl.business_id = p.business_id AND sl.warehouse_id = $3
                  AND sl.variant_id IN (SELECT l.variant_id FROM purchase_lines l WHERE l.business_id = p.business_id AND l.purchase_id = p.id)) AS levels
         FROM purchases p
         JOIN businesses b ON b.id = p.business_id
        CROSS JOIN LATERAL purchase_settlement_state(p.business_id, p.id) st
        WHERE p.business_id = $1 AND p.id = $2`,
      [scope.businessId, purchaseId, warehouseId, reversalDate],
    );
    if (row === undefined) throw purchasingRefusal('purchase.not_found');
    return row;
  }
}
