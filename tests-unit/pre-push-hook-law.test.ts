/**
 * THE LAW OVER THE TRACKED PRE-PUSH HOOK (owner's decision DR-180/3,
 * 2026-11-24).
 *
 * The two refusals — a push that DELETES a remote ref, and a push whose
 * destination is `main` — moved out of `.git/hooks/`, which no pull request
 * can edit, into `.githooks/`, which any branch touching the file can edit.
 * That trade is only a tightening if the guard is itself guarded, and THIS FILE
 * IS THE WHOLE OF THAT GUARD. It used to say «half of it, the other half being
 * `npm run check:hooks`», and that was false: no CI job runs that script —
 * measured on `d3245a3d`, where `ci.yml` is 2755 lines with 65 `npm run`
 * invocations and ZERO mention of `check:hooks`, `setup:hooks`, `githooks` or
 * `hooksPath`. It is a CONVENIENCE for a developer's checkout, not a gate, and
 * naming it a guard is what let the shipped hook's mode go unpinned while this
 * cart claimed that class was closed.
 *
 * SO EVERY «X IS GUARDED» CLAIM IN THIS FILE ANSWERS TWO QUESTIONS, which is
 * the instrument the third review of this cart produced:
 *   (a) WHICH ARTEFACT does the arm read — the one this repository ships, or a
 *       fixture the arm builds itself?
 *   (b) WHICH REQUIRED JOB runs it?
 * For this file: the arms run in the unit lane, which `npm test` drives inside
 * `backend-static`, one of the ten required jobs (measured from the jobs of run
 * 45348243534). The arm named «THE SHIPPED HOOK of THIS repository» reads the
 * shipped artefact; every other arm here reads a fixture it builds, and says so.
 *
 * IT DOES NOT ONLY READ THE FILE. A law over a shell script's TEXT asserts on
 * a picture of the decider: four spellings of a relaxation can satisfy any
 * pattern I would think to write. So every case below RUNS the hook, through
 * `git push`, against a bare repository in a temporary directory — the refusal
 * is exercised for real with nothing at stake and nothing on the network.
 *
 * AND THE POSITIVE CONTROL COMES FIRST, because it is what makes the other two
 * mean anything: a hook that refused every push would satisfy «refuses a push
 * to main» and «refuses a deletion» while being useless. So an ordinary branch
 * push must SUCCEED in the same fixture, with the same hook wired, before any
 * refusal is believed.
 *
 * `--no-verify` is never passed here. Bypassing the hook is forbidden by the
 * charter (§7), and a law that bypassed it to test it would be measuring
 * nothing.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOOKS_DIR, REQUIRED_HOOKS, wireHooks } from '../scripts/setup-git-hooks';

const ROOT = resolve(__dirname, '..');
const HOOK = join(ROOT, '.githooks', 'pre-push');

let work = '';
let bare = '';
let clone = '';

/** Run a command, returning its exit code and both streams, never throwing. */
function run(cwd: string, cmd: string, ...args: readonly string[]): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const git = (cwd: string, ...args: readonly string[]): { code: number; out: string } => run(cwd, 'git', ...args);

/**
 * Drive the hook on its own stdin protocol: one line per ref,
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * WHY NOT ALWAYS THROUGH `git push`: the cases below are about the hook's
 * COMPARISONS — a 64-zero null id, a tag named `main`, several refs at once —
 * and some of them cannot be produced by a push in a sha1 repository at all.
 * The arms that CAN go through `git push` do, because a refusal that only works
 * on synthesized input is not a refusal.
 */
/**
 * Install the hook the way a real checkout carries it: copied, TRACKED, and
 * `100755` in the index.
 *
 * WHY TRACKED AND NOT JUST COPIED: `wireHooks` now reads the INDEX mode,
 * because git ignores a hook that is not executable and a commit changing
 * `100755` to `100644` would turn both refusals off invisibly. The first
 * fixtures only copied the file, so they were not repositories in the one
 * respect the check is about — and four arms went red the moment the check
 * existed, which is the check earning its place.
 */
function installHook(repo: string, dir = HOOKS_DIR): void {
  mkdirSync(join(repo, dir), { recursive: true });
  copyFileSync(HOOK, join(repo, dir, 'pre-push'));
  chmodSync(join(repo, dir, 'pre-push'), 0o755);
  expect(git(repo, 'add', '--', `${dir}/pre-push`).code).toBe(0);
  expect(git(repo, 'update-index', '--chmod=+x', '--', `${dir}/pre-push`).code).toBe(0);
  expect(git(repo, 'ls-files', '-s', '--', `${dir}/pre-push`).out.trim().startsWith('100755'), 'the fixture did not record the hook as executable').toBe(true);
}

const UNIT_CONFIG = 'vitest.unit.config.ts';

/** The root `package.json`'s scripts, as the repository declares them. */
function rootScripts(): Readonly<Record<string, string>> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

