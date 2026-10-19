#!/bin/sh
# A-01 red proof: a repository may serve bytes that are NOT the object it names,
# and the generator pin must refuse when it does.
#
# The finding this proves closed, from the challenger's addendum to round 16:
# git does NOT verify a loose object's hash when it reads it -- only `fsck`
# does. So a store holding the generator blob loose can serve any bytes at all
# under the real blob's id. Reached through `.git/objects/info/alternates` that
# forges the pin with NO replacement anywhere:
#
#   * `rev-parse <sha>:<path>` still prints the id RECORDED IN THE TREE,
#   * `for-each-ref refs/replace/` is empty, so R15-01's disclosure says
#     something true and useless,
#   * the commit, the tree, the worktree, HEAD and the branch resolution are
#     all genuinely correct. This IS the right repository at the right commit.
#
# Only the bytes are not the object. R15-01's two guards are irrelevant, because
# there is no replacement to disable -- which is why this went straight through
# the round-15 fix, and why the author's written bound ("an alternate object
# store cannot substitute the blob ... substitution-by-hash needs a collision")
# was false: the reasoning holds only for a store that verifies what it serves.
#
# The remedy under test: read the id the TREE records, re-hash the bytes handed
# over as Git itself defines an object, sha1("blob <len>\0" + data), and refuse
# by name on mismatch.
#
# A-02, the challenger's NEXT addendum, then showed that the id this compares
# against was itself read from the store -- so this script is necessary and not
# sufficient, and `a02-object-chain-proof.sh` covers the tree and the commit. The
# two together are what the pin now rests on; this one keeps the blob case honest.
#
#   usage: sh docs/phase13/proofs/a01-object-integrity-proof.sh [<subject sha>]
#
# Four arms. The fourth deletes the re-hash check and requires BOTH forgeries to
# pass again; without it the other three cannot tell this guard from any other
# refusal.

set -eu

