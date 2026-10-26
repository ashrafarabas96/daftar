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
 *     npx vitest run --config vitest.unit.config.ts
 *
 * It is deliberately NOT registered as an npm script yet: the root
 * `package.json` is owned by the open T-10 branch (PR #9), and one writer per
 * file. Wiring `test:unit` into `npm test` — which is what gets this lane into
 * CI — is a follow-up card that unblocks once T-10 merges. Until then this
 * lane is run by hand and its exit codes are the recorded evidence.
 */
export default defineConfig({
  test: {
    include: ['tests-unit/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    env: { NODE_PATH: '' },
  },
});
