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
 * Four defects two review rounds found in this gate are what most of this file
 * now exists to hold shut, and all four are money defects:
 *   1. the external event id arrived BESIDE the signed bytes, so one validly
 *      signed delivery replayed with a mutated id was accepted as a new event;
 *   2. an absent or blank id had no refusal channel, and collapsed every event
 *      of a business onto one key — money events behind a reported success;
 *   3. `businessId` was still unauthenticated. Under a secret SHARED across
 *      tenants, which is the model the body-only scheme exists for, one signed
 *      delivery replayed at another tenant's route verified and posted there
 *      too — `business_id` being the first column of the ledger's identity;
 *   4. the identity extractor was a free argument of the call, so one wired to
 *      a constant field returned a well-formed id every time and restored
 *      defect 2 through another door.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  InMemoryReplayStore,
  MAX_IDENTITY_FIELD_LENGTH,
  WebhookGate,
  replayKeyOf,
  type AdapterDescriptor,
  type RawWebhookRequest,
  type ReplayStore,
  type WebhookIdentity,
  type WebhookSignatureScheme,
} from '../apps/api/src/modules/integrations';

const SECRET = Buffer.from('f3a1b2c3d4e5f60718293a4b5c6d7e8f', 'hex');
const WINDOW = 300;
const NOW_MS = 1_780_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const EVENT_ID = 'wamid.HBgMOTk5';
const ACCOUNT = 'waba_1001';

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
    scheme?: WebhookSignatureScheme;
    extract?: AdapterDescriptor['extractWebhookIdentity'];
  } = {},
): AdapterDescriptor {
  const scheme = over.scheme ?? 'hmac_sha256_ts_body';
  return {
    kind: 'notification.whatsapp',
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
  } = {},
) {
  const store = opts.store ?? new DurableLikeStore();
  return {
    store,
    gate: new WebhookGate(
      {
        timestampWindowSeconds: WINDOW,
        acceptTimestampUnboundScheme: opts.acceptTimestampUnboundScheme ?? false,
        production: opts.production ?? false,
      },
      store,
      () => NOW_MS,
      opts.hmac,
    ),
  };
}

const EVENT_SOURCE = 'notification.whatsapp/whatsapp_cloud';

const keyFor = (id: string = EVENT_ID, businessId = 'b1'): string => replayKeyOf({ businessId, eventSource: EVENT_SOURCE, externalEventId: id });

describe('the gate refuses to exist without the three parameters nobody should default', () => {
  it('rejects a nonsense window, an unstated scheme policy, and an unstated environment', () => {
    const store = new DurableLikeStore();
    const base = { acceptTimestampUnboundScheme: false, production: false };
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WebhookGate({ ...base, timestampWindowSeconds: bad as never }, store, () => NOW_MS)).toThrow(/timestampWindowSeconds/);
    }
    expect(() => new WebhookGate({ ...base, timestampWindowSeconds: WINDOW, acceptTimestampUnboundScheme: undefined as never }, store, () => NOW_MS)).toThrow(
      /acceptTimestampUnboundScheme/,
    );
    expect(() => new WebhookGate({ ...base, timestampWindowSeconds: WINDOW, production: undefined as never }, store, () => NOW_MS)).toThrow(/production/);
    expect(new WebhookGate({ ...base, timestampWindowSeconds: WINDOW }, store, () => NOW_MS)).toBeDefined();
  });
});

