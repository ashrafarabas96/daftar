import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { hasPermission } from '@daftar/domain-core';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { Logger } from '../../infra/logger';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { minorToString, priceCart, roundingGrains, type PricedCart, type StoredCartLine } from './pos-cart-pricing';
import { cartStatementPlan, setLineParams, CART_STATEMENTS_PER_COMMAND, type CartCommandTarget, type CartStatement } from './pos-cart-statements';
import { posRefusal, type PosCode } from './pos-errors';
import type { PosCartCommand } from './pos-price-authority';

/**
 * The server-side till basket (P4-S3; lock P4-AL-18, P4-AL-06, P4-AL-35,
 * P4-AL-40; `OD-P4-02` OPTION A).
 *
 * Four commands and nothing else: add a line, change a quantity, remove a
 * line, request a discount. The cart lives on the server, keyed by the till
 * session, and the response is RECOMPUTED on the way out of every one of them
 * — because a client-side cart that posts a finished basket "is the
 * forged-totals attack of §12 with no attacker required" (P4-AL-18).
 *
 * ## What this service is NOT
 *
 * - **not the session lifecycle.** Opening and closing a till session is
 *   Agent A's surface in this slice. This service READS
 *   `pos_till_sessions.status` inside its own mutation statement and refuses
 *   `pos.cart_till_session_not_usable` behind a session that is absent,
 *   closed, or another business's (invisible by RLS, so it reads as unusable
 *   rather than as forbidden). It never writes that relation;
 * - **not the sale.** No cart command creates a sale, an invoice, a stock
 *   movement, a journal entry or an accounting object of any kind. P4-S3
 *   creates NO accounting object at all, and the one sale writer stays
 *   `sale_commit`;
 * - **not a payment, an allocation, a credit, a refund, a return or an
 *   installment.** P4-S3 owns none of them and this service can express none
 *   of them.
 *
 * ## The statement discipline
 *
 * Every command runs `cartStatementPlan`'s TWO statements, in order, inside
 * ONE transaction, through a narrow `CartSql` port — and `runPlan` runs the
 * plan and nothing else. That is what makes "the cart's statement count is
 * constant in the line count" a property of the code rather than of a
 * measurement: the executor has no path by which it could issue a third
 * statement, and no loop anywhere in this file touches the database.
 *
 * ## RLS, not a filter
 *
 * Every statement runs inside `db.withTransaction`, which sets the tenant and
 * business GUCs the policies read. The `tenant_id`/`business_id` predicates in
 * the statements are index predicates and NOT the isolation (P4-AL-40): a row
 * of another business is invisible, and a command that named one reads as not
 * found. RLS is never weakened for a test.
 */

/**
 * The narrow port the plan is executed through: one method, and the one method
 * a statement counter can wrap.
 *
 * The service depends on this rather than on a `PoolClient` so that
 * `tests/integration/pos-s3-cart.test.ts` can count what ONE operation issues
 * without stubbing the service, the plan or the pricing — the three things
 * actually under test.
 */
export interface CartSql {
  query<T extends QueryResultRow>(text: string, params: readonly unknown[]): Promise<readonly T[]>;
}

/** A `CartSql` that records every statement it was asked to issue, in order. */
export class RecordingCartSql implements CartSql {
  readonly issued: { readonly text: string; readonly params: readonly unknown[] }[] = [];
  constructor(private readonly answers: (text: string, params: readonly unknown[]) => readonly QueryResultRow[]) {}
  async query<T extends QueryResultRow>(text: string, params: readonly unknown[]): Promise<readonly T[]> {
    this.issued.push({ text, params });
    return this.answers(text, params) as readonly T[];
  }
}

/**
 * The GATE's one row: the session verdict, the ordinal to call the routine
 * with, and what the addressed line currently is.
 *
 * Every field is a fact the SERVER then states to `pos_cart_set_line`. The
 * client supplied none of them.
 */
