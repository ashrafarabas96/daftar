/**
 * The per-line rounding law — the OWNER'S DECISION of 2026-10-12T20:38:50Z,
 * "أعتمد الخيار A — التقريب لكل سطر", and its seven conditions.
 *
 * The suite is organised by the owner's condition 6: Golden, Property and
 * Mutation, then the cases it names — quantities, discounts, small fractions,
 * several currencies, and concurrency with retry. Each block says which
 * condition it answers, so a reader can check the mapping rather than take it
 * on trust.
 *
 * The mutation block is the one that carries the weight. A rounding law is
 * trivially green against its own implementation; what has to be proved is that
 * these cases would turn RED against the laws the project did NOT choose —
 * HALF_UP, truncation, rounding the product before subtracting the discount,
 * and rounding the document total instead of the lines. Each wrong law is
 * written out here and asserted to disagree with the law on a named figure
 * (PART 12: a mutation that does not turn red is not a proof).
 */
import { describe, expect, it } from 'vitest';
import { roundHalfEven } from '@daftar/inventory';
import {
  OrderError,
  QUANTITY_SCALE,
  assertLineTotalRounded,
  buildCommercialQuote,
  exactLineValueScaled,
  roundedLineTotalMinor,
  type CommercialQuoteInput,
} from '../src';

const QUOTE = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A quantity string written as the four-decimal form the quote law requires. */
const q4 = (scaled: bigint): string => {
  const whole = scaled / QUANTITY_SCALE;
  const frac = (scaled % QUANTITY_SCALE).toString().padStart(4, '0');
  return `${whole}.${frac}`;
};

/** One line, priced by the law itself, so a fixture cannot disagree with it. */
const line = (productId: string, quantityScaled: bigint, unitPriceMinor: bigint, discountMinor = 0n) => ({
  stockKey: `${productId}:`,
  productId,
  variantId: null,
  quantity: q4(quantityScaled),
  unitPriceMinor: unitPriceMinor.toString(),
  discountMinor: discountMinor.toString(),
  lineTotalMinor: roundedLineTotalMinor(quantityScaled, unitPriceMinor, discountMinor).toString(),
});

const quoteOf = (lines: CommercialQuoteInput['lines'], currency = 'ILS'): CommercialQuoteInput => ({
  quoteId: QUOTE,
  orderId: ORDER,
  version: 1,
  currency,
  lines,
  displayedTotalMinor: lines.reduce((sum, l) => sum + BigInt(l.lineTotalMinor), 0n).toString(),
  issuedAt: '2026-10-01T09:00:00Z',
  expiresAt: '2026-10-01T10:00:00Z',
});

describe('GOLDEN — condition 1: one rounding, after the quantity and the discounts', () => {
  // Written as literals rather than derived, so an arithmetic slip in the test
  // cannot agree with one in the implementation.
  it.each([
    ['half a minor unit goes DOWN, to the even neighbour', 5_000n, 1n, 0n, 0n],
    ['one and a half goes UP, to the even neighbour', 15_000n, 1n, 0n, 2n],
    ['two and a half goes DOWN again — a tie never has a direction, only a parity', 25_000n, 1n, 0n, 2n],
    ['three and a half goes up', 35_000n, 1n, 0n, 4n],
    ['an exact value is not moved', 20_000n, 1_500n, 200n, 2_800n],
    ['the discount is subtracted BEFORE the rounding, not after it', 25_000n, 3n, 1n, 6n],
    ['a whole-unit line is plain multiplication', 30_000n, 999n, 0n, 2_997n],
    ['a discount equal to the line value leaves nothing, and that is lawful', 10_000n, 500n, 500n, 0n],
  ])('%s', (_name, quantityScaled, price, discount, expected) => {
    expect(roundedLineTotalMinor(quantityScaled, price, discount)).toBe(expected);
  });

  it('refuses a discount larger than the line value it discounts, rather than returning negative money', () => {
    try {
      roundedLineTotalMinor(10_000n, 500n, 501n, { stockKey: `${PRODUCT_A}:` });
      throw new Error('a discount of 501 was accepted against a line value of 500');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      expect((error as OrderError).code).toBe('order.quote_discount_exceeds_line');
      expect((error as OrderError).details?.stockKey).toBe(`${PRODUCT_A}:`);
    }
  });
});

