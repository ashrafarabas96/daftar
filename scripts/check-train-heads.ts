/**
 * check:train-heads - fail when a branch named as a merge-train or seal-branch
 * member differs between this checkout and `origin`.
 *
 * Why it exists (DR-62 item 3): a train once took a PR at its PUBLISHED head
 * while the commits an owner decision required sat unpushed locally on a base
 * that predated `gh pr update-branch`. Nothing failed; a reviewer found it by
 * reading a recorded decision against the tree. This makes it a failure.
 *
 * Usage:   npm run check:train-heads -- <branch> [<branch> ...]
 *          npm run check:train-heads -- --self-test
 *
 * Rules, each enforced below and each exercised by --self-test:
 *   - comparison is on FULL object names only; a short or malformed name is an
 *     error, never a quiet "same" (an 8-vs-7 character mix-up once reported
 *     all 39 branches as different - a gate that cries wolf is as useless as
 *     one that is silent);
 *   - any difference fails, whatever its direction, and the direction is named;
 *   - a branch absent on origin or absent locally fails by name;
 *   - naming no branch fails: an empty train is not a passing train.
 */
import { execFileSync } from 'node:child_process';

export type Verdict = 'same' | 'local-behind' | 'local-ahead' | 'diverged' | 'unknown-origin-object' | 'absent-on-origin' | 'absent-locally';

export interface Row {
  branch: string;
  local: string | null;
  origin: string | null;
  verdict: Verdict;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function assertFullSha(label: string, sha: string): void {
  if (!FULL_SHA.test(sha)) {
    throw new Error(`${label} is not a full object name (${JSON.stringify(sha)}); refusing to compare abbreviations`);
  }
}

/**
 * Pure classification. `isAncestor(a, b)` answers "is a an ancestor of b" and
 * returns null when an object is not available locally.
 */
export function classify(local: string | null, origin: string | null, isAncestor: (a: string, b: string) => boolean | null): Verdict {
  if (origin === null) return 'absent-on-origin';
  if (local === null) return 'absent-locally';
  assertFullSha('local head', local);
  assertFullSha('origin head', origin);
  if (local === origin) return 'same';
  const localIsBehind = isAncestor(local, origin);
  if (localIsBehind === null) return 'unknown-origin-object';
  if (localIsBehind) return 'local-behind';
  const originIsBehind = isAncestor(origin, local);
  if (originIsBehind === null) return 'unknown-origin-object';
  return originIsBehind ? 'local-ahead' : 'diverged';
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function localHead(branch: string): string | null {
  try {
    return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

function originHead(branch: string): string | null {
  const ref = `refs/heads/${branch}`;
  // A failing ls-remote (network, auth) throws and is NOT read as "absent";
  // only --exit-code's status 2 (no matching ref) means absent.
  let out: string;
  try {
    out = git(['ls-remote', '--exit-code', 'origin', ref]);
  } catch (e) {
    if ((e as { status?: number }).status === 2) return null;
    throw e;
  }
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha) return sha.trim();
  }
  return null;
}

function realIsAncestor(a: string, b: string): boolean | null {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 1) return false;
    return null; // an object is missing locally
  }
}

const ADVICE: Record<Verdict, string> = {
  same: '',
  'local-behind': "origin is ahead of this checkout: `git fetch origin` and fast-forward the branch, or confirm the train was built on origin's head",
  'local-ahead': 'this checkout holds commits origin does not: `git push origin <branch>` before the train is built, or the train will omit them',
  diverged: 'both sides hold commits the other lacks: reconcile (merge or `gh pr update-branch`) and push',
  'unknown-origin-object': "origin's head is not in the local object store: `git fetch origin <branch>` and run again",
  'absent-on-origin': 'not published: `git push origin <branch>` - a member nobody can review is not a member',
  'absent-locally': 'no local branch of this name: `git fetch origin <branch>:<branch>` or fix the name',
};

export function advice(v: Verdict): string {
  return ADVICE[v];
}

export function checkBranches(branches: string[]): Row[] {
  return branches.map((branch) => {
    const local = localHead(branch);
    const origin = originHead(branch);
    return { branch, local, origin, verdict: classify(local, origin, realIsAncestor) };
  });
}

/** Positive and negative controls for the comparator. Returns problems (empty = pass). */
export function selfTest(): string[] {
  const problems: string[] = [];
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // Same first seven characters, different object: a prefix comparison calls these equal.
  const P1 = '1234567' + 'a'.repeat(33);
  const P2 = '1234567' + 'b'.repeat(33);
  const parents = new Map<string, string>([[B, A]]); // A is B's ancestor
  const anc = (x: string, y: string): boolean | null => {
    if (x === y) return true;
    return parents.get(y) === x;
  };
  const expect = (name: string, got: unknown, want: unknown): void => {
    if (got !== want) problems.push(`${name}: got ${String(got)}, want ${String(want)}`);
  };
  expect('identical pair is same', classify(A, A, anc), 'same');
  expect('different pair is not same', classify(A, B, anc) === 'same', false);
  expect('same 7-char prefix, different object, is NOT same', classify(P1, P2, anc) === 'same', false);
  expect('local ancestor of origin is local-behind', classify(A, B, anc), 'local-behind');
  expect('origin ancestor of local is local-ahead', classify(B, A, anc), 'local-ahead');
  expect('neither ancestor is diverged', classify(P1, P2, anc), 'diverged');
  expect(
    'missing object is unknown, never same',
    classify(A, B, () => null),
    'unknown-origin-object',
  );
  expect('absent on origin', classify(A, null, anc), 'absent-on-origin');
  expect('absent locally', classify(null, A, anc), 'absent-locally');
  let rejected = false;
  try {
    classify('abc1234', 'abc12345', anc);
  } catch {
    rejected = true;
  }
  expect('abbreviated names are rejected, not compared', rejected, true);
  return problems;
}

export function main(argv: string[]): number {
  if (argv.includes('--self-test')) {
    const problems = selfTest();
    if (problems.length) {
      console.error(`TRAIN-HEADS SELF-TEST: FAIL\n  - ${problems.join('\n  - ')}`);
      return 1;
    }
    console.log('TRAIN-HEADS SELF-TEST: PASS (10 controls)');
    return 0;
  }
  const unknown = argv.filter((a) => a.startsWith('-'));
  if (unknown.length) {
    console.error(`TRAIN-HEADS: FAIL - unknown option ${unknown.join(' ')}`);
    return 1;
  }
  if (argv.length === 0) {
    console.error('TRAIN-HEADS: FAIL - no branch named. An empty train is not a passing train.');
    return 1;
  }
  let rows: Row[];
  try {
    rows = checkBranches(argv);
  } catch (e) {
    console.error(`TRAIN-HEADS: FAIL - could not read origin: ${(e as Error).message}`);
    return 1;
  }
  for (const r of rows) {
    console.log(`${r.verdict.padEnd(21)} ${r.branch}\n    local  ${r.local ?? '-'}\n    origin ${r.origin ?? '-'}`);
  }
  const bad = rows.filter((r) => r.verdict !== 'same');
  if (bad.length) {
    console.error(`\nTRAIN-HEADS: FAIL (${bad.length} of ${rows.length} differ)`);
    for (const r of bad) console.error(`  ${r.branch} [${r.verdict}]: ${advice(r.verdict)}`);
    return 1;
  }
  console.log(`\nTRAIN-HEADS: PASS (${rows.length} of ${rows.length} identical on full object names)`);
  return 0;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (/check-train-heads\.ts$/.test(entry)) process.exit(main(process.argv.slice(2)));