interface GateRow extends QueryResultRow {
  /** The isolation step: 0 means invisible — another tenant's or business's, or never opened. */
  session_visible: string;
  /** The lifecycle step: 0 means the till is closed. */
  session_open: string;
  /** The `OD-P4-09` step: 0 means it is a colleague's till. */
  session_usable: string;
  /** `max(line_no) + 1` over the whole basket, tombstones included. The append's ordinal. */
  next_line_no: number;
  /** 1 when a row with this id exists in this session, tombstoned or not. */
  line_present: string;
  /** 1 when that row is already tombstoned — the half that makes the removal idempotent AND 404-able. */
  line_removed: string;
  /** The existing line's own ordinal and identities, for a REVISION's routine call. */
  line_no: number | null;
  product_id: string | null;
  variant_id: string | null;
}

interface ProjectionRow extends QueryResultRow {
  cart_line_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: string;
  discount_minor: string;
  unit_price_minor: string | null;
  price_currency: string | null;
  name_snapshot: string;
}

/** The recomputed cart, as the wire carries it: every money figure a decimal STRING of minor units. */
export interface CartDto {
  readonly tillSessionId: string;
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly discountMinor: string;
  /** Structurally zero (P4-AL-44, `OD-03` OPEN). Reported because it is derived, never because it was stated. */
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly lines: readonly {
    readonly cartLineId: string;
    readonly productId: string;
    readonly variantId: string | null;
    readonly name: string;
    readonly quantity: string;
    readonly unitPriceMinor: string;
    readonly grossMinor: string;
    readonly discountMinor: string;
    readonly netMinor: string;
  }[];
}

