#!/usr/bin/env python3
"""Fail when a RETRACTED claim survives somewhere it is not recorded.

ROUND-7 CHALLENGE P3-02 found "the three absent ones are cited only for Phase 4
surface facts" still in `P14-HANDOFF-MANIFEST.md` after it had been retracted in
§15 and in Amendment 09 -- and no gate could see it. `manifest-digests.py
--check` validates digests, byte counts and row/file correspondence;
`citation-provenance.py --check` validates one generated block. Stale PROSE
passed both, in the first page a handoff reader reads.

So retractions are data (`RETRACTED-CLAIMS.tsv`), and this checks them. A
retracted sentence is allowed only where the retraction is RECORDED: the
amendment that retracts it, the report that found it, and the corrected row that
quotes it. Anywhere else is an exit 1 naming the file, the line and the reason.

  usage: tools/retracted-claims.py [--pack DIR] [--list FILE] [--check]
"""
import argparse, hashlib, os, shutil, subprocess, sys

# CHALLENGE R27-P1-01 and the coordinator's ruling: all THREE instruments over
# this pack load ONE enumeration, by path, refused unless its sha256 equals the
# literal below. Round 26 wrote the structural exclusion into two tools and
# proved the sentence against the two it was thinking of; the third pruned by
# NAME and a planted repository-shaped directory moved a published figure. A
# shared module cannot drift, and an edited one refuses in all three until each
# pin is updated deliberately.
_DOMAIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pack-domain.py')
_DOMAIN_SHA = 'd6a48ae0a4f8961ff25b35aff8a61c5e2c6e234cd2b85505544e610de1c44483'

# CHALLENGE R27-P1-01, the other half: this tool had NO git at all, so it could
# not ask the question its sibling asks. The pinned resolution is the one the
# other two carry, system locations first and the binary resolved once and
# passed absolute, so no lookup inside a child can reach a shim.
_PINNED_PATH = '/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin'
_GIT_BIN = shutil.which('git', path=_PINNED_PATH)
_GIT_ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
_GIT_ENV.update(GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull, PATH=_PINNED_PATH)


def _load_domain():
    try:
        raw = open(_DOMAIN_FILE, 'rb').read()
    except OSError as exc:
        print('CONFIGURATION ERROR: THE SHARED ENUMERATION COULD NOT BE READ. %s (%s: %s), so'
              ' this tool does not know which files are in this pack and no retracted claim was'
              ' looked for.' % (_DOMAIN_FILE, type(exc).__name__, exc), file=sys.stderr)
        raise SystemExit(2)
    got = hashlib.sha256(raw).hexdigest()
    if got != _DOMAIN_SHA:
        print('CONFIGURATION ERROR: THE SHARED ENUMERATION DOES NOT MATCH ITS PIN. %s hashes %s'
              ' and this tool is pinned to %s. The domain these three instruments share is not'
              ' the one this tool was reviewed against, so no retracted claim was looked for.'
              % (_DOMAIN_FILE, got, _DOMAIN_SHA), file=sys.stderr)
        raise SystemExit(2)
    ns = {'__name__': 'pack_domain', '__file__': _DOMAIN_FILE}
    exec(compile(raw, _DOMAIN_FILE, 'exec'), ns)
    return ns


_D = _load_domain()


