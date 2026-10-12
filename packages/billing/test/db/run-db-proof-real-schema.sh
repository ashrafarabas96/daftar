#!/usr/bin/env bash
# ROUND 12 — the SAME requested DDL, on the REAL schema.
#
# The challenger's §5 cross-check and the coordinator both asked for this:
# until now the relations Phase 5 borrows were hand-written copies in
# `credit-ledger-fixture.sql`, and the cross-phase standard (Phase 6,
# Phase 11) is to apply the frozen history with the PROJECT'S OWN RUNNER and
# put the slice's DDL on top. Phase 6 found that its own psql loop carried an
# error the runner would not have, which is the whole argument.
#
# What this script does, in order:
#   1. a scratch cluster of its own, PostgreSQL 16 at the deploy collation;
#   2. `infrastructure/database/bootstrap.sql` as the cluster superuser, from
#      a SCRATCH COPY with the password placeholders substituted — the file
#      belongs to another owner and is not edited;
#   3. the whole migration history through `npm run migrate` as
#      `daftar_migrator`, the deployment principal, NOT as a superuser;
#   4. this lane's own roles (`credit-ledger-bootstrap.sql`), the privileges
#      `daftar_platform` and `p5_app` need on the FROZEN relations, granted by the
#      role that owns them;
#   5. the requested DDL — unchanged, byte for byte the same file the fixture
#      lane applies — in a schema of its own, resolving `businesses`,
#      `currencies`, `business_entitlements` and the three `app_*` context
#      functions to the REAL ones through `search_path`;
#   6. the same cases, with `P5_BORROWED_SCHEMA=public`.
#
# What it does NOT do: touch `main`, the migrations directory, any frozen
# file, or the fixture lane. Both lanes stay runnable, and a report says
# which one produced a figure, because they are not the same claim.
set -uo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGPORT_P5=${PGPORT_P5:-54333}
CLUSTER=${P5_CLUSTER_DIR:-/home/p5pg/p5cluster-mig}
P5_LOCALE=${P5_LOCALE:-en_US.utf8}
SQLDIR="$(cd "$(dirname "$0")/sql" && pwd)"
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
W=${P5_WORK_DIR:-/tmp/claude-0/mig}
mkdir -p "$W"

if ! id p5pg >/dev/null 2>&1; then useradd -m -s /bin/bash p5pg || exit 1; fi

if [ ! -f "$CLUSTER/data/PG_VERSION" ]; then
  mkdir -p "$CLUSTER/sock" && chown -R p5pg:p5pg "$CLUSTER"
  locale -a 2>/dev/null | grep -qix "$P5_LOCALE" || locale -a 2>/dev/null | grep -qix "$(echo "$P5_LOCALE" | tr 'A-Z' 'a-z' | tr -d '-')" || {
    echo "P5_LOCALE=$P5_LOCALE is not available; this lane does not fall back to C."; exit 1; }
  su p5pg -c "$PGBIN/initdb -D $CLUSTER/data -U postgres --auth=trust -E UTF8 --locale=$P5_LOCALE" > "$CLUSTER/initdb.log" 2>&1 \
    || { echo "initdb failed"; tail -5 "$CLUSTER/initdb.log"; exit 1; }
fi
if ! pg_isready -h localhost -p "$PGPORT_P5" >/dev/null 2>&1; then
  mkdir -p "$CLUSTER/sock" && chown -R p5pg:p5pg "$CLUSTER/sock"
  su p5pg -c "$PGBIN/pg_ctl -D $CLUSTER/data \
    -o '-p $PGPORT_P5 -c listen_addresses=localhost -c unix_socket_directories=$CLUSTER/sock \
        -c fsync=off -c max_connections=60 -c deadlock_timeout=200ms' \
    -l $CLUSTER/pg.log start -w" || { echo "pg_ctl failed"; tail -10 "$CLUSTER/pg.log"; exit 1; }
fi

SUPER="postgresql://postgres@localhost:$PGPORT_P5/postgres"
DAFTAR_SUPER="postgresql://postgres@localhost:$PGPORT_P5/daftar"

psql -tA "$SUPER" -c "SELECT 1 FROM pg_database WHERE datname='daftar'" | grep -q 1 \
  || psql -v ON_ERROR_STOP=1 "$SUPER" -c "CREATE DATABASE daftar ENCODING 'UTF8'" > /dev/null || exit 1

# The deployment runner substitutes these placeholders; here they are
# substituted into a scratch copy. Scratch-cluster passwords, localhost only.
sed 's/__\([A-Z_]*\)_DB_PASSWORD__/scratchpw/g' "$REPO/infrastructure/database/bootstrap.sql" > "$W/bootstrap.sql"
if grep -q "__[A-Z_]*__" "$W/bootstrap.sql"; then
  echo "a placeholder survived the substitution; refusing to apply a half-substituted bootstrap"; exit 1
fi
psql -v ON_ERROR_STOP=1 "$DAFTAR_SUPER" -f "$W/bootstrap.sql" > "$W/bootstrap.log" 2>&1 \
  || { echo "bootstrap failed"; tail -5 "$W/bootstrap.log"; exit 1; }

