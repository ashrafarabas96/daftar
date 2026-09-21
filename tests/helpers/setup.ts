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
});

afterAll(async () => {
  await closeTestApps(() => true);
});
