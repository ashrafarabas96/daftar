import type { ZodType } from 'zod';
import type { Permission } from '@daftar/domain-core';
import { CartCommandPipe, POS_CART_SCHEMAS } from './pos-cart.schemas';
import { POS_CART_COMMANDS, type PosCartCommand } from './pos-price-authority';
import type { PosCode } from './pos-errors';

/**
 * THE CART'S ROUTE TABLE — as DATA, and deliberately not as a controller.
 *
 * ## Why there is no `pos-cart.controller.ts`
 *
 * `discoverPhase4Routes` (`scripts/phase4-s1-gate.ts`) walks ALL of
 * `apps/api/src/modules` for files ending `.controller.ts` and extracts route
 * paths from the SOURCE TEXT, keeping everything under
 * `PHASE4_ROUTE_PREFIXES` — which includes `/v1/pos`. The G-02 golden
 * `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts` asserts its
 * own route list EQUAL to that discovery, so the MERE EXISTENCE of a POS
 * controller file turns a sealed P4-S1 golden red whether or not Nest ever
 * mounts it. And `tests/security/phase4-route-surface.test.ts` derives the
 * declared Phase 4 surface from `apps/api/src/modules/selling` alone while
 * requiring every `/v1/pos` verb to answer 404, so a POS controller is
 * invisible to that derivation and would make the route answer.
 *
 * Both edits — the goldens, the route surface and the mount itself — land
 * ONCE, from the slice coordinator, together and after `0079`. Not three times
 * from three agents. So this module hands over the route table and the
 * coordinator mounts it.
 *
 * ## Why a table is better than a prose hand-over anyway
 *
 * The table is checkable. `tests/guards/pos-s3-cart-law.test.ts` asserts that
 * every row names a registered permission, carries a request schema and
 * carries the boundary pipe; `tests/security/pos-s3-trust-boundary.test.ts`
 * composes its HTTP cases FROM these rows, so the trust boundary is proved
 * against the surface that will actually be mounted rather than against a
 * hand-written copy of it. A route the coordinator mounts differently from
 * this table is a difference two suites can see.
 *
 * It follows the shape `POS_ROUTE_AUTHORITY` (`pos-permissions.ts`) already
 * uses for the till-session routes, including the `:sessionId` spelling of the
 * session segment, so one POS module has one name for one thing.
 *
 * ## The surface is the law
 *
 * Four routes, each mutating ONE line, and there is deliberately:
 *
 * - **no route that posts a whole basket.** `POST .../cart` with a `lines`
 *   array is precisely the client-side cart P4-AL-18 forbids — "the
 *   forged-totals attack of §12 with no attacker required" — so `lines` is in
 *   the forged-field table and a body carrying one is refused BY NAME;
 * - **no route that prices, totals or quotes.** Every response is the whole
 *   RECOMPUTED cart, so a client has nothing to compute and nothing to send
 *   back;
 * - **no route that sells.** The cart does not become a sale here. The one
 *   sale writer is `sale_commit` behind `POST /v1/sales`, and P4-S3 creates no
 *   accounting object at all;
 * - **no public route.** The basket is server-side state keyed by an
 *   AUTHENTICATED till session (P4-AL-86), which is what keeps Phase 6's
 *   public checkout cart a different thing from this one;
 * - **no `GET`.** Reading the cart belongs to this slice's POS read surface.
 *   Each command answers with the recomputed cart, so a till never asks twice.
 *
 * ## `sales.create` on all four, and `sales.discount` on none
 *
 * P4-AL-35's matrix classifies `sales.create` as ORDINARY — selling, and
 * taking the money for it, IS the normal flow at a till. The discount route's
 * SENSITIVE `sales.discount` is deliberately NOT on its row: whether a
 * discount was asked for depends on the BODY and a route decorator cannot see
 * the body, so the service checks it (the accepted `sale_commit` precedent)
 * and refuses `pos.cart_discount_not_permitted` rather than silently zeroing.
 * P4-S3 invents no permission key.
 */

/** One cart route, with everything the mount needs and everything a test can assert. */
export interface PosCartRoute {
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  /** The path, with the till-session surface's own `:sessionId` spelling. */
  readonly path: string;
  /** The command this route carries — the key into the schema and accepted-key tables. */
  readonly command: PosCartCommand;
  readonly permission: Permission;
  /**
   * `false` on every row. The SENSITIVE `sales.discount` is a body-dependent
   * check in the service, never a route decorator (P4-AL-35, P4-AL-37).
   */
  readonly sensitive: false;
  /**
   * `201` on the add and `200` on the other three.
   *
   * This started as `200` everywhere, on the ground that a second add of one
   * variant MERGED into the existing line and `201` would wrongly tell the
   * till a line had been created. `0079` makes the basket append-only, so a
   * second scan really is a second line — and the honest answer flipped with
   * the identity, not with the opinion. The argument was about honesty both
   * times, which is why it is recorded rather than quietly edited.
   */
  readonly status: 200 | 201;
  /**
   * TRUE on every row, including the removal — and that is load-bearing, not
   * decoration.
   *
   * `@UsePipes` runs per handler PARAMETER: a handler with no `@Body()` never
   * presents its body to the pipe, so the authority scan never runs on it. The
   * first run of `tests/security/pos-s3-trust-boundary.test.ts` found exactly
   * that hole on the `DELETE` route — a forged `cartTotalMinor` came back
   * `200` with nothing changed and nothing said. SILENTLY IGNORED, which the
   * slice's law is explicit is as wrong as obeyed. Every route declares a
   * body, the removal's schema is the empty strict object, and
   * `assertRemovalStatesNothing` judges it in the handler's own code so the
   * claim survives somebody removing a decorator in a later tidy-up.
   */
  readonly body: true;
  /** The request schema, `.strict()` — the SECOND line of defence behind the scan. */
  readonly schema: ZodType;
  /** The boundary pipe for this command: the authority scan, THEN the schema, as one object. */
  readonly pipe: () => CartCommandPipe;
  /** The refusals this route can answer with, by registered code. The list a reviewer checks. */
  readonly refusals: readonly PosCode[];
}

