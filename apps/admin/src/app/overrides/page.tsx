'use client';
import { useEffect, useState } from 'react';
import type { OverrideDto } from '@daftar/shared-contracts';
import { Button, Dialog, Select, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { ApiError } from '@/lib/client';
import { createOverride, listOverrides, revokeOverride } from '@/lib/admin-api';
import { Shell } from '../Shell';

export default function OverridesPage() {
  const [items, setItems] = useState<OverrideDto[]>([]);
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
  const [revoking, setRevoking] = useState<OverrideDto | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  async function load() {
    setItems((await listOverrides()).items);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // XOR contract: exactly one of featureKey / limitKey.
      await createOverride({
        businessId,
        reason,
        ...(kind === 'feature' ? { featureKey, enabledValue: enabledValue === 'true' } : { limitKey, limitValue: Number(limitValue) }),
      });
      setOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'Failed — check the business id and XOR shape (feature OR limit, never both).');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await revokeOverride(revoking.id, revokeReason);
      setRevoking(null);
      setRevokeReason('');
      await load();
    } finally {
      setBusy(false);
    }
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
            { key: 'business', header: 'Business', render: (o) => <code>{o.businessId.slice(0, 8)}…</code> },
            {
              key: 'what',
              header: 'Override',
              render: (o) => (o.featureKey ? `feature ${o.featureKey}=${String(o.enabledValue)}` : `limit ${o.limitKey}=${o.limitValue}`),
            },
            { key: 'reason', header: 'Reason', render: (o) => o.reason },
            {
              key: 'window',
              header: 'Window',
              render: (o) => `${new Date(o.startsAt).toLocaleDateString()} → ${o.endsAt ? new Date(o.endsAt).toLocaleDateString() : '∞'}`,
            },
            { key: 'state', header: 'State', render: (o) => (o.revokedAt ? 'revoked' : 'active') },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (o) =>
                !o.revokedAt ? (
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(o)}>
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
      <Dialog
        open={!!revoking}
        title="Revoke override"
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={revokeReason.trim().length < 3} onClick={() => void revoke()}>
              Revoke
            </Button>
          </>
        }
      >
        <TextField label="Reason (audited)" value={revokeReason} onChange={setRevokeReason} required />
      </Dialog>
    </Shell>
  );
}
