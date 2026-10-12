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
import { arrivalWasRecorded } from './status';
import { nextStepAfterFailure, type StopCause } from './retry';

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
  | 'closed'
  /**
   * Terminal, and nothing was attempted: an earlier channel of this obligation
   * holds an attempt that may still land (Mission §15). Recorded rather than
   * omitted — a channel absent from the ledger looks unconfigured.
   */
  | 'withheld'
  /**
   * Terminal, and nothing was attempted: a gate refused this channel before
   * any provider call (consent, eligibility, address, render, limits).
   *
   * Mission V3 named the conflict this resolves: the DDL spec's state list
   * carried `withheld` and `suppressed` while this type did not, so the schema
   * held two states no code path could write and this type reasoned over seven
   * where the database held nine. One vocabulary, both sides.
   */
  | 'suppressed';

/**
 * PART 46: these states are OPEN WORK. A caller that asks "is anything left to
 * do for this obligation?" must get `true` for every one of them — including
 * `unknown`, whose work is reconciliation rather than sending.
 */
const OPEN: readonly DeliveryState[] = ['queued', 'sending', 'unknown', 'retry_scheduled'];

export function isOpenWork(state: DeliveryState): boolean {
  return OPEN.includes(state);
}

/** Every state, so a test can prove a new one was classified rather than forgotten. */
export const ALL_DELIVERY_STATES: readonly DeliveryState[] = [
  'queued',
  'sending',
  'accepted',
  'unknown',
  'retry_scheduled',
  'dead',
  'closed',
  'withheld',
  'suppressed',
];

/** The provider's last word on a delivery it had accepted. */
export type FinalProviderStatus = 'delivered' | 'read' | 'failed';

/**
 * Mission V3 §15 — WHICH states forbid opening another channel of the same
 * obligation. This is the application-side twin of the partial unique index the
 * migration patch request asks for, so the rule is executable here and not only
 * asserted in a spec nobody can run.
 *
 * It is also the rule the dispatcher ASKS — which it was not until the
 * independent challenge pointed out that this function had no caller in `src/`
 * at all, while this header already described it as the executable twin. The
 * send path had its own copy of the decision, so the rule V3 corrected was not
 * the rule that ran; the two agreed only by coincidence. `L-F5-1` in
 * `test/part42-source-laws.test.ts` now reds if the dispatcher stops asking,
 * because a behavioural test cannot tell two agreeing copies apart.
 *
 * V3's finding: the index's predicate listed the OPEN states only, so it did
 * not constrain an `accepted` delivery — the very case where a second message
 * is most harmful, and the one a replay or a hand-written INSERT would hit.
 * Worse, an inclusion list fails OPEN: a state added later is outside it and
 * silently permits a duplicate. So the rule is stated as the SHORT list of
 * states that release the obligation, and everything else blocks.
 *
 * `closed` is split, because it collapses two opposite facts. A delivery closed
 * on `delivered`/`read` was received, so another channel would duplicate it. A
 * delivery closed on `failed` was accepted and then reported NOT delivered, so
 * the notification is still owed and a fallback yields exactly one message —
 * the same reasoning that lets a `dead` rejection fall through.
 *
 * And that release requires a **verified** landing: an unverified callback
 * claiming `failed` would let an attacker manufacture a second message, which
 * is the mirror of the attack I-12b already refuses in the other direction.
 */
const RELEASES_THE_OBLIGATION: readonly DeliveryState[] = ['dead', 'withheld', 'suppressed'];

export interface ChannelBlockInput {
  readonly state: DeliveryState;
  /** The provider's final status, where the state is `closed`. */
  readonly finalStatus?: FinalProviderStatus;
  /** Whether that final status arrived on a VERIFIED provider landing. */
  readonly finalStatusVerified?: boolean;
}

export function blocksAnotherChannel(input: ChannelBlockInput): boolean {
  const { state, finalStatus, finalStatusVerified } = input;
  if (RELEASES_THE_OBLIGATION.includes(state)) return false;
  if (state === 'closed' && finalStatus === 'failed' && finalStatusVerified === true) {
    // The premise, READ rather than assumed: this release is only safe while a
    // `failed` status is unreachable after an arrival. `status.ts` guarantees
    // that by ranking `failed` below `delivered`; if someone reorders that
    // ladder, this release stops happening instead of silently producing the
    // duplicate the challenger proved. Fail closed on a changed premise.
    if (arrivalWasRecorded('failed')) return true;
    return false;
  }
  // Fail closed: anything not named above blocks, including a state added to
  // this union later and a value that reached here from untyped JavaScript.
  return true;
}

