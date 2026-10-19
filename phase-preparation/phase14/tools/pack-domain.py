# Phase 14 — the ONE enumeration of this pack's domain, shared by all THREE
# instruments.
#
# CHALLENGE R27-P1-01, a FAIL-OPEN, and the coordinator's ruling that followed
# it: `manifest-digests.py` and `retracted-claims.py` pruned a repository
# directory by STRUCTURE while `citation-provenance.py` pruned it by NAME
# (`d != '.git'`). Round 26 had written "two instruments reading one directory
# must enumerate the same domain" and then proved the sentence against the two
# tools it was thinking of. The pack has three. Measured by the challenger and
# reproduced here before anything was changed: with
# `zz-hide/{HEAD, objects/, refs/, zz-doc.md}` planted, `manifest-digests.py
# --check` answered rc 0 and printed "every file has a row" while a pack
# document sat in the tree with no row anywhere; `retracted-claims.py` stayed at
# 42 documents; and `citation-provenance.py --write` moved a figure PUBLISHED
# for that SHA from 42 to 43 document(s) and made the planted file the named
# source of a provenance row. Three published figures, two domains, and the pin
# was the one that could not see.
#
# So the domain lives HERE, once. Every instrument loads this file by path and
# REFUSES unless its sha256 equals a literal pinned in that instrument, then
# execs it: no instrument can drift from another, and an edited domain refuses
# in all three until each pin is updated deliberately. The file is also inside
# the `tools/` declared subtree, so the handoff manifest pins its bytes too.
#
# What is excluded, and it is said in every instrument's own population
# sentence: the contents of a directory that GIT ITSELF accepts as a repository
# (the handoff manifest's exclusion of itself is that tool's alone, and that tool
# prints it). The test
# is `git --git-dir=<dir> rev-parse --git-dir`, asked through the calling
# instrument's own hardened git runner, because:
#   * structure was too weak -- the challenger's cheapest forgery was three
#     entries with an EMPTY `HEAD`, which git rejects (rc 128) and a
#     HEAD/objects/refs test accepts;
#   * spelling was weaker still -- a directory merely CALLED `x.git` is not a
#     repository and stays in the domain;
#   * and a directory git cannot be asked about is NOT silently decided either
#     way: it stays in the domain AND the run carries a named refusal, because
#     this pack's standing rule is to refuse what it cannot classify.
# The residual this leaves is named and not claimed as closed: a file inside a
# REAL repository directory inside the pack is pinned by no instrument of this
# pack. All three now skip it identically, so no published figure moves and no
# two figures disagree -- and that is exactly why the sentence "this manifest
# pins this pack" is still not made anywhere in it.
import os, hashlib

# The sentence below is the SHARED domain, and it carries no exclusion that is
# not shared: the handoff manifest's "a file cannot carry its own digest" belongs
# to `manifest-digests.py` and is printed BY that tool next to this sentence,
# because `retracted-claims.py` reads the manifest's prose (that is the file
# round 7 found a retracted claim surviving in) and must not print a population
# sentence that says it was skipped. One false clause in a shared string would be
# a false sentence in three outputs.
DOMAIN = ('EVERY file under the pack directory, at any depth, in any extension and in any case,'
          ' excluding only the contents of a directory that git itself accepts as a repository'
          ' THAT OWNS AT LEAST ONE GIT OBJECT OF ITS OWN (`git --git-dir=<dir> rev-parse'
          ' --git-dir`, `rev-parse --verify HEAD^{commit}` and a non-zero loose+packed count from'
          ' `count-objects -v`, all three); a symbolic link of any kind, a'
          ' directory that cannot be read and anything that is not a regular file are REFUSED by'
          ' name rather than digested, followed or skipped')


def _unnameable(rel):
    # CHALLENGE R27-P2-01: a record of the form "<digest>  <relpath>\n" is not
    # injective, because a FILENAME MAY CONTAIN A NEWLINE. The challenger built
    # it: a tree of two files {a: 11 bytes, b: 0 bytes} and a tree of ONE file
    # named "a\n<sha256 of empty>  b" holding the same 11 bytes produce the same
    # digest AND the same byte total, so "an added, removed, renamed or edited
    # file moves this digest" was measured FALSE. Reproduced here before the fix:
    # both trees hash 73c805c216a6. Two changes answer it -- the file COUNT is
    # now part of the digested text, and a name that cannot be carried by a
    # line-based record is REFUSED rather than digested. Refusing is what keeps
    # the published `find | sort | sha256sum` recipe faithful: the shapes that
    # would make the shell and the tool disagree cannot reach the digest.
    if '\0' in rel:
        return 'a NUL byte'
    if '\n' in rel or '\r' in rel:
        return 'a newline or carriage return'
    return None