/**
 * Every link in the path from a REQUIRED CI JOB to the file you are reading,
 * as problems — empty means whole.
 *
 * A PURE FUNCTION over text, so each link gets a negative control from a
 * doctored input rather than from a seed in `package.json` or `ci.yml`, which
 * this lane does not own.
 */
function reachabilityProblems(ci: string, scripts: Readonly<Record<string, string>>, unitConfig: string): string[] {
  const problems: string[] = [];
  const lines = ci.split('\n');
  const jobAt = (index: number): string => {
    for (let i = index; i >= 0; i -= 1) {
      const m = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[i] ?? '');
      if (m?.[1] !== undefined) return m[1];
    }
    return '';
  };
  // THE REQUIRED JOBS, named and not counted — the roster this project judges
  // a head by. `npm test` must be run by one of them; a step in a job nobody
  // requires composes nothing.
  const REQUIRED = [
    'workspaces',
    'web-admin',
    'android',
    'browser',
    'hygiene',
    'backend-work',
    'backend-static',
    'backend-gates-p2',
    'backend-golden',
    'backend',
  ];
  const composing = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() === 'run: npm test');
  if (!composing.some(({ i }) => REQUIRED.includes(jobAt(i)))) problems.push('no required job runs `npm test`: the lane is composed by nothing in ci.yml');
  if (!(scripts['test'] ?? '').includes('test:unit')) problems.push('the root `test` script does not compose `test:unit`, so this lane runs nowhere in CI');
  if (!(scripts['test:unit'] ?? '').includes(UNIT_CONFIG)) problems.push(`\`test:unit\` does not name ${UNIT_CONFIG}`);
  if (!unitConfig.includes("include: ['tests-unit/**/*.test.ts']")) problems.push(`${UNIT_CONFIG} does not include tests-unit/`);
  return problems;
}

function runHook(stdin: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [HOOK, 'origin', 'file:///tmp/none'], { input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'prepush-'));
  bare = join(work, 'origin.git');
  clone = join(work, 'clone');

  expect(git(work, 'init', '-q', '--bare', '-b', 'main', bare).code, 'the bare origin could not be created').toBe(0);
  expect(git(work, 'init', '-q', '-b', 'main', clone).code).toBe(0);
  for (const [k, v] of [
    ['user.email', 'law@example.invalid'],
    ['user.name', 'pre-push law'],
    ['commit.gpgsign', 'false'],
    // THE HOOK UNDER TEST, wired the way `npm run setup:hooks` wires it
    ['core.hooksPath', '.githooks'],
  ] as const) {
    expect(git(clone, 'config', k, v).code).toBe(0);
  }
  installHook(clone);

  writeFileSync(join(clone, 'a.txt'), 'a\n');
  expect(git(clone, 'add', '-A').code).toBe(0);
  expect(git(clone, 'commit', '-q', '-m', 'first').code).toBe(0);
  expect(git(clone, 'remote', 'add', 'origin', bare).code).toBe(0);
});

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

