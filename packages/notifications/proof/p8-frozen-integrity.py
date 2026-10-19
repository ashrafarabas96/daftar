#!/usr/bin/env -S python3 -I
"""Verify that no frozen migration was modified — WITHOUT relying on git's
silence, and WITHOUT letting the manifest decide what has to be checked.

WHY THIS FILE EXISTS (round 12, fifth challenge R-1, P1, a FAIL-OPEN).
Round 11's runner ended with:

    if git -C "$REPO" status --porcelain -- .../migrations | grep -q .; then FAIL; else
      say "no frozen migration is modified"; fi

The exit code was never read. When `git status` fails — no repository, no git,
`$REPO` not a work tree — stdout is empty, `grep -q .` is false, and the ELSE
branch prints the reassurance. It fired in MY OWN authoritative run, because the
method I prescribe is "from a clean `git archive` copy of the pushed SHA" and an
archive has no `.git`: round 11's gate-6 log holds git's `fatal:` and my own
reassurance on consecutive lines.

WHY IT WAS REWRITTEN AGAIN (round 13, sixth challenge S-1, P1, STILL FAIL-OPEN).
The round-12 replacement verified every file the manifest MENTIONS. A file the
manifest does not mention was not checked and was not a failure: the loop
iterated the record rather than the territory, so deleting a row was a bypass.
The challenger measured it on `0006_rls.sql` — the migration that creates
row-level security — and I reproduced it before fixing it: editing the file
alone gives `MODIFIED 0006_rls.sql … rc=1`, while editing it AND deleting its
manifest row gives `79 of 87 files verified … rc=0`, with the modified file
silently re-counted into the "beyond" line. Two failures at once: the gate
passed, and the one line a reader might scan was made actively wrong, because it
described `0006` as a file past the attested range.

This was round 11's defect one level up. There the check trusted git's silence;
here it trusted the manifest's completeness. In both, the authority that decides
whether anything is wrong is the thing that could be absent. The remedy is the
one already applied to case T2 in the same commit: DERIVE the required set from
what is actually there.

WHY IT WAS REWRITTEN A THIRD TIME (round 14, seventh challenge N-1, P1, STILL
FAIL-OPEN, in the mirror direction). Round 13 closed "a row excuses a file".
The mirror was open: A FILE'S ABSENCE EXCUSED ITS ROW'S ABSENCE. Delete a frozen
migration AND its manifest row and the derived set simply became smaller, so the
equality held, every remaining digest matched, and the whole gate exited 0 while
reporting "79 files ... all 79 matching". The challenger measured it on
`0050_accounting_report_indexes.sql`, a leaf nothing in the suite references, and
I reproduced it before fixing it. The runner's ledger assertion could not anchor
it either, because it reads its own expectation from the same directory
(`want=$(ls "$MIG"/*.sql | wc -l)`), so `want` and `got` both became 86.

Three rounds, three fail-opens, one shape: the quantity that decides whether
anything is wrong was itself read from the thing under test. git's silence, then
the manifest's completeness, then the directory's own length.

WHAT ANCHORS THE SET NOW. The numbering is the anchor, because it is a property
of the names themselves and is borrowed from nothing: I measured this tree as
`0000`...`0086`, contiguous, no gaps, no duplicate prefixes, every name a
four-digit prefix. So the covered set must be exactly `0000` through `00NN` with
no hole and no repetition, which one equality states:

    nums == list(range(0, len(nums)))

That is deliberately stronger than "no hole between the lowest and the highest".
The weaker form is satisfied by deleting the LOWEST file, which I measured: drop
`0000_extensions.sql` and its row and a hole-between-the-ends test still passes.
Anchoring the low end at zero closes it. A duplicate prefix (two files claiming
one number) and a file renamed into a hole are caught by the same equality,
since either leaves a repetition or a new hole.

    CORRECTION, ROUND 15 (eighth challenge N-1'): the sentence that stood here
    also said "renumbering the whole tail instead would change 80 names and be
    refused by the name equality below". FALSE, and measured false. The tail
    renumber changes as many names as the renumberer chooses — the challenger's
    plant renamed 40, the plant now in the runner renames 79, and both pass —
    and the name equality is not merely unrefused
    but SATISFIED, because the rows are renamed with the files. The claim below
    that "a DELETED file cannot shrink the set it is checked against" was false
    for the same reason: the set shrank 80 -> 79 with the numbering law intact,
    because the law pins the LOW end at zero and takes the HIGH end from the
    set's own length, and `nums == list(range(0, len(nums)))` is as true of
    0..78 as of 0..79. See WHY IT WAS REWRITTEN A FOURTH TIME.

WHY IT WAS REWRITTEN A FOURTH TIME (round 15, eighth challenge N-1', P1).
My own header named the shape of the first three fail-opens: the quantity that
decides whether anything is wrong was read from the thing under test. Each was
closed by moving the anchor OUT — out of git, out of the manifest's rows, out of
the directory's length. `frozenThrough` WAS NEVER MOVED OUT. It is read from the
manifest, it decides WHICH FILES ARE CHECKED AT ALL, and nothing asserted it:
mutants (g) and (h) move it without moving the rows, so both reds come from the
resulting mismatch rather than from the boundary itself. Move it WITH the rows
and two things pass green, both measured here before being fixed:

  * PLANT A, a whole-tail renumber that DELETES a frozen migration. Remove
    `0039_…`, shift `0040`…`0079` each down by one, rename the rows with the
    files, set `frozenThrough` to the new top name: 79 files derived, all 79
    matching, rc=0. No content changed, so every digest matches; the rows were
    renamed, so the equality holds; the numbering law holds as above.
  * PLANT B, a boundary SHRINK that relabels a modified frozen file — round 13's
    S-1 one level up. Edit `0006_rls.sql`, pull `frozenThrough` back to
    `0005_catalog.sql`, drop the rows now beyond it: `6 files derived … all 6
    matching` plus `NOT ATTESTED … 81 files`, rc=0, with the edited RLS
    migration silently re-counted into the not-attested list. At the limit,
    `frozenThrough = 0000_extensions.sql` with one row gives 1 of 1 matching.
    What makes the shrink consequential is this file's own companion rule, which
    is right in itself: beyond the boundary a change is REPORTED, never failed
    on. So moving the boundary moves files out of the only region where
    modification is an error.

HOW THE BOUNDARY IS ANCHORED NOW — OUT, like the other three. The boundary and
the covered set are read from A PINNED COMMIT THIS BRANCH CANNOT MOVE, through
`--git-anchor <sha> --git-dir <path>`, and NOT from the tree under test:

  * `git -C <path> show <sha>:…/MIGRATION_MANIFEST.json` gives the ANCHORED
    `frozenThrough`. The live manifest's value must equal it, or the boundary has
    moved and the check refuses, naming both values.
  * `git -C <path> ls-tree -r --name-only <sha>` gives the anchored FILE LIST.
    The live covered set must equal the anchored set, or files have been added,
    removed or renumbered, and the check refuses, naming each difference.
  * `git -C <path> cat-file blob <sha>:<path>` gives the anchored CONTENT of each
    covered file, so a modification is caught against the pinned commit itself,
    with the manifest's digests kept as a second and independent opinion.

If the anchor commit is unreachable the check REFUSES AND NAMES THAT. It never
falls back to the manifest, because falling back is how the first three
fail-opens worked. This is the Phase 14 lesson in this project's own record: the
witness must not be anchored to anything one commit can change. The anchor is
`93084f8`, Phase 4's integration head, verified here as carrying 87 migration
files with `frozenThrough` = `0079_phase4_pos_till_sessions_cart.sql` and 80
rows — the same figures this tree reports.

Note on method: the gates run from a clean `git archive` copy, which has no
`.git`. So the anchor repository is named explicitly to the runner, which is the
point rather than an inconvenience: the evidence comes from a repository the
archive under test cannot write to, and the anchor SHA is a commit on the shared
remote, so a reviewer on other hardware resolves the same witness.

AND, BESIDE THAT, WHAT THE PACK CLAIMS. `--expect-covered`, `--expect-boundary`
and `--expect-covered-digest` let the caller state the figures it claims to have
attested, each refusing BY NAME on a mismatch, so they sit beside the 87
migrations and 54 cases the runner already asserts. These are WEAKER than the
git anchor and are not a substitute for it: a literal is anchored to its author,
this project's own Phase 4 lesson. They are kept because two independent
statements of the same figure are worth more than one, and the durable form of
them is CI asserting the same numbers, where the author cannot edit the
expectation in the commit that breaks it. That is a patch-request item.

This file still does not judge WHERE the boundary belongs; that is the Migration
Owner's (OD-P8-13). It judges only that the boundary has not MOVED since the
pinned commit.

WHAT IT DOES NOW. The required set is every `.sql` file in the migrations
directory up to and including `frozenThrough` — read off the DIRECTORY. The
manifest supplies digests for that set and nothing else:

  * `frozenThrough` must itself name a file that exists, or the boundary is
    unreadable and nothing below is meaningful;
  * no two manifest rows may name the same file (round 14, N-2): the rows were
    read into a dict, so a SECOND row for one file silently overwrote the first
    and the check reported a pass on a record holding two different digests for
    one name. Anyone who can append a row could have edited the existing one,
    which no digest check can see — but this left the record VISIBLY
    self-inconsistent, where a reviewer diffing the manifest sees an added row
    rather than a changed one, and the one tool whose job is to read that record
    resolved the contradiction without a word;
  * the covered set must satisfy the numbering law above — which refuses a hole,
    a repetition and a deletion at either end, but NOT a coordinated whole-tail
    renumber, for which the caller's expected figures are the guard;
  * the boundary, the covered file list and each covered file's CONTENT must
    match the pinned anchor commit, and an unreachable anchor refuses;
  * where the caller states them, the covered COUNT, the BOUNDARY NAME and the
    concatenated DIGEST of the covered set must match what was measured;
  * the derived set and the manifest's rows must be EQUAL, so a file with no row
    (`UNLISTED`) and a row with no file (`NO SUCH FILE`) each refuse BY NAME;
  * every file in the derived set must match its recorded digest.

Shrinking or widening `frozenThrough` is caught by the same equality, in both
directions, without a separate rule.

WHAT "ATTESTED" MEANS HERE, AND WHAT IT DOES NOT (sixth challenge S-2, P2).
This script attests BYTES AGAINST A RECORDED DIGEST. It does not attest that a
phase is sealed, and it must not be read that way: the manifest's attested range
already INCLUDES six Phase 4 files (`0074`…`0079`), and Phase 4 is unmerged with
its PR open. So the attested range is not the Phase 4 boundary, and the earlier
wording of the "beyond" line — "Phase 4's unsealed range" — was wrong twice
over: it mislabelled the files it listed, and it implied a sealing claim this
file cannot make. `frozenThrough` is also an inherited value that this project
has seen read differently at different commits, so it is reported as read, never
as established. Where the sealing boundary actually lies is the Migration
Owner's to state.

A hole in the files BEYOND `frozenThrough` is reported, not failed on: nothing
there is attested, so refusing it would be a claim this file cannot make.

Usage:  p8-frozen-integrity.py <repo-root>
          [--git-anchor SHA] [--git-dir PATH]
          [--expect-covered N] [--expect-boundary NAME]
          [--expect-covered-digest HEX]
Exit 0 only when the manifest names no file twice, the covered set satisfies the
numbering law, that set equals the manifest's rows, and every file in it matches
its recorded digest. Every other path exits non-zero and names its cause.
"""
import sys

