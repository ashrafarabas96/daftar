/**
 * The coordinator's diff review of `3f56c62`, as cases.
 *
 * Every case here is a PLANT, not a shape: each one is the exact object the
 * review or the challenger built, and each asserts that the refusal NAMES its
 * subject. A `toThrow()` with no named code would pass just as well if the
 * package refused everything for an unrelated reason.
 *
 * Two families, and both are one shape — a field read more than once, or read
 * as a primitive without being one:
 *
 * - `B-1`, check-then-use: an own ACCESSOR answers the CHECK with one value and
 *   the USE with another. T1 through T6 are the review's own threats. Each one
 *   asserts the getter really does switch (the plant is proved to have landed)
 *   before asserting the refusal, so a case cannot pass because the plant
 *   failed to apply.
 * - `B-2`, coerced leaves: `RegExp#test` and `BigInt` stringify, so a boxed
 *   `String`, a `toString` object or a one-element array passed every amount,
 *   instant and currency check with an IDENTICAL digest. The boxed-currency fee
 *   rewrite is the coordinator's own red proof, from the freeze recheck.
 *
 * And `B-3`: the intent emitted the position's product with nothing tying it to
 * the confirmed line, so a position that kept the priced stock key but carried
 * another `productId` committed that other product at the confirmed price.
 *
 * THE GUARD-DELETION PROOF is the other half of each case and it is not in this
 * file: the mutations are recorded in `P6-MUTATIONS-ROUND22.json`, which names
 * the exact single-string replacement per guard and the titles below that red.
 * A case here that no mutation reds would be decoration.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OrderError,
  assertCommitWithinConfirmedQuote,
  assertQuoteApproved,
  assertQuoteIntact,
  assessQuoteDivergence,
  buildCommercialQuote,
  buildSaleCommitIntent,
  canonicalQuoteBytes,
  quoteExpiryText,
  stockKeyOf,
  summariseBasket,
  type CartLine as CartLineInput,
  type CommercialQuote,
  type CommercialQuoteChecks,
  type CommercialQuoteInput,
  type ConfirmedQuoteApproval,
  type OrderCheckoutFacts,
  type OrderQuoteConfirmationDto,
  type OrderSnapshot,
  type UnitPrecisionDeclaration,
} from '../src';

const PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PRODUCT = '99999999-9999-4999-8999-999999999999';
const VARIANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_VARIANT = '66666666-6666-4666-8666-666666666666';
const LINE1 = '11111111-1111-4111-8111-111111111111';
const LINE2 = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const QUOTE_ID = '44444444-4444-4444-8444-444444444444';
const CONFIRMATION_ID = '55555555-5555-4555-8555-555555555555';
const SALE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WAREHOUSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STAFF = '77777777-7777-4777-8777-777777777777';

const KEY = stockKeyOf({ productId: PRODUCT, variantId: VARIANT });
const tracked = (unitDecimals: number): UnitPrecisionDeclaration => ({ tracksInventory: true, unitDecimals });
const PRECISION = new Map([[KEY, tracked(0)]]);

const POSITIONS = summariseBasket(
  [
    { lineId: LINE1, productId: PRODUCT, variantId: VARIANT, quantity: '2', consumedByOrderId: null, retractedAt: null },
    { lineId: LINE2, productId: PRODUCT, variantId: VARIANT, quantity: '3', consumedByOrderId: null, retractedAt: null },
  ] as readonly CartLineInput[],
  PRECISION,
  '2026-10-12T12:00:00Z',
);

/** The quote the shopper confirmed: five units at 1000, less the discount it grants. */
function quoteGranting(discountMinor: string): CommercialQuote {
  const lineTotalMinor = (5000n - BigInt(discountMinor)).toString();
  return buildCommercialQuote({
    quoteId: QUOTE_ID,
    orderId: ORDER,
    version: 1,
    currency: 'ILS',
    lines: [{ stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.0000', unitPriceMinor: '1000', discountMinor, lineTotalMinor }],
    displayedTotalMinor: lineTotalMinor,
    issuedAt: '2026-10-01T09:00:00Z',
    expiresAt: '2026-10-01T10:00:00Z',
  });
}

/** `Q1` of the review's appendix: the quote that grants NOTHING. */
const CONFIRMED = quoteGranting('0');
/** `Q2`: the same ids and version, granting 4000 — the quote the shopper never confirmed. */
const UNCONFIRMED = quoteGranting('4000');

function confirmationFor(quote: CommercialQuote, asOf = '2026-10-01T09:30:00Z'): OrderQuoteConfirmationDto {
  return {
    confirmationId: CONFIRMATION_ID,
    quoteId: quote.quoteId,
    orderId: quote.orderId,
    confirmedVersion: quote.version,
    confirmedAt: asOf,
    confirmedQuoteDigest: quote.digest,
    confirmedQuoteExpiresAt: quoteExpiryText(quote),
    confirmedByUserId: null,
  };
}

const APPROVAL: ConfirmedQuoteApproval = { quote: CONFIRMED, confirmation: confirmationFor(CONFIRMED), asOf: '2026-10-01T09:30:00Z' };

function factsWith(approval: ConfirmedQuoteApproval): OrderCheckoutFacts {
  return {
    orderId: ORDER,
    quoteApproval: approval,
    saleId: SALE,
    settlementMode: 'cash',
    settlementEvidence: { kind: 'cash_collected_on_handover', collectedByUserId: STAFF },
    customerId: null,
    warehouseId: WAREHOUSE,
    documentDate: '2026-10-01',
    dueDate: null,
    taxMinor: '0',
    notes: null,
  };
}

const FULFILLING: OrderSnapshot = { state: 'fulfilling', saleId: null, lastOccurredAt: '2026-10-01T09:00:00Z', transitionCount: 2, isTerminal: false };

/**
 * Plant an own accessor that answers `first` once and `then` on every later
 * read, and prove it switched before the plant is used as evidence.
 */
function switching<T extends object>(carrier: T, field: keyof T & string, first: unknown, then: unknown): T {
  const planted: Record<string, unknown> = { ...(carrier as Record<string, unknown>) };
  delete planted[field];
  let reads = 0;
  Object.defineProperty(planted, field, {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? first : then;
    },
  });
  return planted as T;
}

/** The refusal an attempt produced, as an `OrderError`, or a failure naming what was accepted instead. */
function refusalOf(attempt: () => unknown, what: string): OrderError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof OrderError) return error;
    throw new Error(`${what} was refused, but not as an OrderError: ${String(error)}`);
  }
  throw new Error(`${what} was ACCEPTED`);
}

