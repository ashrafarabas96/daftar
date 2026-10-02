import type { Permission } from '@daftar/domain-core';
import { RequiresPermission } from '../../common/guards';

/**
 * THE AUTHORITY OF THE POS TILL-SESSION ROUTES (P4-S3; `OD-P4-01` OPTION A,
 * lock `P4-AL-35`, `P4-AL-36`, `P4-AL-37`, `P4-AL-40`).
 *
 * ## No new permission key, and that is a decision rather than an omission
 *
 * `PERMISSIONS` in `packages/domain-core/src/permissions.ts` is a **closed set
 * of twelve** Phase 4 keys (`P4-AL-36`), and there is no `pos.*` key in it.
 * Opening and closing a till is not a thirteenth authority: it is the first
 * and last act of selling for cash, which `P4-AL-37` classifies as the NORMAL
 * OPERATING FLOW and which the cashier's default set already carries. So:
 *
 *   - opening and closing a till name **`sales.create`** — the cashier's own
 *     minting key, ORDINARY, and exactly "the narrowest thing a till needs";
 *   - reading a till session names **`sales.view`**.
 *
 * A new `pos.till.open` key would have been new authority in a closed
 * registry, would have needed its own place in the sensitivity vector, the
 * delegation ceiling and the audited backfill of `0076`, and would have left
 * every existing cashier unable to open a till until a migration granted it.
 * A key invented to make a route look well-governed, which nobody holds, is a
 * route that answers nobody.
 *
 * ## `OD-P4-09` is not a permission, and must not be modelled as one
 *
 * "One session, one authenticated user" is not expressible as a permission
 * key, and trying would be the mistake: a key is held by a PRINCIPAL, and the
 * rule is about the relationship between a principal and ONE ROW. Two
 * cashiers in one shop hold identical permissions, by design — that is what
 * makes them both cashiers — so no permission check can tell "my till" from
 * "my colleague's till". The rule is therefore enforced where the row is: in
 * the schema, by `0079`, and proved against the database by
 * `tests/security/pos-s3-session-authority.test.ts` and
 * `tests/guards/pos-s3-session-law.test.ts`. A route decorator cannot see a
 * row, and a service check is not inherited by the next writer in the
 * process.
 *
 * ## The branch is never a request field
 *
 * `P4-AL-40`: a till is bound to a branch, and a user whose
 * `member_branch_scopes` do not include that branch is refused by the POLICY,
 * not by a predicate this module writes. The open command names the branch it
 * is opening a till in; whether the actor may see that branch is the
 * database's answer, and the service renders it as `pos.branch_not_found`
 * rather than distinguishing "absent" from "not yours".
 */

/**
 * The keys this module's routes name. `Extract` rather than a bare union, so
 * each name must BE a registered permission: the registry is the authority and
 * this list is checked against it by the compiler. A key renamed or dropped
 * there is a type error here, never a route that silently answers nobody.
 */
export type PosPermission = Extract<Permission, 'sales.view' | 'sales.create'>;

/** The route decorator: `RequiresPermission` narrowed to this module's two keys. No default, no fallback, no "any of". */
export function posPermission(permission: PosPermission): MethodDecorator & ClassDecorator {
  return RequiresPermission(permission);
}

/**
 * Every till-session route and the key it requires — the list the slice gate
 * checks a route enumeration against, and the list the permission owner reads.
 *
 * `sensitive` is `false` on all four, repeating `P4-AL-37`'s classification:
 * opening a till, counting it and reading it move no value outside the normal
 * flow. Nothing here has a `sensitiveInBody` arm either, which is the
 * difference from `POST /v1/sales`: a till session has no discount and no
 * settlement mode, so no body field can raise the authority the route needs.
 *
 * `sales.void` and `sales.return` appear nowhere, and neither does any
 * `pos.*` key, for the reason `TL-P4-S2-K1` gives: a route for an authority
 * the database does not grant is a route that cannot work.
 */
export const POS_ROUTE_AUTHORITY: readonly {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly permission: PosPermission;
  readonly sensitive: false;
}[] = Object.freeze([
  Object.freeze({ method: 'POST' as const, path: '/v1/pos/till-sessions', permission: 'sales.create' as const, sensitive: false as const }),
  Object.freeze({
    method: 'POST' as const,
    path: '/v1/pos/till-sessions/:sessionId/close',
    permission: 'sales.create' as const,
    sensitive: false as const,
  }),
  Object.freeze({ method: 'GET' as const, path: '/v1/pos/till-sessions/current', permission: 'sales.view' as const, sensitive: false as const }),
  Object.freeze({ method: 'GET' as const, path: '/v1/pos/till-sessions/:sessionId', permission: 'sales.view' as const, sensitive: false as const }),
]);

/**
 * EVERY CONTROLLER P4-S3 OWES THE TWO NEST COMPOSITIONS — the
 * `P4_S2_REQUIRED_CONTROLLERS` precedent in `selling.module.ts`, grown to the
 * whole slice.
 *
 * DAFTAR composes Nest twice (`apps/api/src/app/app.module.ts` and
 * `apps/api/src/app/merchant-api.module.ts`), and a controller registered in
 * only one of them is a route no integration test can reach.
 *
 * ## This list is not evidence on its own, and it is not asked to be
 *
 * A list a slice edits to match what it built describes itself. For most of
 * P4-S3's life this one named `TillSessionsController`, a class that did not
 * exist, and NOTHING read the list — so it asserted nothing at all in either
 * direction. It is now checked from BOTH SIDES by
 * `tests/security/phase4-route-surface.test.ts`:
 *
 *   1. it is asserted EQUAL to the controllers DISCOVERED in
 *      `apps/api/src/modules/pos` by reading the directory, so a controller
 *      built and not listed is red and a name listed and not built is red;
 *   2. every name is required to appear in BOTH composition sources, so a
 *      controller composed in one process only is red;
 *   3. and the routes are then DRIVEN over real HTTP through the production
 *      composition, so what finally proves the mount is a request a cashier
 *      could make — not this constant.
 *
 * Without (1) and (3) the list would be exactly the self-describing artefact
 * `[[daftar-a-closure-rule-is-not-an-invariant]]` warns about. With them, the
 * list's job is to NAME the obligation; the suites' job is to refuse a tree in
 * which it is unmet.
 */
export const P4_S3_REQUIRED_CONTROLLERS: readonly string[] = Object.freeze(['PosCartController', 'PosReadsController', 'TillSessionsController']);
