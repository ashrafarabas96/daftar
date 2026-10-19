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

# `C26-S1`, the coordinator's P2: this file pinned `git` absolutely and scrubbed
# its whole environment, and then asked `PATH` for `python3` at seventeen sites
# -- every verdict in the pack. A `python3` placed first on `PATH` that honours
# `-I` by ignoring it forges each gate's baseline line byte for byte, and `-I`
# cannot help: the flag is handed to the planted binary, and the
# `sys.flags.isolated` refusal lives inside the file that binary never runs.
# The regress ends OUTSIDE the file under attack, which for an interpreter means
# an absolute path, resolved once here and printed, exactly as `gitq` does one
# function below.
PY=/usr/bin/python3
if [ ! -x "$PY" ]; then
  echo "PYTHON-ABSENT: $PY is not an executable file, so every gate below would be run"
  echo "by whatever \`PATH\` resolves \`python3\` to. That is the one thing this pin is"
  echo "for. Refusing to run."
  exit 5
fi

# `R26-S1`, and the whole of what makes a figure legitimate here now: THE
# OUTPUT OF THIS RUN. The haystack used to be the text of the files under
# `prep/phase11/harness/`, and the second challenger of round 26 drove a
# fabricated figure through it with a `#` comment and with a committed `.py`
# that nothing runs -- source text is alterable text. So this script captures
# its OWN output to a file outside the work tree and hands the path to the
# figure gate, which runs at the END of the run rather than at step 0c,
# because a capture is only worth what has been printed into it.
#
# The capture is made by re-entering this script once with its output through
# `tee`. `pipefail` is set above and the exit status taken is the script's own,
# not `tee`'s.
if [ -z "${P11_RUN_CAPTURE:-}" ]; then
  P11_RUN_CAPTURE="$(mktemp -t p11-run-capture-XXXXXXXX)" || exit 5
  export P11_RUN_CAPTURE
  bash "$0" "$@" 2>&1 | tee -a "$P11_RUN_CAPTURE"
  RC_OUTER=${PIPESTATUS[0]}
  exit $RC_OUTER
fi

REPO=${P11_REPO:-/home/user/daftar}
S=${P11_SCRATCH:-/var/tmp/p11u}
PORT=${P11_PORT:-55512}
SOCK=$S/run
PG=/usr/lib/postgresql/16/bin
Q="su postgres -s /bin/bash -c"
export P11_SOCK=$SOCK P11_PORT=$PORT
H=$REPO/prep/phase11/harness
PSQL_P="$PG/psql -h $SOCK -p $PORT"

# `R23-S2`. Both readers build git's environment from scratch and pin the
# binary; this script asked the ambient `git` with the ambient environment, and
# `GIT_DIR` beats `-C` while `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME` and a
# planted `git` earlier on `PATH` each answer for the subject. One function, used
# for every read below.
gitq () {
  env -i PATH=/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null \
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_GRAFT_FILE=/dev/null \
      GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C \
      /usr/bin/git --no-replace-objects -C "$REPO" "$@"
}

# `R23-F2`. This used to be `gitq status --porcelain` alone, and that is a
# statement about the INDEX: the coordinator flagged a frozen migration with
# `--skip-worktree`, appended a `CREATE TABLE`, and `status` printed nothing
# while the planted table ran. The question is asked of the DISK now, by the
# second reader, which recomputes every committed path's blob name from the
# bytes on disk; `status` is kept beside it only to LIST entries for a human,
# never to decide. The reader is a deciding file whose own bytes are compared
# at step 0c-0, and it refuses itself if they moved.
TREE_STATE="$($PY -I $H/check_harness_bytes.py --tree-state 2>/var/tmp/p11-treestate.$$ || true)"
TREE_WHY="$(cat /var/tmp/p11-treestate.$$ 2>/dev/null; rm -f /var/tmp/p11-treestate.$$)"
# THE COORDINATOR'S `F5` on `50a45a0`. This used to be
# `[ "$TREE_STATE" = "no" ] || DIRTY="$TREE_STATE"`, which reads an EMPTY
# answer -- the reader crashed, was deleted, or could not be run -- as a clean
# tree, and then prints `SOURCE_TREE_DIRTY :` with nothing after it. A figure
# that is absent is not a figure that says `no`. The reader answers `no` or
# `YES` and nothing else, so anything else is a refusal of its own.
case "$TREE_STATE" in
  no) DIRTY="" ;;
  YES) DIRTY="YES" ;;
  *)
    echo "REFUSED: SOURCE-TREE-STATE-UNREADABLE: the byte reader was asked whether this"
    echo "work tree is the tree the commit holds and answered $(printf '%s' "${TREE_STATE:-<nothing>}"),"
    echo "which is neither 'no' nor 'YES'. An absent answer is not a clean tree. What it"
    echo "said on the way out:"
    echo "$TREE_WHY" | sed 's/^/  /'
    echo "EXIT_SOURCE_TREE_STATE: 5  (refused before the cluster and every gate)"
    exit 5
    ;;
