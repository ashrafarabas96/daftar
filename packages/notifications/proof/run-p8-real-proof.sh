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
P8_ANCHOR_PIN=$(python3 "$HERE/p8-frozen-integrity.py" --print-pin 2>/dev/null)
case "$P8_ANCHOR_PIN" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) say "FAIL: the check did not report a forty-character anchor pin (got '$P8_ANCHOR_PIN'), so this gate has nothing to require of it"; FAILED=1 ;;
esac
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
elif ! git -C "$P8_ANCHOR_DIR" rev-parse --verify "${P8_ANCHOR_PIN}^{commit}" >/dev/null 2>&1; then
  say "FAIL: P8_GIT_ANCHOR_DIR=$P8_ANCHOR_DIR does not contain the anchor commit $P8_ANCHOR_PIN"
  FAILED=1
else
  ANCHOR_ARGS=(--git-dir "$P8_ANCHOR_DIR")
  say "the frozen boundary is anchored to $P8_ANCHOR_PIN (the ONE pin, read out of the check itself) in $P8_ANCHOR_DIR, read with replacement objects disabled"
fi
CLAIM_ARGS=(--expect-covered "$P8_EXPECT_COVERED" --expect-boundary "$P8_EXPECT_BOUNDARY" --expect-covered-digest "$P8_EXPECT_COVERED_DIGEST")
INTEGRITY_OUT=$OUT/frozen-integrity.log
# ROUND 17, N-2: the authoritative run must SAY that the anchor leg ran. Round
# 16's evidence for its strongest leg was the ABSENCE of a complaint, which is
# what every fail-open in this phase has looked like from outside — and the
# injection above produced exactly that: a quiet exit 0 whose next line said the
# leg had not run. The token is required, and the pin and directory inside it
# must be the ones this gate asked for.
if python3 "$HERE/p8-frozen-integrity.py" "$REPO" "${ANCHOR_ARGS[@]}" "${CLAIM_ARGS[@]}" > "$INTEGRITY_OUT" 2>&1; then
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
  if python3 "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only "$@" > "$out" 2>&1; then
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
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql && python3 -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations']=[r for r in m['migrations'] if r['name']!='0006_rls.sql'];json.dump(m,open(p,'w'))\"" \
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
  "python3 -c \"import json,os;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));od=sorted(f for f in os.listdir('infrastructure/database/migrations') if f.endswith('.sql'));m['frozenThrough']=od[5];json.dump(m,open(p,'w'))\"" \
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
  "python3 -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['frozenThrough']='0079a_nope.sql';json.dump(m,open(p,'w'))\"" \
  "the attested boundary cannot be located"
# (i) ROUND 14's BLOCKER, N-1, measured: a frozen migration DELETED together
#     with its manifest row. Round 13 closed "a row excuses a file"; this is the
#     mirror, where a file's absence excused its row's absence, and the whole of
#     gate 6 exited 0 reporting "79 files ... all 79 matching". The numbering is
#     what anchors the set now, so the hole must be NAMED.
integrity_must_refuse i \
  "rm infrastructure/database/migrations/0050_accounting_report_indexes.sql && python3 -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations']=[r for r in m['migrations'] if r['name']!='0050_accounting_report_indexes.sql'];json.dump(m,open(p,'w'))\"" \
  "MISSING NUMBER 0050"
# (j) ROUND 14, N-2: a SECOND row for one file, carrying the digest of an edited
#     copy and leaving the original row in place. The rows were read into a dict,
#     so the last one won silently and the check reported a pass on a record
#     holding two digests for one name.
integrity_must_refuse j \
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql && python3 -c \"import json,hashlib;p='infrastructure/database/MIGRATION_MANIFEST.json';h=hashlib.sha256(open('infrastructure/database/migrations/0006_rls.sql','rb').read()).hexdigest();m=json.load(open(p));m['migrations'].append({'name':'0006_rls.sql','sha256':h});json.dump(m,open(p,'w'))\"" \
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
  "python3 -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations'].append({'name':'0013a_ghost.sql','sha256':'0'*64});json.dump(m,open(p,'w'))\"" \
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
    say "ANCHOR-MUT $id: FAIL — no anchor was resolved, so this round's guard is untested"
    FAILED=1; return
  fi
  rm -rf "$sand"; mkdir -p "$sand/infrastructure/database"
  cp -r "$REPO/infrastructure/database/migrations" "$sand/infrastructure/database/migrations"
  cp "$REPO/infrastructure/database/MIGRATION_MANIFEST.json" "$sand/infrastructure/database/"
  ( cd "$sand" && eval "$setup" ) >/dev/null 2>&1
  if [ "$(copied_digest "$REPO/infrastructure/database")" \
     = "$(copied_digest "$sand/infrastructure/database")" ]; then
    say "ANCHOR-MUT $id: FAIL — the plant did not land; the sandbox is identical to the source"
    FAILED=1; return
  fi
  local bare=$sand/bare.log anch=$sand/anchored.log
  if python3 "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only > "$bare" 2>&1; then
    say "ANCHOR-MUT $id: bare — the tree is internally consistent and round 14's check PASSES it ($(grep -c . "$bare") lines, exit 0)"
  else
    say "ANCHOR-MUT $id: FAIL — the bare arm went RED, so this plant is not evidence about the anchor"
    head -2 "$bare" | tee -a "$OUT/run.log"
    FAILED=1; return
  fi
  if python3 "$HERE/p8-frozen-integrity.py" "$sand" "${ANCHOR_ARGS[@]}" > "$anch" 2>&1; then
    say "ANCHOR-MUT $id: FAIL — the ANCHORED arm passed too; the fail-open is still open"
    FAILED=1; return
  fi
  if grep -qF "$expect" "$anch"; then
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
  "python3 '$HERE/p8-plant.py' tail-renumber" \
  "the attested boundary has MOVED"
