import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import type { ListDto, PaymentMethodCommandResultDto, PaymentMethodDto } from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import { PaymentMethodService } from './payment-method.service';
import {
  PaymentMethodCreateSchema,
  PaymentMethodLifecycleSchema,
  PaymentMethodUpdateSchema,
  type PaymentMethodCreateRequest,
  type PaymentMethodLifecycleRequest,
  type PaymentMethodUpdateRequest,
} from './payment-methods.schemas';

/**
 * Payment methods (PHASE_3_S6_CONTRACT A-06, A-18).
 *
 * The controller holds no business logic, exactly as `SuppliersController`:
 *
 * - every command requires `accounting.chart.manage` at the route guard,
 *   before the body is even parsed, so a member without it never reaches the
 *   service (and so never the minter). A method is business-wide master data
 *   and names no warehouse: the commands are permission-only (A-03);
 * - the two reads admit ANY of `suppliers.pay`, `accounting.view` or
 *   `accounting.chart.manage` (A-18). The route guard takes one permission,
 *   so these routes require the business context only (`@Membership()`
 *   refuses without it) and the service decides the any-of rule — and
 *   whether the reader may see the posting account — before any read;
 * - the strict DTO is validated by the pipe; path ids are canonical lowercase
 *   uuids (`strictUuidParam`);
 * - the trace id is minted here, once (P3-AL-35); the client-chosen method id
 *   is the idempotency key: a replayed create is not a creation, so 200.
 *
 * There is no delete route: a method is never deleted (A-04, MP-2).
 * Refusals leave the service already typed; nothing is caught here.
 */
@Controller('/v1/payment-methods')
export class PaymentMethodsController {
  constructor(@Inject(PaymentMethodService) private readonly methods: PaymentMethodService) {}

  /** Creates an active method at revision 1. */
  @Post()
  @RequiresPermission('accounting.chart.manage')
  @UsePipes(new ZodValidationPipe(PaymentMethodCreateSchema))
  async create(
    @Membership() m: MembershipContext,
    @Body() body: PaymentMethodCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentMethodCommandResultDto> {
    const result = await this.methods.create(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** States the method in full at the revision the client read. `systemType` is immutable; the account changes only while unused (A-06). */
  @Put(':paymentMethodId')
  @RequiresPermission('accounting.chart.manage')
  @UsePipes(new ZodValidationPipe(PaymentMethodUpdateSchema))
  async update(
    @Membership() m: MembershipContext,
    @Param('paymentMethodId') paymentMethodId: string,
    @Body() body: PaymentMethodUpdateRequest,
  ): Promise<PaymentMethodCommandResultDto> {
    return this.methods.update(m, strictUuidParam(paymentMethodId, 'paymentMethodId'), body, newBusinessTransactionId());
  }

  /** `active → inactive`: a new payment or refund can no longer name it. Posted entries are untouched (A-06). */
  @Post(':paymentMethodId/deactivate')
  @HttpCode(200)
  @RequiresPermission('accounting.chart.manage')
  @UsePipes(new ZodValidationPipe(PaymentMethodLifecycleSchema))
  async deactivate(
    @Membership() m: MembershipContext,
    @Param('paymentMethodId') paymentMethodId: string,
    @Body() body: PaymentMethodLifecycleRequest,
  ): Promise<PaymentMethodCommandResultDto> {
    return this.methods.deactivate(m, strictUuidParam(paymentMethodId, 'paymentMethodId'), body, newBusinessTransactionId());
  }

  /** `inactive → active`, re-checking the account (MP-1). */
  @Post(':paymentMethodId/activate')
  @HttpCode(200)
  @RequiresPermission('accounting.chart.manage')
  @UsePipes(new ZodValidationPipe(PaymentMethodLifecycleSchema))
  async activate(
    @Membership() m: MembershipContext,
    @Param('paymentMethodId') paymentMethodId: string,
    @Body() body: PaymentMethodLifecycleRequest,
  ): Promise<PaymentMethodCommandResultDto> {
    return this.methods.activate(m, strictUuidParam(paymentMethodId, 'paymentMethodId'), body, newBusinessTransactionId());
  }

  @Get()
  async list(@Membership() m: MembershipContext): Promise<ListDto<PaymentMethodDto>> {
    return this.methods.list(m);
  }

  @Get(':paymentMethodId')
  async get(@Membership() m: MembershipContext, @Param('paymentMethodId') paymentMethodId: string): Promise<PaymentMethodDto> {
    return this.methods.get(m, strictUuidParam(paymentMethodId, 'paymentMethodId'));
  }
}
