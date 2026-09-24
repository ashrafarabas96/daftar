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

// The cluster's lifecycle lives in a framework-free module so that evidence
// tooling can start the same PostgreSQL without importing the application.
// Re-exported here because every suite has always imported it from this file.
export {
  PG_DIR,
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  APP_DB_PASSWORD,
  PLATFORM_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  PROVISIONER_DB_PASSWORD,
  RECONCILER_DB_PASSWORD,
  MIGRATOR_DB_PASSWORD,
  pidFileHeld,
  startOrReuse,
  ensureDatabase,
  applyBootstrap,
} from './embedded-cluster';
import {
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  APP_DB_PASSWORD,
  PLATFORM_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  PROVISIONER_DB_PASSWORD,
  RECONCILER_DB_PASSWORD,
  MIGRATOR_DB_PASSWORD,
  applyBootstrap,
  ensureDatabase,
  startOrReuse,
} from './embedded-cluster';
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

export async function ensurePostgres(): Promise<void> {
  await startOrReuse();
  await ensureDatabase('daftar');
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
