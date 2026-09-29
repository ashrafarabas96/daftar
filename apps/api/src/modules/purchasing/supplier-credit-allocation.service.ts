import { Inject, Injectable } from '@nestjs/common';
import { mintDomainPostingAssertion } from '@daftar/accounting';
import {
  parseMinor,
  parseUnitCost,
  planCreditAllocation,
  supplierAllocateCreditIntentSha256,
  supplierAllocateCreditPayload,
  type CreditNoteState,
} from '@daftar/inventory';
import type { SupplierCreditAllocationResultDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findCreditAllocationIntent, readCreditAllocationResult, scopedRows } from './purchasing-reads';
import type { SupplierCreditAllocationRequest } from './purchasing.schemas';
import { SETTLED_PURCHASES_SQL, settledPurchase, type PurchaseStateRow } from './supplier-payment.service';
import { settlementPostingCommand, SUPPLIER_CREDIT_ALLOCATION_SOURCE, type SettlementSnapshot } from './supplier-settlement-posting';

/** One credit note of a settlement's state read, numerics as text (A-10, S5 A-11). */
export interface CreditNoteStateRow {
  id: string;
  supplier_id: string;
  currency_code: string;
  currency_exponent: number;
  original_amount_minor: string;
  remaining_amount_minor: string;
  original_carrying_base_amount_minor: string;
  rate: string;
  rate_source: 'base' | 'manual';
  rate_timestamp: string;
  issued_on: string;
  /** The branch of the note's origin purchase's warehouse: the 1150 lines' dimension (A-05(b), (c)). */
  origin_branch_id: string | null;
}

/** A note of a settlement's state read, as a state-read column. */
export const CREDIT_NOTE_STATE_SQL = `(SELECT json_build_object(
            'id', n.id, 'supplier_id', n.supplier_id, 'currency_code', n.currency_code::text, 'currency_exponent', nc.minor_units,
            'original_amount_minor', n.original_amount_minor::text, 'remaining_amount_minor', n.remaining_amount_minor::text,
            'original_carrying_base_amount_minor', n.original_carrying_base_amount_minor::text,
            'rate', n.source_to_base_rate::text, 'rate_source', n.rate_source,
            'rate_timestamp', to_char(n.rate_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'issued_on', n.issued_on::text, 'origin_branch_id', ow.branch_id)
       FROM supplier_credit_notes n
       JOIN currencies nc ON nc.code = n.currency_code
       JOIN supplier_returns r ON r.business_id = n.business_id AND r.id = n.supplier_return_id
       JOIN purchases op ON op.business_id = r.business_id AND op.id = r.purchase_id
       JOIN warehouses ow ON ow.business_id = op.business_id AND ow.id = op.warehouse_id
      WHERE n.business_id = b.id AND n.id = %NOTE%::uuid)`;

/** A note row as the package's state: its stored amounts and snapshot `Rn`, never a new lookup (L:830-841). */
export function creditNoteState(n: CreditNoteStateRow, baseExponent: number): CreditNoteState {
  return {
    originalMinor: parseMinor(n.original_amount_minor),
    originalCarryingMinor: parseMinor(n.original_carrying_base_amount_minor),
    remainingMinor: parseMinor(n.remaining_amount_minor),
    conversion: { rateR10: parseUnitCost(n.rate), txnExponent: n.currency_exponent, baseExponent },
  };
}

/**
 * The note's remaining checks, in the routine's order (§2.6 step 7): nothing
 * remaining, then more consumed than remains. `planCreditAllocation` /
 * `planRefund` judge the same again; checking here keeps the refusal order
 * the routine's when a later check (the supplier, the dates) would also fail.
 */
export function noteRemainingRefusal(domain: 'supplier_credit_allocation' | 'supplier_refund', n: CreditNoteStateRow, consumedMinor: bigint): void {
  const remaining = parseMinor(n.remaining_amount_minor);
  if (remaining === 0n) throw purchasingRefusal(`${domain}.credit_exhausted`);
  if (consumedMinor > remaining) throw purchasingRefusal(`${domain}.amount_exceeds_credit`);
}

/** A note's stored snapshot as the posting's. */
export function noteSnapshot(n: CreditNoteStateRow): SettlementSnapshot {
  return { currency: n.currency_code, rate: n.rate, source: n.rate_source, at: new Date(n.rate_timestamp) };
}

