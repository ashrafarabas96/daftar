/**
 * Observability without leaks. A notification log line may name the kind, the
 * channel, the business and the outcome. It may NEVER carry the message body,
 * a template variable, a phone number or an email address in the clear — the
 * body of a statement notification is a customer's balance.
 */

/** +972591234567 → +9725****567. Keeps country + last three for support. */
export function maskPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/[^\d+]/g, '');
  if (digits.length <= 7) return '***';
  return `${digits.slice(0, 5)}****${digits.slice(-3)}`;
}

/** ashraf@example.com → a***f@example.com */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const first = local.slice(0, 1);
  const last = local.length > 1 ? local.slice(-1) : '';
  return `${first}***${last}@${domain}`;
}

/** Stable, safe provider failure classes. Mirrors modules/delivery/delivery-error.ts. */
export type ProviderErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'RECIPIENT_REJECTED'
  | 'TEMPLATE_REJECTED'
  | 'DELIVERY_FAILED';

/** Transient classes are retried; the rest are terminal on the first failure. */
const TRANSIENT: readonly ProviderErrorCode[] = ['PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE'];

export function isTransient(code: ProviderErrorCode): boolean {
  return TRANSIENT.includes(code);
}

/**
 * Classify an adapter throw into a safe code. The raw message is NEVER
 * persisted or returned — a provider error can quote the recipient's number or
 * the bearer token that failed.
 */
export function classifyProviderError(err: unknown): ProviderErrorCode {
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  const status = typeof e?.status === 'number' ? e.status : 0;
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (status === 401 || status === 403 || /\b(unauthori[sz]ed|invalid access token)\b/i.test(msg)) return 'PROVIDER_AUTH_FAILED';
  if (status === 429 || /rate limit|too many requests/i.test(msg)) return 'PROVIDER_RATE_LIMITED';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(msg)) return 'PROVIDER_TIMEOUT';
  if (status >= 500 || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'PROVIDER_UNAVAILABLE';
  if (/template/i.test(msg)) return 'TEMPLATE_REJECTED';
  if (/recipient|not a valid whatsapp user|unsubscribed|invalid phone/i.test(msg)) return 'RECIPIENT_REJECTED';
  return 'DELIVERY_FAILED';
}
