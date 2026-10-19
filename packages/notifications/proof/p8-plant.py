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


def _p8_is_own_dir(entry):
    """Is this sys.path entry THIS directory, however it is spelled?

    Two independent readings, because each catches what the other cannot.
    `realpath` resolves symlinks and so answers for a symlinked spelling even
    when the directory has been removed from under us. `samefile` compares the
    device and inode, which answers for a BIND MOUNT of the same directory —
    whose `realpath` is genuinely different while the directory is the same one.
    An entry that does not exist is not this directory, and `samefile` raises on
    it, so that is the only error swallowed here.

    **The `samefile` reading is UNEXERCISED at runtime, and is named as such
    rather than reported as proved.** Measured in this container: a bind mount
    of this directory IS caught, but by the `realpath` reading — on this kernel
    the bind path resolves through to the source — so no arm distinguishes the
    second reading. It is kept because a platform whose bind path does not
    resolve through would otherwise be a hole, and the alternative is code with
    a silent gap rather than a named one. Arms y16 and y17 exercise the
    `realpath` reading on the plain and symlinked spellings; y18 deletes this
    whole test alone and shows the fail-open return.
    """
    absolute = _p8os.path.abspath(entry or ".")
    if _p8os.path.realpath(absolute) == _P8_OWN_REAL:
        return True
    try:
        return _p8os.path.samefile(absolute, _P8_OWN_DIR)
    except OSError:
        return False


_p8_hit = next((p for p in sys.path if _p8_is_own_dir(p)), None)
if _p8_hit is not None:
    sys.stderr.write(
        "PLANT FAIL: NOT ISOLATED — isolated mode was requested and this "
        "interpreter still has " + repr(_p8_hit) + ", which resolves to " +
        _P8_OWN_REAL + ", on sys.path, so a module planted beside this file "
        "would be imported in preference to the standard library. Refusing\n")
    raise SystemExit(1)
import json
import os
import shutil


MDIR = os.path.join("infrastructure", "database", "migrations")
MPATH = os.path.join("infrastructure", "database", "MIGRATION_MANIFEST.json")


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
    PLANTS[sys.argv[1]]()