describe('the signature is checked FIRST, so the endpoint is not a clock oracle', () => {
  it('reports signature_mismatch — not a timestamp verdict — for a bad signature with a bad timestamp', async () => {
    const { gate: g } = gate();
    const old = String(NOW_S - WINDOW - 1);
    const v = await g.verify(request({ timestampHeader: old, signatureHeader: signBody(bodyWith(EVENT_ID)) }), SECRET, adapter());
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
  });

  it('still reports the window once the signature is valid, on BOTH sides and on the exact bound', async () => {
    const { gate: g } = gate();
    for (const delta of [-(WINDOW + 1), WINDOW + 1]) {
      const ts = String(NOW_S + delta);
      const body = bodyWith(EVENT_ID);
      const v = await g.verify(request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }), SECRET, adapter());
      expect(v.accepted, String(delta)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_outside_window');
    }
    for (const [delta, id] of [
      [-WINDOW, 'evt_low'],
      [WINDOW, 'evt_high'],
    ] as const) {
      const ts = String(NOW_S + delta);
      const body = bodyWith(id);
      const v = await g.verify(request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }), SECRET, adapter());
      expect(v.accepted, String(delta)).toBe(true);
    }
  });

  it('rejects a malformed timestamp the provider itself signed, rather than coercing it', async () => {
    const { gate: g } = gate();
    for (const ts of ['', 'now', '17800000000000000000000', '1.5e9', ' 1780000000']) {
      const body = bodyWith(EVENT_ID);
      const v = await g.verify(request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }), SECRET, adapter());
      expect(v.accepted, JSON.stringify(ts)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_malformed');
    }
  });
});

describe("a scheme that does not bind the timestamp is the owner's call, not a default", () => {
  it('refuses it unless the deployment said otherwise, and refuses an unsigned scheme always', async () => {
    const { gate: g } = gate({ acceptTimestampUnboundScheme: false });
    const v = await g.verify(request(), SECRET, adapter({ scheme: 'hmac_sha256_body' }));
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('scheme_not_timestamp_bound');

    const unsigned = await g.verify(request(), SECRET, adapter({ scheme: 'none' }));
    expect(unsigned.accepted).toBe(false);
    if (!unsigned.accepted) expect(unsigned.rejection).toBe('scheme_unsigned');

    const permissive = gate({ acceptTimestampUnboundScheme: true });
    const stillUnsigned = await permissive.gate.verify(request(), SECRET, adapter({ scheme: 'none' }));
    expect(stillUnsigned.accepted).toBe(false);
  });

  it('admits it against a durable store, and then does not consult the clock at all', async () => {
    const body = bodyWith(EVENT_ID);
    const req = request({ rawBody: body, signatureHeader: signBody(body) });
    const durable = gate({ acceptTimestampUnboundScheme: true });
    const accepted = await durable.gate.verify(req, SECRET, adapter({ scheme: 'hmac_sha256_body' }));
    expect(accepted).toEqual({ accepted: true, replay: false, key: keyFor() });

    const staleBody = bodyWith('evt_stale');
    const stale = await durable.gate.verify(
      { ...req, timestampHeader: '1', rawBody: staleBody, signatureHeader: signBody(staleBody) },
      SECRET,
      adapter({ scheme: 'hmac_sha256_body' }),
    );
    expect(stale.accepted).toBe(true);
  });
});

describe('replay prevention is mandatory under every scheme, so the store may not be a double', () => {
  it('refuses a test-double store in production whatever the scheme, and for an unbound scheme anywhere', async () => {
    const inProduction = gate({ store: new InMemoryReplayStore(), production: true });
    const v = await inProduction.gate.verify(request(), SECRET, adapter());
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('replay_store_not_durable');

    const unboundOutsideProduction = gate({
      store: new InMemoryReplayStore(),
      acceptTimestampUnboundScheme: true,
      production: false,
    });
    const body = bodyWith(EVENT_ID);
    const u = await unboundOutsideProduction.gate.verify(
      request({ rawBody: body, signatureHeader: signBody(body) }),
      SECRET,
      adapter({ scheme: 'hmac_sha256_body' }),
    );
    expect(u.accepted).toBe(false);
    if (!u.accepted) expect(u.rejection).toBe('replay_store_not_durable');

    // positive control: the double IS allowed for a timestamp-bound scheme
    // outside production, which is what makes the two refusals above the
    // production flag and the scheme rather than a broken double.
    const allowed = gate({ store: new InMemoryReplayStore(), production: false });
    expect((await allowed.gate.verify(request(), SECRET, adapter())).accepted).toBe(true);
  });
});

