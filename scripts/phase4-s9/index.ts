#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S9 — THE RELEASE-EVIDENCE CHECK REGISTRY
 *
 * S9 IS EVIDENCE ONLY. No product fix belongs to this slice. Where this
 * tooling exposes a product defect it is reported as a FINDING against the
 * owning slice — the registry below names the owner on every such row — and it
 * is never repaired here.
 *
 * The registry reuses `FrameworkCheck` / `evaluateCheck` from the S8 verdict
 * module ON PURPOSE, so the no-fake-PASS law is the SAME law in both slices
 * and not a second implementation of it: a check whose subject is not real
 * reports `WAITING_FOR_INTEGRATED_SURFACE`, and `evaluate` is not called at
 * all while a subject is absent. A release gate is the single worst place for
 * a vacuous green, because its green is the thing a human reads instead of
 * doing the deployment themselves.
 *
 * This is NOT `gate:phase4:release`. That gate — composed from
 * `gate:phase3:release` and `gate:phase4:s8`, run as ONE command from an
 * extracted archive — cannot exist until S5, S6, S7 and S8 seal, and its npm
 * alias and CI wiring are PATCH REQUESTS, because `.github/workflows/**` is
 * the evidence surface for a slice currently in acceptance and
 * `scripts/phase4-s*-gate.ts` has one owner per slice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeSubject } from '../phase4-s8/tree';
import { type CheckOutcome, type FrameworkCheck, evaluateCheck, runVerdict, tally } from '../phase4-s8/verdict';
import { PHASE4_INHERITED_PREFIX, PHASE4_PREFIX } from '../phase4-prefix';
import {
  COMPENSATING_CONTROLS,
  EVIDENCE_INDEX,
  PHASE4_BASE,
  SIX_CI_JOBS,
  evidenceIndexProblems,
  mergeBaseProblems,
  releaseReportProblems,
  renderReleaseReport,
  verifyMergeBase,
  vocabularyProblems,
} from './evidence';
import {
  CATALOGUE_DIMENSIONS,
  EXTRACTED_ARCHIVE_PROCEDURE,
  RELEASE_PLAN,
  UPGRADE_REHEARSAL_PROCEDURE,
  archiveProblems,
  auditProblems,
  catalogueDiffProblems,
  headSha,
  migrationHashProblems,
  procedureProblems,
  releasePlanProblems,
  sharpPinProblems,
  skipFlagProblems,
  verifyMigrationHashes,
} from './release';
import { describeResolution, resolutionContainmentProblems } from './resolution-containment';
import { secretScanCoverage, secretScanCoverageProblems } from './workflow-asymmetry';

const PROOFS = 'tests/guards/p4s89-framework-laws.test.ts';
const WAITING_PROOF = 'tests/guards/p4s89-waiting-status-law.test.ts';

/** A subject that is this tooling's own source: deleted, the check waits rather than passing over nothing. */
const selfSubject = (file: string, exported: string, why: string) => ({ kind: 'module-export', name: `${file}#${exported}`, owedBy: 'P4-S9', why }) as const;

/**
 * The name/digest pairs of every ACCEPTED migration, from the prefix modules.
 *
 * Three independent sources decide a migration's digest — the file, the
 * manifest, and these literals — and the honest weakness is recorded in
 * `verifyMigrationHashes`'s own comment: one commit could change all three.
 * Three sources is still strictly better than two, and S9 does not get to
 * repair the weakness, only to state it.
 */
function prefixDigests(): ReadonlyMap<string, string> {
  return new Map([...PHASE4_INHERITED_PREFIX, ...PHASE4_PREFIX].map(([name, sha256]) => [name, sha256] as const));
}

/** The declared release audit invocation, which `auditProblems` is asked about. */
const DECLARED_AUDIT = {
  command: 'npm audit --audit-level=high && npm run check:supply-chain',
  level: 'high',
  ignoredAdvisories: [] as readonly string[],
  allowlist: [] as readonly string[],
} as const;

