/**
 * Phase 8 refusal codes. Every refusal is a NAMED code — the renderer, the
 * preference gate, the consumer and the provider edge all refuse loudly and
 * never degrade silently. Nothing here ever "best-efforts" a notification that
 * carries money.
 */
export type NotificationRefusalCode =
  // Catalog / consumer
  | 'notification.kind_unknown'
  | 'notification.event_payload_invalid'
  | 'notification.hydration_incomplete'
  // Template / render
  | 'notification.template_missing'
  | 'notification.template_variable_missing'
  | 'notification.template_variable_unknown'
  | 'notification.template_variable_type_mismatch'
  | 'notification.money_formatter_missing'
  | 'notification.date_formatter_missing'
  // Consent / addressing
  | 'notification.channel_not_supported_for_kind'
  | 'notification.consent_missing'
  | 'notification.channel_blocked'
  | 'notification.address_missing'
  | 'notification.address_invalid'
  // Provider edge
  | 'notification.provider_not_configured'
  | 'notification.provider_template_required'
  | 'notification.provider_channel_unsupported'
  // Status webhook
  | 'notification.status_unknown'
  | 'notification.status_regression'
  | 'notification.webhook_signature_invalid';

export class NotificationRefusal extends Error {
  readonly code: NotificationRefusalCode;
  /** Safe, non-PII detail: a field name, a kind, a channel. Never a phone number. */
  readonly subject: string;

  constructor(code: NotificationRefusalCode, subject: string) {
    super(`${code}: ${subject}`);
    this.name = 'NotificationRefusal';
    this.code = code;
    this.subject = subject;
  }
}

export function refuse(code: NotificationRefusalCode, subject: string): never {
  throw new NotificationRefusal(code, subject);
}
