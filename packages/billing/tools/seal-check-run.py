#!/usr/bin/env python3
"""RUN the pack's three checks and seal what they actually printed.

ROUND 24 wrote this tool to close the challenger's B-5: the manifest's
check-run record had carried round 22's strings by hand into the one section
whose whole job is to be recomputed by a reader. It read the strings out of
captured stdout files instead of taking them typed, and its own note claimed
"none of it is typed".

ROUND 25, THE CHALLENGER'S B-7 — and the claim was false, in three places at
once. Measured on a copy of the published pack:

  (a) `rc 0` was a STRING CONSTANT. The tool never saw an exit code, so a
      capture reading "checked 2 documents, 1 problems" was sealed under a bold
      **rc 0**. A red run would have been published as green: a fail-open in a
      record nothing hashes.
  (b) A STALE capture was accepted. The tool counted the tally itself and never
      compared it with the digest line it was quoting, so "38 files, 38 rows"
      was sealed directly above its own freshly counted "40 rows = 24 + 15 + 1".
      That is B-5 reproduced THROUGH the tool written to end it. Empty captures
      were refused; stale ones, the failure that actually happened, were not.
  (c) The ORDERING was typed. `--run-utc`, `--mtime-utc` and `--mtime-file`
      were caller strings and "i.e. AFTER the newest document mtime above" was
      a literal, not a comparison. A seal naming a file that does not exist,
      with a 2030 mtime and a 1999 run time, exited 0.

The remedy is the challenger's and the coordinator's, and it is LESS code, not
more: the sealer RUNS the three tools itself. The exit code is then the
process's, stdout cannot be stale because it was produced in this process, the
run time is `datetime.now(timezone.utc)` and the newest mtime is a `max()` over
the pack. Four arguments and three failure modes disappear together. What
remains refuses, and is red-proved: a nonzero tool, a digest line whose
`N files, N rows` disagrees with the tally counted here, a run that is not
after the newest document mtime, an empty capture, and a missing sentinel pair.

    python3 tools/seal-check-run.py --dir <pack> --tests <test/db dir>
    python3 tools/seal-check-run.py --dir <pack> --tests <dir> --verify-after-write

`--verify-after-write` is the second pass. Writing the block changes this
file's bytes, so the first pass's strings describe bytes that no longer exist.
The second pass re-runs the three tools against the written file, REFUSES if
any line differs from what was sealed, and records that time. The regress it
cannot close — recording the re-run is itself a write — is named in the block
rather than hidden; a reader settles the whole thing by running the three tools
on these bytes.
"""
from __future__ import annotations

# B-9, round 27. This tool must run ISOLATED: `python3 -I tools/seal-check-run.py`.
# Without `-I`, the interpreter puts `PYTHONPATH` and the user site directory on
# `sys.path` BEFORE any line here runs, so a shadowed stdlib module — or a
# `sitecustomize.py`, which `site` imports at startup — decides what this tool
# computes, in a tool whose whole purpose is to be the thing a reader does not
# have to trust.
#
# It REFUSES rather than re-execing itself with `-I`. Round 27's first attempt
# re-exec'd, which re-reads this file from disk: code that has already lost the
# startup race can rewrite the exec target, and the isolated process then runs
# the attacker's file while LOOKING clean. A refusal cannot be redirected.
# `sys` is a builtin module, so this guard cannot itself be shadowed; it stands
# above every other import so nothing else is loaded before the check.
import sys

if not sys.flags.isolated:
    raise SystemExit(
        "refusing to run without -I: run `python3 -I tools/seal-check-run.py`. "
        "Without isolation PYTHONPATH and the user site directory are on sys.path "
        "before this file is read, so what this tool computes is not this tool's."
    )




import argparse
import datetime
import io
import re
import subprocess
from pathlib import Path


ROW = re.compile(r"^\| `([^`]+)` \| (.+) \|$")
# The digest tool's own summary line, the number this tool must agree with.
SUMMARY = re.compile(r"^(\d+) files, (\d+) rows, (\d+) problems$")
BEGIN, END = "<!-- P5-SEAL:BEGIN -->", "<!-- P5-SEAL:END -->"
# The first pass's own run time, read back from the file by the second pass.
SEALED_RUN = re.compile(r"\| \*\*the check run\*\* \| \*\*([0-9TZ:.\-]+)\*\*")


def now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    )


def iso(ts: float) -> str:
    return (
        datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3]
        + "Z"
    )


def newest_other(base: Path, manifest: str) -> tuple[float, str]:
    """The newest mtime over every file in the pack but this one.

    Read from the filesystem, which is what the row says. A pack with no other
    document is a failure, not a quiet zero.

    ROUND 27, THE CHALLENGER'S F-48: this globbed `*.md` and `*.json`, so a
    file of any other type was outside the freshness ordering the whole record
    is read as covering — measured, a tampered `P5-EXPORT.txt` left the seal
    naming a document fifteen minutes older as the newest. The ordering now
    covers what the table covers: every file.
    """
    found = [
        (p.stat().st_mtime, p.name)
        for p in sorted(base.iterdir())
        if p.is_file() and p.name != manifest
    ]
    if not found:
        raise SystemExit(f"no documents besides {manifest} in {base} — nothing to order against")
    return max(found)


