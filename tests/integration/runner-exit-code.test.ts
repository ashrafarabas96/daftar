import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedExit } from '../helpers/exit-code';

/**
 * The runner must be able to report failure.
 *
 * Every gate in this repository — Phase 1, and P2-S1 through P2-S7 — decides
 * PASS or FAIL from the exit status of `npx vitest run`. If that status can be
 * 0 over failing tests, then no gate's verdict and no CI job's green tick is
 * evidence of anything, including this slice's.
 *
 * It could be. `embedded-postgres` registers a shutdown hook through
 * `async-exit-hook`, which subscribes to `beforeExit` with a hardcoded exit
 * code of zero and, when the event loop drains, calls `process.exit(0)`. An
 * explicit argument overwrites `process.exitCode`, so the 1 Vitest had just
 * recorded was erased. `tests/helpers/exit-code.ts` refuses that one
 * transition. This proves it, by running the runner.
 *
 * The assertion is deliberately end to end: it starts a real child `vitest
 * run`, under a configuration identical to the root one except for which
 * files it collects, and reads the status the shell would read. A unit test of
 * the guard function would agree with the guard by construction and would say
 * nothing about the twelve layers between it and an exit status.
 */
const CONFIG = 'tests/fixtures/runner-exit-code/vitest.config.ts';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runCanary(filter: string): { status: number | null; output: string } {
  const res = spawnSync('npx', ['vitest', 'run', '--config', CONFIG, filter], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * The rule itself, argument by argument.
 *
 * The end-to-end proof below is the one that matters, but it can only observe
 * whichever exit path a given run happens to take, and there are two: Vitest's
 * shutdown hook calls `process.exit(0)` with an explicit zero, while its
 * close-timeout path calls `process.exit()` with none. A run that took the
 * first path passed while the second was broken — which is exactly what
 * happened, and what these cases exist to stop happening again.
 *
 * The subtle one is arity. Node's exit is `if (arguments.length !== 0)
 * process.exitCode = code`, so `exit()` honours a recorded failure and
 * `exit(undefined)` erases it. A forwarder that writes `native(code)` turns
 * the first into the second and destroys the thing it was guarding.
 */
describe('the guard passes everything through except an explicit zero over a failure', () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  function record(): { calls: [number?][]; exit: (...args: [number?]) => never } {
    const calls: [number?][] = [];
    const fake = ((...args: [number?]) => {
      calls.push(args);
      return undefined as never;
    }) as (...args: [number?]) => never;
    return { calls, exit: guardedExit(fake) };
  }

  it('turns an explicit zero into the recorded failure', () => {
    const { calls, exit } = record();
    process.exitCode = 1;
    exit(0);
    expect(calls).toEqual([[1]]);
  });

  it('passes a no-argument exit through with NO argument, so the recorded failure survives', () => {
    const { calls, exit } = record();
    process.exitCode = 1;
    exit();
    // Not `[[undefined]]`. One argument, even an undefined one, is Node's
    // signal that a code was supplied, and it would clear the 1.
    expect(calls).toEqual([[]]);
    expect(calls[0]).toHaveLength(0);
  });

  it('leaves an explicit zero alone when nothing failed', () => {
    const { calls, exit } = record();
    process.exitCode = undefined;
    exit(0);
    expect(calls).toEqual([[0]]);
  });

  it('leaves an explicit zero alone when the recorded code is itself zero', () => {
    const { calls, exit } = record();
    process.exitCode = 0;
    exit(0);
    expect(calls).toEqual([[0]]);
  });

  it('never lowers or raises a non-zero code a caller asked for', () => {
    const { calls, exit } = record();
    process.exitCode = 1;
    exit(2);
    expect(calls).toEqual([[2]]);
  });
});

describe('the test runner reports failure (gate soundness)', () => {
  it('leaves with a non-zero status when a test fails', () => {
    const { status, output } = runCanary('failing');

    // First, prove the child really did run the failing test. A run that
    // collected nothing would also "fail", for the wrong reason.
    expect(output).toMatch(/1 failed/);

    expect(status).not.toBe(0);
    expect(status).toBe(1);
  }, 180_000);

  it('leaves with status 0 when nothing fails', () => {
    const { status, output } = runCanary('passing');

    expect(output).toMatch(/1 passed/);
    expect(output).not.toMatch(/\d+ failed/);
    expect(status).toBe(0);
  }, 180_000);
});
