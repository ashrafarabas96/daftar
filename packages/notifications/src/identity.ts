/**
 * TL-P8-R1 — TWO IDEMPOTENCY IDENTITIES, and they are never the same string.
 *
 *   OBLIGATION IDENTITY   origin + kind + recipient
 *     "this recipient is owed this notification, once."
 *
 *   ATTEMPT IDENTITY      obligation + channel + attempt number
 *     "this is the n-th time we tried to hand that obligation to a provider
 *      on that channel."
 *
 * Why the separation is a correctness requirement and not tidiness: one event
 * can owe ten recipients. Under an event-only key, nine of them vanish behind
 * the first — the dedupe that was meant to prevent a double receipt silently
 * prevents nine notifications instead. Under an obligation-only key, a retry on
 * a second channel looks like the same send and cannot be distinguished in the
 * attempt history.
 *
 * Both are derived from stable facts — the origin row, the kind, the recipient,
 * the channel, the attempt number. Never a clock, never a random value. The
 * provider's own delivery id is NOT part of either: it is assigned by the
 * provider after the attempt and is recorded beside it, so it can never be an
 * input to the decision of whether to send.
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

/** Obligation identity: origin + kind + recipient. One per owed notification. */
export function obligationKey(origin: NotificationOrigin, kind: string, recipient: RecipientRef): string {
  return `${originKey(origin)}|${kind}|${recipient.kind}:${recipientId(recipient)}`;
}

/** Attempt identity: obligation + channel + attempt number (1-based). */
export function attemptIdentity(obligation: string, channel: Channel, attemptNo: number): string {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) throw new Error('attemptNo must be a positive integer');
  return `${obligation}#${channel}#${attemptNo}`;
}
