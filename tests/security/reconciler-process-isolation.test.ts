/**
 * THE RECONCILER PROCESS, AND WHAT IT CANNOT REACH (P2-S8 §6, §7, §29, §31).
 *
 * `0051` decides what the reconciliation CREDENTIAL may do. This file decides
 * what the reconciliation PROCESS may hold, which is a different question with
 * a different failure mode: a process can be perfectly scoped at the database
 * and still be the place an attacker goes to find the SMTP password.
 *
 * DAFTAR's answer is that delivery authority is not financial authority. The
 * worker already carries the credential decryption key ring, the SMTP
 * credential and the outbox relay; the reconciler reads every business's
 * ledger. Putting them in one process would make one compromise both, so they
 * are two processes, and the separation is asserted twice over:
 *
 *   at CONFIGURATION — the reconciler's environment REFUSES to carry another
 *   process's secret, in every environment rather than only in production;
 *   at COMPOSITION — the module does not contain the providers, so there is
 *   nothing to resolve even for code that asked.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { ReconcilerModule } from '../../apps/api/src/app/reconciler.module';
import { WorkerModule } from '../../apps/api/src/app/worker.module';
import { loadConfig } from '../../apps/api/src/config';
import { Database } from '../../apps/api/src/infra/database';
import { CredentialDeliveryWorker } from '../../apps/api/src/modules/delivery/delivery-worker.service';
import { CredentialPayloadProtector } from '../../apps/api/src/modules/delivery/credential-protector';
import { CredentialDeliveryEnqueuer } from '../../apps/api/src/modules/delivery/credential-enqueuer.service';
import { OutboxPublisher } from '../../apps/api/src/modules/outbox/publisher';
import { TokenService } from '../../apps/api/src/modules/auth/tokens';
import { AuthService } from '../../apps/api/src/modules/auth/auth.service';
import { AccountingAssertionMinterService } from '../../apps/api/src/modules/accounting/accounting-assertion.minter';
import { AccountingReconciliationWorker } from '../../apps/api/src/modules/accounting/accounting-reconciliation.worker';
import { AccountingReconciliationService } from '../../apps/api/src/modules/accounting/accounting-reconciliation.service';
import { appDbUrl, ensurePostgres, identityDbUrl, platformDbUrl, provisionerDbUrl, reconcilerDbUrl, resolverDbUrl, workerDbUrl } from '../helpers/test-app';

const JWT = 'test-secret-key-with-at-least-32-characters!';
const KEY = Buffer.alloc(32, 7).toString('base64');

const contexts: INestApplicationContext[] = [];
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.close();
});

function absent(get: () => unknown): boolean {
  try {
    get();
    return false;
  } catch {
    return true;
  }
}

/** Every secret the reconciler must never receive (§7), with a plausible value. */
const FORBIDDEN_FOR_RECONCILER: Record<string, string> = {
  APP_DATABASE_URL: appDbUrl,
  PLATFORM_DATABASE_URL: platformDbUrl,
  IDENTITY_DATABASE_URL: identityDbUrl,
  RESOLVER_DATABASE_URL: resolverDbUrl,
  PROVISIONER_DATABASE_URL: provisionerDbUrl,
  WORKER_DATABASE_URL: workerDbUrl,
  PROVISIONING_ASSERTION_KEY: KEY,
  ACCOUNTING_ASSERTION_KEY: KEY,
  CREDENTIAL_PAYLOAD_KEY: KEY,
  CREDENTIAL_PAYLOAD_KEYS: JSON.stringify([{ version: 1, key: KEY, status: 'active' }]),
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.test',
  CREDENTIAL_KMS_TOKEN: 'a'.repeat(40),
  SMTP_URL: 'smtp://user:pw@mail.example.test:587',
  JWT_SECRET: JWT,
  JWT_KEYS: JSON.stringify([{ kid: 'k1', secret: JWT, status: 'active' }]),
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 's3-secret-example',
};

const reconcilerEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  PROCESS_MODE: 'reconciler',
  RECONCILER_DATABASE_URL: reconcilerDbUrl,
  PORT: '0',
  ...extra,
});

