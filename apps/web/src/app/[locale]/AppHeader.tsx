'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BusinessSummaryDto } from '@daftar/shared-contracts';
import { Button, Card, Dropdown, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { currentBusinessId, logout, setCurrentBusinessId } from '@/lib/client';
import { getMyBusinesses } from '@/lib/merchant-api';

const NAV = [
  { key: 'dashboard', path: 'dashboard' },
  { key: 'catalog', path: 'catalog' },
  { key: 'team', path: 'team' },
  { key: 'structure', path: 'structure' },
  { key: 'roles', path: 'roles' },
  { key: 'plan', path: 'plan' },
  { key: 'settings', path: 'settings' },
  { key: 'security', path: 'security' },
] as const;

/**
 * App header with the BUSINESS SWITCHER (Directive §62 "Business switch"):
 * every business the user is a member of, from /me/businesses; switching
 * changes the X-Business-Id context and reloads the current page.
 */
export function AppHeader({ locale, active }: { locale: Locale; active: string }) {
  const t = makeT(locale);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [businesses, setBusinesses] = useState<BusinessSummaryDto[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    setCurrent(currentBusinessId());
    getMyBusinesses()
      .then((r) => setBusinesses(r.items))
      .catch(() => setBusinesses([]));
  }, []);

  const currentName = businesses.find((b) => b.businessId === current)?.name ?? t('nav.switchBusiness');

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
        flexWrap: 'wrap',
      }}
    >
      <strong style={{ color: colors.brand.primary, fontSize: typography.size.lg }}>{t('app.name')}</strong>
      <nav style={{ display: 'flex', gap: spacing[1], flex: 1, flexWrap: 'wrap' }}>
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
            {currentName}
          </Button>
        }
        items={[
          ...businesses.map((b) => ({
            key: b.businessId,
            label: b.businessId === current ? `✓ ${b.name}` : b.name,
            onSelect: () => {
              setCurrentBusinessId(b.businessId);
              setCurrent(b.businessId);
              window.location.reload();
            },
          })),
          { key: 'new', label: t('nav.createBusiness'), onSelect: () => router.push(`/${locale}/businesses/new`) },
        ]}
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
