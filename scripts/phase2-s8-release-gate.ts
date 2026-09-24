#!/usr/bin/env tsx
/**
 * LEVEL B — THE P2-S8 RELEASE GATE (f §4).
 *
 * `npm run gate:phase2:s8:release` answers a different question from
 * `npm run gate:phase2:s8`, and the difference is the whole point of there
 * being two commands.
 *
 * LEVEL A — `gate:phase2:s8` — asks: is the tree in front of me the tree P2-S8
 * describes, and does everything it claims still pass when I run it? It reads
 * only files that are in the repository and the exit status of commands it
 * executes itself, so it runs on a clean checkout, in CI, on any machine, and
 * a green Level A is a true statement about that commit.
 *
 * LEVEL B — this file — asks: has the acceptance-scale evidence ACTUALLY BEEN
 * PRODUCED for this commit? Tier 2 at a hundred thousand and a million lines,
 * the rollback and restore rehearsal against a real backup, the before/after
 * RLS answer equivalence. Those take hours and a real cluster; they cannot be
 * a per-push gate, and pretending otherwise is what produced the defect f §1
 * names.
 *
 * ── The law the two levels exist to keep ─────────────────────────────────
 *
 *   "LEVEL A must never lie because LEVEL B has not been run. LEVEL B must
 *    never claim CI proof unless it was actually produced on GitHub."  (f §4)
 *
 * The first half is why Level A no longer reads `release/` at all: a gate
 * that forgives a missing artefact is weaker on the machine whose verdict
 * matters, and a gate that demands one cannot run there. The second half is
 * why every artefact below is checked for its exact-SHA binding — a file
 * produced on a laptop is supporting evidence and says so, and this gate can
 * tell the difference.
 *
 * ── The dependency direction, which is one-way (f §15, §16) ──────────────
 *
 *     gate:phase2:s8        reads the repository. Nothing else.
 *     evidence:phase2:s8    RUNS gate:phase2:s8 and check:supply-chain,
 *                           READS the produced artefacts, writes the evidence
 *                           document.
 *     gate:phase2:s8:release  READS the artefacts and the evidence document.
 *
 * Nothing reads a file that records its own verdict, so there is no fixpoint
 * to reason about and no row anyone has to remember to ignore.
 *
 * Usage: npm run gate:phase2:s8:release
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateDigests, exactShaBinding, exactShaMismatch, P2_S8_CANDIDATES } from './phase2-s8-binding';

const ROOT = join(__dirname, '..');

let failures = 0;
const fail = (check: string, detail: string): void => {
  failures += 1;
  console.error(`  FAIL [${check}] ${detail}`);
};
const ok = (detail: string): void => console.log(`  ok      ${detail}`);

const artefact = <T>(path: string): T | null => {
  const full = join(ROOT, path);
  return existsSync(full) ? (JSON.parse(readFileSync(full, 'utf8')) as T) : null;
};

/**
 * Every artefact this gate reads, and the command that produces it. The
 * second half matters as much as the first: an artefact reported missing
 * with no way to make it is a dead end for whoever reads the failure.
 */
const ARTEFACTS: readonly (readonly [string, string, string])[] = [
  [
    'release/phase2-s8-performance-tier1.json',
    'the six budgets at Tier 1',
    'npm run gate:phase2:s8 (it runs Tier 1 itself), or P2S8_PERF_TIER=1 npx vitest run tests/performance/accounting-budgets.test.ts',
  ],
  [
    'release/phase2-s8-performance-tier2.json',
    'the six budgets at the ACCEPTANCE sizes — 100,000 reporting lines and 1,000,000 reconciliation lines (§13)',
    'P2S8_PERF_TIER=2 npx vitest run tests/performance/accounting-budgets.test.ts',
  ],
  [
    'release/phase2-s8-rls-equivalence.json',
    'the same trial balance at 0051 and at 0052, with both plans (§10, §11)',
    'npx vitest run tests/performance/accounting-rls-equivalence.test.ts',
  ],
  [
    'release/phase2-s8-rollback-rehearsal.json',
    'a real backup, a real restore, Phase 2 applied to the copy, the accepted Phase 1 build run against it (f §39–§42)',
    'npm run rehearse:phase2:rollback',
  ],
  ['release/phase2-s8-evidence.json', 'the machine-readable evidence document (f §50)', 'npm run evidence:phase2:s8'],
];

