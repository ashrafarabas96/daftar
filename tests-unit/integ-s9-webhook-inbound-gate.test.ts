/**
 * INTEG S-9 (the part that needs no secret store and no queue) — THE INBOUND
 * WEBHOOK GATE: signature, timestamp window, identity, replay.
 *
 * Measured starting point: the repository has no webhook surface at all.
 *   grep -ril "webhook" --include="*.ts" --include="*.sql" .   =>  exit 1, 0 files
 *   grep -ril "accounting_post_entry" --include="*.sql" .      =>  exit 0, 15 files
 * The second command is the positive control: the zero above is a measurement
 * and not a broken search. (Both count FILES, not lines — `-l`.)
 *
 * Five defects three review rounds found in this gate are what most of this
 * file exists to hold shut, and every one of them is a money defect in the
 * same direction — an event accepted twice, or an event reported as a
 * duplicate and so never processed at all:
 *
 *   1. the external event id arrived BESIDE the signed bytes, so one validly
 *      signed delivery replayed with a mutated id was accepted as new;
 *   2. an absent or blank id had no refusal channel, and collapsed every event
 *      of a business onto one key;
 *   3. `businessId` was unauthenticated. Under a secret SHARED across tenants
 *      — the model the body-only scheme exists for — one signed delivery
 *      replayed at another tenant's route verified and posted there too;
 *   4. the identity extractor was a free argument of the call, so one wired to
 *      a constant field returned a well-formed id every time;
 *   5. the replay key used the bare adapter key while the registry identifies
 *      an adapter by `kind/adapterKey`, so one provider under two service
 *      kinds shared one namespace.
 *
 * And the sixth is why this file now builds a REGISTRY rather than passing
 * descriptors: `verify` took an `AdapterDescriptor` from its caller and
 * re-checked nothing on it, so a `/` in an adapter key or a kind outside the
 * closed set collapsed two namespaces, and an unknown scheme fell through to
 * the weakest signed mode. This suite was itself the proof of the bypass — it
 * spread object literals into `verify` and never went through
 * `AdapterRegistry.build`. It cannot do that any more.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  MONEY_BEARING_SERVICE_KINDS,
  NON_MONEY_BEARING_SERVICE_KINDS,
  SERVICE_KINDS,
  InMemoryReplayStore,
  MAX_IDENTITY_FIELD_LENGTH,
  WebhookGate,
  eventSourceOf,
  replayKeyOf,
  type AdapterDescriptor,
  type RawWebhookRequest,
  type ReplayStore,
  type ServiceKind,
  type WebhookIdentity,
  type WebhookSignatureScheme,
} from '../apps/api/src/modules/integrations';

const SECRET = Buffer.from('f3a1b2c3d4e5f60718293a4b5c6d7e8f', 'hex');
const WINDOW = 300;
/** The owner's "small declared skew": five minutes. */
const SKEW = 300;
const NOW_MS = 1_780_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const EVENT_ID = 'wamid.HBgMOTk5';
const ACCOUNT = 'waba_1001';
/** The registered pair the gate is asked for, in the order `verify` takes. */
const WA = ['notification.whatsapp', 'whatsapp_cloud'] as const;

/** A durable store stands in for the table: not a test double. */
class DurableLikeStore implements ReplayStore {
  readonly isTestDouble = false;
  private readonly seen = new Set<string>();
  async remember(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  size(): number {
    return this.seen.size;
  }
}

/** The provider's real rule, read back out of the verified bytes. */
function extractIdentity(verified: Buffer): WebhookIdentity | undefined {
  const text = verified.toString('utf8');
  const account = /"account":"([^"]*)"/.exec(text);
  const id = /"id":"([^"]*)"/.exec(text);
  if (account === null || id === null) return undefined;
  return { accountRef: account[1] as string, externalEventId: id[1] as string };
}

function adapter(
  over: {
    kind?: ServiceKind;
    scheme?: WebhookSignatureScheme;
    extract?: AdapterDescriptor['extractWebhookIdentity'];
    producesFinancialEvent?: boolean;
  } = {},
): AdapterDescriptor {
  const scheme = over.scheme ?? 'hmac_sha256_ts_body';
  return {
    kind: over.kind ?? 'notification.whatsapp',
    adapterKey: 'whatsapp_cloud',
    mode: 'delivers',
    capabilities: {
      serverSideIdempotency: false,
      requiresApprovedTemplate: false,
      supportsDeliveryReceipts: false,
      supportsRefund: false,
      supportsPartialRefund: false,
      supportsHostedFields: false,
      webhookSignatureScheme: scheme,
      supportedCountries: [],
      supportedCurrencies: [],
      supportedLocales: [],
    },
    secretSlots: ['access_token'],
    allowedHosts: ['graph.facebook.com'],
    isTestDouble: false,
    producesFinancialEvent: over.producesFinancialEvent ?? false,
    extractWebhookIdentity: scheme === 'none' ? undefined : (over.extract ?? extractIdentity),
  };
}

