import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '../../../../lib/api';
import { CSRF_COOKIE, RT_COOKIE, csrfCookieOptions, rtCookieOptions } from '../../../../lib/cookies';
import { clientAddressHeaders, retryAfterHeaders, upstreamJson } from '../../../../lib/bff-upstream';
import { randomBytes } from 'node:crypto';

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string; displayName?: string; preferredLocale?: string };
  const res = await fetch(`${API_URL}/v1/auth/register`, {
    method: 'POST',
    // TD-19: the API limits registration per client address; it learns it from the chain.
    headers: { 'content-type': 'application/json', ...clientAddressHeaders(req) },
    body: JSON.stringify(body),
  });
  const data = await upstreamJson(res);
  const accessToken = data?.['accessToken'];
  const refreshToken = data?.['refreshToken'];
  if (!res.ok || typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    return NextResponse.json({ error: data?.['error'] ?? 'REGISTER_FAILED' }, { status: res.ok ? 502 : res.status, headers: retryAfterHeaders(res) });
  }
  const jar = await cookies();
  jar.set(RT_COOKIE, refreshToken, rtCookieOptions(30 * 24 * 3600));
  jar.set(CSRF_COOKIE, randomBytes(16).toString('hex'), csrfCookieOptions());
  return NextResponse.json({ accessToken, expiresInSeconds: data?.['expiresInSeconds'] });
}
