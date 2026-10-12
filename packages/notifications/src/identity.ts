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
 * The separators these keys are composed with. A field carrying one could spell
 * a different key, so a field carrying one is REFUSED rather than escaped:
 * escaping adds a decoder, and every reader of these keys — the database's own
 * UNIQUE constraint and a `ReadonlySet<string>` of recorded obligations
 * included — would have to agree on it. Refusing needs no agreement.
 *
 * The first challenge found two calls producing an identical key by moving a
 * `|` from one field to another. With UUID ids that is unreachable; the
 * scheduled path made it reachable, because `occurrenceKey` is free text from
 * the automation layer rather than a generated id.
 *
 * **`:` is legal in an occurrence key, and nowhere else — CORRECTED after the
 * second challenge.** Refusing it everywhere was a blanket rule that broke the
 * single most obvious occurrence value: an ISO-8601 timestamp. `2026-10-12T00:00`
 * is the natural key for a monthly statement run, and a rule that refuses the
 * canonical spelling of a period does not make the system safer, it makes the
 * automation layer invent a private format.
 *
 * It is safe for exactly one reason, and the reason is structural rather than a
 * judgement: the occurrence is the LAST field of its segment, and every field
 * that can precede it — `schedule` and the schedule id — is itself `:`-free. So
 * `schedule:<scheduleId>:<occurrence>` has its first two colons in fixed
 * positions and everything after the second belongs to the occurrence, however
 * many colons it contains. The segment ends at a `|`, which no field may carry.
 * `::`, `#` and `@` stay refused in every field including this one, because
 * `deliveryKey` and `attemptIdentity` append `::channel`, `@context` and `#n`
 * AFTER the obligation key — a `::` inside an occurrence would make a DELIVERY
 * key ambiguous even while the obligation key stayed sound.
 */
const SEPARATORS_REFUSED_EVERYWHERE: readonly string[] = ['|', '::', '#', '@'];
/** Refused in every field except the terminal occurrence key. See above. */
const SEGMENT_SEPARATOR = ':';

function assertKeyField(name: string, value: string, options?: { readonly allowSegmentSeparator?: boolean }): void {
  if (value === '') throw new NotificationRefusal('notification.obligation_key_field_invalid', `${name}/empty`);
  for (const separator of SEPARATORS_REFUSED_EVERYWHERE) {
    if (value.includes(separator)) {
      throw new NotificationRefusal('notification.obligation_key_field_invalid', `${name}/separator`);
    }
  }
  if (options?.allowSegmentSeparator !== true && value.includes(SEGMENT_SEPARATOR)) {
    throw new NotificationRefusal('notification.obligation_key_field_invalid', `${name}/separator`);
  }
}

/**
 * Check an origin's key fields WITHOUT composing a key, so a caller that holds
 * a firing or an event row can refuse it as a named outcome before anything is
 * planned.
 *
 * This exists because of the second challenge's P1. The scheduled path accepted
 * any non-empty occurrence, planned the dispatch, and the refusal then fired
 * deep inside `dispatchOne` where it escaped as a thrown exception instead of a
 * named outcome — so one badly shaped occurrence took down a whole monthly
 * batch and the ledger recorded nothing about any recipient. A validity rule
 * that can only be learned by triggering it is not a validity rule.
 */
export function originKeyFieldsAreValid(origin: NotificationOrigin): { readonly valid: true } | { readonly valid: false; readonly detail: string } {
  try {
    originKey(origin);
    return { valid: true };
  } catch (err) {
    if (err instanceof NotificationRefusal) return { valid: false, detail: err.subject };
    throw err;
  }
}

/**
 * Assert the law on the COMPOSED key, which is where it actually applies —
 * third challenge, N-7.
 *
 * `assertKeyField` tests each field in isolation, and that is not the same
 * rule. An occurrence key of `:00` carries no `::` of its own, and the
 * composition `schedule:<id>:<occurrence>` supplies the first colon, so
 * `schedule:s1::00` passed every field check while containing the one sequence
 * `deliveryKey` reserves. Nothing in this package parses these keys — they are
 * opaque strings — so no message was duplicated by it; what it broke is the
 * structural guarantee the `:` relaxation's own safety argument rests on, and
 * any future reader that splits a delivery key on the separator this module
 * declares for exactly that purpose.
 *
 * Checking the composition rather than the parts is the shape this package
 * prefers, for the same reason the quote gate in another phase had to rebuild
 * rather than re-hash: a law proved over the inputs is not proved over the
 * thing the inputs make.
 */
function assertComposedKey(name: string, composed: string): string {
  for (const separator of SEPARATORS_REFUSED_EVERYWHERE) {
    if (separator === '|') continue; // `|` is the composition's own separator
    if (composed.includes(separator)) {
      throw new NotificationRefusal('notification.obligation_key_field_invalid', `${name}/composed_${separator === '::' ? 'double_colon' : separator}`);
    }
  }
  return composed;
}

function originKey(origin: NotificationOrigin): string {
  if (origin.source === 'event') {
    assertKeyField('eventId', origin.eventId);
    return `event:${origin.eventId}`;
  }
  assertKeyField('scheduleId', origin.scheduleId);
  // The occurrence is last in this segment, so a `:` inside it is unambiguous.
  assertKeyField('occurrenceKey', origin.occurrenceKey, { allowSegmentSeparator: true });
  // ...but a leading or trailing `:` in the occurrence forms `::` AT THE JOIN,
  // which the field checks cannot see. The segment is checked as a segment.
  return assertComposedKey('originKey', `schedule:${origin.scheduleId}:${origin.occurrenceKey}`);
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
  // And again over the whole key: `originKey` guards its own segment, this
  // guards every join this function makes. Both are cheap and neither implies
  // the other.
  return assertComposedKey('obligationKey', `${businessId}|${originKey(origin)}|${kind}|${recipient.kind}:${recipientId(recipient)}`);
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
