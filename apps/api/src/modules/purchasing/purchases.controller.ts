import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import type {
  Page,
  PurchaseCommandResultDto,
  PurchaseDto,
  PurchasePayableDto,
  PurchaseReceiptDto,
  PurchaseReversalResultDto,
  PurchaseSummaryDto,
  SupplierReturnDto,
  SupplierReturnResultDto,
} from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import {
  PurchaseDraftValidationPipe,
  PurchaseListQuerySchema,
  PurchaseReversalValidationPipe,
  PurchaseTransitionSchema,
  SupplierReturnListQuerySchema,
  SupplierReturnValidationPipe,
  type PurchaseDraftRequest,
  type PurchaseReversalRequest,
  type PurchaseTransitionRequest,
  type SupplierReturnRequest,
} from './purchasing.schemas';
import { PurchaseDraftService } from './purchase-draft.service';
import { PurchaseReceiptService } from './purchase-receipt.service';
import { PurchaseReturnService } from './purchase-return.service';
import { PurchaseReversalService } from './purchase-reversal.service';
import { PurchasingReadService } from './purchasing-reads';

/**
 * Purchases: draft → received | cancelled (PHASE_3_S4_CONTRACT A-04, A-12,
 * A-19, A-20), and received → reversed (PHASE_3_S5_CONTRACT A-04, A-09).
 *
 * The controller holds no business logic, exactly as the P3-S3 movement
 * controller (`inventory-movements.controller.ts`):
 *
 * - the route guard requires the Phase 3 permission before the body is even
 *   parsed; the service then authorizes the op code over the draft's
 *   warehouse (and, when a replace moves the draft, the previous one), and a
 *   read filters by the actor's warehouse scope (A-19);
 * - the strict DTO is validated by the pipe, and path ids are canonical
 *   lowercase UUIDs (`strictUuidParam`). The draft's pipe also refuses a
 *   non-zero `taxAmount` with `purchase.tax_policy_absent` before the service
 *   is reached (A-12, BLOCKED BY OD-03);
 * - the trace id is minted here, once, at the API boundary (P3-AL-35);
 * - the client-chosen purchase id is the idempotency key and is passed on
 *   untouched. Only a first save of a new draft is a creation (201); a
 *   replace or a replay answers 200.
 *
 * P3-S5 adds the two commands on a received purchase and the purchase's
 * returns (PHASE_3_S5_CONTRACT A-03, A-19), on the same rules:
 *
 * - a supplier return requires `purchases.return` at the route; the service
 *   then authorizes `purchase.return` over the body's `warehouseId`, the
 *   warehouse the goods leave, and over that warehouse only (TL-5). The
 *   client-chosen return id is the idempotency key: 201 on create, 200 on
 *   replay;
 * - a purchase reversal requires `purchases.receive` at the route (undoing a
 *   receipt is receipt authority, TL-4); the service then authorizes
 *   `purchase.reverse` over the purchase's warehouse. Its identity is the
 *   purchase, so it answers 200 like the receipt it undoes. The reason is
 *   mandatory, refused at the DTO when absent or blank
 *   (`purchase_reversal.reason_required`);
 * - neither request carries an amount, a rate or a tax field (A-07, A-14:
 *   BLOCKED BY OD-03); a stated one is an unknown key.
 *
 * Refusals leave the services already typed and the global error filter
 * renders them. Nothing is caught here.
 */
@Controller('/v1/purchases')
export class PurchasesController {
  constructor(
    @Inject(PurchaseDraftService) private readonly drafts: PurchaseDraftService,
    @Inject(PurchaseReceiptService) private readonly receipts: PurchaseReceiptService,
    @Inject(PurchaseReturnService) private readonly returns: PurchaseReturnService,
    @Inject(PurchaseReversalService) private readonly reversals: PurchaseReversalService,
    @Inject(PurchasingReadService) private readonly reads: PurchasingReadService,
  ) {}

