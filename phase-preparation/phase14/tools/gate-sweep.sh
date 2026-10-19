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
# CHALLENGE R15-P1-01: this sweep's full count has a PRECONDITION nobody stated
# for fifteen rounds -- the repository must contain the migration-freeze anchor,
# which is on no branch, so a clean CI checkout fails the four provenance cases
# fail-closed. It is printed before the gate runs, whether or not it is met, and
# the anchor is checked here so the sweep says which world it is in.
P14ANCHOR=93084f82b8e36ad49ebb207c0b6e7435d7fcb49f
if git -C "$REPO" --no-replace-objects cat-file -e "$P14ANCHOR^{commit}" 2>/dev/null; then
  printf '   anchor=%s present in %s (citation-provenance can run)\n' "${P14ANCHOR:0:12}" "$REPO"
else
  printf '   anchor=%s ABSENT from %s — the 4 citation-provenance cases below will refuse at rc 2,\n' \
         "${P14ANCHOR:0:12}" "$REPO"
  printf '   which is fail-closed, not a flake. Fetch it by its FULL object name:\n     git fetch --depth 1 origin %s\n' "$P14ANCHOR"
  printf '   The 7-character abbreviation is refused by the server. CHALLENGE R16-R-01, measured in\n'
  printf '   a clean clone by both the author and the challenger: it is fetch-depth: 0 AND that\n'
  printf '   fetch, not one or the other. A depth-1 checkout cannot pass even with the anchor AND\n'
  printf '   the merge-base fetched, because one classification in the generated block is derived\n'
  printf '   from history (a file the pack once tracked and deleted), so the block reads STALE.\n'
fi
# And the opt-out this sweep must never be run with, said where a CI author
# reads it: --allow-unverified-history accepts a history that CANNOT BE READ and
# prints its own limit; a job that passes it asserts nothing about what any
# reviewer sent. No case in this sweep passes it except the two that exist to
# prove it prints the limit.
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
  # CHALLENGE R15-P3-01: the sentence this proof reads used to name a CAUSE
  # ("removed and re-added") for a measurement that is only "git reports no
  # file carrying the manifest in that tree", and it was reached in the
  # quoted-path world by a LOOKUP FAILURE where nothing was removed. The
  # proof follows the corrected sentence.
  named deletion-revision-still-skipped 1 "no file carrying this manifest in 1 of them" \
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

