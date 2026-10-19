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

# The literal counts. A count stated as a law is tested as a function, and a
# count stated as a number must be the number -- "more than zero tests ran" is
# the kind of bound this phase has been burned by four times. Change these in
# the same commit that changes the law's tests, with the reason in the message.
EXPECTED: dict[str, int] = {
    "test/tool-commands-are-isolated.test.ts": 25,
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

    npx = shutil.which("npx", path=os.environ.get("PATH", "/usr/bin:/bin"))
    if npx is None:
        refuse("no npx on PATH, so this step could not run the suite at all")

    out = Path(tempfile.mkdtemp(prefix="law-ran-")) / "report.json"
    try:
        done = subprocess.run(
            [str(npx), "vitest", "run", "--reporter=json", f"--outputFile={out}"],
            cwd=str(package),
            capture_output=True,
            text=True,
            timeout=1800,
        )
        if not out.is_file():
            refuse(f"the suite wrote no report (rc {done.returncode}); last stderr: {done.stderr.strip()[-400:]!r}")
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
    print(f"{sum(EXPECTED.values())} law cases ran inside {total} total, 0 skipped, 0 failed: " + ", ".join(f"{k}={v}" for k, v in EXPECTED.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
