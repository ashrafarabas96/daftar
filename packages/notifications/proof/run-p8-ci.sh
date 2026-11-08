#!/usr/bin/env bash
# =====================================================================
# Phase 8 — the CI arm of the real-schema proof
# =====================================================================
# WHY THIS FILE EXISTS. `run-p8-real-proof.sh` is the gate; it is not a CI
# step. It refuses to start unless a PostgreSQL 16 cluster is already
# answering as the superuser `p8super` on its own socket directory, and it
# says so in its own words: "start the cluster first". Until now nothing
# started one anywhere, so the gate ran only by hand, on a developer's
# machine, and ITS RESULT WAS NEVER A FACT ABOUT A COMMIT. This file is the
# part CI runs: it builds the cluster the gate requires, runs the gate, and
# then reads the gate's own log against floors THIS file declares.
#
# WHY THE FLOORS ARE HERE AND NOT ONLY IN THE GATE. The gate already carries
# two: `P8_EXPECT_CASES=101` and the sealed `EXPECTED_ARMS` set in
# `p8-arm-census.py`. Both are inside the subject. A commit that lowers the
# literal and loses the case lowers the bar and the gate stays green — which
# is the shape of false success this step is built against, measured on the
# sibling lane: a step that executed ZERO cases exited 0 and a required job
# went green with every case NOT_RUN. So the floor is declared OUTSIDE the
# subject, here, and a run that executes fewer cases or fewer arms than this
# file names is a RED STEP whatever the gate itself concluded.
#
# WHAT IT DOES NOT CLAIM. It proves nothing about timing or throughput, and
# the cluster it builds is a throwaway: no data in it outlives the job. It
# makes no claim about the `services:` postgres the rest of the job uses —
# it never touches port 5432, and the gate DROPS AND CREATES a database
# called `daftar`, which is exactly why it must not.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)

# ── Floors, declared outside the subject ──────────────────────────────
# Measured on this tree, not copied from a document:
#   cases — `run-p8-real-proof.sh:322` declares 101 and asserts it.
#   arms  — `p8-arm-census.py` declares 279 arm identities, 279 arm lines,
#           under seal 25f89d78…; counted off the declaration itself.
P8_CI_MIN_CASES=${P8_CI_MIN_CASES:-101}
P8_CI_MIN_ARMS=${P8_CI_MIN_ARMS:-279}

# ── The cluster the gate requires ─────────────────────────────────────
# `$D` is BOTH the socket directory the gate connects to (`psql -h "$D"`)
# and the parent of its run directory, so PGDATA is a child of it and the
# socket lives in it.
B=${PG_BIN:-/usr/lib/postgresql/16/bin}
D=${P8_PG_DIR:-/var/tmp/p8pg}
P=${P8_PG_PORT:-55438}
PGDATA=$D/data
RUN=${RUN_ID:-P8-CI-$(date -u +%Y%m%dT%H%M%SZ)}

fail() { echo "P8_CI_FAIL: $*" >&2; exit 1; }

for bin in initdb pg_ctl psql pg_isready; do
  [ -x "$B/$bin" ] || fail "$B/$bin is missing. This step needs the PGDG PostgreSQL 16 binaries the job installs earlier; it does not use the services: container, because the gate drops and creates a database named 'daftar'."
done

command -v python3 >/dev/null 2>&1 || fail "python3 is absent, and the frozen-integrity check, the plant and the arm census are all Python programs the gate RUNS and whose exit codes it reads."

REPO=$(cd "$HERE/../../.." && pwd)
[ -x "$REPO/node_modules/.bin/tsx" ] || fail "$REPO/node_modules/.bin/tsx is missing — run npm ci at the repository root first; the gate applies the migration history with the project's own migrate.ts."

# A stale cluster from a previous attempt would make the gate measure another
# run's state. The directory is removed outright: it is under /var/tmp on a
# disposable runner and holds nothing but this step's own cluster.
if [ -d "$PGDATA" ]; then
  "$B/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$D" || fail "the previous cluster directory $D could not be removed, and reusing it would mix two runs"
fi
mkdir -p "$D" || fail "could not create $D"

# en_US.utf8 and UTF8 are not preferences: the gate ASSERTS both, and aborts
# on anything else, because every arrival term in the pack compares the
# server's English refusal prose byte for byte.
"$B/initdb" -D "$PGDATA" -U p8super --encoding=UTF8 --locale=en_US.utf8 \
  > "$D/initdb.log" 2>&1 || fail "initdb failed: $(tail -3 "$D/initdb.log" | tr '\n' ' ')"

# `-k "$D"` puts the socket where the gate looks; `-h ''` refuses TCP
# entirely, so this cluster cannot be reached from anywhere but this step.
"$B/pg_ctl" -D "$PGDATA" -o "-p $P -k $D -h ''" -l "$D/server.log" -w start \
  > "$D/pgctl.log" 2>&1 || fail "the cluster did not start: $(tail -5 "$D/server.log" | tr '\n' ' ')"

