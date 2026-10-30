import type { ExecutionContext, Provider, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AppError } from '@daftar/domain-core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { Client } from 'pg';
import { migrationOrdinal, REQUIRED_SCHEMA_MIGRATION, schemaFloor, type AppConfig } from '../config';
import { clientLimiterKey } from '../common/client-ip';
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
import { SalePostingService } from '../modules/accounting/sale-posting.service';
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

/**
 * Throttler module import shared by every HTTP surface: 300 requests per
 * minute for each route handler and CLIENT. The client is the address
 * `clientIp()` resolves — the same TRUSTED_PROXIES authority as the auth
 * limits (TD-19) — not the TCP peer: behind the web server the peer is the
 * web server, and keyed on it every merchant behind one web instance would
 * share one allowance per route. An untrusted peer is its own client, so a
 * forged X-Forwarded-For buys nothing. An IPv6 client counts per /64
 * (`limiterKey`, review L-3).
 */
export function httpImports(config: Pick<AppConfig, 'TRUST_PROXY' | 'TRUSTED_PROXIES'>) {
  return [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      getTracker: (_req: unknown, context: ExecutionContext) => clientLimiterKey(context.switchToHttp().getRequest<Request>(), config),
    }),
  ];
}

/**
 * C1.5 — THE SCHEMA FLOOR GATE.
 *
 * Resolving this provider is what proves the database is at or above the
 * migration this build was written against. It RETURNS the floor it enforced
 * so that the thing depending on it has something to hold, and it THROWS when
 * the database is behind — which, resolved during `app.init()`, means the
 * process never reaches `app.listen()` (`main.ts:93`) and the API never
 * answers a request.
 *
 * ── WHY HERE, AND NOT SOMEWHERE EARLIER OR LATER ──────────────────────────
 *
 * «Before any money read» has to be STRUCTURAL, because an ordering that
 * merely happens to hold today is one a later provider can reorder without
 * anybody noticing. So the gate is wired as a DEPENDENCY OF `Database`
 * below: every money read in this application goes through `Database`, Nest
 * cannot construct a provider before its dependencies have resolved, and so
 * no money read can precede this check — not because it is declared first,
 * but because the handle every money read needs does not exist until the
 * check has passed.
 *
 * Three sites were considered and rejected:
 *
 *   — `loadConfig` (`config.ts`): runs before any pool exists and has no
 *     database to ask. A guard there could only check that a URL was present.
 *   — `Database.onModuleInit`: that is where the PRINCIPAL check lives
 *     (`database.ts:755`, «Refusing to start»), and it is the natural
 *     neighbour — but it is in a file this lane does not own, and a hook runs
 *     AFTER the instance it hangs off has been constructed. Construction is
 *     already far enough along to matter.
 *   — a route guard or an interceptor: that is the guard this one is not. It
 *     would run after the application had started, per request, which means
 *     the first money read has already been served by the time it speaks.
 *
 * It opens its OWN short-lived connection rather than borrowing one from
 * `Database`, for two reasons: `Database` exposes no general query method, and
 * owning the connection means the gate has no dependency on `Database` at all
 * and can therefore be `Database`'s dependency without a cycle.
 *
 * The comparison is on the ORDINAL of the greatest APPLIED migration, not on a
 * count of rows and not on a string: see `migrationOrdinal`. A missing
 * `schema_migrations`, an empty one, or a name without an ordinal are each a
 * REFUSAL and never a pass — the whole point of the gate is that an
 * unidentifiable schema is treated as an inadequate one.
 */
export const SCHEMA_VERSION_GUARD = Symbol('SCHEMA_VERSION_GUARD');

/** The message every refusal below starts with, so operators and tests name one string. */
export const SCHEMA_FLOOR_REFUSAL = 'Refusing to start — database schema is behind this build';

