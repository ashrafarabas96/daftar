import { describe, expect, it } from 'vitest';
import { RequestContextMiddleware } from '../apps/api/src/app/request-context.middleware';
import { loadConfig, type AppConfig } from '../apps/api/src/config';

/**
 * REL-09: the API response carried four hardening headers and neither a
 * transport policy (HSTS) nor a content policy (CSP).
 *
 * Measured on `origin/main` @ `c079a2df`, before this guard existed:
 * `apps/api/src/app/request-context.middleware.ts` set `X-Request-Id`,
 * `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
 * `Cache-Control` — five `setHeader` calls — and
 * `grep -rinE "helmet|Strict-Transport|Content-Security-Policy" apps/api/src`
 * exited 1 with zero rows, against a positive control of 7 `setHeader` hits in
 * the same tree. So the absence was a measurement, not a blind probe.
 *
 * WHAT THIS LANE PROVES AND WHAT IT DOES NOT
 *
 * This file drives the middleware DIRECTLY, with a recorder in place of the
 * express response, so it can assert the PRODUCTION arm of HSTS — which
 * `createTestApp` cannot reach, because `loadConfig` refuses `PROCESS_MODE=all`
 * in production. It therefore says nothing about whether the middleware is
 * reached by a real request: that is the wiring, and
 * `tests/security/rel09-api-security-headers-wiring.test.ts` asserts it on a
 * live HTTP response instead. Neither file is sufficient on its own.
 *
 * WHY HSTS IS PRODUCTION-ONLY AND CSP IS NOT
 *
 * HSTS is a per-HOST instruction a browser remembers: emitted from a
 * development box it pins `localhost` — every port, every other project on
 * that machine — to https, which is exactly the kind of damage that is
 * discovered weeks later. Production is where TLS terminates, so production is
 * where it is emitted. CSP carries no such memory: it applies to the one
 * response that carries it, so it is emitted everywhere and a test can see it.
 *
 * `preload` is deliberately NOT part of the policy: submitting a host to the
 * browsers' preload list is not reversible on the project's own timetable, and
 * that is an owner's decision about a domain, not a middleware default.
 */

const KMS = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms-bridge.internal.example/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
};

/** A production merchant process, mirroring `tests/security/p3c-legacy-trust-proxy.test.ts`. */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  INVENTORY_ASSERTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  REDIS_URL: 'redis://redis:6379',
  TRUSTED_PROXIES: '10.0.0.0/8',
  CORS_ORIGINS: 'https://app.example.com',
  ...KMS,
};

/** The headers one request sets, in the order the middleware set them. */
function headersOf(config: AppConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string): void {
      out[name] = value;
    },
  };
  let nextCalls = 0;
  new RequestContextMiddleware(config).use({} as never, res as never, () => {
    nextCalls += 1;
  });
  // A probe that never reached `next()` would not have run the body at all,
  // and an empty `out` would then read as "no header set" rather than as a
  // broken probe. Assert the chain continued before reading anything off it.
  expect(nextCalls).toBe(1);
  return out;
}

const PROD = headersOf(loadConfig(MERCHANT_PROD));
const DEV = headersOf(loadConfig({ NODE_ENV: 'development' }));
const TEST = headersOf(loadConfig({ NODE_ENV: 'test' }));

describe('REL-09: the API sets a content policy on every response', () => {
  it('POSITIVE CONTROL: the probe sees the headers the middleware already set', () => {
    // If this fails, every "absent" assertion below is worthless.
    for (const captured of [PROD, DEV, TEST]) {
      expect(captured['X-Content-Type-Options']).toBe('nosniff');
      expect(captured['X-Frame-Options']).toBe('DENY');
      expect(captured['Referrer-Policy']).toBe('no-referrer');
      expect(captured['Cache-Control']).toBe('no-store');
    }
  });

  it.each([
    ['production', PROD],
    ['development', DEV],
    ['test', TEST],
  ])('a %s response carries a locked-down Content-Security-Policy', (_env, captured) => {
    const csp = captured['Content-Security-Policy'];
    expect(csp).toBeDefined();
    // A JSON API executes nothing and embeds nothing. Each directive is named
    // separately so a later edit that drops one fails by name.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // DR-46 forbids WEAKENING the CSP that the web surfaces enforce. This one
    // is new, on a different surface, and is the strictest policy there is —
    // so no 'unsafe-inline', no 'unsafe-eval', no wildcard source.
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });
});

describe('REL-09: the API sets HSTS in production and nowhere else', () => {
  it('a production response carries Strict-Transport-Security for at least a year, with subdomains', () => {
    const hsts = PROD['Strict-Transport-Security'];
    expect(hsts).toBeDefined();
    const maxAge = /max-age=(\d+)/.exec(hsts ?? '');
    expect(maxAge).not.toBeNull();
    expect(Number(maxAge?.[1])).toBeGreaterThanOrEqual(31_536_000);
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).not.toContain('preload');
  });

  it.each([
    ['development', DEV],
    ['test', TEST],
  ])('NEGATIVE CONTROL: a %s response does not pin the host to https', (_env, captured) => {
    expect(captured['Strict-Transport-Security']).toBeUndefined();
  });
});
