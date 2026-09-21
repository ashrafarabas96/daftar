'use client';
import { useEffect, useState } from 'react';
import { Table, colors, radius, spacing, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface AuditEvent {
  id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  actor_user_id: string | null;
  request_id: string | null;
  created_at: string;
}

export default function AuditPage() {
  const [items, setItems] = useState<AuditEvent[]>([]);
  useEffect(() => {
    void (async () => {
      const res = await apiFetch<{ items: AuditEvent[] }>('/api/proxy/admin/audit-events');
      setItems(res.items);
    })();
  }, []);
  return (
    <Shell active="audit">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Audit events</h1>
      <p
        style={{
          background: colors.semantic.infoSoft, color: colors.semantic.info,
          padding: spacing[3], borderRadius: radius.md, fontSize: typography.size.sm,
        }}
      >
        Audit events contain safe metadata only — never tokens, passwords, or credential payloads.
      </p>
      <Table
        rows={items}
        columns={[
          { key: 'time', header: 'Time', render: (e) => new Date(e.created_at).toLocaleString() },
          { key: 'action', header: 'Action', render: (e) => <code>{e.action}</code> },
          { key: 'entity', header: 'Entity', render: (e) => `${e.entity}${e.entity_id ? `/${e.entity_id.slice(0, 8)}…` : ''}` },
          { key: 'actor', header: 'Actor', render: (e) => (e.actor_user_id ? <code>{e.actor_user_id.slice(0, 8)}…</code> : '—') },
          { key: 'request', header: 'Request', render: (e) => (e.request_id ? <code>{e.request_id.slice(0, 8)}…</code> : '—') },
        ]}
      />
    </Shell>
  );
}
