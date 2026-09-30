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
 * ## The temporary seam this module carried, and its removal
 *
 * While the registry lacked the twelve P4-AL-36 keys, these four names were not
 * of type `Permission`, so a `phase4Permission` decorator bridged the gap and a
 * `PHASE4_REGISTRY_TRIPWIRE` declaration made the bridge impossible to leave
 * behind: the day the registry gained the keys it stopped compiling. It fired,
 * and the bridge is gone. `Phase4SellingPermission` is now an `Extract` from
 * `Permission`, so each of the four names is checked against the registry by
 * the compiler and a key that is renamed or dropped there is a type error here
 * rather than a route that silently answers nobody.
 */

/**
 * The four keys this module's routes name. `Extract` rather than a bare union,
 * so each name must BE a registered permission: the registry is the authority
 * and this list is checked against it at compile time.
 */
export type Phase4SellingPermission = Extract<Permission, 'sales.view' | 'customers.view' | 'customers.manage' | 'receivables.view'>;

/**
 * The route decorator. It is `RequiresPermission` narrowed to this module's four
 * keys, and nothing else: there is no default, no fallback key and no "any of" —
 * a route names exactly one key, and a member without it never reaches the
 * service. No cast: the key is a `Permission` by construction.
 */
export function phase4Permission(permission: Phase4SellingPermission): MethodDecorator & ClassDecorator {
  return RequiresPermission(permission);
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