describe('B-1 — a field that answers the check and the use differently (coordinator diff review of 3f56c62)', () => {
  it('the plant itself switches, so every case below is evidence rather than hope', () => {
    const planted = switching(CONFIRMED, 'displayedTotalMinor', '5000', '999999');
    const descriptor = Object.getOwnPropertyDescriptor(planted, 'displayedTotalMinor');
    expect(descriptor?.get).toBeTypeOf('function');
    expect(planted.displayedTotalMinor).toBe('5000');
    expect(planted.displayedTotalMinor).toBe('999999');
  });

  it('T1 — an accessor on approval.quote cannot hand the intent a quote the gate never saw', () => {
    const planted = switching(APPROVAL, 'quote', CONFIRMED, UNCONFIRMED);
    const error = refusalOf(() => buildSaleCommitIntent(FULFILLING, POSITIONS, factsWith(planted)), 'an approval whose quote switches');
    expect(error.code).toBe('order.quote_not_approved');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.fields).toBe('quote');
  });

  it('T2 — the divergence verdict is not taken against a total that moved after the gate', () => {
    const planted = switching(APPROVAL, 'quote', CONFIRMED, UNCONFIRMED);
    const error = refusalOf(() => assessQuoteDivergence(planted, ORDER, '5000'), 'a divergence verdict over a switching quote');
    expect(error.code).toBe('order.quote_not_approved');
    expect(error.details?.carrier).toBe('accessor');
    const commit = refusalOf(() => assertCommitWithinConfirmedQuote(planted, ORDER, '5000'), 'a commit window over a switching quote');
    expect(commit.code).toBe('order.quote_not_approved');
  });

  it('T3 — a digest accessor cannot get an unconfirmed quote approved', () => {
    const planted = switching(CONFIRMED, 'digest', CONFIRMED.digest, 'b'.repeat(64));
    const error = refusalOf(() => assertQuoteIntact(planted), 'a quote whose digest switches');
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.fields).toBe('digest');
  });

  it('T4 — an expiresAt accessor cannot get an expired quote confirmed', () => {
    const expired = buildCommercialQuote({
      quoteId: QUOTE_ID,
      orderId: ORDER,
      version: 1,
      currency: 'ILS',
      lines: [
        { stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.0000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5000' },
      ],
      displayedTotalMinor: '5000',
      issuedAt: '2026-10-01T09:00:00Z',
      expiresAt: '2026-10-01T09:15:00Z',
    });
    const planted = switching(expired, 'expiresAt', '2099-01-01T00:00:00Z', '2026-10-01T09:15:00Z');
    const approval: ConfirmedQuoteApproval = { quote: planted, confirmation: confirmationFor(expired), asOf: '2026-10-01T09:30:00Z' };
    const error = refusalOf(() => assertQuoteApproved(approval, ORDER), 'an expired quote whose expiry switches');
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.fields).toBe('expiresAt');
  });

  it('T5 — a displayedTotalMinor accessor cannot defeat the zero tolerance', () => {
    const planted = switching(CONFIRMED, 'displayedTotalMinor', '5000', '999999');
    const approval: ConfirmedQuoteApproval = { quote: planted, confirmation: confirmationFor(CONFIRMED), asOf: '2026-10-01T09:30:00Z' };
    const error = refusalOf(() => assessQuoteDivergence(approval, ORDER, '5000'), 'a quote whose displayed total switches');
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.fields).toBe('displayedTotalMinor');
  });

  it('T6 — a position whose quantity switches cannot be compared at 5 and committed at 50', () => {
    const planted = [switching(POSITIONS[0] as (typeof POSITIONS)[number], 'totalQuantity', '5.0000', '50.0000')];
    const error = refusalOf(() => buildSaleCommitIntent(FULFILLING, planted, factsWith(APPROVAL)), 'a position whose quantity switches');
    expect(error.code).toBe('order.checkout_field_forbidden');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.field).toBe('totalQuantity');
    // The subject is the POSITION BY INDEX, not a stock key read off the object
    // being refused: describing a refusal with the attacker's own getter is how
    // a refusal ends up quoting the plant.
    expect(error.details?.position).toBe('0');
  });

  it('an accessor on a quote LINE is refused and names the line', () => {
    const lines = [switching(CONFIRMED.lines[0] as (typeof CONFIRMED.lines)[number], 'discountMinor', '0', '4000')];
    const error = refusalOf(() => assertQuoteIntact({ ...CONFIRMED, lines }), 'a line whose discount switches');
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.lineIndex).toBe('0');
    expect(error.details?.fields).toBe('discountMinor');
  });

  it('a lawful quote is still accepted, so the guard refuses nothing honest', () => {
    expect(() => assertQuoteIntact(CONFIRMED)).not.toThrow();
    expect(() => assertQuoteApproved(APPROVAL, ORDER)).not.toThrow();
    expect(() => buildSaleCommitIntent(FULFILLING, POSITIONS, factsWith(APPROVAL))).not.toThrow();
  });

  it('every gate hands back a snapshot the caller cannot change, which is the property the refusals do not depend on', () => {
    const snapshot = assertQuoteIntact(CONFIRMED);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lines)).toBe(true);
    expect(Object.isFrozen(snapshot.lines[0])).toBe(true);
    for (const value of Object.values(snapshot.lines[0] as unknown as Record<string, unknown>)) {
      expect(value === null || typeof value !== 'object').toBe(true);
    }
    const approved = assertQuoteApproved(APPROVAL, ORDER);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.quote)).toBe(true);
    expect(Object.isFrozen(approved.confirmation)).toBe(true);
    // And it is a COPY, not the caller's object: the gate accepting an object is
    // not a licence to keep reading that object.
    expect(approved.quote).not.toBe(APPROVAL.quote);
    expect(approved.confirmation).not.toBe(APPROVAL.confirmation);
  });
});

