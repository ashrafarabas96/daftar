import type { Provider } from '@nestjs/common';
import { CustomerReadService } from './customer-reads';
import { InvoiceReadService } from './invoice-reads';
import { SaleCommitService } from './sale-commit.service';
import { SaleReadService } from './sale-reads';

/**
 * The Phase 4 customer and invoice providers (P4-S1), as the two merchant
 * compositions spread them.
 *
 * It is deliberately NOT a Nest `@Module` imported by the compositions, for the
 * reason `purchasingProviders()` documents (`purchasing.module.ts:14-30`): these
 * services depend on providers composed inline by `AppModule` and
 * `MerchantApiModule`, and a child module's controllers would not appear in the
 * composition's own `controllers` list — which
 * `tests/integration/process-composition.test.ts` holds both processes to. So
 * both compositions name `CustomersController` and `InvoicesController`
 * directly and spread these providers beside the purchasing ones.
 *
 * DAFTAR composes Nest twice, and a controller registered in only one of them is
 * a route that cannot be tested. Both are registered.
 */
export function sellingProviders(): Provider[] {
  return [CustomerReadService, InvoiceReadService, SaleCommitService, SaleReadService];
}

/**
 * P4-S2 adds `SalesController`, which BOTH compositions must register for the
 * same reason the two P4-S1 controllers are registered in both: DAFTAR
 * composes Nest twice and a controller in only one of them is a route that
 * cannot be tested (`tests/integration/process-composition.test.ts` holds
 * both processes to their own `controllers` list).
 *
 * `app.module.ts` and `merchant-api.module.ts` are outside this slice's file
 * ownership, so the required wiring is STATED here and reported rather than
 * made: add `SalesController` to each composition's `controllers` list beside
 * `CustomersController` and `InvoicesController`. `SaleCommitService` also
 * needs `SalePostingService` (added to `runtime.ts`'s accounting providers),
 * `InventoryAuthorizationService` and `DatabaseAccountingPostingAdapter`,
 * all of which both compositions already provide.
 */
export const P4_S2_REQUIRED_CONTROLLERS: readonly string[] = Object.freeze(['SalesController']);
