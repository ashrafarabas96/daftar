#!/usr/bin/env -S python3 -I
"""Phase 8 — the arm census, as a program the gate RUNS rather than a pattern a
document carries.

WHY THIS IS A FILE. The arm count was a `grep -oE` pattern published in the
handoff manifest and re-run by hand. Round 26 measured what that costs: ten new
arms ran — seven `VACUITY` arms and three `VACUITY-CTL` controls — and the
published pattern reported the same **74** as the round before, because the
pattern has no `VACUITY` alternative and `grep -o` simply does not match a line
it was not told about. **A count rule that cannot name a new label is measuring
the rule, not the apparatus**, and it fails in the one direction that matters:
silently, and downwards, while the author reads the old number as continuity.

So the census declares the labels that ARE arms and the labels that are
deliberately NOT, and any arm-shaped line whose label is in neither set is a
REFUSAL by name rather than a line the scan skips. A new arm therefore cannot be
added without this file being told.

ROUND 28 CORRECTION — READ THIS BEFORE THE PARAGRAPH ABOVE. Round 26b called
that a *conservation law*. **It was not, and the word was doing work the code did
not do.** The eighteenth challenge measured it (T-1, P1): a declared label that
ARRIVES is refused, and a real arm that DISAPPEARS is not. Its demonstration was
end to end rather than on a log — it silenced one arm's own report in the runner
(`say "GUARD-CTL y20c:` to `true "GUARD-CTL y20c:`, so the arm still runs and
stops naming itself), changed nothing else, and the gate came back:

    [CENSUS-LOSS] ARM CENSUS: 96 named arms
    [CENSUS-LOSS] RUN=CENSUS-LOSS FAILED=0

97 to 96, green. A law that catches only creation is not a conservation law; it
is the same silent-and-downwards failure round 26b was built to end, moved one
level up. And the sibling fix in this very range had already shown the shape of
the answer: `P8_EXPECT_CASES=98` gives the CASE count a literal and a red. The
case count got its literal; the arm count did not.

So the set itself is now DECLARED and SEALED. `EXPECTED_ARMS` names every arm
identity, `EXPECTED_SEAL` is the SHA-256 of FOUR declarations and not of that
list alone — round 30 widened it and ROUND 37 (`R27-S-3`) corrects this
sentence, which was the second site of the stale recipe round 36 fixed at the
first; `seal_of`'s own docstring carries the runnable one — and the census
refuses by name in **both** directions — `ARM NOT DECLARED` on an arrival, `ARM MISSING` on
a departure, naming which — plus `SEAL BROKEN` when the list and its digest
disagree, so the set cannot be widened or narrowed quietly in passing. Adding an
arm and removing one both now cost the same deliberate act: re-seal, in the same
commit.

ROUND 29 CORRECTION — READ THIS BEFORE THE PARAGRAPH ABOVE. The sealed set of
round 28 was still narrower than the sentence it printed. The nineteenth
challenge measured it (U-1, P1): the identity is the label a line PRINTS, and an
identity is not a measurement. Thirteen declared identities were printed by more
than one independent measurement — `ISOLATION` five times, `RETIREMENT` three,
`ANCHOR-ID r/s/t` three each — so twenty of the run's arm lines were redundant to
the census and the loss of any one of them was free. Measured by deleting one
line at a time from the gate's own log and running this program:

    drop the ISOLATION arm this round added to prove F-C   rc=0  109/109
    drop any of the three RETIREMENT arms                  rc=0  109/109

The gate's own `CENSUS-LOSS` arm removed an identity exactly one line printed, so
it proved the half of the law that was never in doubt.

So the declaration is now a MULTIPLICITY: every entry is a pair, the identity and
the number of lines that must print it, and the census compares per-identity
counts. `ARM COUNT CHANGED` names the identity, what was declared and what was
printed. The gate was changed in the same commit to give each distinct
measurement an id of its own, so every declared count is 1 — but the law does not
depend on that, which is the point: a count of 1 is a claim, and so is a count of
5.

The same challenge closed the other half of the shape law (U-5): two arm-shaped
spellings with no colon — a lower-case head and a Mixed-Case head — matched
neither the arm pattern nor the colon-less pattern, so an arm written either way
was invisible. The rule is no longer a pattern that admits: a prefixed line that
this program cannot classify as an arm or as a DECLARED non-arm is now refused.
Refuse by name, fail on absence, never skip what you cannot classify.

Usage:  p8-arm-census.py <run-log>          census; exit 0, or a named refusal, 1
        p8-arm-census.py --seal <run-log>   print a fresh declaration block
The second mode is a GENERATOR for the author and **exits 2 in every case**,
including success, so that no caller can ever read it as a census that passed:
round 17's `--print-pin` was a door in front of every door (N-5), and a mode flag
that can exit 0 without measuring is that door.
"""
import sys

# =====================================================================
# THIS BLOCK SITS ABOVE EVERY IMPORT (round 23, N-17; project lesson P5 B-9)
# =====================================================================
# Python prepends the script's own directory to `sys.path`, and this script
# lives inside the tree it judges, so every module it imports would be resolved
# from the subject first. `sys` is a BUILT-IN, never loaded from a file, so it
# cannot be shadowed; it is the only name imported above this test.
if not sys.flags.isolated:
    sys.stderr.write(
        "CENSUS FAIL: NOT ISOLATED — started without `-I`, so Python put this "
        "program's own directory, which is inside the tree under test, first on "
        "sys.path; every module it needs would then be resolved from the subject "
        "it is judging. Re-run as `python3 -I`. Refusing rather than measuring "
        "with an instrument the subject can supply\n")
    raise SystemExit(1)

import collections
import hashlib
import re

