#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# PHASE 11 — rebuild from zero and prove, on the SETTLED deploy target.
#
# SELF-CONTAINED, and that is finding P2-09 of the independent challenge: the
# earlier version read `$S/sql/bootstrap.rendered.sql`, `$S/apply_a.sql` and
# staged copies of the harness, none of which were in the repository and none
# of which were described. A challenger had to reconstruct the locale, the
# port, the password rendering and whether the pack is applied in one
# transaction — judgement calls that make two runs differ in a way neither log
# can show. "A proof whose setup is not in its own repository is reproducible
# by its author only." So every one of those steps is in this file now, the
# cluster is created here if it is absent, and nothing outside the repository
# is read except the scratch cluster's own data directory.
#
# TARGET (V3, settled): the PostgreSQL 16 family at en_US.utf8. The locale
# does not exist in this container until `localedef` generates it, so a
# cluster created without that step is NOT on the target. The script
# generates it, asserts the running database's collation, and EXITS NON-ZERO
# rather than producing an off-target green.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail
REPO=${P11_REPO:-/home/user/daftar}
S=${P11_SCRATCH:-/var/tmp/p11u}
PORT=${P11_PORT:-55512}
SOCK=$S/run
PG=/usr/lib/postgresql/16/bin
Q="su postgres -s /bin/bash -c"
export P11_SOCK=$SOCK P11_PORT=$PORT
H=$REPO/prep/phase11/harness
PSQL_P="$PG/psql -h $SOCK -p $PORT"

# ── 0. the cluster, created here when it does not exist ──────────────────────
if [ ! -d "$S/data" ]; then
  echo "=== 0. creating the scratch cluster at $S on en_US.utf8 ==="
  locale -a 2>/dev/null | grep -qi '^en_US.utf8$' || localedef -i en_US -f UTF-8 en_US.UTF-8 || exit 1
  mkdir -p "$S/run" "$S/log" "$S/sql" || exit 1
  chown -R postgres:postgres "$S" || exit 1
  $Q "$PG/initdb -D $S/data --locale=en_US.utf8 --encoding=UTF8 -U postgres" >"$S/log/initdb.log" 2>&1 || { tail -5 "$S/log/initdb.log"; exit 1; }
fi
$Q "$PG/pg_ctl -D $S/data status" >/dev/null 2>&1 || {
  echo "=== 0b. starting the cluster (it is reaped between turns in this container) ==="
  $Q "$PG/pg_ctl -D $S/data -l $S/log/pg.log -o '-p $PORT -k $SOCK -c listen_addresses=' start" || exit 1
  sleep 2
}

# ── RUN IDENTITY, printed first so the evidence names its own subject ───────
RUN_ID="p11-$(date -u +%Y%m%dT%H%M%SZ)-$$"
echo "RUN_ID            : $RUN_ID"
echo "RUN_AT_UTC_START  : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "HOST_KERNEL       : $(uname -sr)"
echo "SOURCE_REPO       : $(git -C $REPO config --get remote.origin.url)"
echo "SOURCE_BRANCH     : $(git -C $REPO rev-parse --abbrev-ref HEAD)"
echo "SOURCE_SHA        : $(git -C $REPO rev-parse HEAD)"
echo "SOURCE_TREE_DIRTY : $(test -z "$(git -C $REPO status --porcelain)" && echo no || echo YES)"
echo "MIGRATIONS_SHA    : $(git -C $REPO rev-parse HEAD:infrastructure/database/migrations)"
echo "MANIFEST_SHA256   : $(sha256sum $REPO/infrastructure/database/MIGRATION_MANIFEST.json | cut -d' ' -f1)"
echo "BOOTSTRAP_SHA256  : $(sha256sum $REPO/infrastructure/database/bootstrap.sql | cut -d' ' -f1)"
echo "PACK_A_DDL_SHA256 : $(sha256sum $REPO/prep/phase11/ddl/p11-pack-a-apparel.sql | cut -d' ' -f1)"
echo "PACK_B_DDL_SHA256 : $(test -f $REPO/prep/phase11/ddl/p11-pack-b-lot-expiry.sql && sha256sum $REPO/prep/phase11/ddl/p11-pack-b-lot-expiry.sql | cut -d' ' -f1 || echo 'absent at this SHA — Pack B is not on the branch yet, and the run below skips it by name rather than silently')"
# NOTE ON REPRODUCING THIS DIGEST: `ls` SORTS its arguments, so the bytes
# hashed are the files in ALPHABETICAL order, not in the order written below.
# Concatenating them in the written order gives a different, wrong digest.
# `check_fenced_figures.py` joined the set when step 0 started depending on it:
# an instrument a run refuses on is part of what the run must pin.
echo "HARNESS_SHA256    : $(cat $(ls $H/check_fenced_figures.py $H/proofs.py $H/proofs_b.py $H/races.py $H/races_b.py $H/run_migrations.py $H/render_bootstrap.py $H/world.sql $H/world_b.sql $H/rebuild_and_prove.sh 2>/dev/null) | sha256sum | cut -d' ' -f1)"
echo "PG_VERSION        : $($PG/postgres --version)"
echo "PG_CLUSTER_DIR    : $S/data (port $PORT, socket $SOCK)"
echo "NODE_VERSION      : $(node -v) (repository engines: $(node -e "process.stdout.write(require('$REPO/package.json').engines.node)")) -- NO npm suite is run here"
echo "FIXTURES          : world.sql (Pack A)$(test -f $H/world_b.sql && echo ', world_b.sql (Pack B, with its definer fixture)'). Within the packs present, no fixture and no case is skipped; a pack that is not on the branch is named as skipped above and below."
echo

