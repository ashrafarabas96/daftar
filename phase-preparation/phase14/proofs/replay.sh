#!/bin/bash
# Phase 14 proof replay — THE documented driver. The recipe is this file, not
# prose in a README: round-3 CHALLENGE P2-01 found that the README's one-line
# `while read role script` loop exits 127 on every red proof, because a plain
# `read` cannot parse the red-proof field and the pipes were executed as a
# command. A recipe that lives only in prose drifts from the driver that was
# actually used, which is round-2 P1-02's species inside the harness built to
# close it. So the driver is committed and the README points at it.
#
#   usage: ./replay.sh            replay every case, from a freshly created DB
#          ./replay.sh c7         replay only the lines whose script matches c7
#
# Exit 0 only if every case produced its REQUIRED code: 0 for a normal case,
# 3 for a red proof. Anything else is reported and fails the replay.
set -u
FILTER="${1:-}"
BIN=/usr/lib/postgresql/16/bin
SOCK=/tmp/p14pg/sock; PORT=54314; DB=p14scratch
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=/tmp/p14pg/out; mkdir -p "$OUT"; chmod 777 "$OUT" 2>/dev/null

if [ -z "$FILTER" ]; then
  echo "== recreating $DB so the replay starts from a clean database"
  su claude -s /bin/bash -c "$BIN/psql -h $SOCK -p $PORT -U p14super -d postgres -q \
     -c 'DROP DATABASE IF EXISTS $DB' -c 'CREATE DATABASE $DB OWNER p14_owner'" || exit 1
  su claude -s /bin/bash -c "$BIN/psql -h $SOCK -p $PORT -U p14_owner -d $DB \
     -v ON_ERROR_STOP=1 -q -f $HERE/fixture.sql" || exit 1
  echo "== preflight: asserting the run-identity claims against the cluster"
  su claude -s /bin/bash -c "$BIN/psql -h $SOCK -p $PORT -U p14_owner -d $DB \
     -v ON_ERROR_STOP=1 -q -f $HERE/preflight.sql" || {
       echo "REPLAY ABORTED: a run-identity claim is false. The evidence may not be"
       echo "produced on a runtime it misdescribes."; exit 1; }
  : > "$OUT/evidence.psv"
fi

fail=0; n=0
while read -r role script alias; do
  case "$role" in ''|'#'*) continue ;; esac
  [ -n "$FILTER" ] && case "$script" in *"$FILTER"*) ;; *) continue ;; esac
  n=$((n+1))
  if [ -n "${alias:-}" ]; then want=3; else want=0; alias="$(basename "$script" .sql)"; fi
  P14_CASE_ALIAS="$alias" "$HERE/run.sh" "$role" "$HERE/$script" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne "$want" ]; then
    printf 'FAIL  %-34s role=%-13s exit=%s  (required %s)\n' "$alias" "$role" "$rc" "$want"
    sed -n '1,4p' "$OUT/$(basename "$script" .sql).log" | sed 's/^/        /'
    fail=$((fail+1))
  else
    note=""; [ "$want" = 3 ] && note="  (red proof: 3 is REQUIRED)"
    printf 'ok    %-34s role=%-13s exit=%s%s\n' "$alias" "$role" "$rc" "$note"
  fi
done < "$HERE/ORDER"

echo "== $n case(s) replayed, $fail not at their required exit code"
[ "$fail" -eq 0 ] || exit 1
