import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdapterRegistry } from '../adapter-registry';
import type { ServiceKind } from '../service-kinds';
import { isAcceptableIdentityField, replayKeyOf } from './identity';
import type { RawWebhookRequest, ReplayStore } from './replay-store';

/**
 * The closed set of refusals. Every one of them is a REFUSAL: there is no
 * "accepted with a warning" and no degraded path, because this is the one
 * boundary an outside party starts.
 *
 * These names are for the LOG, not for the wire. The caller owes every one of
 * them the SAME opaque HTTP response, and the reason is in this list's shape:
 * `timestamp_outside_window` tells an unauthenticated caller the server's
 * clock and the configured tolerance, `scheme_not_timestamp_bound` tells it
 * which scheme is configured, and `account_mismatch` tells it that its
 * signature was good. The check order below keeps the last two behind a valid
 * signature; the opaque response is what keeps the configuration refusals
 * from answering the same questions.
 *
 * Each name carries ONE condition. An earlier version returned `unconfigured`
 * both for "no secret" and for "the store is a test double", which is a
 * distinct operator error collapsed into one log line in a list that says of
 * itself that it exists for the log.
 */
export const WEBHOOK_REJECTIONS = [
  'request_malformed',
  'unconfigured',
  'adapter_unregistered',
  'adapter_not_webhook_capable',
  'scheme_unknown',
  'replay_store_not_durable',
  'scheme_unsigned',
  'scheme_not_timestamp_bound',
  'signature_malformed',
  'signature_mismatch',
  'timestamp_malformed',
  'timestamp_outside_window',
  'identity_absent',
  'identity_malformed',
  'instant_malformed',
  'instant_ahead_of_arrival',
  'account_mismatch',
  'financial_adapter_requires_timestamp_binding',
] as const;

export type WebhookRejection = (typeof WEBHOOK_REJECTIONS)[number];

/**
 * The verdict. When accepted it carries the replay key and nothing else — no
 * body, no header, no decoded payload.
 *
 * `replay: true` means SEEN, never POSTED. It is not a licence to skip the
 * work: the caller must still drive the event to the idempotent posting
 * primitive. What that primitive does is worth stating exactly, because the
 * short version is wrong in the direction that costs money. It returns the
 * existing entry with `created = false` ONLY when the posting fingerprint
 * matches (`0045_accounting_post_entry.sql:731`, `:735`); when the same source
 * arrives describing DIFFERENT financial truth it raises
 * `accounting.idempotency_conflict` (`:738-739`). So a redelivery carrying a
 * changed amount is an exception to handle, not a quiet no-op — and a caller
 * that treats `replay` as "already done" drops the first delivery whenever the
 * claim committed and the posting did not.
 */
export type WebhookVerdict =
  | {
      readonly accepted: true;
      readonly replay: boolean;
      readonly key: string;
      /**
       * The economic truth of the event, by the owner's decision of
       * 2026-11-08: the instant the provider signed inside the payload, or the
       * arrival instant where the provider signed none.
       */
      readonly economicInstantMs: number;
      /** The platform's own arrival instant, in its own field, always. */
      readonly arrivalInstantMs: number;
      /**
       * Whether `economicInstantMs` came from the signed payload. A consumer
       * that cannot tell a provider instant from a platform one does not know
       * what date it is posting on.
       */
      readonly economicInstantSigned: boolean;
    }
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
   * An earlier version refused the scheme outright in a comment that called
   * the refusal faithful to the design. That closed a phase contract by a
   * decision written in a comment, and the review was right to block it.
   */
  readonly acceptTimestampUnboundScheme: boolean;
  /**
   * The "small declared skew" of the owner's decision: how far ahead of
   * arrival a provider-signed instant may be before it is refused. Required,
   * with no default, like the window — and bounded only in the FUTURE
   * direction, which is what the decision asks for and all it asks for.
   */
  readonly maxSignedInstantAheadOfArrivalSeconds: number;
  /**
   * Required, because the test-double store refusal depends on it and a
   * default would make the refusal depend on nobody's decision.
   */
  readonly production: boolean;
}

