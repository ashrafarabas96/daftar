#!/bin/bash
# RUN IDENTITY, printed first so the evidence names its own subject (V2 §18:
# "retrieve the DDL, the harness, the raw logs, the run identity, the exact
# SHA and the manifest; the exact source is not attached in the P11 report,
# so do not bind it to the remote head by guesswork").
echo "RUN_ID            : p11-packA-$(date -u +%Y%m%dT%H%M%SZ)-$$"
echo "RUN_AT_UTC        : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "HOST_KERNEL       : $(uname -sr)"
echo "SOURCE_REPO       : $(git -C /home/user/daftar config --get remote.origin.url)"
echo "SOURCE_BRANCH     : $(git -C /home/user/daftar rev-parse --abbrev-ref HEAD)"
echo "SOURCE_SHA        : $(git -C /home/user/daftar rev-parse HEAD)"
echo "SOURCE_TREE_DIRTY : $(test -z "$(git -C /home/user/daftar status --porcelain)" && echo no || echo YES)"
echo "MIGRATIONS_SHA    : $(git -C /home/user/daftar rev-parse HEAD:infrastructure/database/migrations)"
echo "MANIFEST_SHA256   : $(sha256sum /home/user/daftar/infrastructure/database/MIGRATION_MANIFEST.json | cut -d" " -f1)"
echo "PACK_A_DDL_SHA256 : $(sha256sum /home/user/daftar/prep/phase11/ddl/p11-pack-a-apparel.sql | cut -d" " -f1)"
echo "PG_VERSION        : $(/usr/lib/postgresql/16/bin/postgres --version)"
echo "NODE_VERSION      : $(node -v) (repository engines: $(node -e "process.stdout.write(require('/home/user/daftar/package.json').engines.node)")) -- NO npm suite is run here"
echo
# Phase 11 Pack A — from zero, every time. Rebuild the database, apply the
# frozen prefix UNMODIFIED as daftar_migrator, apply the unnumbered Pack A
# DDL, build the world, run every proof. No step is skipped and no step is
# reported in a form other than the one it ran in.
set -o pipefail
S=/var/tmp/p11s
PG=/usr/lib/postgresql/16/bin
Q="su postgres -s /bin/bash -c"
echo "=== 1. drop and recreate the database ==="
$Q "$PG/psql -h $S/run -p 55511 -U postgres -X -q -c 'DROP DATABASE IF EXISTS daftar' -c 'CREATE DATABASE daftar'" || exit 1
echo "=== 2. bootstrap.sql (six runtime roles + extensions), as the deployment administrator ==="
$Q "$PG/psql -h $S/run -p 55511 -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $S/sql/bootstrap.rendered.sql" || exit 1
echo "=== 3. migrations 0000..0086 as daftar_migrator (NOT superuser) ==="
python3 -I $S/run_migrations.py /home/user/daftar/infrastructure/database/migrations daftar_migrator || exit 1
echo "=== 4. Pack A, unnumbered, as daftar_migrator ==="
$Q "$PG/psql -h $S/run -p 55511 -U daftar_migrator -d daftar -X -q -v ON_ERROR_STOP=1 -f $S/apply_a.sql" || exit 1
echo "PACK A APPLIED, end-state assertion passed"
echo "=== 5. the world ==="
$Q "$PG/psql -h $S/run -p 55511 -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $S/world.sql" || exit 1
echo "=== 6. proofs ==="
python3 -I $S/proofs.py
RC=$?
echo "=== 6b. real concurrency: three races, two live backends, no sleep() ==="
python3 -I $S/races.py
RCR=$?
[ $RCR -ne 0 ] && RC=$RCR
echo "=== 7. the frozen tree, after the run ==="
cd /home/user/daftar && git status --porcelain -- infrastructure/database | wc -l | sed 's/^/tracked changes under infrastructure\/database: /'
python3 - <<'PY'
import json,hashlib,os
m=json.load(open('/home/user/daftar/infrastructure/database/MIGRATION_MANIFEST.json'))
d='/home/user/daftar/infrastructure/database/migrations'
bad=[r['name'] for r in m['migrations'] if hashlib.sha256(open(os.path.join(d,r['name']),'rb').read()).hexdigest()!=r['sha256']]
print("frozenThrough:",m['frozenThrough'],"| frozen entries:",len(m['migrations']),"| digest mismatches:",bad)
PY
exit $RC
