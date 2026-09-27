/**
 * Supplier settlement — P3-S6 (PHASE_3_S6_CONTRACT A-07..A-10, A-18, A-19):
 * supplier payments, supplier-credit allocations, supplier refunds and the
 * combined receive-and-pay command.
 *
 * The P3-S4/S5 purchasing conventions hold, with one difference: every
 * settlement amount in a REQUEST is an integer STRING of MINOR units
 * (`amountMinor: "12500"`), never major units and never a JSON number.
 *
 * - `…Minor` in a payment or receipt currency is in that currency's minor
 *   units; `purchaseAmountAppliedMinor` is in the PURCHASE currency;
 *   `creditAmountMinor` is in the credit note's currency; every `…BaseMinor`
 *   is in the business's base currency. Two amounts in different currencies
 *   are never compared (L:899): their base difference is realized FX.
 * - When the two currencies are equal the two amounts must be equal
 *   (`….amount_mismatch`, 400).
 * - Every document id is a client-chosen canonical LOWERCASE uuid and is the
 *   idempotency key: resending the same command answers the stored result with
 *   `replayed: true`; the same id with a different command is
 *   `….idempotency_conflict` (409).
 * - A payment is FULLY allocated at creation: there is no advance and no
 *   unallocated remainder (TL-3). Nothing is ever edited, deleted or reversed.
 * - `….settlement_changed` / `….fx_rate_changed` (409) are RETRYABLE: another
 *   settlement moved the outstanding amount or a rate was stated meanwhile.
 * - Tax is BLOCKED BY OD-03: no request has a tax field.
 */
import type { PurchaseRateDto, PurchaseReceiptDto, PurchaseTransitionRequestDto } from './purchasing';

// ── Requests ─────────────────────────────────────────────────────────────

/** One allocation of a supplier payment to one received, unreversed purchase of the supplier. */
export interface SupplierPaymentAllocationRequestDto {
  allocationId: string;
  purchaseId: string;
  /** > 0, in the payment currency. Σ over the allocations = `amountMinor`. */
  paymentAmountMinor: string;
  /** > 0, in the purchase currency; at most the purchase's outstanding AP (`supplier_payment.amount_exceeds_outstanding`, 422). */
  purchaseAmountAppliedMinor: string;
}

/**
 * `POST /v1/supplier-payments` — requires `suppliers.pay` and the scope of
 * every allocated purchase's warehouse. 201 on create, 200 on replay.
 */
export interface SupplierPaymentRequestDto {
  paymentId: string;
  supplierId: string;
  paymentMethodId: string;
  /** ISO 4217, upper case, registered. */
  currencyCode: string;
  /** > 0: the whole payment, fully allocated. */
  amountMinor: string;
  /** `YYYY-MM-DD`: the entry date and the FX snapshot date. Not before any allocated purchase, not in the future. */
  paymentDate: string;
  /** 1..100 characters after trimming; required when the method requires a reference. */
  reference?: string | null;
  /** 1..50, each to a distinct purchase. */
  allocations: SupplierPaymentAllocationRequestDto[];
}

/** `POST /v1/supplier-credit-allocations` — requires `suppliers.pay` and business-wide scope. */
export interface SupplierCreditAllocationRequestDto {
  allocationId: string;
  creditNoteId: string;
  /** A received, unreversed purchase of the note's supplier. */
  purchaseId: string;
  /** `YYYY-MM-DD`. Not before the purchase or the note, not in the future. */
  allocationDate: string;
  /** > 0, in the note's currency; at most the note's remaining amount. */
  creditAmountMinor: string;
  /** > 0, in the purchase currency; at most the purchase's outstanding AP. */
  purchaseAmountAppliedMinor: string;
}

/** `POST /v1/supplier-refunds` — requires `suppliers.pay` and business-wide scope. */
export interface SupplierRefundRequestDto {
  refundId: string;
  creditNoteId: string;
  paymentMethodId: string;
  /** `YYYY-MM-DD`. Not before the note, not in the future. */
  refundDate: string;
  /** > 0, in the note's currency; at most the note's remaining amount. */
  creditAmountMinor: string;
  /** ISO 4217, upper case, registered: the currency the money arrived in. */
  receiptCurrencyCode: string;
  /** > 0, in the receipt currency. */
  receiptAmountMinor: string;
  reference?: string | null;
}

/** The payment half of `POST /v1/purchases/:purchaseId/receive-and-pay` (A-19). */
export interface ReceiveAndPayPaymentRequestDto {
  paymentId: string;
  allocationId: string;
  paymentMethodId: string;
  currencyCode: string;
  /** > 0, in the payment currency. */
  amountMinor: string;
  /**
   * In the purchase currency, 1..the purchase total: a partial immediate
   * payment is allowed. Omitted: equal to `amountMinor`, which requires the
   * payment currency to be the purchase currency.
   */
  purchaseAmountAppliedMinor?: string | null;
  reference?: string | null;
}

