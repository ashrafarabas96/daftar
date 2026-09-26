import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config';

/**
 * P3-AL-55 §C and signed-authority matrix row P: the inventory command key's
 * configuration rules.
 *
 * - `INVENTORY_ASSERTION_KEY` is REQUIRED for a production merchant API, and
 *   must decode to at least 32 bytes;
 * - it is FORBIDDEN in the platform API and the worker (production) and in the
 *   reconciler (every environment) — exactly the accounting key's rules;
 * - it is REFUSED when its DECODED bytes equal the provisioning key's or the
 *   accounting key's, including when the two values are different base64
 *   spellings of one secret. Different variable names are not separation.
 */

const KMS_BRIDGE = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
} as const;

const PROVISIONING = Buffer.alloc(32, 9).toString('base64');
const ACCOUNTING = Buffer.alloc(32, 11).toString('base64');
const INVENTORY = Buffer.alloc(32, 13).toString('base64');

/** A complete, valid production merchant-api environment. */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: PROVISIONING,
  ACCOUNTING_ASSERTION_KEY: ACCOUNTING,
  ACCOUNTING_ASSERTION_KID: 'acct1',
  INVENTORY_ASSERTION_KEY: INVENTORY,
  INVENTORY_ASSERTION_KID: 'inv1',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  REDIS_URL: 'redis://redis:6379',
  ...KMS_BRIDGE,
};

const PLATFORM_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'platform-api',
  PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  REDIS_URL: 'redis://redis:6379',
  ...KMS_BRIDGE,
};

const WORKER_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'worker',
  WORKER_DATABASE_URL: 'postgresql://daftar_worker:x@db/daftar',
  CREDENTIAL_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64'),
  CREDENTIAL_DELIVERY_KIND: 'smtp',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  SMTP_FROM: 'no-reply@daftar.example',
};

const RECONCILER: NodeJS.ProcessEnv = {
  PROCESS_MODE: 'reconciler',
  RECONCILER_DATABASE_URL: 'postgresql://daftar_reconciler:x@db/daftar',
};

/**
 * A second spelling of the same bytes: the URL-safe alphabet with the padding
 * removed. Node's base64 decoder accepts both, so a comparison of the
 * configured STRINGS would call these two different secrets.
 */
function respell(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes whose standard base64 spelling contains '+', '/' and padding. */
const AWKWARD = Buffer.from(Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 0xfb : 0xff))).toString('base64');

function withoutInventoryKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { INVENTORY_ASSERTION_KEY: _k, ...rest } = env;
  return rest;
}