"$B/pg_isready" -h "$D" -p "$P" > "$D/isready.log" 2>&1 \
  || fail "the cluster started and does not answer at $D:$P: $(cat "$D/isready.log")"

echo "P8_CI_CLUSTER: pgdata=$PGDATA socketdir=$D port=$P superuser=p8super"
"$B/psql" -h "$D" -p "$P" -U p8super -d postgres -tAc \
  "SELECT 'P8_CI_SERVER: ' || version() || ' lc_collate=' || (SELECT datcollate FROM pg_database WHERE datname='postgres') || ' lc_messages=' || current_setting('lc_messages')" \
  || fail "the cluster answered pg_isready and not a query as p8super"

# ── The anchor for the frozen boundary ────────────────────────────────
# The gate requires `P8_GIT_ANCHOR_DIR`: a repository OUTSIDE the tree under
# test that contains the anchor commit, is not shallow, and DESCENDS from it.
# Unset, the gate says "the frozen boundary has no witness outside the tree
# under test; refusing to report a pass" and reds — so this wrapper was
# INCOMPLETE until it set it, and nothing said so until the gate was first
# run end to end and refused for exactly that reason.
#
# The repository's own git directory is that witness: the tree under test is
# a COPY the gate makes, and every plant happens in the copy, never here. An
# operator who has a separate checkout can still pass their own; this is a
# default, not an override.
#
# It fails CLOSED and names which of the two it is: a worktree's `.git` is a
# FILE pointing at the common directory, so the path is resolved with git
# itself rather than assumed to be a directory. `--git-common-dir` is what a
# worktree needs; in a plain clone it is the same `.git`.
if [ -z "${P8_GIT_ANCHOR_DIR:-}" ]; then
  ANCHOR=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)     || fail "P8_GIT_ANCHOR_DIR is not set and $REPO is not a git repository, so the frozen boundary would have no witness outside the tree under test — the gate refuses to report a pass without one, and so does this wrapper rather than letting it red for a reason an operator cannot act on."
  [ -n "$ANCHOR" ] && [ -e "$ANCHOR" ]     || fail "P8_GIT_ANCHOR_DIR is not set and git in $REPO reported no usable common git directory (it said '$ANCHOR'); an empty answer is not a path."
  export P8_GIT_ANCHOR_DIR="$ANCHOR"
  echo "P8_CI_ANCHOR: P8_GIT_ANCHOR_DIR defaulted to $P8_GIT_ANCHOR_DIR (the repository's own git directory; the tree under test is a copy)"
else
  echo "P8_CI_ANCHOR: P8_GIT_ANCHOR_DIR given by the operator: $P8_GIT_ANCHOR_DIR"
fi
# And the gate's three conditions are READ here, not assumed, so a checkout
# that cannot serve as the anchor says which condition it fails before forty
# minutes of cases run. `fetch-depth: 0` on the backend job's checkout is what
# makes a CI run satisfy them; a depth-1 clone holds no such commit.
ANCHOR_PIN=$(python3 -I "$HERE/p8-frozen-integrity.py" --print-pin 2>/dev/null)
case "$ANCHOR_PIN" in
  ????????????????????????????????????????) ;;
  *) fail "the check did not report a forty-character anchor pin (got '$ANCHOR_PIN'), so neither it nor this wrapper has anything to require of the anchor." ;;
esac
git --git-dir="$P8_GIT_ANCHOR_DIR" rev-parse --verify "${ANCHOR_PIN}^{commit}" >/dev/null 2>&1   || fail "the anchor repository $P8_GIT_ANCHOR_DIR does not contain the anchor commit $ANCHOR_PIN; fetch the full history (fetch-depth 0) or pass P8_GIT_ANCHOR_DIR for a checkout that holds it."
git --git-dir="$P8_GIT_ANCHOR_DIR" merge-base --is-ancestor "$ANCHOR_PIN" HEAD 2>/dev/null   || fail "the anchor repository $P8_GIT_ANCHOR_DIR holds $ANCHOR_PIN but HEAD does not DESCEND from it, so it is a repository that happens to hold the object and the gate would refuse it as ANCHOR LINEAGE."
echo "P8_CI_ANCHOR_PIN: $ANCHOR_PIN present, and HEAD descends from it"

