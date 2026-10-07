/**
 * The ORDER state machine — Phase 6 (`PREPARED / NOT PROMOTED`).
 *
 * An order is a COMMERCIAL DOCUMENT that precedes the canonical sale. It is
 * not a sale, not an invoice, not a receivable and not a stock document, and
 * the whole point of this file is that it cannot become one by accident.
 *
 * ## The four laws
 *
 * 1. **The order never holds money and never holds stock.** No state here
 *    carries a total, and no transition posts a journal line or moves a
 *    quantity. The only moment stock leaves and the ledger moves is the
 *    canonical atomic sale commit (`POST /v1/sales`, Phase 4), which the
 *    `record_sale` transition REPORTS and does not perform.
 *
 * 2. **The sale binding is single and immutable.** `record_sale` is the only
 *    transition that may carry a `saleId`, every other transition is refused
 *    if it carries one, and a second DIFFERENT sale id for an order already
 *    bound to one is `order.sale_binding_conflict`. An order has at most one
 *    canonical sale, forever.
 *
 * 3. **Nothing is cancelled after the sale.** There is no edge from
 *    `fulfilled` or `completed` to `cancelled`, and an attempt gets its own
 *    code (`order.cancel_after_sale`) rather than the generic one, because the
 *    reason matters: undoing a committed sale means a return, a credit note or
 *    a reversal, and all three are the Phase 4 S5/S6 authorities' — never an
 *    order-status change. An order's financial afterlife is READ from those
 *    authorities and is not a state of this machine.
 *
 * 4. **No transition reads a clock.** `occurredAt` is stated by the caller, so
 *    the same retry sent either side of midnight is the same command forever.
 *    A history is non-decreasing in `occurredAt`; a transition that moves time
 *    backwards is refused rather than sorted into place.
 *
 * ## The log is the truth
 *
 * The authority is the append-only transition log, and a state is the fold of
 * it. That is why `applyOrderTransition` takes the HISTORY rather than a
 * snapshot: idempotency is a property of the whole log (has this
 * `transitionId` been seen, and was it this exact transition?), and a snapshot
 * that carried enough to answer that would be the log again under another
 * name. A materialized `status` column is a derived convenience, never the
 * fact — exactly as `invoices.status` stays lifecycle-only in Phase 4 and
 * settlement is derived.
 */
import { OrderError, assertCanonicalId } from './errors';
import { compareCanonical, isCanonicalInstant } from './instant';

/** Every state an order can be in. There is no `returned` state — see law 3. */
export type OrderState = 'placed' | 'accepted' | 'rejected' | 'cancelled' | 'fulfilling' | 'fulfilled' | 'completed';

/** Every transition an order can undergo. One kind per edge set, named for what a merchant does. */
export type OrderTransitionKind = 'place' | 'accept' | 'reject' | 'cancel' | 'start_fulfilment' | 'record_sale' | 'complete';

/**
 * The edge table, as DATA. A reader checks the machine by reading this
 * constant; a test checks it by enumerating it. `place` has no `from` because
 * it opens the history and is admissible only as its first entry.
 */
export const ORDER_EDGES: Readonly<Record<OrderTransitionKind, { readonly from: readonly OrderState[]; readonly to: OrderState }>> = Object.freeze({
  place: Object.freeze({ from: Object.freeze([]), to: 'placed' as OrderState }),
  accept: Object.freeze({ from: Object.freeze(['placed'] as OrderState[]), to: 'accepted' as OrderState }),
  reject: Object.freeze({ from: Object.freeze(['placed'] as OrderState[]), to: 'rejected' as OrderState }),
  cancel: Object.freeze({ from: Object.freeze(['placed', 'accepted', 'fulfilling'] as OrderState[]), to: 'cancelled' as OrderState }),
  start_fulfilment: Object.freeze({ from: Object.freeze(['accepted'] as OrderState[]), to: 'fulfilling' as OrderState }),
  record_sale: Object.freeze({ from: Object.freeze(['fulfilling'] as OrderState[]), to: 'fulfilled' as OrderState }),
  complete: Object.freeze({ from: Object.freeze(['fulfilled'] as OrderState[]), to: 'completed' as OrderState }),
});

