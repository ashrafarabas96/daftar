#!/usr/bin/env bash
# =====================================================================
# D-6 — the red proof for the delivery-key guards
# =====================================================================
# A test that passes tells you the suite ran. It does not tell you the test
# reads the law it claims to read. Each mutation below removes exactly ONE guard
# added for D-6 and requires the named test to FAIL — and to fail as a test
# body, not as a load error: an exit code from a suite that never collected a
# case is not a red proof, and the first version of this script was fooled by
# exactly that.
#
# WHY IT MUTATES THE TREE RATHER THAN A COPY. The first version copied src/ and
# test/ to a scratch directory and the suite would not load there: tsconfig.json
# extends ../../tsconfig.base.json, which does not exist beside a copy, and
# `npx vitest` outside the package resolved a DIFFERENT vitest than the pinned
# one. Both would have made every mutation look red for the wrong reason. So the
# mutation is applied in place, the pristine files are held by hash, a trap
# restores them on any exit, and the run FAILS unless the tree is byte-identical
# at the end. The pinned binary is used directly, never through npx.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/.." && pwd)
RUN=${RUN_ID:-D6-$(date -u +%Y%m%dT%H%M%SZ)}
SAFE=${SAFE_DIR:-/var/tmp/p8-d6-$RUN}
VITEST=${VITEST_BIN:-$(cd "$PKG/../.." && pwd)/node_modules/.bin/vitest}
FAILED=0
say(){ echo "[$RUN] $*"; }

[ -x "$VITEST" ] || { say "ABORT: the pinned vitest is not at $VITEST (the workspace root holds it, not the package)"; exit 2; }
say "vitest = $("$VITEST" --version | tr -d '\n')"

mkdir -p "$SAFE"
cp "$PKG/src/identity.ts" "$SAFE/identity.ts"
sha256sum "$PKG/src/identity.ts" > "$SAFE/pristine.sha"
restore(){ cp "$SAFE/identity.ts" "$PKG/src/identity.ts"; }
trap restore EXIT INT TERM

run_one(){         # run_one <id> <sed-expression> <must-fail-test-name>
  local id=$1
  local expr=$2
  local want=$3
  restore
  sed -i "$expr" "$PKG/src/identity.ts" || { say "MUT $id: FAIL — sed refused"; FAILED=1; return; }
  if cmp -s "$PKG/src/identity.ts" "$SAFE/identity.ts"; then
    say "MUT $id: FAIL — the mutation changed nothing, so it proves nothing"; FAILED=1; return
  fi
  local out=$SAFE/$id.log
  ( cd "$PKG" && "$VITEST" run test/challenge-6af3abd.test.ts > "$out" 2>&1 )
  # (a) the suite must have COLLECTED cases — a load error is not a red proof
  if grep -qE "Tests +no tests|Failed Suites" "$out"; then
    say "MUT $id: FAIL — the suite did not load, so no case ran"
    grep -m1 "Error:" "$out"
    FAILED=1; return
  fi
  # (b) the NAMED case must be among the failures
  if grep -qF "$want" "$out" && grep -qE "Tests .*failed" "$out"; then
    local n
    n=$(grep -oE "[0-9]+ failed" "$out" | head -1)
    say "MUT $id: RED at '$want' ($n) — as required"
  else
    say "MUT $id: FAIL — '$want' did not red"
    grep -E "Tests " "$out" | head -2
    FAILED=1
  fi
}

# 1  Remove the providerContext field check: the field cases must red.
run_one 1 "s|  if (providerContext !== undefined && providerContext !== '') assertKeyField('providerContext', providerContext);||" \
        "refuses a provider context carrying the delivery separator"

# 2  Stop asserting the composition: the composed cases must red.
run_one 2 "s|return assertComposedDeliveryKey(\`\${obligation}::\${channel}\${context}\`);|return \`\${obligation}::\${channel}\${context}\`;|" \
        "refuses a composition that already carries the delivery separator"

# 3  Drop the attempt-identity guard.
run_one 3 "s|if (delivery.includes('#')) {|if (false) {|" \
        "refuses an attempt identity over a delivery key carrying a hash"

# 4  Weaken the composed check to \"detects\" rather than \"counts\": one `::`
#    becomes \"at least one\". The enumeration case must notice.
run_one 4 "s|if (doubleColons !== 1) {|if (doubleColons < 1) {|" \
        "refuses a composition that already carries the delivery separator"

restore
if sha256sum -c "$SAFE/pristine.sha" >/dev/null 2>&1; then
  say "src/identity.ts restored byte-identically"
else
  say "FAIL: src/identity.ts was NOT restored"; FAILED=1
fi
if git -C "$PKG" status --porcelain -- src | grep -q .; then
  say "NOTE: src/ differs from HEAD — expected while the round's own changes are uncommitted"
fi
( cd "$PKG" && "$VITEST" run > "$SAFE/final.log" 2>&1 ) \
  && say "the whole suite is green again: $(grep -E '^ *Tests ' "$SAFE/final.log" | tail -1 | xargs)" \
  || { say "FAIL: the suite is not green after restoring"; FAILED=1; }
say "RUN=$RUN FAILED=$FAILED"
exit $FAILED
