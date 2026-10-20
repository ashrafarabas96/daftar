#!/usr/bin/env -S bash -p
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
# R20-02, the twentieth challenge, P1 and reachable with NO EDIT to any file in
# the repository. The pin below reads this script's BYTES; it said nothing about
# the shell those bytes run in. Two routes forged a whole verdict: `BASH_ENV`
# pointing at a file defining `exec() { fake "$@"; }`, which bash sources before
# a non-interactive script, and an exported shell function
# (`BASH_FUNC_exec%%=() { ... }`), which needs no file at all. In both the first
# line still read `interpreter /usr/bin/python3 ... isolated mode -I` -- true and
# reassuring while Python never started.
#
# Three defences, in the order they can be trusted, and the bound said rather
# than implied:
#
#   * The shebang is now `env -S bash -p`. Privileged mode discards inherited
#     functions and ignores `BASH_ENV`, so `./tools/red-proofs.sh` is closed by
#     the interpreter itself rather than by anything written here. `-p` is also
#     part of the pinned first line, so dropping it is an edit the pin sees.
#   * An operator typing `bash tools/red-proofs.sh` bypasses the shebang
#     entirely, so this script REFUSES unless it is actually privileged. `$-` is
#     a shell parameter, not a command, so reading it needs nothing that a
#     function could have replaced.
#   * `unset -f` for every builtin used below, which is what closes the gap for
#     anyone who runs it privileged-but-with-functions-already-defined.
#
# THE BOUND: a shell whose `echo`, `exit` or `unset` are ALREADY functions when
# this file is read cannot be defended from inside this file -- the refusal
# itself would be the hijacked command. That is why the shebang, and not this
# block, is the primary defence, and why the refusal below exists for the one
# invocation the shebang cannot govern.
unset -f exec echo exit cd pwd set test [ unset command builtin printf 2>/dev/null

case $- in
  *p*) ;;
  *)
    echo "REFUSED-P7-WRAPPER-NOT-PRIVILEGED: this script was started without privileged mode,"
    echo "so an inherited shell function named after a builtin it uses could run in its place"
    echo "and forge a verdict with no file edited. Run it as ./tools/red-proofs.sh, which uses"
    echo "the pinned shebang, or as: bash -p tools/red-proofs.sh"
    exit 3
    ;;
esac

if [ -n "${BASH_ENV:-}" ] || [ -n "${ENV:-}" ]; then
  echo "REFUSED-P7-WRAPPER-ENVIRONMENT-SOURCES-A-FILE: BASH_ENV or ENV is set, which names a"
  echo "file the shell sources before this script. Privileged mode ignores it, and this refuses"
  echo "rather than running with it set, because a verdict should not depend on which of the two"
  echo "the reader has to know about."
  exit 3
fi

set -uo pipefail

PY=/usr/bin/python3
if [ ! -x "$PY" ]; then
  echo "REFUSED-P7-NO-PINNED-INTERPRETER: $PY is not executable, and this script will not"
  echo "search PATH for a substitute: the interpreter is part of the command being pinned."
  exit 3
fi
echo "P7 RED PROOFS: interpreter $PY ($("$PY" -V 2>&1)), isolated mode -I"
exec "$PY" -I "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/red_proofs.py" "$@"
