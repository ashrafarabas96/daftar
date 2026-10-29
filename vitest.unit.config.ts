import { defineConfig } from 'vitest/config';

/**
 * The unit lane: tests that assert on pure functions and on source text, with
 * NO database.
 *
 * `vitest.config.ts` cannot host these. Its `globalSetup`
 * (`tests/helpers/global-setup.ts`) calls `ensurePostgres()` unconditionally,
 * so every file under `tests/**` needs a live PostgreSQL before its first
 * assertion runs — correct for the suites that live there, and fatal for a
 * test whose whole point is that it can be run anywhere, including on a
 * Windows machine with no database. Hence a separate config and a separate
 * directory rather than a flag on the existing one.
 *
 * Run it with:
 *
 *     npm run test:unit
 *
 * It is registered as a root script AND composed into `npm test`, which is the
 * step `ci.yml` runs — so this lane executes on every CI run, not by hand.
 *
 * It did not start that way. When this file was written the root
 * `package.json` was owned by the open T-10 branch (PR #9), so the lane was
 * run by hand and its exit codes were the evidence. T-10 has since merged and
 * the wiring followed. DO NOT read the old arrangement as the current one:
 * `tests-unit/test-lane-roster.test.ts` now fails if `test:unit` leaves the
 * `npm test` chain, so the wiring cannot quietly come undone.
 */
export default defineConfig({
  test: {
    include: ['tests-unit/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    env: { NODE_PATH: '' },
  },
});
