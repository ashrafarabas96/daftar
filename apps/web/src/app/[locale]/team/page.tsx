'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BranchDto, InvitationDto, MemberDto, RoleDto } from '@daftar/shared-contracts';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmationDialog,
  Dialog,
  PlanLimitState,
  Select,
  Table,
  Tabs,
  TextField,
  colors,
  spacing,
  typography,
} from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession } from '@/lib/client';
import {
  cancelInvitation,
  inviteMember,
  listBranches,
  listInvitations,
  listMembers,
  listRoles,
  reactivateMember,
  removeMember,
  resendInvitation,
  setMemberBranchScope,
  setMemberRoles,
  suspendMember,
} from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

/** Team (Directive §62): members, invitations, roles per member, branch access, suspend/reactivate/remove. */
export default function TeamPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [tab, setTab] = useState('members');
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('cashier');
  const [editing, setEditing] = useState<MemberDto | null>(null);
  const [editRoles, setEditRoles] = useState<Set<string>>(new Set());
  const [editMode, setEditMode] = useState<'all' | 'assigned'>('all');
  const [editBranches, setEditBranches] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);

  async function load() {
    const [m, i, r, b] = await Promise.all([listMembers(), listInvitations(), listRoles(), listBranches().catch(() => ({ items: [] as BranchDto[] }))]);
    setMembers(m.items);
    setInvitations(i.items);
    setRoles(r.items);
    setBranches(b.items);
  }

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      await load();
    })();
  }, [locale, router]);

  function explain(e: unknown): string {
    if (e instanceof ApiError && e.code === 'LAST_OWNER_REMOVAL') return t('team.lastOwner');
    if (e instanceof ApiError && e.code === 'ALREADY_MEMBER') return t('team.alreadyMember');
    if (e instanceof ApiError && e.code === 'INVITATION_EXISTS') return t('team.inviteExists');
    if (e instanceof ApiError && e.status === 403) return t('common.noPermission');
    return t('error.generic');
  }

  async function invite() {
    setBusy(true);
    setError(null);
    setLimit(false);
    try {
      await inviteMember(email, roleKey);
      setOpen(false);
      setEmail('');
      setNote(t('team.invited'));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PLAN_LIMIT_EXCEEDED') {
        setLimit(true);
        setOpen(false);
      } else setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  function openEditor(m: MemberDto) {
    setEditing(m);
    setEditRoles(new Set(m.roleKeys));
    setEditMode(m.branchScopeMode);
    setEditBranches(new Set(m.allowedBranchIds));
    setError(null);
  }

  async function saveEditor() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const nextRoles = [...editRoles];
      if (nextRoles.sort().join() !== [...editing.roleKeys].sort().join()) await setMemberRoles(editing.userId, nextRoles);
      const nextBranches = [...editBranches];
      if (editMode !== editing.branchScopeMode || nextBranches.sort().join() !== [...editing.allowedBranchIds].sort().join()) {
        await setMemberBranchScope(editing.userId, editMode === 'all' ? { mode: 'all' } : { mode: 'assigned', branchIds: nextBranches });
      }
      setEditing(null);
      await load();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(explain(e));
    }
  }

  const statusBadge = (status: string) =>
    status === 'active' ? (
      <Badge tone="success">{t('team.active')}</Badge>
    ) : status === 'suspended' ? (
      <Badge tone="danger">{t('team.suspended')}</Badge>
    ) : (
      <Badge tone="warning">{t('team.pending')}</Badge>
    );
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <PageShell locale={locale} active="team">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('team.title')}</h1>
        <Button onClick={() => setOpen(true)}>{t('team.invite')}</Button>
      </div>
      {limit ? <PlanLimitState title={t('team.limitReached')} upgradeLabel={t('nav.plan')} onUpgrade={() => router.push(`/${locale}/plan`)} /> : null}
      {error ? (
        <p role="alert" style={{ color: colors.semantic.danger, fontFamily: typography.fontFamily.base }}>
          {error}
        </p>
      ) : null}
      <Tabs
        tabs={[
          { key: 'members', label: t('team.members') },
          { key: 'invitations', label: t('team.invitations') },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: spacing[4] }}>
        {tab === 'members' ? (
          <Table
            rows={members.map((m) => ({ ...m, id: m.userId }))}
            columns={[
              { key: 'name', header: t('auth.displayName'), render: (m) => m.displayName },
              { key: 'email', header: t('auth.email'), render: (m) => m.email ?? '—' },
              { key: 'roles', header: t('team.role'), render: (m) => m.roleKeys.join(', ') },
              {
                key: 'scope',
                header: t('team.branchAccess'),
                render: (m) => (m.branchScopeMode === 'all' ? t('team.allBranches') : m.allowedBranchIds.map(branchName).join(', ') || t('team.noBranches')),
              },
              { key: 'status', header: t('team.status'), render: (m) => statusBadge(m.status) },
              {
                key: 'actions',
                header: '',
                align: 'end',
                render: (m) => (
                  <span style={{ display: 'inline-flex', gap: spacing[1], flexWrap: 'wrap' }}>
                    <Button variant="ghost" size="sm" onClick={() => openEditor(m)}>
                      {t('team.edit')}
                    </Button>
                    {m.status === 'active' ? (
                      <Button variant="ghost" size="sm" onClick={() => void act(() => suspendMember(m.userId))}>
                        {t('team.suspend')}
                      </Button>
                    ) : m.status === 'suspended' ? (
                      <Button variant="ghost" size="sm" onClick={() => void act(() => reactivateMember(m.userId))}>
                        {t('team.reactivate')}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(m)}>
                      {t('team.remove')}
                    </Button>
                  </span>
                ),
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
                key: 'delivery',
                header: t('team.delivery'),
                render: (i) => (
                  <Badge tone={i.deliveryStatus === 'sent' ? 'success' : i.deliveryStatus === 'dead' ? 'danger' : 'neutral'}>{i.deliveryStatus}</Badge>
                ),
              },
              {
                key: 'actions',
                header: '',
                align: 'end',
                render: (i) =>
                  i.status === 'pending' ? (
                    <span style={{ display: 'inline-flex', gap: spacing[2] }}>
                      <Button variant="ghost" size="sm" onClick={() => void act(() => resendInvitation(i.id))}>
                        {t('team.resend')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void act(() => cancelInvitation(i.id))}>
                        {t('team.cancelInvite')}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        )}
      </div>
      {note ? (
        <p role="status" style={{ fontFamily: typography.fontFamily.base }}>
          {note}
        </p>
      ) : null}
      <Dialog
        open={open}
        title={t('team.invite')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!email.includes('@')} onClick={() => void invite()}>
              {t('team.invite')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('team.inviteEmail')} type="email" required value={email} onChange={setEmail} />
          <Select
            label={t('team.role')}
            value={roleKey}
            onChange={setRoleKey}
            options={roles.filter((r) => r.key !== 'owner').map((r) => ({ value: r.key, label: r.name }))}
          />
        </div>
      </Dialog>
      <Dialog
        open={!!editing}
        title={editing ? `${t('team.edit')} — ${editing.displayName}` : ''}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={editRoles.size === 0} onClick={() => void saveEditor()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[3], fontFamily: typography.fontFamily.base }}>
          <p style={{ margin: 0, fontSize: typography.size.sm, color: colors.neutral[500] }}>{t('team.role')}</p>
          {roles.map((r) => (
            <Checkbox
              key={r.key}
              label={r.name}
              checked={editRoles.has(r.key)}
              disabled={r.key === 'owner' && !editing?.roleKeys.includes('owner')}
              onChange={(v) => {
                const next = new Set(editRoles);
                if (v) next.add(r.key);
                else next.delete(r.key);
                setEditRoles(next);
              }}
            />
          ))}
          <Select
            label={t('team.branchAccess')}
            value={editMode}
            onChange={(v) => setEditMode(v as 'all' | 'assigned')}
            options={[
              { value: 'all', label: t('team.allBranches') },
              { value: 'assigned', label: t('team.assignedBranches') },
            ]}
          />
          {editMode === 'assigned'
            ? branches.map((b) => (
                <Checkbox
                  key={b.id}
                  label={b.name}
                  checked={editBranches.has(b.id)}
                  onChange={(v) => {
                    const next = new Set(editBranches);
                    if (v) next.add(b.id);
                    else next.delete(b.id);
                    setEditBranches(next);
                  }}
                />
              ))
            : null}
        </div>
      </Dialog>
      <ConfirmationDialog
        open={!!removing}
        title={t('team.remove')}
        message={t('team.removeConfirm')}
        confirmLabel={t('team.remove')}
        cancelLabel={t('common.cancel')}
        danger
        loading={busy}
        onConfirm={() => {
          if (!removing) return;
          setBusy(true);
          void act(() => removeMember(removing.userId)).finally(() => {
            setBusy(false);
            setRemoving(null);
          });
        }}
        onCancel={() => setRemoving(null)}
      />
    </PageShell>
  );
}
