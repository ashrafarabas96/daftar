#!/usr/bin/env python3
"""The net over every SQL file this gate's runner LOADS, and its byte pin.

ROUND 30, F-4. The gate's closure for "no case may call the core helper
directly" was one literal over one glob:

    grep -lIF -e 'case_refuses_core' "$HERE"/p8-real-cases-*.sql

The coordinator's review walked around it twice, measured end to end on the
real baseline. (a) The name assembled at run time —
`'p8.case_refuses_' || 'core'` executed with `format()` — appears nowhere as
the literal, and reached the core with no witness, against a dead row. (b) A
four-line wrapper created in `p8-real-fixtures.sql`, which `build()` and
`cases()` both RUN and the glob never covered, reached it the same way.

So this program answers three questions the glob could not:

* WHICH files does the run load? Derived from the runner's own source — every
  `"$HERE/<name>.sql"` it mentions — and not from a pattern over a directory,
  because a pattern describes a directory while the run describes itself. A
  file the runner loads and this reader cannot find is a refusal by name.
* May a case or fixtures file reach the core? No, by three rules rather than
  one: the literal name, any DYNAMIC SQL (the only way to assemble a name),
  and any function CREATED in such a file (the only way to hide a wrapper
  behind another name). Each is refused BY NAME, and each is a claim: a case
  file has no business building SQL or defining functions, and no live file
  does either (measured, every round).
* Did the set MOVE while the run used it? The pin is the SHA-256 of
  `name<TAB>sha256` lines over the whole set. The runner takes it before the
  cases run and checks it again at the end, so a file swapped in between is a
  red rather than a silence.

It measures FILES, not behaviour, and says so: a case role may still reach the
core because the wrappers are not SECURITY DEFINER and the roles need EXECUTE
on them either way (`p8-case-helpers.sql` states that narrowing). What this
bounds is the SET of files the run can be given, by content and by reach.
"""
import hashlib
import os
import re
import sys

if not sys.flags.isolated:
    sys.stderr.write(
        "CASE NET FAIL: NOT ISOLATED — started without `-I`, so Python put this "
        "program's own directory, which is inside the tree under test, first on "
        "sys.path. Re-run as `python3 -I`\n")
    raise SystemExit(2)

CORE = "case_refuses_" + "core"          # never as one literal: this file is scanned too
# Every SQL file name the runner MENTIONS, however it mentions it. The first
# version of this reader looked for `"$HERE/<name>.sql"` and found six of the
# ten files in this directory, because the case files are loaded from a
# `role:file` list and named there without the `$HERE` prefix — the same
# one-spelling mistake the glob made, one layer up. So every `*.sql` token is
# read and kept if it names a file in the runner's own directory; migration
# names, which live elsewhere, drop out by that test.
SQL_REF = re.compile(r'([A-Za-z0-9._-]+\.sql)')
# A case or fixtures file may carry neither of these. The words are matched
# outside comments and string literals, because a payload that merely contains
# the word is not a statement (round 30, W-4, learned on the other side of this
# same question).
DYNAMIC = re.compile(r'(^|[^a-z_])execute([^a-z_]|$)', re.I)
CREATES = re.compile(r'(^|[^a-z_])create\s+(or\s+replace\s+)?function($|[^a-z_])', re.I)


def strip_sql(t):
    t = re.sub(r'/\*.*?\*/', ' ', t, flags=re.S)
    t = re.sub(r'--[^\n]*', ' ', t)
    t = re.sub(r"'(''|[^'])*'", ' ', t)
    # Dollar-quoted bodies are deliberately NOT stripped. A case file passes its
    # statements as `$q$ … $q$`, and a plant hides in exactly such a block: the
    # first version of this reader stripped them and let the coordinator's own
    # F-4a plant through, measured on the first run that carried this arm. The
    # cost is that a dollar-quoted PAYLOAD containing one of these words would
    # red; no live file has one, and if one ever does it gets a declaration.
    return t


