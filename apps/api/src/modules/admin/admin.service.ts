import { Injectable, Inject } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppError } from '@daftar/domain-core';
import type {
  AdminBusinessSummaryDto,
  AdminUserDto,
  AuditEventDto,
  BusinessSubscriptionDetailDto,
  FeatureFlagDto,
  OverrideDto,
  PlanDto,
  PlanVersionDiffDto,
  PlanVersionDto,
  SubscriptionStateDto,
  SupportSessionDto,
  TenantDetailDto,
  TenantSummaryDto,
} from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../../config';

/** Platform roles — a SEPARATE namespace from merchant RBAC (§49–50). */
export type PlatformRole = 'platform_owner' | 'platform_admin' | 'support_agent' | 'billing_admin' | 'security_admin' | 'read_only_analyst';

/** Capability map: which platform role may perform which admin capability. */
const MANAGE_PERMISSIONS: Record<string, PlatformRole[]> = {
  'read.all': ['platform_owner', 'platform_admin', 'support_agent', 'billing_admin', 'security_admin', 'read_only_analyst'],
  'plans.manage': ['platform_owner', 'platform_admin'],
  'features.manage': ['platform_owner', 'platform_admin'],
  'flags.manage': ['platform_owner', 'platform_admin'],
  'overrides.manage': ['platform_owner', 'platform_admin', 'billing_admin'],
  'billing.manage': ['platform_owner', 'billing_admin'],
  'security.view': ['platform_owner', 'security_admin'],
  'support.manage': ['platform_owner', 'support_agent'],
  'platform_roles.manage': ['platform_owner'],
};

const PAGE = 100;
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

interface PlanVersionRow {
  id: string;
  plan_key: string;
  version: number;
  state: PlanVersionDto['state'];
  trial_days: number;
  effective_from: Date;
  created_at: Date;
  features: Record<string, boolean> | null;
  limits: Record<string, string | number> | null;
}
const PLAN_VERSION_SELECT = `
  SELECT pv.id, pv.plan_key, pv.version, pv.state, pv.trial_days, pv.effective_from, pv.created_at,
         (SELECT jsonb_object_agg(pe.feature_key, pe.enabled) FROM plan_entitlements pe WHERE pe.plan_version_id = pv.id) AS features,
         (SELECT jsonb_object_agg(pl.limit_key, pl.limit_value) FROM plan_limits pl WHERE pl.plan_version_id = pv.id) AS limits
  FROM plan_versions pv`;
function planVersionDto(r: PlanVersionRow): PlanVersionDto {
  return {
    id: r.id,
    planKey: r.plan_key,
    version: r.version,
    state: r.state,
    trialDays: r.trial_days,
    effectiveFrom: r.effective_from.toISOString(),
    createdAt: r.created_at.toISOString(),
    features: r.features ?? {},
    // Limits are BIGINT in SQL (arrive as strings); plan limits are counts, not money.
    limits: Object.fromEntries(Object.entries(r.limits ?? {}).map(([k, v]) => [k, Number(v)])),
  };
}

interface OverrideRow {
  id: string;
  business_id: string;
  feature_key: string | null;
  enabled_value: boolean | null;
  limit_key: string | null;
  limit_value: string | null;
  reason: string;
  actor_user_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  created_at: Date;
}
const OVERRIDE_SELECT = `SELECT id, business_id, feature_key, enabled_value, limit_key, limit_value::text, reason, actor_user_id,
  starts_at, ends_at, revoked_at, revoked_by, created_at FROM entitlement_overrides`;
function overrideDto(r: OverrideRow): OverrideDto {
  return {
    id: r.id,
    businessId: r.business_id,
    featureKey: r.feature_key,
    enabledValue: r.enabled_value,
    limitKey: r.limit_key,
    limitValue: r.limit_value === null ? null : Number(r.limit_value),
    reason: r.reason,
    actorUserId: r.actor_user_id,
    startsAt: r.starts_at.toISOString(),
    endsAt: iso(r.ends_at),
    revokedAt: iso(r.revoked_at),
    revokedBy: r.revoked_by,
    createdAt: r.created_at.toISOString(),
  };
}

