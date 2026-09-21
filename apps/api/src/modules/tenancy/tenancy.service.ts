import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  AppError,
  getCountryPack,
  BUILTIN_ROLE_PERMISSIONS,
  TrustedRoleSet,
  hasPermission,
  isSystemOwner,
  normalizeIndustryProfileKey,
  normalizeSlug,
  suggestSlugs,
  type Permission,
} from '@daftar/domain-core';
import type { BusinessSettingsDto, BusinessSummaryDto, LocaleCode, OnboardingResultDto, SlugAvailabilityDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { isProvisionError, mapProvisionError } from './provision-errors';
import { AuditService, OutboxService, newId } from '../audit/audit.service';

/** §63: IANA timezone validation at the service boundary (DB trigger is the final arbiter). */
function assertValidTimezone(tz: string): void {
  const valid = (Intl.supportedValuesOf('timeZone') as readonly string[]).includes(tz);
  if (!valid) throw AppError.validation({ timezone: ['invalid_iana_timezone'] });
}

/** Stable fingerprint of a creation-command payload (§12 request fingerprint). */
function operationHash(payload: unknown): string {
  const stable = JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort());
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Authorized business context — resolved SERVER-SIDE from membership.
 * Services receive this, never raw client ids (§31, §37, §93).
 */
export interface MembershipContext {
  tenantId: string;
  businessId: string;
  userId: string;
  roles: TrustedRoleSet;
  roleKeys: string[];
  /** Branch scope (§32–37 / WAVE 6): 'all' = whole business; 'assigned' = only allowedBranchIds. */
  branchScopeMode: 'all' | 'assigned';
  allowedBranchIds: readonly string[];
}

@Injectable()
export class TenancyService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /** Resolve + authorize a business context from membership (resolver role: narrow read-only boundary, §10). */
  async resolveMembership(userId: string, businessId: string): Promise<MembershipContext> {
    return this.db.withResolverTransaction(async (c) => {
      const m = (
        await c.query<{ tenant_id: string; business_id: string; branch_scope_mode: string }>(
          `SELECT b.tenant_id, m.business_id, m.branch_scope_mode
           FROM memberships m JOIN businesses b ON b.id = m.business_id
           WHERE m.business_id = $1 AND m.user_id = $2 AND m.status = 'active' AND b.status = 'active'`,
          [businessId, userId],
        )
      ).rows[0];
      if (!m) throw AppError.forbidden('Not a member of this business');

      const roleRows = (
        await c.query<{ key: string; is_system: boolean; permission: string | null }>(
          `SELECT r.key, r.is_system, p.permission
           FROM memberships m
           JOIN membership_roles mr ON mr.business_id = m.business_id AND mr.user_id = m.user_id
           JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
           LEFT JOIN role_permissions p ON p.business_id = r.business_id AND p.role_id = r.id
           WHERE m.business_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
          [businessId, userId],
        )
      ).rows;
      const byKey = new Map<string, { key: string; isSystem: boolean; permissions: Set<string> }>();
      for (const r of roleRows) {
        const e = byKey.get(r.key) ?? { key: r.key, isSystem: r.is_system, permissions: new Set<string>() };
        if (r.permission) e.permissions.add(r.permission);
        byKey.set(r.key, e);
      }
      const roles = TrustedRoleSet.fromPersistence([...byKey.values()]);
      const branchScopeMode = m.branch_scope_mode === 'assigned' ? ('assigned' as const) : ('all' as const);
      const allowedBranchIds =
        branchScopeMode === 'assigned'
          ? (
              await c.query<{ branch_id: string }>('SELECT branch_id FROM member_branch_scopes WHERE business_id = $1 AND user_id = $2', [businessId, userId])
            ).rows.map((r) => r.branch_id)
          : [];
      return {
        tenantId: m.tenant_id,
        businessId,
        userId,
        roles,
        roleKeys: [...byKey.keys()],
        branchScopeMode,
        allowedBranchIds,
      };
    });
  }

  require(membership: MembershipContext, permission: Permission): void {
    if (!hasPermission(membership.roles, permission)) {
      throw AppError.forbidden(`Missing permission: ${permission}`);
    }
  }

  isOwner(membership: MembershipContext): boolean {
    return isSystemOwner(membership.roles);
  }

  /**
   * Onboarding (§45, §53): tenant + business + owner membership + default
   * branch + default warehouse + settings/locales + slug + outbox event in
   * ONE transaction. Any failure rolls back everything.
   *
   * Idempotency (§54): a user who already owns a business gets that business
   * back with replayed:true — double submit never creates a second tenant /
   * business / branch / warehouse.
   *
   * Fallback slug stability (§24): the slug is generated ONCE here and either
   * persisted or conflicted; a replayed request returns the persisted slug —
   * never a new random one.
   */
  async completeOnboarding(
    userId: string,
    input: {
      businessName: string;
      countryCode: string;
      baseCurrency: string;
      storeSlug: string;
      preferredLocale?: LocaleCode;
      industryProfileKey?: string;
      /** Optional IANA timezone override (§63); defaults to the country pack. */
      timezone?: string;
    },
    idempotencyKey: string,
  ): Promise<OnboardingResultDto> {
    const slug = normalizeSlug(input.storeSlug);

    try {
      // §13 (Stabilization): onboarding runs on the NARROW PROVISIONER
      // boundary — never the platform transaction.
      return await this.db.withProvisionerTransaction(async (c) => {
        // Serialize onboarding per user (§54): advisory lock on the user id —
        // the provisioner intentionally has NO grant on the identity users
        // table. A concurrent double submit waits, then sees the committed
        // operation row → replay, no race.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 73))', [userId]);

        // §37–39: Idempotency-Key is REQUIRED — enforced at the controller.
        const replay = await this.replayOperation(c, userId, idempotencyKey, 'initial_onboarding', { ...input, storeSlug: slug });
        if (replay) return replay;

        const tenantId = newId();
        const businessId = newId();
        // §15–21 (Ultimate Closure): the cross-scope transition runs ONLY via
        // narrow SECURITY DEFINER commands — no direct table writes, no bypass.
        await c.query('SELECT provision_create_tenant($1, $2)', [tenantId, userId]);
        await this.provisionBusiness(c, tenantId, userId, businessId, input, slug, userId, 'tenancy.onboarding_completed');
        const onboardResult: OnboardingResultDto = { businessId, tenantId, storeSlug: slug, replayed: false };
        await this.persistOperation(c, userId, idempotencyKey, 'initial_onboarding', { ...input, storeSlug: slug }, onboardResult);
        return onboardResult;
      });
    } catch (e) {
      // Slug race lost (§23): map ONLY the store-slug unique constraint to
      // SLUG_TAKEN; any other constraint violation keeps its true identity.
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23505' && (pg.constraint ?? '').includes('store_slug')) {
        const suggestions = await this.db.withResolverTransaction((c) => this.slugSuggestions(c, slug));
        throw AppError.conflict('SLUG_TAKEN', 'Store slug is taken', { suggestions });
      }
      throw e;
    }
  }

  /**
   * CREATE BUSINESS (Final Closure §11): a tenant owner creates an ADDITIONAL
   * business inside their existing tenant. Distinct from initial onboarding —
   * no new tenant, no new tenant_owner row. Idempotency-Key required semantics
   * identical to onboarding (same key+payload → replay; mismatch → 409).
   */
  async createBusiness(
    userId: string,
    tenantId: string,
    input: {
      businessName: string;
      countryCode: string;
      baseCurrency: string;
      storeSlug: string;
      preferredLocale?: LocaleCode;
      industryProfileKey?: string;
      timezone?: string;
    },
    idempotencyKey: string,
  ): Promise<OnboardingResultDto> {
    const slug = normalizeSlug(input.storeSlug);
    try {
      // §13: additional business creation is provisioner authority.
      return await this.db.withProvisionerTransaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 73))', [userId]);

        // §34: the idempotency scope includes the TARGET TENANT — the same key
        // aimed at a different tenant is a different operation.
        const fingerprint = { ...input, storeSlug: slug, tenantId };
        const replay = await this.replayOperation(c, userId, idempotencyKey, 'create_business', fingerprint);
        if (replay) return replay;

        // §33–35 SERVER AUTHORITY: the client tenantId is only the TARGET —
        // the caller must be an ACTIVE tenant_owner of EXACTLY that tenant.
        // No ORDER BY created_at guessing: the tenant is explicit.
        try {
          await c.query('SELECT provision_assert_tenant_owner($1, $2)', [tenantId, userId]);
        } catch (e) {
          mapProvisionError(e);
        }

        const businessId = newId();
        await this.provisionBusiness(c, tenantId, userId, businessId, input, slug, userId, 'tenancy.business_created');
        const result: OnboardingResultDto = { businessId, tenantId, storeSlug: slug, replayed: false };
        await this.persistOperation(c, userId, idempotencyKey, 'create_business', fingerprint, result);
        return result;
      });
    } catch (e) {
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23505' && (pg.constraint ?? '').includes('store_slug')) {
        const suggestions = await this.db.withResolverTransaction((c) => this.slugSuggestions(c, slug));
        throw AppError.conflict('SLUG_TAKEN', 'Store slug is taken', { suggestions });
      }
      throw e;
    }
  }

  /** Shared provisioning core: delegates to the narrow SECURITY DEFINER
   *  command (§15–21) — business + roles + owner membership + trial +
   *  default branch/warehouse + outbox + audit, atomically, with the RLS
   *  bypass existing ONLY inside that function. */
  private async provisionBusiness(
    c: import('pg').PoolClient,
    tenantId: string,
    userId: string,
    businessId: string,
    input: {
      businessName: string;
      countryCode: string;
      baseCurrency: string;
      preferredLocale?: LocaleCode;
      industryProfileKey?: string;
      timezone?: string;
    },
    slug: string,
    actorUserId: string,
    auditAction: string,
  ): Promise<void> {
    const resolvedTimezone = input.timezone ?? getCountryPack(input.countryCode).recommendedTimezone;
    assertValidTimezone(resolvedTimezone);
    try {
      await c.query(`SELECT provision_create_business($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
        tenantId,
        userId,
        businessId,
        input.businessName,
        slug,
        input.countryCode,
        input.baseCurrency,
        normalizeIndustryProfileKey(input.industryProfileKey),
        input.preferredLocale ?? 'ar',
        [input.preferredLocale ?? 'ar'],
        resolvedTimezone,
        JSON.stringify(BUILTIN_ROLE_PERMISSIONS),
        auditAction,
        actorUserId,
      ]);
    } catch (e) {
      if (isProvisionError(e, 'SLUG_RESERVED')) {
        // Friendly suggestions come from the read-only resolver directory —
        // the provisioner itself cannot read arbitrary businesses.
        throw AppError.conflict('SLUG_RESERVED', 'This store slug is reserved', {
          suggestions: await this.db.withResolverTransaction((rc) => this.slugSuggestions(rc, slug)),
        });
      }
      mapProvisionError(e);
    }
  }

  /** Idempotency replay lookup (Final Closure §12–13). Returns the stored
   *  result when key+kind+payload match; throws 409 when the key was reused
   *  with a different payload; returns null when the key is new. */
  private async replayOperation(
    c: import('pg').PoolClient,
    userId: string,
    key: string,
    kind: 'initial_onboarding' | 'create_business',
    payload: unknown,
  ): Promise<OnboardingResultDto | null> {
    const hash = operationHash(payload);
    const op = (
      await c.query<{
        kind: string;
        payload_hash: string;
        result_tenant_id: string | null;
        result_business_id: string | null;
        result_store_slug: string | null;
      }>('SELECT kind, payload_hash, result_tenant_id, result_business_id, result_store_slug FROM provision_replay_operation($1, $2)', [userId, key])
    ).rows[0];
    if (!op) return null;
    if (op.kind !== kind || op.payload_hash !== hash) {
      throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    }
    if (!op.result_business_id || !op.result_tenant_id) {
      throw AppError.conflict('IDEMPOTENCY_CONFLICT', 'Operation is incomplete; retry later');
    }
    if (!op.result_store_slug) throw AppError.conflict('IDEMPOTENCY_CONFLICT', 'Operation result no longer exists');
    return { businessId: op.result_business_id, tenantId: op.result_tenant_id, storeSlug: op.result_store_slug, replayed: true };
  }

  private async persistOperation(
    c: import('pg').PoolClient,
    userId: string,
    key: string,
    kind: 'initial_onboarding' | 'create_business',
    payload: unknown,
    result: OnboardingResultDto,
  ): Promise<void> {
    await c.query('SELECT provision_persist_operation($1, $2, $3, $4, $5, $6)', [
      userId,
      key,
      kind,
      operationHash(payload),
      result.tenantId,
      result.businessId,
    ]);
  }

  async listMyBusinesses(userId: string): Promise<BusinessSummaryDto[]> {
    const rows = (
      await this.db.withResolverTransaction((c) =>
        c.query<{
          business_id: string;
          tenant_id: string;
          name: string;
          store_slug: string;
          country_code: string;
          base_currency: string;
          industry_profile_key: string;
          default_locale: string;
          enabled_locales: string[];
          timezone: string;
          storefront_locale: string;
          role_keys: string | null;
        }>(
          `SELECT m.business_id, b.tenant_id, b.name, b.store_slug, b.country_code, b.base_currency,
                b.industry_profile_key, b.default_locale, b.enabled_locales, b.timezone, b.storefront_locale,
                string_agg(r.key, ',' ORDER BY r.key) AS role_keys
         FROM memberships m
         JOIN businesses b ON b.id = m.business_id
         LEFT JOIN membership_roles mr ON mr.business_id = m.business_id AND mr.user_id = m.user_id
         LEFT JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
         WHERE m.user_id = $1 AND m.status = 'active' AND b.status = 'active'
         GROUP BY m.business_id, b.tenant_id, b.name, b.store_slug, b.country_code, b.base_currency,
                  b.industry_profile_key, b.default_locale, b.enabled_locales, b.timezone, b.storefront_locale, b.created_at
         ORDER BY b.created_at`,
          [userId],
        ),
      )
    ).rows;
    return rows.map((r) => ({
      businessId: r.business_id,
      tenantId: r.tenant_id,
      name: r.name,
      storeSlug: r.store_slug,
      countryCode: r.country_code,
      baseCurrency: r.base_currency,
      industryProfileKey: r.industry_profile_key,
      defaultLocale: r.default_locale as LocaleCode,
      enabledLocales: r.enabled_locales as LocaleCode[],
      timezone: r.timezone,
      storefrontLocale: r.storefront_locale as LocaleCode,
      roleKey: r.role_keys?.split(',')[0] ?? 'member',
    }));
  }

  async getBusiness(m: MembershipContext): Promise<BusinessSettingsDto> {
    const r = (
      await this.db.scoped<{
        id: string;
        tenant_id: string;
        name: string;
        store_slug: string;
        country_code: string;
        base_currency: string;
        industry_profile_key: string;
        default_locale: string;
        enabled_locales: string[];
        timezone: string;
        storefront_locale: string;
        financial_started_at: Date | null;
        created_at: Date;
      }>(
        { tenantId: m.tenantId, businessId: m.businessId },
        `SELECT id, tenant_id, name, store_slug, country_code, base_currency, industry_profile_key,
                default_locale, enabled_locales, timezone, storefront_locale, financial_started_at, created_at
         FROM businesses WHERE id = $1`,
        [m.businessId],
      )
    ).rows[0];
    if (!r) throw AppError.notFound('Business not found');
    return {
      businessId: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      storeSlug: r.store_slug,
      countryCode: r.country_code,
      baseCurrency: r.base_currency,
      industryProfileKey: r.industry_profile_key,
      defaultLocale: r.default_locale as LocaleCode,
      enabledLocales: r.enabled_locales as LocaleCode[],
      timezone: r.timezone,
      storefrontLocale: r.storefront_locale as LocaleCode,
      roleKey: m.roleKeys[0] ?? 'member',
      baseCurrencyLocked: r.financial_started_at !== null,
      createdAt: r.created_at.toISOString(),
    };
  }

  async updateSettings(
    m: MembershipContext,
    patch: { name?: string; defaultLocale?: LocaleCode; enabledLocales?: LocaleCode[]; timezone?: string; storefrontLocale?: LocaleCode },
  ): Promise<void> {
    if (patch.timezone) assertValidTimezone(patch.timezone);
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const current = (await c.query<{ id: string }>('SELECT id FROM businesses WHERE id = $1 FOR UPDATE', [m.businessId])).rows[0];
      if (!current) throw AppError.notFound('Business not found');
      await c.query(
        `UPDATE businesses SET
           name = coalesce($2, name),
           default_locale = coalesce($3, default_locale),
           enabled_locales = coalesce($4, enabled_locales),
           timezone = coalesce($5, timezone),
           storefront_locale = coalesce($6, storefront_locale),
           updated_at = now()
         WHERE id = $1`,
        [m.businessId, patch.name ?? null, patch.defaultLocale ?? null, patch.enabledLocales ?? null, patch.timezone ?? null, patch.storefrontLocale ?? null],
      );
      await this.audit.recordTx(c, {
        action: 'tenancy.settings_updated',
        entity: 'business',
        entityId: m.businessId,
        tenantId: m.tenantId,
        businessId: m.businessId,
      });
    });
  }

  /** Base currency (§55): editable only before financial_started_at; locked forever after. */
  async changeBaseCurrency(m: MembershipContext, newCurrency: string): Promise<void> {
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const row = (await c.query<{ financial_started_at: Date | null }>('SELECT financial_started_at FROM businesses WHERE id = $1 FOR UPDATE', [m.businessId]))
        .rows[0];
      if (!row) throw AppError.notFound('Business not found');
      if (row.financial_started_at !== null) {
        throw AppError.conflict('BASE_CURRENCY_LOCKED', 'Base currency is locked after financial activity started');
      }
      await c.query('UPDATE businesses SET base_currency = $2, updated_at = now() WHERE id = $1', [m.businessId, newCurrency]);
      await this.audit.recordTx(c, {
        action: 'tenancy.base_currency_changed',
        entity: 'business',
        entityId: m.businessId,
        tenantId: m.tenantId,
        businessId: m.businessId,
        metadata: { newCurrency },
      });
    });
  }

  /** Availability check is advisory UX (§22): the DB UNIQUE constraint is the final arbiter. */
  async checkSlugAvailability(slugRaw: string): Promise<SlugAvailabilityDto> {
    const slug = normalizeSlug(slugRaw);
    // §15 (Stabilization): the slug directory is the narrow READ-ONLY
    // RESOLVER boundary — no platform authority for a UX availability check.
    const taken = (await this.db.withResolverTransaction((c) => c.query('SELECT 1 FROM businesses WHERE store_slug = $1', [slug]))).rowCount;
    const reserved = (await this.db.withResolverTransaction((c) => c.query('SELECT 1 FROM reserved_store_slugs WHERE slug = $1', [slug]))).rowCount;
    const available = !(taken && taken > 0) && !(reserved && reserved > 0);
    const suggestions = available ? [] : await this.db.withResolverTransaction((c) => this.slugSuggestions(c, slug));
    return { slug, available, suggestions };
  }

  /** DB-backed alternative suggestions (§22–23): candidates filtered against real taken+reserved sets. */
  private async slugSuggestions(c: import('pg').PoolClient, base: string): Promise<string[]> {
    const stem = base.split('-')[0] ?? base;
    const takenRows = (
      await c.query<{ store_slug: string }>(
        `SELECT store_slug FROM businesses WHERE store_slug LIKE $1
         UNION SELECT slug AS store_slug FROM reserved_store_slugs WHERE slug LIKE $1`,
        [`${stem}%`],
      )
    ).rows;
    const takenSet = new Set(takenRows.map((r) => r.store_slug));
    return suggestSlugs(base, (s) => takenSet.has(s));
  }
}
