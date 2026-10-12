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
 *
 * ── Aggregation does not erase provenance ──
 * Two lattes can be two different dishes. If one entered preparation while
 * recipe v3 was current and the second after the chef edited it to v4, §56 binds
 * each line to its own version and both bindings are facts about what was
 * cooked. The aggregate "latte x 2" is only the SALE's view of them.
 *
 * So every sale line carries its `contributions`: each contributing order line
 * or priced modifier, its own quantity, and its own recipe binding. This is not
 * display data. Expanding the aggregate quantity under any single version would
 * consume the wrong components — v3's milk twice when half the cups were made to
 * v4 — which is the wrong consumption the directive's §17 forbids. The component
 * set is the SUM of each contribution expanded under its OWN bound version; see
 * `aggregate-consumption.ts`.
 *
 * The cardinality that follows, and which the Contract Diff has to resolve at
 * promotion: one sale line maps to N contributions and to M distinct recipe
 * versions, M <= N. It is 1:N, never 1:1.
 */

import type { RecipeBinding } from './recipe-binding';
import { QUANTITY_SCALE, halfEvenDiv } from './recipe-version';

export type OrderToSaleRefusalCode =
  | 'restaurant.order.no_billable_line'
  | 'restaurant.order.quantity_not_positive'
  | 'restaurant.order.sale_line_budget_exceeded'
  | 'restaurant.order.modifier_price_not_catalogued'
  /** A priced modifier's quantity scaled to zero or less; it is not billed as nothing. */
  | 'restaurant.order.modifier_quantity_rounds_to_zero';

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
  /**
   * The recipe version bound to THIS modifier at preparation start (§56), when
   * the modifier's product is composed. `null` for a direct or service product,
   * and for an unpriced instruction.
   */
  readonly recipeBinding: RecipeBinding | null;
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
  /**
   * The recipe version bound to THIS line at preparation start (§56). `null`
   * while the line is still queued, and for a direct or service product.
   *
   * Two lines of the same variant may carry different bindings, and that
   * difference survives aggregation.
   */
  readonly recipeBinding: RecipeBinding | null;
}

/**
 * One contribution to an aggregated sale line: where a part of its quantity came
 * from, and under which recipe version that part was prepared.
 *
 * This is the record that makes the aggregate reversible. Billing reads the
 * summed quantity; consumption, waste and audit read the contributions.
 */
export interface SaleLineContribution {
  readonly orderLineId: string;
  /** `null` when the contribution is the order line itself rather than a modifier on it. */
  readonly modifierId: string | null;
  /** This contribution's own share of the sale line's quantity, in Q4. */
  readonly quantityQ4: bigint;
  /** The version bound to this contribution at preparation start, or null. */
  readonly recipeBinding: RecipeBinding | null;
}

/** Exactly the shape `saleCommitLine` admits, minus the server-minted `lineId`. */
export interface SaleLineDraft {
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantityQ4: bigint;
  /** Which order lines rolled into this one sale line. Display. */
  readonly contributingOrderLineIds: readonly string[];
  /**
   * Every contribution, with its own quantity and its own recipe binding. The
   * quantities sum to `quantityQ4` exactly, and the distinct bindings here are
   * the M recipe identities this one sale line was prepared under — identities,
   * because two different recipes can share a version number.
   */
  readonly contributions: readonly SaleLineContribution[];
}

/**
 * The distinct recipe IDENTITIES one aggregated sale line was prepared under.
 *
 * Identities, not version numbers. A bare `3` is not an identity: recipe A v3
 * and recipe B v3 are different recipes, and a set of numbers cannot tell them
 * apart. One sale line can legitimately carry two different recipes — a variant
 * whose dish was re-recipied, or a priced modifier with a recipe of its own — so
 * collapsing to numbers would let a movement from the wrong recipe pass the
 * completeness check because some other contribution happened to be at the same
 * version number.
 */
