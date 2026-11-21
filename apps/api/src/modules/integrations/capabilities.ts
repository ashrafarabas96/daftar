/**
 * Capability flags. Logic reads THESE and never the adapter's name — the ADR
 * draft 3.2 forbids any condition on a provider name outside its own adapter,
 * which is what keeps "which provider" out of the business rules.
 */
export const WEBHOOK_SIGNATURE_SCHEMES = ['hmac_sha256_body', 'hmac_sha256_ts_body', 'none'] as const;

export type WebhookSignatureScheme = (typeof WEBHOOK_SIGNATURE_SCHEMES)[number];

export function isWebhookSignatureScheme(value: unknown): value is WebhookSignatureScheme {
  return typeof value === 'string' && (WEBHOOK_SIGNATURE_SCHEMES as readonly string[]).includes(value);
}

export interface CapabilityFlags {
  /** False when the provider accepts an idempotency key but does not honour it. */
  readonly serverSideIdempotency: boolean;
  readonly requiresApprovedTemplate: boolean;
  readonly supportsDeliveryReceipts: boolean;
  readonly supportsRefund: boolean;
  readonly supportsPartialRefund: boolean;
  readonly supportsHostedFields: boolean;
  /**
   * `hmac_sha256_body` is a real provider constraint, not a misconfiguration:
   * the ADR draft 7 names Meta's scheme as one that signs no timestamp and
   * says the limit is DOCUMENTED here while protection falls to the replay
   * store. The gate therefore admits it only against an explicit option, and
   * never by default.
   */
  readonly webhookSignatureScheme: WebhookSignatureScheme;
  readonly supportedCountries: readonly string[];
  /**
   * A provider's currency coverage, and nothing more. It is NOT posting
   * authority: a missing rate is refused by the ledger, and no code may read
   * this list and post at a rate of one.
   */
  readonly supportedCurrencies: readonly string[];
  readonly supportedLocales: readonly string[];
}