/** The states no transition leaves. */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = Object.freeze(['rejected', 'cancelled', 'completed'] as OrderState[]);

/** The states in which a canonical sale already exists for the order. */
export const SALE_BOUND_ORDER_STATES: readonly OrderState[] = Object.freeze(['fulfilled', 'completed'] as OrderState[]);

/** The ONLY transition kind that may carry a `saleId`. */
export const SALE_BINDING_TRANSITION: OrderTransitionKind = 'record_sale';

export function isTerminalOrderState(state: OrderState): boolean {
  return TERMINAL_ORDER_STATES.includes(state);
}

/**
 * One recorded transition.
 *
 * `transitionId` is the CALLER's, and it is the replay key: a bare "has this
 * been seen" key proves a request arrived twice and says nothing about WHICH
 * request it was, so the stored transition's CONTENT is compared too and a
 * different content under the same id is a conflict rather than a replay.
 */
export interface OrderTransition {
  /** Canonical lowercase UUID, the caller's. */
  transitionId: string;
  kind: OrderTransitionKind;
  /** RFC3339 UTC at second precision, stated by the caller. Never a server clock. */
  occurredAt: string;
  /** The canonical sale — non-null for `record_sale` and null for every other kind. */
  saleId: string | null;
}

/** What the fold of a history yields. Derived, never stored as the fact. */
export interface OrderSnapshot {
  state: OrderState;
  /** The canonical sale once one exists, else null. */
  saleId: string | null;
  /** The `occurredAt` of the last transition. */
  lastOccurredAt: string;
  transitionCount: number;
  isTerminal: boolean;
}

function assertTransitionShape(t: OrderTransition): void {
  assertCanonicalId(t.transitionId, 'transitionId');
  if (!isCanonicalInstant(t.occurredAt)) {
    throw new OrderError('order.occurred_at_invalid', 'occurredAt must be a canonical RFC3339 UTC instant at second precision', {
      transitionId: t.transitionId,
    });
  }
  if (!(t.kind in ORDER_EDGES)) {
    throw new OrderError('order.transition_not_allowed', 'unknown transition kind', { transitionId: t.transitionId, kind: String(t.kind) });
  }
  if (t.kind === SALE_BINDING_TRANSITION) {
    if (t.saleId === null) {
      throw new OrderError('order.sale_binding_invalid', 'record_sale must name the canonical sale it reports', { transitionId: t.transitionId });
    }
    assertCanonicalId(t.saleId, 'saleId');
  } else if (t.saleId !== null) {
    throw new OrderError('order.sale_binding_invalid', 'only record_sale may carry a saleId', { transitionId: t.transitionId, kind: t.kind });
  }
}

/** Whether two transitions are the SAME command, field by field. */
export function isSameTransition(a: OrderTransition, b: OrderTransition): boolean {
  return a.transitionId === b.transitionId && a.kind === b.kind && a.occurredAt === b.occurredAt && a.saleId === b.saleId;
}

function step(current: OrderSnapshot, t: OrderTransition): OrderSnapshot {
  assertTransitionShape(t);

  if (compareCanonical(t.occurredAt, current.lastOccurredAt) < 0) {
    throw new OrderError('order.occurred_at_regressed', 'an order history is non-decreasing in occurredAt', { transitionId: t.transitionId });
  }

  const edge = ORDER_EDGES[t.kind];

  // Law 3 gets its own refusal before the generic edge check, because
  // "transition not allowed" would hide the only reason anyone cares about.
  if (t.kind === 'cancel' && SALE_BOUND_ORDER_STATES.includes(current.state)) {
    throw new OrderError('order.cancel_after_sale', 'an order whose canonical sale has committed is reversed through the sales authority, never cancelled', {
      transitionId: t.transitionId,
      state: current.state,
    });
  }

  if (current.isTerminal) {
    throw new OrderError('order.terminal_state', 'no transition leaves a terminal order state', { transitionId: t.transitionId, state: current.state });
  }

  if (t.kind === 'place' || !edge.from.includes(current.state)) {
    throw new OrderError('order.transition_not_allowed', 'the transition is not an edge from the current state', {
      transitionId: t.transitionId,
      kind: t.kind,
      state: current.state,
    });
  }

  if (t.saleId !== null && current.saleId !== null && current.saleId !== t.saleId) {
    throw new OrderError('order.sale_binding_conflict', 'the order is already bound to a different canonical sale', { transitionId: t.transitionId });
  }

  return {
    state: edge.to,
    saleId: t.saleId ?? current.saleId,
    lastOccurredAt: t.occurredAt,
    transitionCount: current.transitionCount + 1,
    isTerminal: isTerminalOrderState(edge.to),
  };
}

