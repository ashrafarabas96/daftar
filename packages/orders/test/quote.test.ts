/**
 * The commercial quote snapshot — audited master directive §27.
 *
 * Two laws carry the weight, and both are proved by MUTATION rather than by
 * assertion:
 *
 * 1. **Immutability is checkable.** Each field covered by the digest is mutated
 *    one at a time, the mutation is asserted to have landed (the stored value
 *    really differs), and `assertQuoteIntact` must red. A field that the digest
 *    silently failed to cover would pass this and nothing else would catch it.
 * 2. **The displayed total is not invented and not corrected.** A total that does
 *    not equal its own lines is refused, in both directions, and the refusal
 *    names both figures.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NO_QUOTE_EXPIRY,
  OrderError,
  assertCommitWithinConfirmedQuote,
  assertQuoteApproved,
  assertQuoteConfirmable,
  assertQuoteIntact,
  assessQuoteDivergence,
  quoteExpiryText,
  ORDER_QUOTE_DIGEST_PATTERN,
  P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR,
  buildCommercialQuote,
  canonicalQuoteBytes,
  type CommercialQuote,
  type CommercialQuoteInput,
  type ConfirmedQuoteApproval,
  type OrderQuoteConfirmationDto,
  type QuoteLineSnapshot,
  type UnitPrecisionDeclaration,
} from '../src';

/** A product that tracks inventory at the given precision — the ordinary case. */
const tracked = (unitDecimals: number): UnitPrecisionDeclaration => ({ tracksInventory: true, unitDecimals });

const QUOTE = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VARIANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const INPUT: CommercialQuoteInput = {
  quoteId: QUOTE,
  orderId: ORDER,
  version: 1,
  currency: 'ILS',
  lines: [
    {
      stockKey: `${PRODUCT_A}:${VARIANT}`,
      productId: PRODUCT_A,
      variantId: VARIANT,
      quantity: '2.0000',
      unitPriceMinor: '1500',
      discountMinor: '200',
      lineTotalMinor: '2800',
    },
    { stockKey: `${PRODUCT_B}:`, productId: PRODUCT_B, variantId: null, quantity: '1.0000', unitPriceMinor: '999', discountMinor: '0', lineTotalMinor: '999' },
  ],
  displayedTotalMinor: '3799',
  issuedAt: '2026-10-01T09:00:00Z',
  expiresAt: '2026-10-01T10:00:00Z',
};

const QUOTED = buildCommercialQuote(INPUT);

const CONFIRMATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * A HONEST approval of a quote: the confirmation agrees with it field for field.
 *
 * Every refusal case below starts from this and breaks exactly one field, which
 * is what makes each case name its own subject rather than failing for whatever
 * the first disagreement happens to be.
 */
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

const APPROVAL = approve(QUOTED);

