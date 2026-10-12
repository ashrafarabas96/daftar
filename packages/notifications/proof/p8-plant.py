#!/usr/bin/env python3
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
import json
import os
import shutil
import sys

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
