#!/usr/bin/env python3
"""Rewrite the generated blocks of P13-HANDOFF-MANIFEST.md from the ground truth.

Two blocks, two ground truths: §3's digest table comes from the bytes of the
files in this directory, and §3.6's status table comes from live `git` in the
repository worktree.

WHY THIS SCRIPT EXISTS. The manifest's §3 table was hand-maintained. It was
written once, six of its artifacts were then amended by later directive passes,
an eleventh artifact was created after it, and nothing detected any of that --
so six of ten rows were stale and a reader had no way to tell a stale row from
a tampered byte. Rewriting the digests by hand would have fixed the symptom and
left the cause in place. This script is the cause's fix: regeneration is now one
command, and `--check` makes staleness detectable instead of invisible.

    python3 regenerate-manifest.py              # rewrite the two generated blocks
    python3 regenerate-manifest.py --check      # judge them; see the exit codes below
    python3 regenerate-manifest.py --measure-install   # re-measure §3.5a, which INSTALLS

Exit codes under `--check`, which a reviewer should be able to read without
reading the source:

    0  everything judged is current
    1  a row is stale, and the row is printed
    2  the manifest's generated markers are missing, so there is nothing to judge
    3  the digests are current and the branch rows could NOT be measured in this
       clone -- a judgement on the records, and explicitly none on the branch

WHY §3.5a IS GENERATED TOO, AND BY A SEPARATE FLAG. A seventh challenge round
found the §3.5 row about a package-local install reporting "131 entries;
`eslint`, `tsc` and `vitest` all present" when the measured truth at that head
was 54 entries with `eslint` ABSENT -- because the same commit that fixed F-19
removed the eslint dependencies, and the hand-typed row that measured the OLD
manifest came across unchanged. It was the only §3.5 row whose subject its own
commit changed, and it was cited as the evidence that the declaration was sound.
Third time a hand-typed §3.5 figure had gone stale while §3 and §3.6 were
generated and checked.

So that row is generated from a real measurement: `--measure-install` copies the
package manifest at `P13_REPO` into an empty directory with no `node_modules`
above it, runs `npm install` there, and writes what it finds. It is a separate
flag because it reaches the network and takes a minute, and a plain regeneration
run must stay cheap enough to use after every edit.

What makes it UNABLE to go stale silently is not the flag but `--check`: the
block records the SHA-256 of the `package.json` it measured, and `--check`
compares that against the file in the worktree now. Change a dependency and the
row is stale with exit 1 until it is re-measured. It is keyed on that file and
not on `HEAD` deliberately -- an unrelated commit must not demand a network
install, and nothing else can change what this row measures.

WHY §3.6 IS GENERATED TOO. The same independent challenge that found §3 stale
found this file asserting, in its own §1 and §2, that the branch sat at `main`
and that "no Phase 13 commit exists" -- six commits and 23 files after they
did. That is the identical defect one layer up: a file's own status header
sitting OUTSIDE the laws that file enforces on everything else. Editing those
rows by hand would have left them exactly as able to go stale as before, so the
rows are now generated from `git` and `--check` compares them. The hand-written
rows in §1 and §2 no longer state a SHA at all; they point here, because one
question deserves one authority.

The repository worktree is `/home/user/daftar`, overridable with `P13_REPO` for
a reviewer who cloned it elsewhere. Without it the git block cannot be stated,
and the script says so and exits non-zero rather than printing a table it could
not measure.

It only ever rewrites the text BETWEEN the markers in the manifest. It
cannot state the manifest's own digest -- writing one would change the bytes it
claims to describe -- so the manifest's own row carries an em dash, by design
and not by omission.
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'P13-HANDOFF-MANIFEST.md'
BEGIN = '<!-- BEGIN GENERATED DIGEST TABLE -- regenerate-manifest.py owns everything below -->'
END = '<!-- END GENERATED DIGEST TABLE -->'
INSTALL_BEGIN = '<!-- BEGIN GENERATED INSTALL MEASUREMENT -- regenerate-manifest.py owns everything below -->'
INSTALL_END = '<!-- END GENERATED INSTALL MEASUREMENT -->'
GIT_BEGIN = '<!-- BEGIN GENERATED GIT STATUS -- regenerate-manifest.py owns everything below -->'
GIT_END = '<!-- END GENERATED GIT STATUS -->'
CHECK_BEGIN = '<!-- BEGIN GENERATED CHECK ROW -- regenerate-manifest.py owns everything below -->'
CHECK_END = '<!-- END GENERATED CHECK ROW -->'
REPO = Path('/home/user/daftar')  # replaced at startup by find_repo()
BRANCH = 'claude/project-thread-mll4uk'
PEERS = ('main', 'phase/4-sales-pos-customers-receivables')


class GitUnavailable(RuntimeError):
    """The worktree could not be measured. Stated, never guessed around."""


# R15-01, the challenger's blocking finding: `git replace` rewrites what every
# read of an object returns, so a reviewer handed a clone carrying
# `refs/replace/<blob>` got the gate printing "the generator is PINNED ... which
# is `docs/phase13/regenerate-manifest.py` at <sha>" while a patched generator
# ran -- every clause of that sentence false, and the sentence is the whole
# point of the pin. Replace objects are a per-repository redirection the caller
# controls, so the pin was never anchored to Git; it was anchored to whatever
# the handed repository said Git was.
#
# The remedy is not applied to the blob read alone. A redirection that can move
# one object can move the commit the subject SHA resolves to, the committer date
# the stamp is bounded by, and the tree the branch rows are read from, so EVERY
# git invocation in this file goes through these two, and both of them: the flag
# for the invocations spelled here, and the environment variable for anything
# git runs underneath them.
GIT = ('git', '--no-replace-objects')


def git_env() -> dict[str, str]:
    env = dict(os.environ)
    env['GIT_NO_REPLACE_OBJECTS'] = '1'
    return env


def git(*args: str) -> str:
    try:
        done = subprocess.run(
            (*GIT, '-C', str(REPO), *args),
            capture_output=True, text=True, timeout=120, check=False, env=git_env(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GitUnavailable(f'git {" ".join(args)}: {exc}') from exc
    if done.returncode != 0:
        raise GitUnavailable(f'git {" ".join(args)} exited {done.returncode}: {done.stderr.strip()}')
    return done.stdout.strip()


def find_repo() -> Path:
    """The worktree to measure, discovered rather than assumed.

    F-12, from the third challenge round: a reviewer has their own clone and
    their own paths, so a hard-coded default made this tool unrunnable for the
    one person it exists to serve. `P13_REPO` still wins; otherwise the script
    looks where it is being run from, then at the path this pack was prepared
    in.
    """
    explicit = os.environ.get('P13_REPO')
    if explicit:
        return Path(explicit)
    try:
        top = subprocess.run((*GIT, 'rev-parse', '--show-toplevel'),
                             capture_output=True, text=True, timeout=60, check=False,
                             env=git_env())
        if top.returncode == 0 and top.stdout.strip():
            return Path(top.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return Path('/home/user/daftar')


def resolve_ref(name: str, remote: dict[str, str]) -> tuple[str, str]:
    """The SHA of a branch, from whichever spelling of it this clone HAS.

    A reviewer's clone holds the branch as `refs/remotes/origin/<name>` and
    usually has no local branch of that name at all; the author's has both. The
    first version of this resolver asked only for `refs/heads/<name>`, exited
    128 in every clone but the author's, and took the whole check down with it
    -- which is the same defect as validating a check only where the thing it
    depends on already exists. So every candidate is tried, and the spelling
    that answered is reported in the row, because WHICH ref answered is part of
    what the row means.
    """
    for ref, how in ((f'refs/heads/{name}', 'local branch'),
                     (f'refs/remotes/origin/{name}', "this clone's origin/ copy")):
        try:
            return git('rev-parse', '--verify', '--quiet', ref), how
        except GitUnavailable:
            continue
    fetched = remote.get(f'refs/heads/{name}')
    if fetched:
        return fetched, 'the remote, read with ls-remote (no local ref for it here)'
    raise GitUnavailable(f'no ref for {name} in this clone, and the remote does not list it')


# R12-01. The glob was `*.md` + `*.py` + `runs/*`, while §3's sentence said every
# file this directory holds has a row. A challenger found the counter-example
# already sitting in the delivered pack: `__pycache__/regenerate-manifest.cpython-313.pyc`,
# 55584 bytes, written two minutes BEFORE the regeneration that produced the
# table, with `grep -c pycache` = 0 in the manifest and `--check` reporting
# "§3 is current (68 artifacts)" at exit 0. Planted on fresh copies: a file in a
# new subdirectory, and a `.csv` and a `.json` at top level, all three invisible.
# This is `F-28` for the third time -- a predicate narrower than its law -- and
# the third fix is not another extension of the glob. The walk is now RECURSIVE
# over every regular file, the exemptions are NAMED here, and `--check` asserts
# CONTAINMENT: any file under this directory with no row and no named exemption
# reds.
#
# `P13-AL-35` applies to this list: an exemption is part of the gate, so it is
# measured and reported rather than silent. A `__pycache__` byte-cache is not an
# artifact of this pack -- Python writes it when something imports the script,
# its name carries an interpreter version, and its bytes change with no change to
# anything a reader is asked to trust -- but when one exists, `--check` says so
# and counts it, so the exemption can never hide a file quietly.
EXEMPT_DIRS = ('__pycache__',)
# R13-02: the exemption was by DIRECTORY NAME at any depth and for any extension, so
# `__pycache__/P13-SMUGGLED.md` and `runs/__pycache__/P13-HIDDEN.md` were skipped --
# loudly, which is why it was a P3 and not a P2, but skipped. The exemption exists
# for compiled byte-caches, so it is now the compiled files and nothing else, and
# §3's own footer records what was exempted so the DOCUMENT says it too, not only
# the run.
EXEMPT_SUFFIXES = ('.pyc', '.pyo')
# And anchored to the TOP level, per the coordinator's ruling: Python writes the
# cache beside the module, which here is this directory, so a `__pycache__`
# anywhere else is not the thing being exempted and gets a row like anything else.
#
# REVIEWER FILES (coordinator ruling, same round). A challenger's or a
# coordinator's report landing in this directory staled this manifest every time,
# and those files are not mine: I did not write them, I must not vouch for their
# bytes, and they change under me. They are excluded by an ANCHORED pattern --
# top level, the exact prefix, the `.md` suffix -- so a different name
# (`P13-CHALLENGE-x.log`), a nested copy (`runs/P13-CHALLENGE-x.md`) and my OWN
# response documents (`P13-CHALLENGE-RESPONSE-*.md`) all stay covered. The
# tension with PART 13, which asks for a digest on every off-Git artifact, is
# stated rather than hidden: these are the review of the pack, not the pack, and
# §3's footer names every file it did not hash.
# R14-01. The predicate did not entail the class. The test was
# `^P13-CHALLENGE-(?!RESPONSE-)[^/]*\.md$`, which rejects exactly the eight characters
# `RESPONSE-`: `P13-CHALLENGE-RESPONSE2-probe.md` and `P13-CHALLENGE-RESPONSEX.md` --
# files the AUTHOR can create -- passed it, so a document of mine was left out of §3
# AND printed in §3's own footer as "a reviewer file (not mine to vouch for)", at exit
# 0. `ROUND_RECORDS` was a bare prefix, so the same file was not gated for false claims
# either: neither hashed nor checked, and attributed to someone else.
#
# A class decided by a name the author controls is not a class. So the exemption is an
# ENUMERATION of the reports actually delivered. A file that merely LOOKS like one is
# hashed as mine, gated like anything else of mine, and NAMED by the run as a lookalike.
# The limit, stated because the gate cannot close it: this list is maintained by hand,
# so what the gate guarantees is "these names are not hashed and everything else is" --
# never "these files were written by someone else". Forgetting an entry fails CLOSED
# (the report gets hashed and my manifest goes stale when it is edited); inventing one
# is a lie I would have to write into a versioned file to tell.
DELIVERED_REVIEWER_REPORTS = (
    'P13-CHALLENGE-09a8eb6.md',
    'P13-CHALLENGE-1028957.md',
    'P13-CHALLENGE-12fe9a4.md',
    'P13-CHALLENGE-382e070.md',
    'P13-CHALLENGE-383b0f3.md',
    'P13-CHALLENGE-3f5a8d2.md',
    'P13-CHALLENGE-7556812.md',
    'P13-CHALLENGE-76de10c.md',
    'P13-CHALLENGE-86e450e.md',
    'P13-CHALLENGE-9649a15.md',
    'P13-CHALLENGE-9779c8d.md',
    'P13-CHALLENGE-a6d8830.md',
    'P13-CHALLENGE-bcaea5d.md',
    'P13-CHALLENGE-cc4e263.md',
    # R15, delivered into the pack by the challenger during round 15.
    'P13-CHALLENGE-f8068cc.md',
    # R16, delivered into the pack by the challenger during round 16. Its
    # addendum A lives outside the pack, by their choice, so it is not listed.
    'P13-CHALLENGE-ef15738.md',
    'P13-COORD-DIFF-REVIEW-12fe9a4.md',
    # R16's coordinator diff review, frozen and delivered into the pack.
    'P13-COORD-DIFF-REVIEW-ef15738.md',
    # R17, the narrow round on ef15738..8215af5, delivered into the pack by the
    # challenger. It was in the pack while the A-02 fix was being written, which
    # is why it is enumerated in a commit of its own, after that fix: a reviewer's
    # file is not mine to hash as one of my artifacts, and an unlisted file wearing
    # the name is reported as a lookalike -- so leaving it out would have put their
    # report into my digest table and named it suspicious in the same run.
    'P13-CHALLENGE-8215af5.md',
    # R18, the narrow round on 8215af5..3c72703: PASS-WITH-SCOPE, and the two P3
    # findings answered in this commit. Enumerated here rather than in a commit of
    # its own, because this commit exists anyway and theirs did not.
    'P13-CHALLENGE-3c72703.md',
    # The coordinator's diff review of the same range, which SIGNS it.
    'P13-COORD-DIFF-REVIEW-3c72703.md',
)
# The SHAPE of a reviewer report, used only to spot a file that wears the name without
# being on the list, and MY OWN round records, which are hashed and are anchored to a
# hexadecimal subject so that `RESPONSE2-probe` is not one of them.
REVIEWER_SHAPE_RE = re.compile(r'^P13-(?:CHALLENGE|COORD-DIFF-REVIEW)-[^/]*\.md$')
MY_ROUND_RECORD_RE = re.compile(r'^P13-CHALLENGE-RESPONSE-[0-9a-f]{7,40}\.md$')


def _is_reviewer_file(rel: str) -> bool:
    """Delivered by a reviewer, by NAME, from the enumeration above."""
    return rel in DELIVERED_REVIEWER_REPORTS


def _is_my_round_record(rel: str) -> bool:
    return MY_ROUND_RECORD_RE.match(rel) is not None


def lookalike_files() -> list[str]:
    """Files wearing a reviewer's name that are NOT delivered reviewer reports.

    These are hashed and gated. The run names them, because the interesting case is
    not a stranger's file appearing -- it is mine.
    """
    return sorted(str(p.relative_to(HERE)) for p in HERE.rglob('*')
                  if p.is_file()
                  and REVIEWER_SHAPE_RE.match(str(p.relative_to(HERE)))
                  and not _is_reviewer_file(str(p.relative_to(HERE)))
                  and not _is_my_round_record(str(p.relative_to(HERE))))


def _exempt(path: Path) -> bool:
    rel = path.relative_to(HERE)
    if _is_reviewer_file(str(rel)):
        return True
    return (rel.parts[:-1] == (EXEMPT_DIRS[0],)
            and path.suffix in EXEMPT_SUFFIXES)


def exempted_files() -> list[str]:
    return sorted(str(p.relative_to(HERE)) for p in HERE.rglob('*')
                  if p.is_file() and _exempt(p))


def artifacts() -> list[Path]:
    """Every artifact this directory holds: the documents, and EVERY file under runs/.

    The logs are hashed for the same reason the documents are. PART 13 asks for a
    SHA256 on every off-Git artifact, and a run log is exactly the kind of
    artifact a reader is asked to take on trust -- so it is named, sized and
    hashed like anything else here.

    F-28: this used to glob `runs/*.log`, which silently excluded this script's own
    witness file `runs/P13-3.5a-block.sha256`. Three sentences in the manifest and
    in the witness file's header claimed §3 digested it; §3 did not, so re-typing
    the §3.5a block and recomputing the witness to match passed `--check` at exit 0
    with the block reading `entries under node_modules | **131**` -- two file edits
    and no regeneration step, where the stated limit named three. The glob is
    `runs/*` rather than `runs/*.sha256` so that the NEXT witness of any kind is
    covered without a second edit here: the law is that §3 digests every file this
    directory holds, and a predicate narrower than that law is a hole in it.

    And `*.py`, found by the coverage self-test below on its own first run: THIS
    SCRIPT had no row in §3. The glob was `*.md` plus the run logs, so the file
    that generates every digest in the table was the one artifact of this
    directory a reader could not verify -- the same hole as F-28, one level out,
    and the law had been broader than the predicate all along. Unlike the manifest
    there is no self-reference problem: the script's digest is written into the
    manifest, not into the script, so its bytes do not change when it is recorded.
    """
    found = [p for p in HERE.rglob('*') if p.is_file() and not _exempt(p)]
    return sorted(set(found), key=lambda p: str(p.relative_to(HERE)))


def row(path: Path) -> str:
    name = str(path.relative_to(HERE))
    if path.name == MANIFEST.name:
        return (
            f'| `{name}` | — | — | '
            '*(this file — it can state neither its own digest nor its own size, '
            'because writing either changes the bytes being described)* |'
        )
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    lines = data.count(b'\n')
    return f'| `{name}` | {len(data)} | {lines} | `{digest}` |'


def rows() -> list[str]:
    """The part of the table that is a claim about the files, and nothing else.

    Deliberately separate from `table()`: the footer carries a generation
    timestamp, and comparing it would make `--check` report staleness one minute
    after any regeneration. The FIRST version of this script did exactly that,
    which is a pointed lesson for a script whose whole job is detecting a stale
    claim -- a check that cries wolf teaches people to ignore it. `--check`
    compares these rows.
    """
    return [row(p) for p in artifacts()]


def _exempt_footer() -> str:
    """What this table did NOT hash, in the table itself (R13-02).

    The run named every exempt file already; the manifest did not, and the manifest
    is what a reader reads without running anything.
    """
    skipped = exempted_files()
    reviewer = [n for n in skipped if _is_reviewer_file(n)]
    caches = [n for n in skipped if n not in reviewer]
    looks = lookalike_files()
    lines = ['NOT HASHED, and these are the only two exemptions there are:',
             '',
             f'* **{len(reviewer)} reviewer reports, exempt by NAME from a list this script '
             f'carries** — not by a pattern, because a pattern over names the author controls '
             f'cannot decide whose file something is (`R14-01`). They are the review OF this pack, '
             f'delivered by the challenger and the coordinator: '
             + (', '.join(f'`{n}`' for n in reviewer) if reviewer else 'none here')
             + '. What this exemption guarantees is that THESE names are not hashed and every '
             'other file here is; it does not and cannot prove who wrote them. A file that merely '
             'wears the shape of one is hashed as mine and gated like anything else of mine'
             + (f', and there {"is" if len(looks) == 1 else "are"} {len(looks)} such '
                f'{"file" if len(looks) == 1 else "files"} here: '
                + ', '.join(f'`{n}`' for n in looks) if looks else ', and there are none here'),
             f'* **byte-caches** — `{"`, `".join(EXEMPT_SUFFIXES)}` directly under '
             f'`{EXEMPT_DIRS[0]}/`: ' + (', '.join(f'`{n}`' for n in caches) if caches else 'none here')]
    return '\n'.join(lines)


def table() -> str:
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
    head = [
        '| Artifact | Bytes | Lines | SHA256 |',
        '|---|---:|---:|---|',
    ]
    body = rows()
    foot = [
        '',
        f'Generated by `regenerate-manifest.py` at **{stamp}**, over the raw bytes of EVERY REGULAR',
        'FILE in this directory and in every subdirectory of it, whatever its name or extension,',
        f'minus the exemptions named below ({len(body)} files hashed; byte and line counts come from',
        'the same read). The walk is recursive and the run ASSERTS that the set it hashed plus those',
        'exemptions is the whole set on disk, so a file of a kind nobody anticipated reds instead of',
        'being skipped; the sentence that stood here named three shapes while the walk took all of',
        'them, which is a narrower claim than the code and is corrected where it is generated.',
        'Re-run it after ANY edit to the pack, or run it with `--check` to find out whether a row',
        'has gone stale. A stale row is a records defect in this table and says nothing about the',
        'artifact it names.',
        '',
        _exempt_footer(),
    ]
    return '\n'.join(head + body + foot)


STAMP_RE = re.compile(r'^Generated by `regenerate-manifest.py` at \*\*([0-9T:\-]+Z)\*\*', re.MULTILINE)


def stamp_violations(body: str) -> tuple[str | None, list[str]]:
    """Is the stamp §3 records consistent with facts OUTSIDE this directory (R14-03)?

    The timestamp is the one row of a generated block that cannot be recomputed: run the
    script again and it legitimately changes. The challenger measured the consequence --
    re-type it to 1999-01-01, recompute the witness, and every other row still agrees at
    exit 0 -- and then supplied the bound I had missed: regeneration is the LAST write of
    a round, AFTER the push, so the stamp cannot precede the commit this pack is about,
    and it cannot be in the future either.

    The first version of this bound compared the stamp with the mtimes of the artifacts.
    It worked, and it red on any `cp -r` of this directory, because a copy rewrites every
    mtime -- so it would have cried wolf at exactly the reviewer who copies the pack to
    plant against it, which is the F-29 defect. The commit's own committer date is
    copy-stable and lives in Git, outside anything this folder can edit.

    The limit, stated: this catches a stamp moved outside the window between the commit
    and now. It cannot catch a stamp moved WITHIN that window, and an author who also
    chooses the commit date moves one end of it.
    """
    found = STAMP_RE.search(body)
    if not found:
        return None, []
    recorded = found.group(1)
    try:
        when = datetime.strptime(recorded, '%Y-%m-%dT%H:%MZ').replace(tzinfo=timezone.utc)
    except ValueError:
        return recorded, [f'the stamp `{recorded}` is not a timestamp this script writes']
    bad: list[str] = []
    now = datetime.now(timezone.utc).timestamp()
    if when.timestamp() > now + 120:
        bad.append(f'the stamp {recorded} is in the FUTURE by this machine\'s clock')
    try:
        sha = subject_sha_local()
        dated = git('show', '-s', '--format=%cI', sha)
        made = datetime.fromisoformat(dated).astimezone(timezone.utc)
        # A minute of slack: the stamp has minute granularity.
        if when.timestamp() + 60 < made.timestamp():
            bad.append(f'the stamp {recorded} is EARLIER than the commit this pack is about '
                       f'({sha[:7]}, committed {made:%Y-%m-%dT%H:%MZ}) — regeneration is the last '
                       'write of a round, after the push, so a stamp before the commit means the '
                       'stamp was moved')
    except (GitUnavailable, ValueError) as exc:
        bad.append(f'NOT BOUNDED: the commit date could not be read ({exc}); the stamp is then '
                   'neither recomputable nor bounded, and this run says so rather than passing it')
    return recorded, bad


def footer_reviewer_names(body: str) -> list[str]:
    """The reviewer reports §3's footer, as it stands on disk, says it did not hash."""
    for line in body.split('\n'):
        if 'reviewer reports, exempt by NAME' in line:
            return sorted(set(re.findall(r'`(P13-[^`]+\.md)`', line)))
    return []


