/**
 * PART 46 — the delivery state machine, kept SEPARATE from obligation creation.
 *
 * "An obligation exists" and "the delivery is complete" are different facts.
 * Conflating them is how a queued, retryable or ambiguous delivery gets treated
 * as finished work: the dedupe sees the obligation, concludes there is nothing
 * to do, and the customer is never told.
 *
 * The four concerns the directive requires separately:
 *   A. obligation creation / dedup   → identity.ts + the ledger's unique index
 *   B. delivery state machine        → THIS module
 *   C. attempts                      → attempt identity, append-only history
 *   D. provider callbacks            → webhook.ts
 *
 * PART 44 lives here too, as a function rather than a paragraph: `mayAutoRetry`
 * is the only place that decides a resend, and it answers "no" for an ambiguous
 * result unless the provider's own semantics make a resend harmless.
 */
import type { ProviderSendResult } from './provider';

export type DeliveryState =
  /** Owed, nothing attempted. */
  | 'queued'
  /** An attempt is in flight (a worker holds a lease). */
  | 'sending'
  /** The provider accepted it with a valid id; its final status will follow. */
  | 'accepted'
  /** It may or may not have been sent. NEVER auto-resend from here. */
  | 'unknown'
  /** Proven not sent; a retry of the SAME logical delivery is due. */
  | 'retry_scheduled'
  /** Terminal: no further attempt will be made. */
  | 'dead'
  /** Terminal: the provider reported a final status (delivered/read/failed). */
  | 'closed';

/**
 * PART 46: these states are OPEN WORK. A caller that asks "is anything left to
 * do for this obligation?" must get `true` for every one of them — including
 * `unknown`, whose work is reconciliation rather than sending.
 */
const OPEN: readonly DeliveryState[] = ['queued', 'sending', 'unknown', 'retry_scheduled'];

export function isOpenWork(state: DeliveryState): boolean {
  return OPEN.includes(state);
}

/** What the worker should do next. `reconcile` never means "send again". */
export type DeliveryAction =
  | { readonly action: 'none' }
  | { readonly action: 'retry'; readonly afterSeconds: number }
  /** Ask the provider what happened, or wait for a verified callback. */
  | { readonly action: 'reconcile'; readonly reason: string }
  | { readonly action: 'stop'; readonly reason: string };

export interface SendOutcome {
  readonly state: DeliveryState;
  readonly next: DeliveryAction;
}

/**
 * PART 44 — the only gate that authorises a resend.
 *
 * An ambiguous result is resendable ONLY if the provider's own semantics make a
 * second identical send harmless, which in practice means a real server-side
 * idempotency key. Everything else is reconciled, by a status lookup or a
 * verified callback, or escalated to an operator.
 */
export function mayAutoRetry(result: ProviderSendResult, providerServerSideIdempotency: boolean): boolean {
  if (result.outcome === 'accepted') return false;
  if (result.outcome === 'rejected') return result.retryable;
  return providerServerSideIdempotency;
}

export interface ClassifyInput {
  readonly result: ProviderSendResult;
  readonly providerServerSideIdempotency: boolean;
  readonly attemptsMade: number;
  readonly maxAttempts: number;
  readonly backoffSeconds: (attempts: number) => number;
}

/** Fold one send result into the next delivery state and the next action. */
export function classifySend(input: ClassifyInput): SendOutcome {
  const { result, providerServerSideIdempotency: idempotent, attemptsMade, maxAttempts, backoffSeconds } = input;

  if (result.outcome === 'accepted') return { state: 'accepted', next: { action: 'none' } };

  if (result.outcome === 'unknown') {
    if (!mayAutoRetry(result, idempotent)) {
      return { state: 'unknown', next: { action: 'reconcile', reason: result.reason } };
    }
    if (attemptsMade >= maxAttempts) return { state: 'unknown', next: { action: 'stop', reason: 'attempt limit reached while the outcome is unknown' } };
    return { state: 'retry_scheduled', next: { action: 'retry', afterSeconds: backoffSeconds(attemptsMade) } };
  }

  if (!result.retryable) return { state: 'dead', next: { action: 'stop', reason: result.code } };
  if (attemptsMade >= maxAttempts) return { state: 'dead', next: { action: 'stop', reason: 'attempt limit reached' } };
  return { state: 'retry_scheduled', next: { action: 'retry', afterSeconds: backoffSeconds(attemptsMade) } };
}

/** How an `unknown` was resolved, once something authoritative arrived. */
export type Reconciliation =
  /** A lookup or a verified callback proves the provider has the message. */
  | { readonly found: true; readonly providerMessageId: string }
  /** The provider authoritatively has no such message: nothing was sent. */
  | { readonly found: false }
  /** The lookup itself failed or is unsupported — still unknown. */
  | { readonly inconclusive: true };

export function resolveUnknown(reconciliation: Reconciliation): SendOutcome {
  if ('inconclusive' in reconciliation) {
    return { state: 'unknown', next: { action: 'reconcile', reason: 'reconciliation inconclusive' } };
  }
  if (reconciliation.found) {
    // It WAS sent. The obligation is discharged; no resend, ever.
    return { state: 'accepted', next: { action: 'none' } };
  }
  // Proven not sent: now, and only now, a resend of the same logical delivery
  // is a first send rather than a duplicate.
  return { state: 'retry_scheduled', next: { action: 'retry', afterSeconds: 0 } };
}
