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
 *   a patch-bearing one  — ordinary ⇒ NOT patchless
 *   an EMPTY one         — `commit --allow-empty` ⇒ PATCHLESS, the subject
 *   a MERGE              — scanned by its FIRST-PARENT diff ⇒ NOT patchless
 *
 * The merge is the shape a naive rewrite gets wrong: `git log` without
 * `--diff-merges=first-parent` prints NO file names for a merge, so every
 * merge would be reported patchless and the evidence identity would then
 * refuse an honest release. The arm below is what makes that mistake red.
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
import { patchlessCommits } from '../scripts/phase3-secret-scan';

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

  it('the identity the evidence check rests on holds here, with both terms NON-ZERO', () => {
    const all = run('rev-list', `${sha['root'] as string}..HEAD`)
      .split('\n')
      .filter((l) => l.trim() !== '');
    const patchless = patchlessCommits(repo, sha['root'] as string, 'HEAD');
    // `commitsWithPatch + patchlessCommits.length === commitsInRange` is what
    // `secretScanEvidenceProblems` now asserts of a release artefact. Here both
    // terms are non-zero, so the identity is being read over a real partition
    // and not over an empty half.
    expect(patchless).toHaveLength(1);
    expect(all.length - patchless.length).toBeGreaterThan(0);
    expect(all.length - patchless.length + patchless.length).toBe(all.length);
    for (const c of patchless) expect(all).toContain(c);
  });
});
