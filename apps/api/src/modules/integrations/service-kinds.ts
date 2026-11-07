/**
 * The closed set of service kinds an adapter may claim.
 *
 * Transcribed from the ADR draft 3.1 (`ADR_PROVIDER_ADAPTERS_AR.md`), which
 * states that the set is closed and that adding a kind is a documented
 * decision. Nothing here invents a kind, and the owning phase of each one is
 * recorded beside it so that a later phase cannot quietly adopt another's.
 */
export const SERVICE_KINDS = [
  'notification.whatsapp', // P8
  'notification.sms', // P8
  'notification.email', // P8 (and P1 for credentials, which stays separate)
  'payment.platform_billing', // P5
  'payment.merchant_checkout', // P6
  'fx.rates', // P14, and an accounting decision
  'webhook.inbound', // P14 owns the framework, each phase its provider
] as const;

export type ServiceKind = (typeof SERVICE_KINDS)[number];

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === 'string' && (SERVICE_KINDS as readonly string[]).includes(value);
}
