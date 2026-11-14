import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';

/**
 * §31 of `apps/api/src/config.ts`: ACTUAL PRINCIPALS MUST DIFFER — two database
 * roles may not be the same credential. NOTHING asserted it, in any lane.
 *
 * WHY THIS FILE EXISTS, MEASURED RATHER THAN READ. `DR-145` applies to every
 * guard over a file L4 owns, and a guard is proved by PLANTING, not by reading
 * the test that looks like it covers it. Four missing-refusal seeds went into
 * `config.ts` one at a time (the whole unit lane run against each, the tree
 * proved green first — 29 files / 246 cases — and restored byte for byte
 * after):
 *
 *   AC  `TRUST_PROXY=true` no longer refused in production  -> unit lane GREEN
 *   AD  accounting key may equal the provisioning key       -> unit lane GREEN
 *   AE  provisioning key may be under 32 bytes              -> unit lane GREEN
 *   AF  two DB principals may share one credential          -> unit lane GREEN
 *
 * Four greens are not four gaps, and saying so would be the overstatement this
 * file exists to avoid. Three of them ARE covered — by laws that cannot run
 * outside CI, since their lanes boot a database (`ensurePostgres`, so `NOT_RUN`
 * on a developer machine, never `PASS`):
 *
 *   AC  `tests/security/p3c-legacy-trust-proxy.test.ts:59` pins the refusal's
 *       own message text
 *   AD  `tests/integration/assertion-key-separation.test.ts:114`
 *   AE  `tests/integration/production-providers.test.ts:212` plants an 8-byte
 *       key and expects `/at least 32 bytes/`
 *
 * AF is the one with NO law anywhere: `grep` for its message, for "every DB
 * principal", and for the duplicate claim over `tests/**`, `tests-unit/**` and
 * `packages/**` returns nothing. The same probe finds the other three by name,
 * so the zero is a measurement and not a blind spot (`RULE-11`).
 *
 * WHY IT IS NOT COSMETIC. The whole point of these roles is that a compromise
 * of one does not reach the others: the resolver reads tenancy, the app reads a
 * business's ledger, identity holds auth credentials. Alias two of them to one
 * credential by a copy-paste in a deployment's environment and every one of
 * those boundaries is gone — while the process starts, serves, and reports
 * nothing. That is a silent collapse of privilege separation, which is the
 * class of defect a startup refusal exists for.
 *
 * NO SECRET HERE: every URL is an obvious placeholder with no authority
 * anywhere outside this file, and every key is `Buffer.alloc`-filled — the
 * pattern `tests-unit/config-production-refusals.test.ts` already uses.
 *
 * WHO MOVES THIS EXPECTATION. The set of principals below changes in the SAME
 * commit that changes the `urls` map in `config.ts` §31, by the owner of
 * `config.ts` (L4), and only when a principal is deliberately taken out of the
 * separation set. A lane that finds this file red without having decided such a
 * removal has found a defect, not a stale expectation.
 */

/**
 * A merchant API that is otherwise complete and correct, in production.
 *
 * Repeated from `tests-unit/config-production-refusals.test.ts` deliberately,
 * for the reason that file states: a shared fixture would tie two cards'
 * suites together, so that a variable one card needs would silently change
 * what the other measures.
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
  CORS_ORIGINS: 'https://app.example.com',
};

describe('§31: two database roles may not be one credential', () => {
  // DUP-0. The positive control comes first and it is not a formality: without
  // it, every refusal below could be the fixture failing for a reason this
  // file is not about, and each would read as a pass.
  it('POSITIVE CONTROL: the fixture itself starts, with distinct principals', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD })).not.toThrow();
  });

  // DUP-A. The pair no OTHER refusal covers. `config.ts` names three role
  // pairs explicitly (platform vs app `:472`, identity `:494`, provisioner
  // `:522`); app-vs-resolver is covered by §31 ALONE, so it is the pair that
  // measures §31 rather than its neighbours.
  it('REFUSES the app role and the resolver role sharing one credential', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL })).toThrow(/RESOLVER_DATABASE_URL/);
    expect(() => loadConfig({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL })).toThrow(/duplicates APP_DATABASE_URL/);
  });

  // DUP-B. A second uncovered pair, so the claim is about the SET and not
  // about one favoured variable: a law that only ever reddens on
  // `RESOLVER_DATABASE_URL` would pass a §31 that had quietly shrunk to one
  // comparison.
  it('REFUSES the identity role and the resolver role sharing one credential', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL })).toThrow(/duplicates IDENTITY_DATABASE_URL/);
  });

  // DUP-C. The refusal names the SECOND variable and reports the first, which
  // is what makes the message actionable in a deployment: the operator learns
  // which line of their environment to change, not merely that something
  // collides.
  it('the refusal names the colliding variable and the one it duplicates', () => {
    let message = '';
    try {
      loadConfig({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('RESOLVER_DATABASE_URL');
    expect(message).toContain('duplicates APP_DATABASE_URL');
    expect(message).toContain('every DB principal must use distinct credentials');
  });

  // DUP-D. THE OTHER FACE OF THE BOUNDARY (`DR-145`): a change that §31 is NOT
  // about must NOT redden this file. A different password on the same host and
  // database is a DIFFERENT principal — §31 compares credentials, and reading
  // it as "no two roles may share a host" would refuse every real single-server
  // deployment.
  it('NEGATIVE CONTROL: distinct credentials on the same host and database still start', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:y@db/daftar' })).not.toThrow();
  });
});

/**
 * MEASURED, AND RECORDED RATHER THAN CHANGED: `PROVISIONER_DATABASE_URL` is
 * NOT a member of the §31 `urls` map, although `:522` refuses it as a role
 * distinct from app and platform. So a provisioner credential equal to the
 * IDENTITY or RESOLVER credential is refused by nothing. This file does not
 * assert that, because an assertion would be a claim about what `config.ts`
 * SHOULD do, and that is a change to a production refusal rather than a law
 * over the one it makes. It is written here, where the next reader of §31 is
 * looking, and it is in L4's queue for the pilot's security review — a law and
 * the refusal it needs ship together or not at all.
 */
