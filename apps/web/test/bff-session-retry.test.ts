import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/lib/client';

/**
 * TD-19, browser side: a refresh the BFF answers 429 or 503 (or that never
 * reaches it) is not a lost session. `ensureSession()` waits for the retry
 * time and tries again instead of resolving `false` — which every page turns
 * into a redirect to the login screen — and the page's retry notice reads the
 * waiting state from `sessionState()`. Only a refused credential (401, or a
 * 403 CSRF answer) still resolves `false`.
 */

const { ensureSession, setAccessToken } = client;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let refreshCalls = 0;
function stubRefresh(answers: (() => Response | Promise<Response>)[]): void {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    if (String(input) !== '/api/auth/refresh') throw new Error(`unexpected fetch ${String(input)}`);
    refreshCalls += 1;
    const next = answers.shift();
    if (!next) throw new Error('no more refresh answers');
    return Promise.resolve().then(next);
  });
}

beforeEach(() => {
  refreshCalls = 0;
  setAccessToken(null);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('TD-19 a rate-limited or unavailable refresh keeps the user signed in', () => {
  it('429 then success: ensureSession resolves true after the Retry-After, never false', async () => {
    stubRefresh([() => json(429, { error: 'RATE_LIMITED' }, { 'retry-after': '2' }), () => json(200, { accessToken: 'fresh' })]);
    const settled: boolean[] = [];
    const pending = ensureSession().then((ok) => {
      settled.push(ok);
      return ok;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toEqual([]); // still waiting: no redirect to login
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(client.getAccessToken()).toBe('fresh');
  });

  it.each([
    ['503 from the BFF', () => json(503, { error: 'REFRESH_UNAVAILABLE' }, { 'retry-after': '5' })],
    ['a 500 from the BFF itself', () => json(500, {})],
    ['no network', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s, then success: ensureSession resolves true', async (_label, first) => {
    stubRefresh([first, () => json(200, { accessToken: 'fresh' })]);
    const pending = ensureSession();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(true);
    expect(refreshCalls).toBe(2);
  });

  it('while waiting, sessionState() says when the next try is, and retrySessionNow() tries at once', async () => {
    stubRefresh([() => json(429, { error: 'RATE_LIMITED' }, { 'retry-after': '120' }), () => json(200, { accessToken: 'fresh' })]);
    const seen: string[] = [];
    const unsubscribe = client.subscribeSession(() => seen.push(client.sessionState().kind));
    const pending = ensureSession();
    await vi.advanceTimersByTimeAsync(10);
    const waiting = client.sessionState();
    expect(waiting.kind).toBe('retrying');
    expect(waiting.kind === 'retrying' ? waiting.retryAt - Date.now() : 0).toBeGreaterThan(100_000);
    client.retrySessionNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe(true);
    expect(client.sessionState().kind).toBe('ok');
    expect(seen).toEqual(['retrying', 'ok']);
    unsubscribe();
  });

  it('the wait honours Retry-After up to five minutes, and a missing one waits a few seconds', async () => {
    stubRefresh([() => json(429, {}, { 'retry-after': '100000' }), () => json(503, {}), () => json(200, { accessToken: 'fresh' })]);
    const pending = ensureSession();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(refreshCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(true);
    expect(refreshCalls).toBe(3);
  });
});

describe('TD-19 a refused credential still ends the session', () => {
  it.each([
    ['401 REFRESH_FAILED', () => json(401, { error: 'REFRESH_FAILED' })],
    ['401 NO_SESSION', () => json(401, { error: 'NO_SESSION' })],
    ['403 CSRF', () => json(403, { error: 'CSRF' })],
  ])('%s resolves false at once, with no retry notice', async (_label, answer) => {
    stubRefresh([answer]);
    expect(await ensureSession()).toBe(false);
    expect(refreshCalls).toBe(1);
    expect(client.sessionState().kind).toBe('ok');
  });
});
