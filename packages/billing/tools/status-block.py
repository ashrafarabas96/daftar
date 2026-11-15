#!/usr/bin/env -S python3 -I
"""One status block for the Phase 5 pack, generated from one source.

ROUND 17, THE COORDINATOR'S N-5 (P2). Five status claims in three documents
contradicted each other: "the current head is covered" sat beside "a sixth
round is owed on this round's SHA", a verdict row titled "ON THIS SHA" carried
the verdict on a different SHA, and "Coordinator Contract Diff: NOT PERFORMED"
sat beside "DONE at `2108d26`". None of them was a lie when it was written;
each became one when an event moved past it, because each was maintained by
hand in its own document.

So the status is written ONCE, in `P5-STATUS.json`, and rendered into every
document that carries the sentinel pair. `--check` exits 1 on three distinct
failures, and the third is the one the P15 lesson is about:

  * a rendered block that DIFFERS from the source (drift),
  * a document in `documents` that carries NO sentinel pair (absence) — a
    check that only compares what it finds passes when a document quietly
    stops being checked,
  * a sentinel pair that is malformed or unclosed.

It makes no claim about whether the status is TRUE. It makes the pack say the
same thing in every document, which is the whole of N-5.
"""

from __future__ import annotations

# B-9, round 27. This tool must run ISOLATED: `python3 -I tools/status-block.py`.
# Without `-I`, the interpreter puts `PYTHONPATH` and the user site directory on
# `sys.path` BEFORE any line here runs, so a shadowed stdlib module — or a
# `sitecustomize.py`, which `site` imports at startup — decides what this tool
# computes, in a tool whose whole purpose is to be the thing a reader does not
# have to trust.
#
# It REFUSES rather than re-execing itself with `-I`. Round 27's first attempt
# re-exec'd, which re-reads this file from disk: code that has already lost the
# startup race can rewrite the exec target, and the isolated process then runs
# the attacker's file while LOOKING clean.
# `sys` is a builtin module, so the guard cannot be defeated by shadowing a
# stdlib import, and it stands above every other import in this file.
#
# ROUND 28, THE COORDINATOR'S F-50, RATED P1. What the wording here used to claim
# was FALSE, and the correction is the finding. Run this tool WITHOUT `-I` and
# `site` imports `sitecustomize` — and `usercustomize` — at interpreter startup,
# BEFORE line 1 of this file: code is loaded before the check, and the refusal CAN
# be redirected. Measured: a plant on `PYTHONPATH`, reached through the un-isolated
# command this file's own docstring used to print, produced a forged `0 problems`
# at rc 0 over a pack with a drifted file.
#
# AND THE GUARD ITSELF IS FORGEABLE, which is the challenger's §9 and the reason
# nothing here may be read as establishing isolation. `sys.flags` is an ordinary
# writable attribute of an ordinary module, so a startup plant can hand this check
# a `flags` whose `isolated` is 1: measured, an un-isolated run then printed NO
# refusal and exited 0. THE ABSENCE OF THE REFUSAL IS THEREFORE NOT EVIDENCE OF
# ISOLATION, and an un-isolated run that looks clean proves nothing about what
# computed its figures.
#
# So this guard buys one thing only: an un-isolated run with nothing already
# planted against it says so instead of computing. Inside a non-isolated run it
# defends nothing and attests nothing. The real control is `-I` AT THE CALL SITE —
# which is why every usage line here, every command in the pack and every child
# this tool spawns carries it, and why a test asserts that and reds if one loses
# it.
#
# ROUND 28, F-50's companion, stated rather than coded: this tests the `-I` FLAG,
# not the condition, so `python3 -E -s` is refused although it also clears
# `PYTHONPATH` and the user site directory. That is deliberate. `-E -s` still
# leaves the script's own directory first on `sys.path`, which is the one place
# an attacker who can write next to this file does not need `PYTHONPATH` at all.
# One flag, one documented command, nothing to reason about at the call site.
import sys

if not sys.flags.isolated:
    raise SystemExit(
        "refusing to run without -I: run `python3 -I tools/status-block.py`. "
        "Without isolation PYTHONPATH and the user site directory are on sys.path "
        "before this file is read, so what this tool computes is not this tool's."
    )


import argparse
import json
import os
import re
import subprocess
from pathlib import Path

