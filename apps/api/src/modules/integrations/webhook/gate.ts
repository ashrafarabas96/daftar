import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookSignatureScheme } from '../capabilities';
import { isAcceptableExternalEventId, replayKeyOf, type RawWebhookRequest, type ReplayStore } from './replay-store';

/**
 * The closed set of refusals. Every one of them is a REFUSAL: there is no
 * "accepted with a warning" and no degraded path, because this is the one
 * boundary an outside party starts.
 *
 * These names are for the LOG, not for the wire. The caller owes every one of
 * them the SAME opaque HTTP response, and the reason is in this list's shape:
 * `timestamp_outside_window` tells an unauthenticated caller the server's
 * clock and the configured tolerance, and `scheme_not_timestamp_bound` tells
 * it which scheme is configured. The check order below keeps those two behind
 * a valid signature; the opaque response is what keeps the configuration
 * refusals from answering the same questions.
 */
export const WEBHOOK_REJECTIONS = [
  'request_malformed',
  'unconfigured',
  'scheme_unsigned',
  'scheme_not_timestamp_bound',
  'signature_malformed',
  'signature_mismatch',
  'timestamp_malformed',
  'timestamp_outside_window',
  'identity_absent',
  'identity_malformed',
] as const;

export type WebhookRejection = (typeof WEBHOOK_REJECTIONS)[number];

/**
 * The verdict. When accepted it carries the replay key and nothing else — no
 * body, no header, no decoded payload.
 *
 * `replay: true` means SEEN, never POSTED. It is not a licence to skip the
 * work: the caller must still drive the event to the idempotent posting
 * primitive, which recognises a duplicate source on its own
 * (`0045_accounting_post_entry.sql:724-735` returns the existing entry with
 * `created = false`). A caller that treats `replay` as "already done" drops
 * the first delivery whenever the claim committed and the posting did not.
 */
export type WebhookVerdict =
  | { readonly accepted: true; readonly replay: boolean; readonly key: string }
  | { readonly accepted: false; readonly rejection: WebhookRejection };

export interface WebhookGateOptions {
  /**
   * A required value with no default: a default here would be a security
   * parameter nobody chose, and a generous one would be a replay window
   * nobody noticed. The ADR draft 7 says the same — "a platform setting with
   * no default value in production", and boot refuses without it.
   */
  readonly timestampWindowSeconds: number;
  /**
   * Whether a provider that signs the body but NOT a timestamp may pass.
   *
   * Required, with no default, because the two authorities this lane works
   * from disagree and the disagreement is the owner's to settle, not this
   * file's. The design's `W-2` makes a timestamp window mandatory and says the
   * signature must cover the timestamp. The ADR draft 7, bullet 2, says a
   * provider that signs no timestamp — "as in Meta's scheme" — is a documented
   * capability constraint, and that protection then rests on step 3, the
   * replay store. Refusing such a scheme outright closes the inbound WhatsApp
   * path of the P8 contract; admitting it silently removes W-2.
   *
   * An earlier version of this file refused the scheme outright, in a comment
   * that called the refusal faithful to the design. That was a phase contract
   * closed by a decision written in a comment, and the review was right to
   * block it. So neither side is chosen here: the caller must say which, in
   * one place, and saying `true` costs the replay store its optionality.
   */
  readonly acceptTimestampUnboundScheme: boolean;
}

/** Up to twelve digits: enough for any second-precision epoch, and a hard cap. */
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,11})$/;
/** HMAC-SHA256, lower or upper hex, exactly 32 bytes. */
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The inbound gate: the signature first, then the timestamp, then the replay
 * claim — over the bytes as they arrived.
 *
 * That order is deliberate and was corrected after review. Checking the clock
 * before the signature turns the endpoint into an oracle: an unauthenticated
 * caller distinguishes `timestamp_outside_window` from `signature_mismatch`
 * and reads off the server's clock and the configured tolerance. The ADR
 * draft 7 states the same rule — "verification first". The two checks that
 * remain ahead of the signature are CONFIGURATION facts rather than attacker
 * input: there is no secret at all, or the scheme is one this deployment
 * refuses.
 *
 * What it does NOT do is as deliberate as what it does. It does not read a
 * secret (one is handed to it, already unsealed, and it keeps no reference
 * after the call). It does not call a provider. It does not process the event:
 * it returns a verdict and a key, and the enqueue-then-acknowledge is the
 * caller's, in a later slice.
 */
export class WebhookGate {
  private readonly hmac: (key: Buffer, message: Buffer) => Buffer;

