'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Select, Table, TextField, colors, radius, spacing, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface Tenant {
  id: string;
  created_at: string;
  businesses?: { id: string; name: string; storeSlug: string; status: string }[];
}

interface TenantDetail {
  tenant: Tenant;
  supportBanner: { sessionId: string; mode: string; expiresAt: string; message: string };
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [duration, setDuration] = useState('60');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Tenant | null>(null);

  async function load() {
    const res = await apiFetch<{ items: Tenant[] }>('/api/proxy/admin/tenants');
    setTenants(res.items);
  }

  useEffect(() => {
    void load();
  }, []);

  async function openDetail(tenant: Tenant) {
    setSelected(tenant);
    setDetail(null);
    setDetailError(null);
    try {
      const d = await apiFetch<TenantDetail>(`/api/proxy/admin/tenants/${tenant.id}`);
      setDetail(d);
    } catch (e) {
      setDetailError(e instanceof Error && 'status' in e && (e as { status: number }).status === 403
        ? 'No active support session — create one to view tenant data.'
        : 'Failed to load tenant');
    }
  }

  async function createSession() {
    if (!selected) return;
    setBusy(true);
    try {
      await apiFetch('/api/proxy/admin/support-sessions', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: selected.id,
          ...(businessId ? { businessId } : {}),
          reason,
          expiresAt: new Date(Date.now() + Number(duration) * 60_000).toISOString(),
        }),
      });
      setSessionOpen(false);
      setReason('');
      await openDetail(selected);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell active="tenants">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Tenants</h1>
      <Table
        rows={tenants}
        columns={[
          { key: 'id', header: 'Tenant', render: (t) => <code>{t.id.slice(0, 8)}…</code> },
          { key: 'created', header: 'Created', render: (t) => new Date(t.created_at).toLocaleDateString() },
          { key: 'open', header: '', align: 'end', render: (t) => <Button size="sm" variant="secondary" onClick={() => void openDetail(t)}>Open</Button> },
        ]}
      />
      <Dialog
        open={!!selected}
        title={`Tenant ${selected?.id.slice(0, 8) ?? ''}…`}
        onClose={() => { setSelected(null); setDetail(null); }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
            <Button onClick={() => setSessionOpen(true)}>New support session</Button>
          </>
        }
      >
        {detail?.supportBanner ? (
          <div
            role="alert"
            style={{
              background: colors.semantic.warningSoft, color: colors.semantic.warning,
              border: `1px solid ${colors.semantic.warning}`, borderRadius: radius.md,
              padding: spacing[3], marginBottom: spacing[4], fontWeight: 600,
            }}
          >
            {detail.supportBanner.message}
          </div>
        ) : null}
        {detailError ? <p role="alert" style={{ color: colors.semantic.danger }}>{detailError}</p> : null}
        {detail ? (
          <div style={{ fontFamily: typography.fontFamily.base }}>
            <h3 style={{ fontSize: typography.size.md }}>Businesses</h3>
            <ul>
              {(detail.tenant.businesses ?? []).map((b) => (
                <li key={b.id}>
                  {b.name} (<code>{b.storeSlug}</code>) <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={sessionOpen}
        title="Start support session"
        onClose={() => setSessionOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSessionOpen(false)}>Cancel</Button>
            <Button loading={busy} disabled={reason.trim().length < 10} onClick={() => void createSession()}>Start session</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label="Reason (min 10 chars, appears in audit)" value={reason} onChange={setReason} required />
          <Select
            label="Scope"
            value={businessId}
            onChange={setBusinessId}
            options={[
              { value: '', label: 'Whole tenant' },
              ...(selected?.businesses ?? []).map((b) => ({ value: b.id, label: `Business: ${b.name}` })),
            ]}
          />
          <Select
            label="Duration"
            value={duration}
            onChange={setDuration}
            options={[
              { value: '30', label: '30 minutes' },
              { value: '60', label: '1 hour' },
              { value: '120', label: '2 hours' },
              { value: '240', label: '4 hours (max)' },
            ]}
          />
        </div>
      </Dialog>
    </Shell>
  );
}
