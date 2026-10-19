"""The harness's deciding files, read against THE COMMIT by a second reader.

WHY THIS FILE EXISTS, in two steps, because the first answer was wrong.

Rounds 11 to 20 closed eight escapes one shape at a time, each fix a rule about
a SHAPE inside four parsed functions. The coordinator's twenty-first review
walked out through a shape no rule covered -- a DEFAULT ARGUMENT:

    -def scan(docs_dir, harness_dir, quiet=False, skip=()):
    +def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):

The real call passes no `skip`, so that line switches a named guard off for
every run. The first answer was this file, pinning every harness byte against a
TABLE held in the manifest. The independent challenger's round 21 then measured
the same class again one level up: the matcher's constants were pinned by a
digest held as a literal in the file the plant edits, and the refusal text told
the maintainer how to move it. Two edits -- one of them prescribed by the error
message -- reopened the escape with every gate at 0.

**A pin inside the thing it pins is not a pin, and a table a planter edits in
the same commit is the same mistake with one more file in it.** So the pin is
gone and so is the table. The authority is THE COMMIT:

    every deciding file's bytes must equal `git show <resolved sha>:<path>`

read here by a reader that shares NO CODE with `check_fenced_figures.py` --
imports nothing from it, parses nothing it parses -- and is itself one of the
deciding files, so editing this file to lie moves its own blob.

WHAT THIS DOES NOT DO, stated here rather than in a footnote: it does not stop a
planter who COMMITS. Nothing executable can. What it changes is that an escape
from any round between 16 and 21 -- a gitignored artefact, an AST gap, a
receiver, a rebound attribute, an argument, a re-pin, an added admit-list entry
-- has to be in the diff, under the published digest, in front of the
independent challenger and the coordinator. That is the whole of the guarantee,
and it is why this phase's chain has three links.

NO REFUSAL BELOW TELLS ITS READER HOW TO SATISFY IT. The previous version said
"run `--emit` and commit the table it prints", and a refusal that prescribes the
step that silences it is a manual, not a law. These name what moved and stop.

Run it as `python3 -I check_harness_bytes.py`. Exit 0 = every deciding file is
the file the commit holds; exit 5 = a named refusal.
"""

import sys

if not sys.flags.isolated:
    sys.stderr.write(
        "HARNESS-BYTES-NOT-ISOLATED: this reader must run under `python3 -I`. Without "
        "it the interpreter puts the script's own directory on `sys.path`, and that "
        "directory is the harness it is reading -- a planted `hashlib.py` beside the "
        "subject would be imported by the instrument measuring the subject. Refusing "
        "rather than re-executing, because a re-exec reads the target a second time.\n"
    )
    raise SystemExit(5)

import hashlib
import os
import subprocess

DECIDING_SUFFIXES = (".py", ".sh", ".sql")
FULL_SHA = 40


def _here():
    return os.path.dirname(os.path.realpath(__file__))


