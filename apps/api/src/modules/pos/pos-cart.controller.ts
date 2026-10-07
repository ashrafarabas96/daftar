import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post, UsePipes } from '@nestjs/common';
import { Membership, RequiresPermission } from '../../common/guards';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { POS_CART_ROUTE_AUTHORITY, type PosCartRoute } from './pos-cart-routes';
import { assertRemovalStatesNothing, cartUuidParam } from './pos-cart.schemas';
import type { CartAddLineRequest, CartChangeQuantityRequest, CartRequestDiscountRequest } from './pos-cart.schemas';
import { PosCartService, type CartDto } from './pos-cart.service';
import type { PosCartCommand } from './pos-price-authority';

/**
 * THE SERVER-SIDE CART'S TRANSPORT — four routes, each mutating ONE line
 * (P4-S3; `POS_CART_ROUTE_AUTHORITY` in `pos-cart-routes.ts:145`, lock
 * `P4-AL-18`, `P4-AL-35`, `P4-AL-37`, `P4-AL-44`, `P4-AL-86`).
 *
 * ## The table is the authority and this file is its mount
 *
 * `pos-cart-routes.ts` hands over the route table as DATA, and
 * `tests/guards/pos-s3-cart-law.test.ts` and
 * `tests/security/pos-s3-trust-boundary.test.ts` both compose their cases from
 * those rows. This controller takes its PIPE, its PERMISSION and its STATUS
 * from the same rows through `route()` below, so a difference between the
 * mounted surface and the handed-over table is not possible to introduce by
 * editing one of them: there is one copy.
 *
 * The PATHS are the one thing spelled as literals, for the reason
 * `till-sessions.controller.ts` records — `discoverPhase4Routes`
 * (`scripts/phase4-s1-gate.ts:1283`) reads the source text, so a path computed
 * from the table would be invisible to the slice gate and to the G-02 golden
 * checked against it. The guard suite asserts the literals against the table,
 * so the two cannot drift silently either.
 *
 * ## Every route declares a `@Body()`, INCLUDING the removal
 *
 * This is the hole `pos-s3-trust-boundary.test.ts` found on its first run, and
 * it is the reason `body: true` is on all four rows. `@UsePipes` runs per
 * handler PARAMETER: a `DELETE` handler with no `@Body()` never presents its
 * body to the pipe, so the price-authority scan never runs and a forged
 * `cartTotalMinor` came back `200` with nothing changed and nothing said.
 * «A field silently ignored is as wrong as a field obeyed.» Both halves of the
 * fix are here: the parameter exists so the pipe sees the body, AND
 * `assertRemovalStatesNothing` judges it in the handler's own code, so the
 * claim survives somebody removing a decorator in a later tidy-up. Do not undo
 * either half.
 *
 * ## One `BusinessTransactionId` per request, minted here
 *
 * All four service methods take it as their LAST argument, and it is minted
 * ONCE at this boundary exactly as `sale_commit` mints it
 * (`sales.controller.ts:69`). One HTTP request is one business transaction. A
 * service that minted its own would make two calls within one request
 * indistinguishable from two requests, which is precisely what the
 * `invctl/1` assertion's scope is supposed to pin down.
 *
 * ## `201` on the append alone
 *
 * `0079` makes the basket APPEND-ONLY, so a second scan of one variant really
 * is a second line and `201` is the honest answer. The other three revise an
 * existing line and answer `200`. `pos-cart-routes.ts:88-96` records that this
 * started as `200` everywhere and flipped when the identity of a line changed,
 * not when somebody's taste did.
 *
 * ## `sales.create` on all four rows, and `sales.discount` on none
 *
 * Selling, and taking the money for it, IS the normal flow at a till
 * (`P4-AL-35`: ORDINARY). The discount route's SENSITIVE `sales.discount` is
 * deliberately NOT a decorator: whether a discount was asked for depends on
 * the BODY, a decorator cannot see the body, and `PosCartService` refuses
 * `pos.cart_discount_not_permitted` rather than silently zeroing — a silently
 * zeroed discount charges the customer more than the cashier told them, and
 * the cashier finds out from the customer.
 *
 * There is no `GET` here (reading the cart belongs to the POS read surface;
 * every command answers with the whole RECOMPUTED cart, so a till never asks
 * twice), no route that posts a whole basket, no route that prices or totals,
 * no route that sells, and no public route.
 */

