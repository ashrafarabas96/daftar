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
import re
import subprocess

DECIDING_SUFFIXES = (".py", ".sh", ".sql")
FULL_SHA = 40

# `R27-F2`, round 27's second blocker, measured by the challenger: the DDL this
# phase APPLIES -- `prep/phase11/ddl/*.sql` -- was in no pinned set. The
# deciding-set walk below starts at `harness/`, so `ddl/` is outside it; the
# tree law compares disk against the commit, so a COMMITTED edit is invisible
# to it; and the driver PRINTED `PACK_A_DDL_SHA256` and compared it with
# nothing. A digest nobody compares is not a check. One appended
# `RAISE NOTICE` in Pack A's DDL therefore put any string into the run's own
# output.
#
# These are external byte pins: the literal digest of each pack's DDL, in an
# instrument, compared against the bytes on disk -- the bytes the run applies.
# The same two literals are written in `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md`
# and this file REFUSES if the two copies disagree, so moving a pack's DDL
# takes an edit to the DDL, to this file and to that document in one commit,
# which is the declared self-check limit and a diff a reviewer sees in three
# places rather than one.
PACK_DDL_PINS = {
    "p11-pack-a-apparel.sql":
        "f87a7ce0efb295d772d2415f962de2c3f2c173d40b36be4bada38da4b9194456",
    "p11-pack-b-lot-expiry.sql":
        "d5820ada9f3f0ddee2a3475271a996f5c2e3be83190845d2e85130d601c8ff75",
}
PACK_DDL_LAW = "P11-CONSERVATION-LAWS-AND-RED-PROOFS.md"
PACK_DDL_LAW_LINE = re.compile(
    r"^([0-9a-f]{64})\s\s(p11-[a-z0-9-]+\.sql)$", re.M
)


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


# The directories whose CONTENTS a run reads, rather than the commit's copy of
# them, and the suffixes it reads or executes from them. Named here as well as
# in the checker, on purpose: this is the SECOND reader, and two derivations
# that share a list bound drift rather than truth -- but a reader that asked
# the checker for the list would not be a second reader at all. An absent
# directory is a refusal, not an empty walk.
READ_DIRS = ("infrastructure/database/migrations", "prep/phase11")
READ_SUFFIXES = (".sql", ".py", ".sh", ".md", ".txt")


