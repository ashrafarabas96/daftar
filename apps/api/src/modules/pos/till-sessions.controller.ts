import { Body, Controller, Get, HttpCode, Inject, Param, Post, UsePipes } from '@nestjs/common';
import type { PosCheckoutDto } from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import { ZodValidationPipe } from '../../common/validation';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { cartUuidParam } from './pos-cart.schemas';
import { TillSessionCloseSchema, TillSessionOpenSchema, type TillSessionCloseRequest, type TillSessionOpenRequest } from './pos.schemas';
import { TillSessionService, type TillSession } from './till-session.service';
import { PosCheckoutPipe, type PosCheckoutRequest } from './pos-checkout.schemas';
import { PosCheckoutService } from './pos-checkout.service';

/**
 * THE TILL-SESSION ROUTES OF P4-S3 — the transport for `TillSessionService`
 * (`OD-P4-01` OPTION A, `OD-P4-09` OPTION A; lock `P4-AL-30`, `P4-AL-35`,
 * `P4-AL-37`, `P4-AL-39`, `P4-AL-40`, `P4-AL-48`).
 *
 * ## Why this file exists at all, when three P4-S3 modules said it must not
 *
 * `pos-reads.ts`, `pos-cart-routes.ts` and the deleted
 * `tests/helpers/pos-s3-route.ts` each recorded the same reasoning: a
 * `*.controller.ts` under `apps/api/src/modules/pos` is DISCOVERED by
 * `discoverPhase4Routes` (`scripts/phase4-s1-gate.ts:1283`) from its SOURCE
 * TEXT, and the sealed G-02 golden asserts its own route list EQUAL to that
 * discovery — so the mere existence of this file turns that golden red unless
 * the golden grows these routes' cross-tenant pairs in the SAME commit. That
 * is exactly what this commit does, which is why the file may now exist. The
 * reasoning was never "a POS controller is wrong"; it was "the transport, the
 * goldens and the route surface land together, once". They do.
 *
 * Every route decorator below spells its path as a STRING LITERAL, and that is
 * load-bearing rather than stylistic: `discoverPhase4Routes` reads the source
 * with a regex, so a path assembled from `POS_ROUTE_AUTHORITY` at runtime
 * would be invisible to the gate and to the golden that is checked against it.
 * The table in `pos-permissions.ts` stays the authority a reviewer reads and a
 * suite asserts against; the literals are what the static discovery can see.
 *
 * ## `HttpCode(200)` on the open, and that is honesty rather than habit
 *
 * `pos_till_session_open` is a REPLAYABLE command (`P4-AL-30`): the
 * caller-supplied `sessionId` is the key and the stored `open_intent_sha256`
 * is the proof, so a repeat of the same request answers from the stored row
 * and creates nothing. A `201` on that call would tell a till it had just
 * opened a second drawer. The accepted `POST /v1/sales` precedent
 * (`sales.controller.ts:65`) answers `200` for the same reason, and the cart's
 * append — which really does create a row every time — answers `201`. The
 * difference between the two is the identity of the thing, not an opinion
 * about verbs.
 *
 * ## `GET current` is declared before `GET :sessionId`
 *
 * Nest matches in declaration order, so the literal segment has to come first
 * or `current` is read as a session id — and, because `cartUuidParam` refuses
 * a non-canonical uuid with `pos.session_not_found`, the failure would have
 * been a plausible-looking 404 rather than an obvious misroute.
 *
 * ## What this controller does NOT do
 *
 * It re-decides nothing. The owner of a session is the verified assertion's
 * actor and never a request field, the currency is server-derived, the branch
 * scope is the authorization's and the RLS policies', and the replay is the
 * routine's. There is no reopen, no take-over and no transfer route, because a
 * change of user is a NEW session (`OD-P4-09`) and a route for any of them
 * would be the refused OPTION B with a URL in front of it. It creates no
 * accounting object, because P4-S3 creates none at all.
 */
@Controller('/v1/pos/till-sessions')
export class TillSessionsController {
  // Explicit `@Inject`, as every controller in this repository is written:
  // esbuild does not implement `emitDecoratorMetadata`, so a parameter typed
  // only by its TypeScript type injects `undefined` under vitest.
  constructor(
    @Inject(TillSessionService) private readonly sessions: TillSessionService,
    @Inject(PosCheckoutService) private readonly checkouts: PosCheckoutService,
  ) {}

