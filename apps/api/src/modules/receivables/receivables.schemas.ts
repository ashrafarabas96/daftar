import { z } from 'zod';
import { CUSTOMER_PAYMENT_MAX_ALLOCATIONS, RECEIVABLES_REFERENCE_MAX } from './receivables-payload';

/**
 * The P4-S4 receivables REQUESTS, and only the requests.
 *
 * The result shapes are `receivables-contracts.ts`, which is the one
 * declaration site for them and becomes a single re-export from
 * `@daftar/shared-contracts` on integration. They were here and are not any
 * more: a schema file that also declares the response DTOs gives them two
 * plausible homes, and the one that is not the package quietly wins.
 *
 * Every schema is `.strict()`, exactly as the accepted P3-S4 and P4-S1 schemas
 * are: a tenant, a business, an actor, a trace id, a revision the server owns,
 * a DERIVED amount, a rate, a status or any authority flag is refused as an
 * unknown key. There is no `force`, no `skip*` and no `bypass*` field
 * anywhere.
 *
 * What is REFUSED HERE rather than later, because a field's mere presence is
 * the defect (P4-AL-18 — validating a client's figure against the server's
 * implies the client's could have been adopted):
 *
 * - **no posting account.** `postingAccountId`, `accountId` and `accountCode`
 *   are unknown keys. The GL account is part of the three-column foreign key
 *   into the payment method's own row (`0067:351-354`), so a `(method of A,
 *   account of B)` pair is not representable and the client has nothing to
 *   say about it;
 * - **no rate, no base amount, no release, no dust, no realized FX.** Every
 *   one is derived from a STORED snapshot. `rate`, `fxRate`, `fxRateId`,
 *   `baseAmountMinor`, `releasedBeforeMinor`, `dustMinor` and
 *   `realizedMinor` are unknown keys;
 * - **no outstanding, no remaining.** What an invoice owes is
 *   `invoice_outstanding`'s answer and what a credit has left is the credit
 *   row's; a request that stated either would be stating the cap it is
 *   checked against;
 * - **no `idempotencyKey`.** P4-AL-30: idempotency is the caller-supplied
 *   document UUID plus the stored `intent_sha256`, and `idempotency_key`
 *   "exists nowhere in the commercial schema";
 * - **no tax field.** OD-03 is OPEN and sales tax is structurally zero
 *   (P4-AL-44); a settlement does not touch tax at all.
 *
 * Ids are canonical LOWERCASE uuids, refused otherwise and never lower-cased
 * into acceptance: the intent digest binds the exact spelling.
 *
 * Every date is a REQUIRED input and no service behind one resolves a date
 * from the server's clock (`[[daftar-a-command-must-not-read-the-clock]]`,
 * P4-AL-30): the same retry sent either side of local midnight must be the
 * same command forever.
 *
 * Money is an integer count of MINOR UNITS as a decimal STRING — never a
 * JSON number, which cannot carry 10^18 exactly, and never a major-unit
 * decimal.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** Integer minor units, strictly positive, as a decimal string. No sign, no decimal point, no leading zero. */
const positiveMinor = z.string().regex(/^[1-9][0-9]{0,18}$/, 'an amount is a positive integer count of minor units');

/** `YYYY-MM-DD`, a real calendar date. */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');

/** ISO 4217, upper case. The payment's own currency; the invoice's is the invoice's. */
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be an upper-case ISO 4217 code');

const reference = z
  .string()
  .refine((v) => {
    const length = [...v.trim()].length;
    return length >= 1 && length <= RECEIVABLES_REFERENCE_MAX;
  }, `must be 1..${RECEIVABLES_REFERENCE_MAX} characters`)
  .nullish();

/**
 * One allocation of a collected payment.
 *
 * Two amounts and no third: `paymentAmountMinor` is what this leg consumes of
 * the money received, in the PAYMENT's currency, and
 * `invoiceAmountAppliedMinor` is what it settles, in the INVOICE's. Where the
 * two currencies agree they must be equal, which the plan and the row CHECK
 * both judge. Everything the row additionally stores — the chain position, the
 * carrying release, the dust, the base and the realized FX — is derived from
 * stored snapshots and is not stateable.
 */
const CustomerPaymentAllocationSchema = z
  .object({
    allocationId: uuid,
    invoiceId: uuid,
    paymentAmountMinor: positiveMinor,
    invoiceAmountAppliedMinor: positiveMinor,
  })
  .strict();

