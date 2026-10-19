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
          ' (`git --git-dir=<dir> rev-parse --git-dir`, rc 0)')


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


def classify_dirs(root, dirs, gitq):
    """-> (kept, excluded, refusals). gitq(path) answers True / False / None."""
    kept, excluded, refusals = [], [], []
    for d in sorted(dirs):
        p = os.path.join(root, d)
        verdict = gitq(p)
        if verdict is None:
            refusals.append('UNCLASSIFIED DIRECTORY: %s — git could not be asked whether this is a'
                            ' repository, so whether its files are inside this pack\'s domain is'
                            ' UNDECIDED and nothing here is a verdict about them. The directory'
                            ' stays in the domain and this refusal stands.' % p)
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
    for r, dirs, files in os.walk(root):
        kept, exc, ref = classify_dirs(r, dirs, gitq)
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
                try:
                    tgt = os.readlink(ap)
                except OSError as exc:
                    tgt = '<unreadable: %s>' % exc
                refusals.append('SYMBOLIC LINK IN THE PACK: %s names %s. A link is neither the'
                                ' file it points at nor content of its own, and a dangling one'
                                ' cannot be read at all, so it is refused by name rather than'
                                ' followed, digested or skipped.' % (rel, tgt))
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
        b = open(ap, 'rb').read()
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
