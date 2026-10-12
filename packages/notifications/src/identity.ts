/**
 * TL-P8-R2 — THREE identities, and no two of them are the same string.
 *
 *   1. OBLIGATION    origin + kind + recipient
 *      "this recipient is owed this notification, once."
 *
 *   2. LOGICAL DELIVERY   obligation + channel [+ stable provider/template context]
 *      "this is the one intended send of that obligation on that channel."
 *      It is STABLE across every retry of the same intended send. Where a
 *      provider offers real server-side idempotency, THIS is the key handed to
 *      it — never an attempt key.
 *
 *   3. ATTEMPT       logical delivery + attempt number
 *      "the n-th time we tried." AUDIT HISTORY ONLY. An attempt number is NOT
 *      an external idempotency authority.
 *
 * Why three and not two (PART 42, a HIGH finding against the earlier design):
 * the earlier code passed the attempt identity to the provider as its
 * idempotency key. That key changes with the attempt number, so a request that
 * times out AFTER Meta accepted it, retried under a new attempt key, is a
 * second message to the customer. The stable layer between "owed" and "n-th
 * try" is what makes a retry recognisable as the same send.
 *
 * Why not one key (TL-P8-R1, still standing): one event can owe ten recipients.
 * An origin-only key collapses them into one, and nine people are never told by
 * the very mechanism meant to stop one double receipt.
 *
 * Every identity derives from stable facts only — never a clock, never a random
 * value. The provider's own message id is assigned after an attempt and is
 * recorded beside it, so it can never be an input to the decision to send.
 */
import type { Channel, RecipientRef } from './types';
import { recipientId } from './types';

/** Where an obligation came from. Exactly one of the two shapes. */
export type NotificationOrigin =
  | { readonly source: 'event'; readonly eventId: string }
  /** `occurrenceKey` is the configured schedule's own occurrence (e.g. the
   *  period it covers). It is supplied by the automation layer, never derived
   *  from a clock here, so a re-run of the same occurrence is the same key. */
  | { readonly source: 'schedule'; readonly scheduleId: string; readonly occurrenceKey: string };

function originKey(origin: NotificationOrigin): string {
  return origin.source === 'event' ? `event:${origin.eventId}` : `schedule:${origin.scheduleId}:${origin.occurrenceKey}`;
}

/** (1) Obligation identity: origin + kind + recipient. One per owed notification. */
export function obligationKey(origin: NotificationOrigin, kind: string, recipient: RecipientRef): string {
  return `${originKey(origin)}|${kind}|${recipient.kind}:${recipientId(recipient)}`;
}

/**
 * (2) Logical delivery identity: obligation + channel, plus a stable provider
 * or template context where the provider needs one to recognise the same send
 * (e.g. an approved template name). The context must itself be stable across
 * retries — a value that changes per attempt would defeat the whole point, so
 * anything empty is simply omitted rather than silently varying the key.
 */
export function deliveryKey(obligation: string, channel: Channel, providerContext?: string): string {
  const context = providerContext === undefined || providerContext === '' ? '' : `@${providerContext}`;
  return `${obligation}::${channel}${context}`;
}

/** (3) Attempt identity: logical delivery + attempt number (1-based). Audit only. */
export function attemptIdentity(delivery: string, attemptNo: number): string {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) throw new Error('attemptNo must be a positive integer');
  return `${delivery}#${attemptNo}`;
}
