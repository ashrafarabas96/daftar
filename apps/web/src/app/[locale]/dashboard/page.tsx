'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, ErrorState, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { currentBusinessId, refreshSession } from '@/lib/client';
import { getEntitlement, listMembers, listProducts } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

interface Stats {
  products: number;
  team: number;
  planLabel: string;
}

export default function DashboardPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      if (!currentBusinessId()) {
        router.push(`/${locale}/onboarding`);
        return;
      }
      try {
        // §31: the SAME entitlement endpoint the plan page uses — a contract
        // failure surfaces as an error state, never a silent null.
        const [products, members, entitlement] = await Promise.all([
          listProducts(),
          listMembers(),
          getEntitlement(),
        ]);
        setStats({
          products: products.items.length,
          team: members.items.length,
          planLabel: `${entitlement.planKey} · v${entitlement.planVersion} · ${entitlement.effectiveState}`,
        });
      } catch {
        setFailed(true);
      }
    })();
  }, [locale, router]);

  const statCard = (label: string, value: string | number) => (
    <Card key={label} style={{ flex: 1, minWidth: '12rem' }}>
      <p style={{ margin: 0, color: colors.neutral[500], fontSize: typography.size.sm }}>{label}</p>
      <p style={{ margin: `${spacing[2]} 0 0`, fontSize: typography.size['2xl'], fontWeight: 700, color: colors.neutral[900] }}>
        {value}
      </p>
    </Card>
  );

  return (
    <PageShell locale={locale} active="dashboard">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('dashboard.title')}</h1>
      {failed ? (
        <ErrorState title={t('error.generic')} onRetry={() => window.location.reload()} />
      ) : stats ? (
        <div style={{ display: 'flex', gap: spacing[4], flexWrap: 'wrap' }}>
          {statCard(t('dashboard.products'), stats.products)}
          {statCard(t('dashboard.teamMembers'), stats.team)}
          {statCard(t('dashboard.planUsage'), stats.planLabel)}
        </div>
      ) : null}
    </PageShell>
  );
}
