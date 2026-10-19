#!/usr/bin/env python3
"""M119 — the two branches of `seal-check-run.pinned_now()`, exercised directly.

ROUND 28. The challenger sent the same F-51 note twice, because it is the one
way that remedy turns into a fail-open: the sentence "its bytes are the audited
bytes" must be computed AT the refusal, in that process, at that instant. If it
reused the digest check's earlier reading, a byte edit landing between the two
reads would get the gentler sync-bump wording, and the gentler wording is the
one a reader waves through. That is B-7's shape reappearing inside the sentence
written to explain a refusal.

Through the whole tool the interesting branch is UNREACHABLE: a row that no
longer matches its file reds at the digest check before the ordering test is
read, so only a race could reach it, and a race arm that is sometimes green
proves nothing. Hence this arm, which calls the function sequentially with a
crafted manifest and asserts all four branches:

    matching row                  -> True
    row kept, bytes replaced      -> False      <- the one that matters
    marker row ("reviewer-owned") -> False
    no row at all                 -> False

Run it isolated, like every other tool here. Without `-I` the import of
`seal-check-run.py` refuses, which is the behaviour this round exists to keep:

    python3 -I tools/arms/pinned-now-arm.py tools/seal-check-run.py
"""

from __future__ import annotations

# ROUND 28, the coordinator's B-11 ruling. This arm is a `.py` under `tools/`
# like any other, so it carries the same guard, above every other import. It
# would otherwise rely on the guard inside the module it imports, which is a
# defence belonging to a different file and reached only after this one has
# already run.
import sys

if not sys.flags.isolated:
    raise SystemExit(
        "refusing to run without -I: run "
        "`python3 -I tools/arms/pinned-now-arm.py tools/seal-check-run.py`. "
        "Without isolation PYTHONPATH and the user site directory are on sys.path "
        "before this file is read, so what this tool computes is not this tool's."
    )

import hashlib
import importlib.util
import pathlib
import tempfile


# Importing a file writes `tools/__pycache__/` beside it, which is an untracked
# directory appearing in the repository because an ARM ran. Root `.gitignore`
# is the Repo Owner's file and this is not worth a request, so the arm simply
# does not write bytecode.
sys.dont_write_bytecode = True


def load(path: str):
    spec = importlib.util.spec_from_file_location("seal_check_run", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        raise SystemExit("usage: pinned-now-arm.py <path to seal-check-run.py>")
    mod = load(argv[1])

    with tempfile.TemporaryDirectory() as d:
        base = pathlib.Path(d)
        doc = base / "DOC.md"
        doc.write_text("audited bytes\n", encoding="utf-8")
        good = hashlib.sha256(doc.read_bytes()).hexdigest()
        manifest = base / "M.md"

        manifest.write_text(f"| `DOC.md` | `{good}` |\n", encoding="utf-8")
        matching = mod.pinned_now(manifest, base, "DOC.md")

        # The row is untouched; only the bytes move. A function that remembered
        # an earlier verdict would still say True here.
        doc.write_text("edited bytes\n", encoding="utf-8")
        stale = mod.pinned_now(manifest, base, "DOC.md")

        manifest.write_text(
            "| `DOC.md` | reviewer-owned, not hashed by the author |\n", encoding="utf-8"
        )
        marker = mod.pinned_now(manifest, base, "DOC.md")

        manifest.write_text(f"| `OTHER.md` | `{good}` |\n", encoding="utf-8")
        absent = mod.pinned_now(manifest, base, "DOC.md")

    rows = (
        ("matching row", matching, True),
        ("row kept, bytes replaced", stale, False),
        ("marker row", marker, False),
        ("no row at all", absent, False),
    )
    bad = 0
    for label, got, want in rows:
        ok = got is want
        bad += 0 if ok else 1
        print(f"{label:28} -> {got!s:5} (want {want!s:5}) {'ok' if ok else 'WRONG'}")
    print(f"{len(rows) - bad}/{len(rows)} branches as specified")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