/** Every refusal a cart route shares — the trust boundary, the session gate, the arithmetic. */
const COMMON_REFUSALS: readonly PosCode[] = Object.freeze([
  // The trust boundary (P4-AL-18) — the slice's central claim.
  'pos.cart_price_authority_refused',
  'pos.cart_field_unknown',
  // The session gate, resolved inside the mutation's own statement. Every one
  // of these is the till-session surface's registered code: a cart command
  // invents no second vocabulary for a session fact.
  'pos.session_not_found',
  'pos.session_not_open',
  'pos.session_not_owned',
  // The arithmetic, over the catalogue.
  'pos.cart_product_not_priced',
  'pos.cart_currency_mixed',
  'pos.cart_discount_invalid',
  'pos.cart_lines_too_many',
  // The internal invariants: 500, generic, the typed code and nothing else.
  'pos.cart_rounding_grain_invalid',
  'pos.cart_minor_units_invalid',
  'pos.cart_statement_plan_invalid',
]);

const BASE = '/v1/pos/till-sessions/:sessionId/cart-lines';

export const POS_CART_ROUTE_AUTHORITY: readonly PosCartRoute[] = Object.freeze([
  Object.freeze({
    method: 'POST' as const,
    path: BASE,
    command: 'cart.add_line' as const,
    permission: 'sales.create' as const,
    sensitive: false as const,
    // 201: the append really creates a line, every time.
    status: 201 as const,
    body: true as const,
    schema: POS_CART_SCHEMAS['cart.add_line'],
    pipe: () => new CartCommandPipe('cart.add_line'),
    refusals: Object.freeze([...COMMON_REFUSALS, 'pos.cart_product_not_found', 'pos.cart_quantity_invalid'] as PosCode[]),
  }),
  Object.freeze({
    method: 'PATCH' as const,
    path: `${BASE}/:cartLineId`,
    command: 'cart.change_quantity' as const,
    permission: 'sales.create' as const,
    sensitive: false as const,
    status: 200 as const,
    body: true as const,
    schema: POS_CART_SCHEMAS['cart.change_quantity'],
    pipe: () => new CartCommandPipe('cart.change_quantity'),
    refusals: Object.freeze([...COMMON_REFUSALS, 'pos.cart_line_not_found', 'pos.cart_quantity_invalid'] as PosCode[]),
  }),
  Object.freeze({
    method: 'DELETE' as const,
    path: `${BASE}/:cartLineId`,
    command: 'cart.remove_line' as const,
    permission: 'sales.create' as const,
    sensitive: false as const,
    status: 200 as const,
    body: true as const,
    schema: POS_CART_SCHEMAS['cart.remove_line'],
    pipe: () => new CartCommandPipe('cart.remove_line'),
    refusals: Object.freeze([...COMMON_REFUSALS, 'pos.cart_line_not_found'] as PosCode[]),
  }),
  Object.freeze({
    method: 'POST' as const,
    path: `${BASE}/:cartLineId/discount`,
    command: 'cart.request_discount' as const,
    permission: 'sales.create' as const,
    sensitive: false as const,
    status: 200 as const,
    body: true as const,
    schema: POS_CART_SCHEMAS['cart.request_discount'],
    pipe: () => new CartCommandPipe('cart.request_discount'),
    // The SENSITIVE one, refused in the service and never silently zeroed.
    refusals: Object.freeze([...COMMON_REFUSALS, 'pos.cart_line_not_found', 'pos.cart_discount_not_permitted'] as PosCode[]),
  }),
]);

/**
 * The service method each route calls, as data — so the hand-over names the
 * whole mount and not only the URLs. `PosCartService` is the provider; the
 * coordinator spreads it into `posProviders()`, which is the till-session
 * owner's file and not this one's.
 */
export const POS_CART_ROUTE_HANDLERS: Readonly<Record<PosCartCommand, keyof import('./pos-cart.service').PosCartService>> = Object.freeze({
  'cart.add_line': 'addLine',
  'cart.change_quantity': 'changeQuantity',
  'cart.remove_line': 'removeLine',
  'cart.request_discount': 'requestDiscount',
});

/** One route per command, asserted here so the table cannot drift from the command set by one row. */
export const POS_CART_ROUTE_COUNT = POS_CART_COMMANDS.length;