  constructor(
    private readonly opts: WebhookGateOptions,
    private readonly store: ReplayStore,
    private readonly now: () => number = () => Date.now(),
    hmac?: (key: Buffer, message: Buffer) => Buffer,
  ) {
    const w = opts.timestampWindowSeconds;
    if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0) {
      throw new Error('integrations.webhook: timestampWindowSeconds must be a positive whole number of seconds');
    }
    if (typeof opts.acceptTimestampUnboundScheme !== 'boolean') {
      throw new Error('integrations.webhook: acceptTimestampUnboundScheme must be stated explicitly, true or false');
    }
    this.hmac = hmac ?? ((key, message) => createHmac('sha256', key).update(message).digest());
  }

  /**
   * `extractExternalEventId` is applied to the body ONLY AFTER the signature
   * has verified, so the identity the key is built from is identity the
   * provider signed. It returns `undefined` when the body carries no id.
   */
  async verify(
    request: RawWebhookRequest,
    secret: Buffer | undefined,
    scheme: WebhookSignatureScheme,
    extractExternalEventId: (verifiedBody: Buffer) => string | undefined,
  ): Promise<WebhookVerdict> {
    // Shape before anything else. These fields arrive from an HTTP layer, and
    // a duplicated header reaches a handler as an ARRAY: coerced by a regex it
    // would pass, and then `Buffer.from(array, 'utf8')` is not the bytes the
    // provider signed. A body that is not a Buffer would throw from inside the
    // hash, which is a crash an outside party can trigger at will.
    if (
      !Buffer.isBuffer(request.rawBody) ||
      typeof request.signatureHeader !== 'string' ||
      typeof request.timestampHeader !== 'string' ||
      typeof request.businessId !== 'string' ||
      typeof request.eventSource !== 'string' ||
      request.businessId === '' ||
      request.eventSource === ''
    ) {
      return { accepted: false, rejection: 'request_malformed' };
    }

    // No secret means no authority. Checked before any hashing, so no HMAC is
    // ever computed under an absent or empty key — a comparison against a key
    // nobody set is not a weak check, it is no check.
    if (secret === undefined || secret.length === 0) return { accepted: false, rejection: 'unconfigured' };

    if (scheme === 'none') return { accepted: false, rejection: 'scheme_unsigned' };
    const timestampBound = scheme === 'hmac_sha256_ts_body';
    if (!timestampBound && !this.opts.acceptTimestampUnboundScheme) {
      return { accepted: false, rejection: 'scheme_not_timestamp_bound' };
    }
    // When the timestamp is not signed, the replay store is the ONLY defence
    // the ADR leaves standing, so it may not be a test double.
    if (!timestampBound && this.store.isTestDouble) {
      return { accepted: false, rejection: 'unconfigured' };
    }

    // Shape before comparison: `timingSafeEqual` THROWS on a length mismatch,
    // so an unchecked header is a crash an outside party controls.
    if (!SIGNATURE_PATTERN.test(request.signatureHeader)) {
      return { accepted: false, rejection: 'signature_malformed' };
    }

    const signed = timestampBound ? Buffer.concat([Buffer.from(request.timestampHeader, 'utf8'), Buffer.from('.', 'utf8'), request.rawBody]) : request.rawBody;
    const expected = this.hmac(secret, signed);
    const presented = Buffer.from(request.signatureHeader, 'hex');
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return { accepted: false, rejection: 'signature_mismatch' };
    }

    // Only now, behind a valid signature, is the clock consulted — and only
    // for a scheme whose signature covers the header just verified.
    if (timestampBound) {
      if (!TIMESTAMP_PATTERN.test(request.timestampHeader)) {
        return { accepted: false, rejection: 'timestamp_malformed' };
      }
      const sent = Number.parseInt(request.timestampHeader, 10);
      const nowSeconds = Math.floor(this.now() / 1000);
      if (Math.abs(nowSeconds - sent) > this.opts.timestampWindowSeconds) {
        return { accepted: false, rejection: 'timestamp_outside_window' };
      }
    }

    // The identity comes out of the verified bytes, never from beside them.
    const externalEventId = extractExternalEventId(request.rawBody);
    if (externalEventId === undefined || externalEventId === '') {
      return { accepted: false, rejection: 'identity_absent' };
    }
    if (!isAcceptableExternalEventId(externalEventId)) {
      return { accepted: false, rejection: 'identity_malformed' };
    }

    // Only a request that PASSED is remembered: recording a rejected one would
    // let an unsigned request with a guessed id block the real delivery that
    // follows it.
    const key = replayKeyOf({
      businessId: request.businessId,
      eventSource: request.eventSource,
      externalEventId,
    });
    const first = await this.store.remember(key);
    return { accepted: true, replay: !first, key };
  }
}
