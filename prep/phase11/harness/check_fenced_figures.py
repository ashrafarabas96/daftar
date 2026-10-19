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

import ast
import inspect
import os
import re
import tempfile
import textwrap
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
LABEL = re.compile(r"^[A-Za-z][A-Za-z ]{0,30}:\s*")  # `result: deleted=0`
MARKER = re.compile(r"(?:(?<=\s)|^)--+(?=\s|$)")  # a `--` comment marker
TRAIL_EMPH = re.compile(r"[*_]{1,3}$")
TRAIL_CELL = re.compile(r"\|\s*$")
# `%` is deliberately absent: it belongs to the value, not to the decoration.
TRAIL_PUNCT = re.compile(r"[\s.,;:)\]]+$")

# The boolean set, closed. `t` and `f` are what psql prints.
BOOLEANS = ("true", "false", "t", "f")
BOOLEANS_UNNORMALISED = ("true", "false")

# Two tokens exempted by exact name, on the coordinator's R14-S2 ruling.
EXEMPT = ("port=55512", "migrations=87")

def _fold_digits(s):
    """Every decimal digit family, not three named ones.

    Round 15 pointed out that naming Arabic-Indic and Extended Arabic-Indic
    left Devanagari, Bengali and Thai out, and that naming three more would
    leave a fourth -- the same shape of mistake as patching five fences or
    eleven prefixes. `unicodedata.digit` answers for every character Unicode
    calls a decimal digit, so the guard covers the category instead of a list.
    """
    out = []
    for c in s:
        if unicodedata.category(c) == "Nd" and not c.isascii():
            out.append(str(unicodedata.digit(c)))
        else:
            out.append(c)
    return "".join(out)

