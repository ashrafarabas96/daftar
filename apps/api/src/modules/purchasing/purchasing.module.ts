import type { Provider } from '@nestjs/common';
import { PurchaseDraftService } from './purchase-draft.service';
import { PurchaseReceiptService } from './purchase-receipt.service';
import { PurchasingReadService } from './purchasing-reads';
import { SupplierService } from './supplier.service';

/**
 * The P3-S4 purchasing providers (PHASE_3_S4_CONTRACT A-19, §4.3), as the two
 * merchant compositions spread them.
 *
 * It is deliberately NOT a Nest `@Module` imported by the compositions. The
 * services depend on providers composed inline by `AppModule` and
 * `MerchantApiModule` (the database, the inventory authorization seam, the
 * accounting minter and posting adapter), which a child module could not see
 * unless every one of them were re-exported; and a child module's controllers
 * would not appear in the composition's own `controllers` list, which
 * `tests/integration/process-composition.test.ts` holds the two processes to.
 * So both compositions name `SuppliersController` and `PurchasesController`
 * directly, exactly as they do the P3-S3 inventory controllers, and spread
 * these providers beside the inventory ones.
 */
export function purchasingProviders(): Provider[] {
  return [SupplierService, PurchaseDraftService, PurchaseReceiptService, PurchasingReadService];
}
