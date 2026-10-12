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
} from '../src';

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

  it('does NOT derive a line total from the unit price and the quantity', () => {
    // 2 × 1500 − 200 is 2800, and a line that said 9999 would be arithmetically
    // wrong — but deriving the right answer needs a rounding policy at the
    // product's unit precision, and a policy invented here would be a second
    // money truth. So the figure is carried verbatim and only the SUM is
    // checked, which this case documents by passing.
    const odd = buildCommercialQuote({
      ...INPUT,
      lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), lineTotalMinor: '9999' }],
      displayedTotalMinor: '9999',
    });
    expect(odd.displayedTotalMinor).toBe('9999');
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
    const huge = buildCommercialQuote({
      ...INPUT,
      lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), lineTotalMinor: big }],
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
    const fractional = { ...INPUT, lines: [{ ...first, quantity: '2.5000' }, ...INPUT.lines.slice(1)] };
    // Without a precision the law is not claimed: 2.5 of something is a fine
    // quantity until a caller says the product is sold in whole units.
    expect(buildCommercialQuote(fractional).lines[0]?.quantity).toBe('2.5000');
    expect(() => buildCommercialQuote(fractional, { unitDecimalsByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, 0]]) })).toThrowError(
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
  const ONE_LINE: Omit<CommercialQuote, 'digest'> = { ...INPUT, lines: [{ ...LINE, lineTotalMinor: '1000' }], displayedTotalMinor: '1000' };

  it('a forged quote really does carry a valid digest — otherwise these cases prove nothing', () => {
    const forged = forge({ ...ONE_LINE, displayedTotalMinor: '999999' });
    const { digest, ...rest } = forged;
    expect(createHash('sha256').update(canonicalQuoteBytes(rest), 'utf8').digest('hex')).toBe(digest);
  });

  it('refuses a displayed total that does not equal its own lines, even with a valid digest', () => {
    // The challenger's case: the builder refuses 999999 against lines summing
    // to 1000, and the hand-built quote carrying that same illegal total used to
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
    const forged = forge({ ...ONE_LINE, lines: [{ ...LINE, lineTotalMinor: '1000', quantity: '-5.0000' }] });
    expect(() => assertQuoteIntact(forged)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('refuses a forged duplicate stock key, which used to collapse the hand-off per-key map', () => {
    // Two lines on one stock key: `new Map(lines.map(...))` keeps the LAST, so a
    // quote whose first line granted 0 and whose second granted 77 admitted a
    // requested 77 while the size check still agreed with one position.
    const forged = forge({
      ...INPUT,
      lines: [
        { ...LINE, discountMinor: '0', lineTotalMinor: '1000' },
        { ...LINE, discountMinor: '77', lineTotalMinor: '1000' },
      ],
      displayedTotalMinor: '2000',
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
  const WHOLE_UNITS = { unitDecimalsByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, 0]]) };
  const HALF = { ...INPUT, lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), quantity: '2.5000' }, ...INPUT.lines.slice(1)] };

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
      const checks = { unitDecimalsByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, bad]]) };
      expect(() => buildCommercialQuote(INPUT, checks)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_invalid' }));
      expect(() => assertQuoteApproved(approve(QUOTED), ORDER, checks)).toThrowError(expect.objectContaining({ code: 'order.unit_precision_invalid' }));
    }
    // And a lawful precision still reaches the quantity law, so the new guard
    // did not swallow the old one.
    expect(() => buildCommercialQuote(HALF, WHOLE_UNITS)).toThrowError(expect.objectContaining({ code: 'order.quote_quantity_invalid' }));
  });

  it('lets the explicit argument win over the approval own checks when they disagree', () => {
    const forged = buildCommercialQuote(HALF);
    const atQ4 = { unitDecimalsByStockKey: new Map([[`${PRODUCT_A}:${VARIANT}`, 4]]) };
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
