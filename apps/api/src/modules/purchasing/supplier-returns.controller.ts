import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import type { Page, SupplierCreditNoteDto, SupplierReturnDto } from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { strictUuidParam } from '../inventory/canonical-id';
import { SupplierCreditNoteListQuerySchema, type SupplierCreditNoteListQuery, type SupplierReturnListQuery } from './purchasing.schemas';
import { PurchasingReadService } from './purchasing-reads';

/**
 * The P3-S5 reads the controllers need from `PurchasingReadService`
 * (PHASE_3_S5_CONTRACT A-19, §4.3: `purchasing-reads.ts` owns them). Each
 * re-checks its view permission and applies its own scope rule, as the S4
 * reads do:
 *
 * - `listPurchaseReturns`: `purchases.view` and the purchase's warehouse in
 *   scope; an out-of-scope purchase reads as `purchase.not_found`;
 * - `getSupplierReturn`: `purchases.view` and the return's warehouse (or the
 *   purchase's) in scope; an out-of-scope return reads as not found, so the
 *   answer does not reveal it;
 * - `listSupplierCreditNotes`: `suppliers.view` and business-wide branch scope
 *   (the S4 TL-4 precedent), re-checked whatever the caller did.
 */
export interface SupplierReturnReadPort {
  listPurchaseReturns(m: MembershipContext, purchaseId: string, q: SupplierReturnListQuery): Promise<Page<SupplierReturnDto>>;
  getSupplierReturn(m: MembershipContext, returnId: string): Promise<SupplierReturnDto>;
  listSupplierCreditNotes(m: MembershipContext, supplierId: string, q: SupplierCreditNoteListQuery): Promise<Page<SupplierCreditNoteDto>>;
}

/**
 * Supplier returns read by their own id (PHASE_3_S5_CONTRACT A-19). A return
 * is written only through its purchase (`POST /v1/purchases/:purchaseId/returns`,
 * `PurchasesController`), and is insert-only: there is no route that edits,
 * cancels or deletes one (A-04).
 *
 * The controller holds no business logic, exactly as the S4 purchasing
 * controllers: the route guard requires the view permission before anything
 * is read, the path id is a canonical lowercase UUID (`strictUuidParam`),
 * and the read applies the warehouse scope. Nothing is caught here.
 */
@Controller('/v1/supplier-returns')
export class SupplierReturnsController {
  constructor(@Inject(PurchasingReadService) private readonly reads: SupplierReturnReadPort) {}

  @Get(':returnId')
  @RequiresPermission('purchases.view')
  async get(@Membership() m: MembershipContext, @Param('returnId') returnId: string): Promise<SupplierReturnDto> {
    return this.reads.getSupplierReturn(m, strictUuidParam(returnId, 'returnId'));
  }
}

/**
 * A supplier's credit notes (PHASE_3_S5_CONTRACT A-11, A-19): stored rows,
 * remaining values as stored. Written only inside a supplier return and
 * insert-only in S5 (TL-13), so this is a read.
 *
 * It lives beside the returns that issue the notes rather than in
 * `SuppliersController`, under the same `/v1/suppliers` prefix. The notes of
 * a supplier span every warehouse of the business, so beyond
 * `suppliers.view` it requires business-wide branch scope, exactly as the
 * supplier payable (S4 TL-4): an assigned-scope actor is refused before any
 * read, whatever the supplier.
 */
@Controller('/v1/suppliers')
export class SupplierCreditNotesController {
  constructor(@Inject(PurchasingReadService) private readonly reads: SupplierReturnReadPort) {}

  @Get(':supplierId/credit-notes')
  @RequiresPermission('suppliers.view')
  async list(@Membership() m: MembershipContext, @Param('supplierId') supplierId: string, @Query() query: unknown): Promise<Page<SupplierCreditNoteDto>> {
    const id = strictUuidParam(supplierId, 'supplierId');
    if (m.branchScopeMode !== 'all') {
      throw new AppError('FORBIDDEN', 'This read requires business-wide branch scope', 403, { inventoryCode: 'inventory.business_wide_scope_required' });
    }
    return this.reads.listSupplierCreditNotes(m, id, SupplierCreditNoteListQuerySchema.parse(query));
  }
}