function bodyWith(id: string, account: string = ACCOUNT, extra = ''): Buffer {
  return Buffer.from(`{"account":"${account}","id":"${id}","amount":1200,"note":"caf\\u00e9"${extra}}`, 'utf8');
}

function signTsBody(timestamp: string, rawBody: Buffer, secret: Buffer = SECRET): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from('.', 'utf8'), rawBody]))
    .digest('hex');
}

function signBody(rawBody: Buffer, secret: Buffer = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function request(over: Partial<RawWebhookRequest> = {}): RawWebhookRequest {
  const rawBody = over.rawBody ?? bodyWith(EVENT_ID);
  const timestamp = over.timestampHeader ?? String(NOW_S);
  return {
    businessId: 'b1',
    expectedAccountRef: ACCOUNT,
    rawBody,
    timestampHeader: timestamp,
    signatureHeader: signTsBody(timestamp, rawBody),
    ...over,
  };
}

function gate(
  opts: {
    store?: ReplayStore;
    hmac?: (k: Buffer, m: Buffer) => Buffer;
    acceptTimestampUnboundScheme?: boolean;
    production?: boolean;
    adapters?: readonly AdapterDescriptor[];
    skewSeconds?: number;
  } = {},
) {
  const store = opts.store ?? new DurableLikeStore();
  const registry = AdapterRegistry.build(opts.adapters ?? [adapter()], { production: false });
  return {
    store,
    registry,
    gate: new WebhookGate(
      {
        timestampWindowSeconds: WINDOW,
        acceptTimestampUnboundScheme: opts.acceptTimestampUnboundScheme ?? false,
        production: opts.production ?? false,
        maxSignedInstantAheadOfArrivalSeconds: opts.skewSeconds ?? SKEW,
      },
      store,
      registry,
      () => NOW_MS,
      opts.hmac,
    ),
  };
}

/**
 * The accepted verdict in full. With no signed instant in the payload the
 * economic instant IS the arrival instant, and the flag says so — which is
 * what the owner's decision requires a consumer to be able to tell.
 */
const acceptedWith = (key: string, replay = false) => ({
  accepted: true,
  replay,
  key,
  economicInstantMs: NOW_MS,
  arrivalInstantMs: NOW_MS,
  economicInstantSigned: false,
});

const keyFor = (id: string = EVENT_ID, businessId = 'b1', kind = 'notification.whatsapp'): string =>
  replayKeyOf({ businessId, kind, adapterKey: 'whatsapp_cloud', externalEventId: id });

describe('the gate refuses to exist without the three parameters nobody should default', () => {
  it('rejects a nonsense window, an unstated scheme policy, and an unstated environment', () => {
    const store = new DurableLikeStore();
    const registry = AdapterRegistry.build([adapter()], { production: false });
    const base = { acceptTimestampUnboundScheme: false, production: false, maxSignedInstantAheadOfArrivalSeconds: SKEW };
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WebhookGate({ ...base, timestampWindowSeconds: bad as never }, store, registry, () => NOW_MS)).toThrow(/timestampWindowSeconds/);
    }
    expect(
      () => new WebhookGate({ ...base, timestampWindowSeconds: WINDOW, acceptTimestampUnboundScheme: undefined as never }, store, registry, () => NOW_MS),
    ).toThrow(/acceptTimestampUnboundScheme/);
    expect(() => new WebhookGate({ ...base, timestampWindowSeconds: WINDOW, production: undefined as never }, store, registry, () => NOW_MS)).toThrow(
      /production/,
    );
    for (const bad of [undefined, -1, 1.5, Number.NaN]) {
      expect(
        () => new WebhookGate({ ...base, timestampWindowSeconds: WINDOW, maxSignedInstantAheadOfArrivalSeconds: bad as never }, store, registry, () => NOW_MS),
      ).toThrow(/maxSignedInstantAheadOfArrivalSeconds/);
    }
    expect(new WebhookGate({ ...base, timestampWindowSeconds: WINDOW }, store, registry, () => NOW_MS)).toBeDefined();
  });
});

describe('only a REGISTERED adapter can be used — the descriptor is never taken on trust', () => {
  it('refuses a pair the registry does not hold, by name', async () => {
    const { gate: g } = gate();
    const unregistered: Array<[ServiceKind, string]> = [
      ['payment.merchant_checkout', 'whatsapp_cloud'],
      ['notification.whatsapp', 'other_cloud'],
    ];
    for (const [kind, key] of unregistered) {
      const v = await g.verify(request(), SECRET, kind, key);
      expect(v.accepted, `${kind}/${key}`).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('adapter_unregistered');
    }
    // positive control: the registered pair IS accepted, so the refusals above
    // are the lookup and not a broken request.
    expect((await g.verify(request(), SECRET, ...WA)).accepted).toBe(true);
  });

  it('cannot be handed an adapter key carrying the namespace separator, because the registry refuses it', () => {
    // This is what made the lookup necessary: a `/` inside the key would have
    // let two namespaces collide, and the gate re-checked nothing.
    expect(() => AdapterRegistry.build([{ ...adapter(), adapterKey: 'whatsapp/cloud' }], { production: false })).toThrow(/adapterKey/);
    expect(() => AdapterRegistry.build([{ ...adapter(), kind: 'notification.telegram' as never }], { production: false })).toThrow(/service kind/);
    expect(() =>
      AdapterRegistry.build([{ ...adapter(), capabilities: { ...adapter().capabilities, webhookSignatureScheme: 'hmac_sha1_body' as never } }], {
        production: false,
      }),
    ).toThrow(/signature scheme/);
  });
});

