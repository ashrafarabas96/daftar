import { describe, expect, it } from 'vitest';
import { AccountingError } from '../src/errors';
import { convertToBaseMinor, isExactConversion, rateScaled } from '../src/fx';

const convert = (txnAmountMinor: bigint, txnCurrency: string, baseCurrency: string, fxRate: string): bigint =>
  convertToBaseMinor({ txnAmountMinor, txnCurrency, baseCurrency, fxRate });

describe('exact FX conversion — the scale', () => {
  it('scales a rate to an exact integer at ten fraction digits', () => {
    expect(rateScaled('1')).toBe(10_000_000_000n);
    expect(rateScaled('3.72')).toBe(37_200_000_000n);
    expect(rateScaled('0.709')).toBe(7_090_000_000n);
    expect(rateScaled('0.0000000001')).toBe(1n);
  });

  it('converts at rate 1 without changing the amount', () => {
    expect(convert(150_000n, 'ILS', 'ILS', '1')).toBe(150_000n);
  });

  it('converts between two-decimal currencies', () => {
    // $100.00 at 3.72 → ₪372.00
    expect(convert(10_000n, 'USD', 'ILS', '3.72')).toBe(37_200n);
  });

  it('converts across different minor-unit exponents (USD 2 → JOD 3)', () => {
    // $100.00 at 0.709 → 70.900 JOD, i.e. 70900 fils
    expect(convert(10_000n, 'USD', 'JOD', '0.709')).toBe(70_900n);
  });

  it('converts across exponents in the other direction (JOD 3 → USD 2)', () => {
    // 70.900 JOD at 1.410437 → $100.00 (rounded half-even)
    expect(convert(70_900n, 'JOD', 'USD', '1.4104372355')).toBe(10_000n);
  });

  it('stays exact far above Number.MAX_SAFE_INTEGER', () => {
    // The AL-10 cap is 10^18, which a double cannot represent exactly.
    const cap = 1_000_000_000_000_000_000n;
    expect(convert(cap, 'ILS', 'ILS', '1')).toBe(cap);
    expect(convert(cap, 'USD', 'ILS', '3.72')).toBe(3_720_000_000_000_000_000n);
  });
});

describe('exact FX conversion — HALF_EVEN, where naive rounding diverges', () => {
  // Every case below lands exactly on .5, which is the only place HALF_EVEN
  // and "round half away from zero" disagree. PostgreSQL's ROUND() and
  // JavaScript's Math.round both round half away from zero, so if either ever
  // crept into an implementation these are the tests that would fail.
  const ties: ReadonlyArray<readonly [bigint, string, bigint, string]> = [
    [1n, '2.5', 2n, '2.5 → 2 (quotient 2 is even)'],
    [3n, '0.5', 2n, '1.5 → 2 (quotient 1 is odd, rounds up to even)'],
    [5n, '0.5', 2n, '2.5 → 2 (quotient 2 is even, stays)'],
    [7n, '0.5', 4n, '3.5 → 4 (quotient 3 is odd, rounds up)'],
    [9n, '0.5', 4n, '4.5 → 4 (quotient 4 is even, stays)'],
    [11n, '0.5', 6n, '5.5 → 6 (quotient 5 is odd, rounds up)'],
  ];

  for (const [amount, rate, expected, why] of ties) {
    it(why, () => {
      expect(convert(amount, 'ILS', 'ILS', rate)).toBe(expected);
    });
  }

  it('half-away-from-zero would disagree on an even tie, proving HALF_EVEN is really used', () => {
    // 2.5 rounds to 3 under half-away-from-zero and to 2 under HALF_EVEN.
    expect(convert(5n, 'ILS', 'ILS', '0.5')).toBe(2n);
    expect(Math.round(2.5)).toBe(3);
  });

  it('rounds normally when the remainder is not a tie', () => {
    expect(convert(1n, 'ILS', 'ILS', '2.4')).toBe(2n);
    expect(convert(1n, 'ILS', 'ILS', '2.6')).toBe(3n);
    expect(convert(1n, 'ILS', 'ILS', '2.4999999999')).toBe(2n);
    expect(convert(1n, 'ILS', 'ILS', '2.5000000001')).toBe(3n);
  });
});

describe('exact FX conversion — refusals', () => {
  it('refuses a non-positive transaction amount', () => {
    expect(() => convert(0n, 'ILS', 'ILS', '1')).toThrow(AccountingError);
    expect(() => convert(-1n, 'ILS', 'ILS', '1')).toThrow(AccountingError);
  });

  it('refuses a zero rate', () => {
    expect(() => convert(100n, 'ILS', 'ILS', '0')).toThrow(AccountingError);
  });

  it('refuses a rate with more than ten fraction digits rather than truncating it', () => {
    expect(() => convert(100n, 'ILS', 'ILS', '1.00000000001')).toThrow(AccountingError);
  });

  it('refuses a rate that is not a decimal string', () => {
    expect(() => convert(100n, 'ILS', 'ILS', '1e-3')).toThrow(AccountingError);
    expect(() => convert(100n, 'ILS', 'ILS', '-1')).toThrow(AccountingError);
  });
});

describe('isExactConversion — the check the engine makes before the ledger does', () => {
  it('accepts the exact value', () => {
    expect(isExactConversion({ baseAmountMinor: 37_200n, txnAmountMinor: 10_000n, txnCurrency: 'USD', baseCurrency: 'ILS', fxRate: '3.72' })).toBe(true);
  });

  it('rejects a value one minor unit off in either direction', () => {
    for (const off of [37_199n, 37_201n]) {
      expect(isExactConversion({ baseAmountMinor: off, txnAmountMinor: 10_000n, txnCurrency: 'USD', baseCurrency: 'ILS', fxRate: '3.72' })).toBe(false);
    }
  });
});
