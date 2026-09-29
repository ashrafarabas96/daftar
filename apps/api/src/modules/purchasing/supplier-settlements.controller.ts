import { Body, Controller, Get, Inject, Param, Post, Query, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import type {
  Page,
  PurchaseSettlementsDto,
  SupplierCreditAllocationResultDto,
  SupplierPaymentDto,
  SupplierPaymentResultDto,
  SupplierRefundResultDto,
} from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import { ZodValidationPipe } from '../../common/validation';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { PurchasingReadService } from './purchasing-reads';
import {
  SupplierCreditAllocationSchema,
  SupplierPaymentListQuerySchema,
  SupplierPaymentValidationPipe,
  SupplierRefundSchema,
  type SupplierCreditAllocationRequest,
  type SupplierPaymentRequest,
  type SupplierRefundRequest,
} from './purchasing.schemas';
import { SupplierCreditAllocationService } from './supplier-credit-allocation.service';
import { SupplierPaymentService } from './supplier-payment.service';
import { SupplierRefundService } from './supplier-refund.service';

/**
 * Supplier settlement (PHASE_3_S6_CONTRACT A-07 – A-11, A-18): payments,
 * credit allocations and refunds, and their reads.
 *
 * The controller holds no business logic, exactly as the S4/S5 purchasing
 * controllers:
 *
 * - the route guard requires `suppliers.pay` (commands) or `suppliers.view`
 *   (reads) before the body is parsed; the service then authorizes the op
 *   code — a payment over EVERY allocated purchase's warehouse, a credit
 *   allocation or a refund business-wide (TL-5) — and a read filters by the
 *   actor's warehouse scope (A-18);
 * - the strict DTO is validated by the pipe (a payment's allocation rules,
 *   `supplier_payment.allocations_invalid`, included), and path ids are
 *   canonical lowercase UUIDs;
 * - the trace id is minted here, once, at the API boundary (P3-AL-35);
 * - the client-chosen payment, allocation or refund id is the idempotency
 *   key: 201 on create, 200 on replay.
 *
 * Refusals leave the services already typed and the global error filter
 * renders them. Nothing is caught here.
 */
@Controller('/v1')
export class SupplierSettlementsController {
  constructor(
    @Inject(SupplierPaymentService) private readonly payments: SupplierPaymentService,
    @Inject(SupplierCreditAllocationService) private readonly creditAllocations: SupplierCreditAllocationService,
    @Inject(SupplierRefundService) private readonly refunds: SupplierRefundService,
    @Inject(PurchasingReadService) private readonly reads: PurchasingReadService,
  ) {}

  /** A supplier payment over 1..50 of its received purchases, fully allocated (A-07). */
  @Post('supplier-payments')
  @RequiresPermission('suppliers.pay')
  @UsePipes(new SupplierPaymentValidationPipe())
  async pay(
    @Membership() m: MembershipContext,
    @Body() body: SupplierPaymentRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierPaymentResultDto> {
    const result = await this.payments.pay(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** A supplier credit note applied to one of its received purchases (A-10). */
  @Post('supplier-credit-allocations')
  @RequiresPermission('suppliers.pay')
  @UsePipes(new ZodValidationPipe(SupplierCreditAllocationSchema))
  async allocateCredit(
    @Membership() m: MembershipContext,
    @Body() body: SupplierCreditAllocationRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierCreditAllocationResultDto> {
    const result = await this.creditAllocations.allocate(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** Money a supplier returns against its credit note (A-10). */
  @Post('supplier-refunds')
  @RequiresPermission('suppliers.pay')
  @UsePipes(new ZodValidationPipe(SupplierRefundSchema))
  async receiveRefund(
    @Membership() m: MembershipContext,
    @Body() body: SupplierRefundRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierRefundResultDto> {
    const result = await this.refunds.receive(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** One stored payment, visible only with scope over every warehouse it touches. */
  @Get('supplier-payments/:paymentId')
  @RequiresPermission('suppliers.view')
  async getPayment(@Membership() m: MembershipContext, @Param('paymentId') paymentId: string): Promise<SupplierPaymentDto> {
    return this.reads.getSupplierPayment(m, strictUuidParam(paymentId, 'paymentId'));
  }

  /** A supplier's payments, newest first; business-wide (the S5 A-19 precedent). */
  @Get('suppliers/:supplierId/payments')
  @RequiresPermission('suppliers.view')
  async listPayments(@Membership() m: MembershipContext, @Param('supplierId') supplierId: string, @Query() query: unknown): Promise<Page<SupplierPaymentDto>> {
    return this.reads.listSupplierPayments(m, strictUuidParam(supplierId, 'supplierId'), SupplierPaymentListQuerySchema.parse(query));
  }

  /** A purchase's payment and credit allocations, oldest first. */
  @Get('purchases/:purchaseId/settlements')
  @RequiresPermission('suppliers.view')
  async purchaseSettlements(@Membership() m: MembershipContext, @Param('purchaseId') purchaseId: string): Promise<PurchaseSettlementsDto> {
    return this.reads.purchaseSettlements(m, strictUuidParam(purchaseId, 'purchaseId'));
  }
}
