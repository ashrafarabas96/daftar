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

// Round 8, P3-02: `summariseBasket` now takes the instant the basket is read at,
// REQUIRED and supplied rather than read from a clock, because the relation
// refuses a retraction at an instant that has not arrived (`I2.6`, leg 8) and
// this package accepted one. Existing cases call it through this helper, which
// pins one reference instant for the whole suite so no case depends on when it
// runs; the law about `asOf` itself is asserted on the real signature in
// `summariseBasket — the reference instant` below.
const AS_OF = '2026-10-12T12:00:00Z';
const summariseAt = (
  lines: readonly CartLine[],
  precision: ReadonlyMap<string, UnitPrecisionDeclaration>,
  asOf: string = AS_OF,
): ReturnType<typeof summariseBasket> => summariseBasket(lines, precision, asOf);

describe('summariseBasket', () => {
  it('merges rows of one stock key, sums them exactly, and keeps the FIRST row as representative', () => {
    const lines: CartLine[] = [
      { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '6', retractedAt: null },
      { lineId: LINE(2), productId: PRODUCT_B, variantId: null, quantity: '0.125', retractedAt: null },
      { lineId: LINE(3), productId: PRODUCT_A, variantId: null, quantity: '6', retractedAt: null },
    ];
    const positions = summariseAt(lines, PRECISION);
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
    const positions = summariseAt(
      [
        { lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '1', retractedAt: null },
        { lineId: LINE(2), productId: PRODUCT_A, variantId: null, quantity: '1', retractedAt: null },
      ],
      PRECISION,
    );
    expect(positions.map((p) => p.stockKey)).toEqual([KEY_B, KEY_A]);
  });

  it('refuses an empty basket', () => {
    expect(() => summariseAt([], PRECISION)).toThrowError(expect.objectContaining({ code: 'order.cart_empty' }));
  });

  it('refuses two rows that share a lineId', () => {
    expect(() =>
      summariseAt(
        [
          { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '1', retractedAt: null },
          { lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '1', retractedAt: null },
        ],
        PRECISION,
      ),
    ).toThrowError(expect.objectContaining({ code: 'order.cart_line_duplicate' }));
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('refuses the quantity %s on a whole-unit product', (quantity) => {
    expect(() => summariseAt([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity, retractedAt: null }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
  });

  it('refuses a quantity finer than the unit allows, and admits one at exactly its precision', () => {
    expect(() => summariseAt([{ lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '0.0001', retractedAt: null }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
    expect(summariseAt([{ lineId: LINE(1), productId: PRODUCT_B, variantId: null, quantity: '0.001', retractedAt: null }], PRECISION)[0]?.totalQuantity).toBe(
      '0.0010',
    );
  });

  it('refuses a line whose stock key has no stated unit precision', () => {
    expect(() =>
      summariseAt([{ lineId: LINE(1), productId: PRODUCT_A, variantId: VARIANT_1, quantity: '1', retractedAt: null }], new Map([[KEY_A, tracked(0)]])),
    ).toThrowError(expect.objectContaining({ code: 'order.cart_line_invalid' }));
  });

  it('refuses a variant id that is not a canonical UUID', () => {
    expect(() => summariseAt([{ lineId: LINE(1), productId: PRODUCT_A, variantId: 'not-a-uuid', quantity: '1', retractedAt: null }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.cart_line_invalid' }),
    );
  });
});

describe('adviseBasketAvailability — the basket, not the line', () => {
  const onHandTen: StockOnHand[] = [{ stockKey: KEY_A, trackInventory: true, onHand: '10' }];

  it('each line of six alone is satisfiable', () => {
    for (const lineId of [LINE(1), LINE(3)]) {
      const positions = summariseAt([{ lineId, productId: PRODUCT_A, variantId: null, quantity: '6', retractedAt: null }], PRECISION);
      const advice = adviseBasketAvailability(positions, onHandTen);
      expect(advice.items[0]?.verdict).toBe('sufficient');
      expect(advice.anyInsufficient).toBe(false);
    }
  });

  it('the two of them together are NOT — and the shortfall is named exactly', () => {
    const positions = summariseAt(
      [
        { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '6', retractedAt: null },
        { lineId: LINE(3), productId: PRODUCT_A, variantId: null, quantity: '6', retractedAt: null },
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
    const positions = summariseAt([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '1', retractedAt: null }], PRECISION);
    expect(adviseBasketAvailability(positions, onHandTen).advisory).toBe(true);
  });

  it('calls exactly-on-hand sufficient, and one more than on hand insufficient', () => {
    const exact = summariseAt([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '10', retractedAt: null }], PRECISION);
    expect(adviseBasketAvailability(exact, onHandTen).items[0]?.verdict).toBe('sufficient');
    const over = summariseAt([{ lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '11', retractedAt: null }], PRECISION);
    expect(adviseBasketAvailability(over, onHandTen).items[0]?.verdict).toBe('insufficient');
    expect(adviseBasketAvailability(over, onHandTen).items[0]?.shortfallQuantity).toBe('1.0000');
  });
});

describe('adviseBasketAvailability — an untracked product is not out of stock', () => {
  const positions = summariseAt([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3', retractedAt: null }], PRECISION);
  // The same request, declared by the catalogue as a TRACKED product, for the
  // cases whose subject is the on-hand row of a tracked key. The position's own
  // `tracksInventory` must agree with the row's, so a tracked row needs a
  // tracked position: the disagreement is its own refusal, proved below.
  const trackedPositions = summariseAt(
    [{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3', retractedAt: null }],
    new Map([[KEY_GIFT, tracked(0)]]),
  );

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
    const precisionFree = summariseAt(
      [{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3.5', retractedAt: null }],
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
      summariseAt(
        [{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '3', retractedAt: null }],
        new Map([[KEY_GIFT, { tracksInventory: true, unitDecimals: null }]]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'order.unit_precision_required' }));
  });

  it('bounds a precision-free quantity by the storage scale and nothing narrower', () => {
    const map = new Map([[KEY_GIFT, untrackedNoPrecision]]);
    // Q4 is exactly representable...
    expect(summariseAt([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0.0001', retractedAt: null }], map)[0]?.totalQuantity).toBe(
      '0.0001',
    );
    // ...and a fifth decimal is refused, by the storage scale the frozen column carries.
    expect(() => summariseAt([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0.00001', retractedAt: null }], map)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
    // A precision-free line is still strictly positive.
    expect(() => summariseAt([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0', retractedAt: null }], map)).toThrowError(
      expect.objectContaining({ code: 'order.cart_quantity_invalid' }),
    );
  });

  it('refuses a declaration that does not say whether the product tracks inventory', () => {
    const malformed = new Map([[KEY_GIFT, { unitDecimals: 0 } as unknown as UnitPrecisionDeclaration]]);
    expect(() => summariseAt([{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '1', retractedAt: null }], malformed)).toThrowError(
      expect.objectContaining({ code: 'order.unit_precision_invalid' }),
    );
  });

  // Round-7 challenge P2-02: the agreement check was guarded by
  // `typeof position.tracksInventory === 'boolean' &&`, which made it
  // CONDITIONAL on the field whose absence it exists to catch. Two sibling
  // entry points refuse the identical input; this one folded past it with a
  // verdict. The string "false" matters more than the absence, because that is
  // what a boolean becomes across a JSON or form boundary.
  // These three assert the MESSAGE and not only the code, and that is the point
  // of them. A malformed flag is ALSO caught by the agreement comparison one
  // line later, under the same code — a non-boolean is `!==` every boolean — so
  // a case asserting the code alone cannot tell which guard fired, and a
  // mutation disabling the shape guard stayed green. (It did: M49 and M50
  // survived their first version of these cases, for exactly the reason the
  // round-5 Challenger named and I hit once before with M39.) What the shape
  // guard buys is the SUBJECT of the refusal: a client told two sources
  // "disagree" goes looking for a stale catalogue, when the truth is that its
  // own position carried no flag.
  const subjectOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return error instanceof OrderError ? error.message : String(error);
    }
    throw new Error('the call was expected to refuse and did not');
  };

  it('refuses a position whose tracking flag is ABSENT, naming the position and not a disagreement', () => {
    const noFlag = [{ ...(positions[0] as (typeof positions)[number]) }] as unknown as typeof positions;
    delete (noFlag[0] as { tracksInventory?: boolean }).tracksInventory;
    expect(() => adviseBasketAvailability(noFlag, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '9' }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
    expect(subjectOf(() => adviseBasketAvailability(noFlag, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '9' }]))).toContain(
      'a basket position does not state whether',
    );
  });

  it('refuses a position whose tracking flag is the STRING "false", which is what a boolean becomes over JSON', () => {
    const stringFlag = [{ ...(positions[0] as (typeof positions)[number]), tracksInventory: 'false' }] as unknown as typeof positions;
    // Both on-hand answers, so the case cannot pass by the comparison alone:
    // `"false"` disagrees with `true` AND with `false` under `!==`, and the
    // refusal must name the position in both.
    for (const row of [
      { stockKey: KEY_GIFT, trackInventory: true, onHand: '9' },
      { stockKey: KEY_GIFT, trackInventory: false, onHand: null },
    ]) {
      expect(subjectOf(() => adviseBasketAvailability(stringFlag, [row]))).toContain('a basket position does not state whether');
    }
  });

  it('refuses an on-hand ROW whose tracking flag is not a boolean, naming the row', () => {
    const badRow = [{ stockKey: KEY_GIFT, trackInventory: 'true', onHand: '9' }] as unknown as StockOnHand[];
    expect(() => adviseBasketAvailability(positions, badRow)).toThrowError(expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }));
    expect(subjectOf(() => adviseBasketAvailability(positions, badRow))).toContain('an on-hand row does not state whether');
  });

  it('refuses the round-7 consequence: a precision-free line advised sufficient against a tracked row', () => {
    // A4 in the challenge: a precision-free 0.0001 was advised 'sufficient'
    // against a tracked row with 1.0000 on hand and never checked for
    // representability, because the flag was absent and the check was skipped.
    const precisionFree = summariseAt(
      [{ lineId: LINE(1), productId: GIFT_CARD, variantId: null, quantity: '0.0001', retractedAt: null }],
      new Map([[KEY_GIFT, untrackedNoPrecision]]),
    );
    const flagless = [{ ...(precisionFree[0] as (typeof precisionFree)[number]) }] as unknown as typeof precisionFree;
    delete (flagless[0] as { tracksInventory?: boolean }).tracksInventory;
    expect(() => adviseBasketAvailability(flagless, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '1.0000' }])).toThrowError(
      expect.objectContaining({ code: 'order.availability_tracking_inconsistent' }),
    );
    expect(subjectOf(() => adviseBasketAvailability(flagless, [{ stockKey: KEY_GIFT, trackInventory: true, onHand: '1.0000' }]))).toContain(
      'a basket position does not state whether',
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
  const positions = summariseAt(
    [
      { lineId: LINE(1), productId: PRODUCT_A, variantId: null, quantity: '1', retractedAt: null },
      { lineId: LINE(2), productId: PRODUCT_B, variantId: null, quantity: '1', retractedAt: null },
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

// Round-7 challenge P2-03: `I2.6` says the merge is "over the non-retracted
// rows" and the package contained no occurrence of `retract` at all. A law
// stated in a migration request and absent from the code that reads the
// relation is a law nobody enforces — and here it is the ONLY removal path,
// because DELETE and TRUNCATE are now refused by the relation itself.
describe('summariseBasket — a retracted line is not in the basket', () => {
  const live = (n: number, quantity: string): CartLine => ({
    lineId: LINE(n),
    productId: PRODUCT_A,
    variantId: null,
    quantity,
    retractedAt: null,
  });
  const retracted = (n: number, quantity: string): CartLine => ({ ...live(n, quantity), retractedAt: '2026-10-12T01:00:00Z' });

  it('excludes a retracted line from the position it would otherwise have joined', () => {
    const both = summariseAt([live(1, '2'), retracted(2, '5')], PRECISION);
    expect(both).toHaveLength(1);
    expect(both[0]?.totalQuantity).toBe('2.0000');
    expect(both[0]?.lineIds).toEqual([LINE(1)]);
    // The control: the same two lines, both live, sum to 7.
    expect(summariseAt([live(1, '2'), live(2, '5')], PRECISION)[0]?.totalQuantity).toBe('7.0000');
  });

  it('drops the whole position when every line of a stock key is retracted, and keeps the others', () => {
    const positions = summariseAt([retracted(1, '2'), { ...live(2, '3'), productId: PRODUCT_B }], PRECISION);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.stockKey).toBe(KEY_B);
  });

  it('refuses a basket whose every line is retracted, because it asks for nothing', () => {
    expect(() => summariseAt([retracted(1, '2'), retracted(2, '3')], PRECISION)).toThrowError(expect.objectContaining({ code: 'order.cart_empty' }));
  });

  it('keeps a retracted line REPRESENTATIVE of nothing but still claims its id, so it cannot smuggle a duplicate', () => {
    expect(() => summariseAt([retracted(1, '2'), live(1, '3')], PRECISION)).toThrowError(expect.objectContaining({ code: 'order.cart_line_duplicate' }));
  });

  it('claims the IDENTITY of a retracted line too, so a malformed id is refused before the skip', () => {
    // Mutation M54 of round 15 moved this one claim below the retraction skip
    // and the suite stayed green: the duplicate case above covers the id
    // REGISTER, but nothing covered the id's SHAPE on a retracted line. A
    // retracted line is skipped as a QUANTITY; it is not skipped as an
    // identity, because `consumedCartLineIds` will name it to the sales
    // authority and a malformed id there is a row nobody can match.
    expect(() => summariseAt([live(1, '2'), { ...retracted(2, '5'), lineId: 'not-a-uuid' }], PRECISION)).toThrowError(
      expect.objectContaining({ code: 'order.id_invalid' }),
    );
  });

  it('refuses a retraction that is not a canonical instant', () => {
    for (const bad of ['2026-10-12', '2026-10-12T01:00:00.000Z', '2026-10-12T01:00:00+02:00', 'yesterday', '']) {
      expect(() => summariseAt([live(1, '2'), { ...retracted(2, '5'), retractedAt: bad }], PRECISION)).toThrowError(
        expect.objectContaining({ code: 'order.cart_line_invalid' }),
      );
    }
  });

  it('refuses a line that does not state its retraction at all, since a type-only field has no runtime existence', () => {
    const noField = [live(1, '2'), live(2, '5')] as CartLine[];
    delete (noField[1] as { retractedAt?: string | null }).retractedAt;
    expect(() => summariseAt(noField, PRECISION)).toThrowError(expect.objectContaining({ code: 'order.cart_line_invalid' }));
  });

  it('does not judge a retracted line by the live rules, so a basket stays orderable after a removal', () => {
    // The line was priced at four decimals when it was appended; the catalogue
    // now says whole units. A live line of 2.5 is refused — and the same line
    // retracted is skipped, because it contributes nothing and the shopper
    // already removed it. Refusing the basket here would punish them for it.
    expect(() => summariseAt([live(1, '2'), live(2, '2.5')], PRECISION)).toThrowError(expect.objectContaining({ code: 'order.cart_quantity_invalid' }));
    expect(summariseAt([live(1, '2'), { ...retracted(2, '2.5') }], PRECISION)[0]?.totalQuantity).toBe('2.0000');
  });

  it('needs no precision declaration for a stock key only retracted lines name', () => {
    const onlyRetractedKey = summariseAt([live(1, '2'), { ...retracted(2, '1'), productId: GIFT_CARD }], new Map([[KEY_A, tracked(0)]]));
    expect(onlyRetractedKey).toHaveLength(1);
    expect(onlyRetractedKey[0]?.stockKey).toBe(KEY_A);
  });
});

// Round 8, P3-02. The round-8 Challenger measured that this package accepted a
// retraction at `'2999-01-01T00:00:00Z'` while the relation's leg 8 refuses
// `NEW.retracted_at > now()`. One law stated twice, differently, is a law whose
// verdict depends on which layer the caller reaches first.
describe('summariseBasket — the reference instant', () => {
  const line = (retractedAt: string | null): CartLine => ({
    lineId: LINE(1),
    productId: PRODUCT_A,
    variantId: null,
    quantity: '2',
    retractedAt,
  });
  const live = (): CartLine => ({ ...line(null), lineId: LINE(2) });

  it('refuses a retraction at an instant that has not arrived', () => {
    expect(() => summariseBasket([live(), line('2999-01-01T00:00:00Z')], PRECISION, AS_OF)).toThrowError(
      expect.objectContaining({ code: 'order.cart_retraction_not_future' }),
    );
  });

  it('accepts a retraction at exactly the reference instant, because that instant HAS arrived', () => {
    const positions = summariseBasket([live(), line(AS_OF)], PRECISION, AS_OF);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.lineIds).toEqual([LINE(2)]);
  });

  it('is decided by the supplied instant and not by a clock, so the same basket moves with asOf', () => {
    const retractedLater = [live(), line('2026-10-12T18:00:00Z')] as const;
    // read at noon the retraction is in the future and refused ...
    expect(() => summariseBasket([...retractedLater], PRECISION, '2026-10-12T12:00:00Z')).toThrowError(
      expect.objectContaining({ code: 'order.cart_retraction_not_future' }),
    );
    // ... and read at midnight the same basket is lawful and the line is gone.
    expect(summariseBasket([...retractedLater], PRECISION, '2026-10-13T00:00:00Z')[0]?.lineIds).toEqual([LINE(2)]);
  });

  it('refuses a reference instant that is not canonical, including an absent one', () => {
    for (const bad of ['2026-10-12', '2026-10-12T12:00:00.000Z', '2026-10-12T12:00:00+02:00', '', 'now']) {
      expect(() => summariseBasket([live()], PRECISION, bad)).toThrowError(expect.objectContaining({ code: 'order.occurred_at_invalid' }));
    }
    expect(() => summariseBasket([live()], PRECISION, undefined as unknown as string)).toThrowError(
      expect.objectContaining({ code: 'order.occurred_at_invalid' }),
    );
  });

  it('judges the reference instant BEFORE the basket, so an empty basket and a bad instant cannot be confused', () => {
    expect(() => summariseBasket([], PRECISION, 'not-an-instant')).toThrowError(expect.objectContaining({ code: 'order.occurred_at_invalid' }));
  });
});
