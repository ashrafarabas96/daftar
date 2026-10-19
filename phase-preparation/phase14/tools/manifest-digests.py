#!/usr/bin/env python3
"""Generate (or check) the SHA256 and byte columns of the handoff manifest.

Round 4's lesson, applied one layer further: a digest that is typed is a claim,
and this manifest's rows were typed. Every round the challenger re-hashes all of
them by hand; one stale row would be a correct-looking digest beside a changed
file, which is the shape P14-CHALLENGE P3-07 already found once in this manifest
(a right hash beside a wrong description).

  usage: tools/manifest-digests.py [--manifest F] [--dir D] [--write | --check]

--write rewrites the hash and byte cells of every artifact row from the file on
disk and reports any artifact present in the directory with no row, or any row
with no file. --check exits 1 if any cell is stale or any artifact is unlisted,
which is what the handoff gate runs. The manifest lists the files as they stand
in the SHARED FOLDER, so --dir defaults there; `--dir .` checks the repo copy.
"""
import argparse, hashlib, os, re, shutil, subprocess, sys

# ROUND-9 CHALLENGE P2-02: the unsigned placeholder used to be sixty-four
# ZEROS, which is a well-formed digest. One `sed` over a challenge row turned
# the refusal below into an escape hatch: zero the digest, `--write`, and the
# row is re-signed against a TAMPERED reviewer's report. A placeholder must be
# something corrupting a digest cannot produce, so it is the literal `UNSIGNED`
# in BOTH cells -- and a row with one placeholder cell and one real one is not
# a placeholder at all.
# CHALLENGE R26-P1-01, a FAIL-OPEN: a row may also name a DECLARED SUBTREE,
# written with a trailing slash. See the enumeration below for why.
ROW = re.compile(r'^\| `(P14-[^`]+|README-AR\.md|[A-Za-z0-9._-]+/)` \| (.*?) \| `([0-9a-f]{64}|UNSIGNED)` \| ([0-9,]+|UNSIGNED) \|$')
PLACEHOLDER = 'UNSIGNED'

# CHALLENGE R26-P1-01, measured by the challenger with five plants and
# reproduced here before anything was changed: this manifest's enumeration read
# `os.listdir` with an extension filter, so `zz-planted.txt` at the top level,
# `tools/zz-planted.md` and `proofs/zz-planted.md` one directory down, and
# `P14-CHALLENGE-ZZZZZZZ.MD` spelled in upper case all left `--check` at rc 0
# while the identical bytes under `.md` refused by name. It was a FAIL-OPEN and
# not a shape residual, because the invisible file reaches a PUBLISHED figure:
# `retracted-claims.py` walks recursively, so with `proofs/zz-planted.md`
# planted it moved from `41 pack document(s)` to `42` while this gate stayed
# green. A pin that stops where another instrument keeps reading is not a pin.
#
# So the domain is now EVERY file under the pack directory, at any depth, in any
# extension and in any case. Files at the top level need a row each, as before.
# A first-level directory is pinned by ONE row named with a trailing slash whose
# digest is taken over the name, size and SHA-256 of every file beneath it, at
# any depth, so an added, removed, renamed or edited file moves it; a
# first-level directory with no such row refuses by name.
#
# CHALLENGE R27-P2-01 measured the law "an added, removed, renamed or edited file
# moves this digest" FALSE: a record of the form "<digest>  <relpath>" is not
# injective, because a FILENAME MAY CONTAIN A NEWLINE. Two different trees were
# built that hash identically over identical byte totals. Two changes answer it,
# both in `tools/pack-domain.py`: the file COUNT is part of the digested text,
# and the names a line-based record cannot carry (NUL, newline, CR) are REFUSED
# rather than digested -- as are symbolic links, dangling ones included, which
# the shell recipe below would follow and the tool would not.
#
# The digest is written so a reviewer can recompute it without this tool, and the
# recipe is the tool's text EXACTLY -- the count line first, then one line per
# file -- because a published recipe that is merely close is a false sentence
# about how the figure was made. CHALLENGE R28-P3-01 bounded that sentence and
# the clause is now part of it: the recipe reproduces the row **when the run
# reports 0 excluded directories**, because `find -type f` descends into a
# directory git accepts as a repository and this tool does not -- with a real
# repository inside `proofs/` the challenger measured the tool holding the row
# at rc 0 while the recipe returned a different digest. It is also faithful only
# on a tree the tool would ACCEPT: a refused name, link, FIFO or unreadable
# directory makes the tool refuse and leaves the shell computing a digest of
# something the pack does not contain. Both directions are safe -- the tool is
# the stricter of the two -- and both are said rather than left to a reviewer to
# discover.
#
#   { printf '%s file(s)\n' "$(find <dir> -type f | wc -l)"; \
#     find <dir> -type f | LC_ALL=C sort | while read -r f; do \
#       printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f#<dir>/}"; done; } \
#     | sha256sum
# CHALLENGE R27-P1-01, a FAIL-OPEN, and the coordinator's ruling: the pack's
# domain is no longer defined in this file at all. It lives in
# `tools/pack-domain.py`, which every instrument loads by path and REFUSES
# unless its sha256 equals the literal pinned here, then execs. Three
# instruments cannot drift apart if there is one walk; and an edited domain
# refuses in all three until each pin is updated deliberately. The previous
# shape -- a structural `is_repo_dir` here and in `retracted-claims.py`, a name
# test in `citation-provenance.py` -- let a planted
# `zz-hide/{HEAD, objects/, refs/, zz-doc.md}` hide a pack document from THIS
# gate while moving a figure published for that SHA from 42 to 43 document(s).
# Round 26's structural test was itself too weak: the challenger's cheapest
# forgery is three entries with an EMPTY `HEAD`, which git rejects and a
# HEAD/objects/refs test accepts. The question is now put to git.
_DOMAIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pack-domain.py')
_DOMAIN_SHA = 'd6a48ae0a4f8961ff25b35aff8a61c5e2c6e234cd2b85505544e610de1c44483'


def _load_domain():
    try:
        src = open(_DOMAIN_FILE, 'rb').read()
    except OSError as exc:
        # The three instruments say this in the SAME words, because a refusal a
        # runner greps for is a name, and three spellings of one condition is
        # three conditions to a reader. The sweep arms key on this sentence.
        print('CONFIGURATION ERROR: THE SHARED ENUMERATION COULD NOT BE READ. %s (%s: %s), so this'
              ' run enumerated nothing and nothing here is a verdict about this manifest.'
              % (_DOMAIN_FILE, type(exc).__name__, exc), file=sys.stderr)
        raise SystemExit(2)
    got = hashlib.sha256(src).hexdigest()
    if got != _DOMAIN_SHA:
        print('CONFIGURATION ERROR: THE SHARED ENUMERATION DOES NOT MATCH ITS PIN. %s hashes %s'
              ' and this tool is pinned to %s. The three instruments of this pack must enumerate'
              ' one domain, so a domain this tool cannot recognise is refused rather than used.'
              % (_DOMAIN_FILE, got, _DOMAIN_SHA), file=sys.stderr)
        raise SystemExit(2)
    ns = {'__name__': 'pack_domain', '__file__': _DOMAIN_FILE}
    exec(compile(src, _DOMAIN_FILE, 'exec'), ns)
    return ns


_D = _load_domain()

# COORD DIFF REVIEW AT c812aa5, R-03: only names beginning P14-CHALLENGE- were held
# to the reviewer-row rules, so a coordinator's review could be tampered with and
# re-signed. A review is a review whoever wrote it.
REVIEWER_PREFIXES = ('P14-CHALLENGE-', 'P14-COORD-DIFF-REVIEW-')
# CHALLENGE R15-P0-01, which BLOCKED, and the coordinator's ruling on it: the
# history walk may not rest on git's RENAME-SIMILARITY score, because the
# content that score is computed over is content the attacker writes in the
# same commit. Measured in the challenger's world `G2` -- rename to a new
# basename, move out of the pack, forge a reviewer row AND rewrite the
# manifest's prose, all in one commit -- `git log --follow` found 1 revision of
# 4 at the default threshold, 1 at `-M50%`, 1 at `-M20%`, and only 4 at `-M10%`.
# Tuning `-M` is not a fix; it is the same lottery at a different odds. So the
# manifest is identified by a MARKER it carries, the walk asks `git grep` which
# file in each revision carries it, and every path it is found at seeds a
# further `rev-list` until no new path appears. A move, a rename, a prose
# rewrite and all three at once leave the marker in place, and an attacker who
# REMOVES it does not get a pass: the file under `--manifest` is required to
# carry it exactly once, so stripping it refuses by name before any history is
# read. The marker is a fixed literal here and not read from the file, because
# a marker the subject chooses is not an anchor.
MARKER = '# P14-HANDOFF-MANIFEST.md'
# CHALLENGE R16-P0-01, which BLOCKED, and the coordinator's ruling on it: the
# subject test and the two history legs differed BY ONE BYTE of normalisation.
# The subject was `ln.rstrip() == MARKER`, which eats a trailing space, a tab and
# a CR; the legs matched an exact `^marker$`, which does not. So a manifest whose
# marker line carries ONE TRAILING SPACE, or that was committed CRLF, satisfied
# the subject requirement while BOTH legs found zero revisions -- and the summary
# still read "found by the marker it carries and by every path it has held". Not
# only under attack: such a pack runs with the anchor silently inert from the
# day the byte appears, and nothing in this pack forbids either spelling.
# There is now ONE normalisation, written once and used three times: the marker
# line is the literal followed by any run of ASCII whitespace and nothing else.
# `[[:space:]]` in the C locale is space, tab, newline, vertical tab, form feed
# and CR, which is exactly the Python class below for a single line; a line
# cannot contain the newline. The `.` is escaped as `[.]` rather than with
# `re.escape`, because `re.escape` also escapes `#`, `-` and the space, and an
# ERE is not obliged to accept those as escapes.
MARKER_PY = re.compile(r'^' + re.escape(MARKER) + r'[ \t\r\f\v]*$')
MARKER_ERE = '^' + MARKER.replace('.', '[.]') + '[[:space:]]*$'

