/**
 * CARD L4-q9-01 — ITEM 3: THE RANGE IS COUNTED IN ONE PASS, AND THE SET IT
 * NAMES MUST BE THE SAME SET.
 *
 * `patchlessCommits` used to run two git processes per commit
 * (`rev-parse --verify` then `diff --quiet`): about 2 641 processes and 39.5
 * seconds on the 1 319-commit range `PHASE3_BASE..origin/main`, measured. It
 * now runs ONE `git log --diff-merges=first-parent --name-only`: 50 ms,
 * measured on the same range.
 *
 * A rewrite for speed is only safe if it names the SAME commits, so this law
 * builds a repository whose answer is known before it is asked rather than
 * asserting against a range whose contents nobody checked. The repository has
 * four shapes on purpose, and each exists to make one branch of the rule
 * observable:
 *
 *   a ROOT commit        — no parent at all, whole tree scanned ⇒ NOT patchless
 *                          (an EMPTY root is patchless, and that is the one
 *                          shape where this algorithm differs from the
 *                          per-commit one it replaced — see the scanner)
 *   a patch-bearing one  — ordinary ⇒ NOT patchless
 *   an EMPTY one         — `commit --allow-empty` ⇒ PATCHLESS, the subject
 *   a MERGE              — scanned by its FIRST-PARENT diff ⇒ NOT patchless
 *
 * The merge is the shape a naive rewrite gets wrong: `git log` without
 * `--diff-merges=first-parent` prints NO file names for a merge, so every
 * merge would be reported patchless and the evidence identity would then
 * refuse an honest release. The arm below reddens on that mistake — and it is
 * NOT the only guard: `tests-unit/rel11-patchless-commit-identity-law.test.ts`
 * already holds `REL11-P4`, «A MERGE IS NOT PATCHLESS, because the walk is
 * first-parent». Calling this arm the thing that makes the mistake red claimed
 * a guard that already had a sibling; what is genuinely new here is the ROOT
 * commit arm. (Third review of this cart, finding 6.)
 *
 * NOTE ON THE OTHER CONTROL, the one this file cannot hold: the one-pass set
 * was also compared against the per-commit set on the real range, and on
 * `b309b3b2..0aa22682` — a range documented to hold exactly one patchless
 * commit — both implementations named exactly `0aa22682`. The all-green
 * comparison on `PHASE3_BASE..origin/main` is NOT evidence by itself: both
 * sets were empty there, and a probe with no subject reads like a pass.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GITLEAKS_BINARY_SHA256,
  GITLEAKS_VERSION,
  PHASE3_BASE,
  patchlessCommits,
  secretScanEvidenceProblems,
  type ScanResult,
} from '../scripts/phase3-secret-scan';

/**
 * A record every OTHER check in the validator accepts, so the arm below changes
 * only the four fields that carry the partition. Same shape as the one in
 * `secret-scan-evidence-invariant-law.test.ts`, deliberately: these two files
 * read the same validator from two directions — that one from hand-written
 * records, this one from a partition measured on a real repository.
 */
const HEAD = 'b'.repeat(40);
const good: ScanResult = {
  produced: 'scripts/phase3-secret-scan.ts',
  tool: { name: 'gitleaks', version: GITLEAKS_VERSION, binarySha256: GITLEAKS_BINARY_SHA256 },
  mode: 'phase3-base',
  base: PHASE3_BASE,
  head: HEAD,
  mainRef: 'origin/main',
  mergeBase: PHASE3_BASE,
  logOpts: `--diff-merges=first-parent ${PHASE3_BASE}..${HEAD}`,
  commitsInRange: 400,
  mergesInRange: 14,
  commitsWithPatch: 400,
  patchlessCommits: [],
  commitsScanned: 400,
  findings: 3,
  allowlisted: [],
  remaining: [],
  filesScanned: null,
  ignoreFile: { present: true, sha256: null, entries: 3, unused: 0 },
  problems: [],
  result: 'PASS',
};

