import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config';
import { createObjectStorage, S3ObjectStorage } from '../../apps/api/src/infra/storage';
import { createCredentialDelivery, SmtpDelivery } from '../../apps/api/src/modules/delivery/smtp-delivery';
import { RedisRateLimiter } from '../../apps/api/src/infra/redis';

/** Blocker 4: production KMS bridge = https endpoint + bearer token (both mandatory). */
const KMS_BRIDGE = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
} as const;

const PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  // Deliberately DIFFERENT bytes from the provisioning key: since P2-S3 a
  // production merchant process refuses to start when the two secrets are
  // byte-equal, because one compromise would then reach both provisioning
  // and the ledger.
  ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  ACCOUNTING_ASSERTION_KID: 'acct1',
  WORKER_DATABASE_URL: 'postgresql://daftar_worker:x@db/daftar',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  CREDENTIAL_DELIVERY_KIND: 'smtp',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  SMTP_FROM: 'no-reply@daftar.example',
  CREDENTIAL_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64'),
  REDIS_URL: 'redis://redis:6379',
};

/**
 * Gate A §20–32: production provider selection. With production env the
 * factories MUST produce the real adapters — never LocalObjectStorage,
 * LogDelivery or MemoryRateLimiter.
 */
describe('production provider wiring (Gate A §20–32)', () => {
  it('NODE_ENV=production + MEDIA_STORAGE=s3 → REAL S3 adapter', () => {
    // media storage belongs to the merchant-api process — strip secrets it must not receive
    const { PLATFORM_DATABASE_URL: _p, WORKER_DATABASE_URL: _w, CREDENTIAL_PAYLOAD_KEY: _k, SMTP_URL: _s, ...merchantEnv } = PROD_ENV;
    const config = loadConfig({ ...merchantEnv, PROCESS_MODE: 'merchant-api', ...KMS_BRIDGE });
    const storage = createObjectStorage(config);
    expect(storage).toBeInstanceOf(S3ObjectStorage);
    expect(storage.kind).toBe('s3');
  });

  it('NODE_ENV=production + CREDENTIAL_DELIVERY_KIND=smtp → REAL SMTP adapter', () => {
    // credential delivery belongs to the worker process only
    const config = loadConfig({
      NODE_ENV: 'production',
      PROCESS_MODE: 'worker',
      WORKER_DATABASE_URL: 'postgresql://daftar_worker:x@db/daftar',
      CREDENTIAL_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64'),
      CREDENTIAL_DELIVERY_KIND: 'smtp',
      SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
      SMTP_FROM: 'no-reply@daftar.example',
    });
    const delivery = createCredentialDelivery(config);
    expect(delivery).toBeInstanceOf(SmtpDelivery);
    expect(delivery.kind).toBe('smtp');
  });

  it('NODE_ENV=production + REDIS_URL → distributed Redis limiter', () => {
    // HTTP surface (platform-api) — strip worker/provisioner/credential secrets
    const {
      WORKER_DATABASE_URL: _w,
      PROVISIONER_DATABASE_URL: _pv,
      PROVISIONING_ASSERTION_KEY: _pa,
      // §19/§20: platform administration is not financial authority, so the
      // platform process must not carry the accounting signing key either.
      ACCOUNTING_ASSERTION_KEY: _ak,
      CREDENTIAL_PAYLOAD_KEY: _k,
      SMTP_URL: _s,
      ...platformEnv
    } = PROD_ENV;
    const config = loadConfig({ ...platformEnv, PROCESS_MODE: 'platform-api', ...KMS_BRIDGE });
    const limiter = new RedisRateLimiter(config);
    expect(limiter.kind).toBe('redis');
    void limiter.close().catch(() => undefined);
  });

  it('production REFUSES local storage / log delivery / missing payload key / shared DB roles', () => {
    expect(() => loadConfig({ ...PROD_ENV, MEDIA_STORAGE: 'local' })).toThrow(/MEDIA_STORAGE/);
    expect(() => loadConfig({ ...PROD_ENV, CREDENTIAL_DELIVERY_KIND: 'log' })).toThrow(/CREDENTIAL_DELIVERY_KIND/);
    expect(() => loadConfig({ ...PROD_ENV, CREDENTIAL_PAYLOAD_KEY: undefined })).toThrow(/CREDENTIAL_PAYLOAD_KEY/);
    // §31: misconfiguration — worker credentials must not alias the app role.
    expect(() => loadConfig({ ...PROD_ENV, WORKER_DATABASE_URL: PROD_ENV['APP_DATABASE_URL'] })).toThrow();
  });

  it('factories never fall back silently: s3 without bucket throws, smtp without URL throws', () => {
    const devConfig = loadConfig({
      NODE_ENV: 'development',
      APP_DATABASE_URL: 'postgresql://daftar_app:x@localhost/daftar',
      JWT_SECRET: 'dev-secret-with-at-least-32-characters!',
    });
    expect(createObjectStorage(devConfig).kind).toBe('local-development-only');
    expect(createCredentialDelivery(devConfig).kind).toBe('log-development-only');
    expect(() => createObjectStorage({ ...devConfig, MEDIA_STORAGE: 's3' })).toThrow(/S3_BUCKET/);
  });
});

