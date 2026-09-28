import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as refresh } from '@/app/api/auth/refresh/route';

/**
 * TD-19: the refresh route keeps the session through anything retryable.
 *
 * The upstream is stubbed so each answer the API (or the network) can give is
 * exercised on the real route handler; `tests/integration/p3c-bff-client-ip`
 * proves the same against the real API. Only `cookies()` is replaced — there
 * is no Next request scope in a unit run.
 */

const jar = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    get: (name: string) => (values.has(name) ? { name, value: values.get(name) ?? '' } : undefined),
    set: (name: string, value: string) => {
      values.set(name, value);
    },
    delete: (name: string) => {
      values.delete(name);
    },
  };
});
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));

const TOKEN = 'rt-valid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let upstreamCalls = 0;

function upstream(answer: () => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', () => {
    upstreamCalls += 1;
    return Promise.resolve().then(answer);
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const request = (csrf = 'csrf-1') => new Request('http://web.test/api/auth/refresh', { method: 'POST', headers: { 'x-daftar-csrf': csrf } });

beforeEach(() => {
  upstreamCalls = 0;
  jar.values.clear();
  jar.values.set('daftar_rt', TOKEN);
  jar.values.set('daftar_csrf', 'csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TD-19 refresh: retryable answers keep the session', () => {
  it('an upstream 429 stays a 429 with the API’s Retry-After, and the cookie stays', async () => {
    upstream(() => json(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '42' }));
    const res = await refresh(request());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(jar.values.get('daftar_rt')).toBe(TOKEN);
  });

  it('a 429 without a usable Retry-After still says when to retry', async () => {
    upstream(() => json(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': 'soon' }));
    const res = await refresh(request());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(jar.values.get('daftar_rt')).toBe(TOKEN);
  });

  it.each([
    ['limiter outage 503', () => json(503, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '5' })],
    ['500', () => json(500, { error: { code: 'INTERNAL' } })],
    ['502 from a gateway, not JSON', () => new Response('<html>bad gateway</html>', { status: 502 })],
    ['504', () => new Response('', { status: 504 })],
    ['404 (a misrouted API_URL)', () => json(404, { error: { code: 'NOT_FOUND' } })],
    ['403', () => json(403, { error: { code: 'FORBIDDEN' } })],
  ])('an upstream %s answers 503 with Retry-After and keeps the cookie', async (_label, answer) => {
    upstream(answer);
    const res = await refresh(request());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: 'REFRESH_UNAVAILABLE' });
    expect(jar.values.get('daftar_rt')).toBe(TOKEN);
  });

  it('an unreachable API answers 503 and keeps the cookie', async () => {
    upstream(() => Promise.reject(new TypeError('fetch failed')));
    const res = await refresh(request());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(jar.values.get('daftar_rt')).toBe(TOKEN);
  });
});

describe('TD-19 refresh: the auth contract is unchanged where the credential is refused', () => {
  it.each([
    ['401 UNAUTHENTICATED (unknown token)', () => json(401, { error: { code: 'UNAUTHENTICATED' } })],
    ['401 TOKEN_REUSE_DETECTED', () => json(401, { error: { code: 'TOKEN_REUSE_DETECTED' } })],
    ['400 VALIDATION_FAILED (a malformed cookie)', () => json(400, { error: { code: 'VALIDATION_FAILED' } })],
  ])('an upstream %s deletes the cookie and answers 401', async (_label, answer) => {
    upstream(answer);
    const res = await refresh(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'REFRESH_FAILED' });
    expect(jar.values.has('daftar_rt')).toBe(false);
  });

  it('a 2xx without a readable successor deletes the consumed cookie', async () => {
    upstream(() => json(200, { accessToken: 'at' }));
    const res = await refresh(request());
    expect(res.status).toBe(401);
    expect(jar.values.has('daftar_rt')).toBe(false);
  });

  it('a successful rotation replaces the cookie and returns the access token', async () => {
    upstream(() => json(201, { accessToken: 'at-1', refreshToken: 'rt-next-0123456789abcdef', expiresInSeconds: 900 }));
    const res = await refresh(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessToken: 'at-1', expiresInSeconds: 900 });
    expect(jar.values.get('daftar_rt')).toBe('rt-next-0123456789abcdef');
  });

  it('no cookie, or a CSRF mismatch, never reaches the API', async () => {
    upstream(() => json(200, {}));
    expect((await refresh(request('csrf-other'))).status).toBe(403);
    jar.values.delete('daftar_rt');
    expect((await refresh(request())).status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });
});
