import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
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
import { InventoryTransferService } from '../modules/inventory/inventory-transfer.service';
import { InventoryAdjustmentService } from '../modules/inventory/inventory-adjustment.service';
import { InventoryStocktakeService } from '../modules/inventory/inventory-stocktake.service';
import { InventoryOpeningService } from '../modules/inventory/inventory-opening.service';
import { InventoryMovementsController } from '../modules/inventory/inventory-movements.controller';
import { SuppliersController } from '../modules/purchasing/suppliers.controller';
import { PurchasesController } from '../modules/purchasing/purchases.controller';
import { SupplierCreditNotesController, SupplierReturnsController } from '../modules/purchasing/supplier-returns.controller';
import { purchasingProviders } from '../modules/purchasing/purchasing.module';
import { SupplierSettlementsController } from '../modules/purchasing/supplier-settlements.controller';
import { PaymentMethodsController } from '../modules/payment-methods/payment-methods.controller';
import { paymentMethodProviders } from '../modules/payment-methods/payment-methods.module';

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
      controllers: [
        AuthController,
        TenancyController,
        CatalogController,
        PlatformController,
        HealthController,
        EntitlementsController,
        AccountingController,
        InventoryConfigurationController,
        InventoryMovementsController,
        SuppliersController,
        PurchasesController,
        SupplierReturnsController,
        SupplierCreditNotesController,
        // P3-S6: payment methods, supplier payments, credit allocations and refunds.
        PaymentMethodsController,
        SupplierSettlementsController,
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
        // P3-S3: the stock movement commands. Each posting one mints through
        // the accounting minter and posts through the accounting adapter
        // composed above (accountingProviders), inside one transaction.
        InventoryTransferService,
        InventoryAdjustmentService,
        InventoryStocktakeService,
        InventoryOpeningService,
        // P3-S4: suppliers, purchase drafts, receipts and the live AP reads;
        // P3-S5: supplier returns and the purchase reversal. The receipt, the
        // return and the reversal mint through the same accounting minter and
        // post through the same adapters, on the accounting-aware inventory seam.
        ...purchasingProviders(),
        ...paymentMethodProviders(),
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
