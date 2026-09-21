/**
 * BFF session cookies (ADR-001).
 * - daftar_rt: HttpOnly refresh-token cookie, path-scoped to /api/auth so it
 *   is never sent to the merchant API nor readable from JS (no refresh token
 *   in localStorage, ever).
 * - daftar_csrf: readable double-submit token; the BFF refresh/logout routes
 *   require the x-daftar-csrf header to match.
 */
export const RT_COOKIE = 'daftar_rt';
export const CSRF_COOKIE = 'daftar_csrf';

const isProd = process.env.NODE_ENV === 'production';

export function rtCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd,
    path: '/api/auth',
    maxAge: maxAgeSeconds,
  };
}

export function csrfCookieOptions() {
  return {
    httpOnly: false,
    sameSite: 'lax' as const,
    secure: isProd,
    path: '/',
  };
}