# (n) THE CHALLENGER'S PLANT B: the boundary moved down to the sixth migration
#     with every row above it deleted. 6 files, 6 rows, all matching, and the
#     other 81 files reported as merely beyond the manifest's coverage.
anchor_is_loadbearing n \
  "python3 '$HERE/p8-plant.py' boundary-shrink" \
  "the attested boundary has MOVED"
# (o) THE COORDINATOR'S LIMIT CASE: one row, the boundary at 0000. The numbering
#     law round 14 added is SATISFIED by [0], which is the plainest statement of
#     why pinning the low end was necessary but not sufficient.
anchor_is_loadbearing o \
  "python3 '$HERE/p8-plant.py' limit-one" \
  "the attested boundary has MOVED"
# (p) THE WHOLE-RECORD FORGERY: a frozen file edited AND its manifest row
#     updated to the edited digest. This is mutant (a) with the record brought
#     along, and it is the case the manifest can never catch, because the
#     manifest is what was forged. Only content read from the pinned commit sees
#     it.
anchor_is_loadbearing p \
  "printf '\n-- mutant\n' >> infrastructure/database/migrations/0006_rls.sql && python3 -c \"import json,hashlib;p='infrastructure/database/MIGRATION_MANIFEST.json';h=hashlib.sha256(open('infrastructure/database/migrations/0006_rls.sql','rb').read()).hexdigest();m=json.load(open(p));m['migrations']=[dict(r,sha256=h) if r['name']=='0006_rls.sql' else r for r in m['migrations']];json.dump(m,open(p,'w'))\"" \
  "ANCHOR DRIFT  0006_rls.sql"
# (q) A COVERED FILE RENAMED IN PLACE, row carried: same number, same bytes, a
#     different name. The numbering law holds, the equality holds, the digests
#     hold, the boundary is where it was — and the claimed figures hold too,
#     because the count and the digest-over-digests are both unchanged. This one
#     is caught by the anchor's FILE LIST and by nothing else in the pack.
anchor_is_loadbearing q \
  "mv infrastructure/database/migrations/0013_security_boundary.sql infrastructure/database/migrations/0013_security_boundaries.sql && python3 -c \"import json;p='infrastructure/database/MIGRATION_MANIFEST.json';m=json.load(open(p));m['migrations']=[dict(r,name='0013_security_boundaries.sql') if r['name']=='0013_security_boundary.sql' else r for r in m['migrations']];json.dump(m,open(p,'w'))\"" \
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
    say "ANCHOR-ID $id: FAIL — no anchor directory, so this plant is untested"
    FAILED=1; return
  fi
  # A CLONE of the anchor repository, so the real one is never written to. No
  # frozen migration is touched in any real tree: what is doctored is a ref and a
  # commit inside a throwaway clone.
  if ! git clone -q "$P8_ANCHOR_DIR" "$work/anchor" 2>"$work/clone.log"; then
    say "ANCHOR-ID $id: FAIL — could not clone the anchor repository: $(tail -1 "$work/clone.log")"
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
  python3 - "$sand" <<'PLANT'
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
  if python3 "$HERE/p8-frozen-integrity.py" "$sand" --inner-guards-only >"$work/inner.log" 2>&1; then
    say "ANCHOR-ID $id: the forged tree is internally consistent, as the plant requires"
  else
    say "ANCHOR-ID $id: FAIL — the forged tree is not internally consistent ($(head -1 "$work/inner.log")), so it does not reach the anchor at all"
    FAILED=1; return
  fi
  local out=$work/guarded.log
  # shellcheck disable=SC2086  # deliberate flag lists
  if python3 "$HERE/p8-frozen-integrity.py" "$sand" --git-dir "$work/anchor" $extra > "$out" 2>&1; then
    say "ANCHOR-ID $id: FAIL — the check CONFIRMED a forged tree against a doctored anchor"
    FAILED=1; return
  fi
  if grep -qF "$expect" "$out"; then
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
  python3 - "$HERE/p8-frozen-integrity.py" "$nog" <<'DELETE' || pat=$?
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
  if python3 "$nog" "$sand" --git-dir "$work/anchor" $extra > "$work/no-guards.log" 2>&1; then
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
      python3 "$HERE/p8-frozen-integrity.py" "$sand" "$@" > "$out" 2>&1 || rc=$?
  if [ "$mode" = refuse ] && [ "$rc" -eq 0 ]; then
    say "ARGSHAPE $id: FAIL — the check exited 0 on an injected argument; first line: $(head -1 "$out")"
    FAILED=1; return
  fi
  if [ "$mode" = pass ] && [ "$rc" -ne 0 ]; then
    say "ARGSHAPE $id: FAIL — the check refused an HONEST caller (rc=$rc): $(head -1 "$out")"
    FAILED=1; return
  fi
  if grep -qF "$expect" "$out"; then
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
  say "ARGSHAPE v: FAIL — no anchor directory, so this arm is untested"; FAILED=1
