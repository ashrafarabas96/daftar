/**
 * INTEG S-9 (the part that needs no secret store and no queue) — THE INBOUND
 * WEBHOOK GATE: signature, timestamp window, replay.
 *
 * Measured starting point: the repository has NO webhook surface at all. A
 * case-insensitive search for "webhook" across every `*.ts` and `*.sql` file
 * returns zero hits (exit 1), while the same search for `accounting_post_entry`
 * returns 15 — so the zero is a measurement, not a broken search. This file is
 * therefore the first line of that boundary, and it is the only boundary an
 * outside party starts.
 *
 * The design's W-1..W-7 (§7.2) are the specification. What is HERE is what is
 * pure: the three mandatory checks in a fixed order over the bytes as they
 * arrived. What is NOT here, and is named rather than faked:
 *
 *   - the secret itself. The gate takes an already-unsealed key as an argument
 *     and never reads one. The envelope store is slice S-4.
 *   - the replay TABLE. The gate talks to a `ReplayStore` port; the in-memory
 *     double below is the test's, and the migration is a separate, numbered,
 *     money-coupled slice that is not written in this PR.
 *   - the queue insert and the worker (W-5). The gate returns a verdict and a
 *     key; it executes nothing.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryReplayStore, WebhookGate, replayKeyOf, type RawWebhookRequest } from '../apps/api/src/modules/integrations';

const SECRET = Buffer.from('f3a1b2c3d4e5f60718293a4b5c6d7e8f', 'hex');
const WINDOW = 300;
const NOW_MS = 1_780_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

/** The provider's own signing rule: HMAC-SHA256 over `timestamp . rawBody`. */
function sign(timestamp: string, rawBody: Buffer, secret: Buffer = SECRET): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from('.', 'utf8'), rawBody]))
    .digest('hex');
}

function request(over: Partial<RawWebhookRequest> = {}): RawWebhookRequest {
  const rawBody = Buffer.from('{"id":"evt_1","amount":1200,"note":"caf\\u00e9"}', 'utf8');
  const timestamp = String(NOW_S);
  return {
    businessId: 'b1',
    eventSource: 'whatsapp_cloud',
    externalEventId: 'evt_1',
    rawBody,
    timestampHeader: timestamp,
    signatureHeader: sign(timestamp, rawBody),
    ...over,
  };
}

function gate(opts: { store?: InMemoryReplayStore; hmac?: (k: Buffer, m: Buffer) => Buffer } = {}) {
  const store = opts.store ?? new InMemoryReplayStore();
  return {
    store,
    gate: new WebhookGate({ timestampWindowSeconds: WINDOW }, store, () => NOW_MS, opts.hmac),
  };
}

describe('W-2: the timestamp window is a configured value with no generous default', () => {
  it('refuses to be constructed without one, and refuses a nonsense one', () => {
    const store = new InMemoryReplayStore();
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WebhookGate({ timestampWindowSeconds: bad as never }, store, () => NOW_MS)).toThrow(/timestampWindowSeconds/);
    }
    // positive control: a real window constructs.
    expect(new WebhookGate({ timestampWindowSeconds: WINDOW }, store, () => NOW_MS)).toBeDefined();
  });

  it('rejects a timestamp outside the window on BOTH sides, and accepts inside it', async () => {
    const { gate: g } = gate();
    const old = String(NOW_S - WINDOW - 1);
    const future = String(NOW_S + WINDOW + 1);
    const edge = String(NOW_S - WINDOW);
    const body = request().rawBody;

    for (const ts of [old, future]) {
      const v = await g.verify(request({ timestampHeader: ts, signatureHeader: sign(ts, body) }), SECRET, 'hmac_sha256_ts_body');
      expect(v.accepted, ts).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_outside_window');
    }
    const inside = await g.verify(
      request({ timestampHeader: edge, signatureHeader: sign(edge, body), externalEventId: 'evt_edge' }),
      SECRET,
      'hmac_sha256_ts_body',
    );
    expect(inside.accepted).toBe(true);
  });

  it('rejects a malformed timestamp rather than coercing it', async () => {
    const { gate: g } = gate();
    for (const ts of ['', 'now', '17800000000000000000000', '1.5e9', ' 1780000000']) {
      const v = await g.verify(request({ timestampHeader: ts, signatureHeader: sign(ts, request().rawBody) }), SECRET, 'hmac_sha256_ts_body');
      expect(v.accepted, ts).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('timestamp_malformed');
    }
  });

  it('refuses a scheme that does not bind the timestamp, because then W-2 cannot hold', async () => {
    const { gate: g } = gate();
    for (const scheme of ['hmac_sha256_body', 'none'] as const) {
      const v = await g.verify(request(), SECRET, scheme);
      expect(v.accepted, scheme).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('scheme_not_timestamp_bound');
    }
  });
});

