import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_URL } from '@/lib/api';
import { CSRF_COOKIE, RT_COOKIE } from '@/lib/cookies';

export async function POST(req: Request) {
  const jar = await cookies();
  const rt = jar.get(RT_COOKIE)?.value;
  const header = req.headers.get('x-daftar-csrf');
  const csrfCookie = jar.get(CSRF_COOKIE)?.value;
  if (rt) {
    if (!header || !csrfCookie || header !== csrfCookie) {
      return NextResponse.json({ error: 'CSRF' }, { status: 403 });
    }
    const auth = req.headers.get('authorization');
    await fetch(`${API_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ refreshToken: rt }),
    }).catch(() => undefined);
  }
  jar.delete(RT_COOKIE);
  jar.delete(CSRF_COOKIE);
  return NextResponse.json({ ok: true });
}