describe('process-level secret separation (§XXV–XXXI)', () => {
  it('merchant-api: valid with its own secret set', () => {
    // strip the secrets the merchant process must not receive — valid.
    // Part C: the merchant carries NO credential key material — it encrypts
    // via a KMS-style provider endpoint only.
    const { PLATFORM_DATABASE_URL: _p, WORKER_DATABASE_URL: _w, CREDENTIAL_PAYLOAD_KEY: _k, SMTP_URL: _s, ...merchantEnv } = PROD_ENV;
    const cfg = loadConfig({ ...merchantEnv, PROCESS_MODE: 'merchant-api', ...KMS_BRIDGE });
    expect(cfg.PROCESS_MODE).toBe('merchant-api');
  });

  it('merchant-api: production startup FAILS without a KMS-style encrypt provider (DEV key impossible)', () => {
    const { PLATFORM_DATABASE_URL: _p, WORKER_DATABASE_URL: _w, CREDENTIAL_PAYLOAD_KEY: _k, SMTP_URL: _s, ...merchantEnv } = PROD_ENV;
    expect(() => loadConfig({ ...merchantEnv, PROCESS_MODE: 'merchant-api' })).toThrow(/CREDENTIAL_KMS_ENDPOINT/);
    // and the encryptor factory refuses to build a local adapter in production
    return import('../../apps/api/src/modules/delivery/credential-protector').then(({ createCredentialEncryptor }) => {
      expect(() => createCredentialEncryptor({ NODE_ENV: 'production' })).toThrow(/CREDENTIAL_KMS_ENDPOINT/);
    });
  });

  it('merchant-api REJECTS platform/worker/key/SMTP secrets', () => {
    expect(() => loadConfig({ ...PROD_ENV, PROCESS_MODE: 'merchant-api' })).toThrow(/must NOT be set in PROCESS_MODE=merchant-api/);
    const { PLATFORM_DATABASE_URL: _p, ...rest } = PROD_ENV;
    expect(() => loadConfig({ ...rest, PROCESS_MODE: 'merchant-api' } as NodeJS.ProcessEnv)).toThrow(/must NOT be set/); // still has worker/smtp/key
  });

  it('platform-api REJECTS worker secrets and credential keys', () => {
    expect(() => loadConfig({ ...PROD_ENV, PROCESS_MODE: 'platform-api' })).toThrow(/must NOT be set in PROCESS_MODE=platform-api/);
    const {
      WORKER_DATABASE_URL: _w,
      PROVISIONER_DATABASE_URL: _pv,
      PROVISIONING_ASSERTION_KEY: _pa,
      // §19/§20: platform administration is not financial authority, so the
      // platform process must not carry the accounting signing key either.
      ACCOUNTING_ASSERTION_KEY: _ak,
      CREDENTIAL_PAYLOAD_KEY: _k,
      SMTP_URL: _s,
      ...platformEnv
    } = PROD_ENV;
    // Directive §24: the platform HTTP runtime enqueues password resets, so it
    // needs the KMS-style ENCRYPT provider too — never local key material.
    expect(() => loadConfig({ ...platformEnv, PROCESS_MODE: 'platform-api' })).toThrow(/CREDENTIAL_KMS_ENDPOINT/);
    expect(() => loadConfig({ ...platformEnv, PROCESS_MODE: 'platform-api', ...KMS_BRIDGE })).not.toThrow();
  });

  it('worker: requires worker DB + key ring + SMTP; REJECTS merchant/platform DB URLs and JWT', () => {
    expect(() => loadConfig({ ...PROD_ENV, PROCESS_MODE: 'worker' })).toThrow(/must NOT be set in PROCESS_MODE=worker/);
    const workerEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      PROCESS_MODE: 'worker',
      WORKER_DATABASE_URL: 'postgresql://daftar_worker:x@db/daftar',
      CREDENTIAL_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64'),
      CREDENTIAL_DELIVERY_KIND: 'smtp',
      SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
      SMTP_FROM: 'no-reply@daftar.example',
    };
    expect(() => loadConfig(workerEnv)).not.toThrow();
    const { WORKER_DATABASE_URL: _w, ...noDb } = workerEnv;
    expect(() => loadConfig(noDb)).toThrow(/WORKER_DATABASE_URL/);
    const { CREDENTIAL_PAYLOAD_KEY: _k, ...noKey } = workerEnv;
    expect(() => loadConfig(noKey)).toThrow(/CREDENTIAL_PAYLOAD_KEY/);
  });

  it('Blocker 1: merchant-api production REQUIRES the provisioning assertion key; platform-api and worker must NOT receive it', () => {
    const { PLATFORM_DATABASE_URL: _p, WORKER_DATABASE_URL: _w, CREDENTIAL_PAYLOAD_KEY: _k, SMTP_URL: _s, ...merchantEnv } = PROD_ENV;
    const { PROVISIONING_ASSERTION_KEY: _pa, ...noKey } = merchantEnv;
    expect(() => loadConfig({ ...noKey, PROCESS_MODE: 'merchant-api', ...KMS_BRIDGE })).toThrow(/PROVISIONING_ASSERTION_KEY/);
    expect(() =>
      loadConfig({
        ...merchantEnv,
        PROVISIONING_ASSERTION_KEY: Buffer.alloc(8, 1).toString('base64'),
        PROCESS_MODE: 'merchant-api',
        ...KMS_BRIDGE,
      }),
    ).toThrow(/at least 32 bytes/);
    const { WORKER_DATABASE_URL: _w2, PROVISIONER_DATABASE_URL: _pv, CREDENTIAL_PAYLOAD_KEY: _k2, SMTP_URL: _s2, ...platformWithKey } = PROD_ENV;
    expect(() => loadConfig({ ...platformWithKey, PROCESS_MODE: 'platform-api', ...KMS_BRIDGE })).toThrow(/PROVISIONING_ASSERTION_KEY.*must NOT be set/);
  });

  it('mode=all is FORBIDDEN in production (§10 separated runtimes), allowed in dev/test', () => {
    expect(() => loadConfig({ ...PROD_ENV, PROCESS_MODE: 'all' })).toThrow(/PROCESS_MODE=all is forbidden in production/);
    // dev/test convenience mode still works outside production
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        PROCESS_MODE: 'all',
        APP_DATABASE_URL: 'postgresql://daftar_app:x@localhost/daftar',
        JWT_SECRET: 'dev-secret-with-at-least-32-characters!',
      }),
    ).not.toThrow();
    // HTTP surfaces still require REDIS_URL in production (merchant-api shown)
    const { PLATFORM_DATABASE_URL: _p, WORKER_DATABASE_URL: _w, CREDENTIAL_PAYLOAD_KEY: _k, SMTP_URL: _s, REDIS_URL: _r, ...noRedis } = PROD_ENV;
    expect(() => loadConfig({ ...noRedis, PROCESS_MODE: 'merchant-api' })).toThrow(/REDIS_URL/);
  });
});
