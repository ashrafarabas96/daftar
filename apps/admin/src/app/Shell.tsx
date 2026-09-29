'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, Card, spacing, typography } from '@daftar/design-system';
import { logout, refreshSession, retrySessionNow, sessionState, subscribeSession, type SessionState } from '@/lib/client';

const NAV = [
  { key: 'overview', label: 'Overview', path: '/' },
  { key: 'tenants', label: 'Tenants', path: '/tenants' },
  { key: 'businesses', label: 'Businesses', path: '/businesses' },
  { key: 'users', label: 'Users', path: '/users' },
  { key: 'plans', label: 'Plans', path: '/plans' },
  { key: 'overrides', label: 'Overrides', path: '/overrides' },
  { key: 'flags', label: 'Feature flags', path: '/flags' },
  { key: 'support-sessions', label: 'Support sessions', path: '/support-sessions' },
  { key: 'audit', label: 'Audit', path: '/audit' },
  { key: 'operations', label: 'Operations', path: '/operations' },
] as const;

const SESSION_OK: SessionState = { kind: 'ok' };

/**
 * TD-19: while the console's refresh waits out a rate limit or an outage, say
 * so — the operator is still signed in — instead of a blank page or a
 * redirect to the login page. The console is English-only.
 */
export function SessionRetryNotice({ onRetry }: { onRetry: () => void }) {
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
      <span style={{ flex: '1 1 16rem' }}>The connection is busy right now. You&apos;re still signed in — we&apos;ll try again in a moment.</span>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const router = useRouter();
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
        <strong style={{ color: '#60A5FA', fontSize: typography.size.lg, marginBottom: spacing[4] }}>DAFTAR Admin</strong>
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
            {item.label}
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
          Log out
        </Button>
      </aside>
      <main style={{ flex: 1, background: '#F1F5F9', padding: spacing[6] }}>
        {session.kind === 'retrying' ? <SessionRetryNotice onRetry={retrySessionNow} /> : null}
        <Card>{children}</Card>
      </main>
    </div>
  );
}