describe('B-2 — a leaf that is not a primitive (coordinator diff review and the freeze recheck)', () => {
  const LAWFUL: CommercialQuoteInput = {
    quoteId: QUOTE_ID,
    orderId: ORDER,
    version: 1,
    currency: 'ILS',
    lines: [{ stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.0000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5000' }],
    displayedTotalMinor: '5000',
    issuedAt: '2026-10-01T09:00:00Z',
    expiresAt: '2026-10-01T10:00:00Z',
  };

  /** The three coercion shapes, each of which `RegExp#test` and `BigInt` accept. */
  const shapes: readonly (readonly [string, (text: string) => unknown])[] = [
    ['a boxed String', (text) => new String(text)],
    ['a toString object', (text) => ({ toString: () => text })],
    ['a one-element array', (text) => [text]],
  ];

  for (const [label, box] of shapes) {
    it(`refuses ${label} where an amount belongs, naming the field`, () => {
      const error = refusalOf(() => buildCommercialQuote({ ...LAWFUL, displayedTotalMinor: box('5000') as string }), `${label} as displayedTotalMinor`);
      expect(error.code).toBe('order.quote_amount_invalid');
      expect(error.details?.field).toBe('displayedTotalMinor');
      expect(error.details?.carrier).toBe('not-primitive');
    });

    it(`refuses ${label} where a currency belongs, naming the field`, () => {
      const error = refusalOf(() => buildCommercialQuote({ ...LAWFUL, currency: box('ILS') as string }), `${label} as currency`);
      expect(error.code).toBe('order.quote_amount_invalid');
      expect(error.details?.field).toBe('currency');
    });

    it(`refuses ${label} where an instant belongs, naming the field`, () => {
      const error = refusalOf(() => buildCommercialQuote({ ...LAWFUL, issuedAt: box('2026-10-01T09:00:00Z') as string }), `${label} as issuedAt`);
      expect(error.code).toBe('order.occurred_at_invalid');
      expect(error.details?.field).toBe('issuedAt');
    });

    it(`refuses ${label} inside a LINE, naming the field`, () => {
      const first = LAWFUL.lines[0] as (typeof LAWFUL.lines)[number];
      const line = { ...first, unitPriceMinor: box('1000') as string };
      const error = refusalOf(() => buildCommercialQuote({ ...LAWFUL, lines: [line] }), `${label} as unitPriceMinor`);
      expect(error.code).toBe('order.quote_amount_invalid');
      expect(error.details?.field).toBe('unitPriceMinor');
    });
  }

  it("the coordinator's own red proof: a boxed currency carrying a fee, rewritten after the digest", () => {
    // `Object.assign(new String('ILS'), { documentFeeMinor: '500000' })` — the
    // leaf is an object, so the builder's shallow freeze never reached it, the
    // property could be rewritten to `999999999` AFTER the digest was taken, and
    // both gates still answered ACCEPTED. The digest equalled the digest of the
    // lawful all-string quote, which is what made it invisible.
    const boxed = Object.assign(new String('ILS'), { documentFeeMinor: '500000' });
    const error = refusalOf(() => buildCommercialQuote({ ...LAWFUL, currency: boxed as unknown as string }), 'a boxed currency carrying a fee');
    expect(error.code).toBe('order.quote_amount_invalid');
    expect(error.details?.field).toBe('currency');
    expect(error.details?.carrier).toBe('not-primitive');
  });

  it('and the digest of the boxed shape really did equal the lawful one, so the refusal is the only thing that separates them', () => {
    const boxed = { ...LAWFUL, currency: new String('ILS') as unknown as string };
    const lawfulBytes = canonicalQuoteBytes({ ...LAWFUL });
    const boxedBytes = canonicalQuoteBytes(boxed);
    expect(createHash('sha256').update(boxedBytes, 'utf8').digest('hex')).toBe(createHash('sha256').update(lawfulBytes, 'utf8').digest('hex'));
  });

  it('a quote whose leaves are all strings is accepted and comes back frozen through and through', () => {
    const quote = buildCommercialQuote(LAWFUL);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.lines[0])).toBe(true);
    expect(() => {
      (quote.lines[0] as unknown as Record<string, unknown>).unitPriceMinor = '1';
    }).toThrowError(TypeError);
  });

  // THE POST-DIGEST REWRITE, the challenger's fourth case, cannot be written the
  // way the finding was: the rewrite needed a leaf that was an OBJECT, and the
  // builder refuses one before a digest exists. My first attempt at it walked a
  // LAWFUL quote and asserted no leaf was an object — which is decoration, and
  // my own mutation said so: deleting `requirePrimitiveLeaf`'s refusal reds
  // NOTHING of it (M118), because a lawful quote has no object leaf however
  // many guards are gone. The attack form is below, where the leaf refusal is
  // the ONLY thing standing.
  //
  // The two reviewers' disagreement about the freeze is settled by the same
  // fact: `Object.freeze` was never the defect. The quote, its lines array and
  // each line WERE frozen at `3f56c62` (the challenger measured that and is
  // right); what was not frozen was the object a declared field POINTED AT (the
  // coordinator measured that and is right). With no object leaves admitted,
  // there is nothing left for a deeper freeze to do.
  //
  // These four run against the CONFIRMATION rather than the quote, and that is
  // the point: the quote's own fields are type-checked one by one in `quote.ts`,
  // so a boxed currency is refused there and `requirePrimitiveLeaf` never
  // answers. The measurement that says so is the one the challenger's `D-C`
  // corrected, and it is a better one than I first offered: the currency check
  // ALONE reds the four CURRENCY cases, the leaf refusal alone reds these four
  // CONFIRMATION cases, and the pair-drop reds all EIGHT — disjoint halves whose
  // union is the pair, which attributes each set to its own guard and shows both
  // load-bearing. My published figure for the pair was 4, taken from a tree that
  // carried only one of the row's two edits; the runner now asserts that every
  // edit landed before any figure is taken. A confirmation field has no such
  // individual check — the
  // snapshot of `CONFIRMATION_FIELDS` is all that stands between it and the
  // comparison, so here the leaf refusal is load-bearing and testable.
  const BOXED_CONFIRMATION_FIELDS: [string, (confirmation: OrderQuoteConfirmationDto) => OrderQuoteConfirmationDto][] = [
    ['confirmationId', (c) => ({ ...c, confirmationId: new String(c.confirmationId) as unknown as string })],
    ['confirmedQuoteDigest', (c) => ({ ...c, confirmedQuoteDigest: new String(c.confirmedQuoteDigest) as unknown as string })],
    ['confirmedVersion', (c) => ({ ...c, confirmedVersion: new Number(c.confirmedVersion) as unknown as number })],
    ['confirmedAt', (c) => ({ ...c, confirmedAt: { toString: () => '2026-10-01T09:30:00Z' } as unknown as string })],
  ];
  for (const [field, box] of BOXED_CONFIRMATION_FIELDS) {
    it(`a boxed ${field} on the CONFIRMATION is refused as a non-primitive, where only the snapshot's leaf check stands`, () => {
      const boxed = box(confirmationFor(CONFIRMED));
      // The plant is proved to have landed: the field stringifies to the lawful
      // value, so every comparison downstream would have agreed with it.
      expect(String((boxed as unknown as Record<string, unknown>)[field])).toBe(
        String((confirmationFor(CONFIRMED) as unknown as Record<string, unknown>)[field]),
      );
      expect(typeof (boxed as unknown as Record<string, unknown>)[field]).toBe('object');
      const error = refusalOf(() => assertQuoteApproved({ quote: CONFIRMED, confirmation: boxed, asOf: '2026-10-01T09:30:00Z' }, ORDER), `a boxed ${field}`);
      expect(error.code).toBe('order.quote_not_approved');
      expect(error.details?.carrier).toBe('not-primitive');
    });
  }
});

