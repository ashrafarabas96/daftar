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

CITE = re.compile(r'`([A-Za-z0-9_./-]+\.(?:ts|tsx|sql|yaml|yml|kt|js))(?::[0-9][0-9,\s–-]*)?`')

BEGIN = '<!-- BEGIN GENERATED citation-provenance -- do not edit by hand -->'
END   = '<!-- END GENERATED citation-provenance -->'

def git(repo, *args):
    return subprocess.run(['git','-C',repo,*args], capture_output=True, text=True)

def tracked(repo, rev):
    r = git(repo,'ls-tree','-r','--name-only',rev)
    return r.stdout.splitlines() if r.returncode==0 else []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    # The repo root, not the cwd: the gate must give the same answer from the
    # pack directory and from the repo root. A default of '.' made --check
    # report STALE from one and current from the other, which is a gate that
    # disagrees with itself.
    _top = subprocess.run(['git','rev-parse','--show-toplevel'],
                          capture_output=True, text=True)
    ap.add_argument('--repo', default=(_top.stdout.strip() or '.'))
    ap.add_argument('--base', default='93084f8')
    ap.add_argument('--other', default='6fc505d')
    ap.add_argument('--markdown', action='store_true')
    ap.add_argument('--write')
    ap.add_argument('--check')
    a = ap.parse_args()

    docs = sorted(f for f in os.listdir(a.pack)
                  if f.endswith(('.md','.yaml')) and not f.startswith('P14-CHALLENGE'))
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
            proofs = [x for x in unresolved if re.match(r'^(c[0-9]|proofs/|bootstrap|fixture)', x)]
            packown = [x for x in unresolved if x.endswith(('.yaml',)) and 'P14-' in x]
            future = [x for x in unresolved if x not in proofs and x not in packown]
            print('\n**Cited tokens that are not live code at `%s`, classified:**' % a.base)
            print('- %d are this pack\'s own proof scripts (`proofs/cases/*.sql`), which live in the pack, not the repo.' % len(proofs))
            if packown:
                print('- %d are the pack\'s own artifacts.' % len(packown))
            print('- %d are files this phase PROPOSES and that correctly do not exist yet: %s'
                  % (len(future), ', '.join('`%s`'%x for x in sorted(future))))
            print('  A reader should not look for these in any tree; `P14-GATE-034` asserts they stay absent until the phase is built.')
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
