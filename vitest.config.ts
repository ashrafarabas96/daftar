import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
    }),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globalSetup: 'tests/helpers/global-setup.ts',
    env: { NODE_PATH: '' },
  },
});
