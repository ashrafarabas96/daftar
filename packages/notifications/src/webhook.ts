/**
 * §42 — WEBHOOK SAFETY.
 *
 * Three rules, in this order, before a provider callback is allowed to move a
 * delivery state:
 *
 *  1. VERIFY FIRST. An unverified callback may be RECORDED for forensics, and
 *     it may never drive state. Anyone can post to a webhook URL; a status
 *     transition is an assertion about what a customer saw.
 *  2. REPLAY IS NOT AN EVENT. Providers redeliver. Where the provider gives its
 *     own event identity, a second arrival of the same identity applies
 *     nothing — not a second transition, not a second side effect.
 *  3. THE MACHINE STAYS MONOTONIC. Even a verified, fresh callback may only
 *     move forward (`status.ts`), so an out-of-order `sent` after a `read`
 *     changes nothing.
 *
 * The provider's own body never becomes persisted sensitive data: only its
 * status token and the verification verdict are kept.
 */
import { applyStatus, type DeliveryStatus } from './status';

export interface ProviderCallback {
  readonly providerMessageId: string;
  readonly status: string;
  readonly signatureVerified: boolean;
  /** The provider's event id, where it offers one. */
  readonly providerEventId?: string;
}

export type CallbackVerdict =
  | { readonly action: 'applied'; readonly status: DeliveryStatus }
  /** Kept for forensics; no state moved. */
  | {
      readonly action: 'recorded_only';
      readonly reason: 'signature_unverified' | 'duplicate_event' | 'status_unknown' | 'status_regression' | 'duplicate_status';
    };

export interface CallbackContext {
  readonly current: DeliveryStatus;
  /** Provider event ids already applied for this notification. */
  readonly appliedEventIds?: ReadonlySet<string>;
}

export function applyProviderCallback(callback: ProviderCallback, context: CallbackContext): CallbackVerdict {
  if (!callback.signatureVerified) return { action: 'recorded_only', reason: 'signature_unverified' };

  const eventId = callback.providerEventId;
  if (eventId !== undefined && eventId !== '' && context.appliedEventIds?.has(eventId) === true) {
    return { action: 'recorded_only', reason: 'duplicate_event' };
  }

  const transition = applyStatus(context.current, callback.status);
  if (transition.applied) return { action: 'applied', status: transition.status };
  if (transition.reason === 'duplicate') return { action: 'recorded_only', reason: 'duplicate_status' };
  if (transition.reason === 'notification.status_unknown') return { action: 'recorded_only', reason: 'status_unknown' };
  return { action: 'recorded_only', reason: 'status_regression' };
}
