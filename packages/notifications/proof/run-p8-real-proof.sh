#!/usr/bin/env bash
# =====================================================================
# Phase 8 — the real-schema proof runner
# =====================================================================
# WHAT CHANGED FROM ROUND 10. The old runner applied a PROTOTYPE schema that
# transcribed the parts of the system the cases needed. The fourth challenge
# rejected that, and it was right: two of the transcription's details were
# wrong, and the isolation result rested on one of them. This runner applies the
# REAL frozen history — every file in infrastructure/database/migrations,
# unmodified, as `daftar_migrator` — and then applies Phase 8 as an OVERLAY on
# top. Nothing under migrations/ is written, read-only, at any point, including
# during mutation: the mutants are planted in a COPY of the overlay.
#
# WHAT CHANGED IN ROUND 12. The fifth challenge found the schema sound and the
# APPARATUS AROUND IT wrong in two blocking ways, and both are fixed here.
#   * The history is now applied by THE REPOSITORY'S OWN APPLIER,
#     apps/api/src/infra/migrate.ts, as `daftar_migrator`, with NO external
#     privilege lend of any kind. Round 11 applied the files with a psql loop
#     and lent CREATE ON SCHEMA public from outside, as a SUPERUSER, outside the
#     migration's transaction, to a hardcoded role list — and then reported the
#     need for that lend as a gap in the deployment contract. That report was
#     FALSE: migrate.ts derives each file's ownership targets from the file
#     itself and lends and revokes inside that file's own transaction, so the
#     privilege never exists in any committed state. The psql loop also left no
#     `schema_migrations` ledger, and a boundary with no migration ledger is not
#     the boundary a deployment produces. Both are corrected; the false item is
#     withdrawn from the patch request.
#   * The frozen-integrity check no longer asks git and believes its silence. It
#     runs `p8-frozen-integrity.py`, whose exit code IS read.
#
#     ROUND 14, N-4: the sentence that stood here survived the fix it described.
#     It said the check "verifies every file against the digests the repository
#     itself records in MIGRATION_MANIFEST.json" — which was round 12's design,
#     and is exactly what S-1 refuted. It verifies the 80 files the manifest
#     COVERS, out of 87 on disk; the set is DERIVED FROM THE DIRECTORY and
#     anchored by the numbering, and the manifest supplies only the digests to
#     compare. See that file's header for all three fail-opens it has replaced.
#
# WHAT IT PROVES, AND WHAT IT DOES NOT. It proves each named law refuses by its
# own name on a real cluster, and that each law reds when its own guard is
# removed. It proves nothing about timing, throughput or performance, and it
# makes no claim about any of them.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
MIG=$REPO/infrastructure/database/migrations
B=${PG_BIN:-/usr/lib/postgresql/16/bin}
D=${PG_DIR:-/var/tmp/p8pg}
P=${PG_PORT:-55438}
# ROUND 15: this default was the literal `P8-R11-`, four rounds after round 11,
# so a run of THIS round stamped every line of its own log with another round's
# number while the handoff quoted the right one. Nothing measured was wrong, and
# that is the hazard: a label the reader cannot check against the run. The
# default now carries no round number at all, so a round number appears only
# where an operator supplied one.
RUN=${RUN_ID:-P8-RUN-$(date -u +%Y%m%dT%H%M%SZ)}
OUT=$D/$RUN
# ROUND 31, the coordinator's §6 and C-3's R-7, which it hit by accident and
# which is a real hole: `say` appends with `tee -a`, and the census judges
# every prefixed line in the log whatever run id it carries. A re-run under a
# RUN_ID whose directory already holds a log therefore measures the UNION of
# two runs. It failed closed in the shape the coordinator hit — an aborted
# run's `BASELINE BUILD FAILED` line, refused as an unknown arm — and the
# per-identity counts stop the opposite direction, because a complete second
# run doubles every count. Neither is a reason to leave it unstated: a figure
# computed over two runs is a figure about neither.
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  printf '[%s] ABORT: the run directory %s already holds files, so this run would APPEND to another run'"'"'s log and every figure below would be computed over the union of the two. Use a fresh RUN_ID\n' "$RUN" "$OUT" >&2
  exit 2
fi
mkdir -p "$OUT"
FAILED=0

say(){ echo "[$RUN] $*" | tee -a "$OUT/run.log"; }

# ---------------------------------------------------------------------
# WHERE THIS GATE STANDS (round 28, F-C)
# ---------------------------------------------------------------------
# Until round 28 this gate inherited the caller's working directory and passed
# it to every child, including an arm that deletes a guard and then renames
# frozen migration files relative to cwd. Run from the proof directory that arm
# was vacuous; run from the repository root it renumbered all 80 frozen
# migrations. A gate whose RESULT depends on where it was invoked from was never
# "run twice, FAILED=0" — it was run twice from one place.
#
# So the gate states where it was invoked, asserts the paths it derived, and
# MOVES to its own run directory, which is what every child now inherits. The
# repository is still reachable by its absolute path and nothing else resolves
# relative to it.
STARTED_IN=$PWD
for _need in "$HERE/p8-overlay.sql" "$HERE/p8-case-helpers.sql" \
             "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" \
             "$REPO/infrastructure/database/migrations"; do
  if [ ! -e "$_need" ]; then
    say "ABORT: this gate derived $_need from its own location and it is not there, so either the runner was copied out of the pack or the tree is not the one it was written for. Refusing rather than measuring something else"
    exit 2
  fi
done
if [ -e "$REPO/infrastructure/database/.p8-sandbox" ]; then
  say "ABORT: $REPO declares itself a PLANT SANDBOX, which the repository must never do — a disposable copy's marker has been committed or copied into the real tree, and every plant would then be allowed to rename its frozen migrations"
  exit 2
fi
cd "$OUT" || { say "ABORT: the run directory $OUT could not be entered, and this gate will not run from an inherited working directory"; exit 2; }
say "cwd: invoked from $STARTED_IN, running from $PWD — every child inherits THIS directory, and the repository is reached only by its absolute path $REPO"
sup(){ "$B/psql" -h "$D" -p "$P" -U p8super -d "${2:-postgres}" -qt -v ON_ERROR_STOP=1 -c "$1"; }

# ---------------------------------------------------------------------
# 0  The cluster must be reachable, and must be the settled deploy line
# ---------------------------------------------------------------------
# ROUND 12, R-6/R-7: round 11's §0 read the version with no probe, so a cluster
# that was not running produced an EMPTY version string and the abort
# "not the PostgreSQL 16 family" — fail-closed, and a false sentence. Round 10's
# runner had the probe; this one had dropped it. Every abort below now names its
# real cause, and the ROLE assertion has moved to where the roles exist: §0
# cannot assert roles that only `bootstrap.sql` creates, and `build()` runs
# bootstrap. Round 11's runner asserted them in §0 and therefore could never
# succeed on a cluster nobody had bootstrapped by hand, which its own
# instructions did not say to do.
if ! "$B/pg_isready" -h "$D" -p "$P" >/dev/null 2>&1; then
  say "ABORT: no PostgreSQL is answering at $D:$P — start the cluster first"
  exit 2
fi
PGVER=$(sup "SHOW server_version" | tr -d ' \n')
if [ -z "$PGVER" ]; then
  say "ABORT: the cluster answered the probe but not a query as p8super — check the superuser role"
  exit 2
fi
COLL=$(sup "SELECT datcollate FROM pg_database WHERE datname='postgres'" postgres | tr -d ' \n')
say "server_version=$PGVER datcollate(template)=$COLL"
case "$PGVER" in 16.*) ;; *) say "ABORT: server_version is $PGVER, not the PostgreSQL 16 family"; exit 2;; esac
case "$COLL" in en_US.utf8|en_US.UTF-8) ;; *) say "ABORT: datcollate is $COLL, not en_US.utf8"; exit 2;; esac

# The applier is the repository's own, and it needs the repo's node_modules.
TSX=$REPO/node_modules/.bin/tsx
if [ ! -x "$TSX" ]; then
  say "ABORT: $TSX is missing — run npm ci at the repository root first; this runner applies the history with the project's own migrate.ts, not with a psql loop"
  exit 2
fi

assert_roles(){    # called AFTER bootstrap, because bootstrap is what creates them
  local r flags
  for r in daftar_migrator daftar_app daftar_worker daftar_platform; do
    flags=$(sup "SELECT coalesce(max(rolsuper::text || ' ' || rolbypassrls::text), 'ABSENT') FROM pg_roles WHERE rolname='$r'" daftar | tr -d '\n' | xargs)
    case "$flags" in
      ABSENT) say "ABORT: role $r does not exist after bootstrap — bootstrap.sql did not run or did not complete"; return 2;;
      "false false") say "role $r super/bypassrls = $flags";;
      *) say "ABORT: role $r is privileged ($flags); every isolation case below would be vacuous"; return 2;;
    esac
  done
  return 0
}

# ---------------------------------------------------------------------
# 1  Build: the real history, then the overlay, then the fixtures
# ---------------------------------------------------------------------
# ROUND 26. The case helpers are read through a variable so that ONE arm can
# run a build with the vacuity check deleted and require the fail-open to
# return. Every other build, including every mutant, reads the real file.
CASE_HELPERS=$HERE/p8-case-helpers.sql

# ROUND 28, F-C. `p8-plant.py` renames and deletes frozen migration files under
# its CURRENT DIRECTORY, and the only thing between it and the real tree was the
# identity guard — which one arm exists to DELETE. The coordinator's review ran
# that arm with cwd at the repository root, and the first run renumbered all 80
# frozen migrations and rewrote MIGRATION_MANIFEST.json. The frozen set is
# byte-immutable by standing instruction, mutation testing included, so a plant
# now refuses any tree that does not DECLARE itself disposable, and this is what
# writes that declaration into every copy this gate makes. A copy without it is
# refused by name; the repository must never contain one.
sandbox_marker(){   # sandbox_marker <copy-root>
  printf '%s\n' "P8 PLANT SANDBOX — a disposable copy; this file is never committed" \
    > "$1/infrastructure/database/.p8-sandbox"
}

