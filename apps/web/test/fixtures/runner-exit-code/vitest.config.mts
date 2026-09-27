import { defineConfig } from 'vitest/config';
import web from '../../../vitest.config.mjs';

/**
 * The web canary configuration: `apps/web/vitest.config.mts` in every respect
 * — the same root, JSX transform, aliases and exit-code global setup — except
 * which files it collects (P3-S7 contract §7.1(6)).
 */
export default defineConfig({
  ...web,
  test: {
    ...web.test,
    include: ['test/fixtures/runner-exit-code/*.fixture.tsx'],
  },
});
