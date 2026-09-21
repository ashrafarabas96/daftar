import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppError } from '@daftar/domain-core';
import { Database } from '../../infra/database';

/** Usage counters the engine knows how to measure. */
export type LimitKey = 'MAX_USERS' | 'MAX_BRANCHES' | 'MAX_PRODUCTS' | 'MAX_STORAGE' | 'MAX_AI_USAGE' | 'MAX_WHATSAPP_USAGE';

/** Stored subscription states (§29). */
export type SubscriptionState =
  | 'trial' | 'active' | 'grace_period' | 'past_due' | 'paused'
  | 'cancel_at_period_end' | 'cancelled' | 'expired' | 'complimentary';

export interface EntitlementState {
  businessId: string;
  planKey: string;
  planVersion: number;
  /** Stored state (what the billing boundary last wrote). */
  state: SubscriptionState;
  /** Effective state (§30): time-computed — correct even with no scheduler. */
  effectiveState: SubscriptionState;
  trialEndsAt: string | null;
  periodEndsAt: string | null;
}

/**
 * Effective state (§30): derived from stored state + time bounds.
 *  - trial past trial_ends_at             → expired
 *  - cancel_at_period_end past period end → cancelled
 *  - grace_period past period end         → past_due
 * Everything else: stored state stands. Pure function of (row, now).
 */
export function effectiveStateOf(
  state: SubscriptionState, trialEndsAt: Date | null, periodEndsAt: Date | null, now: Date,
): SubscriptionState {
  if (state === 'trial' && trialEndsAt && trialEndsAt.getTime() <= now.getTime()) return 'expired';
  if (state === 'cancel_at_period_end' && periodEndsAt && periodEndsAt.getTime() <= now.getTime()) return 'cancelled';
  if (state === 'grace_period' && periodEndsAt && periodEndsAt.getTime() <= now.getTime()) return 'past_due';
  return state;
}

/** States that entitle the business to features/limits (§31). */
const ENTITLING_STATES: ReadonlySet<SubscriptionState> = new Set([
  'trial', 'active', 'grace_period', 'past_due', 'complimentary',
]);

/**
 * Central Entitlement/Quota Engine (Wave 8). Modules NEVER branch on plan
 * names (`if plan == PRO` is forbidden) — they ask this engine.
 * All methods accept a transaction client so checks+writes stay atomic.
 */
