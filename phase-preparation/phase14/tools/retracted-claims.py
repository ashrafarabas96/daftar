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
    files = []
    for root, _dirs, names in os.walk(a.pack):
        if os.sep + 'tools' in root + os.sep:
            continue                      # the list itself quotes every claim
        for n in sorted(names):
            if n.endswith(('.md', '.yaml')):
                files.append(os.path.join(root, n))

    bad = 0; exempt = 0
    for path in sorted(files):
        base = os.path.basename(path)
        text = open(path, encoding='utf-8', errors='replace').read().split('\n')
        # A challenge report is the record of what a reviewer CLAIMED, committed
        # byte-for-byte as received. Editing one to satisfy this check would be
        # falsifying a review, so they are exempt in code rather than by being
        # listed one at a time.
        if base.startswith('P14-CHALLENGE-'):
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
          ' exempt in code (a reviewer\'s words are the record of what was claimed).'
          % (len(claims), len(files) - exempt, exempt))
    if bad:
        print('%d occurrence(s) of a retracted claim survive outside the files that record the'
              ' retraction. Correct the prose, or add the file to the allowed list ONLY if it'
              ' quotes the claim AS retracted.' % bad, file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
