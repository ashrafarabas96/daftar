import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';
import { TokenService } from '../apps/api/src/modules/auth/tokens';

/**
 * SEC-01 — the worker process must not be able to mint an access token in any
 * merchant's name.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
 *
 * It proves the CONFIGURATION defect and the CRYPTOGRAPHIC edge:
 *
 *   1. `loadConfig` accepts `PROCESS_MODE=worker` together with `JWT_SECRET`
 *      or `JWT_KEYS` — in production and outside it. Nothing refuses the
 *      session signing key to the one process that has no session authority.
 *   2. From exactly that configuration, `TokenService` mints an HS256 access
 *      token for any `(userId, sessionId)` the caller chooses, and the
 *      merchant API's OWN verifier — the same class, built from the merchant
 *      configuration carrying the same secret — accepts it.
 *
 * It does NOT prove a completed privilege escalation, and must not be read as
 * one. After `verifyAccessToken` the request still passes
 * `apps/api/src/common/guards.ts:68` → `auth.service.ts:336-338`, which
 * requires a LIVE `users JOIN sessions` row, and the `daftar_worker` role is
 * granted neither table. Measuring that is a live-database question and is
 * NOT_RUN here (this lane has no PostgreSQL by design). So SEC-01 is a
 * least-privilege and defence-in-depth defect: the worker holds a key whose
 * authority it has no business holding, and the only thing standing between
 * that key and a forged session is a database grant in another file.
 *
 * NO SECRET IN THE REPOSITORY: every key below is either generated at run
 * time (`randomBytes`) or a declared test value with no authority anywhere
 * outside this file, on the pattern the repository already uses.
 */

/** A worker environment that is otherwise complete and correct, production. */
const WORKER_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'worker',
  WORKER_DATABASE_URL: 'postgresql://daftar_worker:x@db/daftar',
  CREDENTIAL_PAYLOAD_KEY: randomBytes(32).toString('base64'),
  CREDENTIAL_DELIVERY_KIND: 'smtp',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  SMTP_FROM: 'no-reply@daftar.example',
};

/** The same, outside production — where the dev conveniences apply. */
const WORKER_DEV: NodeJS.ProcessEnv = { ...WORKER_PROD, NODE_ENV: 'development' };

const SESSION_SECRET = 'sec01-session-signing-secret-32-chars-or-more';
const SESSION_KEYS = JSON.stringify([{ kid: 'k1', secret: SESSION_SECRET, status: 'active' }]);

