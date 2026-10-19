"""The harness's own bytes, pinned OUTSIDE the harness and read by a reader
that shares no code with it.

WHY THIS FILE EXISTS. Rounds 11 to 20 closed eight escapes one shape at a time:
a second test outside a guard, a helper that returns a listed pair, a method
name on a receiver of the planter's own, a rebound module attribute, an
argument added inside an admitted call. Each fix was a rule about a SHAPE
inside four parsed functions, and the coordinator's twenty-first review walked
out through a shape no rule covers at all -- a DEFAULT ARGUMENT:

    -def scan(docs_dir, harness_dir, quiet=False, skip=()):
    +def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):

`_main` calls `scan()` with no `skip`, so that one line switches a named guard
off for every real run, and the figure check returned 0 with a fabricated
figure committed. It was outside the decision parse (`scan` is not one of the
four functions it reads), outside the constants digest (which hashes body
literals, not defaults), and outside every rule key. Patching it would have
bought the next round the same escape through another line of the same file.

So the coordinator's ruling, and this file is it: stop pinning shapes inside
the file and pin THE FILE. Every byte of every executable file in the harness
is digested and compared with a value held outside the harness -- a row in
`prep/phase11/P11-HANDOFF-MANIFEST.md`, which is a document under review --
and a difference is a NAMED REFUSAL. That covers defaults, `scan`, the regex
flags the review left as a residual, `_fold_digits`, and every self-edit
nobody has thought of yet, in one law instead of a rule per shape.

WHY A SECOND READER. A file cannot be the authority on its own bytes: the edit
that moves the bytes can delete the comparison in the same stroke. This reader
shares NO CODE with `check_fenced_figures.py` -- it imports nothing from it,
parses nothing it parses, and its own bytes are pinned by a row of the same
table, so editing this file to lie moves its own pin. It imports `hashlib`,
`os` and `sys` and nothing else.

THE ONE LIMIT, stated where the law is: an edit that changes a harness file AND
its pinned row in the same commit is bounded only by REVIEW. That is not a hole
this instrument can close -- a pin inside the thing it pins is not a pin -- and
it is the reason the chain is author, independent challenger, coordinator, with
the diff read by someone who did not write it.

Run it as `python3 -I check_harness_bytes.py`. `--emit` prints the table to
paste into the manifest after a deliberate change, exactly as a generated block
is regenerated. Exit 0 = every file matches its row; exit 5 = a named refusal.
"""

import sys

if not sys.flags.isolated:
    sys.stderr.write(
        "HARNESS-BYTES-NOT-ISOLATED: this reader must run under `python3 -I`. Without "
        "it the interpreter puts the script's own directory on `sys.path`, and the "
        "directory it reads is the harness it is pinning -- a planted `hashlib.py` "
        "beside the subject would be imported by the instrument measuring the "
        "subject. Refusing instead of re-executing, because a re-exec would read the "
        "target a second time.\n"
    )
    raise SystemExit(5)

import hashlib
import os

MARK_OPEN = "<!-- P11-HARNESS-BYTES-PIN v1 BEGIN -->"
MARK_CLOSE = "<!-- P11-HARNESS-BYTES-PIN v1 END -->"

# What is pinned: every file the harness EXECUTES or is executed against.
# Evidence transcripts (`.txt`) are not pinned -- they are outputs, they are
# published with their own digests, and a run writes them.
PINNED_SUFFIXES = (".py", ".sh", ".sql")


def _here():
    return os.path.dirname(os.path.realpath(__file__))


def _subject_files(harness_dir):
    """Every pinned file under `harness_dir`, by path relative to it.

    `followlinks=True`: a symlinked subdirectory is a directory this walk must
    descend into, or a file reachable by the harness is invisible to the pin.
    """
    out = []
    for root, dirs, names in os.walk(harness_dir, followlinks=True):
        dirs.sort()
        for n in sorted(names):
            if n.endswith(PINNED_SUFFIXES):
                full = os.path.join(root, n)
                out.append(os.path.relpath(full, harness_dir))
    return sorted(out)


