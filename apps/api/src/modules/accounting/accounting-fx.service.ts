import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  computeFxRateFingerprint,
  deriveFxRateId,
  canonicalEnteredRate,
  FX_RATE_SOURCE,
  type AccountingControlAssertionMinter,
  type AccountingFxRatePort,
  type FxRateEntryResult,
  type FxRateSnapshot,
} from '@daftar/accounting';
import { hasPermission } from '@daftar/domain-core';
import type { AccountingFxRateCreateDto } from '@daftar/shared-contracts';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * The authorization boundary in front of the FX rate registry (§37, §38).
 *
 * Three rules hold for every method here.
 *
 * The ACTOR is `membership.userId`. There is no parameter through which a
 * caller could supply one, and `enteredByUserId` is never read from a DTO:
 * the database takes it from the signed assertion, and this service is what
 * puts it there.
 *
 * The PERMISSION is `accounting.fx.manage`, checked before anything else.
 *
 * The BRANCH SCOPE must be business-wide. A rate is configuration for every
 * branch of the business, so a member restricted to one branch may not set
 * it — even holding `accounting.fx.manage` through a custom role. That is a
 * separate check from the permission, because the two say different things:
 * one is "may this person configure rates", the other is "does this person's
 * authority reach the whole business this rate will affect".
 *
 * There is no `enterTrusted`, `systemRate` or `skipAuthorization` variant and
 * no flag that would produce one.
 */
@Injectable()
export class AccountingFxService {
  constructor(
    @Inject('ACCOUNTING_FX_PORT') private readonly rates: AccountingFxRatePort,
    @Inject('ACCOUNTING_CONTROL_MINTER') private readonly minter: AccountingControlAssertionMinter,
  ) {}

  /**
   * Enter a manual rate.
   *
   * The rate's identity is DERIVED from the business and the request's
   * `Idempotency-Key`, under its own domain label, so a retry lands on the
   * same row and the registry's own uniqueness does the rest. The source is
   * fixed here and again inside the trusted command: a caller cannot claim a
   * provenance that never existed (§40).
   */
  async enterRate(membership: MembershipContext, dto: AccountingFxRateCreateDto, idempotencyKey: string, requestId: string | null): Promise<FxRateEntryResult> {
    this.authorize(membership);

    const rateId = deriveFxRateId(membership.businessId, idempotencyKey);
    // Canonical BEFORE the fingerprint, and refused rather than rounded if it
    // does not fit the contract. The database canonicalizes identically and
    // recomputes this digest, so a disagreement is a refusal, never a stored
    // rate nobody stated.
    const rate = canonicalEnteredRate(dto.rate);
    const effectiveAt = new Date(dto.effectiveAt);
    const fingerprint = computeFxRateFingerprint({
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      rateId,
      fromCurrency: dto.fromCurrency,
      toCurrency: dto.toCurrency,
      rate,
      effectiveAt,
      source: FX_RATE_SOURCE,
    });

    const assertion = this.minter.mintControl({
      actorUserId: membership.userId,
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      commandKind: 'fx_rate_enter',
      resourceId: rateId,
      payloadFingerprint: fingerprint,
    });

    return this.rates.enterRate({
      assertion,
      command: {
        tenantId: membership.tenantId,
        businessId: membership.businessId,
        rateId,
        fromCurrency: dto.fromCurrency,
        toCurrency: dto.toCurrency,
        rate,
        effectiveAt,
        requestId,
      },
    });
  }

  /**
   * Resolve the rate in force for a fact at a given instant.
   *
   * No HTTP route exposes this in P2-S5 — it exists for the future domains
   * that will copy a snapshot into a journal line (§47). It reads and returns
   * a snapshot; it never posts, and it writes nothing at all.
   */
  async lookupRate(membership: MembershipContext, pair: { from: string; to: string }, at: Date): Promise<FxRateSnapshot> {
    if (!hasPermission(membership.roles, 'accounting.view')) {
      throw new ForbiddenException('accounting.view is required to read an exchange rate');
    }
    return this.rates.lookupRate({ tenantId: membership.tenantId, businessId: membership.businessId }, pair, at);
  }

  private authorize(membership: MembershipContext): void {
    if (!hasPermission(membership.roles, 'accounting.fx.manage')) {
      throw new ForbiddenException('accounting.fx.manage is required for this accounting command');
    }
    if (membership.branchScopeMode !== 'all') {
      throw new ForbiddenException('an exchange rate applies to every branch, so it may only be configured with business-wide authority');
    }
  }
}
