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
    # `R22-S3`. Dropping every `GIT_*` key is not the whole environment: the
    # GLOBAL config is found through `HOME` *and* through `XDG_CONFIG_HOME`,
    # which is not a `GIT_*` key and survived the scrub, so an injected global
    # config reached this reader and not the older one. The challenger measured
    # the content route CLOSED -- `git show` applies no smudge filter and a
    # global `core.worktree` does not move `rev-parse --show-toplevel` -- so
    # this is the asymmetry closed, not an escape patched: the older reader's
    # own hardening, missing from the reader whose whole answer comes out of git.
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["XDG_CONFIG_HOME"] = os.devnull
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


class Anchor(Exception):
    """A named refusal while resolving the commit the deciding files are read from."""


def _census_top(subject):
    """The ONE repository that contains the subject, derived STRUCTURALLY.

    `F2`, the coordinator's third review: this reader used to ask git for the
    toplevel (`rev-parse --show-toplevel` from the harness directory) and take
    the answer. An UNTRACKED nested `.git` inside the harness, with the plant
    committed into it, therefore answered for the subject and this reader
    returned 0 -- the chain stayed red only because the other reader refused.
    An independent second reader that can be redirected by the subject is not
    independent in the only direction that matters.

    So the anchor is derived the way the haystack's is, and DERIVED AGAIN HERE
    rather than imported: a census of every ancestor of the subject up to `/`,
    and of the subject itself, for a `.git` entry. None, more than one, a
    subject that is its own repository, a `.git` anywhere inside the subject, a
    bare repository, a census that disagrees with git's own discovery, or a
    `HEAD` that differs between the subject and the toplevel -- each is a NAMED
    refusal and none of them picks a repository. Sharing the other reader's
    code would make one bug a bug in both; writing it twice is the point.
    """
    repos = []
    at = subject
    while True:
        if os.path.exists(os.path.join(at, ".git")):
            repos.append(at)
        parent = os.path.dirname(at)
        if parent == at:
            break
        at = parent
    if not repos:
        raise Anchor(
            "HARNESS-NO-REPOSITORY: no ancestor of the harness %s holds a `.git`, so "
            "there is no commit to read the deciding files against." % subject
        )
    if len(repos) > 1:
        raise Anchor(
            "HARNESS-NESTED-REPO: %d repositories contain the harness %s (%s). This "
            "reader does not choose between them, because choosing is what let the "
            "subject pick the commit it was read against."
            % (len(repos), subject, ", ".join(repos))
        )
    top = repos[0]
    if not (subject + os.sep).startswith(top + os.sep):
        raise Anchor(
            "HARNESS-SUBJECT-IS-A-REPO: the harness %s is the repository root itself, "
            "or lies outside it, so a repository planted at the harness would BE the "
            "toplevel." % subject
        )
    for d, subdirs, names in os.walk(subject):
        if ".git" in subdirs or ".git" in names:
            raise Anchor(
                "HARNESS-NESTED-REPO: %s exists inside the harness, so a commit of "
                "that repository could stand in for the subject's."
                % os.path.join(d, ".git")
            )
    try:
        bare = _git(subject, ["rev-parse", "--is-bare-repository"]).decode(
            "ascii", "replace"
        ).strip()
        discovered = os.path.realpath(
            _git(subject, ["rev-parse", "--show-toplevel"]).decode("utf-8", "replace").strip()
        )
        here = _git(subject, ["rev-parse", "--verify", "HEAD^{commit}"]).decode(
            "ascii", "replace"
        ).strip()
        there = _git(top, ["rev-parse", "--verify", "HEAD^{commit}"]).decode(
            "ascii", "replace"
        ).strip()
    except (RuntimeError, OSError) as exc:
        raise Anchor(
            "HARNESS-ANCHOR-UNRESOLVED: the census named %s and git could not be asked "
            "to confirm it (%s)." % (top, exc)
        )
    if bare != "false":
        raise Anchor(
            "HARNESS-BARE-REPOSITORY: git resolves the harness %s inside a BARE "
            "repository, which an ancestor walk cannot see: it holds no `.git` entry "
            "to find. The deciding files are read from a work tree or not at all."
            % subject
        )
    if discovered != os.path.realpath(top):
        raise Anchor(
            "HARNESS-TOPLEVEL-DISAGREES: the census of ancestors names %s as the one "
            "repository holding the harness %s, and git's own discovery names %s. "
            "Where the two differ, every answer taken from git comes from a repository "
            "the census never examined." % (top, subject, discovered)
        )
    if here != there:
        raise Anchor(
            "HARNESS-HEAD-DISAGREES: `HEAD` resolved from the harness is %s and `HEAD` "
            "resolved from %s is %s, so the bytes would be read against one commit and "
            "reported against another." % (here[:12], top, there[:12])
        )
    if len(here) != FULL_SHA:
        raise Anchor(
            "HARNESS-ANCHOR-UNRESOLVED: `rev-parse --verify HEAD^{commit}` returned "
            "%r, which is not a full 40-character object name." % here
        )
    return os.path.realpath(top), here