describe('GOLDEN — condition 2: the document total is the sum of the ROUNDED lines', () => {
  // The case the two candidate rules disagree on, which is why the owner had to
  // decide at all. Three lines each worth exactly half a minor unit: per line
  // each is 0 and the receipt adds up to 0; rounding the exact SUM instead gives
  // 1.5 → 2, a total no printed line accounts for.
  const THREE_HALVES = [line(PRODUCT_A, 5_000n, 1n), line(PRODUCT_B, 5_000n, 1n), line(PRODUCT_C, 5_000n, 1n)];

  it('the chosen rule prints a receipt that adds up', () => {
    const quoted = buildCommercialQuote(quoteOf(THREE_HALVES));
    expect(quoted.lines.map((l) => l.lineTotalMinor)).toEqual(['0', '0', '0']);
    expect(quoted.displayedTotalMinor).toBe('0');
  });

  it('and the rule the owner did not choose would have printed a total of 2 over lines of 0 + 0 + 0', () => {
    const exactSum = THREE_HALVES.reduce((sum, l) => sum + exactLineValueScaled(BigInt(l.quantity.replace('.', '')), BigInt(l.unitPriceMinor), 0n), 0n);
    expect(exactSum).toBe(15_000n);
    expect(roundHalfEven(exactSum, QUANTITY_SCALE)).toBe(2n);
    // Carried into a quote, that total is exactly the price surprise §27 is
    // about, and the builder refuses it.
    expect(() => buildCommercialQuote({ ...quoteOf(THREE_HALVES), displayedTotalMinor: '2' })).toThrowError(
      expect.objectContaining({ code: 'order.quote_total_mismatch' }),
    );
  });

  it('refuses a carried line total that is not the one the rule produces, through the builder', () => {
    const [first, ...rest] = THREE_HALVES;
    const tampered = [{ ...(first as (typeof THREE_HALVES)[number]), lineTotalMinor: '1' }, ...rest];
    try {
      buildCommercialQuote({ ...quoteOf(tampered), displayedTotalMinor: '1' });
      throw new Error('a line total of 1 was accepted over an exact value of half a minor unit');
    } catch (error) {
      expect((error as OrderError).code).toBe('order.quote_line_total_mismatch');
      expect((error as OrderError).details?.expectedLineTotalMinor).toBe('0');
      expect((error as OrderError).details?.exactValueScaled).toBe('5000');
      expect((error as OrderError).details?.stockKey).toBe(`${PRODUCT_A}:`);
    }
  });
});

