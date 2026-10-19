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
  # ROUND 24, O-4. `daftar_worker` holds grants nothing exercised: a
  # column-scoped UPDATE on notifications, an append-only INSERT on attempts,
  # and the quarantine INSERT; and the status ladder was a database rule tested
  # only in TypeScript. The worker cannot create an obligation — that is case
  # W-3 — so its cases need rows that are already committed, which the three
  # files above cannot leave behind because each rolls itself back. Hence:
  # commit a baseline AFTER them, run the worker file, then remove the baseline
  # again, so nothing that runs later (the race proof commits) inherits it.
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
            -f "$HERE/p8-real-fixtures-worker.sql" > "$ld/fixtures-worker.log" 2>&1 \
    || { echo "the worker baseline did not commit" >> "$ld/fixtures-worker.log"; rc=1; }
  "$B/psql" -h "$D" -p "$P" -U daftar_worker -d daftar -v ON_ERROR_STOP=1 \
            -f "$HERE/p8-real-cases-worker.sql" > "$ld/p8-real-cases-worker.sql.log" 2>&1 || rc=1
  "$B/psql" -h "$D" -p "$P" -U daftar_migrator -d daftar -q -v ON_ERROR_STOP=1 \
            -f "$HERE/p8-real-fixtures-worker-teardown.sql" > "$ld/fixtures-worker-teardown.log" 2>&1 \
    || { echo "the worker baseline was NOT removed" >> "$ld/fixtures-worker-teardown.log"; rc=1; }
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
  say "note: P8_GIT_ANCHOR_SHA is set to the pin itself, which steers nothing; the check carries the pin"
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
    say "ANCHOR-MUT $id: PLANT NOT ESTABLISHED — no anchor was resolved, so this guard is UNMEASURED; failing closed under that name"
    FAILED=1; return
  fi
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  ( cd "$sand" && eval "$setup" ) >/dev/null 2>&1
  if [ "$(copied_digest "$REPO/infrastructure/database")" \
     = "$(copied_digest "$sand/infrastructure/database")" ]; then
    say "ANCHOR-MUT $id: PLANT NOT ESTABLISHED — the plant did not land; the sandbox is identical to the source, so there is nothing for the guard to refuse; failing closed under that name"
    FAILED=1; return
  fi
  local bare=$sand/bare.log anch=$sand/anchored.log
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only > "$bare" 2>&1; then
    say "ANCHOR-MUT $id: bare — the tree is internally consistent and round 14's check PASSES it ($(grep -c . "$bare") lines, exit 0)"
  else
    say "ANCHOR-MUT $id: FAIL — the bare arm went RED, so this plant is not evidence about the anchor"
    head -2 "$bare" | tee -a "$OUT/run.log"
    FAILED=1; return
  fi
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" "${ANCHOR_ARGS[@]}" > "$anch" 2>&1; then
    say "ANCHOR-MUT $id: FAIL — the ANCHORED arm passed too; the fail-open is still open"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$anch"; then
    say "ANCHOR-MUT $id: anchored — refused, and named it — '$expect'"
  else
    say "ANCHOR-MUT $id: FAIL — the anchored arm refused, but did not name '$expect'"
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
    say "ANCHOR-ID $id: PLANT NOT ESTABLISHED — no anchor directory, so this plant is UNMEASURED; failing closed under that name"
    FAILED=1; return
  fi
  # A CLONE of the anchor repository, so the real one is never written to. No
  # frozen migration is touched in any real tree: what is doctored is a ref and a
  # commit inside a throwaway clone.
  if ! git clone -q "$P8_ANCHOR_DIR" "$work/anchor" 2>"$work/clone.log"; then
    say "ANCHOR-ID $id: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$work/clone.log"); failing closed under that name"
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
      say "ANCHOR-ID $id: FAIL — $_anc is not an ancestor of the clone's HEAD, so the lineage guard would decide this arm instead of the guard it names"
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
    say "ANCHOR-ID $id: the forged tree is internally consistent, as the plant requires"
  else
    say "ANCHOR-ID $id: PLANT NOT ESTABLISHED — the forged tree is not internally consistent ($(head -1 "$work/inner.log")), so it does not reach the anchor at all; failing closed under that name"
    FAILED=1; return
  fi
  local out=$work/guarded.log
  # shellcheck disable=SC2086  # deliberate flag lists
  if python3 -I "$HERE/p8-frozen-integrity.py" "$sand" --git-dir "$work/anchor" $extra > "$out" 2>&1; then
    say "ANCHOR-ID $id: FAIL — the check CONFIRMED a forged tree against a doctored anchor"
    FAILED=1; return
  fi
  if grep -qF -e "$expect" "$out"; then
    say "ANCHOR-ID $id: refused, and named it — '$expect'"
  else
    say "ANCHOR-ID $id: FAIL — it refused, but did not name '$expect'"
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
    say "ANCHOR-ID $id: FAIL — the guard-deletion patcher did not apply (exit $pat), so this arm measured nothing about this round's guards"
    FAILED=1; return
  fi
  # shellcheck disable=SC2086
  if python3 -I "$nog" "$sand" --git-dir "$work/anchor" $extra > "$work/no-guards.log" 2>&1; then
    say "ANCHOR-ID $id: guard-deletion arm PASSES, so this round's guard is what refused it"
  else
    say "ANCHOR-ID $id: FAIL — refused even with this round's guards deleted ($(head -1 "$work/no-guards.log")), so it is not evidence about them"
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
    say "LINEAGE: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$LIN/clone.log"); failing closed under that name"
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
      say "LINEAGE: PLANT NOT ESTABLISHED — the doctored clone no longer holds the pin at all, so this plant would test reachability, not lineage; failing closed under that name"
      FAILED=1
    elif git -C "$LIN/orphan" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
      say "LINEAGE: PLANT NOT ESTABLISHED — the doctored clone still descends from the pin, so there is nothing for the lineage guard to refuse; failing closed under that name"
      FAILED=1
    else
      if [ "$(git -C "$LIN/orphan" rev-parse --is-shallow-repository)" = true ]; then
        say "LINEAGE: PLANT NOT ESTABLISHED — the plant is SHALLOW, so the completeness guard would decide this arm instead of the lineage guard it names; pass a complete anchor (fetch-depth 0); failing closed under that name"
        FAILED=1
      else
      say "LINEAGE: the plant holds the pin as an object and is not descended from it, and is not shallow, as required"
      if python3 -I "$HERE/p8-frozen-integrity.py" "$LIN/tree" --git-dir "$LIN/orphan" >"$LIN/guarded.log" 2>&1; then
        say "LINEAGE: FAIL — an HONEST tree was confirmed against a repository that merely HOLDS the pin"
        FAILED=1
      elif grep -qF "ANCHOR LINEAGE" "$LIN/guarded.log"; then
        say "LINEAGE: refused, and named it — 'ANCHOR LINEAGE'"
      else
        say "LINEAGE: FAIL — it refused, but not by the lineage guard's name"
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
  say "LINEAGE: PLANT NOT ESTABLISHED — no anchor directory, so the lineage guard is UNMEASURED; failing closed under that name"
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
    say "GRAFTS: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$GRF/clone.log"); failing closed under that name"
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
      say "GRAFTS: PLANT NOT ESTABLISHED — the plant no longer holds the pin, so it would test reachability rather than grafts; failing closed under that name"
      FAILED=1
    elif git -C "$GRF/repo" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
      say "GRAFTS: PLANT NOT ESTABLISHED — the plant already descends from the pin before any graft, so the graft would prove nothing; failing closed under that name"
      FAILED=1
    else
      mkdir -p "$GRF/repo/.git/info"
      printf '%s %s\n' "$(git -C "$GRF/repo" rev-parse HEAD)" "$P8_ANCHOR_PIN" \
        > "$GRF/repo/.git/info/grafts"
      if ! git -C "$GRF/repo" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
        say "GRAFTS: FAIL — the graft did not take effect in this git, so the plant did not land"
        FAILED=1
      else
        say "GRAFTS: the plant is grafted — plain git now calls the pin an ancestor of an unrelated history, as required"
        gout=$GRF/out.log; grc=0
        python3 -I "$HERE/p8-frozen-integrity.py" "$REPO" --git-dir "$GRF/repo" >"$gout" 2>&1 || grc=$?
        if [ "$grc" -eq 0 ]; then
          say "GRAFTS: FAIL — a grafted witness was accepted (rc 0), so the lineage guard reads the graft file"
          FAILED=1
        elif grep -qF "ANCHOR LINEAGE" "$gout"; then
          say "GRAFTS: refused, and named it — 'ANCHOR LINEAGE', so the graft file does not reach this check"
        else
          say "GRAFTS: FAIL — it refused (rc=$grc) but not by the lineage guard's name: $(head -1 "$gout")"
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
  say "GRAFTS: PLANT NOT ESTABLISHED — no anchor directory, so the graft scrub is UNMEASURED; failing closed under that name"
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
    say "SHALLOW: PLANT NOT ESTABLISHED — could not clone the anchor repository: $(tail -1 "$SHAL/clone.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git -C "$SHAL/full" -c user.email=p8@local -c user.name=p8 \
         commit -q --allow-empty -m "a descendant, so the trap can exist" 2>"$SHAL/commit.log"; then
    say "SHALLOW: PLANT NOT ESTABLISHED — could not create a descendant of the anchor's HEAD: $(tail -1 "$SHAL/commit.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git clone -q --depth 1 "file://$SHAL/full" "$SHAL/repo" 2>"$SHAL/shclone.log"; then
    say "SHALLOW: PLANT NOT ESTABLISHED — could not make a shallow clone: $(tail -1 "$SHAL/shclone.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git -C "$SHAL/repo" fetch -q --depth 1 origin "$P8_ANCHOR_PIN" 2>"$SHAL/fetch.log"; then
    say "SHALLOW: PLANT NOT ESTABLISHED — could not fetch the pin into the shallow clone: $(tail -1 "$SHAL/fetch.log"); the completeness guard is UNMEASURED here and this gate fails closed under that name"
    FAILED=1
  elif ! git -C "$SHAL/repo" rev-parse --verify -q "${P8_ANCHOR_PIN}^{commit}" >/dev/null; then
    say "SHALLOW: PLANT NOT ESTABLISHED — the shallow clone does not hold the pin, so it would test absence rather than shallowness; UNMEASURED, failing closed"
    FAILED=1
  elif [ "$(git -C "$SHAL/repo" rev-parse --is-shallow-repository)" != true ]; then
    say "SHALLOW: PLANT NOT ESTABLISHED — the clone is not shallow; UNMEASURED, failing closed"
    FAILED=1
  # THE assertion round 20 was missing: the trap exists only if plain git, in
  # that clone, answers NEGATIVELY. Where it answers 0 the guard has nothing to
  # refuse and its acceptance is correct.
  elif git -C "$SHAL/repo" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
    say "SHALLOW: PLANT NOT ESTABLISHED — plain git calls the pin an ancestor in the shallow clone, so there is no truncated NO to trap and nothing here is evidence about the completeness guard; UNMEASURED, failing closed. (This is the round-13 blocker: with an anchor whose HEAD *is* the pin, round 20 reached this state and blamed the guard instead.)"
    FAILED=1
  else
    say "SHALLOW: the plant holds the pin, is shallow, and plain git answers NEGATIVELY there — all three asserted, as required"
    sout=$SHAL/out.log; src=0
    python3 -I "$HERE/p8-frozen-integrity.py" "$REPO" --git-dir "$SHAL/repo" >"$sout" 2>&1 || src=$?
    if [ "$src" -eq 0 ]; then
      say "SHALLOW: FAIL — an answer computed from a truncated graph was accepted (rc 0)"
      FAILED=1
    elif ! grep -qF "that repository is SHALLOW" "$sout"; then
      say "SHALLOW: FAIL — it refused (rc=$src) but did not name shallowness: $(head -1 "$sout")"
      FAILED=1
    elif grep -qF "happens to hold rather than a commit this code descends from" "$sout"; then
      say "SHALLOW: FAIL — it still says the repository merely HOLDS the pin, which is the false sentence round 20 removed"
      FAILED=1
    else
      say "SHALLOW: refused, and named it — 'that repository is SHALLOW', without the false 'happens to hold' sentence"
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
  say "SHALLOW: PLANT NOT ESTABLISHED — no anchor directory, so the completeness guard is UNMEASURED; failing closed under that name"
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
rm -rf "$ISO"; mkdir -p "$ISO/planted" "$ISO/tree/infrastructure/database" "$ISO/clean/infrastructure/database"
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
b = "if _p8_hit is not None:"
assert s.count(a) == 1, "the isolated-mode test is not where this patcher expects it"
assert s.count(b) == 1, "the sys.path test is not where this patcher expects it"
s = s.replace(a, "if False:", 1).replace(b, "if False:", 1)
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
cat > "$PATCHDIR/drop-path-test.py" <<'PATCH'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
a = "if not sys.flags.isolated:"
b = "if _p8_hit is not None:"
assert s.count(a) == 1, "the isolated-mode test is not where this patcher expects it"
assert s.count(b) == 1, "the sys.path test is not where this patcher expects it"
# ONLY the second test, and the first one left standing: that is the whole
# point of this patcher next to `unisolate.py`.
s = s.replace(b, "if False:", 1)
open(dst, "w", encoding="utf-8").write(s)
PATCH