def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def pin_of(pairs):
    body = "".join("%s\t%s\n" % (n, d) for n, d in pairs)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def read_set(runner):
    src = open(runner, encoding="utf-8").read()
    here = os.path.dirname(os.path.abspath(runner))
    names = sorted({n for n in set(SQL_REF.findall(src))
                    if os.path.exists(os.path.join(here, n))})
    # And the other direction: a case or fixtures file sitting in this directory
    # that the runner does NOT name. It cannot run, so it is not a reach hole —
    # it is an unexercised claim, of exactly the kind this phase refuses to
    # leave standing, so it is named rather than ignored.
    stray = sorted(n for n in os.listdir(here)
                   if n.endswith(".sql") and n not in names
                   and (n.startswith("p8-real-cases-")
                        or n.startswith("p8-real-fixtures")))
    if stray:
        sys.stderr.write(
            "CASE NET FAIL: A CASE OR FIXTURES FILE THE RUNNER DOES NOT LOAD — "
            "%s sits beside the files this run uses and is named nowhere in the "
            "runner, so nothing exercises it and nothing says why it is here\n"
            % ", ".join(stray))
        raise SystemExit(1)
    if not names:
        sys.stderr.write(
            "CASE NET FAIL: THE RUNNER NAMES NO SQL FILE — this reader derives "
            "the set from the runner's own source, and found nothing, so it is "
            "reading the wrong file or the runner's spelling has moved\n")
        raise SystemExit(1)
    return names


def main(argv):
    if len(argv) == 3 and argv[1] == "--pin":
        runner, want = argv[2], None
    elif len(argv) == 4 and argv[1] == "--pin":
        runner, want = argv[2], argv[3]
    elif len(argv) == 2:
        runner, want = argv[1], None
    else:
        sys.stderr.write("CASE NET FAIL: usage: p8-case-net.py <runner> | "
                         "p8-case-net.py --pin <runner> [<expected-pin>]\n")
        return 1
    here = os.path.dirname(os.path.abspath(runner))
    names = read_set(runner)
    pairs, missing = [], []
    for n in names:
        p = os.path.join(here, n)
        if not os.path.exists(p):
            missing.append(n)
        else:
            pairs.append((n, sha(p)))
    if missing:
        sys.stderr.write(
            "CASE NET FAIL: A FILE THE RUNNER LOADS IS MISSING — the runner "
            "names %s and this directory does not hold it, so the set this "
            "program pins is not the set the run uses\n" % ", ".join(missing))
        return 1
    pin = pin_of(pairs)
    if want is not None:
        if pin != want:
            moved = "; ".join("%s=%s" % (n, d[:12]) for n, d in pairs)
            sys.stderr.write(
                "CASE NET FAIL: THE FILE SET MOVED DURING THE RUN — the pin "
                "taken before the cases ran was %s and the same set now "
                "digests to %s, so a file the run loads was changed while it "
                "was being used. Now: %s\n" % (want, pin, moved))
            return 1
        sys.stdout.write("CASE NET PIN: %d files, unchanged at %s\n" % (len(pairs), pin))
        return 0
    if argv[1] == "--pin":
        sys.stdout.write("%s\n" % pin)
        return 0

    bad = []
    for n, _ in pairs:
        subject = n.startswith("p8-real-cases-") or n.startswith("p8-real-fixtures")
        if not subject:
            continue
        text = strip_sql(open(os.path.join(here, n), encoding="utf-8").read())
        if CORE in text:
            bad.append("A DIRECT CORE CALL in %s: the core helper is named in a "
                       "file the run loads as a case or fixture" % n)
        if DYNAMIC.search(text):
            bad.append("DYNAMIC SQL in %s: a case or fixtures file may not build "
                       "SQL, because a built name is a name this net cannot read "
                       "(F-4a)" % n)
        if CREATES.search(text):
            bad.append("A FUNCTION CREATED in %s: a wrapper defined here would "
                       "reach the core under a name this net does not know "
                       "(F-4b)" % n)
    if bad:
        sys.stderr.write("CASE NET FAIL: " + "; ".join(bad) + "\n")
        return 1
    subjects = [n for n, _ in pairs
                if n.startswith("p8-real-cases-") or n.startswith("p8-real-fixtures")]
    sys.stdout.write(
        "CASE NET: %d SQL files are loaded by this runner, derived from its own "
        "source; of them %d are case or fixtures files, and none names the core "
        "helper, builds SQL or creates a function. Set pinned at %s\n"
        % (len(pairs), len(subjects), pin))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
