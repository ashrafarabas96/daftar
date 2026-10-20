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

ROUND 24 REJECTED THE SEVENTH DESIGN FOR THE CAUSE THAT RAN THROUGH ALL SIX:
the candidate was derived SUBTRACTIVELY. Strip the decorations the instrument
had been taught, split on the separators it had been taught, weigh what is
left. Both lists were whitelists. Round 23 widened the splitter from the line
to the whitespace token; round 24 then committed `"k=4242"`, `'k=4242'`,
`a=1;k=4242`, `a=1,k=4242` and `|a=1|k=4242|` on clean clones and ran the whole
authoritative suite green on each, and the coordinator added `&`, `/` and a
bracketed pair list. A straight quote was in no class; a separator that was not
whitespace left one token for a partition on the first `=`.

**So the derivation is INVERTED, and that is the whole of this head's answer.**
There is no stripper of decorations and no table of separators. `_figure_pattern`
describes the FIGURE once -- a key class, `=`, a value class, with the
surrounding characters CONSTRAINED rather than stripped -- and `_candidates`
scans each line for every occurrence of it, wherever it sits and whatever is
around it. What is not a figure is now what FAILS TO MATCH, instead of what the
stripper had not been taught. Thirteen guards went in that commit, and the
fourteen decorated shapes rounds 13 and 14 planted are caught by the shape
itself rather than by fourteen rows. The price on this pack's own prose was
measured before the change was claimed, the way round 13's widening was:
22 candidates became 29, nine of them new, and no true sentence reds.

WHAT IT CHECKS. Every `*.md` anywhere under the phase directory, including
subdirectories. Every occurrence of `key=<number|boolean>` on a line is a
candidate, and the exact token must be one **A CASE OF THIS RUN REQUIRED** --
an expectation of a `kind="value"` case in `proofs.py` or `proofs_b.py` that
PASSED, recorded by `case()` itself in the figure sink the driver creates and
handed here as `--run-capture PATH`. Not in a file under the harness, and not
merely in the run's output: in the set of expectations the run's own cases
asserted. And the document must NAME THE CASE, in brackets on the same line,
because a figure is a figure of something.

WHAT THAT DOES NOT CHECK, first rather than last, because the sentence it
replaces claimed it (`C28-F1`). This gate measures THAT A CASE ASSERTED the
string and passed. It does NOT measure that the case computed the value from
the database: a value case whose subject is a literal --
`SELECT '<figure>'::text` -- passes, writes its row, and legitimises the
figure, and the coordinator drove exactly that to `EXIT_SCRIPT 0` twice with
two different fabricated numbers. So the gate does not promise that anything
would have failed if the number were different; it promises that a case of
this run asserted it, that the case is named beside it, and that the figure
weighed is the one displayed. THE CLOSURE IS KNOWN AND IS NOT HERE: a
figure-bearing case is credible exactly when it REDS under a mutation that
changes the quantity, and this pack already carries `mutations/M*.sql` for
laws. Requiring mutation coverage of every figure-bearing case would make the
claim measured instead of asserted; it is a round of work, it is declared as a
residual at the place the claim is made -- here, the live refusal, and the
conservation row -- and until it exists the price of the attack is a value
case committed into a byte-pinned deciding file, which is what a reviewer
reads in the diff.

`R27-F1` and `R27-F2` are why, and the sentence that stood here until this
round -- the token had to appear in the run's own output -- is the rule
both challengers of round 27 blocked. One `RAISE NOTICE '<literal>'` appended
to a data fixture, one `echo` added to the driver, and one directory named
`/tmp/p11x-<figure>` handed to the driver as `TMPDIR` each carried a
fabricated figure through the whole authoritative pack to `EXIT_SCRIPT 0`: a
printed literal is computed from nothing, and nothing anywhere fails when it
changes. PRINTING IS AS CHEAP AS COMMENTING, which is what the two rounds
before this one blocked (round 25 the committed recordings, round 26 the
suffix whitelist over source text). The ladder of rules this file has held is
kept as its own control: deleting `only an asserted case emits` restores round
26's rule exactly, and deleting `only a run emits` restores `bc54e4c`'s
tree derivation behind it.

What that costs, stated because it is real, and it is a larger cost than the
previous rounds': a figure no case of this run REQUIRES reds, however true it
is and whoever printed it. A measurement of a PAST run, at another commit, can
therefore never be quoted as a figure -- this round re-spelled ten such
occurrences of `rc=0` as prose, because no case of this run requires them --
and a figure of a migration, a fixture or the pack DDL reds unless a case
asserts it (`C26-S2` is withdrawn with the rule it was about). The discharge is
the one the refusal names: have a case assert it, so the case fails when it
changes, and name that case beside the figure.

THE PRECONDITION THE SINK RULE RESTS ON, stated because round 28 measured it
and it was unstated (`R28-S1`). The sink is a file, and the claim this rule
makes is that a COMMIT alone no longer legitimises a figure -- that writing a
row needs access to the measuring host. A committed fixture reaches process
execution on that host: `world.sql` is applied as a superuser, so
`COPY ... TO PROGRAM` runs a shell carrying the server's environment, which
holds `$P11_RUN_CAPTURE`. Round 28 committed exactly that and NO figure was
forged, for two reasons that are both outside this file: the driver creates the
sink with `mktemp` as its own user, mode 0600 (measured: owner `root`, mode
600), and the database server runs as a different OS user which cannot write
it; and the failed `COPY` aborts the fixture under `ON_ERROR_STOP` before the
gate runs. So the rule holds under the precondition THE SINK'S OWNER IS NOT THE
DATABASE'S OS USER, and a deployment that ran the driver as the database's own
user, or left the sink group-writable, would have the row written and weighed.
That is a precondition, not a closure, and `R27-S5` still stands beneath it:
what ties a row to the `case()` call that wrote it is the driver's process
lineage, which nothing executable here can verify.

NORMALISATION, in seven steps, in this order, each one separately deletable
and separately measured:

  0. **HTML CHARACTER REFERENCES RESOLVED**, first, so a reference TO a
     full-width `=` is resolved and then folded by the step below.
     `k&#61;4242`, `k&#x3d;4242`, `k&equals;4242` and `k=&#52;242` all render
     to the figure a reader sees -- two independent CommonMark renderers agree
     -- and each walked the whole suite green at `36c9094`, committed, on a
     clean tree (the coordinator's `C25-F1`). An entity is a SPELLING of the
     figure, which is this function's department, and markdown passes raw HTML
     through, which is the same surface the comment-marker guard exists for.
     `html.unescape` does it: the standard's whole table and its own parsing
     rules, rather than a list of reference names of mine, which is the
     difference between a normalisation and an enumerated exemption. Measured
     cost on this pack's nine documents before the fix was claimed: 0 lines
     changed.
  1. **NFKC**, which maps the full-width `＝` and the compatibility forms of
     the digits to their ASCII spellings.
  2. **EVERY COMBINING MARK DROPPED, WHEREVER IT SITS** (`Mn` and `Me`, after a
     canonical decomposition, so a mark already composed into its letter is
     reached too). `R28-F1`: a mark adds no grapheme of its own, so
     `axes=3` + U+0301 + `00` RENDERS as `axes=300` and the matcher weighed
     `axes=3` -- a figure a case really did require, correctly cited, on a line
     displaying a hundred times it. Round 27 had closed only the marks that
     TOUCH the `=` (the coordinator's `C27-S1`, where NFKC leaves a space and a
     mark), which was an enumerated exemption BY POSITION: it moved the hole to
     mid-value and to the key side, where NFKC composes the mark into the letter
     and the key class then refuses the line altogether. The rule has no
     position in it now, and the cost is disclosed: an accented word is weighed
     as its unaccented spelling, so `livé=4242` is a candidate -- which is the
     direction to fail in, since a figure weighed and found legitimate is an
     outcome while one never weighed is a fail-open. Measured cost on this
     pack's nine documents before the fix was claimed: 9 candidates either way,
     no document differing. Four arms: the mark that truncates a value a case
     required, inside the value, on the key side of the `=`, and inside the key.
  3. **Format characters deleted** (Unicode category `Cf`), which is where
     U+200B ZERO WIDTH SPACE goes. NFKC does not remove it.
  4. **WHITESPACE THAT TOUCHES THE `=` DELETED**, by Unicode category (`Zs`,
     `Zl`, `Zp`, `Cc`, `Cf`) and not as a list of characters. `R26-F1`: the
     matcher required the key, the `=` and the value to be ADJACENT, so
     `rows = 81737` was not weighed at all, and three fabricated figures in
     that spelling -- the spelling this pack's own padded output prints --
     walked the whole authoritative suite to `EXIT_SCRIPT 0`. It is round 14's
     class: the zero-width space before the value was closed then by deleting
     `Cf`, and the VISIBLE sibling of that shape was left open. Step 0 made it
     worse in one direction, because `&nbsp;` resolves to U+00A0 and NFKC folds
     it to a plain space -- a normalisation that moves a shape OUT of the
     matcher's reach. The same rule is applied to the HAYSTACK under
     `the same spelling on both sides`, so a run that prints `rows = 59` emits
     the figure `rows=59`. Measured cost on this pack's own nine documents
     before the fix was claimed: the 17 rows of the `--surface` inventory,
     which wrote its probe shapes with spaces around the `=` BECAUSE the
     matcher refused them. That block prints the key and the value in two
     columns now and writes no `=` at all; the generator does not depend on a
     hole any more. One arm per spelling: space, tab, both sides, no-break
     space, narrow no-break space, `&nbsp;`, and the padded shape.
  5. **Arabic-Indic and Extended Arabic-Indic digits mapped to ASCII**, which
     NFKC also does not do: U+0669 has no compatibility decomposition. The
     owner's Arabic report writes every figure he reads in these digits, so
     this is the spelling the documents actually use, not an exotic one.
  6. **The boolean set, closed**: `true`, `false`, `t`, `f`, in any case, and
     nothing else. `t` and `f` are what `psql` prints, which is what these
     documents transcribe, and the previous class claimed booleans while
     admitting one spelling of two.

Steps 1-5 are the same cause as **Phase 6's open `G-A`**, where a mistyped key,
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

  * UPPERCASE keys (`GIT_DIRTY_AFTER=0`). In these documents those are shell
    commands and log keys, not a case's output. The key class is lower-case and
    the left boundary refuses a key that is the TAIL of a longer identifier, so
    `FABRICATED_count=999` is not a candidate either, and an arm says so.
  * A LOWER-CASE SEGMENT AFTER A HYPHEN inside a longer mixed-case identifier.
    The left boundary admits a key that begins after a hyphen, because that is
    how a long option (`--port=5`) and an html comment (`<!--k=9-->`) are
    written, so `EXIT_FOR_M10-noop=4` yields the candidate `noop=4`. That is a
    FALSE RED if a document ever writes such a shape with a value nothing
    emits; no document writes one OUTSIDE A CODE SPAN today, which was measured
    rather than assumed -- the coordinator's `C25-S6` found two lines that do
    write it inside one, where the matcher never sees them -- and
    it is a residual rather than a bound because closing it would reopen the
    long option.
  * A figure that survives only inside an INLINE CODE SPAN. This is the
    BACKTICK RULE, it is deliberate, and round 24 names it among the bounds it
    is not attacking: this pack quotes its own counter-examples, and
    `superuser_sees=130` is the law's own illustration of a figure nothing
    emits while `fabricated_count=999` is every round's probe token. What
    deleting the guard would cost is GENERATED, not written here: the
    `backtick-cost` block in the manifest runs the gate with this guard deleted
    and prints the document lines and distinct tokens that would red
    (`C25-S7`: the figure that used to stand here was hand-written, matched no
    number any command printed, and was repeated in the published record).
    Round 25 recommends taking the removal and both reviewers leave the call to
    the author; it is the next round's single change, because this commit
    already moves what makes a figure legitimate twice and three changes to one
    unit in one commit cannot be told apart (`R25-S1`). A figure with PROSE on
    the line is no longer in this list: round 23 closed it.
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
  * A VALUE THAT DOES NOT END WHERE THE FIGURE WOULD. The right boundary
    refuses a value followed by any of `[0-9A-Za-z_-]`, so this is a CLASS and
    not the two members of it that were named here before (`R25-S2`):
    `date=2026-10-19` is not the figure `date=2026`, and `k=7731_` and
    `k=7731x` are not figures at all. Refusing rather than reporting a year is
    the point; an arm says so.
  * A FORMAT CHARACTER BETWEEN AN ALPHANUMERIC AND A KEY (`C25-S3`). Deleting
    a `Cf` character, which step 2 above does, can glue the character before it
    to the key -- `a=1<U+200B>k=4242` becomes `a=1k=4242` -- and the left
    boundary then reads one longer identifier and refuses both pairs. The price
    of the attack is a line that reads as run-together mojibake to a human.
  * A VALUE ON THE NEXT LINE (`C25-S4`). The matcher is per LINE, which is
    said here rather than implied: `k=` on one line and `4242` on the next is
    not a candidate, though markdown reflows the paragraph and a renderer shows
    `k= 4242`.
  * **The haystack is a substring match over one blob**: a token emitted
    anywhere for any reason passes everywhere, so `identities=2` printed by one
    case legitimises `identities=2` written about another. Narrowing it to the
    emitting case is a convention, not a check. What the blob holds is now
    stated POSITIVELY: the files this tree can RUN (`.py`, `.sh`, `.sql`) and
    nothing else. A recording of a run is not an emission, and while
    recordings counted -- forty-four of sixty-six files -- anyone who could
    type a file here could legitimise any figure: round 25's `R25-F1`, ruled a
    blocker, and realised at `36c9094` by this pack's own probe transcript.
    Round 25 also named why the first form of the fix was wrong: excluding
    `.txt` moves the hole from shape to TIME, since the next recording arrives
    under the next suffix.
  * **The transcripts are not SCANNED either.** They are committed, they carry
    figures, and nothing weighs their own (`R17-S3`). Round 25's second
    suggestion is to scan them as documents, which would close that in the same
    move; it is the next round's change and not this one's, because it widens
    what the gate WEIGHS rather than narrowing what legitimises, and that is a
    different measurement.
  * **`backtick-cost` is the first generated block that depends on the
    DOCUMENTS**, so any document edit moves its numbers and `--check-blocks`
    reds until `--regenerate` runs. Deliberate -- it is round 15's discipline
    applied to the one figure `C25-S7` found hand-written -- and it costs a
    reader this: a blocks finding on a tree whose documents were just edited is
    usually a stale count, not an attack.
  * **The shell's two untracked sites are UNARMED** (`C25-S5`): no arm
    anywhere in this pack executes `rebuild_and_prove.sh`, so every refusal it
    raises is in that position, and in both deletion worlds the two readers
    still refused. Stated, not claimed closed.
  * **`SELF-READ-DIR-ABSENT`, `SELF-UNTRACKED-UNREADABLE` and
    `HARNESS-HEAD-DISAGREES` are UNMEASURED-at-runtime** (`R25-S3`): they are
    registered refusals with no arm that reads them by name. Not dead --
    unmeasured, which is a different sentence.
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
for every red shape is named above -- an inline code span -- and it requires
no waiver list, which would move the hole from shape to time.

AND IT REFUSES TO BE INERT. If the scan finds no candidate at all, the matcher
has stopped matching the documents it is pointed at, and a check that measures
nothing must not report a pass. That is exit 2.

EXITS: 0 clean, 1 a figure nothing emits, 2 inert, 4 invoked without `-I`,
5 a NAMED REFUSAL -- git absent, or the harness in no repository, so the
haystack cannot be derived from a commit; or the work tree is not the tree the
commit holds, by bytes and by modes (`SELF-TREE-DIRTY`), or a tracked path is
flagged so that git stops looking (`SELF-INDEX-FLAGGED`), or a directory this
run READS carries a file the commit does not hold (`SELF-TREE-UNTRACKED`, the
coordinator's `F1` on `50a45a0`: an untracked `.sql` beside the frozen
migrations was APPLIED, because `run_migrations.py` lists the directory, and
the whole suite was green). It never falls back to the walk.

ITS RED PROOFS, in layers. `--selftest` runs **every shape any round
planted**, each as its own hermetic arm with its expected exit, plus the false
positives round 13 measured as arms that must now come back clean, and then
deletes each guard in turn and requires it to flip an arm -- the guards over
the haystack among them, so "derived from the commit" is measured by a scratch
file and a gitignored `.pyc` that must not legitimise a plant, and by a
directory that is no repository and must be refused. It then parses the
spelling normaliser and the decision frame for a transformation or a
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
import contextlib
import hashlib
import html
import inspect
import io
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
_SNAPSHOT_MODULES = ("re", "os", "unicodedata", "html")
_AT_IMPORT = {m: dict(vars(sys.modules[m])) for m in _SNAPSHOT_MODULES}

PHASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── the decoration, and the spellings ───────────────────────────────────────
# Each pattern here exists because a round planted a figure behind it; none is
# a guess about markdown.
CODE_SPAN = re.compile(r"`[^`]*`")

# ── the figure, described once ───────────────────────────────────────────────
# `R24-F1`, and it ends a class of finding that ran from round 13 to round 24.
# Every design before this one derived a candidate SUBTRACTIVELY: strip the
# decorations the instrument had been taught, split on the separators it had
# been taught, and hope each piece was one token. Both were whitelists, and
# this project has ruled three times that a whitelist of FORMS reopens on the
# next form. Round 24 drove five shapes through, each one COMMITTED on a
# throwaway clone with a clean tree and the whole authoritative suite green:
# `"k=4242"`, `'k=4242'`, `a=1;k=4242`, `a=1,k=4242` and `|a=1|k=4242|`. A
# straight quote was in no `LEAD_*` or `TRAIL_*` class, and a separator that is
# not whitespace left one token for a partition on the first `=`.
#
# So the derivation is INVERTED, which is the coordinator's binding ruling and
# the challenger's own prescription. There is no stripper of decorations and no
# table of separators: `_figure_pattern` describes the FIGURE, and `_candidates`
# scans the line for every occurrence of it, wherever it sits and whatever
# surrounds it. What is NOT a figure is now what fails to match, instead of
# what the stripper had not been taught. Thirteen guards go in this commit --
# not because anything excuses the shapes they used to catch, but because the
# shape itself catches them, and a guard that reds nothing is deleted or armed.
#
# The two boundaries are what remains of "the surrounding characters", and they
# are ASYMMETRIC on purpose, each half measured by its own arm:
#   * on the LEFT a hyphen is a separator -- `--port=5` is a long option and
#     `<!--k=9-->` an html comment -- so a key may begin after one, and what the
#     boundary refuses is a key that is the TAIL of a longer identifier
#     (`FABRICATED_count=999` is the uppercase-key bound, not a figure);
#   * on the RIGHT a hyphen belongs to the value's own shape -- `date=2026-10-19`
#     is a date and not the figure `date=2026` -- so a value may not end before
#     one.
KEY_START = r"(?<![0-9A-Za-z_])"
VALUE_END = r"(?![0-9A-Za-z_-])"
# The CONTROL the `positive scan` guard is measured against: the candidate unit
# exactly as it stood at `50a45a0`, a whitespace-separated token. Deleting the
# guard restores it, and round 24's five shapes red.
TOKEN = r"[^\s]+"

# The boolean set, closed, as the alternation the value class carries. `t` and
# `f` are what psql prints.
BOOLEANS = "true|false|t|f"
BOOLEANS_UNNORMALISED = "true|false"

# Two tokens exempted by exact name, on the coordinator's R14-S2 ruling.
# `R25-F1`. The suffixes of files this tree can RUN, which is what `emits`
# means: the proof suites and the race programs (`.py`), the driver (`.sh`) and
# the DDL and worlds the run applies (`.sql`). Nothing else under the harness
# emits anything -- a transcript records, a `.gitignore` configures -- and a
# file whose suffix is not here is outside the haystack whatever it is named,
# which is how this avoids being a list of names that reopens on the next one.
EMITTING_SUFFIXES = (".py", ".sh", ".sql")

EXEMPT = ("port=55512", "migrations=87")

# `R26-F1`. The whitespace a figure may be written with around its `=`, BY
# CATEGORY and not as a list of characters: `Zs` is every space separator Unicode
# has, `Zl` and `Zp` the line and paragraph separators, `Cc` the control
# characters a tab and a vertical tab are, and `Cf` the format characters round
# 14 closed on their own. A list of four characters would move the hole from
# SHAPE to TIME on the fifth, which is this phase's own standing lesson.
WHITESPACE_CATEGORIES = ("Zs", "Zl", "Zp", "Cc", "Cf")

# `R28-F1`. The marks that render as part of the character before them and add
# no grapheme of their own: nonspacing (`Mn`) and enclosing (`Me`). As a
# category pair rather than a list of marks, for the reason every class in this
# file is a category.
COMBINING_CATEGORIES = ("Mn", "Me")
# The coordinator's `C29-S1`. ONE CLASS, TWO DOCTRINES, and the second one is
# not deletion. `_strip` deletes every `Cf`, which round 14 settled for the
# zero-width hiding characters: deleting is right there because the display
# does not change. For the EXPLICIT BIDI FORMATTING characters it is wrong.
# They reorder what is displayed, so deleting one leaves this gate weighing
# `axes=123` while a reader sees `axes=321` -- the figure weighed is not the
# figure displayed, which is this phase's own standing promise and `R28-F1`'s
# rule in the one subclass that round did not reach.
#
# The set is DERIVED BY RUNNING `unicodedata.bidirectional` over every `Cf`
# codepoint, not listed: a list would be one more enumeration of the kind
# `C29-F1` just measured, and the Unicode tables this interpreter carries are
# the authority on which characters reorder text.
#
# The doctrine is REFUSAL, not deletion: a candidate line carrying one of them
# is reported by name (`BIDI-CONTROL-IN-A-CANDIDATE`), because a figure whose
# displayed value depends on an invisible character is not a figure a reader
# can check, whichever way it is weighed. The coordinator measured that the
# attack has no payload at this head -- every `key=digits` expectation of this
# run is a SINGLE digit, and one digit cannot be reordered -- which is a
# property of the data and not of the rule, and is why this is a residual
# closed here rather than a blocker.
BIDI_FORMATTING = ("LRE", "RLE", "PDF", "LRO", "RLO", "LRI", "RLI", "FSI", "PDI")
BIDI_CONTROLS = tuple(
    chr(cp)
    for cp in range(0x110000)
    if unicodedata.category(chr(cp)) == "Cf"
    and unicodedata.bidirectional(chr(cp)) in BIDI_FORMATTING
)

# `R28-F1`, and it is `C27-S1` MEASURED AGAIN FROM THE OTHER SIDE. The
# coordinator's residual was that `NFKC` expands some fifty compatibility
# characters -- `U+00B4` ACUTE ACCENT, `U+00A8` DIAERESIS, `U+00AF` MACRON --
# into a space AND A COMBINING MARK, and that round 27 deleted the space beside
# the `=` and left the mark, so a figure written with one of them was not a
# candidate at all. Round 27 answered it by widening the class deleted BESIDE
# THE `=` to include the marks, and round 28 measured that fix and rejected it:
#
#     axes=3<U+0301>00   cited correctly   the reader sees `axes=300`
#                                          the matcher weighed `axes=3`
#                                          -- which a case really did require
#
# A mark that does not TOUCH the `=` was never deleted, and the value class
# holds no mark, so the match stopped at the first digit: the gate passed a
# document displaying a figure a hundred times the one any case required, with
# the right case named beside it. The same from the key side, where `NFKC`
# COMPOSES the mark into the letter (`live` + `U+0301` -> `livé`) and the key
# class refuses it, so the line was not weighed at all.
#
# So the round-27 fix was AN ENUMERATED EXEMPTION BY POSITION: it closed the
# position beside the `=` and moved the hole to mid-value and key-side, which is
# this phase's own lesson about moving a hole rather than closing it, and
# `R28-F1` is `a PROJECTION is not an IDENTITY` reopened one position over --
# the string weighed was a projection of the string SEEN, made equal to it at
# the `=` alone.
#
# What replaces it has no position in it: the line is decomposed canonically and
# EVERY nonspacing (`Mn`) and enclosing (`Me`) mark is dropped WHEREVER IT SITS,
# before anything decides what a candidate is, so the figure the gate weighs is
# the grapheme string a reader sees. The whitespace class above goes back to
# whitespace: with the marks gone before it runs, adding them to it would red
# nothing, and a guard that reds nothing is deleted or armed with no third
# option.


def _breaks_a_line(c):
    """Does this character end a line? Asked of Python rather than listed."""
    return len(("a" + c + "b").splitlines()) > 1


# `R26-F1`'s own second measurement, found by reading the verdict's inventory
# rather than by a reviewer: the categories above include the LINE
# TERMINATORS, and the haystack is one blob of text. Deleting a newline that
# touches an `=` therefore JOINS the line that ends in `=` to the line below
# it, so a capture holding `total=` at the end of one line and `55` at the
# start of the next would emit `total=55` -- a figure no run printed on any
# line. The class is whitespace WITHIN a line, and which characters end a line
# is DERIVED BY EXECUTION (`str.splitlines`, the same rule the readers split
# on) over the whole range the terminators live in, rather than written out as
# a list of six that reopens on the seventh.
LINE_TERMINATORS = frozenset(c for c in map(chr, range(0x3000)) if _breaks_a_line(c))


def _drop_marks(s):
    """The line with every combining mark gone, wherever it sat.

    `R28-F1`. The figure the gate weighs must be the grapheme string a reader
    SEES, and a nonspacing mark is exactly a character that adds no grapheme of
    its own: `axes=3` + `U+0301` + `00` renders as `axes=300` and matched
    `axes=3`. The line is decomposed canonically FIRST, because a mark may
    already be composed into its letter -- `NFKC` turns `live` + `U+0301` into
    the single codepoint `livé`, which is how the key-side variant escaped
    weighing entirely -- and `Mn` and `Me` are then dropped by CATEGORY, with no
    position in the rule and no list of marks to reopen on the next one.

    The cost is that an accented word is weighed as its unaccented spelling, so
    `livé=4242` is a candidate. That is the direction this gate should fail in:
    a reader seeing `livé=4242` reads a figure, and a figure that is weighed and
    found legitimate is the outcome, while one that is never weighed is the
    fail-open this finding was.
    """
    return "".join(
        c
        for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) not in COMBINING_CATEGORIES
    )


def _close_equals(s):
    """The line with the whitespace that TOUCHES an `=` deleted.

    `R26-F1`, a fail-open round 26 drove end to end: the matcher required the
    key, the `=` and the value to be ADJACENT, so `rows = 81737` was never
    weighed -- not weighed and found legitimate, not weighed at all. Three
    fabricated figures in that spelling walked the whole authoritative suite to
    `EXIT_SCRIPT 0`.

    It is round 14's class, not a new one. A zero-width space before the value
    was closed then by deleting category `Cf`; the VISIBLE sibling of that shape
    was left open, and this round's first normalisation step made it worse in
    one direction, because `&nbsp;` and `U+00A0` are folded by NFKC into exactly
    the spelling the pattern could not see. A normalisation that moves a shape
    OUT of the matcher's reach is not a normalisation of a spelling.

    Deleting whitespace adjacent to the `=` rather than admitting it in the
    PATTERN is deliberate: the candidate a verdict then reports is the figure's
    one canonical spelling (`rows=81737`), which is the string the haystack is
    searched for, so a reader is not shown one spelling and told about another.
    The same rule is applied to the haystack under `the same spelling on both
    sides`, because a run that PRINTS `rows = 59` emits that figure.

    `C27-S1` widened the class this deletes from WHITESPACE to WHAT ADVANCES
    NO WIDTH, because `NFKC` expands some fifty compatibility characters into a
    space and a combining mark and only the space was being deleted. Measured
    over the nine documents this gate scans, as written and with the wider
    class: **9 candidates either way**, no document differing -- the fix is free
    here, and `total=\u00b455`, `total=\u00a855` and `total=\u00af55` are candidates now
    where they were invisible before.

    The pack's own prose was measured BEFORE this was claimed as a fix, and the
    figure here was WRONG for one round: it said 42 where the measurement is
    38, and the coordinator's `C27-F1` named it. Re-measured with this file's
    own `tokens_in` over `bc54e4c`'s nine documents, this step deleted and
    present: **21 candidate occurrences become 38** (19 distinct), a delta of
    17, of which the `--surface` inventory's own seventeen rows were the bulk -- that block
    wrote its probe shapes with spaces around the `=` precisely because the
    matcher refused them, which is a generator that depended on the hole. It
    names the key and the value in two columns now and writes no `=` at all.
    """
    chars = list(s)
    n = len(chars)
    keep = [True] * n

    def padding(c):
        # Whitespace WITHIN a line. The combining marks `C27-S1` put here for
        # one round are gone from this class and dropped everywhere instead
        # (`R28-F1`). A line terminator is not padding, because deleting one
        # would join two lines into a figure neither of them carries.
        return (
            unicodedata.category(c) in WHITESPACE_CATEGORIES
            and c not in LINE_TERMINATORS
        )

    for i, c in enumerate(chars):
        if c != "=":
            continue
        j = i - 1
        while j >= 0 and padding(chars[j]):
            keep[j] = False
            j -= 1
        j = i + 1
        while j < n and padding(chars[j]):
            keep[j] = False
            j += 1
    return "".join(c for c, k in zip(chars, keep) if k)


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
    "html character references",
    "nfkc",
    "combining marks",
    "format characters",
    "whitespace around the equals",
    "non-ascii digits",
    "html comment markers",
    "inline code span",
    "positive scan",
    "key boundary",
    "value boundary",
    "figure value class",
    "boolean spellings",
    "signed values",
    "percent in the value",
    "hyphen in the key",
    "key class",
    "boolean case folding",
    "named exemptions",
    "planted tokens",
    # The coordinator's `C29-S1`. Not a guard over what the matcher WEIGHS --
    # it decides whether the line is a figure a reader can check at all -- but
    # it is deleted and measured exactly like the others, and the two arms it
    # reds are figures a case of this run really required.
    "bidi controls",
)

# The guards over the HAYSTACK -- over what counts as something this tree
# emits, rather than over what a line says. They are listed apart because the
# paragraph above is about `figure_on`, and they are deleted and measured by
# `--selftest` in exactly the same way: each one reds an arm by name or the
# phase stops.
HAYSTACK_GUARDS = (
    # `R27-F1`, round 27's blocker, measured end to end by BOTH challengers:
    # round 26 made a figure legitimate because A RUN PRINTED it, and printing
    # is as cheap as commenting. `TMPDIR=/tmp/p11x-ledger_sweep=81737` put the
    # capture's own path into the capture; a `RAISE NOTICE 'spectre=7722'` in a
    # data fixture, and an `echo` in the driver, each carried a fabricated
    # figure through the whole authoritative pack to `EXIT_SCRIPT 0`. The
    # printed string is a LITERAL: it is computed from nothing, and no
    # assertion anywhere would fail if the number were different.
    #
    # So printing is not the criterion. A figure is legitimate when a CASE
    # REQUIRED it: the proof suites' `case(..., expect, kind="value")` fails,
    # and the suite exits non-zero, if the measured value does not contain
    # `expect`. Every value case that PASSES writes one row per expectation
    # line into the FIGURE SINK -- suite, case identifier, `key=value` -- and
    # this guard makes those rows, and nothing else, the haystack. A fixture
    # cannot write a row; an `echo` cannot; an environment variable cannot;
    # and a case whose number differed would not be in the sink, because it
    # would not have passed.
    #
    # Deleting this guard restores round 26's rule exactly -- the whole text of
    # the capture, whatever wrote it -- which is what makes the notice arm and
    # the echo arm below a measured FLIP rather than a claim.
    "only an asserted case emits",
    # `R26-S1`, ruled a blocker by the coordinator after the second
    # challenger measured the previous rule end to end: a `#` comment in an
    # instrument, and a committed `.py` that nothing imports or runs,
    # legitimised a fabricated figure and the whole authoritative pack reached
    # `EXIT_SCRIPT 0`. It shipped open in a second way too -- eleven of the
    # admitted files were `M*.sql` mutation worlds the authoritative run never
    # applies, and a `--` comment in one of them backed a figure.
    #
    # The direction of round 25's fix was right and its KIND of authority was
    # not: `.py`, `.sh` and `.sql` was a whitelist over SOURCE TEXT, and source
    # text is alterable text. So round 26 made the haystack THE OUTPUT OF THE
    # RUN, captured outside the work tree and handed to this gate as
    # `--run-capture`: a comment prints nothing, a file nothing runs prints
    # nothing, a mutation world that is never applied prints nothing, and a
    # recording of an older run carries another commit's `RUN_HEAD` and is
    # refused by name. That rule is the MIDDLE RUNG now, superseded by
    # `only an asserted case emits` above it, because printing turned out to be
    # as cheap as commenting (`R27-F1`). It still decides every one of those
    # shapes, and this entry still reds the arms that are about WHICH FILE
    # emits.
    #
    # Deleting this guard restores the ENTIRE tree-derived haystack of
    # `bc54e4c` -- the commit derivation, the suffix whitelist, the anchor and
    # the stem exclusion -- which is what the file-shaped arms below are
    # measured against.
    #
    # `R27-F1` added a THIRD rule above these two, and the three are a LADDER
    # read in the order the rungs were built, not a chain of short circuits:
    # deleting THIS entry drops to the tree derivation whatever the entry above
    # says, so each guard still reds the arms that are about it. Round 26's
    # rule -- the whole text of the capture -- is the middle rung, restored by
    # deleting `only an asserted case emits` alone. Without that ordering the
    # sink would be read first in every world, this entry would red nothing,
    # and a guard that reds nothing is deleted or armed with no third option.
    "only a run emits",
    # The spelling rule, applied to the haystack as well as to the line, under
    # a name of its own so one entry decides one site: a run that prints
    # `rows = 59` emits the figure `rows=59`, and without this the whitespace
    # class of `R26-F1` would red every figure the pack's own padded output
    # reports.
    "the same spelling on both sides",
    # `haystack from the commit`, `only what can run emits` and `the checker is
    # not its own evidence` stood here and are DELETED, not carried. Each one
    # was a rule about which FILES emit, and no file emits any more: with
    # `only a run emits` present, deleting any of the three changed no verdict
    # anywhere, and a guard that reds nothing is deleted or armed with no third
    # option. All three behaviours survive as the CONTROL that deleting
    # `only a run emits` restores -- the commit derivation, the suffix
    # whitelist and the stem exclusion, exactly as they stood at `bc54e4c` --
    # and the arms that measured them (a markdown file, a committed
    # transcript, an untracked `.py`, a gitignored `.pyc`, the checker's own
    # prose) still red, against the rule that decides them now.
    #
    # The census stays a guard of its own: the capture is held against THIS
    # commit, so which repository the head is resolved from still decides a
    # verdict, and the anchor arms read the difference by name.
    # The suffix whitelist `only what can run emits` stood here for one round
    # and is DELETED with the three entries above it, for the reason the second
    # challenger of round 26 measured: `.py`, `.sh` and `.sql` is a whitelist
    # over SOURCE TEXT. It survives as part of the control, in `keep()`, where
    # deleting `only a run emits` restores it; and round 25's own arm -- a
    # committed transcript -- still reds, against the rule that decides it now.
    "no repository redirects the subject",
)

GUARDS = MATCHER_GUARDS + HAYSTACK_GUARDS

# `R24-F1`. `SUBSUMED` is gone with the thirteen decoration guards it was
# about: it existed because splitting a line on whitespace took the last arm
# away from `LEAD_LIST` and `MARKER`, and neither guard exists any more. The law
# it was the arming of still stands and is now unconditional -- a guard that
# reds nothing is DELETED or ARMED, with no third option and no entry to sit in.

def _key_class(skip=()):
    """The key's character class, as the one place that decides it."""
    hyphen = "[a-z][a-z0-9_]*" if "hyphen in the key" in skip else "[a-z][a-z0-9_-]*"
    return "[^=]+" if "key class" in skip else hyphen


def _value_class(skip=()):
    """The value's character class: a number in any digit family, or a boolean."""
    sign = "" if "signed values" in skip else "[-+]?"
    pct = "" if "percent in the value" in skip else "%?"
    num = sign + "[0-9](?:[0-9,._]*[0-9])?" + pct
    words = BOOLEANS_UNNORMALISED if "boolean spellings" in skip else BOOLEANS
    bools = "(?:" + words + ")" if "boolean case folding" in skip else "(?i:" + words + ")"
    return ".+" if "figure value class" in skip else num + "|" + bools


def _figure_pattern(skip=()):
    """The ONE pattern this file calls a figure, built from the named guards.

    `R24-F1`: the scan below and `_is_figure` are now the SAME description of a
    figure, built here once, so a shape cannot be a candidate under one and not
    under the other -- which is how every finding from round 13 to round 24 was
    possible. Nothing in it is a list of the places a figure may sit.
    """
    lead = "" if "key boundary" in skip else KEY_START
    tail = "" if "value boundary" in skip else VALUE_END
    return lead + "(?:" + _key_class(skip) + ")=(?:" + _value_class(skip) + ")" + tail


