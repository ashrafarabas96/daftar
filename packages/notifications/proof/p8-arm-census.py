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
identity, `EXPECTED_SEAL` is the SHA-256 of that list, and the census refuses by
name in **both** directions — `ARM NOT DECLARED` on an arrival, `ARM MISSING` on
a departure, naming which — plus `SEAL BROKEN` when the list and its digest
disagree, so the set cannot be widened or narrowed quietly in passing. Adding an
arm and removing one both now cost the same deliberate act: re-seal, in the same
commit.

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
    "HATCH",
    "BASELINE",
    "I1-conc",
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
)

# ---------------------------------------------------------------------
# THE DECLARED ARM SET, AND ITS SEAL (round 28, T-1)
# ---------------------------------------------------------------------
# The heads above say what SHAPE is an arm. They cannot say which arms exist, so
# they cannot see one stop existing. This tuple can: it is the identity of every
# arm the gate is expected to print, and the census refuses when the run's set
# differs from it in EITHER direction, naming which identities moved.
#
# `EXPECTED_SEAL` is the SHA-256 of "\n".join(EXPECTED_ARMS) + "\n", and it is
# checked before the log is read. Its job is narrow and worth stating: it does
# not stop an author from editing the list — nothing can — it stops the list
# being edited WITHOUT NOTICING, by a patcher, a merge, or a hand reaching for
# one line. Regenerate both together with `--seal` and commit them together.
EXPECTED_ARMS = (
    "ANCHOR-ID r",
    "ANCHOR-ID s",
    "ANCHOR-ID t",
    "ANCHOR-MUT m",
    "ANCHOR-MUT n",
    "ANCHOR-MUT o",
    "ANCHOR-MUT p",
    "ANCHOR-MUT q",
    "ARGSHAPE u",
    "ARGSHAPE v",
    "ARGSHAPE w",
    "ARGSHAPE x",
    "ARGSHAPE y",
    "ARGSHAPE z",
    "BASELINE CASE",
    "CENSUS-LOSS",
    "CENSUS-LOSS-CTL-1",
    "CENSUS-LOSS-CTL-2",
    "CENSUS-LOSS-CTL-3",
    "CENSUS-SEAL",
    "CENSUS-UNKNOWN",
    "CENSUS-UNKNOWN-CTL",
    "GRAFTS",
    "GUARD-CTL y1",
    "GUARD-CTL y10",
    "GUARD-CTL y11",
    "GUARD-CTL y12",
    "GUARD-CTL y13",
    "GUARD-CTL y14",
    "GUARD-CTL y15",
    "GUARD-CTL y16",
    "GUARD-CTL y17",
    "GUARD-CTL y18",
    "GUARD-CTL y2",
    "GUARD-CTL y20a",
    "GUARD-CTL y20b",
    "GUARD-CTL y20c",
    "GUARD-CTL y20d",
    "GUARD-CTL y21a",
    "GUARD-CTL y21b",
    "GUARD-CTL y21c",
    "GUARD-CTL y21d",
    "GUARD-CTL y3",
    "GUARD-CTL y4",
    "GUARD-CTL y5",
    "GUARD-CTL y6",
    "GUARD-CTL y7",
    "GUARD-CTL y8",
    "GUARD-CTL y9",
    "HATCH",
    "I1-conc PASS",
    "INTEGRITY-MUT a",
    "INTEGRITY-MUT b",
    "INTEGRITY-MUT c",
    "INTEGRITY-MUT d",
    "INTEGRITY-MUT e",
    "INTEGRITY-MUT f",
    "INTEGRITY-MUT g",
    "INTEGRITY-MUT h",
    "INTEGRITY-MUT i",
    "INTEGRITY-MUT j",
    "INTEGRITY-MUT k",
    "INTEGRITY-MUT l",
    "INTEGRITY-MUT m2",
    "INTEGRITY-MUT n2",
    "INTEGRITY-MUT o2",
    "ISOLATION",
    "LINEAGE",
    "MUT 1",
    "MUT 10",
    "MUT 10b",
    "MUT 11",
    "MUT 12",
    "MUT 13",
    "MUT 14",
    "MUT 15",
    "MUT 16",
    "MUT 1b",
    "MUT 2",
    "MUT 2b",
    "MUT 3",
    "MUT 4",
    "MUT 5",
    "MUT 6",
    "MUT 7",
    "MUT 8",
    "MUT 8b",
    "MUT 9",
    "MUT 9b",
    "RETIREMENT",
    "RETIREMENT-NET y19",
    "SHALLOW",
    "VACUITY a",
    "VACUITY b",
    "VACUITY c",
    "VACUITY f",
    "VACUITY g",
    "VACUITY n6a",
    "VACUITY n6d",
    "VACUITY-CTL-1",
    "VACUITY-CTL-2",
    "VACUITY-CTL-3",
    "WITNESS unwitnessed",
    "WITNESS w2",
    "WITNESS-BIND",
    "WITNESS-BIND-CTL",
    "WITNESS-CTL",
    "WITNESS-SQLSTATE",
    "WITNESS-SQLSTATE-CTL",
)
EXPECTED_SEAL = "ecc2cb430ba068193dd56cb73e34d4c15ee001b4f126f382766f04b235416f42"

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
SHAPE = re.compile(r"^(?P<head>[A-Za-z][A-Za-z0-9-]*)(?P<id>[ ][A-Za-z0-9]+)?[ ]?[^:]*:")

