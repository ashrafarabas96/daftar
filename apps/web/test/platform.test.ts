import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError, apiFetch, ensureSession, getAccessToken, setAccessToken } from '@/lib/client';
import { DELETE, GET, PATCH, POST, PUT } from '@/app/api/proxy/[...path]/route';
import { isUuid } from '@/lib/route-ids';

/**
 * The four web platform fixes of P3-S7 (contract A-12(1)(2), Annex R web
 * notes a–d), proved on the real modules with a stubbed network.
 */

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(responses: (() => Response)[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${String(input)}`);
    return Promise.resolve(next());
  });
  return calls;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const header = (call: Call | undefined, name: string): string | null => new Headers(call?.init.headers).get(name);

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('BFF proxy (A-12(1))', () => {
  const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

  it('exports PUT beside GET, POST, PATCH and DELETE', () => {
    for (const handler of [GET, POST, PUT, PATCH, DELETE]) expect(typeof handler).toBe('function');
  });

  it('forwards a PUT with its body, accept-language and idempotency key, and answers no-store whatever the upstream sent', async () => {
    const calls = stubFetch([() => json(200, { ok: true }, { 'cache-control': 'public, max-age=600' })]);
    const req = new NextRequest('http://web.test/api/proxy/purchases/p-1?x=1', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer t',
        'content-type': 'application/json',
        'x-business-id': 'b-1',
        'idempotency-key': 'k-1',
        'accept-language': 'tr',
        cookie: 'daftar_refresh=secret',
      },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    const res = await PUT(req, ctx(['purchases', 'p-1']));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/v1\/purchases\/p-1\?x=1$/);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(Buffer.from(calls[0]?.init.body as Buffer).toString('utf8')).toBe('{"expectedRevision":0}');
    expect(header(calls[0], 'accept-language')).toBe('tr');
    expect(header(calls[0], 'idempotency-key')).toBe('k-1');
    expect(header(calls[0], 'x-business-id')).toBe('b-1');
    // The refresh cookie never leaves the BFF.
    expect(header(calls[0], 'cookie')).toBeNull();
  });

  it('answers cache-control: no-store when the upstream sent none', async () => {
    stubFetch([() => new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } })]);
    const res = await GET(new NextRequest('http://web.test/api/proxy/inventory/stock'), ctx(['inventory', 'stock']));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"items":[]}');
  });

  // Security review L-1: Next decodes each catch-all segment, so `%2F`, `%3F`, `%23`, `%5C` and `..` must not steer the call.
  it.each([
    ['an encoded slash with ..', ['purchases', '../suppliers/x', 'return-options']],
    ['a path that climbs out of /v1 and swallows the suffix into a query', ['purchases', '../../admin/businesses?z=', 'return-options']],
    ['an encoded question mark', ['purchases', 'x?status=draft', 'cancel']],
    ['an encoded fragment', ['purchases', 'x#frag', 'y']],
    ['an encoded backslash', ['purchases', '..\\admin', 'y']],
    ['a lone ..', ['purchases', '..', 'admin']],
    ['a lone .', ['purchases', '.', 'receive']],
    ['an empty segment', ['purchases', '', 'receive']],
    ['a control character', ['purchases', 'x\u0000', 'receive']],
  ])('refuses %s with 400 and sends nothing upstream', async (_name, path) => {
    const calls = stubFetch([]);
    const res = await POST(new NextRequest('http://web.test/api/proxy/x', { method: 'POST', body: '{}' }), ctx(path));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls).toHaveLength(0);
  });

  it('re-encodes an ordinary segment, so it stays one segment under /v1', async () => {
    const calls = stubFetch([() => json(200, {})]);
    const res = await GET(new NextRequest('http://web.test/api/proxy/purchases/a%20b?x=1'), ctx(['purchases', 'a b', 'payable']));
    expect(res.status).toBe(200);
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/v1/purchases/a%20b/payable');
    expect(new URL(calls[0]?.url ?? '').search).toBe('?x=1');
  });
});

describe('ids from the page URL (L-1)', () => {
  it('accepts a UUID and nothing else', () => {
    expect(isUuid('0b9e1c52-3f7a-4c1e-9d2b-6a8f0e4d2c11')).toBe(true);
    for (const bad of [
      '',
      'x',
      '../suppliers/x',
      '0b9e1c52-3f7a-4c1e-9d2b-6a8f0e4d2c11/cancel',
      '0b9e1c52-3f7a-4c1e-9d2b-6a8f0e4d2c11?z=',
      ' 0b9e1c52-3f7a-4c1e-9d2b-6a8f0e4d2c11',
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('apiFetch (A-12(2))', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { cookie: 'daftar_csrf=c', documentElement: { lang: 'ar' } });
    vi.stubGlobal('crypto', { randomUUID: () => `minted-${Math.random().toString(16).slice(2)}` });
    // The page already holds a token (one that may have expired): the first
    // request goes out at once, and a 401 is what triggers the refresh.
    setAccessToken('stale');
  });

  it('keeps a caller-owned idempotency key, and the 401 retry re-sends it', async () => {
    const calls = stubFetch([() => json(401, {}), () => json(200, { accessToken: 'fresh' }), () => json(201, { rateId: 'r', created: true })]);
    await apiFetch('/api/proxy/x', { method: 'POST', body: '{}', headers: { 'idempotency-key': 'form-key' } });
    const sent = calls.filter((c) => c.url === '/api/proxy/x');
    expect(sent).toHaveLength(2);
    expect(sent.map((c) => header(c, 'idempotency-key'))).toEqual(['form-key', 'form-key']);
    expect(header(sent[1], 'authorization')).toBe('Bearer fresh');
  });

  it('mints ONE key when the caller set none, and the 401 retry re-sends that same key', async () => {
    const calls = stubFetch([() => json(401, {}), () => json(200, { accessToken: 'fresh' }), () => json(200, { ok: true })]);
    await apiFetch('/api/proxy/y', { method: 'POST', body: '{}' });
    const keys = calls.filter((c) => c.url === '/api/proxy/y').map((c) => header(c, 'idempotency-key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^minted-/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('sends no idempotency key on a GET, and sends the page language', async () => {
    const calls = stubFetch([() => json(200, { items: [] })]);
    await apiFetch('/api/proxy/z');
    expect(header(calls[0], 'idempotency-key')).toBeNull();
    expect(header(calls[0], 'accept-language')).toBe('ar');
  });

  it('keeps the error details, and domainCode reads the domain fields in contract order', async () => {
    const refuse = (body: unknown, status = 409) => {
      stubFetch([() => json(status, body)]);
      return apiFetch('/api/proxy/r', { method: 'POST', body: '{}' }).then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: unknown) => {
          if (!(e instanceof ApiError)) throw e;
          return e;
        },
      );
    };
    const inv = await refuse({
      error: { code: 'CONFLICT', message: 'm', requestId: 'q', details: { inventoryCode: 'inventory.insufficient_stock', lines: [1] } },
    });
    expect(inv.details).toEqual({ inventoryCode: 'inventory.insufficient_stock', lines: [1] });
    expect(inv.domainCode).toBe('inventory.insufficient_stock');
    const pur = await refuse({ error: { code: 'CONFLICT', message: 'm', requestId: 'q', details: { purchasingCode: 'supplier_payment.settlement_changed' } } });
    expect(pur.domainCode).toBe('supplier_payment.settlement_changed');
    const pm = await refuse({ error: { code: 'CONFLICT', message: 'm', requestId: 'q', details: { paymentMethodCode: 'payment_method.inactive' } } });
    expect(pm.domainCode).toBe('payment_method.inactive');
    const cat = await refuse({ error: { code: 'CONFLICT', message: 'm', requestId: 'q', details: { catalogCode: 'catalog.sku_taken' } } });
    expect(cat.domainCode).toBe('catalog.sku_taken');
    const acc = await refuse({ error: { code: 'ACCOUNTING_REFUSED', message: 'm', requestId: 'q', details: { code: 'accounting.fx_rate_missing' } } }, 422);
    expect(acc.domainCode).toBe('accounting.fx_rate_missing');
    // `details.code` counts ONLY under ACCOUNTING_REFUSED; there is no accountingCode on the wire.
    const other = await refuse(
      { error: { code: 'VALIDATION_FAILED', message: 'm', requestId: 'q', details: { code: 'too_small', accountingCode: 'x' } } },
      400,
    );
    expect(other.domainCode).toBeNull();
    expect(other.code).toBe('VALIDATION_FAILED');
    const bare = await refuse({ error: { code: 'NOT_FOUND', message: 'm', requestId: 'q' } }, 404);
    expect(bare.details).toBeUndefined();
    expect(bare.domainCode).toBeNull();
  });
});

describe('one refresh per page (real-browser findings D-2, D-7)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { cookie: 'daftar_csrf=c', documentElement: { lang: 'en' } });
  });

  it('a call made before the page holds a token waits for ONE refresh, and every concurrent call shares it — no bare 401 first', async () => {
    const calls = stubFetch([() => json(200, { accessToken: 'fresh' }), () => json(200, { items: [] }), () => json(200, { permissions: [] })]);
    await Promise.all([apiFetch('/api/proxy/me/businesses'), apiFetch('/api/proxy/inventory/access')]);
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/refresh', '/api/proxy/me/businesses', '/api/proxy/inventory/access']);
    expect(header(calls[0], 'x-daftar-csrf')).toBe('c');
    expect(calls[0]?.init.keepalive).toBe(true);
    for (const call of calls.slice(1)) expect(header(call, 'authorization')).toBe('Bearer fresh');
  });

  it('the page mount, the header and a call share one refresh; a page that holds a token refreshes nothing', async () => {
    const calls = stubFetch([() => json(200, { accessToken: 'fresh' }), () => json(200, { items: [] })]);
    const [mounted] = await Promise.all([ensureSession(), apiFetch('/api/proxy/me/businesses'), ensureSession()]);
    expect(mounted).toBe(true);
    expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(1);
    // A client-side navigation keeps the token in memory: the next page's mount spends no refresh token.
    expect(await ensureSession()).toBe(true);
    expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(1);
    expect(getAccessToken()).toBe('fresh');
  });

  it('without a session the call still goes, bare, and its 401 is not refreshed a second time', async () => {
    const calls = stubFetch([() => json(401, { error: 'NO_SESSION' }), () => json(401, { error: { code: 'UNAUTHORIZED' } })]);
    const error = await apiFetch('/api/proxy/me/businesses').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/refresh', '/api/proxy/me/businesses']);
    expect(header(calls[1], 'authorization')).toBeNull();
  });
});
