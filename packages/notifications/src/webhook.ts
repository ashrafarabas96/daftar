/**
 * PART 48 — WEBHOOK SAFETY, and the thing that changed in this round.
 *
 * The earlier version took a `signatureVerified: boolean` on the callback. That
 * is a hole with a type: whoever constructs the callback decides whether the
 * signature was good, and the layer that constructs it is the HTTP edge, whose
 * input is attacker-controlled. PART 48 names it exactly — "API must not pass
 * untrusted `signatureVerified=true`" — so the boolean is GONE. A verdict now
 * exists only as the return value of a verifier that COMPUTED it from the raw
 * body, the provider's signature header and a configured secret.
 *
 * Four rules, in this order, before a provider callback may move state:
 *
 *  1. VERIFY FIRST, and verify HERE. An unverified callback may be RECORDED for
 *     forensics and may never drive state. Anyone can post to a webhook URL; a
 *     status transition is an assertion about what a customer saw.
 *  2. NO SECRET, NO AUTHORITY. An unconfigured verifier verifies nothing; it
 *     does not fall back to trusting the caller.
 *  3. REPLAY IS NOT AN EVENT. Providers redeliver. Where the provider gives its
 *     own event identity, a second arrival applies nothing.
 *  4. THE MACHINE STAYS MONOTONIC (`status.ts`), so a late `sent` after a
 *     `read` changes nothing even when verified and fresh.
 *
 * The provider's own body never becomes persisted data: only the status token,
 * the event id and the verification verdict are kept.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { applyStatus, type DeliveryStatus } from './status';
import type { Reconciliation } from './delivery';

/** Exactly what arrived on the wire. The raw body is the SIGNED bytes — not a
 *  re-serialisation of a parsed object, which would not reproduce them. */
export interface RawWebhookRequest {
  readonly rawBody: Uint8Array | string;
  /** The provider's signature header value, verbatim. */
  readonly signatureHeader: string | undefined;
}

export type VerificationVerdict =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: 'signature_missing' | 'signature_mismatch' | 'secret_not_configured' | 'signature_malformed' };

/** The ONLY source of a verification verdict. There is no other constructor. */
export interface WebhookVerifier {
  verify(request: RawWebhookRequest): VerificationVerdict;
}

/**
 * Meta's scheme: `X-Hub-Signature-256: sha256=<hex hmac of the raw body>`.
 * Comparison is constant-time, and a wrong-length digest is rejected before
 * `timingSafeEqual` (which throws on a length mismatch) is ever reached.
 */
export class HmacSha256WebhookVerifier implements WebhookVerifier {
  private readonly secret: string;
  private readonly prefix: string;

  constructor(secret: string | undefined, prefix = 'sha256=') {
    this.secret = secret ?? '';
    this.prefix = prefix;
  }

  verify(request: RawWebhookRequest): VerificationVerdict {
    // Rule 2: no secret means no authority — never "verified by default".
    if (this.secret === '') return { verified: false, reason: 'secret_not_configured' };
    const header = request.signatureHeader;
    if (header === undefined || header === '') return { verified: false, reason: 'signature_missing' };
    if (!header.startsWith(this.prefix)) return { verified: false, reason: 'signature_malformed' };
    const presented = header.slice(this.prefix.length).trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(presented)) return { verified: false, reason: 'signature_malformed' };

    const body = typeof request.rawBody === 'string' ? Buffer.from(request.rawBody, 'utf8') : Buffer.from(request.rawBody);
    const expected = createHmac('sha256', this.secret).update(body).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    if (a.length !== b.length) return { verified: false, reason: 'signature_mismatch' };
    return timingSafeEqual(a, b) ? { verified: true } : { verified: false, reason: 'signature_mismatch' };
  }
}

/** A verifier that refuses everything. The shipped default where no secret is
 *  configured, so an unconfigured deployment records callbacks and trusts none. */
export class RefuseAllWebhooks implements WebhookVerifier {
  verify(): VerificationVerdict {
    return { verified: false, reason: 'secret_not_configured' };
  }
}

/** The callback's CONTENT. It carries no claim about its own trustworthiness. */
export interface ProviderCallback {
  readonly providerMessageId: string;
  readonly status: string;
  /** The provider's event id, where it offers one. */
  readonly providerEventId?: string;
}

export type CallbackVerdict =
  | { readonly action: 'applied'; readonly status: DeliveryStatus }
  /** Kept for forensics; no state moved. */
  | {
      readonly action: 'recorded_only';
      readonly reason: 'signature_unverified' | 'duplicate_event' | 'status_unknown' | 'status_regression' | 'duplicate_status';
      /** Why verification failed, where that is what stopped it. Safe tokens only. */
      readonly verificationReason?: string;
    };

export interface CallbackContext {
  readonly current: DeliveryStatus;
  /** Provider event ids already applied for this notification. */
  readonly appliedEventIds?: ReadonlySet<string>;
}

/**
 * Apply a callback. The verdict is COMPUTED here, from the raw request and the
 * injected verifier — the caller cannot assert it.
 */
export function applyProviderCallback(
  callback: ProviderCallback,
  request: RawWebhookRequest,
  verifier: WebhookVerifier,
  context: CallbackContext,
): CallbackVerdict {
  const verification = verifier.verify(request);
  if (!verification.verified) {
    return { action: 'recorded_only', reason: 'signature_unverified', verificationReason: verification.reason };
  }

  const eventId = callback.providerEventId;
  if (eventId !== undefined && eventId !== '' && context.appliedEventIds?.has(eventId) === true) {
    return { action: 'recorded_only', reason: 'duplicate_event' };
  }

  const transition = applyStatus(context.current, callback.status);
  if (transition.applied) return { action: 'applied', status: transition.status };
  if (transition.reason === 'duplicate') return { action: 'recorded_only', reason: 'duplicate_status' };
  if (transition.reason === 'notification.status_unknown') return { action: 'recorded_only', reason: 'status_unknown' };
  return { action: 'recorded_only', reason: 'status_regression' };
}

/**
 * PART 44's other half: a VERIFIED callback correlated to the logical delivery
 * is authoritative evidence that the provider has the message, so it resolves a
 * `delivery_unknown` without a status lookup and without a resend. An
 * unverified callback resolves nothing — it must not be able to, or an attacker
 * could silence a real notification by posting a fake `delivered`.
 */
export function reconcileFromCallback(callback: ProviderCallback, request: RawWebhookRequest, verifier: WebhookVerifier): Reconciliation {
  if (!verifier.verify(request).verified) return { inconclusive: true };
  if (callback.providerMessageId.trim() === '') return { inconclusive: true };
  return { found: true, providerMessageId: callback.providerMessageId };
}
