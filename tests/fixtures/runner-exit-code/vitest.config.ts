import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The canary configuration. It is the root configuration in every respect
 * that matters to the defect it watches for — the same globalSetup, which is
 * what pulls `embedded-postgres` and its shutdown hook into the main process,
 * and the same setup files — and differs only in which files it collects.
 */
export default defineConfig({
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
    }),
  },
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['tests/fixtures/runner-exit-code/*.fixture.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globalSetup: 'tests/helpers/global-setup.ts',
    setupFiles: ['tests/helpers/setup.ts'],
    env: { NODE_PATH: '' },
  },
});
