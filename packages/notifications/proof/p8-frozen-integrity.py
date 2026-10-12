#!/usr/bin/env python3
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
since either leaves a repetition or a new hole, and renumbering the whole tail
instead would change 80 names and be refused by the name equality below.

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
  * the covered set must satisfy the numbering law above, so a DELETED file
    cannot shrink the set it is checked against;
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
Exit 0 only when the manifest names no file twice, the covered set satisfies the
numbering law, that set equals the manifest's rows, and every file in it matches
its recorded digest. Every other path exits non-zero and names its cause.
"""
import hashlib
import json
import os
import sys


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: p8-frozen-integrity.py <repo-root>\n")
        return 2
    repo = sys.argv[1]
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
    unnumbered = [f for f in covered if not f[:4].isdigit()]
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
        bn = [int(f[:4]) for f in beyond if f[:4].isdigit()]
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
