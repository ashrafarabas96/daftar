/**
 * Retry policy. Mirrors apps/api/src/modules/outbox/publisher.ts rather than
 * inventing a second backoff: capped exponential, dead-letter at the limit,
 * and NEVER a silent drop. A transient class retries; a terminal class
 * (auth, rejected recipient, rejected template) dead-letters on the first
 * failure, because retrying it only burns the provider's rate limit.
 */
import { isTransient, type ProviderErrorCode } from './redaction';

export const MAX_ATTEMPTS = 8;

/** attempts already made → seconds until the next attempt (capped at one hour). */
export function backoffSeconds(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error('attempts must be a non-negative integer');
  return Math.min(2 ** attempts * 5, 3600);
}

export type NextStep =
  | { readonly step: 'retry'; readonly attempts: number; readonly afterSeconds: number }
  | { readonly step: 'dead'; readonly attempts: number; readonly reason: ProviderErrorCode };

export function nextStepAfterFailure(attemptsBefore: number, code: ProviderErrorCode): NextStep {
  const attempts = attemptsBefore + 1;
  if (!isTransient(code)) return { step: 'dead', attempts, reason: code };
  if (attempts >= MAX_ATTEMPTS) return { step: 'dead', attempts, reason: code };
  return { step: 'retry', attempts, afterSeconds: backoffSeconds(attempts) };
}
