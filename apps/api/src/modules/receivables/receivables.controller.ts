import { Body, Controller, Get, Inject, Param, Post, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { Membership } from '../../common/guards';
import { ZodValidationPipe } from '../../common/validation';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { CustomerCreditApplicationService } from './customer-credit-application.service';
import { CustomerPaymentService } from './customer-payment.service';
import type { CustomerCreditApplicationResultDto, CustomerCreditDto, CustomerPaymentDto, CustomerPaymentResultDto } from './receivables-contracts';
import { phase4ReceivablesPermission } from './receivables-permissions';
import { ReceivablesReadService } from './receivables-reads';
import {
  CustomerCreditApplicationSchema,
  CustomerPaymentSchema,
  type CustomerCreditApplicationRequest,
  type CustomerPaymentRequest,
} from './receivables.schemas';

/**
 * The P4-S4 receivables surface: collecting a customer payment, applying a
 * customer credit, and the reads of what they wrote.
 *
 * **The controller holds NO business logic and NO ARITHMETIC**, exactly as the
 * accepted `SupplierSettlementsController` and `SalesController` hold none:
 *
 * - the route guard requires its one permission BEFORE the body is parsed —
 *   `payments.collect` for both COMMANDS, and `receivables.view` for both
 *   READS, the payment read included. This header used to name
 *   `payments.collect` for the payment read as well, which the route has not
 *   done since the reasoning in `getPayment`'s own comment below: a read is
 *   not gated on a write key. `phase4ReceivablesPermission`
 *   narrows the decorator to the two registered keys, so a typo or an invented
 *   thirteenth key does not compile;
 * - the service then authorizes the OPERATION CODE through
 *   `InventoryAuthorizationService`, which is the only issuer of a minting
 *   proof. Two layers, two different questions: may this request in, and may
 *   this call sign;
 * - the strict DTO is validated by the pipe, and path ids are canonical
 *   lowercase UUIDs (`strictUuidParam`) — never lower-cased into acceptance,
 *   because the intent digest binds the exact spelling;
 * - the trace id is minted HERE, once, at the API boundary (P3-AL-35);
 * - the client-chosen payment, allocation, credit and application ids are the
 *   idempotency keys: 201 on create, 200 on replay. There is no
 *   `idempotencyKey` header and no server-minted id.
 *
 * Not a single minor unit is added, compared or converted in this file.
 * Refusals leave the services already typed and the global error filter
 * renders them; nothing is caught here.
 */
@Controller('/v1')
export class ReceivablesController {
  constructor(
    @Inject(CustomerPaymentService) private readonly payments: CustomerPaymentService,
    @Inject(CustomerCreditApplicationService) private readonly creditApplications: CustomerCreditApplicationService,
    @Inject(ReceivablesReadService) private readonly reads: ReceivablesReadService,
  ) {}

  /**
   * Collect a customer payment and allocate it across 0..50 of the customer's
   * open invoices; any surplus becomes a customer credit.
   *
   * ZERO allocations is a legal body (OQ-4): a pure on-account payment, whose
   * whole amount becomes the credit named by `creditId`.
   */
  @Post('customer-payments')
  @phase4ReceivablesPermission('payments.collect')
  @UsePipes(new ZodValidationPipe(CustomerPaymentSchema))
  async collect(
    @Membership() m: MembershipContext,
    @Body() body: CustomerPaymentRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerPaymentResultDto> {
    const result = await this.payments.collect(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /**
   * Apply an existing customer credit to one of that customer's open
   * invoices. The credit is the path, so it is not in the body: one identity,
   * one place.
   */
  @Post('customer-credits/:creditId/applications')
  @phase4ReceivablesPermission('payments.collect')
  @UsePipes(new ZodValidationPipe(CustomerCreditApplicationSchema))
  async applyCredit(
    @Membership() m: MembershipContext,
    @Param('creditId') creditId: string,
    @Body() body: CustomerCreditApplicationRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerCreditApplicationResultDto> {
    const result = await this.creditApplications.apply(m, strictUuidParam(creditId, 'creditId'), body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /**
   * One stored payment with its allocations and the credit it created.
   *
   * A READ is gated on the READ key, never on the write key that produced the
   * row. Both accepted precedents do this: the settlement mirror writes under
   * `suppliers.pay` and reads under `suppliers.view`
   * (`supplier-settlements.controller.ts`), and the sale writes under
   * `sales.create` and reads under `sales.view` (`sales.controller.ts`).
   * Gating this on `payments.collect` had two wrong consequences at once — a
   * manager holding `receivables.view` could not read a payment whose credits
   * they could already list, and every cashier (for whom `payments.collect` is
   * a role default) gained read of every stored payment.
   */
  @Get('customer-payments/:paymentId')
  @phase4ReceivablesPermission('receivables.view')
  async getPayment(@Membership() m: MembershipContext, @Param('paymentId') paymentId: string): Promise<CustomerPaymentDto> {
    return this.reads.getCustomerPayment(m, strictUuidParam(paymentId, 'paymentId'));
  }

  /** A customer's credits, newest first. A credit balance is a receivable-surface read, and business-wide. */
  @Get('customers/:customerId/credits')
  @phase4ReceivablesPermission('receivables.view')
  async listCredits(@Membership() m: MembershipContext, @Param('customerId') customerId: string): Promise<readonly CustomerCreditDto[]> {
    return this.reads.listCustomerCredits(m, strictUuidParam(customerId, 'customerId'));
  }
}
