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
  for d in $DIRS; do
    rc=$( cd "$d" && eval "$@" >/dev/null 2>&1; echo $? )
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
    0) printf 'ok    %-26s rc=0 identical from %s directories\n' "$name" "$(echo $DIRS | wc -w)" ;;
    *) printf 'FAIL  %-26s rc=%s identical from %s directories — consistent, but FAILING\n' \
              "$name" "$first" "$(echo $DIRS | wc -w)"; fail=$((fail+1)) ;;
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
# ROUND-8 CHALLENGE P2-01: this proof used to pass `--repo /tmp`, which is
# foreign only when the pack is NOT under /tmp. In a reviewer's `mktemp -d`
# clone -- or any CI runner checking out under /tmp -- the mutation became a
# no-op, the refusal could not fire, and the sweep reported this pack's own
# handoff gate RED at a head the pack records as 0. A foreign repository is now
# CONSTRUCTED, so the proof is about the property and not about this host's
# directory layout.
FR=$(mktemp -d); git -C "$FR" init -q
red provenance-foreign-repo \
  "true" \
  "python3 -I $HERE/citation-provenance.py --check $DOC --repo $FR" 2 \
  "true"
# R8-P2-02: a --repo that is an ANCESTOR of the pack -- so the round-7 ancestry
# refusal cannot fire -- but is not a repository at all. This is the case that
# printed 13 rows instead of 57 and then called the committed block stale.
NR=$(mktemp -d); mkdir -p "$NR/inner"; cp -r "$PACK" "$NR/inner/phase14"
red provenance-nonrepo-ancestor \
  "true" \
  "python3 -I $HERE/citation-provenance.py --pack $NR/inner/phase14 --repo $NR --check $NR/inner/phase14/P14-MIGRATION-PATCH-REQUEST.md" 2 \
  "true"
# And the source-derived floor: a base tree that does not contain the cited
# files at all. The table would be empty while every cited file sits on disk.
ROOTC=$(git -C "$REPO" rev-list --max-parents=0 HEAD 2>/dev/null | head -1)
red provenance-empty-table \
  "true" \
  "python3 -I $HERE/citation-provenance.py --check $DOC --base ${ROOTC:-HEAD}" 2 \
  "true"
red manifest-digest-corrupt \
  "sed -i '0,/| \`[0-9a-f]\{64\}\` |/s/| \`\([0-9a-f]\{64\}\)\` |/| \`0\{64\}\` |/' '$PACK/P14-HANDOFF-MANIFEST.md'" \
  "python3 -I $HERE/manifest-digests.py --dir $PACK --check" 1 \
  "cp '$T/man.bak' '$PACK/P14-HANDOFF-MANIFEST.md'" "$PACK/P14-HANDOFF-MANIFEST.md"
red retracted-claim-planted \
  "printf '\n\nthe three absent ones are cited only for Phase 4 surface facts\n' >> '$PACK/README-AR.md'" \
  "python3 -I $HERE/retracted-claims.py --pack $PACK --check" 1 \
  "cp '$T/ar.bak' '$PACK/README-AR.md'" "$PACK/README-AR.md"
rm -rf "$T" "$FR" "$NR"

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
  rc=$( "$PACK/proofs/redproof-preflight.sh" >/dev/null 2>&1; echo $? )
  if [ "$rc" = 0 ]; then
    printf 'ok    %-26s rc=0 again once the cluster is back (the proof reverted its own world)\n' no-cluster-revert
  else
    printf 'FAIL  %-26s rc=%s after restarting the cluster — the sweep left the box broken\n' no-cluster-revert "$rc"
    fail=$((fail+1))
  fi
fi

[ -n "$WT2" ] && git -C "$REPO" worktree remove --force "$WT2" >/dev/null 2>&1
rm -rf "$WT"

echo "== $fail gate(s)/proof(s) not as required"
[ "$fail" -eq 0 ] || exit 1
