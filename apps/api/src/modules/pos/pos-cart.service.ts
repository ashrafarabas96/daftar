import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { hasPermission } from '@daftar/domain-core';
import { buildInventoryPayload, parseQuantity, type InventoryPayload } from '@daftar/inventory';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { Logger } from '../../infra/logger';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { BusinessTransactionId } from '../inventory/business-transaction';
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
  /** The SESSION's warehouse, for the authority check. Read per command, never cached. */
  warehouse_id: string | null;
  /** The existing line's own ordinal and identities, for a REVISION's routine call. */
  line_no: number | null;
  product_id: string | null;
  variant_id: string | null;
  /**
   * The line's CURRENT quantity and discount request. `pos_cart_set_line`
   * writes BOTH columns on every call, so revising one means RESTATING the
   * other from the server's own copy — otherwise a discount request would set
   * the quantity to NULL and a quantity change would clear a granted discount.
   */
  quantity: string | null;
  requested_discount_minor: string | null;
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
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /** Add a line, or merge into the existing line for this variant. Requires `sales.create`. */
  async addLine(
    m: MembershipContext,
    tillSessionId: string,
    input: { productId: string; variantId: string | null; quantity: string },
    btx: BusinessTransactionId,
  ): Promise<CartDto> {
    return this.run(
      m,
      'cart.add_line',
      {
        ...this.base(m, tillSessionId),
        // The server mints the line id. A client-supplied one would let a till
        // name a row in another basket, and the cart has no idempotency contract
        // the id could be the key of.
        cartLineId: randomUUID(),
        productId: input.productId,
        variantId: input.variantId,
        quantity: input.quantity,
        discountMinor: null,
      },
      btx,
    );
  }

  /** Change one line's quantity. Requires `sales.create`. */
  async changeQuantity(m: MembershipContext, tillSessionId: string, cartLineId: string, quantity: string, btx: BusinessTransactionId): Promise<CartDto> {
    return this.run(
      m,
      'cart.change_quantity',
      { ...this.base(m, tillSessionId), cartLineId, productId: null, variantId: null, quantity, discountMinor: null },
      btx,
    );
  }

  /** Remove one line. Requires `sales.create`. */
  async removeLine(m: MembershipContext, tillSessionId: string, cartLineId: string, btx: BusinessTransactionId): Promise<CartDto> {
    return this.run(
      m,
      'cart.remove_line',
      {
        ...this.base(m, tillSessionId),
        cartLineId,
        productId: null,
        variantId: null,
        quantity: null,
        discountMinor: null,
      },
      btx,
    );
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
  async requestDiscount(m: MembershipContext, tillSessionId: string, cartLineId: string, discountMinor: string, btx: BusinessTransactionId): Promise<CartDto> {
    if (!hasPermission(m.roles, 'sales.discount')) throw posRefusal('pos.cart_discount_not_permitted');
    return this.run(
      m,
      'cart.request_discount',
      {
        ...this.base(m, tillSessionId),
        cartLineId,
        productId: null,
        variantId: null,
        quantity: null,
        discountMinor,
      },
      btx,
    );
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
   * The op kind each command is authorized and minted under. `0079` registers
   * four, and the cart's three write commands all go through ONE of them:
   * `pos_cart_set_line` is keyed by the line id and revises what is there, so
   * the add, the quantity change and the discount request are the same kind of
   * authority over the same relation.
   */
  private static readonly OP_CODE: Readonly<Record<PosCartCommand, 'pos.cart_set_line' | 'pos.cart_remove_line'>> = Object.freeze({
    'cart.add_line': 'pos.cart_set_line',
    'cart.change_quantity': 'pos.cart_set_line',
    'cart.request_discount': 'pos.cart_set_line',
    'cart.remove_line': 'pos.cart_remove_line',
  });

  /**
   * One command, in the order the protocol forces:
   *
   *   1. the GATE — one read, outside the write transaction, for the session
   *      verdict, the session's warehouse, the next ordinal and what the
   *      addressed line currently is;
   *   2. `authorize` — `sales.create` and the SESSION's warehouse against the
   *      actor's branch scope, refused before anything is minted;
   *   3. `mint` — the `invctl/1` assertion over the exact payload the routine
   *      will rebuild and re-digest;
   *   4. the seam — `app.inventory_assertion` at `BEGIN`, then the routine and
   *      the projection.
   *
   * The gate cannot move inside the seam and the mint cannot move before the
   * gate: the assertion SIGNS `line_no`, `product_id`, `variant_id` and
   * `qty_q4`, which are server facts about an existing basket. The order is
   * the protocol's, not a preference.
   *
   * THREE statements per command — gate, routine, projection — and the
   * assertion costs none of them, because it rides the seam's own scope
   * statement at `BEGIN`.
   */
  private async run(m: MembershipContext, command: PosCartCommand, target: CartCommandTarget, btx: BusinessTransactionId): Promise<CartDto> {
    const plan = cartStatementPlan(command, target);
    this.assertPlanIsConstant(plan, command);
    const [gateStatement] = plan;
    if (gateStatement?.role !== 'gate') throw this.invariant('pos.cart_statement_plan_invalid');

    // 1. THE GATE, in its own read transaction: the mint must follow it and
    //    precede the seam, so it cannot share the write transaction.
    const gateSql: CartSql = {
      query: async <T extends QueryResultRow>(text: string, params: readonly unknown[]): Promise<readonly T[]> =>
        this.db.withTransaction(
          { tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId },
          async (client) => (await client.query<T>(text, [...params])).rows,
        ),
    };
    const lines = await this.issuePlan(
      m,
      command,
      target,
      plan,
      gateSql,
      (assertion, run) =>
        this.db.withBusinessInventoryTransaction(
          { tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId, businessTransactionId: btx },
          assertion,
          async (tx) =>
            run({
              query: async <T extends QueryResultRow>(text: string, params: readonly unknown[]): Promise<readonly T[]> =>
                (await tx.query<T>(text, [...params])).rows,
            }),
        ),
      btx,
    );
    return this.recompute(target.tillSessionId, lines);
  }

  /**
   * The whole of a cart command's behaviour, over two `CartSql` ports: the
   * gate's and the seam's.
   *
   * It is one function and not two halves because EVERY decision a cart
   * command makes lives here — the session refusals, the removal's three-way
   * outcome, the authority, the mint and the three statements in order — and
   * splitting it would let a test measure a path production does not take.
   * The integration suite passes ONE recording port for both, which is how
   * the statement count is measured against exactly this code.
   */
  async issuePlan(
    m: MembershipContext,
    command: PosCartCommand,
    target: CartCommandTarget,
    plan: readonly CartStatement[],
    gateSql: CartSql,
    seam: (assertion: string, run: (sql: CartSql) => Promise<readonly ProjectionRow[]>) => Promise<readonly ProjectionRow[]>,
    btx: BusinessTransactionId,
  ): Promise<readonly StoredCartLine[]> {
    const [gateStatement, routine, projectionStatement] = plan;
    if (
      plan.length !== CART_STATEMENTS_PER_COMMAND ||
      gateStatement?.role !== 'gate' ||
      routine?.role !== 'routine' ||
      projectionStatement?.role !== 'projection'
    ) {
      throw this.invariant('pos.cart_statement_plan_invalid');
    }

    // 1. THE GATE.
    const [gateRow] = await gateSql.query<GateRow>(gateStatement.text, gateStatement.params);
    if (gateRow === undefined) throw this.invariant('pos.cart_statement_plan_invalid');

    // The session refusals, widest first, before any authority is established:
    // a cashier asking about another business's till learns only that it does
    // not exist.
    if (Number(gateRow.session_visible) === 0) throw posRefusal('pos.session_not_found');
    if (Number(gateRow.session_open) === 0) throw posRefusal('pos.session_not_open');
    if (Number(gateRow.session_usable) === 0) throw posRefusal('pos.session_not_owned');

    const present = Number(gateRow.line_present) > 0;
    const alreadyRemoved = Number(gateRow.line_removed) > 0;
    if (command === 'cart.remove_line') {
      // A line that was never in this session is a different event from one
      // already removed, and the tombstone is what tells them apart.
      if (!present) throw posRefusal('pos.cart_line_not_found');
    } else if (command !== 'cart.add_line') {
      // A revision of a line that must exist AND still be live: reviving a
      // tombstoned line by revising it would make the removal undoable
      // through a route that does not say so.
      if (!present || alreadyRemoved) throw posRefusal('pos.cart_line_not_found');
    }

    // 2. AUTHORIZE, against the SESSION's warehouse.
    if (gateRow.warehouse_id === null) throw this.invariant('pos.cart_statement_plan_invalid');
    const authority = await this.authorization.authorize(m, PosCartService.OP_CODE[command], btx, [gateRow.warehouse_id]);

    // 3. MINT over the exact payload the routine will rebuild.
    const assertion = this.authorization.mint(authority, this.payload(m, command, target, gateRow));

    // 4. THE SEAM. The assertion is presented at `BEGIN`; the routine consumes
    //    it and re-digests the payload from its own arguments, so a mismatch
    //    between what was signed and what is called is refused by the database
    //    rather than by this service.
    const projected = await seam(assertion, async (sql) => {
      await sql.query(routine.text, routine.bindsFromGate === true ? setLineParams(command, target, gateRow) : routine.params);
      return sql.query<ProjectionRow>(projectionStatement.text, projectionStatement.params);
    });

    // The stored lines, and NOT a priced cart: `recompute` is the one place a
    // cart figure is produced, and keeping it outside this function is what
    // lets the integration suite drive the arithmetic over exactly these rows.
    return projected.map((r) => ({
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
   * The payload the assertion signs, field for field as `0079`'s
   * `inventory_claimed_payload_digest` rebuilds it.
   *
   * Every field is a SERVER fact. `line_no`, `product_id` and `variant_id`
   * come from the gate on a revision and from the gate's next ordinal plus the
   * command's identities on an append; `qty_q4` is the quantity × 10^4 as an
   * exact integer, because the routine signs
   * `inventory_fixed_text(p_quantity, 4)`. There is no price field of any
   * kind — a forged total is not refused here, it is INEXPRESSIBLE.
   */
  private payload(m: MembershipContext, command: PosCartCommand, target: CartCommandTarget, gateRow: GateRow): InventoryPayload {
    const opCode = PosCartService.OP_CODE[command];
    if (opCode === 'pos.cart_remove_line') {
      return buildInventoryPayload(opCode, m.tenantId, m.businessId, [
        { kind: 'uuid', value: target.tillSessionId },
        { kind: 'uuid', value: target.cartLineId ?? '' },
      ]);
    }
    const [, , lineNo, productId, variantId, quantity, discountMinor] = setLineParams(command, target, gateRow);
    return buildInventoryPayload(opCode, m.tenantId, m.businessId, [
      { kind: 'uuid', value: target.tillSessionId },
      { kind: 'uuid', value: target.cartLineId ?? '' },
      { kind: 'integer', value: Number(lineNo) },
      { kind: 'uuid', value: String(productId ?? '') },
      { kind: 'uuid', value: String(variantId ?? '') },
      // Q4: the quantity x 10^4 as an exact integer, because the routine
      // signs `inventory_fixed_text(p_quantity, 4)`.
      { kind: 'integer', value: parseQuantity(String(quantity ?? '0')) },
      { kind: 'integer', value: BigInt(String(discountMinor ?? '0')) },
    ]);
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