# ROUND 49, THE COORDINATOR'S ADDENDUM (d), and the P15 lesson it comes from:
# A SHA THAT APPEARS ANYWHERE IS NOT THE SHA A DOCUMENT DECLARES. This tool
# renders a head into five documents and never asked whether that head exists.
# A typo, a stale abbreviation or a sha from another branch rendered cleanly
# into all five and the pack then SAID it in five places.
#
# So the source carries BOTH forms: `head` as a reader sees it and `head_full`
# as a full 40-character sha, the abbreviation must be a prefix of the full
# one, and the full one must RESOLVE AS A COMMIT in this repository. Each
# failure refuses BY NAME, and ABSENCE refuses too: no git, no repository, no
# `head_full` is a refusal and not a pass.
#
# What this does NOT claim: that the head is the head a reviewer should be at,
# or that it is pushed. It claims the object exists and that the two spellings
# are the same object. `challenger_covers` and the verdict fields are PROSE, by
# design -- they carry sentences such as "nothing in this phase is signed" --
# so they are not sha fields and are not validated as such; the shas inside
# them are pinned where they are measured, in the ledger. ROUND 51 renames that
# field: it was `challenger_sha`, which READ as a sha field and rendered as
# "names `nothing in this phase is signed`". The name now says what the field
# is -- what the challenger's verdict COVERS -- so a reader is not told a
# sentence is a sha. Owed since the round-49 ledger (section 0ad, item 2) and
# riding this commit because a commit whose only content is a record is a
# review loop.
SHA_FULL = re.compile(r"^[0-9a-f]{40}$")
SHA_SHORT = re.compile(r"^[0-9a-f]{7,40}$")
REFUSED_SHA_SHAPE = "REFUSED-STATUS-SHA-SHAPE"
REFUSED_SHA_NOT_RESOLVED = "REFUSED-STATUS-SHA-NOT-RESOLVED"

BEGIN = "<!-- P5-STATUS:BEGIN — generated by tools/status-block.py; edit P5-STATUS.json -->"
END = "<!-- P5-STATUS:END -->"
SOURCE = "P5-STATUS.json"


