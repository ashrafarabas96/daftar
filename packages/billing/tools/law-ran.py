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
checked and the counts are the law's own cases -- or it did not, in which case
this step refuses. Replacing the law with the same number of cases that are
not the law moves a digest, which is the declared limit below, not a hole.

The counts are written ONCE, in EXPECTED below, and this prose names none of
them (R55-C-02's neighbour, the coordinator's R55-C-03: this paragraph said
"25" two rounds after EXPECTED said 26, and a figure repeated in prose drifts
from the constant it describes the moment either moves).

THE REMAINING LIMIT, STATED ONCE: a hostile EXECUTION ENVIRONMENT is outside
any check that lives in this repository. The `node` binary and the contents of
`node_modules` are not pinned here, and a `python3` that lies cannot be caught
by a Python file it is running. This step bounds which PROGRAM it starts and
reports its path; it does not bound what that program is. (The coordinator's
R55-C-05: the clause that used to stand here said those contents come from
`npm ci` against the committed lockfile. For THIS package that is false -- it
is outside the root `workspaces`, so the root `npm ci` installs none of its
dependencies, which is PATCH-REQ-P5-001's other half.)
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
import hashlib
import json
import os
import secrets
import shutil
import signal
import stat
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
# The challenger's R55-S4 and the coordinator's R55-C-06: a pin bounds the arm
# program's bytes, and only PLACEMENT bounds its reach, so it is chained into
# the command people run and that invocation is part of this byte-equal pin.
PINNED_TEST_SCRIPT = (
    "vitest run && python3 -I tools/law-ran.py "
    "&& python3 -I tools/arms/pinned-now-arm.py tools/seal-check-run.py"
)

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

# ROUND 55, THE CHALLENGER'S R53-F1 (report sha256 6f978eb9b782…; the two
# sessions number rounds one apart, so the digest is what pins it). `npm test` reads the pack TWICE -- the
# suite npm starts, and the run this step starts for its figures -- and the pack
# is a directory other sessions write to. Reproduced by the challenger with one
# document added 16 seconds in: the suite printed `Tests 304 passed (304)` with
# no assertion in its output and this step refused with failing figures from a
# run that printed nothing. Against a frozen pack, 10/10 rc 0. The suite is not
# flaky; its SUBJECT MOVES.
#
# So the subject is PINNED BY DIGEST and handed down: this step measures the
# pack, passes the digest to the run it starts in `P5_PACK_DIGEST`, and measures
# again afterwards. The law refuses by name unless the pack it reads hashes to
# the value handed down, and this step refuses by name if the pack moved while
# the run was happening. Reading the report the FIRST run wrote would also fix
# the two-instants problem and is rejected for the reason round 50 recorded: a
# report on disk is a document, and a stale green report is the oldest hole
# there is.
REFUSED_PACK_MOVED = "REFUSED-PACK-MOVED-DURING-MEASUREMENT"
# The challenger's round-55 question about round 57's own remedy: what happens
# when the private copy cannot be MADE at all? Before this name it was an
# unhandled exception -- fail-closed by exit code, but not a refusal anyone can
# read, and a traceback is exactly the output an operator retries blindly. It is
# NEVER a fall-back to the live pack: a step that quietly measures the moving
# subject when its own copy fails has the hole R54-S2 named, back again.
REFUSED_PACK_COPY_IMPOSSIBLE = "REFUSED-PACK-COPY-NOT-POSSIBLE"
# The coordinator's R57-C-03: a pack filename that is not valid UTF-8 came back
# from `os.listdir` with surrogates in it and ended this step in a traceback at
# `entry.encode()` -- fail-closed by exit code, unreadable as a verdict. Names
# are decoded with `surrogateescape` and a name that is not valid UTF-8 is
# refused BY NAME, because this step cannot hand such a name to the law and
# claim the two readers saw one set.
REFUSED_PACK_NAME_NOT_UTF8 = "REFUSED-PACK-NAME-NOT-UTF8"
# The coordinator's R57-C-04: both copiers SKIPPED anything that is not a
# regular file, so a subdirectory dropped out of the measured set in silence --
# and the signed `29cef86` refused it, because its digest marked non-files
# `<not-a-file>`. Skipping what you cannot classify is the oldest hole in this
# phase, so it is a refusal in both copiers now.
REFUSED_PACK_ENTRY_NOT_A_FILE = "REFUSED-PACK-ENTRY-NOT-A-FILE"
# The challenger's R56-S3 (P4): ONE condition, TWO refusal names. A dangling
# symlink in the pack was REFUSED-FILE-NOT-READABLE to the law (its `statSync`
# raises) and REFUSED-PACK-ENTRY-NOT-A-FILE here (`Path.is_file()` answers
# false and raises nothing), so an operator comparing the two reads two causes
# for one file. Worse, and found by measuring it rather than by reading the
# reports: the two DIGEST functions parted company over the same entry --
# `<unreadable>` there, `<not-a-file>` here -- so one directory at one instant
# had two digests and REFUSED-PACK-MOVED would have fired SAYING the pack
# moved when it had not. Both readers classify by ONE `stat` now, whose
# failure is this name and whose non-regular answer is the name above.
REFUSED_FILE_NOT_READABLE = "REFUSED-FILE-NOT-READABLE"
# ROUND 60c, MEASURED AGAINST THIS STEP ITSELF AND IT WAS A FAIL-OPEN.
# This step read the runner's JSON report and threw the runner's own EXIT
# CODE away. A file planted with an unhandled rejection and one passing
# assertion made `vitest run` exit 1 -- "Unhandled Errors", "Errors 1
# error" -- while every case in the report was `passed` and `success` was
# true, so this step printed "0 skipped, 0 failed" and exited 0. The
# gate's verdict disagreed with the runner's, in the direction that hides
# a hole: an unhandled rejection, an error in a teardown, or a worker that
# dies after the report is written are all invisible to a reader of cases.
# The exit code is a verdict too, and this step may not discard it.
REFUSED_RUNNER_NONZERO = "REFUSED-RUNNER-EXITED-NONZERO"
# THE COORDINATOR'S R58-C-01 (P2), a route neither reviewer had measured
# before it: this step read every case and SKIPPED the ones whose status is
# `passed`, so a case that failed once and passed on a RETRY carried its
# failure message into the report and this step threw it away -- with the
# case COUNT unchanged, so `EXPECTED` could not refuse either. The
# coordinator measured the mechanism on this runner and then built the
# attack on the subject: `retry: 3` in the config greens the direct gate
# over a PLANTED law violation and prints clean figures. A passed case
# carrying a non-empty `failureMessages` was retried, and that is a refusal.
REFUSED_CASE_RETRIED = "REFUSED-CASE-PASSED-AFTER-RETRY"
# THE COORDINATOR'S R58-C-09 (P3): every dispatch in this phase names THIS
# program as the gate, and it was weaker than `npm test` by exactly the
# pinned-now arm -- a broken `pinned_now` with its pin moved gave `npm test`
# rc 1 and this step rc 0 with clean figures. Of the two remedies the
# coordinator offered, this is the one taken: the arm is chained HERE, where
# the gate is, so the terminus a dispatch names is not weaker than the
# command a developer runs. The `test` script keeps its own invocation too,
# because its bytes are what pin the chain for `npm test`.
REFUSED_ARM_NOT_AS_SPECIFIED = "REFUSED-ARM-NOT-AS-SPECIFIED"
# THE COORDINATOR'S INTERIM RULING ON `03907d0`, item 2: the per-file counts
# above pin the two LAW files and nothing pinned the SET of files that run, so
# a new test file moved the printed total from 306 to 307 at rc 0 and this step
# said nothing. A census pins its SET: arrivals AND departures refuse. The
# TOTAL is not pinned as a literal on purpose -- a case added to a
# domain test is ordinary work -- but a FILE arriving or leaving changes what
# "the suite passed" means, and the gate's verdict is now coupled to the whole
# package's exit code, so a new file is a new way for this gate to go red.
REFUSED_TEST_FILE_SET_MOVED = "REFUSED-TEST-FILE-SET-MOVED"
# The per-run nonce (the coordinator's item 2, second half): this step writes a
# fresh value into a mode-600 file of its own and hands the law the value and
# the path, so the law's privacy claim binds to THIS run. What that defeats is
# measured and stated narrowly: a REPLAYED directory, a stale digest, or an
# environment copied out of an earlier run. It does not make provenance
# unforgeable -- a program that forges every piece at once still passes, which
# the challenger measured at round 57 -- and what stops such a run from
# producing a false GREEN is the census and the content scan, not this nonce.
REFUSED_NONCE_NOT_AS_SPECIFIED = "REFUSED-NONCE-NOT-AS-SPECIFIED"

# The SET of test files this suite collects, pinned by value. A file arriving
# or leaving is refused by name; change this list in the same commit that adds
# or removes the file, with the reason in the message.
# ROUND 62, THE CHALLENGER'S S-3 ON `a7d22fe`. The SET was pinned and the
# CONTENTS were not: it cut `test/lexer.test.ts` from 53 lines to one case and
# the printed total moved 306 -> 300 at rc 0, because no name had arrived and
# none had left. A census pins its set AND what each member contributes, so the
# count is per FILE and the total is a LITERAL -- a sum computed from the same
# dict would move with it and prove nothing.
#
# These are the whole package's test files, not the law's. That is deliberate
# and it is the scope this gate already has: it reads the runner's exit code,
# which is the whole package's verdict. Change a count here in the same commit
# that changes that file's cases, with the reason in the message.
EXPECTED_TEST_FILES: dict[str, int] = {
    "test/addon-meters.test.ts": 15,
    "test/addons.test.ts": 11,
    "test/collection.test.ts": 20,
    "test/coverage-truth.test.ts": 9,
    "test/credit-application.test.ts": 18,
    "test/credit.test.ts": 24,
    "test/currency-is-canonical.test.ts": 5,
    "test/db-refusals-name-their-defence.test.ts": 7,
    "test/dunning.test.ts": 26,
    "test/error-codes-are-live.test.ts": 8,
    "test/errors-carry-no-money.test.ts": 6,
    "test/fake-provider.test.ts": 12,
    "test/invoice-states.test.ts": 10,
    "test/invoice.test.ts": 13,
    "test/law-bytes-are-pinned.test.ts": 1,
    "test/lexer.test.ts": 7,
    "test/no-hardcoded-pricing.test.ts": 9,
    "test/no-merchant-posting.test.ts": 10,
    "test/period.test.ts": 19,
    "test/plan-change.test.ts": 11,
    "test/platform-authority-law.test.ts": 9,
    "test/proration.test.ts": 21,
    "test/repo-format-gate.test.ts": 2,
    "test/subscription-states.test.ts": 5,
    "test/tool-commands-are-isolated.test.ts": 28,
}
EXPECTED_TOTAL_CASES = 306
# The coordinator's R57-C-01, second half: the directory this step writes the
# runner's report into is created the same way as the private pack copy, and an
# OSError there was a traceback too.
REFUSED_REPORT_DIR_IMPOSSIBLE = "REFUSED-REPORT-DIRECTORY-NOT-POSSIBLE"


# ROUND 62, THE CHALLENGER'S F-2 (P1), first half, and it MEASURED it: every
# temporary directory this step makes was removed in a `finally`, which a
# signal does not reach. `kill -TERM` left `/tmp/law-ran-nonce-*` (mode 600,
# holding its value), `/tmp/law-ran-pack-*` (all 94 documents) and the report
# directory behind, and that leaked set is what a replay needs. So the paths
# are registered as they are created and a handler removes them on SIGTERM,
# SIGINT and SIGHUP before re-raising with the default disposition, which keeps
# the exit status the signal's own (143 for TERM) rather than inventing one.
#
# What this does NOT reach, said plainly: SIGKILL cannot be handled by any
# program, so a `kill -9` still leaks. That is why the nonce also carries the
# writer's PID -- the leak is made harmless as well as rarer, and neither half
# is offered as the whole answer.
_TEMPORARY: list[Path] = []


def _forget_temporary(path: Path | None) -> None:
    if path is not None and path in _TEMPORARY:
        _TEMPORARY.remove(path)


def _clean_temporary() -> None:
    while _TEMPORARY:
        shutil.rmtree(_TEMPORARY.pop(), ignore_errors=True)


def _on_signal(signum: int, _frame: object) -> None:
    _clean_temporary()
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def _install_signal_cleanup() -> None:
    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        handled = getattr(signal, name, None)
        if handled is not None:
            signal.signal(handled, _on_signal)


def pack_digest(directory: Path) -> str:
    """Every name beside its sha256, sorted, hashed -- the law's definition."""
    rows = []
    # R54-S1 (the challenger's P2, latent): ordered by the name's BYTES, not by
    # its characters. Python sorts str by code point and JavaScript by UTF-16
    # code unit, and the two disagree whenever one name holds a character above
    # the BMP and another one above U+D7FF -- one directory, one instant, two
    # digests, and a refusal that would say the pack moved when it had not.
    for name in sorted(os.listdir(directory), key=lambda entry: entry.encode("utf-8", "surrogateescape")):
        full = directory / name
        # R56-S3, the half that is a digest rather than a refusal: the kind is
        # read from ONE `stat`, whose failure is the unreadable branch, because
        # the law's `statSync(full).isFile()` RAISES on a dangling symlink while
        # `Path.is_file()` answers false -- two labels for one entry, which is
        # two digests for one instant. Measured by the agreement arm, which now
        # builds a subdirectory and a dangling symlink as well as names.
        try:
            digest = (
                hashlib.sha256(full.read_bytes()).hexdigest()
                if stat.S_ISREG(full.stat().st_mode)
                else "<not-a-file>"
            )
        except OSError:
            digest = "<unreadable>"
        rows.append(f"{name}\x00{digest}")
    # R57-C-03: a name that is not valid UTF-8 comes back from `os.listdir`
    # with surrogates, and `.encode()` on those raises -- which is how this
    # function ended a run in a traceback. It hashes BYTES, so it encodes as
    # bytes; the refusal for such a name is a named one at the copy, and this
    # function must survive long enough to reach it.
    return hashlib.sha256("\n".join(rows).encode("utf-8", "surrogateescape")).hexdigest()

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
    # 27 -> 28 at round 60g: the law gains the arm the coordinator asked for on
    # top of R58 -- `notStartedByTheGate` RUN as a function over /proc trees the
    # arm builds, one failure mode at a time (no /proc, an empty cmdline, no
    # cmdline, no PPid, an unreadable parent, a COPY of the gate, a non-python
    # program, a chain that is its own parent), plus the two states that must be
    # ADMITTED so the arm is not vacuous. A "cannot say" that returned the empty
    # string would make REFUSED-PACK-HANDED-DOWN-DIRECTORY-NOT-PRIVATE
    # unreachable.
    # 26 -> 27 at round 56: the law gains the R54-S1 case, which RUNS both
    # digest implementations over a directory built to make them disagree and
    # compares the values. 25 -> 26 at round 54: the law gains the CD-53-01/R53-03 case, which
    # refuses a Git-tracked path under either `node_modules` and twins the
    # environment half of CD-52-01. The number changes in the same commit as
    # the case, with the reason in the message.
    "test/tool-commands-are-isolated.test.ts": 28,
    "test/law-bytes-are-pinned.test.ts": 1,
}