describe('the signature is checked FIRST, so the endpoint is not a clock oracle', () => {
  it('reports signature_mismatch — not a timestamp verdict — for a bad signature with a bad timestamp', async () => {
    const { gate: g } = gate();
    const old = String(NOW_S - WINDOW - 1);
    const v = await g.verify(request({ timestampHeader: old, signatureHeader: signBody(bodyWith(EVENT_ID)) }), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
  });

  it('still reports the window once the signature is valid, on BOTH sides and on the exact bound', async () => {
    const { gate: g } = gate();
    for (const delta of [-(WINDOW + 1), WINDOW + 1]) {
      const ts = String(NOW_S + delta);
      const body = bodyWith(EVENT_ID);
      const v = await g.verify(request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }), SECRET, ...WA);
      expect(v.accepted, String(delta)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_outside_window');
    }
    for (const [delta, id] of [
      [-WINDOW, 'evt_low'],
      [WINDOW, 'evt_high'],
    ] as const) {
      const ts = String(NOW_S + delta);
      const body = bodyWith(id);
      const v = await g.verify(request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }), SECRET, ...WA);
      expect(v.accepted, String(delta)).toBe(true);
    }
  });

  it('rejects a malformed timestamp the provider itself signed, rather than coercing it', async () => {
    const { gate: g } = gate();
    for (const ts of ['', 'now', '17800000000000000000000', '1.5e9', ' 1780000000']) {
      const body = bodyWith(EVENT_ID);
      const v = await g.verify(request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }), SECRET, ...WA);
      expect(v.accepted, JSON.stringify(ts)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_malformed');
    }
  });
});

describe("a scheme that does not bind the timestamp is the owner's call, not a default", () => {
  it('refuses it unless the deployment said otherwise, and refuses an unsigned scheme always', async () => {
    const strict = gate({ adapters: [adapter({ scheme: 'hmac_sha256_body' })], acceptTimestampUnboundScheme: false });
    const v = await strict.gate.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('scheme_not_timestamp_bound');

    const none = gate({ adapters: [adapter({ scheme: 'none' })] });
    const unsigned = await none.gate.verify(request(), SECRET, ...WA);
    expect(unsigned.accepted).toBe(false);
    if (!unsigned.accepted) expect(unsigned.rejection).toBe('scheme_unsigned');

    const nonePermissive = gate({ adapters: [adapter({ scheme: 'none' })], acceptTimestampUnboundScheme: true });
    expect((await nonePermissive.gate.verify(request(), SECRET, ...WA)).accepted).toBe(false);
  });

  it('admits it against a durable store, and then does not consult the clock at all', async () => {
    const body = bodyWith(EVENT_ID);
    const req = request({ rawBody: body, signatureHeader: signBody(body) });
    const durable = gate({ adapters: [adapter({ scheme: 'hmac_sha256_body' })], acceptTimestampUnboundScheme: true });
    const accepted = await durable.gate.verify(req, SECRET, ...WA);
    expect(accepted).toEqual(acceptedWith(keyFor()));

    const staleBody = bodyWith('evt_stale');
    const stale = await durable.gate.verify({ ...req, timestampHeader: '1', rawBody: staleBody, signatureHeader: signBody(staleBody) }, SECRET, ...WA);
    expect(stale.accepted).toBe(true);
  });
});

describe('replay prevention is mandatory under every scheme, so the store may not be a double', () => {
  it('refuses a test-double store in production whatever the scheme, and for an unbound scheme anywhere', async () => {
    const inProduction = gate({ store: new InMemoryReplayStore(), production: true });
    const v = await inProduction.gate.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('replay_store_not_durable');

    const unbound = gate({
      store: new InMemoryReplayStore(),
      adapters: [adapter({ scheme: 'hmac_sha256_body' })],
      acceptTimestampUnboundScheme: true,
      production: false,
    });
    const body = bodyWith(EVENT_ID);
    const u = await unbound.gate.verify(request({ rawBody: body, signatureHeader: signBody(body) }), SECRET, ...WA);
    expect(u.accepted).toBe(false);
    if (!u.accepted) expect(u.rejection).toBe('replay_store_not_durable');

    // positive control: the double IS allowed for a timestamp-bound scheme
    // outside production, so the two refusals above are the flag and the
    // scheme rather than a broken double.
    const allowed = gate({ store: new InMemoryReplayStore(), production: false });
    expect((await allowed.gate.verify(request(), SECRET, ...WA)).accepted).toBe(true);
  });
});

