#!/usr/bin/env tsx
/**
 * PHASE 4 — THE SECRET-HISTORY RANGE SCAN (`P4-AL-78`)
 *
 *   npx tsx scripts/phase4-secret-scan.ts --head=<sha> [--base=derive]
 *   npx tsx scripts/phase4-secret-scan.ts --verify-base-only
 *   npx tsx scripts/phase4-secret-scan.ts --tree=<dir>        # extracted archive
 *
 * `P4-AL-78`: the Phase 4 secret-history scan is bounded at the Phase 3 head,
 * and `PHASE4_BASE` is **VERIFIED rather than assumed** — against
 * `git merge-base`, every run. `[[daftar-gitleaks-window-slides]]`: a GUESSED
 * base makes the scan claim a range it did not cover, which is the exact
 * defect `scripts/phase3-secret-scan.ts:8-15` exists to prevent.
 *
 * ── THE ENGINE IS NOT REWRITTEN ──────────────────────────────────────────
 *
 * The scanning engine is the ACCEPTED `scripts/phase3-secret-scan.ts`, reused
 * unchanged: the same pinned checksum-verified gitleaks `8.24.3` (archive
 * digest and binary digest both), the same default rule set with a
 * `.gitleaks.toml` refused, the same `--ignore-gitleaks-allow`, the same bare
 * clone so the scanned directory carries no ignore file, the same
 * three-condition `.gitleaksignore` discipline (exact fingerprints, a reason
 * comment, and a proof that the line is a migration digest), and the same tree
 * mode for an extracted archive. Rewriting it would create a second scanner
 * that can disagree with the accepted one, and the disagreement would be
 * discovered by a release, not by a test.
 *
 * What is Phase 4's is the BASE. `PHASE4_BASE` is the merge of the sealed
 * Phase 3 head into `main` — `main`'s own head when the Phase 4 branch was
 * cut — and the delegation is safe precisely because, for a Phase 4 head, the
 * merge-base of head and `main` IS that commit, so the engine's
 * already-merged-Phase-3 path (which rescans the sealed Phase 3 range) is not
 * taken. That condition is ASSERTED here rather than assumed, because if it
 * ever stopped holding the scan would silently cover the wrong range.
 *
 * ── A FALSE POSITIVE IS ANSWERED BY REWRITING HISTORY ────────────────────
 *
 * `[[daftar-clean-history-not-a-weaker-scan]]`. A false positive in CANDIDATE
 * history is answered by rewriting that history — never by an allowlist and
 * never by weakening the scan. And ACCEPTED SHAs are IMMUTABLE: once a commit
 * is part of a sealed range, it is not rewritten, so a finding there is a
 * finding, not a candidate for a rewrite.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PHASE4_BASE, mergeBaseProblems, verifyMergeBase } from './phase4-s9/evidence';
import { GITLEAKS_BINARY_SHA256, GITLEAKS_VERSION, type ScanResult, ensureGitleaks, git, gitRun, scan } from './phase3-secret-scan';

export { PHASE4_BASE };

/** The sealed Phase 3 head, the upper bound of the predecessor range (`P4-AL-78`). */
export const PHASE3_SEALED_HEAD = 'dd59962c2e53119d5cd5dea0d44df5d2f207a512';

export interface Phase4ScanResult {
  readonly produced: 'scripts/phase4-secret-scan.ts';
  /** Stated plainly: the engine is the accepted Phase 3 scanner, reused. */
  readonly engine: 'scripts/phase3-secret-scan.ts';
  readonly tool: { readonly name: 'gitleaks'; readonly version: string; readonly pinnedBinarySha256: string };
  readonly phase4Base: string;
  readonly baseVerifiedAgainstMergeBase: boolean;
  readonly delegation: ScanResult;
  readonly problems: readonly string[];
  readonly result: 'PASS' | 'FAIL';
}

/**
 * The precondition that makes the delegation sound: the merge-base of the head
 * and `main` is `PHASE4_BASE`. Asserted, not assumed.
 */
export function delegationPreconditionProblems(repo: string, head: string, mainRef = 'main'): string[] {
  const verification = verifyMergeBase(repo, head, mainRef, PHASE4_BASE);
  const problems = mergeBaseProblems(verification);
  if (problems.length > 0) return problems;
  // And the head must NOT be an ancestor-equal of the base, or there is
  // nothing to scan — which is not evidence of anything.
  const count = gitRun(repo, ['rev-list', '--count', `${PHASE4_BASE}..${head}`]);
  if (count.status !== 0) return [`git rev-list --count ${PHASE4_BASE}..${head} failed`];
  if (Number(count.stdout.toString('utf8').trim()) === 0)
    return [`there is no commit in ${PHASE4_BASE}..${head}: nothing to scan, which is not evidence of anything`];
  return [];
}

