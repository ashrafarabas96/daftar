import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { AppConfig } from '../config';
import { RequestContextMiddleware } from './request-context.middleware';
import { coreProviders, httpImports, httpProviders, identityProviders, accountingProviders, merchantInfraProviders, type RuntimeSeams } from './runtime';
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

/**
 * MERCHANT PROCESS (Directive §16). Composes the merchant HTTP surface and
 * NOTHING else. Structurally absent here — not "disabled", absent:
 *   - platform DB pool, worker DB pool, migration credentials (Database opens
 *     pools per PROCESS_MODE; config validation refuses the secrets),
 *   - credential DECRYPT key ring (CredentialPayloadProtector),
 *   - AdminController / AdminService,
 *   - CredentialDeliveryWorker / OutboxPublisher / SMTP delivery.
 * Credential delivery here is ENCRYPT + ENQUEUE only (§21–22).
 */
@Module({})
export class MerchantApiModule implements NestModule {
  static register(options: { config: AppConfig } & RuntimeSeams): DynamicModule {
    const { config } = options;
    return {
      module: MerchantApiModule,
      imports: httpImports(),
      controllers: [AuthController, TenancyController, CatalogController, PlatformController, HealthController, EntitlementsController, AccountingController],
      providers: [
        ...coreProviders(config, options),
        ...httpProviders(config, TenancyService),
        ...identityProviders(config, options),
        ...merchantInfraProviders(config, options),
        ...accountingProviders(),
        TenancyService,
        StructureService,
        InvitationsService,
        EntitlementService,
        CatalogService,
        MediaService,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
