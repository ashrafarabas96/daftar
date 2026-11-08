/**
 * Provider status callbacks (WhatsApp/SMS webhooks).
 *
 * The delivery state machine is MONOTONIC: providers deliver webhooks out of
 * order and more than once, and a notification log that regresses would tell a
 * merchant their customer never received a statement they read.
 *
 * **What is terminal is the ARRIVAL, not the failure.** The earlier ladder
 * ranked `failed` highest and refused everything after it, which looks like
 * "failed is terminal" and is two defects:
 *
 *  - `read -> failed` was "strictly forward" and so was APPLIED. The
 *    challenger composed that with the release in `delivery.ts`: a delivery
 *    closed as a verified `failed` releases its obligation to the next channel,
 *    so a customer who had READ the invoice message got a second one by SMS.
 *    A provider reporting a post-delivery failure, or redelivering an old
 *    event out of order, is enough to trigger it.
 *  - `failed -> delivered` was refused, which is the same defect from the other
 *    side: a message that demonstrably arrived would have stayed `failed`, and
 *    the release would fire for a message the customer is holding.
 *
 * So the ladder is `queued < sent < failed < delivered < read`: a failure is
 * reachable only BEFORE an arrival, an arrival is never demoted, and a late
 * arrival after a failure is applied because it is evidence. That ordering is
 * the premise `blocksAnotherChannel` depends on, and `arrivalWasRecorded` is
 * how it reads it instead of restating it in a comment.
 */
import type { NotificationRefusalCode } from './errors';

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Rank: a status may only move to a strictly higher rank. `failed` sits BELOW
 * the two arrival states, so no callback can turn a received message into a
 * failed one. See the header for the duplicate that ordering prevents.
 */
const RANK: Readonly<Record<DeliveryStatus, number>> = { queued: 0, sent: 1, failed: 2, delivered: 3, read: 4 };

/** The two statuses that mean the message reached the recipient. */
const ARRIVALS: readonly DeliveryStatus[] = ['delivered', 'read'];

/**
 * Did this status record an ARRIVAL? The one question the release rule in
 * `delivery.ts` needs, exported so that rule can read its premise rather than
 * assume it. Derived from the ladder, not a second list: a status ranked at or
 * above `delivered` is an arrival by construction, so the two cannot drift.
 */
export function arrivalWasRecorded(status: DeliveryStatus): boolean {
  return RANK[status] >= RANK.delivered;
}

/** For the law that asserts the ordering the release depends on. */
export function arrivalStatuses(): readonly DeliveryStatus[] {
  return ARRIVALS;
}

export function isKnownStatus(value: string): value is DeliveryStatus {
  return Object.prototype.hasOwnProperty.call(RANK, value);
}

export type StatusTransition =
  | { readonly applied: true; readonly status: DeliveryStatus }
  | { readonly applied: false; readonly reason: NotificationRefusalCode | 'duplicate' };

export function applyStatus(current: DeliveryStatus, incoming: string): StatusTransition {
  if (!isKnownStatus(incoming)) return { applied: false, reason: 'notification.status_unknown' };
  if (incoming === current) return { applied: false, reason: 'duplicate' };
  // There is deliberately NO `current === 'failed'` short-circuit. A later
  // arrival after a reported failure is evidence that the message landed, and
  // refusing it would leave the delivery `failed` — the exact state that
  // releases the obligation to another channel.
  const from = RANK[current];
  const to = RANK[incoming];
  if (to <= from) return { applied: false, reason: 'notification.status_regression' };
  return { applied: true, status: incoming };
}
