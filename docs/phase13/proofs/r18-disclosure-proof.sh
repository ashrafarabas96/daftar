#!/bin/sh
# R18 red proof: two disclosures the gate owed its reader, each with an arm that
# goes red at the commit before the fix and an arm that deletes it again.
#
# `R18-01` (P3, round 18). The pin's own sentence asks the reader to compare the
# subject sha with the one in the signature -- and printed 12 of its 40
# characters. `grep -oE '\b[0-9a-f]{40}\b'` over the whole `--check` output
# returned NOTHING: the gate enforced the full-40 law on its INPUT (an
# abbreviated subject sha is a refusal) and not on its own OUTPUT. §3.6 carries
# the full sha three times, so the comparison was available to anyone who opened
# the manifest -- this is the gap between the two.
#
# `R18-02` (P3, round 18). The record table offers `origin/<branch>` as a SECOND
# source, "read with `git ls-remote`, never inferred from a successful push". But
# `origin` comes from the config of the repository the run was handed -- the one
# the pin exists to distrust. Point it at a bare repository on your own disk and
# every row comes out true, `Pushed?` reading yes, about a remote made a minute
# earlier, with nothing in any row naming which remote answered.
#
# Neither fix CLOSES anything: the first makes a comparison the reader was asked
# to make possible to make, and the second makes a residual visible. That is the
# whole claim, and it is why both are P3 and neither is a guard.
#
#   usage: sh docs/phase13/proofs/r18-disclosure-proof.sh [<subject sha>]
#          R18_ARMS=CD sh docs/phase13/proofs/r18-disclosure-proof.sh <sha>
#
# Four arms. B and D delete each disclosure again, so A and C are about those
# lines and not about something else in the output. The two findings are
# INDEPENDENT, and a shell script stops at its first red, so `R18_ARMS` selects
# a subset: aimed at the commit before the fix, `AB` goes red at A and `CD` goes
# red at C, and reporting one red while the other arm never ran would be a claim
# about an arm nobody executed.

set -eu

SRC=$(cd "$(dirname "$0")/../../.." && pwd)
SUBJECT=${1:-$(git -C "$SRC" --no-replace-objects rev-parse HEAD)}
GEN_IN_REPO=docs/phase13/regenerate-manifest.py
WORK=$(mktemp -d "${TMPDIR:-/tmp}/r18-disclosure.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "subject commit : $SUBJECT"
echo "source worktree: $SRC"
echo

fail() { echo; echo "PROOF FAILED: $1"; exit 1; }
refute() { if grep -q "$1" "$2"; then fail "$3"; fi; }
ARMS=${R18_ARMS:-ABCD}
want() { case "$ARMS" in *"$1"*) return 0 ;; *) echo "ARM $1 - SKIPPED by R18_ARMS=$ARMS"; echo; return 1 ;; esac; }

git --no-replace-objects clone --no-hardlinks -q "$SRC" "$WORK/src"
git -C "$WORK/src" --no-replace-objects checkout -q "$SUBJECT"
GOOD="$WORK/src/$GEN_IN_REPO"

cat > "$WORK/pin.py" <<'PY'
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

cat > "$WORK/rows.py" <<'PY'
import importlib.util
import os
import pathlib
import sys