# ── The mount namespace ───────────────────────────────────────────────
# OWNER DECISION 2026-11-08, route A. Thirteen DECLARED arms live behind
# `mount --bind`, which an unprivileged user may not call. The gate names
# that condition — ISOLATION i8: PLANT NOT ESTABLISHED — and reds, and the
# arm census then reds by ARM MISSING. Run 42442391409 on a GitHub runner
# and three local runs in a WSL container printed the SAME sentence
# (`must be superuser to use mount.`), so the condition is the
# environment's and not the tree's.
#
# `unshare -r -m` gives the gate its own mount namespace with the invoking
# user mapped to root INSIDE it, which is how a bind mount is built without
# privilege. Three things are MEASURED here rather than assumed:
#
#   1. the namespace can be created AND a bind mount inside it succeeds;
#   2. the cluster, which runs OUTSIDE this namespace, is still reachable
#      from INSIDE it — the socket path and the peer credential are the
#      gate's only route to the database, and both cross a namespace
#      boundary that did not exist when the cluster was started;
#   3. when either fails, the gate runs EXACTLY as before, outside any
#      namespace, and reds by ISOLATION i8 and ARM MISSING under their own
#      names. There is no skip, no raised limit, no floor change and no
#      re-seal: the sealed numbers stay 101 cases and 279 arms, and the
#      gate's own text is not touched by this decision.
#
# The probe is a FILE, not an inlined string, because a quoted-in-quoted
# body would be the shell's reading of this file rather than the
# namespace's own behaviour.
USERNS_OK=no
UNS_LOG=$D/userns.log
UNS_PROBE=$D/userns-probe.sh
{
  echo 'set -eu'
  echo 'p=$(mktemp -d)'
  echo 'mkdir -p "$p/a" "$p/b"'
  echo 'mount --bind "$p/a" "$p/b"'
  echo 'mountpoint -q "$p/b"'
  echo '"$PG_BIN/psql" -h "$PG_DIR" -p "$PG_PORT" -U p8super -d postgres -Atc "select 1" > "$p/sel" 2>&1'
  echo 'grep -qx 1 "$p/sel"'
  echo 'echo "PROBE OK: namespace created, bind mount held, cluster answered from inside"'
} > "$UNS_PROBE"

if ! command -v unshare >/dev/null 2>&1; then
  echo "P8_CI_USERNS: NOT AVAILABLE — there is no unshare binary on PATH, so the gate runs outside any namespace and will red by ISOLATION i8 and ARM MISSING under their own names"
elif PG_BIN="$B" PG_DIR="$D" PG_PORT="$P" unshare -r -m bash "$UNS_PROBE" > "$UNS_LOG" 2>&1; then
  USERNS_OK=yes
  echo "P8_CI_USERNS: OK — $(tail -1 "$UNS_LOG")"
else
  echo "P8_CI_USERNS: NOT AVAILABLE — unshare -r -m, or the bind mount inside it, or the cluster as seen from inside it, refused. The gate runs outside any namespace and reds by ISOLATION i8 and ARM MISSING under their own names, as it did before this decision. THE TOOL'S OWN WORDS: $(head -3 "$UNS_LOG" | tr '\n' ' ')"
fi

# ── The gate ──────────────────────────────────────────────────────────
# Its exit code is read from the command itself and not from the end of a
# pipe. Its own log is the evidence the floors below are read from.
if [ "$USERNS_OK" = yes ]; then
  PG_BIN="$B" PG_DIR="$D" PG_PORT="$P" RUN_ID="$RUN" unshare -r -m bash "$HERE/run-p8-real-proof.sh"
else
  PG_BIN="$B" PG_DIR="$D" PG_PORT="$P" RUN_ID="$RUN" bash "$HERE/run-p8-real-proof.sh"
fi
gate_rc=$?
echo "P8_CI_GATE_RC=$gate_rc"

LOG=$D/$RUN/run.log

# ── The floors ────────────────────────────────────────────────────────
# A probe that produces emptiness is not a probe that produced a zero, so
# the log's existence and non-emptiness are asserted before any number is
# read out of it.
[ -s "$LOG" ] || fail "the gate wrote no log at $LOG, so there is nothing to read a count out of, and an absent count is not a zero. gate_rc=$gate_rc"
log_lines=$(grep -c . "$LOG")
echo "P8_CI_LOG: $LOG lines=$log_lines"

floor_failed=0

cases_line=$(grep -F "BASELINE CASE COUNT:" "$LOG" | tail -1)
if [ -z "$cases_line" ]; then
  echo "P8_CI_FLOOR_CASES: FAIL — the gate's log carries no 'BASELINE CASE COUNT:' sentence at all, so no case count was measured; the baseline either did not build or did not report." >&2
  floor_failed=1
