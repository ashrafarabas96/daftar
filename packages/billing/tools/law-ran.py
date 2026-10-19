#!/usr/bin/env -S python3 -I
"""Did the law RUN? A check that lives outside the thing it checks.

ROUND 50, THE COORDINATOR'S CD-49-01 (P1, a one-file fail-open), and it is the
same shape as CD-48-01 one layer further out. Round 49 pinned the law's own
BYTES, so an edit to the law is refused by name. It pinned nothing about
whether the law RUNS. Measured at `5b3bf41`, each a single edit with an
un-isolated command planted in a document, and each leaving a green suite:

  * `exclude: ['test/db/**'].concat('test/tool-commands-are-isolated.test.ts')`
    in `vitest.config.ts` -> `Tests 278 passed (278)`;
  * `testNamePattern: /^(?!every written invocation)/` -> `278 passed | 25
    skipped (303)`;
  * `vitest run --exclude=test/tool-commands-are-isolated.test.ts` as the
    `test` script in `package.json` -> `278 passed` through `npm test`.

In all three the law's bytes are untouched, so the byte pin is green: the law
simply never runs, and a guard that never runs measures nothing
([[daftar-a-mutation-that-does-not-run-has-measured-nothing]]).

WHY THIS CANNOT BE A TEST. Anything inside the suite is subject to the same
collection the attack removes: a test asserting "the law was collected" is a
test that can itself be excluded. So this is a SEPARATE STEP, run as its own
npm script, sharing no code and no configuration with the suite, and it RUNS
VITEST ITSELF rather than reading a report it was handed -- a report on disk
is a document, and a stale green report is the oldest hole there is.

The two files pin each other, which is how the regress stops:

  * the law does not run        -> this step refuses by name (LAW-NOT-RUN);
  * this step is removed from `package.json` or edited -> those bytes are
    pinned in `tools/law-bytes.json`, which the law checks, and the law DOES
    run, so the law refuses by name (LAW-BYTES-MOVED);
  * both edited together, with the pin updated -> the declared limit, bounded
    by review of the diff, where it is a changed digest beside the change it
    licenses.

It FAILS CLOSED everywhere: no vitest, no report, an unparsable report, a
missing law file, a test count that is not the literal one, a single skipped
or todo case, or any failure at all is a refusal naming LAW-NOT-RUN. There is
no path through this file that prints a pass without having seen the law's own
test counts in a run it started.

ROUND 51, THE CHALLENGER'S R49-F2 (P2). This step used to resolve `npx` from
the INHERITED PATH, so whoever controls the environment controls what "the
suite" means: a stand-in `npx` in an untracked `node_modules/.bin`, even above
the repository, printed this file's pass sentence with no test run. The runner
is now resolved ABSOLUTELY under the package -- `node_modules/vitest/vitest.mjs`
in the package, else at the repository root where npm hoists it -- never
through PATH and never through `node_modules/.bin`, which is the symlink
surface the attack used. The child gets a REBUILT environment whose PATH starts
at `/usr/bin`, and the runner's own path is PRINTED beside the counts so the
sentence says which program produced them. An absent runner is a refusal by
name, not a fallback.

WHY THE LITERAL COUNTS ARE NOT A BARE PROJECTION (the challenger's stated next
target). A count is a projection, and this phase has lost that argument three
times. What keeps it honest here is not the number: the keys of EXPECTED are
matched against the report's ABSOLUTE PATHS under the package, and those two
files' BYTES are pinned in `tools/law-bytes.json`, checked by the law itself
and by its separate reader. So either the law ran -- in which case the pin was
checked and the 25 and the 1 are the law's own cases -- or it did not, in which
case this step refuses. Replacing the law with 25 cases that are not the law
moves a digest, which is the declared limit below, not a hole.

THE REMAINING LIMIT, STATED ONCE: a hostile EXECUTION ENVIRONMENT is outside
any check that lives in this repository. The `node` binary and the contents of
`node_modules` are not pinned here -- they come from `npm ci` against the
committed lockfile -- and a `python3` that lies cannot be caught by a Python
file it is running. This step bounds which PROGRAM it starts and reports its
path; it does not bound what that program is.
"""

