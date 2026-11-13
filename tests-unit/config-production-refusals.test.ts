import { describe, expect, it } from 'vitest';
import { REQUIRED_SCHEMA_MIGRATION, loadConfig, migrationOrdinal, schemaFloor } from '../apps/api/src/config';

/**
 * The production refusals of `config.ts` that NOTHING asserted.
 *
 * WHY THIS FILE EXISTS, MEASURED RATHER THAN ASSUMED. An audit of every
 * `fail(...)` branch in `apps/api/src/config.ts` against every test in
 * `tests-unit/**`, `tests/**` and `packages/**` found seven refusals with no
 * assertion anywhere:
 *
 *   - `PLATFORM_DATABASE_URL` required for a platform surface
 *   - `IDENTITY_DATABASE_URL` required, and distinct from the other roles
 *   - `RESOLVER_DATABASE_URL` and `PROVISIONER_DATABASE_URL` required, and the
 *     provisioner distinct
 *   - `ACCOUNTING_ASSERTION_KEY` required, and at least 32 bytes
 *   - the s3 media row required as a WHOLE when `MEDIA_STORAGE=s3`
 *   - `SMTP_URL` / `SMTP_FROM` required when delivery is smtp
 *   - `schemaFloor()` refusing a `REQUIRED_SCHEMA_MIGRATION` with no ordinal
 *
 * Two of those have adjacent coverage that is NOT coverage of this, and the
 * difference is the point: `tests/integration/production-providers.test.ts`
 * asserts that `createObjectStorage` refuses an incomplete s3 row, and
 * `tests/security/t10-smtp-delivery-contract.test.ts` asserts that the
 * `SmtpDelivery` constructor refuses a missing URL. Both are CONSTRUCTORS, and
 * both run long after a process has started. The claim this file holds is the
 * one `config.ts` makes: the process does not START. A deployment that is
 * refused at boot and a deployment that boots and fails on first use are
 * different incidents, and only the first is what "fails fast at startup"
 * means.
 *
 * NO SECRET HERE: every key is `Buffer.alloc`-filled or a declared test
 * string, with no authority anywhere outside this file — the pattern
 * `tests-unit/sec01-worker-jwt-deny.test.ts` already uses.
 */

/**
 * A merchant API that is otherwise complete and correct, in production.
 *
 * This repeats the fixture in `tests-unit/sec01-worker-jwt-deny.test.ts`, and the
 * duplication is deliberate (review of #79 noted it): a shared fixture would tie
 * two cards' suites together, so that a key one card needs would silently change
 * what the other measures. Repeated, a newly required variable reddens both files
 * and the cost is visible rather than hidden.
 */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  ACCOUNTING_ASSERTION_KID: 'acct1',
  INVENTORY_ASSERTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  INVENTORY_ASSERTION_KID: 'inv1',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  REDIS_URL: 'redis://redis:6379',
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  // REL-10: a production surface that serves browsers does not start without an
  // explicit allowlist, and the development default is refused BY NAME. So this
  // belongs to "otherwise complete and correct" and not to this card — without
  // it the three positive controls below fail for a reason this file is not
  // about, which is exactly what happened when REL-10 landed on `main`.
  CORS_ORIGINS: 'https://app.example.com',
};

/**
 * A platform API that is otherwise complete and correct, in production.
 *
 * It carries NO `APP_DATABASE_URL`, no provisioner, no assertion keys and no
 * SMTP, because a platform surface is REFUSED those (TD-14 and §8). That is
 * why the platform requirement needs its own fixture rather than a tweak of
 * the merchant one.
 */
const PLATFORM_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'platform-api',
  PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  REDIS_URL: 'redis://redis:6379',
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
  // REL-10 again: `platform-api` serves browsers too, so the same requirement
  // applies to it. The `worker` fixture below deliberately does NOT carry this
  // variable — the refusal is scoped to the modes that answer a browser, and a
  // fixture that set it everywhere would hide that distinction rather than hold
  // it.
  CORS_ORIGINS: 'https://admin.example.com',
};

/** A worker that is otherwise complete and correct, in production. */
const WORKER_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'worker',
  WORKER_DATABASE_URL: 'postgresql://daftar_worker:x@db/daftar',
  CREDENTIAL_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64'),
  CREDENTIAL_DELIVERY_KIND: 'smtp',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  SMTP_FROM: 'no-reply@daftar.example',
};

/** Drop one key from an environment — the shape every refusal below is measured with. */
function without(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[key];
  return out;
}

describe('config.ts: the three production fixtures are correct (POSITIVE CONTROL)', () => {
  // Without these, every `toThrow` below could be passing for an unrelated
  // missing key and would prove nothing about the branch it names.
  it('a complete merchant API starts', () => {
    expect(() => loadConfig(MERCHANT_PROD)).not.toThrow();
  });

  it('a complete platform API starts', () => {
    expect(() => loadConfig(PLATFORM_PROD)).not.toThrow();
  });

  it('a complete worker starts', () => {
    expect(() => loadConfig(WORKER_PROD)).not.toThrow();
  });
});

