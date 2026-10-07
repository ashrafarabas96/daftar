/**
 * Provider status callbacks (WhatsApp/SMS webhooks).
 *
 * The delivery state machine is MONOTONIC: a late `sent` webhook may never
 * overwrite a `read`, and a terminal `failed` is terminal. Providers deliver
 * webhooks out of order and more than once — a notification log that regresses
 * would tell a merchant their customer never received a statement they read.
 */
import type { NotificationRefusalCode } from './errors';

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/** Rank: a status may only move to a strictly higher rank. `failed` is terminal. */
const RANK: Readonly<Record<DeliveryStatus, number>> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export function isKnownStatus(value: string): value is DeliveryStatus {
  return Object.prototype.hasOwnProperty.call(RANK, value);
}

export type StatusTransition =
  | { readonly applied: true; readonly status: DeliveryStatus }
  | { readonly applied: false; readonly reason: NotificationRefusalCode | 'duplicate' };

export function applyStatus(current: DeliveryStatus, incoming: string): StatusTransition {
  if (!isKnownStatus(incoming)) return { applied: false, reason: 'notification.status_unknown' };
  if (incoming === current) return { applied: false, reason: 'duplicate' };
  if (current === 'failed') return { applied: false, reason: 'notification.status_regression' };
  const from = RANK[current];
  const to = RANK[incoming];
  if (to <= from) return { applied: false, reason: 'notification.status_regression' };
  return { applied: true, status: incoming };
}