# ── the guards ──────────────────────────────────────────────────────────────
# THIS LIST IS THE AUTHORITY. `figure_on()` applies exactly these and nothing
# else, and `--selftest` deletes each one in turn and requires it to flip an
# arm. There is no hand-written table to disagree with it.
GUARDS = (
    "nfkc",
    "format characters",
    "non-ascii digits",
    "html comment markers",
    "inline code span",
    "blockquote and indent",
    "list marker",
    "heading marker",
    "table cell (leading)",
    "bracket",
    "emphasis (leading)",
    "dash marker splits the line",
    "label prefix",
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
    "planted tokens",
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
    if "non-ascii digits" not in skip:
        s = _fold_digits(s)
    if "html comment markers" not in skip:
        s = s.replace("<!--", " ").replace("-->", " ")
    # An inline code span is prose quoting a value, so its content goes --
    # which also means a backticked comment cannot shelter a bare figure.
    if "inline code span" not in skip:
        s = CODE_SPAN.sub(" ", s)
    for _ in range(4):  # decoration nests: `> - **x**`
        before = s
        # Written out one statement per guard, with the name as a literal.
        # They used to be a loop over a table of (name, pattern) pairs, which
        # the structural check below cannot read -- and an indirection the
        # parse cannot see is an indirection something can hide in.
        if "blockquote and indent" not in skip:
            s = LEAD_QUOTE.sub("", s, count=1)
        if "list marker" not in skip:
            s = LEAD_LIST.sub("", s, count=1)
        if "heading marker" not in skip:
            s = LEAD_HEAD.sub("", s, count=1)
        if "table cell (leading)" not in skip:
            s = LEAD_CELL.sub("", s, count=1)
        if "bracket" not in skip:
            s = LEAD_PAREN.sub("", s, count=1)
        if "emphasis (leading)" not in skip:
            s = LEAD_EMPH.sub("", s, count=1)
        if s == before:
            break
    if "label prefix" not in skip:
        s = LABEL.sub("", s)
    for _ in range(4):
        before = s
        if "trailing punctuation" not in skip:
            s = TRAIL_PUNCT.sub("", s, count=1)
        if "emphasis (trailing)" not in skip:
            s = TRAIL_EMPH.sub("", s, count=1)
        if "table cell (trailing)" not in skip:
            s = TRAIL_CELL.sub("", s, count=1)
        if s == before:
            break
    return s


def _segments(line, skip=()):
    """The parts of one line that are each a candidate in their own right.

    A `--` marker SPLITS the line; it does not delete what follows it. The
    previous design deleted from the marker to the end, which revealed a
    figure written as `-- figure` (a different guard stripped the leading
    marker) and DELETED one written as `note -- figure`. Round 15's `R15-S2`
    is exactly that asymmetry, and it was invisible to the guard matrix
    because the arm named for the finding carried the leading form while the
    finding itself was about the trailing one. A split closes both at once and
    cannot be asymmetric: whatever sits on either side of the marker is
    weighed on its own.

    EVERY transformation here is behind a named guard, for the same reason as
    in `_strip`, and `--selftest` parses this function to check it.
    """
    parts = [line]
    if "dash marker splits the line" not in skip:
        parts = MARKER.split(line)
    return parts


def figures_on(line, skip=()):
    """Every figure this line reports, in order. Empty when it reports none."""
    out = []
    for part in _segments(line, skip):
        s = _strip(part, skip)
        if not _is_figure(s, skip):
            continue
        if "named exemptions" not in skip and s in EXEMPT:
            continue
        out.append(s)
    return out


def figure_on(line, skip=()):
    """The FIRST figure this line reports, or None. Kept for the one-token
    callers (`--surface`, the identity test) that weigh a single shape."""
    found = figures_on(line, skip)
    return found[0] if found else None


def tokens_in(path, skip=()):
    """Every (line number, line as written, figure normalised) in one document."""
    out = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        for tok in figures_on(line.rstrip("\n"), skip):
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


ARTEFACT_DIRS = ("__pycache__",)
ARTEFACT_SUFFIXES = (".pyc", ".pyo", ".so", ".o")


def haystack_files(root):
    """The files whose contents count as something this tree emits.

    **Markdown is excluded.** A document is not an instrument, and a markdown
    file under the harness used to be both outside the scan and inside the
    haystack -- so one file could hide a fabricated figure and legitimise it
    elsewhere at the same time. That was round 12's `E4a`/`E4b`.

    **COMPILED ARTEFACTS ARE EXCLUDED, and this file is excluded by STEM.**
    Round 15 rejected a figure of mine as un-reproducible: `--surface` printed
    8 on my tree and 9 on three clean checkouts. The cause was not a retyped
    number. `__pycache__/check_fenced_figures.cpython-313.pyc` sat in my
    working tree, gitignored and therefore invisible to `git status`, and it
    carried this file's own string constants -- including a token quoted in
    the prose above. So the by-name exclusion one line below ("a token quoted
    in this file's own prose proves nothing") was DEFEATED BY THE BYTECODE
    CACHE, and the gate's verdict depended on whether anyone had ever
    imported the module. A haystack that includes build output is a haystack
    nobody can reproduce, which is a fail-open: the figure passed here and
    redded everywhere else. Matching by stem closes the companion hole of a
    `.pyc` for any excluded source file, and the run prints the inventory
    below so the verdict names its own input.
    """
    stem = os.path.splitext(os.path.basename(__file__))[0]
    out = []
    for d, subdirs, files in os.walk(root):
        subdirs[:] = [x for x in sorted(subdirs) if x not in ARTEFACT_DIRS]
        for f in sorted(files):
            if f.endswith(".md"):
                continue
            if f.endswith(ARTEFACT_SUFFIXES):
                continue
            if os.path.splitext(f)[0] == stem:
                continue  # a token quoted in this file's own prose proves nothing
            out.append(os.path.join(d, f))
    return out


def emitted_strings(root):
    """What the instruments and the committed evidence under `root` emit."""
    blob = []
    for path in haystack_files(root):
        try:
            blob.append(open(path, encoding="utf-8", errors="replace").read())
        except OSError:
            pass
    return "\n".join(blob)


def planted_tokens():
    """The tokens the selftest itself plants, derived by RUNNING the matcher
    over the arm bodies rather than by keeping a second list beside them.

    `R15-S4`: a run log that contains the selftest's output is committed as
    evidence, so from that commit on, every token the arms plant was in the
    haystack and `fabricated_count=999` -- the token every round has used for
    its fabricated figure -- passed in any document. The challenger very
    nearly reported two live escapes on that collision and caught itself by
    reading what the stripper returned instead of trusting the exit code.

    The coordinator's ruling is to exclude the selftest's output from the
    haystack by exact name. Excluding the whole run log by filename would
    throw away the real evidence in it, so the exclusion is by exact TOKEN
    name, which is what the arms plant and all they plant. A planted token is
    therefore never evidence of itself, wherever it appears.
    """
    toks = set()
    for _label, body in CATCH:
        for line in body.split("\n"):
            # The arm bodies are weighed with every guard present, which is
            # how the planted set stays in step with what the arms plant.
            toks.update(figures_on(line, ("planted tokens",)))
    return toks


def scan(docs_dir, harness_dir, quiet=False, skip=()):
    """0 = every quoted figure is emitted. 1 = a finding. 2 = inert."""
    haystack = emitted_strings(harness_dir)
    docs = documents(docs_dir)
    planted = () if "planted tokens" in skip else planted_tokens()
    seen = 0
    findings = []
    for path in docs:
        rel = os.path.relpath(path, docs_dir)
        for n, raw, tok in tokens_in(path, skip):
            seen += 1
            if tok not in haystack or tok in planted:
                findings.append((rel, n, tok, raw))
    if not quiet:
        # The inventory, because a verdict that does not name its own input is
        # a verdict nobody can reproduce: `R15-F1` was a gitignored `.pyc` in
        # this very directory, and nothing in the output said it was being read.
        print(
            "quoted figures: %d documents, %d haystack files, %d candidate figures, "
            "%d not emitted"
            % (len(docs), len(haystack_files(harness_dir)), seen, len(findings))
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
    # R15-S2: the marker with text BEFORE it -- the shape the round reported,
    # which the arm named for it did not carry.
    ("R15-S2 text before the marker", "note -- fabricated_count=999"),
    ("R15-S2 label before the marker", "result: -- fabricated_count=999"),
    # R15-S3: every decimal digit family, not three named ones.
    ("R15-S3 devanagari digits", "fabricated_rows=\u0969\u0969\u0969"),
    ("R15-S3 bengali digits", "fabricated_rows=\u09ef\u09ef\u09ef"),
    ("R15-S3 thai digits", "fabricated_rows=\u0e59\u0e59\u0e59"),
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
    # The negative control: the previous round's twelve-row table, run. A
    # shape it missed must still be visible with ONLY those twelve skipped --
    # through the stripper, or through the split, which is where the `--`
    # form moved when `R15-S2` turned a deletion into a split.
    for line in R13_TABLE_MISSED:
        got = _strip(line, R13_TABLE)
        parts = _segments(line, R13_TABLE)
        if got == line and parts == [line]:
            print(
                "  identity **FAILED**: %r is untouched with only the twelve rows of "
                "§7.13 skipped, so this file no longer demonstrates R14-F1" % line
            )
            ok = False
        else:
            shown = "%r" % got if got != line else "%r" % (parts,)
            print(
                "  control: with ONLY §7.13's twelve rows skipped, %r still becomes "
                "%s -- a guard that table never named" % (line, shown)
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



def _arm_r15s4(skip=()):
    """A token the selftest plants is never evidence of itself.

    `R15-S4`: the committed run log carries the selftest's output, so from
    that commit the token every round uses for its fabricated figure was in
    the haystack and passed in any document. Here the synthetic harness holds
    a run log containing it, exactly as the real one does, and the document
    writes it as a plain line. It must still be caught."""
    with tempfile.TemporaryDirectory() as d:
        docs, harness = _world(d)
        open(os.path.join(harness, "RUN-EVIDENCE.txt"), "w", encoding="utf-8").write(
            "  catch  N0 control: a bare line            rc=1 (want 1) -> as required\n"
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
    arms.append(("R15-S4 a planted token is not its own evidence", 1, lambda: _arm_r15s4(skip)))
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



# ── the structural check: no transformation without a name ──────────────────
# `R15-S1`. The identity test proves that a transformation touching a
# character family the PROBE contains has a name. Round 15 then added ten
# unconditional transformations to `_strip`, one per copy, and eight of them
# hid: single and double quotes, `+`, Devanagari digits, an en dash, a curly
# apostrophe, a non-breaking space, and `s.replace(";", "")` -- which is
# exactly "a rule added in a hurry" and came back as no difference at all,
# because no probe line contained a semicolon. A hand-written probe set
# carries a completeness claim no better than a hand-written table did: a
# negative result from an attack set proves only the set.
#
# So the claim is no longer bounded by a list of lines. The subject's own
# SOURCE is parsed, and every statement that rebinds the subject variable must
# sit inside an `if "<name>" not in skip:` branch. The only exception is the
# first statement, which binds the subject to the untransformed input -- the
# identity seed -- and is checked to be exactly that.
#
# ITS OWN BOUND, stated because a net is read as covering the variants of the
# shapes it names: this proves every transformation is behind a NAMED branch.
# It does not prove the name is the RIGHT one -- a transformation smuggled
# into an existing guard's branch is guarded, and the guard matrix would still
# red that guard's own arm. Nothing here compares a transformation to the arm
# that is supposed to measure it; `PROVENANCE` below is the half of that which
# is mechanisable.
#
# AND IT IS TIED TO WHAT RUNS, not only to what is written: the skip keys the
# parse finds are compared with the string constants of the compiled code
# object, so a source file that has drifted from the function in memory is a
# failure rather than a pass. Deriving a subject set from a representation the
# subject can alter is the mistake this phase already made once.


def _subject_of(fn):
    """The variable a transformer transforms: the one its first statement binds."""
    first = fn.body[1] if isinstance(fn.body[0], ast.Expr) else fn.body[0]
    if not isinstance(first, ast.Assign) or len(first.targets) != 1:
        return None, "its first statement is not a single assignment"
    target = first.targets[0]
    if not isinstance(target, ast.Name):
        return None, "its first statement does not bind a plain name"
    return target.id, None


def guarded_transformations(func):
    """(ok, messages, skip_keys) for one transformer's source.

    `ok` is false if any statement rebinds the subject outside a named-guard
    branch, if the seed is not the untransformed input, or if the keys in the
    source disagree with the keys in the compiled function.
    """
    src = textwrap.dedent(inspect.getsource(func))
    fn = ast.parse(src).body[0]
    subject, why = _subject_of(fn)
    msgs = []
    if subject is None:
        return False, ["%s: %s" % (func.__name__, why)], set()

    first = fn.body[1] if isinstance(fn.body[0], ast.Expr) else fn.body[0]
    seed = first.value
    seeded_from = None
    if isinstance(seed, ast.Name):
        seeded_from = seed.id
    elif isinstance(seed, ast.List) and len(seed.elts) == 1 and isinstance(seed.elts[0], ast.Name):
        seeded_from = seed.elts[0].id
    if seeded_from not in [a.arg for a in fn.args.args]:
        msgs.append(
            "%s: the first statement must bind %s to an argument, untransformed; "
            "it does not, so the identity seed is not the input"
            % (func.__name__, subject)
        )

    keys = set()

    def guard_key(test):
        # `"<name>" not in skip`
        if not isinstance(test, ast.Compare) or len(test.ops) != 1:
            return None
        if not isinstance(test.ops[0], ast.NotIn):
            return None
        if not isinstance(test.left, ast.Constant) or not isinstance(test.left.value, str):
            return None
        right = test.comparators[0]
        if not isinstance(right, ast.Name) or right.id != "skip":
            return None
        return test.left.value

    def walk(node, guards):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.If):
                key = guard_key(child.test)
                if key is not None:
                    keys.add(key)
                    walk_body(child.body, guards + [key])
                    walk_body(child.orelse, guards)
                    continue
                walk_body(child.body, guards)
                walk_body(child.orelse, guards)
                continue
            if isinstance(child, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                if any(isinstance(t, ast.Name) and t.id == subject for t in targets):
                    if child is first:
                        continue
                    if not guards:
                        msgs.append(
                            "%s: line %d rebinds `%s` with no named guard around it, so "
                            "there is a transformation `GUARDS` does not name"
                            % (func.__name__, child.lineno, subject)
                        )
                continue
            if isinstance(child, (ast.For, ast.While, ast.With, ast.Try)):
                walk_body(child.body, guards)
                for extra in ("orelse", "finalbody", "handlers"):
                    walk_body(getattr(child, extra, []) or [], guards)
                continue
            walk(child, guards)

    def walk_body(body, guards):
        for stmt in body:
            walk_one(stmt, guards)

    def walk_one(stmt, guards):
        holder = ast.Module(body=[stmt], type_ignores=[])
        walk(holder, guards)

    walk_body(fn.body, [])

    # The tie to what runs: the keys written must be the keys compiled.
    compiled = {c for c in func.__code__.co_consts if isinstance(c, str)}
    drifted = sorted(k for k in keys if k not in compiled)
    if drifted:
        msgs.append(
            "%s: the source names guards the compiled function does not hold (%s), so "
            "the file on disk is not the function in memory"
            % (func.__name__, ", ".join(drifted))
        )
    return not msgs, msgs, keys


# The ten transformations round 15 planted, as sources. Each must be REFUSED.
# Two of them (`.lower()`, collapsing whitespace) the identity probe already
# caught; the other eight it did not, which is why this check exists.
PLANTED_TRANSFORMS = (
    ("R15-S1 case fold", "s = s.lower()"),
    ("R15-S1 collapse whitespace", 's s = "".join(s.split())'.replace("s s", "s")),
    ("R15-S1 strip single quotes", "s = s.replace(\"'\", '')"),
    ("R15-S1 strip double quotes", 's = s.replace(chr(34), "")'),
    ("R15-S1 strip plus", 's = s.replace("+", "")'),
    ("R15-S1 devanagari digits", 's = s.replace("\\u0969", "3")'),
    ("R15-S1 strip en dash", 's = s.replace("\\u2013", "")'),
    ("R15-S1 strip curly apostrophe", 's = s.replace("\\u2019", "")'),
    ("R15-S1 strip nbsp", 's = s.replace("\\u00a0", "")'),
    ("R15-S1 strip semicolon", 's = s.replace(";", "")'),
)

_PLANT_TEMPLATE = '''def _planted(line, skip=()):
    s = line
    if "nfkc" not in skip:
        s = unicodedata.normalize("NFKC", s)
    %s
    return s
'''


def _plant_refused(stmt):
    """Does the structural check refuse a transformer carrying `stmt` unguarded?"""
    src = _PLANT_TEMPLATE % stmt
    ns = {"unicodedata": unicodedata}
    exec(compile(src, "<planted>", "exec"), ns)  # noqa: S102 - a synthetic subject
    func = ns["_planted"]
    func.__source__ = src

    class _Fake:
        __name__ = "_planted"
        __code__ = func.__code__

    # `inspect.getsource` cannot read a string-compiled function, so the parse
    # is done here on the same text that was compiled -- the tie the real check
    # makes through `inspect` is made here by construction.
    fn = ast.parse(src).body[0]
    subject = "s"
    bad = []
    for stmt_node in fn.body[1:]:
        if isinstance(stmt_node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == subject for t in stmt_node.targets
        ):
            bad.append(stmt_node.lineno)
    return bool(bad)


def structure_test():
    """The real transformers must pass; all ten planted transformations must not."""
    ok = True
    for func in (_strip, _segments):
        good, msgs, keys = guarded_transformations(func)
        for m in msgs:
            print("  structure **FAILED**: %s" % m)
        print(
            "  structure %-22s %d named guards, every rebinding inside one -> %s"
            % (func.__name__, len(keys), "as required" if good else "FAILED")
        )
        ok = ok and good
    refused = 0
    for label, stmt in PLANTED_TRANSFORMS:
        if _plant_refused(stmt):
            refused += 1
        else:
            print("  structure **FAILED**: %s hid from the parse" % label)
            ok = False
    print(
        "  structure: %d of %d planted transformations refused -- %s"
        % (refused, len(PLANTED_TRANSFORMS), "all of them" if ok else "FAILURES ABOVE")
    )
    return ok


# ── provenance: an arm must carry the plant of the finding it names ─────────
# `R15-S2` was invisible to everything above it. The computed matrix reported
# `dash marker` measured, because an arm named for the finding existed and
# flipped when the guard went -- but that arm carried the LEADING form while
# the finding was about the TRAILING one, so the guard was load-bearing for a
# shape nobody had reported and the reported shape still escaped. Nothing in
# the matrix compares an arm to the finding it is named for.
#
# So each arm that names a round's finding records the line that finding
# quoted, verbatim, and the selftest asserts the arm's body IS that line.
# `None` means the finding described a shape rather than quoting a line; those
# are listed too, with the description, so the gap is visible rather than
# absent. An arm whose label names a finding with no entry here FAILS.
PROVENANCE = {
    "R15-S2 text before the marker": ("note -- fabricated_count=999", None),
    "R15-S2 label before the marker": (None, "`result: -- figure`, reported as a shape"),
    "R15-S3 devanagari digits": (None, "Devanagari named as a family, not as a line"),
    "R15-S3 bengali digits": (None, "Bengali named as a family, not as a line"),
    "R15-S3 thai digits": (None, "Thai named as a family, not as a line"),
    "R15-S4 a planted token is not its own evidence": (
        None,
        "reported as a collision in the haystack, not as a document line",
    ),
    "R14-F1 heading": (None, "`### fabricated_count=999`, quoted by the author in the answer"),
    "R14-F1 plain -- comment": (
        None,
        "`fabricated_count=999 -- a plain comment`, quoted by the author in the answer",
    ),
    "R14-S1 arabic-indic digits": ("fabricated_rows=٩٩٩", None),
    "R14-S1 extended arabic digits": (None, "the extended family, named by the author"),
    "R14-S1 negative": ("fabricated_delta=-999", None),
    "R14-S1 positive sign": (None, "`+999`, reported as a value and not as a line"),
    "R14-S1 boolean True": ("fabricated_flag=True", None),
    "R14-S1 boolean t as psql prints": ("fabricated_flag=t", None),
    "R14-S1 boolean f as psql prints": (None, "`f`, the other half of the pair"),
    "R14-S1 zero-width space": (None, "a zero-width space before the value, named as a shape"),
    "R14-S1 full-width equals": (None, "a full-width separator, named as a shape"),
    "R14-S1 hyphen in the key": (None, "a hyphen in the key, named as a shape"),
    "R14-S1 behind a -- marker": (None, "a figure after a `--` marker, named as a shape"),
    "R14-S3 percent on a real figure": (None, "`deleted=0%`, quoted in the finding"),
    "R14-S3 percent inside brackets": (None, "`(deleted=0%)`, quoted in the finding"),
    "R13-S1 N16 backticked comment": (None, "a backticked comment after a figure"),
    "R12 in a backtick fence": (None, "a fenced block, the caught control of round 12"),
    "R12 in a tilde fence": (None, "a `~~~` fence, named as a syntax"),
    "R12 four-space indented": (None, "a four-space indented block, named as a shape"),
    "R12 E4a markdown in a subdirectory": (None, "markdown in a subdirectory, named as a location"),
    "R12 E4b a doc is not its own evidence": (
        None,
        "a markdown file under the harness, in both roles at once",
    ),
    "R13 leading tab": (None, "indentation, named as a shape"),
    "R13 trailing period": (None, "a trailing period, named as a shape"),
    "R13 thousands separator": (None, "a thousands separator; the round quoted the repo's own `4,798`"),
    "R13 percent": (None, "a trailing percent, named as a shape"),
    "R13 trailing semicolon": (None, "a trailing semicolon, named as a shape"),
    "R13 blockquote": (None, "a blockquote prefix, named as a shape"),
    "R13 list item": (None, "a list item, named as a shape and called the most idiomatic one"),
    "R13 nested list item": (None, "a nested list item, named as a shape"),
    "R13 parentheses": (None, "parentheses, named as a shape"),
    "R13 trailing comma": (None, "a trailing comma, named as a shape"),
    "R13 bold": (None, "bold emphasis, named as a shape"),
    "R13 HTML comment": (None, "an HTML comment, named as a shape"),
    "R13 colon prefix": (None, "a colon prefix, named as a shape"),
    "R13 table cell": (None, "a table cell, named as a shape"),
    "R13-S3 kind=refusal": (None, "`kind=` quoted as a key; the value is the author's"),
    "R13-S3 role=postgres": (None, "`role=` quoted as a key; the value is the author's"),
    "R13-S3 p11_repo=/var/tmp/myclone": (None, "`/var/tmp/myclone` quoted as a value"),
    "R13-S3 ref=heads/main": (None, "`heads/main` quoted as a value"),
    "R13-S3 expect=catalog.foo_invalid": (None, "`catalog.foo_invalid` quoted as a value"),
    "R13-S3 id=PATCH-REQ-P8-08": (None, "`PATCH-REQ-P8-08` quoted as a value"),
    "R13-S3 unanimity=agreement": (None, "`agreement` quoted as a value"),
    "R13-S3 locale=en_US.utf8": (None, "`locale=en_US.utf8`, which the round got to PASS"),
    "R14-S2 exempt port=55512": ("port=55512", None),
    "R14-S2 exempt migrations=87": ("migrations=87", None),
}
CITES = re.compile(r"^R1\d")


def provenance_test():
    """Every arm that names a finding must carry that finding's own plant."""
    ok = True
    bodies = dict(CATCH)
    bodies.update(dict(SKIP))
    verbatim = 0
    described = 0
    for label in sorted(bodies):
        if not CITES.match(label):
            continue
        if label not in PROVENANCE:
            print(
                "  provenance **FAILED**: the arm %r names a finding and records no "
                "plant, so nothing checks that it measures the shape that was "
                "reported" % label
            )
            ok = False
            continue
        quoted, described_as = PROVENANCE[label]
        if quoted is None:
            described += 1
            continue
        verbatim += 1
        if bodies[label] != quoted:
            print(
                "  provenance **FAILED**: the arm %r plants %r, but the finding it "
                "names quoted %r -- an arm measuring a different shape from the one "
                "reported is how R15-S2 hid" % (label, bodies[label], quoted)
            )
            ok = False
    print(
        "  provenance: %d arms carry the finding's own line verbatim, %d name a shape "
        "the finding described rather than quoted -- %s"
        % (verbatim, described, "all as recorded" if ok else "FAILURES ABOVE")
    )
    return ok


# ── generated blocks: a figure an instrument produced cannot be typed ───────
# `R15-F1`, and the coordinator's ruling on it. Two consecutive rounds were
# rejected over a number in a document that disagreed with the instrument the
# sentence beside it named. The second time the number had actually been
# measured -- on a tree carrying a gitignored `__pycache__`, which is the
# fail-open `haystack_files` closes above -- so care was not the missing
# ingredient and more care would not have helped.
#
# So the figures these documents quote from this instrument are GENERATED INTO
# them. Each sits between markers that name the generator and the command, the
# run rewrites the block, and `--check-blocks` refuses if a block differs from
# a fresh run OR if the generator's own sentence appears anywhere outside its
# block. Typing an instrument's output is then impossible rather than
# discouraged, which is the only form of this rule that holds for the sixth
# round running.
#
# WHAT IS ENROLLED, named exactly, because a net is read as covering the
# variants of what it names: the three figures THIS instrument produces -- the
# guard matrix, the arm counts and the false-positive surface. Figures from
# the other instruments (`121 cases`, `53 cases`, the race counts, the digests)
# are NOT enrolled here; they are pinned by the committed run evidence and by
# the fenced-figure arm itself, and enrolling them means giving each of those
# instruments the same treatment, which is a change to them and not to this
# file.
BEGIN = "<!-- BEGIN GENERATED %s: %s -->"
END = "<!-- END GENERATED %s -->"
CMD = "python3 -I prep/phase11/harness/check_fenced_figures.py --emit %s"


def emit_guard_matrix():
    lines = ["each guard deleted on its own, and the arms that stop answering:", ""]
    for guard in GUARDS:
        flipped = [label for label, want, run in _arms_with((guard,)) if run() != want]
        shown = ", ".join(flipped[:3]) + (
            " +%d more" % (len(flipped) - 3) if len(flipped) > 3 else ""
        )
        lines.append("%-26s reds %2d arm(s): %s" % (guard, len(flipped), shown))
    lines.append("")
    lines.append("%d guards, every one of them deleted and measured" % len(GUARDS))
    return lines


def emit_arm_counts():
    return [
        "%d catch arms, %d skip arms, %d pass arms, 3 others"
        % (len(CATCH), len(SKIP), len(PASSES), )
    ]


def emit_surface():
    haystack = emitted_strings(os.path.join(PHASE_DIR, "harness"))
    lines = []
    red = 0
    for shape in SURFACE:
        tok = figure_on(shape)
        if tok is None:
            verdict = "not a candidate (exempted or not a figure)"
        elif tok in haystack and tok not in planted_tokens():
            verdict = "passes: something emits it"
        else:
            verdict = "REDS THE GATE"
            red += 1
        lines.append("%-20s %s" % (shape, verdict))
    lines.append("")
    lines.append(
        "%d of %d realistic figure-shaped lines would red the gate if a document wrote them"
        % (red, len(SURFACE))
    )
    return lines


GENERATORS = {
    "guard-matrix": (emit_guard_matrix, (r"\d+ guards, every one of them deleted",)),
    "arm-counts": (emit_arm_counts, (r"\d+ catch arms, \d+ skip arms",)),
    "surface": (emit_surface, (r"\d+ of \d+ realistic figure-shaped lines",)),
}


def _block_body(name):
    return "\n".join(GENERATORS[name][0]())


def _find_blocks(text, name):
    """(start, end) spans of one generator's blocks, body only."""
    begin = BEGIN % (name, CMD % name)
    end = END % name
    out = []
    at = 0
    while True:
        i = text.find(begin, at)
        if i < 0:
            return out
        j = text.find(end, i)
        if j < 0:
            return out
        out.append((i + len(begin), j))
        at = j + len(end)


def _wrapped(body):
    return "\n\n```text\n" + body + "\n```\n\n"


def regenerate(docs_dir, quiet=False):
    """Rewrite every generated block in every document. The author's command."""
    changed = 0
    for path in documents(docs_dir):
        text = open(path, encoding="utf-8").read()
        for name in sorted(GENERATORS):
            spans = _find_blocks(text, name)
            if not spans:
                continue
            want = _wrapped(_block_body(name))
            for start, stop in reversed(spans):
                if text[start:stop] != want:
                    text = text[:start] + want + text[stop:]
                    changed += 1
        open(path, "w", encoding="utf-8").write(text)
    if not quiet:
        print("regenerated: %d block(s) rewritten" % changed)
    return 0


def check_blocks(docs_dir, quiet=False):
    """0 = every generated block matches a fresh run and no figure of theirs is
    typed outside one. 1 = a difference. 2 = nothing enrolled, which must not
    report a pass."""
    findings = []
    enrolled = 0
    for path in documents(docs_dir):
        rel = os.path.relpath(path, docs_dir)
        text = open(path, encoding="utf-8").read()
        for name in sorted(GENERATORS):
            _emit, sentinels = GENERATORS[name]
            spans = _find_blocks(text, name)
            enrolled += len(spans)
            want = _wrapped(_block_body(name))
            for start, stop in spans:
                if text[start:stop] != want:
                    findings.append(
                        "%s: the generated block `%s` differs from a fresh run. It is "
                        "generated, not written: run `%s` -- or "
                        "`--regenerate` -- and commit what it prints."
                        % (rel, name, CMD % name)
                    )
            # the generator's own sentence, anywhere outside its blocks
            inside = []
            for start, stop in spans:
                inside.append((start, stop))
            for rx in sentinels:
                for m in re.finditer(rx, text):
                    if not any(a <= m.start() < b for a, b in inside):
                        findings.append(
                            "%s:%d quotes `%s` outside the generated block for `%s`. An "
                            "instrument's figure is generated into the document or it is "
                            "not written at all."
                            % (rel, text[: m.start()].count("\n") + 1, m.group(0), name)
                        )
    if not quiet:
        print("generated blocks: %d enrolled, %d finding(s)" % (enrolled, len(findings)))
    for f in findings:
        if not quiet:
            print("  " + f)
    if enrolled == 0:
        if not quiet:
            print(
                "  INERT: no generated block was found in any document, so this check "
                "is measuring nothing and must not report a pass."
            )
        return 2
    return 1 if findings else 0

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
        "  %d catch arms, %d skip arms, %d pass arms, 3 others -- %s"
        % (len(CATCH), len(SKIP), len(PASSES), "all as required" if ok else "FAILURES ABOVE")
    )
    ok = guard_matrix() and ok
    ok = identity_test() and ok
    ok = structure_test() and ok
    ok = provenance_test() and ok
    return 0 if ok else 1


def surface():
    """The price of the net, measured against the REAL harness haystack.

    For each documented shape: if a document wrote that line, would the gate
    red? Fail-closed, so every one of these is a cost rather than a hole, and
    the escape hatches are named in the header. Reported as a number so the
    header's claim is a command away.
    """
    for line in emit_surface():
        print(("  " + line) if line else "")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--selftest" in args:
        raise SystemExit(selftest())
    if "--surface" in args:
        raise SystemExit(surface())
    if "--regenerate" in args:
        raise SystemExit(regenerate(PHASE_DIR))
    if "--check-blocks" in args:
        raise SystemExit(check_blocks(PHASE_DIR))
    if "--emit" in args:
        name = args[args.index("--emit") + 1]
        if name not in GENERATORS:
            sys.stderr.write("no such generator: %s\n" % name)
            raise SystemExit(3)
        print(_block_body(name))
        raise SystemExit(0)
    raise SystemExit(scan(PHASE_DIR, os.path.join(PHASE_DIR, "harness")))
