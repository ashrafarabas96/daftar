#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S9 — CI EVIDENCE VOCABULARY, THE MERGE-BASE VALIDATOR, THE
 * EVIDENCE INDEX AND THE RELEASE REPORT
 *
 * S9 IS EVIDENCE ONLY. No product fix belongs to it. If this tooling exposes a
 * product defect it is routed to the owning slice as a finding; nothing here
 * changes a product file, and nothing here is permitted to.
 *
 * ── CI TERMINOLOGY IS PRECISE, AND THE IMPRECISION IS EXPENSIVE ──────────
 *
 * A `push` run checks out the EXACT branch-head SHA. A `pull_request` run
 * checks out GitHub's synthetic merge commit (`refs/pull/N/merge`), which is
 * EQUIVALENT-TREE evidence and is a different commit. The project's evidence
 * law: NEVER report CI SUCCESS for a commit unless a workflow run exists for
 * that EXACT SHA.
 *
 * So an evidence record carries five fields and all five are required: the
 * branch head SHA, the base SHA, the synthetic merge SHA (for a PR run), the
 * run id and the ATTEMPT. The attempt is there because a run that went green
 * on attempt 3 after two red attempts is a different fact from one green at
 * attempt 1, and a record that omits it cannot tell the two apart.
 *
 * ── BRANCH PROTECTION IS TD-08: OPEN / EXTERNAL / UNVERIFIED ─────────────
 *
 * Inspection returns 403. Nothing in this tooling may state that GitHub
 * required checks are configured — it is not verifiable from here. The correct
 * vocabulary is "the six repository CI jobs" or "the six expected release
 * checks", and `vocabularyProblems` refuses the forbidden phrasings in any
 * text S9 produces, including a release report generated from otherwise
 * truthful data.
 *
 * The COMPENSATING CONTROLS are what the project actually relies on, and they
 * are encoded as data so a report cannot quietly omit one.
 */
import { execFileSync } from 'node:child_process';

/** The six repository CI jobs, by the names the workflow gives them. */
export const SIX_CI_JOBS: readonly string[] = ['workspaces', 'backend', 'web-admin', 'android', 'hygiene', 'browser'];

/**
 * The compensating controls for TD-08. Not optional, and not a substitute for
 * branch protection — they are what exists instead of it.
 */
export const COMPENSATING_CONTROLS: readonly { readonly id: string; readonly control: string; readonly verifiableFromHere: boolean }[] = [
  { id: 'CC-1', control: 'PR only — every Phase 4 change goes through PR #6', verifiableFromHere: false },
  { id: 'CC-2', control: 'no direct push to main', verifiableFromHere: false },
  { id: 'CC-3', control: 'no force push', verifiableFromHere: false },
  { id: 'CC-4', control: 'the PR stays Draft until the Tech Lead says otherwise', verifiableFromHere: false },
  { id: 'CC-5', control: 'the six repository CI jobs green before release acceptance', verifiableFromHere: true },
  { id: 'CC-6', control: 'no main merge without explicit owner authorization', verifiableFromHere: false },
];

/** How a run's checkout relates to the commit the evidence is about. */
export type RunTrigger = 'push' | 'pull_request' | 'workflow_dispatch';

export interface CiEvidenceRecord {
  readonly workflow: string;
  readonly trigger: RunTrigger;
  /** The branch-head SHA the evidence is ABOUT. Always required. */
  readonly branchHeadSha: string;
  /** The base the branch is measured against. Always required. */
  readonly baseSha: string;
  /** GitHub's synthetic merge commit, for a `pull_request` run. `null` on a push. */
  readonly syntheticMergeSha: string | null;
  readonly runId: string;
  /** Which attempt this is. A green attempt 3 is not the same fact as a green attempt 1. */
  readonly attempt: number;
  readonly jobs: readonly { readonly name: string; readonly conclusion: string }[];
}

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * THE ONE QUESTION THAT DECIDES WHETHER A RECORD IS EVIDENCE FOR A COMMIT.
 *
 * `exactSha` is true only for a `push` or `workflow_dispatch` run whose
 * checkout IS the commit. A `pull_request` run is equivalent-tree evidence and
 * `describe` labels it as such — in those words, every time, so no reader has
 * to remember the distinction.
 */
