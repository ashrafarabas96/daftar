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
  // Phase 2 — accounting (P2-S1).
  'accounting.view',
  'accounting.post',
  'accounting.reverse',
  'accounting.chart.manage',
  'accounting.fx.manage',
  // Phase 2 — accounting periods (P2-S6). Two keys, not one.
  //
  // `manage` creates and closes; `reopen` undoes a close and does NOTHING
  // else. Reopen is deliberately NOT implied by manage: closing a period is
  // the ordinary end of a month, while undoing a close after the fact is a
  // rarer decision worth delegating to fewer people. One combined key could
  // not express "this person closes the books, that person may undo it".
  'accounting.period.manage',
  'accounting.period.reopen',
  // Phase 3 — inventory, purchasing and suppliers (P3-AL-38). A closed set of
  // eleven, persisted for existing businesses by migration 0057 and for new
  // ones through BUILTIN_ROLE_PERMISSIONS below (P3-AL-53).
  'inventory.view',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.stocktake',
  'purchases.view',
  'purchases.manage',
  'purchases.receive',
  'purchases.return',
  'suppliers.view',
  'suppliers.manage',
  'suppliers.pay',
  // Phase 4 — sales, customers, receivables and settlement (P4-AL-36). A closed
  // set of twelve, PLURAL-prefixed because Phase 3 chose plural for the mirror
  // business-document domains (`purchases.*`/`suppliers.*` above); four
  // canonical documents naming `sale.create` singular are corrected, not
  // followed (P4-AL-36). Every first segment is a single lowercase word, so
  // every key also satisfies the frozen operation-code regex
  // `^[a-z]+(\.[a-z_]+)+$` (`0054:53`, duplicated at `0054:229`) — which is
  // why `customer_payment.*` was never a candidate shape.
  'sales.view',
  'sales.create',
  'sales.void',
  'sales.return',
  'sales.discount',
  'customers.view',
  'customers.manage',
  'payments.collect',
  'payments.reverse',
  'refunds.approve',
  'receivables.view',
  'installments.manage',
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
  // Closing a period decides what a merchant reported; reopening one undoes
  // that decision. Both move accounting truth, so both are sensitive (AL-16).
  'accounting.period.manage',
  'accounting.period.reopen',
  // Phase 3 (P3-AL-38): everything that moves stock, receives or returns
  // goods, or settles a supplier moves real value. The three `view` keys are
  // ordinary — reading never corrupts anything.
  'inventory.adjust',
  'inventory.transfer',
  'inventory.stocktake',
  'purchases.manage',
  'purchases.receive',
  'purchases.return',
  'suppliers.manage',
  'suppliers.pay',
  // Phase 4 (P4-AL-37): "sensitive" is value-moving OUTSIDE the normal
  // operating flow, not "everything except a read". Selling for cash and taking
  // the money for it ARE the normal flow, so `sales.view`, `sales.create`,
  // `payments.collect`, `customers.view`, `customers.manage` and
  // `receivables.view` are ordinary. Discounting, voiding, returning goods,
  // approving a refund, reversing a payment and rescheduling a debt each move
  // value outside that flow, so all six are sensitive — and under the
  // `OD-P4-01` OPTION A ruling (2026-09-30) none of them may be a DEFAULT of
  // any built-in role, the cashier and the manager included.
  'sales.void',
  'sales.return',
  'sales.discount',
  'payments.reverse',
  'refunds.approve',
  'installments.manage',
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
    // Phase 3 (P3-AL-38, P3-AL-53): APPENDED — exactly the three ordinary view
    // keys, and no sensitive Phase 3 key. The list above is the accepted
    // Phase 1 set and is not altered, reordered or trimmed.
    'inventory.view',
    'purchases.view',
    'suppliers.view',
    // Phase 4 (P4-AL-35, P4-AL-37, `OD-P4-01` OPTION A): APPENDED — exactly the
    // six ORDINARY Phase 4 keys, and no sensitive Phase 4 key. The Phase 1 and
    // Phase 3 lists above are the accepted sets and are not altered, reordered
    // or trimmed.
    //
    // P4-AL-35's own matrix marks the manager `sales.discount` and
    // `sales.return` with a default tick. Both keys are sensitive by P4-AL-37,
    // and the `OD-P4-01` TECH LEAD RULING of 2026-09-30 forbids
    // `sales.discount` "and any other sensitive permission" as a default "for
    // the cashier and for any built-in role". The ruling is the later and more
    // specific instrument, so both keys are delegations here, not defaults.
    'sales.view',
    'sales.create',
    'customers.view',
    'customers.manage',
    'payments.collect',
    'receivables.view',
  ],
  // P3-AL-38: the cashier gains no Phase 3 permission.
  //
  // Phase 4 (`OD-P4-01` TECH LEAD RULING 2026-09-30, OPTION A): the cashier's
  // FIRST financial authority, and it is the narrowest thing a till needs —
  // read the sales surface, commit a sale, see who the customer is, and take
  // the money. Four ORDINARY keys, APPENDED after the accepted
  // `['catalog.view']`, which is not altered.
  //
  // Deliberately NOT here, each by the ruling: `sales.discount`, `sales.void`,
  // `sales.return`, `refunds.approve`, `payments.reverse` and
  // `installments.manage` (sensitive, delegation only); and
  // `receivables.view`, which is ordinary but is the second half of a CREDIT
  // sale (P4-AL-35) — a till that may sell on credit is a commercial decision
  // the merchant delegates, not a default this registry invents.
  cashier: ['catalog.view', 'sales.view', 'sales.create', 'customers.view', 'payments.collect'],
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
