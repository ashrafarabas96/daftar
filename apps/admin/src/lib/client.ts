'use client';
/** Admin browser client: in-memory access token, BFF refresh, platform API only. */

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)daftar_admin_csrf=([^;]+)/);
  return m?.[1] ?? null;
}

/**
 * Whether the console can currently reach its session (TD-19), for the
 * shell's retry notice. `retrying`: the refresh was rate-limited (429), the
 * BFF or API was unavailable (5xx) or the network failed; the refresh cookie
 * is intact, and the refresh is tried again at `retryAt`.
 */
export type SessionState = { readonly kind: 'ok' } | { readonly kind: 'retrying'; readonly retryAt: number };

const SESSION_OK: SessionState = { kind: 'ok' };
let session: SessionState = SESSION_OK;
const sessionListeners = new Set<() => void>();
let wakeRefresh: (() => void) | null = null;
const DEFAULT_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 300;

export function sessionState(): SessionState {
  return session;
}

export function subscribeSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

/** The notice's "Try again": end the current wait and refresh now. */
export function retrySessionNow(): void {
  wakeRefresh?.();
}

function setSession(next: SessionState): void {
  if (next.kind === 'ok' && session.kind === 'ok') return;
  session = next;
  for (const listener of [...sessionListeners]) listener();
}

function retryDelaySeconds(res: Response | null): number {
  const header = res?.headers.get('retry-after') ?? null;
  const seconds = header !== null && /^\d{1,6}$/.test(header) ? Number(header) : DEFAULT_RETRY_SECONDS;
  return Math.min(Math.max(seconds, 1), MAX_RETRY_SECONDS);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      wakeRefresh = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeRefresh = done;
  });
}

async function refreshOnce(): Promise<Response | null> {
  try {
    return await fetch('/api/auth/refresh', { method: 'POST', headers: { 'x-daftar-csrf': readCsrfCookie() ?? '' } });
  } catch (e: unknown) {
    // fetch rejects with a TypeError when the request could not be made.
    if (e instanceof TypeError) return null;
    throw e;
  }
}

/**
 * One shared refresh for every caller. TD-19: a 429, a 5xx or a failed
 * network waits (Retry-After, at most five minutes) and tries again; only a
 * refused credential (401, 403) resolves `false`, which sends the operator
 * to the login page.
 */
export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    for (;;) {
      const res = await refreshOnce();
      if (res === null || res.status === 429 || res.status >= 500) {
        const seconds = retryDelaySeconds(res);
        setSession({ kind: 'retrying', retryAt: Date.now() + seconds * 1000 });
        await pause(seconds * 1000);
        continue;
      }
      setSession(SESSION_OK);
      if (!res.ok) {
        accessToken = null;
        return false;
      }
      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return true;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (init.method && init.method !== 'GET') headers.set('idempotency-key', crypto.randomUUID());
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && retry) {
    const ok = await refreshSession();
    if (ok) return apiFetch<T>(path, init, false);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string } };
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? `HTTP_${res.status}`);
  return data;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'x-daftar-csrf': readCsrfCookie() ?? '', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
  }).catch(() => undefined);
  accessToken = null;
}
