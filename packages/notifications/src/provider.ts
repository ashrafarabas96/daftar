/**
 * The provider port. Everything that leaves the building goes through here, so
 * every adapter is replaceable and every test is deterministic.
 *
 * A send has THREE possible outcomes, not two (PART 44, PART 45):
 *
 *   accepted  the provider answered and gave a valid, non-empty message id.
 *   rejected  the provider definitely did NOT take the message — a pre-send
 *             failure, or an explicit refusal. Safe to retry if the class is
 *             transient, because nothing was sent.
 *   unknown   the request may have reached the provider and we do not know.
 *             A timeout after the bytes left, a 2xx with no usable message id,
 *             a body that does not parse. **Never auto-resend an unknown.**
 *
 * The two-valued "accepted or failed" shape is what produces duplicate customer
 * messages: it files an ambiguous timeout under "failed" and retries it.
 */
import { refuse } from './errors';
import { classifyProviderError, type ProviderErrorCode } from './redaction';
import type { Channel, RenderedMessage } from './types';

export interface OutgoingMessage {
  /**
   * TL-P8-R2 (2): the LOGICAL DELIVERY key. Stable across every retry of the
   * same intended send, and the only key an adapter may offer a provider as an
   * idempotency key.
   */
  readonly deliveryKey: string;
  /** TL-P8-R2 (3): the attempt key. Correlation and audit only — never an
   *  idempotency authority, and never sent as one. */
  readonly attemptKey: string;
  readonly channel: Channel;
  readonly to: { readonly phoneE164?: string; readonly email?: string };
  readonly rendered: RenderedMessage;
}

export type ProviderSendResult =
  | { readonly outcome: 'accepted'; readonly providerMessageId: string }
  /** Proven not sent. `retryable` says whether the same logical delivery may be
   *  attempted again; a 4xx about the recipient or the template may not. */
  | { readonly outcome: 'rejected'; readonly code: ProviderErrorCode; readonly retryable: boolean }
  /** May or may not have been sent. Requires reconciliation, never a blind resend. */
  | { readonly outcome: 'unknown'; readonly code: ProviderErrorCode; readonly reason: UnknownReason };

export type UnknownReason = 'timeout_after_send' | 'invalid_success_response' | 'transport_interrupted';

export interface NotificationProvider {
  readonly name: string;
  readonly channels: readonly Channel[];
  /** True when the channel will only accept a pre-approved template (WhatsApp). */
  readonly requiresApprovedTemplate: boolean;
  /**
   * TRUE only when the provider honours an idempotency key SERVER-SIDE, so that
   * resending the same logical delivery key cannot produce a second message. A
   * custom request header the provider does not interpret is NOT this (PART 42):
   * WhatsApp Cloud declares `false`.
   */
  readonly serverSideIdempotency: boolean;
  send(message: OutgoingMessage): Promise<ProviderSendResult>;
}

/** E.164: '+' then 8–15 digits, first digit non-zero. No spaces, no dashes. */
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function assertAddressable(message: OutgoingMessage): void {
  if (message.channel === 'inapp') return;
  if (message.channel === 'email') {
    const email = message.to.email;
    if (email === undefined || email === '') refuse('notification.address_missing', 'email');
    if (!EMAIL.test(email)) refuse('notification.address_invalid', 'email');
    return;
  }
  const phone = message.to.phoneE164;
  if (phone === undefined || phone === '') refuse('notification.address_missing', message.channel);
  if (!E164.test(phone)) refuse('notification.address_invalid', message.channel);
}

/** Codes that mean the provider answered and refused: definite, not ambiguous. */
const DEFINITE_REFUSALS: readonly ProviderErrorCode[] = [
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'RECIPIENT_REJECTED',
  'TEMPLATE_REJECTED',
  'PROVIDER_NOT_CONFIGURED',
];
/** Codes that mean the request never left: a connection that was never made. */
const PRE_SEND_FAILURES: readonly string[] = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'];

/**
 * Find a transport code anywhere in the `cause` chain.
 *
 * `HttpPort` is `postJson(url, headers, body)` and says nothing about how it
 * must throw, and the obvious adapter — Node's own `fetch` (undici) — throws
 * `TypeError: fetch failed` with the real code on `err.cause`, not on the error
 * itself. The earlier code read the top level only, so a `fetch` adapter turned
 * EVERY connection-refused failure into `{ outcome: 'unknown' }`: a full stop
 * with no retry and no fallback channel, a reconciliation entry forever, for a
 * request that never left the building. The fail-safe direction was right — it
 * never produced a duplicate — but the cost was a silently undelivered
 * notification whenever the provider was simply down, which is the common case.
 *
 * The chain is walked with a depth bound and a seen-set, because an adapter can
 * hand us a cycle and a worker loop must not hang on one.
 */
function transportCodeOf(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

/**
 * Classify a transport THROW. The distinction that matters: a connection that
 * was never established cannot have delivered anything (rejected, retryable),
 * while a timeout or a reset mid-flight may have (unknown).
 */
export function classifyTransportThrow(err: unknown): ProviderSendResult {
  const transport = transportCodeOf(err);
  const code = classifyProviderError(err);
  if (PRE_SEND_FAILURES.includes(transport)) return { outcome: 'rejected', code, retryable: true };
  if (code === 'PROVIDER_TIMEOUT') return { outcome: 'unknown', code, reason: 'timeout_after_send' };
  if (transport === 'ECONNRESET' || transport === 'EPIPE' || transport === 'ESOCKET') {
    return { outcome: 'unknown', code, reason: 'transport_interrupted' };
  }
  if (DEFINITE_REFUSALS.includes(code))
    return {
      outcome: 'rejected',
      code,
      retryable: code !== 'PROVIDER_AUTH_FAILED' && code !== 'RECIPIENT_REJECTED' && code !== 'TEMPLATE_REJECTED' && code !== 'PROVIDER_NOT_CONFIGURED',
    };
  // An unrecognised throw from inside the send path is not evidence of
  // non-delivery. Treating it as a failure is how a duplicate is produced.
  return { outcome: 'unknown', code, reason: 'transport_interrupted' };
}

/**
 * The single send path: validate the channel, the address and the template
 * requirement, then call the adapter and classify any throw. An adapter
 * exception never escapes with its message — it may quote the recipient's
 * number or the token that failed.
 */
export async function sendThroughProvider(provider: NotificationProvider, message: OutgoingMessage): Promise<ProviderSendResult> {
  if (!provider.channels.includes(message.channel)) refuse('notification.provider_channel_unsupported', `${provider.name}/${message.channel}`);
  assertAddressable(message);
  if (provider.requiresApprovedTemplate && message.rendered.providerTemplate === undefined) {
    refuse('notification.provider_template_required', `${provider.name}/${message.channel}`);
  }
  try {
    const result = await provider.send(message);
    // PART 45: an "accepted" with no usable id is not an acceptance. The guard
    // lives here as well as in each adapter, so a careless adapter cannot file
    // an empty id as a delivery.
    if (result.outcome === 'accepted' && result.providerMessageId.trim() === '') {
      return { outcome: 'unknown', code: 'DELIVERY_FAILED', reason: 'invalid_success_response' };
    }
    return result;
  } catch (err) {
    return classifyTransportThrow(err);
  }
}

export type { ProviderErrorCode };
