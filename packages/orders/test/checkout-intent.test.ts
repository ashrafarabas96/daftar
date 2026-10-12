/**
 * The order → sale hand-off.
 *
 * The forbidden-field law is proved by MUTATION, once per entry in the list:
 * the field is injected into a built intent, the injection is asserted to have
 * landed (the key is really there before the check runs), and the refusal is
 * required to NAME that exact field. A `toThrow()` with no named subject would
 * pass just as well if the guard refused everything for an unrelated reason,
 * and a mutation that silently failed to apply would leave a green test over a
 * law that was never exercised.
 */
import { describe, expect, it } from 'vitest';
import {
  OrderError,
  SALE_FORBIDDEN_INTENT_FIELDS,
  SALE_MIRROR_MAX_LINES,
  SALE_MIRROR_NOTES_MAX_LENGTH,
  assertNoForbiddenIntentFields,
  buildCommercialQuote,
  buildSaleCommitIntent,
  quoteExpiryText,
  stockKeyOf,
  summariseBasket,
  type CartLine as CartLineInput,
  type CommercialQuote,
  type ConfirmedQuoteApproval,
  type OrderCheckoutFacts,
  type OrderQuoteConfirmationDto,
  type OrderSnapshot,
  type OrderState,
} from '../src';

const PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VARIANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LINE1 = '11111111-1111-4111-8111-111111111111';
const LINE2 = '22222222-2222-4222-8222-222222222222';
const SALE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WAREHOUSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CUSTOMER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const STAFF = '77777777-7777-4777-8777-777777777777';
const MANAGER = '88888888-8888-4888-8888-888888888888';

/** The honest cash path: the money changed hands, and a named person collected it. */
const CASH_COLLECTED = { kind: 'cash_collected_on_handover', collectedByUserId: STAFF } as const;
/** The only thing that turns canonical credit on, per order, with an authorizing human. */
const CREDIT_AUTHORIZED = { kind: 'authorized_customer_credit', authorizedByUserId: MANAGER } as const;

const KEY = stockKeyOf({ productId: PRODUCT, variantId: VARIANT });
const PRECISION = new Map([[KEY, 0]]);
const POSITIONS = summariseBasket(
  [
    { lineId: LINE1, productId: PRODUCT, variantId: VARIANT, quantity: '2' },
    { lineId: LINE2, productId: PRODUCT, variantId: VARIANT, quantity: '3' },
  ],
  PRECISION,
);

function snapshot(state: OrderState, saleId: string | null = null): OrderSnapshot {
  return { state, saleId, lastOccurredAt: '2026-10-01T09:00:00Z', transitionCount: 2, isTerminal: false };
}

const ORDER = '33333333-3333-4333-8333-333333333333';
const QUOTE_ID = '44444444-4444-4444-8444-444444444444';
const CONFIRMATION_ID = '55555555-5555-4555-8555-555555555555';

/**
 * The quote the shopper confirmed. It prices exactly the one merged position
 * the basket above produces, at the quantity that basket produces, with the
 * discount it grants — which is what every line of the intent is now checked
 * against.
 */
