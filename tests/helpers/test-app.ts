import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import supertest from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../apps/api/src/app/app.module';
import { loadConfig, type AppConfig } from '../../apps/api/src/config';
import { runMigrations } from '../../apps/api/src/infra/migrate';
import type { CredentialDelivery } from '../../apps/api/src/modules/auth/tokens';
import type { OutboxSink } from '../../apps/api/src/modules/outbox/publisher';
import type { CredentialPayloadEncryptor } from '../../apps/api/src/modules/delivery/credential-protector';
import { CredentialDeliveryWorker } from '../../apps/api/src/modules/delivery/delivery-worker.service';
import { mintProvisioningAssertion, type ProvisioningKind } from '../../apps/api/src/infra/provisioning-assertion';
import { mintAccountingAssertion, type AccountingAssertionClaims, type AccountingAssertionKey } from '../../packages/accounting/src/assertion';
import { ensureEmbeddedPgBinariesExecutable } from '../../scripts/ensure-embedded-pg-binaries';

export const PG_DIR = process.env['PG_DIR'] ?? '/tmp/daftar-pg-shared';
export const PG_PORT = Number(process.env['PG_PORT'] ?? 55432);
export const PG_USER = 'postgres';
export const PG_PASSWORD = 'postgres';
export const APP_DB_PASSWORD = 'test_app_password_123';
export const PLATFORM_DB_PASSWORD = 'test_platform_password_123';
export const WORKER_DB_PASSWORD = 'test_worker_password_123';
export const RESOLVER_DB_PASSWORD = 'test_resolver_password_123';
export const IDENTITY_DB_PASSWORD = 'test_identity_password_123';
export const PROVISIONER_DB_PASSWORD = 'test_provisioner_password_123';
export const RECONCILER_DB_PASSWORD = 'test_reconciler_password_123';
/** Deployment, not runtime: the schema-migration principal (P2-S1 portability). */
export const MIGRATOR_DB_PASSWORD = 'test_migrator_password_123';
/** Blocker 1: the HMAC key the API mints provisioning assertions with; installed in the DB by ensurePostgres(). */
export const PROVISIONING_ASSERTION_KEY_B64 = Buffer.from('test-provisioning-assertion-key-32-bytes!!').subarray(0, 32).toString('base64');
export const PROVISIONING_ASSERTION_KID = 'v1';
/** Mint a valid assertion exactly as the API does (tests that PROVE the boundary, not bypass it). */
export function mintTestAssertion(actorUserId: string, kind: ProvisioningKind, now: Date = new Date(), ttlSeconds = 60): string {
  return mintProvisioningAssertion(
    { kid: PROVISIONING_ASSERTION_KID, secret: Buffer.from(PROVISIONING_ASSERTION_KEY_B64, 'base64') },
    actorUserId,
    kind,
    now,
    ttlSeconds,
  );
}

/**
 * P2-S3: the accounting assertion key. DELIBERATELY different bytes from the
 * provisioning key — §19 makes equal secrets a production startup failure, and
 * a test fixture that shared one would quietly defeat the separation it is
 * supposed to prove.
 */
export const ACCOUNTING_ASSERTION_KEY_B64 = Buffer.from('test-accounting-assertion-key-32b!!!!!!!!').subarray(0, 32).toString('base64');
export const ACCOUNTING_ASSERTION_KID = 'acct1';

/**
 * The key both accounting assertion formats are signed with (P2-S5 §29).
 *
 * ONE secret, two cryptographic domains. The control format prefixes its MAC
 * preimage with `acctctl/1` and a newline; the posting format does not, and
 * cannot, because no posting preimage can contain those bytes.
 */
export function accountingAssertionKey(): AccountingAssertionKey {
  return { kid: ACCOUNTING_ASSERTION_KID, secret: Buffer.from(ACCOUNTING_ASSERTION_KEY_B64, 'base64') };
}

/** Mint an accounting assertion exactly as the merchant API would. */
export function mintTestAccountingAssertion(claims: AccountingAssertionClaims, now: Date = new Date(), ttlSeconds = 60): string {
  return mintAccountingAssertion(accountingAssertionKey(), claims, now, ttlSeconds);
}

