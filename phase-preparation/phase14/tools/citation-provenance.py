#!/usr/bin/env python3
"""Generate the live-code citation provenance table for P14 §15.

Round-4 CHALLENGE P2-01: §15's table was written from a hand-kept list of files
and said "six of fourteen". The list was assembled by memory -- the same
mechanism the base-tree trap is made of. A count that is typed is a claim; a
count that is generated is a measurement. So the table is produced by SCANNING
the pack for citations and resolving each against both trees. The generated
answer at the fix commit is 35 resolved: 5 DIFFER, 21 identical, 9 ABSENT at
`6fc505d` -- none of the three figures the hand-kept table or the challenger
inferred from it.

  usage: tools/citation-provenance.py [--pack DIR] [--repo DIR]
         [--base 93084f8] [--other 6fc505d]
         [--markdown | --write DOC | --check DOC]

--write replaces the block between the BEGIN/END markers in DOC with the
generated table; --check regenerates it and exits 1 when DOC's block is stale,
which is what `P14-GATE-032` runs so the table cannot drift from the trees it
describes. A table that cannot detect its own staleness is a claim again.
"""
import argparse, os, re, subprocess, sys, collections

# ROUND-6 CHALLENGE P2-01: this pattern carried SEVEN extensions and the
# sentence it fed said "35 cited files". `json` was not among them, so
# `infrastructure/database/MIGRATION_MANIFEST.json` -- cited three times, a real
# repo file, and the ONE cited file whose difference between the trees changes a
# RULE rather than a citation (it carries `frozenThrough`) -- appeared in zero
# rows. A generator whose scope is narrower than its sentence is the hand-kept
# list's defect in a new form: not a wrong count, a count of the wrong
# population. The extension set is named in the output now, so the claim cannot
# outrun the scan again.
# COORD-DIFF-REVIEW R1 P3-12: `.md` was outside the population too. The pack
# cites `docs/DAFTAR_DATA_MODEL.md`, `docs/DAFTAR_SECURITY_MODEL.md` and
# `docs/DAFTAR_THREAT_MODEL.md`; all three are identical at both trees today, so
# no row was lost -- but "currently harmless" is not a reason to keep a
# population narrower than the sentence over it. Admitted.
EXTS = ('ts','tsx','sql','yaml','yml','kt','js','json','sh','py','md')
CITE = re.compile(r'`([A-Za-z0-9_./-]+\.(?:%s))(?::[0-9][0-9,\s–-]*)?`' % '|'.join(EXTS))

BEGIN = '<!-- BEGIN GENERATED citation-provenance -- do not edit by hand -->'
END   = '<!-- END GENERATED citation-provenance -->'

# The migration-freeze anchor, pinned as the FULL 40-character object name. A
# coordinator relay of the Phase 8 challenger's measurement, re-measured here:
# GitHub serves this commit to `git fetch --depth 1 origin <40 chars>` (rc 0,
# `git cat-file -t` → commit) and REFUSES the 7-character abbreviation
# ("couldn't find remote ref 93084f8"). So an abbreviation is not a thing a CI
# job can fetch, and an abbreviation is also not a thing this tool should trust:
# it can become ambiguous as the repository grows, and `--base` defaults to one.
# Whenever the default is used, the resolved object is required to BE this
# literal, and every git call runs with replace refs OFF, so a `replace` object
# cannot substitute another tree for the anchor's.
ANCHOR = '93084f82b8e36ad49ebb207c0b6e7435d7fcb49f'

