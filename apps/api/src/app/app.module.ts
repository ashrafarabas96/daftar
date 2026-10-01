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
import { InventoryReadService } from '../modules/inventory/inventory-reads';
import { InventoryReadsController } from '../modules/inventory/inventory-reads.controller';
import { SupplierBalanceReadService } from '../modules/purchasing/supplier-balance-reads';
import { SupplierBalancesController } from '../modules/purchasing/supplier-balances.controller';
import { PaymentMethodDefaultsController, PaymentMethodDefaultsReadService } from '../modules/payment-methods/payment-method-defaults.controller';
// P4-S1: the Phase 4 customer and invoice read surface.
import { CustomersController } from '../modules/selling/customers.controller';
import { InvoicesController } from '../modules/selling/invoices.controller';
import { SalesController } from '../modules/selling/sales.controller';
import { sellingProviders } from '../modules/selling/selling.module';
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
      imports: httpImports(config),
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
        // P3-S7: the merchant reads (live, GET only).
        InventoryReadsController,
        SupplierBalancesController,
        PaymentMethodDefaultsController,
        // P4-S1: the customer and invoice reads (GET only; the invoice's one writer is the sale command).
        CustomersController,
        InvoicesController,
        // P4-S2: the sale command and its read (POST /v1/sales, GET /v1/sales/:saleId).
        SalesController,
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
        // P3-S7: the read services of the three S7 controllers.
        InventoryReadService,
        SupplierBalanceReadService,
        PaymentMethodDefaultsReadService,
        // P4-S1: the customer and invoice read services of the two Phase 4 controllers.
        ...sellingProviders(),
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
