import { Inject, Injectable } from '@nestjs/common';
import { mintDomainPostingAssertion } from '@daftar/accounting';
import { supplierPayIntentSha256 } from '@daftar/inventory';
import type { ReceiveAndPayResultDto, SupplierPaymentResultDto } from '@daftar/shared-contracts';
import { Database, presentInventoryAssertion, type AccountingAssertions } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { PurchaseReceiptService, type ReceiptPlan } from './purchase-receipt.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findSupplierPayment, readReceipt, readSettlementFx, readSupplierPaymentResult, scopedRows, type SettlementFx } from './purchasing-reads';
import type { ReceiveAndPayRequest } from './purchasing.schemas';
import {
  bindSupplierPayment,
  executeSupplierPay,
  SETTLEMENT_METHOD_SQL,
  settlementMethod,
  settlementReference,
  type SettledPurchase,
  type SettlementMethodRow,
} from './supplier-payment.service';

/** The payment half's state, read in ONE statement. */
interface PaymentHalfState {
  base_exponent: number;
  /** The payment currency's exponent, or null when it is not registered. */
  currency_exponent: number | null;
  purchase_exponent: number;
  method: SettlementMethodRow | null;
}

/** The payment key `supplier_pay` takes first (§2.6 step 3), taken by the combined command before the receipt (T-14). */
const PAYMENT_KEY_SQL = `SELECT pg_advisory_xact_lock(hashtext('daftar.supplier_payment_id'), hashtext($1::uuid::text))`;

/**
 * `POST /v1/purchases/:purchaseId/receive-and-pay` (PHASE_3_S6_CONTRACT
 * A-19, AL-24): the S4 receipt, UNCHANGED, and a supplier payment with ONE
 * allocation to this purchase, as one merchant operation — one
 * `business_transaction_id`, one transaction.
 *
 * - The receipt half is `PurchaseReceiptService.plan` / `.execute` exactly.
 * - The payment half is bound from the receipt plan without a second read of
 *   the purchase: `payment_date = document_date`, `X = 0`, `O = T`, and the
 *   purchase's `B` and `R`. `a ≤ T` (a partial immediate payment is allowed).
 *   An omitted applied amount equals `amountMinor`, which needs the payment
 *   currency to be the purchase currency (else
 *   `supplier_payment.allocations_invalid`).
 * - Authority: `purchase.receive` AND `supplier.pay`, each over the purchase
 *   warehouse. Two inventory assertions (`purchase.receive`, then
 *   `supplier.pay`) and the accounting assertions `purchase`, the catch-up
 *   when present, then `supplier_payment` — all minted before seam 2 opens,
 *   which runs them as an `InventoryAssertionSequence`.
 * - The seam callback's FIRST statement takes the payment's key, so a racing
 *   standalone `supplier.pay` of the same `payment_id` (which takes that key
 *   first too) serializes on it instead of deadlocking against the receipt's
 *   locks (T-14).
 * - Replay: a received purchase whose receive intent equals this request's
 *   and whose payment row exists with an equal intent is a full replay,
 *   answered from stored rows without opening the seam. A received purchase
 *   with no such payment is `purchase.state_invalid`: its receipt belongs to
 *   another command.
 */
