import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { API_URL } from '../../../../lib/api';
import { CSRF_COOKIE, RT_COOKIE, csrfCookieOptions, rtCookieOptions } from '../../../../lib/cookies';
import { clientAddressHeaders, retryAfterHeaders, upstreamJson } from '../../../../lib/bff-upstream';

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    // TD-19: the API limits login per client address; it learns it from the chain.
    headers: { 'content-type': 'application/json', ...clientAddressHeaders(req) },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });
  const data = await upstreamJson(res);
  const accessToken = data?.['accessToken'];
  const refreshToken = data?.['refreshToken'];
  if (!res.ok || typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    return NextResponse.json({ error: data?.['error'] ?? 'LOGIN_FAILED' }, { status: res.ok ? 502 : res.status, headers: retryAfterHeaders(res) });
  }
  const jar = await cookies();
  jar.set(RT_COOKIE, refreshToken, rtCookieOptions(8 * 3600)); // shorter admin session
  jar.set(CSRF_COOKIE, randomBytes(16).toString('hex'), csrfCookieOptions());
  return NextResponse.json({ accessToken, expiresInSeconds: data?.['expiresInSeconds'] });
}
