/**
 * Channel reconciliation — Phase 6 (`PREPARED / NOT PROMOTED`).
 *
 * Omnichannel means one business sells through several front ends, and the
 * question this module answers is the only one that matters about that: **did
 * every order that claims to have been sold reach the canonical sales ledger
 * exactly once, and does every channel sale have the order it claims?**
 *
 * It is a PURE FOLD over two lists a caller reads from the two authorities —
 * the Phase 6 order log and the Phase 4 `sales` relation. It reads nothing
 * itself, computes no money, and corrects nothing: a reconciliation that
 * repaired what it found would destroy the evidence that something was wrong.
 * It returns findings; a human or a later slice decides.
 *
 * ## What is checked
 *
 * Six conditions, and the list is exhaustive over the two inputs:
 *
 * - `order_without_sale` — an order whose state says a sale committed, naming a
 *   sale id the ledger has no row for. The order believes it sold something the
 *   ledger never saw;
 * - `order_binding_missing` — an order in a sale-bound state carrying NO sale
 *   id. The state machine cannot produce this, so finding it means the stored
 *   log was written by something other than the state machine;
 * - `binding_without_state` — the mirror image: a sale id on an order that is
 *   not in a sale-bound state;
 * - `sale_without_order` — a sale row naming an order id no order exists for;
 * - `order_sale_mismatch` — a sale row naming an order that is bound to a
 *   DIFFERENT sale;
 * - `sale_shared_by_orders` — two orders bound to one sale. One sale, one
 *   order, always.
 *
 * ## What is NOT checked, stated rather than implied
 *
 * - **Amounts.** No finding here compares a total, because an order holds no
 *   total to compare. Whether the sale's own figures are right is the sales
 *   authority's reconciliation (R-SAL-01…07), not this one;
 * - **Quantities.** Line-level agreement between an order's positions and the
 *   sale's lines is a separate check with its own inputs; it is not folded in
 *   here, and this module does not claim it;
 * - **A sale with a null `orderId`** is a direct or POS sale and is correctly
 *   outside Phase 6. It is COUNTED and never reported.
 */
import { OrderError } from './errors';
import { SALE_BOUND_ORDER_STATES, type OrderState } from './state';

/** The channels an order can originate from. An unrecognised key is refused, never bucketed as "other". */
export const ORDER_CHANNELS: readonly string[] = Object.freeze(['storefront', 'pos', 'admin', 'marketplace']);

export type OrderChannel = 'storefront' | 'pos' | 'admin' | 'marketplace';

/** One order, as the order log reports it. */
export interface ChannelOrderRow {
  orderId: string;
  channel: string;
  state: OrderState;
  /** The canonical sale the order is bound to, or null. */
  saleId: string | null;
}

/** One sale, as the canonical sales ledger reports it. */
export interface CanonicalSaleRow {
  saleId: string;
  /** The order this sale came from, or `null` for a direct/POS sale. */
  orderId: string | null;
}

export type ReconciliationFindingCode =
  | 'order_without_sale'
  | 'order_binding_missing'
  | 'binding_without_state'
  | 'sale_without_order'
  | 'order_sale_mismatch'
  | 'sale_shared_by_orders';

/** One discrepancy. It names the exact subjects, so nobody has to re-derive which row was wrong. */
export interface ReconciliationFinding {
  code: ReconciliationFindingCode;
  orderId: string | null;
  saleId: string | null;
  /** The other order, for `sale_shared_by_orders`; the other sale, for `order_sale_mismatch`. */
  counterpartId: string | null;
}

export interface ChannelReconciliationReport {
  checkedOrders: number;
  checkedSales: number;
  /** Sales with a null `orderId` — direct and POS sales, correctly out of scope. */
  salesWithoutChannelOrigin: number;
  findings: readonly ReconciliationFinding[];
  /** `true` only when the findings list is empty. */
  isReconciled: boolean;
}

export function reconcileChannelOrders(orders: readonly ChannelOrderRow[], sales: readonly CanonicalSaleRow[]): ChannelReconciliationReport {
  const orderById = new Map<string, ChannelOrderRow>();
  for (const order of orders) {
    if (orderById.has(order.orderId)) {
      throw new OrderError('order.reconciliation_order_duplicate', 'two input rows claim one order id', { orderId: order.orderId });
    }
    if (!ORDER_CHANNELS.includes(order.channel)) {
      throw new OrderError('order.channel_unknown', 'an order names a channel this package does not recognise', {
        orderId: order.orderId,
        channel: order.channel,
      });
    }
    orderById.set(order.orderId, order);
  }

  const saleById = new Map<string, CanonicalSaleRow>();
  for (const sale of sales) {
    if (saleById.has(sale.saleId)) {
      throw new OrderError('order.reconciliation_sale_duplicate', 'two input rows claim one sale id', { saleId: sale.saleId });
    }
    saleById.set(sale.saleId, sale);
  }

  const findings: ReconciliationFinding[] = [];
  const orderBySaleId = new Map<string, string>();

  for (const order of orders) {
    const bound = SALE_BOUND_ORDER_STATES.includes(order.state);

    if (bound && order.saleId === null) {
      findings.push({ code: 'order_binding_missing', orderId: order.orderId, saleId: null, counterpartId: null });
      continue;
    }
    if (!bound && order.saleId !== null) {
      findings.push({ code: 'binding_without_state', orderId: order.orderId, saleId: order.saleId, counterpartId: null });
      continue;
    }
    if (order.saleId === null) continue;

    const firstClaimant = orderBySaleId.get(order.saleId);
    if (firstClaimant !== undefined) {
      findings.push({ code: 'sale_shared_by_orders', orderId: order.orderId, saleId: order.saleId, counterpartId: firstClaimant });
      continue;
    }
    orderBySaleId.set(order.saleId, order.orderId);

    if (!saleById.has(order.saleId)) {
      findings.push({ code: 'order_without_sale', orderId: order.orderId, saleId: order.saleId, counterpartId: null });
    }
  }

  let salesWithoutChannelOrigin = 0;
  for (const sale of sales) {
    if (sale.orderId === null) {
      salesWithoutChannelOrigin += 1;
      continue;
    }
    const order = orderById.get(sale.orderId);
    if (order === undefined) {
      findings.push({ code: 'sale_without_order', orderId: sale.orderId, saleId: sale.saleId, counterpartId: null });
      continue;
    }
    if (order.saleId !== sale.saleId) {
      findings.push({ code: 'order_sale_mismatch', orderId: sale.orderId, saleId: sale.saleId, counterpartId: order.saleId });
    }
  }

  return {
    checkedOrders: orders.length,
    checkedSales: sales.length,
    salesWithoutChannelOrigin,
    findings: Object.freeze(findings),
    isReconciled: findings.length === 0,
  };
}
