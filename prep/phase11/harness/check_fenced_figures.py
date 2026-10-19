"""PHASE 11 — the quoted-figure check: every figure a document shows as output
must be emitted by something in this tree.

The file keeps its original name because the documents, the manifest and the
`HARNESS_SHA256` set already carry it, but it has been through four designs,
each one an answer to a challenge round that defeated the last.

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
    **line anchor** -- blockquote, list item, bold, parentheses, trailing
    comma, semicolon, period, percent, thousands separator, HTML comment, colon
    prefix, table cell -- and measured the second design's price in the other
    direction: 7 of 14 realistic prose shapes red the gate. The third design
    narrowed the VALUE and widened the CONTEXT: a figure is a number or a
    boolean, and all decoration is stripped before matching.
  * Round 14 defeated the third design in nine shapes, all of them escapes from
    the **spelling of the value**: Arabic-Indic digits (`٩٩٩`), a zero-width
    space before the value, a full-width `＝`, a sign (`-999`, `+999`), `True`
    and `t` where the class claimed booleans but admitted one spelling of two,
    a hyphen in the key, and a figure behind a `--` marker. A green proof run
    of this phase was produced with three fabricated figures sitting in the
    Arabic report the owner reads. **Patching nine spellings would have left a
    tenth**, as patching eleven prefixes would have left a twelfth and four
    fence syntaxes a fifth, so the fourth design **NORMALISES before matching**
    rather than adding alternatives, and defines the boolean set once, closed.

THE SAME ROUND REJECTED THE COMPLETENESS CLAIM OVER THE GUARDS, which matters
more than any of the nine. The previous header said, in bold, that every guard
in the matcher had been deleted on its own and the arms it reds recorded, and
offered twelve rows. `figure_on()` applied **fourteen** guards: the heading
strip and the trailing `--` strip were load-bearing -- each alone decides a
shape otherwise invisible -- and neither was in the table nor had ever been
deleted, so "no guard reds nothing" was false of the matcher it described. That
is the previous round's finding one level up: there a guard had no red proof,
here the claim OVER the guards had none.

**So the table is no longer written by hand.** `GUARDS` below is the authority:
`figure_on()` applies exactly the guards in it and nothing else, and
`--selftest` DELETES EACH ONE IN TURN and reports which arms stop giving their
required answer. A guard that flips no arm fails the selftest, which the proof
script refuses on, so a guard added without an arm stops the phase instead of
silently widening the net. The row count cannot disagree with the guard count
because there are no rows: the table is computed.

WHAT IT CHECKS. Every `*.md` anywhere under the phase directory, including
subdirectories. A line whose decoration strips away to nothing but
`key=<number|boolean>` is a candidate, and the exact token must appear
somewhere under `prep/phase11/harness/` **excluding markdown** -- in an
instrument or in a committed run-evidence file.

NORMALISATION, in four steps, in this order, each one separately deletable and
separately measured:

  1. **NFKC**, which maps the full-width `＝` and the compatibility forms of
     the digits to their ASCII spellings.
  2. **Format characters deleted** (Unicode category `Cf`), which is where
     U+200B ZERO WIDTH SPACE goes. NFKC does not remove it.
  3. **Arabic-Indic and Extended Arabic-Indic digits mapped to ASCII**, which
     NFKC also does not do: U+0669 has no compatibility decomposition. The
     owner's Arabic report writes every figure he reads in these digits, so
     this is the spelling the documents actually use, not an exotic one.
  4. **The boolean set, closed**: `true`, `false`, `t`, `f`, in any case, and
     nothing else. `t` and `f` are what `psql` prints, which is what these
     documents transcribe, and the previous class claimed booleans while
     admitting one spelling of two.

Steps 1-3 are the same cause as **Phase 6's open `G-A`**, where a mistyped key,
U+200B and U+FF1A are all accepted. Two phases, one cause; raised to the
coordinator rather than solved twice, and `OD-P6-09` stays with the owner.

THE FIGURE AS DISPLAYED. `%` is **not** stripped and is part of the value, so
the token checked is the token shown. The previous design stripped it, which
meant `deleted=0%` was checked as `deleted=0` and passed on a figure no
instrument emits -- the check must not verify a different number from the one a
reader sees. The stripping that remains is not total and the bound is worth
stating: `deleted=0.` still passes on `deleted=0`, because a trailing period is
a sentence ending, while `deleted=0,000` reds.

THE BACKTICK RULE, which round 13 was right about twice over. The previous
design skipped any line containing a backtick. That guard was unmeasured and it
opened an escape in the wrong direction. What replaces it is narrower and is
measured: **inline code spans are removed from the line before matching**, so a
figure written only inside `` `deleted=0` `` is still excluded -- that is prose
quoting a value, and the §16.6 withdrawal note depends on it -- while a bare
figure followed by a backticked comment is caught.

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
  * **Two tokens exempted by exact name**, `port=55512` and `migrations=87`,
    the phase's own scratch port and its own migration count, on the
    coordinator's ruling answering `R14-S2`. This is a SHAPE exemption and it
    carries the known cost of one: it cannot name a token not yet written, and
    a fabricated `migrations=87` now passes. It is two literals, it is listed
    in `EXEMPT` where a reader finds it, and deleting it reds an arm.
  * **The haystack is a substring match over one blob**: a token emitted
    anywhere for any reason passes everywhere, so `identities=2` printed by one
    case legitimises `identities=2` written about another. Narrowing it to the
    emitting case is a convention, not a check.
  * **The second direction of the review arm**, which is not mechanisable here:
    whether a figure that IS emitted is a quantity the moment decides. Nothing
    in a token distinguishes `present=true`, which cannot go stale, from
    `rows=59`, which is true only of an instant. `superuser_sees=130` failed
    both ways; this file catches the first.

THE PRICE, MEASURED AND NOT ESTIMATED. The arm is fail-closed, so its cost is
that a paragraph may have to write a number differently -- but a cost that
stops the work is still a cost, and round 14 found it had moved rather than
shrunk: narrowing the value narrowed the key space while widening the context
widened it back. `--surface` measures it against the REAL harness haystack over
a documented list of realistic shapes and prints the count, so the number in
this header is a command away rather than a sentence:

    python3 -I prep/phase11/harness/check_fenced_figures.py --surface

At the head that introduced this design it prints **8 of 17**: of seventeen
documented figure-shaped lines, eight would red the gate if a document wrote
them, seven pass because something already emits them, and two are the
exempted tokens. Round 14 measured 13 of 16 over ITS OWN list of shapes, which
is not this list; the two numbers are each true of their own set and are not
comparable, and this one is the one a reader can reproduce. The escape hatch
for every red shape is named above -- prose on the line, or an inline code
span -- and neither requires a waiver list, which would move the hole from
shape to time.

AND IT REFUSES TO BE INERT. If the scan finds no candidate at all, the matcher
has stopped matching the documents it is pointed at, and a check that measures
nothing must not report a pass. That is exit 2.

EXITS: 0 clean, 1 a figure nothing emits, 2 inert, 4 invoked without `-I`.

ITS RED PROOFS, in three layers. `--selftest` runs **every shape any round
planted**, each as its own hermetic arm with its expected exit, plus the false
positives round 13 measured as arms that must now come back clean, and then
deletes each guard in turn and requires it to flip an arm; the proof script
runs all of it before the real scan. Pointed at the documents and harness of
`51686d9` -- the head round 10 rejected -- it names both occurrences of
`superuser_sees=130` by file and line and exits 1. And the real
`rebuild_and_prove.sh` refuses at step `0c` on a planted figure, exit 1, with
the refusal text printed, which both the author and the challenger have driven
on their own clones in both directions.

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
    python3 -I prep/phase11/harness/check_fenced_figures.py --surface
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
import unicodedata

PHASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── the decoration, and the spellings ───────────────────────────────────────
# Each pattern here exists because a round planted a figure behind it; none is
# a guess about markdown.
CODE_SPAN = re.compile(r"`[^`]*`")
LEAD_QUOTE = re.compile(r"^[\s>]+")  # blockquote, indentation, leading tab
LEAD_LIST = re.compile(r"^(?:[-*+]|\d+\.)\s+")  # list item, ordered or not
LEAD_HEAD = re.compile(r"^#+\s*")
LEAD_CELL = re.compile(r"^\|\s*")  # table cell
LEAD_PAREN = re.compile(r"^[(\[]+")
LEAD_EMPH = re.compile(r"^[*_]{1,3}")
LEAD_DASH = re.compile(r"^-{2,}\s*")  # a figure written behind a `--` marker
LABEL = re.compile(r"^[A-Za-z][A-Za-z ]{0,30}:\s*")  # `result: deleted=0`
TRAIL_COMMENT = re.compile(r"(?<=\S)\s+--.*$")  # a `--` comment AFTER a figure
TRAIL_EMPH = re.compile(r"[*_]{1,3}$")
TRAIL_CELL = re.compile(r"\|\s*$")
# `%` is deliberately absent: it belongs to the value, not to the decoration.
TRAIL_PUNCT = re.compile(r"[\s.,;:)\]]+$")

# The boolean set, closed. `t` and `f` are what psql prints.
BOOLEANS = ("true", "false", "t", "f")
BOOLEANS_UNNORMALISED = ("true", "false")

# Two tokens exempted by exact name, on the coordinator's R14-S2 ruling.
EXEMPT = ("port=55512", "migrations=87")

# Arabic-Indic (U+0660-0669) and Extended Arabic-Indic (U+06F0-06F9).
ARABIC_DIGITS = {chr(0x0660 + n): str(n) for n in range(10)}
ARABIC_DIGITS.update({chr(0x06F0 + n): str(n) for n in range(10)})

# ── the guards ──────────────────────────────────────────────────────────────
# THIS LIST IS THE AUTHORITY. `figure_on()` applies exactly these and nothing
# else, and `--selftest` deletes each one in turn and requires it to flip an
# arm. There is no hand-written table to disagree with it.
GUARDS = (
    "nfkc",
    "format characters",
    "arabic-indic digits",
    "html comment markers",
    "inline code span",
    "blockquote and indent",
    "list marker",
    "heading marker",
    "table cell (leading)",
    "bracket",
    "emphasis (leading)",
    "dash marker (leading)",
    "label prefix",
    "trailing -- comment",
    "trailing punctuation",
    "emphasis (trailing)",
    "table cell (trailing)",
    "figure value class",
    "boolean spellings",
    "signed values",
    "percent in the value",
    "hyphen in the key",
    "key class",
    "boolean case folding",
    "named exemptions",
)

LEADERS = (
    ("blockquote and indent", LEAD_QUOTE),
    ("list marker", LEAD_LIST),
    ("heading marker", LEAD_HEAD),
    ("table cell (leading)", LEAD_CELL),
    ("bracket", LEAD_PAREN),
    ("emphasis (leading)", LEAD_EMPH),
    ("dash marker (leading)", LEAD_DASH),
)
TRAILERS = (
    ("trailing punctuation", TRAIL_PUNCT),
    ("emphasis (trailing)", TRAIL_EMPH),
    ("table cell (trailing)", TRAIL_CELL),
)


def _is_figure(s, skip=()):
    """Is `s` a bare `key=<number|boolean>`? The narrowest part of the design.

    The ONLY decisions here that are not behind a named guard are that the
    string contains an `=` with text on both sides -- which is not a guard but
    the shape the review arm is about.
    """
    if "=" not in s:
        return False
    key, _, val = s.partition("=")
    if not key or not val:
        return False
    if "key class" not in skip:
        keyre = r"[a-z][a-z0-9_]*" if "hyphen in the key" in skip else r"[a-z][a-z0-9_-]*"
        if not re.fullmatch(keyre, key):
            return False
    if "figure value class" in skip:
        return True
    bools = BOOLEANS_UNNORMALISED if "boolean spellings" in skip else BOOLEANS
    spelled = val if "boolean case folding" in skip else val.lower()
    if spelled in bools:
        return True
    sign = r"" if "signed values" in skip else r"[-+]?"
    pct = r"" if "percent in the value" in skip else r"%?"
    return bool(re.fullmatch(sign + r"[0-9][0-9,._]*" + pct, val))


def _strip(line, skip=()):
    """The line with its decoration and its spellings removed.

    EVERY transformation in this function is behind a named guard, with no
    exception, which is what makes the completeness claim testable rather than
    asserted: with every guard skipped this function is the identity, and
    `--selftest` checks exactly that over a probe of every shape. An
    unconditional transformation -- a case fold, a strip, a new rule added in
    a hurry -- shows up there as a difference, which is how `R14-F1` would
    have been found by the instrument instead of by a reader.
    """
    s = line
    if "nfkc" not in skip:
        s = unicodedata.normalize("NFKC", s)
    if "format characters" not in skip:
        s = "".join(c for c in s if unicodedata.category(c) != "Cf")
    if "arabic-indic digits" not in skip:
        s = "".join(ARABIC_DIGITS.get(c, c) for c in s)
    if "html comment markers" not in skip:
        s = s.replace("<!--", " ").replace("-->", " ")
    # An inline code span is prose quoting a value, so its content goes --
    # which also means a backticked comment cannot shelter a bare figure.
    if "inline code span" not in skip:
        s = CODE_SPAN.sub(" ", s)
    for _ in range(4):  # decoration nests: `> - **x**`
        before = s
        for name, rx in LEADERS:
            if name not in skip:
                s = rx.sub("", s, count=1)
        if s == before:
            break
    if "label prefix" not in skip:
        s = LABEL.sub("", s)
    if "trailing -- comment" not in skip:
        s = TRAIL_COMMENT.sub("", s)
    for _ in range(4):
        before = s
        for name, rx in TRAILERS:
            if name not in skip:
                s = rx.sub("", s, count=1)
        if s == before:
            break
    return s


def figure_on(line, skip=()):
    """The figure this line reports, or None.

    Decoration is not a hiding place and neither is a spelling. `skip` names
    guards to leave out, which is how the selftest measures each one.
    """
    s = _strip(line, skip)
    if not _is_figure(s, skip):
        return None
    if "named exemptions" not in skip and s in EXEMPT:
        return None
    return s


def tokens_in(path, skip=()):
    """Every (line number, figure as written, figure normalised) in one document."""
    out = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        tok = figure_on(line.rstrip("\n"), skip)
        if tok:
            out.append((n, line.strip(), tok))
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


def scan(docs_dir, harness_dir, quiet=False, skip=()):
    """0 = every quoted figure is emitted. 1 = a finding. 2 = inert."""
    haystack = emitted_strings(harness_dir)
    docs = documents(docs_dir)
    seen = 0
    findings = []
    for path in docs:
        rel = os.path.relpath(path, docs_dir)
        for n, raw, tok in tokens_in(path, skip):
            seen += 1
            if tok not in haystack:
                findings.append((rel, n, tok, raw))
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
    for rel, n, tok, raw in findings:
        if not quiet:
            # The normalised token is what was searched for; the line as written
            # is what a reader sees. When they differ, both are reported, because
            # naming only one of them is how a spelling hides.
            written = "" if tok in raw else " (written as `%s`)" % raw
            print(
                "  NOT EMITTED: %s:%d reports `%s`%s, and no instrument or committed "
                "evidence file under the harness emits that string. Either have a case "
                "emit it and paste what it emits, or drop it and keep the claim a case "
                "pins." % (rel, n, tok, written)
            )
    return 1 if findings else 0


# ── the arms ────────────────────────────────────────────────────────────────
# Every shape any round planted a fabricated figure in, each with the exit it
# must produce. `want` 1 = it must be caught; 2 = it must not be a candidate at
# all, which is the inert refusal doing double duty as a negative assertion;
# 0 = a figure that IS emitted must pass.
#
# The `skip` arms are the named exclusions and the seven realistic prose lines
# round 13 measured as false positives of the second design. Both kinds are
# evidence: the first is the net, the second is the price of the net, and
# neither is a claim without the other.
CATCH = [
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
    # R14-F1: the two load-bearing guards that had no arm and no row.
    ("R14-F1 heading", "### fabricated_count=999"),
    ("R14-F1 plain -- comment", "fabricated_count=999 -- a plain comment"),
    # R14-S1: the nine spellings, the challenger's own plants among them.
    ("R14-S1 arabic-indic digits", "fabricated_rows=٩٩٩"),
    ("R14-S1 extended arabic digits", "fabricated_rows=۹۹۹"),
    ("R14-S1 negative", "fabricated_delta=-999"),
    ("R14-S1 positive sign", "fabricated_delta=+999"),
    ("R14-S1 boolean True", "fabricated_flag=True"),
    ("R14-S1 boolean t as psql prints", "fabricated_flag=t"),
    ("R14-S1 boolean f as psql prints", "fabricated_flag=f"),
    ("R14-S1 zero-width space", "fabricated_count=​999"),
    ("R14-S1 full-width equals", "fabricated_count＝999"),
    ("R14-S1 hyphen in the key", "fabricated-count=999"),
    ("R14-S1 behind a -- marker", "-- fabricated_count=999"),
    # R14-S3: the figure checked must be the figure shown.
    ("R14-S3 percent on a real figure", "deleted=0%"),
    ("R14-S3 percent inside brackets", "(deleted=0%)"),
]
SKIP = [
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
    # R14-S2: the two exemptions the coordinator ruled, by exact name.
    ("R14-S2 exempt port=55512", "port=55512"),
    ("R14-S2 exempt migrations=87", "migrations=87"),
]
PASSES = [
    ("an emitted figure", "present=true"),
    ("R14-S3 control: the figure itself", "deleted=0"),
]

# The realistic prose shapes `--surface` measures the price over. Not arms:
# the gate's answer on them is a COST to report, not a requirement to assert.
SURFACE = [
    "port=55512",
    "migrations=87",
    "rows=59",
    "axes=2",
    "variants=6",
    "cases=121",
    "races=13",
    "entries=80",
    "copies=1",
    "attempts=3",
    "deleted=0",
    "present=true",
    "owner_sees=0",
    "chosen=1",
    "identities=2",
    "ratio=0.5",
    "enabled=false",
]


# The probe the identity test runs over: one line per family of decoration and
# per family of spelling, so a transformation left outside `GUARDS` has
# somewhere to show up.
IDENTITY_PROBE = (
    "fabricated_count=999",
    "\tfabricated_count=999 ",
    "> - **fabricated_count=999**, ",
    "| fabricated_count=999 |",
    "### fabricated_count=999",
    "(fabricated_count=999%)",
    "<!-- fabricated_count=999 -->",
    "result: fabricated_count=999 -- a plain comment",
    "-- fabricated_count=999",
    "fabricated_count=999 `-- a note`",
    "fabricated_rows=\u0669\u0669\u0669",
    "fabricated_count=\u200b999",
    "fabricated_count\uff1d999",
    "fabricated_flag=True",
    "fabricated-delta=-999",
    "  ",
)


# The twelve guards §7.13 of the manifest listed, in this file's names. They
# are kept as a NEGATIVE CONTROL: `R14-F1` was that the matcher applied more
# guards than that table named, and the identity test below demonstrates it
# rather than asserting it -- with only these twelve skipped, the stripper is
# still not the identity, and what it still does is what the table missed.
R13_TABLE = (
    "inline code span",
    "blockquote and indent",
    "list marker",
    "table cell (leading)",
    "table cell (trailing)",
    "bracket",
    "emphasis (leading)",
    "emphasis (trailing)",
    "label prefix",
    "trailing punctuation",
    "html comment markers",
    "figure value class",
)
R13_TABLE_MISSED = (
    "### fabricated_count=999",
    "fabricated_count=999 -- a plain comment",
)

SHAPES = (
    ("A B=C D", True),
    ("\u200bX=\u0669", True),
    ("\u200bX\uff1d\u0669", False),  # not an ASCII `=`, so not the shape at all
    ("nothing here", False),
    ("=1", False),
    ("k=", False),
)


def identity_test():
    """With every guard skipped, the stripper must be the IDENTITY.

    This is the executable half of the answer to `R14-F1`. The guard matrix
    proves every NAMED guard is load-bearing; this proves there is no
    UNNAMED one. A transformation outside `GUARDS` cannot be skipped, so it
    still fires here and the probe line comes back changed. `_is_figure` is
    checked the same way: with every guard skipped, the only thing it still
    decides is the shape the arm is about -- an `=` with text on both sides.
    """
    ok = True
    for line in IDENTITY_PROBE:
        got = _strip(line, GUARDS)
        good = got == line
        if not good:
            print(
                "  identity **FAILED**: with every guard skipped, %r became %r, so a "
                "transformation is applied that GUARDS does not name" % (line, got)
            )
        ok = ok and good
    for shape, want in SHAPES:
        got = _is_figure(shape, GUARDS)
        if got != want:
            print(
                "  identity **FAILED**: with every guard skipped, _is_figure(%r) was %r "
                "and should have been %r: the only decision left is the shape itself"
                % (shape, got, want)
            )
            ok = False
    # The negative control: the previous round's twelve-row table, run.
    for line in R13_TABLE_MISSED:
        got = _strip(line, R13_TABLE)
        if got == line:
            print(
                "  identity **FAILED**: %r is unchanged with only the twelve rows of "
                "§7.13 skipped, so this file no longer demonstrates R14-F1" % line
            )
            ok = False
        else:
            print(
                "  control: with ONLY §7.13's twelve rows skipped, %r still becomes "
                "%r -- the two guards that table never named" % (line, got)
            )
    print(
        "  identity: %d probe lines and %d shapes -- %s"
        % (
            len(IDENTITY_PROBE),
            len(SHAPES),
            "with every guard skipped the matcher transforms nothing and decides only "
            "`key=value`" if ok else "FAILURES ABOVE",
        )
    )
    return ok


def _world(d):
    """One hermetic world: a synthetic document tree and a synthetic harness."""
    docs = os.path.join(d, "docs")
    harness = os.path.join(d, "harness")
    os.makedirs(os.path.join(docs, "sub"), exist_ok=True)
    os.makedirs(harness, exist_ok=True)
    open(os.path.join(harness, "fake_proofs.py"), "w", encoding="utf-8").write(
        'case("a", "SELECT 1", "present=true")\n'
        'case("b", "SELECT 2", "deleted=0")\n'
    )
    return docs, harness


def _arm(body, skip=(), relpath="docs/a.md"):
    with tempfile.TemporaryDirectory() as d:
        docs, harness = _world(d)
        open(os.path.join(d, relpath), "w", encoding="utf-8").write(body + "\n")
        return scan(docs, harness, quiet=True, skip=skip)


def _arm_e4b(skip=()):
    """A fabricated figure in markdown UNDER THE HARNESS must not make the same
    token lawful in a scanned document. Round 13 noted, correctly, that this
    arm puts the synthetic harness beside the synthetic docs, so its README is
    never scanned: it measures the haystack half only. The scan half is `E4a`,
    and the real tree's geometry -- one file in both roles -- is exercised by
    the plant driven through `rebuild_and_prove.sh`."""
    with tempfile.TemporaryDirectory() as d:
        docs, harness = _world(d)
        open(os.path.join(harness, "README.md"), "w", encoding="utf-8").write(
            "fabricated_count=999\n"
        )
        open(os.path.join(docs, "a.md"), "w", encoding="utf-8").write("fabricated_count=999\n")
        return scan(docs, harness, quiet=True, skip=skip)


def _arms_with(skip=()):
    """(label, want, runner) for every arm, with `skip` left out of the matcher.

    One list, read by the selftest and by the guard matrix alike, so a guard
    cannot be measured against a different set of arms from the one the
    selftest asserts."""
    arms = [(label, 1, (lambda b=body: _arm(b, skip))) for label, body in CATCH]
    arms += [(label, 2, (lambda b=body: _arm(b, skip))) for label, body in SKIP]
    arms += [(label, 0, (lambda b=body: _arm(b, skip))) for label, body in PASSES]
    arms.append(("R12 E4a markdown in a subdirectory", 1, lambda: _arm("fabricated_count=999", skip, "docs/sub/README.md")))
    arms.append(("R12 E4b a doc is not its own evidence", 1, lambda: _arm_e4b(skip)))
    return arms


def guard_matrix():
    """Delete each guard on its own and report the arms it reds.

    This is the answer to `R14-F1`. The previous design asserted this as prose
    over a hand-written table of twelve rows while the matcher applied
    fourteen guards. Here the table is COMPUTED from `GUARDS`, so a guard
    without an arm cannot hide behind a row that was never written: it flips
    nothing, and the selftest fails.
    """
    ok = True
    print("  -- each guard deleted on its own, and the arms that stop answering --")
    for guard in GUARDS:
        flipped = [label for label, want, run in _arms_with((guard,)) if run() != want]
        good = bool(flipped)
        shown = ", ".join(flipped[:3]) + (" +%d more" % (len(flipped) - 3) if len(flipped) > 3 else "")
        print(
            "  guard  %-24s reds %2d arm(s): %-52s -> %s"
            % (guard, len(flipped), shown, "measured" if good else "**REDS NOTHING: delete it or arm it**")
        )
        ok = ok and good
    print(
        "  %d guards, every one of them deleted and measured -- %s"
        % (len(GUARDS), "none reds nothing" if ok else "FAILURES ABOVE")
    )
    return ok


def selftest():
    ok = True
    for label, want, run in _arms_with():
        rc = run()
        good = rc == want
        kind = {1: "catch ", 2: "skip  ", 0: "pass  "}[want]
        print(
            "  %s %-34s rc=%d (want %d) -> %s"
            % (kind, label, rc, want, "as required" if good else "**SELFTEST FAILED**")
        )
        ok = ok and good
    print(
        "  %d catch arms, %d skip arms, %d pass arms, 2 others -- %s"
        % (len(CATCH), len(SKIP), len(PASSES), "all as required" if ok else "FAILURES ABOVE")
    )
    ok = guard_matrix() and ok
    ok = identity_test() and ok
    return 0 if ok else 1


def surface():
    """The price of the net, measured against the REAL harness haystack.

    For each documented shape: if a document wrote that line, would the gate
    red? Fail-closed, so every one of these is a cost rather than a hole, and
    the escape hatches are named in the header. Reported as a number so the
    header's claim is a command away.
    """
    haystack = emitted_strings(os.path.join(PHASE_DIR, "harness"))
    red = 0
    for shape in SURFACE:
        tok = figure_on(shape)
        if tok is None:
            verdict = "not a candidate (exempted or not a figure)"
        elif tok in haystack:
            verdict = "passes: something emits it"
        else:
            verdict = "REDS THE GATE"
            red += 1
        print("  surface %-20s %s" % (shape, verdict))
    print(
        "  %d of %d realistic figure-shaped lines would red the gate if a document "
        "wrote them" % (red, len(SURFACE))
    )
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        raise SystemExit(selftest())
    if "--surface" in sys.argv[1:]:
        raise SystemExit(surface())
    raise SystemExit(scan(PHASE_DIR, os.path.join(PHASE_DIR, "harness")))