# The labels that ARE arms. Each one is a measurement the gate makes, and the
# census counts DISTINCT identities under these heads: `MUT 14` and `MUT 15` are
# two, `ISOLATION` printed three times is one.
ARM_LABELS = (
    "MUT",
    "INTEGRITY-MUT",
    "ANCHOR-MUT",
    "ANCHOR-ID",
    "ARGSHAPE",
    "GUARD-CTL",
    "LINEAGE",
    "GRAFTS",
    "SHALLOW",
    "ISOLATION",
    "RETIREMENT",
    "RETIREMENT-NET",
    "VACUITY",
    "VACUITY-CTL",
    "WITNESS",
    "WITNESS-CTL",
    # Round 28, T-2: the obligation derived from the arriving SQLSTATE, and the
    # control that deletes that one condition.
    "WITNESS-SQLSTATE",
    "WITNESS-SQLSTATE-CTL",
    # Round 28, T-1: the census's own arms. A guard that measures the apparatus
    # is part of the apparatus, so it is counted like any other.
    "CENSUS-LOSS",
    "CENSUS-LOSS-CTL",
    "CENSUS-SEAL",
    "CENSUS-UNKNOWN",
    "CENSUS-UNKNOWN-CTL",
    # Round 28, F-B: the subject bound into both the statement and the witness.
    "WITNESS-BIND",
    "WITNESS-BIND-CTL",
    # ROUND 29. U-7/N-1: the one door into the witness law. U-6: the sandbox
    # refusal that protects the frozen set. U-1/N-4: the census's own shape and
    # multiplicity laws.
    "CORE-NET",
    "CORE-NET-CTL",
    "SANDBOX",
    "SANDBOX-CTL",
    "CENSUS-BASE",
    "CENSUS-MULT",
    "CENSUS-MULT-CTL",
    "CENSUS-SHAPE",
    "CENSUS-SHAPE-CTL",
    "WITNESS-ROW",
    "WITNESS-ROW-CTL",
    "WITNESS-KEY",
    "WITNESS-KEY-CTL",
    "WITNESS-HANDLER",
    "WITNESS-HANDLER-CTL",
    "WITNESS-SENTINEL",
    # ROUND 30. W-3 and W-4, the two side doors into the witness law: the
    # relation form's shape read from the server's own keyword list, the
    # relation-level refusal class, the handler one frame deeper, the statement
    # that builds more SQL — and the honest case that must NOT red. W-1 and
    # W-2: the census measured in the configuration an archive copy takes, over
    # every static sentence of every code path, with the complement sealed.
    "WITNESS-SHAPE",
    "WITNESS-SHAPE-CTL",
    "WITNESS-RELCLASS",
    "WITNESS-RELCLASS-CTL",
    "WITNESS-LAUNDER",
    "WITNESS-LAUNDER-CTL",
    "WITNESS-DYNSQL",
    "WITNESS-DYNSQL-CTL",
    "WITNESS-LITERAL",
    "WITNESS-LITERAL-CTL",
    "CENSUS-NOGIT",
    "CENSUS-NOGIT-CTL",
    "CENSUS-PATHS",
    "CENSUS-PATHS-CTL",
    "CENSUS-SEAL-COMP",
    "CENSUS-SEAL-COMP-CTL",
    # ROUND 30, the coordinator's F-1 to F-4: the row predicate built by the
    # form rather than written by the case, the relation shape read from the
    # server's keyword list, the refusal read out of the arriving exception
    # CONTEXT, and the net over every SQL file the run loads with its byte pin.
    "WITNESS-REACH",
    "WITNESS-REACH-CTL",
    "WITNESS-REACH2",
    "WITNESS-REACH2-CTL",
    "WITNESS-MERGE",
    "WITNESS-SPLIT",
    "WITNESS-BLOCK",
    "WITNESS-BLOCK-CTL",
    "CORE-NET-SET",
    "CORE-NET-DYN",
    "CORE-NET-FIX",
    "CORE-NET-STRAY",
    "CORE-PIN",
    "CORE-PIN-CTL",
    # ROUND 31. The coordinator's diff review and a second challenge pack, on
    # the same head, measured one defect under three of round 30's closures: a
    # text law that MIS-PARSES the language is weaker than the check it
    # replaced. These are the arms that bound it, and the three ROW-REACH ones
    # read a BEHAVIOUR — whether the composed predicate applied — instead of a
    # text.
    "SCANNER-AGREE",
    "SCANNER-AGREE-CTL",
    # ROUND 32: the twenty-second challenge's D-1 and D-2 and the coordinator
    # diff review's P1. Agreement between the two scanners was never
    # conformance to the thing they implement, so these read the SERVER.
    "SCANNER-ORACLE",
    "SCANNER-ORACLE-CTL",
    "IDENT-RULE",
    "LEX-SETTINGS",
    "ROW-ASTRAL",
    "ROW-ASTRAL-WHERE",
    "ROW-ASTRAL-CTL",
    "ROW-ASTRAL-CLASS-CTL",
    "REACH-BENCH",
    "ROW-REACH",
    "ROW-REACH-COMMENT",
    "ROW-REACH-COMMENT-CTL",
    "ROW-REACH-SEMI",
    "ROW-REACH-SEMI-CTL",
    "ROW-REACH-DOLLAR",
    "ROW-CLASS",
    "ROW-CLASS-CTL",
    "ROW-PACK",
    "ROW-PACK-CTL",
    "WITNESS-SHAPE-DOLLAR",
    "WITNESS-LAUNDER-CTL2",
    "CORE-NET-DOLLAR",
    "HATCH",
    "BASELINE",
    "I1-conc",
    # ROUND 33: the two BLOCKING findings of the reviews of `b7c0933`, each
    # with its plant and its one-deletion control, plus the arm that answers
    # R-5 and the bench the first of them needs.
    "ROWTRAP-BENCH",
    "RELATION-ROWTRAP",
    "RELATION-ROWTRAP-CTL",
    "LEX-SESSION",
    "LEX-SESSION-CTL",
    "EXEC-EQUIV",
    "EXEC-EQUIV-CTL",
    # Round 34, the coordinator's section 4: the attribution law's bench, its
    # four attacks and the two one-deletion controls, one for each term.
    "ATTRIB-BENCH",
    "RELATION-ATTRIB-REL",
    "ROW-ATTRIB-REL",
    "RELATION-ATTRIB-FN",
    "RELATION-ATTRIB-NAMED",
    "RELATION-ATTRIB-CTL",
    # ROUND 35, R25-F-1: the five attacks both reviews measured passing at
    # rc 0, the two probes that isolate the law's two terms, the two that
    # isolate the bind law and the EXPLAIN construction, and the arm that
    # reads the gate's own stderr (R25-S-3).
    "ATTRIB-X1",
    "ATTRIB-X2",
    "ATTRIB-X3",
    "ATTRIB-X4",
    "ATTRIB-X5",
    "ATTRIB-KIND-ISOLATE",
    "ATTRIB-PRIV-CTL",
    "ATTRIB-KIND-CTL",
    "RELATION-BIND-ISOLATE",
    "RELATION-BIND-CTL",
    "RELATION-EXPLAIN-ISOLATE",
    "RELATION-EXPLAIN-CTL",
    "GATE-STDERR",
    # ROUND 36, R26-F-1: the three statements that defeat any privilege set
    # derived from the case's own text, the coordinator's two, the
    # challenger's own control, and a one-deletion control on the reach term
    # for each of them.
    "ATTRIB-W1",
    "ATTRIB-W2",
    "ATTRIB-W3",
    "ATTRIB-A1",
    "ATTRIB-A1B",
    "ATTRIB-F2",
    "ATTRIB-R1",
    "ATTRIB-W3C",
    "ATTRIB-Z1",
    "ATTRIB-Z2",
    "REACH-W1-CTL",
    "REACH-W2-CTL",
    "REACH-W3-CTL",
    "REACH-W3C-CTL",
    "REACH-Z1-CTL",
    "HOMONYM-F2-CTL",
    "HOMONYM-R1-CTL",
    "RLS-A1-CTL",
    "RLS-A1B-CTL",
    "REACH-Z2-CTL",
    # Round 34, the coordinator's section 5 and 6.1 and 6.4, and the
    # twenty-fourth challenge's residual 1: the guard reads behaviour now, so
    # each term has an arm that measures what the behaviour test admits or
    # refuses and a control that puts the name test back.
    "LEX-ALIAS",
    "LEX-ALIAS-CTL",
    "LEX-BQ-CTL",
    "LEX-TNE",
    "LEX-TNE-CTL",
    "LEX-COMPILE",
    "LEX-COMPILE-CTL",
    # Round 34, the coordinator's 6.3: the corpora pinned by digest, and the
    # swap that keeps every count.
    "CORPUS-PIN",
    "CORPUS-SWAP",
)