describe('B-3 — the product the sale commits is the product the quote priced', () => {
  it("the challenger's plant: the priced stock key with another product under it is refused by name", () => {
    const planted = [{ ...(POSITIONS[0] as (typeof POSITIONS)[number]), productId: OTHER_PRODUCT, variantId: OTHER_VARIANT }];
    const error = refusalOf(() => buildSaleCommitIntent(FULFILLING, planted, factsWith(APPROVAL)), 'a position carrying another product under the priced key');
    expect(error.code).toBe('order.quote_not_approved');
    // The position's own key must BE the key of its own product and variant, so
    // this is the refusal that fires first.
    expect(error.details?.expected).toBe(stockKeyOf({ productId: OTHER_PRODUCT, variantId: OTHER_VARIANT }));
  });

  it('a position whose key IS its own but whose VARIANT is not the quoted one is refused naming the variant', () => {
    // The reachable half of the identity comparison, and it exists because
    // `stockKeyOf` is `${productId}:${variantId ?? ''}` — so a variant of `''`
    // and a variant of `null` produce the SAME key. The position's key is
    // therefore self-consistent, the lookup matches the quoted line, and only
    // the field-by-field comparison can tell the two apart. A quote can never
    // carry `''` itself, because the builder id-checks a non-null variant.
    const keyWithoutVariant = stockKeyOf({ productId: PRODUCT, variantId: null });
    const quote = buildCommercialQuote({
      quoteId: QUOTE_ID,
      orderId: ORDER,
      version: 1,
      currency: 'ILS',
      lines: [
        {
          stockKey: keyWithoutVariant,
          productId: PRODUCT,
          variantId: null,
          quantity: '5.0000',
          unitPriceMinor: '1000',
          discountMinor: '0',
          lineTotalMinor: '5000',
        },
      ],
      displayedTotalMinor: '5000',
      issuedAt: '2026-10-01T09:00:00Z',
      expiresAt: '2026-10-01T10:00:00Z',
    });
    const positions = summariseBasket(
      [
        { lineId: LINE1, productId: PRODUCT, variantId: null, quantity: '2', consumedByOrderId: null, retractedAt: null },
        { lineId: LINE2, productId: PRODUCT, variantId: null, quantity: '3', consumedByOrderId: null, retractedAt: null },
      ] as readonly CartLineInput[],
      new Map([[keyWithoutVariant, tracked(0)]]),
      '2026-10-12T12:00:00Z',
    );
    const planted = [{ ...(positions[0] as (typeof positions)[number]), variantId: '' }];
    // The plant is proved to have landed: same key, different variant.
    const plant = planted[0] as (typeof planted)[number];
    expect(stockKeyOf({ productId: plant.productId, variantId: plant.variantId })).toBe(plant.stockKey);
    expect(quote.lines[0]?.variantId).toBeNull();
    const approval: ConfirmedQuoteApproval = { quote, confirmation: confirmationFor(quote), asOf: '2026-10-01T09:30:00Z' };
    const error = refusalOf(() => buildSaleCommitIntent(FULFILLING, planted, factsWith(approval)), 'a position whose variant is not the quoted one');
    expect(error.code).toBe('order.quote_not_approved');
    // The confirmed side is a real `null`; the committed side is the empty
    // string the plant carried. Both are printed as themselves, so the refusal
    // says which half moved rather than showing two identical keys.
    expect(error.details?.confirmed).toBe('null');
    expect(error.details?.committed).toBe('');
  });

  it('the lawful position still commits, and the intent carries the quoted identity', () => {
    const intent = buildSaleCommitIntent(FULFILLING, POSITIONS, factsWith(APPROVAL));
    expect(intent.lines[0]?.productId).toBe(PRODUCT);
    expect(intent.lines[0]?.variantId).toBe(VARIANT);
    expect(intent.lines[0]?.quantity).toBe('5.0000');
    expect(intent.lines[0]?.discountMinor).toBe('0');
  });

  it('ATTRIBUTION: a position canonical for its OWN product but priced by no quoted line is refused by the COVERAGE check, not by the identity comparison', () => {
    // The challenger asked for this one by name, and for the reason: without it,
    // the new identity comparison gets credited with a refusal it does not make.
    // This position's key IS `stockKeyOf` of its own product and variant, so the
    // self-consistency leg passes; the quote simply never priced it, so the
    // lookup misses and the coverage refusal answers FIRST. The two are told
    // apart by their details, since they share `order.quote_not_approved`:
    // coverage names only the `stockKey` it could not find, while the identity
    // comparison names `confirmed` and `committed`.
    const otherKey = stockKeyOf({ productId: OTHER_PRODUCT, variantId: null });
    const unpriced = summariseBasket(
      [{ lineId: LINE1, productId: OTHER_PRODUCT, variantId: null, quantity: '1', consumedByOrderId: null, retractedAt: null }] as readonly CartLineInput[],
      new Map([[otherKey, tracked(0)]]),
      '2026-10-12T12:00:00Z',
    );
    const position = unpriced[0] as (typeof unpriced)[number];
    // The plant is proved to have landed: the key is canonical for ITSELF.
    expect(stockKeyOf({ productId: position.productId, variantId: position.variantId })).toBe(position.stockKey);
    expect(CONFIRMED.lines.some((line) => line.stockKey === position.stockKey)).toBe(false);
    const error = refusalOf(() => buildSaleCommitIntent(FULFILLING, unpriced, factsWith(APPROVAL)), 'a self-consistent position no quoted line priced');
    expect(error.code).toBe('order.quote_not_approved');
    expect(error.details?.stockKey).toBe(otherKey);
    expect(error.details?.confirmed).toBeUndefined();
    expect(error.details?.committed).toBeUndefined();
    expect(error.details?.expected).toBeUndefined();
  });
});

