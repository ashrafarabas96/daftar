import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { PosProductSearchDto } from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import { localeOf } from '../../common/locale';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { cartUuidParam } from './pos-cart.schemas';
import { PosCartService, type CartDto } from './pos-cart.service';
import { PosProductSearchQuerySchema } from './pos-read.schemas';
import { PosReadService } from './pos-reads';

/**
 * THE POS READ SURFACE'S TRANSPORT — two routes, `GET /v1/pos/products` and
 * `GET /v1/pos/till-sessions/:sessionId/cart-lines`
 * (P4-S3; `POS_READ_ROUTE_AUTHORITY` in `pos-reads.ts`).
 *
 * ## Why the cart read is mounted HERE and not on `PosCartController`
 *
 * `pos-cart.controller.ts` states, as its own law, that it has «no `GET` …
 * reading the cart belongs to this slice's POS read surface», and
 * `pos-cart-routes.ts` says the same about the route table: four routes, each
 * mutating ONE line. So the read is mounted on the READ surface, which is
 * this controller, and its authority row is in `POS_READ_ROUTE_AUTHORITY`
 * rather than in the four-row command table. The command table stays four
 * rows, one per `PosCartCommand`, and nothing a command suite asserts about
 * it has to be excused.
 *
 * It is answered by `PosCartService.readCart` and not by `PosReadService`,
 * because the basket's gate, the basket's projection and the one rounding
 * layer (`recompute`) all live on the cart service. A read that queried
 * `pos_cart_lines` from here would be a SECOND definition of "the cart".
 *
 * ## This replaces a test-only harness, and that was the point of the task
 *
 * Until this file landed, the only transport for this read was
 * `tests/helpers/pos-s3-route.ts`, which constructed `PosReadService` by hand
 * inside a test-declared controller. Every POS read assertion therefore
 * measured a hand-built object reached through `ModuleRef`, not a route a
 * cashier can reach: the composition, the provider wiring and the DI graph
 * were all outside the subject. The harness is deleted and both read suites
 * now go through `createTestApp()`, so the thing they assert against is the
 * thing production serves. «A sale endpoint that requires manual SQL setup is
 * not a complete product path» — and a read endpoint that requires a bespoke
 * test harness is not one either.
 *
 * ## The scope is the SESSION's, and the client never names a warehouse
 *
 * `PosProductSearchQuerySchema` is `.strict()` and carries `sessionId`, not
 * `warehouseId` (RULING 2). The till's warehouse is a fact of the session —
 * `NOT NULL`, immutable under `pos_till_session_guard()`, and carrying a
 * composite foreign key into `warehouses (business_id, id)` — so a client that
 * could name it could name a warehouse its own open till does not sell from.
 * That is `P4-AL-18` exactly, which is why the warehouse is derived in
 * `PosReadService.resolveTillWarehouse` and the unknown key is refused here
 * rather than dropped: a POS client whose filter was silently ignored believes
 * it asked the server for something the server never did.
 *
 * ## `sales.view`, never `inventory.view`
 *
 * The built-in cashier role holds `catalog.view`, `sales.view`,
 * `sales.create`, `customers.view` and `payments.collect` and NO inventory key
 * at all (`permissions.ts:214`), so gating the till's own search on
 * `inventory.view` would lock the cashier out of the till. The service repeats
 * the check with `requireAnyPermission`, which is not duplication: the
 * decorator is the route's authority and the service's check is what holds if
 * this read is ever reached from another transport.
 *
 * The path is a STRING LITERAL for the reason `till-sessions.controller.ts`
 * records: `discoverPhase4Routes` reads the source text, so a path computed
 * from the authority table would be invisible to the slice gate and to the
 * G-02 golden that is checked against it.
 */
@Controller('/v1/pos')
export class PosReadsController {
  constructor(
    @Inject(PosReadService) private readonly reads: PosReadService,
    @Inject(PosCartService) private readonly cart: PosCartService,
  ) {}

  /** The product type-ahead. Requires `sales.view`; the warehouse comes from the named session. */
  @Get('products')
  @RequiresPermission('sales.view')
  async products(@Membership() m: MembershipContext, @Query() query: unknown, @Req() req: Request): Promise<PosProductSearchDto> {
    return this.reads.searchProducts(m, PosProductSearchQuerySchema.parse(query), localeOf(req));
  }

  /**
   * The till basket, as the SERVER holds it — the same `CartDto` the four cart
   * commands answer with, so a reloaded till screen recovers exactly what its
   * last command reported. Requires `sales.view`.
   *
   * There is no `@Body()` and no `@Query()`: a read that accepted a price, a
   * total, a tax or a line would be the forged-totals surface `P4-AL-18`
   * forbids, and here it is not refused — it is INEXPRESSIBLE, because the
   * handler takes nothing but the session in the path. A malformed `sessionId`
   * is `pos.session_not_found` through `cartUuidParam`, the same answer as
   * another business's session, so the path is no oracle for which ids exist.
   */
  @Get('till-sessions/:sessionId/cart-lines')
  @RequiresPermission('sales.view')
  async cartLines(@Membership() m: MembershipContext, @Param('sessionId') sessionId: string): Promise<CartDto> {
    return this.cart.readCart(m, cartUuidParam(sessionId, 'sessionId'));
  }
}
