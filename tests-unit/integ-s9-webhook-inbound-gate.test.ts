/**
 * INTEG S-9 (the part that needs no secret store and no queue) — THE INBOUND
 * WEBHOOK GATE: signature, timestamp window, replay.
 *
 * Measured starting point: the repository has no webhook surface at all.
 *   grep -ril "webhook" --include="*.ts" --include="*.sql" .   =>  exit 1, 0 files
 *   grep -ril "accounting_post_entry" --include="*.sql" .      =>  exit 0, 15 files
 * The second command is the positive control: the zero above is a measurement
 * and not a broken search. (Both count FILES, not lines — `-l`.)
 *
 * What is HERE is what is pure: the mandatory checks in a fixed order over the
 * bytes as they arrived. What is NOT here, and is named rather than faked: the
 * secret (handed in, already unsealed), the replay TABLE (a port and an
 * in-memory double), the queue insert and the worker, and the rate limit.
 *
 * Two defects the finance review found in the first version are what most of
 * this file now exists to hold shut:
 *   1. the external event id arrived BESIDE the signed bytes, so one validly
 *      signed delivery could be replayed with a mutated id and accepted as a
 *      new event — which is a duplicate posting the ledger cannot see;
 *   2. an absent or blank id had no refusal channel at all, and collapsed
 *      every event of a business onto one key, so money events disappeared
 *      behind a reported success.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryReplayStore,
  MAX_EXTERNAL_EVENT_ID_LENGTH,
  WebhookGate,
  replayKeyOf,
  type RawWebhookRequest,
  type ReplayStore,
} from '../apps/api/src/modules/integrations';

const SECRET = Buffer.from('f3a1b2c3d4e5f60718293a4b5c6d7e8f', 'hex');
const WINDOW = 300;
const NOW_MS = 1_780_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const EVENT_ID = 'wamid.HBgMOTk5';

/** A durable store stands in for the table: not a test double. */
class DurableLikeStore implements ReplayStore {
  readonly isTestDouble = false;
  private readonly seen = new Set<string>();
  async remember(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

function bodyWith(id: string, extra = ''): Buffer {
  return Buffer.from(`{"id":"${id}","amount":1200,"note":"caf\\u00e9"${extra}}`, 'utf8');
}

/** The identity the gate reads back OUT of the verified bytes. */
function extractId(verified: Buffer): string | undefined {
  const m = /"id":"([^"]*)"/.exec(verified.toString('utf8'));
  return m === null ? undefined : m[1];
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
    eventSource: 'whatsapp_cloud',
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
  } = {},
) {
  const store = opts.store ?? new InMemoryReplayStore();
  return {
    store,
    gate: new WebhookGate(
      {
        timestampWindowSeconds: WINDOW,
        acceptTimestampUnboundScheme: opts.acceptTimestampUnboundScheme ?? false,
      },
      store,
      () => NOW_MS,
      opts.hmac,
    ),
  };
}

const keyFor = (id: string = EVENT_ID): string => replayKeyOf({ businessId: 'b1', eventSource: 'whatsapp_cloud', externalEventId: id });

describe('the gate refuses to exist without the two parameters nobody should default', () => {
  it('rejects a nonsense window and an unstated scheme policy', () => {
    const store = new InMemoryReplayStore();
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WebhookGate({ timestampWindowSeconds: bad as never, acceptTimestampUnboundScheme: false }, store, () => NOW_MS)).toThrow(
        /timestampWindowSeconds/,
      );
    }
    expect(() => new WebhookGate({ timestampWindowSeconds: WINDOW, acceptTimestampUnboundScheme: undefined as never }, store, () => NOW_MS)).toThrow(
      /acceptTimestampUnboundScheme/,
    );
    // positive control: both stated, and it constructs.
    expect(new WebhookGate({ timestampWindowSeconds: WINDOW, acceptTimestampUnboundScheme: false }, store, () => NOW_MS)).toBeDefined();
  });
});

