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
# ROUND 8, the challenger's F-05: the cluster is initialised with `postgres`
# as the bootstrap superuser, and `p5owner` is created afterwards as an
# explicitly NOSUPERUSER NOBYPASSRLS schema owner. Before this round
# `initdb -U p5owner` made the schema owner the cluster superuser, so every
# RLS policy was bypassed for it and a P1 (F-01) hid behind that bypass.
PGUSER_BOOTSTRAP=postgres
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

# DR-100. The lane runs from the PACKAGE root whoever invokes it and from
# wherever. `vitest.db.config.ts` carries `include: test/db/**`, relative to
# the working directory and not to the config file, so invoking this script
# from the repository root used to collect NOTHING and exit 1 with "No test
# files found" -- RULE-8's trap, an operator error read as a package failure.
# Both entry points now land in the same place: `npm run test:db` inside the
# package (already here) and the root `test:db:billing` script CI runs.
cd "$(dirname "$0")/../.." || exit 1

# DR-100, SECOND ROUND, and the vacuity guard is what caught it. The root
# script named the suite as the REPOSITORY sees it and handed that string to
# vitest as a filter: `packages/billing/test/db`. Vitest matches a filter
# against the path relative to its ROOT, which is this package, so every file
# is `test/db/…` and the filter matched NOTHING -- measured on the runner:
# "No test files found", `files=0 total=0`, and the step went red on the floor
# rather than passing with nothing run. Both facts are needed and they are not
# the same string, so the repository-relative name arrives in P5_SUITE_DIR --
# where the plan-evidence resolver reads it -- and the filter is DERIVED from
# it here, with the prefix checked rather than assumed.
if [ -n "${P5_SUITE_DIR:-}" ]; then
  case "$P5_SUITE_DIR" in
    packages/billing/*) set -- "${P5_SUITE_DIR#packages/billing/}" "$@" ;;
    *)
      echo "P5_SUITE_DIR=$P5_SUITE_DIR is not inside packages/billing, so no filter derived from it can mean this package's suite."
      exit 1
      ;;
  esac
  echo "SUITE_DIR=$P5_SUITE_DIR filter=$1"
fi

# ── DR-100: THE CI LANE, AN EXISTING SERVER AND A DATABASE OF ITS OWN ──────
#
# `main`'s plan-evidence contract refuses a plan-shape claim that required CI
# never executes against its `postgres:16` service, and
# `test/db/credit-ledger-atomicity.test.ts` asserts a QUERY PLAN. This lane
# could not be a CI step as it stood: it BUILDS a cluster, and `useradd`,
# `initdb` and `pg_ctl` below all need root and a writable /home. With
# P5_EXISTING_SERVER=1 it builds nothing and uses the server CI already runs,
# in a SEPARATE DATABASE so it cannot touch the integration suite's `daftar`.
#
# What is NOT relaxed: the same SQL files in the same order, the same
# principal guard (`rolsuper=false rolbypassrls=false`), the same live
# collation assertion -- and the database is created FROM template0 with the
# deploy collation stated, so the guard is a real comparison rather than
# whatever template1 happened to hold.
P5_EXISTING_SERVER=${P5_EXISTING_SERVER:-0}
if [ "$P5_EXISTING_SERVER" = "1" ]; then
  P5_PG_HOST=${P5_PG_HOST:-localhost}
  P5_PG_PORT=${PG_PORT:-5432}
  P5_PG_SUPERUSER=${P5_PG_SUPERUSER:-postgres}
  P5_PG_SUPERUSER_PASSWORD=${P5_PG_SUPERUSER_PASSWORD:-postgres}
  P5_DB_NAME=${P5_DB_NAME:-daftar_billing_test}
  ADMIN_URL="postgresql://$P5_PG_SUPERUSER:$P5_PG_SUPERUSER_PASSWORD@$P5_PG_HOST:$P5_PG_PORT/postgres"

  EXISTS=$(psql -tA "$ADMIN_URL" -c "SELECT count(*) FROM pg_database WHERE datname = '$P5_DB_NAME'" | tr -d '[:space:]')
  if [ -z "$EXISTS" ]; then
    echo "the server at $P5_PG_HOST:$P5_PG_PORT answered nothing; an empty probe is not a zero (RULE-18)."
    exit 1
  fi
  if [ "$EXISTS" = "0" ]; then
    psql -v ON_ERROR_STOP=1 "$ADMIN_URL" -c \
      "CREATE DATABASE $P5_DB_NAME TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE '$P5_LOCALE' LC_CTYPE '$P5_LOCALE'" \
      > /dev/null || { echo "CREATE DATABASE $P5_DB_NAME under $P5_LOCALE failed; the lane does not fall back to another collation."; exit 1; }
  fi
  # The one server setting the concurrency cases depend on. The scratch
  # cluster is started with `-c deadlock_timeout=200ms`; a shared service runs
  # the 1s default, and a lock test that waits five times longer is a
  # different measurement. `fsync=off` is NOT reproduced: it only makes the
  # cluster faster and no case asserts it.
  psql -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "ALTER DATABASE $P5_DB_NAME SET deadlock_timeout = '200ms'" > /dev/null || exit 1

  export P5_DB_BOOTSTRAP_URL="postgresql://$P5_PG_SUPERUSER:$P5_PG_SUPERUSER_PASSWORD@$P5_PG_HOST:$P5_PG_PORT/$P5_DB_NAME"
  export P5_DB_OWNER_URL="postgresql://p5owner:p5ownerpw@$P5_PG_HOST:$P5_PG_PORT/$P5_DB_NAME"
  export P5_DB_STRANGER_URL="postgresql://p5_stranger:p5strangerpw@$P5_PG_HOST:$P5_PG_PORT/$P5_DB_NAME"
  export P5_DB_APP_URL="postgresql://p5_app:p5apppw@$P5_PG_HOST:$P5_PG_PORT/$P5_DB_NAME"
  echo "LANE=existing-server host=$P5_PG_HOST port=$P5_PG_PORT database=$P5_DB_NAME locale=$P5_LOCALE"
fi

if [ "$P5_EXISTING_SERVER" != "1" ] && ! id p5pg >/dev/null 2>&1; then
  # initdb refuses to run as root; the cluster needs an unprivileged owner.
  useradd -m -s /bin/bash p5pg || exit 1
fi

if [ "$P5_EXISTING_SERVER" != "1" ] && [ ! -f "$CLUSTER/data/PG_VERSION" ]; then
  mkdir -p "$CLUSTER/sock" && chown -R p5pg:p5pg "$CLUSTER"
  if ! locale -a 2>/dev/null | grep -qix "$(echo "$P5_LOCALE" | tr 'A-Z' 'a-z' | tr -d '-')" \
     && ! locale -a 2>/dev/null | grep -qix "$P5_LOCALE"; then
    echo "P5_LOCALE=$P5_LOCALE is not available in this container; the deploy collation cannot be used."
    echo "Generate it (locale-gen) or state the gap. This lane does not silently fall back to C."
    exit 1
  fi
  su p5pg -c "$PGBIN/initdb -D $CLUSTER/data -U $PGUSER_BOOTSTRAP --auth=trust -E UTF8 --locale=$P5_LOCALE" \
    > "$CLUSTER/initdb.log" 2>&1 || { echo "initdb failed"; tail -5 "$CLUSTER/initdb.log"; exit 1; }
fi

if [ "$P5_EXISTING_SERVER" != "1" ] && ! pg_isready -h localhost -p "$PGPORT_P5" >/dev/null 2>&1; then
  mkdir -p "$CLUSTER/sock" && chown -R p5pg:p5pg "$CLUSTER/sock"
  # unix_socket_directories: /var/run/postgresql is not writable by p5pg.
  su p5pg -c "$PGBIN/pg_ctl -D $CLUSTER/data \
    -o '-p $PGPORT_P5 -c listen_addresses=localhost -c unix_socket_directories=$CLUSTER/sock \
        -c fsync=off -c max_connections=60 -c deadlock_timeout=200ms' \
    -l $CLUSTER/pg.log start -w" || { echo "pg_ctl failed"; tail -10 "$CLUSTER/pg.log"; exit 1; }
fi

if [ "$P5_EXISTING_SERVER" != "1" ]; then
  export P5_DB_BOOTSTRAP_URL="postgresql://$PGUSER_BOOTSTRAP@localhost:$PGPORT_P5/postgres"
  export P5_DB_OWNER_URL="postgresql://$PGUSER_P5@localhost:$PGPORT_P5/postgres"
  export P5_DB_STRANGER_URL="postgresql://p5_stranger:p5strangerpw@localhost:$PGPORT_P5/postgres"
  export P5_DB_APP_URL="postgresql://p5_app:p5apppw@localhost:$PGPORT_P5/postgres"
fi

# Roles first, as the cluster superuser, because the schema owner is now one
# of the things being created rather than the principal creating them.
psql -v ON_ERROR_STOP=1 "$P5_DB_BOOTSTRAP_URL" -f "$SQLDIR/credit-ledger-bootstrap.sql" > /dev/null || exit 1

# The principal of a run is part of its result: asserted here, in the lane,
# so a later report cannot describe a principal the run did not have.
psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT 'principal=' || current_user || ' rolsuper=' || rolsuper || ' rolbypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = current_user"
PRINCIPAL=$(psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT rolsuper::text || ':' || rolbypassrls::text FROM pg_roles WHERE rolname = current_user" | tr -d '[:space:]')
if [ "$PRINCIPAL" != "false:false" ]; then
  echo "PRINCIPAL TOO STRONG: the schema owner is $PRINCIPAL (rolsuper:rolbypassrls), so row-level"
  echo "security is bypassed and every policy in this schema is unverified. See the challenger's F-05."
  exit 1
fi

# ROUND 12: the schema itself, then the BORROWED relations, then the
# requested DDL on top. In the real-schema lane (P5_REAL_SCHEMA=1) the
# fixture file is skipped and the frozen relations in `public` are used
# instead; see §9 of the checkpoint for why the two are different claims.
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -c "DROP SCHEMA IF EXISTS p5scratch CASCADE; CREATE SCHEMA p5scratch; DROP SCHEMA IF EXISTS p5naive CASCADE; CREATE SCHEMA p5naive;" > /dev/null || exit 1
if [ "${P5_REAL_SCHEMA:-0}" = "1" ]; then
  echo "SCHEMA_UNDER_TEST=real (frozen history applied by the project runner)"
else
  echo "SCHEMA_UNDER_TEST=fixture (credit-ledger-fixture.sql)"
  psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-fixture.sql" > /dev/null || exit 1
fi
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-scratch.sql" > /dev/null || exit 1
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-naive.sql"   > /dev/null || exit 1
psql -v ON_ERROR_STOP=1 "$P5_DB_OWNER_URL" -f "$SQLDIR/credit-ledger-roles.sql"   > /dev/null || exit 1

# The collation is part of the evidence, not a footnote: PART 19 requires the
# database version AND collation for every proof.
psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT 'PG=' || current_setting('server_version') || ' lc_collate=' || datcollate || ' lc_ctype=' || datctype || ' encoding=' || pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()" 

# ROUND 7 CORRECTION. The locale guard above only runs when the cluster is
# being CREATED. A cluster initialised in an earlier round under `--locale=C`
# is reused as it stands, so the lane printed `lc_collate=C` while claiming
# `P5_LOCALE=en_US.utf8` — the silent downgrade this script was changed to
# prevent, one step further back than the guard reached. The collation of the
# cluster the proof actually ran against is therefore asserted here, against
# a LIVE catalogue read, and a disagreement FAILS the lane.
LIVE_COLLATE=$(psql -tA "$P5_DB_OWNER_URL" -c \
  "SELECT datcollate FROM pg_database WHERE datname = current_database()" | tr -d '[:space:]')
if [ "$LIVE_COLLATE" != "$P5_LOCALE" ]; then
  echo "COLLATION MISMATCH: the cluster at $CLUSTER is $LIVE_COLLATE, the requested target is $P5_LOCALE."
  echo "A proof taken under $LIVE_COLLATE is not a proof about the deploy target. Point"
  echo "P5_CLUSTER_DIR/PGPORT_P5 at a cluster of the right collation, or set P5_LOCALE deliberately."
  exit 1
fi

psql -tA "$P5_DB_OWNER_URL" -c "SELECT version()"

# DR-100: THE COUNT IS PART OF THE RESULT, not a line to read off a summary.
# `NOT_RUN` and `0 of 0 passed` are the two ways a database lane looks green
# without having proved anything, so the run writes a machine-readable result
# and the floor below is asserted from it. The file goes to the temporary
# directory: no lane writes a result artefact into the repository.
RESULTS="${TMPDIR:-/tmp}/p5-db-results-$$.json"
npx vitest run --config vitest.db.config.ts --reporter=default --reporter=json "--outputFile.json=$RESULTS" "$@"
rc=$?
P5_MIN_CASES=${P5_MIN_CASES:-131}
if [ -s "$RESULTS" ]; then
  node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const floor = Number(process.argv[2]);
const total = r.numTotalTests, passed = r.numPassedTests, failed = r.numFailedTests;
const files = Array.isArray(r.testResults) ? r.testResults.length : 0;
console.log(`DB_PROOF_CASES files=${files} total=${total} passed=${passed} failed=${failed} floor=${floor}`);
if (!Number.isInteger(total) || total < floor) {
  console.log(`DB_PROOF_VACUOUS: ${total} cases executed, below the declared floor of ${floor}. A lane that runs fewer cases than it claims is NOT_RUN wearing a green badge; raise the floor deliberately or find the files that stopped being collected.`);
  process.exit(1);
}
process.exit(0);
' "$RESULTS" "$P5_MIN_CASES" || rc=1
else
  echo "DB_PROOF_VACUOUS: the json reporter wrote nothing to $RESULTS, so the executed count is unknown (RULE-18: an empty probe is not a zero)."
  rc=1
fi
rm -f "$RESULTS"
echo "DB_PROOF_RC=$rc"

# ------------------------------------------------------------------
# DR-100 / the role leak measured in run 42482801134 (step 37).
#
# `credit-ledger-bootstrap.sql` above CREATEs this lane's four
# principals, and ROLES ARE CLUSTER-WIDE: a separate DATABASE does not
# contain them. On the existing-server lane that cluster is the one the
# whole `backend` job shares, so three of them (`p5owner`, `p5_app`,
# `p5_stranger`; `p5_invariants` is NOLOGIN) stayed behind and reded the
# SEALED roster assertions in a later step:
#
#   tests/integration/phase3-s8-rebuild-rehearsal.test.ts:470  (T-09)
#   tests/security/phase3-s8-grant-matrix.test.ts              (T-04)
#   and the third case of that roster, 7 expected against 10 read
#
# THOSE ASSERTIONS ARE RIGHT AND ARE NOT TOUCHED: a sealed control that
# names the cluster's login roles is exactly the control that should red
# when a lane leaves principals behind. The fix is this lane's cleanup.
#
# Scoped to the existing-server lane deliberately: the other lane runs
# `initdb` on a throw-away cluster that is discarded whole, so a drop
# there could only invent a red of its own.
#
# It runs whatever the proof's verdict was — a red lane that leaves
# principals behind reds the next step for a reason that is not the next
# step's — and the lane's own exit code is still the proof's.
if [ "$P5_EXISTING_SERVER" = "1" ]; then
  BEFORE=$(psql -tA "$ADMIN_URL" -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('p5owner','p5_app','p5_stranger','p5_invariants')" | tr -d '[:space:]')
  echo "P5_ROLE_TEARDOWN_BEFORE: $BEFORE of the lane's 4 roles are in the shared cluster — the positive control, so the zero below is a measurement and not an empty probe (RULE-18)"
  TDLOG="${TMPDIR:-/tmp}/p5-teardown-$$.log"
  psql -v ON_ERROR_STOP=1 "$P5_DB_BOOTSTRAP_URL" > "$TDLOG" 2>&1 <<TEARDOWN
DROP SCHEMA IF EXISTS p5scratch CASCADE;
DROP SCHEMA IF EXISTS p5naive CASCADE;
-- What was granted TO these roles in this database goes with DROP OWNED,
-- which is why it comes before the roles themselves.
DROP OWNED BY p5owner, p5_app, p5_invariants, p5_stranger CASCADE;
REVOKE ALL ON DATABASE $P5_DB_NAME FROM p5owner, p5_app, p5_invariants, p5_stranger;
DROP ROLE IF EXISTS p5_app;
DROP ROLE IF EXISTS p5_stranger;
DROP ROLE IF EXISTS p5_invariants;
DROP ROLE IF EXISTS p5owner;
TEARDOWN
  td=$?
  LEFT=$(psql -tA "$ADMIN_URL" -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('p5owner','p5_app','p5_stranger','p5_invariants')" | tr -d '[:space:]')
  echo "P5_ROLE_TEARDOWN_AFTER: $LEFT (psql rc=$td)"
  if [ -z "$BEFORE" ] || [ -z "$LEFT" ]; then
    echo "P5_ROLE_TEARDOWN UNMEASURED: the cluster answered nothing to the role count, and an empty probe is not a zero (RULE-18)."
    exit 1
  fi
  if [ "$td" != "0" ] || [ "$LEFT" != "0" ]; then
    echo "P5_ROLE_TEARDOWN FAILED: this lane's principals are still in the shared cluster, so the sealed roster assertions in the steps after this one would red for this lane's reason. Refusing to report the proof's own verdict as this step's."
    tail -5 "$TDLOG"
    rm -f "$TDLOG"
    exit 1
  fi
  rm -f "$TDLOG"
fi

exit $rc