@Injectable()
export class PurchaseReceiveAndPayService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
    @Inject(PurchaseReceiptService) private readonly receipts: PurchaseReceiptService,
  ) {}

  async receiveAndPay(m: MembershipContext, purchaseId: string, input: ReceiveAndPayRequest, btx: BusinessTransactionId): Promise<ReceiveAndPayResultDto> {
    try {
      return await this.run(m, purchaseId, input, btx);
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async run(m: MembershipContext, purchaseId: string, input: ReceiveAndPayRequest, btx: BusinessTransactionId): Promise<ReceiveAndPayResultDto> {
    const pay = input.payment;
    const reference = settlementReference(pay.reference, 'supplier_payment.allocations_invalid');
    const amountMinor = BigInt(pay.amountMinor);
    const appliedMinor =
      pay.purchaseAmountAppliedMinor === null || pay.purchaseAmountAppliedMinor === undefined ? null : BigInt(pay.purchaseAmountAppliedMinor);

    // The receipt half's steps 1–5: the document, `purchase.receive` over its
    // warehouse, the receive intent's proof, and — for a draft — the bound plan.
    const outcome = await this.receipts.plan(m, purchaseId, { draftRevision: input.draftRevision }, btx);
    const header =
      outcome.kind === 'replay'
        ? outcome
        : {
            warehouseId: outcome.plan.warehouseId,
            supplierId: outcome.plan.supplierId,
            documentDate: outcome.plan.documentDate,
            currency: outcome.plan.currency,
          };
    const payAuthority = await this.authorization.authorize(m, 'supplier.pay', btx, [header.warehouseId]);
    if (appliedMinor === null && pay.currencyCode !== header.currency) throw purchasingRefusal('supplier_payment.allocations_invalid');
    const allocation = { allocationId: pay.allocationId, purchaseId, paymentAmountMinor: amountMinor, appliedMinor: appliedMinor ?? amountMinor };
    const intentSha256 = supplierPayIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      paymentId: pay.paymentId,
      supplierId: header.supplierId,
      paymentMethodId: pay.paymentMethodId,
      paymentDate: header.documentDate,
      currency: pay.currencyCode,
      amountMinor,
      reference,
      allocations: [allocation],
    });

    if (outcome.kind === 'replay') {
      const stored = await findSupplierPayment(this.db, m, pay.paymentId);
      if (stored === null || stored.intentSha256 !== intentSha256) throw purchasingRefusal('purchase.state_invalid');
      return this.result(m, purchaseId, true, await readSupplierPaymentResult(this.db, m, pay.paymentId, true));
    }
    const receipt = outcome.plan;
    if ((await findSupplierPayment(this.db, m, pay.paymentId)) !== null) throw purchasingRefusal('supplier_payment.idempotency_conflict');

    // The payment half, bound from the receipt plan (A-19): X = 0, O = T, B, R.
    const state = await this.readPaymentHalf(m, pay.currencyCode, receipt.currency, pay.paymentMethodId);
    const method = settlementMethod(state.method, reference, 'supplier_payment.reference_required');
    if (state.currency_exponent === null) throw purchasingRefusal('purchase.currency_unknown');
    const fx: SettlementFx =
      pay.currencyCode === receipt.currency ? receipt.fx : await readSettlementFx(this.db, m, pay.currencyCode, receipt.baseCurrency, receipt.documentDate);
    const bound = bindSupplierPayment({
      tenantId: m.tenantId,
      businessId: m.businessId,
      businessTransactionId: btx,
      paymentId: pay.paymentId,
      supplierId: receipt.supplierId,
      method,
      paymentDate: receipt.documentDate,
      currency: pay.currencyCode,
      currencyExponent: state.currency_exponent,
      baseCurrency: receipt.baseCurrency,
      baseExponent: state.base_exponent,
      amountMinor,
      reference,
      fx,
      allocations: [
        {
          allocationId: allocation.allocationId,
          purchase: settledFromPlan(receipt, state.purchase_exponent),
          paymentAmountMinor: amountMinor,
          appliedMinor: allocation.appliedMinor,
        },
      ],
    });
    if (bound.built.intentSha256 !== intentSha256) throw new Error('the bound payment payload does not carry the proven intent');

    // Mint everything before the seam opens: two inventory assertions in call
    // order, and the accounting assertions in posting order.
    const receiveAssertion = this.authorization.mint(receipt.authority, receipt.built.payload);
    const payAssertion = this.authorization.mint(payAuthority, bound.built.payload);
    const mint = (c: (typeof bound.commands)[number]): string => mintDomainPostingAssertion(this.accountingMinter, c, m.userId);
    const accountingAssertions: AccountingAssertions = [
      mint(receipt.purchaseCommand),
      ...(receipt.catchUpCommand === null ? [] : [mint(receipt.catchUpCommand)]),
      ...bound.commands.map(mint),
    ];

    const replayed = await this.db.withBusinessInventoryAccountingTransaction(
      receipt.authority.scope,
      [receiveAssertion, payAssertion],
      accountingAssertions,
      async (tx) => {
        await tx.query(PAYMENT_KEY_SQL, [pay.paymentId]);
        const receiptReplayed = await this.receipts.execute(tx, receipt);
        await presentInventoryAssertion(tx, 'supplier.pay');
        const paymentReplayed = await executeSupplierPay(tx, this.posting, bound);
        return receiptReplayed && paymentReplayed;
      },
    );
    return this.result(m, purchaseId, replayed, await readSupplierPaymentResult(this.db, m, pay.paymentId, replayed));
  }

  /** The combined answer: the receipt exactly as `POST …/receive` answers it, and the stored payment. */
  private async result(m: MembershipContext, purchaseId: string, replayed: boolean, payment: SupplierPaymentResultDto): Promise<ReceiveAndPayResultDto> {
    const receipt = await readReceipt(this.db, m, purchaseId, replayed);
    return {
      purchaseId,
      replayed,
      businessTransactionId: payment.businessTransactionId,
      receipt,
      payment: {
        paymentId: payment.paymentId,
        supplierId: payment.supplierId,
        paymentMethodId: payment.paymentMethodId,
        currency: payment.currency,
        amountMinor: payment.amountMinor,
        baseAmountMinor: payment.baseAmountMinor,
        rate: payment.rate,
        paymentDate: payment.paymentDate,
        reference: payment.reference,
        allocations: payment.allocations,
        createdAt: payment.createdAt,
      },
    };
  }

  /** The payment half's method and the three currencies' exponents in ONE statement. */
  private async readPaymentHalf(scope: ReadScope, currency: string, purchaseCurrency: string, paymentMethodId: string): Promise<PaymentHalfState> {
    const [row] = await scopedRows<PaymentHalfState>(
      this.db,
      scope,
      `SELECT bc.minor_units AS base_exponent,
              (SELECT c.minor_units FROM currencies c WHERE c.code = $2) AS currency_exponent,
              pc.minor_units AS purchase_exponent,
              ${SETTLEMENT_METHOD_SQL.replace('%METHOD%', '$4')} AS method
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
         JOIN currencies pc ON pc.code = $3
        WHERE b.id = $1`,
      [scope.businessId, currency, purchaseCurrency, paymentMethodId],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }
}

/**
 * The purchase as the payment half binds it (A-19): the receipt plan's `T`,
 * `B` and `R`, and `O = T` — nothing has settled a purchase that is being
 * received.
 */
function settledFromPlan(receipt: ReceiptPlan, currencyExponent: number): SettledPurchase {
  return {
    purchaseId: receipt.purchaseId,
    supplierId: receipt.supplierId,
    warehouseId: receipt.warehouseId,
    branchId: receipt.branchId,
    currency: receipt.currency,
    currencyExponent,
    totalTxnMinor: receipt.totalTxnMinor,
    totalBaseMinor: receipt.totalBaseMinor,
    outstandingTxnMinor: receipt.totalTxnMinor,
    rate: receipt.fx.rate,
    rateSource: receipt.fx.source,
    rateAt: receipt.fx.at,
  };
}
