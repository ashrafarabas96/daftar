import { BadRequestException, Body, Controller, ForbiddenException, Headers, Inject, Param, Post, UsePipes } from '@nestjs/common';
import type { z } from 'zod';
import type {
  AccountingAdjustmentCreateDto,
  AccountingEntryRefDto,
  AccountingFxRateCreateDto,
  AccountingFxRateRefDto,
  AccountingOpeningBalanceCreateDto,
  AccountingReversalCreateDto,
} from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import { getContext } from '../../infra/request-context';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { AccountingSourcesService } from './accounting-sources.service';
import { AccountingFxService } from './accounting-fx.service';
import {
  AccountingAdjustmentCreateSchema,
  AccountingFxRateCreateSchema,
  AccountingOpeningBalanceCreateSchema,
  AccountingReversalCreateSchema,
} from './accounting.schemas';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The ENTIRE merchant accounting write surface (§35).
 *
 * Four routes. Three create journal facts; the fourth, added by P2-S5,
 * configures an exchange rate and creates none.
 *
 * There is still no generic `/accounting/post`, no chart editor, no period
 * endpoint and no merchant accounting UI, and their absence is the point: a
 * generic posting endpoint would let a client state any source type it liked,
 * and the whole design of this surface is that each command is narrow and
 * carries its own rules.
 *
 * The business in the path must be the business the membership resolved. A
 * mismatch is refused rather than quietly re-scoped: a caller that believed
 * it was writing elsewhere has a bug worth surfacing, and in a ledger that
 * bug is money in the wrong company's books.
 */
@Controller('/v1/businesses/:businessId/accounting')
export class AccountingController {
  constructor(
    @Inject(AccountingSourcesService) private readonly sources: AccountingSourcesService,
    @Inject(AccountingFxService) private readonly fx: AccountingFxService,
  ) {}

  @Post('adjustments')
  @RequiresPermission('accounting.post')
  @UsePipes(new ZodValidationPipe(AccountingAdjustmentCreateSchema))
  async createAdjustment(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AccountingEntryRefDto> {
    sameBusiness(m, businessId);
    const dto = body as z.infer<typeof AccountingAdjustmentCreateSchema> & AccountingAdjustmentCreateDto;
    return this.sources.postAdjustment(m, dto, requireIdempotencyKey(idempotencyKey), requestId());
  }

  /**
   * `accounting.reverse`, and not `accounting.post`. Undoing a posted fact is
   * a different authority from making one, and there is no fallback between
   * them at any layer: the guard below, the service and the database's own
   * operation kind all say `reverse` independently.
   */
  @Post('entries/:entryId/reversals')
  @RequiresPermission('accounting.reverse')
  @UsePipes(new ZodValidationPipe(AccountingReversalCreateSchema))
  async createReversal(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Param('entryId') entryId: string,
    @Body() body: unknown,
  ): Promise<AccountingEntryRefDto> {
    sameBusiness(m, businessId);
    if (!UUID_RE.test(entryId)) throw new BadRequestException('Invalid entry id');
    const dto = body as z.infer<typeof AccountingReversalCreateSchema> & AccountingReversalCreateDto;
    return this.sources.postReversal(m, entryId, dto, requestId());
  }

  @Post('opening-balance')
  @RequiresPermission('accounting.post')
  @UsePipes(new ZodValidationPipe(AccountingOpeningBalanceCreateSchema))
  async createOpeningBalance(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AccountingEntryRefDto> {
    sameBusiness(m, businessId);
    const dto = body as z.infer<typeof AccountingOpeningBalanceCreateSchema> & AccountingOpeningBalanceCreateDto;
    return this.sources.postOpeningBalance(m, dto, requireIdempotencyKey(idempotencyKey), requestId());
  }

  /**
   * Enter a manual exchange rate (P2-S5 §38).
   *
   * `accounting.fx.manage`, and not `accounting.post`: configuring the rate
   * every future posting will be measured against is a different authority
   * from recording one fact, and there is no fallback between them.
   *
   * The service additionally requires business-wide branch authority, which
   * the guard cannot express: a rate applies to every branch, so a member
   * restricted to one of them may not set it even holding the permission.
   */
  @Post('fx-rates')
  @RequiresPermission('accounting.fx.manage')
  @UsePipes(new ZodValidationPipe(AccountingFxRateCreateSchema))
  async enterFxRate(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AccountingFxRateRefDto> {
    sameBusiness(m, businessId);
    const dto = body as z.infer<typeof AccountingFxRateCreateSchema> & AccountingFxRateCreateDto;
    return this.fx.enterRate(m, dto, requireIdempotencyKey(idempotencyKey), requestId());
  }
}

function sameBusiness(m: MembershipContext, businessId: string): void {
  if (!UUID_RE.test(businessId) || businessId.toLowerCase() !== m.businessId.toLowerCase()) {
    throw new ForbiddenException('an accounting command may only be raised for the business the membership resolved');
  }
}

/**
 * The `Idempotency-Key` is REQUIRED on the three endpoints that create new
 * durable accounting truth, and that is a deliberate contract rather than a
 * convenience. Without it there is no stable source identity, so a retried
 * request after a timeout would post the same money twice — and a client
 * cannot tell a lost response from a lost request. Making the key optional
 * would make that outcome optional too.
 *
 * A reversal takes no key: its source identity is the original entry's id, so
 * it is already idempotent by construction.
 */
function requireIdempotencyKey(value: string | undefined): string {
  const key = (value ?? '').trim();
  if (key.length < 8 || key.length > 200) {
    throw new BadRequestException('an Idempotency-Key header of 8 to 200 characters is required for this command');
  }
  return key;
}

/** Narrative only: the request id is stored for tracing and is never a source identity. */
function requestId(): string | null {
  return getContext()?.requestId ?? null;
}
