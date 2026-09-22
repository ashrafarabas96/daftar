import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AccountingEngine, type PostingCommand, type PostingResult } from '@daftar/accounting';
import { hasPermission } from '@daftar/domain-core';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * The authorization boundary in front of the engine (§52, §53, §54).
 *
 * An assertion is minted only after ALL of: the request was authenticated, the
 * membership was resolved and is active, the business context came from that
 * membership, the member holds `accounting.post`, and every line's branch was
 * checked against the member's branch scope. The engine performs the last of
 * those; this service performs the rest and is the only caller of the engine.
 *
 * Two things are deliberately impossible to express here. The actor is read
 * from `MembershipContext.userId` and there is no parameter that could carry
 * one from a DTO. And there is no `postTrusted`, `postWithoutPermission` or
 * `skipAuthorization` variant: a seam like that becomes a permanent bypass the
 * first time a later slice finds it convenient.
 */
@Injectable()
export class AccountingPostingService {
  constructor(@Inject(AccountingEngine) private readonly engine: AccountingEngine) {}

  /**
   * Post a journal entry on behalf of an authenticated member.
   *
   * `command.tenantId` and `command.businessId` are taken from the membership,
   * not from the caller: passing a command whose ids disagree with the
   * resolved membership is refused rather than quietly re-scoped, because a
   * caller that believed it was writing elsewhere has a bug worth surfacing.
   */
  async post(membership: MembershipContext, command: PostingCommand): Promise<PostingResult> {
    if (!hasPermission(membership.roles, 'accounting.post')) {
      throw new ForbiddenException('accounting.post is required to write to the journal');
    }
    if (command.businessId !== membership.businessId || command.tenantId !== membership.tenantId) {
      throw new ForbiddenException('a posting may only be raised for the business the membership resolved');
    }
    return this.engine.post(command, {
      actorUserId: membership.userId,
      branchScope: membership.branchScopeMode === 'assigned' ? { mode: 'assigned', allowedBranchIds: [...membership.allowedBranchIds] } : { mode: 'all' },
    });
  }
}
