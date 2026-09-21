'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EntitlementSummaryDto } from '@daftar/shared-contracts';
import { Badge, ErrorState, Table, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { refreshSession } from '@/lib/client';
import { getEntitlement } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

export default function PlanPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [plan, setPlan] = useState<EntitlementSummaryDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        setPlan(await getEntitlement());
      } catch {
        setFailed(true);
      }
    })();
  }, [locale, router]);

  const trialDays = plan?.trialEndsAt ? Math.max(0, Math.ceil((new Date(plan.trialEndsAt).getTime() - Date.now()) / 86_400_000)) : null;

  return (
    <PageShell locale={locale} active="plan">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('plan.title')}</h1>
      {failed ? (
        <ErrorState title={t('error.generic')} onRetry={() => window.location.reload()} />
      ) : plan ? (
        <>
          <p style={{ fontFamily: typography.fontFamily.base }}>
            {t('plan.current')}:{' '}
            <Badge tone="brand">
              {plan.planKey} · v{plan.planVersion}
            </Badge>{' '}
            <Badge tone={plan.effectiveState === 'active' ? 'success' : 'warning'}>{plan.effectiveState}</Badge>
            {trialDays !== null ? ` — ${t('plan.trialDaysLeft')}: ${trialDays}` : ''}
            {plan.periodEndsAt ? ` — ${new Date(plan.periodEndsAt).toLocaleDateString(locale)}` : ''}
          </p>
          <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg }}>{t('plan.limits')}</h2>
          <Table
            rows={plan.limits.map((l, i) => ({ id: `${l.key}-${i}`, ...l }))}
            columns={[
              { key: 'key', header: '', render: (r) => r.key },
              { key: 'used', header: '', align: 'end', render: (r) => `${r.usage} / ${r.limit === -1 ? '∞' : r.limit}` },
            ]}
          />
          <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg, marginTop: spacing[6] }}>{t('plan.features')}</h2>
          <Table
            rows={plan.features.map((f, i) => ({ id: `${f.key}-${i}`, ...f }))}
            columns={[
              { key: 'key', header: '', render: (r) => r.key },
              { key: 'enabled', header: '', align: 'end', render: (r) => (r.enabled ? <Badge tone="success">✓</Badge> : <Badge tone="neutral">—</Badge>) },
            ]}
          />
        </>
      ) : (
        <p>{t('common.loading')}</p>
      )}
    </PageShell>
  );
}
