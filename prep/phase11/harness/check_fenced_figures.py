"""PHASE 11 — the quoted-figure check: every figure a document shows as output
must be emitted by something in this tree.

The file keeps its original name because the documents, the manifest and the
`HARNESS_SHA256` set already carry it, but it has been through three designs,
each one an answer to a challenge round that defeated the last. **The current
one is: narrow the VALUE, widen the CONTEXT.**

  * Round 11 asked for the review arm `figure-that-no-instrument-emits` to stop
    being a rule in a document. The first design read `key=value` lines inside
    fenced blocks.
  * Round 12 defeated it in five shapes, all of them escapes from **fence
    parsing**: `~~~`, a four-space indented block, a block downstream of an
    unclosed fence, markdown in a subdirectory, and a markdown file under
    `harness/` that was outside the scan AND inside the haystack. The second
    design deleted the fence parsing: a line that was nothing but `key=value`
    counted wherever it sat.
  * Round 13 defeated THAT in eleven shapes, all of them escapes from the
    **line anchor**: a blockquote, a list item, bold, parentheses, a trailing
    comma, semicolon, period or percent, a thousands separator, an HTML
    comment, a colon prefix, a table cell. And a list item is the most
    idiomatic way these documents write a figure. The same round measured the
    price of the second design in the other direction: **7 of 14 realistic
    prose shapes red the gate** -- `role=postgres` and `kind=refusal` are
    `proofs.py`'s own `case()` parameters, so a future paragraph explaining the
    harness would have stopped every proof in the phase. Fail-closed, so a cost
    rather than a hole, but a cost that stops the work.

Patching eleven prefixes would have left a twelfth, exactly as patching four
fence syntaxes would have left a fifth. **So this design changes what a
candidate IS.** The arm is about FIGURES, and a figure is a number or a
boolean. The value must now be `[0-9][0-9,._]*` or `true`/`false`; everything
around the token is markdown decoration and is stripped before matching --
blockquote markers, list markers, headings, table cells, emphasis, brackets, a
leading `label:`, HTML comment markers, and trailing punctuation.

That closes both directions at once. The eleven escapes are caught because the
decoration no longer matters, and the seven false positives stop being
candidates because `postgres`, `refusal`, `heads/main`, `catalog.foo_invalid`,
`PATCH-REQ-P8-08`, `agreement` and `/var/tmp/myclone` are not figures.
`locale=en_US.utf8`, which round 13 got to PASS only because those bytes sit in
the script's `initdb` line, is not a candidate either.

WHAT IT CHECKS. Every `*.md` anywhere under the phase directory, including
subdirectories. A line whose markdown decoration strips away to nothing but
`key=<number|boolean>` is a candidate, and the exact token must appear
somewhere under `prep/phase11/harness/` **excluding markdown** -- in an
instrument or in a committed run-evidence file.

THE BACKTICK RULE, which round 13 was right about twice over. The previous
design skipped any line containing a backtick. That guard was **unmeasured**
(deleting it red no arm and changed nothing on the real tree) and it opened an
escape in the wrong direction: a token followed by a backticked `--` comment
passed. It is gone. What replaces it is narrower and is measured: **inline code
spans are removed from the line before matching**, so a figure written only
inside `` `deleted=0` `` is still excluded -- that is prose quoting a value,
and the §16.6 withdrawal note depends on it -- while a bare figure followed by
a backticked comment is now caught, because deleting the span leaves the bare
figure behind.

WHAT IT STILL DOES NOT COVER, named because a net is read as covering the
variants of the shapes it names:

  * UPPERCASE keys (`GIT_DIRTY_AFTER=0`, `EXIT_FOR_M10-noop=4`). In these
    documents those are shell commands and log keys, not a case's output.
  * A figure with prose on the same line (`it printed deleted=0 and stopped`),
    and a figure that survives only inside an inline code span. Both are a
    reader's sentence about a value rather than a report of one.
  * A NON-NUMERIC, NON-BOOLEAN value, which is the deliberate price of closing
    round 13's false positives: an invented refusal name or path shown as
    output is not a candidate. `role=postgres` cannot be checked without
    stopping the phase on its own documentation.
  * Outcome transcripts of the shape `-> rc=0 (NOT REFUSED)` or `rc = 0`.
  * **The haystack is a substring match over one blob**: a token emitted
    anywhere for any reason passes everywhere, so `identities=2` printed by one
    case legitimises `identities=2` written about another. Round 13 built the
    first live instance of this (`locale=en_US.utf8`, now excluded by the value
    class for an unrelated reason). Narrowing it to the emitting case is a
    convention, not a check.
  * **The second direction of the review arm**, which is not mechanisable here:
    whether a figure that IS emitted is a quantity the moment decides. Nothing
    in a token distinguishes `present=true`, which cannot go stale, from
    `rows=59`, which is true only of an instant. `superuser_sees=130` failed
    both ways; this file catches the first.

AND IT REFUSES TO BE INERT. If the scan finds no candidate at all, the matcher
has stopped matching the documents it is pointed at, and a check that measures
nothing must not report a pass. That is exit 2.

EXITS: 0 clean, 1 a figure nothing emits, 2 inert, 4 invoked without `-I`.

ITS RED PROOFS, in three layers. `--selftest` runs **every shape either round
planted**, each as its own hermetic arm with its expected exit, plus the false
positives round 13 measured as arms that must now come back clean; the proof
script runs it before the real scan. Pointed at the documents and harness of
`51686d9` -- the head round 10 rejected -- it names both occurrences of
`superuser_sees=130` by file and line and exits 1. And the real
`rebuild_and_prove.sh` refuses at step `0c` on a planted figure, naming
`harness/mutations/README.md:94`, with no `=== 1.` line in the log, which both
the author and round 13 verified on their own clones.

WHERE IT RUNS, stated exactly, because an earlier version of this sentence was
false and cost a head its signature: steps `0` and `0b` of
`rebuild_and_prove.sh` create and start the scratch cluster, so this is step
**`0c`** -- after the cluster is up, and before the database is dropped and
recreated, before the roles are bootstrapped and before any migration or pack
is applied. Nothing under test has been touched when it refuses.

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

# Decoration stripped before matching. Each of these exists because a round
# planted a figure behind it; none of them is a guess about markdown.
CODE_SPAN = re.compile(r"`[^`]*`")
LEAD_QUOTE = re.compile(r"^[\s>]+")  # blockquote, indentation, leading tab
LEAD_LIST = re.compile(r"^(?:[-*+]|\d+\.)\s+")  # list item, ordered or not
LEAD_HEAD = re.compile(r"^#+\s*")
LEAD_CELL = re.compile(r"^\|\s*")  # table cell
LEAD_PAREN = re.compile(r"^[(\[]+")
EMPH = re.compile(r"^[*_]{1,3}")
LABEL = re.compile(r"^[A-Za-z][A-Za-z ]{0,30}:\s*")  # `result: deleted=0`
COMMENT = re.compile(r"--.*$")
TRAIL_EMPH = re.compile(r"[*_]{1,3}$")
TRAIL_CELL = re.compile(r"\|\s*$")
TRAIL_PUNCT = re.compile(r"[\s.,;:)%\]]+$")

# A FIGURE: a number, however written, or a boolean. The narrowness here is
# what lets the context above be wide.
FIGURE = re.compile(r"^[a-z][a-z0-9_]*=(?:[0-9][0-9,._]*|true|false)$")

PHASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def figure_on(line):
    """The figure this line reports, or None. Decoration is not a hiding place."""
    s = line.rstrip("\n").replace("<!--", " ").replace("-->", " ")
    # An inline code span is prose quoting a value, so its content goes --
    # which also means a backticked comment cannot shelter a bare figure.
    s = CODE_SPAN.sub(" ", s)
    for _ in range(4):  # decoration nests: `> - **x**`
        before = s
        s = LEAD_QUOTE.sub("", s)
        s = LEAD_LIST.sub("", s)
        s = LEAD_HEAD.sub("", s)
        s = LEAD_CELL.sub("", s)
        s = LEAD_PAREN.sub("", s)
        s = EMPH.sub("", s)
        if s == before:
            break
    s = LABEL.sub("", s)
    s = COMMENT.sub("", s)
    for _ in range(4):
        before = s
        s = TRAIL_PUNCT.sub("", s)
        s = TRAIL_EMPH.sub("", s)
        s = TRAIL_CELL.sub("", s)
        if s == before:
            break
    s = s.strip()
    return s if FIGURE.match(s) else None


def tokens_in(path):
    """Every (line number, figure) in one document."""
    out = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        tok = figure_on(line)
        if tok:
            out.append((n, tok))
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
    elsewhere at the same time. That was round 12's `E4a`/`E4b`.
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
            "quoted figures: %d documents, %d candidate figures, %d not emitted"
            % (len(docs), seen, len(findings))
        )
    if seen == 0:
        if not quiet:
            print(
                "  INERT: no `key=<number|boolean>` line was found in any document. The "
                "check is measuring nothing, which it must not report as a pass."
            )
        return 2
    for rel, n, tok in findings:
        if not quiet:
            print(
                "  NOT EMITTED: %s:%d reports `%s`, and no instrument or committed "
                "evidence file under the harness emits that string. Either have a case "
                "emit it and paste what it emits, or drop it and keep the claim a case "
                "pins." % (rel, n, tok)
            )
    return 1 if findings else 0


# ── the arms ────────────────────────────────────────────────────────────────
# MUST_CATCH is every shape a challenge round planted a fabricated figure in,
# plus the control. MUST_SKIP is every shape that must NOT be a candidate --
# the named exclusions, and the seven realistic prose lines round 13 measured
# as false positives of the previous design. Both lists are evidence: the first
# is the net, the second is the price of the net, and neither is a claim
# without the other.
MUST_CATCH = [
    ("N0 control: a bare line", "fabricated_count=999"),
    ("R13 leading tab", "\tfabricated_count=999"),
    ("R13 trailing period", "fabricated_count=999."),
    ("R13 thousands separator", "fabricated_count=9,999"),
    ("R13 percent", "fabricated_count=999%"),
    ("R13 trailing semicolon", "fabricated_count=999;"),
    ("R13 blockquote", "> fabricated_count=999"),
    ("R13 list item", "- fabricated_count=999"),
    ("R13 nested list item", "  - fabricated_count=999"),
    ("R13 parentheses", "(fabricated_count=999)"),
    ("R13 trailing comma", "fabricated_count=999,"),
    ("R13 bold", "**fabricated_count=999**"),
    ("R13 HTML comment", "<!-- fabricated_count=999 -->"),
    ("R13 colon prefix", "result: fabricated_count=999"),
    ("R13 table cell", "| fabricated_count=999 |"),
    ("R13-S1 N16 backticked comment", "fabricated_count=999 `-- a note`"),
    ("R12 in a backtick fence", "```\nfabricated_count=999\n```"),
    ("R12 in a tilde fence", "~~~\nfabricated_count=999\n~~~"),
    ("R12 four-space indented", "text:\n\n    fabricated_count=999"),
    ("a decimal figure", "fabricated_ratio=9.99"),
]
MUST_SKIP = [
    ("named: inline code span only", "the value `fabricated_count=999` is quoted in prose"),
    ("named: UPPERCASE key", "FABRICATED_COUNT=999"),
    ("named: prose on the line", "it printed fabricated_count=999 and then stopped"),
    ("R13-S3 p11_repo=/var/tmp/myclone", "p11_repo=/var/tmp/myclone"),
    ("R13-S3 ref=heads/main", "ref=heads/main"),
    ("R13-S3 expect=catalog.foo_invalid", "expect=catalog.foo_invalid"),
    ("R13-S3 kind=refusal", "kind=refusal"),
    ("R13-S3 role=postgres", "role=postgres"),
    ("R13-S3 id=PATCH-REQ-P8-08", "id=PATCH-REQ-P8-08"),
    ("R13-S3 unanimity=agreement", "unanimity=agreement"),
    ("R13-S3 locale=en_US.utf8", "locale=en_US.utf8"),
    ("a quoted SQL fragment", "   WHERE c.relname = 'x'"),
    ("a quoted shell assignment", "P11_SCRATCH=/var/tmp/mine bash x.sh"),
]


def _arm(d, relpath, body):
    """One hermetic world: a synthetic document and a synthetic search root."""
    docs = os.path.join(d, "docs")
    harness = os.path.join(d, "harness")
    os.makedirs(os.path.join(docs, "sub"), exist_ok=True)
    os.makedirs(harness, exist_ok=True)
    open(os.path.join(harness, "fake_proofs.py"), "w", encoding="utf-8").write(
        'case("a", "SELECT 1", "present=true")\n'
    )
    open(os.path.join(d, relpath), "w", encoding="utf-8").write(body + "\n")
    return scan(docs, harness, quiet=True)


def selftest():
    ok = True
    for label, body in MUST_CATCH:
        with tempfile.TemporaryDirectory() as d:
            rc = _arm(d, "docs/a.md", body)
            good = rc == 1
            print(
                "  catch  %-34s rc=%d (want 1) -> %s"
                % (label, rc, "as required" if good else "**SELFTEST FAILED: it escaped**")
            )
            ok = ok and good

    for label, body in MUST_SKIP:
        with tempfile.TemporaryDirectory() as d:
            rc = _arm(d, "docs/a.md", body)
            # No candidate at all is the correct answer here, which is exit 2.
            good = rc == 2
            print(
                "  skip   %-34s rc=%d (want 2) -> %s"
                % (label, rc, "as required" if good else "**SELFTEST FAILED: false positive**")
            )
            ok = ok and good

    with tempfile.TemporaryDirectory() as d:
        rc = _arm(d, "docs/a.md", "present=true")
        print(
            "  pass   %-34s rc=%d (want 0) -> %s"
            % ("an emitted figure", rc, "as required" if rc == 0 else "**SELFTEST FAILED**")
        )
        ok = ok and rc == 0

    with tempfile.TemporaryDirectory() as d:
        rc = _arm(d, "docs/sub/README.md", "fabricated_count=999")
        print(
            "  catch  %-34s rc=%d (want 1) -> %s"
            % ("R12 E4a markdown in a subdirectory", rc, "as required" if rc == 1 else "**SELFTEST FAILED**")
        )
        ok = ok and rc == 1

    # E4b: a fabricated figure in markdown UNDER THE HARNESS must not make the
    # identical token lawful in a scanned document. Round 13 noted, correctly,
    # that this arm puts the synthetic harness beside the synthetic docs, so its
    # README is never scanned: it measures the haystack half only. The scan half
    # is E4a above, and the real tree's geometry -- one file in both roles -- is
    # exercised by the plant driven through `rebuild_and_prove.sh`.
    with tempfile.TemporaryDirectory() as d:
        docs = os.path.join(d, "docs")
        harness = os.path.join(d, "harness")
        os.makedirs(docs)
        os.makedirs(harness)
        open(os.path.join(harness, "fake_proofs.py"), "w", encoding="utf-8").write(
            'case("a", "SELECT 1", "present=true")\n'
        )
        open(os.path.join(harness, "README.md"), "w", encoding="utf-8").write(
            "fabricated_count=999\n"
        )
        open(os.path.join(docs, "a.md"), "w", encoding="utf-8").write("fabricated_count=999\n")
        rc = scan(docs, harness, quiet=True)
        print(
            "  catch  %-34s rc=%d (want 1) -> %s"
            % (
                "R12 E4b a doc is not its own evidence",
                rc,
                "as required" if rc == 1 else "**SELFTEST FAILED**",
            )
        )
        ok = ok and rc == 1

    print(
        "  %d catch arms, %d skip arms, 4 others -- %s"
        % (len(MUST_CATCH), len(MUST_SKIP), "all as required" if ok else "FAILURES ABOVE")
    )
    return 0 if ok else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        raise SystemExit(selftest())
    raise SystemExit(scan(PHASE_DIR, os.path.join(PHASE_DIR, "harness")))