# The labels that are deliberately NOT arms. This list is the price of the
# conservation law and it is paid on purpose: an exception is itself a CLAIM,
# and it goes red the day one of these starts carrying a measurement.
NOT_ARMS = (
    "NOTE",      # prose the runner addresses to a reader
    "RUN",       # the final `RUN=… FAILED=…` line
    "FAIL",      # a failure report, counted by FAILED= and not by this census
    "ABORT",     # a precondition the run could not meet; it exits before the
                 # census, so this entry exists for a reviewer re-scanning an
                 # aborted log rather than for a run of this gate
)

# Two lines are arm-shaped and are not arms, and they are declared as exact
# PREFIXES rather than as heads, so that a future `ANCHOR <something>:` arm is
# still caught by the law instead of being swallowed by a bare `ANCHOR`. The
# first was found by this program on its first run, which is the behaviour it
# exists for.
NOT_ARM_PREFIXES = (
    # The positive token the frozen-integrity check prints. It is REQUIRED by
    # the gate — `GUARD-CTL y7` deletes it and the runner reds — so it is
    # already measured, as a requirement rather than as an arm of its own.
    "ANCHOR LEG EXERCISED:",
    # This program's own output lines, so that a COMPLETED log can be
    # re-scanned — by the next round, or by a reviewer in its own container —
    # without the report of the count being read as a measurement.
    "ARM CENSUS:",
    "ARM CENSUS LIST:",
    # Prose: the files the manifest's boundary does not cover. It names a set,
    # it asserts nothing, and when it starts asserting something it gets a
    # label of its own and this line goes red.
    "NOT ATTESTED",
    # ROUND 28: the lines that became visible when the head admitted a
    # lower-case initial. Each names a fact the gate REQUIRES elsewhere — the
    # frozen-integrity verdict, the git agreement, the covered-set digest and
    # the overlay's byte identity after mutation — and each has a red path of
    # its own, so none of them is an arm. The day one of them starts carrying a
    # measurement of its own it gets a label and this entry goes red.
    "covered-set digest",
    "frozen integrity:",
    "git agrees:",
    "the overlay is byte-identical after mutation:",
    # The final line of the run, which has no colon.
    "RUN=",
    # Round 28, F-C: the line that states where the gate was invoked from and
    # where it runs. It is a fact the run reports, with its own ABORT paths.
    "cwd:",
    # ROUND 29, U-5. Replacing the two admitting patterns with "refuse what you
    # cannot classify" made every one of these visible for the first time, which
    # is the point: each had been skipped in silence by both patterns. They are
    # declared here one shape at a time, and each is a CLAIM that the line
    # asserts nothing the gate does not measure elsewhere.
    #
    # The section headers the runner prints to divide its log.
    "=== ",
    # The figures the run reports and asserts elsewhere: the case count (which
    # BASELINE CASE COUNT compares against a literal), the cluster's state
    # between phases, the migration count, each role's privilege shape (asserted
    # by the gate's own preconditions), the server version and collation (an
    # ABORT when wrong), and the frozen boundary's anchor (ANCHOR LEG).
    "baseline cases rc=",
    "cluster left at the baseline",
    "cluster restored to the baseline",
    "migrations applied = ",
    "role daftar_",
    # ROUND 31. The CENSUS-PATHS reader anchored at the start of a line, and
    # twenty say-sites after `&&`, `||`, `;` or `{` were in NEITHER the
    # classified set nor the total that was supposed to bound it, so the gap
    # was a silence — the shape of W-1 itself. With the anchor gone two more
    # sentences became visible and each is declared rather than re-hidden: the
    # role line as the paths reader substitutes it, and the abort the
    # coordinator hit by re-using a RUN_ID, which is arm-shaped and is not an
    # arm.
    "role X super/bypassrls",
    "BASELINE BUILD FAILED",
    "server_version=",
    "the frozen boundary is anchored to ",
    # ROUND 30, W-1 (P1), found by the twentieth challenge and the defect this
    # round is about. Round 29's "refuse what you cannot classify" is strictly
    # stronger than the patterns it replaced, and it therefore turns every
    # undeclared line of EVERY code path into a red — including the paths this
    # container does not take. The runner's no-git branch prints this line, and
    # a `git archive` copy with no `.git` — which is the configuration an
    # independent reviewer runs, and the project's own definition of a subject
    # copy — takes it. So the same head was FAILED=0 in a work tree and
    # FAILED=1 from an archive, and the difference was a directory the gate
    # states it does not need.
    #
    # It asserts nothing the gate does not measure elsewhere: in that
    # configuration the manifest's byte check is what attests the frozen set,
    # and it has its own red path. `CENSUS-NOGIT` below measures the census
    # against a log with this branch taken, and `CENSUS-PATHS` measures EVERY
    # static line the runner can print, in any configuration, against this
    # declaration — so an undeclared line of an untaken path reds here instead
    # of in a reviewer's container.
    "no git work tree here",
)

