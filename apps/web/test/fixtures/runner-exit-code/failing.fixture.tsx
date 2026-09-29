import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

/**
 * Deliberately failing, permanently: the web runner's exit-code canary
 * (P3-S7 contract §7.1(6)). It is named `.fixture.tsx`, so no ordinary run of
 * `apps/web/vitest.config.mts` collects it; the gate reaches it through the
 * config beside it, which is the web config with only `include` changed. It
 * renders JSX first, so the canary also proves the JSX transform is live.
 */
it('fails, so that a web runner which cannot report failure is caught', () => {
  expect(renderToStaticMarkup(<bdi dir="ltr">1</bdi>)).toBe('<bdi dir="ltr">2</bdi>');
});
