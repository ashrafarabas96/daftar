import type { Permission } from '@daftar/domain-core';
import { RequiresPermission } from '../../common/guards';

/**
 * The permission key each Phase 4 customer and invoice route requires
 * (`OD-P4-01` OPTION A, lock P4-AL-35 and P4-AL-36).
 *
 * **This module invents nothing.** Every key below is one of the twelve
 * P4-AL-36 names the lock already fixed — `sales.view`, `customers.view`,
 * `customers.manage`, `receivables.view` — and the closed registry that makes
 * them real is `packages/domain-core/src/permissions.ts`, which is the
 * permission owner's file in this slice, not this agent's. The table here is
 * the STATEMENT of what each route needs, in one place, so the registry owner
 * and a reviewer can check the two against each other by reading two lists.
 *
 * ## The one temporary seam in this slice, and how it removes itself
 *
 * `Permission` is the union of `PERMISSIONS` (`permissions.ts:11-72`), so until
 * the registry gains the twelve keys these four names are not of that type.
 * `phase4Permission` is the single place that bridges the gap, and
 * `PHASE4_REGISTRY_TRIPWIRE` below makes the bridge impossible to leave behind:
 * the day the registry gains the keys, that declaration stops compiling and the
 * cast must be deleted in the same change.
 *
 * Until then the runtime behaviour is the safe one rather than the convenient
 * one: `hasPermission` (`permissions.ts:182-188`) matches a key against the
 * grants a role actually holds, so an unregistered key matches no grant and
 * every one of these routes refuses every member who is not the system owner.
 * A route that answers nobody is a visible defect; a route that answers
 * everybody would not be.
 */

/** The four keys this module's routes name. A subset of P4-AL-36's twelve. */
export type Phase4SellingPermission = 'sales.view' | 'customers.view' | 'customers.manage' | 'receivables.view';

/**
 * The tripwire. While the registry lacks the Phase 4 keys this resolves to
 * `true` and the constant below compiles. The moment the registry gains them it
 * resolves to the instruction, `PHASE4_REGISTRY_TRIPWIRE` fails to compile, and
 * whoever lands the registry deletes `phase4Permission` and uses
 * `RequiresPermission` directly.
 */
type Phase4RegistryStatus = Phase4SellingPermission extends Permission ? 'DELETE phase4Permission: the registry now has the P4-AL-36 keys' : true;

export const PHASE4_REGISTRY_TRIPWIRE: Phase4RegistryStatus = true;

/**
 * The route decorator. It is `RequiresPermission` with the bridge, and nothing
 * else: there is no default, no fallback key and no "any of" — a route names
 * exactly one key, and a member without it never reaches the service.
 */
export function phase4Permission(permission: Phase4SellingPermission): MethodDecorator & ClassDecorator {
  return RequiresPermission(permission as unknown as Permission);
}

/**
 * Every route of this module and the key it requires — the list `gate:phase4:s1`
 * checks a route enumeration against, and the list the registry owner reads.
 *
 * `sensitive` repeats P4-AL-37's classification: none of these is sensitive,
 * because none of them moves value. Reading a receivable is not a value
 * movement; every value-moving key of P4-AL-35 (`sales.discount`, `sales.void`,
 * `refunds.approve`, `payments.reverse`, `installments.manage`) belongs to a
 * later slice and appears nowhere in this module.
 */
export const SELLING_ROUTE_AUTHORITY: readonly {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly permission: Phase4SellingPermission;
  readonly sensitive: false;
  /** True when the read sums across branches and therefore also needs business-wide scope. */
  readonly businessWide: boolean;
}[] = Object.freeze([
  Object.freeze({ method: 'GET' as const, path: '/v1/customers', permission: 'customers.view' as const, sensitive: false as const, businessWide: false }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId',
    permission: 'customers.view' as const,
    sensitive: false as const,
    businessWide: false,
  }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId/receivable',
    permission: 'receivables.view' as const,
    sensitive: false as const,
    businessWide: true,
  }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId/receivable/aging',
    permission: 'receivables.view' as const,
    sensitive: false as const,
    businessWide: true,
  }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId/open-invoices',
    permission: 'receivables.view' as const,
    sensitive: false as const,
    businessWide: true,
  }),
  Object.freeze({ method: 'GET' as const, path: '/v1/invoices', permission: 'sales.view' as const, sensitive: false as const, businessWide: false }),
  Object.freeze({ method: 'GET' as const, path: '/v1/invoices/:invoiceId', permission: 'sales.view' as const, sensitive: false as const, businessWide: false }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/invoices/:invoiceId/settlement',
    permission: 'receivables.view' as const,
    sensitive: false as const,
    businessWide: true,
  }),
  Object.freeze({ method: 'GET' as const, path: '/v1/document-sequences', permission: 'sales.view' as const, sensitive: false as const, businessWide: false }),
]);
