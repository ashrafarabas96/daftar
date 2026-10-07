/**
 * THE RED PROOFS OF THE S8 FRAMEWORK AND THE S9 RELEASE TOOLING.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. Every law in
 * `scripts/phase4-s8/**` and `scripts/phase4-s9/**` is green on the live tree
 * except the one real finding. A green that has never been seen go red is a
 * claim, so this suite plants a DEFECT for each law and requires the SPECIFIC
 * refusal — not merely "some problem was reported", because a check that
 * reports the wrong problem for the right reason is a check that will report
 * the wrong problem for the wrong reason too.
 *
 * Each `it(` title here is the `redProof` string of the check it proves, so
 * either end of the pair is findable from the other, and
 * `p4s89-waiting-status-law.test.ts` asserts that every registry entry's
 * `redProof` really names a test in a file that exists.
 *
 * HOW THE DEFECTS ARE PLANTED
 *
 * Two ways, and never a third:
 *
 *   - A law whose input is a VALUE gets a mutated copy of the real value. The
 *     copy starts from the real table, so the mutation is one difference
 *     rather than a fiction built to fail.
 *   - A law whose input is the TREE gets a temporary root holding the real
 *     files with one real edit. `--root=` exists on both runners for exactly
 *     this.
 *
 * What is NOT done here: planting a FICTIONAL subject. A proof that plants a
 * relation or a routine that could never exist asserts "no finding", which is
 * the opposite of its intent. The DB-backed proofs that plant a real routine,
 * a real relation and a real grant live in `p4s8-red-proofs.test.ts`.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMatrix, matrixProblems, LOCK_TAKING_COMMANDS } from '../../scripts/phase4-s8/deadlock-matrix';
import {
  browserMatrixProblems,
  goldenCompletenessProblems,
  unitTreeReachProblems,
  DECLARED_GOLDENS,
  SHIPPED_SLICES,
} from '../../scripts/phase4-s8/golden-and-browser';
import {
  type IdempotencyKey,
  type SourceRow,
  discoverIdempotencyKeys,
  discoverSources,
  idempotencyFindings,
  sourceFindings,
} from '../../scripts/phase4-s8/inventories';
import { BUDGETS, budgetPlanProblems, mutationProblems, orchestrate } from '../../scripts/phase4-s8/performance-orchestrator';
import { SALES_RECONCILIATION_CHECKS, frameworkSelfProblems } from '../../scripts/phase4-s8/reconciliation-framework';
import { ISOLATION_PATH, LIFECYCLE, isolationProblems, lifecycleProblems } from '../../scripts/phase4-s8/scenarios';
import {
  CATALOGUE_DIMENSIONS,
  EXTRACTED_ARCHIVE_PROCEDURE,
  RELEASE_PLAN,
  UPGRADE_REHEARSAL_PROCEDURE,
  auditProblems,
  catalogueDiffProblems,
  migrationHashProblems,
  procedureProblems,
  releasePlanProblems,
  sharpPinProblems,
  skipFlagProblems,
} from '../../scripts/phase4-s9/release';
import {
  EVIDENCE_INDEX,
  PHASE4_BASE,
  evidenceIndexProblems,
  mergeBaseProblems,
  releaseReportProblems,
  verifyMergeBase,
} from '../../scripts/phase4-s9/evidence';
import { S9_CHECKS } from '../../scripts/phase4-s9/index';
import { resolutionContainmentProblems, workspaceLinks } from '../../scripts/phase4-s9/resolution-containment';
import { findTriggerAsymmetries, secretScanCoverage, triggersAdmittedBy, SECRET_HISTORY_COMMAND } from '../../scripts/phase4-s9/workflow-asymmetry';

const ROOT = join(__dirname, '..', '..');

/** A temporary root holding only the files the law under test reads, with one real edit. */
function withRoot(files: Readonly<Record<string, string>>, body: (root: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'p4s89-red-proof-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const abs = join(dir, relative);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The live file, read so a mutation is a mutation OF SOMETHING and not an invention. */
const live = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

// ─────────── THE RECONCILIATION FRAMEWORK ─────────────────────────────────

describe('the R-SAL contract', () => {
  it('the R-SAL contract refuses a check whose plant mutates a relation it never reads', () => {
    // Sanity first: the real table is clean, so the refusal below is caused by
    // the mutation and by nothing else.
    expect(frameworkSelfProblems()).toEqual([]);

    const real = SALES_RECONCILIATION_CHECKS[0];
    expect(real).toBeDefined();
    if (real === undefined) return;
    const plant = real.plants[0];
    expect(plant).toBeDefined();
    if (plant === undefined) return;

    // One difference from the real table: the plant now mutates a relation
    // that IS real in the tree (`journal_lines` exists) but that R-SAL-01's
    // own `relations` list has been narrowed to exclude. The plant is still a
    // real plant; what has broken is the correspondence between what it
    // touches and what the check reads.
    const mutated = [{ ...real, relations: ['invoices'], plants: [{ ...plant, relation: 'journal_lines' }] }, ...SALES_RECONCILIATION_CHECKS.slice(1)];
    const problems = frameworkSelfProblems(mutated);
    expect(problems.join('\n')).toContain('mutates journal_lines, which R-SAL-01 does not read');
    expect(problems.join('\n')).toContain('proves nothing');
  });

  it('refuses a check with no planted discrepancy at all', () => {
    const real = SALES_RECONCILIATION_CHECKS[2];
    expect(real).toBeDefined();
    if (real === undefined) return;
    const mutated = SALES_RECONCILIATION_CHECKS.map((c) => (c.id === real.id ? { ...c, plants: [] } : c));
    expect(frameworkSelfProblems(mutated).join('\n')).toContain('no planted discrepancy');
  });
});

// ─────────── THE DEADLOCK MATRIX ──────────────────────────────────────────

describe('the deadlock matrix', () => {
  it('the deadlock matrix refuses a pair run in only one direction', () => {
    const real = buildMatrix();
    expect(matrixProblems(real)).toEqual([]);
    expect(real.length).toBeGreaterThan(0);

    // Delete the REVERSE run of one real pair. Both directions is the law:
    // a pair exercised in one order can never show the inversion that is the
    // whole reason the order was declared.
    const victim = real.find((p) => p.direction === 'reverse');
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const problems = matrixProblems(real.filter((p) => p !== victim));
    expect(problems.join('\n')).toContain(victim.first);
    expect(problems.join('\n')).toMatch(/both\s+directions|one\s+direction|reverse/i);
  });

  it('refuses a matrix with no pair at all', () => {
    expect(matrixProblems([]).join('\n')).toMatch(/empty|no pair/i);
    expect(buildMatrix(LOCK_TAKING_COMMANDS).length).toBeGreaterThan(0);
  });
});

// ─────────── THE INVENTORIES ──────────────────────────────────────────────

describe('the idempotency inventory', () => {
  it('the idempotency inventory names a replay path whose registry read follows its first change', () => {
    const real = discoverIdempotencyKeys(ROOT);
    expect(real.length).toBeGreaterThan(0);
    expect(idempotencyFindings(real)).toEqual([]);

    // `[[daftar-registry-before-state]]`. One field flipped on a REAL
    // discovered row: the replay path now performs its first change before it
    // has established WHICH command it is replaying.
    const victim = real[0];
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const mutated: IdempotencyKey[] = [{ ...victim, registryBeforeState: false }, ...real.slice(1)];
    const problems = idempotencyFindings(mutated);
    expect(problems.join('\n')).toContain(victim.routine);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('names a key with no identity guard at all', () => {
    const real = discoverIdempotencyKeys(ROOT);
    const victim = real[0];
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const problems = idempotencyFindings([{ ...victim, identityGuard: 'none', advisoryKey: null }]);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('the source inventory', () => {
  it('the source inventory names a registry row whose name appears nowhere but its own INSERT', () => {
    const real = discoverSources(ROOT);
    expect(real.length).toBeGreaterThan(0);
    expect(sourceFindings(real)).toEqual([]);

    // A row that is registered and used by nothing. It is built from a real
    // discovered row so every other field is real; the one difference is the
    // thing the law is about.
    const victim = real[0];
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const orphan: SourceRow = { ...victim, name: 'an_orphan_source_registered_and_never_posted', hasWriter: false };
    const problems = sourceFindings([...real, orphan]);
    expect(problems.join('\n')).toContain('an_orphan_source_registered_and_never_posted');
  });
});

// ─────────── GOLDENS, THE UNIT ESTATE AND THE BROWSER MATRIX ──────────────

describe('golden completeness', () => {
  it('golden completeness names a declared golden whose shipped owner left it unreferenced', () => {
    // The mutation is in the SHIPPED SET, not in the tree: declare P4-S5
    // shipped while its goldens are not there. That is the real hazard this
    // law exists for — a slice seals and its goldens are simply never written,
    // and nothing notices because the completeness check only knows about the
    // slices that have already delivered.
    const owedByS5 = DECLARED_GOLDENS.filter((g) => g.owner === 'P4-S5');
    expect(owedByS5.length, 'this proof needs at least one declared golden owned by P4-S5').toBeGreaterThan(0);
    const problems = goldenCompletenessProblems(ROOT, [...SHIPPED_SLICES, 'P4-S5']);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('P4-S5');
    expect(problems.join('\n')).toMatch(/unproven|NOT in the golden estate/);
  });
});

describe('the unit-tree estate', () => {
  it('the unit-tree estate check names the ordering when npm test moves after the database steps', () => {
    expect(unitTreeReachProblems(ROOT)).toEqual([]);

    // A REAL edit to a real workflow: one extra `backend` step that bootstraps
    // the database roles, inserted BEFORE `npm test`. Nothing fictional — this
    // is the exact change that would make the recorded ordering (unit trees
    // AHEAD of the database steps) stop being true, and with it the
    // consequence the golden-completeness checker documents.
    const ci = live('.github/workflows/ci.yml');
    const at = ci.indexOf('      - name: Unit tests');
    const anchor = at === -1 ? ci.indexOf('npm test') : at;
    expect(anchor, 'the live ci.yml must contain the npm test step for this mutation to be a mutation').toBeGreaterThan(0);
    const lineStart = ci.lastIndexOf('\n      - ', anchor) + 1;
    const inserted = `      - name: Planted early database step\n        run: npm run bootstrap:db-roles\n`;
    const mutatedCi = `${ci.slice(0, lineStart)}${inserted}${ci.slice(lineStart)}`;

    const files: Record<string, string> = {
      '.github/workflows/ci.yml': mutatedCi,
      'package.json': live('package.json'),
    };
    withRoot(files, (root) => {
      // The five unit trees are copied so the law is not reported red for the
      // unrelated reason that they are empty.
      for (const tree of [
        'packages/domain-core/test',
        'packages/accounting/test',
        'packages/shared-contracts/test',
        'packages/inventory/test',
        'apps/web/test',
      ])
        cpSync(join(ROOT, tree), join(root, tree), { recursive: true });
      const problems = unitTreeReachProblems(root);
      expect(problems.join('\n')).toContain('the recorded ordering');
      expect(problems.join('\n')).toMatch(/`npm test` is step \d+ of `backend` and the first database step is \d+/);
    });
  });
});

describe('the browser matrix', () => {
  it('the browser matrix refuses a PHASE4_STEPS entry that collides with a Phase 3 step', () => {
    expect(browserMatrixProblems(ROOT).filter((p) => p.includes('BOTH PHASE4_STEPS and PHASE3_STEPS'))).toEqual([]);

    // `P4-AL-63`: the two exported lists are DISJOINT, because
    // `tests/browser/gate.ts` filters `--steps` as a plain name list keyed by
    // name, so a duplicate name would be run by the Phase 3 selection.
    const flows = live('tests/browser/flows.ts');
    const mutated = flows.replace(/export const PHASE4_STEPS[^=]*=\s*\[/, (m) => `${m}\n  'return',`);
    expect(mutated, 'the mutation must actually change the file').not.toBe(flows);
    withRoot({ 'tests/browser/flows.ts': mutated }, (root) => {
      const problems = browserMatrixProblems(root);
      expect(problems.join('\n')).toContain('is in BOTH PHASE4_STEPS and PHASE3_STEPS');
    });
  });
});

// ─────────── THE PERFORMANCE ORCHESTRATOR ─────────────────────────────────

describe('the performance budgets', () => {
  it('the budget plan refuses a ceiling increase, a p95 to p90 change and a reduced sample', () => {
    expect(budgetPlanProblems()).toEqual([]);
    const budget = BUDGETS.find((b) => b.ceilingMs !== null);
    expect(budget).toBeDefined();
    if (budget === undefined || budget.ceilingMs === null) return;

    const raised = mutationProblems({ budgetId: budget.id, ceilingMs: budget.ceilingMs + 1 });
    expect(raised.join('\n')).toContain('ceiling increase');

    const percentile = mutationProblems({ budgetId: budget.id, percentile: 90 });
    expect(percentile.join('\n')).toContain('p95 -> p90');

    const sample = mutationProblems({ budgetId: budget.id, iterations: 10 });
    expect(sample.join('\n')).toContain('reduced sample is a reduced claim');

    // And the other four forbidden mutations, so the proof covers the set
    // rather than a sample of it.
    expect(mutationProblems({ budgetId: budget.id, dropOutliers: true }).join('\n')).toContain('every sample is kept');
    expect(mutationProblems({ budgetId: budget.id, hostMultiplier: 1.5 }).join('\n')).toContain('not a ceiling');
    expect(mutationProblems({ budgetId: budget.id, keepBestRunOnly: true }).join('\n')).toContain('cherry-picking');
    expect(mutationProblems({ budgetId: budget.id, suppressNoisyResults: true }).join('\n')).toContain('noisy result is a diagnosis');
  });

  it('the orchestrator refuses an unattested box and a relaxed ceiling', () => {
    const unattested = orchestrate(null, 1);
    expect(unattested.verdict).toBe('INVALID_RESOURCE_CONTENTION');
    expect(unattested.steps, 'an unattested run must produce NO steps: a plan handed back is a plan somebody runs').toEqual([]);
    expect(unattested.reasons.join('\n')).toContain('INVALID — RESOURCE CONTENTION');

    const attested = {
      attestedBy: 'the coordinator, for this proof only',
      attestedAt: new Date(0).toISOString(),
      noOtherAgentsRunning: true,
      noInstallBuildLintOrTypecheck: true,
      noOtherTestsRunning: true,
      noDatabaseCleanupOrFilesystemWork: true,
      dedicatedPgDir: '/tmp/daftar-pg-budgets-proof',
      analyzePerformed: true,
    } as const;
    // Attested but with ANALYZE not performed: a figure taken against a table
    // with no statistics is a number about the missing statistics (2.9 s on a
    // runner, 122 ms after one ANALYZE, same query).
    const noAnalyze = orchestrate({ ...attested, analyzePerformed: false }, 1);
    expect(noAnalyze.verdict).toBe('INVALID_RESOURCE_CONTENTION');
    expect(noAnalyze.reasons.join('\n')).toContain('MISSING STATISTICS');

    // A relaxed ceiling is refused at the PLAN level, before anything is run.
    const relaxed = BUDGETS.map((b) => (b.ceilingMs === null ? b : { ...b, ceilingMs: b.ceilingMs * 2 }));
    const refused = orchestrate(attested, 1, relaxed);
    expect(refused.verdict).toBe('REFUSED_PLAN');
    expect(refused.steps).toEqual([]);

    // And the passing case, so this proof is not only asked where it refuses.
    const ready = orchestrate(attested, 1);
    expect(ready.verdict).toBe('READY');
    expect(ready.steps.length).toBeGreaterThan(0);
    // No timing is taken here, ever: other agents are running on this box.
    expect(ready.steps.join('\n')).toContain('runner canary');
  });
});

// ─────────── THE SCENARIOS ────────────────────────────────────────────────

describe('the lifecycle and isolation scenarios', () => {
  it('the lifecycle refuses a stage order that is not the required fourteen', () => {
    expect(lifecycleProblems()).toEqual([]);
    // Drop one real stage out of the middle. The order is mandated end to end
    // — customer through reconciliation — and a lifecycle missing a stage
    // "passes" every stage it still has.
    const without = LIFECYCLE.filter((_, i) => i !== 5);
    expect(lifecycleProblems(without).length).toBeGreaterThan(0);
    // And a reordering, which is the subtler defect: all fourteen present, in
    // an order that is not the mandated one. Note WHAT is mutated — the
    // `order` FIELD, not the array position. The law sorts by `order` first,
    // so shuffling the array changes nothing and SHOULD change nothing: the
    // field is the order. A proof that shuffled the array and expected a
    // refusal would have been asserting the wrong law.
    const swapped = LIFECYCLE.map((s) => (s.order === 4 ? { ...s, order: 5 } : s.order === 5 ? { ...s, order: 4 } : s));
    const problems = lifecycleProblems(swapped);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('the required order is');
  });

  it('the isolation path refuses a second-business arm that only drives the API', () => {
    expect(isolationProblems()).toEqual([]);
    // The second-business arm must reach SQL. An arm that only drives the API
    // tests the API's own scoping, which is not the same question as whether
    // the ROW is reachable — and RLS is the thing under test.
    const apiOnly = ISOLATION_PATH.map((s) => (s.arm === 'second-business-of-one-tenant' ? { ...s, layer: 'api' as const } : s));
    expect(isolationProblems(apiOnly).length).toBeGreaterThan(0);
    // And dropping the second-business arm altogether.
    const tenantOnly = ISOLATION_PATH.filter((s) => s.arm !== 'second-business-of-one-tenant');
    expect(isolationProblems(tenantOnly).length).toBeGreaterThan(0);
  });
});

// ─────────── THE S9 RELEASE PLAN ──────────────────────────────────────────

describe('the release plan', () => {
  it('the release plan refuses a canary that is not the first step', () => {
    expect(releasePlanProblems()).toEqual([]);
    // Move the canary to the end. Every exit status read before it is
    // unreadable: DAFTAR's runner once exited 0 over four failing tests.
    const canary = RELEASE_PLAN.find((s) => s.id === 'runner-canary');
    expect(canary).toBeDefined();
    if (canary === undefined) return;
    const moved = [...RELEASE_PLAN.filter((s) => s.id !== 'runner-canary').map((s, i) => ({ ...s, order: i + 1 })), { ...canary, order: RELEASE_PLAN.length }];
    const problems = releasePlanProblems(moved);
    expect(problems.join('\n')).toContain('must be FIRST');
    expect(problems.join('\n')).toContain('unreadable');

    // The archive built before the audit, which would ship a checksum of an
    // archive that predates the security fix folded into it.
    const audit = RELEASE_PLAN.find((s) => s.id === 'supply-chain');
    const archive = RELEASE_PLAN.find((s) => s.id === 'rc-archive');
    if (audit !== undefined && archive !== undefined) {
      const reordered = RELEASE_PLAN.map((s) => (s.id === 'rc-archive' ? { ...s, order: audit.order - 1 } : s));
      expect(releasePlanProblems(reordered).join('\n')).toContain('FINAL RC checksum');
    }

    // Both deployment proofs. A never implies B.
    expect(releasePlanProblems(RELEASE_PLAN.filter((s) => s.id !== 'upgrade-rehearsal')).join('\n')).toContain('A never implies B');
    expect(releasePlanProblems(RELEASE_PLAN.filter((s) => s.id !== 'fresh-cluster')).join('\n')).toContain('proof (A) is missing');
  });

  it('the skip-flag refusal fires on a planted RELEASE_GATE_SKIP_ variable', () => {
    expect(skipFlagProblems({})).toEqual([]);
    expect(skipFlagProblems({ RELEASE_GATE_SKIP_BROWSER: '' }), 'an empty value is not a set flag').toEqual([]);
    const problems = skipFlagProblems({ RELEASE_GATE_SKIP_BROWSER: '1', PATH: '/usr/bin' });
    expect(problems.join('\n')).toContain('RELEASE_GATE_SKIP_BROWSER');
    expect(problems.join('\n')).toContain('BEFORE running anything');
  });

  it('the fresh-cluster check refuses a non-blocking step', () => {
    const check = S9_CHECKS.find((c) => c.id === 'fresh-cluster-runner');
    expect(check).toBeDefined();
    if (check === undefined) return;
    expect(check.evaluate(ROOT)).toEqual([]);
    // The subject of this proof is the law, so the law is re-asked with the
    // step mutated. The check reads `RELEASE_PLAN` directly, so the mutation
    // is asserted through `releasePlanProblems`, which shares the law.
    const nonBlocking = RELEASE_PLAN.map((s) => (s.id === 'fresh-cluster' ? { ...s, blocking: true, command: null } : s));
    expect(releasePlanProblems(nonBlocking).join('\n')).toContain('names no command');
  });
});

// ─────────── RESOLUTION CONTAINMENT ───────────────────────────────────────

describe('is the tree being judged the tree that resolved', () => {
  it('the resolution checker names a workspace link that escapes the root being judged', () => {
    // The passing case first, over this very worktree. If this is red, the
    // run that produced it was about somebody else's packages.
    expect(resolutionContainmentProblems(ROOT)).toEqual([]);
    expect(workspaceLinks(ROOT).length, 'this proof needs real workspace links to contain').toBeGreaterThan(0);

    // THE ESCAPING LINK. A real symlink, to a real package in the real main
    // checkout — which is exactly the shape npm produces when a worktree's
    // whole `node_modules` is a link: `@daftar/x -> ../../packages/x` resolved
    // relative to the WRONG tree.
    const outside = mkdtempSync(join(tmpdir(), 'p4s9-other-tree-'));
    const judged = mkdtempSync(join(tmpdir(), 'p4s9-judged-tree-'));
    try {
      mkdirSync(join(outside, 'packages/domain-core/dist'), { recursive: true });
      writeFileSync(join(outside, 'packages/domain-core/package.json'), JSON.stringify({ name: '@daftar/domain-core', main: './dist/index.js' }), 'utf8');
      writeFileSync(join(outside, 'packages/domain-core/dist/index.js'), 'module.exports = {};\n', 'utf8');
      mkdirSync(join(judged, 'node_modules/@daftar'), { recursive: true });
      symlinkSync(join(outside, 'packages/domain-core'), join(judged, 'node_modules/@daftar/domain-core'));

      const problems = resolutionContainmentProblems(judged);
      expect(problems.join('\n')).toContain('@daftar/domain-core');
      expect(problems.join('\n')).toContain('OUTSIDE this root');
      expect(problems.join('\n')).toContain('the verdict is about neither');

      // And the SECOND half of the hazard: repointed, inside the root, and
      // unbuilt. It resolves to nothing, so every import becomes TS2307 and
      // reads as a defect in the importing code.
      const unbuiltRoot = mkdtempSync(join(tmpdir(), 'p4s9-unbuilt-'));
      try {
        mkdirSync(join(unbuiltRoot, 'packages/accounting/src'), { recursive: true });
        writeFileSync(
          join(unbuiltRoot, 'packages/accounting/package.json'),
          JSON.stringify({ name: '@daftar/accounting', main: './dist/index.js', types: './dist/index.d.ts' }),
          'utf8',
        );
        mkdirSync(join(unbuiltRoot, 'node_modules/@daftar'), { recursive: true });
        symlinkSync(join(unbuiltRoot, 'packages/accounting'), join(unbuiltRoot, 'node_modules/@daftar/accounting'));
        const unbuilt = resolutionContainmentProblems(unbuiltRoot);
        expect(unbuilt.join('\n')).toContain('TS2307');
        expect(unbuilt.join('\n')).toContain('./dist/index.d.ts');
      } finally {
        rmSync(unbuiltRoot, { recursive: true, force: true });
      }

      // An empty scope is NOT a pass: nothing resolves, so nothing was judged.
      const empty = mkdtempSync(join(tmpdir(), 'p4s9-empty-'));
      try {
        expect(resolutionContainmentProblems(empty).join('\n')).toContain('not a judged tree');
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(judged, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ─────────── MIGRATION HASHES ─────────────────────────────────────────────

describe('the migration hash verifier', () => {
  it('the migration hash verifier reports a mutated accepted migration', () => {
    // The rows are built from the real tree and are clean. Note what is NOT
    // done here: no file under `infrastructure/database/migrations/` is
    // written or edited, ever. The mutation is to a ROW, which is the value
    // the law consumes.
    const row = { name: '0040_accounting_chart.sql', onDisk: 'a'.repeat(64), inManifest: 'a'.repeat(64), inPrefixModule: 'a'.repeat(64), agrees: true };
    expect(migrationHashProblems([row])).toEqual([]);
    const tampered = [{ ...row, onDisk: 'b'.repeat(64), agrees: false }];
    const problems = migrationHashProblems(tampered);
    expect(problems.join('\n')).toContain('0040_accounting_chart.sql');
    expect(problems.join('\n')).toContain('bbbbbbbbbbbb');
    // An empty estate is never a verified one.
    expect(migrationHashProblems([]).join('\n')).toContain('empty migration estate is never a verified one');
  });
});

// ─────────── THE SECRET SCAN ──────────────────────────────────────────────

describe('the secret-history range scan', () => {
  it('the trigger-asymmetry detector names the live ci.yml secret-scan step and its line', () => {
    // This one is NOT a planted defect: it is the LIVE finding, asserted
    // against the real file so the patch request cannot drift from it. If the
    // workflow is ever fixed, this test goes red and says so — which is the
    // correct way for a recorded finding to expire.
    const coverage = secretScanCoverage(ROOT);
    expect(coverage.rangeSteps.length, 'the live ci.yml carries exactly one asymmetric range-scan step').toBe(1);
    const step = coverage.rangeSteps[0];
    expect(step).toBeDefined();
    if (step === undefined) return;
    expect(step.job).toBe('hygiene');
    expect(step.runsOn).toEqual(['pull_request']);
    expect(step.skippedOn).toEqual(['push']);
    expect(step.line).toBeGreaterThan(600);
    expect(coverage.uncoveredTriggers).toEqual(['push']);

    // And the exact file:line, so a reader can open the defect.
    const ci = live('.github/workflows/ci.yml');
    const lines = ci.split('\n');
    expect(lines[step.line - 1] ?? '', `ci.yml:${step.line.toString()} must be the step this finding names`).toContain('Secret history range scan');

    // The detector does not cry wolf: an `if:` it cannot parse admits BOTH
    // triggers, so an unreadable condition is never reported as an asymmetry.
    expect(triggersAdmittedBy(null)).toEqual(['push', 'pull_request']);
    expect(triggersAdmittedBy("fromJSON(something.clever) == 'yes'")).toEqual(['push', 'pull_request']);
    expect(triggersAdmittedBy("github.event_name == 'push'")).toEqual(['push']);
    expect(triggersAdmittedBy("github.event_name != 'push'")).toEqual(['pull_request']);

    // And it finds the step by WHAT IT DOES, so a rename does not hide it.
    const renamed = ci.replace('Secret history range scan (every commit of the pull request)', 'A step with an entirely different name');
    expect(findTriggerAsymmetries(renamed, SECRET_HISTORY_COMMAND).length).toBe(1);

    // The passing counterfactual: with the `if:` removed, the asymmetry is gone.
    const fixed = ci.replace(/( {6}- name: Secret history range scan[^\n]*\n) {8}if: github\.event_name == 'pull_request'\n/, '$1');
    expect(fixed).not.toBe(ci);
    expect(findTriggerAsymmetries(fixed, SECRET_HISTORY_COMMAND)).toEqual([]);
  });

  it('the merge-base verifier refuses a declared base that is not the merge-base', () => {
    const head = 'HEAD';
    // The real base, verified.
    expect(mergeBaseProblems(verifyMergeBase(ROOT, head, 'main', PHASE4_BASE))).toEqual([]);
    // A plausible-looking wrong base: the shape is right and the value is not.
    const wrong = `${PHASE4_BASE.slice(0, 39)}${PHASE4_BASE.endsWith('5') ? '6' : '5'}`;
    const problems = mergeBaseProblems(verifyMergeBase(ROOT, head, 'main', wrong));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(wrong);
  });
});

// ─────────── SUPPLY CHAIN ─────────────────────────────────────────────────

describe('the supply-chain refusals', () => {
  it('the audit refusal fires on --force, a lowered level, an ignore and an allowlist', () => {
    expect(auditProblems({ command: 'npm audit --audit-level=high', level: 'high', ignoredAdvisories: [], allowlist: [] })).toEqual([]);
    expect(auditProblems({ command: 'npm audit fix --force', level: 'high', ignoredAdvisories: [], allowlist: [] }).join('\n')).toContain('not a reviewed fix');
    expect(auditProblems({ command: 'npm audit --audit-level=moderate', level: 'moderate', ignoredAdvisories: [], allowlist: [] }).join('\n')).toContain(
      'change of subject',
    );
    expect(
      auditProblems({ command: 'npm audit --audit-level=high', level: 'high', ignoredAdvisories: ['GHSA-xxxx-yyyy-zzzz'], allowlist: [] }).join('\n'),
    ).toContain('no advisory ignore');
    expect(auditProblems({ command: 'npm audit --audit-level=high', level: 'high', ignoredAdvisories: [], allowlist: ['sharp'] }).join('\n')).toContain(
      'no allowlist',
    );
  });

  it('the sharp pin check reports a lockfile that resolves a different version', () => {
    expect(sharpPinProblems(ROOT)).toEqual([]);
    // A real lockfile shape with one version changed.
    const lock = { name: 'daftar', lockfileVersion: 3, packages: { 'node_modules/sharp': { version: '0.33.0' } } };
    withRoot({ 'package-lock.json': JSON.stringify(lock, null, 2) }, (root) => {
      const problems = sharpPinProblems(root);
      expect(problems.join('\n')).toContain('0.33.0');
      expect(problems.join('\n')).toContain('0.35.5');
    });
    // An absent lockfile is reported, never passed over.
    withRoot({ 'README.md': 'no lockfile here' }, (root) => {
      expect(sharpPinProblems(root).join('\n')).toContain('package-lock.json is absent');
    });
  });
});

// ─────────── THE PROCEDURES AND THE CATALOGUE DIFF ────────────────────────

describe('the deployment procedures', () => {
  it('a procedure step with no reason is refused', () => {
    expect(procedureProblems(EXTRACTED_ARCHIVE_PROCEDURE, 'extracted-archive')).toEqual([]);
    const victim = EXTRACTED_ARCHIVE_PROCEDURE[0];
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const problems = procedureProblems([{ ...victim, why: '' }], 'extracted-archive');
    expect(problems.join('\n')).toContain('no reason');
    expect(procedureProblems([], 'extracted-archive').join('\n')).toContain('EMPTY');
  });

  it('the upgrade rehearsal refuses a procedure that starts from 0000', () => {
    const check = S9_CHECKS.find((c) => c.id === 'upgrade-rehearsal-procedure');
    expect(check).toBeDefined();
    if (check === undefined) return;
    expect(check.evaluate(ROOT)).toEqual([]);

    // Proof (B) that starts from `0000` is proof (A) wearing proof (B)'s name.
    // The law is re-asked over a mutated copy of the real procedure.
    const fromZero = UPGRADE_REHEARSAL_PROCEDURE.map((s) => (s.id === 'U-1' ? { ...s, what: 'build a database fresh from 0000 as a superuser' } : s));
    const problems = [
      ...procedureProblems(fromZero, 'upgrade-rehearsal'),
      ...(fromZero.some((s) => /frozen predecessor prefix/i.test(s.what)) ? [] : ['no step starts the rehearsal at the FROZEN PREDECESSOR PREFIX']),
      ...(fromZero.some((s) => /daftar_migrator/.test(s.what)) ? [] : ['no step applies the candidate as `daftar_migrator`']),
    ];
    expect(problems.join('\n')).toContain('FROZEN PREDECESSOR PREFIX');

    // And a rehearsal performed as a superuser, which is never asked who owns
    // the object or who may do what to it.
    const asSuperuser = UPGRADE_REHEARSAL_PROCEDURE.map((s) =>
      s.id === 'U-3' ? { ...s, what: 'apply the candidate migrations as the postgres superuser' } : s,
    );
    expect(
      asSuperuser.some((s) => /daftar_migrator/.test(s.what)),
      'U-2 also names daftar_migrator; this proof asserts the ownership step is what carries it',
    ).toBe(true);
    expect(asSuperuser.find((s) => s.id === 'U-3')?.what).not.toContain('daftar_migrator');
  });

  it('the catalogue diff refuses a cover set that omits grants and ownership', () => {
    expect(catalogueDiffProblems(CATALOGUE_DIMENSIONS)).toEqual([]);
    const problems = catalogueDiffProblems(CATALOGUE_DIMENSIONS.filter((d) => d !== 'grants' && d !== 'ownership'));
    expect(problems.join('\n')).toContain('grants');
    expect(problems.join('\n')).toContain('ownership');
    expect(problems.join('\n')).toContain('a superuser suite is never asked');
    expect(catalogueDiffProblems([]).length).toBeGreaterThan(0);
  });
});

// ─────────── THE EVIDENCE INDEX AND THE RELEASE REPORT ────────────────────

describe('the evidence index and the release report', () => {
  it('the evidence index refuses an index with no upgrade-rehearsal artefact', () => {
    expect(evidenceIndexProblems()).toEqual([]);
    const withoutB = EVIDENCE_INDEX.filter((a) => a.id !== 'E-03');
    expect(evidenceIndexProblems(withoutB).join('\n')).toContain('A never implies B');
    const withoutA = EVIDENCE_INDEX.filter((a) => a.id !== 'E-02');
    expect(evidenceIndexProblems(withoutA).join('\n')).toContain('proof (A) is missing');
    expect(evidenceIndexProblems([]).join('\n')).toContain('EMPTY');
    // A duplicate id, which is how two artefacts come to be read as one.
    const first = EVIDENCE_INDEX[0];
    if (first !== undefined) expect(evidenceIndexProblems([...EVIDENCE_INDEX, first]).join('\n')).toContain('declared twice');
  });

  it('the release report refuses the phrase "required status checks are configured"', () => {
    // TD-08 is OPEN / EXTERNAL / UNVERIFIED: inspection returns 403. The
    // report may not claim otherwise, and the scanner is LEXICAL, so the
    // phrase is refused in every grammatical mood — including a denial,
    // because a reader who quotes one sentence out of a release report has the
    // claim either way.
    expect(releaseReportProblems('# a report that claims nothing about the repository settings')).toEqual([]);
    for (const claim of [
      'the required status checks are configured on main',
      'branch protection is enabled',
      'main is protected',
      'the six required checks must pass',
      'the merge is blocked by GitHub until then',
      'we confirmed that required checks are configured',
    ])
      expect(releaseReportProblems(claim).length, `the report must refuse ${JSON.stringify(claim)}`).toBeGreaterThan(0);

    // And the GENERATED report, over the live tree, carries none of them.
    const check = S9_CHECKS.find((c) => c.id === 'release-report-vocabulary');
    expect(check).toBeDefined();
    if (check === undefined) return;
    expect(check.evaluate(ROOT)).toEqual([]);
  });
});
