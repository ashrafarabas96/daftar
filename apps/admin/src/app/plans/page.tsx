'use client';
import { useEffect, useState } from 'react';
import type { PlanDto, PlanVersionDiffDto, PlanVersionDto } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, Switch, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { ApiError } from '@/lib/client';
import { createPlan, createPlanVersion, diffPlanVersions, listPlans, publishPlanVersion, sunsetPlanVersion, updateDraftPlanVersion } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

/**
 * Plan builder (Directive §29), end-to-end: Create Plan → Draft Version →
 * Clone Version → Edit Features → Edit Limits → Trial Days → Diff → Publish →
 * Sunset → next Version. Published versions are immutable (DB-enforced).
 */
export default function PlansPage() {
  const t = useT();
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
      setError(e instanceof ApiError ? e.code : t('plans.error.loadFailed'));
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
      setError(e instanceof ApiError ? e.code : t('plans.error.saveFailed'));
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
      setError(e instanceof ApiError ? e.code : t('plans.error.createFailed'));
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
      setError(e instanceof ApiError ? e.code : t(action === 'publish' ? 'plans.error.publishFailed' : 'plans.error.sunsetFailed'));
    }
  }

  const stateBadge = (s: PlanVersionDto['state']) =>
    s === 'PUBLISHED' ? (
      <Badge tone="success">{t('plans.state.published')}</Badge>
    ) : s === 'DRAFT' ? (
      <Badge tone="warning">{t('plans.state.draft')}</Badge>
    ) : (
      <Badge tone="neutral">{t('plans.state.sunset')}</Badge>
    );

  const versions = plans.flatMap((p) => p.versions.map((v) => ({ ...v, planName: p.name })));

  return (
    <Shell active="plans">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('plans.title')}</h1>
        <Button onClick={() => setPlanOpen(true)}>{t('plans.new')}</Button>
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
            { key: 'plan', header: t('common.col.plan'), render: (v) => `${v.planName} (${v.planKey})` },
            { key: 'version', header: t('common.col.version'), render: (v) => `v${v.version}` },
            { key: 'state', header: t('common.col.state'), render: (v) => stateBadge(v.state) },
            { key: 'trial', header: t('plans.col.trialDays'), align: 'end', render: (v) => v.trialDays },
            {
              key: 'summary',
              header: t('plans.col.featuresLimits'),
              render: (v) =>
                t('plans.summary', {
                  on: Object.values(v.features).filter(Boolean).length,
                  total: Object.keys(v.features).length,
                  limits: Object.entries(v.limits)
                    .map(([k, n]) => `${k}=${n === -1 ? '∞' : n}`)
                    .join(', '),
                }),
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (v) => (
                <span style={{ display: 'inline-flex', gap: spacing[1], flexWrap: 'wrap' }}>
                  {v.version > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => void diffPlanVersions(v.planKey, v.version - 1, v.version).then(setDiff)}>
                      {t('plans.action.diff')}
                    </Button>
                  ) : null}
                  {v.state === 'DRAFT' ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => openEditor({ mode: 'edit', version: v })}>
                        {t('plans.action.editDraft')}
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => void transition(v, 'publish')}>
                        {t('plans.action.publish')}
                      </Button>
                    </>
                  ) : null}
                  {v.state === 'PUBLISHED' ? (
                    <Button size="sm" variant="ghost" onClick={() => void transition(v, 'sunset')}>
                      {t('plans.action.sunset')}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => openEditor({ mode: 'clone', planKey: v.planKey, base: v })}>
                    {t('plans.action.clone')}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </div>

      <Dialog
        open={planOpen}
        title={t('plans.create.title')}
        onClose={() => setPlanOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!/^[a-z][a-z0-9_-]{1,31}$/.test(planKey) || planName.trim().length < 2} onClick={() => void savePlan()}>
              {t('plans.create.submit')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('plans.create.keyLabel')} value={planKey} onChange={setPlanKey} required />
          <TextField label={t('plans.create.displayName')} value={planName} onChange={setPlanName} required />
          <p style={{ margin: 0, color: colors.neutral[500], fontSize: typography.size.sm }}>{t('plans.create.note')}</p>
        </div>
      </Dialog>

      <Dialog
        open={!!editor}
        title={
          editor?.mode === 'clone'
            ? t('plans.editor.cloneTitle', { planKey: editor.planKey, version: editor.base.version })
            : t('plans.editor.editTitle', { version: editor?.mode === 'edit' ? editor.version.version : '' })
        }
        onClose={() => setEditor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} onClick={() => void saveEditor()}>
              {editor?.mode === 'clone' ? t('plans.editor.createDraft') : t('plans.editor.saveDraft')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4], fontFamily: typography.fontFamily.base }}>
          <TextField label={t('plans.editor.trialDays')} value={trialDays} onChange={setTrialDays} inputMode="numeric" />
          <h3 style={{ margin: 0, fontSize: typography.size.md }}>{t('plans.editor.features')}</h3>
          {Object.entries(features).map(([key, enabled]) => (
            <Switch key={key} label={key} checked={enabled} onChange={(v) => setFeatures({ ...features, [key]: v })} />
          ))}
          <div style={{ display: 'flex', gap: spacing[2], alignItems: 'flex-end' }}>
            <TextField label={t('plans.editor.addFeatureKey')} value={newFeatureKey} onChange={setNewFeatureKey} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!newFeatureKey.trim()}
              onClick={() => {
                setFeatures({ ...features, [newFeatureKey.trim()]: false });
                setNewFeatureKey('');
              }}
            >
              {t('common.add')}
            </Button>
          </div>
          <h3 style={{ margin: 0, fontSize: typography.size.md }}>{t('plans.editor.limits')}</h3>
          {Object.entries(limits).map(([key, value]) => (
            <TextField key={key} label={key} value={value} onChange={(v) => setLimits({ ...limits, [key]: v })} inputMode="numeric" />
          ))}
          <div style={{ display: 'flex', gap: spacing[2], alignItems: 'flex-end' }}>
            <TextField label={t('plans.editor.addLimitKey')} value={newLimitKey} onChange={setNewLimitKey} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!newLimitKey.trim()}
              onClick={() => {
                setLimits({ ...limits, [newLimitKey.trim()]: '0' });
                setNewLimitKey('');
              }}
            >
              {t('common.add')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!diff} title={t('plans.diff.title')} onClose={() => setDiff(null)}>
        {diff ? (
          <div style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
            <p style={{ color: colors.neutral[500] }}>{t('plans.diff.range', { planKey: diff.planKey, from: diff.fromVersion, to: diff.toVersion })}</p>
            {diff.trialDays.changed ? <p>{t('plans.diff.trialDays', { from: String(diff.trialDays.from), to: String(diff.trialDays.to) })}</p> : null}
            {diff.features.map((f) => (
              <p key={f.key}>{t('plans.diff.feature', { key: f.key, from: String(f.from), to: String(f.to) })}</p>
            ))}
            {diff.limits.map((l) => (
              <p key={l.key}>{t('plans.diff.limit', { key: l.key, from: String(l.from), to: String(l.to) })}</p>
            ))}
            {!diff.trialDays.changed && diff.features.length === 0 && diff.limits.length === 0 ? <p>{t('plans.diff.noChanges')}</p> : null}
          </div>
        ) : null}
      </Dialog>
    </Shell>
  );
}
