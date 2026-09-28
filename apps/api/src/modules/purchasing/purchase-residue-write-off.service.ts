import { Inject, Injectable } from '@nestjs/common';
import { mintDomainPostingAssertion } from '@daftar/accounting';
import {
  InventoryError,
  normalizeDocumentText,
  parseMinor,
  parseUnitCost,
  planResidueWriteOff,
  purchaseResidueWriteOffIntentSha256,
  purchaseResidueWriteOffPayload,
  REASON_MAX_CHARS,
} from '@daftar/inventory';
import type { PurchaseResidueWriteOffResultDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findPurchaseHeader, findResidueWriteOffIntent, readResidueWriteOffResult, scopedRows } from './purchasing-reads';
import type { PurchaseResidueWriteOffRequest } from './purchasing.schemas';
import { PURCHASE_RESIDUE_WRITE_OFF_SOURCE, settlementPostingCommand } from './supplier-settlement-posting';

/** Everything the write-off binds beyond the header, read in ONE statement. */
interface WriteOffState {
  future: boolean;
  base_currency: string;
  base_exponent: number;
  txn_exponent: number;
  outstanding: string;
  /** A supplier return released part of the purchase's AP: the one origin of a residue. */
  returned: boolean;
  /** The purchase warehouse's branch: the dimension of the entry's lines. */
  branch_id: string | null;
}

/** `purchase_write_off_residue` (0072 §5 (d)). */
const PURCHASE_WRITE_OFF_RESIDUE_SQL = `SELECT purchase_id, replayed FROM purchase_write_off_residue(
   $1::uuid, $2::date, $3::text, $4::bigint, $5::bigint, $6::bigint)`;

/** The package's `inventory.reason_required` (a missing reason at the builder) is the write-off's own code. */
function rethrowWriteOffRefusal(error: unknown): never {
  if (error instanceof InventoryError && error.code === 'inventory.reason_required') throw purchasingRefusal('purchase_residue.reason_required');
  return rethrowPurchasingRefusal(error);
}

/**
 * `POST /v1/purchases/:purchaseId/residue-write-off` (Phase 3 corrective,
 * TD-16, migration 0072 R-96): closes a purchase's sub-unit AP residue — an
 * outstanding amount 0 < O converting to 0 base minor units, which only a
 * frozen P3-S5 partial return could leave and no settlement can clear.
 *
 * The flow is the S6 one (A-16):
 *
 * 1. the purchase header (not found → 404), then authority:
 *    `purchase.write_off_residue` — `suppliers.pay`, business-wide;
 * 2. the client intent (purchase, date, reason, the stated residue) and the
 *    idempotency proof: the write-off's identity IS the purchase, so an equal
 *    stored intent answers the stored write-off and another one is
 *    `purchase_residue.already_written_off` — BEFORE any state read;
 * 3. the routine's refusals in its order, over one snapshot: received
 *    (`purchase.state_invalid`), the dates, O = 0 (`nothing_outstanding`), O
 *    converting to a base unit or more (`not_below_base_unit`: pay or
 *    allocate it), the stated residue not O (`amount_mismatch`, 409: it
 *    moved), no return that released AP (`settlement_inconsistent`,
 *    unreachable: S6 never leaves a residue); O's three refusals first read
 *    the intent again, so a concurrent write-off that committed after the
 *    proof answers as a replay or `already_written_off`, never as its trace;
 * 4. `planResidueWriteOff` binds X = T − O and the base the ledger still
 *    carries, rb = apRelease(B, T, X, O) ∈ {0, 1}, and the entry lines;
 * 5. rb = 0: seam 1 — the routine only; no entry is owed (no journal line
 *    may carry base 0, and the ledger already owes no base). rb = 1: seam 2
 *    — the routine, then (unless it answered a replay) the one
 *    `purchase_residue_write_off` entry, Dr Accounts Payable 1 / Cr FX gain
 *    1; the row's deferred binding FK and the entry's completeness trigger
 *    prove each other at COMMIT.
 *
 * The routine re-derives O, X and rb under the purchase key and row lock and
 * refuses any difference, so a concurrent payment, return, reversal or
 * write-off can only turn this one into a clean refusal or a replay.
 */
