import type { Permission } from '@daftar/domain-core';
import { RequiresPermission } from '../../common/guards';

/**
 * The permission key each P4-S4 receivables route requires.
 *
 * **This module invents nothing, and the registry is a CLOSED SET OF TWELVE**
 * (`packages/domain-core/src/permissions.ts:68-89`, lock P4-AL-36). Every key
 * below is already one of the twelve:
 *
 * - `payments.collect` (`permissions.ts:84`) — ORDINARY, not sensitive
 *   (`permissions.ts:132-137`: taking the money IS the normal flow). It is an
 *   owner, manager (`:197`) AND cashier (`:214`) default;
 * - `receivables.view` (`permissions.ts:87`) — a read key, an owner and
 *   manager default and deliberately NOT a cashier one.
 *
 * `payments.reverse` (`permissions.ts:85`) is SENSITIVE and belongs to P4-S6;
 * it appears nowhere here, because a route for an authority this slice's
 * database does not grant is a route that cannot work.
 *
 * ## Both operations authorise on `payments.collect` (OQ-5, ruled)
 *
 * Applying an existing customer credit to an invoice moves value exactly the
 * way an allocation does — it releases the invoice's carrying base and posts a
 * journal entry — so it needs settlement authority, not a weaker one. The
 * registry has no `credits.*` key and MUST NOT GAIN ONE: a thirteenth key
 * contradicts P4-AL-36. Anyone adding `credits.apply` here is adding it to the
 * registry too, and that is the edit the ruling forbids.
 *
 * ## There is no registry edit in this slice
 *
 * The map's §5.3 checklist resolves, for S4, to: registry — already done;
 * sensitivity vector — already done; built-in defaults — already done;
 * defaults in the database (`0076:118-134`) — already done; delegation ceiling
 * (`beyondGrantAuthority`, `permissions.ts:266-272`) — generic, no change;
 * custom-role tests (the P4-AL-37 digest assertion, `0076:43-48`) — no change,
 * and S4 must not break it. What is left is this table, the route enumeration
 * the Phase 4 gate checks it against, and the cross-tenant golden's ALLOW/DENY
 * pairs. The last two are `scripts/**` and `tests/**` and are reported as
 * required wiring in `receivables.module.ts` rather than made here.
 */

/**
 * The keys this module's routes name. `Extract` rather than a bare union, so
 * each name must BE a registered permission: the registry is the authority and
 * this list is checked against it BY THE COMPILER. A key renamed or dropped
 * there is a type error here, rather than a route that silently answers
 * nobody.
 */
export type Phase4ReceivablesPermission = Extract<Permission, 'payments.collect' | 'receivables.view'>;

/**
 * The route decorator: `RequiresPermission` narrowed to this module's two
 * keys, and nothing else. There is no default, no fallback key and no "any
 * of" — a route names exactly one key, and a member without it never reaches
 * the service. No cast: the key is a `Permission` by construction.
 */
export function phase4ReceivablesPermission(permission: Phase4ReceivablesPermission): MethodDecorator & ClassDecorator {
  return RequiresPermission(permission);
}

/**
 * Every route of this module and the key it requires — the list the Phase 4
 * gate checks a route enumeration against, and the list the registry owner
 * reads.
 *
 * `sensitive` repeats P4-AL-37's classification, and it is `false` on every
 * row: `payments.collect` is ORDINARY and `receivables.view` is a read.
 * `businessWide` is true where the read sums across branches and therefore
 * also needs business-wide scope — a customer's credits are the customer's
 * across every branch, the `GET /v1/customers/:customerId/receivable`
 * precedent (`selling-permissions.ts`).
 *
 * `sensitiveInBody` is absent from every row, and that absence is a fact
 * rather than an omission: neither command has a body-decided second key. A
 * payment is not a discount and not a credit sale, so nothing in the request
 * can raise its authority — which is why both writes name exactly one key and
 * the service re-establishes that same authority through
 * `InventoryAuthorizationService` before anything is minted.
 */
export const RECEIVABLES_ROUTE_AUTHORITY: readonly {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly permission: Phase4ReceivablesPermission;
  readonly sensitive: false;
  readonly businessWide: boolean;
}[] = Object.freeze([
  // ── The two commands ────────────────────────────────────────────────
  Object.freeze({
    method: 'POST' as const,
    path: '/v1/customer-payments',
    permission: 'payments.collect' as const,
    sensitive: false as const,
    businessWide: false,
  }),
  Object.freeze({
    method: 'POST' as const,
    path: '/v1/customer-credits/:creditId/applications',
    permission: 'payments.collect' as const,
    sensitive: false as const,
    businessWide: false,
  }),
  // ── The reads of what they wrote ────────────────────────────────────
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customer-payments/:paymentId',
    permission: 'receivables.view' as const,
    sensitive: false as const,
    businessWide: false,
  }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId/credits',
    permission: 'receivables.view' as const,
    sensitive: false as const,
    businessWide: true,
  }),
]);
