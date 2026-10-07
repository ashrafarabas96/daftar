import type { Permission } from '@daftar/domain-core';
import { RequiresPermission } from '../../common/guards';

/**
 * The permission key each P4-S5 returns route requires.
 *
 * **This module invents nothing, and the registry is a CLOSED SET OF TWELVE**
 * (`packages/domain-core/src/permissions.ts:75-89`, lock P4-AL-36). All three
 * keys below are already among the twelve, and S5 therefore makes NO registry
 * edit — which is the same resolution S4 reached and recorded
 * (`receivables-permissions.ts:30-40`):
 *
 * - `sales.return` (`permissions.ts:79`) — SENSITIVE (`permissions.ts:139`).
 *   Issuing or voiding a credit note returns goods and reverses revenue, which
 *   P4-AL-37 classifies as value-moving OUTSIDE the normal operating flow;
 * - `refunds.approve` (`permissions.ts:85`) — SENSITIVE (`permissions.ts:142`).
 *   Paying money back out is the clearest case of that class;
 * - `receivables.view` (`permissions.ts:87`) — a read key, ORDINARY, an owner
 *   and manager default and deliberately NOT a cashier one.
 *
 * **Neither sensitive key may be a DEFAULT of any built-in role.** `OD-P4-01` is
 * RULED OPTION A (2026-09-30) and `permissions.ts:131-145` states it in its own
 * words: "under the `OD-P4-01` OPTION A ruling none of them may be a DEFAULT of
 * any built-in role, the cashier and the manager included". So the two write
 * routes answer nobody until an owner grants the key explicitly, and that is the
 * intended behaviour rather than a gap — a merchant who has not decided who may
 * refund has decided that nobody may.
 *
 * `payments.reverse` appears nowhere here. A refund is not a reversal: a
 * reversal unwinds an entry that should not have been made, while a refund is a
 * lawful discharge of a liability that was correctly recorded. `payments.reverse`
 * is P4-S6's and a route for an authority this slice's database does not grant
 * is a route that cannot work.
 */

/**
 * The keys this module's routes name. `Extract` rather than a bare union, so
 * each name must BE a registered permission: the registry is the authority and
 * this list is checked against it BY THE COMPILER. A key renamed or dropped
 * there is a type error here, rather than a route that silently answers nobody.
 */
export type Phase4ReturnsPermission = Extract<Permission, 'sales.return' | 'refunds.approve' | 'receivables.view'>;

/**
 * The route decorator: `RequiresPermission` narrowed to this module's three
 * keys, and nothing else. There is no default, no fallback key and no "any of" —
 * a route names exactly one key.
 */
export function phase4ReturnsPermission(permission: Phase4ReturnsPermission): MethodDecorator & ClassDecorator {
  return RequiresPermission(permission);
}

/**
 * Every route of this module and the key it requires — the list the Phase 4
 * gate checks a route enumeration against, and the list the registry owner
 * reads. The shape is `RECEIVABLES_ROUTE_AUTHORITY`'s
 * (`receivables-permissions.ts:81-118`), deliberately, so one reader can compare
 * the two slices side by side.
 *
 * ## The reads are the SAME GATE and the SAME PROJECTION as the writes
 *
 * Not a second permission list and not a second shape of the row. A reader
 * behind a weaker gate is a leak; a reader behind a different projection is a
 * second truth about the same document. The reads here are gated on
 * `receivables.view` rather than on the sensitive write keys because reading is
 * ordinary — but they project `CreditNoteDto` and `RefundDto`, the EXACT shapes
 * the commands answer with, and no field is added or dropped between them.
 *
 * ## Their refusal set is NOT the writes'
 *
 * A read refuses on absence and on authority. It does not inherit
 * `*_inconsistent`, `*_immutable`, `*_changed` or `registry_incomplete`, and it
 * is not documented as if it did. An EMPTY collection is never a refusal:
 * `200 []` is the correct answer for a customer with no credit note — which is
 * also why such a route must not be driven by a generic ALLOW/DENY loop in the
 * cross-tenant golden. The isolation claim for a collection read is about
 * CONTENTS: under A's header the array holds A's own credit note and not one of
 * A2's or B's.
 *
 * `sensitiveInBody` is absent from every row, and that absence is a fact rather
 * than an omission: no command here has a body-decided second key. A refund's
 * authority does not depend on its amount or on which source it draws on —
 * `refunds.approve` covers both kinds, because a cap is not an authority
 * boundary.
 */
export const RETURNS_ROUTE_AUTHORITY: readonly {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly permission: Phase4ReturnsPermission;
  readonly sensitive: boolean;
  readonly businessWide: boolean;
}[] = Object.freeze([
  // ── The three commands ──────────────────────────────────────────────
  Object.freeze({ method: 'POST' as const, path: '/v1/credit-notes', permission: 'sales.return' as const, sensitive: true, businessWide: false }),
  Object.freeze({
    method: 'POST' as const,
    path: '/v1/credit-notes/:creditNoteId/void',
    permission: 'sales.return' as const,
    sensitive: true,
    businessWide: false,
  }),
  Object.freeze({ method: 'POST' as const, path: '/v1/refunds', permission: 'refunds.approve' as const, sensitive: true, businessWide: false }),
  // ── The reads of what they wrote ────────────────────────────────────
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/credit-notes/:creditNoteId',
    permission: 'receivables.view' as const,
    sensitive: false,
    businessWide: false,
  }),
  Object.freeze({ method: 'GET' as const, path: '/v1/refunds/:refundId', permission: 'receivables.view' as const, sensitive: false, businessWide: false }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId/credit-notes',
    permission: 'receivables.view' as const,
    sensitive: false,
    businessWide: true,
  }),
  Object.freeze({
    method: 'GET' as const,
    path: '/v1/customers/:customerId/refunds',
    permission: 'receivables.view' as const,
    sensitive: false,
    businessWide: true,
  }),
]);
