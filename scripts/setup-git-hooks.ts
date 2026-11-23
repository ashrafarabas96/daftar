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
 * Run:  npm run setup:hooks        (and `--check` to report without writing)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOOKS_DIR = '.githooks';
const REQUIRED_HOOKS = ['pre-push'] as const;

function git(...args: readonly string[]): string {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

function gitSoft(...args: readonly string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function main(): void {
  const check = process.argv.includes('--check');
  const problems: string[] = [];

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

  if (problems.length > 0) {
    console.log('GIT HOOKS: FAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }

  if (current === HOOKS_DIR) {
    console.log(`GIT HOOKS: PASS — core.hooksPath is already ${HOOKS_DIR} (${REQUIRED_HOOKS.join(', ')})`);
    return;
  }

  if (check) {
    console.log('GIT HOOKS: FAIL');
    console.log(`  - core.hooksPath is ${current === null ? 'unset' : `'${current}'`}, not '${HOOKS_DIR}'`);
    console.log('  - run `npm run setup:hooks` (this was `--check`, so nothing was written)');
    process.exit(1);
  }

  git('config', 'core.hooksPath', HOOKS_DIR);
  const after = gitSoft('config', '--get', 'core.hooksPath');
  if (after !== HOOKS_DIR) {
    console.log(`GIT HOOKS: FAIL — core.hooksPath was set but reads back as ${after === null ? 'unset' : `'${after}'`}`);
    process.exit(1);
  }
  console.log(`GIT HOOKS: core.hooksPath ${current === null ? 'unset' : `'${current}'`} -> '${HOOKS_DIR}'`);
  console.log(`  hooks now in force: ${REQUIRED_HOOKS.join(', ')}`);
  console.log('  what they refuse: a push that DELETES a remote ref, and a push whose destination is `main`');
}

main();
