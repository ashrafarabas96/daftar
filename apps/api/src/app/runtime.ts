import type { Provider, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AppError } from '@daftar/domain-core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { AppConfig } from '../config';
import { createLogger } from '../infra/logger';
import { Database } from '../infra/database';
import { InMemoryMetrics, METRICS, type Metrics } from '../infra/metrics';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from '../infra/redis';
import { createObjectStorage, DisabledDevelopmentMalwareScanner, type MalwareScanner, type ObjectStorage } from '../infra/storage';
import { GlobalExceptionFilter } from '../common/error.filter';
import { AuthGuard, MEMBERSHIP_RESOLVER, type MembershipResolver } from '../common/guards';
import { TokenService, type CredentialDelivery } from '../modules/auth/tokens';
import { AuthService } from '../modules/auth/auth.service';
import { AuditService, OutboxService } from '../modules/audit/audit.service';
import { CredentialDeliveryEnqueuer } from '../modules/delivery/credential-enqueuer.service';
import { createCredentialDelivery } from '../modules/delivery/smtp-delivery';
import {
  CredentialPayloadProtector,
  createCredentialEncryptor,
  credentialKeyRingFromConfig,
  type CredentialPayloadEncryptor,
} from '../modules/delivery/credential-protector';
import { LogSink, type OutboxSink } from '../modules/outbox/publisher';
import { TenancyService } from '../modules/tenancy/tenancy.service';
import { AccountingEngine, AccountingReports } from '@daftar/accounting';
import { AccountingAssertionMinterService } from '../modules/accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../modules/accounting/accounting-posting.adapter';
import { AccountingPostingService } from '../modules/accounting/accounting-posting.service';
import { DatabaseAccountingSourcesAdapter } from '../modules/accounting/accounting-sources.adapter';
import { DatabaseAccountingLedgerReader } from '../modules/accounting/accounting-ledger.reader';
import { AccountingSourcesService } from '../modules/accounting/accounting-sources.service';
import { AccountingFxService } from '../modules/accounting/accounting-fx.service';
import { DatabaseAccountingFxAdapter } from '../modules/accounting/accounting-fx.adapter';
import { AccountingPeriodsService } from '../modules/accounting/accounting-periods.service';
import { DatabaseAccountingPeriodsAdapter } from '../modules/accounting/accounting-periods.adapter';
import { AccountingReportsService } from '../modules/accounting/accounting-reports.service';
import { DatabaseAccountingReportReader } from '../modules/accounting/accounting-reports.reader';
import {
  DatabaseAccountingReconciliationReader,
  ReconcilerConnection,
  RECONCILIATION_CONNECTION,
} from '../modules/accounting/accounting-reconciliation.reader';
import {
  AccountingReconciliationService,
  SystemReconciliationClock,
  RECONCILIATION_CLOCK,
  RECONCILIATION_READER,
} from '../modules/accounting/accounting-reconciliation.service';
import { AccountingReconciliationWorker } from '../modules/accounting/accounting-reconciliation.worker';
import { InventoryAssertionMinterService } from '../modules/inventory/inventory-assertion.minter';

/**
 * RUNTIME COMPOSITION (Phase 1 Completion Directive §15–20).
 *
 * ONE modular monolith, FOUR real processes. Each process module composes
 * ONLY the providers of its authority — a provider that is absent from a
 * module cannot be injected, cannot be reached by a route, and cannot hold
 * a secret. The building blocks below are shared; the modules in this
 * directory decide who gets what:
 *
 *   MerchantApiModule  merchant HTTP surface. Owns app/identity/resolver/
 *                      provisioner pools, media storage, ENCRYPT-only
 *                      credential enqueue. NO platform pool, NO worker
 *                      pool, NO AdminController/AdminService, NO delivery
 *                      worker, NO decrypt key ring.
 *   PlatformApiModule  super-admin HTTP surface + the shared identity
 *                      routes it needs (login/refresh/logout/reset). Owns
 *                      platform + identity pools. NO worker secrets, NO
 *                      merchant mutation surface (tenancy/catalog/media).
 *   WorkerModule       NO HTTP. Owns the worker pool, the DECRYPT key
 *                      ring, SMTP delivery and the outbox relay. Owns NO
 *                      reconciliation: see ReconcilerModule.
 *   ReconcilerModule   NO HTTP. Owns the reconciler pool and the daily
 *                      accounting reconciliation pass, and NOTHING else —
 *                      no delivery transport, no key ring, no outbox sink,
 *                      no assertion minter (P2-S8 §6).
 *   AppModule ('all')  dev/test single-process composition of everything;
 *                      production config validation REJECTS it (§19).
 *
 * The migrator is a separate entrypoint (apps/api/src/infra/migrate.ts) that
 * reads the migration connection string itself — no runtime module ever
 * sees migration credentials.
 */
