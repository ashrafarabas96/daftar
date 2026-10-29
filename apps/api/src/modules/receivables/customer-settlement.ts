/**
 * The AR settlement arithmetic of P4-S4, re-exported.
 *
 * The arithmetic is declared ONCE, in
 * `packages/inventory/src/customer-settlement.ts`, and held there to
 * `packages/inventory/vectors/customer-settlement-vectors.json` the way
 * `supplier-settlement.ts:18-20` is held to its own vectors. This module keeps
 * the import path the services, the posting command and
 * `receivables-errors.ts` already use, so the single declaration site costs no
 * churn in the module that consumes it — the same one-line-swap device as
 * `receivables-contracts.ts`, for the same reason.
 *
 * What the package module reconciled, and why, is recorded in its own header:
 * this file's former body and the package's `customer-settlement-payloads.ts`
 * were two independent implementations of one arithmetic, and there is now
 * exactly one. The names, the fifteen refusal codes and the entry-line order
 * are the ones this file previously carried — that is what
 * `receivables-errors.ts`' `RECEIVABLES_STATUS` classifies and what
 * `RECEIVABLES_PLAN_CODES_ARE_REGISTERED` binds at compile time — so no other
 * file in this directory changes. The two behaviours that did change are the
 * `totalBaseMinor` floor (`1n` → `0n`, the accepted `apSide` precedent) and
 * the 0..50 allocation cap, now enforced in the plan layer as well as in
 * `receivables.schemas.ts`.
 */
export {
  ReceivableArithmeticError,
  RECEIVABLE_ARITHMETIC_CODES,
  CUSTOMER_PAYMENT_MAX_ALLOCATIONS,
  isReceivableArithmeticCode,
  planCustomerPaymentAllocation,
  planCustomerCreditCreation,
  planCustomerCreditApplication,
  planCustomerPayment,
  assertPaymentClosure,
  paymentSurplusMinor,
} from '@daftar/inventory';
export type {
  ReceivableArithmeticCode,
  ReceivableConversion,
  ReceivableAccount,
  ReceivableEntryLine,
  InvoiceArState,
  CustomerCreditState,
  CustomerPaymentAllocationInput,
  CustomerPaymentAllocationPlan,
  CustomerCreditCreationInput,
  CustomerCreditCreationPlan,
  CustomerCreditApplicationInput,
  CustomerCreditApplicationPlan,
  CustomerPaymentLegInput,
  CustomerPaymentInput,
  CustomerPaymentPlan,
} from '@daftar/inventory';
