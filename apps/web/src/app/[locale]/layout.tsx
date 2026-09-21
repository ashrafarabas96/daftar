import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { DaftarProvider } from '@daftar/design-system';
import { dirOf, isLocale, LOCALES } from '@/lib/i18n';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

// Next's typed routes hand the segment over as a plain string; anything outside
// the supported set is a 404, never a silent fallback.
export default async function LocaleLayout(props: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body style={{ margin: 0, background: '#F9FAFB' }}>
        <DaftarProvider locale={locale}>{props.children}</DaftarProvider>
      </body>
    </html>
  );
}