# CHALLENGE R22-P1-02, a FAIL-OPEN with narrow reach, and R22-P2-01, both in the
# PATH pin round 21 added. Two defects in one line.
#   (a) The pin read '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:...',
#       so its first two entries PRECEDE /usr/bin -- and /usr/local/bin is
#       exactly where a locally installed binary goes. Measured by the
#       challenger with a shim written to /usr/local/bin/git: rc 0, no refusal,
#       "all 3 revision(s)", and the provenance line naming
#       /usr/local/bin/git. Narrower than GIT_DIR, because it needs write
#       access to a system directory, but it is the very mechanism the pin was
#       added to close, and it is also an HONEST-MISTAKE surface: a CI step
#       that installs a newer git into /usr/local/bin silently changes which
#       binary this gate runs. So the pin is REORDERED with the system
#       locations first.
#   (b) The binary was resolved TWICE on the same string -- `shutil.which` for
#       the provenance line, and `subprocess` independently for the call -- so
#       the line ASSERTED a binary by a second lookup instead of REPORTING the
#       one that ran. It is resolved ONCE, here, and passed ABSOLUTE.
# With no git anywhere on the pinned path (an ordinary image with git in /opt,
# /nix/store or a Homebrew prefix) the subject answered rc 1 with a
# FileNotFoundError TRACEBACK -- and rc 1 is this gate's STALE code, so a
# runner could not tell "the manifest is stale" from "this tool could not run
# at all" (R22-P2-01). That condition is now a NAMED refusal at the
# CONFIGURATION code, 2, in main() below.
_PINNED_PATH = '/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin'
_GIT_BIN = shutil.which('git', path=_PINNED_PATH)

# CHALLENGE R23-P2-01, the reviewer's own finding about the remedy it had just
# recommended, and the coordinator measured it a P3 rather than a P2: the
# resolution above happens ONCE AT IMPORT and the file is used later, so if the
# resolved executable stops being runnable between those two moments -- removed,
# chmod'd, or never runnable in the first place because its interpreter is
# missing -- `subprocess.run` raises FileNotFoundError or PermissionError and
# this tool dies with an UNNAMED TRACEBACK at rc 1, which is this gate's STALE
# code. That is the exact failure shape R22-P2-01 closed one round earlier, and
# a bare name would have fallen through to the next candidate on the path
# instead. It fails CLOSED and never produces a green verdict, which is why it
# is a P3; it is still the wrong exit code with the wrong sentence, so the call
# is wrapped and the refusal is the configuration one, by name.
def _refuse_unrunnable_git(exc):
    print('CONFIGURATION ERROR: the `git` executable resolved on the pinned PATH'
          ' (%s) at start-up could not be run (%s: %s), so no history could be'
          ' read and nothing here is a verdict about this manifest.'
          % (_GIT_BIN, type(exc).__name__, exc), file=sys.stderr)
    raise SystemExit(2)