# ---------------------------------------------------------------------
# THE DECLARED ARM SET, AND ITS SEAL (round 28, T-1)
# ---------------------------------------------------------------------
# The heads above say what SHAPE is an arm. They cannot say which arms exist, so
# they cannot see one stop existing. This tuple can: it is the identity of every
# arm the gate is expected to print, and the census refuses when the run's set
# differs from it in EITHER direction, naming which identities moved.
#
# `EXPECTED_SEAL` is what `seal_of` computes, and ROUND 36 (R26-S-5) corrects
# this line: it used to say the SHA-256 of `"\n".join(EXPECTED_ARMS) + "\n"`,
# which round 30 superseded when the seal was widened to all FOUR declarations
# and which no longer computes the committed value — a reader running the
# published recipe would have concluded the seal was broken. The recipe is the
# one in `seal_of`'s own docstring: the four declarations, each as its own
# tab-delimited block. It is checked before the log is read. Its job is narrow and worth stating: it does
# not stop an author from editing the list — nothing can — it stops the list
# being edited WITHOUT NOTICING, by a patcher, a merge, or a hand reaching for
# one line. Regenerate both together with `--seal` and commit them together.
EXPECTED_ARMS = (
    ("ANCHOR-ID r.10", 1),
    ("ANCHOR-ID r.4", 1),
    ("ANCHOR-ID r.7", 1),
    ("ANCHOR-ID s.10", 1),
    ("ANCHOR-ID s.4", 1),
    ("ANCHOR-ID s.7", 1),
    ("ANCHOR-ID t.10", 1),
    ("ANCHOR-ID t.4", 1),
    ("ANCHOR-ID t.7", 1),
    ("ANCHOR-MUT m.3", 1),
    ("ANCHOR-MUT m.6", 1),
    ("ANCHOR-MUT n.3", 1),
    ("ANCHOR-MUT n.6", 1),
    ("ANCHOR-MUT o.3", 1),
    ("ANCHOR-MUT o.6", 1),
    ("ANCHOR-MUT p.3", 1),
    ("ANCHOR-MUT p.6", 1),
    ("ANCHOR-MUT q.3", 1),
    ("ANCHOR-MUT q.6", 1),
    ("ARGSHAPE u", 1),
    ("ARGSHAPE v", 1),
    ("ARGSHAPE w", 1),
    ("ARGSHAPE x", 1),
    ("ARGSHAPE y", 1),
    ("ARGSHAPE z", 1),
    ("ATTRIB-A1", 1),
    ("ATTRIB-A1B", 1),
    ("ATTRIB-BENCH", 1),
    ("ATTRIB-F2", 1),
    ("ATTRIB-KIND-CTL", 1),
    ("ATTRIB-KIND-ISOLATE", 1),
    ("ATTRIB-PRIV-CTL", 1),
    ("ATTRIB-R1", 1),
    ("ATTRIB-W1", 1),
    ("ATTRIB-W2", 1),
    ("ATTRIB-W3", 1),
    ("ATTRIB-W3C", 1),
    ("ATTRIB-X1", 1),
    ("ATTRIB-X2", 1),
    ("ATTRIB-X3", 1),
    ("ATTRIB-X4", 1),
    ("ATTRIB-X5", 1),
    ("ATTRIB-Z1", 1),
    ("ATTRIB-Z2", 1),
    ("BASELINE CASE", 1),
    ("CENSUS-BASE", 1),
    ("CENSUS-LOSS", 1),
    ("CENSUS-LOSS-CTL-1", 1),
    ("CENSUS-LOSS-CTL-2", 1),
    ("CENSUS-LOSS-CTL-3", 1),
    ("CENSUS-MULT a1", 1),
    ("CENSUS-MULT a2", 1),
    ("CENSUS-MULT-CTL", 1),
    ("CENSUS-NOGIT", 1),
    ("CENSUS-NOGIT-CTL", 1),
    ("CENSUS-PATHS", 1),
    ("CENSUS-PATHS-CTL", 1),
    ("CENSUS-SEAL", 1),
    ("CENSUS-SEAL-COMP", 1),
    ("CENSUS-SEAL-COMP-CTL", 1),
    ("CENSUS-SHAPE", 1),
    ("CENSUS-SHAPE-CTL", 1),
    ("CENSUS-UNKNOWN", 1),
    ("CENSUS-UNKNOWN-CTL", 1),
    ("CORE-NET", 1),
    ("CORE-NET y22", 1),
    ("CORE-NET-CTL y23", 1),
    ("CORE-NET-DOLLAR", 1),
    ("CORE-NET-DYN", 1),
    ("CORE-NET-FIX", 1),
    ("CORE-NET-SET", 1),
    ("CORE-NET-STRAY", 1),
    ("CORE-PIN", 1),
    ("CORE-PIN-CTL", 1),
    ("CORPUS-PIN", 1),
    ("CORPUS-SWAP", 1),
    ("EXEC-EQUIV", 1),
    ("EXEC-EQUIV-CTL", 1),
    ("GATE-STDERR", 1),
    ("GRAFTS g5", 1),
    ("GRAFTS g7", 1),
    ("GUARD-CTL y1", 1),
    ("GUARD-CTL y10", 1),
    ("GUARD-CTL y11", 1),
    ("GUARD-CTL y12", 1),
    ("GUARD-CTL y13", 1),
    ("GUARD-CTL y14", 1),
    ("GUARD-CTL y15", 1),
    ("GUARD-CTL y16", 1),
    ("GUARD-CTL y17", 1),
    ("GUARD-CTL y18", 1),
    ("GUARD-CTL y2", 1),
    ("GUARD-CTL y20a", 1),
    ("GUARD-CTL y20b", 1),
    ("GUARD-CTL y20c", 1),
    ("GUARD-CTL y20d", 1),
    ("GUARD-CTL y21a", 1),
    ("GUARD-CTL y21b", 1),
    ("GUARD-CTL y21c", 1),
    ("GUARD-CTL y21d", 1),
    ("GUARD-CTL y3", 1),
    ("GUARD-CTL y4", 1),
    ("GUARD-CTL y5", 1),
    ("GUARD-CTL y6", 1),
    ("GUARD-CTL y7", 1),
    ("GUARD-CTL y8", 1),
    ("GUARD-CTL y9", 1),
    ("HATCH", 1),
    ("HOMONYM-F2-CTL", 1),
    ("HOMONYM-R1-CTL", 1),
    ("I1-conc PASS", 1),
    ("IDENT-RULE", 1),
    ("INTEGRITY-MUT a", 1),
    ("INTEGRITY-MUT b", 1),
    ("INTEGRITY-MUT c", 1),
    ("INTEGRITY-MUT d", 1),
    ("INTEGRITY-MUT e", 1),
    ("INTEGRITY-MUT f", 1),
    ("INTEGRITY-MUT g", 1),
    ("INTEGRITY-MUT h", 1),
    ("INTEGRITY-MUT i", 1),
    ("INTEGRITY-MUT j", 1),
    ("INTEGRITY-MUT k", 1),
    ("INTEGRITY-MUT l", 1),
    ("INTEGRITY-MUT m2", 1),
    ("INTEGRITY-MUT n2", 1),
    ("INTEGRITY-MUT o2", 1),
    ("ISOLATION i10", 1),
    ("ISOLATION i11", 1),
    ("ISOLATION i12", 1),
    ("ISOLATION i4", 1),
    ("ISOLATION i7", 1),
    ("LEX-ALIAS", 1),
    ("LEX-ALIAS-CTL", 1),
    ("LEX-BQ-CTL", 1),
    ("LEX-COMPILE", 1),
    ("LEX-COMPILE-CTL", 1),
    ("LEX-SESSION", 1),
    ("LEX-SESSION-CTL", 1),
    ("LEX-SETTINGS", 1),
    ("LEX-TNE", 1),
    ("LEX-TNE-CTL", 1),
    ("LINEAGE a5", 1),
    ("LINEAGE a7", 1),
    ("MUT 1", 1),
    ("MUT 10", 1),
    ("MUT 10b", 1),
    ("MUT 11", 1),
    ("MUT 12", 1),
    ("MUT 13", 1),
    ("MUT 14", 1),
    ("MUT 15", 1),
    ("MUT 16", 1),
    ("MUT 1b", 1),
    ("MUT 2", 1),
    ("MUT 2b", 1),
    ("MUT 3", 1),
    ("MUT 4", 1),
    ("MUT 5", 1),
    ("MUT 6", 1),
    ("MUT 7", 1),
    ("MUT 8", 1),
    ("MUT 8b", 1),
    ("MUT 9", 1),
    ("MUT 9b", 1),
    ("REACH-BENCH", 1),
    ("REACH-W1-CTL", 1),
    ("REACH-W2-CTL", 1),
    ("REACH-W3-CTL", 1),
    ("REACH-W3C-CTL", 1),
    ("REACH-Z1-CTL", 1),
    ("REACH-Z2-CTL", 1),
    ("RELATION-ATTRIB-CTL", 1),
    ("RELATION-ATTRIB-FN", 1),
    ("RELATION-ATTRIB-NAMED", 1),
    ("RELATION-ATTRIB-REL", 1),
    ("RELATION-BIND-CTL", 1),
    ("RELATION-BIND-ISOLATE", 1),
    ("RELATION-EXPLAIN-CTL", 1),
    ("RELATION-EXPLAIN-ISOLATE", 1),
    ("RELATION-ROWTRAP", 1),
    ("RELATION-ROWTRAP-CTL", 1),
    ("RETIREMENT n1", 1),
    ("RETIREMENT n2", 1),
    ("RETIREMENT n3", 1),
    ("RETIREMENT-NET y19", 1),
    ("RLS-A1-CTL", 1),
    ("RLS-A1B-CTL", 1),
    ("ROW-ASTRAL", 1),
    ("ROW-ASTRAL-CLASS-CTL", 1),
    ("ROW-ASTRAL-CTL", 1),
    ("ROW-ASTRAL-WHERE", 1),
    ("ROW-ATTRIB-REL", 1),
    ("ROW-CLASS", 1),
    ("ROW-CLASS-CTL", 1),
    ("ROW-PACK", 1),
    ("ROW-PACK-CTL", 1),
    ("ROW-REACH", 1),
    ("ROW-REACH-COMMENT", 1),
    ("ROW-REACH-COMMENT-CTL", 1),
    ("ROW-REACH-DOLLAR", 1),
    ("ROW-REACH-SEMI", 1),
    ("ROW-REACH-SEMI-CTL", 1),
    ("ROWTRAP-BENCH", 1),
    ("SANDBOX y24", 1),
    ("SANDBOX y25", 1),
    ("SANDBOX-CTL y26", 1),
    ("SCANNER-AGREE", 1),
    ("SCANNER-AGREE-CTL", 1),
    ("SCANNER-ORACLE", 1),
    ("SCANNER-ORACLE-CTL", 1),
    ("SHALLOW s12", 1),
    ("SHALLOW s8", 1),
    ("VACUITY a", 1),
    ("VACUITY b", 1),
    ("VACUITY c", 1),
    ("VACUITY f", 1),
    ("VACUITY g", 1),
    ("VACUITY n6a", 1),
    ("VACUITY n6d", 1),
    ("VACUITY-CTL-1", 1),
    ("VACUITY-CTL-2", 1),
    ("VACUITY-CTL-3", 1),
    ("WITNESS unwitnessed", 1),
    ("WITNESS w2", 1),
    ("WITNESS-BIND", 1),
    ("WITNESS-BIND-CTL", 1),
    ("WITNESS-BLOCK", 1),
    ("WITNESS-BLOCK-CTL", 1),
    ("WITNESS-CTL", 1),
    ("WITNESS-DYNSQL", 1),
    ("WITNESS-DYNSQL-CTL", 1),
    ("WITNESS-HANDLER", 1),
    ("WITNESS-HANDLER-CTL", 1),
    ("WITNESS-KEY", 1),
    ("WITNESS-KEY-CTL", 1),
    ("WITNESS-LAUNDER", 1),
    ("WITNESS-LAUNDER-CTL", 1),
    ("WITNESS-LAUNDER-CTL2", 1),
    ("WITNESS-LITERAL", 1),
    ("WITNESS-LITERAL-CTL", 1),
    ("WITNESS-MERGE", 1),
    ("WITNESS-REACH", 1),
    ("WITNESS-REACH-CTL", 1),
    ("WITNESS-REACH2", 1),
    ("WITNESS-REACH2-CTL", 1),
    ("WITNESS-RELCLASS", 1),
    ("WITNESS-RELCLASS-CTL", 1),
    ("WITNESS-ROW", 1),
    ("WITNESS-ROW-CTL", 1),
    ("WITNESS-SENTINEL", 1),
    ("WITNESS-SHAPE", 1),
    ("WITNESS-SHAPE-CTL", 1),
    ("WITNESS-SHAPE-DOLLAR", 1),
    ("WITNESS-SPLIT", 1),
    ("WITNESS-SQLSTATE", 1),
    ("WITNESS-SQLSTATE-CTL", 1),
)
EXPECTED_SEAL = "265977107ed47c1de202bce9d3dcd5337b96b028143ede5f89fd60ae623a7e55"

