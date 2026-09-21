'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, ConfirmationDialog, Table, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface Session {
  id: string;
  reason: string;
  actor_user_id: string;
  tenant_id: string;
  business_id: string | null;
  mode: string;
  starts_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export default function SupportSessionsPage() {
  const [items, setItems] = useState<Session[]>([]);
  const [revoking, setRevoking] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await apiFetch<{ items: Session[] }>('/api/proxy/admin/support-sessions');
    setItems(res.items);
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await apiFetch(`/api/proxy/admin/support-sessions/${revoking.id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'revoked from console' }),
      });
      setRevoking(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const stateOf = (s: Session) =>
    s.revoked_at ? (
      <Badge tone="neutral">revoked</Badge>
    ) : new Date(s.expires_at) < new Date() ? (
      <Badge tone="neutral">expired</Badge>
    ) : (
      <Badge tone="danger">ACTIVE</Badge>
    );

  return (
    <Shell active="support-sessions">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Support sessions</h1>
      <Table
        rows={items}
        columns={[
          { key: 'tenant', header: 'Tenant', render: (s) => <code>{s.tenant_id.slice(0, 8)}…</code> },
          {
            key: 'scope',
            header: 'Scope',
            render: (s) => (s.business_id ? <Badge tone="info">business {s.business_id.slice(0, 8)}…</Badge> : <Badge tone="neutral">whole tenant</Badge>),
          },
          { key: 'reason', header: 'Reason', render: (s) => s.reason },
          { key: 'expires', header: 'Expires', render: (s) => new Date(s.expires_at).toLocaleString() },
          { key: 'state', header: 'State', render: stateOf },
          {
            key: 'actions',
            header: '',
            align: 'end',
            render: (s) =>
              !s.revoked_at && new Date(s.expires_at) > new Date() ? (
                <Button size="sm" variant="danger" onClick={() => setRevoking(s)}>
                  Revoke
                </Button>
              ) : null,
          },
        ]}
      />
      <ConfirmationDialog
        open={!!revoking}
        title="Revoke support session"
        message="Revocation is immediate — the next request with this session fails."
        confirmLabel="Revoke now"
        cancelLabel="Cancel"
        danger
        loading={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </Shell>
  );
}
