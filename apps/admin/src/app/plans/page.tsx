'use client';
import { useEffect, useState } from 'react';
import type { PlanDto, PlanVersionDiffDto, PlanVersionDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Switch, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { ApiError } from '@/lib/client';
import { createPlan, createPlanVersion, diffPlanVersions, listPlans, publishPlanVersion, sunsetPlanVersion, updateDraftPlanVersion } from '@/lib/admin-api';
import { Shell } from '../Shell';

/**
 * Plan builder (Directive §29), end-to-end: Create Plan → Draft Version →
 * Clone Version → Edit Features → Edit Limits → Trial Days → Diff → Publish →
 * Sunset → next Version. Published versions are immutable (DB-enforced).
 */
export default function PlansPage() {
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Create plan
  const [planOpen, setPlanOpen] = useState(false);
  const [planKey, setPlanKey] = useState('');
  const [planName, setPlanName] = useState('');
  // Version editor (clone or edit draft)
  const [editor, setEditor] = useState<{ mode: 'clone'; planKey: string; base: PlanVersionDto } | { mode: 'edit'; version: PlanVersionDto } | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [trialDays, setTrialDays] = useState('');
  const [newLimitKey, setNewLimitKey] = useState('');
  const [newFeatureKey, setNewFeatureKey] = useState('');
  // Diff
  const [diff, setDiff] = useState<PlanVersionDiffDto | null>(null);

  async function load() {
    try {
      setPlans((await listPlans()).items);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'Failed to load plans');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function openEditor(next: NonNullable<typeof editor>) {
    const base = next.mode === 'clone' ? next.base : next.version;
    setFeatures({ ...base.features });
    setLimits(Object.fromEntries(Object.entries(base.limits).map(([k, v]) => [k, String(v)])));
    setTrialDays(String(base.trialDays));
    setEditor(next);
  }

  async function saveEditor() {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      const changes = {
        features,
        limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number(v)])),
        trialDays: Number(trialDays),
      };
      if (editor.mode === 'clone') await createPlanVersion(editor.planKey, changes);
      else await updateDraftPlanVersion(editor.version.id, changes);
      setEditor(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function savePlan() {
    setBusy(true);
    setError(null);
    try {
      await createPlan(planKey.trim(), planName.trim());
      setPlanOpen(false);
      setPlanKey('');
      setPlanName('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  async function transition(v: PlanVersionDto, action: 'publish' | 'sunset') {
    setError(null);
    try {
      await (action === 'publish' ? publishPlanVersion(v.id) : sunsetPlanVersion(v.id));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : `${action} failed`);
    }
  }

  const stateBadge = (s: PlanVersionDto['state']) =>
    s === 'PUBLISHED' ? (
      <Badge tone="success">PUBLISHED (immutable)</Badge>
    ) : s === 'DRAFT' ? (
      <Badge tone="warning">DRAFT</Badge>
    ) : (
      <Badge tone="neutral">SUNSET</Badge>
    );

  const versions = plans.flatMap((p) => p.versions.map((v) => ({ ...v, planName: p.name })));

  return (
    <Shell active="plans">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>Plans</h1>
        <Button onClick={() => setPlanOpen(true)}>New plan</Button>
      </div>
      {error ? (
        <p role="alert" style={{ color: colors.semantic.danger }}>
          {error}
        </p>
      ) : null}
      <div style={{ marginTop: spacing[4] }}>
        <Table
          rows={versions}
          columns={[
            { key: 'plan', header: 'Plan', render: (v) => `${v.planName} (${v.planKey})` },
            { key: 'version', header: 'Version', render: (v) => `v${v.version}` },
            { key: 'state', header: 'State', render: (v) => stateBadge(v.state) },
            { key: 'trial', header: 'Trial days', align: 'end', render: (v) => v.trialDays },
            {
              key: 'summary',
              header: 'Features / limits',
              render: (v) =>
                `${Object.values(v.features).filter(Boolean).length}/${Object.keys(v.features).length} on · ${Object.entries(v.limits)
                  .map(([k, n]) => `${k}=${n === -1 ? '∞' : n}`)
                  .join(', ')}`,
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (v) => (
                <span style={{ display: 'inline-flex', gap: spacing[1], flexWrap: 'wrap' }}>
                  {v.version > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => void diffPlanVersions(v.planKey, v.version - 1, v.version).then(setDiff)}>
                      Diff
                    </Button>
                  ) : null}
                  {v.state === 'DRAFT' ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => openEditor({ mode: 'edit', version: v })}>
                        Edit draft
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => void transition(v, 'publish')}>
                        Publish
                      </Button>
                    </>
                  ) : null}
                  {v.state === 'PUBLISHED' ? (
                    <Button size="sm" variant="ghost" onClick={() => void transition(v, 'sunset')}>
                      Sunset
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => openEditor({ mode: 'clone', planKey: v.planKey, base: v })}>
                    Clone → next version
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </div>

      <Dialog
        open={planOpen}
        title="Create plan"
        onClose={() => setPlanOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!/^[a-z][a-z0-9_-]{1,31}$/.test(planKey) || planName.trim().length < 2} onClick={() => void savePlan()}>
              Create plan (v1 draft)
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label="Plan key (a-z, 0-9, -, _)" value={planKey} onChange={setPlanKey} required />
          <TextField label="Display name" value={planName} onChange={setPlanName} required />
          <p style={{ margin: 0, color: colors.neutral[500], fontSize: typography.size.sm }}>
            The plan starts with an empty DRAFT v1. Edit its features, limits and trial days, then publish.
          </p>
        </div>
      </Dialog>

      <Dialog
        open={!!editor}
        title={
          editor?.mode === 'clone'
            ? `Clone ${editor.planKey} v${editor.base.version} → new DRAFT`
            : `Edit DRAFT v${editor?.mode === 'edit' ? editor.version.version : ''}`
        }
        onClose={() => setEditor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void saveEditor()}>
              {editor?.mode === 'clone' ? 'Create draft' : 'Save draft'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4], fontFamily: typography.fontFamily.base }}>
          <TextField label="Trial days" value={trialDays} onChange={setTrialDays} inputMode="numeric" />
          <h3 style={{ margin: 0, fontSize: typography.size.md }}>Features</h3>
          {Object.entries(features).map(([key, enabled]) => (
            <Switch key={key} label={key} checked={enabled} onChange={(v) => setFeatures({ ...features, [key]: v })} />
          ))}
          <div style={{ display: 'flex', gap: spacing[2], alignItems: 'flex-end' }}>
            <TextField label="Add feature key" value={newFeatureKey} onChange={setNewFeatureKey} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!newFeatureKey.trim()}
              onClick={() => {
                setFeatures({ ...features, [newFeatureKey.trim()]: false });
                setNewFeatureKey('');
              }}
            >
              Add
            </Button>
          </div>
          <h3 style={{ margin: 0, fontSize: typography.size.md }}>Limits (-1 = unlimited)</h3>
          {Object.entries(limits).map(([key, value]) => (
            <TextField key={key} label={key} value={value} onChange={(v) => setLimits({ ...limits, [key]: v })} inputMode="numeric" />
          ))}
          <div style={{ display: 'flex', gap: spacing[2], alignItems: 'flex-end' }}>
            <TextField label="Add limit key" value={newLimitKey} onChange={setNewLimitKey} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!newLimitKey.trim()}
              onClick={() => {
                setLimits({ ...limits, [newLimitKey.trim()]: '0' });
                setNewLimitKey('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!diff} title="Version diff preview" onClose={() => setDiff(null)}>
        {diff ? (
          <div style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
            <p style={{ color: colors.neutral[500] }}>
              {diff.planKey}: v{diff.fromVersion} → v{diff.toVersion}
            </p>
            {diff.trialDays.changed ? (
              <p>
                Trial days: {diff.trialDays.from} → {diff.trialDays.to}
              </p>
            ) : null}
            {diff.features.map((f) => (
              <p key={f.key}>
                Feature {f.key}: {String(f.from)} → {String(f.to)}
              </p>
            ))}
            {diff.limits.map((l) => (
              <p key={l.key}>
                Limit {l.key}: {String(l.from)} → {String(l.to)}
              </p>
            ))}
            {!diff.trialDays.changed && diff.features.length === 0 && diff.limits.length === 0 ? <p>No changes between versions.</p> : null}
          </div>
        ) : null}
      </Dialog>
    </Shell>
  );
}
