"""PHASE 11 — the quoted-figure check: every figure a document shows as output
must be emitted by something in this tree.

The file keeps its original name (`check_fenced_figures.py`) because the
documents, the manifest and the `HARNESS_SHA256` set already carry it, but
**the net is no longer about fences.** The twelfth challenge round defeated the
fenced version in five shapes, and the fix is not five patches: a line that is
nothing but `key=value` is output-shaped **wherever it sits**, so the fence
parsing is gone and with it every way of escaping the fence.

WHY THIS FILE EXISTS. The tenth round rejected a head because
`P11-LIVE-DDL-PROOF.md` §16.6 showed three lines inside a fenced block, in the
shape of program output, and the third -- `superuser_sees=130` -- was emitted by
nothing in the tree. The answer added the review arm
`figure-that-no-instrument-emits`. The eleventh round made the honest objection
that the arm was a rule in a document with nothing enforcing it. This file is
the enforcement. The twelfth round then attacked the enforcement, which is the
history below.

WHAT IT CHECKS. Every `*.md` **anywhere under the phase directory**, including
subdirectories, scanned line by line. A line that is nothing but a lowercase
`key=value` token -- optionally followed by a `--` comment, with no backtick on
the line -- is a candidate, and the exact token must appear somewhere under
`prep/phase11/harness/` **excluding markdown**, i.e. in an instrument or in a
committed run-evidence file.

WHAT THE TWELFTH ROUND BROKE, AND WHAT EACH FIX IS. It planted the same
fabricated token in six places and changed only where it sat; the control (a
backtick fence) was caught, and five arms were not:

  * `~~~` tilde fence, and a four-space indented block. Both render as code in
    every renderer these documents are read in, so both impersonate output
    exactly as well as ``` does. **Fixed by not looking at blocks at all.**
  * A fenced block after an earlier UNCLOSED fence marker: `inside = not
    inside` flipped parity and the real block downstream read as prose, while
    the candidate count stayed plausible -- a silent hole of exactly the kind
    `exit 2` exists to prevent. **Fixed by deleting the parity state.**
  * A fenced block in `harness/mutations/README.md`: the scan was
    `os.listdir` of the phase directory, so markdown in a subdirectory was
    never a document. **Fixed by walking `**/*.md`.**
  * And the one that mattered: that same file **is part of the haystack**, so a
    fabricated figure written into a markdown file under `harness/` both
    escaped the scan AND legitimised the identical token in a document that
    *was* scanned -- a document being used as an instrument, which is the exact
    thing this check exists to stop. **Fixed by excluding `.md` from the
    haystack**, so no document can ever be its own evidence.

WHAT IT STILL DOES NOT COVER, named because a net is read as covering the
variants of the shapes it names:

  * UPPERCASE assignments (`GIT_DIRTY_AFTER=0`, `EXIT_FOR_M10-noop=4`). In
    these documents those are shell commands and log keys, not a case's output.
  * A `key=value` inside a longer line (`... WHERE axis_code='x'`), and any
    line carrying a backtick, which is source or prose being quoted rather
    than output being reported. The §16.6 withdrawal note names
    `superuser_sees=130` in prose deliberately and must stay findable.
  * Outcome transcripts of the shape `-> rc=0 (NOT REFUSED)` or `rc = 0`, which
    older sections use. They are a figure embedded in a sentence about a
    statement, and a regex reaching them would also swallow the SQL beside
    them.
  * **The haystack is a substring match over one blob** (recorded at the
    twelfth round's request, because six tokens make it invisible and a hundred
    will not): a token emitted anywhere for any reason passes everywhere, so
    `identities=2` printed by one case legitimises `identities=2` written about
    another. Narrowing it to the emitting case is a convention, not a check.
  * **The second direction of the review arm**, which is not mechanisable here:
    whether a figure that IS emitted is a quantity the moment decides. Nothing
    in a token distinguishes a boolean that cannot go stale (`present=true`)
    from a count true only of an instant (`rows=59`).
    `superuser_sees=130` failed both ways; this file catches the first.

AND IT REFUSES TO BE INERT. If the scan finds no candidate at all, the regex
has stopped matching the documents it is pointed at, and a check that measures
nothing must not report a pass. That is exit 2.

EXITS: 0 clean, 1 a figure nothing emits, 2 inert, 4 invoked without `-I`.

ITS RED PROOFS, in three layers. `--selftest` runs every shape above as its own
hermetic arm (synthetic documents AND a synthetic search root, so no arm can
pass or fail because of the real tree), and the proof script runs it BEFORE the
real scan. Pointed at the documents and harness of `51686d9` -- the head the
tenth round rejected -- it names both occurrences of `superuser_sees=130` by
file and line and exits 1. And `rebuild_and_prove.sh` stops on a planted
figure, which the twelfth round verified on its own copy rather than reading.

A CORRECTION ABOUT WHERE IT RUNS, because the first version of this file and of
the manifest's §7.11 both said "step 0, before a cluster exists" and that was
wrong: steps `0` and `0b` of `rebuild_and_prove.sh` create and start the
scratch cluster, and this check was numbered 0 as well -- a collision with
them. It is now step **`0c`**, which runs AFTER the cluster is up and BEFORE
the database is dropped and recreated, before the roles are bootstrapped and
before any migration or pack is applied. Nothing under test has been touched
when it refuses, which is what the claim was for; the cluster sentence was
simply not true, and it was found by running the plant rather than by reading
the script.

EVERY COMMAND SHOWN HERE USES `python3 -I`. `sitecustomize` runs before line 1
of this file, so an un-isolated invocation could forge a green before the guard
below is reached; the guard refuses rather than re-execs, because a tool that
re-execs re-reads its target.

    python3 -I prep/phase11/harness/check_fenced_figures.py --selftest
    python3 -I prep/phase11/harness/check_fenced_figures.py
"""

