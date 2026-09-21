import { Module, NestModule, MiddlewareConsumer, DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { AppConfig } from '../config';
import { createLogger } from '../infra/logger';
import { Database } from '../infra/database';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from '../infra/redis';
import { createObjectStorage, DisabledDevelopmentMalwareScanner, type MalwareScanner, type ObjectStorage } from '../infra/storage';
import { GlobalExceptionFilter } from '../common/error.filter';
import { AuthGuard } from '../common/guards';
import { RequestContextMiddleware } from './request-context.middleware';
import { TokenService, type CredentialDelivery } from '../modules/auth/tokens';
import { AuthService } from '../modules/auth/auth.service';
import { AuthController } from '../modules/auth/auth.controller';
import { AuditService, OutboxService } from '../modules/audit/audit.service';
import { TenancyService } from '../modules/tenancy/tenancy.service';
import { StructureService } from '../modules/tenancy/structure.service';
import { InvitationsService } from '../modules/tenancy/invitations.service';
import { TenancyController } from '../modules/tenancy/tenancy.controller';
import { EntitlementService } from '../modules/entitlements/entitlements.service';
import { EntitlementsController } from '../modules/entitlements/entitlements.controller';
import { CatalogService } from '../modules/catalog/catalog.service';
import { MediaService } from '../modules/catalog/media.service';
import { CatalogController } from '../modules/catalog/catalog.controller';
import { PlatformController, HealthController } from '../modules/platform/platform.controller';
import { AdminService } from '../modules/admin/admin.service';
import { AdminController } from '../modules/admin/admin.controller';
import { OutboxPublisher, LogSink, type OutboxSink } from '../modules/outbox/publisher';
import { CredentialDeliveryWorker } from '../modules/delivery/delivery-worker.service';
import { CredentialDeliveryEnqueuer } from '../modules/delivery/credential-enqueuer.service';
import { createCredentialDelivery } from '../modules/delivery/smtp-delivery';
import { CredentialPayloadProtector, createCredentialEncryptor, credentialKeyRingFromConfig } from '../modules/delivery/credential-protector';

export interface AppModuleOptions {
  config: AppConfig;
  /** Test seam: deterministic delivery adapter. Defaults to LogDelivery (dev-only, honest). */
  delivery?: CredentialDelivery;
  /** Test seam: capture sink for outbox assertions. */
  outboxSink?: OutboxSink;
  /** Test seam: scripted object storage (compensation/failure tests). */
  storage?: ObjectStorage;
  /** Test seam: deterministic credential encryptor. Defaults per createCredentialEncryptor. */
  encryptor?: import('../modules/delivery/credential-protector').CredentialPayloadEncryptor;
}

@Module({})
export class AppModule implements NestModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])],
      controllers: [AuthController, TenancyController, CatalogController, PlatformController, HealthController, EntitlementsController, AdminController],
      providers: [
        { provide: 'APP_CONFIG', useValue: config },
        { provide: 'LOGGER', useFactory: () => createLogger(config.LOG_LEVEL) },
        // §27 provider factory: production = SMTP only; dev/test = log adapter or test seam.
        { provide: 'CREDENTIAL_DELIVERY', useFactory: (): CredentialDelivery => options.delivery ?? createCredentialDelivery(config) },
        // Gate A §5–7 + §23–27: payload protector with a REAL key ring.
        // Production key material comes from CREDENTIAL_PAYLOAD_KEYS /
        // CREDENTIAL_PAYLOAD_KEY (config validation refuses the dev key).
        // Part C: merchant-side ENCRYPT-ONLY provider (KMS-style in
        // production; local DEV_TEST_KEY adapter only outside production).
        // The merchant process NEVER receives decryption material.
        {
          provide: 'CREDENTIAL_ENCRYPTOR',
          useFactory: () => options.encryptor ?? createCredentialEncryptor(config),
        },
        {
          provide: CredentialPayloadProtector,
          useFactory: (): CredentialPayloadProtector =>
            new CredentialPayloadProtector(credentialKeyRingFromConfig(config)),
        },
        {
          provide: 'OUTBOX_SINK',
          useFactory: (logger: ReturnType<typeof createLogger>): OutboxSink => options.outboxSink ?? new LogSink(logger),
          inject: ['LOGGER'],
        },
        {
          provide: 'RATE_LIMITER',
          useFactory: (): RateLimiter => (config.REDIS_URL ? new RedisRateLimiter(config) : new MemoryRateLimiter()),
        },
        // §21 storage factory: production = real S3; dev/test = local disk or test seam.
        { provide: 'OBJECT_STORAGE', useFactory: (): ObjectStorage => options.storage ?? createObjectStorage(config) },
        { provide: 'MALWARE_SCANNER', useFactory: (): MalwareScanner => new DisabledDevelopmentMalwareScanner() },
        { provide: 'HEALTH_CHECK', useFactory: (db: Database) => () => db.healthCheck(), inject: [Database] },
        Database, TokenService, AuthService, AuditService, OutboxService, AdminService,
        TenancyService, StructureService, InvitationsService, EntitlementService,
        CatalogService, MediaService, OutboxPublisher, CredentialDeliveryEnqueuer, CredentialDeliveryWorker,
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
