#!/usr/bin/env bash
# =====================================================================
# RETIRED — this gate does not run. Round 22, open item OD-P8-14.
# =====================================================================
# WHY. Round 11 replaced the standalone transcription this gate measures with
# an OVERLAY on the real frozen schema, and from round 12 the authoritative gate
# sections stopped listing this gate. Round 12 also gave `p8-ddl-prototype.sql`
# a composite foreign key to `users (id, business_id)` while that file's own
# stub is global, so the prototype has not APPLIED since — the gate has been
# red, failing closed, and unlisted, for nine rounds. The composite key was a
# rule the pack had already retracted in writing: the user reference goes
# through the membership relation, not through a key, because the real `users`
# has no business dimension.
#
# WHAT COVERS ITS INVARIANTS NOW, AND WHAT DOES NOT. Retiring a gate whose
# invariants nothing else exercises is a deletion wearing a retirement's name,
# so this is stated family by family and not as one sentence.
#
#   * I-8f / N-6 — ported in round 22 into `run-p8-real-proof.sh` as cases
#     `I8f-a`..`I8f-e` and `N6-a`..`N6-i`, with mutant 13 removing the arrival
#     conjunct from the real overlay's partial index and requiring `N6-e` to red
#     by name. Measured before this file was retired: baseline 54 -> 69 cases.
#   * `W-1`..`W-7`, the worker's grants, and `I3-a`..`I3-i`, the status ladder —
#     ported in round 24 into `p8-real-cases-worker.sql`, which runs as the REAL
#     `daftar_worker` under the real policies, with mutant 15 widening the
#     column-scoped `UPDATE` grant (must red `W-2`) and mutant 14 dropping the
#     monotonic trigger (must red `I3-d`). Baseline 69 -> 91 cases.
#     **ROUND 24 CORRECTION.** Round 22's version of this file said the
#     invariants were covered by the live gate, full stop, and the handoff said
#     the role cases were superseded. Both were FALSE for this family: no live
#     case ran as `daftar_worker` at all, which the fifteenth challenge (O-4)
#     and the coordinator's diff review (C-1) each measured independently by
#     widening a worker grant and watching the gate stay green. The claim is
#     narrowed to what is measured, and the sentence that was wrong is left
#     visible rather than quietly replaced.
#   * `H-3` (the quarantine) — ported in round 24 as `H-3`, `H-3b`, `H-3c`,
#     because the worker is the live principal that holds its `INSERT`.
#   * `H-1`, `H-2`, `H-4` — **UNMEASURED at runtime, and not covered here.**
#     They are rules about a WEBHOOK principal, the frozen role set contains no
#     webhook role (an open owner item in the overlay's §6), and the live worker
#     both reads `notifications` and holds `UPDATE (status, ...)`. They are not
#     approximated with a principal that is not the subject of the rule; they
#     wait on the administrator's role-creation step at promotion.
#   * EVERY OTHER retired case — **ROUND 25, and this is the honest count.**
#     The lines above name the families that were ported; they do not say how
#     much of this file that is, and a reader could take "covered" for "all".
#     The sixteenth challenge counted it (R-4) and corrected its own earlier
#     figure doing so: a literal comparison had read `A-4` here and `A4` in the
#     live files as two different cases. Normalising that spelling, this
#     directory declares **93** case ids and **56** of them have no live
#     counterpart by name — **ROUND 27 CORRECTION**: this block said 55, which
#     is the TABLE's row count, not the figure the published rule gives. One of
#     the 56 is not an id at all but the loop-constructed family
#     `'I1b-' || (i+1)` below, which a static scan cannot enumerate, so it is
#     counted once in the 56 and excluded from the table's 55. The two numbers
#     are different things and each is now named as what it is.
#     **Ten are carried**: eight re-expressed under other live ids — `A-6`,
#     `G-3`, `G-4`, `N6-j`, `I9c2-a`, `I9c2-b`, `R-1`, `R-2`, of which `G-3`
#     and `G-4` ARE the worker ports named above — and `I8-a`/`I8-b`, carried
#     for the worker only. **Forty-five are not**, and **ROUND 27 CORRECTION**
#     (the coordinator's F-4): the split published in round 25 UNDERSTATED the
#     unexercised refusals. It put 23 in one group and 16 in "accepted paths or
#     catalogue censuses", but four of those sixteen are `case_refuses` —
#     `I8e-a`, `I8e-d`, `I9a1-c` and `I9c1` — so a reader counting refusals got
#     23 where the number is **27**. Classifying by the helper each case calls,
#     rather than by what its label reads like, the forty-five are: **27
#     refusals that nothing exercises** (23 naming a constraint the overlay
#     carries, 4 naming none), **8 accepted paths**, **4 catalogue censuses**,
#     **4** naming a principal the frozen role set does not contain (`G-5` with
#     `H-1`/`H-2`/`H-4`), and **2** grant censuses on the app role. Each of the fifty-five is named, one by one, in
#     `P8-HANDOFF-MANIFEST.md`, section "THE RETIRED IDS, ONE BY ONE". A
#     constraint present but unexercised is NOT the same as an absent one, and
#     it is NOT the same as a measured one either: that is the distinction this
#     block exists to keep, because the sentence that had to be corrected twice
#     in this file was each time a coverage claim wider than its measurement.
#
# It is kept, not deleted, so a reader can see what was measured and how.
# It refuses rather than runs: a retired gate that still executes is a gate.
set -u
echo "RETIRED: this gate was retired in round 22 (OD-P8-14) and does not run." >&2
echo "         COVERED by run-p8-real-proof.sh on the real schema: I8f-a..I8f-e and" >&2
echo "         N6-a..N6-i with mutant 13 (round 22); W-1..W-7, I3-a..I3-i and the" >&2
echo "         quarantine H-3* as the real daftar_worker, with mutants 14 and 15" >&2
echo "         (round 24)." >&2
echo "         NOT covered, UNMEASURED at runtime: H-1, H-2, H-4 — they are rules" >&2
echo "         about a WEBHOOK principal and the frozen role set has no such role." >&2
echo "         THE COUNT (round 25; corrected round 27): of the 93 case ids declared" >&2
echo "         here, 56 have no live counterpart by name. One of the 56 is not an" >&2
echo "         id but the loop-constructed family 'I1b-' || (i+1), which a static" >&2
echo "         scan cannot enumerate, so the table names 55. TEN are carried," >&2
echo "         FORTY-FIVE are not:" >&2
echo "         27 REFUSALS that nothing exercises (23 naming a constraint the" >&2
echo "         overlay carries, 4 naming none), 8 accepted paths, 4 catalogue" >&2
echo "         censuses, 4 with no live principal, 2 grant censuses on the app" >&2
echo "         role. Every one is named in" >&2
echo "         P8-HANDOFF-MANIFEST.md, 'THE RETIRED IDS, ONE BY ONE'." >&2
echo "         Kept for the record, never deleted. Refusing with exit 2." >&2
exit 2
# =====================================================================
# Phase 8 — the DDL proof. Applies the prototype of `P8-DDL-SPEC.md` to a
# real PostgreSQL 16 cluster at `en_US.utf8` as a NOSUPERUSER NOBYPASSRLS
# NOCREATEROLE migrator, then runs every invariant, grant and isolation
# case, each asserting its refusal BY NAME.
#
# Exit code IS the verdict:
#   0  every case reached its stated outcome, and all five mutants red
#   1  a case or a mutant did not
#   2  the environment is not the target (refused, not worked around)
#
# It touches nothing under `db/migrations` (byte-immutable, including for
# mutation testing) and allocates no migration number. The mutants are
# applied to COPIES of the prototype in the run directory.
# =====================================================================
set -u
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
PORT=${PG_PORT:-55438}
DIR=${PG_DIR:-/var/tmp/p8pg}          # deliberately outside /tmp/claude-0
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=${RUN_ID:-P8-DDL-$(date -u +%Y%m%dT%H%M%SZ)}
OUT=$DIR/$RUN; mkdir -p "$OUT"

