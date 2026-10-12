import { describe, expect, it } from 'vitest';
import { at } from './at';
import {
  MAX_SALE_LINES,
  OrderToSaleRefusal,
  aggregateToSaleLines,
  kitchenInstructionsFor,
  type OrderedModifier,
  type RestaurantOrderLine,
} from '../src/order-to-sale';

const Q = (whole: number): bigint => BigInt(whole) * 10_000n;

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

describe('aggregateToSaleLines — the sale authority admits one line per variant', () => {
  it('merges two guests ordering the same drink into one sale line of quantity two', () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', productId: 'latte', seatNo: 1 }),
      line({ orderLineId: 'o2', productId: 'latte', seatNo: 2 }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(at(drafts, Number(0)).quantityQ4).toBe(Q(2));
    expect(at(drafts, Number(0)).contributingOrderLineIds).toEqual(['o1', 'o2']);
  });

  it('keeps different variants of the same product apart', () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', productId: 'latte', variantId: 'small' }),
      line({ orderLineId: 'o2', productId: 'latte', variantId: 'large' }),
      line({ orderLineId: 'o3', productId: 'latte', variantId: null }),
    ]);
    expect(drafts).toHaveLength(3);
  });

  it('turns a priced modifier into its own sale line, because price authority is the catalogue', () => {
    const drafts = aggregateToSaleLines([
      line({
        orderLineId: 'o1',
        productId: 'latte',
        modifiers: [modifier({ modifierId: 'm1', label: 'extra shot', priced: true, productId: 'extra-shot' })],
      }),
    ]);
    expect(drafts.map((d) => d.productId).sort()).toEqual(['extra-shot', 'latte']);
  });

  it('multiplies a modifier by its line quantity: two lattes with an extra shot each is two shots', () => {
    const drafts = aggregateToSaleLines([
      line({
        orderLineId: 'o1',
        productId: 'latte',
        quantityQ4: Q(2),
        modifiers: [modifier({ modifierId: 'm1', label: 'extra shot', priced: true, productId: 'extra-shot', quantityQ4: Q(1) })],
      }),
    ]);
    const shot = drafts.find((d) => d.productId === 'extra-shot');
    expect(shot?.quantityQ4).toBe(Q(2));
  });

  it('keeps an unpriced modifier out of the sale entirely', () => {
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', productId: 'latte', modifiers: [modifier({ modifierId: 'm1', label: 'no sugar' })] })]);
    expect(drafts).toHaveLength(1);
    expect(at(drafts, Number(0)).productId).toBe('latte');
  });

  it('bills nothing for a voided line, including its priced modifiers', () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', productId: 'latte' }),
      line({
        orderLineId: 'o2',
        productId: 'cake',
        voided: true,
        modifiers: [modifier({ modifierId: 'm1', label: 'extra cream', priced: true, productId: 'cream' })],
      }),
    ]);
    expect(drafts.map((d) => d.productId)).toEqual(['latte']);
  });

  it('refuses a priced modifier with no catalogue product — a quoted extra given away is lost revenue', () => {
    try {
      aggregateToSaleLines([line({ orderLineId: 'o1', productId: 'latte', modifiers: [modifier({ modifierId: 'm1', label: 'extra shot', priced: true })] })]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderToSaleRefusal);
      const refusal = error as OrderToSaleRefusal;
      expect(refusal.code).toBe('restaurant.order.modifier_price_not_catalogued');
      expect(refusal.details?.modifierId).toBe('m1');
    }
  });

  it('refuses a bill whose every line is voided rather than committing a sale of nothing', () => {
    expect(() => aggregateToSaleLines([line({ orderLineId: 'o1', productId: 'latte', voided: true })])).toThrowError(
      expect.objectContaining({ code: 'restaurant.order.no_billable_line' }),
    );
  });

  it('refuses an empty bill', () => {
    expect(() => aggregateToSaleLines([])).toThrowError(expect.objectContaining({ code: 'restaurant.order.no_billable_line' }));
  });

  it('refuses a non-positive quantity by code', () => {
    expect(() => aggregateToSaleLines([line({ orderLineId: 'o1', productId: 'latte', quantityQ4: 0n })])).toThrowError(
      expect.objectContaining({ code: 'restaurant.order.quantity_not_positive' }),
    );
  });

  it('refuses a bill that aggregates past the sale authority ceiling, and names the ceiling', () => {
    const many = Array.from({ length: MAX_SALE_LINES + 1 }, (_, i) => line({ orderLineId: `o${i}`, productId: `p${i}` }));
    expect(many).toHaveLength(201);
    try {
      aggregateToSaleLines(many);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as OrderToSaleRefusal;
      expect(refusal.code).toBe('restaurant.order.sale_line_budget_exceeded');
      expect(refusal.details?.maxSaleLines).toBe(200);
      expect(refusal.details?.saleLineCount).toBe(201);
    }
  });

  it('accepts a bill exactly at the ceiling — the refusal is off-by-one safe in both directions', () => {
    const atCap = Array.from({ length: MAX_SALE_LINES }, (_, i) => line({ orderLineId: `o${i}`, productId: `p${i}` }));
    expect(aggregateToSaleLines(atCap)).toHaveLength(MAX_SALE_LINES);
  });

  it('lets aggregation keep a bill under the ceiling that its order lines alone would exceed', () => {
    const repeats = Array.from({ length: 300 }, (_, i) => line({ orderLineId: `o${i}`, productId: 'latte' }));
    const drafts = aggregateToSaleLines(repeats);
    expect(drafts).toHaveLength(1);
    expect(at(drafts, Number(0)).quantityQ4).toBe(Q(300));
  });
});

