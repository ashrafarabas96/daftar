import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '../../../../lib/api';
import { CSRF_COOKIE, RT_COOKIE, rtCookieOptions } from '../../../../lib/cookies';
import { clientAddressHeaders, retryAfterHeaders, upstreamJson } from '../../../../lib/bff-upstream';

/**
 * Admin refresh-token rotation through the BFF (ADR-001), TD-19 — the same
 * contract as the merchant web app's refresh route.
 *
 * The refresh cookie is deleted only when the API refused the credential
 * itself (401, or 400 for a cookie that fails the token schema) or rotated it
 * (2xx) without a readable successor. A 429 stays a 429 with the API's
 * Retry-After; an unreachable or failing API answers 503 with a Retry-After;
 * both keep the cookie.
 */
const RETRY_AFTER_UNAVAILABLE = '5';

const retryable = (status: 429 | 503, error: string, retryAfter: Record<string, string>) =>
  NextResponse.json({ error }, { status, headers: { 'retry-after': RETRY_AFTER_UNAVAILABLE, ...retryAfter } });

export async function POST(req: Request) {
  const jar = await cookies();
  const rt = jar.get(RT_COOKIE)?.value;
  if (!rt) return NextResponse.json({ error: 'NO_SESSION' }, { status: 401 });
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
    // No response arrived: an unreachable API (nothing consumed) or a
    // connection lost after the API rotated the token (the cookie is then
    // consumed and the next refresh trips reuse detection) — the web
    // route's lost-answer case, a recorded technical debt.
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
  jar.set(RT_COOKIE, refreshToken, rtCookieOptions(8 * 3600));
  return NextResponse.json({ accessToken, expiresInSeconds: data?.['expiresInSeconds'] });
}