/** Up to twelve digits: enough for any second-precision epoch, and a hard cap. */
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,11})$/;
/** HMAC-SHA256, lower or upper hex, exactly 32 bytes. */
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The inbound gate: the signature first, then the timestamp, then the identity
 * out of the verified bytes, then the replay claim.
 *
 * That order is deliberate and was corrected after review. Checking the clock
 * before the signature turns the endpoint into an oracle: an unauthenticated
 * caller distinguishes `timestamp_outside_window` from `signature_mismatch`
 * and reads off the server's clock and the configured tolerance. The ADR
 * draft 7 states the same rule — "verification first". The checks that remain
 * ahead of the signature are CONFIGURATION facts rather than attacker input:
 * no secret at all, a scheme or a store this deployment refuses.
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
    /**
     * The registry, not a descriptor, and this is the fix for a hole the
     * finance review found: `verify` used to take an `AdapterDescriptor`
     * straight from its caller and re-check nothing on it, while the registry
     * states the opposite doctrine about itself — that every closed set is
     * re-checked at runtime because a descriptor can reach a function from
     * code built against an older shape. The argument applied to the gate
     * verbatim and the gate did not apply it.
     *
     * Two money consequences followed. A `/` inside `adapterKey`, or a `kind`
     * outside the closed set, made two replay namespaces collide, so the
     * second independent event was reported as a duplicate. And an unknown
     * signature scheme fell through to the body-only branch — the WEAKEST
     * signed mode — where the registry would have refused it outright. The
     * suite itself demonstrated the bypass: it built descriptors with object
     * spread and never went through `AdapterRegistry.build`.
     *
     * Taking the registry removes the class rather than the two instances: the
     * only descriptor the gate can use is one that was validated at boot.
     */
    private readonly registry: AdapterRegistry,
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
    if (typeof opts.production !== 'boolean') {
      throw new Error('integrations.webhook: production must be stated explicitly, true or false');
    }
    // Zero is allowed here while the window requires more than zero, and the
    // asymmetry is deliberate rather than an oversight: a window of zero would
    // refuse every request, whereas a skew of zero is the coherent strict
    // choice, "accept no clock ahead of ours at all". It is still a sharp edge
    // — a provider clock one millisecond fast then refuses genuine deliveries —
    // so it is named here, because it would present as an outage rather than as
    // a setting.
    const skew = opts.maxSignedInstantAheadOfArrivalSeconds;
    if (typeof skew !== 'number' || !Number.isInteger(skew) || skew < 0) {
      throw new Error('integrations.webhook: maxSignedInstantAheadOfArrivalSeconds must be a whole number of seconds, zero or more');
    }
    this.hmac = hmac ?? ((key, message) => createHmac('sha256', key).update(message).digest());
  }

  /**
   * The scheme and the identity rule both come from the RESOLVED DESCRIPTOR,
   * not from arguments at the call site, so they cannot be wired to different
   * providers, and `eventSource` is the adapter's own key rather than a string
   * a caller chose.
   */
  async verify(request: RawWebhookRequest, secret: Buffer | undefined, kind: ServiceKind, adapterKey: string): Promise<WebhookVerdict> {
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
      typeof request.expectedAccountRef !== 'string' ||
      request.businessId === '' ||
      request.expectedAccountRef === ''
    ) {
      return { accepted: false, rejection: 'request_malformed' };
    }

    // Arrival is read ONCE, here, and reused: the window check and the
    // economic-instant comparison must not be able to disagree about when this
    // request arrived.
    const arrivalInstantMs = this.now();

    // No secret means no authority. Checked before any hashing, so no HMAC is
    // ever computed under an absent or empty key — a comparison against a key
    // nobody set is not a weak check, it is no check.
    if (secret === undefined || secret.length === 0) return { accepted: false, rejection: 'unconfigured' };

    const adapter = this.registry.get(kind, adapterKey);
    if (adapter === undefined) return { accepted: false, rejection: 'adapter_unregistered' };

    const scheme = adapter.capabilities.webhookSignatureScheme;
    if (scheme === 'none') return { accepted: false, rejection: 'scheme_unsigned' };
    const extract = adapter.extractWebhookIdentity;
    if (typeof extract !== 'function') return { accepted: false, rejection: 'adapter_not_webhook_capable' };

    // Exhaustive, rather than "everything else is the body-only branch". The
    // registry already refuses an unknown scheme, so through the lookup above
    // this is unreachable — and it is written anyway, because the previous
    // version's fall-through made the WEAKEST mode the default for anything it
    // did not recognise. There is deliberately NO test claiming to reach it:
    // it cannot be reached through a validated registry, and a control that
    // cannot fail is worth nothing.
    if (scheme !== 'hmac_sha256_ts_body' && scheme !== 'hmac_sha256_body') {
      return { accepted: false, rejection: 'scheme_unknown' };
    }
    const timestampBound = scheme === 'hmac_sha256_ts_body';
    // Defence in depth for the owner's law. The registry refuses this
    // combination at build time, so through a validated registry this is
    // unreachable — and there is deliberately no test claiming to reach it.
    if (!timestampBound && adapter.producesFinancialEvent) {
      return { accepted: false, rejection: 'financial_adapter_requires_timestamp_binding' };
    }
    if (!timestampBound && !this.opts.acceptTimestampUnboundScheme) {
      return { accepted: false, rejection: 'scheme_not_timestamp_bound' };
    }
    // Replay prevention is mandatory under EVERY scheme, so a store that
    // forgets on restart and is not shared between instances is refused in
    // production outright — not only where the timestamp is unsigned. Outside
    // production it is still refused for an unbound scheme, because there the
    // store is the only defence the ADR leaves standing.
    if (this.store.isTestDouble && (this.opts.production || !timestampBound)) {
      return { accepted: false, rejection: 'replay_store_not_durable' };
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
      const nowSeconds = Math.floor(arrivalInstantMs / 1000);
      if (Math.abs(nowSeconds - sent) > this.opts.timestampWindowSeconds) {
        return { accepted: false, rejection: 'timestamp_outside_window' };
      }
    }

    // The identity comes out of the verified bytes, never from beside them.
    //
    // The call is GUARDED, and the reason was measured in review: a body the
    // provider signed correctly but changed the shape of makes a JSON parse
    // throw, and the exception escapes `verify` as a 500 instead of a named
    // refusal — carrying a message that for this class of error can quote a
    // fragment of the input, which reopens the one channel this file keeps
    // shut. A broken extractor is a provider-shape problem, so it is a
    // refusal, not a crash.
    let identity;
    try {
      identity = extract(request.rawBody);
    } catch {
      return { accepted: false, rejection: 'identity_malformed' };
    }
    // `== null` on purpose: the type says `undefined`, and a compiled caller
    // returning `null` is both idiomatic for "no identity" and what `exec`
    // itself returns. Reading a field off it threw out of `verify` — the same
    // escape that was closed two lines above, through a nearer door.
    if (identity === undefined || identity === null) return { accepted: false, rejection: 'identity_absent' };
    if (
      identity.externalEventId === undefined ||
      identity.externalEventId === null ||
      identity.externalEventId === '' ||
      identity.accountRef === undefined ||
      identity.accountRef === null ||
      identity.accountRef === ''
    ) {
      return { accepted: false, rejection: 'identity_absent' };
    }
    if (!isAcceptableIdentityField(identity.externalEventId) || !isAcceptableIdentityField(identity.accountRef)) {
      return { accepted: false, rejection: 'identity_malformed' };
    }

    // THE TENANT IS CHECKED HERE, and nowhere else. The signed bytes must name
    // the same provider account the caller resolved this business from;
    // without it, a secret shared across tenants lets one genuine delivery be
    // replayed at every other tenant's route.
    //
    // This NARROWS the assumption rather than ending it, and the review was
    // right to say so. The invariant becomes "the signed bytes name the
    // account the caller claims", which is strictly stronger than "the secret
    // was resolved for this business" but still rests on two facts no code
    // here can see — and so they are obligations on the configuration slice
    // that owns the mapping, in the same terms as the store's obligations:
    //
    //  1. an account reference is UNIQUE across businesses. Without that
    //     constraint, two businesses may both declare one reference, one
    //     signed delivery passes this check at each of them, and each gets its
    //     own replay key and its own ledger entry.
    //  2. `businessId` and `expectedAccountRef` come from the SAME row. The
    //     design's `W-9` says the business is "resolved FROM the reference",
    //     which is a lookup, not a comparison against a caller's claim. Where
    //     the secret is per-business the caller must resolve before it can
    //     verify, so the comparison is the only shape available — and then
    //     these two obligations are what make it sound.
    if (identity.accountRef !== request.expectedAccountRef) {
      return { accepted: false, rejection: 'account_mismatch' };
    }

    // The economic instant, by the owner's decision. The signed one where the
    // provider carries one, arrival otherwise — and a signed instant ahead of
    // arrival by more than the declared skew is refused, because `entry_date`
    // is derived from it and a future instant crosses both the civil-date
    // bound (`0045_accounting_post_entry.sql:757-759`) and the closed-period
    // bound (`0049_accounting_periods.sql:762`).
    const signedInstant = identity.signedInstantMs;
    const economicInstantSigned = signedInstant !== undefined && signedInstant !== null;
    if (economicInstantSigned && (typeof signedInstant !== 'number' || !Number.isInteger(signedInstant) || signedInstant < 0)) {
      return { accepted: false, rejection: 'instant_malformed' };
    }
    const economicInstantMs = economicInstantSigned ? (signedInstant as number) : arrivalInstantMs;
    if (economicInstantMs - arrivalInstantMs > this.opts.maxSignedInstantAheadOfArrivalSeconds * 1000) {
      return { accepted: false, rejection: 'instant_ahead_of_arrival' };
    }

    // Only a request that PASSED is remembered: recording a rejected one would
    // let an unsigned request with a guessed id block the real delivery that
    // follows it.
    const key = replayKeyOf({
      businessId: request.businessId,
      kind: adapter.kind,
      adapterKey: adapter.adapterKey,
      externalEventId: identity.externalEventId,
    });
    const first = await this.store.remember(key);
    return { accepted: true, replay: !first, key, economicInstantMs, arrivalInstantMs, economicInstantSigned };
  }
}
