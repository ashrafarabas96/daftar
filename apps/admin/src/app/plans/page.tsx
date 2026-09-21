'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface Plan {
  key: string;
  name: string;
}

interface PlanVersion {
  id: string;
  plan_key: string;
  version: number;
  state: 'DRAFT' | 'PUBLISHED' | 'SUNSET';
  trial_days: number;
}

interface Diff {
  trialDays: { from: number | null; to: number | null; changed: boolean };
  features: { key: string; from: boolean | null; to: boolean | null }[];
  limits: { key: string; from: number | null; to: number | null }[];
}

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [clonePlan, setClonePlan] = useState('');
  const [trialDays, setTrialDays] = useState('');
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await apiFetch<{ items: Plan[]; versions?: PlanVersion[] }>('/api/proxy/admin/plans');
    setPlans(res.items);
    setVersions(res.versions ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function clone() {
    setBusy(true);
    try {
      await apiFetch('/api/proxy/admin/plan-versions', {
        method: 'POST',
        body: JSON.stringify({ planKey: clonePlan, ...(trialDays ? { trialDays: Number(trialDays) } : {}) }),
      });
      setCloneOpen(false);
      setTrialDays('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function showDiff(planKey: string, from: number, to: number) {
    const d = await apiFetch<Diff>(`/api/proxy/admin/plans/${planKey}/versions/diff?from=${from}&to=${to}`);
    setDiff(d);
    setDiffOpen(true);
  }

  async function transition(id: string, action: 'publish' | 'sunset') {
    await apiFetch(`/api/proxy/admin/plan-versions/${id}/${action}`, { method: 'POST', body: '{}' });
    await load();
  }

  const stateBadge = (s: PlanVersion['state']) =>
    s === 'PUBLISHED' ? <Badge tone="success">PUBLISHED (read-only)</Badge> : s === 'DRAFT' ? <Badge tone="warning">DRAFT</Badge> : <Badge tone="neutral">SUNSET</Badge>;

  return (
    <Shell active="plans">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>Plans</h1>
        <Button onClick={() => setCloneOpen(true)}>New version (clone)</Button>
      </div>
      <div style={{ marginTop: spacing[4] }}>
        <Table
          rows={versions}
          columns={[
            { key: 'plan', header: 'Plan', render: (v) => v.plan_key },
            { key: 'version', header: 'Version', render: (v) => `v${v.version}` },
            { key: 'state', header: 'State', render: (v) => stateBadge(v.state) },
            { key: 'trial', header: 'Trial days', align: 'end', render: (v) => v.trial_days },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (v) => (
                <span style={{ display: 'inline-flex', gap: spacing[1] }}>
                  {v.version > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => void showDiff(v.plan_key, v.version - 1, v.version)}>Diff</Button>
                  ) : null}
                  {v.state === 'DRAFT' ? (
                    <Button size="sm" variant="secondary" onClick={() => void transition(v.id, 'publish')}>Publish</Button>
                  ) : null}
                  {v.state === 'PUBLISHED' ? (
                    <Button size="sm" variant="ghost" onClick={() => void transition(v.id, 'sunset')}>Sunset</Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </div>
      <Dialog
        open={cloneOpen}
        title="Clone plan version"
        onClose={() => setCloneOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCloneOpen(false)}>Cancel</Button>
            <Button loading={busy} disabled={!clonePlan} onClick={() => void clone()}>Create draft</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <p style={{ margin: 0, color: colors.neutral[500], fontSize: typography.size.sm }}>
            Clones the latest version (features, limits, trial) into a new DRAFT. Published versions are immutable.
          </p>
          <div style={{ display: 'flex', gap: spacing[2], flexWrap: 'wrap' }}>
            {plans.map((p) => (
              <Button key={p.key} size="sm" variant={clonePlan === p.key ? 'primary' : 'secondary'} onClick={() => setClonePlan(p.key)}>
                {p.name}
              </Button>
            ))}
          </div>
          <TextField label="Trial days (optional override)" value={trialDays} onChange={setTrialDays} inputMode="numeric" />
        </div>
      </Dialog>
      <Dialog open={diffOpen} title="Version diff preview" onClose={() => setDiffOpen(false)}>
        {diff ? (
          <div style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
            {diff.trialDays.changed ? <p>Trial days: {diff.trialDays.from} → {diff.trialDays.to}</p> : null}
            {diff.features.filter((f) => f.from !== f.to).map((f) => (
              <p key={f.key}>Feature {f.key}: {String(f.from)} → {String(f.to)}</p>
            ))}
            {diff.limits.filter((l) => l.from !== l.to).map((l) => (
              <p key={l.key}>Limit {l.key}: {String(l.from)} → {String(l.to)}</p>
            ))}
            {!diff.trialDays.changed && diff.features.every((f) => f.from === f.to) && diff.limits.every((l) => l.from === l.to) ? (
              <p>No changes between versions.</p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </Shell>
  );
}
