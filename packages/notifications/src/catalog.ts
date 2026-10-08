/**
 * The notification catalog: the ONE registry of what DAFTAR may notify about.
 *
 * A kind is not a string sprinkled through the code — it is a row here, with
 * its consent class, its allowed channels, the display facts it needs, and the
 * source that triggers it. Adding a notification without adding a row is
 * impossible: the dispatcher reads nothing but this table.
 *
 * `trigger` is deliberately honest about the live tree:
 *  - `outbox`: an event type that ALREADY exists in a migration, with the
 *    payload keys that migration actually writes.
 *  - `schedule`: automation fires it (statements, daily reports, due reminders).
 *    Those have no outbox event and must not pretend to.
 *
 * `boundTo` records which slice owns the read it needs. Where that slice is not
 * sealed, Phase 8 is WAITING_FOR_INTEGRATED_SURFACE for that kind — it is
 * engineered and tested against the hydrator port, and it is NOT claimed green.
 */
import type { Channel, ConsentClass } from './types';

export type NotificationKind =
  | 'invoice_issued'
  | 'payment_receipt'
  | 'credit_applied'
  | 'customer_statement'
  | 'installment_due_soon'
  | 'installment_overdue'
  | 'daily_sales_report'
  | 'low_stock_alert';

/** Variable names a kind's templates may use, and which of them are required. */
export interface KindVariable {
  readonly name: string;
  readonly type: 'text' | 'money' | 'date' | 'int';
  readonly required: boolean;
}

export interface CatalogEntry {
  readonly kind: NotificationKind;
  readonly consent: ConsentClass;
  /** Channels this kind may EVER use. A dispatch outside this set is refused. */
  readonly channels: readonly Channel[];
  readonly audience: 'customer' | 'staff';
  readonly variables: readonly KindVariable[];
  readonly trigger:
    | { readonly source: 'outbox'; readonly eventType: string; readonly payloadKeys: readonly string[] }
    /**
     * §41: a scheduled kind carries NO cadence and NO lead time in source.
     * `requiresConfiguration` records that: until a business configures the
     * schedule, nothing fires — an unconfigured statement schedule sends no
     * statement, and an unset instalment lead sends no reminder. A default
     * invented here would be a business policy invented in source.
     */
    | { readonly source: 'schedule'; readonly scheduleId: string; readonly requiresConfiguration: boolean };
  /** The slice whose canonical read hydrates this kind. */
  readonly boundTo: string;
}