def run_checks(tools: Path, pack: Path, tests: Path) -> dict[str, str]:
    """Run the three checks HERE and return the last line each printed.

    The exit code is the process's own. A nonzero one refuses: the whole of
    B-7(a) is that a record must not be able to publish a red run as green.
    """
    calls = {
        "context-sites.py": [
            sys.executable,
            "-I",
            str(tools / "context-sites.py"),
            "--dir",
            str(pack),
            "--tests",
            str(tests),
            "--check",
        ],
        "status-block.py": [
            sys.executable,
            "-I",
            str(tools / "status-block.py"),
            "--dir",
            str(pack),
            "--check",
        ],
        "manifest-digests.py": [
            sys.executable,
            "-I",
            str(tools / "manifest-digests.py"),
            "--dir",
            str(pack),
            "--check",
        ],
    }
    out: dict[str, str] = {}
    for name, cmd in calls.items():
        proc = subprocess.run(cmd, capture_output=True, text=True)
        lines = [l.strip() for l in proc.stdout.split("\n") if l.strip()]
        if proc.returncode != 0:
            tail = lines[-1] if lines else "(no output)"
            raise SystemExit(
                f"{name} exited {proc.returncode} — a record may not seal a run that failed; "
                f"last line: {tail}"
            )
        if not lines:
            raise SystemExit(
                f"{name} printed nothing — a record may not quote a run that produced nothing"
            )
        out[name] = lines[-1]
    return out


def tally(manifest: Path) -> tuple[int, int, int]:
    digests = markers = selfrow = 0
    for line in io.open(manifest, encoding="utf-8"):
        m = ROW.match(line.rstrip("\n"))
        if not m:
            continue
        v = m.group(2)
        if v == "this file":
            selfrow += 1
        elif v.startswith("`") and len(v) == 66:
            digests += 1
        elif "reviewer-owned" in v:
            markers += 1
    return digests, markers, selfrow


def agree(summary_line: str, digests: int, markers: int, selfrow: int) -> None:
    """B-7(b): the quoted line and the counted tally must be the same pack.

    Both numbers sit in memory at the same moment. Not comparing them is how a
    stale capture sealed 38/38 above a counted 40.
    """
    m = SUMMARY.match(summary_line)
    if not m:
        raise SystemExit(
            f"the digest tool's summary is not in the form 'N files, N rows, N problems': "
            f"{summary_line!r}"
        )
    files, rows, problems = (int(g) for g in m.groups())
    total = digests + markers + selfrow
    if problems:
        raise SystemExit(f"the digest check reports {problems} problems — nothing to seal")
    if rows != total or files != total:
        raise SystemExit(
            f"the quoted run and this file disagree: the summary says {files} files / {rows} rows "
            f"while the table here holds {total} ({digests} digests + {markers} markers + "
            f"{selfrow} this file). One of them is stale; refusing to seal either."
        )


