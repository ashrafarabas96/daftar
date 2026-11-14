'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, Card, spacing, typography } from '@daftar/design-system';
import { useT } from '@/lib/i18n';
import { logout, refreshSession, retrySessionNow, sessionState, subscribeSession, type SessionState } from '@/lib/client';

const NAV = [
  { key: 'overview', label: 'nav.overview', path: '/' },
  { key: 'tenants', label: 'nav.tenants', path: '/tenants' },
  { key: 'businesses', label: 'nav.businesses', path: '/businesses' },
  { key: 'users', label: 'nav.users', path: '/users' },
  { key: 'plans', label: 'nav.plans', path: '/plans' },
  { key: 'overrides', label: 'nav.overrides', path: '/overrides' },
  { key: 'flags', label: 'nav.flags', path: '/flags' },
  { key: 'support-sessions', label: 'nav.supportSessions', path: '/support-sessions' },
  { key: 'audit', label: 'nav.audit', path: '/audit' },
  { key: 'operations', label: 'nav.operations', path: '/operations' },
] as const;

const SESSION_OK: SessionState = { kind: 'ok' };

/**
 * TD-19: while the console's refresh waits out a rate limit or an outage, say
 * so — the operator is still signed in — instead of a blank page or a
 * redirect to the login page. Text comes from the admin message catalogs (ar/en/tr).
 */
export function SessionRetryNotice({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing[3],
        margin: spacing[4],
        padding: spacing[3],
        background: '#FEF3C7',
        color: '#0F172A',
        borderInlineStart: '4px solid #D97706',
        borderRadius: '0.5rem',
        fontFamily: typography.fontFamily.base,
      }}
    >
      <span style={{ flex: '1 1 16rem' }}>{t('shell.retryNotice')}</span>
      <Button variant="secondary" onClick={onRetry}>
        {t('shell.retryAction')}
      </Button>
    </div>
  );
}

export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const router = useRouter();
  const t = useT();
  const [ready, setReady] = useState(false);
  const session = useSyncExternalStore(subscribeSession, sessionState, () => SESSION_OK);

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push('/login');
        return;
      }
      setReady(true);
    })();
  }, [router]);

  if (!ready) return session.kind === 'retrying' ? <SessionRetryNotice onRetry={retrySessionNow} /> : null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: typography.fontFamily.base }}>
      <aside
        style={{ width: '14rem', background: '#0F172A', color: '#E2E8F0', padding: spacing[4], display: 'flex', flexDirection: 'column', gap: spacing[1] }}
      >
        <strong style={{ color: '#60A5FA', fontSize: typography.size.lg, marginBottom: spacing[4] }}>{t('shell.brand')}</strong>
        {NAV.map((item) => (
          <a
            key={item.key}
            href={item.path}
            aria-current={active === item.key ? 'page' : undefined}
            style={{
              padding: `${spacing[2]} ${spacing[3]}`,
              borderRadius: '0.5rem',
              textDecoration: 'none',
              color: active === item.key ? '#FFFFFF' : '#94A3B8',
              background: active === item.key ? '#1E293B' : 'transparent',
              fontSize: typography.size.sm,
              minHeight: '2.75rem',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {t(item.label)}
          </a>
        ))}
        <div style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="sm"
          style={{ color: '#94A3B8' }}
          onClick={async () => {
            await logout();
            router.push('/login');
          }}
        >
          {t('shell.logout')}
        </Button>
      </aside>
      <main style={{ flex: 1, background: '#F1F5F9', padding: spacing[6] }}>
        {session.kind === 'retrying' ? <SessionRetryNotice onRetry={retrySessionNow} /> : null}
        <Card>{children}</Card>
      </main>
    </div>
  );
}
