/**
 * P3-09 — the two guards that must BOTH run, proven to compose.
 *
 * The modifier scaling in `aggregateToSaleLines` rounds HALF_EVEN and refuses a
 * quantity that vanishes, but it does NOT check the result against the modifier
 * product's own `unit_decimals`: that check lives downstream in
 * `expectedMovementsFor`. The second challenge measured that the chain closes
 * and then made the point that matters — no test file in the pack used both
 * functions, so the grain safety of a billed modifier quantity rested on a
 * caller remembering the second guard, and nothing recorded that dependency as
 * a tested fact.
 *
 * This file records it. It is also the shortest statement of what an integrator
 * has to wire: aggregate, then take the stock effect of each draft. Running
 * only the first is not safe, and the second case below is what it costs.
 */
import { describe, expect, it } from 'vitest';
import { aggregateToSaleLines, type OrderedModifier, type RestaurantOrderLine } from '../src/order-to-sale';
import { expectedMovementsFor, type SoldProductFacts } from '../src/stock-effect';
import { at } from './at';

const Q = (units: number): bigint => BigInt(Math.round(units * 10_000));

const line = (over: Partial<RestaurantOrderLine> & { orderLineId: string; productId: string }): RestaurantOrderLine => ({
  variantId: null,
  quantityQ4: Q(1),
  seatNo: null,
  courseNo: 1,
  modifiers: [],
  voided: false,
  recipeBinding: null,
  ...over,
});

const modifier = (over: Partial<OrderedModifier> & { modifierId: string; label: string }): OrderedModifier => ({
  productId: null,
  variantId: null,
  quantityQ4: Q(1),
  priced: false,
  recipeBinding: null,
  ...over,
});

/** A whole-counted stock product: shots are poured, not weighed. */
const shotFacts = (unitDecimals: number): SoldProductFacts => ({
  productId: 'extra-shot',
  stockVariantId: 'shot-unit',
  stockTracked: true,
  stockUnitDecimals: unitDecimals,
  recipeVersion: null,
  declaredService: false,
});

function shotDraftQuantity(lineQ4: bigint, modifierQ4: bigint): bigint {
  const drafts = aggregateToSaleLines([
    line({
      orderLineId: 'o1',
      productId: 'latte',
      quantityQ4: lineQ4,
      modifiers: [modifier({ modifierId: 'm1', label: 'extra shot', priced: true, productId: 'extra-shot', variantId: 'shot-unit', quantityQ4: modifierQ4 })],
    }),
  ]);
  const shot = drafts.find((d) => d.productId === 'extra-shot');
  if (shot === undefined) throw new Error('the modifier produced no sale line');
  return shot.quantityQ4;
}

describe('P3-09 — aggregation composes with the grain check it depends on', () => {
  it('passes a whole-unit modifier straight through both guards', () => {
    const quantityQ4 = shotDraftQuantity(Q(2), Q(1));
    expect(quantityQ4).toBe(Q(2));
    expect(expectedMovementsFor(shotFacts(0), quantityQ4)).toEqual([{ componentProductId: 'extra-shot', componentVariantId: 'shot-unit', quantityQ4: Q(2) }]);
  });

  it('lets a fractional modifier through aggregation and refuses it at the stock grain, before service', () => {
    // 0.7 of a shot on a one-shot line. Aggregation is right to allow it: a
    // quantity is not wrong for being fractional, and whether this particular
    // product can hold it is the catalogue's fact, not the order's. The second
    // guard is where it is refused — and it is refused BEFORE the dish is
    // served, which is the whole purpose of §57's refuse-before-service rule.
    const quantityQ4 = shotDraftQuantity(Q(1), Q(0.7));
    expect(quantityQ4).toBe(Q(0.7));
    expect(() => expectedMovementsFor(shotFacts(0), quantityQ4)).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.direct_quantity_not_representable' }),
    );
    // The same quantity on a product the catalogue holds to one decimal is
    // fine, which is the control: the refusal is about the GRAIN, not about
    // the quantity being fractional.
    expect(expectedMovementsFor(shotFacts(1), quantityQ4)).toHaveLength(1);
  });

  it('carries a HALF_EVEN rounding result into the grain check, not a truncated one', () => {
    // 0.1234 x 0.5678 is 700.6652 Q4 steps. The first guard rounds to 701; the
    // second then judges 701 against the product's grain. Were the first guard
    // truncating, the second would be judging a quantity the guest was never
    // charged for.
    const quantityQ4 = shotDraftQuantity(1234n, 5678n);
    expect(quantityQ4).toBe(701n);
    expect(expectedMovementsFor(shotFacts(4), quantityQ4)).toEqual([{ componentProductId: 'extra-shot', componentVariantId: 'shot-unit', quantityQ4: 701n }]);
  });

  it('refuses at the first guard what never reaches the second', () => {
    // A modifier that scales away is stopped at aggregation, so the stock
    // effect is never consulted: the two guards are ordered, not redundant.
    expect(() => shotDraftQuantity(1n, 1n)).toThrowError(expect.objectContaining({ code: 'restaurant.order.modifier_quantity_rounds_to_zero' }));
  });

  it('holds across the grid of grains a product may declare', () => {
    const quantityQ4 = shotDraftQuantity(Q(1), Q(0.25));
    expect(quantityQ4).toBe(Q(0.25));
    const refused: number[] = [];
    const accepted: number[] = [];
    for (const decimals of [0, 1, 2, 3, 4]) {
      try {
        expectedMovementsFor(shotFacts(decimals), quantityQ4);
        accepted.push(decimals);
      } catch {
        refused.push(decimals);
      }
    }
    // 0.25 needs two decimals: refused at 0 and 1, accepted from 2 up.
    expect(refused).toEqual([0, 1]);
    expect(accepted).toEqual([2, 3, 4]);
  });

  it('keeps the line and its modifier on their own grains, not a shared one', () => {
    const drafts = aggregateToSaleLines([
      line({
        orderLineId: 'o1',
        productId: 'latte',
        quantityQ4: Q(1),
        modifiers: [modifier({ modifierId: 'm1', label: 'extra shot', priced: true, productId: 'extra-shot', variantId: 'shot-unit', quantityQ4: Q(0.5) })],
      }),
    ]);
    expect(drafts).toHaveLength(2);
    const latte = drafts.find((d) => d.productId === 'latte');
    const shot = drafts.find((d) => d.productId === 'extra-shot');
    expect(latte?.quantityQ4).toBe(Q(1));
    expect(shot?.quantityQ4).toBe(Q(0.5));
    // The latte is whole-counted and fine; the half shot is refused on its own
    // product's grain. One draft's grain says nothing about another's.
    const latteFacts: SoldProductFacts = { ...shotFacts(0), productId: 'latte', stockVariantId: 'latte-unit' };
    expect(expectedMovementsFor(latteFacts, at(drafts, drafts.indexOf(latte === undefined ? at(drafts, 0) : latte)).quantityQ4)).toHaveLength(1);
    expect(() => expectedMovementsFor(shotFacts(0), Q(0.5))).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.direct_quantity_not_representable' }),
    );
  });
});
