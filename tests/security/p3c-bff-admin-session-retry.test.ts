import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * TD-19, admin console browser side: the console's `refreshSession()` waits
 * out a 429, a 5xx or a failed network and tries again, instead of resolving
 * `false` — which the console shell turns into a redirect to its login page.
 * A refused credential (401, 403) still resolves `false` at once.
 *
 * Loaded at run time by path: the admin app has no runner of its own, and a
 * static import would pull Next's global types into the root program.
 */

interface AdminClient {
  refreshSession: () => Promise<boolean>;
  sessionState?: () => { kind: string };
  retrySessionNow?: () => void;
}

const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;
async function loadClient(): Promise<AdminClient> {
  const m: unknown = await import(fileURLToPath(new URL('../../apps/admin/src/lib/client.ts', import.meta.url)));
  if (!isObject(m) || typeof m['refreshSession'] !== 'function') throw new Error('admin client exports no refreshSession');
  const refreshSession = m['refreshSession'];
  const sessionState = m['sessionState'];
  const retrySessionNow = m['retrySessionNow'];
  return {
    refreshSession: async () => {
      const ok: unknown = await refreshSession();
      if (typeof ok !== 'boolean') throw new Error('refreshSession did not resolve a boolean');
      return ok;
    },
    ...(typeof sessionState === 'function'
      ? {
          sessionState: () => {
            const s: unknown = sessionState();
            if (!isObject(s) || typeof s['kind'] !== 'string') throw new Error('sessionState() is not a state');
            return { kind: s['kind'] };
          },
        }
      : {}),
    ...(typeof retrySessionNow === 'function' ? { retrySessionNow: () => void retrySessionNow() } : {}),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let calls = 0;
function stubRefresh(answers: (() => Response | Promise<Response>)[]): void {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    if (String(input) !== '/api/auth/refresh') throw new Error(`unexpected fetch ${String(input)}`);
    calls += 1;
    const next = answers.shift();
    if (!next) throw new Error('no more refresh answers');
    return Promise.resolve().then(next);
  });
}

let client: AdminClient;

beforeEach(async () => {
  calls = 0;
  client = await loadClient();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TD-19 admin console: a rate-limited or unavailable refresh keeps the operator signed in', () => {
  it.each([
    ['429', () => json(429, { error: 'RATE_LIMITED' }, { 'retry-after': '2' })],
    ['503', () => json(503, { error: 'REFRESH_UNAVAILABLE' }, { 'retry-after': '2' })],
    ['no network', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s, then success: refreshSession resolves true, never false', async (_label, first) => {
    stubRefresh([first, () => json(200, { accessToken: 'fresh' })]);
    const settled: boolean[] = [];
    const pending = client.refreshSession().then((ok) => {
      settled.push(ok);
      return ok;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toEqual([]);
    expect(client.sessionState?.().kind).toBe('retrying');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(true);
    expect(calls).toBe(2);
    expect(client.sessionState?.().kind).toBe('ok');
  });

  it('Try again ends the wait at once', async () => {
    stubRefresh([() => json(429, {}, { 'retry-after': '200' }), () => json(200, { accessToken: 'fresh' })]);
    const pending = client.refreshSession();
    await vi.advanceTimersByTimeAsync(10);
    client.retrySessionNow?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe(true);
  });

  it.each([
    ['401', () => json(401, { error: 'REFRESH_FAILED' })],
    ['403', () => json(403, { error: 'CSRF' })],
  ])('%s resolves false at once', async (_label, answer) => {
    stubRefresh([answer]);
    expect(await client.refreshSession()).toBe(false);
    expect(calls).toBe(1);
  });
});
