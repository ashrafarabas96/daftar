/**
 * THE LAW OVER THE TRACKED PRE-PUSH HOOK (owner's decision DR-180/3,
 * 2026-11-24).
 *
 * The two refusals — a push that DELETES a remote ref, and a push whose
 * destination is `main` — moved out of `.git/hooks/`, which no pull request
 * can edit, into `.githooks/`, which any branch touching the file can edit.
 * That trade is only a tightening if the guard is itself guarded, and this
 * file is half of that guard (the other half is `npm run check:hooks`).
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
import { HOOKS_DIR, wireHooks } from '../scripts/setup-git-hooks';

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
  mkdirSync(join(clone, '.githooks'), { recursive: true });
  copyFileSync(HOOK, join(clone, '.githooks', 'pre-push'));
  chmodSync(join(clone, '.githooks', 'pre-push'), 0o755);

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
      mkdirSync(join(repo, HOOKS_DIR), { recursive: true });
      copyFileSync(HOOK, join(repo, HOOKS_DIR, 'pre-push'));
      chmodSync(join(repo, HOOKS_DIR, 'pre-push'), 0o755);
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

    it('`undo` FAILS, rather than reporting success, when nothing would guard the checkout afterwards', () => {
      // This is the case that made the original mistake invisible: a command
      // that prints success while the checkout is left with no refusal at all.
      const other = join(work, 'unguarded');
      expect(git(work, 'init', '-q', '-b', 'main', other).code).toBe(0);
      mkdirSync(join(other, HOOKS_DIR), { recursive: true });
      copyFileSync(HOOK, join(other, HOOKS_DIR, 'pre-push'));
      expect(wireHooks(other, 'wire').ok).toBe(true);
      rmSync(join(other, '.git', 'hooks', 'pre-push'), { force: true });

      const undone = wireHooks(other, 'undo');
      expect(undone.ok, 'undo reported success while leaving the checkout unguarded').toBe(false);
      expect(undone.lines.join('\n')).toMatch(/NO pre-push refusal/);
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
      mkdirSync(join(shared, HOOKS_DIR), { recursive: true });
      copyFileSync(HOOK, join(shared, HOOKS_DIR, 'pre-push'));

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
      mkdirSync(join(real, HOOKS_DIR), { recursive: true });
      copyFileSync(HOOK, join(real, HOOKS_DIR, 'pre-push'));
      const wired = wireHooks(real, 'wire');
      expect(wired.lines.join('\n')).not.toMatch(/SKIPPED/);
      expect(wired.ok).toBe(true);
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

  it('pins the TWO refusals in the file by their mechanism, so a silent edit cannot pass review as a formatting change', () => {
    const text = readFileSync(HOOK, 'utf8');
    // the deletion test is «the local sha is forty zeros», not a ref name
    expect(text).toContain("zero=$(printf '%040d' 0)");
    expect(text).toMatch(/if \[ "\$\{local_sha:-\}" = "\$zero" \]/);
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