describe('INVENTORY_ASSERTION_KEY — the production merchant API (P3-AL-55 §C)', () => {
  it('a production merchant API starts with its own distinct inventory key', () => {
    const cfg = loadConfig(MERCHANT_PROD);
    expect(cfg.INVENTORY_ASSERTION_KEY).toBe(INVENTORY);
    expect(cfg.INVENTORY_ASSERTION_KID).toBe('inv1');
  });

  it('is REQUIRED: a production merchant API without it refuses to start', () => {
    expect(() => loadConfig(withoutInventoryKey(MERCHANT_PROD))).toThrow(/INVENTORY_ASSERTION_KEY: production inventory commands require/);
  });

  it('must decode to at least 32 bytes', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, INVENTORY_ASSERTION_KEY: Buffer.alloc(31, 13).toString('base64') })).toThrow(
      /INVENTORY_ASSERTION_KEY: must be base64 of at least 32 bytes/,
    );
    expect(() => loadConfig({ ...MERCHANT_PROD, INVENTORY_ASSERTION_KEY: Buffer.alloc(32, 13).toString('base64') })).not.toThrow();
  });

  it('the kid must match ^[A-Za-z0-9_-]{1,32}$ in every environment', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, INVENTORY_ASSERTION_KID: 'inv.1' })).toThrow(/INVENTORY_ASSERTION_KID/);
    expect(() => loadConfig({ ...MERCHANT_PROD, INVENTORY_ASSERTION_KID: 'x'.repeat(33) })).toThrow(/INVENTORY_ASSERTION_KID/);
    expect(() => loadConfig({ NODE_ENV: 'test', INVENTORY_ASSERTION_KID: 'bad kid' })).toThrow(/INVENTORY_ASSERTION_KID/);
  });

  it('is REFUSED when its bytes equal the provisioning key', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, INVENTORY_ASSERTION_KEY: PROVISIONING })).toThrow(
      /INVENTORY_ASSERTION_KEY: must not be the same secret as PROVISIONING_ASSERTION_KEY/,
    );
  });

  it('is REFUSED when its bytes equal the accounting key', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, INVENTORY_ASSERTION_KEY: ACCOUNTING })).toThrow(
      /INVENTORY_ASSERTION_KEY: must not be the same secret as ACCOUNTING_ASSERTION_KEY/,
    );
  });

  it('compares DECODED bytes: a different base64 spelling of the provisioning key is still refused', () => {
    const alternate = respell(AWKWARD);
    expect(alternate).not.toBe(AWKWARD);
    expect(Buffer.from(alternate, 'base64').equals(Buffer.from(AWKWARD, 'base64'))).toBe(true);
    // The two keys are valid and distinct on their own …
    expect(() => loadConfig({ ...MERCHANT_PROD, PROVISIONING_ASSERTION_KEY: AWKWARD })).not.toThrow();
    // … and the same secret under another spelling is one secret.
    expect(() => loadConfig({ ...MERCHANT_PROD, PROVISIONING_ASSERTION_KEY: AWKWARD, INVENTORY_ASSERTION_KEY: alternate })).toThrow(
      /INVENTORY_ASSERTION_KEY: must not be the same secret as PROVISIONING_ASSERTION_KEY/,
    );
  });

  it('compares DECODED bytes: a different base64 spelling of the accounting key is still refused', () => {
    const alternate = respell(AWKWARD);
    expect(() => loadConfig({ ...MERCHANT_PROD, ACCOUNTING_ASSERTION_KEY: AWKWARD })).not.toThrow();
    expect(() => loadConfig({ ...MERCHANT_PROD, ACCOUNTING_ASSERTION_KEY: AWKWARD, INVENTORY_ASSERTION_KEY: alternate })).toThrow(
      /INVENTORY_ASSERTION_KEY: must not be the same secret as ACCOUNTING_ASSERTION_KEY/,
    );
  });

  it('is not required outside production (dev/test supply it explicitly, like the accounting key)', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PROCESS_MODE: 'merchant-api',
        APP_DATABASE_URL: 'postgresql://daftar_app:x@localhost/daftar',
        JWT_SECRET: 'dev-secret-with-at-least-32-characters!',
      }),
    ).not.toThrow();
  });
});

describe('INVENTORY_ASSERTION_KEY — forbidden outside the merchant API (P3-AL-55 §C)', () => {
  it('platform-api: valid without it, refused with it', () => {
    expect(() => loadConfig(PLATFORM_PROD)).not.toThrow();
    expect(() => loadConfig({ ...PLATFORM_PROD, INVENTORY_ASSERTION_KEY: INVENTORY })).toThrow(
      /INVENTORY_ASSERTION_KEY: must NOT be set in PROCESS_MODE=platform-api/,
    );
  });

  it('worker: valid without it, refused with it', () => {
    expect(() => loadConfig(WORKER_PROD)).not.toThrow();
    expect(() => loadConfig({ ...WORKER_PROD, INVENTORY_ASSERTION_KEY: INVENTORY })).toThrow(/INVENTORY_ASSERTION_KEY: must NOT be set in PROCESS_MODE=worker/);
  });

  it.each(['production', 'test', 'development'])('reconciler (%s): refused with it — the separation is a property of the mode', (nodeEnv) => {
    expect(() => loadConfig({ ...RECONCILER, NODE_ENV: nodeEnv })).not.toThrow();
    expect(() => loadConfig({ ...RECONCILER, NODE_ENV: nodeEnv, INVENTORY_ASSERTION_KEY: INVENTORY })).toThrow(
      /INVENTORY_ASSERTION_KEY: must NOT be set in PROCESS_MODE=reconciler/,
    );
  });
});