export interface RuntimeSeams {
  /** Test seam: deterministic delivery adapter (worker/all only). */
  delivery?: CredentialDelivery;
  /** Test seam: capture sink for outbox assertions (worker/all only). */
  outboxSink?: OutboxSink;
  /** Test seam: scripted object storage (merchant/all only). */
  storage?: ObjectStorage;
  /** Test seam: deterministic credential encryptor (merchant/platform/all). */
  encryptor?: CredentialPayloadEncryptor;
  /** Test seam: a metrics recorder to assert against (any process). */
  metrics?: Metrics;
  /** Test seam: a controllable clock for the daily reconciliation schedule. */
  reconciliationClock?: { now(): Date };
}

/** Throttler module import shared by every HTTP surface. */
export function httpImports() {
  return [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])];
}

/** Config + logger + Database (pools opened per PROCESS_MODE inside Database). */
export function coreProviders(config: AppConfig, seams: RuntimeSeams = {}): Provider[] {
  return [
    { provide: 'APP_CONFIG', useValue: config },
    { provide: 'LOGGER', useFactory: () => createLogger(config.LOG_LEVEL) },
    // The metrics port (§28) is core rather than per-surface: a posting
    // counter lives in the merchant runtime and a reconciliation counter in
    // the worker, and neither should have to know which process it is in.
    { provide: METRICS, useFactory: (): Metrics => seams.metrics ?? new InMemoryMetrics() },
    Database,
    { provide: 'HEALTH_CHECK', useFactory: (db: Database) => () => db.healthCheck(), inject: [Database] },
  ];
}

/** Error contract + throttling + bearer auth guard — every HTTP surface. */
export function httpProviders(config: AppConfig, resolver: Type<MembershipResolver> | { useValue: MembershipResolver }): Provider[] {
  return [
    {
      provide: 'RATE_LIMITER',
      useFactory: (): RateLimiter => (config.REDIS_URL ? new RedisRateLimiter(config) : new MemoryRateLimiter()),
    },
    'useValue' in resolver ? { provide: MEMBERSHIP_RESOLVER, useValue: resolver.useValue } : { provide: MEMBERSHIP_RESOLVER, useExisting: resolver },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ];
}

/**
 * Shared identity runtime: tokens, sessions, password reset. Password reset
 * ENQUEUES an encrypted credential delivery — encrypt authority only (§24):
 * the KMS-style provider in production, the local dev adapter otherwise.
 */
export function identityProviders(config: AppConfig, seams: RuntimeSeams): Provider[] {
  return [
    TokenService,
    AuthService,
    AuditService,
    { provide: 'CREDENTIAL_ENCRYPTOR', useFactory: (): CredentialPayloadEncryptor => seams.encryptor ?? createCredentialEncryptor(config) },
    CredentialDeliveryEnqueuer,
  ];
}

/** Merchant-only infrastructure: object storage + malware seam + outbox writer. */
export function merchantInfraProviders(config: AppConfig, seams: RuntimeSeams): Provider[] {
  return [
    OutboxService,
    { provide: 'OBJECT_STORAGE', useFactory: (): ObjectStorage => seams.storage ?? createObjectStorage(config) },
    { provide: 'MALWARE_SCANNER', useFactory: (): MalwareScanner => new DisabledDevelopmentMalwareScanner() },
  ];
}

/**
 * Merchant-only inventory command authority (P3-AL-55 §C, §I).
 *
 * The inventory signing key lives here and only here. The platform, worker
 * and reconciler runtimes never receive `INVENTORY_ASSERTION_KEY` (config
 * validation refuses it) and never compose this provider, so they cannot mint
 * an `invctl/1` assertion and therefore cannot drive any inventory routine,
 * whatever code they happen to link.
 */
export function inventoryAuthorityProviders(): Provider[] {
  return [InventoryAssertionMinterService];
}

/**
 * Merchant-only accounting authority (P2-S3, §11, §12, §19).
 *
 * The signing key lives here and only here: the platform and worker runtimes
 * never receive `ACCOUNTING_ASSERTION_KEY` (config validation refuses it), so
 * they cannot mint an assertion and therefore cannot post, whatever code they
 * happen to link.
 *
 * There is no controller. The engine is exported as a service for the domain
 * slices that own posting sources to call; a generic HTTP endpoint accepting
 * arbitrary journal lines is exactly the authority this slice removed.
 */
