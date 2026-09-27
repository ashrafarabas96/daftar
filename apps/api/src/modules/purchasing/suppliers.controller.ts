import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '@daftar/domain-core';
import type { Page, SupplierCommandResultDto, SupplierDto, SupplierOpenPurchasesDto, SupplierPayableDto } from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import { searchQueryParam } from '../inventory/read-scope';
import {
  SupplierCreateSchema,
  SupplierLifecycleSchema,
  SupplierListQuerySchema,
  SupplierUpdateSchema,
  type SupplierCreateRequest,
  type SupplierLifecycleRequest,
  type SupplierUpdateRequest,
} from './purchasing.schemas';
import { PurchasingReadService } from './purchasing-reads';
import { SupplierBalanceReadService, SupplierOpenPurchasesQuerySchema } from './supplier-balance-reads';
import { SupplierService } from './supplier.service';

/**
 * `GET /v1/suppliers` with the P3-S7 `search` (PHASE_3_S7_CONTRACT A-09(d),
 * Annex R #25): the strict S4 schema, `limit` 1..100 unchanged, plus a name
 * substring of 1..100 characters after trimming, holding no NUL (L-2).
 */
const SupplierSearchQuerySchema = SupplierListQuerySchema.extend({
  search: searchQueryParam.optional(),
});

/**
 * Suppliers (PHASE_3_S4_CONTRACT A-04, A-11, A-19, A-20).
 *
 * The controller holds no business logic, exactly as the P3-S3 movement
 * controller (`inventory-movements.controller.ts`):
 *
 * - the route guard requires the Phase 3 permission before the body is even
 *   parsed, so a member without it never reaches the service (and so never
 *   the minter). Supplier commands are permission-only: a supplier is
 *   business-wide master data and names no warehouse (TL-4);
 * - the strict DTO is validated by the pipe, and path ids are canonical
 *   lowercase UUIDs (`strictUuidParam`), never lower-cased into acceptance;
 * - the trace id is minted here, once, at the API boundary (P3-AL-35);
 * - the client-chosen supplier id is the idempotency key and is passed on
 *   untouched: a replayed create is not a creation, so it answers 200.
 *
 * Refusals leave the services already typed (`supplier.*` / `purchase.*` /
 * `inventory.*` codes in `error.details`) and the global error filter renders
 * them. Nothing is caught here.
 */
@Controller('/v1/suppliers')
export class SuppliersController {
  constructor(
    @Inject(SupplierService) private readonly suppliers: SupplierService,
    @Inject(PurchasingReadService) private readonly reads: PurchasingReadService,
    @Inject(SupplierBalanceReadService) private readonly balances: SupplierBalanceReadService,
  ) {}

  /** Creates an active supplier at revision 1. */
  @Post()
  @RequiresPermission('suppliers.manage')
  @UsePipes(new ZodValidationPipe(SupplierCreateSchema))
  async create(
    @Membership() m: MembershipContext,
    @Body() body: SupplierCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierCommandResultDto> {
    const result = await this.suppliers.create(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** States the supplier's fields in full, at the revision the client read. Documents keep their snapshots (A-11). */
  @Put(':supplierId')
  @RequiresPermission('suppliers.manage')
  @UsePipes(new ZodValidationPipe(SupplierUpdateSchema))
  async update(
    @Membership() m: MembershipContext,
    @Param('supplierId') supplierId: string,
    @Body() body: SupplierUpdateRequest,
  ): Promise<SupplierCommandResultDto> {
    return this.suppliers.update(m, strictUuidParam(supplierId, 'supplierId'), body, newBusinessTransactionId());
  }

  /** `active → inactive`. There is no delete (A-04). */
  @Post(':supplierId/archive')
  @HttpCode(200)
  @RequiresPermission('suppliers.manage')
  @UsePipes(new ZodValidationPipe(SupplierLifecycleSchema))
  async archive(
    @Membership() m: MembershipContext,
    @Param('supplierId') supplierId: string,
    @Body() body: SupplierLifecycleRequest,
  ): Promise<SupplierCommandResultDto> {
    return this.suppliers.archive(m, strictUuidParam(supplierId, 'supplierId'), body, newBusinessTransactionId());
  }

  /** `inactive → active` (AL-40, TL-3). */
  @Post(':supplierId/reactivate')
  @HttpCode(200)
  @RequiresPermission('suppliers.manage')
  @UsePipes(new ZodValidationPipe(SupplierLifecycleSchema))
  async reactivate(
    @Membership() m: MembershipContext,
    @Param('supplierId') supplierId: string,
    @Body() body: SupplierLifecycleRequest,
  ): Promise<SupplierCommandResultDto> {
    return this.suppliers.reactivate(m, strictUuidParam(supplierId, 'supplierId'), body, newBusinessTransactionId());
  }

  @Get()
  @RequiresPermission('suppliers.view')
  async list(@Membership() m: MembershipContext, @Query() query: unknown): Promise<Page<SupplierDto>> {
    return this.reads.listSuppliers(m, SupplierSearchQuerySchema.parse(query));
  }

  @Get(':supplierId')
  @RequiresPermission('suppliers.view')
  async get(@Membership() m: MembershipContext, @Param('supplierId') supplierId: string): Promise<SupplierDto> {
    return this.reads.getSupplier(m, strictUuidParam(supplierId, 'supplierId'));
  }

  /**
   * The supplier's live AP, derived from the ledger on read (A-20). It sums
   * across every warehouse of the business, so beyond `suppliers.view` it
   * requires business-wide branch scope (TL-4, the F4 opening precedent): an
   * assigned-scope actor is refused before any read, whatever the supplier.
   */
  @Get(':supplierId/payable')
  @RequiresPermission('suppliers.view')
  async payable(@Membership() m: MembershipContext, @Param('supplierId') supplierId: string): Promise<SupplierPayableDto> {
    const id = strictUuidParam(supplierId, 'supplierId');
    if (m.branchScopeMode !== 'all') {
      throw new AppError('FORBIDDEN', 'This read requires business-wide branch scope', 403, { inventoryCode: 'inventory.business_wide_scope_required' });
    }
    return this.reads.supplierPayable(m, id);
  }

  /**
   * The supplier's open purchases in reachable warehouses, oldest first, and
   * with `currency` + `amount` the server's oldest-first payment proposal
   * (PHASE_3_S7_CONTRACT A-09(b)). `suppliers.view` or `suppliers.pay`, which
   * the service checks; the route requires only membership.
   */
  @Get(':supplierId/open-purchases')
  async openPurchases(@Membership() m: MembershipContext, @Param('supplierId') supplierId: string, @Query() query: unknown): Promise<SupplierOpenPurchasesDto> {
    const id = strictUuidParam(supplierId, 'supplierId');
    return this.balances.openPurchases(m, id, SupplierOpenPurchasesQuerySchema.parse(query));
  }
}
