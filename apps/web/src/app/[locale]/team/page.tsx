'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InvitationDto, MemberDto, RoleDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Select, Table, Tabs, TextField, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { refreshSession } from '@/lib/client';
import {
  inviteMember, listInvitations, listMembers, listRoles,
  reactivateMember, resendInvitation, cancelInvitation, suspendMember,
} from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

export default function TeamPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [tab, setTab] = useState('members');
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('cashier');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const [m, i, r] = await Promise.all([listMembers(), listInvitations(), listRoles()]);
    setMembers(m.items);
    setInvitations(i.items);
    setRoles(r.items);
  }

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      await load();
    })();
  }, [locale]);

  async function invite() {
    setBusy(true);
    try {
      await inviteMember(email, roleKey);
      setOpen(false);
      setEmail('');
      setNote(t('team.invited'));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = (status: string) =>
    status === 'active' ? <Badge tone="success">{t('team.active')}</Badge> : status === 'suspended' ? <Badge tone="danger">{t('team.suspended')}</Badge> : <Badge tone="warning">{t('team.pending')}</Badge>;

  return (
    <PageShell locale={locale} active="team">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('team.title')}</h1>
        <Button onClick={() => setOpen(true)}>{t('team.invite')}</Button>
      </div>
      <Tabs tabs={[{ key: 'members', label: t('team.members') }, { key: 'invitations', label: t('team.invitations') }]} active={tab} onChange={setTab} />
      <div style={{ marginTop: spacing[4] }}>
        {tab === 'members' ? (
          <Table
            rows={members.map((m) => ({ ...m, id: m.userId }))}
            columns={[
              { key: 'name', header: t('auth.displayName'), render: (m) => m.displayName },
              { key: 'email', header: t('auth.email'), render: (m) => m.email ?? '—' },
              { key: 'roles', header: t('team.role'), render: (m) => m.roleKeys.join(', ') },
              { key: 'status', header: t('team.status'), render: (m) => statusBadge(m.status) },
              {
                key: 'actions',
                header: '',
                align: 'end',
                render: (m) =>
                  m.status === 'active' ? (
                    <Button variant="ghost" size="sm" onClick={() => void suspendMember(m.userId).then(load)}>{t('team.suspend')}</Button>
                  ) : m.status === 'suspended' ? (
                    <Button variant="ghost" size="sm" onClick={() => void reactivateMember(m.userId).then(load)}>{t('team.reactivate')}</Button>
                  ) : null,
              },
            ]}
          />
        ) : (
          <Table
            rows={invitations}
            columns={[
              { key: 'email', header: t('auth.email'), render: (i) => i.email },
              { key: 'role', header: t('team.role'), render: (i) => i.roleKey },
              { key: 'status', header: t('team.status'), render: (i) => statusBadge(i.status) },
              {
                key: 'actions',
                header: '',
                align: 'end',
                render: (i) =>
                  i.status === 'pending' ? (
                    <span style={{ display: 'inline-flex', gap: spacing[2] }}>
                      <Button variant="ghost" size="sm" onClick={() => void resendInvitation(i.id).then(load)}>{t('team.resend')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => void cancelInvitation(i.id).then(load)}>{t('team.cancelInvite')}</Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        )}
      </div>
      {note ? <p role="status" style={{ fontFamily: typography.fontFamily.base }}>{note}</p> : null}
      <Dialog
        open={open}
        title={t('team.invite')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={busy} disabled={!email.includes('@')} onClick={() => void invite()}>{t('team.invite')}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('team.inviteEmail')} type="email" required value={email} onChange={setEmail} />
          <Select label={t('team.role')} value={roleKey} onChange={setRoleKey} options={roles.map((r) => ({ value: r.key, label: r.name }))} />
        </div>
      </Dialog>
    </PageShell>
  );
}