def _tree_dirty(top):
    """Every path the commit holds, compared with what is on disk.

    THE COORDINATOR'S `F1` RULING, round 22, and its correction in round 23.
    The byte law covered every deciding file and not THE FILE THAT INVOKES it,
    so a dirty tree had to become a refusal wherever a run is entered; no check
    inside a self-run entry point can stop an uncommitted edit to that entry
    point, and what can be true is that such a tree produces NO ADMISSIBLE
    TRANSCRIPT.

    Round 23 then measured the first version of that law false. It asked
    `git status --porcelain`, which is a statement about the INDEX:
    `git update-index --assume-unchanged` or `--skip-worktree` is the
    documented way to stop git looking, edits no file and commits nothing, and
    one flag defeated all three clean-tree sites at once. The coordinator built
    the consequence: that flag on migration `0086` plus an appended
    `CREATE TABLE` produced a full green suite printing `SOURCE_TREE_DIRTY :
    no`, with `MIGRATIONS_SHA` unchanged because it was read from `HEAD`, and
    the planted table really ran.

    So nothing here asks git what changed. Every path the COMMIT holds is read
    off the disk and its blob name recomputed from the bytes -- which no index
    flag can move -- and the executable bit is compared with the mode the
    commit carries, because `core.fileMode=false` hides a mode change from git
    and the disk's own bits are not git's opinion.

    This reader derives all of it from its own calls. Sharing the checker's
    code would make one bug a bug in both.
    """
    try:
        fmt = _git(top, ["rev-parse", "--show-object-format"]).decode("ascii", "replace").strip()
        sha = _git(top, ["rev-parse", "--verify", "HEAD^{commit}"]).decode(
            "ascii", "replace"
        ).strip()
        listed = _git(top, ["ls-tree", "-r", "-z", "--full-tree", sha]).decode(
            "utf-8", "surrogateescape"
        )
    except (RuntimeError, OSError) as exc:
        return (
            "HARNESS-TREE-STATE-UNREADABLE: whether the work tree at %s is the tree "
            "the commit holds could not be determined (%s)." % (top, exc),
        )
    if fmt != "sha1":
        return (
            "HARNESS-OBJECT-FORMAT-UNSUPPORTED: this repository's object format is %r "
            "and the comparison here computes blob names as sha1, so it cannot say "
            "whether the work tree is the committed tree." % fmt,
        )
    moved, gone, modes = [], [], []
    for row in listed.split("\0"):
        if not row:
            continue
        meta, _tab, path = row.partition("\t")
        bits = meta.split(" ")
        if len(bits) < 3 or bits[1] != "blob":
            continue
        mode, oid = bits[0], bits[2]
        full = os.path.join(top, path)
        try:
            if mode == "120000":
                data = os.readlink(full).encode("utf-8", "surrogateescape")
            else:
                with open(full, "rb") as fh:
                    data = fh.read()
        except OSError:
            gone.append(path)
            continue
        if hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() != oid:
            moved.append(path)
        if mode in ("100644", "100755"):
            try:
                executable = bool(os.stat(full).st_mode & 0o111)
            except OSError:
                gone.append(path)
                continue
            if executable != (mode == "100755"):
                modes.append(path)
    count = len(moved) + len(gone) + len(modes)
    if not count:
        return ()
    return (
        "HARNESS-TREE-DIRTY: %d path%s the commit holds %s not what is on disk at %s, "
        "so a run from it is not a run of the committed tree and its transcript is not "
        "evidence. %s%s%s"
        % (
            count,
            "" if count == 1 else "s",
            "is" if count == 1 else "are",
            top,
            "Moved: %s. " % "; ".join(sorted(moved)[:5]) if moved else "",
            "Missing: %s. " % "; ".join(sorted(gone)[:5]) if gone else "",
            "Mode: %s." % "; ".join(sorted(modes)[:5]) if modes else "",
        ),
    )