/** A merchant API that legitimately holds the same session key. */
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
  JWT_SECRET: SESSION_SECRET,
  REDIS_URL: 'redis://redis:6379',
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
  // A production merchant API refuses local disk storage, so the media row is
  // part of "otherwise complete and correct" — not of this card.
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('SEC-01: PROCESS_MODE=worker is denied the session signing key', () => {
  // ── RED ─────────────────────────────────────────────────────────────────
  // Before the remedy lands in `apps/api/src/config.ts` these three fail.

  it('RED a-1: a production worker carrying JWT_SECRET is REFUSED at startup', () => {
    expect(() => loadConfig({ ...WORKER_PROD, JWT_SECRET: SESSION_SECRET })).toThrow(/JWT_SECRET.*must NOT be set in PROCESS_MODE=worker/s);
  });

  it('RED a-2: a production worker carrying JWT_KEYS is REFUSED at startup', () => {
    expect(() => loadConfig({ ...WORKER_PROD, JWT_KEYS: SESSION_KEYS })).toThrow(/JWT_KEYS.*must NOT be set in PROCESS_MODE=worker/s);
  });

  it('RED a-3: and OUTSIDE production too — the denial is a property of the mode, not of NODE_ENV', () => {
    // This is the control that proves the denial sits BEFORE the production
    // gate in `config.ts` (`if (c.NODE_ENV !== 'production') return;`). A
    // block written after that gate would pass a-1 and a-2 by accident
    // rather than by denial — a silent false positive (RULE-11).
    expect(() => loadConfig({ ...WORKER_DEV, JWT_SECRET: SESSION_SECRET })).toThrow(/JWT_SECRET.*must NOT be set in PROCESS_MODE=worker/s);
    expect(() => loadConfig({ ...WORKER_DEV, JWT_KEYS: SESSION_KEYS })).toThrow(/JWT_KEYS.*must NOT be set in PROCESS_MODE=worker/s);
  });

  it('RED a-4: a worker configured through loadConfig cannot mint a token the merchant API accepts', async () => {
    // The whole exploit, assembled from the configuration the worker is
    // allowed to hold — no planting, no private import, nothing the worker
    // process does not already have.
    let workerConfig: ReturnType<typeof loadConfig> | undefined;
    let refusal: unknown;
    try {
      workerConfig = loadConfig({ ...WORKER_PROD, JWT_SECRET: SESSION_SECRET });
    } catch (e) {
      // The remedy has landed: the worker never obtains a config with the
      // session key, so there is no ring to sign with. That is the fix.
      refusal = e;
      workerConfig = undefined;
    }
    if (workerConfig === undefined) {
      // Assert what was refused and why, rather than `expect(true).toBe(true)`.
      // A tautology here would keep this test green against ANY startup
      // failure — a typo in the worker environment would read as the fix.
      expect(String((refusal as Error)?.message), 'the refusal names the variable and the mode').toMatch(/JWT_SECRET.*must NOT be set in PROCESS_MODE=worker/s);
      return;
    }

    // The worker holds the key ring. Mint for a user and session it invented.
    const forged = await new TokenService(workerConfig).signAccessToken('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa');

    // And the merchant API's own verifier accepts the signature.
    const api = new TokenService(loadConfig(MERCHANT_PROD));
    const claims = await api.verifyAccessToken(forged);

    // Reaching here IS the defect. The assertion below therefore fails on
    // purpose, and its message carries the evidence: the API accepted a token
    // the worker minted. (What the API does NEXT — the live `users JOIN
    // sessions` check — is NOT_RUN in this lane and is a database grant, not
    // a cryptographic boundary.)
    expect(
      claims,
      `SEC-01: the worker minted an access token for sub=${claims.sub} sid=${claims.sid} and the merchant API's verifier accepted it`,
    ).toBeUndefined();
  });

  // ── NEGATIVE CONTROLS ───────────────────────────────────────────────────
  // Each one proves the remedy denies the KEY and not the mode, the process
  // or the test harness. They are green before the remedy and must stay green
  // after it: a remedy that turns any of them red is too wide.

  it('b-1: a correct worker WITHOUT any JWT variable still starts — production and dev', () => {
    expect(() => loadConfig(WORKER_PROD)).not.toThrow();
    expect(() => loadConfig(WORKER_DEV)).not.toThrow();
  });

  it('b-2: merchant-api in production still REQUIRES and accepts the session key', () => {
    expect(() => loadConfig(MERCHANT_PROD)).not.toThrow();
    const { JWT_SECRET: _j, ...noJwt } = MERCHANT_PROD;
    expect(() => loadConfig(noJwt)).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...noJwt, JWT_KEYS: SESSION_KEYS })).not.toThrow();
  });

  it('b-3: PROCESS_MODE=all outside production still accepts the session key', () => {
    // `all` composes the HTTP runtime, which cannot work without the key, and
    // `all` is already forbidden in production (`config.ts` §10). So the
    // remedy deliberately leaves `all` alone, and the whole test harness —
    // which runs as `all` with JWT_SECRET set — keeps working.
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        PROCESS_MODE: 'all',
        APP_DATABASE_URL: 'postgresql://daftar_app:x@localhost/daftar',
        JWT_SECRET: SESSION_SECRET,
      }),
    ).not.toThrow();
  });

  it('b-4: the reconciler denial is untouched — the pattern this remedy copies', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        PROCESS_MODE: 'reconciler',
        RECONCILER_DATABASE_URL: 'postgresql://daftar_reconciler:x@db/daftar',
        JWT_SECRET: SESSION_SECRET,
      }),
    ).toThrow(/JWT_SECRET.*must NOT be set in PROCESS_MODE=reconciler/s);
  });
});