# ── 0c. the documents' quoted figures ───────────────────────────────────────
# Round 10 rejected a head over a figure shown as output that no instrument
# emitted. Round 11 made the honest objection that the arm added in answer was
# a rule in a document with nothing enforcing it. This is the enforcement.
#
# WHERE IT RUNS, stated exactly, because the first version of this comment got
# it wrong and said "before a cluster exists": steps 0 and 0b above create and
# start the scratch cluster, so this step runs AFTER the cluster is up and
# BEFORE the database is dropped and recreated, before the roles are
# bootstrapped and before any migration or pack is applied. Nothing under test
# has been touched when it refuses. It is numbered 0c rather than 0 because 0
# and 0b were already taken -- the first version collided with them.
#
# Its own red proof runs before it, as the renderer's selftest does.
echo "=== 0c. the documents' quoted figures (every key=value shown as output must be emitted by something) ==="
python3 -I $H/check_fenced_figures.py --selftest || { echo "the fenced-figure check cannot fail; refusing to trust it"; exit 1; }
python3 -I $H/check_fenced_figures.py
RC_FIGURES=$?
if [ $RC_FIGURES -ne 0 ]; then
  echo "A document of this phase shows a figure nothing emits (exit 1), or the check "
  echo "matched nothing at all (exit 2). Either way this run would publish a number "
  echo "with no instrument behind it. Refusing to run."
  exit $RC_FIGURES
fi
# And the figures THIS instrument produces are generated into the documents,
# never typed: two rounds in a row were rejected over a number written beside
# the command that prints it. A block that differs from a fresh run, or one of
# their sentences written outside a block, stops the run here.
python3 -I $H/check_fenced_figures.py --check-blocks
RC_BLOCKS=$?
if [ $RC_BLOCKS -ne 0 ]; then
  echo "A generated figure block in a document of this phase disagrees with a fresh "
  echo "run of its generator (exit 1), or nothing is enrolled at all (exit 2). Run "
  echo "\`python3 -I $H/check_fenced_figures.py --regenerate\` and commit what it "
  echo "prints. Refusing to run."
  exit $RC_BLOCKS
fi
echo

# ── 1. the database ─────────────────────────────────────────────────────────
echo "=== 1. drop and recreate the database ==="
$Q "$PSQL_P -U postgres -X -q -c 'DROP DATABASE IF EXISTS daftar' -c 'CREATE DATABASE daftar'" || exit 1
COLL=$($Q "$PSQL_P -U postgres -d daftar -X -A -t -c \"select datcollate||' / '||datctype||' / '||pg_encoding_to_char(encoding) from pg_database where datname='daftar'\"")
echo "DB_COLLATION      : $COLL   (measured on the database under test, not on template1)"
case "$COLL" in
  "en_US.utf8 / en_US.utf8 / UTF8") ;;
  *) echo "OFF TARGET — V3 settles the deploy target as the PostgreSQL 16 family at en_US.utf8."
     echo "This database is '$COLL'. Every code validator in Pack A is a bracket-range regex,"
     echo "and bracket ranges are the collation-sensitive part of POSIX regular expressions,"
     echo "so a green here would not be a green on the target. Refusing to run."
     exit 3;;