def _git_is_repo(path):
    """True / False / None (git could not be asked)."""
    if _GIT_BIN is None:
        return None
    try:
        for _args in (['rev-parse', '--git-dir'], ['rev-parse', '--verify', 'HEAD^{commit}']):
            r = subprocess.run([_GIT_BIN, '--git-dir=' + path, '--no-replace-objects'] + _args,
                               capture_output=True, text=True, env=_GIT_ENV)
            if r.returncode != 0:
                return False
    except (FileNotFoundError, PermissionError, OSError):
        return None
    return True


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--pack', default=os.path.dirname(here))
    ap.add_argument('--list', default=os.path.join(here, 'RETRACTED-CLAIMS.tsv'))
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()

    claims = []
    for ln in open(a.list, encoding='utf-8'):
        ln = ln.rstrip('\n')
        if not ln.strip() or ln.lstrip().startswith('#'):
            continue
        parts = ln.split('\t')
        if len(parts) < 3:
            print('%s: malformed row (needs claim<TAB>allowed<TAB>why): %r'
                  % (a.list, ln), file=sys.stderr)
            return 2
        claims.append((parts[0], [x.strip() for x in parts[1].split(',') if x.strip()],
                       parts[2]))
    if not claims:
        print('%s: no retracted claims listed — nothing is enforced, which is not a pass'
              % a.list, file=sys.stderr)
        return 2

    # Every document in the pack, and the proofs' README, which is prose too.
    # COORD DIFF REVIEW AT c812aa5, R-01: this skip was a SUBSTRING test on the
    # absolute path, so every document of a pack checked out under any path
    # containing `/tools` was skipped and the tool reported "across 0 pack
    # document(s)" with exit 0 -- a gate component whose verdict depended on
    # where the repository happened to sit, which is round 8's defect again.
    # The skip is now relative to the pack, and a run that scanned NO document
    # refuses: measuring nothing is not a pass.
    # CHALLENGE R26-P1-01, then R27-P1-01: the instruments over this directory
    # must enumerate the SAME domain. That fail-open was an asymmetry -- a file
    # this tool read and `manifest-digests.py` could not see, which is how a
    # plant moved a published document count while the pin stayed green. Round 26
    # wrote a structural exclusion into TWO tools and proved the sentence against
    # the two it was thinking of; the pack has THREE, and the third pruned by
    # name. So there is no exclusion written here at all: the walk comes from
    # `tools/pack-domain.py`, loaded by digest, and the question "is this
    # directory a repository" is put to git itself rather than to a
    # HEAD/objects/refs test, which the challenger's empty-HEAD forgery passed.
    _entries, _excluded, _dref = _D['walk'](a.pack, _git_is_repo)
    if _dref:
        for _r in sorted(set(_dref)):
            print(_r, file=sys.stderr)
        print('%d path(s) under --pack (%s) could not be classified, so the population this run'
              ' would have measured is UNDECIDED and no retracted claim was looked for.'
              % (len(set(_dref)), a.pack), file=sys.stderr)
        return 2
    files = []
    for _rel, _ap in _entries:
        if _rel == 'tools' or _rel.startswith('tools/'):
            continue                      # the list itself quotes every claim
        if _rel.endswith(('.md', '.yaml')):
            files.append(_ap)
    if not files:
        print('%s: no .md or .yaml document was found under --pack (%s), so no retracted claim'
              ' was looked for. An empty population is not a pass.' % (a.list, a.pack),
              file=sys.stderr)
        return 2

    # COORD DIFF REVIEW AT c812aa5, R-10: an allow-list entry named a file that
    # does not exist (`P14-AMENDMENT-11-CHALLENGE-ROUND-7.md`, whose real name
    # ends `-AND-COORD-REVIEW.md`). It failed closed -- the exemption simply did
    # not apply -- but an exemption nobody can reach is a line of this list that
    # says something false, and the next one might be a real exemption silently
    # not granted. Every allowed name must be a document this run actually
    # scanned.
    basenames = {os.path.basename(f) for f in files}
    ghosts = sorted({n for _c, allowed, _w in claims for n in allowed if n not in basenames})
    if ghosts:
        print('%s: the allowed list names %d document(s) that are not under --pack (%s): %s. An'
              ' exemption that names no file is not an exemption; correct the name or drop it.'
              % (a.list, len(ghosts), a.pack, ', '.join(ghosts)), file=sys.stderr)
        return 2

    bad = 0; exempt = 0
    for path in sorted(files):
        base = os.path.basename(path)
        text = open(path, encoding='utf-8', errors='replace').read().split('\n')
        # A challenge report is the record of what a reviewer CLAIMED, committed
        # byte-for-byte as received. Editing one to satisfy this check would be
        # falsifying a review, so they are exempt in code rather than by being
        # listed one at a time.
        # COORD DIFF REVIEW AT c812aa5: a coordinator's review is a reviewer's
        # words committed unedited for the same reason a challenge report is,
        # and it QUOTES the sentences this list retracts -- that is what a
        # review does. Editing one to satisfy this check would be falsifying a
        # review. (`citation-provenance.py` already excluded both.)
        if base.startswith(('P14-CHALLENGE-', 'P14-COORD-DIFF-REVIEW-')):
            exempt += 1          # ROUND-8 P3-01: counted separately, not as enforced
            continue
        for claim, allowed, why in claims:
            if base in allowed:
                continue
            for i, ln in enumerate(text, 1):
                if claim in ln:
                    print('RETRACTED CLAIM PRESENT: %s:%d — %r\n'
                          '  retracted because: %s\n'
                          '  allowed only in: %s'
                          % (os.path.relpath(path, a.pack), i, claim, why,
                             ', '.join(allowed)), file=sys.stderr)
                    bad += 1
    # ROUND-8 CHALLENGE P3-01: this line said "enforced across N pack
    # document(s)" while N counted the files it had just EXEMPTED -- a
    # population figure that included what it did not measure, which is the
    # defect round 6 found in the provenance generator, here in the tool written
    # to fence prose. Enforced and exempt are counted separately.
    print('%d retracted claim(s) enforced across %d pack document(s); %d challenge report(s)'
          ' exempt in code (a reviewer\'s words, challenger or coordinator, are the record of'
          ' what was claimed).'
          % (len(claims), len(files) - exempt, exempt))
    # CHALLENGE R27-P1-01: every instrument says what its population IS and what
    # it leaves out, in its own output, so two figures over this pack can be
    # compared without reading either tool.
    print('population: %s, minus this tool\'s own `tools/` directory (the list quotes every'
          ' claim), scanned for .md and .yaml; %d directory(ies) excluded as a repository%s'
          % (_D['DOMAIN'], len(_excluded),
             (': ' + ', '.join(os.path.relpath(x, a.pack) for x in sorted(_excluded)))
             if _excluded else ''))
    if bad:
        print('%d occurrence(s) of a retracted claim survive outside the files that record the'
              ' retraction. Correct the prose, or add the file to the allowed list ONLY if it'
              ' quotes the claim AS retracted.' % bad, file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
