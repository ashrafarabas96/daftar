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
import { OrderError, adviseBasketAvailability, stockKeyOf, summariseBasket, type CartLine, type StockOnHand, type UnitPrecisionDeclaration } from '../src';

/** A product that tracks inventory at the given precision — the ordinary case. */
const tracked = (unitDecimals: number): UnitPrecisionDeclaration => ({ tracksInventory: true, unitDecimals });
/** A product the merchant does not track, as the catalogue may lawfully declare it: no precision at all. */
const untrackedNoPrecision: UnitPrecisionDeclaration = { tracksInventory: false, unitDecimals: null };

const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VARIANT_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GIFT_CARD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LINE = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

const KEY_A = stockKeyOf({ productId: PRODUCT_A, variantId: null });
const KEY_A1 = stockKeyOf({ productId: PRODUCT_A, variantId: VARIANT_1 });
const KEY_B = stockKeyOf({ productId: PRODUCT_B, variantId: null });
const KEY_GIFT = stockKeyOf({ productId: GIFT_CARD, variantId: null });

const PRECISION = new Map<string, UnitPrecisionDeclaration>([
  [KEY_A, tracked(0)],
  [KEY_A1, tracked(0)],
  [KEY_B, tracked(3)],
  [KEY_GIFT, { tracksInventory: false, unitDecimals: 0 }],
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
    expect(() =>
      summariseBasket([{ lineId: LINE(1), productId: PRODUCT_A, variantId: VARIANT_1, quantity: '1' }], new Map([[KEY_A, tracked(0)]])),
    ).toThrowError(expect.objectContaining({ code: 'order.cart_line_invalid' }));
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
  // The same request, declared by the catalogue as a TRACKED product, for the
  // cases whose subject is the on-hand row of a tracked key. The position's own
  // `tracksInventory` must agree with the row's, so a tracked row needs a
  // tracked position: the disagreement is its own refusal, proved below.
  const trackedPositions = summariseBasket([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3' }], new Map([[KEY_GIFT, tracked(0)]]));

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
    expect(() => adviseBasketAvailability(trackedPositions, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: null }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
  });

  it('refuses a row that says tracked where the catalogue declaration said untracked', () => {
    // The position was validated against a declaration of UNTRACKED. A row that
    // answers "tracked" is about a different product, and neither source wins.
    expect(() => adviseBasketAvailability(positions, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '9' }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
  });

  it('refuses a row that says untracked where the catalogue declaration said tracked — the other direction', () => {
    expect(() => adviseBasketAvailability(trackedPositions, [{ stockKey: KEY_GIFT, trackInventory: false, onHand: null }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
  });

  it('admits a line of a product the catalogue declares with NO precision at all', () => {
    // The round-6 finding: a service, a delivery fee or a digital good carries
    // `unit_decimals IS NULL` in the frozen catalogue, which is lawful exactly
    // when `track_inventory` is false. Such a line must be sellable.
    const precisionFree = summariseBasket(
      [{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3.5' }],
      new Map([[KEY_GIFT, untrackedNoPrecision]]),
    );
    expect(precisionFree[0]?.unitDecimals).toBeNull();
    expect(precisionFree[0]?.tracksInventory).toBe(false);
    expect(precisionFree[0]?.totalQuantity).toBe('3.5000');
    const advice = adviseBasketAvailability(precisionFree, [{ stockKey: KEY_GIFT, trackInventory: false, onHand: null }]);
    expect(advice.items[0]?.verdict).toBe('not_tracked');
  });

  it('refuses a TRACKED product declared with no precision, as the catalogue CHECK does', () => {
    expect(() =>
      summariseBasket(
        [{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3' }],
        new Map([[KEY_GIFT, { tracksInventory: true, unitDecimals: null }]]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'order.unit_precision_required' }));
  });

  it('bounds a precision-free quantity by the storage scale and nothing narrower', () => {
    const map = new Map([[KEY_GIFT, untrackedNoPrecision]]);
    // Q4 is exactly representable...
    expect(summariseBasket([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0.0001' }], map)[0]?.totalQuantity).toBe('0.0001');
    // ...and a fifth decimal is refused, by the storage scale the frozen column carries.
    expect(() => summariseBasket([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0.00001' }], map)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
    // A precision-free line is still strictly positive.
    expect(() => summariseBasket([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0' }], map)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
  });

  it('refuses a declaration that does not say whether the product tracks inventory', () => {
    const malformed = new Map([[KEY_GIFT, { unitDecimals: 0 } as unknown as UnitPrecisionDeclaration]]);
    expect(() => summariseBasket([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '1' }], malformed)).toThrowError(
      expect.objectContaining({ code: 'order.unit_precision_invalid' }),
    );
  });

  it('shows that zero on hand and untracked are different answers for the same request', () => {
    const outOfStock = adviseBasketAvailability(trackedPositions, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '0' }]);
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