/**
 * Fold a whole history into the order's state.
 *
 * The history must begin with exactly one `place`, carry no repeated
 * `transitionId`, and be a legal walk of `ORDER_EDGES`. A history that is none
 * of those is not a state this machine can be in, so it is refused rather than
 * repaired: an order whose log cannot be replayed is a data defect, and
 * returning a plausible state for it would hide exactly the corruption a fold
 * is there to find.
 */
export function foldOrderHistory(history: readonly OrderTransition[]): OrderSnapshot {
  const first = history[0];
  if (first === undefined || first.kind !== 'place') {
    throw new OrderError('order.history_invalid', 'an order history begins with exactly one place transition');
  }
  assertTransitionShape(first);

  const seen = new Map<string, OrderTransition>();
  seen.set(first.transitionId, first);

  let snapshot: OrderSnapshot = {
    state: 'placed',
    saleId: null,
    lastOccurredAt: first.occurredAt,
    transitionCount: 1,
    isTerminal: false,
  };

  for (let i = 1; i < history.length; i += 1) {
    const t = history[i] as OrderTransition;
    const prior = seen.get(t.transitionId);
    if (prior !== undefined) {
      throw new OrderError('order.transition_duplicate', 'a transitionId appears twice in one history', { transitionId: t.transitionId });
    }
    if (t.kind === 'place') {
      throw new OrderError('order.history_invalid', 'a history carries exactly one place transition', { transitionId: t.transitionId });
    }
    snapshot = step(snapshot, t);
    seen.set(t.transitionId, t);
  }

  return snapshot;
}

/** What applying a transition to a history produced. */
export interface OrderTransitionResult {
  snapshot: OrderSnapshot;
  /** `true` when the identical transition had already been recorded and this call changed nothing. */
  replayed: boolean;
  /** The history after the call — the input itself on a replay. */
  history: readonly OrderTransition[];
}

/**
 * Apply one transition to an order's history.
 *
 * The replay proof is consulted BEFORE the current state is read: a stale
 * request replayed after a later transition, in a handler that read state
 * first, would be evaluated against a state it was never meant for and could
 * perform a second real change.
 */
export function applyOrderTransition(history: readonly OrderTransition[], next: OrderTransition): OrderTransitionResult {
  assertTransitionShape(next);

  for (const recorded of history) {
    if (recorded.transitionId !== next.transitionId) continue;
    if (isSameTransition(recorded, next)) {
      return { snapshot: foldOrderHistory(history), replayed: true, history };
    }
    throw new OrderError('order.transition_conflict', 'the transitionId was replayed with a different transition', { transitionId: next.transitionId });
  }

  const extended = [...history, next];
  return { snapshot: foldOrderHistory(extended), replayed: false, history: Object.freeze(extended) };
}

/** Open a history. A convenience over `foldOrderHistory` for the first transition. */
export function placeOrder(transition: OrderTransition): OrderTransitionResult {
  if (transition.kind !== 'place') {
    throw new OrderError('order.history_invalid', 'an order history begins with a place transition', { kind: transition.kind });
  }
  const history = Object.freeze([transition]);
  return { snapshot: foldOrderHistory(history), replayed: false, history };
}
