/**
 * The test runner must be able to report failure.
 *
 * ── The defect this exists to answer ─────────────────────────────────────
 *
 * `embedded-postgres` registers a graceful-shutdown hook at import time:
 *
 *     AsyncExitHook(gracefulShutdown);            // embedded-postgres/dist/index.js
 *
 * `async-exit-hook` implements that by subscribing to `beforeExit` with a
 * HARDCODED exit code of zero:
 *
 *     add.hookEvent('beforeExit', 0);             // async-exit-hook/index.js
 *     …
 *     process.nextTick(process.exit.bind(null, code));   // code === 0
 *
 * `beforeExit` fires when the event loop drains naturally. At that moment
 * Vitest has already recorded the verdict the only way it can — by setting
 * `process.exitCode = 1` — but it has not yet reached its own exit path. The
 * hook then calls `process.exit(0)` with an explicit zero, and an explicit
 * argument OVERWRITES `process.exitCode`. The process leaves with status 0
 * having just printed `Tests  10 failed`.
 *
 * Which of the two paths wins is a race between the shutdown hook and Vitest's
 * teardown, so the run reports failure some of the time and success the rest.
 * That is worse than a reliable defect: every gate in this repository decides
 * PASS or FAIL from the exit status of `npx vitest run`, and a runner that
 * sometimes answers 0 over failing tests makes every one of those verdicts,
 * and the CI evidence built on them, worth nothing.
 *
 * ── What this does ───────────────────────────────────────────────────────
 *
 * It refuses exactly one transition: a zero exit may not lower a non-zero
 * `process.exitCode`. Nothing else changes. A passing run still exits 0, an
 * explicit non-zero code is still honoured, and a caller that wants to raise
 * the code still can.
 *
 * Note the direction. This shim can only ever turn a 0 into a failure that was
 * already recorded; it can never turn a failure into a 0. It cannot mask a
 * broken test, only stop a broken test from being masked.
 *
 * ── Why not just unhook it ───────────────────────────────────────────────
 *
 * Because the hook is doing something we want: it stops the PostgreSQL cluster
 * so a run does not leave a zombie behind. The bug is the hardcoded zero, not
 * the shutdown. So the shutdown is left alone and the zero is made harmless.
 *
 * The property this file claims is proved two ways: `guardedExit` is asserted
 * directly, argument by argument, and the whole mechanism is proved end to end
 * by running the runner
 * against a deliberately failing test, in
 * `tests/integration/runner-exit-code.test.ts`, and independently re-proved by
 * the P2-S7 gate before it trusts any test result in its own run.
 */

let installed = false;

/**
 * The exit call that survives the guard, given the real `process.exit`.
 *
 * Separated from the installation so the rule can be asserted directly, which
 * matters more than it looks — see the arity note below.
 */
export function guardedExit(native: (...args: [number?]) => never): (...args: [number?]) => never {
  return (...args: [number?]): never => {
    const recorded = process.exitCode;
    const failing = typeof recorded === 'number' && recorded !== 0;

    // The one refused transition: an EXPLICIT zero over a recorded failure.
    if (failing && args.length > 0 && args[0] === 0) return native(recorded as number);

    // Everything else is passed through UNCHANGED — and "unchanged" includes
    // how many arguments there were. This is not pedantry. Node's own exit is:
    //
    //     function exit(code) {
    //       if (arguments.length !== 0) { process.exitCode = code; }
    //       ...
    //       process.reallyExit(process.exitCode || kNoFailure);
    //     }
    //
    // so `process.exit()` honours a recorded `process.exitCode`, while
    // `process.exit(undefined)` COUNTS AS SUPPLYING A CODE and sets it to
    // undefined, which leaves as 0. A forwarder written as `native(code)`
    // silently converts the first into the second and erases exactly the
    // failure this file exists to preserve. Vitest's close-timeout path calls
    // `process.exit()` with no argument, and that is the path taken whenever
    // something holds the event loop open — so getting this wrong turns the
    // guard into the very defect it was written to answer.
    return native(...args);
  };
}

/**
 * Make a zero exit unable to clear a failing exit code. Idempotent.
 */
export function protectFailingExitCode(): void {
  if (installed) return;
  installed = true;

  const native = process.exit.bind(process) as (...args: [number?]) => never;
  process.exit = guardedExit(native) as typeof process.exit;
}