describe('W-1: the HMAC is over the bytes as they arrived, and the comparison is constant time', () => {
  it('accepts the raw bytes and REJECTS the same JSON re-serialized', async () => {
    const { gate: g } = gate();
    const raw = request().rawBody;
    const ts = String(NOW_S);
    const signature = sign(ts, raw);

    const ok = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body');
    expect(ok.accepted).toBe(true);

    // The round trip changes the bytes (the é escape becomes one UTF-8
    // character) without changing the parsed value — which is exactly the
    // substitution W-1 exists to refuse.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
    expect(reserialized.equals(raw)).toBe(false);
    const v = await g.verify(
      request({ rawBody: reserialized, timestampHeader: ts, signatureHeader: signature, externalEventId: 'evt_2' }),
      SECRET,
      'hmac_sha256_ts_body',
    );
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
  });

  it('rejects a one-bit corruption, a wrong secret, and a tampered timestamp', async () => {
    const { gate: g } = gate();
    const raw = request().rawBody;
    const ts = String(NOW_S);
    const good = sign(ts, raw);
    const flipped = (Number.parseInt(good.slice(0, 1), 16) ^ 0x1).toString(16) + good.slice(1);

    const cases: Array<[string, string, string]> = [
      ['evt_a', flipped, ts],
      ['evt_b', sign(ts, raw, randomBytes(16)), ts],
      ['evt_c', good, String(NOW_S - 1)],
    ];
    for (const [id, signature, timestamp] of cases) {
      const v = await g.verify(
        request({ rawBody: raw, externalEventId: id, signatureHeader: signature, timestampHeader: timestamp }),
        SECRET,
        'hmac_sha256_ts_body',
      );
      expect(v.accepted, id).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('signature_mismatch');
    }
  });

  it('rejects a signature of the wrong shape WITHOUT throwing (timingSafeEqual dies on a length mismatch)', async () => {
    const { gate: g } = gate();
    for (const signature of ['', 'deadbeef', 'zz'.repeat(32), `${sign(String(NOW_S), request().rawBody)}00`]) {
      const v = await g.verify(request({ signatureHeader: signature }), SECRET, 'hmac_sha256_ts_body');
      expect(v.accepted, JSON.stringify(signature)).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('signature_malformed');
    }
  });
});

describe('W-4: no secret means no authority, and no HMAC is computed at all', () => {
  it('returns unconfigured and never reaches the hasher', async () => {
    let calls = 0;
    const counting = (k: Buffer, m: Buffer): Buffer => {
      calls += 1;
      return createHmac('sha256', k).update(m).digest();
    };
    const { gate: g } = gate({ hmac: counting });

    for (const secret of [undefined, Buffer.alloc(0)]) {
      const v = await g.verify(request(), secret, 'hmac_sha256_ts_body');
      expect(v.accepted).toBe(false);
      if (!v.accepted) expect(v.rejection).toBe('unconfigured');
    }
    expect(calls).toBe(0);
    // positive control: the counter does count when a secret is present.
    expect((await g.verify(request(), SECRET, 'hmac_sha256_ts_body')).accepted).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('W-3: a re-delivery is processed once, and the key is byte-identical across attempts', () => {
  it('accepts the first delivery and marks the second a replay', async () => {
    const { gate: g, store } = gate();
    const first = await g.verify(request(), SECRET, 'hmac_sha256_ts_body');
    const second = await g.verify(request(), SECRET, 'hmac_sha256_ts_body');

    expect(first).toEqual({ accepted: true, replay: false, key: replayKeyOf(request()) });
    expect(second).toEqual({ accepted: true, replay: true, key: replayKeyOf(request()) });
    expect(store.size()).toBe(1);
  });

  it('derives the key from identity alone, so a retry cannot mint a new one', () => {
    const a = replayKeyOf(request({ timestampHeader: '1', signatureHeader: 'aa' }));
    const b = replayKeyOf(request({ timestampHeader: '2', signatureHeader: 'bb' }));
    expect(Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'))).toBe(true);
    // and it separates the three dimensions it is made of.
    expect(replayKeyOf(request({ businessId: 'b2' }))).not.toBe(a);
    expect(replayKeyOf(request({ eventSource: 'other' }))).not.toBe(a);
    expect(replayKeyOf(request({ externalEventId: 'evt_9' }))).not.toBe(a);
  });

  it('cannot be confused by a separator planted inside a field', () => {
    const left = replayKeyOf(request({ eventSource: 'a', externalEventId: 'b_c' }));
    const right = replayKeyOf(request({ eventSource: 'a_b', externalEventId: 'c' }));
    expect(left).not.toBe(right);
  });

  it('does not record anything when the signature fails', async () => {
    const { gate: g, store } = gate();
    const v = await g.verify(request({ signatureHeader: sign(String(NOW_S), Buffer.from('x')) }), SECRET, 'hmac_sha256_ts_body');
    expect(v.accepted).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe('W-5 and W-7: the verdict acknowledges and carries no payload', () => {
  it('returns only the three fields, and the raw bytes are not among them', async () => {
    const marker = 'MARKER_7f3c2a';
    const raw = Buffer.from(`{"secretish":"${marker}"}`, 'utf8');
    const ts = String(NOW_S);
    const { gate: g } = gate();
    const v = await g.verify(request({ rawBody: raw, timestampHeader: ts, signatureHeader: sign(ts, raw) }), SECRET, 'hmac_sha256_ts_body');
    expect(v.accepted).toBe(true);
    expect(Object.keys(v).sort()).toEqual(['accepted', 'key', 'replay']);
    expect(JSON.stringify(v)).not.toContain(marker);
    // positive control: the marker IS in the bytes, so the absence above is
    // about the verdict and not about a marker that was never there.
    expect(raw.toString('utf8')).toContain(marker);
  });
});