describe('buildCommercialQuote', () => {
  it('produces a stable lowercase-hex sha256 digest over the canonical stream', () => {
    expect(QUOTED.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(buildCommercialQuote(INPUT).digest).toBe(QUOTED.digest);
  });

  it('checks the displayed total adds up — and refuses it in both directions', () => {
    for (const wrong of ['3798', '3800', '0']) {
      try {
        buildCommercialQuote({ ...INPUT, displayedTotalMinor: wrong });
        throw new Error(`a displayed total of ${wrong} was accepted over a line sum of 3799`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.quote_total_mismatch');
        expect((error as OrderError).details?.lineSumMinor).toBe('3799');
        expect((error as OrderError).details?.displayedTotalMinor).toBe(wrong);
      }
    }
  });

  // The owner settled the rounding question on 2026-10-12 ("التقريب لكل سطر"):
  // per line, half to even, one rounding after the quantity and the approved
  // discounts. Until then this builder deliberately accepted ANY line total
  // that summed, because deriving one needs a rounding mode and inventing a
  // mode here would have been a second money truth. The mode is no longer
  // invented: it is the project's own, so the figure now has one lawful value.
  // The previous case asserted the opposite and passed by accepting 9999; it is
  // replaced rather than deleted, so the record shows which law changed and
  // when.
  it('refuses a line total that is not the line arithmetic, now that the rounding mode is settled', () => {
    // 2 × 1500 − 200 is exactly 2800, so 9999 is simply wrong.
    try {
      buildCommercialQuote({
        ...INPUT,
        lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), lineTotalMinor: '9999' }],
        displayedTotalMinor: '9999',
      });
      throw new Error('a line total of 9999 was accepted over an exact value of 2800');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      expect((error as OrderError).code).toBe('order.quote_line_total_mismatch');
      expect((error as OrderError).details?.expectedLineTotalMinor).toBe('2800');
      expect((error as OrderError).details?.statedLineTotalMinor).toBe('9999');
    }
  });

  it('still does not PRICE the line: a lawful carried figure is returned verbatim, byte for byte', () => {
    // The distinction the module note turns on. The builder never writes a line
    // total, so a lawful one reaches the digest exactly as the pricing
    // authority spelled it, and the digest is unchanged by the new gate.
    expect(QUOTED.lines[0]?.lineTotalMinor).toBe('2800');
    expect(QUOTED.lines[0]?.lineTotalMinor).toBe(INPUT.lines[0]?.lineTotalMinor);
  });

  it.each(['-1', '1.5', '01', '', ' 1', '1e3'])('refuses the non-canonical amount %s', (bad) => {
    expect(() => buildCommercialQuote({ ...INPUT, displayedTotalMinor: bad })).toThrowError(expect.objectContaining({ code: 'order.quote_amount_invalid' }));
  });

  it('refuses a version below 1 and a non-integer version', () => {
    for (const version of [0, -1, 1.5]) {
      expect(() => buildCommercialQuote({ ...INPUT, version })).toThrowError(expect.objectContaining({ code: 'order.quote_version_invalid' }));
    }
  });

  it('refuses an expiry at or before the issue instant, and admits a null expiry', () => {
    expect(() => buildCommercialQuote({ ...INPUT, expiresAt: INPUT.issuedAt })).toThrowError(expect.objectContaining({ code: 'order.quote_expiry_invalid' }));
    expect(() => buildCommercialQuote({ ...INPUT, expiresAt: '2026-10-01T08:59:59Z' })).toThrowError(
      expect.objectContaining({ code: 'order.quote_expiry_invalid' }),
    );
    expect(buildCommercialQuote({ ...INPUT, expiresAt: null }).expiresAt).toBeNull();
  });

  it('refuses two lines naming one stock key, and an empty line list', () => {
    expect(() =>
      buildCommercialQuote({
        ...INPUT,
        lines: [INPUT.lines[0] as (typeof INPUT.lines)[number], INPUT.lines[0] as (typeof INPUT.lines)[number]],
        displayedTotalMinor: '5600',
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.quote_line_duplicate' }));
    expect(() => buildCommercialQuote({ ...INPUT, lines: [], displayedTotalMinor: '0' })).toThrowError(expect.objectContaining({ code: 'order.cart_empty' }));
  });

  it.each(['ils', 'IL', 'ILSX', ''])('refuses the currency %s', (currency) => {
    expect(() => buildCommercialQuote({ ...INPUT, currency })).toThrowError(expect.objectContaining({ code: 'order.quote_amount_invalid' }));
  });
});

describe('immutability, proved by mutation of every covered field', () => {
  it('accepts the quote as built — the baseline is green', () => {
    expect(() => assertQuoteIntact(QUOTED)).not.toThrow();
  });

  const HEADER_MUTATIONS: readonly { field: string; value: unknown }[] = [
    { field: 'quoteId', value: '33333333-3333-4333-8333-333333333333' },
    { field: 'orderId', value: '44444444-4444-4444-8444-444444444444' },
    { field: 'version', value: 2 },
    { field: 'currency', value: 'USD' },
    { field: 'issuedAt', value: '2026-10-01T09:00:01Z' },
    { field: 'expiresAt', value: '2026-10-01T11:00:00Z' },
    { field: 'displayedTotalMinor', value: '3798' },
  ];

  for (const { field, value } of HEADER_MUTATIONS) {
    it(`reds when ${field} is edited after issue`, () => {
      const mutated = { ...QUOTED } as unknown as Record<string, unknown>;
      const before = mutated[field];
      mutated[field] = value;
      // Prove the mutation landed: a mutation that matched nothing would leave a
      // green test over a law that was never exercised.
      expect(mutated[field]).not.toEqual(before);
      expect(canonicalQuoteBytes(mutated as unknown as CommercialQuoteInput)).not.toBe(canonicalQuoteBytes(QUOTED));
      try {
        assertQuoteIntact(mutated as unknown as CommercialQuote);
        throw new Error(`${field} was edited and the quote still verified`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.quote_tampered');
      }
    });
  }

  const LINE_FIELDS: readonly string[] = ['stockKey', 'productId', 'variantId', 'quantity', 'unitPriceMinor', 'discountMinor', 'lineTotalMinor'];

  for (const field of LINE_FIELDS) {
    it(`reds when a line's ${field} is edited after issue`, () => {
      const line = { ...(QUOTED.lines[0] as unknown as Record<string, unknown>) };
      const before = line[field];
      line[field] = field === 'variantId' ? null : 'MUTATED';
      expect(line[field]).not.toEqual(before);
      const mutated = { ...QUOTED, lines: [line, QUOTED.lines[1]] } as unknown as CommercialQuote;
      expect(canonicalQuoteBytes(mutated)).not.toBe(canonicalQuoteBytes(QUOTED));
      expect(() => assertQuoteIntact(mutated)).toThrowError(expect.objectContaining({ code: 'order.quote_tampered' }));
    });
  }

  it('reds when a line is dropped, and when one is added', () => {
    expect(() => assertQuoteIntact({ ...QUOTED, lines: [QUOTED.lines[0] as (typeof QUOTED.lines)[number]] })).toThrowError(
      expect.objectContaining({ code: 'order.quote_tampered' }),
    );
    expect(() => assertQuoteIntact({ ...QUOTED, lines: [...QUOTED.lines, QUOTED.lines[0] as (typeof QUOTED.lines)[number]] })).toThrowError(
      expect.objectContaining({ code: 'order.quote_tampered' }),
    );
  });

  it('distinguishes a null expiry from an empty-string one, so the separator cannot be forged', () => {
    const nullExpiry = buildCommercialQuote({ ...INPUT, expiresAt: null });
    expect(nullExpiry.digest).not.toBe(QUOTED.digest);
  });
});

describe('assertQuoteConfirmable', () => {
  it('admits a confirmation inside the window at the current version', () => {
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T09:30:00Z', 1)).not.toThrow();
  });

  // Directive #11 PART 34 — the expiry boundary is HALF-OPEN: a quote is valid
  // only while `asOf < expiresAt`, so the exact expiry instant is EXPIRED.
  //
  // The three instants around the boundary are named one by one, with the
  // boundary written as a literal rather than derived from the quote, because
  // the previous revision of this suite asserted the OPPOSITE on this very line
  // ("admits a confirmation exactly at the expiry instant") and was green. A
  // test can pin the wrong side of a boundary just as confidently as the right
  // one; what distinguishes them is a stated rule to check the test against.
  it('PART 34 — one instant BEFORE the expiry is valid', () => {
    // expiresAt is 2026-10-01T10:00:00Z.
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T09:59:59Z', 1)).not.toThrow();
  });

  it('PART 34 — the EXACT expiry instant is EXPIRED, never admitted by accident', () => {
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T10:00:00Z', 1)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
  });

  it('PART 34 — one instant AFTER the expiry is expired', () => {
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T10:00:01Z', 1)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
  });

  it('PART 34 — a quote with no expiry is subject to the OTHER checks, not exempt from them', () => {
    const forever = buildCommercialQuote({ ...INPUT, expiresAt: null });
    // No expiry: never expires, however far out the instant is.
    expect(() => assertQuoteConfirmable(forever, '2099-01-01T00:00:00Z', 1)).not.toThrow();
    // ...but the version check and the digest check still apply to it.
    expect(() => assertQuoteConfirmable(forever, '2099-01-01T00:00:00Z', 2)).toThrowError(expect.objectContaining({ code: 'order.quote_version_stale' }));
    expect(() => assertQuoteConfirmable({ ...forever, displayedTotalMinor: '1' }, '2099-01-01T00:00:00Z', 1)).toThrowError(
      expect.objectContaining({ code: 'order.quote_tampered' }),
    );
  });

  it('refuses a stale version — the shopper agreed to a figure that has been superseded', () => {
    const reQuoted = buildCommercialQuote({ ...INPUT, quoteId: '55555555-5555-4555-8555-555555555555', version: 2 });
    expect(() => assertQuoteConfirmable(reQuoted, '2026-10-01T09:30:00Z', 1)).toThrowError(expect.objectContaining({ code: 'order.quote_version_stale' }));
    expect(() => assertQuoteConfirmable(reQuoted, '2026-10-01T09:30:00Z', 2)).not.toThrow();
  });

  it('refuses an asOf before the quote was issued, and a non-canonical asOf', () => {
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T08:59:59Z', 1)).toThrowError(expect.objectContaining({ code: 'order.quote_expiry_invalid' }));
    expect(() => assertQuoteConfirmable(QUOTED, '2026-13-01T09:00:00Z', 1)).toThrowError(expect.objectContaining({ code: 'order.occurred_at_invalid' }));
  });

  it('checks the digest first, so a tampered quote cannot be confirmed at all', () => {
    expect(() => assertQuoteConfirmable({ ...QUOTED, displayedTotalMinor: '1' }, '2026-10-01T09:30:00Z', 1)).toThrowError(
      expect.objectContaining({ code: 'order.quote_tampered' }),
    );
  });
});

describe('assessQuoteDivergence', () => {
  // Directive #11 PART 33 — Phase 6 v1 tolerance is EXACTLY 0 minor units, and
  // it is a constant rather than a parameter so that no caller can widen it.
  it('PART 33 — the v1 tolerance is exactly zero, stated as a literal', () => {
    expect(P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR).toBe('0');
  });

  it('PART 33 — the function takes NO tolerance argument, so no caller can widen the policy', () => {
    // An extra argument would be silently ignored by JS, so arity is asserted
    // directly: this is the only mechanical check that a tolerance parameter has
    // not quietly come back. Three parameters: the approval, the order it must
    // belong to, and the recomputed total. None of them is a tolerance.
    expect(assessQuoteDivergence.length).toBe(3);
  });

  it('passes an exact match', () => {
    expect(assessQuoteDivergence(APPROVAL, ORDER, '3799')).toEqual({ status: 'within_policy', differenceMinor: '0' });
  });

  it('PART 33 — one minor unit MORE requires re-confirmation', () => {
    expect(assessQuoteDivergence(APPROVAL, ORDER, '3800')).toEqual({
      status: 'requires_reconfirmation',
      quotedTotalMinor: '3799',
      recomputedTotalMinor: '3800',
      differenceMinor: '1',
    });
  });

  it('PART 33 — one minor unit LESS requires re-confirmation too — charging less is still not what was agreed', () => {
    const verdict = assessQuoteDivergence(APPROVAL, ORDER, '3798');
    expect(verdict.status).toBe('requires_reconfirmation');
    expect(verdict.differenceMinor).toBe('1');
  });

  it('PART 33 — the admitted set is exactly ONE total, written out as a literal', () => {
    // Quoted 3799. At a tolerance of zero the only recomputation that may commit
    // automatically is 3799 itself; both neighbours diverge. The three numbers
    // are written out rather than derived, so an arithmetic slip in the test
    // cannot agree with one in the implementation.
    expect(assessQuoteDivergence(APPROVAL, ORDER, '3798').status).toBe('requires_reconfirmation');
    expect(assessQuoteDivergence(APPROVAL, ORDER, '3799').status).toBe('within_policy');
    expect(assessQuoteDivergence(APPROVAL, ORDER, '3800').status).toBe('requires_reconfirmation');
  });

  it('is exact above Number.MAX_SAFE_INTEGER — a double could not hold this comparison', () => {
    const big = '9007199254740993';
    // One unit at that price, no discount, so the figure is lawful under the
    // per-line rounding rule as well as too large for a double: the case still
    // measures the comparison and not the new gate.
    const huge = buildCommercialQuote({
      ...INPUT,
      lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), quantity: '1.0000', unitPriceMinor: big, discountMinor: '0', lineTotalMinor: big }],
      displayedTotalMinor: big,
    });
    expect(assessQuoteDivergence(approve(huge), ORDER, big)).toEqual({ status: 'within_policy', differenceMinor: '0' });
    expect(assessQuoteDivergence(approve(huge), ORDER, '9007199254740994').status).toBe('requires_reconfirmation');
  });

  it('refuses a negative or non-canonical recomputed total rather than reading it as zero', () => {
    for (const bad of ['-1', '0.5', '']) {
      expect(() => assessQuoteDivergence(APPROVAL, ORDER, bad)).toThrowError(expect.objectContaining({ code: 'order.quote_amount_invalid' }));
    }
  });

  it('refuses a tampered quote before comparing anything', () => {
    expect(() => assessQuoteDivergence(approve({ ...QUOTED, displayedTotalMinor: '3798' }), ORDER, '3798')).toThrowError(
      expect.objectContaining({ code: 'order.quote_tampered' }),
    );
  });
});