/**
 * `POST /v1/purchases/:purchaseId/receive-and-pay` — requires
 * `purchases.receive` AND `suppliers.pay`, each over the purchase warehouse.
 * One operation, one transaction: the S4 receipt and a one-allocation payment
 * dated the purchase's document date.
 */
export interface ReceiveAndPayRequestDto extends PurchaseTransitionRequestDto {
  payment: ReceiveAndPayPaymentRequestDto;
}

// ── Responses ────────────────────────────────────────────────────────────

/** The FX snapshot of a payment or refund. Domestic: `source: 'base'`, rate `"1"`, no rate id. */
export type SettlementRateDto = PurchaseRateDto;

/** One stored allocation of a supplier payment (the `supplier_payment` accounting source). */
export interface SupplierPaymentAllocationDto {
  allocationId: string;
  lineNo: number;
  purchaseId: string;
  paymentCurrency: string;
  paymentAmountMinor: string;
  paymentBaseMinor: string;
  purchaseCurrency: string;
  purchaseAmountAppliedMinor: string;
  /** The purchase's applied amount before this allocation (X). */
  apReleasedBeforeTxnMinor: string;
  /** The purchase's carrying base this allocation released. */
  carryingBaseReleasedMinor: string;
  /** Signed. */
  apDustBaseMinor: string;
  /** Signed: positive is a loss, negative a gain. */
  realizedFxMinor: string;
  /** The allocation's `supplier_payment` journal entry. */
  entryId: string;
}

/** A supplier payment as stored: `GET /v1/supplier-payments/:paymentId` and each item of `GET /v1/suppliers/:supplierId/payments`. */
export interface SupplierPaymentDto {
  paymentId: string;
  supplierId: string;
  paymentMethodId: string;
  currency: string;
  amountMinor: string;
  baseAmountMinor: string;
  rate: SettlementRateDto;
  paymentDate: string;
  reference: string | null;
  allocations: SupplierPaymentAllocationDto[];
  createdAt: string;
}

/** The answer of `POST /v1/supplier-payments` — always read from stored rows. */
export interface SupplierPaymentResultDto extends SupplierPaymentDto {
  replayed: boolean;
  businessTransactionId: string;
}

/** A supplier-credit allocation as stored (the `supplier_credit_allocation` accounting source). */
export interface SupplierCreditAllocationDto {
  allocationId: string;
  supplierId: string;
  creditNoteId: string;
  purchaseId: string;
  allocationDate: string;
  creditCurrency: string;
  creditAmountConsumedMinor: string;
  creditRemainingBeforeMinor: string;
  creditCarryingBaseReleasedMinor: string;
  creditDustBaseMinor: string;
  purchaseCurrency: string;
  purchaseAmountAppliedMinor: string;
  apReleasedBeforeTxnMinor: string;
  carryingBaseReleasedMinor: string;
  apDustBaseMinor: string;
  realizedFxMinor: string;
  entryId: string;
  createdAt: string;
}

export interface SupplierCreditAllocationResultDto extends SupplierCreditAllocationDto {
  replayed: boolean;
  businessTransactionId: string;
}

/** A supplier refund as stored (the `supplier_refund` accounting source). */
export interface SupplierRefundDto {
  refundId: string;
  supplierId: string;
  creditNoteId: string;
  paymentMethodId: string;
  refundDate: string;
  reference: string | null;
  sourceCurrency: string;
  sourceAmountConsumedMinor: string;
  creditRemainingBeforeMinor: string;
  sourceCarryingBaseReleasedMinor: string;
  sourceDustBaseMinor: string;
  receiptCurrency: string;
  receiptAmountMinor: string;
  receiptBaseMinor: string;
  rate: SettlementRateDto;
  /** Signed: positive is a gain, negative a loss. */
  realizedFxMinor: string;
  entryId: string;
  createdAt: string;
}

export interface SupplierRefundResultDto extends SupplierRefundDto {
  replayed: boolean;
  businessTransactionId: string;
}

/**
 * `GET /v1/purchases/:purchaseId/settlements` — requires `suppliers.view` and
 * the purchase warehouse's scope: the payment allocations and credit
 * allocations applied to the purchase, oldest first.
 */
export interface PurchaseSettlementsDto {
  purchaseId: string;
  currency: string;
  payments: (SupplierPaymentAllocationDto & { paymentId: string; paymentDate: string })[];
  creditAllocations: SupplierCreditAllocationDto[];
}

/** The answer of `POST /v1/purchases/:purchaseId/receive-and-pay`: both halves, read from stored rows. */
export interface ReceiveAndPayResultDto {
  purchaseId: string;
  replayed: boolean;
  businessTransactionId: string;
  /** The receipt half, exactly as `POST …/receive` answers it. */
  receipt: PurchaseReceiptDto;
  payment: SupplierPaymentDto;
}