describe('the signature is checked FIRST, so the endpoint is not a clock oracle', () => {
  it('reports signature_mismatch — not a timestamp verdict — for a bad signature with a bad timestamp', async () => {
    const { gate: g } = gate();
    const old = String(NOW_S - WINDOW - 1);
    const v = await g.verify(request({ timestampHeader: old, signatureHeader: signBody(bodyWith(EVENT_ID)) }), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(v.accepted).toBe(false);
    // the window verdict would have told an unauthenticated caller the
    // server's clock and the configured tolerance.
    if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
  });

  it('still reports the window once the signature is valid, on BOTH sides and on the exact bound', async () => {
    const { gate: g } = gate();
    for (const delta of [-(WINDOW + 1), WINDOW + 1]) {
      const ts = String(NOW_S + delta);
      const body = bodyWith(EVENT_ID);
      const v = await g.verify(
        request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }),
        SECRET,
        'hmac_sha256_ts_body',
        extractId,
      );
      expect(v.accepted, String(delta)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_outside_window');
    }
    // both exact bounds are INSIDE the window, and both are asserted.
    for (const [delta, id] of [
      [-WINDOW, 'evt_low'],
      [WINDOW, 'evt_high'],
    ] as const) {
      const ts = String(NOW_S + delta);
      const body = bodyWith(id);
      const v = await g.verify(
        request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }),
        SECRET,
        'hmac_sha256_ts_body',
        extractId,
      );
      expect(v.accepted, String(delta)).toBe(true);
    }
  });

  it('rejects a malformed timestamp the provider itself signed, rather than coercing it', async () => {
    const { gate: g } = gate();
    for (const ts of ['', 'now', '17800000000000000000000', '1.5e9', ' 1780000000']) {
      const body = bodyWith(EVENT_ID);
      const v = await g.verify(
        request({ timestampHeader: ts, rawBody: body, signatureHeader: signTsBody(ts, body) }),
        SECRET,
        'hmac_sha256_ts_body',
        extractId,
      );
      expect(v.accepted, JSON.stringify(ts)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_malformed');
    }
  });
});

describe("a scheme that does not bind the timestamp is the owner's call, not a default", () => {
  it('refuses it when the deployment has not said otherwise, and refuses an unsigned scheme always', async () => {
    const { gate: g } = gate({ acceptTimestampUnboundScheme: false });
    const v = await g.verify(request(), SECRET, 'hmac_sha256_body', extractId);
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('scheme_not_timestamp_bound');

    const unsigned = await g.verify(request(), SECRET, 'none', extractId);
    expect(unsigned.accepted).toBe(false);
    if (!unsigned.accepted) expect(unsigned.rejection).toBe('scheme_unsigned');
    // and `none` stays refused even where the body-only scheme is admitted.
    const permissive = gate({ acceptTimestampUnboundScheme: true, store: new DurableLikeStore() });
    const stillUnsigned = await permissive.gate.verify(request(), SECRET, 'none', extractId);
    expect(stillUnsigned.accepted).toBe(false);
  });

  it('admits it only against a durable store, because then the store is the only defence left', async () => {
    const body = bodyWith(EVENT_ID);
    const req = request({ rawBody: body, signatureHeader: signBody(body) });

    const withDouble = gate({ acceptTimestampUnboundScheme: true, store: new InMemoryReplayStore() });
    const refused = await withDouble.gate.verify(req, SECRET, 'hmac_sha256_body', extractId);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) expect(refused.rejection).toBe('unconfigured');

    const durable = gate({ acceptTimestampUnboundScheme: true, store: new DurableLikeStore() });
    const accepted = await durable.gate.verify(req, SECRET, 'hmac_sha256_body', extractId);
    expect(accepted).toEqual({ accepted: true, replay: false, key: keyFor() });
    // and the timestamp is not consulted for this scheme: a wildly stale
    // header on a valid body-only signature still passes, which is exactly the
    // constraint the capability flag documents.
    const stale = await durable.gate.verify(
      { ...req, timestampHeader: '1', rawBody: bodyWith('evt_stale'), signatureHeader: signBody(bodyWith('evt_stale')) },
      SECRET,
      'hmac_sha256_body',
      extractId,
    );
    expect(stale.accepted).toBe(true);
  });
});

