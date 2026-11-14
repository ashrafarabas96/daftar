'use client';
import { useEffect, useState } from 'react';
import type { OverrideDto } from '@daftar/shared-contracts';
import { Button, Dialog, Select, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { ApiError } from '@/lib/client';
import { createOverride, listOverrides, revokeOverride } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

export default function OverridesPage() {
  const t = useT();
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
      setError(e instanceof ApiError ? e.code : t('overrides.error.createFailed'));
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
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('overrides.title')}</h1>
        <Button onClick={() => setOpen(true)}>{t('overrides.new')}</Button>
      </div>
      <div style={{ marginTop: spacing[4] }}>
        <Table
          rows={items}
          columns={[
            { key: 'business', header: t('common.col.business'), render: (o) => <code>{o.businessId.slice(0, 8)}…</code> },
            {
              key: 'what',
              header: t('overrides.col.override'),
              render: (o) =>
                o.featureKey
                  ? t('common.override.feature', { key: o.featureKey, value: String(o.enabledValue) })
                  : t('common.override.limit', { key: o.limitKey ?? '', value: o.limitValue ?? '' }),
            },
            { key: 'reason', header: t('common.col.reason'), render: (o) => o.reason },
            {
              key: 'window',
              header: t('overrides.col.window'),
              render: (o) => `${new Date(o.startsAt).toLocaleDateString()} → ${o.endsAt ? new Date(o.endsAt).toLocaleDateString() : '∞'}`,
            },
            { key: 'state', header: t('common.col.state'), render: (o) => (o.revokedAt ? t('common.revoked') : t('common.active')) },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (o) =>
                !o.revokedAt ? (
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(o)}>
                    {t('common.revoke')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
      <Dialog
        open={open}
        title={t('overrides.dialog.newTitle')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!businessId || reason.trim().length < 3} onClick={() => void create()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('overrides.field.businessId')} value={businessId} onChange={setBusinessId} required />
          <Select
            label={t('overrides.field.kind')}
            value={kind}
            onChange={(v) => setKind(v as 'feature' | 'limit')}
            options={[
              { value: 'feature', label: t('overrides.kind.feature') },
              { value: 'limit', label: t('overrides.kind.limit') },
            ]}
          />
          {kind === 'feature' ? (
            <>
              <TextField label={t('overrides.field.featureKey')} value={featureKey} onChange={setFeatureKey} required />
              <Select
                label={t('overrides.field.enabled')}
                value={enabledValue}
                onChange={setEnabledValue}
                options={[
                  { value: 'true', label: t('overrides.bool.true') },
                  { value: 'false', label: t('overrides.bool.false') },
                ]}
              />
            </>
          ) : (
            <>
              <TextField label={t('overrides.field.limitKey')} value={limitKey} onChange={setLimitKey} required />
              <TextField label={t('overrides.field.limitValue')} value={limitValue} onChange={setLimitValue} inputMode="numeric" required />
            </>
          )}
          <TextField label={t('common.reasonAudited')} value={reason} onChange={setReason} required />
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
      <Dialog
        open={!!revoking}
        title={t('overrides.dialog.revokeTitle')}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} disabled={revokeReason.trim().length < 3} onClick={() => void revoke()}>
              {t('common.revoke')}
            </Button>
          </>
        }
      >
        <TextField label={t('common.reasonAudited')} value={revokeReason} onChange={setRevokeReason} required />
      </Dialog>
    </Shell>
  );
}
