import { Injectable, Inject } from '@nestjs/common';
import { Database } from '../../infra/database';
import { AppError } from '@daftar/domain-core';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../../config';

/** Platform roles — a SEPARATE namespace from merchant RBAC (§49–50). */
export type PlatformRole =
  | 'platform_owner'
  | 'platform_admin'
  | 'support_agent'
  | 'billing_admin'
  | 'security_admin'
  | 'read_only_analyst';

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

/**
 * Super Admin service (§49–56). All queries run in bypass scope on the
 * platform DB role. FINANCIAL BOUNDARY: there is intentionally no method
 * here that reads or writes merchant ledgers, posted documents, stock or
 * payments — that boundary holds in every later phase too.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  async resolvePlatformRole(userId: string): Promise<PlatformRole | null> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<{ role_key: PlatformRole }>(
      'SELECT role_key FROM platform_role_memberships WHERE user_id = $1',
      [userId],
    ));
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

  async listTenants(): Promise<unknown[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<Record<string, unknown>>(
      `SELECT t.id, t.created_at, count(b.id)::int AS business_count
       FROM tenants t LEFT JOIN businesses b ON b.tenant_id = t.id
       GROUP BY t.id ORDER BY t.created_at DESC LIMIT $1`,
      [PAGE],
    ));
    return rows;
  }

  async listBusinesses(): Promise<unknown[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<Record<string, unknown>>(
      `SELECT b.id, b.tenant_id, b.name, b.store_slug, b.created_at,
              be.state AS entitlement_state, pv.plan_key, pv.version AS plan_version
       FROM businesses b
       LEFT JOIN business_entitlements be ON be.business_id = b.id
       LEFT JOIN plan_versions pv ON pv.id = be.plan_version_id
       ORDER BY b.created_at DESC LIMIT $1`,
      [PAGE],
    ));
    return rows;
  }

  /**
   * §XLVII: plan version DIFF PREVIEW — structural diff between two versions
   * of a plan (features added/removed/toggled, limits changed, trial days).
   * Powers the plan builder's preview before publishing.
   */
  async diffPlanVersions(
    planKey: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<{
    planKey: string; fromVersion: number; toVersion: number;
    trialDays: { from: number | null; to: number | null; changed: boolean };
    features: { key: string; from: boolean | null; to: boolean | null }[];
    limits: { key: string; from: number | null; to: number | null }[];
  }> {
    return this.db.withPlatformTransaction(async (c) => {
      const load = async (v: number) => {
        const pv = (
          await c.query<{ id: string; trial_days: number | null }>(
            `SELECT id, trial_days FROM plan_versions WHERE plan_key = $1 AND version = $2`,
            [planKey, v],
          )
        ).rows[0];
        if (!pv) throw AppError.notFound(`Unknown plan version: ${planKey} v${v}`);
        const features = new Map<string, boolean>();
        for (const r of (await c.query<{ feature_key: string; enabled: boolean }>(
          `SELECT feature_key, enabled FROM plan_entitlements WHERE plan_version_id = $1`, [pv.id],
        )).rows) features.set(r.feature_key, r.enabled);
        const limits = new Map<string, number>();
        for (const r of (await c.query<{ limit_key: string; limit_value: string }>(
          `SELECT limit_key, limit_value FROM plan_limits WHERE plan_version_id = $1`, [pv.id],
        )).rows) limits.set(r.limit_key, Number(r.limit_value));
        return { trialDays: pv.trial_days, features, limits };
      };
      const a = await load(fromVersion);
      const b = await load(toVersion);
      const features: { key: string; from: boolean | null; to: boolean | null }[] = [];
      for (const key of new Set([...a.features.keys(), ...b.features.keys()]).values()) {
        const from = a.features.get(key) ?? null;
        const to = b.features.get(key) ?? null;
        if (from !== to) features.push({ key, from, to });
      }
      const limits: { key: string; from: number | null; to: number | null }[] = [];
      for (const key of new Set([...a.limits.keys(), ...b.limits.keys()]).values()) {
        const from = a.limits.get(key) ?? null;
        const to = b.limits.get(key) ?? null;
        if (from !== to) limits.push({ key, from, to });
      }
      return {
        planKey, fromVersion, toVersion,
        trialDays: { from: a.trialDays, to: b.trialDays, changed: a.trialDays !== b.trialDays },
        features: features.sort((x, y) => x.key.localeCompare(y.key)),
        limits: limits.sort((x, y) => x.key.localeCompare(y.key)),
      };
    });
  }

  // ── §LII–LIV: SUPPORT SESSIONS ─────────────────────────────────────────
  // Time-boxed, reason-bound, audited platform-actor access into a tenant.
  // Sessions are immutable except revocation; expired/revoked denies
  // IMMEDIATELY (checked at request time, no caching).

  async createSupportSession(
    actorUserId: string,
    dto: { tenantId: string; businessId?: string; reason: string; expiresAt: string },
  ): Promise<{ sessionId: string }> {
    // §11: expiry is capped SERVER-SIDE — far-future sessions are rejected.
    const expiresAt = new Date(dto.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw AppError.validation({ expiresAt: ['must be a valid future ISO timestamp'] });
    }
    const maxAt = Date.now() + this.config.SUPPORT_SESSION_MAX_MINUTES * 60_000;
    if (expiresAt.getTime() > maxAt) {
      throw AppError.validation({
        expiresAt: [`exceeds the server-side maximum of ${this.config.SUPPORT_SESSION_MAX_MINUTES} minutes`],
      });
    }
    return this.db.withPlatformTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO support_sessions (reason, actor_user_id, tenant_id, business_id, expires_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id`,
        [dto.reason, actorUserId, dto.tenantId, dto.businessId ?? null, dto.expiresAt],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('support session insert failed');
      await this.audit.recordTx(c, {
        action: 'admin.support_session_created', entity: 'support_session', entityId: id,
        actorUserId, metadata: { tenantId: dto.tenantId, businessId: dto.businessId ?? null, expiresAt: dto.expiresAt },
      });
      return { sessionId: id };
    });
  }

  async listSupportSessions(): Promise<unknown[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<Record<string, unknown>>(
      `SELECT id, reason, actor_user_id, tenant_id, business_id, mode,
              starts_at, expires_at, revoked_at, revoked_reason, created_at
       FROM support_sessions ORDER BY created_at DESC LIMIT $1`,
      [PAGE],
    ));
    return rows;
  }

  async revokeSupportSession(actorUserId: string, sessionId: string, reason: string): Promise<void> {
    await this.db.withPlatformTransaction(async (c) => {
      const r = await c.query(
        `UPDATE support_sessions SET revoked_at = now(), revoked_reason = $2
         WHERE id = $1 AND revoked_at IS NULL`,
        [sessionId, reason],
      );
      if (r.rowCount !== 1) throw AppError.notFound('Active support session not found');
      await this.audit.recordTx(c, {
        action: 'admin.support_session_revoked', entity: 'support_session', entityId: sessionId,
        actorUserId, metadata: { reason },
      });
    });
  }

  /**
   * The active session for (actor, tenant), or 403. Expiry and revocation are
   * evaluated at REQUEST time — a revoked/expired session denies immediately.
   * §8 (Final Enforcement): when the session carries a businessId, the scope
   * is THAT business only — tenant-wide data must not be returned.
   */
  async requireActiveSupportSession(actorUserId: string, tenantId: string): Promise<{
    id: string; mode: string; expiresAt: Date; reason: string; businessId: string | null;
  }> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<{
      id: string; mode: string; expires_at: Date; reason: string; business_id: string | null;
    }>(
      `SELECT id, mode, expires_at, reason, business_id FROM support_sessions
       WHERE actor_user_id = $1 AND tenant_id = $2
         AND revoked_at IS NULL AND starts_at <= now() AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [actorUserId, tenantId],
    ));
    const s = rows[0];
    if (!s) throw AppError.forbidden('An active support session is required to access this tenant');
    return { id: s.id, mode: s.mode, expiresAt: s.expires_at, reason: s.reason, businessId: s.business_id };
  }

  /**
   * Tenant detail for support — REQUIRES an active session and returns the
   * visible banner the UI must render while the session is live.
   */
  async tenantDetailWithBanner(actorUserId: string, tenantId: string): Promise<{
    tenant: Record<string, unknown>;
    supportBanner: { sessionId: string; mode: string; expiresAt: Date; businessId: string | null; message: string };
  }> {
    const session = await this.requireActiveSupportSession(actorUserId, tenantId);
    // §8–§9: a business-scoped session sees ONLY that business; other
    // businesses of the tenant must not be revealed. The composite FK
    // (business_id, tenant_id) on support_sessions already guarantees the
    // scoped business belongs to this tenant.
    const result = await this.db.withPlatformTransaction(async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT t.id, t.created_at,
                (SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'storeSlug', b.store_slug, 'status', b.status))
                 FROM businesses b
                 WHERE b.tenant_id = t.id AND ($2::uuid IS NULL OR b.id = $2::uuid)) AS businesses
         FROM tenants t WHERE t.id = $1`,
        [tenantId, session.businessId],
      );
      const tenant = rows[0];
      if (!tenant) throw AppError.notFound('Tenant not found');
      // §10: EVERY actual support access is audited — session, actor, tenant,
      // business (when scoped), action/endpoint. request_id comes from context.
      await this.audit.recordTx(c, {
        action: 'admin.support_access',
        entity: 'support_session',
        entityId: session.id,
        actorUserId,
        tenantId,
        businessId: session.businessId ?? undefined,
        metadata: {
          endpoint: 'admin.tenants.detail',
          scope: session.businessId ? 'business' : 'tenant',
          mode: session.mode,
        },
      });
      return tenant;
    });
    return {
      tenant: result,
      supportBanner: {
        sessionId: session.id,
        mode: session.mode,
        expiresAt: session.expiresAt,
        businessId: session.businessId,
        message: `SUPPORT SESSION ACTIVE — read-only access${session.businessId ? ' (business-scoped)' : ''}, expires ${session.expiresAt.toISOString()}`,
      },
    };
  }

  async listUsers(): Promise<unknown[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<Record<string, unknown>>(
      `SELECT u.id, u.email, u.display_name, u.created_at, prm.role_key AS platform_role
       FROM users u LEFT JOIN platform_role_memberships prm ON prm.user_id = u.id
       ORDER BY u.created_at DESC LIMIT $1`,
      [PAGE],
    ));
    return rows;
  }

  async listPlans(): Promise<unknown[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<Record<string, unknown>>(
      `SELECT p.key, p.name, pv.id AS plan_version_id, pv.version, pv.effective_from,
              (SELECT jsonb_object_agg(limit_key, limit_value) FROM plan_limits pl WHERE pl.plan_version_id = pv.id) AS limits,
              (SELECT jsonb_object_agg(feature_key, enabled) FROM plan_entitlements pe WHERE pe.plan_version_id = pv.id) AS features
       FROM plans p JOIN plan_versions pv ON pv.plan_key = p.key
       ORDER BY p.key, pv.version DESC`,
    ));
    return rows;
  }

  async listAuditEvents(): Promise<unknown[]> {
    const { rows } = await this.db.withPlatformTransaction((c) => c.query<Record<string, unknown>>(
      `SELECT id, tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, created_at
       FROM audit_events ORDER BY created_at DESC LIMIT $1`,
      [PAGE],
    ));
    return rows;
  }

  /**
   * Plan versions are IMMUTABLE (§45): a change creates version N+1 that
   * copies the previous version's grants/limits and applies the changes.
   */
  async createPlanVersion(
    actorUserId: string,
    planKey: string,
    changes: { features?: Record<string, boolean>; limits?: Record<string, number>; trialDays?: number },
  ): Promise<{ planVersionId: string; version: number }> {
    return this.db.withPlatformTransaction( async (c) => {
      const { rows: prev } = await c.query<{ id: string; version: number }>(
        `SELECT id, version FROM plan_versions WHERE plan_key = $1 ORDER BY version DESC LIMIT 1`,
        [planKey],
      );
      const base = prev[0];
      if (!base) throw AppError.notFound(`Unknown plan: ${planKey}`);
      const nextVersion = base.version + 1;
      // §22/§XLVI: cloning copies the ENTIRE versioned commercial contract —
      // future-proof: every column of plan_versions except identity/lineage
      // (id, plan_key, version, effective_from, created_at) and LIFECYCLE
      // (state — a clone always starts as DRAFT) is copied dynamically, so
      // adding a contract column later can never silently drop it from clones.
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
      const createdRow = created[0];
      if (!createdRow) throw new Error('plan_version insert returned no row');
      const newId = createdRow.id;
      if (changes.trialDays !== undefined) {
        await c.query(`UPDATE plan_versions SET trial_days = $2 WHERE id = $1`, [newId, changes.trialDays]);
      }
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
      for (const [featureKey, enabled] of Object.entries(changes.features ?? {})) {
        await c.query(
          `INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled) VALUES ($1, $2, $3)
           ON CONFLICT (plan_version_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [newId, featureKey, enabled],
        );
      }
      for (const [limitKey, limitValue] of Object.entries(changes.limits ?? {})) {
        await c.query(
          `INSERT INTO plan_limits (plan_version_id, limit_key, limit_value) VALUES ($1, $2, $3)
           ON CONFLICT (plan_version_id, limit_key) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
          [newId, limitKey, limitValue],
        );
      }
      await this.audit.recordTx(c, {
        action: 'admin.plan_version_created',
        entity: 'plan_version',
        entityId: newId,
        actorUserId,
        metadata: { planKey, version: nextVersion },
      });
      return { planVersionId: newId, version: nextVersion };
    });
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
  ): Promise<{ overrideId: string }> {
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
    return this.db.withPlatformTransaction( async (c) => {
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
      const row = rows[0];
      if (!row) throw new Error('override insert returned no row');
      await this.audit.recordTx(c, {
        action: 'admin.entitlement_override_created',
        entity: 'entitlement_override',
        entityId: row.id,
        actorUserId,
        businessId: dto.businessId,
        metadata: { reason: dto.reason, featureKey: dto.featureKey ?? null, limitKey: dto.limitKey ?? null },
      });
      return { overrideId: row.id };
    });
  }

  /** §35–37: publish a DRAFT version (one-way; its children freeze). */
  async publishPlanVersion(actorUserId: string, planVersionId: string): Promise<void> {
    await this.db.withPlatformTransaction(async (c) => {
      const res = await c.query(
        `UPDATE plan_versions SET state = 'PUBLISHED' WHERE id = $1 AND state = 'DRAFT'`,
        [planVersionId],
      );
      if (!res.rowCount) throw AppError.conflict('CONFLICT', 'Only a DRAFT version can be published');
      await this.audit.recordTx(c, {
        action: 'admin.plan_version_published', entity: 'plan_version', entityId: planVersionId, actorUserId,
      });
    });
  }

  /** §35: sunset a PUBLISHED version (existing subscribers keep it). */
  async sunsetPlanVersion(actorUserId: string, planVersionId: string): Promise<void> {
    await this.db.withPlatformTransaction(async (c) => {
      const res = await c.query(
        `UPDATE plan_versions SET state = 'SUNSET' WHERE id = $1 AND state = 'PUBLISHED'`,
        [planVersionId],
      );
      if (!res.rowCount) throw AppError.conflict('CONFLICT', 'Only a PUBLISHED version can be sunset');
      await this.audit.recordTx(c, {
        action: 'admin.plan_version_sunset', entity: 'plan_version', entityId: planVersionId, actorUserId,
      });
    });
  }

  /** §44: revoke an override — audited, idempotent-ish (already revoked → 409). */
  async revokeOverride(actorUserId: string, overrideId: string, reason: string): Promise<void> {
    await this.db.withPlatformTransaction(async (c) => {
      const res = await c.query<{ business_id: string }>(
        `UPDATE entitlement_overrides SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL RETURNING business_id`,
        [overrideId, actorUserId],
      );
      const row = res.rows[0];
      if (!row) throw AppError.conflict('CONFLICT', 'Override not found or already revoked');
      await this.audit.recordTx(c, {
        action: 'admin.entitlement_override_revoked', entity: 'entitlement_override', entityId: overrideId,
        actorUserId, businessId: row.business_id, metadata: { reason },
      });
    });
  }

  /** Feature flags are technical enablement — separate from entitlements (§36). */
  async setFeatureFlag(actorUserId: string, key: string, enabled: boolean, description?: string): Promise<void> {
    await this.db.withPlatformTransaction( async (c) => {
      await c.query(
        `INSERT INTO feature_flags (key, enabled, description) VALUES ($1, $2, coalesce($3, ''))
         ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [key, enabled, description ?? null],
      );
      await this.audit.recordTx(c, {
        action: 'admin.feature_flag_set',
        entity: 'feature_flag',
        entityId: key,
        actorUserId,
        metadata: { enabled },
      });
    });
  }

  /** Grant/replace a user's platform role (platform_owner only, audited). */
  async grantPlatformRole(actorUserId: string, targetUserId: string, roleKey: PlatformRole): Promise<void> {
    await this.db.withPlatformTransaction( async (c) => {
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
