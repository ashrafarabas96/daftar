'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PERMISSIONS, type RoleDto } from '@daftar/shared-contracts';
import { Badge, Button, Checkbox, Dialog, FeatureLockedState, Select, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession } from '@/lib/client';
import { createRole, deleteRole, listRoles, updateRole } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

/** Custom roles (Directive §62 "Roles"): create / edit permissions / delete with replacement. System roles are read-only. */
export default function RolesPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [editing, setEditing] = useState<RoleDto | 'new' | null>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<RoleDto | null>(null);
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  async function load() {
    setRoles((await listRoles()).items);
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

  function openEditor(role: RoleDto | 'new') {
    setEditing(role);
    setKey(role === 'new' ? '' : role.key);
    setName(role === 'new' ? '' : role.name);
    setPermissions(new Set(role === 'new' ? [] : role.permissions));
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') await createRole(key.trim(), name.trim(), [...permissions]);
      else if (editing) await updateRole(editing.id, { name: name.trim(), permissions: [...permissions] });
      setEditing(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FEATURE_NOT_ENTITLED') {
        setLocked(true);
        setEditing(null);
      } else setError(e instanceof ApiError && e.status === 403 ? t('roles.ceiling') : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteRole(deleting.id, replacement || undefined);
      setDeleting(null);
      await load();
    } catch {
      setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="roles">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('roles.title')}</h1>
        <Button onClick={() => openEditor('new')}>{t('roles.new')}</Button>
      </div>
      {locked ? <FeatureLockedState title={t('roles.locked')} upgradeLabel={t('nav.plan')} onUpgrade={() => router.push(`/${locale}/plan`)} /> : null}
      {error ? (
        <p role="alert" style={{ color: colors.semantic.danger }}>
          {error}
        </p>
      ) : null}
      <div style={{ marginTop: spacing[4] }}>
        <Table
          rows={roles}
          columns={[
            { key: 'name', header: t('roles.name'), render: (r) => r.name },
            { key: 'key', header: t('roles.key'), render: (r) => <code>{r.key}</code> },
            { key: 'perms', header: t('roles.permissions'), render: (r) => (r.isSystem && r.key === 'owner' ? t('roles.all') : String(r.permissions.length)) },
            {
              key: 'kind',
              header: '',
              render: (r) => (r.isSystem ? <Badge tone="neutral">{t('roles.system')}</Badge> : <Badge tone="brand">{t('roles.custom')}</Badge>),
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (r) =>
                r.isSystem ? null : (
                  <span style={{ display: 'inline-flex', gap: spacing[2] }}>
                    <Button size="sm" variant="ghost" onClick={() => openEditor(r)}>
                      {t('roles.edit')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                      {t('common.delete')}
                    </Button>
                  </span>
                ),
            },
          ]}
        />
      </div>
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? t('roles.new') : t('roles.edit')}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!name.trim() || (editing === 'new' && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(key))} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[3] }}>
          {editing === 'new' ? (
            <TextField label={t('roles.key')} required value={key} onChange={(v) => setKey(v.toLowerCase())} hint={t('roles.keyHint')} />
          ) : null}
          <TextField label={t('roles.name')} required value={name} onChange={setName} />
          <p style={{ margin: 0, fontFamily: typography.fontFamily.base, fontSize: typography.size.sm, color: colors.neutral[500] }}>
            {t('roles.permissions')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))' }}>
            {PERMISSIONS.map((p) => (
              <Checkbox
                key={p}
                label={p}
                checked={permissions.has(p)}
                onChange={(v) => {
                  const next = new Set(permissions);
                  if (v) next.add(p);
                  else next.delete(p);
                  setPermissions(next);
                }}
              />
            ))}
          </div>
        </div>
      </Dialog>
      <Dialog
        open={!!deleting}
        title={t('roles.deleteTitle')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <Select
          label={t('roles.replacement')}
          value={replacement}
          onChange={setReplacement}
          hint={t('roles.replacementHint')}
          options={[
            { value: '', label: '—' },
            ...roles.filter((r) => r.id !== deleting?.id && r.key !== 'owner').map((r) => ({ value: r.key, label: r.name })),
          ]}
        />
      </Dialog>
    </PageShell>
  );
}
