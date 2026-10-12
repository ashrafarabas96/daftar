#!/usr/bin/env bash
# The DB lane of the Phase 5 prep: start a SCRATCH PostgreSQL cluster, create
# the DDL the MIGRATION PATCH REQUEST asks for, run the executed concurrency
# proof against it, stop the cluster.
#
# A lane of its own, not part of `npm test`, for two reasons: the pure gate
# must stay a pure gate (a green run of it is a statement about 215 pure
# cases and nothing else), and the test economy law says not to pay for a
# cluster on every small change.
#
# It touches NOTHING in the repository: its own data directory, its own port,
# its own schemas, and nothing from infrastructure/database/migrations.
set -uo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGPORT_P5=${PGPORT_P5:-54329}
PGUSER_P5=p5owner
CLUSTER=${P5_CLUSTER_DIR:-/home/p5pg/p5cluster}
# The DEPLOY COLLATION. The approved target is PostgreSQL 16 with
# `en_US.utf8` (Master Continuous Mission V3 §15, restated by the
# High-Velocity mission), and rounds 4-6 all ran under `--locale=C` because
# that is what `initdb` took without argument in this container. C and
# en_US.utf8 do not sort text the same way, so a proof taken under C is not
# a proof about the deploy target: this lane now runs the target by default.
#
# If the locale is not present, the lane FAILS rather than falling back to C.
# A silent downgrade of the collation would mean every later report quoted
# the deploy target for a run that never used it.
P5_LOCALE=${P5_LOCALE:-en_US.utf8}
# P5_SQL_DIR exists for the RED PROOFS: a mutation is applied to a COPY of
# these files in a scratch directory and the runner is pointed at it, so no
# mutation is ever applied to a file in the repository. That is PART 6's law
# (no mutation of a frozen migration, even temporarily) applied one step
# further than PART 6 requires, after this thread's own round-2 incident.
SQLDIR="${P5_SQL_DIR:-$(cd "$(dirname "$0")/sql" && pwd)}"

if ! id p5pg >/dev/null 2>&1; then
  # initdb refuses to run as root; the cluster needs an unprivileged owner.
  useradd -m -s /bin/bash p5pg || exit 1
fi

if [ ! -f "$CLUSTER/data/PG_VERSION" ]; then
  mkdir -p "$CLUSTER/sock" && chown -R p5pg:p5pg "$CLUSTER"
  if ! locale -a 2>/dev/null | grep -qix "$(echo "$P5_LOCALE" | tr 'A-Z' 'a-z' | tr -d '-')" \
     && ! locale -a 2>/dev/null | grep -qix "$P5_LOCALE"; then
    echo "P5_LOCALE=$P5_LOCALE is not available in this container; the deploy collation cannot be used."
    echo "Generate it (locale-gen) or state the gap. This lane does not silently fall back to C."
    exit 1
  fi
  su p5pg -c "$PGBIN/initdb -D $CLUSTER/data -U $PGUSER_P5 --auth=trust -E UTF8 --locale=$P5_LOCALE" \
    > "$CLUSTER/initdb.log" 2>&1 || { echo "initdb failed"; tail -5 "$CLUSTER/initdb.log"; exit 1; }
fi

if ! pg_isready -h localhost -p "$PGPORT_P5" >/dev/null 2>&1; then
  mkdir -p "$CLUSTER/sock" && chown -R p5pg:p5pg "$CLUSTER/sock"
  # unix_socket_directories: /var/run/postgresql is not writable by p5pg.
  su p5pg -c "$PGBIN/pg_ctl -D $CLUSTER/data \
    -o '-p $PGPORT_P5 -c listen_addresses=localhost -c unix_socket_directories=$CLUSTER/sock \
        -c fsync=off -c max_connections=60 -c deadlock_timeout=200ms' \
    -l $CLUSTER/pg.log start -w" || { echo "pg_ctl failed"; tail -10 "$CLUSTER/pg.log"; exit 1; }
fi

export P5_DB_OWNER_URL="postgresql://$PGUSER_P5@localhost:$PGPORT_P5/postgres"
export P5_DB_APP_URL="postgresql://p5_app:p5apppw@localhost:$PGPORT_P5/postgres"

psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-scratch.sql" > /dev/null || exit 1
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-naive.sql"   > /dev/null || exit 1
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-roles.sql"   > /dev/null || exit 1

# The collation is part of the evidence, not a footnote: PART 19 requires the
# database version AND collation for every proof.
psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT 'PG=' || current_setting('server_version') || ' lc_collate=' || datcollate || ' lc_ctype=' || datctype || ' encoding=' || pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()" 

psql -tA "$P5_DB_OWNER_URL" -c "SELECT version()"
npx vitest run --config vitest.db.config.ts "$@"
rc=$?
echo "DB_PROOF_RC=$rc"
exit $rc