export function isExactShaEvidence(record: CiEvidenceRecord): boolean {
  return record.trigger !== 'pull_request' && record.syntheticMergeSha === null;
}

export function describe(record: CiEvidenceRecord): string {
  const green = record.jobs.filter((j) => j.conclusion === 'success').length;
  const verdict = `${green.toString()} of ${record.jobs.length.toString()} job(s) success`;
  if (isExactShaEvidence(record))
    return (
      `${record.workflow} run ${record.runId} attempt ${record.attempt.toString()} (${record.trigger}): ` +
      `EXACT-SHA evidence for ${record.branchHeadSha} against base ${record.baseSha} — ${verdict}`
    );
  return (
    `${record.workflow} run ${record.runId} attempt ${record.attempt.toString()} (pull_request): ` +
    `EQUIVALENT-TREE evidence ONLY. The checkout was the synthetic merge commit ${record.syntheticMergeSha ?? 'UNRECORDED'}, ` +
    `not the branch head ${record.branchHeadSha}; base ${record.baseSha} — ${verdict}`
  );
}

export function evidenceRecordProblems(record: CiEvidenceRecord): string[] {
  const problems: string[] = [];
  if (!SHA40.test(record.branchHeadSha))
    problems.push(`branchHeadSha ${JSON.stringify(record.branchHeadSha)} is not a 40-hex SHA — an abbreviated SHA is not an identity`);
  if (!SHA40.test(record.baseSha)) problems.push(`baseSha ${JSON.stringify(record.baseSha)} is not a 40-hex SHA`);
  if (record.trigger === 'pull_request' && record.syntheticMergeSha === null)
    problems.push(
      'a pull_request run with no syntheticMergeSha recorded: the commit that was actually checked out is unknown, so the record cannot say what it is evidence for',
    );
  if (record.trigger !== 'pull_request' && record.syntheticMergeSha !== null)
    problems.push(
      `a ${record.trigger} run carrying a syntheticMergeSha: a push run checks out the branch head, so recording a merge SHA for it misdescribes the checkout`,
    );
  if (record.runId.trim() === '') problems.push('no run id');
  if (!Number.isInteger(record.attempt) || record.attempt < 1)
    problems.push(
      `attempt ${String(record.attempt)} is not a positive integer — a record without an attempt cannot distinguish a green attempt 3 from a green attempt 1`,
    );
  if (record.jobs.length === 0) problems.push('no job conclusions recorded — an empty job list is never six green jobs');
  return problems;
}

/**
 * `[[daftar-never-report-ci-success-for-a-commit-without-a-run-for-that-sha]]`.
 *
 * Given the commit the release is about, decide what the available records
 * actually prove. The answer a reader needs is one of three, and the middle
 * one is the one that gets lost.
 */
export type ReleaseEvidenceVerdict = 'EXACT_SHA_GREEN' | 'EQUIVALENT_TREE_ONLY' | 'NO_RUN_FOR_THIS_SHA';

export function releaseEvidenceVerdict(
  sealSha: string,
  records: readonly CiEvidenceRecord[],
): { readonly verdict: ReleaseEvidenceVerdict; readonly reasons: readonly string[] } {
  const forThisSha = records.filter((r) => r.branchHeadSha === sealSha);
  if (forThisSha.length === 0)
    return { verdict: 'NO_RUN_FOR_THIS_SHA', reasons: [`no workflow run exists for ${sealSha}; a run on another SHA is not evidence for this one`] };
  const exact = forThisSha.filter((r) => isExactShaEvidence(r));
  if (exact.length === 0)
    return {
      verdict: 'EQUIVALENT_TREE_ONLY',
      reasons: [
        `${forThisSha.length.toString()} run(s) exist for ${sealSha} and every one is a pull_request run on a synthetic merge commit — equivalent-tree evidence, labelled as such`,
      ],
    };
  const reasons: string[] = [];
  for (const record of exact) {
    const missing = SIX_CI_JOBS.filter((job) => !record.jobs.some((j) => j.name === job && j.conclusion === 'success'));
    if (missing.length > 0) reasons.push(`run ${record.runId} attempt ${record.attempt.toString()}: ${missing.join(', ')} not green`);
  }
  return reasons.length === 0 ? { verdict: 'EXACT_SHA_GREEN', reasons: [] } : { verdict: 'EQUIVALENT_TREE_ONLY', reasons };
}