from __future__ import annotations

# B-9/F-50: this tool must run ISOLATED (`python3 -I tools/law-ran.py`). The
# guard stands above every other import, `sys` being a builtin module, and it
# REFUSES rather than re-execing -- code that has already won the startup race
# can rewrite the exec target. It attests nothing on its own: `sys.flags` is a
# writable attribute of an ordinary module, so an un-isolated run that looks
# clean proves nothing. The real control is `-I` AT THE CALL SITE, which is
# what `package.json` carries and what the law's own arm pins.
import sys

if not sys.flags.isolated:
    raise SystemExit(
        "refusing to run without -I: run `python3 -I tools/law-ran.py`. "
        "Without isolation PYTHONPATH and the user site directory are on sys.path "
        "before this file is read, so what this tool computes is not this tool's."
    )


import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

LAW_NOT_RUN = "LAW-NOT-RUN"

# ROUND 52, THE COORDINATOR'S CD-51-01 (P1). Round 51 chained this step into the
# `test` script and the law checked that chaining with a REGEX, which one edit to
# the same file satisfies while discarding the verdict:
# `vitest run --exclude=<the law>; python3 -I tools/law-ran.py; true` printed 277
# passed, then this step's own LAW-NOT-RUN -- it DID catch it -- and `npm test`
# exited 0 with a plant present. So the command is pinned as a LITERAL in two
# programs that share no code: the law's own arm and this one.
#
# WHAT THIS CANNOT DO, said plainly -- and the previous wording here was FALSE,
# which the challenger's R51-F1 measured and which is corrected rather than
# softened. It claimed the attack "must change bytes two programs declare, so it
# appears in the diff beside a digest line". It does not: with
# `vitest run --exclude=<both law files>; python3 -I tools/law-ran.py; true` in
# `scripts.test`, the whole working tree is ` M packages/billing/package.json`,
# `tools/law-bytes.json` untouched and no digest line anywhere, because the file
# that reads the pin is excluded from collection by the same edit.
#
# What is true: an exit code thrown away by the command that started this step
# cannot be recovered by this step. The residual is ONE EDIT TO ONE FILE,
# `package.json`, which is inside this package rather than out in some caller,
# and it shows in the diff as that file alone. What this step buys is a VOICE:
# no vitest filter can exclude it, it reads `scripts.test` itself, and it refuses
# BY NAME at rc 1 into the output that npm then discards. The closure is a check
# that does not pass through this package's own files at all -- a CI step that
# runs `python3 -I packages/billing/tools/law-ran.py` DIRECTLY and reads its exit
# code, never phrased as an npm script, because npm configuration can silence npm
# and npx alike (see CD-52-01 below) -- which is PATCH-REQ-P5-001 with the
# Repo/CI owner.
PINNED_TEST_SCRIPT = "vitest run && python3 -I tools/law-ran.py"

# ROUND 53, THE COORDINATOR'S CD-52-01 (P1, a committed one-file fail-open).
# Pinning the `test` script pins the COMMAND and says nothing about the SHELL it
# is handed to. One committed `packages/billing/.npmrc` holding
# `script-shell=/bin/true` made `npm test` and `npm run gate:law` both exit 0
# with a plant present and NOTHING run. Nothing read that file, so what is
# required is its ABSENCE: this step refuses by name if an `.npmrc` sits beside
# the package or at the repository root. The file's PRESENCE is the subject, not
# a key inside it -- a whitelist of keys is a list of the ones someone thought
# of, and this is a file that need not exist at all.
#
# This also moves the terminus named in the docstring: a CI step must run
# `python3 -I tools/law-ran.py` DIRECTLY, not through npm, because npm
# configuration can replace the shell that would have run it. PATCH-REQ-P5-001
# says so.
REFUSED_NPM_CONFIG = "REFUSED-NPM-CONFIG-PRESENT"