build(){           # build <overlay-file> <logdir>
  local ov=$1
  local ld=$2
  mkdir -p "$ld"
  # ROUND 28, T-4. These two statements ESTABLISH the subject, and their exit
  # status used to be discarded — the DROP with its stderr too. The eighteenth
  # challenge hit it for real: with a backend left `idle in transaction` by an
  # interrupted run, the DROP failed 55006 and the CREATE failed "already
  # exists", both swallowed, and the run reported `overlay failed / BASELINE
  # BUILD FAILED` — a refusal naming the wrong reason, in the very range whose
  # title is that defect. It fails CLOSED, so it was never a fail-open; the
  # cause was simply misattributed, which costs a reader the one thing the
  # refusal is for. Every other step in this function names its own failure;
  # now these do too, and the DROP keeps its stderr for the message.
  if ! sup "DROP DATABASE IF EXISTS daftar" >"$ld/dropdb.log" 2>&1; then
    echo "the database could not be dropped: $(tail -1 "$ld/dropdb.log")"; return 1
  fi
  if ! sup "CREATE DATABASE daftar OWNER daftar_migrator" >"$ld/createdb.log" 2>&1; then
    echo "the database could not be created: $(tail -1 "$ld/createdb.log")"; return 1
  fi
  # bootstrap.sql grants ON DATABASE by the name `daftar`, so the database is
  # created under that name and the file runs unmodified.
  "$B/psql" -h "$D" -p "$P" -U p8super -d daftar -q -v ON_ERROR_STOP=1 -f "$REPO/infrastructure/database/bootstrap.sql" > "$ld/bootstrap.log" 2>&1 \
    || { echo "bootstrap failed"; return 1; }
  assert_roles || return 1
  # THE REPOSITORY'S OWN APPLIER, as the deploy role, with NO external privilege
  # lend. It checksum-verifies each file, takes an advisory lock, applies each
  # file in its own transaction, and records it in `schema_migrations`. It
  # derives each file's ownership targets from the file and lends/revokes CREATE
  # ON SCHEMA public INSIDE that transaction, so the privilege never exists in
  # committed state. Round 11 reimplemented a weaker version of this from
  # outside and then reported the need for it as a deployment gap; the report
  # was false and is withdrawn.
  ( cd "$REPO" && MIGRATION_DATABASE_URL="postgresql://daftar_migrator@/daftar?host=$D&port=$P" \
      "$TSX" apps/api/src/infra/migrate.ts ) > "$ld/migrate.log" 2>&1 \
    || { echo "the project applier failed"; return 1; }
  # The ledger is part of the boundary a deployment produces, so it is asserted
  # rather than assumed, and the file count is READ from disk, not written here.
  local want got
  want=$(ls "$MIG"/*.sql | wc -l | xargs)
  got=$(sup "SELECT count(*) FROM schema_migrations" daftar | tr -d ' \n')
  if [ "$want" != "$got" ]; then
    echo "the ledger holds $got rows for $want files on disk"; return 1
  fi
  echo "$got" > "$ld/applied"
  # And the privilege the applier lends must not survive its own transaction.
  local leaked
  leaked=$(sup "SELECT has_schema_privilege('daftar_platform','public','CREATE')::text" daftar | tr -d ' \n')
  if [ "$leaked" != "false" ]; then
    echo "daftar_platform holds CREATE ON SCHEMA public in committed state"; return 1
  fi
  # The overlay. Its own §7 refuses if the shape it claims is not the shape it
  # produced, so a silent half-apply is not possible.
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 --single-transaction -f "$ov" > "$ld/overlay.log" 2>&1 \
    || { echo "overlay failed"; return 1; }
  sup "CREATE SCHEMA IF NOT EXISTS p8 AUTHORIZATION daftar_migrator" daftar >/dev/null
  sup "GRANT USAGE ON SCHEMA p8 TO daftar_app, daftar_worker, daftar_platform" daftar >/dev/null
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 -f "$CASE_HELPERS" > "$ld/helpers.log" 2>&1 || return 1
  sup "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA p8 TO daftar_app, daftar_worker, daftar_platform" daftar >/dev/null
  "$B/psql" -h "$D" -p "$P" -U daftar_platform  -d daftar -q -v ON_ERROR_STOP=1 --single-transaction -f "$HERE/p8-real-fixtures.sql" > "$ld/fixtures-1.log" 2>&1 || { echo "fixtures 1 failed"; return 1; }
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator  -d daftar -q -v ON_ERROR_STOP=1 --single-transaction -f "$HERE/p8-real-fixtures-owner.sql" > "$ld/fixtures-2.log" 2>&1 || { echo "fixtures 2 failed"; return 1; }
  return 0
}

# ROUND 26. `cases` takes an OPTIONAL second argument: a directory whose copy
# of a case file is used in place of the real one. It exists for the vacuity
# arms below, which neuter one case's WHERE in a copy; every other caller passes
# one argument and reads the real files, which is asserted by `csrc` resolving
# to $HERE whenever the override holds no copy of that name.
csrc(){            # csrc <basename> — the override's copy, else the real file
  if [ -n "${CASE_OVERRIDE:-}" ] && [ -f "$CASE_OVERRIDE/$1" ]; then
    echo "$CASE_OVERRIDE/$1"
  else
    echo "$HERE/$1"
  fi
}

cases(){           # cases <logdir> [override-dir]
  local ld=$1 rc=0 r
  local CASE_OVERRIDE=${2:-}
  for pair in "daftar_app:p8-real-cases-app.sql" \
              "daftar_migrator:p8-real-cases-owner.sql" \
              "daftar_platform:p8-real-cases-platform.sql"; do
    r=${pair%%:*}; f=${pair#*:}
    "$B/psql" -h "$D" -p "$P" -U "$r" -d daftar -v ON_ERROR_STOP=1 -f "$(csrc "$f")" > "$ld/$f.log" 2>&1 || rc=1
  done
  # ROUND 24, O-4. `daftar_worker` holds grants nothing exercised: a
  # column-scoped UPDATE on notifications, an append-only INSERT on attempts,
  # and the quarantine INSERT; and the status ladder was a database rule tested
  # only in TypeScript. The worker cannot create an obligation — that is case
  # W-3 — so its cases need rows that are already committed, which the three
  # files above cannot leave behind because each rolls itself back. Hence:
  # commit a baseline AFTER them, run the worker file, then remove the baseline
  # again, so nothing that runs later (the race proof commits) inherits it.
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
            -f "$(csrc p8-real-fixtures-worker.sql)" > "$ld/fixtures-worker.log" 2>&1 \
    || { echo "the worker baseline did not commit" >> "$ld/fixtures-worker.log"; rc=1; }
  "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
            -f "$(csrc p8-real-cases-worker.sql)" > "$ld/p8-real-cases-worker.sql.log" 2>&1 || rc=1
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
            -f "$(csrc p8-real-fixtures-worker-teardown.sql)" > "$ld/fixtures-worker-teardown.log" 2>&1 \
    || { echo "the worker baseline was NOT removed" >> "$ld/fixtures-worker-teardown.log"; rc=1; }
  grep -h "PASS" "$ld"/*.sql.log 2>/dev/null | wc -l > "$ld/passes"
  return $rc
}

say "=== baseline ==="
build "$HERE/p8-overlay.sql" "$OUT/baseline" || { say "BASELINE BUILD FAILED"; exit 1; }
say "migrations applied = $(cat "$OUT/baseline/applied")"
if cases "$OUT/baseline"; then
  say "baseline cases rc=0 passes=$(cat "$OUT/baseline/passes")"
  # ROUND 27, the coordinator's F-3 (P3). Nothing asserted this figure. Every
  # document in the pack quotes it, every mutant arm is read against it, and
  # the run printed whatever it happened to count — so a case silently lost to
  # a syntax slip, a renamed file or a dropped `SELECT` would lower the number
  # and nothing would red. It is now a LITERAL, compared, and a case added
  # deliberately must raise it here in the same commit.
  # ROUND 28: 98 -> 101, three cases that RECORD the NULL-event-id gap
  # (`G-NULL-a`/`-b`/`-c`), raised here in the same commit that adds them,
  # which is the discipline this literal exists for.
  P8_EXPECT_CASES=101
  _cases_got=$(cat "$OUT/baseline/passes" | xargs)
  if [ "$_cases_got" != "$P8_EXPECT_CASES" ]; then
    say "FAIL: BASELINE CASE COUNT — expected $P8_EXPECT_CASES, measured $_cases_got. A case was added, lost or renamed: if it was added, raise the literal in this runner in the same commit; if it was lost, the pack is measuring less than every document in it claims"
    FAILED=1
  else
    say "BASELINE CASE COUNT: $_cases_got, equal to the literal this runner declares — the figure every document quotes is now asserted and not merely printed"
  fi
else
  say "FAIL: BASELINE CASES FAILED"; grep -h "FAIL\|ERROR" "$OUT"/baseline/*.sql.log | head -5 | tee -a "$OUT/run.log"; exit 1
fi

# The one EXECUTED race this phase has. Round 11's runner dropped it; the fifth
# challenge reported that as a coverage regression and was right. It commits, so
# it runs after the case files (which each roll themselves back) and cleans up
# after itself.
if RACE_OUT=$OUT/baseline-race bash "$HERE/run-p8-race-proof.sh" > "$OUT/baseline/race.log" 2>&1; then
  say "$(grep -o 'I1-conc PASS.*' "$OUT/baseline/race.log" | head -1)"
else
  say "FAIL: BASELINE RACE FAILED"; tail -3 "$OUT/baseline/race.log" | tee -a "$OUT/run.log"; FAILED=1
fi

# ---------------------------------------------------------------------
# 2  Mutation: every law must red when ITS OWN guard is removed
# ---------------------------------------------------------------------
# Each mutant is planted in a COPY of the overlay. Three things are asserted per
# mutant, in this order, and any one of them failing fails the run:
#   (a) the mutation LANDED — the copy differs from the baseline at the line
#       named, because a mutant that did not apply reds nothing and looks like
#       a pass;
#   (b) the named case FAILED — and by its own label, not merely "something
#       broke": a build that dies before any case runs is NOT a red proof;
#   (c) the baseline file is byte-identical afterwards.
BASE_SHA=$(sha256sum "$HERE/p8-overlay.sql" | cut -d' ' -f1)
MUT=$HERE/p8-mutants.py

# <<< P8-Y7-CUT-BEGIN-A >>>

plant(){           # plant <id> <dir> — mutate a COPY, and refuse a no-op
  # NOTE ON `local`: bash expands every word on the line before any of the
  # assignments take effect, so `local id=$1 md=$OUT/mut-$id` reads an empty
  # $id. Each derived variable gets its own line throughout this file.
  local id=$1
  local md=$2
  mkdir -p "$md"
  cp "$HERE/p8-overlay.sql" "$md/overlay.sql"
  python3 -I "$MUT" "$id" "$md/overlay.sql" > "$md/plant.log" 2>&1 || return 1
  cmp -s "$md/overlay.sql" "$HERE/p8-overlay.sql" && return 1
  return 0
}

mutate(){          # mutate <id> <expect-case-label>
  local id=$1 expect=$2
  local md=$OUT/mut-$id   # a separate line: see the note in `plant`
  plant "$id" "$md" || { say "MUT $id: FAIL — the mutation did not land"; FAILED=1; return; }
  if ! build "$md/overlay.sql" "$md" >/dev/null 2>&1; then
    # A mutant that cannot be applied at all is NOT a red proof: no case body
    # ran. It is reported as a failure of this mutant's design, because the
    # intent was to measure a CASE.
    say "MUT $id: FAIL — the mutated schema would not build, so no case ran"
    grep -h ERROR "$md/overlay.log" 2>/dev/null | head -2 | tee -a "$OUT/run.log"
    FAILED=1; return
  fi
  cases "$md" >/dev/null 2>&1
  if grep -hqF "ERROR:  $expect" "$md"/*.sql.log 2>/dev/null; then
    say "MUT $id: RED at '$expect' — as required"
  else
    say "MUT $id: FAIL — '$expect' did NOT red. The law is unguarded, or the case does not read it."
    grep -h "FAIL" "$md"/*.sql.log 2>/dev/null | head -3 | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

mutate_race(){     # mutate_race <id> — the RACE must fail, not a case file
  local id=$1
  local md=$OUT/mut-$id
  plant "$id" "$md" || { say "MUT $id: FAIL — the mutation did not land"; FAILED=1; return; }
  if ! build "$md/overlay.sql" "$md" >/dev/null 2>&1; then
    say "MUT $id: FAIL — the mutated schema would not build, so the race never ran"
    FAILED=1; return
  fi
  if RACE_OUT=$md/race bash "$HERE/run-p8-race-proof.sh" > "$md/race.log" 2>&1; then
    say "MUT $id: FAIL — the race PASSED with the key it contends for removed"
    FAILED=1
  else
    # The LAST I1-conc FAIL line, not the first: the first is the bound running
    # out, the last is the DIAGNOSIS that says which of the two meanings it had.
    # Sixth challenge S-3 is about keeping those two apart, so the summary line
    # carries the diagnosis.
    say "MUT $id: RED — the race fails without notifications_obligation_once: $(grep -o 'I1-conc FAIL.*' "$md/race.log" | tail -1)"
  fi
}

mutate_refuses(){  # mutate_refuses <id> <expect-apply-error>
  # For these mutants the required outcome is the OVERLAY REFUSING ITSELF at
  # apply time, and a successful build is the failure.
  local id=$1 expect=$2
  local md=$OUT/mut-$id   # a separate line: see the note in `plant`
  plant "$id" "$md" || { say "MUT $id: FAIL — the mutation did not land"; FAILED=1; return; }
  if build "$md/overlay.sql" "$md" >/dev/null 2>&1; then
    say "MUT $id: FAIL — the overlay applied anyway, so its own check does not fail on absence"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$md/overlay.log" 2>/dev/null; then
    say "MUT $id: RED — the overlay refused itself with '$expect'"
  else
    say "MUT $id: FAIL — the build failed, but NOT with '$expect'"
    grep -h ERROR "$md/overlay.log" 2>/dev/null | head -2 | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

say "=== mutation ==="
# Every mutant is described in p8-mutants.py, beside the code that plants it.
# Three of them are PAIRS: section 7 refuses the mutant at apply time, which is
# a real guard but is evidence about section 7 only, so the second half of the
# pair blinds section 7 and requires the CASE to red. Either guard alone would
# have hidden the other — the shape this project has now met in five phases.
mutate_refuses 1 "P8-OVERLAY-E(2): notifications carries 1 of the 2 required policies"
mutate         1b "A3 sibling business sees nothing"
mutate_refuses 2 "P8-OVERLAY-E(3): notifications.business_isolation does not read the live helpers"
mutate         2b "A6a app.bypass_rls does not lift the policy"
mutate         3  "M4 a suspended member is refused"
mutate         4  "T1b behind the policy, notifications_tenant_fk refuses by name"
mutate         5  "D3a the status CHECK and the ladder agree"
mutate         6  "D3b the arrival CHECK's token list is exactly what the ladder calls an arrival"
mutate         7  "X1 the owner may not truncate the attempt history"
mutate_refuses 8  "P8-OVERLAY-E(1): notification_settings is not under FORCED row level security"
mutate         8b "A11 another tenant sees none of this business's settings"
mutate_refuses 9 "P8-OVERLAY-E(5): a business-tier role can read unattributed events"
mutate         9b "A10 the app may not read unattributed events"
mutate_refuses 10 "P8-OVERLAY-E(4): the quarantine claims an isolation it cannot have"
mutate         10b "A12 the quarantine is not under RLS, because it has no tenant to scope by"
mutate         11  "T2 every tenant-scoped relation carries a composite tenant key"
mutate         13  "N6-e but the obligation is NOT released: no second channel"
mutate         14  "I3-d read -> sent is a regression"
mutate         15  "W-2 may NOT rewrite the obligation key — the UPDATE grant is column-scoped"
# ROUND 28. The one mutant that TIGHTENS: it simulates the owner deciding
# `OD-P8-NULL-EVENT`, and `G-NULL-b` must red, which is what makes the three
# cases recording the NULL gap load-bearing instead of prose beside a comment.
mutate         16  "G-NULL-b and a SECOND one is accepted too"
mutate_race    12

# <<< P8-Y7-CUT-END-A >>>
# ---------------------------------------------------------------------
# 3  The overlay must be untouched, and the frozen history must be VERIFIED
# ---------------------------------------------------------------------
NOW_SHA=$(sha256sum "$HERE/p8-overlay.sql" | cut -d' ' -f1)
if [ "$BASE_SHA" = "$NOW_SHA" ]; then
  say "the overlay is byte-identical after mutation: $NOW_SHA"
else
  say "FAIL: the overlay was MODIFIED by its own mutation run"; FAILED=1
fi

# ROUND 12, R-1: round 11 asked `git status` and believed its silence. The exit
# code was never read, so in a copy with no `.git` — which is exactly how the
# authoritative gates are told to run — git printed `fatal:` and the ELSE branch
# printed "no frozen migration is modified". It fired in round 11's own gate-6
# log. The check is now a program that verifies every file against the digests
# the repository itself records, and ITS EXIT CODE IS READ.
#
# ROUND 15, N-1': the check's own boundary was still read from the manifest. It
# is now ANCHORED to a pinned commit, and the three figures this pack claims are
# stated here rather than left to be inferred from the log.
#
# The anchor repository must be NAMED, because the authoritative gates run from
# a `git archive` copy that has no `.git` of its own — the same condition that
# produced round 12's fail-open. If it is not named, or names no reachable
# commit, THIS GATE GOES RED. It does not "skip the anchor": a run that quietly
# drops its strongest witness and still prints a pass is the defect this round
# exists to remove.
# ROUND 16, N-1" (route two): this line was
# `P8_ANCHOR_SHA=${P8_GIT_ANCHOR_SHA:-93084f8}` — one environment variable, and
# the anchor pointed somewhere else, with a seven-character abbreviation as the
# only pin. The anchor's identity is not the caller's to supply, so the SHA now
# lives in the check as forty characters and this script passes none. The
# variable is not merely ignored: being ignored silently is how a reader keeps
# believing it works.
# ROUND 17, N-2 (second half): this was its own forty-character literal, and the
# line below printed a claim about the one it did NOT hold. The challenger
# measured that with the two set to different commits the authoritative leg
# passed on a tampered tree while this script printed "pinned in the check, all
# forty characters" — false. There is ONE pin in the pack now, in the check, and
# this script ASKS for it. It still refuses what it reads, because a derived
# value is not an unchecked one.
P8_ANCHOR_PIN=$(python3 -I "$HERE/p8-frozen-integrity.py" --print-pin 2>/dev/null)
case "$P8_ANCHOR_PIN" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) say "FAIL: the check did not report a forty-character anchor pin (got '$P8_ANCHOR_PIN'), so this gate has nothing to require of it"; FAILED=1 ;;
esac
# ROUND 20, N-11: the gate's own reads of the anchor repository used plain
# `git -C`, which was the ONE git read in this pack without --no-replace-objects
# and without the environment scrub the check's `_git()` does. A replace ref or
# an inherited GIT_* key could therefore make the GATE's precondition disagree
# with the CHECK's guard — and a precondition that disagrees with the guard
# behind it masks every arm it gates. Same scrub, same flag, one helper.
anchor_git(){   # anchor_git <dir> <git args...>
  local d=$1; shift
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
      -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
      -u GIT_CEILING_DIRECTORIES -u GIT_REPLACE_REF_BASE -u GIT_NAMESPACE \
      -u GIT_LITERAL_PATHSPECS -u GIT_CONFIG -u GIT_CONFIG_GLOBAL \
      -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT \
      GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null \
      git --no-replace-objects -C "$d" "$@"
}

P8_ANCHOR_DIR=${P8_GIT_ANCHOR_DIR:-}
P8_EXPECT_COVERED=80
P8_EXPECT_BOUNDARY=0079_phase4_pos_till_sessions_cart.sql
P8_EXPECT_COVERED_DIGEST=ae0a8d0a45403ced7f622c67dc4bb7ed8a196592c386c33379fcce79b205f916
# ROUND 17, N-1-TRIPLE-PRIME: these were STRINGS, expanded unquoted at the call
# site. The anchor directory is the only caller-controlled value among them, so
# the caller chose not merely which repository was read but WHICH ARGUMENTS the
# check received — a directory named `--inner-guards-only`, or merely containing
# it after a space, turned the strongest leg OFF and a tampered tree exited 0.
# Both forms were measured here before this was written. They are ARRAYS now, so
# one element is one argument whatever it contains, and a path with a space
# arrives whole (also measured: the old form truncated it and then refused by
# naming a directory that does not exist).
ANCHOR_ARGS=()
if [ -n "${P8_GIT_ANCHOR_SHA:-}" ] && [ "${P8_GIT_ANCHOR_SHA}" != "$P8_ANCHOR_PIN" ]; then
  say "FAIL: ANCHOR IDENTITY — P8_GIT_ANCHOR_SHA=${P8_GIT_ANCHOR_SHA} is set, and this gate's anchor is pinned to $P8_ANCHOR_PIN inside the check; the variable no longer steers anything and is refused rather than ignored"
  FAILED=1
elif [ -n "${P8_GIT_ANCHOR_SHA:-}" ]; then
  say "NOTE: P8_GIT_ANCHOR_SHA is set to the pin itself, which steers nothing; the check carries the pin"
fi
# ROUND 18, the diagnostic half of N-6. The refusal below clears the variable and
# the next branch then reported "P8_GIT_ANCHOR_DIR is not set" — a sentence that
# is internally true and names a state THIS PATH created one line earlier, not
# anything the operator did. It is the same family as N-6 itself, where
# `--git-dir=VALUE` produced "no --git-dir was given": true about the variable,
# false about the command line it was handed. Two named refusals for one cause
# are kept; what is fixed is that the second named the wrong cause, and sent a
# reader who reads the LAST failure looking for an export that was never missing.
ANCHOR_DIR_REJECTED=0
# ROUND 21, N-16: a rejection by THIS gate's precondition leaves ANCHOR_ARGS
# empty, so the authoritative run below printed the check's "no --git-dir was
# given" — true of the command line it received, false about what the operator
# did, and the same sentence the no-anchor red prints. Third time that sentence
# has misnamed its cause. The flag makes the gate say which it was.
ANCHOR_PRECOND_REJECTED=0
case "$P8_ANCHOR_DIR" in
  -*) say "FAIL: ARGUMENT INJECTION — P8_GIT_ANCHOR_DIR=$P8_ANCHOR_DIR is option-shaped, so the anchor's directory cannot be told from this gate's own flags; refusing"
      FAILED=1; ANCHOR_DIR_REJECTED=1; P8_ANCHOR_DIR="" ;;
esac
if [ "$ANCHOR_DIR_REJECTED" = 1 ]; then
  say "FAIL: P8_GIT_ANCHOR_DIR was REJECTED above as option-shaped, not left unset, so this gate now runs with no anchor at all and the frozen boundary has no witness outside the tree under test; refusing to report a pass"
  FAILED=1
elif [ -z "$P8_ANCHOR_DIR" ]; then
  say "FAIL: P8_GIT_ANCHOR_DIR is not set, so the frozen boundary has no witness outside the tree under test; refusing to report a pass without it"
  FAILED=1
elif ! anchor_git "$P8_ANCHOR_DIR" rev-parse --verify "${P8_ANCHOR_PIN}^{commit}" >/dev/null 2>&1; then
  say "FAIL: P8_GIT_ANCHOR_DIR=$P8_ANCHOR_DIR does not contain the anchor commit $P8_ANCHOR_PIN"
  FAILED=1; ANCHOR_PRECOND_REJECTED=1
# ROUND 20, N-11: this precondition used to test CONTAINMENT only — the very
# relation round 19 declared insufficient — so the gate announced an anchor and
# the check then refused it, and every arm behind the announcement reported
# "refused, but did not name …": the masking lesson a fourth time, one level up,
# where the arms have no precondition of their own to assert because the anchor
# belongs to the gate. The precondition now MIRRORS the guard behind it, in the
# same order the check applies: shallow first (a truncated graph's definite "no"
# is undecided, N-9), then ancestry.
elif ! anchor_git "$P8_ANCHOR_DIR" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
  # A shallow repository's YES is trustworthy — reachability is proved by the
  # graph that is present — and only its NO is uninformative, because absence
  # may be truncation. So the ancestry answer is taken first and shallowness is
  # consulted only to explain a non-zero one. Measured here the hard way: the
  # first version of this precondition refused any shallow anchor and reddened
  # the whole gate against this container's own checkout, which was shallow
  # (532 of 930 commits) while answering the ancestry question CORRECTLY.
  #
  # ROUND 21, N-14: `git rev-parse` ECHOES an option it does not recognise and
  # exits 0 (measured: `rev-parse --is-shallow-repositoryX` prints the word and
  # returns 0), so a test for "= true" reads a non-answer as "not shallow" and
  # then asserts, in the refusal below, something the probe never established.
  # Only the two literals are answers; anything else is undecided and says so.
  _sh=$(anchor_git "$P8_ANCHOR_DIR" rev-parse --is-shallow-repository 2>/dev/null)
  if [ "$_sh" = true ]; then
    say "FAIL: P8_GIT_ANCHOR_DIR=$P8_ANCHOR_DIR holds $P8_ANCHOR_PIN but is SHALLOW and its ancestry answer was negative, which a truncated graph cannot distinguish from absence; pass a complete checkout (fetch-depth 0, no --depth on any later fetch)"
  elif [ "$_sh" != false ]; then
    say "FAIL: P8_GIT_ANCHOR_DIR=$P8_ANCHOR_DIR holds $P8_ANCHOR_PIN, its ancestry answer was negative, and this git did not answer whether the repository is shallow (it said '$_sh'), so whether that negative means anything is UNDECIDED; refusing rather than calling it a lineage failure"
  else
    say "FAIL: P8_GIT_ANCHOR_DIR=$P8_ANCHOR_DIR holds $P8_ANCHOR_PIN but does not DESCEND from it, so it is a repository that happens to hold the object; the check would refuse it as ANCHOR LINEAGE and every arm behind this line would report itself untested instead of naming its own guard"
  fi
  FAILED=1; ANCHOR_PRECOND_REJECTED=1
else
  ANCHOR_ARGS=(--git-dir "$P8_ANCHOR_DIR")
  say "the frozen boundary is anchored to $P8_ANCHOR_PIN (the ONE pin, read out of the check itself) in $P8_ANCHOR_DIR, which CONTAINS it, is not shallow, and DESCENDS from it, read with replacement objects disabled"
fi
CLAIM_ARGS=(--expect-covered "$P8_EXPECT_COVERED" --expect-boundary "$P8_EXPECT_BOUNDARY" --expect-covered-digest "$P8_EXPECT_COVERED_DIGEST")
if [ "$ANCHOR_PRECOND_REJECTED" = 1 ]; then
  say "FAIL: the anchor directory WAS given and was rejected by this gate's own precondition above (lineage, shallowness, or containment) — so the check below runs with no --git-dir and will say so, and that sentence is about the command line this gate built, not about a missing export"
  FAILED=1
fi
INTEGRITY_OUT=$OUT/frozen-integrity.log
# ROUND 17, N-2: the authoritative run must SAY that the anchor leg ran. Round
# 16's evidence for its strongest leg was the ABSENCE of a complaint, which is
# what every fail-open in this phase has looked like from outside — and the
# injection above produced exactly that: a quiet exit 0 whose next line said the
# leg had not run. The token is required, and the pin and directory inside it
# must be the ones this gate asked for.
if python3 -I "$HERE/p8-frozen-integrity.py" "$REPO" "${ANCHOR_ARGS[@]}" "${CLAIM_ARGS[@]}" > "$INTEGRITY_OUT" 2>&1; then
  while IFS= read -r line; do say "$line"; done < "$INTEGRITY_OUT"
  WANT_TOKEN="ANCHOR LEG EXERCISED: pin=$P8_ANCHOR_PIN dir=$P8_ANCHOR_DIR"
  if [ -n "$P8_ANCHOR_DIR" ] && ! grep -qF "$WANT_TOKEN" "$INTEGRITY_OUT"; then
    say "FAIL: the frozen-integrity check exited 0 but never said it exercised the anchor leg for the pin and directory this gate asked for ('$WANT_TOKEN'). A reader throws unless it sees the pass token; the absence of a complaint is not evidence that the leg ran."
    FAILED=1
  fi
else
  say "FAIL: the frozen history did not verify against the manifest"
  while IFS= read -r line; do say "  $line"; done < "$INTEGRITY_OUT"
  FAILED=1
fi

# <<< P8-Y7-CUT-BEGIN-B >>>
# A check that cannot fail is worth nothing, so the check is itself measured —
# the lesson round 11 wrote into `mutate_refuses` and then did not apply to its
# own last ten lines. TWELVE ways of breaking it, each required to exit non-zero
# AND to name its own cause.
#
# ROUND 14 ALSO RE-AIMED TWO OF THEM, and the reason is this phase's own lesson
# (a guard in front of a guard is evidence about the OUTER one). N-1's numbering
# law runs BEFORE the row/file equality, so it masked (b) and (f): a deleted
# file is now diagnosed as a HOLE rather than as an orphaned row, and an extra
# file planted inside the range necessarily collides with a number, because the
# range is contiguous. Rather than relabel them and lose the witnesses, (b) and
# (f) are re-aimed at paths only they reach, and (l) is added for the orphaned
# row. What is no longer reachable is stated plainly: UNLISTED cannot be reached
# by ADDING a file inside the range any more, only by deleting a row — which is
# mutant (e), the one place it matters. Every one runs against a COPY of the two
# directories; nothing under migrations/ is written, here or anywhere.
#
# ROUND 13, S-1: four of these eight are new, and (e) is the one that matters —
# round 12's check iterated the MANIFEST, so editing a frozen file AND deleting
# its row passed green, with the edited file silently re-counted as "beyond".
# The check now derives the required set from the DIRECTORY, so a row can no
# longer excuse a file. (g) and (h) close the same door on `frozenThrough`.
# A digest over EXACTLY the two things the sandbox is a copy of — the migrations
# directory and the manifest — and nothing else, so the comparison is between
# like and like. Paths are relative to the directory given, so the two sides are
# comparable; an unreadable side yields a different digest, never an equal one.
copied_digest(){
  (
    cd "$1" 2>/dev/null || exit 0
    find migrations -type f -print0 2>/dev/null | sort -z | xargs -0r sha256sum 2>/dev/null
    sha256sum MIGRATION_MANIFEST.json 2>/dev/null
  ) | sha256sum | cut -d' ' -f1
}

integrity_must_refuse(){   # integrity_must_refuse <id> <setup> <expect> [extra-flags]
  local id=$1
  local setup=$2
  local expect=$3
  # ROUND 15: the twelve plants above run with NO anchor and NO claimed figures,
  # deliberately. The git anchor is an OUTER guard: with it on, a modified byte
  # is diagnosed as ANCHOR DRIFT and a moved boundary as "the boundary has
  # MOVED", so every one of the twelve would be refused by the outer guard's
  # name and would stop being evidence about the guard its comment names. This
  # phase has paid for that shape twice already ("a guard in front of a guard is
  # evidence about the outer one"), so the new plants carry their flags
  # explicitly, one arm per guard, and the old twelve keep testing the inner
  # ones.
  # ROUND 17: this used to be `local extra=${4:-}`, one string the call site
  # quoted and the run unquoted. That is the shape the tenth challenge attacked,
  # and it broke here the moment the authoritative call became an array: a
  # single word "$CLAIM_ARGS" carries only the array's FIRST element, so the
  # three claim arms ran with `--expect-covered` and no value and reported
  # "PASSED on a broken tree". Caught by this run. The extra flags are now the
  # remaining positional arguments, passed through as an array, so there is no
  # string for a space to split.
  shift 3
  local sand=$OUT/integrity-$id
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  sandbox_marker "$sand"
  ( cd "$sand" && eval "$setup" ) >/dev/null 2>&1
  # ROUND 14: assert the plant LANDED. Without this, a setup that silently fails
  # — a mistyped filename, which this round had — runs the check against an
  # unmodified tree. That would be caught here as "PASSED on a broken tree", but
  # by the wrong name, and a mutant whose failure is misdiagnosed is the defect
  # class this phase has now paid for four times.
  # ROUND 15, P3-2: this comparison was `diff -r -q ... && cmp -s ...`, and
  # `diff` returns 2 for ITS OWN errors as well as 1 for a difference. So a
  # sandbox the comparison could not read — the plant that deletes a file, a
  # permission problem, a missing path — short-circuited the && and was recorded
  # as "landed". The same shape as every other finding this phase has paid for:
  # the quantity deciding whether anything is wrong was read from something that
  # answers the same way when it cannot answer at all. It is now a DIGEST of
  # both trees, computed the same way on each side, with no rc to misread: equal
  # digests mean the plant did not land, and a digest that cannot be computed is
  # an empty string on one side only, which is a difference, not a pass.
  if [ "$(copied_digest "$REPO/infrastructure/database")" \
     = "$(copied_digest "$sand/infrastructure/database")" ]; then
    say "INTEGRITY-MUT $id: FAIL — the mutation did not land; the sandbox is identical to the source"
    FAILED=1; return
  fi
  local out=$sand/out.log
  # ROUND 16: `--inner-guards-only` is now how a run says it is NOT exercising
  # the anchor. It used to be the absence of a flag, which is how round 15's
  # check came to print a pass line with its strongest leg never run.
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only "$@" > "$out" 2>&1; then
    say "INTEGRITY-MUT $id: FAIL — the check PASSED on a broken tree"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$out"; then
    say "INTEGRITY-MUT $id: refused, and named it — '$expect'"
  else
    say "INTEGRITY-MUT $id: FAIL — it refused, but did not name '$expect'"
    head -2 "$out" | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

say "=== the integrity check, measured against itself ==="
# (a) a frozen file edited by one byte — the case the whole check exists for
integrity_must_refuse a \
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql" \
  "MODIFIED      0006_rls.sql"
# (b) a frozen file deleted, its manifest row left behind. RE-AIMED in round 14:
#     this used to be the ORPHANED ROW witness, and the numbering law now
#     diagnoses it earlier and more precisely as a hole. Kept as its own plant
#     because it witnesses something (i) does not: deletion is caught whether or
#     not the row goes with it.
integrity_must_refuse b \
  "rm infrastructure/database/migrations/0013_security_boundary.sql" \
  "MISSING NUMBER 0013"
# (c) the manifest itself gone — round 11's shape of failure, where the tool the
#     check depends on cannot answer. It must now refuse, not reassure.
integrity_must_refuse c \
  "rm infrastructure/database/MIGRATION_MANIFEST.json" \
  "the manifest could not be read"
# (d) the manifest present but not the shape the check reads
integrity_must_refuse d \
  "printf '{}' > infrastructure/database/MIGRATION_MANIFEST.json" \
  "not the shape this check reads"
# (e) ROUND 13's BLOCKER, S-1, measured: a frozen file edited AND its manifest
#     row deleted. Round 12's check reported "79 of 87 verified … rc=0" on
#     exactly this, and re-labelled 0006_rls.sql — the file that creates RLS —
#     as one of the files past the attested range. It must now refuse BY NAME.
integrity_must_refuse e \
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql && python3 -I -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations']=[r for r in m['migrations'] if r['name']!='0006_rls.sql'];json.dump(m,open(p,'w'))\"" \
  "UNLISTED      0006_rls.sql"
# (f) an extra file planted INSIDE the attested range with no row of its own.
#     RE-AIMED in round 14: `0006a_sneak.sql` now trips the numbering law as a
#     REPEATED NUMBER (which (k) already witnesses), because every number in the
#     range is taken. So this plant is aimed at the one way an extra file can
#     arrive inside the range without colliding — carrying no number at all.
#     `000a_sneak.sql` sorts below `0079_…` and its prefix is not four digits.
integrity_must_refuse f \
  "cp infrastructure/database/migrations/0006_rls.sql infrastructure/database/migrations/000a_sneak.sql" \
  "UNNUMBERED    000a_sneak.sql"
# (g) frozenThrough moved BACKWARDS to a file that does exist, which would
#     shrink the attested set without touching a single digest.
integrity_must_refuse g \
  "python3 -I -c \"import json,os;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));od=sorted(f for f in os.listdir('infrastructure/database/migrations') if f.endswith('.sql'));m['frozenThrough']=od[5];json.dump(m,open(p,'w'))\"" \
  "a row for a file beyond frozenThrough"
# (h) frozenThrough naming a file that is not there — RE-AIMED in round 14. The
#     old plant used `9999_nope.sql`, which sorts ABOVE every file, so with the
#     boundary guard removed it would have been refused by the UNLISTED path
#     instead: a valid test that did not exercise the guard its comment names.
#     The challenger found that and then measured that the guard is nonetheless
#     load-bearing: `0079a_nope.sql` sorts between `0079_…` and `0080_…`, so the
#     derived set is exactly the manifest's 80 rows, the equality holds, every
#     digest matches, and without the guard the check prints "all 80 matching
#     (read as 0079a_nope.sql)" and exits 0 on a boundary naming no file. The
#     plant now aims there.
integrity_must_refuse h \
  "python3 -I -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['frozenThrough']='0079a_nope.sql';json.dump(m,open(p,'w'))\"" \
  "the attested boundary cannot be located"
# (i) ROUND 14's BLOCKER, N-1, measured: a frozen migration DELETED together
#     with its manifest row. Round 13 closed "a row excuses a file"; this is the
#     mirror, where a file's absence excused its row's absence, and the whole of
#     gate 6 exited 0 reporting "79 files ... all 79 matching". The numbering is
#     what anchors the set now, so the hole must be NAMED.
integrity_must_refuse i \
  "rm infrastructure/database/migrations/0050_accounting_report_indexes.sql && python3 -I -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations']=[r for r in m['migrations'] if r['name']!='0050_accounting_report_indexes.sql'];json.dump(m,open(p,'w'))\"" \
  "MISSING NUMBER 0050"
# (j) ROUND 14, N-2: a SECOND row for one file, carrying the digest of an edited
#     copy and leaving the original row in place. The rows were read into a dict,
#     so the last one won silently and the check reported a pass on a record
#     holding two digests for one name.
integrity_must_refuse j \
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql && python3 -I -c \"import json,hashlib;p='infrastructure/database/MIGRATION_MANIFEST.json';h=hashlib.sha256(open('infrastructure/database/migrations/0006_rls.sql','rb').read()).hexdigest();m=json.load(open(p));m['migrations'].append({'name':'0006_rls.sql','sha256':h});json.dump(m,open(p,'w'))\"" \
  "DUPLICATE ROW 0006_rls.sql"
# (k) two files claiming one number — the renumbering route into a hole, which
#     the same numbering equality refuses as a repetition rather than a gap.
integrity_must_refuse k \
  "cp infrastructure/database/migrations/0049_accounting_periods.sql infrastructure/database/migrations/0050_twin.sql" \
  "REPEATED NUMBER 0050"
# (l) a manifest row for a file that does not exist, inside the range — the
#     ORPHANED ROW witness that (b) used to carry before the numbering law
#     diagnosed (b)'s plant earlier. A ghost row leaves the directory untouched,
#     so it reaches the equality rather than the numbering law.
integrity_must_refuse l \
  "python3 -I -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations'].append({'name':'0013a_ghost.sql','sha256':'0'*64});json.dump(m,open(p,'w'))\"" \
  "ORPHANED ROW  0013a_ghost.sql — NO SUCH FILE"

# ---------------------------------------------------------------------
# ROUND 15, N-1': THE PLANTS THE ROUND-14 CHECK CALLED CORRECT.
# ---------------------------------------------------------------------
# Every one of the twelve plants above breaks the tree's INTERNAL consistency —
# a file disagrees with a row, a row with a file, a number with its neighbours.
# The eighth challenge found the case none of them reach: a change that moves
# the boundary AND the rows together leaves nothing inside the tree disagreeing
# with anything else inside it, so the round-14 check exited 0 on it.
#
# These five plants are therefore measured in a different shape, because
# "it refuses" is not the claim. The claim is that the guard added this round is
# LOAD-BEARING: the same tree must pass with the guard absent and be refused BY
# NAME with it present. That is measured without patching the guard out, by
# running the check twice on the same sandbox — once bare, which is exactly what
# round 14 would have done, and once anchored. A plant whose bare arm goes RED
# is reported as such and fails the gate, because then it is not evidence about
# this round's guard at all; and a plant whose anchored arm passes is the
# fail-open, still open.
anchor_is_loadbearing(){   # anchor_is_loadbearing <id> <setup> <expect>
  local id=$1
  local setup=$2
  local expect=$3
  local sand=$OUT/anchor-$id
  if [ "${#ANCHOR_ARGS[@]}" -eq 0 ]; then
    say "ANCHOR-MUT $id.1: PLANT NOT ESTABLISHED — no anchor was resolved, so this guard is UNMEASURED; failing closed under that name"
    FAILED=1; return
  fi
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  sandbox_marker "$sand"
  ( cd "$sand" && eval "$setup" ) >/dev/null 2>&1
  if [ "$(copied_digest "$REPO/infrastructure/database")" \
     = "$(copied_digest "$sand/infrastructure/database")" ]; then
    say "ANCHOR-MUT $id.2: PLANT NOT ESTABLISHED — the plant did not land; the sandbox is identical to the source, so there is nothing for the guard to refuse; failing closed under that name"
    FAILED=1; return
  fi
  local bare=$sand/bare.log anch=$sand/anchored.log
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only > "$bare" 2>&1; then
    say "ANCHOR-MUT $id.3: bare — the tree is internally consistent and round 14's check PASSES it ($(grep -c . "$bare") lines, exit 0)"
  else
    say "ANCHOR-MUT $id.4: FAIL — the bare arm went RED, so this plant is not evidence about the anchor"
    head -2 "$bare" | tee -a "$OUT/run.log"
    FAILED=1; return
  fi
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" "${ANCHOR_ARGS[@]}" > "$anch" 2>&1; then
    say "ANCHOR-MUT $id.5: FAIL — the ANCHORED arm passed too; the fail-open is still open"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$anch"; then
    say "ANCHOR-MUT $id.6: anchored — refused, and named it — '$expect'"
  else
    say "ANCHOR-MUT $id.7: FAIL — the anchored arm refused, but did not name '$expect'"
    head -2 "$anch" | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

say "=== the plants round 14 called correct (the anchor, measured) ==="
# (m) THE CHALLENGER'S PLANT A: the lowest migration dropped and the whole tail
#     renumbered down by one, rows and boundary carried with it. The challenger's
#     own version of this plant renamed 40 files; this one renames 79, and both
#     pass the round-14 check — the count is not what makes it work, the
#     coordination is.
anchor_is_loadbearing m \
  "python3 -I '$HERE/p8-plant.py' tail-renumber" \
  "the attested boundary has MOVED"
# (n) THE CHALLENGER'S PLANT B: the boundary moved down to the sixth migration
#     with every row above it deleted. 6 files, 6 rows, all matching, and the
#     other 81 files reported as merely beyond the manifest's coverage.
anchor_is_loadbearing n \
  "python3 -I '$HERE/p8-plant.py' boundary-shrink" \
  "the attested boundary has MOVED"
# (o) THE COORDINATOR'S LIMIT CASE: one row, the boundary at 0000. The numbering
#     law round 14 added is SATISFIED by [0], which is the plainest statement of
#     why pinning the low end was necessary but not sufficient.
anchor_is_loadbearing o \
  "python3 -I '$HERE/p8-plant.py' limit-one" \
  "the attested boundary has MOVED"
# (p) THE WHOLE-RECORD FORGERY: a frozen file edited AND its manifest row
#     updated to the edited digest. This is mutant (a) with the record brought
#     along, and it is the case the manifest can never catch, because the
#     manifest is what was forged. Only content read from the pinned commit sees
#     it.
anchor_is_loadbearing p \
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql && python3 -I -c \"import json,hashlib;p='infrastructure/database/MIGRATION_MANIFEST.json';h=hashlib.sha256(open('infrastructure/database/migrations/0006_rls.sql','rb').read()).hexdigest();m=json.load(open(p));m['migrations']=[dict(r,sha256=h) if r['name']=='0006_rls.sql' else r for r in m['migrations']];json.dump(m,open(p,'w'))\"" \
  "ANCHOR DRIFT  0006_rls.sql"
# (q) A COVERED FILE RENAMED IN PLACE, row carried: same number, same bytes, a
#     different name. The numbering law holds, the equality holds, the digests
#     hold, the boundary is where it was — and the claimed figures hold too,
#     because the count and the digest-over-digests are both unchanged. This one
#     is caught by the anchor's FILE LIST and by nothing else in the pack.
anchor_is_loadbearing q \
  "mv infrastructure/database/migrations/0013_security_boundary.sql infrastructure/database/migrations/0013_security_boundaries.sql && python3 -I -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations']=[dict(r,name='0013_security_boundaries.sql') if r['name']=='0013_security_boundary.sql' else r for r in m['migrations']];json.dump(m,open(p,'w'))\"" \
  "NOT IN TREE   0013_security_boundary.sql"

# ---------------------------------------------------------------------
# ROUND 16, N-1": THE ANCHOR'S OWN IDENTITY.
# ---------------------------------------------------------------------
# Round 15 moved the authority out of the tree and onto a commit. The ninth
# challenge found that the commit was whatever the CALLER made `93084f8` mean —
# the fourth appearance of one shape, now one level further out: the quantity
# deciding whether anything is wrong (here, WHICH commit is the witness) was
# supplied by the party being checked. Two routes, both measured by me before
# being fixed:
#
#   1. `refs/replace/93084f82b8…` in the anchor repository redirects exactly the
#      reads the check makes — show, ls-tree, cat-file — while `rev-parse
#      --verify` keeps printing the honest name, so nothing in the log looked
#      wrong. Measured: plant (p)'s forged tree CONFIRMED, "all 80 matching",
#      rc=0.
#   2. The anchor SHA came from an environment variable with a seven-character
#      default, so naming a forged commit needed no git trickery at all.
#      Measured: the same forged tree, rc=0.
#
# The remedies are in `p8-frozen-integrity.py`: every anchor read runs with
# replacement objects disabled (by argument AND by environment), and the pin is
# forty characters inside the check, compared against the SHA `rev-parse`
# RESOLVES — which round 15 computed and threw away. Each plant below carries a
# GUARD-DELETION arm, because a guard is shown to be load-bearing only by a run
# in which it is absent.
anchor_identity(){   # anchor_identity <id> <doctor-the-anchor-clone> <extra-args> <expect>
  local id=$1
  local doctor=$2
  local extra=$3
  local expect=$4
  local work=$OUT/anchorid-$id
  rm -rf "$work"; mkdir -p "$work"
  if [ -z "$P8_ANCHOR_DIR" ]; then
    say "ANCHOR-ID $id.1: PLANT NOT ESTABLISHED — no anchor directory, so this plant is UNMEASURED; failing closed under that name"
    FAILED=1; return
  fi
  # A CLONE of the anchor repository, so the real one is never written to. No
  # frozen migration is touched in any real tree: what is doctored is a ref and a
  # commit inside a throwaway clone.
  if ! git clone -q "$P8_ANCHOR_DIR" "$work/anchor" 2>"$work/clone.log"; then
    say "ANCHOR-ID $id.2: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$work/clone.log"); failing closed under that name"
    FAILED=1; return
  fi
  git -C "$work/anchor" config user.email p8@local >/dev/null 2>&1
  git -C "$work/anchor" config user.name p8 >/dev/null 2>&1
  # The forged commit every plant aims at: the anchor's tree with one frozen file
  # altered, built in the clone.
  git -C "$work/anchor" checkout -q -b p8forge "$P8_ANCHOR_PIN" 2>/dev/null
  printf '\n-- mutant\n' >> "$work/anchor/infrastructure/database/migrations/0006_rls.sql"
  git -C "$work/anchor" commit -q -am "p8 round 16 forge (throwaway clone)" 2>/dev/null
  FORGE=$(git -C "$work/anchor" rev-parse p8forge)
  FORGE_SHORT=$(git -C "$work/anchor" rev-parse --short=7 p8forge)
  # ROUND 19, found by this round's own run: this used to detach HEAD back onto
  # the pin, and the new LINEAGE guard then masked two of these three arms. With
  # HEAD at the pin, the forged commit (s) and (t) NAME is not an ancestor of
  # HEAD, so with the identity guard deleted the lineage guard refused instead —
  # and a deletion arm that still reds is reported as "refused even with this
  # round's guards deleted", which is true and useless. It is this phase's own
  # lesson for the third time: A GUARD IN FRONT OF A GUARD IS EVIDENCE ABOUT THE
  # OUTER ONE. HEAD therefore stays on p8forge, which descends from the pin, so
  # BOTH the pin (r) and the forge (s, t) are ancestors of it and each arm stays
  # evidence about the guard its comment names. The precondition is asserted
  # below rather than left to luck.
  ( cd "$work/anchor" && eval "$doctor" ) >"$work/doctor.log" 2>&1
  # The caller cannot name the forged commit, because it does not exist until the
  # lines above make it, so <extra-args> is a template and is filled in here.
  extra=${extra//@FORGE_SHORT@/$FORGE_SHORT}
  extra=${extra//@FORGE@/$FORGE}
  # ROUND 19: assert what the arms now rest on — the commit this plant will name
  # is an ancestor of the clone's HEAD, so the lineage guard is not what reds it.
  for _anc in "$P8_ANCHOR_PIN" "$FORGE"; do
    if ! git -C "$work/anchor" --no-replace-objects merge-base --is-ancestor "$_anc" HEAD 2>/dev/null; then
      say "ANCHOR-ID $id.3: FAIL — $_anc is not an ancestor of the clone's HEAD, so the lineage guard would decide this arm instead of the guard it names"
      FAILED=1; return
    fi
  done
  # The SUBJECT is a tree built to AGREE with the forgery. That is the only
  # subject that tests the anchor's identity: an honest tree disagrees with the
  # forged content and reds for the wrong reason, which is exactly how round 15's
  # gate went red while the fail-open stood.
  local sand=$work/tree
  mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  sandbox_marker "$sand"
  printf '\n-- mutant\n' >> "$sand/infrastructure/database/migrations/0006_rls.sql"
  python3 -I - "$sand" <<'PLANT'
import hashlib, json, os, sys
root = sys.argv[1]
mp = os.path.join(root, "infrastructure", "database", "MIGRATION_MANIFEST.json")
f = os.path.join(root, "infrastructure", "database", "migrations", "0006_rls.sql")
h = hashlib.sha256(open(f, "rb").read()).hexdigest()
m = json.load(open(mp))
m["migrations"] = [dict(r, sha256=h) if r["name"] == "0006_rls.sql" else r
                   for r in m["migrations"]]
json.dump(m, open(mp, "w"))
PLANT
  # The subject must be a tree the round-15 check calls correct, or the plant is
  # evidence about something else.
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only >"$work/inner.log" 2>&1; then
    say "ANCHOR-ID $id.4: the forged tree is internally consistent, as the plant requires"
  else
    say "ANCHOR-ID $id.5: PLANT NOT ESTABLISHED — the forged tree is not internally consistent ($(head -1 "$work/inner.log")), so it does not reach the anchor at all; failing closed under that name"
    FAILED=1; return
  fi
  local out=$work/guarded.log
  # shellcheck disable=SC2086  # deliberate flag lists
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" --git-dir "$work/anchor" $extra > "$out" 2>&1; then
    say "ANCHOR-ID $id.6: FAIL — the check CONFIRMED a forged tree against a doctored anchor"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$out"; then
    say "ANCHOR-ID $id.7: refused, and named it — '$expect'"
  else
    say "ANCHOR-ID $id.8: FAIL — it refused, but did not name '$expect'"
    head -2 "$out" | tee -a "$OUT/run.log"
    FAILED=1; return
  fi
  # THE GUARD-DELETION ARM: the same plant against a copy of the check with this
  # round's two guards removed. It must PASS. A guard whose absence changes
  # nothing was not the reason the plant was refused.
  local nog=$work/no-guards.py
  local pat=0
  python3 -I - "$HERE/p8-frozen-integrity.py" "$nog" <<'DELETE' || pat=$?
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '    env["GIT_NO_REPLACE_OBJECTS"] = "1"\n'
assert s.count(a) == 1, "the replacement guard is not where this expects it"
s = s.replace(a, "", 1)
a1 = '("git", "--no-replace-objects", "-C", gitdir)'
assert s.count(a1) == 1, "the --no-replace-objects argument is not where this expects it"
s = s.replace(a1, '("git", "-C", gitdir)', 1)
a2 = "        if resolved != ANCHOR_PIN:"
assert s.count(a2) == 1, "the identity comparison is not where this expects it"
s = s.replace(a2, "        if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
DELETE
  # ROUND 17, N-4: the patcher's own exit code. Each of its three asserts fires
  # BEFORE the write, so a patcher that no longer matches the check leaves no
  # file at all — and the arm below then failed on python's "No such file or
  # directory" and reported it as "refused even with the guards deleted", which
  # blames the plant for the apparatus. The same defect class as everything else
  # in this phase: the quantity that decided whether anything was wrong (the
  # arm's exit code) could not tell a measurement from the absence of one.
  if [ "$pat" -ne 0 ] || [ ! -s "$nog" ]; then
    say "ANCHOR-ID $id.9: FAIL — the guard-deletion patcher did not apply (exit $pat), so this arm measured nothing about this round's guards"
    FAILED=1; return
  fi
  # shellcheck disable=SC2086
  if python3 -I "$nog" "$sand" --git-dir "$work/anchor" $extra > "$work/no-guards.log" 2>&1; then
    say "ANCHOR-ID $id.10: guard-deletion arm PASSES, so this round's guard is what refused it"
  else
    say "ANCHOR-ID $id.11: FAIL — refused even with this round's guards deleted ($(head -1 "$work/no-guards.log")), so it is not evidence about them"
    FAILED=1
  fi
}

say "=== the anchor's own identity, measured ==="
# (r) ROUTE ONE: a replace ref in the anchor repository, aimed at the pin itself.
#     No environment change; nothing about it appears in the log.
anchor_identity r \
  'git replace "$P8_ANCHOR_PIN" "$FORGE"' \
  "" \
  "ANCHOR DRIFT  0006_rls.sql"
# (s) ROUTE TWO: the forged commit named directly, which is what the old
#     environment variable bought. The anchor repository is honest here; only the
#     NAME is wrong, which is the whole point.
anchor_identity s \
  'true' \
  "--git-anchor @FORGE@" \
  "ANCHOR IDENTITY"
# (t) THE ABBREVIATION: seven characters of the forged commit. A short SHA names
#     whatever a given repository makes it mean, which is why the pin is forty.
anchor_identity t \
  'true' \
  "--git-anchor @FORGE_SHORT@" \
  "ANCHOR IDENTITY"

# The three claimed figures are the pack's SECOND leg, and weaker: a literal
# travels in the same commit as the change it would catch, which is this
# project's own lesson (P14 B2 — the witness must not be anchored to anything
# one commit can change). They are measured anyway, because a claim that cannot
# fail is not a claim. Each of the three coordinated plants is run once more with
# the figures and no anchor, and must be refused by the falsified figure's name.

say "=== the shape of the check's own arguments, measured ==="
# ROUND 17, N-1-TRIPLE-PRIME. The ninth round moved the anchor's identity out of
# the caller's reach: the pin is forty characters in the check's own source and
# the resolved sha must equal it. The tenth found the leg BELOW that one — WHICH
# ARGUMENTS THE CHECK RECEIVES was still the caller's to choose, and a single
# option-shaped word turned the whole anchor leg off while the gate exited 0.
# That is this phase's defect class at its sixth depth: git's silence, the
# manifest's rows, the directory's length, the boundary name, the anchor commit,
# and now the argv the measurement is asked for.
#
# Four arms. Two must be REFUSED BY NAME, because an injected flag must never
# read as an opt-out. Two must PASS, because a guard that refuses an honest
# caller is a guard nobody can run: a directory whose path contains a space, and
# a run whose environment tries to redirect git underneath it.
ARG_SHAPE_ENV=()
arg_shape(){   # arg_shape <id> <refuse|pass> <expect-text> [args...]
  local id=$1
  local mode=$2
  local expect=$3
  shift 3
  local sand=$OUT/argshape-$id
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  sandbox_marker "$sand"
  # The subject is an HONEST copy, deliberately. What is under test here is the
  # argument shape, not a tree mutation: a planted byte would red for the wrong
  # reason and the arm would stop being evidence about the argv.
  local out=$sand/out.log
  local rc=0
  # ARG_SHAPE_ENV is how an arm names the environment it wants, as an array
  # passed to env(1). An assignment prefix on a FUNCTION call is not reliably
  # scoped to that call in bash, and a subshell would lose FAILED, so the
  # environment travels explicitly.
  env ${ARG_SHAPE_ENV[@]+"${ARG_SHAPE_ENV[@]}"} \
      python3 -I "$HERE/p8-frozen-integrity.py" "$sand" "$@" > "$out" 2>&1 || rc=$?
  if [ "$mode" = refuse ] && [ "$rc" -eq 0 ]; then
    say "ARGSHAPE $id: FAIL — the check exited 0 on an injected argument; first line: $(head -1 "$out")"
    FAILED=1; return
  fi
  if [ "$mode" = pass ] && [ "$rc" -ne 0 ]; then
    say "ARGSHAPE $id: FAIL — the check refused an HONEST caller (rc=$rc): $(head -1 "$out")"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$out"; then
    say "ARGSHAPE $id ($mode, rc=$rc): named it — '$expect'"
  else
    say "ARGSHAPE $id: FAIL — rc=$rc as required, but '$expect' is not in the output"
    head -2 "$out" | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

# (u) The flag AS the directory. This is the attack verbatim: the gate's own
#     opt-out word arriving where a path belongs.
arg_shape u refuse \
  "ARGUMENT INJECTION — --git-dir was given '--inner-guards-only'" \
  --git-dir --inner-guards-only
# (v) The flag ALONGSIDE the directory, which is what word-splitting a path
#     produced. One argument asks for the anchor leg, the other turns it off;
#     preferring the opt-out is how round 16 exited 0 with nothing measured.
if [ -n "$P8_ANCHOR_DIR" ]; then
  arg_shape v refuse \
    "ARGUMENT INJECTION — --inner-guards-only was given" \
    --git-dir "$P8_ANCHOR_DIR" --inner-guards-only
else
  say "ARGSHAPE v: PLANT NOT ESTABLISHED — no anchor directory, so this arm is UNMEASURED; failing closed under that name"; FAILED=1
fi
# (w) THE HONEST SPACED PATH. The quoting fix is only proved by a caller a
#     naive implementation would truncate: this directory's name contains a
#     space, and the run must exercise the anchor leg against it and say so.
# ROUND 20, (y) and (z) — the twelfth challenge's N-8. Round 18 validated the
# argv as a closed vocabulary and left the READER alone, so a value option could
# CONSUME a flag: the parser recorded no flag, the membership test saw one
# anyway, and `--git-anchor --inner-guards-only` turned the anchor leg off at
# exit 0 on a tampered tree. Reproduced before the fix. (y) is the challenger's
# own spelling; (z) is the sibling it named, to show the refusal is keyed on the
# SHAPE of the value and not on one option's name.
arg_shape y refuse \
  "ARGUMENT INJECTION — --git-anchor was given '--inner-guards-only' as its value" \
  --git-anchor --inner-guards-only
arg_shape z refuse \
  "ARGUMENT INJECTION — --expect-covered was given '--inner-guards-only' as its value" \
  --expect-covered --inner-guards-only
if [ -n "$P8_ANCHOR_DIR" ]; then
  SPACED="$OUT/spaced anchor dir"
  rm -rf "$SPACED"; mkdir -p "$SPACED"
  if git clone -q "$P8_ANCHOR_DIR" "$SPACED/anchor" 2>"$OUT/spaced-clone.log"; then
    arg_shape w pass \
      "ANCHOR LEG EXERCISED: pin=$P8_ANCHOR_PIN dir=$SPACED/anchor" \
      --git-dir "$SPACED/anchor"
  else
    say "ARGSHAPE w: PLANT NOT ESTABLISHED — could not clone the anchor into a spaced path: $(tail -1 "$OUT/spaced-clone.log"); failing closed under that name"
    FAILED=1
  fi
else
  say "ARGSHAPE w: PLANT NOT ESTABLISHED — no anchor directory, so this arm is UNMEASURED; failing closed under that name"; FAILED=1
fi
# (x) THE ENVIRONMENT UNDERNEATH. GIT_DIR BEATS -C, measured in this container:
#     with GIT_DIR set to an empty repository, `git -C <anchor> rev-parse
#     --absolute-git-dir` answers with the EMPTY one, and round 16's check then
#     said the anchor commit was unreachable in a repository that demonstrably
#     holds it — a refusal naming a directory it never read. The subprocess
#     environment is scrubbed, so this run must pass and must name the directory
#     it was actually given.
if [ -n "$P8_ANCHOR_DIR" ]; then
  DECOY=$OUT/env-decoy
  rm -rf "$DECOY"; mkdir -p "$DECOY"
  git init -q "$DECOY/empty" 2>/dev/null
  ARG_SHAPE_ENV=(
    "GIT_DIR=$DECOY/empty/.git"
    "GIT_REPLACE_REF_BASE=refs/p8-elsewhere/"
    "GIT_CONFIG_COUNT=1" "GIT_CONFIG_KEY_0=core.useReplaceRefs" "GIT_CONFIG_VALUE_0=true"
  )
  arg_shape x pass \
    "ANCHOR LEG EXERCISED: pin=$P8_ANCHOR_PIN dir=$P8_ANCHOR_DIR" \
    --git-dir "$P8_ANCHOR_DIR"
  ARG_SHAPE_ENV=()
else
  say "ARGSHAPE x: PLANT NOT ESTABLISHED — no anchor directory, so this arm is UNMEASURED; failing closed under that name"; FAILED=1
fi


say "=== the round-17 and round-18 argument guards, measured BY DELETING THEM ==="
# ROUND 18, N-7. The pack's own rule is that a guard whose absence changes
# nothing was not the reason anything was refused, and round 17 shipped three
# new refusals and a token requirement with no deletion control for any of them.
# The challenger supplied all three and found them load-bearing; they are arms
# here now, so the next round measures them without being asked.
#
# Each arm patches a COPY of the check (never the shipped file), asserts on every
# replacement, READS THE PATCHER'S OWN EXIT CODE, and then requires the OLD
# behaviour to come back. An arm whose patcher did not apply says so.
tamper_consistently(){   # tamper_consistently <sandbox-root>
  local sand=$1
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  sandbox_marker "$sand"
  printf '\n-- mutant\n' >> "$sand/infrastructure/database/migrations/0006_rls.sql"
  python3 -I - "$sand" <<'TAMPER'
import hashlib, json, os, sys
root = sys.argv[1]
mp = os.path.join(root, "infrastructure", "database", "MIGRATION_MANIFEST.json")
f = os.path.join(root, "infrastructure", "database", "migrations", "0006_rls.sql")
h = hashlib.sha256(open(f, "rb").read()).hexdigest()
m = json.load(open(mp))
m["migrations"] = [dict(r, sha256=h) if r["name"] == "0006_rls.sql" else r
                   for r in m["migrations"]]
json.dump(m, open(mp, "w"))
TAMPER
}

guard_control(){   # guard_control <id> <patcher> <tampered|honest> <present|absent> <text> [args...]
  local id=$1 patcher=$2 subject=$3 want=$4 text=$5
  shift 5
  local work=$OUT/guardctl-$id
  rm -rf "$work"; mkdir -p "$work"
  local sand=$work/tree
  if [ "$subject" = tampered ]; then
    tamper_consistently "$sand"
  else
    rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
    cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
    cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
    sandbox_marker "$sand"
  fi
  local nog=$work/no-guard.py pat=0
  python3 -I "$patcher" "$HERE/p8-frozen-integrity.py" "$nog" >"$work/patch.log" 2>&1 || pat=$?
  if [ "$pat" -ne 0 ] || [ ! -s "$nog" ]; then
    say "GUARD-CTL $id: PLANT NOT ESTABLISHED — the patcher did not apply (exit $pat: $(tail -1 "$work/patch.log")), so this arm measured nothing; failing closed under that name"
    FAILED=1; return
  fi
  local out=$work/out.log rc=0
  python3 -I "$nog" "$sand" "$@" > "$out" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    say "GUARD-CTL $id: FAIL — with the guard deleted the check still refused (rc=$rc: $(head -1 "$out")), so the refusal this arm credits to the guard came from somewhere else"
    FAILED=1; return
  fi
  if [ "$want" = present ] && grep -qF "$text" "$out"; then
    say "GUARD-CTL $id: with the guard deleted the old fail-open RETURNS (rc 0, '$text'), so the guard is what closes it"
  elif [ "$want" = absent ] && ! grep -qF "$text" "$out"; then
    say "GUARD-CTL $id: with the print deleted '$text' is ABSENT, so requiring it is what makes the leg's claim load-bearing"
  else
    say "GUARD-CTL $id: FAIL — rc 0 as expected, but the output does not show '$text' $want"
    head -2 "$out" | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

PATCHDIR=$OUT/guard-patchers
mkdir -p "$PATCHDIR"
cat > "$PATCHDIR/injection.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
# ROUND 20: round 17's refusal below is now SUBSUMED. The parser refuses an
# option-shaped VALUE for every value option, and it runs first, so
# `--git-dir --inner-guards-only` never reaches the later check. Round 17's line
# is kept as defence in depth for any future caller that reaches `main()`'s body
# another way, and it is therefore UNMEASURED at runtime rather than dead — this
# arm deletes BOTH, because deleting only one leaves the other refusing and the
# arm would credit the wrong guard. Measured: with only the later one deleted,
# y1 reported "the check still refused".
a0 = '            if val.startswith("-"):'
assert s.count(a0) == 1, "the parser's option-shaped value refusal is not where this expects it"
s = s.replace(a0, "            if False:", 1)
a = '    if anchor_dir is not None and anchor_dir.startswith("-"):'
assert s.count(a) == 1, "the option-shaped refusal is not where this expects it"
s = s.replace(a, "    if False:", 1)
# And the reader, for the same reason: with both refusals gone the parser still
# CONSUMES the flag as a value, so `in seen` is false and the check walks the
# anchor path and refuses for a third reason ("not reachable in
# --inner-guards-only"). Measured. Round 18's fail-open — rc 0, ANCHOR LEG NOT
# EXERCISED — comes back only when the reader is also put back on sys.argv, so
# what this arm measures is the THREE together, which is the honest claim.
c = '    inner_only = "--inner-guards-only" in seen'
assert s.count(c) == 1, "the parser-record reader is not where this expects it"
s = s.replace(c, '    inner_only = "--inner-guards-only" in sys.argv', 1)
b = "    if inner_only and anchor_dir is not None:"
assert s.count(b) == 1, "the incoherence refusal is not where this expects it"
s = s.replace(b, "    if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/vocabulary.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
head = "        sys.stderr.write(\"INTEGRITY FAIL: ARGUMENT INJECTION — unrecognised argument"
assert s.count(head) == 1, "the unrecognised-argument refusal is not where this expects it"
i = s.index(head)
tail = "        return 1\n"
j = s.index(tail, i) + len(tail)
s = s[:i] + "        i += 1\n        continue\n" + s[j:]
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/printpin.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '    if argv == ["--print-pin"]:'
assert s.count(a) == 1, "the print-pin mode guard is not where this expects it"
s = s.replace(a, '    if "--print-pin" in argv:', 1)
b = '    if "--print-pin" in argv:\n        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — --print-pin is a MODE'
assert s.count(b) == 1, "the print-pin company refusal is not where this expects it"
s = s.replace(b, '    if False:\n        sys.stderr.write("INTEGRITY FAIL: ARGUMENT INJECTION — --print-pin is a MODE', 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/token.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '        print("ANCHOR LEG EXERCISED: pin=%s dir=%s covered=%d anchored=%d boundary=%s"'
assert s.count(a) == 1, "the pass token is not where this expects it"
s = s.replace(a, '        print("ANCHOR LEG (suppressed by the round-18 control) pin=%s dir=%s covered=%d anchored=%d boundary=%s"', 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH

if [ -n "$P8_ANCHOR_DIR" ]; then
  # (y1) round 17's two injection refusals deleted: the flag AS the path.
  guard_control y1 "$PATCHDIR/injection.py" tampered present \
    "ANCHOR LEG NOT EXERCISED" --git-dir --inner-guards-only
  # (y2) the same, with the flag BESIDE the path.
  guard_control y2 "$PATCHDIR/injection.py" tampered present \
    "ANCHOR LEG NOT EXERCISED" --git-dir "$P8_ANCHOR_DIR" --inner-guards-only
  # (y3) round 18's argument-vocabulary refusal deleted: the `=` spelling the
  #      check does not parse, honoured beside the opt-out it does.
  guard_control y3 "$PATCHDIR/vocabulary.py" tampered present \
    "ANCHOR LEG NOT EXERCISED" "--git-dir=$P8_ANCHOR_DIR" --inner-guards-only
  # (y4) round 18's mode guard reverted to round 17's membership test: the pin
  #      is printed and nothing is verified, on a tampered tree.
  guard_control y4 "$PATCHDIR/printpin.py" tampered present \
    "$P8_ANCHOR_PIN" --git-dir "$P8_ANCHOR_DIR" --expect-covered "$P8_EXPECT_COVERED" --print-pin
  # (y5) the pass token's PRINT deleted, on an HONEST tree: the token the
  #      authoritative run requires is then absent, which is what makes that
  #      requirement evidence rather than decoration.
  guard_control y5 "$PATCHDIR/token.py" honest absent \
    "ANCHOR LEG EXERCISED:" --git-dir "$P8_ANCHOR_DIR"
else
  say "GUARD-CTL: PLANT NOT ESTABLISHED — no anchor directory, so none of these guards is measured; failing closed under that name"
  FAILED=1
fi


say "=== the anchor's LINEAGE, measured ==="
# ROUND 19, the coordinator's fourth follow-up item. Until now the anchor leg
# asked only that the repository CONTAIN the pinned object. A commit can be in a
# repository without being in its history: fetched by sha, left on a deleted
# branch, reachable only from a note or a stash. The check now requires the pin
# to be an ANCESTOR of that repository's HEAD — the relation the phrase "the
# frozen history" actually claims — and the plant below is a repository that
# holds the object and is not descended from it.
#
# What this does NOT close is stated in the check itself and repeated here so no
# reader has to find it: an editor of the pin can make their forged commit an
# ancestor as easily as they made it exist. PATCH-REQ-P8-08 still carries that.
if [ -n "$P8_ANCHOR_DIR" ]; then
  LIN=$OUT/lineage
  rm -rf "$LIN"; mkdir -p "$LIN/tree/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$LIN/tree/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$LIN/tree/infrastructure/database/"
  if ! git clone -q "$P8_ANCHOR_DIR" "$LIN/orphan" 2>"$LIN/clone.log"; then
    say "LINEAGE a1: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$LIN/clone.log"); failing closed under that name"
    FAILED=1
  else
    ( cd "$LIN/orphan" \
      && git config user.email p8@local && git config user.name p8 \
      && git checkout -q --orphan p8-unrelated \
      && git rm -rq --cached . \
      && printf 'unrelated\n' > u.txt && git add u.txt \
      && git commit -q -m "an unrelated root, so the pin is HELD here but not descended from" \
    ) >"$LIN/doctor.log" 2>&1
    # The plant only measures lineage if the OBJECT is still present: a clone
    # that lost it would red for "not reachable", which is a different guard.
    if ! git -C "$LIN/orphan" cat-file -e "${P8_ANCHOR_PIN}^{commit}" 2>/dev/null; then
      say "LINEAGE a2: PLANT NOT ESTABLISHED — the doctored clone no longer holds the pin at all, so this plant would test reachability, not lineage; failing closed under that name"
      FAILED=1
    elif git -C "$LIN/orphan" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
      say "LINEAGE a3: PLANT NOT ESTABLISHED — the doctored clone still descends from the pin, so there is nothing for the lineage guard to refuse; failing closed under that name"
      FAILED=1
    else
      if [ "$(git -C "$LIN/orphan" rev-parse --is-shallow-repository)" = true ]; then
        say "LINEAGE a4: PLANT NOT ESTABLISHED — the plant is SHALLOW, so the completeness guard would decide this arm instead of the lineage guard it names; pass a complete anchor (fetch-depth 0); failing closed under that name"
        FAILED=1
      else
      say "LINEAGE a5: the plant holds the pin as an object and is not descended from it, and is not shallow, as required"
      if python3 -I "$HERE/p8-frozen-integrity.py" "$LIN/tree" --git-dir "$LIN/orphan" >"$LIN/guarded.log" 2>&1; then
        say "LINEAGE a6: FAIL — an HONEST tree was confirmed against a repository that merely HOLDS the pin"
        FAILED=1
      elif grep -qF "ANCHOR LINEAGE" "$LIN/guarded.log"; then
        say "LINEAGE a7: refused, and named it — 'ANCHOR LINEAGE'"
      else
        say "LINEAGE a8: FAIL — it refused, but not by the lineage guard's name"
        head -2 "$LIN/guarded.log" | tee -a "$OUT/run.log"
        FAILED=1
      fi
      # (y6) the deletion arm: with the lineage refusal gone, the same plant must
      # PASS, or the red above was not this guard's doing.
      cat > "$PATCHDIR/lineage.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '        if rc == 1:\n            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE'
assert s.count(a) == 1, "the lineage refusal is not where this expects it"
s = s.replace(a, '        if False:\n            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE', 1)
b = '        if rc != 0:\n            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE — the ancestry'
assert s.count(b) == 1, "the undecided-lineage refusal is not where this expects it"
s = s.replace(b, '        if False:\n            sys.stderr.write("INTEGRITY FAIL: ANCHOR LINEAGE — the ancestry', 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
      guard_control y6 "$PATCHDIR/lineage.py" honest present \
        "ANCHOR LEG EXERCISED:" --git-dir "$LIN/orphan"
      fi
    fi
  fi
else
  say "LINEAGE a9: PLANT NOT ESTABLISHED — no anchor directory, so the lineage guard is UNMEASURED; failing closed under that name"
  FAILED=1
fi

# ---------------------------------------------------------------------
# ROUND 20, N-9 — a definite "no" from a truncated graph is an undecided answer
# ---------------------------------------------------------------------
# `merge-base --is-ancestor` answers from the graph it HAS. A shallow repository
# has a truncated graph, so it returns 1 — git's definite "not an ancestor" —
# for a commit that IS one, and round 19's lineage refusal then said of an
# honest CI checkout that it "happens to hold" the object. The undecided branch
# round 19 wrote could never be reached, because the one genuinely undecidable
# case arrives wearing a decided answer. The plant is built with the recipe
# PATCH-REQ-P8-08 itself used to recommend, and the arm asserts BOTH halves of
# the trap before measuring: the pin present, and the repository shallow.
# ---------------------------------------------------------------------
# ROUND 20, R-B — a grafts file in the witness defeated the lineage check
# ---------------------------------------------------------------------
# Round 16 disabled replacement objects by argument AND by environment. It did
# not disable GRAFTS, the older mechanism that does the same thing to parent
# traversal, is deprecated, and is still honoured. One line in
# `<git-dir>/info/grafts` makes the pin an ancestor of anything, so the
# round-19 lineage guard accepted a repository descended from nothing. The
# content legs still verified, which is why this is P3 and not a blocker — but
# the guard it defeats is the one round 19 was entirely about.
say "=== the anchor's GRAFTS, measured ==="
if [ -n "$P8_ANCHOR_DIR" ]; then
  GRF=$OUT/grafts
  rm -rf "$GRF"; mkdir -p "$GRF"
  if ! git clone -q "$P8_ANCHOR_DIR" "$GRF/repo" 2>"$GRF/clone.log"; then
    say "GRAFTS g1: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$GRF/clone.log"); failing closed under that name"
    FAILED=1
  else
    ( cd "$GRF/repo" \
      && git config user.email p8@local && git config user.name p8 \
      && git config advice.graftFileDeprecated false \
      && git checkout -q --orphan p8-grafted \
      && git rm -rq --cached . \
      && git commit -q --allow-empty -m "unrelated to the frozen history" ) \
      >"$GRF/build.log" 2>&1
    if ! git -C "$GRF/repo" rev-parse --verify -q "${P8_ANCHOR_PIN}^{commit}" >/dev/null; then
      say "GRAFTS g2: PLANT NOT ESTABLISHED — the plant no longer holds the pin, so it would test reachability rather than grafts; failing closed under that name"
      FAILED=1
    elif git -C "$GRF/repo" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
      say "GRAFTS g3: PLANT NOT ESTABLISHED — the plant already descends from the pin before any graft, so the graft would prove nothing; failing closed under that name"
      FAILED=1
    else
      mkdir -p "$GRF/repo/.git/info"
      printf '%s %s\n' "$(git -C "$GRF/repo" rev-parse HEAD)" "$P8_ANCHOR_PIN" \
        > "$GRF/repo/.git/info/grafts"
      if ! git -C "$GRF/repo" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
        say "GRAFTS g4: FAIL — the graft did not take effect in this git, so the plant did not land"
        FAILED=1
      else
        say "GRAFTS g5: the plant is grafted — plain git now calls the pin an ancestor of an unrelated history, as required"
        gout=$GRF/out.log; grc=0
        python3 -I "$HERE/p8-frozen-integrity.py" "$REPO" --git-dir "$GRF/repo" >"$gout" 2>&1 || grc=$?
        if [ "$grc" -eq 0 ]; then
          say "GRAFTS g6: FAIL — a grafted witness was accepted (rc 0), so the lineage guard reads the graft file"
          FAILED=1
        elif grep -qF "ANCHOR LINEAGE" "$gout"; then
          say "GRAFTS g7: refused, and named it — 'ANCHOR LINEAGE', so the graft file does not reach this check"
        else
          say "GRAFTS g8: FAIL — it refused (rc=$grc) but not by the lineage guard's name: $(head -1 "$gout")"
          FAILED=1
        fi
        # y10 — the scrub measured BY DELETING IT. With GIT_GRAFT_FILE gone the
        # grafted witness is accepted again at rc 0, which is the fail-open R-B
        # names.
        cat > "$PATCHDIR/graftfile.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '    env["GIT_GRAFT_FILE"] = os.devnull'
assert s.count(a) == 1, "the graft-file scrub is not where this expects it"
s = s.replace(a, "    pass", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
        nog=$GRF/no-scrub.py; pat=0
        python3 -I "$PATCHDIR/graftfile.py" "$HERE/p8-frozen-integrity.py" "$nog" >"$GRF/patch.log" 2>&1 || pat=$?
        if [ "$pat" -ne 0 ] || [ ! -s "$nog" ]; then
          say "GUARD-CTL y10: PLANT NOT ESTABLISHED — the patcher did not apply (exit $pat: $(tail -1 "$GRF/patch.log")); failing closed under that name"
          FAILED=1
        else
          yout=$GRF/y10.log; yrc=0
          python3 -I "$nog" "$REPO" --git-dir "$GRF/repo" >"$yout" 2>&1 || yrc=$?
          if [ "$yrc" -eq 0 ] && grep -qF "ANCHOR LEG EXERCISED:" "$yout"; then
            say "GUARD-CTL y10: with the graft-file scrub deleted the grafted witness is ACCEPTED again (rc 0, 'ANCHOR LEG EXERCISED:'), so the scrub is what closes it"
          else
            say "GUARD-CTL y10: FAIL — with the scrub deleted the grafted witness was still refused (rc $yrc: $(head -1 "$yout")), so this arm credits the scrub with something else"
            FAILED=1
          fi
        fi
      fi
    fi
  fi
else
  say "GRAFTS g9: PLANT NOT ESTABLISHED — no anchor directory, so the graft scrub is UNMEASURED; failing closed under that name"
  FAILED=1
fi

say "=== the anchor's COMPLETENESS, measured ==="
# ROUND 21, N-13 — THE ROUND-13 BLOCKER, AND IT WAS THIS PLANT.
#
# Round 20 built the trap by `clone --depth 1` of the anchor and then fetching
# the pin. That lands only when the anchor's HEAD is a STRICT descendant of the
# pin. The independent challenger's authoritative anchor is a full clone of the
# Phase 4 line whose HEAD *is* the pin — so the shallow clone's HEAD was the pin
# itself, `merge-base --is-ancestor <pin> HEAD` answered 0 (a commit is its own
# ancestor; no truncation involved, so this round's own rule says that YES is
# sound), the check correctly accepted and printed the token, and the ARM then
# said "an answer computed from a truncated graph was accepted". The guard was
# right and the arm called it broken. Reproduced here before any change, with an
# anchor detached onto the pin: shallow true, pin present, is-ancestor 0.
#
# Two things were wrong, and the coordinator's ruling generalises the second to
# every plant in this file:
#   (1) the trap was not BUILT so that it could exist. A descendant must exist
#       BEFORE the shallow clone is taken. Committing on top of the shallow
#       clone does NOT work — the pin becomes HEAD's visible parent and the
#       answer is YES again; measured, as the challenger said it would be.
#   (2) the arm asserted "holds the pin" and "is shallow" and NOT the one thing
#       its verdict depends on: that the ancestry answer there is NEGATIVE. A
#       plant that does not assert the answer it traps reports the guard as
#       broken.
#
# So: every precondition is asserted, and a precondition that does not hold is
# reported as PLANT NOT ESTABLISHED — a named state of its own, never as a guard
# failure — and still fails closed under that name.
if [ -n "$P8_ANCHOR_DIR" ]; then
  SHAL=$OUT/shallow
  rm -rf "$SHAL"; mkdir -p "$SHAL"
  if ! git clone -q "$P8_ANCHOR_DIR" "$SHAL/full" 2>"$SHAL/clone.log"; then
    say "SHALLOW s1: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$SHAL/clone.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git -C "$SHAL/full" -c user.email=p8@local -c user.name=p8 \
         commit -q --allow-empty -m "a descendant, so the trap can exist" 2>"$SHAL/commit.log"; then
    say "SHALLOW s2: PLANT NOT ESTABLISHED — could not create a descendant of the anchor's HEAD: $(tail -1 "$SHAL/commit.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git clone -q --depth 1 "file://$SHAL/full" "$SHAL/repo" 2>"$SHAL/shclone.log"; then
    say "SHALLOW s3: PLANT NOT ESTABLISHED — could not make a shallow clone: $(tail -1 "$SHAL/shclone.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git -C "$SHAL/repo" fetch -q --depth 1 origin "$P8_ANCHOR_PIN" 2>"$SHAL/fetch.log"; then
    say "SHALLOW s4: PLANT NOT ESTABLISHED — could not fetch the pin into the shallow clone: $(tail -1 "$SHAL/fetch.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git -C "$SHAL/repo" rev-parse --verify -q "${P8_ANCHOR_PIN}^{commit}" >/dev/null; then
    say "SHALLOW s5: PLANT NOT ESTABLISHED — the shallow clone does not hold the pin, so it would test absence rather than shallowness; UNMEASURED, failing closed"
    FAILED=1
  elif [ "$(git -C "$SHAL/repo" rev-parse --is-shallow-repository)" != true ]; then
    say "SHALLOW s6: PLANT NOT ESTABLISHED — the clone is not shallow; UNMEASURED, failing closed"
    FAILED=1
  # THE assertion round 20 was missing: the trap exists only if plain git, in
  # that clone, answers NEGATIVELY. Where it answers 0 the guard has nothing to
  # refuse and its acceptance is correct.
  elif git -C "$SHAL/repo" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
    say "SHALLOW s7: PLANT NOT ESTABLISHED — plain git calls the pin an ancestor in the shallow clone, so there is no truncated NO to trap and nothing here is evidence about the completeness guard; UNMEASURED, failing closed. (This is the round-13 blocker: with an anchor whose HEAD *is* the pin, round 20 reached this state and blamed the guard instead.)"
    FAILED=1
  else
    say "SHALLOW s8: the plant holds the pin, is shallow, and plain git answers NEGATIVELY there — all three asserted, as required"
    sout=$SHAL/out.log; src=0
    python3 -I "$HERE/p8-frozen-integrity.py" "$REPO" --git-dir "$SHAL/repo" >"$sout" 2>&1 || src=$?
    if [ "$src" -eq 0 ]; then
      say "SHALLOW s9: FAIL — an answer computed from a truncated graph was accepted (rc 0)"
      FAILED=1
    elif ! grep -qF "that repository is SHALLOW" "$sout"; then
      say "SHALLOW s10: FAIL — it refused (rc=$src) but did not name shallowness: $(head -1 "$sout")"
      FAILED=1
    elif grep -qF "happens to hold rather than a commit this code descends from" "$sout"; then
      say "SHALLOW s11: FAIL — it still says the repository merely HOLDS the pin, which is the false sentence round 20 removed"
      FAILED=1
    else
      say "SHALLOW s12: refused, and named it — 'that repository is SHALLOW', without the false 'happens to hold' sentence"
    fi

    # y9 — the probe measured BY DELETING IT. This one does not restore a
    # fail-open: it restores a measured-FALSE refusal, which is the mirror image
    # and is why it has its own arm rather than guard_control's shape.
    cat > "$PATCHDIR/shallowprobe.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = "        if shallow and rc != 0:"
assert s.count(a) == 1, "the shallow routing is not where this expects it"
s = s.replace(a, "        if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
    nog=$SHAL/no-probe.py; pat=0
    python3 -I "$PATCHDIR/shallowprobe.py" "$HERE/p8-frozen-integrity.py" "$nog" >"$SHAL/patch.log" 2>&1 || pat=$?
    if [ "$pat" -ne 0 ] || [ ! -s "$nog" ]; then
      say "GUARD-CTL y9: PLANT NOT ESTABLISHED — the patcher did not apply (exit $pat: $(tail -1 "$SHAL/patch.log")); UNMEASURED, failing closed"
      FAILED=1
    else
      yout=$SHAL/y9.log; yrc=0
      python3 -I "$nog" "$REPO" --git-dir "$SHAL/repo" >"$yout" 2>&1 || yrc=$?
      if grep -qF "happens to hold rather than a commit this code descends from" "$yout"; then
        say "GUARD-CTL y9: with the routing deleted the FALSE sentence returns (rc $yrc, 'happens to hold'), so the routing is what makes the refusal true"
      else
        say "GUARD-CTL y9: FAIL — with the routing deleted the old false sentence did not return (rc $yrc: $(head -1 "$yout")), so this arm credits it with something else"
        FAILED=1
      fi
    fi

    # ROUND 21, y11 — N-14's three-state read, measured by breaking the PROBE
    # rather than the routing. With the probe made to return a non-answer, the
    # check must say UNDECIDED and must NOT assert that the repository is
    # complete. Before this round it read the non-answer as "not shallow" and
    # printed round 19's sentence with a parenthetical asserting exactly what
    # the probe had failed to establish.
    cat > "$PATCHDIR/probeanswer.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '        shallow_said = shallow_out.decode("utf-8", "replace").strip()'
assert s.count(a) == 1, "the probe's answer is not read where this expects it"
s = s.replace(a, a + '\n        shallow_said = "--is-shallow-repository"', 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
    nob=$SHAL/no-answer.py; pat2=0
    python3 -I "$PATCHDIR/probeanswer.py" "$HERE/p8-frozen-integrity.py" "$nob" >"$SHAL/patch2.log" 2>&1 || pat2=$?
    if [ "$pat2" -ne 0 ] || [ ! -s "$nob" ]; then
      say "GUARD-CTL y11: PLANT NOT ESTABLISHED — the patcher did not apply (exit $pat2: $(tail -1 "$SHAL/patch2.log")); UNMEASURED, failing closed"
      FAILED=1
    else
      bout=$SHAL/y11.log; brc=0
      python3 -I "$nob" "$REPO" --git-dir "$SHAL/repo" >"$bout" 2>&1 || brc=$?
      if [ "$brc" -eq 0 ]; then
        say "GUARD-CTL y11: FAIL — with the probe answering nothing the check still PASSED (rc 0), so a non-answer is being read as an answer"
        FAILED=1
      elif grep -qF "ANCHOR COMPLETENESS" "$bout"; then
        say "GUARD-CTL y11: a non-answer from the probe is refused as UNDECIDED and named — 'ANCHOR COMPLETENESS' (rc $brc), so absence is not read as 'not shallow'"
      else
        say "GUARD-CTL y11: FAIL — it refused (rc $brc) but not as an undecided probe: $(head -1 "$bout")"
        FAILED=1
      fi
    fi
  fi
else
  say "SHALLOW s13: PLANT NOT ESTABLISHED — no anchor directory, so the completeness guard is UNMEASURED; failing closed under that name"
  FAILED=1
fi

# ---------------------------------------------------------------------
# ROUND 20, N-8 — the pair that closes the consumed-flag hole, measured
# ---------------------------------------------------------------------
# N-8 is closed TWICE over: the parser refuses an option-shaped value for every
# value option, and the reader reads the parser's record instead of sys.argv.
# Either half alone refuses the attack, so an arm that deletes one and finds the
# other still refusing cannot use "the old fail-open returns". y8 therefore
# deletes BOTH and requires the round-18 behaviour back, which is the
# conservative claim: the PAIR is what closes it.
cat > "$PATCHDIR/consumedvalue.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = '            if val.startswith("-"):'
assert s.count(a) == 1, "the option-shaped value refusal is not where this expects it"
s = s.replace(a, "            if False:", 1)
b = '    inner_only = "--inner-guards-only" in seen'
assert s.count(b) == 1, "the parser-record reader is not where this expects it"
s = s.replace(b, '    inner_only = "--inner-guards-only" in sys.argv', 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
guard_control y8 "$PATCHDIR/consumedvalue.py" tampered present \
  "ANCHOR LEG NOT EXERCISED" --git-anchor --inner-guards-only

# ---------------------------------------------------------------------
# ROUND 20, N-12 — the token REQUIREMENT, measured through the runner
# ---------------------------------------------------------------------
# y5 deletes the token `print` and asserts the string is absent from the
# patched check's own output. That measures the PRODUCER. What this pack relies
# on is the consumer: the runner's `grep -qF "$WANT_TOKEN"`. No arm removed the
# token and then ran the GATE, so the requirement was load-bearing and
# undemonstrated — the challenger supplied the missing control itself. y7 is
# that control, inside the pack.
#
# It runs a COPY of this runner against a COPY of the check whose token print is
# renamed. Three things make that honest rather than circular: the copy sits at
# the same depth as the original so its own `REPO=$HERE/../../..` resolves to a
# tree holding the REAL migrations; the copy's own mutant and arm sections are
# CUT at the sentinels, so this arm neither recurses into itself nor re-runs
# work already measured; and the patcher asserts every anchor it replaces, so a
# patcher that no longer matches is reported as such instead of being credited
# with a red.
say "=== the token requirement, measured through the RUNNER ==="
if [ -n "$P8_ANCHOR_DIR" ]; then
  Y7=$OUT/y7
  rm -rf "$Y7"; mkdir -p "$Y7/repo/packages/notifications"
  # A symlink farm, not a copy: every top-level entry of the real repository is
  # linked in, so the copy's own `REPO=$HERE/../../..` resolves to a tree that
  # holds the REAL migrations, the REAL applier (apps/api/src/infra/migrate.ts)
  # and the REAL node_modules. Only `proof` is a true copy, because only the
  # check inside it is patched. Measured the hard way twice: without
  # node_modules the copy aborted on a missing tsx, and without apps/ the
  # project applier failed.
  # `*` does not match a dotfile, so each level is swept twice: once for the
  # visible entries and once for `.[!.]*` (which excludes `.` and `..`, and
  # expands to itself when nothing matches, hence the -e test). `.git` is the
  # one deliberate omission: a symlink to it would let a git write inside the
  # copy mutate the REAL repository, which this pack may never do.
  _farm(){   # _farm <source dir> <dest dir> <basename to skip>
    local _src=$1 _dst=$2 _skip=$3 _e _b
    for _e in "$_src"/* "$_src"/.[!.]*; do
      [ -e "$_e" ] || continue
      _b=$(basename "$_e")
      [ "$_b" = "$_skip" ] && continue
      [ "$_b" = .git ] && continue
      ln -s "$_e" "$_dst/$_b"
    done
  }
  _farm "$REPO" "$Y7/repo" packages
  _farm "$REPO/packages" "$Y7/repo/packages" notifications
  _farm "$REPO/packages/notifications" "$Y7/repo/packages/notifications" proof
  cp -r "$HERE" "$Y7/repo/packages/notifications/proof"
  cat > "$PATCHDIR/notoken.py" <<'PATCH'
import sys
chk, run = sys.argv[1], sys.argv[2]
s = open(chk, encoding="utf-8").read()
a = 'print("ANCHOR LEG EXERCISED: pin=%s dir=%s covered=%d anchored=%d boundary=%s"'
assert s.count(a) == 1, "the token print is not where this expects it"
s = s.replace(a, 'print("ANCHOR LEG WAS HERE: pin=%s dir=%s covered=%d anchored=%d boundary=%s"', 1)
open(chk, "w", encoding="utf-8").write(s)
r = open(run, encoding="utf-8").read()
# The sentinel strings are built here rather than written out, because a
# literal copy of one in this patcher would itself be an occurrence in the file
# the patcher counts — which is how the first version of this arm reported "a
# cut sentinel is missing" about sentinels that were present twice.
_S = "# <<< P8-Y7-CUT-"
for lo, hi in ((_S + "BEGIN-A >>>", _S + "END-A >>>"),
               (_S + "BEGIN-B >>>", _S + "END-B >>>")):
    assert r.count(lo) == 1 and r.count(hi) == 1, "a cut sentinel is missing: %s" % lo
    i, j = r.index(lo), r.index(hi)
    assert i < j, "the cut sentinels are out of order: %s" % lo
    r = r[:i] + r[j + len(hi):]
assert "GUARD-CTL y7" not in r and "=== the token requirement" not in r, \
    "the copy still contains this arm, so it would recurse"
open(run, "w", encoding="utf-8").write(r)
PATCH
  pat=0
  python3 -I "$PATCHDIR/notoken.py" \
    "$Y7/repo/packages/notifications/proof/p8-frozen-integrity.py" \
    "$Y7/repo/packages/notifications/proof/run-p8-real-proof.sh" \
    >"$Y7/patch.log" 2>&1 || pat=$?
  if [ "$pat" -ne 0 ]; then
    say "GUARD-CTL y7: PLANT NOT ESTABLISHED — the patcher did not apply (exit $pat: $(tail -1 "$Y7/patch.log")); failing closed under that name"
    FAILED=1
  else
    y7rc=0
    RUN_ID="$RUN-Y7" bash "$Y7/repo/packages/notifications/proof/run-p8-real-proof.sh" \
      >"$Y7/run.log" 2>&1 || y7rc=$?
    if [ "$y7rc" -eq 0 ]; then
      say "GUARD-CTL y7: FAIL — with the token removed the GATE still passed (rc 0), so the runner's requirement is not what makes the leg's claim load-bearing"
      FAILED=1
    elif grep -qF "never said it exercised the anchor leg" "$Y7/run.log"; then
      say "GUARD-CTL y7: with the token removed the RUNNER reds by name (rc $y7rc, 'never said it exercised the anchor leg'), so the requirement — not the print — is what carries the claim"
    else
      say "GUARD-CTL y7: FAIL — the gate red (rc $y7rc) but not by the token requirement's name, so this arm credits it with someone else's refusal"
      FAILED=1
    fi
  fi
else
  say "GUARD-CTL y7: PLANT NOT ESTABLISHED — no anchor directory, so the token requirement is UNMEASURED; failing closed under that name"
  FAILED=1
fi

say "=== the claimed figures, measured (the weaker leg) ==="
integrity_must_refuse m2 \
  "python3 -I '$HERE/p8-plant.py' tail-renumber" \
  "COVERED COUNT  expected 80, measured 79" "${CLAIM_ARGS[@]}"
integrity_must_refuse n2 \
  "python3 -I '$HERE/p8-plant.py' boundary-shrink" \
  "COVERED COUNT  expected 80, measured 6" "${CLAIM_ARGS[@]}"
integrity_must_refuse o2 \
  "python3 -I '$HERE/p8-plant.py' limit-one" \
  "COVERED COUNT  expected 80, measured 1" "${CLAIM_ARGS[@]}"

# git is still consulted WHERE THERE IS A WORK TREE, as a second opinion on the
# files that are beyond the manifest's coverage. Its exit code is read, and where
# there is no work tree that is reported rather than passed.
#
# ROUND 13, S-2: this comment used to call that set "Phase 4's unsealed range".
# It is not. The manifest's attested range ALREADY INCLUDES six Phase 4 files
# (0074…0079) while Phase 4 is unmerged with its PR open, so the manifest
# attests BYTES against a record and says nothing about sealing. Where the
# sealing boundary lies is the Migration Owner's to state, not this runner's.
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  GIT_OUT=$(git -C "$REPO" status --porcelain -- infrastructure/database/migrations 2>&1)
  GIT_RC=$?
  if [ "$GIT_RC" -ne 0 ]; then
    say "FAIL: git status failed with rc=$GIT_RC in a tree that reports a git dir: $GIT_OUT"; FAILED=1
  elif [ -n "$GIT_OUT" ]; then
    say "FAIL: git reports a modified migration: $GIT_OUT"; FAILED=1
  else
    say "git agrees: no migration is modified in this work tree"
  fi
else
  say "no git work tree here, so git is not consulted — the manifest check above is what attests (this is the case round 11 silently passed)"
fi

# <<< P8-Y7-CUT-END-B >>>
# ---------------------------------------------------------------------
# 4  Rebuild the baseline, so the cluster is left in the proved state
# ---------------------------------------------------------------------
build "$HERE/p8-overlay.sql" "$OUT/final" >/dev/null && cases "$OUT/final" \
  && say "cluster left at the baseline, passes=$(cat "$OUT/final/passes")" \
  || { say "FAIL: could not restore the baseline"; FAILED=1; }

say "=== a refusal must have a SUBJECT, and the zero-row hatch must be armed (round 27, S-5) ==="
# S-5 (P2), measured by the sixteenth challenger on `787aa11`. It pointed `W-2`
# — the worker may not rewrite the obligation key — at a uuid no fixture
# creates, and the case PASSED: rc 0, `passes=98`, the figure a clean run
# prints. The reason is NOT the permits vacuity in another costume. The
# column-scoped GRANT refuses the statement before any row is read, so
# `permission denied` arrives whether the row is there or not, and `ROW_COUNT`
# is the wrong instrument because a REFUSED statement affects zero rows by
# construction — a row-count check on `case_refuses` would red every refuses
# case in the pack. And it is worse than the permits hole in one way: a vacuous
# permits-case leaves a row unmoved, which is readable, and is exactly what the
# read-backs read; a vacuous refuses-case has nothing to read back, because the
# statement is SUPPOSED to have no effect.
#
# So the guard is a WITNESS, declared by the case and asserted BEFORE the
# statement: see `p8-case-helpers.sql`. Which cases need one is derived from the
# case's own expectation rather than from a list — a case expecting a PERMISSION
# denial must call the four-argument form, and the three-argument form refuses
# it by name. These arms measure both halves.
cat > "$PATCHDIR/neuter-refuses.py" <<'PATCH'
import re
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
DEAD = "0fffffff-0000-4000-8000-00000000dead"
s = open(src, encoding="utf-8").read()
i = s.find("case_refuses_row('" + label)
assert i >= 0, "no case_refuses_row whose label starts " + label
# The whole call: from the label to the `);` that closes it. Both the statement
# and the witness live inside, and BOTH are pointed away — which is the
# challenger's own method, and the only way the witness can be false.
j = s.index(");", i)
call = s[i:j]
uuid = re.compile(r"'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'")
found = uuid.findall(call)
assert found, "this case names no uuid to point elsewhere"
patched = uuid.sub("'" + DEAD + "'", call)
out = s[:i] + patched + s[j:]
assert out != s
open(dst, "w", encoding="utf-8").write(out)
PATCH
cat > "$PATCHDIR/drop-witness-check.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
# ROUND 29: the witness is DERIVED now, and the condition that reds a case
# whose subject is not there is `n < 1` inside `assert_witness`.
b = "  IF n < 1 THEN"
assert s.count(b) == 1, "the witness check is not where this patcher expects it"
s = s.replace(b, "  IF false THEN", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH

WIT=$OUT/witness
mkdir -p "$WIT"
if python3 -I "$PATCHDIR/neuter-refuses.py" "$HERE/p8-real-cases-worker.sql" \
        "$WIT/p8-real-cases-worker.sql" "W-2 may NOT rewrite" >"$WIT/patch.log" 2>&1; then
  cases "$WIT" "$WIT" >/dev/null 2>&1
  if grep -hqF "FAIL: NO SUBJECT" "$WIT"/*.sql.log 2>/dev/null; then
    say "WITNESS w2: with 'W-2' and its witness pointed at a row that does not exist the case REDS BY NAME (FAIL: NO SUBJECT), so the refusal is no longer evidence about an empty set — the exact case the sixteenth challenge passed at rc 0"
  else
    say "WITNESS w2: FAIL — W-2 pointed at a row that does not exist did not red by NO SUBJECT, which is S-5 unfixed"
    grep -h "PASS\|FAIL" "$WIT"/*.sql.log 2>/dev/null | grep "W-2" | head -2 | tee -a "$OUT/run.log"
    FAILED=1
  fi
else
  say "WITNESS w2: PLANT NOT ESTABLISHED — W-2 could not be pointed elsewhere: $(tail -1 "$WIT/patch.log")"
  FAILED=1
fi

# The attribution: the witness check deleted ALONE must bring the vacuous pass
# back, at the clean figure, which is what the challenger measured.
WC=$OUT/witness-ctl
mkdir -p "$WC"
if python3 -I "$PATCHDIR/drop-witness-check.py" "$HERE/p8-case-helpers.sql" "$WC/p8-case-helpers.sql" >"$WC/patch.log" 2>&1 \
   && ! cmp -s "$HERE/p8-case-helpers.sql" "$WC/p8-case-helpers.sql" \
   && cp "$WIT/p8-real-cases-worker.sql" "$WC/p8-real-cases-worker.sql"; then
  CASE_HELPERS=$WC/p8-case-helpers.sql
  if build "$HERE/p8-overlay.sql" "$WC/build" >/dev/null 2>&1; then
    if cases "$WC" "$WC" >/dev/null 2>&1; then
      say "WITNESS-CTL: with the witness check deleted ALONE the neutered 'W-2' PASSES again (passes=$(cat "$WC/passes")) — the vacuous pass of 787aa11 returns, so the witness is what closes it"
    else
      say "WITNESS-CTL: FAIL — with the witness check deleted the neutered W-2 still reddened, so the arm above is measuring something else"
      grep -h "FAIL" "$WC"/*.sql.log 2>/dev/null | head -2 | tee -a "$OUT/run.log"
      FAILED=1
    fi
  else
    say "WITNESS-CTL: PLANT NOT ESTABLISHED — the build with the patched helpers did not come up"
    FAILED=1
  fi
  CASE_HELPERS=$HERE/p8-case-helpers.sql
  build "$HERE/p8-overlay.sql" "$OUT/final-3" >/dev/null && cases "$OUT/final-3" >/dev/null \
    || { say "FAIL: could not restore the baseline after the witness control"; FAILED=1; }
else
  say "WITNESS-CTL: PLANT NOT ESTABLISHED — the witness check could not be deleted from a copy of the helpers"
  FAILED=1
fi

# And the three-argument form must REFUSE a permission-denial case, because that
# is what makes the discipline fail closed for a case written tomorrow rather
# than for the seven that exist today.
cat > "$WIT/unwitnessed.sql" <<'SQL'
SET search_path = p8, public;
BEGIN;
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';
SELECT p8.case_refuses('HATCH-A a permission case with no witness',
                       'SELECT count(*) FROM notification_provider_quarantine',
                       'permission denied for table notification_provider_quarantine');
ROLLBACK;
SQL
if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -v ON_ERROR_STOP=1 \
             -f "$WIT/unwitnessed.sql" >"$WIT/unwitnessed.log" 2>&1; then
  say "WITNESS unwitnessed: FAIL — a case expecting a PERMISSION denial was accepted by the three-argument form, so a case written tomorrow can still measure an empty set"
  FAILED=1
elif grep -qF "WITNESS REQUIRED" "$WIT/unwitnessed.log"; then
  say "WITNESS unwitnessed: the three-argument form REFUSES a permission-denial case by name (WITNESS REQUIRED), so the discipline is derived from the case's own expectation and not from a list that must name cases in advance"
else
  say "WITNESS unwitnessed: FAIL — it refused, but not by WITNESS REQUIRED"
  head -2 "$WIT/unwitnessed.log" | tee -a "$OUT/run.log"; FAILED=1
fi

# ROUND 28, T-2. The obligation above was derived from the case's own
# EXPECTATION, and the eighteenth challenge measured what that derivation
# actually read: the author's prose. `denied for table notifications` is a true
# substring of the real message, carries SQLSTATE 42501, and does not contain
# the phrase the test looked for — so the three-argument form accepted it,
# pointed at a dead uuid, at `passes=98`. It is now derived from the refusal
# that ARRIVES, which the server spells and the case cannot.
cat > "$PATCHDIR/drop-sqlstate-check.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = ("    IF NOT witnessed AND sst = '42501'\n"
     "       AND position('row-level security policy' in lower(coalesce(msg,''))) = 0 THEN")
assert s.count(b) == 1, "the SQLSTATE derivation is not where this patcher expects it"
# BOTH lines of the condition, or the continuation is left dangling and the
# helper file stops parsing — which is how this control reported PLANT NOT
# ESTABLISHED on its first run instead of a measurement.
s = s.replace(b, "    IF false THEN", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
WS=$OUT/witness-sqlstate
mkdir -p "$WS"
cat > "$WS/probe.sql" <<'SQL'
SET search_path = p8, public;
BEGIN;
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';
-- The challenger's own case, verbatim in shape: the three-argument form, a
-- permission refusal spelled WITHOUT the phrase the prose test reads, and the
-- row pointed at a uuid no fixture creates.
SELECT p8.case_refuses('T2-a W-2 spelled around the prose test', $q$
  UPDATE notifications SET obligation_key = 'B1|rewritten'
   WHERE id = '0fffffff-dead-4000-8000-00000000dead'
$q$, 'denied for table notifications');
ROLLBACK;
SQL
if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
             -f "$WS/probe.sql" >"$WS/probe.log" 2>&1; then
  say "WITNESS-SQLSTATE: FAIL — a permission refusal spelled around the prose test was ACCEPTED against a row that does not exist, which is T-2 unfixed"
  FAILED=1
elif grep -qF "WITNESS REQUIRED" "$WS/probe.log" \
     && grep -qF "SQLSTATE 42501" "$WS/probe.log"; then
  say "WITNESS-SQLSTATE: a permission refusal spelled around the prose test is REFUSED, and the message names SQLSTATE 42501 as what obliged it — a string only the arriving-refusal branch can print, so this arm reads the derivation and not the label (the y20d lesson, applied to the guard the same challenger found next)"
else
  say "WITNESS-SQLSTATE: FAIL — it refused, but not by WITNESS REQUIRED naming SQLSTATE 42501"
  head -2 "$WS/probe.log" | tee -a "$OUT/run.log"; FAILED=1
fi

# The attribution: the SQLSTATE derivation deleted ALONE must bring the
# challenger's acceptance back. The patched helpers are loaded over the live
# baseline — ONE deletion, nothing else touched — and the real file is loaded
# back immediately afterwards WITH the guard re-measured, because a control that
# leaves the subject patched has moved the baseline every later arm reads.
if python3 -I "$PATCHDIR/drop-sqlstate-check.py" "$HERE/p8-case-helpers.sql" "$WS/p8-case-helpers.sql" >"$WS/patch.log" 2>&1 \
   && ! cmp -s "$HERE/p8-case-helpers.sql" "$WS/p8-case-helpers.sql" \
   && "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 -f "$WS/p8-case-helpers.sql" >"$WS/load.log" 2>&1; then
  if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
               -f "$WS/probe.sql" >"$WS/ctl.log" 2>&1; then
    say "WITNESS-SQLSTATE-CTL: with the SQLSTATE derivation deleted ALONE the same case PASSES again — the acceptance of 787aa11 returns through a spelling the prose test never covered, so that one condition is what closes T-2"
  else
    say "WITNESS-SQLSTATE-CTL: FAIL — with the derivation deleted the case still reddened, so the arm above is measuring something else"
    head -2 "$WS/ctl.log" | tee -a "$OUT/run.log"; FAILED=1
  fi
  if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 -f "$HERE/p8-case-helpers.sql" >"$WS/restore.log" 2>&1; then
    if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
                 -f "$WS/probe.sql" >"$WS/verify.log" 2>&1 \
       || ! grep -qF "SQLSTATE 42501" "$WS/verify.log"; then
      say "FAIL: the real case helpers were loaded back after the T-2 control but the derivation did not come back with them, so every later case ran against a patched helper"
      FAILED=1
    fi
  else
    say "FAIL: the real case helpers could not be loaded back after the T-2 control — $(tail -1 "$WS/restore.log")"
    FAILED=1
  fi
else
  say "WITNESS-SQLSTATE-CTL: PLANT NOT ESTABLISHED — the SQLSTATE derivation could not be deleted from a copy of the helpers: $(tail -1 "$WS/patch.log")"
  FAILED=1
fi

# ROUND 28, F-B. The witness used to be a free expression beside the statement.
# The coordinator moved ONLY the statement's uuid and `W-2` passed at 98, with
# the witness still true of a row the statement no longer read; round 27's arm
# could not see it because it retargets both halves together. The subject is now
# ONE value substituted into both, and these arms measure the divergence that
# form is supposed to make unwritable.
# ---------------------------------------------------------------------
# THE WITNESS LAW, armed one condition at a time (round 29)
# ---------------------------------------------------------------------
# Round 28 gave `case_refuses` a witness and a subject and required the text of
# each to mention the other. Two reviewers broke that three ways in one round
# (U-2 a witness that reads nothing, U-3 a subject satisfied by a comment, N-2 a
# row case re-declared as a relation case), and all three were the same thing:
# the witness and the statement were two texts that could be moved apart. So the
# witness is DERIVED in the helpers now, and there are three forms instead of
# one. Each condition of each form gets an arm and a deletion control here,
# because a condition nobody deletes is a condition nobody has measured.
WB=$OUT/witness-law
rm -rf "$WB"; mkdir -p "$WB"
wb_head(){ cat <<'SQL'
SET search_path = p8, public;
BEGIN;
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';
SQL
}
# (1) U-3, read both ways: the statement names a DIFFERENT relation and carries
#     the placeholder only inside a comment. Before comments were stripped this
#     was the whole of the requirement.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('FB-a a statement about another relation, with the placeholder in a comment',
  'SELECT count(*) FROM notification_provider_quarantine -- @REL@',
  'permission denied', 'notifications');
ROLLBACK;
SQL
} > "$WB/bind.sql"
# (2) N-2: a RELATION case whose statement reaches for a row. This is the
#     coordinator's attack — declare the relation, keep a key no fixture
#     creates — and the form itself refuses it.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('FB-b a relation case whose statement selects a row',
  'UPDATE @REL@ SET outcome = ''rejected'' WHERE attempt_key = ''NO-SUCH-ATTEMPT''',
  'permission denied', 'notification_attempts');
ROLLBACK;
SQL
} > "$WB/key.sql"
# (3) S-5/U-2: a ROW case keyed at a value no fixture creates. The derived
#     witness reads the row, so the refusal cannot be about an empty set.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('FB-c a row case keyed at a row that does not exist',
  'UPDATE @REL@ SET obligation_key = ''x''', 'permission denied',
  'notifications', 'id', '0fffffff-dead-4000-8000-00000000dead');
ROLLBACK;
SQL
} > "$WB/row.sql"
# (4) N-3: a statement that re-raises a permission denial as P0001, which the
#     SQLSTATE derivation cannot see.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses('FB-d a statement that launders its own refusal', $q$
  DO $d$ BEGIN
    UPDATE notifications SET obligation_key = 'x' WHERE id = '0fffffff-dead-4000-8000-00000000dead';
  EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'denied for table notifications';
  END $d$
$q$, 'denied for table notifications');
ROLLBACK;
SQL
} > "$WB/handler.sql"

wb_probe(){        # wb_probe <file> <arm> <needle> <what-it-means>
  local f=$1 arm=$2 needle=$3 meaning=$4
  if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
               -f "$WB/$f" >"$WB/$f.log" 2>&1; then
    say "$arm: FAIL — $meaning was ACCEPTED, so that condition of the witness law is not holding"
    FAILED=1
  elif grep -qF "$needle" "$WB/$f.log"; then
    say "$arm: $meaning is REFUSED BY NAME ($needle)"
  else
    say "$arm: FAIL — it refused, but not by $needle"
    head -2 "$WB/$f.log" | tee -a "$OUT/run.log"; FAILED=1
  fi
}
wb_probe bind.sql    "WITNESS-BIND"    "THE STATEMENT IS NOT BUILT FROM ITS SUBJECT" \
  "a statement about a different relation that carries the placeholder only in a comment (U-3)"
wb_probe key.sql     "WITNESS-KEY"     "THE STATEMENT IS NOT A DECLARED RELATION SHAPE" \
  "a relation case whose statement reaches for one row with WHERE, which is how N-2 re-declared a row case"
wb_probe row.sql     "WITNESS-ROW"     "NO SUBJECT" \
  "a row case keyed at a row no fixture creates (S-5)"
wb_probe handler.sql "WITNESS-HANDLER" "THE STATEMENT CARRIES AN EXCEPTION HANDLER" \
  "a statement that re-raises its own permission denial as P0001 (N-3)"

# The controls. One condition deleted at a time from a COPY of the helpers,
# loaded over the live baseline, the probe re-run, and the real file loaded back
# and RE-MEASURED afterwards — because a control that leaves the subject altered
# has changed the thing every later case is measured against.
cat > "$PATCHDIR/wl-drop.py" <<'PATCH'
import sys
src, dst, needle = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding="utf-8").read()
assert s.count(needle) == 1, "the condition is not where this patcher expects it: " + needle
s = s.replace(needle, "  IF false THEN", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
wl_ctl(){          # wl_ctl <arm> <probe-file> <needle-in-helpers> <sentence>
  local arm=$1 f=$2 needle=$3 sentence=$4
  if python3 -I "$PATCHDIR/wl-drop.py" "$HERE/p8-case-helpers.sql" "$WB/patched.sql" "$needle" \
       >"$WB/patch.log" 2>&1 \
     && ! cmp -s "$HERE/p8-case-helpers.sql" "$WB/patched.sql" \
     && "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
                  -f "$WB/patched.sql" >"$WB/load.log" 2>&1; then
    if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
                 -f "$WB/$f" >"$WB/ctl.log" 2>&1; then
      say "$arm: with that one condition deleted ALONE the same case PASSES again — $sentence"
    else
      say "$arm: FAIL — with the condition deleted the case still reddened, so the arm above attributes to something else"
      head -2 "$WB/ctl.log" | tee -a "$OUT/run.log"; FAILED=1
    fi
  else
    say "$arm: PLANT NOT ESTABLISHED — that condition could not be deleted from a copy of the helpers: $(tail -1 "$WB/patch.log")"
    FAILED=1
  fi
  # Restore, and MEASURE that the restore took: the probe must refuse again.
  if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
               -f "$HERE/p8-case-helpers.sql" >"$WB/restore.log" 2>&1; then
    if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
                 -f "$WB/$f" >"$WB/verify.log" 2>&1; then
      say "FAIL: the real case helpers were loaded back after $arm and the condition did not come back with them"
      FAILED=1
    fi
  else
    say "FAIL: the real case helpers could not be loaded back after $arm — $(tail -1 "$WB/restore.log")"
    FAILED=1
  fi
}
wl_ctl "WITNESS-BIND-CTL" bind.sql \
  "  IF position('@REL@' in bare) = 0 THEN" \
  "the statement is a free text again and the witness can be true of something it does not touch, which is U-3"
wl_ctl "WITNESS-KEY-CTL" key.sql \
  "  IF bad IS NOT NULL THEN" \
  "a row case can be declared as a relation case once more, with its key pointed at nothing, which is N-2"
wl_ctl "WITNESS-ROW-CTL" row.sql \
  "  IF n < 1 THEN" \
  "the refusal is evidence about an empty set again, which is S-5"

# ---------------------------------------------------------------------
# ROUND 30. The two SIDE DOORS into the same law (the twentieth challenge's
# W-3 and W-4), each with its probe and its deletion control.
# ---------------------------------------------------------------------
# W-3: the relation form's no-key rule read for the word `where`, and
# `INSERT … ON CONFLICT (key) DO UPDATE` reaches exactly one row without it —
# measured as `daftar_worker`, PASS, witnessed only by the relation existing.
# W-4: the handler ban reads the STATEMENT, and the handler that defeats the
# SQLSTATE derivation is in the pack: `p8.case_permits_rows` caught `WHEN
# others` and re-raised as P0001, which every case role may call. The same grep
# reddened an HONEST case whose payload merely contained the word.
#
# The fixes are on the arriving side wherever one exists: the keywords are read
# from `pg_get_keywords()` and refused unless declared, the relation form must
# be refused by a 42501 that is not a row-level policy, and
# `case_permits_rows` re-raises `USING ERRCODE` so a 42501 stays a 42501 through
# whatever frame catches it. Only the two text tests that remain — a handler
# written in the statement, and a statement that builds more SQL — are text,
# and each is measured both ways: it must refuse the attack AND leave an honest
# case alone.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('FB-f a relation case that reaches one row through ON CONFLICT', $q$
  INSERT INTO @REL@ (tenant_id, business_id, delivery_id, notification_id, attempt_no,
                     attempt_key, outcome, retryable, consent_read_at, consent_source, attempted_at)
  VALUES ('11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001',
          '0ddddddd-0000-4000-8000-0000000000a1','0fffffff-0000-4000-8000-0000000000a1',1,
          'NO-SUCH-ATTEMPT-KEY','rejected',true,now(),'fixture',now())
  ON CONFLICT (business_id, attempt_key) DO UPDATE SET outcome = 'rejected'
$q$, 'permission denied', 'notification_attempts');
ROLLBACK;
SQL
} > "$WB/shape.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('FB-g a relation case refused by a check constraint, not by a grant', $q$
  INSERT INTO @REL@ (provider, provider_event_id, status_token, verification)
  VALUES ('meta_cloud', 'evt-relclass-probe', 'delivered', 'verified')
$q$, 'quarantine_verification_in', 'notification_provider_quarantine');
ROLLBACK;
SQL
} > "$WB/relclass.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses('FB-h a permission denial laundered through case_permits',
  $i$SELECT p8.case_permits('inner', 'UPDATE notifications SET obligation_key = ''x'' WHERE id = ''0fffffff-dead-4000-8000-00000000dead''')$i$,
  'FAIL: REFUSED, and it should not be');
ROLLBACK;
SQL
} > "$WB/launder.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses('FB-j a statement that builds more SQL and hides a handler in it', $q$
  DO $d$ BEGIN
    EXECUTE 'DO $x$ BEGIN UPDATE notifications SET obligation_key = ''y'' WHERE id = ''0fffffff-dead-4000-8000-00000000dead''; EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION ''denied for table notifications''; END $x$';
  END $d$
$q$, 'denied for table notifications');
ROLLBACK;
SQL
} > "$WB/dynsql.sql"
# The HONEST case, the other direction of W-4: a row case whose payload carries
# the word `exception` inside a string literal. `pg_class` is the subject
# because it has a row for every relation in every configuration, so this arm
# needs no fixture of its own.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('FB-i an honest row case with the word exception in a literal',
  $q$UPDATE @REL@ SET relname = 'B1|exception noted'$q$,
  'permission denied', 'pg_class', 'relname', 'notifications');
ROLLBACK;
SQL
} > "$WB/literal.sql"

wb_probe shape.sql    "WITNESS-SHAPE"    "THE STATEMENT IS NOT A DECLARED RELATION SHAPE" \
  "a relation case that reaches one row through ON CONFLICT, which is the spelling the word WHERE did not see (W-3)"
wb_probe relclass.sql "WITNESS-RELCLASS" "A RELATION CASE REFUSED BY SOMETHING ROW-LEVEL" \
  "a relation case whose refusal is decided by the row — a check constraint — rather than by a grant (W-3)"
wb_probe launder.sql  "WITNESS-LAUNDER"  "WITNESS REQUIRED" \
  "a permission denial laundered into P0001 by a handler one frame deeper, inside a function the pack grants to every case role (W-4)"
wb_probe dynsql.sql   "WITNESS-DYNSQL"   "THE STATEMENT BUILDS MORE SQL" \
  "a statement that EXECUTEs a string carrying the handler, which no test that reads the statement can see (W-4)"

# The honest case must PASS, and that is an arm of its own: a text test that
# reds a case with no handler in it is not a hardening, and the only way to say
# so is to run such a case.
if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
             -f "$WB/literal.sql" >"$WB/literal.log" 2>&1 \
   && grep -qF "PASS refused by permission denied" "$WB/literal.log"; then
  say "WITNESS-LITERAL: an honest row case whose payload contains the word exception inside a string literal PASSES, so the handler ban reads the statement and not its payload (W-4, the direction that reds an honest case)"
else
  say "WITNESS-LITERAL: FAIL — an honest case with the word exception in a literal did not pass: $(head -2 "$WB/literal.log" | tr '\n' ' ')"
  FAILED=1
fi

# The three controls that are not a deleted IF: a substitution, one per copy.
cat > "$PATCHDIR/wl-sub.py" <<'PATCH'
import sys
src, dst, needle, repl = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src, encoding="utf-8").read()
assert s.count(needle) == 1, "the text is not where this patcher expects it: " + needle
open(dst, "w", encoding="utf-8").write(s.replace(needle, repl, 1))
PATCH
wl_sub_ctl(){      # wl_sub_ctl <arm> <probe> <needle> <repl> <expect: pass|refuse> <needle-in-log> <sentence>
  local arm=$1 f=$2 needle=$3 repl=$4 want=$5 lneedle=$6 sentence=$7
  if python3 -I "$PATCHDIR/wl-sub.py" "$HERE/p8-case-helpers.sql" "$WB/sub.sql" "$needle" "$repl" \
       >"$WB/sub-patch.log" 2>&1 \
     && ! cmp -s "$HERE/p8-case-helpers.sql" "$WB/sub.sql" \
     && "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
                  -f "$WB/sub.sql" >"$WB/sub-load.log" 2>&1; then
    if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
                 -f "$WB/$f" >"$WB/$arm-ctl.log" 2>&1; then
      if [ "$want" = "pass" ] && grep -qF "$lneedle" "$WB/$arm-ctl.log"; then
        say "$arm: with that one change undone the same case PASSES again — $sentence"
      else
        say "$arm: FAIL — with the change undone the case did not land where this control says: rc=0 $(head -2 "$WB/$arm-ctl.log" | tr '\n' ' ')"
        FAILED=1
      fi
    elif [ "$want" = "refuse" ] && grep -qF "$lneedle" "$WB/$arm-ctl.log"; then
      say "$arm: with that one change undone the same case is REFUSED again by $lneedle — $sentence"
    else
      say "$arm: FAIL — with the change undone the case did not land where this control says: $(head -2 "$WB/$arm-ctl.log" | tr '\n' ' ')"
      FAILED=1
    fi
  else
    say "$arm: PLANT NOT ESTABLISHED — that change could not be made in a copy of the helpers: $(tail -1 "$WB/sub-patch.log")"
    FAILED=1
  fi
  if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
               -f "$HERE/p8-case-helpers.sql" >"$WB/sub-restore.log" 2>&1; then
    :
  else
    say "FAIL: the real case helpers could not be loaded back after $arm — $(tail -1 "$WB/sub-restore.log")"
    FAILED=1
  fi
}
wl_ctl "WITNESS-SHAPE-CTL" shape.sql \
  "  IF bad IS NOT NULL THEN" \
  "the ON CONFLICT spelling reaches one row in a relation case again, with its key pointed at nothing, which is W-3"
wl_ctl "WITNESS-RELCLASS-CTL" relclass.sql \
  "    IF kind = 'relation' AND rowlevel THEN" \
  "a relation case can be witnessed by the relation while its refusal is decided by the row, which is W-3's other half"
wl_sub_ctl "WITNESS-HANDLER-CTL" handler.sql \
  "  IF bare ~* '(^|[^a-z_])exception([^a-z_]|\$)' THEN" "  IF false THEN" \
  refuse "THE REFUSAL CAME FROM THE STATEMENT'S OWN BLOCK" \
  "the text ban is gone and the same statement is caught by the condition BEHIND it, which reads the arriving exception's context instead of the statement (N-3 closed twice, and round 30 learned why: the text test is the one that can be spelled around)"
# TWO controls, because round 31 added a second law over the same attack and a
# control that leaves the other one standing attributes nothing. The first
# deletes round 30's law alone and requires round 31's to name the case; the
# second undoes the one line round 30's fix was, and requires round 31's to
# name it for a different reason — the denial no longer arrives as 42501 at
# all. Each law is therefore shown to hold without the other.
wl_sub_ctl "WITNESS-LAUNDER-CTL" launder.sql \
  "    IF NOT witnessed AND sst = '42501'" "    IF false AND sst = '42501'" \
  refuse "THE REFUSAL CAME FROM THIS PACK" \
  "with round 30's arriving-SQLSTATE law deleted ALONE the laundered denial is named by round 31's pack rule instead, so the two bound it independently (W-4, C-2)"
wl_sub_ctl "WITNESS-LAUNDER-CTL2" launder.sql \
  "      USING ERRCODE = sst;" "      ;" \
  refuse "THE REFUSAL CAME FROM THIS PACK" \
  "with the USING ERRCODE deleted ALONE the denial arrives as P0001, so round 30's law cannot see it and round 31's pack rule is what names it — which is why that single line was a fix at all (W-4)"
wl_sub_ctl "WITNESS-DYNSQL-CTL" dynsql.sql \
  "  IF bare ~* '(^|[^a-z_])execute([^a-z_]|\$)' THEN" "  IF false THEN" \
  refuse "THE REFUSAL CAME FROM THE STATEMENT'S OWN BLOCK" \
  "the ban on building SQL is gone and the laundered refusal is caught by the arriving context instead — the two conditions bound the same attack from the text side and from the server side, and only the second cannot be re-spelled (W-4, F-3)"
wl_sub_ctl "WITNESS-LITERAL-CTL" literal.sql \
  "  bare := p8.sql_scan(stmt, 'dollar');" \
  "  bare := p8.sql_scan(stmt, 'exec');" \
  refuse "THE STATEMENT CARRIES AN EXCEPTION HANDLER" \
  "with the handler ban reading the statement with its literals KEPT, the honest case is reddened by its own payload again, which is why the scanner blanks them (W-4)"

# ---------------------------------------------------------------------
# ROUND 30, the coordinator's F-1, F-2 and F-3: three TEXT checks standing in
# for BEHAVIOUR checks, each measured as a fail-open on this head's parent.
# ---------------------------------------------------------------------
# F-1: `@KEY@` bound its own PRESENCE. `WHERE id = '…dead' AND @KEY@ <> ''`
# carried it, the witness read the declared row, the statement touched none, and
# the case passed. The predicate is now APPENDED by the form from the declared
# key, so the statement and the witness read the same row because one expression
# builds both: the attack is not refused, it is unwritable. Three layers, each
# with its own arm: the placeholder ban, the row shape law, and the construction
# underneath them.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('FB-k a row case whose declared key is a decoy beside its own predicate',
  $q$UPDATE @REL@ SET relname = 'rewritten' WHERE relname = 'no-such-relation-at-all' AND @KEY@ <> ''$q$,
  'permission denied', 'pg_class', 'relname', 'notifications');
ROLLBACK;
SQL
} > "$WB/reach.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('FB-l a row case that writes a predicate of its own and no placeholder',
  $q$UPDATE @REL@ SET relname = 'rewritten' WHERE relname = 'no-such-relation-at-all'$q$,
  'permission denied', 'pg_class', 'relname', 'notifications');
ROLLBACK;
SQL
} > "$WB/reach2.sql"
# F-2: the relation form's `where` regex against `MERGE … ON`, which reaches one
# row with no WHERE in it. The keyword law reads the server's own list, so this
# is refused by the keywords it carries rather than by a word someone thought of.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('FB-m a MERGE that reaches one row through ON', $q$
  MERGE INTO @REL@ t USING (SELECT 1 AS x) s ON t.attempt_key = 'NO-SUCH-ATTEMPT'
   WHEN MATCHED THEN UPDATE SET outcome = 'rejected'
$q$, 'permission denied', 'notification_attempts');
ROLLBACK;
SQL
} > "$WB/merge.sql"
# F-3: the handler keyword split across a concatenation, which no regex sees.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses('FB-n a handler assembled from pieces', $q$
  DO $d$ BEGIN
    EXECUTE 'DO $i$ BEGIN UPDATE notifications SET obligation_key = ''x'' WHERE id = ''0fffffff-dead-4000-8000-00000000dead''; EXCEP' || 'TION WHEN insufficient_privilege THEN RAISE EXCEP' || 'TION ''denied for table notifications''; END $i$';
  END $d$
$q$, 'denied for table notifications');
ROLLBACK;
SQL
} > "$WB/split.sql"
# F-3 again, from the other end: a block that reports whatever it likes and
# carries NO handler keyword at all (`RAISE` without `EXCEPTION` raises P0001).
# No text test can see this one; the arriving exception CONTEXT names the
# statement's own anonymous block, and that is what refuses it.
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses('FB-o a block that reports its own refusal, with no handler keyword in it', $q$
  DO $d$ BEGIN
    RAISE 'denied for table notifications';
  END $d$
$q$, 'denied for table notifications');
ROLLBACK;
SQL
} > "$WB/block.sql"

wb_probe reach.sql  "WITNESS-REACH"  "A ROW CASE MAY NOT WRITE ITS OWN PREDICATE" \
  "a row case whose declared key sits beside a decoy predicate, which is F-1: the witness read one row and the statement touched none"
wb_probe reach2.sql "WITNESS-REACH2" "THE STATEMENT IS NOT A DECLARED ROW SHAPE" \
  "a row case that writes a predicate of its own without the placeholder, caught by the row form's declared keywords"
wb_probe merge.sql  "WITNESS-MERGE"  "THE STATEMENT IS NOT A DECLARED RELATION SHAPE" \
  "MERGE … ON, which reaches exactly one row and carries no WHERE for a regex to find (F-2)"
wb_probe split.sql  "WITNESS-SPLIT"  "THE STATEMENT BUILDS MORE SQL" \
  "a handler assembled from 'EXCEP' || 'TION' inside a statement that EXECUTEs the pieces (F-3)"
wb_probe block.sql  "WITNESS-BLOCK"  "THE REFUSAL CAME FROM THE STATEMENT'S OWN BLOCK" \
  "a statement whose own anonymous block raises the refusal the case then reads, with no handler keyword anywhere in it (F-3)"

wl_sub_ctl "WITNESS-REACH-CTL" reach.sql \
  "  IF position('@KEY@' in p8.sql_scan(stmt)) > 0 THEN" \
  "  IF false THEN" \
  refuse "THE STATEMENT IS NOT A DECLARED ROW SHAPE" \
  "the placeholder ban is gone and the same case is caught by the row shape law instead, so the two bound the same attack independently (F-1)"
wl_sub_ctl "WITNESS-REACH2-CTL" reach2.sql \
  "  IF bad IS NOT NULL THEN" "  IF false THEN" \
  refuse "A ROW CASE REFUSED BY SOMETHING NO AUTHORITY DECIDED" \
  "with both text conditions gone the statement cannot even be FORMED — the form appends its own predicate beside the case's and the server rejects the result as a syntax error, which round 31's arriving-class rule then names, so the construction and the class rule catch it from two sides (F-1, C-2)"
wl_sub_ctl "WITNESS-BLOCK-CTL" block.sql \
  "    IF split_part(coalesce(ctx,''), E'\\n', 1) ~ 'inline_code_block' THEN" \
  "    IF false THEN" \
  pass "PASS refused by denied for table notifications" \
  "a block that reports its own refusal passes the law again, against a row that does not exist — the state the coordinator's F-3 measured, in a spelling no regex reads"

# ---------------------------------------------------------------------
# ROUND 31, SCANNER-AGREE. The keystone of this round, and the reason it is
# an arm rather than a comment.
# ---------------------------------------------------------------------
# The defect two reviewers measured was not that a regex was wrong. It was
# that the gate's reading of SQL had DRIFTED from the server's, and nothing in
# the gate could notice. The answer is a scanner that follows the server's own
# lexing — but there are two of them now, one in plpgsql and one in Python,
# and two implementations of one language that can drift apart are two
# languages. So both read the same corpus, in all three modes, and their
# outputs must be byte-identical. The corpus leads with every attack the two
# reviews measured on this head's parent; input and output are hex, so no
# escaping convention sits between the two readings being compared.
SCAN=$OUT/scan; mkdir -p "$SCAN"
if python3 -I "$HERE/p8-case-net.py" --scan "$HERE/p8-scanner-corpus.txt" >"$SCAN/py.txt" 2>"$SCAN/py.err"; then
  {
    echo "\pset tuples_only on"
    echo "\pset format unaligned"
    printf '%s\n' "\\pset fieldsep '\\t'"
    echo "CREATE TEMP TABLE corpus(line TEXT);"
    printf '%s\n' "\\copy corpus FROM PROGRAM 'grep -v \"^#\" $HERE/p8-scanner-corpus.txt | grep -v \"^\$\"' WITH (FORMAT csv, DELIMITER E'\\b', QUOTE E'\\f')"
    cat <<'SQL'
SELECT split_part(line, E'\t', 1), m,
       encode(convert_to(p8.sql_scan(convert_from(decode(split_part(line, E'\t', 2), 'hex'), 'UTF8'), m), 'UTF8'), 'hex')
FROM corpus, unnest(ARRAY['strip','dollar','exec']) AS m
ORDER BY ctid, array_position(ARRAY['strip','dollar','exec'], m);
SQL
  } > "$SCAN/sql.sql"
  if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
               -f "$SCAN/sql.sql" >"$SCAN/sql.txt" 2>"$SCAN/sql.err"; then
    SCAN_N=$(grep -c . "$SCAN/py.txt")
    if diff -q "$SCAN/py.txt" "$SCAN/sql.txt" >/dev/null 2>&1; then
      say "SCANNER-AGREE: the Python scanner and p8.sql_scan return byte-identical output for all $SCAN_N readings of the corpus — every line of it in all three modes, led by the five attacks the twenty-first round measured — so the gate has ONE reading of SQL and not two that can drift"
    else
      say "SCANNER-AGREE: FAIL — the two scanners disagree: $(diff "$SCAN/py.txt" "$SCAN/sql.txt" | head -2 | tr '\n' ' ')"
      FAILED=1
    fi
  else
    say "SCANNER-AGREE: PLANT NOT ESTABLISHED — the corpus could not be read in the database: $(tail -1 "$SCAN/sql.err")"
    FAILED=1
  fi
else
  say "SCANNER-AGREE: PLANT NOT ESTABLISHED — the corpus could not be read by the Python scanner: $(tail -1 "$SCAN/py.err")"
  FAILED=1
fi
# The control. One mode's dollar-quote handling reverted to round 30's regex in
# a COPY of the SQL side alone, and the two readings must then DIFFER — because
# an arm that compares two things is only a measurement if a difference reds.
if python3 -I "$PATCHDIR/wl-sub.py" "$HERE/p8-case-helpers.sql" "$SCAN/drift.sql" \
     "          k := position(tag in substr(t, i + length(tag)));" \
     "          k := 0;" >"$SCAN/drift-patch.log" 2>&1 \
   && ! cmp -s "$HERE/p8-case-helpers.sql" "$SCAN/drift.sql" \
   && "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
                -f "$SCAN/drift.sql" >"$SCAN/drift-load.log" 2>&1 \
   && "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
                -f "$SCAN/sql.sql" >"$SCAN/drift.txt" 2>&1; then
  if diff -q "$SCAN/py.txt" "$SCAN/drift.txt" >/dev/null 2>&1; then
    say "SCANNER-AGREE-CTL: FAIL — the SQL scanner's dollar-quote handling was changed in a copy and the comparison still reported agreement, so SCANNER-AGREE measures nothing"
    FAILED=1
  else
    say "SCANNER-AGREE-CTL: with the SQL side's dollar-quote scan broken ALONE in a copy the two readings DIFFER and the arm above reds, so the agreement it reports is a comparison and not a sentence"
  fi
else
  say "SCANNER-AGREE-CTL: PLANT NOT ESTABLISHED — that one change could not be made in a copy: $(tail -1 "$SCAN/drift-patch.log")"
  FAILED=1
fi
if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
             -f "$HERE/p8-case-helpers.sql" >"$SCAN/restore.log" 2>&1; then
  :
else
  say "FAIL: the real case helpers could not be loaded back after SCANNER-AGREE-CTL — $(tail -1 "$SCAN/restore.log")"
  FAILED=1
fi

# ---------------------------------------------------------------------
# ROUND 31. Two reviewers, independently, on the same head, measured the same
# defect one layer under round 30's: a TEXT check that MIS-PARSES the language
# is weaker than no check, because it reports on a statement it did not read.
#
#   * one apostrophe inside a dollar-quoted body blinded the single regex that
#     three laws read through — the row shape law, the relation shape law and
#     the handler ban — and the whole gate ran green over a tree whose case
#     W-2 touched no row;
#   * appending `WHERE …` to a statement is not composing one: a trailing `--`
#     put the form's own predicate inside a comment, and a `;` gave it to a
#     second statement. Both ran the mutation against EVERY row;
#   * a ROW case was never asked what CLASS of error arrived, so
#     `SELECT 1/0 FROM @REL@` passed as a refusal.
#
# The scanner, `assert_single_statement` and `assert_arriving_class` answer
# those. The arms below measure each of them, and the first three measure
# BEHAVIOUR rather than text: a bench where the predicate's applying or not
# decides whether anything refuses at all.
# ---------------------------------------------------------------------
# The bench. Two rows; a BEFORE UPDATE trigger that refuses with 42501 only for
# the row the cases do NOT declare. A case whose composed predicate APPLIES
# touches only row W, nothing refuses, and the case ends in `FAIL: ACCEPTED`.
# A case whose predicate was detached touches row X too and PASSES. So "did the
# predicate apply" is read off the outcome instead of off the statement's text.
# Its trigger lives OUTSIDE schema p8, because `assert_arriving_class` refuses
# a refusal raised inside a p8 helper and this trigger must be allowed to
# speak; and the relation is unqualified, because `p8.quoted_ident` quotes what
# it is given as ONE identifier.
"$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 >"$WB/bench.log" 2>&1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.p8bench_reach(k TEXT PRIMARY KEY, v INT NOT NULL);
TRUNCATE public.p8bench_reach;
INSERT INTO public.p8bench_reach VALUES ('W', 1), ('X', 1);
CREATE OR REPLACE FUNCTION public.p8bench_trap() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN
  IF NEW.k = 'X' THEN
    RAISE EXCEPTION 'permission denied for table reach: DENIED-BY-THE-OTHER-ROW'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $t$;
DROP TRIGGER IF EXISTS p8bench_trap ON public.p8bench_reach;
CREATE TRIGGER p8bench_trap BEFORE UPDATE ON public.p8bench_reach
  FOR EACH ROW EXECUTE FUNCTION public.p8bench_trap();
GRANT SELECT, UPDATE ON public.p8bench_reach TO daftar_worker;
SQL
if [ -s "$WB/bench.log" ] && grep -qi error "$WB/bench.log"; then
  say "REACH-BENCH: PLANT NOT ESTABLISHED — the reach bench could not be built: $(tail -1 "$WB/bench.log")"
  FAILED=1
else
  say "REACH-BENCH: two rows and a trigger that refuses with 42501 for the row no case declares, so whether the composed predicate APPLIES decides whether anything refuses — the three arms below read a behaviour and not a text"
fi

{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('RB-honest the predicate applies and nothing refuses',
  $q$UPDATE @REL@ SET v = 2$q$, 'DENIED-BY-THE-OTHER-ROW', 'p8bench_reach', 'k', 'W');
ROLLBACK;
SQL
} > "$WB/rb-honest.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('RB-comment the statement ends in a line comment',
  $q$UPDATE @REL@ SET v = 2 --$q$, 'DENIED-BY-THE-OTHER-ROW', 'p8bench_reach', 'k', 'W');
ROLLBACK;
SQL
} > "$WB/rb-comment.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('RB-semi the statement is two statements',
  $q$UPDATE @REL@ SET v = 2; SELECT 1 FROM @REL@$q$,
  'DENIED-BY-THE-OTHER-ROW', 'p8bench_reach', 'k', 'W');
ROLLBACK;
SQL
} > "$WB/rb-semi.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('RB-dollar a predicate of its own behind one apostrophe',
  $q$UPDATE @REL@ SET v = 2, k = $n$a'b$n$ WHERE k = 'X'$q$,
  'DENIED-BY-THE-OTHER-ROW', 'p8bench_reach', 'k', 'W');
ROLLBACK;
SQL
} > "$WB/rb-dollar.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('RB-class an error the statement computed for itself',
  $q$SELECT 1/0 FROM @REL@$q$, 'division by zero', 'p8bench_reach', 'k', 'W');
ROLLBACK;
SQL
} > "$WB/rb-class.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_row('RB-pack a refusal this pack raised for the case',
  $q$SELECT p8.assert_no_handler('RB-pack','exception') FROM @REL@$q$,
  'THE STATEMENT CARRIES AN EXCEPTION HANDLER', 'p8bench_reach', 'k', 'W');
ROLLBACK;
SQL
} > "$WB/rb-pack.sql"
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('RB-shape ON CONFLICT hidden behind one apostrophe', $q$
  INSERT INTO @REL@ (business_id, attempt_key, outcome, provider, created_at)
  VALUES ('bbbbbbbb-0000-4000-8000-000000000001','k',$n$x rejected'$n$,'p','now')
  ON CONFLICT (business_id, attempt_key) DO UPDATE SET outcome = 'rejected'
$q$, 'permission denied', 'notification_attempts');
ROLLBACK;
SQL
} > "$WB/rb-shape.sql"

# The honest case and the comment case must now land in the SAME place, and that
# place is `ACCEPTED`: the predicate applied, only row W was touched, and
# nothing refused. Before this round the comment case PASSED.
wb_probe rb-honest.sql  "ROW-REACH"         "FAIL: ACCEPTED" \
  "an honest row case whose composed predicate applies touches only the declared row, so nothing refuses"
wb_probe rb-comment.sql "ROW-REACH-COMMENT" "FAIL: ACCEPTED" \
  "a row case ending in a line comment lands in the same place as the honest one, because the form now RUNS the scanner's text and the comment is gone before the predicate is appended (C-1a)"
wb_probe rb-semi.sql    "ROW-REACH-SEMI"    "MORE THAN ONE STATEMENT" \
  "a row case that is two statements, where the appended predicate joined the SECOND one and the first ran against every row (C-1b)"
wb_probe rb-dollar.sql  "ROW-REACH-DOLLAR"  "THE STATEMENT IS NOT A DECLARED ROW SHAPE" \
  "a row case writing its own WHERE behind an apostrophe in a dollar-quoted body, which the old stripper deleted from the text every law read (the coordinator's F-1b)"
wb_probe rb-class.sql   "ROW-CLASS"         "A ROW CASE REFUSED BY SOMETHING NO AUTHORITY DECIDED" \
  "a row case whose statement computes its own error — SELECT 1/0 expecting a division by zero — which passed because the arriving-class rule was applied to the relation form alone (C-2)"
wb_probe rb-pack.sql    "ROW-PACK"          "THE REFUSAL CAME FROM THIS PACK" \
  "a case that calls one of this pack's own helpers to raise the message it then reads, so the case chose both the error and its wording (C-2)"
wb_probe rb-shape.sql   "WITNESS-SHAPE-DOLLAR" "THE STATEMENT IS NOT A DECLARED RELATION SHAPE" \
  "ON CONFLICT … DO UPDATE SET hidden from the keyword law by one apostrophe in a dollar-quoted value (the coordinator's F-2)"

# One control per law, each deleting that law ALONE and requiring the measured
# fail-open to come back. These are the states the two reviews measured.
wl_sub_ctl "ROW-REACH-COMMENT-CTL" rb-comment.sql \
  "  stmt2 := replace(p8.sql_scan(stmt, 'exec'), '@REL@', p8.quoted_ident(relation))" \
  "  stmt2 := replace(stmt, '@REL@', p8.quoted_ident(relation))" \
  pass "PASS refused by DENIED-BY-THE-OTHER-ROW" \
  "with the form appending to the RAW statement again the comment swallows the predicate, the mutation runs against every row, and the case reports the refusal the OTHER row decided — the exact state both reviews measured on this head's parent (C-1a)"
wl_sub_ctl "ROW-REACH-SEMI-CTL" rb-semi.sql \
  "  IF position(';' in bare) > 0 THEN" "  IF false THEN" \
  pass "PASS refused by DENIED-BY-THE-OTHER-ROW" \
  "with the single-statement law deleted the second statement takes the appended predicate and the first runs unbounded, which carries only keywords the row form declares and so no keyword law could ever catch it (C-1b)"
wl_sub_ctl "ROW-CLASS-CTL" rb-class.sql \
  "  IF kind = 'row' AND NOT (sst = '42501' OR left(sst, 2) = '23' OR sst = 'P0001') THEN" \
  "  IF false THEN" \
  pass "PASS refused by division by zero" \
  "with the row form's arriving-class rule deleted, four characters of arithmetic are a refusal again (C-2)"
wl_sub_ctl "ROW-PACK-CTL" rb-pack.sql \
  "                      ~* ('function (p8\\.)?' || pr.proname || '\\(.*at RAISE')) THEN" \
  "                      ~* 'nothing matches this') THEN" \
  pass "PASS refused by THE STATEMENT CARRIES AN EXCEPTION HANDLER" \
  "with that one condition deleted a case can call this pack's own helpers to manufacture the message it reads (C-2)"

# ---------------------------------------------------------------------
# ROUND 30, F-4: the net over every SQL file the run LOADS, and its byte pin
# ---------------------------------------------------------------------
# `CORE-NET` above bounds CONTENT with one literal over one glob. The
# coordinator's review walked around it twice: a core call whose name is
# assembled at run time (`'p8.case_refuses_' || 'core'`), and a wrapper created
# in a FIXTURES file, which `build()` and `cases()` both run and the glob never
# covered. `p8-case-net.py` derives the file set from the runner's OWN source,
# refuses a direct core call, any dynamic SQL and any function created in a case
# or fixtures file, names a case file the runner does not load, and pins the
# whole set by digest so a file swapped mid-run reds.
NETBOX=$OUT/casenet
rm -rf "$NETBOX"; mkdir -p "$NETBOX"
if CASE_NET_OUT=$(python3 -I "$HERE/p8-case-net.py" "$HERE/run-p8-real-proof.sh" 2>&1); then
  say "CORE-NET-SET: $CASE_NET_OUT"
  CASE_NET_PIN=$(python3 -I "$HERE/p8-case-net.py" --pin "$HERE/run-p8-real-proof.sh" 2>/dev/null)
else
  say "CORE-NET-SET: FAIL — the net over the files this run loads refused the live set: $(printf '%s' "$CASE_NET_OUT" | head -2 | tr '\n' ' ')"
  FAILED=1
fi
# The three plants, each in its own copy of the directory, because a plant in
# the live tree is a plant in the subject.
_netcopy(){        # _netcopy <dir>
  rm -rf "$1"; mkdir -p "$1"
  cp "$HERE"/*.sql "$HERE/run-p8-real-proof.sh" "$HERE/p8-case-net.py" "$1/"
}
net_plant(){       # net_plant <arm> <file-in-copy> <python-that-appends> <needle> <sentence>
  local arm=$1 file=$2 appender=$3 needle=$4 sentence=$5
  local box=$NETBOX/$arm
  _netcopy "$box"
  if python3 -I - "$box/$file" "$appender" >"$box/plant.log" 2>&1 <<'PY'
import sys
path, text = sys.argv[1], sys.argv[2]
with open(path, "a", encoding="utf-8") as fh:
    fh.write("\n" + text + "\n")
PY
  then
    NP=$(python3 -I "$box/p8-case-net.py" "$box/run-p8-real-proof.sh" 2>&1); NPRC=$?
    if [ "$NPRC" -ne 0 ] && printf '%s' "$NP" | grep -qF "$needle"; then
      say "$arm: $sentence is REFUSED BY NAME ($needle)"
    else
      say "$arm: FAIL — $sentence was not refused by name: rc=$NPRC $(printf '%s' "$NP" | head -1)"
      FAILED=1
    fi
  else
    say "$arm: PLANT NOT ESTABLISHED — the plant could not be written into a copy: $(tail -1 "$box/plant.log")"
    FAILED=1
  fi
}
net_plant "CORE-NET-DYN" "p8-real-cases-app.sql" \
  "DO \$outer\$ DECLARE fn TEXT := 'p8.case_refuses_' || 'core'; BEGIN EXECUTE format('SELECT %s(%L,%L,%L,%L,%L)', fn, 'ATK', 'SELECT 1', 'denied', 'x', 'row'); END \$outer\$;" \
  "DYNAMIC SQL" \
  "a core call whose name is assembled at run time in a case file, which the literal net cannot see (F-4a)"
net_plant "CORE-NET-FIX" "p8-real-fixtures.sql" \
  "CREATE OR REPLACE FUNCTION p8.case_refuses_sneaky(l TEXT, s TEXT, e TEXT) RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN PERFORM 1; END \$f\$;" \
  "A FUNCTION CREATED" \
  "a wrapper created in a fixtures file, which build() and cases() both run and the glob never covered (F-4b)"
# ROUND 31, the coordinator's §3(a) and (b). The three rules above all read
# ONE stripper, and one apostrophe inside a dollar-quoted body blinded it:
# `CREATE OR REPLACE FUNCTION`, the body and the body's literal core call were
# all inside a single pseudo-literal at once, and the program printed "none
# names the core helper, builds SQL or creates a function" about a file that
# did all three. For the literal spelling that made this reader measurably
# WEAKER than round 29's `grep -lIF`, which cannot be fooled by quoting
# because it does not parse. So two things changed: the scanner follows the
# server's own lexing, and the literal is read BOTH ways — scanned AND raw —
# because a reader that replaces an older check inherits that check's floor.
net_plant "CORE-NET-DOLLAR" "p8-real-fixtures-owner.sql" \
  "SELECT \$n\$a'\$n\$; CREATE OR REPLACE FUNCTION p8.case_refuses_sneaky(l TEXT) RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN PERFORM p8.case_refuses_core(l,'SELECT 1','denied','x','row'); END \$f\$;" \
  "A DIRECT CORE CALL" \
  "a wrapper in a FIXTURES file hidden behind one apostrophe in a dollar-quoted body, which blinded all three rules at once and which round 29's grep still caught (the coordinator's section 3)"

# And the completeness direction: a case file beside the loaded ones that the
# runner names nowhere.
CORE_STRAY=$NETBOX/stray
_netcopy "$CORE_STRAY"
# The name is ASSEMBLED, because a name typed here appears in the runner's own
# source and the net derives its set from that source — so a literal would make
# this planted file part of the declared set and the arm would measure nothing.
# The same lesson the retirement net learned, one arm later.
STRAY_NAME="p8-real-cases-""stray.sql"
printf -- '-- a case file nothing loads\nSELECT 1;\n' > "$CORE_STRAY/$STRAY_NAME"
NS=$(python3 -I "$CORE_STRAY/p8-case-net.py" "$CORE_STRAY/run-p8-real-proof.sh" 2>&1); NSRC=$?
if [ "$NSRC" -ne 0 ] && printf '%s' "$NS" | grep -qF "A CASE OR FIXTURES FILE THE RUNNER DOES NOT LOAD"; then
  say "CORE-NET-STRAY: a case file sitting beside the loaded ones that the runner names NOWHERE is refused by name, so the set is bounded in both directions"
else
  say "CORE-NET-STRAY: FAIL — an unloaded case file was not named: rc=$NSRC $(printf '%s' "$NS" | head -1)"
  FAILED=1
fi

# And the sentinel leg. With the witness DERIVED there is no way for a case to
# write one that ignores its subject, so this condition cannot be reached from a
# case file — which is exactly the state the project calls UNMEASURED-at-runtime
# rather than dead. It is measured here by building the hole: a copy of the
# helpers whose derived witness drops its own key predicate, so the witness
# stops reading the subject while everything else holds.
cat > "$PATCHDIR/wl-blind-witness.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "  sq := 'SELECT 1 FROM pg_class WHERE relname = ' || quote_literal(p8.sentinel_subject());"
assert s.count(b) == 1, "the sentinel witness is not where this patcher expects it"
s = s.replace(b, "  sq := 'SELECT 1 FROM pg_class';", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
{ wb_head; cat <<'SQL'
SELECT p8.case_refuses_relation('FB-e a case whose derived witness has stopped reading its subject',
  'SELECT count(*) FROM @REL@', 'permission denied', 'notification_provider_quarantine');
ROLLBACK;
SQL
} > "$WB/sentinel.sql"
if python3 -I "$PATCHDIR/wl-blind-witness.py" "$HERE/p8-case-helpers.sql" "$WB/blind.sql" \
     >"$WB/blind-patch.log" 2>&1 \
   && "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
                -f "$WB/blind.sql" >"$WB/blind-load.log" 2>&1; then
  if "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
               -f "$WB/sentinel.sql" >"$WB/sentinel.log" 2>&1; then
    say "WITNESS-SENTINEL: FAIL — a witness that answers for the sentinel as well as for the subject was ACCEPTED, so the second leg measures nothing"
    FAILED=1
  elif grep -qF "THE WITNESS DOES NOT READ ITS SUBJECT" "$WB/sentinel.log"; then
    say "WITNESS-SENTINEL: a derived witness that no longer reads its key is REFUSED BY NAME (THE WITNESS DOES NOT READ ITS SUBJECT), so the sentinel leg is UNMEASURED-at-runtime from a case file and measured here by building the hole (U-2)"
  else
    say "WITNESS-SENTINEL: FAIL — it refused, but not by THE WITNESS DOES NOT READ ITS SUBJECT"
    head -2 "$WB/sentinel.log" | tee -a "$OUT/run.log"; FAILED=1
  fi
  if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
               -f "$HERE/p8-case-helpers.sql" >"$WB/restore2.log" 2>&1; then
    if ! "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
                   -f "$WB/sentinel.sql" >"$WB/verify2.log" 2>&1; then
      say "FAIL: the real case helpers were loaded back after WITNESS-SENTINEL and the honest witness did not come back with them"
      FAILED=1
    fi
  else
    say "FAIL: the real case helpers could not be loaded back after WITNESS-SENTINEL — $(tail -1 "$WB/restore2.log")"
    FAILED=1
  fi
else
  say "WITNESS-SENTINEL: PLANT NOT ESTABLISHED — the derived witness could not be blinded: $(tail -1 "$WB/blind-patch.log")"
  FAILED=1
fi

# THE ZERO-ROW HATCH, armed. `case_permits_rows(label, stmt, 0)` is the escape
# for a permit that genuinely means zero. An escape nobody measures is a hole
# with a name, so: a case DECLARING 0 whose statement affects a row must red.
cat > "$WIT/hatch.sql" <<'SQL'
SET search_path = p8, public;
BEGIN;
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';
SELECT p8.case_permits_rows('HATCH-B a declared zero whose statement matches nothing',
  $h$UPDATE notification_settings SET max_consent_age_seconds = max_consent_age_seconds
      WHERE business_id = '0fffffff-0000-4000-8000-00000000dead'$h$, 0);
SELECT p8.case_permits_rows('HATCH-C a declared zero whose statement DOES affect a row',
  $h$UPDATE notification_settings SET max_consent_age_seconds = max_consent_age_seconds
      WHERE business_id = 'bbbbbbbb-0000-4000-8000-000000000001'$h$, 0);
ROLLBACK;
SQL
if "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -v ON_ERROR_STOP=1 \
             -f "$WIT/hatch.sql" >"$WIT/hatch.log" 2>&1; then
  say "HATCH: FAIL — a case DECLARING 0 rows passed while its statement affected one, so the escape hatch asserts nothing"
  FAILED=1
elif grep -qF "HATCH-B a declared zero whose statement matches nothing PASS permitted, 0 row(s) as declared" "$WIT/hatch.log" \
     && grep -qF "FAIL: permitted, but affected 1 row(s) and this case DECLARES 0" "$WIT/hatch.log" \
     && grep -qF "HATCH-C" "$WIT/hatch.log"; then
  say "HATCH: a declared zero PASSES when it is true and REDS when the statement starts affecting a row (HATCH-B then HATCH-C), so the escape from the vacuity check is itself a claim and not a way around it"
else
  say "HATCH: FAIL — the declared-zero hatch did not behave as both halves require"
  grep -E "HATCH-[BC]" "$WIT/hatch.log" | head -3 | tee -a "$OUT/run.log"; FAILED=1
fi

say "=== a permits-case must have MOVED something (round 26, the sixteenth challenge) ==="
# THE DEFECT, as the challenger measured it on `a7a71e8`. It pointed ONE
# `WHERE id` at a uuid no fixture creates, so the UPDATE matched zero rows and
# raised nothing — and FIVE of the seven UPDATE permits-cases passed, at the
# same `passes=91` as the honest run. My answer to its question had been an
# argument: the ladder runs on one row, so a neutered `I3-a` would be caught
# downstream by `I3-d`. It is not. The chain SELF-HEALS: the row stays at
# `queued`, `I3-b` becomes `queued -> delivered` and is still a forward move,
# the row still reaches `read`, and `I3-d` is still correctly refused. Only
# `I3-g` and `N6-a` were caught, each for a reason specific to it.
#
# The fix is in `p8-case-helpers.sql`, not in seven read-backs: `case_permits`
# now refuses by name when the statement affected no row. These arms measure
# that, with the challenger's own method, one neutered case per copy — and the
# last one deletes the check ALONE and requires the fail-open to RETURN, because
# a guard with no deletion arm is a sentence.
cat > "$PATCHDIR/neuter-case.py" <<'PATCH'
import re
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
DEAD = "0fffffff-0000-4000-8000-00000000dead"
s = open(src, encoding="utf-8").read()
i = s.find("case_permits('" + label)
assert i >= 0, "no case_permits whose label starts " + label
a = s.index("$q$", i) + 3
b = s.index("$q$", a)
stmt = s[a:b]
m = re.search(r"'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'", stmt)
assert m, "this case's statement names no uuid to point elsewhere"
# ONE uuid, in ONE case's statement, and nothing else in the file.
patched = stmt[:m.start()] + "'" + DEAD + "'" + stmt[m.end():]
assert patched != stmt
out = s[:a] + patched + s[b:]
assert out.count(DEAD) == 1, "the dead uuid must appear exactly once"
open(dst, "w", encoding="utf-8").write(out)
PATCH

vacuity(){         # vacuity <id> <label-prefix> <case-file>
  local id=$1
  local label=$2
  local file=$3
  local vd=$OUT/vac-$id
  mkdir -p "$vd"
  if ! python3 -I "$PATCHDIR/neuter-case.py" "$HERE/$file" "$vd/$file" "$label" > "$vd/patch.log" 2>&1; then
    say "VACUITY $id: PLANT NOT ESTABLISHED — the case could not be neutered: $(tail -1 "$vd/patch.log")"
    FAILED=1; return
  fi
  if cmp -s "$HERE/$file" "$vd/$file"; then
    say "VACUITY $id: PLANT NOT ESTABLISHED — the copy is identical to the real file, so nothing was neutered"
    FAILED=1; return
  fi
  cases "$vd" "$vd" >/dev/null 2>&1
  if grep -hqF "ERROR:  $label" "$vd"/*.sql.log 2>/dev/null \
     && grep -hqF "FAIL: VACUOUS" "$vd"/*.sql.log 2>/dev/null; then
    say "VACUITY $id: with '$label' pointed at a row that does not exist the case REDS BY NAME (FAIL: VACUOUS), so its pass is conditional on the statement doing something"
  else
    say "VACUITY $id: FAIL — '$label' matched zero rows and still PASSED, which is the defect the sixteenth challenge measured"
    grep -h "PASS permitted" "$vd"/*.sql.log 2>/dev/null | head -2 | tee -a "$OUT/run.log"
    FAILED=1
  fi
}

vacuity a  "I3-a queued -> sent"             p8-real-cases-worker.sql
vacuity b  "I3-b sent -> delivered"          p8-real-cases-worker.sql
vacuity c  "I3-c delivered -> read"          p8-real-cases-worker.sql
vacuity f  "I3-f queued -> failed"           p8-real-cases-worker.sql
vacuity g  "I3-g failed -> delivered"        p8-real-cases-worker.sql
vacuity n6a "N6-a the customer READS"        p8-real-cases-owner.sql
vacuity n6d "N6-d the demotion"              p8-real-cases-owner.sql

# THE CONTROLS, and the first draft of them was WRONG in a way worth keeping.
# I wrote one control — delete the zero-row check alone and require the
# neutered case to pass again — and it FAILED, because the neutered `I3-a` is
# now caught by a SECOND guard: round 25's read-back `I3-a2`, which reads the
# status and finds `queued` where it wants `sent`. So the single control was
# measuring the pair and attributing to the check. Three arms instead, because
# two independent guards need one deletion each plus the pair:
#
#   CTL-1  the check deleted ALONE  -> still fails, but by the READ-BACK's name
#   CTL-2  the read-back deleted ALONE -> still fails, by VACUOUS
#   CTL-3  BOTH deleted -> PASSES, which is `a7a71e8`'s behaviour: the hole
#          returns. Deleting two at once attributes nothing to either, and is
#          legitimate here only because the claim is about the PAIR.
#
# What the structural check buys over the read-backs is therefore not this
# case, which both cover: it is the case nobody has written yet. A read-back is
# per-case and cannot be forgotten only if someone remembers it; the check is
# the default and fails closed.
cat > "$PATCHDIR/drop-vacuity-check.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "    IF n = 0 THEN"
assert s.count(b) == 1, "the vacuity check is not where this patcher expects it"
s = s.replace(b, "    IF false THEN", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/drop-readback.py" <<'PATCH'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding="utf-8").read()
a = s.find("SELECT p8.case_equals('" + label)
assert a >= 0, "no case_equals whose label starts " + label
b = s.index(");", a) + 2
while b < len(s) and s[b] == "\n":
    b += 1
out = s[:a] + s[b:]
assert out.count(label) == 0, "the read-back's label still appears after the deletion"
assert len(out) < len(s)
open(dst, "w", encoding="utf-8").write(out)
PATCH

VSRC=p8-real-cases-worker.sql
VLAB="I3-a queued -> sent"
VRB="I3-a2"

# CTL-2 first: it needs the REAL helpers, so it runs against the baseline that
# is already built and costs no rebuild.
C2=$OUT/vac-ctl2
mkdir -p "$C2"
if python3 -I "$PATCHDIR/neuter-case.py" "$HERE/$VSRC" "$C2/n.sql" "$VLAB" >"$C2/patch.log" 2>&1 \
   && python3 -I "$PATCHDIR/drop-readback.py" "$C2/n.sql" "$C2/$VSRC" "$VRB" >>"$C2/patch.log" 2>&1; then
  cases "$C2" "$C2" >/dev/null 2>&1
  if grep -hqF "FAIL: VACUOUS" "$C2"/*.sql.log 2>/dev/null; then
    say "VACUITY-CTL-2: with the read-back '$VRB' deleted ALONE the neutered case still reds, by VACUOUS — so the zero-row check is a guard in its own right and not a restatement of the read-back"
  else
    say "VACUITY-CTL-2: FAIL — with the read-back gone the neutered case did not red by VACUOUS"
    FAILED=1
  fi
else
  say "VACUITY-CTL-2: PLANT NOT ESTABLISHED — the case could not be neutered with its read-back removed: $(tail -1 "$C2/patch.log")"
  FAILED=1
fi

# CTL-1 and CTL-3 share ONE build with the zero-row check deleted from a copy
# of the helpers. CTL-1 keeps the read-back, CTL-3 drops it too.
C1=$OUT/vac-ctl1
C3=$OUT/vac-ctl3
mkdir -p "$C1" "$C3"
if python3 -I "$PATCHDIR/drop-vacuity-check.py" "$HERE/p8-case-helpers.sql" "$C1/p8-case-helpers.sql" >"$C1/patch.log" 2>&1 \
   && ! cmp -s "$HERE/p8-case-helpers.sql" "$C1/p8-case-helpers.sql" \
   && python3 -I "$PATCHDIR/neuter-case.py" "$HERE/$VSRC" "$C1/$VSRC" "$VLAB" >>"$C1/patch.log" 2>&1 \
   && python3 -I "$PATCHDIR/drop-readback.py" "$C1/$VSRC" "$C3/$VSRC" "$VRB" >>"$C1/patch.log" 2>&1; then
  CASE_HELPERS=$C1/p8-case-helpers.sql
  if build "$HERE/p8-overlay.sql" "$C1/build" >/dev/null 2>&1; then
    cases "$C1" "$C1" >/dev/null 2>&1
    if grep -hqF "ERROR:  $VRB" "$C1"/*.sql.log 2>/dev/null \
       && ! grep -hqF "FAIL: VACUOUS" "$C1"/*.sql.log 2>/dev/null; then
      say "VACUITY-CTL-1: with the zero-row check deleted ALONE the neutered case still reds — by the READ-BACK '$VRB', and NOT by VACUOUS, so the two guards are independent and this arm attributes to the read-back"
    else
      say "VACUITY-CTL-1: FAIL — with the check deleted the case did not red by the read-back's name alone"
      grep -h "FAIL" "$C1"/*.sql.log 2>/dev/null | head -2 | tee -a "$OUT/run.log"
      FAILED=1
    fi
    if cases "$C3" "$C3" >/dev/null 2>&1; then
      say "VACUITY-CTL-3: with BOTH the zero-row check and the read-back deleted the neutered case PASSES (passes=$(cat "$C3/passes")) — the hole of a7a71e8 returns, which is what makes the pair responsible for closing it"
    else
      say "VACUITY-CTL-3: FAIL — with both guards gone the neutered case still did not pass, so something else is closing this route and is unaccounted for"
      grep -h "FAIL" "$C3"/*.sql.log 2>/dev/null | head -2 | tee -a "$OUT/run.log"
      FAILED=1
    fi
  else
    say "VACUITY-CTL-1: PLANT NOT ESTABLISHED — the build with the patched helpers did not come up"
    FAILED=1
  fi
  CASE_HELPERS=$HERE/p8-case-helpers.sql
  build "$HERE/p8-overlay.sql" "$OUT/final-2" >/dev/null && cases "$OUT/final-2" >/dev/null \
    && say "cluster restored to the baseline after the vacuity controls, passes=$(cat "$OUT/final-2/passes")" \
    || { say "FAIL: could not restore the baseline after the vacuity controls"; FAILED=1; }
else
  say "VACUITY-CTL-1: PLANT NOT ESTABLISHED — the patched copies could not be built: $(tail -1 "$C1/patch.log")"
  FAILED=1
fi

say "=== the check's own STANDARD LIBRARY, measured by planting one (round 23, N-17) ==="
# The fourteenth challenge's blocker, reproduced here before it was fixed: the
# check lives inside the tree it judges, so Python put its own directory first
# on sys.path and `hashlib` — which computes every digest — was resolved from
# the subject. A commit that modified a frozen migration AND added
# `proof/hashlib.py` exited 0, printed ANCHOR LEG EXERCISED with the right pin,
# and REPRODUCED the pinned covered-set digest, because that digest is a hash
# over per-file digests and every one of them came from the plant.
#
# The controls run the other way round from this pack's usual ones: what is
# being shown load-bearing is the ABSENCE of isolation. So y12/y13 require the
# guarded forms to red, and y14/y15 delete the guard and require the old
# fail-open to return — including on an honest tree, which is what makes such a
# plant usable by someone who wants the gate quiet rather than broken.
ISO=$OUT/iso
# ROUND 27, S-4 (P3), the other half. `rm -rf "$ISO"` was unchecked, and the
# bind arms below mount INSIDE $ISO. Deleting through a live mount reaches the
# bind SOURCE, which here is the planted copy — recoverable, but it is the
# shape of an accident that is not recoverable elsewhere. So the mount table is
# read first and the run refuses rather than recursing into one, and the
# deletion itself is checked.
if grep -qF " $ISO" /proc/mounts 2>/dev/null; then
  say "ABORT: something is still mounted under $ISO ($(grep -F " $ISO" /proc/mounts | head -1)); refusing to rm -rf through a live mount"
  exit 2
fi
rm -rf "$ISO" || { say "ABORT: $ISO could not be removed, so the plant below would run against last time's files"; exit 2; }
mkdir -p "$ISO/planted" "$ISO/tree/infrastructure/database" "$ISO/clean/infrastructure/database"
for _t in tree clean; do
  cp -r "$REPO/infrastructure/database/migrations" "$ISO/$_t/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$ISO/$_t/infrastructure/database/"
done
printf '\n-- tamper\n' >> "$ISO/tree/infrastructure/database/migrations/0006_rls.sql"
cp "$HERE/p8-frozen-integrity.py" "$ISO/planted/p8-frozen-integrity.py"
# The shim: it delegates to the REAL hashlib from the next entry on sys.path and
# strips the appended bytes before hashing, so every digest it returns is the
# digest of the file as it was BEFORE the tamper.
cat > "$ISO/planted/hashlib.py" <<'SHIM'
import sys, os, importlib.util, importlib.machinery
_d = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.machinery.PathFinder.find_spec(
    'hashlib', [x for x in sys.path if os.path.abspath(x or '.') != _d])
_real = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_real)
class _H:
    def __init__(self, inner): self._i = inner
    def update(self, b): self._i.update(b.replace(b"\n-- tamper\n", b""))
    def hexdigest(self): return self._i.hexdigest()
def sha256(*a, **k): return _H(_real.sha256(*a, **k))
def __getattr__(n): return getattr(_real, n)
SHIM
cat > "$PATCHDIR/unisolate.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = "if not sys.flags.isolated:"
b = "\nif _p8_hit_by is not None:"
assert s.count(a) == 1, "the isolated-mode test is not where this patcher expects it"
assert s.count(b) == 1, "the identity test is not where this patcher expects it"
s = s.replace(a, "if False:", 1).replace(b, "\nif False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH

# ROUND 24, O-2. `unisolate.py` above deletes BOTH tests in one patch, so y14
# and y15 cannot say which of the two closed the route — and the challenger
# measured the consequence: the second test was never exercised by any arm
# (y12 runs isolated, so no entry derived from the tree is on the path; y13
# runs un-isolated, so the FIRST test returns before the second is read), and
# a real defect lived in it unseen for a round. These two helpers exist so the
# second test has arms of its own: one that runs it, and one that deletes it
# ALONE.
cat > "$PATCHDIR/with-path-entry.py" <<'PATCH'
import runpy
import sys
entry, script = sys.argv[1], sys.argv[2]
sys.argv = [script] + sys.argv[3:]
sys.path.insert(0, entry)
runpy.run_path(script, run_name="__main__")
PATCH
# ROUND 25, R-1. The sixteenth challenge measured that `realpath` resolves
# symlinks but does NOT traverse mount points, so a BIND MOUNT of the proof
# directory is caught by the `samefile` reading ALONE — and round 24's comment
# claimed the opposite, which was a measured-false sentence and the reason no
# arm existed. This patcher deletes that one reading, leaving `realpath`
# standing, so arm y20 can hold it responsible for the case only it catches.
cat > "$PATCHDIR/drop-samefile.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "        if _p8os.path.samefile(absolute, _P8_OWN_DIR):"
assert s.count(b) == 1, "the samefile reading is not where this patcher expects it"
s = s.replace(b, "        if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
# ROUND 27, the sixteenth challenger's S-1 (P2). It reverted ONE expression —
# the refusal's `realpath(entry) = <value as read>` back to round 24's
# `which resolves to <the script's own directory>` — and BOTH y17 and y20a still
# passed, because they greped the LABEL of the reason (`matched by realpath`,
# `matched by samefile`) and nothing read the value. The arms now require the
# value, and `y20d` is what holds that requirement responsible: with the
# expression reverted the refusal is still correct about WHICH reading matched,
# and the arm must nevertheless refuse to credit it.
cat > "$PATCHDIR/revert-value.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = '"; realpath(entry) = " + _p8os.path.realpath(_p8os.path.abspath(_p8_hit or "."))'
assert s.count(b) == 1, "the value expression is not where this patcher expects it"
s = s.replace(b, '"; which resolves to " + _P8_OWN_REAL', 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/drop-path-test.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = "if not sys.flags.isolated:"
b = "\nif _p8_hit_by is not None:"
assert s.count(a) == 1, "the isolated-mode test is not where this patcher expects it"
assert s.count(b) == 1, "the identity test is not where this patcher expects it"
# ONLY the second test, and the first one left standing: that is the whole
# point of this patcher next to `unisolate.py`.
s = s.replace(b, "\nif False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH

ISO_OK=1
if [ ! -f "$ISO/planted/hashlib.py" ] || [ ! -s "$ISO/planted/p8-frozen-integrity.py" ]; then
  say "ISOLATION i1: PLANT NOT ESTABLISHED — the planted module or the copied check is missing"
  FAILED=1; ISO_OK=0
elif ! cmp -s "$HERE/p8-frozen-integrity.py" "$ISO/planted/p8-frozen-integrity.py"; then
  say "ISOLATION i2: PLANT NOT ESTABLISHED — the copied check is not byte-identical to the real one, so the arms below would measure a different program"
  FAILED=1; ISO_OK=0
elif [ "$(copied_digest "$REPO/infrastructure/database")" \
     = "$(copied_digest "$ISO/tree/infrastructure/database")" ]; then
  say "ISOLATION i3: PLANT NOT ESTABLISHED — the tamper did not land, so there is nothing for the plant to hide"
  FAILED=1; ISO_OK=0
else
  say "ISOLATION i4: the plant holds — a byte-identical copy of the check, a planted hashlib beside it, and a frozen migration modified in the tree it judges"
fi

if [ "$ISO_OK" = 1 ]; then
  ISO_CLAIM=(--expect-covered "$P8_EXPECT_COVERED" --expect-boundary "$P8_EXPECT_BOUNDARY"
             --expect-covered-digest "$P8_EXPECT_COVERED_DIGEST")
  # y12 — isolated, plant present, tamper present: the plant must not reach it.
  _o=$ISO/y12.log
  if python3 -I "$ISO/planted/p8-frozen-integrity.py" "$ISO/tree" "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
    say "FAIL: GUARD-CTL y12 — with isolated mode the check PASSED on a tampered tree, so the planted module still reached it"
    FAILED=1
  elif grep -qF -e "ANCHOR DRIFT" "$_o"; then
    say "GUARD-CTL y12: isolated, the plant does not reach it — refused by name (ANCHOR DRIFT), so isolated mode is what closes the route"
  else
    say "FAIL: GUARD-CTL y12 — it refused, but not as ANCHOR DRIFT"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
  fi
  # y13 — NOT isolated, guard present: the guard must refuse before any digest.
  _o=$ISO/y13.log
  if python3 "$ISO/planted/p8-frozen-integrity.py" "$ISO/tree" "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
    say "FAIL: GUARD-CTL y13 — started without isolated mode and it PASSED, so the isolation precondition is not load-bearing"
    FAILED=1
  elif grep -qF -e "NOT ISOLATED" "$_o"; then
    say "GUARD-CTL y13: started without \`-I\`, the precondition refuses by name (NOT ISOLATED) before it measures anything"
  else
    say "FAIL: GUARD-CTL y13 — it refused, but not as NOT ISOLATED"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
  fi
  # y14 — the guard DELETED, not isolated, plant and tamper present: the old
  # fail-open must RETURN, or the guard is not what closes the hole.
  _nog=$ISO/planted/no-guard.py
  if ! python3 -I "$PATCHDIR/unisolate.py" "$ISO/planted/p8-frozen-integrity.py" "$_nog" >"$ISO/patch.log" 2>&1; then
    say "ISOLATION i5: PLANT NOT ESTABLISHED — the guard-deletion patcher did not match its anchors"
    head -2 "$ISO/patch.log" | tee -a "$OUT/run.log"; FAILED=1
  else
    _o=$ISO/y14.log
    if python3 "$_nog" "$ISO/tree" "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
      say "GUARD-CTL y14: with the isolation precondition deleted the old fail-open RETURNS (rc 0 on a tampered tree, ANCHOR LEG EXERCISED and the pinned digest both reproduced), so the precondition is what closes it"
    else
      say "FAIL: GUARD-CTL y14 — with the guard deleted the check still refused, so this arm is not measuring the hole it names"
      head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
    fi
    # y15 — the same, on an HONEST tree: the plant must not red it, which is
    # what makes it a bypass rather than a breaker.
    _o=$ISO/y15.log
    if python3 "$_nog" "$ISO/clean" "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
      say "GUARD-CTL y15: the same plant leaves an HONEST tree green, so it is a BYPASS and not a breaker — which is what makes it usable to keep a gate quiet"
    else
      say "FAIL: GUARD-CTL y15 — the plant reddened an honest tree, so y14's green is not evidence about the route"
      head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
    fi
  fi

  # ------------------------------------------------------------------
  # y16/y17/y18 — the SECOND test, which until round 24 no arm reached
  # ------------------------------------------------------------------
  # The construction is the only one that can reach it: isolated mode, so the
  # first test returns, and an entry put on `sys.path` afterwards, which is
  # what `-I` cannot prevent (a `.pth` in site-packages does the same thing
  # outside the subject). Under this pack's real invocation, `python3 -I <abs
  # path>`, no entry derived from the tree is on the path at all, so this is a
  # belt-and-braces test being MEASURED rather than a live route.
  ln -sfn "$ISO/planted" "$ISO/spelling"
  _sl_real=$(cd "$ISO/spelling" && pwd -P)
  if [ ! -L "$ISO/spelling" ] || [ "$_sl_real" != "$ISO/planted" ]; then
    say "ISOLATION i6: PLANT NOT ESTABLISHED — the second spelling is not a symlink to the directory the check lives in, so y17 would measure two different directories"
    FAILED=1
  else
    say "ISOLATION i7: the two spellings hold — '$ISO/spelling' is a symlink resolving to '$ISO/planted', so y16 and y17 differ only in HOW the same directory is named"
    # y16 — the directory by its own name: the second test must refuse.
    _o=$ISO/y16.log
    if python3 -I "$PATCHDIR/with-path-entry.py" "$ISO/planted" \
               "$ISO/planted/p8-frozen-integrity.py" "$ISO/tree" \
               "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
      say "FAIL: GUARD-CTL y16 — isolated mode was on and the subject's own directory was on sys.path, and the check measured anyway"
      FAILED=1
    elif grep -q "NOT ISOLATED" "$_o" && grep -q "still has" "$_o"; then
      say "GUARD-CTL y16: the subject's directory on sys.path under isolated mode is refused by the SECOND test (NOT ISOLATED … still has), which no arm reached before this round"
    else
      say "FAIL: GUARD-CTL y16 — it refused, but not by the second test"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
    fi
    # y17 — the SAME directory under a symlinked name. This is round 15's O-1:
    # the first version of the test compared spelling, so this arm passed the
    # check and the whole fail-open came back. It must refuse, and the refusal
    # must name both the entry as written and what it resolves to.
    _o=$ISO/y17.log
    if python3 -I "$PATCHDIR/with-path-entry.py" "$ISO/spelling" \
               "$ISO/planted/p8-frozen-integrity.py" "$ISO/tree" \
               "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
      say "FAIL: GUARD-CTL y17 — a SYMLINKED spelling of the subject's own directory defeated the second test, which is round 15's O-1 unfixed"
      FAILED=1
    elif grep -q "NOT ISOLATED" "$_o" && grep -q "matched by realpath" "$_o" \
         && grep -qF "realpath(entry) = $ISO/planted" "$_o"; then
      say "GUARD-CTL y17: a symlinked spelling of the same directory is refused on IDENTITY, the refusal names WHICH reading matched (realpath) AND prints realpath(entry) as read — round 27: greping the LABEL of the reason leaves the VALUE it reports unarmed, and the value is the expression round 24 got wrong"
    else
      say "FAIL: GUARD-CTL y17 — it refused, but this arm requires THREE things of the message and one is missing: the NOT ISOLATED refusal, 'matched by realpath' as the reading, and realpath(entry) printed as the value read"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
    fi
    # y18 — the second test DELETED ALONE, first test left standing. Without
    # this control y16/y17 prove only that something refused; with it, the
    # refusal is attributed to the second test, and the hole it closes is shown
    # to be a real one: rc 0 on a tampered tree with the plant in play.
    _nop=$ISO/planted/no-path-test.py
    if ! python3 -I "$PATCHDIR/drop-path-test.py" "$ISO/planted/p8-frozen-integrity.py" "$_nop" >"$ISO/patch2.log" 2>&1; then
      say "FAIL: GUARD-CTL y18 — the second test could not be deleted alone, so the arms above are unattributed"
      head -2 "$ISO/patch2.log" | tee -a "$OUT/run.log"; FAILED=1
    else
      _o=$ISO/y18.log
      if python3 -I "$PATCHDIR/with-path-entry.py" "$ISO/spelling" "$_nop" "$ISO/tree" \
                 "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
        say "GUARD-CTL y18: with the second test deleted ALONE the fail-open returns (rc 0 on a tampered tree), so y16 and y17 are the second test's own arms and the route is real"
      else
        say "FAIL: GUARD-CTL y18 — with the second test deleted the check still refused, so y16/y17 are not measuring that test"
        head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
      fi
    fi

  fi

  # ----------------------------------------------------------------
  # y20 — the `samefile` reading, which round 24 called untestable
  # ----------------------------------------------------------------
  # ROUND 25, R-1 (P1, measured-false). `realpath` resolves symlinks and does
  # NOT traverse mount points, so a bind mount of the proof directory is the
  # case `samefile` alone catches. Round 24 asserted the opposite and called
  # the reading UNEXERCISED; the arm is three lines. It needs mount
  # privileges, and a missing privilege is a PLANT NOT ESTABLISHED under its
  # own name — never a silent skip, because a skipped arm reads exactly like
  # a passing one.
  #
  # ROUND 27, S-3 (P3). These three arms used to sit inside the `else` of the
  # SYMLINK plant, so a container where `ln -sfn` failed reddened on the
  # spelling plant and then ran NO bind arm and named none — which is the
  # silent skip the paragraph above forbids, two conditions deep. No-symlink
  # and no-mount-namespace are different conditions and each gets its own
  # sentence, so the block is hoisted to sit directly under the plant it
  # actually depends on.
  BINDPOINT=$ISO/bindpoint
  mkdir -p "$BINDPOINT"
  if ! mount --bind "$ISO/planted" "$BINDPOINT" 2>"$ISO/bind.log"; then
    say "ISOLATION i8: PLANT NOT ESTABLISHED — this container may not bind-mount ($(head -1 "$ISO/bind.log")), so the one spelling the samefile reading exists for cannot be built here"
    FAILED=1
  else
    # The arm's own precondition, measured rather than assumed: the bind path
    # must NOT resolve through (or `realpath` would catch it and the arm would
    # be attributing the wrong reading), and it must be the same inode.
    _pre=$(python3 -I -c "
import os, sys
b, srcdir = sys.argv[1], sys.argv[2]
print('rp-differs' if os.path.realpath(b) != os.path.realpath(srcdir) else 'rp-same',
    'same-inode' if os.path.samefile(b, srcdir) else 'other-inode')" "$BINDPOINT" "$ISO/planted")
    if [ "$_pre" != "rp-differs same-inode" ]; then
      say "ISOLATION i9: PLANT NOT ESTABLISHED — the bind mount is not the shape this arm measures (got '$_pre'); on a platform where realpath traverses the mount, y16's reading would catch it and y20 would attribute the wrong one"
      FAILED=1
    else
      say "ISOLATION i10: the bind spelling holds — realpath differs and the inode is the same, which is the one case the samefile reading exists for"
      # Unpatched: the bind spelling must refuse, and the refusal must say
      # WHICH reading caught it.
      _o=$ISO/y20a.log
      if python3 -I "$PATCHDIR/with-path-entry.py" "$BINDPOINT" \
                 "$ISO/planted/p8-frozen-integrity.py" "$ISO/tree" \
                 "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
        say "FAIL: GUARD-CTL y20a — a bind mount of the subject's own directory was on sys.path and the check measured anyway"
        FAILED=1
      elif grep -q "NOT ISOLATED" "$_o" && grep -q "matched by samefile" "$_o" \
           && grep -qF "realpath(entry) = $BINDPOINT" "$_o"; then
        say "GUARD-CTL y20a: a BIND MOUNT of the same directory is refused, the refusal names samefile as the reading that caught it, AND it prints realpath(entry) = the bind path AS READ — not the script's own directory, which is the expression round 24 got wrong and that no arm read"
      else
        say "FAIL: GUARD-CTL y20a — it refused, but not by the samefile reading"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
      fi
      # The attribution: that reading DELETED ALONE, realpath left standing.
      _nos=$ISO/planted/no-samefile.py
      if ! python3 -I "$PATCHDIR/drop-samefile.py" "$ISO/planted/p8-frozen-integrity.py" "$_nos" >"$ISO/patch3.log" 2>&1; then
        say "FAIL: GUARD-CTL y20 — the samefile reading could not be deleted alone, so y20a is unattributed"
        head -2 "$ISO/patch3.log" | tee -a "$OUT/run.log"; FAILED=1
      else
        _o=$ISO/y20b.log
        if python3 -I "$PATCHDIR/with-path-entry.py" "$BINDPOINT" "$_nos" "$ISO/tree" \
                   "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
          say "GUARD-CTL y20b: with the samefile reading deleted ALONE the bind spelling goes rc 0 on a tampered tree, so that reading is the only thing standing between it and the planted module — round 24's 'UNEXERCISED' sentence was false"
        else
          say "FAIL: GUARD-CTL y20b — with the samefile reading deleted the bind spelling was still refused, so y20a is not measuring that reading"
          head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
        fi
        # And the deletion must be SURGICAL: the plain spelling must still be
        # refused by the reading that was left standing.
        _o=$ISO/y20c.log
        if python3 -I "$PATCHDIR/with-path-entry.py" "$ISO/planted" "$_nos" "$ISO/tree" \
                   "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1; then
          say "FAIL: GUARD-CTL y20c — deleting the samefile reading also disabled the realpath one, so y20b's green says nothing about which reading matters"
          FAILED=1
        elif grep -q "matched by realpath" "$_o"; then
          say "GUARD-CTL y20c: the same deletion leaves the plain spelling refused by realpath, so y20b measured ONE reading and not the whole test"
        else
          say "FAIL: GUARD-CTL y20c — the plain spelling refused, but not by realpath"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
        fi
      fi
      # y20d — the arm's OWN requirement, held responsible. With round 24's
      # wrong value expression put back, the refusal still names the right
      # reading, so every label grep still matches; only the VALUE differs.
      # This arm requires that y20a's value requirement would have caught it.
      _rev=$ISO/planted/reverted-value.py
      if ! python3 -I "$PATCHDIR/revert-value.py" "$ISO/planted/p8-frozen-integrity.py" "$_rev" >"$ISO/patch4.log" 2>&1; then
        say "FAIL: GUARD-CTL y20d — round 24's value expression could not be put back, so y20a's value requirement is unattributed"
        head -2 "$ISO/patch4.log" | tee -a "$OUT/run.log"; FAILED=1
      else
        _o=$ISO/y20d.log
        python3 -I "$PATCHDIR/with-path-entry.py" "$BINDPOINT" "$_rev" "$ISO/tree" \
                   "${ANCHOR_ARGS[@]}" "${ISO_CLAIM[@]}" >"$_o" 2>&1
        if grep -q "matched by samefile" "$_o" \
           && ! grep -qF "realpath(entry) = $BINDPOINT" "$_o"; then
          say "GUARD-CTL y20d: with round 24's value expression put back the refusal still names samefile — every LABEL grep still matches — and y20a's value requirement does NOT, so the requirement is what reads the value and not the label"
        else
          say "FAIL: GUARD-CTL y20d — the reverted value expression was not distinguishable by y20a's own requirement, so greping the value adds nothing and S-1 is not closed"
          head -3 "$_o" | tee -a "$OUT/run.log"; FAILED=1
        fi
      fi
    fi
    # ----------------------------------------------------------------
  # y21 — the OTHER TWO COPIES of the identity guard, armed
  # ----------------------------------------------------------------
  # ROUND 27, the coordinator's F-1 (P1, MEASURED-FALSE). `p8-plant.py` and
  # `p8-mutants.py` carry the same identity guard and the same docstring, and
  # that docstring says "Arm `y20` deletes this reading alone". It does not:
  # every `y20` arm patches `p8-frozen-integrity.py`, and the coordinator
  # measured that deleting the `samefile` reading in either of the other two
  # leaves gate 6 at `FAILED=0`. A sentence that credits an arm to a file no arm
  # touches is the same defect family as round 24's: prose that a reader would
  # ACT on, and that is not true of the thing it describes.
  #
  # Both halves of the ruling are done rather than the cheaper one. These arms
  # delete the reading in each copy, one deletion per copy, and require the
  # refusal to go away BY NAME; and the block itself is then held identical
  # across the three programs by bytes, so arming one copy keeps meaning
  # something about the others.
  # ROUND 28, F-C. The control below DELETES the identity guard and then runs
  # the program for real. `p8-plant.py` renames and deletes frozen migration
  # files under its CURRENT DIRECTORY, and round 27's version of this arm passed
  # the caller's cwd straight through: from the proof directory the program
  # refused with "no migrations copy" — so the control was VACUOUS and still
  # printed its pass, because it asserted a NEGATIVE ("no longer refused on
  # isolation") that any other refusal satisfies — and from the repository root
  # it renumbered all 80 frozen migrations. One arm, two defects, and the worse
  # one was the quiet one.
  #
  # So each control now runs in a PRIVATE SANDBOX it creates, and asserts
  # POSITIVELY that the program got past the isolation test and did its own
  # work: the plant must report the rename it made, the mutant must leave a
  # changed overlay. And after the plant control, the REPOSITORY's own frozen
  # tree is compared against the digest taken before it ran, because the one
  # thing F-C proved is that this gate could damage the tree it judges.
  _psb=$ISO/plant-sandbox
  rm -rf "$_psb"; mkdir -p "$_psb/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$_psb/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$_psb/infrastructure/database/"
  sandbox_marker "$_psb"
  _frozen_before=$( (ls "$REPO/infrastructure/database/migrations"; sha256sum "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" | cut -d' ' -f1) | sha256sum | cut -d' ' -f1)
  for _prog in p8-plant.py p8-mutants.py; do
    case "$_prog" in
      p8-plant.py)   _tag=y21a; _ctl=y21b; _args="tail-renumber"; _expect="PLANT FAIL: NOT ISOLATED";;
      p8-mutants.py) _tag=y21c; _ctl=y21d; _args="1 $ISO/mut-overlay.sql"; _expect="MUTANT FAIL: NOT ISOLATED";;
    esac
    cp "$HERE/$_prog" "$ISO/planted/$_prog"
    cp "$HERE/p8-overlay.sql" "$ISO/mut-overlay.sql"
    # Unpatched: the bind spelling must refuse, naming the reading. It refuses at
    # IMPORT, before either program looks at a path, which is why this half is
    # safe to run anywhere.
    _o=$ISO/$_tag.log
    if ( cd "$_psb" && python3 -I "$PATCHDIR/with-path-entry.py" "$BINDPOINT" \
               "$ISO/planted/$_prog" $_args ) >"$_o" 2>&1; then
      say "FAIL: GUARD-CTL $_tag — $_prog ran with a bind mount of its own directory on sys.path and did not refuse"
      FAILED=1
    elif grep -qF "$_expect" "$_o" && grep -q "matched by samefile" "$_o"; then
      say "GUARD-CTL $_tag: $_prog refuses the BIND spelling by its own name ($_expect) and names samefile as the reading — this copy now has an arm of its own, which is what F-1 said the docstring was claiming without one"
    else
      say "FAIL: GUARD-CTL $_tag — $_prog refused, but not by its own NOT ISOLATED refusal naming samefile"
      head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
    fi
    # The attribution: that reading deleted ALONE in THIS copy, run in the
    # sandbox, and required to SHOW that it got through.
    _nos2=$ISO/planted/no-samefile-$_prog
    if ! python3 -I "$PATCHDIR/drop-samefile.py" "$ISO/planted/$_prog" "$_nos2" >"$ISO/patch-$_tag.log" 2>&1; then
      say "FAIL: GUARD-CTL $_ctl — the samefile reading could not be deleted from $_prog alone, so $_tag is unattributed"
      head -2 "$ISO/patch-$_tag.log" | tee -a "$OUT/run.log"; FAILED=1
    else
      _o=$ISO/$_ctl.log
      ( cd "$_psb" && python3 -I "$PATCHDIR/with-path-entry.py" "$BINDPOINT" "$_nos2" $_args ) >"$_o" 2>&1
      # The POSITIVE evidence, per program: work that only a program past the
      # isolation test can have done.
      case "$_prog" in
        p8-plant.py)   _did=$(grep -c "^renamed [0-9]*," "$_o" || true); _what="reported the rename it planted in its sandbox";;
        p8-mutants.py) _did=0; cmp -s "$HERE/p8-overlay.sql" "$ISO/mut-overlay.sql" || _did=1; _what="left a CHANGED overlay copy behind";;
      esac
      if grep -qF "$_expect" "$_o"; then
        say "FAIL: GUARD-CTL $_ctl — with the samefile reading deleted from $_prog the bind spelling was STILL refused on isolation, so $_tag is not measuring that reading"
        head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
      elif [ "$_did" != 1 ]; then
        say "FAIL: GUARD-CTL $_ctl — with the reading deleted $_prog was not refused on isolation, but it did not $_what either, so this control asserts a NEGATIVE that any other refusal satisfies — which is exactly how it was vacuous at e6e3c6e"
        head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
      else
        say "GUARD-CTL $_ctl: with the samefile reading deleted ALONE from $_prog the bind spelling gets PAST the isolation test and $_what in a private sandbox, so that reading is this copy's own guard and the control is not satisfied by some other refusal"
      fi
    fi
  done
  # And the tree this gate judges is untouched by the control that deletes the
  # guard protecting it. This is F-C stated as a measurement rather than as a
  # promise.
  _frozen_after=$( (ls "$REPO/infrastructure/database/migrations"; sha256sum "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" | cut -d' ' -f1) | sha256sum | cut -d' ' -f1)
  if [ "$_frozen_before" = "$_frozen_after" ]; then
    say "ISOLATION i11: the repository's own frozen set is unchanged by the guard-deletion controls — the file list and the manifest digest together hash to $_frozen_after before and after, measured around the arm that renumbered all 80 of them at e6e3c6e"
  else
    say "FAIL: ISOLATION — the guard-deletion controls CHANGED the repository's frozen set ($_frozen_before -> $_frozen_after), which is the standing instruction this gate exists to keep"
    FAILED=1
  fi
  # And the block is the SAME block in all three: arming one copy says something
  # about the others only while they are identical, and a divergence is how a
  # guard quietly loses a reading in one file. The comparison is made between
  # the sentinels `P8-IDENTITY-GUARD-BEGIN`/`-END`, which bound the EXECUTABLE
  # region — the docstring above it legitimately differs, because each copy
  # names its own arms — and with ONE declared normalisation: each program's
  # refusal names itself (`INTEGRITY FAIL`, `PLANT FAIL`, `MUTANT FAIL`), which
  # is deliberate, so that prefix is replaced by a token before comparing.
  # Declaring the normalisation is the point: an unnormalised "identical" claim
  # would be false, and a silently normalised one would hide a real divergence.
  _gb=$ISO/guardblock
  mkdir -p "$_gb"
  for _prog in p8-frozen-integrity.py p8-plant.py p8-mutants.py; do
    sed -n '/P8-IDENTITY-GUARD-BEGIN/,/P8-IDENTITY-GUARD-END/p' "$HERE/$_prog" \
      | sed -E 's/"(INTEGRITY|PLANT|MUTANT) FAIL: /"<SELF> FAIL: /' > "$_gb/$_prog.block"
  done
  _gbl=$(wc -l < "$_gb/p8-frozen-integrity.py.block" | xargs)
  if [ "$_gbl" -lt 20 ]; then
    say "FAIL: ISOLATION — the identity guard extracted to only $_gbl lines, so the sentinels have moved and this comparison is measuring the wrong region"
    FAILED=1
  elif cmp -s "$_gb/p8-frozen-integrity.py.block" "$_gb/p8-plant.py.block" \
     && cmp -s "$_gb/p8-frozen-integrity.py.block" "$_gb/p8-mutants.py.block"; then
    say "ISOLATION i12: the identity guard is IDENTICAL in all three programs ($_gbl lines between the sentinels, with each program's own FAIL prefix normalised to <SELF> and nothing else), so y20 and y21 measure the same block and a divergence reds here rather than in a reader's assumption"
  else
    say "FAIL: ISOLATION — the identity guard is NOT identical across the three programs, so an arm on one says nothing about the others"
    for _prog in p8-plant.py p8-mutants.py; do diff "$_gb/p8-frozen-integrity.py.block" "$_gb/$_prog.block" | head -4 | tee -a "$OUT/run.log"; done
    FAILED=1
  fi

  # ROUND 27, S-4 (P3). This was the one statement in the section that did not
  # fail closed: a NOTE with no `FAILED`. A bind mount left behind sits inside
  # this run's own output directory, and the next run's `rm -rf "$ISO"` would
  # then be deleting through a live mount — so it is a refusal, and the mount
  # is left in place rather than removed under a reader's feet.
  if ! umount "$BINDPOINT" 2>"$ISO/umount.log"; then
    say "FAIL: ISOLATION — the bind mount at $BINDPOINT could not be unmounted ($(head -1 "$ISO/umount.log")); it is INSIDE this run's output directory, so a later rm -rf would delete through a live mount. Failing rather than reporting a note"
    FAILED=1
  fi
  fi
fi

# ---------------------------------------------------------------------
# 5  The RETIREMENT of the prototype gate, measured (round 22, OD-P8-14)
# ---------------------------------------------------------------------
# A retirement that is only written down is a claim. Three things are measured
# here: the files are still PRESENT (retired, never deleted), the retired runner
# REFUSES rather than runs, and no live gate list still names it. The name is
# built by concatenation so that this arm is not its own match — the same
# lesson as the y7 sentinels, which counted themselves.
say "=== the retirement of the prototype gate, measured ==="
RET_DIR=$HERE/retired
# ROUND 24. The SET is declared once, here, in the concatenated form, and both
# arms below read it: the presence check and the net. The first version of this
# round's widened net caught THIS FILE, because the presence list spelled the
# five case files plainly a few lines above — the y7 lesson one level up, where
# what the net matched was not a sentinel but the arm's own inventory. One
# declaration also means a retired file cannot be present-checked and left out
# of the net, or the reverse.
#
# The first element is the runner's STEM, so the net catches the runner with or
# without `.sh` (round 15's O-3 measured the extensionless spelling slipping
# through), and the presence check appends the extension to it.
RET_NET=("run-p8-ddl""-proof" "p8-ddl""-prototype.sql" "p8-ddl""-cases.sql"
         "p8-role""-cases-app.sql" "p8-role""-cases-worker.sql" "p8-role""-cases-webhook.sql")
RET_RUNNER="${RET_NET[0]}.sh"
RET_FILES=("$RET_RUNNER" "${RET_NET[@]:1}")
RET_MISSING=
for _f in "${RET_FILES[@]}"; do
  [ -f "$RET_DIR/$_f" ] || RET_MISSING="$RET_MISSING $_f"
done
if [ -n "$RET_MISSING" ]; then
  say "FAIL: RETIREMENT — a retired file is MISSING, so it was deleted rather than retired:$RET_MISSING"
  FAILED=1
else
  say "RETIREMENT n1: all six retired files are present under retired/, none deleted"
fi

# The retired runner must refuse. A retired gate that still executes is a gate.
if [ -f "$RET_DIR/$RET_RUNNER" ]; then
  RET_OUT=$(bash "$RET_DIR/$RET_RUNNER" 2>&1); RET_RC=$?
  if [ "$RET_RC" -eq 0 ]; then
    say "FAIL: RETIREMENT — the retired runner exited 0, so it still runs"
    FAILED=1
  elif ! printf '%s' "$RET_OUT" | grep -qF -e "RETIRED: this gate was retired"; then
    say "FAIL: RETIREMENT — the retired runner refused (rc $RET_RC) without saying it is retired, so a reader sees a broken gate rather than a retired one"
    FAILED=1
  else
    say "RETIREMENT n2: the retired runner refuses by name (rc $RET_RC) and says what covers it now"
  fi
fi

# And no LIVE gate list may still name it. Permitted homes: the retired
# directory itself, and this arm (which holds no literal). Anything else is a
# list that would send a reader to a gate that does not run. The repository is
# scanned rather than the manifest, because the manifest is not in the tree.
# ROUND 24, O-3. Until this round the net held ONE spelling of ONE of the six
# retired files. The challenger measured two sentences that slipped through: a
# gate list naming the runner WITHOUT its `.sh`, and a gate list naming the
# prototype's own SQL file instead of its runner. A reader sent to either goes
# to a gate that does not run, which is the whole purpose of this arm. The set
# is now declared once above, in the concatenated form, and the examples are
# NOT quoted here — a comment that spells the names is itself a hit, which is
# how the first version of this fix reddened on this very file. The sentences
# are reproduced in the handoff, which is not in the tree being scanned.
RET_ARGS=()
for _n in "${RET_NET[@]}"; do RET_ARGS+=(-e "$_n"); done

# ROUND 24. A clean scan is not evidence about the spellings a net cannot see,
# which is how O-3 stood for two rounds: the arm reported "no file names it" and
# was right about the one spelling it knew. So the net is PLANTED first, in a
# temporary directory OUTSIDE the repository (the live scan must not see these
# sentences), with every spelling built from the declared set rather than typed
# — a planted sentence typed here would be a hit on this file. Three sentences
# must be caught and one must NOT be: a net that matches everything proves as
# little as one that matches nothing.
NET_T=$OUT/retnet
rm -rf "$NET_T"; mkdir -p "$NET_T"
printf 'gate 11: bash proof/%s\n' "$RET_RUNNER"     > "$NET_T/full.md"
printf 'gate 11: the prototype via proof/%s\n' "${RET_NET[0]}" > "$NET_T/stem.md"
printf 'the DDL prototype proof (%s) must pass\n' "${RET_NET[1]}" > "$NET_T/sqlname.md"
printf 'gate 6: bash proof/run-p8-real-proof.sh\n'  > "$NET_T/control.md"
NET_HITS=$(grep -rlI "${RET_ARGS[@]}" "$NET_T" 2>/dev/null | sed 's#.*/##' | sort | tr '\n' ' ')
if [ "$NET_HITS" = "full.md sqlname.md stem.md " ]; then
  say "RETIREMENT-NET y19: the net catches the runner's full name, its extensionless stem and a list naming a retired case file, and does NOT match the live gate's own line"
else
  say "FAIL: RETIREMENT-NET y19 — the net caught [$NET_HITS] instead of exactly the three planted spellings, so the scan below is not evidence about the spellings it misses"
  FAILED=1
fi

RET_HITS=$(grep -rlI --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=retired \
                     --exclude-dir=dist --exclude-dir=coverage \
                     "${RET_ARGS[@]}" "$REPO" 2>/dev/null || true)
if [ -n "$RET_HITS" ]; then
  say "FAIL: RETIREMENT — a live file still names a retired file, so some list points at a gate that does not run:"
  printf '%s\n' "$RET_HITS" | tee -a "$OUT/run.log"
  for _f in $RET_HITS; do
    grep -nI "${RET_ARGS[@]}" "$_f" 2>/dev/null | head -3 | tee -a "$OUT/run.log"
  done
  FAILED=1
else
  say "RETIREMENT n3: no file outside retired/ names any of the ${#RET_NET[@]} retired spellings (the runner with or without .sh, and each retired case file), so no live list points at it"
fi

# ---------------------------------------------------------------------
# SANDBOX: the F-C refusal gets an arm of its own (round 29, U-6)
# ---------------------------------------------------------------------
# `PLANT FAIL: NOT A SANDBOX` is what this range offered as the answer to the
# worst defect the phase has found in its own apparatus, and nothing in the gate
# ever ran a plant in a tree without the marker, because the runner writes the
# marker into every copy it makes. The refusal was correct and load-bearing —
# the nineteenth challenge measured that independently — and its removal cost
# the gate nothing, which is precisely the condition this project's own rule
# names: a fail-open fix is done only when DELETING it reds a gate, read by
# refusal name.
#
# So: two copies of the migrations tree, one WITHOUT the marker and one with.
# The unmarked copy must be refused BY NAME, must exit 2, and must come out
# byte-identical afterwards; the marked copy must let the plant land. Then the
# guard itself is deleted from a patched copy of the program and the unmarked
# tree must be renumbered, so the refusal is what stands between the two
# outcomes.
SBX=$OUT/sandbox-arm
rm -rf "$SBX"; mkdir -p "$SBX/bare/infrastructure/database" "$SBX/marked/infrastructure/database"
cp -r "$REPO/infrastructure/database/migrations" "$SBX/bare/infrastructure/database/"
cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$SBX/bare/infrastructure/database/"
cp -r "$SBX/bare/infrastructure/database/migrations" "$SBX/marked/infrastructure/database/"
cp "$SBX/bare/infrastructure/database/MIGRATION_MANIFEST.json" "$SBX/marked/infrastructure/database/"
sandbox_marker "$SBX/marked"
_sbx_digest(){ ( cd "$1/infrastructure/database" \
  && find migrations -type f | LC_ALL=C sort | xargs -r sha256sum; sha256sum MIGRATION_MANIFEST.json ) \
  | sha256sum | cut -d' ' -f1; }
SBX_BEFORE=$(_sbx_digest "$SBX/bare")
if [ ! -f "$SBX/bare/infrastructure/database/.p8-sandbox" ] \
   && [ -f "$SBX/marked/infrastructure/database/.p8-sandbox" ]; then
  _sb_out=$( cd "$SBX/bare" && python3 -I "$HERE/p8-plant.py" tail-renumber 2>&1 ); _sb_rc=$?
  SBX_AFTER=$(_sbx_digest "$SBX/bare")
  if [ "$_sb_rc" = 2 ] && printf '%s' "$_sb_out" | grep -qF "NOT A SANDBOX" \
     && [ "$SBX_AFTER" = "$SBX_BEFORE" ]; then
    say "SANDBOX y24: a migrations tree with no marker is refused BY NAME (PLANT FAIL: NOT A SANDBOX, rc 2) and comes out byte-identical — the digest of its file list is $SBX_BEFORE before and after, so the refusal happened before any rename"
  else
    say "FAIL: SANDBOX y24 — an unmarked tree was not refused by name and left untouched: rc=$_sb_rc digest ${SBX_BEFORE} -> ${SBX_AFTER}: $(printf '%s' "$_sb_out" | head -1)"
    FAILED=1
  fi
  _sm_out=$( cd "$SBX/marked" && python3 -I "$HERE/p8-plant.py" tail-renumber 2>&1 ); _sm_rc=$?
  if [ "$_sm_rc" = 0 ] && printf '%s' "$_sm_out" | grep -qE "^renamed [0-9]+,"; then
    say "SANDBOX y25: the SAME tree WITH the marker is planted — $(printf '%s' "$_sm_out" | grep -m1 -E '^renamed [0-9]+,') — so y24 measured the marker and not an unrelated refusal"
  else
    say "FAIL: SANDBOX y25 — a marked tree did not plant (rc=$_sm_rc), so y24's refusal cannot be attributed to the marker: $(printf '%s' "$_sm_out" | head -1)"
    FAILED=1
  fi
else
  say "SANDBOX y24: PLANT NOT ESTABLISHED — the two copies do not differ in the marker, so there is nothing for this arm to measure"
  FAILED=1
fi
cat > "$PATCHDIR/drop-sandbox-guard.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "    if declared != SANDBOX_TOKEN:"
assert s.count(b) == 1, "the sandbox requirement is not where this patcher expects it"
s = s.replace(b, "    if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
if python3 -I "$PATCHDIR/drop-sandbox-guard.py" "$HERE/p8-plant.py" "$SBX/no-sandbox-guard.py" \
     >"$SBX/patch.log" 2>&1; then
  rm -rf "$SBX/bare2"; mkdir -p "$SBX/bare2/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$SBX/bare2/infrastructure/database/"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$SBX/bare2/infrastructure/database/"
  _b2_before=$(_sbx_digest "$SBX/bare2")
  _sd_out=$( cd "$SBX/bare2" && python3 -I "$SBX/no-sandbox-guard.py" tail-renumber 2>&1 ); _sd_rc=$?
  _b2_after=$(_sbx_digest "$SBX/bare2")
  if [ "$_sd_rc" = 0 ] && printf '%s' "$_sd_out" | grep -qE "^renamed [0-9]+," \
     && [ "$_b2_after" != "$_b2_before" ]; then
    say "SANDBOX-CTL y26: with the sandbox requirement deleted ALONE the same unmarked tree is RENUMBERED — $(printf '%s' "$_sd_out" | grep -m1 -E '^renamed [0-9]+,') — and its digest moves, so that one condition is the whole of what stands between this program and a tree nobody declared disposable"
  else
    say "FAIL: SANDBOX-CTL y26 — with the requirement deleted the unmarked tree was not renumbered (rc=$_sd_rc, digest ${_b2_before} -> ${_b2_after}), so y24 attributes to something else: $(printf '%s' "$_sd_out" | head -1)"
    FAILED=1
  fi
else
  say "SANDBOX-CTL y26: PLANT NOT ESTABLISHED — the sandbox requirement could not be deleted: $(tail -1 "$SBX/patch.log")"
  FAILED=1
fi
if [ -e "$REPO/infrastructure/database/.p8-sandbox" ]; then
  say "FAIL: SANDBOX — the REPOSITORY itself now carries a sandbox marker, which would make every refusal above vacuous"
  FAILED=1
fi

# ---------------------------------------------------------------------
# CORE-NET: the one door into the witness law, kept to one (round 29, U-7)
# ---------------------------------------------------------------------
# Round 28 closed F-A by DELETING `case_refuses_unwitnessed`, on the reasoning
# that a second door a comment asks people not to use is still a door. The same
# commit's refactor introduced `p8.case_refuses_core(label, stmt, expect,
# witnessed BOOLEAN)` and the nineteenth challenge walked through it with
# `witnessed := true`, no witness and a dead uuid: F-A on the head that closes
# F-A (U-7, P1).
#
# The function itself is narrowed in the helper — its fourth argument is a
# SUBJECT it verifies is bound into the statement, not a boolean it believes —
# but a direct caller can still supply both and skip the witness, and REVOKE is
# not available because the wrappers are not SECURITY DEFINER. So the
# enforceable closure is STATIC, in the shape the pack already uses for retired
# script names: the gate scans every live case file for a direct call and reds
# BY NAME. The net is PLANTED first, outside the repository, because a clean
# scan is not evidence about a spelling the net cannot see — O-3's lesson, which
# this file has paid for once.
CORE_NEEDLE='case_refuses_core'
CORE_T=$OUT/corenet
rm -rf "$CORE_T"; mkdir -p "$CORE_T"
printf 'SELECT p8.%s(%s);\n' "$CORE_NEEDLE" "'L', 'SELECT 1', 'denied', NULL" > "$CORE_T/direct.sql"
printf 'SELECT p8.%s (%s);\n' "$CORE_NEEDLE" "'L', 'SELECT 1', 'denied', NULL" > "$CORE_T/spaced.sql"
printf 'SELECT p8.case_refuses(%s);\n' "'L', 'SELECT 1', 'denied'" > "$CORE_T/control.sql"
CORE_NET_HITS=$(grep -rlIF -e "$CORE_NEEDLE" "$CORE_T" 2>/dev/null | sed 's#.*/##' | sort | tr '\n' ' ')
if [ "$CORE_NET_HITS" = "direct.sql spaced.sql " ]; then
  say "CORE-NET y22: the net catches a direct call to the core helper with and without a space before its parenthesis, and does NOT match a call to the wrapper, so the scan below is evidence about the spellings it is looking for"
else
  say "FAIL: CORE-NET y22 — the net caught [$CORE_NET_HITS] instead of exactly the two planted spellings"
  FAILED=1
fi
CORE_HITS=$(grep -lIF -e "$CORE_NEEDLE" "$HERE"/p8-real-cases-*.sql 2>/dev/null || true)
if [ -n "$CORE_HITS" ]; then
  say "FAIL: CORE-NET — a live case file calls the core helper directly, which is the door U-7 walked through: the witness law holds only while every case goes through a wrapper"
  printf '%s\n' "$CORE_HITS" | tee -a "$OUT/run.log"
  for _f in $CORE_HITS; do grep -nIF -e "$CORE_NEEDLE" "$_f" | head -3 | tee -a "$OUT/run.log"; done
  FAILED=1
else
  say "CORE-NET: no live case file calls p8.case_refuses_core directly, so every refuses-case in this run went through a wrapper and owes a witness"
fi
# And the control: PLANT such a call into a COPY of a case file and require the
# same scan to catch it. A scan that has never caught anything is a scan whose
# pattern nobody has measured.
CORE_C=$OUT/corenet-ctl
rm -rf "$CORE_C"; mkdir -p "$CORE_C"
cp "$HERE/p8-real-cases-app.sql" "$CORE_C/p8-real-cases-app.sql"
printf 'SELECT p8.%s(%s);\n' "$CORE_NEEDLE" "'planted', 'SELECT 1', 'denied', NULL" \
  >> "$CORE_C/p8-real-cases-app.sql"
if grep -lIF -e "$CORE_NEEDLE" "$CORE_C"/p8-real-cases-*.sql >/dev/null 2>&1; then
  say "CORE-NET-CTL y23: with a direct call planted into a copy of a case file the same scan catches it, so the clean result above is a measurement and not the absence of one"
else
  say "FAIL: CORE-NET-CTL y23 — the planted direct call was NOT caught, so the scan above says nothing"
  FAILED=1
fi

# ---------------------------------------------------------------------
# The CENSUS's OWN arms (round 28, T-1)
# ---------------------------------------------------------------------
# Round 26b gave the arm count a program and called it a conservation law. The
# eighteenth challenge measured that an ARRIVAL is refused and a DEPARTURE is
# not: it silenced one arm's own report in this runner, changed nothing else,
# and the gate came back `ARM CENSUS: 96 named arms` / `FAILED=0`. 97 to 96,
# green. So the census now declares the SET and refuses in both directions, and
# the refusals get arms of their own — because the last two rounds are a record
# of what an unarmed guard is worth.
cat > "$PATCHDIR/drop-census-missing.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "    missing = [a for a in declared if a not in seen_count]"
assert s.count(b) == 1, "the ARM MISSING check is not where this patcher expects it"
s = s.replace(b, "    missing = []", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/drop-census-unknown.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
# Anchored on the CENSUS path's own message, not on the --seal branch's, which
# carries the same `if unknown:` and comes first in the file.
b = '''            "CENSUS FAIL: ARM LABEL UNKNOWN — these lines are arm-shaped and "'''
assert s.count(b) == 1, "the unknown-label refusal is not where this patcher expects it"
i = s.index(b)
j = s.rindex("    if unknown:", 0, i)
s = s[:j] + "    if False:" + s[j + len("    if unknown:"):]
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/census-declare-twice.py" <<'PATCH'
import re
import subprocess
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
m = re.search(r'\n    \("GUARD-CTL y20c", 1\),', s)
assert m, "the declaration does not hold GUARD-CTL y20c with a count of 1"
s = s[:m.start()] + '\n    ("GUARD-CTL y20c", 2),' + s[m.end():]
open(dst, "w", encoding="utf-8").write(s)
# Re-seal, because the SEAL covers the declarations and would otherwise speak
# first. ROUND 30: this used to recompute the digest here, which was a COPY of
# the law inside a program whose job is to perturb it — and it went silently
# wrong the moment the seal grew from one declaration to four (W-2). It now
# asks the patched program for its own seal.
out = subprocess.run([sys.executable, "-I", dst, "--seal-only"],
                     capture_output=True, text=True)
line = out.stdout.strip()
assert line.startswith('EXPECTED_SEAL = "'), "the patched census would not state its own seal: " + out.stderr
s = open(dst, encoding="utf-8").read()
s = re.sub(r'EXPECTED_SEAL = "[0-9a-f]+"', line, s, count=1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/drop-census-shape.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = ("                if not line.startswith(NOT_ARM_PREFIXES):\n"
     "                    unknown.append(line[:60])")
assert s.count(b) == 1, "the unclassifiable-line refusal is not where this patcher expects it"
s = s.replace(b, "                if False:\n                    unknown.append(line[:60])", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/drop-census-mult.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "    if moved:"
assert s.count(b) == 1, "the count comparison is not where this patcher expects it"
s = s.replace(b, "    if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/drop-census-count.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "    if total_seen != total_declared:"
assert s.count(b) == 1, "the count law is not where this patcher expects it"
s = s.replace(b, "    if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH
cat > "$PATCHDIR/break-census-seal.py" <<'PATCH'
import re
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
# Rename ONE declared identity and leave EXPECTED_SEAL alone, which is exactly
# the edit the seal exists to notice.
m = re.search(r'\n    \("(GUARD-CTL y1)", ([0-9]+)\),', s)
assert m, "the declared set does not hold the entry this patcher renames"
s = s[:m.start()] + '\n    ("GUARD-CTL y1x", ' + m.group(2) + '),' + s[m.end():]
open(dst, "w", encoding="utf-8").write(s)
PATCH

CEN=$OUT/census-arms
rm -rf "$CEN"; mkdir -p "$CEN"
# BOTH snapshots are taken at the SAME instant: the live log keeps growing as
# the arms below print, so a "full" figure read later would differ from the
# snapshot by every line printed in between and not by the one removed.
cp "$OUT/run.log" "$CEN/full.log"
grep -v "GUARD-CTL y20c:" "$CEN/full.log" > "$CEN/lost.log"

# ROUND 29. Every arm below needs a census whose DECLARATION matches its own
# baseline, and the baseline here is a MID-RUN snapshot: the census arms have
# not printed their own lines yet, so the real declaration legitimately names
# arms this snapshot does not carry. Round 28 worked around that by asserting
# only the refusal it wanted; with a per-identity count law that no longer
# works, because the snapshot's absent arms are refused first and the arm below
# would be measuring the snapshot's incompleteness instead of the law.
#
# So each arm gets a census program whose declaration IS this snapshot, sealed,
# built by the program's own --seal generator. The perturbation is then the ONLY
# difference between the declaration and the log, which is what makes the
# refusal evidence about the law.
_mk_census(){      # _mk_census <log> <out.py>
  python3 -I "$HERE/p8-arm-census.py" --seal "$1" > "$2.decl" 2>"$2.decl.err" || true
  if [ ! -s "$2.decl" ]; then return 1; fi
  python3 -I - "$HERE/p8-arm-census.py" "$2.decl" "$2" <<'PY'
import re
import sys
src, decl, dst = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding="utf-8").read()
new = open(decl, encoding="utf-8").read().rstrip("\n")
pat = re.compile(r'EXPECTED_ARMS = \(\n.*?\n\)\nEXPECTED_SEAL = "[0-9a-f]+"', re.S)
assert len(pat.findall(s)) == 1, "the declaration block is not where this expects it"
open(dst, "w", encoding="utf-8").write(pat.sub(lambda m: new, s, count=1))
PY
}
if ! _mk_census "$CEN/full.log" "$CEN/base.py"; then
  say "CENSUS-LOSS: PLANT NOT ESTABLISHED — a census sealed to this run's own snapshot could not be built: $(tail -1 "$CEN/base.py.decl.err")"
  FAILED=1
elif ! python3 -I "$CEN/base.py" "$CEN/full.log" >"$CEN/base.log" 2>&1; then
  say "CENSUS-LOSS: PLANT NOT ESTABLISHED — the census sealed to this snapshot does not accept the snapshot it was sealed from: $(head -1 "$CEN/base.log")"
  FAILED=1
else
  say "CENSUS-BASE: a census sealed to this run's own mid-run snapshot accepts that snapshot exactly — $(sed -n 's/^ARM CENSUS: //p' "$CEN/base.log") — so every perturbation below is the only difference between the declaration and the log"

  # (1) A DEPARTURE of an identity exactly one line prints.
  if [ "$(wc -l < "$CEN/lost.log")" -lt "$(wc -l < "$CEN/full.log")" ]; then
    if CEN_OUT=$(python3 -I "$CEN/base.py" "$CEN/lost.log" 2>&1); then
      say "CENSUS-LOSS: FAIL — a log with one arm's line removed was accepted, so T-1 is unfixed and the count still moves down in silence"
      FAILED=1
    elif printf '%s' "$CEN_OUT" | grep -qF "ARM MISSING" \
         && printf '%s' "$CEN_OUT" | grep -qF "GUARD-CTL y20c"; then
      say "CENSUS-LOSS: a log with one arm's line removed is REFUSED BY NAME (ARM MISSING) and the refusal names GUARD-CTL y20c, so a departure costs what an arrival costs — this is the exact state the eighteenth challenge took green at 96"
    else
      say "CENSUS-LOSS: FAIL — it refused, but not by ARM MISSING naming the arm that went: $(printf '%s' "$CEN_OUT" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-LOSS: PLANT NOT ESTABLISHED — no 'GUARD-CTL y20c:' line to remove from this run's log"
    FAILED=1
  fi

  # THREE guards now stand over a departure — the named comparison, the
  # per-identity count law (round 29, U-1) and the total — so there are three
  # controls, each deleting ONE and naming which of the others caught it.
  if python3 -I "$PATCHDIR/drop-census-missing.py" "$CEN/base.py" "$CEN/no-missing.py" >"$CEN/p1.log" 2>&1; then
    C1=$(python3 -I "$CEN/no-missing.py" "$CEN/lost.log" 2>&1); C1RC=$?
    if [ "$C1RC" != 0 ] && printf '%s' "$C1" | grep -qF "ARM COUNT CHANGED" \
       && ! printf '%s' "$C1" | grep -qF "ARM MISSING"; then
      say "CENSUS-LOSS-CTL-1: with the named comparison deleted ALONE the same log still reds — by ARM COUNT CHANGED and NOT by ARM MISSING — so the per-identity count law is a guard in its own right and this arm attributes to it"
    else
      say "CENSUS-LOSS-CTL-1: FAIL — with the named comparison deleted the outcome was not the count law's: rc=$C1RC $(printf '%s' "$C1" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-LOSS-CTL-1: PLANT NOT ESTABLISHED — the named comparison could not be deleted: $(tail -1 "$CEN/p1.log")"
    FAILED=1
  fi
  if python3 -I "$PATCHDIR/drop-census-mult.py" "$CEN/base.py" "$CEN/no-mult.py" >"$CEN/p2.log" 2>&1; then
    C2=$(python3 -I "$CEN/no-mult.py" "$CEN/lost.log" 2>&1); C2RC=$?
    if [ "$C2RC" != 0 ] && printf '%s' "$C2" | grep -qF "ARM MISSING"; then
      say "CENSUS-LOSS-CTL-2: with the per-identity count law deleted ALONE the same log still reds by ARM MISSING, so the named comparison is a guard in its own right and CTL-1 measured one guard rather than the patcher"
    else
      say "CENSUS-LOSS-CTL-2: FAIL — with the count law deleted the loss was not caught by name: rc=$C2RC $(printf '%s' "$C2" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-LOSS-CTL-2: PLANT NOT ESTABLISHED — the per-identity count law could not be deleted: $(tail -1 "$CEN/p2.log")"
    FAILED=1
  fi
  # ROUND 29. This control deleted TWO guards and called the result the T-1
  # state. There are THREE now, and the per-identity law catches a departure on
  # its own, so all three come out — which is what the sentence is allowed to
  # claim. The figures are DERIVED from two files captured at the same instant
  # that differ by exactly the removed line; reading the live log here would
  # compare two different instants and make the difference the number of arms
  # that happened to print in between.
  if python3 -I "$PATCHDIR/drop-census-missing.py" "$CEN/base.py" "$CEN/neither-a.py" >"$CEN/p3.log" 2>&1 \
     && python3 -I "$PATCHDIR/drop-census-mult.py" "$CEN/neither-a.py" "$CEN/neither-b.py" >>"$CEN/p3.log" 2>&1 \
     && python3 -I "$PATCHDIR/drop-census-count.py" "$CEN/neither-b.py" "$CEN/neither.py" >>"$CEN/p3.log" 2>&1; then
    C3=$(python3 -I "$CEN/neither.py" "$CEN/lost.log" 2>&1); C3RC=$?
    C3FULL=$(python3 -I "$CEN/neither.py" "$CEN/full.log" 2>&1 | sed -n 's/^ARM CENSUS: \([0-9]*\) .*/\1/p')
    C3LOST=$(printf '%s' "$C3" | sed -n 's/^ARM CENSUS: \([0-9]*\) .*/\1/p')
    if [ "$C3RC" = 0 ] && [ -n "$C3FULL" ] && [ -n "$C3LOST" ] \
       && [ "$C3LOST" = "$((C3FULL - 1))" ]; then
      say "CENSUS-LOSS-CTL-3: with ALL THREE comparisons deleted the lost arm goes GREEN again and the count simply drops by one ($C3FULL -> $C3LOST, rc 0) — the exact state the eighteenth challenge measured on this gate, which is what makes the three of them together responsible for closing T-1"
    else
      say "CENSUS-LOSS-CTL-3: FAIL — with all three comparisons deleted the loss did not reproduce as a green count one lower: rc=$C3RC full=$C3FULL lost=$C3LOST $(printf '%s' "$C3" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-LOSS-CTL-3: PLANT NOT ESTABLISHED — the three comparisons could not all be deleted from one copy: $(tail -1 "$CEN/p3.log")"
    FAILED=1
  fi

  # (2) An ARRIVAL under a label nothing declares.
  { cat "$CEN/full.log"; printf '[%s] PROBE z1: a line nothing declares\n' "$RUN"; } > "$CEN/unknown.log"
  if CU=$(python3 -I "$CEN/base.py" "$CEN/unknown.log" 2>&1); then
    say "CENSUS-UNKNOWN: FAIL — an undeclared arm-shaped label was accepted"
    FAILED=1
  elif printf '%s' "$CU" | grep -qF "ARM LABEL UNKNOWN" && printf '%s' "$CU" | grep -qF "PROBE z1"; then
    say "CENSUS-UNKNOWN: an arm-shaped line whose label nothing declares is REFUSED BY NAME (ARM LABEL UNKNOWN) and the refusal quotes it, so a new arm family cannot be added without this census being told"
  else
    say "CENSUS-UNKNOWN: FAIL — an undeclared arm-shaped label was not refused by name: $(printf '%s' "$CU" | head -1)"
    FAILED=1
  fi
  if python3 -I "$PATCHDIR/drop-census-unknown.py" "$CEN/base.py" "$CEN/no-unknown.py" >"$CEN/p4.log" 2>&1; then
    C4=$(python3 -I "$CEN/no-unknown.py" "$CEN/unknown.log" 2>&1); C4RC=$?
    if [ "$C4RC" = 0 ] && ! printf '%s' "$C4" | grep -qF "PROBE z1"; then
      say "CENSUS-UNKNOWN-CTL: with that check deleted ALONE the undeclared label is named NOWHERE in the output and the census goes GREEN — it is invisible again, which is what makes the refusal above load-bearing"
    else
      say "CENSUS-UNKNOWN-CTL: FAIL — with the check deleted the undeclared label did not become invisible: rc=$C4RC $(printf '%s' "$C4" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-UNKNOWN-CTL: PLANT NOT ESTABLISHED — the unknown-label refusal could not be deleted: $(tail -1 "$CEN/p4.log")"
    FAILED=1
  fi

  # (3) The SEAL, read before the set.
  if python3 -I "$PATCHDIR/break-census-seal.py" "$CEN/base.py" "$CEN/unsealed.py" >"$CEN/p5.log" 2>&1; then
    C5=$(python3 -I "$CEN/unsealed.py" "$CEN/full.log" 2>&1); C5RC=$?
    if [ "$C5RC" != 0 ] && printf '%s' "$C5" | grep -qF "SEAL BROKEN" \
       && ! printf '%s' "$C5" | grep -qF "ARM MISSING"; then
      say "CENSUS-SEAL: one declared identity renamed and the digest left alone is refused by SEAL BROKEN, and NOT by ARM MISSING, so the seal is read before the log and the two refusals name different things"
    else
      say "CENSUS-SEAL: FAIL — an unsealed edit to the declared set was not refused by SEAL BROKEN: rc=$C5RC $(printf '%s' "$C5" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-SEAL: PLANT NOT ESTABLISHED — the declared set could not be edited in a copy: $(tail -1 "$CEN/p5.log")"
    FAILED=1
  fi

  # (4) CENSUS-MULT (round 29, U-1 and the coordinator's ruling). The identity is
  # not the measurement: five separate measurements printed `ISOLATION`, so four
  # could stop reporting with the SET intact and the gate silent. Each
  # measurement now has an id of its own and the declaration carries a COUNT per
  # identity; both directions of that count law are armed here.
  _cm_line=$(grep -m1 '^\[[^]]*\] GUARD-CTL y20c:' "$CEN/full.log" || true)
  if [ -n "$_cm_line" ]; then
    { cat "$CEN/full.log"; printf '%s\n' "$_cm_line"; } > "$CEN/dup.log"
    _cm_out=$(python3 -I "$CEN/base.py" "$CEN/dup.log" 2>&1); _cm_rc=$?
    if [ "$_cm_rc" != 0 ] && printf '%s' "$_cm_out" | grep -qF "ARM COUNT CHANGED" \
       && printf '%s' "$_cm_out" | grep -qF "GUARD-CTL y20c: declared 1, printed 2"; then
      say "CENSUS-MULT a1: a SECOND line under an identity declared once is REFUSED BY NAME (ARM COUNT CHANGED), with both numbers, so the count is a claim and not a tally of whatever printed"
    else
      say "CENSUS-MULT a1: FAIL — a duplicated arm line was not refused by name: rc=$_cm_rc $(printf '%s' "$_cm_out" | head -1)"
      FAILED=1
    fi
    if python3 -I "$PATCHDIR/census-declare-twice.py" "$CEN/base.py" "$CEN/twice.py" >"$CEN/p6.log" 2>&1; then
      _cm2=$(python3 -I "$CEN/twice.py" "$CEN/full.log" 2>&1); _cm2rc=$?
      if [ "$_cm2rc" != 0 ] && printf '%s' "$_cm2" | grep -qF "declared 2, printed 1"; then
        say "CENSUS-MULT a2: an identity declared TWICE and printed ONCE is REFUSED BY NAME with both numbers — this is U-1 exactly: the set holds, every identity is present, and a measurement has stopped reporting"
      else
        say "CENSUS-MULT a2: FAIL — a departure under a multiply-declared identity was not refused by name: rc=$_cm2rc $(printf '%s' "$_cm2" | head -1)"
        FAILED=1
      fi
      if python3 -I "$PATCHDIR/drop-census-mult.py" "$CEN/twice.py" "$CEN/twice-no-mult.py" >>"$CEN/p6.log" 2>&1; then
        _cm3=$(python3 -I "$CEN/twice-no-mult.py" "$CEN/full.log" 2>&1); _cm3rc=$?
        if [ "$_cm3rc" != 0 ] && printf '%s' "$_cm3" | grep -qF "COUNT DISAGREES" \
           && ! printf '%s' "$_cm3" | grep -qF "ARM COUNT CHANGED"; then
          say "CENSUS-MULT-CTL: with the per-identity comparison deleted ALONE the same log still reds — by the TOTAL (COUNT DISAGREES) and not by name — so the total is a guard in its own right and a1 and a2 attribute to the per-identity law"
        else
          say "CENSUS-MULT-CTL: FAIL — with the per-identity comparison deleted the outcome was not the total's: rc=$_cm3rc $(printf '%s' "$_cm3" | head -1)"
          FAILED=1
        fi
      else
        say "CENSUS-MULT-CTL: PLANT NOT ESTABLISHED — the per-identity comparison could not be deleted: $(tail -1 "$CEN/p6.log")"
        FAILED=1
      fi
    else
      say "CENSUS-MULT a2: PLANT NOT ESTABLISHED — the declaration could not be patched: $(tail -1 "$CEN/p6.log")"
      FAILED=1
    fi
  else
    say "CENSUS-MULT a1: PLANT NOT ESTABLISHED — no 'GUARD-CTL y20c:' line to duplicate"
    FAILED=1
  fi

  # (5) CENSUS-SHAPE (round 29, U-5 and the coordinator's N-4). The shape law
  # used to be two patterns that ADMITTED, and two spellings fell between them:
  # a colon-less lower-case head and a colon-less Mixed-Case head both left the
  # census green. The patterns are gone; what is left is a refusal for any
  # prefixed line this program cannot classify.
  _csh_ok=1
  for _sp in "probe z2 passed, an arm-shaped claim with no colon and a lower-case head" \
             "Probe z3 passed with no colon at all" \
             "PROBE Z4 PASSED"; do
    { cat "$CEN/full.log"; printf '[%s] %s\n' "$RUN" "$_sp"; } > "$CEN/shape.log"
    _csh_out=$(python3 -I "$CEN/base.py" "$CEN/shape.log" 2>&1); _csh_rc=$?
    if [ "$_csh_rc" = 0 ] || ! printf '%s' "$_csh_out" | grep -qF "ARM LABEL UNKNOWN"; then
      say "FAIL: CENSUS-SHAPE — a colon-less arm-shaped line was not refused: [$_sp] rc=$_csh_rc"
      _csh_ok=0; FAILED=1
    fi
  done
  if [ "$_csh_ok" = 1 ]; then
    say "CENSUS-SHAPE: all three colon-less spellings — lower-case, Mixed-Case and ALL-CAPS heads — are REFUSED BY NAME (ARM LABEL UNKNOWN); the two that round 28's patterns admitted are the two the nineteenth challenge used"
  fi
  if python3 -I "$PATCHDIR/drop-census-shape.py" "$CEN/base.py" "$CEN/no-shape.py" >"$CEN/p7.log" 2>&1; then
    { cat "$CEN/full.log"; printf '[%s] probe z2 passed, invisible again\n' "$RUN"; } > "$CEN/shape2.log"
    _cs2=$(python3 -I "$CEN/no-shape.py" "$CEN/shape2.log" 2>&1); _cs2rc=$?
    if [ "$_cs2rc" = 0 ] && ! printf '%s' "$_cs2" | grep -qF "probe z2"; then
      say "CENSUS-SHAPE-CTL: with that refusal deleted ALONE the same planted line is named NOWHERE and the census goes GREEN — the state the coordinator measured by hand (N-4), so the refusal above is what closes it"
    else
      say "CENSUS-SHAPE-CTL: FAIL — with the refusal deleted the planted line did not go green and unnamed: rc=$_cs2rc $(printf '%s' "$_cs2" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-SHAPE-CTL: PLANT NOT ESTABLISHED — the unclassifiable-line refusal could not be deleted: $(tail -1 "$CEN/p7.log")"
    FAILED=1
  fi
fi


# ---------------------------------------------------------------------
# ROUND 30, F-4, the second half: the set must not MOVE while the run uses it
# ---------------------------------------------------------------------
# The scan above read the files before the cases ran. A file swapped after that
# read would be scanned in one state and executed in another, which is the
# shape this phase calls a projection rather than an identity. The pin is
# re-measured here, at the end of the run, against the digest taken then.
if [ -n "${CASE_NET_PIN:-}" ]; then
  if CASE_PIN_OUT=$(python3 -I "$HERE/p8-case-net.py" --pin "$HERE/run-p8-real-proof.sh" "$CASE_NET_PIN" 2>&1); then
    say "CORE-PIN: $CASE_PIN_OUT — the same bytes the net read before the cases ran are the bytes still on disk now"
  else
    say "CORE-PIN: FAIL — a file this run loads changed while it was being used: $(printf '%s' "$CASE_PIN_OUT" | head -2 | tr '\n' ' ')"
    FAILED=1
  fi
  CPB=$OUT/casepin
  _netcopy "$CPB"
  CPP=$(python3 -I "$CPB/p8-case-net.py" --pin "$CPB/run-p8-real-proof.sh" 2>/dev/null)
  printf -- '\n-- one byte after the pin was taken\n' >> "$CPB/p8-real-cases-app.sql"
  CP=$(python3 -I "$CPB/p8-case-net.py" --pin "$CPB/run-p8-real-proof.sh" "$CPP" 2>&1); CPRC=$?
  if [ "$CPRC" -ne 0 ] && printf '%s' "$CP" | grep -qF "THE FILE SET MOVED DURING THE RUN"; then
    say "CORE-PIN-CTL: a case file changed after its pin was taken is REFUSED BY NAME (THE FILE SET MOVED DURING THE RUN) and the refusal prints every file's digest, so the arm above is evidence about bytes and not about a reading taken once"
  else
    say "CORE-PIN-CTL: FAIL — a file changed after the pin was not named: rc=$CPRC $(printf '%s' "$CP" | head -1)"
    FAILED=1
  fi
else
  say "CORE-PIN: FAIL — no pin was taken before the cases ran, so nothing here is evidence about the bytes they used"
  FAILED=1
fi

# ---------------------------------------------------------------------
# ROUND 30, W-1 and W-2: the census must hold in every configuration this gate
# supports, and the list that lets it SKIP must be sealed like the list that
# makes it count.
# ---------------------------------------------------------------------
# W-1 (P1) is the defect this round answers. Round 29's shape law — refuse every
# prefixed line this program cannot classify — is strictly stronger than the two
# admitting patterns it replaced, and it therefore turns every undeclared line
# of EVERY code path into a red, including the paths this container never takes.
# The runner's no-git branch prints one such line, and a `git archive` copy with
# no `.git` takes it, so the same head was FAILED=0 here and FAILED=1 in the
# configuration an independent reviewer runs. The declaration is in
# `p8-arm-census.py` now; these arms are what stops it being needed again
# without anyone noticing.
cat > "$PATCHDIR/drop-census-nogit.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = '    "no git work tree here",\n'
assert s.count(b) == 1, "the no-git declaration is not where this patcher expects it"
open(dst, "w", encoding="utf-8").write(s.replace(b, "", 1))
PATCH
cat > "$PATCHDIR/widen-census-complement.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = 'NOT_ARMS = (\n    "NOTE",'
assert s.count(b) == 1, "NOT_ARMS is not where this patcher expects it"
# One head added to the complement, the seal left exactly as it was: the state
# the twentieth challenge measured, in which a whole arm-shaped family is
# skipped in silence (W-2).
open(dst, "w", encoding="utf-8").write(s.replace(b, 'NOT_ARMS = (\n    "PROBE",\n    "NOTE",', 1))
PATCH
cat > "$PATCHDIR/drop-census-sealcheck.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
b = "    if actual_seal != EXPECTED_SEAL:"
assert s.count(b) == 1, "the seal comparison is not where this patcher expects it"
open(dst, "w", encoding="utf-8").write(s.replace(b, "    if False:", 1))
PATCH

# BOTH sentences the frozen-integrity check can print, read OUT OF THIS FILE
# rather than retyped, so the arm cannot drift from the lines the gate actually
# prints. One of them is in this run's log and the other is the one the OTHER
# configuration prints; the arm swaps them, so whichever world this run is in,
# the census is measured against the world it is not in. That is the whole of
# W-1: round 29's declaration was complete for the configuration it was written
# in, and the gate was red in the other one.
NOGIT_PAIR=$(python3 -I - "$HERE/run-p8-real-proof.sh" <<'PY'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
a = re.findall(r'\n  say "(no git work tree here[^"]*)"', s)
b = re.findall(r'\n    say "(git agrees:[^"]*)"', s)
if len(a) != 1 or len(b) != 1:
    sys.stderr.write("the two integrity sentences are not where this expects them: %d/%d\n"
                     % (len(a), len(b)))
    raise SystemExit(1)
sys.stdout.write(a[0] + "\n" + b[0] + "\n")
PY
)
NOGIT_LINE=$(printf '%s\n' "$NOGIT_PAIR" | sed -n 1p)
GIT_LINE=$(printf '%s\n' "$NOGIT_PAIR" | sed -n 2p)
if [ -z "$NOGIT_LINE" ] || [ -z "$GIT_LINE" ]; then
  say "CENSUS-NOGIT: PLANT NOT ESTABLISHED — the runner's own integrity sentences could not be read out of its source, so this arm cannot be about the lines the gate prints"
  FAILED=1
elif ! python3 -I - "$CEN/full.log" "$CEN/nogit.log" "$NOGIT_LINE" "$GIT_LINE" >"$CEN/nogit-build.log" 2>&1 <<'PY'
import sys
src, dst, nogit, git = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = open(src, encoding="utf-8").readlines()
have_git = sum(1 for l in lines if git[:12] in l)
have_nogit = sum(1 for l in lines if nogit[:24] in l)
assert have_git + have_nogit == 1, (
    "this run's log carries %d git lines and %d no-git lines, and exactly one "
    "of the two is expected" % (have_git, have_nogit))
out = []
for l in lines:
    if have_git and git[:12] in l:
        out.append(l.split(git[:12])[0] + nogit + "\n")
    elif have_nogit and nogit[:24] in l:
        out.append(l.split(nogit[:24])[0] + git + "\n")
    else:
        out.append(l)
open(dst, "w", encoding="utf-8").writelines(out)
sys.stderr.write("SWAPPED: %s\n" % ("git -> no-git" if have_git else "no-git -> git"))
PY
then
  say "CENSUS-NOGIT: PLANT NOT ESTABLISHED — a log of the other configuration could not be built: $(tail -1 "$CEN/nogit-build.log")"
  FAILED=1
elif ! _mk_census "$CEN/nogit.log" "$CEN/nogit.py"; then
  say "CENSUS-NOGIT: FAIL — a log of THIS run in the OTHER configuration cannot be classified by this census, which is W-1: the gate would be red in a tree that differs only by its .git — $(tail -1 "$CEN/nogit.py.decl.err")"
  FAILED=1
elif python3 -I "$CEN/nogit.py" "$CEN/nogit.log" >"$CEN/nogit-run.log" 2>&1; then
  say "CENSUS-NOGIT: the same log with the frozen-integrity check's OTHER sentence in it ($(sed -n 's/^SWAPPED: //p' "$CEN/nogit-build.log")) is classified and ACCEPTED — $(sed -n 's/^ARM CENSUS: //p' "$CEN/nogit-run.log") — so both worlds are measured here rather than one of them in a reviewer's container (W-1)"
else
  say "CENSUS-NOGIT: FAIL — the other configuration's log was refused: $(head -1 "$CEN/nogit-run.log")"
  FAILED=1
fi

# And the attribution: with that one declaration deleted, a log carrying the
# no-git line cannot be read at all, and the refusal NAMES it. This is the arm
# the coordinator asked for, so the line cannot go undeclared again in silence.
if python3 -I "$PATCHDIR/drop-census-nogit.py" "$HERE/p8-arm-census.py" "$CEN/no-nogit.py" \
     >"$CEN/p8n.log" 2>&1; then
  CN_SRC=$CEN/nogit.log
  if grep -qF "no git work tree here" "$CEN/full.log"; then CN_SRC=$CEN/full.log; fi
  CN=$(python3 -I "$CEN/no-nogit.py" --seal "$CN_SRC" 2>&1 >/dev/null); CNRC=$?
  if printf '%s' "$CN" | grep -qF "ARM LABEL UNKNOWN" \
     && printf '%s' "$CN" | grep -qF "no git work tree here"; then
    say "CENSUS-NOGIT-CTL: with that one declaration deleted ALONE the log carrying the no-git line is REFUSED BY NAME (ARM LABEL UNKNOWN) and the refusal quotes it — the exact state the twentieth challenge measured as FAILED=1 from an archive copy"
  else
    say "CENSUS-NOGIT-CTL: FAIL — with the declaration deleted the no-git line was not named: rc=$CNRC $(printf '%s' "$CN" | head -1)"
    FAILED=1
  fi
else
  say "CENSUS-NOGIT-CTL: PLANT NOT ESTABLISHED — the no-git declaration could not be deleted from a copy: $(tail -1 "$CEN/p8n.log")"
  FAILED=1
fi

# Every line the runner can print, in any configuration. One line of one
# untaken path is what W-1 was; this arm reads the runner's own source and
# classifies EVERY static sentence in it, so an undeclared line reds here even
# when this container never executes it. Lines whose first token is substituted
# at run time are SKIPPED and the number of them is printed: their identity is
# only knowable from a run, and the census sees it there.
if python3 -I - "$HERE/run-p8-real-proof.sh" "$CEN/full.log" "$CEN/paths.log" \
     >"$CEN/paths-build.log" 2>&1 <<'PY'
import re, sys
src, base, dst = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding="utf-8").read()
# Every `say "…"` with a static first token. A double-quoted shell literal ends
# at the first unescaped quote, which is what this reads.
#
# ROUND 31, C-3 and the coordinator's §6, measured the same thing: this reader
# anchored at the START OF A LINE and the runner has say-sites after `&&`, `||`
# and `;`. Twenty of them, two printed in EVERY run, and they were in none of
# the three figures — not the classified set, not the run-time-substituted set,
# and not the total that was supposed to BOUND the claim. So the gap was a
# silence, which is the exact shape of W-1 and the exact thing this arm exists
# to make impossible. The anchor is gone: a say-site is a say-site wherever it
# sits on its line.
# A say-site is one in COMMAND position: the start of a line, or straight
# after `;`, `&&`, `||`, `{` or `(`. Bare whitespace is deliberately not a
# separator — this file embeds Python that itself contains the text `say "…"`
# inside a regex, and reading those as say-sites would be the mirror of the
# defect this round answers: a reader that cannot tell code from a string.
SAY = r'(?:^|[;{(]|&&|\|\|)[\t ]*say '
lits = re.findall(SAY + r'"((?:[^"\\]|\\.)*)"', s, re.M)
sites = len(re.findall(SAY, s, re.M))
# A sentence whose first non-blank character is substituted at run time has no
# identity until it runs; `lstrip` because a leading space is still no prefix.
runtime = [t for t in lits if t.lstrip().startswith("$")]
static = [t for t in lits if not t.lstrip().startswith("$")]
subst = re.compile(r'\$\((?:[^()]|\([^()]*\))*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z_0-9]*')
lines = [subst.sub("X", t) for t in static]
with open(dst, "w", encoding="utf-8") as out:
    out.write(open(base, encoding="utf-8").read())
    for l in lines:
        out.write("[PATHS] %s\n" % l.replace("\\$", "$").replace('\\"', '"'))
# The claim this arm may make is bounded by what this reader covers, so all
# three figures are printed: the sentences classified, the ones whose first
# token is substituted at run time (their identity is only knowable from a run,
# and the census reads it there), and the total number of say-sites, so a
# sentence this reader cannot see is visible as a difference rather than as a
# silence. ROUND 31: that sentence was FALSE while the reader anchored at the
# start of a line, because the TOTAL was derived from the same anchor, so the
# twenty sites it could not see were missing from both sides of the comparison.
# It is true of the reader below, whose two patterns differ only in what
# follows `say `.
# FOUR figures, because three left a remainder. A say-site whose argument is
# not a double-quoted literal at all — `say $MSG`, a concatenation — is in
# neither `lits` set, so it is counted and named here rather than absorbed
# into the total. The arm's claim is bounded by the first figure and the
# other three say exactly what it is not about.
sys.stderr.write("PATHS: %d static sentences classified, %d skipped as "
                 "run-time-substituted, %d not a quoted literal, "
                 "%d say-sites in the runner\n"
                 % (len(lines), len(runtime), sites - len(lits), sites))
PY
then
  PATHS_N=$(sed -n 's/^PATHS: \([0-9]*\) static.*/\1/p' "$CEN/paths-build.log")
  PATHS_ALL=$(sed -n 's/^PATHS: .*, \([0-9]*\) say-sites.*/\1/p' "$CEN/paths-build.log")
  PATHS_NQ=$(sed -n 's/^PATHS: .*, \([0-9]*\) not a quoted literal.*/\1/p' "$CEN/paths-build.log")
  PATHS_RT=$(sed -n 's/^PATHS: [0-9]* static sentences classified, \([0-9]*\) skipped.*/\1/p' "$CEN/paths-build.log")
  if _mk_census "$CEN/paths.log" "$CEN/paths.py"; then
    say "CENSUS-PATHS: every one of the $PATHS_N static sentences this runner can print — in EVERY configuration, including the paths this container does not take — is classified by the census, so an undeclared line of an untaken path reds here (W-1); of $PATHS_ALL say-sites in the runner the other $PATHS_RT begin with a value substituted at run time, so their identity is knowable only from a run and the census reads it there, and $PATHS_NQ are not a quoted literal at all; the three remainders are STATED because round 30's reader anchored at the start of a line and the twenty sites it could not see were missing from its total as well, so the gap was a silence (C-3)"
  else
    say "CENSUS-PATHS: FAIL — a sentence the runner can print is classified by nothing: $(tail -1 "$CEN/paths.py.decl.err")"
    FAILED=1
  fi
  if [ -s "$CEN/no-nogit.py" ]; then
    CP=$(python3 -I "$CEN/no-nogit.py" --seal "$CEN/paths.log" 2>&1 >/dev/null)
    if printf '%s' "$CP" | grep -qF "ARM LABEL UNKNOWN" \
       && printf '%s' "$CP" | grep -qF "no git work tree here"; then
      say "CENSUS-PATHS-CTL: with the no-git declaration deleted ALONE the all-paths log is REFUSED BY NAME and the refusal quotes that line, so this arm is what would have caught W-1 before a reviewer did"
    else
      say "CENSUS-PATHS-CTL: FAIL — with that declaration deleted the all-paths log did not name the line: $(printf '%s' "$CP" | head -1)"
      FAILED=1
    fi
  fi
else
  say "CENSUS-PATHS: PLANT NOT ESTABLISHED — the runner's static sentences could not be read out of its source: $(tail -1 "$CEN/paths-build.log")"
  FAILED=1
fi

# W-2: the seal covers the complement now. One head added to NOT_ARMS, the seal
# left alone, and the census must refuse — and with the seal comparison deleted
# the smuggled family goes green again, which is what the challenger measured.
if python3 -I "$PATCHDIR/widen-census-complement.py" "$CEN/base.py" "$CEN/widened.py" \
     >"$CEN/p9a.log" 2>&1; then
  cp "$CEN/full.log" "$CEN/probe.log"
  printf '[%s] PROBE z99: a measurement smuggled in under a widened complement\n' "$RUN" >> "$CEN/probe.log"
  CW=$(python3 -I "$CEN/widened.py" "$CEN/probe.log" 2>&1); CWRC=$?
  if [ "$CWRC" -ne 0 ] && printf '%s' "$CW" | grep -qF "SEAL BROKEN"; then
    say "CENSUS-SEAL-COMP: one head added to the list that decides what the census may SKIP, with the seal untouched, is REFUSED BY NAME (SEAL BROKEN) and the refusal names all four declarations, so the complement cannot be widened quietly (W-2)"
  else
    say "CENSUS-SEAL-COMP: FAIL — a widened complement with an untouched seal was not refused: rc=$CWRC $(printf '%s' "$CW" | head -1)"
    FAILED=1
  fi
  if python3 -I "$PATCHDIR/drop-census-sealcheck.py" "$CEN/widened.py" "$CEN/widened-unsealed.py" \
       >"$CEN/p9b.log" 2>&1; then
    CS=$(python3 -I "$CEN/widened-unsealed.py" "$CEN/probe.log" 2>&1); CSRC=$?
    if [ "$CSRC" -eq 0 ] && printf '%s' "$CS" | grep -qF "ARM CENSUS:"; then
      say "CENSUS-SEAL-COMP-CTL: with the seal comparison deleted ALONE the same widened complement reports a clean census over a log carrying an undeclared arm-shaped line — the exact rc 0 the twentieth challenge measured (W-2), so the seal above is what closes it"
    else
      say "CENSUS-SEAL-COMP-CTL: FAIL — with the seal check deleted the widened complement did not go green: rc=$CSRC $(printf '%s' "$CS" | head -1)"
      FAILED=1
    fi
  else
    say "CENSUS-SEAL-COMP-CTL: PLANT NOT ESTABLISHED — the seal comparison could not be deleted: $(tail -1 "$CEN/p9b.log")"
    FAILED=1
  fi
else
  say "CENSUS-SEAL-COMP: PLANT NOT ESTABLISHED — the complement could not be widened in a copy: $(tail -1 "$CEN/p9a.log")"
  FAILED=1
fi

# ---------------------------------------------------------------------
# The ARM CENSUS, now a set and not only a count
# ---------------------------------------------------------------------
# Round 26: ten new arms ran and the published `grep` pattern reported the same
# 74 as the round before, because the pattern has no `VACUITY` alternative and
# `grep -o` does not match a line it was not told about. A count rule that
# cannot name a new label measures the rule, not the apparatus, and it fails
# silently and downwards while the author reads the old number as continuity.
# `p8-arm-census.py` declares which labels ARE arms and which deliberately are
# NOT, and REFUSES on an arm-shaped line whose label is in neither set. So a new
# arm cannot be added without the census being told, and the failure is a red
# gate instead of an unchanged number. It runs as a SUBPROCESS, isolated, never
# imported, and it reads this run's own log.
if CENSUS_OUT=$(python3 -I "$HERE/p8-arm-census.py" "$OUT/run.log" 2>&1); then
  say "$(printf '%s' "$CENSUS_OUT" | head -1)"
else
  say "FAIL: ARM CENSUS refused this run's log — $(printf '%s' "$CENSUS_OUT" | head -3 | tr '\n' ' ')"
  FAILED=1
fi

say "RUN=$RUN FAILED=$FAILED"
exit $FAILED