# ---- CHALLENGE R15-P0-01, which BLOCKED: the anchor above rested on git's
# RENAME-SIMILARITY score over content the attacker writes in the same commit.
# The challenger's world `G2` is the rename-and-move world PLUS a prose rewrite,
# and at the default threshold `--follow` scored no rename: 1 revision of 4,
# rc 0, "checked over every revision". The anchor is now the manifest's MARKER,
# and these four proofs are the four ways that anchor can be attacked. Each
# asserts its own premise, so a world that fails to build FAILS rather than
# passing quietly.
G2W=$(mktemp -d); SCRATCH="${SCRATCH:-} $G2W"; mkdir -p "$G2W/repo/a"; cp -r "$PACK" "$G2W/repo/a/phase14"
rm -rf "$G2W/repo/a/phase14/.git"
( cd "$G2W/repo" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' \
  && git -c user.email=p14@local -c user.name=p14 commit -q --allow-empty -m 'another revision' \
  && mkdir -p elsewhere && git mv a/phase14/P14-HANDOFF-MANIFEST.md elsewhere/LEDGER.md ) >/dev/null 2>&1
printf '\n\nan appended line nobody received\n' >> "$G2W/repo/a/phase14/P14-CHALLENGE-7af6438.md"
python3 - "$G2W/repo/a/phase14/P14-CHALLENGE-7af6438.md" "$G2W/repo/elsewhere/LEDGER.md" <<'G2FORGE'
import hashlib,os,re,sys
rep,man=sys.argv[1],sys.argv[2]
b=open(rep,'rb').read(); h=hashlib.sha256(b).hexdigest()
L=open(man,encoding='utf-8').read().split(chr(10))
out=[]
for l in L:
    if l.startswith('| `%s`' % os.path.basename(rep)):
        l=re.sub(r'`[0-9a-f]{64}`','`%s`' % h,l)
        l=re.sub(r'\| [0-9,]+ \|$','| %s |' % format(len(b),','),l)
    out.append(l)
# EVERY row is kept, so the pack still validates and the ONLY thing this commit
# changes besides the forgery is the narrative -- which is what drops the
# rename similarity below git's threshold. Measured: with the rows alone the
# score still holds and `--follow` DOES see the move, so the premise below
# would not hold and the proof would fail rather than mislead.
pad=['the promotion ledger restates every artifact of this phase line %d, and the'
     ' narrative around the table was rewritten wholesale for the promotion.' % i
     for i in range(4000)]
open(man,'w',encoding='utf-8').write(chr(10).join(out[:1]+pad+out[1:]))
G2FORGE
( cd "$G2W/repo" && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'promote: rename, move and rewrite' ) >/dev/null 2>&1
G2M="--manifest $G2W/repo/elsewhere/LEDGER.md --dir $G2W/repo/a/phase14"
# Premise: BOTH of the old legs miss -- one revision by basename AND one by
# `--follow` -- while the history holds three and the marker leg finds two.
G2B=$(cd "$G2W/repo" && git rev-list HEAD -- ':(top,glob)**/LEDGER.md' | wc -l)
G2F=$(cd "$G2W/repo" && git log --follow --format=%H -- elsewhere/LEDGER.md | wc -l)
G2G=$(cd "$G2W/repo" && git log --format=%H --no-renames -G '^# P14-HANDOFF-MANIFEST\.md$' HEAD -- ':(top)' | wc -l)
if [ "$G2B" = 1 ] && [ "$G2F" = 1 ] && [ "$G2G" -gt 1 ]; then
  named manifest-renamed-moved-and-rewritten 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $G2M --witness $G2W/none --check"
  named manifest-renamed-moved-and-rewritten-write 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $G2M --witness $G2W/none --write"
else
  printf 'FAIL  %-26s the G2 world was not built (%s by basename, %s by --follow, %s by marker) — nothing was proved\n' \
         manifest-renamed-moved-and-rewritten "${G2B:-<none>}" "${G2F:-<none>}" "${G2G:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$G2W"

# ---- CHALLENGE R15-P0-02, which BLOCKED: `core.quotePath` defaults TRUE, so a
# non-ASCII path came back QUOTED and `ls-tree -- <that string>` answered empty
# at rc 0 -- read here as "absent from that tree". In the challenger's world the
# two revisions holding the TRUE digest were both counted as gaps and the tool
# printed 0 with "ABSENT in 2 of them — removed and re-added", a cause that was
# not the cause. This is an ar/en/tr product; the path shape is ordinary.
ARW=$(mktemp -d); SCRATCH="${SCRATCH:-} $ARW"; ARD="$ARW/repo/مرحلة"
mkdir -p "$ARD" && cp -r "$PACK"/* "$ARD"/ 2>/dev/null; rm -rf "$ARD/.git"
( cd "$ARW/repo" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received at an arabic path' ) >/dev/null 2>&1
printf '\n' >> "$ARD/P14-HANDOFF-MANIFEST.md"
( cd "$ARW/repo" && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'amend the manifest there' \
  && mkdir -p pack && git mv "مرحلة/P14-HANDOFF-MANIFEST.md" pack/HANDOFF.md ) >/dev/null 2>&1
forge "$ARD" "$ARW/repo/pack/HANDOFF.md"
( cd "$ARW/repo" && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'promote: move it out of the arabic path' ) >/dev/null 2>&1
ARM="--manifest $ARW/repo/pack/HANDOFF.md --dir $ARD"
# Premise: git really does quote this path, and the history really holds three
# revisions -- otherwise the quoting is not what is being measured.
ARQ=$(cd "$ARW/repo" && git log --name-only --format= -1 HEAD~1 | grep -c '^"')
ARR=$(cd "$ARW/repo" && git rev-list HEAD | wc -l)
if [ "$ARQ" -ge 1 ] && [ "$ARR" = 3 ]; then
  named manifest-moved-off-a-quoted-path 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $ARM --witness $ARW/none --check"
  named manifest-moved-off-a-quoted-path-write 1 "REWRITTEN IN HISTORY" \
    "python3 -I $HERE/manifest-digests.py $ARM --witness $ARW/none --write"
else
  printf 'FAIL  %-26s the quoted-path world was not built (%s quoted line(s), %s revision(s)) — nothing was proved\n' \
         manifest-moved-off-a-quoted-path "${ARQ:-<none>}" "${ARR:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$ARW"

# ---- The coordinator's requirement on the new anchor, and the challenger's own
# caveat about it: a marker-based walk must not let a SECOND file carrying the
# marker supply an "oldest" record of its own, and must not be silently
# unanchored when the marker is REMOVED. Both refuse by name.
DCW=$(mktemp -d); SCRATCH="${SCRATCH:-} $DCW"; mkdir -p "$DCW/repo/a"; cp -r "$PACK" "$DCW/repo/a/phase14"
rm -rf "$DCW/repo/a/phase14/.git"
( cd "$DCW/repo" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' ) >/dev/null 2>&1
printf '# an amendment quoting the manifest\n\n# P14-HANDOFF-MANIFEST.md\n\nsays the row was received.\n' \
  > "$DCW/repo/a/phase14/P14-AMENDMENT-99-QUOTES-THE-MARKER.md"
( cd "$DCW/repo" && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'an amendment reproducing the marker as a whole line' ) >/dev/null 2>&1
DCM="--manifest $DCW/repo/a/phase14/P14-HANDOFF-MANIFEST.md --dir $DCW/repo/a/phase14"
DCN=$(cd "$DCW/repo" && git grep -l --full-name -E '^# P14-HANDOFF-MANIFEST\.md$' HEAD -- ':(top)' | wc -l)
if [ "$DCN" = 2 ]; then
  named marker-in-two-files-refused 1 "AMBIGUOUS" \
    "python3 -I $HERE/manifest-digests.py $DCM --witness $DCW/none --check"
else
  printf 'FAIL  %-26s the decoy world was not built (%s carrier(s)) — nothing was proved\n' \
         marker-in-two-files-refused "${DCN:-<none>}"
  fail=$((fail+1))
fi
# The subject with its marker stripped: unanchorable, and refused before any
# history is read rather than answered at 0.
STW=$(mktemp -d); SCRATCH="${SCRATCH:-} $STW"; cp -r "$PACK"/* "$STW"/ 2>/dev/null; rm -rf "$STW/.git"
sed -i '1s/.*/# a ledger/' "$STW/P14-HANDOFF-MANIFEST.md"
STN=$(grep -c '^# P14-HANDOFF-MANIFEST\.md$' "$STW/P14-HANDOFF-MANIFEST.md" || true)
if [ "${STN:-0}" = 0 ]; then
  named marker-stripped-from-subject 1 "NOT ANCHORED" \
    "python3 -I $HERE/manifest-digests.py --manifest $STW/P14-HANDOFF-MANIFEST.md --dir $STW --witness $STW/none --check"
else
  printf 'FAIL  %-26s the stripped world was not built (%s marker line(s) left) — nothing was proved\n' \
         marker-stripped-from-subject "${STN:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$DCW" "$STW"

# ---- CHALLENGE R16-P0-01, which BLOCKED: the marker's subject test and its two
# history legs differed by ONE BYTE of normalisation -- `rstrip()` against an
# exact `^marker$` -- so a manifest whose marker line carries a trailing SPACE,
# or that is committed CRLF, passed the subject requirement while BOTH legs
# found nothing, and the walk fell back to the path alone while still printing
# "found by the marker it carries". These three worlds are identical except for
# that one byte, which is why the control is here: without it the two attack
# worlds prove only that something refuses.
mkworld16() { # $1 world dir, $2 none|space|crlf
  local W="$1" M="$2"
  rm -rf "$W"; mkdir -p "$W/repo/a"; cp -r "$PACK" "$W/repo/a/phase14"
  rm -rf "$W/repo/a/phase14/.git"
  case "$M" in
    space) python3 - "$W/repo/a/phase14/P14-HANDOFF-MANIFEST.md" <<'SP'
import sys
p=sys.argv[1]; L=open(p,encoding='utf-8').read().split(chr(10))
L[0]=L[0]+' '
open(p,'w',encoding='utf-8').write(chr(10).join(L))
SP
;;
    crlf) python3 - "$W/repo/a/phase14/P14-HANDOFF-MANIFEST.md" <<'CR'
