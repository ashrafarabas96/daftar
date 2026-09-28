import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { loadConfig } from '../../apps/api/src/config';
import { createTestApp, type TestApp } from '../helpers/test-app';

/**
 * TD-19 review M-1: the legacy `TRUST_PROXY=true` mode.
 *
 * It took the LEFTMOST X-Forwarded-For entry — the one the CALLER writes — as
 * the client, and every per-client limit keys on that (login, register,
 * password reset, refresh and, since the per-route throttle counts the client,
 * the 300-per-minute allowance too). A caller rotating that entry had an
 * unlimited allowance of everything. The review's reproduction: 320 GETs with
 * a rotating X-Forwarded-For were never throttled, and 45 failed logins never
 * met a 429.
 *
 * Now:
 * - production refuses `TRUST_PROXY=true` at startup (a deployment lists its
 *   proxies in TRUSTED_PROXIES);
 * - in dev/test the legacy mode means "exactly one proxy in front": the client
 *   is the RIGHTMOST entry, the one that proxy appended; whatever the caller
 *   wrote to its left is ignored.
 */

const KMS = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms-bridge.internal.example/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
};
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
  ...KMS,
};
const PLATFORM_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'platform-api',
  PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@127.0.0.1:1/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@127.0.0.1:1/daftar',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  REDIS_URL: 'redis://127.0.0.1:1',
  ...KMS,
};
const REFUSED = /TRUST_PROXY: TRUST_PROXY=true is refused in production/;

describe('M-1: production refuses the legacy proxy mode', () => {
  it.each([
    ['merchant-api', MERCHANT_PROD],
    ['platform-api', PLATFORM_PROD],
  ])('DENY: a production %s process with TRUST_PROXY=true does not start', (_mode, env) => {
    expect(() => loadConfig({ ...env, TRUST_PROXY: 'true' })).toThrow(REFUSED);
    expect(() => loadConfig({ ...env, TRUST_PROXY: 'true', TRUSTED_PROXIES: '10.0.0.0/8' })).toThrow(REFUSED);
  });

  it.each([
    ['merchant-api', MERCHANT_PROD],
    ['platform-api', PLATFORM_PROD],
  ])('ALLOW: a production %s process names its proxies in TRUSTED_PROXIES instead', (_mode, env) => {
    expect(() => loadConfig({ ...env, TRUSTED_PROXIES: '10.0.0.0/8' })).not.toThrow();
    expect(() => loadConfig({ ...env, TRUST_PROXY: 'false', TRUSTED_PROXIES: '10.0.0.0/8' })).not.toThrow();
  });

  it('ALLOW: dev and test may still run the legacy mode', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', TRUST_PROXY: 'true' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' })).not.toThrow();
  });
});

let t: TestApp;
let api: string;

/** The review's reproduction, as a caller behind the one proxy the legacy mode assumes: the proxy appends the caller's real address. */
function viaOneProxy(method: 'GET' | 'POST', path: string, callerWrote: string, body?: unknown): Promise<number> {
  const url = new URL(path, api);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'x-forwarded-for': `${callerWrote}, 203.0.113.50` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method, localAddress: '127.0.0.9', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function tally(statuses: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

describe('M-1: in the legacy mode a caller cannot choose its address', () => {
  beforeAll(async () => {
    t = await createTestApp({ configOverrides: { TRUST_PROXY: 'true', TRUSTED_PROXIES: '' } });
    await t.app.listen(0, '127.0.0.1');
    const address: unknown = t.app.getHttpServer().address();
    if (typeof address !== 'object' || address === null || !('port' in address)) throw new Error('the API is not listening on a port');
    api = `http://127.0.0.1:${String(address.port)}`;
  });
  afterAll(async () => {
    await t.close();
  });

  it('DENY: 320 GETs with a rotating X-Forwarded-For meet the per-route allowance at 300', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 320; i += 1) statuses.push(await viaOneProxy('GET', '/v1/me/businesses', `10.7.${i >> 8}.${i & 255}`));
    expect(tally(statuses)).toEqual({ 401: 300, 429: 20 });
  });

  it('DENY: 45 failed logins with a rotating X-Forwarded-For meet the per-client login limit at 30', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 45; i += 1) {
      statuses.push(await viaOneProxy('POST', '/v1/auth/login', `10.6.0.${i}`, { email: `nobody${i}@example.com`, password: 'wrong-password-123' }));
    }
    expect(tally(statuses)).toEqual({ 401: 30, 429: 15 });
  });
});
