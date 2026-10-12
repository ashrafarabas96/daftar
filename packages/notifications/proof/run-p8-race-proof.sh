#!/usr/bin/env bash
# =====================================================================
# Phase 8 — I-1 on the REAL schema: two connections, one obligation
# =====================================================================
# ROUND 12. Round 10 had an executed race — the only one this phase has ever
# had — and round 11's new runner did not carry it over. The fifth challenge
# noticed and reported it as a coverage regression rather than a finding,
# because round 11 said plainly that concurrency was unmeasured. Saying so is
# honest; dropping the one race that existed is still a loss. It is restored
# here, against the real schema and as the REAL `daftar_app` role with the real
# session GUCs, where round 10's version used a bypass flag that no longer
# exists.
#
# WHAT IT PROVES. That `notifications_obligation_once` is enforced by the
# DATABASE under genuine contention, with the loser provably WAITING on the
# winner's uncommitted key rather than merely arriving later. The wait is read
# out of `pg_locks` and `pg_stat_activity`; there is no `sleep` anywhere, and
# the script greps itself to keep it so. A bound that runs out FAILS the case:
# a proof that can hang reports nothing.
#
# WHAT IT DOES NOT PROVE. Nothing about timing, throughput or how long anything
# took. The only temporal claim is the ORDER of two events, which the lock views
# state as fact.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
B=${PG_BIN:-/usr/lib/postgresql/16/bin}
D=${PG_DIR:-/var/tmp/p8pg}
P=${PG_PORT:-55438}
RUN=${RUN_ID:-RACE-$(date -u +%Y%m%dT%H%M%SZ)}
OUT=${RACE_OUT:-$D/$RUN-race}
mkdir -p "$OUT"
status=0
say(){ echo "[$RUN] $*"; }

sup(){ "$B/psql" -h "$D" -p "$P" -U p8super -d daftar -qAt -c "$1"; }

T=11111111-1111-4111-8111-111111111111
BIZ=bbbbbbbb-0000-4000-8000-000000000001
CUST=cccccccc-0000-4000-8000-000000000001

# The insert both connections attempt. The obligation key is THE SAME in both —
# that is the point, and the first version of this script took it as a parameter
# alongside the event id, gave the two connections different keys, and sat in
# the bounded wait until it ran out, reporting "the loser never blocked". It was
# right: there was nothing to block on. Only the event id varies now, so the one
# thing they contend for is the key.
RACE_KEY="RACE|event:shared|low_stock|customer:1"
A_EVENT=0eeeeeee-0000-4000-8000-0000000000a1
B_EVENT=0eeeeeee-0000-4000-8000-0000000000b1
ins(){ cat <<SQL
INSERT INTO notifications (tenant_id, business_id, kind, consent_class, customer_id,
                           locale, subject_refs, obligation_key, source_event_id)
VALUES ('$T', '$BIZ', 'low_stock', 'operational', '$CUST', 'ar', '{}'::jsonb,
        '$RACE_KEY', '$1');
SQL
}

await(){           # await <sql returning a count> <what is being waited for>
  local sql=$1
  local what=$2
  local i=0
  until [ "$(sup "$sql")" -ge 1 ]; do
    i=$((i+1))
    # A BOUND, not a sleep. Round 10 learned this the hard way: a handshake with
    # no bound hangs forever when the race goes the other way, and a proof that
    # can hang reports nothing.
    if [ $i -gt 20000 ]; then say "I1-conc FAIL: the bound ran out waiting for $what"; return 1; fi
  done
  return 0
}

FIFO=$OUT/fifo
rm -f "$FIFO"; mkfifo "$FIFO"

# Connection A: insert, do not commit, then take an advisory lock so that its
# having inserted is OBSERVABLE rather than assumed.
"$B/psql" -h "$D" -p "$P" -U daftar_app -d daftar -q -v ON_ERROR_STOP=1 -f "$FIFO" > "$OUT/a.log" 2>&1 &
APID=$!
exec 3>"$FIFO"
{
  echo "BEGIN;"
  echo "SET LOCAL app.tenant_id = '$T';"
  echo "SET LOCAL app.business_id = '$BIZ';"
  ins "$A_EVENT"
  echo "SELECT pg_advisory_lock(8801);"
} >&3