@Injectable()
export class PurchaseResidueWriteOffService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async writeOff(
    m: MembershipContext,
    purchaseId: string,
    input: PurchaseResidueWriteOffRequest,
    btx: BusinessTransactionId,
  ): Promise<PurchaseResidueWriteOffResultDto> {
    try {
      return await this.run(m, purchaseId, input, btx);
    } catch (e) {
      return rethrowWriteOffRefusal(e);
    }
  }

  private async run(
    m: MembershipContext,
    purchaseId: string,
    input: PurchaseResidueWriteOffRequest,
    btx: BusinessTransactionId,
  ): Promise<PurchaseResidueWriteOffResultDto> {
    const { writeOffDate } = input;

    // 1. The document, then authority (business-wide).
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null) throw purchasingRefusal('purchase.not_found');
    const authority = await this.authorization.authorize(m, 'purchase.write_off_residue', btx);

    // 2. The client intent, then the idempotency proof — before any state read.
    const reason = normalizeDocumentText(input.reason);
    if (reason === null || [...reason].length > REASON_MAX_CHARS) throw purchasingRefusal('purchase_residue.reason_required');
    const statedResidue = BigInt(input.residueAmountMinor);
    const intent = { tenantId: m.tenantId, businessId: m.businessId, purchaseId, writeOffDate, reason, residueTxnMinor: statedResidue };
    const intentSha256 = purchaseResidueWriteOffIntentSha256(intent);
    const stored = await findResidueWriteOffIntent(this.db, m, purchaseId);
    if (stored !== null) {
      if (stored === intentSha256) return readResidueWriteOffResult(this.db, m, purchaseId, true);
      throw purchasingRefusal('purchase_residue.already_written_off');
    }

    // 3. The routine's refusals, in its order.
    if (header.status !== 'received' || header.total_base_minor === null || header.source_to_base_rate === null) {
      throw purchasingRefusal('purchase.state_invalid');
    }
    if (writeOffDate < header.document_date) throw purchasingRefusal('purchase_residue.date_before_purchase');
    const state = await this.readState(m, purchaseId, header.warehouse_id, header.currency_code, writeOffDate);
    if (state.future) throw purchasingRefusal('purchase_residue.date_in_future');

    // 4. The bound write-off.
    const plan = planResidueWriteOff({
      totalTxnMinor: parseMinor(header.total_txn_minor),
      totalBaseMinor: parseMinor(header.total_base_minor),
      outstandingTxnMinor: parseMinor(state.outstanding),
      rateR10: parseUnitCost(header.source_to_base_rate),
      txnExponent: state.txn_exponent,
      baseExponent: state.base_exponent,
    });
    if (plan.verdict !== 'write_off') return this.refuseUnlessWrittenOff(m, purchaseId, intentSha256, `purchase_residue.${plan.verdict}`);
    if (statedResidue !== plan.residueTxnMinor) return this.refuseUnlessWrittenOff(m, purchaseId, intentSha256, 'purchase_residue.amount_mismatch');
    if (!state.returned) throw purchasingRefusal('purchase_residue.settlement_inconsistent');
    const built = purchaseResidueWriteOffPayload({
      ...intent,
      releasedBeforeTxnMinor: plan.releasedBeforeTxnMinor,
      residueBaseMinor: plan.residueBaseMinor,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound write-off payload does not carry the proven intent');
    const params = [
      purchaseId,
      writeOffDate,
      reason,
      plan.residueTxnMinor.toString(10),
      plan.releasedBeforeTxnMinor.toString(10),
      plan.residueBaseMinor.toString(10),
    ];
    const inventoryAssertion = this.authorization.mint(authority, built.payload);

    // 5. rb = 0: the routine alone (seam 1). rb = 1: the routine and its entry (seam 2).
    if (plan.entryLines.length === 0) {
      const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, inventoryAssertion, async (tx) => {
        const r = await tx.query<{ replayed: boolean }>(PURCHASE_WRITE_OFF_RESIDUE_SQL, params);
        const [first] = r.rows;
        if (first === undefined) throw new Error('purchase_write_off_residue returned no row');
        return first.replayed;
      });
      return readResidueWriteOffResult(this.db, m, purchaseId, replayed);
    }
    if (state.branch_id === null) throw new Error("a received purchase's warehouse has no branch");
    const command = settlementPostingCommand({
      tenantId: m.tenantId,
      businessId: m.businessId,
      sourceType: PURCHASE_RESIDUE_WRITE_OFF_SOURCE,
      sourceId: purchaseId,
      entryDate: writeOffDate,
      baseCurrency: state.base_currency,
      snapshots: {},
      postingAccountCode: null,
      branches: { purchase: state.branch_id, origin: null },
      lines: plan.entryLines,
      businessTransactionId: btx,
    });
    const accountingAssertion = mintDomainPostingAssertion(this.accountingMinter, command, m.userId);
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, [accountingAssertion], async (tx) => {
      const r = await tx.query<{ replayed: boolean }>(PURCHASE_WRITE_OFF_RESIDUE_SQL, params);
      const [first] = r.rows;
      if (first === undefined) throw new Error('purchase_write_off_residue returned no row');
      // A replay inside the routine (a concurrent identical write-off won the
      // purchase key) commits no entry; its minted assertion expires unused.
      if (first.replayed) return true;
      await this.posting.postEntryInTransaction(tx.accounting, { command });
      return false;
    });
    return readResidueWriteOffResult(this.db, m, purchaseId, replayed);
  }

  /**
   * A state refusal may be the trace of a concurrent write-off that committed
   * between the idempotency proof and the state read (it takes O to 0). The
   * intent is read again, in a later snapshot that sees at least what the
   * state read saw: an equal stored intent is a replay, any other is
   * `already_written_off`; only with none is the refusal the state's.
   */
  private async refuseUnlessWrittenOff(
    m: MembershipContext,
    purchaseId: string,
    intentSha256: string,
    refusal: 'purchase_residue.nothing_outstanding' | 'purchase_residue.not_below_base_unit' | 'purchase_residue.amount_mismatch',
  ): Promise<PurchaseResidueWriteOffResultDto> {
    const stored = await findResidueWriteOffIntent(this.db, m, purchaseId);
    if (stored === intentSha256) return readResidueWriteOffResult(this.db, m, purchaseId, true);
    if (stored !== null) throw purchasingRefusal('purchase_residue.already_written_off');
    throw purchasingRefusal(refusal);
  }

  /** The write-off's state in ONE statement, read by `daftar_app` under RLS. */
  private async readState(scope: ReadScope, purchaseId: string, warehouseId: string, currency: string, writeOffDate: string): Promise<WriteOffState> {
    const [row] = await scopedRows<WriteOffState>(
      this.db,
      scope,
      `SELECT ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              b.base_currency::text AS base_currency, bc.minor_units AS base_exponent, tc.minor_units AS txn_exponent,
              purchase_ap_outstanding($1, $3)::text AS outstanding,
              EXISTS (SELECT 1 FROM supplier_returns r WHERE r.business_id = $1 AND r.purchase_id = $3 AND r.ap_txn_minor > 0) AS returned,
              (SELECT w.branch_id FROM warehouses w WHERE w.business_id = $1 AND w.id = $4) AS branch_id
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
         JOIN currencies tc ON tc.code = $5
        WHERE b.id = $1`,
      [scope.businessId, writeOffDate, purchaseId, warehouseId, currency],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }
}
