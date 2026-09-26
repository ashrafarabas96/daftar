import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { LOCALES } from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { AppError } from '@daftar/domain-core';
import { Membership, Principal, Public, RequiresPermission, type PrincipalInfo } from '../../common/guards';
import type { MembershipContext as MC } from './tenancy.service';
import { TenancyService } from './tenancy.service';
import { StructureService } from './structure.service';
import { InvitationsService } from './invitations.service';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { canonicalUuidParam } from '../inventory/canonical-id';

const OnboardingSchema = z
  .object({
    businessName: z.string().min(1).max(160),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    baseCurrency: z.string().min(3).max(3),
    storeSlug: z.string().min(2).max(64),
    preferredLocale: z.enum(LOCALES as ['ar', 'en', 'tr']).optional(),
    industryProfileKey: z.string().min(1).max(64).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

const SettingsSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    defaultLocale: z.enum(LOCALES as ['ar', 'en', 'tr']).optional(),
    enabledLocales: z
      .array(z.enum(LOCALES as ['ar', 'en', 'tr']))
      .min(1)
      .optional(),
    timezone: z.string().min(1).max(64).optional(),
    storefrontLocale: z.enum(LOCALES as ['ar', 'en', 'tr']).optional(),
  })
  .strict();

const CurrencySchema = z.object({ currency: z.string().min(3).max(3) }).strict();
const NameSchema = z.object({ name: z.string().min(1).max(120) }).strict();
const WarehouseSchema = z.object({ name: z.string().min(1).max(120), branchId: z.string().uuid() }).strict();
const WarehouseBranchSchema = z.object({ branchId: z.string().uuid() }).strict();
const MemberSchema = z.object({ email: z.string().email(), roleKey: z.string().min(1).max(64) }).strict();
const InviteSchema = z.object({ email: z.string().email(), roleKey: z.string().min(1).max(64) }).strict();
const AcceptInviteSchema = z.object({ token: z.string().min(10).max(200) }).strict();
const AcceptInviteRegisterSchema = z
  .object({
    token: z.string().min(10).max(200),
    email: z.string().email(),
    password: z.string().min(8).max(200),
    displayName: z.string().min(1).max(120),
  })
  .strict();
const RoleSchema = z
  .object({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), name: z.string().min(1).max(80), permissions: z.array(z.string()).max(100) })
  .strict();
