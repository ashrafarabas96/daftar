import { expect, it } from 'vitest';

/**
 * The other half of the canary: the guard in `tests/helpers/exit-code.ts` may
 * only stop a zero from erasing a recorded failure. A run with nothing wrong
 * must still leave with status 0, or the guard would have turned every green
 * run red and proved nothing.
 */
it('passes, so that the guard is shown not to invent failure', () => {
  expect(1).toBe(1);
});