// ─────────────────── THE FORBIDDEN VOCABULARY ─────────────────────────────

/**
 * Phrasings S9 may never produce, because each asserts something TD-08 says is
 * unverifiable from this tooling.
 */
export const FORBIDDEN_PHRASES: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /required\s+(?:status\s+)?checks?\s+(?:are|is|were)\s+configured/i,
    why: 'branch-protection inspection returns 403 (TD-08) — this is not verifiable from here',
  },
  { pattern: /branch\s+protection\s+(?:is|was)\s+(?:enabled|on|configured|verified)/i, why: 'TD-08 is OPEN / EXTERNAL / UNVERIFIED' },
  { pattern: /main\s+is\s+protected/i, why: 'main remains unprotected; the compensating controls are the control' },
  {
    pattern: /the\s+six\s+required\s+checks/i,
    why: 'say "the six repository CI jobs" or "the six expected release checks" — "required" asserts a configuration that cannot be read',
  },
  { pattern: /merge\s+(?:is|was)\s+blocked\s+by\s+github/i, why: 'nothing in GitHub is known to block the merge; the discipline is the control' },
];

export function vocabularyProblems(where: string, text: string): string[] {
  const problems: string[] = [];
  for (const { pattern, why } of FORBIDDEN_PHRASES) {
    const match = pattern.exec(text);
    if (match !== null) problems.push(`${where}: ${JSON.stringify(match[0])} — ${why}`);
  }
  return problems;
}

// ─────────────────── THE MERGE-BASE VALIDATOR ─────────────────────────────

/**
 * `PHASE4_BASE` — the merge of the sealed Phase 3 head into `main`, which is
 * `main`'s own head at the moment the Phase 4 branch was created.
 *
 * DECLARED here and VERIFIED against `git merge-base`, never assumed.
 * `[[daftar-gitleaks-window-slides]]`: a guessed base makes a scan claim a
 * range it did not cover, which is the exact defect `phase3-secret-scan.ts:8-15`
 * exists to prevent.
 */
export const PHASE4_BASE = '6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595';

export interface MergeBaseVerification {
  readonly declared: string;
  readonly head: string;
  readonly mainRef: string;
  readonly observed: string | null;
  readonly agrees: boolean;
  readonly error: string | null;
}