else
  cases_got=$(printf '%s' "$cases_line" | sed -E 's/.*BASELINE CASE COUNT: ([0-9]+).*/\1/')
  case "$cases_got" in
    ''|*[!0-9]*)
      echo "P8_CI_FLOOR_CASES: FAIL — the count could not be read as a number out of: $cases_line" >&2
      floor_failed=1 ;;
    *)
      if [ "$cases_got" -lt "$P8_CI_MIN_CASES" ]; then
        echo "P8_CI_FLOOR_CASES: FAIL — $cases_got cases executed, below the floor of $P8_CI_MIN_CASES this step declares outside the gate. A case was lost, or the gate's own literal was lowered with it." >&2
        floor_failed=1
      else
        echo "P8_CI_FLOOR_CASES: $cases_got cases executed, floor $P8_CI_MIN_CASES"
      fi ;;
  esac
fi

census_line=$(grep -F "ARM CENSUS:" "$LOG" | tail -1)
if [ -z "$census_line" ]; then
  echo "P8_CI_FLOOR_ARMS: FAIL — the gate's log carries no 'ARM CENSUS:' sentence, so the arm set was never counted; the census refuses by name, and its silence is not a pass." >&2
  floor_failed=1
else
  arms_got=$(printf '%s' "$census_line" | sed -E 's/.*ARM CENSUS: ([0-9]+) named arms.*/\1/')
  case "$arms_got" in
    ''|*[!0-9]*)
      echo "P8_CI_FLOOR_ARMS: FAIL — the arm count could not be read as a number out of: $census_line" >&2
      floor_failed=1 ;;
    *)
      if [ "$arms_got" -lt "$P8_CI_MIN_ARMS" ]; then
        echo "P8_CI_FLOOR_ARMS: FAIL — $arms_got named arms, below the floor of $P8_CI_MIN_ARMS this step declares outside the census. An arm stopped naming itself, which is a loss the census alone has been measured to miss." >&2
        floor_failed=1
      else
        echo "P8_CI_FLOOR_ARMS: $arms_got named arms, floor $P8_CI_MIN_ARMS"
      fi ;;
  esac
fi

# ── The thirteen arms the namespace was adopted for ───────────────────
# The census reds by ARM MISSING when any declared identity stops naming
# itself, which is the law. This block is the POSITIVE control the owner
# required of route A: it names the thirteen that the bind mount gates and
# reads each one out of the gate's own log, so a reader is not left to
# infer from a total that they ran. The list lives HERE, outside the
# census and outside the gate, exactly as the two counts above do; it adds
# no identity and changes no floor.
BIND_ARMS="ISOLATION i10|ISOLATION i11|ISOLATION i12|GUARD-CTL y20a|GUARD-CTL y20b|GUARD-CTL y20c|GUARD-CTL y20d|GUARD-CTL y21a|GUARD-CTL y21b|GUARD-CTL y21c|GUARD-CTL y21d|CENSUS-MULT a2|CENSUS-MULT-CTL"
bind_named=0; bind_absent=
OLDIFS=$IFS; IFS='|'
for arm in $BIND_ARMS; do
  # An arm that RAN and failed names itself as `FAIL: <arm> —`, and one that
  # ran and held names itself as `<arm>:`. Both are the arm reporting; only
  # silence is the loss this reads for, so the pattern admits either.
  if grep -qE "\] (FAIL: )?$arm[ :]" "$LOG"; then
    bind_named=$((bind_named + 1))
  else
    bind_absent="$bind_absent $arm,"
  fi
done
IFS=$OLDIFS
if [ "$bind_named" -eq 13 ]; then
  echo "P8_CI_BIND_ARMS: all 13 of the arms that depend on the bind mount named themselves in the gate's own log, under a namespace this step measured before using (P8_CI_USERNS above)"
elif [ "$USERNS_OK" = yes ]; then
  echo "P8_CI_BIND_ARMS: FAIL — the namespace was measured usable and the gate still did not name $((13 - bind_named)) of the 13 bind arms:${bind_absent%,} — so the mount is not what was standing between this step and them, and nothing here may be read as a pass." >&2
  floor_failed=1
else
  echo "P8_CI_BIND_ARMS: $bind_named of 13 — no usable mount namespace, so these are the arms the census reds by name:${bind_absent%,}" >&2
fi

verdict=$(grep -oE "FAILED=[0-9]+" "$LOG" | tail -1)
if [ "$verdict" != "FAILED=0" ]; then
  echo "P8_CI_FLOOR_VERDICT: FAIL — the gate's own verdict line is '${verdict:-ABSENT}'." >&2
  floor_failed=1
else
  echo "P8_CI_FLOOR_VERDICT: $verdict"
fi

"$B/pg_ctl" -D "$PGDATA" -m fast stop > "$D/stop.log" 2>&1 || true

if [ "$gate_rc" -ne 0 ] || [ "$floor_failed" -ne 0 ]; then
  echo "P8_CI_RESULT: FAIL gate_rc=$gate_rc floors_failed=$floor_failed"
  exit 1
fi
echo "P8_CI_RESULT: PASS gate_rc=0 cases=$cases_got arms=$arms_got"
exit 0