interface SupportSessionRow {
  id: string;
  reason: string;
  actor_user_id: string;
  tenant_id: string;
  business_id: string | null;
  mode: 'READ_ONLY';
  starts_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  created_at: Date;
}
const SUPPORT_SESSION_SELECT = `SELECT id, reason, actor_user_id, tenant_id, business_id, mode, starts_at, expires_at, revoked_at, revoked_reason, created_at
  FROM support_sessions`;
function supportSessionDto(r: SupportSessionRow): SupportSessionDto {
  return {
    id: r.id,
    reason: r.reason,
    actorUserId: r.actor_user_id,
    tenantId: r.tenant_id,
    businessId: r.business_id,
    mode: r.mode,
    startsAt: r.starts_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: iso(r.revoked_at),
    revokedReason: r.revoked_reason,
    createdAt: r.created_at.toISOString(),
  };
}

interface FlagRow {
  key: string;
  enabled: boolean;
  description: string;
  updated_at: Date;
}
const flagDto = (r: FlagRow): FeatureFlagDto => ({ key: r.key, enabled: r.enabled, description: r.description, updatedAt: r.updated_at.toISOString() });

interface AdminBusinessRow {
  id: string;
  tenant_id: string;
  name: string;
  store_slug: string;
  base_currency: string;
  country_code: string;
  status: string;
  created_at: Date;
  entitlement_state: SubscriptionStateDto | null;
  plan_key: string | null;
  plan_version: number | null;
}
const ADMIN_BUSINESS_SELECT = `
  SELECT b.id, b.tenant_id, b.name, b.store_slug, b.base_currency, b.country_code, b.status, b.created_at,
         be.state AS entitlement_state, pv.plan_key, pv.version AS plan_version
  FROM businesses b
  LEFT JOIN business_entitlements be ON be.business_id = b.id
  LEFT JOIN plan_versions pv ON pv.id = be.plan_version_id`;
function adminBusinessDto(r: AdminBusinessRow): AdminBusinessSummaryDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    storeSlug: r.store_slug,
    baseCurrency: r.base_currency,
    countryCode: r.country_code,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    subscriptionState: r.entitlement_state,
    planKey: r.plan_key,
    planVersion: r.plan_version,
  };
}