def _link_refusal(rel, ap, kind):
    # CHALLENGE R28-P1-01, a FAIL-OPEN, and the coordinator's ruling: round 27
    # wrote "A link is neither the file it points at nor content of its own ...
    # so it is refused by name rather than followed, digested or skipped" and
    # then refused links only where `walk` iterates FILES. `os.walk` does not
    # descend into a symlink to a DIRECTORY and does not list it among files, so
    # that one shape was skipped in SILENCE -- measured by the challenger and
    # reproduced here before the fix: `zz-link -> <an existing directory>` left
    # `manifest-digests.py --check` at rc 0 printing "every file has a row",
    # `81 file(s) at the top level` unchanged, `0 directory(ies) ... excluded`,
    # and the string `zz-link` absent from all three instruments' output; inside
    # `proofs/` it left `55 file(s) under 2 declared subtree(s)` and that row's
    # digest unmoved. It defeats an ENFORCEMENT and not only a pin: a document
    # behind the link carrying a claim from `RETRACTED-CLAIMS.tsv` gave
    # `retracted-claims.py --check` rc 0, where the same bytes at the top level
    # give rc 1 `RETRACTED CLAIM PRESENT`. Two arms covering the two shapes a
    # reviewer named were read as covering the variants of the shape they name:
    # this pack's own lesson, and it cost a round. The refusal is now ONE
    # sentence reached from BOTH branches of the walk, and it says which kind of
    # link it found so the two branches cannot drift apart again.
    try:
        tgt = os.readlink(ap)
    except OSError as exc:
        tgt = '<unreadable: %s>' % exc
    return ('SYMBOLIC LINK IN THE PACK: %s names %s (a link to a %s). A link is neither the thing'
            ' it points at nor content of its own, a dangling one cannot be read at all, and a'
            ' link to a directory is not descended into — so it is refused by name rather than'
            ' followed, digested or skipped.' % (rel, tgt, kind))


def classify_dirs(root, dirs, gitq, relof=None):
    """-> (kept, excluded, refusals). gitq(path) answers True / False / None.

    `relof(path)` names a path the way the caller's refusals name one; without it
    the absolute path is used."""
    kept, excluded, refusals = [], [], []
    for d in sorted(dirs):
        p = os.path.join(root, d)
        nm = relof(p) if relof else p
        # BEFORE git is asked anything: a link is refused by name, whatever it
        # points at. Asking git first would let a link to a repository be
        # EXCLUDED rather than refused, which is the same hole one step along.
        if os.path.islink(p):
            refusals.append(_link_refusal(nm, p, 'directory'))
            continue
        # The ruling's sweep for "any other shape the walk does not descend
        # into": a directory whose entries cannot be listed. `os.walk` reports
        # the error to its `onerror` handler, which this pack did not set, and
        # then yields NOTHING for it -- invisible exactly as the link was.
        try:
            os.listdir(p)
        except OSError as exc:
            refusals.append('UNREADABLE DIRECTORY IN THE PACK: %s cannot be listed (%s: %s), so'
                            ' what it holds is UNDECIDED and nothing here is a verdict about it.'
                            ' It is refused by name rather than walked past.'
                            % (nm, type(exc).__name__, exc))
            continue
        verdict = gitq(p)
        if verdict is None:
            refusals.append('UNCLASSIFIED DIRECTORY: %s — git could not be asked whether this is a'
                            ' repository, so whether its files are inside this pack\'s domain is'
                            ' UNDECIDED and nothing here is a verdict about them. The directory'
                            ' stays in the domain and this refusal stands.' % nm)
            kept.append(d)
        elif verdict:
            excluded.append(p)
        else:
            kept.append(d)
    return kept, excluded, refusals


