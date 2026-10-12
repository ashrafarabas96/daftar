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

# COORDINATOR RE-REVIEW AT a725342, R-11 (partial): the trap was installed long
# after the worktree was created, so a signal in between left a worktree
# registered in the repository; and `trap cleanup INT TERM` without an exit let
# the sweep CARRY ON after the signal, cleaning up under itself. The backups the
# cleanup needs do not exist yet here, so it is written to restore only what it
# finds, and it is installed FIRST.
T=$(mktemp -d); SCRATCH="${SCRATCH:-} $T"; WT=$(mktemp -d); SCRATCH="${SCRATCH:-} $WT"; WT2=""
cleanup() {
  [ -f "$T/doc.bak" ]   && cp "$T/doc.bak" "$DOC" 2>/dev/null
  [ -f "$T/man.bak" ]   && cp "$T/man.bak" "$PACK/P14-HANDOFF-MANIFEST.md" 2>/dev/null
  [ -f "$T/ar.bak" ]    && cp "$T/ar.bak" "$PACK/README-AR.md" 2>/dev/null
  [ -f "$T/rep.bak" ]   && cp "$T/rep.bak" "$PACK/P14-CHALLENGE-7af6438.md" 2>/dev/null
  [ -f "$T/coord.bak" ] && cp "$T/coord.bak" "$PACK/P14-COORD-DIFF-REVIEW-c812aa5.md" 2>/dev/null
  [ -n "${WT2:-}" ] && git -C "$REPO" worktree remove --force "$WT2" >/dev/null 2>&1
  # CHALLENGE R12-P3-01: the pack's FILES were inside the trap and the CLUSTER
  # was not. `no-cluster` stops the cluster and `rolecount-discriminates` renames
  # p14_merchant, so an interrupted sweep left one of those behind and the NEXT
  # sweep measured the residue -- one of the two causes behind the unexplained
  # red at 20:24:17Z. Restoring both costs these lines.
  # COORD-DIFF-REVIEW 03b3a0b, R-5: the pack's files and the cluster were inside
  # this trap and the proof scratch directories were not, so a TERM mid-run left
  # eight of them behind. Every `mktemp -d` this script makes is registered in
  # SCRATCH as it is created, and removed here.
  for _d in ${SCRATCH:-}; do
    case "$_d" in /tmp/*) rm -rf "$_d" ;; esac
  done
  if [ -n "${PGSTOPPED:-}" ] || [ -n "${PGRENAMED:-}" ]; then
    su claude -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/p14pg/data -l /tmp/p14pg/data/pg_ctl.log -o \"-p 54314 -c listen_addresses='' -k /tmp/p14pg/sock -c fsync=off\" -w start" >/dev/null 2>&1
    [ -n "${PGRENAMED:-}" ] && su claude -s /bin/bash -c "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -qc 'ALTER ROLE p14_merchant_x RENAME TO p14_merchant'" >/dev/null 2>&1
  fi
  rm -rf "$WT" "$T"
  return 0
}
trap cleanup EXIT
trap 'printf "\nINTERRUPTED: restoring the pack and leaving.\n" >&2; cleanup; exit 130' INT
trap 'printf "\nTERMINATED: restoring the pack and leaving.\n" >&2; cleanup; exit 143' TERM HUP

# A second worktree of the same repository: the case that broke the round-6 fix.
git -C "$REPO" worktree add -q "$WT/wt" HEAD 2>/dev/null && WT2="$WT/wt" || WT2=""
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
    # ROUND-10 CHALLENGE P3-01: this kept only the FIRST line, and the two
    # database gates print a banner first, so a permission failure under them
    # still read "consistent, but FAILING". The diagnostic line is chosen from
    # the WHOLE output, preferring an error over a banner.
    if [ -z "$out1" ]; then
      # CAUSE lines first, SUMMARY lines second: the summary is what a reader
      # already has (the gate failed), the cause is what they need. Preferring
      # `FAIL` over `psql said:` cost me a diagnosis within the hour of fixing
      # R10-P3-01, which is the same defect one layer in.
      out1=$(printf '%s' "$o" | grep -m1 -E 'Permission denied|No such file|command not found|psql said|CAUSE:|[Ee]rror:|ERROR|FATAL|WARNING|could not' | cut -c1-120)
      [ -z "$out1" ] && out1=$(printf '%s' "$o" | grep -m1 -E 'FAIL|STALE|CONFIGURATION ERROR|MEASUREMENT|ABORTED' | cut -c1-120)
      [ -z "$out1" ] && out1=$(printf '%s' "$o" | grep -m1 . | cut -c1-120)
    fi
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
# R12-P2-02's lesson applied to this run's ENTRY condition, after two sweeps
# answered 1 on both DB lanes with "Connection refused" and no attribution: the
# lanes below need a listening cluster, and until now the sweep never asked
# whether it had one. An unasserted premise turns into a red nobody can explain
# -- so ask, repair once, say which happened, and if it still cannot answer,
# declare the lanes BLOCKED instead of reporting a measurement of the pack.
if [ "$NODB" = 0 ]; then
  PGQ="su claude -s /bin/bash -c"
  pgup() { $PGQ "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -qtAc 'select 1'" 2>/dev/null | grep -q 1; }
  if ! pgup; then
    printf 'note  %-26s the cluster was NOT listening when this run started, so the two DB
' db-precondition
    printf '      lanes would have measured that and not the pack. Starting it once.
'
    # -l so the next unexplained stop is attributable: until now the postmaster's
    # stderr went to /dev/null and no shutdown could be read back from anything.
    $PGQ "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/p14pg/data -l /tmp/p14pg/data/pg_ctl.log -o \"-p 54314 -c listen_addresses='' -k /tmp/p14pg/sock -c fsync=off\" -w start" >/dev/null 2>&1
    if pgup; then
      printf 'ok    %-26s the cluster was down at the start and this run started it; the DB
' db-precondition
      printf '      lanes below are measured against a cluster this run brought up.
'
    else
      printf 'FAIL  %-26s the cluster is not listening on /tmp/p14pg/sock:54314 and this run
' db-precondition
      printf '      could not start it, so the DB lanes are BLOCKED, not measured. Nothing
'
      printf '      below says anything about replay or the preflight.
'
      fail=$((fail+1)); NODB=1
    fi
  else
    printf 'ok    %-26s the cluster answers `select 1` before any DB lane runs
' db-precondition
  fi
fi
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
cp "$DOC" "$T/doc.bak"; cp "$PACK/P14-HANDOFF-MANIFEST.md" "$T/man.bak"
cp "$PACK/README-AR.md" "$T/ar.bak"
cp "$PACK/P14-CHALLENGE-7af6438.md" "$T/rep.bak"
cp "$PACK/P14-COORD-DIFF-REVIEW-c812aa5.md" "$T/coord.bak" 2>/dev/null

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
NR=$(mktemp -d); SCRATCH="${SCRATCH:-} $NR"; mkdir -p "$NR/inner"; cp -r "$PACK" "$NR/inner/phase14"
named provenance-not-a-repo 2 "is not a git repository" \
  "python3 -I $HERE/citation-provenance.py --pack $NR/inner/phase14 --repo $NR --check $NR/inner/phase14/P14-MIGRATION-PATCH-REQUEST.md"

# (b) --repo IS a repository but does not carry the declared base.
FR=$(mktemp -d); SCRATCH="${SCRATCH:-} $FR"; git -C "$FR" init -q
named provenance-repo-without-base 2 "does not contain 93084f8" \
  "python3 -I $HERE/citation-provenance.py --check $DOC --repo $FR"

# (c) the ROUND-7 remedy itself, which had never been red-proofed: a repository
# that does carry the revisions, with the pack OUTSIDE it, so every pathspec
# would climb out of the tree.
OP=$(mktemp -d); SCRATCH="${SCRATCH:-} $OP"; cp -r "$PACK" "$OP/phase14"
named provenance-pack-outside-repo 2 "is not inside --repo" \
  "python3 -I $HERE/citation-provenance.py --pack $OP/phase14 --repo $REPO --check $OP/phase14/P14-MIGRATION-PATCH-REQUEST.md"

# (d) and (e): a real repository, with the pack inside it so the ancestry
# refusal cannot fire instead, whose committed tree knows nothing of the cited
# files. My first attempt at (d) used the repository's own root commit, which
# already carries 972 files: it answered 1, the proof was wrong, and the sweep
# caught it.
ER=$(mktemp -d); SCRATCH="${SCRATCH:-} $ER"; git -C "$ER" init -q
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
RB=$(mktemp -d); SCRATCH="${SCRATCH:-} $RB"; cp "$PACK/P14-CHALLENGE-7af6438.md" "$RB/rep.bak"; cp "$PACK/P14-HANDOFF-MANIFEST.md" "$RB/man.bak"
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
# ROUND-10: this arm used to require the sentence "does not move, in either
# direction", which was the HEAD-only rule's wording. Against the real pack the
# refusal now comes from the two-directory witness -- the shared folder still
# holds the pristine report -- so that is the sentence required here, and the
# committed-unsign and no-repository routes have their own constructed proofs
# below.
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q "REVIEWER COPIES DIFFER"; then
  printf 'ok    %-26s rc=1 — the other directory contradicts the zeroed row\n' reviewer-row-unsign
else
  printf 'FAIL  %-26s rc=%s — the placeholder is still an escape hatch: %s\n' reviewer-row-unsign "$rc" \
         "$(printf '%s' "$out" | grep -m1 . | cut -c1-80)"; fail=$((fail+1))
fi
cp "$RB/rep.bak" "$PACK/P14-CHALLENGE-7af6438.md"; cp "$RB/man.bak" "$PACK/P14-HANDOFF-MANIFEST.md"; rm -rf "$RB"
rc=$( cd /tmp && python3 -I "$HERE/manifest-digests.py" --dir "$PACK" --check >/dev/null 2>&1; echo $? )
[ "$rc" = 0 ] || { printf 'FAIL  %-26s rc=%s — the proof did not restore the pack\n' reviewer-row-restore "$rc"; fail=$((fail+1)); }

# ROUND-10 CHALLENGE P2-01, which BLOCKED: both round-9 proofs covered only
# UNCOMMITTED transitions, so one ordinary `git commit -am` of the UNSIGNED row
# made the rule disable itself, and the non-repository route stayed open. The
# rule now rests on the two-directory witness and on the WHOLE history, and all
# three routes are proved here, each by its own refusal sentence.
RW=$(mktemp -d); SCRATCH="${SCRATCH:-} $RW"; cp -r "$PACK" "$RW/pack"; cp -r "$PACK" "$RW/witness"
( cd "$RW/pack" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' ) >/dev/null 2>&1
printf '\n\nthe three absent ones are cited only for Phase 4 surface facts\n' >> "$RW/pack/P14-CHALLENGE-7af6438.md"
RWM="--manifest $RW/pack/P14-HANDOFF-MANIFEST.md --dir $RW/pack"
named reviewer-row-two-dirs 1 "REVIEWER COPIES DIFFER" \
  "python3 -I $HERE/manifest-digests.py $RWM --witness $RW/witness --write"
# now the round-10 bypass itself: both cells set to UNSIGNED and COMMITTED, so
# HEAD carries the placeholder, with no counterpart directory to fall back on.
python3 - "$RW/pack/P14-HANDOFF-MANIFEST.md" <<'UNSIGN'
import re,sys
p=sys.argv[1]; L=open(p,encoding='utf-8').read().split('\n')
for k,l in enumerate(L):
    if l.startswith('| `P14-CHALLENGE-7af6438.md`'):
        l=re.sub(r'`[0-9a-f]{64}`','`UNSIGNED`',l)
        L[k]=re.sub(r'\| [0-9,]+ \|$','| UNSIGNED |',l); break
open(p,'w',encoding='utf-8').write('\n'.join(L))
UNSIGN
( cd "$RW/pack" && git -c user.email=p14@local -c user.name=p14 commit -qam 'unsign the row' ) >/dev/null 2>&1
EMPTYW=$(mktemp -d); SCRATCH="${SCRATCH:-} $EMPTYW"
named reviewer-row-committed-unsign 1 "a signed reviewer row does not move" \
  "python3 -I $HERE/manifest-digests.py $RWM --witness $EMPTYW --write"
# and the non-repository route, which round 9 disclosed and did not close.
cp -r "$RW/pack" "$RW/norepo"; rm -rf "$RW/norepo/.git"
named reviewer-row-no-repo 1 "REVIEWER COPIES DIFFER" \
  "python3 -I $HERE/manifest-digests.py --manifest $RW/norepo/P14-HANDOFF-MANIFEST.md --dir $RW/norepo --witness $RW/witness --write"
named reviewer-row-no-witness 1 "NO WITNESS" \
  "python3 -I $HERE/manifest-digests.py --manifest $RW/norepo/P14-HANDOFF-MANIFEST.md --dir $RW/norepo --witness $EMPTYW --write"
rm -rf "$RW" "$EMPTYW"

# COORD DIFF REVIEW AT c812aa5, P2-01, which BLOCKED: round 10 closed the
# committed-PLACEHOLDER route and left the committed-FORGERY route open -- the
# revision walk was newest-first with setdefault, so the witness was whatever
# HEAD last recorded, and a tampered report plus a hand-forged row plus one
# `git commit -am` returned 0 while printing "checked over every revision". The
# witness is now the OLDEST recorded digest. Both shapes the reviewer measured
# are proved here, and so are the two protections that were resting on the
# two-directory construction (R-02, R-03) and the incomplete-history case (R-08).
FW=$(mktemp -d); SCRATCH="${SCRATCH:-} $FW"; cp -r "$PACK" "$FW/pack"; cp -r "$PACK" "$FW/witness"
( cd "$FW/pack" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' ) >/dev/null 2>&1
FWM="--manifest $FW/pack/P14-HANDOFF-MANIFEST.md --dir $FW/pack"
EMPTYW=$(mktemp -d); SCRATCH="${SCRATCH:-} $EMPTYW"
forge() { # tamper one reviewer report in $1 and hand-forge its row to match,
          # in $1's manifest or in the manifest named as $2 (CHALLENGE R14-P2-01,
          # where the manifest has been renamed and moved out of the pack).
  local d="$1" rep=P14-CHALLENGE-7af6438.md
  printf '\n\nan appended line nobody received\n' >> "$d/$rep"
  python3 - "$d/$rep" "${2:-$d/P14-HANDOFF-MANIFEST.md}" <<'FORGE'
import hashlib,os,re,sys
rep,man=sys.argv[1],sys.argv[2]
b=open(rep,'rb').read(); h=hashlib.sha256(b).hexdigest()
L=open(man,encoding='utf-8').read().split('\n')
for k,l in enumerate(L):
    if l.startswith('| `%s`' % os.path.basename(rep)):
        l=re.sub(r'`[0-9a-f]{64}`','`%s`' % h,l)
        L[k]=re.sub(r'\| [0-9,]+ \|$','| %s |' % format(len(b),','),l); break
open(man,'w',encoding='utf-8').write('\n'.join(L))
FORGE
}
forge "$FW/pack"
( cd "$FW/pack" && git -c user.email=p14@local -c user.name=p14 commit -qam 'forge the row to match' ) >/dev/null 2>&1
named reviewer-row-committed-forgery 1 "REWRITTEN IN HISTORY" \
  "python3 -I $HERE/manifest-digests.py $FWM --witness $EMPTYW --write"
# ...and with the counterpart changed in step, which is the shape that defeats
# the two-directory witness and leaves the history as the only one left.
cp "$FW/pack/P14-CHALLENGE-7af6438.md" "$FW/witness/P14-CHALLENGE-7af6438.md"
named reviewer-row-forged-both-dirs 1 "REWRITTEN IN HISTORY" \
  "python3 -I $HERE/manifest-digests.py $FWM --witness $FW/witness --write"
# R-02: a received review deleted together with its row.
DW=$(mktemp -d); SCRATCH="${SCRATCH:-} $DW"; cp -r "$PACK" "$DW/pack"
( cd "$DW/pack" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' ) >/dev/null 2>&1
rm -f "$DW/pack/P14-CHALLENGE-7af6438.md"
grep -v '^| `P14-CHALLENGE-7af6438.md` |' "$DW/pack/P14-HANDOFF-MANIFEST.md" > "$DW/m" \
  && mv "$DW/m" "$DW/pack/P14-HANDOFF-MANIFEST.md"
named reviewer-row-deleted 1 "SIGNED REVIEWER ROW REMOVED" \
  "python3 -I $HERE/manifest-digests.py --manifest $DW/pack/P14-HANDOFF-MANIFEST.md --dir $DW/pack --witness $EMPTYW --check"
# R-03: a coordinator's review is a review. Tampered in one directory only, so
# the refusal must come from the reviewer-row rules and not from a stale digest.
CW=$(mktemp -d); SCRATCH="${SCRATCH:-} $CW"; cp -r "$PACK" "$CW/pack"; cp -r "$PACK" "$CW/witness"
printf '\n\nan appended line nobody received\n' >> "$CW/pack/P14-COORD-DIFF-REVIEW-583a4a0.md"
named coord-review-protected 1 "REVIEWER COPIES DIFFER" \
  "python3 -I $HERE/manifest-digests.py --manifest $CW/pack/P14-HANDOFF-MANIFEST.md --dir $CW/pack --witness $CW/witness --write"
# R-08: an incomplete history must not answer. A grafted commit reports no
# parents exactly as a root commit does, so a `--depth 1` clone looks complete
# until the graft list is read -- measured, such a clone printed "checked over
# every revision" over ONE truncated revision. The witness is now discarded
# there, which makes every reviewer row with no counterpart NO WITNESS: loud and
# fail-closed, instead of quietly trusting the oldest digest that survived.
SW=$(mktemp -d); SCRATCH="${SCRATCH:-} $SW"; SW2=$(mktemp -d); SCRATCH="${SCRATCH:-} $SW2"; EMPTYW2=$(mktemp -d); SCRATCH="${SCRATCH:-} $EMPTYW2"
( cd "$FW/pack" && git -c user.email=p14@local -c user.name=p14 commit -qam 'another revision' \
    --allow-empty ) >/dev/null 2>&1
# the R11-P2-01 world: a depth-1 clone of the SAME forged repository, with a
# counterpart carrying the same tampered bytes, so the two-directory witness
# agrees and cannot be what refuses.
git clone -q --depth 1 "file://$FW/pack" "$SW2/shallow" >/dev/null 2>&1
if [ -d "$SW2/shallow/.git" ]; then
  cp -r "$SW2/shallow" "$SW2/counterpart"; rm -rf "$SW2/counterpart/.git"
fi
git clone -q --depth 1 "file://$FW/pack" "$SW/shallow" >/dev/null 2>&1
if [ -d "$SW/shallow/.git" ]; then
  named history-truncated-not-checked 1 "shallow boundary" \
    "python3 -I $HERE/manifest-digests.py --manifest $SW/shallow/P14-HANDOFF-MANIFEST.md --dir $SW/shallow --witness $EMPTYW --check"
else
  printf 'FAIL  %-26s the shallow clone was not created — nothing was proved\n' history-truncated-not-checked
  fail=$((fail+1))
fi
# CHALLENGE R11-P2-01 and the COORDINATOR RE-REVIEW's remedy: a truncated clone
# WITH a matching counterpart used to answer 0, announcing NOT CHECKED. An
# announced blind spot still exits 0, and the exit code is what a gate is read
# by -- so NOT CHECKED now REFUSES by default, and a caller who accepts the
# limit says so with --allow-unverified-history. All three states are proved:
# the refusal, the explicit opt-in (which must still PRINT the limit), and the
# no-counterpart case, whose sentence names the clone rather than claiming no
# revision ever recorded a digest (R11-P2-02).
if [ -d "$SW2/shallow/.git" ]; then
  SWM="--manifest $SW2/shallow/P14-HANDOFF-MANIFEST.md --dir $SW2/shallow"
  named shallow-counterpart-refused 1 "HISTORY NOT VERIFIED" \
    "python3 -I $HERE/manifest-digests.py $SWM --witness $SW2/counterpart --check"
  named shallow-optin-prints-the-limit 0 "NOT CHECKED" \
    "python3 -I $HERE/manifest-digests.py $SWM --witness $SW2/counterpart --check --allow-unverified-history"
  named shallow-no-witness-names-the-clone 1 "visible in the revisions this clone has" \
    "python3 -I $HERE/manifest-digests.py $SWM --witness $EMPTYW2 --check"
  # CHALLENGE R12-P2-01, a FAIL-OPEN: `HISTORY NOT VERIFIED` fired only while a
  # reviewer row SURVIVED in the manifest, and the detector that would have
  # caught the deletion (`SIGNED ROW REMOVED`) reads the history the same
  # NOT CHECKED empties. Both protections were switched off by one condition, so
  # "this manifest never had a reviewer row" and "every one was just deleted"
  # were indistinguishable and the permissive reading won: every reviewer row and
  # file removed in a depth-1 clone answered 0, "every artifact row matches",
  # while the counterpart directory held all of them unread. The refusal now
  # consults that directory, so the removal is refused by what was received.
  RD=$(mktemp -d); SCRATCH="${SCRATCH:-} $RD"; cp -r "$SW2/shallow" "$RD/shallow" >/dev/null 2>&1
  cp -r "$PACK" "$RD/counterpart" >/dev/null 2>&1; rm -rf "$RD/counterpart/.git"
  RDN=$(python3 - "$RD/shallow" <<'STRIP'
import os,re,sys
d=sys.argv[1]; man=os.path.join(d,'P14-HANDOFF-MANIFEST.md')
pre=('P14-CHALLENGE-','P14-COORD-DIFF-REVIEW-')
L=open(man,encoding='utf-8').read().split('\n'); keep=[]; n=0
for l in L:
    m=re.match(r'^\| `([^`]+)`', l)
    if m and m.group(1).startswith(pre):
        n+=1
        try: os.remove(os.path.join(d,m.group(1)))
        except OSError: pass
        continue
    keep.append(l)
open(man,'w',encoding='utf-8').write('\n'.join(keep))
print(n)
STRIP
)
  RDM="--manifest $RD/shallow/P14-HANDOFF-MANIFEST.md --dir $RD/shallow"
  if [ -d "$RD/shallow/.git" ] && [ "${RDN:-0}" -ge 10 ] \
     && ! ls "$RD/shallow"/P14-CHALLENGE-* >/dev/null 2>&1; then
    named shallow-every-review-deleted 1 "HISTORY NOT VERIFIED" \
      "python3 -I $HERE/manifest-digests.py $RDM --witness $RD/counterpart --check"
    named shallow-every-review-deleted-names-them 1 "have NO ROW here" \
      "python3 -I $HERE/manifest-digests.py $RDM --witness $RD/counterpart --check"
  else
    printf 'FAIL  %-26s the world was not built (%s row(s) stripped) — nothing was proved\n' \
           shallow-every-review-deleted "${RDN:-<none>}"
    fail=$((fail+1))
  fi
  rm -rf "$RD"
else
  printf 'FAIL  %-26s the shallow clone with a counterpart was not created — nothing was proved\n' shallow-counterpart-refused
  fail=$((fail+1))
fi

# COORDINATOR RE-REVIEW AT a725342, P2-01-bis, which BLOCKED: two ordinary
# commits -- `git rm` the manifest, then re-add it carrying a forged row -- made
# the walk treat a DELETION revision as unreadable, discard the whole witness,
# and pass the forgery at 0 with the counterpart edited in step. In a full
# history a deletion is not a truncation. Proved here on the whole route.
DR=$(mktemp -d); SCRATCH="${SCRATCH:-} $DR"; cp -r "$PACK" "$DR/pack"
( cd "$DR/pack" && rm -rf .git && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' ) >/dev/null 2>&1
forge "$DR/pack"
cp "$DR/pack/P14-HANDOFF-MANIFEST.md" "$DR/forged-manifest.md"
( cd "$DR/pack" \
  && git checkout -q -- P14-HANDOFF-MANIFEST.md \
  && git add P14-CHALLENGE-7af6438.md \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'a line appended to a received report' \
  && git rm -q P14-HANDOFF-MANIFEST.md \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'drop the manifest' \
  && cp "$DR/forged-manifest.md" P14-HANDOFF-MANIFEST.md \
  && git add P14-HANDOFF-MANIFEST.md \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 're-add the manifest' ) >/dev/null 2>&1
cp -r "$DR/pack" "$DR/counterpart"; rm -rf "$DR/counterpart/.git"
DRM="--manifest $DR/pack/P14-HANDOFF-MANIFEST.md --dir $DR/pack"
if [ "$(cd "$DR/pack" && git rev-list --count HEAD)" = 4 ]; then
  named manifest-dropped-and-readded 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $DRM --witness $DR/counterpart --check"
  named manifest-dropped-and-readded-write 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $DRM --witness $DR/counterpart --write"
  # CHALLENGE R12-P1-01's control: a GENUINE deletion revision must still be
  # SKIPPED AND RECORDED, not read as an unreadable record. This is the half of
  # the discrimination that the blobless proof below cannot show.
  named deletion-revision-still-skipped 1 "ABSENT in 1 of them" \
    "python3 -I $HERE/manifest-digests.py $DRM --witness $DR/counterpart --check"
else
  printf 'FAIL  %-26s the drop/re-add world was not built (%s commits) — nothing was proved\n' \
         manifest-dropped-and-readded "$(cd "$DR/pack" && git rev-list --count HEAD 2>/dev/null)"
  fail=$((fail+1))
fi
rm -rf "$DR"

# CHALLENGE R12-P1-01, which BLOCKED: the remedy for P2-01-bis asked git ONE
# question -- `git cat-file -e <rev>:<path>` -- that fails for TWO reasons, "the
# path is not in that tree" and "the path is there but its BLOB is not
# available". Reading the second as a deletion skipped the revision, kept
# walking, and printed "checked over every revision ... ABSENT in 1 of them":
# two false sentences, the witness erased, and a forged reviewer row at rc 0
# with no flag and no limit announced. A --filter=blob:none clone whose promisor
# cannot be reached is that world, and it is a normal CI shape. Built here as a
# real partial clone, with the premise asserted before anything is judged.
BLW=$(mktemp -d); SCRATCH="${SCRATCH:-} $BLW"; cp -r "$PACK" "$BLW/origin"
( cd "$BLW/origin" && rm -rf .git && git init -q . && git config uploadpack.allowFilter true \
  && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' ) >/dev/null 2>&1
forge "$BLW/origin"
( cd "$BLW/origin" && git -c user.email=p14@local -c user.name=p14 commit -qam 'forge the row to match' ) >/dev/null 2>&1
git clone -q --filter=blob:none "file://$BLW/origin" "$BLW/partial" >/dev/null 2>&1
git -C "$BLW/partial" remote set-url origin "file://$BLW/promisor-that-is-not-there" >/dev/null 2>&1
cp -r "$BLW/partial" "$BLW/counterpart"; rm -rf "$BLW/counterpart/.git"
BLM="--manifest $BLW/partial/P14-HANDOFF-MANIFEST.md --dir $BLW/partial --witness $BLW/counterpart"
BLOLD=$(git -C "$BLW/partial" rev-list HEAD 2>/dev/null | tail -1)
# The premise of this proof is a tree entry WITH an unreadable blob. If the
# transport ignored the filter, or the promisor is still reachable, the world is
# a different one and nothing is proved -- so say that instead of a verdict.
if [ -n "$BLOLD" ] \
   && [ -n "$(git -C "$BLW/partial" ls-tree --name-only "$BLOLD" -- P14-HANDOFF-MANIFEST.md 2>/dev/null)" ] \
   && ! git -C "$BLW/partial" show "$BLOLD:./P14-HANDOFF-MANIFEST.md" >/dev/null 2>&1; then
  named blobless-clone-refused 1 "unreachable" \
    "python3 -I $HERE/manifest-digests.py $BLM --check"
  named blobless-clone-write-refused 1 "unreachable" \
    "python3 -I $HERE/manifest-digests.py $BLM --write"
  # ...and the limit is still PRINTED when the caller accepts it deliberately,
  # so the opt-in cannot be used to make the tool say "checked".
  named blobless-optin-prints-the-limit 0 "its content could not be read" \
    "python3 -I $HERE/manifest-digests.py $BLM --check --allow-unverified-history"
else
  printf 'FAIL  %-26s the blobless world was not built (oldest=%s, tree entry=%s) — nothing was proved\n' \
         blobless-clone-refused "${BLOLD:-<none>}" \
         "$(git -C "$BLW/partial" ls-tree --name-only "${BLOLD:-HEAD}" -- P14-HANDOFF-MANIFEST.md 2>/dev/null | head -1)"
  fail=$((fail+1))
fi
rm -rf "$BLW"

# CHALLENGE R13-P2-01: the walk assumed the tracked path was a REGULAR FILE. With
# the manifest committed as a SYMLINK every revision reads as the link text, no
# row parses, the witness stays empty -- and the printed line still said "checked
# over every revision of the manifest, OLDEST first", rc 0 on a tampered report
# whose counterpart agrees. Two worlds are fenced: the mode, and the wider case
# of a history that was read in full and recorded nothing. The symlink points
# OUTSIDE the pack directory, or the extra file would be refused as an artifact
# with no row and the proof would pass for a reason that is not the one named.
SYW=$(mktemp -d); SCRATCH="${SCRATCH:-} $SYW"; cp -r "$PACK" "$SYW/pack"
( cd "$SYW/pack" && rm -rf .git && git init -q . \
  && mv P14-HANDOFF-MANIFEST.md tools/real-manifest.md \
  && ln -s tools/real-manifest.md P14-HANDOFF-MANIFEST.md \
  && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'the manifest as a symlink' ) >/dev/null 2>&1
# forge against the REAL file the link points at, so the rows on disk are sound
( cd "$SYW/pack" && printf '\n\nan appended line nobody received\n' >> P14-CHALLENGE-7af6438.md ) 2>/dev/null
python3 - "$SYW/pack/P14-CHALLENGE-7af6438.md" "$SYW/pack/tools/real-manifest.md" <<'SFORGE'
import hashlib,os,re,sys
rep,man=sys.argv[1],sys.argv[2]
b=open(rep,'rb').read(); h=hashlib.sha256(b).hexdigest()
L=open(man,encoding='utf-8').read().split(chr(10))
for k,l in enumerate(L):
    if l.startswith('| `%s`' % os.path.basename(rep)):
        l=re.sub(r'`[0-9a-f]{64}`','`%s`' % h,l)
        L[k]=re.sub(r'\| [0-9,]+ \|$','| %s |' % format(len(b),','),l); break
open(man,'w',encoding='utf-8').write(chr(10).join(L))
SFORGE
( cd "$SYW/pack" && git -c user.email=p14@local -c user.name=p14 commit -qam 'forge the row to match' ) >/dev/null 2>&1
cp -r "$SYW/pack" "$SYW/counterpart"; rm -rf "$SYW/counterpart/.git"
SYM="--manifest $SYW/pack/P14-HANDOFF-MANIFEST.md --dir $SYW/pack --witness $SYW/counterpart"
# Both halves of the premise are asserted: the mode, and that the FORGE LANDED.
# Without the second, this proof passes on a world where nothing was tampered at
# all, which would make it a proof about a symlink and not about a forgery
# surviving one -- a red proof passing for a reason that is not the one named.
SYMODE=$(cd "$SYW/pack" && git ls-tree HEAD -- P14-HANDOFF-MANIFEST.md | cut -d' ' -f1)
SYHASH=$(sha256sum "$SYW/pack/P14-CHALLENGE-7af6438.md" 2>/dev/null | cut -d' ' -f1)
if [ "$SYMODE" = 120000 ] && [ -n "$SYHASH" ] \
   && grep -q "$SYHASH" "$SYW/pack/tools/real-manifest.md" 2>/dev/null; then
  named symlink-manifest-refused 1 "not a regular file" \
    "python3 -I $HERE/manifest-digests.py $SYM --check"
else
  printf 'FAIL  %-26s the world was not built (mode=%s, forged row present=%s) — nothing was proved\n' \
         symlink-manifest-refused "${SYMODE:-<none>}" \
         "$(grep -qc "$SYHASH" "$SYW/pack/tools/real-manifest.md" 2>/dev/null && echo yes || echo no)"
  fail=$((fail+1))
fi
rm -rf "$SYW"

# ...and the wider half: a history read IN FULL that records no reviewer digest
# said the same words as one that verified nineteen. "checked" is a claim about
# what was FOUND. Here every reviewer row is `UNSIGNED` in the one revision and
# signed on disk, so the walk is complete and the record is empty.
NRW=$(mktemp -d); SCRATCH="${SCRATCH:-} $NRW"; cp -r "$PACK" "$NRW/pack"; cp "$PACK/P14-HANDOFF-MANIFEST.md" "$NRW/received.md"
NRN=$(python3 - "$NRW/pack/P14-HANDOFF-MANIFEST.md" <<'UNSIGN'
import re,sys
p=sys.argv[1]; L=open(p,encoding='utf-8').read().split(chr(10))
pre=('P14-CHALLENGE-','P14-COORD-DIFF-REVIEW-'); n=0
for k,l in enumerate(L):
    m=re.match(r'^\| `([^`]+)`', l)
    if m and m.group(1).startswith(pre):
        L[k]=re.sub(r'`[0-9a-f]{64}`','`UNSIGNED`',l); n+=1
open(p,'w',encoding='utf-8').write(chr(10).join(L)); print(n)
UNSIGN
)
( cd "$NRW/pack" && rm -rf .git && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'every reviewer row unsigned in the history' ) >/dev/null 2>&1
cp "$NRW/received.md" "$NRW/pack/P14-HANDOFF-MANIFEST.md"
cp -r "$NRW/pack" "$NRW/counterpart"; rm -rf "$NRW/counterpart/.git"
NRM="--manifest $NRW/pack/P14-HANDOFF-MANIFEST.md --dir $NRW/pack --witness $NRW/counterpart"
if [ "${NRN:-0}" -ge 10 ]; then
  named no-record-in-any-revision 1 "NO RECORD IN ANY REVISION" \
    "python3 -I $HERE/manifest-digests.py $NRM --check"
else
  printf 'FAIL  %-26s only %s reviewer row(s) unsigned — nothing was proved\n' \
         no-record-in-any-revision "${NRN:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$NRW"

# COORDINATOR DIFF REVIEW AT 03b3a0b, B2 (P2-01-ter), which BLOCKED: ONE ordinary
# commit that moves the pack directory while forging a reviewer row made the
# forging commit the oldest revision AT THE NEW PATH, so the walk read 1 of 20
# revisions and still printed "checked over every revision", rc 0 in both lanes
# and with NO counterpart. The pack is nested one directory deep here so the move
# is a real rename of a parent, as a promotion would be.
MVW=$(mktemp -d); SCRATCH="${SCRATCH:-} $MVW"; mkdir -p "$MVW/repo/a"; cp -r "$PACK" "$MVW/repo/a/phase14"
( cd "$MVW/repo" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' \
  && mkdir -p b && git mv a/phase14 b/phase14 ) >/dev/null 2>&1
forge "$MVW/repo/b/phase14"
( cd "$MVW/repo" && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'promote: move the pack' ) >/dev/null 2>&1
MVM="--manifest $MVW/repo/b/phase14/P14-HANDOFF-MANIFEST.md --dir $MVW/repo/b/phase14"
# The premise: at the NEW path there is exactly one revision, and by name there
# are two. Without that, the proof is not about a rename at all.
MVP=$(cd "$MVW/repo" && git rev-list HEAD -- b/phase14/P14-HANDOFF-MANIFEST.md | wc -l)
MVN=$(cd "$MVW/repo" && git rev-list HEAD -- ':(top,glob)**/P14-HANDOFF-MANIFEST.md' | wc -l)
if [ "$MVP" = 1 ] && [ "$MVN" = 2 ]; then
  # no counterpart at all, which is the CI shape and leaves the history as the
  # only witness there is.
  named manifest-moved-and-forged 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $MVM --witness $MVW/none --check"
  named manifest-moved-and-forged-write 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $MVM --witness $MVW/none --write"
else
  printf 'FAIL  %-26s the move world was not built (%s revision(s) at the new path, %s by name) — nothing was proved\n' \
         manifest-moved-and-forged "${MVP:-<none>}" "${MVN:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$MVW"

# COORDINATOR DIFF REVIEW AT 03b3a0b, B3, which BLOCKED: under NOT CHECKED the
# refusal fired only while a reviewer row or a READABLE counterpart report
# survived, and `os.listdir` raising was mapped to "holds none" -- so a depth-1
# clone with every reviewer row and file deleted answered 0 whenever the
# counterpart was ABSENT (the CI shape: no shared folder), a regular file, or an
# empty directory. All four shapes are proved, and so is the deliberate opt-in.
B3W=$(mktemp -d); SCRATCH="${SCRATCH:-} $B3W"; cp -r "$PACK" "$B3W/origin"
( cd "$B3W/origin" && rm -rf .git && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' \
  && git -c user.email=p14@local -c user.name=p14 commit -q --allow-empty -m 'another revision' ) >/dev/null 2>&1
git clone -q --depth 1 "file://$B3W/origin" "$B3W/clone" >/dev/null 2>&1
mkdir -p "$B3W/empty"; printf 'not a directory\n' > "$B3W/plainfile"
B3N=$(python3 - "$B3W/clone" <<'B3STRIP'
import os,re,sys
d=sys.argv[1]; man=os.path.join(d,'P14-HANDOFF-MANIFEST.md')
pre=('P14-CHALLENGE-','P14-COORD-DIFF-REVIEW-')
L=open(man,encoding='utf-8').read().split(chr(10)); keep=[]; n=0
for l in L:
    m=re.match(r'^\| `([^`]+)`', l)
    if m and m.group(1).startswith(pre):
        n+=1
        try: os.remove(os.path.join(d,m.group(1)))
        except OSError: pass
        continue
    keep.append(l)
open(man,'w',encoding='utf-8').write(chr(10).join(keep)); print(n)
B3STRIP
)
B3M="--manifest $B3W/clone/P14-HANDOFF-MANIFEST.md --dir $B3W/clone"
if [ -d "$B3W/clone/.git" ] && [ "${B3N:-0}" -ge 10 ] \
   && ! ls "$B3W/clone"/P14-CHALLENGE-* >/dev/null 2>&1; then
  named shallow-no-counterpart-refused 1 "HISTORY NOT VERIFIED" \
    "python3 -I $HERE/manifest-digests.py $B3M --witness $B3W/nonexistent --check"
  named shallow-counterpart-is-a-file 1 "HISTORY NOT VERIFIED" \
    "python3 -I $HERE/manifest-digests.py $B3M --witness $B3W/plainfile --check"
  named shallow-counterpart-empty 1 "HISTORY NOT VERIFIED" \
    "python3 -I $HERE/manifest-digests.py $B3M --witness $B3W/empty --check"
  named shallow-no-counterpart-optin 0 "NOT CHECKED" \
    "python3 -I $HERE/manifest-digests.py $B3M --witness $B3W/nonexistent --check --allow-unverified-history"
else
  printf 'FAIL  %-26s the world was not built (%s row(s) stripped) — nothing was proved\n' \
         shallow-no-counterpart-refused "${B3N:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$B3W"

# CHALLENGE R14-P2-01: the NAME anchor closed a MOVE and not a move plus a
# RENAME to a different basename, in the same commit as the forge. Then the new
# basename has one revision -- the forging one -- and the walk read 1 of 3 and
# said "checked". The coordinator ruled it must refuse by name under EVERY
# invocation, not only under the gate's default `--manifest`, so this proof
# points the verifier AT the renamed file, which is the shape that answered 0.
RVW=$(mktemp -d); SCRATCH="${SCRATCH:-} $RVW"; mkdir -p "$RVW/repo/a"; cp -r "$PACK" "$RVW/repo/a/phase14"
( cd "$RVW/repo" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' \
  && git -c user.email=p14@local -c user.name=p14 commit -q --allow-empty -m 'another revision' \
  && mkdir -p elsewhere && git mv a/phase14/P14-HANDOFF-MANIFEST.md elsewhere/LEDGER.md ) >/dev/null 2>&1
forge "$RVW/repo/a/phase14" "$RVW/repo/elsewhere/LEDGER.md"
( cd "$RVW/repo" && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'promote: rename and move the ledger' ) >/dev/null 2>&1
RVM="--manifest $RVW/repo/elsewhere/LEDGER.md --dir $RVW/repo/a/phase14"
# Premise: the NEW basename has exactly one revision, and `--follow` sees more.
RVB=$(cd "$RVW/repo" && git rev-list HEAD -- ':(top,glob)**/LEDGER.md' | wc -l)
RVF=$(cd "$RVW/repo" && git log --follow --format=%H -- elsewhere/LEDGER.md | wc -l)
if [ "$RVB" = 1 ] && [ "$RVF" -gt 1 ]; then
  named manifest-renamed-and-moved 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $RVM --witness $RVW/none --check"
  named manifest-renamed-and-moved-write 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $RVM --witness $RVW/none --write"
else
  printf 'FAIL  %-26s the rename world was not built (%s by basename, %s by --follow) — nothing was proved\n' \
         manifest-renamed-and-moved "${RVB:-<none>}" "${RVF:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$RVW"
rm -rf "$FW" "$DW" "$CW" "$SW" "$SW2" "$EMPTYW" "$EMPTYW2"

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
  PGSTOPPED=1
  $PGC "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/p14pg/data -m fast -w stop" >/dev/null 2>&1
  # COORD DIFF REVIEW AT c812aa5, R-05: this proof required only "non-zero", so
  # the lock refusal (exit 4) or a missing `flock` (exit 5) satisfied it without
  # anything being measured -- a red proof passing for the wrong reason, which is
  # the defect this proof exists to fence. It requires exit 1 and the no-cluster
  # CAUSE sentence, so only the arms actually failing to connect can satisfy it.
  # CHALLENGE R12-P2-02: the stop's exit code was never read and nothing was
  # asked afterwards, while the RESTART two lines down IS verified with
  # `select 1`. So this proof's own premise -- that nothing is listening -- was
  # the one thing it did not measure, and when the stop did not take hold the
  # FAIL line below reported a code and a missing sentence with no cause. That
  # is the shape of the unexplained red at 20:24:17Z. Assert the premise first,
  # and when the cluster still answers say THAT instead of judging the preflight.
  # COORD-DIFF-REVIEW 03b3a0b, R-3: this premise accepted ANY non-answer as
  # "the stop took effect", so a cluster that was up and merely refusing this
  # connection (pg_hba, authentication, a missing role) satisfied it. A FATAL
  # means something answered, so the stderr is read too.
  pgerr=$($PGC "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -qtAc 'select 1'" 2>&1 >/dev/null)
  if printf '%s' "$pgerr" | grep -q 'FATAL'; then
    printf 'FAIL  %-26s a cluster ANSWERED and refused the connection (%s), so the stop\n' no-cluster \
           "$(printf '%s' "$pgerr" | grep -m1 FATAL | cut -c1-60)"
    printf '      cannot be said to have taken effect and no verdict about the preflight is\n'
    printf '      reported from here.\n'
    fail=$((fail+1))
  elif $PGC "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -qtAc 'select 1'" 2>/dev/null | grep -q 1; then
    printf 'FAIL  %-26s the stop did not take effect — the cluster still answers `select 1`, so\n' no-cluster
    printf '      this proof would have measured a DIFFERENT world than the one it names, and\n'
    printf '      no verdict about the preflight is reported from here.\n'
    fail=$((fail+1))
  else
  out=$( "$PACK/proofs/redproof-preflight.sh" 2>&1 ); rc=$?
  if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'no cluster is listening'; then
    printf 'ok    %-26s rc=1 with the cluster STOPPED (`select 1` refused first), and it says so: "no cluster is listening"\n' no-cluster
  else
    printf 'FAIL  %-26s rc=%s with the cluster STOPPED (required 1 and "no cluster is listening"): %s\n' \
           no-cluster "$rc" "$(printf '%s' "$out" | grep -m1 -E 'Permission denied|No such file|command not found|psql said|CAUSE:|[Ee]rror:|ERROR|FATAL|could not' | cut -c1-90)"
    fail=$((fail+1))
  fi
  fi
  $PGC "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/p14pg/data -l /tmp/p14pg/data/pg_ctl.log -o \"-p 54314 -c listen_addresses='' -k /tmp/p14pg/sock -c fsync=off\" -w start" >/dev/null 2>&1
  PGSTOPPED=
  # R8-P3-04: the rolecount arm must be a proof about p14_resolver and not
  # about "some role". Rename a DIFFERENT one: the arm is required to FAIL.
  PSQL="/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U p14super -d postgres -q -c"
  PGRENAMED=1
  $PGC "$PSQL \"ALTER ROLE p14_merchant RENAME TO p14_merchant_x\"" >/dev/null 2>&1
  out=$( "$PACK/proofs/redproof-preflight.sh" rolecount 2>&1 ); rc=$?
  $PGC "$PSQL \"ALTER ROLE p14_merchant_x RENAME TO p14_merchant\"" >/dev/null 2>&1
  PGRENAMED=
  # R-05 again: "non-zero" was satisfiable by a lock refusal that never looked
  # at a role. Exit 1 and the arm's own "required message is absent" line.
  if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'the required message is absent'; then
    printf 'ok    %-26s rc=1 after renaming a DIFFERENT role, and the arm says its own message is absent\n' rolecount-discriminates
  else
    printf 'FAIL  %-26s rc=%s after renaming p14_merchant (required 1 and "the required message is absent"): %s\n' \
           rolecount-discriminates "$rc" "$(printf '%s' "$out" | grep -m1 . | cut -c1-90)"
    fail=$((fail+1))
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
      # COORD DIFF REVIEW AT c812aa5, R-07: this was the one filter left without
      # a fallback, so an exit-4 refusal (which matches none of the patterns)
      # printed the sentence with an empty payload -- the very claim Amendment
      # 14 made about every filter. The raw first line beats a blank claim.
      said=$(printf '%s' "$out" | grep -m1 -E 'Permission denied|No such file|command not found|psql said|CAUSE:|REFUSING|[Ee]rror:|ERROR|FATAL|WARNING|could not' | cut -c1-90)
      [ -z "$said" ] && said=$(printf '%s' "$out" | grep -m1 . | cut -c1-90)
      printf 'FAIL  %-26s rc=%s while the cluster ANSWERS select 1 — so this is not the cluster: %s\n' \
             no-cluster-revert "$rc" "${said:-<no output at all>}"
    else
      printf 'FAIL  %-26s rc=%s and the cluster does not answer — the sweep left the box broken\n' no-cluster-revert "$rc"
    fi
    fail=$((fail+1))
  fi
  # ROUND-10 ADDENDUM: the challenger diagnosed R10-RESIDUAL-AUTHOR-01 as
  # CONTENTION -- two concurrent runs colliding over CREATE DATABASE, with the
  # loser blaming residue. The remedy is per-run database names plus a lock, so
  # the LOCK itself is red-proofed: hold it, require the script to refuse by
  # name rather than measure a world another run is editing.
  ( exec 9>/tmp/p14pg/redproof.lock; flock 9; sleep 8 ) &
  LOCKER=$!
  sleep 1
  out=$( "$PACK/proofs/redproof-preflight.sh" 2>&1 ); rc=$?
  if [ "$rc" = 4 ] && printf '%s' "$out" | grep -q 'REFUSING TO MEASURE'; then
    printf 'ok    %-26s rc=4, refused while another run holds the lock\n' concurrent-run-refused
  else
    printf 'FAIL  %-26s rc=%s — a second run measured a world another run is editing: %s\n' \
           concurrent-run-refused "$rc" "$(printf '%s' "$out" | grep -m1 . | cut -c1-80)"
    fail=$((fail+1))
  fi
  wait $LOCKER 2>/dev/null

  # ROUND-9 CHALLENGE P3-02, offered as a remedy and taken: the VERSION arm
  # cannot be proved against a real PG 17 cluster here, but its purpose is to
  # prove the assertion FIRES. The bound is mutated in a COPY of preflight.sql
  # and the specific abort is required. It remains UNFENCED for the narrower
  # claim that a real PG 17 cluster is refused, and that note stays.
  VC=$(mktemp -d); SCRATCH="${SCRATCH:-} $VC"; sed 's/v < 160000 OR v >= 170000/v < 170000 OR v >= 180000/' \
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
