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
import { requireAnyPermission } from '../inventory/read-scope';
import { minorToString, priceCart, roundingGrains, type PricedCart, type StoredCartLine } from './pos-cart-pricing';
import {
  cartReadPlan,
  cartStatementPlan,
  setLineParams,
  CART_STATEMENTS_PER_COMMAND,
  CART_STATEMENTS_PER_READ,
  type CartCommandTarget,
  type CartStatement,
} from './pos-cart-statements';
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
  /**
   * The `OD-P4-09` step ALONE, independent of the lifecycle: 0 means it is a
   * colleague's till. The cart READ needs it separately from `session_usable`,
   * because it answers a CLOSED session's basket and would otherwise have had
   * to read a closed-but-own shift as "not owned".
   */
  session_owned: string;
  /** The `OD-P4-09` step a WRITE needs: `opened ∩ owned`. 0 means closed, or a colleague's till. */
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
   * `GET /v1/pos/till-sessions/:sessionId/cart-lines` — READ the basket.
   * Requires `sales.view`.
   *
   * ## Why the read is owed at all
   *
   * The four commands above each answer with the recomputed cart, and for a
   * while that was taken to mean a till «never asks twice»
   * (`pos-cart-routes.ts`). It was wrong about one case, which is the only
   * case that matters: a till screen that RELOADS. The basket is server-side
   * state in `pos_cart_lines`, and neither
   * `GET /v1/pos/till-sessions/current` nor
   * `GET /v1/pos/till-sessions/:sessionId` carries a line — both answer a
   * `TillSession`. So before this read, a reload lost the basket while its
   * rows sat in the table with no route that could see them. The row is in
   * `POS_READ_ROUTE_AUTHORITY` (`pos-reads.ts`) and NOT in
   * `POS_CART_ROUTE_AUTHORITY`: that table is the four COMMANDS, one per
   * `PosCartCommand`, and a read is not a fifth command.
   *
   * ## `sales.view` and not `sales.create`
   *
   * The four commands name `sales.create` because they WRITE. Reading a till
   * session names `sales.view` (`pos-permissions.ts`), and so does the POS
   * type-ahead (`pos-reads.ts`); the basket is the same till's own state, so
   * it takes the same key. The decorator is the route's authority and this
   * check is what holds if the read is ever reached from another transport —
   * the `PosReadService.searchProducts` precedent, not duplication.
   *
   * ## A CLOSED shift's basket IS readable, and that is a decision
   *
   * The four commands refuse `pos.session_not_open` (409) behind a closed
   * till, and this read deliberately does NOT. The reasoning is the schema's
   * own, not a preference:
   *
   *   - `0079` does not delete the basket at close. Its own comment on
   *     `pos_till_session_close` says «The basket is NOT deleted: a closed
   *     session and its lines are the frozen record of the shift, and
   *     `pos_cart_line_guard()` refuses every later write to them»
   *     (`0079:945`, and `0079:601-603` calls it «frozen evidence»). So the
   *     rows exist, by design, after the drawer is counted;
   *   - what `pos_cart_line_guard()` refuses is a WRITE. There is no reading
   *     of that guard under which a `SELECT` changes a counted drawer, so the
   *     409 the commands answer is about mutating evidence and has no
   *     counterpart here;
   *   - `GET /v1/pos/till-sessions/:sessionId` already answers for a closed
   *     session (`till-session.service.ts`: it checks visibility and the
   *     owner, and never `status`). A line-level read of the same session
   *     that refused where the session-level read answers would be two
   *     answers to one question;
   *   - and refusing would make the frozen evidence unreachable. The record
   *     of what was in the drawer would exist in `pos_cart_lines` with no
   *     route able to read it — which is exactly the defect this read was
   *     added to fix, moved from "no route" to "a route that refuses".
   *
   * `GET /v1/pos/products` keeps its `pos.session_not_open` and should: a
   * type-ahead on a closed till is a cashier still ringing up a counted
   * drawer. Answering what WAS in the basket is a different act from offering
   * to add to it.
   *
   * ## The refusals, and that they are the slice's own
   *
   * Two, both from the EXISTING gate (`cartReadPlan` reuses the commands' own
   * `gate`), widest first and neither of them an empty cart:
   *
   *   - `pos.session_not_found` (404) — not VISIBLE to this transaction. A
   *     session of another business or another tenant is invisible under RLS
   *     and arrives here as no row, so it is the same answer as a session that
   *     was never opened, and a malformed id is the same answer again
   *     (`cartUuidParam`). The path is therefore no oracle for which ids
   *     exist;
   *   - `pos.session_not_owned` (403) — visible, in this business, and a
   *     COLLEAGUE's. `OD-P4-09`: one session, one authenticated user. Handing
   *     over another cashier's basket would be the shared till the ruling
   *     refused, read-only.
   *
   * An empty cart is NOT a refusal and must never be used as one: a
   * cross-business session answered with `{ lines: [] }` would be a leak
   * dressed as a zero, and a cashier reading it would believe the basket was
   * emptied.
   *
   * ## Two statements, one connection, no second query
   *
   * `cartReadPlan` is the commands' own `gate` and `projection` — see its
   * note for why it is built there and not here. Both run in ONE
   * `db.withTransaction` as `daftar_app`, which is the only connection this
   * read takes and the only role it needs: `daftar_app` already holds
   * `SELECT` on both relations (`0079:605`), so the read needs no routine, no
   * assertion, no `invctl/1` mint and no `BusinessTransactionId` — all four
   * are the write protocol's, and a read that minted one would be claiming an
   * authority it does not use. The arithmetic is `recompute`, the one place a
   * cart figure is produced, so the read adds no rounding layer and answers
   * the identical `CartDto` the commands do.
   */
  async readCart(m: MembershipContext, tillSessionId: string): Promise<CartDto> {
    requireAnyPermission(m, ['sales.view']);
    const plan = cartReadPlan(this.base(m, tillSessionId));
    const [gateStatement, projectionStatement] = plan;
    if (plan.length !== CART_STATEMENTS_PER_READ || gateStatement?.role !== 'gate' || projectionStatement?.role !== 'projection') {
      throw this.invariant('pos.cart_statement_plan_invalid');
    }
    const projected = await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId }, async (client) => {
      const gateRow = (await client.query<GateRow>(gateStatement.text, [...gateStatement.params])).rows[0];
      if (gateRow === undefined) throw this.invariant('pos.cart_statement_plan_invalid');
      // Widest first, for the same reason the commands order them so: a 403
      // about a session the 404 says is invisible would confirm it exists.
      if (Number(gateRow.session_visible) === 0) throw posRefusal('pos.session_not_found');
      if (Number(gateRow.session_owned) === 0) throw posRefusal('pos.session_not_owned');
      // `session_open` is READ by the gate and deliberately not consulted
      // here. See this method's note: a closed shift's basket is frozen
      // evidence and a SELECT cannot thaw it.
      return (await client.query<ProjectionRow>(projectionStatement.text, [...projectionStatement.params])).rows;
    });
    return this.recompute(tillSessionId, projected.map(storedLine));
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
    return projected.map(storedLine);
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

/**
 * One projected row as a `StoredCartLine`.
 *
 * ONE function, called by the commands' `issuePlan` and by `readCart`, so the
 * read and the four writes cannot come to read the projection's columns two
 * ways. It carries no figure of its own: every money value is still the
 * column's own text and `recompute` is what prices it.
 */
function storedLine(r: ProjectionRow): StoredCartLine {
  return {
    cartLineId: r.cart_line_id,
    productId: r.product_id,
    variantId: r.variant_id,
    quantity: r.quantity,
    discountMinor: r.discount_minor,
    unitPriceMinor: r.unit_price_minor,
    priceCurrency: r.price_currency,
    nameSnapshot: r.name_snapshot,
  };
}

/** Q4 as its exact decimal string. Integer arithmetic only; `Number` never touches a quantity. */
function formatQ4(units: bigint): string {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const whole = a / 10_000n;
  const frac = (a % 10_000n).toString(10).padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString(10)}${frac === '' ? '' : `.${frac}`}`;
}
