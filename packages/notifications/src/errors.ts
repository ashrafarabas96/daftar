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
  // Consent / addressing / eligibility
  | 'notification.channel_not_supported_for_kind'
  | 'notification.consent_missing'
  | 'notification.channel_blocked'
  | 'notification.address_missing'
  | 'notification.address_invalid'
  /** §40: the provider's or the law's own channel eligibility said no. An
   *  internal consent class never answers this question on its own. */
  | 'notification.channel_not_eligible'
  /** §39: the recipient does not belong to the business the obligation names. */
  | 'notification.recipient_business_mismatch'
  /** §41: a scheduled kind fired with no configured schedule behind it. */
  | 'notification.schedule_not_configured'
  /**
   * Mission §15: consent was ALLOWED at enqueue and refuses NOW. A consent
   * snapshot taken when the obligation was created is an audit record, not a
   * lasting right to send — so this is its own code, distinct from a message
   * that was never permitted, because the two mean different things to an
   * operator reading the ledger.
   */
  | 'notification.consent_withdrawn'
  /** Mission §15: channel eligibility allowed at enqueue and refuses NOW. */
  | 'notification.eligibility_withdrawn'
  /**
   * Mission §15: a channel was not attempted because an earlier channel of the
   * same obligation has an attempt that may still land. A fallback there would
   * be the second message the directive forbids.
   */
  | 'notification.channel_withheld_pending_delivery'
  // Money and formatting scope (Mission §15: correct language, currency, scope)
  | 'notification.currency_not_in_contract'
  | 'notification.money_minor_invalid'
  // Provider payload limits (Mission §15: body limits)
  | 'notification.body_too_long'
  | 'notification.parameter_invalid'
  /**
   * Mission V2 §15: post-render content that is EMPTY. A message with nothing
   * in it is not a cheaper message, it is a message the recipient cannot act
   * on while the ledger records a delivery. Refused rather than sent.
   */
  | 'notification.content_empty'
  /**
   * Mission V2 §15: post-render content carrying control characters. In a
   * subject they are a header-injection vector; in a body they are an upstream
   * rendering defect reaching a customer. Refused, never stripped — stripping
   * would change the text of a message about money without saying so.
   */
  | 'notification.content_invalid'
  /**
   * Mission V2 §15: "ChannelLimits must come from approved provider policy".
   * A limit whose origin is unstated cannot be approved, so it is not usable.
   */
  | 'notification.limits_policy_unstated'
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
