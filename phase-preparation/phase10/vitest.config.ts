import { defineConfig } from 'vitest/config';

/**
 * Phase 10 preparation suite — deliberately SEPARATE from the repository's
 * canonical `vitest.config.ts`.
 *
 * The canonical config carries `globalSetup: 'tests/helpers/global-setup.ts'`,
 * which provisions a PostgreSQL cluster unconditionally. This suite is pure
 * domain arithmetic and state machines: no cluster, no fixtures, no DB. Keeping
 * its own config is what lets it run in seconds AND keeps Phase 10 outside the
 * required CI estate, which PART 9 of the directive requires of code whose
 * predecessors are not sealed.
 *
 * Run it with:
 *   npx vitest run --config phase-preparation/phase10/vitest.config.ts
 */
export default defineConfig({
  test: {
    include: ['phase-preparation/phase10/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
