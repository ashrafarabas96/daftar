'use client';
import { useEffect, useState } from 'react';
import type { AuditEventDto } from '@daftar/shared-contracts';
import { Table, colors, radius, spacing, typography } from '@daftar/design-system';
import { listAuditEvents } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

export default function AuditPage() {
  const t = useT();
  const [items, setItems] = useState<AuditEventDto[]>([]);
  useEffect(() => {
    void listAuditEvents().then((r) => setItems(r.items));
  }, []);
  return (
    <Shell active="audit">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('audit.title')}</h1>
      <p
        style={{
          background: colors.semantic.infoSoft,
          color: colors.semantic.info,
          padding: spacing[3],
          borderRadius: radius.md,
          fontSize: typography.size.sm,
        }}
      >
        {t('audit.notice')}
      </p>
      <Table
        rows={items}
        columns={[
          { key: 'time', header: t('audit.col.time'), render: (e) => new Date(e.createdAt).toLocaleString() },
          { key: 'action', header: t('audit.col.action'), render: (e) => <code>{e.action}</code> },
          { key: 'entity', header: t('audit.col.entity'), render: (e) => `${e.entity}${e.entityId ? `/${e.entityId.slice(0, 8)}…` : ''}` },
          { key: 'tenant', header: t('audit.col.tenantBusiness'), render: (e) => `${e.tenantId?.slice(0, 8) ?? '—'} / ${e.businessId?.slice(0, 8) ?? '—'}` },
          { key: 'actor', header: t('common.col.actor'), render: (e) => (e.actorUserId ? <code>{e.actorUserId.slice(0, 8)}…</code> : '—') },
          { key: 'request', header: t('audit.col.request'), render: (e) => (e.requestId ? <code>{e.requestId.slice(0, 8)}…</code> : '—') },
        ]}
      />
    </Shell>
  );
}
