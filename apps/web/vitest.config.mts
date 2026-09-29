import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The web unit and SSR runner (P3-S7 contract §5(2)).
 *
 * - Node environment: views are rendered with `react-dom/server`, and the
 *   phone-width checks (T-15, T-16) read the markup through the small walker
 *   in `test/helpers/render.tsx`. No jsdom, no new dependency: vitest is the
 *   root devDependency and `react-dom/server` ships with `react-dom`.
 * - `@/` resolves to `src/`, as the Next build resolves it.
 * - `server-only` resolves to an empty module, so the BFF route handler (whose
 *   `API_URL` import is server-only) can be exercised in a test.
 * - The global setup's first act is `protectFailingExitCode()` — the first
 *   line of `tests/helpers/global-setup.ts`, without `ensurePostgres`: no web
 *   test touches a database, and a runner that cannot report failure proves
 *   nothing.
 */
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': here('./src'),
      'server-only': here('./test/helpers/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    globalSetup: ['test/helpers/global-setup.ts'],
  },
});
