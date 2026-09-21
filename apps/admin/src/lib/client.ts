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

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'x-daftar-csrf': readCsrfCookie() ?? '' } });
    if (!res.ok) {
      accessToken = null;
      return false;
    }
    const data = (await res.json()) as { accessToken: string };
    accessToken = data.accessToken;
    return true;
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
