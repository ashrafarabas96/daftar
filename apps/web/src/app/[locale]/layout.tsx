import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { DaftarProvider } from '@daftar/design-system';
// The tokens entry, not the package root: the root is a client module, and a
// server component reading its objects would get client references.
import { colors, typography } from '@daftar/design-system/tokens';
import { isLocale, dirOf } from '@/lib/i18n';
import { SessionNotice } from './SessionNotice';

// Every page carries a per-request CSP nonce (src/middleware.ts), and Next can
// stamp its scripts with it only on a page rendered for that request: no page
// is prerendered at build time.
export const dynamic = 'force-dynamic';

export const metadata = { icons: { icon: '/favicon.svg' } };

// Next's typed routes hand the segment over as a plain string; anything outside
// the supported set is a 404, never a silent fallback.
export default async function LocaleLayout(props: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body style={{ margin: 0, background: colors.neutral[50], color: colors.neutral[900], fontFamily: typography.fontFamily.base }}>
        <DaftarProvider locale={locale}>
          {/* TD-19: shown only while a refresh waits out a rate limit or an outage. */}
          <SessionNotice locale={locale} />
          {props.children}
        </DaftarProvider>
      </body>
    </html>
  );
}