def walk(root, gitq):
    """Every file in the domain, sorted by path: (entries, excluded, refusals).

    entries are (relpath-with-forward-slashes, absolute path)."""
    entries, excluded, refusals = [], [], []
    def _rel(ap):
        return os.path.relpath(ap, root).replace(os.sep, '/')
    # `os.walk` swallows a listing error unless a handler is given, and a
    # swallowed error is a directory that reports nothing -- the shape of
    # R28-P1-01. The top of the walk is also covered here; the handler is the
    # only place an error on `root` itself can be seen.
    def _onerror(exc):
        refusals.append('DIRECTORY COULD NOT BE WALKED: %s (%s: %s), so what it holds is UNDECIDED'
                        ' and nothing here is a verdict about it.'
                        % (getattr(exc, 'filename', '<unknown>'), type(exc).__name__, exc))
    # CHALLENGE R29-P2-02 (P2): `classify_dirs` refuses a link BEFORE asking git,
    # which is right, but `os.walk` then makes its OWN descent-time decision, and
    # between the two the answer can change. The challenger swapped a directory
    # for a link mid-walk: of 30 runs, 16 refused by name, 2 found the moved
    # copy, FOUR ended rc 0 saying nothing about the directory -- R28-P1-01's
    # silent skip handed back -- and the rest ended rc 1 with an unhandled
    # FileNotFoundError, which is this gate's STALE code. Reachable rather than
    # theoretical: three lanes read a shared folder every session writes.
    # `followlinks=True` removes the second decision: whatever the path is at
    # descent time, the walk ENTERS it, so a swap lands either on the explicit
    # link refusal above (which is kept, and is what makes this safe) or on real
    # rows that must be pinned -- never on silence. It cannot loop on a cycle
    # inside the pack, because a link is refused and never descended from.
    for r, dirs, files in os.walk(root, onerror=_onerror, followlinks=True):
        kept, exc, ref = classify_dirs(r, dirs, gitq, _rel)
        dirs[:] = kept
        excluded += exc
        refusals += ref
        for f in sorted(files):
            ap = os.path.join(r, f)
            rel = os.path.relpath(ap, root).replace(os.sep, '/')
            why = _unnameable(rel)
            if why is not None:
                refusals.append('UNNAMEABLE PATH under %s: a file name carries %s, which no'
                                ' line-based record can carry unambiguously, so it is REFUSED'
                                ' rather than digested. Rename the file.' % (root, why))
                continue
            # CHALLENGE R27-P3-02 and R27-P3-03: a symbolic link made the tool
            # and the published recipe disagree (the recipe follows it, the tool
            # digested the target), and a DANGLING one raised an unhandled
            # FileNotFoundError at rc 1 -- this gate's STALE code -- from inside
            # the digest. A link is neither the file it names nor content of its
            # own, so it is refused BY NAME, dangling or not, and the pack holds
            # none.
            if os.path.islink(ap):
                refusals.append(_link_refusal(rel, ap, 'file or dangling path'))
                continue
            # The rest of the ruling's sweep: `os.walk` lists a FIFO, a socket
            # and a device among `files`, and `open(ap,'rb').read()` on a FIFO
            # does not return. Anything that is not a regular file is content of
            # no kind this pack can digest, and it is refused by name rather
            # than read.
            try:
                _regular = os.path.isfile(ap) and not os.path.isdir(ap)
            except OSError:
                _regular = False
            if not _regular:
                refusals.append('NOT A REGULAR FILE IN THE PACK: %s is not a regular file (a FIFO,'
                                ' a socket, a device or something else that cannot be read as'
                                ' bytes), so it is refused by name rather than opened.' % rel)
                continue
            entries.append((rel, ap))
    entries.sort()
    return entries, excluded, refusals


def subtree_digest(d, gitq):
    """-> (digest, total_bytes, file_count, excluded, refusals).

    The digested text is `"<n> file(s)\\n"` followed by one `"<sha256>  <relpath>\\n"`
    line per file, sorted by relpath. The count is INSIDE the digest (R27-P2-01),
    and the shapes that would make a line-based record ambiguous are refused
    above rather than digested."""
    entries, excluded, refusals = walk(d, gitq)
    rows, total = [], 0
    for rel, ap in entries:
        # CHALLENGE R29-P2-02, the other half: a file enumerated by the walk and
        # GONE by the time it is read raised an unhandled OSError at rc 1, which
        # means STALE. A digest taken over a file that vanished under us is not a
        # digest of anything, so the read refuses BY NAME. The digest that comes
        # out will not match the row either -- it is taken over fewer files --
        # and that is the point: the refusal says WHY it does not match, instead
        # of a traceback at the code that means `stale`.
        try:
            b = open(ap, 'rb').read()
        except OSError as exc:
            refusals.append('FILE VANISHED OR COULD NOT BE READ: %s (%s: %s). It was enumerated by'
                            ' this walk and could not be read afterwards, so this digest covers a'
                            ' set this directory no longer holds and NOTHING here is a verdict'
                            ' about it. Re-run when nothing else is writing the directory.'
                            % (rel, type(exc).__name__, exc))
            continue
        rows.append('%s  %s\n' % (hashlib.sha256(b).hexdigest(), rel))
        total += len(b)
    text = ('%d file(s)\n' % len(rows)) + ''.join(rows)
    return hashlib.sha256(text.encode()).hexdigest(), total, len(rows), excluded, refusals


def enumerate_pack(root, manifest_basename, gitq):
    """-> (top_level_files, {first_level_dir+'/': [relpaths]}, excluded, refusals)."""
    entries, excluded, refusals = walk(root, gitq)
    top, sub = [], {}
    for rel, _ap in entries:
        if '/' not in rel:
            if rel == manifest_basename or rel == 'P14-HANDOFF-MANIFEST.md':
                continue
            top.append(rel)
        else:
            sub.setdefault(rel.split('/')[0] + '/', []).append(rel)
    return top, sub, excluded, refusals


def reviewer_reports(d, prefixes, gitq):
    """Every reviewer-prefixed file in the domain, at any depth, in any case.

    CHALLENGE R27-P3-06: `--reports-in-tree` enumerated its own directory with
    `os.listdir` and a case-sensitive prefix test, which is R26-P1-01's defect
    inside the fix for R26-P3-02 -- `p14-challenge-zzzzzzz.md` and
    `sub/P14-CHALLENGE-zzzzzzz.md` both answered rc 0."""
    entries, excluded, refusals = walk(d, gitq)
    low = tuple(p.lower() for p in prefixes)
    names = sorted(rel for rel, _ap in entries
                   if os.path.basename(rel).lower().startswith(low))
    return names, excluded, refusals