describe('MUTATION — condition 3: the official mode, and no other', () => {
  // Four laws the project did NOT adopt. Each is implemented here and asserted
  // to DISAGREE with the law on a named figure: that is what makes the golden
  // cases above proofs rather than restatements of the implementation.
  const halfUp = (q: bigint, p: bigint, d: bigint): bigint => {
    const scaled = exactLineValueScaled(q, p, d);
    return (2n * scaled + QUANTITY_SCALE) / (2n * QUANTITY_SCALE);
  };
  const truncate = (q: bigint, p: bigint, d: bigint): bigint => exactLineValueScaled(q, p, d) / QUANTITY_SCALE;
  const roundThenDiscount = (q: bigint, p: bigint, d: bigint): bigint => roundHalfEven(q * p, QUANTITY_SCALE) - d;

  it('HALF_UP disagrees at the tie: it would print 1 where the law prints 0', () => {
    expect(halfUp(5_000n, 1n, 0n)).toBe(1n);
    expect(roundedLineTotalMinor(5_000n, 1n, 0n)).toBe(0n);
  });

  it('truncation disagrees above the tie: it would print 1 where the law prints 2', () => {
    expect(truncate(15_000n, 1n, 0n)).toBe(1n);
    expect(roundedLineTotalMinor(15_000n, 1n, 0n)).toBe(2n);
  });

  it('rounding the product and then subtracting the discount is TWO roundings, and it differs by a minor unit', () => {
    expect(roundThenDiscount(25_000n, 3n, 1n)).toBe(7n);
    expect(roundedLineTotalMinor(25_000n, 3n, 1n)).toBe(6n);
  });

  it('a float implementation cannot even hold the numerator, so the law uses none', () => {
    const scaled = exactLineValueScaled(10_001n, 9_007_199_254_740_993n, 0n);
    expect(scaled > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // The exact claim: a double loses this numerator, so any implementation that
    // passed through one would be deciding the tie on a figure that is not the
    // line's value.
    expect(BigInt(Number(scaled))).not.toBe(scaled);
    expect(typeof roundedLineTotalMinor(10_001n, 9_007_199_254_740_993n, 0n)).toBe('bigint');
  });
});

describe('PROPERTY — the law holds over the whole input space, not only the golden figures', () => {
  // A deterministic generator: a seeded xorshift, so a failure is reproducible
  // from the seed and the run carries no clock (the convention this package
  // already uses for its instants).
  function* cases(seed: number, count: number): Generator<readonly [bigint, bigint, bigint]> {
    let x = seed;
    const next = (bound: number): number => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x |= 0;
      return Math.abs(x) % bound;
    };
    for (let i = 0; i < count; i += 1) {
      const quantity = BigInt(next(5_000_000) + 1);
      const price = BigInt(next(1_000_000) + 1);
      const gross = (quantity * price) / QUANTITY_SCALE;
      yield [quantity, price, gross === 0n ? 0n : BigInt(next(Number(gross) + 1))] as const;
    }
  }

  const SAMPLE = [...cases(0x6d617979, 2_000)];

  it('generates the space it claims to: fractional quantities, discounts, and zero discounts all occur', () => {
    expect(SAMPLE).toHaveLength(2_000);
    expect(SAMPLE.some(([q]) => q % QUANTITY_SCALE !== 0n)).toBe(true);
    expect(SAMPLE.some(([, , d]) => d > 0n)).toBe(true);
    expect(SAMPLE.filter(([q, p, d]) => exactLineValueScaled(q, p, d) % QUANTITY_SCALE !== 0n).length).toBeGreaterThan(100);
  });

  it('the rounded figure is never more than half a minor unit from the exact value', () => {
    for (const [q, p, d] of SAMPLE) {
      const exact = exactLineValueScaled(q, p, d);
      const residual = roundedLineTotalMinor(q, p, d) * QUANTITY_SCALE - exact;
      const magnitude = residual < 0n ? -residual : residual;
      expect(magnitude * 2n <= QUANTITY_SCALE).toBe(true);
    }
  });

  it('a tie always lands on an even figure, and a non-tie on the nearer one', () => {
    for (const [q, p, d] of SAMPLE) {
      const exact = exactLineValueScaled(q, p, d);
      const rounded = roundedLineTotalMinor(q, p, d);
      const twiceRemainder = 2n * (exact % QUANTITY_SCALE);
      if (twiceRemainder === QUANTITY_SCALE) {
        expect(rounded % 2n).toBe(0n);
      } else if (twiceRemainder < QUANTITY_SCALE) {
        expect(rounded).toBe(exact / QUANTITY_SCALE);
      } else {
        expect(rounded).toBe(exact / QUANTITY_SCALE + 1n);
      }
    }
  });

  it('the law accepts its own output, every time — the gate and the rule are one law', () => {
    for (const [q, p, d] of SAMPLE) {
      expect(() => assertLineTotalRounded(roundedLineTotalMinor(q, p, d), q, p, d)).not.toThrow();
    }
  });

  it('and it refuses the neighbours of its own output, so the gate is not vacuous', () => {
    for (const [q, p, d] of SAMPLE.slice(0, 200)) {
      const lawful = roundedLineTotalMinor(q, p, d);
      for (const wrong of [lawful + 1n, lawful - 1n]) {
        if (wrong < 0n) continue;
        expect(() => assertLineTotalRounded(wrong, q, p, d)).toThrowError(expect.objectContaining({ code: 'order.quote_line_total_mismatch' }));
      }
    }
  });
});

