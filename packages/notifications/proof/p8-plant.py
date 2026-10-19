#!/usr/bin/env -S python3 -I
"""Apply one named plant to the MIGRATIONS COPY in the current directory.

ROUND 15. These three plants exist because of N-1': every guard in
`p8-frozen-integrity.py` up to round 14 read the attested boundary from the
manifest, which is the thing under test. A change that moves the boundary AND
the rows together therefore left the check internally consistent, and it exited
0 — measured, twice, by the eighth challenge and again here.

They are plants, not utilities: each one produces a tree the round-14 check
calls correct. They run ONLY against a sandbox copy. Nothing here writes to
`infrastructure/database/migrations` in a real tree, and the frozen files are
byte-immutable even for mutation testing — a plant that renames or drops is
operating on a copy, which is the only form this project permits.

  tail-renumber   The challenger's plant A. Drop the lowest migration and shift
                  every remaining covered name down by one, carrying the manifest
                  rows and the boundary with it. The result is contiguous from
                  0000, every digest matches its (renamed) row, and the boundary
                  names a file that exists. Nothing inside the tree disagrees
                  with anything else inside the tree.

  boundary-shrink The challenger's plant B. Move the boundary down to the sixth
                  migration and delete every row above it. 6 covered files, 6
                  rows, all matching; the other 81 files are simply reported as
                  beyond the manifest's coverage.

  limit-one       The coordinator's limit case. The boundary at 0000 with a
                  single row. The numbering law is satisfied by [0] — it pins the
                  low end, which is what round 14 added, and this is the case
                  that shows pinning the low end alone is not enough.
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
        "PLANT FAIL: NOT ISOLATED — started without `-I`, so Python put this "
        "program's own directory, which is inside the tree under test, first on "
        "sys.path; every module it needs would then be resolved from the subject "
        "it is judging. Re-run as `python3 -I`. Refusing rather than measuring "
        "with an instrument the subject can supply\n")
    raise SystemExit(1)
import os as _p8os  # noqa: E402  — deliberate: nothing is imported above the test
# ROUND 24, O-1 (round 15's challenge). The first version of this test compared
# path SPELLING. `abspath` normalises `.`, `..` and repeated slashes but never
# resolves a symlink, so a `sys.path` entry that is a SYMLINK to this very
# directory compared unequal, the test passed, and the challenger measured
# round 14's whole fail-open returning through it — with the refusal's own
# sentence, "a module planted beside this file would be imported in preference
# to the standard library", true of the case it let through. Identity is what
# the test is about, so both sides are resolved with `realpath`. `abspath` stays
# because `realpath` of a relative entry still has to be taken against the
# working directory, and the refusal now names BOTH spellings: the entry as
# written and what it resolves to.
_P8_OWN_DIR = _p8os.path.dirname(_p8os.path.abspath(__file__))
_P8_OWN_REAL = _p8os.path.realpath(_P8_OWN_DIR)


def _p8_own_dir_match(entry):
    """Which reading says this sys.path entry IS this directory? None if neither.

    Two independent readings, because each catches a case the other cannot, and
    the caller is told WHICH one matched — a refusal that names the wrong reason
    is how the round-24 version of this comment came to be false.

    `realpath` resolves symlinks, so it catches the plain spelling, a symlinked
    spelling and a relative one. `samefile` compares device and inode, so it
    catches a BIND MOUNT of this directory.

    **ROUND 25 CORRECTION, and it was a P1 measured-false claim.** Round 24 said
    here that the `samefile` reading was UNEXERCISED because a bind mount "is
    caught by the `realpath` reading — on this kernel the bind path resolves
    through to the source". That is wrong, as the sixteenth challenge measured
    and as was reproduced here before this was written:

        realpath(bindpoint) = /…/bindpoint      realpath(src) = /…/proof
        realpath equal      = False             samefile      = True

    **`realpath` resolves symlinks; it does not traverse mount points.** So the
    bind mount is caught by `samefile` ALONE, this reading is the only thing
    standing between that spelling and the planted module, and an arm for it is
    three lines rather than impossible.

    **ROUND 27 CORRECTION (the coordinator's F-1, P1).** This paragraph used to
    end "Arm `y20` deletes this reading alone", and that was false of THIS file:
    every `y20` arm patches `p8-frozen-integrity.py`, and deleting the
    `samefile` reading in this copy left gate 6 at `FAILED=0` — a sentence that
    credits an arm to a file no arm touches, which is round 24's defect family
    one file over. The arms for this copy are `y21a` and `y21b`: the first
    requires this program to refuse the bind spelling by its OWN name and to
    say `matched by samefile`, the second deletes that reading here alone and
    requires the refusal to go away. The gate also holds this block
    byte-identical across the three programs, so an arm on one keeps meaning
    something about the others.

    What produced the false sentence is the defect below it (round 16's R-2):
    the refusal printed `_P8_OWN_REAL`, this file's own directory, under the
    words "which resolves to", so the bind case LOOKED like a `realpath` match
    in the one place a reader would check. The message now prints
    `realpath(entry)` and names the reading that matched.

    An entry that does not exist is not this directory, and `samefile` raises on
    it, so that is the only error swallowed here.
    """
    # <<< P8-IDENTITY-GUARD-BEGIN >>>
    absolute = _p8os.path.abspath(entry or ".")
    if _p8os.path.realpath(absolute) == _P8_OWN_REAL:
        return "realpath"
    try:
        if _p8os.path.samefile(absolute, _P8_OWN_DIR):
            return "samefile"
    except OSError:
        pass
    return None


_p8_hit = None
_p8_hit_by = None
for _p8_entry in sys.path:
    _p8_hit_by = _p8_own_dir_match(_p8_entry)
    if _p8_hit_by is not None:
        _p8_hit = _p8_entry
        break
if _p8_hit_by is not None:
    sys.stderr.write(
        "PLANT FAIL: NOT ISOLATED — isolated mode was requested and this "
        "interpreter still has " + repr(_p8_hit) + " on sys.path, which IS this "
        "program's own directory " + _P8_OWN_DIR + " — matched by " + _p8_hit_by +
        "; realpath(entry) = " + _p8os.path.realpath(_p8os.path.abspath(_p8_hit or ".")) +
        ". A module planted beside this file would be imported in preference to "
        "the standard library. Refusing\n")
    raise SystemExit(1)
# <<< P8-IDENTITY-GUARD-END >>>
import json
import os
import shutil


MDIR = os.path.join("infrastructure", "database", "migrations")
MPATH = os.path.join("infrastructure", "database", "MIGRATION_MANIFEST.json")

# ROUND 28, F-C — THE WORST DEFECT THIS PHASE HAS FOUND IN ITS OWN APPARATUS.
# This program renames and deletes files under the CURRENT DIRECTORY, and it had
# nothing but the identity guard above between it and a real tree. The arm that
# deletes that guard (`y21b`) then ran it with the caller's cwd: from the
# repository root the coordinator's review measured the first run at rc 0, with
# **the 80 frozen migrations renumbered and MIGRATION_MANIFEST.json rewritten**,
# and the second run at rc 1 because the boundary had moved. The frozen set is
# BYTE-IMMUTABLE by standing instruction — including for mutation testing — so a
# guard-deletion control that can reach it is not a control, it is the failure
# it was built to prevent.
#
# A plant therefore operates ONLY on a tree that DECLARES ITSELF disposable.
# The marker is positive and the refusal is by name: no marker, no plant, and a
# caller that forgot to make a copy is told so instead of modifying the one
# tree that must never change. The runner writes this file into every copy it
# makes; the repository does not contain it and must not.
SANDBOX = os.path.join("infrastructure", "database", ".p8-sandbox")
SANDBOX_TOKEN = "P8 PLANT SANDBOX — a disposable copy; this file is never committed"


def load():
    with open(MPATH, encoding="utf-8") as fh:
        return json.load(fh)


def save(m):
    with open(MPATH, "w", encoding="utf-8") as fh:
        json.dump(m, fh, indent=2)


def covered_names(m):
    on_disk = sorted(f for f in os.listdir(MDIR) if f.endswith(".sql"))
    return [f for f in on_disk if f <= m["frozenThrough"]]


def tail_renumber():
    m = load()
    cov = covered_names(m)
    rows = {r["name"]: r["sha256"] for r in m["migrations"]}
    lowest = cov[0]
    os.remove(os.path.join(MDIR, lowest))
    rename = {}
    for name in cov[1:]:
        new = "%04d%s" % (int(name[:4]) - 1, name[4:])
        rename[name] = new
    # Rename in ascending order so each target is already free.
    for name in cov[1:]:
        shutil.move(os.path.join(MDIR, name), os.path.join(MDIR, rename[name]))
    kept = [{"name": rename[n], "sha256": rows[n]} for n in cov[1:] if n in rows]
    beyond = [r for r in m["migrations"] if r["name"] not in rows or r["name"] not in cov]
    beyond = [r for r in beyond if r["name"] not in cov]
    m["migrations"] = kept + beyond
    m["frozenThrough"] = rename[cov[-1]]
    save(m)
    print("renamed %d, frozenThrough -> %s, rows %d"
          % (len(rename), m["frozenThrough"], len(m["migrations"])))


def shrink_to(index):
    m = load()
    cov = covered_names(m)
    boundary = cov[index]
    keep = set(cov[:index + 1])
    m["migrations"] = [r for r in m["migrations"] if r["name"] in keep]
    m["frozenThrough"] = boundary
    save(m)
    print("frozenThrough -> %s, rows -> %d" % (boundary, len(m["migrations"])))


PLANTS = {
    "tail-renumber": tail_renumber,
    "boundary-shrink": lambda: shrink_to(5),
    "limit-one": lambda: shrink_to(0),
}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in PLANTS:
        sys.stderr.write("usage: p8-plant.py {%s}\n" % "|".join(sorted(PLANTS)))
        sys.exit(2)
    if not os.path.isdir(MDIR) or not os.path.isfile(MPATH):
        sys.stderr.write("refusing: no migrations copy in %s\n" % os.getcwd())
        sys.exit(2)
    # The sandbox requirement, BEFORE anything is renamed or removed.
    try:
        with open(SANDBOX, encoding="utf-8") as fh:
            declared = fh.read().strip()
    except OSError:
        declared = None
    if declared != SANDBOX_TOKEN:
        sys.stderr.write(
            "PLANT FAIL: NOT A SANDBOX — this program renames and deletes "
            "frozen migration files, and the tree at " + os.getcwd() + " does "
            "not declare itself a disposable copy: " + SANDBOX + " is "
            + ("absent" if declared is None else "present but does not carry the token")
            + ". The frozen set is byte-immutable, including for mutation "
              "testing, so a plant refuses rather than trusts its working "
              "directory (round 28, F-C: a guard-deletion arm ran this from the "
              "repository root and renumbered all 80 frozen migrations)\n")
        sys.exit(2)
    PLANTS[sys.argv[1]]()