def resolves_as_commit(sha: str, repo: Path) -> str | None:
    """`None` when `sha` is a commit object in `repo`, else the refusal to print.

    The git hygiene is the standing one for this phase, and every line of it is
    a measured lesson rather than caution: a tool that sets two environment
    keys still inherits the rest, so the environment is REBUILT instead of
    patched; `GIT_DIR` beats `-C`, so it is set explicitly; replace refs are
    disabled, because a replace ref can make one object answer for another;
    `PATH` is pinned and the binary is named absolutely; and an ABSENT git is a
    named refusal, never a skip. Only OBJECT EXISTENCE is asked -- grafts and
    shallow clones rewrite history TRAVERSAL, which this question does not use.
    """
    git = Path("/usr/bin/git")
    if not git.is_file():
        return f"{REFUSED_SHA_NOT_RESOLVED} {sha}: no /usr/bin/git on this machine, so nothing here resolved it"
    gitdir = repo / ".git"
    if not gitdir.exists():
        return f"{REFUSED_SHA_NOT_RESOLVED} {sha}: no git repository at {repo}, so nothing here resolved it"
    env = {
        "PATH": "/usr/bin:/bin",
        "GIT_DIR": str(gitdir),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(repo),
        "LC_ALL": "C",
    }
    try:
        done = subprocess.run(
            [str(git), "--no-replace-objects", "cat-file", "-t", f"{sha}^{{commit}}"],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
    except OSError as exc:
        return f"{REFUSED_SHA_NOT_RESOLVED} {sha}: git did not run ({exc})"
    except subprocess.TimeoutExpired:
        return f"{REFUSED_SHA_NOT_RESOLVED} {sha}: git did not answer in time"
    if done.returncode != 0 or done.stdout.strip() != "commit":
        return (
            f"{REFUSED_SHA_NOT_RESOLVED} {sha}: not a commit in {repo} "
            f"(rc {done.returncode}, {done.stdout.strip() or done.stderr.strip()[:120]!r})"
        )
    return None


def sha_problems(st: dict, repo: Path) -> list[str]:
    """Every refusal the head's two spellings earn, by name. Absence refuses."""
    out: list[str] = []
    head = st.get("head")
    full = st.get("head_full")
    if not isinstance(head, str) or not SHA_SHORT.match(head):
        out.append(f"{REFUSED_SHA_SHAPE} head={head!r}: not 7 to 40 lowercase hex characters")
    if not isinstance(full, str) or not SHA_FULL.match(full):
        out.append(f"{REFUSED_SHA_SHAPE} head_full={full!r}: not a full 40-character lowercase sha")
        return out
    if isinstance(head, str) and not full.startswith(head):
        out.append(f"{REFUSED_SHA_SHAPE} head={head!r} is not a prefix of head_full={full!r}: two documents, two heads")
    refusal = resolves_as_commit(full, repo)
    if refusal is not None:
        out.append(refusal)
    return out


def render(st: dict) -> list[str]:
    """The block. Deliberately a table: a reader compares two documents by eye."""
    rows = [
        BEGIN,
        "",
        "| status field | value |",
        "|---|---|",
        f"| **Ladder position** | `{st['ladder']}` |",
        f"| **READY_TO_PROMOTE** | **{st['ready_to_promote']}** |",
        f"| **Branch head** | `{st['head']}`{'' if st['head_pushed'] else ' — **NOT PUSHED**'} |",
        f"| **Run id at that head** | `{st['run_id']}` |",
        f"| **Challenger verdict** | {st['challenger_verdict']} — **covers: {st['challenger_covers']}** |",
        f"| **Coordinator diff review** | {st['coordinator_review']} |",
        f"| **Does any verdict cover the head?** | **{st['head_covered']}** |",
        f"| **Author self-signature** | {st['self_signature']} |",
        f"| **Next thing owed** | {st['next_owed']} |",
        "",
        f"_{st['note']}_",
        "",
        END,
    ]
    return rows


def bounds(lines: list[str], path: Path) -> tuple[int, int] | None:
    begins = [i for i, l in enumerate(lines) if l.strip() == BEGIN]
    ends = [i for i, l in enumerate(lines) if l.strip() == END]
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        sys.exit(f"{path.name}: malformed sentinel pair ({len(begins)} begin, {len(ends)} end)")
    return begins[0], ends[0] + 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="the directory holding the pack")
    ap.add_argument("--check", action="store_true", help="verify instead of rewriting")
    ap.add_argument(
        "--repo",
        default=str(Path(__file__).resolve().parents[3]),
        help="the repository the declared head must resolve in (default: the one this tool lives in)",
    )
    args = ap.parse_args()

    base = Path(args.dir)
    src = base / SOURCE
    if not src.is_file():
        sys.exit(f"no {SOURCE} in {base}")
    st = json.loads(src.read_text())
    # ROUND 50, THE COORDINATOR'S P2, and it is a sentence that was FALSE. This
    # comment used to say a sha that does not exist is "never written into a
    # document", while the loop below went on writing: measured, `wrote 5
    # documents, 1 problem`. The remedy is the behaviour and not the sentence.
    # In rewrite mode a bad head now REFUSES BEFORE the first write, so the
    # claim and the code agree; in --check mode the problems are reported with
    # everything else, because reporting is what --check is for.
    problems: list[str] = sha_problems(st, Path(args.repo).resolve())
    if problems and not args.check:
        for p in problems:
            print(p)
        print(f"refusing to write {SOURCE}'s block into any document while the declared head is wrong")
        return 1
    block = render(st)
    documents: list[str] = st["documents"]

    for name in documents:
        path = base / name
        if not path.is_file():
            problems.append(f"MISSING document: {name}")
            continue
        lines = path.read_text().split("\n")
        at = bounds(lines, path)
        if at is None:
            # ABSENCE, not drift. This is the failure a comparing-only check
            # cannot see, and the one that lets a document fall out of the set.
            problems.append(f"NO STATUS BLOCK in a document that must carry one: {name}")
            continue
        start, end = at
        if args.check:
            if lines[start:end] != block:
                problems.append(f"STATUS BLOCK DRIFTED from {SOURCE}: {name}")
        else:
            path.write_text("\n".join(lines[:start] + block + lines[end:]))

    for p in problems:
        print(p)
    verb = "checked" if args.check else "wrote"
    print(f"{verb} {len(documents)} documents, {len(problems)} problems")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
