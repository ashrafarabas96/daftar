/**
 * REL-11 — WHAT THE SECRET SCAN'S COUNT IS A COUNT OF.
 *
 * `scripts/phase3-secret-scan.ts` requires gitleaks' own «N commits scanned»
 * to equal the range's size. That equality refused a branch with no secret in
 * it, because the two numbers do not have the same identity: gitleaks scans
 * PATCHES, and a commit whose patch is empty has no bytes to scan, so it is
 * not counted. Correct behaviour, read as a gap.
 *
 * Measured in CI on 2026-11-16, run `43851805698`, job `hygiene`, step
 * «Secret history range scan»: gitleaks reported `no leaks found` and the
 * guard failed with «gitleaks scanned 6 commits but the range
 * b309b3b2..0aa22682 holds 7». The range holds exactly one patchless commit,
 * `0aa22682`, and `git diff --quiet 0aa22682^1 0aa22682` exits 0 while a
 * patch-bearing commit in the same range exits 1 — so the probe
 * discriminates, and the deficit was exactly that commit.
 *
 * WHY THIS LAW IS HERE AND NOT ONLY IN `tests/security/p3c-secret-scan.test.ts`.
 * That suite runs the REAL gitleaks, which the script downloads as a
 * `linux_x64` binary — so it cannot run on a Windows workstation, and its arm
 * for this defect is proven in CI only. This file measures the thing the fix
 * actually changed — THE IDENTITY OF THE COUNT — against real git
 * repositories built here, so the red-first proof does not depend on a
 * platform. The end-to-end pairing (gitleaks' number equals this one) stays in
 * the security suite, where the binary exists.
 *
 * It is a law over `patchlessCommits`, the function the guard consumes, not
 * over the guard's text: see the project rule that a law pins the adjudicator
 * and not its image.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchlessCommits } from '../scripts/phase3-secret-scan';

const dirs: string[] = [];

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Canary',
      GIT_AUTHOR_EMAIL: 'canary@example.invalid',
      GIT_COMMITTER_NAME: 'Canary',
      GIT_COMMITTER_EMAIL: 'canary@example.invalid',
    },
  }).trim();
}

/** A real repository: one base commit, then the described commits in order. */
function build(commits: readonly ('patch' | 'empty')[]): { repo: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'rel11-patchless-'));
  dirs.push(repo);
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repo, 'README.md'), '# base\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  commits.forEach((kind, i) => {
    if (kind === 'empty') {
      git(repo, ['commit', '--quiet', '--allow-empty', '-m', `empty ${String(i)}`]);
    } else {
      writeFileSync(join(repo, `file-${String(i)}.txt`), `change ${String(i)}\n`, 'utf8');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', `patch ${String(i)}`]);
    }
  });
  return { repo, base, head: git(repo, ['rev-parse', 'HEAD']) };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('REL-11 the identity of the secret scan’s commit count', () => {
  it('REL11-P1 A PATCHLESS COMMIT IS NAMED, AND IT IS THE ONLY ONE', () => {
    const { repo, base, head } = build(['patch', 'patch', 'empty', 'patch']);
    const patchless = patchlessCommits(repo, base, head);

    // 1. THE POSITIVE CONTROL FIRST: the range is the size it looks.
    expect(Number(git(repo, ['rev-list', '--count', `${base}..${head}`]))).toBe(4);

    // 2. EXACTLY ONE commit is reported, and it is the empty one BY NAME —
    //    not merely a count that happens to be 1, which would also be
    //    satisfied by naming the wrong commit.
    expect(patchless).toHaveLength(1);
    const empties = git(repo, ['log', '--format=%H %s', `${base}..${head}`])
      .split('\n')
      .filter((l) => l.includes('empty '))
      .map((l) => l.split(' ')[0]);
    expect(empties).toHaveLength(1);
    expect(patchless[0]).toBe(empties[0]);
  });

  it('REL11-P2 (negative control) A RANGE WITH NO PATCHLESS COMMIT REPORTS NONE', () => {
    // Without this, a function that returned every commit — or that happened
    // to return one for any range — would pass the arm above.
    const { repo, base, head } = build(['patch', 'patch', 'patch']);
    expect(patchlessCommits(repo, base, head)).toEqual([]);
  });

  it('REL11-P3 SEVERAL PATCHLESS COMMITS, AND THE COUNT IS NOT THE RANGE', () => {
    const { repo, base, head } = build(['empty', 'patch', 'empty', 'empty', 'patch']);
    const patchless = patchlessCommits(repo, base, head);
    expect(Number(git(repo, ['rev-list', '--count', `${base}..${head}`]))).toBe(5);
    expect(patchless).toHaveLength(3);
    // The number the guard compares gitleaks against: 5 - 3.
    expect(5 - patchless.length).toBe(2);
  });

  it('REL11-P4 A MERGE IS NOT PATCHLESS, because the walk is first-parent', () => {
    // The guard passes `--diff-merges=first-parent` to gitleaks, so a merge's
    // patch is the branch it brought in. If this function called a merge
    // patchless, the narrowing would UNDERCOUNT and the guard would start
    // refusing every range that contains a merge — a wrong direction of its
    // own, and one that an arm about empty commits would never catch.
    const { repo, base } = build(['patch']);
    git(repo, ['checkout', '--quiet', '-b', 'side']);
    writeFileSync(join(repo, 'side.txt'), 'side\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'side patch']);
    git(repo, ['checkout', '--quiet', 'main']);
    writeFileSync(join(repo, 'main.txt'), 'main\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'main patch']);
    git(repo, ['merge', '--quiet', '--no-ff', '-m', 'merge side', 'side']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    expect(git(repo, ['rev-list', '--count', '--merges', `${base}..${head}`])).toBe('1');
    expect(patchlessCommits(repo, base, head)).toEqual([]);
  });

  it('REL11-P5 AN EMPTY RANGE IS EMPTY, not everything', () => {
    // `base..base` holds nothing; a reader that fell back to "all commits"
    // here would make the guard's zero-check unreachable.
    const { repo, base } = build(['patch']);
    expect(patchlessCommits(repo, base, base)).toEqual([]);
  });
});