def _candidates(line, skip=()):
    """Every occurrence of a figure on the line, wherever it sits.

    A POSITIVE SCAN, and the whole of `R24-F1`'s answer. There is no decoration
    to strip and no separator to know: `re.findall` returns each place the
    figure's own description matches, so a quote, a semicolon, a comma, a pipe, a
    table cell, a bullet, a heading, a bracket, a label, an emphasis run and a
    `--` marker are all handled by not being part of the figure. Only the
    SPELLINGS are still normalised first, by `_strip`, because a full-width `=`
    and an Arabic-Indic digit are the same figure written differently rather
    than a figure with something around it.

    The first branch is the CONTROL the `positive scan` guard is measured
    against: with the guard deleted the unit is a whitespace-separated token
    again, exactly as at `50a45a0`, so round 24's own shapes and the fourteen
    decorated shapes rounds 13 and 14 planted all red. The two scans are two
    call sites of one admitted module call, and rule 5 names them separately --
    one by the guard that wraps it, one by nothing -- because an entry admits
    exactly one site and two sites under one entry is a call nobody read.

    Written as two returns rather than as one call on a pattern chosen above it
    because the frame's descent follows four levels, and a function whose only
    work is to choose between two constants spends one of them.
    """
    if "positive scan" in skip:
        return re.findall(TOKEN, _strip(line, skip))
    return re.findall(_figure_pattern(skip), _strip(line, skip))


def _is_figure(s, skip=()):
    """Is `s` a bare `key=<number|boolean>`? The narrowest part of the design.

    The ONLY decisions here that are not behind a named guard are that the
    string contains an `=` with text on both sides -- which is not a guard but
    the shape the review arm is about.

    Since `R24-F1` this decides with the SAME pattern the scan uses, anchored,
    and that has a consequence worth stating rather than leaving for a reader:
    under the positive scan a candidate already matched that pattern, so this
    call cannot reject one. It is not therefore ornamental and its guards are
    not therefore unmeasured -- they are measured through `_figure_pattern`,
    which is what the scan FINDS with, and the guard matrix reads them there.
    What this function is still needed FOR is the control branch: with
    `positive scan` deleted a candidate is a whitespace-separated token again
    and something must decide whether that token is a figure. The partition is
    kept because it is the shape the review arms are planted against, and
    because `identity_test` requires that with every guard skipped the only
    decision left is an `=` with text on both sides.
    """
    if "=" not in s:
        return False
    key, _, val = s.partition("=")
    if not key or not val:
        return False
    if "key class" not in skip:
        keyre = _key_class(skip)
        if not re.fullmatch(keyre, key):
            return False
    if "figure value class" in skip:
        return True
    return bool(re.fullmatch(_value_class(skip), val))


def _strip(line, skip=()):
    """The line with its SPELLINGS normalised. No decoration is removed here.

    EVERY transformation in this function is behind a named guard, with no
    exception, which is what makes the completeness claim testable rather than
    asserted: with every guard skipped this function is the identity, and
    `--selftest` checks exactly that over a probe of every shape. An
    unconditional transformation -- a case fold, a strip, a new rule added in
    a hurry -- shows up there as a difference, which is how `R14-F1` would
    have been found by the instrument instead of by a reader.

    `R24-F1` emptied this function of its decoration rules. Ten leading and
    trailing patterns, the `--` marker split and the whitespace split are gone,
    because the positive scan does not care what sits around a figure. Four
    guards remain and each one is a SPELLING: a shape it normalises is the same
    figure written differently, which the scan would otherwise miss for a reason
    that has nothing to do with where the figure sits.

    `inline code span` is the one that is not a spelling, and it is the
    DISCLOSED BOUND the header names and an arm measures: a figure inside
    backticks is prose quoting a value, and this pack quotes its own
    counter-examples -- `superuser_sees=130` is the law's own illustration of a
    figure nothing emits, and `fabricated_count=999` is every round's probe
    token. Round 24 lists the backtick rule among the bounds it is NOT
    attacking. Deleting the guard makes those quotations claims and reds nine
    true sentences, which is the measurement beside it, not a promise.
    """
    s = line
    if "html character references" not in skip:
        s = html.unescape(s)
    if "nfkc" not in skip:
        s = unicodedata.normalize("NFKC", s)
    if "combining marks" not in skip:
        s = _drop_marks(s)
    if "bidi controls" not in skip:
        # `C29-S1`. The nine `Cf` characters that REORDER what follows are not
        # deleted like the other format characters -- deleting one leaves a
        # token that is not the string a reader sees, which is the doctrine the
        # coordinator objected to. Each becomes `U+FFFD`, which is in no class
        # this file deletes and is not a digit, so the value class BREAKS and
        # the line is not a figure under these rules at all. `scan` then
        # refuses the line BY NAME rather than letting it fall through
        # silently, and `planted_tokens` plants nothing for the arms, so the
        # figures those arms borrow stay available to the documents.
        #
        # Skipping this guard restores round 14's doctrine for them: the
        # control is deleted with the rest of `Cf`, the token becomes the
        # figure a case required, and the arms PASS. That is the flip this
        # guard is measured by.
        s = "".join("\ufffd" if c in BIDI_CONTROLS else c for c in s)
    if "format characters" not in skip:
        s = "".join(c for c in s if unicodedata.category(c) != "Cf")
    if "whitespace around the equals" not in skip:
        s = _close_equals(s)
    if "non-ascii digits" not in skip:
        s = _fold_digits(s)
    if "html comment markers" not in skip:
        s = s.replace("<!--", " ").replace("-->", " ")
    if "inline code span" not in skip:
        s = CODE_SPAN.sub(" ", s)
    return s


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
    for cand in _candidates(line, skip):
        if not _is_figure(cand, skip):
            continue
        if _exempted(cand, skip):
            continue
        out.append(cand)
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
    # `R22-S3`, applied in both readers rather than in one: the GLOBAL config is
    # found through `HOME` and through `XDG_CONFIG_HOME`, and neither is a
    # `GIT_*` key, so neither was removed by the scrub above.
    env["XDG_CONFIG_HOME"] = os.devnull
    env["HOME"] = os.devnull
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

# THE ONE PLACE the capture's path is kept: set by `_main` from the command
# line, and set and restored by `_arm` around one arm's own world, so a world's
# output is never this process's and this process's is never a world's. A
# second source for it would be a haystack nobody read.
_RUN_CAPTURE = []

# The line `rebuild_and_prove.sh` prints, and the only thing that ties a
# capture to a commit. It is not a proof of provenance and is not written as
# one: `C27-S3` found this pointer aimed at the header, where the statement is
# not. It is `R26-S5` in the residual table of `prep/phase11/P11-HANDOFF-MANIFEST.md`,
# under round 26, and the round-27 entry `R27-S5` repeats it for the sink: a
# capture is a FILE, and what ties it to a RUN is the process lineage of the
# driver that wrote it, which nothing executable here can verify.
RUN_HEAD_LINE = re.compile(r"^RUN_HEAD\s*:\s*([0-9a-f]{40})\s*$", re.M)

# `C28-F2`. THE ONE SENTENCE THAT SAYS WHAT THE HAYSTACK IS, as a literal.
#
# Four rounds running, the rule moved and a live sentence about the rule did
# not: round 25's wording, round 26's and round 27's -- the entries of
# `RETIRED_SENTENCES` below, each named there and nowhere else in this file --
# each stayed somewhere
# after the rule they described was gone. The coordinator's `C28-F2` found two
# of them in `rebuild_and_prove.sh` -- the step-7b header and the
# `EXIT_FENCED_FIGURES` description -- printing round 27's wording four
# lines from the gate's own correct line, and a reader whose figure reds and
# believes the driver adds the `print` this round abolished.
#
# A sweep is not an answer to a class of defect, so the sentence is a LITERAL
# here, the verdict prints it, and `driver_sentences` requires the driver to
# QUOTE IT BY BYTES in both places. That is the enrolment `--check-blocks`
# already does for figures, applied to the sentences that describe the rule.
HAYSTACK_SENTENCE = "the expectations the value cases of this run REQUIRED"

# The sentences rules of this file RETIRED, refused anywhere in the driver. It
# is an enumeration and it is DECLARED as one: it cannot name the wording
# nobody has written yet, so it catches the stale sentence a rule change leaves
# behind and a reviewer adds the next entry when the next rule moves. The pin
# above is what actually binds; this is the net under it.
RETIRED_SENTENCES = (
    "what this run printed",
    "what this run prints",
    "this run's own output",
    "no instrument under the harness emits",
    "an instrument under the harness emits",
    "appears in a published evidence file",
    # The coordinator's `C29-F1` measured these four LIVE in the two files
    # this law reads, at `acfe049`, while the law reported zero. Each is one
    # word away from an entry above, which is what an enumeration is worth;
    # they are here because the file no longer spells any of them, not as a
    # claim that the next wording is covered.
    "this run's output",
    "this run did not print",
    "every line this run has printed",
    "legitimate because it is in there",
    "a run of this phase printed",
)

# `R27-F1`. One row per expectation of a value case that PASSED, written by
# `case()` in `proofs.py` and `proofs_b.py`: the suite, the case's own
# identifier, and the expectation itself. Tab-separated, because the sink is
# not prose and nothing that merely PRINTS reaches it.
FIGURE_ROW = re.compile(r"^FIGURE\t([A-Z][A-Z0-9_]*)\t([^\t\n]+)\t([^\t\n]+)$", re.M)
# `R27-F2`. The case a DOCUMENT names beside the figure it quotes. A figure is
# a figure OF something, and `axes=3` -- true of Pack A's grid -- was asserted
# of Pack B's, where the same run requires `axes=2`. Binding the quotation to
# the case lets that red.
CASE_REF = re.compile(r"\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]")
UNIDENTIFIED = "UNIDENTIFIED-CASE"


def _run_capture_text(path, sha, top):
    """The FIGURE SINK this run wrote, or a NAMED refusal. Never a fallback.

    Since `R27-F1` the file holds one row per expectation a value case required
    and passed, not the run's output; the four file-level refusals below are
    unchanged, because a sink is still a file.

    `R26-S1`. Four refusals, each by its own name, because the previous design
    could not tell a file someone typed from something a run produced:

      1. No capture at all is `RUN-CAPTURE-ABSENT`. The gate is a step of the
         driver, which captures its own output; with no capture there is no run
         to read and the gate refuses rather than reading the tree.
      2. A capture INSIDE the repository that holds the subject is refused:
         that is the committed recording round 25 blocked, reached by another
         route.
      3. An unreadable or empty capture is refused, so a figure never reds for
         the wrong reason.
      4. A capture whose `RUN_HEAD` is not this commit is refused: a run of
         another commit says nothing about this one, which is what makes a
         recording of an older run worthless here rather than merely stale.
    """
    if not path:
        raise Refusal(
            "RUN-CAPTURE-ABSENT: no run capture was given. A figure is legitimate here "
            "because A CASE OF THIS RUN REQUIRED it, so the haystack is "
            + HAYSTACK_SENTENCE
            + " and this gate reads the FIGURE SINK of the run it is a step of "
            "(`--run-capture PATH`, which `rebuild_and_prove.sh` writes outside the "
            "work tree and hands over). There is no fall back to reading the files."
        )
    ap = os.path.realpath(path)
    anchor = os.path.realpath(top)
    if (ap + os.sep).startswith(anchor + os.sep):
        raise Refusal(
            "RUN-CAPTURE-INSIDE-THE-SUBJECT: the capture %s lies inside the repository "
            "%s that holds the subject, where a committed or planted file could stand "
            "in for the output of a run. The capture is written outside the work tree "
            "or it is not read." % (ap, anchor)
        )
    try:
        data = open(ap, encoding="utf-8", errors="replace").read()
    except OSError as why:
        raise Refusal("RUN-CAPTURE-UNREADABLE: %s could not be read (%s)." % (ap, why))
    if not data.strip():
        raise Refusal(
            "RUN-CAPTURE-EMPTY: %s holds no output, so every figure would red for the "
            "wrong reason." % ap
        )
    heads = sorted(set(RUN_HEAD_LINE.findall(data)))
    if sha not in heads:
        raise Refusal(
            "RUN-CAPTURE-NOT-THIS-HEAD: the capture %s carries %s and the subject's "
            "HEAD is %s. A run of another commit says nothing about this one."
            % (
                ap,
                ", ".join(h[:12] for h in heads) or "no `RUN_HEAD : <sha>` line",
                sha[:12],
            )
        )
    return data


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


_ASSERTED = {}


def _haystack_key(root, skip):
    """The cache key, derived once so `haystack` and `asserted` cannot drift."""
    return (
        os.path.abspath(root),
        "only an asserted case emits" not in skip,
        "only a run emits" not in skip,
        "the same spelling on both sides" not in skip,
        (_RUN_CAPTURE[0] if _RUN_CAPTURE else None),
        "no repository redirects the subject" not in skip,
    )


def asserted(root, skip=()):
    """{figure: {(suite, case id)}} — which case REQUIRED each figure.

    `R27-F2`. Empty when `only an asserted case emits` is deleted, because the
    control it restores binds nothing: round 26's rule knew only whether a
    string was printed, never what it was a figure OF. The scan therefore
    stops asking about attribution in that world, which is what makes the
    misattribution arm a flip of THIS guard and not of the matcher.
    """
    if "only an asserted case emits" in skip or "only a run emits" in skip:
        # Either rung below the sink binds nothing: round 26's rule knew only
        # whether a string was printed, and `bc54e4c`'s knew only which file
        # held it. Neither knows what a figure is a figure OF.
        return {}
    haystack(root, skip)
    return _ASSERTED.get(_haystack_key(root, skip), {})


def haystack(root, skip=()):
    """(label, paths, text): what EMITS here, and where that was read from.

    Since `R26-S1` the first answer is the output of the run this gate is a
    step of, and the tree derivation below is the CONTROL that deleting
    `only a run emits` restores.

    Cached per (root, guards, capture) because one process measures one run:
    the object store cannot change under a run, and the arms would otherwise
    spawn a subprocess per guard per arm.
    """
    stem = os.path.splitext(os.path.basename(__file__))[0]
    asserted_only = "only an asserted case emits" not in skip
    from_run = "only a run emits" not in skip
    same_spelling = "the same spelling on both sides" not in skip
    capture = _RUN_CAPTURE[0] if _RUN_CAPTURE else None
    anchored = "no repository redirects the subject" not in skip
    key = _haystack_key(root, skip)
    if key in _HAYSTACK:
        return _HAYSTACK[key]

    def keep(name):
        base = os.path.basename(name)
        # `R25-F1`. A POSITIVE rule, and the direction matters more than the
        # set: a file emits only if it is a file this tree can RUN. Forty-four
        # of the sixty-six files this haystack used to hold were recorded
        # output, and a recording produces nothing -- it records what was
        # produced once, and anyone who can type into it can legitimise a
        # figure. What a run of these instruments prints is still read from
        # their source, which is what the gate has always meant by `emits`;
        # the recordings stay committed, under their digests, as the evidence a
        # reader opens. They simply stop deciding.
        if os.path.splitext(base)[1] not in EMITTING_SUFFIXES:
            return False
        # By STEM, so a `.pyc` of an excluded source is excluded with it. Under
        # the git derivation that is belt and braces; with the derivation
        # deleted it is the round-15 design, which is what the arm measures.
        if os.path.splitext(base)[0] == stem:
            return False
        return True

    if asserted_only and from_run:
        # `R27-F1`. The haystack is the sink's ROWS, and a row exists because a
        # case required the value and passed. The capture's file-level laws are
        # unchanged and run first -- outside the subject, this commit's
        # `RUN_HEAD`, readable, not empty -- because a sink is still a file.
        top = _subject_top(root, anchored)
        sha = _commit_of(top if anchored else root)
        data = _run_capture_text(capture, sha, top)
        rows = FIGURE_ROW.findall(data)
        if not rows:
            raise Refusal(
                ("FIGURE-SINK-HAS-NO-ROWS: %s carries this commit's `RUN_HEAD` "
                 "and not one `FIGURE` row, so the haystack -- "
                 + HAYSTACK_SENTENCE
                 + " -- is EMPTY: no case of this run required any value. A "
                 "gate whose haystack is empty passes nothing and must not "
                 "report that as a pass.")
                % os.path.basename(os.path.realpath(capture))
            )
        bound = {}
        for suite, case_id, figure in rows:
            fig = _close_equals(figure) if same_spelling else figure
            for tok in figures_on(fig, skip):
                bound.setdefault(tok, set()).add((suite, case_id))
        text = "\n".join(
            (_close_equals(f) if same_spelling else f) for _s, _c, f in rows
        )
        cases = sorted({c for _s, c, _f in rows})
        digest = hashlib.sha256(text.encode("utf-8", "surrogateescape")).hexdigest()
        label = (
            HAYSTACK_SENTENCE + " (%s, %d rows from "
            "%d case(s), sha256 %s of the text weighed, RUN_HEAD %s)"
            % (
                os.path.basename(os.path.realpath(capture)), len(rows), len(cases),
                digest[:12], sha[:12],
            )
        )
        got = (label, [os.path.realpath(capture)], text)
        _HAYSTACK[key] = got
        _ASSERTED[key] = bound
        return got

    if from_run:
        # THE FIRST CONTROL, round 26's rule exactly: the whole text of the
        # capture, whatever wrote it. Restored by deleting
        # `only an asserted case emits`, which is what makes the notice and
        # echo arms a measured flip.
        # The anchor and the head are still resolved from the repository,
        # because the capture is checked AGAINST this commit and must not lie
        # inside it. Deleting the census therefore changes which repository's
        # head the capture is held to, which the anchor arms read by name.
        top = _subject_top(root, anchored)
        sha = _commit_of(top if anchored else root)
        text = _run_capture_text(capture, sha, top)
        # Counted on what the capture HOLDS, before the spelling rule touches
        # it: a reader compares this with `wc -l` on the file.
        lines = text.count("\n") + 1
        if same_spelling:
            text = _close_equals(text)
        digest = hashlib.sha256(text.encode("utf-8", "surrogateescape")).hexdigest()
        # `R26-S3`: the set is named by a DIGEST and a size, not by a count of
        # files, so an arrival in it is visible in the verdict's own inventory.
        label = (
            "the output this run printed (%s, %d lines, sha256 %s of the text weighed, "
            "RUN_HEAD %s)"
            % (os.path.basename(os.path.realpath(capture)), lines, digest[:12], sha[:12])
        )
        got = (label, [os.path.realpath(capture)], text)
        _HAYSTACK[key] = got
        return got

    # THE CONTROL, and nothing else reaches it: `bc54e4c`'s haystack exactly,
    # the commit's own files filtered by the suffix whitelist and the stem
    # exclusion. It is restored by deleting `only a run emits`, which is what
    # makes the three `R26-S1` attacks -- a comment in an instrument, a `.py`
    # nothing runs, a `--` comment in a mutation world the run never applies --
    # measurable as a flip rather than assertable as closed. The working-tree
    # walk that used to stand here as the control of the commit derivation is
    # deleted with the guard it was the control of.
    top = _subject_top(root, anchored)
    sha = _commit_of(top if anchored else root)
    rel = os.path.relpath(os.path.realpath(root), top)
    paths = [n for n in _tracked_paths(top, sha, rel) if keep(n)]
    text = "\n".join(_blobs(top, sha, paths))
    if same_spelling:
        text = _close_equals(text)
    label = "commit %s (%d files, the git derivation is the control)" % (sha, len(paths))
    got = (label, paths, text)
    _HAYSTACK[key] = got
    return got


def emitted_strings(root, skip=()):
    """The haystack: in the live world, the expectations the value cases of this
    run REQUIRED; in the `only an asserted case emits` world, what the run
    printed; in the control, the commit's own files.

    `R26-F3` and the coordinator's `C26-S3`: the sentence that stood here said
    "what the instruments and the committed evidence under `root` emit", which
    was round 25's own blocker written as the specification -- the OUTCOME
    sentence was swept at `bc54e4c` and this, the discipline half, was not.
    Moving a guard needs two sweeps."""
    return haystack(root, skip)[2]


def haystack_files(root, skip=()):
    """Where that output was read from: one capture, or the control's file set."""
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
OBJECT_KEYS = (
    "attr-identity",
    "fn-identity",
    "self-bytes",
    "harness-bytes",
    # `R23`: the clean-tree law and the index-flag law were consulted inside
    # `committed_harness`, which is the `self-bytes` check, so neither had a
    # deletion control of its own -- the challenger deleted the checker's half
    # in one line, committed on a copy, and nothing red. They are keys now,
    # which is what makes "deleting IT reds a gate" measurable per law.
    "clean-tree",
    "index-flags",
    # The coordinator's `F1` on `50a45a0`: a law built on `ls-tree HEAD` never
    # examines a file the commit does not hold, and `run_migrations.py` applies
    # `sorted(os.listdir(MIGDIR))`. An UNTRACKED `.sql` dropped into the
    # migrations directory was applied, `APPLIED 88/88`, with
    # `SOURCE_TREE_DIRTY : no` and every `EXIT_*` 0. Its own key, so deleting
    # it reds.
    "untracked-paths",
)


# The two tree laws, named once so the generation suspension below and the
# keyed deletion arms read the same strings.
TREE_LAW_KEYS = frozenset(("clean-tree", "index-flags", "untracked-paths"))

# Set for the whole process by `--regenerate` and `--emit`, and by nothing
# else. See `_suspend_tree_law_for_generation`.
_GENERATING = []


def _objects_enabled(objects):
    """`None` = every object check (the real run). A set = only those keys."""
    if objects is not None:
        return frozenset(objects)
    if _GENERATING:
        return frozenset(OBJECT_KEYS) - TREE_LAW_KEYS
    return frozenset(OBJECT_KEYS)


# The files whose bytes DECIDE: every executable file under the harness. The
# set is derived by walking, not listed, so a file added to the harness is
# covered by the law the day it is written rather than the day someone
# remembers to name it (`R16`'s lesson: an enumerated exemption cannot name
# what has not been written yet).
DECIDING_SUFFIXES = (".py", ".sh", ".sql")


def _deciding_files(harness_dir):
    """Every deciding file under `harness_dir`, by path relative to it.

    `followlinks=True`: a symlinked subdirectory is a directory the harness can
    be reached through, and a file this walk cannot see is a file the law does
    not cover.
    """
    out = []
    for root, dirs, names in os.walk(harness_dir, followlinks=True):
        dirs.sort()
        for n in sorted(names):
            if n.endswith(DECIDING_SUFFIXES):
                out.append(os.path.relpath(os.path.join(root, n), harness_dir))
    return sorted(out)


def _tree_dirty(top):
    """The uncommitted entries in the WHOLE work tree, or a named refusal.

    THE COORDINATOR'S `F1`, measured on this head: the byte law covered every
    deciding file and not THE FILE THAT INVOKES IT. An uncommitted
    `rebuild_and_prove.sh` with four lines replaced by `true`, or -- the
    challenger's `R22-F1(a)` -- three uncommitted hunks in this file that pass
    the guard off at the call site, skip the comparison for the live directory
    only and return before the second reader is built, produced
    `selftest 0 / blocks 0 / scan 0` with a fabricated figure in a document.
    Nothing inside a self-run entry point can stop that: the entry point is
    what would run the check.

    What can be true, and is enforced here, in the second reader and in the
    shell step, is that such a tree PRODUCES NO ADMISSIBLE TRANSCRIPT. A dirty
    tree is refused by name wherever the run is entered, including the bare
    scan a reader or CI runs alone.

    `R23-F2`, and it is why this reads bytes rather than a report:
    `git status --porcelain` is a statement about the INDEX, and
    `git update-index --assume-unchanged <path>` is the documented way to stop
    it looking. One such flag edits no file, commits nothing and defeated all
    three clean-tree sites at once -- the challenger produced a full
    authoritative run printing `SOURCE_TREE_DIRTY : no`, at the committed sha,
    with a fabricated figure on disk in a document the commit does not hold.
    Its bite was on the DOCUMENTS, which the byte law does not cover and which
    are where the figures are. So nothing here asks git what changed: every
    path the COMMIT holds is read off the disk and its blob name recomputed
    from the bytes, which no index flag can move.

    WHAT THIS DOES NOT COVER, said here rather than discovered: a file the
    commit does not hold. That sentence used to continue "an untracked document
    can only ever ADD a figure, so it reds rather than passes", and the
    coordinator measured it FALSE in the one place it mattered -- an untracked
    `.sql` in the migrations directory is not read for figures at all, it is
    APPLIED, and the run was fully green with the planted table in the
    database. `_untracked` below is that hole closed, by its own key, and this
    function still reads only what the commit holds. The mode bits ARE read
    here, in the loop below, since the coordinator's `F2` on the previous head;
    the sentence saying they were not was stale and is gone (`F6`). So the
    sentence this file used to carry --
    "an escape therefore has to be COMMITTED to work" -- is replaced by the
    one that is true: a transcript is evidence only when it was produced from a
    CLEAN tree whose `HEAD` is the committed sha, and reviewers run from fresh
    clones. An uncommitted edit, one file or many, is the declared limit.
    """
    try:
        fmt = _git(top, ["rev-parse", "--show-object-format"]).decode("ascii", "replace").strip()
        sha = _commit_of(top)
        listed = _git(top, ["ls-tree", "-r", "-z", "--full-tree", sha]).decode(
            "utf-8", "surrogateescape"
        )
    except (Refusal, RuntimeError, OSError) as exc:
        return (
            "SELF-TREE-STATE-UNREADABLE: whether the work tree at %s is the tree the "
            "commit holds could not be determined (%s)." % (top, exc),
        )
    if fmt != "sha1":
        return (
            "SELF-OBJECT-FORMAT-UNSUPPORTED: this repository's object format is %r and "
            "the comparison below computes blob names as sha1, so this run cannot say "
            "whether the work tree is the committed tree." % fmt,
        )
    moved, gone, mode_moved = [], [], []
    for row in listed.split("\0"):
        if not row:
            continue
        meta, _tab, path = row.partition("\t")
        bits = meta.split(" ")
        if len(bits) < 3 or bits[1] != "blob":
            # A gitlink (`commit`) is another repository's HEAD and not bytes
            # this tree carries; the census refuses a nested repository by name
            # before this runs.
            continue
        mode, oid = bits[0], bits[2]
        full = os.path.join(top, path)
        try:
            if mode == "120000":
                data = os.readlink(full).encode("utf-8", "surrogateescape")
            else:
                with open(full, "rb") as fh:
                    data = fh.read()
        except OSError:
            gone.append(path)
            continue
        if hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() != oid:
            moved.append(path)
        if mode in ("100644", "100755"):
            # The coordinator's `F2` (low): with `core.fileMode=false` a mode
            # change is invisible to `git status` in all four places. The disk's
            # own bits are not git's opinion, so they are read here: an
            # executable bit the commit does not carry, or one it carries and
            # the file has lost, is drift like any other.
            try:
                executable = bool(os.stat(full).st_mode & 0o111)
            except OSError:
                gone.append(path)
                continue
            if executable != (mode == "100755"):
                mode_moved.append(path)
    if not moved and not gone and not mode_moved:
        return ()
    count = len(moved) + len(gone) + len(mode_moved)
    return (
        "SELF-TREE-DIRTY: %d path%s the commit holds %s not what is on disk at %s, so "
        "this run is not a run of the committed tree and its output is not evidence. "
        "%s%s%s"
        % (
            count,
            "" if count == 1 else "s",
            "is" if count == 1 else "are",
            top,
            "Moved: %s. " % "; ".join(sorted(moved)[:5]) if moved else "",
            "Missing: %s. " % "; ".join(sorted(gone)[:5]) if gone else "",
            "Mode: %s." % "; ".join(sorted(mode_moved)[:5]) if mode_moved else "",
        ),
    )


# The directories whose CONTENTS the run reads, rather than the commit's copy
# of them. Both are named here rather than discovered because this file's own
# bytes are pinned to the commit: an edit to either name is an edit to the
# checker, which `self-bytes` refuses unless it is committed and reviewed. Each
# one is armed below by a plant, and an absent directory is a REFUSAL rather
# than an empty walk -- fail on ABSENCE, never skip what cannot be classified.
READ_DIRS = ("infrastructure/database/migrations", "prep/phase11")
# A suffix the run reads or executes from one of those directories. `.pyc` is
# deliberately absent: a compiled cache is not read by anything the run
# executes, and naming it would make every `__pycache__` a refusal.
READ_SUFFIXES = (".sql", ".py", ".sh", ".md", ".txt")


def _untracked(top):
    """Paths the commit does not hold, under a directory the run READS.

    THE COORDINATOR'S `F1` ON `50a45a0`: a blocker, a measured fail-open, and a
    REGRESSION this phase introduced. `R23-F2`'s answer replaced
    `git status --porcelain` with a comparison of every path the COMMIT holds
    against the bytes on disk -- which is right about index flags and blind in a
    way `status` was not. `status` lists `?? 0086z_plant.sql`; a walk of
    `ls-tree HEAD` never looks at a file the commit does not hold. And
    `run_migrations.py` applies `sorted(os.listdir(MIGDIR))`, so an untracked
    `.sql` dropped beside the frozen migrations was APPLIED: `APPLIED 88/88`,
    `SOURCE_TREE_DIRTY : no`, every `EXIT_*` 0, the planted table in
    `to_regclass`, and the last `schema_migrations` row naming the plant.

    So the law is stated in the other direction as well: not only "every path
    the commit holds is what is on disk", but "nothing the run reads is a path
    the commit does not hold". Both halves are needed and neither implies the
    other.

    WHAT THIS DOES NOT COVER, named rather than discovered: a file whose suffix
    is not one the run reads, and a directory not named in `READ_DIRS` -- the
    run executes `npm` and a PostgreSQL build from outside this tree, and
    neither is pinned by anything here. A planter who COMMITS is not covered by
    this or by anything executable; that is the declared limit of the chain.
    """
    try:
        sha = _commit_of(top)
        listed = _git(
            top, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", sha]
        ).decode("utf-8", "surrogateescape")
    except (Refusal, RuntimeError, OSError) as exc:
        return (
            "SELF-UNTRACKED-UNREADABLE: whether the work tree at %s carries a file the "
            "commit does not hold could not be determined (%s)." % (top, exc),
        )
    held = {path for path in listed.split("\0") if path}
    absent = [d for d in READ_DIRS if not os.path.isdir(os.path.join(top, d))]
    if absent:
        return (
            "SELF-READ-DIR-ABSENT: %s is named as a directory this run reads and is not "
            "a directory at %s, so the law cannot say what the run would read from it. "
            "An absent subject is a refusal, never an empty walk."
            % ("; ".join(absent), top),
        )
    extra = []
    for rel_dir in READ_DIRS:
        for root, dirs, names in os.walk(os.path.join(top, rel_dir), followlinks=True):
            dirs.sort()
            for name in sorted(names):
                if not name.endswith(READ_SUFFIXES):
                    continue
                rel = os.path.relpath(os.path.join(root, name), top)
                if rel not in held:
                    extra.append(rel)
    if not extra:
        return ()
    return (
        "SELF-TREE-UNTRACKED: %d path%s under a directory this run reads %s not in the "
        "commit at %s, and the run reads or applies what is on disk rather than what the "
        "commit holds, so its output is not evidence. Untracked: %s."
        % (
            len(extra),
            "" if len(extra) == 1 else "s",
            "is" if len(extra) == 1 else "are",
            top,
            "; ".join(sorted(extra)[:5]),
        ),
    )


def _index_flagged(top):
    """The paths whose INDEX ENTRY has been flagged to stop git looking at them.

    The coordinator's `F1` on the previous head, which is `R23-F2` carried one
    step further and measured: `git update-index --skip-worktree` on migration
    `0086` plus an appended `CREATE TABLE` gave a full green suite printing
    `SOURCE_TREE_DIRTY : no`, with `MIGRATIONS_SHA` matching the clean run
    because it was read from `HEAD`, and the planted table really ran.
    `--assume-unchanged` does the same.

    The byte comparison above already catches the drift those flags hide. This
    refusal is separate and by its own name because the flag itself is a
    statement that a tracked path is not to be looked at, and a run that reads
    that path has no business proceeding on it -- and because a flag can hide a
    MISSING file (sparse checkout) as easily as a changed one. `ls-files -v`
    marks assume-unchanged with a lowercase tag and skip-worktree with `S`.
    """
    try:
        out = _git(top, ["ls-files", "-v", "-z"]).decode("utf-8", "surrogateescape")
    except (Refusal, RuntimeError, OSError) as exc:
        return (
            "SELF-INDEX-STATE-UNREADABLE: whether any tracked path is flagged "
            "assume-unchanged or skip-worktree could not be determined (%s)." % exc,
        )
    flagged = []
    for row in out.split("\0"):
        if not row or len(row) < 2 or row[1] != " ":
            continue
        tag, path = row[0], row[2:]
        if tag == "S" or tag.islower():
            flagged.append("%s (%s)" % (path, "skip-worktree" if tag == "S" else "assume-unchanged"))
    if not flagged:
        return ()
    return (
        "SELF-INDEX-FLAGGED: %d tracked path%s flagged so that git stops looking at "
        "%s: %s. A run whose inputs are marked not-to-be-read is not a measurement of "
        "the committed tree."
        % (
            len(flagged),
            " is" if len(flagged) == 1 else "s are",
            "it" if len(flagged) == 1 else "them",
            "; ".join(sorted(flagged)[:5]),
        ),
    )


def _harness_dir():
    """The harness this run's deciding files are read from.

    One function rather than the same expression in three places, and it is
    here for the arms: round 22 found `self-bytes` and `harness-bytes`
    UNARMED, because every arm exercised the law on a COPY -- which measures
    the instrument in another directory and never that THIS run consults it.
    An arm can now bind the live consultation to a prepared world the way the
    identity arms rebind `re.fullmatch`, so the deletion control deletes the
    key from the call the run actually makes.

    It is one more line a planter could move, and moving it is a COMMITTED edit
    to a deciding file: it lands in the diff under the published digest. That
    is the same declared limit the law itself carries, and it buys two
    deletion controls that did not exist.
    """
    return os.path.dirname(os.path.realpath(__file__))


def committed_harness(harness_dir=None, compare=True):
    """(refusals, {relpath: committed text}) for the deciding files.

    THE RULING THIS IMPLEMENTS, and it subsumes six rounds of rules. Round 21
    measured the previous answer false: the ARGUMENTS of an admitted call were
    pinned by a digest held as a literal IN THE FILE THE PLANT EDITS, and the
    refusal text told the maintainer how to move it, so two edits -- one of them
    the one the error message prescribed -- reopened the escape with every gate
    at 0. That is this project's `P7 R11` law: **a derived subject set must not
    be derived from a representation the subject can alter.** A constant beside
    the constants is such a representation.

    So nothing in this file pins anything any more. The deciding code is read
    from THE COMMIT: every deciding file's bytes must equal
    `git show <resolved anchored sha>:<path>`, and the frame parse takes its
    source from that blob rather than from `inspect.getsource`. The anchor is
    the same structural one the haystack already uses -- the most attacked and
    best armed machinery in this phase.

    AND THE SENTENCE THAT USED TO STAND HERE WAS MEASURED FALSE. It said an
    escape from any round between 16 to 21 "has to be COMMITTED to work".
    Round 22 planted three uncommitted hunks in this file -- the guard off at
    the call site, the comparison skipped for the live directory only, the
    second reader never invoked -- and got a fabricated figure through at
    0/0/0; one uncommitted line in the shell step did the same to the whole
    authoritative run. No check inside a self-run entry point can stop that.
    What is true is the limit: a transcript is evidence only when it was
    produced from a CLEAN tree whose `HEAD` is the committed sha, and reviewers
    run from fresh clones -- which `_tree_dirty` refuses by name here, in the
    second reader and in the shell step, so an uncommitted edit produces no
    admissible transcript. An uncommitted edit, one file or many, is therefore
    the declared limit and not a measured escape.

    WHAT THIS DOES NOT DO, stated here rather than beside it: it does not stop a
    planter who commits. Nothing executable can. What it changes is that the
    change is then in the diff, under the published digest, in front of the
    independent challenger and the coordinator -- which is the whole of the
    guarantee and is why this phase's chain has three links.
    """
    # `harness_dir` is a parameter so the law can be MEASURED on a copy: the
    # arm builds a scratch repository, commits a copy of the harness into it,
    # edits one deciding file on disk and reads the refusal by name. `compare`
    # is the by-value deletion of the comparison itself, which is what makes
    # the arm a measurement rather than an assertion -- the arm runs the same
    # poisoned world with it deleted and requires that nothing reds.
    harness_dir = harness_dir or _harness_dir()
    try:
        top = _subject_top(harness_dir)
        sha = _commit_of(top)
    except Refusal as why:
        return (
            "SELF-ANCHOR-UNRESOLVED: the deciding code is read from the commit and the "
            "anchor could not be resolved, so this run cannot say what the rules it is "
            "about to apply are. The anchor refused: %s" % why,
        ), {}
    found = _deciding_files(harness_dir)
    rel_of = {
        n: os.path.relpath(os.path.realpath(os.path.join(harness_dir, n)), top)
        for n in found
    }
    try:
        # Only the DECIDING files: `_tracked_paths` answers for everything the
        # commit holds under the harness, and the evidence transcripts beside
        # the instruments decide nothing. Filtering here rather than in the
        # loops below, so the absent-file check reads the same set as the
        # present-file check and cannot report a transcript as a missing rule.
        tracked = {
            n
            for n in _tracked_paths(top, sha, os.path.relpath(harness_dir, top))
            if n.endswith(DECIDING_SUFFIXES)
        }
    except Refusal as why:
        return ("SELF-ANCHOR-UNRESOLVED: %s" % why,), {}
    msgs = []
    want = [n for n in found if rel_of[n] in tracked]
    for n in found:
        if rel_of[n] not in tracked:
            msgs.append(
                "SELF-FILE-UNCOMMITTED: `%s` is a deciding file this run can execute and "
                "commit %s does not hold it. The rules are read from the commit, so a "
                "file that is not in it decides nothing it is allowed to decide."
                % (rel_of[n], sha[:12])
            )
    for n in sorted(tracked - {rel_of[k] for k in want}):
        msgs.append(
            "SELF-FILE-ABSENT: commit %s holds the deciding file `%s` and it is not under "
            "the harness. A deciding file that is gone is not a run with one fewer rule."
            % (sha[:12], n)
        )
    blobs = {}
    if want:
        try:
            texts = _blobs(top, sha, [rel_of[n] for n in want])
        except Refusal as why:
            return (tuple(msgs) + ("SELF-BLOB-UNREADABLE: %s" % why,)), {}
        for n, text in zip(want, texts):
            blobs[n] = text
            full = os.path.join(harness_dir, n)
            try:
                with open(full, "rb") as fh:
                    disk = fh.read()
            except OSError as exc:
                msgs.append(
                    "SELF-BYTES-UNREADABLE: `%s` is a deciding file and could not be read "
                    "(%s)." % (rel_of[n], exc)
                )
                continue
            if compare and hashlib.sha256(disk).hexdigest() != hashlib.sha256(
                text.encode("utf-8", "surrogateescape")
            ).hexdigest():
                msgs.append(
                    "SELF-BYTES-UNCOMMITTED: `%s` on disk digests to %s and commit %s "
                    "holds %s. What moved is the working tree, not the commit: a default "
                    "argument, a flag on a compiled pattern, a transformer that returns "
                    "early, a deleted comparison, an added admit-list entry. The rules are "
                    "read from the commit, so this run refuses rather than measuring a "
                    "file nobody has reviewed."
                    % (
                        rel_of[n],
                        hashlib.sha256(disk).hexdigest()[:12],
                        sha[:12],
                        hashlib.sha256(text.encode("utf-8", "surrogateescape")).hexdigest()[:12],
                    )
                )
    return tuple(msgs), blobs


