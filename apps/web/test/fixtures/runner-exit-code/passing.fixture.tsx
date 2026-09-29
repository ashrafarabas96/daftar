import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

/**
 * The other half of the web canary: a run with nothing wrong must still leave
 * with status 0, or the exit-code guard would have turned every green run red.
 */
it('passes, so that the guard is shown not to invent failure', () => {
  expect(renderToStaticMarkup(<bdi dir="ltr">1</bdi>)).toBe('<bdi dir="ltr">1</bdi>');
});