export const dbUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const appDbUrl = `postgresql://daftar_app:${APP_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const platformDbUrl = `postgresql://daftar_platform:${PLATFORM_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const workerDbUrl = `postgresql://daftar_worker:${WORKER_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const resolverDbUrl = `postgresql://daftar_resolver:${RESOLVER_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const identityDbUrl = `postgresql://daftar_identity:${IDENTITY_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const provisionerDbUrl = `postgresql://daftar_provisioner:${PROVISIONER_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
export const reconcilerDbUrl = `postgresql://daftar_reconciler:${RECONCILER_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;
/** Never used by the API — only by the migration-portability proof. */
export const migratorDbUrl = `postgresql://daftar_migrator:${MIGRATOR_DB_PASSWORD}@localhost:${PG_PORT}/daftar`;

let pg: EmbeddedPostgres | null = null;

async function ping(): Promise<boolean> {
  const pool = new Pool({ connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres`, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function applyBootstrap(): Promise<void> {
  const bootstrap = (await readFile(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8'))
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD)
    .replaceAll('__PROVISIONER_DB_PASSWORD__', PROVISIONER_DB_PASSWORD)
    .replaceAll('__RECONCILER_DB_PASSWORD__', RECONCILER_DB_PASSWORD)
    .replaceAll('__MIGRATOR_DB_PASSWORD__', MIGRATOR_DB_PASSWORD);
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    await pool.query(bootstrap);
  } finally {
    await pool.end();
  }
}

/** The database side of the assertion key (0038) — what the ops job does with BOOTSTRAP_DATABASE_URL in production. */
async function installProvisioningKey(): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    await pool.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, [PROVISIONING_ASSERTION_KID, PROVISIONING_ASSERTION_KEY_B64]);
  } finally {
    await pool.end();
  }
}

/** The database side of the accounting assertion key (0044) — the platform-only ops command. */
async function installAccountingKey(): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);
  } finally {
    await pool.end();
  }
}

/**
 * Start (or reuse) a REAL PostgreSQL 18 instance and migrate a fresh schema.
 *
 * Consecutive suite runs share one data directory (PG_DIR). A previous run's
 * server may still be shutting down when the next one starts: its socket
 * already refuses connections while `postmaster.pid` is still held, so a naive
 * "ping, else start" would try to start a second postmaster in the same
 * directory and die with `lock file "postmaster.pid" already exists`. The
 * handshake below waits — bounded — for the directory to settle into one of
 * the two usable states (a server that answers, or no server at all) and
 * retries a start that loses that race.
 */
const START_ATTEMPTS = 12;
const SETTLE_DELAY_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True while a previous postmaster still owns the data directory. */
/**
 * Is the shared data directory actually held by a live postmaster?
 *
 * The file's presence alone is not the answer. `postmaster.pid` survives a
 * crash, a `kill -9` and — as happened here — a container restart, and a
 * directory guarded by a dead process's leftovers is not busy, it is littered.
 * The old check read the file's existence, so one abnormal exit made every
 * later run wait out its twelve attempts and then fail with "did not become
 * usable within 6s", forever, until somebody deleted the file by hand. A test
 * harness that cannot recover from a crash cannot report anything, and §3 of
 * the P2-S8 directive makes the harness part of the gate.
 *
 * So: read the postmaster's pid and ask the operating system whether it is
 * still there. Signal 0 checks existence and delivers nothing. `ESRCH` means
 * the process is gone and the file is stale. `EPERM` means it exists but
 * belongs to someone else, which is still held. An unreadable or malformed
 * file is treated as stale, because it cannot name a holder.
 */
export function pidFileHeld(dir: string = PG_DIR): boolean {
  const file = join(dir, 'postmaster.pid');
  if (!existsSync(file)) return false;

  let pid = Number.NaN;
  try {
    pid = Number.parseInt((readFileSync(file, 'utf8').split('\n')[0] ?? '').trim(), 10);
  } catch {
    return false; // unreadable: it names no holder
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true; // alive, not ours
    // ESRCH — the postmaster is gone. Clear its leftovers so a fresh start can
    // take the directory, which is the whole point of the check.
    rmSync(file, { force: true });
    return false;
  }
}

async function startOrReuse(): Promise<void> {
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    if (await ping()) return; // a usable server is already listening
    if (pidFileHeld()) {
      // Someone else owns the directory: either still starting or still stopping.
      await delay(SETTLE_DELAY_MS);
      continue;
    }
    ensureEmbeddedPgBinariesExecutable();
    pg = new EmbeddedPostgres({
      databaseDir: PG_DIR,
      user: PG_USER,
      password: PG_PASSWORD,
      port: PG_PORT,
      persistent: true,
    });
    if (!existsSync(join(PG_DIR, 'PG_VERSION'))) {
      await pg.initialise();
    }
    try {
      await pg.start();
      return;
    } catch (e) {
      pg = null;
      // Lost the race against a concurrent start: settle and re-evaluate.
      if (!/postmaster\.pid|already (exists|running)/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await delay(SETTLE_DELAY_MS);
    }
  }
  throw new Error(`PostgreSQL at ${PG_DIR} (port ${PG_PORT}) did not become usable within ${(START_ATTEMPTS * SETTLE_DELAY_MS) / 1000}s`);
}

export async function ensurePostgres(): Promise<void> {
  await startOrReuse();
  try {
    await (pg?.createDatabase('daftar') ?? Promise.resolve());
  } catch {
    // database already exists
  }
  if (!pg) {
    // Reused instance: make sure the database exists before bootstrapping it.
    const admin = new Pool({ connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres`, max: 1 });
    try {
      await admin.query('CREATE DATABASE daftar');
    } catch {
      // already exists
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
  // Bootstrap is idempotent; migrations apply only what is pending.
  await applyBootstrap();
  await runMigrations(dbUrl);
  await installProvisioningKey();
  await installAccountingKey();
}

let ownerPoolInstance: Pool | null = null;
export function ownerPool(): Pool {
  ownerPoolInstance ??= new Pool({ connectionString: dbUrl, max: 4 });
  return ownerPoolInstance;
}

export async function resetData(): Promise<void> {
  await ownerPool().query(`TRUNCATE
    audit_events, outbox_events, credential_deliveries, product_media, media, catalog_identifiers, product_translations, product_variants, products,
    category_translations, categories,
    business_invitations, member_branch_scopes, membership_roles, memberships,
    entitlement_overrides, business_entitlements, support_sessions,
    accounting_source_bindings, journal_lines, journal_entries,
    role_permissions, business_roles, accounts, warehouses, branches, businesses, tenant_memberships, tenants,
    platform_role_memberships, password_reset_tokens, session_refresh_tokens, sessions, users CASCADE`);
  // Plan registry is reference data with test-created versions — reset it to
  // the migration seed so provisioning defaults are deterministic.
  await ownerPool().query(`TRUNCATE plan_limits, plan_entitlements, plan_versions, plans CASCADE`);
  await ownerPool().query(`INSERT INTO plans (key, name) VALUES
    ('free','Free'), ('starter','Starter'), ('pro','Pro'), ('business','Business')`);
  await ownerPool().query(`INSERT INTO plan_versions (plan_key, version, state, trial_days)
    SELECT key, 1, 'DRAFT', 14 FROM plans`);
  await ownerPool().query(`INSERT INTO plan_limits (plan_version_id, limit_key, limit_value)
    SELECT pv.id, x.limit_key, x.limit_value
    FROM plan_versions pv
    JOIN (VALUES
      ('free','MAX_USERS',2),      ('free','MAX_BRANCHES',1),  ('free','MAX_PRODUCTS',100),
      ('starter','MAX_USERS',5),   ('starter','MAX_BRANCHES',3),('starter','MAX_PRODUCTS',1000),
      ('pro','MAX_USERS',25),      ('pro','MAX_BRANCHES',10),  ('pro','MAX_PRODUCTS',100000),
      ('business','MAX_USERS',100),('business','MAX_BRANCHES',50),('business','MAX_PRODUCTS',-1)
    ) AS x(plan_key, limit_key, limit_value) ON pv.plan_key = x.plan_key AND pv.version = 1`);
  await ownerPool().query(`INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled)
    SELECT pv.id, f.key,
      CASE
        WHEN pv.plan_key = 'business' THEN true
        WHEN pv.plan_key = 'pro' AND f.key IN ('MULTI_BRANCH','CUSTOM_ROLES','ADVANCED_REPORTS') THEN true
        WHEN pv.plan_key = 'starter' AND f.key = 'MULTI_BRANCH' THEN true
        ELSE false
      END
    FROM plan_versions pv CROSS JOIN features f
    WHERE pv.version = 1`);
  await ownerPool().query(`UPDATE plan_versions SET state = 'PUBLISHED' WHERE state = 'DRAFT'`);
}

let seq = 0;

/** Test fixture: grant a feature via entitlement override (platform-level). */
export async function grantFeature(businessId: string, actorUserId: string, featureKey: string, enabled = true): Promise<void> {
  await ownerPool().query(
    `INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value, reason, actor_user_id)
     VALUES ($1, $2, $3, 'test-fixture', $4)`,
    [businessId, featureKey, enabled, actorUserId],
  );
}

/** Test fixture: raise a plan limit via entitlement override (platform-level). */
export async function raiseLimit(businessId: string, actorUserId: string, limitKey: string, value: number): Promise<void> {
  await ownerPool().query(
    `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
     VALUES ($1, $2, $3, 'test-fixture', $4)`,
    [businessId, limitKey, value, actorUserId],
  );
}

export function uniqueEmail(): string {
  seq += 1;
  return `user-${Date.now()}-${seq}@test.daftar.local`;
}

export interface TestApp {
  app: INestApplication;
  request: ReturnType<typeof supertest>;
  worker: CredentialDeliveryWorker;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  delivery?: CredentialDelivery;
  outboxSink?: OutboxSink;
  /** Blocker 4 seam: the merchant-side credential encryptor (KMS bridge stand-in). */
  encryptor?: CredentialPayloadEncryptor;
  storage?: import('../../apps/api/src/infra/storage').ObjectStorage;
  /** P2-S8 §28 seam: a metrics recorder the test can read back. */
  metrics?: import('../../apps/api/src/infra/metrics').Metrics;
  /** P2-S8 §25 seam: a controllable clock for the daily reconciliation schedule. */
  reconciliationClock?: { now(): Date };
  /** Extra env applied on top of the test config (e.g. TRUST_PROXY, JWT_KEYS). */
  configOverrides?: Record<string, string>;
}

/** Registry of apps that have not been closed yet (see tests/helpers/setup.ts). */
const openApps = new Set<TestApp>();

export function openTestApps(): readonly TestApp[] {
  return [...openApps];
}

/** Close (and forget) every open app matching the predicate. Idempotent. */
export async function closeTestApps(predicate: (app: TestApp) => boolean): Promise<void> {
  for (const app of [...openApps]) {
    if (predicate(app)) await app.close();
  }
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  await ensurePostgres(); // each vitest fork is a fresh process — ping-reuse the shared instance
  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    APP_DATABASE_URL: appDbUrl,
    PLATFORM_DATABASE_URL: platformDbUrl,
    IDENTITY_DATABASE_URL: identityDbUrl,
    RESOLVER_DATABASE_URL: resolverDbUrl,
    WORKER_DATABASE_URL: workerDbUrl,
    PROVISIONER_DATABASE_URL: provisionerDbUrl,
    RECONCILER_DATABASE_URL: reconcilerDbUrl,
    PROVISIONING_ASSERTION_KEY: PROVISIONING_ASSERTION_KEY_B64,
    PROVISIONING_ASSERTION_KID,
    ACCOUNTING_ASSERTION_KEY: ACCOUNTING_ASSERTION_KEY_B64,
    ACCOUNTING_ASSERTION_KID,
    JWT_SECRET: 'test-secret-key-with-at-least-32-characters!',
    MEDIA_ROOT: '/tmp/daftar-test-media',
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'warn',
    PORT: '0',
    ...(options.configOverrides ?? {}),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config,
        ...(options.delivery ? { delivery: options.delivery } : {}),
        ...(options.outboxSink ? { outboxSink: options.outboxSink } : {}),
        ...(options.encryptor ? { encryptor: options.encryptor } : {}),
        ...(options.storage ? { storage: options.storage } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(options.reconciliationClock ? { reconciliationClock: options.reconciliationClock } : {}),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const request = supertest(app.getHttpServer());
  const testApp: TestApp = {
    app,
    request,
    worker: moduleRef.get(CredentialDeliveryWorker),
    close: async () => {
      if (!openApps.delete(testApp)) return; // already closed — idempotent
      await app.close();
    },
  };
  openApps.add(testApp);
  return testApp;
}
