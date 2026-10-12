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
 * Six conditions, and the list is exhaustive over the two inputs AS TYPED. Two
 * of them cannot fire on the data that exists today, and saying so is the point
 * of this paragraph: `sale_without_order` and `order_sale_mismatch` are both
 * reached through `CanonicalSaleRow.orderId`, and **Phase 4's `sales` relation
 * at `93084f8` carries no order back-reference** (`0077…:219-253`). So that
 * field has no source: every real sale row arrives with `orderId: null`, is
 * counted as a sale with no channel origin, and the two findings stay silent.
 * The coordinator's diff review at `b3719c0` measured exactly that (R-10): an
 * order in `fulfilled` naming a sale whose row has `orderId: null` reconciles
 * clean. The gap is a CROSS-PHASE SEAM, not a defect in this fold: either Phase
 * 4 gains the back-reference, or the sale side of the check has to be derived
 * from `orders.sale_id` alone, and that is a contract decision rather than this
 * module's to take. Until it is taken, this reconciler's real coverage is the
 * four order-side conditions.
 *
 * The six:
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
import { OrderError, assertCanonicalId } from './errors';
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
  /**
   * The finding codes that had NOTHING to judge in this input, so their absence
   * from `findings` says nothing about the world.
   *
   * The coordinator's review of `7834bfb` raised this as `R-19`: the report
   * returned `isReconciled: true` while two of its six checks were structurally
   * blind, and the only hint was a count the reader had to interpret. Two of
   * the six are reachable ONLY through `CanonicalSaleRow.orderId`, and Phase 4's
   * `sales` relation at `93084f8` has no order back-reference
   * (`0077_sales_core.sql:219-253`), so a faithful caller supplies `null` for
   * every sale and those two checks never fire. That is a cross-phase seam, not
   * a defect of this function, and the honest thing is to SAY SO in the report
   * rather than to let an empty findings list read as coverage.
   *
   * It is DERIVED from the input, never hard-coded: if a single supplied sale
   * names an order, both checks were live and this list is empty. So when Phase
   * 4 gains the back-reference, the list empties itself with no edit here.
   */
  blindChecks: readonly ReconciliationFindingCode[];
  /**
   * `true` only when the findings list is empty.
   *
   * It is NOT a statement that everything was checked: read it together with
   * `blindChecks`, which names what could not be. Keeping the two separate is
   * deliberate — `isReconciled` answers "did any check I could run fail?", and
   * conflating that with coverage would make a clean POS-only day read as a
   * discrepancy.
   */
  isReconciled: boolean;
}

export function reconcileChannelOrders(orders: readonly ChannelOrderRow[], sales: readonly CanonicalSaleRow[]): ChannelReconciliationReport {
  const orderById = new Map<string, ChannelOrderRow>();
  for (const order of orders) {
    // Ids are validated here as they are in every other module of this package.
    // They were not, and that mattered more than it looks: the findings name
    // their subjects by id, and a report that names `''` or `'ORDER-7'` as the
    // orphaned order cannot be acted on by whoever reads it.
    assertCanonicalId(order.orderId, 'orderId');
    if (order.saleId !== null) assertCanonicalId(order.saleId, 'saleId');
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
    assertCanonicalId(sale.saleId, 'saleId');
    if (sale.orderId !== null) assertCanonicalId(sale.orderId, 'orderId');
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

    // A shared sale is reported, and then the row is checked for the ORPHAN
    // condition as well. It used to `continue` here, which lost one finding per
    // shared sale: where two orders claimed one sale that the ledger has no row
    // for, only the first was reported as orphaned, and a human reading the
    // findings list saw one missing sale where there were two.
    const firstClaimant = orderBySaleId.get(order.saleId);
    if (firstClaimant !== undefined) {
      findings.push({ code: 'sale_shared_by_orders', orderId: order.orderId, saleId: order.saleId, counterpartId: firstClaimant });
    } else {
      orderBySaleId.set(order.saleId, order.orderId);
    }

    if (!saleById.has(order.saleId)) {
      findings.push({ code: 'order_without_sale', orderId: order.orderId, saleId: order.saleId, counterpartId: null });
    }
  }

  let salesWithoutChannelOrigin = 0;
  let salesNamingAnOrder = 0;
  for (const sale of sales) {
    if (sale.orderId === null) {
      salesWithoutChannelOrigin += 1;
      continue;
    }
    salesNamingAnOrder += 1;
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
    // Both of these read `sale.orderId`, and nothing else does. If no supplied
    // sale named an order, neither could have fired, whatever the findings say.
    blindChecks: Object.freeze(
      salesNamingAnOrder === 0 ? (['sale_without_order', 'order_sale_mismatch'] as const).slice() : [],
    ) as readonly ReconciliationFindingCode[],
    isReconciled: findings.length === 0,
  };
}