GENERATOR_IN_REPO = 'docs/phase13/regenerate-manifest.py'
# A-01: an object id as Git spells it, so a store cannot answer with prose.
OBJECT_ID_RE = re.compile(r'^[0-9a-f]{40}$')


# A-02: a tree entry's mode, so a walk that expects a directory is never handed
# something else. A submodule (160000) or a symlink (120000) on this path is a
# refusal and not a guess.
TREE_MODE = b'40000'
BLOB_MODES = (b'100644', b'100755')


def tree_entries(data: bytes) -> list[tuple[bytes, bytes, str]]:
    """The entries of a tree object, parsed from the bytes Git stores.

    `<mode> <name>\0<20 raw bytes>`, repeated. Parsed from the bytes this walk
    has just re-hashed rather than taken from `ls-tree`, because that is the
    whole point of A-02: a second `git` call would be a second question put to
    the store whose answers are in doubt.
    """
    out: list[tuple[bytes, bytes, str]] = []
    i = 0
    while i < len(data):
        nul = data.find(b'\x00', i)
        if nul < 0 or nul + 21 > len(data):
            raise ValueError(f'truncated tree entry at byte {i} of {len(data)}')
        head = data[i:nul]
        if b' ' not in head:
            raise ValueError(f'tree entry with no mode at byte {i}')
        mode, name = head.split(b' ', 1)
        out.append((mode, name, data[nul + 1:nul + 21].hex()))
        i = nul + 21
    return out