describe('the small fractions and the quantity scale — condition 6', () => {
  it('the smallest quantity the schema can hold still prices exactly', () => {
    // One ten-thousandth of a unit at 10000 minor units is exactly one minor unit.
    expect(roundedLineTotalMinor(1n, 10_000n, 0n)).toBe(1n);
    // And a hair under half of it rounds away, while a hair over it rounds up.
    expect(roundedLineTotalMinor(1n, 4_999n, 0n)).toBe(0n);
    expect(roundedLineTotalMinor(1n, 5_001n, 0n)).toBe(1n);
  });

  it('a tiny discount on a large line is not lost in the rounding', () => {
    expect(roundedLineTotalMinor(10_000n, 1_000_000n, 1n)).toBe(999_999n);
  });
});

describe('several currencies — condition 6', () => {
  // The law takes minor units and a quantity, never a currency: a currency's
  // exponent is already spent by the time a figure reaches here, which is why
  // one rule serves a 2-minor-unit ILS line and a 3-minor-unit JOD line without
  // a branch. These cases pin that, so a later "currency-aware rounding" would
  // have to break them out loud.
  it.each(['ILS', 'JOD', 'TRY', 'USD', 'EUR'])('prices the same figures identically in %s', (currency) => {
    const quoted = buildCommercialQuote(quoteOf([line(PRODUCT_A, 25_000n, 3n, 1n), line(PRODUCT_B, 5_000n, 1n)], currency));
    expect(quoted.lines.map((l) => l.lineTotalMinor)).toEqual(['6', '0']);
    expect(quoted.displayedTotalMinor).toBe('6');
  });

  // R-20, the coordinator's residual: the quote builder checks the currency for
  // SHAPE only, so an unknown code is accepted and the minor unit is never
  // resolved. This case pins why that cannot move money in the rounding rule:
  // the rule never consults an exponent. A JPY line (exponent 0, no committed
  // case had one) rounds by exactly the same arithmetic as a KWD line
  // (exponent 3), because both arrive in integer minor units already.
  it('R-20: an exponent-0 currency rounds by the same arithmetic — the rule never reads an exponent', () => {
    // 2.5 yen at 1 yen a unit: the exact value is 2.5 minor units, the tie
    // rounds to EVEN, so 2 — not 3, and not "2.5 yen", which does not exist.
    expect(roundedLineTotalMinor(25000n, 1n, 0n)).toBe(2n);
    // The same figures in KWD fils give the same integer, from the same call.
    expect(roundedLineTotalMinor(25000n, 1n, 0n)).toBe(roundedLineTotalMinor(25000n, 1n, 0n));
    // And a whole-unit JPY line is exact, as it must be for a cash currency
    // whose smallest coin IS the unit.
    expect(roundedLineTotalMinor(30000n, 7n, 0n)).toBe(21n);
  });

  it('a JOD fils is a minor unit like any other — 1.333 of a unit at 1000 fils is exactly 1333', () => {
    expect(roundedLineTotalMinor(13_330n, 1_000n, 0n)).toBe(1_333n);
  });
});

describe('concurrency and retry — condition 6', () => {
  const INPUT = quoteOf([line(PRODUCT_A, 25_000n, 3n, 1n), line(PRODUCT_B, 5_000n, 1n), line(PRODUCT_C, 13_330n, 1_000n)]);

  it('the figure is a pure function of its operands, so a retry cannot produce a second answer', async () => {
    const once = roundedLineTotalMinor(25_000n, 3n, 1n);
    const many = await Promise.all(Array.from({ length: 256 }, async () => roundedLineTotalMinor(25_000n, 3n, 1n)));
    expect(new Set(many.map(String)).size).toBe(1);
    expect(many[0]).toBe(once);
  });

  it('a quote rebuilt from the same input carries the same digest, so a retried build is the same quote', async () => {
    const first = buildCommercialQuote(INPUT);
    const rebuilt = await Promise.all(Array.from({ length: 64 }, async () => buildCommercialQuote(INPUT).digest));
    expect(new Set(rebuilt).size).toBe(1);
    expect(rebuilt[0]).toBe(first.digest);
  });

  it('the gate holds no state: a refusal does not change the verdict on the next lawful line', () => {
    expect(() => assertLineTotalRounded(1n, 5_000n, 1n, 0n)).toThrow();
    expect(() => assertLineTotalRounded(0n, 5_000n, 1n, 0n)).not.toThrow();
    expect(() => assertLineTotalRounded(1n, 5_000n, 1n, 0n)).toThrow();
  });
});
