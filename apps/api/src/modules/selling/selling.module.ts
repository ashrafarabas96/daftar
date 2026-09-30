import type { Provider } from '@nestjs/common';
import { CustomerReadService } from './customer-reads';
import { InvoiceReadService } from './invoice-reads';

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
  return [CustomerReadService, InvoiceReadService];
}
