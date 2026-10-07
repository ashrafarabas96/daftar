/**
 * Phase 10 — turning a restaurant order into a sale-commit payload.
 * PREPARED / NOT PROMOTED.
 *
 * Two facts about the LIVE sale contract shape this module, and neither is
 * negotiable from here:
 *
 *  1. `saleCommitLine` carries `{ lineId, productId, variantId, quantity,
 *     discountMinor }` and NO price. The server prices every line from the
 *     catalogue. So a modifier that costs money must BE a catalogue product.
 *  2. `SaleCommitSchema` refines "a sale has one line per variant": two lines
 *     with the same `productId:variantId` pair are refused.
 *
 * (2) is why a restaurant order line is not a sale line. Two guests ordering the
 * same latte are two order lines — the kitchen makes two, the waiter tracks two
 * seats — but one sale line of quantity 2. The fine-grained unit lives in the
 * restaurant pack; the aggregate is what the sale authority receives.
 *
 * It also fixes WHEN a bill may be split: a split must happen BEFORE commit, so
 * each bill aggregates its own lines into its own sale. After commit, a bill is
 * divided only by payment, through the Phase 4 payment/allocation authority.
 */

export type OrderToSaleRefusalCode =
  | 'restaurant.order.no_billable_line'
  | 'restaurant.order.quantity_not_positive'
  | 'restaurant.order.sale_line_budget_exceeded'
  | 'restaurant.order.modifier_price_not_catalogued';

export class OrderToSaleRefusal extends Error {
  constructor(
    readonly code: OrderToSaleRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderToSaleRefusal';
  }
}

/** The live ceiling, `MAX_SALE_LINES`, pinned in three places in the sale path. */
export const MAX_SALE_LINES = 200;

/**
 * A modifier chosen on an order line.
 *
 * `productId === null` means the modifier costs nothing and is a PREPARATION
 * INSTRUCTION only ("no ice", "well done"): it reaches the kitchen ticket and
 * never the sale. A priced modifier names the catalogue product that carries its
 * price, because price authority stays in the catalogue.
 */
export interface OrderedModifier {
  readonly modifierId: string;
  readonly label: string;
  readonly productId: string | null;
  readonly variantId: string | null;
  /** How many of this modifier on this one order line (e.g. two extra shots). */
  readonly quantityQ4: bigint;
  /** True when the merchant configured a price for it. Must imply `productId`. */
  readonly priced: boolean;
}

/**
 * One thing one guest ordered, once. The restaurant pack's finest unit.
 * Quantities are scaled integers (4 decimal places), matching the live
 * `sale_items.quantity NUMERIC(18,4)` and the request's decimal-string shape.
 */
export interface RestaurantOrderLine {
  readonly orderLineId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantityQ4: bigint;
  /** Which seat/guest, for the waiter and for splitting. Never financial. */
  readonly seatNo: number | null;
  /** Which course this belongs to, for firing. Never financial. */
  readonly courseNo: number;
  readonly modifiers: readonly OrderedModifier[];
  /** Void state: a voided line is billed to nobody. */
  readonly voided: boolean;
}

/** Exactly the shape `saleCommitLine` admits, minus the server-minted `lineId`. */
export interface SaleLineDraft {
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantityQ4: bigint;
  /** Which order lines and modifiers rolled into this one sale line. Display only. */
  readonly contributingOrderLineIds: readonly string[];
}

function variantKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? '-'}`;
}

/**
 * Aggregate a bill's order lines — and their priced modifiers — into the set of
 * sale lines the sale authority will accept.
 *
 * Voided lines contribute nothing. Unpriced modifiers contribute nothing. A
 * priced modifier without a catalogue product is refused rather than given away,
 * because a modifier the guest was quoted and not charged for is lost revenue.
 */
export function aggregateToSaleLines(orderLines: readonly RestaurantOrderLine[]): readonly SaleLineDraft[] {
  const buckets = new Map<string, { productId: string; variantId: string | null; quantityQ4: bigint; contributingOrderLineIds: string[] }>();

  const add = (productId: string, variantId: string | null, quantityQ4: bigint, orderLineId: string): void => {
    if (quantityQ4 <= 0n) {
      throw new OrderToSaleRefusal('restaurant.order.quantity_not_positive', `Order line ${orderLineId} carries a non-positive quantity ${quantityQ4}`, {
        orderLineId,
        quantityQ4: quantityQ4.toString(),
      });
    }
    const key = variantKey(productId, variantId);
    const bucket = buckets.get(key) ?? { productId, variantId, quantityQ4: 0n, contributingOrderLineIds: [] };
    bucket.quantityQ4 += quantityQ4;
    if (!bucket.contributingOrderLineIds.includes(orderLineId)) bucket.contributingOrderLineIds.push(orderLineId);
    buckets.set(key, bucket);
  };

  for (const line of orderLines) {
    if (line.voided) continue;
    add(line.productId, line.variantId, line.quantityQ4, line.orderLineId);
    for (const modifier of line.modifiers) {
      if (!modifier.priced) continue;
      if (modifier.productId === null) {
        throw new OrderToSaleRefusal(
          'restaurant.order.modifier_price_not_catalogued',
          `Modifier ${modifier.label} is priced but names no catalogue product, so the sale authority cannot price it`,
          { orderLineId: line.orderLineId, modifierId: modifier.modifierId },
        );
      }
      // A modifier's quantity multiplies with the line's: two lattes with an
      // extra shot each is two extra shots.
      add(modifier.productId, modifier.variantId, (modifier.quantityQ4 * line.quantityQ4) / 10_000n, line.orderLineId);
    }
  }

  if (buckets.size === 0) {
    throw new OrderToSaleRefusal('restaurant.order.no_billable_line', 'This bill has no billable line; a bill of nothing is not committed as a sale', {});
  }
  if (buckets.size > MAX_SALE_LINES) {
    throw new OrderToSaleRefusal(
      'restaurant.order.sale_line_budget_exceeded',
      `This bill aggregates to ${buckets.size} sale lines, over the sale authority's ceiling of ${MAX_SALE_LINES}`,
      { saleLineCount: buckets.size, maxSaleLines: MAX_SALE_LINES },
    );
  }
  return Object.freeze(
    [...buckets.values()].map((b) =>
      Object.freeze({
        productId: b.productId,
        variantId: b.variantId,
        quantityQ4: b.quantityQ4,
        contributingOrderLineIds: Object.freeze([...b.contributingOrderLineIds]),
      }),
    ),
  );
}

/**
 * The kitchen's view of one order line: what to make, and every instruction,
 * priced or not. Unpriced modifiers appear ONLY here — this is the whole reason
 * they exist.
 */
export interface KitchenInstructionLine {
  readonly orderLineId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantityQ4: bigint;
  readonly seatNo: number | null;
  readonly courseNo: number;
  readonly instructions: readonly string[];
}

export function kitchenInstructionsFor(orderLines: readonly RestaurantOrderLine[]): readonly KitchenInstructionLine[] {
  return Object.freeze(
    orderLines
      .filter((line) => !line.voided)
      .map((line) =>
        Object.freeze({
          orderLineId: line.orderLineId,
          productId: line.productId,
          variantId: line.variantId,
          quantityQ4: line.quantityQ4,
          seatNo: line.seatNo,
          courseNo: line.courseNo,
          instructions: Object.freeze(line.modifiers.map((m) => m.label)),
        }),
      ),
  );
}
