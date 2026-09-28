import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '../../../../lib/api';
import { CSRF_COOKIE, RT_COOKIE, rtCookieOptions } from '../../../../lib/cookies';
import { clientAddressHeaders, retryAfterHeaders, upstreamJson } from '../../../../lib/bff-upstream';

/**
 * Refresh-token rotation through the BFF (ADR-001), TD-19.
 *
 * The refresh cookie is the session. It is deleted only when the API refused
 * the credential itself — 401 (`UNAUTHENTICATED` for a token it does not
 * know, `TOKEN_REUSE_DETECTED` once reuse revoked the family) or 400 (a
 * cookie that fails the token schema and can never succeed) — or when the API
 * rotated it (2xx) but the successor cannot be read: the old token is then
 * consumed, and presenting it again would only trip reuse detection.
 *
 * Everything else is retryable and keeps the cookie: a 429 stays a 429 with
 * the API's Retry-After, and an unreachable or failing API (network error,
 * 5xx, any other status) answers 503 with a Retry-After. A rate limit or an
 * outage never logs the user out.
 */
const RETRY_AFTER_UNAVAILABLE = '5';

const retryable = (status: 429 | 503, error: string, retryAfter: Record<string, string>) =>
  NextResponse.json({ error }, { status, headers: { 'retry-after': RETRY_AFTER_UNAVAILABLE, ...retryAfter } });

export async function POST(req: Request) {
  const jar = await cookies();
  const rt = jar.get(RT_COOKIE)?.value;
  if (!rt) return NextResponse.json({ error: 'NO_SESSION' }, { status: 401 });
  // CSRF double-submit: the header must match the readable cookie.
  const header = req.headers.get('x-daftar-csrf');
  const csrfCookie = jar.get(CSRF_COOKIE)?.value;
  if (!header || !csrfCookie || header !== csrfCookie) {
    return NextResponse.json({ error: 'CSRF' }, { status: 403 });
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...clientAddressHeaders(req) },
      body: JSON.stringify({ refreshToken: rt }),
    });
  } catch (e: unknown) {
    // undici rejects an unreachable upstream with a TypeError; nothing was
    // consumed, so the cookie is still the session.
    if (e instanceof TypeError) return retryable(503, 'REFRESH_UNAVAILABLE', {});
    throw e;
  }
  if (res.status === 429) return retryable(429, 'RATE_LIMITED', retryAfterHeaders(res));
  if (res.status === 400 || res.status === 401) {
    jar.delete(RT_COOKIE);
    return NextResponse.json({ error: 'REFRESH_FAILED' }, { status: 401 });
  }
  if (!res.ok) return retryable(503, 'REFRESH_UNAVAILABLE', retryAfterHeaders(res));
  let data: Record<string, unknown> | null;
  try {
    data = await upstreamJson(res);
  } catch (e: unknown) {
    if (!(e instanceof TypeError)) throw e;
    data = null; // the body broke off after the API rotated the token
  }
  const accessToken = data?.['accessToken'];
  const refreshToken = data?.['refreshToken'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    jar.delete(RT_COOKIE);
    return NextResponse.json({ error: 'REFRESH_FAILED' }, { status: 401 });
  }
  jar.set(RT_COOKIE, refreshToken, rtCookieOptions(30 * 24 * 3600)); // rotation
  return NextResponse.json({ accessToken, expiresInSeconds: data?.['expiresInSeconds'] });
}
