'use client';
import { useEffect, useState } from 'react';
import type { AdminBusinessSummaryDto, BusinessSubscriptionDetailDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Table, colors, typography } from '@daftar/design-system';
import { getBusinessDetail, listBusinesses } from '@/lib/admin-api';
import { Shell } from '../Shell';

export default function BusinessesPage() {
  const [items, setItems] = useState<AdminBusinessSummaryDto[]>([]);
  const [detail, setDetail] = useState<BusinessSubscriptionDetailDto | null>(null);
  useEffect(() => {
    void listBusinesses().then((r) => setItems(r.items));
  }, []);
  return (
    <Shell active="businesses">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Businesses</h1>
      <Table
        rows={items}
        columns={[
          { key: 'name', header: 'Name', render: (b) => b.name },
          { key: 'slug', header: 'Slug', render: (b) => <code>{b.storeSlug}</code> },
          { key: 'currency', header: 'Currency', render: (b) => b.baseCurrency },
          { key: 'plan', header: 'Plan', render: (b) => (b.planKey ? `${b.planKey} v${b.planVersion} · ${b.subscriptionState}` : '—') },
          { key: 'status', header: 'Status', render: (b) => <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge> },
          { key: 'created', header: 'Created', render: (b) => new Date(b.createdAt).toLocaleDateString() },
          {
            key: 'open',
            header: '',
            align: 'end',
            render: (b) => (
              <Button size="sm" variant="secondary" onClick={() => void getBusinessDetail(b.id).then(setDetail)}>
                Subscription
              </Button>
            ),
          },
        ]}
      />
      <Dialog open={!!detail} title={detail ? `${detail.name} — subscription` : ''} onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
            {detail.subscription ? (
              <p>
                <strong>
                  {detail.subscription.planKey} v{detail.subscription.planVersion}
                </strong>{' '}
                · state {detail.subscription.state} (effective {detail.subscription.effectiveState})
                {detail.subscription.trialEndsAt ? ` · trial ends ${new Date(detail.subscription.trialEndsAt).toLocaleString()}` : ''}
                {detail.subscription.periodEndsAt ? ` · period ends ${new Date(detail.subscription.periodEndsAt).toLocaleString()}` : ''}
              </p>
            ) : (
              <p style={{ color: colors.semantic.danger }}>No subscription row.</p>
            )}
            <h3 style={{ fontSize: typography.size.md }}>Overrides</h3>
            {detail.overrides.length === 0 ? <p style={{ color: colors.neutral[500] }}>None.</p> : null}
            <ul>
              {detail.overrides.map((o) => (
                <li key={o.id}>
                  {o.featureKey ? `feature ${o.featureKey}=${String(o.enabledValue)}` : `limit ${o.limitKey}=${o.limitValue}`} — {o.reason}{' '}
                  <Badge tone={o.revokedAt ? 'neutral' : 'success'}>{o.revokedAt ? 'revoked' : 'active'}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Dialog>
    </Shell>
  );
}
