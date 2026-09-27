import { Inject, Injectable } from '@nestjs/common';
import { mintDomainPostingAssertion } from '@daftar/accounting';
import { planRefund, supplierReceiveRefundIntentSha256, supplierReceiveRefundPayload } from '@daftar/inventory';
import type { SupplierRefundResultDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findRefundIntent, readRefundResult, readSettlementFx, scopedRows } from './purchasing-reads';
import type { SupplierRefundRequest } from './purchasing.schemas';
import { CREDIT_NOTE_STATE_SQL, creditNoteState, noteRemainingRefusal, noteSnapshot, type CreditNoteStateRow } from './supplier-credit-allocation.service';
import { SETTLEMENT_METHOD_SQL, settlementMethod, settlementReference, type SettlementMethodRow } from './supplier-payment.service';
import { settlementPostingCommand, SUPPLIER_REFUND_SOURCE } from './supplier-settlement-posting';

/** Everything a refund binds, read in ONE statement. */
interface RefundState {
  base_currency: string;
  base_exponent: number;
  future: boolean;
  receipt_exponent: number | null;
  note: CreditNoteStateRow | null;
  supplier_exists: boolean;
  method: SettlementMethodRow | null;
}

/** `supplier_receive_refund` (§2.6). */
const SUPPLIER_RECEIVE_REFUND_SQL = `SELECT refund_id, replayed FROM supplier_receive_refund(
   $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::char(3), $7::bigint, $8::bigint, $9::bigint, $10::bigint,
   $11::char(3), $12::bigint, $13::uuid, $14::numeric, $15::text, $16::timestamptz, $17::bigint, $18::bigint, $19::text)`;

/**
 * `POST /v1/supplier-refunds` (PHASE_3_S6_CONTRACT A-05(c), A-10, A-11,
 * A-15, A-16; §2.6 `supplier_receive_refund`): money a supplier returns
 * against its credit note, received through a payment method.
 *
 * The flow is A-16's: the client intent and the idempotency proof BEFORE any
 * state read → authority (`suppliers.pay`, business-wide, TL-5) → the note
 * and its stored snapshot, its supplier, the method and its account's code,
 * the receipt currency and the business in ONE statement → the routine's
 * refusals in its order → the receipt's FX snapshot at `refund_date` (A-15)
 * → every amount bound by `planRefund` (the credit release by the
 * remaining-carrying function, its dust, the receipt base, realized FX) →
 * both assertions minted → seam 2: the routine (which inserts the refund
 * BEFORE it decrements the note, A-12), then — unless it answered a replay —
 * the one entry, then COMMIT with the R-63 guard.
 *
 * An inactive supplier's refund may still be received (TL-13). Optimistic: a
 * moved remaining is `supplier_refund.settlement_changed`, a moved rate
 * `supplier_refund.fx_rate_changed` (409, retry).
 */
@Injectable()
export class SupplierRefundService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async receive(m: MembershipContext, input: SupplierRefundRequest, btx: BusinessTransactionId): Promise<SupplierRefundResultDto> {
    try {
      return await this.run(m, input, btx);
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async run(m: MembershipContext, input: SupplierRefundRequest, btx: BusinessTransactionId): Promise<SupplierRefundResultDto> {
    const consumedMinor = BigInt(input.creditAmountMinor);
    const receiptAmountMinor = BigInt(input.receiptAmountMinor);
    const reference = settlementReference(input.reference, 'inventory.payload_invalid');

    // 1. The client intent, then the idempotency proof — before any state read.
    const intentSha256 = supplierReceiveRefundIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      refundId: input.refundId,
      creditNoteId: input.creditNoteId,
      paymentMethodId: input.paymentMethodId,
      refundDate: input.refundDate,
      consumedMinor,
      receiptCurrency: input.receiptCurrencyCode,
      receiptAmountMinor,
      reference,
    });
    const stored = await findRefundIntent(this.db, m, input.refundId);
    // 2. Authority: business-wide (TL-5). It reads membership only.
    const authority = await this.authorization.authorize(m, 'supplier.receive_refund', btx);
    if (stored !== null) {
      if (stored !== intentSha256) throw purchasingRefusal('supplier_refund.idempotency_conflict');
      return readRefundResult(this.db, m, input.refundId, true);
    }

    // 3. Current state, and the routine's refusals in its order (§2.6 steps 6–10).
    const state = await this.readState(m, input);
    const note = state.note;
    if (note === null) throw purchasingRefusal('supplier_credit_note.not_found');
    noteRemainingRefusal('supplier_refund', note, consumedMinor);
    if (!state.supplier_exists) throw purchasingRefusal('supplier.not_found');
    const method = settlementMethod(state.method, reference, 'supplier_refund.reference_required');
    if (input.refundDate < note.issued_on) throw purchasingRefusal('supplier_refund.date_before_credit');
    if (state.future) throw purchasingRefusal('supplier_refund.date_in_future');
    if (state.receipt_exponent === null) throw purchasingRefusal('purchase.currency_unknown');
    const fx = await readSettlementFx(this.db, m, input.receiptCurrencyCode, state.base_currency, input.refundDate);

