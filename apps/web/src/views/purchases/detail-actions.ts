/**
 * What the purchase screen offers (P3-S7 A-11, TL-4(b); TD-16), decided from
 * the server's reads only: the purchase's status, the S7 return-options
 * (`returnable`, `reversible`), the purchase's payable, and the caller's own
 * grants. Every command still enforces its own authority.
 */
import type { PurchaseStatusDto } from '@daftar/shared-contracts';
import type { Phase3Permission } from '@/lib/phase3-api';
import { isLeftoverOnly, isNonZeroMinor } from '../common/amount-text';
import type { PurchaseActions } from './types';

export interface PurchaseDetailFacts {
  status: PurchaseStatusDto;
  returnable: boolean;
  reversible: boolean;
  /** The purchase's payable (`GET /v1/purchases/:id/payable`); null when it is not received. */
  payable: { outstandingTxnMinor: string; outstandingBaseMinor: string } | null;
  /** The caller's branch scope is the whole business. */
  businessWide: boolean;
  can: (permission: Phase3Permission) => boolean;
}

export function purchaseDetailActions(f: PurchaseDetailFacts): PurchaseActions {
  const received = f.status === 'received';
  // A leftover smaller than the smallest coin cannot be paid (the server
  // refuses it): the screen offers to close it instead, to a business-wide
  // holder of suppliers.pay (`purchase.write_off_residue`, 0072).
  const leftover = received && isLeftoverOnly(f.payable);
  return {
    continueDraft: f.status === 'draft' && f.can('purchases.manage'),
    returnToSupplier: f.returnable && f.can('purchases.return'),
    undoReceipt: f.reversible && f.can('purchases.receive'),
    paySupplier: received && !leftover && isNonZeroMinor(f.payable?.outstandingTxnMinor) && f.can('suppliers.pay'),
    closeLeftover: leftover && f.businessWide && f.can('suppliers.pay'),
  };
}
