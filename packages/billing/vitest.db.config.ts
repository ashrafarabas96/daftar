import { defineConfig } from 'vitest/config';

/**
 * The DB lane. Separate config, separate command, separate verdict: the
 * pure gate's `include` excludes `test/db/**`, so a green `npm test`
 * remains a statement about the pure core only, and this run is the only
 * thing that may be cited for a database claim.
 *
 * `fileParallelism: false` because every case here drives two or three real
 * backends against one cluster and asserts on `pg_stat_activity`; two files
 * interleaving would make a lock wait ambiguous.
 */
export default defineConfig({
  test: {
    include: ['test/db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
