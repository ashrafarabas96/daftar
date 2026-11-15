/**
 * THE LAW: §31 refuses one CREDENTIAL used twice, not one STRING written twice.
 *
 * Source of the finding: the independent review of #110, carried to L4 as
 * `.local-context/cards/L4_CONFIG_URL_LITERAL_COMPARE_CARD_AR.md`. The card
 * said plainly that it had NOT been measured. It was then measured on the
 * merged `main` (`0af68e81`), with an otherwise complete and correct
 * production `merchant-api` fixture that STARTED as the control — so every
 * result below is the spelling's doing and not the fixture's. Of eight
 * spellings of ONE credential, only the byte-identical one was refused:
 *
 *   byte-identical            -> REFUSED
 *   `@db:5432/`               -> started
 *   `?sslmode=require`        -> started
 *   a trailing slash          -> started
 *   `postgres://`             -> started
 *   `@DB/`                    -> started
 *   password as `%78`         -> started
 *   role as `daftar_%61pp`    -> started
 *
 * Seven of eight. Each of them aliases two roles onto one principal while the
 * process starts and reports nothing.
 *
 * ── WHAT THIS FILE PINS, AND WHY IN THIS SHAPE ──────────────────────────────
 *
 * Normalizing is a WIDENING: every element added to `dbPrincipalKey` shrinks
 * the space of configurations the loader accepts, so an element that goes too
 * far refuses a deployment that is correct. A law that only proved refusals
 * would therefore be half a law — it would pass just as happily over a
 * `dbPrincipalKey` that returned a constant and refused everything.
 *
 * So every element gets TWO arms: a positive one that must be refused, and a
 * NEGATIVE CONTROL that must still start. The negative controls are the half
 * that makes this safe to ship, and they are listed with the element each one
 * defends.
 *
 * ── WHO MOVES THIS ─────────────────────────────────────────────────────────
 *
 * L4, in the same commit as `dbPrincipalKey`. Removing an element from that
 * function reddens its positive arm here and nothing else; adding one needs
 * its own pair of arms in this file, in that same commit.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';

const APP = 'postgresql://daftar_app:x@db/daftar';

/** The §31 clause, which names both fields. */
const DUP = /IDENTITY_DATABASE_URL: duplicates APP_DATABASE_URL — every DB principal must use distinct credentials/;

/**
 * A production `merchant-api` that is otherwise complete and correct.
 *
 * Repeated from `tests-unit/config-production-refusals.test.ts` deliberately,
 * for the reason that file states: a shared fixture would tie two cards'
 * suites together, so a variable one card needs would silently change what the
 * other measures.
 */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: APP,
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

/** The loader, with `IDENTITY_DATABASE_URL` set to one spelling. */
const withIdentity = (url: string): NodeJS.ProcessEnv => ({ ...MERCHANT_PROD, IDENTITY_DATABASE_URL: url });