# An arm-shaped line: a label, optionally an id, then a colon. `I1-conc` is
# lower-case after the first token, which is why the head pattern does not
# require upper case throughout.
#
# ROUND 28 (the coordinator's P3). The head used to require an UPPER-CASE first
# letter, so an arm printed as `probe z1: ...` was not arm-shaped at all and the
# census skipped it in silence — the same failure as round 26b's, one character
# narrower. The head now admits a lower-case initial, and the four prose lines
# that newly match are declared below, which is the price and is paid on
# purpose.
SHAPE = re.compile(r"^(?P<head>[A-Za-z][A-Za-z0-9-]*)(?P<id>[ ][A-Za-z0-9.]+)?[ ]?[^:]*:")
# ROUND 29: the id may carry a dot. The anchor families print one line per
# mutant per SITE (`ANCHOR-MUT m.3`), and a site is a measurement, so the
# identity has to be able to name it (U-1, and the coordinator's ruling that
# the census must count measurements rather than printed names).

# ROUND 29, U-5. There used to be a SECOND pattern here, matching a colon-less
# ALL-CAPS opener, so that `MUT 17 passed` would be refused rather than skipped.
# The nineteenth challenge stepped around it in two characters: `probe z2
# passed` fails on its first character and `Probe z3 passed` on its second, and
# both left the census at 109/109, rc 0. The pattern is GONE rather than
# widened, because the rule it was trying to express is not "these shapes are
# arms" but "a line this program cannot classify is a refusal" — and that rule
# needs no pattern at all. See `census`.