/** Everything a credit allocation binds, read in ONE statement. */
interface CreditAllocationState {
  base_currency: string;
  base_exponent: number;
  future: boolean;
  purchases: PurchaseStateRow[];
  note: CreditNoteStateRow | null;
  supplier_exists: boolean;
}

/** `supplier_allocate_credit` (§2.6). */
const SUPPLIER_ALLOCATE_CREDIT_SQL = `SELECT allocation_id, replayed FROM supplier_allocate_credit(
   $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::char(3), $7::bigint, $8::bigint, $9::bigint, $10::bigint,
   $11::char(3), $12::bigint, $13::bigint, $14::bigint, $15::bigint, $16::bigint)`;

/**
 * `POST /v1/supplier-credit-allocations` (PHASE_3_S6_CONTRACT A-05(b), A-08,
 * A-10, A-11, A-15, A-16; §2.6 `supplier_allocate_credit`): a supplier's
 * credit note applied to one of its received, unreversed purchases.
 *
 * The flow is A-16's: the client intent and the idempotency proof BEFORE any
 * state read → authority (`suppliers.pay`, business-wide: a credit is the
 * supplier's across every warehouse, TL-5) → the purchase, its `O`, the note
 * and its stored snapshot, the supplier and the business in ONE statement →
 * the routine's refusals in its order → every stored amount bound by
 * `planCreditAllocation` (the AP release and dust, the credit release by the
 * remaining-carrying function, its dust, realized FX) → both assertions
 * minted → seam 2: the routine (which inserts the allocation BEFORE it
 * decrements the note, A-12), then — unless it answered a replay — the one
 * entry, then COMMIT with the R-62 and R-63 guards.
 *
 * An inactive supplier's credit may still be applied (TL-13). Optimistic: a
 * moved `O` or remaining is `….settlement_changed` (409, retry).
 */
@Injectable()
export class SupplierCreditAllocationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async allocate(m: MembershipContext, input: SupplierCreditAllocationRequest, btx: BusinessTransactionId): Promise<SupplierCreditAllocationResultDto> {
    try {
      return await this.run(m, input, btx);
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async run(m: MembershipContext, input: SupplierCreditAllocationRequest, btx: BusinessTransactionId): Promise<SupplierCreditAllocationResultDto> {
    const consumedMinor = BigInt(input.creditAmountMinor);
    const appliedMinor = BigInt(input.purchaseAmountAppliedMinor);

    // 1. The client intent, then the idempotency proof — before any state read.
    const intentSha256 = supplierAllocateCreditIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      allocationId: input.allocationId,
      creditNoteId: input.creditNoteId,
      purchaseId: input.purchaseId,
      allocationDate: input.allocationDate,
      consumedMinor,
      appliedMinor,
    });
    const stored = await findCreditAllocationIntent(this.db, m, input.allocationId);
    // 2. Authority: business-wide (TL-5). It reads membership only.
    const authority = await this.authorization.authorize(m, 'supplier.allocate_credit', btx);
    if (stored !== null) {
      if (stored !== intentSha256) throw purchasingRefusal('supplier_credit_allocation.idempotency_conflict');
      return readCreditAllocationResult(this.db, m, input.allocationId, true);
    }

    // 3. Current state, and the routine's refusals in its order (§2.6 steps 6–9).
    const state = await this.readState(m, input);
    const [row] = state.purchases;
    if (row === undefined) throw purchasingRefusal('purchase.not_found');
    if (row.status !== 'received') throw purchasingRefusal('supplier_credit_allocation.purchase_state_invalid');
    if (row.reversed) throw purchasingRefusal('supplier_credit_allocation.purchase_reversed');
    const note = state.note;
    if (note === null) throw purchasingRefusal('supplier_credit_note.not_found');
    if (note.supplier_id !== row.supplier_id) throw purchasingRefusal('supplier_credit_allocation.supplier_mismatch');
    noteRemainingRefusal('supplier_credit_allocation', note, consumedMinor);
    if (!state.supplier_exists) throw purchasingRefusal('supplier.not_found');
    const source = row.document_date > note.issued_on ? row.document_date : note.issued_on;
    if (input.allocationDate < source) throw purchasingRefusal('supplier_credit_allocation.date_before_source');
    if (state.future) throw purchasingRefusal('supplier_credit_allocation.date_in_future');