def _git(root, argv):
    """git, with the environment built from scratch rather than inherited.

    Phase 14's lesson, applied here because this reader's whole answer comes out
    of git: a tool that sets two environment keys still inherits the rest. Every
    `GIT_*` key is dropped, object replacement and grafts are disabled, and the
    `PATH` is pinned -- otherwise a planted `git` earlier on the path, or a
    `GIT_DIR` in the environment, answers for the subject.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["PATH"] = "/usr/bin:/bin:/usr/local/bin"
    env["GIT_GRAFT_FILE"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["HOME"] = os.devnull
    got = subprocess.run(
        ["/usr/bin/git", "--no-replace-objects", "-C", root] + list(argv),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        timeout=120,
    )
    if got.returncode != 0:
        raise RuntimeError(
            "git %s in %s exited %d: %s"
            % (" ".join(argv), root, got.returncode, got.stderr.decode("utf-8", "replace").strip())
        )
    return got.stdout


def _deciding_files(harness_dir):
    out = []
    for root, dirs, names in os.walk(harness_dir, followlinks=True):
        dirs.sort()
        for n in sorted(names):
            if n.endswith(DECIDING_SUFFIXES):
                out.append(os.path.relpath(os.path.join(root, n), harness_dir))
    return sorted(out)


def check(harness_dir=None):
    """(ok, refusals) that every deciding file is the file the commit holds."""
    harness_dir = harness_dir or _here()
    try:
        top = os.path.realpath(
            _git(harness_dir, ["rev-parse", "--show-toplevel"]).decode("utf-8", "replace").strip()
        )
        sha = _git(harness_dir, ["rev-parse", "--verify", "HEAD^{commit}"]).decode(
            "ascii", "replace"
        ).strip()
    except (RuntimeError, OSError) as exc:
        return False, (
            "HARNESS-ANCHOR-UNRESOLVED: the deciding files are read against the commit "
            "and the commit could not be resolved (%s)." % exc,
        )
    if len(sha) != FULL_SHA:
        return False, (
            "HARNESS-ANCHOR-UNRESOLVED: `rev-parse --verify HEAD^{commit}` returned %r, "
            "which is not a full 40-character object name." % sha,
        )
    rel_root = os.path.relpath(os.path.realpath(harness_dir), top)
    try:
        listed = _git(
            top, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", sha, "--", rel_root]
        ).decode("utf-8", "surrogateescape")
    except (RuntimeError, OSError) as exc:
        return False, (
            "HARNESS-ANCHOR-UNRESOLVED: commit %s could not be listed under %s (%s)."
            % (sha[:12], rel_root, exc),
        )
    tracked = {
        n for n in listed.split("\0") if n and n.endswith(DECIDING_SUFFIXES)
    }
    found = _deciding_files(harness_dir)
    msgs = []
    for n in found:
        rel = os.path.relpath(os.path.realpath(os.path.join(harness_dir, n)), top)
        if rel not in tracked:
            msgs.append(
                "HARNESS-FILE-UNCOMMITTED: `%s` is a deciding file this harness can "
                "execute and commit %s does not hold it." % (rel, sha[:12])
            )
            continue
        try:
            blob = _git(top, ["show", "%s:%s" % (sha, rel)])
        except (RuntimeError, OSError) as exc:
            msgs.append(
                "HARNESS-BLOB-UNREADABLE: `%s` is held by commit %s and could not be "
                "read from the object store (%s)." % (rel, sha[:12], exc)
            )
            continue
        try:
            with open(os.path.join(harness_dir, n), "rb") as fh:
                disk = fh.read()
        except OSError as exc:
            msgs.append(
                "HARNESS-BYTES-UNREADABLE: `%s` is a deciding file and could not be "
                "read (%s)." % (rel, exc)
            )
            continue
        if hashlib.sha256(disk).hexdigest() != hashlib.sha256(blob).hexdigest():
            msgs.append(
                "HARNESS-BYTES-UNCOMMITTED: `%s` on disk digests to %s and commit %s "
                "holds %s. What moved is the working tree, not the commit."
                % (
                    rel,
                    hashlib.sha256(disk).hexdigest()[:12],
                    sha[:12],
                    hashlib.sha256(blob).hexdigest()[:12],
                )
            )
    on_disk = {
        os.path.relpath(os.path.realpath(os.path.join(harness_dir, n)), top) for n in found
    }
    for rel in sorted(tracked - on_disk):
        msgs.append(
            "HARNESS-FILE-ABSENT: commit %s holds the deciding file `%s` and it is not "
            "under the harness. A run with an instrument missing is not a run with one "
            "fewer rule." % (sha[:12], rel)
        )
    return not msgs, tuple(msgs)


def digests(harness_dir=None):
    """The committed digest of each deciding file, for publication."""
    harness_dir = harness_dir or _here()
    top = os.path.realpath(
        _git(harness_dir, ["rev-parse", "--show-toplevel"]).decode("utf-8", "replace").strip()
    )
    sha = _git(harness_dir, ["rev-parse", "--verify", "HEAD^{commit}"]).decode(
        "ascii", "replace"
    ).strip()
    rows = []
    for n in _deciding_files(harness_dir):
        rel = os.path.relpath(os.path.realpath(os.path.join(harness_dir, n)), top)
        try:
            blob = _git(top, ["show", "%s:%s" % (sha, rel)])
        except (RuntimeError, OSError):
            continue
        rows.append("%s  %s" % (hashlib.sha256(blob).hexdigest(), n))
    return sha, rows


def _main(argv):
    harness_dir = None
    want_digests = False
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a == "--digests":
            want_digests = True
        elif a == "--harness" and rest:
            harness_dir = rest.pop(0)
        else:
            sys.stderr.write("usage: [--digests] [--harness DIR]\n")
            return 2
    if want_digests:
        sha, rows = digests(harness_dir)
        print("the deciding files as commit %s holds them:" % sha)
        for r in rows:
            print(r)
        return 0
    ok, msgs = check(harness_dir)
    if ok:
        n = len(_deciding_files(harness_dir or _here()))
        print("HARNESS-BYTES OK: %d deciding files are the files the commit holds" % n)
        return 0
    for m in msgs:
        print("REFUSED: %s" % m)
    return 5


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