@Injectable()
export class EntitlementService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async getState(c: PoolClient, businessId: string): Promise<EntitlementState> {
    const row = (
      await c.query<{
        plan_key: string; version: number; state: SubscriptionState;
        trial_ends_at: Date | null; period_ends_at: Date | null;
      }>(
        `SELECT pv.plan_key, pv.version, be.state, be.trial_ends_at, be.period_ends_at
         FROM business_entitlements be JOIN plan_versions pv ON pv.id = be.plan_version_id
         WHERE be.business_id = $1`,
        [businessId],
      )
    ).rows[0];
    if (!row) throw AppError.notFound('Business entitlement not provisioned');
    return {
      businessId, planKey: row.plan_key, planVersion: row.version,
      state: row.state,
      effectiveState: effectiveStateOf(row.state, row.trial_ends_at, row.period_ends_at, new Date()),
      trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
      periodEndsAt: row.period_ends_at?.toISOString() ?? null,
    };
  }

  /** §31: a business whose EFFECTIVE state does not entitle gets nothing. */
  private async isEntitled(c: PoolClient, businessId: string): Promise<boolean> {
    const s = await this.getState(c, businessId);
    return ENTITLING_STATES.has(s.effectiveState);
  }

  /**
   * Domain gating (§22–24): features are CAPABILITY gates, enforced server-side
   * at the command. FEATURE_NOT_ENTITLED (409) when plan/override disables it.
   */
  async assertFeature(c: PoolClient, businessId: string, featureKey: string): Promise<void> {
    if (!(await this.hasFeature(c, businessId, featureKey))) {
      throw AppError.conflict('FEATURE_NOT_ENTITLED', 'Feature is not included in the current plan', { featureKey });
    }
  }

  /** Active, in-window override wins over the plan grant. Effective subscription
   *  state gates BOTH (§31): cancelled/expired/paused → feature off. */
  async hasFeature(c: PoolClient, businessId: string, featureKey: string): Promise<boolean> {
    if (!(await this.isEntitled(c, businessId))) return false;
    const ov = (
      await c.query<{ enabled_value: boolean }>(
        `SELECT enabled_value FROM entitlement_overrides
         WHERE business_id = $1 AND feature_key = $2 AND revoked_at IS NULL
           AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
         ORDER BY created_at DESC LIMIT 1`,
        [businessId, featureKey],
      )
    ).rows[0];
    if (ov) return ov.enabled_value;
    const plan = (
      await c.query<{ enabled: boolean }>(
        `SELECT pe.enabled FROM business_entitlements be
         JOIN plan_entitlements pe ON pe.plan_version_id = be.plan_version_id
         WHERE be.business_id = $1 AND pe.feature_key = $2`,
        [businessId, featureKey],
      )
    ).rows[0];
    return plan?.enabled ?? false;
  }

  /** -1 = unlimited. Effective subscription state gates (§31): non-entitled → 0. */
  async getLimit(c: PoolClient, businessId: string, limitKey: LimitKey): Promise<number> {
    if (!(await this.isEntitled(c, businessId))) return 0;
    const ov = (
      await c.query<{ limit_value: string }>(
        `SELECT limit_value FROM entitlement_overrides
         WHERE business_id = $1 AND limit_key = $2 AND revoked_at IS NULL
           AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
         ORDER BY created_at DESC LIMIT 1`,
        [businessId, limitKey],
      )
    ).rows[0];
    if (ov) return Number(ov.limit_value);
    const plan = (
      await c.query<{ limit_value: string }>(
        `SELECT pl.limit_value FROM business_entitlements be
         JOIN plan_limits pl ON pl.plan_version_id = be.plan_version_id
         WHERE be.business_id = $1 AND pl.limit_key = $2`,
        [businessId, limitKey],
      )
    ).rows[0];
    return plan ? Number(plan.limit_value) : 0;
  }

  /**
   * Quota race defense (§46–48): COUNT→CHECK→INSERT is NOT sufficient under
   * concurrency. Every consumption takes a transaction-scoped advisory lock
   * keyed by (business, limit) so concurrent consumers serialize; the loser
   * re-counts AFTER the winner commits and correctly fails.
   */
  private async acquireQuotaLock(c: PoolClient, businessId: string, limitKey: LimitKey): Promise<void> {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [businessId, limitKey]);
  }

  async getUsage(c: PoolClient, businessId: string, limitKey: LimitKey): Promise<number> {
    switch (limitKey) {
      case 'MAX_USERS':
        // §27: active users + VALID PENDING invitations (slot reservation;
        // cancel/expire releases the slot, accept converts it to a member).
        return Number((await c.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM memberships WHERE business_id = $1 AND status = 'active')
                + (SELECT count(*) FROM business_invitations
                   WHERE business_id = $1 AND status = 'pending' AND expires_at > now()) AS n`,
          [businessId])).rows[0]?.n ?? 0);
      case 'MAX_BRANCHES':
        return Number((await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM branches WHERE business_id = $1 AND status = 'active'`, [businessId])).rows[0]?.n ?? 0);
      case 'MAX_PRODUCTS':
        return Number((await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM products WHERE business_id = $1 AND status <> 'archived'`, [businessId])).rows[0]?.n ?? 0);
      default:
        // Not yet measurable in Phase 1 (storage/AI/WhatsApp quotas are future).
        return 0;
    }
  }

  /**
   * DOWNGRADE RULE: when usage already exceeds the limit, existing data is
   * preserved (never deleted) but new consumption is denied — OVER_LIMIT.
   */
  async canConsume(c: PoolClient, businessId: string, limitKey: LimitKey, amount = 1): Promise<boolean> {
    await this.acquireQuotaLock(c, businessId, limitKey);
    const limit = await this.getLimit(c, businessId, limitKey);
    if (limit === -1) return true;
    const usage = await this.getUsage(c, businessId, limitKey);
    return usage + amount <= limit;
  }

  async assertCanConsume(c: PoolClient, businessId: string, limitKey: LimitKey, amount = 1): Promise<void> {
    await this.acquireQuotaLock(c, businessId, limitKey);
    const limit = await this.getLimit(c, businessId, limitKey);
    if (limit === -1) return;
    const usage = await this.getUsage(c, businessId, limitKey);
    if (usage + amount > limit) {
      throw AppError.conflict('PLAN_LIMIT_EXCEEDED', 'Plan limit reached', { limitKey, limit, usage });
    }
  }

  /** Feature flags are technical enablement — SEPARATE from customer entitlement. */
  async isFlagEnabled(c: PoolClient, flagKey: string): Promise<boolean> {
    const row = (await c.query<{ enabled: boolean }>('SELECT enabled FROM feature_flags WHERE key = $1', [flagKey])).rows[0];
    return row?.enabled ?? false;
  }

  /** Plan change: point business at another plan version. Never deletes data. */
  async changePlan(c: PoolClient, businessId: string, planKey: string): Promise<EntitlementState> {
    const pv = (
      await c.query<{ id: string }>(
        `SELECT id FROM plan_versions WHERE plan_key = $1 AND state = 'PUBLISHED' ORDER BY version DESC LIMIT 1`, [planKey])
    ).rows[0];
    if (!pv) throw AppError.validation({ planKey: ['unknown plan'] });
    await c.query(
      `UPDATE business_entitlements SET plan_version_id = $2, updated_at = now() WHERE business_id = $1`,
      [businessId, pv.id],
    );
    return this.getState(c, businessId);
  }
}