import sys
p=sys.argv[1]; d=open(p,'rb').read().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')
open(p,'wb').write(d)
CR
;;
  esac
  ( cd "$W/repo" && git init -q . && git add -A >/dev/null 2>&1 \
    && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' \
    && git -c user.email=p14@local -c user.name=p14 commit -q --allow-empty -m 'another revision' ) >/dev/null 2>&1
  # an honest third revision OF THE MANIFEST: the manifest carries no row for
  # itself, so editing it leaves every artifact row intact and the only reason
  # this world can red is the forgery below.
  python3 - "$W/repo/a/phase14/P14-HANDOFF-MANIFEST.md" <<'ED'
import sys
p=sys.argv[1]; raw=open(p,'rb').read()
nl=b'\r\n' if b'\r\n' in raw else b'\n'
open(p,'wb').write(raw+nl+b'an honest later note.'+nl)
ED
  ( cd "$W/repo" && git add -A >/dev/null 2>&1 \
    && git -c user.email=p14@local -c user.name=p14 commit -q -m 'an honest edit of the manifest' \
    && mkdir -p promoted && git mv a/phase14/P14-HANDOFF-MANIFEST.md promoted/HANDOFF.md ) >/dev/null 2>&1
  printf '\n\nan appended line nobody received\n' >> "$W/repo/a/phase14/P14-CHALLENGE-7af6438.md"
  python3 - "$W/repo/a/phase14/P14-CHALLENGE-7af6438.md" "$W/repo/promoted/HANDOFF.md" <<'FG16'
import hashlib,os,re,sys
rep,man=sys.argv[1],sys.argv[2]
b=open(rep,'rb').read(); h=hashlib.sha256(b).hexdigest()
raw=open(man,'rb').read(); crlf=b'\r\n' in raw
L=raw.decode('utf-8').split('\n'); out=[]
for l in L:
    if l.startswith('| `%s`' % os.path.basename(rep)):
        l=re.sub(r'`[0-9a-f]{64}`','`%s`' % h,l)
        l=re.sub(r'\| [0-9,]+ \|(\r?)$','| %s |\\1' % format(len(b),','),l)
    out.append(l)
pad=['the promotion ledger was rewritten wholesale, line %d.%s' % (i,'\r' if crlf else '')
     for i in range(4000)]
open(man,'w',encoding='utf-8',newline='').write('\n'.join(out[:1]+pad+out[1:]))
FG16
  ( cd "$W/repo" && git add -A >/dev/null 2>&1 \
    && git -c user.email=p14@local -c user.name=p14 commit -q -m 'promote: rename, move and rewrite' ) >/dev/null 2>&1
}
M16=$(mktemp -d); SCRATCH="${SCRATCH:-} $M16"
for v in ctrl:none space:space crlf:crlf; do
  nm="${v%%:*}"; mut="${v##*:}"
  mkworld16 "$M16/$nm" "$mut"
  R="$M16/$nm/repo"
  # Premises, all read from git: four revisions exist; the path legs see one
  # each; and the EXACT marker is present at HEAD only in the control.
  tot=$(cd "$R" && git rev-list HEAD | wc -l)
  bn=$(cd "$R" && git rev-list HEAD -- ':(top,glob)**/HANDOFF.md' | wc -l)
  fl=$(cd "$R" && git log --follow --format=%H -- promoted/HANDOFF.md | wc -l)
  ex=$(cd "$R" && git grep -l --full-name -E '^# P14-HANDOFF-MANIFEST[.]md$' HEAD -- ':(top)' | wc -l)
  want_ex=0; [ "$nm" = ctrl ] && want_ex=1
  A16="--manifest $R/promoted/HANDOFF.md --dir $R/a/phase14 --witness $M16/$nm/none"
  if [ "$tot" = 4 ] && [ "$bn" = 1 ] && [ "$fl" = 1 ] && [ "$ex" = "$want_ex" ]; then
    named "marker-$nm-world" 1 "REWRITTEN IN HISTORY" \
      "python3 -I $HERE/manifest-digests.py $A16 --check"
  else
    printf 'FAIL  %-26s premise not built (total %s, basename %s, follow %s, exact-at-HEAD %s want %s) — nothing was proved\n' \
           "marker-$nm-world" "$tot" "$bn" "$fl" "$ex" "$want_ex"
    fail=$((fail+1))
  fi