describe('the HMAC is over the bytes as they arrived', () => {
  it('accepts the raw bytes and REJECTS the same JSON re-serialized', async () => {
    const { gate: g } = gate();
    const raw = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const signature = signTsBody(ts, raw);

    const ok = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(ok.accepted).toBe(true);

    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
    expect(reserialized.equals(raw)).toBe(false);
    const v = await g.verify(request({ rawBody: reserialized, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
  });

  it('rejects a one-bit corruption, a wrong secret, and a tampered timestamp', async () => {
    const { gate: g } = gate();
    const raw = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const good = signTsBody(ts, raw);
    const flipped = (Number.parseInt(good.slice(0, 1), 16) ^ 0x1).toString(16) + good.slice(1);

    const cases: Array<[string, string, string]> = [
      ['flipped bit', flipped, ts],
      ['wrong secret', signTsBody(ts, raw, randomBytes(16)), ts],
      ['tampered timestamp', good, String(NOW_S - 1)],
    ];
    for (const [name, signature, timestamp] of cases) {
      const v = await g.verify(request({ rawBody: raw, signatureHeader: signature, timestampHeader: timestamp }), SECRET, ...WA);
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
    }
  });

  it('rejects a signature of the wrong shape WITHOUT throwing (timingSafeEqual dies on a length mismatch)', async () => {
    const { gate: g } = gate();
    const good = signTsBody(String(NOW_S), bodyWith(EVENT_ID));
    for (const signature of ['', 'deadbeef', 'zz'.repeat(32), `${good}00`]) {
      const v = await g.verify(request({ signatureHeader: signature }), SECRET, ...WA);
      expect(v.accepted, JSON.stringify(signature)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('signature_malformed');
    }
  });

  it('refuses a request whose shape an HTTP layer can deliver, instead of throwing', async () => {
    const { gate: g } = gate();
    const malformed: Array<[string, Partial<RawWebhookRequest>]> = [
      ['body is not a Buffer', { rawBody: '{"id":"x"}' as never }],
      ['duplicated signature header arrives as an array', { signatureHeader: [signTsBody(String(NOW_S), bodyWith(EVENT_ID))] as never }],
      ['duplicated timestamp header arrives as an array', { timestampHeader: [String(NOW_S)] as never }],
      ['no business', { businessId: '' }],
      ['no expected account', { expectedAccountRef: '' }],
    ];
    for (const [name, over] of malformed) {
      // built from a VALID request and then spoiled, so the helper does not
      // trip over the broken field while signing it.
      const v = await g.verify({ ...request(), ...over }, SECRET, ...WA);
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('request_malformed');
    }
  });
});

describe('no secret means no authority, and no HMAC is computed at all', () => {
  it('returns unconfigured and never reaches the hasher', async () => {
    let calls = 0;
    const counting = (k: Buffer, m: Buffer): Buffer => {
      calls += 1;
      return createHmac('sha256', k).update(m).digest();
    };
    const { gate: g } = gate({ hmac: counting });

    for (const secret of [undefined, Buffer.alloc(0)]) {
      const v = await g.verify(request(), secret, ...WA);
      expect(v.accepted).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('unconfigured');
    }
    expect(calls).toBe(0);
    expect((await g.verify(request(), SECRET, ...WA)).accepted).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('the identity comes out of the SIGNED bytes — the first money defect', () => {
  it('cannot be mutated without breaking the signature', async () => {
    const { gate: g } = gate();
    const raw = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const signature = signTsBody(ts, raw);

    const mutated = Buffer.from(raw.toString('utf8').replace(EVENT_ID, 'wamid.FORGED00'), 'utf8');
    expect(mutated.equals(raw)).toBe(false);
    const forged = await g.verify(request({ rawBody: mutated, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(forged.accepted).toBe(false);
    if (!forged.accepted) expect(forged.rejection).toBe('signature_mismatch');

    const honest = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(honest).toEqual(acceptedWith(keyFor(EVENT_ID)));
  });

  it('offers no field in which to pass an identity beside the body', () => {
    expect(Object.keys(request()).sort()).toEqual(['businessId', 'expectedAccountRef', 'rawBody', 'signatureHeader', 'timestampHeader'].sort());
  });
});

describe("the owner's own acceptance condition, in the owner's words", () => {
  /**
   * The owner stated the rule and the test together: the event id must be
   * INSIDE what the signature covers — extracted from the signed body or
   * carried in the signing string — and no id from outside the signed bytes is
   * accepted. Then: "a correctly signed message, re-sent with a different id,
   * is accepted today and must be refused", with the positive control "the
   * original message is accepted exactly once".
   *
   * It was run red first, and the red is on the DEFECTIVE CODE ITSELF, not on
   * a mutant of the current gate. The gate as it stood at 8ad606ce took the
   * event id as a field on the request, beside the body, so changing it does
   * not touch the signature: the owner's case run against that commit gives
   * EXIT=1, "expected true to be false" — the forged id really was accepted.
   *
   * An earlier version of this comment claimed the red came from removing the
   * body from the signed message. That is the attempt I DISCARDED, and the
   * claim was also wrong on its face: with the body uncovered every signature
   * fails, so the first assertion below PASSES and it is the positive control
   * that breaks — red for the wrong reason, which proves nothing.
   */
  it('refuses a correctly signed message re-sent with a different id, and accepts the original exactly once', async () => {
    const { gate: g, store } = gate();
    const original = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const signature = signTsBody(ts, original);

    const resentWithAnotherId = Buffer.from(original.toString('utf8').replace(EVENT_ID, 'wamid.OTHER01'), 'utf8');
    const forged = await g.verify(request({ rawBody: resentWithAnotherId, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(forged.accepted).toBe(false);

    const first = await g.verify(request({ rawBody: original, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    const second = await g.verify(request({ rawBody: original, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(first).toEqual(acceptedWith(keyFor(EVENT_ID)));
    expect(second).toEqual(acceptedWith(keyFor(EVENT_ID), true));
    expect((store as DurableLikeStore).size()).toBe(1);

    expect(Object.keys(request())).not.toContain('externalEventId');
  });
});

describe('the TENANT is checked too — the third money defect, and the sharpest', () => {
  it('refuses one signed delivery replayed at another tenant, under a secret shared between them', async () => {
    // ONE secret, as with a single Meta app serving every tenant. The
    // signature cannot tell the businesses apart, so without the account check
    // the replay below would verify.
    const { gate: g, store } = gate();
    const raw = bodyWith(EVENT_ID, 'waba_1001');
    const ts = String(NOW_S);
    const signature = signTsBody(ts, raw);

    const atOtherTenant = await g.verify(
      {
        businessId: 'b2',
        expectedAccountRef: 'waba_2002',
        rawBody: raw,
        timestampHeader: ts,
        signatureHeader: signature,
      },
      SECRET,
      ...WA,
    );
    expect(atOtherTenant.accepted).toBe(false);
    if (!atOtherTenant.accepted) expect(atOtherTenant.rejection).toBe('account_mismatch');
    expect((store as DurableLikeStore).size()).toBe(0);

    // positive control: the SAME bytes and the SAME secret are accepted at the
    // tenant the payload names, so the refusal is the account, not the
    // signature.
    const atOwnTenant = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, ...WA);
    expect(atOwnTenant).toEqual(acceptedWith(keyFor(EVENT_ID, 'b1')));
  });

  it('refuses an absent or unusable account reference by name', async () => {
    const { gate: g } = gate();
    const noAccount = Buffer.from(`{"id":"${EVENT_ID}"}`, 'utf8');
    const ts = String(NOW_S);
    const v = await g.verify(request({ rawBody: noAccount, timestampHeader: ts, signatureHeader: signTsBody(ts, noAccount) }), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('identity_absent');

    const weird = gate({
      adapters: [adapter({ extract: () => ({ accountRef: 'a\nb', externalEventId: EVENT_ID }) })],
    });
    const w = await weird.gate.verify(request(), SECRET, ...WA);
    expect(w.accepted).toBe(false);
    if (!w.accepted) expect(w.rejection).toBe('identity_malformed');
  });
});

describe('the extraction rule lives on the adapter — the fourth money defect', () => {
  it('is required of a signing adapter and refused of a non-signing one, at BUILD time', () => {
    expect(() => AdapterRegistry.build([{ ...adapter(), extractWebhookIdentity: undefined }], { production: false })).toThrow(/extractWebhookIdentity/);
    expect(() =>
      AdapterRegistry.build([{ ...adapter({ scheme: 'none' }), extractWebhookIdentity: extractIdentity }], {
        production: false,
      }),
    ).toThrow(/must not declare/);
    // positive control: the matched pairs both build.
    expect(AdapterRegistry.build([adapter()], { production: false }).get('notification.whatsapp', 'whatsapp_cloud')).toBeDefined();
    expect(AdapterRegistry.build([adapter({ scheme: 'none' })], { production: false }).get('notification.whatsapp', 'whatsapp_cloud')).toBeDefined();
  });

  it('refuses rather than crashing when the extractor throws on a body the provider signed', async () => {
    const parsing = (b: Buffer): WebhookIdentity | undefined => {
      const o = JSON.parse(b.toString('utf8')) as { account?: string; id?: string };
      return { accountRef: o.account ?? '', externalEventId: o.id ?? '' };
    };
    const { gate: g } = gate({ adapters: [adapter({ extract: parsing })] });
    const notJson = Buffer.from('<xml>the provider changed its shape</xml>', 'utf8');
    const ts = String(NOW_S);
    const v = await g.verify(request({ rawBody: notJson, timestampHeader: ts, signatureHeader: signTsBody(ts, notJson) }), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('identity_malformed');
  });

  it('keeps two distinct events apart through verify, not merely through the key function', async () => {
    const { gate: g, store } = gate();
    const ts = String(NOW_S);
    const keys: string[] = [];
    for (const id of ['evt_one', 'evt_two']) {
      const body = bodyWith(id);
      const v = await g.verify(request({ rawBody: body, timestampHeader: ts, signatureHeader: signTsBody(ts, body) }), SECRET, ...WA);
      expect(v.accepted, id).toBe(true);
      if (v.accepted) {
        expect(v.replay, id).toBe(false);
        keys.push(v.key);
      }
    }
    expect(new Set(keys).size).toBe(2);
    expect((store as DurableLikeStore).size()).toBe(2);
  });
});

describe('an absent or unusable event id is refused by name — the second money defect', () => {
  it('refuses rather than collapsing every event onto one key', async () => {
    const absent: Array<[string, AdapterDescriptor['extractWebhookIdentity']]> = [
      ['extractor finds nothing', () => undefined],
      ['empty id', () => ({ accountRef: ACCOUNT, externalEventId: '' })],
    ];
    for (const [name, extract] of absent) {
      const { gate: g, store } = gate({ adapters: [adapter({ extract })] });
      const v = await g.verify(request(), SECRET, ...WA);
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('identity_absent');
      expect((store as DurableLikeStore).size(), name).toBe(0);
    }
    const honest = gate();
    const real = await honest.gate.verify(request(), SECRET, ...WA);
    expect(real).toEqual(acceptedWith(keyFor()));
  });

  it('refuses an id carrying a newline, a space, a control byte, or more than the cap', async () => {
    const bad = ['evt\nFAKE_LOG_LINE', 'evt one', 'evt\u0000one', 'e'.repeat(MAX_IDENTITY_FIELD_LENGTH + 1)];
    for (const id of bad) {
      const { gate: g } = gate({
        adapters: [adapter({ extract: () => ({ accountRef: ACCOUNT, externalEventId: id }) })],
      });
      const v = await g.verify(request(), SECRET, ...WA);
      expect(v.accepted, JSON.stringify(id)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('identity_malformed');
    }
    const atCap = gate({
      adapters: [
        adapter({
          extract: () => ({ accountRef: ACCOUNT, externalEventId: 'e'.repeat(MAX_IDENTITY_FIELD_LENGTH) }),
        }),
      ],
    });
    expect((await atCap.gate.verify(request(), SECRET, ...WA)).accepted).toBe(true);
  });
});

describe('an extractor that returns null is a refusal, not a crash', () => {
  it('refuses instead of throwing out of verify', async () => {
    // `null` is what `RegExp.exec` returns, and what a compiled caller writes
    // for "no identity". Read as an object it threw out of `verify`.
    const nulled = gate({ adapters: [adapter({ extract: () => null as never })] });
    const v = await nulled.gate.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('identity_absent');

    const nullField = gate({
      adapters: [adapter({ extract: () => ({ accountRef: ACCOUNT, externalEventId: null as never }) })],
    });
    const p = await nullField.gate.verify(request(), SECRET, ...WA);
    expect(p.accepted).toBe(false);
    if (!p.accepted) expect(p.rejection).toBe('identity_absent');
  });
});

describe("the replay namespace is the registry's own identity, not the bare adapter key", () => {
  it('keeps one provider registered under two service kinds in separate namespaces', async () => {
    // The registry identifies an adapter by `kind/adapterKey`, and the closed
    // set carries two payment kinds — P5's platform billing and P6's merchant
    // checkout. Keyed on the bare adapter key, two INDEPENDENT events sharing
    // an external id collapse: the second is reported as a replay, which is a
    // money event behind a success.
    const { gate: g, store } = gate({
      adapters: [
        // a payment kind must declare its financial effect, so this is
        // what a real registration of it looks like
        adapter({ kind: 'payment.merchant_checkout', producesFinancialEvent: true }),
        adapter({ kind: 'webhook.inbound' }),
      ],
    });
    const ts = String(NOW_S);
    const body = bodyWith(EVENT_ID);
    const req = request({ rawBody: body, timestampHeader: ts, signatureHeader: signTsBody(ts, body) });

    const underCheckout = await g.verify(req, SECRET, 'payment.merchant_checkout', 'whatsapp_cloud');
    const underInbound = await g.verify(req, SECRET, 'webhook.inbound', 'whatsapp_cloud');

    expect(underCheckout.accepted).toBe(true);
    expect(underInbound.accepted).toBe(true);
    if (underCheckout.accepted && underInbound.accepted) {
      expect(underCheckout.replay).toBe(false);
      expect(underInbound.replay).toBe(false);
      expect(underCheckout.key).not.toBe(underInbound.key);
    }
    expect((store as DurableLikeStore).size()).toBe(2);

    // positive control: the SAME kind twice is still one namespace, so the
    // separation above is the kind and not two keys for everything.
    const again = await g.verify(req, SECRET, 'webhook.inbound', 'whatsapp_cloud');
    expect(again.accepted).toBe(true);
    if (again.accepted) expect(again.replay).toBe(true);
    expect((store as DurableLikeStore).size()).toBe(2);
  });

  it('prefix-encodes the key, so its injectivity does not rest on a charset checked in another file', () => {
    // The canonical `event_source` for the column is the readable composite.
    expect(eventSourceOf('notification.whatsapp', 'whatsapp_cloud')).toBe('notification.whatsapp/whatsapp_cloud');
    // The KEY keeps the two parts separate and length-prefixed, so even a
    // separator inside a part cannot make two keys collide.
    const left = replayKeyOf({ businessId: 'b1', kind: 'a', adapterKey: 'b_c', externalEventId: 'x' });
    const right = replayKeyOf({ businessId: 'b1', kind: 'a_b', adapterKey: 'c', externalEventId: 'x' });
    expect(left).not.toBe(right);
    const slashLeft = replayKeyOf({ businessId: 'b1', kind: 'a/b', adapterKey: 'c', externalEventId: 'x' });
    const slashRight = replayKeyOf({ businessId: 'b1', kind: 'a', adapterKey: 'b/c', externalEventId: 'x' });
    expect(slashLeft).not.toBe(slashRight);
  });
});

describe('a money adapter may never ride an unsigned timestamp', () => {
  /**
   * The owner's decision (2026-11-08, DR-107/2): the body-only scheme is
   * permitted ONLY for an adapter that produces no financial effect — inbound
   * messages, as WhatsApp — and FORBIDDEN BY LAW for any adapter that produces
   * a money event, "with a control that fails if the two are combined".
   *
   * So the control is at BUILD time and does not depend on the deployment
   * option: a descriptor claiming both is refused outright, whatever any
   * environment says. `acceptTimestampUnboundScheme` can then only ever widen
   * the non-financial case, never reach a financial one.
   */
  it('refuses the combination at build time, whatever the deployment allows', () => {
    expect(() =>
      AdapterRegistry.build([adapter({ scheme: 'hmac_sha256_body', producesFinancialEvent: true })], {
        production: false,
      }),
    ).toThrow(/financial/i);
    // positive control, both halves: each property on its own builds, so the
    // refusal is the COMBINATION and not either one.
    expect(
      AdapterRegistry.build([adapter({ scheme: 'hmac_sha256_body', producesFinancialEvent: false })], {
        production: false,
      }).get(...WA),
    ).toBeDefined();
    expect(
      AdapterRegistry.build([adapter({ scheme: 'hmac_sha256_ts_body', producesFinancialEvent: true })], {
        production: false,
      }).get(...WA),
    ).toBeDefined();
  });

  it('refuses a MONEY-BEARING adapter that declares itself free of financial effect', () => {
    // The rule is a set against the closed list, not a `payment.` prefix. The
    // prefix missed `fx.rates`, which the finance review caught: a rate is not
    // a posting, but the ledger recomputes amounts from it, so a replayed or
    // stale rate moves every amount posted against it.
    for (const kind of MONEY_BEARING_SERVICE_KINDS) {
      expect(() => AdapterRegistry.build([adapter({ kind, producesFinancialEvent: false })], { production: false })).toThrow(/money-bearing/i);
    }
    expect(MONEY_BEARING_SERVICE_KINDS).toContain('fx.rates');
    // positive control: a non-money kind may declare false and does build.
    expect(
      AdapterRegistry.build([adapter({ kind: 'notification.sms', producesFinancialEvent: false })], {
        production: false,
      }).get('notification.sms', 'whatsapp_cloud'),
    ).toBeDefined();
  });

  it('classifies EVERY service kind, so a new one cannot join the exempt side in silence', () => {
    const classified = [...MONEY_BEARING_SERVICE_KINDS, ...NON_MONEY_BEARING_SERVICE_KINDS].sort();
    expect(classified).toEqual([...SERVICE_KINDS].sort());
    // and the two sides do not overlap, or the law would be ambiguous.
    const overlap = MONEY_BEARING_SERVICE_KINDS.filter((k) => (NON_MONEY_BEARING_SERVICE_KINDS as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });

  it('refuses a payment adapter that declares itself free of financial effect', () => {
    // Not the owner's words but a consequence of them: the two payment kinds
    // are money by construction, so a descriptor claiming otherwise declares
    // something that cannot be true — and the law above would be bypassed by
    // writing `false`.
    for (const kind of ['payment.platform_billing', 'payment.merchant_checkout'] as const) {
      expect(() => AdapterRegistry.build([adapter({ kind, producesFinancialEvent: false })], { production: false })).toThrow(/financial/i);
    }
    expect(
      AdapterRegistry.build([adapter({ kind: 'payment.merchant_checkout', producesFinancialEvent: true })], {
        production: false,
      }).get('payment.merchant_checkout', 'whatsapp_cloud'),
    ).toBeDefined();
  });

  it('still lets the non-financial inbound case through, which is what the permission is for', async () => {
    const body = bodyWith(EVENT_ID);
    const { gate: g } = gate({
      adapters: [adapter({ scheme: 'hmac_sha256_body', producesFinancialEvent: false })],
      acceptTimestampUnboundScheme: true,
    });
    const v = await g.verify(request({ rawBody: body, signatureHeader: signBody(body) }), SECRET, ...WA);
    expect(v.accepted).toBe(true);
  });
});

describe('the economic instant is what the provider signed', () => {
  /**
   * DR-107/3: the time the provider signs INSIDE the payload is the economic
   * truth of the event; the arrival time is recorded in its own field; where no
   * signed time exists the arrival time is used; and a signed time ahead of
   * arrival by more than a small declared skew is refused.
   */
  const withInstant = (ms: number | undefined): AdapterDescriptor =>
    adapter({
      extract: (b) => {
        const base = extractIdentity(b);
        return base === undefined ? undefined : { ...base, signedInstantMs: ms };
      },
    });

  it('takes the signed instant as the economic one, and records arrival separately', async () => {
    const signedAt = NOW_MS - 90_000;
    const { gate: g } = gate({ adapters: [withInstant(signedAt)] });
    const v = await g.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(true);
    if (v.accepted) {
      expect(v.economicInstantMs).toBe(signedAt);
      expect(v.arrivalInstantMs).toBe(NOW_MS);
      expect(v.economicInstantSigned).toBe(true);
      expect(v.economicInstantMs).not.toBe(v.arrivalInstantMs);
    }
  });

  it('falls back to arrival when the provider signs no instant, and says that it did', async () => {
    const { gate: g } = gate({ adapters: [withInstant(undefined)] });
    const v = await g.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(true);
    if (v.accepted) {
      expect(v.economicInstantMs).toBe(NOW_MS);
      expect(v.arrivalInstantMs).toBe(NOW_MS);
      // The flag is the point: a consumer must be able to tell a provider
      // instant from a platform one, or it cannot know what it is posting on.
      expect(v.economicInstantSigned).toBe(false);
    }
  });

  it('refuses a signed instant ahead of arrival by more than the declared skew, and accepts the exact bound', async () => {
    const onBound = gate({ adapters: [withInstant(NOW_MS + SKEW * 1000)] });
    expect((await onBound.gate.verify(request(), SECRET, ...WA)).accepted).toBe(true);

    const beyond = gate({ adapters: [withInstant(NOW_MS + SKEW * 1000 + 1)] });
    const v = await beyond.gate.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('instant_ahead_of_arrival');
  });

  it('refuses an unusable signed instant rather than coercing it', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, '1780000000000']) {
      const { gate: g } = gate({ adapters: [withInstant(bad as never)] });
      const v = await g.verify(request(), SECRET, ...WA);
      expect(v.accepted, String(bad)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('instant_malformed');
    }
  });

  it('does not bound the signed instant in the PAST, which the decision deliberately does not ask for', async () => {
    const { gate: g } = gate({ adapters: [withInstant(NOW_MS - 400 * 24 * 3600 * 1000)] });
    const v = await g.verify(request(), SECRET, ...WA);
    expect(v.accepted).toBe(true);
  });
});

describe('a re-delivery is processed once, and the key is byte-identical across attempts', () => {
  it('accepts the first delivery and marks the second a replay', async () => {
    const { gate: g, store } = gate();
    const first = await g.verify(request(), SECRET, ...WA);
    const second = await g.verify(request(), SECRET, ...WA);

    expect(first).toEqual(acceptedWith(keyFor()));
    expect(second).toEqual(acceptedWith(keyFor(), true));
    expect((store as DurableLikeStore).size()).toBe(1);
  });

  it('derives the key from identity alone, so a retry cannot mint a new one', () => {
    const a = keyFor();
    expect(Buffer.from(a, 'utf8').equals(Buffer.from(keyFor(), 'utf8'))).toBe(true);
    expect(keyFor(EVENT_ID, 'b2')).not.toBe(a);
    expect(keyFor(EVENT_ID, 'b1', 'webhook.inbound')).not.toBe(a);
    expect(keyFor('evt_9')).not.toBe(a);
  });

  it('does not record anything when the signature fails', async () => {
    const { gate: g, store } = gate();
    const v = await g.verify(request({ signatureHeader: signTsBody(String(NOW_S), Buffer.from('x')) }), SECRET, ...WA);
    expect(v.accepted).toBe(false);
    expect((store as DurableLikeStore).size()).toBe(0);
  });
});

describe('the verdict acknowledges, and carries no payload beyond the identity', () => {
  it('returns three fields, and no body content reaches them', async () => {
    const marker = 'MARKER_7f3c2a';
    const raw = bodyWith(EVENT_ID, ACCOUNT, `,"secretish":"${marker}"`);
    const ts = String(NOW_S);
    const { gate: g } = gate();
    const v = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signTsBody(ts, raw) }), SECRET, ...WA);
    expect(v.accepted).toBe(true);
    // Six fields now, not three: the owner's decision requires the economic
    // instant and the arrival instant to be carried separately. None of them is
    // payload CONTENT, which is the property this test is about.
    expect(Object.keys(v).sort()).toEqual(['accepted', 'arrivalInstantMs', 'economicInstantMs', 'economicInstantSigned', 'key', 'replay'].sort());
    expect(JSON.stringify(v)).not.toContain(marker);
    // positive control: the marker IS in the bytes, so the absence above is
    // about the verdict and not about a marker that was never there.
    expect(raw.toString('utf8')).toContain(marker);
    if (v.accepted) {
      expect(v.key).toContain(EVENT_ID);
      expect(/^[\x20-\x7e]+$/.test(v.key)).toBe(true);
    }
  });
});
