/**
 * The basket merge and the ADVISORY availability read.
 *
 * The headline proof is `the basket, not the line`: ten on hand and two lines of
 * six each. Each line alone is satisfiable, the basket is not, and a read that
 * answered per line would tell the shopper both lines are fine. That is the
 * defect this fold exists to make impossible, so it is proved in both
 * directions — the two lines pass individually, and the merged position fails.
 */
import { describe, expect, it } from 'vitest';
import { OrderError, adviseBasketAvailability, stockKeyOf, summariseBasket, type CartLine, type StockOnHand } from '../src';

const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VARIANT_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GIFT_CARD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LINE = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

const KEY_A = stockKeyOf({ productId: PRODUCT_A, variantId: null });
const KEY_A1 = stockKeyOf({ productId: PRODUCT_A, variantId: VARIANT_1 });
const KEY_B = stockKeyOf({ productId: PRODUCT_B, variantId: null });
const KEY_GIFT = stockKeyOf({ productId: GIFT_CARD, variantId: null });

const PRECISION = new Map<string, number>([
  [KEY_A, 0],
  [KEY_A1, 0],
  [KEY_B, 3],
  [KEY_GIFT, 0],
]);

describe('the stock key', () => {
  it('separates a variant from the simple product it belongs to', () => {
    expect(KEY_A).not.toBe(KEY_A1);
    expect(KEY_A).toBe(`${PRODUCT_A}:`);
    expect(KEY_A1).toBe(`${PRODUCT_A}:${VARIANT_1}`);
  });
});

describe('summariseBasket', () => {
  it('merges rows of one stock key, sums them exactly, and keeps the FIRST row as representative', () => {
    const lines: CartLine[] = [
      { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '6' },
      { lineId: LINE(2), productId: PRODUCT_B, variantId: null, quantity: '0.125' },
      { lineId: LINE(3), productId: PRODUCT_A, variantId: null, quantity: '6' },
    ];
    const positions = summariseBasket(lines, PRECISION);
    expect(positions).toHaveLength(2);

    const a = positions.find((p) => p.stockKey === KEY_A);
    // Q4 canonical, as `@daftar/inventory`'s `formatQuantity` renders it. The
    // basket does NOT invent a second rendering of a quantity: one inventory
    // truth means one spelling of "twelve" across the basket, the movement and
    // the ledger.
    expect(a?.totalQuantity).toBe('12.0000');
    expect(a?.lineIds).toEqual([LINE(1), LINE(3)]);
    expect(a?.representativeLineId).toBe(LINE(1));

    const b = positions.find((p) => p.stockKey === KEY_B);
    expect(b?.totalQuantity).toBe('0.1250');
  });

  it('orders positions by first appearance, not by how a UUID sorts', () => {
    const positions = summariseBasket(
      [
        { lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '1' },
        { lineId: LINE(2), productId: PRODUCT_A, variantId: null, quantity: '1' },
      ],
      PRECISION,
    );
    expect(positions.map((p) => p.stockKey)).toEqual([KEY_B, KEY_A]);
  });

  it('refuses an empty basket', () => {
    expect(() => summariseBasket([], PRECISION)).toThrowError(expect.objectContaining({ code: 'order.cart_empty' }));
  });

  it('refuses two rows that share a lineId', () => {
    expect(() =>
      summariseBasket(
        [
          { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '1' },
          { lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '1' },
        ],
        PRECISION,
      ),
    ).toThrowError(expect.objectContaining({ code: 'order.cart_line_duplicate' }));
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('refuses the quantity %s on a whole-unit product', (quantity) => {
    expect(() => summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
  });

  it('refuses a quantity finer than the unit allows, and admits one at exactly its precision', () => {
    expect(() => summariseBasket([{ lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '0.0001' }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
    expect(summariseBasket([{ lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '0.001' }], PRECISION)[0]?.totalQuantity).toBe('0.0010');
  });

  it('refuses a line whose stock key has no stated unit precision', () => {
    expect(() => summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: VARIANT_1, quantity: '1' }], new Map([[KEY_A, 0]]))).toThrowError(
      expect.objectContaining({ code: 'order.cart_line_invalid' }),
    );
  });

  it('refuses a variant id that is not a canonical UUID', () => {
    expect(() => summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: 'not-a-uuid', quantity: '1' }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.cart_line_invalid' }),
    );
  });
});

describe('adviseBasketAvailability — the basket, not the line', () => {
  const onHandTen: StockOnHand[] = [{ stockKey: KEY_A, trackInventory: true, onHand: '10' }];

  it('each line of six alone is satisfiable', () => {
    for (const lineId of [LINE(1), LINE(3)]) {
      const positions = summariseBasket([{ lineId, productId: PRODUCT_A, variantId: null, quantity: '6' }], PRECISION);
      const advice = adviseBasketAvailability(positions, onHandTen);
      expect(advice.items[0]?.verdict).toBe('sufficient');
      expect(advice.anyInsufficient).toBe(false);
    }
  });

  it('the two of them together are NOT — and the shortfall is named exactly', () => {
    const positions = summariseBasket(
      [
        { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '6' },
        { lineId: LINE(3), productId: PRODUCT_A, variantId: null, quantity: '6' },
      ],
      PRECISION,
    );
    const advice = adviseBasketAvailability(positions, onHandTen);
    expect(advice.items).toHaveLength(1);
    expect(advice.items[0]?.requestedQuantity).toBe('12.0000');
    expect(advice.items[0]?.verdict).toBe('insufficient');
    expect(advice.items[0]?.shortfallQuantity).toBe('2.0000');
    expect(advice.anyInsufficient).toBe(true);
  });

  it('says in its own type that it is advice', () => {
    const positions = summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '1' }], PRECISION);
    expect(adviseBasketAvailability(positions, onHandTen).advisory).toBe(true);
  });

  it('calls exactly-on-hand sufficient, and one more than on hand insufficient', () => {
    const exact = summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '10' }], PRECISION);
    expect(adviseBasketAvailability(exact, onHandTen).items[0]?.verdict).toBe('sufficient');
    const over = summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '11' }], PRECISION);
    expect(adviseBasketAvailability(over, onHandTen).items[0]?.verdict).toBe('insufficient');
    expect(adviseBasketAvailability(over, onHandTen).items[0]?.shortfallQuantity).toBe('1.0000');
  });
});