def _digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 16)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def read_pin(pin_path):
    """(rows, refusals). `rows` maps a relative path to its pinned digest."""
    if not os.path.isfile(pin_path):
        return {}, (
            "HARNESS-PIN-UNREADABLE: the pinned table lives at %s and there is no file "
            "there, so this run has nothing to compare the harness with" % pin_path,
        )
    with open(pin_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if text.count(MARK_OPEN) != 1 or text.count(MARK_CLOSE) != 1:
        return {}, (
            "HARNESS-PIN-UNREADABLE: %s carries %d opening and %d closing markers for "
            "the pin table and exactly one of each is required -- two tables mean a "
            "reader and a planter can be reading different ones"
            % (pin_path, text.count(MARK_OPEN), text.count(MARK_CLOSE)),
        )
    body = text.split(MARK_OPEN, 1)[1].split(MARK_CLOSE, 1)[0]
    rows = {}
    msgs = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("```"):
            continue
        parts = line.split()
        if len(parts) != 2 or len(parts[0]) != 64:
            msgs.append(
                "HARNESS-PIN-UNREADABLE: %r inside the pin table is not `<sha256> "
                "<path>` -- a row this reader cannot parse is a row it would otherwise "
                "skip, and skipping is how a file leaves the pin" % raw
            )
            continue
        try:
            int(parts[0], 16)
        except ValueError:
            msgs.append(
                "HARNESS-PIN-UNREADABLE: %r is not a hexadecimal digest" % parts[0]
            )
            continue
        if parts[1] in rows:
            msgs.append(
                "HARNESS-PIN-UNREADABLE: `%s` has two rows in the pin table, so which "
                "digest it is pinned to depends on the order a reader reads"
                % parts[1]
            )
            continue
        rows[parts[1]] = parts[0]
    if not rows and not msgs:
        msgs.append(
            "HARNESS-PIN-UNREADABLE: the pin table in %s is empty, and an empty table "
            "pins nothing while reading as a table" % pin_path
        )
    return rows, tuple(msgs)


def check(harness_dir=None, pin_path=None):
    """(ok, refusals) for the harness's own bytes against the external pin."""
    harness_dir = harness_dir or _here()
    if pin_path is None:
        pin_path = os.path.join(
            os.path.dirname(harness_dir.rstrip(os.sep)), "P11-HANDOFF-MANIFEST.md"
        )
    rows, msgs = read_pin(pin_path)
    msgs = list(msgs)
    if msgs:
        return False, tuple(msgs)
    found = _subject_files(harness_dir)
    for rel in found:
        full = os.path.join(harness_dir, rel)
        if rel not in rows:
            msgs.append(
                "HARNESS-FILE-UNPINNED: `%s` is a harness file this run can execute and "
                "the pin table has no row for it. A file with no row is a file whose "
                "bytes nothing checks, which is the whole of what this law closes"
                % rel
            )
            continue
        try:
            got = _digest(full)
        except OSError as exc:
            msgs.append(
                "HARNESS-UNREADABLE: `%s` is pinned and could not be read (%s), so this "
                "run cannot say whether its bytes moved" % (rel, exc)
            )
            continue
        if got != rows[rel]:
            msgs.append(
                "HARNESS-BYTES-MOVED: `%s` digests to %s and the pin table holds %s. "
                "Any edit to a harness file moves this digest -- a changed default "
                "argument, a flag added to a compiled pattern, a transformer that "
                "returns early, a deleted comparison -- so the bytes are refused "
                "rather than parsed shape by shape. If the change was deliberate, run "
                "`python3 -I check_harness_bytes.py --emit` and commit the table it "
                "prints in the same commit as the change" % (rel, got, rows[rel])
            )
    for rel in sorted(set(rows) - set(found)):
        msgs.append(
            "HARNESS-FILE-ABSENT: the pin table has a row for `%s` and no such file is "
            "under the harness. A pinned file that is gone fails this check BY "
            "ABSENCE, because deleting an instrument is a way of silencing it" % rel
        )
    return not msgs, tuple(msgs)


def emit(harness_dir=None):
    harness_dir = harness_dir or _here()
    lines = [MARK_OPEN, "```"]
    for rel in _subject_files(harness_dir):
        lines.append("%s  %s" % (_digest(os.path.join(harness_dir, rel)), rel))
    lines.append("```")
    lines.append(MARK_CLOSE)
    return "\n".join(lines) + "\n"


def _main(argv):
    harness_dir = None
    pin_path = None
    want_emit = False
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a == "--emit":
            want_emit = True
        elif a == "--harness" and rest:
            harness_dir = rest.pop(0)
        elif a == "--pin" and rest:
            pin_path = rest.pop(0)
        else:
            sys.stderr.write("usage: --emit | [--harness DIR] [--pin MANIFEST]\n")
            return 2
    if want_emit:
        sys.stdout.write(emit(harness_dir))
        return 0
    ok, msgs = check(harness_dir, pin_path)
    if ok:
        n = len(_subject_files(harness_dir or _here()))
        print("HARNESS-BYTES-PIN OK: %d harness files match the table in the manifest" % n)
        return 0
    for m in msgs:
        print("REFUSED: %s" % m)
    return 5


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
