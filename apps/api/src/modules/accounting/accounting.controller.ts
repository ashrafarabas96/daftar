import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Param, Post, Query, UsePipes } from '@nestjs/common';
import type { z } from 'zod';
import type {
  AccountingAccountListDto,
  AccountingAdjustmentCreateDto,
  AccountingBalanceListDto,
  AccountingEntryDetailDto,
  AccountingEntryListDto,
  AccountingEntryRefDto,
  AccountingFxRateCreateDto,
  AccountingFxRateRefDto,
  AccountingLedgerDto,
  AccountingOpeningBalanceCreateDto,
  AccountingPeriodCreateDto,
  AccountingPeriodListDto,
  AccountingPeriodRefDto,
  AccountingPeriodReopenDto,
  AccountingReversalCreateDto,
  AccountingTrialBalanceDto,
} from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import { getContext } from '../../infra/request-context';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { AccountingSourcesService } from './accounting-sources.service';
import { AccountingFxService } from './accounting-fx.service';
import { AccountingPeriodsService } from './accounting-periods.service';
import { AccountingReportsService } from './accounting-reports.service';
import {
  AccountingAccountsQuerySchema,
  AccountingAdjustmentCreateSchema,
  AccountingBalancesQuerySchema,
  AccountingEntriesQuerySchema,
  AccountingFxRateCreateSchema,
  AccountingLedgerQuerySchema,
  AccountingOpeningBalanceCreateSchema,
  AccountingPeriodCreateSchema,
  AccountingPeriodReopenSchema,
  AccountingReversalCreateSchema,
  AccountingTrialBalanceQuerySchema,
} from './accounting.schemas';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The ENTIRE merchant accounting surface (§29-§32).
 *
 * Eight routes. Three create journal facts, one configures an exchange rate,
 * three manage accounting periods, and one reads them back.
 *
 * There is still no generic `/accounting/post`, no chart editor and no
 * merchant accounting UI, and their absence is the point: a generic posting
 * endpoint would let a client state any source type it liked, and the whole
 * design of this surface is that each command is narrow and carries its own
 * rules.
 *
 * There is also NO generic period PATCH. A period's boundaries are immutable
 * and its state changes only through the two named transitions below, so an
 * endpoint that accepted a partial period would be an endpoint whose contract
 * the database refuses most of (§15).
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
    @Inject(AccountingPeriodsService) private readonly periods: AccountingPeriodsService,
    @Inject(AccountingReportsService) private readonly reports: AccountingReportsService,
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

  /**
   * Create an accounting period (§29).
   *
   * THE FIRST ONE ACTIVATES period-managed posting for the business. Before
   * it, every date rule is exactly what P2-S3 established; after it, a new
   * entry must be dated inside an open period. Nothing existing is rewritten.
   *
   * The service additionally requires business-wide branch authority, which
   * the guard cannot express: a period governs every branch, so a member
   * restricted to one of them may not create it even holding the permission.
   */
  @Post('periods')
  @RequiresPermission('accounting.period.manage')
  @UsePipes(new ZodValidationPipe(AccountingPeriodCreateSchema))
  async createPeriod(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AccountingPeriodRefDto> {
    sameBusiness(m, businessId);
    const dto = body as z.infer<typeof AccountingPeriodCreateSchema> & AccountingPeriodCreateDto;
    return this.periods.create(m, dto, requireIdempotencyKey(idempotencyKey), requestId());
  }

  /**
   * Close a period (§30).
   *
   * The body is empty by design: there is nothing about a close for a client
   * to state. Who closed it comes from the verified authority and when comes
   * from the database clock, so neither can be back-dated by a caller.
   */
  @Post('periods/:periodId/close')
  @RequiresPermission('accounting.period.manage')
  async closePeriod(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Param('periodId') periodId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AccountingPeriodRefDto> {
    sameBusiness(m, businessId);
    if (!UUID_RE.test(periodId)) throw new BadRequestException('Invalid period id');
    return this.periods.close(m, periodId.toLowerCase(), requireIdempotencyKey(idempotencyKey), requestId());
  }

  /**
   * Reopen a closed period (§31).
   *
   * `accounting.period.reopen`, and NOT `accounting.period.manage`: undoing a
   * close is a different decision from making one, and there is no fallback
   * between them at any layer. The reason is mandatory.
   */
  @Post('periods/:periodId/reopen')
  @RequiresPermission('accounting.period.reopen')
  @UsePipes(new ZodValidationPipe(AccountingPeriodReopenSchema))
  async reopenPeriod(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Param('periodId') periodId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AccountingPeriodRefDto> {
    sameBusiness(m, businessId);
    if (!UUID_RE.test(periodId)) throw new BadRequestException('Invalid period id');
    const dto = body as z.infer<typeof AccountingPeriodReopenSchema> & AccountingPeriodReopenDto;
    return this.periods.reopen(m, periodId.toLowerCase(), dto, requireIdempotencyKey(idempotencyKey), requestId());
  }

  /**
   * List the business's periods (§32).
   *
   * `accounting.view`, because reading never corrupts a ledger, and no
   * business-wide requirement: a branch manager may need to know which months
   * are closed even though they may not close one. The response is an OBJECT
   * with `items`, never a bare array, and it carries no assertion, no
   * internal operation id and no audit internals.
   */
  @Get('periods')
  @RequiresPermission('accounting.view')
  async listPeriods(@Membership() m: MembershipContext, @Param('businessId') businessId: string): Promise<AccountingPeriodListDto> {
    sameBusiness(m, businessId);
    const items = await this.periods.list(m);
    return {
      items: items.map((p) => ({
        periodId: p.periodId,
        startDate: p.startDate,
        endDate: p.endDate,
        status: p.status,
        closedAt: p.closedAt,
        lastReopenedAt: p.lastReopenedAt,
      })),
    };
  }

  // ── The financial reads (P2-S7 §18) ─────────────────────────────────────
  //
  // Six routes, every one a GET, every one requiring `accounting.view`, and
  // not one of them capable of changing a number. There is no POST balance,
  // no PATCH ledger, no `setBalance` and no `recalculate`: a balance in DAFTAR
  // is derived from the journal at the moment it is asked for, so there is
  // nothing to set (AL-15).
  //
  // The query schemas are `.strict()` like every payload schema above, and a
  // refusal is a 400 before any query is built. Branch scope is not among the
  // things a query decides: `branchId` here is a REQUEST, checked against the
  // membership in the service before it can reach a predicate.

  /**
   * The chart of accounts.
   *
   * Inactive accounts are INCLUDED by default. `is_active` governs whether an
   * account may receive NEW postings, not whether the history written in it
   * exists, and a chart read that hid them would hide the accounts a
   * merchant's own past is denominated in (§19, §33).
   */
  @Get('accounts')
  @RequiresPermission('accounting.view')
  async listAccounts(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AccountingAccountListDto> {
    sameBusiness(m, businessId);
    return this.reports.accounts(m, AccountingAccountsQuerySchema.parse(query));
  }

  /**
   * The journal-entry list — keyset paginated, never OFFSET (§20).
   *
   * Summary fields only. There is deliberately no entry-level total: an
   * entry's money lives on its lines, and a total invented at the header
   * would be a second figure that can disagree with them.
   */
  @Get('entries')
  @RequiresPermission('accounting.view')
  async listEntries(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AccountingEntryListDto> {
    sameBusiness(m, businessId);
    return this.reports.entries(m, AccountingEntriesQuerySchema.parse(query));
  }

  /**
   * One journal entry, with every line and the FX snapshot each line was
   * posted with (§21).
   *
   * The rate rendered here is the rate that was POSTED. No report in this
   * slice calls the FX lookup: a rate entered tomorrow must never change
   * yesterday's entry, and the only way to be certain is never to ask.
   */
  @Get('entries/:entryId')
  @RequiresPermission('accounting.view')
  async readEntry(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Param('entryId') entryId: string,
  ): Promise<AccountingEntryDetailDto> {
    sameBusiness(m, businessId);
    if (!UUID_RE.test(entryId)) throw new BadRequestException('Invalid entry id');
    return this.reports.entry(m, entryId.toLowerCase());
  }

  /**
   * The trial balance (§22-§24).
   *
   * `asOf` or `from`+`to`, never both. A whole-business report that does not
   * balance is REFUSED rather than rendered; a branch-filtered one is labelled
   * a dimensional view and reports `isBalanced` honestly, because one entry
   * may carry different branches on different lines and a slice of a sound
   * ledger need not balance.
   */
  @Get('trial-balance')
  @RequiresPermission('accounting.view')
  async trialBalance(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AccountingTrialBalanceDto> {
    sameBusiness(m, businessId);
    return this.reports.trialBalance(m, AccountingTrialBalanceQuerySchema.parse(query));
  }

  /**
   * The general ledger for ONE account over an inclusive range (§26-§29).
   *
   * The opening figure is everything posted strictly before `from`; the rows
   * are ordered `(entryDate, entryId, lineNo)` and paginated on that exact
   * tuple, so a page boundary inside a busy date neither repeats nor skips a
   * row.
   */
  @Get('ledger')
  @RequiresPermission('accounting.view')
  async ledger(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AccountingLedgerDto> {
    sameBusiness(m, businessId);
    return this.reports.ledger(m, AccountingLedgerQuerySchema.parse(query));
  }

  /**
   * Account balances as of an inclusive date (§31).
   *
   * `asOf` is REQUIRED and every row repeats it. A balance without the instant
   * it is true at is a number somebody will quote in another context next
   * week, and the omission is what makes that possible.
   */
  @Get('balances')
  @RequiresPermission('accounting.view')
  async balances(
    @Membership() m: MembershipContext,
    @Param('businessId') businessId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AccountingBalanceListDto> {
    sameBusiness(m, businessId);
    const parsed = AccountingBalancesQuerySchema.parse(query);
    const accountIds = parsed.accountId === undefined ? null : Array.isArray(parsed.accountId) ? parsed.accountId : [parsed.accountId];
    return this.reports.balances(m, { ...parsed, accountIds });
  }
}

function sameBusiness(m: MembershipContext, businessId: string): void {
  if (!UUID_RE.test(businessId) || businessId.toLowerCase() !== m.businessId.toLowerCase()) {
    throw new ForbiddenException('an accounting command may only be raised for the business the membership resolved');
  }
}

/**
 * The `Idempotency-Key` is REQUIRED on every endpoint that creates new
 * durable accounting truth or changes a period's state, and that is a
 * deliberate contract rather than a convenience. Without it there is no stable source identity, so a retried
 * request after a timeout would post the same money twice — and a client
 * cannot tell a lost response from a lost request. Making the key optional
 * would make that outcome optional too.
 *
 * A reversal takes no key: its source identity is the original entry's id, so
 * it is already idempotent by construction.
 *
 * A close and a reopen DO take one, and for a sharper reason than a retry. A
 * period's state is not a function of the command alone: closing an
 * already-closed period is a different situation from replaying the close
 * that closed it, and reopening one that was closed again after an earlier
 * reopen must NOT reopen it a second time. The key is what distinguishes
 * those, through the operation registry (§18).
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