# =====================================================================
# ROUND 23, N-17 (P1, FAIL-OPEN) — THIS BLOCK SITS ABOVE EVERY IMPORT
# =====================================================================
# Python prepends the script's own directory to `sys.path`, and this script
# lives INSIDE the tree it judges. So every module it imports is resolved,
# first, from the subject: `hashlib`, which computes every digest, and
# `subprocess`, which carries every answer git gives about the anchor. The
# fourteenth challenge measured the consequence — a commit that modifies a
# frozen migration AND adds `proof/hashlib.py` exited 0, printed
# `ANCHOR LEG EXERCISED` with the right pin, and reproduced the pinned
# covered-set digest exactly, because that digest is a hash OVER per-file
# digests and every one of them came from the plant. Reproduced here before it
# was fixed.
#
# This is the phase's own defect family one level below its four earlier
# depths: not the quantity read from the subject, but the INSTRUMENT that
# computes it. It is also a standing project lesson from another phase
# (P5 B-9/F-50) which this pack failed to apply.
#
# WHY THE ORDER IS WHAT IT IS. `sys` is a BUILT-IN module, never loaded from a
# file, so it cannot be shadowed by a planted one. That is why it is the only
# name imported above this test, and everything else comes after.
#
# WHY TWO TESTS AND NOT ONE. `sys.flags.isolated` says what was ASKED for;
# whether the script's directory is actually off `sys.path` depends on the
# interpreter's version. The flag alone would pass on an interpreter where `-I`
# does not drop it, leaving the hole open with the guard green — the exact shape
# this phase keeps finding. So the second test MEASURES the path rather than
# trusting the flag.
if not sys.flags.isolated:
    sys.stderr.write(
        "INTEGRITY FAIL: NOT ISOLATED — started without `-I`, so Python put this "
        "program's own directory, which is inside the tree under test, first on "
        "sys.path; every module it needs would then be resolved from the subject "
        "it is judging. Re-run as `python3 -I`. Refusing rather than measuring "
        "with an instrument the subject can supply\n")
    raise SystemExit(1)