export function accountingProviders(): Provider[] {
  return [
    AccountingAssertionMinterService,
    DatabaseAccountingPostingAdapter,
    DatabaseAccountingSourcesAdapter,
    DatabaseAccountingLedgerReader,
    {
      provide: AccountingEngine,
      useFactory: (
        minter: AccountingAssertionMinterService,
        posting: DatabaseAccountingPostingAdapter,
        sources: DatabaseAccountingSourcesAdapter,
        reader: DatabaseAccountingLedgerReader,
      ): AccountingEngine => new AccountingEngine(minter, posting, sources, sources, sources, reader),
      inject: [AccountingAssertionMinterService, DatabaseAccountingPostingAdapter, DatabaseAccountingSourcesAdapter, DatabaseAccountingLedgerReader],
    },
    AccountingPostingService,
    AccountingSourcesService,
    // P2-S5: the FX rate registry. The port and the CONTROL minter are
    // injected by token rather than by class so the service depends on the
    // two contracts and not on a Nest adapter — and so nothing can reach the
    // control minter without asking for it by name.
    DatabaseAccountingFxAdapter,
    { provide: 'ACCOUNTING_FX_PORT', useExisting: DatabaseAccountingFxAdapter },
    { provide: 'ACCOUNTING_CONTROL_MINTER', useExisting: AccountingAssertionMinterService },
    AccountingFxService,
    // P2-S6: accounting periods. Same shape as the FX registry above — the
    // port is injected by token so the service depends on the contract and
    // not on a Nest adapter, and the control minter is reached only by name.
    DatabaseAccountingPeriodsAdapter,
    { provide: 'ACCOUNTING_PERIOD_PORT', useExisting: DatabaseAccountingPeriodsAdapter },
    AccountingPeriodsService,
    // P2-S7: the financial reads. `AccountingReports` is a SEPARATE object
    // from `AccountingEngine` on purpose — the engine is the write side and
    // its surface is asserted exactly, so a read method added there would be
    // a read one character away from a posting method. The reader it is built
    // over has no write method at all, so nothing downstream can turn a report
    // into a second journal writer.
    DatabaseAccountingReportReader,
    {
      provide: 'ACCOUNTING_REPORTS',
      useFactory: (reader: DatabaseAccountingReportReader): AccountingReports => new AccountingReports(reader),
      inject: [DatabaseAccountingReportReader],
    },
    AccountingReportsService,
  ];
}

/**
 * Worker-only authority: the DECRYPT key ring, the real delivery transport
 * and the outbox sink. These providers exist in NO HTTP process module.
 */
export function workerProviders(config: AppConfig, seams: RuntimeSeams): Provider[] {
  return [
    { provide: 'CREDENTIAL_DELIVERY', useFactory: (): CredentialDelivery => seams.delivery ?? createCredentialDelivery(config) },
    {
      provide: CredentialPayloadProtector,
      useFactory: (): CredentialPayloadProtector => new CredentialPayloadProtector(credentialKeyRingFromConfig(config)),
    },
    {
      provide: 'OUTBOX_SINK',
      useFactory: (logger: ReturnType<typeof createLogger>): OutboxSink => seams.outboxSink ?? new LogSink(logger),
      inject: ['LOGGER'],
    },
  ];
}

/**
 * Reconciler-only authority (P2-S8 §6, §31): the reconciliation reader, the
 * clock and the daily scheduler.
 *
 * These providers exist in NO other process module, and that placement is the
 * decision this slice turns on. Reconciliation started out as a provider
 * inside the worker, which was wrong for a reason no amount of care inside
 * the code would have fixed: the worker already holds the credential
 * decryption key ring, the SMTP credential and the outbox relay, so putting a
 * pass that reads every business's ledger beside them would have made one
 * compromised process both the delivery authority and the financial
 * inspection authority. Delivery authority is not financial authority, so the
 * reconciler is its own process with its own database credential.
 *
 * The composition is deliberately thin — `coreProviders` plus these — so that
 * "this process cannot obtain the worker's secrets" is a fact about what is
 * in the module rather than a fact about what the code chooses to ask for.
 */
export function reconcilerProviders(_config: AppConfig, seams: RuntimeSeams): Provider[] {
  return [
    { provide: RECONCILIATION_CONNECTION, useClass: ReconcilerConnection },
    { provide: RECONCILIATION_READER, useClass: DatabaseAccountingReconciliationReader },
    { provide: RECONCILIATION_CLOCK, useFactory: () => seams.reconciliationClock ?? new SystemReconciliationClock() },
    AccountingReconciliationService,
    AccountingReconciliationWorker,
  ];
}

/**
 * Platform surface has NO merchant membership resolution: a request that
 * presents X-Business-Id on the admin API is refused. The guard still
 * authenticates the bearer token; business context simply does not exist.
 */
export const NO_MERCHANT_CONTEXT: MembershipResolver = {
  resolveMembership: () => Promise.reject(AppError.forbidden('Business context is not available on this surface')),
  require: () => {
    throw AppError.forbidden('Business context is not available on this surface');
  },
};

export { TenancyService as MerchantMembershipResolver };