describe('config.ts: the database principals a production surface cannot start without', () => {
  it('DENY: a platform API with no PLATFORM_DATABASE_URL', () => {
    expect(() => loadConfig(without(PLATFORM_PROD, 'PLATFORM_DATABASE_URL'))).toThrow(/PLATFORM_DATABASE_URL.*requires the platform DB URL/s);
  });

  it('DENY: a production surface with no IDENTITY_DATABASE_URL — both surfaces, since the rule is not the mode', () => {
    expect(() => loadConfig(without(MERCHANT_PROD, 'IDENTITY_DATABASE_URL'))).toThrow(/IDENTITY_DATABASE_URL.*requires the identity DB URL/s);
    expect(() => loadConfig(without(PLATFORM_PROD, 'IDENTITY_DATABASE_URL'))).toThrow(/IDENTITY_DATABASE_URL.*requires the identity DB URL/s);
  });

  it('DENY: IDENTITY_DATABASE_URL aliased to the app role — auth credentials are not the app principal', () => {
    // The defect this refuses is not a missing value but a REUSED one: one
    // connection string pasted twice is a privilege boundary that exists only
    // in the documentation.
    expect(() => loadConfig({ ...MERCHANT_PROD, IDENTITY_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL })).toThrow(
      /IDENTITY_DATABASE_URL.*must be distinct from APP_DATABASE_URL and PLATFORM_DATABASE_URL/s,
    );
  });

  it('DENY: IDENTITY_DATABASE_URL aliased to the platform role', () => {
    expect(() => loadConfig({ ...PLATFORM_PROD, IDENTITY_DATABASE_URL: PLATFORM_PROD.PLATFORM_DATABASE_URL })).toThrow(
      /IDENTITY_DATABASE_URL.*must be distinct from APP_DATABASE_URL and PLATFORM_DATABASE_URL/s,
    );
  });

  it('DENY: a merchant API with no RESOLVER_DATABASE_URL', () => {
    expect(() => loadConfig(without(MERCHANT_PROD, 'RESOLVER_DATABASE_URL'))).toThrow(/RESOLVER_DATABASE_URL.*requires the membership-resolver DB URL/s);
  });

  it('DENY: a merchant API with no PROVISIONER_DATABASE_URL', () => {
    expect(() => loadConfig(without(MERCHANT_PROD, 'PROVISIONER_DATABASE_URL'))).toThrow(/PROVISIONER_DATABASE_URL.*requires the provisioning DB URL/s);
  });

  it('DENY: PROVISIONER_DATABASE_URL aliased to the app role', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, PROVISIONER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL })).toThrow(
      /PROVISIONER_DATABASE_URL.*must be a distinct role from APP\/PLATFORM/s,
    );
  });
});

describe('config.ts: why these fixtures carry CORS_ORIGINS at all', () => {
  it('DENY: a browser-serving surface with no CORS_ORIGINS does not start — both surfaces', () => {
    // This is not a second home for REL-10 (`tests-unit/rel10-cors-allowlist.test.ts`
    // holds that card). It is here so the fixtures' extra variable can never be
    // tidied away as noise: if someone drops `CORS_ORIGINS` from the two
    // production fixtures above, THIS case keeps naming the reason instead of
    // three unrelated positive controls failing with a CORS message.
    //
    // Measured on the tree where REL-10 had just landed: the fixtures without it
    // failed 3 of 21, and the three were "a complete merchant API starts",
    // "a complete platform API starts" and the 32-byte boundary — none of which
    // is about CORS.
    expect(() => loadConfig(without(MERCHANT_PROD, 'CORS_ORIGINS'))).toThrow(/CORS_ORIGINS/);
    expect(() => loadConfig(without(PLATFORM_PROD, 'CORS_ORIGINS'))).toThrow(/CORS_ORIGINS/);
  });

  it('ALLOW: a production worker needs none, because it answers no browser', () => {
    // The negative control of the same rule: REL-10 is scoped to the modes that
    // serve browsers, and a fixture carrying the variable everywhere would hide
    // that scope rather than hold it.
    expect(WORKER_PROD.CORS_ORIGINS).toBeUndefined();
    expect(() => loadConfig(WORKER_PROD)).not.toThrow();
  });
});

