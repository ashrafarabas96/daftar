import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '@daftar/domain-core';
import type {
  AdminBusinessSummaryDto,
  AdminUserDto,
  AuditEventDto,
  BusinessSubscriptionDetailDto,
  FeatureFlagDto,
  ListDto,
  OverrideDto,
  PlanDto,
  PlanListResponseDto,
  PlanVersionDiffDto,
  PlanVersionDto,
  PlatformCapabilitiesDto,
  SupportSessionDto,
  TenantDetailDto,
  TenantSummaryDto,
} from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Principal } from '../../common/guards';
import type { PrincipalInfo } from '../../common/guards';
import { AdminService } from './admin.service';

const PlanSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    name: z.string().min(2).max(80),
  })
  .strict();

const PlanVersionChanges = {
  features: z.record(z.string().min(1).max(64), z.boolean()).optional(),
  limits: z.record(z.string().min(1).max(64), z.number().int().min(-1)).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
};
const PlanVersionSchema = z.object({ planKey: z.string().min(1), ...PlanVersionChanges }).strict();
const PlanVersionEditSchema = z.object(PlanVersionChanges).strict();

// §LII: support session — reason-bound, time-boxed, READ_ONLY.
const SupportSessionSchema = z
  .object({
    tenantId: z.string().uuid(),
    businessId: z.string().uuid().optional(),
    reason: z.string().min(10).max(1000),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
const ReasonSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

const OverrideSchema = z
  .object({
    businessId: z.string().uuid(),
    featureKey: z.string().min(1).optional(),
    enabledValue: z.boolean().optional(),
    limitKey: z.string().min(1).optional(),
    limitValue: z.number().int().optional(),
    reason: z.string().min(3),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  })
  .strict();

const FeatureFlagSchema = z
  .object({
    key: z.string().min(1),
    enabled: z.boolean(),
    description: z.string().optional(),
  })
  .strict();

const PlatformRoleSchema = z
  .object({
    userId: z.string().uuid(),
    roleKey: z.enum(['platform_owner', 'platform_admin', 'support_agent', 'billing_admin', 'security_admin', 'read_only_analyst']),
  })
  .strict();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function uuidParam(id: string): string {
  if (!UUID_RE.test(id)) throw AppError.validation({ id: ['invalid_uuid'] });
  return id;
}

/**
 * Super Admin API (§49–56; Completion Directive §28). NO business context:
 * these routes authenticate the user, then authorize on PLATFORM role via
 * AdminService.require — the merchant permission system is never involved.
 * Every response is a stable @daftar/shared-contracts DTO.
 */
@Controller('/v1/admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  // ── Tenants / businesses / users ────────────────────────────────────────
  @Get('tenants')
  async listTenants(@Principal() p: PrincipalInfo): Promise<ListDto<TenantSummaryDto>> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listTenants() };
  }

  /** Tenant detail — requires an ACTIVE support session; returns the banner. */
  @Get('tenants/:tenantId')
  async tenantDetail(@Principal() p: PrincipalInfo, @Param('tenantId') tenantId: string): Promise<TenantDetailDto> {
    await this.admin.require(p.userId, 'read.all');
    return this.admin.tenantDetailWithBanner(p.userId, uuidParam(tenantId));
  }

  @Get('businesses')
  async listBusinesses(@Principal() p: PrincipalInfo): Promise<ListDto<AdminBusinessSummaryDto>> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listBusinesses() };
  }

  @Get('businesses/:businessId')
  async businessDetail(@Principal() p: PrincipalInfo, @Param('businessId') businessId: string): Promise<BusinessSubscriptionDetailDto> {
    await this.admin.require(p.userId, 'read.all');
    return this.admin.businessDetail(uuidParam(businessId));
  }

  @Get('users')
  async listUsers(@Principal() p: PrincipalInfo): Promise<ListDto<AdminUserDto>> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listUsers() };
  }

  @Get('audit-events')
  async listAuditEvents(@Principal() p: PrincipalInfo): Promise<ListDto<AuditEventDto>> {
    await this.admin.require(p.userId, 'security.view');
    return { items: await this.admin.listAuditEvents() };
  }

  @Get('capabilities/:userId')
  async capabilities(@Principal() p: PrincipalInfo, @Param('userId') userId: string): Promise<PlatformCapabilitiesDto> {
    await this.admin.require(p.userId, 'read.all');
    return { userId: uuidParam(userId), platformRole: await this.admin.resolvePlatformRole(userId) };
  }

  @Post('platform-roles')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(PlatformRoleSchema))
  async grantPlatformRole(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<PlatformCapabilitiesDto> {
    await this.admin.require(p.userId, 'platform_roles.manage');
    const b = body as z.infer<typeof PlatformRoleSchema>;
    await this.admin.grantPlatformRole(p.userId, b.userId, b.roleKey);
    return { userId: b.userId, platformRole: await this.admin.resolvePlatformRole(b.userId) };
  }

  // ── Plan builder (§29) ──────────────────────────────────────────────────
  @Get('plans')
  async listPlans(@Principal() p: PrincipalInfo): Promise<PlanListResponseDto> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listPlans() };
  }

  @Post('plans')
  @UsePipes(new ZodValidationPipe(PlanSchema))
  async createPlan(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<PlanDto> {
    await this.admin.require(p.userId, 'plans.manage');
    const b = body as z.infer<typeof PlanSchema>;
    return this.admin.createPlan(p.userId, b.key, b.name);
  }

  @Get('plans/:planKey/versions/diff')
  async diffPlanVersions(
    @Principal() p: PrincipalInfo,
    @Param('planKey') planKey: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<PlanVersionDiffDto> {
    await this.admin.require(p.userId, 'read.all');
    const fromV = Number(from);
    const toV = Number(to);
    if (!Number.isInteger(fromV) || !Number.isInteger(toV) || fromV < 1 || toV < 1) {
      throw AppError.validation({ query: 'from and to must be positive integer version numbers' });
    }
    return this.admin.diffPlanVersions(planKey, fromV, toV);
  }

  @Post('plan-versions')
  @UsePipes(new ZodValidationPipe(PlanVersionSchema))
  async createPlanVersion(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<PlanVersionDto> {
    await this.admin.require(p.userId, 'plans.manage');
    const b = body as z.infer<typeof PlanVersionSchema>;
    return this.admin.createPlanVersion(p.userId, b.planKey, { features: b.features, limits: b.limits, trialDays: b.trialDays });
  }

  @Patch('plan-versions/:id')
  @UsePipes(new ZodValidationPipe(PlanVersionEditSchema))
  async editDraftPlanVersion(@Principal() p: PrincipalInfo, @Param('id') id: string, @Body() body: unknown): Promise<PlanVersionDto> {
    await this.admin.require(p.userId, 'plans.manage');
    return this.admin.updateDraftPlanVersion(p.userId, uuidParam(id), body as z.infer<typeof PlanVersionEditSchema>);
  }

  @Post('plan-versions/:id/publish')
  @HttpCode(200)
  async publishPlanVersion(@Principal() p: PrincipalInfo, @Param('id') id: string): Promise<PlanVersionDto> {
    await this.admin.require(p.userId, 'plans.manage');
    return this.admin.publishPlanVersion(p.userId, uuidParam(id));
  }

  @Post('plan-versions/:id/sunset')
  @HttpCode(200)
  async sunsetPlanVersion(@Principal() p: PrincipalInfo, @Param('id') id: string): Promise<PlanVersionDto> {
    await this.admin.require(p.userId, 'plans.manage');
    return this.admin.sunsetPlanVersion(p.userId, uuidParam(id));
  }

  // ── Overrides ───────────────────────────────────────────────────────────
  @Get('entitlement-overrides')
  async listOverrides(@Principal() p: PrincipalInfo): Promise<ListDto<OverrideDto>> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listOverrides() };
  }

  @Post('entitlement-overrides')
  @UsePipes(new ZodValidationPipe(OverrideSchema))
  async createOverride(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<OverrideDto> {
    await this.admin.require(p.userId, 'overrides.manage');
    return this.admin.createOverride(p.userId, body as z.infer<typeof OverrideSchema>);
  }

  @Post('entitlement-overrides/:id/revoke')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(ReasonSchema))
  async revokeOverride(@Principal() p: PrincipalInfo, @Param('id') id: string, @Body() body: unknown): Promise<OverrideDto> {
    await this.admin.require(p.userId, 'overrides.manage');
    return this.admin.revokeOverride(p.userId, uuidParam(id), (body as z.infer<typeof ReasonSchema>).reason);
  }

  // ── Feature flags ───────────────────────────────────────────────────────
  @Get('feature-flags')
  async listFeatureFlags(@Principal() p: PrincipalInfo): Promise<ListDto<FeatureFlagDto>> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listFeatureFlags() };
  }

  @Post('feature-flags')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(FeatureFlagSchema))
  async setFeatureFlag(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<FeatureFlagDto> {
    await this.admin.require(p.userId, 'flags.manage');
    const b = body as z.infer<typeof FeatureFlagSchema>;
    return this.admin.setFeatureFlag(p.userId, b.key, b.enabled, b.description);
  }

  // ── §LII–LIV: support sessions ──────────────────────────────────────────
  @Post('support-sessions')
  @UsePipes(new ZodValidationPipe(SupportSessionSchema))
  async createSupportSession(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<SupportSessionDto> {
    await this.admin.require(p.userId, 'support.manage');
    return this.admin.createSupportSession(p.userId, body as z.infer<typeof SupportSessionSchema>);
  }

  @Get('support-sessions')
  async listSupportSessions(@Principal() p: PrincipalInfo): Promise<ListDto<SupportSessionDto>> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listSupportSessions() };
  }

  @Post('support-sessions/:id/revoke')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(ReasonSchema))
  async revokeSupportSession(@Principal() p: PrincipalInfo, @Param('id') id: string, @Body() body: unknown): Promise<SupportSessionDto> {
    await this.admin.require(p.userId, 'support.manage');
    return this.admin.revokeSupportSession(p.userId, uuidParam(id), (body as z.infer<typeof ReasonSchema>).reason);
  }
}
