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
import { NotificationRefusal } from './errors';

/** Where an obligation came from. Exactly one of the two shapes. */
export type NotificationOrigin =
  | { readonly source: 'event'; readonly eventId: string }
  /** `occurrenceKey` is the configured schedule's own occurrence (e.g. the
   *  period it covers). It is supplied by the automation layer, never derived
   *  from a clock here, so a re-run of the same occurrence is the same key. */
  | { readonly source: 'schedule'; readonly scheduleId: string; readonly occurrenceKey: string };

/**
 * The separators this module composes keys with. A field carrying one of them
 * could spell a different key, so a field carrying one is REFUSED rather than
 * escaped: escaping adds a decoder, and every reader of these keys — including
 * the database's own UNIQUE constraint and a `ReadonlySet<string>` of recorded
 * obligations — would have to agree on it. Refusing needs no agreement.
 *
 * The challenger found two calls that produced an identical key by moving a
 * `|` from one field to another. With UUID ids it is unreachable; the scheduled
 * path made it reachable, because `occurrenceKey` is free text supplied by the
 * automation layer rather than a generated id.
 */
const KEY_SEPARATORS: readonly string[] = ['|', ':', '::', '#', '@'];

function assertKeyField(name: string, value: string): void {
  if (value === '') throw new NotificationRefusal('notification.obligation_key_field_invalid', `${name}/empty`);
  for (const separator of KEY_SEPARATORS) {
    if (value.includes(separator)) {
      throw new NotificationRefusal('notification.obligation_key_field_invalid', `${name}/separator`);
    }
  }
}

function originKey(origin: NotificationOrigin): string {
  if (origin.source === 'event') {
    assertKeyField('eventId', origin.eventId);
    return `event:${origin.eventId}`;
  }
  assertKeyField('scheduleId', origin.scheduleId);
  assertKeyField('occurrenceKey', origin.occurrenceKey);
  return `schedule:${origin.scheduleId}:${origin.occurrenceKey}`;
}

/**
 * (1) Obligation identity: **business** + origin + kind + recipient. One per
 * owed notification.
 *
 * The business comes FIRST, and that is a correction. The key used to be
 * `origin|kind|recipient` while `types.ts` argued the opposite two files
 * earlier: "`businessId` is part of the recipient, not context around it: a
 * recipient that does not name its business cannot be proven to belong to this
 * tenant." `assertRecipientBelongs` checks the tenant at dispatch time and the
 * DDL's `UNIQUE (business_id, obligation_key)` restores it in the database —
 * but `DispatchPorts.obligationsAlreadyRecorded` is a bare set of these
 * strings, so a caller that assembled it across tenants would suppress a real
 * notification as `already_owed`, and nothing in the type forbade it. A key
 * that carries its own tenant cannot be mixed up by its consumer.
 *
 * The business is a SEPARATE REQUIRED PARAMETER and not read off the recipient,
 * because `RecipientRef` does not carry one — only the fuller `Recipient` does.
 * `types.ts` claimed otherwise directly above that type ("a recipient that does
 * not name its business cannot be proven to belong to this tenant"), which was
 * a fifth instance of a law naming a premise it does not read; the comment is
 * corrected there. Making it a parameter is what stops a caller omitting it.
 */
export function obligationKey(businessId: string, origin: NotificationOrigin, kind: string, recipient: RecipientRef): string {
  assertKeyField('businessId', businessId);
  assertKeyField('kind', kind);
  assertKeyField('recipient', recipientId(recipient));
  return `${businessId}|${originKey(origin)}|${kind}|${recipient.kind}:${recipientId(recipient)}`;
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