def served_object(oid: str, typ: str) -> tuple[bytes | None, str]:
    """One object's bytes, RE-HASHED as Git defines an object before they are used.

    `sha1("<type> <len>\0" + content)`, compared with the id the object was
    asked for. Git itself does not do this on read (A-01, measured), so every
    id this module compares against is computed here from the bytes actually
    handed over. Returns (bytes, '') or (None, reason) -- never bytes it has
    not checked.
    """
    try:
        got = subprocess.run((*GIT, '-C', str(REPO), 'cat-file', typ, oid),
                             capture_output=True, timeout=120, check=False, env=git_env())
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f'git could not be run in {REPO} ({exc})'
    if got.returncode != 0:
        detail = got.stderr.decode('utf-8', 'replace').strip().splitlines()
        why = detail[0] if detail else f'git exited {got.returncode}'
        return None, f'the {typ} object {oid} is not readable in {REPO} — {why}'
    served = hashlib.sha1(b'%s %d\x00' % (typ.encode('ascii'), len(got.stdout))
                          + got.stdout).hexdigest()
    if served != oid:
        return None, (f'the {typ} object SERVED AS {oid} HASHES TO {served} '
                      f'({len(got.stdout)} bytes)')
    return got.stdout, ''


def verified_chain(subject_sha: str, path: str) -> tuple[str | None, list[str], str]:
    """Walk commit -> tree -> ... -> blob, re-hashing every object on the way.

    A-02, the challenger's second addendum and a P1 fail-open that went straight
    THROUGH the A-01 fix. A-01 stopped the store serving forged bytes under a
    real blob id, by re-hashing the bytes against the id the tree records. But
    that id was itself read with `rev-parse <sha>:<path>`, which resolves
    commit -> tree -> ... -> blob out of the same store that A-01 had just shown
    cannot be taken at its word. So the attacker moves one level up and tampers
    with the TREE instead: one 20-byte id swapped inside the `docs/phase13` tree
    object, written back under that tree's own id, and the forged generator goes
    in as a perfectly HONEST blob. Then `recorded_id == served_id` and the
    re-hash matches -- because what it matches is a forged record of a forged
    object. Measured on the real gate: `ok=True`, with `refs/replace/` empty,
    the flag and the environment variable with nothing to disable, and HEAD,
    the worktree and the branch all resolving correctly. Stronger still: leave
    every tree and the blob HONEST and tamper only the commit object, stored
    under the anchored sha with its `parent` line intact -- also `ok=True`.
    And the sentence the gate printed, "the id the tree at <sha> RECORDS", was
    then FALSE as measured: the tree at that sha, hashed properly, records the
    real blob.

    A re-hash is only as good as the id it compares against. So the chain is
    walked down from the one input that is not an answer from the store -- the
    40-character subject sha -- and every object on it is re-hashed as Git
    defines an object: the commit, each tree on the path, then the blob. The id
    for the next step is taken from the bytes of the object just verified, never
    from a second question to the store. The first mismatch is a refusal BY NAME.

    What this does NOT close, stated rather than implied: the subject sha itself
    is handed to this function, and `subject_sha_local()` reads it from a ref in
    that same store. A store that lies about its refs prints a different sha --
    so the anchor holds only as far as a reader comparing the printed sha with
    the one in the signature, which is why the pin's sentence names it. The
    standing residual of WHICH repository the gate is handed is unchanged and
    no code in this pack can close it.

    Returns (blob id, steps verified, '') or (None, steps verified, reason).
    """
    steps: list[str] = []
    commit, why = served_object(subject_sha, 'commit')
    if commit is None:
        return None, steps, f'the COMMIT itself could not be verified: {why}'
    head = commit.split(b'\n', 1)[0]
    tree_id = head[5:].decode('ascii', 'replace') if head.startswith(b'tree ') else ''
    if not OBJECT_ID_RE.match(tree_id):
        return None, steps, (f'the verified commit {subject_sha[:12]} does not begin with a '
                             f'`tree <id>` line, so the walk has nowhere to go: its first line '
                             f'is {head[:64]!r}')
    steps.append(f'commit={subject_sha[:12]} -> tree={tree_id[:12]}')
    oid, parts = tree_id, path.split('/')
    for depth, part in enumerate(parts):
        where = '/'.join(parts[:depth]) or 'the repository root'
        tree, why = served_object(oid, 'tree')
        if tree is None:
            return None, steps, f'the TREE at `{where}` could not be verified: {why}'
        try:
            entries = tree_entries(tree)
        except ValueError as exc:
            return None, steps, (f'the verified tree {oid[:12]} at `{where}` does not parse as '
                                 f'a tree object: {exc}')
        hits = [e for e in entries if e[1] == part.encode('utf-8')]
        if len(hits) != 1:
            found = 'is absent from' if not hits else f'appears {len(hits)} times in'
            return None, steps, (f'`{part}` {found} the verified tree {oid[:12]} at `{where}` '
                                 f'({len(entries)} entries). Refusing rather than guessing which')
        mode, _, nxt = hits[0]
        last = depth == len(parts) - 1
        want = BLOB_MODES if last else (TREE_MODE,)
        if mode not in want:
            kind = 'a file' if last else 'a directory'
            return None, steps, (f'`{part}` in the verified tree {oid[:12]} at `{where}` has mode '
                                 f'{mode.decode("ascii", "replace")}, which is not {kind}; a '
                                 f'submodule or a symlink on this path is a refusal, not a guess')
        steps.append(f'{part}={nxt[:12]}')
        oid = nxt
    return oid, steps, ''

