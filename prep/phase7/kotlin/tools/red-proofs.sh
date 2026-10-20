#!/bin/bash -p
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
#
# R20-02, the twentieth challenge, P1 and reachable with NO EDIT to any file in
# the repository. The pin below reads this script's BYTES; it said nothing about
# the shell those bytes run in. Two routes forged a whole verdict: `BASH_ENV`
# pointing at a file defining `exec() { fake "$@"; }`, which bash sources before
# a non-interactive script, and an exported shell function
# (`BASH_FUNC_exec%%=() { ... }`), which needs no file at all.
#
# R21-01 / coord F-S, the twenty-first challenge, P1 and again with NO EDIT:
# every defence above is reached THROUGH `PATH`. The shebang was
# `#!/usr/bin/env -S bash -p`, and `env` resolves `bash` through `PATH`, so a
# forged `bash` earlier on `PATH` printed `ALL 105 RED PROOFS SATISFIED` at rc 0
# without ever reading this file. The handover line called `dirname` unqualified,
# which is the same hole one command further on: a forged `dirname` names the
# directory the harness is loaded from. Reproduced here, both routes, before
# either was fixed.
#
# R21-02, P1: the privileged check below used to read `$-` alone. `p` in `$-`
# is a FLAG, and `SHELLOPTS=privileged` sets that flag while the environment's
# functions are STILL IMPORTED -- measured identical in `$-` and opposite in
# `declare -F`. The refusal therefore passed in exactly the state it existed to
# stop. It asks the PROPERTY now: any function defined when this file is read is
# a refusal by name, captured BEFORE `unset -f` runs so the capture cannot be
# emptied by this script's own defence.
#
# The defences, in the order they can be trusted, and each bound said rather
# than implied:
#
#   * The shebang is `#!/bin/bash -p`: an ABSOLUTE interpreter, so no `PATH`
#     entry chooses it, and privileged mode, so inherited functions are not
#     imported and `BASH_ENV` is ignored. `/bin/bash` and `/usr/bin/bash` are
#     the same binary here; the pin covers line one, so changing either word is
#     an edit the pin sees.
#   * `PATH` is ASSIGNED, not inherited, before any external command runs, and
#     the one external command on the handover path is named absolutely as well.
#     Belt and braces on purpose: either alone closes the `dirname` route.
#   * Any function defined at entry is a refusal BY NAME, which is the state
#     `$-` cannot distinguish, and the `$-` case stays as a second arm, since it
#     is the one that catches a plainly non-privileged start.
#   * `unset -f` for every builtin used below, for anyone who runs it
#     privileged-but-with-functions-already-defined.
#
# THE BOUNDS, both of them:
#
#   * A shell whose `echo`, `exit`, `unset` or `declare` are ALREADY functions
#     when this file is read cannot be defended from inside this file -- the
#     refusal itself would be the hijacked command. That is why the shebang, and
#     not this block, is the primary defence.
#   * If `/bin/bash` ITSELF is replaced, nothing written here runs at all, and no
#     check inside this file or inside the harness can see it. That bound is the
#     same class as a forged `/usr/bin/python3`, and it is closed, if anywhere,
#     by the reader trusting the two absolute paths this file names.
#
# `SHELLOPTS` is deliberately NOT refused on presence, unlike `BASH_ENV` and
# `ENV`: a privileged bash EXPORTS its own option list, so this harness's own
# child invocations inherit `SHELLOPTS` containing `privileged`, and refusing on
# presence would red those legitimate runs. A hardening that causes a false red
# is not hardening. What matters about that state -- imported functions -- is
# what the `declare -F` refusal measures directly.
_P7_FUNCS_AT_ENTRY=$(declare -F 2>/dev/null)
unset -f exec echo exit cd pwd set test [ unset command builtin printf declare 2>/dev/null
PATH=/usr/bin:/bin
export PATH

if [ -n "$_P7_FUNCS_AT_ENTRY" ]; then
  echo "REFUSED-P7-WRAPPER-FUNCTIONS-WERE-IMPORTED: a shell function was already defined when"
  echo "this script was read, so a command it uses could run as that function and forge a"
  echo "verdict with no file edited. SHELLOPTS=privileged sets the privileged FLAG while still"
  echo "importing functions, which is why the flag alone is not asked. Functions seen:"
  echo "$_P7_FUNCS_AT_ENTRY"
  exit 3
fi

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
exec "$PY" -I "$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && pwd)/red_proofs.py" "$@"