# The history, through the project's own runner, as the deployment principal.
APPLIED_BEFORE=$(psql -tA "$DAFTAR_SUPER" -c "SELECT count(*) FROM schema_migrations" 2>/dev/null | tr -d '[:space:]')
( cd "$REPO" && MIGRATION_DATABASE_URL="postgresql://daftar_migrator:scratchpw@localhost:$PGPORT_P5/daftar" \
  npm run migrate > "$W/migrate.log" 2>&1 )
MIGRATE_RC=$?
echo "MIGRATE_RC=$MIGRATE_RC (applied before this run: ${APPLIED_BEFORE:-0})"
[ "$MIGRATE_RC" = "0" ] || { tail -15 "$W/migrate.log"; exit 1; }
psql -tA "$DAFTAR_SUPER" -c \
  "SELECT 'MIGRATIONS=' || count(*) || ' TABLES=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') FROM schema_migrations"

export P5_DB_BOOTSTRAP_URL="postgresql://postgres@localhost:$PGPORT_P5/daftar"
# THE PLATFORM PRINCIPAL IS A ROLE, SO THE REAL LANE MUST BE THAT ROLE.
# The fixture lane substitutes `p5owner` for `daftar_platform` because it
# writes its own `app_bypass()`. Here the function is the REAL one, 0052's
# `CURRENT_USER OPERATOR(pg_catalog.=) 'daftar_platform'::pg_catalog.name`,
# so nothing but that role satisfies it: `p5owner` would own the schema and
# still be denied by every policy it had just created. `daftar_platform` is
# NOSUPERUSER NOBYPASSRLS in `bootstrap.sql`, which the principal guard
# below re-checks rather than trusting.
export P5_DB_OWNER_URL="postgresql://daftar_platform:scratchpw@localhost:$PGPORT_P5/daftar"
export P5_DB_APP_URL="postgresql://p5_app:p5apppw@localhost:$PGPORT_P5/daftar"
export P5_REAL_SCHEMA=1
export P5_BORROWED_SCHEMA=public

psql -v ON_ERROR_STOP=1 "$P5_DB_BOOTSTRAP_URL" -f "$SQLDIR/credit-ledger-bootstrap.sql" > /dev/null || exit 1

# The privileges this lane needs on the FROZEN relations. They are granted by
# the superuser because `daftar_migrator` owns them and this is a scratch
# cluster; on a real deployment they would be a GRANT in the migration the
# patch request asks for, which is why §16 of that request now names them.
psql -v ON_ERROR_STOP=1 "$P5_DB_BOOTSTRAP_URL" <<'SQL' > /dev/null || exit 1
-- The definer function's owner. `credit-ledger-roles.sql` hands the
-- invariant function to `p5_invariants`, and a role may only give an object
-- to a role it can SET ROLE to; in the fixture lane `p5owner` holds that
-- membership, so here the platform principal must.
GRANT p5_invariants TO daftar_platform WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public TO daftar_platform, p5_app, p5_invariants;
GRANT SELECT, INSERT ON public.tenants, public.businesses TO daftar_platform;
-- REFERENCES, not just SELECT: a foreign key from a Phase 5 relation to a
-- frozen one is a privilege on the PARENT, and it is the privilege the
-- migration this request asks for will need too (§16).
GRANT REFERENCES ON public.businesses, public.currencies TO daftar_platform;
GRANT SELECT ON public.currencies TO daftar_platform, p5_app, p5_invariants;
GRANT SELECT ON public.businesses TO p5_app, p5_invariants;
DROP SCHEMA IF EXISTS p5scratch CASCADE;
CREATE SCHEMA p5scratch AUTHORIZATION daftar_platform;
GRANT USAGE ON SCHEMA p5scratch TO p5_app, p5_invariants;
DROP SCHEMA IF EXISTS p5naive CASCADE;
CREATE SCHEMA p5naive AUTHORIZATION daftar_platform;
GRANT USAGE ON SCHEMA p5naive TO p5_app, p5_invariants;
SQL

PRINCIPAL=$(psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT rolsuper::text || ':' || rolbypassrls::text FROM pg_roles WHERE rolname = current_user" | tr -d '[:space:]')
echo "principal=$(psql -tA "$P5_DB_OWNER_URL" -c 'SELECT current_user')  rolsuper:rolbypassrls=$PRINCIPAL"
if [ "$PRINCIPAL" != "false:false" ]; then
  echo "PRINCIPAL TOO STRONG: see the challenger's F-05."; exit 1
fi

psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-scratch.sql" > "$W/ddl.log" 2>&1 \
  || { echo "the requested DDL did not apply on the real schema"; tail -20 "$W/ddl.log"; exit 1; }
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-naive.sql" > /dev/null || exit 1
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-roles.sql" > /dev/null || exit 1

LIVE_COLLATE=$(psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT datcollate FROM pg_database WHERE datname = current_database()" | tr -d '[:space:]')
if [ "$LIVE_COLLATE" != "$P5_LOCALE" ]; then
  echo "COLLATION MISMATCH: the cluster is $LIVE_COLLATE, the target is $P5_LOCALE."; exit 1
fi
psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT 'PG=' || current_setting('server_version') || ' lc_collate=' || datcollate || ' encoding=' || pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()"
echo "SCHEMA_UNDER_TEST=real (frozen history applied by the project runner, borrowed schema = public)"

cd "$(dirname "$0")/../.." && npx vitest run --config vitest.db.config.ts "$@"
rc=$?
echo "DB_PROOF_REAL_SCHEMA_RC=$rc"
exit $rc
