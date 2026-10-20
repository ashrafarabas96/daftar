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


DOLLAR_TAG = re.compile(r'\$(?:[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)?\$')


def sql_scan(t, keep_dollar=False, keep_strings=False):
    """Remove comments and blank out literals the way PostgreSQL LEXES them.

    ROUND 31, the coordinator's blocking finding. Every text law in this gate
    read its statement through one regex over single quotes,
    `'(''|[^'])*'`, and PostgreSQL has more than one string syntax. One
    apostrophe inside a DOLLAR-QUOTED body is read by that regex as the START
    of a literal, so everything from it to the next quote vanishes from the
    text the law reads: measured, `UPDATE n SET k = $n$a'b$n$ WHERE id = '…'`
    strips to `UPDATE n SET k = $n$a 0fff-dead'` and the law never sees WHERE.
    Three laws were blind at once, because three laws read one stripper.

    So the regress ends where it has ended before in this phase: in the thing
    itself. This is a character scanner that follows the same five rules the
    server's own lexer follows — `--` to end of line, `/* */` NESTED, `'…'`
    with doubled quotes, `E'…'` with backslash escapes, and `$tag$…$tag$` —
    and consumes each construct whole, so no shift inside one can change where
    another begins. A quoted "identifier" is consumed and KEPT, because it
    names a thing rather than carrying a value, and an apostrophe inside one
    would otherwise desync everything after it.

    With keep_strings every literal is kept verbatim and only comments go:
    that is what the row form RUNS, so the statement executed is the statement
    the laws read. With keep_dollar, dollar-quoted BODIES are kept. The
    handler ban needs them: `DO $d$ … EXCEPTION … $d$` carries its handler inside dollar
    quotes, and that is the shape the ban exists for. Every other law blanks
    them, because to those a dollar-quoted body is a VALUE. The delimiters are
    consumed identically either way, which is the part that was wrong.

    An unterminated construct consumes to end of input. That can only hide
    text from a law, never reveal it, so it can only make a refusal more
    likely — and `assert_balanced` below refuses it outright.
    """
    out = []
    i, n = 0, len(t)
    while i < n:
        c = t[i]
        if c == '-' and t.startswith('--', i):
            j = t.find('\n', i)
            out.append(' ')
            i = n if j < 0 else j
            continue
        if c == '/' and t.startswith('/*', i):
            depth, i = 1, i + 2
            while i < n and depth:
                if t.startswith('/*', i):
                    depth, i = depth + 1, i + 2
                elif t.startswith('*/', i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            out.append(' ')
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if t[j] == '"':
                    if t.startswith('""', j):
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append(t[i:j])
            i = j
            continue
        if c == "'" or (c in 'Ee' and t.startswith("'", i + 1)
                        and not (i and (t[i - 1].isalnum() or t[i - 1] == '_'))):
            esc = c in 'Ee'
            j = i + 2 if esc else i + 1
            while j < n:
                if esc and t[j] == '\\':
                    j += 2
                    continue
                if t[j] == "'":
                    if t.startswith("''", j):
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append(t[i:j] if keep_strings else ' ')
            i = j
            continue
        if c == '$':
            m = DOLLAR_TAG.match(t, i)
            if m:
                tag = m.group(0)
                k = t.find(tag, m.end())
                if k < 0:
                    out.append(t[i:] if keep_strings else ' ')
                    i = n
                    continue
                if keep_strings:
                    out.append(t[i:k + len(tag)])
                elif keep_dollar:
                    # ROUND 31: the body is RE-SCANNED with the same rules, not
                    # copied. A kept body that is not read the way the top
                    # level is read is a second reading again: the statement
                    # `DO $d$ … EXECUTE 'DO $x$ … EXCEPTION … $x$' … $d$` must
                    # show the handler ban its EXECUTE and must NOT show it the
                    # word inside that literal, which is a payload. Nested
                    # dollar bodies stay visible, which is what the ban is for.
                    out.append(' %s ' % sql_scan(t[m.end():k], keep_dollar=True))
                else:
                    out.append(' ')
                i = k + len(tag)
                continue
        out.append(c)
        i += 1
    return ''.join(out)


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
    # ROUND 31, SCANNER-AGREE. Two implementations of one language that can
    # drift apart are two languages, and the defect this round answers is a
    # reading that had drifted from the server's own lexing. This mode prints
    # the scanner's three readings of every corpus line; the gate runs the
    # same corpus through `p8.sql_scan` in the database and requires the two
    # outputs to be byte-identical. Input and output are hex, so that no
    # escaping convention sits between the two readings being compared.
    if len(argv) == 3 and argv[1] == "--scan":
        for line in open(argv[2], encoding="utf-8"):
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            lab, t = parts[0], bytes.fromhex(parts[1]).decode("utf-8")
            for mode, out in (("strip", sql_scan(t)),
                              ("dollar", sql_scan(t, keep_dollar=True)),
                              ("exec", sql_scan(t, keep_strings=True))):
                sys.stdout.write("%s\t%s\t%s\n"
                                 % (lab, mode, out.encode("utf-8").hex()))
        return 0
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
        raw = open(os.path.join(here, n), encoding="utf-8").read()
        # The scan keeps DOLLAR-QUOTED bodies (re-scanned, not copied),
        # because a plant hides in exactly such a block: the first version
        # of this reader stripped them and let the coordinator's own F-4a
        # plant through, measured on the first run that carried this arm.
        text = sql_scan(raw, keep_dollar=True)
        # ROUND 31, the coordinator's §3(a). Round 30 replaced round 29's
        # `grep -lIF` with this reader, and for the LITERAL spelling the
        # replacement was measurably WEAKER than what it replaced: one
        # apostrophe inside a dollar-quoted body hid the name from the
        # stripper, and the program printed "none names the core helper"
        # about a file that named it. The grep could not be fooled that way,
        # because a literal substring search does not parse at all.
        #
        # So the literal is read BOTH ways and either one refuses. The raw
        # reading cannot be blinded by any quoting; the scanned reading is
        # what lets a payload mention the name in a comment without a false
        # red. A reader that replaces an older check inherits the older
        # check's floor.
        if CORE in text or CORE in raw:
            bad.append("A DIRECT CORE CALL in %s: the core helper is named in a "
                       "file the run loads as a case or fixture%s" %
                       (n, "" if CORE in text else " (found in the raw bytes; the "
                        "scanned reading did not see it, so the file is quoting "
                        "around the net)"))
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