done
rm -rf "$M16"

# ---- The second half of the same remedy, which the first half cannot cover:
# the next spelling nobody thought of. The anchor is ASSERTED -- a subject that
# carries the marker while NO file in HEAD does refuses by name, instead of
# walking a revision set the marker had no part in choosing. NOTE what this
# proof claims: at `7f6f535` this world also exited 1 (the forged row is caught
# by its digest), so this is NOT a 0 -> 1 flip. What changes is that the summary
# no longer says "checked over all 2 revision(s) ... found by the marker" about
# a run in which the marker found nothing.
NHW=$(mktemp -d); SCRATCH="${SCRATCH:-} $NHW"; mkdir -p "$NHW/repo/a"
cp -r "$PACK" "$NHW/repo/a/phase14"; rm -rf "$NHW/repo/a/phase14/.git"
python3 - "$NHW/repo/a/phase14/P14-HANDOFF-MANIFEST.md" <<'OTHER'
import sys
p=sys.argv[1]; L=open(p,encoding='utf-8').read().split(chr(10))
L[0]='# the promotion ledger'
open(p,'w',encoding='utf-8').write(chr(10).join(L))
OTHER
( cd "$NHW/repo" && git init -q . && git add -A >/dev/null 2>&1 \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'committed under another heading' \
  && git -c user.email=p14@local -c user.name=p14 commit -q --allow-empty -m 'another revision' ) >/dev/null 2>&1
python3 - "$NHW/repo/a/phase14/P14-HANDOFF-MANIFEST.md" <<'BACK'
import sys
p=sys.argv[1]; L=open(p,encoding='utf-8').read().split(chr(10))
L[0]='# P14-HANDOFF-MANIFEST.md'
open(p,'w',encoding='utf-8').write(chr(10).join(L))
BACK
NHE=$(cd "$NHW/repo" && git grep -l --full-name -E '^# P14-HANDOFF-MANIFEST[.]md$' HEAD -- ':(top)' | wc -l)
NHS=$(grep -c '^# P14-HANDOFF-MANIFEST\.md$' "$NHW/repo/a/phase14/P14-HANDOFF-MANIFEST.md" || true)
if [ "$NHE" = 0 ] && [ "${NHS:-0}" = 1 ]; then
  named marker-absent-from-head 1 "NOT ANCHORED" \
    "python3 -I $HERE/manifest-digests.py --manifest $NHW/repo/a/phase14/P14-HANDOFF-MANIFEST.md --dir $NHW/repo/a/phase14 --witness $NHW/none --check"
else
  printf 'FAIL  %-26s premise not built (exact-at-HEAD %s, in subject %s) — nothing was proved\n' \
         marker-absent-from-head "$NHE" "${NHS:-<none>}"
  fail=$((fail+1))
fi
rm -rf "$NHW"

