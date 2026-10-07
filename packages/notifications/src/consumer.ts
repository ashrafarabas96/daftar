/**
 * The outbox consumer, as a PURE plan step.
 *
 * It reads one `outbox_events` row and answers one question: which
 * notifications does this event owe, and under which idempotency key. It does
 * not read the database, does not send anything, and does not decide consent.
 *
 * Two facts about the live tree shape this (verified, not assumed):
 *  1. `outbox_events` payloads carry IDS ONLY — `sale.committed.v1` writes
 *     businessId/saleId/invoiceId/businessTransactionId (0078:1008) and
 *     `customer.payment_collected.v1` writes ids plus allocation ids
 *     (0081:2175). There is no amount, no name, no phone number in an event.
 *     So a notification CANNOT be rendered from an event: it must be hydrated
 *     from the canonical reads. That is the one-truth law (Part 11) expressed
 *     as a dependency, not a convenience.
 *  2. Delivery is at-least-once (publisher.ts says so). The idempotency key is
 *     therefore derived from the EVENT ROW ID and the kind — never from a
 *     clock or a random value — so a repeated delivery of the same row
 *     produces the same key and the second send is suppressed.
 */
import { refuse } from './errors';
import { catalogEntry, kindsForEventType, type NotificationKind } from './catalog';

export interface OutboxRow {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DispatchIntent {
  readonly kind: NotificationKind;
  readonly businessId: string;
  /** The ids the hydrator resolves against canonical reads. */
  readonly subjectRefs: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly sourceEventId: string;
}

export interface ConsumerPlan {
  readonly intents: readonly DispatchIntent[];
  /** True when no kind subscribes to this event type. Not an error: most of the
   *  outbox is accounting and inventory traffic notifications never touch. */
  readonly unmapped: boolean;
}

function requiredString(payload: Readonly<Record<string, unknown>>, key: string, eventType: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') refuse('notification.event_payload_invalid', `${eventType}/${key}`);
  return value;
}

export function planFromOutboxRow(row: OutboxRow): ConsumerPlan {
  const kinds = kindsForEventType(row.type);
  if (kinds.length === 0) return { intents: [], unmapped: true };

  const intents: DispatchIntent[] = [];
  for (const kind of kinds) {
    const entry = catalogEntry(kind);
    if (!entry || entry.trigger.source !== 'outbox') refuse('notification.kind_unknown', kind);

    // Tenant scope first: an untenanted notification is a data leak, not a bug.
    const businessId = requiredString(row.payload, 'businessId', row.type);

    // Carry every declared id this event writes, so the hydrator never has to
    // guess which read to perform, and a renamed payload key fails loudly here
    // instead of producing a blank-looking notification downstream.
    const subjectRefs: Record<string, string> = {};
    for (const key of entry.trigger.payloadKeys) {
      if (key === 'businessId') continue;
      const value = row.payload[key];
      if (typeof value === 'string' && value !== '') subjectRefs[key] = value;
    }

    intents.push({
      kind,
      businessId,
      subjectRefs,
      idempotencyKey: `${row.id}:${kind}`,
      sourceEventId: row.id,
    });
  }
  return { intents, unmapped: false };
}