/** One row of the handed-over table, by command. The mount reads the table; it never restates it. */
function route(command: PosCartCommand): PosCartRoute {
  const found = POS_CART_ROUTE_AUTHORITY.find((r) => r.command === command);
  // A command with no row is a mount of a route nobody declared, which is the
  // drift this indirection exists to make impossible. It is a composition-time
  // defect, so it fails at class definition rather than on the first request.
  if (found === undefined) throw new Error(`POS_CART_ROUTE_AUTHORITY declares no route for ${command}`);
  return found;
}

const ADD = route('cart.add_line');
const QUANTITY = route('cart.change_quantity');
const REMOVE = route('cart.remove_line');
const DISCOUNT = route('cart.request_discount');

@Controller('/v1/pos/till-sessions/:sessionId/cart-lines')
export class PosCartController {
  constructor(@Inject(PosCartService) private readonly cart: PosCartService) {}

  /**
   * Append a line. `201`: the basket is append-only, so a line really is
   * created every time. Requires `sales.create`.
   */
  @Post()
  @HttpCode(ADD.status)
  @RequiresPermission(ADD.permission)
  @UsePipes(ADD.pipe())
  async addLine(@Membership() m: MembershipContext, @Param('sessionId') sessionId: string, @Body() body: CartAddLineRequest): Promise<CartDto> {
    return this.cart.addLine(m, cartUuidParam(sessionId, 'sessionId'), body, newBusinessTransactionId());
  }

  /** Revise one line's quantity. Requires `sales.create`. */
  @Patch(':cartLineId')
  @HttpCode(QUANTITY.status)
  @RequiresPermission(QUANTITY.permission)
  @UsePipes(QUANTITY.pipe())
  async changeQuantity(
    @Membership() m: MembershipContext,
    @Param('sessionId') sessionId: string,
    @Param('cartLineId') cartLineId: string,
    @Body() body: CartChangeQuantityRequest,
  ): Promise<CartDto> {
    return this.cart.changeQuantity(
      m,
      cartUuidParam(sessionId, 'sessionId'),
      cartUuidParam(cartLineId, 'cartLineId'),
      body.quantity,
      newBusinessTransactionId(),
    );
  }

  /**
   * Tombstone one line. Requires `sales.create`.
   *
   * The `@Body()` parameter and `assertRemovalStatesNothing` are BOTH the fix
   * for the hole described in this file's header: the parameter is what makes
   * the pipe's price-authority scan run at all, and the call is what judges a
   * body on a command that accepts none even if the decorator is ever removed.
   */
  @Delete(':cartLineId')
  @HttpCode(REMOVE.status)
  @RequiresPermission(REMOVE.permission)
  @UsePipes(REMOVE.pipe())
  async removeLine(
    @Membership() m: MembershipContext,
    @Param('sessionId') sessionId: string,
    @Param('cartLineId') cartLineId: string,
    @Body() body: unknown,
  ): Promise<CartDto> {
    assertRemovalStatesNothing(body);
    return this.cart.removeLine(m, cartUuidParam(sessionId, 'sessionId'), cartUuidParam(cartLineId, 'cartLineId'), newBusinessTransactionId());
  }

  /**
   * REQUEST a discount on one line. Requires `sales.create` at the route; the
   * SENSITIVE `sales.discount` is checked in the service, because whether a
   * discount was asked for depends on the body. A request of exactly zero is a
   * REMOVAL of a discount and needs the same key.
   */
  @Post(':cartLineId/discount')
  @HttpCode(DISCOUNT.status)
  @RequiresPermission(DISCOUNT.permission)
  @UsePipes(DISCOUNT.pipe())
  async requestDiscount(
    @Membership() m: MembershipContext,
    @Param('sessionId') sessionId: string,
    @Param('cartLineId') cartLineId: string,
    @Body() body: CartRequestDiscountRequest,
  ): Promise<CartDto> {
    return this.cart.requestDiscount(
      m,
      cartUuidParam(sessionId, 'sessionId'),
      cartUuidParam(cartLineId, 'cartLineId'),
      body.discountMinor,
      newBusinessTransactionId(),
    );
  }
}
