#!/bin/bash
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