def _index_flagged(top):
    """The tracked paths whose index entry says git is to stop looking at them.

    A refusal of its own, beside the comparison above: a flag can hide a
    MISSING file as easily as a changed one, and a run whose inputs are marked
    not-to-be-read is not a measurement of the committed tree. `ls-files -v`
    tags assume-unchanged in lower case and skip-worktree with `S`.
    """
    try:
        out = _git(top, ["ls-files", "-v", "-z"]).decode("utf-8", "surrogateescape")
    except (RuntimeError, OSError) as exc:
        return (
            "HARNESS-INDEX-STATE-UNREADABLE: whether any tracked path is flagged "
            "assume-unchanged or skip-worktree could not be determined (%s)." % exc,
        )
    flagged = []
    for row in out.split("\0"):
        if not row or len(row) < 2 or row[1] != " ":
            continue
        tag, path = row[0], row[2:]
        if tag == "S" or tag.islower():
            flagged.append(
                "%s (%s)" % (path, "skip-worktree" if tag == "S" else "assume-unchanged")
            )
    if not flagged:
        return ()
    return (
        "HARNESS-INDEX-FLAGGED: %d tracked path%s flagged so that git stops looking at "
        "%s: %s." % (
            len(flagged),
            " is" if len(flagged) == 1 else "s are",
            "it" if len(flagged) == 1 else "them",
            "; ".join(sorted(flagged)[:5]),
        ),
    )


def check(harness_dir=None):
    """(ok, refusals) that every deciding file is the file the commit holds."""
    harness_dir = harness_dir or _here()
    try:
        top, sha = _census_top(os.path.realpath(harness_dir))
    except Anchor as why:
        return False, (str(why),)
    except (RuntimeError, OSError) as exc:
        return False, (
            "HARNESS-ANCHOR-UNRESOLVED: the deciding files are read against the commit "
            "and the commit could not be resolved (%s)." % exc,
        )
    dirty = tuple(_tree_dirty(top)) + tuple(_index_flagged(top))
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
    msgs = list(dirty)
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
    top, sha = _census_top(os.path.realpath(harness_dir))
    rows = []
    for n in _deciding_files(harness_dir):
        rel = os.path.relpath(os.path.realpath(os.path.join(harness_dir, n)), top)
        try:
            blob = _git(top, ["show", "%s:%s" % (sha, rel)])
        except (RuntimeError, OSError):
            continue
        rows.append("%s  %s" % (hashlib.sha256(blob).hexdigest(), n))
    return sha, rows


def tree_state(harness_dir=None):
    """(ok, refusals) for the WHOLE committed tree, by the bytes on disk.

    `R23-F2`, the half of it the shell step cannot answer for itself. The
    script printed `SOURCE_TREE_DIRTY` from `git status --porcelain`, and that
    is a statement about the INDEX: a `--skip-worktree` flag on a frozen
    migration plus an appended `CREATE TABLE` left the line reading `no` while
    the planted table really ran. The figure has to be a MEASUREMENT, so the
    script asks this reader for it -- the same comparison this file already
    makes for the deciding files, over every path the commit holds.
    """
    harness_dir = harness_dir or _here()
    try:
        top, _sha = _census_top(os.path.realpath(harness_dir))
    except Anchor as why:
        return False, (str(why),)
    except (RuntimeError, OSError) as exc:
        return False, (
            "HARNESS-ANCHOR-UNRESOLVED: the tree state is read against the commit and "
            "the commit could not be resolved (%s)." % exc,
        )
    return (lambda bad: (not bad, bad))(
        tuple(_tree_dirty(top)) + tuple(_index_flagged(top))
    )


def _main(argv):
    harness_dir = None
    want_digests = False
    want_tree_state = False
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a == "--digests":
            want_digests = True
        elif a == "--tree-state":
            want_tree_state = True
        elif a == "--harness" and rest:
            harness_dir = rest.pop(0)
        else:
            sys.stderr.write("usage: [--digests] [--tree-state] [--harness DIR]\n")
            return 2
    if want_tree_state:
        ok, msgs = tree_state(harness_dir)
        # One word on stdout, because the caller prints it as a figure; the
        # reasons go to stderr so the transcript carries them too.
        print("no" if ok else "YES")
        for m in msgs:
            sys.stderr.write("REFUSED: %s\n" % m)
        return 0 if ok else 5
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