describe('kitchenInstructionsFor — unpriced modifiers exist for the kitchen alone', () => {
  it('carries every modifier label, priced or not, and keeps seat and course', () => {
    const tickets = kitchenInstructionsFor([
      line({
        orderLineId: 'o1',
        productId: 'steak',
        seatNo: 3,
        courseNo: 2,
        modifiers: [modifier({ modifierId: 'm1', label: 'well done' }), modifier({ modifierId: 'm2', label: 'extra sauce', priced: true, productId: 'sauce' })],
      }),
    ]);
    expect(tickets).toHaveLength(1);
    expect(at(tickets, Number(0)).instructions).toEqual(['well done', 'extra sauce']);
    expect(at(tickets, Number(0)).seatNo).toBe(3);
    expect(at(tickets, Number(0)).courseNo).toBe(2);
  });

  it('does not send a voided line to the kitchen', () => {
    expect(kitchenInstructionsFor([line({ orderLineId: 'o1', productId: 'steak', voided: true })])).toHaveLength(0);
  });

  it('sends a line the sale will never see, when its only content is an unpriced instruction', () => {
    const tickets = kitchenInstructionsFor([line({ orderLineId: 'o1', productId: 'water', modifiers: [modifier({ modifierId: 'm1', label: 'no ice' })] })]);
    expect(at(tickets, Number(0)).instructions).toEqual(['no ice']);
  });
});

describe('P1-01 — a modifier is scaled by the pack’s one rounding rule', () => {
  const QQ = (q4: number): bigint => BigInt(q4);

  const scaled = (lineQ4: bigint, modQ4: bigint): bigint => {
    const drafts = aggregateToSaleLines([
      line({
        orderLineId: 'o1',
        productId: 'latte',
        quantityQ4: lineQ4,
        modifiers: [modifier({ modifierId: 'm1', label: 'syrup', priced: true, productId: 'syrup', quantityQ4: modQ4 })],
      }),
    ]);
    const found = drafts.find((d) => d.productId === 'syrup');
    if (found === undefined) throw new Error('the modifier produced no sale line');
    return found.quantityQ4;
  };

  it('rounds HALF_EVEN rather than truncating a billed quantity toward zero', () => {
    // 0.1234 x 0.5678 = 0.07006652, which is 700.6652 Q4 steps. Truncation
    // bills 700 and loses a step in silence; the pack's rule bills 701.
    expect(scaled(QQ(5678), QQ(1234))).toBe(701n);
  });

  it('rounds a tie to the even step, as every other quantity division in the pack does', () => {
    // 0.0005 x 1 = 5000 / 10000 in Q8 terms: exactly half a step, to the even one.
    expect(scaled(QQ(10_000), QQ(5))).toBe(5n);
    // 1.5 steps worth: 0.0003 x 0.5 = 1.5 Q4 steps, HALF_EVEN gives 2.
    expect(scaled(QQ(5_000), QQ(3))).toBe(2n);
    // 2.5 steps worth: 0.0005 x 0.5 -> 2.5, HALF_EVEN gives 2, not 3.
    expect(scaled(QQ(5_000), QQ(5))).toBe(2n);
  });

  it('leaves whole-unit multiplication exactly where it was', () => {
    expect(scaled(Q(2), Q(1))).toBe(Q(2));
    expect(scaled(Q(3), Q(2))).toBe(Q(6));
  });

  it('refuses a modifier that scales away, and names the MODIFIER rather than the line', () => {
    // The order line's own quantity is 1 and is perfectly valid. Reporting this
    // as the line's non-positive quantity would send an operator to correct
    // something that is already correct.
    try {
      scaled(QQ(1), QQ(1));
      throw new Error('expected a refusal, none was thrown');
    } catch (error) {
      if (!(error instanceof OrderToSaleRefusal)) throw error;
      expect(error.code).toBe('restaurant.order.modifier_quantity_rounds_to_zero');
      expect(error.details?.modifierId).toBe('m1');
      expect(error.details?.lineQuantityQ4).toBe('1');
      expect(error.details?.scaledQuantityQ4).toBe('0');
    }
  });

  it('never silently loses a step across a grid of line and modifier quantities', () => {
    // A bounded sweep, not a proof: it states that on this grid the result is
    // the pack's own HALF_EVEN of the Q8 product, so a return to truncation is
    // seen even where the two rules agree on most inputs.
    const expectedHalfEven = (a: bigint, b: bigint): bigint => {
      const n = a * b;
      const q = n / 10_000n;
      const r = n % 10_000n;
      const twice = r * 2n;
      if (twice > 10_000n) return q + 1n;
      if (twice < 10_000n) return q;
      return q % 2n === 0n ? q : q + 1n;
    };
    let checked = 0;
    for (let lineQ4 = 1; lineQ4 <= 40_000; lineQ4 += 997) {
      for (let modQ4 = 1; modQ4 <= 40_000; modQ4 += 1013) {
        const want = expectedHalfEven(BigInt(lineQ4), BigInt(modQ4));
        if (want <= 0n) continue;
        expect(scaled(BigInt(lineQ4), BigInt(modQ4))).toBe(want);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1_500);
  });
});
