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
import argparse, os, sys

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
    # CHALLENGE R26-P1-01: the two instruments over this directory must enumerate
    # the SAME domain. The whole of that fail-open was an asymmetry -- a file this
    # tool read and `manifest-digests.py` could not see, which is how a plant
    # moved a published document count while the pin stayed green. So the one
    # structural exclusion is written here too: a directory that IS a git
    # repository (HEAD, objects and refs present) is a repository, not pack
    # content. The test is structure, not spelling.
    def _is_repo_dir(p):
        return (os.path.isfile(os.path.join(p,'HEAD'))
                and os.path.isdir(os.path.join(p,'objects'))
                and os.path.isdir(os.path.join(p,'refs')))
    files = []
    for root, _dirs, names in os.walk(a.pack):
        _dirs[:] = [x for x in sorted(_dirs) if not _is_repo_dir(os.path.join(root,x))]
        relroot = os.path.relpath(root, a.pack)
        if relroot == 'tools' or relroot.startswith('tools' + os.sep):
            continue                      # the list itself quotes every claim
        for n in sorted(names):
            if n.endswith(('.md', '.yaml')):
                files.append(os.path.join(root, n))
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
    if bad:
        print('%d occurrence(s) of a retracted claim survive outside the files that record the'
              ' retraction. Correct the prose, or add the file to the allowed list ONLY if it'
              ' quotes the claim AS retracted.' % bad, file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