# And the other half of the same residual: a label with NO colon matched
# nothing, so `MUT 17 passed` would have been invisible. A line that opens with
# an ALL-CAPS word and carries no colon is therefore refused too, unless it is
# declared. Measured across a whole run before this was added: exactly ONE line
# in the gate's log is of that shape, the final `RUN=… FAILED=…`, which is why
# this can be a refusal rather than a widening nobody could satisfy.
COLONLESS = re.compile(r"^[A-Z][A-Z0-9-]+\b")


def head_of(label):
    """The declared head of a label, with a trailing -<digits> stripped.

    `VACUITY-CTL-1`, `-2` and `-3` are three identities under one declared head
    `VACUITY-CTL`; `INTEGRITY-MUT` is a head in its own right and must not be
    read as `INTEGRITY` with an id.
    """
    return re.sub(r"-[0-9]+$", "", label)


def census(path):
    seen = set()
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
                # Round 28: a colon-less ALL-CAPS opener is arm-shaped enough to
                # be an arm nobody declared, so it is refused rather than
                # skipped.
                if COLONLESS.match(line) and not line.startswith(NOT_ARM_PREFIXES):
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
            seen.add(ident)
    return sorted(seen), unknown


def seal_of(arms):
    """The SHA-256 of the declared set, as one newline-terminated block."""
    return hashlib.sha256(("\n".join(arms) + "\n").encode("utf-8")).hexdigest()


def declaration(arms):
    """The literal block an author pastes back into this file."""
    out = ["EXPECTED_ARMS = ("]
    for a in arms:
        out.append('    "%s",' % a)
    out.append(")")
    out.append('EXPECTED_SEAL = "%s"' % seal_of(arms))
    return "\n".join(out) + "\n"


def main(argv):
    # The WHOLE argv vocabulary is validated, because round 18's N-6 was an
    # option spelling that no parser read and no refusal could therefore see.
    if len(argv) == 3 and argv[1] == "--seal":
        log = argv[2]
    elif len(argv) == 2 and not argv[1].startswith("-"):
        log = argv[1]
    else:
        sys.stderr.write(
            "CENSUS FAIL: usage: p8-arm-census.py <run-log> | "
            "p8-arm-census.py --seal <run-log>\n")
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
        sys.stdout.write(declaration(arms))
        sys.stderr.write(
            "CENSUS: %d identities printed for pasting into p8-arm-census.py. "
            "This mode MEASURES NOTHING and exits 2 by design\n" % len(arms))
        return 2

    # ---- the seal, before the log is read -------------------------------
    declared = list(EXPECTED_ARMS)
    # The SEAL is read first. Round 28 learned this from its own arm: the arm
    # that renames one declared identity also disturbs the sort order, so with
    # the set check first the refusal came back "NOT A SET" and the seal was
    # never reached — a guard in front of a guard, which this phase has paid for
    # before. The seal is the stronger statement, so it speaks first.
    actual_seal = seal_of(declared)
    if actual_seal != EXPECTED_SEAL:
        sys.stderr.write(
            "CENSUS FAIL: SEAL BROKEN — EXPECTED_ARMS digests to %s and "
            "EXPECTED_SEAL says %s, so the declared set was changed without "
            "being re-sealed and this program cannot say which version of it "
            "the author meant. Run --seal and commit both lines together\n"
            % (actual_seal, EXPECTED_SEAL))
        return 1
    if sorted(set(declared)) != declared:
        sys.stderr.write(
            "CENSUS FAIL: THE DECLARATION IS NOT A SET — EXPECTED_ARMS must be "
            "sorted and free of duplicates, because a duplicate hides a "
            "departure behind an arrival. Regenerate it with --seal\n")
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
    missing = [a for a in declared if a not in set(arms)]
    if missing:
        sys.stderr.write(
            "CENSUS FAIL: ARM MISSING — the declared set names %d arms and this "
            "run printed %d; these never named themselves: %s. An arm that "
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
    if len(arms) != len(declared):
        # Unreachable while the two checks above hold; it is here because a
        # literal total is the only thing that bounds a loss no comparison
        # happened to look at.
        sys.stderr.write(
            "CENSUS FAIL: COUNT DISAGREES — %d arms seen, %d declared, with "
            "neither set differing by name, so this program's own comparison "
            "has moved\n" % (len(arms), len(declared)))
        return 1

    sys.stdout.write("ARM CENSUS: %d named arms, every one of the %d declared\n"
                     % (len(arms), len(declared)))
    # Comma-separated, because an identity contains a space ("MUT 14") and a
    # space-joined list cannot be read back unambiguously.
    sys.stdout.write("ARM CENSUS LIST: %s\n" % ", ".join(arms))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
