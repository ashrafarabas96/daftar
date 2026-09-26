import { randomUUID } from 'node:crypto';

declare const businessTransactionBrand: unique symbol;

/**
 * `business_transaction_id` (P3-AL-35): the one id that ties together
 * everything a single user operation produces — its source documents, its
 * stock movements, its journal entry, its audit events and its outbox events —
 * so the operation can be reconstructed across domains without relying on
 * timestamps.
 *
 * It is OBSERVABILITY, never authority. No invariant, idempotency check,
 * balance or financial decision may depend on it, and no command may look a
 * financial fact up by it. The brand exists so a signature can say "this is a
 * trace id minted at the boundary", not so the value can be trusted for
 * anything.
 */
export type BusinessTransactionId = string & { readonly [businessTransactionBrand]: true };

/**
 * Mint the trace id for one user operation.
 *
 * Called exactly once per operation, by the merchant controller that receives
 * it — the API boundary — and passed down explicitly from there. It is a fresh
 * random UUID and takes no input: it is never derived from the request id, an
 * `Idempotency-Key` or any other value a client controls.
 */
export function newBusinessTransactionId(): BusinessTransactionId {
  return randomUUID() as BusinessTransactionId;
}
