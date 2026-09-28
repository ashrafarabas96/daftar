import type { Provider } from '@nestjs/common';
import { PurchaseDraftService } from './purchase-draft.service';
import { PurchaseReceiptService } from './purchase-receipt.service';
import { PurchaseReceiveAndPayService } from './purchase-receive-and-pay.service';
import { PurchaseReturnService } from './purchase-return.service';
import { PurchaseResidueWriteOffService } from './purchase-residue-write-off.service';
import { PurchaseReversalService } from './purchase-reversal.service';
import { PurchasingReadService } from './purchasing-reads';
import { SupplierCreditAllocationService } from './supplier-credit-allocation.service';
import { SupplierPaymentService } from './supplier-payment.service';
import { SupplierRefundService } from './supplier-refund.service';
import { SupplierService } from './supplier.service';

/**
 * The purchasing providers (PHASE_3_S4_CONTRACT A-19, §4.3; P3-S5 adds the
 * supplier return and the purchase reversal, PHASE_3_S5_CONTRACT §4.3), as the
 * two merchant compositions spread them.
 *
 * It is deliberately NOT a Nest `@Module` imported by the compositions. The
 * services depend on providers composed inline by `AppModule` and
 * `MerchantApiModule` (the database, the inventory authorization seam, the
 * accounting minter and posting adapter), which a child module could not see
 * unless every one of them were re-exported; and a child module's controllers
 * would not appear in the composition's own `controllers` list, which
 * `tests/integration/process-composition.test.ts` holds the two processes to.
 * So both compositions name `SuppliersController`, `PurchasesController`,
 * `SupplierReturnsController` and `SupplierCreditNotesController` directly,
 * exactly as they do the P3-S3 inventory controllers, and spread these
 * providers beside the inventory ones.
 *
 * P3-S6 (PHASE_3_S6_CONTRACT §4.3) adds the three settlement services and
 * receive-and-pay; both compositions also name `SupplierSettlementsController`
 * (and the payment-methods controller with `paymentMethodProviders()`).
 */
export function purchasingProviders(): Provider[] {
  return [
    SupplierService,
    PurchaseDraftService,
    PurchaseReceiptService,
    PurchaseReturnService,
    PurchaseReversalService,
    PurchaseResidueWriteOffService,
    PurchasingReadService,
    SupplierPaymentService,
    SupplierCreditAllocationService,
    SupplierRefundService,
    PurchaseReceiveAndPayService,
  ];
}