import sys

if not sys.flags.isolated:
    sys.stderr.write(
        "check_fenced_figures.py: refusing to run without -I. sitecustomize and a "
        "planted module on sys.path both run before this file does, so an "
        "un-isolated run cannot report on itself. Re-invoke as "
        "`python3 -I prep/phase11/harness/check_fenced_figures.py`.\n"
    )
    raise SystemExit(4)

import os
import re
import tempfile

# Nothing but a lowercase key, '=', and a plain value, with an optional `--`
# comment. The value's character class excludes the backtick and the markdown
# punctuation that ends a sentence, so a prose fragment such as
# ``status='active'`):`` is not a candidate. No fence state, by design: a line
# of this shape impersonates output wherever it sits, and every escape the
# twelfth round found was an escape from fence parsing.
TOKEN = re.compile(r"^\s*([a-z][a-z0-9_]*=[A-Za-z0-9_.'\"/+:-]+)\s*(?:--.*)?$")

PHASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def tokens_in(path):
    """Every (line number, token) in one document, fenced or not."""
    out = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.rstrip("\n")
        if "`" in line:
            continue
        m = TOKEN.match(line)
        if m:
            out.append((n, m.group(1)))
    return out


def documents(docs_dir):
    """Every markdown file under the phase directory, subdirectories included."""
    out = []
    for d, _subdirs, files in os.walk(docs_dir):
        for f in sorted(files):
            if f.endswith(".md"):
                out.append(os.path.join(d, f))
    return sorted(out)


def emitted_strings(root):
    """What the instruments and the committed evidence under `root` emit.

    **Markdown is excluded.** A document is not an instrument, and a markdown
    file under the harness used to be both outside the scan and inside the
    haystack -- so one file could hide a fabricated figure and legitimise it
    elsewhere at the same time. That was the twelfth round's `E4a`/`E4b`.
    """
    blob = []
    for d, _subdirs, files in os.walk(root):
        for f in sorted(files):
            if f.endswith(".md"):
                continue
            if f == os.path.basename(__file__):
                continue  # a token quoted in this file's own prose proves nothing
            try:
                blob.append(open(os.path.join(d, f), encoding="utf-8", errors="replace").read())
            except OSError:
                pass
    return "\n".join(blob)


