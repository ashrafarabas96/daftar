'use client';
import { useEffect, useState } from 'react';
import type { SupportSessionDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Table, TextField, typography } from '@daftar/design-system';
import { listSupportSessions, revokeSupportSession } from '@/lib/admin-api';
import { Shell } from '../Shell';

export default function SupportSessionsPage() {
  const [items, setItems] = useState<SupportSessionDto[]>([]);
  const [revoking, setRevoking] = useState<SupportSessionDto | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setItems((await listSupportSessions()).items);
  }
  useEffect(() => {
    void load();
  }, []);

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await revokeSupportSession(revoking.id, reason);
      setRevoking(null);
      setReason('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  const stateOf = (s: SupportSessionDto) =>
    s.revokedAt ? (
      <Badge tone="neutral">revoked</Badge>
    ) : new Date(s.expiresAt) < new Date() ? (
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
          { key: 'tenant', header: 'Tenant', render: (s) => <code>{s.tenantId.slice(0, 8)}…</code> },
          {
            key: 'scope',
            header: 'Scope',
            render: (s) => (s.businessId ? <Badge tone="info">business {s.businessId.slice(0, 8)}…</Badge> : <Badge tone="neutral">whole tenant</Badge>),
          },
          { key: 'actor', header: 'Actor', render: (s) => <code>{s.actorUserId.slice(0, 8)}…</code> },
          { key: 'reason', header: 'Reason', render: (s) => s.reason },
          { key: 'expires', header: 'Expires', render: (s) => new Date(s.expiresAt).toLocaleString() },
          { key: 'state', header: 'State', render: stateOf },
          {
            key: 'actions',
            header: '',
            align: 'end',
            render: (s) =>
              !s.revokedAt && new Date(s.expiresAt) > new Date() ? (
                <Button size="sm" variant="danger" onClick={() => setRevoking(s)}>
                  Revoke
                </Button>
              ) : null,
          },
        ]}
      />
      <Dialog
        open={!!revoking}
        title="Revoke support session"
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => void revoke()}>
              Revoke now
            </Button>
          </>
        }
      >
        <p style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
          Revocation is immediate — the next request with this session fails.
        </p>
        <TextField label="Reason (audited)" value={reason} onChange={setReason} required />
      </Dialog>
    </Shell>
  );
}