describe('B-4(2) — a line that is not a plain object is refused, not skipped', () => {
  it('a FUNCTION-object line carrying a document fee is refused by name, where it used to be accepted with the fee dropped', () => {
    // `typeof` a function is `'function'`, and the input loop skipped any line
    // that was not `'object'` — so this line walked past the per-line guard and
    // past the fee refusal, and the fee was silently dropped. That is the exact
    // thing `ACC-REQ-P6-03` and the pack claimed could not happen, which is why
    // the coordinator counted it as a FALSE CLAIM and not only as a gap.
    const lawful = {
      stockKey: KEY,
      productId: PRODUCT,
      variantId: VARIANT,
      quantity: '5.0000',
      unitPriceMinor: '1000',
      discountMinor: '0',
      lineTotalMinor: '5000',
    };
    const asFunction = Object.assign(function lineCarrier() {}, lawful, { documentFeeMinor: '500000' });
    // The plant is proved to have landed: it really is a function, and it really
    // carries the fee.
    expect(typeof asFunction).toBe('function');
    expect((asFunction as unknown as Record<string, string>).documentFeeMinor).toBe('500000');
    const error = refusalOf(
      () =>
        buildCommercialQuote({
          quoteId: QUOTE_ID,
          orderId: ORDER,
          version: 1,
          currency: 'ILS',
          lines: [asFunction as unknown as CommercialQuoteInput['lines'][number]],
          displayedTotalMinor: '5000',
          issuedAt: '2026-10-01T09:00:00Z',
          expiresAt: '2026-10-01T10:00:00Z',
        }),
      'a function-object line carrying a document fee',
    );
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.lineIndex).toBe('0');
    // THE SUBJECT MATTERS, and my own mutation proved why: with the loop
    // reverted to the old `continue`, this case still went green, because the
    // carrier copy refuses a function-prototype line one layer later — so the
    // case was passing on a guard other than the one it names, and a reader
    // would have believed the INPUT refusal was tested when it was not. The
    // refusal is therefore pinned to the input stage by its own subject.
    expect(error.message).toContain('a quote input LINE');
    expect(error.details?.prototype).toBe('not Object.prototype');
  });

  it('a line that is a NUMBER, a string or a symbol is refused by name rather than skipped', () => {
    const base = {
      quoteId: QUOTE_ID,
      orderId: ORDER,
      version: 1,
      currency: 'ILS',
      displayedTotalMinor: '5000',
      issuedAt: '2026-10-01T09:00:00Z',
      expiresAt: '2026-10-01T10:00:00Z',
    };
    for (const [label, line] of [
      ['a number', 7],
      ['a string', 'line'],
      ['a symbol', Symbol('line')],
      ['null', null],
    ] as readonly (readonly [string, unknown])[]) {
      const error = refusalOf(() => buildCommercialQuote({ ...base, lines: [line] as unknown as CommercialQuoteInput['lines'] }), `${label} as a quote line`);
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.message).toContain('a quote input LINE');
      expect(error.details?.lineIndex).toBe('0');
    }
  });
});