_COMMITTED = []


def committed_text(name=None):
    """The COMMITTED text of a deciding file, read once per process."""
    if not _COMMITTED:
        _COMMITTED.append(committed_harness())
    msgs, blobs = _COMMITTED[0]
    if name is None:
        return msgs, blobs
    return msgs, blobs.get(name)


def self_bytes_committed():
    """(ok, refusals) that every deciding file is the file the commit holds."""
    msgs, _blobs_ = committed_text()
    return not msgs, tuple(msgs)


def harness_bytes_pinned():
    """(ok, refusals) from the SECOND reader, which shares no code with this file.

    `self_bytes_committed` above reads the same law with this file's own code,
    and a file cannot be the authority on its own bytes: the edit that moves
    them can delete the comparison in the same stroke. So the law is read twice,
    once here by `check_harness_bytes.py`, which imports nothing from this file
    and is itself one of the deciding files the law covers.

    A SUBPROCESS, never an import: an instrument that is part of the set it
    measures must not be loaded into the process measuring it. Its refusal lines
    are passed through unchanged, because the name that refused is what an arm
    reads.
    """
    harness = _harness_dir()
    reader = os.path.join(harness, "check_harness_bytes.py")
    if not os.path.isfile(reader):
        return False, (
            "HARNESS-BYTES-READER-ABSENT: the second reader of the byte law is not at "
            "%s. Deleting an instrument is a way of silencing it, so its absence is a "
            "refusal and not a skip" % reader,
        )
    try:
        got = subprocess.run(
            [sys.executable, "-I", reader, "--harness", harness],
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


def tree_committed():
    """The clean-tree law, consulted live: refusals or nothing.

    A key of its own since `R23`, so deleting it is a measurable deletion and
    not a line nobody's arm reads. The subject is resolved exactly as the
    deciding bytes are, through the structural anchor, so a run that cannot say
    which commit it is standing on refuses here too rather than skipping.
    """
    try:
        top = _subject_top(_harness_dir())
    except Refusal as why:
        return (
            "SELF-TREE-ANCHOR-UNRESOLVED: whether the work tree is the committed tree "
            "cannot be asked without the commit. The anchor refused: %s" % why,
        )
    return _tree_dirty(top)


def index_unflagged():
    """The index-flag law, consulted live: refusals or nothing."""
    try:
        top = _subject_top(_harness_dir())
    except Refusal as why:
        return (
            "SELF-INDEX-ANCHOR-UNRESOLVED: whether a tracked path is flagged cannot be "
            "asked without the repository. The anchor refused: %s" % why,
        )
    return _index_flagged(top)


def tree_tracked():
    """The untracked-paths law, consulted live: refusals or nothing."""
    try:
        top = _subject_top(_harness_dir())
    except Refusal as why:
        return (
            "SELF-UNTRACKED-ANCHOR-UNRESOLVED: whether the run reads a path the commit "
            "does not hold cannot be asked without the commit. The anchor refused: %s"
            % why,
        )
    return _untracked(top)


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
    if "self-bytes" in keys:
        _ok, m = self_bytes_committed()
        msgs += list(m)
    if "harness-bytes" in keys:
        _ok, m = harness_bytes_pinned()
        msgs += list(m)
    if "clean-tree" in keys:
        msgs += list(tree_committed())
    if "index-flags" in keys:
        msgs += list(index_unflagged())
    if "untracked-paths" in keys:
        msgs += list(tree_tracked())
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


FINDING_TAIL = (
    " The haystack this gate weighs a figure against is " + HAYSTACK_SENTENCE + "."
)
"""The sentence appended to EVERY finding a reader meets, composed from the pin.

`R32-S1`, the round-32 challenger's residual, and the project's own lesson:
close a text check BY CONSTRUCTION, never by another text check. Round 31 held
the printed findings by SELECTING the ones that talk about the criterion, from
the pin's vocabulary -- which is a net, and the challenger was right that a
finding written in other words slips under it. The pin is not selected for any
more: it is APPENDED, by `_finding`, to every finding that is printed, and an
`ast` law over the committed bytes requires that no finding is printed any
other way.
"""


def _finding(text):
    """Print one finding, with the rule's own sentence appended by construction.

    Every branch of the report goes through here. `finding_construction_test`
    reads the committed bytes and refuses a `print` inside the findings loop,
    so a branch added later cannot emit a sentence this law has not seen.
    """
    print("  " + text + FINDING_TAIL)


def scan(docs_dir, harness_dir, quiet=False, skip=()):
    """0 = every quoted figure is emitted. 1 = a finding. 2 = inert. 5 = a
    NAMED REFUSAL: the haystack could not be derived from a commit, or the
    decision frame is not one the rules admit, so the check says so and exits
    non-zero instead of reading the working tree."""
    admissible, refusals = frame_admissible()
    if not admissible:
        if not quiet:
            print(
                # `R24-S2`: this used to print "FRAME-INADMISSIBLE: the
                # decision frame on disk is not one the closed sub-language
                # admits" in front of whatever the first refusal was -- and the
                # first refusal is usually `SELF-BYTES-UNCOMMITTED` or
                # `SELF-TREE-DIRTY`, which says nothing about the frame. A
                # reader sent to the wrong cause reads the wrong file. Every
                # refusal carries its own NAME, so the refusal leads.
                "  REFUSED: %s A verdict is read only from a run of the committed tree "
                "whose decision frame the closed sub-language admits, and %d refusal(s) "
                "stand in the way of that here."
                % (refusals[0], len(refusals))
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
    bound = asserted(harness_dir, skip)
    seen = 0
    findings = []
    for path in docs:
        rel = os.path.relpath(path, docs_dir)
        if "bidi controls" not in skip:
            # `C29-S1`, asked before anything else and asked of the LINE: with
            # the controls left in, the value class breaks and `tokens_in`
            # yields nothing, so the question is what figure the line would
            # PRETEND to be with them taken out the way every other `Cf`
            # character is taken out. If that is a figure, the line is one a
            # reader cannot check, and it is refused by name.
            with open(path, encoding="utf-8") as fh:
                for n, line in enumerate(fh, 1):
                    # The coordinator's `C30-S1`. The question is asked of the
                    # line AFTER `html.unescape`, like every other character
                    # question in this file: `&#x202e;` and `&#8238;` are
                    # SPELLINGS of `U+202E`, a Markdown renderer turns them
                    # into the control, and round 29 asked this one question
                    # of the raw line -- so the entity spelling was invisible
                    # to the guard that had just closed the character.
                    seen_line = html.unescape(line)
                    if not any(c in seen_line for c in BIDI_CONTROLS):
                        continue
                    bare = "".join(
                        c for c in seen_line if c not in BIDI_CONTROLS
                    )
                    for tok in figures_on(bare.rstrip("\n"), skip):
                        seen += 1
                        findings.append(
                            (rel, n, tok, line.strip(), "bidi control", ())
                        )
        for n, raw, tok in tokens_in(path, skip):
            seen += 1
            if tok not in emitted or tok in planted:
                findings.append((rel, n, tok, raw, "unasserted", ()))
                continue
            if not bound:
                # The control: `only an asserted case emits` is deleted, so
                # there is nothing to attribute a figure to.
                continue
            # `R27-F2`. The figure is required by SOME case; this asks whether
            # it is required by the case this document names it of.
            owners = bound.get(tok, set())
            named = set(CASE_REF.findall(raw))
            if not named:
                findings.append((rel, n, tok, raw, "no case named", owners))
            elif UNIDENTIFIED in named:
                findings.append((rel, n, tok, raw, "unidentified case", owners))
            elif not (named & {c for _s, c in owners}):
                findings.append((rel, n, tok, raw, "another case", owners))
    if not quiet:
        # The inventory, because a verdict that does not name its own input is
        # a verdict nobody can reproduce: `R15-F1` was a gitignored `.pyc` in
        # this very directory, and nothing in the output said it was being read.
        print(
            "quoted figures: %d documents, haystack from %s, %d candidate figures, "
            "%d not emitted" % (len(docs), label, seen, len(findings))
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
            _finding(
                "NOT IN THE HAYSTACK: %s differs from that commit (changed, untracked "
                "or ignored). Nothing it contains legitimises a figure." % name
            )
    if seen == 0:
        if not quiet:
            print(
                "  INERT: no `key=<number|boolean>` line was found in any document. The "
                "check is measuring nothing, which it must not report as a pass."
            )
        return 2
    for rel, n, tok, raw, why, owners in findings:
        if not quiet:
            # The normalised token is what was searched for; the line as written
            # is what a reader sees. When they differ, both are reported, because
            # naming only one of them is how a spelling hides.
            written = "" if tok in raw else " (written as `%s`)" % raw
            who = ", ".join("%s %s" % (sx, c) for sx, c in sorted(owners))
            if why == "unasserted":
                # `R27-S1` of the second round-27 report, and it is the sentence
                # a reviewer acts on: the old wording was round 26's, the
                # fifth entry of `RETIRED_SENTENCES`, which that rule let
                # anything that PRINTED satisfy -- a fixture's
                # `RAISE NOTICE`, an `echo` in the driver. What passing means is
                # stated exactly now.
                # `C28-F1`. The clause that stood here -- "nothing anywhere
                # would have failed if the number were different" -- was a
                # PROMISE this gate cannot keep, and the coordinator measured
                # it: a value case whose subject is a literal
                # (`SELECT '<figure>'::text`) passes, writes a row, and
                # legitimises the figure, so something DID assert it and
                # nothing would have failed either. What is measured is stated
                # exactly now, and what is not measured is named in the same
                # breath, because a refusal a reader acts on must not claim
                # more than it checked.
                _finding(
                    ("NOT REQUIRED BY ANY CASE: %s:%d reports `%s`%s, which is "
                     "not in the haystack this gate weighs a figure against -- "
                     "named at the end of this sentence, where every finding of "
                     "this gate names it (`C33-S1`: this clause used to say "
                     "\"that haystack\" five hundred characters before anything "
                     "said what it was): no value case of this run asserted it "
                     "and passed. "
                     "Either have a case assert it -- and name that case beside the "
                     "figure -- or drop it. WHAT THIS CHECKS is that a case of this "
                     "run asserted the string; what it does NOT check is that the "
                     "case computed it from the database rather than carrying it as "
                     "a literal of its own (`C28-F1`, a declared limit: the closure "
                     "is mutation coverage of every figure-bearing case, which is a "
                     "round of work and is not here).") % (rel, n, tok, written)
                )
            elif why == "bidi control":
                _finding(
                    "BIDI-CONTROL-IN-A-CANDIDATE: %s:%d reports `%s`%s and carries "
                    "%s, an explicit bidi formatting character. It is invisible and it "
                    "REORDERS what follows, so the figure this gate weighs and the "
                    "figure a reader sees need not be the same number. Remove it: a "
                    "figure whose displayed value depends on an invisible character is "
                    "not a figure anyone can check (the coordinator's `C29-S1`; the "
                    "set is derived by running `unicodedata.bidirectional` over every "
                    "`Cf` codepoint, not listed)."
                    % (rel, n, tok, written,
                       ", ".join("U+%04X" % ord(c)
                                  for c in html.unescape(raw)
                                  if c in BIDI_CONTROLS))
                )
            elif why == "no case named":
                _finding(
                    "NAMES NO CASE: %s:%d reports `%s`%s. A case required it (%s), "
                    "but this line does not say which, so nothing says the figure is "
                    "a figure OF what the sentence claims. Write the case in brackets "
                    "on the same line." % (rel, n, tok, written, who)
                )
            elif why == "unidentified case":
                _finding(
                    "THE CASE NAMED HAS NO IDENTIFIER: %s:%d reports `%s`%s and "
                    "names `%s`, which is what the suites record for a case titled in "
                    "prose. A case a document cannot reference cannot pin a figure; "
                    "give the case an identifier." % (rel, n, tok, written, UNIDENTIFIED)
                )
            else:
                _finding(
                    "ANOTHER CASE REQUIRED IT: %s:%d reports `%s`%s and names a case "
                    "that did not require it. The case(s) that did: %s. A true string "
                    "asserted of the wrong grid, pack or world is a false sentence made "
                    "of a true figure." % (rel, n, tok, written, who or "none")
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
    ("R14-S3 percent on a real figure", "deleted=0% [FA-02]"),
    ("R14-S3 percent inside brackets", "(deleted=0%) [FA-02]"),
    # `R23-F1`: a candidate is a TOKEN, so a second `key=value` on the line no
    # longer swallows the first one's value -- and these are the shapes the
    # challenger measured empty at `78f9392`, each of them a line this phase's
    # own instruments could print. The last one is Pack B's own output shape
    # with a fabricated number in it, which is the likeliest thing a reader
    # pastes.
    # Every key in an arm body is `fabricated_`-prefixed, and that is the
    # coordinator's `F3` rather than a style: `planted_tokens()` weighs these
    # bodies and plants every figure it finds, so an arm written with a REAL
    # key plants a real token. At `50a45a0` these arms carried `a=1`, `b=2` and
    # `core_routine=1`, and the last of those is Pack B's own output, which
    # appears 62 times in committed evidence -- so quoting Pack B's own line in
    # a fence red as NOT EMITTED. The shape an arm measures is two pairs on one
    # line; whose keys they are was never part of it.
    ("R23-F1 a second pair after the figure", "fabricated_count=999 fabricated_a=1"),
    ("R23-F1 a pair before the figure", "fabricated_a=1 fabricated_count=999"),
    ("R23-F1 a tab between the pairs", "fabricated_count=999\tfabricated_a=1"),
    ("R23-F1 a semicolon between the pairs", "fabricated_count=999; fabricated_a=1"),
    ("R23-F1 two table cells", "| fabricated_count=999 | fabricated_a=1 |"),
    ("R23-F1 three pairs", "fabricated_count=999 fabricated_a=1 fabricated_b=2"),
    ("R23-F1 the instrument's own shape", "fabricated_routine=1 fabricated_count=999"),
    # And the bound this closes rather than carries: PROSE on the line used to
    # excuse the figure beside it, disclosed as a residual since round 13. A
    # token is weighed wherever it sits now, and `--surface` reports what that
    # costs on this pack's own prose.
    ("R23-F1 prose no longer excuses the figure", "it printed fabricated_count=999 and then stopped"),
    # The seven shapes that KEEP the decoration guards measured now that a
    # token, not a line, is the candidate. Splitting on whitespace separates
    # `<!--` or `|` from the figure whenever a space sits between them, so the
    # arms that used to measure those guards stopped measuring them and the
    # matrix said so. These are the same decorations written WITHOUT the
    # space -- which is how a generator writes them, not a contrivance -- and
    # each one reds its own guard again.
    ("attached: an HTML comment with no spaces", "<!--fabricated_count=999-->"),
    ("attached: a backticked word against the figure", "fabricated_count=999`note`"),
    ("attached: a blockquote with no space", ">fabricated_count=999"),
    ("attached: a heading with no space", "###fabricated_count=999"),
    ("attached: a table cell opened with no padding", "|fabricated_count=999"),
    ("attached: a table cell closed with no padding", "fabricated_count=999|"),
    ("attached: a label with no space", "result:fabricated_count=999"),
    # `R26-F1`, the fail-open round 26 drove end to end with three fabricated
    # figures and `EXIT_SCRIPT 0`. One arm per SPELLING of the whitespace, and
    # the class is Unicode's own (`Zs`, `Zl`, `Zp`, `Cc`, `Cf`) rather than
    # these five characters: an arm measures a spelling, the category decides
    # the rule. The last two are the composition this round's first
    # normalisation step created -- `&nbsp;` resolves to `U+00A0` and NFKC
    # folds it to a plain space -- which is a shape that did not exist before
    # the entity step and was open the moment it did.
    ("R26-F1 a space before the value", "fabricated_count= 999"),
    ("R26-F1 a space on both sides", "fabricated_count = 999"),
    ("R26-F1 a space before the equals", "fabricated_count =999"),
    ("R26-F1 a tab before the value", "fabricated_count=\t999"),
    ("R26-F1 a no-break space", "fabricated_count=\u00a0999"),
    ("R26-F1 a narrow no-break space", "fabricated_count=\u202f999"),
    ("R26-F1 an &nbsp; entity", "fabricated_count=&nbsp;999"),
    ("R26-F1 the padded shape the pack prints", "rows = 81737 fabricated_count = 999"),
    # `C27-S1`, the coordinator's residual on `fc3f845` and the same class one
    # layer out: these three characters are NOT whitespace, and `NFKC` expands
    # each of them into a space and a COMBINING MARK, so the whitespace step
    # deleted the space and left the mark between the `=` and the value. Three
    # spellings of the fold, with the rule decided by the categories `Mn` and
    # `Me` rather than by these three codepoints or the fifty like them.
    ("C27-S1 an acute accent before the value", "fabricated_count=\u00b4999"),
    ("C27-S1 a diaeresis before the value", "fabricated_count=\u00a8999"),
    ("C27-S1 a bare combining mark before the value", "fabricated_count=\u0301999"),
    # `R28-F1`, round 28's blocker, and the arms that make the rule
    # position-free. The first is the decisive one: `deleted=0` is a figure a
    # case of this run really does require and the cite is the right one, so
    # the only thing wrong with the line is that a reader sees `deleted=04`.
    # Round 27's class deleted marks beside the `=` alone and weighed
    # `deleted=0`, which passed.
    ("R28-F1 a mark truncating a value a case required", "deleted=0\u03014 [FA-02]"),
    # These two borrow the arm world's own figure, like every other arm here:
    # an arm is weighed against a SYNTHETIC world, not against the pack's run,
    # so a figure of the real suites would not be in that world's sink at all.
    # Borrowing it costs the documents nothing, because while this guard holds
    # the matcher yields NO token for either body -- the control becomes
    # `U+FFFD` and the value class breaks -- so `planted_tokens()` plants
    # nothing and the three documents that quote this figure keep it. That is
    # measured, not assumed: planting the token instead redded those three
    # documents and this file's own `R14-S3` pass arm.
    ("C29-S1 a bidi override before a value a case required",
     "deleted=\u202e0 [FA-02]"),
    ("C29-S1 a bidi isolate before a value a case required",
     "deleted=\u20660 [FA-02]"),
    # `C30-S1`. The same control written as an HTML entity, hex and decimal.
    # Before the scan asked `html.unescape` these two were invisible: not a
    # candidate, no finding, rc 0, while a renderer showed the reader a
    # reordered number.
    ("C30-S1 a bidi override written as a hex HTML entity",
     "deleted=&#x202e;0 [FA-02]"),
    ("C30-S1 a bidi override written as a decimal HTML entity",
     "deleted=&#8238;0 [FA-02]"),
    ("R28-F1 a mark inside the value", "fabricated_count=9\u030199"),
    ("R28-F1 a mark on the key side of the equals", "fabricated_count\u0301=999"),
    ("R28-F1 a mark inside the key", "fabricated_co\u0301unt=999"),
    # Measured consequence of the step above, and the reason these two arms
    # exist: deleting whitespace that touches the `=` also deletes a format
    # character there, so round 14's own arm (a zero-width space BEFORE the
    # value) stopped flipping when `format characters` was deleted and that
    # guard red nothing. The class `format characters` decides is a `Cf`
    # ANYWHERE in the figure, which the whitespace step does not reach: inside
    # the value, and inside the key.
    ("R14-S1 a zero-width space inside the value", "fabricated_count=9\u200b99"),
    ("R14-S1 a zero-width space inside the key", "fabricated_co\u200bunt=999"),
    # The one of the three that FLIPS, and it took the measurement to find:
    # under the positive scan a `Cf` inside the key or the value leaves a
    # SHORTER figure that still matches (`unt=999`, `fabricated_count=9`), so
    # the arm reds with the guard deleted too and the guard was credited with
    # nothing. After the SIGN there is no shorter figure to find: the value
    # class needs a digit where the format character sits, and `999` alone has
    # no key, so with `format characters` deleted this line is not a candidate
    # at all.
    ("R14-S1 a zero-width space after the sign", "fabricated_count=-\u200b999"),
    # `R24-F1`: the five shapes the challenger drove through `50a45a0` as
    # committed commits on throwaway clones, with the whole suite green. Each
    # one is caught here by the figure's own description rather than by a row of
    # its own, which is the difference between this answer and the last three.
    ("R24-F1 a double-quoted figure", '"fabricated_count=999"'),
    ("R24-F1 a single-quoted figure", "'fabricated_count=999'"),
    ("R24-F1 a semicolon between the pairs, no space", "fabricated_routine=1;fabricated_count=999"),
    ("R24-F1 a comma between the pairs, no space", "fabricated_routine=1,fabricated_count=999"),
    ("R24-F1 pipes with no padding", "|fabricated_routine=1|fabricated_count=999|"),
    # The coordinator's `F2` added four separators the challenger had not run.
    # They need no rule of their own under the positive scan, which is the
    # point of measuring them here rather than listing them anywhere.
    ("R24-F1 an ampersand between the pairs", "fabricated_a=1&fabricated_count=999"),
    ("R24-F1 a slash between the pairs", "fabricated_a=1/fabricated_count=999"),
    ("R24-F1 a bracketed pair list", "(fabricated_count=999,fabricated_a=1)"),
    # And the two shapes the inversion closes that no round had reached: a long
    # option, which the old key class refused for the leading hyphens, and the
    # generator's own single-quoted control line, which is the shape round 24
    # pointed out this pack PRINTS and could not see.
    ("R24-F1 a long option", "--fabricated_count=999"),
    # `R24-F1` took `hyphen in the key`'s last arm away, and a guard that reds
    # nothing is deleted or armed. Its old arm, `fabricated-count=999`, reds
    # either way now: the left boundary admits a key that begins after a
    # hyphen, because that is how a long option is written, so with the guard
    # deleted the scan finds `count=999` instead and a fabricated figure reds
    # under both keys. What the guard decides is not WHETHER a hyphenated
    # figure is weighed but WHICH TOKEN is weighed, and that shows only where
    # the two tokens get different verdicts. `deleted=0` IS emitted and
    # `zz-deleted=0` is not, so with the guard the arm catches a fabricated
    # figure and with it deleted the scan weighs `deleted=0` and passes.
    ("R24-F1 a fabricated figure whose hyphenated key ends in an emitted one", "zz-deleted=0 [FA-02]"),
    (
        "R24-F1 the pack's own quoted control line",
        "control: '### fabricated_count=999' still becomes 'fabricated_count=999'",
    ),
    # `C25-F1`, the coordinator's blocker: an HTML character reference is a
    # SPELLING of the figure, not a place it sits, and the four spellings
    # `_strip` normalised did not reach it. Two independent CommonMark
    # renderers agree all four of these render to exactly the same figure a
    # reader sees, and at `36c9094` each one was committed on a clean tree and
    # walked the whole authoritative suite green. `html.unescape` resolves the
    # whole standard table rather than a list of names of my own, which is the
    # difference between a normalisation and an enumerated exemption.
    ("C25-F1 a decimal character reference for the `=`", "fabricated_count&#61;999"),
    ("C25-F1 a hexadecimal character reference for the `=`", "fabricated_count&#x3d;999"),
    ("C25-F1 a named character reference for the `=`", "fabricated_count&equals;999"),
    ("C25-F1 a character reference inside the value", "fabricated_count=&#57;99"),
]
SKIP = [
    ("named: inline code span only", "the value `fabricated_count=999` is quoted in prose"),
    ("named: UPPERCASE key", "FABRICATED_COUNT=999"),
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
    # `R24-F1`'s two boundaries, one arm each, and both of them keep a bound
    # this pack already disclosed rather than opening a new one: an uppercase
    # key is not a figure, and a date is not a figure. Delete the left boundary
    # and `count=999` is read out of the middle of an uppercase identifier;
    # delete the right one and `date=2026` is read out of a date.
    ("key boundary: a key that is the tail of an uppercase name", "FABRICATED_count=999"),
    ("value boundary: a date is not a figure", "date=2026-10-19"),
]
PASSES = [
    # `R27-F2`: a figure quoted WITH the case that required it. The bracketed
    # identifier is not decoration -- it is what makes the quotation a claim
    # about something, and a figure quoted without one is a finding of its own
    # (`NAMES NO CASE`), armed below.
    ("an emitted figure", "present=true [FA-01]"),
    ("R14-S3 control: the figure itself", "deleted=0 [FA-02]"),
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


# `R24-F1`. §7.13's twelve-row table, and the negative control that RAN it,
# are gone with the thirteen decoration guards. The control's whole content was
# "with only those twelve skipped the stripper is still not the identity, and
# what it still does is what the table missed" -- and there is no longer any
# decoration rule for a table of decoration rules to miss. What it guarded
# against, an unnamed transformation in the stripper, is covered by the two
# things that remain: `identity_test` below, over four guards instead of
# seventeen, and the structural parse, which refuses a rebinding outside a
# named guard whether or not anyone wrote a row for it.
#
# Two of this pack's own committed lines were that control's printed output,
# carrying `'fabricated_count=999'` in single quotes -- the exact shape round 24
# attacked -- and they are the only four findings the inversion produced on this
# pack's prose. They go with the control that generated them, at the generator,
# which is where round 23 ruled such a thing is answered rather than in an
# exemption list.

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
    # `R24-F1`: the positive scan is checked here too, in the direction the
    # identity test is for. With every guard skipped the SCAN must find the
    # whole token and nothing less, because a scan that still narrowed its
    # candidate with every guard deleted would be narrowing it somewhere
    # `GUARDS` does not name.
    for line in IDENTITY_PROBE:
        got = _candidates(line, GUARDS)
        want = [t for t in line.split() if t]
        if got != want:
            print(
                "  identity **FAILED**: with every guard skipped, the scan of %r found "
                "%r and the line's own tokens are %r, so the candidate unit is narrowed "
                "somewhere GUARDS does not name" % (line, got, want)
            )
            ok = False
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
# What a RUN of `fake_proofs.py` PRINTS -- the two cases it holds, as output
# and not as source. It was a world's whole haystack under round 26's rule;
# since `R27-F1` it is only the PRINTED half of a world, kept in every world
# beside the rows so that "printed but required by nothing" is a world this
# selftest actually contains.
FAKE_RUN_OUTPUT = "  a  SELECT 1 -> present=true\n  b  SELECT 2 -> deleted=0\n"
# `R27-F1`. What a world's SINK holds: one row per expectation a value case
# required and passed, in the shape `case()` writes. The printed text above is
# kept beside it deliberately -- every world's sink carries BOTH, so a figure
# that is only PRINTED is in the world and legitimises nothing, which is what
# the notice and echo arms measure.
def _row(case_id, figure, suite="PACK_A"):
    return "FIGURE\t%s\t%s\t%s\n" % (suite, case_id, figure)


FAKE_SINK = (
    FAKE_RUN_OUTPUT + _row("FA-01", "present=true") + _row("FA-02", "deleted=0")
)
# The two fixture plants of round 27, each PRINTED in the run's own voice and
# required by nothing.
NOTICE_PLANT = "spectre_notice=7722"
ECHO_PLANT = "spectre_echo=4409"
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
    # R15-S4: a planted token, committed under the harness, legitimising
    # itself. The world used to carry it in a committed `RUN-EVIDENCE.txt`, and
    # `R25-F1`'s guard now drops every `.txt` from the haystack -- which took
    # this arm away and left `planted tokens` redding nothing, so the arm is
    # moved to where that guard does not reach and this one still has to
    # answer: an INSTRUMENT'S OWN SOURCE. The `.txt` half is kept beside it, so
    # the world is the one round 15 reported and the two exclusions are
    # measured apart rather than one standing in for the other.
    "runlog": (
        {
            "fake_proofs.py": FAKE_PROOFS,
            "fake_arms.py": 'ARM = ("N0 control: a bare line", "' + PLANT + '")\n',
            "RUN-EVIDENCE.txt": (
                "  catch  N0 control: a bare line            rc=1 (want 1) -> as required\n"
                + PLANT
                + "\n"
            ),
        },
        {},
    ),
    # R16-F1: a scratch file in the working tree, committed nowhere. The plant
    # is a `.py` since `R25-F1`: under the positive haystack rule a `.log`
    # emits nothing whether it is committed or not, so a plant in one measured
    # the suffix rule instead of the commit derivation this arm is for.
    "untracked": ({"fake_proofs.py": FAKE_PROOFS}, {"scratch.py": PROBE + "\n"}),
    # R16-F1: round 15's own fail-open, gitignored exactly as it was.
    "pyc": (
        {"fake_proofs.py": FAKE_PROOFS, ".gitignore": "__pycache__/\nignored_output.py\n"},
        {
            # Round 15's own shape, kept.
            "__pycache__/check_fenced_figures.cpython-313.pyc": PROBE + "\n",
            # And the same shape in a file the positive rule WOULD admit, for
            # the reason the `untracked` world changed: a `.pyc` is not a file
            # this tree runs, so a plant in one no longer reaches the commit
            # derivation this arm measures.
            "ignored_output.py": PROBE + "\n",
        },
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
    # `R25-F1`: a committed transcript carrying the token, which is round 25's
    # own blocker. The file is tracked, under the harness, named as every
    # recording in this directory is named -- and with the guard it legitimises
    # nothing.
    "transcript": (
        {
            "fake_proofs.py": FAKE_PROOFS,
            "RUN-EVIDENCE-AUTHORITATIVE-ROUND99.txt": (
                "RUN_ID : p11-the-arm-world\nEXIT_SCRIPT : 0\n" + PROBE + "\n"
            ),
        },
        {},
    ),
    # R16-F1: the checker's own prose, committed, under its own name.
    "stem": (
        {"fake_proofs.py": FAKE_PROOFS, "check_fenced_figures.py": "# " + PROBE + "\n"},
        {},
    ),
    # `R26-S1`, the three shapes the second challenger measured through
    # `bc54e4c` with the whole pack green. Each is COMMITTED, each is a file
    # the previous rule admitted, and none of them produces anything: a
    # comment in an instrument the run executes, a `.py` nothing imports or
    # runs, and a `--` comment in a mutation world the authoritative run never
    # applies. With `only a run emits` deleted all three legitimise the figure,
    # which is the flip that makes the fix measured.
    "comment": ({"fake_proofs.py": FAKE_PROOFS + "# " + PROBE + "\n"}, {}),
    "unrun": ({"fake_proofs.py": FAKE_PROOFS, "notes_dump.py": PROBE + "\n"}, {}),
    "mutation": (
        {"fake_proofs.py": FAKE_PROOFS, "M10-noop.sql": "-- " + PROBE + "\n"},
        {},
    ),
    # The PASS direction: a case REQUIRED the figure, so it is legitimate and
    # the document may quote it -- naming that case. Nothing in this world's
    # files carries it.
    "printed": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # `the same spelling on both sides`: the case's expectation is recorded
    # PADDED, the way this pack's own output prints it, and the document writes
    # it bare.
    "padded": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # The capture's own four refusals, each read by NAME in
    # `capture_names_test`.
    "split": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    "nocapture": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    "capture-inside": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    "capture-otherhead": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    "capture-empty": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # `R27-F1`: the two worlds the second challenger drove. The repository is
    # the plain one; the plant is in what the run PRINTED, which is where a
    # fixture's `RAISE NOTICE` and the driver's `echo` land.
    "notice": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    "echo": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # A sink carrying this commit's head and not one row.
    "norows": ({"fake_proofs.py": FAKE_PROOFS}, {}),
    # `R27-F2`: a case titled in prose.
    "unidentified": ({"fake_proofs.py": FAKE_PROOFS}, {}),
}

# What each world's run printed, where it is not just what `fake_proofs.py`
# prints.
WORLD_OUTPUT = {
    # `R15-S4`, and it is LOUDER under the new rule than it was under the old
    # one. The selftest prints every arm's label, and an arm's label carries
    # the token that arm plants; `rebuild_and_prove.sh` runs the selftest into
    # the same capture the figure gate then reads. So the planted tokens are
    # genuinely in the haystack of every real run, and `planted_tokens()` is
    # what keeps a token this instrument printed from legitimising itself. The
    # world says so by printing the plant the way the selftest prints it.
    # `R15-S4` under round 27's rule. A token this instrument plants in its own
    # arms must not legitimise itself, and since `R27-F1` the only way into the
    # haystack is a CASE'S EXPECTATION -- so the world carries the plant as a
    # ROW, which is a case in the suites asserting the arm's own token. That is
    # exactly the planter's remaining path, and `planted_tokens()` is what
    # closes it. The committed recording and the arm source are kept in the
    # world beside it: under this rule neither emits anything, which is what
    # `only an asserted case emits` is for.
    "runlog": FAKE_SINK
    + _row("FA-04", PLANT)
    + "  catch  N0 control: a bare line            rc=1 (want 1) -> as required\n",
    "printed": FAKE_SINK + _row("FA-03", PROBE),
    # The line-terminator half of `R26-F1`: the run printed the key and its
    # `=` at the end of one line and the value at the start of the next. That
    # is not a figure any line of the output carries, and deleting the newline
    # would have made one.
    # Two rows of ONE case, the key and its `=` in one and the value in the
    # other: not a figure either row carries, and deleting the line terminator
    # beside the `=` would have made one.
    "split": FAKE_SINK + _row("FA-03", "world_probe=") + _row("FA-03", "404"),
    # Padded on both sides with a no-break space: the TAB is the sink's own
    # field separator, so a row cannot carry one, and a spelling rule measured
    # with a character the row cannot hold measures nothing.
    "padded": FAKE_SINK + _row("FA-03", PROBE.replace("=", "\u00a0=\u00a0")),
    # `R27-F1`, the second challenger's two worlds. The sink is the real one;
    # the plants are PRINTED beside it, exactly as `psql` and the driver print,
    # and nothing required either number.
    "notice": FAKE_SINK
    + "psql:/var/tmp/p11/prep/phase11/harness/world.sql:75: NOTICE:  "
    + NOTICE_PLANT
    + "\n",
    "echo": FAKE_SINK + "=== 5c. the driver says: " + ECHO_PLANT + " ===\n",
    # `R27-F1`'s refusal: a sink with this commit's head and not one row.
    "norows": FAKE_RUN_OUTPUT,
    # `R27-F2`: a case whose title is prose, which the suites record as
    # `UNIDENTIFIED-CASE`. A case a document cannot reference pins nothing.
    "unidentified": FAKE_SINK + _row(UNIDENTIFIED, PROBE),
}

# The worlds whose subject is the CAPTURE rather than the tree: no capture at
# all, a capture inside the repository that holds the subject, a capture of
# another commit, and an empty one.
CAPTURE_WORLDS = ("nocapture", "capture-inside", "capture-otherhead", "capture-empty")

_CAPTURES = {}

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


def _capture_file(tag, sha, output, at=None):
    """One capture, written where `at` says or outside every repository.

    The `RUN_HEAD` line is the one `rebuild_and_prove.sh` prints, so a capture
    names the commit whose run produced it.
    """
    body = "RUN_HEAD          : %s\n" % sha + output
    if at is not None:
        open(at, "w", encoding="utf-8").write(body)
        return at
    fd, path = tempfile.mkstemp(prefix="p11-capture-%s-" % tag, suffix=".txt")
    os.close(fd)
    atexit.register(os.unlink, path)
    open(path, "w", encoding="utf-8").write(body)
    return path


def _world_capture(kind, harness):
    """The file the world's run printed, written OUTSIDE the world's repository.

    One per kind per process, like the world itself. The `RUN_HEAD` line is the
    one the driver prints, so a capture is tied to the commit it is weighed
    against; the four `CAPTURE_WORLDS` deviate from that on purpose, each in
    one way, so each refusal has an arm that reads its name.
    """
    if kind in _CAPTURES:
        return _CAPTURES[kind]
    if kind == "nocapture":
        _CAPTURES[kind] = None
        return None
    try:
        sha = _commit_of(harness)
    except Refusal:
        # `norepo`: there is no commit to name. The refusal this world
        # measures is raised before the capture is read.
        sha = "0" * 40
    if kind == "capture-otherhead":
        sha = "1" * 40
    output = WORLD_OUTPUT.get(kind, FAKE_SINK)
    if kind == "capture-empty":
        fd, path = tempfile.mkstemp(prefix="p11-capture-empty-", suffix=".txt")
        os.close(fd)
        atexit.register(os.unlink, path)
        open(path, "w", encoding="utf-8").write("")
    elif kind == "capture-inside":
        # INSIDE the world's own repository, which is the committed recording
        # round 25 blocked, reached by another route.
        path = _capture_file(kind, sha, output, at=os.path.join(harness, "RUN-CAPTURE.txt"))
    else:
        path = _capture_file(kind, sha, output)
    _CAPTURES[kind] = path
    return path


def _arm(body, skip=(), relpath="a.md", kind="plain", quiet=True):
    """One document line, weighed against one world. `relpath` is under docs.

    The world's own capture is installed for the length of the arm and taken
    away again: an arm reads what ITS run printed, and never what this
    process's run printed.
    """
    harness = _world_harness(kind)
    capture = _world_capture(kind, harness)
    was = list(_RUN_CAPTURE)
    _RUN_CAPTURE[:] = [capture] if capture else []
    try:
        with tempfile.TemporaryDirectory() as d:
            docs = os.path.join(d, "docs")
            os.makedirs(docs)
            _write(docs, relpath, body + "\n")
            return scan(docs, harness, quiet=quiet, skip=skip)
    finally:
        _RUN_CAPTURE[:] = was


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


def _gitfile_arm(skip=(), quiet=True):
    """The census and git disagree: a named refusal, from the harness seat.

    `C32-S3`: `quiet` is a parameter here, and not hardcoded, for the reason
    `_arm` gained one in round 32 -- a scan nobody can run LOUD prints
    paragraphs no law reads. `printed_seat_sentences` runs this arm loud and
    censuses what it says.
    """
    subject, harness = _gitfile_world()
    capture = _seat_capture("gitfile", subject)
    was = os.getcwd()
    with tempfile.TemporaryDirectory() as docs_at:
        docs = os.path.join(docs_at, "docs")
        os.makedirs(docs)
        _write(docs, "a.md", PROBE + "\n")
        held = list(_RUN_CAPTURE)
        _RUN_CAPTURE[:] = [capture]
        try:
            os.chdir(harness)
            return scan(docs, harness, quiet=quiet, skip=skip)
        finally:
            os.chdir(was)
            _RUN_CAPTURE[:] = held


_SEAT_CAPTURES = {}


def _seat_capture(tag, root):
    """The capture for a world whose harness sits inside a repository.

    The head is the OUTER repository's, which is the head of the run that
    produced the output. With the census deleted the gate resolves a PLANTED
    repository's head instead, and the capture of this run does not carry it --
    which is the difference `capture_names_test` reads by name.
    """
    if tag in _SEAT_CAPTURES:
        return _SEAT_CAPTURES[tag]
    try:
        sha = _commit_of(root)
    except Refusal:
        sha = "0" * 40
    _SEAT_CAPTURES[tag] = _capture_file(tag, sha, FAKE_SINK)
    return _SEAT_CAPTURES[tag]


def _anchor_arm(where, cwd_kind, skip=(), quiet=True):
    """One anchor world, weighed from one working directory.

    `C32-S3`: `quiet` is a parameter, not a hardcoded `True`. See
    `_gitfile_arm`.
    """
    root, harness, sibling = _anchor_world(where)
    capture = _seat_capture("anchor-%s" % where, root)
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
        held = list(_RUN_CAPTURE)
        _RUN_CAPTURE[:] = [capture]
        try:
            os.chdir(seat)
            return scan(docs, harness, quiet=quiet, skip=skip)
        finally:
            os.chdir(was)
            _RUN_CAPTURE[:] = held


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
        ("R15-S4 a planted token is not its own evidence", "runlog", PLANT + " [FA-04]"),
        ("R16-F1 an untracked scratch file is not evidence", "untracked", PROBE),
        ("R16-F1 a gitignored .pyc is not evidence", "pyc", PROBE),
        ("R16-F1 the checker is not its own evidence", "stem", PROBE),
        ("R25-F1 a committed transcript emits nothing", "transcript", PROBE),
        # `R26-S1`: the three shapes the previous rule admitted. Each is the
        # deletion control of `only a run emits` as well as an arm of its own:
        # with the guard deleted the tree's text decides again and all three
        # pass.
        ("R26-S1 a comment in an instrument emits nothing", "comment", PROBE),
        ("R26-S1 a committed .py nothing runs emits nothing", "unrun", PROBE),
        ("R26-S1 an unapplied mutation world emits nothing", "mutation", PROBE),
    ):
        arms.append((label, 1, (lambda k=kind, x=token: _arm(x, skip, "a.md", k))))
    # The PASS direction of the same rule, which is what keeps it from being a
    # net that reds everything: a case required the figure and the document
    # names that case.
    arms.append(
        (
            "R26-S1 what the run printed is emitted",
            0,
            (lambda: _arm(PROBE + " [FA-03]", skip, "a.md", "printed")),
        )
    )
    # ── `R27-F1`: PRINTING IS NOT REQUIRING ───────────────────────────────
    # Both challengers of round 27 drove a fabricated figure to
    # `EXIT_SCRIPT 0` through something that merely PRINTED: a `RAISE NOTICE`
    # in a data fixture, an `echo` in the driver, and the driver's own echo of
    # `TMPDIR`. Each world below carries the real sink AND the plant in the
    # printed text beside it, so what is measured is the difference between
    # printed and required, with everything else held still. Deleting
    # `only an asserted case emits` makes all three PASS -- that is round 26's
    # rule, restored by value.
    arms.append(
        (
            "R27-F1 a RAISE NOTICE in a fixture requires nothing",
            1,
            (lambda: _arm(NOTICE_PLANT + " [FA-01]", skip, "a.md", "notice")),
        )
    )
    arms.append(
        (
            "R27-F1 an echo in the driver requires nothing",
            1,
            (lambda: _arm(ECHO_PLANT + " [FA-01]", skip, "a.md", "echo")),
        )
    )
    # The same world, with no case named: the figure is not required either
    # way, and the finding a reader gets must be the one about requirement.
    arms.append(
        (
            "R27-F1 a printed plant with no case named requires nothing",
            1,
            (lambda: _arm(NOTICE_PLANT, skip, "a.md", "notice")),
        )
    )
    # A sink that carries this commit's head and not one row is a REFUSAL, not
    # a pass: a gate whose haystack is empty passes nothing.
    arms.append(
        (
            "R27-F1 a sink with no rows is refused",
            5,
            (lambda: _arm(PROBE + " [FA-03]", skip, "a.md", "norows")),
        )
    )
    # ── `R27-F2`: A FIGURE IS A FIGURE *OF* SOMETHING ─────────────────────
    # `axes=3` is true of Pack A's grid and was asserted of Pack B's, where
    # the same run requires `axes=2`. The three arms are the three ways a
    # quotation can fail to be about the case that required it.
    arms.append(
        (
            "R27-F2 a figure attributed to another case",
            1,
            (lambda: _arm("present=true [FA-02]", skip, "a.md")),
        )
    )
    arms.append(
        (
            "R27-F2 a required figure naming no case at all",
            1,
            (lambda: _arm("present=true", skip, "a.md")),
        )
    )
    arms.append(
        (
            "R27-F2 a figure naming a case the suites could not identify",
            1,
            (lambda: _arm(PROBE + " [" + UNIDENTIFIED + "]", skip, "a.md", "unidentified")),
        )
    )
    # The other direction of the same rule, and a hole this round found in its
    # own fix: a figure split across two PRINTED lines is not a figure the run
    # printed.
    arms.append(
        (
            "R26-F1 a figure split across two printed lines emits nothing",
            1,
            (lambda: _arm(PROBE + " [FA-03]", skip, "a.md", "split")),
        )
    )
    # `the same spelling on both sides`: the case required it PADDED, the
    # document writes it bare, and they are one figure.
    arms.append(
        (
            "R26-F1 a padded figure in the output is the same figure",
            0,
            (lambda: _arm(PROBE + " [FA-03]", skip, "a.md", "padded")),
        )
    )
    # The capture's four refusals. `capture_names_test` reads each one BY NAME;
    # these assert the exit, which is what a reader of the summary sees.
    for label, kind in (
        ("R26-S1 no capture is a refusal", "nocapture"),
        ("R26-S1 a capture inside the subject is refused", "capture-inside"),
        ("R26-S1 a capture of another head is refused", "capture-otherhead"),
        ("R26-S1 an empty capture is refused", "capture-empty"),
    ):
        arms.append((label, 5, (lambda k=kind: _arm(PROBE, skip, "a.md", k))))
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
    for guard, flipped in _guard_rows():
        shown = ", ".join(flipped[:3]) + (" +%d more" % (len(flipped) - 3) if len(flipped) > 3 else "")
        good = bool(flipped)
        verdict = "measured" if good else "**REDS NOTHING: delete it or arm it**"
        print("  guard  %-24s reds %2d arm(s): %-52s -> %s" % (guard, len(flipped), shown, verdict))
        ok = ok and good
    print(
        "  %d guards, every one of them deleted on its own and measured -- %s"
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
TRANSFORMERS = (_strip,)


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
#   2. WHAT A TRANSFORMER MAY DO. `_strip` is covered by
#      `guarded_transformations`, which proves every rebinding sits inside a
#      named branch -- and a transformation that DROPS a candidate decides, under
#      another name. Round 20 named this as where it would look next and it is
#      not closed here.
#   3. COMPLETENESS OF THE ADMIT-LISTS. Every entry of `DECIDING_MODULE_CALLS`
#      and every name in `FRAME_METHODS` is checked to be LIVE, and that is a
#      check for DEAD entries and not for MISSING ones. The coordinator's
#      standing ruling on this phase: `each entry is live` may never stand in
#      for `the set is complete`. What stood here argued the gap was harmless --
#      that anything the lists do not admit is refused BY NAME, so they are read
#      through a refusal rather than through their own completeness -- and round
#      21 measured that argument FALSE: **the planter's move is not to evade the
#      list but to EXTEND it.** One new entry, its call inside the guard the
#      entry names, and the fabricated figure passed every gate. Reading a list
#      through a refusal does not help when the entry exists. The sentence is
#      deleted rather than qualified; what is checked is that a dead entry reds,
#      and the gap is the gap. What it costs a planter now is that the entry has
#      to be in the COMMIT, under the published digest, in the diff two
#      reviewers read.
#
# THE DECIDING CODE IS READ FROM THE COMMIT, and that single change is what
# replaces the fourth line that used to stand here. The line said the file's own
# bytes were outside the rules -- `HARNESS_SHA256` printed and never compared --
# which read as a disclosure and worked as a hole, because it would have covered
# every escape in this list, the one ruled a blocker included. **A residual that
# covers everything discharges nothing.** Two reviews then walked out of it in
# succession:
#
#     -def scan(docs_dir, harness_dir, quiet=False, skip=()):
#     +def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):
#
# `_main` calls `scan()` with no `skip`, so that default switches a named guard
# off for every real run -- outside the decision parse, outside the constants
# digest, outside every rule key. The first answer pinned every harness byte
# against a TABLE in the manifest; round 21 measured the same class one level up
# by taking the step the refusal text itself prescribed -- edit the pattern,
# re-run `--decision-constants`, commit the printed digest -- and every gate
# returned 0 with the fabricated figure through. **A pin inside the thing it
# pins is not a pin, and a table a planter edits in the same commit is the same
# mistake with one more file in it.**
#
# So nothing in this file pins anything. The rules are read from the COMMIT:
#
#   * every deciding file under `prep/phase11/harness/` must equal
#     `git show <resolved anchored sha>:<path>`, refused by name as
#     `SELF-BYTES-UNCOMMITTED`, `SELF-FILE-UNCOMMITTED`, `SELF-FILE-ABSENT`;
#   * `_source_of` takes the frame's source from THAT BLOB rather than from
#     `inspect.getsource`, so a working-tree edit cannot be measured as a rule
#     at all, and a name the commit does not define is a named refusal and never
#     a fallback to the running file;
#   * the law is read TWICE, once with this file's own code and once by
#     `check_harness_bytes.py`, which imports nothing from here and is itself one
#     of the deciding files -- because a file cannot be the authority on its own
#     bytes;
#   * the anchor is the same structural one the haystack uses, which is the most
#     attacked and best armed machinery in this phase.
#
# An escape from any round between 16 and 21 -- a gitignored artefact, an AST
# gap, a receiver, a rebound attribute, an argument, a re-pin, an added
# admit-list entry -- is read against the commit, and a WORKING-TREE edit now
# produces no admissible transcript rather than a green one: a dirty tree is
# refused BY NAME here, in the second reader and in the shell step. This
# paragraph used to say such an escape "has to be COMMITTED to work", and round
# 22 measured that false with three uncommitted hunks in this file. The true
# sentence is the limit: a transcript is evidence only when produced from a
# CLEAN tree whose `HEAD` is the committed sha, and reviewers run from fresh
# clones. An uncommitted edit, one file or many, is the declared limit.
#
#   WHAT THIS DOES NOT DO: it does not stop a planter who commits. Nothing
#   executable can. What it changes is that the change is in the diff, under the
#   published digest, in front of an independent challenger and a coordinator.
#   That is the whole of the guarantee, and it is why this phase's chain has
#   three links and why no author signs their own work.
#
# Every claim in this paragraph is armed: round 19's two escapes, round 20's
# three, the coordinator's three, `C21`'s own line and round 21's own, each with
# the ONE thing that refuses it deleted beside it -- a rule by key (`RULE_KEYS`,
# which now includes `lambda`, so no arm in the set names none), an object check
# by key (`OBJECT_KEYS`), or, for the byte law, the comparison itself deleted
# from a COPY of the reader. Each arm reads the REFUSAL NAME, which is `C21-F2`
# and `R21-F1`'s second half: the arm that used to stand for the argument pin
# compared two digests and never ran the refusal, so deleting the refusal left
# it printing `as required`.

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
# `.lower` left with `R24-F1`: the case of a boolean VALUE is folded by the
# value class's own inline flag now, so nothing in the frame calls it, and an
# entry nothing calls is checked for below rather than left to widen the
# language. A method call cannot
# smuggle a transformation past rule 4 even so: binding it over the name it
# came from is a second binding, and deciding on its result is a test the node
# set does not admit. Every entry is checked to be in use below, so a
# permissive entry cannot sit here dead.
FRAME_METHODS = ("append", "rstrip", "strip", "partition")
FRAME_MODULES = ("re", "os", "unicodedata", "html")
# Parsed by `guarded_transformations` rather than by these rules. The claim is
# checked below against the tuple that function is actually run over.
PARSED_AS_TRANSFORMERS = ("_strip",)

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
    # `R24-F1`'s one new deciding call: the positive scan itself. Its entry
    # records `None` where a guard would be for the same reason `_is_figure`'s
    # return entry does -- finding the figures on a line IS this function's
    # purpose and there is no guard to name. Which PATTERN it scans with is a
    # named guard, read off `_figure_pattern`'s own branches by the parse (the
    # comment here used to name `_scan_pattern`, a function round 24's answer
    # deleted when the frame's descent proved one level too shallow for it).
    # Two call sites, named apart: the control scan sits inside the branch
    # `"positive scan" in skip` opens, and the real one sits inside no guard.
    # An entry whose guard is named matches only the site that guard wraps, and
    # it is listed FIRST so the unguarded entry is left with the other site --
    # which is how each of the two entries ends up admitting exactly one.
    ("_candidates", "re", "findall", "return", "positive scan"),
    ("_candidates", "re", "findall", "return", None),
)

# `C25-F1`. The module call a TRANSFORMER makes, listed apart because the rules
# above are about what may DECIDE and `_strip` decides nothing -- it is parsed
# by `guarded_transformations`, which bounds where a rebinding may sit and says
# nothing about the objects it calls. That distinction is real and it is not a
# reason to leave the object unpinned: a transformation that drops a candidate
# decides under another name, which is declared bound 2 above, so
# `html.unescape` is read in WHAT IS RUNNING by the same three checks and the
# same four refusal names as every entry above. `html` is therefore in
# `FRAME_MODULES` and in the import-time snapshot, because the file's own rule
# is that a module reachable from the frame with no snapshot is an unpinned
# attribute. Same five-part shape as the entries above so one loop reads both;
# the position is `transform` because there is no test and no return to name.
TRANSFORMER_MODULE_CALLS = (
    ("_strip", "html", "unescape", "transform", "html character references"),
)

DECISION_EXCEPTIONS = {
    "_is_figure": (
        "'=' not in s",
        "not key or not val",
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
# There is NO pinned literal here any more, and its absence is the fix. See
# `decision_constants_digest`: the digest below is published in the manifest and
# the constants are pinned by being read from the COMMIT, because a digest held
# beside the constants it pins is a representation the subject can alter
# (`R21-F1`, this phase's `P7 R11` law).


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


def decision_constants_digest():
    """The digest of the canonical constants text — INFORMATIONAL, nothing else.

    `R21-F1`. This used to be a RULE: the digest was compared with a literal
    `DECISION_CONSTANTS_SHA256` held in this same file. Round 21 ran the step
    the refusal text itself prescribed -- edit the pattern, re-run
    `--decision-constants`, commit the printed digest -- and every gate returned
    0 with the fabricated figure through. **A pin inside the thing it pins is
    not a pin**, and a refusal that tells its reader how to satisfy it is a
    manual, not a law.

    The literal is gone. What pins the constants now is that they are read from
    the COMMIT: the constants are literals and module-level values of the
    deciding file, `self_bytes_committed` refuses unless that file is the file
    the commit holds, and the committed digest is published in the manifest for
    a reader. So an argument edit is still visible -- it is in the diff, under a
    published digest, in front of two reviewers -- and it is no longer something
    this file claims to catch by itself.
    """
    try:
        return hashlib.sha256(decision_constants().encode("utf-8")).hexdigest()
    except (Refusal, OSError, TypeError, SyntaxError, IndexError):
        return None


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
    for fn, mod, attr, position, _guard in DECIDING_MODULE_CALLS + TRANSFORMER_MODULE_CALLS:
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


_COMMITTED_AST = {}


def _source_of(func):
    """The `FunctionDef` for `func`, taken from the COMMITTED bytes of this file.

    Round 21's direction, adopted as a ruling: the deciding code is read from
    the commit, not the working tree. `inspect.getsource` reads the file on
    disk, so every rule below used to be a rule about whatever was on disk at
    the moment the gate ran -- which is how a default argument, a re-pinned
    digest and an added admit-list entry each decided something no reviewer had
    seen. The source comes out of `git show <resolved anchored sha>:<path>`
    now, and `self_bytes_committed` refuses by name when the two differ, so a
    working-tree edit cannot be measured as a rule at all.

    A name the commit does not define at module level is a NAMED refusal and
    never a fallback to the running file: falling back is exactly the hole.
    """
    name = getattr(func, "__name__", None)
    if not _COMMITTED_AST:
        _msgs, text = committed_text(os.path.basename(os.path.realpath(__file__)))
        if text is None:
            raise Refusal(
                "FRAME-SOURCE-NOT-IN-COMMIT: this file's committed bytes could not be "
                "read, so the rules this run would apply are not the rules the commit "
                "carries. The anchor's own refusal is reported beside this one."
            )
        tree = ast.parse(text)
        _COMMITTED_AST.update(
            {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        )
    got = _COMMITTED_AST.get(name)
    if got is None:
        raise Refusal(
            "FRAME-SOURCE-NOT-IN-COMMIT: the commit's copy of this file defines no "
            "module-level function named %r, so there is no reviewed source for what is "
            "running under that name." % name
        )
    return got


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
# `R21-S3`: the lambda refusal was the one arm in the set that named no key, so
# the round's own law -- a fix is done only when deleting IT reds a gate -- did
# not reach it. It has a key now, and every arm in the set names one.
RULE_KEYS = ("positions", "one-site", "receiver", "data", "shadow", "lambda")


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
                if what == "lambda" and "lambda" in rules:
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
    for s in _candidates(line, skip):
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
        "C20 P3/R21-S3 a module-level lambda, refused by name rather than followed",
        '    if _ARM_LAMBDA(s):\n        return False',
        ("lambda",),
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
    self_ok, self_msgs = self_bytes_committed()
    ident_ok = ident_ok and fn_ok and self_ok
    ident_msgs = tuple(ident_msgs) + tuple(fn_msgs) + tuple(self_msgs)
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
    # Every function either parse covers, for the source/bytecode tie below.
    compiled = set()
    for func in (
        figures_on,
        tokens_in,
        _exempted,
        _is_figure,
        _candidates,
        _figure_pattern,
        _key_class,
        _value_class,
    ) + TRANSFORMERS:
        compiled |= {c for c in func.__code__.co_consts if isinstance(c, str)}
    for func in (figures_on, tokens_in, _exempted, _is_figure):
        fn = _source_of(func)
        good, msgs, keys = decision_frame(fn, DECISION_EXCEPTIONS.get(func.__name__, ()))
        for m in msgs:
            print("  decision **FAILED**: %s" % m)
        drifted = sorted(k for k in keys if k not in compiled)
        if drifted:
            # `R24-F1` removed the name exemption this check used to carry. It
            # read "the descent collects the callees' keys too, which are not
            # constants of the caller", and the remedy was to skip the two
            # functions that descend -- so a guard name invented in `figures_on`
            # or `tokens_in` was tied to nothing at all. The tie is now against
            # the constants of EVERY function the parses cover, which is the
            # granularity the descent actually has, and no function is skipped.
            print(
                "  decision **FAILED**: %s names guards no compiled function the "
                "parses cover holds (%s)" % (func.__name__, ", ".join(drifted))
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
    # `R26-F1`, round 26's blocker: the challenger's report quotes its three
    # fabricated figures and its own nine-line matcher battery. Each arm below
    # records a DESCRIPTION rather than the verbatim line, for the reason the
    # `R24-F1` entries give: an arm body's figures are PLANTED, and the
    # round's own probe token would plant a token beside a real key.
    "R26-F1 a space before the value": (
        None, "a space between the `=` and the value, the round's own first row"),
    "R26-F1 a space on both sides": (
        None, "a space on each side of the `=`, the shape the three fabricated "
              "figures were written in and the shape this pack's padded output prints"),
    "R26-F1 a space before the equals": (
        None, "a space between the key and the `=`"),
    "R26-F1 a tab before the value": (
        None, "a tab between the `=` and the value, category `Cc`"),
    "R26-F1 a no-break space": (
        None, "U+00A0 between the `=` and the value, which NFKC folds to a plain "
              "space -- the composition the round reported"),
    "R26-F1 a narrow no-break space": (
        None, "U+202F between the `=` and the value, folded the same way"),
    "R26-F1 an &nbsp; entity": (
        None, "the `&nbsp;` character reference before the value, resolved by step 0 "
              "and then folded by NFKC into the spelling the matcher could not see"),
    "R26-F1 the padded shape the pack prints": (
        None, "two padded pairs on one line, the shape the `--surface` inventory "
              "printed until this round"),
    "C27-S1 an acute accent before the value": (
        None, "`U+00B4`, which NFKC expands into a space and `U+0301`: the space was "
              "deleted beside the `=` and the mark was not, so the line was never a "
              "candidate at all"),
    "C27-S1 a diaeresis before the value": (
        None, "`U+00A8`, the same fold through a different compatibility character"),
    "C27-S1 a bare combining mark before the value": (
        None, "`U+0301` written on its own, which is the residue the fold leaves and "
              "the thing the widened class actually deletes"),
    "C29-S1 a bidi override before a value a case required": (
        None, "the coordinator's `C29-S1`, in the direction that makes it a flip: a "
              "figure a case of this run required, cited correctly, carrying "
              "`U+202E` -- deleted with the rest of `Cf` since round 14, so without "
              "this guard the line PASSES while a reader is shown the digits in "
              "another order"),
    "C30-S1 a bidi override written as a hex HTML entity": (
        None, "the coordinator's `C30-S1`: an entity is a SPELLING of the character, "
              "and this one question was asked of the raw line while every other "
              "character question in this file is asked after `html.unescape`"),
    "C30-S1 a bidi override written as a decimal HTML entity": (
        None, "the decimal spelling of the same codepoint, so the arm pair is about "
              "the unescaping step and not about one entity's text"),
    "C29-S1 a bidi isolate before a value a case required": (
        None, "the same, with `U+2066`, so the arm pair is not one codepoint's "
              "behaviour: the set is derived by running `unicodedata.bidirectional` "
              "over every `Cf` codepoint and both members come out of that run"),
    "R28-F1 a mark truncating a value a case required": (
        None, "round 28's blocker, in the direction that makes it one: a figure a case "
              "of this run required, cited correctly, with a mark between the value's "
              "first digit and the rest -- so the matcher weighed the required figure "
              "and the reader saw a different one"),
    "R28-F1 a mark inside the value": (
        None, "the same shape with a fabricated figure, which reds either way but "
              "under the old class redded the WRONG figure"),
    "R28-F1 a mark on the key side of the equals": (
        None, "a mark that touches the `=` from the left, where round 27's class did "
              "reach but NFKC had already composed it into the letter"),
    "R28-F1 a mark inside the key": (
        None, "a mark in the middle of the key, which the old class never reached: the "
              "positive scan found a shorter figure there and the reader saw a longer "
              "key"),
    # `R27-F1` and `R27-F2`, round 27's two blockers. Both challengers quote
    # their plants verbatim in their reports; the entries here are DESCRIPTIONS
    # for the reason the `R24-F1` entries give -- an arm body's figures are
    # PLANTED, and a round's probe token quoted into this file would plant a
    # token beside a real key.
    "R27-F1 a RAISE NOTICE in a fixture requires nothing": (
        None, "the fixture's `RAISE NOTICE '<literal>'`, printed by `psql` in the "
              "run's own voice and required by no case, which the second challenger "
              "drove to `EXIT_SCRIPT 0`"),
    "R27-F1 an echo in the driver requires nothing": (
        None, "an `echo` added to `rebuild_and_prove.sh`, the same attack through the "
              "driver's own voice"),
    "R27-F1 a printed plant with no case named requires nothing": (
        None, "the same printed plant quoted with no case reference, so the finding a "
              "reader gets is the one about requirement and not about attribution"),
    "R27-F1 a sink with no rows is refused": (
        None, "a sink carrying this commit's `RUN_HEAD` and not one row, which is an "
              "empty haystack and must not pass as a verdict"),
    "R27-F2 a figure attributed to another case": (
        None, "the first challenger's `axes=3` shape: a figure one case requires, "
              "quoted of another case, which is a false sentence made of a true "
              "figure"),
    "R27-F2 a required figure naming no case at all": (
        None, "a required figure quoted with no case beside it, so nothing says what "
              "the figure is a figure OF"),
    "R27-F2 a figure naming a case the suites could not identify": (
        None, "a case titled in prose, which the suites record as the unidentified "
              "case: a case a document cannot reference pins nothing"),
    "R26-F1 a figure split across two printed lines emits nothing": (
        None, "the hole this round found inside its own fix: the run printed the key "
              "and its `=` at the end of one line and the value at the start of the "
              "next, so deleting whitespace beside the `=` would JOIN two printed "
              "lines into a figure neither of them carries"),
    "R26-F1 a padded figure in the output is the same figure": (
        None, "the pass direction: the run PRINTED the figure padded and the document "
              "writes it bare, which is one figure under `the same spelling on both "
              "sides`"),
    "R14-S1 a zero-width space inside the value": (
        None, "a format character inside the value rather than beside the `=`"),
    "R14-S1 a zero-width space inside the key": (
        None, "a format character inside the key"),
    "R14-S1 a zero-width space after the sign": (
        None, "a format character between the sign and the digits, which is the only "
              "one of the three that leaves no shorter figure for the positive scan "
              "to find"),
    # `R26-S1` / `C26-F1`: the second challenger's three worlds, and the
    # capture's four refusals.
    "R26-S1 a comment in an instrument emits nothing": (
        None, "a `#` comment carrying the figure, committed in an instrument the run "
              "executes -- the first of the three shapes the suffix rule admitted"),
    "R26-S1 a committed .py nothing runs emits nothing": (
        None, "a committed `.py` that nothing imports or runs, carrying the figure"),
    "R26-S1 an unapplied mutation world emits nothing": (
        None, "a `--` comment carrying the figure in a committed `.sql` world"),
    "R26-S1 what the run printed is emitted": (
        None, "the pass direction of the same rule: the figure is in what the run "
              "printed and in none of the world's files"),
    "R26-S1 no capture is a refusal": (
        None, "the gate asked for a verdict with no run to read"),
    "R26-S1 a capture inside the subject is refused": (
        None, "a capture written INSIDE the repository that holds the subject, which "
              "is round 25's committed recording reached by another route"),
    "R26-S1 a capture of another head is refused": (
        None, "a capture whose `RUN_HEAD` is another commit"),
    "R26-S1 an empty capture is refused": (
        None, "a capture with nothing in it, which would otherwise red every figure "
              "for the wrong reason"),
    # `R24-F1`, and the coordinator's `F2` beside it: the round reported a
    # DEFECT over shapes -- "the unit is still derived subtractively, and both
    # lists are whitelists" -- and demonstrated it with five fenced lines, then
    # the coordinator with four more. Each arm below is one of those shapes
    # written with this file's own fabricated keys, because an arm body's
    # figures are PLANTED (the coordinator's `F3`) and the round's own
    # `overlay_routine=4242` would plant a token beside Pack B's real output.
    # So each records a description, and the shape it plants is the one the
    # finding named.
    "R24-F1 a double-quoted figure": (
        None,
        "a figure in straight double quotes, the round's own first shape",
    ),
    "R24-F1 a single-quoted figure": (
        None,
        "a figure in straight single quotes, which is the shape this pack PRINTS",
    ),
    "R24-F1 a semicolon between the pairs, no space": (
        None,
        "two pairs joined by a separator that is not whitespace",
    ),
    "R24-F1 a comma between the pairs, no space": (
        None,
        "the same, with a comma, which the round ran in both orders",
    ),
    "R24-F1 pipes with no padding": (
        None,
        "the same, as an unpadded markdown table row",
    ),
    "R24-F1 an ampersand between the pairs": (
        None,
        "the same, with an ampersand, which the coordinator added",
    ),
    "R24-F1 a slash between the pairs": (
        None,
        "the same, with a slash, which the coordinator added",
    ),
    "R24-F1 a bracketed pair list": (
        None,
        "the same, bracketed, which the coordinator added",
    ),
    "R24-F1 a long option": (
        None,
        "a figure written as a long option, which no round reached and the "
        "inversion closes",
    ),
    "R24-F1 the pack's own quoted control line": (
        None,
        "the generator's own control line, the two committed fenced lines the "
        "round pointed at as figures this instrument prints and cannot see",
    ),
    "R24-F1 a fabricated figure whose hyphenated key ends in an emitted one": (
        None,
        "a fabricated figure whose hyphenated key ends in an emitted one, which "
        "is what `hyphen in the key` decides now that the scan is positive",
    ),
    # `R23-F1`: the round measured the DEFECT -- `_is_figure` partitions on the
    # first `=`, so a line carrying two pairs was never a candidate at all --
    # and reported it as that defect over shapes, not as nine document lines.
    # Each arm below is a shape, so each records a description and not a
    # verbatim plant, and the shape it plants is the one the finding names.
    "R23-F1 a second pair after the figure": (
        None,
        "two `key=value` pairs on one line, the defect the round reported",
    ),
    "R23-F1 a pair before the figure": (
        None,
        "the same two pairs in the other order, which the round's reading covers",
    ),
    "R23-F1 a tab between the pairs": (
        None,
        "the same two pairs separated by a tab rather than a space",
    ),
    "R23-F1 a semicolon between the pairs": (
        None,
        "the same two pairs with punctuation between them",
    ),
    "R23-F1 two table cells": (
        None,
        "the same two pairs in a markdown table row, reported as a shape",
    ),
    "R23-F1 three pairs": (
        None,
        "the same defect with a third pair, which bounds it at more than two",
    ),
    "R23-F1 the instrument's own shape": (
        None,
        "this pack's own probe output, whose two pairs per line are exactly what "
        "the round pasted -- reported as the instrument's shape, not as a line",
    ),
    "R23-F1 prose no longer excuses the figure": (
        None,
        "the bound this phase disclosed in round 13 and carried until now: prose "
        "on the line, reported as a residual rather than as a plant",
    ),
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
    "R25-F1 a committed transcript emits nothing": (
        None,
        "round 25's own finding: the instrument reports a figure as passing on the "
        "authority of committed transcript text, which anyone can type into -- "
        "reported as the haystack's composition and not as a document line, and "
        "realised at `36c9094` by this pack's own probe transcript",
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
    # Described rather than quoted since `R27-F2`: the body carries the case
    # that REQUIRES the figure, in brackets, which the round's own finding did
    # not quote because the convention is this round's.
    "R14-S3 control: the figure itself": (
        None, "`deleted=0`, the figure itself, with the case that requires it named "
              "beside it as every quotation of a figure must be since `R27-F2`"),
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
# variants of what it names: the figures THIS instrument produces -- the guard
# matrix, the arm counts, the false-positive surface, the price of the last
# decoration removal, and since `R26-F2` the pack's own counts (the files the
# commit holds under the harness, how many of them are recordings, the guard
# count and the `skip` keys the committed source reads), which were the two
# figures round 26 measured false in this pack's prose. Figures from
# the other instruments (`121 cases`, `53 cases`, the race counts, the digests)
# are NOT enrolled here; they are pinned by the committed run evidence and by
# the fenced-figure arm itself, and enrolling them means giving each of those
# instruments the same treatment, which is a change to them and not to this
# file.
BEGIN = "<!-- BEGIN GENERATED %s: %s -->"
END = "<!-- END GENERATED %s -->"
# `C26-S1` (the interpreter by absolute path) and `R26-S1` (a generator reads
# the haystack, so it needs the run's capture): the command a reader is given
# is the command that reproduces the block. `$P11_RUN_CAPTURE` is the variable
# `rebuild_and_prove.sh` exports for the run it is in.
CMD = (
    "/usr/bin/python3 -I prep/phase11/harness/check_fenced_figures.py --emit %s "
    "--run-capture $P11_RUN_CAPTURE"
)


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
def _memo_key(name):
    """The cache key for a memo of what a RUN produced.

    `C35-S1`, the coordinator's `P2` on `A-35-F2`, and it closes the CLASS
    rather than the site. `_HAYSTACK` and `_ASSERTED` are keyed on the capture
    by `_haystack_key`, so a haystack read under one run can never be served to
    another. `_BODIES` and `_ROWS` were keyed on the NAME alone -- and a
    generator RUNS the arms, which is exactly how `A-35-F2` happened: a body
    generated under a census's own capture was served to a verdict that had
    none, and that verdict stopped refusing. Keyed this way a body generated
    under one run is never served to another, and no future caller has to
    remember a `finally`.

    The snapshot and restore in `printed_block_sentences` stays as well. Two
    independent mechanisms for one hole is deliberate here: the keying is the
    law, and the restore is what keeps the cache from growing an entry per
    capture in a process that installs several.
    """
    return (name, _RUN_CAPTURE[0] if _RUN_CAPTURE else None)


_ROWS = {}


def _guard_rows():
    """(guard, the arms its deletion reds) for every guard, computed once.

    `R24-F1` removed the third element. It carried the arms a SUBSUMED guard
    reds once the guard that subsumes it is gone, and both entries were about
    decoration rules that no longer exist.
    """
    memo = _memo_key("guard")
    if memo not in _ROWS:
        def reds(skip):
            return [label for label, want, run in _arms_with(skip) if run() != want]

        rows = [(guard, reds((guard,))) for guard in GUARDS]
        _ROWS[memo] = rows
    return _ROWS[memo]


def _surface_rows():
    """(shape, verdict) for every documented shape, computed once."""
    memo = _memo_key("surface")
    if memo not in _ROWS:
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
        _ROWS[memo] = rows
    return _ROWS[memo]


def _backtick_rows():
    """(subject, claim) for what deleting `inline code span` would cost.

    `C25-S7`, the coordinator's P2: the header said deleting this guard "reds
    nine true sentences", and NINE was written by hand, matched no number any
    command printed, and was then repeated in the published record. The figure
    is generated here instead, by RUNNING the gate with the guard deleted over
    this pack's own documents -- which is the pack's own rule, that every
    document figure is re-counted with the command it names.

    It is a COST and not a verdict: the rows say what the gate would say if the
    last decoration removal were taken, so a reader weighing `R25-S1` reads a
    measurement rather than my estimate of one.
    """
    memo = _memo_key("backtick")
    if memo not in _ROWS:
        skip = ("inline code span",)
        emitted = emitted_strings(os.path.join(PHASE_DIR, "harness"), skip)
        planted = planted_tokens()
        docs = documents(PHASE_DIR)
        seen = 0
        hits = []
        for path in docs:
            rel = os.path.relpath(path, PHASE_DIR)
            for n, _raw, tok in tokens_in(path, skip):
                seen += 1
                if tok not in emitted or tok in planted:
                    hits.append((rel, n, tok))
        lines = {(rel, n) for rel, n, _tok in hits}
        toks = {tok for _rel, _n, tok in hits}
        _ROWS[memo] = [
            ("candidates with the guard deleted", str(seen)),
            ("document lines that would red", str(len(lines))),
            ("distinct tokens in them", str(len(toks))),
            (
                "",
                "deleting `inline code span` would red %d document line(s) carrying %d "
                "distinct token(s); it is a disclosed bound and not a hole"
                % (len(lines), len(toks)),
            ),
        ]
    return _ROWS[memo]


def emit_backtick_cost():
    rows = _backtick_rows()
    lines = ["the price of the last decoration removal, measured:", ""]
    for subject, claim in rows[:-1]:
        lines.append("%-38s %s" % (subject, claim))
    lines.append("")
    lines.append(rows[-1][1])
    return lines


def claims_backtick_cost():
    return list(_backtick_rows())


def _pack_count_rows():
    """The counts this pack's own prose keeps getting wrong, computed.

    `R26-F2`: two figures this pack WROTE were false at `bc54e4c`, and both
    were figures about the instrument itself -- the recordings in the old
    haystack given as "twenty-seven" in three documents where `git ls-tree`
    says forty-four, and the guard binding given as "23 and 23" where the
    selftest prints 22 and 22. Neither was catchable by anything here: one was
    spelled in words, the other sat in a table row outside a block, which is
    the disclosed `figure spelled out in words` residual doing what a residual
    does.

    So they are GENERATED, from the same reads the instrument makes, and the
    prose that used to carry them points here instead. Spelled in two columns
    with no `=`, like every block this file writes since `R26-F1`, so the
    block itself asserts no figure.
    """
    memo = _memo_key("counts")
    if memo not in _ROWS:
        harness = os.path.join(PHASE_DIR, "harness")
        top = _subject_top(harness)
        sha = _commit_of(top)
        rel = os.path.relpath(os.path.realpath(harness), top)
        names = [os.path.basename(n) for n in _tracked_paths(top, sha, rel)]
        recordings = [n for n in names if n.startswith("RUN-EVIDENCE")]
        _msgs, text = committed_text(os.path.basename(os.path.realpath(__file__)))
        read = set()
        if text is not None:
            for node in ast.walk(ast.parse(text)):
                key = _guard_test(node) if isinstance(node, ast.Compare) else None
                if key is not None:
                    read.add(key)
        # The guard COUNT is not a row here: `guard-matrix` already prints it
        # as its own summary, and two generated blocks claiming one figure is
        # how `--check-blocks` reports a restatement -- correctly, since a
        # figure with two generators has two places to drift. What this block
        # adds is the `skip` keys the committed source reads, which is the
        # other half of the binding round 26 measured false.
        rows = [
            ("files the commit holds under the harness", len(names)),
            ("of them recordings of past runs", len(recordings)),
            ("skip keys the committed source reads", len(read)),
            ("arms the selftest runs", len(_arms_with())),
        ]
        _ROWS[memo] = [(label, str(n)) for label, n in rows]
    return _ROWS[memo]


def emit_pack_counts():
    lines = ["what this pack counts, read from the commit and from this file:", ""]
    for label, n in _pack_count_rows():
        lines.append("%-44s %s" % (label, n))
    return lines


def claims_pack_counts():
    return list(_pack_count_rows())


def emit_guard_matrix():
    lines = ["each guard deleted on its own, and the arms that stop answering:", ""]
    for guard, flipped in _guard_rows():
        shown = ", ".join(flipped[:3]) + (
            " +%d more" % (len(flipped) - 3) if len(flipped) > 3 else ""
        )
        lines.append("%-26s reds %2d arm(s): %s" % (guard, len(flipped), shown))
    lines.append("")
    lines.append(
        "%d guards, every one of them deleted on its own and measured" % len(GUARDS)
    )
    return lines


def claims_guard_matrix():
    # The row's CLAIM is its FIGURE -- `reds N arm(s)` -- and not the labels
    # behind it. The labels are detail, and putting them in the claim gave the
    # comparison a vocabulary of hundreds of words, which matched the pack's
    # ordinary prose everywhere and measured nothing.
    rows = [(guard, "reds %d arm(s)" % len(flipped)) for guard, flipped in _guard_rows()]
    rows.append(
        (
            "",
            "%d guards, every one of them deleted on its own and measured"
            % len(GUARDS),
        )
    )
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
    # `R23-F1`'s cost, and the one place it had to be paid. A candidate is a
    # TOKEN since round 23, so this INVENTORY of probe shapes -- most of whose
    # rows are figure-shaped by construction, because that is what it measures
    # the price of -- became reports of figures no instrument emits, and the
    # scan red on them. The probes are not reports, and this block must say
    # what shape was measured without asserting it.
    #
    # `R26-F1`. Until this round it did that by writing each shape with SPACES
    # around the `=`, "which the matcher's own key class refuses" -- a
    # generator that depended on the hole round 26 drove three fabricated
    # figures through, and the one spelling a reader of this pack is most
    # habituated to. With the whitespace class closed that device is gone and
    # nothing takes its place: the KEY and the VALUE are printed in two
    # columns and no `=` is written anywhere in the block, so there is no
    # figure here to assert, to exempt or to hide.
    #
    # Not an exemption and not a list: nothing is excused anywhere. A
    # fabricated figure written into this block still reds, because
    # `--check-blocks` compares the block with a fresh run of this generator.
    rows = _surface_rows()
    lines = [
        "%-22s %-10s %s" % ("key", "value", "the gate's answer on `key=value`"),
        "",
    ]
    lines += [
        "%-22s %-10s %s" % (shape.partition("=")[0], shape.partition("=")[2], verdict)
        for shape, verdict in rows
    ]
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
    "backtick-cost": (emit_backtick_cost, claims_backtick_cost),
    "pack-counts": (emit_pack_counts, claims_pack_counts),
}

_BODIES = {}


def _block_body(name):
    """What `--regenerate` would write for one generator. Memoised PER RUN: a
    generator is deterministic within a run and `--check-blocks` asks every
    document, but a body is a body of ONE run -- see `_memo_key` and
    `A-35-F2`."""
    memo = _memo_key(name)
    if memo not in _BODIES:
        _BODIES[memo] = "\n".join(GENERATORS[name][0]())
    return _BODIES[memo]


# A word long enough to carry a subject, and a number STANDING ON ITS OWN: a
# digit run inside `d15315e19cb3` is part of a digest, not a figure, and
# counting it made a digest line a restatement of anything with a `17` in it.
WORD = re.compile(r"[a-z][a-z-]{4,}")
# A digit run is a FIGURE only where it stands on its own. The underscore is
# excluded on both sides because this pack's subject matter is full of names
# that carry a position: `product_variants_30_archive_requires_zero_stock`,
# `._30_`, `products_20_unit_history_lock`. With `_` counted as a boundary the
# `30` inside those names was read as the guard matrix's `30 guards` and redded
# seven sentences in three documents that restate nothing -- and a hardening
# that causes a false red is not hardening, it is a gate people learn to
# ignore. A figure a document really does restate is still bounded by spaces,
# an `=`, a bracket or a comma, none of which this changes.
NUMBER = re.compile(r"(?<![0-9a-z_])[0-9]+(?![0-9a-z_])")


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


def _counted_nouns(claim):
    """The word each of the claim's own numbers COUNTS.

    `R24-F1` moved the guard count from 30 to 21, and 21 is also the number of
    a round, a `C21`, a decision id and a count of cases in this pack. The
    summary rule asked only for A NUMBER AND A LONG WORD in common, and the
    collision redded six true sentences in five documents -- "Round 21 measured
    that whole class", "rounds 16 to 21", "Node 24.21.0", "The 21 cases test
    every clause". A hardening that causes a false red is not hardening, and
    this file has made that correction once already, for the `30` inside a
    trigger's name.

    So a restatement of a COUNTED claim has to name the number AND WHAT IS
    COUNTED. The noun is read from the claim itself -- the first long word
    after each of its numbers -- so it moves when the generator's wording
    moves, and it is not a list anyone maintains. The cost is in the other
    direction and is armed below: a wrong summary figure written with a
    different noun ("21 checks") is not caught, which is a narrowing of the
    same shape as the spelled-out `thirty guards` residual the coordinator
    already ruled a named `P3`.
    """
    toks = _tokens(claim)
    out = set()
    for i, tok in enumerate(toks):
        if not tok.isdigit():
            continue
        for word in toks[i + 1 : i + 4]:
            if not word.isdigit() and len(word) >= 4 and word not in STOPWORDS:
                out.add(word)
                break
    return out


def _summary_restated(clause, claim):
    """Does this clause restate a counted summary: the number AND its noun?

    The noun must stand NEAR the number in the clause as well as in the claim,
    within three tokens on either side, because this pack's table cells put a
    dozen sentences on one physical line and a noun five sentences away is not
    a restatement of anything.
    """
    nouns = _counted_nouns(claim)
    if not nouns:
        return ()
    folded = _fold_digits(clause.lower())
    numbers = {n for n in NUMBER.findall(folded) if len(n) >= 2} & set(
        NUMBER.findall(_fold_digits(claim.lower()))
    )
    toks = _tokens(folded)
    for i, tok in enumerate(toks):
        if tok not in numbers:
            continue
        near = [w for w in toks[max(0, i - 3) : i + 4] if w in nouns]
        if near:
            return tok, sorted(set(near))
    return ()


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
                restated = _summary_restated(clause, claim)
                if restated:
                    found.append(
                        "restates the summary `%s` prints (says %s of the %s it counts)"
                        % (name, restated[0], ", ".join(restated[1]))
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
                # `R24-S2`, as above: the refusal leads under its own name.
                "  REFUSED: %s A generated block is read as evidence only from a run of "
                "the committed tree whose decision frame the closed sub-language admits, "
                "and %d refusal(s) stand in the way of that here."
                % (refusals[0], len(refusals))
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
        # `@@AN@@`, not a literal: the arm carried `\u0664\u0660` -- forty --
        # and stopped measuring the day an arm was added, because a number
        # typed into an arm is the same hand-written figure this whole block
        # rule exists to refuse.
        "@@AN@@ catch arms, and the skip arms beside them",
    ),
    ("R16-S2 a block whose body was edited", 1, None),
    # The narrowed summary rule, measured from both sides. `R24-F1` moved the
    # guard count onto a number this pack already uses for a round, a decision
    # id and a count of cases, and the rule as it stood redded six true
    # sentences. What it must still catch is the count restated ABOUT THE THING
    # COUNTED; what it must not raise is the same number about something else.
    (
        "C-R24 the guard-matrix summary restated in prose",
        1,
        "the matcher applies @@G@@ guards and each one is deleted on its own",
    ),
    (
        "C-R24 control: the same number, about a round rather than the guards",
        0,
        "round @@G@@ measured that whole class again one level up",
    ),
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
    # The boundary `NUMBER` draws, measured from both sides. The restatement
    # it must still catch is the figure standing on its own; the false red it
    # must not raise is the same digits INSIDE a name, which is what seven
    # sentences in this pack carry because its triggers are numbered.
    (
        "the summary's figure restated in prose is still caught",
        1,
        "the selftest runs @@N@@ catch arms today",
    ),
    (
        "control: the same digits inside a trigger name are not a figure",
        0,
        "`product_variants_@@N@@_archive_requires_zero_stock` names a position, "
        "and the catch arms are counted in the block below",
    ),
)


def _blocks_arm(extra, edit=False, quiet=True):
    """One synthetic document: a correct `arm-counts` block plus one line.

    `C32-S3` and `C33-F1`: the third hardcoded `quiet=True` in this file, and
    the census cannot see a paragraph an arm cannot be asked to print.
    """
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
        return check_blocks(docs, quiet=quiet)


def blocks_test():
    ok = True
    for label, want, extra in BLOCK_ARMS:
        if extra is None:
            rc = _blocks_arm("", edit=True)
        else:
            filled = (
                extra.replace("@@CLAIM@@", _claims_of("arm-counts")[0][1])
                .replace("@@N@@", str(len(CATCH)))
                .replace("@@G@@", str(len(GUARDS)))
                .replace(
                    "@@AN@@",
                    "".join(chr(0x0660 + int(d)) for d in str(len(CATCH))),
                )
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

    # 3. `R21-F1`: the deciding code read from the COMMIT, which replaces the
    # in-file constants pin entirely.
    #
    # WHAT WAS WRONG WITH WHAT STOOD HERE, kept because it is the lesson, twice
    # over. The fix was a digest of the matcher's constants compared with a
    # LITERAL IN THIS FILE, and its refusal text told the maintainer to re-run
    # `--decision-constants` and commit the printed digest. Round 21 took
    # exactly that step: two edits, one of them prescribed by the error
    # message, and every gate returned 0 with the fabricated figure through.
    # **A pin inside the thing it pins is not a pin.** And the arm beside it
    # digested two strings, saw them differ, and printed `as required`; with the
    # comparison forced to pass it went on printing `as required`, because it
    # had measured arithmetic and not the instrument.
    #
    # So there is no literal and no re-pin step. The deciding files must BE the
    # files the commit holds, and this arm measures that law on a COPY: a
    # scratch repository with a copy of the harness committed into it, one
    # deciding file edited on disk afterwards, the refusal read BY NAME, and the
    # comparison deleted by value beside it.
    world = tempfile.mkdtemp(prefix="p11-selfbytes-")
    atexit.register(shutil.rmtree, world, True)
    here = os.path.dirname(os.path.realpath(__file__))
    rel = os.path.join("prep", "phase11", "harness")
    copy = os.path.join(world, rel)
    os.makedirs(os.path.dirname(copy))
    shutil.copytree(here, copy)
    _git(world, ["init", "-q"])
    _git(world, ["add", "-A", "--", "."])
    _git(
        world,
        ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
         "commit", "-q", "--no-gpg-sign", "-m", "a copy of the harness, committed"],
    )
    clean_msgs, _b = committed_harness(copy)
    subject = os.path.join(copy, os.path.basename(os.path.realpath(__file__)))
    with open(subject, "r", encoding="utf-8") as fh:
        was = fh.read()
    # The review's own line, in the copy and NOT in the commit: a default
    # argument that switches a named guard off for every real run.
    tail = '\n    """0 = every quoted figure is emitted.'
    planted = was.replace(
        "def scan(docs_dir, harness_dir, quiet=False, skip=()):" + tail,
        'def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):' + tail,
        1,
    )
    with open(subject, "w", encoding="utf-8") as fh:
        fh.write(planted)
    moved_msgs, _b2 = committed_harness(copy)
    deleted_msgs, _b3 = committed_harness(copy, compare=False)
    # The NAME SET and not the first name: since round 22 the same world also
    # carries the clean-tree law, which refuses `SELF-TREE-DIRTY` for the very
    # edit this arm plants. Two laws naming the same world is the intent; what
    # the arm reads is whether ITS name is there, and whether deleting ITS
    # comparison takes ITS name away and leaves the other one standing.
    moved = sorted({m.split(":")[0] for m in moved_msgs})
    left = sorted({m.split(":")[0] for m in deleted_msgs})
    good = (
        planted != was
        and not clean_msgs
        and "SELF-BYTES-UNCOMMITTED" in moved
        and "SELF-BYTES-UNCOMMITTED" not in left
    )
    ok = ok and good
    print(
        "  identity R21-F1 a deciding file edited on disk and NOT in the commit (the "
        "review's own `skip=` default, in a copy): the committed copy named %s, the "
        "edited one %s, and with the comparison DELETED %s -> %s"
        % (
            "nothing" if not clean_msgs else "%d refusal(s)" % len(clean_msgs),
            ", ".join(moved) or "NO REFUSAL",
            "that name is gone and %s remains" % (", ".join(left) or "nothing")
            if "SELF-BYTES-UNCOMMITTED" not in left
            else "it still reds, so the arm measures nothing",
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

    # 8. `C25-F1`: the module call the TRANSFORMER makes. `html.unescape`
    # resolves the spelling `&#61;` into the `=` a reader sees, so a planter who
    # rebinds it to the identity puts the whole round-25 blocker back while
    # every AST rule still passes -- `_strip` is parsed for WHERE a rebinding
    # sits, never for what it calls. The arm performs that rebinding, reads the
    # refusal by name, and measures the direction that used to pass: with
    # `TRANSFORMER_MODULE_CALLS` emptied the refusal is gone and the entity
    # figure walks through the scan.
    real_unescape = html.unescape

    def _planted_unescape(text):
        return text

    # The body carries an EMITTED figure beside the entity one, so the second
    # direction is a PASS and not an inert world: with the pin deleted the scan
    # must weigh something, find it legitimate and return 0, which is the hole
    # as a planter would experience it. One line with nothing but the entity on
    # it returns 2 (`INERT`), which is the gate refusing to call an unweighed
    # world a pass -- correct behaviour, and not the measurement this arm wants.
    entity = "present=true [FA-01] fabricated_count&#61;999"
    cache = list(_FRAME_PARSED)
    entries = TRANSFORMER_MODULE_CALLS
    try:
        html.unescape = _planted_unescape
        _with, msgs = module_call_identity()
        _FRAME_PARSED[:] = []
        scanned = _arm(entity, ())
        globals()["TRANSFORMER_MODULE_CALLS"] = ()
        _unpinned, unpinned_msgs = module_call_identity()
        _FRAME_PARSED[:] = []
        unpinned_scan = _arm(entity, ())
    finally:
        html.unescape = real_unescape
        globals()["TRANSFORMER_MODULE_CALLS"] = entries
        _FRAME_PARSED[:] = cache
    name = msgs[0].split(":")[0] if msgs else "NO REFUSAL"
    good = (
        (not _with)
        and name == "MODULE-ATTR-REBOUND"
        and scanned == 5
        and _unpinned
        and not unpinned_msgs
        and unpinned_scan == 0
    )
    ok = ok and good
    print(
        "  identity C25-F1 `html.unescape` rebound to the identity: refused as %s, the "
        "scan rc=%d, and with the transformer's entry DELETED the frame named %s and the "
        "entity figure rc=%d (want 0, the hole reopened) -> %s"
        % (
            name,
            scanned,
            "nothing at all" if not unpinned_msgs else "%d refusal(s)" % len(unpinned_msgs),
            unpinned_scan,
            "as required" if good else "**SELFTEST FAILED**",
        )
    )

    # 9. The generator's own frame gate, which did not exist until this round
    # and was found by using the file: a `--regenerate` from a tree whose
    # deciding bytes were not in the commit wrote a guard matrix of refusals
    # and called them measurements. The arm seeds one refusal into the parse
    # cache for its own length, as arm 4 does for `--check-blocks`, and
    # requires BOTH generation entry points to refuse; the same call with no
    # refusal to report must still generate, or the gate would be refusing for
    # some other reason.
    class _Sink:
        def write(self, _text):
            return None

        def flush(self):
            return None

    cache = list(_FRAME_PARSED)
    # `_suspend_tree_law_for_generation` sets a PROCESS flag and nothing pops
    # it, so a generation entry point called from inside the selftest would
    # leave the two tree laws suspended for every arm after it -- which is
    # exactly what it did on the first run of this arm: six tree arms then
    # reported that the real run does not name its own refusals. Saved and
    # restored here, and the generator's own output is swallowed so an arm
    # cannot put a figure into a transcript.
    generating = list(_GENERATING)
    out = sys.stdout
    try:
        sys.stdout = _Sink()
        _FRAME_PARSED[:] = [("a refusal planted for this arm only",)]
        refused_emit = _main(["--emit", "arm-counts"])
        refused_regen = _main(["--regenerate"])
        _FRAME_PARSED[:] = cache
        plain_emit = _main(["--emit", "arm-counts"])
    finally:
        sys.stdout = out
        _FRAME_PARSED[:] = cache
        _GENERATING[:] = generating
    good = refused_emit == 5 and refused_regen == 5 and plain_emit == 0
    ok = ok and good
    print(
        "  identity C25 the generator's frame gate: --emit rc=%d and --regenerate rc=%d "
        "with a refusal to report (want 5 and 5), rc=%d without one (want 0) -> %s"
        % (
            refused_emit,
            refused_regen,
            plain_emit,
            "as required" if good else "**SELFTEST FAILED**",
        )
    )
    return ok


def guard_set_test():
    """`R25-S4`: the guard LIST and the guard keys the code READS are one set.

    Round 25 derived this correspondence with an `ast` walk of its own and
    found it exact -- 21 and 21 -- and then named the gap: nothing in the
    instrument binds it. Dropping an ENTRY from `MATCHER_GUARDS` is refused for
    a guard that TRANSFORMS the line, because the identity probe notices a
    transformation the skip set no longer suspends; it is ACCEPTED for a guard
    that NARROWS the pattern (`key boundary`, `value boundary`), because a
    narrowing leaves the identity probe's output unchanged. An entry nobody
    lists is a guard `--selftest` never deletes and the matrix never measures,
    which is the same hole `SUBSUMED` used to be.

    Read from the COMMITTED bytes, like every other rule, so a key added to the
    working tree cannot bind itself.
    """
    _msgs, text = committed_text(os.path.basename(os.path.realpath(__file__)))
    if text is None:
        raise Refusal(
            "FRAME-SOURCE-NOT-IN-COMMIT: this file's committed bytes could not be read, "
            "so the guard set this run would bind is not the set the commit carries."
        )
    read = set()
    for node in ast.walk(ast.parse(text)):
        key = _guard_test(node) if isinstance(node, ast.Compare) else None
        if key is not None:
            read.add(key)
    listed = set(GUARDS)
    unlisted = sorted(read - listed)
    unread = sorted(listed - read)
    ok = not unlisted and not unread
    print(
        "  guards R25-S4 the committed source reads %d `skip` keys and `GUARDS` lists "
        "%d; %s -> %s"
        % (
            len(read),
            len(listed),
            "they are the same set"
            if ok
            else "read and unlisted: %s; listed and never read: %s"
            % (", ".join(unlisted) or "none", ", ".join(unread) or "none"),
            "as required" if ok else "**SELFTEST FAILED**",
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


def _clean_line(line):
    """One line as a reader reads it: no comment marker, no `echo` prefix, no
    trailing quote or continuation. `R30-S1` moved this out of `_prose` so the
    whole-file reading cleans its lines the same way, which is what lets a
    sentence split across a BLANK LINE be read as the sentence it is."""
    body = line.strip()
    body = re.sub(r"^#+\s*", "", body)
    hit = re.match(r'^echo\s+"(.*)$', body)
    if hit:
        body = hit.group(1)
    body = body.rstrip("\\").rstrip()
    if body.endswith('"'):
        body = body[:-1]
    return body.rstrip()


def _prose(text):
    """The file's SENTENCES, not its lines: `(first line number, paragraph)`.

    `C29-F1`, the coordinator's blocker, and the whole of it. Round 28 wrote
    this law as a line scan, and both these files wrap their prose at column
    80, so the author's own arm -- a one-line `echo` -- redded while the same
    sentence written the way the file actually writes sentences did not:

        one line                        -> 1 finding
        wrapped over two comment lines  -> 0 findings   ESCAPED
        split across two echoes         -> 0 findings   ESCAPED

    A run of consecutive non-blank lines is therefore ONE string here. Comment
    markers, the `echo "` prefix, a trailing quote and a trailing backslash are
    removed first, so a sentence reads the way a reader reads it, whether it
    was written as a comment, as one `echo`, or as six.

    It over-joins: two adjacent lines that are not one sentence become one
    paragraph. That direction is the safe one -- it can only ADD a candidate
    sentence, never hide one -- and the live text of both files is measured
    against it with the result required to be zero findings.
    """
    paras, cur, start, last = [], [], None, None
    for n, line in enumerate(text.split("\n"), 1):
        body = _clean_line(line)
        if not body:
            if cur:
                paras.append((start, last, " ".join(cur)))
            cur, start, last = [], None, None
            continue
        if start is None:
            start = n
        last = n
        cur.append(body)
    if cur:
        paras.append((start, last, " ".join(cur)))
    # `C29-F1`: one space between words, whatever the wrapping did. A sentence
    # split across two `echo`s rejoins with the trailing space of the first,
    # and a double space is not a different sentence to a reader.
    return [(a, b, re.sub(r"\s+", " ", t)) for a, b, t in paras]


def _without_the_declaration(text):
    """`text` with the lines this file GENERATES from `RETIRED_SENTENCES` gone.

    The declaration must be excluded or the law reports its own enumeration;
    the coordinator asked for that exclusion BY CONSTRUCTION rather than by a
    list, so the excluded lines are built here FROM the tuple's own values and
    nothing is named a second time. Add an entry to the tuple and its line is
    excluded; write that same sentence anywhere else in the file and it is not.
    """
    gone = set('    "%s",' % r for r in RETIRED_SENTENCES)
    return "\n".join("" if l in gone else l for l in text.split("\n"))


SENTENCE_WHOLE_FILE = "the whole file"
"""The fourth reading's name. A constant, and the parameter that drops a
reading is called `without` and not `skip`, because `skip` in this file is the
MATCHER's guard set, which has a census of its own (`R25-S4`) -- and one name
holding two sets is the defect this pack has a lesson about."""

SENTENCE_SPELLINGS = (
    ("as written", lambda t: t),
    ("the double quotes", lambda t: t.replace('"', "")),
    ("every quote", lambda t: t.replace('"', "").replace("'", "")),
)
"""The three SPELLINGS of one paragraph this law reads, declared rather than
written into the reading loop so that `--selftest` can delete one at a time and
require an arm to stop redding. With `the whole file` they are the four
readings of `C31-S2`; each one is the only reading that catches one shape, and
the selftest proves exactly that, one deletion at a time."""


def sentences(text, prefix, name, pins=(), without=()):
    """Every stale or missing sentence about the haystack in `text`, as PROSE.

    `C28-F2` and the coordinator's `C29-F1`. What makes a figure legitimate
    here has moved four times, and each time a sentence SAYING the old rule
    stayed behind in live code -- once in the line the driver PRINTS to the one
    reader who is looking, prescribing the remedy the move abolished. So:

      * `HAYSTACK_SENTENCE` is the one place the rule is stated, and every
        site in `pins` must quote it BY BYTES;
      * no sentence a rule of this file retired may stand anywhere in `text`,
        read as paragraphs;
      * a retired rule is named by its ROUND in this file from `C29-F1` on,
        never spelled, so this law's reach over its own file needs no
        exemption beyond the declaration it is built from.

    The limit, declared, and narrower than round 28 declared it: the tuple is
    an enumeration, and it cannot name a wording nobody has written. Round 28
    declared that for the NEXT wording and was wrong about the wordings
    ALREADY IN THE FILE -- four of them, each one word from an entry. They are
    in the tuple now because the files no longer spell them. What binds is the
    positive pin; the tuple is the net under it.
    """
    out = []
    # `R30-S1`, the round-30 challenger's residual, and the coordinator's
    # `C31-S2` after it. Reading the file as paragraphs left out shapes these
    # files could really be written in: a sentence split ACROSS A BLANK LINE,
    # which ends a paragraph, and a sentence split across the ARGUMENTS of one
    # command, where the quotes are what hide it. The examples are written with
    # placeholders because this file names a retired rule by its ROUND and does
    # not spell one -- including inside an example, which is a rule this very
    # reading caught me breaking.
    #
    # So the text is read under FOUR readings: the three SPELLINGS declared in
    # `SENTENCE_SPELLINGS` and the whole-file scope named by
    # `SENTENCE_WHOLE_FILE`. The parameter that drops one is `without`, and
    # `skip` -- which this comment said for one round, and the manifest with it
    # (`C32-S4`) -- is the MATCHER's guard set, a different set with a census of
    # its own; passing `skip=` here raises a TypeError, which is the one honest
    # thing about the old wording. The names are:
    #
    #   as written            the paragraph as a reader reads it
    #   the double quotes     `"` removed and nothing else -- `C31-S2`: a
    #                         retired wording that CONTAINS an apostrophe is
    #                         destroyed by removing `'` from the text, so the
    #                         reading that removes both cannot catch it split
    #                         across arguments, and this one can
    #   every quote           `"` and `'` both removed -- the only reading that
    #                         catches a split made with SINGLE quotes
    #   the whole file        every non-blank line joined into ONE paragraph,
    #                         under each of the three spellings above, which no
    #                         blank line can break
    #
    # The whole-file reading is the strongest over-join in this law: it can
    # only ADD a candidate sentence, and the two live files are required to
    # report nothing under all four.
    spellings = [
        (nm, fn) for nm, fn in SENTENCE_SPELLINGS if nm not in without
    ]
    readings = []
    for nm, fn in spellings:
        readings += [
            (a, b, re.sub(r"\s+", " ", fn(para))) for a, b, para in _prose(text)
        ]
    if SENTENCE_WHOLE_FILE not in without:
        whole = re.sub(r"\s+", " ", " ".join(
            c for c in (_clean_line(l) for l in text.split("\n")) if c
        ))
        last = text.count("\n") + 1
        for nm, fn in spellings:
            readings.append((1, last, re.sub(r"\s+", " ", fn(whole))))
    seen_already = set()
    for start, end, para in readings:
        low = para.lower()
        for retired in RETIRED_SENTENCES:
            if retired.lower() in low and (retired, start) not in seen_already:
                seen_already.add((retired, start))
                out.append(
                    "%s-SENTENCE-RETIRED: %s, in the paragraph at lines %d-%d, says "
                    "%r, which describes a rule this gate no longer holds. The "
                    "sentence that says what the haystack is lives in "
                    "check_fenced_figures.py as HAYSTACK_SENTENCE; quote it, or name "
                    "the retired rule by its round instead of spelling it."
                    % (prefix, name, start, end, retired)
                )
    for what, need in pins:
        lines = [l for l in text.split("\n") if need in l and "echo" in l]
        if not lines:
            out.append(
                "%s-SENTENCE-ABSENT: no line of %s echoes %s (looked for %r), so "
                "there is nothing to hold to the rule." % (prefix, name, what, need)
            )
            continue
        if not any(HAYSTACK_SENTENCE in l for l in lines):
            out.append(
                "%s-SENTENCE-UNQUOTED: %s does not quote HAYSTACK_SENTENCE (%r). A "
                "sentence about the rule that is not the rule's own words is the "
                "defect C28-F2 named and C29-F1 measured again."
                % (prefix, what, HAYSTACK_SENTENCE)
            )
    return out


DRIVER_PINS = (
    ("the step header of the figure gate", "=== 7b."),
    ("the EXIT_FENCED_FIGURES description", "EXIT_FENCED_FIGURES:"),
)


def driver_sentences(text):
    """The driver's sentences: the two pinned sites, and no retired wording."""
    return sentences(text, "DRIVER", "rebuild_and_prove.sh", DRIVER_PINS)


def gate_text_sentences(text):
    """This gate's OWN sentences, the declaration excluded by construction."""
    return sentences(
        _without_the_declaration(text), "GATE", "check_fenced_figures.py"
    )


def _sentence_subject(name):
    """One of the two files this law reads, by bytes, or a named refusal."""
    path = os.path.join(_harness_dir(), name)
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def driver_sentence_arms():
    """Both files' sentences, and the worlds where a retired one comes back.

    The three wrap worlds are the coordinator's own measurement of round 28's
    law: the same sentence as one line, wrapped over two comment lines, and
    split across two `echo`s. Round 28 redded on the first and passed the two
    that this file is actually written in.
    """
    ok = True
    try:
        real = _sentence_subject("rebuild_and_prove.sh")
        mine = _sentence_subject("check_fenced_figures.py")
    except OSError as why:
        print("  sentences SENTENCE-SUBJECT-UNREADABLE: %s -> **SELFTEST FAILED**" % why)
        return False
    for label, found in (
        ("the driver quotes the gate's own sentence in both places and carries no "
         "retired one", driver_sentences(real)),
        ("C29-F1 the gate's own text carries no retired sentence either",
         gate_text_sentences(mine)),
    ):
        good = not found
        ok = ok and good
        print(
            "  sentences C28-F2 %s: %d finding(s) -> %s"
            % (label, len(found), "as required" if good else "**SELFTEST FAILED**")
        )
        for why in found:
            print("    " + why)
    retired = RETIRED_SENTENCES[0]
    worlds = (
        (
            "C29-F1 one line, which round 28 caught",
            real + '\necho "the haystack is %s"\n' % retired,
            "DRIVER-SENTENCE-RETIRED",
        ),
        (
            "C29-F1 wrapped over two comment lines",
            real + "\n# the haystack is %s\n# %s\n" % (
                retired.split()[0], " ".join(retired.split()[1:])),
            "DRIVER-SENTENCE-RETIRED",
        ),
        (
            "C29-F1 split across two echoes",
            real + '\necho "the haystack is %s "\necho "%s"\n' % (
                retired.split()[0], " ".join(retired.split()[1:])),
            "DRIVER-SENTENCE-RETIRED",
        ),
        (
            "R30-S1 split across a BLANK LINE",
            real + "\n# the haystack is %s\n\n# %s\n" % (
                retired.split()[0], " ".join(retired.split()[1:])),
            "DRIVER-SENTENCE-RETIRED",
        ),
        (
            "C30 the coordinator's P4 note: split across a BARE `#` LINE",
            real + "\n# the haystack is %s\n#\n# %s\n" % (
                retired.split()[0], " ".join(retired.split()[1:])),
            "DRIVER-SENTENCE-RETIRED",
        ),
        (
            "R30-S1 split across one command's ARGUMENTS",
            real + "\nprintf '%%s %%s\\n' \"%s\" \"%s\"\n" % (
                retired.split()[0], " ".join(retired.split()[1:])),
            "DRIVER-SENTENCE-RETIRED",
        ),
        (
            "the exit description stops quoting it",
            real.replace(HAYSTACK_SENTENCE, "something else entirely", 1),
            "DRIVER-SENTENCE-UNQUOTED",
        ),
    )
    for label, planted, want in worlds:
        names = [f.split(":")[0] for f in driver_sentences(planted)]
        good = want in names
        ok = ok and good
        print(
            "  sentences %-44s refused as %-26s (want %s) -> %s"
            % (label, names[0] if names else "NO REFUSAL", want,
               "as required" if good else "**SELFTEST FAILED**")
        )
    planted = mine + "\n# the haystack is %s\n" % retired
    names = [f.split(":")[0] for f in gate_text_sentences(planted)]
    good = "GATE-SENTENCE-RETIRED" in names
    ok = ok and good
    print(
        "  sentences %-44s refused as %-26s (want %s) -> %s"
        % ("C29-F1 a retired sentence in the gate itself",
           names[0] if names else "NO REFUSAL", "GATE-SENTENCE-RETIRED",
           "as required" if good else "**SELFTEST FAILED**")
    )
    # The declaration is excluded BY CONSTRUCTION and not by a list: the whole
    # tuple, spelled as this file spells it, must still report nothing.
    declared = "\n".join('    "%s",' % r for r in RETIRED_SENTENCES)
    good = not gate_text_sentences(declared)
    ok = ok and good
    print(
        "  sentences %-44s %-26s -> %s"
        % ("C29-F1 the declaration itself, excluded by construction",
           "%d finding(s)" % len(gate_text_sentences(declared)),
           "as required" if good else "**SELFTEST FAILED**")
    )
    return ok


def sentence_reading_arms():
    """`C31-S2`: each of the four readings deleted on its own, one red each.

    The coordinator asked for a reading that removes ONLY `"`, and for every
    reading to be armed rather than argued. Both are here, and the second is
    the harder half: these readings form a ladder of over-joins, so a stronger
    reading subsumes a weaker one for most shapes. A world that reds under all
    four and stops redding when ONE is deleted therefore has to be chosen for
    that reading, and each of the four below is the ONLY reading that catches
    its shape -- measured, by deleting each of the other three in turn too.

      as written         a retired wording that CONTAINS a double quote. No
                         entry of the live tuple does, so this arm plants one:
                         removing `"` from the text destroys the needle as well
                         as the haystack
      the double quotes  a retired wording that contains an APOSTROPHE, split
                         across the arguments of one command. Removing `'` as
                         well destroys the needle, so the strongest spelling
                         CANNOT catch this one
      every quote        the same split made with SINGLE quotes
      the whole file     a sentence split across a BLANK LINE
    """
    global RETIRED_SENTENCES
    ok = True
    names = tuple(n for n, _ in SENTENCE_SPELLINGS) + (SENTENCE_WHOLE_FILE,)
    quoted = 'the "run printed" rule'
    apostrophe = next((r for r in RETIRED_SENTENCES if "'" in r), None)
    plain = next((r for r in RETIRED_SENTENCES if "'" not in r), None)
    if apostrophe is None or plain is None:            # pragma: no cover
        print("  readings SENTENCE-READING-NO-SUBJECT: the tuple has no wording of "
              "one of the two shapes -> **SELFTEST FAILED**")
        return False
    first, rest = apostrophe.split(" ", 2)[:2], apostrophe.split(" ", 2)[2]
    worlds = (
        ("as written", "# %s\n" % quoted, True,
         "a retired wording containing a double quote"),
        ("the double quotes",
         'printf \'%%s %%s\\n\' "%s" "%s"\n' % (" ".join(first), rest), False,
         "an apostrophe wording split across one command's arguments"),
        ("every quote",
         "printf \'%%s %%s\\n\' \'%s \' \'%s\'\n"
         % (plain.split()[0], " ".join(plain.split()[1:])), False,
         "the same split made with single quotes"),
        (SENTENCE_WHOLE_FILE,
         "# the haystack is %s\n\n# %s\n"
         % (plain.split()[0], " ".join(plain.split()[1:])), False,
         "a sentence split across a blank line"),
    )
    for name, text, plant, what in worlds:
        was = RETIRED_SENTENCES
        if plant:
            RETIRED_SENTENCES = was + (quoted,)
        try:
            whole = len(sentences(text, "X", "x"))
            mine = len(sentences(text, "X", "x", without=(name,)))
            others = max(len(sentences(text, "X", "x", without=(o,)))
                         for o in names if o != name)
        finally:
            RETIRED_SENTENCES = was
        good = whole >= 1 and mine == 0 and others >= 1
        ok = ok and good
        print(
            "  readings %-18s %-52s all=%d without-it=%d without-any-other=%d -> %s"
            % (name, what, whole, mine, others,
               "as required" if good else "**SELFTEST FAILED**")
        )
    return ok


SENTENCE_STEM_THRESHOLD = 2
"""How many of the pin's own content words mark a paragraph as talking about
the criterion. Two, and the number is MEASURED rather than chosen: at three the
four attacks of `C32-S1` escape, and at one the stem `thi` alone selects every
paragraph that contains the word `this`, which reds thirteen live shapes. Both
sides are armed in `criterion_selector_arms`, so this line cannot be moved in
either direction without a selftest failing."""


def _criterion_stems():
    """The pin's own content words, derived from the pin and nothing else.

    `C32-S1`. Round 31 derived these but then gated on the literal phrase
    `this run` written BESIDE the pin, so the selector's coupling to the pin
    was held by accident: a paragraph keeping all four of these words escaped
    by writing `the run`, and a pin that stopped containing the phrase would
    have left the gate alive on a string of its own. There is no phrase any
    more. Everything this selector reads comes out of `HAYSTACK_SENTENCE`.
    """
    return sorted({
        re.sub(r"[^a-z]", "", w.lower()).rstrip("s")
        for w in HAYSTACK_SENTENCE.split()
        if len(re.sub(r"[^a-z]", "", w)) > 3
    })


def _states_the_criterion(text):
    """Does this printed paragraph SAY what makes a figure legitimate here?

    The coordinator's `C31-S3`, with its `C32-S1` after it. The
    printed-sentence law requires the pin, and requiring it of EVERY line a run
    prints would red on a table row; so the set it is required of has to be
    decided, and deciding it by a list of sentences is the defect this whole
    chain has been closing. It is decided from the PIN'S OWN VOCABULARY
    instead: a paragraph carrying `SENTENCE_STEM_THRESHOLD` or more of the
    pin's content words is talking about the criterion, and a paragraph that
    QUOTES the pin has nothing left to judge.

    Whitespace is normalised before matching, because a sentence rewrapped
    across two lines or printed with a double space is the same sentence to a
    reader and was not the same string to round 31's selector.

    The limit, declared, and this time measured rather than asserted: a
    paragraph that states the criterion while carrying at most ONE of the four
    words `case`, `expectation`, `this`, `value` is not selected -- every word
    of it replaced by a synonym. `C32-S1` built four paragraphs that kept two
    of them and escaped round 31's line of three; they are arms now, and they
    red if the line moves back. What remains open is one level further out
    than round 29's net: an enumeration of WORDS, derived, not of sentences.
    The outer declaration in `gate_sentences` is what bounds it -- prose is
    written by a person, and nothing here derives the set of sentences a person
    may add.
    """
    low = re.sub(r"\s+", " ", text.lower())
    if HAYSTACK_SENTENCE.lower() in low:
        return False
    hits = sum(1 for st in _criterion_stems()
               if re.search(r"\b%ss?\b" % re.escape(st), low))
    return hits >= SENTENCE_STEM_THRESHOLD


# `C34-S1`, the coordinator's round-34 residual. The labelled test used to
# require SEVEN characters before the colon (`^[A-Z][A-Z -]{6,}:`), which is a
# LENGTH and not a law. `INERT:` is six, so the sentence the `seen == 0` branch
# prints was labelled by nothing, and a reviewer's plant spelling a short name
# -- `UNHELD:` -- walked past the labelled arm untouched. The floor is TWO
# characters now, and it is ONE pattern, used by every site that asks the
# question: two spellings of one test is how two sites come to disagree about
# what a label is.
LABELLED = r"^(?P<name>[A-Z][A-Z -]+):"


def _sentence_shape(text):
    """One SHAPE of a printed paragraph: its words, with what MOVES masked.

    `C32-S3`. A census counts shapes, so anything that differs between two runs
    of the same sentence has to be masked or the census is a census of one run:
    quoted tokens, absolute paths (the seat worlds live in temporary
    directories) and digits. The masking is shared by the finding census and
    the seat census, because two shape functions for one census is the kind of
    split doctrine this pack has a lesson about.
    """
    out = re.sub(r"`[^`]*`", "`X`", text)
    out = re.sub(r"/[A-Za-z0-9_.+-]+(?:/[A-Za-z0-9_.+-]+)*", "<PATH>", out)
    return re.sub(r"[0-9]+", "N", out)


def printed_finding_sentences():
    """Every distinct paragraph a FINDING of this gate PRINTS, by running it.

    The coordinator's `C31-S3`. `gate_sentences` read the two refusals the arms
    provoke, and the arms ran `scan` with `quiet=True`, so the sentences a
    reader actually meets when a figure reds -- the findings themselves -- were
    read by nothing. The set is derived here from EXECUTION: every catch arm is
    run loud and every paragraph it prints is collected, with figures, digests
    and quoted tokens normalised away so that one shape counts once.
    """
    out, seen = [], set()
    for label, body in CATCH:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                _arm(body, quiet=False)
            except Refusal:                                    # pragma: no cover
                continue
        for line in buf.getvalue().split("\n"):
            text = line.strip()
            if not text:
                continue
            key = _sentence_shape(text)
            if key in seen:
                continue
            seen.add(key)
            out.append(("the finding printed by the arm %r" % label, text))
    return out


def _printed_by(arms):
    """Every distinct paragraph a family of arms SAYS, by running them loud.

    `C33-F1`. One runner for every family, because the hole the coordinator
    walked through was a family nobody could run loud: a paragraph a law never
    reads is bounded by nothing, whichever branch prints it. A refusal message
    counts as a paragraph -- in several of these worlds the refusal IS the
    output a reader meets.
    """
    out, seen = [], set()
    for label, runner in arms:
        buf = io.StringIO()
        said = []
        try:
            with contextlib.redirect_stdout(buf):
                runner()
        except Refusal as why:
            said.append("REFUSED: " + str(why).split("\n")[0])
        except Exception as why:                               # pragma: no cover
            said.append("RAISED: %r" % (why,))
        for line in buf.getvalue().split("\n"):
            if line.strip():
                said.append(line.strip())
        for text in said:
            key = _sentence_shape(text)
            if key in seen:
                continue
            seen.add(key)
            out.append((label, text))
    return out


def _printed_to_stdout(paragraphs):
    """The paragraphs a run PRINTED, as opposed to the refusals it RAISED.

    `C33-F1`. A finding is printed; a refusal is raised and carries its own
    law (`gate_sentences` over the provoked refusals). The two are judged
    apart, because requiring the figure-legitimacy sentence of a `GIT-*`
    refusal about which repository holds the haystack would be a false red --
    which is the measurement that forced this split rather than a preference.
    """
    return [(w, t) for w, t in paragraphs if not t.startswith("REFUSED: ")]


def printed_world_sentences():
    """Every distinct paragraph the gate says in each DECLARED WORLD.

    The coordinator's `C33-F1`, and it is the arrival half of that closure. The
    census of round 31 read the paragraphs the `CATCH` arms provoke, and the
    `extra` branch -- `NOT IN THE HAYSTACK`, the one that names a file the
    commit does not carry -- is provoked by no `CATCH` arm. So a finding
    printed there, by a helper rather than by `_finding`, was read by nothing:
    it passed the selftest and reached a reader. The set of worlds is `WORLDS`
    itself, derived and not listed here, so a world added later is censused
    without anyone remembering to add it.
    """
    return _printed_by([
        ("the gate in the world %r" % kind,
         (lambda k=kind: _arm(PROBE, kind=k, quiet=False)))
        for kind in sorted(WORLDS)
    ])


def _under_the_blocks_capture(run):
    """Run `run()` with a capture carrying THIS subject's head installed, and
    leave the two memo caches as they were found.

    `A-35-F2`'s restore and `C35-F1`'s second pair of arms both need this, and
    two copies of it is how two copies drift apart. The capture has to carry
    the SUBJECT's head: the enrolment check resolves its subject from the
    harness it runs in, so a world's capture makes it refuse
    `RUN-CAPTURE-NOT-THIS-HEAD` and the census then holds a refusal where the
    printed lines should be -- the vacuity this pack forbids. And the enrolment
    check GENERATES on every call, even where nothing is enrolled, so an arm
    that runs it with no capture refuses rather than printing: that is why the
    two `C35-F1` arms are in here and not beside the others.
    """
    held = list(_RUN_CAPTURE)
    bodies, rows = dict(_BODIES), dict(_ROWS)
    _RUN_CAPTURE[:] = [_seat_capture("blocks", _subject_top(_harness_dir()))]
    try:
        return run()
    finally:
        _RUN_CAPTURE[:] = held
        _BODIES.clear()
        _BODIES.update(bodies)
        _ROWS.clear()
        _ROWS.update(rows)


def printed_block_sentences():
    """Every distinct paragraph the ENROLMENT check says, run loud.

    `C32-S3`'s third site. `check_blocks` keeps a findings list of its own and
    prints it directly, which is the declared limit of the `ast` law; it is
    bounded here by ARRIVAL instead, which is the closure that does not depend
    on a syntax.
    """
    # A world's own capture is installed for the length of these two arms, the
    # way `_arm` does it, and for a reason this round measured: with no capture
    # installed the enrolment check stops earlier and says LESS, so the census
    # counted 34 shapes when run by hand and 36 under the driver, where a real
    # capture is on the command line. A census whose number depends on the
    # environment measures the environment; this one is pinned to a world.
    # The capture has to carry THIS subject's head, not a world's: the
    # enrolment check resolves the subject from the harness it is run in, so a
    # world's capture makes it refuse `RUN-CAPTURE-NOT-THIS-HEAD` and the
    # census then holds a refusal where the printed lines should be. `R34-S1`
    # of the round-34 challenger is about paragraphs below the law; this is the
    # same question one step earlier -- a family that refuses prints nothing,
    # and a census of nothing is the vacuity the project forbids.
    # And `A-35-F2`, which this round measured on its own commit before anyone
    # else read it. A generator RUNS the arms, and `_block_body` and
    # `_guard_rows` memoise what a run produced. So installing a capture here
    # -- which the paragraph above does deliberately -- filled those caches
    # under THIS arm's capture, and `blocks_test`, a VERDICT arm that runs much
    # later with no capture installed, then read the memoised bodies and ran to
    # completion where on `493d135` it refused `RUN-CAPTURE-ABSENT` and
    # measured nothing. A census that makes a later verdict stop refusing is a
    # fail-open, and this pack's rule is that a fail-open blocks. Both caches
    # are therefore snapshotted and put back, so nothing this family generated
    # outlives it; `capture_leak_arm` is the arm, and it reds if either cache
    # is left behind.
    return _under_the_blocks_capture(lambda: _printed_by([
        ("the enrolment check on an edited block",
         (lambda: _blocks_arm("", edit=True, quiet=False))),
        ("the enrolment check on a correct block",
         (lambda: _blocks_arm("", quiet=False))),
    ]))


# ── `C35-F1` / `R36-S1`: the SET of emission sites, derived from the commit ──
#
# Three rounds running, the same shape of defect: a branch that PRINTS and that
# no arm provokes, with prose saying the branch is bound. `C33-F1` was eight
# doors in `scan` named as one; `C34-S1` was two branches of `scan` in no shape
# of the census; `C35-F1` is two branches of `check_blocks`, and the coordinator
# asked whether the author wanted to keep answering it one site at a time.
#
# The answer is no, and this is what replaces that: the set of emission sites
# is DERIVED from the committed bytes of the verdicts, and every one of them
# must have been REACHED while the census ran. A site is not something an
# author remembers to list -- it is something `ast` finds and the recorder
# either saw executed or did not. A site added later, armed by nobody, is named
# by LINE here before anyone notices it is missing from a list. `C36-S2`: the
# ordinal this sentence used to carry said `twelfth` while the literal below is
# TEN, because another section counted a different set -- `scan`'s own emission
# points, eleven of them. The law pins direct print sites in the three
# functions named below, and nothing here counts anything else.
#
# The declared reach, stated because every law in this file states one: the
# three functions below, which are the two VERDICTS a reader acts on and the
# single door they emit findings through. Generators and `--emit` print too,
# and they assert no verdict; `--selftest`'s own arm lines print too, and they
# are the measurement rather than the thing measured.
EMITTING_VERDICTS = ("scan", "check_blocks", "_finding")

# `C36-S3`: the counts this census pins, as LITERALS, because a census pins its
# SET and a count armed from one side only is the `C32-S1` shape. `SITE_COUNT`
# is every emission site `emission_sites` derives from the commit;
# `BLIND_COUNT` is how many of them the branch family alone reaches -- the
# control that keeps the law from passing while those branches are unprovoked.
# Both are re-counted by the run that prints them, never edited to match it.
SITE_COUNT = 10
BLIND_COUNT = 4
DOOR_COUNT = 16


def _verdict_spans():
    """{function: the line span} for each verdict, from the COMMITTED bytes."""
    out = {}
    for name in EMITTING_VERDICTS:
        body = _COMMITTED_AST.get(name) if _COMMITTED_AST else None
        if body is None:
            body = _source_of(globals()[name])
        last = getattr(body, "end_lineno", body.lineno) or body.lineno
        out[name] = (body.lineno, last)
    return out


def emission_sites():
    """{(function, first line): (the line span, how it emits)} for every
    emission site of the verdicts, read from the COMMITTED bytes of this file.

    `C36-S1`: three kinds of door, because a test of the call's SPELLING is
    not a test of what emits.

      * `direct` -- `print`, or `.print`/`.write` on anything. These are the
        sites the census requires to have RUN: a direct print no arm provokes
        is the defect `C33-F1`, `C34-S1` and `C35-F1` each were.
      * a name BOUND from an emission, in the function or at the commit's
        module level (`out = sys.stdout.write`, then `out(...)`). The
        `R20-F1` doctrine, with the sides swapped.
      * a call to a module-level helper that can reach a print
        (`_can_reach_a_print`, written for `C33-F1`).

    The last two are DOORS, not lines that must run: a helper that prints only
    when it refuses is reached on no clean run, so requiring it would red every
    green run. What they bound is the CONVERSE law -- an emission that passed
    through a line of a verdict must have passed through a door derived here,
    or it is named. So a new emitter is caught whether it RUNS (the converse)
    or does not (the literal count moves).

    The spans, rather than single lines, because a frame's `f_lineno` during a
    multi-line call is not required to be the line `ast` gives the `Call`
    node, and a law that depends on which of the two Python reports would be a
    law about an implementation detail.

    This reads the commit, like every other rule in this frame, so the line
    numbers are the commit's. They are the running file's as well in any run
    that reaches a verdict, because `self_bytes_committed` refuses by name when
    the two differ -- and `emission_site_census` asserts that rather than
    assuming it.
    """
    bodies = {}
    for name in EMITTING_VERDICTS:
        body = _COMMITTED_AST.get(name) if _COMMITTED_AST else None
        if body is None:
            body = _source_of(globals()[name])
        bodies[name] = body
    if not _COMMITTED_AST:                                     # pragma: no cover
        _source_of(globals()[EMITTING_VERDICTS[0]])
    helpers = _emitting_helpers(dict(_COMMITTED_AST))
    _msgs, text = committed_text(os.path.basename(os.path.realpath(__file__)))
    if text is None:
        raise Refusal(
            "FRAME-SOURCE-NOT-IN-COMMIT: the committed bytes of this file could not be "
            "read, so the MODULE-LEVEL bindings a call in a verdict may emit through "
            "are unknown. `C36-S1` is refused by name rather than measured over the "
            "function bodies alone, because an alias bound at import is exactly the "
            "form that escapes a test of the call's spelling."
        )
    at_module = _emission_aliases(ast.parse(text), module_only=True)
    out = {}
    for name, body in bodies.items():
        aliases = dict(at_module)
        aliases.update(_emission_aliases(body))
        for node in ast.walk(body):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            how = None
            if _is_an_emission(node):
                how = "direct"
            elif isinstance(f, ast.Name) and f.id in aliases:
                how = "the name `%s`, bound from %s" % (f.id, aliases[f.id])
            elif isinstance(f, ast.Name) and f.id in helpers:
                how = "a call to `%s`, which reaches a print" % f.id
            if how is None:
                continue
            last = getattr(node, "end_lineno", node.lineno) or node.lineno
            out[(name, node.lineno)] = ((node.lineno, last), how)
    return out


def _emission_aliases(body, module_only=False):
    """{name: what it was bound from} for names in `body` bound to an emission.

    `C36-S1`, and it is the `R20-F1` doctrine with the sides swapped. There,
    a whitelist of method NAMES said nothing about the OBJECT the method was
    called on; here, a test of the call's SPELLING says nothing about a name
    that HOLDS the emission -- `out = sys.stdout.write` and then `out(...)` is
    a print this file's `ast` test does not classify as one. So an assignment
    whose value is an emission attribute, or the Name `print` itself, binds an
    alias, and a call through that name is a site.

    Read over the function's own body, and over the commit's MODULE level with
    `module_only`, because an alias bound at import is the form that escapes
    both sides of the law: the spelling test does not classify the call, and
    the recorder's wrapper is installed after the binding already holds the
    real `write`. A site derived here and never recorded is UNREACHED, which
    reds -- the conservative direction.
    """
    out = {}
    nodes = body.body if module_only else ast.walk(body)
    for node in nodes:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if value is None:                                      # pragma: no cover
            continue
        held = None
        if isinstance(value, ast.Attribute) and value.attr in ("print", "write"):
            held = "`%s`" % ast.unparse(value)
        elif isinstance(value, ast.Name) and value.id == "print":
            held = "`print`"
        if held is None:
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for t in targets:
            for sub in ast.walk(t):
                if isinstance(sub, ast.Name):
                    out[sub.id] = held
    return out


def _record_emissions(run):
    """Run `run()` and return the set of lines of THIS file that an emission
    passed THROUGH -- the printing line and every line of this file waiting
    below it on the stack.

    `print` is wrapped for the length of the call and put back, which is the
    plant idiom this file already uses for `_FRAME_PARSED` and for the
    import-time snapshots. `builtins` is reached through `sys.modules` rather
    than imported, so the import list of the commit is unchanged.

    Two things here answer `C36-S1`:

      * `sys.stdout.write` is wrapped beside `print`, through a proxy, because
        `sys.stdout` is a stream whose `write` cannot be assigned. An alias
        resolved at call time -- `out = sys.stdout.write` inside the run --
        then records like any other emission. One bound at IMPORT holds the
        real `write` and records nothing, and that is why the derivation reads
        the commit's module level too: the site is derived, never recorded,
        and reds as UNREACHED.

        THE REACH OF THAT WRAPPER, measured and not assumed: an arm captures
        by `contextlib.redirect_stdout`, which REPLACES the stream, so a
        direct `write` executed inside an arm reaches the capture without
        passing this proxy. `print` is wrapped on `builtins` and is recorded
        wherever it runs. What bounds the unrecorded form is not this
        recorder: it is the DOOR census, which counts the alias
        syntactically -- a planted `out = sys.stdout.write` moves 16 doors to
        17 -- and ARRIVAL, which names the paragraph however it was printed. A
        committed plant emitting through a SUBSCRIPT (`{"w": sys.stdout.write}
        ["w"](...)`), which `ast` cannot classify and this proxy does not see,
        reds SEVEN arrival arms, among them "every printed paragraph is a
        finding or a declared one". Three laws, and the round states which one
        holds which form rather than crediting this one with all three.
      * the whole CHAIN of this file's frames is recorded, not the printing
        frame alone. A call to a helper that prints is an emission site of the
        caller -- that is what `_can_reach_a_print` says -- so the line that
        CALLS it has to be recordable, or the law would red every derived
        helper call as unreached. A line of this file that is in no derived
        site is then a finding of its own: `emission_site_census` compares the
        two sets BOTH ways.
    """
    mod = sys.modules["builtins"]
    real = mod.print
    real_stdout = sys.stdout
    here = os.path.realpath(__file__)
    seen = set()

    def record(frame):
        try:
            while frame is not None:
                if os.path.realpath(frame.f_code.co_filename) == here:
                    seen.add(frame.f_lineno)
                frame = frame.f_back
        except (OSError, AttributeError):                      # pragma: no cover
            pass

    def recording(*args, **kw):
        record(sys._getframe(1))
        return real(*args, **kw)

    class _recording_stdout(object):
        """`sys.stdout` with a recording `write`, delegating everything else.

        Not a subclass and not a copy: whatever the real stream does, this
        does, because a gate that changes what its own output IS would be
        measuring a different program.
        """

        def write(self, text):
            record(sys._getframe(1))
            return real_stdout.write(text)

        def __getattr__(self, name):
            return getattr(real_stdout, name)

    try:
        mod.print = recording
        sys.stdout = _recording_stdout()
        run()
    finally:
        mod.print = real
        sys.stdout = real_stdout
    return seen


def emission_site_census():
    """`C35-F1`: every emission site of the verdicts is REACHED by an arm.

    The closure of the class the last three rounds answered one site at a time.
    Two sets, and neither is written down: the sites come from `ast` over the
    committed bytes, the reached lines come from a recorder wrapped round
    `print` while the whole census runs. A site in the first and not the second
    is named by function and line.

    Six lines, and `C36-S1` added the second and the fourth:

      1. every DIRECT emission site was reached;
      2. the CONVERSE -- every line of a verdict an emission passed through is
         a door this law derived. One direction alone leaves an emitter that
         RUNS through a form `ast` does not classify simply absent from the
         comparison, which is how `out = sys.stdout.write` walked past the
         round that introduced this census. Its reach is what the recorder
         sees, which `_record_emissions` states: `print` wherever it runs, and
         a `write` on the real stream. A `write` inside an arm's redirected
         capture is bounded by the door count and by arrival instead, both
         measured;
      3. the count of direct sites is pinned as a LITERAL, so a site DELETED
         reds as loudly as one added -- a census pins its set;
      4. the count of DOORS likewise, so a new way out of a verdict moves a
         figure even when no arm ever provokes it;
      5. the recorder is not blind: with one family of arms left out, the
         sites only that family reaches are NAMED, and `C36-S3`: their number
         is pinned too, because `bool(blind)` would pass with one of the four
         left blind;
      6. the premise is asserted, not assumed: the committed bytes and the
         bytes on disk are the same file, so the commit's line numbers are the
         running file's.
    """
    ok = True
    bytes_msgs = []
    try:
        _ok, bytes_msgs = self_bytes_committed()
    except Refusal as why:                                     # pragma: no cover
        bytes_msgs = [str(why)]
    doors = emission_sites()
    sites = {at: span for at, (span, how) in doors.items() if how == "direct"}
    reached = _record_emissions(printed_paragraphs)
    missed = sorted(
        (name, span) for (name, _at), span in sites.items()
        if not any(span[0] <= line <= span[1] for line in reached)
    )
    # The CONVERSE, `C36-S1`: every line an emission passed through INSIDE a
    # verdict is a derived site. Without it the two sets are compared one way
    # only, and an emitter that is provoked but undeclared -- a call this
    # file's derivation does not classify -- is simply absent from the
    # comparison instead of being named. Scoped to the verdicts' own spans
    # because the arms that drive the census print too, and they are not what
    # this law is about.
    spans = _verdict_spans()
    undeclared = sorted(
        (name, line) for name, (first, last) in spans.items()
        for line in reached
        if first <= line <= last
        and not any(at[0] == name and span[0] <= line <= span[1]
                    for at, (span, _how) in doors.items())
    )
    # The blindness control: the branch family left out, which is the family
    # `C35-F1` is about. The sites only it reaches must then be named -- if
    # they are not, this law would pass with those branches unprovoked, which
    # is the state this round found.
    without = _record_emissions(lambda: (printed_finding_sentences(),
                                         printed_world_sentences(),
                                         printed_seat_sentences(),
                                         printed_block_sentences()))
    blind = sorted(
        (name, span) for (name, _at), span in sites.items()
        if not any(span[0] <= line <= span[1] for line in without)
    )
    for label, good, shown in (
        ("every emission site of the verdicts was reached", not missed,
         "%d site(s) unreached of %d" % (len(missed), len(sites))),
        ("every line an emission passed through is a derived site",
         not undeclared,
         "%d line(s) in a verdict, emitting, undeclared" % len(undeclared)),
        ("the census of emission sites", len(sites) == SITE_COUNT,
         "%d site(s), want %d" % (len(sites), SITE_COUNT)),
        ("the census of doors an emission may leave by",
         len(doors) == DOOR_COUNT,
         "%d door(s), want %d" % (len(doors), DOOR_COUNT)),
        ("with the branch family left out, its sites are NAMED",
         len(blind) == BLIND_COUNT,
         "%d site(s) unreached without it, want %d" % (len(blind), BLIND_COUNT)),
        ("the commit's line numbers are this file's", not bytes_msgs,
         "committed bytes: %s"
         % ("the same" if not bytes_msgs else bytes_msgs[0].split(":")[0])),
    ):
        ok = ok and good
        print("  sites C35-F1 %-50s %-40s -> %s"
              % (label, shown, "as required" if good else "**SELFTEST FAILED**"))
    for name, span in missed:
        print("    UNREACHED: %s, lines %d-%d" % (name, span[0], span[1]))
    for name, line in undeclared:
        print("    EMITTED FROM AN UNDECLARED SITE: %s, line %d" % (name, line))
    for name, span in blind:
        print("    reached only by the branch family: %s, lines %d-%d"
              % (name, span[0], span[1]))
    return ok


def printed_branch_sentences():
    """Every printed branch of the two VERDICTS that no other family provokes.

    `C34-S1` and then `C35-F1`, which is the same class one function over and
    is why this docstring no longer counts the branches it covers. Round 36
    provoked the two `scan` has -- the `INERT` branch (`seen == 0`, rc 2) and
    the frame refusal at the top (rc 5) -- and said in three places that the
    printed side of `check_blocks` was bound. It was not: `check_blocks` has
    four emission sites and its own family provokes two, so its `INERT`
    paragraph (`enrolled == 0`), which both arrival predicates name when they
    are handed it, was never handed to them. The coordinator committed a
    criterion claim there and the selftest returned 0.

    All four are reachable without a plant in the subject's own logic: a
    documents directory with no figure, a documents tree with no generated
    block, and either verdict under an inadmissible frame.

    What stops a third round of this is NOT this list, which a later branch can
    outgrow in silence. It is `emission_site_census`, which derives the SET of
    emission sites from the COMMITTED bytes of both verdicts and requires each
    one to have been REACHED while the census ran. A site added later and armed
    by nobody reds there, named by line, before anyone has to notice it is
    missing from here.
    """
    def inert():
        # No `key=<number|boolean>` line anywhere in the documents, which is
        # the one condition the branch asks about.
        return _arm("a document with no figure anywhere in it", quiet=False)

    def frame():
        # The frame instruments read the REAL tree, and every run that reaches
        # this census has a clean committed one -- that is what admits it. So
        # the refusal LIST is planted for the length of the arm, the way the
        # `C20` arm in front of `--check-blocks` plants one, and what the
        # census then reads is the SENTENCE this branch prints, which is
        # parameterised by nothing but the first refusal and the count. The
        # planted refusal is deliberately LOWERCASE: a `FRAME-...` spelling
        # would put a NAME in the names census that no instrument raised.
        cache = list(_FRAME_PARSED)
        try:
            _FRAME_PARSED[:] = [(
                "a refusal planted by this arm only, so that the sentence this "
                "branch prints arrives where a law reads it",
            )]
            return _arm(PROBE, quiet=False)
        finally:
            _FRAME_PARSED[:] = cache

    def block_inert():
        # `C35-F1`: `enrolled == 0`, which an ordinary run reaches whenever the
        # documents it is pointed at hold no generated block at all. The
        # paragraph it prints is labelled, carries no pin, and is matched by no
        # declaration until the sixth entry below -- so it is the one the
        # coordinator's plant walked through.
        def once():
            with tempfile.TemporaryDirectory() as at:
                docs = os.path.join(at, "docs")
                os.makedirs(docs)
                _write(docs, "a.md", "a document with no generated block in it\n")
                return check_blocks(docs, quiet=False)

        return _under_the_blocks_capture(once)

    def block_frame():
        # The other half of the same function, and the same mechanism as
        # `frame` above: the refusal LIST is planted for the length of the arm
        # because the frame instruments read the real tree, which is clean in
        # any run that reaches this census.
        def once():
            cache = list(_FRAME_PARSED)
            try:
                _FRAME_PARSED[:] = [(
                    "a refusal planted by this arm only, so that the sentence "
                    "this branch prints arrives where a law reads it",
                )]
                with tempfile.TemporaryDirectory() as at:
                    return check_blocks(at, quiet=False)
            finally:
                _FRAME_PARSED[:] = cache

        return _under_the_blocks_capture(once)

    return _printed_by([
        ("the INERT branch, on a documents directory with no figure", inert),
        ("the frame refusal at the top of the scan", frame),
        ("the enrolment INERT branch, on a tree with no generated block",
         block_inert),
        ("the frame refusal in front of the enrolment check", block_frame),
    ])


def printed_paragraphs():
    """EVERY paragraph this gate can print, as far as its arms can provoke it.

    The union of the five families: the `CATCH` arms, every declared world, the
    two seat arms, the enrolment check and the two branches `C34-S1` named. This is the set the pin arm binds
    and the set the criterion selector is measured against, so that adding a
    finding branch cannot add a sentence no law reads -- the defect `C33-F1`
    named, where a closure by SYNTAX was credited with a reach only arrival can
    give it.
    """
    out, seen = [], set()
    for label, text in (printed_finding_sentences()
                        + printed_world_sentences()
                        + printed_seat_sentences()
                        + printed_block_sentences()
                        + printed_branch_sentences()):
        key = _sentence_shape(text)
        if key in seen:
            continue
        seen.add(key)
        out.append((label, text))
    return out


def printed_seat_sentences():
    """Every distinct paragraph the SEAT arms say, by running them loud.

    The coordinator's `C32-S3`. `_arm` gained a `quiet` parameter in round 32
    and these two did not, so the harness-inside-a-repository worlds -- the
    git-file seat, the five anchor positions from three working directories --
    printed and refused in sentences no law read, which is exactly the state
    the findings were in for four rounds.

    A refusal is included deliberately. In these worlds the refusal IS the
    output a reader meets, and `GIT-*` refusals talk about which repository
    holds the haystack -- where the word names a DIRECTORY and not the rule --
    so they are the paragraphs most likely to drift into stating a criterion
    they do not hold.
    """
    arms = [("the git-file seat", lambda: _gitfile_arm(quiet=False))]
    for where in ANCHOR_POSITIONS:
        for seat in ANCHOR_CWDS:
            arms.append((
                "the anchor seat %s, run from %s" % (where, seat),
                (lambda w=where, c=seat: _anchor_arm(w, c, quiet=False)),
            ))
    return _printed_by(arms)


def finding_labels(printed):
    """The distinct NAMES a finding prints, derived from the paragraphs.

    `C32-S3`: a seat world's paragraph arrives as `REFUSED: GIT-...`, so the
    `REFUSED` prefix is stepped over rather than counted as a name of its own.
    A count that names the prefix sees one label where there are four.
    """
    names = set()
    for _, text in printed:
        hit = re.match(r"^(?:REFUSED: )?" + LABELLED.lstrip("^"), text)
        if hit:
            names.add(hit.group("name"))
    return sorted(names)


def gate_sentences(printed, rule_statements_only=False):
    """Every stale or missing sentence about the haystack in what a RUN of this
    gate PRINTS, as opposed to what its file says.

    `A-29-F1`, which the coordinator rated up into `C29-F1`. The text law above
    reads bytes a reviewer could grep; this one reads the strings a run
    produced, which is what a reader is actually told. At `acfe049` the
    `RUN-CAPTURE-ABSENT` refusal -- the first sentence anyone running this gate
    by hand meets -- still stated round 26's criterion and sent a reader off to
    make the run print their figure, which is the remedy `R27-F1` abolished.

    The limit, declared: the set of sites is the set the arms PROVOKE. A new
    refusal written in new words in a new place is not caught here; it is
    caught by the text law above only if it spells a retired wording. The sink
    closed the figure census by construction because `case()` writes a figure.
    Prose is written by a person, and nothing here derives the set of
    sentences a person may add.
    """
    out = []
    for where, msg in printed:
        low = msg.lower()
        for retired in RETIRED_SENTENCES:
            if retired.lower() in low:
                out.append(
                    "GATE-SENTENCE-RETIRED: %s prints %r, which describes a rule this "
                    "file no longer holds." % (where, retired)
                )
        if rule_statements_only and not _states_the_criterion(msg):
            continue
        if HAYSTACK_SENTENCE not in msg:
            out.append(
                "GATE-SENTENCE-UNQUOTED: %s says what the haystack is without quoting "
                "HAYSTACK_SENTENCE (%r). This file printed such a sentence for three "
                "rounds while checking the driver for it."
                % (where, HAYSTACK_SENTENCE)
            )
    return out


def _can_reach_a_print(tree):
    """Module-level functions that can reach an emission, by a fixed point.

    `C33-F1`: the law below read the Name `print` and nothing else, so a
    helper that prints, called from the loop, walked through it. A helper is
    now resolved transitively -- `_coord_emit` calling `print` is an emitter,
    and so is anything calling `_coord_emit`.
    """
    return _emitting_helpers(
        {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    )


def _emitting_helpers(funcs):
    """The same fixed point over a DICT of module-level `FunctionDef`s.

    `C36-S1`: `emission_sites` needs this over the COMMITTED functions, which
    is the form `_COMMITTED_AST` already holds, and two callers computing the
    same closure two ways is how one of them drifts.
    """
    emits = {name for name, node in funcs.items()
             if any(_is_an_emission(x) for x in ast.walk(node))}
    moved = True
    while moved:
        moved = False
        for name, node in funcs.items():
            if name in emits:
                continue
            for x in ast.walk(node):
                if (isinstance(x, ast.Call) and isinstance(x.func, ast.Name)
                        and x.func.id in emits):
                    emits.add(name)
                    moved = True
                    break
    return emits


def _is_an_emission(node):
    """Is this call a way of putting a line in front of a reader?

    `print`, `builtins.print`, and `write` on anything -- `sys.stdout.write`,
    `os.write`, a file handle. Named by the CALL and not by a list of modules,
    because the list is what `C33-F1` walked around.
    """
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    if isinstance(f, ast.Name) and f.id == "print":
        return True
    return isinstance(f, ast.Attribute) and f.attr in ("print", "write")


def emitters_in_the_finding_loops(text):
    """Calls inside `scan`'s FINDING loops that can emit, other than `_finding`.

    `R32-S1`, as `C33-F1` corrected it. WHAT THIS LAW READS, exactly: inside
    the `for`, `while` and comprehension loops of `scan` whose iterable
    mentions `findings` or `extra`, every call that is an emission
    (`_is_an_emission`) or that reaches one through a module-level helper
    (`_can_reach_a_print`), except `_finding` itself. It names them by line.

    WHAT IT DOES NOT READ, and this is the correction the coordinator's measure
    forced -- the round-32 commit said this law refused "any other door" in
    three places, and it read one syntactic form in two loops, one door of
    eight:

      * an emission in `scan` OUTSIDE every finding loop. That is outside this
        law BY CONSTRUCTION, and it is bounded instead by ARRIVAL, in
        `union_sentence_arms`: a labelled paragraph the gate PRINTS without the
        pin is named there however it was printed.
      * `check_blocks`, which keeps a findings list of its own and prints it
        directly. One doctrine for two functions is this pack's own named
        defect; `printed_block_sentences` brings that function under the
        arrival law instead, and the coordinator has ruled the shared door a
        later round.

    So this is a LINT with a stated reach, and the closure of the class is the
    arrival census. A lint credited with a census's reach is exactly the defect
    `C33-F1` named.
    """
    tree = ast.parse(text)
    body = next((n for n in tree.body
                 if isinstance(n, ast.FunctionDef) and n.name == "scan"), None)
    if body is None:                                           # pragma: no cover
        raise Refusal(
            "FRAME-FUNCTION-ABSENT: `scan` is not in the committed bytes, so the "
            "loops this law reads are not the loops that print a finding."
        )
    helpers = _can_reach_a_print(tree)
    bad = []
    for node in ast.walk(body):
        over = None
        if isinstance(node, (ast.For, ast.While)):
            over = node.iter if isinstance(node, ast.For) else node.test
        elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp,
                               ast.DictComp)):
            over = node
        if over is None:
            continue
        names = {n.id for n in ast.walk(over) if isinstance(n, ast.Name)}
        if not ({"findings", "extra"} & names):
            continue
        for inner in ast.walk(node):
            if not isinstance(inner, ast.Call):
                continue
            f = inner.func
            if isinstance(f, ast.Name) and f.id == "_finding":
                continue
            if _is_an_emission(inner) or (
                    isinstance(f, ast.Name) and f.id in helpers):
                bad.append(inner.lineno)
    return sorted(set(bad))


def finding_construction_test():
    """`R32-S1`: every finding is emitted by `_finding`, read from the commit."""
    ok = True
    _msgs, text = committed_text(os.path.basename(os.path.realpath(__file__)))
    if text is None:
        raise Refusal(
            "FRAME-SOURCE-NOT-IN-COMMIT: this file's committed bytes could not be "
            "read, so the construction this law binds is not the one the commit "
            "carries."
        )
    live = emitters_in_the_finding_loops(text)
    good = not live
    ok = ok and good
    print(
        "  construction R32-S1 the finding loops call `print` directly at %-14s -> %s"
        % (", ".join(str(n) for n in live) or "no line",
           "as required" if good else "**SELFTEST FAILED**")
    )
    # The tail is composed from the pin, not written beside it.
    good = HAYSTACK_SENTENCE in FINDING_TAIL
    ok = ok and good
    print(
        "  construction R32-S1 FINDING_TAIL carries the pin by composition %-9s -> %s"
        % ("yes" if good else "NO", "as required" if good else "**SELFTEST FAILED**")
    )
    # And the arm: a branch that prints its own finding is NAMED. The plant is
    # made in a COPY of the committed source, so nothing on disk moves.
    hit = "    for rel, n, tok, raw, why, owners in findings:\n"
    if hit not in text:                                        # pragma: no cover
        print("  construction R32-S1 the findings loop was not found -> "
              "**SELFTEST FAILED**")
        return False
    planted = text.replace(hit, hit + '        print("a finding of its own")\n', 1)
    found = emitters_in_the_finding_loops(planted)
    good = len(found) == 1
    ok = ok and good
    print(
        "  construction R32-S1 a planted direct `print` is named at %-16s -> %s"
        % (", ".join(str(n) for n in found) or "no line",
           "as required" if good else "**SELFTEST FAILED**")
    )
    return ok


def finding_sentence_arms():
    """`C31-S3`: the sentences a FINDING prints, derived by running the arms.

    The set is a census, so it is pinned by LITERALS and an arrival reds as
    loudly as a departure: six paragraph shapes and two finding names. If the
    arms ever go quiet again -- which is how these sentences escaped every law
    in this file for four rounds -- the counts fall and this arm reds instead
    of passing over an empty set, which is the vacuity the project's own ruling
    forbids.
    """
    ok = True
    printed = printed_finding_sentences()
    labels = finding_labels(printed)
    found = gate_sentences(printed, rule_statements_only=True)
    for label, good, said in (
        ("the live set reports nothing", not found,
         "%d finding(s)" % len(found)),
        ("the census of printed shapes", len(printed) == 6,
         "%d paragraph shape(s), want 6" % len(printed)),
        ("the census of finding names", labels == [
            "BIDI-CONTROL-IN-A-CANDIDATE", "NOT REQUIRED BY ANY CASE"],
         ", ".join(labels) or "none"),
        # `R32-S1`, and `C33-F1` after it: the pin is required of every
        # LABELLED paragraph, with no selector in the way. This line is the
        # CATCH set only; `union_sentence_arms` applies the same requirement to
        # every paragraph the gate can print, which is where the reach comes
        # from -- a census of one family is a census of one family.
        ("the pin in every labelled finding, no selector",
         all(HAYSTACK_SENTENCE in t for _, t in printed
             if re.match(LABELLED, t)),
         "%d labelled paragraph(s)"
         % sum(1 for _, t in printed if re.match(LABELLED, t))),
    ):
        ok = ok and good
        print("  findings C31-S3 %-34s %-44s -> %s"
              % (label, said, "as required" if good else "**SELFTEST FAILED**"))
    for why in found:
        print("    " + why)
    live = next((t for w, t in printed
                 if t.startswith("NOT REQUIRED BY ANY CASE")), None)
    if live is None:                                           # pragma: no cover
        print("  findings C31-S3 the subject sentence is not in the set -> "
              "**SELFTEST FAILED**")
        return False
    retired = RETIRED_SENTENCES[0]
    worlds = (
        ("the pin cut out of the live finding sentence",
         live.replace(HAYSTACK_SENTENCE, "what this gate happens to hold"),
         "GATE-SENTENCE-UNQUOTED"),
        ("a retired wording put into it",
         live.replace(HAYSTACK_SENTENCE, retired),
         "GATE-SENTENCE-RETIRED"),
    )
    for label, planted, want in worlds:
        names = [f.split(":")[0]
                 for f in gate_sentences([("the planted finding", planted)],
                                         rule_statements_only=True)]
        good = want in names
        ok = ok and good
        print("  findings %-44s refused as %-24s (want %s) -> %s"
              % (label, names[0] if names else "NO REFUSAL", want,
                 "as required" if good else "**SELFTEST FAILED**"))
    # The control, and it is what keeps the selector from being a net that reds
    # every line: a printed paragraph that is NOT about the criterion and does
    # not quote the pin must pass.
    other = next((t for w, t in printed if t.startswith("the decision frame")), "")
    good = not gate_sentences([("the frame line", other)],
                              rule_statements_only=True)
    ok = ok and good
    print("  findings %-44s %-35s -> %s"
          % ("control: a printed line that states no rule", "0 finding(s)",
             "as required" if good else "**SELFTEST FAILED**"))
    return ok


def _criterion_attacks(live):
    """`C32-S1`'s four escapes and two more, built FROM the live sentence.

    Each world is the live finding sentence with the pin cut out -- which is
    the world the round-32 arm already reds -- and then one further change that
    took it under round 31's line of three stems. They are built here rather
    than written out so that a change to the live sentence changes the attacks
    with it.
    """
    cut = live.replace(HAYSTACK_SENTENCE, "what this gate happens to hold")
    return (
        ("A: no `value`, no `expectation`",
         cut.replace("value case", "case").replace("expectations", "things")),
        ("B: `demanded` for `asserted`",
         cut.replace("value case", "case").replace("asserted", "demanded")),
        ("C: the label dropped too",
         cut.replace("NOT REQUIRED BY ANY CASE", "NOT HELD HERE")
            .replace("value case", "case")),
        ("E: the live sentence minus the word `value`",
         cut.replace("no value case", "no case")),
        ("F: `the run` for `this run`", cut.replace("this run", "the run")),
        ("G: `this  run`, two spaces", cut.replace("this run", "this  run")),
    )


def criterion_selector_arms(printed):
    """`C32-S1`: the selector's line, armed on BOTH sides by measurement.

    Round 32 left this selector loose in the one direction no arm read: the
    coordinator built four paragraphs that state the criterion in detail,
    quote nothing, and were not selected, and measured that only RAISING the
    threshold redded anything. The line is now two derived stems with no
    phrase beside them, and this arm requires three things of it at once --
    every attack caught, nothing live redded, and a FAILURE at each
    neighbouring threshold, which is what makes the number measured rather
    than chosen.
    """
    global SENTENCE_STEM_THRESHOLD, HAYSTACK_SENTENCE
    ok = True
    live = next((t for w, t in printed
                 if t.startswith("NOT REQUIRED BY ANY CASE")
                 and "(written as" not in t), None)
    if live is None:                                           # pragma: no cover
        print("  criterion C32-S1 the subject sentence is not in the set -> "
              "**SELFTEST FAILED**")
        return False
    attacks = _criterion_attacks(live)
    for label, planted in attacks:
        names = [f.split(":")[0]
                 for f in gate_sentences([("the planted paragraph", planted)],
                                         rule_statements_only=True)]
        good = "GATE-SENTENCE-UNQUOTED" in names
        ok = ok and good
        print("  criterion C32-S1 %-40s refused as %-24s -> %s"
              % (label, names[0] if names else "NO REFUSAL",
                 "as required" if good else "**SELFTEST FAILED**"))
    # Nothing live may be selected, or the line is a net that reds a table row.
    held = gate_sentences(printed, rule_statements_only=True)
    good = not held
    ok = ok and good
    print("  criterion C32-S1 %-40s %-35s -> %s"
          % ("the live shapes report nothing",
             "%d finding(s)" % len(held),
             "as required" if good else "**SELFTEST FAILED**"))
    for why in held:
        print("    " + why)
    # And the two neighbours. Each MUST break something, or the number is not
    # measured: at one, live shapes red; at three, an attack walks through.
    was = SENTENCE_STEM_THRESHOLD
    try:
        SENTENCE_STEM_THRESHOLD = 1
        loose = gate_sentences(printed, rule_statements_only=True)
        good = bool(loose)
        ok = ok and good
        print("  criterion C32-S1 %-40s %-35s -> %s"
              % ("at one stem the live shapes red",
                 "%d finding(s), want more than 0" % len(loose),
                 "as required" if good else "**SELFTEST FAILED**"))
        SENTENCE_STEM_THRESHOLD = 3
        escaped = [label for label, planted in attacks
                   if not gate_sentences([("x", planted)],
                                         rule_statements_only=True)]
        good = bool(escaped)
        ok = ok and good
        print("  criterion C32-S1 %-40s %-35s -> %s"
              % ("at three stems an attack escapes",
                 "%d escape(s), want more than 0" % len(escaped),
                 "as required" if good else "**SELFTEST FAILED**"))
    finally:
        SENTENCE_STEM_THRESHOLD = was
    # The coupling the round-31 docstring CLAIMED and held by accident: with
    # the phrase gone, every word this selector reads comes from the pin, so
    # replacing the pin replaces the selector. Measured, not asserted.
    other = "whatever the signed baseline FROZE for this document"
    kept = HAYSTACK_SENTENCE
    try:
        HAYSTACK_SENTENCE = other
        stems = _criterion_stems()
        moved = ("baseline" in stems and "case" not in stems)
        follows = (_states_the_criterion(
            "the signed baselines froze this document") is True)
        stale = (_states_the_criterion(
            "no value case of this run required it") is False)
    finally:
        HAYSTACK_SENTENCE = kept
    for label, good in (
        ("a replaced pin replaces the stems", moved),
        ("a paragraph in the NEW pin's words is selected", follows),
        ("a paragraph in the OLD pin's words is not", stale),
    ):
        ok = ok and good
        print("  criterion C32-S1 %-40s %-35s -> %s"
              % (label, "yes" if good else "NO",
                 "as required" if good else "**SELFTEST FAILED**"))
    return ok


def _labelled_printed_without_the_pin(paragraphs):
    """Labelled paragraphs a run PRINTED that do not carry the pin.

    `C33-F1`, and this predicate is the closure the round-32 commit claimed for
    its `ast` law. It decides nothing from the SHAPE of the code: a finding
    printed by a helper, by `sys.stdout.write`, from a `while` loop, from a
    comprehension or from outside every loop arrives here all the same, as long
    as an arm provokes the branch -- which `printed_paragraphs` now makes true
    of every declared world, both seats and the enrolment check.
    """
    out = []
    for where, text in _printed_to_stdout(paragraphs):
        if not re.match(LABELLED, text):
            continue
        # `C34-S1`: the declared non-findings are the ONE door that says a
        # printed paragraph is not a finding, and this arm reads everything
        # else. `INERT:` is labelled and carries no pin, and appending the pin
        # to it would make the paragraph below-the-law predicate read it as a
        # finding, which it is not -- so it is exempted HERE, by the same
        # declaration, and not by a second doctrine of its own. An edit to its
        # words stops matching that declaration and is then named by both arms,
        # which is the measurement at the end of `union_sentence_arms`.
        if _declared_non_finding(_sentence_shape(text)) is not None:
            continue
        if HAYSTACK_SENTENCE not in text:
            out.append((where, text))
    return out


NON_FINDING_PARAGRAPHS = (
    ("whole", "generated blocks: N enrolled, N finding(s)"),
    ("whole", "the decision frame was parsed before this verdict: four "
              "functions, no refusal"),
    ("whole", "a.md: the generated block `X` differs from a fresh run. It is "
              "generated, not written: run `X` -- or `X` -- and commit what it "
              "prints."),
    ("prefix", "quoted figures: N documents, haystack from "
               + HAYSTACK_SENTENCE + " ("),
    ("whole", "INERT: no `X` line was found in any document. The check is "
              "measuring nothing, which it must not report as a pass."),
    ("whole", "INERT: no generated block was found in any document, so this "
              "check is measuring nothing and must not report a pass."),
)
"""Every paragraph this gate PRINTS that is not a finding, declared.

`R34-S1`, the round-34 challenger's residual, and then its own two attacks on
the first form of this closure. Until this existed the arrival predicate bound
only the LABELLED shape, so an UNLABELLED paragraph --
printed through a callable the lint cannot resolve, in any branch -- sat below
both layers. The rule is turned round here: a printed paragraph is bound unless
it is one of these SIX declared non-findings. A new kind of printed line reds
whether it is labelled or not and whatever emitted it.

Two things this tuple does that a list of OPENINGS did not, both of them the
challenger's own attacks on the opening form:

  * three of the four are matched by their WHOLE shape, so a finding cannot be
    exempted by starting with a non-finding's first words and then saying
    something else;
  * the fourth is the inventory line, whose variable tail is a capture name and
    two digests, so it is matched by a PREFIX -- and that prefix is COMPOSED
    FROM the pin. An exempted paragraph of that kind therefore has to quote the
    rule itself, which is the thing the whole chain is for.

The sixth is `C35-F1`: the ENROLMENT check's own `INERT` paragraph, which has
different words from the scan's, so the fifth entry never covered it. It is
declared here on the same terms and by the same whole-shape match.

And one exclusion is stated rather than left silent, because `C35-F1` is partly
a finding about silence. The frame refusals of BOTH verdicts print a paragraph
beginning `REFUSED:`, and `_printed_to_stdout` classifies those as RAISED
rather than PRINTED, so neither predicate here reads them. That is deliberate
and it is not a gap: a refusal carries its own law, `gate_sentences` over the
provoked refusals, and requiring the figure-legitimacy sentence of a `GIT-*`
refusal about which repository holds the haystack would be a false red. Both
frame branches are PROVOKED all the same -- they are in the census, under
`gate_sentences` and under the emission-site law -- so what judges them is
named instead of absent.

And the exemptions are armed from both sides: the count is pinned as a literal,
and every entry must be MATCHED by a live printed paragraph. An exemption
nothing uses is an open door, which is this pack's own lesson about a gate
nobody calls.
"""


def _declared_non_finding(shape):
    """Which declared non-finding this shape IS, or None."""
    for kind, text in NON_FINDING_PARAGRAPHS:
        if kind == "whole" and shape == text:
            return text
        if kind == "prefix" and shape.startswith(text):
            return text
    return None


def _printed_paragraphs_below_the_law(paragraphs):
    """Printed paragraphs that are neither a finding nor a declared non-finding.

    `R34-S1`. A finding is identified by the tail `_finding` appends, which is
    composed from the pin, so this reads what a reader is TOLD and not how the
    code emitted it: a helper, an imported function, a method named neither
    `print` nor `write`, inside a loop or outside one, labelled or unlabelled,
    all arrive here the same way.
    """
    out = []
    for where, text in _printed_to_stdout(paragraphs):
        if FINDING_TAIL in text:
            continue
        if _declared_non_finding(_sentence_shape(text)) is None:
            out.append((where, text))
    return out


def union_sentence_arms():
    """`C33-F1`: every paragraph this gate can print, bound by ARRIVAL.

    The coordinator passed the round-32 closure by printing a labelled finding
    through a helper in the `extra` branch -- `NOT IN THE HAYSTACK` -- which no
    `CATCH` arm provokes, so no census counted it, and which contains no
    `print` inside a findings loop, so the `ast` law saw nothing. The selftest
    returned 0 and the sentence reached a reader. Measured, it was one of eight
    doors the law does not read; seven of the other eight were caught by the
    census, by arrival, and not by the construction.

    So the set is widened to every family of arms this file has, and the
    binding arm is the pin in every labelled paragraph PRINTED, which is a
    property of what a reader is told rather than of how the code says it. The
    counts are a census, pinned by LITERALS, so a world or a branch arriving
    later reds here instead of passing unread.
    """
    ok = True
    printed = printed_paragraphs()
    said = _printed_to_stdout(printed)
    labels = finding_labels(printed)
    found = gate_sentences(printed, rule_statements_only=True)
    unpinned = _labelled_printed_without_the_pin(printed)
    for label, good, shown in (
        ("the live union reports nothing", not found, "%d finding(s)" % len(found)),
        ("the census of paragraph shapes", len(printed) == 40,
         "%d shape(s), want 40" % len(printed)),
        ("of them PRINTED, not raised", len(said) == 29,
         "%d printed, want 29" % len(said)),
        ("the census of names", len(labels) == 15,
         "%d name(s), want 15" % len(labels)),
        ("C33-F1 the pin in every labelled paragraph PRINTED", not unpinned,
         "%d labelled printed, %d without the pin"
         % (sum(1 for _w, t in said if re.match(LABELLED, t)),
            len(unpinned))),
    ):
        ok = ok and good
        print("  union C33-F1 %-50s %-40s -> %s"
              % (label, shown, "as required" if good else "**SELFTEST FAILED**"))
    for why in found:
        print("    " + why)
    for where, text in unpinned:
        print("    " + where + ": " + text[:110])
    # `R34-S1`: the same question asked of EVERY printed paragraph, labelled or
    # not. Either `_finding` emitted it -- which the appended tail says -- or it
    # is one of the six declared non-findings. Anything else is a sentence a
    # reader meets that no law has read.
    below = _printed_paragraphs_below_the_law(printed)
    good = not below
    ok = ok and good
    print("  union R34-S1 %-50s %-40s -> %s"
          % ("every printed paragraph is a finding or a declared one",
             "%d below the law, %d declared non-findings"
             % (len(below), len(NON_FINDING_PARAGRAPHS)),
             "as required" if good else "**SELFTEST FAILED**"))
    for where, text in below:
        print("    " + where + ": " + text[:110])
    # And its arm: an UNLABELLED paragraph, in no declared opening, stating the
    # criterion. This is the shape the round-34 challenger named as sitting
    # below both earlier layers.
    # The exemptions, armed from both sides. A count that is not pinned lets a
    # fifth exemption in silently, and an entry no live paragraph matches is an
    # open door nothing walks through yet -- the pack's own lesson about a gate
    # nobody calls, applied to a whitelist.
    used = {_declared_non_finding(_sentence_shape(t))
            for _w, t in said if FINDING_TAIL not in t}
    unused = [t for _k, t in NON_FINDING_PARAGRAPHS if t not in used]
    for label, good, shown in (
        ("the census of declared non-findings",
         len(NON_FINDING_PARAGRAPHS) == 6,
         "%d declared, want 6" % len(NON_FINDING_PARAGRAPHS)),
        ("every exemption is matched by a live paragraph", not unused,
         "%d matched, %d unused" % (len(used - {None}), len(unused))),
    ):
        ok = ok and good
        print("  union R34-S1 %-50s %-40s -> %s"
              % (label, shown, "as required" if good else "**SELFTEST FAILED**"))
    for text in unused:
        print("    unused exemption: " + text[:100])
    for label, planted, want in (
        ("the spoof: a declared opening, then other words",
         "the decision frame was parsed before this verdict, and a figure is "
         "legitimate here when some assertion of this pass demanded it", True),
        ("an UNLABELLED paragraph in no declared opening",
         "a figure here is legitimate when some assertion of this pass "
         "demanded it, which this one did not", True),
        # The control is the LIVE inventory line, not a hand-written imitation
        # of it: the first form of this control was written by hand and passed
        # only because the exemption was four words long. It fails now, which
        # is the point -- an exemption that quotes the pin cannot be imitated
        # by a paragraph that does not.
        ("the control: the live inventory line itself",
         next((t for _w, t in said
               if t.startswith("quoted figures:")), "quoted figures:"), False),
    ):
        hit = bool(_printed_paragraphs_below_the_law(
            [("the planted paragraph", planted)]))
        good = hit is want
        ok = ok and good
        print("  union R34-S1 %-50s %-40s -> %s"
              % (label, "named" if hit else "not named",
                 "as required" if good else "**SELFTEST FAILED**"))
    # `C34-S1`, and the plant is the REVIEWER'S, rebuilt from the pin rather
    # than written out: the `INERT` branch's own paragraph with a criterion
    # statement in it, carrying three of the pin's stems. On the round-33
    # commit that plant, COMMITTED, gave rc 0 -- the branch was in no shape of
    # the union, so no arrival predicate ever saw the sentence, and the label
    # was six characters long, so the labelled arm did not see it either. Both
    # halves are measured here: the edited paragraph stops matching the
    # declared whole shape and is named by BOTH arms, while the live paragraph
    # -- the control, taken from THIS run and not imitated -- is named by
    # neither.
    inert = next((t for _w, t in said if t.startswith("INERT:")), None)
    if inert is None:                                          # pragma: no cover
        print("  union C34-S1 the INERT branch printed nothing -> "
              "**SELFTEST FAILED**")
        return False
    stems = _criterion_stems()[:3]
    plant = ("INERT: no line was found, and a figure here is legitimate when "
             "the " + " ".join(stems) + " of this run allowed it")
    for label, text, want in (
        ("the reviewer's plant: INERT stating the criterion", plant, True),
        ("the control: the live INERT paragraph itself", inert, False),
    ):
        one = [("the planted paragraph", text)]
        below_hit = bool(_printed_paragraphs_below_the_law(one))
        label_hit = bool(_labelled_printed_without_the_pin(one))
        good = below_hit is want and label_hit is want
        ok = ok and good
        print("  union C34-S1 %-50s %-40s -> %s"
              % (label,
                 "below the law %s, labelled %s"
                 % ("named" if below_hit else "not named",
                    "named" if label_hit else "not named"),
                 "as required" if good else "**SELFTEST FAILED**"))
    # `C35-F1`, and the plant is the COORDINATOR'S: the ENROLMENT check's own
    # `INERT` paragraph with a criterion statement in it. On `e3a2df4` that
    # plant, COMMITTED, gave rc 0 with zero arms red -- the branch was in no
    # shape of the union, so neither predicate was ever handed the sentence,
    # though both name it when they are. Measured here the same way as the
    # scan's: the edited paragraph stops matching the declared whole shape and
    # is named by BOTH, and the live paragraph -- taken from THIS run, not
    # imitated -- is named by neither.
    block = next((t for _w, t in said
                  if t.startswith("INERT: no generated block")), None)
    if block is None:                                          # pragma: no cover
        print("  union C35-F1 the enrolment INERT branch printed nothing -> "
              "**SELFTEST FAILED**")
        return False
    planted_block = ("INERT: no generated block was found, and a figure here "
                     "is legitimate when the " + " ".join(stems)
                     + " of this run allowed it")
    for label, text, want in (
        ("the coordinator's plant: block INERT stating the criterion",
         planted_block, True),
        ("the control: the live block INERT paragraph itself", block, False),
    ):
        one = [("the planted paragraph", text)]
        below_hit = bool(_printed_paragraphs_below_the_law(one))
        label_hit = bool(_labelled_printed_without_the_pin(one))
        good = below_hit is want and label_hit is want
        ok = ok and good
        print("  union C35-F1 %-50s %-40s -> %s"
              % (label,
                 "below the law %s, labelled %s"
                 % ("named" if below_hit else "not named",
                    "named" if label_hit else "not named"),
                 "as required" if good else "**SELFTEST FAILED**"))
    # And the floor itself, which was the other half of `C34-S1`: a label of
    # six characters is a label. The old pattern required seven.
    for label, good in (
        ("a six-character label is held", bool(re.match(LABELLED, "INERT: x"))),
        ("and a two-character one", bool(re.match(LABELLED, "AB: x"))),
        ("a lowercase opening is not a label",
         not re.match(LABELLED, "quoted figures: x")),
    ):
        ok = ok and good
        print("  union C34-S1 %-50s %-40s -> %s"
              % (label, "yes" if good else "NO",
                 "as required" if good else "**SELFTEST FAILED**"))
    # The census must be a property of the COMMIT, not of the command line
    # that ran it. Measured, because it was not: with no capture installed the
    # enrolment check says less, so this set counted 34 by hand and 36 under
    # the driver until `printed_block_sentences` pinned its own world's
    # capture. The arm runs the union twice, once each way.
    held = list(_RUN_CAPTURE)
    try:
        _RUN_CAPTURE[:] = [_world_capture("plain", _world_harness("plain"))]
        with_one = len(printed_paragraphs())
        _RUN_CAPTURE[:] = []
        with_none = len(printed_paragraphs())
    finally:
        _RUN_CAPTURE[:] = held
    good = with_one == with_none == len(printed)
    ok = ok and good
    print("  union C33-F1 %-50s %-40s -> %s"
          % ("the census does not depend on the command line",
             "%d with a capture, %d with none" % (with_one, with_none),
             "as required" if good else "**SELFTEST FAILED**"))
    # And the arm under the predicate, which is the coordinator's own attack
    # rebuilt: the `extra` branch's live paragraph with the appended pin taken
    # off, exactly as a helper that prints it would produce. If this does not
    # red, the predicate is decorative.
    # The live paragraph for the two arms below is the one `_finding` emitted,
    # which is the one carrying the appended tail. Taking "the first `extra`
    # paragraph" would, in a world where the attack is PRESENT, hand the
    # control the attack's own sentence and report a cascade as a second
    # failure.
    live = next((t for _w, t in said
                 if t.startswith("NOT IN THE HAYSTACK")
                 and FINDING_TAIL in t), None)
    if live is None:                                           # pragma: no cover
        print("  union C33-F1 the `extra` branch printed nothing -> "
              "**SELFTEST FAILED**")
        return False
    for label, planted, want in (
        ("the attack: the `extra` finding with no appended pin",
         live.replace(FINDING_TAIL, ""), True),
        ("the control: the same paragraph as `_finding` emits it",
         live, False),
    ):
        hit = bool(_labelled_printed_without_the_pin(
            [("the planted paragraph", planted)]))
        good = hit is want
        ok = ok and good
        print("  union C33-F1 %-50s %-40s -> %s"
              % (label, "named" if hit else "not named",
                 "as required" if good else "**SELFTEST FAILED**"))
    return ok


def capture_leak_arm():
    """`A-35-F2`: the census family leaves no generated body behind.

    Self-reported, measured on this round's own commit before any reviewer read
    it. `printed_block_sentences` installs a capture on purpose -- that is how
    its census stopped depending on the command line -- and a generator RUNS
    the arms, so `_block_body` and `_guard_rows` memoised what that run
    produced. `blocks_test` runs much later, with no capture installed, and
    read those memoised bodies: on `493d135` it refused `RUN-CAPTURE-ABSENT`
    and measured nothing, and with this family in front of it, it ran to
    completion. A census that makes a later VERDICT stop refusing is a
    fail-open, whichever direction the verdict then goes.

    Four lines, and the third is the one that would have caught it:

      1. the family leaves both caches exactly as it found them;
      2. a captureless enrolment check still REFUSES, by name, after the
         family has run, which is the behaviour the leak removed;
      3. and the same generator under the family's own capture DOES fill the
         cache, so the first line is not vacuous -- an arm that passes
         because nothing was generated measures nothing.
    """
    ok = True
    bodies, rows = dict(_BODIES), dict(_ROWS)
    held = list(_RUN_CAPTURE)
    try:
        _BODIES.clear()
        _ROWS.clear()
        printed_block_sentences()
        left = len(_BODIES) + len(_ROWS)
        # The behaviour the leak removed, asked straight after the family and
        # with no capture installed: the caches are as the line above measured
        # them, so a verdict that needs a generated body has to go and generate
        # one, and generating one needs a run to read.
        _RUN_CAPTURE[:] = []
        try:
            rc = _blocks_arm("")
            name = "NO REFUSAL, rc=%d" % rc
        except Refusal as why:
            name = str(why).split(":")[0]
        # The premise, last because it fills the cache on purpose: the same
        # generator, under the family's own capture, DOES fill it. Without this
        # line the first one passes in a world where nothing is generated at
        # all, which is the vacuity this pack forbids.
        _RUN_CAPTURE[:] = [_seat_capture("blocks", _subject_top(_harness_dir()))]
        _block_body(sorted(GENERATORS)[0])
        filled = len(_BODIES)
    finally:
        _RUN_CAPTURE[:] = held
        _BODIES.clear()
        _BODIES.update(bodies)
        _ROWS.clear()
        _ROWS.update(rows)
    for label, good, shown in (
        ("the census family leaves both caches as it found them",
         left == 0, "%d generated body/row(s) left behind" % left),
        ("a captureless verdict still refuses after it has run",
         name == "RUN-CAPTURE-ABSENT", name),
        ("and one generator does fill the cache, so that is not vacuous",
         filled > 0, "%d body cached by one generator" % filled),
    ):
        ok = ok and good
        print("  leak A-35-F2 %-50s %-40s -> %s"
              % (label, shown, "as required" if good else "**SELFTEST FAILED**"))
    return ok


def seat_sentence_arms():
    """`C32-S3`: the paragraphs the SEAT arms say, read by a law at last.

    A census, so it is pinned by LITERALS on both counts and an arrival reds
    as loudly as a departure. The bodies are NOT pinned, because two of these
    shapes carry a temporary directory's name; what is pinned is how many
    distinct shapes there are and which refusals they name.
    """
    ok = True
    printed = printed_seat_sentences()
    labels = finding_labels(printed)
    found = gate_sentences(printed, rule_statements_only=True)
    for label, good, said in (
        ("the live set reports nothing", not found, "%d finding(s)" % len(found)),
        ("the census of printed shapes", len(printed) == 6,
         "%d paragraph shape(s), want 6" % len(printed)),
        ("the census of names", labels == [
            "GIT-BARE-REPOSITORY", "GIT-NESTED-REPO", "GIT-TOPLEVEL-DISAGREES",
            "NOT REQUIRED BY ANY CASE"], ", ".join(labels) or "none"),
    ):
        ok = ok and good
        print("  seats C32-S3 %-35s %-44s -> %s"
              % (label, said, "as required" if good else "**SELFTEST FAILED**"))
    for why in found:
        print("    " + why)
    # The arm under the census: a seat refusal REWORDED to state the criterion
    # without the pin is refused now, where before round 33 nothing read it.
    planted = ("REFUSED: GIT-NESTED-REPO: two repositories contain the haystack, "
               "and the haystack here is whatever this gate happens to hold: no "
               "value case of this run asserted the figure.")
    names = [f.split(":")[0]
             for f in gate_sentences([("a planted seat refusal", planted)],
                                     rule_statements_only=True)]
    good = "GATE-SENTENCE-UNQUOTED" in names
    ok = ok and good
    print("  seats C32-S3 %-35s refused as %-26s -> %s"
          % ("a seat refusal that states the rule",
             names[0] if names else "NO REFUSAL",
             "as required" if good else "**SELFTEST FAILED**"))
    return ok


def gate_sentence_arms():
    """This gate's own printed sentence, provoked by RUNNING the refusal."""
    ok = True
    live = []
    try:
        _run_capture_text(None, "0" * 40, _harness_dir())
    except Refusal as why:
        live.append(("the RUN-CAPTURE-ABSENT refusal", str(why)))
    except Exception as why:                                   # pragma: no cover
        print("  sentences GATE-SENTENCE-NOT-REFUSED: %r -> **SELFTEST FAILED**" % why)
        return False
    # The coordinator's round-30 note on this law's reach: it enumerated every
    # `Refusal()` in this file -- twenty-three -- and found exactly TWO that
    # state what makes a figure legitimate. The other is
    # `FIGURE-SINK-HAS-NO-ROWS`, whose wording is the live rule, so it is
    # PROVOKED here too rather than read: a sink carrying this commit's own
    # `RUN_HEAD` and not one row.
    try:
        top = _subject_top(_harness_dir(), False)
        sha = _commit_of(top)
        with tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8"
        ) as fh:
            fh.write("RUN_HEAD : %s\n" % sha)
            empty = fh.name
        was = list(_RUN_CAPTURE)
        _RUN_CAPTURE[:] = [empty]
        try:
            haystack(_harness_dir())
        finally:
            _RUN_CAPTURE[:] = was
            os.unlink(empty)
    except Refusal as why:
        live.append(("the FIGURE-SINK-HAS-NO-ROWS refusal", str(why)))
    except Exception as why:                                   # pragma: no cover
        print("  sentences GATE-SINK-REFUSAL-NOT-PROVOKED: %r" % why)
    if not live:
        print(
            "  sentences GATE-SENTENCE-NOT-PROVOKED: a missing capture did not refuse, "
            "so there is no printed sentence to hold to the rule -> **SELFTEST FAILED**"
        )
        return False
    found = gate_sentences(live)
    good = not found
    ok = ok and good
    print(
        "  sentences C29-F1 the gate's own refusal quotes its own sentence: "
        "%d finding(s) -> %s"
        % (len(found), "as required" if good else "**SELFTEST FAILED**")
    )
    for why in found:
        print("    " + why)
    for label, planted, want in (
        (
            "round 26's wording back in the refusal",
            [("a planted refusal", "the haystack is %s" % RETIRED_SENTENCES[0])],
            "GATE-SENTENCE-RETIRED",
        ),
        (
            "a refusal in new words that drops the pin",
            [("a planted refusal", "the haystack is whatever this gate feels like")],
            "GATE-SENTENCE-UNQUOTED",
        ),
        (
            "the live refusal with the pin cut out",
            [("a planted refusal", live[0][1].replace(HAYSTACK_SENTENCE, "x", 1))],
            "GATE-SENTENCE-UNQUOTED",
        ),
    ):
        names = [f.split(":")[0] for f in gate_sentences(planted)]
        good = want in names
        ok = ok and good
        print(
            "  sentences C29-F1 %-38s refused as %-26s (want %s) -> %s"
            % (label, names[0] if names else "NO REFUSAL", want,
               "as required" if good else "**SELFTEST FAILED**")
        )
    return ok


def capture_names_test():
    """`R26-S6`: four capture refusals and three older ones, read BY NAME.

    An exit code of 5 says a run stopped; it does not say which law stopped it,
    and this phase has twice found a world that was fail-closed by another
    tool's error message rather than by the rule it was credited to. So each
    refusal here is printed with its own name and asserted on the name.

    The three at the end are the ones the coordinator named: the generator's
    frame gate, the module-attribute pin, and `SELF-READ-DIR-ABSENT`, which
    `R25-S3` declared UNMEASURED-at-runtime. The last is a UNIT arm and is
    written as one rather than dressed as a world: `_untracked` is called with
    a repository that holds no `prep/phase11`, which is the state the refusal
    is about, and the name it returns is read.
    """
    ok = True
    for kind, want in (
        ("nocapture", "RUN-CAPTURE-ABSENT"),
        ("capture-inside", "RUN-CAPTURE-INSIDE-THE-SUBJECT"),
        ("capture-otherhead", "RUN-CAPTURE-NOT-THIS-HEAD"),
        ("capture-empty", "RUN-CAPTURE-EMPTY"),
    ):
        harness = _world_harness(kind)
        capture = _world_capture(kind, harness)
        held = list(_RUN_CAPTURE)
        _RUN_CAPTURE[:] = [capture] if capture else []
        try:
            haystack(harness)
            name = "NO REFUSAL"
        except Refusal as why:
            name = str(why).split(":")[0]
        finally:
            _RUN_CAPTURE[:] = held
        good = name == want
        ok = ok and good
        print(
            "  capture R26-S1 %-18s refuses as %-31s (want %s) -> %s"
            % (kind, name, want, "as required" if good else "**SELFTEST FAILED**")
        )
    # The generator's frame gate, by name and not by rc.
    saved = list(_FRAME_PARSED)
    try:
        _FRAME_PARSED[:] = [("a refusal planted for this arm only",)]
        why = _generation_refused()
    finally:
        _FRAME_PARSED[:] = saved
    name = (why or "NO REFUSAL").split(":")[0]
    good = name == "GENERATION-FRAME-INADMISSIBLE"
    ok = ok and good
    print(
        "  capture R26-S6 the generator refuses as %-31s (want "
        "GENERATION-FRAME-INADMISSIBLE) -> %s"
        % (name, "as required" if good else "**SELFTEST FAILED**")
    )
    # `SELF-READ-DIR-ABSENT`, measured at last: a repository that holds no
    # `prep/phase11` at all.
    d = tempfile.mkdtemp(prefix="p11-readdir-")
    atexit.register(shutil.rmtree, d, True)
    os.makedirs(os.path.join(d, "infrastructure", "database", "migrations"))
    _write(d, "keep.txt", "a repository with no phase directory\n")
    _git(d, ["init", "-q"])
    _git(d, ["add", "-A", "--", "."])
    _git(
        d,
        ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
         "commit", "-q", "--no-gpg-sign", "-m", "read-dir world"],
    )
    msgs = _untracked(d)
    name = (msgs[0] if msgs else "NO REFUSAL").split(":")[0]
    good = name == "SELF-READ-DIR-ABSENT"
    ok = ok and good
    print(
        "  capture R25-S3 an absent read directory refuses as %-24s (want "
        "SELF-READ-DIR-ABSENT) -> %s"
        % (name, "as required" if good else "**SELFTEST FAILED**")
    )
    return ok


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
            held = list(_RUN_CAPTURE)
            _RUN_CAPTURE[:] = [_seat_capture("anchor-bare", root)]
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
                _RUN_CAPTURE[:] = held
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


def _reader_name(harness_dir, rename=None):
    """The refusal NAME the SECOND reader prints, run from `harness_dir`.

    `rename` renames one refusal's own literal in the copy that is run, which
    is the control that makes this arm read the NAME and not the exit code: the
    same world refuses for the same reason either way, and only an arm reading
    the name can tell the two apart.
    """
    src = os.path.join(_harness_dir(), "check_harness_bytes.py")
    with open(src, "rb") as fh:
        text = fh.read()
    if rename is not None:
        assert text.count(rename.encode("ascii")) >= 1
        text = text.replace(rename.encode("ascii"), rename.encode("ascii") + b"-RENAMED")
    dst = os.path.join(harness_dir, "check_harness_bytes.py")
    with open(dst, "wb") as fh:
        fh.write(text)
    out = subprocess.run(
        [sys.executable, "-I", dst],
        cwd=harness_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    said = out.stdout.decode("utf-8", "replace")
    found = re.search(r"(HARNESS-[A-Z-]+):", said)
    return out.returncode, (found.group(1) if found else "NO REFUSAL")


def reader_census_arms():
    """`R23-S1`: the SECOND reader's own census refusals, read by NAME.

    The round's finding: the reader grew a census of its own at `78f9392` --
    three refusals that decide which commit its bytes are read against -- and
    no arm read any of their names, so renaming each one on a committed copy
    left `--selftest` at rc 0. A refusal nothing reads by name is a refusal
    whose deletion nothing measures.

    Two of the three have a world, and both are built here rather than
    described: a `.git` inside the harness, which is the second site of
    `HARNESS-NESTED-REPO`, and a `.git` FILE whose gitdir carries
    `core.worktree`, which is the shape `R20-S2` found for the checker's own
    census and which the reader answers with `HARNESS-TOPLEVEL-DISAGREES`.

    `HARNESS-HEAD-DISAGREES` has no world here and is NOT armed: both reads
    resolve `HEAD` through the same repository, and every construction I could
    build where they differ -- a linked worktree, a `.git` file -- is refused
    earlier by the census for a different reason, so the arm would measure that
    earlier refusal. It stays a named residual, UNMEASURED-at-runtime, which is
    what `R20-S2` asked for in the same position and is not the same sentence
    as "armed".
    """
    ok = True
    worlds = []

    def _plant_nested(copy):
        inner = os.path.join(copy, "sub", ".git")
        os.makedirs(inner)
        with open(os.path.join(inner, "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("ref: refs/heads/master\n")

    _world, copy = _deciding_copy("p11-readercensus-", after=_plant_nested)
    worlds.append(("a `.git` inside the harness", copy, "HARNESS-NESTED-REPO"))
    _subject, gitfile_harness = _gitfile_world()
    worlds.append(
        (
            "a `.git` FILE whose gitdir carries `core.worktree`",
            gitfile_harness,
            "HARNESS-TOPLEVEL-DISAGREES",
        )
    )
    for label, where, want in worlds:
        rc, live = _reader_name(where)
        rc_renamed, renamed = _reader_name(where, rename=want)
        good = rc == 5 and live == want and renamed == want + "-RENAMED"
        ok = ok and good
        print(
            "  reader R23-S1 %-48s refuses as %s (rc=%d), and with the name renamed as "
            "%s -> %s"
            % (label, live, rc, renamed, "as required" if good else "**SELFTEST FAILED**")
        )
    return ok


def harness_bytes_arm():
    """The byte law read by the SECOND reader, armed on copies, by name.

    `self_bytes_committed` reads this law with this file's own code; the second
    reader reads it with code this file does not share. Both directions are
    measured on COPIES and never on the subject: a red proof does not edit the
    instrument the whole run is read through, and these files are that
    instrument.

    One copy of the harness carries the review's own escape -- a default
    argument that switches a named guard off for every real run -- committed
    NOWHERE, which is the shape the law is about. One copy of the READER has its
    comparison deleted, which is the single edit that would let every byte move
    unnoticed. The arm reads the REFUSAL NAME, because round 21 showed an exit
    code and a digest comparison to be worth nothing as a measurement.
    """
    here = os.path.dirname(os.path.realpath(__file__))
    reader = os.path.join(here, "check_harness_bytes.py")
    subject = os.path.basename(os.path.realpath(__file__))
    ok = True
    world = tempfile.mkdtemp(prefix="p11-bytearm-")
    atexit.register(shutil.rmtree, world, True)
    copy = os.path.join(world, "prep", "phase11", "harness")
    os.makedirs(os.path.dirname(copy))
    shutil.copytree(here, copy)
    _git(world, ["init", "-q"])
    _git(world, ["add", "-A", "--", "."])
    _git(
        world,
        ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
         "commit", "-q", "--no-gpg-sign", "-m", "a copy of the harness, committed"],
    )
    # The control: the copy as committed. If this reds, every arm below is
    # measuring the copy rather than the plant.
    clean = subprocess.run(
        [sys.executable, "-I", reader, "--harness", copy],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180,
    )
    good = clean.returncode == 0
    ok = ok and good
    print(
        "  bytes  control: a committed copy of the harness, read by the second reader: "
        "rc=%d -> %s" % (clean.returncode, "as required" if good else "**SELFTEST FAILED**")
    )
    target = os.path.join(copy, subject)
    with open(target, "r", encoding="utf-8") as fh:
        was = fh.read()
    tail = '\n    """0 = every quoted figure is emitted.'
    original = "def scan(docs_dir, harness_dir, quiet=False, skip=()):" + tail
    planted = (
        'def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):' + tail
    )
    if was.count(original) != 1:
        print(
            "  bytes  C21-F1 **SELFTEST FAILED**: the line this arm plants into a copy is "
            "not in the subject exactly once, so the arm is measuring nothing"
        )
        return False
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(was.replace(original, planted, 1))
    got = subprocess.run(
        [sys.executable, "-I", reader, "--harness", copy],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180,
    )
    lines = [
        l.split("REFUSED: ", 1)[1] for l in got.stdout.splitlines()
        if l.startswith("REFUSED: ")
    ]
    names = sorted({l.split(":")[0] for l in lines})
    named_the_file = any(("`%s" % "prep/phase11/harness/" + subject) in l for l in lines)
    good = (
        "HARNESS-BYTES-UNCOMMITTED" in names and named_the_file and got.returncode == 5
    )
    ok = ok and good
    print(
        "  bytes  C21-F1 the review's own `skip=` default, on disk in the copy and in no "
        "commit: refused as %s naming %s, rc=%d -> %s"
        % (
            ", ".join(names) or "NOTHING",
            subject if named_the_file else "no file",
            got.returncode,
            "as required" if good else "**SELFTEST FAILED**",
        )
    )
    # The deletion control: the comparison removed from a COPY of the reader,
    # which lives outside the harness copy so that its own blob is not what
    # reds.
    broken = os.path.join(world, "reader_with_the_law_deleted.py")
    with open(reader, "r", encoding="utf-8") as fh:
        rtext = fh.read()
    cmp_line = "        if hashlib.sha256(disk).hexdigest() != hashlib.sha256(blob).hexdigest():"
    if rtext.count(cmp_line) != 1:
        print(
            "  bytes  R21-F1 **SELFTEST FAILED**: the comparison this control deletes is "
            "not in the second reader exactly once"
        )
        return False
    with open(broken, "w", encoding="utf-8") as fh:
        fh.write(rtext.replace(cmp_line, "        if False:", 1))
    got = subprocess.run(
        [sys.executable, "-I", broken, "--harness", copy],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180,
    )
    named = sorted({
        l.split("REFUSED: ", 1)[1].split(":")[0]
        for l in got.stdout.splitlines() if l.startswith("REFUSED: ")
    })
    # BY NAME, and the clean-tree law is expected to stand: deleting the byte
    # comparison must take `HARNESS-BYTES-UNCOMMITTED` away, and it must not
    # take away `HARNESS-TREE-DIRTY`, which is a different law about the same
    # world. A control that demanded silence here would be asserting that one
    # deletion disables both, which is the opposite of what is wanted.
    good = "HARNESS-BYTES-UNCOMMITTED" not in named and named == ["HARNESS-TREE-DIRTY"]
    ok = ok and good
    print(
        "  bytes  R21-F1 the same copy read by a reader with the comparison DELETED: "
        "rc=%d and it named %s -> %s"
        % (
            got.returncode,
            ", ".join(named) or "nothing",
            "as required" if good else "**SELFTEST FAILED**",
        )
    )
    return ok



def _deciding_copy(prefix, mutate=None, exclude=(), after=None):
    """A scratch repository holding a copy of the harness's DECIDING files.

    Only the deciding files, because they are the whole subject of the byte law
    and copying the evidence transcripts beside them costs seconds per arm for
    nothing. `mutate` runs BEFORE the commit, so it changes what the COMMIT
    holds; `exclude` is committed-without; `after` runs after the commit, so it
    changes what the WORKING TREE holds. The difference between the two is the
    law.
    """
    here = _harness_dir()
    world = tempfile.mkdtemp(prefix=prefix)
    atexit.register(shutil.rmtree, world, True)
    copy = os.path.join(world, "prep", "phase11", "harness")
    os.makedirs(copy)
    for rel in _deciding_files(here):
        dst = os.path.join(copy, rel)
        if not os.path.isdir(os.path.dirname(dst)):
            os.makedirs(os.path.dirname(dst))
        shutil.copy2(os.path.join(here, rel), dst)
    # `untracked-paths` (the coordinator's `F1`) refuses an absent read
    # directory rather than walking nothing, so an arm world is a repository
    # that HAS one: a single committed migration, which every arm world then
    # shares and which the untracked arm plants beside.
    migrations = os.path.join(world, "infrastructure", "database", "migrations")
    os.makedirs(migrations)
    with open(os.path.join(migrations, "0001_arm_world.sql"), "w", encoding="utf-8") as fh:
        fh.write("-- the arm world's own migration, so the directory the run reads exists\n")
    if mutate is not None:
        mutate(copy)
    _git(world, ["init", "-q"])
    _git(world, ["add", "-A", "--", "."])
    for rel in exclude:
        _git(world, ["rm", "--cached", "-q", "--", "prep/phase11/harness/" + rel])
    _git(
        world,
        ["-c", "user.name=phase11", "-c", "user.email=phase11@example.invalid",
         "commit", "-q", "--no-gpg-sign", "-m", "a copy of the harness's deciding files"],
    )
    if after is not None:
        after(copy)
    return world, copy


def _live_names(copy, keys):
    """The refusal NAMES the LIVE consultation produces with the harness bound
    to `copy` and exactly `keys` consulted.

    The binding is the identity arms' technique -- they rebind `re.fullmatch`
    in this process and read what the frame says -- applied to the directory
    the law reads. That is what makes this a control on THIS RUN: round 22
    found `self-bytes` and `harness-bytes` unarmed precisely because every arm
    ran the instruments on a copy, in another directory, and nothing measured
    that the run consults them.
    """
    real = globals()["_harness_dir"]
    committed, parsed = list(_COMMITTED), list(_FRAME_PARSED)
    ast_cache = dict(_COMMITTED_AST)
    try:
        globals()["_harness_dir"] = lambda: copy
        _COMMITTED[:] = []
        _COMMITTED_AST.clear()
        _FRAME_PARSED[:] = []
        try:
            _ok, msgs = frame_admissible(objects=keys)
        except Refusal as why:
            msgs = (str(why),)
        _FRAME_PARSED[:] = []
        try:
            scanned = _arm(PROBE, ())
        except Refusal:
            # The rc a reader gets: `_main` maps a refusal raised out of the
            # scan to 5. Caught here so one bound world cannot end the selftest
            # with a traceback instead of a verdict.
            scanned = 5
    finally:
        globals()["_harness_dir"] = real
        _COMMITTED[:] = committed
        _COMMITTED_AST.clear()
        _COMMITTED_AST.update(ast_cache)
        _FRAME_PARSED[:] = parsed
    return sorted({m.split(":")[0] for m in msgs}), scanned


def live_byte_keys_arm():
    """`R22-F1(b)`: the two byte keys, DELETED FROM THE LIVE CONSULTATION.

    The round-22 finding, in the challenger's words: of the four object checks,
    two had a key-deletion arm and `self-bytes` and `harness-bytes` -- the two
    that carry this law entirely -- had none. Deleting either from
    `_frame_refusals` and committing the deletion red nothing, because the
    three byte arms exercise the instruments on a COPY and `an arm on a copy of
    the instrument is not a control on the run`.

    So the deletion is applied HERE, to the call this process makes, with the
    harness bound to a prepared world: one deciding file drifted on disk after
    the commit, which is the shape the law is about. With both keys consulted
    the run must name both refusals; with one key deleted THAT NAME must be
    gone and the other must remain. The scan is run in the same bound world,
    so what is measured is the verdict a reader would get and not a return
    value.

    Four more names ride this arm, each a round-22 residual (`R22-S1`) that no
    arm read by name: the second reader DELETED (`HARNESS-BYTES-READER-ABSENT`,
    whose own text says absence is a refusal and not a skip), a committed
    deciding file missing from the tree (`SELF-FILE-ABSENT`), and the two sites
    of `FRAME-SOURCE-NOT-IN-COMMIT` -- this file absent from the commit
    entirely, and a commit whose copy of this file defines no function under
    the name that is running.
    """
    ok = True
    drift = "\n# a line this arm appends AFTER the commit, so the tree drifts\n"

    def _drift(copy):
        with open(os.path.join(copy, "proofs.py"), "a", encoding="utf-8") as fh:
            fh.write(drift)

    _world, copy = _deciding_copy("p11-livekeys-", after=_drift)
    both, scanned = _live_names(copy, frozenset(OBJECT_KEYS))
    want_self, want_harness = "SELF-BYTES-UNCOMMITTED", "HARNESS-BYTES-UNCOMMITTED"
    good = want_self in both and want_harness in both and scanned == 5
    ok = ok and good
    print(
        "  live   both byte keys consulted, one deciding file drifted after the commit: "
        "the run named %s and the scan rc=%d -> %s"
        % (", ".join(both) or "NOTHING", scanned, "as required" if good else "**SELFTEST FAILED**")
    )
    for key, gone, stays in (
        ("self-bytes", want_self, want_harness),
        ("harness-bytes", want_harness, want_self),
    ):
        names, _rc = _live_names(copy, frozenset(OBJECT_KEYS) - {key})
        good = gone not in names and stays in names
        ok = ok and good
        print(
            "  live   `%s` DELETED from the live consultation: %s is %s and %s %s -> %s"
            % (
                key,
                gone,
                "gone" if gone not in names else "STILL THERE",
                stays,
                "remains" if stays in names else "IS ALSO GONE",
                "as required" if good else "**SELFTEST FAILED**",
            )
        )

    # `R22-S1`, first and second names: the reader deleted from the tree. One
    # world measures both, because a deleted deciding file is absent to this
    # file's own reader and the second reader is the file that is gone.
    def _unlink_reader(copy):
        os.unlink(os.path.join(copy, "check_harness_bytes.py"))

    _world, gone_copy = _deciding_copy("p11-readergone-", after=_unlink_reader)
    names, scanned = _live_names(gone_copy, frozenset(OBJECT_KEYS))
    good = (
        "HARNESS-BYTES-READER-ABSENT" in names
        and "SELF-FILE-ABSENT" in names
        and scanned == 5
    )
    ok = ok and good
    print(
        "  live   R22-S1 the second reader DELETED from the tree: the run named %s and "
        "the scan rc=%d -> %s"
        % (", ".join(names) or "NOTHING", scanned, "as required" if good else "**SELFTEST FAILED**")
    )

    # `R22-S1`, third name, site one: this file is on disk and in no commit, so
    # there are no committed bytes to parse the rules out of.
    subject = os.path.basename(os.path.realpath(__file__))
    _world, no_subject = _deciding_copy("p11-nosubject-", exclude=(subject,))
    names, scanned = _live_names(no_subject, frozenset(OBJECT_KEYS))
    good = "FRAME-SOURCE-NOT-IN-COMMIT" in names and scanned == 5
    ok = ok and good
    print(
        "  live   R22-S1 this file committed NOWHERE in the bound world: the run named "
        "%s and the scan rc=%d -> %s"
        % (", ".join(names) or "NOTHING", scanned, "as required" if good else "**SELFTEST FAILED**")
    )

    # `R22-S1`, third name, site two: the commit holds this file and its copy
    # defines no function under the name that is running. The rename is
    # committed and then undone on disk, so what differs is the COMMIT.
    # Assembled rather than written, so this line is not itself an occurrence of
    # what it counts -- which is how the first version of this control failed.
    marker = "def " + '_is_figure(s, skip=()):\n    """Is `s` a bare '
    real_text = open(os.path.realpath(__file__), encoding="utf-8").read()
    if real_text.count(marker) != 1:
        print(
            "  live   R22-S1 **SELFTEST FAILED**: the definition this control renames is "
            "not in this file exactly once, so the arm would measure nothing"
        )
        return False

    def _rename(copy):
        target = os.path.join(copy, subject)
        text = open(target, encoding="utf-8").read()
        # The NAME is renamed and the rest of the anchor put back, because a
        # replacement that swallowed the docstring's opening quotes left the
        # committed copy unparseable: the run then refused
        # `FRAME-SOURCE-UNREADABLE` for a syntax error, which is a different
        # claim, and the arm was measuring the wrong refusal.
        open(target, "w", encoding="utf-8").write(
            text.replace(
                marker,
                marker.replace(
                    "def " + "_is_figure(", "def _is_figure_not_under_this_name(", 1
                ),
                1,
            )
        )

    def _restore(copy):
        open(os.path.join(copy, subject), "w", encoding="utf-8").write(real_text)

    _world, renamed = _deciding_copy("p11-renamed-", mutate=_rename, after=_restore)
    names, scanned = _live_names(renamed, frozenset(OBJECT_KEYS))
    good = "FRAME-SOURCE-NOT-IN-COMMIT" in names and scanned == 5
    ok = ok and good
    print(
        "  live   R22-S1 the commit's copy defines no `_is_figure`: the run named %s and "
        "the scan rc=%d -> %s"
        % (", ".join(names) or "NOTHING", scanned, "as required" if good else "**SELFTEST FAILED**")
    )
    return ok


def _reader_run(program, copy, extra=(), want_stdout=False):
    """(refusal names, rc[, stdout]) from running one reader over one world.

    `--tree-state` prints its verdict on stdout and its reasons on stderr, so
    the two streams are kept apart here; every other invocation only needs the
    names and the rc.
    """
    got = subprocess.run(
        [sys.executable, "-I", program] + list(extra) + ["--harness", copy],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
    )
    names = sorted(
        {
            line.split("REFUSED: ", 1)[1].split(":")[0]
            for line in (got.stdout + "\n" + got.stderr).splitlines()
            if line.startswith("REFUSED: ")
        }
    )
    if want_stdout:
        return names, got.returncode, got.stdout
    return names, got.returncode


def tree_law_arm():
    """`R23`: the clean-tree and index-flag laws, deleted by key, read by name.

    Round 23's finding about my own arms: no arm read `SELF-TREE-DIRTY` by
    name, and deleting the checker's half -- one line, committed on a copy --
    red nothing, so the law that answers the coordinator's `F1` was itself
    unarmed. The law is a KEY now, and each world below is one the law exists
    for, with the deletion applied to the LIVE consultation:

      1. a DOCUMENT drifted after the commit, which the byte law does not cover
         and which is where the figures are;
      2. the same drift hidden behind `git update-index --assume-unchanged`,
         which is what defeated the previous version in all three places at
         once -- `git status --porcelain` is a statement about the INDEX;
      3. an executable bit the commit does not carry, which `core.fileMode`
         can hide from git and which the disk's own bits cannot hide;
      4. a committed document DELETED from the tree, because a sparse checkout
         leaves `status` clean while files are missing.

    Each is read by refusal NAME, with the key deleted beside it, and the scan
    is run in the same bound world so what is measured is the verdict.
    """
    ok = True
    doc_rel = os.path.join("..", "P11-ARM-DOCUMENT.md")
    fab = "arm_fabricated_rows=4242\n"

    def _write_doc(copy):
        with open(os.path.join(copy, doc_rel), "w", encoding="utf-8") as fh:
            fh.write("a document this arm commits\n")

    def _drift_doc(copy):
        with open(os.path.join(copy, doc_rel), "a", encoding="utf-8") as fh:
            fh.write(fab)

    def _flag_doc(copy):
        _drift_doc(copy)
        # The path is relative to the directory the read runs in, which is the
        # harness copy, not the repository top: a path spelled from the top
        # makes git refuse with 128 and the arm measures the refusal instead
        # of the law.
        _git(copy, ["update-index", "--assume-unchanged", "--", doc_rel])

    def _chmod_doc(copy):
        target = os.path.join(copy, doc_rel)
        os.chmod(target, os.stat(target).st_mode | 0o111)

    def _unlink_doc(copy):
        os.unlink(os.path.join(copy, doc_rel))

    def _plant_sql(copy):
        # THE COORDINATOR'S `F1`: an UNTRACKED `.sql` beside the frozen
        # migrations, which `run_migrations.py` applies because it lists the
        # DIRECTORY. The arm world carries one committed migration, so this is
        # exactly the attack: a second file the commit does not hold.
        top = os.path.dirname(os.path.dirname(os.path.dirname(copy)))
        target = os.path.join(
            top, "infrastructure", "database", "migrations", "0002z_arm_plant.sql"
        )
        with open(target, "w", encoding="utf-8") as fh:
            fh.write("CREATE TABLE public.p11_arm_plant(x int);\n")

    for label, after, want, key in (
        ("a committed DOCUMENT drifted on disk", _drift_doc, "SELF-TREE-DIRTY", "clean-tree"),
        ("an executable bit the commit does not carry", _chmod_doc, "SELF-TREE-DIRTY", "clean-tree"),
        ("a committed document DELETED from the tree", _unlink_doc, "SELF-TREE-DIRTY", "clean-tree"),
        ("the same drift behind --assume-unchanged", _flag_doc, "SELF-INDEX-FLAGGED", "index-flags"),
        # The coordinator's `F1` world, this head's blocker.
        ("an UNTRACKED migration the run would apply", _plant_sql, "SELF-TREE-UNTRACKED", "untracked-paths"),
    ):
        _world, copy = _deciding_copy("p11-treearm-", mutate=_write_doc, after=after)
        names, scanned = _live_names(copy, frozenset(OBJECT_KEYS))
        deleted, deleted_rc = _live_names(copy, frozenset(OBJECT_KEYS) - {key})
        # THE COORDINATOR'S `F4`, first weakness: every one of these arms passed
        # an explicit key set, so `objects=None` -- which is what a real run
        # consults -- was covered by nothing. The same world is read again the
        # way the run reads it.
        real, real_rc = _live_names(copy, None)
        good = (
            want in names
            and scanned == 5
            and want not in deleted
            and want in real
            and real_rc == 5
        )
        ok = ok and good
        print(
            "  tree   R23 %s: the run named %s and the scan rc=%d; with `%s` DELETED %s "
            "and the scan rc=%d; as the REAL run reads it (objects=None) %s, rc=%d -> %s"
            % (
                label,
                ", ".join(names) or "NOTHING",
                scanned,
                key,
                "that name is gone" if want not in deleted else "IT STILL REDS",
                deleted_rc,
                "it names it too" if want in real else "IT IS NOT NAMED",
                real_rc,
                "as required" if good else "**SELFTEST FAILED**",
            )
        )
    # THE COORDINATOR'S `F4`, `D11`: forcing `_GENERATING` true makes
    # `_objects_enabled` drop both tree laws in a REAL run, and no arm read
    # that. The suspension is deleted here the way the keyed arms delete a
    # key -- in the live consultation -- and the name the key owns must go.
    _world, copy = _deciding_copy("p11-genarm-", mutate=_write_doc, after=_drift_doc)
    names, scanned = _live_names(copy, None)
    _GENERATING.append(True)
    try:
        forced, forced_rc = _live_names(copy, None)
    finally:
        _GENERATING.pop()
    good = (
        "SELF-TREE-DIRTY" in names
        and scanned == 5
        and "SELF-TREE-DIRTY" not in forced
    )
    ok = ok and good
    print(
        "  tree   C-F4 D11 the generation suspension forced on in a real run: the run "
        "named %s and the scan rc=%d; forced, %s and the scan rc=%d (the second reader "
        "still refuses, which is the backstop the coordinator measured) -> %s"
        % (
            ", ".join(names) or "NOTHING",
            scanned,
            "SELF-TREE-DIRTY is gone" if "SELF-TREE-DIRTY" not in forced else "IT STILL REDS",
            forced_rc,
            "as required" if good else "**SELFTEST FAILED**",
        )
    )
    # THE COORDINATOR'S `F4`, `D6`/`D7`/`D8` and the untracked law's own half:
    # four single-line deletions inside the SECOND READER that kept the
    # selftest green. The reader is a separate program, so each deletion is
    # applied by value to a COPY of it that lives outside the harness copy, and
    # the arm reads the refusal NAME in each direction.
    reader = os.path.join(_harness_dir(), "check_harness_bytes.py")
    with open(reader, "r", encoding="utf-8") as fh:
        rtext = fh.read()
    for label, old, new, want, after in (
        (
            "D6 the reader's index-flag detection",
            '        if tag == "S" or tag.islower():',
            "        if False:",
            "HARNESS-INDEX-FLAGGED",
            _flag_doc,
        ),
        (
            "D7 the reader's mode check",
            '            if executable != (mode == "100755"):',
            "            if False:",
            "HARNESS-TREE-DIRTY",
            _chmod_doc,
        ),
        (
            "D8 the reader's missing-file arm",
            "    count = len(moved) + len(gone) + len(modes)",
            "    count = len(moved) + len(modes)",
            "HARNESS-TREE-DIRTY",
            _unlink_doc,
        ),
    ):
        if rtext.count(old) != 1:
            print(
                "  tree   C-F4 **SELFTEST FAILED**: the line `%s` deletes is not in the "
                "second reader exactly once" % label
            )
            ok = False
            continue
        _world, copy = _deciding_copy("p11-readerarm-", mutate=_write_doc, after=after)
        cut_path = os.path.join(
            os.path.dirname(copy), "reader_with_%s_deleted.py" % label.split()[0]
        )
        with open(cut_path, "w", encoding="utf-8") as fh:
            fh.write(rtext.replace(old, new, 1))
        got = _reader_run(reader, copy)
        lost = _reader_run(cut_path, copy)
        good = (
            want in got[0] and got[1] == 5 and want not in lost[0]
        )
        ok = ok and good
        print(
            "  tree   C-F4 %s: the reader named %s and rc=%d; with it DELETED %s and "
            "rc=%d -> %s"
            % (
                label,
                ", ".join(got[0]) or "NOTHING",
                got[1],
                "that name is gone" if want not in lost[0] else "IT STILL REDS",
                lost[1],
                "as required" if good else "**SELFTEST FAILED**",
            )
        )
    # The untracked law's own half in the second reader, which is asked through
    # `--tree-state` rather than through `check()`: the byte law answers about
    # the harness's deciding bytes and is run over worlds that hold a harness
    # and no repository around it, where an absent read directory is true and
    # means nothing.
    old = "    extra = []\n    for rel_dir in READ_DIRS:"
    if rtext.count(old) != 1:
        print(
            "  tree   C-F1 **SELFTEST FAILED**: the line this control deletes is not in "
            "the second reader exactly once"
        )
        ok = False
    else:
        _world, copy = _deciding_copy("p11-untrackarm-", mutate=_write_doc, after=_plant_sql)
        cut_path = os.path.join(os.path.dirname(copy), "reader_with_the_untracked_law_deleted.py")
        with open(cut_path, "w", encoding="utf-8") as fh:
            fh.write(rtext.replace(old, "    extra = []\n    for rel_dir in ():", 1))
        got = _reader_run(reader, copy, ("--tree-state",), True)
        lost = _reader_run(cut_path, copy, ("--tree-state",), True)
        good = (
            "HARNESS-TREE-UNTRACKED" in got[0]
            and got[1] == 5
            and got[2].strip() == "YES"
            and "HARNESS-TREE-UNTRACKED" not in lost[0]
            and lost[1] == 0
            and lost[2].strip() == "no"
        )
        ok = ok and good
        print(
            "  tree   C-F1 the reader's untracked law, through --tree-state: an untracked "
            "migration gave %r rc=%d naming %s; with the walk DELETED %r rc=%d -> %s"
            % (
                got[2].strip(),
                got[1],
                ", ".join(got[0]) or "NOTHING",
                lost[2].strip(),
                lost[1],
                "as required" if good else "**SELFTEST FAILED**",
            )
        )
    # THE COORDINATOR'S `F4`, second weakness: "the reader's `--tree-state`
    # path has no arm at all". It is the path the SHELL asks for the figure it
    # prints, so a hole there is a hole in `SOURCE_TREE_DIRTY`.
    _world, copy = _deciding_copy("p11-statearm-", mutate=_write_doc, after=_drift_doc)
    clean_world, clean_copy = _deciding_copy("p11-statearm-clean-", mutate=_write_doc)
    dirty_names, dirty_rc, dirty_out = _reader_run(reader, copy, ("--tree-state",), True)
    clean_names, clean_rc, clean_out = _reader_run(reader, clean_copy, ("--tree-state",), True)
    good = (
        "HARNESS-TREE-DIRTY" in dirty_names
        and dirty_rc == 5
        and dirty_out.strip() == "YES"
        and clean_rc == 0
        and clean_out.strip() == "no"
    )
    ok = ok and good
    print(
        "  tree   C-F4 the reader's --tree-state path: a drifted tree printed %r rc=%d "
        "naming %s, a clean one printed %r rc=%d -> %s"
        % (
            dirty_out.strip(),
            dirty_rc,
            ", ".join(dirty_names) or "NOTHING",
            clean_out.strip(),
            clean_rc,
            "as required" if good else "**SELFTEST FAILED**",
        )
    )
    # The second reader's own half, deleted by value in a COPY of the reader
    # that lives outside the harness copy, so what reds is the law and not the
    # reader's own blob. The reader is a separate program: its deletion control
    # cannot be a key in this process.
    _world, copy = _deciding_copy("p11-treearm-reader-", mutate=_write_doc, after=_drift_doc)
    reader = os.path.join(_harness_dir(), "check_harness_bytes.py")
    with open(reader, "r", encoding="utf-8") as fh:
        rtext = fh.read()
    cut = "    dirty = tuple(_tree_dirty(top)) + tuple(_index_flagged(top))"
    if rtext.count(cut) != 1:
        print(
            "  tree   R23 **SELFTEST FAILED**: the line this control deletes is not in "
            "the second reader exactly once"
        )
        return False
    broken = os.path.join(os.path.dirname(copy), "reader_with_the_tree_law_deleted.py")
    with open(broken, "w", encoding="utf-8") as fh:
        fh.write(rtext.replace(cut, "    dirty = ()", 1))
    with_law = subprocess.run(
        [sys.executable, "-I", reader, "--harness", copy],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180,
    )
    without = subprocess.run(
        [sys.executable, "-I", broken, "--harness", copy],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180,
    )
    def _names(out):
        return sorted({
            l.split("REFUSED: ", 1)[1].split(":")[0]
            for l in out.splitlines() if l.startswith("REFUSED: ")
        })
    had, lost = _names(with_law.stdout), _names(without.stdout)
    good = (
        "HARNESS-TREE-DIRTY" in had
        and with_law.returncode == 5
        and "HARNESS-TREE-DIRTY" not in lost
        and without.returncode == 0
    )
    ok = ok and good
    print(
        "  tree   R23 the second reader on the same world: named %s rc=%d; with its own "
        "tree law DELETED it named %s rc=%d -> %s"
        % (
            ", ".join(had) or "NOTHING",
            with_law.returncode,
            ", ".join(lost) or "nothing",
            without.returncode,
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
    # A DIRTY TREE STOPS HERE, BY NAME, and not as 93 failing arms.
    #
    # `R23-F2` widened the tree law from the deciding files to every committed
    # path, which is what closes the escape -- and it also means that an author
    # with one document open has a tree the law refuses. Most arms call `scan`,
    # so the frame is consulted inside them and each one returns 5 against a
    # `want` of 0, 1 or 2: the run reds correctly and reports the cause as
    # ninety-odd unrelated arm failures, which is a reader's time spent on a
    # diagnosis the instrument already has.
    #
    # The verdict does not change -- a selftest run from a tree that is not the
    # committed tree is not evidence either -- only what it says. The clean
    # clone is how this phase measures anything (and the project's own ruling
    # of 2026-10-19): commit the candidate tree into a scratch clone, run the
    # gates there, write the outputs outside it.
    admissible, why = frame_admissible()
    if not admissible:
        print(
            "  THE TREE IS NOT THE COMMITTED TREE: the arms are NOT run. %s"
            % " ".join(why)
        )
        return 5
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
    ok = capture_names_test() and ok
    ok = driver_sentence_arms() and ok
    ok = sentence_reading_arms() and ok
    ok = gate_sentence_arms() and ok
    ok = finding_sentence_arms() and ok
    ok = seat_sentence_arms() and ok
    ok = union_sentence_arms() and ok
    ok = capture_leak_arm() and ok
    ok = emission_site_census() and ok
    ok = criterion_selector_arms(printed_paragraphs()) and ok
    ok = finding_construction_test() and ok
    ok = guard_set_test() and ok
    ok = frame_gate_test() and ok
    ok = anchor_names_test() and ok
    ok = gitfile_name_test() and ok
    ok = reader_census_arms() and ok
    ok = harness_bytes_arm() and ok
    ok = live_byte_keys_arm() and ok
    ok = tree_law_arm() and ok
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


def _suspend_tree_law_for_generation():
    """Consult every object check EXCEPT the two tree laws, for generation only.

    `R23-F2` put a clean-tree law and an index-flag law into the decision
    frame, and a generator is the one entry point that must run in a tree that
    is not yet clean: regeneration is HOW the working tree is brought to the
    state the law demands, so a generator that refuses a dirty tree could
    never be used to clean one.

    This is admissible because a generator WRITES documents and prints no
    verdict. Nothing a reader cites comes out of `--regenerate` or `--emit`:
    the verdicts are `scan`, `--check-blocks` and `--selftest`, and all three
    keep consulting both tree laws -- `--check-blocks` especially, since it is
    the verdict that says a generated block agrees with a fresh run. A block
    written from a dirty tree therefore earns no transcript until the tree is
    committed and `--check-blocks` passes on it.

    The suspension is a process flag read by `_objects_enabled`, not a seeded
    cache: the generators clear the frame cache on purpose (a guard-deletion
    world must re-parse), so a seeded cache would be thrown away and the real
    parse -- tree law included -- would run inside the very world being
    measured.
    """
    _GENERATING.append(True)


def _generation_refused():
    """A named refusal when a generator is asked to write from a frame the rules
    do not admit, or `None`.

    Found by using this file: `--regenerate` run in a working tree whose
    deciding bytes differ from the commit wrote a guard matrix in which EVERY
    guard "reds 98 arm(s)" -- because the arms run the scan, the scan refused
    `SELF-BYTES-UNCOMMITTED`, and an arm whose world refuses is an arm that
    stopped giving its verdict, which the matrix reads as the guard being
    load-bearing for everything. A false generated figure, written silently,
    into the one place this pack tells readers to trust over its prose.

    The two TREE laws stay suspended -- a generator must be able to run in a
    tree that is not yet clean, which is the whole reason the suspension
    exists -- so what is required here is everything else: the deciding bytes
    in the commit, the frame's objects, the parse. `--check-blocks` would
    disagree with such a block afterwards, which is how this was caught, but a
    check downstream of a written document is not a reason to write a false
    one.
    """
    ok, msgs = frame_admissible()
    if ok:
        return None
    return (
        "GENERATION-FRAME-INADMISSIBLE: a generated block is written by RUNNING the "
        "arms, so a frame the rules refuse writes a block of refusals and calls them "
        "measurements. %d refusal(s) stand in the way, the first being: %s" % (len(msgs), msgs[0])
    )


# The flags that SUSPEND the two tree laws, and the flags that produce a
# VERDICT. The coordinator's caveat on judgement call (a): the dispatch below
# takes the first flag it matches, so `--regenerate --check-blocks` suspended
# the laws and then returned the generation branch's 0 -- no committed entry
# point passes both, but a reader who typed them would have read a 0 that no
# verdict path produced. An entry point given one of each is refused.
GENERATION_FLAGS = ("--regenerate", "--emit")
VERDICT_FLAGS = ("--selftest", "--check-blocks", "--surface")


def _main(args):
    if "--run-capture" in args:
        at = args.index("--run-capture") + 1
        if at >= len(args):
            sys.stderr.write(
                "check_fenced_figures.py REFUSED: RUN-CAPTURE-ABSENT: `--run-capture` "
                "was given with no path.\n"
            )
            return 5
        _RUN_CAPTURE[:] = [args[at]]
    gen = [a for a in args if a in GENERATION_FLAGS]
    verdict = [a for a in args if a in VERDICT_FLAGS]
    if gen and verdict:
        sys.stderr.write(
            "check_fenced_figures.py REFUSED: ENTRY-POINT-AMBIGUOUS: %s suspends the "
            "clean-tree and index-flag laws because a generator must be able to run in "
            "a tree that is not yet clean, and %s is a verdict, which is read only from "
            "a run of the committed tree. One invocation cannot be both.\n"
            % (", ".join(gen), ", ".join(verdict))
        )
        return 5
    if "--decision-constants" in args:
        # Not a generated block in a document: a digest a reader regenerates
        # when a constant changes on purpose, printed above the text it is taken
        # over, so the change itself is readable and not only its hash.
        # The canonical text and its digest, printed so a reader can see WHAT
        # the matcher's decisions read and not only a hash of it. It pins
        # nothing by itself: no literal in this file holds it, and the digest a
        # reader checks is the published one for the commit.
        text = decision_constants()
        sys.stdout.write(text)
        print(
            "DECISION_CONSTANTS_DIGEST (informational, published in the manifest) = %r"
            % hashlib.sha256(text.encode("utf-8")).hexdigest()
        )
        return 0
    if "--selftest" in args:
        return selftest()
    if "--surface" in args:
        return surface()
    if "--regenerate" in args:
        _suspend_tree_law_for_generation()
        why = _generation_refused()
        if why is not None:
            sys.stderr.write("check_fenced_figures.py REFUSED: %s\n" % why)
            return 5
        return regenerate(PHASE_DIR)
    if "--check-blocks" in args:
        return check_blocks(PHASE_DIR)
    if "--emit" in args:
        name = args[args.index("--emit") + 1]
        if name not in GENERATORS:
            sys.stderr.write("no such generator: %s\n" % name)
            return 3
        _suspend_tree_law_for_generation()
        why = _generation_refused()
        if why is not None:
            sys.stderr.write("check_fenced_figures.py REFUSED: %s\n" % why)
            return 5
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
