import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestApp, ownerPool, uniqueEmail, type TestApp } from '../helpers/test-app';
import { hashRefreshToken } from '../../apps/api/src/modules/auth/tokens';

/**
 * TD-19 for the ADMIN console's BFF (Phase 3 corrective directive §5: the
 * entire BFF-to-auth boundary). Same chain as the merchant web app
 * (`p3c-bff-client-ip.test.ts`), proved on the REAL admin route handlers
 * against the REAL API listening on a socket:
 *
 *   simulated operator browser (peer P) → `apps/admin/server.mts` (appends P,
 *   stamps the boot secret) → admin route handler → API at 127.0.0.1 with
 *   TRUSTED_PROXIES=127.0.0.1 → `clientIp()` finds P.
 *
 * Only `cookies()` is replaced by each simulated browser's jar. Users are
 * registered straight at the API from the trusted loopback with a distinct
 * X-Forwarded-For each, so the fixture never spends a client's allowance.
 */

class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly peer: string) {}
  jar() {
    return {
      get: (name: string) => {
        const value = this.cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string): void => {
        this.cookies.set(name, value);
      },
      delete: (name: string): void => {
        this.cookies.delete(name);
      },
    };
  }
}

const state = vi.hoisted(() => ({ browser: null as { jar(): unknown } | null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () => {
    if (!state.browser) throw new Error('no simulated browser for this request');
    return Promise.resolve(state.browser.jar());
  },
}));

const RT = 'daftar_admin_rt';
const CSRF = 'daftar_admin_csrf';
const PASSWORD = 'Str0ng!Passw0rd';

/** Loaded at run time by path (see the web suite): Next's global types stay out of the root program. */
interface Edge {
  EDGE_TOKEN_ENV: string;
  stampPeer: (headers: IncomingHttpHeaders, peer: string | undefined, token: string) => void;
}
type Handler = (req: Request, ctx?: { params: Promise<{ path: string[] }> }) => Promise<Response>;
const ADMIN = fileURLToPath(new URL('../../apps/admin/', import.meta.url));
const loadAdmin = (path: string): Promise<unknown> => import(`${ADMIN}${path}`);
const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;
function isEntry(m: unknown): m is Edge {
  return isObject(m) && typeof m['EDGE_TOKEN_ENV'] === 'string' && typeof m['stampPeer'] === 'function';
}
function handlerOf(m: unknown, name: string): Handler {
  const fn = isObject(m) ? m[name] : undefined;
  if (typeof fn !== 'function') throw new Error(`route module does not export ${name}`);
  return async (req, ctx) => {
    const res: unknown = await fn(req, ctx);
    if (!(res instanceof Response)) throw new Error(`${name} did not answer with a Response`);
    return res;
  };
}