  /**
   * Open a till for the AUTHENTICATED user. Requires `sales.create` — the
   * cashier's own ORDINARY minting key (`P4-AL-37`), not a thirteenth
   * permission invented for the occasion (`pos-permissions.ts`).
   *
   * The `BusinessTransactionId` is minted ONCE here, at the API boundary,
   * exactly as `sale_commit` mints it: one request is one business
   * transaction, and a service that minted its own would make two calls of one
   * request indistinguishable from two requests.
   */
  @Post()
  @HttpCode(200)
  @RequiresPermission('sales.create')
  @UsePipes(new ZodValidationPipe(TillSessionOpenSchema))
  async open(@Membership() m: MembershipContext, @Body() body: TillSessionOpenRequest): Promise<TillSession> {
    return this.sessions.open(m, body, newBusinessTransactionId());
  }

  /**
   * Count the till and close it. Requires `sales.create`: closing is the last
   * act of selling for cash, not a separate authority.
   *
   * The basket is neither emptied nor required to be empty — a closed session
   * and its lines are the frozen record of the shift.
   */
  @Post(':sessionId/close')
  @HttpCode(200)
  @RequiresPermission('sales.create')
  @UsePipes(new ZodValidationPipe(TillSessionCloseSchema))
  async close(@Membership() m: MembershipContext, @Param('sessionId') sessionId: string, @Body() body: TillSessionCloseRequest): Promise<TillSession> {
    return this.sessions.close(m, cartUuidParam(sessionId, 'sessionId'), body, newBusinessTransactionId());
  }

  /**
   * **THE ATOMIC POS CHECKOUT** (TL-P4-S3-R1). Turn this till's basket into an
   * accepted sale, and consume exactly the cart rows that sale was derived
   * from, in ONE transaction. Requires `sales.create` — the same ORDINARY
   * cashier key the cart's four commands and the sale commit name, because
   * ringing a basket up IS selling and P4-S3 invents no permission.
   *
   * `HttpCode(200)` for the `POST /v1/sales` and `POST /v1/pos/till-sessions`
   * reason: the command is REPLAYABLE on its caller-supplied `saleId`, so a
   * repeat answers from the stored sale and creates nothing. A `201` would
   * tell a till it had just made a second sale.
   *
   * The body states the sale's HEADER and nothing about the basket: no lines,
   * no warehouse, no currency, no price, no discount and no total. Those are
   * read from `pos_cart_lines`, the session and the catalogue inside the
   * checkout's own transaction, and `PosCheckoutPipe` refuses a request that
   * tried to state one BY NAME (P4-AL-18).
   */
  @Post(':sessionId/checkout')
  @HttpCode(200)
  @RequiresPermission('sales.create')
  @UsePipes(new PosCheckoutPipe())
  async checkout(@Membership() m: MembershipContext, @Param('sessionId') sessionId: string, @Body() body: PosCheckoutRequest): Promise<PosCheckoutDto> {
    return this.checkouts.checkout(m, cartUuidParam(sessionId, 'sessionId'), body, newBusinessTransactionId());
  }

  /**
   * The caller's OWN open till, or `null`. Requires `sales.view`.
   *
   * `null` rather than a refusal: "I have no till open" is a legitimate answer
   * a POS screen renders as the open-till prompt. There is no id to supply, so
   * there is no way to ask this question about somebody else.
   */
  @Get('current')
  @RequiresPermission('sales.view')
  async current(@Membership() m: MembershipContext): Promise<TillSession | null> {
    return this.sessions.current(m);
  }

  /**
   * One till session. Requires `sales.view`.
   *
   * A colleague's session in the caller's own business is REFUSED
   * (`pos.session_not_owned`) and not merely filtered; a session in another
   * business is invisible under RLS and answers `pos.session_not_found`, which
   * is deliberately the same answer a malformed id gets — a path that
   * distinguished them would be an oracle for which session ids exist.
   */
  @Get(':sessionId')
  @RequiresPermission('sales.view')
  async read(@Membership() m: MembershipContext, @Param('sessionId') sessionId: string): Promise<TillSession> {
    return this.sessions.read(m, cartUuidParam(sessionId, 'sessionId'));
  }
}
