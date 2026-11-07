import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookSignatureScheme } from '../capabilities';
import { replayKeyOf, type RawWebhookRequest, type ReplayStore } from './replay-store';

/**
 * The closed set of refusals. Every one of them is a REFUSAL: there is no
 * "accepted with a warning" and no degraded path, because this is the one
 * boundary an outside party starts.
 */
export const WEBHOOK_REJECTIONS = [
  'unconfigured',
  'scheme_not_timestamp_bound',
  'timestamp_malformed',
  'timestamp_outside_window',
  'signature_malformed',
  'signature_mismatch',
] as const;

export type WebhookRejection = (typeof WEBHOOK_REJECTIONS)[number];

/**
 * The verdict. When accepted it carries the replay key and NOTHING ELSE —
 * no body, no header, no decoded payload (W-7). What is not in the verdict
 * cannot be written to a log, an audit row or a queue row by accident.
 */
export type WebhookVerdict =
  | { readonly accepted: true; readonly replay: boolean; readonly key: string }
  | { readonly accepted: false; readonly rejection: WebhookRejection };

export interface WebhookGateOptions {
  /**
   * W-2. A required value with no default: a default here would be a security
   * parameter nobody chose, and a generous one would be a replay window
   * nobody noticed.
   */
  readonly timestampWindowSeconds: number;
}

/** Up to twelve digits: enough for any second-precision epoch, and a hard cap. */
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,11})$/;
/** HMAC-SHA256, lower or upper hex, exactly 32 bytes. */
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The inbound gate: signature, then timestamp, then replay — in that order,
 * over the bytes as they arrived.
 *
 * What it does NOT do is as deliberate as what it does. It does not read a
 * secret (one is handed to it, already unsealed, and it keeps no reference
 * after the call). It does not call a provider. It does not process the event:
 * it returns a verdict and a key, and the enqueue-then-acknowledge of W-5 is
 * the caller's, in a later slice.
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
    this.hmac = hmac ?? ((key, message) => createHmac('sha256', key).update(message).digest());
  }

  async verify(request: RawWebhookRequest, secret: Buffer | undefined, scheme: WebhookSignatureScheme): Promise<WebhookVerdict> {
    // W-4: no secret means no authority. This is checked FIRST so that no
    // HMAC is ever computed under an empty or absent key — a comparison
    // against a key nobody set is not a weak check, it is no check.
    if (secret === undefined || secret.length === 0) return { accepted: false, rejection: 'unconfigured' };

    // W-2 requires that the signature COVER the timestamp. A scheme that signs
    // the body alone cannot satisfy that, so it is refused here rather than
    // accepted with a window that an attacker can simply ignore by replaying
    // the same signed body later.
    if (scheme !== 'hmac_sha256_ts_body') return { accepted: false, rejection: 'scheme_not_timestamp_bound' };

    if (!TIMESTAMP_PATTERN.test(request.timestampHeader)) {
      return { accepted: false, rejection: 'timestamp_malformed' };
    }
    const sent = Number.parseInt(request.timestampHeader, 10);
    const nowSeconds = Math.floor(this.now() / 1000);
    if (Math.abs(nowSeconds - sent) > this.opts.timestampWindowSeconds) {
      return { accepted: false, rejection: 'timestamp_outside_window' };
    }

    // Shape before comparison: `timingSafeEqual` THROWS on a length mismatch,
    // so an unchecked header is a crash an outside party can trigger at will.
    if (!SIGNATURE_PATTERN.test(request.signatureHeader)) {
      return { accepted: false, rejection: 'signature_malformed' };
    }

    const signed = Buffer.concat([Buffer.from(request.timestampHeader, 'utf8'), Buffer.from('.', 'utf8'), request.rawBody]);
    const expected = this.hmac(secret, signed);
    const presented = Buffer.from(request.signatureHeader, 'hex');
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return { accepted: false, rejection: 'signature_mismatch' };
    }

    // W-3. Only a request that PASSED is remembered: recording a rejected one
    // would let an unsigned request with a guessed id block the real delivery
    // that follows it.
    const key = replayKeyOf(request);
    const first = await this.store.remember(key);
    return { accepted: true, replay: !first, key };
  }
}
