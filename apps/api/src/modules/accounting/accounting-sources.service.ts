import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  AccountingEngine,
  AccountingError,
  deriveSourceId,
  type AuthorizedPostingContext,
  type OpeningPosition,
  type PostingCommand,
  type PostingLineCommand,
  type PostingResult,
} from '@daftar/accounting';
import { hasPermission } from '@daftar/domain-core';
import type { AccountingAdjustmentCreateDto, AccountingOpeningBalanceCreateDto, AccountingReversalCreateDto } from '@daftar/shared-contracts';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * The authorization boundary in front of the three Phase-2-native sources
 * (§10, §17, §35, §52-§54).
 *
 * Three rules hold for every method here and are worth stating once.
 *
 * The ACTOR is `membership.userId`. There is no parameter on any of these
 * methods through which a caller could supply one, which is stronger than
 * validating one away.
 *
 * The PERMISSION is checked before anything else, and a reversal requires
 * `accounting.reverse` specifically. `accounting.post` is not a fallback for
 * it and never becomes one: undoing a posted fact is a different authority
 * from making one, and a member trusted to record sales is not automatically
 * trusted to erase them.
 *
 * There is no `postTrusted`, `postWithoutPermission`, `systemPost` or
 * `skipAuthorization` variant of any of these, and no flag that would produce
 * one. A seam like that becomes a permanent bypass the first time a later
 * slice finds it convenient.
 */
@Injectable()
export class AccountingSourcesService {
  constructor(@Inject(AccountingEngine) private readonly engine: AccountingEngine) {}

  /**
   * A merchant-authored correction.
   *
   * The source identity is DERIVED from the business and the request's
   * `Idempotency-Key`, so the ledger's own `(business, source_type,
   * source_id)` uniqueness provides transport idempotency with no second
   * store to keep in step. A request id is not a source id and never becomes
   * one: `requestId` stays narrative, outside the fingerprint, for tracing.
   */
  async postAdjustment(
    membership: MembershipContext,
    dto: AccountingAdjustmentCreateDto,
    idempotencyKey: string,
    requestId: string | null,
  ): Promise<PostingResult> {
    this.require(membership, 'accounting.post');
    const command: PostingCommand = {
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      sourceType: 'manual_adjustment',
      sourceId: deriveSourceId(membership.businessId, idempotencyKey),
      entryDate: dto.entryDate,
      lines: dto.lines.map(toLine),
      description: dto.description ?? null,
      requestId,
    };
    return this.engine.adjust(command, dto.reason, this.context(membership));
  }

  /**
   * The undo of an earlier entry.
   *
   * No `Idempotency-Key` is read here, and that is not an omission. A
   * reversal's source identity IS the original entry's id, so the command is
   * already idempotent by construction and a second reversal of one entry is
   * structurally impossible rather than merely refused.
   */
  async postReversal(
    membership: MembershipContext,
    originalEntryId: string,
    dto: AccountingReversalCreateDto,
    requestId: string | null,
  ): Promise<PostingResult> {
    this.require(membership, 'accounting.reverse');
    return this.engine.reverse(
      {
        tenantId: membership.tenantId,
        businessId: membership.businessId,
        originalEntryId,
        // A reversal with no date stated is dated today in the business's own
        // timezone. The engine resolves that from the database rather than
        // from this process's clock, so the signed date and the date the
        // ledger checks are the same date.
        entryDate: dto.entryDate ?? null,
        reason: dto.reason,
        requestId,
      },
      this.context(membership),
    );
  }

  /** The opening position. Business-level, so business-wide branch authority is required (§31). */
  async postOpeningBalance(
    membership: MembershipContext,
    dto: AccountingOpeningBalanceCreateDto,
    idempotencyKey: string,
    requestId: string | null,
  ): Promise<PostingResult> {
    this.require(membership, 'accounting.post');
    const positions: OpeningPosition[] = dto.positions.map((p) => ({
      account: p.account.kind === 'system' ? { kind: 'system', systemKey: p.account.systemKey } : { kind: 'code', code: p.account.code },
      side: p.side,
      baseAmountMinor: BigInt(p.baseAmountMinor),
      baseCurrency: p.baseCurrency,
      txnAmountMinor: BigInt(p.txnAmountMinor),
      txnCurrency: p.txnCurrency,
      fxRate: p.fxRate,
      fxRateSource: p.fxRateSource,
      fxRateAt: new Date(p.fxRateAt),
      memo: p.memo ?? null,
    }));

    return this.engine.openingBalance(
      {
        tenantId: membership.tenantId,
        businessId: membership.businessId,
        openingBalanceId: deriveSourceId(membership.businessId, idempotencyKey),
        asOfDate: dto.asOfDate,
        positions,
        description: dto.description ?? null,
        requestId,
      },
      this.context(membership),
    );
  }

  private require(membership: MembershipContext, permission: 'accounting.post' | 'accounting.reverse'): void {
    if (!hasPermission(membership.roles, permission)) {
      throw new ForbiddenException(`${permission} is required for this accounting command`);
    }
  }

  private context(membership: MembershipContext): AuthorizedPostingContext {
    return {
      actorUserId: membership.userId,
      branchScope: membership.branchScopeMode === 'assigned' ? { mode: 'assigned', allowedBranchIds: [...membership.allowedBranchIds] } : { mode: 'all' },
    };
  }
}

function toLine(l: AccountingAdjustmentCreateDto['lines'][number]): PostingLineCommand {
  return {
    account: l.account.kind === 'system' ? { kind: 'system', systemKey: l.account.systemKey } : { kind: 'code', code: l.account.code },
    side: l.side,
    baseAmountMinor: BigInt(l.baseAmountMinor),
    baseCurrency: l.baseCurrency,
    txnAmountMinor: BigInt(l.txnAmountMinor),
    txnCurrency: l.txnCurrency,
    fxRate: l.fxRate,
    fxRateSource: l.fxRateSource,
    fxRateAt: new Date(l.fxRateAt),
    branchId: l.branchId ?? null,
    warehouseId: l.warehouseId ?? null,
    memo: l.memo ?? null,
  };
}

/** Re-exported so the controller can name the refusal type without importing the engine. */
export { AccountingError };
