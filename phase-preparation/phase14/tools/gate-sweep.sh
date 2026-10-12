#!/bin/bash
# Every gate, from several working directories, asserting the SAME exit code --
# and then each gate red-proofed.
#
# ROUND-7 CHALLENGE P2-01: `citation-provenance.py --check` answered 0 from the
# pack directory and 1 from anywhere else, because --repo came from the CWD
# while --pack came from the script. Round 6 had already "fixed" cwd-dependence
# in that same tool; the fix left it, one layer up. A gate whose verdict depends
# on where CI stands is not a gate, and an author who only ever runs it from one
# directory cannot see that. So the property is MEASURED, over every gate, from
# four directories, instead of being reasoned about per tool.
#
#   usage: tools/gate-sweep.sh [--no-db]
#
# Exit 0 only if every gate gave the same code from every directory AND every
# red proof turned red.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); PACK=$(dirname "$HERE")
REPO=$(git -C "$PACK" rev-parse --show-toplevel)
DOC="$PACK/P14-MIGRATION-PATCH-REQUEST.md"
SHARED=/mnt/project-files/phase14
NODB=0; [ "${1:-}" = --no-db ] && NODB=1
fail=0

# A second worktree of the same repository: the case that broke the round-6 fix.
WT=$(mktemp -d); git -C "$REPO" worktree add -q "$WT/wt" HEAD 2>/dev/null \
  && WT2="$WT/wt" || WT2=""
DIRS="$PACK $REPO /tmp"; [ -n "$WT2" ] && DIRS="$DIRS $WT2"
# ROUND-8 CHALLENGE P3-03: the four-directory property was REPORTED and never
# ASSERTED. Outside a git checkout $REPO is empty and the worktree add is
# silenced, so three gates printed "ok ... identical from 2 directories" and
# nothing required four. A property that degrades quietly is not measured.
NDIRS=$(echo $DIRS | wc -w)
if [ -z "$REPO" ] || [ -z "$WT2" ] || [ "$NDIRS" -ne 4 ]; then
  printf 'FAIL  %-26s only %s directory set(s) available (repo=%s worktree=%s) — the\n' \
         four-directories "$NDIRS" "${REPO:-<none>}" "${WT2:-<none>}"
  printf '      cwd-independence property cannot be measured with fewer than four, and a\n'
  printf '      sweep that silently measures two would have passed round 7 unchanged.\n'
  fail=$((fail+1))
fi

gate() { # name | command (absolute paths only)
  local name="$1"; shift
  local first="" rc d
  local out1=""
  for d in $DIRS; do
    local o
    o=$( cd "$d" && eval "$@" 2>&1 ); rc=$?
    [ -z "$out1" ] && out1=$(printf '%s' "$o" | grep -m1 . | cut -c1-120)
    # COORDINATOR RELAY round 8: an exit code recorded without the path it was
    # measured from is not a property of the commit. My 0 and the challenger's 1
    # at the same head were both true -- my clone is outside /tmp, theirs inside
    # -- so every code is printed with its absolute directory.
    printf '      %-3s %s\n' "$rc" "$d"
    if [ -z "$first" ]; then first=$rc
    elif [ "$rc" != "$first" ]; then
      printf 'FAIL  %-26s rc=%s from %s but rc=%s from %s — the verdict depends on the directory\n' \
             "$name" "$first" "$(basename "$(echo $DIRS | cut -d" " -f1)")" "$rc" "$d"
      fail=$((fail+1)); first="$rc!"
    fi
  done
  # Consistency is NOT the pass condition. A gate that answers 1 from every
  # directory is consistently FAILING, and printing "ok" beside it would be this
  # pack's own recurring defect -- a line that reads as a verdict without being
  # one. Identical AND 0.
  case "$first" in
    *'!'*) ;;
    0) printf 'ok    %-26s rc=0 identical from %s directories\n' "$name" "$NDIRS" ;;
    *) # ROUND-9 CHALLENGE P3-01: output was discarded, so a gate that FAILED
       # and a gate that COULD NOT RUN printed the same line — and the
       # challenger nearly filed a container permission problem as a pack
       # defect. The first line of output is kept, and the two states are
       # named apart. Both still fail: fail-closed, but diagnosable.
       case "$out1" in
         *"Permission denied"*|*"No such file or directory"*|*"command not found"*|*"not found"*)
           printf 'UNRUNNABLE %-21s rc=%s from %s directories — this gate never asked its question\n' \
                  "$name" "$first" "$NDIRS" ;;
         *)
           printf 'FAIL  %-26s rc=%s identical from %s directories — consistent, but FAILING\n' \
                  "$name" "$first" "$NDIRS" ;;
       esac
       printf '      first line: %s\n' "${out1:-<no output>}"
       fail=$((fail+1)) ;;
  esac
}