    // 4. Every stored amount, bound (A-08, A-10, A-15).
    const purchase = settledPurchase(row);
    const plan = planCreditAllocation({
      purchase: {
        totalTxnMinor: purchase.totalTxnMinor,
        totalBaseMinor: purchase.totalBaseMinor,
        outstandingTxnMinor: purchase.outstandingTxnMinor,
        conversion: { rateR10: parseUnitCost(purchase.rate), txnExponent: purchase.currencyExponent, baseExponent: state.base_exponent },
      },
      note: creditNoteState(note, state.base_exponent),
      sameCurrency: note.currency_code === purchase.currency,
      consumedMinor,
      appliedMinor,
    });
    const built = supplierAllocateCreditPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      allocationId: input.allocationId,
      creditNoteId: input.creditNoteId,
      purchaseId: input.purchaseId,
      warehouseId: purchase.warehouseId,
      allocationDate: input.allocationDate,
      creditCurrency: note.currency_code,
      consumedMinor: plan.consumedMinor,
      remainingBeforeMinor: plan.remainingBeforeMinor,
      creditReleasedMinor: plan.creditReleasedMinor,
      creditDustBaseMinor: plan.creditDustBaseMinor,
      purchaseCurrency: purchase.currency,
      appliedMinor: plan.appliedMinor,
      apReleasedBeforeMinor: plan.releasedBeforeMinor,
      apReleasedMinor: plan.carryingReleasedMinor,
      apDustBaseMinor: plan.apDustBaseMinor,
      realizedMinor: plan.realizedMinor,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound credit-allocation payload does not carry the proven intent');
    const command = settlementPostingCommand({
      tenantId: m.tenantId,
      businessId: m.businessId,
      sourceType: SUPPLIER_CREDIT_ALLOCATION_SOURCE,
      sourceId: input.allocationId,
      entryDate: input.allocationDate,
      baseCurrency: state.base_currency,
      snapshots: {
        purchase: { currency: purchase.currency, rate: purchase.rate, source: purchase.rateSource, at: purchase.rateAt },
        note: noteSnapshot(note),
      },
      postingAccountCode: null,
      branches: { purchase: purchase.branchId, origin: note.origin_branch_id },
      lines: plan.entryLines,
      businessTransactionId: btx,
    });

    // 5. Mint both assertions before the seam opens.
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const accountingAssertion = mintDomainPostingAssertion(this.accountingMinter, command, m.userId);

    // 6. One transaction: the routine, the entry, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, [accountingAssertion], async (tx) => {
      const r = await tx.query<{ replayed: boolean }>(SUPPLIER_ALLOCATE_CREDIT_SQL, [
        input.allocationId,
        input.creditNoteId,
        input.purchaseId,
        purchase.warehouseId,
        input.allocationDate,
        note.currency_code,
        plan.consumedMinor.toString(10),
        plan.remainingBeforeMinor.toString(10),
        plan.creditReleasedMinor.toString(10),
        plan.creditDustBaseMinor.toString(10),
        purchase.currency,
        plan.appliedMinor.toString(10),
        plan.releasedBeforeMinor.toString(10),
        plan.carryingReleasedMinor.toString(10),
        plan.apDustBaseMinor.toString(10),
        plan.realizedMinor.toString(10),
      ]);
      const [first] = r.rows;
      if (first === undefined) throw new Error('supplier_allocate_credit returned no row');
      if (first.replayed) return true;
      await this.posting.postEntryInTransaction(tx.accounting, { command });
      return false;
    });
    return readCreditAllocationResult(this.db, m, input.allocationId, replayed);
  }

  /** The allocation's state in ONE statement, read by `daftar_app` under RLS. */
  private async readState(scope: ReadScope, input: SupplierCreditAllocationRequest): Promise<CreditAllocationState> {
    const [row] = await scopedRows<CreditAllocationState>(
      this.db,
      scope,
      `SELECT b.base_currency::text AS base_currency, bc.minor_units AS base_exponent,
              ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              ${SETTLED_PURCHASES_SQL.replace('%IDS%', 'ARRAY[$3::uuid]')} AS purchases,
              ${CREDIT_NOTE_STATE_SQL.replace('%NOTE%', '$4')} AS note,
              EXISTS (SELECT 1 FROM suppliers s JOIN purchases p ON p.business_id = s.business_id AND p.supplier_id = s.id
                       WHERE s.business_id = b.id AND p.id = $3) AS supplier_exists
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
        WHERE b.id = $1`,
      [scope.businessId, input.allocationDate, input.purchaseId, input.creditNoteId],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }
}