ISO_OK=1
if [ ! -f "$ISO/planted/hashlib.py" ] || [ ! -s "$ISO/planted/p8-frozen-integrity.py" ]; then
  say "ISOLATION: PLANT NOT ESTABLISHED — the planted module or the copied check is missing"
  FAILED=1; ISO_OK=0
elif ! cmp -s "$HERE/p8-frozen-integrity.py" "$ISO/planted/p8-frozen-integrity.py"; then
  say "ISOLATION: PLANT NOT ESTABLISHED — the copied check is not byte-identical to the real one, so the arms below would measure a different program"
  FAILED=1; ISO_OK=0
elif [ "$(copied_digest "$REPO/infrastructure/database")" \
     = "$(copied_digest "$ISO/tree/infrastructure/database")" ]; then
  say "ISOLATION: PLANT NOT ESTABLISHED — the tamper did not land, so there is nothing for the plant to hide"
  FAILED=1; ISO_OK=0
else
  say "ISOLATION: the plant holds — a byte-identical copy of the check, a planted hashlib beside it, and a frozen migration modified in the tree it judges"
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
    say "ISOLATION: PLANT NOT ESTABLISHED — the guard-deletion patcher did not match its anchors"
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
    say "ISOLATION: PLANT NOT ESTABLISHED — the second spelling is not a symlink to the directory the check lives in, so y17 would measure two different directories"
    FAILED=1
  else
    say "ISOLATION: the two spellings hold — '$ISO/spelling' is a symlink resolving to '$ISO/planted', so y16 and y17 differ only in HOW the same directory is named"
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
    elif grep -q "NOT ISOLATED" "$_o" && grep -q "which resolves to" "$_o"; then
      say "GUARD-CTL y17: a symlinked spelling of the same directory is refused on IDENTITY, and the refusal names the entry and what it resolves to"
    else
      say "FAIL: GUARD-CTL y17 — it refused, but not on identity with both spellings named"; head -2 "$_o" | tee -a "$OUT/run.log"; FAILED=1
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
  say "RETIREMENT: all six retired files are present under retired/, none deleted"
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
    say "RETIREMENT: the retired runner refuses by name (rc $RET_RC) and says what covers it now"
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
  say "RETIREMENT: no file outside retired/ names any of the ${#RET_NET[@]} retired spellings (the runner with or without .sh, and each retired case file), so no live list points at it"
fi

say "RUN=$RUN FAILED=$FAILED"
exit $FAILED
