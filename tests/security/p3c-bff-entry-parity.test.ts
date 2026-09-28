import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * TD-19: the merchant web app and the admin console carry the same client
 * address chain and the same refresh contract.
 *
 * - `src/lib/bff-upstream.ts` is one file in two apps, byte for byte;
 * - the production entries `server.mts` differ only in the default port and
 *   the name they log, and stamp identically;
 * - the admin refresh route keeps the session through a 429, a 5xx and an
 *   unreachable API, and clears it only when the credential is refused
 *   (the web route's matrix is `apps/web/test/bff-refresh.test.ts`).
 *
 * Modules are loaded at run time by path so Next's global type augmentations
 * stay out of the root type program.
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
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));

const APPS = ['web', 'admin'] as const;
const root = (app: string, path: string): string => fileURLToPath(new URL(`../../apps/${app}/${path}`, import.meta.url));
const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;

type Stamp = (headers: IncomingHttpHeaders, peer: string | undefined, token: string) => void;
async function stampOf(app: string): Promise<Stamp> {
  const m: unknown = await import(root(app, 'server.mts'));
  const fn = isObject(m) ? m['stampPeer'] : undefined;
  if (typeof fn !== 'function') throw new Error(`apps/${app}/server.mts exports no stampPeer`);
  return (headers, peer, token) => {
    fn(headers, peer, token);
  };
}

/** Code lines only: comments and blank lines dropped. */
function codeLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trimEnd())
    .filter((line) => line.trim().length > 0);
}

describe('TD-19 web and admin carry one client-address chain', () => {
  it('bff-upstream.ts is the same file in both apps', () => {
    expect(readFileSync(root('admin', 'src/lib/bff-upstream.ts'), 'utf8')).toBe(readFileSync(root('web', 'src/lib/bff-upstream.ts'), 'utf8'));
  });

  it('the two production entries differ only in their default port and the name they log', () => {
    const web = codeLines(root('web', 'server.mts'));
    const admin = codeLines(root('admin', 'server.mts'));
    expect(admin).toHaveLength(web.length);
    const differing = web.flatMap((line, i) => (line === admin[i] ? [] : [[line.trim(), admin[i]?.trim()]]));
    expect(differing).toEqual([
      ["const port = Number(process.env['PORT'] ?? 3001);", "const port = Number(process.env['PORT'] ?? 3100);"],
      ['process.stdout.write(`daftar web listening on ${port}\\n`);', 'process.stdout.write(`daftar admin listening on ${port}\\n`);'],
    ]);
  });

  it.each(APPS)('%s entry: appends the peer to the chain and overwrites a caller-sent stamp', async (app) => {
    const stamp = await stampOf(app);
    const h: IncomingHttpHeaders = { 'x-forwarded-for': '203.0.113.9', 'x-daftar-edge': 'guess' };
    stamp(h, '192.0.2.1', 'secret');
    expect(h['x-forwarded-for']).toBe('203.0.113.9, 192.0.2.1');
    expect(h['x-daftar-edge']).toBe('secret');
    const gone: IncomingHttpHeaders = { 'x-daftar-edge': 'guess' };
    stamp(gone, undefined, 'secret');
    expect(gone['x-daftar-edge']).toBeUndefined();
  });
});

describe('TD-19 admin refresh keeps the session through anything retryable', () => {
  const TOKEN = 'admin-rt-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  async function refreshWith(answer: () => Response | Promise<Response>): Promise<Response> {
    jar.values.clear();
    jar.values.set('daftar_admin_rt', TOKEN);
    jar.values.set('daftar_admin_csrf', 'c');
    vi.stubGlobal('fetch', () => Promise.resolve().then(answer));
    const m: unknown = await import(root('admin', 'src/app/api/auth/refresh/route.ts'));
    const post = isObject(m) ? m['POST'] : undefined;
    if (typeof post !== 'function') throw new Error('admin refresh route exports no POST');
    const res: unknown = await post(new Request('http://admin.test/api/auth/refresh', { method: 'POST', headers: { 'x-daftar-csrf': 'c' } }));
    if (!(res instanceof Response)) throw new Error('admin refresh did not answer with a Response');
    return res;
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('429 stays 429 with the API’s Retry-After; the cookie stays', async () => {
    const res = await refreshWith(() => json(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '42' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(jar.values.get('daftar_admin_rt')).toBe(TOKEN);
  });

  it.each([
    ['503', () => json(503, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '5' })],
    ['500', () => json(500, {})],
    ['502 not JSON', () => new Response('<html>', { status: 502 })],
    ['unreachable', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s answers 503 with Retry-After; the cookie stays', async (_label, answer) => {
    const res = await refreshWith(answer);
    expect(res.status).toBe(503);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(jar.values.get('daftar_admin_rt')).toBe(TOKEN);
  });

  it.each([
    ['401', () => json(401, { error: { code: 'TOKEN_REUSE_DETECTED' } })],
    ['400', () => json(400, { error: { code: 'VALIDATION_FAILED' } })],
    ['2xx without a successor', () => json(200, { accessToken: 'at' })],
  ])('%s clears the cookie and answers 401', async (_label, answer) => {
    const res = await refreshWith(answer);
    expect(res.status).toBe(401);
    expect(jar.values.has('daftar_admin_rt')).toBe(false);
  });
});
