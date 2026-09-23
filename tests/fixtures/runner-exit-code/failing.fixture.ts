import { expect, it } from 'vitest';

/**
 * Deliberately failing, permanently.
 *
 * This is the canary for `tests/helpers/exit-code.ts`: a runner that cannot
 * report failure would run this file, print `1 failed`, and still leave with
 * status 0. It is named `.fixture.ts` rather than `.test.ts` so no ordinary
 * run collects it — the root config includes `tests/**` + `/*.test.ts` only —
 * and it is reached through its own config in this directory.
 */
it('fails, so that a runner which cannot report failure is caught', () => {
  expect(1).toBe(2);
});
