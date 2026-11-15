import { describe, expect, it } from 'vitest';
import { BillingError } from '../src/errors';
import { billingPeriodByIndex, periodLengthMs } from '../src/period';
import { divHalfEven, proratePlanChange, proratedAmountMinor } from '../src/proration';
import type { BillingPeriod, Price } from '../src/types';

function expectRefusal(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
}

/** A 30-day period, so halves and quarters are exact and a tie is reachable. */
const APRIL: BillingPeriod = { startsAt: '2026-04-01T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' };
const ILS = (amountMinor: bigint): Price => ({ amountMinor, currency: 'ILS' });

describe('divHalfEven', () => {
  it('rounds a remainder below half down and above half up', () => {
    expect(divHalfEven(10n, 4n)).toBe(2n); // 2.5 → tie → even → 2
    expect(divHalfEven(11n, 4n)).toBe(3n); // 2.75 → up
    expect(divHalfEven(9n, 4n)).toBe(2n); // 2.25 → down
  });

  it('resolves an exact tie to the EVEN quotient, in both directions', () => {
    expect(divHalfEven(5n, 2n)).toBe(2n); // 2.5 → 2 (even)
    expect(divHalfEven(7n, 2n)).toBe(4n); // 3.5 → 4 (even)
    expect(divHalfEven(1n, 2n)).toBe(0n); // 0.5 → 0 (even)
    expect(divHalfEven(3n, 2n)).toBe(2n); // 1.5 → 2 (even)
  });

  it('agrees with the accounting engine on the rule, not merely on a result', () => {
    // Half-even is not half-up: these two cases are where they differ, and a
    // slice that used half-up would pass every other case in this file.
    expect(divHalfEven(5n, 2n)).not.toBe(3n);
    expect(divHalfEven(1n, 2n)).not.toBe(1n);
  });

  it('is exact far above Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1, unrepresentable as a double
    expect(divHalfEven(big * 4n, 4n)).toBe(big);
  });

  it('refuses a non-positive divisor and a negative numerator', () => {
    expectRefusal(() => divHalfEven(1n, 0n), 'billing.payload_invalid');
    expectRefusal(() => divHalfEven(1n, -2n), 'billing.payload_invalid');
    expectRefusal(() => divHalfEven(-1n, 2n), 'billing.payload_invalid');
  });
});

describe('proratedAmountMinor', () => {
  it('charges the whole price when the instant is the period start', () => {
    expect(proratedAmountMinor(ILS(12_000n), APRIL, APRIL.startsAt)).toBe(12_000n);
  });

  it('charges half for the exact midpoint of a 30-day period', () => {
    expect(proratedAmountMinor(ILS(12_000n), APRIL, '2026-04-16T00:00:00.000Z')).toBe(6_000n);
  });

  it('charges one day of thirty on the last day', () => {
    expect(proratedAmountMinor(ILS(12_000n), APRIL, '2026-04-30T00:00:00.000Z')).toBe(400n);
  });

  it('never exceeds the whole price and never goes below zero, across the whole period', () => {
    const price = ILS(99_991n); // a prime-ish amount, so most instants round
    const total = periodLengthMs(APRIL);
    for (let step = 0; step < 720; step++) {
      const at = new Date(Date.parse(APRIL.startsAt) + Math.floor((total * step) / 720)).toISOString();
      const part = proratedAmountMinor(price, APRIL, at);
      expect(part).toBeGreaterThanOrEqual(0n);
      expect(part).toBeLessThanOrEqual(price.amountMinor);
    }
  });

  it('is monotonically non-increasing as the instant moves later', () => {
    // A later start can never cost more than an earlier one. This is the
    // property a rounding mistake breaks first, and no single case shows it.
    const price = ILS(99_991n);
    const total = periodLengthMs(APRIL);
    let previous = price.amountMinor + 1n;
    for (let step = 0; step < 500; step++) {
      const at = new Date(Date.parse(APRIL.startsAt) + Math.floor((total * step) / 500)).toISOString();
      const part = proratedAmountMinor(price, APRIL, at);
      expect(part).toBeLessThanOrEqual(previous);
      previous = part;
    }
  });

  it('prorates zero to zero without refusing', () => {
    expect(proratedAmountMinor(ILS(0n), APRIL, '2026-04-16T00:00:00.000Z')).toBe(0n);
  });

  it('refuses the exclusive end instant, which belongs to the next period', () => {
    expectRefusal(() => proratedAmountMinor(ILS(12_000n), APRIL, APRIL.endsAt), 'billing.proration_outside_period');
  });

  it('refuses an instant before the period start', () => {
    expectRefusal(() => proratedAmountMinor(ILS(12_000n), APRIL, '2026-03-31T23:59:59.999Z'), 'billing.proration_outside_period');
  });

  it('refuses a malformed price', () => {
    expectRefusal(() => proratedAmountMinor({ amountMinor: -1n, currency: 'ILS' }, APRIL, APRIL.startsAt), 'billing.price_invalid');
    expectRefusal(() => proratedAmountMinor({ amountMinor: 1n, currency: 'ils' }, APRIL, APRIL.startsAt), 'billing.price_invalid');
    expectRefusal(() => proratedAmountMinor({ amountMinor: 1200 as unknown as bigint, currency: 'ILS' }, APRIL, APRIL.startsAt), 'billing.price_invalid');
    expectRefusal(() => proratedAmountMinor({ amountMinor: 10n ** 18n + 1n, currency: 'ILS' }, APRIL, APRIL.startsAt), 'billing.price_invalid');
  });
});

