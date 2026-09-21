'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmationDialog, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { refreshSession } from '@/lib/client';
import { logoutAllSessions } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

export default function SecurityPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) router.push(`/${locale}/login`);
    })();
  }, [locale, router]);

  async function logoutAll() {
    setBusy(true);
    try {
      await logoutAllSessions().catch(() => undefined);
      setDone(true);
      setConfirmOpen(false);
      router.push(`/${locale}/login`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="security">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('security.title')}</h1>
      <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg }}>{t('security.sessions')}</h2>
      <div style={{ marginTop: spacing[4] }}>
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          {t('security.logoutAll')}
        </Button>
        {done ? (
          <p role="status" style={{ color: colors.semantic.success }}>
            {t('security.done')}
          </p>
        ) : null}
      </div>
      <ConfirmationDialog
        open={confirmOpen}
        title={t('security.logoutAll')}
        message={t('security.logoutAllConfirm')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        danger
        loading={busy}
        onConfirm={() => void logoutAll()}
        onCancel={() => setConfirmOpen(false)}
      />
    </PageShell>
  );
}