function quoteGranting(discountMinor: string): CommercialQuote {
  return buildCommercialQuote({
    quoteId: QUOTE_ID,
    orderId: ORDER,
    version: 1,
    currency: 'ILS',
    lines: [{ stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.0000', unitPriceMinor: '1000', discountMinor, lineTotalMinor: '5000' }],
    displayedTotalMinor: '5000',
    issuedAt: '2026-10-01T09:00:00Z',
    expiresAt: '2026-10-01T10:00:00Z',
  });
}

function approve(quote: CommercialQuote, asOf = '2026-10-01T09:30:00Z'): ConfirmedQuoteApproval {
  const confirmation: OrderQuoteConfirmationDto = {
    confirmationId: CONFIRMATION_ID,
    quoteId: quote.quoteId,
    orderId: quote.orderId,
    confirmedVersion: quote.version,
    confirmedAt: asOf,
    confirmedQuoteDigest: quote.digest,
    confirmedQuoteExpiresAt: quoteExpiryText(quote),
    confirmedByUserId: null,
  };
  return { quote, confirmation, asOf };
}

const QUOTE_NO_DISCOUNT = quoteGranting('0');
const APPROVAL = approve(QUOTE_NO_DISCOUNT);

const CASH: OrderCheckoutFacts = {
  orderId: ORDER,
  quoteApproval: APPROVAL,
  saleId: SALE,
  settlementMode: 'cash',
  settlementEvidence: CASH_COLLECTED,
  customerId: null,
  warehouseId: WAREHOUSE,
  documentDate: '2026-10-01',
  dueDate: null,
  taxMinor: '0',
  notes: null,
};

describe('buildSaleCommitIntent', () => {
  it('merges the basket into one line per stock key, carrying the first row id', () => {
    const intent = buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH);
    expect(intent.lines).toHaveLength(1);
    expect(intent.lines[0]?.lineId).toBe(LINE1);
    expect(intent.lines[0]?.quantity).toBe('5.0000');
    expect(intent.lines[0]?.variantId).toBe(VARIANT);
    expect(intent.lines[0]?.discountMinor).toBe('0');
  });

  it('builds from accepted and from fulfilling, and from nothing else', () => {
    // Enumerated with CREDIT evidence, because collected cash is admitted only
    // while fulfilling — see the handover law below.
    const credit = { ...CASH, settlementMode: 'credit' as const, settlementEvidence: CREDIT_AUTHORIZED, customerId: CUSTOMER };
    for (const state of ['accepted', 'fulfilling'] as OrderState[]) {
      expect(buildSaleCommitIntent(snapshot(state), POSITIONS, credit).saleId).toBe(SALE);
    }
    for (const state of ['placed', 'rejected', 'cancelled'] as OrderState[]) {
      expect(() => buildSaleCommitIntent(snapshot(state), POSITIONS, CASH)).toThrowError(expect.objectContaining({ code: 'order.checkout_state_invalid' }));
    }
  });

  it('refuses an order already bound to a sale — by state and by binding, independently', () => {
    for (const state of ['fulfilled', 'completed'] as OrderState[]) {
      expect(() => buildSaleCommitIntent(snapshot(state, SALE), POSITIONS, CASH)).toThrowError(
        expect.objectContaining({ code: 'order.checkout_state_invalid' }),
      );
    }
    // A snapshot whose STATE looks buildable but which already carries a sale is
    // refused too: the binding, not only the label, closes the checkout.
    expect(() => buildSaleCommitIntent(snapshot('accepted', SALE), POSITIONS, CASH)).toThrowError(
      expect.objectContaining({ code: 'order.checkout_state_invalid' }),
    );
  });

  it('refuses an empty position list', () => {
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), [], CASH)).toThrowError(expect.objectContaining({ code: 'order.cart_empty' }));
  });

  it('states the tax as zero and refuses any non-zero value rather than normalizing it', () => {
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH).taxMinor).toBe('0');
    for (const taxMinor of ['1', '-1', '0.00', '00', '']) {
      expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, taxMinor })).toThrowError(
        expect.objectContaining({ code: 'order.checkout_tax_policy_absent' }),
      );
    }
  });
});

