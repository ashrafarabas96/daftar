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

/**
 * Trade the refresh cookie for a fresh access token, through the BFF.
 *
 * The refresh token is single-use (the API rotates it, and a second use of the
 * same token revokes the whole session). So every caller in this page that
 * asks while a refresh is in flight shares that ONE request: the header, the
 * page and a 401 retry never send the same token twice.
 */
export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    csrfToken = readCsrfCookie();
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'x-daftar-csrf': csrfToken ?? '' },
      // Should the page be left while the rotation is in flight, the browser
      // still completes it and keeps the rotated cookie (D-2).
      keepalive: true,
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

/**
 * The page's session: true at once when this page already holds an access
 * token (a client-side navigation keeps it in memory), otherwise one shared
 * refresh. Every page calls this on mount instead of refreshing again, so
 * moving between pages spends no refresh token (D-2).
 */
export async function ensureSession(): Promise<boolean> {
  if (accessToken) return true;
  return refreshSession();
}

/**
 * The domain-code fields a refusal may carry in `details`, in the order the
 * P3-S7 contract reads them (A-12(2), Annex R #12). An `accounting.*` code
 * travels as `details.code`, and only under the `ACCOUNTING_REFUSED` envelope
 * code; no payload carries an `accountingCode`.
 */
const DOMAIN_CODE_FIELDS = ['inventoryCode', 'purchasingCode', 'paymentMethodCode', 'catalogCode'] as const;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** The envelope's `details`, kept whole (P3-S7 A-12(2)). Phase 1 callers read only `status` and `code`. */
    public details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
  }

  /** The stable domain refusal code, or null when the refusal carries none. */
  get domainCode(): string | null {
    const details = this.details;
    if (!details) return null;
    for (const field of DOMAIN_CODE_FIELDS) {
      const value = details[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    if (this.code === 'ACCOUNTING_REFUSED') {
      const value = details['code'];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
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

/** The page's locale, as the root layout wrote it on `<html lang>`, or null outside a browser. */
function pageLanguage(): string | null {
  if (typeof document === 'undefined') return null;
  const lang = document.documentElement.lang;
  return lang.length > 0 ? lang : null;
}

function plainObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/**
 * Fetch through the BFF.
 *
 * A mutation carries an `Idempotency-Key`. When the caller set one it is the
 * caller's (P3-S7 A-12(2)): a form that must retry the same act — the fx-rate
 * entry of A-14 — owns its key and keeps it. Only when the caller set none is
 * a fresh one minted, and it is minted ONCE per call: the 401 refresh retry
 * re-sends the very same key, so a request the API applied before the token
 * expired is answered as a replay, never applied twice.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  // A call made before the page holds a token waits for the page's one
  // refresh instead of going out bare and coming back 401 (D-7). When there
  // is no session, the call still goes (a public endpoint needs none), and a
  // 401 is not refreshed a second time.
  let mayRefresh = retry;
  if (!accessToken && retry) mayRefresh = await refreshSession();
  const headers = new Headers(init.headers);
  // FormData (media upload) sets its own multipart boundary; everything else is JSON.
  if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const businessId = currentBusinessId();
  if (businessId) headers.set('x-business-id', businessId);
  const language = pageLanguage();
  if (language && !headers.has('accept-language')) headers.set('accept-language', language);
  if (init.method && init.method !== 'GET' && !headers.has('idempotency-key')) {
    headers.set('idempotency-key', crypto.randomUUID());
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && mayRefresh) {
    const ok = await refreshSession();
    // The retry carries these headers — and therefore this key — unchanged;
    // only the authorization is re-stamped with the refreshed token.
    if (ok) return apiFetch<T>(path, { ...init, headers }, false);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; details?: unknown } };
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? `HTTP_${res.status}`, plainObject(data.error?.details));
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
