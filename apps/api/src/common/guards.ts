import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError, type Permission } from '@daftar/domain-core';
import { TokenService } from '../modules/auth/tokens';
import { AuthService } from '../modules/auth/auth.service';
import type { MembershipContext } from '../modules/tenancy/tenancy.service';
import { patchContext } from '../infra/request-context';

export const PERMISSION_KEY = 'daftar:required_permission';
/**
 * Runtime seam (Directive §15–17): the merchant process resolves business
 * membership (TenancyService); the platform process has NO merchant context
 * and provides a resolver that refuses X-Business-Id outright.
 */
export const MEMBERSHIP_RESOLVER = 'MEMBERSHIP_RESOLVER';
export interface MembershipResolver {
  resolveMembership(userId: string, businessId: string): Promise<MembershipContext>;
  require(membership: MembershipContext, permission: Permission): void;
}
export const PUBLIC_KEY = 'daftar:public';

/** Route metadata: required permission. Absence of metadata = authenticated only. */
export const RequiresPermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export interface PrincipalInfo {
  userId: string;
  sessionId: string;
  email: string | null;
  displayName: string;
  preferredLocale: string;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Auth + tenant/business context + permission guard (§31, §37).
 *
 * The client REQUESTS a business via X-Business-Id; the SERVER resolves and
 * authorizes it from membership. Client-supplied business_id fields in bodies
 * are never trusted — services receive MembershipContext, not raw client ids.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MEMBERSHIP_RESOLVER) private readonly tenancy: MembershipResolver,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { principal?: PrincipalInfo; membership?: MembershipContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    let payload: { sub: string; sid: string };
    try {
      payload = await this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const principal = await this.auth.resolvePrincipal(payload.sub, payload.sid);
    req.principal = { ...principal, sessionId: payload.sid };
    patchContext({ userId: principal.userId });

    const required = this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    // Business context is required when a permission is required.
    const businessId = req.headers['x-business-id'];
    if (required || typeof businessId === 'string') {
      if (typeof businessId !== 'string' || !UUID_RE.test(businessId)) {
        throw AppError.forbidden('Business context required');
      }
      const membership = await this.tenancy.resolveMembership(principal.userId, businessId);
      req.membership = membership;
      patchContext({ tenantId: membership.tenantId, businessId: membership.businessId });
      if (required) this.tenancy.require(membership, required);
    }
    return true;
  }
}

/** Parameter decorators for controllers. */
export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext): PrincipalInfo => {
  const req = ctx.switchToHttp().getRequest<{ principal?: PrincipalInfo }>();
  const p = req.principal;
  if (!p) throw AppError.unauthenticated();
  return p;
});

export const Membership = createParamDecorator((_: unknown, ctx: ExecutionContext): MembershipContext => {
  const req = ctx.switchToHttp().getRequest<{ membership?: MembershipContext }>();
  const m = req.membership;
  if (!m) throw AppError.forbidden('Business context required');
  return m;
});
