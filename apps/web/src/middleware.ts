import { NextResponse, type NextRequest } from 'next/server';

const LOCALES = ['ar', 'en', 'tr'] as const;
const DEFAULT_LOCALE = 'ar';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next') || pathname.includes('.')) {
    return NextResponse.next();
  }
  const hasLocale = LOCALES.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`));
  if (hasLocale) return NextResponse.next();
  const accept = req.headers.get('accept-language') ?? '';
  const preferred = LOCALES.find((l) => accept.toLowerCase().startsWith(l)) ?? DEFAULT_LOCALE;
  const url = req.nextUrl.clone();
  url.pathname = `/${preferred}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!_next|api).*)'] };