esac
# THE COORDINATOR'S `F1` on `50a45a0`, the blocker, read here by the refusal
# NAME rather than by an exit code: an UNTRACKED `.sql` in the migrations
# directory was applied by `run_migrations.py` (`sorted(os.listdir(MIGDIR))`)
# and the whole run was green -- `APPLIED 88/88`, `SOURCE_TREE_DIRTY : no`.
# Both readers refuse it now; this is the third site, and it is separate from
# SOURCE-TREE-DIRTY because a file the commit does not hold is a different
# thing from a file whose bytes moved, and a reader sent to one name should not
# be told the other.
# `C25-S1`, the coordinator's naming residual: this test used to read
# `UNTRACKED:` alone, which matches `HARNESS-TREE-UNTRACKED:` and
# `HARNESS-UNTRACKED-UNREADABLE:` and NOT `HARNESS-READ-DIR-ABSENT:` -- so in a
# world where a directory the run reads is gone, the shell named
# SOURCE-TREE-DIRTY, which is the other law. The three names the reader can
# give for this one question are read here by name, as alternatives, because
# the pack's own rule is that a reader sent to one name must not be told
# another.
if printf '%s' "$TREE_WHY" | grep -qE 'HARNESS-TREE-UNTRACKED:|HARNESS-UNTRACKED-UNREADABLE:|HARNESS-READ-DIR-ABSENT:'; then
  echo "REFUSED: SOURCE-TREE-UNTRACKED: a directory this run READS either carries a path"
  echo "the commit does not hold, could not be walked, or is absent -- and the run applies"
  echo "and reads what is on disk, so nothing below would be a measurement of the"
  echo "committed code. What the reader said:"
  printf '%s\n' "$TREE_WHY" \
    | grep -E 'HARNESS-TREE-UNTRACKED:|HARNESS-UNTRACKED-UNREADABLE:|HARNESS-READ-DIR-ABSENT:' \
    | sed 's/^/  /'
  echo "and what git status lists, for a reader (it is not what decided above):"
  gitq status --porcelain | sed 's/^/  /'
  echo "EXIT_SOURCE_TREE_UNTRACKED: 5  (refused before the cluster and every gate)"
  exit 5
fi
FLAGGED="$(gitq ls-files -v | grep -E '^([a-z]|S) ' || true)"
if [ -n "$FLAGGED" ]; then
  # `R23-F2` and the coordinator's `F1` on the head before this one: an index
  # flag -- `git update-index --assume-unchanged` or `--skip-worktree` -- stops
  # git looking at a tracked path. It edits no file and commits nothing, and the
  # coordinator put such a flag on a MIGRATION, appended a CREATE TABLE, and got
  # a full green suite that printed `SOURCE_TREE_DIRTY : no` while the planted
  # table really ran. So the flags are refused here by a name of their own, and
  # both readers refuse them again by theirs -- and what no flag can move, the
  # bytes, is what the readers compare.
  echo "REFUSED: SOURCE-INDEX-FLAGGED: tracked paths are flagged so that git stops"
  echo "looking at them, so neither the line above nor anything below is a statement"
  echo "about what this run reads. The flagged paths:"
  echo "$FLAGGED" | sed 's/^/  /'
  echo "EXIT_SOURCE_INDEX_FLAGGED: 5  (refused before the cluster and every gate)"
  exit 5
