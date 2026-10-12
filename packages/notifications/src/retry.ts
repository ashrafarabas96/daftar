/**
 * Retry policy. Mirrors apps/api/src/modules/outbox/publisher.ts rather than
 * inventing a second backoff: capped exponential, dead-letter at the limit,
 * and NEVER a silent drop. A transient class retries; a terminal class
 * (auth, rejected recipient, rejected template) dead-letters on the first
 * failure, because retrying it only burns the provider's rate limit.
 *
 * PART 44 narrowed this module's authority. `nextStepAfterFailure` answers only
 * for a PROVEN REJECTION — a result the provider definitively did not accept.
 * It must never be asked about an ambiguous outcome: an `unknown` has no retry
 * step at all, and `delivery.ts` (`mayAutoRetry`, `classifySend`) is the single
 * place allowed to decide a resend. Routing an ambiguous timeout through a
 * failure policy is exactly how a customer gets the message twice.
 */
import { isTransient, type ProviderErrorCode } from './redaction';

export const MAX_ATTEMPTS = 8;

/** attempts already made → seconds until the next attempt (capped at one hour). */
export function backoffSeconds(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error('attempts must be a non-negative integer');
  return Math.min(2 ** attempts * 5, 3600);
}

/**
 * Why a delivery stopped. The CAUSE is decided here, where the policy lives,
 * and not inferred by whoever reads the result — third challenge, N-8. Carrying
 * only the error code made an exhausted retry schedule and a first-attempt
 * terminal class report the same shape, so an operator had to know the class
 * table to tell them apart. That is the same inference the second challenge
 * objected to in the other direction, when a constant "attempt limit reached"
 * was reported for a rejection that never reached the limit.
 */
export type StopCause =
  /** the class is not worth retrying at all; the attempt number is incidental */
  | 'terminal_class'
  /** a transient class that ran out of attempts */
  | 'attempt_limit';

export type NextStep =
  | { readonly step: 'retry'; readonly attempts: number; readonly afterSeconds: number }
  | { readonly step: 'dead'; readonly attempts: number; readonly reason: ProviderErrorCode; readonly cause: StopCause };

/** Limits a caller may inject, so there is one policy and not one per caller. */
export interface RetryLimits {
  readonly maxAttempts?: number;
  readonly backoff?: (attempts: number) => number;
}

/**
 * For a PROVEN rejection only (`{ outcome: 'rejected' }`). `retryable` on the
 * result and `isTransient` on the class must agree; where an adapter says a
 * class is not retryable, the caller stops regardless of what this returns.
 *
 * PART 8, single authority: this is the ONE rejection policy, and
 * `classifySend` asks it rather than carrying a second copy. It used to carry
 * one — the same two rules written twice, which the challenger found uncalled
 * from `src/` and therefore unable to disagree visibly. `attemptsBefore` is the
 * number of attempts made BEFORE the one that just failed, and `limits` is how
 * `DispatchPorts.maxAttempts` reaches the policy instead of forking it.
 */
export function nextStepAfterFailure(attemptsBefore: number, code: ProviderErrorCode, limits: RetryLimits = {}): NextStep {
  const max = limits.maxAttempts ?? MAX_ATTEMPTS;
  const backoff = limits.backoff ?? backoffSeconds;
  const attempts = attemptsBefore + 1;
  if (!isTransient(code)) return { step: 'dead', attempts, reason: code, cause: 'terminal_class' };
  if (attempts >= max) return { step: 'dead', attempts, reason: code, cause: 'attempt_limit' };
  return { step: 'retry', attempts, afterSeconds: backoff(attempts) };
}