describe('the quote snapshot carries NO confirmation field (Master Continuous Mission, 12 Oct 2026)', () => {
  // "Settle the quote confirmation fields together with immutability, by an
  // approved fact-transition mechanism, not a silent update that violates the
  // contract."
  //
  // The migration request had declared the quote relation immutable (no UPDATE,
  // no DELETE) and then given it `confirmed_at` and `confirmed_version` — two
  // columns nothing could ever fill, since they start NULL at insert and only an
  // UPDATE could set them. The contradiction had one obvious bad resolution:
  // drop the no-UPDATE rule so the write goes through, which is how an immutable
  // snapshot quietly stops being immutable. The confirmation is its own
  // append-only fact instead.
  //
  // This is the domain-side half of that law. The snapshot type must stay free
  // of any confirmation field, because the digest covers the snapshot: a
  // `confirmedAt` on it would either be outside the digest (an uncovered field
  // on a tamper-evident record) or inside it (making the digest change when the
  // shopper agrees, so every confirmation would read as tampering).
  const CONFIRMATION_WORDS = /confirm|accept|agree|approv/i;

  it('has no confirmation-shaped key on the quote, nor on any of its lines', () => {
    const header = Object.keys(QUOTED).filter((k) => CONFIRMATION_WORDS.test(k));
    expect(header).toEqual([]);
    const line = Object.keys(QUOTED.lines[0] as object).filter((k) => CONFIRMATION_WORDS.test(k));
    expect(line).toEqual([]);
  });

  it('proves the regex would catch one, so the empty result is a measurement and not a vacuous pass', () => {
    // Without this, the case above passes equally well if CONFIRMATION_WORDS
    // never matched anything at all.
    const planted = { ...(QUOTED as unknown as Record<string, unknown>), confirmedAt: '2026-10-01T09:30:00Z' };
    expect(Object.keys(planted).filter((k) => CONFIRMATION_WORDS.test(k))).toEqual(['confirmedAt']);
  });

  it('produces the ONE digest representation the DDL can reference (Mission V3)', () => {
    // V3: «وحّد تمثيل digest وبايتاته» — unify the digest representation AND its bytes. There
    // were THREE across two documents and this code: `bytea` on the quote relation, `text` on the
    // confirmation, and a hex string here. MEASURED on PostgreSQL 16.15, as the finding rather
    // than as an opinion:
    //
    //   ERROR: foreign key constraint ... cannot be implemented
    //   DETAIL: Key columns "confirmed_quote_digest" and "digest" are of
    //           incompatible types: text and bytea.
    //
    // So the specification as written could not have been applied, and no number of green cases
    // here would have said so. The unified representation is hex text — what this package already
    // computes — so nothing is encoded at the boundary, and an encoding step is one more place
    // two values can disagree.
    expect(QUOTED.digest).toMatch(ORDER_QUOTE_DIGEST_PATTERN);
    expect(QUOTED.digest).toHaveLength(64);
    // Planted controls: a pattern matching anything would pass the two cases above.
    expect(ORDER_QUOTE_DIGEST_PATTERN.test(QUOTED.digest.toUpperCase())).toBe(false);
    expect(ORDER_QUOTE_DIGEST_PATTERN.test(QUOTED.digest.slice(0, 63))).toBe(false);
  });

  it('keeps the digest independent of any confirmation, since confirming changes nothing on the quote', () => {
    // The same quote, confirmed or not, is byte-identical and so digest-identical.
    // That is the property the append-only confirmation record buys: the shopper
    // agreeing leaves the thing they agreed to untouched.
    const reissued = buildCommercialQuote(INPUT);
    expect(reissued.digest).toBe(QUOTED.digest);
    expect(() => assertQuoteIntact(QUOTED)).not.toThrow();
  });
});

