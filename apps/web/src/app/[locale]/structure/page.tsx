'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BranchDto, WarehouseDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, FeatureLockedState, PlanLimitState, Select, Table, Tabs, TextField, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession } from '@/lib/client';
import { createBranch, createWarehouse, listBranches, listWarehouses } from '@/lib/merchant-api';
import { addWarehouseBranch, getInventoryAccess, listInventoryWarehouses, removeWarehouseBranch, type InventoryWarehouseDto } from '@/lib/phase3-api';
import { refusalKey } from '@/lib/phase3-errors';
import { WarehouseBranches } from '@/views/structure/WarehouseBranches';
import { PageShell } from '../AppHeader';

/** Branches & warehouses (Directive §62). Feature/limit gates surface as honest states, never silent failures. */
export default function StructurePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [tab, setTab] = useState('branches');
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  const [open, setOpen] = useState<'branch' | 'warehouse' | null>(null);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<'feature' | 'limit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [b, w] = await Promise.all([listBranches(), listWarehouses()]);
    setBranches(b.items);
    setWarehouses(w.items);
    if (!branchId && b.items[0]) setBranchId(b.items[0].id);
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

  async function save() {
    setBusy(true);
    setError(null);
    setGate(null);
    try {
      if (open === 'branch') await createBranch(name.trim());
      else await createWarehouse(branchId, name.trim());
      setOpen(null);
      setName('');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FEATURE_NOT_ENTITLED') setGate('feature');
      else if (e instanceof ApiError && e.code === 'PLAN_LIMIT_EXCEEDED') setGate('limit');
      else if (e instanceof ApiError && e.status === 403) setError(t('common.noPermission'));
      else setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? '—';

  return (
    <PageShell locale={locale} active="structure">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('structure.title')}</h1>
        <Button onClick={() => setOpen(tab === 'branches' ? 'branch' : 'warehouse')}>
          {tab === 'branches' ? t('structure.newBranch') : t('structure.newWarehouse')}
        </Button>
      </div>
      <Tabs
        tabs={[
          { key: 'branches', label: t('structure.branches') },
          { key: 'warehouses', label: t('structure.warehouses') },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: spacing[4] }}>
        {gate === 'feature' ? (
          <FeatureLockedState title={t('structure.multiBranchLocked')} upgradeLabel={t('nav.plan')} onUpgrade={() => router.push(`/${locale}/plan`)} />
        ) : null}
        {gate === 'limit' ? (
          <PlanLimitState title={t('structure.limitReached')} upgradeLabel={t('nav.plan')} onUpgrade={() => router.push(`/${locale}/plan`)} />
        ) : null}
        {error ? (
          <p role="alert" style={{ fontFamily: typography.fontFamily.base }}>
            {error}
          </p>
        ) : null}
        {tab === 'branches' ? (
          <Table
            rows={branches}
            columns={[
              { key: 'name', header: t('structure.name'), render: (b) => b.name },
              { key: 'default', header: '', render: (b) => (b.isDefault ? <Badge tone="brand">{t('structure.default')}</Badge> : null) },
            ]}
          />
        ) : (
          <>
            <Table
              rows={warehouses}
              columns={[
                { key: 'name', header: t('structure.name'), render: (w) => w.name },
                { key: 'branch', header: t('structure.branch'), render: (w) => branchName(w.branchId) },
                { key: 'default', header: '', render: (w) => (w.isDefault ? <Badge tone="brand">{t('structure.default')}</Badge> : null) },
              ]}
            />
            <WarehouseReach locale={locale} branches={branches} warehouseCount={warehouses.length} />
          </>
        )}
      </div>
      <Dialog
        open={open !== null}
        title={open === 'branch' ? t('structure.newBranch') : t('structure.newWarehouse')}
        onClose={() => setOpen(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!name.trim() || (open === 'warehouse' && !branchId)} onClick={() => void save()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('structure.name')} required value={name} onChange={setName} autoFocus />
          {open === 'warehouse' ? (
            <Select label={t('structure.branch')} value={branchId} onChange={setBranchId} options={branches.map((b) => ({ value: b.id, label: b.name }))} />
          ) : null}
        </div>
      </Dialog>
    </PageShell>
  );
}

/**
 * "Also serves branches" (P3-S7 A-11, A-05): which branches each warehouse
 * serves, from `GET /v1/inventory/warehouses`, changed with
 * `POST`/`DELETE …/warehouses/:id/branches` (each states its end state and
 * answers `changed: false` on a repeat). Shown only to a member with
 * `warehouse.manage` and access to every branch, the authority the command
 * itself requires. The Phase 1 table above stays as it was.
 */
function WarehouseReach({ locale, branches, warehouseCount }: { locale: Locale; branches: readonly BranchDto[]; warehouseCount: number }) {
  const t = makeT(locale);
  const [allowed, setAllowed] = useState(false);
  const [reach, setReach] = useState<InventoryWarehouseDto[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const access = await getInventoryAccess();
        if (!live || !access.businessWide || !access.permissions.includes('warehouse.manage')) return;
        const w = await listInventoryWarehouses();
        if (!live) return;
        setReach(w.items);
        setAllowed(true);
      } catch (e) {
        if (live) setErrorKey(refusalKey(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [warehouseCount]);

  async function change(warehouseId: string, branchId: string, serve: boolean) {
    setBusyKey(`${warehouseId}:${branchId}`);
    setErrorKey(null);
    try {
      if (serve) await addWarehouseBranch(warehouseId, branchId);
      else await removeWarehouseBranch(warehouseId, branchId);
      setReach((await listInventoryWarehouses()).items);
    } catch (e) {
      setErrorKey(refusalKey(e));
    } finally {
      setBusyKey(null);
    }
  }

  if (!allowed) {
    // The grants or the warehouses could not be read: say so, rather than hide the section in silence.
    return errorKey !== null ? (
      <p role="alert" style={{ fontFamily: typography.fontFamily.base, marginTop: spacing[6] }}>
        {t(errorKey)}
      </p>
    ) : null;
  }
  return (
    <div style={{ marginTop: spacing[6] }}>
      <WarehouseBranches
        t={t}
        locale={locale}
        warehouses={reach}
        branches={branches}
        busyKey={busyKey}
        errorKey={errorKey}
        onAdd={(warehouseId, branchId) => void change(warehouseId, branchId, true)}
        onRemove={(warehouseId, branchId) => void change(warehouseId, branchId, false)}
      />
    </div>
  );
}
