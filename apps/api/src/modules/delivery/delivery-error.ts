/**
 * §XXIII: centralized delivery error redaction. The worker NEVER persists raw
 * adapter exception messages (they may contain credentials/hosts/tokens).
 * Every failure is classified into a stable, safe code.
 */
export type DeliveryErrorCode =
  | 'PAYLOAD_DECRYPT_FAILED'
  | 'SMTP_CONNECTION_FAILED'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'DELIVERY_FAILED';

/** Adapters may tag errors with a safe code; anything else is classified by shape. */
export function classifyDeliveryError(err: unknown): DeliveryErrorCode {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (/decrypt|authentication|authenticate data|unknown credential payload key/i.test(msg)) {
    return 'PAYLOAD_DECRYPT_FAILED';
  }
  if (code === 'EAUTH' || /\b(535|authentication failed|invalid login)\b/i.test(msg)) {
    return 'SMTP_AUTH_FAILED';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(msg)) {
    return 'SMTP_TIMEOUT';
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKET', 'ECONNECTION'].includes(code)) {
    return 'SMTP_CONNECTION_FAILED';
  }
  if (/\b5\d\d\b/.test(msg) || (/unavailable|service/i.test(msg) && /provider|smtp/i.test(msg))) {
    return 'PROVIDER_UNAVAILABLE';
  }
  return 'DELIVERY_FAILED';
}
