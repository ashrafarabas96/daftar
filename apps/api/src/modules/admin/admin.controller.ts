import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '@daftar/domain-core';
import { ZodValidationPipe } from '../../common/validation';
import { Principal } from '../../common/guards';
import type { PrincipalInfo } from '../../common/guards';
import { AdminService } from './admin.service';

const PlanVersionSchema = z
  .object({
    planKey: z.string().min(1),
    features: z.record(z.string(), z.boolean()).optional(),
    limits: z.record(z.string(), z.number().int()).optional(),
    trialDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

// §LII: support session — reason-bound, time-boxed, READ_ONLY.
const SupportSessionSchema = z
  .object({
    tenantId: z.string().uuid(),
    businessId: z.string().uuid().optional(),
    reason: z.string().min(10).max(1000),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
const SupportRevokeSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

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
    roleKey: z.enum([
      'platform_owner', 'platform_admin', 'support_agent',
      'billing_admin', 'security_admin', 'read_only_analyst',
    ]),
  })
  .strict();

/**
 * Super Admin API (§49–56). NO business context: these routes authenticate the
 * user, then authorize on PLATFORM role via AdminService.require — the
 * merchant permission system is never involved.
 */
@Controller('/v1/admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('tenants')
  async listTenants(@Principal() p: PrincipalInfo): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listTenants() };
  }

  @Get('businesses')
  async listBusinesses(@Principal() p: PrincipalInfo): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listBusinesses() };
  }

  @Get('users')
  async listUsers(@Principal() p: PrincipalInfo): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listUsers() };
  }

  // ── §LII–LIV: support sessions ──────────────────────────────────────────
  @Post('support-sessions')
  @UsePipes(new ZodValidationPipe(SupportSessionSchema))
  async createSupportSession(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<unknown> {
    await this.admin.require(p.userId, 'support.manage');
    return this.admin.createSupportSession(p.userId, body as z.infer<typeof SupportSessionSchema>);
  }

  @Get('support-sessions')
  async listSupportSessions(@Principal() p: PrincipalInfo): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listSupportSessions() };
  }

  @Post('support-sessions/:id/revoke')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(SupportRevokeSchema))
  async revokeSupportSession(@Principal() p: PrincipalInfo, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    await this.admin.require(p.userId, 'support.manage');
    await this.admin.revokeSupportSession(p.userId, id, (body as z.infer<typeof SupportRevokeSchema>).reason);
    return { ok: true };
  }

  /** Tenant detail — requires an ACTIVE support session; returns the banner. */
  @Get('tenants/:tenantId')
  async tenantDetail(@Principal() p: PrincipalInfo, @Param('tenantId') tenantId: string): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return this.admin.tenantDetailWithBanner(p.userId, tenantId);
  }

  @Get('plans/:planKey/versions/diff')
  async diffPlanVersions(
    @Principal() p: PrincipalInfo,
    @Param('planKey') planKey: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    const fromV = Number(from);
    const toV = Number(to);
    if (!Number.isInteger(fromV) || !Number.isInteger(toV) || fromV < 1 || toV < 1) {
      throw AppError.validation({ query: 'from and to must be positive integer version numbers' });
    }
    return this.admin.diffPlanVersions(planKey, fromV, toV);
  }

  @Get('plans')
  async listPlans(@Principal() p: PrincipalInfo): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return { items: await this.admin.listPlans() };
  }

  @Get('audit-events')
  async listAuditEvents(@Principal() p: PrincipalInfo): Promise<unknown> {
    await this.admin.require(p.userId, 'security.view');
    return { items: await this.admin.listAuditEvents() };
  }

  @Post('plan-versions')
  @UsePipes(new ZodValidationPipe(PlanVersionSchema))
  async createPlanVersion(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<unknown> {
    await this.admin.require(p.userId, 'plans.manage');
    const b = body as z.infer<typeof PlanVersionSchema>;
    return this.admin.createPlanVersion(p.userId, b.planKey, { features: b.features, limits: b.limits, trialDays: b.trialDays });
  }

  @Post('entitlement-overrides')
  @UsePipes(new ZodValidationPipe(OverrideSchema))
  async createOverride(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<unknown> {
    await this.admin.require(p.userId, 'overrides.manage');
    return this.admin.createOverride(p.userId, body as z.infer<typeof OverrideSchema>);
  }

  @Post('feature-flags')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(FeatureFlagSchema))
  async setFeatureFlag(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<{ ok: true }> {
    await this.admin.require(p.userId, 'flags.manage');
    const b = body as z.infer<typeof FeatureFlagSchema>;
    await this.admin.setFeatureFlag(p.userId, b.key, b.enabled, b.description);
    return { ok: true };
  }

  @Post('platform-roles')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(PlatformRoleSchema))
  async grantPlatformRole(@Principal() p: PrincipalInfo, @Body() body: unknown): Promise<{ ok: true }> {
    await this.admin.require(p.userId, 'platform_roles.manage');
    const b = body as z.infer<typeof PlatformRoleSchema>;
    await this.admin.grantPlatformRole(p.userId, b.userId, b.roleKey);
    return { ok: true };
  }

  @Post('plan-versions/:id/publish')
  @HttpCode(200)
  async publishPlanVersion(@Principal() p: PrincipalInfo, @Param('id') id: string): Promise<{ ok: true }> {
    await this.admin.require(p.userId, 'plans.manage');
    await this.admin.publishPlanVersion(p.userId, id);
    return { ok: true };
  }

  @Post('plan-versions/:id/sunset')
  @HttpCode(200)
  async sunsetPlanVersion(@Principal() p: PrincipalInfo, @Param('id') id: string): Promise<{ ok: true }> {
    await this.admin.require(p.userId, 'plans.manage');
    await this.admin.sunsetPlanVersion(p.userId, id);
    return { ok: true };
  }

  @Post('entitlement-overrides/:id/revoke')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(z.object({ reason: z.string().min(3) }).strict()))
  async revokeOverride(
    @Principal() p: PrincipalInfo, @Param('id') id: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    await this.admin.require(p.userId, 'overrides.manage');
    await this.admin.revokeOverride(p.userId, id, (body as { reason: string }).reason);
    return { ok: true };
  }

  @Get('capabilities/:userId')
  async capabilities(@Principal() p: PrincipalInfo, @Param('userId') userId: string): Promise<unknown> {
    await this.admin.require(p.userId, 'read.all');
    return { userId, platformRole: await this.admin.resolvePlatformRole(userId) };
  }
}
