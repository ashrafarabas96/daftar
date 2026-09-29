import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { NextRequest } from 'next/server';
import { EDGE_TOKEN_ENV, EDGE_TOKEN_HEADER, stampPeer } from '../server.mjs';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as refresh } from '@/app/api/auth/refresh/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { GET as proxyGet, POST as proxyPost } from '@/app/api/proxy/[...path]/route';

/**
 * TD-19: every BFF route that reaches the API carries the client address the
 * production entry (`server.mts`) established, and nothing a caller wrote
 * itself. The upstream is stubbed; the real-API proof is
 * `tests/integration/p3c-bff-client-ip.test.ts`.
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

const BOOT_SECRET = 'a'.repeat(64);
const sent: Headers[] = [];

function stubUpstream(
  status = 200,
  body: unknown = { accessToken: 'at', refreshToken: 'rt-aaaaaaaaaaaaaaaaaaaa' },
  headers: Record<string, string> = {},
): void {
  vi.stubGlobal('fetch', (_input: string | URL | Request, init: RequestInit = {}) => {
    sent.push(new Headers(init.headers));
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
  });
}

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(h)) {
    if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

/** A request as the handler sees it: through the entry (stamped) or not. */
function req(path: string, method: string, own: Record<string, string>, via: 'edge' | 'direct', peer = '198.51.100.7'): NextRequest {
  const headers: IncomingHttpHeaders = { 'content-type': 'application/json', 'x-daftar-csrf': 'c', ...own };
  if (via === 'edge') stampPeer(headers, peer, BOOT_SECRET);
  return new NextRequest(`http://web.test${path}`, {
    method,
    headers: toHeaders(headers),
    ...(method === 'GET' ? {} : { body: JSON.stringify({ email: 'a@b.co', password: 'x', displayName: 'd', preferredLocale: 'ar' }) }),
  });
}

type Route = (via: 'edge' | 'direct', own: Record<string, string>) => Promise<Response>;
const ROUTES: [string, Route][] = [
  ['login', (via, own) => login(req('/api/auth/login', 'POST', own, via))],
  ['register', (via, own) => register(req('/api/auth/register', 'POST', own, via))],
  ['refresh', (via, own) => refresh(req('/api/auth/refresh', 'POST', own, via))],
  ['logout', (via, own) => logout(req('/api/auth/logout', 'POST', own, via))],
  [
    'proxy POST (password reset request)',
    (via, own) =>
      proxyPost(req('/api/proxy/auth/password-reset/request', 'POST', own, via), { params: Promise.resolve({ path: ['auth', 'password-reset', 'request'] }) }),
  ],
  ['proxy GET', (via, own) => proxyGet(req('/api/proxy/products', 'GET', own, via), { params: Promise.resolve({ path: ['products'] }) })],
];

beforeEach(() => {
  sent.length = 0;
  jar.values.clear();
  jar.values.set('daftar_rt', 'rt-current-0123456789abcdef');
  jar.values.set('daftar_csrf', 'c');
  process.env[EDGE_TOKEN_ENV] = BOOT_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[EDGE_TOKEN_ENV];
});

describe('TD-19 the production entry appends the peer as a proxy does', () => {
  it('appends the peer to an existing chain and stamps the boot secret', () => {
    const h: IncomingHttpHeaders = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
    stampPeer(h, '192.0.2.1', BOOT_SECRET);
    expect(h['x-forwarded-for']).toBe('203.0.113.9, 10.0.0.1, 192.0.2.1');
    expect(h[EDGE_TOKEN_HEADER]).toBe(BOOT_SECRET);
  });

  it('starts the chain with the peer when none arrived, and joins a repeated header', () => {
    const none: IncomingHttpHeaders = {};
    stampPeer(none, '::ffff:192.0.2.2', BOOT_SECRET);
    expect(none['x-forwarded-for']).toBe('::ffff:192.0.2.2');
    const repeated: IncomingHttpHeaders = { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] };
    stampPeer(repeated, '192.0.2.3', BOOT_SECRET);
    expect(repeated['x-forwarded-for']).toBe('1.1.1.1, 2.2.2.2, 192.0.2.3');
  });

  it('overwrites a stamp the caller sent, and stamps nothing without a peer', () => {
    const h: IncomingHttpHeaders = { [EDGE_TOKEN_HEADER]: 'guess', 'x-forwarded-for': '203.0.113.9' };
    stampPeer(h, undefined, BOOT_SECRET);
    expect(h[EDGE_TOKEN_HEADER]).toBeUndefined();
    expect(h['x-forwarded-for']).toBe('203.0.113.9');
    stampPeer(h, '192.0.2.4', BOOT_SECRET);
    expect(h[EDGE_TOKEN_HEADER]).toBe(BOOT_SECRET);
  });
});

describe('TD-19 every BFF route forwards the stamped chain and nothing else', () => {
  for (const [name, call] of ROUTES) {
    it(`${name}: through the entry, the API receives the chain ending in the real peer`, async () => {
      stubUpstream();
      await call('edge', { 'x-forwarded-for': '203.0.113.200' });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.get('x-forwarded-for')).toBe('203.0.113.200, 198.51.100.7');
      expect(sent[0]?.get(EDGE_TOKEN_HEADER)).toBeNull();
    });

    it(`${name}: without the entry's stamp, a caller's own X-Forwarded-For never reaches the API`, async () => {
      stubUpstream();
      await call('direct', { 'x-forwarded-for': '203.0.113.200', [EDGE_TOKEN_HEADER]: 'b'.repeat(64) });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.get('x-forwarded-for')).toBeNull();
      expect(sent[0]?.get(EDGE_TOKEN_HEADER)).toBeNull();
    });
  }

  it('a process not started through the entry forwards no address even for a stamped-looking request', async () => {
    delete process.env[EDGE_TOKEN_ENV];
    stubUpstream();
    await login(req('/api/auth/login', 'POST', { [EDGE_TOKEN_HEADER]: '', 'x-forwarded-for': '203.0.113.200' }, 'direct'));
    expect(sent[0]?.get('x-forwarded-for')).toBeNull();
  });

  it('only the rightmost sixteen hops travel, the peer always last; malformed hops are dropped', async () => {
    stubUpstream();
    const long = Array.from({ length: 40 }, (_, i) => `10.9.${i}.1`).join(', ');
    await login(req('/api/auth/login', 'POST', { 'x-forwarded-for': `${'x'.repeat(60)}, ${long}` }, 'edge'));
    const chain = (sent[0]?.get('x-forwarded-for') ?? '').split(', ');
    expect(chain).toHaveLength(16);
    expect(chain.at(-1)).toBe('198.51.100.7');
    expect(chain.every((hop) => hop.length <= 45)).toBe(true);
  });
});

describe('TD-19 limits travel back to the browser with their retry time', () => {
  it('login passes a 429 on with Retry-After', async () => {
    stubUpstream(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '120' });
    const res = await login(req('/api/auth/login', 'POST', {}, 'edge'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it('register passes a 429 on with Retry-After', async () => {
    stubUpstream(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '120' });
    const res = await register(req('/api/auth/register', 'POST', {}, 'edge'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it('the proxy passes a 429 on with Retry-After and still no-store', async () => {
    stubUpstream(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '77' });
    const res = await proxyPost(req('/api/proxy/auth/password-reset/request', 'POST', {}, 'edge'), {
      params: Promise.resolve({ path: ['auth', 'password-reset', 'request'] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('77');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
