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
 * The keys this module's routes name. `Extract` rather than a bare union,
 * so each name must BE a registered permission: the registry is the authority
 * and this list is checked against it at compile time.
 */
export type Phase4SellingPermission = Extract<
  Permission,
  'sales.view' | 'sales.create' | 'sales.discount' | 'customers.view' | 'customers.manage' | 'receivables.view'
>;

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
 * `sensitive` repeats P4-AL-37's classification. Every P4-S1 read is
 * non-sensitive, because reading a receivable is not a value movement.
 *
 * P4-S2 adds ONE writing route, and its classification needs care:
 * `POST /v1/sales` names `sales.create`, which P4-AL-35's matrix classifies
 * as ORDINARY (it is the cashier's own key — selling and taking the money for
 * it ARE the normal flow). The sale's two SENSITIVE conditions —
 * `sales.discount` for any non-zero discount, and `receivables.view` for a
 * credit sale — are not decorators, because both depend on the BODY and a
 * route decorator cannot see it. They are checked in the service, after the
 * idempotency proof and before any state read, and `sensitiveInBody` records
 * that here so a reviewer reading this one list is not misled into thinking
 * the route needs only one key. A discount asked without its key is REFUSED,
 * never silently zeroed.
 *
 * `sale.void` and `sale.return` appear nowhere, by `TL-P4-S2-K1`: `0077`
 * registers the `sale.commit` operation kind ALONE, and a route for an
 * authority the database does not grant is a route that cannot work.
 */
export const SELLING_ROUTE_AUTHORITY: readonly {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly permission: Phase4SellingPermission;
  readonly sensitive: false;
  /** True when the read sums across branches and therefore also needs business-wide scope. */
  readonly businessWide: boolean;
  /** Keys the SERVICE additionally requires, decided by the body rather than the route (P4-S2). */
  readonly sensitiveInBody?: readonly Phase4SellingPermission[];
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

  // ── P4-S2: the atomic sale commit, and the read of what it wrote ───────
  Object.freeze({
    method: 'POST' as const,
    path: '/v1/sales',
    permission: 'sales.create' as const,
    sensitive: false as const,
    businessWide: false,
    sensitiveInBody: Object.freeze(['sales.discount' as const, 'receivables.view' as const]),
  }),
  Object.freeze({ method: 'GET' as const, path: '/v1/sales/:saleId', permission: 'sales.view' as const, sensitive: false as const, businessWide: false }),
]);
