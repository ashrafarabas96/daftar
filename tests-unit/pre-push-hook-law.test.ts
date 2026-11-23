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
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