describe('adviseBasketAvailability — an untracked product is not out of stock', () => {
  const positions = summariseBasket([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3' }], PRECISION);

  it('verdicts an untracked key not_tracked, with a null figure rather than zero', () => {
    const advice = adviseBasketAvailability(positions, [{ stockKey: KEY_GIFT, trackInventory: false, onHand: null }]);
    expect(advice.items[0]?.verdict).toBe('not_tracked');
    expect(advice.items[0]?.onHand).toBeNull();
    expect(advice.anyInsufficient).toBe(false);
  });

  it('refuses an untracked key that reported a figure', () => {
    expect(() => adviseBasketAvailability(positions, [{ stockKey: KEY_GIFT, trackInventory: false, onHand: '0' }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
  });

  it('refuses a tracked key that reported none — never folds past it', () => {
    expect(() => adviseBasketAvailability(positions, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: null }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
  });

  it('shows that zero on hand and untracked are different answers for the same request', () => {
    const outOfStock = adviseBasketAvailability(positions, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '0' }]);
    expect(outOfStock.items[0]?.verdict).toBe('insufficient');
    const untracked = adviseBasketAvailability(positions, [{ stockKey: KEY_GIFT, trackInventory: false, onHand: null }]);
    expect(untracked.items[0]?.verdict).toBe('not_tracked');
  });
});

describe('adviseBasketAvailability — the subject set is exhaustive and disjoint', () => {
  const positions = summariseBasket(
    [
      { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '1' },
      { lineId: LINE(2), productId: PRODUCT_B, variantId: null, quantity: '1' },
    ],
    PRECISION,
  );

  it('gives every named position exactly one verdict', () => {
    const advice = adviseBasketAvailability(positions, [
      { stockKey: KEY_A, trackInventory: true, onHand: '1' },
      { stockKey: KEY_B, trackInventory: true, onHand: '1' },
    ]);
    expect(advice.items.map((i) => i.stockKey).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  it('refuses a missing on-hand row rather than treating it as zero', () => {
    expect(() => adviseBasketAvailability(positions, [{ stockKey: KEY_A, trackInventory: true, onHand: '1' }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_subject_missing' }),
    );
  });

  it('refuses an on-hand row for a key nobody asked about', () => {
    expect(() =>
      adviseBasketAvailability(positions, [
        { stockKey: KEY_A, trackInventory: true, onHand: '1' },
        { stockKey: KEY_B, trackInventory: true, onHand: '1' },
        { stockKey: KEY_A1, trackInventory: true, onHand: '1' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'order.availability_subject_unknown' }));
  });

  it('refuses two rows for one key', () => {
    expect(() =>
      adviseBasketAvailability(positions, [
        { stockKey: KEY_A, trackInventory: true, onHand: '1' },
        { stockKey: KEY_A, trackInventory: true, onHand: '9' },
        { stockKey: KEY_B, trackInventory: true, onHand: '1' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }));
  });

  it('refuses an on-hand figure that is not an exact decimal', () => {
    expect(() =>
      adviseBasketAvailability(positions, [
        { stockKey: KEY_A, trackInventory: true, onHand: '1e3' },
        { stockKey: KEY_B, trackInventory: true, onHand: '1' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }));
  });

  it('raises OrderError and nothing else', () => {
    try {
      adviseBasketAvailability(positions, []);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
    }
  });
});