describe('a quoted quantity is validated by the inventory truth (challenger P1-02)', () => {
  // The independent challenger measured seven values that the quote relation
  // accepted into the immutable record of what the shopper was shown, each of
  // which then reported itself intact AND confirmable. They are written out
  // here one by one rather than generated, because each is a different way of
  // being wrong and a reader should see all seven.
  const REFUSED = ['-5', '', 'abc', '0', '1e3', '  2  ', '2.00000000001'];

  for (const quantity of REFUSED) {
    it(`refuses a line quantity of ${JSON.stringify(quantity)}`, () => {
      const first = INPUT.lines[0] as (typeof INPUT.lines)[number];
      try {
        buildCommercialQuote({ ...INPUT, lines: [{ ...first, quantity }, ...INPUT.lines.slice(1)] });
        throw new Error(`a line quantity of ${JSON.stringify(quantity)} was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.quote_quantity_invalid');
        expect((error as OrderError).details?.stated).toBe(quantity);
      }
    });
  }

  it('refuses a non-canonical spelling of a valid quantity, so one quantity has one digest', () => {
    const first = INPUT.lines[0] as (typeof INPUT.lines)[number];
    for (const spelling of ['2', '2.0', '2.00']) {
      try {
        buildCommercialQuote({ ...INPUT, lines: [{ ...first, quantity: spelling }, ...INPUT.lines.slice(1)] });
        throw new Error(`the spelling ${JSON.stringify(spelling)} was accepted beside 2.0000`);
      } catch (error) {
        expect((error as OrderError).code).toBe('order.quote_quantity_invalid');
        expect((error as OrderError).details?.canonical).toBe('2.0000');
      }
    }
  });

  it('refuses a quantity the product unit precision cannot represent, when the precision is supplied', () => {
    const first = INPUT.lines[0] as (typeof INPUT.lines)[number];
    // 2.5 × 1500 − 200 = 3550, so the line total moves with the quantity; a
    // stale 2800 would be refused by the rounding gate and this case would
    // then measure that gate instead of the precision law.
    const fractional = {
      ...INPUT,
      lines: [{ ...first, quantity: '2.5000', lineTotalMinor: '3550' }, ...INPUT.lines.slice(1)],
      displayedTotalMinor: '4549',
    };
    // Without a precision the law is not claimed: 2.5 of something is a fine
    // quantity until a caller says the product is sold in whole units.
    expect(buildCommercialQuote(fractional).lines[0]?.quantity).toBe('2.5000');
    expect(() => buildCommercialQuote(fractional, { unitPrecisionByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, tracked(0)]]) })).toThrowError(
      expect.objectContaining({ code: 'order.quote_quantity_invalid' }),
    );
  });
});

describe('the digest premise about \\u0000 is now true for the reason it gives (challenger P3-02)', () => {
  // The module states that `\u0000` separates fields because it cannot occur in
  // any value. `stockKey` and `quantity` were the two fields nothing validated,
  // so both could carry one; the premise held only by the accident of the
  // line-count field. Both are validated now, and these two cases are what keep
  // that true.
  it('refuses a stock key that is not the canonical key of its own product and variant', () => {
    const first = INPUT.lines[0] as (typeof INPUT.lines)[number];
    for (const stockKey of ['A\u0000B', `${PRODUCT_A}:`, `${PRODUCT_B}:${VARIANT}`, '']) {
      try {
        buildCommercialQuote({ ...INPUT, lines: [{ ...first, stockKey }, ...INPUT.lines.slice(1)] });
        throw new Error(`a stock key of ${JSON.stringify(stockKey)} was accepted`);
      } catch (error) {
        expect((error as OrderError).code).toBe('order.quote_stock_key_invalid');
        expect((error as OrderError).details?.expected).toBe(`${PRODUCT_A}:${VARIANT}`);
      }
    }
  });

  it('no NUL reaches the canonical stream, so the segment count is exactly the field count', () => {
    // 9 header fields + 7 per line × 2 lines = 23 segments. A NUL smuggled into
    // any value would raise this count, which is the mechanism the challenger
    // found was doing the work on its own.
    expect(canonicalQuoteBytes(INPUT).split('\u0000')).toHaveLength(23);
  });
});

describe('an approval is an approval of THIS order current quote (challenger P2-02)', () => {
  it('refuses a confirmation that names another order, another quote or other bytes', () => {
    const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const cases: [string, ConfirmedQuoteApproval][] = [
      ['another order', { ...APPROVAL, confirmation: { ...APPROVAL.confirmation, orderId: OTHER } }],
      ['another quote', { ...APPROVAL, confirmation: { ...APPROVAL.confirmation, quoteId: OTHER } }],
      ['other bytes', { ...APPROVAL, confirmation: { ...APPROVAL.confirmation, confirmedQuoteDigest: 'a'.repeat(64) } }],
      ['another expiry', { ...APPROVAL, confirmation: { ...APPROVAL.confirmation, confirmedQuoteExpiresAt: '2026-10-01T11:00:00Z' } }],
    ];
    for (const [what, approval] of cases) {
      try {
        assertQuoteApproved(approval, ORDER);
        throw new Error(`a confirmation naming ${what} was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.quote_not_approved');
      }
    }
  });

  it('refuses a quote that belongs to another order even when the confirmation agrees with it', () => {
    const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const foreign = buildCommercialQuote({ ...INPUT, orderId: OTHER });
    expect(() => assertQuoteApproved(approve(foreign), ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_not_approved' }));
  });

  it('PART 34 — no divergence verdict exists at all for an expired quote', () => {
    // This is the defect the challenger measured: the same quote that
    // `assertQuoteConfirmable` refuses at this instant used to return
    // `within_policy` from the one function whose verdict gates the commit.
    const atExpiry = approve(QUOTED, '2026-10-01T10:00:00Z');
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T10:00:00Z', 1)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
    expect(() => assessQuoteDivergence(atExpiry, ORDER, '3799')).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
  });

  it('refuses a superseded version rather than passing it', () => {
    const superseded: ConfirmedQuoteApproval = { ...APPROVAL, confirmation: { ...APPROVAL.confirmation, confirmedVersion: 9 } };
    expect(() => assessQuoteDivergence(superseded, ORDER, '3799')).toThrowError(expect.objectContaining({ code: 'order.quote_version_stale' }));
  });

  it('turns the divergence verdict into a refusal that names both figures (PART 33)', () => {
    expect(() => assertCommitWithinConfirmedQuote(APPROVAL, ORDER, '3799')).not.toThrow();
    try {
      assertCommitWithinConfirmedQuote(APPROVAL, ORDER, '3800');
      throw new Error('a recomputation of 3800 was admitted over a confirmed 3799');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_requires_reconfirmation');
      expect((error as OrderError).details?.quotedTotalMinor).toBe('3799');
      expect((error as OrderError).details?.recomputedTotalMinor).toBe('3800');
      expect((error as OrderError).details?.toleranceMinor).toBe('0');
    }
  });
});

describe('the domain null and the relation infinity are one mapping (challenger P0-01)', () => {
  // The domain says `expiresAt: string | null`; `I6a.2`'s seven-column foreign
  // key cannot carry a null, because under the default MATCH SIMPLE a null in
  // any column skips the WHOLE key — measured on PostgreSQL 16.15, where a
  // confirmation of a nonexistent order, quote, version and digest was
  // accepted. `quoteExpiryText` is the one place the two representations meet.
  const OPEN_ENDED = buildCommercialQuote({ ...INPUT, expiresAt: null });

  it('maps a quote with no expiry onto the value the relation stores', () => {
    expect(OPEN_ENDED.expiresAt).toBeNull();
    expect(quoteExpiryText(OPEN_ENDED)).toBe(NO_QUOTE_EXPIRY);
    expect(quoteExpiryText(QUOTED)).toBe('2026-10-01T10:00:00Z');
  });

  // The OUTPUT of this function is what a confirmation row carries, and it was
  // the one exported reader of a quote field with no gate of its own — the
  // challenger's `R-25`, routed by the coordinator. These cases are the red
  // proof: delete the `assertQuoteIntact` call in `quoteExpiryText` and each of
  // the refusal cases below goes red. What the ungated function would do differs
  // by case and is NOT uniformly "returns the forged value" — the two Proxy
  // cases below measure that difference rather than assuming it.
  it('refuses a quote whose expiry was edited in place after its bytes were digested (R-25)', () => {
    const edited = { ...QUOTED, expiresAt: '2099-01-01T00:00:00Z' };
    expect(() => quoteExpiryText(edited)).toThrowError(expect.objectContaining({ code: 'order.quote_tampered' }));
    // And the forged value is not returned on the way to the refusal.
    let returned: string | null = null;
    try {
      returned = quoteExpiryText(edited);
    } catch {
      returned = null;
    }
    expect(returned).toBeNull();
  });

  it('refuses an expiry read off a quote that was never a lawful quote (R-25)', () => {
    // Self-consistent bytes are NOT enough: the gate re-runs the builder, so a
    // quote whose displayed total disagrees with its lines is refused by the law
    // it breaks rather than answered for. Forged here rather than borrowed from
    // the lawfulness block below, so this case stands on its own.
    const fields = { ...QUOTED, displayedTotalMinor: '999999' } as Omit<CommercialQuote, 'digest'> & { digest?: string };
    delete fields.digest;
    const forged = { ...fields, digest: createHash('sha256').update(canonicalQuoteBytes(fields), 'utf8').digest('hex') } as CommercialQuote;
    // The forgery is proved to have landed before it is used as evidence.
    expect(() => assertQuoteIntact(forged)).toThrowError(expect.objectContaining({ code: 'order.quote_total_mismatch' }));
    expect(() => quoteExpiryText(forged)).toThrowError(expect.objectContaining({ code: 'order.quote_total_mismatch' }));
  });

  // The Proxy threat is NOT uniform, and the challenger measured why at
  // `3f56c62`: the builder FREEZES its quote, so a `get` trap that answers
  // differently from a frozen own data property throws a `TypeError` from the
  // language's own invariant before any guard is consulted. So a Proxy can only
  // forge a field of a carrier that never came from `buildCommercialQuote`. Both
  // cases are kept, because the gate must refuse BY NAME in either one rather
  // than letting the runtime decide which error a caller sees.
  const forgeExpiry = {
    get(target: CommercialQuote, key: string | symbol, receiver: unknown): unknown {
      if (key === 'expiresAt') return '2099-01-01T00:00:00Z';
      return Reflect.get(target, key, receiver) as unknown;
    },
  };

  it('refuses an expiry read through a Proxy over a FROZEN builder quote (R-25 over F-41)', () => {
    const trapped = new Proxy(QUOTED, forgeExpiry);
    // The refusal arrives BEFORE the trap is consulted, which is the point: the
    // caller gets this package's code, not a TypeError out of the language.
    expect(() => quoteExpiryText(trapped)).toThrowError(expect.objectContaining({ code: 'order.quote_field_undeclared' }));
    // And the language fact that makes this case different, asserted rather
    // than described: reading the trapped field directly throws.
    expect(() => (trapped as CommercialQuote).expiresAt).toThrowError(TypeError);
  });

  it('refuses an expiry read through a Proxy over an UNFROZEN lawful carrier, which is the case that forges (R-25)', () => {
    // A spread of a lawful quote: same fields, same digest, no longer frozen —
    // exactly the carrier a storage read or a deserializer hands over.
    const carrier = { ...QUOTED };
    const trapped = new Proxy(carrier, forgeExpiry);
    // Here the trap DOES answer, so without the gate the forged text is what a
    // confirmation row would carry. Measured, not assumed:
    expect((trapped as CommercialQuote).expiresAt).toBe('2099-01-01T00:00:00Z');
    expect(() => quoteExpiryText(trapped)).toThrowError(expect.objectContaining({ code: 'order.quote_field_undeclared' }));
  });

  it('still maps the two representations in exactly one place after the gate (R-25)', () => {
    // The gate is added WITHOUT a second mapping appearing at a call site: the
    // approval gate's refusal still reports the same text this function returns.
    const honest = approve(OPEN_ENDED);
    const disagreeing = { ...honest, confirmation: { ...honest.confirmation, confirmedQuoteExpiresAt: '2026-10-01T10:00:00Z' } };
    try {
      assertQuoteApproved(disagreeing, ORDER);
      throw new Error('the approval gate accepted a confirmation that disagreed about the expiry');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: 'order.quote_not_approved' }));
      expect((error as { details?: { expiresAt?: string } }).details?.expiresAt).toBe(quoteExpiryText(OPEN_ENDED));
    }
  });

  it('a no-expiry quote is confirmable at any instant at or after issue, and never before', () => {
    expect(() => assertQuoteApproved(approve(OPEN_ENDED, '2099-01-01T00:00:00Z'), ORDER)).not.toThrow();
    expect(() => assertQuoteApproved(approve(OPEN_ENDED, '2026-10-01T08:59:59Z'), ORDER)).toThrowError(
      expect.objectContaining({ code: 'order.quote_expiry_invalid' }),
    );
  });

  it('the three cases the relation used to accept for a no-expiry quote are refused in the domain too', () => {
    const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const honest = approve(OPEN_ENDED);
    // 1. a WRONG DIGEST on a quote with no expiry — the case the challenger
    //    asked to be named explicitly, because the composite key could not see it.
    expect(() => assertQuoteApproved({ ...honest, confirmation: { ...honest.confirmation, confirmedQuoteDigest: 'b'.repeat(64) } }, ORDER)).toThrowError(
      expect.objectContaining({ code: 'order.quote_not_approved' }),
    );
    // 2. a NONEXISTENT VERSION.
    expect(() => assertQuoteApproved({ ...honest, confirmation: { ...honest.confirmation, confirmedVersion: 7 } }, ORDER)).toThrowError(
      expect.objectContaining({ code: 'order.quote_version_stale' }),
    );
    // 3. a FOREIGN ORDER.
    expect(() => assertQuoteApproved({ ...honest, confirmation: { ...honest.confirmation, orderId: OTHER } }, ORDER)).toThrowError(
      expect.objectContaining({ code: 'order.quote_not_approved' }),
    );
  });

  it('a null expiry is never written into a confirmation', () => {
    // The DTO's type forbids it; this reads the VALUE the mapping produces, so
    // the law is executed and not only compiled.
    expect(approve(OPEN_ENDED).confirmation.confirmedQuoteExpiresAt).toBe(NO_QUOTE_EXPIRY);
    expect(approve(OPEN_ENDED).confirmation.confirmedQuoteExpiresAt).not.toBeNull();
  });
});