esac
echo "=== 2. bootstrap.sql (the runtime roles + extensions), as the deployment administrator ==="
# The repository's bootstrap carries eight password placeholders. Rendering
# them is part of the setup, so it lives in the repository rather than in a
# file nobody can see; the values are scratch-only and the cluster takes no
# TCP connection. The renderer moved OUT of this script in answer to finding
# P3-N03.1 — its completeness check was inert twice over and let an
# unmatched placeholder through unrendered — and the check now has a case
# that fails it, run here BEFORE anything is rendered or applied.
echo "--- 2a. the renderer's own check, proved red before it is trusted ---"
python3 -I $H/render_bootstrap.py --selftest || { echo "the bootstrap renderer's completeness check is inert; refusing to run"; exit 1; }
python3 -I $H/render_bootstrap.py "$REPO/infrastructure/database/bootstrap.sql" "$S/sql/bootstrap.rendered.sql" || exit 1
chmod 644 "$S/sql/bootstrap.rendered.sql"
$Q "$PSQL_P -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $S/sql/bootstrap.rendered.sql" || exit 1
echo "=== 3. migrations 0000..0086 as daftar_migrator (NOT superuser) ==="
python3 -I $H/run_migrations.py $REPO/infrastructure/database/migrations daftar_migrator || exit 1

# Each pack is applied in ONE transaction, stated here rather than left to a
# reader's assumption (finding P2-09): its end-state assertion is the last
# statement of that transaction, so a pack that fails its own assertion
# leaves nothing behind.
apply_pack () { # $1 = ddl path, $2 = label
  printf 'BEGIN;\n\\i %s\nCOMMIT;\n' "$1" > "$S/sql/apply.sql"
  chmod 644 "$S/sql/apply.sql"
  $Q "$PSQL_P -U daftar_migrator -d daftar -X -q -v ON_ERROR_STOP=1 -f $S/sql/apply.sql" || return 1
  echo "$2 APPLIED in one transaction, end-state assertion passed"
}
echo "=== 4. Pack A (apparel / variant matrix), unnumbered, as daftar_migrator ==="
apply_pack "$REPO/prep/phase11/ddl/p11-pack-a-apparel.sql" "PACK A" || exit 1
# Pack B (lot / expiry) is built in its own round. While it is not on the
# branch, this step and its proofs are SKIPPED BY NAME: a harness that
# silently runs a different set of packs than the SHA carries is how a green
# comes to stand for work that is not there.
if [ -f "$REPO/prep/phase11/ddl/p11-pack-b-lot-expiry.sql" ]; then
  echo "=== 4b. Pack B (lot / expiry), unnumbered, as daftar_migrator ==="
  apply_pack "$REPO/prep/phase11/ddl/p11-pack-b-lot-expiry.sql" "PACK B" || exit 1
else
  echo "=== 4b. Pack B: NOT PRESENT at this SHA — skipped (not applied, not proved, not claimed) ==="
fi
echo "=== 5. the world (Pack A) ==="
$Q "$PSQL_P -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $H/world.sql" || exit 1
if [ -f "$H/world_b.sql" ]; then
  echo "=== 5b. the lot world (Pack B) ==="
  $Q "$PSQL_P -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $H/world_b.sql" || exit 1
