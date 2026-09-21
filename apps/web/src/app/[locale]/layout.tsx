import type { ReactNode } from 'react';
import { DaftarProvider } from '@daftar/design-system';
import { dirOf, LOCALES, type Locale } from '@/lib/i18n';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout(props: { children: ReactNode; params: Promise<{ locale: Locale }> }) {
  const { locale } = await props.params;
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body style={{ margin: 0, background: '#F9FAFB' }}>
        <DaftarProvider locale={locale}>{props.children}</DaftarProvider>
      </body>
    </html>
  );
}