describe('config.ts: the accounting assertion key', () => {
  it('DENY: a merchant API with no ACCOUNTING_ASSERTION_KEY', () => {
    expect(() => loadConfig(without(MERCHANT_PROD, 'ACCOUNTING_ASSERTION_KEY'))).toThrow(
      /ACCOUNTING_ASSERTION_KEY.*requires the accounting assertion HMAC key/s,
    );
  });

  it('DENY: an ACCOUNTING_ASSERTION_KEY shorter than 32 bytes, measured as BYTES and not characters', () => {
    // 31 bytes is the interesting case, not 4: a base64 string that LOOKS long
    // enough while decoding one byte short is exactly the mistake a length
    // check on the string would miss.
    expect(() => loadConfig({ ...MERCHANT_PROD, ACCOUNTING_ASSERTION_KEY: Buffer.alloc(31, 11).toString('base64') })).toThrow(
      /ACCOUNTING_ASSERTION_KEY.*must be base64 of at least 32 bytes/s,
    );
    // And the boundary itself holds from the other side: 32 bytes starts.
    expect(() => loadConfig({ ...MERCHANT_PROD, ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 12).toString('base64') })).not.toThrow();
  });
});

describe('config.ts: the s3 media row is required as a whole, at startup', () => {
  // `tests/integration/production-providers.test.ts` holds the CONSTRUCTOR's
  // refusal. This holds the BOOT refusal, which is a different event.
  it.each([['S3_ENDPOINT'], ['S3_BUCKET'], ['S3_ACCESS_KEY_ID'], ['S3_SECRET_ACCESS_KEY']])('DENY: MEDIA_STORAGE=s3 with %s missing', (key) => {
    expect(() => loadConfig(without(MERCHANT_PROD, key))).toThrow(/S3_BUCKET.*all required for s3 storage/s);
  });
});

describe('config.ts: smtp delivery is required to be complete, at startup', () => {
  it('DENY: a production worker delivering by smtp with no SMTP_URL', () => {
    expect(() => loadConfig(without(WORKER_PROD, 'SMTP_URL'))).toThrow(/SMTP_URL.*required when CREDENTIAL_DELIVERY_KIND=smtp/s);
  });

  it('DENY: the same with no SMTP_FROM — the sender address is not optional either', () => {
    expect(() => loadConfig(without(WORKER_PROD, 'SMTP_FROM'))).toThrow(/SMTP_FROM.*required when CREDENTIAL_DELIVERY_KIND=smtp/s);
  });
});

describe('config.ts: the wrapper that makes a schema failure readable', () => {
  it('a schema-level rejection is reported with its key and the startup sentence', () => {
    // The wrapper is what an operator actually sees. If it ever stopped naming
    // the key, a refusal would become "invalid configuration" and nothing
    // more — which is a support call rather than a fix.
    expect(() => loadConfig({ ...MERCHANT_PROD, PORT: '70000' })).toThrow(/Invalid configuration \(fails fast at startup\)/);
    // `/PORT/` alone would also match `SUPPORT_SESSION_MAX_MINUTES` (review
    // of #79), so the key is pinned with its separator.
    expect(() => loadConfig({ ...MERCHANT_PROD, PORT: '70000' })).toThrow(/\bPORT:/);
  });
});

describe('config.ts: the schema floor has an ordinal to compare against', () => {
  it('schemaFloor() returns the ordinal of the pinned migration, so a constant without one cannot pass unnoticed', () => {
    // `schemaFloor()` THROWS when `REQUIRED_SCHEMA_MIGRATION` has no leading
    // ordinal. That branch is only reachable by editing the constant — which
    // is precisely the edit this assertion catches, because the throw would
    // make it red.
    //
    // The review of #79 was right that the first form of this test asserted
    // `schemaFloor() === migrationOrdinal(REQUIRED_SCHEMA_MIGRATION)`, which is
    // the implementation restated: both sides came from the same parse, so a
    // defect in that parse stayed green here. The ordinal is now derived by the
    // TEST's own regex, so the two sides are independent and a parse that
    // started disagreeing with the file name would redden.
    const pinned = /^(\d{4})_/.exec(REQUIRED_SCHEMA_MIGRATION);
    expect(pinned, `REQUIRED_SCHEMA_MIGRATION ${REQUIRED_SCHEMA_MIGRATION} must open with a four-digit ordinal`).not.toBeNull();
    const floor = schemaFloor();
    expect(Number.isSafeInteger(floor)).toBe(true);
    expect(floor).toBe(Number(pinned?.[1]));
    // And it is the ordinal of a migration that EXISTS, not merely a number:
    // `migrationOrdinal` is the implementation's own reading, kept here as a
    // cross-check of the two parses rather than as the claim itself.
    expect(migrationOrdinal(REQUIRED_SCHEMA_MIGRATION)).toBe(floor);
  });

  it('migrationOrdinal refuses a name with no leading ordinal (negative control)', () => {
    expect(migrationOrdinal('phase4_rls.sql')).toBeNull();
    expect(migrationOrdinal('')).toBeNull();
    expect(migrationOrdinal('0086_phase4_rls_quals_once_per_query.sql')).toBe(86);
  });
});
