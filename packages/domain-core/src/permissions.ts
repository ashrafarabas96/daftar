/**
 * DAFTAR RBAC permission registry + evaluator (SECURITY_MODEL §3, Directive §25–27).
 *
 * SECURITY BOUNDARY: owner authority is role IDENTITY sourced from trusted
 * persistence (business_roles.is_system AND key='owner'), never a boolean on an
 * untrusted object. Callers cannot self-grant by setting a flag: the evaluator
 * only accepts a TrustedRoleSet, constructible exclusively via trustedRoleSet()
 * from server-loaded DB rows. A fabricated plain object cannot satisfy the brand.
 */

export const PERMISSIONS = [
  'business.view',
  'business.manage',
  'branch.view',
  'branch.manage',
  'warehouse.view',
  'warehouse.manage',
  'member.view',
  'member.invite',
  'member.manage',
  'member.suspend',
  'member.branch_scope.manage',
  'role.view',
  'role.create',
  'role.update',
  'role.delete',
  'role.assign',
  'catalog.view',
  'catalog.create',
  'catalog.update',
  'catalog.archive',
  'category.manage',
  'media.manage',
  'settings.view',
  'settings.manage',
  'billing.view',
  'billing.manage',
  'subscription.view',
  'subscription.manage',
  // Phase 2 — accounting (P2-S1). Period permissions (accounting.period.manage /
  // accounting.period.reopen) are P2-S6 and deliberately absent until AL-14 is
  // confirmed: an unregistered key cannot be granted, delegated or tested for.
  'accounting.view',
  'accounting.post',
  'accounting.reverse',
  'accounting.chart.manage',
  'accounting.fx.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Sensitive permissions (Wave 6): a future re-authentication / MFA / approval
 * step may be required before exercising these. Metadata seam only — no UX now.
 */
export const SENSITIVE_PERMISSIONS = [
  'member.manage',
  'member.suspend',
  'member.branch_scope.manage',
  'role.create',
  'role.update',
  'role.delete',
  'role.assign',
  'billing.manage',
  'subscription.manage',
  'business.manage',
  // Accounting authority is financial authority: posting, reversing, changing
  // the chart and setting FX rates all move accounting truth (AL-16).
  // accounting.view is ordinary — reading never corrupts a ledger.
  'accounting.post',
  'accounting.reverse',
  'accounting.chart.manage',
  'accounting.fx.manage',
] as const satisfies readonly Permission[];
export function isSensitivePermission(p: Permission): boolean {
  return (SENSITIVE_PERMISSIONS as readonly string[]).includes(p);
}

export function isPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

export type BuiltinRoleKey = 'owner' | 'manager' | 'cashier';

export const BUILTIN_ROLE_PERMISSIONS: Record<BuiltinRoleKey, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: [
    'business.view',
    'branch.view',
    'branch.manage',
    'warehouse.view',
    'warehouse.manage',
    'member.view',
    'member.invite',
    'role.view',
    'role.assign',
    'catalog.view',
    'catalog.create',
    'catalog.update',
    'catalog.archive',
    'category.manage',
    'media.manage',
    'settings.view',
    'subscription.view',
  ],
  cashier: ['catalog.view'],
};

/** Server-loaded role row (from business_roles + role_permissions). Untrusted until wrapped. */
export interface RoleRow {
  readonly key: string;
  readonly isSystem: boolean;
  readonly permissions: ReadonlySet<string>;
}

/**
 * Roles whose owner-ness is attested by the server (DB rows inside a bypass
 * transaction). The private constructor makes external fabrication a
 * compile-time error — the only way to obtain one is fromPersistence().
 */
export class TrustedRoleSet {
  private constructor(readonly roles: readonly RoleRow[]) {}

  /** The ONLY entry point. Call exclusively with rows loaded from business_roles in a bypass tx. */
  static fromPersistence(rows: readonly RoleRow[]): TrustedRoleSet {
    return new TrustedRoleSet(rows.map((r) => ({ key: r.key, isSystem: r.isSystem, permissions: r.permissions })));
  }
}

function isSystemOwnerRole(r: RoleRow): boolean {
  return r.isSystem === true && r.key === 'owner';
}

/**
 * Evaluate whether a trusted role set grants a permission.
 * System owner role implicitly grants every registered permission.
 * There is NO generic boolean bypass parameter (Directive §27).
 */
export function hasPermission(set: TrustedRoleSet, permission: Permission): boolean {
  for (const r of set.roles) {
    if (isSystemOwnerRole(r)) return true;
    if (r.permissions.has(permission)) return true;
  }
  return false;
}

export function filterGranted(set: TrustedRoleSet, permissions: readonly Permission[]): Permission[] {
  return permissions.filter((p) => hasPermission(set, p));
}

/** True iff the trusted set contains the system owner role (identity, not a flag). */
export function isSystemOwner(set: TrustedRoleSet): boolean {
  return set.roles.some(isSystemOwnerRole);
}

/**
 * Delegation ceiling (Directive §27–30): a non-owner actor may only delegate
 * permissions they personally hold. Returns the permissions BEYOND the actor's
 * grant authority — an empty array means the delegation is allowed.
 * The system owner is exempt: owner authority is total by identity.
 */
export function beyondGrantAuthority(set: TrustedRoleSet, permissions: readonly Permission[]): Permission[] {
  if (set.roles.some(isSystemOwnerRole)) return [];
  return permissions.filter((p) => !hasPermission(set, p));
}