# ---- ROUND 17 (R17-P1-01). The count in that summary was written by BOTH legs:
# the path-discovery loop added every revision it found to the marker set, so
# the sentence could never be low, and the one world it exists to expose -- an
# inert anchor, where `git log -G` matches nothing at all -- printed its whole
# revision count back as "found by the marker". No proof covered the COUNT,
# which is how it survived into b49d612. These two do, and they read the true
# figure from the marker leg's OWN command rather than from the tool.
mkworld17() { # $1 world dir, $2 plain|binary
  local W="$1" M="$2"
  rm -rf "$W"; mkdir -p "$W/repo/a"; cp -r "$PACK" "$W/repo/a/phase14"
  rm -rf "$W/repo/a/phase14/.git"
  # `*.md binary` makes git produce NO textual diff for the manifest, so the
  # `-G` leg cannot match the marker in any patch -- an anchor that is inert
  # through no fault of the manifest, which still carries the marker verbatim
  # and is still found at HEAD by `git grep`.
  [ "$M" = binary ] && printf '*.md binary\n' > "$W/repo/.gitattributes"
  ( cd "$W/repo" && git init -q . && git add -A >/dev/null 2>&1 \
    && git -c user.email=p14@local -c user.name=p14 commit -q -m 'reports received and signed' \
    && git -c user.email=p14@local -c user.name=p14 commit -q --allow-empty -m 'another revision' ) >/dev/null 2>&1
  # an honest later revision OF THE MANIFEST, whose added line does not carry
  # the marker: the path leg sees it, the marker leg does not, and the two legs
  # must therefore report different numbers.
  printf '\nan honest later note.\n' >> "$W/repo/a/phase14/P14-HANDOFF-MANIFEST.md"
  ( cd "$W/repo" && git -c user.email=p14@local -c user.name=p14 commit -qam 'an honest edit of the manifest' ) >/dev/null 2>&1
}
C17=$(mktemp -d); SCRATCH="${SCRATCH:-} $C17"
for w in plain binary; do
  mkworld17 "$C17/$w" "$w"
  R="$C17/$w/repo"; P17="$R/a/phase14"
  # Premises, every one read from git, not from the tool: the marker leg's own
  # command, the path leg's own command, and the carrier at HEAD (without which
  # the run would refuse NOT ANCHORED and print no count at all).
  g17=$(cd "$R" && git log --format=%H --no-renames -G '^# P14-HANDOFF-MANIFEST[.]md[[:space:]]*$' HEAD -- ':(top)' | wc -l | tr -d ' ')
  p17=$(cd "$R" && git rev-list HEAD -- ':(top)a/phase14/P14-HANDOFF-MANIFEST.md' | wc -l | tr -d ' ')
  h17=$(cd "$R" && git grep -l --full-name -E '^# P14-HANDOFF-MANIFEST[.]md[[:space:]]*$' HEAD -- ':(top)' | wc -l | tr -d ' ')
  want_g=1; [ "$w" = binary ] && want_g=0
  if [ "$g17" = "$want_g" ] && [ "$p17" = 2 ] && [ "$h17" = 1 ]; then
    # The required message is built from git's figure, so a tool that counts
    # the path leg's revisions into the marker set cannot satisfy it: at
    # b49d612 these worlds printed "2 of them" and "2 of them".
    named "marker-count-$w" 0 "— $g17 of them found by the marker" \
      "python3 -I $HERE/manifest-digests.py --manifest $P17/P14-HANDOFF-MANIFEST.md --dir $P17 --witness $C17/$w/none --check"
  else
    printf 'FAIL  %-26s premise not built (marker leg %s want %s, path leg %s want 2, carrier at HEAD %s want 1) — nothing was proved\n' \
           "marker-count-$w" "$g17" "$want_g" "$p17" "$h17"
    fail=$((fail+1))
  fi
done
rm -rf "$C17"

