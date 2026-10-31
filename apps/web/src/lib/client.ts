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
 * Whether the page can currently reach its session (TD-19), for the retry
 * notice every page shows (`SessionNotice` in the locale layout).
 *
 * `retrying` means the refresh was rate-limited (429), the BFF or the API was
 * unavailable (5xx), or the network failed: the refresh cookie is intact and
 * the user is still signed in, so the refresh is tried again at `retryAt`.
 */
export type SessionState = { readonly kind: 'ok' } | { readonly kind: 'retrying'; readonly retryAt: number };

const SESSION_OK: SessionState = { kind: 'ok' };
let session: SessionState = SESSION_OK;
const sessionListeners = new Set<() => void>();
let wakeRefresh: (() => void) | null = null;

/** Seconds to wait when a retryable answer carries no usable Retry-After. */
const DEFAULT_RETRY_SECONDS = 5;
/** The longest wait honoured: the API's limit windows are five minutes. */
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

/** Wait `ms`, or less if the notice's "Try again" is pressed. */
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

/** One refresh request; null when it never reached the BFF (offline, connection reset). */
async function refreshOnce(): Promise<Response | null> {
  csrfToken = readCsrfCookie();
  try {
    return await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'x-daftar-csrf': csrfToken ?? '' },
      // Should the page be left while the rotation is in flight, the browser
      // still completes it and keeps the rotated cookie (D-2).
      keepalive: true,
    });
  } catch (e: unknown) {
    // fetch rejects with a TypeError when the request could not be made.
    if (e instanceof TypeError) return null;
    throw e;
  }
}

/**
 * Trade the refresh cookie for a fresh access token, through the BFF.
 *
 * The refresh token is single-use (the API rotates it, and a second use of the
 * same token revokes the whole session). So every caller in this page that
 * asks while a refresh is in flight shares that ONE request: the header, the
 * page and a 401 retry never send the same token twice.
 *
 * TD-19: a 429, a 5xx or a failed network is not a lost session — the BFF
 * kept the cookie. The refresh waits (the answer's Retry-After, at most five
 * minutes; the notice lets the user try sooner) and tries again, so a page
 * never sends a signed-in user to the login screen because of a rate limit or
 * an outage. Only a refused credential (401, or 403 when the CSRF pair is
 * missing) resolves `false`.
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
 *
 * `sellingCode` was MISSING from this list until P4-S3, and its absence made
 * every `sale.*` and `pos.*` refusal render the generic "your data is safe"
 * fallback: the API sets `details.sellingCode` on all six status arms
 * (`apps/api/src/modules/selling/selling-errors.ts:473`), `domainCode`
 * returned null because no field here named it, `refusalCode` then fell back
 * to the envelope code, and `error.CONFLICT` is not a catalogue key. So the
 * whole `error.sale.*` family shipped with P4-S2 and the whole `error.pos.*`
 * family were dead strings — present, translated, asserted by a guard that
 * reads the catalogues, and unreachable on a screen.
 *
 * That is why `apps/web/test/domain-code-fields.test.ts` derives this list's
 * required contents from the API's own detail-field names rather than checking
 * the one code that was missing. A list of strings kept by hand beside a
 * growing set of namespaces goes stale silently, and the only symptom is a
 * cashier being told nothing.
 */
// P4-S4 adds `receivablesCode`: the field
// `apps/api/src/modules/receivables/receivables-errors.ts` attaches to every
// customer-payment and customer-credit refusal. A field the API attaches and
// this list omits makes its whole code family a dead string — the P4-S2 defect
// `test/domain-code-fields.test.ts` derives this list against.
const DOMAIN_CODE_FIELDS = ['inventoryCode', 'purchasingCode', 'paymentMethodCode', 'catalogCode', 'sellingCode', 'receivablesCode'] as const;

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
