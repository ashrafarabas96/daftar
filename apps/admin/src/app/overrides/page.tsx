'use client';
import { useEffect, useState } from 'react';
import { Button, Dialog, Select, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface Override {
  id: string;
  business_id: string;
  feature_key: string | null;
  enabled_value: boolean | null;
  limit_key: string | null;
  limit_value: number | null;
  reason: string;
  revoked_at: string | null;
}

export default function OverridesPage() {
  const [items, setItems] = useState<Override[]>([]);
  const [open, setOpen] = useState(false);
  const [businessId, setBusinessId] = useState('');
  const [kind, setKind] = useState<'feature' | 'limit'>('feature');
  const [featureKey, setFeatureKey] = useState('');
  const [enabledValue, setEnabledValue] = useState('true');
  const [limitKey, setLimitKey] = useState('');
  const [limitValue, setLimitValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await apiFetch<{ items: Override[] }>('/api/proxy/admin/entitlement-overrides');
    setItems(res.items);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // XOR contract: exactly one of featureKey / limitKey.
      await apiFetch('/api/proxy/admin/entitlement-overrides', {
        method: 'POST',
        body: JSON.stringify({
          businessId,
          reason,
          ...(kind === 'feature' ? { featureKey, enabledValue: enabledValue === 'true' } : { limitKey, limitValue: Number(limitValue) }),
        }),
      });
      setOpen(false);
      await load();
    } catch {
      setError('Failed — check the business id and XOR shape (feature OR limit, never both).');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await apiFetch(`/api/proxy/admin/entitlement-overrides/${id}/revoke`, { method: 'POST', body: '{}' });
    await load();
  }

  return (
    <Shell active="overrides">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>Entitlement overrides</h1>
        <Button onClick={() => setOpen(true)}>New override</Button>
      </div>
      <div style={{ marginTop: spacing[4] }}>
        <Table
          rows={items}
          columns={[
            { key: 'business', header: 'Business', render: (o) => <code>{o.business_id.slice(0, 8)}…</code> },
            {
              key: 'what',
              header: 'Override',
              render: (o) => (o.feature_key ? `feature ${o.feature_key}=${o.enabled_value}` : `limit ${o.limit_key}=${o.limit_value}`),
            },
            { key: 'reason', header: 'Reason', render: (o) => o.reason },
            { key: 'state', header: 'State', render: (o) => (o.revoked_at ? 'revoked' : 'active') },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (o) =>
                !o.revoked_at ? (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(o.id)}>
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
      <Dialog
        open={open}
        title="New entitlement override"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!businessId || reason.trim().length < 3} onClick={() => void create()}>
              Create
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label="Business ID" value={businessId} onChange={setBusinessId} required />
          <Select
            label="Kind"
            value={kind}
            onChange={(v) => setKind(v as 'feature' | 'limit')}
            options={[
              { value: 'feature', label: 'Feature' },
              { value: 'limit', label: 'Limit' },
            ]}
          />
          {kind === 'feature' ? (
            <>
              <TextField label="Feature key" value={featureKey} onChange={setFeatureKey} required />
              <Select
                label="Enabled"
                value={enabledValue}
                onChange={setEnabledValue}
                options={[
                  { value: 'true', label: 'true' },
                  { value: 'false', label: 'false' },
                ]}
              />
            </>
          ) : (
            <>
              <TextField label="Limit key" value={limitKey} onChange={setLimitKey} required />
              <TextField label="Limit value" value={limitValue} onChange={setLimitValue} inputMode="numeric" required />
            </>
          )}
          <TextField label="Reason (audited)" value={reason} onChange={setReason} required />
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </Shell>
  );
}