fi
if [ -n "$DIRTY" ]; then
  # THE COORDINATOR'S `F1` RULING, round 22. The byte law covers every deciding
  # file and it cannot cover THE FILE THAT INVOKES IT: an uncommitted version of
  # this script with the four checking lines replaced by `true`, or an
  # uncommitted `check_fenced_figures.py` whose call site passes a guard off and
  # whose invocation of the second reader returns early, produced a full green
  # run with the law never executed. No check inside a self-run entry point can
  # stop that -- the entry point is what would run the check.
  #
  # What CAN be true is that such a tree produces NO ADMISSIBLE TRANSCRIPT. So a
  # dirty tree is FATAL here, and refused by name in both readers as well, where
  # deleting it from this script does not reach. A transcript is evidence only
  # when it was produced from a CLEAN tree whose HEAD is the committed sha, and
  # reviewers run from fresh clones. An uncommitted edit -- one file or many --
  # is then the declared limit rather than a measured escape.
  echo "REFUSED: SOURCE-TREE-DIRTY: the work tree at $REPO is not the tree the commit"
  echo "holds -- measured by recomputing each committed path's blob name from the bytes"
  echo "on disk -- so nothing below would be a measurement of the committed code and its"
  echo "transcript would not be evidence. What the comparison said:"
  echo "$TREE_WHY" | sed 's/^/  /'
  echo "and what git status lists, for a reader (it is not what decided above):"
  gitq status --porcelain | sed 's/^/  /'
  echo "EXIT_SOURCE_TREE_DIRTY: 5  (refused before the cluster, the identity block and every gate)"
  exit 5
fi

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
echo "SOURCE_REPO       : $(gitq config --get remote.origin.url)"
echo "SOURCE_BRANCH     : $(gitq rev-parse --abbrev-ref HEAD)"
echo "SOURCE_SHA        : $(gitq rev-parse HEAD)"
# The line the figure gate reads: a capture is weighed against ONE commit, and
# a capture that does not carry this head is refused by name
# (`RUN-CAPTURE-NOT-THIS-HEAD`). It is not a proof of provenance and is not
# written as one -- see `R26-S5` in the gate's own header.
echo "RUN_HEAD          : $(gitq rev-parse HEAD)"
echo "RUN_CAPTURE       : $P11_RUN_CAPTURE   (this run's own output, outside the work tree: the figure gate's haystack)"
echo "PYTHON            : $PY   ($($PY -I -c 'import sys;print(sys.version.split()[0], "isolated" if sys.flags.isolated else "NOT ISOLATED")'))"
echo "SOURCE_TREE_DIRTY : $TREE_STATE   (measured against the commit's own blobs, path by path, from the bytes on disk)"
# `R23-F2`, the coordinator's measurement: this line used to read the migrations
# TREE OBJECT out of HEAD, so it printed the same digest whether or not the files
# the suite actually applied were those bytes -- a skip-worktree flag plus an
# appended CREATE TABLE left it unchanged while the planted table ran. Two lines
# now, and the first is read from the DISK: `ls` sorts, so the bytes hashed are
# the files in alphabetical order.
MIG_DISK="$(cat $(ls -1 $REPO/infrastructure/database/migrations/*.sql | sort) | sha256sum | cut -d' ' -f1)"
# THE COORDINATOR'S `F1`, second half: "`MIGRATIONS_SHA256` is read from disk,
# so that part of the claim is TRUE. It is a printed figure only, though:
# nothing compares it and nothing refuses on it." So it is COMPARED here,
# against the same digest computed over the COMMIT's own blobs in the same
# order, and a difference is a refusal. This is a second, independent reader of
# the fact the untracked law above reads -- an extra `.sql` on disk moves this
# digest whether or not any walk saw it -- and the two are not derived from each
# other.
MIG_COMMIT="$(for f in $(gitq ls-tree -r --name-only HEAD infrastructure/database/migrations | grep '\.sql$' | sort); do gitq show "HEAD:$f"; done | sha256sum | cut -d' ' -f1)"
echo "MIGRATIONS_SHA256 : $MIG_DISK  (the bytes ON DISK, which are what the run below applies)"
echo "MIGRATIONS_COMMIT : $MIG_COMMIT  (the same digest over the COMMIT's own blobs, in the same order)"
if [ "$MIG_DISK" != "$MIG_COMMIT" ]; then
  echo "REFUSED: SOURCE-MIGRATIONS-DIGEST-MOVED: the migrations this run would apply are"
  echo "not the migrations the commit holds -- a file added, removed or changed -- so the"
  echo "APPLIED count below would describe a history nobody has reviewed."
  echo "EXIT_SOURCE_MIGRATIONS_DIGEST: 5  (refused before the cluster and every gate)"
  exit 5
