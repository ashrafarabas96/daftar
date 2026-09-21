'use client';
import { useEffect, useState } from 'react';
import type { AuditEventDto } from '@daftar/shared-contracts';
import { Table, colors, radius, spacing, typography } from '@daftar/design-system';
import { listAuditEvents } from '@/lib/admin-api';
import { Shell } from '../Shell';

export default function AuditPage() {
  const [items, setItems] = useState<AuditEventDto[]>([]);
  useEffect(() => {
    void listAuditEvents().then((r) => setItems(r.items));
  }, []);
  return (
    <Shell active="audit">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Audit events</h1>
      <p
        style={{
          background: colors.semantic.infoSoft,
          color: colors.semantic.info,
          padding: spacing[3],
          borderRadius: radius.md,
          fontSize: typography.size.sm,
        }}
      >
        Audit events contain safe metadata only — never tokens, passwords, or credential payloads.
      </p>
      <Table
        rows={items}
        columns={[
          { key: 'time', header: 'Time', render: (e) => new Date(e.createdAt).toLocaleString() },
          { key: 'action', header: 'Action', render: (e) => <code>{e.action}</code> },
          { key: 'entity', header: 'Entity', render: (e) => `${e.entity}${e.entityId ? `/${e.entityId.slice(0, 8)}…` : ''}` },
          { key: 'tenant', header: 'Tenant / business', render: (e) => `${e.tenantId?.slice(0, 8) ?? '—'} / ${e.businessId?.slice(0, 8) ?? '—'}` },
          { key: 'actor', header: 'Actor', render: (e) => (e.actorUserId ? <code>{e.actorUserId.slice(0, 8)}…</code> : '—') },
          { key: 'request', header: 'Request', render: (e) => (e.requestId ? <code>{e.requestId.slice(0, 8)}…</code> : '—') },
        ]}
      />
    </Shell>
  );
}