describe('the HMAC is over the bytes as they arrived', () => {
  it('accepts the raw bytes and REJECTS the same JSON re-serialized', async () => {
    const { gate: g } = gate();
    const raw = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const signature = signTsBody(ts, raw);

    const ok = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    expect(ok.accepted).toBe(true);

    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
    expect(reserialized.equals(raw)).toBe(false);
    const v = await g.verify(request({ rawBody: reserialized, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
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
      const v = await g.verify(request({ rawBody: raw, signatureHeader: signature, timestampHeader: timestamp }), SECRET, adapter());
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
    }
  });

  it('rejects a signature of the wrong shape WITHOUT throwing (timingSafeEqual dies on a length mismatch)', async () => {
    const { gate: g } = gate();
    const good = signTsBody(String(NOW_S), bodyWith(EVENT_ID));
    for (const signature of ['', 'deadbeef', 'zz'.repeat(32), `${good}00`]) {
      const v = await g.verify(request({ signatureHeader: signature }), SECRET, adapter());
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
      const v = await g.verify({ ...request(), ...over }, SECRET, adapter());
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
      const v = await g.verify(request(), secret, adapter());
      expect(v.accepted).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('unconfigured');
    }
    expect(calls).toBe(0);
    expect((await g.verify(request(), SECRET, adapter())).accepted).toBe(true);
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
    const forged = await g.verify(request({ rawBody: mutated, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    expect(forged.accepted).toBe(false);
    if (!forged.accepted) expect(forged.rejection).toBe('signature_mismatch');

    const honest = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    expect(honest).toEqual({ accepted: true, replay: false, key: keyFor(EVENT_ID) });
  });

  it('offers no field in which to pass an identity beside the body', () => {
    expect(Object.keys(request()).sort()).toEqual(['businessId', 'expectedAccountRef', 'rawBody', 'signatureHeader', 'timestampHeader'].sort());
  });
});

describe("the owner's own acceptance condition, in the owner's words", () => {
  /**
   * The owner stated the rule and the test together: the event id must be
   * INSIDE what the signature covers — extracted from the signed body or
   * carried in the signing string — and no id from outside the signed bytes
   * is accepted. Then: "a correctly signed message, re-sent with a different
   * id, is accepted today and must be refused", with the positive control
   * "the original message is accepted exactly once".
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

    // (2a) the same signature, a different id. This must be refused.
    const resentWithAnotherId = Buffer.from(original.toString('utf8').replace(EVENT_ID, 'wamid.OTHER01'), 'utf8');
    const forged = await g.verify(request({ rawBody: resentWithAnotherId, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    expect(forged.accepted).toBe(false);

    // (2b) the positive control: the original is accepted, ONCE. Not "the
    // second call is also accepted and flagged" — once, meaning exactly one
    // key was claimed and the second delivery is not a new event.
    const first = await g.verify(request({ rawBody: original, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    const second = await g.verify(request({ rawBody: original, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    expect(first).toEqual({ accepted: true, replay: false, key: keyFor(EVENT_ID) });
    expect(second).toEqual({ accepted: true, replay: true, key: keyFor(EVENT_ID) });
    expect((store as DurableLikeStore).size()).toBe(1);

    // (1) and there is no id from outside the signed bytes to accept: the
    // request type carries none, and the extraction rule is the adapter's.
    expect(Object.keys(request())).not.toContain('externalEventId');
  });
});

describe('the TENANT is authenticated too — the third money defect, and the sharpest', () => {
  it('refuses one signed delivery replayed at another tenant, under a secret shared between them', async () => {
    // The whole point: ONE secret, as with a single Meta app serving every
    // tenant. The signature cannot tell the businesses apart, so without the
    // account check the replay below would verify.
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
      adapter(),
    );
    expect(atOtherTenant.accepted).toBe(false);
    if (!atOtherTenant.accepted) expect(atOtherTenant.rejection).toBe('account_mismatch');
    // nothing was claimed for the other tenant either.
    expect((store as DurableLikeStore).size()).toBe(0);

    // positive control: the SAME bytes and the SAME secret are accepted at the
    // tenant the payload actually names, so the refusal is the account and not
    // the signature.
    const atOwnTenant = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, adapter());
    expect(atOwnTenant).toEqual({ accepted: true, replay: false, key: keyFor(EVENT_ID, 'b1') });
  });

  it('refuses an absent or unusable account reference by name', async () => {
    const { gate: g } = gate();
    const noAccount = Buffer.from(`{"id":"${EVENT_ID}"}`, 'utf8');
    const ts = String(NOW_S);
    const v = await g.verify(request({ rawBody: noAccount, timestampHeader: ts, signatureHeader: signTsBody(ts, noAccount) }), SECRET, adapter());
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('identity_absent');

    const weird = await g.verify(request(), SECRET, adapter({ extract: () => ({ accountRef: 'a\nb', externalEventId: EVENT_ID }) }));
    expect(weird.accepted).toBe(false);
    if (!weird.accepted) expect(weird.rejection).toBe('identity_malformed');
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
    const { gate: g } = gate();
    const notJson = Buffer.from('<xml>the provider changed its shape</xml>', 'utf8');
    const ts = String(NOW_S);
    const parsing = (b: Buffer): WebhookIdentity | undefined => {
      const o = JSON.parse(b.toString('utf8')) as { account?: string; id?: string };
      return { accountRef: o.account ?? '', externalEventId: o.id ?? '' };
    };
    const v = await g.verify(
      request({ rawBody: notJson, timestampHeader: ts, signatureHeader: signTsBody(ts, notJson) }),
      SECRET,
      adapter({ extract: parsing }),
    );
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('identity_malformed');
  });

  it('keeps two distinct events apart through verify, not merely through the key function', async () => {
    const { gate: g, store } = gate();
    const ts = String(NOW_S);
    const keys: string[] = [];
    for (const id of ['evt_one', 'evt_two']) {
      const body = bodyWith(id);
      const v = await g.verify(request({ rawBody: body, timestampHeader: ts, signatureHeader: signTsBody(ts, body) }), SECRET, adapter());
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
    const { gate: g, store } = gate();
    const absent: Array<[string, AdapterDescriptor['extractWebhookIdentity']]> = [
      ['extractor finds nothing', () => undefined],
      ['empty id', () => ({ accountRef: ACCOUNT, externalEventId: '' })],
    ];
    for (const [name, extract] of absent) {
      const v = await g.verify(request(), SECRET, adapter({ extract }));
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('identity_absent');
    }
    expect((store as DurableLikeStore).size()).toBe(0);
    const real = await g.verify(request(), SECRET, adapter());
    expect(real).toEqual({ accepted: true, replay: false, key: keyFor() });
  });

  it('refuses an id carrying a newline, a space, a control byte, or more than the cap', async () => {
    const { gate: g } = gate();
    const bad = ['evt\nFAKE_LOG_LINE', 'evt one', 'evt\u0000one', 'e'.repeat(MAX_IDENTITY_FIELD_LENGTH + 1)];
    for (const id of bad) {
      const v = await g.verify(request(), SECRET, adapter({ extract: () => ({ accountRef: ACCOUNT, externalEventId: id }) }));
      expect(v.accepted, JSON.stringify(id)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('identity_malformed');
    }
    const atCap = await g.verify(
      request(),
      SECRET,
      adapter({ extract: () => ({ accountRef: ACCOUNT, externalEventId: 'e'.repeat(MAX_IDENTITY_FIELD_LENGTH) }) }),
    );
    expect(atCap.accepted).toBe(true);
  });
});

describe("the replay namespace is the registry's own identity, not the bare adapter key", () => {
  it('keeps one provider registered under two service kinds in separate namespaces', async () => {
    // The registry identifies an adapter by `kind/adapterKey`, and the card
    // expects one provider under two kinds — `payment.platform_billing` for
    // P5 and `payment.merchant_checkout` for P6. Keyed on the bare adapter
    // key, two INDEPENDENT events sharing an external id collapse: the second
    // is reported as a replay, which is a money event behind a success.
    const { gate: g, store } = gate();
    const ts = String(NOW_S);
    const body = bodyWith(EVENT_ID);
    const req = request({ rawBody: body, timestampHeader: ts, signatureHeader: signTsBody(ts, body) });

    const underCheckout = await g.verify(req, SECRET, { ...adapter(), kind: 'payment.merchant_checkout' });
    const underInbound = await g.verify(req, SECRET, { ...adapter(), kind: 'webhook.inbound' });

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
    const again = await g.verify(req, SECRET, { ...adapter(), kind: 'webhook.inbound' });
    expect(again.accepted).toBe(true);
    if (again.accepted) expect(again.replay).toBe(true);
    expect((store as DurableLikeStore).size()).toBe(2);
  });
});

describe('an extractor that returns null is a refusal, not a crash', () => {
  it('refuses instead of throwing out of verify', async () => {
    const { gate: g } = gate();
    // `null` is what `RegExp.exec` returns, and what a compiled caller writes
    // for "no identity". Read as an object it threw out of `verify`.
    const v = await g.verify(request(), SECRET, adapter({ extract: () => null as never }));
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('identity_absent');

    const partial = await g.verify(request(), SECRET, adapter({ extract: () => ({ accountRef: ACCOUNT, externalEventId: null as never }) }));
    expect(partial.accepted).toBe(false);
    if (!partial.accepted) expect(partial.rejection).toBe('identity_absent');
  });
});

describe('a re-delivery is processed once, and the key is byte-identical across attempts', () => {
  it('accepts the first delivery and marks the second a replay', async () => {
    const { gate: g, store } = gate();
    const first = await g.verify(request(), SECRET, adapter());
    const second = await g.verify(request(), SECRET, adapter());

    expect(first).toEqual({ accepted: true, replay: false, key: keyFor() });
    expect(second).toEqual({ accepted: true, replay: true, key: keyFor() });
    expect((store as DurableLikeStore).size()).toBe(1);
  });

  it('derives the key from identity alone, so a retry cannot mint a new one', () => {
    const a = keyFor();
    expect(Buffer.from(a, 'utf8').equals(Buffer.from(keyFor(), 'utf8'))).toBe(true);
    expect(keyFor(EVENT_ID, 'b2')).not.toBe(a);
    expect(replayKeyOf({ businessId: 'b1', eventSource: 'other', externalEventId: EVENT_ID })).not.toBe(a);
    expect(keyFor('evt_9')).not.toBe(a);
  });

  it('cannot be confused by a separator planted inside a field', () => {
    const left = replayKeyOf({ businessId: 'b1', eventSource: 'a', externalEventId: 'b_c' });
    const right = replayKeyOf({ businessId: 'b1', eventSource: 'a_b', externalEventId: 'c' });
    expect(left).not.toBe(right);
  });

  it('does not record anything when the signature fails', async () => {
    const { gate: g, store } = gate();
    const v = await g.verify(request({ signatureHeader: signTsBody(String(NOW_S), Buffer.from('x')) }), SECRET, adapter());
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
    const v = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signTsBody(ts, raw) }), SECRET, adapter());
    expect(v.accepted).toBe(true);
    expect(Object.keys(v).sort()).toEqual(['accepted', 'key', 'replay']);
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