fi
# `R24-F2`: the manifest used to carry a hand-maintained table of document
# digests, inside one of the documents it named, and a reader who trusted it
# reviewed bytes the commit does not hold. There is no table now; the run
# prints what it MEASURED, from the commit, over the documents the commit
# actually lists.
echo "DOCUMENT DIGESTS, from the commit (no table pins these; this is the authority):"
$PY -I $H/check_harness_bytes.py --doc-digests | sed 's/^/  /'
echo "MIGRATIONS_TREE   : $(gitq rev-parse HEAD:infrastructure/database/migrations)  (the tree object HEAD holds, for comparison with a clean checkout)"
echo "MANIFEST_SHA256   : $(sha256sum $REPO/infrastructure/database/MIGRATION_MANIFEST.json | cut -d' ' -f1)"
echo "BOOTSTRAP_SHA256  : $(sha256sum $REPO/infrastructure/database/bootstrap.sql | cut -d' ' -f1)"
echo "PACK_A_DDL_SHA256 : $(sha256sum $REPO/prep/phase11/ddl/p11-pack-a-apparel.sql | cut -d' ' -f1)"
echo "PACK_B_DDL_SHA256 : $(test -f $REPO/prep/phase11/ddl/p11-pack-b-lot-expiry.sql && sha256sum $REPO/prep/phase11/ddl/p11-pack-b-lot-expiry.sql | cut -d' ' -f1 || echo 'absent at this SHA — Pack B is not on the branch yet, and the run below skips it by name rather than silently')"
# NOTE ON REPRODUCING THIS DIGEST: `ls` SORTS its arguments, so the bytes
# hashed are the files in ALPHABETICAL order, not in the order written below.
# Concatenating them in the written order gives a different, wrong digest.
# `check_fenced_figures.py` joined the set when step 0 started depending on it:
# an instrument a run refuses on is part of what the run must pin.
echo "HARNESS_SHA256    : $(cat $(ls $H/check_fenced_figures.py $H/check_harness_bytes.py $H/proofs.py $H/proofs_b.py $H/races.py $H/races_b.py $H/run_migrations.py $H/render_bootstrap.py $H/world.sql $H/world_b.sql $H/rebuild_and_prove.sh 2>/dev/null) | sha256sum | cut -d' ' -f1)"
echo "PG_VERSION        : $($PG/postgres --version)"
echo "PG_CLUSTER_DIR    : $S/data (port $PORT, socket $SOCK)"
echo "NODE_VERSION      : $(node -v) (repository engines: $(node -e "process.stdout.write(require('$REPO/package.json').engines.node)")) -- NO npm suite is run here"
echo "FIXTURES          : world.sql (Pack A)$(test -f $H/world_b.sql && echo ', world_b.sql (Pack B, with its definer fixture)'). Within the packs present, no fixture and no case is skipped; a pack that is not on the branch is named as skipped above and below."
echo

# ── 0c. the deciding files against the commit ───────────────────────────────
# `R26-S1`: this step was "the documents' quoted figures" until this round, and
# the scan, `--check-blocks` and the gate's own selftest have moved to step 7b,
# because their haystack is now what this run prints and at this point it has
# printed the identity block and nothing else. What stays here is the one check
# that must precede everything which reads the harness: the deciding files
# against the commit's own blobs.
# Round 10 rejected a head over a figure shown as output that no instrument
# emitted. Round 11 made the honest objection that the arm added in answer was
# a rule in a document with nothing enforcing it. This is the enforcement.
#
# WHERE IT RUNS, stated exactly: steps 0 and 0b above create and start the
# scratch cluster, so this step runs AFTER the cluster is up and BEFORE the
# database is dropped and recreated, before the roles are bootstrapped and
# before any migration or pack is applied. Nothing under test has been touched
# when it refuses. It is numbered 0c rather than 0 because 0 and 0b were
# already taken -- the first version collided with them.
echo "=== 0c. the deciding files, against the commit's own blobs (the figure gate itself runs at step 7b) ==="
# 0c-0. THE DECIDING FILES AGAINST THE COMMIT, before anything that reads them.
# The coordinator's `C21-F1` left this instrument through a DEFAULT ARGUMENT --
# `def scan(..., skip=("hyphen in the key",))` switches a named guard off for
# every real run -- and round 21 then left the first answer to it through the
# re-pin step its own refusal text prescribed. A pin inside the thing it pins is
# not a pin, and a table a planter edits in the same commit is the same mistake
# with one more file in it. So the authority is THE COMMIT: every deciding file
# under the harness must equal `git show <resolved sha>:<path>`. It runs FIRST
# here because every number printed below is read out of those bytes. The scan
# and `--check-blocks` read the same law themselves -- once with their own code
# and once through this reader, which shares none of it. What that does NOT buy,
# and the sentence here used to claim it did: the line that INVOKES the reader
# lives in the file the same edit changes, so a reader who runs the scan alone
# is not outside an uncommitted edit to the scan. What is true is that a dirty
# tree is refused by name by this script above, by the scan and by this reader,
# so no admissible transcript comes out of such a tree.
echo "--- 0c-0. the deciding files against the commit ---"
$PY -I $H/check_harness_bytes.py
RC_HARNESS_BYTES=$?
if [ $RC_HARNESS_BYTES -ne 0 ]; then
  echo "A deciding file on disk is not the file the commit holds, a deciding file is "
  echo "not in the commit, a committed one is missing, or the anchor could not be "
  echo "resolved. The refusal above names which, and names nothing else: the rules this "
  echo "suite applies are read from the commit, so an uncommitted edit is refused "
  echo "rather than measured. What the law does not do is stop a planter who COMMITS -- "
  echo "nothing executable can -- and that is why the diff is read by an independent "
  echo "challenger and by the coordinator."
  # Fatal, and fatal HERE: every figure, digest and exit code printed below is
  # read out of bytes this step is what checks, so continuing would publish
  # numbers whose instrument is unaccounted for.
  echo "EXIT_HARNESS_BYTES: $RC_HARNESS_BYTES  (refused at step 0c-0; nothing below ran)"
  exit $RC_HARNESS_BYTES