import os as _p8os  # noqa: E402  — deliberate: nothing is imported above the test
_P8_OWN_DIR = _p8os.path.dirname(_p8os.path.abspath(__file__))
if any(_p8os.path.abspath(p or ".") == _P8_OWN_DIR for p in sys.path):
    sys.stderr.write(
        "INTEGRITY FAIL: NOT ISOLATED — isolated mode was requested and this "
        "interpreter still has " + _P8_OWN_DIR + " on sys.path, so a module "
        "planted beside this file would be imported in preference to the "
        "standard library. Refusing\n")
    raise SystemExit(1)

import hashlib
import json
import os
import subprocess


# The anchor commit, pinned to all FORTY characters, in the check itself.
#
# ROUND 16, N-1" (route two): this was a seven-character abbreviation supplied by
# the caller, through `--git-anchor` and, in the runner, through an environment
# variable with the abbreviation only as its default. So the check verified that
# whatever commit it was handed agreed with the tree, which is not the same claim
# as the tree agreeing with THE frozen history — measured: naming a forged commit
# directly makes plant (p) exit 0 with no git trickery at all. A literal here is
# not the weak kind this pack already labels weak: a count or a name is a
# PROPERTY that a commit can change and a literal can be edited to match, whereas
# forty hex characters ARE the object's identity, so an editor of this line has to
# produce a commit with that exact hash.
ANCHOR_PIN = "93084f82b8e36ad49ebb207c0b6e7435d7fcb49f"