def _untracked(top, sha):
    """Paths the commit does not hold, under a directory a run READS.

    THE COORDINATOR'S `F1` ON `50a45a0`, the blocker. A law that walks
    `ls-tree HEAD` never examines a file the commit does not hold, and
    `run_migrations.py` applies `sorted(os.listdir(MIGDIR))`: an untracked
    `.sql` beside the frozen migrations was applied with `APPLIED 88/88`,
    `SOURCE_TREE_DIRTY : no` and every `EXIT_*` 0. `git status --porcelain`,
    which round 23 replaced, did list it -- so the fix for one hole opened
    another, and both halves are needed: every path the commit holds is what is
    on disk, AND nothing a run reads is a path the commit does not hold.
    """
    try:
        listed = _git(
            top, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", sha]
        ).decode("utf-8", "surrogateescape")
    except (Anchor, RuntimeError, OSError) as exc:
        return (
            "HARNESS-UNTRACKED-UNREADABLE: whether the work tree at %s carries a file "
            "the commit does not hold could not be determined (%s)." % (top, exc),
        )
    held = {path for path in listed.split("\0") if path}
    absent = [d for d in READ_DIRS if not os.path.isdir(os.path.join(top, d))]
    if absent:
        return (
            "HARNESS-READ-DIR-ABSENT: %s is named as a directory a run reads and is not "
            "a directory at %s, so this reader cannot say what would be read from it."
            % ("; ".join(absent), top),
        )
    extra = []
    for rel_dir in READ_DIRS:
        for root, dirs, names in os.walk(os.path.join(top, rel_dir), followlinks=True):
            dirs.sort()
            for name in sorted(names):
                if not name.endswith(READ_SUFFIXES):
                    continue
                rel = os.path.relpath(os.path.join(root, name), top)
                if rel not in held:
                    extra.append(rel)
    if not extra:
        return ()
    return (
        "HARNESS-TREE-UNTRACKED: %d path%s under a directory a run reads %s not in the "
        "commit at %s, and a run reads or applies what is on disk, so its transcript is "
        "not evidence. Untracked: %s."
        % (
            len(extra),
            "" if len(extra) == 1 else "s",
            "is" if len(extra) == 1 else "are",
            top,
            "; ".join(sorted(extra)[:5]),
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
    # `_untracked` is deliberately NOT consulted here. `check()` answers one
    # question -- are the harness's DECIDING BYTES the bytes the commit holds --
    # and it is run over narrow worlds that hold a harness and no repository
    # around it, where 'a directory this run reads is absent' is true and means
    # nothing. The whole-tree question is `tree_state()` below, which is what the
    # shell asks and what the checker's own `untracked-paths` key asks in process.
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
                # `C26-S4`, the coordinator's P3: this sentence used to say
                # the commit "does not hold it", and in the symlink world the
                # commit DID hold the path -- what it does not hold is a
                # DECIDING entry at that path. It also called a three-line
                # text transcript "a deciding file this harness can execute",
                # which is `C26-F1` asserted by the instrument itself. Both
                # halves are the reader's time spent looking for something
                # they will find.
                "HARNESS-FILE-UNCOMMITTED: `%s` is a path this law reads as deciding "
                "(it is under the harness and carries one of %s) and commit %s holds "
                "no deciding entry for it. The commit may hold the path itself; what "
                "it does not hold is a deciding file there, which is what this law "
                "compares." % (rel, ", ".join(DECIDING_SUFFIXES), sha[:12])
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


def doc_digests(harness_dir=None):
    """(sha, rows) — every phase document's digest, read FROM THE COMMIT.

    `R24-F2`. The manifest carried a hand-maintained table of document digests,
    inside one of the documents it named, and said the shared copies and the Git
    copies were byte-identical. This commit's predecessor made that false for
    the four documents it edited, and five of seven published digests named
    bytes at neither path. §2a had already ruled the class: a pin inside the
    thing it pins is not a pin, and a table a planter edits in the same commit
    is the same mistake with one more file in it.

    So there is no table. The run prints what it MEASURED, derived by listing
    the phase directory IN THE COMMIT rather than from a list of names, so a
    document added tomorrow is covered the day it is written and a document
    deleted stops being claimed.
    """
    harness_dir = harness_dir or _here()
    top, sha = _census_top(os.path.realpath(harness_dir))
    phase = os.path.dirname(os.path.relpath(os.path.realpath(harness_dir), top))
    names = _git(
        top, ["ls-tree", "-z", "--name-only", "%s:%s" % (sha, phase)]
    ).decode("utf-8", "surrogateescape")
    rows = []
    for n in sorted(x for x in names.split("\0") if x.endswith(".md")):
        blob = _git(top, ["show", "%s:%s/%s" % (sha, phase, n)])
        rows.append("%s  %s" % (hashlib.sha256(blob).hexdigest(), n))
    return sha, rows


def pack_ddl(harness_dir=None):
    """(ok, msgs) — the applied pack DDL against its external byte pins.

    `R27-F2`. Four refusals, each by its own name, and the set is a CENSUS:
    a pinned file that is gone refuses, and a `.sql` that ARRIVES in `ddl/`
    with no pin refuses too, because the run applies Pack A and Pack B by name
    and anything else landing in that directory is a file no pin covers.

    The bytes read are the bytes ON DISK, which are the bytes the driver feeds
    to `psql`; comparing the commit with the disk is the tree law's job one
    function below, and it is the comparison a COMMITTED edit survives.
    """
    harness_dir = harness_dir or _here()
    phase_dir = os.path.dirname(os.path.realpath(harness_dir))
    ddl_dir = os.path.join(phase_dir, "ddl")
    msgs = []
    if not os.path.isdir(ddl_dir):
        return False, [
            "PACK-DDL-DIR-ABSENT: %s is not a directory, and this law cannot "
            "report that the applied DDL matches its pins by finding nothing "
            "to read." % ddl_dir
        ]
    # The law document's copy of the same literals. A disagreement is a
    # refusal: one of the two was edited alone.
    law_path = os.path.join(phase_dir, PACK_DDL_LAW)
    try:
        law_text = open(law_path, encoding="utf-8").read()
    except OSError as exc:
        return False, [
            "PACK-DDL-LAW-UNREADABLE: %s cannot be read (%s), so the second "
            "copy of these pins cannot be compared with the first."
            % (law_path, exc)
        ]
    law = {name: sha for sha, name in PACK_DDL_LAW_LINE.findall(law_text)}
    for name in sorted(PACK_DDL_PINS):
        if name not in law:
            msgs.append(
                "PACK-DDL-LAW-PIN-ABSENT: this file pins %s but %s carries no "
                "digest line for it, so the pin has one copy and not two."
                % (name, PACK_DDL_LAW)
            )
        elif law[name] != PACK_DDL_PINS[name]:
            msgs.append(
                "PACK-DDL-PIN-DISAGREES-WITH-THE-LAW: %s is pinned %s here and "
                "%s in %s. One of the two was edited alone."
                % (name, PACK_DDL_PINS[name][:12], law[name][:12], PACK_DDL_LAW)
            )
    for name in sorted(law):
        if name not in PACK_DDL_PINS:
            msgs.append(
                "PACK-DDL-LAW-PINS-AN-UNKNOWN-FILE: %s carries a digest for %s, "
                "which this file does not pin at all." % (PACK_DDL_LAW, name)
            )
    present = sorted(n for n in os.listdir(ddl_dir) if n.endswith(".sql"))
    for name in present:
        if name not in PACK_DDL_PINS:
            msgs.append(
                "PACK-DDL-FILE-UNPINNED: %s is a `.sql` in %s and no pin covers "
                "it. The run applies the packs this directory holds, so an "
                "arrival here is DDL nothing compares." % (name, ddl_dir)
            )
            continue
        with open(os.path.join(ddl_dir, name), "rb") as fh:
            got = hashlib.sha256(fh.read()).hexdigest()
        if got != PACK_DDL_PINS[name]:
            msgs.append(
                "PACK-DDL-DIGEST-MISMATCH: %s hashes %s on disk and its pin is "
                "%s. These are the bytes the driver applies, so the database "
                "this run proves is not the database these pins describe."
                % (name, got[:12], PACK_DDL_PINS[name][:12])
            )
    for name in sorted(PACK_DDL_PINS):
        # Pack B is pinned and may legitimately be absent at an older SHA; the
        # driver skips it BY NAME there, so absence is reported rather than
        # refused only when the driver's own skip is the reason.
        if name not in present:
            msgs.append(
                "PACK-DDL-PINNED-FILE-ABSENT: %s is pinned here and is not in "
                "%s. A pin for a file that is gone passes vacuously."
                % (name, ddl_dir)
            )
    return (not msgs), msgs


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
        top, sha = _census_top(os.path.realpath(harness_dir))
    except Anchor as why:
        return False, (str(why),)
    except (RuntimeError, OSError) as exc:
        return False, (
            "HARNESS-ANCHOR-UNRESOLVED: the tree state is read against the commit and "
            "the commit could not be resolved (%s)." % exc,
        )
    return (lambda bad: (not bad, bad))(
        tuple(_tree_dirty(top)) + tuple(_index_flagged(top)) + tuple(_untracked(top, sha))
    )


def _main(argv):
    harness_dir = None
    want_digests = False
    want_tree_state = False
    want_doc_digests = False
    want_pack_ddl = False
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a == "--digests":
            want_digests = True
        elif a == "--doc-digests":
            want_doc_digests = True
        elif a == "--tree-state":
            want_tree_state = True
        elif a == "--pack-ddl":
            want_pack_ddl = True
        elif a == "--harness" and rest:
            harness_dir = rest.pop(0)
        else:
            sys.stderr.write(
                "usage: [--digests] [--doc-digests] [--tree-state] [--pack-ddl]"
                " [--harness DIR]\n"
            )
            return 2
    if want_pack_ddl:
        ok, msgs = pack_ddl(harness_dir)
        if ok:
            print(
                "PACK-DDL OK: %d pinned pack DDL file(s) hash exactly as this "
                "law and %s pin them"
                % (len(PACK_DDL_PINS), PACK_DDL_LAW)
            )
            return 0
        for m in msgs:
            print("REFUSED: %s" % m)
        return 5
    if want_tree_state:
        ok, msgs = tree_state(harness_dir)
        # One word on stdout, because the caller prints it as a figure; the
        # reasons go to stderr so the transcript carries them too.
        print("no" if ok else "YES")
        for m in msgs:
            sys.stderr.write("REFUSED: %s\n" % m)
        return 0 if ok else 5
    if want_doc_digests:
        sha, rows = doc_digests(harness_dir)
        print("the phase documents as commit %s holds them:" % sha)
        for r in rows:
            print(r)
        return 0
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
