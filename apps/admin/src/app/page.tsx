'use client';
import { useEffect, useState } from 'react';
import { Card, colors, spacing, typography } from '@daftar/design-system';
import { listBusinesses, listSupportSessions, listTenants, listUsers } from '@/lib/admin-api';
import { Shell } from './Shell';

interface Counts {
  tenants: number | null;
  businesses: number | null;
  users: number | null;
  supportSessions: number | null;
}

export default function OverviewPage() {
  const [counts, setCounts] = useState<Counts>({ tenants: null, businesses: null, users: null, supportSessions: null });

  useEffect(() => {
    void (async () => {
      const [tenants, businesses, users, sessions] = await Promise.all([
        listTenants().catch(() => null),
        listBusinesses().catch(() => null),
        listUsers().catch(() => null),
        listSupportSessions().catch(() => null),
      ]);
      setCounts({
        tenants: tenants?.items.length ?? null,
        businesses: businesses?.items.length ?? null,
        users: users?.items.length ?? null,
        supportSessions: sessions?.items.filter((s) => !s.revokedAt && new Date(s.expiresAt) > new Date()).length ?? null,
      });
    })();
  }, []);

  const tile = (label: string, value: number | null) => (
    <Card key={label} style={{ flex: 1, minWidth: '10rem' }}>
      <p style={{ margin: 0, color: colors.neutral[500], fontSize: typography.size.sm }}>{label}</p>
      <p style={{ margin: `${spacing[2]} 0 0`, fontSize: typography.size['2xl'], fontWeight: 700 }}>{value ?? '—'}</p>
    </Card>
  );

  return (
    <Shell active="overview">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Overview</h1>
      <div style={{ display: 'flex', gap: spacing[4], flexWrap: 'wrap' }}>
        {tile('Tenants', counts.tenants)}
        {tile('Businesses', counts.businesses)}
        {tile('Users', counts.users)}
        {tile('Active support sessions', counts.supportSessions)}
      </div>
    </Shell>
  );
}
