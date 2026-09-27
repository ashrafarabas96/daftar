import { afterAll, afterEach, beforeEach } from 'vitest';
import { closeTestApps, openTestApps } from './test-app';

/**
 * Per-file lifecycle guard (Directive §67/§74: the suite must pass on a FRESH
 * PostgreSQL with the stock max_connections=100 — no manually tuned database).
 *
 * Every createTestApp() owns six role pools. A test that builds an app in
 * beforeEach and never closes it leaks those connections until the server
 * refuses new sessions ("remaining connection slots are reserved"), which
 * cascades into >100 unrelated failures. This setup file closes every app that
 * was opened DURING a test (or its beforeEach) once that test finishes, and
 * everything still open when the file ends. Apps opened in beforeAll survive
 * across the file's tests exactly as before.
 */
let openedBefore = new Set<object>();

beforeEach(() => {
  openedBefore = new Set(openTestApps());
});

afterEach(async () => {
  await closeTestApps((app) => !openedBefore.has(app));
  // Yield one macrotask so the fork can answer the runner's RPC between tests.
  // A file of synchronous tests (the static-guard suites re-parse every
  // migration per case) otherwise never lets the event loop run, and once the
  // file passes 60 s the pending "onTaskUpdate" call times out and aborts the
  // whole run. No test's own budget or timeout changes.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

afterAll(async () => {
  await closeTestApps(() => true);
});
