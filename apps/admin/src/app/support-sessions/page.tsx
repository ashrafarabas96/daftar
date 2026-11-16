'use client';
import { useEffect, useState } from 'react';
import type { SupportSessionDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Table, TextField, typography } from '@daftar/design-system';
import { listSupportSessions, revokeSupportSession } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

export default function SupportSessionsPage() {
  const t = useT();
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
      <Badge tone="neutral">{t('common.revoked')}</Badge>
    ) : new Date(s.expiresAt) < new Date() ? (
      <Badge tone="neutral">{t('common.expired')}</Badge>
    ) : (
      <Badge tone="danger">{t('support.state.active')}</Badge>
    );

  return (
    <Shell active="support-sessions">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('support.title')}</h1>
      <Table
        rows={items}
        columns={[
          { key: 'tenant', header: t('common.col.tenant'), render: (s) => <code>{s.tenantId.slice(0, 8)}…</code> },
          {
            key: 'scope',
            header: t('support.col.scope'),
            render: (s) =>
              s.businessId ? (
                <Badge tone="info">{t('support.scope.business', { id: s.businessId.slice(0, 8) })}</Badge>
              ) : (
                <Badge tone="neutral">{t('support.scope.tenant')}</Badge>
              ),
          },
          { key: 'actor', header: t('common.col.actor'), render: (s) => <code>{s.actorUserId.slice(0, 8)}…</code> },
          { key: 'reason', header: t('common.col.reason'), render: (s) => s.reason },
          { key: 'expires', header: t('support.col.expires'), render: (s) => new Date(s.expiresAt).toLocaleString() },
          { key: 'state', header: t('common.col.state'), render: stateOf },
          {
            key: 'actions',
            header: '',
            align: 'end',
            render: (s) =>
              !s.revokedAt && new Date(s.expiresAt) > new Date() ? (
                <Button size="sm" variant="danger" onClick={() => setRevoking(s)}>
                  {t('common.revoke')}
                </Button>
              ) : null,
          },
        ]}
      />
      <Dialog
        open={!!revoking}
        title={t('support.dialog.title')}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => void revoke()}>
              {t('support.dialog.submit')}
            </Button>
          </>
        }
      >
        <p style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>{t('support.dialog.notice')}</p>
        <TextField label={t('common.reasonAudited')} value={reason} onChange={setReason} required />
      </Dialog>
    </Shell>
  );
}
