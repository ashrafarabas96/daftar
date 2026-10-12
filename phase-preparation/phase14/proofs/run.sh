#!/bin/bash
# PART 19 evidence harness. Each case is a psql script whose assertions RAISE
# when the law does not hold, so the exit code IS the verdict: 0 = the law held.
# A red-proof case is REQUIRED to exit 3.
#   usage: ./run.sh <role> cases/<script>.sql
# The case id is derived from the script path, so every recorded run names the
# exact file that produced it and the recipe in README.md can be replayed.
ROLE="$1"; FILE="$2"
CASE=$(basename "$FILE" .sql)
# evidence.psv column 1 is the SCRIPT that ran; column 3 is the recorded case id,
# which differs only for a red proof (an earlier green arm re-run after its
# mutation). So every row names the file that produced it.
OUT=/tmp/p14pg/out; mkdir -p "$OUT"
RUNID="P14-RUN-$(date -u +%Y%m%dT%H%M%SZ)-$CASE"
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
su claude -s /bin/bash -c "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U $ROLE -d p14scratch -v ON_ERROR_STOP=1 -q -f $FILE" > "$OUT/$CASE.log" 2>&1
RC=$?
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$ROLE" "${P14_CASE_ALIAS:-$CASE}" "$RUNID" "$START" "$END" "$RC" >> "$OUT/evidence.psv"
echo "$(printf '%-34s' "$CASE") role=$(printf '%-13s' "$ROLE") exit=$RC"
[ $RC -ne 0 ] && sed -n '1,6p' "$OUT/$CASE.log" | sed 's/^/      /'
exit $RC