const EDGE_TOKEN = randomBytes(32).toString('hex');
let edge: Edge;
let t: TestApp;
let apiUrl: string;
let routes: { login: Handler; refresh: Handler; logout: Handler; proxyPost: Handler };
let fixtureIp = 0;

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(h)) {
    if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

function incoming(browser: Browser, path: string, init: { headers?: Record<string, string>; body?: unknown }, via: 'edge' | 'direct'): Request {
  const headers: IncomingHttpHeaders = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value;
  if (via === 'edge') edge.stampPeer(headers, browser.peer, EDGE_TOKEN);
  return new Request(`http://admin.test${path}`, {
    method: 'POST',
    headers: toHeaders(headers),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function call(
  browser: Browser,
  handler: Handler,
  path: string,
  init: { headers?: Record<string, string>; body?: unknown } = {},
  via: 'edge' | 'direct' = 'edge',
  segments?: string[],
) {
  state.browser = browser;
  try {
    const res = await handler(incoming(browser, path, init, via), segments ? { params: Promise.resolve({ path: segments }) } : undefined);
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
  } finally {
    state.browser = null;
  }
}

const csrf = (b: Browser): Record<string, string> => ({ 'x-daftar-csrf': b.cookies.get(CSRF) ?? '' });
const refresh = (b: Browser, via: 'edge' | 'direct' = 'edge', extra: Record<string, string> = {}) =>
  call(b, routes.refresh, '/api/auth/refresh', { headers: { ...csrf(b), ...extra } }, via);
const resetRequest = (b: Browser) =>
  call(b, routes.proxyPost, '/api/proxy/auth/password-reset/request', { body: { email: uniqueEmail() } }, 'edge', ['auth', 'password-reset', 'request']);

/** A raw HTTP call to the API from a chosen loopback source address (no BFF). */
function directApi(localAddress: string, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = new URL(path, apiUrl);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        localAddress,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Register an operator at the API (from the trusted loopback, a fresh address each) and log in through the admin BFF. */
async function signedIn(b: Browser): Promise<void> {
  const email = uniqueEmail();
  fixtureIp += 1;
  const reg = await directApi(
    '127.0.0.1',
    '/v1/auth/register',
    { email, password: PASSWORD, displayName: 'Operator', preferredLocale: 'en' },
    { 'x-forwarded-for': `100.64.${Math.floor(fixtureIp / 250)}.${(fixtureIp % 250) + 1}` },
  );
  expect(reg.status, reg.body).toBe(201);
  const res = await call(b, routes.login, '/api/auth/login', { body: { email, password: PASSWORD } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(b.cookies.get(RT)).toBeTruthy();
  expect(b.cookies.get(CSRF)).toBeTruthy();
}

async function refreshTokenState(token: string): Promise<string | undefined> {
  const row = await ownerPool().query<{ state: string }>('SELECT state FROM session_refresh_tokens WHERE token_hash = $1', [hashRefreshToken(token)]);
  return row.rows[0]?.state;
}

beforeAll(async () => {
  t = await createTestApp({ configOverrides: { TRUSTED_PROXIES: '127.0.0.1' } });
  await t.app.listen(0, '127.0.0.1');
  const address = t.app.getHttpServer().address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
  process.env['PLATFORM_API_URL'] = apiUrl;
  const entry = await loadAdmin('server.mts');
  if (!isEntry(entry)) throw new Error('apps/admin/server.mts does not export the edge stamp');
  edge = entry;
  process.env[edge.EDGE_TOKEN_ENV] = EDGE_TOKEN;
  routes = {
    login: handlerOf(await loadAdmin('src/app/api/auth/login/route.ts'), 'POST'),
    refresh: handlerOf(await loadAdmin('src/app/api/auth/refresh/route.ts'), 'POST'),
    logout: handlerOf(await loadAdmin('src/app/api/auth/logout/route.ts'), 'POST'),
    proxyPost: handlerOf(await loadAdmin('src/app/api/proxy/[...path]/route.ts'), 'POST'),
  };
});

afterAll(async () => {
  delete process.env[edge.EDGE_TOKEN_ENV];
  delete process.env['PLATFORM_API_URL'];
  await t.close();
});

describe('TD-19 admin refresh through one BFF', () => {
  it('61 refreshes from two operators: the second one’s 60 do not log the first out', async () => {
    const alice = new Browser('203.0.113.110');
    const bob = new Browser('198.51.100.120');
    await signedIn(alice);
    await signedIn(bob);
    for (let i = 0; i < 60; i += 1) {
      const res = await refresh(bob);
      expect(res.status, `bob refresh ${i + 1}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const before = alice.cookies.get(RT);
    const res = await refresh(alice);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(alice.cookies.get(RT)).toBeTruthy();
    expect(alice.cookies.get(RT)).not.toBe(before);
  });

  it('one operator still reaches its own limit; the 429 stays a 429 with Retry-After and keeps the valid cookie', async () => {
    const carol = new Browser('192.0.2.130');
    const dave = new Browser('192.0.2.131');
    await signedIn(carol);
    await signedIn(dave);
    for (let i = 0; i < 60; i += 1) expect((await refresh(carol)).status).toBe(200);
    const held = carol.cookies.get(RT) ?? '';
    const limited = await refresh(carol);
    expect(limited.status).toBe(429);
    expect(limited.body['error']).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(carol.cookies.get(RT)).toBe(held);
    expect(await refreshTokenState(held)).toBe('issued');
    expect((await refresh(dave)).status).toBe(200);
  });

  it('a spoofed X-Forwarded-For through the edge does not buy a fresh allowance', async () => {
    const mallory = new Browser('192.0.2.166');
    await signedIn(mallory);
    for (let i = 0; i < 60; i += 1) {
      expect((await refresh(mallory, 'edge', { 'x-forwarded-for': `203.0.113.${100 + i}` })).status).toBe(200);
    }
    expect((await refresh(mallory, 'edge', { 'x-forwarded-for': '203.0.113.250' })).status).toBe(429);
  });

  it('a caller that bypassed the edge cannot choose its address, not even with a guessed stamp', async () => {
    const trent = new Browser('192.0.2.170');
    await signedIn(trent);
    for (let i = 0; i < 60; i += 1) {
      const res = await refresh(trent, 'direct', { 'x-forwarded-for': `198.18.2.${i + 1}`, 'x-daftar-edge': randomBytes(32).toString('hex') });
      expect(res.status).toBe(200);
    }
    expect((await refresh(trent, 'direct', { 'x-forwarded-for': '198.18.3.1' })).status).toBe(429);
  });

  it('a true invalid or reused refresh still ends the session and clears the cookie', async () => {
    const grace = new Browser('192.0.2.180');
    await signedIn(grace);
    const first = grace.cookies.get(RT) ?? '';
    expect((await refresh(grace)).status).toBe(200);
    const second = grace.cookies.get(RT) ?? '';
    grace.cookies.set(RT, first);
    const replay = await refresh(grace);
    expect(replay.status).toBe(401);
    expect(replay.body['error']).toBe('REFRESH_FAILED');
    expect(grace.cookies.has(RT)).toBe(false);
    grace.cookies.set(RT, second);
    expect((await refresh(grace)).status).toBe(401);
    expect(grace.cookies.has(RT)).toBe(false);
    expect(await refreshTokenState(second)).toBe('revoked');
    grace.cookies.set(RT, randomBytes(32).toString('hex'));
    expect((await refresh(grace)).status).toBe(401);
    expect(grace.cookies.has(RT)).toBe(false);
  });
});

describe('TD-19 admin: every other client-address-limited route', () => {
  it('login: one operator’s 30 failures lock only that operator, with Retry-After', async () => {
    const eve = new Browser('192.0.2.190');
    const frank = new Browser('192.0.2.191');
    for (let i = 0; i < 30; i += 1) {
      expect((await call(eve, routes.login, '/api/auth/login', { body: { email: uniqueEmail(), password: 'wrong-password' } })).status).toBe(401);
    }
    const locked = await call(eve, routes.login, '/api/auth/login', { body: { email: uniqueEmail(), password: 'wrong-password' } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    await signedIn(frank);
  });

  it('password reset through the admin proxy is counted per client, and the 429 keeps its Retry-After', async () => {
    const x = new Browser('192.0.2.200');
    const y = new Browser('192.0.2.201');
    for (let i = 0; i < 20; i += 1) expect((await resetRequest(x)).status).toBe(201);
    const limited = await resetRequest(x);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await resetRequest(y)).status).toBe(201);
  });

  it('logout still clears the session', async () => {
    const h = new Browser('192.0.2.210');
    await signedIn(h);
    const refreshed = await refresh(h);
    const live = h.cookies.get(RT) ?? '';
    const out = await call(h, routes.logout, '/api/auth/logout', {
      headers: { ...csrf(h), authorization: `Bearer ${String(refreshed.body['accessToken'])}` },
    });
    expect(out.status).toBe(200);
    expect(h.cookies.has(RT)).toBe(false);
    expect(await refreshTokenState(live)).toBe('revoked');
  });
});