describe('proratePlanChange', () => {
  it('returns both sides and their exact difference on an upgrade', () => {
    const result = proratePlanChange({
      period: APRIL,
      changeAt: '2026-04-16T00:00:00.000Z',
      from: ILS(12_000n),
      to: ILS(30_000n),
    });
    expect(result.creditMinor).toBe(6_000n);
    expect(result.chargeMinor).toBe(15_000n);
    expect(result.netMinor).toBe(9_000n);
    expect(result.netMinor).toBe(result.chargeMinor - result.creditMinor);
    expect(result.currency).toBe('ILS');
    expect(result.periodMs).toBe(periodLengthMs(APRIL));
    expect(result.remainingMs).toBe(periodLengthMs(APRIL) / 2);
  });

  it('returns a NEGATIVE net on a downgrade rather than clamping it to zero', () => {
    // Clamping would silently keep money the merchant is owed. What to do
    // with the credit is a policy; losing it is not an option.
    const result = proratePlanChange({
      period: APRIL,
      changeAt: '2026-04-16T00:00:00.000Z',
      from: ILS(30_000n),
      to: ILS(12_000n),
    });
    expect(result.netMinor).toBe(-9_000n);
  });

  it('nets to zero when the price is unchanged, at every instant of the period', () => {
    const total = periodLengthMs(APRIL);
    for (let step = 0; step < 240; step++) {
      const at = new Date(Date.parse(APRIL.startsAt) + Math.floor((total * step) / 240)).toISOString();
      const result = proratePlanChange({ period: APRIL, changeAt: at, from: ILS(77_777n), to: ILS(77_777n) });
      expect(result.netMinor).toBe(0n);
    }
  });

  it('prices the two sides independently, and that is NOT the same number as prorating the difference', () => {
    // The tempting shortcut is one rounding on (to − from). Here it gives a
    // different answer, so this is a measured difference and not a stylistic
    // preference: a quarter of the period remains, from = 1, to = 3.
    //   two roundings: HALF_EVEN(3/4) − HALF_EVEN(1/4) = 1 − 0 = 1
    //   one rounding:  HALF_EVEN(2/4) = HALF_EVEN(0.5) = 0  (tie → even)
    const total = periodLengthMs(APRIL);
    const threeQuarters = new Date(Date.parse(APRIL.startsAt) + (total * 3) / 4).toISOString();
    const result = proratePlanChange({ period: APRIL, changeAt: threeQuarters, from: ILS(1n), to: ILS(3n) });
    expect(result.remainingMs).toBe(total / 4);
    expect(result.creditMinor).toBe(0n);
    expect(result.chargeMinor).toBe(1n);
    expect(result.netMinor).toBe(1n);

    // The shortcut, computed here with the SAME rounding rule so the only
    // difference under test is where the rounding happens.
    const shortcut = divHalfEven((3n - 1n) * BigInt(result.remainingMs), BigInt(total));
    expect(shortcut).toBe(0n);
    expect(result.netMinor).not.toBe(shortcut);
  });

  it('refuses a currency change inside one period', () => {
    expectRefusal(
      () =>
        proratePlanChange({
          period: APRIL,
          changeAt: '2026-04-16T00:00:00.000Z',
          from: ILS(12_000n),
          to: { amountMinor: 3_000n, currency: 'USD' },
        }),
      'billing.proration_currency_mismatch',
    );
  });

  it('refuses a change instant outside the period', () => {
    expectRefusal(() => proratePlanChange({ period: APRIL, changeAt: APRIL.endsAt, from: ILS(12_000n), to: ILS(30_000n) }), 'billing.proration_outside_period');
  });

  it('works on a real anchored period, including a clamped short month', () => {
    const february = billingPeriodByIndex({ anchorAt: '2026-01-31T00:00:00.000Z', interval: 'month' }, 1);
    expect(february.startsAt).toBe('2026-02-28T00:00:00.000Z');
    const result = proratePlanChange({
      period: february,
      changeAt: '2026-03-15T00:00:00.000Z',
      from: ILS(31_000n),
      to: ILS(62_000n),
    });
    expect(result.chargeMinor).toBe(result.creditMinor * 2n);
    expect(result.creditMinor).toBeLessThan(31_000n);
  });
});
