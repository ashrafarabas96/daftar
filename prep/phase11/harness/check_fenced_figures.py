"""PHASE 11 — the fenced-figure check, made executable.

WHY THIS FILE EXISTS. The tenth challenge round rejected a head because
`P11-LIVE-DDL-PROOF.md` §16.6 showed three lines inside a fenced block, in the
shape of program output, and the third of them -- `superuser_sees=130` -- was
emitted by nothing in the tree. A fenced block reads as OUTPUT; putting a
number in one asserts that something printed it. The answer added a review arm,
`figure-that-no-instrument-emits`, to
`P11-CONSERVATION-LAWS-AND-RED-PROOFS.md`, and the independent challenger then
made the honest objection that closes the loop: **that arm was a rule in a
document, and nothing in the harness enforced it.** This file is the
instrument. It would have caught the defect it is named after.

WHAT IT CHECKS, exactly, and the shape of the net matters because a net is
read as covering the variants of the shapes it names. For every `*.md` under
the phase's own directory it reads the FENCED blocks only, and in them the
lines that are nothing but a lowercase `key=value` token, optionally followed
by a `--` comment. For each such token it requires the exact string to appear
somewhere under `prep/phase11/harness/` -- which holds both the instruments
(`proofs.py`, `proofs_b.py`, `races.py`, `races_b.py`, the mutations) and the
committed run-evidence files. A token nothing emits is a FINDING.

WHAT IT DOES NOT CHECK, named rather than left to be assumed:

  * Prose. A figure in a sentence is a claim a reader weighs with its
    surrounding words; a figure in a fenced block impersonates output. Only
    the second is this file's subject, and the withdrawal note in §16.6 names
    `superuser_sees=130` in prose deliberately -- it must stay findable.
  * UPPERCASE assignments (`GIT_DIRTY_AFTER=0`, `EXIT_FOR_M10-noop=4`). In the
    blocks of this phase those are shell commands and log keys, not a case's
    output.
  * A `key=value` inside a longer line (`... WHERE axis_code='x'`), which is
    source being quoted, not output being reported.
  * Outcome transcripts of the shape `-> rc=0 (NOT REFUSED)` or `rc = 0`, which
    this phase's older sections use inside fenced blocks. They are a different
    shape -- a figure embedded in a sentence about a statement -- and widening
    the regex to reach them would also swallow the SQL in those same blocks
    (`c.oid = a.attrelid`), turning source into candidates. Named here because
    a net is read as covering the variants of the shapes it names, and this one
    does not cover that one.
  * **The second direction of the review arm**, which is NOT mechanisable
    here: whether a figure that IS emitted is a quantity the moment decides.
    `superuser_sees=130` failed twice over -- nothing emitted it, AND a ledger
    row count depends on when it is read, because the suites run twice on one
    database and the ledger accumulates. This file catches the first. The
    second stays a rule, and the arm says so.

AND IT REFUSES TO BE INERT. If the scan finds no candidate token at all, the
regex has stopped matching the documents it is pointed at -- a check that
measures nothing while reporting success is the defect `M10` exists to catch,
one level up. That is exit 2, not exit 0.

ITS OWN RED PROOF is `--selftest`, which the proof run executes BEFORE the
real scan, the way `render_bootstrap.py --selftest` is run before anything is
rendered. Its three arms are hermetic -- a synthetic document plus a synthetic
search root -- so none of them can pass or fail because of the real tree: a
token nothing emits must give exit 1, an emitted token exit 0, and a document
set with no fenced token at all exit 2.

AND IT WAS PROVED AGAINST THE REAL DEFECT, not only against its fixtures. Run
over the documents and harness of `51686d9` -- the head the tenth round
rejected -- it reports, unprompted:

    fenced figures: 8 documents, 6 candidate tokens, 2 not emitted
      NOT EMITTED: P11-LIVE-DDL-PROOF.md:2234 shows `superuser_sees=130` ...
      NOT EMITTED: P11-MIGRATION-PATCH-REQUEST.md:746 shows `superuser_sees=130` ...

Both occurrences, by file and line, with exit 1. At the head that answered the
round it reports 6 candidate tokens and 0 not emitted, with exit 0. A fixture
proves the check can fail; the rejected head proves it fails on the thing it
was built for.

EVERY COMMAND SHOWN HERE USES `python3 -I`. `sitecustomize` runs before line 1
of this file, so an un-isolated invocation could forge a green before the
guard below is ever reached; the guard refuses rather than re-execing, because
a tool that re-execs re-reads its target.

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

FENCE = re.compile(r"^\s*```")
# Nothing but a lowercase key, '=', a value with no spaces, and an optional
# `--` comment. Anchored at both ends on purpose: a token inside a longer line
# is quoted source, not reported output.
TOKEN = re.compile(r"^\s*([a-z][a-z0-9_]*=\S+?)\s*(?:--.*)?$")

PHASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def tokens_in(path):
    """Every (line number, token) inside a fenced block of one document."""
    out = []
    inside = False
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        if FENCE.match(line):
            inside = not inside
            continue
        if not inside:
            continue
        m = TOKEN.match(line.rstrip("\n"))
        if m:
            out.append((n, m.group(1)))
    return out


def emitted_strings(root):
    """Everything the instruments and the committed evidence under `root` say.

    Read as one blob rather than per file: the question is only whether any
    instrument or any recorded run emits the token, not which one does.
    """
    blob = []
    for d, _subdirs, files in os.walk(root):
        for f in sorted(files):
            if f == os.path.basename(__file__):
                continue  # a token quoted in this file's own prose proves nothing
            p = os.path.join(d, f)
            try:
                blob.append(open(p, encoding="utf-8", errors="replace").read())
            except OSError:
                pass
    return "\n".join(blob)


def scan(docs_dir, harness_dir, quiet=False):
    """0 = every fenced token is emitted. 1 = a finding. 2 = inert."""
    haystack = emitted_strings(harness_dir)
    docs = sorted(f for f in os.listdir(docs_dir) if f.endswith(".md"))
    seen = 0
    findings = []
    for f in docs:
        for n, tok in tokens_in(os.path.join(docs_dir, f)):
            seen += 1
            if tok not in haystack:
                findings.append((f, n, tok))
    if not quiet:
        print(
            "fenced figures: %d documents, %d candidate tokens, %d not emitted"
            % (len(docs), seen, len(findings))
        )
    if seen == 0:
        if not quiet:
            print(
                "  INERT: no fenced `key=value` token was found in any document. The "
                "check is measuring nothing, which it must not report as a pass."
            )
        return 2
    for f, n, tok in findings:
        if not quiet:
            print(
                "  NOT EMITTED: %s:%d shows `%s` inside a fenced block, and no file "
                "under the harness emits that string. Either have a case emit it and "
                "paste what it emits, or drop it and keep the claim a case pins." % (f, n, tok)
            )
    return 1 if findings else 0


def selftest():
    """The cases that fail it. Both arms hermetic: synthetic doc, synthetic root."""
    ok = True
    with tempfile.TemporaryDirectory() as d:
        docs = os.path.join(d, "docs")
        harness = os.path.join(d, "harness")
        os.makedirs(docs)
        os.makedirs(harness)
        # The synthetic instrument emits one token and not the other.
        open(os.path.join(harness, "fake_proofs.py"), "w", encoding="utf-8").write(
            'case("a", "SELECT 1", "present=true")\n'
        )

        open(os.path.join(docs, "red.md"), "w", encoding="utf-8").write(
            "A sentence naming fabricated_count=999 in prose is NOT a finding.\n\n"
            "```\n"
            "present=true         -- emitted by the synthetic instrument\n"
            "fabricated_count=999 -- emitted by nothing\n"
            "```\n"
        )
        rc = scan(docs, harness, quiet=True)
        print(
            "  selftest RED case  : rc=%d -> %s"
            % (rc, "RED as required" if rc == 1 else "**SELFTEST FAILED: the check is inert**")
        )
        ok = ok and rc == 1

        os.remove(os.path.join(docs, "red.md"))
        open(os.path.join(docs, "green.md"), "w", encoding="utf-8").write(
            "```\npresent=true\n```\n"
        )
        rc = scan(docs, harness, quiet=True)
        print("  selftest GREEN case: rc=%d -> %s" % (rc, "passes" if rc == 0 else "**SELFTEST FAILED**"))
        ok = ok and rc == 0

        # And the inert arm: a document with no fenced token must NOT pass.
        os.remove(os.path.join(docs, "green.md"))
        open(os.path.join(docs, "empty.md"), "w", encoding="utf-8").write(
            "No fenced block here, only prose naming present=true.\n"
        )
        rc = scan(docs, harness, quiet=True)
        print(
            "  selftest INERT case: rc=%d -> %s"
            % (rc, "refuses as required" if rc == 2 else "**SELFTEST FAILED: it reported a pass on nothing**")
        )
        ok = ok and rc == 2
    return 0 if ok else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        raise SystemExit(selftest())
    raise SystemExit(scan(PHASE_DIR, os.path.join(PHASE_DIR, "harness")))