fail() { echo "REFUSED: $*" >&2; exit 2; }
[ -x "$BIN/psql" ] || fail "no PostgreSQL 16 client at $BIN (set PG_BIN)"
locale -a 2>/dev/null | grep -qx 'en_US.utf8' || fail "the en_US.utf8 locale is absent (localedef -i en_US -f UTF-8 en_US.UTF-8)"
"$BIN/pg_isready" -h "$DIR" -p "$PORT" >/dev/null 2>&1 || fail "no cluster at $DIR:$PORT"

sup() { "$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d "${2:-postgres}" -q -v ON_ERROR_STOP=1 -c "$1"; }
ver=$("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc 'select version()')
col=$("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc "select datcollate from pg_database where datname='postgres'")
case "$ver" in *"PostgreSQL 16."*) ;; *) fail "the cluster is not the 16 family: $ver" ;; esac
[ "$col" = "en_US.utf8" ] || fail "collation is '$col', not en_US.utf8 — the settled deploy line"
echo "run      : $RUN"
echo "cluster  : $ver"
echo "collation: $col"

# The ADMINISTRATOR's step: roles. The migrator is NOCREATEROLE, as the deploy
# role is, so the prototype only grants to roles that already exist.
sup "DO \$\$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['p8_migrator','p8_app','p8_worker','p8_webhook'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE', r);
    END IF;
  END LOOP; END \$\$;" >/dev/null
for r in p8_migrator p8_app p8_worker p8_webhook; do
  priv=$("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc \
    "select rolsuper::text||','||rolbypassrls::text from pg_roles where rolname='$r'")
  [ "$priv" = "false,false" ] || fail "$r is not NOSUPERUSER NOBYPASSRLS (pg_roles: $priv)"
done
echo "principals: migrator, app, worker, webhook — all NOSUPERUSER NOBYPASSRLS"

run_one() { # <db> <role> <file...>  -> prints exit code
  local db=$1 role=$2; shift 2
  local args=(); for f in "$@"; do args+=(-f "$f"); done
  "$BIN/psql" -h "$DIR" -p "$PORT" -U "$role" -d "$db" -q -v ON_ERROR_STOP=1 "${args[@]}"
}

apply_suite() { # <db> <prototype>  -> 0 when every case reached its outcome
  local db=$1 proto=$2 rc=0 got
  sup "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1
  sup "CREATE DATABASE $db OWNER p8_migrator" >/dev/null
  run_one "$db" p8_migrator "$proto" "$HERE/p8-case-helpers.sql" "$HERE/p8-ddl-cases.sql" \
    > "$OUT/$db-migrator.log" 2>&1; got=$?; [ $got -eq 0 ] || rc=$got
  echo "  migrator cases: exit $got  ($(grep -c 'PASS' "$OUT/$db-migrator.log") passed)"
  for r in app worker webhook; do
    run_one "$db" "p8_$r" "$HERE/p8-role-cases-$r.sql" > "$OUT/$db-$r.log" 2>&1; got=$?
    [ $got -eq 0 ] || rc=$got
    echo "  as p8_$r:       exit $got  ($(grep -c 'PASS' "$OUT/$db-$r.log") passed)"
  done
  return $rc
}

status=0
echo "--- baseline"
apply_suite p8proof "$HERE/p8-ddl-prototype.sql" || { echo "BASELINE FAILED"; status=1; }

# I-1 under genuinely concurrent inserts, two connections, no sleep anywhere:
# the second waits on the first's uncommitted key and is refused at its commit.
echo "--- I-1 concurrency (two connections, no sleep)"
# The spec's §9 item 2: two connections, the same obligation key, one survivor,
# and no sleep anywhere — a race "proved" by waiting a while is proved for one
# machine on one day.
#
# The handshake is explicit, and the first version of it was WRONG in a way
# worth recording: it started both sessions and let the writer poll for a lock
# wait. B won the race, A took the duplicate, and the poll then spun forever on
# a condition that could no longer arrive. A proof that can hang is a proof that
# will one day be killed by a timeout and reported as neither pass nor fail, so
# every wait below is bounded and a bound that runs out FAILS the case.
CONC=$OUT/conc; mkdir -p "$CONC"; FIFO=$CONC/a.fifo; rm -f "$FIFO"; mkfifo "$FIFO"
q() { "$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d p8proof -Atc "$1"; }
await() { # <sql returning a count> <what is being waited for>
  local i=0
  until [ "$(q "$1")" -ge 1 ]; do
    i=$((i+1))
    if [ $i -gt 20000 ]; then echo "  I1-conc FAIL: waited out on $2"; return 1; fi
  done
}
RI="INSERT INTO p8.notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id) VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','low_stock','operational','c1111111-1111-1111-1111-111111111111','ar','{}','k-race',"

"$BIN/psql" -h "$DIR" -p "$PORT" -U p8_migrator -d p8proof -q -v ON_ERROR_STOP=1 -f "$FIFO" > "$CONC/a.log" 2>&1 &
APID=$!
exec 3>"$FIFO"
printf '%s\n' "BEGIN;" "SET app.bypass_rls='on';" \
  "${RI}'e1000000-0000-0000-0000-0000000000aa');" "SELECT pg_advisory_lock(8801);" >&3
# A has inserted, and not committed, once it holds the advisory lock.
if await "select count(*) from pg_locks where locktype='advisory' and objid=8801" "A to insert"; then
  "$BIN/psql" -h "$DIR" -p "$PORT" -U p8_migrator -d p8proof -q -v ON_ERROR_STOP=1 \
    -c "SET app.bypass_rls='on'" -c "${RI}'e1000000-0000-0000-0000-0000000000bb')" > "$CONC/b.log" 2>&1 &
  BPID=$!
  # B is now provably BLOCKED on the uncommitted key, not merely slower.
  if await "select count(*) from pg_stat_activity where datname='p8proof' and wait_event_type='Lock'" "B to block on the key"; then
    printf '%s\n' "SELECT pg_advisory_unlock(8801);" "COMMIT;" >&3
    exec 3>&-
    wait $APID; ARC=$?
    wait $BPID; BRC=$?
    survivors=$(q "select count(*) from p8.notifications where obligation_key='k-race'")
    if [ "$ARC" = "0" ] && [ "$BRC" != "0" ] && [ "$survivors" = "1" ] \
       && grep -q 'notifications_obligation_once' "$CONC/b.log"; then
      echo "  I1-conc PASS: B waited on A's uncommitted key; one survivor; the loser refused by notifications_obligation_once"
    else
      echo "  I1-conc FAIL: A=$ARC B=$BRC survivors=$survivors"; sed -n 1,5p "$CONC/b.log"; status=1
    fi
  else
    status=1; exec 3>&-; kill $APID $BPID 2>/dev/null
  fi
else
  status=1; exec 3>&-; kill $APID 2>/dev/null
fi
# (the pattern below is written with a character class so that this very line
# does not match itself — a self-grep that matches its own pattern always fails,
# which is how a guard comes to report a defect that is not there)
if grep -qE "pg_sle[e]p|(^|[;&| ])sle[e]p +[0-9.]" "$0"; then
  echo "  I1-conc FAIL: this proof must contain no sleep"; status=1
fi

# ----------------------------------------------------------------- mutants
# A case suite that cannot go red measures nothing. Each mutant removes ONE
# defence and must red the case named beside it.
echo "--- mutants (each must red its named case)"
mutate() { # <name> <sed expr> <case that must fail>
  local name=$1 expr=$2 want=$3
  local file=$OUT/proto-$name.sql
  sed "$expr" "$HERE/p8-ddl-prototype.sql" > "$file"
  if cmp -s "$file" "$HERE/p8-ddl-prototype.sql"; then
    echo "  $name: MUTATION DID NOT LAND"; status=1; return
  fi
  if apply_suite "p8mut_$name" "$file" > "$OUT/mut-$name.summary" 2>&1; then
    echo "  $name: the suite stayed GREEN with the defence removed — $want proves nothing"; status=1
  else
    if grep -qh "$want" "$OUT"/p8mut_$name-*.log; then
      echo "  $name: red at $want, as required"
    else
      echo "  $name: red, but NOT at $want"; grep -h 'FAIL' "$OUT"/p8mut_$name-*.log | head -2; status=1
    fi
  fi
}
mutate arrivalfact "s/AND final_status_verified AND NOT arrival_ever_recorded)/AND final_status_verified)/" 'N6-e'
# the round-6 order: `failed` above `read`, so a late failure is "forward"
mutate oldladder   "s/WHEN 'failed' THEN 2/WHEN 'failed' THEN 5/" 'I3-e'
mutate permissive  "s/AS RESTRICTIVE FOR ALL/AS PERMISSIVE FOR ALL/" 'R-2'
mutate appupdate   "s/GRANT SELECT, INSERT ON notifications TO p8_app;/GRANT SELECT, INSERT, UPDATE ON notifications TO p8_app;/" 'G-1'
mutate openstates  "s/WHERE delivery_state NOT IN ('dead','withheld','suppressed')/WHERE delivery_state IN ('queued','sending','unknown','retry_scheduled')/" 'I8f-a'

echo "--- logs in $OUT"
exit $status