export function scanPhase4(options: {
  readonly repo: string;
  readonly head: string;
  readonly base?: string;
  readonly mainRef?: string;
  readonly gitleaks?: string;
}): Phase4ScanResult {
  const repo = resolve(options.repo);
  const base = options.base ?? PHASE4_BASE;
  const problems: string[] = [];
  if (base !== 'derive') problems.push(...delegationPreconditionProblems(repo, options.head, options.mainRef ?? 'main'));

  const binary = options.gitleaks ?? ensureGitleaks(undefined, repo);
  const delegation = scan({
    repo,
    head: options.head,
    base,
    ...(options.mainRef === undefined ? {} : { mainRef: options.mainRef }),
    gitleaks: binary,
    // The engine's already-merged-Phase-3 path keys off this. The
    // precondition above guarantees it is not taken for a Phase 4 head; it is
    // passed explicitly so the behaviour does not depend on the engine's
    // default changing.
    phase3Head: PHASE3_SEALED_HEAD,
  });
  if (delegation.mergedInto !== undefined)
    problems.push(
      `the engine took its already-merged-Phase-3 path (mergedInto ${delegation.mergedInto}) and scanned the SEALED Phase 3 range instead of the Phase 4 range — ` +
        'the delegation precondition has stopped holding and this result is not a Phase 4 scan',
    );
  return {
    produced: 'scripts/phase4-secret-scan.ts',
    engine: 'scripts/phase3-secret-scan.ts',
    tool: { name: 'gitleaks', version: GITLEAKS_VERSION, pinnedBinarySha256: GITLEAKS_BINARY_SHA256 },
    phase4Base: base,
    baseVerifiedAgainstMergeBase: base !== 'derive' && problems.length === 0,
    delegation,
    problems: [...problems, ...delegation.problems],
    result: problems.length === 0 && delegation.result === 'PASS' ? 'PASS' : 'FAIL',
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const repo = resolve(arg('repo') ?? join(__dirname, '..'));
  const evidence = arg('evidence');

  if (args.includes('--verify-base-only')) {
    const head = arg('head') ?? git(repo, ['rev-parse', 'HEAD']);
    const verification = verifyMergeBase(repo, head, arg('main-ref') ?? 'main', PHASE4_BASE);
    const problems = mergeBaseProblems(verification);
    console.log(JSON.stringify(verification, null, 2));
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL ${problem}`);
      process.exit(1);
    }
    console.log(`PASS PHASE4_BASE ${PHASE4_BASE} is the merge-base of ${head} and ${verification.mainRef}`);
    process.exit(0);
  }

  const tree = arg('tree');
  if (tree !== undefined) {
    // Tree mode for an extracted archive: there is no history to scan, and
    // saying so is the point. The engine's own tree mode is the substitute and
    // is labelled as one, never reported as a range scan.
    if (!existsSync(tree)) {
      console.error(`FAIL the tree ${tree} does not exist`);
      process.exit(1);
    }
    console.error(
      'FAIL tree mode is delegated to `npx tsx scripts/phase3-secret-scan.ts --tree=<dir>`, whose tree arm is the accepted implementation. ' +
        'This script does not reimplement it: a second tree scanner could disagree with the accepted one, and the disagreement would be found by a release.',
    );
    process.exit(1);
  }

  const head = arg('head') ?? git(repo, ['rev-parse', 'HEAD']);
  const result = scanPhase4({ repo, head, base: arg('base') ?? PHASE4_BASE, ...(arg('main-ref') === undefined ? {} : { mainRef: arg('main-ref') ?? 'main' }) });
  if (evidence !== undefined) writeFileSync(evidence, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  for (const problem of result.problems) console.error(`  ${problem}`);
  console.log(
    `${result.result} phase4 secret-history range scan: base ${result.phase4Base}, head ${result.delegation.head ?? 'unresolved'}, ` +
      `${result.delegation.commitsInRange?.toString() ?? '?'} commit(s) in range (${result.delegation.mergesInRange?.toString() ?? '?'} merge(s)), ` +
      `${result.delegation.findings?.toString() ?? '?'} finding(s), ${result.delegation.remaining.length.toString()} remaining`,
  );
  process.exit(result.result === 'PASS' ? 0 : 1);
}
