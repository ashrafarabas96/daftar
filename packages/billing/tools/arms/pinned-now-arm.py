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
import types


# Importing a file writes `tools/__pycache__/` beside it, which is an untracked
# directory appearing in the repository because an ARM ran. Root `.gitignore`
# is the Repo Owner's file and this is not worth a request, so the arm simply
# does not write bytecode.
sys.dont_write_bytecode = True


def load(path: str):
    """Load the subject, and REFUSE unless what came back is that file.

    ROUND 29, the challenger's B-11, third remedy. Measured by it: a
    `sitecustomize.py` that swaps `importlib.util` — both
    `sys.modules["importlib.util"]` and the attribute on the real `importlib`
    package — hands this function a fake and the real file is never read. It
    printed `4/4 branches as specified` at rc 0 with the argument pointing at
    `/nonexistent/seal-check-run.py`. An arm that reports four branches of a
    function it never loaded witnesses nothing, and witnessing is this file's
    only job.

    The guard above now removes the un-isolated path that delivers that plant,
    but the guard's SILENCE is not evidence — that is this round's own lesson —
    so the arm also checks what it got: the file exists and is non-empty, the
    spec's origin and the module's `__file__` are the path it was given, and
    the attribute under test is a real function from that module.
    """
    # Resolved, because the import machinery answers with an absolute origin and
    # the comparison must be between the same two things.
    target = pathlib.Path(path).resolve()
    if not target.is_file():
        raise SystemExit(f"no file at {path} — refusing to report branches of a module not loaded")
    size = target.stat().st_size
    if size == 0:
        raise SystemExit(f"{path} is empty — refusing to report branches of an empty module")

    spec = importlib.util.spec_from_file_location("seal_check_run", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    if getattr(spec, "origin", None) != str(target):
        raise SystemExit(
            f"the import machinery returned a spec for {getattr(spec, 'origin', None)!r} when "
            f"{str(target)!r} was asked for — refusing: something between this arm and the file "
            f"is answering for it"
        )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if getattr(mod, "__file__", None) != str(target):
        raise SystemExit(
            f"the loaded module reports __file__ {getattr(mod, '__file__', None)!r}, not "
            f"{str(target)!r} — refusing to attribute its answers to that file"
        )
    subject = getattr(mod, "pinned_now", None)
    if not isinstance(subject, types.FunctionType):
        raise SystemExit(
            f"{path} has no `pinned_now` FUNCTION to exercise — refusing rather than reporting "
            f"branches of whatever this is"
        )
    if getattr(subject, "__module__", None) != "seal_check_run":
        raise SystemExit("`pinned_now` did not come from the module just loaded — refusing")
    print(f"subject: {target} ({size} bytes), pinned_now loaded from that file")
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
