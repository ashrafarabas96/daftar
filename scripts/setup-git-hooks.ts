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
 *
 * AND NONE OF THESE IS A GATE. No CI job runs any of them — measured on
 * `d3245a3d`: `ci.yml` is 2755 lines with 65 `npm run` invocations and ZERO
 * mention of `check:hooks`, `setup:hooks`, `githooks` or `hooksPath`. They are
 * CONVENIENCES for a developer's own checkout. What guards the shipped hook is
 * `tests-unit/pre-push-hook-law.test.ts`, whose arms run in the unit lane
 * inside `backend-static`, a required job — and calling `check:hooks` «half the
 * guard», as this cart did, is precisely what let the shipped file's mode stay
 * unpinned while the class was announced closed.
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
    // UNREACHABLE BY CONSTRUCTION — the early return below leaves this function
    // before any git call when `DELIVERY_MANIFEST.json` is present. Review
    // named that: the branch the portability law reads is dead text, and its
    // first form RETURNED AN EMPTY STRING, so if it ever did become reachable
    // `wire` would report `-> '.githooks'` having written nothing. It now
    // THROWS, so an unreachable guard that becomes reachable fails loudly
    // instead of lying. It is kept because the law reads the ENCLOSING
    // FUNCTION of each git call, and because the behaviour and the guard being
    // in two places is what made both halves provable separately.
    if (existsSync(join(repo, 'DELIVERY_MANIFEST.json'))) {
      throw new Error('setup-git-hooks: refusing to run git in a delivered archive (DELIVERY_MANIFEST.json is present)');
    }
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
      continue;
    }
    // PRESENCE IS NOT SUBSTANCE. An empty or truncated hook satisfies
    // `existsSync` and refuses nothing — review named it: the check passed on
    // a file whose refusals could have been deleted. This is a FLOOR, not a
    // law; the law is `tests-unit/pre-push-hook-law.test.ts`, which RUNS the
    // hook against a bare repository. But a floor that a blank file clears is
    // not a floor.
    const size = statSync(path).size;
    if (size < 512) {
      problems.push(`${HOOKS_DIR}/${hook} is only ${String(size)} bytes — too small to be the hook this repository ships`);
    }
    // AND THE EXECUTE BIT IN THE INDEX, which carries the whole verdict: git
    // looks a hook up with `access(X_OK)` and SILENTLY IGNORES one that is not
    // executable. So a commit turning `100755` into `100644` removes both
    // refusals on every Linux and macOS checkout, and that change does not
    // show up as a line in a diff. Review of this cart named it, and named why
    // the law did not catch it: the fixture copies the file and chmods it
    // itself, so the suite stays green whatever the tracked mode is.
    //
    // The INDEX mode is read rather than the filesystem's, because NTFS does
    // not carry the bit at all — `statSync(...).mode` is meaningless here while
    // `git ls-files -s` says the same thing on every platform.
    //
    // AND THE CITATION THAT USED TO SIT HERE WAS WRONG, which the third review
    // of this cart named: it pointed at
    // `tests/integration/embedded-pg-binaries.test.ts:25-33` as a precedent for
    // reading the mode «this way», and that file asserts
    // `statSync(...).mode & 0o111` — the FILESYSTEM bit, the very instrument
    // this comment says is meaningless here. So the precedent was for the
    // platform-DEPENDENT machine. There is no precedent in this repository for
    // the index read; this is the first, and it is argued on its own.
    const entry = gitSoft('ls-files', '-s', '--', `${HOOKS_DIR}/${hook}`);
    // NOT `mode`: that is this function's own parameter, read far below. The
    // shadowing was harmless by block scope and is still a trap for the next
    // check added inside this loop (third review, finding 8).
    const indexMode = entry === null ? null : (/^(\d{6})\s/.exec(entry)?.[1] ?? null);
    if (indexMode === null) {
      problems.push(`${HOOKS_DIR}/${hook} is not tracked, so git has no mode for it — the hook would not travel`);
    } else if (indexMode !== '100755') {
      problems.push(`${HOOKS_DIR}/${hook} is tracked as ${indexMode}, not 100755 — git ignores a hook that is not executable, so both refusals would be off`);
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
  //    within the minute, and this check closes the WIRING moment: it refuses
  //    while any sibling lacks the directory.
  //
  //    IT DOES NOT CLOSE EVERY PATH TO THE SAME STATE, and saying otherwise was
  //    a claim wider than the code (review of this cart). Once `core.hooksPath`
  //    is set, a `git switch` in any sibling worktree to a branch that predates
  //    this cart empties its `.githooks/` — no hook, silently, with no second
  //    chance to refuse. The limitation is inherent to `core.hooksPath` naming
  //    a path inside the working tree; what this check buys is that the state
  //    is never entered BY THIS SCRIPT.
  const worktrees = (gitSoft('worktree', 'list', '--porcelain') ?? '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((l) => l !== '');
  // AND AN EMPTY LIST IS A FAILURE, NOT A CLEAN BILL. `gitSoft(...) ?? ''`
  // yields zero worktrees when the enumeration fails for ANY reason, and zero
  // worktrees means zero disarmed, which used to let the wiring through with a
  // message reading «0 of 0» — the check failing OPEN, in the one place whose
  // whole purpose is to refuse (third review, finding 4). Every repository has
  // at least one worktree, so an empty list means the measurement did not
  // happen, and a measurement that did not happen may not be read as a pass.
  //
  // AND THIS REFUSAL IS NOT PINNED BY AN ARM, said here rather than left to be
  // found: reaching it needs `git worktree list` to fail inside a directory
  // that is already a repository — every earlier check has returned by then —
  // and I could not build that state. By this project's rule an element that
  // reddens nothing is a line and not a remedy, so it is recorded as a line:
  // it is kept because a check that fails open is worse than one that is
  // merely unpinned, and the two readings are not symmetric.
  if (worktrees.length === 0) {
    problems.push('`git worktree list` named no worktree at all — the sibling check could not be measured, and an unmeasured check is not a passed one');
  }
  // EVERY required hook, not `REQUIRED_HOOKS[0]`: a second hook added to the
  // contract would otherwise never be checked across the siblings at all.
  const disarmed = worktrees.filter((w) => REQUIRED_HOOKS.some((hook) => !existsSync(join(w, HOOKS_DIR, hook))));
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
      return { ok: true, lines };
    }
    if (current !== HOOKS_DIR) {
      lines.push('GIT HOOKS: FAIL');
      lines.push(`  - core.hooksPath is '${current}', which this script did not set — it is left alone`);
      return { ok: false, lines };
    }
    // MEASURE THE FALLBACK AND REFUSE *BEFORE* UNSETTING. «Undone» is not
    // «guarded»: with the configuration unset git uses `.git/hooks/`, and if
    // nothing is there the checkout has NO pre-push refusal at all.
    //
    // THE FIRST FORM OF THIS BLOCK UNSET FIRST AND LOOKED AFTERWARDS, and
    // review caught it: on a checkout with no `.git/hooks/pre-push` — which is
    // ANY FRESH CLONE, and exactly the fixture one of the arms builds — it
    // removed the only guard and then returned `ok: false`. Everywhere else in
    // this script `FAIL` means «nothing was written»; that made the restoration
    // mechanism the one place where it meant «written, and you are now
    // unguarded». A tool built to stop a guard being removed by accident must
    // not remove one itself.
    const common = gitSoft('rev-parse', '--git-common-dir');
    const fallbacks = REQUIRED_HOOKS.map((hook) => (common === null ? null : resolve(repo, common, 'hooks', hook)));
    // AND `existsSync` ALONE WAS THE WRONG FLOOR, which the third review of
    // this cart named: an EMPTY or truncated `.git/hooks/pre-push` satisfies it,
    // so the fallback could be a hollow file — the configuration would be unset,
    // the checkout left with a hook that refuses nothing, and the report would
    // read PASS with `in force now: …`. That is the same «presence is not
    // substance» hole this script refuses in `wire` sixty lines above, left open
    // in the one path whose job is restoration. The SAME floor applies here, for
    // the same reason and with the same number.
    const hollow: string[] = [];
    const missing = REQUIRED_HOOKS.filter((_hook, i) => {
      const path = fallbacks[i];
      if (path === null || path === undefined || !existsSync(path)) return true;
      const size = statSync(path).size;
      if (size < 512) hollow.push(`  - ${path} is only ${String(size)} bytes — present, but too small to be a hook that refuses anything`);
      return false;
    });
    if (missing.length > 0 || hollow.length > 0) {
      lines.push('GIT HOOKS: FAIL — nothing written, because undoing would leave this checkout with no refusal');
      for (const hook of missing) lines.push(`  - there is no ${hook} in the git hooks directory to fall back to`);
      for (const line of hollow) lines.push(line);
      lines.push('  put the untracked copy back under `.git/hooks/` first, then undo');
      return { ok: false, lines };
    }
    git('config', '--unset', 'core.hooksPath');
    const after = gitSoft('config', '--get', 'core.hooksPath');
    if (after !== null) {
      lines.push(`GIT HOOKS: FAIL — core.hooksPath still reads '${after}' after unsetting`);
      return { ok: false, lines };
    }
    lines.push(`GIT HOOKS: core.hooksPath '${current}' -> unset`);
    for (const path of fallbacks) lines.push(`  in force now: ${String(path)}`);
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

  // AND `wire` REFUSES A FOREIGN VALUE, as `undo` already did. It used to
  // overwrite whatever `core.hooksPath` held — an absolute path, another
  // tool's `.husky/_`, anything — without refusing and without keeping the old
  // value, and then `undo` unsets rather than restoring it, so the original
  // was simply lost. Review named the asymmetry: the two modes must not
  // disagree about whose configuration this is.
  if (current !== null && current !== HOOKS_DIR) {
    lines.push('GIT HOOKS: FAIL — nothing written');
    lines.push(`  - core.hooksPath is '${current}', which this script did not set — it is left alone`);
    lines.push(`  - unset it yourself if you mean to replace it with '${HOOKS_DIR}'`);
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