describe('DR-180/3: the tracked pre-push hook refuses exactly two things, and allows the rest', () => {
  it('POSITIVE CONTROL: an ordinary branch push SUCCEEDS with the hook wired — without this the refusals below prove nothing', () => {
    const r = git(clone, 'push', 'origin', 'HEAD:refs/heads/feature/ordinary');
    expect(r.out).not.toMatch(/pre-push: REFUSED/);
    expect(r.code, `an ordinary push was refused, so this fixture cannot judge anything:\n${r.out}`).toBe(0);
    // and it really arrived, so the control measured a push and not a no-op
    expect(git(bare, 'rev-parse', '--verify', 'refs/heads/feature/ordinary').code).toBe(0);
  });

  it('REFUSES a push whose destination is `main`, naming it', () => {
    const r = git(clone, 'push', 'origin', 'HEAD:main');
    expect(r.code, 'the push to main was NOT refused').not.toBe(0);
    expect(r.out).toMatch(/pre-push: REFUSED — push to the protected branch 'main'/);
    // and nothing reached the bare repository
    expect(git(bare, 'rev-parse', '--verify', 'refs/heads/main').code, 'main exists on the remote, so the push went through').not.toBe(0);
  });

  it('REFUSES the fully-qualified spelling too, so the refusal is not matching a short name', () => {
    const r = git(clone, 'push', 'origin', 'HEAD:refs/heads/main');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/pre-push: REFUSED — push to the protected branch 'main'/);
  });

  it('REFUSES a DELETION of any remote ref, including the ordinary branch it just allowed', () => {
    const r = git(clone, 'push', 'origin', ':refs/heads/feature/ordinary');
    expect(r.code, 'the deletion was NOT refused').not.toBe(0);
    expect(r.out).toMatch(/pre-push: REFUSED — DELETION of the remote ref 'feature\/ordinary'/);
    // the branch is still there, which is the point of refusing
    expect(git(bare, 'rev-parse', '--verify', 'refs/heads/feature/ordinary').code).toBe(0);
  });

  it('TRIPWIRE: `REQUIRED_HOOKS` holds exactly one hook today, and the sibling sweep is UNPINNED while it does', () => {
    // MEASURED, and said rather than claimed: the sibling-worktree sweep was
    // generalised from the first element to «every required hook», and seeding
    // it back reddens NOTHING — with one element the two forms are the same
    // function. By this project's own rule that is a LINE, not a remedy, so it
    // is recorded as one. This arm is a tripwire, not a proof: the single entry
    // is the contract today, and when a second hook joins the list, the sweep,
    // the undo fallback check and the size floor must each be re-read for
    // whether they actually cover it.
    expect([...REQUIRED_HOOKS]).toEqual(['pre-push']);
  });

  it('REFUSES a 64-zero deletion too, so the sentinel is read as «all zeros» and not as a width', () => {
    // The null object id's width is the repository's hash width. This drives
    // the hook directly on its stdin protocol, because a sha256 repository
    // cannot be made here and the point is the COMPARISON, not git's plumbing.
    const line = `refs/heads/gone ${'0'.repeat(64)} refs/heads/gone ${'1'.repeat(64)}\n`;
    const r = runHook(line);
    expect(r.code, 'a 64-zero deletion was allowed').not.toBe(0);
    expect(r.out).toMatch(/REFUSED — DELETION of the remote ref 'gone'/);
  });

  it('ALLOWS a tag named `main`, and a branch named `main` under a namespace — the protection is the branch, not the word', () => {
    // Measured by review and held by nothing: `refs/tags/main` and
    // `refs/heads/ns/main` are not the protected branch, and a refusal that
    // matched the word would refuse correct pushes.
    for (const ref of ['refs/tags/main', 'refs/heads/ns/main']) {
      const r = runHook(`refs/heads/x ${'a'.repeat(40)} ${ref} ${'b'.repeat(40)}\n`);
      expect(r.out, ref).not.toMatch(/pre-push: REFUSED/);
      expect(r.code, ref).toBe(0);
    }
  });

  it('REFUSES the WHOLE push when several refs are sent and only one is `main`', () => {
    // git feeds every ref on one stdin, and the hook's exit code governs the
    // whole push. Measured by review, pinned here: one forbidden ref among
    // allowed ones must stop all of it, or the refusal is advisory.
    const lines =
      `refs/heads/a ${'a'.repeat(40)} refs/heads/a ${'b'.repeat(40)}\n` +
      `refs/heads/b ${'c'.repeat(40)} refs/heads/main ${'d'.repeat(40)}\n` +
      `refs/heads/c ${'e'.repeat(40)} refs/heads/c ${'f'.repeat(40)}\n`;
    const r = runHook(lines);
    expect(r.code, 'a batch containing main was allowed').not.toBe(0);
    expect(r.out).toMatch(/REFUSED — push to the protected branch 'main'/);
  });

  it('NEGATIVE CONTROL: a branch whose name merely CONTAINS `main` is not the protected branch', () => {
    // `maintenance` is not `main`, and a refusal that matched substrings would
    // refuse a correct push. This is what separates the guard from a grep.
    const r = git(clone, 'push', 'origin', 'HEAD:refs/heads/maintenance');
    expect(r.out).not.toMatch(/pre-push: REFUSED/);
    expect(r.code, `a branch named 'maintenance' was refused:\n${r.out}`).toBe(0);
  });

  // ── THE WIRING AND ITS UNDO, driven through the exported function against a
  //    throwaway repository, because the restoration must be a REVIEWED
  //    MECHANISM and not a tool reached for under pressure (the coordinator's
  //    condition on this cart, after I disarmed 151 of 152 worktrees and
  //    restored them with a second tool).
  describe('`wireHooks` wires, refuses, and undoes — measured on real configuration', () => {
    let repo = '';

    beforeAll(() => {
      repo = join(work, 'wiring');
      expect(git(work, 'init', '-q', '-b', 'main', repo).code).toBe(0);
      installHook(repo);
    });

    it('POSITIVE CONTROL: wiring sets the configuration and the hook then actually governs a push', () => {
      const wired = wireHooks(repo, 'wire');
      expect(wired.lines.join('\n')).toMatch(/core\.hooksPath .* -> '\.githooks'/);
      expect(wired.ok).toBe(true);
      expect(git(repo, 'config', '--get', 'core.hooksPath').out.trim()).toBe(HOOKS_DIR);
      // and it is in force, not merely configured: a push to main is refused
      for (const [k, v] of [
        ['user.email', 'law@example.invalid'],
        ['user.name', 'wiring law'],
        ['commit.gpgsign', 'false'],
      ] as const) {
        expect(git(repo, 'config', k, v).code).toBe(0);
      }
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      expect(git(repo, 'add', '-A').code).toBe(0);
      expect(git(repo, 'commit', '-q', '-m', 'first').code).toBe(0);
      expect(git(repo, 'remote', 'add', 'origin', bare).code).toBe(0);
      const push = git(repo, 'push', 'origin', 'HEAD:main');
      expect(push.code).not.toBe(0);
      expect(push.out).toMatch(/pre-push: REFUSED — push to the protected branch 'main'/);
    });

    it('`undo` unsets the configuration AND says what guards the checkout afterwards', () => {
      // `.git/hooks/pre-push` is what governs once the configuration is gone,
      // so the undo must find it and name it — «undone» is not «guarded».
      const fallback = join(repo, '.git', 'hooks', 'pre-push');
      copyFileSync(HOOK, fallback);
      chmodSync(fallback, 0o755);

      const undone = wireHooks(repo, 'undo');
      expect(undone.ok, undone.lines.join('\n')).toBe(true);
      expect(undone.lines.join('\n')).toMatch(/core\.hooksPath '\.githooks' -> unset/);
      expect(undone.lines.join('\n')).toMatch(/in force now: .*hooks[\\/]pre-push/);
      expect(git(repo, 'config', '--get', 'core.hooksPath').code, 'the configuration is still set').not.toBe(0);
      // and the fallback really governs: the same refusal still fires
      const push = git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
      expect(push.out).toMatch(/pre-push: REFUSED/);
    });

    it('`undo` WRITES NOTHING when undoing would leave the checkout with no refusal', () => {
      // THE ARM'S NAME USED TO BE «FAILS, rather than reporting success …» and
      // it asserted only the exit code and the message — while the checkout
      // really WAS left unguarded, because the first form of `undo` unset the
      // configuration before looking for a fallback. Review caught both: the
      // defect, and that this arm's name was wider than what it pinned. It now
      // reads `core.hooksPath` BACK, which is the only thing that distinguishes
      // «refused» from «did it and then complained».
      const other = join(work, 'unguarded');
      expect(git(work, 'init', '-q', '-b', 'main', other).code).toBe(0);
      installHook(other);
      expect(wireHooks(other, 'wire').ok).toBe(true);
      rmSync(join(other, '.git', 'hooks', 'pre-push'), { force: true });

      const undone = wireHooks(other, 'undo');
      expect(undone.ok, 'undo reported success while leaving the checkout unguarded').toBe(false);
      expect(undone.lines.join('\n')).toMatch(/nothing written/);
      // THE CONFIGURATION IS UNCHANGED — the hook under `.githooks/` still
      // governs, so the checkout is still guarded.
      expect(git(other, 'config', '--get', 'core.hooksPath').out.trim(), 'the configuration was changed despite the refusal').toBe(HOOKS_DIR);
    });

    it('`undo` WRITES NOTHING when the fallback is PRESENT BUT HOLLOW — `existsSync` was the wrong floor', () => {
      // THE HOLE THE THIRD REVIEW FOUND, and it is the same class as the one
      // the arm above closed: the fallback was accepted by `existsSync` alone,
      // so an EMPTY `.git/hooks/pre-push` passed, the configuration was unset,
      // and the report read PASS with `in force now: …` — while the checkout
      // was left with a hook that refuses nothing. `wire` refuses exactly this
      // file sixty lines earlier («presence is not substance»); the restoration
      // path did not, which made the one path built to prevent a guard being
      // removed the one path that removed one.
      const other = join(work, 'hollow-fallback');
      expect(git(work, 'init', '-q', '-b', 'main', other).code).toBe(0);
      installHook(other);
      expect(wireHooks(other, 'wire').ok).toBe(true);
      // present, and hollow
      writeFileSync(join(other, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
      expect(existsSync(join(other, '.git', 'hooks', 'pre-push')), 'the fallback is not present, so this arm measures the missing case instead').toBe(true);

      const undone = wireHooks(other, 'undo');
      expect(undone.ok, 'undo reported success while the fallback refuses nothing').toBe(false);
      expect(undone.lines.join('\n')).toMatch(/nothing written/);
      expect(undone.lines.join('\n')).toMatch(/present, but too small/);
      expect(git(other, 'config', '--get', 'core.hooksPath').out.trim(), 'the configuration was changed despite the refusal').toBe(HOOKS_DIR);
    });

    it('`--check` WRITES NOTHING — the mode whose whole promise is that it only reports', () => {
      // UNPINNED UNTIL THE THIRD REVIEW: `check` is documented as «report
      // without writing», and the only arm that drove it asserted the MESSAGE,
      // so it would have stayed green had `check` fallen through to writing
      // `core.hooksPath`. In a repository where one write to the shared
      // configuration took the guard off 151 worktrees, a read-only promise
      // needs an arm that reads the configuration back.
      //
      // BOTH STATES, because the write could appear in either: unset before
      // (where a write would create the value) and already wired (where a
      // write would be invisible in the value and visible only as a change).
      const other = join(work, 'check-writes-nothing');
      expect(git(work, 'init', '-q', '-b', 'main', other).code).toBe(0);
      installHook(other);

      expect(git(other, 'config', '--get', 'core.hooksPath').code, 'the fixture already has the value, so the unset case is untested').not.toBe(0);
      const unwired = wireHooks(other, 'check');
      expect(unwired.ok, 'check passed on an unwired checkout, so this arm is reading the wrong state').toBe(false);
      expect(git(other, 'config', '--get', 'core.hooksPath').code, '`--check` WROTE core.hooksPath on an unwired checkout').not.toBe(0);

      expect(wireHooks(other, 'wire').ok).toBe(true);
      const before = git(other, 'config', '--get', 'core.hooksPath').out.trim();
      expect(wireHooks(other, 'check').ok, 'check failed on a correctly wired checkout').toBe(true);
      expect(git(other, 'config', '--get', 'core.hooksPath').out.trim(), '`--check` changed the configuration it only reports on').toBe(before);
    });

    it('REFUSES to wire a hook present on disk but UNTRACKED — git has no mode for it, so it would not travel', () => {
      // THE `indexMode === null` BRANCH, which the third review found pinned by
      // nothing: the missing-file arm returns before reaching it, so removing
      // the branch reddened nothing. An untracked hook is the shape this whole
      // cart is about — a file that works here and does not exist for anybody
      // who clones.
      const other = join(work, 'untracked-hook');
      expect(git(work, 'init', '-q', '-b', 'main', other).code).toBe(0);
      for (const [k, v] of [
        ['user.email', 'law@example.invalid'],
        ['user.name', 'prepush law'],
        ['commit.gpgsign', 'false'],
      ] as const) {
        expect(git(other, 'config', k, v).code).toBe(0);
      }
      writeFileSync(join(other, 'a.txt'), 'a\n');
      expect(git(other, 'add', '-A').code).toBe(0);
      expect(git(other, 'commit', '-q', '-m', 'first').code).toBe(0);
      // the hook, on disk, with substance, and NOT added to the index
      mkdirSync(join(other, HOOKS_DIR), { recursive: true });
      copyFileSync(HOOK, join(other, HOOKS_DIR, 'pre-push'));
      expect(git(other, 'ls-files', '-s', '--', `${HOOKS_DIR}/pre-push`).out.trim(), 'the fixture tracked the hook, so the untracked branch is untested').toBe(
        '',
      );

      const refused = wireHooks(other, 'wire');
      expect(refused.ok, 'wiring was allowed with an untracked hook').toBe(false);
      expect(refused.lines.join('\n')).toMatch(/is not tracked, so git has no mode for it/);
      expect(git(other, 'config', '--get', 'core.hooksPath').code, 'the configuration was written despite the refusal').not.toBe(0);
    });

    it('REFUSES to wire while any SIBLING WORKTREE lacks the directory — the check the original mistake needed', () => {
      // THE HEART OF THIS CART, and it would otherwise be pinned by nothing:
      // every arm above uses a repository with ONE worktree, which passes the
      // check whether or not the check exists. Here a second worktree is
      // added and `.githooks/` is untracked, so that worktree does not have
      // it — exactly the shape that disarmed 151 of 152 worktrees of the real
      // repository, because `core.hooksPath` is shared and the directory is
      // not.
      const shared = join(work, 'shared');
      expect(git(work, 'init', '-q', '-b', 'main', shared).code).toBe(0);
      for (const [k, v] of [
        ['user.email', 'law@example.invalid'],
        ['user.name', 'wiring law'],
        ['commit.gpgsign', 'false'],
      ] as const) {
        expect(git(shared, 'config', k, v).code).toBe(0);
      }
      writeFileSync(join(shared, 'c.txt'), 'c\n');
      expect(git(shared, 'add', '-A').code).toBe(0);
      expect(git(shared, 'commit', '-q', '-m', 'first').code).toBe(0);
      installHook(shared);

      // one worktree: wiring is allowed (the positive control for this arm,
      // without which «refuses» could be «refuses always»)
      expect(wireHooks(shared, 'check').lines.join('\n')).not.toMatch(/worktrees have no/);

      const sibling = join(work, 'sibling');
      expect(git(shared, 'worktree', 'add', '-q', '-b', 'side', sibling).code, 'the sibling worktree could not be created').toBe(0);
      expect(existsSync(join(sibling, HOOKS_DIR, 'pre-push')), 'the sibling unexpectedly has the hooks directory').toBe(false);

      const refused = wireHooks(shared, 'wire');
      expect(refused.ok, 'wiring was allowed while a sibling worktree had no hooks directory').toBe(false);
      expect(refused.lines.join('\n')).toMatch(/of 2 worktrees have no \.githooks\//);
      expect(refused.lines.join('\n')).toMatch(/core\.hooksPath is SHARED/);
      // AND NOTHING WAS WRITTEN, which is the part that matters
      expect(git(shared, 'config', '--get', 'core.hooksPath').code, 'the configuration was written despite the refusal').not.toBe(0);
    });

    it('SKIPS in a delivered archive, where there is no repository to configure', () => {
      // `tests/security/archive-portability.test.ts` requires every git
      // invocation under `scripts/**` to carry a `DELIVERY_MANIFEST.json`
      // branch, a try/catch fallback, or a place on its five-file allowlist.
      // CI found this script with none of the three (`backend-work`, step 15,
      // «Integration + security tests»), and the allowlist is pinned by an arm
      // to exactly those five — so widening it would have reddened a contract
      // to make my own change pass. The branch is the sanctioned route and the
      // right behaviour: a delivered tree carries the manifest and no `.git`.
      const archive = join(work, 'archive');
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'DELIVERY_MANIFEST.json'), '{}\n');
      // no `git init` here at all: if the script shells out, it fails
      const out = wireHooks(archive, 'wire');
      expect(out.ok, out.lines.join('\n')).toBe(true);
      expect(out.lines.join('\n')).toMatch(/SKIPPED — DELIVERY_MANIFEST\.json is present/);
      // AND THE POSITIVE CONTROL: the same call in a real repository does NOT
      // skip, so «skips» is not «skips always»
      const real = join(work, 'not-an-archive');
      expect(git(work, 'init', '-q', '-b', 'main', real).code).toBe(0);
      installHook(real);
      const wired = wireHooks(real, 'wire');
      expect(wired.lines.join('\n')).not.toMatch(/SKIPPED/);
      expect(wired.ok).toBe(true);
    });

    it('REFUSES to wire a hook tracked as NOT EXECUTABLE — the change that would turn both refusals off invisibly', () => {
      // git looks a hook up with `access(X_OK)` and silently ignores one that
      // is not executable, so a commit turning `100755` into `100644` removes
      // both refusals on every Linux and macOS checkout, and that change is
      // not a line in a diff. The INDEX mode is read, not the filesystem's,
      // because NTFS does not carry the bit at all.
      const repo644 = join(work, 'mode644');
      expect(git(work, 'init', '-q', '-b', 'main', repo644).code).toBe(0);
      installHook(repo644);
      expect(git(repo644, 'update-index', '--chmod=-x', '--', `${HOOKS_DIR}/pre-push`).code).toBe(0);
      expect(git(repo644, 'ls-files', '-s', '--', `${HOOKS_DIR}/pre-push`).out.trim().startsWith('100644')).toBe(true);

      const out = wireHooks(repo644, 'wire');
      expect(out.ok, 'wiring was allowed with the hook tracked as non-executable').toBe(false);
      expect(out.lines.join('\n')).toMatch(/tracked as 100644, not 100755/);
      expect(git(repo644, 'config', '--get', 'core.hooksPath').code, 'the configuration was written despite the refusal').not.toBe(0);
    });

    it('REFUSES to WIRE over a `core.hooksPath` it did not set, as `undo` already refused to unset one', () => {
      // `wire` used to overwrite whatever the configuration held — an absolute
      // path, another tool's directory, anything — without refusing and
      // without keeping the old value, while `undo` refused to touch a foreign
      // value and unsets rather than restores it. Review named the asymmetry:
      // the two modes must not disagree about whose configuration this is.
      const foreignWire = join(work, 'foreign-wire');
      expect(git(work, 'init', '-q', '-b', 'main', foreignWire).code).toBe(0);
      installHook(foreignWire);
      expect(git(foreignWire, 'config', 'core.hooksPath', 'somebody-elses-hooks').code).toBe(0);

      const out = wireHooks(foreignWire, 'wire');
      expect(out.ok, 'wiring overwrote a foreign core.hooksPath').toBe(false);
      expect(out.lines.join('\n')).toMatch(/which this script did not set/);
      expect(git(foreignWire, 'config', '--get', 'core.hooksPath').out.trim()).toBe('somebody-elses-hooks');
    });

    it('REFUSES to wire an EMPTY hook — presence is not substance', () => {
      // The size floor was added because a review observed that `existsSync`
      // accepts a file whose refusals have been deleted. It was then pinned by
      // NOTHING: seeding `size < 512` to `size < 0` left the whole suite green.
      const empty = join(work, 'emptyhook');
      expect(git(work, 'init', '-q', '-b', 'main', empty).code).toBe(0);
      mkdirSync(join(empty, HOOKS_DIR), { recursive: true });
      writeFileSync(join(empty, HOOKS_DIR, 'pre-push'), '');
      expect(git(empty, 'add', '--', `${HOOKS_DIR}/pre-push`).code).toBe(0);
      expect(git(empty, 'update-index', '--chmod=+x', '--', `${HOOKS_DIR}/pre-push`).code).toBe(0);

      const out = wireHooks(empty, 'wire');
      expect(out.ok, 'wiring was allowed with an empty hook').toBe(false);
      expect(out.lines.join('\n')).toMatch(/is only 0 bytes/);
    });

    it('REFUSES to wire when the hook is MISSING or is a directory', () => {
      // The missing/not-a-file check's only red came from an ENOENT inside
      // `statSync` in an unrelated fixture — a red for a reason other than the
      // one the check names, which is the same defect as an arm passing for
      // the wrong reason.
      const none = join(work, 'nohook');
      expect(git(work, 'init', '-q', '-b', 'main', none).code).toBe(0);
      mkdirSync(join(none, HOOKS_DIR), { recursive: true });
      const missing = wireHooks(none, 'wire');
      expect(missing.ok).toBe(false);
      expect(missing.lines.join('\n')).toMatch(/is missing — there is nothing to wire/);

      const dir = join(work, 'dirhook');
      expect(git(work, 'init', '-q', '-b', 'main', dir).code).toBe(0);
      mkdirSync(join(dir, HOOKS_DIR, 'pre-push'), { recursive: true });
      const asDir = wireHooks(dir, 'wire');
      expect(asDir.ok).toBe(false);
      expect(asDir.lines.join('\n')).toMatch(/is missing — there is nothing to wire/);
    });

    it('`undo` REFUSES to touch a `core.hooksPath` it did not set', () => {
      const foreign = join(work, 'foreign');
      expect(git(work, 'init', '-q', '-b', 'main', foreign).code).toBe(0);
      expect(git(foreign, 'config', 'core.hooksPath', 'somebody-elses-hooks').code).toBe(0);
      const undone = wireHooks(foreign, 'undo');
      expect(undone.ok).toBe(false);
      expect(undone.lines.join('\n')).toMatch(/which this script did not set — it is left alone/);
      expect(git(foreign, 'config', '--get', 'core.hooksPath').out.trim()).toBe('somebody-elses-hooks');
    });
  });

  it('THE SHIPPED HOOK of THIS repository is tracked `100755` and has substance — the one check that was only ever run on fixtures', () => {
    // THE BLOCKING FINDING OF THE THIRD REVIEW, and it is the very class this
    // cart announced it had closed. `wireHooks` does read the index mode — but
    // every arm that exercised it ran on a FIXTURE whose mode `installHook`
    // sets itself, and `npm run check:hooks` is wired into no CI job (measured:
    // it appears nowhere outside `package.json`). So after this lands, a commit
    // turning `.githooks/pre-push` from `100755` into `100644` would turn both
    // refusals off on every Linux and macOS checkout — invisibly, since a mode
    // change is not a line in a diff — and REDDEN NOTHING.
    //
    // This arm reads THE REPOSITORY, in the unit lane, which `backend-static`
    // runs. It is the first assertion in this cart about the artefact that
    // actually travels rather than about a copy of it.
    const entry = git(ROOT, 'ls-files', '-s', '--', `${HOOKS_DIR}/pre-push`).out.trim();
    expect(entry, `${HOOKS_DIR}/pre-push is not tracked in this repository at all`).not.toBe('');
    expect(
      entry.startsWith('100755'),
      `the shipped hook is tracked as '${entry.slice(0, 6)}', not 100755 — git ignores a hook that is not executable, so both refusals would be OFF on every Linux and macOS checkout`,
    ).toBe(true);
    // AND THE SUBSTANCE FLOOR on the shipped file too, for the same reason: the
    // floor in `setup-git-hooks.ts` also only ever ran on fixtures.
    expect(readFileSync(HOOK, 'utf8').length, 'the shipped hook is too small to be a hook that refuses anything').toBeGreaterThan(512);
    // AND THE NEGATIVE CONTROL, in this same repository, so the reader is not
    // a function that says 100755 about everything: an ordinary tracked file
    // must NOT read as executable.
    const ordinary = git(ROOT, 'ls-files', '-s', '--', 'package.json').out.trim();
    expect(ordinary, 'package.json is not tracked, so the control measures nothing').not.toBe('');
    expect(ordinary.startsWith('100755'), 'an ordinary tracked file reads as 100755, so this reader cannot tell an executable entry from a plain one').toBe(
      false,
    );
  });

  it('THE PATH FROM THE REQUIRED JOB TO THIS FILE is whole — and names the one link no arm in this lane can hold', () => {
    // THE INSTRUMENT OF THIS CART TURNED ON THIS CART'S OWN REMEDY. The arm
    // above guards the shipped hook's mode, and its answer to «which required
    // job runs it» is `backend-static`. That answer hangs on a CHAIN:
    //
    //   ci.yml `backend-static` → `run: npm test` → … && `npm run test:unit`
    //   → `vitest.unit.config.ts` → include `tests-unit/**` → this file
    //
    // Every link is read here. MEASURED, and it is why this arm exists: there
    // is NO OTHER path from `ci.yml` to this lane — `test:unit` and
    // `vitest.unit` appear nowhere else in that workflow but in a comment — so
    // the whole lane, every law in it, hangs on the last link of one `&&`.
    //
    // AND THE LINK THIS ARM CANNOT HOLD, said plainly because it is the point:
    // REMOVING `&& npm run test:unit` from the chain. Then this arm does not
    // run at all, and `backend-static` stays green — an arm inside a lane
    // cannot witness its own lane being unplugged. `tests-unit/test-lane-roster
    // .test.ts:250` already asserts the composition and has the same hole, and
    // `vitest.unit.config.ts` claims in prose that «the wiring cannot quietly
    // come undone», which is true for a REWRITE and false for a REMOVAL.
    //
    // AND THE FOOT OUTSIDE NOW EXISTS:
    // `tests/security/unit-lane-reachability.test.ts` asserts the same links
    // under `npm run test:integration` (`ci.yml:532`) in the `backend` job —
    // required, and not `backend-static` — so it keeps running exactly when
    // this chain is cut, and it carries its own copy of the reader rather than
    // importing this one, because a guard coupled to the lane it guards dies
    // with it.
    //
    // AND THE END OF THE CHAIN, measured rather than gestured at: on 2026-11-24
    // `branches/main/protection` lists TEN required checks by name, including
    // `backend` and `backend-static`, with `strict: true` and
    // `enforce_admins: true`. Above that roster NO TEST guards anything —
    // changing a repository setting reddens nothing, because a setting is not a
    // file any suite reads. What holds there is `enforce_admins` and the
    // owner's discipline, and that is where a test's custody genuinely ends.
    // AND THE READER IS A PURE FUNCTION, deliberately: `package.json` and
    // `ci.yml` are NOT this lane's files, so seeding them to prove this arm
    // red-first would be touching what I do not own. Feeding the same reader
    // doctored TEXT instead gives every link its own negative control without
    // one keystroke in a foreign file — and the positive reading below is the
    // real repository, read by that same function.
    const real = reachabilityProblems(
      readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
      rootScripts(),
      readFileSync(join(ROOT, UNIT_CONFIG), 'utf8'),
    );
    expect(real, 'the path from the required job to this lane is broken').toEqual([]);

    // ONE DOCTORED INPUT PER LINK, each naming only its own problem.
    const goodCi = 'jobs:\n  backend-static:\n    steps:\n      - name: the unit lane\n        run: npm test\n';
    const goodScripts = { test: 'npm run test -w @daftar/web && npm run test:unit', 'test:unit': `vitest run --config ${UNIT_CONFIG}` };
    const goodConfig = "include: ['tests-unit/**/*.test.ts'],";
    expect(reachabilityProblems(goodCi, goodScripts, goodConfig), 'the control inputs are themselves broken, so the arms below measure nothing').toEqual([]);
    // A JOB THAT IS NOT IN THE ROSTER, with a WELL-FORMED step: the first
    // version of this control named `hygiene` — which IS required — and read
    // as a pass only because its step line was malformed, so it was green for
    // a reason other than the one it claims. The only difference from `goodCi`
    // is the job's name.
    expect(reachabilityProblems(goodCi.replace('backend-static:', 'some-optional-job:'), goodScripts, goodConfig)).toEqual([
      'no required job runs `npm test`: the lane is composed by nothing in ci.yml',
    ]);
    expect(reachabilityProblems(goodCi, { ...goodScripts, test: 'npm run test -w @daftar/web' }, goodConfig)).toEqual([
      'the root `test` script does not compose `test:unit`, so this lane runs nowhere in CI',
    ]);
    expect(reachabilityProblems(goodCi, { ...goodScripts, 'test:unit': 'vitest run --config vitest.other.config.ts' }, goodConfig)).toEqual([
      `\`test:unit\` does not name ${UNIT_CONFIG}`,
    ]);
    expect(reachabilityProblems(goodCi, goodScripts, "include: ['tests/**/*.test.ts'],")).toEqual([`${UNIT_CONFIG} does not include tests-unit/`]);
  });

  it('pins the TWO refusals in the file by their mechanism, so a silent edit cannot pass review as a formatting change', () => {
    const text = readFileSync(HOOK, 'utf8');
    // the deletion test is «the local sha is ALL zeros», of any width, not a
    // ref name and not a fixed forty — the null object id is 40 hex zeros under
    // SHA-1 and 64 under SHA-256, and review measured a 64-zero delete being
    // ALLOWED by the previous fixed-width comparison
    expect(text).toMatch(/case "\$\{local_sha:-\}" in/);
    expect(text).toMatch(/'' \| \*\[!0\]\*\)/);
    // the protected branch is `main`, compared after stripping `refs/heads/`
    expect(text).toContain("protected='main'");
    expect(text).toContain('short_remote="${remote_ref#refs/heads/}"');
    expect(text).toMatch(/if \[ "\$short_remote" = "\$protected" \]/);
    // and it fails the push rather than only printing
    expect(text).toMatch(/exit 1/);
    // THE TEXT IS THE WEAKEST PART OF THIS LAW and is here only to make an
    // edit visible; the cases above are what prove the hook behaves.
  });
});
