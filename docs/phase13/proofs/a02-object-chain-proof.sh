#!/bin/sh
# A-02 red proof: the id a re-hash compares against must not itself come from the
# store, so the whole chain from the subject commit down is re-hashed.
#
# The finding this proves closed, from the challenger's second addendum to round
# 16. A-01 stopped a prepared store serving forged bytes under the real blob id,
# by re-hashing the bytes against the id the TREE records. But that id was read
# with `rev-parse <sha>:<path>`, which resolves commit -> tree -> ... -> blob out
# of the same store A-01 had just shown cannot be taken at its word. So the
# attacker moves one level up:
#
#   * arm C, the TREE: one 20-byte id swapped inside the `docs/phase13` tree
#     object, written back under that tree's own id; the forged generator then
#     goes in as a perfectly HONEST blob. `recorded_id == served_id`, the A-01
#     re-hash agrees, and the gate prints a PIN for a generator nobody committed.
#   * arm E, the COMMIT: every tree and the blob honest, and only the commit
#     object rewritten -- the real commit's bytes with the `tree` line repointed,
#     stored under the anchored sha, `parent` line intact. Also accepted.
#
# Measured at `8215af5` before any of this was written: ok=True both ways, with
# `refs/replace/` empty, the R15-01 flag and environment variable with nothing to
# disable, and HEAD, the worktree and the branch all resolving correctly. The
# sentence the gate printed then -- "the id the tree at <sha> RECORDS" -- was
# FALSE as measured: the tree at that sha, hashed properly, records the real blob.
#
# The remedy under test: walk down from the one input that is not an answer from
# the store, the 40-character subject sha, and re-hash every object on the way as
# Git defines one -- the commit, each tree on the path, then the blob -- taking
# each next id from the bytes just verified. Refuse BY NAME at the first mismatch.
#
#   usage: sh docs/phase13/proofs/a02-object-chain-proof.sh [<subject sha>]
#
# Six arms. Arm F deletes the re-hash and requires the tree forgery to succeed
# again; without it, arms B, C and E cannot tell this guard from any other
# refusal. Arm 0 of `a01-object-integrity-proof.sh` measures the premise both
# scripts rest on -- that git does not verify a loose object when it reads it --
# and is not repeated here.

set -eu