# ---- ROUND 18 (R18-P0-01), a FAIL-OPEN. No git call of manifest-digests.py
# disabled replace objects, and git honours refs/replace by default in every
# subcommand the tool uses, so the history witness was supplied by a ref inside
# the repository under judgement. The remedy is the FLAG on the helper, not a
# check: the SECOND arm below moves the refs to refs/other/ with
# GIT_REPLACE_REF_BASE, leaving refs/replace EMPTY, so any gate that merely
# greps for replace refs reports clean while the forgery still passes.
mkreplace18() { # $1 world dir, $2 base|other
  local W="$1" MODE="$2"
  rm -rf "$W"; mkdir -p "$W/repo/pack"
  cp "$PACK/P14-HANDOFF-MANIFEST.md" "$W/repo/pack/P14-HANDOFF-MANIFEST.md"
  printf 'a reviewer report, true content\n' > "$W/repo/pack/P14-CHALLENGE-test.md"
  # a manifest carrying ONE row, for that report, with its TRUE digest
  python3 -I - "$W" <<'R18A'
import hashlib, sys
W=sys.argv[1]
b=open(W+'/repo/pack/P14-CHALLENGE-test.md','rb').read()
p=W+'/repo/pack/P14-HANDOFF-MANIFEST.md'
s=open(p,encoding='utf-8').read().split('\n')
row='| `P14-CHALLENGE-test.md` | a test reviewer report | `%s` | %s |' % (
    hashlib.sha256(b).hexdigest(), len(b))
out=[l for l in s if not l.startswith('| `')]
i=[n for n,l in enumerate(out) if l.startswith('|---')][0]
open(p,'w',encoding='utf-8').write('\n'.join(out[:i+1]+[row]+out[i+1:]))
R18A
  ( cd "$W/repo" && git init -q . \
    && git -c user.email=p14@local -c user.name=p14 add -A \
    && git -c user.email=p14@local -c user.name=p14 commit -q -m 'honest 1' \
    && printf 'an honest later note\n' >> pack/P14-HANDOFF-MANIFEST.md \
    && git -c user.email=p14@local -c user.name=p14 commit -qam 'honest 2' \
    && printf 'another honest note\n' >> pack/P14-HANDOFF-MANIFEST.md \
    && git -c user.email=p14@local -c user.name=p14 commit -qam 'honest 3' ) >/dev/null 2>&1
  # the forgery: the report grows a line nobody received, and its row is re-signed
  printf 'an appended line nobody received\n' >> "$W/repo/pack/P14-CHALLENGE-test.md"
  python3 -I - "$W" <<'R18B'
import hashlib, re, sys
W=sys.argv[1]
b=open(W+'/repo/pack/P14-CHALLENGE-test.md','rb').read()
p=W+'/repo/pack/P14-HANDOFF-MANIFEST.md'
s=open(p,encoding='utf-8').read()
s=re.sub(r'(\| `P14-CHALLENGE-test\.md` \| a test reviewer report \| `)[0-9a-f]{64}(` \| )[0-9]+( \|)',
         r'\g<1>%s\g<2>%d\g<3>' % (hashlib.sha256(b).hexdigest(), len(b)), s)
open(p,'w',encoding='utf-8').write(s)
R18B
  ( cd "$W/repo" && git -c user.email=p14@local -c user.name=p14 commit -qam 'forge: re-sign the row' ) >/dev/null 2>&1
  # one REPLACEMENT commit per honest revision, each holding a manifest that
  # already records the forged digest, built with plumbing only.
  ( cd "$W/repo"
    FORGED=$(git hash-object -w pack/P14-HANDOFF-MANIFEST.md)
    OLDEST=$(git rev-list --max-parents=0 HEAD)
    [ "$MODE" = other ] && export GIT_REPLACE_REF_BASE=refs/other/
    for rev in $(git rev-list HEAD~1); do
      git read-tree "$rev"
      git update-index --add --cacheinfo 100644,$FORGED,pack/P14-HANDOFF-MANIFEST.md
      t=$(git write-tree)
      if [ "$rev" = "$OLDEST" ]; then new=$(git commit-tree $t -m replaced)
      else new=$(git commit-tree $t -p ${rev}^ -m replaced); fi
      git replace -f "$rev" "$new"
    done
    git read-tree HEAD; git checkout-index -af ) >/dev/null 2>&1
}
R18=$(mktemp -d); SCRATCH="${SCRATCH:-} $R18"
for arm in base other; do
  mkreplace18 "$R18/$arm" "$arm"
  R="$R18/$arm/repo"; MAN="$R/pack/P14-HANDOFF-MANIFEST.md"
  BASEREF=refs/replace; [ "$arm" = other ] && BASEREF=refs/other
  nref=$(cd "$R" && GIT_REPLACE_REF_BASE=$BASEREF/ git for-each-ref "$BASEREF" | wc -l | tr -d ' ')
  nplain=$(cd "$R" && git for-each-ref refs/replace | wc -l | tr -d ' ')
  # the true root, read with replacement OFF so the lookup itself cannot be replaced
  OLD=$(cd "$R" && git --no-replace-objects rev-list --max-parents=0 HEAD | tail -1)
  # The premise that matters: at the OLDEST revision, the tree git serves WITH
  # replacement differs from the one it serves with --no-replace-objects, i.e.
  # the replacement is really in effect for a read of history.
  if [ "$arm" = other ]; then
    seen=$(cd "$R" && GIT_REPLACE_REF_BASE=refs/other/ git show "$OLD:pack/P14-HANDOFF-MANIFEST.md" | sha256sum | cut -c1-16)
  else
    seen=$(cd "$R" && git show "$OLD:pack/P14-HANDOFF-MANIFEST.md" | sha256sum | cut -c1-16)
  fi
  true_=$(cd "$R" && git --no-replace-objects show "$OLD:pack/P14-HANDOFF-MANIFEST.md" | sha256sum | cut -c1-16)
  want_plain=3; [ "$arm" = other ] && want_plain=0
  if [ "$nref" = 3 ] && [ "$nplain" = "$want_plain" ] && [ "$seen" != "$true_" ]; then
    # At c001cd9 both arms were rc 0 over "all 1 revision(s)" with NO refusal.
    if [ "$arm" = other ]; then
      named replace-refs-off-base-refused 1 "REFUSED: P14-CHALLENGE-test.md" \
        "GIT_REPLACE_REF_BASE=refs/other/ python3 -I $HERE/manifest-digests.py --manifest $MAN --dir $R/pack --witness $R18/$arm/none --check"
    else
      named replace-refs-refused 1 "REFUSED: P14-CHALLENGE-test.md" \
        "python3 -I $HERE/manifest-digests.py --manifest $MAN --dir $R/pack --witness $R18/$arm/none --check"
    fi
  else
    printf 'FAIL  %-26s premise not built (%s refs %s want 3, refs/replace %s want %s, replaced read %s vs true %s) — nothing was proved\n' \
           "replace-refs-$arm" "$BASEREF" "$nref" "$nplain" "$want_plain" "$seen" "$true_"
    fail=$((fail+1))
  fi
