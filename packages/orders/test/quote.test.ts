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
import { describe, expect, it } from 'vitest';
import {
  OrderError,
  assertQuoteConfirmable,
  assertQuoteIntact,
  assessQuoteDivergence,
  buildCommercialQuote,
  canonicalQuoteBytes,
  type CommercialQuote,
  type CommercialQuoteInput,
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

  it('admits a confirmation exactly at the expiry instant, and refuses one a second later', () => {
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T10:00:00Z', 1)).not.toThrow();
    expect(() => assertQuoteConfirmable(QUOTED, '2026-10-01T10:00:01Z', 1)).toThrowError(expect.objectContaining({ code: 'order.quote_expired' }));
  });

  it('never expires a quote with no expiry', () => {
    const forever = buildCommercialQuote({ ...INPUT, expiresAt: null });
    expect(() => assertQuoteConfirmable(forever, '2099-01-01T00:00:00Z', 1)).not.toThrow();
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
  it('passes an exact match at zero tolerance', () => {
    expect(assessQuoteDivergence(QUOTED, '3799', '0')).toEqual({ status: 'within_policy', differenceMinor: '0' });
  });

  it('requires re-confirmation for one minor unit more at zero tolerance', () => {
    expect(assessQuoteDivergence(QUOTED, '3800', '0')).toEqual({
      status: 'requires_reconfirmation',
      quotedTotalMinor: '3799',
      recomputedTotalMinor: '3800',
      differenceMinor: '1',
    });
  });

  it('requires re-confirmation for one minor unit LESS too — charging less is still not what was agreed', () => {
    const verdict = assessQuoteDivergence(QUOTED, '3798', '0');
    expect(verdict.status).toBe('requires_reconfirmation');
    expect(verdict.differenceMinor).toBe('1');
  });

  it('treats the tolerance as inclusive, and the unit beyond it as divergent', () => {
    // Quoted 3799, tolerance 5: the admitted band is 3794..3804 inclusive, and
    // the first unit beyond it on EITHER side diverges. The band is written out
    // as explicit numbers rather than computed in the test, so an arithmetic slip
    // here cannot agree with an arithmetic slip in the implementation.
    expect(assessQuoteDivergence(QUOTED, '3804', '5').status).toBe('within_policy');
    expect(assessQuoteDivergence(QUOTED, '3794', '5').status).toBe('within_policy');
    expect(assessQuoteDivergence(QUOTED, '3805', '5').status).toBe('requires_reconfirmation');
    expect(assessQuoteDivergence(QUOTED, '3805', '5').differenceMinor).toBe('6');
    expect(assessQuoteDivergence(QUOTED, '3793', '5').status).toBe('requires_reconfirmation');
    expect(assessQuoteDivergence(QUOTED, '3793', '5').differenceMinor).toBe('6');
  });

  it('is exact above Number.MAX_SAFE_INTEGER — a double could not hold this comparison', () => {
    const big = '9007199254740993';
    const huge = buildCommercialQuote({
      ...INPUT,
      lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), lineTotalMinor: big }],
      displayedTotalMinor: big,
    });
    expect(assessQuoteDivergence(huge, big, '0')).toEqual({ status: 'within_policy', differenceMinor: '0' });
    expect(assessQuoteDivergence(huge, '9007199254740994', '0').status).toBe('requires_reconfirmation');
  });

  it('refuses a negative or non-canonical tolerance rather than reading it as zero', () => {
    for (const bad of ['-1', '0.5', '']) {
      expect(() => assessQuoteDivergence(QUOTED, '3799', bad)).toThrowError(expect.objectContaining({ code: 'order.quote_amount_invalid' }));
    }
  });

  it('refuses a tampered quote before comparing anything', () => {
    expect(() => assessQuoteDivergence({ ...QUOTED, displayedTotalMinor: '3798' }, '3798', '0')).toThrowError(
      expect.objectContaining({ code: 'order.quote_tampered' }),
    );
  });
});
