#!/usr/bin/env bash
# P7 — compile the offline kernel and run its suites. Exit 0 green, non-zero red.
#
# $? is captured as the IMMEDIATELY next statement after every command whose
# status matters: an intervening echo clobbers it and no pipe check notices.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${P7_SRC:-$ROOT/src}"
TEST="${P7_TEST:-$ROOT/test}"
OUT="${P7_OUT:-${TMPDIR:-/tmp}/daftar-p7-build}"

# shellcheck source=toolchain.sh
. "$HERE/toolchain.sh"
# toolchain.sh sets -e for its own downloads; turn it back off, because every
# command below has its status read explicitly and an -e exit would skip the
# report that says WHY the run failed.
set +e

rm -rf "$OUT"
mkdir -p "$OUT/main" "$OUT/test"

"$KOTLINC" -nowarn "$SRC"/app/daftar/offline/*.kt -d "$OUT/main" > "$OUT/compile-main.log" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "P7 KERNEL DID NOT COMPILE (rc=$rc)"
  grep -v 'JAVA_TOOL_OPTIONS' "$OUT/compile-main.log" || true
  exit "$rc"
fi

"$KOTLINC" -nowarn -cp "$OUT/main:$TEST_CP" "$TEST"/app/daftar/offline/*.kt -d "$OUT/test" > "$OUT/compile-test.log" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "P7 SUITE DID NOT COMPILE (rc=$rc)"
  grep -v 'JAVA_TOOL_OPTIONS' "$OUT/compile-test.log" || true
  exit "$rc"
fi

# A suite that cannot compile reports nothing, so compilation is checked above
# as its own exit code before anything is allowed to look green.
java -jar "$JUNIT_JAR" execute \
  -cp "$OUT/test:$OUT/main:$TEST_CP" \
  --select-package=app.daftar.offline \
  --details=summary --disable-ansi-colors > "$OUT/run.log" 2>&1
rc=$?
grep -v 'JAVA_TOOL_OPTIONS' "$OUT/run.log"
echo "P7 SUITE EXIT=$rc  (log: $OUT/run.log)"
exit "$rc"