let repo = '';
const sha: Record<string, string> = {};

const run = (...args: readonly string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'patchless-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  run('config', 'user.email', 'law@example.invalid');
  run('config', 'user.name', 'patchless law');
  run('config', 'commit.gpgsign', 'false');

  writeFileSync(join(repo, 'root.txt'), 'root\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'root');
  sha['root'] = run('rev-parse', 'HEAD');

  writeFileSync(join(repo, 'a.txt'), 'a\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'carries a patch');
  sha['patch'] = run('rev-parse', 'HEAD');

  run('commit', '-q', '--allow-empty', '-m', 'carries NO patch');
  sha['empty'] = run('rev-parse', 'HEAD');

  // a side branch off the patch-bearing commit, merged with --no-ff so the
  // merge commit's first-parent diff is the side branch it brought in
  run('checkout', '-q', '-b', 'side', sha['patch'] as string);
  writeFileSync(join(repo, 'side.txt'), 'side\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'on the side branch');
  sha['side'] = run('rev-parse', 'HEAD');
  run('checkout', '-q', 'main');
  run('merge', '-q', '--no-ff', '--no-edit', 'side');
  sha['merge'] = run('rev-parse', 'HEAD');

  // an UNRELATED root, used only as a base so a range can contain main's own
  // root commit — `A..B` always excludes A itself.
  run('checkout', '-q', '--orphan', 'elsewhere');
  run('rm', '-rq', '--cached', '.');
  writeFileSync(join(repo, 'elsewhere.txt'), 'elsewhere\n');
  run('add', 'elsewhere.txt');
  run('commit', '-q', '-m', 'an unrelated root');
  sha['orphan'] = run('rev-parse', 'HEAD');
  // `-f`: the orphan branch left main's files untracked, and this is a
  // throwaway directory under the OS temp dir, created by `mkdtempSync` in
  // this `beforeAll` and removed in `afterAll` — nothing here belongs to
  // anyone, so there is nothing to lose.
  run('checkout', '-q', '-f', 'main');
});

afterAll(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
});

describe('L4-q9-01 item 3: one pass over the range names exactly the commits that carry no patch', () => {
  it('names the EMPTY commit and nothing else, over a range whose answer is known in advance', () => {
    const out = patchlessCommits(repo, sha['root'] as string, 'HEAD');
    expect(out).toEqual([sha['empty']]);
  });

  it('does NOT name the merge, because a merge is read by its first-parent diff — the mistake a naive rewrite makes', () => {
    const out = patchlessCommits(repo, sha['root'] as string, 'HEAD');
    expect(out).not.toContain(sha['merge']);
    // and the side commit it brought in is itself patch-bearing
    expect(out).not.toContain(sha['side']);
  });

  it('counts an EMPTY ROOT commit as PATCHLESS — the one shape where this algorithm differs from the one it replaced', () => {
    // THE CONTRACT THIS CART DECLARED AND DID NOT PIN. The per-commit version
    // skipped every parentless commit, so it called an empty root
    // patch-bearing; this one sees an empty block and calls it patchless. Both
    // the scanner's comment and this file's header state that the new reading
    // is the right one for the identity — an empty root carries no bytes for
    // gitleaks to scan — and review measured that restoring the OLD behaviour
    // left the entire unit lane green. A decision no arm holds is prose.
    //
    // Its own repository, because `main`'s root here has content: a second
    // temp repo whose FIRST commit is `--allow-empty`.
    const other = mkdtempSync(join(tmpdir(), 'emptyroot-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', other]);
      const g = (...args: readonly string[]): string => execFileSync('git', ['-C', other, ...args], { encoding: 'utf8' }).trim();
      g('config', 'user.email', 'law@example.invalid');
      g('config', 'user.name', 'patchless law');
      g('config', 'commit.gpgsign', 'false');
      g('commit', '-q', '--allow-empty', '-m', 'an EMPTY root');
      const emptyRoot = g('rev-parse', 'HEAD');
      writeFileSync(join(other, 'a.txt'), 'a\n');
      g('add', '-A');
      g('commit', '-q', '-m', 'carries a patch');
      const withPatch = g('rev-parse', 'HEAD');

      // the range must contain the root, so the base is an UNRELATED root
      g('checkout', '-q', '--orphan', 'elsewhere');
      g('rm', '-rq', '--cached', '.');
      writeFileSync(join(other, 'elsewhere.txt'), 'x\n');
      g('add', 'elsewhere.txt');
      g('commit', '-q', '-m', 'an unrelated root');
      const base = g('rev-parse', 'HEAD');
      g('checkout', '-q', '-f', 'main');

      const all = g('rev-list', `${base}..HEAD`).split('\n');
      expect(all, 'the range does not hold the empty root, so this arm measures nothing').toContain(emptyRoot);
      const out = patchlessCommits(other, base, 'HEAD');
      expect(out).toContain(emptyRoot);
      expect(out).not.toContain(withPatch);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('counts a ROOT commit as patch-bearing, since its whole tree is scanned', () => {
    // A range cannot exclude its own base, so the root is reached by taking the
    // base from an UNRELATED root: `orphan..HEAD` contains every commit on main
    // including this history's first one.
    const out = patchlessCommits(repo, sha['orphan'] as string, 'HEAD');
    const all = run('rev-list', `${sha['orphan'] as string}..HEAD`).split('\n');
    expect(all).toContain(sha['root']); // the range really does hold the root
    expect(out).not.toContain(sha['root']); // and the root is not patchless
    expect(out).toEqual([sha['empty']]); // still exactly one, over the wider range
  });

  it('the VALIDATOR accepts the partition this function measures, and refuses it when one term is bent', () => {
    // THE FOURTH REVIEW'S BLOCKING FINDING, and it was right in the worst way:
    // this arm used to assert
    //   `all.length - patchless.length + patchless.length === all.length`
    // which is an arithmetic identity, true of any two numbers, and so could
    // never redden — a claim TRUE BY CONSTRUCTION in the one file whose whole
    // creed is that such claims are worthless. It also never called
    // `secretScanEvidenceProblems`, while its title said «the identity the
    // evidence check rests on».
    //
    // So the measured partition is now fed TO the validator, which is the only
    // thing that can make the claim a reading rather than a restatement, and
    // the same record is then bent to prove the validator is looking.
    const all = run('rev-list', `${sha['root'] as string}..HEAD`)
      .split('\n')
      .filter((l) => l.trim() !== '');
    const patchless = patchlessCommits(repo, sha['root'] as string, 'HEAD');
    expect(patchless).toHaveLength(1);
    const withPatch = all.length - patchless.length;
    expect(withPatch, 'the patch-bearing half is empty, so the identity is read over half a partition').toBeGreaterThan(0);

    const measured: ScanResult = {
      ...good,
      commitsInRange: all.length,
      commitsWithPatch: withPatch,
      commitsScanned: withPatch,
      patchlessCommits: patchless,
    };
    expect(secretScanEvidenceProblems(measured, HEAD), 'the validator refuses the partition this function actually measures').toEqual([]);

    // AND IT IS LOOKING: drop the patchless commit from the list and the sum no
    // longer accounts for the range. One term bent, nothing else.
    expect(secretScanEvidenceProblems({ ...measured, patchlessCommits: [] }, HEAD)).not.toEqual([]);
    // and the mirror: claim one more patch-bearing commit than the range holds
    expect(secretScanEvidenceProblems({ ...measured, commitsWithPatch: all.length, commitsScanned: all.length }, HEAD)).not.toEqual([]);

    for (const c of patchless) expect(all).toContain(c);
  });
});
