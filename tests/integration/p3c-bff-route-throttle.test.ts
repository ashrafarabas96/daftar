import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '../helpers/test-app';

/**
 * TD-19 (Phase 3 corrective): the API's general allowance — `ThrottlerModule`,
 * 300 requests per minute for each route handler and client, on every HTTP
 * route — counts the CLIENT, by the same `clientIp()` / TRUSTED_PROXIES
 * authority the auth limits use, not the TCP peer. Behind the web server the
 * TCP peer is the web server itself, so keyed on the peer every merchant
 * behind one web instance shared one allowance per route.
 *
 * Proved on the REAL web proxy route handler and the production entry's
 * `stampPeer`, against the REAL API listening on a socket, with the
 * production limit. `GET /v1/me/businesses` is the route: the throttle runs
 * before authentication, so an unauthenticated call is counted (401) until
 * the allowance is gone (429), and no account is needed.
 */
vi.mock('server-only', () => ({}));

const LIMIT = 300; // apps/api/src/app/runtime.ts
const ROUTE = ['me', 'businesses'];

interface Edge {
  EDGE_TOKEN_ENV: string;
  stampPeer: (headers: IncomingHttpHeaders, peer: string | undefined, token: string) => void;
}
type ProxyHandler = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

const WEB = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const loadWeb = (path: string): Promise<unknown> => import(`${WEB}${path}`);
const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;
function isEntry(m: unknown): m is Edge {
  return isObject(m) && typeof m['EDGE_TOKEN_ENV'] === 'string' && typeof m['stampPeer'] === 'function';
}
function proxyGetOf(m: unknown): ProxyHandler {
  const fn = isObject(m) ? m['GET'] : undefined;
  if (typeof fn !== 'function') throw new Error('the web proxy exports no GET');
  return async (req, ctx) => {
    const res: unknown = await fn(req, ctx);
    if (!(res instanceof Response)) throw new Error('the web proxy did not answer with a Response');
    return res;
  };
}

const EDGE_TOKEN = randomBytes(32).toString('hex');
let edge: Edge;
let proxyGet: ProxyHandler;
let t: TestApp;
let apiUrl: string;

/** One browser's GET through the production entry's stamp and the web proxy; `forged` is an X-Forwarded-For the browser itself sends. */
async function viaWeb(peer: string, forged?: string): Promise<number> {
  const headers: IncomingHttpHeaders = {};
  if (forged !== undefined) headers['x-forwarded-for'] = forged;
  edge.stampPeer(headers, peer, EDGE_TOKEN);
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(', ') : value);
  const res = await proxyGet(new Request(`http://web.test/api/proxy/${ROUTE.join('/')}`, { headers: out }), {
    params: Promise.resolve({ path: ROUTE }),
  });
  await res.arrayBuffer();
  return res.status;
}

/** A caller that reaches the API itself, from a chosen loopback source address, with whatever X-Forwarded-For it likes. */
function direct(localAddress: string, forged?: string): Promise<number> {
  const url = new URL(`/v1/${ROUTE.join('/')}`, apiUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        localAddress,
        headers: forged === undefined ? {} : { 'x-forwarded-for': forged },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Spend `n` of an allowance, each call counted (401) and none refused. */
async function spend(n: number, send: (i: number) => Promise<number>): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const status = await send(i);
    expect(status, `call ${i + 1} of ${n}`).toBe(401);
  }
}

beforeAll(async () => {
  // The web server (this process, calling from 127.0.0.1) is the API's one trusted proxy.
  t = await createTestApp({ configOverrides: { TRUSTED_PROXIES: '127.0.0.1' } });
  await t.app.listen(0, '127.0.0.1');
  const address = t.app.getHttpServer().address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
  process.env['API_URL'] = apiUrl;
  const entry = await loadWeb('server.mts');
  if (!isEntry(entry)) throw new Error('apps/web/server.mts does not export the edge stamp');
  edge = entry;
  process.env[edge.EDGE_TOKEN_ENV] = EDGE_TOKEN;
  proxyGet = proxyGetOf(await loadWeb('src/app/api/proxy/[...path]/route.ts'));
});

afterAll(async () => {
  delete process.env[edge.EDGE_TOKEN_ENV];
  await t.close();
});

describe('TD-19: the API route allowance counts the client, not the web server', () => {
  it('two clients behind one web server: the second has its own allowance after the first spends all of its', async () => {
    await spend(LIMIT, () => viaWeb('203.0.113.10'));
    expect(await viaWeb('203.0.113.10')).toBe(429); // the first client reached its own limit
    expect(await viaWeb('198.51.100.20')).toBe(401); // the other client behind the same web server was never charged
  });

  it('a spoofed X-Forwarded-For through the web server does not buy a fresh allowance', async () => {
    await spend(LIMIT, (i) => viaWeb('192.0.2.66', `10.9.${Math.floor(i / 256)}.${i % 256}`));
    expect(await viaWeb('192.0.2.66', '10.200.0.1')).toBe(429);
  });

  it('a caller the API does not trust cannot choose its address with X-Forwarded-For', async () => {
    await spend(LIMIT, (i) => direct('127.0.0.2', `10.8.${Math.floor(i / 256)}.${i % 256}`));
    expect(await direct('127.0.0.2', '10.200.0.2')).toBe(429);
  });

  it('a direct caller is counted by its own address, as before', async () => {
    await spend(LIMIT, () => direct('127.0.0.3'));
    expect(await direct('127.0.0.3')).toBe(429);
    expect(await direct('127.0.0.4')).toBe(401);
  });
});
