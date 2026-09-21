import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '@/lib/api';
import { CSRF_COOKIE, RT_COOKIE, csrfCookieOptions, rtCookieOptions } from '@/lib/cookies';
import { randomBytes } from 'node:crypto';

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresInSeconds?: number; error?: unknown };
  if (!res.ok || !data.accessToken || !data.refreshToken) {
    return NextResponse.json({ error: data.error ?? 'LOGIN_FAILED' }, { status: res.status });
  }
  const jar = await cookies();
  // Refresh token lives ONLY in an HttpOnly cookie scoped to /api/auth.
  jar.set(RT_COOKIE, data.refreshToken, rtCookieOptions(30 * 24 * 3600));
  jar.set(CSRF_COOKIE, randomBytes(16).toString('hex'), csrfCookieOptions());
  // Access token goes to JS memory (never localStorage).
  return NextResponse.json({ accessToken: data.accessToken, expiresInSeconds: data.expiresInSeconds });
}
