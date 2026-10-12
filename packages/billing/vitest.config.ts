import { defineConfig } from 'vitest/config';

/**
 * The PURE lane. `test/db/**` is excluded on purpose: those cases need a
 * real PostgreSQL cluster and run through `test/db/run-db-proof.sh` with
 * `vitest.db.config.ts`. Keeping them out is what lets a green run of this
 * config be reported as what it is — the pure core, no database.
 */
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/db/**'] },
});