export const S9_CHECKS: readonly FrameworkCheck[] = [
  // ───── THE RELEASE GATE PLAN ────────────────────────────────────────────
  {
    id: 'release-plan-ordering',
    title: 'the release plan orders its steps so that no verdict is read before one can be read',
    ok: 'the runner canary is first, the RELEASE_GATE_SKIP_* refusal is near the front, both deployment proofs are present, the archive is built after the dependency audit, and the archive re-run follows the build',
    subjects: [
      selfSubject('scripts/phase4-s9/release.ts', 'RELEASE_PLAN', 'the plan itself'),
      {
        kind: 'suite',
        name: 'scripts/runner-canary.ts',
        owedBy: 'P4-S0',
        why: 'step 1 runs it; a plan whose canary does not exist cannot prove an exit status can say NO',
      },
    ],
    evaluate: () => releasePlanProblems(),
    redProof: `${PROOFS}::the release plan refuses a canary that is not the first step`,
    note: () =>
      `${RELEASE_PLAN.length.toString()} ordered steps, ${RELEASE_PLAN.filter((s) => s.inExtractedArchive).length.toString()} of them required to run inside the extracted archive`,
  },
  {
    id: 'release-skip-flags-refused',
    title: 'no RELEASE_GATE_SKIP_* is set in the environment this tooling runs in',
    ok: 'the environment carries no skip flag, so nothing in the release path is running a reduced matrix',
    subjects: [selfSubject('scripts/phase4-s9/release.ts', 'skipFlagProblems', 'the refusal itself')],
    // Deliberately evaluated against the LIVE environment rather than a
    // literal: a skip flag set in the shell that runs the release is exactly
    // the case this refusal exists for, and a check that only reads a constant
    // would pass in that shell.
    evaluate: () => skipFlagProblems(process.env),
    redProof: `${PROOFS}::the skip-flag refusal fires on a planted RELEASE_GATE_SKIP_ variable`,
  },

  // ───── IS THE TREE BEING JUDGED THE TREE THAT RESOLVED? ─────────────────
  {
    id: 'resolution-containment',
    title: 'every @daftar/* import resolves inside the root being judged, and every workspace package is built from it',
    ok: 'no workspace link escapes this root, no declared entry point is missing, and no build output is older than its sources — so the verdict is about this tree and not another one',
    subjects: [
      {
        kind: 'suite',
        name: 'node_modules/@daftar',
        owedBy: 'P4-S0',
        why: 'without an install there is no resolution to contain; an extracted archive before `npm ci` must report that it cannot answer rather than answering yes',
      },
      selfSubject('scripts/phase4-s9/resolution-containment.ts', 'resolutionContainmentProblems', 'the checker itself'),
    ],
    // MEASURED, not assumed: this check found `@daftar/design-system` unbuilt
    // in this very worktree, which would have turned every import of it into
    // TS2307 and read as a defect in the importing code.
    evaluate: (root) => resolutionContainmentProblems(root),
    redProof: `${PROOFS}::the resolution checker names a workspace link that escapes the root being judged`,
    note: (root) => describeResolution(root),
  },

  // ───── MIGRATION HASH VERIFICATION ──────────────────────────────────────
  {
    id: 'migration-hash-verification',
    title: 'every migration on disk hashes to its manifest digest and its prefix-module digest',
    ok: 'all accepted migrations agree across the three independent sources; a candidate past frozenThrough is legitimately absent from the manifest and is not reported as a finding',
    subjects: [
      selfSubject('scripts/phase4-prefix.ts', 'PHASE4_PREFIX', 'the independent digest literals the manifest is checked against'),
      {
        kind: 'suite',
        name: 'infrastructure/database/MIGRATION_MANIFEST.json',
        owedBy: 'P4-S0',
        why: 'the manifest is one of the three sources; without it nothing is verified against anything',
      },
    ],
    evaluate: (root) => migrationHashProblems(verifyMigrationHashes(root, prefixDigests())),
    redProof: `${PROOFS}::the migration hash verifier reports a mutated accepted migration`,
    note: (root) => {
      const rows = verifyMigrationHashes(root, prefixDigests());
      const accepted = rows.filter((r) => r.inManifest !== null).length;
      return `${rows.length.toString()} migration file(s) on disk, ${accepted.toString()} recorded in the manifest, ${rows.filter((r) => !r.agrees).length.toString()} disagreeing`;
    },
  },

  // ───── THE SECRET-HISTORY RANGE SCAN ────────────────────────────────────
  {
    id: 'secret-scan-push-coverage',
    title: 'the secret-history range scan covers the PUSH path, which is the exact-SHA evidence path',
    ok: 'the range-scan step runs on both triggers, so the one run that is exact-SHA evidence for the commit being released is a run in which the candidate history was scanned',
    subjects: [
      {
        kind: 'workflow-step',
        name: 'Secret history range scan (every commit of the pull request)',
        owedBy: 'P4-S0',
        why: 'the step whose trigger coverage decides whether candidate history is scanned at all; its absence would be a different and larger finding',
      },
    ],
    // This check is RED on the live tree, and that is the point: it is the one
    // S9 check whose subject is fully real today, so it is the proof that this
    // registry can say FAIL about something other than itself.
    evaluate: (root) => secretScanCoverageProblems(root),
    redProof: `${PROOFS}::the trigger-asymmetry detector names the live ci.yml secret-scan step and its line`,
    note: (root) => {
      const coverage = secretScanCoverage(root);
      return `${coverage.rangeSteps.length.toString()} asymmetric range-scan step(s); uncovered trigger(s): ${coverage.uncoveredTriggers.join(', ') || 'none'}`;
    },
  },
  {
    id: 'secret-scan-base-verified',
    title: 'PHASE4_BASE is the real git merge-base of this head and main (P4-AL-78)',
    ok: 'the declared base agrees with git merge-base, so the scanned range is the range the scan claims to have covered',
    subjects: [selfSubject('scripts/phase4-secret-scan.ts', 'PHASE3_SEALED_HEAD', 'the Phase 4 scan entry point that verifies rather than assumes its base')],
    evaluate: (root) => {
      const head = headSha(root);
      if (head === null) return ['git rev-parse HEAD failed, so no base can be verified — which is reported, never passed over'];
      return mergeBaseProblems(verifyMergeBase(root, head, 'main', PHASE4_BASE));
    },
    redProof: `${PROOFS}::the merge-base verifier refuses a declared base that is not the merge-base`,
    note: (root) => {
      const head = headSha(root);
      const v = head === null ? null : verifyMergeBase(root, head, 'main', PHASE4_BASE);
      return `declared ${PHASE4_BASE.slice(0, 12)}…, observed ${v?.observed?.slice(0, 12) ?? 'unresolved'}`;
    },
  },
  {
    id: 'secret-scan-phase4-alias',
    title: 'the Phase 4 range scan is reachable as `npm run scan:secrets:phase4`',
    ok: 'the release plan step 4 names a script that exists, so the step executes the scan rather than failing as a missing script',
    subjects: [
      {
        kind: 'npm-script',
        name: 'scan:secrets:phase4',
        owedBy: 'P4-S9',
        why: 'the alias is a PATCH REQUEST against package.json; until it is added, the release plan names a command that does not resolve',
      },
    ],
    evaluate: (root) => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.['scan:secrets:phase4'] ?? '';
      return script.includes('phase4-secret-scan.ts')
        ? []
        : [
            `scan:secrets:phase4 is ${JSON.stringify(script)} and must invoke scripts/phase4-secret-scan.ts, not the Phase 3 engine directly with a Phase 4 name`,
          ];
    },
    redProof: `${WAITING_PROOF}::secret-scan-phase4-alias reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },

  // ───── SUPPLY CHAIN ─────────────────────────────────────────────────────
  {
    id: 'supply-chain-audit-invocation',
    title: 'the declared dependency audit is release-blocking at --audit-level=high with no forbidden remedy',
    ok: 'no --force, no lowered level, no ignored advisory and no allowlist — a real High advisory is answered by a narrow reviewed fix folded into the final RC checksum',
    subjects: [selfSubject('scripts/phase4-s9/release.ts', 'auditProblems', 'the refusal of the forbidden remedies')],
    evaluate: () => auditProblems(DECLARED_AUDIT),
    redProof: `${PROOFS}::the audit refusal fires on --force, a lowered level, an ignore and an allowlist`,
  },
  {
    id: 'supply-chain-sharp-pin',
    title: 'sharp resolves to 0.35.5 in the lockfile',
    ok: 'every lockfile entry for sharp resolves to the pin, read from the lockfile rather than from a package.json range',
    subjects: [
      { kind: 'suite', name: 'package-lock.json', owedBy: 'P4-S0', why: 'the pin is a property of the resolved tree; a range in package.json is not a pin' },
    ],
    evaluate: (root) => sharpPinProblems(root),
    redProof: `${PROOFS}::the sharp pin check reports a lockfile that resolves a different version`,
  },

  // ───── THE TWO DEPLOYMENT PROOFS ────────────────────────────────────────
  {
    id: 'extracted-archive-procedure',
    title: 'the extracted-archive procedure is complete and every step states its reason',
    ok: 'six steps, each with the class of clean-runner failure it exists for, including the no-.git step that makes a history-dependent check say it cannot run rather than pass',
    subjects: [selfSubject('scripts/phase4-s9/release.ts', 'EXTRACTED_ARCHIVE_PROCEDURE', 'the procedure itself')],
    evaluate: () => procedureProblems(EXTRACTED_ARCHIVE_PROCEDURE, 'extracted-archive'),
    redProof: `${PROOFS}::a procedure step with no reason is refused`,
    note: () => `${EXTRACTED_ARCHIVE_PROCEDURE.length.toString()} steps`,
  },
  {
    id: 'upgrade-rehearsal-procedure',
    title: 'the upgrade rehearsal is a REAL upgrade as the non-superuser deployment principal, diffed against a superuser build',
    ok: 'seven steps starting from the frozen predecessor prefix, applying as daftar_migrator, requiring a no-op second pass, and diffing the catalogue — with the finding routed to the owning slice, never fixed here',
    subjects: [selfSubject('scripts/phase4-s9/release.ts', 'UPGRADE_REHEARSAL_PROCEDURE', 'the procedure itself')],
    evaluate: () => {
      const problems = procedureProblems(UPGRADE_REHEARSAL_PROCEDURE, 'upgrade-rehearsal');
      // Proof (A) never implies proof (B). A procedure that starts from `0000`
      // is a fresh install wearing an upgrade's name, so the step that decides
      // which proof this is gets asserted explicitly.
      if (!UPGRADE_REHEARSAL_PROCEDURE.some((s) => /frozen predecessor prefix/i.test(s.what)))
        problems.push('no step starts the rehearsal at the FROZEN PREDECESSOR PREFIX — a rehearsal that starts from 0000 is proof (A) wearing proof (B) name');
      if (!UPGRADE_REHEARSAL_PROCEDURE.some((s) => /daftar_migrator/.test(s.what)))
        problems.push(
          'no step applies the candidate as `daftar_migrator` — a suite that applies migrations as a superuser is never asked who owns the object or who may do what to it',
        );
      return problems;
    },
    redProof: `${PROOFS}::the upgrade rehearsal refuses a procedure that starts from 0000`,
    note: () => `${UPGRADE_REHEARSAL_PROCEDURE.length.toString()} steps`,
  },
  {
    id: 'upgrade-catalogue-diff-dimensions',
    title: 'the upgrade catalogue diff covers every dimension, grants and ownership included',
    ok: 'all twelve dimensions are covered, so the forgotten GRANT — which WARNS and COMMITS and therefore produces a green migration with a missing privilege — is caught by the diff',
    subjects: [selfSubject('scripts/phase4-s9/release.ts', 'CATALOGUE_DIMENSIONS', 'the dimension list')],
    evaluate: () => catalogueDiffProblems(CATALOGUE_DIMENSIONS),
    redProof: `${PROOFS}::the catalogue diff refuses a cover set that omits grants and ownership`,
    note: () => `${CATALOGUE_DIMENSIONS.length.toString()} dimensions`,
  },
  {
    id: 'fresh-cluster-runner',
    title: 'proof (A): a fresh cluster migrated 0000 -> candidate, then a no-op second pass',
    ok: 'the from-zero runner exists and the release plan invokes it as a blocking step producing E-02',
    subjects: [
      {
        kind: 'npm-script',
        name: 'check:db-from-zero',
        owedBy: 'P4-S0',
        why: 'proof (A) is performed by this runner; without it the fresh-install claim has no producer',
      },
    ],
    evaluate: () => {
      const step = RELEASE_PLAN.find((s) => s.id === 'fresh-cluster');
      if (step === undefined) return ['the release plan has no fresh-cluster step'];
      const problems: string[] = [];
      if (!step.blocking) problems.push('the fresh-cluster step is not blocking');
      if (step.produces !== 'E-02') problems.push(`the fresh-cluster step produces ${step.produces ?? 'nothing'} and must produce E-02`);
      if (!step.readsExitStatus) problems.push('the fresh-cluster step does not read an exit status, so nothing records whether it succeeded');
      return problems;
    },
    redProof: `${PROOFS}::the fresh-cluster check refuses a non-blocking step`,
  },

  // ───── THE RC ARCHIVE ───────────────────────────────────────────────────
  {
    id: 'rc-archive-builder',
    title: 'the RC archive builder is reachable and emits a SIBLING .sha256',
    ok: 'export:release:phase4 exists, the archive is built after the dependency audit, and the checksum is a sibling file naming the archive so an operator can verify it with sha256sum -c',
    subjects: [
      {
        kind: 'npm-script',
        name: 'export:release:phase4',
        owedBy: 'P4-S9',
        why: 'the alias is a PATCH REQUEST against package.json; until it exists, step 11 of the release plan names a command that does not resolve and no archive is produced',
      },
    ],
    evaluate: (root) => archiveProblems(root),
    redProof: `${WAITING_PROOF}::rc-archive-builder reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },

  // ───── THE INTEGRATED RELEASE GATE ──────────────────────────────────────
  {
    id: 'release-gate-composed',
    title: 'gate:phase4:release composes the predecessor gates VERBATIM and INTERNALLY',
    ok: 'the release gate runs as ONE command from an extracted archive with no workflow around it, composing gate:phase3:release and gate:phase4:s8',
    subjects: [
      {
        kind: 'npm-script',
        name: 'gate:phase4:release',
        owedBy: 'P4-S9',
        why: 'the integrated gate cannot exist until S5, S6, S7 and S8 seal — a gate wired while red by design can never show a real regression appearing',
      },
      {
        kind: 'npm-script',
        name: 'gate:phase4:s8',
        owedBy: 'P4-S8',
        why: 'the composed child; S8 ships a framework runner, and the gate alias is a patch request once the predecessor slices seal',
      },
    ],
    evaluate: (root) => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.['gate:phase4:release'] ?? '';
      const problems: string[] = [];
      for (const child of ['gate:phase3:release', 'gate:phase4:s8'])
        if (!script.includes(child)) problems.push(`gate:phase4:release does not compose ${child}`);
      return problems;
    },
    redProof: `${WAITING_PROOF}::release-gate-composed reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },

  // ───── THE EVIDENCE INDEX AND THE REPORT ────────────────────────────────
  {
    id: 'evidence-index',
    title: 'the evidence index is complete, unique, and keeps the two deployment proofs separate',
    ok: 'every artefact carries a claim and a SHA binding, ids are unique, and both E-02 (fresh install) and E-03 (real upgrade) exist as separate artefacts because A never implies B',
    subjects: [selfSubject('scripts/phase4-s9/evidence.ts', 'EVIDENCE_INDEX', 'the index itself')],
    evaluate: () => evidenceIndexProblems(),
    redProof: `${PROOFS}::the evidence index refuses an index with no upgrade-rehearsal artefact`,
    note: () =>
      `${EVIDENCE_INDEX.length.toString()} artefacts, ${EVIDENCE_INDEX.filter((a) => a.shaBinding === 'exact-sha').length.toString()} exact-SHA bound, ${EVIDENCE_INDEX.filter((a) => a.required).length.toString()} required`,
  },
  {
    id: 'release-report-vocabulary',
    title: 'the generated release report uses the TD-08 vocabulary and claims no branch protection',
    ok: 'the report renders, says "the six repository CI jobs", records branch head / base / synthetic merge SHA / run id / attempt, and contains none of the forbidden phrases',
    subjects: [selfSubject('scripts/phase4-s9/evidence.ts', 'renderReleaseReport', 'the generator whose output is checked')],
    evaluate: (root) => {
      const head = headSha(root) ?? '0'.repeat(40);
      // Rendered over a WORST-CASE input — no CI records and no artefacts — so
      // the vocabulary is checked on the path a reader is most likely to be
      // handed, the one where the report has to say NO.
      const text = renderReleaseReport({
        sealSha: head,
        baseSha: PHASE4_BASE,
        ciRecords: [],
        artefactsPresent: [],
        archiveSha256: null,
        mergeBase: verifyMergeBase(root, head, 'main', PHASE4_BASE),
      });
      const problems = [...releaseReportProblems(text)];
      for (const control of COMPENSATING_CONTROLS)
        if (!text.includes(control.id))
          problems.push(`the report omits compensating control ${control.id} (${control.control}) — TD-08 is OPEN, so the controls are what stands in for it`);
      problems.push(...vocabularyProblems('the compensating-control table', COMPENSATING_CONTROLS.map((c) => c.control).join(' ')));
      return problems;
    },
    redProof: `${PROOFS}::the release report refuses the phrase "required status checks are configured"`,
    note: () =>
      `${SIX_CI_JOBS.length.toString()} repository CI jobs, ${COMPENSATING_CONTROLS.length.toString()} compensating controls, ${COMPENSATING_CONTROLS.filter((c) => c.verifiableFromHere).length.toString()} verifiable from here`,
  },
  {
    id: 'ci-exact-sha-evidence',
    title: 'a PUSH run of DAFTAR CI green on all six jobs at the seal commit own SHA, plus a release-evidence run at the SAME SHA',
    ok: 'both runs exist for the exact SHA being released, recorded with run id and attempt, and no pull_request run is reported as the same commit unless it genuinely is',
    subjects: [
      {
        kind: 'suite',
        name: '.github/workflows/phase4-s9-release.yml',
        owedBy: 'P4-S9',
        why: 'the release-evidence workflow is a PATCH REQUEST — .github/workflows/** is the evidence surface for a slice in acceptance and is never edited from here',
      },
      {
        kind: 'suite',
        name: 'release/phase4/ci-push-run.json',
        owedBy: 'P4-S9',
        why: 'the recorded push-run evidence; it exists only once a real run at the seal SHA has happened',
      },
    ],
    evaluate: () => [
      'NOT IMPLEMENTED: the subjects became real and this evaluation is still a stub — a stub that returned no problems here would be a fake PASS over real evidence, so it fails loudly instead',
    ],
    redProof: `${WAITING_PROOF}::ci-exact-sha-evidence reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
    note: () => 'branch protection is TD-08, OPEN / EXTERNAL / UNVERIFIED: inspection returns 403, so no claim is made about configured required checks',
  },
  {
    id: 'archive-gate-rerun',
    title: 'the gate re-run from the EXTRACTED archive on a NEW cluster',
    ok: 'the archive extracts into a clean directory, npm ci installs from its own lockfile, a new cluster is started on a unique PG_DIR and PG_PORT, and the gate passes there as one command',
    subjects: [
      {
        kind: 'suite',
        name: 'release/phase4/archive-gate.json',
        owedBy: 'P4-S9',
        why: 'E-01 is produced by performing the re-run; the procedure exists now, the evidence cannot until the archive does',
      },
    ],
    evaluate: () => [
      'NOT IMPLEMENTED: the subject became real and this evaluation is still a stub — a stub that returned no problems here would be a fake PASS over real evidence, so it fails loudly instead',
    ],
    redProof: `${WAITING_PROOF}::archive-gate-rerun reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },
  {
    id: 'upgrade-rehearsal-evidence',
    title: 'proof (B) PERFORMED: the recorded upgrade rehearsal with its catalogue diff',
    ok: 'the rehearsal ran from the frozen predecessor prefix as daftar_migrator and the catalogue diff against a superuser build is recorded, with any difference routed as a finding',
    subjects: [
      {
        kind: 'suite',
        name: 'release/phase4/upgrade-rehearsal.json',
        owedBy: 'P4-S9',
        why: 'proof (B) is proved by performing the upgrade; a procedure document is not the proof',
      },
    ],
    evaluate: () => [
      'NOT IMPLEMENTED: the subject became real and this evaluation is still a stub — a stub that returned no problems here would be a fake PASS over real evidence, so it fails loudly instead',
    ],
    redProof: `${WAITING_PROOF}::upgrade-rehearsal-evidence reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },
  {
    id: 'tier2-budget-evidence',
    title: 'the Tier-2 budgets measured under an EXCLUSIVE BOX',
    ok: 'every budget measured with an exclusive-box attestation, every sample kept, planningStatistics non-null, and no threshold, percentile, sample count or host multiplier changed',
    subjects: [
      {
        kind: 'suite',
        name: 'release/phase4/budgets-tier2.json',
        owedBy: 'P4-S9',
        why: 'S8 BUILDS the orchestrator and the coordinator runs it under an exclusive box; a measurement taken while other agents run is INVALID — RESOURCE CONTENTION, neither pass nor fail',
      },
    ],
    evaluate: () => [
      'NOT IMPLEMENTED: the subject became real and this evaluation is still a stub — a stub that returned no problems here would be a fake PASS over real evidence, so it fails loudly instead',
    ],
    redProof: `${WAITING_PROOF}::tier2-budget-evidence reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },
];

export function runS9(root: string): readonly CheckOutcome[] {
  return S9_CHECKS.map((check) => evaluateCheck(root, check, probeSubject));
}

/**
 * The registry's own structural laws, which `tests/guards` asserts.
 *
 * The one that matters most: every check that is currently WAITING must have a
 * red proof in the WAITING-status suite, because the thing that has to be
 * proved about such a check is precisely that it reports WAITING and not PASS.
 */
export function registryProblems(root: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const check of S9_CHECKS) {
    if (ids.has(check.id)) problems.push(`${check.id} is declared twice`);
    ids.add(check.id);
    const [file] = check.redProof.split('::');
    if (file === undefined || !existsSync(join(root, file)))
      problems.push(`${check.id}: redProof names ${file ?? '(nothing)'}, which is not a suite in this tree`);
    problems.push(...vocabularyProblems(`${check.id}.ok`, check.ok));
  }
  return problems;
}

export { runVerdict, tally };