sys.dont_write_bytecode = True
os.environ['P13_REPO'] = sys.argv[2]
spec = importlib.util.spec_from_file_location('p13gate', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.REPO = mod.find_repo()
# The same trap round 17 cost me: REPO is assigned in main(), so a driver that
# does not ASSERT where the gate is pointed gets answers about another repository
# and reads them as the subject's.
if str(mod.REPO) != sys.argv[2]:
    raise SystemExit(f'the gate is pointed at {mod.REPO}, not at {sys.argv[2]}')
for line in mod.git_record_rows():
    print(f'REC {line}')
for line in mod.git_observation_rows():
    print(f'OBS {line}')
PY

# An honest prepared store, so arm A reads the PINNED sentence and nothing else.
cat > "$WORK/store.py" <<'PY'
import hashlib
import pathlib
import subprocess
import sys
import zlib

src, subject, gen, victim = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
store = victim.parent / (victim.name + '-store')


def g(*a):
    return subprocess.run(('git', '-C', src, '--no-replace-objects', *a),
                          capture_output=True, check=True).stdout


parts = gen.split('/')
specs = [(subject, 'commit'), (f'{subject}^{{tree}}', 'tree')]
for i in range(len(parts) - 1):
    specs.append((f'{subject}:{"/".join(parts[:i + 1])}', 'tree'))
specs.append((f'{subject}:{gen}', 'blob'))
subprocess.run(('git', 'init', '-q', str(victim)), check=True)
for spec, typ in specs:
    oid = g('rev-parse', spec).decode().strip()
    body = g('cat-file', typ, oid)
    raw = b'%s %d\x00' % (typ.encode(), len(body)) + body
    if hashlib.sha1(raw).hexdigest() != oid:
        raise SystemExit(f'the source repository does not serve {spec} honestly')
    d = store / 'objects' / oid[:2]
    d.mkdir(parents=True, exist_ok=True)
    (d / oid[2:]).write_bytes(zlib.compress(raw))
info = victim / '.git' / 'objects' / 'info'
info.mkdir(parents=True, exist_ok=True)
(info / 'alternates').write_text(str(store / 'objects') + '\n')
print(f'    honest store: {len(specs)} loose objects, no pack')
PY

# ------------------------------------- arm A: the sentence prints all 40 characters
if want A; then
echo "ARM A - R18-01: the id the reader is asked to COMPARE is printed in full."
python3 -B "$WORK/store.py" "$WORK/src" "$SUBJECT" "$GEN_IN_REPO" "$WORK/honest"
mkdir -p "$WORK/pA" && cp "$GOOD" "$WORK/pA/regenerate-manifest.py"
python3 -B "$WORK/pin.py" "$WORK/pA/regenerate-manifest.py" "$WORK/honest" "$SUBJECT" > "$WORK/armA.out"
sed 's/^/    /' "$WORK/armA.out"
grep -q '^VERDICT ok=True' "$WORK/armA.out" || fail "arm A: an honest store was refused"
grep -q "$SUBJECT" "$WORK/armA.out" \
    || fail "arm A: the sentence asks the reader to compare the subject sha and does not print all 40 characters of it - this is R18-01"
grep -oE '\b[0-9a-f]{40}\b' "$WORK/armA.out" > "$WORK/armA.full" || true
echo "    full 40-character ids in the verdict: $(sort -u "$WORK/armA.full" | wc -l | tr -d ' ')"
grep -q "$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WORK/pA/regenerate-manifest.py")" "$WORK/armA.out" \
    || fail "arm A: the generator SHA-256 is part of the signed triple and is not printed in full either"
echo "    OK: the subject sha and the generator SHA-256 - the two elements of the signed"
echo "    triple this sentence names - are both printed in full."
echo
fi

# ----------------------------- arm B: abbreviate it again; the comparison vanishes
if want B; then
echo "ARM B - R18-01's own line removed: the full sha must disappear from the verdict."
python3 - "$GOOD" "$WORK/pB/regenerate-manifest.py" <<'PY'
import pathlib
import sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = src.read_text(encoding='utf-8')
needle = "f'{subject_sha} RECORDS for `{GENERATOR_IN_REPO}`, and the bytes running '"
if needle not in s:
    raise SystemExit('the pin sentence is not where this proof expects it; the proof needs updating')
s = s.replace(needle, "f'{subject_sha[:7]} RECORDS for `{GENERATOR_IN_REPO}`, and the bytes running '")
s = s.replace("f'here hash to {running} — so no id in this comparison was taken from '",
              "f'here hash to {running[:16]}… — so no id in this comparison was taken from '")
s = s.replace("f'the store\\'s word for it (A-01), only the subject sha {subject_sha} '",
              "f'the store\\'s word for it (A-01), only the subject sha {subject_sha[:12]}… '")
compile(s, str(dst), 'exec')
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(s, encoding='utf-8')
print('    abbreviated the subject sha and the generator digest again')
PY
# The running copy must be what the store serves, or the content comparison refuses
# first and this arm would say nothing about the sentence.
python3 - "$SUBJECT" "$GEN_IN_REPO" "$WORK/honest-store/objects" "$WORK/pB/regenerate-manifest.py" "$WORK/src" <<'PY'
import hashlib
import pathlib
import subprocess
import sys
import zlib
subject, gen, store, payload, src = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3]), \
    pathlib.Path(sys.argv[4]), sys.argv[5]
oid = subprocess.run(('git', '-C', src, '--no-replace-objects', 'rev-parse', f'{subject}:{gen}'),
                     capture_output=True, check=True).stdout.decode().strip()