# CHALLENGE R19-P0-01's scope half, measured rather than assumed: this tool had
# `--no-replace-objects` and NO graft control, and its classification is
# history-derived, so one line in `.git/info/grafts` turns its block stale
# (rc 1) in a clone where it is current. That direction is fail-closed, so it
# was not a second fail-open -- but the class reaches here and one key closes
# both tools, so every git call of this tool now runs with the graft file
# pointed at os.devnull. GIT_SHALLOW_FILE is deliberately NOT set: it makes
# `rev-parse --is-shallow-repository` answer true on a full clone.
# CHALLENGE R20-P0-01's scope half: this tool is GIT_DIR-sensitive too, and
# measured FAIL-CLOSED (rc 2 CONFIGURATION ERROR against a decoy clone and
# against an unrelated repository), so it was not a second fail-open. The
# class reaches it and one scrub closes both, for the third round running
# on the rule that a remedy is not applied until every sibling carries it.
# The scrub stays inside this module's git calls, which are local reads;
# it is NOT exported to the sweep or to CI, which fetch.
GIT_ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
GIT_ENV.update(GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull)

def git(repo, *args):
    return subprocess.run(['git','-C',repo,'--no-replace-objects',*args],
                          capture_output=True, text=True, env=GIT_ENV)

def tracked(repo, rev):
    r = git(repo,'ls-tree','-r','--name-only',rev)
    return r.stdout.splitlines() if r.returncode==0 else []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    # ROUND-7 CHALLENGE P2-01: the repository must be derived from the PACK, not
    # from the working directory. Round 6 replaced a '.' default with the CWD's
    # `git rev-parse --show-toplevel`, which fixed the two cases anybody tested
    # and left the gate still deciding by location: from a cwd outside the
    # repository, or inside a DIFFERENT worktree of it, --repo named another
    # tree than --pack, `os.path.relpath` then climbed out of it with `../..`,
    # git refused that pathspec, and `was_in_pack` answered False for every
    # token -- so the deleted-scripts bucket collapsed into the proposed one and
    # the gate reported `BLOCK IS STALE`. A LOCATION problem printed as a
    # CONTENT verdict, with two fixed points selected by cwd. --pack is the one
    # argument that cannot be wrong, so the repository is read from it.
    _top = subprocess.run(['git','-C',ap.get_default('pack'),
                           '--no-replace-objects','rev-parse','--show-toplevel'],
                          capture_output=True, text=True, env=GIT_ENV)
    ap.add_argument('--repo', default=(_top.stdout.strip() or '.'))
    ap.add_argument('--base', default='93084f8')
    ap.add_argument('--other', default='6fc505d')
    ap.add_argument('--markdown', action='store_true')
    ap.add_argument('--write')
    ap.add_argument('--check')
    a = ap.parse_args()

    # ROUND-8 CHALLENGE P2-02: the round-7 remedy tested path ANCESTRY and
    # called it fixed. It is not the same property. `--repo /tmp` from a pack
    # that lives UNDER /tmp -- a reviewer's `mktemp -d` clone, a CI runner's
    # workspace -- has no leading `..`, so the ancestry refusal below cannot
    # fire; and `git()` never read `returncode` on the `log`/`ls-tree` calls, so
    # every git answer came back EMPTY and was treated as data. The table then
    # printed 13 lines instead of 57 -- all 41 base-tree rows gone, including
    # every frozen migration and the one `.json` whose difference changes a rule
    # -- and `--check` called the committed block STALE and told the reader to
    # `--write`, which would have committed the empty table. Word for word the
    # defect the comment above says was removed: a LOCATION problem printed as a
    # CONTENT verdict. So repository-ness is REQUIRED, by name, and so is the
    # presence of both revisions, because a directory can be a git repository
    # and still know nothing of this history (a decoy clone answers every
    # `ls-tree` with nothing at all).
    _gd = git(a.repo, 'rev-parse', '--git-dir')
    if _gd.returncode != 0:
        print('CONFIGURATION ERROR: --repo (%s) is not a git repository, so every'
              ' git answer below would be EMPTY and would be read as "the file is'
              ' absent". Pass --repo for the repository that contains the pack.'
              % a.repo, file=sys.stderr)
        return 2
    for _rev in (a.base, a.other):
        if git(a.repo, 'rev-parse', '--verify', '%s^{commit}' % _rev).returncode != 0:
            print('CONFIGURATION ERROR: --repo (%s) is a git repository but does not'
                  ' contain %s, so the two trees cannot be compared and every row'
                  ' would read as absent.%s' % (a.repo, _rev,
                  (' This is the migration-freeze anchor, and it is reachable from'
                   ' neither `main` nor this branch, so a plain clone does not carry'
                   ' it. Fetch it by its FULL object name —'
                   ' `git fetch --depth 1 origin %s` — or fetch a branch that'
                   ' contains it; the 7-character abbreviation is refused by the'
                   ' server.' % ANCHOR) if _rev == ap.get_default('base') else ''),
                  file=sys.stderr)
            return 2
    # CHALLENGE R15-P1-01 and the coordinator's relay of the Phase 8 finding: an
    # abbreviation is not an anchor. When `--base` is the default, what it
    # resolves to here must be the pinned full object name; another commit that
    # happens to share the prefix, or a `replace` object standing in for it, is a
    # DIFFERENT tree and every row below would be computed against it.
    if a.base == ap.get_default('base'):
        _res = git(a.repo, 'rev-parse', '--verify', '%s^{commit}' % a.base).stdout.strip()
        if _res != ANCHOR:
            print('CONFIGURATION ERROR: the default --base (%s) resolves to %s in --repo (%s),'
                  ' not to the pinned migration-freeze anchor %s. Every row below would be'
                  ' computed against a different tree, so nothing is reported.'
                  % (a.base, _res or '<nothing>', a.repo, ANCHOR), file=sys.stderr)
            return 2

    # COORD-DIFF-REVIEW R1 P3-12: only TOP-LEVEL pack documents were scanned, so
    # `proofs/README.md` and every case header were outside the population while
    # the output said "cited files". The walk is recursive now, and the scanned
    # set is printed with the result.
    docs = []
    for root, dirs, names in os.walk(a.pack):
        dirs[:] = [d for d in dirs if d != '.git']
        for f in sorted(names):
            if f.endswith(('.md','.yaml')) and not f.startswith('P14-CHALLENGE') \
               and not f.startswith('P14-COORD-DIFF-REVIEW'):
                docs.append(os.path.relpath(os.path.join(root, f), a.pack))
    docs = sorted(docs)
    hits = collections.defaultdict(set)          # cited token -> {doc, ...}
    for d in docs:
        text = open(os.path.join(a.pack,d), encoding='utf-8').read()
        # The generated block is itself full of `path` tokens, so a scan that
        # read it would count its own rows and never reach a fixed point. Strip
        # the generated region before scanning. (The hand-kept table this
        # replaced had the same property, silently.)
        text = re.sub(r'%s.*?%s' % (re.escape(BEGIN), re.escape(END)), '', text, flags=re.S)
        for m in CITE.finditer(text):
            hits[m.group(1)].add(d)

    base_files = tracked(a.repo, a.base)
    # resolve each cited token to real repo paths; a BARE BASENAME may resolve to
    # several files, which is itself a defect worth reporting (P3-04)
    resolved, unresolved, ambiguous = {}, [], {}
    for tok in sorted(hits):
        if tok in base_files:
            resolved[tok] = [tok]; continue
        base = os.path.basename(tok)
        cands = [p for p in base_files if p.endswith('/'+base) or p == base]
        # a path fragment like modules/pos/x.ts should match by suffix first
        suffix = [p for p in base_files if p.endswith('/'+tok)]
        if suffix:
            resolved[tok] = suffix
            if len(suffix) > 1: ambiguous[tok] = suffix
        elif cands:
            resolved[tok] = cands
            if len(cands) > 1: ambiguous[tok] = cands
        else:
            unresolved.append(tok)

    rows, differ, identical, absent = [], [], [], []
    for tok, paths in sorted(resolved.items()):
        for p in paths:
            rb = git(a.repo,'rev-parse','%s:%s'%(a.base,p))
            ro = git(a.repo,'rev-parse','%s:%s'%(a.other,p))
            # NOTE: `git rev-parse <rev>:<missing path>` exits NON-ZERO but still
            # echoes the ref to stdout, so a missing file reads as a present blob
            # unless the RETURN CODE is checked. The first version of this script
            # checked only stdout and reported absent=0 while 0079 was absent --
            # the same species of defect the script exists to eliminate.
            b = rb.stdout.strip() if rb.returncode == 0 else ''
            o = ro.stdout.strip() if ro.returncode == 0 else ''
            if not o:
                v = '**ABSENT at %s**' % a.other; absent.append(p)
            elif b == o:
                v = 'identical'; identical.append(p)
            else:
                ns = git(a.repo,'diff','--numstat','%s..%s'%(a.other,a.base),'--',p).stdout.split()
                v = '**DIFFERS** (+%s/-%s)' % (ns[0],ns[1]) if len(ns)>=2 else '**DIFFERS**'
                differ.append(p)
            rows.append((p, v, tok, sorted(hits[tok])))

    uniq = lambda xs: sorted(set(xs))
    differ, identical, absent = uniq(differ), uniq(identical), uniq(absent)
    total = len(differ)+len(identical)+len(absent)

    # ROUND-8 CHALLENGE P2-02, second remedy: the row count is GENERATED and was
    # never MEASURED, which is this pack's own law applied to its own
    # instrument. An empty or near-empty table is not a result; under any
    # misconfiguration that survives the refusals above it is the LOUDEST
    # symptom available, so it is asserted rather than printed.
    # And a floor DERIVED FROM SOURCE rather than typed (coordinator relay,
    # round 8): every cited token that exists as a file in the repository's own
    # working tree MUST have resolved. A typed expected row count would be the
    # hand-kept list again; the filesystem is an independent witness, and
    # "the file is right there on disk but git answered nothing" is exactly the
    # shape of the empty-table defect.
    floor = [t for t in sorted(hits)
             if not os.path.isabs(t) and os.path.exists(os.path.join(a.repo, t))]
    lost = [t for t in floor if t not in resolved]
    if lost:
        print('MEASUREMENT INCOMPLETE: %d cited file(s) exist in the working tree of'
              ' --repo (%s) but resolved to no row — %s. git answered nothing for'
              ' paths that are present on disk, so the table below would be short'
              ' and the shortfall would read as "absent at the other tree".'
              % (len(lost), a.repo, ', '.join('`%s`' % x for x in lost[:6])), file=sys.stderr)
        return 2
    if total == 0 or not base_files:
        print('MEASUREMENT EMPTY: %d cited file(s) resolved against `%s` (%d path(s) tracked'
              ' there). A generated table with no rows is a misconfiguration, not a finding:'
              ' it would be committed as the measurement and `--check` would then hold it'
              ' stable forever.' % (total, a.base, len(base_files)), file=sys.stderr)
        return 2

    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        print('| Cited file | `%s` vs `%s` | cited as | cited in |' % (a.other, a.base))
        print('|---|---|---|---|')
        seen=set()
        for p,v,tok,ds in rows:
            if p in seen: continue
            seen.add(p)
            print('| `%s` | %s | `%s` | %s |' % (p, v, tok, ', '.join(d.replace('.md','') for d in ds)))
        print()
        print('**%d cited files resolved: %d DIFFER, %d identical, %d ABSENT at `%s`.**'
              % (total, len(differ), len(identical), len(absent), a.other))
        print('\nScanned population: backticked citations with one of these extensions — %s —'
              ' taken from **%d document(s)**: every `.md` and `.yaml` under the pack, walked'
              ' recursively (so `proofs/README.md` and the case headers are included), excluding the'
              ' challenge reports and the coordinator reviews, which are other people\'s words'
              ' committed unedited, and excluding this generated block itself, which would otherwise'
              ' count its own rows. The population is printed because `ROUND-6 P2-01` and'
              ' `COORD-DIFF-REVIEW R1 P3-12` each found the sentence claiming more than the pattern'
              ' matched: first `json` was missing — and the one cited file whose difference changes a'
              ' RULE is a `.json` — then `md` was, and only top-level documents were read.'
              % (', '.join('`.%s`' % e for e in EXTS), len(docs)))
        if absent:
            print('\nAbsent at `%s`: %s — a reader on that tree cannot verify these citations at all.'
                  % (a.other, ', '.join('`%s`'%x for x in absent)))
        if ambiguous:
            print('\n**Ambiguous citations** (a bare basename resolving to several files — cite the path):')
            for tok, ps in sorted(ambiguous.items()):
                print('- `%s` → %s' % (tok, ', '.join('`%s`'%x for x in ps)))
        if unresolved:
            # Classify rather than dump: most "unresolved" tokens are not
            # citations of live code at all, and listing them as if they were
            # missing files misleads a reader.
            # ROUND-6 P3-04: `cases/c7a_cross_business_accepted.sql` landed in
            # the PROPOSES bucket, which is false twice over -- it is a proof
            # script, and it is one this pack DELETED. The bucket was decided by
            # a NAME PATTERN, which is the hand-kept list again at one remove,
            # so it is decided by MEASUREMENT instead: a token that resolves to
            # a real file inside the pack is the pack's own, whatever it is
            # called. (Widening the extensions to `.sh`/`.py` immediately proved
            # the point: the pack's own driver and tools were classified as
            # files the phase proposes.)
            # COORD-DIFF-REVIEW R1 P2-02: these buckets counted TOKENS, not
            # files, and they overlapped -- `replay.sh` and `proofs/replay.sh`
            # each counted, `packown` was still a name pattern that intersected
            # the in-pack bucket, `deleted` was folded BEFORE `future` was built
            # from "not in deleted" so the folded-out basename leaked into
            # PROPOSES, and an absolute `/mnt/...` token was resolved against
            # the HOST filesystem. The buckets summed to 60 against 59 tokens
            # and nothing noticed, which is the defect: a classification nobody
            # can add up is not a measurement. So: membership is computed on the
            # UNFOLDED token set with a strict priority, folding is for DISPLAY
            # only, and the totals are ASSERTED to partition the set.
            # COORD DIFF REVIEW AT c812aa5, P2-02, which BLOCKED: the three
            # directories here were a HAND-KEPT LIST -- the very thing round 6
            # said it had replaced with measurement -- and `tools` was not on
            # it, so `citation-provenance.py`, `gate-sweep.sh` and
            # `retracted-claims.py` were generated into the bucket of "files
            # this phase PROPOSES and that correctly do not exist yet" while
            # sitting in the pack being run by the gate that printed it. Adding
            # 'tools' would have fixed those three and left the next directory
            # to be found by the next reviewer, so the list is gone: the pack is
            # WALKED, and a token belongs to the pack when it is a real file
            # under it, at any depth, matched at a path boundary.
            pack_rel = set()
            for _root, _dirs, _files in os.walk(a.pack):
                _dirs[:] = [d for d in _dirs if d != '.git']
                for _f in _files:
                    pack_rel.add(os.path.relpath(os.path.join(_root, _f), a.pack))
            def in_pack(tok):
                if os.path.isabs(tok):
                    return False          # not ours to resolve on this host
                # `./redproof-preflight.sh` is cited with its `./` because the
                # file is mode 100644 and must be run through bash; it is the
                # same file either way, and normalising is what keeps a live
                # pack file out of the DELETED bucket.
                tok = os.path.normpath(tok)
                return any(rp == tok or rp.endswith(os.sep + tok) for rp in pack_rel)
            # ROUND-7 P2-01, second remedy, taken as well as the first: a
            # pathspec that leaves the repository must FAIL LOUDLY. Answering
            # False turns a misconfiguration into a silent misclassification,
            # and a wrong bucket then reads as drift.
            rel = os.path.relpath(a.pack, a.repo)
            if rel.startswith('..') or os.path.isabs(rel):
                print('CONFIGURATION ERROR: --pack (%s) is not inside --repo (%s), so no pathspec'
                      ' under the pack can be resolved and every classification below would be'
                      ' silently wrong. Pass --repo for the repository that contains the pack.'
                      % (a.pack, a.repo), file=sys.stderr)
                return 2
            def was_in_pack(tok):
                # Same defect, same remedy: a glob pathspec over the WHOLE pack
                # instead of three named directories. `rel/**/tok` matches the
                # pack root as well as any depth under it.
                if os.path.isabs(tok):
                    return False
                tok = os.path.normpath(tok)
                r = git(a.repo, 'log', '--all', '--oneline', '-1', '--',
                        ':(glob)%s/**/%s' % (rel, tok))
                if r.returncode != 0:
                    print('CONFIGURATION ERROR: `git log` refused the pathspec for %r under %s'
                          ' (%s), so no token can be classified as one this pack deleted and the'
                          ' bucket below would be silently wrong.'
                          % (tok, rel, (r.stderr.strip().split(chr(10)) or [''])[0][:160]),
                          file=sys.stderr)
                    raise SystemExit(2)
                return bool(r.stdout.strip())

            fold = lambda xs: sorted(x for x in xs
                                     if not any(y != x and y.endswith('/'+x) for y in xs))
            # strict priority, each token in exactly one bucket
            proofs  = [x for x in unresolved if in_pack(x)]
            deleted = [x for x in unresolved if x not in proofs and was_in_pack(x)]
            abspath = [x for x in unresolved if x not in proofs and x not in deleted
                       and os.path.isabs(x)]
            # A `.md`/`.yaml` token that is neither in the pack nor in either
            # tree is another document -- another phase's pack, a directive --
            # cited by name. It is NOT a file this phase proposes: this phase
            # proposes source files and gates, and no markdown outside its own
            # folder. Lumping the two together put `P4-SLOT4-ROSTER-PROOF-LAW.md`
            # among Phase 14's proposed files, which is simply false.
            otherdocs = [x for x in unresolved if x not in proofs and x not in deleted
                         and x not in abspath and x.endswith(('.md','.yaml'))
                         and not x.startswith('P14-')]
            # COORDINATOR RE-REVIEW AT a725342 (P3): a MISSPELLED pack document
            # name sat in the "documents that live outside this pack" bucket,
            # which is a false sentence about it -- `P14-AMENDMENT-11-CHALLENGE-
            # ROUND-7.md` lives nowhere, it is the wrong name for a file that is
            # in the pack. A token spelled like one of this pack's own documents
            # and absent from the pack is neither outside nor proposed: it is
            # named and not present, and it gets its own line saying exactly
            # that, because the next one may be a typo rather than a name quoted
            # as wrong.
            misnamed = [x for x in unresolved if x not in proofs and x not in deleted
                        and x not in abspath and x.endswith(('.md','.yaml'))
                        and x.startswith('P14-')]
            future  = [x for x in unresolved if x not in proofs and x not in deleted
                       and x not in abspath and x not in otherdocs and x not in misnamed]
            assert (len(proofs)+len(deleted)+len(abspath)+len(otherdocs)+len(misnamed)
                    +len(future) == len(unresolved)), \
                'the buckets do not partition the unresolved tokens'
            fp, fd, fa, fo, fm, ff = (fold(proofs), fold(deleted), fold(abspath),
                                      fold(otherdocs), fold(misnamed), fold(future))
            print('\n**Cited tokens that are not live code at `%s`, classified.** Each token is in'
                  ' exactly one bucket, and the generator asserts that all six add up to the %d'
                  ' unresolved tokens. The counts below are of FILES (spellings of one path folded'
                  ' together); the token count is given beside each, because an earlier edition'
                  ' counted tokens while saying files and the buckets summed to one more than'
                  ' existed (`COORD-DIFF-REVIEW R1 P2-02`).'
                  % (a.base, len(unresolved)))
            print('- **%d file(s)** (%d tokens) resolve to real files INSIDE this pack — its proof'
                  ' scripts, its driver and its tools — which live in the pack and not in the repo.'
                  % (len(fp), len(proofs)))
            if fd:
                print('- **%d file(s)** (%d tokens) were proof scripts this pack DELETED and still'
                      ' names: %s. Git knows them under the pack, so they are neither live code nor'
                      ' proposed files, and a reader must not look for them.'
                      % (len(fd), len(deleted), ', '.join('`%s`' % x for x in fd)))
            if fa:
                print('- **%d file(s)** (%d tokens) are cited by an ABSOLUTE path outside the'
                      ' repository (%s). They are not resolved here: resolving an absolute token'
                      ' would measure this host rather than either tree.'
                      % (len(fa), len(abspath), ', '.join('`%s`' % x for x in fa)))
            if fo:
                print('- **%d file(s)** (%d tokens) are documents that live OUTSIDE this pack and'
                      ' outside both trees — another phase\'s pack, or a directive — cited by name:'
                      ' %s. They are not files this phase proposes.'
                      % (len(fo), len(otherdocs), ', '.join('`%s`' % x for x in fo)))
            if fm:
                print('- **%d file(s)** (%d tokens) are spelled like one of THIS pack\'s own'
                      ' documents and are not in the pack: %s. Such a token is neither an outside'
                      ' document nor a proposed file — it is a name that exists nowhere, either a'
                      ' typo or a wrong name quoted as wrong (`COORD-DIFF-REVIEW a725342`).'
                      % (len(fm), len(misnamed), ', '.join('`%s`' % x for x in fm)))
            print('- **%d file(s)** (%d tokens) are files this phase PROPOSES and that correctly do'
                  ' not exist yet: %s'
                  % (len(ff), len(future), ', '.join('`%s`' % x for x in ff)))
            # COORD-DIFF-REVIEW R1 P3-08: this line used to say `--check` turns a
            # proposed file that later appears into drift. It cannot: resolution
            # is against the PINNED base, so building the phase can never make
            # one resolve at `93084f8`. A gate credited with a detection it
            # cannot make is the same species as a gate cited by the wrong
            # number, so the claim is withdrawn rather than reworded.
            print('  A reader should not look for these in any tree. They are absent at `%s` by this'
                  " scan's own construction. **No gate asserts their absence, and `--check` cannot"
                  ' detect their arrival**: resolution is pinned to `%s`, so building the phase would'
                  ' not make them resolve there. What `--check` does detect is this block drifting'
                  ' from the trees it describes.' % (a.base, a.base))
    block = buf.getvalue().strip('\n')

    if a.markdown:
        print(block)
    elif a.write or a.check:
        doc = a.write or a.check
        text = open(doc, encoding='utf-8').read()
        m = re.search(r'(%s\n)(.*?)(\n%s)' % (re.escape(BEGIN), re.escape(END)),
                      text, re.S)
        if not m:
            print('%s: markers %s / %s not found' % (doc, BEGIN, END), file=sys.stderr)
            return 2
        if a.write:
            open(doc, 'w', encoding='utf-8').write(
                text[:m.start(2)] + block + text[m.end(2):])
            print('%s: generated block written (%d lines)' % (doc, block.count(chr(10))+1))
            return 0
        if m.group(2).strip('\n') != block:
            print('%s: GENERATED CITATION-PROVENANCE BLOCK IS STALE.' % doc, file=sys.stderr)
            print('Run: tools/citation-provenance.py --write %s' % doc, file=sys.stderr)
            return 1
        print('%s: generated citation-provenance block is current.' % doc)
        return 0
    else:
        print('resolved=%d differ=%d identical=%d absent=%d ambiguous=%d unresolved=%d'
              % (total, len(differ), len(identical), len(absent), len(ambiguous), len(unresolved)))
        for p in differ: print('DIFFERS   %s' % p)
        for p in absent: print('ABSENT    %s' % p)
    return 0

if __name__ == '__main__':
    sys.exit(main())
