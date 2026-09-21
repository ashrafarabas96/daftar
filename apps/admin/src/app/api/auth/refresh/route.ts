import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '@/lib/api';
import { CSRF_COOKIE, RT_COOKIE, rtCookieOptions } from '@/lib/cookies';

export async function POST(req: Request) {
  const jar = await cookies();
  const rt = jar.get(RT_COOKIE)?.value;
  if (!rt) return NextResponse.json({ error: 'NO_SESSION' }, { status: 401 });
  const header = req.headers.get('x-daftar-csrf');
  const csrfCookie = jar.get(CSRF_COOKIE)?.value;
  if (!header || !csrfCookie || header !== csrfCookie) {
    return NextResponse.json({ error: 'CSRF' }, { status: 403 });
  }
  const res = await fetch(`${API_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  });
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresInSeconds?: number };
  if (!res.ok || !data.accessToken || !data.refreshToken) {
    jar.delete(RT_COOKIE);
    return NextResponse.json({ error: 'REFRESH_FAILED' }, { status: 401 });
  }
  jar.set(RT_COOKIE, data.refreshToken, rtCookieOptions(8 * 3600));
  return NextResponse.json({ accessToken: data.accessToken, expiresInSeconds: data.expiresInSeconds });
}
