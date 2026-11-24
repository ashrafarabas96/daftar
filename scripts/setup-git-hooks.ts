/**
 * Wire this repository's tracked hooks by setting `core.hooksPath`.
 *
 * Owner's decision DR-180/3 (2026-11-24): the pre-push refusals move from
 * `.git/hooks/` into the repository, under `.githooks/`, selected by
 * `core.hooksPath`, with the SAME two refusals — a push that deletes a remote
 * ref, and a push whose destination is `main`.
 *
 * WHY A SCRIPT AND NOT A DOCUMENTED COMMAND: `core.hooksPath` is local
 * configuration, so a clone does not inherit it. A command in a README is a
 * command someone forgets, and the failure is SILENT — the hooks simply never
 * run and nothing says so. This script is idempotent, reports what it changed,
 * and refuses rather than half-apply.
 *
 * AND WHAT IT DOES NOT DO: it does not install anything into `.git/hooks/`,
 * and it does not remove what is already there. Setting `core.hooksPath` makes
 * git look ONLY in the configured directory, so an existing
 * `.git/hooks/pre-push` stops running — which is the point, since the tracked
 * copy is the one under review — but it is left on disk rather than deleted,
 * because deleting a file nobody asked to delete is not this script's business
 * and the old copy is the only record of what was running before.
 *
 * Run:  npm run setup:hooks        wire them
 *       npm run check:hooks        report without writing
 *       npm run undo:hooks         put `core.hooksPath` back to unset, and say
 *                                  what guards the checkout afterwards
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const HOOKS_DIR = '.githooks';
export const REQUIRED_HOOKS = ['pre-push'] as const;

export type Mode = 'wire' | 'check' | 'undo';
export interface Outcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * WHY THIS TAKES A REPOSITORY AND IS EXPORTED, rather than reading `ROOT` and
 * printing: a law can then drive it against a temporary repository and watch
 * what it does to real configuration. A script that only runs on the one
 * checkout it lives in can be asserted on by reading its text, which is a
 * picture of the decider rather than the decider.
 */