# ROUND 54, THE CHALLENGER'S ASK on round 53's §4 caveat. The no-report case used
# to refuse with "the suite wrote no report", which is TRUE of a replaced runner,
# of a broken install and of a node the suite cannot run on alike -- the
# challenger hit it with a vitest shim, could not tell which of the three it had,
# and said so in the report rather than claim the refusal was the shim's. A
# refusal that covers three causes tells a reader only that the run died. So the
# case has its own NAME, and the message carries the three things that tell the
# causes apart: the PROGRAM this step resolved and started, its exit code, and
# the tail of its stderr. The name does not claim WHICH cause it was -- nothing
# here can know that -- it says that the program this step started produced no
# report, which is the fact this step measured.
REFUSED_RUNNER_NO_REPORT = "REFUSED-RUNNER-WROTE-NO-REPORT"

# ROUND 54, THE COORDINATOR'S CD-53-01 (P1, a fail-open of the terminus this
# phase nominates for CI). The runner was resolved by PATH ON DISK, which bounds
# WHICH program runs and says nothing about WHO WROTE IT. `node_modules` is
# gitignored, but ignored is not untrackable: one `git add -f` of a nine-line
# stub at `packages/billing/node_modules/vitest/vitest.mjs` wrote a fabricated
# report and made THIS step print `26 law cases ran inside 303 total, 0 skipped,
# 0 failed` at rc 0 with a plant present. Root `npm ci` does not remove it,
# because this package is not a workspace, so the committed file sat outside the
# declared "node_modules is bounded by npm ci" limit. Reproduced independently
# in a fresh clone of `3a29afc` before the fix.
#
# Two refusals follow, both by name. An installed tree is NEVER committed, so
# Git tracking anything under either `node_modules` is refused; and the runner
# this step is about to start is refused if Git tracks it, whatever path it sits
# at. Git being unreadable is refused too -- fail on ABSENCE, never skip what
# cannot be classified.
REFUSED_TRACKED_NODE_MODULES = "REFUSED-TRACKED-NODE-MODULES"
REFUSED_TRACKED_RUNNER = "REFUSED-TRACKED-RUNNER"
REFUSED_GIT_NOT_READABLE = "REFUSED-GIT-NOT-READABLE"

# The pinned git invocation: an ABSOLUTE program, a `/usr/bin` PATH, replace
# objects disabled, and an environment with no `GIT_*` of its own, because
# `GIT_DIR` beats any directory handed in. Absent git is a named refusal.
GIT = "/usr/bin/git"
GIT_ENV = {"PATH": "/usr/bin", "GIT_NO_REPLACE_OBJECTS": "1"}