fi
# `R26-S1`: the figure scan and the block check used to stand HERE, at step 0c,
# and they cannot any more. Their haystack is what this run printed, so they
# run at step 7b, after the proofs and the races, when there is a run to read.
# The selftest stays here: it builds its own worlds and reads nothing of this
# run.
RC_FIGURES=0
RC_BLOCKS=0
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
$PY -I $H/render_bootstrap.py --selftest || { echo "the bootstrap renderer's completeness check is inert; refusing to run"; exit 1; }
$PY -I $H/render_bootstrap.py "$REPO/infrastructure/database/bootstrap.sql" "$S/sql/bootstrap.rendered.sql" || exit 1
chmod 644 "$S/sql/bootstrap.rendered.sql"
$Q "$PSQL_P -U postgres -d daftar -X -q -v ON_ERROR_STOP=1 -f $S/sql/bootstrap.rendered.sql" || exit 1
echo "=== 3. migrations 0000..0086 as daftar_migrator (NOT superuser) ==="
$PY -I $H/run_migrations.py $REPO/infrastructure/database/migrations daftar_migrator || exit 1

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
$PY -I $H/proofs.py
RC_PROOFS=$?; RC=$RC_PROOFS
if [ -f "$H/proofs_b.py" ]; then
  echo "=== 6a2. proofs (Pack B, lot/expiry) ==="
  $PY -I $H/proofs_b.py
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
$PY -I $H/proofs.py | tail -2
RC_PROOFS2=${PIPESTATUS[0]}; [ $RC_PROOFS2 -ne 0 ] && RC=$RC_PROOFS2
if [ -f "$H/proofs_b.py" ]; then
  $PY -I $H/proofs_b.py | tail -2
  RC_B2=${PIPESTATUS[0]}; [ $RC_B2 -ne 0 ] && RC=$RC_B2
else
  RC_B2="n/a"
fi
echo "=== 6b. real concurrency: the races, two live backends, no sleep() (Pack A) ==="
$PY -I $H/races.py
RCR=$?; [ $RCR -ne 0 ] && RC=$RCR
# The overlay's own races, carried here from the second independent
# challenge's `pb3race.py` rather than left in its evidence directory: a law
# whose concurrency is proved by somebody else's script is a law this pack
# cannot re-prove when §3.6's writer lands.
if [ -f "$H/races_b.py" ]; then
  echo "=== 6d. real concurrency: the lot overlay's races (Pack B) ==="
  $PY -I $H/races_b.py
  RCRB=$?; [ $RCRB -ne 0 ] && RC=$RCRB
else
  RCRB="n/a"
