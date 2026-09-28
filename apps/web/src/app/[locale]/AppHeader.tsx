'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BusinessSummaryDto } from '@daftar/shared-contracts';
import { Button, Card, Dropdown, IconButton, TOUCH_TARGET, breakpoints, colors, radius, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { currentBusinessId, logout, setCurrentBusinessId } from '@/lib/client';
import { getMyBusinesses } from '@/lib/merchant-api';
import { getInventoryAccess, type Phase3Permission } from '@/lib/phase3-api';

const NAV = [
  { key: 'dashboard', path: 'dashboard' },
  { key: 'catalog', path: 'catalog' },
  // P3-S7 (A-11): shown only to a member holding the matching view permission.
  { key: 'stock', path: 'stock', requires: 'inventory.view' },
  { key: 'purchases', path: 'purchases', requires: 'purchases.view' },
  { key: 'suppliers', path: 'suppliers', requires: 'suppliers.view' },
  { key: 'team', path: 'team' },
  { key: 'structure', path: 'structure' },
  { key: 'roles', path: 'roles' },
  { key: 'plan', path: 'plan' },
  { key: 'settings', path: 'settings' },
  { key: 'security', path: 'security' },
] as const satisfies readonly { key: string; path: string; requires?: Phase3Permission }[];

/**
 * Below the `lg` breakpoint the nav collapses behind a menu button (a phone
 * cannot hold eleven links in a row). A media query, not a width read in
 * script, so the server markup is already right; the classes are this
 * component's own. The button's inline `display` is overridden with
 * `!important` because an inline style otherwise wins over a class.
 */
const NAV_ID = 'daftar-app-nav';
const TOGGLE_ID = 'daftar-app-nav-toggle';
const HEADER_CSS = `
.daftar-header { gap: ${spacing[4]}; }
.daftar-nav { display: flex; flex: 1; flex-wrap: wrap; gap: ${spacing[1]}; min-width: 0; }
.daftar-header-actions { display: flex; align-items: center; gap: ${spacing[2]}; margin-inline-start: auto; }
.daftar-nav-toggle { display: none !important; }
@media (max-width: calc(${breakpoints.lg} - 0.02px)) {
  .daftar-header { gap: ${spacing[2]}; }
  .daftar-nav-toggle { display: inline-flex !important; }
  .daftar-nav { display: none; order: 1; flex-basis: 100%; flex-direction: column; padding-block-end: ${spacing[2]}; }
  .daftar-nav[data-open='true'] { display: flex; }
}
`;

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
  // The caller's own Phase 3 grants (GET /v1/inventory/access). Advisory: it
  // only hides links a member could not use; every read still enforces its own
  // authority. Until it answers, and when it fails, no Phase 3 link is shown.
  const [granted, setGranted] = useState<ReadonlySet<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  // A link followed from the open menu lands on a page with the menu closed.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Escape closes the open menu and gives focus back to its button.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      document.getElementById(TOGGLE_ID)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    setCurrent(currentBusinessId());
    getMyBusinesses()
      .then((r) => setBusinesses(r.items))
      .catch(() => setBusinesses([]));
    getInventoryAccess()
      .then((a) => setGranted(new Set(a.permissions)))
      .catch(() => setGranted(new Set()));
  }, []);

  const visibleNav = NAV.filter((item) => !('requires' in item) || granted.has(item.requires));

  const currentName = businesses.find((b) => b.businessId === current)?.name ?? t('nav.switchBusiness');

  return (
    <header
      className="daftar-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${spacing[4]}`,
        minHeight: '3.5rem',
        background: colors.neutral[0],
        borderBottom: `1px solid ${colors.neutral[200]}`,
        fontFamily: typography.fontFamily.base,
        flexWrap: 'wrap',
      }}
    >
      <style>{HEADER_CSS}</style>
      {/* First in the order: the open menu's links follow their button, at inline-start in either direction. */}
      <IconButton
        id={TOGGLE_ID}
        type="button"
        className="daftar-nav-toggle"
        aria-label={t('nav.menu')}
        aria-expanded={menuOpen}
        aria-controls={NAV_ID}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d={menuOpen ? 'M5 5l10 10M15 5L5 15' : 'M3 5h14M3 10h14M3 15h14'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </IconButton>
      <strong style={{ color: colors.brand.primary, fontSize: typography.size.lg }}>{t('app.name')}</strong>
      {/* In-app links are client navigations: the page keeps its access token in memory and spends no refresh token (D-2). */}
      <nav id={NAV_ID} className="daftar-nav" data-open={menuOpen ? 'true' : 'false'} aria-label={t('nav.menu')}>
        {visibleNav.map((item) => (
          <Link
            key={item.key}
            href={`/${locale}/${item.path}`}
            aria-current={active === item.key ? 'page' : undefined}
            onClick={() => setMenuOpen(false)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: TOUCH_TARGET,
              padding: `0 ${spacing[3]}`,
              borderRadius: radius.md,
              textDecoration: 'none',
              color: active === item.key ? colors.brand.primary : colors.neutral[600],
              fontWeight: active === item.key ? 600 : 400,
              fontSize: typography.size.sm,
            }}
          >
            {t(`nav.${item.key}`)}
          </Link>
        ))}
      </nav>
      <div className="daftar-header-actions">
        <Dropdown
          trigger={<Button variant="secondary">{currentName}</Button>}
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
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await logout();
            router.push(`/${locale}/login`);
          }}
        >
          {t('nav.logout')}
        </Button>
      </div>
    </header>
  );
}

export function PageShell(props: { locale: Locale; active: string; children: React.ReactNode }) {
  return (
    <>
      <AppHeader locale={props.locale} active={props.active} />
      <main style={{ maxWidth: '64rem', margin: '0 auto', padding: `${spacing[6]} ${spacing[4]}` }}>
        <Card>{props.children}</Card>
      </main>
    </>
  );
}
