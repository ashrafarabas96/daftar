import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../apps/api/src/config';

/**
 * TD-14 (Phase 3 corrective directive §13): the platform process refuses the
 * merchant database credential.
 *
 * `platform-api` never opens an app pool (`Database` owns `app` only in
 * `merchant-api` and `all`), so `APP_DATABASE_URL` there is a credential the
 * process cannot use and must not hold: together with the platform
 * credential's key-install authority it is the two-credential signing
 * authority TD-14 describes. Production refuses it at startup, like every
 * other secret outside the platform's authority; dev/test stay permissive for
 * every mode but the reconciler, as they are for the other platform rules.
 */

const KMS = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms-bridge.internal.example/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
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

const APP_URL = 'postgresql://daftar_app:x@127.0.0.1:1/daftar';
const REFUSED = /APP_DATABASE_URL: must NOT be set in PROCESS_MODE=platform-api/;

describe('TD-14 platform-api and the merchant database credential', () => {
  it('ALLOW: a production platform process without APP_DATABASE_URL starts', () => {
    expect(() => loadConfig(PLATFORM_PROD)).not.toThrow();
  });

  it('DENY: a production platform process holding APP_DATABASE_URL fails at startup, naming it', () => {
    expect(() => loadConfig({ ...PLATFORM_PROD, APP_DATABASE_URL: APP_URL })).toThrow(REFUSED);
  });

  it('DENY: the real entry point exits non-zero with that error before opening any connection', async () => {
    const api = fileURLToPath(new URL('../../apps/api/', import.meta.url));
    const run = promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: api,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...PLATFORM_PROD, APP_DATABASE_URL: APP_URL },
      timeout: 60_000,
    });
    const failure: unknown = await run.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(failure instanceof Error) || !('stderr' in failure) || !('code' in failure)) throw new Error('the entry point started instead of refusing');
    const { code, stderr } = failure;
    expect(code).toBe(1);
    expect(stderr).toMatch(/Invalid configuration \(fails fast at startup\)/);
    expect(stderr).toMatch(REFUSED);
  }, 90_000);

  it('the merchant process is unchanged: it still requires APP_DATABASE_URL', () => {
    expect(() => loadConfig(MERCHANT_PROD)).not.toThrow();
    const { APP_DATABASE_URL: _app, ...withoutApp } = MERCHANT_PROD;
    expect(() => loadConfig(withoutApp)).toThrow(/APP_DATABASE_URL: merchant-api requires the app DB URL/);
  });

  it('dev/test platform runs keep their existing latitude (the pool is simply never opened)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', PROCESS_MODE: 'platform-api', PLATFORM_DATABASE_URL: PLATFORM_PROD['PLATFORM_DATABASE_URL'], APP_DATABASE_URL: APP_URL }),
    ).not.toThrow();
  });
});
