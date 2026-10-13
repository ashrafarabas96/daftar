#!/bin/sh
# R15-01 red proof: the generator pin must not be forgeable with `git replace`.
#
# The finding this proves closed: `git replace` installs a per-repository
# redirection that rewrites what EVERY read of an object returns. The pin hashes
# the bytes it is running from and compares them with the blob at the subject
# commit, so a reviewer handed a clone carrying `refs/replace/<blob>` got the
# gate printing
#
#     the generator is PINNED: the bytes running here hash to <h>, which is
#     `docs/phase13/regenerate-manifest.py` at <sha>
#
# while a patched generator ran. Every clause of that sentence was false.
#
# Three arms, each asserted, and the third is the one that matters: it DELETES
# the guard and requires the forgery to succeed again. A guard whose removal
# changes nothing was never doing the work.
#
# It needs no pack: the pack lives off Git, so this proof drives the pinning code
# path directly out of the repository.
#
#   usage: sh docs/phase13/proofs/r15-replace-ref-proof.sh [<subject sha>]
#          (default: HEAD of the repository this script is run in)
#
# Exits 0 only if all three arms hold. Every arm prints the sentence it asserted
# on, so a reader checks the wording and not just the verdict.

set -eu

SRC=$(cd "$(dirname "$0")/../../.." && pwd)
SUBJECT=${1:-$(git -C "$SRC" --no-replace-objects rev-parse HEAD)}
GEN_IN_REPO=docs/phase13/regenerate-manifest.py
WORK=$(mktemp -d "${TMPDIR:-/tmp}/r15-replace-ref.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "subject commit : $SUBJECT"
echo "source worktree: $SRC"
echo "scratch        : $WORK"
echo

# A clone of its own, because the attack IS a property of the repository the
# reviewer is handed, and because planting a replace ref in someone's real
# worktree is not a thing a proof may do.
git clone --no-hardlinks -q "$SRC" "$WORK/repo"
git -C "$WORK/repo" checkout -q "$SUBJECT"

# The driver calls the pinning code path itself and prints what it returns, so
# the sentences asserted below are the gate's own, not this script's.
cat > "$WORK/driver.py" <<'PY'
import importlib.util
import pathlib
import sys

gen, repo, subject = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
spec = importlib.util.spec_from_file_location('p13gate', gen)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.REPO = repo
ok, says = mod.pin_verdict(subject)
print(f'VERDICT ok={ok}')
print(f'SAYS {says}')
lister = getattr(mod, 'replace_refs', None)
if lister is None:
    print('REPLACE-REF-LISTING ABSENT from this build of the generator')
else:
    for entry in lister():
        print(f'REPLACE-REF {entry}')
PY

# Each arm runs the generator from a directory of its own, under its real
# name, so the sentence this proof asserts on is byte-for-byte the sentence a
# reviewer reads out of the gate -- including the file name inside it.
stage() {  # $1 = arm name, $2 = file to stage; echoes the staged path
    mkdir -p "$WORK/$1"
    cp "$2" "$WORK/$1/regenerate-manifest.py"
    echo "$WORK/$1/regenerate-manifest.py"
}

run_driver() {  # $1 = generator to run
    python3 "$WORK/driver.py" "$1" "$WORK/repo" "$SUBJECT"
}

fail() { echo; echo "PROOF FAILED: $1"; exit 1; }

# Negative assertions go through `if`, where errexit is suppressed by the
# standard rather than by a subtlety of and-or lists.
refute() {  # $1 = pattern that must NOT appear, $2 = file, $3 = message
    if grep -q "$1" "$2"; then fail "$3"; fi
}

# ---------------------------------------------------------------- arm 1: honest
echo "ARM 1 - the committed generator, in a clone with no replace refs."
HONEST=$(stage arm1-honest "$WORK/repo/$GEN_IN_REPO")
run_driver "$HONEST" > "$WORK/arm1.out"
sed 's/^/    /' "$WORK/arm1.out"
grep -q '^VERDICT ok=True' "$WORK/arm1.out" || fail "arm 1: the honest generator was not accepted"
grep -q 'is PINNED' "$WORK/arm1.out" || fail "arm 1: the honest generator did not report a pin"
refute '^REPLACE-REF ' "$WORK/arm1.out" "arm 1: a clean clone reported a replace ref"
echo "    OK: accepted, and nothing was disclosed because there was nothing to disclose."
echo

# ------------------------------------------------- the forgery, built once here
# The attacker's patch is a real one: it exempts a document from the digest walk,
# so that document can be changed without §3 moving.
cp "$WORK/repo/$GEN_IN_REPO" "$WORK/forged.py"
python3 - "$WORK/forged.py" <<'PY'
import pathlib
import sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
marker = 'def _exempt(path: Path) -> bool:\n'
if s.count(marker) != 1:
    raise SystemExit(f'{p}: expected exactly one `{marker.strip()}`; the proof needs updating')
i = s.index(marker) + len(marker)
p.write_text(s[:i] + "    if path.name == 'P13-SECRET-FIGURES.md':\n        return True\n" + s[i:],
             encoding='utf-8')
PY

plant() {  # $1 = file whose bytes replace the committed blob
    real=$(git -C "$WORK/repo" --no-replace-objects rev-parse "$SUBJECT:$GEN_IN_REPO")
    planted=$(git -C "$WORK/repo" hash-object -w "$1")
    [ -n "$planted" ] || fail "the plant produced no object"
    git -C "$WORK/repo" replace -f "$real" "$planted" >/dev/null
    echo "    planted refs/replace/$real -> $planted"
    echo "    a replace-respecting read of $GEN_IN_REPO at ${SUBJECT%"${SUBJECT#???????}"} now returns:"
    git -C "$WORK/repo" show "$SUBJECT:$GEN_IN_REPO" | sha256sum | sed 's/^/      /'
    echo "    the real object is:"
    git -C "$WORK/repo" --no-replace-objects show "$SUBJECT:$GEN_IN_REPO" | sha256sum | sed 's/^/      /'
}

# ------------------------------------------------- arm 2: the forgery is refused
echo "ARM 2 - the same clone, carrying refs/replace/<the generator blob>."
plant "$WORK/forged.py"
FORGED=$(stage arm2-forged "$WORK/forged.py")
run_driver "$FORGED" > "$WORK/arm2.out"
sed 's/^/    /' "$WORK/arm2.out"
grep -q '^VERDICT ok=False' "$WORK/arm2.out" || fail "arm 2: THE FORGERY PASSED - this is R15-01, open again"
grep -q 'is not the one committed at' "$WORK/arm2.out" || fail "arm 2: refused, but not by name"
grep -q 'the file is `regenerate-manifest.py` in this directory' "$WORK/arm2.out" \
    || fail "arm 2: the refusal did not name the file a reviewer is looking at"
refute 'is PINNED' "$WORK/arm2.out" "arm 2: the gate claimed a pin it had just refused"
grep -q '^REPLACE-REF refs/replace/' "$WORK/arm2.out" || fail "arm 2: the replace ref was not disclosed"
echo "    OK: refused BY NAME, and the replace ref is disclosed with its exact object ids."
echo

# ------------------------------- arm 3: delete the guard, the forgery must work
# Without this arm the fix is unfalsifiable: arm 2 would read the same if the
# refusal came from somewhere else entirely.
echo "ARM 3 - the guard DELETED from the forged generator, same plant."
python3 - "$WORK/forged.py" "$WORK/guardless.py" <<'PY'
import pathlib
import sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = src.read_text(encoding='utf-8')
flags = s.count('*GIT,')
envs = s.count('env=git_env()')
if not flags or not envs:
    raise SystemExit('the guard is not where this proof expects it; the proof needs updating')
s = s.replace('(*GIT, ', "('git', ").replace('[*GIT, ', "['git', ")
s = s.replace(', env=git_env()', '').replace('env=git_env(),', '')
s = s.replace('\n                             env=git_env())', ')')
if '*GIT,' in s or 'env=git_env()' in s.replace('def git_env()', ''):
    raise SystemExit('a guarded invocation survived the removal; the proof needs updating')
compile(s, str(dst), 'exec')
dst.write_text(s, encoding='utf-8')
print(f'    removed {flags} --no-replace-objects site(s) and {envs} environment site(s)')
PY
plant "$WORK/guardless.py"
GUARDLESS=$(stage arm3-guardless "$WORK/guardless.py")
run_driver "$GUARDLESS" > "$WORK/arm3.out"
sed 's/^/    /' "$WORK/arm3.out"
grep -q '^VERDICT ok=True' "$WORK/arm3.out" || fail "arm 3: removing the guard changed nothing, so arm 2 proves nothing about it"
grep -q 'is PINNED' "$WORK/arm3.out" || fail "arm 3: removing the guard changed nothing, so arm 2 proves nothing about it"
echo "    OK: with the guard gone the forgery succeeds again - it printed a PIN for a"
echo "    generator that is not the committed one. The guard is what refuses arm 2."
echo "    Note it still disclosed the replace ref while claiming the pin: a disclosure"
echo "    is not a guard."
echo
echo "ALL THREE ARMS HOLD at $SUBJECT"