done
rm -rf "$R18"

# ---- ROUND 19 (R19-P0-01), the same class one mechanism along: GRAFTS are not
# disabled by --no-replace-objects or GIT_NO_REPLACE_OBJECTS. One line naming
# the forging commit with no parents truncates `rev-list HEAD` to a single
# commit, and the refusal restored in round 18 went away again at rc 0. A check
# is no remedy here either: the SECOND arm puts the graft file somewhere else
# with GIT_GRAFT_FILE, so `.git/info/grafts` is ABSENT while the truncation
# still applies. Each arm asserts from git that the truncation is really in
# effect -- the walk git serves is shorter than the one it serves with the
# graft file pointed at /dev/null -- before it requires the refusal.
G19=$(mktemp -d); SCRATCH="${SCRATCH:-} $G19"
for arm in default elsewhere; do
  mkreplace18 "$G19/$arm" base
  R="$G19/$arm/repo"; MAN="$R/pack/P14-HANDOFF-MANIFEST.md"
  # the replace refs are this proof's noise: delete them, so the ONLY
  # truncation in the world is the graft.
  ( cd "$R" && for r in $(git replace -l); do git replace -d "$r"; done ) >/dev/null 2>&1
  GF="$R/.git/info/grafts"; PRE=""
  if [ "$arm" = elsewhere ]; then GF="$G19/$arm/grafts-elsewhere"; PRE="GIT_GRAFT_FILE=$GF"; fi
  ( cd "$R" && git rev-parse HEAD ) > "$GF" 2>/dev/null
  nrep=$(cd "$R" && git for-each-ref refs/replace | wc -l | tr -d ' ')
  ngraft=$(cd "$R" && env $PRE git rev-list HEAD 2>/dev/null | wc -l | tr -d ' ')
  nfull=$(cd "$R" && GIT_GRAFT_FILE=/dev/null git rev-list HEAD 2>/dev/null | wc -l | tr -d ' ')
  ndefault=0; [ -f "$R/.git/info/grafts" ] && ndefault=1
  want_default=1; [ "$arm" = elsewhere ] && want_default=0
  if [ "$nrep" = 0 ] && [ "$ngraft" = 1 ] && [ "$nfull" = 4 ] && [ "$ndefault" = "$want_default" ]; then
    # At 06cbc8f both arms were rc 0 over "all 1 revision(s)" with NO refusal.
    named "graft-$arm-refused" 1 "REFUSED: P14-CHALLENGE-test.md" \
      "$PRE python3 -I $HERE/manifest-digests.py --manifest $MAN --dir $R/pack --witness $G19/$arm/none --check"
  else
    printf 'FAIL  %-26s premise not built (replace refs %s want 0, grafted walk %s want 1, ungrafted %s want 4, file at default path %s want %s) — nothing was proved\n' \
           "graft-$arm" "$nrep" "$ngraft" "$nfull" "$ndefault" "$want_default"
    fail=$((fail+1))
  fi
done
rm -rf "$G19"

# ---- ROUND 20 (R20-P0-01), the same class a THIRD mechanism along: the tool's
# git environment was dict(os.environ, ...), and GIT_DIR BEATS `-C`, so the
# repository read was caller-supplied. Arm one points GIT_DIR at a DECOY whose
# every revision already carries the forged digest; arm two uses a RELATIVE
# GIT_DIR, which already failed closed at 911f2b1 but for the WRONG reason ("the
# manifest is not in a git repository"), so this proof requires the ROW refusal
# in both arms. Premises are read from git first: the walk GIT_DIR serves must
# differ from the walk the pack's own repository serves.
E20=$(mktemp -d); SCRATCH="${SCRATCH:-} $E20"
mkreplace18 "$E20/w" base
WR="$E20/w/repo"
( cd "$WR" && for r in $(git replace -l); do git replace -d "$r"; done; rm -f .git/info/grafts ) >/dev/null 2>&1
# the decoy: a SEPARATE repository, three revisions, every one of them already
# holding the forged manifest and the forged report at the same relative path.
mkdir -p "$E20/f/repo/pack"
cp "$WR/pack/P14-HANDOFF-MANIFEST.md" "$WR/pack/P14-CHALLENGE-test.md" "$E20/f/repo/pack/"
( cd "$E20/f/repo" && git init -q . && git -c user.email=p14@local -c user.name=p14 add -A \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'decoy 1' \
  && printf 'decoy note\n' >> pack/P14-HANDOFF-MANIFEST.md \
  && git -c user.email=p14@local -c user.name=p14 commit -qam 'decoy 2' \
  && printf 'decoy note 2\n' >> pack/P14-HANDOFF-MANIFEST.md \
  && git -c user.email=p14@local -c user.name=p14 commit -qam 'decoy 3' ) >/dev/null 2>&1
