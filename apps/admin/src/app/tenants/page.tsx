'use client';
import { useEffect, useState } from 'react';
import type { TenantDetailDto, TenantSummaryDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Select, Table, TextField, colors, radius, spacing, typography } from '@daftar/design-system';
import { ApiError } from '@/lib/client';
import { createSupportSession, getTenantDetail, listTenants } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

export default function TenantsPage() {
  const t = useT();
  const [tenants, setTenants] = useState<TenantSummaryDto[]>([]);
  const [detail, setDetail] = useState<TenantDetailDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [duration, setDuration] = useState('60');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<TenantSummaryDto | null>(null);

  async function load() {
    setTenants((await listTenants()).items);
  }
  useEffect(() => {
    void load();
  }, []);

  async function openDetail(tenant: TenantSummaryDto) {
    setSelected(tenant);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await getTenantDetail(tenant.id));
    } catch (e) {
      setDetailError(e instanceof ApiError && e.status === 403 ? t('tenants.error.noSession') : t('tenants.error.loadFailed'));
    }
  }

  async function startSession() {
    if (!selected) return;
    setBusy(true);
    try {
      await createSupportSession({
        tenantId: selected.id,
        ...(businessId ? { businessId } : {}),
        reason,
        expiresAt: new Date(Date.now() + Number(duration) * 60_000).toISOString(),
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
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('tenants.title')}</h1>
      <Table
        rows={tenants}
        columns={[
          { key: 'id', header: t('common.col.tenant'), render: (t) => <code>{t.id.slice(0, 8)}…</code> },
          { key: 'businesses', header: t('tenants.col.businesses'), align: 'end', render: (t) => t.businessCount },
          { key: 'created', header: t('common.col.created'), render: (t) => new Date(t.createdAt).toLocaleDateString() },
          {
            key: 'open',
            header: '',
            align: 'end',
            render: (row) => (
              <Button size="sm" variant="secondary" onClick={() => void openDetail(row)}>
                {t('tenants.open')}
              </Button>
            ),
          },
        ]}
      />
      <Dialog
        open={!!selected}
        title={t('tenants.dialog.title', { id: selected?.id.slice(0, 8) ?? '' })}
        onClose={() => {
          setSelected(null);
          setDetail(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              {t('common.close')}
            </Button>
            <Button onClick={() => setSessionOpen(true)}>{t('tenants.dialog.newSession')}</Button>
          </>
        }
      >
        {detail?.supportBanner ? (
          <div
            role="alert"
            style={{
              background: colors.semantic.warningSoft,
              color: colors.semantic.warning,
              border: `1px solid ${colors.semantic.warning}`,
              borderRadius: radius.md,
              padding: spacing[3],
              marginBottom: spacing[4],
              fontWeight: 600,
            }}
          >
            {detail.supportBanner.message}
          </div>
        ) : null}
        {detailError ? (
          <p role="alert" style={{ color: colors.semantic.danger }}>
            {detailError}
          </p>
        ) : null}
        {detail ? (
          <div style={{ fontFamily: typography.fontFamily.base }}>
            <h3 style={{ fontSize: typography.size.md }}>{t('tenants.dialog.businesses')}</h3>
            <ul>
              {detail.tenant.businesses.map((b) => (
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
        title={t('tenants.session.title')}
        onClose={() => setSessionOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSessionOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={reason.trim().length < 10} onClick={() => void startSession()}>
              {t('tenants.session.submit')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('tenants.session.reason')} value={reason} onChange={setReason} required />
          <Select
            label={t('tenants.session.scope')}
            value={businessId}
            onChange={setBusinessId}
            options={[
              { value: '', label: t('tenants.session.wholeTenant') },
              ...(detail?.tenant.businesses ?? []).map((b) => ({ value: b.id, label: t('tenants.session.business', { name: b.name }) })),
            ]}
          />
          <Select
            label={t('tenants.session.duration')}
            value={duration}
            onChange={setDuration}
            options={[
              { value: '30', label: t('tenants.session.min30') },
              { value: '60', label: t('tenants.session.hour1') },
              { value: '120', label: t('tenants.session.hour2') },
              { value: '240', label: t('tenants.session.hour4') },
            ]}
          />
        </div>
      </Dialog>
    </Shell>
  );
}
