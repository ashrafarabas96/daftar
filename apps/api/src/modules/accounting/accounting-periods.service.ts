import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  computePeriodFingerprint,
  derivePeriodId,
  derivePeriodOperationId,
  normalizePeriodReason,
  type AccountingControlAssertionMinter,
  type AccountingPeriodPort,
  type AccountingPeriodSnapshot,
  type PeriodCommandResult,
} from '@daftar/accounting';
import { hasPermission } from '@daftar/domain-core';
import type { AccountingPeriodCreateDto, AccountingPeriodReopenDto } from '@daftar/shared-contracts';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * The authorization boundary in front of accounting periods (§21, §22).
 *
 * Three rules hold for every mutation here.
 *
 * The ACTOR is `membership.userId`. There is no parameter through which a
 * caller could supply one, and `createdBy`, `closedBy` and
 * `lastReopenedBy` are never read from a DTO: the database takes them from
 * the signed assertion, and this service is what puts them there.
 *
 * The PERMISSION is `accounting.period.manage` for creating and closing, and
 * `accounting.period.reopen` for reopening. Reopen is NOT implied by manage
 * and there is no fallback between them at any layer — the guard on the
 * route, the check below and the database's own command kind each say it
 * independently.
 *
 * The BRANCH SCOPE must be business-wide. A period governs every branch, so a
 * member restricted to one of them may not create, close or reopen one even
 * holding the permission through a custom role. That is a separate check from
 * the permission, because the two say different things: one is "may this
 * person manage periods", the other is "does this person's authority reach
 * the whole business the period will govern".
 *
 * There is no `closeTrusted`, `forceReopen` or `skipAuthorization` variant
 * and no flag that would produce one.
 */
@Injectable()
export class AccountingPeriodsService {
  constructor(
    @Inject('ACCOUNTING_PERIOD_PORT') private readonly periods: AccountingPeriodPort,
    @Inject('ACCOUNTING_CONTROL_MINTER') private readonly minter: AccountingControlAssertionMinter,
  ) {}

  /**
   * Create a period.
   *
   * THIS IS THE ACTIVATION POINT. A business with no periods posts under the
   * ordinary date rules; the first period created here switches that business
   * to period-managed posting, from now on. Nothing is back-filled and no
   * existing entry is touched — history keeps the dates it already has.
   *
   * The period's identity and the operation's identity are both DERIVED from
   * the request's `Idempotency-Key`, under separate domain labels, so a retry
   * lands on the same period and is answered from the operation registry.
   */
  async create(membership: MembershipContext, dto: AccountingPeriodCreateDto, idempotencyKey: string, requestId: string | null): Promise<PeriodCommandResult> {
    this.authorize(membership, 'accounting.period.manage');

    const periodId = derivePeriodId(membership.businessId, idempotencyKey);
    const operationId = derivePeriodOperationId(membership.businessId, idempotencyKey);
    const assertion = this.mint(membership, 'period_create', periodId, {
      kind: 'period_create',
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      operationId,
      periodId,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });

    return this.periods.createPeriod({
      assertion,
      command: {
        tenantId: membership.tenantId,
        businessId: membership.businessId,
        operationId,
        periodId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        requestId,
      },
    });
  }

  /**
   * Close a period.
   *
   * The closing actor and instant are NOT in the command. They come from the
   * verified assertion and from the database clock respectively, so a client
   * cannot state when a period was closed or on whose authority.
   */
  async close(membership: MembershipContext, periodId: string, idempotencyKey: string, requestId: string | null): Promise<PeriodCommandResult> {
    this.authorize(membership, 'accounting.period.manage');

    const operationId = derivePeriodOperationId(membership.businessId, idempotencyKey);
    const assertion = this.mint(membership, 'period_close', periodId, {
      kind: 'period_close',
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      operationId,
      periodId,
    });

    return this.periods.closePeriod({
      assertion,
      command: { tenantId: membership.tenantId, businessId: membership.businessId, operationId, periodId, requestId },
    });
  }

  /**
   * Reopen a closed period.
   *
   * `accounting.period.reopen`, and not `accounting.period.manage`. Undoing a
   * close is a different authority from making one, and a merchant who wants
   * one person to close the books and another to be able to undo it can say
   * so precisely because the two keys are separate.
   *
   * The reason is normalized here with the SAME contract the fingerprint and
   * the database use, so the text that is signed, the text that is stored and
   * the text a reviewer reads are one string.
   */
  async reopen(
    membership: MembershipContext,
    periodId: string,
    dto: AccountingPeriodReopenDto,
    idempotencyKey: string,
    requestId: string | null,
  ): Promise<PeriodCommandResult> {
    this.authorize(membership, 'accounting.period.reopen');

    const reason = normalizePeriodReason(dto.reason);
    const operationId = derivePeriodOperationId(membership.businessId, idempotencyKey);
    const assertion = this.mint(membership, 'period_reopen', periodId, {
      kind: 'period_reopen',
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      operationId,
      periodId,
      reason,
    });

    return this.periods.reopenPeriod({
      assertion,
      command: { tenantId: membership.tenantId, businessId: membership.businessId, operationId, periodId, reason, requestId },
    });
  }

  /**
   * List the business's periods.
   *
   * `accounting.view` — reading never corrupts a ledger, so this is the
   * ordinary permission rather than either period authority, and it is NOT
   * restricted to business-wide branch scope: a branch manager may need to
   * know which months are closed even though they may not close one.
   */
  async list(membership: MembershipContext): Promise<readonly AccountingPeriodSnapshot[]> {
    if (!hasPermission(membership.roles, 'accounting.view')) {
      throw new ForbiddenException('accounting.view is required to read accounting periods');
    }
    return this.periods.listPeriods({ tenantId: membership.tenantId, businessId: membership.businessId });
  }

  private mint(
    membership: MembershipContext,
    commandKind: 'period_create' | 'period_close' | 'period_reopen',
    periodId: string,
    facts: Parameters<typeof computePeriodFingerprint>[0],
  ): string {
    return this.minter.mintControl({
      actorUserId: membership.userId,
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      commandKind,
      resourceId: periodId,
      payloadFingerprint: computePeriodFingerprint(facts),
    });
  }

  private authorize(membership: MembershipContext, permission: 'accounting.period.manage' | 'accounting.period.reopen'): void {
    if (!hasPermission(membership.roles, permission)) {
      throw new ForbiddenException(`${permission} is required for this accounting command`);
    }
    if (membership.branchScopeMode !== 'all') {
      throw new ForbiddenException('an accounting period governs every branch, so it may only be managed with business-wide authority');
    }
  }
}