/**
 * THE MONEY-READ SURFACE THIS BUILD REQUIRES, and why the gate needs it at all.
 *
 * `schema_migrations` is owned by `postgres` and granted to `postgres` ALONE —
 * measured, not assumed: `has_table_privilege('daftar_app',
 * 'public.schema_migrations', 'SELECT')` is `false`, no routine exposes it, and
 * `MIGRATION_DATABASE_URL` is withheld from the API runtime on purpose
 * («migration command only; the API runtime never reads it»). So on a real
 * deployment the API's own principal CANNOT read the migration ledger, and a
 * gate that only read the ledger would not fail closed — it would fail
 * ALWAYS, with `42501 permission denied`, and no deployment would ever boot.
 *
 * The gate therefore has two halves, and the order matters:
 *
 *   1. THE LEDGER, when and only when this principal may read it (a scratch
 *      database, a migration test, a single-role dev setup). That is the half
 *      that enforces the ORDINAL and gives the operator the clearest message.
 *   2. THE SURFACE, always. The shapes below are what the shipped code
 *      actually reads, checked through `pg_catalog`, which every role may
 *      read. This half is what protects a real deployment, where half 1 is
 *      structurally unavailable.
 *
 * Neither half fails open: half 1 refuses an absent, empty or unplaceable
 * ledger rather than skipping it, and half 2 runs on every path.
 *
 * ── WHAT THE SURFACE HALF DOES NOT DO ─────────────────────────────────────
 *
 * It pins the money-read SHAPE, not every migration. A migration that changed
 * nothing on this list would pass it. That is a declared limit and not a hole
 * the gate pretends to cover: the ordinal is half 1's job, and where half 1
 * cannot run, the honest claim is «the surface the code reads is the surface
 * the build expects», which is the defect class C1.5 was opened for.
 *
 * AND THE LIST STOPS AT 0084. Both remaining migrations of the required range
 * were examined for a sentinel and NEITHER yields one, by measurement rather
 * than by omission:
 *
 *   — 0085 replaces this very routine set with the set-based recompute, but it
 *     does so by `CREATE OR REPLACE` over the SAME shape: 0081 already
 *     declares `customer_collect_payment` with the same twenty-six parameters
 *     and the same six result columns that 0085 declares and that
 *     `CUSTOMER_COLLECT_PAYMENT_SQL` calls. What 0085 changes is the BODY, and
 *     a body is not a shape any caller reads. Pinning that signature would
 *     LOOK like 0085 coverage while being unable to tell 0084 from 0085 —
 *     which is a protection claim wider than its evidence, so it is not here.
 *   — 0086 consists of EIGHT `ALTER POLICY` statements and nothing else: no
 *     routine, no table, no column. A row-security qual is not a shape the
 *     code reads; it filters the rows the code reads, and it is invisible to
 *     every signature and result this list can pin.
 *
 * The consequence, stated plainly rather than left to be discovered: on a
 * deployment where half 1 cannot run, a database stopped at 0084 passes this
 * gate. What actually holds 0085 and 0086 is CI — the settlement suites for
 * the recompute, and `tests/security/dr60-rls-tenant-isolation.test.ts`, which
 * executes the eight quals as two tenants. Those are CI gates, not boot gates.
 * Closing the remaining two at boot needs either the ordinal half working in
 * production (a `SELECT` grant or a reader over `schema_migrations`, which is
 * a migration and so not an execution card's to make) or a catalogue
 * assertion over `pg_proc.prosrc` and `pg_policy`. The first is the cheaper
 * and the more honest: it checks the version, which is the actual question.
 */
const REQUIRED_SURFACE: readonly { readonly signature: string; readonly result?: string; readonly because: string }[] = [
  {
    signature: 'public.invoice_outstanding(uuid,uuid[])',
    result:
      'TABLE(invoice_id uuid, paid_txn_minor bigint, paid_base_minor bigint, outstanding_txn_minor bigint, ' +
      'outstanding_base_minor bigint, currency_code text, due_date date, issue_date date)',
    because:
      "candidate 0084 APPENDED currency_code, due_date and issue_date to 0083's five-column form. A positional reader against the older form " +
      'does not fail — it reads the wrong field and reports a number, which is the quietest money defect this gate exists to prevent',
  },
  {
    signature: 'public.customer_ar_open_document_counts(uuid,uuid)',
    because: 'DR-39: the open-document counters the receivable reads, absent before candidate 0084',
  },
];