const CATALOG: readonly CatalogEntry[] = [
  {
    kind: 'invoice_issued',
    consent: 'transactional',
    channels: ['whatsapp', 'email', 'inapp'],
    audience: 'customer',
    variables: [
      { name: 'customerName', type: 'text', required: true },
      { name: 'invoiceNumber', type: 'text', required: true },
      { name: 'invoiceTotal', type: 'money', required: true },
      { name: 'dueDate', type: 'date', required: false },
    ],
    // 0078_phase4_sale_commit.sql:1008 — the live payload is ids only.
    trigger: { source: 'outbox', eventType: 'sale.committed.v1', payloadKeys: ['businessId', 'saleId', 'invoiceId', 'businessTransactionId'] },
    boundTo: 'P4-S3/S4 sales + invoice reads',
  },
  {
    kind: 'payment_receipt',
    consent: 'transactional',
    channels: ['whatsapp', 'email', 'inapp'],
    audience: 'customer',
    variables: [
      { name: 'customerName', type: 'text', required: true },
      { name: 'paidAmount', type: 'money', required: true },
      { name: 'outstandingAfter', type: 'money', required: true },
      { name: 'paymentDate', type: 'date', required: true },
    ],
    // 0081_phase4_customer_payments_credits.sql:2175.
    trigger: {
      source: 'outbox',
      eventType: 'customer.payment_collected.v1',
      payloadKeys: ['businessId', 'paymentId', 'customerId', 'allocationIds', 'creditId', 'businessTransactionId'],
    },
    boundTo: 'P4-S4 customer settlement reads',
  },
  {
    kind: 'credit_applied',
    consent: 'transactional',
    channels: ['whatsapp', 'email', 'inapp'],
    audience: 'customer',
    variables: [
      { name: 'customerName', type: 'text', required: true },
      { name: 'appliedAmount', type: 'money', required: true },
      { name: 'invoiceNumber', type: 'text', required: true },
    ],
    // 0081_phase4_customer_payments_credits.sql:2425 — the live write carries
    // the application, the credit and the invoice, and NO customer id. The
    // hydrator resolves the customer from the credit; the catalog does not
    // pretend the event knows who to address.
    trigger: {
      source: 'outbox',
      eventType: 'customer.credit_applied.v1',
      payloadKeys: ['businessId', 'applicationId', 'creditId', 'invoiceId', 'businessTransactionId'],
    },
    boundTo: 'P4-S4/S5 customer credit reads',
  },
  {
    kind: 'customer_statement',
    consent: 'transactional',
    channels: ['whatsapp', 'email'],
    audience: 'customer',
    variables: [
      { name: 'customerName', type: 'text', required: true },
      { name: 'periodEnd', type: 'date', required: true },
      { name: 'outstanding', type: 'money', required: true },
      { name: 'oldestBandDays', type: 'int', required: false },
    ],
    trigger: { source: 'schedule', scheduleId: 'p8.statement.monthly', requiresConfiguration: true },
    boundTo: 'P4-S4 aging read (foldCustomerAging)',
  },
  {
    kind: 'installment_due_soon',
    consent: 'transactional',
    channels: ['whatsapp', 'sms', 'inapp'],
    audience: 'customer',
    variables: [
      { name: 'customerName', type: 'text', required: true },
      { name: 'dueDate', type: 'date', required: true },
      { name: 'dueAmount', type: 'money', required: true },
    ],
    trigger: { source: 'schedule', scheduleId: 'p8.installment.due_soon', requiresConfiguration: true },
    boundTo: 'P4-S7 installment schedule (NOT SEALED)',
  },
  {
    kind: 'installment_overdue',
    consent: 'transactional',
    channels: ['whatsapp', 'sms', 'inapp'],
    audience: 'customer',
    variables: [
      { name: 'customerName', type: 'text', required: true },
      { name: 'dueDate', type: 'date', required: true },
      { name: 'dueAmount', type: 'money', required: true },
      { name: 'daysOverdue', type: 'int', required: true },
    ],
    trigger: { source: 'schedule', scheduleId: 'p8.installment.overdue', requiresConfiguration: true },
    boundTo: 'P4-S7 installment aging (NOT SEALED)',
  },
  {
    kind: 'daily_sales_report',
    consent: 'operational',
    channels: ['whatsapp', 'email', 'inapp'],
    audience: 'staff',
    variables: [
      { name: 'reportDate', type: 'date', required: true },
      { name: 'salesTotal', type: 'money', required: true },
      { name: 'invoiceCount', type: 'int', required: true },
    ],
    trigger: { source: 'schedule', scheduleId: 'p8.report.daily_sales', requiresConfiguration: true },
    boundTo: 'P4-S4 sales reads',
  },
  {
    kind: 'low_stock_alert',
    consent: 'operational',
    channels: ['whatsapp', 'email', 'inapp'],
    audience: 'staff',
    variables: [
      { name: 'productName', type: 'text', required: true },
      { name: 'onHand', type: 'int', required: true },
      { name: 'threshold', type: 'int', required: true },
    ],
    trigger: { source: 'schedule', scheduleId: 'p8.alert.low_stock', requiresConfiguration: true },
    boundTo: 'Phase 3 inventory reads (SEALED)',
  },
];

export const NOTIFICATION_KINDS: readonly NotificationKind[] = CATALOG.map((e) => e.kind);

const BY_KIND = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.kind, e]));

export function catalogEntries(): readonly CatalogEntry[] {
  return CATALOG;
}

/** Undefined — never a fabricated default — for an unregistered kind. */
export function catalogEntry(kind: string): CatalogEntry | undefined {
  return BY_KIND.get(kind);
}

/** Outbox event type → the kinds it triggers. An unmapped type has no kinds. */
export function kindsForEventType(eventType: string): readonly NotificationKind[] {
  return CATALOG.filter((e) => e.trigger.source === 'outbox' && e.trigger.eventType === eventType).map((e) => e.kind);
}
