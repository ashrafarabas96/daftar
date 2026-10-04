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
// P4-S3: the POS till session, the till's type-ahead and the server-side cart.
import { TillSessionsController } from '../modules/pos/till-sessions.controller';
import { PosReadsController } from '../modules/pos/pos-reads.controller';
import { PosCartController } from '../modules/pos/pos-cart.controller';
import { posProviders } from '../modules/pos/pos.module';
// P4-S4: the receivables commands — collecting a customer payment and applying
// a customer credit — and the reads of what they wrote.
import { ReceivablesController } from '../modules/receivables/receivables.controller';
import { receivablesProviders } from '../modules/receivables/receivables.module';

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
        // P4-S3: the till session lifecycle, the POS type-ahead and the
        // server-side cart. THIS is the composition production runs, and the
        // one every integration test cannot reach — so all three are
        // registered in AppModule too, and `phase4-route-surface.test.ts`
        // refuses a tree where either list is short.
        TillSessionsController,
        PosReadsController,
        PosCartController,
        // P4-S4: POST /v1/customer-payments, POST
        // /v1/customer-credits/:creditId/applications and their two reads.
        // Registered in BOTH compositions (`P4_S4_REQUIRED_CONTROLLERS`): a
        // controller composed in one process only is a route no integration
        // test can reach.
        ReceivablesController,
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
        // P4-S3: the till-session minter, the POS read and the cart. Each
        // needs only providers composed above — `Database`,
        // `InventoryAuthorizationService` and `'LOGGER'` (`pos.module.ts`).
        ...posProviders(),
        // P4-S4: the two receivables commands and their read service. Each
        // needs only providers composed above — `Database`,
        // `InventoryAuthorizationService`,
        // `AccountingAssertionMinterService` and
        // `DatabaseAccountingPostingAdapter`.
        ...receivablesProviders(),
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
