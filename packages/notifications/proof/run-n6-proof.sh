#!/usr/bin/env bash
# =====================================================================
# Phase 8, round 10 — the direct-SQL proof of N-6 and its fix.
#
# This is the first EXECUTED database evidence in Phase 8. Everything in
# `P8-DDL-SPEC.md` was a text reading until this script ran; §9 of that
# spec names exactly this proof ("I-3 and I-8 proven from direct SQL, not
# through the application") as the one that would have caught N-6.
#
# What it proves, in one PostgreSQL 16 cluster at `en_US.utf8`, as a
# NOSUPERUSER NOBYPASSRLS role:
#   baseline  exit 0 — every case reaches its stated outcome, including
#                      the REPRODUCTION of N-6 on the pre-round schema
#   mutant 1  exit 3 — drop the arrival term from I-8f's predicate and
#                      case C2 fails: the second channel inserts again
#   mutant 2  exit 3 — let the set-once trigger permit a clear and case
#                      C3 fails
# A baseline that cannot reproduce N-6 aborts: a fix proof whose defect
# is unreachable proves nothing.
#
# It builds a PROTOTYPE of the §2/§4a relations. It does NOT read, apply
# or modify any file under `db/migrations` — those are byte-immutable,
# including for mutation testing — and it creates no migration.
#
# Requires: PostgreSQL 16 binaries and an `en_US.utf8` locale. Both are
# stated rather than assumed: the script refuses to run without them,
# because a proof measured on another collation is off-target evidence.
# =====================================================================
set -u
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
PORT=${PG_PORT:-55438}
DIR=${PG_DIR:-/var/tmp/p8pg}
HERE=$(cd "$(dirname "$0")" && pwd)

fail() { echo "REFUSED: $*" >&2; exit 2; }
[ -x "$BIN/initdb" ] || fail "no PostgreSQL 16 binaries at $BIN (set PG_BIN)"
locale -a 2>/dev/null | grep -qx 'en_US.utf8' || fail "the en_US.utf8 locale is absent; generate it with: localedef -i en_US -f UTF-8 en_US.UTF-8"

run() { # <database> <sql file>
  "$BIN/psql" -h "$DIR" -p "$PORT" -U p8_migrator -d "$1" -v ON_ERROR_STOP=1 -f "$2"
}
admin() { "$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

"$BIN/pg_isready" -h "$DIR" -p "$PORT" >/dev/null 2>&1 || fail "no cluster answering at $DIR:$PORT — start one with: initdb -D \$DIR/data --locale=en_US.utf8 --encoding=UTF8 -U p8super && pg_ctl -D \$DIR/data -o \"-p $PORT -k \$DIR\" -w start"

COLLATE=$("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc "select datcollate from pg_database where datname='postgres'")
[ "$COLLATE" = "en_US.utf8" ] || fail "the cluster's collation is '$COLLATE', not en_US.utf8 — the settled deploy line"
echo "cluster: $("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc 'select version()') / $COLLATE"

# The role is created only when absent: dropping one that owns earlier proof
# databases fails, and a failed drop followed by a create reads like a cluster
# fault rather than a re-run.
HAS_ROLE=$("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc "select 1 from pg_roles where rolname='p8_migrator'")
[ "$HAS_ROLE" = "1" ] || admin "CREATE ROLE p8_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE"
# The proof is worthless if it runs with more authority than the deploy role.
PRIV=$("$BIN/psql" -h "$DIR" -p "$PORT" -U p8super -d postgres -Atc "select rolsuper::text||','||rolbypassrls::text from pg_roles where rolname='p8_migrator'")
[ "$PRIV" = "false,false" ] || fail "p8_migrator is not NOSUPERUSER NOBYPASSRLS (pg_roles says $PRIV)"

sed "s/AND final_status_verified AND NOT arrival_ever_recorded)/AND final_status_verified)/" \
  "$HERE/n6-arrival-fact.sql" > "$DIR/n6.mut1.sql"
sed "s/RAISE EXCEPTION 'notification.arrival_fact_cleared' USING ERRCODE = 'check_violation';/NULL;/" \
  "$HERE/n6-arrival-fact.sql" > "$DIR/n6.mut2.sql"
# A substitution that did not land would make a mutant pass for the wrong reason.
# Each mutant is asserted to have LANDED, by the line it was meant to remove
# and not by any text that merely mentions it: the C3 notice names the error
# condition in prose, so grepping for the condition alone always matches.
grep -q 'AND NOT arrival_ever_recorded)' "$DIR/n6.mut1.sql" && fail "mutant 1 did not land"
grep -q "RAISE EXCEPTION 'notification.arrival_fact_cleared'" "$DIR/n6.mut2.sql" && fail "mutant 2 did not land"
grep -q 'AND NOT arrival_ever_recorded)' "$HERE/n6-arrival-fact.sql" || fail "the baseline has lost the arrival term; it is no longer the subject of this proof"

status=0
for case in "baseline:0:$HERE/n6-arrival-fact.sql" "mutant1:3:$DIR/n6.mut1.sql" "mutant2:3:$DIR/n6.mut2.sql"; do
  name=${case%%:*}; rest=${case#*:}; want=${rest%%:*}; file=${rest#*:}
  db="p8proof_$name"
  admin "DROP DATABASE IF EXISTS $db"
  admin "CREATE DATABASE $db OWNER p8_migrator"
  run "$db" "$file" > "$DIR/$name.log" 2>&1
  got=$?
  if [ "$got" = "$want" ]; then echo "$name: exit $got as required"
  else echo "$name: exit $got, expected $want — see $DIR/$name.log"; status=1; fi
done
exit $status