def block(
    out: dict[str, str],
    run_utc: str,
    mtime_utc: str,
    mtime_file: str,
    digests: int,
    markers: int,
    selfrow: int,
    rerun_utc: str | None,
) -> str:
    total = digests + markers + selfrow
    rows = [
        "| | |",
        "|---|---|",
        f"| **newest document mtime** (every `.md` and `.json` in the pack except this file) "
        f"| **{mtime_utc}** — `{mtime_file}`, read from the filesystem by this tool. "
        f"`/mnt/project-files` is synced, so an mtime there may not be the write time; this is "
        f"the time the filesystem reported. |",
        f"| **`context-sites.py --check`** | **rc 0** — `{out['context-sites.py']}` |",
        f"| **`status-block.py --check`** | **rc 0** — `{out['status-block.py']}` |",
        f"| **`manifest-digests.py --check`** | **rc 0** — `{out['manifest-digests.py']}` |",
        f"| **the check run** | **{run_utc}**, which this tool VERIFIED to be after the newest "
        f"document mtime above, by comparison and not by assertion |",
        f"| **the table's own tally** | **{total} rows** = {digests} digests + {markers} "
        f"reviewer-owned markers + {selfrow} `this file`, counted from the table in this file and "
        f"CHECKED equal to the `{total} files, {total} rows` the digest tool printed |",
    ]
    if rerun_utc:
        rows.append(
            f"| **re-run after this file's last write** | **{rerun_utc}**, all three rc 0 and "
            f"every line above re-verified identical |"
        )
    note = (
        "Every string in the table above was produced by THIS TOOL RUNNING the three checks "
        "itself, in this process, with `-I` so that no inherited `PYTHONPATH` decides what the "
        "tools import: each `rc 0` is the exit code `subprocess.run` reported and a nonzero one "
        "refuses, each quoted line is that run's own last line of stdout, the run time is "
        "`datetime.now(timezone.utc)`, the mtime is a `max()` over the pack taken AFTER the "
        "checks ran, the tally is counted from the digest table in this same file and compared "
        "with the figure the digest tool printed, and the ordering is re-tested against the time "
        "this row actually carries. Round 24 read those strings out of capture FILES and typed "
        "the times (the challenger's B-7: a red run sealed as green, a stale capture sealed above "
        "a freshly counted tally, an ordering claim that was a literal). Round 25 fixed the code "
        "and left this paragraph asserting more than the run established (its B-8): an ordering "
        "\"verified\" on a time that was never compared, and a sentence about a second pass that "
        "printed whether or not one had run.\n\n"
        "**Where the regress stops.** Writing anything here is itself a write to this file, whose "
        "own row is `this file` because nothing can carry its own digest. "
        + (
            "A second pass then re-ran all three checks against these written bytes, compared "
            "each quoted line against the text BETWEEN the sentinels, and found no difference; "
            "its time is the last row above. Recording that row was one more write, which no run "
            "in this file can cover.\n\n"
            if rerun_utc
            else "No second pass has run against these bytes: there is no re-run row above, and "
            "this paragraph does not claim one.\n\n"
        )
        + "Any reader settles the whole thing in one command: the three tools, run on these "
        "bytes, must print exactly the strings above."
    )
    return "\n".join([BEGIN, ""] + rows + ["", note, "", END])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="the directory holding the pack")
    ap.add_argument("--tests", required=True, help="the test/db directory of @daftar/billing")
    ap.add_argument(
        "--verify-after-write",
        action="store_true",
        help="second pass: re-run against the written bytes, refuse on any difference, record it",
    )
    a = ap.parse_args()

    pack, tests = Path(a.dir), Path(a.tests)
    tools = Path(__file__).resolve().parent
    name = "P5-HANDOFF-MANIFEST.md"
    manifest = pack / name
    if not manifest.is_file():
        raise SystemExit(f"no {name} in {pack}")
    if not tests.is_dir():
        raise SystemExit(f"no test directory at {tests}")

    # B-8(a): the pack is measured AFTER the checks ran, not before. Reading it
    # first described the directory as it was BEFORE the run, so a document
    # written while the checks were running was outside the ordering the row
    # claims.
    out = run_checks(tools, pack, tests)
    run_utc = now()
    mtime, mfile = newest_other(pack, name)
    digests, markers, selfrow = tally(manifest)
    agree(out["manifest-digests.py"], digests, markers, selfrow)

    rerun_utc = None
    if a.verify_after_write:
        # The second pass does not replace the first run; it CONFIRMS it. The
        # sealed check-run time is read back out of the file (nothing typed),
        # every quoted line must still be exactly what the tools print on the
        # written bytes, and this pass's own clock reading becomes the re-run.
        text = io.open(manifest, encoding="utf-8").read()
        # B-8(c): `line not in text` searched the WHOLE manifest, so a corrupted
        # row passed whenever the true line also appeared in the prose — and
        # this document's history sections do carry such lines. The identity
        # test must read the block it is confirming and nothing else.
        if BEGIN not in text or END not in text:
            raise SystemExit("no P5-SEAL sentinel pair to confirm")
        sealed_block = text[text.index(BEGIN) : text.index(END) + len(END)]
        for tool, line in out.items():
            if line not in sealed_block:
                raise SystemExit(
                    f"the sealed block does not carry what {tool} just printed — the first "
                    f"pass's seal is stale; re-seal before verifying.\n  printed: {line}"
                )
        sealed = SEALED_RUN.search(sealed_block)
        if not sealed:
            raise SystemExit(
                "no sealed check-run time to confirm — run the first pass before "
                "--verify-after-write"
            )
        rerun_utc, run_utc = run_utc, sealed.group(1)

    # B-8(a), the half that blocked: the ordering was tested against the FRESH
    # clock while the row was written from the OLD sealed time. Editing one
    # reviewer-owned document between the passes — which is what a reviewer
    # filing a report does — produced a row claiming a run 309 ms BEFORE the
    # mtime it says it is after, at rc 0, and the three checks cannot catch it
    # because a reviewer-owned file carries a marker instead of a digest. The
    # test now runs on `run_utc` as it will be WRITTEN, whichever pass this is.
    if run_utc <= iso(mtime):
        raise SystemExit(
            f"the time this record would claim as its check run ({run_utc}) is not after the "
            f"newest document mtime ({iso(mtime)}, {mfile}) — a document changed since that "
            f"run, so re-seal rather than confirming a stale one"
        )

    text = io.open(manifest, encoding="utf-8").read()
    if BEGIN not in text or END not in text:
        raise SystemExit("no P5-SEAL sentinel pair in the manifest")
    head = text[: text.index(BEGIN)]
    tail = text[text.index(END) + len(END) :]
    io.open(manifest, "w", encoding="utf-8").write(
        head
        + block(out, run_utc, iso(mtime), mfile, digests, markers, selfrow, rerun_utc)
        + tail
    )
    total = digests + markers + selfrow
    print(
        f"sealed: {total} rows = {digests} + {markers} + {selfrow}; run {run_utc}; "
        f"newest other document {iso(mtime)} ({mfile})"
        + ("; re-run verified identical" if rerun_utc else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
