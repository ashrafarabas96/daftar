import { Module, NestModule, MiddlewareConsumer, DynamicModule } from '@nestjs/common';
import type { AppConfig } from '../config';
import { RequestContextMiddleware } from './request-context.middleware';
import {
  coreProviders,
  httpImports,
  httpProviders,
  identityProviders,
  accountingProviders,
  inventoryAuthorityProviders,
  merchantInfraProviders,
  workerProviders,
  reconcilerProviders,
  type RuntimeSeams,
} from './runtime';
import { AuthController } from '../modules/auth/auth.controller';
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
import { AccountingController } from '../modules/accounting/accounting.controller';
import { InventoryAuthorizationService } from '../modules/inventory/inventory-authorization';
import { InventoryConfigurationService } from '../modules/inventory/inventory-configuration.service';
import { InventoryConfigurationController } from '../modules/inventory/inventory-configuration.controller';
import { AdminService } from '../modules/admin/admin.service';
import { AdminController } from '../modules/admin/admin.controller';
import { OutboxPublisher } from '../modules/outbox/publisher';
import { CredentialDeliveryWorker } from '../modules/delivery/delivery-worker.service';

export type AppModuleOptions = { config: AppConfig } & RuntimeSeams;

/**
 * SINGLE-PROCESS composition (PROCESS_MODE=all): merchant + platform + worker
 * in one Nest application. Development/test ONLY — production configuration
 * validation rejects this mode (Directive §19); the separated runtimes are
 * MerchantApiModule / PlatformApiModule / WorkerModule (see runtime.ts).
 *
 * This composition must carry EVERY merchant controller that
 * MerchantApiModule carries. A route that exists in one and not the other is
 * a route no integration test can reach, so its contract goes unproven here
 * and its first real exercise is production. `tests/integration/
 * process-composition.test.ts` holds the two lists to each other.
 */
@Module({})
export class AppModule implements NestModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    return {
      module: AppModule,
      imports: httpImports(),
      controllers: [
        AuthController,
        TenancyController,
        CatalogController,
        PlatformController,
        HealthController,
        EntitlementsController,
        AccountingController,
        InventoryConfigurationController,
        AdminController,
      ],
      providers: [
        ...coreProviders(config, options),
        ...httpProviders(config, TenancyService),
        ...identityProviders(config, options),
        ...merchantInfraProviders(config, options),
        ...accountingProviders(),
        ...inventoryAuthorityProviders(),
        // P3-AL-33/39: the authorization seam every inventory command uses, and
        // the first command on it. Composed wherever the minter is, and only there.
        InventoryAuthorizationService,
        InventoryConfigurationService,
        ...workerProviders(config, options),
        // Only PROCESS_MODE=all composes the reconciler beside the worker,
        // and only because this composition exists for dev and tests;
        // production refuses this mode outright (§19), so the two
        // authorities never share a process where it matters.
        ...reconcilerProviders(config, options),
        AdminService,
        TenancyService,
        StructureService,
        InvitationsService,
        EntitlementService,
        CatalogService,
        MediaService,
        OutboxPublisher,
        CredentialDeliveryWorker,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