export function boundRecipesOf(draft: SaleLineDraft): readonly RecipeBinding[] {
  const byKey = new Map<string, RecipeBinding>();
  for (const contribution of draft.contributions) {
    const binding = contribution.recipeBinding;
    if (binding === null) continue;
    byKey.set(`${binding.recipeId}@${binding.version}`, Object.freeze({ ...binding }));
  }
  return Object.freeze(
    [...byKey.values()].sort((a, b) => {
      if (a.recipeId !== b.recipeId) return a.recipeId < b.recipeId ? -1 : 1;
      return a.version - b.version;
    }),
  );
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
  const buckets = new Map<
    string,
    { productId: string; variantId: string | null; quantityQ4: bigint; contributingOrderLineIds: string[]; contributions: SaleLineContribution[] }
  >();

  const add = (
    productId: string,
    variantId: string | null,
    quantityQ4: bigint,
    orderLineId: string,
    modifierId: string | null,
    recipeBinding: RecipeBinding | null,
  ): void => {
    if (quantityQ4 <= 0n) {
      throw new OrderToSaleRefusal('restaurant.order.quantity_not_positive', `Order line ${orderLineId} carries a non-positive quantity ${quantityQ4}`, {
        orderLineId,
        quantityQ4: quantityQ4.toString(),
      });
    }
    const key = variantKey(productId, variantId);
    const bucket = buckets.get(key) ?? { productId, variantId, quantityQ4: 0n, contributingOrderLineIds: [], contributions: [] };
    bucket.quantityQ4 += quantityQ4;
    if (!bucket.contributingOrderLineIds.includes(orderLineId)) bucket.contributingOrderLineIds.push(orderLineId);
    // Each contribution is recorded separately even when two share a variant and
    // a version: collapsing them would lose which order line owes which share,
    // and waste on a cancellation is per line.
    bucket.contributions.push(
      Object.freeze({ orderLineId, modifierId, quantityQ4, recipeBinding: recipeBinding === null ? null : Object.freeze({ ...recipeBinding }) }),
    );
    buckets.set(key, bucket);
  };

  for (const line of orderLines) {
    if (line.voided) continue;
    add(line.productId, line.variantId, line.quantityQ4, line.orderLineId, null, line.recipeBinding);
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
      // extra shot each is two extra shots. Two Q4 quantities multiply to a Q8
      // product, so coming back to Q4 is a DIVISION, and a division needs the
      // pack's one stated rounding rule. `halfEvenDiv`, not `/`: bare BigInt
      // division truncates toward zero, which silently loses up to one Q4 step
      // off a BILLED quantity and would make this the only place in the pack
      // that rounds a quantity by a different rule than `expandRecipe` does.
      const scaledQuantityQ4 = halfEvenDiv(modifier.quantityQ4 * line.quantityQ4, QUANTITY_SCALE);
      if (scaledQuantityQ4 <= 0n) {
        // Named apart from the line's own non-positive refusal, which this
        // would otherwise be reported as. The ORDER LINE's quantity is fine;
        // it is the modifier that vanished under scaling, and an operator sent
        // to correct the line would find nothing wrong with it. `expandRecipe`
        // makes the same distinction for a component.
        throw new OrderToSaleRefusal(
          'restaurant.order.modifier_quantity_rounds_to_zero',
          `Modifier ${modifier.label} scales to ${scaledQuantityQ4} on order line ${line.orderLineId}; a priced modifier that rounds away is not billed as nothing`,
          {
            orderLineId: line.orderLineId,
            modifierId: modifier.modifierId,
            modifierQuantityQ4: modifier.quantityQ4.toString(),
            lineQuantityQ4: line.quantityQ4.toString(),
            scaledQuantityQ4: scaledQuantityQ4.toString(),
          },
        );
      }
      add(modifier.productId, modifier.variantId, scaledQuantityQ4, line.orderLineId, modifier.modifierId, modifier.recipeBinding);
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
        contributions: Object.freeze([...b.contributions]),
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
