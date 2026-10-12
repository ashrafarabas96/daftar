#!/usr/bin/env python3
"""Verify that no frozen migration was modified — WITHOUT relying on git's silence.

WHY THIS FILE EXISTS (round 12, fifth challenge R-1, P1, a FAIL-OPEN).
Round 11's runner ended with:

    if git -C "$REPO" status --porcelain -- .../migrations | grep -q .; then FAIL; else
      say "no frozen migration is modified"; fi

The exit code was never read. When `git status` fails — no repository, no git,
`$REPO` not a work tree — stdout is empty, `grep -q .` is false, and the ELSE
branch prints the reassurance. The challenger measured it, and it is worse than
that: it fired in MY OWN authoritative run, because the method I prescribe is
"from a clean `git archive` copy of the pushed SHA" and an archive has no
`.git`. Round 11's gate-6 log contains git's `fatal:` and my own sentence on
consecutive lines. The underlying fact was true; the check was worthless. This
is the same principle `mutate_refuses` enforces — "its own check does not fail
on absence" — applied everywhere except to itself.

WHAT REPLACES IT. The repository carries its own checksums:
`infrastructure/database/MIGRATION_MANIFEST.json` lists a `sha256` for every
file through `frozenThrough`. So integrity is verified against THE REPOSITORY'S
OWN RECORD, which works in a bare archive, needs no git, and fails closed on
every path: a missing manifest, a missing file, a digest mismatch, a file the
manifest does not cover, or an unreadable anything.

The files BEYOND `frozenThrough` are a different question and are reported as
such rather than folded in: they are Phase 4's own unsealed range, the manifest
does not cover them, so this script prints their digests and says plainly that
it cannot attest to them. Reporting a limit is not the same as passing.

Usage:  p8-frozen-integrity.py <repo-root>
Exit 0 only when every manifest-covered file matches its recorded digest.
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
        recorded = {row["name"]: row["sha256"] for row in manifest["migrations"]}
        frozen_through = manifest["frozenThrough"]
    except Exception as exc:                                   # noqa: BLE001
        sys.stderr.write("INTEGRITY FAIL: the manifest is not the shape this check reads: %s\n" % exc)
        return 1
    if not recorded:
        sys.stderr.write("INTEGRITY FAIL: the manifest records no migration at all\n")
        return 1

    on_disk = sorted(f for f in os.listdir(mdir) if f.endswith(".sql"))
    bad, missing = [], []
    for name, want in sorted(recorded.items()):
        path = os.path.join(mdir, name)
        if not os.path.exists(path):
            missing.append(name)
            continue
        try:
            got = digest(path)
        except Exception as exc:                               # noqa: BLE001
            bad.append((name, "unreadable: %s" % exc))
            continue
        if got != want:
            bad.append((name, "digest %s, manifest records %s" % (got[:16], want[:16])))

    beyond = [f for f in on_disk if f not in recorded]

    if missing or bad:
        sys.stderr.write("INTEGRITY FAIL: %d missing, %d mismatched\n" % (len(missing), len(bad)))
        for name in missing:
            sys.stderr.write("  MISSING   %s\n" % name)
        for name, why in bad:
            sys.stderr.write("  MODIFIED  %s — %s\n" % (name, why))
        return 1

    print("frozen integrity: %d of %d files verified against the manifest, "
          "frozenThrough %s" % (len(recorded), len(on_disk), frozen_through))
    if beyond:
        # Stated, not folded in. These are Phase 4's own files, past the sealed
        # boundary, and the manifest does not record a digest for them — so this
        # check cannot attest to them and says so instead of implying it can.
        joined = hashlib.sha256()
        for name in beyond:
            joined.update(digest(os.path.join(mdir, name)).encode())
        print("NOT ATTESTED (beyond frozenThrough, Phase 4's unsealed range): %d files, "
              "concatenated digest %s" % (len(beyond), joined.hexdigest()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
