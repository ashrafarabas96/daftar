import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestApp, ownerPool, uniqueEmail, type TestApp } from '../helpers/test-app';
import { hashRefreshToken } from '../../apps/api/src/modules/auth/tokens';

/**
 * TD-19 (Phase 3 corrective directive §5): the whole BFF-to-auth client
 * address chain, proved on the REAL route handlers of `apps/web` against the
 * REAL API listening on a socket.
 *
 * The chain under test:
 *   simulated browser (peer P) → web entry `server.mts` (appends P to XFF,
 *   stamps the boot secret) → BFF route handler (forwards XFF only when the
 *   stamp matches) → API at 127.0.0.1 with TRUSTED_PROXIES=127.0.0.1 →
 *   `clientIp()` walks XFF right to left and finds P.
 *
 * Only the Next request context is replaced: `cookies()` from `next/headers`
 * becomes each simulated browser's own cookie jar, because outside a Next
 * server there is no request scope to read cookies from. Everything the
 * handlers do upstream is real HTTP to the real API, whose per-IP limits are
 * the production constants (refresh 60, login 30, register 10, password reset
 * request 20 and complete 20, per window).
 */

interface CookieEntry {
  name: string;
  value: string;
}

class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly peer: string) {}
  jar() {
    return {
      get: (name: string): CookieEntry | undefined => {
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

type Handler = (req: Request) => Promise<Response>;
type ProxyHandler = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
interface Routes {
  login: Handler;
  register: Handler;
  refresh: Handler;
  logout: Handler;
  proxyPost: ProxyHandler;
}

/**
 * The web modules are loaded at run time by path, not imported: a static
 * import would pull Next's global type augmentations into the root type
 * program (Next makes `process.env.NODE_ENV` a required literal union).
 * What comes back is checked before it is used.
 */
interface Edge {
  EDGE_TOKEN_ENV: string;
  stampPeer: (headers: IncomingHttpHeaders, peer: string | undefined, token: string) => void;
}
const WEB = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const loadWeb = (path: string): Promise<unknown> => import(`${WEB}${path}`);
const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;
function isEntry(m: unknown): m is Edge {
  return isObject(m) && typeof m['EDGE_TOKEN_ENV'] === 'string' && typeof m['stampPeer'] === 'function';
}
function handlerOf(m: unknown, name: string): (req: Request, ctx?: { params: Promise<{ path: string[] }> }) => Promise<Response> {
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
let routes: Routes;

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(h)) {
    if (value === undefined) continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

/**
 * The request as the route handler receives it. `via: 'edge'` passes the
 * headers through the production entry's `stampPeer` with the browser's peer
 * address; `via: 'direct'` is a caller that reached the handler some other way
 * (plain `next start`, a misrouted port), its headers untouched.
 */
function incoming(browser: Browser, path: string, init: { headers?: Record<string, string>; body?: unknown }, via: 'edge' | 'direct' = 'edge'): Request {
  const headers: IncomingHttpHeaders = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value;
  if (via === 'edge') edge.stampPeer(headers, browser.peer, EDGE_TOKEN);
  return new Request(`http://web.test${path}`, {
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
) {
  state.browser = browser;
  try {
    const res = await handler(incoming(browser, path, init, via));
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
  } finally {
    state.browser = null;
  }
}

const csrf = (b: Browser): Record<string, string> => ({ 'x-daftar-csrf': b.cookies.get('daftar_csrf') ?? '' });
const refresh = (b: Browser, via: 'edge' | 'direct' = 'edge', extra: Record<string, string> = {}) =>
  call(b, routes.refresh, '/api/auth/refresh', { headers: { ...csrf(b), ...extra } }, via);

async function proxyPost(browser: Browser, segments: string[], body: unknown) {
  state.browser = browser;
  try {
    const res = await routes.proxyPost(incoming(browser, `/api/proxy/${segments.join('/')}`, { body }), { params: Promise.resolve({ path: segments }) });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
  } finally {
    state.browser = null;
  }
}

async function registerThroughBff(b: Browser): Promise<void> {
  const res = await call(b, routes.register, '/api/auth/register', {
    body: { email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'BFF client', preferredLocale: 'ar' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(b.cookies.get('daftar_rt')).toBeTruthy();
  expect(b.cookies.get('daftar_csrf')).toBeTruthy();
}

async function refreshTokenState(token: string): Promise<string | undefined> {
  const row = await ownerPool().query<{ state: string }>('SELECT state FROM session_refresh_tokens WHERE token_hash = $1', [hashRefreshToken(token)]);
  return row.rows[0]?.state;
}

/** A raw HTTP call to the API from a chosen loopback source address (no BFF). */
function directApi(localAddress: string, path: string, body: unknown, headers: Record<string, string>): Promise<number> {
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
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  // The web server (this process, calling from 127.0.0.1) is the API's one
  // trusted proxy — the deployment requirement TD-19 documents.
  t = await createTestApp({ configOverrides: { TRUSTED_PROXIES: '127.0.0.1' } });
  await t.app.listen(0, '127.0.0.1');
  const address = t.app.getHttpServer().address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
  process.env['API_URL'] = apiUrl;
  const entry = await loadWeb('server.mts');
  if (!isEntry(entry)) throw new Error('apps/web/server.mts does not export the edge stamp');
  edge = entry;
  process.env[edge.EDGE_TOKEN_ENV] = EDGE_TOKEN;
  routes = {
    login: handlerOf(await loadWeb('src/app/api/auth/login/route.ts'), 'POST'),
    register: handlerOf(await loadWeb('src/app/api/auth/register/route.ts'), 'POST'),
    refresh: handlerOf(await loadWeb('src/app/api/auth/refresh/route.ts'), 'POST'),
    logout: handlerOf(await loadWeb('src/app/api/auth/logout/route.ts'), 'POST'),
    proxyPost: handlerOf(await loadWeb('src/app/api/proxy/[...path]/route.ts'), 'POST'),
  };
});

afterAll(async () => {
  delete process.env[edge.EDGE_TOKEN_ENV];
  await t.close();
});

describe('TD-19 refresh through one BFF', () => {
  it('61 refreshes from two clients: the second client’s 60 do not log the first user out', async () => {
    const alice = new Browser('203.0.113.10');
    const bob = new Browser('198.51.100.20');
    await registerThroughBff(alice);
    await registerThroughBff(bob);
    for (let i = 0; i < 60; i += 1) {
      const res = await refresh(bob);
      expect(res.status, `bob refresh ${i + 1}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const before = alice.cookies.get('daftar_rt');
    const res = await refresh(alice); // the 61st refresh this web server sends in the window
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(typeof res.body['accessToken']).toBe('string');
    expect(alice.cookies.get('daftar_rt')).toBeTruthy();
    expect(alice.cookies.get('daftar_rt')).not.toBe(before); // rotated, not deleted
  });

  it('one client still reaches its own limit; the 429 stays a 429 with Retry-After and keeps the valid cookie', async () => {
    const carol = new Browser('192.0.2.30');
    const dave = new Browser('192.0.2.31');
    await registerThroughBff(carol);
    await registerThroughBff(dave);
    for (let i = 0; i < 60; i += 1) expect((await refresh(carol)).status).toBe(200);
    const held = carol.cookies.get('daftar_rt') ?? '';
    const limited = await refresh(carol);
    expect(limited.status).toBe(429);
    expect(limited.body['error']).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // The session credential survives the rate limit: same cookie, still live.
    expect(carol.cookies.get('daftar_rt')).toBe(held);
    expect(await refreshTokenState(held)).toBe('issued');
    // Another client behind the same web server is untouched.
    expect((await refresh(dave)).status).toBe(200);
  });

  it('a spoofed X-Forwarded-For through the edge does not buy a fresh allowance', async () => {
    const mallory = new Browser('192.0.2.66');
    await registerThroughBff(mallory);
    for (let i = 0; i < 60; i += 1) {
      const res = await refresh(mallory, 'edge', { 'x-forwarded-for': `203.0.113.${100 + i}` });
      expect(res.status).toBe(200);
    }
    const res = await refresh(mallory, 'edge', { 'x-forwarded-for': '203.0.113.250' });
    expect(res.status).toBe(429);
  });

  it('a caller that bypassed the edge cannot choose its address, not even with a guessed stamp', async () => {
    const trent = new Browser('192.0.2.70');
    await registerThroughBff(trent); // the session itself is legitimate
    // From here on the requests reach the handler without the edge: whatever
    // they claim, the API sees the web server itself — one shared allowance.
    for (let i = 0; i < 60; i += 1) {
      const res = await refresh(trent, 'direct', { 'x-forwarded-for': `198.18.0.${i + 1}`, 'x-daftar-edge': randomBytes(32).toString('hex') });
      expect(res.status).toBe(200);
    }
    const res = await refresh(trent, 'direct', { 'x-forwarded-for': '198.18.1.1' });
    expect(res.status).toBe(429);
  });

  it('a true invalid or reused refresh still ends the session and clears the cookie', async () => {
    const grace = new Browser('192.0.2.80');
    await registerThroughBff(grace);
    const first = grace.cookies.get('daftar_rt') ?? '';
    expect((await refresh(grace)).status).toBe(200);
    const second = grace.cookies.get('daftar_rt') ?? '';
    // Replay of the consumed token: reuse detection revokes the family.
    grace.cookies.set('daftar_rt', first);
    const replay = await refresh(grace);
    expect(replay.status).toBe(401);
    expect(replay.body['error']).toBe('REFRESH_FAILED');
    expect(grace.cookies.has('daftar_rt')).toBe(false);
    // The successor was revoked with the family.
    grace.cookies.set('daftar_rt', second);
    const revoked = await refresh(grace);
    expect(revoked.status).toBe(401);
    expect(grace.cookies.has('daftar_rt')).toBe(false);
    expect(await refreshTokenState(second)).toBe('revoked');
    // A token the API has never issued, and one that fails its schema.
    grace.cookies.set('daftar_rt', randomBytes(32).toString('hex'));
    expect((await refresh(grace)).status).toBe(401);
    expect(grace.cookies.has('daftar_rt')).toBe(false);
    grace.cookies.set('daftar_rt', 'short');
    expect((await refresh(grace)).status).toBe(401);
    expect(grace.cookies.has('daftar_rt')).toBe(false);
  });
});

describe('TD-19 every other client-address-limited route', () => {
  it('login: one client’s 30 failures lock only that client, with Retry-After', async () => {
    const eve = new Browser('192.0.2.90');
    const frank = new Browser('192.0.2.91');
    const email = uniqueEmail();
    await call(frank, routes.register, '/api/auth/register', {
      body: { email, password: 'Str0ng!Passw0rd', displayName: 'Frank', preferredLocale: 'en' },
    });
    for (let i = 0; i < 30; i += 1) {
      const res = await call(eve, routes.login, '/api/auth/login', { body: { email: uniqueEmail(), password: 'wrong-password' } });
      expect(res.status).toBe(401);
    }
    const locked = await call(eve, routes.login, '/api/auth/login', { body: { email: uniqueEmail(), password: 'wrong-password' } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    const ok = await call(frank, routes.login, '/api/auth/login', { body: { email, password: 'Str0ng!Passw0rd' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('register: the tenth-and-one registration from one client is refused, another client registers', async () => {
    const farm = new Browser('192.0.2.100');
    for (let i = 0; i < 10; i += 1) await registerThroughBff(farm);
    const refused = await call(farm, routes.register, '/api/auth/register', {
      body: { email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Farm', preferredLocale: 'ar' },
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    await registerThroughBff(new Browser('192.0.2.101'));
  });

  it('password reset request and complete (through the proxy) are counted per client', async () => {
    const x = new Browser('192.0.2.110');
    const y = new Browser('192.0.2.111');
    for (let i = 0; i < 20; i += 1) {
      expect((await proxyPost(x, ['auth', 'password-reset', 'request'], { email: uniqueEmail() })).status).toBe(201);
    }
    const limited = await proxyPost(x, ['auth', 'password-reset', 'request'], { email: uniqueEmail() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await proxyPost(y, ['auth', 'password-reset', 'request'], { email: uniqueEmail() })).status).toBe(201);

    const bogus = { token: randomBytes(24).toString('hex'), password: 'An0ther!Passw0rd' };
    for (let i = 0; i < 20; i += 1) {
      expect((await proxyPost(x, ['auth', 'password-reset', 'complete'], bogus)).status).not.toBe(429);
    }
    expect((await proxyPost(x, ['auth', 'password-reset', 'complete'], bogus)).status).toBe(429);
    expect((await proxyPost(y, ['auth', 'password-reset', 'complete'], bogus)).status).not.toBe(429);
  });

  it('logout carries the client address too and still clears the session', async () => {
    const h = new Browser('192.0.2.120');
    await registerThroughBff(h);
    const refreshed = await refresh(h);
    const live = h.cookies.get('daftar_rt') ?? '';
    expect(await refreshTokenState(live)).toBe('issued');
    const out = await call(h, routes.logout, '/api/auth/logout', {
      headers: { ...csrf(h), authorization: `Bearer ${String(refreshed.body['accessToken'])}` },
    });
    expect(out.status).toBe(200);
    expect(h.cookies.has('daftar_rt')).toBe(false);
    expect(await refreshTokenState(live)).toBe('revoked');
  });
});

describe('TD-19 direct API behaviour is unchanged', () => {
  it('an untrusted direct caller’s forged X-Forwarded-For is ignored: its own limit applies', async () => {
    // 127.0.0.2 is not in TRUSTED_PROXIES: the API ignores its XFF entirely.
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      statuses.push(
        await directApi('127.0.0.2', '/v1/auth/refresh', { refreshToken: randomBytes(24).toString('hex') }, { 'x-forwarded-for': `203.0.113.${i + 1}` }),
      );
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
    // The web server's clients are separate from that caller.
    const ivan = new Browser('192.0.2.130');
    await registerThroughBff(ivan);
    expect((await refresh(ivan)).status).toBe(200);
  });
});