fi
# ── 5c. THE MUTATION HOOK, and why it is in the repository ──────────────────
# A mutation is only measurable on a state that can be restored, and the third
# round paid for the other half of that sentence: a mutation applied AFTER the
# suite has already run measures the re-run. `P11_MUTATION_SQL` was added when
# removing the `status` filter from the freeze guard red NOTHING — every write
# the recovery case needed was already in place from the clean run, and its
# statements are conditional precisely so a second run is quiet. So the
# mutation is applied HERE: on a fresh database, after the packs and the
# worlds, before any proof runs. It is in this file rather than in the
# author's shell so a challenger can reproduce a mutation run by name, and it
# is printed in full so a log says which words were changed.
# ── What the hook MEASURES about its own mutation (finding P2-02, round 4) ──
# The fourth independent challenge planted a mutation that changes nothing
# (`SELECT 1;`) and the hook reported it as applied, every suite passed, and
# every EXIT_* was 0 — a mutation run that proves nothing while looking like
# a clean one. A tool that reports on evidence must be able to fail (the P10
# lesson), and the thing this tool reports is "the schema was changed and the
# suites noticed". So the DDL-VISIBLE STATE is digested before and after, and
# a mutation that leaves it identical is refused here rather than measured as
# a pass. The digest covers function bodies, triggers (definition, timing and
# deferredness), constraints, policies with both their expressions, indexes,
# table and function ACLs and the row-security flags — which is every object
# this phase's mutations touch.
#
# `pg_attribute` is in the digest, and finding P3-02 of the fifth round is why
# it had to be added: without it, two real mutations were byte-identical
# no-ops the hook would have refused -- `REVOKE UPDATE (on_hand) ON
# stock_lot_levels` (a COLUMN acl, which `relacl` does not carry) and
# `ALTER TABLE product_matrix_axes ALTER COLUMN axis_position DROP NOT NULL`.
# The second is the sharp one: `attnotnull` is the single catalogue fact forms
# 3 and 4 of the tautology test rest on, and the write-path sweep is
# enumerated from `pg_attribute.attacl` precisely because information_schema
# hid those grants -- so the digest could not mutation-test the two facts the
# round's other two fixes depend on.
#
# Its own limit, stated because it is real: the digest is of the schema, not
# of the data, so a mutation that only changes FIXTURE rows reads as a no-op
# and is refused. That is the right default for this phase, whose mutations
# are all guard removals; a data mutation would need its own hook.
#
# And the ORDERING limit, which no digest can fix: step 5c runs AFTER the
# packs were applied at step 4, so a mutation cannot test an end-state
# assertion — the assertion already passed on the unmutated pack. An
# end-state arm is mutation-tested by editing the DDL on a scratch COPY and
# applying that, which is how the §11 table's M4 row was measured, and the
# copy is used because a frozen tree is never mutated in place.
pg_ddl_digest () {
  $Q "$PSQL_P -U postgres -d daftar -X -A -t -c \"
    SELECT md5(string_agg(x, chr(10) ORDER BY x)) FROM (
      SELECT 'f:'||p.proname||':'||md5(p.prosrc) AS x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      UNION ALL SELECT 't:'||c.relname||':'||g.tgname||':'||g.tgtype||':'||g.tgdeferrable::text||':'||g.tginitdeferred::text||':'||pg_get_triggerdef(g.oid)
                  FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace='public'::regnamespace
      UNION ALL SELECT 'k:'||co.conname||':'||pg_get_constraintdef(co.oid) FROM pg_constraint co WHERE co.connamespace='public'::regnamespace
      UNION ALL SELECT 'p:'||c.relname||':'||pol.polname||':'||coalesce(pg_get_expr(pol.polqual,pol.polrelid),'')||':'||coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'')
                  FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE c.relnamespace='public'::regnamespace
      UNION ALL SELECT 'i:'||i.indexrelid::regclass::text||':'||pg_get_indexdef(i.indexrelid)
                  FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace
      UNION ALL SELECT 'a:'||c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text
                  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
      UNION ALL SELECT 'x:'||p.proname||':'||coalesce(p.proacl::text,'') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      UNION ALL SELECT 'c:'||c.relname||':'||a.attname||':'||a.attnotnull::text||':'||coalesce(a.attacl::text,'')
                  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
                 WHERE c.relnamespace='public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    ) s\"" | tr -d '[:space:]'
}
if [ -n "$P11_MUTATION_SQL" ]; then
  echo "=== 5c. MUTATION APPLIED: $P11_MUTATION_SQL (this run is NOT a clean-tree proof run) ==="
  sed 's/^/  | /' "$P11_MUTATION_SQL"
  DDL_BEFORE=$(pg_ddl_digest)
  $Q "$PSQL_P -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $P11_MUTATION_SQL" || exit 1
  DDL_AFTER=$(pg_ddl_digest)
  echo "MUTATION_DDL_DIGEST_BEFORE: $DDL_BEFORE"
  echo "MUTATION_DDL_DIGEST_AFTER : $DDL_AFTER"
  if [ -z "$DDL_BEFORE" ] || [ -z "$DDL_AFTER" ]; then
    echo "the mutation hook could not digest the schema, so it cannot say whether the mutation changed anything; refusing to report this run"; exit 4
  fi
  if [ "$DDL_BEFORE" = "$DDL_AFTER" ]; then
    echo "=== MUTATION IS A NO-OP: the DDL-visible state is byte-identical before and after. ==="
    echo "A run whose mutation changed nothing measures the clean tree while reporting a mutation."
    echo "Refusing to run the suites (finding P2-02 of the fourth independent challenge)."
    exit 4
  fi
  echo "=== the mutation CHANGED the schema (digests differ); the suites below are expected to FAIL ==="
  echo "=== a mutation run whose suites pass is a gap in the suite ==="