describe('the unguarded objects and the unnamed refusals (R-C2, R-C3, R-C4)', () => {
  it('R-C4 — a null quote and a null line are REFUSED by name rather than crashing', () => {
    const nullQuote = refusalOf(() => assertQuoteIntact(null as unknown as CommercialQuote), 'a null quote');
    expect(nullQuote.code).toBe('order.quote_field_undeclared');
    const nullLine = refusalOf(() => assertQuoteIntact({ ...CONFIRMED, lines: [null] as unknown as CommercialQuote['lines'] }), 'a null line');
    expect(nullLine.code).toBe('order.quote_field_undeclared');
  });

  it('R-C3 / C9 — a confirmation carrying an undeclared field is refused, not quietly ignored', () => {
    const confirmation = { ...confirmationFor(CONFIRMED), documentFeeMinor: '500000' } as unknown as OrderQuoteConfirmationDto;
    const error = refusalOf(() => assertQuoteApproved({ ...APPROVAL, confirmation }, ORDER), 'a confirmation carrying a fee');
    expect(error.code).toBe('order.quote_not_approved');
    expect(error.details?.fields).toBe('documentFeeMinor');
  });

  it('R-C3 — a Proxy as the approval and a Proxy as the confirmation are both refused', () => {
    const asProxy = refusalOf(() => assertQuoteApproved(new Proxy(APPROVAL, {}), ORDER), 'a Proxy approval');
    expect(asProxy.code).toBe('order.quote_not_approved');
    expect(asProxy.details?.carrier).toBe('proxy');
    const confirmation = new Proxy(confirmationFor(CONFIRMED), {});
    const inner = refusalOf(() => assertQuoteApproved({ ...APPROVAL, confirmation }, ORDER), 'a Proxy confirmation');
    expect(inner.code).toBe('order.quote_not_approved');
  });

  it('R-C2 — a sparse array with an enormous length is refused by the BOUND, before anything walks it', () => {
    // Twenty bytes of input used to cost 23 seconds and end in an unnamed
    // RangeError, because the guard built a Set of every index key before any
    // limit was consulted. The bound comes first now, so this case is also a
    // measurement: it has to return fast.
    const huge = new Array<unknown>(2e7);
    const started = process.hrtime.bigint();
    const error = refusalOf(() => assertQuoteIntact({ ...CONFIRMED, lines: huge as unknown as CommercialQuote['lines'] }), 'a 2e7-position lines array');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("the challenger's REJECT at a869aab — the leaf the remedy itself left unchecked, and a law dropped by a typo", () => {
  it('C-A: a boxed asOf carrying an undeclared field is refused, where it used to be accepted AND handed back by reference', () => {
    // Measured by the independent challenger at `a869aab`, inside the remedy's
    // own return value: `isCanonicalInstant` runs a regex, a regex stringifies,
    // so this passed every window comparison; the returned approval was frozen
    // but its `asOf` was the caller's live object, and rewriting that object
    // after the gate returned changed what the approval carried.
    const boxed = Object.assign(new String('2026-10-01T09:30:00Z'), { documentFeeMinor: '500000' });
    // The plant is proved to have landed: it stringifies to the lawful instant,
    // so every comparison downstream would have agreed with it.
    expect(String(boxed)).toBe('2026-10-01T09:30:00Z');
    expect(typeof boxed).toBe('object');
    const error = refusalOf(
      () => assertQuoteApproved({ quote: CONFIRMED, confirmation: confirmationFor(CONFIRMED), asOf: boxed as unknown as string }, ORDER),
      'a boxed asOf',
    );
    expect(error.code).toBe('order.occurred_at_invalid');
  });

  it("C-A: the approval the gate returns carries asOf as a frozen PRIMITIVE, so a caller's reference cannot reach it", () => {
    const approval: ConfirmedQuoteApproval = { quote: CONFIRMED, confirmation: confirmationFor(CONFIRMED), asOf: '2026-10-01T09:30:00Z' };
    const approved = assertQuoteApproved(approval, ORDER);
    expect(typeof approved.asOf).toBe('string');
    expect(Object.isFrozen(approved)).toBe(true);
    // The comment at that `return` claims nothing in the returned object can
    // change under a caller that holds it. This is that claim, as an assertion:
    // every value the approval hands back is a primitive or a frozen object.
    for (const [field, value] of Object.entries(approved)) {
      if (value !== null && typeof value === 'object') expect(Object.isFrozen(value), `${field} is handed back unfrozen`).toBe(true);
    }
  });

  it('C-E: an undeclared field on the APPROVAL itself is refused by name, as it already was on the confirmation', () => {
    const error = refusalOf(
      () =>
        assertQuoteApproved(
          {
            quote: CONFIRMED,
            confirmation: confirmationFor(CONFIRMED),
            asOf: '2026-10-01T09:30:00Z',
            documentFeeMinor: '500000',
          } as unknown as ConfirmedQuoteApproval,
          ORDER,
        ),
      'an approval carrying a document fee',
    );
    expect(error.code).toBe('order.quote_not_approved');
    expect(error.details?.fields).toBe('documentFeeMinor');
  });

  const WHOLE_UNITS = new Map([[KEY, { tracksInventory: true, unitDecimals: 0 } as UnitPrecisionDeclaration]]);
  const HALF_UNIT: CommercialQuoteInput = {
    quoteId: QUOTE_ID,
    orderId: ORDER,
    version: 1,
    currency: 'ILS',
    lines: [{ stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.5000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5500' }],
    displayedTotalMinor: '5500',
    issuedAt: '2026-10-01T09:00:00Z',
    expiresAt: '2026-10-01T10:00:00Z',
  };

  it('C-B: the correct key refuses half a whole unit — the law this typo used to drop', () => {
    const error = refusalOf(() => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: WHOLE_UNITS }), 'half a unit of a whole-unit product');
    expect(error.code).toBe('order.quote_quantity_invalid');
    expect(error.details?.stated).toBe('5.5000');
  });

  it('C-B: a MISSPELLED key on checks is refused by name, naming both what was sent and what is read', () => {
    // One letter. It was indistinguishable from no `checks` at all, so the same
    // quantity was refused with the correct key and ACCEPTED with the typo, at
    // the same digest — a law not claimed rather than answered wrongly.
    const error = refusalOf(
      () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockkey: WHOLE_UNITS } as unknown as CommercialQuoteChecks),
      'a misspelled checks key',
    );
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.fields).toBe('unitPrecisionByStockkey');
    expect(error.details?.expected).toBe('unitPrecisionByStockKey');
  });

  it('C-B: a plain object where the declaration MAP belongs is refused, because get() for no key is the same silent omission', () => {
    const error = refusalOf(
      () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: { get: () => undefined } } as unknown as CommercialQuoteChecks),
      'a plain object instead of a Map',
    );
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.fields).toBe('unitPrecisionByStockKey');
  });

  it('C-B: saying "check nothing" is still lawful, by absence or by an empty object', () => {
    // The cost of the refusal, stated as a case: a caller that genuinely states
    // no law must stay accepted, or the guard has quietly become a requirement.
    expect(buildCommercialQuote(HALF_UNIT).lines[0]?.quantity).toBe('5.5000');
    expect(buildCommercialQuote(HALF_UNIT, {}).lines[0]?.quantity).toBe('5.5000');
  });

  it('E-A: a container KEY that is not a string is refused by name, with the type it was', () => {
    // The challenger's round-26 finding: the previous remedy made the lookup
    // honest about the VALUE and left the KEY unchecked, so each of these
    // dropped the whole unit-precision law at the no-`checks` digest.
    const shapes: [string, unknown][] = [
      ['object', new String(KEY)],
      ['number', 7],
      ['symbol', Symbol(KEY)],
    ];
    for (const [keyType, key] of shapes) {
      const error = refusalOf(
        () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: new Map([[key, WHOLE_UNITS.get(KEY)]]) } as unknown as CommercialQuoteChecks),
        `a ${keyType} key`,
      );
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.details?.keyType).toBe(keyType);
    }
  });

  it('E-A: a container that prices NO line of this quote is refused, which is what a type check cannot reach', () => {
    const whole = WHOLE_UNITS.get(KEY);
    if (whole === undefined) throw new Error('the fixture must declare the whole-unit product');
    // The wrongly SHAPED key — right product, wrong case or a trailing space —
    // and another product's key entirely. A type check admits all three, and the
    // mirror of `checkout-intent`'s coverage refusal is what catches them.
    for (const key of [`${KEY} `, KEY.toUpperCase(), stockKeyOf({ productId: OTHER_PRODUCT, variantId: null })]) {
      const error = refusalOf(
        () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: new Map([[key, whole]]) }),
        `a key this quote does not price: ${key}`,
      );
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.details?.declared).toBe('1');
      expect(error.details?.priced).toBe('1');
    }
  });

  it('E-A: the COST of that rule, stated as cases — a superset still applies the law, and saying nothing stays lawful', () => {
    // A caller holding one precision map for several quotes is refused only when
    // NOTHING in it matches; a map that covers this quote and more is accepted
    // and the law it states for the priced line is applied.
    const superset = new Map(WHOLE_UNITS);
    superset.set(stockKeyOf({ productId: OTHER_PRODUCT, variantId: null }), { tracksInventory: false, unitDecimals: null });
    const error = refusalOf(() => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: superset }), 'a superset container');
    expect(error.code).toBe('order.quote_quantity_invalid');
    // And "check nothing" is still lawful two ways, which is the half a guard
    // like this is most likely to break.
    expect(buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: new Map() }).lines[0]?.quantity).toBe('5.5000');
    expect(buildCommercialQuote(HALF_UNIT).lines[0]?.quantity).toBe('5.5000');
  });

  it('E-A: the no-MATCH rule does NOT run on the re-verification path, where another refusal owns that fact', () => {
    // The scoping is measured, not assumed: applying it there made the sales
    // authority's own coverage refusal answer under a different code and
    // reddened two accepted cases. `assertQuoteIntact` therefore accepts a
    // container that prices no line of the quote — the KEY TYPE check still
    // runs on both paths — and the two coverage cases in this file and in
    // `checkout-intent.test.ts` are what hold the other half.
    const whole = WHOLE_UNITS.get(KEY);
    if (whole === undefined) throw new Error('the fixture must declare the whole-unit product');
    const elsewhere = new Map([[stockKeyOf({ productId: OTHER_PRODUCT, variantId: null }), whole]]);
    expect(assertQuoteIntact(CONFIRMED, { unitPrecisionByStockKey: elsewhere }).digest).toBe(CONFIRMED.digest);
    const error = refusalOf(
      () => assertQuoteIntact(CONFIRMED, { unitPrecisionByStockKey: new Map([[7, WHOLE_UNITS.get(KEY)]]) } as unknown as CommercialQuoteChecks),
      'a numeric key on the re-verification path',
    );
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.keyType).toBe('number');
  });

  it('E-A: the BASKET path refuses a non-string key too, under its own code', () => {
    const error = refusalOf(
      () =>
        summariseBasket(
          [{ lineId: LINE1, productId: PRODUCT, variantId: VARIANT, quantity: '2', consumedByOrderId: null, retractedAt: null }] as readonly CartLineInput[],
          new Map([[7, { tracksInventory: true, unitDecimals: 0 }]]) as unknown as ReadonlyMap<string, UnitPrecisionDeclaration>,
          '2026-10-12T12:00:00Z',
        ),
      'a numeric key on the basket path',
    );
    expect(error.code).toBe('order.unit_precision_invalid');
    expect(error.details?.keyType).toBe('number');
  });

  it("D-B: the snapshot's own COST, stated as cases — an extra field and a half-stated declaration are both refused", () => {
    // The challenger named both as residuals with no case. They are the right
    // direction and they are a BEHAVIOUR CHANGE, so they are pinned rather than
    // left to be discovered: a declaration carrying one extra field used to
    // reach the law and now does not.
    const extra = refusalOf(
      () =>
        buildCommercialQuote(HALF_UNIT, {
          unitPrecisionByStockKey: new Map([[KEY, { tracksInventory: true, unitDecimals: 0, unitCode: 'kg' } as unknown as UnitPrecisionDeclaration]]),
        }),
      'a declaration carrying an undeclared field',
    );
    expect(extra.code).toBe('order.unit_precision_invalid');
    expect(extra.details?.carrier).toBe('undeclared');
    expect(extra.details?.field).toBe('unitCode');
    const half = refusalOf(
      () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: new Map([[KEY, { tracksInventory: true } as unknown as UnitPrecisionDeclaration]]) }),
      'a declaration stating only half the law',
    );
    expect(half.code).toBe('order.unit_precision_invalid');
    expect(half.details?.carrier).toBe('not-primitive');
    expect(half.details?.field).toBe('unitDecimals');
  });

  it('D-A: a container that is not a Map at all is refused up front, null and a number alike', () => {
    // The old check refused these as a side effect of `instanceof`; the new one
    // states them, and the case exists because the first guard-deletion run
    // found this refusal UNTESTED rather than masked.
    for (const container of [null, 7, 'a map']) {
      const error = refusalOf(
        () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: container as unknown as Map<string, UnitPrecisionDeclaration> }),
        `a container that is ${String(container)}`,
      );
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.details?.fields).toBe('unitPrecisionByStockKey');
      expect(error.details?.carrier).toBe('not-map');
    }
  });

  it('D-A: a Map with an own get cannot answer for what the map HOLDS, so the law still applies', () => {
    // The challenger's shape, and the plant is proved to have landed before the
    // refusal is asserted: the container's own `get` really does answer
    // `undefined` for the key the map holds, and the whole-unit law is applied
    // anyway, because the lookup is the intrinsic one.
    const ownGet = new Map(WHOLE_UNITS);
    Object.defineProperty(ownGet, 'get', { value: () => undefined });
    expect(ownGet.get(KEY)).toBeUndefined();
    expect(ownGet instanceof Map).toBe(true);
    const error = refusalOf(() => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: ownGet }), 'a Map with an own get');
    expect(error.code).toBe('order.quote_quantity_invalid');
    expect(error.details?.stated).toBe('5.5000');
  });

  it('D-A: a Map SUBCLASS overriding get cannot either, which instanceof could never have caught', () => {
    class Forgetful extends Map<string, UnitPrecisionDeclaration> {
      override get(_key: string): UnitPrecisionDeclaration | undefined {
        return undefined;
      }
    }
    const subclass = new Forgetful(WHOLE_UNITS);
    expect(subclass.get(KEY)).toBeUndefined();
    expect(subclass instanceof Map).toBe(true);
    const error = refusalOf(() => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: subclass }), 'a Map subclass');
    expect(error.code).toBe('order.quote_quantity_invalid');
    expect(error.details?.stated).toBe('5.5000');
  });

  it('D-A: a PROXY over a real Map is refused as a container, naming the proxy', () => {
    // `instanceof` goes through the `getPrototypeOf` trap, so this one passed
    // the old check with a real Map behind it. It is refused rather than read
    // through: every field of a Proxy can answer twice, which is this package's
    // oldest law and it simply did not reach the VALUE of a declared field.
    const behind = new Map(WHOLE_UNITS);
    const proxied = new Proxy(behind, {
      get: (target, key) => (key === 'get' ? () => undefined : (Reflect.get(target, key) as unknown)),
    });
    expect(proxied instanceof Map).toBe(true);
    const error = refusalOf(
      () => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: proxied as unknown as Map<string, UnitPrecisionDeclaration> }),
      'a Proxy over a real Map',
    );
    expect(error.code).toBe('order.quote_field_undeclared');
    expect(error.details?.fields).toBe('unitPrecisionByStockKey');
    expect(error.details?.carrier).toBe('proxy');
  });

  it('D-B: a unitDecimals ACCESSOR is refused, and the control shows what it would otherwise have bought', () => {
    // It answered `0` to every check and `4` to the read whose value is
    // RETURNED — five reads, measured — so a whole-unit product accepted
    // `5.5000` at the digest a quote with no `checks` produces. The box was
    // never the escape: `Number.isInteger` does not coerce.
    let reads = 0;
    const switching = {
      tracksInventory: true,
      get unitDecimals(): number {
        reads += 1;
        return reads >= 5 ? 4 : 0;
      },
    } as unknown as UnitPrecisionDeclaration;
    const error = refusalOf(() => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: new Map([[KEY, switching]]) }), 'an accessor unit precision');
    expect(error.code).toBe('order.unit_precision_invalid');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.stockKey).toBe(KEY);
    // The refusal is reached with NO read of the accessor at all, which is the
    // point of a snapshot: the switch never gets a turn.
    expect(reads).toBe(0);
  });

  it('D-B: a tracksInventory ACCESSOR is refused, where the honest object it imitates is refused by the LAW', () => {
    const switching = {
      unitDecimals: null,
      get tracksInventory(): boolean {
        return true;
      },
    } as unknown as UnitPrecisionDeclaration;
    const error = refusalOf(() => buildCommercialQuote(HALF_UNIT, { unitPrecisionByStockKey: new Map([[KEY, switching]]) }), 'an accessor tracksInventory');
    expect(error.code).toBe('order.unit_precision_invalid');
    expect(error.details?.carrier).toBe('accessor');
    // The control: the same two values as OWN DATA are refused under the
    // catalogue's own law, which is what the accessor was for — answering
    // `true` to the `typeof` check and `false` to the law admitted a TRACKED
    // product with no precision at all.
    const honest = refusalOf(
      () =>
        buildCommercialQuote(HALF_UNIT, {
          unitPrecisionByStockKey: new Map([[KEY, { tracksInventory: true, unitDecimals: null } as UnitPrecisionDeclaration]]),
        }),
      'a tracked product declaring no precision',
    );
    expect(honest.code).toBe('order.unit_precision_required');
  });

  it('D-B: the BASKET path reads a declaration the same way, where the flag is recorded a third time', () => {
    // Found by taking `D-B` to its sibling rather than waiting to be shown it:
    // `summariseBasket` reads `tracksInventory` for the law and records it on
    // the position, so an accessor could put a flag on a position that is not
    // the flag the law was applied to — and the position is what checkout
    // reads.
    const switching = {
      unitDecimals: 0,
      get tracksInventory(): boolean {
        return true;
      },
    } as unknown as UnitPrecisionDeclaration;
    const error = refusalOf(
      () =>
        summariseBasket(
          [{ lineId: LINE1, productId: PRODUCT, variantId: VARIANT, quantity: '2', consumedByOrderId: null, retractedAt: null }] as readonly CartLineInput[],
          new Map([[KEY, switching]]),
          '2026-10-12T12:00:00Z',
        ),
      'an accessor declaration on the basket path',
    );
    expect(error.code).toBe('order.unit_precision_invalid');
    expect(error.details?.carrier).toBe('accessor');
    expect(error.details?.lineId).toBe(LINE1);
  });

  it('C-F: more positions than the authority accepts are refused BY ITS OWN CODE, before the container is walked', () => {
    // The bound moved earlier and the refusal did not change: `C-F` asked for
    // the ordering, and PART 16 forbids the code changing with it. The
    // attribution matters — if this came back as a carrier fault, the sales
    // authority's limit would have silently become a shape complaint.
    const one = POSITIONS[0] as (typeof POSITIONS)[number];
    const tooMany = Array.from({ length: 201 }, () => one);
    const error = refusalOf(() => buildSaleCommitIntent(FULFILLING, tooMany, factsWith(APPROVAL)), '201 positions');
    expect(error.code).toBe('order.checkout_line_limit');
    expect(error.details?.lines).toBe('201');
    expect(error.details?.maxLines).toBe('200');
    expect(error.details?.carrier).toBeUndefined();
  });

  it('C-F: the bound runs BEFORE the walk, proved by which refusal answers when both would fire', () => {
    // The ordering is the whole of `C-F`, and asserting the line-limit refusal
    // alone does not prove it: without the bound, the later length check
    // refuses with the same code and the same details, so that case stayed
    // green with the guard deleted (M126, 0 red, published). What distinguishes
    // the two is WHICH refusal answers when the container is both over-long
    // AND carries a malformed position. With the bound before the walk the
    // limit answers; without it, position 5 is reached first and the refusal
    // becomes a shape complaint.
    const one = POSITIONS[0] as (typeof POSITIONS)[number];
    const tooMany: unknown[] = Array.from({ length: 201 }, () => one);
    tooMany[5] = { ...one, totalQuantity: { toString: () => '5.0000' } };
    const error = refusalOf(
      () => buildSaleCommitIntent(FULFILLING, tooMany as readonly (typeof one)[], factsWith(APPROVAL)),
      '201 positions, one of them malformed',
    );
    expect(error.code).toBe('order.checkout_line_limit');
    expect(error.details?.lines).toBe('201');
    expect(error.details?.position).toBeUndefined();
  });

  it('C-D: a built quote hands back a frozen lines array and frozen lines — the builder\u2019s freeze, not the snapshot\u2019s inner one', () => {
    // Named precisely, because my first version of this case claimed to test
    // the snapshot's INNER array freeze and did not. That freeze covers one
    // field, `lineIds` on a checkout position, which is internal to
    // `buildSaleCommitIntent` and reaches no exported surface, so NO case can
    // observe it at this head: M127 is published as a zero that is
    // UNOBSERVABLE rather than merely untested. What is asserted here is the
    // builder's own freeze, which M109 and M110 red.
    const approved = assertQuoteApproved({ quote: CONFIRMED, confirmation: confirmationFor(CONFIRMED), asOf: '2026-10-01T09:30:00Z' }, ORDER);
    expect(Object.isFrozen(approved.quote.lines)).toBe(true);
    expect(() => {
      (approved.quote.lines as unknown as unknown[]).push({});
    }).toThrowError(TypeError);
    expect(Object.isFrozen(approved.quote.lines[0])).toBe(true);
  });
});