/**
 * Super Admin service (§49–56; Completion Directive §28–29). All queries run
 * on the platform DB role and return STABLE DTOs from @daftar/shared-contracts
 * — never raw SQL row shapes. FINANCIAL BOUNDARY: there is intentionally no
 * method here that reads or writes merchant ledgers, posted documents, stock
 * or payments — that boundary holds in every later phase too.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  async resolvePlatformRole(userId: string): Promise<PlatformRole | null> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<{ role_key: PlatformRole }>('SELECT role_key FROM platform_role_memberships WHERE user_id = $1', [userId]),
    );
    const row = rows[0];
    return row ? row.role_key : null;
  }

  async require(userId: string, capability: keyof typeof MANAGE_PERMISSIONS): Promise<PlatformRole> {
    const role = await this.resolvePlatformRole(userId);
    const allowed: PlatformRole[] = MANAGE_PERMISSIONS[capability] ?? [];
    if (!role || !allowed.includes(role)) {
      throw AppError.forbidden(`Platform capability required: ${capability}`);
    }
    return role;
  }

  // ── Tenants / businesses / users ────────────────────────────────────────
  async listTenants(): Promise<TenantSummaryDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<{ id: string; created_at: Date; business_count: number }>(
        `SELECT t.id, t.created_at, count(b.id)::int AS business_count
         FROM tenants t LEFT JOIN businesses b ON b.tenant_id = t.id
         GROUP BY t.id ORDER BY t.created_at DESC LIMIT $1`,
        [PAGE],
      ),
    );
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), businessCount: r.business_count }));
  }

  async listBusinesses(): Promise<AdminBusinessSummaryDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<AdminBusinessRow>(`${ADMIN_BUSINESS_SELECT} ORDER BY b.created_at DESC LIMIT $1`, [PAGE]),
    );
    return rows.map(adminBusinessDto);
  }

  /** Business + subscription + every override (BusinessSubscriptionDetailDto). */
  async businessDetail(businessId: string): Promise<BusinessSubscriptionDetailDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const biz = (await c.query<AdminBusinessRow>(`${ADMIN_BUSINESS_SELECT} WHERE b.id = $1`, [businessId])).rows[0];
      if (!biz) throw AppError.notFound('Business not found');
      const sub = (
        await c.query<{
          plan_version_id: string;
          plan_key: string;
          version: number;
          state: SubscriptionStateDto;
          effective_state: SubscriptionStateDto;
          trial_ends_at: Date | null;
          period_ends_at: Date | null;
        }>(
          `SELECT be.plan_version_id, pv.plan_key, pv.version, be.state,
                  CASE
                    WHEN be.state = 'trial' AND be.trial_ends_at IS NOT NULL AND be.trial_ends_at <= now() THEN 'expired'
                    WHEN be.state = 'cancel_at_period_end' AND be.period_ends_at IS NOT NULL AND be.period_ends_at <= now() THEN 'cancelled'
                    WHEN be.state = 'grace_period' AND be.period_ends_at IS NOT NULL AND be.period_ends_at <= now() THEN 'past_due'
                    ELSE be.state END AS effective_state,
                  be.trial_ends_at, be.period_ends_at
           FROM business_entitlements be JOIN plan_versions pv ON pv.id = be.plan_version_id
           WHERE be.business_id = $1`,
          [businessId],
        )
      ).rows[0];
      const overrides = (await c.query<OverrideRow>(`${OVERRIDE_SELECT} WHERE business_id = $1 ORDER BY created_at DESC`, [businessId])).rows;
      return {
        ...adminBusinessDto(biz),
        subscription: sub
          ? {
              planVersionId: sub.plan_version_id,
              planKey: sub.plan_key,
              planVersion: sub.version,
              state: sub.state,
              effectiveState: sub.effective_state,
              trialEndsAt: iso(sub.trial_ends_at),
              periodEndsAt: iso(sub.period_ends_at),
            }
          : null,
        overrides: overrides.map(overrideDto),
      };
    });
  }

  async listUsers(): Promise<AdminUserDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<{ id: string; email: string; display_name: string; created_at: Date; platform_role: string | null }>(
        `SELECT u.id, u.email::text AS email, u.display_name, u.created_at, prm.role_key AS platform_role
         FROM users u LEFT JOIN platform_role_memberships prm ON prm.user_id = u.id
         ORDER BY u.created_at DESC LIMIT $1`,
        [PAGE],
      ),
    );
    return rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, platformRole: r.platform_role, createdAt: r.created_at.toISOString() }));
  }

  async listAuditEvents(): Promise<AuditEventDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<{
        id: string;
        tenant_id: string | null;
        business_id: string | null;
        actor_user_id: string | null;
        action: string;
        entity: string;
        entity_id: string | null;
        request_id: string | null;
        created_at: Date;
      }>(
        `SELECT id, tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, created_at
         FROM audit_events ORDER BY created_at DESC LIMIT $1`,
        [PAGE],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      businessId: r.business_id,
      actorUserId: r.actor_user_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      requestId: r.request_id,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // ── Plan builder (§29) ──────────────────────────────────────────────────
  async listPlans(): Promise<PlanDto[]> {
    return this.db.withPlatformTransaction(async (c) => {
      const plans = (await c.query<{ key: string; name: string }>('SELECT key, name FROM plans ORDER BY key')).rows;
      const versions = (await c.query<PlanVersionRow>(`${PLAN_VERSION_SELECT} ORDER BY pv.plan_key, pv.version DESC`)).rows.map(planVersionDto);
      return plans.map((p) => ({ key: p.key, name: p.name, versions: versions.filter((v) => v.planKey === p.key) }));
    });
  }

  private async loadVersion(c: PoolClient, planVersionId: string): Promise<PlanVersionDto> {
    const row = (await c.query<PlanVersionRow>(`${PLAN_VERSION_SELECT} WHERE pv.id = $1`, [planVersionId])).rows[0];
    if (!row) throw AppError.notFound('Plan version not found');
    return planVersionDto(row);
  }

  /** Create Plan: the plan row + an EMPTY DRAFT v1 to edit and publish. */
  async createPlan(actorUserId: string, key: string, name: string): Promise<PlanDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const existing = await c.query('SELECT 1 FROM plans WHERE key = $1', [key]);
      if (existing.rowCount) throw AppError.conflict('CONFLICT', 'Plan key already exists');
      await c.query('INSERT INTO plans (key, name) VALUES ($1, $2)', [key, name]);
      const { rows } = await c.query<{ id: string }>(`INSERT INTO plan_versions (plan_key, version, state) VALUES ($1, 1, 'DRAFT') RETURNING id`, [key]);
      const id = rows[0]?.id;
      if (!id) throw new Error('plan version insert returned no row');
      await this.audit.recordTx(c, { action: 'admin.plan_created', entity: 'plan', entityId: key, actorUserId, metadata: { name } });
      return { key, name, versions: [await this.loadVersion(c, id)] };
    });
  }

  /**
   * §XLVII: plan version DIFF PREVIEW — structural diff between two versions
   * of a plan (features added/removed/toggled, limits changed, trial days).
   */
  async diffPlanVersions(planKey: string, fromVersion: number, toVersion: number): Promise<PlanVersionDiffDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const load = async (v: number) => {
        const pv = (await c.query<PlanVersionRow>(`${PLAN_VERSION_SELECT} WHERE pv.plan_key = $1 AND pv.version = $2`, [planKey, v])).rows[0];
        if (!pv) throw AppError.notFound(`Unknown plan version: ${planKey} v${v}`);
        return planVersionDto(pv);
      };
      const a = await load(fromVersion);
      const b = await load(toVersion);
      const features: PlanVersionDiffDto['features'] = [];
      for (const key of new Set([...Object.keys(a.features), ...Object.keys(b.features)])) {
        const from = a.features[key] ?? null;
        const to = b.features[key] ?? null;
        if (from !== to) features.push({ key, from, to });
      }
      const limits: PlanVersionDiffDto['limits'] = [];
      for (const key of new Set([...Object.keys(a.limits), ...Object.keys(b.limits)])) {
        const from = a.limits[key] ?? null;
        const to = b.limits[key] ?? null;
        if (from !== to) limits.push({ key, from, to });
      }
      return {
        planKey,
        fromVersion,
        toVersion,
        trialDays: { from: a.trialDays, to: b.trialDays, changed: a.trialDays !== b.trialDays },
        features: features.sort((x, y) => x.key.localeCompare(y.key)),
        limits: limits.sort((x, y) => x.key.localeCompare(y.key)),
      };
    });
  }

  /**
   * Plan versions are IMMUTABLE once published (§45): a change clones the
   * latest version into DRAFT N+1 (every contract column + children copied)
   * and applies the requested changes to the clone.
   */
  async createPlanVersion(
    actorUserId: string,
    planKey: string,
    changes: { features?: Record<string, boolean>; limits?: Record<string, number>; trialDays?: number },
  ): Promise<PlanVersionDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const { rows: prev } = await c.query<{ id: string; version: number }>(
        `SELECT id, version FROM plan_versions WHERE plan_key = $1 ORDER BY version DESC LIMIT 1`,
        [planKey],
      );
      const base = prev[0];
      if (!base) throw AppError.notFound(`Unknown plan: ${planKey}`);
      const nextVersion = base.version + 1;
      // §22/§XLVI: cloning copies the ENTIRE versioned commercial contract —
      // every column except identity/lineage and lifecycle (clone = DRAFT).
      const { rows: cols } = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'plan_versions'
           AND column_name NOT IN ('id', 'plan_key', 'version', 'effective_from', 'created_at', 'state')
         ORDER BY ordinal_position`,
      );
      const copiedCols = cols.map((r) => `"${r.column_name}"`).join(', ');
      const { rows: created } = await c.query<{ id: string }>(
        `INSERT INTO plan_versions (plan_key, version${copiedCols ? `, ${copiedCols}` : ''})
         SELECT $1::text, $2::int${copiedCols ? `, ${copiedCols}` : ''} FROM plan_versions WHERE id = $3 RETURNING id`,
        [planKey, nextVersion, base.id],
      );
      const newId = created[0]?.id;
      if (!newId) throw new Error('plan_version insert returned no row');
      await c.query(
        `INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled)
         SELECT $1, feature_key, enabled FROM plan_entitlements WHERE plan_version_id = $2`,
        [newId, base.id],
      );
      await c.query(
        `INSERT INTO plan_limits (plan_version_id, limit_key, limit_value)
         SELECT $1, limit_key, limit_value FROM plan_limits WHERE plan_version_id = $2`,
        [newId, base.id],
      );
      await this.applyDraftChanges(c, newId, changes, false);
      await this.audit.recordTx(c, {
        action: 'admin.plan_version_created',
        entity: 'plan_version',
        entityId: newId,
        actorUserId,
        metadata: { planKey, version: nextVersion },
      });
      return this.loadVersion(c, newId);
    });
  }

  /** Edit a DRAFT in place (§29 Edit Features / Edit Limits / Trial Days). Published → 409. */
  async updateDraftPlanVersion(
    actorUserId: string,
    planVersionId: string,
    changes: { features?: Record<string, boolean>; limits?: Record<string, number>; trialDays?: number },
  ): Promise<PlanVersionDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const row = (await c.query<{ state: string }>('SELECT state FROM plan_versions WHERE id = $1 FOR UPDATE', [planVersionId])).rows[0];
      if (!row) throw AppError.notFound('Plan version not found');
      if (row.state !== 'DRAFT') throw AppError.conflict('CONFLICT', 'Only a DRAFT version can be edited — clone it into a new version');
      await this.applyDraftChanges(c, planVersionId, changes, true);
      await this.audit.recordTx(c, { action: 'admin.plan_version_edited', entity: 'plan_version', entityId: planVersionId, actorUserId, metadata: changes });
      return this.loadVersion(c, planVersionId);
    });
  }

  /** Apply feature/limit/trial changes to a DRAFT. `replace` = the maps are the full desired sets. */
  private async applyDraftChanges(
    c: PoolClient,
    planVersionId: string,
    changes: { features?: Record<string, boolean>; limits?: Record<string, number>; trialDays?: number },
    replace: boolean,
  ): Promise<void> {
    if (changes.trialDays !== undefined) {
      await c.query(`UPDATE plan_versions SET trial_days = $2 WHERE id = $1`, [planVersionId, changes.trialDays]);
    }
    if (changes.features) {
      if (replace) await c.query('DELETE FROM plan_entitlements WHERE plan_version_id = $1', [planVersionId]);
      for (const [featureKey, enabled] of Object.entries(changes.features)) {
        await c.query(
          `INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled) VALUES ($1, $2, $3)
           ON CONFLICT (plan_version_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [planVersionId, featureKey, enabled],
        );
      }
    }
    if (changes.limits) {
      if (replace) await c.query('DELETE FROM plan_limits WHERE plan_version_id = $1', [planVersionId]);
      for (const [limitKey, limitValue] of Object.entries(changes.limits)) {
        await c.query(
          `INSERT INTO plan_limits (plan_version_id, limit_key, limit_value) VALUES ($1, $2, $3)
           ON CONFLICT (plan_version_id, limit_key) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
          [planVersionId, limitKey, limitValue],
        );
      }
    }
  }

  /** §35–37: publish a DRAFT version (one-way; its children freeze). */
  async publishPlanVersion(actorUserId: string, planVersionId: string): Promise<PlanVersionDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const res = await c.query(`UPDATE plan_versions SET state = 'PUBLISHED' WHERE id = $1 AND state = 'DRAFT'`, [planVersionId]);
      if (!res.rowCount) throw AppError.conflict('CONFLICT', 'Only a DRAFT version can be published');
      await this.audit.recordTx(c, { action: 'admin.plan_version_published', entity: 'plan_version', entityId: planVersionId, actorUserId });
      return this.loadVersion(c, planVersionId);
    });
  }

  /** §35: sunset a PUBLISHED version (existing subscribers keep it). */
  async sunsetPlanVersion(actorUserId: string, planVersionId: string): Promise<PlanVersionDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const res = await c.query(`UPDATE plan_versions SET state = 'SUNSET' WHERE id = $1 AND state = 'PUBLISHED'`, [planVersionId]);
      if (!res.rowCount) throw AppError.conflict('CONFLICT', 'Only a PUBLISHED version can be sunset');
      await this.audit.recordTx(c, { action: 'admin.plan_version_sunset', entity: 'plan_version', entityId: planVersionId, actorUserId });
      return this.loadVersion(c, planVersionId);
    });
  }

  // ── Overrides ───────────────────────────────────────────────────────────
  async listOverrides(): Promise<OverrideDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<OverrideRow>(`${OVERRIDE_SELECT} ORDER BY created_at DESC LIMIT $1`, [PAGE]));
    return rows.map(overrideDto);
  }

  /** Override grant: exactly one of featureKey/limitKey; reason + actor + window (§42–44). */
  async createOverride(
    actorUserId: string,
    dto: {
      businessId: string;
      featureKey?: string;
      enabledValue?: boolean;
      limitKey?: string;
      limitValue?: number;
      reason: string;
      startsAt?: string;
      endsAt?: string;
    },
  ): Promise<OverrideDto> {
    const hasFeature = typeof dto.featureKey === 'string';
    const hasLimit = typeof dto.limitKey === 'string';
    if (hasFeature === hasLimit) {
      throw AppError.validation({ field: 'featureKey|limitKey', reason: 'Exactly one of featureKey or limitKey is required (override is feature XOR limit)' });
    }
    if (hasFeature && typeof dto.enabledValue !== 'boolean') {
      throw AppError.validation({ field: 'enabledValue', reason: 'enabledValue is required for a feature override' });
    }
    if (hasLimit && typeof dto.limitValue !== 'number') {
      throw AppError.validation({ field: 'limitValue', reason: 'limitValue is required for a limit override' });
    }
    return this.db.withPlatformTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO entitlement_overrides
           (business_id, feature_key, enabled_value, limit_key, limit_value, reason, actor_user_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9::timestamptz)
         RETURNING id`,
        [
          dto.businessId,
          dto.featureKey ?? null,
          dto.enabledValue ?? null,
          dto.limitKey ?? null,
          dto.limitValue ?? null,
          dto.reason,
          actorUserId,
          dto.startsAt ?? null,
          dto.endsAt ?? null,
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('override insert returned no row');
      await this.audit.recordTx(c, {
        action: 'admin.entitlement_override_created',
        entity: 'entitlement_override',
        entityId: id,
        actorUserId,
        businessId: dto.businessId,
        metadata: { reason: dto.reason, featureKey: dto.featureKey ?? null, limitKey: dto.limitKey ?? null },
      });
      return this.loadOverride(c, id);
    });
  }

  private async loadOverride(c: PoolClient, id: string): Promise<OverrideDto> {
    const row = (await c.query<OverrideRow>(`${OVERRIDE_SELECT} WHERE id = $1`, [id])).rows[0];
    if (!row) throw AppError.notFound('Override not found');
    return overrideDto(row);
  }

  /** §44: revoke an override — audited (already revoked → 409). */
  async revokeOverride(actorUserId: string, overrideId: string, reason: string): Promise<OverrideDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const res = await c.query<{ business_id: string }>(
        `UPDATE entitlement_overrides SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL RETURNING business_id`,
        [overrideId, actorUserId],
      );
      const row = res.rows[0];
      if (!row) throw AppError.conflict('CONFLICT', 'Override not found or already revoked');
      await this.audit.recordTx(c, {
        action: 'admin.entitlement_override_revoked',
        entity: 'entitlement_override',
        entityId: overrideId,
        actorUserId,
        businessId: row.business_id,
        metadata: { reason },
      });
      return this.loadOverride(c, overrideId);
    });
  }

  // ── Feature flags ───────────────────────────────────────────────────────
  async listFeatureFlags(): Promise<FeatureFlagDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<FlagRow>('SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key'),
    );
    return rows.map(flagDto);
  }

  /** Feature flags are technical enablement — separate from entitlements (§36). */
  async setFeatureFlag(actorUserId: string, key: string, enabled: boolean, description?: string): Promise<FeatureFlagDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const { rows } = await c.query<FlagRow>(
        `INSERT INTO feature_flags (key, enabled, description) VALUES ($1, $2, coalesce($3, ''))
         ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, description = coalesce($3, feature_flags.description), updated_at = now()
         RETURNING key, enabled, description, updated_at`,
        [key, enabled, description ?? null],
      );
      const row = rows[0];
      if (!row) throw new Error('feature flag upsert returned no row');
      await this.audit.recordTx(c, { action: 'admin.feature_flag_set', entity: 'feature_flag', entityId: key, actorUserId, metadata: { enabled } });
      return flagDto(row);
    });
  }

  // ── §LII–LIV: SUPPORT SESSIONS ─────────────────────────────────────────
  // Time-boxed, reason-bound, audited platform-actor access into a tenant.
  // Sessions are immutable except revocation; expired/revoked denies
  // IMMEDIATELY (checked at request time, no caching).

  async createSupportSession(
    actorUserId: string,
    dto: { tenantId: string; businessId?: string; reason: string; expiresAt: string },
  ): Promise<SupportSessionDto> {
    // §11: expiry is capped SERVER-SIDE — far-future sessions are rejected.
    const expiresAt = new Date(dto.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw AppError.validation({ expiresAt: ['must be a valid future ISO timestamp'] });
    }
    const maxAt = Date.now() + this.config.SUPPORT_SESSION_MAX_MINUTES * 60_000;
    if (expiresAt.getTime() > maxAt) {
      throw AppError.validation({ expiresAt: [`exceeds the server-side maximum of ${this.config.SUPPORT_SESSION_MAX_MINUTES} minutes`] });
    }
    return this.db.withPlatformTransaction(async (c) => {
      const { rows } = await c.query<SupportSessionRow>(
        `INSERT INTO support_sessions (reason, actor_user_id, tenant_id, business_id, expires_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)
         RETURNING id, reason, actor_user_id, tenant_id, business_id, mode, starts_at, expires_at, revoked_at, revoked_reason, created_at`,
        [dto.reason, actorUserId, dto.tenantId, dto.businessId ?? null, dto.expiresAt],
      );
      const row = rows[0];
      if (!row) throw new Error('support session insert failed');
      await this.audit.recordTx(c, {
        action: 'admin.support_session_created',
        entity: 'support_session',
        entityId: row.id,
        actorUserId,
        metadata: { tenantId: dto.tenantId, businessId: dto.businessId ?? null, expiresAt: dto.expiresAt },
      });
      return supportSessionDto(row);
    });
  }

  async listSupportSessions(): Promise<SupportSessionDto[]> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<SupportSessionRow>(`${SUPPORT_SESSION_SELECT} ORDER BY created_at DESC LIMIT $1`, [PAGE]),
    );
    return rows.map(supportSessionDto);
  }

  async revokeSupportSession(actorUserId: string, sessionId: string, reason: string): Promise<SupportSessionDto> {
    return this.db.withPlatformTransaction(async (c) => {
      const r = await c.query<SupportSessionRow>(
        `UPDATE support_sessions SET revoked_at = now(), revoked_reason = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, reason, actor_user_id, tenant_id, business_id, mode, starts_at, expires_at, revoked_at, revoked_reason, created_at`,
        [sessionId, reason],
      );
      const row = r.rows[0];
      if (!row) throw AppError.notFound('Active support session not found');
      await this.audit.recordTx(c, {
        action: 'admin.support_session_revoked',
        entity: 'support_session',
        entityId: sessionId,
        actorUserId,
        metadata: { reason },
      });
      return supportSessionDto(row);
    });
  }

  /**
   * The active session for (actor, tenant), or 403. Expiry and revocation are
   * evaluated at REQUEST time — a revoked/expired session denies immediately.
   * §8 (Final Enforcement): when the session carries a businessId, the scope
   * is THAT business only — tenant-wide data must not be returned.
   */
  async requireActiveSupportSession(
    actorUserId: string,
    tenantId: string,
  ): Promise<{ id: string; mode: 'READ_ONLY'; expiresAt: Date; reason: string; businessId: string | null }> {
    const { rows } = await this.db.withPlatformTransaction((c) =>
      c.query<{ id: string; mode: 'READ_ONLY'; expires_at: Date; reason: string; business_id: string | null }>(
        `SELECT id, mode, expires_at, reason, business_id FROM support_sessions
         WHERE actor_user_id = $1 AND tenant_id = $2
           AND revoked_at IS NULL AND starts_at <= now() AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [actorUserId, tenantId],
      ),
    );
    const s = rows[0];
    if (!s) throw AppError.forbidden('An active support session is required to access this tenant');
    return { id: s.id, mode: s.mode, expiresAt: s.expires_at, reason: s.reason, businessId: s.business_id };
  }

  /**
   * Tenant detail for support — REQUIRES an active session and returns the
   * visible banner the UI must render while the session is live. EVERY actual
   * access is audited (§43): session, actor, tenant, business, action,
   * request/correlation id, timestamp.
   */
  async tenantDetailWithBanner(actorUserId: string, tenantId: string): Promise<TenantDetailDto> {
    const session = await this.requireActiveSupportSession(actorUserId, tenantId);
    const tenant = await this.db.withPlatformTransaction(async (c) => {
      const { rows } = await c.query<{ id: string; created_at: Date; businesses: TenantDetailDto['tenant']['businesses'] | null }>(
        `SELECT t.id, t.created_at,
                (SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'storeSlug', b.store_slug, 'status', b.status) ORDER BY b.created_at)
                 FROM businesses b
                 WHERE b.tenant_id = t.id AND ($2::uuid IS NULL OR b.id = $2::uuid)) AS businesses
         FROM tenants t WHERE t.id = $1`,
        [tenantId, session.businessId],
      );
      const row = rows[0];
      if (!row) throw AppError.notFound('Tenant not found');
      await this.audit.recordTx(c, {
        action: 'admin.support_access',
        entity: 'support_session',
        entityId: session.id,
        actorUserId,
        tenantId,
        businessId: session.businessId ?? undefined,
        metadata: { endpoint: 'admin.tenants.detail', scope: session.businessId ? 'business' : 'tenant', mode: session.mode },
      });
      return { id: row.id, createdAt: row.created_at.toISOString(), businesses: row.businesses ?? [] };
    });
    return {
      tenant,
      supportBanner: {
        sessionId: session.id,
        mode: session.mode,
        expiresAt: session.expiresAt.toISOString(),
        businessId: session.businessId,
        message: `SUPPORT SESSION ACTIVE — read-only access${session.businessId ? ' (business-scoped)' : ''}, expires ${session.expiresAt.toISOString()}`,
      },
    };
  }

  /** Grant/replace a user's platform role (platform_owner only, audited). */
  async grantPlatformRole(actorUserId: string, targetUserId: string, roleKey: PlatformRole): Promise<void> {
    await this.db.withPlatformTransaction(async (c) => {
      const { rowCount } = await c.query(
        `INSERT INTO platform_role_memberships (user_id, role_key, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET role_key = EXCLUDED.role_key, granted_by = EXCLUDED.granted_by`,
        [targetUserId, roleKey, actorUserId],
      );
      if (rowCount !== 1) throw new Error('platform role grant failed');
      await this.audit.recordTx(c, {
        action: 'admin.platform_role_granted',
        entity: 'platform_role_membership',
        entityId: targetUserId,
        actorUserId,
        metadata: { roleKey },
      });
    });
  }
}
