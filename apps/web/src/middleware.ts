import { NextResponse, type NextRequest } from 'next/server';
import { createNonce, pageCsp } from '@/lib/csp';

const LOCALES = ['ar', 'en', 'tr'] as const;
const DEFAULT_LOCALE = 'ar';
const CSP = 'Content-Security-Policy';

/**
 * Locale routing, and the per-request CSP nonce (`@/lib/csp`): the policy goes
 * on the request, where Next reads the nonce and stamps its scripts with it,
 * and on the response, where the browser enforces it.
 */
export function middleware(req: NextRequest) {
  const nonce = createNonce();
  const policy = pageCsp(nonce, { production: process.env.NODE_ENV === 'production' });
  const withPolicy = (res: NextResponse): NextResponse => {
    res.headers.set(CSP, policy);
    return res;
  };

  const { pathname } = req.nextUrl;
  const hasLocale = LOCALES.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`));
  if (hasLocale || pathname.includes('.')) {
    const headers = new Headers(req.headers);
    headers.set('x-nonce', nonce);
    headers.set(CSP, policy);
    return withPolicy(NextResponse.next({ request: { headers } }));
  }
  const accept = req.headers.get('accept-language') ?? '';
  const preferred = LOCALES.find((l) => accept.toLowerCase().startsWith(l)) ?? DEFAULT_LOCALE;
  const url = req.nextUrl.clone();
  url.pathname = `/${preferred}${pathname === '/' ? '' : pathname}`;
  return withPolicy(NextResponse.redirect(url));
}

// Every page and public file; the BFF routes (`/api`) and Next's own assets
// (`/_next`) carry the static policy of next.config.mjs instead.
export const config = { matcher: ['/((?!_next|api).*)'] };
