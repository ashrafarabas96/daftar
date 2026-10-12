#!/bin/bash
# Red proofs for preflight.sql's OWN arms. Round-5 CHALLENGE P3-03: the README
# red-proofed the BYPASSRLS arm only, so by the pack's own law -- an assertion
# that has never failed is an unfenced assertion -- the encoding, collation and
# version arms were unproved. The collation arm is the one guarding the settled
# deploy target (PG 16 @ en_US.utf8), and the challenger proved it with one
# command; it is committed here rather than left in prose, which is round-3
# P2-01's lesson applied to this file.
#
#   usage: ./redproof-preflight.sh            run every arm that can be proved
#          ./redproof-preflight.sh collation  one arm
#
# Each arm MUTATES, runs preflight.sql, REQUIRES exit 1 (or 3 where psql aborts
# on the DO block), then REVERTS. Exit 0 only if every arm turned red.
set -u
BIN=/usr/lib/postgresql/16/bin
SOCK=/tmp/p14pg/sock; PORT=54314
HERE=$(cd "$(dirname "$0")" && pwd)
WANT="${1:-all}"
fail=0; n=0

psql_as() { su claude -s /bin/bash -c "$BIN/psql -h $SOCK -p $PORT -U $1 -d $2 -v ON_ERROR_STOP=1 -q $3" 2>&1; }

arm() { # name | setup-sql-as-p14super | db to preflight | teardown
  local name="$1" setup="$2" db="$3" teardown="$4"
  [ "$WANT" = all ] || [ "$WANT" = "$name" ] || return 0
  n=$((n+1))
  [ -n "$setup" ] && psql_as p14super postgres "-c \"$setup\"" >/dev/null
  out=$(psql_as p14_owner "$db" "-f $HERE/preflight.sql"); rc=$?
  [ -n "$teardown" ] && psql_as p14super postgres "-c \"$teardown\"" >/dev/null
  if [ "$rc" -eq 0 ]; then
    printf 'FAIL  %-12s preflight exited 0 — the arm did NOT turn red, so it is unfenced\n' "$name"
    fail=$((fail+1))
  else
    printf 'ok    %-12s preflight exit=%s  %s\n' "$name" "$rc" "$(echo "$out" | grep -m1 'CLAIM FALSE' | sed 's/^[A-Z]*:  *//')"
  fi
}

# (1) COLLATION — a database built on C/C instead of en_US.utf8. This is the
# arm that guards the settled deploy target: a result measured on the wrong
# collation is OFF-TARGET, which is exactly how Phase 9's 75-case base was lost.
arm collation \
  "CREATE DATABASE p14wrongcoll OWNER p14_owner TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'" \
  p14wrongcoll \
  "DROP DATABASE IF EXISTS p14wrongcoll"

# (2) ENCODING — SQL_ASCII, which is not UTF8. Needs LC_COLLATE C as well,
# because PostgreSQL refuses SQL_ASCII with an en_US.utf8 collation; the
# encoding arm is reached first, so it is the one that fires.
arm encoding \
  "CREATE DATABASE p14wrongenc OWNER p14_owner TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'" \
  p14wrongenc \
  "DROP DATABASE IF EXISTS p14wrongenc"

# (3) PRINCIPAL — a role under test given BYPASSRLS. Every privilege and RLS
# result in the evidence depends on this being false.
arm bypassrls \
  "ALTER ROLE p14_worker BYPASSRLS" \
  p14scratch \
  "ALTER ROLE p14_worker NOBYPASSRLS"

# (4) PRINCIPAL — a role under test made SUPERUSER.
arm superuser \
  "ALTER ROLE p14_merchant SUPERUSER" \
  p14scratch \
  "ALTER ROLE p14_merchant NOSUPERUSER"

# (5) PRINCIPAL — a role under test missing entirely.
arm rolecount \
  "ALTER ROLE p14_resolver RENAME TO p14_resolver_x" \
  p14scratch \
  "ALTER ROLE p14_resolver_x RENAME TO p14_resolver"

# The VERSION arm is NOT proved here and is not claimed to be: it needs a second
# cluster of a different major version, which this container does not have. It
# is recorded as UNFENCED rather than described as proved.

echo "== $n arm(s), $fail not red.  The version arm is UNFENCED (needs a second cluster)."
[ "$fail" -eq 0 ] || exit 1
