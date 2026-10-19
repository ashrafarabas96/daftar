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

So the census is a conservation law instead of a filter. It declares the labels
that ARE arms and the labels that are deliberately NOT, and any arm-shaped line
whose label is in neither set is a REFUSAL by name rather than a line the scan
skips. A new arm therefore cannot be added without this file being told, and the
failure mode is a red gate instead of an unchanged number.

Usage:  p8-arm-census.py <run-log>
Prints `ARM CENSUS: <n> named arms` and exits 0, or names the unknown label and
exits 1.
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
)

# An arm-shaped line: an upper-case-initial label, optionally an id, then a
# colon. `I1-conc` is lower-case after the first token, which is why the head
# pattern allows it rather than requiring upper case throughout.
SHAPE = re.compile(r"^(?P<head>[A-Z][A-Za-z0-9-]*)(?P<id>[ ][A-Za-z0-9]+)?[ ]?[^:]*:")


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
            # Strip the run-id prefix the runner puts on every line.
            line = re.sub(r"^\[[^\]]*\]\s*", "", line)
            m = SHAPE.match(line)
            if not m:
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


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("CENSUS FAIL: usage: p8-arm-census.py <run-log>\n")
        return 1
    try:
        arms, unknown = census(argv[1])
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
    sys.stdout.write("ARM CENSUS: %d named arms\n" % len(arms))
    sys.stdout.write("ARM CENSUS LIST: %s\n" % " ".join(arms))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
