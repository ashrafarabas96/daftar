import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