if await "select count(*) from pg_locks where locktype='advisory' and objid=8801" "A to insert and signal"; then
  # Connection B: the same obligation key, a different event.
  {
    echo "SET app.tenant_id = '$T';"
    echo "SET app.business_id = '$BIZ';"
    ins "$B_EVENT"
  } > "$OUT/b.sql"
  "$B/psql" -h "$D" -p "$P" -U daftar_app -d daftar -q -v ON_ERROR_STOP=1 -f "$OUT/b.sql" > "$OUT/b.log" 2>&1 &
  BPID=$!
  # B is now provably BLOCKED on A's uncommitted key, not merely slower. This is
  # the whole difference between a race proof and a coincidence.
  if await "select count(*) from pg_stat_activity where datname='daftar' and wait_event_type='Lock'" "B to block on the key"; then
    printf '%s\n' "SELECT pg_advisory_unlock(8801);" "COMMIT;" >&3
    exec 3>&-
    wait $APID; ARC=$?
    wait $BPID; BRC=$?
    survivors=$(sup "select count(*) from notifications where obligation_key like 'RACE|%'")
    if [ "$ARC" = "0" ] && [ "$BRC" != "0" ] && [ "$survivors" = "1" ] \
       && grep -q 'notifications_obligation_once' "$OUT/b.log"; then
      say "I1-conc PASS: B waited on A's uncommitted key; one survivor; the loser refused by notifications_obligation_once"
    else
      say "I1-conc FAIL: A=$ARC B=$BRC survivors=$survivors"
      sed -n 1,5p "$OUT/b.log"
      status=1
    fi
  else
    # NAME THE REAL CAUSE, and read it from the DATABASE rather than from
    # process state. The bound running out has two very different meanings, and
    # R-6/R-7 of the fifth challenge is exactly about not conflating them: B may
    # be slow to reach a lock wait, or there may be NOTHING TO BLOCK ON, which
    # is what happens when the unique it contends for is gone. Mutant 12 removes
    # that unique, so the message has to tell them apart. An earlier version
    # asked `kill -0` and `wait` about B and got "pid is not a child of this
    # shell" and a fabricated exit code 127 — process bookkeeping is not
    # evidence here; the row count is.
    exec 3>&-
    kill $APID $BPID 2>/dev/null
    wait 2>/dev/null
    # A is killed before it commits, so its row is gone and a total count is
    # not the question. The question is whether B'S OWN row committed: if it
    # did, B was never refused, and the key that should have been unique is not.
    bland=$(sup "select count(*) from notifications where source_event_id = '$B_EVENT'")
    if [ "${bland:-0}" -ge 1 ]; then
      say "I1-conc FAIL: B never blocked and its row COMMITTED — nothing refused a second notification for one obligation, so the key that should have been unique is not"
    else
      say "I1-conc FAIL: B never reached a lock wait and its row is absent — see $OUT/b.log"
      sed -n 1,3p "$OUT/b.log"
    fi
    status=1
  fi
else
  status=1; exec 3>&-; kill $APID 2>/dev/null
fi

# The row this case committed is removed, so the suite that follows starts from
# the same fixtures it always did. Every other case file rolls itself back; this
# one cannot, because a race needs a real commit.
sup "DELETE FROM notifications WHERE obligation_key LIKE 'RACE|%'" >/dev/null

# (written with a character class so this very line does not match itself — a
# self-grep that matches its own pattern always fails, which is how a guard
# comes to report a defect that is not there)
if grep -qE "pg_sle[e]p|(^|[;&| ])sle[e]p +[0-9.]" "$0"; then
  say "I1-conc FAIL: this proof must contain no sleep"; status=1
fi

say "RACE status=$status"
exit $status