export async function assertSchemaFloor(config: Pick<AppConfig, 'APP_DATABASE_URL'>): Promise<number> {
  const floor = schemaFloor();
  const client = new Client({ connectionString: config.APP_DATABASE_URL });
  await client.connect();
  try {
    // ── 1. THE LEDGER, if this principal may read it ─────────────────────
    // `to_regclass` first, because `has_table_privilege` raises on a relation
    // that does not exist, and because an operator reading a bare
    // «relation does not exist» has to work out for himself that it means the
    // migrations never ran. The gate says so itself.
    const access = await client.query<{ present: boolean; may: boolean | null }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present,
              CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN NULL
                   ELSE has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') END AS may`,
    );
    if (access.rows[0]?.present !== true)
      throw new Error(
        `${SCHEMA_FLOOR_REFUSAL}: this build requires ${REQUIRED_SCHEMA_MIGRATION} but the database has no schema_migrations table, ` +
          `so no migration has ever been applied to it. Run the migrations before starting the API.`,
      );
    if (access.rows[0]?.may === true) {
      const r = await client.query<{ applied: string | null }>(`SELECT max(name) AS applied FROM public.schema_migrations`);
      const applied = r.rows[0]?.applied ?? null;
      if (applied === null)
        throw new Error(
          `${SCHEMA_FLOOR_REFUSAL}: this build requires ${REQUIRED_SCHEMA_MIGRATION} but schema_migrations is empty. ` +
            `Run the migrations before starting the API.`,
        );
      const at = migrationOrdinal(applied);
      if (at === null)
        throw new Error(
          `${SCHEMA_FLOOR_REFUSAL}: the greatest applied migration is ${JSON.stringify(applied)}, which carries no leading ordinal, so this ` +
            `build cannot tell whether it is at or above ${REQUIRED_SCHEMA_MIGRATION}. An unidentifiable schema is refused rather than assumed ` +
            `adequate.`,
        );
      if (at < floor)
        throw new Error(
          `${SCHEMA_FLOOR_REFUSAL}: this build requires ${REQUIRED_SCHEMA_MIGRATION} (ordinal ${floor}) but the database has only reached ` +
            `${applied} (ordinal ${at}). Starting would let the API read money through routines and columns that are not there yet. ` +
            `Run the migrations, then start the API.`,
        );
    }

    // ── 2. THE SURFACE, on every path ────────────────────────────────────
    for (const required of REQUIRED_SURFACE) {
      const s = await client.query<{ oid: string | null; result: string | null }>(
        `SELECT to_regprocedure($1)::text AS oid,
                CASE WHEN to_regprocedure($1) IS NULL THEN NULL ELSE pg_get_function_result(to_regprocedure($1)) END AS result`,
        [required.signature],
      );
      const row = s.rows[0];
      if (row === undefined || row.oid === null)
        throw new Error(
          `${SCHEMA_FLOOR_REFUSAL}: this build requires ${REQUIRED_SCHEMA_MIGRATION}, whose ${required.signature} is not in this database's ` +
            `catalogue — ${required.because}. Run the migrations before starting the API.`,
        );
      if (required.result !== undefined && row.result !== required.result)
        throw new Error(
          `${SCHEMA_FLOOR_REFUSAL}: ${required.signature} is present but returns ${JSON.stringify(row.result)}, and this build reads ` +
            `${JSON.stringify(required.result)} — ${required.because}. Run the migrations before starting the API.`,
        );
    }
  } finally {
    // Released whatever happened. A gate that leaked a connection on the
    // refusal path would make a misconfigured deployment exhaust the server's
    // connection slots while it restarted.
    await client.end().catch(() => undefined);
  }
  return floor;
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
    { provide: SCHEMA_VERSION_GUARD, useFactory: (): Promise<number> => assertSchemaFloor(config) },
    // `Database` is produced by a factory ONLY so that it can declare the
    // schema gate as a dependency. Nest calls `onModuleInit` on a
    // factory-produced instance exactly as it does on a class provider —
    // measured in `tests-unit/nest-factory-provider-lifecycle.test.ts`,
    // because if that ever stopped being true this line would silently
    // disable the DB PRINCIPAL check that lives in that hook
    // (`database.ts:755`), and a wiring change that switches off a security
    // check without failing is the worst kind.
    //
    // The floor is taken as an argument and checked rather than ignored: an
    // injected dependency nobody reads is one a later edit drops from the
    // `inject` array without anything going red.
    {
      provide: Database,
      useFactory: (cfg: AppConfig, floor: number): Database => {
        if (typeof floor !== 'number') throw new Error(`the schema floor gate did not resolve to an ordinal, so the database handle must not be built`);
        return new Database(cfg);
      },
      inject: ['APP_CONFIG', SCHEMA_VERSION_GUARD],
    },
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
    // P4-S2: the ONE place a sale's posting authority is minted. The selling
    // services inject it and mint no assertion themselves, so there is no
    // second posting authority without a permission check in front of it.
    SalePostingService,
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