fi

echo "=== 6. proofs (Pack A, apparel) ==="
python3 -I $H/proofs.py
RC_PROOFS=$?; RC=$RC_PROOFS
if [ -f "$H/proofs_b.py" ]; then
  echo "=== 6a2. proofs (Pack B, lot/expiry) ==="
  python3 -I $H/proofs_b.py
  RC_B=$?; [ $RC_B -ne 0 ] && RC=$RC_B
else
  RC_B="n/a (Pack B is not on the branch at this SHA)"
fi
# ── IDEMPOTENCE, measured rather than claimed ────────────────────────────
# The second independent challenger measured that proofs.py was NOT
# idempotent: a second run failed seven cases with no mutation at all,
# because its own writes persisted. This harness always rebuilds, so the
# defect never bit the author — it cost the challenger a run, and it is a
# real hazard for anyone measuring coverage by mutation, because a mutation
# run against a dirty database measures the dirt. Fixed in both suites, and
# proved by running each one AGAIN here, on the database the first run just
# wrote. The second green is not a second proof of the laws; it is the proof
# that the first green was about the schema and not about the sequence.
echo "=== 6c. the same suites, a SECOND time on the same database (idempotence) ==="
python3 -I $H/proofs.py | tail -2
RC_PROOFS2=${PIPESTATUS[0]}; [ $RC_PROOFS2 -ne 0 ] && RC=$RC_PROOFS2
if [ -f "$H/proofs_b.py" ]; then
  python3 -I $H/proofs_b.py | tail -2
  RC_B2=${PIPESTATUS[0]}; [ $RC_B2 -ne 0 ] && RC=$RC_B2
else
  RC_B2="n/a"
fi
echo "=== 6b. real concurrency: the races, two live backends, no sleep() (Pack A) ==="
python3 -I $H/races.py
RCR=$?; [ $RCR -ne 0 ] && RC=$RCR
# The overlay's own races, carried here from the second independent
# challenge's `pb3race.py` rather than left in its evidence directory: a law
# whose concurrency is proved by somebody else's script is a law this pack
# cannot re-prove when §3.6's writer lands.
if [ -f "$H/races_b.py" ]; then
  echo "=== 6d. real concurrency: the lot overlay's races (Pack B) ==="
  python3 -I $H/races_b.py
  RCRB=$?; [ $RCRB -ne 0 ] && RC=$RCRB
else
  RCRB="n/a"
fi
echo "=== 7. the frozen tree, after the run ==="
cd $REPO && git status --porcelain -- infrastructure/database | wc -l | sed 's/^/tracked changes under infrastructure\/database: /'
python3 -I - <<PY
import json,hashlib,os
m=json.load(open('$REPO/infrastructure/database/MIGRATION_MANIFEST.json'))
d='$REPO/infrastructure/database/migrations'
bad=[r['name'] for r in m['migrations'] if hashlib.sha256(open(os.path.join(d,r['name']),'rb').read()).hexdigest()!=r['sha256']]
print("frozenThrough:",m['frozenThrough'],"| frozen entries:",len(m['migrations']),"| digest mismatches:",bad)
PY
# EXIT CODES, in the log itself (V3 §9). A verdict read from prose rather than
# from a status is how a green report over a failing run happens.
echo
echo "RUN_ID            : $RUN_ID"
echo "RUN_AT_UTC_END    : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "EXIT_PROOFS_A     : $RC_PROOFS  (prep/phase11/harness/proofs.py)"
echo "EXIT_PROOFS_B     : $RC_B  (prep/phase11/harness/proofs_b.py)"
echo "EXIT_PROOFS_A_RUN2: $RC_PROOFS2  (the same file, the same database -- idempotence)"
echo "EXIT_PROOFS_B_RUN2: $RC_B2  (the same file, the same database -- idempotence)"
echo "EXIT_GENERATED_BLOCKS: $RC_BLOCKS  (prep/phase11/harness/check_fenced_figures.py --check-blocks, run at step 0c beside the figure scan)"
echo "EXIT_FENCED_FIGURES: $RC_FIGURES  (prep/phase11/harness/check_fenced_figures.py, run at step 0c: after the cluster is up, before the database is recreated)"
echo "EXIT_RACES        : $RCR  (prep/phase11/harness/races.py)"
echo "EXIT_RACES_B      : $RCRB  (prep/phase11/harness/races_b.py)"
echo "EXIT_SCRIPT       : $RC  (0 means every step above returned 0)"
exit $RC
