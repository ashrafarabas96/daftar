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
import argparse, hashlib, os, re, subprocess, sys

# ROUND-9 CHALLENGE P2-02: the unsigned placeholder used to be sixty-four
# ZEROS, which is a well-formed digest. One `sed` over a challenge row turned
# the refusal below into an escape hatch: zero the digest, `--write`, and the
# row is re-signed against a TAMPERED reviewer's report. A placeholder must be
# something corrupting a digest cannot produce, so it is the literal `UNSIGNED`
# in BOTH cells -- and a row with one placeholder cell and one real one is not
# a placeholder at all.
ROW = re.compile(r'^\| `(P14-[^`]+|README-AR\.md)` \| (.*?) \| `([0-9a-f]{64}|UNSIGNED)` \| ([0-9,]+|UNSIGNED) \|$')
PLACEHOLDER = 'UNSIGNED'

def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--manifest', default=os.path.join(here,'P14-HANDOFF-MANIFEST.md'))
    ap.add_argument('--dir', default='/mnt/project-files/phase14')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true')
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
    head_rows, history = {}, 'checked'
    _md = os.path.dirname(os.path.abspath(a.manifest))
    _r = subprocess.run(['git','-C',_md,'show','HEAD:./%s' % os.path.basename(a.manifest)],
                        capture_output=True, text=True)
    if _r.returncode == 0:
        for ln in _r.stdout.split('\n'):
            m = ROW.match(ln)
            if m: head_rows[m.group(1)] = m.group(3)
    else:
        history = 'NOT CHECKED (the manifest is not in a git repository here)'
    listed, out, stale, refused = [], [], [], []
    for ln in lines:
        m = ROW.match(ln)
        if not m:
            out.append(ln); continue
        name, desc, dig, size = m.groups()
        listed.append(name)
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
        was = head_rows.get(name)
        if (name.startswith('P14-CHALLENGE-') and was and was != PLACEHOLDER
                and dig != was):
            stale.append('%s: this reviewer\'s row carried %s at HEAD and now carries %s —'
                         ' a signed reviewer row does not move, in either direction. Restore'
                         ' the row, or the reviewer\'s file, whichever was changed.'
                         % (name, was[:12], dig[:12] if dig != PLACEHOLDER else PLACEHOLDER))
            refused.append(name)
            out.append(ln); continue
        unsigned = (dig == PLACEHOLDER and size == PLACEHOLDER)
        if a.write and drifted and name.startswith('P14-CHALLENGE-') and not unsigned:
            stale.append('%s: REFUSING to re-sign a challenge report\'s row — the file under'
                         ' %s no longer matches the digest committed when it was received.'
                         ' Restore the reviewer\'s file; do not update the row.' % (name, a.dir))
            refused.append(name)
            out.append(ln); continue
        out.append('| `%s` | %s | `%s` | %s |' % (name, desc, h, format(len(b),',')))

    on_disk = sorted(f for f in os.listdir(a.dir)
                     if f.endswith(('.md','.yaml')) and f != 'P14-HANDOFF-MANIFEST.md')
    unlisted = [f for f in on_disk if f not in listed]
    missing  = [n for n in listed if not os.path.exists(os.path.join(a.dir,n))]

    for u in unlisted: stale.append('%s: ARTIFACT WITH NO ROW' % u)
    print('manifest: %d artifact row(s) + the manifest itself; %d file(s) in %s;'
          ' reviewer-row history %s'
          % (len(listed), len(on_disk), a.dir, history))
    if a.write:
        open(a.manifest,'w',encoding='utf-8').write('\n'.join(out))
        for s in stale: print('  updated/flagged: %s' % s)
        if unlisted: print('  NOT ADDED (a row is a description, not a digest — write it): %s' % ', '.join(unlisted))
        return 1 if (unlisted or missing or refused) else 0
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
