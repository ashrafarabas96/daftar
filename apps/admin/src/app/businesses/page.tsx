'use client';
import { useEffect, useState } from 'react';
import type { AdminBusinessSummaryDto, BusinessSubscriptionDetailDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Table, colors, typography } from '@daftar/design-system';
import { getBusinessDetail, listBusinesses } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

export default function BusinessesPage() {
  const t = useT();
  const [items, setItems] = useState<AdminBusinessSummaryDto[]>([]);
  const [detail, setDetail] = useState<BusinessSubscriptionDetailDto | null>(null);
  useEffect(() => {
    void listBusinesses().then((r) => setItems(r.items));
  }, []);
  return (
    <Shell active="businesses">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('businesses.title')}</h1>
      <Table
        rows={items}
        columns={[
          { key: 'name', header: t('common.col.name'), render: (b) => b.name },
          { key: 'slug', header: t('businesses.col.slug'), render: (b) => <code>{b.storeSlug}</code> },
          { key: 'currency', header: t('businesses.col.currency'), render: (b) => b.baseCurrency },
          { key: 'plan', header: t('common.col.plan'), render: (b) => (b.planKey ? `${b.planKey} v${b.planVersion} · ${b.subscriptionState}` : '—') },
          { key: 'status', header: t('businesses.col.status'), render: (b) => <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge> },
          { key: 'created', header: t('common.col.created'), render: (b) => new Date(b.createdAt).toLocaleDateString() },
          {
            key: 'open',
            header: '',
            align: 'end',
            render: (b) => (
              <Button size="sm" variant="secondary" onClick={() => void getBusinessDetail(b.id).then(setDetail)}>
                {t('businesses.subscription')}
              </Button>
            ),
          },
        ]}
      />
      <Dialog open={!!detail} title={detail ? t('businesses.dialogTitle', { name: detail.name }) : ''} onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
            {detail.subscription ? (
              <p>
                <strong>
                  {detail.subscription.planKey} v{detail.subscription.planVersion}
                </strong>{' '}
                {t('businesses.stateLine', { state: detail.subscription.state, effective: detail.subscription.effectiveState })}
                {detail.subscription.trialEndsAt ? t('businesses.trialEnds', { date: new Date(detail.subscription.trialEndsAt).toLocaleString() }) : ''}
                {detail.subscription.periodEndsAt ? t('businesses.periodEnds', { date: new Date(detail.subscription.periodEndsAt).toLocaleString() }) : ''}
              </p>
            ) : (
              <p style={{ color: colors.semantic.danger }}>{t('businesses.noSubscription')}</p>
            )}
            <h3 style={{ fontSize: typography.size.md }}>{t('businesses.overrides')}</h3>
            {detail.overrides.length === 0 ? <p style={{ color: colors.neutral[500] }}>{t('common.none')}</p> : null}
            <ul>
              {detail.overrides.map((o) => (
                <li key={o.id}>
                  {o.featureKey
                    ? t('common.override.feature', { key: o.featureKey, value: String(o.enabledValue) })
                    : t('common.override.limit', { key: o.limitKey ?? '', value: o.limitValue ?? '' })}{' '}
                  — {o.reason} <Badge tone={o.revokedAt ? 'neutral' : 'success'}>{o.revokedAt ? t('common.revoked') : t('common.active')}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Dialog>
    </Shell>
  );
}
