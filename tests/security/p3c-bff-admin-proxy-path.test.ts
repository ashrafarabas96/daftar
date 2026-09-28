import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * The admin console's BFF proxy gets the web proxy's path safety (security
 * review L-1, Phase 3 corrective follow-up). Next hands the catch-all segments
 * over DECODED, so `%2F`, `%3F`, `%23`, `%5C` and `..` inside a segment would
 * otherwise steer an operator's request — with the operator's own token — to
 * another platform route. A segment that is empty, `.` or `..`, or holds `/`,
 * `\`, `?`, `#` or a control character is refused with 400 and nothing is
 * sent; every other segment is re-encoded and the target stays under `/v1/`.
 *
 * Loaded at run time by path: the admin app has no runner of its own.
 */
vi.mock('server-only', () => ({}));

type Proxy = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;
async function proxy(method: 'GET' | 'POST'): Promise<Proxy> {
  const m: unknown = await import(fileURLToPath(new URL('../../apps/admin/src/app/api/proxy/[...path]/route.ts', import.meta.url)));
  const fn = isObject(m) ? m[method] : undefined;
  if (typeof fn !== 'function') throw new Error(`admin proxy exports no ${method}`);
  return async (req, ctx) => {
    const res: unknown = await fn(req, ctx);
    if (!(res instanceof Response)) throw new Error('admin proxy did not answer with a Response');
    return res;
  };
}

const sent: string[] = [];
function stubUpstream(): void {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    sent.push(String(input));
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  });
}
const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => {
  sent.length = 0;
  vi.unstubAllGlobals();
});

describe('admin BFF proxy path safety (L-1)', () => {
  it.each([
    ['an encoded slash with ..', ['admin', 'businesses', '../users/x', 'suspend']],
    ['a path that climbs out of /v1 and swallows the suffix into a query', ['admin', '../../auth/logout-all?z=', 'x']],
    ['an encoded question mark', ['admin', 'businesses', 'x?status=all', 'suspend']],
    ['an encoded fragment', ['admin', 'businesses', 'x#frag', 'y']],
    ['an encoded backslash', ['admin', '..\\auth', 'y']],
    ['a lone ..', ['admin', '..', 'auth']],
    ['a lone .', ['admin', '.', 'businesses']],
    ['an empty segment', ['admin', '', 'businesses']],
    ['a control character', ['admin', 'x\u0000', 'businesses']],
    ['no segment at all', []],
  ])('refuses %s with 400 and sends nothing upstream', async (_name, path) => {
    stubUpstream();
    const post = await proxy('POST');
    const res = await post(new Request('http://admin.test/api/proxy/x', { method: 'POST', body: '{}' }), ctx(path));
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('re-encodes an ordinary segment, so it stays one segment under /v1, and keeps the query', async () => {
    stubUpstream();
    const get = await proxy('GET');
    const res = await get(new Request('http://admin.test/api/proxy/admin/businesses/a%20b?page=2'), ctx(['admin', 'businesses', 'a b']));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0] ?? '');
    expect(url.pathname).toBe('/v1/admin/businesses/a%20b');
    expect(url.search).toBe('?page=2');
  });
});