fi
# (w) THE HONEST SPACED PATH. The quoting fix is only proved by a caller a
#     naive implementation would truncate: this directory's name contains a
#     space, and the run must exercise the anchor leg against it and say so.
if [ -n "$P8_ANCHOR_DIR" ]; then
  SPACED="$OUT/spaced anchor dir"
  rm -rf "$SPACED"; mkdir -p "$SPACED"
  if git clone -q "$P8_ANCHOR_DIR" "$SPACED/anchor" 2>"$OUT/spaced-clone.log"; then
    arg_shape w pass \
      "ANCHOR LEG EXERCISED: pin=$P8_ANCHOR_PIN dir=$SPACED/anchor" \
      --git-dir "$SPACED/anchor"
  else
    say "ARGSHAPE w: FAIL — could not clone the anchor into a spaced path: $(tail -1 "$OUT/spaced-clone.log")"
    FAILED=1
  fi
else
  say "ARGSHAPE w: FAIL — no anchor directory, so this arm is untested"; FAILED=1
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
  say "ARGSHAPE x: FAIL — no anchor directory, so this arm is untested"; FAILED=1
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
  python3 - "$sand" <<'TAMPER'
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
  python3 "$patcher" "$HERE/p8-frozen-integrity.py" "$nog" >"$work/patch.log" 2>&1 || pat=$?
  if [ "$pat" -ne 0 ] || [ ! -s "$nog" ]; then
    say "GUARD-CTL $id: FAIL — the patcher did not apply (exit $pat: $(tail -1 "$work/patch.log")), so this arm measured nothing"
    FAILED=1; return
  fi
  local out=$work/out.log rc=0
  python3 "$nog" "$sand" "$@" > "$out" 2>&1 || rc=$?
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
a = '    if anchor_dir is not None and anchor_dir.startswith("-"):'
assert s.count(a) == 1, "the option-shaped refusal is not where this expects it"
s = s.replace(a, "    if False:", 1)
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
  say "GUARD-CTL: FAIL — no anchor directory, so none of this round's guards is measured"
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
    say "LINEAGE: FAIL — could not clone the anchor repository: $(tail -1 "$LIN/clone.log")"
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
      say "LINEAGE: FAIL — the doctored clone no longer holds the pin at all, so this plant tests reachability, not lineage"
      FAILED=1
    elif git -C "$LIN/orphan" merge-base --is-ancestor "$P8_ANCHOR_PIN" HEAD 2>/dev/null; then
      say "LINEAGE: FAIL — the doctored clone still descends from the pin, so the plant did not land"
      FAILED=1
    else
      say "LINEAGE: the plant holds the pin as an object and is not descended from it, as required"
      if python3 "$HERE/p8-frozen-integrity.py" "$LIN/tree" --git-dir "$LIN/orphan" >"$LIN/guarded.log" 2>&1; then
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
else
  say "LINEAGE: FAIL — no anchor directory, so the lineage guard is untested"
  FAILED=1
fi

say "=== the claimed figures, measured (the weaker leg) ==="
integrity_must_refuse m2 \
  "python3 '$HERE/p8-plant.py' tail-renumber" \
  "COVERED COUNT  expected 80, measured 79" "${CLAIM_ARGS[@]}"
integrity_must_refuse n2 \
  "python3 '$HERE/p8-plant.py' boundary-shrink" \
  "COVERED COUNT  expected 80, measured 6" "${CLAIM_ARGS[@]}"
integrity_must_refuse o2 \
  "python3 '$HERE/p8-plant.py' limit-one" \
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

# ---------------------------------------------------------------------
# 4  Rebuild the baseline, so the cluster is left in the proved state
# ---------------------------------------------------------------------
build "$HERE/p8-overlay.sql" "$OUT/final" >/dev/null && cases "$OUT/final" \
  && say "cluster left at the baseline, passes=$(cat "$OUT/final/passes")" \
  || { say "FAIL: could not restore the baseline"; FAILED=1; }

say "RUN=$RUN FAILED=$FAILED"
exit $FAILED