SRC=$(cd "$(dirname "$0")/../../.." && pwd)
SUBJECT=${1:-$(git -C "$SRC" --no-replace-objects rev-parse HEAD)}
GEN_IN_REPO=docs/phase13/regenerate-manifest.py
WORK=$(mktemp -d "${TMPDIR:-/tmp}/a01-object-integrity.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "subject commit : $SUBJECT"
echo "source worktree: $SRC"
echo

fail() { echo; echo "PROOF FAILED: $1"; exit 1; }
refute() { if grep -q "$1" "$2"; then fail "$3"; fi; }

# The clone and the checkout read objects too. If $SRC carried a replace ref, the
# clone would copy refs/replace/ and the checkout would lay down the replacement,
# so the proof would be built on top of the thing it is testing.
git --no-replace-objects clone --no-hardlinks -q "$SRC" "$WORK/src"
git -C "$WORK/src" --no-replace-objects checkout -q "$SUBJECT"

cat > "$WORK/drv.py" <<'PY'
import importlib.util
import pathlib
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('p13gate', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.REPO = pathlib.Path(sys.argv[2])
ok, says = mod.pin_verdict(sys.argv[3])
print(f'VERDICT ok={ok}')
print(f'SAYS {says}')
PY

# The prepared store: the five objects on the path to the generator blob, written
# LOOSE, so that one of them can later be rewritten under its own name. Built with
# Git's own object format and each id asserted, so the store is honest until it is
# deliberately made otherwise.
cat > "$WORK/build_store.py" <<'PY'
import hashlib
import pathlib
import subprocess
import sys
import zlib

src, subject, gen, store = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
store.mkdir(parents=True, exist_ok=True)

def g(*a):
    return subprocess.run(('git', '-C', src, '--no-replace-objects', *a),
                          capture_output=True, check=True).stdout

for spec in (subject, f'{subject}^{{tree}}', f'{subject}:docs',
             f'{subject}:{gen.rsplit("/", 1)[0]}', f'{subject}:{gen}'):
    oid = g('rev-parse', spec).decode().strip()
    typ = g('cat-file', '-t', oid).decode().strip()
    content = g('cat-file', typ, oid)
    raw = f'{typ} {len(content)}\0'.encode() + content
    if hashlib.sha1(raw).hexdigest() != oid:
        raise SystemExit(f'the store build is wrong for {spec}; the proof needs updating')
    d = store / oid[:2]
    d.mkdir(exist_ok=True)
    (d / oid[2:]).write_bytes(zlib.compress(raw))
    print(f'    loose {typ:6} {oid} ({len(content)} bytes)')
PY

cat > "$WORK/forge.py" <<'PY'
import pathlib
import sys
import zlib

# The planted bytes are ALSO written out as a file, because the running copy has
# to be able to BE them. An attacker who patches the gate in the pack serves the
# same patched bytes from the store; if the proof ran an honest copy against a
# forged store, the plain sha256 comparison would refuse it on its own and the
# arms would say nothing about the re-hash. That hole was in the first version of
# this script and its own arm 4 is what found it.
oid, store, out = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
f = store / oid[:2] / oid[2:]
raw = zlib.decompress(f.read_bytes())
_, _, body = raw.partition(b'\x00')
forged = b'# FORGED: this generator exempts whatever it likes\n' + body
f.write_bytes(zlib.compress(b'blob %d\x00' % len(forged) + forged))
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(forged)
print(f'    rewrote the loose object UNDER ITS OWN NAME: {len(body)} -> {len(forged)} bytes')
print(f'    and staged those same bytes as the RUNNING copy, which is the real attack')
PY

BLOB=$(git -C "$WORK/src" --no-replace-objects rev-parse "$SUBJECT:$GEN_IN_REPO")

# ---------------------------------------------------------- arm 0: git's behaviour
# Stated first because every other arm rests on it, and it is a fact about git,
# not about this repository.
echo "ARM 0 - does git verify a loose object's hash when it reads it?"
git init -q "$WORK/tiny"
printf 'real content!!!!\n' > "$WORK/tiny/r.txt"
TID=$(git -C "$WORK/tiny" hash-object -w "$WORK/tiny/r.txt")
python3 - "$WORK/tiny/.git/objects/$(echo "$TID" | cut -c1-2)/$(echo "$TID" | cut -c3-)" <<'PY'
import pathlib
import sys
import zlib
body = b'forged content!!\n'
pathlib.Path(sys.argv[1]).write_bytes(zlib.compress(b'blob %d\x00' % len(body) + body))
PY
SERVED=$(git -C "$WORK/tiny" cat-file blob "$TID")
echo "    wrote $TID, then rewrote its loose file; cat-file returns: $SERVED"
[ "$SERVED" = "forged content!!" ] || fail "arm 0: git refused the tampered loose object, so this proof's premise does not hold on this git"
git -C "$WORK/tiny" fsck 2>&1 | grep -q 'hash-path mismatch' \
    || fail "arm 0: fsck did not report a hash-path mismatch; the premise is not as described"
echo "    OK: served at exit 0 under the real id. Only \`git fsck\` reports the mismatch."
echo

# ------------------------------------------- arm 1: the committed gate, honest store
echo "ARM 1 - the committed generator, an honest prepared store through alternates."
python3 -B "$WORK/build_store.py" "$WORK/src" "$SUBJECT" "$GEN_IN_REPO" "$WORK/store/objects"
git init -q "$WORK/honest"
echo "$WORK/store/objects" > "$WORK/honest/.git/objects/info/alternates"
mkdir -p "$WORK/a1"
cp "$WORK/src/$GEN_IN_REPO" "$WORK/a1/regenerate-manifest.py"
python3 -B "$WORK/drv.py" "$WORK/a1/regenerate-manifest.py" "$WORK/honest" "$SUBJECT" > "$WORK/arm1.out"
sed 's/^/    /' "$WORK/arm1.out"
grep -q '^VERDICT ok=True' "$WORK/arm1.out" || fail "arm 1: an honest store was refused"
grep -q 'RECORDS for' "$WORK/arm1.out" \
    || fail "arm 1: the pin passed without stating that it re-hashed the served bytes"
echo "    OK: accepted, and the sentence says the served bytes re-hash to the recorded id."
echo

# ------------------------------------------------- arm 2: the forgery is refused
echo "ARM 2 - the same store, with the generator's loose object rewritten."
python3 -B "$WORK/forge.py" "$BLOB" "$WORK/store/objects" "$WORK/a2/regenerate-manifest.py"
echo "    the tree still records $BLOB"
echo "    replace refs in that repo: $(git -C "$WORK/honest" for-each-ref refs/replace/ | wc -l | tr -d ' ')"
# The running copy IS the planted bytes, so the sha256 comparison agrees with the
# store and the re-hash is the only thing left that can refuse.
python3 -B "$WORK/drv.py" "$WORK/a2/regenerate-manifest.py" "$WORK/honest" "$SUBJECT" > "$WORK/arm2.out"
sed 's/^/    /' "$WORK/arm2.out"
grep -q '^VERDICT ok=False' "$WORK/arm2.out" || fail "arm 2: THE FORGERY PASSED - this is A-01, open again"
grep -q 'SERVED BYTES THAT ARE NOT THE OBJECT IT NAMES' "$WORK/arm2.out" \
    || fail "arm 2: refused, but not by name"
refute 'is PINNED' "$WORK/arm2.out" "arm 2: the gate claimed a pin it had just refused"
echo "    OK: refused BY NAME, with no replace ref anywhere, the right commit, tree and branch,"
echo "    and the running bytes MATCHING what the store served - so nothing but the re-hash"
echo "    could have refused it."
echo

# ------------- arm 3: the re-hash subsumes R15-01 with both git guards removed
echo "ARM 3 - R15-01's replace plant, with BOTH git guards stripped from the gate."
python3 - "$WORK/a1/regenerate-manifest.py" "$WORK/a3/regenerate-manifest.py" <<'PY'
import pathlib
import sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = src.read_text(encoding='utf-8')
flags, envs = s.count('*GIT,'), s.count('env=git_env()')
if not flags or not envs:
    raise SystemExit('the git guards are not where this proof expects them; the proof needs updating')
s = s.replace('(*GIT, ', "('git', ").replace('[*GIT, ', "['git', ")
s = s.replace(', env=git_env()', '').replace('env=git_env(),', '')
s = s.replace('\n                             env=git_env())', ')')
compile(s, str(dst), 'exec')
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(s, encoding='utf-8')
print(f'    stripped {flags} flag sites and {envs} environment sites')
PY
git --no-replace-objects clone --no-hardlinks -q "$WORK/src" "$WORK/replrepo"
git -C "$WORK/replrepo" --no-replace-objects checkout -q "$SUBJECT"
PLANT=$(git -C "$WORK/replrepo" hash-object -w "$WORK/a3/regenerate-manifest.py")
git -C "$WORK/replrepo" replace -f "$BLOB" "$PLANT" >/dev/null
echo "    planted refs/replace/$BLOB -> $PLANT"
python3 -B "$WORK/drv.py" "$WORK/a3/regenerate-manifest.py" "$WORK/replrepo" "$SUBJECT" > "$WORK/arm3.out"
sed 's/^/    /' "$WORK/arm3.out"
grep -q '^VERDICT ok=False' "$WORK/arm3.out" \
    || fail "arm 3: with the git guards gone the replace plant passed, so the re-hash does not subsume R15-01"
grep -q 'SERVED BYTES THAT ARE NOT THE OBJECT IT NAMES' "$WORK/arm3.out" \
    || fail "arm 3: refused, but not by the re-hash"
echo "    OK: the re-hash catches the replace case too, so it SUBSUMES the R15-01 guards."
echo "    The guards stay anyway: they are free, and they keep that case out of this comparison."
echo

# --------------------- arm 4: delete the re-hash, both forgeries must work again
echo "ARM 4 - the re-hash check DELETED; both forgeries must succeed again."
python3 - "$WORK/a2/regenerate-manifest.py" "$WORK/a4/regenerate-manifest.py" <<'PY'
import pathlib
import re
import sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = src.read_text(encoding='utf-8')
# A-02 moved the re-hash into `served_object()`, where the commit, the trees and the
# blob all pass through it. Deleting it there is still exactly "delete the A-01 check",
# and it is the only place left that performs one.
m = re.search(r'\n    served = hashlib\.sha1\(.*?\n(?=    if served != oid:)', s, re.S)
if not m:
    raise SystemExit('the re-hash check is not where this proof expects it; the proof needs updating')
s = s[:m.start()] + '\n    served = oid  # GUARD DELETED for arm 4\n' + s[m.end():]
compile(s, str(dst), 'exec')
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(s, encoding='utf-8')
print('    replaced the re-hash with the id the store claims')
PY
# Deleting the guard changes the running bytes too, so the attacker serves THOSE:
# the gate they patched is the gate they plant. Without this re-plant the sha256
# comparison refuses and arm 4 reads as a pass when it is really a different
# refusal -- which is how this script found its own second hole, after arm 4 had
# already found its first.
python3 - "$BLOB" "$WORK/store/objects" "$WORK/a4/regenerate-manifest.py" <<'PY'
import pathlib
import sys
import zlib
oid, store, payload = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
body = payload.read_bytes()
f = store / oid[:2] / oid[2:]
f.write_bytes(zlib.compress(b'blob %d\x00' % len(body) + body))
print(f'    planted those same {len(body)} bytes as loose object {oid}')
PY
python3 -B "$WORK/drv.py" "$WORK/a4/regenerate-manifest.py" "$WORK/honest" "$SUBJECT" > "$WORK/arm4.out"
sed 's/^/    /' "$WORK/arm4.out"
grep -q '^VERDICT ok=True' "$WORK/arm4.out" \
    || fail "arm 4: removing the re-hash did NOT reopen the forgery, so arm 2 proves nothing about this guard"
grep -q 'is PINNED' "$WORK/arm4.out" \
    || fail "arm 4: removing the re-hash did NOT reopen the forgery, so arm 2 proves nothing about this guard"
refute 'SERVED BYTES THAT ARE NOT THE OBJECT' "$WORK/arm4.out" "arm 4: the deleted check still fired"
echo "    OK: with the re-hash gone the forgery SUCCEEDS - a PIN printed for a generator that"
echo "    is not the committed one, in a repository at the right commit with no replace ref."
echo "    So the re-hash is what refuses arm 2, and arm 2 is about this guard and not another."
echo "    Note what the guardless build's own sentence says while doing it: \"the store was not"
echo "    taken at its word\". It was. A claim in a gate's output is not a check."
echo
echo "ALL ARMS HOLD at $SUBJECT"
