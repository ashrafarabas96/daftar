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
 * `npm test` chain.
 *
 * BUT «THE WIRING CANNOT QUIETLY COME UNDONE», WHICH THIS COMMENT USED TO SAY,
 * IS FALSE IN ONE DIRECTION — measured, not supposed. That roster arm, and
 * every other arm in this lane, RUNS ONLY IF THIS LANE RUNS, and the lane's
 * only path from CI is the last link of one `&&` chain: `ci.yml` has no
 * `test:unit` and no `vitest.unit` anywhere but in a comment. So REMOVING
 * `&& npm run test:unit` from the root `test` script unplugs all of it — every
 * law here, silently, with `backend-static` still green — and no arm inside
 * the lane can witness that, because it does not run either. A REWRITE (a
 * different config, a different include) is caught; a REMOVAL is not.
 *
 * `tests-unit/pre-push-hook-law.test.ts` reads every link of that path and
 * names this hole at its site. AND IT IS NOW CLOSED FROM OUTSIDE:
 * `tests/security/unit-lane-reachability.test.ts` asserts the same links while
 * running under `npm run test:integration` (`ci.yml:532`) inside the `backend`
 * job — required, and NOT `backend-static` — so it keeps running exactly when
 * this chain is cut. ONE foot outside the lane is enough; cutting that arm's
 * own path means editing `ci.yml` and the roster of required jobs, which are
 * another lane's file and a repository setting the owner alone changes.
 */
export default defineConfig({
  test: {
    include: ['tests-unit/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    env: { NODE_PATH: '' },
  },
});