    // 4. Every amount, bound (A-10, A-15).
    const plan = planRefund({
      note: creditNoteState(note, state.base_exponent),
      sameCurrency: input.receiptCurrencyCode === note.currency_code,
      consumedMinor,
      receiptAmountMinor,
      receipt: { rateR10: fx.rateR10, txnExponent: state.receipt_exponent, baseExponent: state.base_exponent },
    });
    const built = supplierReceiveRefundPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      refundId: input.refundId,
      creditNoteId: input.creditNoteId,
      paymentMethodId: method.paymentMethodId,
      postingAccountId: method.postingAccountId,
      refundDate: input.refundDate,
      sourceCurrency: note.currency_code,
      consumedMinor: plan.consumedMinor,
      remainingBeforeMinor: plan.remainingBeforeMinor,
      sourceReleasedMinor: plan.creditReleasedMinor,
      sourceDustBaseMinor: plan.creditDustBaseMinor,
      receiptCurrency: input.receiptCurrencyCode,
      receiptAmountMinor: plan.receiptAmountMinor,
      rate: { rateId: fx.rateId, rateR10: fx.rateR10, source: fx.source, rateAtEpochSeconds: BigInt(fx.at.getTime() / 1000) },
      receiptBaseMinor: plan.receiptBaseMinor,
      realizedMinor: plan.realizedMinor,
      reference,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound refund payload does not carry the proven intent');
    const command = settlementPostingCommand({
      tenantId: m.tenantId,
      businessId: m.businessId,
      sourceType: SUPPLIER_REFUND_SOURCE,
      sourceId: input.refundId,
      entryDate: input.refundDate,
      baseCurrency: state.base_currency,
      snapshots: {
        note: noteSnapshot(note),
        receipt: { currency: input.receiptCurrencyCode, rate: fx.rate, source: fx.source, at: fx.at },
      },
      postingAccountCode: method.postingAccountCode,
      branches: { purchase: null, origin: note.origin_branch_id },
      lines: plan.entryLines,
      businessTransactionId: btx,
    });

    // 5. Mint both assertions before the seam opens.
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const accountingAssertion = mintDomainPostingAssertion(this.accountingMinter, command, m.userId);

    // 6. One transaction: the routine, the entry, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, [accountingAssertion], async (tx) => {
      const r = await tx.query<{ replayed: boolean }>(SUPPLIER_RECEIVE_REFUND_SQL, [
        input.refundId,
        input.creditNoteId,
        method.paymentMethodId,
        method.postingAccountId,
        input.refundDate,
        note.currency_code,
        plan.consumedMinor.toString(10),
        plan.remainingBeforeMinor.toString(10),
        plan.creditReleasedMinor.toString(10),
        plan.creditDustBaseMinor.toString(10),
        input.receiptCurrencyCode,
        plan.receiptAmountMinor.toString(10),
        fx.rateId,
        fx.rate,
        fx.source,
        `${fx.at.toISOString().slice(0, 19)}Z`,
        plan.receiptBaseMinor.toString(10),
        plan.realizedMinor.toString(10),
        reference,
      ]);
      const [first] = r.rows;
      if (first === undefined) throw new Error('supplier_receive_refund returned no row');
      if (first.replayed) return true;
      await this.posting.postEntryInTransaction(tx.accounting, { command });
      return false;
    });
    return readRefundResult(this.db, m, input.refundId, replayed);
  }

  /** The refund's state in ONE statement, read by `daftar_app` under RLS. */
  private async readState(scope: ReadScope, input: SupplierRefundRequest): Promise<RefundState> {
    const [row] = await scopedRows<RefundState>(
      this.db,
      scope,
      `SELECT b.base_currency::text AS base_currency, bc.minor_units AS base_exponent,
              ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              (SELECT c.minor_units FROM currencies c WHERE c.code = $3) AS receipt_exponent,
              ${CREDIT_NOTE_STATE_SQL.replace('%NOTE%', '$4')} AS note,
              EXISTS (SELECT 1 FROM suppliers s JOIN supplier_credit_notes n ON n.business_id = s.business_id AND n.supplier_id = s.id
                       WHERE s.business_id = b.id AND n.id = $4) AS supplier_exists,
              ${SETTLEMENT_METHOD_SQL.replace('%METHOD%', '$5')} AS method
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
        WHERE b.id = $1`,
      [scope.businessId, input.refundDate, input.receiptCurrencyCode, input.creditNoteId, input.paymentMethodId],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }
}