@Injectable()
export class PosCartService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /** Add a line, or merge into the existing line for this variant. Requires `sales.create`. */
  async addLine(m: MembershipContext, tillSessionId: string, input: { productId: string; variantId: string | null; quantity: string }): Promise<CartDto> {
    return this.run(m, 'cart.add_line', {
      ...this.base(m, tillSessionId),
      // The server mints the line id. A client-supplied one would let a till
      // name a row in another basket, and the cart has no idempotency contract
      // the id could be the key of.
      cartLineId: randomUUID(),
      productId: input.productId,
      variantId: input.variantId,
      quantity: input.quantity,
      discountMinor: null,
    });
  }

  /** Change one line's quantity. Requires `sales.create`. */
  async changeQuantity(m: MembershipContext, tillSessionId: string, cartLineId: string, quantity: string): Promise<CartDto> {
    return this.run(m, 'cart.change_quantity', { ...this.base(m, tillSessionId), cartLineId, productId: null, variantId: null, quantity, discountMinor: null });
  }

  /** Remove one line. Requires `sales.create`. */
  async removeLine(m: MembershipContext, tillSessionId: string, cartLineId: string): Promise<CartDto> {
    return this.run(m, 'cart.remove_line', {
      ...this.base(m, tillSessionId),
      cartLineId,
      productId: null,
      variantId: null,
      quantity: null,
      discountMinor: null,
    });
  }

  /**
   * REQUEST a discount on one line.
   *
   * `sales.discount` is SENSITIVE (P4-AL-35) and is checked HERE rather than
   * at a decorator, because whether a discount was asked for depends on the
   * BODY and a decorator cannot see it — the accepted `sale_commit` precedent.
   * A discount asked without the key is REFUSED, never silently zeroed: a
   * silently-zeroed discount charges the customer more than the cashier told
   * them, and the cashier finds out from the customer.
   *
   * A request of exactly zero is a REMOVAL of a discount and needs the same
   * key, because setting a discount to zero changes the price the cashier
   * quoted just as surely as setting it to anything else.
   */
  async requestDiscount(m: MembershipContext, tillSessionId: string, cartLineId: string, discountMinor: string): Promise<CartDto> {
    if (!hasPermission(m.roles, 'sales.discount')) throw posRefusal('pos.cart_discount_not_permitted');
    return this.run(m, 'cart.request_discount', {
      ...this.base(m, tillSessionId),
      cartLineId,
      productId: null,
      variantId: null,
      quantity: null,
      discountMinor,
    });
  }

  /**
   * The identities a cart command is built from, all three resolved from the
   * AUTHENTICATED membership and none of them a request field: the tenant, the
   * business (P4-AL-40 — scope is RLS, never a payload) and the actor
   * (`OD-P4-09` — a client that could name the owner could add to a
   * colleague's till).
   */
  private base(m: MembershipContext, tillSessionId: string): Pick<CartCommandTarget, 'tenantId' | 'businessId' | 'tillSessionId' | 'actorUserId'> {
    return { tenantId: m.tenantId, businessId: m.businessId, tillSessionId, actorUserId: m.userId };
  }

  /**
   * One command: ONE transaction, the plan's three statements in order, then
   * the server's arithmetic over what came back.
   *
   * The refusals are read off the GATE's own columns rather than from a second
   * query: `session_usable = 0` is an unusable session, and `line_present`
   * with `line_removed` are what let the removal be idempotent for a line
   * already gone while still answering 404 for one that was never here.
   */
  private async run(m: MembershipContext, command: PosCartCommand, target: CartCommandTarget): Promise<CartDto> {
    const plan = cartStatementPlan(command, target);
    this.assertPlanIsConstant(plan, command);
    const projected = await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId }, async (client) => {
      const sql: CartSql = {
        query: async <T extends QueryResultRow>(text: string, params: readonly unknown[]): Promise<readonly T[]> =>
          (await client.query<T>(text, [...params])).rows,
      };
      return this.runPlan(sql, plan, command, target);
    });
    return this.recompute(target.tillSessionId, projected);
  }

  /**
   * Run exactly the plan: the gate, the routine, the projection. No statement
   * is issued that the plan does not hold, and all three roles are checked
   * rather than assumed — a plan whose shape drifted is a 500 and not a
   * silently different operation.
   *
   * The routine is `0079`'s SECURITY DEFINER writer, because `daftar_app`
   * holds SELECT and only SELECT on both POS relations: there is no direct
   * INSERT, UPDATE or DELETE this service could issue even if it wanted to.
   * The assertion that authorizes it is presented at `BEGIN` by the seam, so
   * it costs no statement here.
   */
  async runPlan(sql: CartSql, plan: readonly CartStatement[], command: PosCartCommand, target: CartCommandTarget): Promise<readonly StoredCartLine[]> {
    const [gateStatement, routine, projectionStatement] = plan;
    if (
      plan.length !== CART_STATEMENTS_PER_COMMAND ||
      gateStatement?.role !== 'gate' ||
      routine?.role !== 'routine' ||
      projectionStatement?.role !== 'projection'
    ) {
      throw this.invariant('pos.cart_statement_plan_invalid');
    }

    const [gateRow] = await sql.query<GateRow>(gateStatement.text, gateStatement.params);
    if (gateRow === undefined) throw this.invariant('pos.cart_statement_plan_invalid');

    // WIDEST REFUSAL FIRST. The order is the law, not a style: answering
    // `pos.session_not_owned` for a session in another business would confirm
    // that a row exists there, which is the cross-tenant enumeration the
    // estate refuses. Every code is the till-session surface's own, registered
    // in the one canonical registry — a cart command invents no second
    // vocabulary for a session fact, and in particular it does not adopt the
    // `pos.till_session_*` spellings `0079` currently raises.
    if (Number(gateRow.session_visible) === 0) throw posRefusal('pos.session_not_found');
    if (Number(gateRow.session_open) === 0) throw posRefusal('pos.session_not_open');
    if (Number(gateRow.session_usable) === 0) throw posRefusal('pos.session_not_owned');

    const present = Number(gateRow.line_present) > 0;
    const alreadyRemoved = Number(gateRow.line_removed) > 0;

    if (command === 'cart.remove_line') {
      // THE THREE-WAY REMOVAL (coordinator ruling). The tombstone is what
      // makes E's idempotency and this module's 404 both survivable: without
      // it, "already removed" and "never existed" are the same observation
      // and one of the two behaviours would have had to be withdrawn.
      if (!present) throw posRefusal('pos.cart_line_not_found');
      // Present, live or already tombstoned: issue the routine either way. It
      // matches nothing when the line is already tombstoned, returns 0 and
      // raises nothing — a till that taps "remove" twice has not done
      // anything wrong — and the plan stays three statements in both cases,
      // so the count does not depend on the outcome.
      await sql.query(routine.text, routine.params);
    } else if (command === 'cart.add_line') {
      // The append: the gate's `next_line_no` is the ordinal, and the server
      // states it. `max(line_no) + 1` over the whole basket, tombstones
      // included, so a freed ordinal is never reused under a cashier.
      await sql.query(routine.text, setLineParams(command, target, gateRow));
    } else {
      // A revision of a line that must already exist and must still be live.
      // A tombstoned line is GONE as far as a quantity change or a discount
      // request is concerned: reviving it by revision would make the removal
      // undoable by a route that does not say so.
      if (!present || alreadyRemoved) throw posRefusal('pos.cart_line_not_found');
      await sql.query(routine.text, setLineParams(command, target, gateRow));
    }

    const rows = await sql.query<ProjectionRow>(projectionStatement.text, projectionStatement.params);
    return rows.map((r) => ({
      cartLineId: r.cart_line_id,
      productId: r.product_id,
      variantId: r.variant_id,
      quantity: r.quantity,
      discountMinor: r.discount_minor,
      unitPriceMinor: r.unit_price_minor,
      priceCurrency: r.price_currency,
      nameSnapshot: r.name_snapshot,
    }));
  }

  /**
   * The server's arithmetic, and the one place a cart figure is produced.
   *
   * Exposed (rather than inlined) so the integration suite drives exactly this
   * function over exactly these stored lines and asserts the rounding ledger —
   * the one-rounding law — without stubbing the arithmetic it is measuring.
   */
  recompute(tillSessionId: string, lines: readonly StoredCartLine[], fallbackCurrency = ''): CartDto {
    const cart = priceCart(lines, fallbackCurrency);
    const grains = roundingGrains(cart.rounding);
    // The law, asserted on the way out: one grain for a basket of any size.
    // Not a comment and not a test-only check — a second rounding layer added
    // later is refused here, in production, as a 500 with no details.
    if (grains.length > 1) throw this.invariant('pos.cart_rounding_grain_invalid');
    return this.toDto(tillSessionId, cart);
  }

  private toDto(tillSessionId: string, cart: PricedCart): CartDto {
    return {
      tillSessionId,
      currency: cart.currency,
      subtotalMinor: minorToString(cart.subtotalMinor),
      discountMinor: minorToString(cart.discountMinor),
      taxMinor: minorToString(cart.taxMinor),
      totalMinor: minorToString(cart.totalMinor),
      lines: cart.lines.map((l) => ({
        cartLineId: l.cartLineId,
        productId: l.productId,
        variantId: l.variantId,
        name: l.nameSnapshot,
        // Q4 back to its decimal spelling, exactly: no float, no `toFixed`.
        quantity: formatQ4(l.quantityQ4),
        unitPriceMinor: minorToString(l.unitPriceMinor),
        grossMinor: minorToString(l.grossMinor),
        discountMinor: minorToString(l.discountMinor),
        netMinor: minorToString(l.netMinor),
      })),
    };
  }

  private assertPlanIsConstant(plan: readonly CartStatement[], command: PosCartCommand): void {
    if (plan.length !== CART_STATEMENTS_PER_COMMAND) {
      this.logger.error({ command, statements: plan.length }, 'pos cart statement plan is not constant');
      throw this.invariant('pos.cart_statement_plan_invalid');
    }
  }

  /**
   * A violated internal cart invariant.
   *
   * The name goes to the LOG beside the request id, where the engineer who has
   * to fix it is reading. The RESPONSE is the registry's 500 rendering:
   * `INTERNAL_ERROR`, the safe generic sentence, and the typed code and
   * nothing else — no amount, no grain, no statement count, no SQL, no
   * routine name. 500 and never a 4xx, because «an internal invariant failure
   * is not an authorization denial» (TL-P4-S2-R5): a 403 would read as a
   * merchant outcome and nobody would look at the server.
   *
   * Each code is registered in the ONE canonical registry at 500, the
   * `pos.session_owner_immutable` / `sale.immutable` precedent — so the status
   * is a property of the registry and not of this method.
   */
  private invariant(code: Extract<PosCode, `pos.cart_${string}_invalid`>): Error {
    this.logger.error({ invariant: code }, 'pos cart invariant violated');
    return posRefusal(code);
  }
}

/** Q4 as its exact decimal string. Integer arithmetic only; `Number` never touches a quantity. */
function formatQ4(units: bigint): string {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const whole = a / 10_000n;
  const frac = (a % 10_000n).toString(10).padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString(10)}${frac === '' ? '' : `.${frac}`}`;
}
