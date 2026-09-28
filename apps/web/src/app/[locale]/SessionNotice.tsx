'use client';
import { useSyncExternalStore } from 'react';
import { Button, colors, radius, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { retrySessionNow, sessionState, subscribeSession, type SessionState } from '@/lib/client';
import type { ViewBaseProps } from '@/lib/phase3-format';

/**
 * TD-19: while the page's refresh is waiting out a rate limit or an outage,
 * the page says so in plain words — the user is still signed in, and the page
 * will carry on by itself — with a "Try again" for the impatient. The page
 * underneath keeps its loading state; nothing sends the user to log in.
 *
 * `SessionRetryNotice` is the pure view (tested at phone width in ar/en/tr);
 * `SessionNotice` connects it to the session state in `@/lib/client`.
 */
export function SessionRetryNotice({ t, onRetry }: ViewBaseProps & { onRetry: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing[3],
        margin: spacing[3],
        padding: spacing[3],
        background: colors.semantic.warningSoft,
        color: colors.neutral[900],
        borderInlineStart: `4px solid ${colors.semantic.warning}`,
        borderRadius: radius.md,
        fontFamily: typography.fontFamily.base,
        fontSize: typography.size.md,
      }}
    >
      <span style={{ flex: '1 1 16rem', minWidth: 0 }}>{t('session.retrying')}</span>
      <Button variant="secondary" onClick={onRetry}>
        {t('common.tryAgain')}
      </Button>
    </div>
  );
}

const OK: SessionState = { kind: 'ok' };

export function SessionNotice({ locale }: { locale: Locale }) {
  const state = useSyncExternalStore(subscribeSession, sessionState, () => OK);
  if (state.kind !== 'retrying') return null;
  return <SessionRetryNotice t={makeT(locale)} locale={locale} onRetry={retrySessionNow} />;
}
