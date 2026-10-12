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
# COORD DIFF REVIEW AT c812aa5, R-03: only names beginning P14-CHALLENGE- were held
# to the reviewer-row rules, so a coordinator's review could be tampered with and
# re-signed. A review is a review whoever wrote it.
REVIEWER_PREFIXES = ('P14-CHALLENGE-', 'P14-COORD-DIFF-REVIEW-')

def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--manifest', default=os.path.join(here,'P14-HANDOFF-MANIFEST.md'))
    ap.add_argument('--dir', default='/mnt/project-files/phase14')
    ap.add_argument('--witness', help='directory holding the second copy of each'
                    ' reviewer report; defaults to the counterpart of --dir')
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
                    help='accept a manifest history that cannot be read in full (shallow clone);'
                         ' the limit is printed either way')
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
    # for the same report is itself a refusal. What a commit can still do is
    # rewrite history, and that is named as a limit rather than guarded here.
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
    _md = os.path.dirname(os.path.abspath(a.manifest))
    _mb = os.path.basename(a.manifest)
    _revs = subprocess.run(['git','-C',_md,'rev-list','HEAD','--',_mb],
                           capture_output=True, text=True)
    def _g(*argv):
        return subprocess.run(['git','-C',_md] + list(argv), capture_output=True, text=True)
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
        _par = _g('rev-parse', '%s^@' % _oldest)
        _shallow = (_g('rev-parse', '--is-shallow-repository').stdout.strip() == 'true')
        # A grafted commit reports NO PARENTS, exactly like a true root commit,
        # so "the parents are readable" cannot see a `--depth 1` clone at all:
        # measured, that clone answered "checked over every revision" over a
        # single truncated revision. The graft list is where the truth is.
        _bounds = set()
        if _shallow:
            _gd = _g('rev-parse', '--absolute-git-dir').stdout.strip()
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
            elif _g('cat-file', '-e', '%s:./%s' % (_p, _mb)).returncode == 0:
                _incomplete = ('the oldest revision of this manifest reachable here (%s) is a'
                               ' modification, not the commit that added it, so the digest a'
                               ' report was received with may be out of reach' % _oldest[:12])
    if _revs.returncode != 0 or not _revs.stdout.strip():
        history = 'NOT CHECKED (the manifest is not in a git repository here)'
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
            r = subprocess.run(['git','-C',_md,'show','%s:./%s' % (rev,_mb)],
                               capture_output=True, text=True)
            if r.returncode != 0:
                if _g('cat-file', '-e', '%s:./%s' % (rev, _mb)).returncode != 0:
                    gaps.append(rev)      # the manifest does not exist in this revision
                    continue
                _why = (r.stderr.strip().split('\n') or [''])[0][:120]
                signed_history, moved = {}, {}
                history = ('NOT CHECKED (revision %s of this manifest could not be read: %s)'
                           % (rev[:12], _why or 'git show failed'))
                break
            for ln in r.stdout.split('\n'):
                m = ROW.match(ln)
                if not m or m.group(3) == PLACEHOLDER: continue
                nm, dg = m.group(1), m.group(3)
                if nm not in signed_history:
                    signed_history[nm] = dg
                elif dg != signed_history[nm] and nm not in moved:
                    moved[nm] = (signed_history[nm], dg, rev)
        if gaps and history.startswith('checked'):
            history += (', and the manifest is ABSENT in %d of them (%s) — removed and re-added,'
                        ' which does not erase the records before it'
                        % (len(gaps), ', '.join(g[:12] for g in gaps[:4])))
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

    on_disk = sorted(f for f in os.listdir(a.dir)
                     if f.endswith(('.md','.yaml')) and f != 'P14-HANDOFF-MANIFEST.md')
    unlisted = [f for f in on_disk if f not in listed]
    missing  = [n for n in listed if not os.path.exists(os.path.join(a.dir,n))]

    for u in unlisted: stale.append('%s: ARTIFACT WITH NO ROW' % u)
    # It fires only when there IS a reviewer row to protect, so it cannot red a
    # manifest that has none.
    blocked = False
    if (history.startswith('NOT CHECKED') and not a.allow_unverified_history
            and any(n.startswith(REVIEWER_PREFIXES) for n in listed)):
        blocked = True
        stale.append('HISTORY NOT VERIFIED: the reviewer-row history is %s. The only witness'
                     ' left for a reviewer row is then the copy in the other directory, which'
                     ' the same hand writes, so nothing here can confirm what was received.'
                     ' Fetch the full history (`fetch-depth: 0`) and re-run, or pass'
                     ' --allow-unverified-history to accept that limit deliberately.' % history)
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
    print('manifest: %d artifact row(s) + the manifest itself; %d file(s) in %s;'
          ' reviewer-row history %s'
          % (len(listed), len(on_disk), a.dir, history))
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