printf '== every gate, from %s working directories\n' "$NDIRS"
printf '   pack=%s\n   repo=%s\n   worktree=%s\n   host=%s  date=%s\n' \
       "$PACK" "$REPO" "${WT2:-<none>}" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gate citation-provenance "python3 -I $HERE/citation-provenance.py --check $DOC"
gate manifest-digests    "python3 -I $HERE/manifest-digests.py --dir $PACK --check"
gate manifest-shared     "python3 -I $HERE/manifest-digests.py --dir $SHARED --check"
gate retracted-claims    "python3 -I $HERE/retracted-claims.py --pack $PACK --check"
if [ "$NODB" = 0 ]; then
  gate replay              "$PACK/proofs/replay.sh"
  gate redproof-preflight  "$PACK/proofs/redproof-preflight.sh"
fi

# ---- the location that distinguished round 8: a checkout whose PACK is under
# /tmp. Running the gates from /tmp as a CWD was never the same property --
# every command above names the pack by absolute path, so the pack stayed
# outside /tmp in all four lanes, and the one case that broke (`--repo /tmp` is
# not foreign to a pack under /tmp; a non-repository ancestor answers every git
# call with nothing) could not appear. This lane runs the WORKTREE'S OWN copies
# of the tools against the WORKTREE'S OWN pack, which is under /tmp by
# construction. (The database lane is not repeated here: it is one cluster and
# one socket, and a second concurrent replay would measure the first.)
if [ -n "$WT2" ]; then
  WP="$WT2/phase-preparation/phase14"; WH="$WP/tools"
  printf '== the same gates with the PACK under /tmp: %s\n' "$WP"
  for one in \
    "citation-provenance|python3 -I $WH/citation-provenance.py --pack $WP --check $WP/P14-MIGRATION-PATCH-REQUEST.md" \
    "manifest-digests|python3 -I $WH/manifest-digests.py --manifest $WP/P14-HANDOFF-MANIFEST.md --dir $WP --check" \
    "retracted-claims|python3 -I $WH/retracted-claims.py --pack $WP --check" ; do
    nm=${one%%|*}; cm=${one#*|}
    rc=$( cd "$WT2" && eval "$cm" >/dev/null 2>&1; echo $? )
    if [ "$rc" = 0 ]; then printf 'ok    %-26s rc=0 with the pack at %s\n' "$nm" "$WP"
    else printf 'FAIL  %-26s rc=%s with the pack at %s — the verdict depends on where the pack lives\n' \
                "$nm" "$rc" "$WP"; fail=$((fail+1)); fi
  done
fi

# ---- red proofs: a gate that has never failed is an unfenced gate.
echo "== red proofs"
red() { # name | mutate | command | expected-rc | restore | [file the mutation must change]
  local name="$1" mut="$2" cmd="$3" want="$4" res="$5" tgt="${6:-}" rc before after
  # COORDINATOR RELAY round 8: assert each mutation actually changed its target
  # before judging the result. This is `arm()`'s own lesson -- a mutation that
  # silently no-ops leaves the gate answering about the UNMUTATED world, and the
  # proof then passes for the wrong reason. R8-P2-01 was exactly that: a
  # hard-coded `--repo /tmp` which is not foreign at all when the pack lives
  # under /tmp.
  [ -n "$tgt" ] && before=$(md5sum "$tgt" 2>/dev/null | cut -d" " -f1)
  eval "$mut"
  if [ -n "$tgt" ]; then
    after=$(md5sum "$tgt" 2>/dev/null | cut -d" " -f1)
    if [ "$before" = "$after" ]; then
      printf 'FAIL  %-26s the MUTATION did not change %s — nothing was proved\n' "$name" "$(basename "$tgt")"
      fail=$((fail+1)); eval "$res"; return 0
    fi
  fi
  rc=$( cd /tmp && eval "$cmd" >/dev/null 2>&1; echo $? ); eval "$res"
  if [ -n "$tgt" ] && [ "$(md5sum "$tgt" 2>/dev/null | cut -d' ' -f1)" != "$before" ]; then
    printf 'FAIL  %-26s the RESTORE did not put %s back — the pack is left mutated\n' "$name" "$(basename "$tgt")"
    fail=$((fail+1)); return 0
  fi
  if [ "$rc" = "$want" ]; then printf 'ok    %-26s rc=%s (required %s)\n' "$name" "$rc" "$want"
  else printf 'FAIL  %-26s rc=%s, required %s — the gate did not turn red\n' "$name" "$rc" "$want"
       fail=$((fail+1)); fi
}
T=$(mktemp -d)
cp "$DOC" "$T/doc.bak"; cp "$PACK/P14-HANDOFF-MANIFEST.md" "$T/man.bak"
cp "$PACK/README-AR.md" "$T/ar.bak"

red provenance-stale \
  "sed -i 's/\*\*DIFFERS\*\*/identical/' '$DOC'" \
  "python3 -I $HERE/citation-provenance.py --check $DOC" 1 \
  "cp '$T/doc.bak' '$DOC'" "$DOC"
# ROUND-9 CHALLENGE P2-01: `citation-provenance.py` has FIVE reachable
# refusals that all answer 2, and two of these proofs were judged by the code
# alone — so the `foreign-repo` proof was in fact firing "is a git repository
# but does not contain 93084f8", not the escaping-pathspec refusal its name
# described, and the round-7 ancestry remedy had NO red proof at all. Each
# refusal is now asserted by its own message, each world is CONSTRUCTED, and
# each proof is named for the refusal it actually fires. This closes
# `COORD P3-07` for the whole provenance lane.
named() { # name | expected-rc | required message | command
  local nm="$1" want="$2" msg="$3"; shift 3
  local out rc
  out=$( cd /tmp && eval "$@" 2>&1 ); rc=$?
  if [ "$rc" = "$want" ] && printf '%s' "$out" | grep -q "$msg"; then
    printf 'ok    %-26s rc=%s, refused with %s\n' "$nm" "$rc" "$msg"
  else
    printf 'FAIL  %-26s rc=%s (required %s), and the message was not %s: %s\n' \
           "$nm" "$rc" "$want" "$msg" "$(printf '%s' "$out" | grep -m1 . | cut -c1-90)"
    fail=$((fail+1))
  fi
}

# (a) --repo is not a repository at all, and IS an ancestor of the pack, so the
# ancestry refusal cannot fire instead. This is the world that printed 12 rows.
NR=$(mktemp -d); mkdir -p "$NR/inner"; cp -r "$PACK" "$NR/inner/phase14"
named provenance-not-a-repo 2 "is not a git repository" \
  "python3 -I $HERE/citation-provenance.py --pack $NR/inner/phase14 --repo $NR --check $NR/inner/phase14/P14-MIGRATION-PATCH-REQUEST.md"

# (b) --repo IS a repository but does not carry the declared base.
FR=$(mktemp -d); git -C "$FR" init -q
named provenance-repo-without-base 2 "does not contain 93084f8" \
  "python3 -I $HERE/citation-provenance.py --check $DOC --repo $FR"

# (c) the ROUND-7 remedy itself, which had never been red-proofed: a repository
# that does carry the revisions, with the pack OUTSIDE it, so every pathspec
# would climb out of the tree.
OP=$(mktemp -d); cp -r "$PACK" "$OP/phase14"
named provenance-pack-outside-repo 2 "is not inside --repo" \
  "python3 -I $HERE/citation-provenance.py --pack $OP/phase14 --repo $REPO --check $OP/phase14/P14-MIGRATION-PATCH-REQUEST.md"

# (d) and (e): a real repository, with the pack inside it so the ancestry
# refusal cannot fire instead, whose committed tree knows nothing of the cited
# files. My first attempt at (d) used the repository's own root commit, which
# already carries 972 files: it answered 1, the proof was wrong, and the sweep
# caught it.
ER=$(mktemp -d); git -C "$ER" init -q
mkdir -p "$ER/phase-preparation"; cp -r "$PACK" "$ER/phase-preparation/phase14"
echo scaffolding > "$ER/unrelated.txt"; git -C "$ER" add unrelated.txt
git -C "$ER" -c user.email=p14@local -c user.name=p14 commit -q -m 'a tree that knows nothing of the cited files'
EP="$ER/phase-preparation/phase14"
named provenance-empty-table 2 "MEASUREMENT EMPTY" \
  "python3 -I $HERE/citation-provenance.py --pack $EP --repo $ER --base HEAD --other HEAD --check $EP/P14-MIGRATION-PATCH-REQUEST.md"
# ...and now one cited file is PRESENT on disk in that repository but unknown to
# git, which is the exact shape of the defect: the table would be short and the
# shortfall would read as "absent at the other tree".
mkdir -p "$ER/infrastructure/database"
cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$ER/infrastructure/database/"
named provenance-floor 2 "MEASUREMENT INCOMPLETE" \
  "python3 -I $HERE/citation-provenance.py --pack $EP --repo $ER --base HEAD --other HEAD --check $EP/P14-MIGRATION-PATCH-REQUEST.md"

red manifest-digest-corrupt \
  "sed -i '0,/| \`[0-9a-f]\{64\}\` |/s/| \`\([0-9a-f]\{64\}\)\` |/| \`0\{64\}\` |/' '$PACK/P14-HANDOFF-MANIFEST.md'" \
  "python3 -I $HERE/manifest-digests.py --dir $PACK --check" 1 \
  "cp '$T/man.bak' '$PACK/P14-HANDOFF-MANIFEST.md'" "$PACK/P14-HANDOFF-MANIFEST.md"
# ROUND-9 CHALLENGE P2-02: the one-step bypass. Tamper with a committed
# reviewer's report, then zero its row digest -- the state that used to mean
# "unsigned" -- and `--write` re-signed the row against the tampered file. Both
# halves are proved here: the refusal on the drifted row, and the refusal after
# the digest is moved to a placeholder.
RB=$(mktemp -d); cp "$PACK/P14-CHALLENGE-7af6438.md" "$RB/rep.bak"; cp "$PACK/P14-HANDOFF-MANIFEST.md" "$RB/man.bak"
printf '\n\nthe three absent ones are cited only for Phase 4 surface facts\n' >> "$PACK/P14-CHALLENGE-7af6438.md"
rc=$( cd /tmp && python3 -I "$HERE/manifest-digests.py" --dir "$PACK" --write >/dev/null 2>&1; echo $? )
[ "$rc" = 1 ] && printf 'ok    %-26s rc=1 — refused to re-sign a tampered reviewer report\n' reviewer-row-resign \
             || { printf 'FAIL  %-26s rc=%s — a tampered reviewer report was re-signed\n' reviewer-row-resign "$rc"; fail=$((fail+1)); }
python3 - "$PACK/P14-HANDOFF-MANIFEST.md" <<'ZERO'
import re,sys
p=sys.argv[1]; L=open(p,encoding='utf-8').read().split('\n')
for k,l in enumerate(L):
    if l.startswith('| `P14-CHALLENGE-7af6438.md`'):
        L[k]=re.sub(r'`[0-9a-f]{64}`','`'+'0'*64+'`',l); break
open(p,'w',encoding='utf-8').write('\n'.join(L))
ZERO
out=$( cd /tmp && python3 -I "$HERE/manifest-digests.py" --dir "$PACK" --write 2>&1 ); rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q "does not move, in either direction"; then
  printf 'ok    %-26s rc=1 — a signed reviewer row cannot be moved back to unsigned\n' reviewer-row-unsign
else
  printf 'FAIL  %-26s rc=%s — the placeholder is still an escape hatch: %s\n' reviewer-row-unsign "$rc" \
         "$(printf '%s' "$out" | grep -m1 . | cut -c1-80)"; fail=$((fail+1))
fi
cp "$RB/rep.bak" "$PACK/P14-CHALLENGE-7af6438.md"; cp "$RB/man.bak" "$PACK/P14-HANDOFF-MANIFEST.md"; rm -rf "$RB"
rc=$( cd /tmp && python3 -I "$HERE/manifest-digests.py" --dir "$PACK" --check >/dev/null 2>&1; echo $? )
[ "$rc" = 0 ] || { printf 'FAIL  %-26s rc=%s — the proof did not restore the pack\n' reviewer-row-restore "$rc"; fail=$((fail+1)); }

red retracted-claim-planted \
  "printf '\n\nthe three absent ones are cited only for Phase 4 surface facts\n' >> '$PACK/README-AR.md'" \
  "python3 -I $HERE/retracted-claims.py --pack $PACK --check" 1 \
  "cp '$T/ar.bak' '$PACK/README-AR.md'" "$PACK/README-AR.md"
rm -rf "$T" "$FR" "$NR" "$ER" "$OP"

# ---- the no-cluster red proof (COORD-DIFF-REVIEW R1 P2-05, confirmed by
# execution in P14-CHALLENGE-583a4a0-ADDENDUM-01). The preflight red proofs used
# to print "5 arm(s), 0 not red" and exit 0 with NO PostgreSQL running at all,
# because psql's exit 2 (cannot connect) counted as a refusal. GATE-035 requires
# that script to exit 0, so the gate fencing the run-identity assertions passed
# most reliably when nothing was running. The fix must itself be fenced, so the
# cluster is STOPPED and the script is REQUIRED to fail.
if [ "$NODB" = 0 ] && [ -d /tmp/p14pg/data ]; then
  PGC="su claude -s /bin/bash -c"
  $PGC "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/p14pg/data -m fast -w stop" >/dev/null 2>&1
  rc=$( "$PACK/proofs/redproof-preflight.sh" >/dev/null 2>&1; echo $? )
  if [ "$rc" = 0 ]; then
    printf 'FAIL  %-26s rc=0 with the cluster STOPPED — "cannot connect" is being read as a refusal\n' no-cluster
    fail=$((fail+1))
  else
    printf 'ok    %-26s rc=%s with the cluster STOPPED (required non-zero)\n' no-cluster "$rc"
  fi
  $PGC "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/p14pg/data -o \"-p 54314 -c listen_addresses='' -k /tmp/p14pg/sock -c fsync=off\" -w start" >/dev/null 2>&1
  # R8-P3-04: the rolecount arm must be a proof about p14_resolver and not
  # about "some role". Rename a DIFFERENT one: the arm is required to FAIL.
  PSQL="/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -q -c"
  $PGC "$PSQL \"ALTER ROLE p14_merchant RENAME TO p14_merchant_x\"" >/dev/null 2>&1
  rc=$( "$PACK/proofs/redproof-preflight.sh" rolecount >/dev/null 2>&1; echo $? )
  $PGC "$PSQL \"ALTER ROLE p14_merchant_x RENAME TO p14_merchant\"" >/dev/null 2>&1
  if [ "$rc" = 0 ]; then
    printf 'FAIL  %-26s rc=0 after renaming p14_merchant — the arm cannot tell which role it removed\n' rolecount-discriminates
    fail=$((fail+1))
  else
    printf 'ok    %-26s rc=%s after renaming a DIFFERENT role (required non-zero)\n' rolecount-discriminates "$rc"
  fi
  out=$( "$PACK/proofs/redproof-preflight.sh" 2>&1 ); rc=$?
  if [ "$rc" = 0 ]; then
    printf 'ok    %-26s rc=0 again once the cluster is back (the proof reverted its own world)\n' no-cluster-revert
  else
    # ROUND-9 CHALLENGE P3-01: this line used to name ONE cause -- "the sweep
    # left the box broken" -- and in the reviewer's container that cause was
    # measurably false: the cluster was up and answering `select 1`, and the
    # real cause was that the unprivileged account could not READ the pack.
    # A refusal that names a cause must have asked it. So ask the cluster.
    if $PGC "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -qtAc 'select 1'" 2>/dev/null | grep -q 1; then
      printf 'FAIL  %-26s rc=%s while the cluster ANSWERS select 1 — so this is not the cluster: %s\n' \
             no-cluster-revert "$rc" "$(printf '%s' "$out" | grep -m1 -E 'FAIL|Permission|denied|No such' | cut -c1-90)"
    else
      printf 'FAIL  %-26s rc=%s and the cluster does not answer — the sweep left the box broken\n' no-cluster-revert "$rc"
    fi
    fail=$((fail+1))
  fi
  # ROUND-9 CHALLENGE P3-02, offered as a remedy and taken: the VERSION arm
  # cannot be proved against a real PG 17 cluster here, but its purpose is to
  # prove the assertion FIRES. The bound is mutated in a COPY of preflight.sql
  # and the specific abort is required. It remains UNFENCED for the narrower
  # claim that a real PG 17 cluster is refused, and that note stays.
  VC=$(mktemp -d); sed 's/v < 160000 OR v >= 170000/v < 170000 OR v >= 180000/' \
      "$PACK/proofs/preflight.sql" > "$VC/preflight.sql"; chmod 755 "$VC"; chmod 644 "$VC/preflight.sql"
  if grep -q 'v < 170000 OR v >= 180000' "$VC/preflight.sql"; then
    out=$( $PGC "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14_owner -d p14scratch -v ON_ERROR_STOP=1 -q -f $VC/preflight.sql" 2>&1 ); rc=$?
    if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q 'is not PostgreSQL 16'; then
      printf 'ok    %-26s rc=3 with the bound mutated, refused with "is not PostgreSQL 16"\n' version-arm-fires
    else
      printf 'FAIL  %-26s rc=%s — the version assertion did not fire: %s\n' version-arm-fires "$rc" \
             "$(printf '%s' "$out" | grep -m1 . | cut -c1-90)"; fail=$((fail+1))
    fi
  else
    printf 'FAIL  %-26s the bound mutation did not apply — nothing was proved\n' version-arm-fires
    fail=$((fail+1))
  fi
  rm -rf "$VC"
fi

[ -n "$WT2" ] && git -C "$REPO" worktree remove --force "$WT2" >/dev/null 2>&1
rm -rf "$WT"

echo "== $fail gate(s)/proof(s) not as required"
[ "$fail" -eq 0 ] || exit 1