describe('§31 compares credentials, not strings', () => {
  it('POSITIVE CONTROL: the fixture itself starts, with four distinct credentials', () => {
    // Without this arm, every refusal below could be the fixture's own doing.
    expect(() => loadConfig({ ...MERCHANT_PROD })).not.toThrow();
  });

  // ── THE SEVEN SPELLINGS THAT WERE MEASURED PASSING ON `main` ──────────────
  const refused: readonly { readonly element: string; readonly url: string; readonly what: string }[] = [
    { element: '3 port', url: 'postgresql://daftar_app:x@db:5432/daftar', what: "PostgreSQL's default port written out" },
    { element: 'query', url: 'postgresql://daftar_app:x@db/daftar?sslmode=require', what: 'a connection parameter appended' },
    { element: '5 path', url: 'postgresql://daftar_app:x@db/daftar/', what: 'a trailing slash on the database path' },
    { element: '1 scheme', url: 'postgres://daftar_app:x@db/daftar', what: 'the `postgres://` spelling of the same scheme' },
    { element: '1 scheme', url: 'POSTGRESQL://daftar_app:x@db/daftar', what: 'the scheme in upper case' },
    { element: '2 host', url: 'postgresql://daftar_app:x@DB/daftar', what: 'the host in another case' },
    { element: '4 decode', url: 'postgresql://daftar_app:%78@db/daftar', what: 'the password percent-encoded (`%78` is `x`)' },
    { element: '4 decode', url: 'postgresql://daftar_%61pp:x@db/daftar', what: 'the role percent-encoded (`%61` is `a`)' },
  ];

  for (const { element, url, what } of refused) {
    it(`refuses ${what} — element ${element}`, () => {
      // The MESSAGE, not merely "it threw": a refusal for some other reason
      // would pass an assertion that only checked that something was thrown.
      expect(() => loadConfig(withIdentity(url))).toThrow(DUP);
    });
  }

  it('refuses the byte-identical spelling too, which is what held before this law', () => {
    expect(() => loadConfig(withIdentity(APP))).toThrow(DUP);
  });

  // ── THE OTHER HALF: ONE NEGATIVE CONTROL PER ELEMENT ─────────────────────
  //
  // Each of these is a configuration a real deployment can have, and each
  // would be refused by an element that normalized more than it should. A
  // `dbPrincipalKey` that collapsed everything would redden exactly here.
  const started: readonly { readonly element: string; readonly url: string; readonly what: string }[] = [
    {
      element: '2 host',
      url: 'postgresql://daftar_app:x@identity-db/daftar',
      what: 'a different host — no DNS is resolved, so two names stay two principals',
    },
    {
      element: '3 port',
      url: 'postgresql://daftar_app:x@db:5433/daftar',
      what: 'a NON-default port — two servers on one host is a real deployment',
    },
    {
      element: '5 path',
      url: 'postgresql://daftar_app:x@db/daftar_identity',
      what: 'a different database on the same host',
    },
    {
      element: '4 decode',
      url: 'postgresql://daftar_app:%79@db/daftar',
      what: 'a different password after decoding (`%79` is `y`) — a rotation must not be refused',
    },
    {
      element: '4 decode',
      url: 'postgresql://daftar_identity:x@db/daftar',
      what: 'a different role with the same password — the roster this file is about',
    },
    {
      element: '1 scheme',
      url: 'mysql://daftar_app:x@db/daftar',
      what: 'a genuinely different scheme — only `postgres`/`postgresql` are one',
    },
  ];

  for (const { element, url, what } of started) {
    it(`NEGATIVE CONTROL: ${what} — defends element ${element}`, () => {
      expect(() => loadConfig(withIdentity(url))).not.toThrow();
    });
  }

  // ── THE DOUBLE-ENCODING RULING, WRITTEN DOWN RATHER THAN LEFT TO CHANCE ───
  it('RULES: a double-encoded escape is a DIFFERENT secret, so it starts', () => {
    // `%2578` is the literal text `%78`, not `x`. Decoding once keeps them
    // apart; decoding repeatedly would merge two different passwords and
    // refuse a correct deployment. This arm fixes the choice so that a future
    // "just decode until it stops changing" cannot slip in unnoticed.
    expect(() => loadConfig(withIdentity('postgresql://daftar_app:%2578@db/daftar'))).not.toThrow();
  });

  it('RULES: a malformed escape does not crash the check, and still compares', () => {
    // `decodeURIComponent('%zz')` throws. The refusal must not become a
    // TypeError out of the middle of the loader — and the value must still
    // compare, so the identical malformed string is refused.
    const env = { ...MERCHANT_PROD, APP_DATABASE_URL: 'postgresql://daftar_app:%zz@db/daftar' };
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'postgresql://daftar_app:%zz@db/daftar' })).toThrow(DUP);
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:%zz@db/daftar' })).not.toThrow();
  });

  it('RULES: a value that is not a URL at all still compares as text', () => {
    // The fallback keeps the pre-existing behaviour instead of making an
    // unparseable value match everything — or nothing.
    const env = { ...MERCHANT_PROD, APP_DATABASE_URL: 'not-a-url' };
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'not-a-url' })).toThrow(DUP);
  });
});
