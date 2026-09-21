/** Admin BFF session cookies — same discipline as the merchant app (ADR-001). */
export const RT_COOKIE = 'daftar_admin_rt';
export const CSRF_COOKIE = 'daftar_admin_csrf';

const isProd = process.env.NODE_ENV === 'production';

export function rtCookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: isProd, path: '/api/auth', maxAge: maxAgeSeconds };
}

export function csrfCookieOptions() {
  return { httpOnly: false, sameSite: 'lax' as const, secure: isProd, path: '/' };
}
