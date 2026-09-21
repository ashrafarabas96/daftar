'use client';
/**
 * Browser-side API client (ADR-001):
 * - access token lives in module memory ONLY (never localStorage/cookies),
 * - refresh goes through the BFF with the CSRF double-submit header,
 * - business context travels in the X-Business-Id header,
 * - mutations send an Idempotency-Key.
 */

let accessToken: string | null = null;
let csrfToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)daftar_csrf=([^;]+)/);
  return m?.[1] ?? null;
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    csrfToken = readCsrfCookie();
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'x-daftar-csrf': csrfToken ?? '' },
    });
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

const BUSINESS_KEY = 'daftar_business_id';

export function currentBusinessId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(BUSINESS_KEY);
}

export function setCurrentBusinessId(id: string): void {
  window.localStorage.setItem(BUSINESS_KEY, id);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  // FormData (media upload) sets its own multipart boundary; everything else is JSON.
  if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const businessId = currentBusinessId();
  if (businessId) headers.set('x-business-id', businessId);
  if (init.method && init.method !== 'GET') {
    headers.set('idempotency-key', crypto.randomUUID());
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && retry) {
    const ok = await refreshSession();
    if (ok) return apiFetch<T>(path, init, false);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string } };
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? `HTTP_${res.status}`);
  }
  return data;
}

export async function logout(): Promise<void> {
  csrfToken = readCsrfCookie();
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: {
      'x-daftar-csrf': csrfToken ?? '',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  }).catch(() => undefined);
  accessToken = null;
}
