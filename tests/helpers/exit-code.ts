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
 * The property this file claims is proved end to end, by running the runner
 * against a deliberately failing test, in
 * `tests/integration/runner-exit-code.test.ts`, and independently re-proved by
 * the P2-S7 gate before it trusts any test result in its own run.
 */

let installed = false;

/**
 * Make a zero exit unable to clear a failing exit code. Idempotent.
 */
export function protectFailingExitCode(): void {
  if (installed) return;
  installed = true;

  const native = process.exit.bind(process) as (code?: number) => never;

  process.exit = ((code?: number): never => {
    const recorded = process.exitCode;
    const failing = typeof recorded === 'number' && recorded !== 0;
    // `process.exit()` with no argument already honours `process.exitCode`;
    // only an explicit zero can erase it.
    if (failing && code === 0) return native(recorded);
    return native(code);
  }) as typeof process.exit;
}
