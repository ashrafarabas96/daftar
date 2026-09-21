import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { API_URL } from '@/lib/api';
import { CSRF_COOKIE, RT_COOKIE, csrfCookieOptions, rtCookieOptions } from '@/lib/cookies';

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
  jar.set(RT_COOKIE, data.refreshToken, rtCookieOptions(8 * 3600)); // shorter admin session
  jar.set(CSRF_COOKIE, randomBytes(16).toString('hex'), csrfCookieOptions());
  return NextResponse.json({ accessToken: data.accessToken, expiresInSeconds: data.expiresInSeconds });
}