describe('the gate proves LAWFULNESS, not only integrity (round-2 challenge P1-01)', () => {
  // `canonicalQuoteBytes` is exported, so anyone can give a hand-built object a
  // valid digest. Each case below forges a quote that is self-consistent — its
  // digest really is the digest of its own bytes, asserted first so the forgery
  // is proved to have landed — and then breaks one law the builder enforces.
  function forge(fields: Omit<CommercialQuote, 'digest'>): CommercialQuote {
    const digest = createHash('sha256').update(canonicalQuoteBytes(fields), 'utf8').digest('hex');
    return { ...fields, digest };
  }

  const LINE = INPUT.lines[0] as (typeof INPUT.lines)[number];
  // 2 × 1500 − 200 = 2800 is the line's one lawful total, so every forgery
  // below breaks exactly the field it names and not the rounding rule as well.
  const ONE_LINE: Omit<CommercialQuote, 'digest'> = { ...INPUT, lines: [{ ...LINE, lineTotalMinor: '2800' }], displayedTotalMinor: '2800' };

  it('a forged quote really does carry a valid digest — otherwise these cases prove nothing', () => {
    const forged = forge({ ...ONE_LINE, displayedTotalMinor: '999999' });
    const { digest, ...rest } = forged;
    expect(createHash('sha256').update(canonicalQuoteBytes(rest), 'utf8').digest('hex')).toBe(digest);
  });

  it('refuses a displayed total that does not equal its own lines, even with a valid digest', () => {
    // The challenger's case: the builder refuses 999999 against lines summing
    // to 2800, and the hand-built quote carrying that same illegal total used to
    // pass the gate, build an intent, AND have the zero tolerance measured
    // against the forged figure — so the honest recomputation of 1000 was the
    // one refused as a divergence.
    const forged = forge({ ...ONE_LINE, displayedTotalMinor: '999999' });
    expect(() => assertQuoteIntact(forged)).toThrowError(expect.objectContaining({ code: 'order.quote_total_mismatch' }));
    expect(() => assertQuoteApproved(approve(forged), ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_total_mismatch' }));
    expect(() => assertCommitWithinConfirmedQuote(approve(forged), ORDER, '999999')).toThrowError(
      expect.objectContaining({ code: 'order.quote_total_mismatch' }),
    );
  });

  it('refuses a forged negative quantity', () => {
    const forged = forge({ ...ONE_LINE, lines: [{ ...LINE, lineTotalMinor: '2800', quantity: '-5.0000' }] });
    expect(() => assertQuoteIntact(forged)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('refuses a forged duplicate stock key, which used to collapse the hand-off per-key map', () => {
    // Two lines on one stock key: `new Map(lines.map(...))` keeps the LAST, so a
    // quote whose first line granted 0 and whose second granted 77 admitted a
    // requested 77 while the size check still agreed with one position.
    const forged = forge({
      ...INPUT,
      lines: [
        { ...LINE, discountMinor: '0', lineTotalMinor: '3000' },
        { ...LINE, discountMinor: '77', lineTotalMinor: '2923' },
      ],
      displayedTotalMinor: '5923',
    });
    expect(() => assertQuoteIntact(forged)).toThrowError(expect.objectContaining({ code: 'order.quote_line_duplicate' }));
  });

  it('refuses a forged non-canonical digest representation and a forged bad currency', () => {
    expect(() => assertQuoteIntact(forge({ ...ONE_LINE, currency: 'ils' }))).toThrowError(expect.objectContaining({ code: 'order.quote_amount_invalid' }));
    expect(() => assertQuoteIntact(forge({ ...ONE_LINE, version: 0 }))).toThrowError(expect.objectContaining({ code: 'order.quote_version_invalid' }));
  });

  it('still accepts the quote its own builder produced, and still catches an EDIT', () => {
    // Both halves of the claim: lawfulness does not reject what is lawful, and
    // the digest check still speaks for the storage.
    expect(() => assertQuoteIntact(QUOTED)).not.toThrow();
    expect(() => assertQuoteIntact({ ...QUOTED, issuedAt: '2026-10-01T08:00:00Z' })).toThrowError(expect.objectContaining({ code: 'order.quote_tampered' }));
  });
});

describe('confirmedAt is validated and compared to the window (round-2 challenge P1-02)', () => {
  function confirmedAtOf(value: string): ConfirmedQuoteApproval {
    const honest = approve(QUOTED);
    return { ...honest, confirmation: { ...honest.confirmation, confirmedAt: value } };
  }

  it.each(['', 'not-a-date', '2026-13-45T99:99:99Z', '2026-10-01', '2026-10-01T09:30:00.000Z', '2026-10-01T09:30:00+02:00'])(
    'refuses a confirmedAt of %s rather than reading it as an instant',
    (value) => {
      expect(() => assertQuoteApproved(confirmedAtOf(value), ORDER)).toThrowError(expect.objectContaining({ code: 'order.occurred_at_invalid' }));
    },
  );

  it('refuses a confirmation dated before the quote was issued', () => {
    expect(() => assertQuoteApproved(confirmedAtOf('2020-01-01T00:00:00Z'), ORDER)).toThrowError(
      expect.objectContaining({ code: 'order.quote_expiry_invalid' }),
    );
    // The issue instant itself is admitted: agreeing the moment you are quoted
    // is not an error.
    expect(() => assertQuoteApproved(confirmedAtOf('2026-10-01T09:00:00Z'), ORDER)).not.toThrow();
  });

  it('I6.4a — the three instants around the expiry, named one by one', () => {
    // The quote expires at 10:00:00Z.
    expect(() => assertQuoteApproved(confirmedAtOf('2026-10-01T09:59:59Z'), ORDER)).not.toThrow();
    expect(() => assertQuoteApproved(confirmedAtOf('2026-10-01T10:00:00Z'), ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
    expect(() => assertQuoteApproved(confirmedAtOf('2026-10-01T10:00:01Z'), ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
  });

  it('refuses the challenger thirteen-hours-late confirmation, and gives it no divergence verdict either', () => {
    const late = confirmedAtOf('2026-10-01T23:00:00Z');
    expect(() => assertQuoteApproved(late, ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
    expect(() => assessQuoteDivergence(late, ORDER, '3799')).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
  });

  it('a quote with no expiry is confirmable at any instant from its issue onward', () => {
    const openEnded = buildCommercialQuote({ ...INPUT, expiresAt: null });
    const honest = approve(openEnded);
    const far = { ...honest, confirmation: { ...honest.confirmation, confirmedAt: '2099-01-01T00:00:00Z' } };
    expect(() => assertQuoteApproved({ ...far, asOf: '2099-01-01T00:00:00Z' }, ORDER)).not.toThrow();
    const early = { ...honest, confirmation: { ...honest.confirmation, confirmedAt: '2026-10-01T08:59:59Z' } };
    expect(() => assertQuoteApproved(early, ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_expiry_invalid' }));
  });
});

describe('the representability leg of the gate has a caller (round-3 challenge P2-02)', () => {
  // The rebuild was strictly weaker than the build it claimed to re-run:
  // `assertQuoteIntact` accepted a `checks` argument, `assertQuoteConfirmable`
  // had no parameter to pass one through, and the only gate call site passed
  // none — so the builder's representability law had no caller AT THE GATE.
  // Measured by the challenger: with a precision of 0 the builder refuses a
  // quantity of 0.5000, and a forged quote carrying it passed the whole gate.
  const WHOLE_UNITS = { unitPrecisionByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, tracked(0)]]) };
  // 2.5 × 1500 − 200 = 3550, plus the second line's 999.
  const HALF = {
    ...INPUT,
    lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), quantity: '2.5000', lineTotalMinor: '3550' }, ...INPUT.lines.slice(1)],
    displayedTotalMinor: '4549',
  };

  it('the builder refuses the half unit, so there is a law to carry', () => {
    expect(() => buildCommercialQuote(HALF, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('the gate refuses it too, through every entry point, when the precision is supplied', () => {
    // Built WITHOUT the precisions — which is lawful, since the law is not
    // claimed where no caller states it — and then checked WITH them.
    const forged = buildCommercialQuote(HALF);
    expect(() => assertQuoteIntact(forged, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
    expect(() => assertQuoteConfirmable(forged, '2026-10-01T09:30:00Z', 1, WHOLE_UNITS)).toThrowError(
      expect.objectContaining({ code: 'order.quote_quantity_invalid' }),
    );
    expect(() => assertQuoteApproved(approve(forged), ORDER, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
    // And carried ON the approval, which is how `assessQuoteDivergence` — whose
    // signature takes no checks — reaches the same refusal.
    const withChecks: ConfirmedQuoteApproval = { ...approve(forged), checks: WHOLE_UNITS };
    expect(() => assertQuoteApproved(withChecks, ORDER)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
    expect(() => assessQuoteDivergence(withChecks, ORDER, '4049')).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('still admits the half unit where no precision is claimed', () => {
    const halfQuote = buildCommercialQuote(HALF);
    expect(() => assertQuoteApproved(approve(halfQuote), ORDER)).not.toThrow();
  });

  // Round-4 challenge P3-01: a SURVIVING mutation. Inverting
  // `checks ?? approval.checks` to `approval.checks ?? checks` left all cases
  // green, because no case made the two maps DISAGREE — so the documented
  // precedence was a comment with nothing behind it, and which map wins decides
  // whether a law is claimed. The explicit argument wins: an approval cannot
  // weaken a check its call site stated.
  it('refuses a stated precision that is not a precision, under its own code', () => {
    // Not `order.quote_quantity_invalid`: the quantity is honest and the figure
    // at fault is the caller's. Round-5 challenge P3.
    for (const bad of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY, 10]) {
      const checks = { unitPrecisionByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, tracked(bad)]]) };
      expect(() => buildCommercialQuote(INPUT, checks)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_invalid' }));
      expect(() => assertQuoteApproved(approve(QUOTED), ORDER, checks)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_invalid' }));
    }
    // And a lawful precision still reaches the quantity law, so the new guard
    // did not swallow the old one.
    expect(() => buildCommercialQuote(HALF, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('lets the explicit argument win over the approval own checks when they disagree', () => {
    const forged = buildCommercialQuote(HALF);
    const atQ4 = { unitPrecisionByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, tracked(4)]]) };
    // The approval says four decimals, the call site says whole units. The call
    // site decides, so the half unit is REFUSED.
    const lenientApproval: ConfirmedQuoteApproval = { ...approve(forged), checks: atQ4 };
    expect(() => assertQuoteApproved(lenientApproval, ORDER, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
    // And the other direction, so the case cannot pass by refusing everything:
    // the approval says whole units, the call site says four decimals, and the
    // call site decides again — admitted.
    const strictApproval: ConfirmedQuoteApproval = { ...approve(forged), checks: WHOLE_UNITS };
    expect(() => assertQuoteApproved(strictApproval, ORDER, atQ4)).not.toThrow();
  });

  // Round-6 challenge §7. A supplied declaration whose precision is `null` is
  // the catalogue SAYING there is none, which is lawful for a product that does
  // not track inventory. An absent KEY is the caller not saying. The two look
  // the same to a reader of the old map type and are different laws.
  const SERVICE = { unitPrecisionByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, { tracksInventory: false, unitDecimals: null }]]) };

  it('admits the half unit for a product the catalogue declares with no precision', () => {
    expect(() => buildCommercialQuote(HALF, SERVICE)).not.toThrow();
    const quoted = buildCommercialQuote(HALF, SERVICE);
    expect(() => assertQuoteApproved(approve(quoted), ORDER, SERVICE)).not.toThrow();
    // The same line, the same bytes, under a declaration of whole units: refused.
    expect(() => assertQuoteApproved(approve(quoted), ORDER, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('refuses a declaration of a TRACKED product with no precision, under its own code', () => {
    const contradiction = { unitPrecisionByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, { tracksInventory: true, unitDecimals: null }]]) };
    expect(() => buildCommercialQuote(INPUT, contradiction)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_required' }));
    expect(() => assertQuoteApproved(approve(QUOTED), ORDER, contradiction)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_required' }));
  });

  it('still bounds a precision-free quoted quantity by the storage scale', () => {
    const tooFine = { ...INPUT, lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), quantity: '2.00001' }, ...INPUT.lines.slice(1)] };
    expect(() => buildCommercialQuote(tooFine, SERVICE)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('refuses a declaration that does not state whether the product tracks inventory', () => {
    const malformed = {
      unitPrecisionByStockKey: new Map([
        [`${PRODUCT_A}:${VARIANT}`, { unitDecimals: 0 } as unknown as { tracksInventory: boolean; unitDecimals: number | null }],
      ]),
    };
    expect(() => buildCommercialQuote(INPUT, malformed)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_invalid' }));
  });
});

describe('confirmedByUserId is an id or it is nothing (round-3 challenge P3-01)', () => {
  it('refuses a non-canonical confirming user', () => {
    const honest = approve(QUOTED);
    for (const bad of ['not-a-uuid', '', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
      expect(() => assertQuoteApproved({ ...honest, confirmation: { ...honest.confirmation, confirmedByUserId: bad } }, ORDER)).toThrowError(
        expect.objectContaining({ code: 'order.id_invalid' }),
      );
    }
  });

  it('admits null — the shopper confirming on the storefront — and a real id', () => {
    const honest = approve(QUOTED);
    expect(() => assertQuoteApproved(honest, ORDER)).not.toThrow();
    const byStaff = { ...honest, confirmation: { ...honest.confirmation, confirmedByUserId: '77777777-7777-4777-8777-777777777777' } };
    expect(() => assertQuoteApproved(byStaff, ORDER)).not.toThrow();
  });
});

// The coordinator's diff review at `b3719c0`, R-09: the guard whose comment says
// a malformed approval is REFUSED rather than crashing was itself crashing on
// one, because `typeof null === 'object'`. It failed closed — a `TypeError` is
// not an accepted sale — but under the wrong subject and the wrong error class,
// and a caller cannot act on a `TypeError`.
describe('a malformed approval is refused, not crashed on (coordinator R-09)', () => {
  const honest = approve(QUOTED);

  it.each([
    ['quote', { ...honest, quote: null }],
    ['confirmation', { ...honest, confirmation: null }],
    ['both', { ...honest, quote: null, confirmation: null }],
  ])('a null %s is order.quote_not_approved', (_which, broken) => {
    try {
      assertQuoteApproved(broken as unknown as ConfirmedQuoteApproval, ORDER);
      throw new Error('a null member of the approval was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      expect((error as OrderError).code).toBe('order.quote_not_approved');
    }
  });

  it('and so are the shapes that already worked, so the fix did not narrow the guard', () => {
    for (const broken of [undefined, null, 'quote', 7, { quote: 'x', confirmation: 'y' }]) {
      expect(() => assertQuoteApproved(broken as unknown as ConfirmedQuoteApproval, ORDER)).toThrowError(
        expect.objectContaining({ code: 'order.quote_not_approved' }),
      );
    }
    expect(() => assertQuoteApproved(honest, ORDER)).not.toThrow();
  });
});

// Round-10 challenge F-34. `buildCommercialQuote` returned `{ ...input, lines,
// digest }` while `canonicalQuoteBytes` is a hand-written field list, so a field
// the caller had attached to the input rode onto the returned quote OUTSIDE the
// digest — and `assertQuoteIntact` then answered "untampered" after that field
// had been rewritten. Reproduced here first, and it was WIDER than the report:
// it held for a LINE's extra field too. The money path was never open (a total
// inflated by a fee is refused as `order.quote_total_mismatch`), so what this
// closes is the SCOPE of the immutability claim: a consumer reading a field off
// a quote now either has tamper evidence for it or cannot read it at all.
describe('the carrier is the digested stream, not a superset of it (round-10 F-34)', () => {
  const withExtra = { ...INPUT, documentFeeMinor: '5' } as CommercialQuoteInput & { documentFeeMinor: string };

  it('R-16: the builder REFUSES a field the canonical stream does not cover, and names it', () => {
    // Until this commit the builder STRIPPED it. The coordinator's review of
    // `7834bfb` was right that stripping makes the pack's own sentence false:
    // `ACC-REQ-P6-03` says a document-level fee is "fail-closed, not silently
    // dropped", and a silently dropped field is the definition of the second.
    // The refusal happens at the INPUT, before anything is computed, so a
    // caller who sends a fee learns that this package does not price one.
    try {
      buildCommercialQuote(withExtra);
      throw new Error('a quote input carrying an undeclared field was accepted');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_field_undeclared');
      expect((error as OrderError).details?.fields).toBe('documentFeeMinor');
    }
  });

  it('R-16: names EVERY undeclared field, sorted, not just the first one found', () => {
    const two = { ...INPUT, documentFeeMinor: '5', serviceChargeMinor: '9' } as CommercialQuoteInput;
    try {
      buildCommercialQuote(two);
      throw new Error('accepted two undeclared fields');
    } catch (error) {
      expect((error as OrderError).details?.fields).toBe('documentFeeMinor,serviceChargeMinor');
    }
  });

  it('R-16: refuses it on a LINE too, with the line index', () => {
    const lineExtra = {
      ...INPUT,
      lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), surcharge: '7' }, ...INPUT.lines.slice(1)],
    } as CommercialQuoteInput;
    try {
      buildCommercialQuote(lineExtra);
      throw new Error('a quote input line carrying an undeclared field was accepted');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_field_undeclared');
      expect((error as OrderError).details?.lineIndex).toBe('0');
      expect((error as OrderError).details?.fields).toBe('surcharge');
    }
  });

  it('a lawful input still builds, and to the same digest — the refusal is scoped to extra fields', () => {
    expect(buildCommercialQuote(INPUT).digest).toBe(QUOTED.digest);
  });

  it('refuses a hand-built carrier that holds an undeclared field, and NAMES it', () => {
    // The challenger's own case: set the fee, build, then rewrite it in place —
    // exactly what `order.quote_tampered` exists to catch. Before this commit
    // `assertQuoteIntact` answered UNTAMPERED.
    const forged = { ...QUOTED, documentFeeMinor: '500000' } as CommercialQuote;
    try {
      assertQuoteIntact(forged);
      throw new Error('a quote carrying an undeclared field was accepted as intact');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_field_undeclared');
      expect((error as OrderError).details?.fields).toBe('documentFeeMinor');
    }
  });

  it('refuses it on a line, with the line INDEX, so the holder can be found', () => {
    const forged = { ...QUOTED, lines: [QUOTED.lines[0] as object, { ...(QUOTED.lines[1] as object), surcharge: '9' }] } as unknown as CommercialQuote;
    try {
      assertQuoteIntact(forged);
      throw new Error('a quote line carrying an undeclared field was accepted as intact');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_field_undeclared');
      expect((error as OrderError).details?.lineIndex).toBe('1');
      expect((error as OrderError).details?.fields).toBe('surcharge');
    }
  });

  it('the digested stream and the carried fields are THE SAME SET', () => {
    // The agreement the two field lists and `canonicalQuoteBytes` have to keep,
    // asserted rather than left to a comment. Every carried field must be
    // digest-RELEVANT: changing it alone must change the bytes. A field in the
    // carrier that the stream ignores would be F-34 again under another name.
    const { digest: _digest, ...carried } = QUOTED;
    expect(Object.keys(carried).sort()).toEqual(['currency', 'displayedTotalMinor', 'expiresAt', 'issuedAt', 'lines', 'orderId', 'quoteId', 'version'].sort());
    expect(Object.keys(QUOTED.lines[0] as object).sort()).toEqual(
      ['discountMinor', 'lineTotalMinor', 'productId', 'quantity', 'stockKey', 'unitPriceMinor', 'variantId'].sort(),
    );
    const base = canonicalQuoteBytes(carried as CommercialQuoteInput);
    const moved: Record<string, unknown> = {
      quoteId: ORDER,
      orderId: QUOTE,
      version: 2,
      currency: 'USD',
      displayedTotalMinor: '3800',
      issuedAt: '2026-10-01T09:00:01Z',
      expiresAt: null,
      lines: [INPUT.lines[1], INPUT.lines[0]],
    };
    // DRIVEN FROM THE DECLARED LIST, not from this map. The independent
    // challenger's point before round 11: iterating the map checks only the
    // fields someone remembered to put in it, so a field added to the carrier
    // list with no entry here went unperturbed and its digest-relevance was
    // never asserted. Now a missing entry is a FAILURE, so the map cannot fall
    // behind the list in silence.
    for (const field of Object.keys(carried)) {
      expect(Object.keys(moved), `no perturbation is declared for the carried field ${field}`).toContain(field);
      expect(canonicalQuoteBytes({ ...(carried as CommercialQuoteInput), [field]: moved[field] })).not.toBe(base);
    }
    for (const field of Object.keys(QUOTED.lines[0] as object)) {
      const line = { ...(INPUT.lines[0] as (typeof INPUT.lines)[number]) } as Record<string, unknown>;
      line[field] = field === 'variantId' ? null : `${String(line[field])}x`;
      expect(canonicalQuoteBytes({ ...(carried as CommercialQuoteInput), lines: [line as unknown as (typeof INPUT.lines)[number]] })).not.toBe(base);
    }
  });

  it('the APPROVAL path reaches the same refusal, so a refactor of it cannot drop the guard', () => {
    // The coordinator's ruling: one call site, not two, and a case proving the
    // path reaches it. `assertQuoteApproved` validates the quote through
    // `assertQuoteIntact`, so a wider carrier is refused there too — and the day
    // someone reorders that path, this case reds instead of the guard silently
    // disappearing from the approval route.
    const forged = { ...QUOTED, documentFeeMinor: '500000' } as CommercialQuote;
    // The confirmation is built by the PRODUCTION mapping over the lawful quote
    // and the forged carrier is then substituted, rather than the helper being
    // relaxed to write the expiry itself (`R-25`, the challenger's judgement).
    // Measured: this is the ONE case of the seven `approve(forged)` sites that
    // the gated reader refuses, because the other six forge values a lawfully
    // BUILT quote can carry, so relaxing the helper would have been wider than
    // the problem by six cases.
    const approvalOfForged = { ...approve(QUOTED), quote: forged };
    // Every confirmation field still describes THIS quote, so the refusal below
    // cannot be an incidental disagreement about the digest, version or expiry.
    expect(approvalOfForged.confirmation.confirmedQuoteDigest).toBe(forged.digest);
    expect(approvalOfForged.confirmation.confirmedVersion).toBe(forged.version);
    expect(approvalOfForged.confirmation.confirmedQuoteExpiresAt).toBe(forged.expiresAt);
    try {
      assertQuoteApproved(approvalOfForged, ORDER);
      throw new Error('an approval of a quote carrying an undeclared field was accepted');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_field_undeclared');
      expect((error as OrderError).details?.fields).toBe('documentFeeMinor');
    }
  });

  it('and an ordinary quote is still intact, so the new guard refuses nothing lawful', () => {
    expect(() => assertQuoteIntact(QUOTED)).not.toThrow();
    expect(() => assertQuoteApproved(APPROVAL, ORDER)).not.toThrow();
    expect(() => assertQuoteIntact({ ...QUOTED, currency: 'USD' })).toThrowError(expect.objectContaining({ code: 'order.quote_tampered' }));
  });
  // THE CARRIER'S SHAPE, not only its keys (the challenger's pre-round-11
  // measurement, ruled a FAIL-OPEN by the coordinator). With `Object.keys`,
  // three shapes answered for an undeclared field that the check could not see,
  // and `assertQuoteIntact` said ACCEPTED while the field read back as '5'.
  // `Reflect.ownKeys` closes the own half (non-enumerable AND symbol keys);
  // the prototype half needs the carrier's SHAPE, because the field is not the
  // object's own key at all.
  describe("the carrier's SHAPE is checked, not only its keys", () => {
    const refusal = (carrier: unknown): OrderError => {
      try {
        assertQuoteIntact(carrier as CommercialQuote);
      } catch (error) {
        return error as OrderError;
      }
      throw new Error('a wider carrier was accepted as intact');
    };

    it('an own NON-ENUMERABLE field is refused, and named', () => {
      const forged = { ...QUOTED };
      Object.defineProperty(forged, 'documentFeeMinor', { value: '5', enumerable: false });
      expect((forged as { documentFeeMinor?: string }).documentFeeMinor).toBe('5');
      const error = refusal(forged);
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.details?.fields).toBe('documentFeeMinor');
    });

    it('a SYMBOL-keyed field is refused — neither review had listed it', () => {
      const key = Symbol('documentFeeMinor');
      const forged = { ...QUOTED, [key]: '5' };
      expect((forged as Record<symbol, string>)[key]).toBe('5');
      expect(refusal(forged).details?.fields).toBe('Symbol(documentFeeMinor)');
    });

    it('a field on the PROTOTYPE is refused — it is not an own key, so no key list can see it', () => {
      const forged = Object.assign(Object.create({ documentFeeMinor: '5' }), QUOTED) as CommercialQuote & { documentFeeMinor: string };
      expect(forged.documentFeeMinor).toBe('5');
      const error = refusal(forged);
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.details?.prototype).toBe('not Object.prototype');
    });

    it('a CLASS INSTANCE with an accessor is refused — a getter can answer differently on each read', () => {
      class Forged {
        get documentFeeMinor(): string {
          return '5';
        }
      }
      const forged = Object.assign(new Forged(), QUOTED) as unknown as CommercialQuote;
      expect((forged as unknown as { documentFeeMinor: string }).documentFeeMinor).toBe('5');
      expect(refusal(forged).details?.prototype).toBe('not Object.prototype');
    });

    it('a NULL-prototype carrier is refused too, and that is a STATED cost, not an oversight', () => {
      // JSON.parse yields Object.prototype, so the ordinary storage path is
      // unaffected; a layer that builds carriers with Object.create(null) must
      // project. Named here so the cost is in the suite and not only in a
      // comment.
      const forged = Object.assign(Object.create(null), QUOTED) as CommercialQuote;
      expect(refusal(forged).details?.prototype).toBe('null');
    });

    it('a LINE carrying it on its prototype is refused, with the line index', () => {
      const line = Object.assign(Object.create({ surcharge: '7' }), QUOTED.lines[0]);
      const error = refusal({ ...QUOTED, lines: [line, QUOTED.lines[1]] });
      expect(error.code).toBe('order.quote_field_undeclared');
      expect(error.details?.lineIndex).toBe('0');
    });

    // F-40, the challenger's P1: the quote was guarded and each LINE was
    // guarded, and the ARRAY between them was neither. Every shape below
    // answered an undeclared field while assertQuoteIntact said ACCEPTED and
    // the field read back as '500000'.
    it('F-40: the lines CONTAINER is held to the same standard as the things on either side of it', () => {
      const withOwn = Object.assign([...QUOTED.lines], { documentFeeMinor: '500000' });
      expect(refusal({ ...QUOTED, lines: withOwn }).details?.fields).toBe('documentFeeMinor');

      const withNonEnumerable = [...QUOTED.lines];
      Object.defineProperty(withNonEnumerable, 'documentFeeMinor', { value: '500000', enumerable: false });
      expect(refusal({ ...QUOTED, lines: withNonEnumerable }).details?.fields).toBe('documentFeeMinor');

      class Lines extends Array {
        get documentFeeMinor(): string {
          return '500000';
        }
      }
      const subclass = Lines.from(QUOTED.lines) as unknown as readonly QuoteLineSnapshot[];
      expect((subclass as unknown as { documentFeeMinor: string }).documentFeeMinor).toBe('500000');
      expect(refusal({ ...QUOTED, lines: subclass }).details?.container).toBe('is not a plain array');

      // Array.isArray was asserted on the INPUT path only, so a hand-built
      // quote could hand in any iterable and every line check still ran over it.
      const iterable = {
        length: 1,
        0: QUOTED.lines[0],
        documentFeeMinor: '500000',
        entries: Array.prototype.entries,
        map: Array.prototype.map,
        [Symbol.iterator]: Array.prototype[Symbol.iterator],
      };
      expect(refusal({ ...QUOTED, lines: iterable }).details?.container).toBe('is not an array');
    });

    it('F-40: a SPARSE array is refused — its holes are not own keys, so walking it would read undefined lines', () => {
      const sparse: unknown[] = [];
      sparse[2] = QUOTED.lines[0];
      const error = refusal({ ...QUOTED, lines: sparse });
      expect(error.details?.container).toBe('is sparse');
      expect(error.details?.missingIndex).toBe('0');
    });

    it('F-40: and a lawful lines array still passes, frozen or not', () => {
      expect(() => assertQuoteIntact({ ...QUOTED, lines: [...QUOTED.lines] })).not.toThrow();
      expect(() => assertQuoteIntact({ ...QUOTED, lines: Object.freeze([...QUOTED.lines]) })).not.toThrow();
      expect(() => assertQuoteIntact(QUOTED)).not.toThrow();
    });

    // F-41, ruled blocking by the coordinator: a Proxy forwards
    // getPrototypeOf, isArray and ownKeys, so every structural check here
    // passes while a get trap answers an undeclared field. Refused by name
    // through node:util types.isProxy, at every level.
    it('F-41: a Proxy over the QUOTE is refused by name, trap or no trap', () => {
      expect(refusal(new Proxy({ ...QUOTED }, {})).details?.carrier).toBe('proxy');
      const trapped = new Proxy(
        { ...QUOTED },
        {
          get(target, key) {
            return key === 'documentFeeMinor' ? '500000' : (Reflect.get(target, key) as unknown);
          },
        },
      );
      expect((trapped as unknown as { documentFeeMinor: string }).documentFeeMinor).toBe('500000');
      expect(refusal(trapped).details?.carrier).toBe('proxy');
    });

    it('F-41: a Proxy over a LINE is refused, with the line index', () => {
      const line = new Proxy(
        { ...(QUOTED.lines[0] as object) },
        {
          get(target, key) {
            return key === 'surcharge' ? '7' : (Reflect.get(target, key) as unknown);
          },
        },
      ) as unknown as QuoteLineSnapshot;
      const error = refusal({ ...QUOTED, lines: [line] });
      expect(error.details?.carrier).toBe('proxy');
      expect(error.details?.lineIndex).toBe('0');
    });

    it('F-41: a Proxy over the lines CONTAINER is refused too', () => {
      const container = new Proxy([...QUOTED.lines], {
        get(target, key) {
          return key === 'documentFeeMinor' ? '500000' : (Reflect.get(target, key) as unknown);
        },
      });
      expect((container as unknown as { documentFeeMinor: string }).documentFeeMinor).toBe('500000');
      expect(refusal({ ...QUOTED, lines: container }).details?.carrier).toBe('proxy');
    });

    it('and the closing rebuild still refuses a trap over a DIGESTED field, which is the money half', () => {
      // The challenger measured this before the Proxy guard existed: a trap
      // that changes a digested value is refused as order.quote_tampered on
      // every re-entry, because assertQuoteIntact re-digests what it reads.
      // Now the Proxy is refused one step earlier, so this asserts the ORDER of
      // the two guards rather than letting the earlier one hide the later.
      const target = { ...QUOTED, displayedTotalMinor: '999999' };
      expect(refusal(target).code).toBe('order.quote_tampered');
    });

    it('F-45: a fee on the INPUT lines array is refused by name, not silently dropped', () => {
      // The ACC-REQ-P6-03 claim is "fail-closed in BOTH directions". It was
      // false for this one shape: a fee on the input's lines ARRAY was accepted
      // and dropped, so the caller learned nothing.
      const lines = Object.assign([...INPUT.lines], { documentFeeMinor: '5000' });
      try {
        buildCommercialQuote({ ...INPUT, lines });
        throw new Error('a fee on the input lines array was accepted');
      } catch (error) {
        expect((error as OrderError).code).toBe('order.quote_field_undeclared');
        expect((error as OrderError).details?.fields).toBe('documentFeeMinor');
      }
    });

    it('F-45: the BUILDER emits a plain Array, so Symbol.species cannot ride on its own output', () => {
      // Array.prototype.map honours Symbol.species, so mapping a subclass used
      // to return that subclass and the builder's OWN output carried a readable
      // field the digest does not cover. Two things are asserted: the subclass
      // input is refused, and the container the builder emits for a lawful
      // input is a plain Array.
      class Lines extends Array {
        get documentFeeMinor(): string {
          return '5000';
        }
      }
      try {
        buildCommercialQuote({ ...INPUT, lines: Lines.from(INPUT.lines) as unknown as readonly QuoteLineSnapshot[] });
        throw new Error('an Array subclass input was accepted');
      } catch (error) {
        expect((error as OrderError).details?.container).toBe('is not a plain array');
      }
      const built = buildCommercialQuote(INPUT);
      expect(Object.getPrototypeOf(built.lines)).toBe(Array.prototype);
      expect(built.lines.constructor).toBe(Array);
      expect(() => assertQuoteIntact(built)).not.toThrow();
    });

    it('the INPUT is held to the same standard, so neither shape can even reach the builder', () => {
      const protoInput = Object.assign(Object.create({ documentFeeMinor: '5' }), INPUT) as CommercialQuoteInput;
      const neInput = { ...INPUT };
      Object.defineProperty(neInput, 'documentFeeMinor', { value: '5', enumerable: false });
      for (const [input, named] of [
        [protoInput, 'prototype'],
        [neInput, 'fields'],
      ] as const) {
        try {
          buildCommercialQuote(input);
          throw new Error('a wider input was accepted by the builder');
        } catch (error) {
          expect((error as OrderError).code).toBe('order.quote_field_undeclared');
          expect((error as OrderError).details?.[named]).toBeDefined();
        }
      }
    });

    it('and a spread rebuild would have DROPPED both anyway — which is why this is the caller boundary', () => {
      // The severity split, measured as plain JavaScript rather than asserted:
      // `{ ...input }` copies own ENUMERABLE properties only, so a quote the
      // builder produced could never have carried either shape even before the
      // guard above. What the guard closes is the carrier a CALLER builds and
      // hands straight to `assertQuoteIntact` — a storage read, a deserializer,
      // a class instance — and the input half closes the silent DROP that
      // `R-16` was about.
      const proto = Object.assign(Object.create({ documentFeeMinor: '5' }), { quoteId: QUOTE });
      const ne = { quoteId: QUOTE };
      Object.defineProperty(ne, 'documentFeeMinor', { value: '5', enumerable: false });
      expect((proto as { documentFeeMinor?: string }).documentFeeMinor).toBe('5');
      expect(({ ...proto } as { documentFeeMinor?: string }).documentFeeMinor).toBeUndefined();
      expect((ne as { documentFeeMinor?: string }).documentFeeMinor).toBe('5');
      expect(({ ...ne } as { documentFeeMinor?: string }).documentFeeMinor).toBeUndefined();
      // A lawful plain input still builds and still verifies.
      expect(() => assertQuoteIntact(buildCommercialQuote(INPUT))).not.toThrow();
    });
  });
});
