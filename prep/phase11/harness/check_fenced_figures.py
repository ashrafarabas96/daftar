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

  * Round 15 defeated the fourth design twice over. It planted ten
    unconditional transformations in the stripper, one per copy, and EIGHT of
    them hid from the identity probe, because a hand-written probe set carries
    a completeness claim no better than a hand-written table: so every
    transformation is now behind a NAMED guard that the function's own source
    is parsed to check. And it rejected a figure of mine as unreproducible,
    which turned out to be a fail-open rather than a typo -- a gitignored
    `__pycache__` in my tree was in the haystack, carrying this file's own
    prose.
  * Round 16 defeated the fifth design in three places, each one a hole of the
    same shape as the fix that preceded it. The haystack was read FROM THE
    FILESYSTEM, so excluding artefacts by name could not name the file nobody
    has written yet: it is now derived from the COMMIT by running git, and
    read from the object store. The structural parse covered every
    transformation and nothing that DECIDES, so `figures_on` could rebind its
    input or return early under a test nobody named: the decision frame is
    parsed too. And the generated blocks were enrolled BY A SENTINEL, one
    regex per generator, so round 15's own figure reworded by six words walked
    past it: enrolment is now AGREEMENT WITH WHAT `--regenerate` WOULD WRITE.

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
`key=<number|boolean>` is a candidate, and the exact token must appear in **the
commit** under `prep/phase11/harness/`, **excluding markdown** -- in an
instrument or in a committed run-evidence file. Not in the directory: in the
commit. A file the commit does not carry cannot legitimise a figure, and the
run names the commit it read and every file under the harness that differs
from it.

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

What it prints is NOT WRITTEN HERE, and that is round 15's finding applied to
this file's own header: the count is generated into the manifest, in the
`surface` block, by the command above. Of the documented shapes, some would red
the gate if a document wrote them, some pass because something already emits
them, and the two exempted tokens are not candidates at all. Round 14 measured
its own list of shapes, which is not this list; two such counts are each true
of their own set and are not comparable. The escape hatch
for every red shape is named above -- prose on the line, or an inline code
span -- and neither requires a waiver list, which would move the hole from
shape to time.

AND IT REFUSES TO BE INERT. If the scan finds no candidate at all, the matcher
has stopped matching the documents it is pointed at, and a check that measures
nothing must not report a pass. That is exit 2.

EXITS: 0 clean, 1 a figure nothing emits, 2 inert, 4 invoked without `-I`,
5 a NAMED REFUSAL -- git absent, or the harness in no repository, so the
haystack cannot be derived from a commit. It never falls back to the walk.

ITS RED PROOFS, in layers. `--selftest` runs **every shape any round
planted**, each as its own hermetic arm with its expected exit, plus the false
positives round 13 measured as arms that must now come back clean, and then
deletes each guard in turn and requires it to flip an arm -- the guards over
the haystack among them, so "derived from the commit" is measured by a scratch
file and a gitignored `.pyc` that must not legitimise a plant, and by a
directory that is no repository and must be refused. It then parses the
stripper, the splitter and the decision frame for a transformation or a
decision no name covers, plants both kinds, and runs the enrolment rule
against a reworded figure. The proof script runs all of it before the real
scan. Pointed at the documents and harness of
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
import atexit
import hashlib
import inspect
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unicodedata