def scan(docs_dir, harness_dir, quiet=False):
    """0 = every quoted figure is emitted. 1 = a finding. 2 = inert."""
    haystack = emitted_strings(harness_dir)
    docs = documents(docs_dir)
    seen = 0
    findings = []
    for path in docs:
        rel = os.path.relpath(path, docs_dir)
        for n, tok in tokens_in(path):
            seen += 1
            if tok not in haystack:
                findings.append((rel, n, tok))
    if not quiet:
        print(
            "quoted figures: %d documents, %d candidate tokens, %d not emitted"
            % (len(docs), seen, len(findings))
        )
    if seen == 0:
        if not quiet:
            print(
                "  INERT: no `key=value` line was found in any document. The check is "
                "measuring nothing, which it must not report as a pass."
            )
        return 2
    for rel, n, tok in findings:
        if not quiet:
            print(
                "  NOT EMITTED: %s:%d shows `%s` as output, and no instrument or "
                "committed evidence file under the harness emits that string. Either "
                "have a case emit it and paste what it emits, or drop it and keep the "
                "claim a case pins." % (rel, n, tok)
            )
    return 1 if findings else 0


# Each arm is one shape the twelfth round planted the same fabricated token in.
# The first is the control it caught; the rest are the five it did not, and each
# must now be caught or the fix is a claim rather than a measurement.
ARMS = [
    ("E3 control: backtick fence", "docs/a.md", "```\nfabricated_count=999\n```\n", 1),
    ("E1 tilde fence", "docs/a.md", "~~~\nfabricated_count=999\n~~~\n", 1),
    ("E2 four-space indented block", "docs/a.md", "text:\n\n    fabricated_count=999\n", 1),
    (
        "E5 after an unclosed earlier fence",
        "docs/a.md",
        "```\nsome opener never closed\n\nprose\n\n```\nfabricated_count=999\n```\n",
        1,
    ),
    ("E4a markdown in a subdirectory", "docs/sub/README.md", "```\nfabricated_count=999\n```\n", 1),
    ("bare line, no block at all", "docs/a.md", "prose\n\nfabricated_count=999\n\nmore prose\n", 1),
    ("a token the synthetic instrument emits", "docs/a.md", "```\npresent=true\n```\n", 0),
    (
        "prose naming a figure is NOT a finding",
        "docs/a.md",
        "The withdrawn `fabricated_count=999` is named here in prose.\n",
        2,
    ),
]


def selftest():
    """The cases that fail it, one per shape, all hermetic."""
    ok = True
    for label, relpath, body, expect in ARMS:
        with tempfile.TemporaryDirectory() as d:
            docs = os.path.join(d, "docs")
            harness = os.path.join(d, "harness")
            os.makedirs(os.path.join(docs, "sub"))
            os.makedirs(harness)
            open(os.path.join(harness, "fake_proofs.py"), "w", encoding="utf-8").write(
                'case("a", "SELECT 1", "present=true")\n'
            )
            open(os.path.join(d, relpath), "w", encoding="utf-8").write(body)
            rc = scan(docs, harness, quiet=True)
            good = rc == expect
            print(
                "  selftest %-42s rc=%d (want %d) -> %s"
                % (label, rc, expect, "as required" if good else "**SELFTEST FAILED**")
            )
            ok = ok and good

    # E4b, which needs two files: a fabricated token in markdown under the
    # harness must NOT make the identical token lawful in a scanned document.
    with tempfile.TemporaryDirectory() as d:
        docs = os.path.join(d, "docs")
        harness = os.path.join(d, "harness")
        os.makedirs(docs)
        os.makedirs(harness)
        open(os.path.join(harness, "fake_proofs.py"), "w", encoding="utf-8").write(
            'case("a", "SELECT 1", "present=true")\n'
        )
        open(os.path.join(harness, "README.md"), "w", encoding="utf-8").write(
            "```\nfabricated_count=999\n```\n"
        )
        open(os.path.join(docs, "a.md"), "w", encoding="utf-8").write(
            "```\nfabricated_count=999\n```\n"
        )
        rc = scan(docs, harness, quiet=True)
        print(
            "  selftest %-42s rc=%d (want 1) -> %s"
            % ("E4b a document cannot be its own evidence", rc, "as required" if rc == 1 else "**SELFTEST FAILED**")
        )
        ok = ok and rc == 1
    return 0 if ok else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        raise SystemExit(selftest())
    raise SystemExit(scan(PHASE_DIR, os.path.join(PHASE_DIR, "harness")))
