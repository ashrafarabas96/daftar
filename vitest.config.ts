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
    // One test file at a time (the Vitest 3 `singleFork` guarantee the
    // committed-fixture suites rely on, docs/PHASE_3_S2_CONTRACT.md A-11).
    // Vitest 4 removed `poolOptions`; `maxWorkers: 1` keeps the files
    // sequential, and the default `isolate: true` gives each file a fresh
    // fork, so no module state crosses from one file to the next (Vitest 3
    // re-evaluated modules per file inside one fork; `isolate: false` in
    // Vitest 4 would stop doing even that).
    maxWorkers: 1,
    globalSetup: 'tests/helpers/global-setup.ts',
    setupFiles: ['tests/helpers/setup.ts'],
    env: { NODE_PATH: '' },
  },
});