def refuse(why: str) -> "None":
    raise SystemExit(f"{LAW_NOT_RUN}: {why}")


def main() -> int:
    # Before anything is created, so a signal arriving between the first
    # mkdtemp and the handler's installation is not a window of its own.
    _install_signal_cleanup()
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
    #
    # R53-S1 (the challenger's P3, against its OWN remedy from the round
    # before): reading those variables ALONE is a hole in the direction that
    # matters. Through npm the override silences this step before it runs; run
    # DIRECTLY -- the CI terminus -- the variables are absent, so a check that
    # only reads them is SKIPPED while the compromised file still sits on disk,
    # and CI would be green while every developer's `npm test` ran nothing. So
    # the DEFAULT paths npm reads are checked whether or not a variable names
    # them: the user config at `~/.npmrc`, and the global one beside the node
    # that will run the suite (below, once that node is resolved).
    def refuse_if_sets_shell(label: str, named: "Path") -> None:
        if not named.is_file():
            return
        try:
            text = named.read_text(errors="replace")
        except OSError as exc:
            refuse(f"{REFUSED_NPM_CONFIG}: {label} ({named}) cannot be read, so this step cannot say what it configures: {exc}")
        for line in text.splitlines():
            key = line.split("=", 1)[0].strip().lower().replace("_", "-")
            if key in ("script-shell", "shell"):
                refuse(
                    f"{REFUSED_NPM_CONFIG}: {label} is {named}, which sets {key!r}. That replaces the shell npm "
                    "hands every script to, from a file outside the two this step checks, so the pinned command "
                    "would be handed to a program of someone else's choosing"
                )

    for var in [
        key
        for key in os.environ
        if key.lower().replace("-", "_") in ("npm_config_userconfig", "npm_config_globalconfig")
    ]:
        if os.environ.get(var):
            refuse_if_sets_shell(var, Path(os.environ[var]).expanduser())
    refuse_if_sets_shell("npm's default user config", Path.home() / ".npmrc")

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
    #
    # R53-S2 (the challenger's P3): the census used to run with its working
    # directory AT THE PACKAGE, so a `git init` inside `packages/billing` gave
    # it a different repository to answer about and it saw nothing. The runner
    # check below already ran from the root and caught that case, so there was
    # no hole -- but a census answered by the wrong repository is worth closing
    # at the census. It runs from the ROOT now, with each directory named
    # relative to it, and a nested repository inside the package is refused by
    # name rather than worked around.
    root = package.parent.parent
    # `rev-parse` has no NUL form, so its one line is read and stripped here
    # rather than split: `-z` would be taken for a revision.
    toplevel = [entry.strip() for entry in git_lines(package, "rev-parse", "--show-toplevel") if entry.strip()]
    if toplevel and Path(toplevel[0]).resolve() != root.resolve():
        refuse(
            f"{REFUSED_TRACKED_NODE_MODULES}: {package} belongs to the repository at {toplevel[0]}, not to "
            f"{root}. A repository nested inside the package answers a census about a different history, so what "
            "this step could say about committed files would be about the wrong tree"
        )
    for where in (package, root):
        relative = where.relative_to(root) / "node_modules" if where != root else Path("node_modules")
        tracked = git_lines(root, "ls-files", "-z", "--", str(relative))
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

    # R53-S1, the other default: npm's global config lives beside the node that
    # runs it, and is read whether or not a variable names it. The coordinator's
    # R57-C-01: this check used to sit AFTER the private pack copy, so its
    # refusal left 87 copied documents behind in a temporary directory. Nothing
    # here depends on the copy, so it runs BEFORE it, where there is nothing to
    # leak -- the cheapest form of that fix, and the one with no cleanup path to
    # get wrong.
    refuse_if_sets_shell("npm's default global config", Path(node).parent.parent / "etc" / "npmrc")

    # R53-F1: the pack is pinned by digest for the duration of the run this
    # step starts, so the figures below and the set the law checks are one
    # instant. A pack that is absent is left to the law's declared UNMEASURED
    # branch rather than invented here.
    pack_dir = Path((os.environ.get("P5_PACK_DIR") or "").strip() or "/mnt/project-files/phase5")
    # R54-S2 (the challenger's P2 on `29cef86`): a digest taken before the run
    # and one taken after it AGREE over any change that happens and reverts in
    # between. The challenger measured exactly that -- an author-owned document
    # added one second into a twenty-second run and removed two seconds later,
    # every digest check green, because comparing two endpoints keeps no journal
    # of the window between them. So the window is REMOVED rather than policed:
    # this step COPIES the pack into a private directory, hands THAT directory
    # and its digest down, and the run it starts measures a subject no sibling
    # SESSION can name (the challenger's R55-S5: it set out to measure that
    # claim false and measured it TRUE as written -- sessions here share nothing
    # but /mnt/project-files, so another session's glob runs in its own
    # container). The narrower truth the same residual asks for: any process in
    # THIS container can name and write the directory -- a worker this session
    # starts, anything the suite itself runs, a stray script -- and for that
    # family it is DETECTION ON READ doing the work, not unreachability. Both of
    # the challenger's straddles came from exactly such a process and both were
    # refused by name, which is the arm below, not this sentence.
    #
    # A write to the live pack after the copy changes nothing the run claims, which is why there is no longer a refusal for it;
    # refusing on it would be a false red about figures that are true of a real
    # instant of the pack.
    #
    # The SOURCE is digested on both sides of the copy, because copying the pack
    # is not an instant either, and a copy that straddles a write holds part of
    # one state and part of another. What remains is a change that happens and
    # reverts ENTIRELY between those two reads; closing that needs a filesystem
    # snapshot, which is not this package's to arrange, and it is declared.
    pack_snapshot: Path | None = None
    source_before: str | None = None
    subject_pack: Path | None = pack_dir if os.environ.get("P5_PACK_DIR") else None
    pinned_pack = None
    if pack_dir.is_dir():
        # R57-C-03: the names are checked BEFORE anything is digested or copied,
        # because every later step reads them and a refusal is only useful if it
        # arrives before the traceback would.
        for entry in sorted(os.listdir(pack_dir), key=lambda name: name.encode("utf-8", "surrogateescape")):
            try:
                entry.encode("utf-8")
            except UnicodeEncodeError:
                refuse(
                    f"{REFUSED_PACK_NAME_NOT_UTF8}: {pack_dir} holds a filename that is not valid UTF-8 "
                    f"({entry.encode('utf-8', 'surrogateescape')!r}), so this step and the law could not be "
                    "reading one set of names. Rename it, or say in review why a name like that belongs here"
                )
        source_before = pack_digest(pack_dir)
        try:
            pack_snapshot = Path(tempfile.mkdtemp(prefix="law-ran-pack-")).resolve()
            _TEMPORARY.append(pack_snapshot)
            # The challenger's question about the sentence above: can the
            # environment steer where this copy lands? Measured -- TMPDIR, TMP
            # and TEMP all fall back, and the candidate list `tempfile` consults
            # after them is ['/tmp', '/var/tmp', '/usr/tmp', CWD]. The last one
            # is this PACKAGE. A private copy of the pack written inside the
            # tree this step measures is a directory the suite's own arms walk,
            # 86 documents deep, so it is refused by name rather than used: the
            # destination is part of the instrument, not an implementation
            # detail of `mkdtemp`.
            # R57-C-02: the PACK itself joins the list. A private copy made
            # inside the directory it is copying is a copier walking its own
            # output, and the set it measures is then not the pack's.
            inside = [
                tree
                for tree in (root.resolve(), package, pack_dir.resolve())
                if pack_snapshot.is_relative_to(tree)
            ]
            if inside:
                shutil.rmtree(pack_snapshot, ignore_errors=True)
                refuse(
                    f"{REFUSED_PACK_COPY_IMPOSSIBLE}: the private directory this step measures the pack in "
                    f"landed at {pack_snapshot}, inside {inside[0]}, which is a tree this step and the run "
                    f"it starts both measure. Point TMPDIR at a directory outside {inside[0]}"
                )
        except OSError as exc:
            refuse(
                f"{REFUSED_PACK_COPY_IMPOSSIBLE}: this step could not create the private directory it "
                f"measures the pack in ({exc}), so there is nothing it can measure that does not move. "
                "It does NOT fall back to the live pack at "
                f"{pack_dir}: measuring a directory other sessions write to is the hole this copy exists "
                "to close"
            )
        for name in sorted(os.listdir(pack_dir), key=lambda entry: entry.encode("utf-8", "surrogateescape")):
            full = pack_dir / name
            # R57-C-03: a name that does not round-trip through UTF-8 carries
            # surrogates from `surrogateescape`, and the law reads names as
            # JavaScript strings, so the two readers could never agree on such
            # a set. Refused by name instead of crashing on it.
            try:
                name.encode("utf-8")
            except UnicodeEncodeError:
                shutil.rmtree(pack_snapshot, ignore_errors=True)
                refuse(
                    f"{REFUSED_PACK_NAME_NOT_UTF8}: {pack_dir} holds a filename that is not valid UTF-8 "
                    f"({name.encode('utf-8', 'surrogateescape')!r}), so this step and the law could not be "
                    "reading one set of names. Rename it, or say in review why a name like that belongs here"
                )
            # R57-C-04: anything that is not a regular file is REFUSED, not
            # skipped. The signed `29cef86` refused it through its digest, and
            # a copier that skips what it cannot classify re-opens that hole.
            # R56-S3: an entry that cannot be read AT ALL is the law's
            # REFUSED-FILE-NOT-READABLE, by the same name and in the same order,
            # so one condition has one cause in both readers. A dangling symlink
            # reaches this branch; `Path.is_file()` used to swallow it into the
            # name below.
            try:
                entry_mode = full.stat().st_mode
            except OSError as exc:
                shutil.rmtree(pack_snapshot, ignore_errors=True)
                refuse(
                    f"{REFUSED_FILE_NOT_READABLE}: {full} is in the pack and could not be read at all "
                    f"({exc}), so this step would be handing down a set it never saw whole"
                )
            if not stat.S_ISREG(entry_mode):
                shutil.rmtree(pack_snapshot, ignore_errors=True)
                refuse(
                    f"{REFUSED_PACK_ENTRY_NOT_A_FILE}: {full} is in the pack and is not a regular file, so "
                    "it cannot be copied into the private directory this step measures and would drop out "
                    "of the measured set in silence. The pack is a flat set of documents"
                )
            try:
                shutil.copyfile(full, pack_snapshot / name)
            except OSError as exc:
                shutil.rmtree(pack_snapshot, ignore_errors=True)
                refuse(
                    f"{REFUSED_PACK_MOVED}: {full} could not be copied into this step's private pack "
                    f"({exc}), so the run this step starts would measure a set this step never read whole"
                )
        source_after = pack_digest(pack_dir)
        if source_after != source_before:
            # The private copy goes BEFORE the refusal: a refusal that leaves a
            # half-copied pack behind leaves a directory a later run could glob
            # for, and the measurement that found this line found exactly that.
            shutil.rmtree(pack_snapshot, ignore_errors=True)
            refuse(
                f"{REFUSED_PACK_MOVED}: the pack at {pack_dir} was {source_before} when this step began "
                f"copying it and is {source_after} now, so the private copy holds part of one state and "
                "part of another. Re-run against a pack nothing else is writing to"
            )
        subject_pack = pack_snapshot
        pinned_pack = pack_digest(pack_snapshot)


    nonce_dir: Path | None = None
    nonce_value = ""
    try:
        nonce_dir = Path(tempfile.mkdtemp(prefix="law-ran-nonce-")).resolve()
        _TEMPORARY.append(nonce_dir)
        nonce_value = secrets.token_hex(16)
        nonce_file = nonce_dir / "nonce"
        # ROUND 62, THE CHALLENGER'S F-2 (P1), second half. A value on disk
        # cannot tell a live run from a dead one, and its measurement showed a
        # killed run leaving this file behind at mode 600 with its value intact.
        # The PID of the writer goes in beside the value, and the law requires
        # it to be the very ancestor its own /proc walk found -- so a replayed
        # environment pointing at a leaked file is refused by name instead of
        # passing privacy, ancestry, the nonce and the digest check and only
        # being caught, four gates later, by the census.
        nonce_file.write_text(f"{os.getpid()} {nonce_value}")
        nonce_file.chmod(0o600)
    except OSError as exc:
        if nonce_dir is not None:
            shutil.rmtree(nonce_dir, ignore_errors=True)
        shutil.rmtree(pack_snapshot, ignore_errors=True) if pack_snapshot is not None else None
        refuse(
            f"{REFUSED_NONCE_NOT_AS_SPECIFIED}: this step could not write the per-run nonce the law reads "
            f"({exc}), so the run it starts could not bind its privacy claim to THIS run"
        )
    try:
        out = Path(tempfile.mkdtemp(prefix="law-ran-")) / "report.json"
        _TEMPORARY.append(out.parent)
    except OSError as exc:
        # R57-C-01: a traceback here left the private pack copy behind as well.
        shutil.rmtree(pack_snapshot, ignore_errors=True) if pack_snapshot is not None else None
        refuse(
            f"{REFUSED_REPORT_DIR_IMPOSSIBLE}: this step could not create the directory it writes the "
            f"runner's report into ({exc}), so it has nowhere to read the run's figures from and will not "
            "guess them"
        )
    try:
        done = subprocess.run(
            [
                str(node),
                str(runner),
                "run",
                "--reporter=json",
                f"--outputFile={out}",
                # THE COORDINATOR'S INTERIM RULING, item 1. The law reads every
                # runner setting out of the EFFECTIVE run, and MEASURED: the
                # worker's resolved config never carries these two, not even
                # when the command line sets them. So this step does not ask
                # the config for them -- it FORCES them on the run that
                # produces the verdict. Measured: with the config saying
                # `dangerouslyIgnoreUnhandledErrors: true` and a planted
                # unhandled rejection, the plain run is rc 0 and this flag
                # makes it rc 1.
                "--no-dangerously-ignore-unhandled-errors",
                "--no-file-parallelism",
            ],
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
                # R54-S2: the directory handed down is this step's PRIVATE
                # COPY whenever the pack exists, so the run cannot be measuring
                # a subject that moves. When the pack is absent the name the
                # operator gave is forwarded unchanged, so the law reaches its
                # declared UNMEASURED branch about the directory that was asked
                # for rather than about a default this step invented.
                **({"P5_PACK_DIR": str(subject_pack)} if subject_pack is not None else {}),
                # R53-F1: the instant this step measured, handed to the run it
                # starts. The law refuses by name if what it reads is not this.
                **({"P5_PACK_DIGEST": pinned_pack} if pinned_pack else {}),
                # The nonce goes down beside the digest, and only when there is a
                # private copy to speak about. It is NOT written into the pack
                # copy: a file inside it would change the very digest both
                # readers compare, and an exempt name inside the measured set is
                # a hole of its own.
                **(
                    {"P5_PACK_NONCE": nonce_value, "P5_PACK_NONCE_FILE": str(nonce_dir / "nonce")}
                    if pinned_pack and nonce_dir is not None
                    else {}
                ),
            },
        )
        # The challenger's R55-S1: the law no longer refuses when the SHARED
        # pack moves after the copy, because the figures describe the private
        # copy, which is a real instant. But a movement is worth SAYING, and
        # this step is the reader that can say it: its stdout is what an
        # operator reads, and a note is not a refusal.
        if pack_dir.is_dir() and source_before is not None:
            source_at_exit = pack_digest(pack_dir)
            if source_at_exit != source_before:
                print(
                    f"note: the pack at {pack_dir} moved while this step measured a private copy of it "
                    f"({source_before} -> {source_at_exit}). Every figure below describes the copy, which is "
                    "a real instant of the pack; nothing below describes the pack as it now stands"
                )
        if pack_snapshot is not None and pinned_pack is not None:
            after = pack_digest(pack_snapshot)
            if after != pinned_pack:
                refuse(
                    f"{REFUSED_PACK_MOVED}: this step's own private copy at {pack_snapshot} was {pinned_pack} "
                    f"when the run started and is {after} now, so something outside this step is writing into "
                    "a directory only this step and the run it started can name"
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
        _forget_temporary(out.parent)
        if pack_snapshot is not None:
            shutil.rmtree(pack_snapshot, ignore_errors=True)
            _forget_temporary(pack_snapshot)
        if nonce_dir is not None:
            shutil.rmtree(nonce_dir, ignore_errors=True)
            _forget_temporary(nonce_dir)

    if not isinstance(report, dict) or not isinstance(report.get("testResults"), list):
        refuse("the report has no testResults list, so nothing in it says what ran")

    problems: list[str] = []
    # ROUND 60c: FIRST, because it is the one problem that is true of the run as
    # a whole and not of a case, and because the cases below can all be clean
    # while it holds.
    if done.returncode != 0:
        problems.append(
            f"{REFUSED_RUNNER_NONZERO}: the runner this step started exited {done.returncode} even though the "
            "report it wrote carries the cases below. A clean set of cases is not a clean RUN: an unhandled "
            "rejection, an error thrown in a hook after a case ended, or a worker that dies once the report is "
            f"written all look like this. Last stderr: {done.stderr.strip()[-400:]!r}"
        )
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
        # R58-C-01: BEFORE the not-passed branch, because a retried case is
        # `passed` and would never reach it. The evidence is in the report and
        # this step used to discard it.
        for case in cases:
            if case.get("status") != "passed":
                continue
            said = [str(m).strip() for m in (case.get("failureMessages") or []) if str(m).strip()]
            if not said:
                continue
            title = str(case.get("fullName") or case.get("title") or "<unnamed case>")
            problems.append(
                f"{REFUSED_CASE_RETRIED}: {relative} :: {title} is reported `passed` and carries "
                f"{len(said)} failure message(s), so it FAILED at least once and the runner retried it. A law "
                "case that passes only on a second attempt measured nothing the first time, and the case count "
                f"cannot see the difference. First message: {said[0].splitlines()[0][:300]!r}"
            )
        not_passed = sorted({str(c.get("status")) for c in cases if c.get("status") != "passed"})
        if not_passed:
            problems.append(f"{relative} has cases that did not pass: {', '.join(not_passed)}")
            # The coordinator's R55-C-01 (P2): the refusal NAME lives in the
            # law's own assertion message, and this step used to throw the
            # report's `failureMessages` away -- so when a suite-side arm
            # fired, the operator read "has cases that did not pass" and never
            # the name that says WHICH law refused. A refusal nobody can read
            # by name is a refusal that gets retried blindly. The messages are
            # the report's, quoted, truncated, and attributed to the case.
            for case in cases:
                if case.get("status") == "passed":
                    continue
                title = str(case.get("fullName") or case.get("title") or "<unnamed case>")
                said = [str(m).strip() for m in (case.get("failureMessages") or []) if str(m).strip()]
                if not said:
                    problems.append(f"{relative} :: {title} did not pass and the report carries no message for it")
                    continue
                for message in said:
                    first = message.splitlines()[0][:400]
                    problems.append(f"{relative} :: {title} said: {first}")
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

    # R58-C-09: the arm, where the gate is. It is a program, run isolated, by
    # the same node-independent interpreter this step was started with, and its
    # verdict is READ -- a non-zero exit is a refusal by name here, not a line
    # on someone's terminal. Its own output is printed first so an operator sees
    # the four branches before this step's figures.
    arm = package / "tools" / "arms" / "pinned-now-arm.py"
    subject = package / "tools" / "seal-check-run.py"
    if not arm.is_file() or not subject.is_file():
        refuse(
            f"{REFUSED_ARM_NOT_AS_SPECIFIED}: this step cannot run {arm} over {subject} because one of them is "
            "not there, so the branch arm the dispatch counts on measured nothing"
        )
    armed = subprocess.run(
        [sys.executable, "-I", str(arm), str(subject)],
        cwd=str(package),
        capture_output=True,
        text=True,
        timeout=600,
        env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/tmp")},
    )
    print(armed.stdout.rstrip())
    if armed.returncode != 0:
        refuse(
            f"{REFUSED_ARM_NOT_AS_SPECIFIED}: {arm} over {subject} exited {armed.returncode}, so the four "
            "branches of the seal's `pinned_now` are not as specified and this step will not report the law as "
            f"having run. Its stderr: {armed.stderr.strip()[-400:]!r}"
        )

    # The coordinator's item 2: the SET of files that ran, by value.
    collected = sorted(
        {
            str(Path(str(result.get("name", ""))).relative_to(package))
            for result in report["testResults"]
            if str(result.get("name", "")).startswith(str(package))
        }
    )
    missing = [name for name in EXPECTED_TEST_FILES if name not in collected]
    arrived = [name for name in collected if name not in EXPECTED_TEST_FILES]
    ran_cases = {
        str(Path(str(result.get("name", ""))).relative_to(package)): len(result.get("assertionResults") or [])
        for result in report["testResults"]
        if str(result.get("name", "")).startswith(str(package))
    }
    moved = [
        f"{name}: {ran_cases.get(name)} cases, not the {pinned} this step pins"
        for name, pinned in EXPECTED_TEST_FILES.items()
        if name in ran_cases and ran_cases[name] != pinned
    ]
    if moved:
        refuse(
            f"{REFUSED_TEST_FILE_SET_MOVED}: every file this step pins ran, and one of them does not hold the "
            f"cases this step pins: {moved}. The challenger cut one file from 53 lines to one case at round 58 "
            "and the printed total moved 306 -> 300 with nothing refusing, because a set that pins only NAMES "
            "says nothing about what each name contributes"
        )
    total_ran = report.get("numTotalTests")
    if total_ran != EXPECTED_TOTAL_CASES:
        refuse(
            f"{REFUSED_TEST_FILE_SET_MOVED}: the suite ran {total_ran} cases and this step pins "
            f"{EXPECTED_TOTAL_CASES}. The figure is a LITERAL here on purpose: a total summed from the per-file "
            "counts would move with them and could never disagree with them"
        )
    if missing or arrived:
        refuse(
            f"{REFUSED_TEST_FILE_SET_MOVED}: the suite this step started did not run the set of test files this "
            f"step pins. Departed: {missing or 'none'}. Arrived: {arrived or 'none'}. This step's verdict is "
            "coupled to the whole package's exit code, so a file arriving or leaving changes what a green run "
            "means; update EXPECTED_TEST_FILES in the same commit, with the reason in the message"
        )

    total = report.get("numTotalTests")
    print(
        f"{sum(EXPECTED.values())} law cases ran inside {total} total, 0 skipped, 0 failed: "
        + ", ".join(f"{k}={v}" for k, v in EXPECTED.items())
        + f" (runner: {node} {runner})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
