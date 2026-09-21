'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Dropdown, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { logout } from '@/lib/client';

const NAV = [
  { key: 'dashboard', path: 'dashboard' },
  { key: 'catalog', path: 'catalog' },
  { key: 'team', path: 'team' },
  { key: 'plan', path: 'plan' },
  { key: 'settings', path: 'settings' },
  { key: 'security', path: 'security' },
] as const;

export function AppHeader({ locale, active }: { locale: Locale; active: string }) {
  const t = makeT(locale);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing[4],
        padding: `0 ${spacing[4]}`,
        minHeight: '3.5rem',
        background: colors.neutral[0],
        borderBottom: `1px solid ${colors.neutral[200]}`,
        fontFamily: typography.fontFamily.base,
      }}
    >
      <strong style={{ color: colors.brand.primary, fontSize: typography.size.lg }}>{t('app.name')}</strong>
      <nav style={{ display: 'flex', gap: spacing[1], flex: 1 }}>
        {NAV.map((item) => (
          <a
            key={item.key}
            href={`/${locale}/${item.path}`}
            aria-current={active === item.key ? 'page' : undefined}
            style={{
              padding: `${spacing[2]} ${spacing[3]}`,
              borderRadius: '0.5rem',
              textDecoration: 'none',
              color: active === item.key ? colors.brand.primary : colors.neutral[600],
              fontWeight: active === item.key ? 600 : 400,
              fontSize: typography.size.sm,
            }}
          >
            {t(`nav.${item.key}`)}
          </a>
        ))}
      </nav>
      <Dropdown
        trigger={
          <Button variant="secondary" size="sm">
            {t('nav.switchBusiness')}
          </Button>
        }
        items={[{ key: 'switch', label: t('nav.switchBusiness'), onSelect: () => router.push(`/${locale}/dashboard`) }]}
      />
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await logout();
          router.push(`/${locale}/login`);
        }}
      >
        {t('nav.logout')}
      </Button>
    </header>
  );
}

export function PageShell(props: { locale: Locale; active: string; children: React.ReactNode }) {
  return (
    <>
      <AppHeader locale={props.locale} active={props.active} />
      <main style={{ maxWidth: '64rem', margin: '0 auto', padding: spacing[6] }}>
        <Card>{props.children}</Card>
      </main>
    </>
  );
}