def head_of(label):
    """The declared head of a label, with a trailing -<digits> stripped.

    `VACUITY-CTL-1`, `-2` and `-3` are three identities under one declared head
    `VACUITY-CTL`; `INTEGRITY-MUT` is a head in its own right and must not be
    read as `INTEGRITY` with an id.
    """
    return re.sub(r"-[0-9]+$", "", label)


def census(path):
    """Return (Counter of identity -> lines that printed it, unclassified lines).

    ROUND 29, U-1: a SET of identities cannot see the loss of a line whose
    identity another line also prints, so what is returned is a COUNT per
    identity and not a membership test.
    """
    seen = collections.Counter()
    unknown = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            # ROUND 28. Only the gate's OWN statements are judged, and the gate
            # marks them: `say` prefixes every line it writes with the run id.
            # The log also carries foreign text — psql's `SET`/`BEGIN` echoes, a
            # `diff`, the head of an error log — which failure paths tee in as
            # EVIDENCE, not as claims. Judging those made the widened head
            # refuse `BEGIN` and `SET`; requiring the prefix is the right rule
            # and it is also stricter, because an arm can now only be counted if
            # it went through `say`.
            m_pref = re.match(r"^\[[^\]]*\]\s", line)
            if not m_pref:
                continue
            line = line[m_pref.end():]
            m = SHAPE.match(line)
            if not m:
                # ROUND 29, U-5. This used to admit only a colon-less ALL-CAPS
                # opener, so `probe z2 passed` (lower-case head) and `Probe z3
                # passed` (Mixed-Case head) matched neither pattern and were
                # skipped in silence — an arm written either way was invisible,
                # exactly as the seven VACUITY arms were invisible to round 26's
                # grep. A pattern that ADMITS can always be stepped around; a
                # pattern that REFUSES cannot. So every prefixed line this
                # program cannot classify as an arm is now refused unless it is
                # a DECLARED non-arm, which is this project's first lesson read
                # back onto its own instrument: fail on absence, never skip what
                # you cannot classify.
                if not line.startswith(NOT_ARM_PREFIXES):
                    unknown.append(line[:60])
                continue
            if line.startswith(NOT_ARM_PREFIXES):
                continue
            head = head_of(m.group("head"))
            if head in NOT_ARMS:
                continue
            if head not in ARM_LABELS:
                unknown.append(m.group(0))
                continue
            # The IDENTITY is the label as PRINTED, not the declared head:
            # `VACUITY-CTL-1`, `-2` and `-3` are three arms under one declared
            # head, and counting the head would collapse them into one. Round
            # 26 made exactly that mistake in a hand-written grep and reported
            # 85 where the arms are 87.
            printed = m.group("head")
            ident = printed if m.group("id") is None else printed + m.group("id")
            seen[ident] += 1
    return seen, unknown


