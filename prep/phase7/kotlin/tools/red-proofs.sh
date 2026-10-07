#!/usr/bin/env bash
# P7 — run the red proofs. Exit 0 only when every law's planted defect was caught.
set -uo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/red_proofs.py" "$@"
