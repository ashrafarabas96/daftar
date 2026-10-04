/**
 * Customer settlement — P4-S4: collecting a customer payment, and applying an
 * existing customer credit to an invoice. The exact mirror of
 * `supplier-settlement.ts`, with the supplier's credit note replaced by the
 * customer's credit and AP by AR.
 *
 * The P3-S6 settlement conventions hold unchanged:
 *
 * - every amount is an integer STRING of MINOR units (`amountMinor: "12500"`),
 *   never major units and never a JSON number;
 * - `…Minor` in a payment currency is in that currency's minor units;
 *   `invoiceAmountAppliedMinor` is in the INVOICE currency;
 *   `creditAmountConsumedMinor` is in the credit's currency; every `…BaseMinor`
 *   is in the business's base currency. Two amounts in different currencies are
 *   never compared: their base difference is realized FX;
 * - when the two currencies are equal the two amounts must be equal
 *   (`….amount_mismatch`, 422);
 * - every document id is a client-chosen canonical LOWERCASE uuid and is the
 *   idempotency key: resending the same command answers the stored result with
 *   `replayed: true`; the same id with a different command is
 *   `….idempotency_conflict` (409);
 * - `….settlement_changed` / `….fx_rate_changed` (409) are the optimistic
 *   refusals — another settlement moved the invoice, or a rate was stated
 *   meanwhile — and the client retries the SAME body. The cap is never
 *   silently adjusted to fit;
 * - tax is BLOCKED BY OD-03: no request here has a tax field.
 *
 * Two differences from the supplier side, both deliberate:
 *
 * 1. a customer payment need NOT be fully allocated. A payment may allocate
 *    nothing at all, and the whole unallocated surplus becomes a CUSTOMER
 *    CREDIT reported as `CustomerPaymentDto.credit`. The closure law is in the
 *    PAYMENT's currency and is a sum of commensurable quantities:
 *    `Σ paymentAmountMinor + the credit created = amountMinor`. It is NOT
 *    stated over `invoiceAmountAppliedMinor`: that figure is in the INVOICE's
 *    currency (see the unit rules above), so the moment the two currencies
 *    differ such a sum compares amounts in different units — which the rule
 *    four lines up forbids outright. The base identity is the same shape in
 *    the base currency, `Σ paymentBaseAmountMinor + the credit's carrying base
 *    = baseAmountMinor`, and the accepted supplier closure (`0067:950-955`)
 *    sums the payment-currency column for this reason;
 * 2. a WALK-IN invoice (one with no customer on it) can carry neither an
 *    allocation nor a credit application: `….invoice_walkin` (409).
 *
 * The merchant never reads the words in this file. The refusal codes above are
 * rendered from `error.customer_payment.*`, `error.customer_credit_application.*`
 * and `error.customer_credit.not_found` in the three locale catalogues.
 */

// ── Reported shapes ──────────────────────────────────────────────────────

/** One allocation of a collected payment to one invoice, as the API reports it. */
export interface CustomerPaymentAllocationDto {
  readonly allocationId: string;
  readonly lineNo: number;
  readonly invoiceId: string;
  readonly invoiceCurrencyCode: string;
  readonly paymentAmountMinor: string;
  readonly invoiceAmountAppliedMinor: string;
}

/**
 * A customer credit, as the API reports it: both halves of the remaining pair,
 * and no status. A credit is exhausted exactly when `remainingAmountMinor` is
 * `"0"`; there is no stored flag to disagree with it.
 */
export interface CustomerCreditDto {
  readonly creditId: string;
  readonly customerId: string;
  readonly currencyCode: string;
  readonly originalAmountMinor: string;
  readonly remainingAmountMinor: string;
  readonly remainingCarryingBaseAmountMinor: string;
  readonly creditDate: string;
}

/** The answer of `POST /v1/customer-payments`, and of its read. */
export interface CustomerPaymentDto {
  readonly paymentId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly paymentDate: string;
  readonly currencyCode: string;
  readonly amountMinor: string;
  readonly reference: string | null;
  readonly allocations: readonly CustomerPaymentAllocationDto[];
  /** The surplus credit this payment created, or null when it was fully allocated. */
  readonly credit: CustomerCreditDto | null;
}

export interface CustomerPaymentResultDto extends CustomerPaymentDto {
  /** True when the command answered a replay and wrote nothing (200, not 201). */
  readonly replayed: boolean;
}

/** The answer of `POST /v1/customer-credits/:creditId/applications`. */
export interface CustomerCreditApplicationResultDto {
  readonly applicationId: string;
  readonly creditId: string;
  readonly invoiceId: string;
  readonly applicationDate: string;
  readonly consumedMinor: string;
  readonly invoiceAmountAppliedMinor: string;
  /** The credit's remaining pair AFTER the application. */
  readonly creditRemainingAmountMinor: string;
  readonly creditRemainingCarryingBaseAmountMinor: string;
  readonly replayed: boolean;
}