function checkArtefactsExist(): void {
  console.log('P2-S8 RELEASE GATE — the acceptance evidence exists');
  for (const [path, what, how] of ARTEFACTS) {
    if (existsSync(join(ROOT, path))) ok(`${path} — ${what}`);
    else fail('s8-release-missing', `${path} was never produced — ${what}. Produce it with: ${how}`);
  }
}

/**
 * EVERY ARTEFACT NAMES THE COMMIT IT WAS MEASURED ON (f §11).
 *
 * Without this the release evidence is a folder of numbers. With it, each
 * file states the head commit and both candidate migrations' digests, and
 * this gate refuses a set in which any of them disagrees — which is exactly
 * the case where somebody edited a migration between producing two artefacts
 * and the two halves of the evidence describe different schemas.
 */
function checkExactShaBinding(): void {
  console.log('P2-S8 RELEASE GATE — every artefact is bound to this exact commit (f §11)');
  const mismatch = exactShaMismatch(ROOT);
  if (mismatch !== null) {
    fail('s8-release-sha', mismatch);
    return;
  }
  const here = exactShaBinding(ROOT);
  const digests = candidateDigests(ROOT);
  for (const name of P2_S8_CANDIDATES) {
    if (digests[name] === 'absent') fail('s8-release-sha', `${name} is not on disk — the candidate the evidence describes does not exist here`);
  }

  for (const [path] of ARTEFACTS) {
    const e = artefact<{ binding?: { head?: string; candidates?: Record<string, string>; producedIn?: string }; gitSha?: string; head?: string }>(path);
    if (e === null) continue;
    const binding = e.binding;
    if (binding === undefined) {
      fail(
        's8-release-sha',
        `${path} carries no exact-SHA binding block — it cannot say which tree produced it, so it cannot be evidence about this one (f §11)`,
      );
      continue;
    }
    if (binding.head !== here.head) {
      fail(
        's8-release-sha',
        `${path} was produced at ${String(binding.head).slice(0, 12)}… but HEAD is ${here.head.slice(0, 12)}… — it describes a different tree`,
      );
      continue;
    }
    const drifted = P2_S8_CANDIDATES.filter((c) => (binding.candidates ?? {})[c] !== digests[c]);
    if (drifted.length > 0) {
      fail('s8-release-sha', `${path} records a different digest for ${drifted.join(', ')} than the file on disk — a candidate changed between artefacts`);
      continue;
    }
    ok(`${path} — head ${here.head.slice(0, 12)}…, both candidate digests match, produced in ${String(binding.producedIn)}`);
  }
}

/**
 * The recorded before/after result (§10, §11).
 *
 * The suite that produces this file asserts the same two things while it runs.
 * Reading the file here is not a duplicate: it is what lets this gate refuse a
 * release in which the measurement was never taken at all, which is the
 * failure a green test list cannot show you.
 */