def pin_verdict(subject_sha: str) -> tuple[bool, str]:
    """Is the generator running here the one committed at the SHA it is judging?

    The coordinator's ruling, and it is the right shape: this script checks the pack
    while living in the pack, where anyone with folder access could change the checker
    with no committed artefact moving -- and a digest of the checker stored IN the pack
    would just be the pack certifying its own checker, which is §3.5b's cycle again.
    So the pin is anchored to Git. The bytes running now are compared with the blob at
    the commit this manifest claims to be about, and nothing in this directory can move
    both.

    A-01, the challenger's addendum to round 16, and a P1 fail-open of mine: "anchored to
    Git" assumed that asking git for an object returns that object. It does not. Git does
    NOT verify a loose object's hash when it reads it -- only `fsck` does -- so a store
    holding the generator blob loose can serve any bytes at all under the real blob's
    name. Reached through `.git/objects/info/alternates`, that forges the pin with no
    replacement anywhere: `rev-parse <sha>:<path>` still prints the id RECORDED IN THE
    TREE, `for-each-ref refs/replace/` is empty so the R15 disclosure says something true
    and useless, and the subject SHA, the tree, the worktree and the branch resolution are
    all genuinely correct. This IS the right repository at the right commit; only the
    bytes are not the object. Measured: all five arms (`--no-replace-objects`,
    `GIT_NO_REPLACE_OBJECTS=1`, both, both plus `core.useReplaceRefs=false`, and plain)
    served the forgery. My own written bound -- "an alternate object store cannot
    substitute the blob ... substitution-by-hash needs a collision" -- was false, and it
    was false in the one clause that mattered: the reasoning holds only for a store that
    verifies what it serves.

    So the identity is no longer taken from the store's word for it. The id the TREE
    records is read, the bytes are re-hashed as Git itself defines an object
    (`sha1("blob <len>\0" + data)`), and a mismatch is a named refusal. That is a
    statement the store cannot lie about, because the id is in the tree and the hash is
    over the bytes actually handed over. It also SUBSUMES the R15-01 replace case: with
    both git guards deliberately removed, `show` returns the replacement while the tree
    still records the real id, so the re-hash refuses anyway. The guards stay regardless
    -- they are free, and they keep the replace case out of this comparison entirely.

    A-02, the challenger's next addendum, then showed that THAT was still the store's
    word: the id the re-hash compared against came from `rev-parse <sha>:<path>`, which
    resolves commit -> tree -> ... -> blob out of the same unverified store. Tamper the
    TREE, or the COMMIT, and the re-hash matches a forged record of a forged object --
    measured both ways at `8215af5`, ok=True, with the printed sentence false as measured.
    So the id is no longer read at all: `verified_chain()` walks down from the 40-character
    subject sha and re-hashes the commit, every tree on the path and then the blob, taking
    each next id from the bytes it has just verified. See its docstring for what that still
    does not close.

    Returns (ok, sentence). Every failure is BY NAME, and a failure is fail-closed:
    unreachable commit, absent blob, foreign repository, bytes that are not the object they
    are served as, and now an object on the PATH that is not the object it is named as, are
    refusals, not skips, because "I could not check the checker" must never read as "the
    checker is fine".
    """
    running = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if not OBJECT_ID_RE.match(subject_sha):
        return False, (f'the generator pin CANNOT BE CHECKED: `{subject_sha}` is not a full '
                       '40-character object id. An abbreviation is resolved BY the store this '
                       'walk exists to distrust, so there would be no anchor left (A-02). '
                       'Refusing')
    recorded_id, steps, why = verified_chain(subject_sha, GENERATOR_IN_REPO)
    if recorded_id is None:
        walked = ' -> '.join(steps) if steps else 'nothing'
        return False, (f'the repository SERVED AN OBJECT THAT IS NOT THE ONE IT NAMES (A-02):\n'
                       f'    {why}\n'
                       f'    re-hashed and verified before the refusal: {walked}\n'
                       '  git does not verify an object\'s hash when it reads it, so neither the '
                       'blob id written in a tree nor the tree id written in a commit may be taken '
                       'from the store\'s word for it. The chain is walked down from the subject '
                       'sha and every object on it re-hashed; this one did not hash to the id it '
                       'was served as. Refusing by name')
    blob, why = served_object(recorded_id, 'blob')
    if blob is None:
        return False, (f'the repository SERVED BYTES THAT ARE NOT THE OBJECT IT NAMES (A-01):\n'
                       f'    the verified chain from {subject_sha[:7]} records '
                       f'`{GENERATOR_IN_REPO}` as {recorded_id}\n'
                       f'    {why}\n'
                       '  git does not verify a loose object when it reads it, so a prepared '
                       'object store can serve anything under a real id. This is NOT a '
                       'replacement and no `refs/replace/` need exist; the commit, the tree and '
                       'the branch resolution can all be correct. Refusing by name')
    pinned = hashlib.sha256(blob).hexdigest()
    if pinned != running:
        return False, (f'the generator RUNNING HERE is not the one committed at '
                       f'{subject_sha[:7]}:\n    running   {running}\n    committed {pinned}\n'
                       f'  the file is `{Path(__file__).name}` in this directory and '
                       f'`{GENERATOR_IN_REPO}` in the repository; they must be the same bytes')
    # R18-01, the challenger's other P3 at `3c72703`: this sentence ASKS the reader to
    # compare the subject sha with the one in the signature, and then printed 12 of its
    # 40 characters -- `grep -oE '\b[0-9a-f]{40}\b'` over the whole `--check` output
    # returned NOTHING. The gate enforced the full-40 law on its input (the abbreviated
    # sha above is a refusal) and not on its own output. So every id that is part of the
    # signed triple is printed IN FULL here: the subject sha, and the generator's SHA-256
    # on both sides of the comparison. The blob id stays abbreviated -- it is disclosure,
    # not an element of the triple.
    return True, (f'the generator is PINNED, and the chain to it was RE-HASHED object by object '
                  f'(A-02): {" -> ".join(steps)}. The {len(blob)} bytes served for that blob '
                  f'id re-hash to {recorded_id[:12]}…, which is the id the verified tree at '
                  f'{subject_sha} RECORDS for `{GENERATOR_IN_REPO}`, and the bytes running '
                  f'here hash to {running} — so no id in this comparison was taken from '
                  f'the store\'s word for it (A-01), only the subject sha {subject_sha} '
                  'itself, which a reader must compare with the one in the signature (R18-01: '
                  'an id a reader is asked to COMPARE is printed in full, not abbreviated)')


def replace_refs() -> list[str]:
    """Any `refs/replace/` in the repository this run was handed, named.

    Disabling the redirection makes the comparison sound; it does not make the
    redirection's PRESENCE uninteresting. A reviewer who is handed a clone
    carrying a replace ref is being handed something, and a gate that silently
    ignores it tells them nothing. So the refs are listed, by name, beside the
    pin's verdict. This is a DISCLOSURE and not a refusal: with
    `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS=1` on every invocation
    above, the bytes compared are the real ones whether these exist or not.
    """
    try:
        listed = git('for-each-ref', '--format=%(refname) -> %(objectname)', 'refs/replace/')
    except GitUnavailable as exc:
        return [f'(could not be listed: {exc})']
    return [ln.strip() for ln in listed.splitlines() if ln.strip()]


def subject_sha_local() -> str:
    """The branch SHA this pack is about, from local refs only.

    The pin and R14-05's disclosure must work offline and in a reviewer's clone, so
    `ls-remote` is not consulted here: `refs/heads/<branch>` if this clone has it,
    otherwise `refs/remotes/origin/<branch>`.
    """
    for ref in (f'refs/heads/{BRANCH}', f'refs/remotes/origin/{BRANCH}'):
        try:
            return git('rev-parse', '--verify', '--quiet', ref)
        except GitUnavailable:
            continue
    raise GitUnavailable(f'no local ref for {BRANCH} in {REPO}')


def git_record_rows() -> list[str]:
    """The rows that are a CLAIM ABOUT THE BRANCH, and are compared by --check.

    F-09, from the second challenge round: the first version measured
    `rev-parse HEAD` in whatever worktree it was pointed at, so it mixed claims
    about the branch with facts about the READER's checkout, and a reviewer in a
    detached worktree got a red gate on a matching checkout. F-12, from the
    third: the fix then resolved `refs/heads/<branch>`, which exists in the
    author's clone and in nobody else's, so the check exited 2 and judged
    nothing at all -- strictly worse than what it replaced. Both had one cause:
    a check validated only in the environment that already contains what it
    depends on.

    So the branch is resolved from whichever spelling this clone has
    (`resolve_ref`), the counts are measured from that SHA, and what the
    reader's own checkout happens to be is reported separately and compared by
    nothing.

    `git ls-remote` is read for the remote head on purpose: a successful push is
    not evidence that the remote moved. Local and remote are reported
    SEPARATELY, so an unpushed commit shows up as a difference instead of hiding
    inside one SHA.
    """
    remote = {}
    for line in git('ls-remote', 'origin', f'refs/heads/{BRANCH}',
                    *[f'refs/heads/{p}' for p in PEERS]).splitlines():
        sha, _, ref = line.partition('\t')
        remote[ref.strip()] = sha.strip()
    local, _how = resolve_ref(BRANCH, remote)
    mine = remote.get(f'refs/heads/{BRANCH}', '(absent on the remote)')
    base, _ = resolve_ref('main', remote)
    ahead = git('rev-list', '--count', f'{base}..{local}')
    files = len([f for f in git('diff', '--name-only', f'{base}...{local}').splitlines() if f])
    rows = [
        # The SHA is the claim; WHICH ref answered is a fact about the reader's
        # clone, so it goes in the observation table. Leaving it here would red
        # the gate in every clone but the author's -- F-09 all over again, in
        # the row that fixes F-12.
        f'| `{BRANCH}` | `{local}` | resolved from whichever ref this clone holds; the spelling that answered is reported below |',
        f'| `origin/{BRANCH}` | `{mine}` | read with `git ls-remote`, never inferred from a successful push |',
        f'| Pushed? | **{"yes" if mine == local else "NO — the resolved branch and the remote differ"}** |'
        ' the two SHAs above compared, not assumed |',
        f'| Commits on this branch beyond `main` | **{ahead}** | `git rev-list --count <main sha>..<branch sha>` |',
        f'| Repository files changed vs `main` | **{files}** | `git diff --name-only <main sha>...<branch sha>` |',
    ]
    for peer in PEERS:
        sha = remote.get(f'refs/heads/{peer}', '(absent on the remote)')
        note = ('**unmoved**; every `file:line` citation in this pack is at this SHA'
                if peer.startswith('phase/4') else '**unmoved**')
        rows.append(f'| `{peer}` | `{sha}` | {note} |')
    return rows


def git_observation_rows() -> list[str]:
    """Where the reader happens to be standing. Regenerated, never compared.

    R18-02, the challenger's P3 at `3c72703`: the record table offers the
    `origin/<branch>` row as a SECOND source -- "read with `git ls-remote`, never
    inferred from a successful push" -- but `origin` is read from the config of the
    repository this run was handed, which is the repository the pin exists to
    distrust. They measured it: point `origin` at a bare repository on your own
    disk, push the branch into it, and every row comes out TRUE, with `Pushed?`
    reading yes, about a remote made a minute earlier. I reproduced it with a bare
    clone on this disk and the gate's own resolver: same shas, same `Pushed? yes`,
    and nothing in any row naming which remote answered.

    The URL does not CLOSE that -- nothing here can, any more than it can close
    which repository the gate is handed. It makes it VISIBLE, which is the
    difference between a residual a reader can act on and one they cannot see.
    """
    head = git('rev-parse', 'HEAD')
    checked_out = git('rev-parse', '--abbrev-ref', 'HEAD')
    dirty = git('status', '--porcelain')
    try:
        origin = git('remote', 'get-url', 'origin')
    except GitUnavailable as exc:
        origin = f'(no `origin` could be read: {exc})'
    try:
        _sha, how = resolve_ref(BRANCH, {})
    except GitUnavailable:
        how = 'the remote only; this clone holds no ref for it'
    return [
        f'| How the branch ref resolved here | **{how}** | a reviewer\'s clone usually holds the branch only as `refs/remotes/origin/<name>`; both spellings are accepted |',
        f'| The remote that answered `ls-remote` | `{origin}` | `git remote get-url origin`, so the second source in the table above is NAMED. It is read from the config of the repository this run was handed, so a crafted remote makes every row above true about itself (`R18-02`); naming it does not close that, it lets the reader see it |',
        f'| Checked out at regeneration | `{checked_out}` at `{head}` | a detached review worktree reports `HEAD`; that is normal and is not a defect |',
        f'| Worktree at regeneration | **{"clean" if not dirty else f"DIRTY in {len(dirty.splitlines())} path(s)"}** |'
        ' a dirty tree makes a SHA-bound claim measured in it unbound |',
    ]


def git_table() -> str:
    head = ['| Subject | Value | Note |', '|---|---|---|']
    mid = [
        '',
        '**Observed, not compared** — these two rows describe whoever ran the regeneration, so',
        '`--check` ignores them (F-09):',
        '',
        '| Subject | Value | Note |',
        '|---|---|---|',
    ]
    foot = [
        '',
        'Generated by `regenerate-manifest.py` from live `git`. Every row in the FIRST table is a',
        'claim about the named branch, resolved from `refs/heads/<branch>` and `git ls-remote`, and',
        '`--check` compares it; the second table is where the reader was standing and is compared by',
        'nothing. The rows in §1 and §2 state no SHA at all and point here, because the first version',
        'of them asserted this branch sat at `main` with no Phase 13 commit long after six commits',
        'existed. A stale row here is a records defect and says nothing about the branch it names.',
    ]
    return '\n'.join(head + git_record_rows() + mid + git_observation_rows() + foot)


PACKAGE_JSON = Path('packages/analytics/package.json')


def _package_json_path() -> Path:
    return Path(REPO) / PACKAGE_JSON


