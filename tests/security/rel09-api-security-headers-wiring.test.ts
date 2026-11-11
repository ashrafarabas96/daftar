import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';

/**
 * REL-09, the wiring half.
 *
 * `tests-unit/rel09-api-security-headers.test.ts` drives the middleware
 * directly, so it proves the POLICY (including the production HSTS arm, which
 * no test app can reach: `loadConfig` refuses `PROCESS_MODE=all` in
 * production). It proves nothing about reach. This file asserts the headers on
 * a real HTTP response, through the `consumer.apply(RequestContextMiddleware)
 * .forRoutes('*')` registration — because a header set in a class that no
 * request passes through protects nobody.
 *
 * It also carries the negative control the unit lane cannot: the app here runs
 * with `NODE_ENV=test`, so a `Strict-Transport-Security` on this response would
 * mean the production gate is not a gate at all.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('REL-09: a real API response carries the hardening headers', () => {
  it('a public endpoint answers with the locked-down CSP and the four existing headers', async () => {
    const res = await t.request.get('/v1/health/live');
    // Positive control: the response is the API's, not a 404 from nowhere.
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('an authenticated surface refusing a request carries them too', async () => {
    // The error path has its own `setHeader` calls (`common/error.filter.ts`),
    // so "the headers are on the happy path" is not the same claim as "the
    // headers are on every response".
    const res = await t.request.get('/v1/me/businesses');
    expect(res.status).toBe(401);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('NEGATIVE CONTROL: a non-production app does not pin the host to https', async () => {
    const res = await t.request.get('/v1/health/live');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
