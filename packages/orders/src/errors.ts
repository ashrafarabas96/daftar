/**
 * Typed order errors raised by this package — stable machine codes, never a
 * message a client is meant to parse and never a database string.
 *
 * `@daftar/orders` is Phase 6 PREPARATION (master directive PART 9: `PREPARED
 * / NOT PROMOTED`). It holds the ORDER document's own rules and NOTHING else:
 *
 * - it never computes money. A price, a line total, a subtotal, a discount
 *   amount, a tax figure and a grand total are the sales authority's
 *   (`POST /v1/sales`, P4-AL-18), and this package carries no minor-unit
 *   arithmetic at all, so there is no second place for a total to be wrong;
 * - it never moves stock and never reserves it. On-hand is Phase 3's
 *   `stock_levels` and the only authority on whether stock suffices is the
 *   atomic sale commit, which refuses `inventory.insufficient_stock` inside
 *   its own transaction. What this package computes about availability is
 *   ADVISORY and says so in its own type (`availability.ts`);
 * - it never reads a clock. Every transition states the instant it happened,
 *   so the same retry is the same command forever.
 *
 * Codes are grouped by the subject that refuses, so a reader can tell an order
 * lifecycle refusal from a checkout-intent refusal without consulting a table.
 */
export type OrderErrorCode =
  // ── the order lifecycle (state.ts) ───────────────────────────────────────
  /** The transition is not an edge of the state machine from the current state. */
  | 'order.transition_not_allowed'
  /** The order is in a terminal state: no transition leaves it. */
  | 'order.terminal_state'
  /** A transition to `fulfilled` carried no `saleId`, or another transition carried one. */
  | 'order.sale_binding_invalid'
  /**
   * A second, DIFFERENT canonical sale was named for an order that is already
   * bound to one. The binding is immutable: an order has at most one sale,
   * forever.
   */
  | 'order.sale_binding_conflict'
  /** A cancellation was attempted after the canonical sale had committed. */
  | 'order.cancel_after_sale'
  /** The same `transitionId` was replayed with a different transition. */
  | 'order.transition_conflict'
  /** Two transitions carry the same `transitionId` and the same content twice in one history. */
  | 'order.transition_duplicate'
  /** `occurredAt` is not a canonical RFC3339 UTC instant at second precision. */
  | 'order.occurred_at_invalid'
  /** `occurredAt` moved backwards: an order's history is non-decreasing in time. */
  | 'order.occurred_at_regressed'
  /** An id is not a canonical lowercase UUID. */
  | 'order.id_invalid'
  /** The history is empty, or does not begin at `placed`. */
  | 'order.history_invalid'

  // ── the basket (cart.ts) ────────────────────────────────────────────────
  /** A cart line names no product, or names a variant that is not a canonical UUID. */
  | 'order.cart_line_invalid'
  /** The basket is empty where at least one line is required. */
  | 'order.cart_empty'
  /** Two cart lines share a `lineId`. */
  | 'order.cart_line_duplicate'
  /** A line quantity is not positive, or is not representable at the unit's precision. */
  | 'order.cart_quantity_invalid'

  // ── the advisory availability read (availability.ts) ─────────────────────
  /** An on-hand figure was supplied for a stock key the basket does not name. */
  | 'order.availability_subject_unknown'
  /** No on-hand figure was supplied for a stock key the basket names. */
  | 'order.availability_subject_missing'
  /** A tracked stock key reported no on-hand figure, or an untracked one reported a figure. */
  | 'order.availability_tracking_inconsistent'

  // ── the checkout hand-off (checkout-intent.ts) ───────────────────────────
  /** The order is not in a state a checkout may be built from. */
  | 'order.checkout_state_invalid'
  /** The intent carries a field the sales authority forbids a client to state. */
  | 'order.checkout_field_forbidden'
  /** A credit checkout named no customer, or a due date was stated without one. */
  | 'order.checkout_customer_required'
  /** A non-zero tax was stated while sales tax is a structural zero (PART 14). */
  | 'order.checkout_tax_policy_absent'
  /** `documentDate` or `dueDate` is not a `YYYY-MM-DD` civil date, or the due date precedes it. */
  | 'order.checkout_date_invalid'

  // ── channel reconciliation (reconciliation.ts) ───────────────────────────
  /** Two input rows claim the same order id. */
  | 'order.reconciliation_order_duplicate'
  /** Two input rows claim the same sale id. */
  | 'order.reconciliation_sale_duplicate'
  /** A channel key is not one this package recognises. */
  | 'order.channel_unknown';

/** Typed, string-valued facts a refusal may carry beside its code. Never part of the message. */
export type OrderErrorDetails = Readonly<Record<string, string | readonly string[]>>;

export class OrderError extends Error {
  readonly code: OrderErrorCode;
  readonly details: OrderErrorDetails | undefined;

  constructor(code: OrderErrorCode, message: string, details?: OrderErrorDetails) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }

  /** The only representation that should ever be logged or returned to a client. */
  toSafeJSON(): { code: OrderErrorCode } {
    return { code: this.code };
  }
}

/** Canonical lowercase UUID — the identity shape every id in this package keeps. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Throws `order.id_invalid` for anything that is not a canonical lowercase UUID. */
export function assertCanonicalId(value: string, field: string): void {
  if (!CANONICAL_UUID.test(value)) {
    throw new OrderError('order.id_invalid', 'identifier is not a canonical lowercase UUID', { field });
  }
}

/** Whether a string is a canonical lowercase UUID. */
export function isCanonicalId(value: string): boolean {
  return CANONICAL_UUID.test(value);
}