SRC=$(cd "$(dirname "$0")/../../.." && pwd)
SUBJECT=${1:-$(git -C "$SRC" --no-replace-objects rev-parse HEAD)}
GEN_IN_REPO=docs/phase13/regenerate-manifest.py
WORK=$(mktemp -d "${TMPDIR:-/tmp}/a02-object-chain.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "subject commit : $SUBJECT"
echo "source worktree: $SRC"
echo

fail() { echo; echo "PROOF FAILED: $1"; exit 1; }
refute() { if grep -q "$1" "$2"; then fail "$3"; fi; }

# The clone and the checkout read objects too, so they are done with replacement
# disabled: a replace ref in $SRC would otherwise be laid down by the checkout and
# the proof would rest on the thing it tests.
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

# One stager for all four stores, so the only difference between the arms is WHICH
# object is tampered with. Every object is written loose, through
# `.git/objects/info/alternates`, into a repository that holds no pack of its own:
# a tampered loose object beside a real PACKED one reads real, so a store that is
# merely added to proves nothing.
#
# The payload is written out as a FILE as well as into the store, because the
# running copy has to be able to BE it. An attacker who patches the gate serves
# the same patched bytes; an honest running copy would be refused by the plain
# sha256 comparison and the arm would pass for a reason unrelated to the guard
# under test. That hole was in the first version of the A-01 proof and its own
# guard-deletion arm is what found it.
cat > "$WORK/stage.py" <<'PY'
import hashlib
import pathlib
import subprocess
import sys
import zlib

src, subject, gen, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
payload_file, out, victim = sys.argv[5], pathlib.Path(sys.argv[6]), pathlib.Path(sys.argv[7])


def g(*a):
    return subprocess.run(('git', '-C', src, '--no-replace-objects', *a),
                          capture_output=True, check=True).stdout


def oid_of(typ, data):
    return hashlib.sha1(b'%s %d\x00' % (typ.encode(), len(data)) + data).hexdigest()


def parse_tree(data):
    out_, i = [], 0
    while i < len(data):
        j = data.index(b'\x00', i)
        m, n = data[i:j].split(b' ', 1)
        out_.append([m, n, data[j + 1:j + 21]])
        i = j + 21
    return out_


def build_tree(entries):
    return b''.join(m + b' ' + n + b'\x00' + s for m, n, s in entries)


parts = gen.split('/')
commit = g('cat-file', 'commit', subject)
if oid_of('commit', commit) != subject:
    raise SystemExit(f'the source repository does not serve {subject} honestly; the proof '
                     'cannot be built on it')
root_id = commit.split(b'tree ', 1)[1][:40].decode()
chain = [('', root_id, g('cat-file', 'tree', root_id))]
for part in parts[:-1]:
    entry = [e for e in parse_tree(chain[-1][2]) if e[1] == part.encode()][0]
    oid = entry[2].hex()
    chain.append((part, oid, g('cat-file', 'tree', oid)))
gen_entry = [e for e in parse_tree(chain[-1][2]) if e[1] == parts[-1].encode()][0]
gen_id = gen_entry[2].hex()
real = g('cat-file', 'blob', gen_id)

payload = pathlib.Path(payload_file).read_bytes()
forged = b'# FORGED: this generator exempts whatever it likes\n' + payload
forged_id = oid_of('blob', forged)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(forged)

objects = []   # (id to serve it as, type, bytes)
if mode == 'honest':
    objects = [(subject, 'commit', commit)] + [(o, 'tree', b) for _, o, b in chain] \
              + [(gen_id, 'blob', real)]
    out.write_bytes(real)
elif mode == 'blob':
    # A-01: the blob tampered under its own name; commit and every tree honest.
    objects = [(subject, 'commit', commit)] + [(o, 'tree', b) for _, o, b in chain] \
              + [(gen_id, 'blob', forged)]
elif mode == 'tree':
    # A-02 arm C: the LEAF tree tampered under its own name; the blob is honest.
    leaf = build_tree([[m, n, bytes.fromhex(forged_id) if n == parts[-1].encode() else s]
                       for m, n, s in parse_tree(chain[-1][2])])
    if oid_of('tree', leaf) == chain[-1][1]:
        raise SystemExit('the tampered tree hashes to the real id; the proof needs updating')
    objects = [(subject, 'commit', commit)] \
              + [(o, 'tree', leaf if o == chain[-1][1] else b) for _, o, b in chain] \
              + [(forged_id, 'blob', forged)]
elif mode == 'commit':
    # A-02 arm E: every tree and the blob HONEST, under their own ids; only the
    # commit object is tampered, served under the anchored sha.
    # chain[i] is the tree that CONTAINS parts[i], so rebuild from the leaf upwards.
    rebuilt, nxt = [], forged_id
    for i in range(len(chain) - 1, -1, -1):
        built = build_tree([[m, n, bytes.fromhex(nxt) if n == parts[i].encode() else s]
                            for m, n, s in parse_tree(chain[i][2])])
        nxt = oid_of('tree', built)
        rebuilt.append((nxt, built))
    tampered = commit.replace(b'tree ' + root_id.encode(), b'tree ' + nxt.encode(), 1)
    if oid_of('commit', tampered) == subject:
        raise SystemExit('the tampered commit hashes to the subject sha; the proof needs updating')
    objects = [(subject, 'commit', tampered)] + [(o, 'tree', b) for o, b in rebuilt] \
              + [(forged_id, 'blob', forged)]
else:
    raise SystemExit(f'unknown mode {mode}')

store = victim.parent / (victim.name + '-store')
subprocess.run(('git', 'init', '-q', str(victim)), check=True)
for oid, typ, data in objects:
    d = store / 'objects' / oid[:2]
    d.mkdir(parents=True, exist_ok=True)
    (d / oid[2:]).write_bytes(zlib.compress(b'%s %d\x00' % (typ.encode(), len(data)) + data))
info = victim / '.git' / 'objects' / 'info'
info.mkdir(parents=True, exist_ok=True)
(info / 'alternates').write_text(str(store / 'objects') + '\n')
print(f'    {mode:6}: real blob {gen_id[:12]}, forged blob {forged_id[:12]}, '
      f'{len(objects)} loose objects, no pack')
PY

STAGE="python3 -B $WORK/stage.py $WORK/src $SUBJECT $GEN_IN_REPO"
GOOD="$WORK/src/$GEN_IN_REPO"

# ------------------------------------------- arm A: the committed gate, honest store
echo "ARM A - the committed generator, an honest prepared store through alternates."
$STAGE honest "$GOOD" "$WORK/pA/regenerate-manifest.py" "$WORK/honest"
python3 -B "$WORK/drv.py" "$WORK/pA/regenerate-manifest.py" "$WORK/honest" "$SUBJECT" > "$WORK/armA.out"
sed 's/^/    /' "$WORK/armA.out"
grep -q '^VERDICT ok=True' "$WORK/armA.out" || fail "arm A: an honest store was refused"
echo "    OK: accepted. What the sentence must SAY is arm G, deliberately last, so that a"
echo "    head without the fix fails at the forgery itself and not at a wording check."
echo

# -------------------------------------------- arm B: A-01 still refused by name
echo "ARM B - the blob tampered under its own name (A-01), commit and trees honest."
$STAGE blob "$GOOD" "$WORK/pB/regenerate-manifest.py" "$WORK/vblob"
python3 -B "$WORK/drv.py" "$WORK/pB/regenerate-manifest.py" "$WORK/vblob" "$SUBJECT" > "$WORK/armB.out"
sed 's/^/    /' "$WORK/armB.out"
grep -q '^VERDICT ok=False' "$WORK/armB.out" || fail "arm B: A-01's forgery passed, so A-01 is open again"
grep -q 'SERVED BYTES THAT ARE NOT THE OBJECT IT NAMES' "$WORK/armB.out" \
    || fail "arm B: refused, but not by A-01's name"
echo "    OK: the A-01 refusal survives the rewrite, and still names A-01."
echo

# --------------------------------------------------- arm C: the tampered TREE
echo "ARM C - the docs/phase13 TREE tampered under its own id; the blob is HONEST."
$STAGE tree "$GOOD" "$WORK/pC/regenerate-manifest.py" "$WORK/vtree"
echo "    replace refs in that repo: $(git -C "$WORK/vtree" for-each-ref refs/replace/ | wc -l | tr -d ' ')"
echo "    rev-parse says: $(git -C "$WORK/vtree" --no-replace-objects rev-parse "$SUBJECT:$GEN_IN_REPO")"
python3 -B "$WORK/drv.py" "$WORK/pC/regenerate-manifest.py" "$WORK/vtree" "$SUBJECT" > "$WORK/armC.out"
sed 's/^/    /' "$WORK/armC.out"
grep -q '^VERDICT ok=False' "$WORK/armC.out" || fail "arm C: THE TREE FORGERY PASSED - this is A-02, open again"
grep -q 'SERVED AN OBJECT THAT IS NOT THE ONE IT NAMES (A-02)' "$WORK/armC.out" \
    || fail "arm C: refused, but not by name"
grep -q 'the TREE at `docs/phase13`' "$WORK/armC.out" \
    || fail "arm C: refused without naming WHICH object on the path was forged"
refute 'is PINNED' "$WORK/armC.out" "arm C: the gate claimed a pin it had just refused"
echo "    OK: refused BY NAME, naming the tree. The id the A-01 re-hash would have compared"
echo "    against is exactly what this store forged, and the blob it points at is honest -"
echo "    so nothing but the chain walk could have refused it."
echo

# ------------------------------------------------- arm E: the tampered COMMIT
echo "ARM E - every tree and the blob HONEST; only the commit object is tampered."
$STAGE commit "$GOOD" "$WORK/pE/regenerate-manifest.py" "$WORK/vcommit"
echo "    replace refs in that repo: $(git -C "$WORK/vcommit" for-each-ref refs/replace/ | wc -l | tr -d ' ')"
echo "    rev-parse says: $(git -C "$WORK/vcommit" --no-replace-objects rev-parse "$SUBJECT:$GEN_IN_REPO")"
git -C "$WORK/vcommit" --no-replace-objects cat-file commit "$SUBJECT" | grep -q '^parent ' \
    || fail "arm E: the tampered commit lost its parent line, so it is not the shape being tested"
python3 -B "$WORK/drv.py" "$WORK/pE/regenerate-manifest.py" "$WORK/vcommit" "$SUBJECT" > "$WORK/armE.out"
sed 's/^/    /' "$WORK/armE.out"
grep -q '^VERDICT ok=False' "$WORK/armE.out" || fail "arm E: THE COMMIT FORGERY PASSED - this is A-02, open again"
grep -q 'the COMMIT itself could not be verified' "$WORK/armE.out" \
    || fail "arm E: refused, but not by naming the commit"
echo "    OK: refused at the anchor itself, with every other object in the store honest."
echo

# ------------- arm D: the chain walk subsumes R15-01 with both git guards removed
echo "ARM D - R15-01's replace plant, with BOTH git guards stripped from the gate."
python3 - "$GOOD" "$WORK/pD/regenerate-manifest.py" <<'PY'
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
BLOB=$(git -C "$WORK/src" --no-replace-objects rev-parse "$SUBJECT:$GEN_IN_REPO")
PLANT=$(git -C "$WORK/replrepo" hash-object -w "$WORK/pD/regenerate-manifest.py")
git -C "$WORK/replrepo" replace -f "$BLOB" "$PLANT" >/dev/null
echo "    planted refs/replace/$BLOB -> $PLANT"
python3 -B "$WORK/drv.py" "$WORK/pD/regenerate-manifest.py" "$WORK/replrepo" "$SUBJECT" > "$WORK/armD.out"
sed 's/^/    /' "$WORK/armD.out"
grep -q '^VERDICT ok=False' "$WORK/armD.out" \
    || fail "arm D: with the git guards gone the replace plant passed, so the walk does not subsume R15-01"
grep -q 'NOT THE OBJECT' "$WORK/armD.out" || fail "arm D: refused, but not by a re-hash"
echo "    OK: the re-hash catches the replace case too, so the walk SUBSUMES R15-01 and"
echo "    the 8215af5 blob check both. The guards stay anyway: they are free, and they keep"
echo "    that case out of this comparison entirely."
echo

# ------------------- arm F: delete the re-hash; the tree forgery must work again
echo "ARM F - the object re-hash DELETED; the tree forgery must succeed again."
python3 - "$GOOD" "$WORK/pF/regenerate-manifest.py" <<'PY'
import pathlib
import re
import sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = src.read_text(encoding='utf-8')
m = re.search(r'\n    served = hashlib\.sha1\(.*?\n(?=    if served != oid:)', s, re.S)
if not m:
    raise SystemExit('the object re-hash is not where this proof expects it; the proof needs updating')
s = s[:m.start()] + '\n    served = oid  # GUARD DELETED for arm F\n' + s[m.end():]
compile(s, str(dst), 'exec')
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(s, encoding='utf-8')
print('    replaced the re-hash with the id the store claims')
PY
# Deleting the guard changes the running bytes, so the attacker serves THOSE: the
# gate they patched is the gate they plant.
$STAGE tree "$WORK/pF/regenerate-manifest.py" "$WORK/pF2/regenerate-manifest.py" "$WORK/vguardless"
cmp -s "$WORK/pF2/regenerate-manifest.py" "$WORK/pF/regenerate-manifest.py" \
    && fail "arm F: the staged payload is the unmarked gate; the arm would test nothing"
python3 -B "$WORK/drv.py" "$WORK/pF2/regenerate-manifest.py" "$WORK/vguardless" "$SUBJECT" > "$WORK/armF.out"
sed 's/^/    /' "$WORK/armF.out"
grep -q '^VERDICT ok=True' "$WORK/armF.out" \
    || fail "arm F: removing the re-hash did NOT reopen the tree forgery, so arm C proves nothing about this guard"
grep -q 'is PINNED' "$WORK/armF.out" \
    || fail "arm F: removing the re-hash did NOT reopen the tree forgery, so arm C proves nothing about this guard"
refute 'NOT THE ONE IT NAMES' "$WORK/armF.out" "arm F: the deleted check still fired"
echo "    OK: with the re-hash gone the tree forgery SUCCEEDS - a PIN printed for a generator"
echo "    nobody committed, in a repository at the right commit with no replace ref and an"
echo "    honest blob. So the chain walk is what refuses arms C and E."
echo "    Note what the guardless build still SAYS while doing it: that it re-hashed the chain."
echo "    A claim in a gate's output is not a check."
echo
# -------------------------------- arm G: the accepted sentence must say what it checked
echo "ARM G - what the honest verdict of arm A actually claims."
grep -q 'RE-HASHED object by object' "$WORK/armA.out" \
    || fail "arm G: the pin passed without stating that it re-hashed the chain"
grep -q 'commit=' "$WORK/armA.out" || fail "arm G: the sentence does not name the chain it walked"
grep -q 'which a reader must compare with the one in the signature' "$WORK/armA.out" \
    || fail "arm G: the sentence does not name the one input it did NOT check"
echo "    OK: it names every object it re-hashed, and names the subject sha as the one input"
echo "    it cannot check from inside - which is the residual, stated and not implied."
echo
echo "ALL ARMS HOLD at $SUBJECT"