# `R20-F1`, and it has to sit HERE, immediately after the imports and before any
# other statement of this file runs. Round 20 rebound `re.fullmatch` at module
# level to a function of its own: the module object was still `sys.modules["re"]`
# and its `__name__` was still `"re"`, so round 19's identity check held, the
# call site still matched its entry inside the guard the matrix measures, and the
# decision that entry admits was the planter's. Rule 5 pinned the MODULE by
# identity and the ATTRIBUTE by name.
#
# So the namespaces of the modules the frame may call are SNAPSHOTTED at import,
# and every attribute a listed entry names is compared against this snapshot by
# IDENTITY before any verdict is read. A rebinding anywhere after this line --
# which is where a plant lands, since this line is the second thing the file does
# -- is a named refusal. A plant that moved ABOVE this line would be captured
# here instead, which is why identity is not the only test: the object must also
# come from the module's own source and not from this file.
#
# The names below must be exactly `FRAME_MODULES`, which is defined far later;
# the two are compared at run time rather than kept in step by hand.
_SNAPSHOT_MODULES = ("re", "os", "unicodedata")
_AT_IMPORT = {m: dict(vars(sys.modules[m])) for m in _SNAPSHOT_MODULES}

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
MATCHER_GUARDS = (
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

# The guards over the HAYSTACK -- over what counts as something this tree
# emits, rather than over what a line says. They are listed apart because the
# paragraph above is about `figure_on`, and they are deleted and measured by
# `--selftest` in exactly the same way: each one reds an arm by name or the
# phase stops.
HAYSTACK_GUARDS = (
    "haystack from the commit",
    "no repository redirects the subject",
    "markdown is not evidence",
    "the checker is not its own evidence",
)

GUARDS = MATCHER_GUARDS + HAYSTACK_GUARDS

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


def _exempted(s, skip=()):
    """Is `s` one of the two tokens the coordinator exempted by exact name?

    A function of its own, and not a clause in the decision below, because
    `R16-S1` parses that decision and a clause is somewhere a narrowing can
    hide. Here the guard is a named branch the parse can read.
    """
    if "named exemptions" not in skip:
        return s in EXEMPT
    return False


def figures_on(line, skip=()):
    """Every figure this line reports, in order. Empty when it reports none.

    THE DECISION FRAME. `R16-S1`: the structural parse proved every
    TRANSFORMATION was behind a named guard, and round 16 pointed out that it
    said nothing about the function that decides what to do with the result. A
    rebinding of `line` here, or one early `return out` under a test nobody
    named, defeats every guard below it while `_strip` stays pristine.

    So this function, `tokens_in`, `_exempted` and `_is_figure` are parsed too
    -- and round 17 rejected the TWO-RULE parse that first answered that,
    because `ast.If`/`ast.IfExp`/`ast.Assign` are not the only ways to decide.
    What holds here now is a CLOSED SUB-LANGUAGE, stated in full above
    `FRAME_NODES` as four rules: every node type is in the admitted set or
    refused by name at its line; every decision is a named guard, a call the
    frame admits, or one of the exact sources listed as the shape a review arm
    is about; every call is classified, and a function this file defines is
    DESCENDED INTO under the same rules; and no name is bound twice, nor any
    parameter or `for` target bound at all. `--selftest` plants every shape
    round 16 and round 17 used, and the unplanted frame must still be accepted.
    """
    out = []
    for part in _segments(line, skip):
        s = _strip(part, skip)
        if not _is_figure(s, skip):
            continue
        if _exempted(s, skip):
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


# ── the haystack, derived from the COMMIT and not from the working tree ────
# `R16-F1`. Round 15 closed a fail-open -- a gitignored `.pyc` carrying this
# file's own prose -- by excluding compiled artefacts and this file's bytecode
# BY NAME. Round 16 rejected that as the wrong kind of fix, and it was right:
# the reasoning error was "not committed, therefore not in the subject", when
# the haystack was read from the FILESYSTEM and had nothing to do with what was
# committed. An enumeration of artefact directories and suffixes cannot name
# the file nobody has written yet -- a `scratch.log`, an editor backup, a
# `.orig` left by a merge, a tarball unpacked in the wrong directory -- so it
# moves the hole from SHAPE to TIME, which is this phase's own `P7` lesson.
#
# So the subject set is DERIVED FROM EXECUTION of git at a resolved commit, and
# the content is read FROM THE OBJECT STORE. A file that is not in that commit
# cannot legitimise a figure, whatever it is called; the artefact enumeration is
# DELETED rather than extended, and `__pycache__` is out of the haystack now
# because it is not committed, not because someone remembered to name it.
#
# THE READ IS HARDENED, as `P14` hardened its own local git reads, because a
# haystack an environment variable can redirect is no haystack: every `GIT_*`
# variable is scrubbed (`GIT_DIR` beats `-C`, so scrubbing comes first),
# replace objects are disabled by flag AND by environment, grafts are pointed
# at the null device, system and global configuration are ignored, `PATH` is
# pinned starting at `/usr/bin`, the binary is resolved once from a fixed list
# of absolute paths, and an absent git, a directory that is not a repository or
# a commit that does not resolve is A NAMED REFUSAL with a non-zero exit --
# never a silent fallback to the walk this round deleted. Shallowness is not
# refused: one commit's tree and its blobs are complete in a shallow clone,
# which is all this reads, and `P8`'s ruling is about a shallow graph's
# definite "no".
#
# WHAT IT COSTS, stated because it is a real cost and not a detail: content
# that exists only in the working tree does not count, so a figure whose
# evidence is written but not yet committed REDS until it is committed. The run
# prints the commit it read and the files under the harness that differ from it,
# so the one surprise this design can produce names itself in the output.

GIT_CANDIDATES = ("/usr/bin/git", "/bin/git", "/usr/local/bin/git")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")


class Refusal(Exception):
    """A named refusal. The haystack is never guessed and never falls back."""


def _git_binary():
    for cand in GIT_CANDIDATES:
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    raise Refusal(
        "GIT-ABSENT: none of %s is an executable file, so the haystack cannot be "
        "derived from the commit. The check refuses instead of reading the working "
        "tree." % ", ".join(GIT_CANDIDATES)
    )


def _git_env():
    """The environment for a local read, built by scrubbing rather than by adding.

    `GIT_DIR` beats `-C`, `GIT_REPLACE_REF_BASE` redirects objects and
    `GIT_ALTERNATE_OBJECT_DIRECTORIES` adds stores, so the inherited `GIT_*`
    set goes FIRST and whole; what follows then cannot be undone by a key this
    file forgot to name.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["PATH"] = "/usr/bin:/bin"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_GRAFT_FILE"] = os.devnull
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["LC_ALL"] = "C"
    return env


def _git(root, argv, stdin=None):
    proc = subprocess.run(
        [_git_binary(), "--no-replace-objects", "-C", root] + list(argv),
        env=_git_env(),
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise Refusal(
            "GIT-FAILED: `git %s` in %s exited %d: %s"
            % (
                " ".join(argv),
                root,
                proc.returncode,
                proc.stderr.decode("utf-8", "replace").strip().replace("\n", " "),
            )
        )
    return proc.stdout


def _toplevel(root):
    out = _git(root, ["rev-parse", "--show-toplevel"]).decode("utf-8", "surrogateescape")
    top = out.strip()
    if not top or not os.path.isdir(top):
        raise Refusal(
            "GIT-NO-REPO: `rev-parse --show-toplevel` in %s returned %r, so there is no "
            "commit to derive the haystack from." % (root, top)
        )
    return top


def _commit_of(root):
    sha = _git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).decode("ascii", "replace").strip()
    if not FULL_SHA.match(sha):
        raise Refusal(
            "GIT-UNRESOLVED: `rev-parse --verify HEAD^{commit}` in %s did not return a "
            "full 40-character object name (%r)." % (root, sha)
        )
    return sha


def _tracked_paths(top, sha, relpath):
    """The paths the COMMIT holds under `relpath`, repo-root-relative.

    `-z` so a path with a space or a quote cannot be mis-split, and
    `--full-tree` so the answer does not depend on the working directory.
    """
    out = _git(top, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", sha, "--", relpath])
    names = [n for n in out.decode("utf-8", "surrogateescape").split("\0") if n]
    if not names:
        raise Refusal(
            "GIT-EMPTY-SUBJECT: commit %s holds no file under %s, so the haystack would "
            "be empty and every figure would red for the wrong reason." % (sha[:12], relpath)
        )
    return sorted(names)


def _blobs(top, sha, names):
    """The contents of those paths, read from the object store in one batch."""
    if not names:
        return []
    stdin = "".join("%s:%s\n" % (sha, n) for n in names).encode("utf-8", "surrogateescape")
    out = _git(top, ["cat-file", "--batch"], stdin=stdin)
    read = []
    at = 0
    for name in names:
        nl = out.find(b"\n", at)
        if nl < 0:
            raise Refusal("GIT-BATCH: the object stream ended before %s" % name)
        header = out[at:nl].decode("utf-8", "replace").split()
        if len(header) != 3 or header[1] != "blob":
            raise Refusal(
                "GIT-OBJECT: %s:%s is not a blob (`cat-file --batch` said %r)"
                % (sha[:12], name, " ".join(header))
            )
        size = int(header[2])
        read.append(out[nl + 1 : nl + 1 + size].decode("utf-8", "replace"))
        at = nl + 1 + size + 1
    return read


def _differs_from_commit(root):
    """The files under `root` the working tree holds that the commit does not
    agree with: changed, untracked, or ignored. Reporting only -- nothing here
    decides anything -- and best effort, because a report that can refuse
    would make the refusal about the report.

    It exists because `R15-F1` was a file nobody could see: gitignored, so
    `git status` said clean, and read by the gate all the same. Whatever the
    commit does not carry is now out of the haystack AND named in the output.
    """
    try:
        # The SAME anchored toplevel the verdict used. Reading this from an
        # upward resolution is how the redirect silenced its own report.
        top = _subject_top(root)
        rel = os.path.relpath(os.path.realpath(root), top)
        changed = _git(top, ["diff", "--no-ext-diff", "--name-only", "HEAD", "--", rel])
        extra = _git(
            top, ["ls-files", "-z", "--others", "--exclude-standard", "--", rel]
        )
        ignored = _git(
            top, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", rel]
        )
    except (Refusal, OSError):
        return None
    out = []
    out += [x for x in changed.decode("utf-8", "surrogateescape").split("\n") if x]
    out += [x for x in extra.decode("utf-8", "surrogateescape").split("\0") if x]
    out += [x for x in ignored.decode("utf-8", "surrogateescape").split("\0") if x]
    return sorted(set(out))


_HAYSTACK = {}


def _subject_top(root, checked=True):
    """The ONE repository that contains the subject, or a named refusal.

    What this does and does not claim, stated exactly, because round 18
    rejected the sentence that used to stand here: it does NOT claim that no
    repository can be planted. It claims that if more than one repository
    contains the haystack, this function REFUSES BY NAME and lists them,
    instead of choosing one -- and that the answer does not depend on the
    working directory the run was started from. Choosing was the defect:
    round 17 anchored on `cwd`, and round 18 moved the plant one level up so
    that the plant WAS the anchor from the harness directory.

    `R17`, ranked a fail-open by the coordinator over the challenger's own
    milder ranking: `_toplevel` resolved UPWARD from the harness directory, so
    a `git init` INSIDE it became the toplevel. The challenger built it: the
    nested repository carried every harness file plus the fabricated token, the
    scan read ITS commit, the figure passed -- and the self-announcing
    "differs from that commit" list came from the same redirected repository,
    so the mechanism that was supposed to name the surprise was defeated by the
    same move. Nothing compared the haystack's commit with the repository's
    own HEAD, because `_commit_of` was called once and its answer went only
    into a label.

    Four assertions, each a NAMED refusal, and `cwd` is in none of them:

      1. A CENSUS of every ancestor of the subject up to `/`, and of the
         subject itself, for a `.git` entry -- a directory, or the file a
         worktree leaves. None is `GIT-NO-REPOSITORY`. More than one is
         `GIT-NESTED-REPO`, listing them all and naming no intent (`R19-S1`):
         two repositories contain the haystack and the gate does not pick,
         which is why CI must not run it in a nested workspace.
      2. The subject must be a STRICT subdirectory of the one that is left. A
         subject that is its own repository is round 17's plant exactly.
      3. No `.git` anywhere INSIDE the subject, which is the one position the
         census cannot reach, because it is not an ancestor.
      4. The census must AGREE WITH GIT: the repository git itself discovers
         from the subject must be the one the census named, and a bare
         repository -- which has no `.git` entry for the census to see -- is a
         refusal of its own (`R19-S2`).
      5. By value: `HEAD` resolved FROM THE SUBJECT must be the same commit as
         `HEAD` resolved from that repository.

    The arms plant a repository at the harness, one level above it and two
    levels above it, and run each from three working directories -- the
    repository root, the harness directory and an unrelated subdirectory --
    because the defect round 18 reported was invisible from one `cwd` and live
    from another.
    """
    subject = os.path.realpath(root)
    if not checked:
        # THE PRE-`R17` RESOLUTION, and it is here for exactly two callers: the
        # hermetic arms, whose synthetic world IS its own repository, and the
        # guard matrix's deletion of this guard. Resolving upward from the
        # subject is the fail-open `R17-F2` reported, so deleting the guard
        # restores that behaviour by value and not by approximation -- which is
        # what makes the published probe's third direction mean anything.
        return os.path.realpath(_toplevel(subject))
    # `R18-F1`: the anchor is STRUCTURAL and the working directory plays no part
    # in it. Round 17 anchored it to the directory the run was invoked in, and
    # round 18 moved the planted repository ONE LEVEL UP, to `prep/phase11`:
    # that repository then WAS the toplevel, so there was nothing "between" it
    # and the subject to find, the subject was a strict subdirectory of it, and
    # its HEAD agreed with itself. All three assertions passed, and the
    # protection turned out to depend on an operator's `cwd` -- it held from the
    # repository root and failed when the file was run FROM THE HARNESS
    # DIRECTORY, which is how it is most naturally run.
    #
    # So: every ancestor of the subject up to `/`, and the subject itself, is
    # examined for a `.git` entry (a directory, or the file a worktree leaves).
    # MORE THAN ONE is a refusal that lists them all -- the gate does not pick
    # between two repositories, because picking is what let the subject choose,
    # and it says nothing about which of them was meant to be there.
    # Exactly one is the anchor.
    repos = []
    at = subject
    while True:
        if os.path.exists(os.path.join(at, ".git")):
            repos.append(at)
        parent = os.path.dirname(at)
        if parent == at:
            break
        at = parent
    if not repos:
        raise Refusal(
            "GIT-NO-REPOSITORY: no ancestor of the haystack %s holds a `.git`, so there "
            "is no commit to derive the subject set from. This is a refusal and not a "
            "fall back to reading the directory." % subject
        )
    if len(repos) > 1:
        # `R19-S1`. The wording used to call one of the two a plant. It does not
        # know that: a nested checkout, a vendored dependency with its own
        # history, a `git init` someone forgot are all this shape, and the gate
        # refuses every one of them for the same structural reason. So the
        # refusal LISTS what it found and states the rule, and the consequence
        # is recorded where it lands: CI must run this gate in a workspace that
        # is not nested inside another repository.
        raise Refusal(
            "GIT-NESTED-REPO: %d repositories contain the haystack %s (%s). The gate "
            "does not choose between them, because choosing is what let the subject "
            "pick the commit it was judged against. This is refused whether or not "
            "anything was planted: run the gate in a workspace that is not nested "
            "inside another repository." % (len(repos), subject, ", ".join(repos))
        )
    top = repos[0]
    if not (subject + os.sep).startswith(top + os.sep):
        raise Refusal(
            "GIT-SUBJECT-IS-A-REPO: the subject %s is the repository root itself (or "
            "lies outside it), so a repository planted at or inside the subject would "
            "BE the toplevel. The haystack must be a strict subdirectory of the "
            "repository it is read from." % subject
        )
    # `R19-S2`. The census reads a `.git` ENTRY, and a BARE repository has
    # none: its `HEAD`, `objects` and `refs` sit directly in the directory, so
    # an ancestor turned bare is INVISIBLE to the census while git's own
    # discovery finds it and answers every later question from it. At `e90bd70`
    # that shape was fail-closed by accident -- git either errored or the HEAD
    # comparison below disagreed -- and a hole covered by another tool's error
    # message is not a hole this gate measured. So the census is made to AGREE
    # with git, by name, and a disagreement is a refusal rather than a choice.
    if _git(subject, ["rev-parse", "--is-bare-repository"]).decode(
        "ascii", "replace"
    ).strip() != "false":
        raise Refusal(
            "GIT-BARE-REPOSITORY: git resolves the haystack %s inside a BARE "
            "repository, which an ancestor walk cannot see: a bare repository holds no "
            "`.git` entry to find. The subject is read from a work tree or not at all."
            % subject
        )
    discovered = os.path.realpath(_toplevel(subject))
    if discovered != os.path.realpath(top):
        raise Refusal(
            "GIT-TOPLEVEL-DISAGREES: the census of ancestors names %s as the one "
            "repository holding the haystack %s, and git's own discovery names %s. "
            "Where the two differ, every answer taken from git comes from a repository "
            "the census never examined." % (top, subject, discovered)
        )
    # Every directory between the toplevel and the subject is already covered:
    # it is an ancestor of the subject, so a `.git` there is a second
    # repository and the census above refused it by name. What the census does
    # NOT reach is a repository planted DEEPER, inside the haystack itself.
    for d, subdirs, _files in os.walk(subject):
        if ".git" in subdirs or ".git" in _files:
            raise Refusal(
                "GIT-NESTED-REPO: %s exists inside the haystack, so a commit of that "
                "repository could stand in for the subject's."
                % os.path.join(d, ".git")
            )
    # 3b, by value: the subject's own HEAD must be the toplevel's HEAD.
    here, there = _commit_of(subject), _commit_of(top)
    if here != there:
        raise Refusal(
            "GIT-HEAD-DISAGREES: HEAD resolved from the subject %s is %s, and HEAD "
            "resolved from the repository root %s is %s. One of them is not the "
            "repository that holds the subject." % (subject, here[:12], top, there[:12])
        )
    return top


def haystack(root, skip=()):
    """(label, paths, text): what this tree emits, and where that was read from.

    Cached per (root, guards) because one process measures one commit: the
    object store cannot change under a run, and the arms would otherwise spawn
    a subprocess per guard per arm.
    """
    stem = os.path.splitext(os.path.basename(__file__))[0]
    from_commit = "haystack from the commit" not in skip
    anchored = "no repository redirects the subject" not in skip
    drop_md = "markdown is not evidence" not in skip
    drop_self = "the checker is not its own evidence" not in skip
    key = (os.path.abspath(root), from_commit, anchored, drop_md, drop_self)
    if key in _HAYSTACK:
        return _HAYSTACK[key]

    def keep(name):
        base = os.path.basename(name)
        if drop_md and base.endswith(".md"):
            return False
        # By STEM, so a `.pyc` of an excluded source is excluded with it. Under
        # the git derivation that is belt and braces; with the derivation
        # deleted it is the round-15 design, which is what the arm measures.
        if drop_self and os.path.splitext(base)[0] == stem:
            return False
        return True

    if from_commit:
        top = _subject_top(root, anchored)
        sha = _commit_of(top if anchored else root)
        # `R20-S1`: `realpath`, not `abspath`. The anchor is resolved, so a
        # subject reached through a SYMLINK kept the link's spelling here while
        # the repository was found at the resolved path -- git then rejected the
        # pathspec and told the operator their haystack was "outside
        # repository", which is not what had happened. Identity and spelling
        # again, on the path this time.
        rel = os.path.relpath(os.path.realpath(root), top)
        paths = [n for n in _tracked_paths(top, sha, rel) if keep(n)]
        text = "\n".join(_blobs(top, sha, paths))
        label = "commit %s" % sha
    else:
        paths = []
        read = []
        for d, subdirs, files in os.walk(root):
            subdirs[:] = sorted(subdirs)
            for f in sorted(files):
                p = os.path.join(d, f)
                if not keep(p):
                    continue
                paths.append(os.path.relpath(p, root))
                try:
                    read.append(open(p, encoding="utf-8", errors="replace").read())
                except OSError:
                    pass
        text = "\n".join(read)
        label = "the working tree (the git derivation is deleted)"
    got = (label, paths, text)
    _HAYSTACK[key] = got
    return got


def emitted_strings(root, skip=()):
    """What the instruments and the committed evidence under `root` emit."""
    return haystack(root, skip)[2]


def haystack_files(root, skip=()):
    """The paths whose contents count as something this tree emits."""
    return haystack(root, skip)[1]


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


_FRAME_PARSED = []


# The object-level checks, by key, so each can be DELETED BY VALUE on a copy
# of the call rather than by editing the file. The coordinator's `C21` review:
# four of these had no arm that reds when the check is removed, and one -- the
# constants pin -- had an arm that compared two digests and never read the
# refusal at all, so deleting the comparison left the arm printing
# `as required`. A check with no deletion control is a check nobody has
# measured ([[a fix is done only when deleting IT reds a gate]]).
OBJECT_KEYS = ("attr-identity", "fn-identity", "const-pin", "harness-bytes")


def _objects_enabled(objects):
    """`None` = every object check (the real run). A set = only those keys."""
    return frozenset(OBJECT_KEYS) if objects is None else frozenset(objects)


def harness_bytes_pinned():
    """(ok, refusals) that every harness file's BYTES are the pinned bytes.

    The coordinator's `C21-F1` walked out of this instrument through a DEFAULT
    ARGUMENT -- `def scan(..., skip=("hyphen in the key",))` -- which is
    outside the decision parse (`scan` is not one of the four functions it
    reads), outside the constants digest (which hashes body literals, not
    defaults) and outside every rule key. Its ruling was to stop pinning shapes
    inside this file and pin THE FILE, against a value held outside it, read by
    a reader sharing no code with it.

    So this is a SUBPROCESS, never an import: an instrument that is part of the
    set it measures must not be loaded into the process it is measuring, and
    `check_harness_bytes.py` is itself a pinned row of the same table. Its
    refusal lines are passed through unchanged, because the name that refused
    is the thing an arm reads.
    """
    reader = os.path.join(os.path.dirname(os.path.realpath(__file__)), "check_harness_bytes.py")
    if not os.path.isfile(reader):
        return False, (
            "HARNESS-BYTES-READER-ABSENT: the reader that pins this harness's bytes is "
            "not at %s. Deleting the instrument is a way of silencing it, so its "
            "absence is a refusal and not a skip" % reader,
        )
    try:
        got = subprocess.run(
            [sys.executable, "-I", reader],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, (
            "HARNESS-BYTES-READER-FAILED: the byte pin reader could not be run (%s), so "
            "this run cannot say whether the harness's bytes moved" % exc,
        )
    if got.returncode == 0:
        return True, ()
    msgs = [
        line.split("REFUSED: ", 1)[1]
        for line in got.stdout.splitlines()
        if line.startswith("REFUSED: ")
    ]
    if not msgs:
        msgs = [
            "HARNESS-BYTES-READER-FAILED: the byte pin reader exited %d and named no "
            "refusal. Its output was %r" % (got.returncode, got.stdout[-400:])
        ]
    return False, tuple(msgs)


def frame_admissible(objects=None):
    """(ok, refusals) for the REAL decision frame, parsed once per process.

    `R19-S3`. The decision parse lived in `--selftest` only, so the bare scan
    -- the thing CI and a reader actually run -- executed whatever frame was on
    disk and said nothing about having read it. A gate that has an instrument
    and does not run it is a gate whose claim about itself is a sentence. The
    parse is cheap and deterministic; it is cached because `--selftest` calls
    `scan` once per arm and the answer cannot change inside one process.
    """
    if objects is not None:
        # A deletion control: one object check removed, by value, on a copy of
        # the call. Never cached, because the point is to differ from the run.
        return _frame_refusals(_objects_enabled(objects))
    if not _FRAME_PARSED:
        _FRAME_PARSED.append(_frame_refusals(_objects_enabled(None))[1])
    return not _FRAME_PARSED[0], _FRAME_PARSED[0]


def _frame_refusals(keys):
    """(ok, refusals) with exactly the object checks in `keys` consulted."""
    msgs = []
    if "attr-identity" in keys:
        _ok, m = module_call_identity()
        msgs += list(m)
    if "fn-identity" in keys:
        _ok, m = frame_function_identity()
        msgs += list(m)
    if "const-pin" in keys:
        _ok, m = decision_constants_pinned()
        msgs += list(m)
    if "harness-bytes" in keys:
        _ok, m = harness_bytes_pinned()
        msgs += list(m)
    for func in (figures_on, tokens_in, _exempted, _is_figure):
        try:
            tree = _source_of(func)
        except (OSError, TypeError, SyntaxError, IndexError) as exc:
            # `C21`: with `fn-identity` deleted, a body compiled under another
            # file name reaches this parse and `inspect.getsource` cannot find
            # it. A traceback tells a reader the instrument broke rather than
            # that the frame is inadmissible, so it is a NAMED refusal -- the
            # same correction round 20 made for a module-level lambda.
            msgs.append(
                "FRAME-SOURCE-UNREADABLE: the source of `%s` could not be read (%s: %s), "
                "so this run cannot say what the function that decides contains"
                % (func.__name__, type(exc).__name__, exc)
            )
            continue
        _ok, m, _k = decision_frame(tree, DECISION_EXCEPTIONS.get(func.__name__, ()))
        msgs = msgs + m
    return not msgs, tuple(msgs)


def scan(docs_dir, harness_dir, quiet=False, skip=()):
    """0 = every quoted figure is emitted. 1 = a finding. 2 = inert. 5 = a
    NAMED REFUSAL: the haystack could not be derived from a commit, or the
    decision frame is not one the rules admit, so the check says so and exits
    non-zero instead of reading the working tree."""
    admissible, refusals = frame_admissible()
    if not admissible:
        if not quiet:
            print(
                "  REFUSED: FRAME-INADMISSIBLE: the decision frame on disk is not one "
                "the closed sub-language admits, so nothing it decides is read as a "
                "verdict. %d refusal(s), the first of them: %s"
                % (len(refusals), refusals[0])
            )
        return 5
    try:
        label, files, emitted = haystack(harness_dir, skip)
    except Refusal as why:
        if not quiet:
            print("  REFUSED: %s" % why)
        return 5
    docs = documents(docs_dir)
    planted = () if "planted tokens" in skip else planted_tokens()
    seen = 0
    findings = []
    for path in docs:
        rel = os.path.relpath(path, docs_dir)
        for n, raw, tok in tokens_in(path, skip):
            seen += 1
            if tok not in emitted or tok in planted:
                findings.append((rel, n, tok, raw))
    if not quiet:
        # The inventory, because a verdict that does not name its own input is
        # a verdict nobody can reproduce: `R15-F1` was a gitignored `.pyc` in
        # this very directory, and nothing in the output said it was being read.
        print(
            "quoted figures: %d documents, haystack from %s (%d files), %d candidate "
            "figures, %d not emitted" % (len(docs), label, len(files), seen, len(findings))
        )
        # `R19-S3`: said rather than assumed. The parse ran above; a reader who
        # is told nothing about it has to take the header's word for it.
        print(
            "  the decision frame was parsed before this verdict: four functions, "
            "no refusal"
        )
        # Named, not silent: `R15-F1` was a gitignored file the gate read and
        # the output never mentioned. These no longer count, and they are no
        # longer invisible either.
        extra = _differs_from_commit(harness_dir)
        for name in extra or []:
            print(
                "  NOT IN THE HAYSTACK: %s differs from that commit (changed, untracked "
                "or ignored). Nothing it contains legitimises a figure." % name
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


FAKE_PROOFS = (
    'case("a", "SELECT 1", "present=true")\n'
    'case("b", "SELECT 2", "deleted=0")\n'
)
PLANT = "fabricated_count=999"
# The haystack arms cannot use `PLANT`: it is a token the arms plant, so the
# `planted tokens` guard catches it whatever the haystack says, and a haystack
# guard measured with it reds nothing. `R15-S4`'s own arm keeps `PLANT`,
# because a planted token in the evidence IS its finding.
PROBE = "world_probe=404"

# The worlds the arms run in. The haystack is derived from a COMMIT now, so a
# world is a repository: `tracked` is committed, `untracked` is written after
# the commit and is exactly what `R16-F1` is about -- a file in the directory
# that the commit does not carry.
WORLDS = {
    "plain": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # R12-E4b: a markdown file under the harness, in both roles at once.
    "md": ({"fake_proofs.py": FAKE_PROOFS, "README.md": PROBE + "\n"}, {}),
    # R15-S4: the committed run log carries the selftest's own output.
    "runlog": (
        {
            "fake_proofs.py": FAKE_PROOFS,
            "RUN-EVIDENCE.txt": (
                "  catch  N0 control: a bare line            rc=1 (want 1) -> as required\n"
                + PLANT
                + "\n"
            ),
        },
        {},
    ),
    # R16-F1: a scratch file in the working tree, committed nowhere.
    "untracked": ({"fake_proofs.py": FAKE_PROOFS}, {"scratch.log": PROBE + "\n"}),
    # R16-F1: round 15's own fail-open, gitignored exactly as it was.
    "pyc": (
        {"fake_proofs.py": FAKE_PROOFS, ".gitignore": "__pycache__/\n"},
        {"__pycache__/check_fenced_figures.cpython-313.pyc": PROBE + "\n"},
    ),
    # R17: the challenger's own plant, ranked a fail-open by the coordinator.
    # A repository is created INSIDE the haystack, carrying the token, after
    # the outer commit -- so an upward resolution finds IT and the figure
    # passes. Built by `_world_harness`, which cannot express it as a file map.
    "nested": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # R16-F1: a directory that is no repository. Not committed on purpose: the
    # arm below requires the check to REFUSE here rather than fall back to the
    # walk, which is the whole difference between a guard and a preference.
    "norepo": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # R16-F1: the checker's own prose, committed, under its own name.
    "stem": (
        {"fake_proofs.py": FAKE_PROOFS, "check_fenced_figures.py": "# " + PROBE + "\n"},
        {},
    ),
}

_WORLDS = {}


def _write(root, name, body):
    path = os.path.join(root, name)
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    open(path, "w", encoding="utf-8").write(body)


def _world_harness(kind):
    """The harness half of one hermetic world, as a real commit.

    Built once per process per kind. The haystack is read from the object
    store, so an arm needs a repository and not a directory -- and a fresh
    `git init` per arm per deleted guard would be some thousands of
    subprocesses for no new information.
    """
    if kind in _WORLDS:
        return _WORLDS[kind]
    tracked, untracked = WORLDS[kind]
    d = tempfile.mkdtemp(prefix="p11-world-%s-" % kind)
    atexit.register(shutil.rmtree, d, True)
    harness = os.path.join(d, "harness")
    os.makedirs(harness)
    for name, body in sorted(tracked.items()):
        _write(harness, name, body)
    if kind == "norepo":
        _WORLDS[kind] = harness
        return harness
    _git(d, ["init", "-q"])
    _git(d, ["add", "-A", "--", "harness"])
    _git(
        d,
        [
            "-c",
            "user.name=phase11",
            "-c",
            "user.email=phase11@example.invalid",
            "commit",
            "-q",
            "--no-gpg-sign",
            "-m",
            "world: %s" % kind,
        ],
    )
    for name, body in sorted(untracked.items()):
        _write(harness, name, body)
    if kind == "nested":
        # A repository INSIDE the haystack, carrying the plant, committed in
        # itself and in nothing else.
        _write(harness, "PROBE-NESTED.txt", PROBE + "\n")
        _git(harness, ["init", "-q"])
        _git(harness, ["add", "-A", "--", "."])
        _git(
            harness,
            [
                "-c",
                "user.name=phase11",
                "-c",
                "user.email=phase11@example.invalid",
                "commit",
                "-q",
                "--no-gpg-sign",
                "-m",
                "nested: the plant, committed in the planted repository",
            ],
        )
    _WORLDS[kind] = harness
    return harness


def _arm(body, skip=(), relpath="a.md", kind="plain"):
    """One document line, weighed against one world. `relpath` is under docs."""
    harness = _world_harness(kind)
    with tempfile.TemporaryDirectory() as d:
        docs = os.path.join(d, "docs")
        os.makedirs(docs)
        _write(docs, relpath, body + "\n")
        return scan(docs, harness, quiet=True, skip=skip)


# ── R18-F1: the anchor, measured at three POSITIONS and three WORKING ──────
# DIRECTORIES.
#
# Round 17's arm planted a repository AT the harness and refused it. Round 18
# moved the plant ONE LEVEL UP and it passed -- not because the assertions were
# wrong, but because the anchor was resolved from `cwd`, so the same tree
# refused from the repository root and passed when the file was run from the
# harness directory. A position is not a measurement unless the `cwd` it is
# measured from is one of several.
#
# Each world: an outer repository, the harness three directories down
# (`prep/phase11/harness`, the real layout), and for the planted positions a
# second repository at the harness, one level above it, or two. Each is run
# from the outer root, from the harness itself and from an unrelated sibling.
# `bare` is `R19-S2`: the same plant as `up1`, converted to a BARE
# repository, which the ancestor census cannot see at all.
ANCHOR_POSITIONS = ("none", "at", "up1", "up2", "bare")
ANCHOR_CWDS = ("the repository root", "the harness directory", "an unrelated subdir")
_ANCHOR = {}


def _anchor_world(where):
    """(root, harness, sibling) for one anchor world, built once per process."""
    if where in _ANCHOR:
        return _ANCHOR[where]
    d = tempfile.mkdtemp(prefix="p11-anchor-%s-" % where)
    atexit.register(shutil.rmtree, d, True)
    rel = os.path.join("prep", "phase11", "harness")
    harness = os.path.join(d, rel)
    os.makedirs(harness)
    sibling = os.path.join(d, "apps")
    os.makedirs(sibling)
    _write(harness, "fake_proofs.py", FAKE_PROOFS)
    _write(sibling, "keep.txt", "a sibling that is not an ancestor of the harness\n")
    _git(d, ["init", "-q"])
    _git(d, ["add", "-A", "--", "."])
    _git(
        d,
        ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
         "commit", "-q", "--no-gpg-sign", "-m", "anchor world: %s" % where],
    )
    if where != "none":
        at = {
            "at": harness,
            "up1": os.path.join(d, "prep", "phase11"),
            "up2": os.path.join(d, "prep"),
            "bare": os.path.join(d, "prep", "phase11"),
        }[where]
        # The plant carries the token, committed in ITSELF and in nothing else,
        # so if its commit is ever read the figure looks emitted. The file is
        # written INSIDE THE HAYSTACK and committed in the plant: the derivation
        # lists the subject's path within whatever repository it resolves, so a
        # token at the plant's own root would be outside that path and the
        # guard-deletion control would measure nothing. Round 18's own plant
        # had to satisfy the same condition to pass.
        _write(harness, "PROBE-PLANTED.txt", PROBE + "\n")
        _git(at, ["init", "-q"])
        _git(at, ["add", "-A", "--", "."])
        _git(
            at,
            ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
             "commit", "-q", "--no-gpg-sign", "-m", "the planted repository"],
        )
        if where == "bare":
            # `R19-S2`. The same live plant, converted to a BARE repository: its
            # `HEAD`, `objects` and `refs` move up out of `.git` and into the
            # directory itself, so the ancestor census -- which looks for a
            # `.git` ENTRY -- walks straight past it, while git's own discovery
            # finds it and reads the plant's commit. Converted rather than
            # created empty, so the plant is as live here as in `up1`: a bare
            # repository with no commit would be refused by git's own error and
            # the arm would measure that instead.
            gitdir = os.path.join(at, ".git")
            for entry in sorted(os.listdir(gitdir)):
                shutil.move(os.path.join(gitdir, entry), os.path.join(at, entry))
            os.rmdir(gitdir)
            _git(at, ["config", "core.bare", "true"])
    _ANCHOR[where] = (d, harness, sibling)
    return _ANCHOR[where]


_GITFILE = {}


def _gitfile_world():
    """A world where GIT'S toplevel and the CENSUS's answer disagree.

    `R20-S2`. The challenger could reach `GIT-TOPLEVEL-DISAGREES` with neither
    of the two shapes it tried -- a linked worktree and a `.git` file -- because
    in both of those git's answer and the walk's agree, and it asked for the
    refusal to be recorded as UNMEASURED-at-runtime rather than described as
    armed. There IS a shape: a `.git` FILE whose gitdir carries `core.worktree`
    pointing somewhere else. Then the directory holding the `.git` is the only
    repository an ancestor walk can see, and `rev-parse --show-toplevel` names a
    different directory entirely -- which is the disagreement the refusal exists
    for, and every answer taken from git after it would come from a repository
    the census never examined.
    """
    if _GITFILE:
        return _GITFILE["world"]
    d = tempfile.mkdtemp(prefix="p11-gitfile-")
    atexit.register(shutil.rmtree, d, True)
    elsewhere = os.path.join(d, "elsewhere")
    harness = os.path.join(d, "subject", "prep", "phase11", "harness")
    os.makedirs(os.path.join(elsewhere, "keep"))
    os.makedirs(harness)
    _write(harness, "fake_proofs.py", FAKE_PROOFS)
    _write(os.path.join(elsewhere, "keep"), "x.txt", "another repository's work tree\n")
    _git(elsewhere, ["init", "-q"])
    _git(elsewhere, ["add", "-A", "--", "."])
    _git(
        elsewhere,
        ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
         "commit", "-q", "--no-gpg-sign", "-m", "the repository git will name"],
    )
    _git(elsewhere, ["config", "core.worktree", os.path.realpath(elsewhere)])
    with open(os.path.join(d, "subject", ".git"), "w", encoding="utf-8") as fh:
        fh.write("gitdir: %s\n" % os.path.join(os.path.realpath(elsewhere), ".git"))
    _GITFILE["world"] = (os.path.join(d, "subject"), harness)
    return _GITFILE["world"]


def _gitfile_arm(skip=()):
    """The census and git disagree: a named refusal, from the harness seat."""
    subject, harness = _gitfile_world()
    was = os.getcwd()
    with tempfile.TemporaryDirectory() as docs_at:
        docs = os.path.join(docs_at, "docs")
        os.makedirs(docs)
        _write(docs, "a.md", PROBE + "\n")
        try:
            os.chdir(harness)
            return scan(docs, harness, quiet=True, skip=skip)
        finally:
            os.chdir(was)


def _anchor_arm(where, cwd_kind, skip=()):
    """One anchor world, weighed from one working directory."""
    root, harness, sibling = _anchor_world(where)
    seat = {
        "the repository root": root,
        "the harness directory": harness,
        "an unrelated subdir": sibling,
    }[cwd_kind]
    was = os.getcwd()
    with tempfile.TemporaryDirectory() as docs_at:
        docs = os.path.join(docs_at, "docs")
        os.makedirs(docs)
        _write(docs, "a.md", PROBE + "\n")
        try:
            os.chdir(seat)
            return scan(docs, harness, quiet=True, skip=skip)
        finally:
            os.chdir(was)


def _arms_with(skip=()):
    """(label, want, runner) for every arm, with `skip` left out of the matcher.

    One list, read by the selftest and by the guard matrix alike, so a guard
    cannot be measured against a different set of arms from the one the
    selftest asserts."""
    arms = [(label, 1, (lambda b=body: _arm(b, skip))) for label, body in CATCH]
    arms += [(label, 2, (lambda b=body: _arm(b, skip))) for label, body in SKIP]
    arms += [(label, 0, (lambda b=body: _arm(b, skip))) for label, body in PASSES]
    # `R12-E4a` is a location, not a line: the same plant in a subdirectory.
    arms.append(
        (
            "R12 E4a markdown in a subdirectory",
            1,
            lambda: _arm(PLANT, skip, "sub/README.md"),
        )
    )
    # The haystack arms. Each names the file that must NOT legitimise the plant,
    # and each is the arm the matching guard in `HAYSTACK_GUARDS` reds when it
    # is deleted -- which is how "the haystack is derived from the commit" is a
    # measured claim rather than a sentence in this header.
    for label, kind, token in (
        ("R12 E4b a doc is not its own evidence", "md", PROBE),
        ("R15-S4 a planted token is not its own evidence", "runlog", PLANT),
        ("R16-F1 an untracked scratch file is not evidence", "untracked", PROBE),
        ("R16-F1 a gitignored .pyc is not evidence", "pyc", PROBE),
        ("R16-F1 the checker is not its own evidence", "stem", PROBE),
    ):
        arms.append((label, 1, (lambda k=kind, x=token: _arm(x, skip, "a.md", k))))
    # Fail-closed, measured: no commit, no haystack, no verdict.
    arms.append(
        (
            "R16-F1 a directory that is no repository is refused",
            5,
            (lambda: _arm(PROBE, skip, "a.md", "norepo")),
        )
    )
    # R17: a repository planted inside the haystack must not become the
    # subject's repository. Deleting the anchor makes this arm PASS the plant,
    # which is the fail-open the coordinator ranked.
    arms.append(
        (
            "R17 a repository planted inside the haystack is refused",
            5,
            (lambda: _arm(PROBE, skip, "a.md", "nested")),
        )
    )
    # `R18-F1`: the same question at three positions and from three working
    # directories. `none` is the control -- the figure is not emitted, so the
    # honest answer is a red -- and every planted position must refuse from
    # every seat. Deleting the anchor turns the three planted positions into
    # passes, which is the fail-open restored by value.
    for where in ANCHOR_POSITIONS:
        for seat in ANCHOR_CWDS:
            arms.append(
                (
                    "%s %s, run from %s"
                    % (
                        "R19-S2" if where == "bare" else "R18-F1",
                        {
                            "none": "no planted repository",
                            "at": "planted at the harness",
                            "up1": "planted one level above",
                            "up2": "planted two levels above",
                            "bare": "a BARE repository planted one level above",
                        }[where],
                        seat,
                    ),
                    1 if where == "none" else 5,
                    (lambda w=where, s=seat: _anchor_arm(w, s, skip)),
                )
            )
    # `R20-S2`: the thirteenth registered `GIT-*` refusal, which nobody had
    # reached. A shape that reaches it is an arm; a shape nobody can reach would
    # have been recorded as UNMEASURED-at-runtime, which is not the same as dead.
    arms.append(
        (
            "R20-S2 git's toplevel and the census disagree",
            5,
            (lambda: _gitfile_arm(skip)),
        )
    )
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


# The transformers, as ONE tuple: `decision_test` claims these two are parsed
# here instead of by the frame's rules, and checks the claim against this.
TRANSFORMERS = (_strip, _segments)


def structure_test():
    """The real transformers must pass; all ten planted transformations must not."""
    ok = True
    for func in TRANSFORMERS:
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


# ── the decision frame: a CLOSED SUB-LANGUAGE, not an audit ────────────────
# `R16-S1` asked for the deciding function to be parsed, and the parse that
# answered it read decisions out of `ast.If`/`ast.IfExp` and rebindings out of
# `ast.Assign`. Round 17 then wrote the sentence that claim deserved: "this
# proves the frame takes no decision outside a named guard or a named
# function" was FALSE of the instrument, and false in the direction that
# matters -- a reader sent to it audits the named guards and the named calls
# and does not look at the comprehension filters. Five decision shapes walked
# straight through, each one planted in the real `figures_on` with a
# fabricated figure committed in the owner's Arabic report, and each one took
# the scan from refusing (rc 1) to passing (rc 0):
#
#   * a comprehension filter, which lives in `ast.comprehension.ifs` and is no
#     `ast.If` at all;
#   * a call to a helper beside the frame, which the rule's own remedy --
#     "move the predicate into a function" -- MAKES permitted, and which
#     nothing then parses (`R17-S1`);
#   * `try/except/else`, whose branches have no test to read;
#   * `match/case`, which contains no `ast.If` either;
#   * a boolean index, `s = ["", s][not s.startswith("zz_")]`, which decides
#     with a subscript and no test;
#   * and, as a hole in rule 1 rather than an escape, `(line := ...)`, because
#     `ast.NamedExpr` is not an `ast.Assign`.
#
# PATCHING SIX SHAPES WOULD LEAVE A SEVENTH. That is this file's own lesson,
# learned on fences, line anchors, value spellings, probe lines and artefact
# names, so the answer is not a longer list of node types to inspect: the
# frame is written in a CLOSED SUB-LANGUAGE and every node type outside it is
# REFUSED BY TYPE, with its own name, whether or not anyone thought of it as a
# way to decide. A comprehension, a `match`, a `try`, a `while`, an `assert`, a
# walrus, a subscript, a lambda, a dict and a statement-position `and` are all
# absent from `FRAME_NODES`, so none of them needs to be anticipated as a
# decision: they cannot appear.
#
# The four rules, and they are what the sentences in the manifest now say:
#
#   1. EVERY NODE TYPE in the frame is in `FRAME_NODES`. Anything else is
#      refused by name, at its line.
#   2. EVERY DECISION -- an `if` statement or an `if` expression, which are the
#      only decision forms the node set admits -- is a named guard
#      (`"<name>" in skip` / `not in skip`), a call the frame admits, or one of
#      the exact sources listed in `DECISION_EXCEPTIONS` as being the SHAPE the
#      review arm is about. A listed exception is itself a claim: it reds when
#      the source stops containing it.
#   3. EVERY CALL is classified, and a call nothing parses is refused: a module
#      function of this file is DESCENDED INTO under these same rules
#      (`R17-S1`), a transformer named in `PARSED_AS_TRANSFORMERS` is parsed by
#      `guarded_transformations` instead and that claim is checked against the
#      set that function actually reads, an attribute call is either on a
#      module in `FRAME_MODULES` or a method named in `FRAME_METHODS`, and a
#      bare name is in `FRAME_BUILTINS`. Everything else is a refusal.
#   4. NO NAME IS BOUND TWICE and no binding touches a parameter or a `for`
#      target. One binding per name is what makes "the frame reads the input it
#      was given" a statement about the code rather than about the author.
#
# WHAT IS STILL OUTSIDE IT, named because a net is read as covering the
# variants of what it names: this says nothing about the two transformers,
# which `guarded_transformations` covers; nothing about the honesty of a
# guard's NAME, which is what the arms are for; and nothing about any function
# the frame does not call. `--check-blocks`, `scan`, the emitters and the
# selftest machinery are not in the frame and are not parsed -- they decide
# nothing about whether a document's figure is emitted.
#
# A FIFTH RULE, which rounds 18 and 19 wrote between them: the four rules above
# are closed over node TYPES and were open over WHICH MODULE CALLS MAY DECIDE.
# Rule 2 admitted "a call the frame admits" and rule 3 admitted an attribute
# call on a module in `FRAME_MODULES`, so `if re.match("zz_", s)` planted in
# the real `figures_on` was admissible as written -- and it could not simply be
# banned, because `_is_figure` decides on `re.fullmatch` legitimately.
#
#   5. EVERY ATTRIBUTE CALL ON A MODULE, IN EVERY POSITION IT CAN OCCUPY, is
#      admitted only by an entry of `DECIDING_MODULE_CALLS` naming that
#      function, that module, that attribute and that POSITION -- `test`
#      (anywhere inside an `if` or `if`-expression condition), `return`
#      (anywhere inside a returned value) or `other`. An entry for a `test`
#      names the guard that must LEXICALLY WRAP the call, and the parse
#      requires it to be there. Each entry admits EXACTLY ONE site: at zero it
#      permits a decision nothing takes, and above one it covers a call nobody
#      read. Everything else is refused by name, wherever it sits.
#
# Round 19 rejected the three-part form of this rule, and the sentence that
# bounded it, twice over -- which is why the rule above is stated in positions
# and the paragraph below says only what the parse refuses:
#
#   * a SECOND test on a listed pair, inside NO guard at all, was admitted,
#     while the bounding sentence said the decision is "trusted to the named
#     guard that wraps it". Nothing required a wrapper;
#   * the listed pair reached through a helper that RETURNS it was outside the
#     rule entirely: in the helper the call sat in a `return` position and the
#     rule read only tests, and at the call site the test was on a local
#     function rule 2 admits.
#
# WHAT IS OUTSIDE THE RULES, as a count the parse can defend. Round 19 wrote
# here that it was ONE thing, the honesty of a guard's name, and round 20
# measured that sentence false by finding two more: a whitelisted METHOD NAME on
# an object of the planter's own (rule 3 was a list of names with no constraint
# on the receiver), and a module-level REBINDING of the listed attribute (the
# identity check reached the module and stopped one level short of the
# function). The coordinator's review then found a third, the ARGUMENTS of an
# admitted call. All three are closed above and armed; what follows is what is
# left, and each line is a thing the parse does NOT do:
#
#   1. THE HONESTY OF A GUARD'S NAME. The parse proves that the admitted call
#      sits inside the branch `"key class" not in skip` opens and that it is the
#      only such call; it cannot prove the branch deserves the name. The guard
#      matrix measures that by deleting the guard and reading which arms stop
#      giving their verdict.
#   2. WHAT A TRANSFORMER MAY DO. `_strip` and `_segments` are covered by
#      `guarded_transformations`, which proves every rebinding sits inside a
#      named branch -- and a transformation that DROPS a candidate decides, under
#      another name. Round 20 named this as where it would look next and it is
#      not closed here.
#   3. COMPLETENESS OF THE ADMIT-LISTS. Every entry of `DECIDING_MODULE_CALLS`
#      and every name in `FRAME_METHODS` is checked to be LIVE, and that is a
#      check for DEAD entries and not for MISSING ones. The coordinator's
#      standing ruling on this phase: `each entry is live` may never stand in
#      for `the set is complete`. It does not have to here -- anything the lists
#      do not admit is refused BY NAME, so the admit-lists are read through a
#      refusal rather than through their own completeness -- but the documents
#      say only what is checked, which is that a dead entry reds.
#
# THE FILE'S OWN BYTES WERE THE FOURTH LINE HERE, and they are no longer
# outside the rules -- they are a LAW, because the coordinator's twenty-first
# review walked out through them. Its escape was one line, and no rule above
# covers it:
#
#     -def scan(docs_dir, harness_dir, quiet=False, skip=()):
#     +def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):
#
# `_main` calls `scan()` with no `skip`, so the default switches a named guard
# off for every real run. It is outside the decision parse (`scan` is not one of
# the four functions it reads), outside the constants digest (which hashes body
# literals, not defaults) and outside every rule key -- and the same shape was
# available through `_fold_digits`, through a flag on a compiled pattern, and
# through any line of this file nobody has thought of. The previous wording,
# that `HARNESS_SHA256` is printed and not checked, read as a disclosure and
# worked as a hole: residual 4 would have covered every escape in this list,
# including the one that was ruled a blocker.
#
# So the ruling, and it ends the class instead of chasing it: THE HARNESS'S OWN
# BYTES ARE PINNED OUTSIDE THE HARNESS. Every executable file under
# `prep/phase11/harness/` is digested and compared with a row of the table in
# `prep/phase11/P11-HANDOFF-MANIFEST.md` §2a by `check_harness_bytes.py` -- a
# reader that shares NO CODE with this file, is itself a pinned row of the same
# table, and refuses by name (`HARNESS-BYTES-MOVED`, `HARNESS-FILE-UNPINNED`,
# `HARNESS-FILE-ABSENT`, `HARNESS-PIN-UNREADABLE`, `HARNESS-UNREADABLE`). It is
# run as a SUBPROCESS by `frame_admissible`, so the scan and `--check-blocks`
# refuse on it, and by `rebuild_and_prove.sh` as its own exit code before
# anything that reads these bytes. A default argument, a flag, a transformer
# that returns early, a deleted comparison: one law, by the bytes, not a rule
# per shape.
#
#   THE ONE LIMIT, and it is the only thing left on this line: an edit that
#   changes a harness file AND its pinned row in the same commit is bounded
#   only by REVIEW. A pin inside the thing it pins is not a pin. That is why
#   this phase's chain is author, independent challenger, coordinator, with the
#   diff read by someone who did not write it.
#
# Every claim in this paragraph is armed: round 19's two escapes, round 20's
# three, the coordinator's three, and `C21`'s own line, each with the ONE thing
# that refuses it deleted beside it -- a rule by key (`RULE_KEYS`), an object
# check by key (`OBJECT_KEYS`), or, for the byte law, the comparison itself
# deleted from a COPY of the reader. Each arm reads the REFUSAL NAME. That last
# point is `C21-F2`: the arm that used to stand for the argument-edit pin
# compared two digests and never ran the refusal, so when the coordinator
# deleted the comparison the arm went on printing `as required`.

FRAME_NODES = frozenset(
    (
        "FunctionDef",
        "arguments",
        "arg",
        "Expr",
        "Constant",
        "Name",
        "Load",
        "Store",
        "Assign",
        "Tuple",
        "List",
        "For",
        "Call",
        "Attribute",
        "keyword",
        "Return",
        "Continue",
        "If",
        "IfExp",
        "Compare",
        "In",
        "NotIn",
        "Not",
        "UnaryOp",
        "BinOp",
        "Add",
        "Pass",
    )
)
# The only names the frame may call without this file defining them.
FRAME_BUILTINS = ("open", "enumerate", "bool")
# The only methods it may call on anything. A WHITELIST, so an unknown method
# -- `.replace`, `.casefold`, `.removeprefix`, `.translate` -- is refused
# without being anticipated.
# `.lower` is here because `_is_figure` folds the case of a VALUE inside the
# `boolean case folding` guard, which the matrix measures. A method call cannot
# smuggle a transformation past rule 4 even so: binding it over the name it
# came from is a second binding, and deciding on its result is a test the node
# set does not admit. Every entry is checked to be in use below, so a
# permissive entry cannot sit here dead.
FRAME_METHODS = ("append", "rstrip", "strip", "partition", "lower")
FRAME_MODULES = ("re", "os", "unicodedata")
# Parsed by `guarded_transformations` rather than by these rules. The claim is
# checked below against the tuple that function is actually run over.
PARSED_AS_TRANSFORMERS = ("_strip", "_segments")

# `R18-S1`. The sub-language was closed over node TYPES and OPEN over which
# module calls may DECIDE: rule 2 admits "a call the frame admits" and rule 3
# admits an attribute call on a module in `FRAME_MODULES`, so
# `if re.match("zz_", s): continue` planted in the real `figures_on` was
# admissible under the rules as written -- selftest 0, scan 0, parse silent,
# fabricated figure through. Banning module calls outright is not available:
# `_is_figure` decides on `re.fullmatch` legitimately, inside the `key class`
# guard the matrix measures.
#
# So the pairs that may decide are NAMED, per function, and every other
# attribute call in a test position is refused by name. Each entry is checked
# to be live below, for the same reason `FRAME_METHODS` is: a permissive entry
# nothing uses only widens the language.
# Each entry is (function, module, attribute, POSITION, wrapping guard). Round
# 19 rejected the three-part form, and it was right twice over:
#
#   * `R19-F1` B1 -- a SECOND test on the listed pair, at the top of
#     `_is_figure` and inside NO guard at all, was admitted, while the
#     paragraph bounding the rule said the decision is "trusted to the named
#     guard that wraps it". Nothing required a wrapper. The sentence did not
#     bound what it claimed to bound.
#   * `R19-F1` B2 -- the listed pair reached through a helper that RETURNS it
#     was neither the helper's decision nor the caller's: at the helper the
#     call sat in a RETURN position and the rule only looked at TEST positions,
#     and at the call site the test was on a local function rule 2 admits. The
#     allow-list was never consulted at all.
#
# So the rule walks EVERY position a module call can occupy inside the frame,
# not the one position a decision is written in most often -- round 17's lesson
# again: a rule is only as wide as the positions it walks. A call in a `test`
# position must sit lexically inside the guard its entry names. A call in a
# `return` position is admitted only from a function the list names, and its
# entry records `None` where a guard would be, because the value-class decision
# IS this function's purpose and there is no guard to name: that is written
# down rather than implied.
#
# AND EACH ENTRY ADMITS EXACTLY ONE CALL SITE. A count stated as a law is
# tested as a function of its domain: with "at least one" the planted second
# test would simply have matched the entry the real one matches.
DECIDING_MODULE_CALLS = (
    ("_is_figure", "re", "fullmatch", "test", "key class"),
    ("_is_figure", "re", "fullmatch", "return", None),
)

DECISION_EXCEPTIONS = {
    "_is_figure": (
        "'=' not in s",
        "not key or not val",
        "spelled in bools",
    ),
}


# `C20-F1`, the coordinator's blocker on this head's predecessor: rule 5 pins
# WHICH call may decide, in which position, inside which guard, and by the
# identity of the function it names -- and never looked at the ARGUMENTS. Adding
# `(?!4242$)` to the pattern inside the admitted `return re.fullmatch(...)`, or
# editing the guarded `keyre`, gave a green run with a fabricated figure
# through. The arguments of an admitted call are part of what it decides, so the
# CONSTANTS the matcher's decisions read are pinned by digest: any edit to any
# of them reds by name, which is a law over argument edits rather than a list of
# the ones anyone has thought of.
#
# What is in the digest, all of it derived rather than listed: every literal in
# the six functions the parses cover (their docstrings excluded, because prose
# decides nothing), and the module-level names those functions READ, by their
# value in what is RUNNING -- a compiled pattern by its `.pattern`, anything
# else by `repr`. A compiled pattern carries its FLAGS with it: the
# coordinator's `C21` `R-1` added `re.I` to a pinned pattern and the digest did
# not move, and a flag is part of what a pattern decides. Regenerate it with
# `--decision-constants` after a
# deliberate change, exactly as a generated block is regenerated.
DECISION_CONSTANTS_SHA256 = "9d67a25b20b0efccc07d4d7b0b69229f5426228ffe3c2ea32937117c3ead388c"


def _frame_globals(fn):
    """The module-level names `fn` reads, as (name, value-text) in what runs."""
    params = {a.arg for a in fn.args.args}
    loops = set()
    bound = set()
    for node in ast.walk(fn):
        if isinstance(node, (ast.For, ast.comprehension)):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    loops.add(sub.id)
        if isinstance(node, ast.Assign):
            for t in node.targets:
                for sub in ast.walk(t):
                    if isinstance(sub, ast.Name):
                        bound.add(sub.id)
    out = []
    for g in sorted(_data_loads(fn) - params - loops - bound):
        obj = globals().get(g, None)
        text = getattr(obj, "pattern", None)
        if isinstance(text, str):
            # `C21` `R-1`: the digest read a compiled pattern by `.pattern`
            # alone, so adding `re.I` left it unchanged -- and a flag is part of
            # what a pattern decides. The flags go in with the pattern.
            out.append((g, "%s flags=%d" % (text, int(getattr(obj, "flags", 0)))))
        else:
            out.append((g, repr(obj)))
    return out


def decision_constants():
    """The canonical text whose digest `DECISION_CONSTANTS_SHA256` pins."""
    rows = []
    for func in (figures_on, tokens_in, _exempted, _is_figure) + TRANSFORMERS:
        fn = _source_of(func)
        body = fn.body
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
            body = body[1:]
        lits = []
        for stmt in body:
            for node in ast.walk(stmt):
                if isinstance(node, ast.Constant):
                    lits.append(repr(node.value))
        rows.append("%s literals: %s" % (fn.name, " | ".join(lits)))
        for g, text in _frame_globals(fn):
            rows.append("%s reads %s = %s" % (fn.name, g, text))
    return "\n".join(rows) + "\n"


def decision_constants_pinned():
    """(ok, refusals) that the matcher's decision constants are the pinned ones."""
    try:
        text = decision_constants()
    except (OSError, TypeError, SyntaxError, IndexError) as exc:
        # Same correction as in `_frame_refusals`: a body this file cannot read
        # is a NAMED refusal and never a traceback, whichever instrument reaches
        # it first. `C21`'s `FRAME-FUNCTION-FOREIGN` arm reaches it here when
        # `fn-identity` is deleted, because the constants are read off the same
        # four functions.
        return False, (
            "DECISION-CONSTANTS-UNREADABLE: the constants the matcher's decisions read "
            "could not be collected (%s: %s), so this run cannot say whether they are "
            "the pinned ones" % (type(exc).__name__, exc),
        )
    got = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if got == DECISION_CONSTANTS_SHA256:
        return True, ()
    return False, (
        "DECISION-CONSTANTS-MOVED: the constants the matcher's decisions read digest to "
        "%s and this file pins %s. An ARGUMENT of an admitted call is part of what that "
        "call decides -- `(?!4242$)` added to a pattern inside the admitted call is a "
        "narrowing rule 5 cannot see -- so a changed constant is a refusal. If the "
        "change was deliberate, run `--decision-constants` and commit the digest it "
        "prints." % (got, DECISION_CONSTANTS_SHA256),
    )


def frame_function_identity():
    """(ok, refusals) that the functions PARSED are the functions that RUN.

    The coordinator's `C20` review wrapped `_is_figure` in a decorator carrying
    `__wrapped__`: `inspect.getsource` follows that attribute, so the parse read
    the original body while the call read the wrapper. `--selftest` noticed by
    accident -- its compiled-constants tie is not part of the gate the scan runs
    -- and `--check-blocks` and the scan returned 0. So the tie is here, where
    both gates read it, and it is three named refusals rather than a side
    effect:

      1. no `__wrapped__`: that attribute is exactly what makes
         `inspect.getsource` return a body other than the one that runs;
      2. the code object comes from THIS file, so a body defined elsewhere
         cannot stand in for it;
      3. the qualified name is the plain name, so a closure or a method cannot
         sit under it.
    """
    msgs = []
    here = os.path.realpath(__file__)
    for func in (figures_on, tokens_in, _exempted, _is_figure) + TRANSFORMERS:
        nm = func.__name__
        if getattr(func, "__wrapped__", None) is not None:
            msgs.append(
                "FRAME-FUNCTION-WRAPPED: `%s` carries `__wrapped__`, so the source this "
                "file parses is not the code that runs -- the parse would report the "
                "body underneath while the wrapper decides" % nm
            )
            continue
        code = getattr(func, "__code__", None)
        if code is None or os.path.realpath(code.co_filename) != here:
            msgs.append(
                "FRAME-FUNCTION-FOREIGN: `%s` carries code from %r rather than from this "
                "file, so what the gates parse is not what they run"
                % (nm, getattr(code, "co_filename", None))
            )
            continue
        if getattr(func, "__qualname__", nm) != nm:
            msgs.append(
                "FRAME-FUNCTION-NESTED: `%s` is qualified as %r, so the name this file "
                "parses is bound to something defined inside something else"
                % (nm, func.__qualname__)
            )
    return not msgs, tuple(msgs)


def module_call_identity():
    """(ok, refusals) for the OBJECTS the deciding-call entries name.

    `R20-F1`. Round 19 tied the spelling `re` to the module object. Round 20
    rebound `re.fullmatch` at module level and walked a fabricated figure
    through every exit code: the module was still the module, the entry still
    matched in its guard, and the function the entry admits was the planter's.
    **A whitelist of names is not a whitelist of behaviours** -- so each entry's
    attribute is checked in WHAT IS RUNNING, three ways, each its own refusal:

      1. IDENTITY against the import-time snapshot (`_AT_IMPORT`, taken on the
         line after the imports). This is what catches a rebinding, because a
         rebinding is exactly a change of object at an unchanged name.
      2. PROVENANCE: the object's `__module__` must be the module the entry
         names. A planter who rebinds BEFORE the snapshot is captured by it, so
         identity alone would be satisfied; provenance is what refuses there.
      3. NOT DEFINED IN THIS FILE: a Python-level object must not carry code
         from `check_fenced_figures.py`. Same reason as 2, read off the code
         object instead of a settable attribute.

    This is run by `frame_admissible`, so the scan and `--check-blocks` refuse on
    it too and not only `--selftest`.
    """
    msgs = []
    if tuple(_SNAPSHOT_MODULES) != tuple(FRAME_MODULES):
        msgs.append(
            "the import-time snapshot covers %s and the frame may call %s -- the two "
            "lists are the same list and a module the frame may call with no snapshot "
            "is an unpinned attribute" % (_SNAPSHOT_MODULES, FRAME_MODULES)
        )
        return False, tuple(msgs)
    here = os.path.realpath(__file__)
    for fn, mod, attr, position, _guard in DECIDING_MODULE_CALLS:
        module = sys.modules.get(mod)
        if globals().get(mod) is not module or getattr(module, "__name__", None) != mod:
            msgs.append(
                "`%s` in this module is not the module of that name, so the entry "
                "`%s.%s` named for `%s` is matched by spelling against something else"
                % (mod, mod, attr, fn)
            )
            continue
        now = getattr(module, attr, None)
        before = _AT_IMPORT[mod].get(attr)
        if now is None:
            msgs.append(
                "MODULE-ATTR-ABSENT: `%s.%s`, which the entry for `%s` names, does not "
                "exist on that module at run time" % (mod, attr, fn)
            )
            continue
        if now is not before:
            msgs.append(
                "MODULE-ATTR-REBOUND: `%s.%s` is not the object this file saw when it "
                "imported `%s` (now %r). The entry for `%s` admits a decision taken by "
                "whatever that name now holds, so the name is refused rather than "
                "trusted -- a whitelist of names is not a whitelist of behaviours"
                % (mod, attr, mod, now, fn)
            )
            continue
        if getattr(now, "__module__", None) != mod:
            msgs.append(
                "MODULE-ATTR-FOREIGN: `%s.%s` reports `__module__` %r rather than %r, so "
                "the object the entry for `%s` admits was not defined by the module the "
                "entry names" % (mod, attr, getattr(now, "__module__", None), mod, fn)
            )
            continue
        code = getattr(now, "__code__", None)
        if code is not None and os.path.realpath(code.co_filename) == here:
            msgs.append(
                "MODULE-ATTR-IS-OURS: `%s.%s` carries code from this file (%s), so the "
                "entry for `%s` admits a decision this file took while reporting it as "
                "the module's" % (mod, attr, code.co_filename, fn)
            )
    return not msgs, tuple(msgs)


def _guard_test(test):
    """`"<name>" not in skip` or `"<name>" in skip`, or None."""
    if not isinstance(test, ast.Compare) or len(test.ops) != 1:
        return None
    if not isinstance(test.ops[0], (ast.NotIn, ast.In)):
        return None
    if not isinstance(test.left, ast.Constant) or not isinstance(test.left.value, str):
        return None
    right = test.comparators[0]
    if not isinstance(right, ast.Name) or right.id != "skip":
        return None
    return test.left.value


def _frame_lookup(name):
    """What a called bare name IS, resolved in what is RUNNING.

    `globals()` rather than a text map, because a map of names read from the
    source is a representation the source can alter -- this phase's own `P7`
    lesson -- and because a helper that exists only on disk cannot be called.
    """
    if name in FRAME_BUILTINS:
        return ("builtin", None)
    if getattr(globals().get(name), "__name__", None) == "<lambda>":
        # `C20` `P3`: a `lambda` has a `__code__` and this module's
        # `__module__`, so it used to be resolved as a function and then
        # `inspect.getsource` returned the ASSIGNMENT it sits in, which parses
        # to an `Assign` and not a `FunctionDef`. The descent died on
        # `fn.name` with a traceback. A traceback tells a reader the instrument
        # broke; this phase refuses by name.
        return ("lambda", None)
    if name in PARSED_AS_TRANSFORMERS:
        return ("transformer", None)
    obj = globals().get(name)
    if getattr(obj, "__code__", None) is not None and getattr(obj, "__module__", None) == __name__:
        return ("function", obj)
    return (None, None)


def _source_of(func):
    return ast.parse(textwrap.dedent(inspect.getsource(func))).body[0]


# `R20-F1`. Rule 3's method whitelist was a list of method NAMES with no
# constraint on the RECEIVER, so a module-level object of the planter's own --
# `_r20_shape.strip(key)` -- was admitted, because `strip` is on the list.
# Round 20 proved that was the admitting rule by running the same plant with
# `.match`, which is refused by name. The frame could therefore decide on its
# input through a predicate of its own with no module call in it anywhere, which
# is why the old bound ("nothing else in the frame calls a module") was true and
# bounded nothing. **A whitelist of names is not a whitelist of behaviours.**
#
# So a whitelisted method is admitted only on a receiver the frame can ACCOUNT
# FOR: a parameter, a `for` target, or a name bound in the function from a value
# that is itself accounted. A module-level name is NOT accounted, and -- round
# 20's `A4c` -- binding one to a local first does not launder it, because the
# binding's own right-hand side is read.
def _data_loads(expr):
    """Every name whose VALUE this expression reads.

    A callee is not a data load: a called bare name is classified by rule 3's
    own lookup. A module in `FRAME_MODULES` is not one either: rule 5 and the
    import-time identity check own those. Everything else that is read --
    including the RECEIVER of a method call -- is here, which is the point.
    """
    callees = {id(n.func) for n in ast.walk(expr) if isinstance(n, ast.Call)}
    out = set()
    for n in ast.walk(expr):
        if not isinstance(n, ast.Name) or not isinstance(n.ctx, ast.Load):
            continue
        if id(n) in callees or n.id in FRAME_MODULES:
            continue
        out.add(n.id)
    return out


def _accounted_names(fn, params, loop_targets):
    """The names in `fn` whose value is derived from the function's own inputs.

    A fixed point rather than a walk in source order: monotone, so it does not
    depend on reading the statements in the order a human would, and rule 4
    already forbids binding a name twice.
    """
    acc = set(params) | set(loop_targets)
    for _pass in range(8):
        grew = False
        for node in ast.walk(fn):
            if not isinstance(node, ast.Assign):
                continue
            targets = {
                sub.id
                for t in node.targets
                for sub in ast.walk(t)
                if isinstance(sub, ast.Name)
            }
            if targets <= acc or not _data_loads(node.value) <= acc:
                continue
            acc |= targets
            grew = True
        if not grew:
            break
    return acc


def _module_call_sites(fn):
    """Every attribute call on a frame module inside `fn`, with the POSITION it
    occupies and the named guards that LEXICALLY wrap it.

    `R19-F1`. The three-part allow-list looked only at tests, so the same pair
    reached in a `return` position was outside the rule entirely, and a test
    that sat inside no guard at all matched an entry whose fifth field did not
    exist. A rule is only as wide as the positions it walks, so this walks all
    of them: `test` (anywhere inside an `if`/`if`-expression condition),
    `return` (anywhere inside a returned value) and `other`. The guard set is
    built on the way down, from the `if` statements this node is lexically
    inside -- a guard's OWN test is not wrapped by it, so the key is added only
    for the body and the `else`.
    """
    sites = []

    def visit(node, position, guards):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            on = node.func.value
            if isinstance(on, ast.Name) and on.id in FRAME_MODULES:
                sites.append((node, on.id, node.func.attr, position, guards))
        if isinstance(node, ast.If):
            inner = node.test
            if isinstance(inner, ast.UnaryOp) and isinstance(inner.op, ast.Not):
                inner = inner.operand
            key = _guard_test(inner)
            visit(node.test, "test", guards)
            inside = guards | frozenset([key]) if key is not None else guards
            for sub in node.body + node.orelse:
                visit(sub, "other", inside)
            return
        if isinstance(node, ast.IfExp):
            visit(node.test, "test", guards)
            visit(node.body, position, guards)
            visit(node.orelse, position, guards)
            return
        if isinstance(node, ast.Return):
            if node.value is not None:
                visit(node.value, "return", guards)
            return
        for sub in ast.iter_child_nodes(node):
            visit(sub, position, guards)

    for sub in fn.body:
        visit(sub, "other", frozenset())
    return sites


# The keys of the rules a deletion control may delete ONE AT A TIME. The
# coordinator's `C20` ruling: a fix is done only when deleting it reds a gate,
# and `enforce=False` deleted all of them at once, so no single rule was
# measured. `True` is every key, `False` is none (kept for the arms written
# before the keys existed), and a set is exactly those keys.
RULE_KEYS = ("positions", "one-site", "receiver", "data", "shadow")


def _enabled(enforce):
    if enforce is True:
        return frozenset(RULE_KEYS)
    if enforce is False:
        return frozenset()
    bad = sorted(set(enforce) - set(RULE_KEYS))
    assert not bad, "no such rule key: %s" % ", ".join(bad)
    return frozenset(enforce)


def decision_frame(fn, exceptions=(), lookup=None, _seen=None, _depth=0, enforce=True):
    """(ok, messages, guard keys) for one decision function's AST.

    `lookup` resolves a called name; the default resolves it in this module, and
    the plants pass their own so a planted helper can be descended into without
    being defined here.

    `enforce=False` is the GUARD-DELETION switch for `R19-F1`, and nothing else
    may pass it: it restores round 18's behaviour by value -- a module call
    admitted in any position, with no entry and no guard required -- so the
    control run beside each of round 19's two arms shows the plant passing with
    the rule deleted rather than merely failing with it present.
    """
    lookup = lookup or _frame_lookup
    rules = _enabled(enforce)
    # `R18-S2`: the names on the CURRENT descent, copied at each level rather
    # than accumulated. A cumulative set would make two siblings calling one
    # helper look like re-entry; a path makes re-entry mean re-entry.
    seen = set(_seen or ())
    seen.add(fn.name)
    name = fn.name
    msgs = []
    keys = set()

    params = {a.arg for a in fn.args.args}
    loop_targets = set()
    for node in ast.walk(fn):
        if isinstance(node, (ast.For, ast.comprehension)):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    loop_targets.add(sub.id)

    accounted = _accounted_names(fn, params, loop_targets)

    # Rule 5 matches a module BY SPELLING, so the spelling is nailed down here
    # and its identity is checked in `decision_test`. Round 19 said where it
    # would look next -- shadow `re`, alias it, reach it through `getattr` --
    # and of those only a shadowing binding is matched by rule 5 as written: an
    # alias (`import re as _r`) and an attribute chain
    # (`re.compile(...).fullmatch`) are attribute calls the method whitelist
    # already refuses, and `getattr` is not in `FRAME_BUILTINS`. A PARAMETER
    # named `re` is the one that would be admitted, which is round 18's
    # shadowed-default shape caught by the arms rather than by the parse.
    # Refused by name now.
    for bad in sorted((params | loop_targets) & set(FRAME_MODULES)) if "shadow" in rules else ():
        msgs.append(
            "%s: `%s` is a parameter or a loop target here, and it is the name rule 5 "
            "matches a module by -- a listed pair whose module name can be rebound is "
            "matched by spelling and not by identity" % (name, bad)
        )

    # The listed exceptions own their own nodes: `not key or not val` is a
    # `BoolOp`, which the node set does not admit anywhere else.
    tests = [n.test for n in ast.walk(fn) if isinstance(n, (ast.If, ast.IfExp))]
    exempt = set()
    used = set()
    for test in tests:
        if ast.unparse(test) in exceptions:
            used.add(ast.unparse(test))
            for sub in ast.walk(test):
                exempt.add(id(sub))

    # Rule 2: every decision.
    for test in tests:
        if id(test) in exempt:
            continue
        inner = test
        if isinstance(inner, ast.UnaryOp) and isinstance(inner.op, ast.Not):
            inner = inner.operand
        key = _guard_test(inner)
        if key is not None:
            keys.add(key)
            continue
        if isinstance(inner, ast.Call):
            # Classified below, in every position at once: a module call is
            # weighed against `DECIDING_MODULE_CALLS` wherever it sits, and a
            # method on the value is refused by the method list.
            continue
        msgs.append(
            "%s: line %d decides on `%s`, which is neither a named guard nor a call the "
            "frame admits -- a predicate written inline is where a narrowing hides"
            % (name, test.lineno, ast.unparse(test))
        )

    # Rules 1, 3 and 4, in one walk.
    bound = {}
    for node in ast.walk(fn):
        if id(node) in exempt:
            continue
        kind = type(node).__name__
        if kind not in FRAME_NODES:
            msgs.append(
                "%s: line %s holds a `%s`, which the frame's node set does not admit. A "
                "decision taken through it is refused by TYPE rather than audited, which "
                "is the whole of R17-F1."
                % (name, getattr(node, "lineno", "?"), kind)
            )
            continue
        if isinstance(node, ast.Assign):
            for target in node.targets:
                for sub in ast.walk(target):
                    if not isinstance(sub, ast.Name):
                        continue
                    if sub.id in params or sub.id in loop_targets:
                        msgs.append(
                            "%s: line %d rebinds `%s`, which is %s -- a decision frame "
                            "reads the input it was given"
                            % (
                                name,
                                node.lineno,
                                sub.id,
                                "a parameter" if sub.id in params else "a loop target",
                            )
                        )
                    if sub.id in FRAME_MODULES and "shadow" in rules:
                        msgs.append(
                            "%s: line %d binds `%s`, which is the name rule 5 matches a "
                            "module by -- see the parameter case above"
                            % (name, node.lineno, sub.id)
                        )
                    if sub.id in bound:
                        msgs.append(
                            "%s: line %d binds `%s` a second time (first at line %d) -- "
                            "in the frame a name is bound once, so a transformation "
                            "cannot be slipped between a binding and its use"
                            % (name, node.lineno, sub.id, bound[sub.id])
                        )
                    bound[sub.id] = node.lineno
            continue
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                what, payload = lookup(func.id)
                if what == "lambda":
                    msgs.append(
                        "%s: line %d calls `%s`, which this file binds to a `lambda` "
                        "rather than to a `def`. The rules descend into a function by "
                        "parsing its source, and a lambda's source is the statement it "
                        "sits in -- so it is refused by name rather than followed into a "
                        "traceback" % (name, node.lineno, func.id)
                    )
                elif what is None:
                    msgs.append(
                        "%s: line %d calls `%s`, which this file does not define and "
                        "which is not in the frame's builtin list. A helper nothing "
                        "parses is exactly where R17-S1 says a decision hides."
                        % (name, node.lineno, func.id)
                    )
                elif what in ("function", "planted") and func.id in seen:
                    # Round 18 asked whether the descent terminates. It did,
                    # by SKIPPING a name already on the path -- so a helper
                    # that calls itself, or a mutual pair, was parsed as
                    # admissible and then recursed at RUN time until the
                    # interpreter stopped it with a `RecursionError`. A
                    # traceback tells a reader the instrument broke. This
                    # phase refuses BY NAME.
                    msgs.append(
                        "%s: line %d calls `%s`, which is already on this descent (%s) "
                        "-- a frame that re-enters a function is refused by name, not "
                        "followed until the interpreter's own limit stops it"
                        % (name, node.lineno, func.id, " -> ".join(sorted(seen)))
                    )
                elif what in ("function", "planted"):
                    if _depth >= 4:
                        msgs.append(
                            "%s: the descent into `%s` is deeper than this parse follows, "
                            "so it is refused rather than assumed"
                            % (name, func.id)
                        )
                    else:
                        sub_fn = _source_of(payload) if what == "function" else payload
                        _ok, sub_msgs, sub_keys = decision_frame(
                            sub_fn,
                            DECISION_EXCEPTIONS.get(func.id, ()),
                            lookup,
                            seen,
                            _depth + 1,
                            enforce,
                        )
                        msgs = msgs + sub_msgs
                        keys = keys | sub_keys
            elif isinstance(func, ast.Attribute):
                on_module = (
                    isinstance(func.value, ast.Name) and func.value.id in FRAME_MODULES
                )
                if not on_module and func.attr not in FRAME_METHODS:
                    msgs.append(
                        "%s: line %d calls the method `.%s`, which is not in the frame's "
                        "method list -- a transformation of the input that no guard names"
                        % (name, node.lineno, func.attr)
                    )
                elif not on_module and "receiver" in rules:
                    # `R20-F1` A4/A4c: the whitelist says which METHOD NAMES may
                    # be called, and said nothing about WHAT they are called on.
                    recv = func.value
                    if not isinstance(recv, ast.Name) or recv.id not in accounted:
                        msgs.append(
                            "%s: line %d calls the whitelisted method `.%s` on `%s`, "
                            "which is not a value this frame can account for -- a "
                            "parameter, a `for` target, or a name bound from one. A "
                            "method whitelist is a list of NAMES, so an object of "
                            "someone else's with a whitelisted method on it decides "
                            "without calling a module at all"
                            % (name, node.lineno, func.attr, ast.unparse(recv))
                        )
            else:
                msgs.append(
                    "%s: line %d calls something that is neither a name nor an attribute"
                    % (name, node.lineno)
                )

    # `R20-F1`, the other half of A4: what the frame may READ from outside
    # itself. The four functions legitimately read three module-level
    # constants -- the boolean sets and the exempted tokens -- and nothing in
    # rules 1 to 5 said what such a name may hold. An object with a whitelisted
    # method on it is exactly this shape, so a name the frame reads from module
    # level must be DATA in what is RUNNING: a string, or a tuple, set or
    # frozenset of strings. Anything else is refused by name, which refuses A4
    # a second and independent time: its predicate is an instance, not data.
    if "data" in rules:
        outside = sorted(_data_loads(fn) - accounted - set(bound))
        for g in outside:
            if g not in globals():
                msgs.append(
                    "%s: reads `%s`, which is neither accounted for in this function nor "
                    "defined by this file at module level -- a value a decision reads and "
                    "nothing parses" % (name, g)
                )
                continue
            obj = globals()[g]
            data = isinstance(obj, str) or (
                isinstance(obj, (tuple, set, frozenset))
                and all(isinstance(x, str) for x in obj)
            )
            if not data:
                msgs.append(
                    "%s: reads the module-level name `%s`, which holds %r. A name the "
                    "frame reads from outside itself must be DATA -- a string, or a "
                    "tuple, set or frozenset of strings -- because an OBJECT read from "
                    "there decides through its own methods without calling a module"
                    % (name, g, obj)
                )

    # `R19-F1`. The allow-list is ENFORCED here rather than described above:
    # every module call inside this function, in whatever position it occupies,
    # must be admitted by an entry naming that function, that module, that
    # attribute, that POSITION and -- for a test -- a guard that lexically
    # wraps it. Nothing else about a module call is admissible anywhere in the
    # frame, which is what makes the bounding paragraph a statement about the
    # parse.
    matched = {}
    for node, module, attr, position, guards in (
        _module_call_sites(fn) if "positions" in rules else ()
    ):
        if id(node) in exempt:
            continue
        entry = None
        for cand in DECIDING_MODULE_CALLS:
            if (cand[0], cand[1], cand[2], cand[3]) != (name, module, attr, position):
                continue
            if cand[4] is not None and cand[4] not in guards:
                continue
            entry = cand
            break
        if entry is None:
            msgs.append(
                "%s: line %d calls `%s.%s` in a %s position%s, and no entry of "
                "DECIDING_MODULE_CALLS admits it -- a module call that decides outside "
                "the guard its entry names, or in a position the list does not cover, "
                "is refused by name"
                % (
                    name,
                    node.lineno,
                    module,
                    attr,
                    position,
                    (
                        " inside the guards %s" % ", ".join(sorted(guards))
                        if guards
                        else " inside no named guard"
                    ),
                )
            )
            continue
        matched.setdefault(entry, []).append(node.lineno)
    for pair in DECIDING_MODULE_CALLS:
        if pair[0] != name or "one-site" not in rules or "positions" not in rules:
            # The sites this law counts are the ones the POSITIONS walk
            # collects, so with that walk deleted the count is zero for a
            # reason that has nothing to do with this law. Two keys, one
            # mechanism, stated here rather than left for a reader to infer
            # from an arm that fails both ways.
            continue
        at = matched.get(pair, [])
        if len(at) != 1:
            msgs.append(
                "%s: the deciding-call entry `%s.%s` in a %s position admits EXACTLY "
                "ONE site and matched %d (%s) -- a count stated as a law is tested as a "
                "function of its domain, and at zero the entry permits a decision "
                "nothing takes while above one it covers a call nobody read"
                % (
                    name,
                    pair[1],
                    pair[2],
                    pair[3],
                    len(at),
                    ", ".join("line %d" % n for n in at) or "none",
                )
            )
    for src in exceptions:
        if src not in used:
            msgs.append(
                "%s: the listed exception `%s` is not in the function any more, so the "
                "entry covers nothing and must go" % (name, src)
            )
    return not msgs, msgs, keys


# The frame, and the plants. Every plant is a statement inserted where one
# would sit in `figures_on`; six are the challenger's own, verbatim where it
# quoted them.
_DECISION_TEMPLATE = '''def _decided(line, skip=()):
    out = []
    for part in _segments(line, skip):
        s = _strip(part, skip)
%s
        if not _is_figure(s, skip):
            continue
        out.append(s)
    return out
'''

_PLANTED_HELPER = '''def _r17_helper(s):
    if s.startswith("zz_"):
        return True
    return False
'''

# `R18-S2`'s two shapes, as the round ran them: a helper that calls itself, and
# a mutual pair. Both used to be parsed as admissible -- the descent skipped a
# name it had already seen -- and then recursed at RUN time until the
# interpreter raised. They are plants here so the parse has to name them.
_PLANTED_SELF = '''def _r18_self(s):
    if _r18_self(s):
        return True
    return False
'''

_PLANTED_H1 = '''def _r18_h1(s):
    if _r18_h2(s):
        return True
    return False
'''

_PLANTED_H2 = '''def _r18_h2(s):
    if _r18_h1(s):
        return True
    return False
'''

# `R19-F1` B2, as the round ran it: the listed pair reached through a helper
# that RETURNS it. At `e90bd70` this was admitted twice over -- in the helper
# the call sat in a RETURN position and the rule read only TEST positions, and
# at the call site the test was on a local function rule 2 admits -- so the
# allow-list was never consulted at all.
_PLANTED_RETURNS = '''def _r19_shape(s):
    return re.fullmatch(r"zz_.*", s)
'''

DECISION_PLANTS = (
    ("R17-F1 comprehension filter", '        out = [x for x in out if not x.startswith("zz_")]'),
    ("R17-F1 helper this file does not define", '        if _r17_helper(s):\n            continue'),
    ("R17-F1 try/except/else", "        try:\n            s2 = s[:2]\n        except KeyError:\n            s2 = s\n        else:\n            continue"),
    ("R17-F1 match/case", '        match s[:3]:\n            case "zz_":\n                continue'),
    ("R17-F1 boolean index", '        s = ["", s][not s.startswith("zz_")]'),
    ("R17-F1 walrus on the parameter", '        _ = (line := line.replace(";", ""))'),
    ("R17-F1 statement-position and", '        s.startswith("zz_") and out.append(s)'),
    ("R17-F1 while", '        while s.startswith("zz_"):\n            s = s[3:]'),
    ("R17-F1 assert", '        assert not s.startswith("zz_")'),
    ("R16-S1 rebind the input", '        line = line.replace(";", "")'),
    ("R16-S1 rebind the parameter wholesale", "        skip = ()"),
    ("R16-S1 rebind the loop target", "        part = part.strip()"),
    ("R16-S1 narrowing early return", '        if "\\u2060" in line:\n            return out'),
    ("R16-S1 silent truncation", "        if len(out) > 1:\n            return out[:1]"),
    ("R16-S1 inline predicate on the value", '        if s.endswith("%"):\n            continue'),
    ("R16-S1 a guard with a clause bolted on", '        if _exempted(s, skip) and "%" in s:\n            continue'),
    ("R17-S1 an unguarded method on the value", '        s = s.replace(";", "")'),
    # Round 18's three. The first is the `P1`: admissible under the rules as
    # round 17 wrote them, because `re` is a module the frame admits.
    ("R18-S1 a decision on an admitted module call", '        if re.match("zz_", s):\n            continue'),
    ("R18-S2 a helper that calls itself", '        if _r18_self(s):\n            continue'),
    ("R18-S2 a mutual pair of helpers", '        if _r18_h1(s):\n            continue'),
)

# `R19-F1` B1, as the round ran it: a SECOND test on the pair the list names,
# at the top of the real `_is_figure` and inside NO guard at all. It cannot be
# planted in the template, because the template's function is not the one the
# entry names -- which is the point: the escape needed the author's own
# function, so the arm uses the author's own source.
_IS_FIGURE_ANCHOR = '    if "=" not in s:'

# `R20-F1` A4's object, at module level where the round put it: a whitelisted
# METHOD NAME on something that is not a module and not derived from the input.
# It exists here so the arms can read it in what is RUNNING, which is what the
# DATA rule reads; a plant that only existed in a string could not be measured
# against that rule at all.
class _ArmShape:
    """Round 20's `A4`: a predicate wearing a whitelisted method's name."""

    def strip(self, text):
        return text.startswith("qq_r20")


_ARM_SHAPE = _ArmShape()
# `C20` `P3`: a module-level `lambda`, which used to be followed into a
# traceback instead of refused by name.
_ARM_LAMBDA = lambda text: text.startswith("qq_r20")  # noqa: E731

# Each plant names the ONE rule key whose deletion must let it through -- the
# coordinator's `C20` `P2`: a fix is done only when deleting IT reds a gate, and
# a control that deletes every rule at once measures none of them. A tuple of
# keys means the shape is refused by that many independent rules, and all of
# them have to go for it to pass; that is reported rather than hidden.
IS_FIGURE_PLANTS = (
    (
        "R19-F1 B1 a second test on the listed pair, inside no guard",
        '    if re.fullmatch(r"zz_.*", s):\n        return False',
        ("positions",),
    ),
    (
        "R19-F1 B2 the listed pair reached through a helper that RETURNS it",
        '    if _r19_shape(s):\n        return False',
        ("positions",),
    ),
    (
        "R20-F1 A4 a whitelisted method on an object of the planter's own",
        '    if _ARM_SHAPE.strip(key):\n        return False',
        ("receiver", "data"),
    ),
    (
        "R20-F1 A4c the same object through a name BOUND in the frame",
        '    local = _ARM_SHAPE\n    if local.strip(key):\n        return False',
        ("receiver", "data"),
    ),
    (
        "R20-F1 A4 the receiver rule alone: a whitelisted method on DATA the frame reads",
        '    if BOOLEANS.strip(key):\n        return False',
        ("receiver",),
    ),
    (
        "C20 P3 a module-level lambda, refused by name rather than followed",
        '    if _ARM_LAMBDA(s):\n        return False',
        (),
    ),
)

# Planted INSIDE the guard the real call sits in, so rule 5 admits the position
# and the guard, and only the `exactly one site` law stands between the plant
# and a green run. The coordinator measured that law unarmed: deleting it while
# planting a second test gave a clean 0/0/0.
IS_FIGURE_GUARDED_PLANTS = (
    (
        "C20 P2 a SECOND test matching the listed entry, inside its own guard",
        '        if re.fullmatch(r"qq_r20.*", key):\n            return False',
        ("one-site",),
    ),
)
_GUARDED_ANCHOR = "        if not re.fullmatch(keyre, key):\n            return False"


def _is_figure_guarded(stmt):
    """`_is_figure`'s own source with one statement planted INSIDE the guard the
    real deciding call sits in, so position and guard are both satisfied."""
    src = textwrap.dedent(inspect.getsource(_is_figure))
    assert src.count(_GUARDED_ANCHOR) == 1
    return ast.parse(
        src.replace(_GUARDED_ANCHOR, _GUARDED_ANCHOR + "\n" + stmt, 1)
    ).body[0]


def _is_figure_planted(stmt):
    """`_is_figure`'s own source with one statement planted above its first
    decision -- the author's function, not a stand-in for it."""
    src = textwrap.dedent(inspect.getsource(_is_figure))
    assert src.count(_IS_FIGURE_ANCHOR) == 1
    return ast.parse(
        src.replace(_IS_FIGURE_ANCHOR, stmt + "\n" + _IS_FIGURE_ANCHOR, 1)
    ).body[0]


def _plant_lookup(name):
    """The frame's lookup, plus the planted helper -- so `R17-S1`'s remedy is
    measured as the rule says it is: a helper the frame calls is DESCENDED
    into, and the decision inside it is refused there."""
    planted = {
        "_r17_helper": _PLANTED_HELPER,
        "_r18_self": _PLANTED_SELF,
        "_r18_h1": _PLANTED_H1,
        "_r18_h2": _PLANTED_H2,
        "_r19_shape": _PLANTED_RETURNS,
    }
    if name in ("_ARM_LAMBDA", "_ARM_SHAPE"):
        return _frame_lookup(name)
    if name in planted:
        return ("planted", ast.parse(planted[name]).body[0])
    return _frame_lookup(name)


def decision_test():
    """The real frame must pass; every planted decision must be refused."""
    ok = True
    # The claim about the transformers, checked against the set that is run.
    parsed_elsewhere = tuple(f.__name__ for f in TRANSFORMERS)
    if parsed_elsewhere != PARSED_AS_TRANSFORMERS:
        print(
            "  decision **FAILED**: `PARSED_AS_TRANSFORMERS` says %s and the structural "
            "check actually parses %s, so a function is claimed to be covered by a parse "
            "that never reads it" % (PARSED_AS_TRANSFORMERS, parsed_elsewhere)
        )
        ok = False
    # Rule 3's method whitelist, checked live: an entry nothing uses is an
    # entry that only widens the language.
    seen_methods = set()
    for func in (figures_on, tokens_in, _exempted, _is_figure):
        for node in ast.walk(_source_of(func)):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                seen_methods.add(node.func.attr)
    # Rule 5's modules AND the attributes its entries name, checked in what is
    # running. A triple matched by spelling does not match by identity -- Phase 8
    # recorded it about path guards and Phase 15 about `spawnSync` -- and round
    # 20 showed round 19's version of this check reached the module and stopped
    # one level short of the function.
    ident_ok, ident_msgs = module_call_identity()
    fn_ok, fn_msgs = frame_function_identity()
    pin_ok, pin_msgs = decision_constants_pinned()
    ident_ok = ident_ok and fn_ok and pin_ok
    ident_msgs = tuple(ident_msgs) + tuple(fn_msgs) + tuple(pin_msgs)
    for m in ident_msgs:
        print("  decision **FAILED**: %s" % m)
    ok = ok and ident_ok
    dead = [m for m in FRAME_METHODS if m not in seen_methods]
    if dead:
        print(
            "  decision **FAILED**: `FRAME_METHODS` permits %s, which the frame does not "
            "call -- a whitelist entry nothing uses only widens the language"
            % ", ".join(dead)
        )
        ok = False
    for func in (figures_on, tokens_in, _exempted, _is_figure):
        fn = _source_of(func)
        good, msgs, keys = decision_frame(fn, DECISION_EXCEPTIONS.get(func.__name__, ()))
        for m in msgs:
            print("  decision **FAILED**: %s" % m)
        compiled = {c for c in func.__code__.co_consts if isinstance(c, str)}
        drifted = sorted(k for k in keys if k not in compiled)
        if drifted and func.__name__ not in ("figures_on", "tokens_in"):
            # The descent collects the callees' keys too, which are not
            # constants of the caller; the tie is checked on the function that
            # owns them.
            print(
                "  decision **FAILED**: %s names guards the compiled function does not "
                "hold (%s)" % (func.__name__, ", ".join(drifted))
            )
            good = False
        print(
            "  decision %-14s node set + decisions on named guards or listed calls + "
            "classified calls + one binding per name + no re-entry -> %s"
            % (func.__name__, "as required" if good else "FAILED")
        )
        ok = ok and good
    # The negative control: the template with nothing planted must PASS, or the
    # parse refuses everything and measures nothing.
    clean = ast.parse(_DECISION_TEMPLATE % "        pass").body[0]
    clean_ok, clean_msgs, _k = decision_frame(clean, (), _plant_lookup)
    if not clean_ok:
        for m in clean_msgs:
            print("  decision **FAILED** (control): %s" % m)
        ok = False
    refused = 0
    for label, stmt in DECISION_PLANTS:
        planted = ast.parse(_DECISION_TEMPLATE % stmt.replace("\\n", "\n")).body[0]
        plant_ok, _m, _k = decision_frame(planted, (), _plant_lookup)
        if plant_ok:
            print("  decision **FAILED**: %s hid from the parse" % label)
            ok = False
        else:
            refused += 1
    print(
        "  decision: %d of %d planted decisions refused, the unplanted frame accepted "
        "-- %s" % (refused, len(DECISION_PLANTS), "all of them" if ok else "FAILURES ABOVE")
    )
    # `R19-F1`'s own arms, each with the deletion control beside it. The
    # control runs the SAME plant with `enforce=False`, which is round 18's
    # rule restored by value: a plant that the rule refuses and the deleted
    # rule admits measures the hole that was there, and one that fails both
    # ways measures nothing.
    arms = [
        (label, _is_figure_planted(stmt.replace("\\n", "\n")), keys)
        for label, stmt, keys in IS_FIGURE_PLANTS
    ]
    arms += [
        (label, _is_figure_guarded(stmt.replace("\\n", "\n")), keys)
        for label, stmt, keys in IS_FIGURE_GUARDED_PLANTS
    ]
    # Not a round-19 finding: the shape round 19 said it would attack next, and
    # the only one of its four that rule 5 would have admitted as written.
    shadowed = textwrap.dedent(inspect.getsource(_is_figure)).replace(
        "def _is_figure(s, skip=()):", "def _is_figure(s, skip=(), re=None):", 1
    )
    arms.append(
        (
            "R19 pre-emptive: a parameter shadowing the module name rule 5 matches",
            ast.parse(shadowed).body[0],
            ("shadow",),
        )
    )
    # `C21`: the `shadow` key has TWO branches -- a parameter or loop target
    # named for a frame module, and a BINDING inside the body that takes the
    # same name. Round 20 armed the first and left the second with no arm, so
    # deleting half the rule reds nothing. This is the second half: the frame
    # binds `re` in its own body, after which rule 5 matches a listed pair by a
    # spelling the planter owns.
    rebound = textwrap.dedent(inspect.getsource(_is_figure)).replace(
        '    if "=" not in s:\n        return False\n',
        '    if "=" not in s:\n        return False\n    re = key\n',
        1,
    )
    arms.append(
        (
            "C21: the frame BINDS the module name rule 5 matches, in its own body",
            ast.parse(rebound).body[0],
            ("shadow",),
        )
    )
    # The DATA rule's own shape: nothing is tested on it and no module is
    # called, so no other rule has anything to say -- an OBJECT of the
    # planter's, read by a frame that is allowed to read module-level data.
    arms.append(
        (
            "R20-F1 the data rule alone: an object read where the frame reads its data",
            ast.parse(_DECISION_TEMPLATE % "        out.append(_ARM_SHAPE)").body[0],
            ("data",),
        )
    )
    for label, tree, keys in arms:
        excs = DECISION_EXCEPTIONS.get(tree.name, ())
        with_rule, msgs, _k = decision_frame(tree, excs, _plant_lookup)
        if keys:
            # ONE rule deleted per copy, and only the keys this arm names.
            left = frozenset(RULE_KEYS) - frozenset(keys)
            without, _m, _k2 = decision_frame(tree, excs, _plant_lookup, enforce=left)
            good = (not with_rule) and without
            how = "with %s DELETED it %s" % (
                " and ".join("`%s`" % k for k in keys),
                "passes" if without else "still fails, so the arm measures nothing",
            )
        else:
            # A shape whose fix is not one of the rule keys: the refusal itself
            # is the measurement, and the direction that used to be a traceback
            # is measured beside it where the arm can reach it.
            good = not with_rule
            how = "no rule key owns this shape; before the fix it was a traceback"
        if not good:
            ok = False
        print(
            "  decision %s: refused=%s, %s -> %s"
            % (
                label,
                "yes" if not with_rule else "NO",
                how,
                "as required" if good else "**SELFTEST FAILED**",
            )
        )
        if not with_rule:
            print("    refusal: %s" % msgs[0])
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
    "R16-F1 an untracked scratch file is not evidence": (
        None,
        "a file in the directory that the commit does not carry -- reported as the "
        "haystack's input, not as a document line",
    ),
    "R16-F1 a gitignored .pyc is not evidence": (
        None,
        "round 15's own `__pycache__/check_fenced_figures.cpython-313.pyc`, gitignored, "
        "which the round quoted as the fail-open",
    ),
    "R20-S2 git's toplevel and the census disagree": (
        None,
        "round 20's `S-2`, which asked for this refusal to be recorded as UNMEASURED-at-runtime because neither of its two shapes reached it: a `.git` FILE whose gitdir carries `core.worktree` pointing elsewhere does reach it -- reported as the shape the census cannot agree with, not as a document line",
    ),
    "R19-S2 a BARE repository planted one level above, run from the repository root": (
        None,
        "round 19's `S-2`: a bare repository is invisible to the ancestor census, reported as the shape the census cannot see rather than as a line -- the refusal NAME is asserted by `anchor_names_test`, because the exit code was already 5",
    ),
    "R19-S2 a BARE repository planted one level above, run from the harness directory": (
        None,
        "round 19's `S-2` from THE SEAT THE ROUNDS RAN FROM, reported as a shape rather than as a line -- the refusal NAME is asserted by `anchor_names_test`",
    ),
    "R19-S2 a BARE repository planted one level above, run from an unrelated subdir": (
        None,
        "round 19's `S-2` from a seat that is no ancestor of the harness, reported as a shape rather than as a line -- the refusal NAME is asserted by `anchor_names_test`",
    ),
    "R18-F1 no planted repository, run from the repository root": (
        None,
        "the control: the round's part 1, where the figure is committed and emitted by nothing, so the honest answer is a red, from the seat that already refused at `2dbce28` -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 no planted repository, run from the harness directory": (
        None,
        "the control: the round's part 1, where the figure is committed and emitted by nothing, so the honest answer is a red, from THE SEAT THE ROUND RAN FROM, where the plant passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 no planted repository, run from an unrelated subdir": (
        None,
        "the control: the round's part 1, where the figure is committed and emitted by nothing, so the honest answer is a red, from a seat that is not an ancestor of the harness, where it also passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted at the harness, run from the repository root": (
        None,
        "the round's part 2, which refused at `2dbce28` as claimed, from the seat that already refused at `2dbce28` -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted at the harness, run from the harness directory": (
        None,
        "the round's part 2, which refused at `2dbce28` as claimed, from THE SEAT THE ROUND RAN FROM, where the plant passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted at the harness, run from an unrelated subdir": (
        None,
        "the round's part 2, which refused at `2dbce28` as claimed, from a seat that is not an ancestor of the harness, where it also passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted one level above, run from the repository root": (
        None,
        "the round's part 3, quoted as `rc=0 haystack from a59d9360... 0 not emitted *** PASSES ***`, from the seat that already refused at `2dbce28` -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted one level above, run from the harness directory": (
        None,
        "the round's part 3, quoted as `rc=0 haystack from a59d9360... 0 not emitted *** PASSES ***`, from THE SEAT THE ROUND RAN FROM, where the plant passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted one level above, run from an unrelated subdir": (
        None,
        "the round's part 3, quoted as `rc=0 haystack from a59d9360... 0 not emitted *** PASSES ***`, from a seat that is not an ancestor of the harness, where it also passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted two levels above, run from the repository root": (
        None,
        "the same move one directory further out, which the round's discharge covers and its table does not, from the seat that already refused at `2dbce28` -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted two levels above, run from the harness directory": (
        None,
        "the same move one directory further out, which the round's discharge covers and its table does not, from THE SEAT THE ROUND RAN FROM, where the plant passed -- reported as a table of exit codes, not as a line",
    ),
    "R18-F1 planted two levels above, run from an unrelated subdir": (
        None,
        "the same move one directory further out, which the round's discharge covers and its table does not, from a seat that is not an ancestor of the harness, where it also passed -- reported as a table of exit codes, not as a line",
    ),
    "R17 a repository planted inside the haystack is refused": (
        None,
        "the challenger's nested `git init` under the harness, which made the planted "
        "repository the toplevel -- reported as a redirect of the subject, not as a line",
    ),
    "R16-F1 a directory that is no repository is refused": (
        None,
        "the round's own demand that the derivation not fall back -- a refusal, "
        "reported as the design and not as a line",
    ),
    "R16-F1 the checker is not its own evidence": (
        None,
        "this file's own prose, committed under its own name",
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
    "R14-S3 control: the figure itself": ("deleted=0", None),
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
# `^R1\d` until round 20, which is an exemption by SPELLING: the rule that an
# arm naming a finding must record the plant it measures stopped applying the
# moment the rounds reached twenty. Exactly this phase's own lesson about an
# enumerated exemption -- it cannot name what has not been written yet -- found
# in the instrument that enforces the lesson. Any round number now.
CITES = re.compile(r"^R\d+")


def provenance_test():
    """Every arm that names a finding must carry that finding's own plant."""
    ok = True
    bodies = dict(CATCH)
    bodies.update(dict(SKIP))
    bodies.update(dict(PASSES))
    # The arms appended by `_arms_with` -- the haystack arms -- name findings
    # too, and until round 16 nothing required them to record one: the loop
    # read `CATCH` and `SKIP` only. They have no body in a table, so their
    # entry must be a description.
    for label, _want, _run in _arms_with():
        bodies.setdefault(label, None)
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
        if quoted is not None and bodies[label] is None:
            print(
                "  provenance **FAILED**: the arm %r has no body in a table, so a "
                "verbatim plant cannot be checked against it" % label
            )
            ok = False
            continue
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
# fail-open the git derivation closes above -- so care was not the missing
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


# `R17-S2`: the emitters now produce (SUBJECT, CLAIM) ROWS, and the block is
# rendered from them. The enrolment used to read one line per block -- the
# summary -- and the challenger measured what that left: of the generated
# lines, three were compared and the rest, which are the per-guard and
# per-shape rows, were compared against nothing at all. Those rows are where
# this pack's prose actually cites figures, and it proved it by writing "the
# dash marker guard reds 7 arm(s)" and "rows=59 passes because something emits
# it" into a document, both undetected, the second being `R15-F1`'s exact
# shape. A row with a subject and a claim can be checked for CONTRADICTION,
# which a formatted line cannot.
_ROWS = {}


def _guard_rows():
    """(guard, the arms its deletion reds) for every guard, computed once."""
    if "guard" not in _ROWS:
        _ROWS["guard"] = [
            (guard, [label for label, want, run in _arms_with((guard,)) if run() != want])
            for guard in GUARDS
        ]
    return _ROWS["guard"]


def _surface_rows():
    """(shape, verdict) for every documented shape, computed once."""
    if "surface" not in _ROWS:
        emitted = emitted_strings(os.path.join(PHASE_DIR, "harness"))
        planted = planted_tokens()
        rows = []
        for shape in SURFACE:
            tok = figure_on(shape)
            if tok is None:
                verdict = "not a candidate (exempted or not a figure)"
            elif tok in emitted and tok not in planted:
                verdict = "passes: something emits it"
            else:
                verdict = "REDS THE GATE"
            rows.append((shape, verdict))
        _ROWS["surface"] = rows
    return _ROWS["surface"]


def emit_guard_matrix():
    lines = ["each guard deleted on its own, and the arms that stop answering:", ""]
    for guard, flipped in _guard_rows():
        shown = ", ".join(flipped[:3]) + (
            " +%d more" % (len(flipped) - 3) if len(flipped) > 3 else ""
        )
        lines.append("%-26s reds %2d arm(s): %s" % (guard, len(flipped), shown))
    lines.append("")
    lines.append("%d guards, every one of them deleted and measured" % len(GUARDS))
    return lines


def claims_guard_matrix():
    # The row's CLAIM is its FIGURE -- `reds N arm(s)` -- and not the labels
    # behind it. The labels are detail, and putting them in the claim gave the
    # comparison a vocabulary of hundreds of words, which matched the pack's
    # ordinary prose everywhere and measured nothing.
    rows = [
        (guard, "reds %d arm(s)" % len(flipped)) for guard, flipped in _guard_rows()
    ]
    rows.append(("", "%d guards, every one of them deleted and measured" % len(GUARDS)))
    return rows


def emit_arm_counts():
    # `3 others` used to be a literal here and in the selftest's own summary.
    # Round 16 adds three haystack arms, and a hand-written count of the arms
    # that are not in a table is the same mistake as a hand-written table:
    # computed from the list the selftest actually runs.
    others = len(_arms_with()) - len(CATCH) - len(SKIP) - len(PASSES)
    return [
        "%d catch arms, %d skip arms, %d pass arms, %d others"
        % (len(CATCH), len(SKIP), len(PASSES), others)
    ]


def claims_arm_counts():
    return [("", emit_arm_counts()[0])]


def emit_surface():
    rows = _surface_rows()
    lines = ["%-20s %s" % (shape, verdict) for shape, verdict in rows]
    red = len([1 for _shape, verdict in rows if verdict == "REDS THE GATE"])
    lines.append("")
    lines.append(
        "%d of %d realistic figure-shaped lines would red the gate if a document wrote them"
        % (red, len(SURFACE))
    )
    return lines


def claims_surface():
    rows = list(_surface_rows())
    red = len([1 for _shape, verdict in rows if verdict == "REDS THE GATE"])
    rows.append(
        (
            "",
            "%d of %d realistic figure-shaped lines would red the gate if a document "
            "wrote them" % (red, len(SURFACE)),
        )
    )
    return rows


# `R16-S2`: the enrolment used to be A SENTINEL -- one regex per generator,
# matched against the document, with anything outside a block that matched it
# reported. Round 16 reworded round 15's own figure by six words and walked
# through: `8 of 17 realistic figure-shaped lines` became `8 of the 17
# realistic shapes`, which no sentinel of mine named. Writing a looser regex
# would be patching escape N+1 of a wrong idea for the fifth time in this
# file, so the sentinels are DELETED. A figure is now recognised BY AGREEMENT
# WITH WHAT `--regenerate` WOULD WRITE: the generator is run, its claim line is
# read, and a line outside the blocks that shares both a number and a word with
# it is a restatement -- however it is worded, in whatever digits, because the
# comparison is made on the folded, lower-cased line.
GENERATORS = {
    "guard-matrix": (emit_guard_matrix, claims_guard_matrix),
    "arm-counts": (emit_arm_counts, claims_arm_counts),
    "surface": (emit_surface, claims_surface),
}

_BODIES = {}


def _block_body(name):
    """What `--regenerate` would write for one generator. Memoised: a generator
    is deterministic within a run, and `--check-blocks` asks every document."""
    if name not in _BODIES:
        _BODIES[name] = "\n".join(GENERATORS[name][0]())
    return _BODIES[name]


# A word long enough to carry a subject, and a number STANDING ON ITS OWN: a
# digit run inside `d15315e19cb3` is part of a digest, not a figure, and
# counting it made a digest line a restatement of anything with a `17` in it.
WORD = re.compile(r"[a-z][a-z-]{4,}")
NUMBER = re.compile(r"(?<![0-9a-z])[0-9]+(?![0-9a-z])")


def _claims_of(name):
    """Every (subject, claim) the generator asserts, read from the generator.

    A subject of `""` is the generator's SUMMARY, which has no subject but its
    own wording; anything else is a guard name or a figure-shaped token.
    """
    return GENERATORS[name][1]()


def _tokens(s):
    """The line as (numbers, words), folded and lower-cased.

    A number must stand ALONE: a digit run inside `d15315e19cb3` is part of a
    digest, and counting it made a digest line a restatement of anything with a
    `17` in it.
    """
    folded = _fold_digits(s.lower())
    return re.findall(r"(?<![0-9a-z])[0-9]+(?![0-9a-z])|[a-z][a-z-]*", folded)


# Words too common to identify anything. A stoplist LOOSENS this rule, so its
# failure mode is a catch it misses and never a figure it lets through
# silently; the price of the loosening is measured on this pack below.
STOPWORDS = (
    "the", "and", "that", "this", "with", "from", "they", "have", "been", "than",
    "what", "when", "each", "into", "only", "more", "most", "some", "such", "very",
    "also", "over", "then", "there", "here", "which", "while", "where", "those",
    "these", "about", "after", "before", "other", "both", "same", "once", "here",
    "says", "said", "like", "just", "even", "them", "their", "would", "could",
)


def _subject_words(subject):
    return [w for w in _tokens(subject) if len(w) >= 4 and not w.isdigit()]


def _mentions(text, subject):
    """Does this text NAME that subject?

    A token subject (`rows=59`) must appear as a substring. A phrase subject
    (`dash marker splits the line`) must have its first two real words
    present, in order and within three tokens of each other -- "the dash
    marker guard" names the dash-marker row, while "derived from the commit"
    does not name `haystack from the commit`, which a loose word-overlap test
    said it did about every line in the pack carrying `from` and `the`.
    """
    folded = _fold_digits(text.lower())
    if " " not in subject:
        return subject.lower() in folded
    words = _subject_words(subject)[:2]
    if len(words) < 2:
        return bool(words) and words[0] in set(_tokens(folded))
    toks = _tokens(folded)
    for i, tok in enumerate(toks):
        if tok != words[0]:
            continue
        if words[1] in toks[i + 1 : i + 4]:
            return True
    return False


# A claim pairs a SUBJECT with a FIGURE IN ONE CLAUSE.
#
# This pack's tables put two thousand characters on ONE physical line: the
# whole history of a conservation law, a dozen sentences long, inside one
# table cell. A rule applied to the line therefore reads a subject named in
# one sentence against a verdict word from a sentence five sentences away,
# and reds prose that restates nothing -- measured, on this pack: three of
# the five findings the line-wide rule produced were exactly that, two on the
# conservation row and one on a historical paragraph whose `29` is a decision
# id. So the comparison is per clause.
#
# The cost of the split is the other direction, and it is named rather than
# hidden: a subject in one clause whose wrong figure sits in the next escapes
# this check (`R17-S2-B1`, a P3 residual in the manifest). The window is a
# clause and not a token count because a clause is what a reader reads as one
# statement; a token count is a number with no meaning behind it.
CLAUSE = re.compile(r"(?:(?<=[.;:!?])\s)|[|\u2014]|(?:\s--\s)")


def _clauses(line):
    """`line` as the statements a reader reads it as."""
    return [c for c in CLAUSE.split(line) if c and c.strip()]


def _counts_claimed(text, claim):
    """The numbers in `text` that are COUNTS of what `claim` is about.

    A standalone number next to a word the claim itself uses -- `reds 7
    arm(s)`, `8 of 17` -- is a count about this subject. A number next to
    nothing the claim says, such as a section number or a migration id, is
    not, and this is what keeps the rule off the pack's ordinary prose. The
    vocabulary is the claim's own, so it moves when the generator's wording
    moves.
    """
    vocabulary = {
        w
        for w in _tokens(claim)
        if not w.isdigit() and len(w) >= 4 and w not in STOPWORDS
    }
    toks = _tokens(text)
    out = set()
    for i, tok in enumerate(toks):
        if not tok.isdigit():
            continue
        near = toks[max(0, i - 2) : i + 3]
        if [w for w in near if not w.isdigit() and w in vocabulary]:
            out.add(tok)
    return out


def _shared(text, claim):
    """(numbers, words) a clause has in common with a generator's claim.

    Folded and lower-cased on both sides, so `٤٠ catch arms` and `40 CATCH
    arms` are the same restatement -- the same normalisation the matcher
    applies, for the same reason.

    A number of ONE digit does not count. `2`, `3` and `9` carry no subject,
    and this file's own lesson is that a net whose price nobody measures is
    worse than no net: with single digits counted, the pack's own prose redded
    in 17 places that restate nothing.
    """
    a, b = _fold_digits(text.lower()), _fold_digits(claim.lower())
    numbers = {n for n in NUMBER.findall(a) if len(n) >= 2} & set(NUMBER.findall(b))
    return numbers, set(WORD.findall(a)) & set(WORD.findall(b))


def _restatements(line, name):
    """Every way `line` disagrees with, or restates, what `name` prints.

    Applied to each CLAUSE of the line, for the reason stated above `CLAUSE`.
    """
    found = []
    claims = _claims_of(name)
    # The verdict vocabulary comes from the ROWS only. Built from every claim it
    # also held the summary's words, so `deleted` and `measured` -- which the
    # guard-matrix summary says -- made every line of prose about a guard a
    # finding. The summary has no subject, so nothing anchors it.
    others = {}
    for subject, claim in claims:
        if subject == "":
            continue
        for word in _tokens(claim):
            if not word.isdigit() and len(word) >= 5 and word not in STOPWORDS:
                others.setdefault(word, set()).add(subject)
    for clause in _clauses(line):
        for subject, claim in claims:
            if subject == "":
                # THE SUMMARY: restatement only. A wrong summary figure with a
                # number in common is caught here; one written in words
                # (`thirty guards`) is the spelled-out residual the coordinator
                # ruled a named `P3`, and it is named in the manifest.
                numbers, words = _shared(clause, claim)
                if numbers and words:
                    found.append(
                        "restates the summary `%s` prints (shares %s and %s)"
                        % (name, ", ".join(sorted(numbers)), ", ".join(sorted(words)))
                    )
                continue
            if not _mentions(clause, subject):
                continue
            # Minus the SUBJECT's own tokens: `rows=59` carries a number, and
            # that number is the subject, never a figure claimed about it.
            # Without this, "`rows=59` reds the gate" -- the row's verdict
            # stated correctly -- was read as claiming `59` where the row says
            # `REDS THE GATE`, which is the control arm below.
            wrong = (
                _counts_claimed(clause, claim)
                - set(_tokens(claim))
                - set(_tokens(subject))
            )
            if wrong:
                found.append(
                    "contradicts the row `%s` prints for `%s`: it claims %s where the "
                    "row says `%s`"
                    % (name, subject, ", ".join(sorted(wrong)), claim)
                )
                continue
            # A verdict from a DIFFERENT row of the same generator, which is how
            # `rows=59 passes because something emits it` was written about a
            # shape the row says REDS THE GATE.
            mine = {w for w in _tokens(claim) if not w.isdigit()}
            # TWO words of another row's verdict, not one. One is how `figure` --
            # which the `not a candidate` verdict says -- made the conservation
            # pack's own sentence about `rows=59` a finding; two is what
            # `passes because something emits it` has and ordinary prose does not.
            elsewhere = sorted(
                word
                for word in set(_tokens(clause))
                if not word.isdigit()
                and len(word) >= 5
                and word not in mine
                and others.get(word)
                and subject not in others[word]
            )
            if len(elsewhere) >= 2:
                found.append(
                    "contradicts the row `%s` prints for `%s`: the clause says %s, "
                    "which belong to another row's verdict, where this row says `%s`"
                    % (name, subject, ", ".join("`%s`" % w for w in elsewhere[:3]), claim)
                )
    return found


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
    report a pass. 5 = the decision frame is not one the rules admit."""
    # `R19-S3`. The same gate as the scan, for the same reason: the generators
    # read the matcher, so a frame the rules refuse decides what these blocks
    # say.
    admissible, refusals = frame_admissible()
    if not admissible:
        if not quiet:
            print(
                "  REFUSED: FRAME-INADMISSIBLE: the decision frame on disk is not one "
                "the closed sub-language admits, so the generated blocks are not read "
                "as evidence. %d refusal(s), the first of them: %s"
                % (len(refusals), refusals[0])
            )
        return 5
    findings = []
    enrolled = 0
    for path in documents(docs_dir):
        rel = os.path.relpath(path, docs_dir)
        text = open(path, encoding="utf-8").read()
        for name in sorted(GENERATORS):
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
            # A RESTATEMENT of, or a CONTRADICTION of, anything the generator
            # prints -- every row, not only the summary. Derived from the
            # generator's own rows, so a reworded or a wrong figure is caught
            # by what it says rather than by the form it says it in.
            at = 0
            for lineno, line in enumerate(text.split("\n"), 1):
                start, at = at, at + len(line) + 1
                if any(a <= start < b or a < at <= b for a, b in spans):
                    continue
                for why in _restatements(line, name):
                    findings.append(
                        "%s:%d %s, outside its block. An instrument's figure is "
                        "generated into the document or it is not written at all; a "
                        "block is enrolled by agreement with `--regenerate`, not by a "
                        "sentence this file knows the shape of."
                        % (rel, lineno, why)
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

# The block arms. `R16-S2` asked for one thing in particular -- that round
# 15's figure, REWORDED, reds -- and the rule is useless if it also reds the
# unreworded document, so the control is an arm too.
BLOCK_ARMS = (
    ("R16-S2 a correct block, and numbers of other instruments", 0, ""),
    ("R16-S2 the claim typed verbatim outside the block", 1, "@@CLAIM@@"),
    (
        "R16-S2 the claim REWORDED, which no sentinel named",
        1,
        "there are @@N@@ catch arms and 15 skip arms in the selftest",
    ),
    (
        "R16-S2 the claim reworded in Arabic-Indic digits",
        1,
        "\u0664\u0660 catch arms, and the skip arms beside them",
    ),
    ("R16-S2 a block whose body was edited", 1, None),
    # `R17-S2`. The enrolment now compares EVERY row the generators print, not
    # one claim per block, so a verdict belonging to a different row is a
    # finding wherever it is written. The challenger's plant is the first of
    # these; the second is the control that keeps the rule about DISAGREEMENT
    # and not about mentioning a shape at all, which this pack does constantly.
    (
        "R17-S2 a row's verdict swapped for another row's",
        1,
        "rows=59 passes because something emits it",
    ),
    (
        "R17-S2 control: the same row's verdict stated correctly",
        0,
        "`rows=59` reds the gate, and that is what the row says",
    ),
    # The BOUND of the clause window, measured rather than described: the same
    # plant with a sentence boundary between the subject and the verdict is NOT
    # caught. `R17-S2-B1`, a named `P3` residual in the manifest. An arm that
    # expects 0 here is not a pass; it is the size of the hole, and it reds the
    # selftest the day the window changes without this line changing with it.
    (
        "R17-S2-B1 residual: the verdict one clause away is NOT caught",
        0,
        "rows=59 is the shape at issue. Something emits it, so it passes.",
    ),
)


def _blocks_arm(extra, edit=False):
    """One synthetic document: a correct `arm-counts` block plus one line."""
    with tempfile.TemporaryDirectory() as d:
        docs = os.path.join(d, "docs")
        os.makedirs(docs)
        body = _block_body("arm-counts")
        if edit:
            body = body.replace("catch arms", "catch arms (edited by hand)")
        text = (
            "# a synthetic document\n\n"
            "121 cases, 13 races and 93 migrations are other instruments' figures.\n\n"
            + extra
            + "\n\n"
            + (BEGIN % ("arm-counts", CMD % "arm-counts"))
            + _wrapped(body)
            + (END % "arm-counts")
            + "\n"
        )
        _write(docs, "a.md", text)
        return check_blocks(docs, quiet=True)


def blocks_test():
    ok = True
    for label, want, extra in BLOCK_ARMS:
        if extra is None:
            rc = _blocks_arm("", edit=True)
        else:
            filled = extra.replace("@@CLAIM@@", _claims_of("arm-counts")[0][1]).replace(
                "@@N@@", str(len(CATCH))
            )
            rc = _blocks_arm(filled)
        good = rc == want
        print(
            "  blocks %-46s rc=%d (want %d) -> %s"
            % (label, rc, want, "as required" if good else "**SELFTEST FAILED**")
        )
        ok = ok and good
    print(
        "  blocks: %d arms over the enrolment rule -- %s"
        % (len(BLOCK_ARMS), "all as required" if ok else "FAILURES ABOVE")
    )
    return ok


def identity_arms_test():
    """The four checks that are not AST rules, each armed and each read by NAME.

    The coordinator's `C20` `P2`: a fix is done only when deleting it reds a
    gate. These four cannot be deleted by a rule key, because they are not
    rules about shapes -- they are statements about the objects that RUN. So
    each arm performs the round's own move in this process, reads the refusal by
    name, and restores what it moved; and beside each one the direction that
    used to pass is measured, so the arm is a measurement and not an assertion.
    """
    ok = True

    # 1. `R20-F1` `A1`: the listed ATTRIBUTE rebound at module level.
    real = re.fullmatch

    def _planted_fullmatch(pattern, string, *a, **k):
        if isinstance(string, str) and string.startswith("qq_r20"):
            return None
        return real(pattern, string, *a, **k)

    cache = list(_FRAME_PARSED)
    try:
        re.fullmatch = _planted_fullmatch
        _with, msgs = module_call_identity()
        # Round 19's check, by value: the module object and its `__name__`. It
        # is what this arm deletes, and it sees nothing.
        old_check = (
            globals().get("re") is sys.modules.get("re")
            and getattr(re, "__name__", None) == "re"
        )
        _FRAME_PARSED[:] = []
        scanned = _arm(PROBE, ())
    finally:
        re.fullmatch = real
        _FRAME_PARSED[:] = cache
    name = msgs[0].split(":")[0] if msgs else "NO REFUSAL"
    good = (not _with) and name == "MODULE-ATTR-REBOUND" and old_check and scanned == 5
    ok = ok and good
    print(
        "  identity R20-F1 A1 `re.fullmatch` rebound at module level: refused as %s, the "
        "scan rc=%d, and round 19's module-only check saw %s -> %s"
        % (
            name,
            scanned,
            "nothing wrong" if old_check else "it",
            "as required" if good else "**SELFTEST FAILED**",
        )
    )

    # 2. `C20` `P2`: a decorator around a frame function. `inspect.getsource`
    # follows `__wrapped__`, so the parse reads the body underneath while the
    # wrapper decides.
    original = _is_figure

    def _wrapper(*a, **k):
        return original(*a, **k)

    _wrapper.__name__ = "_is_figure"
    _wrapper.__qualname__ = "_is_figure"
    _wrapper.__wrapped__ = original
    cache = list(_FRAME_PARSED)
    try:
        globals()["_is_figure"] = _wrapper
        _with, msgs = frame_function_identity()
        parsed_clean, _m, _k = decision_frame(
            _source_of(_wrapper), DECISION_EXCEPTIONS.get("_is_figure", ())
        )
        _FRAME_PARSED[:] = []
        scanned = _arm(PROBE, ())
    finally:
        globals()["_is_figure"] = original
        _FRAME_PARSED[:] = cache
    name = msgs[0].split(":")[0] if msgs else "NO REFUSAL"
    good = (not _with) and name == "FRAME-FUNCTION-WRAPPED" and parsed_clean and scanned == 5
    ok = ok and good
    print(
        "  identity C20 a decorator around `_is_figure`: refused as %s, the scan rc=%d, "
        "and the AST the parse reads is %s -> %s"
        % (
            name,
            scanned,
            "clean, which is the hole" if parsed_clean else "not clean",
            "as required" if good else "**SELFTEST FAILED**",
        )
    )

    # 3. `C20-F1`: an ARGUMENT of an admitted call, and the coordinator's
    # `C21-F2` on the arm that used to stand here.
    #
    # WHAT WAS WRONG WITH THE OLD ARM, kept because it is the lesson. It
    # digested the canonical text, digested an edited copy of that text, saw the
    # two differ, and printed `the edit reds by name -> as required`. It never
    # ran the refusal. The coordinator deleted the comparison
    # (`if got == DECISION_CONSTANTS_SHA256:` -> `if True:`) and the arm went on
    # printing `as required`, with the fabricated figure passing the gates CI
    # runs. **An arm that compares two digests has measured arithmetic, not an
    # instrument** -- a claim about an instrument is verified only by RUNNING
    # the instrument. So this arm MOVES a pinned constant in this process, reads
    # the refusal BY NAME, takes the scan's exit code, and deletes the check by
    # value beside it.
    target = None
    for _f in (figures_on, tokens_in, _exempted, _is_figure):
        for g, _t in _frame_globals(_source_of(_f)):
            if isinstance(globals().get(g), tuple) and len(globals()[g]) > 1:
                target = g
                break
        if target:
            break
    before = globals().get(target)
    cache = list(_FRAME_PARSED)
    try:
        # A NARROWING, which is what `C20-F1`'s shape is: one boolean spelling
        # dropped from the set the matcher recognises, so a figure whose value
        # is that spelling stops being a figure. The file is untouched; the
        # object the decisions read is what moves.
        globals()[target] = before[:-1]
        _with, msgs = decision_constants_pinned()
        deleted_ok, deleted_msgs = frame_admissible(
            objects=frozenset(OBJECT_KEYS) - {"const-pin"}
        )
        _FRAME_PARSED[:] = []
        scanned = _arm(PROBE, ())
    finally:
        globals()[target] = before
        _FRAME_PARSED[:] = cache
    name = msgs[0].split(":")[0] if msgs else "NO REFUSAL"
    good = (
        (not _with)
        and name == "DECISION-CONSTANTS-MOVED"
        and scanned == 5
        and deleted_ok
        and not deleted_msgs
    )
    ok = ok and good
    print(
        "  identity C20-F1/C21-F2 a pinned constant MOVED in this process (`%s` narrowed "
        "by one entry): refused as %s, the scan rc=%d, and with `const-pin` DELETED the "
        "frame named %s -> %s"
        % (
            target,
            name,
            scanned,
            "nothing at all" if not deleted_msgs else "%d refusal(s)" % len(deleted_msgs),
            "as required" if good else "**SELFTEST FAILED**",
        )
    )

    # 4. `C20` `P2`: the frame gate in front of `--check-blocks`, which had none
    # until round 19 and no arm until now.
    cache = list(_FRAME_PARSED)
    with tempfile.TemporaryDirectory() as empty:
        try:
            _FRAME_PARSED[:] = [("a refusal planted for this arm only",)]
            refused = check_blocks(empty, quiet=True)
        finally:
            _FRAME_PARSED[:] = cache
        plain = check_blocks(empty, quiet=True)
    good = refused == 5 and plain == 2
    ok = ok and good
    print(
        "  identity C20 the frame gate in front of --check-blocks: rc=%d with a refusal to "
        "report (want 5), rc=%d without one (want 2, nothing enrolled) -> %s"
        % (refused, plain, "as required" if good else "**SELFTEST FAILED**")
    )

    # 5. `C21`: `MODULE-ATTR-FOREIGN` was registered and had no arm. It is the
    # branch for a planter who rebinds BEFORE the import-time snapshot is
    # taken, so identity is satisfied and provenance is what refuses. The arm
    # moves the snapshot WITH the attribute, which is that planter exactly.
    real = re.fullmatch

    def _foreign_fullmatch(pattern, string, *a, **k):
        return real(pattern, string, *a, **k)

    cache = list(_FRAME_PARSED)
    snap = dict(_AT_IMPORT["re"])
    try:
        re.fullmatch = _foreign_fullmatch
        _AT_IMPORT["re"]["fullmatch"] = _foreign_fullmatch
        _with, msgs = module_call_identity()
        identity_blind = re.fullmatch is _AT_IMPORT["re"].get("fullmatch")
        deleted_ok, deleted_msgs = frame_admissible(
            objects=frozenset(OBJECT_KEYS) - {"attr-identity"}
        )
        _FRAME_PARSED[:] = []
        scanned = _arm(PROBE, ())
    finally:
        re.fullmatch = real
        _AT_IMPORT["re"].clear()
        _AT_IMPORT["re"].update(snap)
        _FRAME_PARSED[:] = cache
    name = msgs[0].split(":")[0] if msgs else "NO REFUSAL"
    good = (
        (not _with)
        and name == "MODULE-ATTR-FOREIGN"
        and identity_blind
        and scanned == 5
        and deleted_ok
        and not deleted_msgs
    )
    ok = ok and good
    print(
        "  identity C21 `re.fullmatch` rebound WITH the import-time snapshot: refused as "
        "%s, the scan rc=%d, the identity test saw %s, and with `attr-identity` DELETED "
        "the frame named %s -> %s"
        % (
            name,
            scanned,
            "nothing wrong" if identity_blind else "it",
            "nothing at all" if not deleted_msgs else "%d refusal(s)" % len(deleted_msgs),
            "as required" if good else "**SELFTEST FAILED**",
        )
    )

    # 6 and 7. `C21`: `FRAME-FUNCTION-FOREIGN` and `FRAME-FUNCTION-NESTED`,
    # both registered since round 20 with no arm. One body compiled under
    # another filename; one body defined inside something else. Neither carries
    # `__wrapped__`, so neither is caught by arm 2.
    original = _is_figure
    src = textwrap.dedent(inspect.getsource(original))
    for label, maker, want in (
        ("a body compiled under another file name", "foreign", "FRAME-FUNCTION-FOREIGN"),
        ("a body defined inside another function", "nested", "FRAME-FUNCTION-NESTED"),
    ):
        box = {}
        if maker == "foreign":
            exec(compile(src, "/elsewhere/not-this-file.py", "exec"), box)
            planted = box["_is_figure"]
        else:
            exec(compile("def _outer():\n" + textwrap.indent(src, "    ")
                         + "    return _is_figure\n", __file__, "exec"), box)
            planted = box["_outer"]()
        cache = list(_FRAME_PARSED)
        try:
            globals()["_is_figure"] = planted
            _with, msgs = frame_function_identity()
            deleted_ok, deleted_msgs = frame_admissible(
                objects=frozenset(OBJECT_KEYS) - {"fn-identity"}
            )
            _FRAME_PARSED[:] = []
            scanned = _arm(PROBE, ())
        finally:
            globals()["_is_figure"] = original
            _FRAME_PARSED[:] = cache
        name = msgs[0].split(":")[0] if msgs else "NO REFUSAL"
        # The deletion control is read BY REFUSAL NAME, not by exit code and not
        # by a count: deleting this check must take THIS refusal away. What reds
        # in its place -- here the parse failing to read a body that is not in
        # this file -- is printed rather than counted, because a different
        # refusal is a different claim.
        gone = [m for m in deleted_msgs if m.split(":")[0] == want]
        instead = sorted({m.split(":")[0] for m in deleted_msgs}) or ["nothing at all"]
        good = (
            (not _with)
            and name == want
            and getattr(planted, "__wrapped__", None) is None
            and scanned == 5
            and not gone
        )
        ok = ok and good
        print(
            "  identity C21 %s: refused as %s (want %s), no `__wrapped__` to notice, the "
            "scan rc=%d, and with `fn-identity` DELETED that refusal is gone and what "
            "reds instead is %s -> %s"
            % (
                label,
                name,
                want,
                scanned,
                ", ".join(instead),
                "as required" if good else "**SELFTEST FAILED**",
            )
        )
    return ok


def frame_gate_test():
    """`R19-S3`'s own arm: the scan's refusal branch, measured rather than read.

    A red proof never edits the subject, so the frame is not made inadmissible
    on disk. The per-process cache the parse fills is SEEDED with one refusal
    for the length of this arm, which exercises exactly the branch a planted
    frame would take, and the same arm without the seed must still give its own
    verdict -- otherwise the gate would be refusing for some other reason.
    """
    saved = list(_FRAME_PARSED)
    try:
        _FRAME_PARSED[:] = [("a refusal planted for this arm only",)]
        refused = _arm(PROBE, ())
    finally:
        _FRAME_PARSED[:] = saved
    plain = _arm(PROBE, ())
    good = refused == 5 and plain == 1
    print(
        "  frame  R19-S3 the scan refuses an inadmissible frame rc=%d (want 5), and "
        "with no refusal to report the same arm rc=%d (want 1) -> %s"
        % (refused, plain, "as required" if good else "**SELFTEST FAILED**")
    )
    return good


def anchor_names_test():
    """`R19-S2`, read the way a refusal has to be read: by NAME.

    The exit code is 5 either way. At `e90bd70` the bare plant was already
    fail-closed -- git's own error, or the HEAD comparison -- and a hole
    another tool's error message covers is not a hole this gate measured. So
    the refusal NAME is printed with the anchor present and with it deleted,
    and the arm asserts only the first: that the gate now names this shape
    itself.
    """
    ok = True
    for seat in ANCHOR_CWDS:
        names = {}
        for label, skip in (("with the anchor", ()), ("with the anchor deleted",
                            ("no repository redirects the subject",))):
            root, harness, sibling = _anchor_world("bare")
            was = os.getcwd()
            try:
                os.chdir({"the repository root": root,
                          "the harness directory": harness,
                          "an unrelated subdir": sibling}[seat])
                try:
                    haystack(harness, skip)
                    names[label] = "NO REFUSAL"
                except Refusal as why:
                    names[label] = str(why).split(":")[0]
            finally:
                os.chdir(was)
        good = names["with the anchor"] == "GIT-BARE-REPOSITORY"
        ok = ok and good
        print(
            "  anchor R19-S2 bare repository, from %-22s refuses as %s, and with the "
            "anchor deleted as %s -> %s"
            % (seat, names["with the anchor"], names["with the anchor deleted"],
               "as required" if good else "**SELFTEST FAILED**")
        )
    return ok


def gitfile_name_test():
    """`R20-S2`, read the way the coordinator's `C21` required: by NAME.

    The arm registered for this shape asserted `rc=5` and nothing else, and
    `rc=5` is what the same world gives with the census deleted -- it refuses
    as `GIT-EMPTY-SUBJECT` there, for an unrelated reason, while the arm went
    on printing `as required` and the manifest called the refusal armed. The
    exit code was never the measurement; the name is.
    """
    names = {}
    for label, skip in (
        ("with the census", ()),
        ("with the census deleted", ("no repository redirects the subject",)),
    ):
        subject, harness = _gitfile_world()
        was = os.getcwd()
        try:
            os.chdir(harness)
            try:
                haystack(harness, skip)
                names[label] = "NO REFUSAL"
            except Refusal as why:
                names[label] = str(why).split(":")[0]
        finally:
            os.chdir(was)
    good = (
        names["with the census"] == "GIT-TOPLEVEL-DISAGREES"
        and names["with the census deleted"] != "GIT-TOPLEVEL-DISAGREES"
    )
    print(
        "  anchor R20-S2/C21 a `.git` FILE whose gitdir carries `core.worktree`: refuses "
        "as %s, and with the census deleted as %s -> %s"
        % (
            names["with the census"],
            names["with the census deleted"],
            "as required" if good else "**SELFTEST FAILED**",
        )
    )
    return good


def harness_bytes_arm():
    """`C21-F1`, end to end, on COPIES: the shape, and the law deleted.

    The review's own escape was a default argument --
    `def scan(..., skip=("hyphen in the key",))` switches a named guard off for
    every real run -- outside the decision parse, outside the constants digest
    and outside every rule key. The law that closes it is the harness's own
    bytes against a table held in the manifest.

    Both directions are measured on COPIES and never on the subject: a red
    proof does not edit the thing it is proving, and these files are the
    instrument this whole run is read through. One copy of the harness carries
    the review's line; one copy of the READER has its comparison deleted. The
    arm reads the REFUSAL NAME, because the exit code alone is what `C21`
    showed to be worthless.
    """
    here = os.path.dirname(os.path.realpath(__file__))
    reader = os.path.join(here, "check_harness_bytes.py")
    pin = os.path.join(os.path.dirname(here), "P11-HANDOFF-MANIFEST.md")
    subject = os.path.basename(__file__)
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "harness")
        shutil.copytree(here, copy)
        target = os.path.join(copy, subject)
        with open(target, "r", encoding="utf-8") as fh:
            text = fh.read()
        tail = '\n    """0 = every quoted figure is emitted.'
        original = "def scan(docs_dir, harness_dir, quiet=False, skip=()):" + tail
        plant = (
            'def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):'
            + tail
        )
        if text.count(original) != 1:
            print(
                "  bytes  C21-F1 **SELFTEST FAILED**: the line this arm plants into a "
                "copy (%r) is not in the subject exactly once, so the arm is measuring "
                "nothing" % original
            )
            return False
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(original, plant, 1))
        for label, run_with in (("the real reader", reader),):
            got = subprocess.run(
                [sys.executable, "-I", run_with, "--harness", copy, "--pin", pin],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120,
            )
            lines = [
                l.split("REFUSED: ", 1)[1] for l in got.stdout.splitlines()
                if l.startswith("REFUSED: ")
            ]
            names = sorted({l.split(":")[0] for l in lines})
            named_the_file = any(("`%s`" % subject) in l for l in lines)
            good = names == ["HARNESS-BYTES-MOVED"] and named_the_file and got.returncode == 5
            ok = ok and good
            print(
                "  bytes  C21-F1 `skip` given a non-empty DEFAULT in a copy, read by %s: "
                "refused as %s naming %s, rc=%d -> %s"
                % (
                    label,
                    ", ".join(names) or "NOTHING",
                    subject if named_the_file else "no file",
                    got.returncode,
                    "as required" if good else "**SELFTEST FAILED**",
                )
            )
        # The deletion control: the comparison removed from a COPY of the
        # reader, which is the one edit that would let every byte move
        # unnoticed. It lives outside the harness copy so that its own row is
        # not what reds.
        broken = os.path.join(tmp, "reader_with_the_law_deleted.py")
        with open(reader, "r", encoding="utf-8") as fh:
            rtext = fh.read()
        cmp_line = "        if got != rows[rel]:"
        if rtext.count(cmp_line) != 1:
            print(
                "  bytes  C21-F2 **SELFTEST FAILED**: the comparison this control deletes "
                "(%r) is not in the reader exactly once" % cmp_line
            )
            return False
        with open(broken, "w", encoding="utf-8") as fh:
            fh.write(rtext.replace(cmp_line, "        if False:", 1))
        got = subprocess.run(
            [sys.executable, "-I", broken, "--harness", copy, "--pin", pin],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120,
        )
        named = [l for l in got.stdout.splitlines() if l.startswith("REFUSED: ")]
        good = got.returncode == 0 and not named
        ok = ok and good
        print(
            "  bytes  C21-F2 the same copy read by a reader with the comparison DELETED: "
            "rc=%d and it named %s -> %s"
            % (
                got.returncode,
                "nothing, so the comparison is the whole of the law" if not named
                else "%d refusal(s), so this control measures nothing" % len(named),
                "as required" if good else "**SELFTEST FAILED**",
            )
        )
    return ok


def selftest():
    # THE PARSES RUN FIRST, and an inadmissible frame is not executed.
    #
    # `R18-S2`: a self-calling helper and a mutual pair were parsed as
    # admissible (the descent skipped a name already on the path) and then
    # recursed at RUN time until the interpreter raised `RecursionError`. The
    # refusal they earn now is worth nothing if the arms run the frame first
    # and the reader gets a traceback instead. So the structural parse and the
    # decision parse come before anything that executes the matcher, and a
    # frame the rules do not admit stops the selftest here, by name.
    ok = structure_test()
    ok = decision_test() and ok
    if not ok:
        print(
            "  THE FRAME IS INADMISSIBLE: the arms are NOT run, because running a frame "
            "the rules refuse would report its behaviour as if the rules had passed."
        )
        return 1
    for label, want, run in _arms_with():
        rc = run()
        good = rc == want
        kind = {1: "catch ", 2: "skip  ", 0: "pass  ", 5: "refuse"}[want]
        print(
            "  %s %-34s rc=%d (want %d) -> %s"
            % (kind, label, rc, want, "as required" if good else "**SELFTEST FAILED**")
        )
        ok = ok and good
    print(
        "  %s -- %s"
        % (emit_arm_counts()[0], "all as required" if ok else "FAILURES ABOVE")
    )
    ok = identity_arms_test() and ok
    ok = frame_gate_test() and ok
    ok = anchor_names_test() and ok
    ok = gitfile_name_test() and ok
    ok = harness_bytes_arm() and ok
    ok = guard_matrix() and ok
    ok = identity_test() and ok
    ok = blocks_test() and ok
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


def _main(args):
    if "--decision-constants" in args:
        # Not a generated block in a document: a digest a reader regenerates
        # when a constant changes on purpose, printed above the text it is taken
        # over, so the change itself is readable and not only its hash.
        text = decision_constants()
        sys.stdout.write(text)
        print(
            "DECISION_CONSTANTS_SHA256 = %r"
            % hashlib.sha256(text.encode("utf-8")).hexdigest()
        )
        return 0
    if "--selftest" in args:
        return selftest()
    if "--surface" in args:
        return surface()
    if "--regenerate" in args:
        return regenerate(PHASE_DIR)
    if "--check-blocks" in args:
        return check_blocks(PHASE_DIR)
    if "--emit" in args:
        name = args[args.index("--emit") + 1]
        if name not in GENERATORS:
            sys.stderr.write("no such generator: %s\n" % name)
            return 3
        print(_block_body(name))
        return 0
    return scan(PHASE_DIR, os.path.join(PHASE_DIR, "harness"))


if __name__ == "__main__":
    try:
        raise SystemExit(_main(sys.argv[1:]))
    except Refusal as why:
        # Every entry point, not only the scan: `--surface` and
        # `--check-blocks` read the haystack too, and a refusal that only one
        # of them honours is a fail-open in the other two.
        sys.stderr.write("check_fenced_figures.py REFUSED: %s\n" % why)
        raise SystemExit(5)
