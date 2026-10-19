#!/usr/bin/env bash
# P7 — run the red proofs. Exit 0 only when every law's planted defect was caught.
#
# F-A, the coordinator's review of `184f7d7`: this script used to run
# `exec python3 …` with no `-I`, which put the harness's own directory on
# `sys.path` and let a file dropped beside it shadow the standard library. A
# planted `tools/shutil.py` forced rc 0 out of a run whose own output said
# `SELF-TEST FAILED`. Two things changed, and the harness refuses by name if
# either is undone, so this script cannot quietly become the hole again:
#
#   * `-I`, which is isolated mode: no script directory on `sys.path`, no user
#     site packages, no PYTHON* environment variables.
#   * the interpreter resolved BY ABSOLUTE PATH and PRINTED, because a step that
#     asks the environment for its runner measures whatever the environment
#     hands it. An absent interpreter is a named refusal, never a fallback.
set -uo pipefail

PY=/usr/bin/python3
if [ ! -x "$PY" ]; then
  echo "REFUSED-P7-NO-PINNED-INTERPRETER: $PY is not executable, and this script will not"
  echo "search PATH for a substitute: the interpreter is part of the command being pinned."
  exit 3
fi
echo "P7 RED PROOFS: interpreter $PY ($("$PY" -V 2>&1)), isolated mode -I"
exec "$PY" -I "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/red_proofs.py" "$@"