body = payload.read_bytes()
(store / oid[:2] / oid[2:]).write_bytes(zlib.compress(b'blob %d\x00' % len(body) + body))
print(f'    planted those same {len(body)} bytes as loose object {oid[:12]} '
      f'(really {hashlib.sha1(b"blob %d\\x00" % len(body) + body).hexdigest()[:12]})')
PY
python3 -B "$WORK/pin.py" "$WORK/pB/regenerate-manifest.py" "$WORK/honest" "$SUBJECT" > "$WORK/armB.out" || true
sed 's/^/    /' "$WORK/armB.out"
refute "$SUBJECT" "$WORK/armB.out" "arm B: the full sha is still printed with the line removed, so arm A is about something else"
echo "    OK: with that line abbreviated again the comparison the sentence ASKS for cannot be"
echo "    made from the sentence - which is exactly what R18-01 reported."
echo
fi

# ------------------------- arm C: the remote that answered ls-remote is named
if want C; then
echo "ARM C - R18-02: a crafted remote, and the rows must NAME it."
git --no-replace-objects clone --no-hardlinks -q "$WORK/src" "$WORK/victim"
git -C "$WORK/victim" --no-replace-objects checkout -q "$SUBJECT"
# The crafted remote must carry the PEER branches too, or the rows fail to generate for
# a reason that has nothing to do with the finding -- and a remote an attacker crafts
# would of course carry them. Both spellings are fetched because a clone copies local
# heads only.
git -C "$WORK/victim" fetch -q "$SRC" 'refs/remotes/origin/*:refs/heads/*' 2>/dev/null || true
git -C "$WORK/victim" fetch -q "$SRC" 'refs/heads/*:refs/heads/*' 2>/dev/null || true
git clone --bare -q "$WORK/victim" "$WORK/crafted.git"
git -C "$WORK/victim" remote set-url origin "$WORK/crafted.git"
echo "    origin in the victim now: $(git -C "$WORK/victim" remote get-url origin)"
echo "    heads the crafted remote answers with: $(git -C "$WORK/victim" ls-remote --heads origin | wc -l | tr -d ' ')"
python3 -B "$WORK/rows.py" "$GOOD" "$WORK/victim" > "$WORK/armC.out"
sed 's/^/    /' "$WORK/armC.out"
grep -q 'Pushed?' "$WORK/armC.out" || fail "arm C: the record rows did not come out, so the arm measured nothing"
grep -q "$WORK/crafted.git" "$WORK/armC.out" \
    || fail "arm C: every row is true about a remote made a minute ago and NOTHING names it - this is R18-02"
grep -q 'R18-02' "$WORK/armC.out" \
    || fail "arm C: the remote is named but the row does not say what naming it does and does not do"
echo "    OK: the rows name the remote that answered, and say that naming it does not close"
echo "    the residual. Note what the row ABOVE it still says while this remote answers:"
echo "    \"never inferred from a successful push\" - true, and about a directory on this disk."
echo
fi

# ------------------------------ arm D: remove the row; the crafted remote vanishes
if want D; then
echo "ARM D - that row removed: the crafted remote must become invisible again."
python3 - "$GOOD" "$WORK/pD/regenerate-manifest.py" <<'PY'
import pathlib
import re
import sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = src.read_text(encoding='utf-8')
m = re.search(r"\n        f'\| The remote that answered `ls-remote` \|.*?\|',\n", s, re.S)
if not m:
    raise SystemExit('the remote-disclosure row is not where this proof expects it; the proof needs updating')
s = s[:m.start()] + '\n' + s[m.end():]
compile(s, str(dst), 'exec')
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(s, encoding='utf-8')
print('    deleted the remote-disclosure row')
PY
python3 -B "$WORK/rows.py" "$WORK/pD/regenerate-manifest.py" "$WORK/victim" > "$WORK/armD.out"
sed 's/^/    /' "$WORK/armD.out"
grep -q 'Pushed?' "$WORK/armD.out" || fail "arm D: the rows did not come out, so the arm measured nothing"
refute "$WORK/crafted.git" "$WORK/armD.out" "arm D: the remote is still named with the row deleted, so arm C is about something else"
echo "    OK: without that row the table says \`Pushed?\` **yes** about a bare repository created"
echo "    by this script, and a reader cannot tell. A second source that does not say WHO"
echo "    answered is one source."
fi

echo
echo "ALL SELECTED ARMS HOLD ($ARMS) at $SUBJECT"