def _digest(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def components(pairs):
    """The four declarations this program decides by, each as its own block.

    ROUND 30, W-2. The seal used to cover `EXPECTED_ARMS` alone — the set of
    things that MUST print — and not the lists that decide which lines the
    census is allowed to pass over. The twentieth challenge added one head to
    `NOT_ARMS`, left `EXPECTED_SEAL` untouched, and an arm-shaped arrival that
    had been refused by name came back as `148 named arms of 148 declared`,
    rc 0: a whole family admitted by one line, with no re-seal.

    The file's own argument for the seal — that the set must not be widened or
    narrowed quietly in passing — applies verbatim to the complement, so all
    four blocks are sealed together. Each is digested on its own as well, and
    both the refusal and `--seal` print the four, so an author can see WHICH
    declaration moved rather than only that something did.
    """
    return (
        ("EXPECTED_ARMS",
         "".join("%s\t%d\n" % (ident, n) for ident, n in pairs)),
        ("ARM_LABELS", "".join("L\t%s\n" % w for w in ARM_LABELS)),
        ("NOT_ARMS", "".join("N\t%s\n" % w for w in NOT_ARMS)),
        ("NOT_ARM_PREFIXES", "".join("P\t%s\n" % w for w in NOT_ARM_PREFIXES)),
    )


def component_report(pairs):
    return "; ".join("%s=%s" % (name, _digest(body)[:12])
                     for name, body in components(pairs))


def seal_of(pairs):
    """The SHA-256 of all four declarations, as one newline-terminated block.

    ROUND 29: the seal covers the COUNTS as well as the identities, so changing
    a declared count from 5 to 4 — which is how U-1's hole would be papered over
    — breaks the seal exactly as deleting an identity does. ROUND 30: and the
    three lists above, so the complement cannot be widened without a re-seal.
    """
    return _digest("".join(body for _, body in components(pairs)))


def declaration(pairs):
    """The literal block an author pastes back into this file."""
    out = ["EXPECTED_ARMS = ("]
    for ident, n in pairs:
        out.append('    ("%s", %d),' % (ident, n))
    out.append(")")
    out.append('EXPECTED_SEAL = "%s"' % seal_of(pairs))
    return "\n".join(out) + "\n"


def pairs_of(counter):
    """The counter as a sorted tuple of (identity, count) pairs."""
    return [(ident, counter[ident]) for ident in sorted(counter)]


def main(argv):
    # The WHOLE argv vocabulary is validated, because round 18's N-6 was an
    # option spelling that no parser read and no refusal could therefore see.
    # ROUND 30, W-2. The patchers that build the census's own arms used to
    # re-seal by RE-IMPLEMENTING the digest — a copy of the law in a program
    # whose job is to perturb it, which went wrong the moment the seal grew to
    # cover four declarations instead of one. This mode prints the seal of THIS
    # program's own declarations, so a patcher re-seals by asking the law rather
    # than by restating it. It reads no log, measures nothing, and exits 2 like
    # the other generator.
    if len(argv) == 2 and argv[1] == "--seal-only":
        sys.stdout.write('EXPECTED_SEAL = "%s"\n' % seal_of(list(EXPECTED_ARMS)))
        sys.stderr.write("CENSUS: the four declarations as this file holds them — %s. "
                         "This mode MEASURES NOTHING and exits 2 by design\n"
                         % component_report(list(EXPECTED_ARMS)))
        return 2
    if len(argv) == 3 and argv[1] == "--seal":
        log = argv[2]
    elif len(argv) == 2 and not argv[1].startswith("-"):
        log = argv[1]
    else:
        sys.stderr.write(
            "CENSUS FAIL: usage: p8-arm-census.py <run-log> | "
            "p8-arm-census.py --seal <run-log> | "
            "p8-arm-census.py --seal-only\n")
        return 1

    if argv[1] == "--seal":
        # A GENERATOR, never a measurement: it exits 2 on success as well as on
        # failure, so a caller that reads only the exit code can never mistake
        # it for a census.
        try:
            arms, unknown = census(log)
        except OSError as exc:
            sys.stderr.write("CENSUS FAIL: the run log could not be read: %s\n" % exc)
            return 2
        if unknown:
            sys.stderr.write(
                "CENSUS FAIL: ARM LABEL UNKNOWN, so the set cannot be sealed "
                "from this log: " + "; ".join(sorted(set(unknown))) + "\n")
            return 2
        pairs = pairs_of(arms)
        sys.stdout.write(declaration(pairs))
        # ROUND 29, U-4. `ARM MISSING` ends by telling the author to re-seal, and
        # this generator used to regenerate the declaration from the log and
        # print nothing about what had changed. An author re-sealing after a loss
        # they did not intend got a block one entry shorter and a total they had
        # no reason to question — the refusal prescribing its own laundering. So
        # the generator now states the DIFF against the declaration it would
        # replace, by name and in both directions, and both totals.
        was = {ident: n for ident, n in EXPECTED_ARMS}
        now = dict(pairs)
        delta = []
        for ident in sorted(set(was) | set(now)):
            if ident not in now:
                delta.append("- %s (was %d)" % (ident, was[ident]))
            elif ident not in was:
                delta.append("+ %s (%d)" % (ident, now[ident]))
            elif was[ident] != now[ident]:
                delta.append("~ %s (%d -> %d)" % (ident, was[ident], now[ident]))
        sys.stderr.write(
            "CENSUS: %d identities / %d arm lines printed for pasting into "
            "p8-arm-census.py; the declaration being replaced holds %d "
            "identities / %d lines\n"
            % (len(pairs), sum(now.values()), len(was), sum(was.values())))
        if delta:
            sys.stderr.write(
                "CENSUS: what this block CHANGES, which you are asked to read "
                "before pasting it — an entry leaving is a measurement the gate "
                "stops making:\n  " + "\n  ".join(delta) + "\n")
        else:
            sys.stderr.write(
                "CENSUS: this block is identical to the declaration in the "
                "file; nothing arrived and nothing departed\n")
        sys.stderr.write(
            "CENSUS: the seal covers four declarations, and these are their "
            "digests as this block leaves them — %s. The three lists are "
            "hand-written, so a change to one of them shows up as a broken "
            "seal and is named here (W-2)\n" % component_report(pairs))
        sys.stderr.write(
            "CENSUS: this mode MEASURES NOTHING and exits 2 by design\n")
        return 2

    # ---- the seal, before the log is read -------------------------------
    declared_pairs = list(EXPECTED_ARMS)
    declared = [ident for ident, _ in declared_pairs]
    declared_count = {ident: n for ident, n in declared_pairs}
    # The SEAL is read first. Round 28 learned this from its own arm: the arm
    # that renames one declared identity also disturbs the sort order, so with
    # the set check first the refusal came back "NOT A SET" and the seal was
    # never reached — a guard in front of a guard, which this phase has paid for
    # before. The seal is the stronger statement, so it speaks first.
    actual_seal = seal_of(declared_pairs)
    if actual_seal != EXPECTED_SEAL:
        sys.stderr.write(
            "CENSUS FAIL: SEAL BROKEN — the four declarations digest to %s and "
            "EXPECTED_SEAL says %s, so one of them was changed without being "
            "re-sealed and this program cannot say which version of them the "
            "author meant. Run --seal and commit the block and the seal "
            "together. The four, each on its own: %s\n"
            % (actual_seal, EXPECTED_SEAL, component_report(declared_pairs)))
        return 1
    if sorted(set(declared)) != declared:
        sys.stderr.write(
            "CENSUS FAIL: THE DECLARATION IS NOT A SET — the identities in "
            "EXPECTED_ARMS must be sorted and free of duplicates, because a "
            "duplicate hides a departure behind an arrival. Regenerate it with "
            "--seal\n")
        return 1
    bad = [ident for ident, n in declared_pairs if not isinstance(n, int) or n < 1]
    if bad:
        sys.stderr.write(
            "CENSUS FAIL: THE DECLARATION IS NOT A MULTIPLICITY — every entry "
            "must be (identity, count) with a count of at least 1, and these "
            "are not: %s. A count of 0 would declare an arm that must never "
            "print, which is a different claim and has no instrument here\n"
            % ", ".join(bad))
        return 1

    try:
        arms, unknown = census(log)
    except OSError as exc:
        sys.stderr.write("CENSUS FAIL: the run log could not be read: %s\n" % exc)
        return 1
    if unknown:
        sys.stderr.write(
            "CENSUS FAIL: ARM LABEL UNKNOWN — these lines are arm-shaped and "
            "their label is in neither ARM_LABELS nor NOT_ARMS, so this census "
            "would have skipped a measurement and reported the old number: "
            + "; ".join(sorted(set(unknown)))
            + ". Declare each one in p8-arm-census.py — as an arm, or as "
              "deliberately not an arm, which is a claim either way\n")
        return 1
    if not arms:
        sys.stderr.write(
            "CENSUS FAIL: no arm was found at all, which is not a count of zero "
            "but a sign that the log or this program's shape has moved\n")
        return 1

    # ---- both directions, named ----------------------------------------
    seen_count = arms
    arms = sorted(seen_count)
    total_seen = sum(seen_count.values())
    total_declared = sum(declared_count.values())
    missing = [a for a in declared if a not in seen_count]
    if missing:
        sys.stderr.write(
            "CENSUS FAIL: ARM MISSING — the declared set names %d identities "
            "and this run printed %d; these never named themselves: %s. An arm that "
            "stops reporting is a measurement the gate no longer makes, and "
            "before round 28 it only moved the number down. If an arm was "
            "retired on purpose, re-seal with --seal in the SAME commit that "
            "removes it\n" % (len(declared), len(arms), ", ".join(missing)))
        return 1
    extra = [a for a in arms if a not in set(declared)]
    if extra:
        sys.stderr.write(
            "CENSUS FAIL: ARM NOT DECLARED — this run printed arms the declared "
            "set does not name: %s. Their label is known, so the shape law let "
            "them through; the SET is what refuses them. Re-seal with --seal in "
            "the SAME commit that adds them\n" % ", ".join(extra))
        return 1
    # ROUND 29, U-1. The identity is present in both directions by now, and
    # that was the whole law until the nineteenth challenge showed what it
    # misses: five separate measurements printed `ISOLATION`, so four of them
    # could stop reporting and the identity was still there. The COUNT per
    # identity is the measurement-level statement, and it is refused by name.
    moved = ["%s: declared %d, printed %d"
             % (ident, declared_count[ident], seen_count[ident])
             for ident in declared if seen_count[ident] != declared_count[ident]]
    if moved:
        sys.stderr.write(
            "CENSUS FAIL: ARM COUNT CHANGED — every declared identity printed "
            "at least once, so the SET holds, and these identities did not "
            "print the declared NUMBER of lines: %s. An identity is not a "
            "measurement: where several lines share one identity, losing one of "
            "them leaves the set intact and the gate silent, which is U-1. If "
            "the change is deliberate, re-seal with --seal in the SAME commit\n"
            % "; ".join(moved))
        return 1
    if total_seen != total_declared:
        # Unreachable while the three checks above hold; it is here because a
        # literal total is the only thing that bounds a loss no comparison
        # happened to look at.
        sys.stderr.write(
            "CENSUS FAIL: COUNT DISAGREES — %d arm lines seen, %d declared, "
            "with no identity and no count differing by name, so this "
            "program's own comparison has moved\n"
            % (total_seen, total_declared))
        return 1

    # ROUND 29, the coordinator's N-5. This line used to ASSERT the agreement it
    # was reporting — "every one of the N declared" — so with the comparisons
    # above deleted it printed "108 named arms, every one of the 109 declared"
    # at rc 0: a sentence that was false about the very log it had just read. A
    # success line must be COMPUTED from the comparison, never written as a
    # claim beside it. These are four numbers and no claim: where a guard is
    # missing they disagree in plain sight.
    sys.stdout.write(
        "ARM CENSUS: %d named arms of %d declared, %d arm lines of %d declared\n"
        % (len(arms), len(declared), total_seen, total_declared))
    # Comma-separated, because an identity contains a space ("MUT 14") and a
    # space-joined list cannot be read back unambiguously.
    sys.stdout.write("ARM CENSUS LIST: %s\n" % ", ".join(arms))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