def git_lines(cwd: Path, *args: str) -> "list[str]":
    """Run git in `cwd` and return its NUL-separated answer, or refuse by name."""
    if not Path(GIT).is_file():
        refuse(f"{REFUSED_GIT_NOT_READABLE}: no git at {GIT}, so this step cannot say whether a file is committed")
    done = subprocess.run(
        [GIT, "--no-replace-objects", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=120,
        env=GIT_ENV,
    )
    if done.returncode != 0:
        refuse(
            f"{REFUSED_GIT_NOT_READABLE}: `git {' '.join(args)}` in {cwd} exited {done.returncode}, so this step "
            f"cannot say whether a file is committed: {done.stderr.strip()[-300:]!r}"
        )
    return [entry for entry in done.stdout.split("\0") if entry]

# The literal counts. A count stated as a law is tested as a function, and a
# count stated as a number must be the number -- "more than zero tests ran" is
# the kind of bound this phase has been burned by four times. Change these in
# the same commit that changes the law's tests, with the reason in the message.
EXPECTED: dict[str, int] = {
    # 25 -> 26 at round 54: the law gains the CD-53-01/R53-03 case, which
    # refuses a Git-tracked path under either `node_modules` and twins the
    # environment half of CD-52-01. The number changes in the same commit as
    # the case, with the reason in the message.
    "test/tool-commands-are-isolated.test.ts": 26,
    "test/law-bytes-are-pinned.test.ts": 1,
}


def refuse(why: str) -> "None":
    raise SystemExit(f"{LAW_NOT_RUN}: {why}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--package",
        default=str(Path(__file__).resolve().parent.parent),
        help="the package whose suite must have run the law (default: the one this tool lives in)",
    )
    args = ap.parse_args()
    package = Path(args.package).resolve()

    # CD-52-01, and the challenger's named next target with it: npm config does
    # not live only in a FILE. `npm_config_script_shell` in the environment does
    # the same job as `script-shell` in an `.npmrc`, so it is refused here BY
    # NAME. This one IS a named key rather than a class, and the class -- every
    # other interpreter between an operator's command and this step -- stays the
    # declared execution-environment limit in this module's docstring, not
    # something this file can close. The variable is checked and not the whole
    # `npm_config_*` family, because npm sets several of them on every script
    # run and refusing those would refuse every legitimate invocation.
    # R53-02 (the coordinator's P3): npm honours `NPM_CONFIG_SCRIPT_SHELL` as
    # well as the lower-case spelling, so the keys are matched WITHOUT CASE and
    # with `-` normalised to `_`. The two names are still the subject; the
    # spelling is not.
    #
    # R52-S1 (the challenger's P2), SAID HERE RATHER THAN THREE PARAGRAPHS AWAY:
    # this check cannot fire where the variable does its damage. Set through
    # `npm test`, the variable stops this step from running at all, so the only
    # invocation it can refuse is a DIRECT one -- where no npm sits between the
    # command and this step and the variable is already harmless. It is kept
    # because a direct run is the terminus this phase nominates for CI and a
    # named refusal there is worth more than silence; what actually bounds the
    # npm path is PATCH-REQ-P5-001.
    for var in [
        key
        for key in os.environ
        if key.lower().replace("-", "_") in ("npm_config_script_shell", "npm_config_shell")
    ]:
        if os.environ.get(var):
            refuse(
                f"{REFUSED_NPM_CONFIG}: {var}={os.environ[var]!r} is set in this step's environment. "
                "That replaces the shell npm hands every script to, exactly as `script-shell` in an .npmrc does, "
                "so the pinned command would be handed to a program of someone else's choosing"
            )

    # R52-S2 (the challenger's P3): two more config sources carry the same
    # override -- `npm_config_userconfig` and `npm_config_globalconfig`, in
    # either case. Their PRESENCE cannot be the subject, because npm sets both
    # itself on every script run (measured by the challenger: `/root/.npmrc` and
    # the node prefix's `etc/npmrc`), so refusing presence would refuse every
    # legitimate invocation. The VALUE is the subject instead: the file those
    # variables name may not carry a `script-shell` line. That is the same shape
    # as the file check below and refuses none of npm's own defaults.
    for var in [
        key
        for key in os.environ
        if key.lower().replace("-", "_") in ("npm_config_userconfig", "npm_config_globalconfig")
    ]:
        named = Path(os.environ[var]).expanduser() if os.environ.get(var) else None
        if named is None or not named.is_file():
            continue
        try:
            text = named.read_text(errors="replace")
        except OSError as exc:
            refuse(f"{REFUSED_NPM_CONFIG}: {var}={named} cannot be read, so this step cannot say what it configures: {exc}")
        for line in text.splitlines():
            key = line.split("=", 1)[0].strip().lower().replace("_", "-")
            if key in ("script-shell", "shell"):
                refuse(
                    f"{REFUSED_NPM_CONFIG}: {var} names {named}, which sets {key!r}. That replaces the shell npm "
                    "hands every script to, from a file outside the two this step checks, so the pinned command "
                    "would be handed to a program of someone else's choosing"
                )

    # CD-52-01: no npm configuration may stand between the pinned command and
    # the shell that runs it. Checked here as well as in the law, so neither is
    # the only reader.
    for where in (package, package.parent.parent):
        if (where / ".npmrc").is_file():
            refuse(
                f"{REFUSED_NPM_CONFIG}: {where / '.npmrc'} exists. npm configuration can replace the shell every "
                "script is handed to -- `script-shell=/bin/true` makes `npm test` and `npm run gate:law` exit 0 with "
                "nothing run at all -- so this step requires that no such file exists. A CI step must run this gate "
                "directly, not through npm"
            )

    # CD-51-01: the `test` script must be the pinned literal, read from the
    # package manifest by this program as well as by the law, so neither is the
    # only reader. A missing manifest, a missing script or a changed byte is a
    # refusal by name.
    manifest = package / "package.json"
    if not manifest.is_file():
        refuse(f"no package.json at {manifest}, so nothing says what `npm test` runs")
    try:
        scripts = json.loads(manifest.read_text()).get("scripts")
    except json.JSONDecodeError as exc:
        refuse(f"{manifest} is not JSON: {exc}")
    if not isinstance(scripts, dict):
        refuse(f"{manifest} has no scripts object, so nothing says what `npm test` runs")
    if scripts.get("test") != PINNED_TEST_SCRIPT:
        refuse(
            f"the `test` script is {scripts.get('test')!r}, not the pinned {PINNED_TEST_SCRIPT!r}. "
            "A command with anything after this gate, or a filter before the suite, discards what either one measures"
        )

    # R49-F2: the runner is resolved as a PATH ON DISK under the package, not
    # by a PATH lookup and not through `node_modules/.bin`. Both candidates are
    # named in the refusal so a reader knows where it looked.
    candidates = [
        package / "node_modules" / "vitest" / "vitest.mjs",
        package.parent.parent / "node_modules" / "vitest" / "vitest.mjs",
    ]
    runner = next((c for c in candidates if c.is_file()), None)
    if runner is None:
        refuse("no vitest entry at " + " or ".join(str(c) for c in candidates) + ", so this step could not run the suite at all")

    # CD-53-01, first half: Git tracks nothing under either `node_modules`.
    for where in (package, package.parent.parent):
        tracked = git_lines(where, "ls-files", "-z", "--", "node_modules")
        if tracked:
            refuse(
                f"{REFUSED_TRACKED_NODE_MODULES}: Git tracks {len(tracked)} path(s) under "
                f"{where / 'node_modules'}, the first being {tracked[0]!r}. An installed tree is never committed, "
                "and a committed file there can BE the runner this step starts, fabricating these very figures at "
                "rc 0 with no npm ci able to remove it"
            )

    # CD-53-01, second half, and it does not depend on the path: the program
    # this step is about to start must not be a file Git tracks, wherever it
    # sits. The census above is the SET; this is the one file that decides what
    # the figures mean.
    # The path is RESOLVED first, because `node_modules` can be a symlink into
    # a directory that IS tracked under another name -- there the census above
    # sees nothing and only the real path tells the truth.
    real_runner = runner.resolve()
    if git_lines(package.parent.parent, "ls-files", "-z", "--", str(real_runner)):
        refuse(
            f"{REFUSED_TRACKED_RUNNER}: the runner this step resolved, {runner} (really {real_runner}), "
            "is tracked by Git. "
            "A committed runner is a program a reader of the diff chose, not the one `npm ci` installed, and it can "
            "write whatever report it likes"
        )

    # `node` itself cannot be PINNED by a file in this repository (see the
    # remaining limit in this module's docstring), but the directories it is
    # LOOKED FOR IN can be narrowed, and R50-S1 (P3, the challenger's) is why.
    # `npm run` puts four `node_modules/.bin` directories at the front of PATH,
    # one of them above the repository root, all untracked by design. With the
    # inherited tail on the resolution path, a `node` planted in one of them was
    # resolved and ran: it wrote a fabricated report and this step printed
    # `26 law cases ran inside 303 total, 0 skipped, 0 failed` at rc 0 with no
    # test having run and `git status --porcelain` empty. Measured here before
    # the fix. The challenger's remedy -- drop the inherited tail outright --
    # would break resolution rather than close it in this container, where
    # neither /usr/bin/node nor /bin/node exists and node comes from an nvm
    # prefix; so the tail is KEPT and FILTERED: every directory inside a
    # `node_modules` tree is dropped from the search, and a node that still
    # resolves inside one is a refusal BY NAME rather than a runner. The child's
    # PATH is a separate value, built from the resolved node's own directory, so
    # this does not reintroduce the exit-127 false red.
    inherited = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d and "node_modules" not in Path(d).parts]
    pinned_path = os.pathsep.join(["/usr/bin", "/bin", *inherited])
    node = shutil.which("node", path=pinned_path)
    if node is None:
        refuse(f"no node on {pinned_path!r}, so this step could not run the suite at all")
    if "node_modules" in Path(node).resolve().parts:
        refuse(
            f"the node this step resolved is {node!r}, inside a node_modules tree. "
            "Those directories are untracked by design and `npm run` puts four of them at the front of PATH, "
            "so a binary planted in one could fabricate the report this step reads"
        )

    out = Path(tempfile.mkdtemp(prefix="law-ran-")) / "report.json"
    try:
        done = subprocess.run(
            [str(node), str(runner), "run", "--reporter=json", f"--outputFile={out}"],
            cwd=str(package),
            capture_output=True,
            text=True,
            timeout=1800,
            # The child's environment is REBUILT, not inherited: nothing of
            # PYTHONPATH, NODE_OPTIONS, NODE_PATH, VITEST_* or GIT_* reaches
            # it. Its PATH is DERIVED from the node this step resolved -- the
            # suite itself spawns the repository's own tooling (`prettier`,
            # `python3`), and a PATH without that directory makes those spawns
            # exit 127, which is a FALSE red rather than a defence.
            env={
                "PATH": f"{Path(node).parent}:/usr/bin:/bin",
                "HOME": os.environ.get("HOME", "/tmp"),
                "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
                # R49-F2's last clause: a rebuilt environment drops the one
                # variable the suite's own subject set READS, so without this
                # the run this step starts would measure the DEFAULT pack while
                # the operator had named another. Forwarded EXPLICITLY, and only
                # when it is set, so the subject is the one that was asked for.
                **({"P5_PACK_DIR": os.environ["P5_PACK_DIR"]} if os.environ.get("P5_PACK_DIR") else {}),
            },
        )
        if not out.is_file():
            refuse(
                f"{REFUSED_RUNNER_NO_REPORT}: the program this step started wrote no report. "
                f"Program: {node} {runner}; exit code {done.returncode}; "
                f"last stderr: {done.stderr.strip()[-400:]!r}. "
                "A runner replaced by a stand-in, an install that cannot run, and a node this suite "
                "does not support all reach this line; the exit code and the stderr above are what "
                "tell them apart, and this step does not guess which it was"
            )
        try:
            report = json.loads(out.read_text())
        except json.JSONDecodeError as exc:
            refuse(f"the suite's report is not JSON: {exc}")
    finally:
        if out.is_file():
            out.unlink()
        out.parent.rmdir()

    if not isinstance(report, dict) or not isinstance(report.get("testResults"), list):
        refuse("the report has no testResults list, so nothing in it says what ran")

    problems: list[str] = []
    for relative, expected in EXPECTED.items():
        matches = [r for r in report["testResults"] if str(r.get("name", "")) == str(package / relative)]
        if len(matches) != 1:
            problems.append(f"{relative} was not collected ({len(matches)} results name it), so the law did not run")
            continue
        result = matches[0]
        cases = result.get("assertionResults")
        if not isinstance(cases, list):
            problems.append(f"{relative} reports no cases at all")
            continue
        if len(cases) != expected:
            problems.append(f"{relative} ran {len(cases)} cases, not the {expected} this step pins")
        not_passed = sorted({str(c.get("status")) for c in cases if c.get("status") != "passed"})
        if not_passed:
            problems.append(f"{relative} has cases that did not pass: {', '.join(not_passed)}")
        if result.get("status") != "passed":
            problems.append(f"{relative} as a file is {result.get('status')!r}, not 'passed'")

    # And the run as a whole: a skip anywhere is a case that measured nothing,
    # and a failure anywhere means the head is red whatever the law did.
    for key in ("numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"):
        if report.get(key):
            problems.append(f"{key} is {report.get(key)}, so the run is not a clean pass")
    if report.get("success") is not True:
        problems.append(f"the suite reports success={report.get('success')!r}")

    if problems:
        refuse("; ".join(problems))

    total = report.get("numTotalTests")
    print(
        f"{sum(EXPECTED.values())} law cases ran inside {total} total, 0 skipped, 0 failed: "
        + ", ".join(f"{k}={v}" for k, v in EXPECTED.items())
        + f" (runner: {node} {runner})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