export function verifyMergeBase(repo: string, head: string, mainRef = 'main', declared: string = PHASE4_BASE): MergeBaseVerification {
  let observed: string | null = null;
  let error: string | null = null;
  try {
    observed = execFileSync('git', ['merge-base', head, mainRef], { cwd: repo, encoding: 'utf8' }).trim();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { declared, head, mainRef, observed, agrees: observed === declared, error };
}

export function mergeBaseProblems(verification: MergeBaseVerification): string[] {
  if (verification.error !== null)
    return [`git merge-base ${verification.head} ${verification.mainRef} failed: ${verification.error} — an unverifiable base is not a verified one`];
  if (verification.observed === null) return ['git merge-base produced no output'];
  if (!verification.agrees)
    return [
      `PHASE4_BASE is declared ${verification.declared} and git merge-base ${verification.head} ${verification.mainRef} is ${verification.observed} — ` +
        'the scan would claim a range it did not cover',
    ];
  return [];
}

// ─────────────────── THE EVIDENCE INDEX ───────────────────────────────────

export interface EvidenceArtefact {
  readonly id: string;
  /** What this artefact proves. An artefact with no claim is a file. */
  readonly claim: string;
  /** Where it comes from. */
  readonly producedBy: string;
  /** The path it is written to, relative to the repository root. */
  readonly path: string;
  /** Whether it must exist before the release is accepted. */
  readonly required: boolean;
  /** Whether it is exact-SHA evidence, equivalent-tree evidence, or neither. */
  readonly shaBinding: 'exact-sha' | 'equivalent-tree' | 'not-sha-bound';
}

export const EVIDENCE_INDEX: readonly EvidenceArtefact[] = [
  {
    id: 'E-01',
    claim: 'gate:phase4:release PASS from an EXTRACTED ARCHIVE on a FRESH cluster',
    producedBy: 'the extracted-archive runner',
    path: 'release/phase4/archive-gate.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-02',
    claim: 'a fresh cluster migrated 0000 -> candidate, then a no-op second pass',
    producedBy: 'the fresh-cluster procedure',
    path: 'release/phase4/fresh-cluster.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-03',
    claim: 'a REAL upgrade from the frozen predecessor prefix to the candidate, with the catalogue diffed against a superuser build',
    producedBy: 'the upgrade rehearsal',
    path: 'release/phase4/upgrade-rehearsal.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-04',
    claim: 'every migration file hashes to its manifest digest and its prefix-module digest',
    producedBy: 'the migration hash verifier',
    path: 'release/phase4/migration-hashes.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-05',
    claim: 'the Phase 4 secret-history range scan over PHASE4_BASE..head, with the base VERIFIED against git merge-base',
    producedBy: 'scripts/phase4-secret-scan.ts',
    path: 'release/phase4/secret-history-scan.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-06',
    claim: 'DAFTAR_PHASE_4_RC.zip and its SIBLING .sha256',
    producedBy: 'the RC archive builder',
    path: 'release/DAFTAR_PHASE_4_RC.zip',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-07',
    claim: 'the dependency audit at --audit-level=high, release-blocking, with no --force and no allowlist',
    producedBy: 'npm audit + scripts/check-supply-chain.ts',
    path: 'release/phase4/supply-chain.json',
    required: true,
    shaBinding: 'not-sha-bound',
  },
  {
    id: 'E-08',
    claim: 'a PUSH run of DAFTAR CI green on all six jobs at the seal commit own SHA',
    producedBy: 'GitHub Actions',
    path: 'release/phase4/ci-push-run.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-09',
    claim: 'a release-evidence run at the SAME SHA',
    producedBy: '.github/workflows/phase4-s9-release.yml',
    path: 'release/phase4/release-run.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-10',
    claim: 'the Tier-2 budgets, measured under an exclusive box, every sample kept, planningStatistics non-null',
    producedBy: 'the performance orchestrator under an exclusive-box attestation',
    path: 'release/phase4/budgets-tier2.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-11',
    claim: 'the browser matrix green in all nine combinations over every step, with every plant proven able to fire',
    producedBy: 'npm run gate:browser',
    path: 'release/browser/results.json',
    required: true,
    shaBinding: 'equivalent-tree',
  },
  {
    id: 'E-12',
    claim: 'the R-SAL and R-INV reconciliation pass, each check with a planted-discrepancy red proof',
    producedBy: 'the S8 reconciliation framework, executed',
    path: 'release/phase4/reconciliation.json',
    required: true,
    shaBinding: 'exact-sha',
  },
  {
    id: 'E-13',
    claim: 'the three generated inventories agree with the live tree',
    producedBy: 'scripts/phase4-s8/generate-inventories.ts --check',
    path: 'release/phase4/inventories.json',
    required: true,
    shaBinding: 'exact-sha',
  },
];

export function evidenceIndexProblems(index: readonly EvidenceArtefact[] = EVIDENCE_INDEX): string[] {
  const problems: string[] = [];
  if (index.length === 0) problems.push('the evidence index is EMPTY');
  const ids = new Set<string>();
  for (const artefact of index) {
    if (ids.has(artefact.id)) problems.push(`${artefact.id} is declared twice`);
    ids.add(artefact.id);
    if (artefact.claim.trim() === '') problems.push(`${artefact.id}: no claim — an artefact with no claim is a file`);
    problems.push(...vocabularyProblems(`${artefact.id}`, artefact.claim));
  }
  // The two proofs that are NOT the same proof must both be present and must
  // not be merged into one artefact.
  if (!index.some((a) => a.id === 'E-02')) problems.push('no fresh-cluster artefact — proof (A) is missing');
  if (!index.some((a) => a.id === 'E-03')) problems.push('no upgrade-rehearsal artefact — proof (B) is missing, and A never implies B');
  return problems.filter((p) => p !== '');
}

// ─────────────────── THE RELEASE REPORT ───────────────────────────────────

export interface ReleaseReportInput {
  readonly sealSha: string;
  readonly baseSha: string;
  readonly ciRecords: readonly CiEvidenceRecord[];
  readonly artefactsPresent: readonly string[];
  readonly archiveSha256: string | null;
  readonly mergeBase: MergeBaseVerification;
}

/**
 * The release report, GENERATED. Its text is passed through
 * `vocabularyProblems` by `releaseReportProblems`, so a report cannot claim
 * branch protection even if its input data happens to be truthful.
 */
export function renderReleaseReport(input: ReleaseReportInput): string {
  const verdict = releaseEvidenceVerdict(input.sealSha, input.ciRecords);
  const missing = EVIDENCE_INDEX.filter((a) => a.required && !input.artefactsPresent.includes(a.id));
  const lines: string[] = [
    '# DAFTAR — PHASE 4 RELEASE REPORT (P4-S9)',
    '',
    '**S9 is EVIDENCE ONLY.** No product fix belongs to this slice. Where this tooling exposed a product defect it is routed to the owning slice as a',
    'finding and is listed below, not fixed here.',
    '',
    '| | |',
    '|---|---|',
    `| seal commit | \`${input.sealSha}\` |`,
    `| base | \`${input.baseSha}\` |`,
    `| merge-base verified | ${input.mergeBase.agrees ? `yes, \`${input.mergeBase.observed ?? ''}\`` : '**NO**'} |`,
    `| RC archive sha256 | ${input.archiveSha256 === null ? '**absent**' : `\`${input.archiveSha256}\``} |`,
    `| CI evidence verdict | **${verdict.verdict}** |`,
    '',
    '## CI runs, by the exact terminology',
    '',
    'A `push` run checks out the exact branch-head SHA. A `pull_request` run checks out the synthetic merge commit and is EQUIVALENT-TREE evidence only.',
    '',
    ...(input.ciRecords.length === 0 ? ['_No run recorded._'] : input.ciRecords.map((r) => `- ${describe(r)}`)),
    ...(verdict.reasons.length === 0 ? [] : ['', '### Why the verdict is not EXACT_SHA_GREEN', '', ...verdict.reasons.map((r) => `- ${r}`)]),
    '',
    '## Branch protection — TD-08',
    '',
    // The first draft of this line DENIED the forbidden claim ("nothing here
    // states that GitHub required checks are configured") and the vocabulary
    // scanner matched it — correctly. A lexical scanner cannot tell a denial
    // from a claim, and neither can a reader who quotes one sentence out of a
    // release report. So the phrase is not here in any grammatical mood.
    'TD-08 is **OPEN / EXTERNAL / UNVERIFIED**: inspection returns 403, so this report makes no statement at all about the repository branch-protection',
    'settings — neither that they exist nor that they do not. What is relied on instead is the six repository CI jobs and the compensating controls:',
    '',
    '| id | control | verifiable from this tooling |',
    '|---|---|---|',
    ...COMPENSATING_CONTROLS.map((c) => `| ${c.id} | ${c.control} | ${c.verifiableFromHere ? 'yes' : 'no — external'} |`),
    '',
    '## The two deployment proofs, which are not the same proof',
    '',
    '**(A) a fresh cluster from `0000` to the candidate** and **(B) a real upgrade from the frozen predecessor prefix to the candidate**. A success of',
    '(A) is never a safety claim about (B). A suite that applies migrations as a superuser is never asked the two questions that decide whether a',
    'deployment works — so (B) performs the deployment as the non-superuser principal and then diffs the catalogue against a superuser build.',
    '',
    '## Required evidence',
    '',
    '| id | claim | present |',
    '|---|---|---|',
    ...EVIDENCE_INDEX.filter((a) => a.required).map((a) => `| ${a.id} | ${a.claim} | ${input.artefactsPresent.includes(a.id) ? 'yes' : '**NO**'} |`),
    '',
    missing.length === 0
      ? '_Every required artefact is present._'
      : `**${missing.length.toString()} required artefact(s) absent: ${missing.map((a) => a.id).join(', ')}.**`,
    '',
    '## Verdict',
    '',
    verdict.verdict === 'EXACT_SHA_GREEN' && missing.length === 0 && input.mergeBase.agrees
      ? 'Every required artefact is present and the six repository CI jobs are green at the seal commit own SHA. **A green gate grants no authority to merge.**'
      : '**NOT RELEASABLE.** See above. A green gate grants no authority to merge, and an incomplete evidence set grants less.',
    '',
  ];
  return lines.join('\n');
}

export function releaseReportProblems(text: string): string[] {
  return vocabularyProblems('the release report', text);
}