def _git(gitdir, *args):
    """Run git in the ANCHOR repository, never in the tree under test.

    Returns (rc, stdout_bytes, stderr_text). The caller refuses on rc != 0 and
    never falls back to the manifest: falling back is how the first three
    fail-opens worked.

    ROUND 16, N-1" (route one): every read here is made with replacement objects
    DISABLED, both by argument and by environment. `refs/replace/<the anchor>` in
    the anchor repository redirects exactly the reads this check makes — `show`,
    `ls-tree` and `cat-file` — while `rev-parse --verify` keeps printing the
    honest name, so nothing in the log said anything was wrong. Measured here: a
    forged tree was CONFIRMED, `all 80 matching`, rc=0; the same read with
    replacement off returns the true content. Both switches are set because they
    fail differently — the argument is refused outright by a git too old to know
    it, rather than silently ignored like an unknown environment variable.
    """
    env = dict(os.environ)
    # ROUND 17, N-3: `GIT_DIR` OVERRIDES `-C` — measured: `GIT_DIR=<other>/.git git
    # -C <anchor> rev-parse --absolute-git-dir` prints the OTHER repository. So
    # round 16's refusal could name a repository that demonstrably holds the
    # commit, which is a false sentence even where it fails closed. And
    # `GIT_REPLACE_REF_BASE` moves replacement into a namespace nothing looks at,
    # while `GIT_CONFIG_*` can set `core.useReplaceRefs` from outside the
    # repository — the challenger measured all three. None can steer a read any
    # more: every variable that relocates the repository, its objects or its
    # configuration is REMOVED from the child environment, rather than fought one
    # at a time.
    for name in [n for n in env if n.startswith("GIT_CONFIG")]:
        del env[name]
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
                 "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                 "GIT_CEILING_DIRECTORIES", "GIT_REPLACE_REF_BASE",
                 "GIT_NAMESPACE", "GIT_LITERAL_PATHSPECS"):
        env.pop(name, None)
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    # ROUND 20, R-B: replacement objects were disabled and GRAFTS were not.
    # `<git-dir>/info/grafts` rewrites a commit's parents for every traversal,
    # so one line in the witness turned `merge-base --is-ancestor` from 1 into 0
    # and the round-19 lineage guard accepted a repository descended from
    # nothing. Measured here on an orphan clone: rc 1 before the file, rc 0
    # after it, rc 1 again with this variable set. Grafts are deprecated and
    # still honoured, which is the worst combination — and this project already
    # paid for the same lesson in phase 14. Pointing the variable at an empty
    # file is the documented way to ignore the repository's own.
    env["GIT_GRAFT_FILE"] = os.devnull
    proc = subprocess.run(("git", "--no-replace-objects", "-C", gitdir) + args,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace").strip()


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    # ROUND 17, N-2 (second half): the runner carried its own forty-character
    # literal and printed a claim about THIS one, with nothing reconciling them.
    # The challenger measured the consequence: with the two set to different
    # commits, the authoritative leg passed on a tampered tree while the runner
    # printed "pinned in the check, all forty characters" — false. There is now
    # ONE pin in the pack, here, and every other reader asks for it.
    #
    # ROUND 18, N-5: this was `if "--print-pin" in sys.argv`, a membership test
    # over the WHOLE vector, placed BEFORE the usage check, before --git-dir is
    # read, and before both ARGUMENT INJECTION refusals round 17 added. So the
    # mode flag was a door in front of every door: measured on a tampered tree
    # with a REAL anchor directory and the REAL claim literals, the shipped check
    # printed the pin and exited 0, verifying nothing. The remedy the challenger
    # named: --print-pin is honoured only when it is the ENTIRE request, and in
    # company it is refused by name like any other injected argument.
    argv = sys.argv[1:]
    if argv == ["--print-pin"]:
        print(ANCHOR_PIN)
        return 0
    if "--print-pin" in argv:
        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — --print-pin is a MODE, not an "
                         "option: it asks this check to print its pin and verify nothing, so it "
                         "is honoured only as the entire request. Here it arrived alongside %d "
                         "other argument(s), which is the shape an injected flag takes; refusing "
                         "rather than answering a question nobody asked\n" % (len(argv) - 1))
        return 1
    if not argv or argv[0].startswith("-"):
        sys.stderr.write("usage: p8-frozen-integrity.py <repo-root> --git-dir PATH "
                         "[--git-anchor SHA] [--inner-guards-only] [--expect-covered N] "
                         "[--expect-boundary NAME] [--expect-covered-digest HEX]\n"
                         "       p8-frozen-integrity.py --print-pin\n")
        return 2
    # ROUND 18, N-6: the whole argument vector is now VALIDATED before any of it
    # is read. `_arg` matches an exact element followed by its value, so the
    # `--git-dir=VALUE` spelling was not parsed at all — and while that is
    # fail-closed alone ("no --git-dir was given"), it was NOT fail-closed in
    # company: round 17's incoherence refusal is guarded by `anchor_dir is not
    # None`, and in the = spelling anchor_dir is None, so
    # `--git-dir=<real anchor> --inner-guards-only` exited 0 on a tampered tree.
    # Measured before this fix. An argument this check silently IGNORES is the
    # same hole as an argument it silently PREFERS, so an option-shaped token it
    # does not recognise is refused by name, and so is a repeated option, whose
    # resolution `_arg` was deciding by position alone.
    #
    # ROUND 20, N-8: round 18 validated the argv and then left the READER alone,
    # and a parser and its reader are two parties. `--git-anchor
    # --inner-guards-only` made this loop CONSUME the flag as --git-anchor's
    # value and record no flag at all, while the reader below still asked
    # `"--inner-guards-only" in sys.argv` and saw it — so the anchor leg was
    # turned off by a flag no caller had asked for, at exit 0, on a tampered
    # tree. Measured before this fix. Two changes close it at the root rather
    # than at the membership test:
    #   (1) NO value option may consume an option-shaped token. Round 17 refused
    #       that for --git-dir alone; the hole was the four options it did not
    #       cover.
    #   (2) the parser RECORDS what it parsed, into the local `values` and `seen`
    #       dictionaries, and every reader below reads those. There is one parse
    #       and one consumer, so the two cannot disagree again.
    #
    # ROUND 21, N-15: the helper those readers replaced, `_arg`, was left in the
    # file — dead, and still walking sys.argv, which is exactly the second walk
    # this change exists to remove. It is deleted. The sentence above also named
    # `_argv_values`/`_argv_flags`, which never existed; two local dictionaries
    # did the work. A comment that names a helper the reader cannot find sends
    # the next author looking for it.
    value_opts = ("--git-dir", "--git-anchor", "--expect-covered", "--expect-boundary",
                  "--expect-covered-digest")
    flag_opts = ("--inner-guards-only",)
    i = 1
    seen = {}
    values = {}
    while i < len(argv):
        tok = argv[i]
        if tok in value_opts:
            if i + 1 >= len(argv):
                sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — %s was given with no "
                                 "value, so what it was meant to name cannot be known; refusing "
                                 "rather than falling back to a default this run did not ask "
                                 "for\n" % tok)
                return 1
            val = argv[i + 1]
            if val.startswith("-"):
                sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — %s was given '%s' as its "
                                 "value, which is option-shaped. A value option that CONSUMES a "
                                 "flag is the same hole as one that ignores it: the flag then "
                                 "reaches no parser while still being present on the command "
                                 "line. Refusing rather than deciding by position which of the "
                                 "two the caller meant\n" % (tok, val))
                return 1
            seen[tok] = seen.get(tok, 0) + 1
            values[tok] = val
            i += 2
            continue
        if tok in flag_opts:
            seen[tok] = seen.get(tok, 0) + 1
            i += 1
            continue
        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — unrecognised argument '%s'. This "
                         "check does not parse it, and an argument it IGNORES is the same hole as "
                         "one it silently prefers: the `--git-dir=VALUE` spelling was ignored "
                         "while `--inner-guards-only` beside it was honoured, which turned the "
                         "anchor leg off at exit 0. Use the space-separated spelling; refusing "
                         "rather than proceeding with a vector this check does not "
                         "understand\n" % tok)
        return 1
    repeated = sorted(name for name, n in seen.items() if n > 1)
    if repeated:
        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — %s given more than once, and this "
                         "check reads the FIRST occurrence, so which one governs would be decided "
                         "by position rather than by the caller; refusing\n"
                         % ", ".join(repeated))
        return 1
    repo = argv[0]
    # ROUND 20, N-8: every one of these now comes from `values`/`seen`, which the
    # loop above built and validated. Nothing below re-walks sys.argv.
    anchor_sha = values.get("--git-anchor", ANCHOR_PIN)
    anchor_dir = values.get("--git-dir")
    inner_only = "--inner-guards-only" in seen
    want_covered = values.get("--expect-covered")
    want_boundary = values.get("--expect-boundary")
    want_digest = values.get("--expect-covered-digest")
    mdir = os.path.join(repo, "infrastructure", "database", "migrations")
    mpath = os.path.join(repo, "infrastructure", "database", "MIGRATION_MANIFEST.json")

    # Every failure below is fail-closed and names its own cause, which is the
    # whole point of the file.
    if not os.path.isdir(mdir):
        sys.stderr.write("INTEGRITY FAIL: the migrations directory is not at %s\n" % mdir)
        return 1
    try:
        with open(mpath, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:                                   # noqa: BLE001
        sys.stderr.write("INTEGRITY FAIL: the manifest could not be read: %s\n" % exc)
        return 1
    try:
        rows = [(row["name"], row["sha256"]) for row in manifest["migrations"]]
        frozen_through = manifest["frozenThrough"]
    except Exception as exc:                                   # noqa: BLE001
        sys.stderr.write("INTEGRITY FAIL: the manifest is not the shape this check reads: %s\n" % exc)
        return 1
    # ROUND 14, N-2: this was a dict comprehension, so a second row for one file
    # overwrote the first instead of colliding, and the check passed on a record
    # carrying two different digests for one name.
    recorded = {}
    duplicated = []
    for name, sha in rows:
        # A repeated name is refused whether or not the two digests agree: the
        # record is self-inconsistent either way, and resolving it silently is
        # the defect.
        if name in recorded:
            duplicated.append((name, recorded[name], sha))
        recorded[name] = sha
    if duplicated:
        sys.stderr.write("INTEGRITY FAIL: the manifest names %d file(s) more than once, so it "
                         "records more than one digest for one file\n" % len(duplicated))
        for name, first, second in duplicated:
            sys.stderr.write("  DUPLICATE ROW %s — records %s and %s\n"
                             % (name, first[:16], second[:16]))
        return 1
    if not recorded:
        sys.stderr.write("INTEGRITY FAIL: the manifest records no migration at all\n")
        return 1

    # THE REQUIRED SET IS DERIVED FROM THE DIRECTORY, never enumerated from the
    # manifest — that is S-1's whole lesson. The names are zero-padded and
    # ordered, so "up to frozenThrough" is a comparison on the name.
    on_disk = sorted(f for f in os.listdir(mdir) if f.endswith(".sql"))
    if frozen_through not in on_disk:
        sys.stderr.write("INTEGRITY FAIL: frozenThrough names '%s', which is not a file in %s — "
                         "the attested boundary cannot be located\n" % (frozen_through, mdir))
        return 1
    covered = [f for f in on_disk if f <= frozen_through]
    beyond = [f for f in on_disk if f > frozen_through]

    # ROUND 14, N-1: without this, a DELETED file simply made the set smaller,
    # so every other check still held and the gate exited 0. The numbering is
    # the one anchor that is a property of the names and is borrowed from
    # nothing — not the manifest, not git, not a count recomputed from the
    # directory under test. See the docstring for why the low end is pinned at
    # zero rather than at whatever the lowest surviving file happens to be.
    # ROUND 15, P3-1: this was `.isdigit()`, which is NOT the int-able predicate.
    # `00²6_sneak.sql` passes isdigit() and raises ValueError in int(), so the
    # guard CRASHED where it must refuse — the very distinction fixed one guard
    # over in the previous commit, and the challenger found it from the other
    # side: with this guard patched out, mutant (f) crashes instead of going
    # green. (Measured in passing: `٠٠٠٦` is isdigit AND isdecimal AND int-able to
    # 6, which matters in a project whose domain language is Arabic — so ASCII is
    # required too, because the tree's names are four ASCII digits.)
    unnumbered = [f for f in covered
                  if not (f[:4].isdecimal() and f[:4].isascii())]
    if unnumbered:
        sys.stderr.write("INTEGRITY FAIL: %d covered file(s) do not carry a four-digit "
                         "number, so the numbering cannot anchor the set\n" % len(unnumbered))
        for name in unnumbered:
            sys.stderr.write("  UNNUMBERED    %s\n" % name)
        return 1
    nums = [int(f[:4]) for f in covered]
    if nums != list(range(0, len(nums))):
        expected = set(range(0, max(nums) + 1))
        holes = sorted(expected - set(nums))
        repeated = sorted({n for n in nums if nums.count(n) > 1})
        sys.stderr.write("INTEGRITY FAIL: the covered migrations are not 0000..%04d contiguous — "
                         "%d file(s), %d hole(s), %d repeated number(s)\n"
                         % (max(nums), len(nums), len(holes), len(repeated)))
        for n in holes:
            sys.stderr.write("  MISSING NUMBER %04d — no covered migration carries it, so a "
                             "frozen migration has been removed\n" % n)
        for n in repeated:
            sys.stderr.write("  REPEATED NUMBER %04d — carried by %s\n"
                             % (n, ", ".join(f for f in covered if int(f[:4]) == n)))
        return 1

    unlisted = [f for f in covered if f not in recorded]
    orphaned = [f for f in sorted(recorded) if f not in covered]
    if unlisted or orphaned:
        sys.stderr.write("INTEGRITY FAIL: the manifest's rows are not the set of files to "
                         "attest — %d unlisted, %d orphaned\n" % (len(unlisted), len(orphaned)))
        for name in unlisted:
            sys.stderr.write("  UNLISTED      %s — present, at or below frozenThrough, and the "
                             "manifest records no digest for it\n" % name)
        for name in orphaned:
            why = ("NO SUCH FILE" if name not in on_disk
                   else "a row for a file beyond frozenThrough")
            sys.stderr.write("  ORPHANED ROW  %s — %s\n" % (name, why))
        return 1

    # ---------------------------------------------------------------
    # ROUND 15, N-1': THE BOUNDARY, ANCHORED OUT OF THE TREE UNDER TEST.
    # Everything above still reads `frozenThrough` from the manifest, which is
    # the one quantity never moved out — and moving it WITH the rows passes every
    # check above (plants A and B in the docstring). So the boundary, the file
    # list and the content are read from a PINNED COMMIT instead, in a
    # repository this archive cannot write to. An unreachable anchor REFUSES; it
    # never falls back to the manifest.
    #
    # ROUND 16, N-1": the anchor leg is no longer OPTIONAL to the check. Round 15
    # left "is there an anchor at all?" to the caller, and only the runner
    # insisted — so the check printed its pass line with the leg never exercised,
    # which is the same shape as the finding itself. There is one opt-out, it has
    # to be asked for by name, and it SAYS so in the output: the twelve
    # internal-consistency mutants and the two-arm harness's bare arm are run
    # that way on purpose, and their output must not read like frozen-history
    # evidence.
    #
    # ROUND 17, N-1-TRIPLE-PRIME: the anchor directory was the only
    # caller-controlled string in this check's argument list, and the runner
    # interpolated it UNQUOTED while this function decided the opt-out by a
    # membership test over the whole vector. So the caller chose not merely WHICH
    # repository was read but WHICH ARGUMENTS arrived — including the opt-out
    # introduced one commit earlier. A directory named `--inner-guards-only`, or
    # merely containing it after a space, turned the strongest leg off, and a
    # tampered tree exited 0 printing `ANCHOR LEG NOT EXERCISED`. Measured in both
    # forms before this was written.
    #
    # The runner now passes the path as one quoted argument, which closes the
    # injection at its source. These two refusals are here because the check must
    # not depend on its caller's quoting: any caller that builds a command line
    # gets them.
    if anchor_dir is not None and anchor_dir.startswith("-"):
        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — --git-dir was given '%s', which is "
                         "option-shaped, so the anchor's directory and this check's own flags "
                         "cannot be told apart; refusing rather than reading whatever that "
                         "resolves to\n" % anchor_dir)
        return 1
    if inner_only and anchor_dir is not None:
        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — --inner-guards-only was given "
                         "together with --git-dir '%s'. The combination is incoherent: one asks "
                         "for the anchor leg and the other turns it off, and it is the shape an "
                         "injected flag takes; refusing rather than silently preferring the "
                         "opt-out\n" % anchor_dir)
        return 1
    if inner_only:
        print("ANCHOR LEG NOT EXERCISED (--inner-guards-only): what follows checks the tree "
              "against ITSELF and is NOT evidence that the frozen history is intact.")
    else:
        if not anchor_dir:
            sys.stderr.write("INTEGRITY FAIL: no --git-dir was given, so the frozen boundary has "
                             "no witness outside the tree under test. Pass --git-dir, or ask for "
                             "--inner-guards-only by name; refusing rather than reporting a pass "
                             "on the tree's agreement with itself\n")
            return 1
        rc, out, err = _git(anchor_dir, "rev-parse", "--verify", "%s^{commit}" % anchor_sha)
        if rc != 0:
            sys.stderr.write("INTEGRITY FAIL: the anchor commit %s is not reachable in %s, so the "
                             "boundary has no witness: %s\n" % (anchor_sha, anchor_dir, err))
            return 1
        # ROUND 16, N-1" (route two): `rev-parse --verify` already returns the
        # RESOLVED forty characters, and round 15 discarded them. The resolved
        # value is now compared against the pin, so an anchor that merely
        # resolves is refused; only THE anchor is accepted. This also removes the
        # abbreviation: seven characters name whatever a repository happens to
        # make them mean.
        resolved = out.decode("utf-8", "replace").strip()
        if resolved != ANCHOR_PIN:
            sys.stderr.write("INTEGRITY FAIL: ANCHOR IDENTITY — '%s' resolves to %s in %s, but "
                             "this check is pinned to %s, so that commit is not the frozen "
                             "history's witness whatever it contains\n"
                             % (anchor_sha, resolved, anchor_dir, ANCHOR_PIN))
            return 1
        # Every read below names the RESOLVED pin, not the caller's spelling of
        # it, so nothing downstream can be aimed somewhere else by abbreviation.
        anchor_sha = resolved
        # ROUND 19, the coordinator's fourth follow-up item: the pin must be an
        # ANCESTOR of the anchor repository's HEAD. Until now the only
        # requirement was that the repository CONTAIN the object, and a commit
        # can be in a repository without being in its history at all — fetched
        # by sha, left on a deleted branch, or reachable only from a stash or a
        # note. This says the witness must be a commit the code under review
        # descends FROM, in the same repository, which is the relation the
        # sentence "the frozen history" actually claims.
        #
        # STATED PLAINLY, because the challenger will test it: this does NOT
        # close the pin edit. Someone who edits ANCHOR_PIN to a forged commit
        # can make that commit an ancestor of their own HEAD as easily as they
        # made it exist. It closes a different and smaller thing — an anchor
        # repository that merely holds the object — and PATCH-REQ-P8-08 still
        # carries the pin edit alone.
        #
        # ROUND 20, N-9: `merge-base --is-ancestor` answers from the graph it
        # HAS. A shallow repository has a truncated graph, so it returns 1 — a
        # definite "not an ancestor" — for a commit that IS one. Round 19 wrote
        # the undecided branch below and then could never reach it, because the
        # one genuinely undecidable case arrives wearing a decided answer.
        # Measured with the recipe PATCH-REQ-P8-08 itself used to recommend:
        # `clone --depth 1` then `fetch --depth 1 origin <the forty characters>`
        # leaves the pin PRESENT, `--is-shallow-repository` true, is-ancestor 1,
        # and the truth 0 in a full clone of the same branch. The refusal then
        # said of that checkout that it "happens to hold" the object. It does
        # not: it descends from it. A lie in a refusal is the mirror image of a
        # lie in a pass, so shallowness is probed BEFORE a 1 is believed and is
        # routed to the undecided branch, naming itself.
        #
        # ROUND 21, N-14: this read was `rc == 0 and out == "true"`, which makes
        # a NON-ANSWER mean "not shallow" — and `git rev-parse` ECHOES an option
        # it does not recognise and exits 0 (measured:
        # `rev-parse --is-shallow-repositoryX` prints the word back, rc 0). So on
        # a git without the option the refusal below would assert, in its own
        # parenthetical, that the repository is not shallow when nothing had
        # established it. Only the two literals are answers. Anything else —
        # a non-zero exit, an echoed option, empty output — is UNDECIDED and
        # refuses under its own name, because this whole family of findings is
        # about reading absence as evidence.
        shallow_rc, shallow_out, shallow_err = _git(anchor_dir, "rev-parse",
                                                    "--is-shallow-repository")
        shallow_said = shallow_out.decode("utf-8", "replace").strip()
        if shallow_rc != 0 or shallow_said not in ("true", "false"):
            sys.stderr.write("INTEGRITY FAIL: ANCHOR COMPLETENESS — this git did not answer "
                             "whether %s is a shallow repository (exit %d, output %r%s), so "
                             "whether its ancestry answer can be trusted is UNDECIDED. Refusing "
                             "rather than reading a non-answer as 'not shallow'\n"
                             % (anchor_dir, shallow_rc, shallow_said,
                                (": " + shallow_err) if shallow_err else ""))
            return 1
        shallow = shallow_said == "true"
        rc, _out, err = _git(anchor_dir, "merge-base", "--is-ancestor",
                             anchor_sha, "HEAD")
        if shallow and rc != 0:
            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE — %s is present in %s, but that "
                             "repository is SHALLOW, so git answered the ancestry question from a "
                             "truncated graph (exit %d) and its answer carries no information "
                             "either way. An undecided lineage is not a passed one, and a "
                             "truncated graph's definite 'no' is undecided: pass a complete "
                             "checkout (fetch-depth 0, and no --depth on any later fetch); "
                             "refusing\n" % (anchor_sha, anchor_dir, rc))
            return 1
        if rc == 1:
            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE — %s exists in %s but is NOT an "
                             "ancestor of that repository's HEAD, so it is an object the "
                             "repository happens to hold rather than a commit this code descends "
                             "from; refusing to call it the frozen history's witness. (That "
                             "repository is not shallow, so this is git's answer from a complete "
                             "graph.)\n" % (anchor_sha, anchor_dir))
            return 1
        if rc != 0:
            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE — the ancestry of %s in %s could not "
                             "be decided (git exit %d: %s), and an undecided lineage is not a "
                             "passed one\n" % (anchor_sha, anchor_dir, rc, err.strip()))
            return 1
        rc, out, err = _git(anchor_dir, "show",
                            "%s:infrastructure/database/MIGRATION_MANIFEST.json" % anchor_sha)
        if rc != 0:
            sys.stderr.write("INTEGRITY FAIL: the anchor commit %s has no readable manifest: %s\n"
                             % (anchor_sha, err))
            return 1
        try:
            anchored_boundary = json.loads(out.decode("utf-8"))["frozenThrough"]
        except Exception as exc:                               # noqa: BLE001
            sys.stderr.write("INTEGRITY FAIL: the anchor commit's manifest is not readable as "
                             "JSON with a frozenThrough: %s\n" % exc)
            return 1
        if frozen_through != anchored_boundary:
            sys.stderr.write("INTEGRITY FAIL: the attested boundary has MOVED — this tree says "
                             "'%s', the anchor commit %s says '%s'\n"
                             % (frozen_through, anchor_sha, anchored_boundary))
            return 1
        rc, out, err = _git(anchor_dir, "ls-tree", "-r", "--name-only", anchor_sha,
                            "--", "infrastructure/database/migrations")
        if rc != 0:
            sys.stderr.write("INTEGRITY FAIL: the anchor commit %s has no readable migrations "
                             "listing: %s\n" % (anchor_sha, err))
            return 1
        anchored_all = sorted(os.path.basename(line) for line
                              in out.decode("utf-8").split("\n")
                              if line.strip().endswith(".sql"))
        if not anchored_all:
            sys.stderr.write("INTEGRITY FAIL: the anchor commit %s lists no migration at all\n"
                             % anchor_sha)
            return 1
        anchored_covered = [f for f in anchored_all if f <= anchored_boundary]
        gone = [f for f in anchored_covered if f not in covered]
        extra = [f for f in covered if f not in anchored_covered]
        if gone or extra:
            sys.stderr.write("INTEGRITY FAIL: the covered set does not match the anchor commit %s "
                             "— %d missing, %d unexpected\n" % (anchor_sha, len(gone), len(extra)))
            for name in gone:
                sys.stderr.write("  NOT IN TREE   %s — present at the anchor commit, absent or "
                                 "renumbered here\n" % name)
            for name in extra:
                sys.stderr.write("  NOT ANCHORED  %s — present here, not at the anchor commit\n"
                                 % name)
            return 1
        # The anchored CONTENT, so a modification is caught against the pinned
        # commit itself and not only against the manifest's record of it.
        drifted = []
        for name in covered:
            rc, blob, err = _git(anchor_dir, "cat-file", "blob",
                                 "%s:infrastructure/database/migrations/%s" % (anchor_sha, name))
            if rc != 0:
                drifted.append((name, "unreadable at the anchor commit: %s" % err))
                continue
            here = digest(os.path.join(mdir, name))
            there = hashlib.sha256(blob).hexdigest()
            if here != there:
                drifted.append((name, "here %s, anchor %s" % (here[:16], there[:16])))
        if drifted:
            sys.stderr.write("INTEGRITY FAIL: %d covered file(s) differ from the anchor commit "
                             "%s\n" % (len(drifted), anchor_sha))
            for name, why in drifted:
                sys.stderr.write("  ANCHOR DRIFT  %s — %s\n" % (name, why))
            return 1

    bad = []
    for name in covered:
        path = os.path.join(mdir, name)
        try:
            got = digest(path)
        except Exception as exc:                               # noqa: BLE001
            bad.append((name, "unreadable: %s" % exc))
            continue
        if name not in recorded:
            # Unreachable while the equality above holds, and deliberately not
            # left to raise: the challenger observed (round 14) that with that
            # guard removed, mutants (e) and (f) exited 1 through an uncaught
            # KeyError rather than through a named refusal. A crash and a
            # refusal are not the same evidence, so this names it too.
            bad.append((name, "the manifest records no digest for it"))
            continue
        if got != recorded[name]:
            bad.append((name, "digest %s, manifest records %s"
                        % (got[:16], recorded[name][:16])))
    if bad:
        sys.stderr.write("INTEGRITY FAIL: %d of %d attested files do not match\n"
                         % (len(bad), len(covered)))
        for name, why in bad:
            sys.stderr.write("  MODIFIED      %s — %s\n" % (name, why))
        return 1

    # ---------------------------------------------------------------
    # ROUND 15, N-1' (second leg): WHAT THE PACK CLAIMS, ASSERTED BY NAME.
    # These three literals are WEAKER than the git anchor above and are not a
    # substitute for it — a literal travels in the same commit as the change it
    # would catch, which is this project's own Phase 4 lesson (P14 B2). They are
    # here so that the pack states the figures it rests on, and so that a reader
    # of the gate log sees the boundary name and the count rather than inferring
    # them. Each refuses BY NAME and never widens into a pass.
    covered_digest = hashlib.sha256()
    for name in covered:
        covered_digest.update(recorded[name].encode())
    covered_digest = covered_digest.hexdigest()
    claimed = []
    if want_covered is not None:
        try:
            n_want = int(want_covered)
        except ValueError:
            sys.stderr.write("INTEGRITY FAIL: --expect-covered '%s' is not a number\n"
                             % want_covered)
            return 1
        if len(covered) != n_want:
            claimed.append("COVERED COUNT  expected %d, measured %d"
                           % (n_want, len(covered)))
    if want_boundary is not None and frozen_through != want_boundary:
        claimed.append("BOUNDARY NAME  expected '%s', measured '%s'"
                       % (want_boundary, frozen_through))
    if want_digest is not None and covered_digest != want_digest:
        claimed.append("COVERED DIGEST expected %s, measured %s"
                       % (want_digest, covered_digest))
    if claimed:
        sys.stderr.write("INTEGRITY FAIL: the covered set is internally consistent but is NOT "
                         "the set this pack claims to attest — %d claim(s) falsified\n"
                         % len(claimed))
        for line in claimed:
            sys.stderr.write("  %s\n" % line)
        return 1

    # ROUND 17, N-2: on success this check used to print nothing saying the
    # anchor leg had RUN, so the gate's evidence for its strongest leg was an
    # ABSENCE — and an absence is what every fail-open in this phase has looked
    # like from the outside. The leg now announces itself, with the pin it used,
    # the directory it read and the counts it compared, and the runner REQUIRES
    # this token in the authoritative log rather than inferring it from a quiet
    # exit 0.
    if not inner_only:
        print("ANCHOR LEG EXERCISED: pin=%s dir=%s covered=%d anchored=%d boundary=%s"
              % (anchor_sha, anchor_dir, len(covered), len(anchored_covered), frozen_through))
    print("covered-set digest (sha256 over the recorded digests, in name order): %s"
          % covered_digest)
    print("frozen integrity: %d files derived from the directory up to frozenThrough "
          "(read as %s), all %d matching the manifest's recorded digests"
          % (len(covered), frozen_through, len(covered)))
    if beyond:
        # Stated, not folded in, and NOT described as a phase boundary: the
        # attested range above already contains six Phase 4 files, so what is
        # below is simply outside the manifest's coverage. See S-2 in the
        # docstring.
        joined = hashlib.sha256()
        for name in beyond:
            joined.update(digest(os.path.join(mdir, name)).encode())
        print("NOT ATTESTED (beyond the manifest's coverage): %d files, concatenated digest %s"
              % (len(beyond), joined.hexdigest()))
        bn = [int(f[:4]) for f in beyond
              if f[:4].isdecimal() and f[:4].isascii()]
        if bn:
            bholes = [n for n in range(min(bn), max(bn) + 1) if n not in bn]
            if bholes or len(bn) != len(beyond):
                # Reported, never failed on: nothing out here is attested, so
                # refusing would be a claim this file cannot make.
                print("NOTE: the un-attested range is not contiguous (%s) — this is reported, not "
                      "failed on, because nothing beyond the manifest's coverage is attested"
                      % (", ".join("%04d" % n for n in bholes) or "a name without a number"))
        print("NOTE: the attested range already includes Phase 4 files, so these digests attest "
              "BYTES against a record, not that any phase is sealed; the sealing boundary is the "
              "Migration Owner's to state.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
