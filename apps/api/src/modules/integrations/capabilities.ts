/**
 * Capability flags. Logic reads THESE and never the adapter's name — the ADR
 * draft 3.2 forbids any condition on a provider name outside its own adapter,
 * which is what keeps "which provider" out of the business rules.
 */
export const WEBHOOK_SIGNATURE_SCHEMES = ['hmac_sha256_body', 'hmac_sha256_ts_body', 'none'] as const;

export type WebhookSignatureScheme = (typeof WEBHOOK_SIGNATURE_SCHEMES)[number];

export interface CapabilityFlags {
  /** False when the provider accepts an idempotency key but does not honour it. */
  readonly serverSideIdempotency: boolean;
  readonly requiresApprovedTemplate: boolean;
  readonly supportsDeliveryReceipts: boolean;
  readonly supportsRefund: boolean;
  readonly supportsPartialRefund: boolean;
  readonly supportsHostedFields: boolean;
  readonly webhookSignatureScheme: WebhookSignatureScheme;
  readonly supportedCountries: readonly string[];
  readonly supportedCurrencies: readonly string[];
  readonly supportedLocales: readonly string[];
}
