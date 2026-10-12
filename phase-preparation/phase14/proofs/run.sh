#!/bin/bash
# PART 19 evidence harness. Each case is a psql script that RAISEs when its law
# does not hold, so the exit code IS the verdict. 0 = law held.
CASE="$1"; ROLE="$2"; FILE="$3"
OUT=/tmp/p14pg/out; mkdir -p "$OUT"
RUNID="P14-RUN-$(date -u +%Y%m%dT%H%M%SZ)-$CASE"
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
su claude -s /bin/bash -c "/usr/lib/postgresql/16/bin/psql -h /tmp/p14pg/sock -p 54314 -U $ROLE -d p14scratch -v ON_ERROR_STOP=1 -q -f $FILE" > "$OUT/$CASE.log" 2>&1
RC=$?
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s|%s|%s|%s|%s|%s\n' "$CASE" "$ROLE" "$RUNID" "$START" "$END" "$RC" >> "$OUT/evidence.psv"
echo "CASE=$CASE ROLE=$ROLE RUNID=$RUNID EXIT=$RC"
[ $RC -ne 0 ] && tail -8 "$OUT/$CASE.log"
exit $RC