fi
echo "=== 7. the frozen tree, after the run ==="
# `R23-F2`: this line asked `git status` whether the frozen tree had moved
# DURING the run, and that is the figure the coordinator's flag falsified. It is
# the byte comparison now, re-run after everything above, and the migrations'
# disk digest is printed again so a reader can compare it with the one printed
# before the run rather than take a word for it.
AFTER_STATE="$($PY -I $H/check_harness_bytes.py --tree-state 2>/var/tmp/p11-after.$$ || true)"
echo "tree differs from the commit, after the run: $AFTER_STATE   (by the bytes on disk, every committed path)"
[ "$AFTER_STATE" = "no" ] || sed 's/^/  /' /var/tmp/p11-after.$$
rm -f /var/tmp/p11-after.$$
echo "MIGRATIONS_SHA256 after the run: $(cat $(ls -1 $REPO/infrastructure/database/migrations/*.sql | sort) | sha256sum | cut -d' ' -f1)"
echo
echo "=== 7b. the quoted figures, against WHAT THIS RUN PRINTED ==="
# The gate's own red proof runs first, as it always has -- and HERE rather than
# at step 0c, because `blocks_test` runs the generators and the generators read
# the haystack, which is this run's output. A selftest of the figure gate that
# could not read a run would have to skip that arm, and this pack does not skip
# what it cannot classify.
$PY -I $H/check_fenced_figures.py --selftest --run-capture "$P11_RUN_CAPTURE" || { echo "the fenced-figure check cannot fail; refusing to trust it"; RC=1; }
# `R26-S1`. The haystack is the capture above, which by now holds every line
# this run has printed: the migrations, both proof suites twice, both race
# programs, every digest and every exit code. A figure in a document of this
# phase is legitimate because it is in there.
$PY -I $H/check_fenced_figures.py --run-capture "$P11_RUN_CAPTURE"
RC_FIGURES=$?
if [ $RC_FIGURES -ne 0 ]; then
  echo "A document of this phase shows a figure THIS RUN DID NOT PRINT (exit 1), the "
  echo "check matched nothing at all (exit 2), or it REFUSED (exit 5) -- the capture "
  echo "is absent, unreadable, empty, inside the repository that holds the subject, or "
  echo "carries another commit'\''s RUN_HEAD; or the haystack'\''s anchor could not be "
  echo "resolved to ONE repository -- git absent, no repository above this tree, MORE "
  echo "THAN ONE repository containing it (which the gate refuses to choose between, "
  echo "whoever put the second one there: run this in a workspace that is not nested "
  echo "inside another repository), a BARE repository an ancestor walk cannot see, a "
  echo "disagreement with git'\''s own discovery -- or a DECISION FRAME the closed "
  echo "sub-language does not admit, which includes a listed module ATTRIBUTE rebound "
  echo "since this file imported it, a frame function whose source is not the code "
  echo "that runs, and a DECIDING FILE whose bytes are not the bytes the commit holds. "
  echo "In every case a figure in these documents would be standing on something other "
  echo "than a run of this phase, and this run is not evidence for it."
fi
$PY -I $H/check_fenced_figures.py --check-blocks --run-capture "$P11_RUN_CAPTURE"
RC_BLOCKS=$?
if [ $RC_BLOCKS -ne 0 ]; then
  echo "A generated figure block in a document of this phase disagrees with a fresh "
  echo "run of its generator -- which includes a clause outside a block that RESTATES "
  echo "what a generator prints, or CONTRADICTS any one of its rows, in any wording "
  echo "(exit 1) -- or nothing is enrolled at all (exit 2), or the capture or the "
  echo "frame was refused (exit 5). Run"
  echo "\`$PY -I $H/check_fenced_figures.py --regenerate --run-capture $P11_RUN_CAPTURE\`"
  echo "and commit what it prints."
fi
[ $RC_FIGURES -ne 0 ] && RC=$RC_FIGURES
[ $RC_BLOCKS -ne 0 ] && RC=$RC_BLOCKS
gitq status --porcelain -- infrastructure/database | wc -l | sed 's/^/what git status lists under infrastructure\/database, for a reader: /'
$PY -I - <<PY
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
echo "EXIT_HARNESS_BYTES: $RC_HARNESS_BYTES  (prep/phase11/harness/check_harness_bytes.py, run at step 0c-0 before anything that reads the harness: every deciding file's bytes against the blob the resolved commit holds, by a reader that shares no code with the checker)"
echo "EXIT_GENERATED_BLOCKS: $RC_BLOCKS  (prep/phase11/harness/check_fenced_figures.py --check-blocks, run at step 7b beside the figure scan, against this run'\''s own output)"
echo "EXIT_FENCED_FIGURES: $RC_FIGURES  (prep/phase11/harness/check_fenced_figures.py, run at step 7b: after the proofs and the races, because its haystack is what this run printed)"
echo "EXIT_RACES        : $RCR  (prep/phase11/harness/races.py)"
echo "EXIT_RACES_B      : $RCRB  (prep/phase11/harness/races_b.py)"
echo "EXIT_SCRIPT       : $RC  (0 means every step above returned 0)"
exit $RC
