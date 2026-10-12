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
#   * The frozen-integrity check no longer asks git and believe its silence. It
#     verifies every file against the digests the repository itself records in
#     MIGRATION_MANIFEST.json, through `p8-frozen-integrity.py`, whose exit code
#     IS read. See that file's header for the fail-open it replaces.
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
RUN=${RUN_ID:-P8-R11-$(date -u +%Y%m%dT%H%M%SZ)}
OUT=$D/$RUN
mkdir -p "$OUT"
FAILED=0

say(){ echo "[$RUN] $*" | tee -a "$OUT/run.log"; }
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
build(){           # build <overlay-file> <logdir>
  local ov=$1
  local ld=$2
  mkdir -p "$ld"
  sup "DROP DATABASE IF EXISTS daftar" >/dev/null 2>&1
  sup "CREATE DATABASE daftar OWNER daftar_migrator" >/dev/null
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
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 -f "$HERE/p8-case-helpers.sql" > "$ld/helpers.log" 2>&1 || return 1
  sup "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA p8 TO daftar_app, daftar_worker, daftar_platform" daftar >/dev/null
  "$B/psql" -h "$D" -p "$P" -U daftar_platform  -d daftar -q -v ON_ERROR_STOP=1 --single-transaction -f "$HERE/p8-real-fixtures.sql" > "$ld/fixtures-1.log" 2>&1 || { echo "fixtures 1 failed"; return 1; }
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator  -d daftar -q -v ON_ERROR_STOP=1 --single-transaction -f "$HERE/p8-real-fixtures-owner.sql" > "$ld/fixtures-2.log" 2>&1 || { echo "fixtures 2 failed"; return 1; }
  return 0
}

cases(){           # cases <logdir>  — runs every case file as its own role
  local ld=$1 rc=0 r
  for pair in "daftar_app:p8-real-cases-app.sql" \
              "daftar_migrator:p8-real-cases-owner.sql" \
              "daftar_platform:p8-real-cases-platform.sql"; do
    r=${pair%%:*}; f=${pair#*:}
    "$B/psql" -h "$D" -p "$P" -U "$r" -d daftar -v ON_ERROR_STOP=1 -f "$HERE/$f" > "$ld/$f.log" 2>&1 || rc=1
  done
  grep -h "PASS" "$ld"/*.sql.log 2>/dev/null | wc -l > "$ld/passes"
  return $rc
}

say "=== baseline ==="
build "$HERE/p8-overlay.sql" "$OUT/baseline" || { say "BASELINE BUILD FAILED"; exit 1; }
say "migrations applied = $(cat "$OUT/baseline/applied")"
if cases "$OUT/baseline"; then
  say "baseline cases rc=0 passes=$(cat "$OUT/baseline/passes")"
else
  say "BASELINE CASES FAILED"; grep -h "FAIL\|ERROR" "$OUT"/baseline/*.sql.log | head -5 | tee -a "$OUT/run.log"; exit 1
fi

# The one EXECUTED race this phase has. Round 11's runner dropped it; the fifth
# challenge reported that as a coverage regression and was right. It commits, so
# it runs after the case files (which each roll themselves back) and cleans up
# after itself.
if RACE_OUT=$OUT/baseline-race bash "$HERE/run-p8-race-proof.sh" > "$OUT/baseline/race.log" 2>&1; then
  say "$(grep -o 'I1-conc PASS.*' "$OUT/baseline/race.log" | head -1)"
else
  say "BASELINE RACE FAILED"; tail -3 "$OUT/baseline/race.log" | tee -a "$OUT/run.log"; FAILED=1
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

plant(){           # plant <id> <dir> — mutate a COPY, and refuse a no-op
  # NOTE ON `local`: bash expands every word on the line before any of the
  # assignments take effect, so `local id=$1 md=$OUT/mut-$id` reads an empty
  # $id. Each derived variable gets its own line throughout this file.
  local id=$1
  local md=$2
  mkdir -p "$md"
  cp "$HERE/p8-overlay.sql" "$md/overlay.sql"
  python3 "$MUT" "$id" "$md/overlay.sql" > "$md/plant.log" 2>&1 || return 1
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
    say "MUT $id: RED — the race fails without notifications_obligation_once: $(grep -o 'I1-conc FAIL.*' "$md/race.log" | head -1)"
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
  if grep -qF "$expect" "$md/overlay.log" 2>/dev/null; then
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
mutate_race    12

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
INTEGRITY_OUT=$OUT/frozen-integrity.log
if python3 "$HERE/p8-frozen-integrity.py" "$REPO" > "$INTEGRITY_OUT" 2>&1; then
  while IFS= read -r line; do say "$line"; done < "$INTEGRITY_OUT"
else
  say "FAIL: the frozen history did not verify against the manifest"
  while IFS= read -r line; do say "  $line"; done < "$INTEGRITY_OUT"
  FAILED=1
fi

# A check that cannot fail is worth nothing, so the check is itself measured —
# the lesson round 11 wrote into `mutate_refuses` and then did not apply to its
# own last ten lines. Four ways of breaking it, each required to exit non-zero
# AND to name its own cause. Every one runs against a COPY of the two
# directories; nothing under migrations/ is written, here or anywhere.
integrity_must_refuse(){   # integrity_must_refuse <id> <setup-command> <expect>
  local id=$1
  local setup=$2
  local expect=$3
  local sand=$OUT/integrity-$id
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  ( cd "$sand" && eval "$setup" ) >/dev/null 2>&1
  local out=$sand/out.log
  if python3 "$HERE/p8-frozen-integrity.py" "$sand" > "$out" 2>&1; then
    say "INTEGRITY-MUT $id: FAIL — the check PASSED on a broken tree"
    FAILED=1; return
  fi
  if grep -qF "$expect" "$out"; then
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
  "MODIFIED  0006_rls.sql"
# (b) a frozen file deleted
integrity_must_refuse b \
  "rm infrastructure/database/migrations/0013_security_boundary.sql" \
  "MISSING   0013_security_boundary.sql"
# (c) the manifest itself gone — round 11's shape of failure, where the tool the
#     check depends on cannot answer. It must now refuse, not reassure.
integrity_must_refuse c \
  "rm infrastructure/database/MIGRATION_MANIFEST.json" \
  "the manifest could not be read"
# (d) the manifest present but not the shape the check reads
integrity_must_refuse d \
  "printf '{}' > infrastructure/database/MIGRATION_MANIFEST.json" \
  "not the shape this check reads"

# git is still consulted WHERE THERE IS A WORK TREE, as a second opinion on the
# files the manifest cannot attest to (Phase 4's unsealed range). Its exit code
# is read, and where there is no work tree that is reported rather than passed.
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

# ---------------------------------------------------------------------
# 4  Rebuild the baseline, so the cluster is left in the proved state
# ---------------------------------------------------------------------
build "$HERE/p8-overlay.sql" "$OUT/final" >/dev/null && cases "$OUT/final" \
  && say "cluster left at the baseline, passes=$(cat "$OUT/final/passes")" \
  || { say "FAIL: could not restore the baseline"; FAILED=1; }

say "RUN=$RUN FAILED=$FAILED"
exit $FAILED