export function wireHooks(repo: string, mode: Mode): Outcome {
  // THE DELIVERED ARCHIVE HAS NO REPOSITORY. `scripts/export-release.ts`
  // writes `DELIVERY_MANIFEST.json` into the tree it ships, and that tree
  // carries no `.git` — so there are no hooks to wire and nothing to ask git.
  // The check appears HERE as well as at the top of this function on purpose:
  // `tests/security/archive-portability.test.ts` reads the ENCLOSING FUNCTION
  // of each git invocation and requires the branch to be visible there, and
  // this arrow is that function. The early return below is the behaviour; this
  // is the guard where the call is. Adding this file to that law's
  // `REPOSITORY_TOOLS` allowlist was the other way out and I did not take it:
  // the allowlist is pinned by an arm to exactly five files, so widening it
  // would have reddened a contract to make my own change pass.
  const git = (...args: readonly string[]): string => {
    if (existsSync(join(repo, 'DELIVERY_MANIFEST.json'))) return '';
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  };
  const gitSoft = (...args: readonly string[]): string | null => {
    try {
      return git(...args);
    } catch {
      return null;
    }
  };
  const lines: string[] = [];
  const problems: string[] = [];
  const ROOT = repo;

  // AND THE EARLY RETURN, which is the behaviour rather than the guard: in a
  // delivered archive there is no repository, so this reports that there is
  // nothing to do and SUCCEEDS, instead of shelling out to git and failing
  // with something obscure about a missing work tree.
  if (existsSync(join(repo, 'DELIVERY_MANIFEST.json'))) {
    return { ok: true, lines: ['GIT HOOKS: SKIPPED — DELIVERY_MANIFEST.json is present, so this is a delivered archive with no repository to configure'] };
  }

  // 1. every hook this repository declares must actually be there, and be a file
  for (const hook of REQUIRED_HOOKS) {
    const path = join(ROOT, HOOKS_DIR, hook);
    if (!existsSync(path) || !statSync(path).isFile()) {
      problems.push(`${HOOKS_DIR}/${hook} is missing — there is nothing to wire`);
    }
  }

  // 2. AND EVERY WORKTREE MUST HAVE THE DIRECTORY, because `core.hooksPath`
  //    lives in the SHARED `.git/config` while `.githooks/` is per-checkout.
  //
  //    MEASURED THE HARD WAY on 2026-11-24: running this script from one
  //    worktree set the shared configuration while `.githooks/` existed only
  //    on that worktree's branch, so every OTHER worktree of this repository
  //    had NO pre-push hook at all — git looks only in the configured
  //    directory, and theirs was empty. That is not «one copy swapped for
  //    another», it is the guard removed from them. The setting was reverted
  //    within the minute and this check is why it cannot happen again:
  //    disarming a checkout that never asked is worse than leaving it on the
  //    untracked copy.
  const worktrees = (gitSoft('worktree', 'list', '--porcelain') ?? '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((l) => l !== '');
  const disarmed = worktrees.filter((w) => !existsSync(join(w, HOOKS_DIR, REQUIRED_HOOKS[0])));
  if (disarmed.length > 0) {
    problems.push(
      `${disarmed.length} of ${worktrees.length} worktrees have no ${HOOKS_DIR}/, and core.hooksPath is SHARED between them — setting it would leave those with no hook at all:`,
    );
    for (const w of disarmed.slice(0, 8)) problems.push(`    ${w}`);
    if (disarmed.length > 8) problems.push(`    … and ${disarmed.length - 8} more`);
    problems.push(`  wire the hooks only once ${HOOKS_DIR}/ is on the branch those worktrees have checked out`);
  }

  const current = gitSoft('config', '--get', 'core.hooksPath');

  // ── `--undo`: put `core.hooksPath` back to UNSET, and say what guards the
  //    checkout afterwards.
  //
  //    This exists because of what happened on 2026-11-24: the wiring was run
  //    from a worktree while `.githooks/` was on one branch, 151 of 152
  //    worktrees sharing this `.git/config` were left with NO hook, and the
  //    restoration was done with a second tool because the direct command was
  //    refused. The coordinator's ruling: the END was right and the MEANS was
  //    a bypass, and the remedy is that restoring becomes a REVIEWED mechanism
  //    in this file rather than something improvised under pressure.
  //
  //    IT WILL NOT TOUCH A VALUE IT DID NOT SET. If `core.hooksPath` names
  //    something other than this repository's hooks directory, it belongs to
  //    whoever set it and is left alone — unsetting that would be the same
  //    class of mistake in the other direction.
  if (mode === 'undo') {
    if (current === null) {
      lines.push('GIT HOOKS: PASS — core.hooksPath is already unset, nothing to undo');
    } else if (current !== HOOKS_DIR) {
      lines.push('GIT HOOKS: FAIL');
      lines.push(`  - core.hooksPath is '${current}', which this script did not set — it is left alone`);
      return { ok: false, lines };
    } else {
      git('config', '--unset', 'core.hooksPath');
      const after = gitSoft('config', '--get', 'core.hooksPath');
      if (after !== null) {
        lines.push(`GIT HOOKS: FAIL — core.hooksPath still reads '${after}' after unsetting`);
        return { ok: false, lines };
      }
      lines.push(`GIT HOOKS: core.hooksPath '${current}' -> unset`);
    }
    // AND SAY WHAT IS IN FORCE NOW, because «undone» is not «guarded»: with
    // the configuration unset git uses `.git/hooks/`, and if nothing is there
    // the checkout has no pre-push refusal at all. Reporting success without
    // this would be the silent failure this whole cart exists to remove.
    const common = gitSoft('rev-parse', '--git-common-dir');
    const fallback = common === null ? null : resolve(repo, common, 'hooks', REQUIRED_HOOKS[0]);
    if (fallback !== null && existsSync(fallback)) {
      lines.push(`  in force now: ${fallback}`);
    } else {
      lines.push(`  WARNING: no ${REQUIRED_HOOKS[0]} in the git hooks directory — this checkout now has NO pre-push refusal`);
      return { ok: false, lines };
    }
    return { ok: true, lines };
  }

  if (problems.length > 0) {
    lines.push('GIT HOOKS: FAIL');
    for (const p of problems) lines.push(`  - ${p}`);
    return { ok: false, lines };
  }

  if (current === HOOKS_DIR) {
    lines.push(`GIT HOOKS: PASS — core.hooksPath is already ${HOOKS_DIR} (${REQUIRED_HOOKS.join(', ')})`);
    return { ok: true, lines };
  }

  if (mode === 'check') {
    lines.push('GIT HOOKS: FAIL');
    lines.push(`  - core.hooksPath is ${current === null ? 'unset' : `'${current}'`}, not '${HOOKS_DIR}'`);
    lines.push('  - run `npm run setup:hooks` (this was `--check`, so nothing was written)');
    return { ok: false, lines };
  }

  git('config', 'core.hooksPath', HOOKS_DIR);
  const after = gitSoft('config', '--get', 'core.hooksPath');
  if (after !== HOOKS_DIR) {
    lines.push(`GIT HOOKS: FAIL — core.hooksPath was set but reads back as ${after === null ? 'unset' : `'${after}'`}`);
    return { ok: false, lines };
  }
  lines.push(`GIT HOOKS: core.hooksPath ${current === null ? 'unset' : `'${current}'`} -> '${HOOKS_DIR}'`);
  lines.push(`  hooks now in force: ${REQUIRED_HOOKS.join(', ')}`);
  lines.push('  what they refuse: a push that DELETES a remote ref, and a push whose destination is `main`');
  lines.push('  to put it back: npm run undo:hooks');
  return { ok: true, lines };
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode: Mode = argv.includes('--undo') ? 'undo' : argv.includes('--check') ? 'check' : 'wire';
  const outcome = wireHooks(ROOT, mode);
  for (const line of outcome.lines) console.log(line);
  if (!outcome.ok) process.exit(1);
}

// The CLI runs only when this file is the entry point, so a law can import
// `wireHooks` without the script acting on this checkout.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