def package_manifest_digest() -> str:
    """The SHA-256 of the file §3.5a's measurement is about."""
    return hashlib.sha256(_package_json_path().read_bytes()).hexdigest()


def _tool_version(cmd: list[str]) -> str:
    """The version of the tool that actually ran, recorded beside what it measured.

    The P10 lesson, in this pack's own apparatus: a runner that inherits a PATH
    can run under a different engine than the reader assumes. npm 10.9.4 crashes
    on this package manifest and npm 11.6.2 installs it, so a figure in §3.5a is
    meaningless without the engine beside it.
    """
    done = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return done.stdout.strip() or '(unknown)' if done.returncode == 0 else '(unknown)'


def measure_install() -> list[str]:
    """Install the package's own manifest in an empty directory and report it.

    The point of the measurement is what a standalone checkout gets, so it runs
    with NO `node_modules` anywhere above it: a row measured inside the
    repository would measure the root install, which is exactly the borrowed
    figure F-19 was about.
    """
    import json
    import shutil
    import tempfile

    manifest = _package_json_path()
    if not manifest.is_file():
        raise GitUnavailable(f'{PACKAGE_JSON} not found under {REPO}')
    head = subprocess.run([*GIT, '-C', str(REPO), 'rev-parse', 'HEAD'],
                          capture_output=True, text=True, check=False, env=git_env())
    sha = head.stdout.strip() if head.returncode == 0 else '(unknown)'
    digest = package_manifest_digest()

    workdir = Path(tempfile.mkdtemp(prefix='p13-install-'))
    try:
        shutil.copy2(manifest, workdir / 'package.json')
        run = subprocess.run(['npm', 'install', '--no-audit', '--no-fund'],
                             cwd=workdir, capture_output=True, text=True, check=False)
        # R11 self-finding, from running this very flag on the round that
        # answers R11-02: with the container's default npm on PATH (10.9.4,
        # Node 22) the install CRASHES -- `Cannot read properties of null
        # (reading 'edgesOut')` -- and this block happily recorded `exit code 1`,
        # `0 entries` and `eslint ABSENT, typescript ABSENT, vitest ABSENT, pg
        # ABSENT`, overwriting a good measurement with a row that reads as a
        # finding about the PACKAGE when it is a fact about the engine. A
        # measurement that did not happen must not replace one that did, and an
        # absence nothing looked for must not be reported as an absence
        # (`P13-AL-14`, and the same law §3.5b now applies to exit codes). So a
        # failed install refuses: nothing is written and the previous block
        # stands.
        if run.returncode != 0:
            lines = [ln.strip() for ln in run.stderr.strip().splitlines() if ln.strip()]
            # the LAST line is npm's "a complete log of this run can be found
            # in ...", which names a file and not a cause; the cause is the
            # first error line that is not that pointer.
            cause = next((ln for ln in lines
                          if 'complete log' not in ln and 'debug-0.log' not in ln),
                         lines[-1] if lines else 'no stderr')
            why = cause
            raise GitUnavailable(
                f'npm install exited {run.returncode} under node '
                f'{_tool_version(["node", "--version"])} / npm {_tool_version(["npm", "--version"])}'
                f' — nothing was measured and the recorded block is UNCHANGED. Last line: {why}')
        modules = workdir / 'node_modules'
        entries = sorted(p.name for p in modules.iterdir() if not p.name.startswith('.')) if modules.is_dir() else []
        declared = json.loads(manifest.read_text(encoding='utf-8')).get('devDependencies', {})
        looked_for = ['eslint', 'typescript', 'vitest', 'pg']
        present = {
            name: (modules / name).exists() if modules.is_dir() else False
            for name in looked_for
        }
        binaries = {
            name: (modules / '.bin' / name).exists() if modules.is_dir() else False
            for name in ['eslint', 'tsc', 'vitest']
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    def mark(ok: bool) -> str:
        return '**present**' if ok else '**ABSENT**'

    dirty = subprocess.run([*GIT, '-C', str(REPO), 'status', '--porcelain'],
                           capture_output=True, text=True, check=False, env=git_env())
    worktree = 'clean' if (dirty.returncode == 0 and dirty.stdout.strip() == '') else 'NOT clean'
    rows = [
        f'| measured at | `{sha}`, worktree **{worktree}** |',
        f'| engine that installed | node **{_tool_version(["node", "--version"])}**, '
        f'npm **{_tool_version(["npm", "--version"])}** |',
        f'| `{PACKAGE_JSON}` SHA-256 | `{digest}` |',
        f'| `npm install` exit code | **{run.returncode}** |',
        f'| entries under `node_modules` (dot-entries excluded) | **{len(entries)}** |',
        f'| `devDependencies` declared | **{len(declared)}** |',
        '| packages looked for | ' + ', '.join(f'`{n}` {mark(ok)}' for n, ok in present.items()) + ' |',
        '| binaries in `node_modules/.bin` | ' + ', '.join(f'`{n}` {mark(ok)}' for n, ok in binaries.items()) + ' |',
    ]
    return rows


WITNESS = HERE / 'runs' / 'P13-3.5a-block.sha256'


def _normalised_block(body: str) -> bytes:
    """The block's own bytes, for the witness, with TRANSPORT normalised away and
    nothing else.

    F-29: this used to be `body.strip()` alone, which trimmed the outer edges only.
    That was asymmetric: one trailing space on an inner line red at exit 1 saying the
    block "was edited rather than measured", while converting the whole block to CRLF
    passed at exit 0 -- because `read_text` folds CRLF before the digest is taken.
    Neither is tampering, and a check that cries wolf on one of them teaches a reader
    to ignore it on the day it is right (the principle is already in rows()).

    So line endings and per-line trailing whitespace are both normalised, for both
    the writer and the reader, and the digest covers the block's words and figures.
    Its limit, stated: a change that alters ONLY inter-line whitespace is not
    detected here. A tamper that changes a digit, a name or a mark still is.

    F-32: the clause that stood here said "and §3 digests the block's file byte for
    byte besides", which is false and was written in the very commit that closed
    F-28. The block's file is P13-HANDOFF-MANIFEST.md, and §3 carries no digest of
    it BY DESIGN -- row() returns an em-dash row for it and §3.0 states the reason,
    that writing a digest into a file changes the bytes it would describe. So this
    witness is the ONLY check on the block's own bytes, and the floor under both is
    Git, which §3.5a states correctly. Nothing else backed the limit above, and a
    limit with nothing behind it is the thing the limit was written to prevent. The
    coverage self-test above now reds on a sentence of this shape.
    """
    lines = [ln.rstrip() for ln in body.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    return '\n'.join(lines).strip().encode('utf-8')


def witness_line(body: str) -> str:
    return (
        '# The SHA-256 of §3.5a\'s generated block in P13-HANDOFF-MANIFEST.md, written by\n'
        '# regenerate-manifest.py --measure-install and compared by --check (F-27). §3 digests every\n'
        '# file under runs/, this one included (artifacts(), F-28), so editing it alone makes §3\n'
        '# stale -- verify that by name: this file must have its own row in §3. Limit: §3.5a.\n'
        f'{hashlib.sha256(_normalised_block(body)).hexdigest()}\n'
    )


class AmbiguousWitness(Exception):
    """A witness file carrying more than one digest line."""


def _only_digest(path: Path) -> str | None:
    """The one digest in a witness file, or an exception if there are several.

    R12-07 closed a first-match read of §3.5b's exit-code row, and a challenger's
    next aim was the obvious one: do the WITNESS files have the same shape? They
    did. Both readers returned the FIRST digest-looking line, so a line planted
    above the real one would be read and the real one ignored -- the same hole
    one level down, in the files that key §3.5a and §3.5b.

    So a witness carries exactly one digest. Several is not a stale digest, it is
    an unreadable record, and the gate exits 2 on it rather than picking one.
    """
    if not path.is_file():
        return None
    found = [ln.strip() for ln in path.read_text(encoding='utf-8').splitlines()
             if re.fullmatch(r'[0-9a-f]{64}', ln.strip())]
    if len(found) > 1:
        raise AmbiguousWitness(
            f'{path.relative_to(HERE)} carries {len(found)} digest lines '
            f'({", ".join(d[:12] + "…" for d in found)}) — refusing to guess which one is the '
            'witness')
    return found[0] if found else None


def recorded_witness() -> str | None:
    return _only_digest(WITNESS)


def install_table(rows: list[str]) -> str:
    return '\n'.join([
        '| what | measured |',
        '|---|---|',
        *rows,
        '',
        'Measured by `regenerate-manifest.py --measure-install`, which copies the package manifest',
        'into an empty directory with **no `node_modules` above it** and installs there. `--check`',
        'compares the recorded `package.json` digest with the file in the worktree, so a dependency',
        'change makes this block stale (exit 1) until it is re-measured. `eslint` is **deliberately**',
        'absent since `F-19`: linting is a root gate, so a standalone checkout of this package can',
        'typecheck and test itself and cannot lint itself.',
    ])


# --------------------------------------------------------------------------- #
# F-32: the §3 COVERAGE self-test.
#
# Four rounds running, the same defect: a sentence asserting that §3 covers some
# artifact, where §3 does not. F-24 (a hand-typed install row), F-27 (a staleness
# key covering a subject and not its own output), F-28 (three sentences, one of
# them a stated LIMIT, saying §3 digested the witness file while the glob excluded
# it) and now F-32 -- written in the very commit that closed F-28 and recorded
# that the form of claim which fails is the ASSERTION. A lesson recorded four
# times and re-broken four times is not a lesson, it is a missing gate.
#
# So the claim is now measured. For each NORMATIVE file of this pack, every
# sentence that asserts §3 covers some artifact must name that subject in
# backticks, and that subject must have a row in §3's table carrying a real
# digest. A claim that names no subject is UNRESOLVED and reds -- which is what
# catches F-32 itself, whose sentence said "the block's file" and named nothing.
#
# What it covers, exactly, because that is this gate's own coverage claim:
#  * the files in NORMATIVE below -- the two documents that state the pack's laws,
#    this script, and the witness file whose header makes the claim in its own
#    first lines.
#  * NOT the round records: neither the challenge documents nor the
#    challenge-RESPONSE documents are scanned, mine included. They quote false
#    claims verbatim on purpose, and a gate that red on a quotation would teach a
#    reader to ignore it (F-29). So, stated as a residual rather than left to be
#    inferred: COVERAGE CLAIMS IN CHALLENGE-RESPONSE DOCUMENTS ARE NOT GATED. A
#    reader who needs one of those checked reads it against the §3 table by hand.
#    This scope is the coordinator's ruling of 2026-10-12, not this script's
#    choice, and widening it means widening NORMATIVE and adjudicating what reds.
#  * present-tense ASSERTIONS only. A sentence reporting or denying a claim --
#    one carrying a word in REPORTED -- is skipped, because "§3 did not digest it"
#    is the record of a defect, not an instance of it.
#  * a subject named as a concrete path. A glob is not a subject.
# Its limit, stated: a false claim written in a form none of these patterns match
# is not caught, and nothing here judges a claim about anything other than §3.
# --------------------------------------------------------------------------- #

# The scope is defined by EXCLUSION, not by a list of four files, and that is this
# gate's own P13-AL-30: write the predicate at the width of the law. A list would
# be defeated by moving a sentence -- a coverage claim pushed into an ungated
# document would keep whatever authority its reader grants it, and the gate would
# not have moved. So every document of this pack is gated EXCEPT the round
# records, whose exclusion is the coordinator's ruling and is stated as a residual
# in §3.2; and a NEW document appearing here is gated by default rather than
# needing to be remembered.
# `ROUND_RECORDS` used to live here as the bare prefix `P13-CHALLENGE-`. R14-01 killed
# it: the un-gated set is now DELIVERED_REVIEWER_REPORTS plus MY_ROUND_RECORD_RE, the
# same two facts the walk uses, so a lookalike cannot slip past both at once.
# Named one by one so that their ABSENCE reds. A set derived from a glob alone
# cannot fail closed: delete the manifest and a glob simply returns one name
# fewer, which is a check that stops looking when its subject disappears -- the
# F-28 defect wearing the other hat. These four are read by name, every time.
ALWAYS_NORMATIVE = ('P13-HANDOFF-MANIFEST.md', 'P13-S0-ARCHITECTURE-LOCK.md',
                    'regenerate-manifest.py', 'runs/P13-3.5a-block.sha256')


def normative_files() -> list[str]:
    """The documents whose §3 coverage claims are gated.

    R14-01's second half: the un-gated set used to be the bare prefix `P13-CHALLENGE-`,
    so a file I could name myself was neither hashed nor checked. It is now exactly the
    delivered reviewer reports (not mine to gate) plus my own round records matched on an
    ANCHORED hexadecimal subject (historical by ruling: a round record may quote a claim
    that was false at the time). Everything else here is gated, lookalikes included.
    """
    docs = sorted(f.name for f in HERE.glob('*.md')
                  if f.is_file()
                  and not _is_reviewer_file(f.name)
                  and not _is_my_round_record(f.name))
    return list(ALWAYS_NORMATIVE) + [d for d in docs if d not in ALWAYS_NORMATIVE]

# The VERB, in the present tense, with §3 as its subject -- not the noun. "§3's
# digest table comes from the bytes on disk" and "with §3 naming the witness's
# changed digest" describe the mechanism and assert coverage of nothing, so a gate
# that red on them would be the wolf-crier of F-29.
CLAIM_RE = re.compile(
    r'(?:§3\s+(?:already\s+|now\s+|still\s+)?(?:digests|hashes)\b)'
    r'|(?:\b(?:digested|hashed)\s+(?:in|by|under)\s+§3\b)',
    re.IGNORECASE)
PATH_RE = re.compile(r'`([^`*]+?\.(?:md|log|sha256|py|json))`')
# C-1: the exemptions are applied at TWO different scopes, because the words
# behave differently.
#
# A NARRATION word governs the whole sentence: "this paragraph used to read X"
# and "the sentence said X" are records of a defect, not instances of one.
#
# A NEGATION governs its own CLAUSE only. The first version of this gate applied
# both at sentence scope, and the coordinator's review measured what that cost:
# a live false sentence in the lock survived it --
#     "the limit is stated (a change altering only inter-line whitespace is not
#      detected by the witness, and §3 digests the file byte for byte besides)"
# -- because the "not" of the FIRST clause exempted the false claim in the
# second. So the self-test's own claim, that it "is what catches F-32 itself",
# was false as written. A negation is now read only in the clause it sits in.
#
# And a QUOTATION is not an assertion: quoted spans are removed before any of
# this, so the manifest can narrate the sentence F-28 was raised for without the
# gate reading the quotation as a new instance of it.
#
# A claim whose subject is the whole CLASS ("every file this directory holds")
# states the law, which the glob and the table answer, not one path.
NARRATION = ('used to', 'said', 'claimed', 'was false', 'F-24', 'F-27', 'F-28',
             'F-32', 'every file', 'everything')
NEGATION = ('not ', 'no ', 'never', 'cannot', "can't", 'nothing', 'neither',
            'deliberately', 'would', 'false')
QUOTED_RE = re.compile(r'"[^"]{0,400}"|“[^”]{0,400}”|\*"[^"]{0,400}"\*')
CLAUSE_RE = re.compile(r'[,;:()]')


def coverage_claims() -> list[str]:
    """Every §3 coverage claim in the normative files that §3 does not back.

    Returns one line per failure, naming the file, the subject and why.
    """
    recorded: set[str] = set()
    for line in table().split('\n'):
        parts = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(parts) >= 4 and re.fullmatch(r'`[0-9a-f]{64}`', parts[3]):
            recorded.add(parts[0].strip('`'))
    bad: list[str] = []
    for name in normative_files():
        f = HERE / name
        if not f.is_file():
            bad.append(f'{name}: a normative file this self-test must read is MISSING')
            continue
        try:
            text = re.sub(r'\s+', ' ', f.read_text(encoding='utf-8'))
        except OSError as exc:
            bad.append(f'{name}: unreadable, so its claims are UNJUDGED ({exc})')
            continue
        for raw in re.split(r'(?<=[.!?])\s+', text):
            sent = QUOTED_RE.sub(' … ', raw)
            if not CLAIM_RE.search(sent):
                continue
            low = sent.lower()
            if any(w.lower() in low for w in NARRATION):
                continue
            # the negation must sit in the SAME clause as the claim
            clauses = CLAUSE_RE.split(sent)
            claimed = [i for i, c in enumerate(clauses) if CLAIM_RE.search(c)]
            if claimed and all(
                    any(w.lower() in clauses[i].lower() for w in NEGATION) for i in claimed):
                continue
            # The subject may sit in the claim's own clause or in the one before
            # it, because "`X`, which §3 digests" is an ordinary appositive and
            # the antecedent of a relative clause is the clause before it. It may
            # NOT sit further back: that is the distance at which "the limit is
            # stated (…, and §3 digests the file byte for byte besides)" borrowed
            # a subject it did not have.
            if claimed:
                window = []
                for i in claimed:
                    window.append(clauses[i])
                    if i > 0:
                        window.append(clauses[i - 1])
                sent = ' '.join(window)
            subjects = PATH_RE.findall(sent)
            if not subjects:
                bad.append(f'{name}: a §3 coverage claim names NO subject — '
                           f'"{sent[:120].strip()}"')
                continue
            for subject in subjects:
                if subject not in recorded:
                    bad.append(f'{name}: claims §3 digests `{subject}`, which has no '
                               f'digest row in §3 — "{sent[:100].strip()}"')
    return bad


CODE_RE = re.compile(r'\| Exit code \| \*\*(-?\d+)\*\* \|')
COUNT_RE = re.compile(r'\| Artifacts compared, both ways \| \*?\*?(\d+)\*?\*? \|')
CHECK_WITNESS_NAME = 'P13-3.5b-check-row.sha256'


def check_witness_path() -> Path:
    return HERE / 'runs' / CHECK_WITNESS_NAME


def check_witness_line(body: str) -> str:
    return '\n'.join([
        f'# The SHA-256 of §3.5b\'s generated block in {MANIFEST.name}, written by',
        '# regenerate-manifest.py (no arguments) and compared by --check (R12-07).',
        '# §3 digests every file this directory holds, this one included, so editing it alone makes',
        '# §3 stale -- verify that by name: this file must have its own row in §3.',
        '# Limit: it covers §3.5b and nothing else.',
        hashlib.sha256(_normalised_block(body)).hexdigest(),
    ]) + '\n'


def recorded_check_witness() -> str | None:
    """The digest §3.5b's block had when it was written, or None.

    R12-07, a P1 fail-open found by a challenger. §3.5b recorded a verdict and
    keyed it to §3's block digest, which says WHICH table the verdict was measured
    over and nothing about the row's own bytes. With one hand edit -- a decoy
    `| Exit code | **0** |` line planted above the real row, which `re.search`
    matches first, and the generated row re-typed -- `--check` exited 0 and
    printed that §3.5b agreed with it. The first-match lesson of `P10 R5/R6`, in
    this pack's own gate.

    Two halves close it. The block must carry EXACTLY ONE exit-code row, or the
    gate refuses to read it at all (exit 2): a second row is not a stale figure,
    it is an ambiguous record. And the block's own bytes are witnessed in
    `runs/P13-3.5b-check-row.sha256`, exactly as §3.5a's are (`F-27`).

    Why the §3-block key is GONE rather than kept beside the witness: §3 digests
    every file under runs/, so §3 would digest this witness, whose bytes follow
    the block, which would carry a digest of §3 -- a cycle with no fixed point.
    The witness plus the recorded-versus-live comparison is strictly stronger than
    the key was, so the key is the half that goes.
    """
    return _only_digest(check_witness_path())


def check_row_table(code: int, count: int) -> str:
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
    return '\n'.join([
        '| What `--check` reported on the committed tree | Value |',
        '|---|---|',
        f'| Exit code | **{code}** |',
        f'| Artifacts compared, both ways | {count} |',
        f'| Measured at | {stamp}, by the run that generated §3 |',
        '',
        'Generated, never typed. The script runs its own `--check` on the file it has just written,',
        'records what that command reported, and then runs a PLAIN `--check` to verify that this row',
        'agrees with the gate a reader would run (`R12-08`). The row carries exactly ONE exit-code',
        'line and ONE count line -- a second of either makes the record ambiguous and the gate',
        'refuses to read it -- and its own bytes are witnessed in',
        '`runs/P13-3.5b-check-row.sha256`, which §3 digests (`R12-07`).',
        '',
        '**Every figure here is recomputed and compared by `--check`:** the exit code against the',
        'verdict the run is about to return, and the count against `len(artifacts())`. `R13-01`: a',
        'witness over a block\'s bytes proves WHEN it was written, never that what it says was',
        'measured, and this block once had one row compared and the rest merely witnessed.',
        '',
        '**The timestamp cannot be recomputed, but it is no longer unverified**, which is what this',
        'block used to claim (`R14-03`, and the correction is the challenger\'s, not mine). Because',
        'regeneration is the LAST write of a round, no hashed artifact may be NEWER than the stamp,',
        'and that is checkable from the bytes on disk: `--check` compares every artifact\'s mtime',
        'against it and refuses BY NAME if one is later. The limit of THAT, stated in the same',
        'breath: an mtime is writable too, so the bound catches a backdated stamp, not an author who',
        'also rewrites the clock on every file it covers.',
        '',
        'Regeneration is the LAST write of a round, after every document and after the push.',
    ])


def _block(text: str, begin: str, end: str, what: str) -> tuple[str, str, str]:
    """Split `text` around a generated block, refusing to guess if it is absent."""
    if begin not in text or end not in text:
        raise GitUnavailable(f'{MANIFEST.name}: the {what} markers are missing; refusing to guess where it goes')
    before, rest = text.split(begin, 1)
    body, after = rest.split(end, 1)
    return before, body, after


def _recorded(body: str, prefix: str) -> set[str]:
    return {line for line in body.splitlines() if line.startswith(prefix)}


def main() -> int:
    global REPO
    REPO = find_repo()
    check = '--check' in sys.argv[1:]
    # The regeneration run below invokes `--check --bootstrap` on the file it has
    # just written, and that one run does NOT compare §3.5b's recorded exit code
    # with the code it is about to return -- because the row has not been written
    # yet. Every other run does. That is the whole self-reference, named and
    # confined to one flag rather than left implicit.
    bootstrap = '--bootstrap' in sys.argv[1:]
    remeasure = '--measure-install' in sys.argv[1:]
    text = MANIFEST.read_text(encoding='utf-8')
    try:
        d_before, d_body, d_after = _block(text, BEGIN, END, 'generated-digest-table')
        g_before, g_body, g_after = _block(text, GIT_BEGIN, GIT_END, 'generated-git-status')
        i_before, i_body, i_after = _block(text, INSTALL_BEGIN, INSTALL_END, 'generated-install-measurement')
        c_before, c_body, c_after = _block(text, CHECK_BEGIN, CHECK_END, 'generated-check-row')
    except GitUnavailable as exc:
        print(exc)
        return 2

    if remeasure:
        try:
            rows_measured = measure_install()
        except GitUnavailable as exc:
            print(f'{MANIFEST.name}: §3.5a cannot be measured — {exc}')
            return 2
        body = install_table(rows_measured)
        fresh = f'{i_before}{INSTALL_BEGIN}\n{body}\n{INSTALL_END}{i_after}'
        MANIFEST.write_text(fresh, encoding='utf-8')
        WITNESS.parent.mkdir(parents=True, exist_ok=True)
        WITNESS.write_text(witness_line(body), encoding='utf-8')
        print(f'{MANIFEST.name}: §3.5a re-measured by installing the package manifest:')
        for line in rows_measured:
            print(f'  {line}')
        return 0

    # A failure to measure the git facts is never downgraded to "the table is
    # fine" -- but it must not void the DIGEST verdict either. F-12: a reviewer
    # whose clone the resolver could not read got exit 2 and no judgement on
    # anything, and had to hash eighteen files by hand to learn what the tool
    # was for. The digests need no repository at all, so under --check they are
    # judged regardless and §3.6 reports itself as unmeasured.
    git_error: str | None = None
    fresh_git_rows: list[str] = []
    fresh_git = ''
    try:
        fresh_git_rows = git_record_rows()
        fresh_git = git_table()
    except GitUnavailable as exc:
        git_error = str(exc)
        if not check:
            print(f'{MANIFEST.name}: §3.6 cannot be measured — {git_error}')
            print(f'  worktree looked for at {REPO} (override with P13_REPO=<path>)')
            return 2

    if check:
        stale: list[tuple[str, list[str]]] = []
        # C-3: the comparison is TWO-WAY, and it was not.
        #
        # `rows() - recorded` catches a file that is new or changed. It cannot
        # catch a file that is GONE: deleting an artifact just makes `rows()`
        # one row shorter, the difference stays empty, and `--check` said "§3 is
        # current" at exit 0 while two hashed artifacts had been deleted --
        # measured on a freshly regenerated copy. A check that stops looking
        # when its subject disappears is the F-28 defect wearing the other hat,
        # and a manifest's whole job is to say an artifact EXISTS.
        #
        # So the rows recorded for artifacts no longer on disk are reported too,
        # and under their own heading, because the remedy is not the same: a
        # stale row is regenerated, a missing artifact has to be found or the
        # claim withdrawn deliberately.
        recorded_rows = _recorded(d_body, '| `')
        fresh_rows = set(rows())
        digest_missing = sorted(fresh_rows - recorded_rows)
        if digest_missing:
            stale.append(('§3 digest table', digest_missing))

        def _named(row_lines: set[str]) -> dict[str, str]:
            named: dict[str, str] = {}
            for line in row_lines:
                cells = [c.strip() for c in line.strip().strip('|').split('|')]
                if cells and cells[0].startswith('`'):
                    named[cells[0].strip('`')] = line
            return named

        on_disk = _named(fresh_rows)
        in_table = _named(recorded_rows)
        vanished = sorted(name for name in in_table if name not in on_disk
                          and name != MANIFEST.name)
        if vanished:
            stale.append(('§3 names artifacts that are NOT ON DISK',
                          [f'{name}: §3 carries a digest for it and the file is not here'
                           for name in vanished]))
        # R12-01: the CLASS claim, asserted rather than trusted. Every regular file
        # under this directory is either in the table, the manifest itself, or
        # named in EXEMPT_DIRS. Nothing else is permitted to exist unrecorded.
        in_table_names = set(_named(recorded_rows))
        uncovered = sorted(
            str(p.relative_to(HERE)) for p in HERE.rglob('*')
            if p.is_file() and not _exempt(p)
            and p.name != MANIFEST.name
            and str(p.relative_to(HERE)) not in in_table_names)
        if uncovered:
            stale.append(('§3 does NOT COVER files that are in this directory',
                          [f'{name}: no digest row, and no named exemption covers it'
                           for name in uncovered]))

        if git_error is None:
            git_missing = sorted(set(fresh_git_rows) - _recorded(g_body, '| '))
            if git_missing:
                stale.append(('§3.6 git status', git_missing))

        # R14-03: the stamp cannot be recomputed, but it CAN be bounded -- from Git,
        # which is outside anything this directory can edit.
        recorded_stamp, stamp_bad = stamp_violations(d_body)
        if stamp_bad:
            stale.append(('§3 stamp is OUTSIDE the window the commit and the clock allow',
                          stamp_bad))

        # R14-01: the footer's own list of exempt reviewer reports must be the walk's.
        # Both come from one enumeration here, so a disagreement means the footer was
        # edited by hand -- which is exactly how a name gets added to someone else's
        # column.
        footer_says = footer_reviewer_names(d_body)
        walk_says = sorted(n for n in exempted_files() if _is_reviewer_file(n))
        if footer_says != walk_says:
            stale.append(('§3 footer and the walk DISAGREE about the exempt reviewer reports',
                          [f'the footer names {len(footer_says)} and this script exempts '
                           f'{len(walk_says)}; only in the footer: '
                           f'{sorted(set(footer_says) - set(walk_says)) or "none"}; only in the '
                           f'walk: {sorted(set(walk_says) - set(footer_says)) or "none"}']))

        # The generator pin, anchored to Git (coordinator's ruling). Fail-closed.
        pin_ok, pin_says = False, ''
        try:
            pin_ok, pin_says = pin_verdict(subject_sha_local())
        except GitUnavailable as exc:
            pin_says = (f'the generator pin CANNOT BE CHECKED: {exc}. Refusing, because an '
                        'unchecked checker is not a checked one')

        # §3.5a is judged on ITS OWN SUBJECT: the file whose install it measured.
        # It is not re-installed here -- a check must stay cheap and offline --
        # so what is compared is the digest the measurement recorded.
        install_stale: list[str] = []
        subject_changed = False
        install_judged = True
        try:
            want = f'| `{PACKAGE_JSON}` SHA-256 | `{package_manifest_digest()}` |'
            if want not in _recorded(i_body, '| `'):
                install_stale.append(want)
                subject_changed = True
                stale.append(('§3.5a install measurement', install_stale))
        except OSError as exc:
            # R12-04: this used to be followed, in the same run, by "§3.5a is
            # current — it measured the package.json that is on disk now", because
            # `install_stale` is empty when nothing was judged. A check that could
            # not look must not reassure.
            install_judged = False
            print(f'{MANIFEST.name}: §3.5a NOT JUDGED — {PACKAGE_JSON} unreadable here ({exc})')

        # F-27: the key above covers §3.5a's SUBJECT and not its own output, so a
        # re-typed measured row read as current. The block's own digest is kept
        # in `runs/P13-3.5a-block.sha256`, which §3 digests (F-28), and compared
        # here.
        try:
            witness = recorded_witness()
        except AmbiguousWitness as exc:
            print(f'{MANIFEST.name}: {exc}')
            return 2
        measured_now = hashlib.sha256(_normalised_block(i_body)).hexdigest()
        if witness is None:
            install_stale.append(f'| §3.5a witness | missing: {WITNESS.name} |')
            if not any(sec.startswith('§3.5a') for sec, _ in stale):
                stale.append(('§3.5a install measurement', install_stale))
        elif witness != measured_now:
            install_stale.append(f'| §3.5a block SHA-256 | recorded `{witness}`, the block now hashes `{measured_now}` |')
            if not any(sec.startswith('§3.5a') for sec, _ in stale):
                stale.append(('§3.5a install measurement', install_stale))

        # F-32: the §3 coverage claims of the normative files, measured. This is
        # judged on every run of --check, and a failure here is a STALE row of the
        # same kind as any other: a sentence the table does not back.
        claim_failures = coverage_claims()
        if claim_failures:
            stale.append(('§3 coverage claims', claim_failures))

        # R11-02 / R12-07: §3.5b's row is generated, and here it is judged.
        #
        # THREE things are checked, because a challenger defeated the first two
        # with one hand edit: the row must be UNAMBIGUOUS (exactly one exit-code
        # line, or this gate refuses to read it at all), its own BYTES are
        # witnessed in runs/, and the figure it records is compared with the
        # verdict this very run is about to return.
        row_failures: list[str] = []
        count_rows = COUNT_RE.findall(c_body)
        if len(count_rows) > 1:
            print(f'{MANIFEST.name}: §3.5b carries {len(count_rows)} artifact-count rows '
                  f'({", ".join(count_rows)}) — refusing to read an ambiguous record (R12-07, '
                  'applied to every row of this block and not only to the exit code).')
            return 2
        code_rows = CODE_RE.findall(c_body)
        if len(code_rows) > 1:
            print(f'{MANIFEST.name}: §3.5b carries {len(code_rows)} exit-code rows '
                  f'({", ".join(code_rows)}) — refusing to read an ambiguous record. '
                  'R12-07: a decoy row above the generated one is matched first by a '
                  'search, so this is exit 2 and not a stale figure.')
            return 2
        try:
            witness_recorded = recorded_check_witness()
        except AmbiguousWitness as exc:
            print(f'{MANIFEST.name}: {exc}')
            return 2
        witness_now = hashlib.sha256(_normalised_block(c_body)).hexdigest()
        if witness_recorded is None:
            row_failures.append(f'| §3.5b block SHA-256 | missing: runs/{CHECK_WITNESS_NAME} |')
        elif witness_recorded != witness_now:
            row_failures.append(f'| §3.5b block SHA-256 | recorded `{witness_recorded}`, '
                                f'the block now hashes `{witness_now}`, so it was edited '
                                'rather than measured |')
        if row_failures:
            stale.append(('§3.5b generated check row', row_failures))

        # The recorded-versus-live comparison. Its limit, stated: where §3.6 cannot
        # be measured the honest verdict is 3 while the recorded row legitimately
        # says 0, so the comparison is not made there and the run says so.
        # R14-01's sibling, found by my own replay rather than reported: this predicted
        # verdict was computed BEFORE the pin was weighed, so on a patched-and-regenerated
        # pack the gate printed "§3.5b records 2, this run returns 0" while actually
        # returning non-zero. A predicted exit code that omits one of the real exits is a
        # false figure in the one row whose whole job is to be comparable, so the pin's
        # verdict is folded in here, in the same order the returns below use.
        base_code = (1 if stale
                     else 2 if not pin_ok
                     else 3 if git_error is not None
                     else 0)
        code_mismatch = False
        # R13-01, a bounded fail-open: the exit code was recomputed and compared and
        # the COUNT beside it was neither, so three coordinated edits (the count
        # re-typed to 999, the witness recomputed with this script's own helper,
        # and §3's row for that witness rewritten by hand) left the gate at rc 0
        # printing the true 74 next to a row reading 999. A witness over a block's
        # bytes proves WHEN it was written, never that what it says was measured.
        # So every figure in §3.5b is now either recomputed and compared, or named
        # as unverifiable: the timestamp is the one row that cannot be RECOMPUTED, and
        # R14-03 bounds it by the mtimes of the artifacts the block covers.
        recorded_count = COUNT_RE.search(c_body)
        live_count = len(artifacts())
        if recorded_count is None:
            row_failures.append('| Artifacts compared, both ways | NOT RECORDED as a measured figure |')
        elif int(recorded_count.group(1)) != live_count:
            row_failures.append(f'| Artifacts compared, both ways | §3.5b records '
                                f'**{recorded_count.group(1)}**, this run counts **{live_count}** |')
        if row_failures and not any(sec.startswith('§3.5b generated') for sec, _ in stale):
            stale.append(('§3.5b generated check row', row_failures))

        if not bootstrap and git_error is None:
            recorded_code = CODE_RE.search(c_body)
            if recorded_code is None:
                code_mismatch = True
                row_failures.append('| Exit code | NOT RECORDED as a measured figure |')
            elif int(recorded_code.group(1)) != base_code:
                code_mismatch = True
                row_failures.append(f'| Exit code | §3.5b records **{recorded_code.group(1)}**, '
                                    f'this run returns **{base_code}** |')
            if row_failures and not any(sec.startswith('§3.5b generated') for sec, _ in stale):
                stale.append(('§3.5b generated check row', row_failures))

        for section, missing in stale:
            # §3.5a has its own remedy and its own line below: it is not fixed by
            # a plain regeneration run, because fixing it means installing.
            how = ('re-run with --measure-install' if section.startswith('§3.5a')
                   else 'run this script with no arguments, AFTER every other write of the round'
                   if section.startswith('§3.5b generated')
                   else 'correct the sentence, or add the row it claims'
                   if section.startswith('§3 coverage')
                   else 'restore the artifact, or withdraw the claim deliberately'
                   if section.startswith('§3 names')
                   else 'run this script with no arguments, or name an exemption in EXEMPT_DIRS'
                   if section.startswith('§3 does NOT COVER')
                   else 'run this script with no arguments')
            print(f'{MANIFEST.name}: {section} IS STALE in {len(missing)} row(s) — {how}')
            for line in missing:
                print(f'  expected: {line}')

        if not digest_missing and not vanished and not uncovered:
            print(f'{MANIFEST.name}: §3 is current ({len(rows())} artifacts), compared BOTH ways and '
                  'over a RECURSIVE walk of every regular file here — this needs no repository and is '
                  'judged from the bytes on disk')
        exempted = exempted_files()
        if exempted:
            for name in exempted:
                why = ('a DELIVERED reviewer report, exempt by name from this script\'s list'
                       if _is_reviewer_file(name)
                       else f'a byte-cache under {EXEMPT_DIRS[0]}/')
                print(f'  NOT HASHED, exempt by name: {name} — {why}')
            for name in lookalike_files():
                print(f'  HASHED AS MINE: {name} — it wears a reviewer\'s name but is not one of '
                      'the delivered reports, and a name I control cannot put a file outside this '
                      'table (R14-01)')
        if not claim_failures:
            print(f'§3 coverage claims are backed — every present-tense claim that §3 COVERS some '
                  f'artifact, in {len(normative_files())} normative files, names a subject that has a '
                  'digest row. Round records are not scanned; see coverage_claims()')
        if git_error is None and not any(section.startswith('§3.6') for section, _ in stale):
            print(f'{MANIFEST.name}: §3.6 is current ({len(fresh_git_rows)} measured rows)')
        if not install_judged:
            pass  # R12-04: the NOT JUDGED line above is the whole verdict
        elif not install_stale:
            print(f'{MANIFEST.name}: §3.5a is current — it measured the `package.json` that is on disk now')
        elif subject_changed:
            print(f'{MANIFEST.name}: §3.5a IS STALE — `{PACKAGE_JSON}` has changed since it was '
                  'measured; re-run with --measure-install (it installs, and reaches the network)')
        else:
            print(f'{MANIFEST.name}: §3.5a IS STALE — its own generated rows do not match the '
                  f'digest in runs/{WITNESS.name}, so the block was edited rather than measured; '
                  're-run with --measure-install')

        if not code_mismatch and not bootstrap and git_error is None:
            print(f'{MANIFEST.name}: §3.5b agrees with this run — it records exit '
                  f'**{base_code}**, which is what this run returns')
        elif bootstrap:
            print(f'{MANIFEST.name}: §3.5b NOT COMPARED — this is the bootstrap run that '
                  'measures it')
        elif git_error is not None:
            # R12-05: this sentence used to hard-code "the recorded 0 is not
            # wrong" — a typed figure inside the line that explains why a figure
            # is not typed. It reads the row.
            shown = CODE_RE.search(c_body)
            recorded = shown.group(1) if shown else 'no figure'
            print(f'{MANIFEST.name}: §3.5b NOT COMPARED — §3.6 could not be measured here, so this '
                  f'run returns 3 while §3.5b records **{recorded}**, measured where §3.6 could be '
                  'read. Neither figure is wrong and this run does not judge that row')

        # R14-05: WHICH worktree answered, said out loud. `Pushed?` and the install rows
        # describe whatever sits at that path, so a reader must not have to guess whether
        # they are reading their own clone or mine.
        if git_error is None:
            named = os.environ.get('P13_REPO')
            try:
                ambient_head = git('rev-parse', 'HEAD')
            except GitUnavailable:
                ambient_head = '(no HEAD)'
            try:
                subject = subject_sha_local()
            except GitUnavailable:
                subject = '(unresolved)'
            where = (f'P13_REPO={named}' if named
                     else f'the AMBIENT clone at {REPO} (no P13_REPO was set)')
            print(f'  measured in {where}; its HEAD is {ambient_head[:7]} and the subject '
                  f'branch {BRANCH} resolves there to {subject[:7]}'
                  + ('' if ambient_head.startswith(subject[:7]) and subject != '(unresolved)'
                     else ' — these differ, so the rows describe that worktree, not the subject '
                          'commit; point P13_REPO at a clone AT the subject SHA to compare them'))
        print(f'  {pin_says}')
        planted = replace_refs()
        if planted:
            print(f'  DISCLOSED: this repository carries {len(planted)} `refs/replace/` '
                  'entry(ies). Every git invocation in this script runs with '
                  '`--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS=1`, so the figures above '
                  'are read from the real objects; the entries are named because their '
                  'presence is itself worth reading:')
            for entry in planted:
                print(f'    {entry}')

        if stale:
            return 1
        if not pin_ok:
            print(f'{MANIFEST.name}: REFUSING — the digests are verified and the GENERATOR is not. '
                  'A pack whose checker cannot be traced to a commit certifies nothing about '
                  'itself (exit 2).')
            return 2
        if git_error is not None:
            print(f'{MANIFEST.name}: §3.6 NOT MEASURED — {git_error}')
            print(f'  worktree looked for at {REPO} (override with P13_REPO=<path>)')
            print('  exit 3 = the digests are verified and the branch rows were not measured. It is')
            print('  NOT a stale row, and it says nothing about the branch either way.')
            return 3
        return 0

    def write_digests() -> str:
        text_now = MANIFEST.read_text(encoding='utf-8')
        d_b, _, d_a = _block(text_now, BEGIN, END, 'generated-digest-table')
        out = f'{d_b}{BEGIN}\n{table()}\n{END}{d_a}'
        g_b, _, g_a = _block(out, GIT_BEGIN, GIT_END, 'generated-git-status')
        out = f'{g_b}{GIT_BEGIN}\n{fresh_git}\n{GIT_END}{g_a}'
        MANIFEST.write_text(out, encoding='utf-8')
        return out

    def run_self(*flags: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(Path(__file__).resolve()), '--check', *flags],
                              capture_output=True, text=True, cwd=str(HERE))

    def write_check_row(code: int, count: int) -> None:
        body = check_row_table(code, count)
        c_b, _, c_a = _block(MANIFEST.read_text(encoding='utf-8'),
                             CHECK_BEGIN, CHECK_END, 'generated-check-row')
        MANIFEST.write_text(f'{c_b}{CHECK_BEGIN}\n{body}\n{CHECK_END}{c_a}', encoding='utf-8')
        witness = check_witness_path()
        witness.parent.mkdir(parents=True, exist_ok=True)
        witness.write_text(check_witness_line(f'\n{body}\n'), encoding='utf-8')

    # R12-07 made §3.5b's block witnessed, and §3 digests every file under runs/,
    # so writing the witness stales §3 and regenerating §3 changes nothing the
    # witness covers. That is a two-step fixed point, not a cycle, so it is
    # iterated to stability rather than assumed: write the digests, measure, write
    # the row and its witness, and repeat until the measurement stops changing.
    recorded: tuple[int, int] | None = None
    for _attempt in range(5):
        write_digests()
        proc = run_self('--bootstrap')
        count = len(artifacts())
        found = re.search(r'§3 is current \((\d+) artifacts\)', proc.stdout)
        if found:
            count = int(found.group(1))
        measured = (proc.returncode, count)
        if recorded == measured:
            break
        write_check_row(*measured)
        recorded = measured
    else:
        print(f'{MANIFEST.name}: §3.5b did NOT settle in 5 passes — the pack is being changed '
              'underneath this run, or the gate is not deterministic. Nothing is claimed.')
        return 2

    print(f'{MANIFEST.name}: §3 regenerated over {len(artifacts())} artifacts; '
          f'§3.6 regenerated from git at {REPO}')
    print(f'{MANIFEST.name}: §3.5b measured by running --check on what was just written — '
          f'exit {recorded[0]} over {recorded[1]} artifacts')

    # R12-08: the row is headed `--check`, so it is verified against a PLAIN
    # `--check` -- the command a reader runs, with the row comparison included --
    # and not only against the bootstrap run that skips that one comparison.
    plain = run_self()
    if plain.returncode != recorded[0]:
        print(f'{MANIFEST.name}: REFUSING the row — a plain --check returns {plain.returncode} '
              f'where §3.5b records {recorded[0]}. The bootstrap run and the gate disagree, '
              'which is the R12-08 shape, and nothing here is to be trusted until it is explained:')
        for line in plain.stdout.splitlines():
            print(f'  | {line}')
        return 2
    print(f'{MANIFEST.name}: a plain --check agrees — exit {plain.returncode}, '
          'the same figure §3.5b records')
    if recorded[0] != 0:
        # R15-02, folded into this round: this arm printed "the pack does NOT pass its
        # own gate" and then returned 0, so a caller that reads the exit code -- which is
        # what a CI step does, and what the install block's own law says to do -- was told
        # the regeneration succeeded by a run that had just measured its own refusal. The
        # regeneration now returns the code the gate returns, so the two cannot disagree.
        print('  the pack does NOT pass its own gate; --check said:')
        for line in plain.stdout.splitlines():
            print(f'  | {line}')
        print(f'  this regeneration run therefore exits {recorded[0]}, the figure the gate '
              'returns, and not 0')
        return recorded[0]
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
