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
#          ./replay.sh c7         replay the ORDER prefix up to and including
#                                 the last line whose SCRIPT PATH CONTAINS c7,
#                                 from a freshly created DB
#
# The filter is a SUBSTRING of the script path, not a family name, and that is
# easy to forget: `./replay.sh nope` replays 33 cases, because
# `c7c_assertio[nope]rable.sql` contains it. Measured while testing the
# no-match path, which is why the no-match path is loud (exit 2) rather than an
# empty success.
#
# Round-5 CHALLENGE P2-01: the filtered form used to SKIP the database
# recreation, the fixture AND the preflight, so it could not exit 0 in any state
# of the database -- and in the state a reader is actually in (straight after a
# full replay) `c7c_assertion_inoperable` printed `FINDING REFUTED` about the
# live TL-P14-SEC-02 ruling, when the real cause was c7d's GRANT surviving from
# the previous run. A leftover grant must never be able to print a verdict. The
# prerequisite assertions added in round 3 fence only the ABSENCE of a required
# relation, never the PRESENCE of state a case requires to be absent, so they
# cannot catch a dirty database -- the same one-directional shape Phase 11 paid
# for. The remedy is structural rather than another assertion: there is now ONE
# setup path, taken unconditionally, and a filter selects how far down ORDER the
# replay goes, never whether the database is clean.
#
# Exit 0 only if every case produced its REQUIRED code: 0 for a normal case,
# 3 for a red proof. Anything else is reported and fails the replay.
set -u
FILTER="${1:-}"
BIN=/usr/lib/postgresql/16/bin
SOCK=/tmp/p14pg/sock; PORT=54314; DB=p14scratch
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=/tmp/p14pg/out; mkdir -p "$OUT"; chmod 777 "$OUT" 2>/dev/null

# How far down ORDER to replay. With no filter: all of it. With a filter: the
# prefix ending at the LAST matching line, because ORDER is topologically
# sorted and a case's prerequisites are its predecessors. A filter that matches
# nothing is an error, not an empty success.
LAST=0; i=0
while read -r role script alias; do
  i=$((i+1))
  case "$role" in ''|'#'*) continue ;; esac
  if [ -z "$FILTER" ]; then LAST=$i
  else case "$script" in *"$FILTER"*) LAST=$i ;; esac
  fi
done < "$HERE/ORDER"
if [ "$LAST" -eq 0 ]; then
  echo "no ORDER line matches '$FILTER' — nothing would be replayed, which is an error, not a pass"
  exit 2
fi

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
[ -n "$FILTER" ] && echo "== filter '$FILTER': replaying ORDER lines 1..$LAST (its prerequisites included)"

fail=0; n=0; i=0
while read -r role script alias; do
  i=$((i+1))
  [ "$i" -gt "$LAST" ] && break
  case "$role" in ''|'#'*) continue ;; esac
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
