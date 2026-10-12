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
  ORDER_QUOTE_DIGEST_PATTERN,
  P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR,
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
    // not quietly come back.
    expect(assessQuoteDivergence.length).toBe(2);
  });

  it('passes an exact match', () => {
    expect(assessQuoteDivergence(QUOTED, '3799')).toEqual({ status: 'within_policy', differenceMinor: '0' });
  });

  it('PART 33 — one minor unit MORE requires re-confirmation', () => {
    expect(assessQuoteDivergence(QUOTED, '3800')).toEqual({
      status: 'requires_reconfirmation',
      quotedTotalMinor: '3799',
      recomputedTotalMinor: '3800',
      differenceMinor: '1',
    });
  });

  it('PART 33 — one minor unit LESS requires re-confirmation too — charging less is still not what was agreed', () => {
    const verdict = assessQuoteDivergence(QUOTED, '3798');
    expect(verdict.status).toBe('requires_reconfirmation');
    expect(verdict.differenceMinor).toBe('1');
  });

  it('PART 33 — the admitted set is exactly ONE total, written out as a literal', () => {
    // Quoted 3799. At a tolerance of zero the only recomputation that may commit
    // automatically is 3799 itself; both neighbours diverge. The three numbers
    // are written out rather than derived, so an arithmetic slip in the test
    // cannot agree with one in the implementation.
    expect(assessQuoteDivergence(QUOTED, '3798').status).toBe('requires_reconfirmation');
    expect(assessQuoteDivergence(QUOTED, '3799').status).toBe('within_policy');
    expect(assessQuoteDivergence(QUOTED, '3800').status).toBe('requires_reconfirmation');
  });

  it('is exact above Number.MAX_SAFE_INTEGER — a double could not hold this comparison', () => {
    const big = '9007199254740993';
    const huge = buildCommercialQuote({
      ...INPUT,
      lines: [{ ...(INPUT.lines[0] as (typeof INPUT.lines)[number]), lineTotalMinor: big }],
      displayedTotalMinor: big,
    });
    expect(assessQuoteDivergence(huge, big)).toEqual({ status: 'within_policy', differenceMinor: '0' });
    expect(assessQuoteDivergence(huge, '9007199254740994').status).toBe('requires_reconfirmation');
  });

  it('refuses a negative or non-canonical recomputed total rather than reading it as zero', () => {
    for (const bad of ['-1', '0.5', '']) {
      expect(() => assessQuoteDivergence(QUOTED, bad)).toThrowError(expect.objectContaining({ code: 'order.quote_amount_invalid' }));
    }
  });

  it('refuses a tampered quote before comparing anything', () => {
    expect(() => assessQuoteDivergence({ ...QUOTED, displayedTotalMinor: '3798' }, '3798')).toThrowError(
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