describe('the credit laws (TL-P6-R3, TL-P6-R4) and the settlement-truth gate (section 25)', () => {
  it('refuses a credit checkout with no customer — an anonymous receivable is forbidden', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, settlementMode: 'credit', settlementEvidence: CREDIT_AUTHORIZED }),
    ).toThrowError(expect.objectContaining({ code: 'order.checkout_customer_required' }));
  });

  it('admits a credit checkout that names one and was authorized, with a due date on the document date', () => {
    const intent = buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
      ...CASH,
      settlementMode: 'credit',
      settlementEvidence: CREDIT_AUTHORIZED,
      customerId: CUSTOMER,
      dueDate: '2026-10-01',
    });
    expect(intent.settlementMode).toBe('credit');
    expect(intent.dueDate).toBe('2026-10-01');
  });

  it('refuses a credit CLAIM backed only by collected cash — the claim is never adopted on trust', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, settlementMode: 'credit', customerId: CUSTOMER, settlementEvidence: CASH_COLLECTED }),
    ).toThrowError(expect.objectContaining({ code: 'order.settlement_mode_unsupported' }));
  });

  it('refuses a cash CLAIM backed only by a credit authorization — and never silently corrects it', () => {
    // Silently adopting the evidence's mode would commit a receivable the
    // merchant never asked for. The refusal is the whole point.
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, customerId: CUSTOMER, settlementEvidence: CREDIT_AUTHORIZED }),
    ).toThrowError(expect.objectContaining({ code: 'order.settlement_mode_unsupported' }));
  });

  it('refuses a verified online payment: no merchant provider is integrated (section 31)', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, settlementEvidence: { kind: 'payment_verified', providerRef: 'ref-1' } }),
    ).toThrowError(expect.objectContaining({ code: 'order.payment_surface_not_integrated' }));
  });

  it('refuses a due date without a credit settlement, whichever side is missing', () => {
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, customerId: CUSTOMER, dueDate: '2026-10-02' })).toThrowError(
      expect.objectContaining({ code: 'order.checkout_customer_required' }),
    );
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
        ...CASH,
        settlementMode: 'credit',
        settlementEvidence: CREDIT_AUTHORIZED,
        dueDate: '2026-10-02',
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.checkout_customer_required' }));
  });

  it('admits a cash walk-in, because collected cash from a walk-in is a true fact', () => {
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH).customerId).toBeNull();
  });

  it('carries the ESTABLISHED mode into the intent, not the claimed one', () => {
    const intent = buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
      ...CASH,
      settlementMode: 'credit',
      settlementEvidence: CREDIT_AUTHORIZED,
      customerId: CUSTOMER,
    });
    expect(intent.settlementMode).toBe('credit');
  });
});

describe('the dates', () => {
  it.each(['2026-13-01', '2026-02-30', '2026-1-1', '20261001', ''])('refuses the impossible or non-canonical document date %s', (documentDate) => {
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, documentDate })).toThrowError(
      expect.objectContaining({ code: 'order.checkout_date_invalid' }),
    );
  });

  it('refuses a due date that precedes the document date', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
        ...CASH,
        settlementMode: 'credit',
        settlementEvidence: CREDIT_AUTHORIZED,
        customerId: CUSTOMER,
        dueDate: '2026-09-30',
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.checkout_date_invalid' }));
  });
});

describe('the discount request', () => {
  it('carries a stated request through untouched — no arithmetic happens here', () => {
    // The quote GRANTED 250, so 250 is what may be requested, and it is carried
    // verbatim: this module still performs no arithmetic on it.
    const granted = approve(quoteGranting('250'));
    const intent = buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
      ...CASH,
      quoteApproval: granted,
      discountMinorByStockKey: new Map([[KEY, '250']]),
    });
    expect(intent.lines[0]?.discountMinor).toBe('250');
  });

  it.each(['-1', '1.5', '01', ' 1', '1e2', ''])('refuses the discount request %s', (value) => {
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, discountMinorByStockKey: new Map([[KEY, value]]) })).toThrowError(
      expect.objectContaining({ code: 'order.checkout_field_forbidden' }),
    );
  });

  it('refuses a discount for a stock key the checkout does not carry', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
        ...CASH,
        discountMinorByStockKey: new Map([[stockKeyOf({ productId: PRODUCT, variantId: null }), '1']]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.availability_subject_unknown' }));
  });
});

