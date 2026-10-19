import { defineConfig } from 'vitest/config';

/**
 * The PURE lane. `test/db/**` is excluded on purpose: those cases need a
 * real PostgreSQL cluster and run through `test/db/run-db-proof.sh` with
 * `vitest.db.config.ts`. Keeping them out is what lets a green run of this
 * config be reported as what it is — the pure core, no database.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/db/**'],
    /**
     * ROUND 59, AND IT IS THE ROOT CAUSE OF THE UNEXPLAINED RED THIS PACK
     * RECORDED AT 21:11:05 ON 2026-10-19 rather than calling it a flake.
     *
     * The law's cases are not pure computation: they spawn `prettier`,
     * `python3` and `git`, walk the whole repository, and copy and hash the
     * pack. Their duration is therefore a property of the MACHINE, not of the
     * code under test -- measured here at 3.2s, 2.9s and 2.0s for the three
     * heaviest on an idle container with 4 CPUs. Vitest's default per-case
     * timeout is 5000ms, so a container under load turns one of those cases
     * into `Test timed out in 5000ms`: `1 failed | 304 passed (305)`, rc 1, and
     * NO REFUSAL NAME anywhere in the output.
     *
     * Reproduced deliberately: with twelve busy loops on four CPUs, the flag
     * grammar case failed at exactly that message, which is the same shape as
     * the 21:11:05 red. So the default clock was a FALSE RED GENERATOR, and a
     * red gate carries no signature.
     *
     * Raising it weakens no assertion: every case asserts exactly what it
     * asserted before and a case that genuinely hangs still fails, two minutes
     * later instead of five seconds later. The value is read by the law as well
     * as pinned, because a number nobody reads is a number that can drift
     * (placement, not just content).
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
