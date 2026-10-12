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

gate() { # name | command (absolute paths only)
  local name="$1"; shift
  local first="" rc d
  for d in $DIRS; do
    rc=$( cd "$d" && eval "$@" >/dev/null 2>&1; echo $? )
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

echo "== every gate, from $(echo $DIRS | wc -w) working directories"
gate citation-provenance "python3 -I $HERE/citation-provenance.py --check $DOC"
gate manifest-digests    "python3 -I $HERE/manifest-digests.py --dir $PACK --check"
gate manifest-shared     "python3 -I $HERE/manifest-digests.py --dir $SHARED --check"
gate retracted-claims    "python3 -I $HERE/retracted-claims.py --pack $PACK --check"
if [ "$NODB" = 0 ]; then
  gate replay              "$PACK/proofs/replay.sh"
  gate redproof-preflight  "$PACK/proofs/redproof-preflight.sh"
fi

# ---- red proofs: a gate that has never failed is an unfenced gate.
echo "== red proofs"
red() { # name | mutate | command | expected-rc | restore
  local name="$1" mut="$2" cmd="$3" want="$4" res="$5" rc
  eval "$mut"; rc=$( cd /tmp && eval "$cmd" >/dev/null 2>&1; echo $? ); eval "$res"
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
  "cp '$T/doc.bak' '$DOC'"
red provenance-foreign-repo \
  "true" \
  "python3 -I $HERE/citation-provenance.py --check $DOC --repo /tmp" 2 \
  "true"
red manifest-digest-corrupt \
  "sed -i '0,/| \`[0-9a-f]\{64\}\` |/s/| \`\([0-9a-f]\{64\}\)\` |/| \`0\{64\}\` |/' '$PACK/P14-HANDOFF-MANIFEST.md'" \
  "python3 -I $HERE/manifest-digests.py --dir $PACK --check" 1 \
  "cp '$T/man.bak' '$PACK/P14-HANDOFF-MANIFEST.md'"
red retracted-claim-planted \
  "printf '\n\nthe three absent ones are cited only for Phase 4 surface facts\n' >> '$PACK/README-AR.md'" \
  "python3 -I $HERE/retracted-claims.py --pack $PACK --check" 1 \
  "cp '$T/ar.bak' '$PACK/README-AR.md'"
rm -rf "$T"

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