function checkRlsEquivalenceEvidence(): void {
  console.log('P2-S8 RELEASE GATE — the answer did not change, and the per-row lookup is gone (§10, §11)');
  const e = artefact<{
    boundaryBefore?: string;
    boundaryAfter?: string;
    answerIdentical?: boolean;
    rowCount?: number;
    dataset?: { lineCount?: number };
    before?: { subplanRelations?: Record<string, string[]>; sharedHit?: number; sharedRead?: number; executionMs?: number };
    after?: { subplanRelations?: Record<string, string[]>; sharedHit?: number; sharedRead?: number; executionMs?: number };
  }>('release/phase2-s8-rls-equivalence.json');
  if (e === null) return; // the missing-file case is already reported above

  if (!(e.boundaryBefore ?? '').startsWith('0051') || !(e.boundaryAfter ?? '').startsWith('0052')) {
    fail(
      's8-equivalence',
      `the before/after evidence was not taken at 0051 → 0052 (${e.boundaryBefore} → ${e.boundaryAfter}) — it compares the wrong two states`,
    );
  } else if (e.answerIdentical !== true) {
    fail('s8-equivalence', 'the recorded trial balance is NOT identical before and after 0052 — a faster wrong answer is a defect (§10, f §13)');
  } else if ((e.rowCount ?? 0) === 0 || (e.dataset?.lineCount ?? 0) < 10_000) {
    fail('s8-equivalence', `the comparison ran on ${e.dataset?.lineCount ?? 0} lines and ${e.rowCount ?? 0} rows — equality over nothing proves nothing (§10)`);
  } else {
    ok(`the trial balance is identical at 0051 and 0052 over ${e.dataset?.lineCount} lines, ${e.rowCount} accounts (§10)`);
  }

  // Attribution, not a mention. `businesses` appearing anywhere in a plan is
  // not the defect — a relation being read ONCE PER ROW of another is — so the
  // recorded evidence keys each per-row lookup to the scan it hangs under, and
  // this reads that. Before: all three corrected tables do it. After: nothing
  // does, under any relation at all.
  const beforeSub = e.before?.subplanRelations ?? {};
  const afterSub = e.after?.subplanRelations ?? {};
  const missingBefore = ['journal_lines', 'journal_entries', 'accounts'].filter((t) => !(beforeSub[t] ?? []).includes('businesses'));
  const remainingAfter = Object.entries(afterSub).filter(([, rels]) => rels.includes('businesses'));
  if (missingBefore.length > 0 || remainingAfter.length > 0) {
    fail(
      's8-equivalence',
      missingBefore.length > 0
        ? `the recorded BEFORE plan shows no per-row businesses lookup under ${missingBefore.join(', ')} — the evidence does not contain the defect it claims to remove (§11)`
        : `the recorded AFTER plan still reads businesses per row under ${remainingAfter.map(([t]) => t).join(', ')} (§11)`,
    );
  } else {
    const beforeBlocks = (e.before?.sharedHit ?? 0) + (e.before?.sharedRead ?? 0);
    const afterBlocks = (e.after?.sharedHit ?? 0) + (e.after?.sharedRead ?? 0);
    ok(`the per-row businesses lookup is gone from the plan: ${beforeBlocks} → ${afterBlocks} shared blocks (§11)`);
  }
}

interface PerfArtefact {
  readonly tier?: number;
  readonly executedIn?: string;
  readonly postgres?: string;
  readonly dataset?: { seededLines?: number; reportingLines?: number; reconciliationLines?: number };
  readonly budgets?: Record<string, number>;
  readonly measurements?: { name: string; budgetMs: number; iterations: number; p50: number; p95: number }[];
  readonly planningStatistics?: { table: string; relpages: number; reltuples: number; analyzedAt: string | null }[];
}

/**
 * A BUDGET WITH NO MEASUREMENT IS NOT A BUDGET THAT WAS MET (f §12).
 *
 * Shared by both tiers, because the failure it catches is the same at either
 * size: a run that crashed after four of the six cases leaves a file whose
 * every recorded number is inside its ceiling, and reading only the recorded
 * numbers calls that a pass.
 */