describe('the forbidden-field law, proved by mutation', () => {
  it('has a non-empty subject set with no duplicates', () => {
    expect(SALE_FORBIDDEN_INTENT_FIELDS.length).toBeGreaterThan(20);
    expect(new Set(SALE_FORBIDDEN_INTENT_FIELDS).size).toBe(SALE_FORBIDDEN_INTENT_FIELDS.length);
  });

  it('passes the intent the builder actually produces', () => {
    const intent = buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH);
    expect(() => assertNoForbiddenIntentFields(intent)).not.toThrow();
  });

  for (const field of SALE_FORBIDDEN_INTENT_FIELDS) {
    it(`names ${field} when it appears on the header`, () => {
      const mutated = { ...buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH) } as Record<string, unknown>;
      mutated[field] = '1';
      // Prove the mutation landed before reading the verdict: a mutation that
      // did not apply would leave a green test over an unexercised law.
      expect(Object.keys(mutated)).toContain(field);
      try {
        assertNoForbiddenIntentFields(mutated);
        throw new Error(`the header carried ${field} and was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.checkout_field_forbidden');
        expect((error as OrderError).details?.field).toBe(field);
        expect((error as OrderError).details?.where).toBe('header');
      }
    });

    it(`names ${field} when it appears on a line`, () => {
      const intent = buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH);
      const line = { ...intent.lines[0] } as Record<string, unknown>;
      line[field] = '1';
      expect(Object.keys(line)).toContain(field);
      const mutated = { ...intent, lines: [line] };
      try {
        assertNoForbiddenIntentFields(mutated);
        throw new Error(`a line carried ${field} and was accepted`);
      } catch (error) {
        expect((error as OrderError).code).toBe('order.checkout_field_forbidden');
        expect((error as OrderError).details?.field).toBe(field);
        expect((error as OrderError).details?.where).toBe('lines[0]');
      }
    });
  }

  it('does not forbid the fields the sale command genuinely accepts', () => {
    for (const permitted of [
      'saleId',
      'settlementMode',
      'customerId',
      'warehouseId',
      'documentDate',
      'dueDate',
      'taxMinor',
      'notes',
      'lines',
      'discountMinor',
      'quantity',
      'productId',
      'variantId',
      'lineId',
    ]) {
      expect(SALE_FORBIDDEN_INTENT_FIELDS).not.toContain(permitted);
    }
  });
});

describe('the confirmed quote now guards the hand-off (challenger P1-01)', () => {
  // The challenger's measurement: `quote.ts` implemented section 27, PART 33's zero
  // tolerance and PART 34's half-open boundary, and NOTHING on the path that
  // produces a sale request called any of it. The laws held when invoked and
  // were invoked by nobody. These cases are the wiring, proved from the outside.

  it('refuses a discount the confirmed quote did not grant — the challenger exact probe', () => {
    try {
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, discountMinorByStockKey: new Map([[KEY, '999999999']]) });
      throw new Error('a discount of 999999999 minor units built against a quote that granted 0');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      expect((error as OrderError).code).toBe('order.quote_discount_unapproved');
      expect((error as OrderError).details?.granted).toBe('0');
      expect((error as OrderError).details?.requested).toBe('999999999');
    }
  });

  it('refuses a discount even one minor unit above what was granted', () => {
    const granted = approve(quoteGranting('250'));
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: granted, discountMinorByStockKey: new Map([[KEY, '251']]) }),
    ).toThrowError(expect.objectContaining({ code: 'order.quote_discount_unapproved' }));
    // And below it: a discount the shopper did not see is not a kindness, it is
    // a different transaction.
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: granted, discountMinorByStockKey: new Map([[KEY, '249']]) }),
    ).toThrowError(expect.objectContaining({ code: 'order.quote_discount_unapproved' }));
  });

  it('PART 34 — a checkout at the exact expiry instant is refused, and one second before is not', () => {
    const atExpiry = { ...CASH, quoteApproval: approve(QUOTE_NO_DISCOUNT, '2026-10-01T10:00:00Z') };
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, atExpiry)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
    const justBefore = { ...CASH, quoteApproval: approve(QUOTE_NO_DISCOUNT, '2026-10-01T09:59:59Z') };
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, justBefore).saleId).toBe(SALE);
  });

  it('PART 33 — a second attempt at a total the authority recomputed differently is refused HERE', () => {
    const diverged: ConfirmedQuoteApproval = { ...APPROVAL, priorRecomputedTotalMinor: '5001' };
    try {
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: diverged });
      throw new Error('an intent was rebuilt for a total of 5001 against a confirmed 5000');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_requires_reconfirmation');
      expect((error as OrderError).details?.differenceMinor).toBe('1');
    }
    // The exact total the shopper confirmed is the one that passes.
    expect(
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: { ...APPROVAL, priorRecomputedTotalMinor: '5000' } }).saleId,
    ).toBe(SALE);
  });

  it('refuses a quote that is not this order quote', () => {
    const foreign = approve(
      buildCommercialQuote({
        quoteId: QUOTE_ID,
        orderId: '66666666-6666-4666-8666-666666666666',
        version: 1,
        currency: 'ILS',
        lines: [
          { stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.0000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5000' },
        ],
        displayedTotalMinor: '5000',
        issuedAt: '2026-10-01T09:00:00Z',
        expiresAt: '2026-10-01T10:00:00Z',
      }),
    );
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: foreign })).toThrowError(
      expect.objectContaining({ code: 'order.quote_not_approved' }),
    );
  });

  it('refuses a checkout quantity that is not the quantity the shopper confirmed', () => {
    const forThree = approve(
      buildCommercialQuote({
        quoteId: QUOTE_ID,
        orderId: ORDER,
        version: 1,
        currency: 'ILS',
        lines: [
          { stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '3.0000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '3000' },
        ],
        displayedTotalMinor: '3000',
        issuedAt: '2026-10-01T09:00:00Z',
        expiresAt: '2026-10-01T10:00:00Z',
      }),
    );
    try {
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: forThree });
      throw new Error('a checkout of 5 built against a quote for 3');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_not_approved');
      expect((error as OrderError).details?.confirmed).toBe('3.0000');
      expect((error as OrderError).details?.checkout).toBe('5.0000');
    }
  });

  it('refuses a checkout whose positions the confirmed quote does not price', () => {
    const other = summariseBasket(
      [{ lineId: LINE1, productId: PRODUCT, variantId: null, quantity: '1' }],
      new Map([[stockKeyOf({ productId: PRODUCT, variantId: null }), 0]]),
    );
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS.concat(other), CASH)).toThrowError(
      expect.objectContaining({ code: 'order.quote_not_approved' }),
    );
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), other, CASH)).toThrowError(expect.objectContaining({ code: 'order.quote_not_approved' }));
  });

  it('refuses a checkout that commits FEWER positions than the quote priced', () => {
    // The only case the set-size check catches on its own: every position the
    // checkout carries agrees with its quoted line, and a quoted line is simply
    // not being committed — the basket changed after confirmation. Added because
    // the mutation that disabled that check did NOT turn the suite red, which
    // under PART 12 means the law was not proved.
    const twoLines = buildCommercialQuote({
      quoteId: QUOTE_ID,
      orderId: ORDER,
      version: 1,
      currency: 'ILS',
      lines: [
        { stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.0000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5000' },
        {
          stockKey: stockKeyOf({ productId: PRODUCT, variantId: null }),
          productId: PRODUCT,
          variantId: null,
          quantity: '1.0000',
          unitPriceMinor: '700',
          discountMinor: '0',
          lineTotalMinor: '700',
        },
      ],
      displayedTotalMinor: '5700',
      issuedAt: '2026-10-01T09:00:00Z',
      expiresAt: '2026-10-01T10:00:00Z',
    });
    try {
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: approve(twoLines) });
      throw new Error('a checkout of one position built against a quote that priced two');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_not_approved');
      expect((error as OrderError).details?.quotedLines).toBe('2');
      expect((error as OrderError).details?.positions).toBe('1');
    }
  });

  it('refuses a caller that carries no approval at all, at RUNTIME and not only in the types', () => {
    // A required field is a type-level law, and a type-level law reds the
    // typecheck while leaving the suite green. This is the executed path.
    const unapproved = { ...CASH } as Record<string, unknown>;
    delete unapproved.quoteApproval;
    expect(Object.keys(unapproved)).not.toContain('quoteApproval');
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, unapproved as unknown as OrderCheckoutFacts)).toThrowError(
      expect.objectContaining({ code: 'order.quote_not_approved' }),
    );
  });
});

describe('cash at handover is admissible only while fulfilling (challenger P2-03)', () => {
  it('refuses collected cash from an accepted order, where no handover has begun', () => {
    try {
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH);
      throw new Error('an accepted order produced a cash settlement with no handover');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.checkout_state_invalid');
      expect((error as OrderError).details?.evidenceKind).toBe('cash_collected_on_handover');
      expect((error as OrderError).details?.state).toBe('accepted');
    }
  });

  it('admits it while fulfilling, and admits authorized credit from accepted', () => {
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH).settlementMode).toBe('cash');
    const credit = { ...CASH, settlementMode: 'credit' as const, settlementEvidence: CREDIT_AUTHORIZED, customerId: CUSTOMER };
    expect(buildSaleCommitIntent(snapshot('accepted'), POSITIONS, credit).settlementMode).toBe('credit');
  });
});

describe('the mirror carries the authority CONSTRAINTS, not only its shape (challenger P2-04)', () => {
  it('states the two mirrored bounds as the values the authority states', () => {
    expect(SALE_MIRROR_MAX_LINES).toBe(200);
    expect(SALE_MIRROR_NOTES_MAX_LENGTH).toBe(1000);
  });

  it('refuses a note longer than the authority accepts — the 5000 character case', () => {
    try {
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, notes: 'x'.repeat(5000) });
      throw new Error('a 5000 character note built cleanly');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.checkout_notes_invalid');
      expect((error as OrderError).details?.trimmedLength).toBe('5000');
    }
  });

  it('refuses a note that is empty after trimming, and admits the bounds themselves', () => {
    for (const notes of ['', '   ', '\t\n']) {
      expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, notes })).toThrowError(
        expect.objectContaining({ code: 'order.checkout_notes_invalid' }),
      );
    }
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, notes: 'x' }).notes).toBe('x');
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, notes: 'x'.repeat(1000) }).notes).toHaveLength(1000);
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, notes: null }).notes).toBeNull();
  });

  it('refuses one line more than the authority accepts, and admits exactly that many', () => {
    const productOf = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const basketOf = (count: number): CartLineInput[] =>
      Array.from({ length: count }, (_unused, index) => ({
        lineId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
        productId: productOf(index),
        variantId: null,
        quantity: '1',
      }));
    const precisionOf = (count: number): Map<string, number> =>
      new Map(Array.from({ length: count }, (_unused, index) => [stockKeyOf({ productId: productOf(index), variantId: null }), 0] as const));
    const quoteFor = (count: number): CommercialQuote =>
      buildCommercialQuote({
        quoteId: QUOTE_ID,
        orderId: ORDER,
        version: 1,
        currency: 'ILS',
        lines: Array.from({ length: count }, (_unused, index) => ({
          stockKey: stockKeyOf({ productId: productOf(index), variantId: null }),
          productId: productOf(index),
          variantId: null,
          quantity: '1.0000',
          unitPriceMinor: '1000',
          discountMinor: '0',
          lineTotalMinor: '1000',
        })),
        displayedTotalMinor: String(count * 1000),
        issuedAt: '2026-10-01T09:00:00Z',
        expiresAt: '2026-10-01T10:00:00Z',
      });

    const atLimit = summariseBasket(basketOf(200), precisionOf(200));
    expect(buildSaleCommitIntent(snapshot('fulfilling'), atLimit, { ...CASH, quoteApproval: approve(quoteFor(200)) }).lines).toHaveLength(200);

    const overLimit = summariseBasket(basketOf(201), precisionOf(201));
    try {
      buildSaleCommitIntent(snapshot('fulfilling'), overLimit, { ...CASH, quoteApproval: approve(quoteFor(201)) });
      throw new Error('201 lines were accepted over a stated limit of 200');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.checkout_line_limit');
      expect((error as OrderError).details?.lines).toBe('201');
      expect((error as OrderError).details?.maxLines).toBe('200');
    }
  });
});

describe('the hand-off supplies the precisions it validated the basket with (round-3 challenge P2-02)', () => {
  it('refuses a quote line the product unit precision cannot represent', () => {
    // PRECISION above states this product is sold in whole units, and
    // `summariseBasket` was given that same map. The gate now claims the law
    // too, instead of relying on the basket module to fail closed one layer out.
    const halfUnitQuote = buildCommercialQuote({
      quoteId: QUOTE_ID,
      orderId: ORDER,
      version: 1,
      currency: 'ILS',
      lines: [
        { stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.5000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5500' },
      ],
      displayedTotalMinor: '5500',
      issuedAt: '2026-10-01T09:00:00Z',
      expiresAt: '2026-10-01T10:00:00Z',
    });
    expect(() =>
      buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, {
        ...CASH,
        quoteApproval: approve(halfUnitQuote),
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('still builds the honest checkout, with no precision field to supply', () => {
    expect(buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, CASH).saleId).toBe(SALE);
  });

  // Round-4 challenge R4-B: the obligation was POSSIBLE at the real entry point
  // but still OPTIONAL there, and nothing required the gate's map to BE the
  // basket's. The precisions are now read off the positions, so neither hole
  // has a shape left: there is no field to omit, and no second map to differ.
  it('reads the precision off the position, so no caller can substitute a different one', () => {
    const halfUnitQuote = buildCommercialQuote({
      quoteId: QUOTE_ID,
      orderId: ORDER,
      version: 1,
      currency: 'ILS',
      lines: [
        { stockKey: KEY, productId: PRODUCT, variantId: VARIANT, quantity: '5.5000', unitPriceMinor: '1000', discountMinor: '0', lineTotalMinor: '5500' },
      ],
      displayedTotalMinor: '5500',
      issuedAt: '2026-10-01T09:00:00Z',
      expiresAt: '2026-10-01T10:00:00Z',
    });
    // The position says whole units, and that is the only statement there is.
    expect(POSITIONS[0]?.unitDecimals).toBe(0);
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), POSITIONS, { ...CASH, quoteApproval: approve(halfUnitQuote) })).toThrowError(
      expect.objectContaining({ code: 'order.quote_quantity_invalid' }),
    );
    // A position that declares four decimals admits the same quantity. The law
    // follows the basket, not a field beside it.
    const atQ4 = summariseBasket([{ lineId: LINE1, productId: PRODUCT, variantId: VARIANT, quantity: '5.5000' }], new Map([[KEY, 4]]));
    expect(atQ4[0]?.unitDecimals).toBe(4);
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), atQ4, { ...CASH, quoteApproval: approve(halfUnitQuote) })).not.toThrow();
  });

  it('refuses a hand-built position that carries no precision at all', () => {
    // A type-only requirement has no runtime existence: without this guard the
    // derived map answers `undefined` for that key and the representability
    // check skips the line in silence, which is the defect class R4-B names.
    const noPrecision = [{ ...(POSITIONS[0] as (typeof POSITIONS)[number]) }] as unknown as typeof POSITIONS;
    delete (noPrecision[0] as { unitDecimals?: number }).unitDecimals;
    expect(() => buildSaleCommitIntent(snapshot('fulfilling'), noPrecision, CASH)).toThrowError(
      expect.objectContaining({ code: 'order.checkout_field_forbidden' }),
    );
  });
});