wn=$(cd "$WR" && git rev-list HEAD | wc -l | tr -d ' ')
fn=$(GIT_DIR="$E20/f/repo/.git" git rev-list HEAD | wc -l | tr -d ' ')
A20="--manifest $WR/pack/P14-HANDOFF-MANIFEST.md --dir $WR/pack --witness $E20/none --check"
if [ "$wn" = 4 ] && [ "$fn" = 3 ] && [ "$wn" != "$fn" ]; then
  # At 911f2b1 this arm was rc 0, no refusal, "all 3 revision(s)".
  # CHALLENGE R21-P1-01: `REFUSED: <report>` is the HEADER every refusal about
  # that report prints, and the reason is in the STALE line beneath it, so a
  # proof keyed on the header passes for ANY refusal about that file. Both
  # GIT_DIR arms now require the ROW refusal itself.
  named git-dir-decoy-refused 1 "REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md" \
    "GIT_DIR=$E20/f/repo/.git python3 -I $HERE/manifest-digests.py $A20"
else
  printf 'FAIL  %-26s premise not built (pack repo walk %s want 4, GIT_DIR walk %s want 3) — nothing was proved\n' \
         git-dir-decoy "$wn" "$fn"
  fail=$((fail+1))
fi
# arm two, rebuilt after CHALLENGE R21-P1-02: a relative GIT_DIR resolves against
# the directory `-C` moved to, NOT the caller's cwd -- measured by the challenger
# with two repositories. The old arm therefore asserted a path (/tmp/.git) that
# did not decide it, and it passed with the guard deleted. The right form is a
# STRONGER attack: because resolution is against the manifest's own directory,
# the decoy can sit INSIDE THE PACK, so the redirection is repository-supplied
# rather than caller-supplied. Premise as in arm one: the decoy's walk differs
# from the pack repository's walk.
DEC="$WR/pack/decoy.git"
rm -rf "$E20/d"; mkdir -p "$E20/d/pack"
cp "$WR/pack/P14-HANDOFF-MANIFEST.md" "$WR/pack/P14-CHALLENGE-test.md" "$E20/d/pack/"
( cd "$E20/d" && git init -q . && git -c user.email=p14@local -c user.name=p14 add -A \
  && git -c user.email=p14@local -c user.name=p14 commit -q -m 'in-pack decoy 1' \
  && printf 'in-pack decoy note\n' >> pack/P14-HANDOFF-MANIFEST.md \
  && git -c user.email=p14@local -c user.name=p14 commit -qam 'in-pack decoy 2' \
  && printf 'in-pack decoy note 2\n' >> pack/P14-HANDOFF-MANIFEST.md \
  && git -c user.email=p14@local -c user.name=p14 commit -qam 'in-pack decoy 3' ) >/dev/null 2>&1
cp -r "$E20/d/.git" "$DEC"
dn=$(GIT_DIR="$DEC" git rev-list HEAD | wc -l | tr -d ' ')
if [ "$dn" = 3 ] && [ "$wn" = 4 ]; then
  # At 911f2b1 this arm was rc 0, no refusal, over the decoy's 3 revisions.
  named git-dir-in-pack-decoy-refused 1 "REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md" \
    "GIT_DIR=decoy.git python3 -I $HERE/manifest-digests.py $A20"
else
  printf 'FAIL  %-26s premise not built (in-pack decoy walk %s want 3, pack repo walk %s want 4) — nothing was proved\n' \
         git-dir-in-pack-decoy "$dn" "$wn"
  fail=$((fail+1))
fi
# ---- ROUND 21 (R21-P2-01), ruled a P2 and fixed: `python3 -I` stopped the
# caller's environment supplying the tool's PYTHON while the same environment
# still supplied its GIT. A shim earlier on PATH that execs the real git with
# --git-dir at the decoy answered rc 0 with NO refusal; with PATH pinned in the
# built environment, the row refusal holds. Premise: the shim really does
# redirect, i.e. the walk git serves through it differs from the pack's.
SH="$E20/shim"; mkdir -p "$SH"
printf '#!/bin/sh\nexec /usr/bin/git --git-dir=%s "$@"\n' "$E20/f/repo/.git" > "$SH/git"
chmod +x "$SH/git"
sn=$(PATH="$SH:$PATH" git rev-list HEAD 2>/dev/null | wc -l | tr -d ' ')
if [ "$sn" = 3 ] && [ "$wn" = 4 ] && [ -x "$SH/git" ]; then
  named git-binary-shim-refused 1 "REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md" \
    "PATH=$SH:\$PATH python3 -I $HERE/manifest-digests.py $A20"
else
  printf 'FAIL  %-26s premise not built (walk through the shim %s want 3, pack repo walk %s want 4) — nothing was proved\n' \
         git-binary-shim "$sn" "$wn"
  fail=$((fail+1))
fi
rm -rf "$E20"
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