function checkBudgets(label: string, e: PerfArtefact, expectedTier: number): void {
  if (e.tier !== expectedTier) {
    fail(
      's8-budgets',
      `${label} records tier ${String(e.tier)} — a tier ${String(e.tier)} result may not stand in for the tier ${expectedTier} run (f §12, §23)`,
    );
    return;
  }
  const declared = Object.keys(e.budgets ?? {}).length;
  const measured = e.measurements ?? [];
  if (declared === 0 || measured.length < declared) {
    fail('s8-budgets', `${label}: ${measured.length} of ${declared || 6} budgets were measured — a partial run is not a pass (f §12)`);
    return;
  }
  const unmeasured = measured.filter((m) => !(m.iterations > 0));
  if (unmeasured.length > 0) {
    fail(
      's8-budgets',
      `${label}: ${unmeasured.map((m) => m.name).join(', ')} recorded zero iterations — f §12 requires the iteration count beside every number`,
    );
  }
  // A NUMBER MEASURED WITHOUT STATISTICS IS A NUMBER ABOUT THE MISSING
  // STATISTICS (f §11, §12).
  //
  // This is not a hypothetical. `accounts` is read by the trial balance,
  // written by no part of the dataset generator, and about twenty rows per
  // business — under `autovacuum_analyze_threshold`, so nothing analyzed it.
  // The planner estimated one row where there were twenty-one and re-executed
  // the whole journal aggregate once per account: 327 ms on a workstation and
  // 2.9 s on a GitHub runner, where the re-executed side is a parallel
  // `Gather Merge`. The fix belongs in the harness, and this is what proves
  // the harness kept doing it.
  const stats = e.planningStatistics ?? [];
  if (stats.length === 0) {
    fail('s8-budgets', `${label} records no planning statistics — a budget measured by a planner nobody can describe is not evidence (f §11)`);
  } else {
    const blind = stats.filter((s) => s.analyzedAt === null);
    if (blind.length > 0) {
      fail('s8-budgets', `${label}: ${blind.map((s) => s.table).join(', ')} had no statistics when the budgets were measured (f §11, §12)`);
    } else {
      ok(`${label}: every measured table had statistics — ${stats.map((s) => `${s.table} ~${Math.round(s.reltuples)} rows`).join('; ')}`);
    }
  }
  const over = measured.filter((m) => m.p95 > m.budgetMs);
  if (over.length > 0) {
    for (const m of over) fail('s8-budgets', `${label} — ${m.name}: p95 ${m.p95.toFixed(1)} ms against a ${m.budgetMs} ms ceiling (§6, §14)`);
  } else {
    ok(
      `${label}: all ${measured.length} budgets met — ${measured.map((m) => `${m.name} p50 ${m.p50.toFixed(1)} / p95 ${m.p95.toFixed(1)} of ${m.budgetMs}ms × ${m.iterations}`).join('; ')}`,
    );
  }
}

/**
 * TIER 2 IS THE ACCEPTANCE MEASUREMENT, AND A TIER 1 FILE DOES NOT SATISFY IT
 * (§13, §14, §15, §23; f §12).
 *
 * The distinction is the whole point. Tier 1 asserts the same ceilings on a
 * smaller dataset, which is a weaker claim and says so. The budgets §14 names
 * are about 100,000 journal lines for the reporting reads and 1,000,000 for
 * the reconciliation pass, so a file that records a pass over 21,000 lines is
 * not evidence for them — §15 is explicit that a "100k" run which created 21k
 * lines is a FAILURE OF EVIDENCE, not a pass.
 */
function checkPerformance(): void {
  console.log('P2-S8 RELEASE GATE — the budgets, at the sizes they were written for');
  const tier1 = artefact<PerfArtefact>('release/phase2-s8-performance-tier1.json');
  if (tier1 !== null) checkBudgets('Tier 1', tier1, 1);

  const tier2 = artefact<PerfArtefact>('release/phase2-s8-performance-tier2.json');
  if (tier2 === null) return;
  const reporting = tier2.dataset?.reportingLines ?? 0;
  const reconciliation = tier2.dataset?.reconciliationLines ?? 0;
  if (reporting < 100_000) {
    fail(
      's8-tier2',
      `the reporting dataset held ${reporting} journal lines — §13 requires 100,000 for C, D and E, and §15 calls a short dataset a failure of evidence`,
    );
  } else {
    ok(`the reporting dataset actually held ${reporting} journal lines (§13 C/D/E)`);
  }
  if (reconciliation < 1_000_000) {
    fail('s8-tier2', `the reconciliation dataset held ${reconciliation} journal lines — §13 requires 1,000,000 for F`);
  } else {
    ok(`the reconciliation dataset actually held ${reconciliation} journal lines (§13 F)`);
  }
  if ((tier2.postgres ?? '') === '') fail('s8-tier2', 'the Tier 2 file records no PostgreSQL version — f §11 requires it where a measurement depends on it');
  checkBudgets('Tier 2', tier2, 2);
}