describe('the HMAC is over the bytes as they arrived', () => {
  it('accepts the raw bytes and REJECTS the same JSON re-serialized', async () => {
    const { gate: g } = gate();
    const raw = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const signature = signTsBody(ts, raw);

    const ok = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(ok.accepted).toBe(true);

    // The round trip changes the bytes (the é escape becomes one UTF-8
    // character) without changing the parsed value — exactly the substitution
    // this check exists to refuse.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
    expect(reserialized.equals(raw)).toBe(false);
    const v = await g.verify(request({ rawBody: reserialized, timestampHeader: ts, signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body', extractId);
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
      const v = await g.verify(request({ rawBody: raw, signatureHeader: signature, timestampHeader: timestamp }), SECRET, 'hmac_sha256_ts_body', extractId);
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
    }
  });

  it('rejects a signature of the wrong shape WITHOUT throwing (timingSafeEqual dies on a length mismatch)', async () => {
    const { gate: g } = gate();
    const good = signTsBody(String(NOW_S), bodyWith(EVENT_ID));
    for (const signature of ['', 'deadbeef', 'zz'.repeat(32), `${good}00`]) {
      const v = await g.verify(request({ signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body', extractId);
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
      ['no event source', { eventSource: '' }],
    ];
    for (const [name, over] of malformed) {
      // built from a VALID request and then spoiled, so the helper does not
      // trip over the broken field while signing it.
      const v = await g.verify({ ...request(), ...over }, SECRET, 'hmac_sha256_ts_body', extractId);
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
      const v = await g.verify(request(), secret, 'hmac_sha256_ts_body', extractId);
      expect(v.accepted).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('unconfigured');
    }
    expect(calls).toBe(0);
    // positive control: the counter does count when a secret is present.
    expect((await g.verify(request(), SECRET, 'hmac_sha256_ts_body', extractId)).accepted).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('the identity comes out of the SIGNED bytes — the first finance defect', () => {
  it('cannot be mutated without breaking the signature', async () => {
    const { gate: g } = gate();
    const raw = bodyWith(EVENT_ID);
    const ts = String(NOW_S);
    const signature = signTsBody(ts, raw);

    // One genuine delivery, captured, with its id changed and the signature
    // left alone: this is the whole attack, and it must not be accepted.
    const mutated = Buffer.from(raw.toString('utf8').replace(EVENT_ID, 'wamid.FORGED00'), 'utf8');
    expect(mutated.equals(raw)).toBe(false);
    const forged = await g.verify(request({ rawBody: mutated, timestampHeader: ts, signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(forged.accepted).toBe(false);
    if (!forged.accepted) expect(forged.rejection).toBe('signature_mismatch');

    // positive control: the untouched delivery IS accepted, and keys to the id
    // that was inside the signed bytes.
    const honest = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(honest).toEqual({ accepted: true, replay: false, key: keyFor(EVENT_ID) });
  });

  it('ignores any id offered beside the body, because there is nowhere to offer one', () => {
    // The type carries no identity field at all: the only way in is the
    // extractor, which only ever sees verified bytes.
    expect(Object.keys(request()).sort()).toEqual(['businessId', 'eventSource', 'rawBody', 'signatureHeader', 'timestampHeader'].sort());
  });
});

describe('an absent or unusable identity is refused by name — the second finance defect', () => {
  it('refuses rather than collapsing every event onto one key', async () => {
    const { gate: g, store } = gate({ store: new InMemoryReplayStore() });
    const absent: Array<[string, (b: Buffer) => string | undefined]> = [
      ['extractor finds nothing', () => undefined],
      ['empty id', () => ''],
    ];
    for (const [name, extractor] of absent) {
      const v = await g.verify(request(), SECRET, 'hmac_sha256_ts_body', extractor);
      expect(v.accepted, name).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('identity_absent');
    }
    // and nothing was claimed, so the real delivery that follows is not
    // reported as a replay — which is how a money event used to disappear.
    expect((store as InMemoryReplayStore).size()).toBe(0);
    const real = await g.verify(request(), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(real).toEqual({ accepted: true, replay: false, key: keyFor() });
  });

  it('refuses an id carrying a newline, a space, a control byte, or more than the cap', async () => {
    const { gate: g } = gate();
    const bad = ['evt\nFAKE_LOG_LINE', 'evt one', 'evt\u0000one', 'e'.repeat(MAX_EXTERNAL_EVENT_ID_LENGTH + 1)];
    for (const id of bad) {
      const v = await g.verify(request(), SECRET, 'hmac_sha256_ts_body', () => id);
      expect(v.accepted, JSON.stringify(id)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('identity_malformed');
    }
    // positive control: the cap itself is allowed, so the refusal above is the
    // length and not the repetition.
    const atCap = await g.verify(request(), SECRET, 'hmac_sha256_ts_body', () => 'e'.repeat(MAX_EXTERNAL_EVENT_ID_LENGTH));
    expect(atCap.accepted).toBe(true);
  });
});

describe('a re-delivery is processed once, and the key is byte-identical across attempts', () => {
  it('accepts the first delivery and marks the second a replay', async () => {
    const { gate: g, store } = gate();
    const first = await g.verify(request(), SECRET, 'hmac_sha256_ts_body', extractId);
    const second = await g.verify(request(), SECRET, 'hmac_sha256_ts_body', extractId);

    expect(first).toEqual({ accepted: true, replay: false, key: keyFor() });
    expect(second).toEqual({ accepted: true, replay: true, key: keyFor() });
    expect((store as InMemoryReplayStore).size()).toBe(1);
  });

  it('derives the key from identity alone, so a retry cannot mint a new one', () => {
    const a = keyFor();
    const b = replayKeyOf({ businessId: 'b1', eventSource: 'whatsapp_cloud', externalEventId: EVENT_ID });
    expect(Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'))).toBe(true);
    expect(replayKeyOf({ businessId: 'b2', eventSource: 'whatsapp_cloud', externalEventId: EVENT_ID })).not.toBe(a);
    expect(replayKeyOf({ businessId: 'b1', eventSource: 'other', externalEventId: EVENT_ID })).not.toBe(a);
    expect(replayKeyOf({ businessId: 'b1', eventSource: 'whatsapp_cloud', externalEventId: 'evt_9' })).not.toBe(a);
  });

  it('cannot be confused by a separator planted inside a field', () => {
    const left = replayKeyOf({ businessId: 'b1', eventSource: 'a', externalEventId: 'b_c' });
    const right = replayKeyOf({ businessId: 'b1', eventSource: 'a_b', externalEventId: 'c' });
    expect(left).not.toBe(right);
  });

  it('does not record anything when the signature fails', async () => {
    const { gate: g, store } = gate();
    const v = await g.verify(request({ signatureHeader: signTsBody(String(NOW_S), Buffer.from('x')) }), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(v.accepted).toBe(false);
    expect((store as InMemoryReplayStore).size()).toBe(0);
  });
});

describe('the verdict acknowledges, and carries no payload beyond the identity', () => {
  it('returns three fields, and no body content reaches them', async () => {
    const marker = 'MARKER_7f3c2a';
    const raw = bodyWith(EVENT_ID, `,"secretish":"${marker}"`);
    const ts = String(NOW_S);
    const { gate: g } = gate();
    const v = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signTsBody(ts, raw) }), SECRET, 'hmac_sha256_ts_body', extractId);
    expect(v.accepted).toBe(true);
    expect(Object.keys(v).sort()).toEqual(['accepted', 'key', 'replay']);
    expect(JSON.stringify(v)).not.toContain(marker);
    // positive control: the marker IS in the bytes, so the absence above is
    // about the verdict and not about a marker that was never there.
    expect(raw.toString('utf8')).toContain(marker);
    // the key does carry the event id, by design — and the charset rule above
    // is what keeps that from being a log-forging field.
    if (v.accepted) expect(v.key).toContain(EVENT_ID);
    if (v.accepted) expect(/^[\x20-\x7e]+$/.test(v.key)).toBe(true);
  });
});