def _git_is_repo(path):
    """True / False / None -- None meaning git could not be asked.

    The question is whether PATH IS a git directory, not whether it sits inside
    one: `git -C <dir> rev-parse` answers rc 0 for every directory of this
    repository and would have excluded `proofs/`. Measured on this container:
    `--git-dir=` answers rc 0 for a real bare repository and for the real
    `.git`, rc 128 for `proofs/` and rc 128 for the challenger's cheapest
    CHALLENGE R28-P2-01: `rev-parse --git-dir` alone accepts a 20-byte forgery --
    `HEAD` holding `ref: refs/heads/main` with no trailing newline plus two EMPTY
    directories, measured rc 0 by the challenger and reproduced here. git checks
    neither that the branch exists nor that `objects/` holds anything. So the
    question is now composite, as the coordinator ruled: a repository must also
    RESOLVE A COMMIT. Measured on this container: the forgery is rc 128 on
    `--verify HEAD^{commit}` and the real `.git` is rc 0. A repository with no
    commits fails this too and therefore stays in the domain, which is
    fail-closed and is the direction this pack refuses in.
    forgery (three entries with an EMPTY HEAD). The runner is this tool's own
    hardened one -- every GIT_* scrubbed, replace objects and grafts disabled,
    the binary resolved once on the pinned PATH and passed absolute."""
    if _GIT_BIN is None:
        return None
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull, PATH=_PINNED_PATH)
    try:
        for _args in (['rev-parse', '--git-dir'], ['rev-parse', '--verify', 'HEAD^{commit}']):
            r = subprocess.run([_GIT_BIN, '--git-dir=' + path] + _args,
                               capture_output=True, text=True, env=env)
            if r.returncode != 0:
                return False
    except OSError:
        return None
    return True


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--manifest', default=os.path.join(here,'P14-HANDOFF-MANIFEST.md'))
    ap.add_argument('--dir', default='/mnt/project-files/phase14')
    ap.add_argument('--witness', help='directory holding the second copy of each'
                    ' reviewer report; defaults to the counterpart of --dir')
    # CHALLENGE R26-P3-02, the coordinator's wording: "add the shared-folder
    # comparison as a pre-commit step in the build, so an uncommitted reviewer
    # report reds before the push". Twice in two consecutive rounds a reviewer's
    # report sat in the shared folder while the commit went out without it
    # (09:08:24 and 09:30:26 UTC), and both times what caught it was a lane read
    # AFTER the push. This asks the question BEFORE: every reviewer-prefixed file
    # in the counterpart directory must have a row here AND be carried by this
    # commit -- the index counts, not only HEAD, because a file staged for the
    # commit about to be made IS in it. Use with --check; it adds refusals and
    # nothing else.
    ap.add_argument('--reports-in-tree', action='store_true',
                    help='refuse if a reviewer report in the counterpart directory'
                         ' is not carried by this commit (index or HEAD)')
    # CHALLENGE R27-P3-04, and the coordinator's wording: "add an --at-head leg that
    # reads HEAD alone and run it in the sweep after the commit". The index leg
    # answers BEFORE a commit, which is what the lane was added for, and it is
    # satisfied by `git add` -- so it cannot tell a staged report from a
    # committed one. The two legs answer two different questions and the sweep
    # now runs both: --reports-in-tree before the commit, --reports-at-head
    # after it, where only the commit itself can satisfy it.
    ap.add_argument('--reports-at-head', action='store_true',
                    help='refuse if a reviewer report in the counterpart directory'
                         ' is not carried by HEAD itself (the index does not count)')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true')
    # CHALLENGE R11-P2-01 and the COORDINATOR RE-REVIEW's remedy, which is the
    # stronger one and closes both: in a `--depth 1` clone WITH a matching
    # counterpart the committed forgery answered 0, because the history witness
    # was NOT CHECKED and the only witness left was the other directory, written
    # by the same hand. An ANNOUNCED blind spot still exits 0, and an exit code
    # is what a gate is read by. So NOT CHECKED is now a REFUSAL by default
    # whenever there is a reviewer row to protect, and a caller who accepts the
    # limit says so explicitly with --allow-unverified-history. My first attempt
    # at this had the default the other way round, which is the same mistake in
    # the opposite direction: the safe thing has to be what happens when nobody
    # passes a flag. `actions/checkout` defaults to `fetch-depth: 1`, so a CI job
    # running this gate needs `fetch-depth: 0`.
    ap.add_argument('--allow-unverified-history', action='store_true',
                    help='accept a history that CANNOT BE READ in full -- a shallow clone, a'
                         ' missing object, a non-blob revision (NOT CHECKED). It does NOT excuse a'
                         ' history that WAS read and records no reviewer digest'
                         ' (NO RECORD IN ANY REVISION), which refuses with this flag too'
                         ' (CHALLENGE R14-P3-02: the old text was wider than the behaviour).'
                         ' The limit is printed either way')
    a = ap.parse_args()

    # ROUND-8 CHALLENGE P3-02: an absent --dir refused by FileNotFoundError
    # TRACEBACK, and the shared folder is the one input most likely to be absent
    # in CI -- where a traceback is read as a broken tool, not as a failed gate.
    # Refuse by name, with the code the sweep expects.
    for label, path in (('--manifest', a.manifest), ('--dir', a.dir)):
        if not os.path.exists(path):
            print('CONFIGURATION ERROR: %s (%s) does not exist, so no digest can be'
                  ' compared. This is not a stale manifest and must not be read as one.'
                  % (label, path), file=sys.stderr)
            return 2
    # CHALLENGE R22-P2-01: refuse by NAME, at the CONFIGURATION code, when the
    # pinned path holds no git at all. rc 1 is this gate's STALE verdict; an
    # absent binary is not a verdict about this manifest.
    if _GIT_BIN is None:
        print('CONFIGURATION ERROR: no `git` executable was found on the pinned'
              ' PATH (%s), so no history could be read and nothing here is a'
              ' verdict about this manifest.' % _PINNED_PATH, file=sys.stderr)
        return 2
    lines = open(a.manifest, encoding='utf-8').read().split('\n')

    # ROUND-9 CHALLENGE P2-02, second remedy: a committed reviewer's digest must
    # not MOVE. The structural rule above stops a corrupted digest from being
    # re-signed; it cannot see a digest hand-edited to match the tampered file,
    # because such a row is self-consistent. Git can: the manifest's own history
    # says what digest was recorded when the report was received. When the
    # manifest is not in a repository this cannot be asked, and that is printed
    # as a STATED LIMIT rather than silently skipped -- a verdict that changes
    # with the location is round 8's defect, and a limit that is announced is
    # not one.
    # ROUND-10 CHALLENGE P2-01, which BLOCKED: round 9's guard compared a
    # reviewer's row against HEAD only, so one ordinary `git commit -am` of the
    # UNSIGNED row made HEAD carry the placeholder and the rule DISABLED ITSELF
    # -- while still printing "reviewer-row history checked". HEAD is written by
    # the same hand that writes the row, and a handoff IS a commit, so that is
    # the normal path, not an exotic one. Outside a repository the two-step
    # bypass survived too, disclosed but unclosed.
    #
    # For the third round running the protection was in fact being carried by
    # the one-manifest-two-directories construction, so that construction is now
    # the RULE and not a happy accident: a reviewer's report is checked against
    # the copy in the OTHER directory. The git history is still consulted, but
    # over EVERY revision of the manifest rather than HEAD.
    # COORDINATOR DIFF REVIEW AT c812aa5, P2-01, which BLOCKED: walking the
    # revisions newest-first with setdefault kept the NEWEST committed digest,
    # so whenever HEAD carried a digest the witness WAS HEAD -- and one ordinary
    # `git commit -am` of a tampered report plus a hand-forged row returned 0
    # while printing "checked over every revision". Round 10 closed the
    # committed-PLACEHOLDER route and left the committed-FORGERY route open:
    # the same species one step over. The witness is now the OLDEST recorded
    # digest, which is the one the report was RECEIVED with and which no later
    # commit can erase, and any LATER revision that records a different digest
    # for the same report is itself a refusal. COORD-DIFF-REVIEW AT 03b3a0b, B2:
    # this comment used to end "what a commit can still do is rewrite history,
    # and that is named as a limit rather than guarded here" -- which was false,
    # because one ordinary commit could also MOVE the pack and start a fresh
    # first revision at the new path. That route is closed below by anchoring
    # the walk to the manifest's NAME. Rewriting the manifest's own history
    # remains named as a limit rather than guarded.
    # R-08: a shallow clone and an unreadable revision are now NOT CHECKED, and
    # NOT CHECKED discards the history witness entirely instead of trusting the
    # fragment that happens to be present -- an incomplete history can begin at
    # a forged revision, so a partial walk must not be allowed to answer.
    def witness_default():
        d = os.path.abspath(a.dir)
        shared = '/mnt/project-files/phase14'
        return os.path.dirname(os.path.abspath(a.manifest)) if d == os.path.abspath(shared) else shared

    signed_history, moved = {}, {}
    history = 'checked over every revision of the manifest, OLDEST first'
    _nrevs = 0
    _md = os.path.dirname(os.path.abspath(a.manifest))
    _mb = os.path.basename(a.manifest)
    def _g(*argv):
        # CHALLENGE R15-P0-02, which BLOCKED: `core.quotePath` defaults TRUE, so
        # every git command that emits a path QUOTES a non-ASCII one
        # (`"\331\205..."`). The quoted string was then fed straight back to
        # `ls-tree -- <path>`, which answered EMPTY at rc 0 -- indistinguishable
        # here from "the path is not in this tree" -- so in the challenger's
        # world `M` (a manifest added at an Arabic path, then moved and forged)
        # the two revisions holding the TRUE digest were both counted as gaps
        # and the tool answered 0. This is an ar/en/tr product; that path shape
        # is ordinary. Every git call of this tool now runs with quoting OFF,
        # and a path that still arrives quoted is a NAMED REFUSAL below rather
        # than a skip.
        # CHALLENGE R18-P0-01, a FAIL-OPEN. Not one git call of this tool
        # disabled REPLACE OBJECTS, and git honours `refs/replace` by default in
        # rev-list, log, grep, show and ls-tree -- every subcommand used here.
        # So the history this whole verdict rests on was supplied by a ref
        # INSIDE the repository being judged: with one replacement commit per
        # honest revision, each carrying a manifest that already records the
        # FORGED digest, a forgery that is refused at rc 1 over 4 revisions
        # passes at rc 0 over 1. The remedy is the FLAG, not a check: the same
        # refs under `refs/other/` with `GIT_REPLACE_REF_BASE` set leave
        # `refs/replace` EMPTY while the forgery still passes, so a gate that
        # greps for replace refs reports clean. `--no-replace-objects` goes on
        # the HELPER, before the subcommand, where no call site can forget it --
        # the shape tools/citation-provenance.py already uses -- and
        # GIT_NO_REPLACE_OBJECTS is set as well so a replacement cannot be
        # reinstated through the environment. This is the Phase 8 and Phase 13
        # lesson, written down in both and applied in the sibling tool, missing
        # from the one tool whose entire output is a claim about history.
        # CHALLENGE R19-P0-01, the SAME CLASS one mechanism along: neither
        # `--no-replace-objects` nor GIT_NO_REPLACE_OBJECTS disables GRAFTS.
        # One line in `.git/info/grafts` naming the forging commit with no
        # parents truncated `rev-list HEAD` to 1 commit WITH the flag set,
        # and the refusal that had just been restored went away again at
        # rc 0. A check is no remedy here either: with GIT_GRAFT_FILE
        # pointing at a file somewhere else, `.git/info/grafts` is absent
        # and the truncation still applies. git does print a deprecation
        # hint on stderr, which this helper captures and discards, but the
        # hint is not the remedy: `-c advice.graftFileDeprecated=false`
        # silences it while the history stays truncated, the judged
        # repository's own config can set that key, and a later git drops
        # the hint along with the support. Pointing GIT_GRAFT_FILE at
        # os.devnull is the remedy, and it covers BOTH arms. NOT added
        # beside it: GIT_SHALLOW_FILE, measured by the challenger -- with
        # that variable set, `rev-parse --is-shallow-repository` answers
        # true on a full clone and this tool would refuse sound
        # repositories with its shallow-boundary sentence. Shallowness is
        # already handled by name.
        # CHALLENGE R20-P0-01, the same class a THIRD mechanism along:
        # `dict(os.environ, ...)` takes the caller's environment VERBATIM, and
        # GIT_DIR is in it. GIT_DIR BEATS `-C`, so the repository this tool
        # believes it is reading is caller-supplied. Measured: with the files of
        # a world whose 4th revision is the forgery, and GIT_DIR naming a
        # SEPARATE repository whose 3 revisions all already carry the forged
        # digest at the same relative path, the row refusal disappeared at rc 0
        # over "all 3 revision(s)"; and against the REAL pack, GIT_DIR pointed
        # at a clone of this repository one head back moved the published
        # revision count with the same exit code and the same sentence shape.
        # So the environment is BUILT, not inherited: every GIT_* name is
        # dropped and only what this tool needs is set. The scrub belongs HERE,
        # inside the helper, and must NOT be exported to tools/gate-sweep.sh or
        # to a CI step: every git call of this tool is a local read, while those
        # FETCH, and they need GIT_SSL_CAINFO and the migration-freeze anchor's
        # full-object-name fetch. GIT_EXEC_PATH is not set in this container, so
        # whether dropping it matters is UNMEASURED and named, not a pass.
        _env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        # CHALLENGE R21-P2-01, ruled a P2 and fixed anyway, with the reason
        # recorded so round 22 does not re-find it: `python3 -I` already stops
        # the caller's environment supplying this tool's PYTHON, while the same
        # environment still supplied its GIT. A two-line shim earlier on PATH
        # that execs the real git with `--git-dir` at a decoy answered rc 0 with
        # NO refusal where the subject refuses by row; with PATH pinned in this
        # same dict, both arms refuse. The argument against calling it a P0 is
        # true -- whoever sets PATH chose the python3 too, so unlike GIT_DIR it
        # is not something an honest unrelated step exports by accident -- and
        # the argument for fixing it is that this environment is already BUILT
        # rather than inherited, so it is one more key in a dict that exists.
        # Measured: the real pack is unchanged under the pinned PATH, and git
        # resolves to /usr/bin/git here.
        # CHALLENGE R22-P1-02: the pin is reordered (/usr/bin and /bin FIRST) and
        # the binary is the ONE object resolved at import, passed ABSOLUTE, so
        # no lookup inside the child can reach a shim earlier on a path. The
        # pinned PATH is still set, because it is what any process this git
        # starts will inherit.
        _env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull,
                    PATH=_PINNED_PATH)
        try:
            return subprocess.run([_GIT_BIN,'-C',_md,'--no-replace-objects',
                                   '-c','core.quotePath=false'] + list(argv),
                                  capture_output=True, text=True, env=_env)
        except (FileNotFoundError, PermissionError, OSError) as exc:
            _refuse_unrunnable_git(exc)
    def _quoted(path):
        '''True when git handed back a path this tool cannot use verbatim.'''
        return path.startswith('"') or '\\' in path
    # COORDINATOR DIFF REVIEW AT 03b3a0b, B2 (P2-01-ter), which BLOCKED: this
    # walk asked `git rev-list HEAD -- P14-HANDOFF-MANIFEST.md`, keyed to the
    # manifest's CURRENT path and blind to renames. ONE ordinary commit that
    # `git mv`s the pack directory while forging a reviewer row made the forging
    # commit the only -- and therefore the "oldest" -- revision at the new path:
    # its parent holds no file THERE, which the completeness test below read as
    # "the commit that added it". The forged digest became the witness, all
    # earlier received records at the old path were never read, and the tool
    # answered 0 while printing "checked over every revision of the manifest" --
    # in both lanes and with no counterpart at all. This is the fourth round of
    # one species: the witness anchored to something one commit can change. The
    # anchor is now the manifest's NAME anywhere in the tree, so a move keeps
    # the same history. `--follow` is NOT used: it finds a move only when git
    # scores the file as a rename, and a promotion commit that also rewrites the
    # manifest can fall under that score.
    _PS = ':(top,glob)**/%s' % _mb
    def _paths_at(rev):
        '''Every path in `rev` whose basename is the manifest's, with its mode.
        None means the tree itself could not be read -- never "no such path".'''
        # `ls-tree` does not accept `glob` pathspec magic ("pathspec magic not
        # supported by this command"), measured; so the whole tree is listed and
        # filtered here by basename. `rev-list` does accept it, which is what
        # selects the revisions.
        r = _g('ls-tree', '-r', '--full-tree', '--format=%(objectmode) %(path)', rev)
        if r.returncode != 0:
            return None
        out = []
        for ln in r.stdout.split('\n'):
            ln = ln.strip()
            if not ln:
                continue
            mode, _, path = ln.partition(' ')
            if os.path.basename(path) == _mb:
                out.append((mode, path))
        return out
    _revs = _g('rev-list', 'HEAD', '--', _PS)
    # CHALLENGE R14-P2-01: the NAME anchor closes a move, and not a move plus a
    # RENAME to a different basename in the same commit as the forge. Then the
    # new basename has exactly one revision, the forging one, and the walk again
    # read 1 of 3 and said "checked". The coordinator's ruling: refuse by name
    # under EVERY invocation, not only under the gate's default `--manifest`
    # (which answers 2 CONFIGURATION ERROR because the file is gone from --dir).
    # So the revision set is the UNION of two questions git can answer, and each
    # revision is read at the path IT had:
    #   (a) any path whose basename is this manifest's, anywhere in the tree;
    #   (b) `git log --follow` on this manifest's own path, which crosses a
    #       rename when git scores one -- and a forged manifest is ~99% similar
    #       to the one it replaces, which is exactly when --follow does see it.
    # Neither question alone is sufficient and neither is trusted alone: (a)
    # misses a basename change, (b) misses a move git does not score. The union
    # is what the witness is read from, and the printed line says how many
    # revisions were read.
    _revmap = {}
    for _r in _revs.stdout.split():
        _revmap.setdefault(_r, set())
    _top = _g('rev-parse', '--show-toplevel').stdout.strip()
    _rel = None
    if _top:
        try:
            _rel = os.path.relpath(os.path.abspath(a.manifest), _top)
        except ValueError:
            _rel = None
    if _rel and not _rel.startswith('..'):
        # `-C` is the manifest's own directory, so a bare relative path is
        # resolved against THAT and silently matches nothing; `:(top)` anchors
        # it at the repository root. Measured: without this the union never
        # fired and the rename-and-move world still answered 0.
        _fl = _g('log', '--follow', '--format=C %H', '--name-only', '--', ':(top)%s' % _rel)
        if _fl.returncode == 0:
            _cur = None
            for ln in _fl.stdout.split('\n'):
                ln = ln.rstrip()
                if ln.startswith('C ') and len(ln) > 2:
                    _cur = ln[2:].strip()
                    _revmap.setdefault(_cur, set())
                elif ln and _cur:
                    _revmap[_cur].add(ln)
    # CHALLENGE R15-P0-01 and the coordinator's ruling: legs (a) and (b) are
    # kept, neither is trusted alone, and NEITHER IS THE ANCHOR ANY MORE. The
    # anchor is the MARKER, asked of git three ways:
    #   (c) every HEAD-reachable revision whose diff adds or removes a marker
    #       line -- which is every revision that created, deleted, moved or
    #       renamed the manifest, whatever its name and wherever it went;
    #   (d) for each revision found, `git grep` says WHICH file in that
    #       revision's tree carries the marker, so the path is read from the
    #       tree instead of guessed from a name or a similarity score;
    #   (e) every path so discovered seeds `rev-list HEAD -- <that path>`, and
    #       (d) runs again on whatever that adds, until no new path appears.
    # (e) is what makes the set COMPLETE across a chain of moves: a commit that
    # moves the file CHANGES both the old and the new path, so it is listed by
    # the `rev-list` of the old path, and its own grep then yields the new path.
    # A revision carrying the marker in MORE THAN ONE file is a refusal by name
    # (this tool will not choose between two candidate manifests), which is also
    # what closes the decoy the challenger warned of: an amendment that quotes
    # the marker does not become an older "manifest", it stops the gate.
    _ambiguous, _quotefail = None, None
    def _carriers(rev):
        '''Paths in `rev` whose content carries MARKER. None = unreadable tree.'''
        # The marker must match a WHOLE LINE. Measured: `-F` matches a
        # SUBSTRING, so every document that mentions the manifest's heading --
        # this tool's own source among them -- counted as a carrier and the
        # AMBIGUOUS refusal fired on an honest world. `git grep` has no `-x`
        # ("unknown switch", measured), so the pattern is anchored explicitly
        # and the same whole-line test is applied to the subject above.
        r = _g('grep', '-l', '--full-name', '-E', MARKER_ERE, rev, '--', ':(top)')
        if r.returncode == 1:
            return []                      # git's own "no file matches"
        if r.returncode != 0:
            return None
        out = []
        for ln in r.stdout.split('\n'):
            ln = ln.strip()
            if not ln:
                continue
            pre, _, path = ln.partition(':')
            if pre != rev or not path:
                return None                # not the shape this parse assumes
            out.append(path)
        return out
    # `--no-renames` is load-bearing and measured: WITH rename detection git
    # presents a move as a rename whose unchanged lines are not in the patch, so
    # `-G` on the marker missed the very commit that moved the file (1 revision
    # of 3 in the G2 world); with it the move appears as a delete plus an add,
    # the marker lines are in the patch, and both the add and the move are
    # found. Depending on rename detection here would be the same lottery this
    # leg exists to replace.
    _gm = _g('log', '--format=%H', '--no-renames', '-G', MARKER_ERE, 'HEAD', '--', ':(top)')
    if _gm.returncode == 0:
        for _r in _gm.stdout.split():
            _revmap.setdefault(_r, set())
    _marker_revs = set(_gm.stdout.split()) if _gm.returncode == 0 else set()
    _seen_paths, _todo = set(), list(_revmap)
    while _todo:
        _rev = _todo.pop()
        _cs = _carriers(_rev)
        if _cs is None:
            continue                       # the walk below reports an unreadable tree
        if len(_cs) > 1 and _ambiguous is None:
            _ambiguous = (_rev, sorted(_cs))
        for _c in _cs:
            _revmap[_rev].add(_c)
            if _quoted(_c) and _quotefail is None:
                _quotefail = (_rev, _c)
            if _c in _seen_paths:
                continue
            _seen_paths.add(_c)
            _rl = _g('rev-list', 'HEAD', '--', ':(top)%s' % _c)
            if _rl.returncode != 0:
                continue
            for _r2 in _rl.stdout.split():
                # CHALLENGE R17-P1-01: this loop is the PATH leg, and it used to
                # add every revision it discovered to _marker_revs, the set the
                # summary reports as "found by the marker it carries". So the
                # count could never be low: the real pack printed "24 of them
                # found by the marker" where `git log --no-renames -G` finds 1,
                # and a world whose marker leg found NOTHING printed its own
                # revision count back — the exact blindness the sentence was
                # added to remove. _marker_revs is now written ONCE, from the
                # marker leg's own output, and nothing else may add to it.
                if _r2 not in _revmap:
                    _revmap.setdefault(_r2, set())
                    _todo.append(_r2)
                _revmap[_r2].add(_c)
    if len(_revmap) > len(_revs.stdout.split()):
        # Order them the way git does, oldest last, then walk reversed.
        _all = _g('rev-list', 'HEAD')
        _ordered = [r for r in _all.stdout.split() if r in _revmap]
        if len(_ordered) == len(_revmap):
            _revs = type(_revs)(args=_revs.args, returncode=0,
                                stdout='\n'.join(_ordered) + '\n', stderr='')
    # R-08, measured rather than asserted: "every revision" is a claim about
    # REACHABILITY, and this container's own clone is shallow. The flag is not
    # the question -- a truncated history is harmless for a file whose FIRST
    # record is still present, and fatal for one whose is not, because then the
    # oldest digest visible here is simply the oldest SURVIVING one and may
    # already be a forgery. So the test is whether the oldest listed revision
    # is the one that ADDED the manifest: every parent of it must be readable
    # and must not contain the file. Anything else is NOT CHECKED, and NOT
    # CHECKED discards the history witness entirely.
    _incomplete = None
    if _revs.returncode == 0 and _revs.stdout.strip():
        _oldest = _revs.stdout.split()[-1]
        # COORD-DIFF-REVIEW 03b3a0b, R-4: these two return codes were unread.
        # A failed `^@` printed nothing and read as "a root commit", and a
        # failed `--is-shallow-repository` read as "not shallow" -- both the
        # permissive value. A question git refused to answer is unknown.
        _par = _g('rev-parse', '%s^@' % _oldest)
        _sh = _g('rev-parse', '--is-shallow-repository')
        if _par.returncode != 0 or _sh.returncode != 0:
            _incomplete = ('git could not say %s for revision %s, so whether an earlier record'
                           ' of this manifest exists cannot be decided here'
                           % ('what its parents are' if _par.returncode != 0
                              else 'whether this clone is shallow', _oldest[:12]))
        _shallow = (_sh.stdout.strip() == 'true')
        # A grafted commit reports NO PARENTS, exactly like a true root commit,
        # so "the parents are readable" cannot see a `--depth 1` clone at all:
        # measured, that clone answered "checked over every revision" over a
        # single truncated revision. The graft list is where the truth is.
        _bounds = set()
        if _shallow:
            # FOUND BY EXECUTION in the sweep's pack-under-/tmp lane: a LINKED
            # WORKTREE's own git dir is .git/worktrees/<name>, which holds no
            # `shallow` file -- that file belongs to the COMMON git dir and is
            # shared by every worktree. Reading the per-worktree dir therefore
            # raised OSError, every revision became a boundary, and the gate
            # answered 1 in the worktree and 0 in the main checkout on the same
            # commit: a verdict that depended on where the pack lived. Ask for
            # the common dir, which is the same path in both.
            _gd = _g('rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip()
            if not _gd:
                _gd = _g('rev-parse', '--absolute-git-dir').stdout.strip()
            # R-4 again: an EMPTY answer here used to make os.path.join produce
            # the bare name "shallow", read relative to this process's cwd --
            # a file in some unrelated directory deciding a boundary. If git
            # will not name its own directory, the boundary is unreadable.
            if not _gd:
                _bounds = {'<unreadable>'}
            else:
                try:
                    _bounds = set(open(os.path.join(_gd, 'shallow')).read().split())
                except OSError:
                    _bounds = {'<unreadable>'}
        if _oldest in _bounds or '<unreadable>' in _bounds:
            _incomplete = ('revision %s is the shallow boundary of this clone, so the history'
                           ' below it was never fetched and the oldest digest here need not be'
                           ' the first' % _oldest[:12])
        for _p in (_par.stdout.split() if _par.returncode == 0 else []):
            if _g('rev-parse', '--verify', '--quiet', '%s^{commit}' % _p).returncode != 0:
                _incomplete = ('revision %s is a boundary commit%s, so an earlier record of this'
                               ' manifest may exist and cannot be read'
                               % (_oldest[:12], ' of a shallow clone' if _shallow else ''))
            elif _paths_at(_p) is None or _carriers(_p) is None:
                # FOUND BY MY OWN READING WHILE HOLDING AT 7f6f535, before the
                # challenger's round 16 asked for it: both of these helpers
                # return None for "the tree could not be read" and [] for "the
                # manifest is not in it", and `_paths_at(_p) or (_carriers(_p)
                # or [])` collapsed BOTH to falsy -- so a parent whose commit
                # object exists but whose TREE or blobs are unreadable (a
                # treeless or blobless clone whose promisor is unreachable, a
                # pruned or corrupt object) was read as "the parent does not
                # contain the manifest", which is the permissive value and makes
                # the oldest discovered revision look like the commit that ADDED
                # it. That is the species this pack has now fixed six times: an
                # exception or an unknown must never resolve to the permissive
                # value. Unknown is NOT CHECKED.
                _incomplete = ('the tree of %s, the parent of the oldest revision of this manifest'
                               ' reachable here (%s), could not be read, so whether an earlier'
                               ' record of this manifest exists there is unknown'
                               % (_p[:12], _oldest[:12]))
            elif _paths_at(_p) or _carriers(_p):
                # CHALLENGE R15-P0-01: this test asked only the BASENAME, so a
                # parent that carried the manifest under its OLD name looked
                # empty and the forging revision passed as "the commit that
                # added it". The marker answers it whatever the file is called,
                # and this is the backstop that holds even when every discovery
                # leg finds nothing but the forging revision itself.
                _incomplete = ('the oldest revision of this manifest reachable here (%s) is a'
                               ' modification, not the commit that added it, so the digest a'
                               ' report was received with may be out of reach' % _oldest[:12])
    if _revs.returncode != 0 or not _revs.stdout.strip():
        # COORD-DIFF-REVIEW 03b3a0b, R-2: one sentence covered two different
        # facts -- there is no repository here, and there IS one but it could
        # not answer (a treeless clone, an unfetchable tree, a refused command).
        # The refusal is written from what was actually read.
        _inrepo = _g('rev-parse', '--is-inside-work-tree')
        if _inrepo.returncode != 0 or _inrepo.stdout.strip() != 'true':
            history = 'NOT CHECKED (the manifest is not in a git repository here)'
        elif _revs.returncode != 0:
            history = ('NOT CHECKED (this is a git repository, but it could not list the'
                       ' revisions of this manifest: %s)'
                       % ((_revs.stderr.strip().split('\n') or [''])[0][:120] or 'no reason given'))
        else:
            history = ('NOT CHECKED (this is a git repository and no revision of a file named'
                       ' %s is reachable from HEAD, so nothing here records what was received)'
                       % _mb)
    elif _incomplete:
        history = 'NOT CHECKED (%s)' % _incomplete
    else:
        # COORDINATOR RE-REVIEW AT a725342, P2-01-bis, which BLOCKED: this loop
        # treated ANY unreadable revision as a truncation, discarded the whole
        # history witness and the `moved` refusal with it -- and a DELETION
        # revision is unreadable that way. So two ordinary commits (`git rm` the
        # manifest, then re-add it carrying a forged row) emptied the witness in
        # a FULL history, and with the counterpart edited in step the forgery
        # passed at 0. No history was rewritten, which is exactly what the pack
        # said was required. A deletion is not a truncation: the revisions
        # BEFORE it are readable and so is the digest the report was received
        # with, so an absent path is SKIPPED and RECORDED, never discarded.
        # Only a missing object -- a graft boundary, a corrupt or unfetched
        # commit -- is NOT CHECKED.
        gaps = []
        for rev in reversed(_revs.stdout.split()):           # OLDEST first
            if _g('rev-parse', '--verify', '--quiet', '%s^{commit}' % rev).returncode != 0:
                signed_history, moved = {}, {}
                history = ('NOT CHECKED (the commit object %s is not in this repository, so the'
                           ' records at and below it cannot be read)' % rev[:12])
                break
            # CHALLENGE R12-P1-01, which BLOCKED: `git cat-file -e <rev>:<path>`
            # fails BOTH when the path is not in that tree and when the path IS
            # there with its BLOB unavailable (a blobless clone whose promisor
            # is unreachable, a pruned or corrupt object), and reading the second
            # as "a deletion" skipped the revision and still printed "checked ...
            # ABSENT in 1 of them". The TREE answers the first question without
            # needing any blob. (`git rev-parse <rev>:<path>` does NOT
            # discriminate -- it exits 0 and echoes the string for a deleted
            # path.)
            _pl = _paths_at(rev)
            if _pl is not None:
                _have = {pth for _m, pth in _pl}
                for _extra in sorted(_revmap.get(rev, set()) - _have):
                    _ex = _g('ls-tree', '--full-tree', '--format=%(objectmode) %(path)',
                             rev, '--', _extra)
                    if _ex.returncode != 0:
                        _pl = None
                        break
                    for _ln in _ex.stdout.split('\n'):
                        _ln = _ln.strip()
                        if not _ln:
                            continue
                        _m2, _, _p2 = _ln.partition(' ')
                        _pl.append((_m2, _p2))
            if _pl is None:
                signed_history, moved = {}, {}
                history = ('NOT CHECKED (the tree of revision %s could not be read, so'
                           ' whether this manifest existed in it is unknown)' % rev[:12])
                break
            if not _pl:
                gaps.append(rev)      # the manifest does not exist in this revision
                continue
            # CHALLENGE R13-P2-01: the walk assumed a REGULAR FILE. Committed as
            # a SYMLINK (mode 120000) every revision reads as the link TEXT, no
            # row parses, the witness stays empty -- and the line still said
            # "checked over every revision". The mode is read for every revision
            # and a non-blob is NOT CHECKED.
            _bad = [(m, pth) for m, pth in _pl if m not in ('100644', '100755')]
            if _bad:
                signed_history, moved = {}, {}
                history = ('NOT CHECKED (revision %s records this manifest at %s with mode %s,'
                           ' not a regular file, so what it holds is not the manifest\'s rows'
                           ' and no digest in it can be read)'
                           % (rev[:12], _bad[0][1], _bad[0][0]))
                break
            _texts, _unreadable = [], None
            for _m, _pth in _pl:
                r = _g('show', '%s:%s' % (rev, _pth))
                if r.returncode != 0:
                    _unreadable = _pth
                    break
                _texts.append(r.stdout)
            if _unreadable is not None:
                signed_history, moved = {}, {}
                history = ('NOT CHECKED (revision %s lists this manifest at %s but its content'
                           ' could not be read — the object is missing, pruned, or in an'
                           ' unreachable promisor — so the record it carries cannot be'
                           ' compared)' % (rev[:12], _unreadable))
                break
            for _txt in _texts:
                for ln in _txt.split('\n'):
                    m = ROW.match(ln)
                    if not m or m.group(3) == PLACEHOLDER: continue
                    nm, dg = m.group(1), m.group(3)
                    if nm not in signed_history:
                        signed_history[nm] = dg
                    elif dg != signed_history[nm] and nm not in moved:
                        moved[nm] = (signed_history[nm], dg, rev)
        _nrevs = len(_revs.stdout.split())
        if history.startswith('checked'):
            # CHALLENGE R16-P0-01: this sentence asserted that the marker had
            # found the revisions, and printed the same words when the marker
            # legs had found NOTHING AT ALL. It now reports the count those legs
            # contributed, so a reader can see an inert anchor in the output.
            history = ('checked over all %d revision(s) of this manifest reachable from HEAD,'
                       ' OLDEST first — %d of them found by the marker it carries, the rest by'
                       ' a path it has held' % (_nrevs, len(_marker_revs & set(_revmap))))
        if gaps and history.startswith('checked'):
            # CHALLENGE R15-P3-01: this sentence used to say "removed and
            # re-added", which is a CAUSE, and the measurement under it is only
            # that git reported no such path in those trees — the eighth
            # instance of a refusal naming a cause that is not the cause. It
            # was reached in the challenger's world `M` by a LOOKUP FAILURE on a
            # quoted path, where nothing had been removed at all. The quoting is
            # fixed above; the sentence now claims only what was read.
            history += (', and git reports no file carrying this manifest in %d of them (%s),'
                        ' which is what a revision before it was added, or between a removal and'
                        ' a re-add, looks like from here; the records in the revisions that DO'
                        ' carry it were read, and a gap does not erase them'
                        % (len(gaps), ', '.join(g[:12] for g in gaps[:4])))
    listed, out, stale, refused = [], [], [], []
    for ln in lines:
        m = ROW.match(ln)
        if not m:
            out.append(ln); continue
        name, desc, dig, size = m.groups()
        listed.append(name)
        # ---- a DECLARED SUBTREE (R26-P1-01). One row pins a whole directory.
        if name.endswith('/'):
            sd = os.path.join(a.dir, name.rstrip('/'))
            if not os.path.isdir(sd):
                stale.append('%s: ROW WITH NO DIRECTORY in %s' % (name, a.dir))
                out.append(ln); continue
            sh, sbytes, sfiles, _sexc, _sref = _D['subtree_digest'](sd, _git_is_repo)
            for _r in _sref:
                stale.append('%s: %s' % (name, _r))
            sdrift = (sh != dig or ('%d' % sbytes) != size.replace(',',''))
            if dig == PLACEHOLDER or size == PLACEHOLDER:
                sdrift = True
            if sdrift:
                stale.append('%s: row says %s over %s bytes, the directory holds %d file(s) at'
                             ' any depth hashing %s over %d bytes. A declared subtree is pinned'
                             ' by the name, size and SHA-256 of every file beneath it, so an'
                             ' added, removed, renamed or edited file moves this digest.'
                             % (name, dig[:12], size, sfiles, sh[:12], sbytes))
            out.append('| `%s` | %s | `%s` | %s |' % (name, desc, sh, format(sbytes,',')))
            continue
        p = os.path.join(a.dir, name)
        if not os.path.exists(p):
            stale.append('%s: ROW WITH NO FILE in %s' % (name, a.dir))
            out.append(ln); continue
        b = open(p,'rb').read()
        h = hashlib.sha256(b).hexdigest()
        drifted = h != dig or ('%d' % len(b)) != size.replace(',','')
        if dig == PLACEHOLDER or size == PLACEHOLDER:
            drifted = True
        if drifted:
            stale.append('%s: row says %s/%s bytes, file is %s/%d bytes'
                         % (name, dig[:12], size, h[:12], len(b)))
        # ROUND-8 CHALLENGE, pair-drop 4, and its own suggestion: --write
        # already refuses to ADD a row for a challenge report, but it would
        # happily RE-SIGN one whose file had been edited -- so tampering with a
        # reviewer's report and re-running --write turned both prose gates
        # green. (What caught it was that --manifest is pinned to the pack while
        # --dir is not, so the shared folder contradicted the re-signed row.
        # That construction is real protection, but it is a second witness, not
        # a refusal.) A reviewer's digest is never rewritten here: it is
        # evidence, and a digest that no longer matches means the FILE changed.
        # A row is unsigned only when it has NEITHER a digest NOR a byte count:
        # the first signing of a newly added reviewer's row is not a re-signing,
        # but a row whose digest was corrupted to a placeholder-looking value
        # still carries its original byte count, and that mismatch is the tell
        # (R9-P2-02 measured it: `000000000000/17,898 bytes` beside a 17,962-byte
        # file).
        # ROUND-9, and the coordinator's wording, which is the stronger rule:
        # ANY transition of an already-signed reviewer row is a refusal, in
        # either direction -- including back to the unsigned placeholder, which
        # is how the one-step bypass worked. `--write` leaves such a row exactly
        # as it found it and fails.
        # ---- a reviewer's report, and the three witnesses it is held to.
        if name.startswith(REVIEWER_PREFIXES):
            wdir = a.witness or witness_default()
            wpath = os.path.join(wdir, name)
            wh = (hashlib.sha256(open(wpath,'rb').read()).hexdigest()
                  if os.path.isfile(wpath) else None)
            sig = signed_history.get(name)
            mv = moved.get(name)
            why = None
            if wh and wh != h:
                why = ('REVIEWER COPIES DIFFER: %s hashes %s under %s but %s under %s. Two'
                       ' directories disagree about a reviewer\'s report, so neither can be'
                       ' signed from here. Restore the copy that was changed.'
                       % (name, h[:12], a.dir, wh[:12], wdir))
            elif mv:
                why = ('REVIEWER ROW REWRITTEN IN HISTORY: %s was recorded as %s when it was'
                       ' received, and a later revision of this manifest (%s) records %s for it'
                       ' instead. A signed reviewer row does not move, and a later commit does not'
                       ' get to redefine what was received. **This refusal cannot be cleared'
                       ' from here**, and that is deliberate: restoring the row and the file'
                       ' leaves the forging revision in the history, which is the record. What'
                       ' can be done is to say so in the handoff and have the reviewer re-send'
                       ' the report.'
                       % (name, mv[0][:12], mv[2][:12], mv[1][:12]))
            elif sig and h != sig:
                why = ('%s: a signed reviewer row does not move. The OLDEST revision of this'
                       ' manifest that records it recorded %s, and the file under %s now hashes %s — neither a'
                       ' committed placeholder nor a committed forgery erases the digest the report'
                       ' was received with. Restore the reviewer\'s file.'
                       % (name, sig[:12], a.dir, h[:12]))
            elif wh is None and sig is None:
                # CHALLENGE R11-P2-02, the SIXTH instance of one class: this said "no digest in
                # any revision of this manifest" in a clone that cannot SEE the revisions --
                # seventeen of them record that report, oldest e89fcb1c90ea. The verdict was
                # right and the sentence sent the reader to re-sign a report signed long ago.
                # The rule the reviewer draws, and it is the right one: a refusal is written
                # from the variable it actually read. `history` is in hand, so it is used.
                why = ('NO WITNESS for %s: %s, and there is no counterpart under %s, so nothing'
                       ' here can confirm what was received. %s'
                       % (name,
                          ('no digest for it is visible in the revisions this clone has'
                           if history.startswith('NOT CHECKED')
                           else 'it has no digest in any revision of this manifest'),
                          wdir,
                          ('Fetch the full history (`fetch-depth: 0`) and re-run, or place the'
                           ' reviewer\'s report in both directories.'
                           if history.startswith('NOT CHECKED')
                           else 'Place the reviewer\'s report in both directories before signing'
                                ' its row.')))
            if why:
                stale.append(why); refused.append(name); out.append(ln); continue
            # Only a row that is unsigned in BOTH cells may be signed, and only
            # with a witness agreeing (checked above). A drifted signed row is
            # never rewritten: a digest that no longer matches means the FILE
            # changed (ROUND-8, pair-drop 4).
            unsigned = (dig == PLACEHOLDER and size == PLACEHOLDER)
            if a.write and drifted and not unsigned:
                stale.append('%s: REFUSING to re-sign a challenge report\'s row — the file under'
                             ' %s no longer matches the digest it was received with. Restore the'
                             ' reviewer\'s file; do not update the row.' % (name, a.dir))
                refused.append(name); out.append(ln); continue
        out.append('| `%s` | %s | `%s` | %s |' % (name, desc, h, format(len(b),',')))

    # CHALLENGE R26-P1-01: a WALK, no extension filter, no case folding, and
    # every first-level directory required to be declared. The manifest's own
    # file is the one exclusion, because a file cannot carry its own digest.
    _mb = os.path.basename(a.manifest)
    on_disk, sub, _excluded, _dref = _D['enumerate_pack'](a.dir, _mb, _git_is_repo)
    for _r in _dref:
        stale.append(_r)
    subtotal = sum(len(v) for v in sub.values())
    unlisted = [f for f in on_disk if f not in listed]
    missing  = [n for n in listed
                if not os.path.exists(os.path.join(a.dir, n.rstrip('/')))]

    for u in unlisted: stale.append('%s: ARTIFACT WITH NO ROW' % u)
    for d in sorted(d for d in sub if d not in listed):
        # CHALLENGE R27-P1-01, found while arming the plants for its own remedy:
        # this refusal carried round 26's domain sentence -- "excluding only this
        # manifest and any directory that IS a git repository" -- after the test
        # had become git's own verdict and after the manifest's self-exclusion
        # had been separated from the shared domain. A reader sent to the
        # refusal would have gone looking for a HEAD/objects/refs test that no
        # longer exists. The sentence is now the shared DOMAIN itself, so it
        # cannot describe a discipline this tool does not run, and the files are
        # NAMED rather than only counted.
        _names = sorted(sub[d])
        stale.append('SUBTREE WITH NO ROW: %s holds %d file(s) that no row of this manifest'
                     ' pins (%s%s). The domain this manifest enforces under %s is %s, minus'
                     ' this manifest itself; a directory is pinned by one row named `%s` whose'
                     ' digest covers the name, size and SHA-256 of every file beneath it.'
                     % (d, len(_names), ', '.join(_names[:5]),
                        (', and %d more' % (len(_names) - 5)) if len(_names) > 5 else '',
                        a.dir, _D['DOMAIN'], d))
    # It fires only when there IS a reviewer row to protect, so it cannot red a
    # manifest that has none.
    # CHALLENGE R12-P2-01, a FAIL-OPEN: this refusal fired only when a reviewer
    # row SURVIVED in the manifest, and the other protection (SIGNED ROW
    # REMOVED) reads `signed_history`, which NOT CHECKED empties -- so one
    # condition disabled both, and "this manifest never had a reviewer row" was
    # indistinguishable from "every one of them was just deleted". Measured in a
    # depth-1 clone with all 18 reviewer rows and their files removed: rc 0,
    # "every artifact row matches". The counterpart directory is evidence the
    # manifest cannot erase, so it is asked: reports there with no rows here,
    # under an unverifiable history, is the shape of the attack.
    blocked = False
    # CHALLENGE R15-P0-01 / R15-P0-02, the three refusals the new anchor owes,
    # each by name and each fail-closed:
    #  * the subject must carry the marker EXACTLY ONCE. An attacker who strips
    #    it cannot be found by grep in any revision, so the tool must stop
    #    before it reads a history it cannot anchor -- not answer 0.
    #  * a revision carrying the marker in more than one file is ambiguous and
    #    stops the gate; this tool does not choose between two candidate
    #    manifests, and it is the quoting-amendment decoy's refusal too.
    #  * a path git hands back quoted, or with a backslash this tool cannot
    #    round-trip, is a refusal and never a skip -- it was read as "absent
    #    from that tree" and counted two true records as gaps.
    _subject_marks = sum(1 for ln in lines if MARKER_PY.match(ln))
    if _subject_marks != 1:
        blocked = True
        history = ('NOT ANCHORED (the file given as the manifest carries the manifest marker %d'
                   ' time(s), not once)' % _subject_marks)
        stale.append('%s: %s. The marker is how every revision of this manifest is found'
                     ' whatever path or name it has held, so without exactly one of it in the'
                     ' subject there is no anchor to read a history against, and this tool'
                     ' reports no verdict about the reviewer rows.' % (history, MARKER))
    # CHALLENGE R16-P0-01, the second half of the remedy, and the coordinator's
    # "zero revisions found must be a named refusal": matching the three places
    # alike is not enough on its own, because the next spelling nobody thought
    # of makes the anchor inert again. So the anchor is ASSERTED: the subject
    # carries the marker, and if HEAD is in a readable repository and NO file in
    # it carries that marker, the tool refuses by name instead of walking a
    # revision set the marker had no part in choosing.
    _head_carriers = _carriers('HEAD')
    if (_subject_marks == 1 and _head_carriers is not None and not _head_carriers
            and not blocked):
        blocked = True
        history = ('NOT ANCHORED (the file given as the manifest carries the marker, but no file'
                   ' in HEAD does, so the marker found nothing to walk)')
        stale.append('%s. Either this manifest is not the one this repository tracks, or its'
                     ' marker line differs from the committed one by bytes this tool normalises'
                     ' away in the file and git does not in the tree — a trailing space, a tab or'
                     ' a CR. Until the committed marker and this one agree, the history witness'
                     ' is chosen by path alone, which is what a move plus a rename defeats, so'
                     ' nothing here is reported as checked.' % history)
    if _quotefail is not None:
        blocked = True
        history = ('NOT CHECKED (git reported the manifest at revision %s under a path this tool'
                   ' cannot use verbatim: %s)' % (_quotefail[0][:12], _quotefail[1]))
        stale.append('%s. Paths are read with `core.quotePath=false`, so a quoted or escaped path'
                     ' here means the name holds something this parse does not round-trip. It is'
                     ' refused rather than skipped, because a skipped revision is a record that'
                     ' was never compared.' % history)
    # CHALLENGE R18, the challenger's own answer to a question I put to them:
    # the two count proofs pin the FIGURE, not its provenance — a copy whose
    # count ignores the walk and re-runs the marker leg's command is
    # byte-identical on the real pack and in both proof worlds, so both proofs
    # pass for it. That is harmless only while the invariant holds that every
    # revision the marker leg found was seeded into the walked set, which makes
    # `len(_marker_revs & set(_revmap))` identically `len(_marker_revs)`. An
    # invariant a figure's honesty rests on is checked here by name, so a later
    # change that recomputes the count independently is refused instead of
    # sailing past two tautological proofs.
    if not _marker_revs <= set(_revmap):
        blocked = True
        _lost = sorted(_marker_revs - set(_revmap))
        history = ('NOT CHECKED (%d revision(s) the marker leg found are absent from the walked'
                   ' set, the first being %s, so the count reported beside it would describe'
                   ' neither set)' % (len(_lost), _lost[0][:12]))
        stale.append('%s. The summary says how many of the WALKED revisions the marker leg found.'
                     ' That sentence is only true while every marker-found revision is one of the'
                     ' walked ones; if it is not, the number is an intersection of two sets that'
                     ' no longer stand in that relation, and it is refused rather than printed.'
                     % history)
    if _ambiguous is not None:
        blocked = True
        history = ('AMBIGUOUS (revision %s carries the manifest marker in %d files: %s)'
                   % (_ambiguous[0][:12], len(_ambiguous[1]), ', '.join(_ambiguous[1][:4])))
        stale.append('%s. The marker identifies the manifest in history; two files carrying it in'
                     ' one revision means this tool cannot say which of them the records belong'
                     ' to, and it will not pick. Keep the marker in the manifest alone — a'
                     ' document that needs to quote it must not reproduce it as a whole line.'
                     % history)
    # CHALLENGE R13-P2-01's wider half: a walk that read EVERY revision and
    # parsed ZERO rows printed the same words as a walk that verified nineteen.
    # "checked" is a claim about what was found, not only about what was read,
    # so when reviewer rows exist here and no revision of this manifest recorded
    # a digest for any of them, the history is NO RECORD IN ANY REVISION and it
    # refuses -- the honest sentence for an empty-but-complete history too.
    # (Measured while fencing this: `signed_history` carries EVERY row a revision
    # recorded, amendments included, so "it is empty" is not the question. The
    # question is whether any revision recorded a digest for a REVIEWER report,
    # which is what this refusal is about.)
    if (history.startswith('checked')
            and not any(n.startswith(REVIEWER_PREFIXES) for n in signed_history)
            and any(n.startswith(REVIEWER_PREFIXES) for n in listed)):
        history = ('NO RECORD IN ANY REVISION (%d revision(s) of this manifest were read and not'
                   ' one of them carries a digest for any reviewer report, so the history'
                   ' confirms nothing about what was received)'
                   % len(_revs.stdout.split()))
        blocked = True
        stale.append('%s. This manifest lists reviewer report(s), and a history that was read'
                     ' in full and holds no record is not a history that'
                     ' agrees — the only witness left is the copy in the other directory, which'
                     ' the same hand writes. This refusal cannot be cleared from here: it is'
                     ' cleared by a revision that records the rows as received.' % history)
    _wdir = a.witness or witness_default()
    # COORDINATOR DIFF REVIEW AT 03b3a0b, B3, which BLOCKED: `os.listdir` raising
    # was mapped to `[]`, so "the counterpart could not be read" became "the
    # counterpart holds no reports" and the tool printed success. Measured: a
    # depth-1 clone with all reviewer rows and files removed answered 0 whenever
    # the counterpart was ABSENT, a regular file, or an empty directory -- and
    # absent is the CI shape (no shared folder, `actions/checkout` at depth 1).
    # An exception must not resolve to the permissive value: under an
    # unverifiable history a counterpart that cannot be read is NO witness, not
    # an empty one.
    _wfail = None
    try:
        _wreports = sorted(f for f in os.listdir(_wdir) if f.startswith(REVIEWER_PREFIXES))
    except OSError as e:
        _wreports, _wfail = [], '%s (%s)' % (_wdir, e.__class__.__name__)
    _wmissing = [f for f in _wreports if f not in listed]
    # B3 again, one shape further: an EMPTY counterpart directory still answered
    # 0 when every reviewer row had also been deleted, because then nothing was
    # left to name -- and "this manifest never had a review" is exactly what a
    # deletion of every review looks like. The one thing that could tell them
    # apart is the history, and the history is NOT CHECKED. So an unverifiable
    # history certifies nothing at all: it refuses, and the sentence says which
    # of the four states it is in. `--allow-unverified-history` remains the way
    # to accept the limit deliberately, and it still prints it.
    if history.startswith('NOT CHECKED') and not a.allow_unverified_history:
        blocked = True
        stale.append('HISTORY NOT VERIFIED: the reviewer-row history is %s, and %s. The only'
                     ' witness left for a reviewer row is then the copy in the other directory,'
                     ' which the same hand writes, so nothing here can confirm what was'
                     ' received. Fetch the full history (`fetch-depth: 0`) and re-run, or pass'
                     ' --allow-unverified-history to accept that limit deliberately.'
                     % (history,
                        ('%d reviewer report(s) under %s have NO ROW here (%s) — a manifest'
                         ' cannot erase the other directory'
                         % (len(_wmissing), _wdir, ', '.join(_wmissing[:3]))) if _wmissing
                        else ('no counterpart could be read at %s, so there is no second'
                              ' witness either — and a manifest that lists no reviewer row'
                              ' under an unreadable history is indistinguishable from one'
                              ' whose rows were just deleted' % _wfail) if _wfail
                        else ('this manifest lists reviewer report(s) and the other directory'
                              ' holds none, so nothing here can confirm what was received')
                        if any(n.startswith(REVIEWER_PREFIXES) for n in listed)
                        else ('neither this manifest nor %s holds a reviewer report, and an'
                              ' unreadable history cannot tell "never had one" from "every one'
                              ' was just deleted"' % _wdir)))
    # COORD DIFF REVIEW AT c812aa5, R-02: a whole reviewer report could be
    # deleted together with its row and this lane stayed green -- what caught it
    # was the other directory, which is a second witness and not a refusal. A
    # name that any revision of this manifest signed must keep its row here.
    # COORDINATOR RE-REVIEW AT a725342, two P3s on this one refusal: it called
    # every removed row a REVIEWER row -- an amendment's deleted row was
    # answered with "a received review is not deleted", a cause that is
    # measurably not the cause (the class again) -- and `--write` printed it and
    # still exited 0, so a gate reading the code alone saw a pass.
    for nm in sorted(signed_history):
        if nm not in listed:
            if nm.startswith(REVIEWER_PREFIXES):
                stale.append('%s: SIGNED REVIEWER ROW REMOVED — this manifest signed it in an'
                             ' earlier revision (%s) and it has no row now. A received review is'
                             ' not deleted; restore the row and the file.'
                             % (nm, signed_history[nm][:12]))
            else:
                stale.append('%s: SIGNED ROW REMOVED — this manifest signed it in an earlier'
                             ' revision (%s) and it has no row now. This is not a reviewer\'s'
                             ' report: a pack document may legitimately be withdrawn, but not'
                             ' silently, so restore the row or record the withdrawal.'
                             % (nm, signed_history[nm][:12]))
            refused.append(nm)
    # CHALLENGE R21-P3-01: the verdict carried NO provenance -- which is exactly
    # what made R20-P0-01 invisible, since "27 revisions" and "26 revisions"
    # were the same exit code and the same sentence one number apart, with
    # nothing saying which repository had been read. The repository walked, its
    # git directory and the git binary are now part of the output, so the
    # questions those rounds turned on are answered in the verdict instead of
    # in the environment.
    _ptop = _g('rev-parse','--show-toplevel')
    _pdir = _g('rev-parse','--absolute-git-dir')
    # ---- R26-P3-02: the pre-commit comparison, named refusals only.
    if a.reports_in_tree or a.reports_at_head:
        _rdir = a.witness or witness_default()
        _pfxr = _g('rev-parse','--show-prefix')
        _pfx = _pfxr.stdout.strip()
        _at_head_only = a.reports_at_head and not a.reports_in_tree
        _leg = 'HEAD itself' if _at_head_only else 'this commit (index or HEAD)'
        if not os.path.isdir(_rdir):
            stale.append('REPORTS DIRECTORY NOT READABLE: %s does not exist, so this run says'
                         ' NOTHING about whether a reviewer report is carried by %s.'
                         % (_rdir, _leg))
        elif _ptop.returncode != 0 or not _ptop.stdout.strip() or _pfxr.returncode != 0:
            # CHALLENGE R27-P3-05: with no repository to ask -- an archive
            # export, a `tar` of the pack, a copy taken outside any checkout --
            # both legs failed and the refusal read "this commit does not carry
            # it" while the SAME run printed "repository NONE". It BLAMED a
            # commit it had not been able to look at. There is no commit to
            # blame; the question could not be put, and this pack's rule is to
            # refuse what it cannot classify rather than to answer it.
            stale.append('NO REPOSITORY TO ASK: this pack was read at %s, where git reports no'
                         ' repository (`rev-parse --show-toplevel` rc %d, `--show-prefix` rc'
                         ' %d), so whether %s carries the reviewer report(s) in %s is a question'
                         ' that COULD NOT BE PUT and nothing here is a verdict about it. Run'
                         ' this lane in a checkout.'
                         % (a.dir, _ptop.returncode, _pfxr.returncode, _leg, _rdir))
        else:
            # CHALLENGE R27-P3-06: this enumerated with `os.listdir` and a
            # case-sensitive prefix test, which is R26-P1-01's own defect inside
            # the fix for R26-P3-02 -- `p14-challenge-zzzzzzz.md` and
            # `sub/P14-CHALLENGE-zzzzzzz.md` both answered rc 0. It is now the
            # shared walk: recursive, any case.
            _reports, _rexc, _rref = _D['reviewer_reports'](_rdir, REVIEWER_PREFIXES, _git_is_repo)
            for _r in _rref:
                stale.append('%s: %s' % (_rdir, _r))
            for _n in _reports:
                _why = []
                if _n not in listed:
                    _why.append('it has no row in this manifest')
                # A pathspec given to `ls-files` resolves against the CWD of the
                # git call, which is the manifest's directory here, while a
                # `HEAD:<path>` name resolves against the repository ROOT. The
                # first run of this check refused with the right-looking sentence
                # for the wrong cause -- it was looking for
                # phase-preparation/phase14/phase-preparation/phase14/<report> --
                # so the pathspec carries `:(top)` and the two legs agree on
                # which path they mean. This pack has the same lesson written
                # down for GIT_DIR; it cost a second reading here.
                _hd  = _g('cat-file','-e','HEAD:%s%s' % (_pfx,_n))
                if _at_head_only:
                    if _hd.returncode != 0:
                        _why.append('HEAD does not carry it (HEAD:%s%s does not resolve, and a'
                                    ' staged file does not count on this leg)' % (_pfx,_n))
                else:
                    _idx = _g('ls-files','--cached','--error-unmatch','--',
                              ':(top)%s%s' % (_pfx,_n))
                    if _idx.returncode != 0 and _hd.returncode != 0:
                        _why.append('this commit does not carry it (neither the index nor HEAD'
                                    ' has %s%s)' % (_pfx,_n))
                if _why:
                    stale.append('REVIEWER REPORT NOT CARRIED BY %s: %s is in %s and %s. A'
                                 ' reviewer\'s words are the record behind a signature, so a head'
                                 ' that does not carry them cannot be verified from the pack by'
                                 ' anyone reading it. Commit the file unedited with its row'
                                 ' BEFORE pushing; this refusal exists because that was missed'
                                 ' twice in consecutive rounds and both times a lane read after'
                                 ' the push is what found it.'
                                 % (_leg.upper(), _n, _rdir, ' and '.join(_why)))
    _pver = _g('--version')
    # CHALLENGE R22-P1-02, second half: this line REPORTS the object that ran --
    # _GIT_BIN, resolved once at import and passed absolute to every call --
    # instead of asserting a binary by a second lookup on the same string.
    print('read: repository %s; git directory %s; %s at %s'
          % ((_ptop.stdout.strip() or 'NONE (no repository was walked)'),
             (_pdir.stdout.strip() or 'NONE'),
             (_pver.stdout.strip() or 'git version UNKNOWN'), _GIT_BIN))
    print('manifest: %d artifact row(s) + the manifest itself; %d file(s) at the top level of'
          ' %s and %d file(s) under %d declared subtree(s); the domain enumerated is %s'
          ' (R26-P1-01, R27-P1-01), minus this manifest itself because a file cannot carry its'
          ' own digest — an exclusion that is THIS tool\'s and not the shared domain\'s — and'
          ' %d directory(ies) were excluded as repositories: %s; reviewer-row history %s'
          % (len(listed), len(on_disk), a.dir, subtotal,
             len([n for n in listed if n.endswith('/')]), _D['DOMAIN'],
             len(_excluded),
             (', '.join(os.path.relpath(x, a.dir) for x in sorted(_excluded))
              if _excluded else 'none'), history))
    if a.write:
        open(a.manifest,'w',encoding='utf-8').write('\n'.join(out))
        for s in stale: print('  updated/flagged: %s' % s)
        if unlisted: print('  NOT ADDED (a row is a description, not a digest — write it): %s' % ', '.join(unlisted))
        return 1 if (unlisted or missing or refused or blocked) else 0
    if a.check:
        for r in refused: print('  REFUSED: %s' % r, file=sys.stderr)
        for s in stale: print('  STALE: %s' % s, file=sys.stderr)
        if stale:
            print('HANDOFF MANIFEST IS STALE. Run: tools/manifest-digests.py --write', file=sys.stderr)
            return 1
        print('every artifact row matches the file on disk, and every file has a row.')
        return 0
    for s in stale: print('  %s' % s)
    return 0

if __name__ == '__main__':
    sys.exit(main())