const RolesSetSchema = z.object({ roleKeys: z.array(z.string().min(1).max(64)).min(1).max(10) }).strict();
const RoleUpdateSchema = z
  .object({ name: z.string().min(1).max(80).optional(), permissions: z.array(z.string()).max(100).optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.permissions !== undefined, { message: 'nothing_to_update' });
const RoleDeleteSchema = z.object({ replacementRoleKey: z.string().min(1).max(64).optional() }).strict();
const BranchScopeSchema = z
  .object({
    mode: z.enum(['all', 'assigned']),
    branchIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();

@Controller('/v1')
export class TenancyController {
  constructor(
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(StructureService) private readonly structure: StructureService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
  ) {}

  @Post('onboarding/complete')
  @UsePipes(new ZodValidationPipe(OnboardingSchema))
  async completeOnboarding(
    @Principal() p: PrincipalInfo,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // §37–38: creation commands REQUIRE an Idempotency-Key in the API contract.
    if (!idempotencyKey) throw AppError.validation({ idempotencyKey: ['IDEMPOTENCY_KEY_REQUIRED'] });
    const result = await this.tenancy.completeOnboarding(p.userId, body as z.infer<typeof OnboardingSchema>, idempotencyKey);
    // Idempotent replay is not a creation (§54): 200, not 201.
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /**
   * CREATE BUSINESS (Final Closure §11, Gate A §33–36): EXPLICIT TENANT
   * TARGETING — the tenant is in the path, never guessed from "the user's
   * first tenant". The server verifies the caller is an ACTIVE tenant_owner
   * of exactly that tenant. Idempotency-Key REQUIRED; same key + same
   * payload (incl. tenant) → replay (200), different payload → 409.
   */
  @Post('tenants/:tenantId/businesses')
  @UsePipes(new ZodValidationPipe(OnboardingSchema))
  async createBusiness(
    @Principal() p: PrincipalInfo,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) throw AppError.validation({ idempotencyKey: ['IDEMPOTENCY_KEY_REQUIRED'] });
    const result = await this.tenancy.createBusiness(p.userId, tenantId, body as z.infer<typeof OnboardingSchema>, idempotencyKey);
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  @Get('onboarding/slug-availability')
  async slugAvailability(@Query('slug') slug: string) {
    return this.tenancy.checkSlugAvailability(typeof slug === 'string' ? slug : '');
  }

  @Get('me/businesses')
  async myBusinesses(@Principal() p: PrincipalInfo) {
    return { items: await this.tenancy.listMyBusinesses(p.userId) };
  }

  @Get('businesses/current')
  @RequiresPermission('business.view')
  async currentBusiness(@Membership() m: MC) {
    return this.tenancy.getBusiness(m);
  }

  @Patch('businesses/current')
  @RequiresPermission('settings.manage')
  @UsePipes(new ZodValidationPipe(SettingsSchema))
  async updateSettings(@Membership() m: MC, @Body() body: unknown) {
    await this.tenancy.updateSettings(m, body as z.infer<typeof SettingsSchema>);
    // Directive §26: mutations return the full DTO, never a bare {ok:true}.
    return this.tenancy.getBusiness(m);
  }

  @Post('businesses/current/base-currency')
  @RequiresPermission('settings.manage')
  @UsePipes(new ZodValidationPipe(CurrencySchema))
  async changeBaseCurrency(@Membership() m: MC, @Body() body: unknown) {
    await this.tenancy.changeBaseCurrency(m, (body as z.infer<typeof CurrencySchema>).currency);
    return { ok: true };
  }

  @Get('businesses/current/branches')
  @RequiresPermission('branch.view')
  async branches(@Membership() m: MC) {
    return { items: await this.structure.listBranches(m) };
  }

  @Post('businesses/current/branches')
  @RequiresPermission('branch.manage')
  @UsePipes(new ZodValidationPipe(NameSchema))
  async createBranch(@Membership() m: MC, @Body() body: unknown) {
    return this.structure.createBranch(m, (body as z.infer<typeof NameSchema>).name);
  }

  @Get('businesses/current/warehouses')
  @RequiresPermission('warehouse.view')
  async warehouses(@Membership() m: MC) {
    return { items: await this.structure.listWarehouses(m) };
  }

  @Post('businesses/current/warehouses')
  @RequiresPermission('warehouse.manage')
  @UsePipes(new ZodValidationPipe(WarehouseSchema))
  async createWarehouse(@Membership() m: MC, @Body() body: unknown) {
    const b = body as z.infer<typeof WarehouseSchema>;
    return this.structure.createWarehouse(m, b.name, b.branchId);
  }

  /**
   * Associate a warehouse with an additional branch (P3-AL-15 §B). The route
   * requires `warehouse.manage`; the service additionally requires
   * business-wide scope before anything is minted. Idempotent: an existing
   * association answers 200 with `changed: false`.
   */
  @Post('businesses/current/warehouses/:warehouseId/branches')
  @HttpCode(200)
  @RequiresPermission('warehouse.manage')
  @UsePipes(new ZodValidationPipe(WarehouseBranchSchema))
  async addWarehouseBranch(@Membership() m: MC, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    const b = body as z.infer<typeof WarehouseBranchSchema>;
    return this.structure.addWarehouseBranch(
      m,
      canonicalUuidParam(warehouseId, 'warehouseId'),
      canonicalUuidParam(b.branchId, 'branchId'),
      newBusinessTransactionId(),
    );
  }

  /** Remove a non-home warehouse–branch association (P3-AL-15 §B). Idempotent. */
  @Delete('businesses/current/warehouses/:warehouseId/branches/:branchId')
  @HttpCode(200)
  @RequiresPermission('warehouse.manage')
  async removeWarehouseBranch(@Membership() m: MC, @Param('warehouseId') warehouseId: string, @Param('branchId') branchId: string) {
    return this.structure.removeWarehouseBranch(
      m,
      canonicalUuidParam(warehouseId, 'warehouseId'),
      canonicalUuidParam(branchId, 'branchId'),
      newBusinessTransactionId(),
    );
  }

  @Get('businesses/current/members')
  @RequiresPermission('member.view')
  async members(@Membership() m: MC) {
    return { items: await this.structure.listMembers(m) };
  }

  @Post('businesses/current/members')
  @RequiresPermission('member.manage')
  @UsePipes(new ZodValidationPipe(MemberSchema))
  async addMember(@Membership() m: MC, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = body as z.infer<typeof MemberSchema>;
    const member = await this.structure.addMember(m, b.email, b.roleKey);
    res.status(201);
    return member;
  }

  @Get('businesses/current/roles')
  @RequiresPermission('role.view')
  async roles(@Membership() m: MC) {
    return { items: await this.structure.listRoles(m) };
  }

  @Post('businesses/current/roles')
  @RequiresPermission('role.create')
  @UsePipes(new ZodValidationPipe(RoleSchema))
  async createRole(@Membership() m: MC, @Body() body: unknown) {
    return this.structure.createRole(m, body as z.infer<typeof RoleSchema>);
  }

  @Patch('businesses/current/roles/:roleId')
  @RequiresPermission('role.update')
  @UsePipes(new ZodValidationPipe(RoleUpdateSchema))
  async updateRole(@Membership() m: MC, @Param('roleId') roleId: string, @Body() body: unknown) {
    return this.structure.updateRole(m, roleId, body as z.infer<typeof RoleUpdateSchema>);
  }

  @Delete('businesses/current/roles/:roleId')
  @HttpCode(200)
  @RequiresPermission('role.delete')
  @UsePipes(new ZodValidationPipe(RoleDeleteSchema))
  async deleteRole(@Membership() m: MC, @Param('roleId') roleId: string, @Body() body: unknown) {
    await this.structure.deleteRole(m, roleId, (body as z.infer<typeof RoleDeleteSchema>).replacementRoleKey);
    return { ok: true };
  }

  @Patch('businesses/current/members/:userId/roles')
  @RequiresPermission('role.assign')
  @UsePipes(new ZodValidationPipe(RolesSetSchema))
  async setMemberRoles(@Membership() m: MC, @Param('userId') userId: string, @Body() body: unknown) {
    await this.structure.setMemberRoles(m, userId, (body as z.infer<typeof RolesSetSchema>).roleKeys);
    return { ok: true };
  }

  /**
   * Branch scope management (§36): set mode + the exact allowed branch set
   * (assign = include the id, remove = omit it). Audited. Fine-grained
   * permission 'member.branch_scope.manage' (§37).
   */
  @Patch('businesses/current/members/:userId/branch-scope')
  @RequiresPermission('member.branch_scope.manage')
  @UsePipes(new ZodValidationPipe(BranchScopeSchema))
  async setBranchScope(@Membership() m: MC, @Param('userId') userId: string, @Body() body: unknown) {
    const b = body as z.infer<typeof BranchScopeSchema>;
    await this.structure.setBranchScope(m, userId, b.mode, b.branchIds ?? []);
    return { ok: true };
  }

  @Post('businesses/current/members/:userId/suspend')
  @HttpCode(200)
  @RequiresPermission('member.suspend')
  async suspendMember(@Membership() m: MC, @Param('userId') userId: string) {
    await this.structure.suspendMember(m, userId);
    return { ok: true };
  }

  @Post('businesses/current/members/:userId/reactivate')
  @HttpCode(200)
  @RequiresPermission('member.suspend')
  async reactivateMember(@Membership() m: MC, @Param('userId') userId: string) {
    await this.structure.reactivateMember(m, userId);
    return { ok: true };
  }

  @Get('businesses/current/invitations')
  @RequiresPermission('member.view')
  async listInvitations(@Membership() m: MC) {
    return { items: await this.invitations.list(m) };
  }

  @Post('businesses/current/invitations')
  @RequiresPermission('member.invite')
  @UsePipes(new ZodValidationPipe(InviteSchema))
  async invite(@Membership() m: MC, @Body() body: unknown) {
    const b = body as z.infer<typeof InviteSchema>;
    return this.invitations.invite(m, b.email, b.roleKey);
  }

  @Post('businesses/current/invitations/:id/resend')
  @HttpCode(200)
  @RequiresPermission('member.invite')
  async resendInvitation(@Membership() m: MC, @Param('id') id: string) {
    await this.invitations.resend(m, id);
    return { ok: true };
  }

  @Delete('businesses/current/invitations/:id')
  @RequiresPermission('member.invite')
  async cancelInvitation(@Membership() m: MC, @Param('id') id: string) {
    await this.invitations.cancel(m, id);
    return { ok: true };
  }

  /** Authenticated existing user accepts an invitation addressed to their email. */
  @Post('invitations/accept')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(AcceptInviteSchema))
  async acceptInvitation(@Principal() p: PrincipalInfo, @Body() body: unknown) {
    return this.invitations.accept((body as z.infer<typeof AcceptInviteSchema>).token, { userId: p.userId });
  }

  /** New user registers + joins via invitation (public — the token IS the credential). */
  @Public()
  @Post('invitations/accept-register')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(AcceptInviteRegisterSchema))
  async acceptInvitationRegister(@Body() body: unknown) {
    const b = body as z.infer<typeof AcceptInviteRegisterSchema>;
    return this.invitations.accept(b.token, { email: b.email, password: b.password, displayName: b.displayName });
  }

  @Delete('businesses/current/members/:userId')
  @RequiresPermission('member.manage')
  async removeMember(@Membership() m: MC, @Param('userId') userId: string) {
    await this.structure.removeMember(m, userId);
    return { ok: true };
  }
}
