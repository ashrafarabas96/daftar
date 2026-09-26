import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import type { Page, PurchaseCommandResultDto, PurchaseDto, PurchasePayableDto, PurchaseReceiptDto, PurchaseSummaryDto } from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import {
  PurchaseDraftValidationPipe,
  PurchaseListQuerySchema,
  PurchaseTransitionSchema,
  type PurchaseDraftRequest,
  type PurchaseTransitionRequest,
} from './purchasing.schemas';
import { PurchaseDraftService } from './purchase-draft.service';
import { PurchaseReceiptService } from './purchase-receipt.service';
import { PurchasingReadService } from './purchasing-reads';

/**
 * Purchases: draft → received | cancelled (PHASE_3_S4_CONTRACT A-04, A-12,
 * A-19, A-20).
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
 * Refusals leave the services already typed and the global error filter
 * renders them. Nothing is caught here.
 */
@Controller('/v1/purchases')
export class PurchasesController {
  constructor(
    @Inject(PurchaseDraftService) private readonly drafts: PurchaseDraftService,
    @Inject(PurchaseReceiptService) private readonly receipts: PurchaseReceiptService,
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