  /** Creates (`expectedRevision: 0`) or replaces in full a draft. A draft moves no stock and posts nothing (L:737). */
  @Put(':purchaseId')
  @RequiresPermission('purchases.manage')
  @UsePipes(new PurchaseDraftValidationPipe())
  async saveDraft(
    @Membership() m: MembershipContext,
    @Param('purchaseId') purchaseId: string,
    @Body() body: PurchaseDraftRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseCommandResultDto> {
    const result = await this.drafts.saveDraft(m, strictUuidParam(purchaseId, 'purchaseId'), body, newBusinessTransactionId());
    res.status(!result.replayed && body.expectedRevision === 0 ? 201 : 200);
    return result;
  }

  /** `draft → received`: the stock, the `Dr Inventory / Cr AP` entry and any deficit coverage, atomically (A-05–A-08). */
  @Post(':purchaseId/receive')
  @HttpCode(200)
  @RequiresPermission('purchases.receive')
  @UsePipes(new ZodValidationPipe(PurchaseTransitionSchema))
  async receive(
    @Membership() m: MembershipContext,
    @Param('purchaseId') purchaseId: string,
    @Body() body: PurchaseTransitionRequest,
  ): Promise<PurchaseReceiptDto> {
    return this.receipts.receive(m, strictUuidParam(purchaseId, 'purchaseId'), body, newBusinessTransactionId());
  }

  /** `draft → cancelled`. Nothing moves and nothing posts. */
  @Post(':purchaseId/cancel')
  @HttpCode(200)
  @RequiresPermission('purchases.manage')
  @UsePipes(new ZodValidationPipe(PurchaseTransitionSchema))
  async cancel(
    @Membership() m: MembershipContext,
    @Param('purchaseId') purchaseId: string,
    @Body() body: PurchaseTransitionRequest,
  ): Promise<PurchaseCommandResultDto> {
    return this.drafts.cancel(m, strictUuidParam(purchaseId, 'purchaseId'), body, newBusinessTransactionId());
  }

  /**
   * A supplier return of a received purchase: the goods leave the named
   * warehouse at its current average, AP first and any excess as a supplier
   * credit note, in one `supplier_return` entry (S5 A-10 – A-13).
   */
  @Post(':purchaseId/returns')
  @RequiresPermission('purchases.return')
  @UsePipes(new SupplierReturnValidationPipe())
  async createReturn(
    @Membership() m: MembershipContext,
    @Param('purchaseId') purchaseId: string,
    @Body() body: SupplierReturnRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierReturnResultDto> {
    const result = await this.returns.createReturn(m, strictUuidParam(purchaseId, 'purchaseId'), body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /**
   * `received → reversed`: the inverse movements at the original receipt cost
   * and the Phase 2 reversal of the purchase entry, atomically, only when all
   * four preconditions hold (S5 A-09).
   */
  @Post(':purchaseId/reversal')
  @HttpCode(200)
  @RequiresPermission('purchases.receive')
  @UsePipes(new PurchaseReversalValidationPipe())
  async reverse(
    @Membership() m: MembershipContext,
    @Param('purchaseId') purchaseId: string,
    @Body() body: PurchaseReversalRequest,
  ): Promise<PurchaseReversalResultDto> {
    return this.reversals.reverse(m, strictUuidParam(purchaseId, 'purchaseId'), body, newBusinessTransactionId());
  }

  /** The purchase's supplier returns, as stored (S5 A-19). */
  @Get(':purchaseId/returns')
  @RequiresPermission('purchases.view')
  async listReturns(@Membership() m: MembershipContext, @Param('purchaseId') purchaseId: string, @Query() query: unknown): Promise<Page<SupplierReturnDto>> {
    const id = strictUuidParam(purchaseId, 'purchaseId');
    return this.reads.listPurchaseReturns(m, id, SupplierReturnListQuerySchema.parse(query));
  }

  @Get()
  @RequiresPermission('purchases.view')
  async list(@Membership() m: MembershipContext, @Query() query: unknown): Promise<Page<PurchaseSummaryDto>> {
    return this.reads.listPurchases(m, PurchaseListQuerySchema.parse(query));
  }

  @Get(':purchaseId')
  @RequiresPermission('purchases.view')
  async get(@Membership() m: MembershipContext, @Param('purchaseId') purchaseId: string): Promise<PurchaseDto> {
    return this.reads.getPurchase(m, strictUuidParam(purchaseId, 'purchaseId'));
  }

  /** The purchase's live AP, derived from the ledger on read (A-20). */
  @Get(':purchaseId/payable')
  @RequiresPermission('purchases.view')
  async payable(@Membership() m: MembershipContext, @Param('purchaseId') purchaseId: string): Promise<PurchasePayableDto> {
    return this.reads.purchasePayable(m, strictUuidParam(purchaseId, 'purchaseId'));
  }
}