/** What the worker should do next. `reconcile` never means "send again". */
export type DeliveryAction =
  | { readonly action: 'none' }
  | { readonly action: 'retry'; readonly afterSeconds: number }
  /** Ask the provider what happened, or wait for a verified callback. */
  | { readonly action: 'reconcile'; readonly reason: string }
  /**
   * `cause` and `attempts` are carried because `reason` alone cannot say
   * whether the schedule was exhausted or the class was never retryable
   * (third challenge, N-8). `cause` comes from `retry.ts`, which owns the
   * policy, rather than being re-derived from the code here.
   */
  | { readonly action: 'stop'; readonly reason: string; readonly cause: StopCause; readonly attempts: number };

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
    if (attemptsMade >= maxAttempts) {
      return {
        state: 'unknown',
        next: { action: 'stop', reason: 'attempt limit reached while the outcome is unknown', cause: 'attempt_limit', attempts: attemptsMade },
      };
    }
    return { state: 'retry_scheduled', next: { action: 'retry', afterSeconds: backoffSeconds(attemptsMade) } };
  }

  // TWO vetoes, and either one stops the delivery. Stated explicitly because
  // the second challenge found the comment here claiming the adapter's flag was
  // "the narrower of the two" after delegation had made them independent:
  //
  //  1. the ADAPTER's `retryable` — it saw the actual response;
  //  2. the CLASS policy in `retry.ts` (`isTransient`) — it knows which error
  //     classes are worth retrying at all.
  //
  // `retry.ts`'s docstring says the two must agree. Where they disagree the
  // delivery stops, which is the safe direction and is now what the code does
  // rather than what a comment claimed.
  // The ADAPTER's veto. It is a terminal class by the adapter's own reading of
  // the response, whatever attempt number it arrived on.
  if (!result.retryable) {
    return { state: 'dead', next: { action: 'stop', reason: result.code, cause: 'terminal_class', attempts: attemptsMade } };
  }
  // PART 8, single authority: the attempt limit and the backoff live in
  // `retry.ts`, and this asks them. The two used to be written out here as
  // well — the same policy twice, with nothing holding the copies together.
  const step = nextStepAfterFailure(attemptsMade - 1, result.code, { maxAttempts, backoff: backoffSeconds });
  if (step.step === 'dead') {
    // The reason is CARRIED, never substituted. This returned the constant
    // "attempt limit reached" for every dead rejection, so a delivery stopped
    // by its error class on attempt 1 of 8 reported a limit that was nowhere
    // near reached — a falsehood in the one field an operator reads to find out
    // why a customer was not told something.
    return { state: 'dead', next: { action: 'stop', reason: step.reason, cause: step.cause, attempts: step.attempts } };
  }
  return { state: 'retry_scheduled', next: { action: 'retry', afterSeconds: step.afterSeconds } };
}

/** Why a reconciliation settled nothing. Each one implies different next work. */
export type ReconciliationGap =
  | 'signature_unverified'
  | 'provider_message_id_mismatch'
  | 'provider_message_id_never_learned'
  | 'lookup_failed'
  | 'lookup_unsupported';

/** How an `unknown` was resolved, once something authoritative arrived. */
export type Reconciliation =
  /** A lookup or a verified callback proves the provider has the message. */
  | { readonly found: true; readonly providerMessageId: string }
  /** The provider authoritatively has no such message: nothing was sent. */
  | { readonly found: false }
  /**
   * Nothing authoritative arrived about THIS delivery — still unknown.
   *
   * `reason` is required because the three ways of being inconclusive need
   * different work: an unverified callback is discarded, a mismatched one
   * belongs to another delivery and must not be applied to this one, and an id
   * that was never learned can only be settled by a provider status LOOKUP —
   * no callback can ever settle it, so a worker that waits for one waits
   * forever.
   */
  | { readonly inconclusive: true; readonly reason: ReconciliationGap };

export function resolveUnknown(reconciliation: Reconciliation): SendOutcome {
  if ('inconclusive' in reconciliation) {
    // The reason is carried through, so the queue entry says what would settle
    // it. `provider_message_id_never_learned` in particular is NOT waiting for
    // a callback: it needs a lookup by the recipient and the send window.
    return { state: 'unknown', next: { action: 'reconcile', reason: reconciliation.reason } };
  }
  if (reconciliation.found) {
    // It WAS sent. The obligation is discharged; no resend, ever.
    return { state: 'accepted', next: { action: 'none' } };
  }
  // Proven not sent: now, and only now, a resend of the same logical delivery
  // is a first send rather than a duplicate.
  return { state: 'retry_scheduled', next: { action: 'retry', afterSeconds: 0 } };
}