/**
 * `POST /v1/customer-payments` — collect a customer payment, allocate it
 * across invoices, and carry any surplus as a customer credit.
 *
 * Four properties of this schema are the contract, not decoration:
 *
 * 1. **`paymentId` is the idempotency key** and `allocations[].allocationId`
 *    are too (R-74). The client mints them; the server never does.
 * 2. **`allocations` may be EMPTY** (OQ-4, in scope). A pure on-account
 *    payment is `allocations: []` with a `creditId`: the whole amount becomes
 *    a customer credit. The supplier precedent forbids this
 *    (`0067:341`, `0067:954-957`); the Customer Credit Law requires it.
 * 3. **`creditId` is stated exactly when there is a surplus.** It is
 *    client-supplied so that the credit a replay returns is the credit the
 *    first attempt created, rather than a second one; a fully-allocated
 *    payment must pass `null`, and the mismatch is refused before anything is
 *    minted. The schema cannot see the surplus (it depends on the invoices'
 *    outstanding), so it admits both and the payload builder judges the pair.
 * 4. **`amountMinor` is the money RECEIVED**, a fact of the document. It is
 *    not "the amount the invoices were paid": what an invoice has been paid is
 *    `invoice_outstanding`'s answer, and no request or column may restate it.
 * 5. **`currencyCode` may be NULL**, meaning "the business's base currency".
 *    The service resolves it from `businesses.base_currency` and binds the
 *    RESOLVED code into the intent digest. That is not a derived figure
 *    leaking into the intent: a business's base currency is immutable, so the
 *    same request digests identically for ever.
 *
 * ## What this schema REFUSES that a caller might send
 *
 * `releasedBeforeMinor`, `carryingReleasedMinor`, `arDustBaseMinor` and
 * `realizedFxMinor` are UNKNOWN KEYS on an allocation, and a body carrying
 * them is refused before the service is reached.
 *
 * This is a deliberate, reported divergence from the figures the P4-S4 golden
 * suite currently sends, and the accepted code is why. «Caller computes, the
 * database re-verifies» (OQ-3, the supplier shape) is a law of the
 * SERVICE→ROUTINE boundary, not of the CLIENT→API boundary: the caller in that
 * sentence is `bindSupplierPayment`, and `supplier_pay` is what re-verifies
 * it. The accepted `POST /v1/supplier-payments` body carries exactly
 * `{ allocationId, purchaseId, paymentAmountMinor, purchaseAmountAppliedMinor }`
 * — four fields, no release, no dust, no realized FX — and
 * `supplier-payment.service.ts` derives the rest from stored snapshots.
 *
 * Accepting them from a client would break two laws at once: P4-AL-18 (a
 * figure the server derives is refused BY NAME, never validated against the
 * server's own, because validating one implies the client's could be adopted),
 * and the request-only intent (`0068:585-600`,
 * `[[daftar-registry-before-state]]`) — a derived figure inside the digest
 * makes an FX movement between two retries a false `idempotency_conflict`
 * instead of the recomputation it should be.
 */
export const CustomerPaymentSchema = z
  .object({
    paymentId: uuid,
    customerId: uuid,
    paymentMethodId: uuid,
    paymentDate: civilDate,
    currencyCode: currencyCode.nullish(),
    amountMinor: positiveMinor,
    reference,
    creditId: uuid.nullish(),
    allocations: z.array(CustomerPaymentAllocationSchema).max(CUSTOMER_PAYMENT_MAX_ALLOCATIONS),
  })
  .strict();

export type CustomerPaymentRequest = z.infer<typeof CustomerPaymentSchema>;

/**
 * `POST /v1/customer-credits/:creditId/applications` — apply an existing
 * customer credit to one of the customer's open invoices.
 *
 * The credit is the PATH, so it is not in the body: one identity, one place.
 * `creditAmountConsumedMinor` is in the credit's currency and
 * `invoiceAmountAppliedMinor` in the invoice's; where they agree they must be
 * equal. The credit's remaining pair, its rate and the invoice's rate are
 * stored facts the routine reads under its own locks.
 *
 * `creditRemainingBeforeMinor`, `creditCarryingReleasedMinor`,
 * `creditDustBaseMinor`, `releasedBeforeMinor`, `carryingReleasedMinor`,
 * `arDustBaseMinor` and `realizedFxMinor` are UNKNOWN KEYS here, for the
 * reason `CustomerPaymentSchema`'s header gives at length: a figure the server
 * derives from a stored snapshot is refused by name, and a derived figure
 * inside a request-only intent digest turns an FX movement between retries
 * into a false conflict.
 */
export const CustomerCreditApplicationSchema = z
  .object({
    applicationId: uuid,
    /**
     * The customer the caller believes owns BOTH the credit and the invoice.
     *
     * A client-stated FACT, not a derived figure, so taking it is lawful — and
     * taking it is strictly better than deriving it, because the service then
     * cross-checks it against the credit's `customer_id` AND the invoice's and
     * refuses `customer_mismatch` on either disagreement. A client that meant
     * a different customer finds out instead of settling someone else's
     * invoice.
     */
    customerId: uuid,
    invoiceId: uuid,
    applicationDate: civilDate,
    creditAmountConsumedMinor: positiveMinor,
    invoiceAmountAppliedMinor: positiveMinor,
  })
  .strict();

export type CustomerCreditApplicationRequest = z.infer<typeof CustomerCreditApplicationSchema>;