describe('the reconciler environment refuses every other process secret (§7, §29)', () => {
  it('starts from the reconciler DB URL alone', () => {
    const config = loadConfig(reconcilerEnv());
    expect(config.PROCESS_MODE).toBe('reconciler');
    expect(config.RECONCILER_DATABASE_URL).toBe(reconcilerDbUrl);
  });

  it('refuses to start without it, rather than falling back to another credential', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PROCESS_MODE: 'reconciler', PORT: '0' })).toThrow(/RECONCILER_DATABASE_URL/);
  });

  /**
   * One case per secret, so a failure names the secret that leaked rather
   * than telling a reviewer that "something" was wrong.
   */
  it.each(Object.keys(FORBIDDEN_FOR_RECONCILER))('refuses %s', (name) => {
    const value = FORBIDDEN_FOR_RECONCILER[name];
    expect(value).toBeDefined();
    expect(() => loadConfig(reconcilerEnv({ [name]: value as string }))).toThrow(new RegExp(name));
  });

  /**
   * The converse, and the one that protects §15: no other process may hold
   * the credential that reads every business's ledger.
   */
  it.each(['merchant-api', 'platform-api', 'worker'])('%s refuses RECONCILER_DATABASE_URL', (mode) => {
    const base: Record<string, string> = {
      NODE_ENV: 'test',
      PROCESS_MODE: mode,
      PORT: '0',
      RECONCILER_DATABASE_URL: reconcilerDbUrl,
      JWT_SECRET: JWT,
    };
    if (mode === 'worker') base['WORKER_DATABASE_URL'] = workerDbUrl;
    else base['APP_DATABASE_URL'] = appDbUrl;
    expect(() => loadConfig(base)).toThrow(/RECONCILER_DATABASE_URL/);
  });

  /**
   * The separation is NOT a production-only rule. A staging box or a laptop
   * that runs the reconciler beside the delivery secrets teaches the habit
   * that production then inherits from a deployment template.
   */
  it('applies in development as well as in production', () => {
    expect(() => loadConfig({ ...reconcilerEnv({ SMTP_URL: 'smtp://x@y.test' }), NODE_ENV: 'development' })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ ...reconcilerEnv({ SMTP_URL: 'smtp://x@y.test' }), NODE_ENV: 'production' })).toThrow(/SMTP_URL/);
  });
});

describe('the reconciler composition holds nothing else (§6, §31)', () => {
  it('has the reconciliation pass, and no delivery, identity, outbox or minting provider', async () => {
    await ensurePostgres();
    const config = loadConfig(reconcilerEnv());
    const ref = await Test.createTestingModule({ imports: [ReconcilerModule.register({ config })] }).compile();
    const ctx = await ref.init();
    contexts.push(ctx);

    // What it IS.
    expect(ctx.get(AccountingReconciliationWorker)).toBeDefined();
    expect(ctx.get(AccountingReconciliationService)).toBeDefined();

    // What it is NOT — asserted at the container, not at the call site.
    for (const provider of [
      CredentialDeliveryWorker,
      CredentialPayloadProtector,
      CredentialDeliveryEnqueuer,
      OutboxPublisher,
      TokenService,
      AuthService,
      AccountingAssertionMinterService,
    ]) {
      expect(
        absent(() => ctx.get(provider)),
        provider.name,
      ).toBe(true);
    }
    for (const token of ['CREDENTIAL_DELIVERY', 'OUTBOX_SINK', 'CREDENTIAL_ENCRYPTOR', 'OBJECT_STORAGE', 'RATE_LIMITER']) {
      expect(
        absent(() => ctx.get(token)),
        token,
      ).toBe(true);
    }
  });

  it('opens the reconciler pool and no other, and is authenticated as daftar_reconciler (§30)', async () => {
    await ensurePostgres();
    const config = loadConfig(reconcilerEnv());
    const ref = await Test.createTestingModule({ imports: [ReconcilerModule.register({ config })] }).compile();
    const ctx = await ref.init();
    contexts.push(ctx);
    const db = ctx.get(Database);

    const principal = await db.withReconcilerTransaction(async (c) => {
      const { rows } = await c.query<{ u: string }>('SELECT current_user AS u');
      return rows[0]?.u;
    });
    expect(principal).toBe('daftar_reconciler');

    // Every other boundary in the same object is unreachable, because the
    // pool behind it was never opened. Not a guard that could be removed —
    // there is no connection to make.
    for (const [name, call] of [
      ['app', () => db.withTransaction({}, async () => undefined)],
      ['platform', () => db.withPlatformTransaction(async () => undefined)],
      ['identity', () => db.withIdentityTransaction(async () => undefined)],
      ['resolver', () => db.withResolverTransaction(async () => undefined)],
      ['worker', () => db.withWorkerTransaction(async () => undefined)],
      ['provisioner', () => db.withProvisionerTransaction(null, null, async () => undefined)],
    ] as const) {
      await expect(call(), name).rejects.toThrow(/pool is not configured/);
    }
  });

  it('the WORKER process cannot reach reconciliation at all (§15)', async () => {
    await ensurePostgres();
    const config = loadConfig({
      NODE_ENV: 'test',
      PROCESS_MODE: 'worker',
      WORKER_DATABASE_URL: workerDbUrl,
      CREDENTIAL_PAYLOAD_KEY: KEY,
      PORT: '0',
    });
    const ref = await Test.createTestingModule({ imports: [WorkerModule.register({ config })] }).compile();
    const ctx = await ref.init();
    contexts.push(ctx);

    expect(absent(() => ctx.get(AccountingReconciliationWorker))).toBe(true);
    expect(absent(() => ctx.get(AccountingReconciliationService))).toBe(true);
    await expect(ctx.get(Database).withReconcilerTransaction(async () => undefined)).rejects.toThrow(/pool is not configured/);
  });
});