function checkRollbackRehearsal(): void {
  console.log('P2-S8 RELEASE GATE — the rollback and restore rehearsal actually ran (f §14, §39–§42)');
  const e = artefact<{ verdict?: string; findings?: string[]; steps?: { step: string; ok: boolean }[] }>('release/phase2-s8-rollback-rehearsal.json');
  if (e === null) return;
  const steps = e.steps ?? [];
  const failedSteps = steps.filter((s) => !s.ok);
  if (steps.length === 0) {
    fail('s8-rollback', 'the rehearsal recorded no steps — an empty rehearsal is not a rehearsal');
  } else if (failedSteps.length > 0) {
    fail('s8-rollback', `${failedSteps.map((s) => s.step).join(', ')} did not pass — ${String(e.verdict)}`);
  } else if (e.verdict !== 'PASS') {
    fail('s8-rollback', `the rehearsal's verdict is ${String(e.verdict)}: ${(e.findings ?? []).join(' | ')}`);
  } else {
    ok(`${steps.length} rehearsal steps, real backup and real restore, verdict PASS`);
  }
}

/**
 * The evidence document says what it says, and this gate reads all of it
 * (f §4: zero mandatory SKIPPED, zero FAIL, verdict PASS).
 *
 * There is no row excluded from this read. The old gate had to exclude two —
 * `GATE-S8`, which was its own previous verdict, and `SUPPLY-01` — because it
 * was being read by the very gate whose result it recorded. That cycle is
 * gone: nothing in `gate:phase2:s8` reads this file, so every row here is a
 * statement some other process made, and every row counts.
 */
function checkEvidenceDocument(): void {
  console.log('P2-S8 RELEASE GATE — the evidence document (f §4, §50)');
  const e = artefact<{
    verdict?: string;
    summary?: { fail?: number; mandatorySkipped?: number; total?: number };
    checks?: { id: string; status: string; mandatory?: boolean; evidence?: string }[];
  }>('release/phase2-s8-evidence.json');
  if (e === null) return;
  const checks = e.checks ?? [];
  const skipped = checks.filter((c) => c.mandatory !== false && c.status.toUpperCase() === 'SKIPPED');
  const failed = checks.filter((c) => c.status.toUpperCase() === 'FAIL');
  if (skipped.length > 0)
    fail('s8-evidence', `${skipped.length} mandatory check(s) recorded SKIPPED: ${skipped.map((c) => c.id).join(', ')} — f §4 requires zero`);
  if (failed.length > 0) fail('s8-evidence', `${failed.length} check(s) recorded FAIL: ${failed.map((c) => c.id).join(', ')}`);
  if ((e.summary?.mandatorySkipped ?? -1) !== 0) fail('s8-evidence', `summary.mandatorySkipped is ${String(e.summary?.mandatorySkipped)} — f §26 requires 0`);
  if ((e.summary?.fail ?? -1) !== 0) fail('s8-evidence', `summary.fail is ${String(e.summary?.fail)} — f §26 requires 0`);
  if (e.verdict !== 'PASS') fail('s8-evidence', `the evidence document's own verdict is ${String(e.verdict)} — f §26 requires PASS`);
  if (failures === 0) ok(`${checks.length} recorded checks, 0 mandatory skipped, 0 failed, verdict PASS`);
}

checkArtefactsExist();
checkExactShaBinding();
checkPerformance();
checkRlsEquivalenceEvidence();
checkRollbackRehearsal();
checkEvidenceDocument();

if (failures > 0) {
  console.error(`\nP2-S8 RELEASE GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S8 RELEASE GATE: PASS');
