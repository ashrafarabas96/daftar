import { describe, expect, it } from 'vitest';
import { BillingError } from '../src/errors';
import { addMonthsUtc, billingPeriodAt, billingPeriodByIndex, daysInMonth, periodContains, periodLengthMs } from '../src/period';
import type { BillingAnchor } from '../src/types';

/** Assert the refusal, by its code — not merely that something threw. */
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

describe('daysInMonth', () => {
  it('knows the Gregorian leap rule at all three of its branches', () => {
    expect(daysInMonth(2024, 2)).toBe(29); // divisible by 4
    expect(daysInMonth(2100, 2)).toBe(28); // century, not divisible by 400
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('knows the thirty-day months', () => {
    expect([4, 6, 9, 11].map((m) => daysInMonth(2026, m))).toEqual([30, 30, 30, 30]);
    expect([1, 3, 5, 7, 8, 10, 12].map((m) => daysInMonth(2026, m))).toEqual([31, 31, 31, 31, 31, 31, 31]);
  });

  it('refuses a month outside 1..12', () => {
    expectRefusal(() => daysInMonth(2026, 0), 'billing.payload_invalid');
    expectRefusal(() => daysInMonth(2026, 13), 'billing.payload_invalid');
  });
});

describe('addMonthsUtc', () => {
  const jan31 = Date.parse('2026-01-31T09:15:30.250Z');

  it('clamps DOWN into a short month and never rolls into the next one', () => {
    expect(new Date(addMonthsUtc(jan31, 1)).toISOString()).toBe('2026-02-28T09:15:30.250Z');
  });

  it('preserves the time of day to the millisecond', () => {
    expect(new Date(addMonthsUtc(jan31, 2)).toISOString()).toBe('2026-03-31T09:15:30.250Z');
  });

  it('borrows a year correctly for a negative count', () => {
    // JavaScript's % keeps the dividend's sign; Math.floor is what makes this
    // December of the previous year rather than month -1.
    expect(new Date(addMonthsUtc(Date.parse('2026-01-15T00:00:00.000Z'), -1)).toISOString()).toBe('2025-12-15T00:00:00.000Z');
    expect(new Date(addMonthsUtc(Date.parse('2026-01-15T00:00:00.000Z'), -13)).toISOString()).toBe('2024-12-15T00:00:00.000Z');
  });

  it('refuses a non-integer month count', () => {
    expectRefusal(() => addMonthsUtc(jan31, 1.5), 'billing.payload_invalid');
  });
});

describe('billingPeriodByIndex', () => {
  const monthly: BillingAnchor = { anchorAt: '2026-01-31T00:00:00.000Z', interval: 'month' };

  it('derives every period from the anchor, so a short month does not steal the anchor day', () => {
    // This is the defect the module exists to prevent: chaining from the
    // previous period's end would give 2026-03-28 here, and the subscription
    // would bill on the 28th for the rest of its life.
    expect(billingPeriodByIndex(monthly, 0)).toEqual({
      index: 0,
      startsAt: '2026-01-31T00:00:00.000Z',
      endsAt: '2026-02-28T00:00:00.000Z',
    });
    expect(billingPeriodByIndex(monthly, 1)).toEqual({
      index: 1,
      startsAt: '2026-02-28T00:00:00.000Z',
      endsAt: '2026-03-31T00:00:00.000Z',
    });
    expect(billingPeriodByIndex(monthly, 2).startsAt).toBe('2026-03-31T00:00:00.000Z');
    expect(billingPeriodByIndex(monthly, 2).endsAt).toBe('2026-04-30T00:00:00.000Z');
  });

  it('makes consecutive periods meet exactly, with no gap and no overlap', () => {
    for (let i = 0; i < 36; i++) {
      expect(billingPeriodByIndex(monthly, i).endsAt).toBe(billingPeriodByIndex(monthly, i + 1).startsAt);
    }
  });

  it('spans twelve months for a yearly interval and survives 29 February', () => {
    const yearly: BillingAnchor = { anchorAt: '2024-02-29T12:00:00.000Z', interval: 'year' };
    expect(billingPeriodByIndex(yearly, 0).endsAt).toBe('2025-02-28T12:00:00.000Z');
    expect(billingPeriodByIndex(yearly, 4).startsAt).toBe('2028-02-29T12:00:00.000Z');
  });

  it('refuses a malformed anchor, an unsupported interval and an out-of-range index', () => {
    expectRefusal(() => billingPeriodByIndex({ anchorAt: 'not-a-date', interval: 'month' }, 0), 'billing.anchor_invalid');
    expectRefusal(() => billingPeriodByIndex({ anchorAt: '', interval: 'month' }, 0), 'billing.anchor_invalid');
    expectRefusal(
      () => billingPeriodByIndex({ anchorAt: '2026-01-01T00:00:00.000Z', interval: 'week' as unknown as 'month' }, 0),
      'billing.interval_unsupported',
    );
    expectRefusal(() => billingPeriodByIndex(monthly, -1), 'billing.period_index_invalid');
    expectRefusal(() => billingPeriodByIndex(monthly, 1.5), 'billing.period_index_invalid');
    expectRefusal(() => billingPeriodByIndex(monthly, 100_001), 'billing.period_index_invalid');
  });
});

describe('billingPeriodAt', () => {
  const monthly: BillingAnchor = { anchorAt: '2026-01-31T00:00:00.000Z', interval: 'month' };

  it('treats the period as half-open: the start is inside, the end is the next period', () => {
    expect(billingPeriodAt(monthly, '2026-01-31T00:00:00.000Z').index).toBe(0);
    expect(billingPeriodAt(monthly, '2026-02-27T23:59:59.999Z').index).toBe(0);
    expect(billingPeriodAt(monthly, '2026-02-28T00:00:00.000Z').index).toBe(1);
  });

  it('finds the containing period across a long walk, and the answer always contains the instant', () => {
    for (let i = 0; i < 60; i++) {
      const period = billingPeriodByIndex(monthly, i);
      const midMs = Date.parse(period.startsAt) + Math.floor(periodLengthMs(period) / 2);
      const found = billingPeriodAt(monthly, new Date(midMs).toISOString());
      expect(found.index).toBe(i);
      expect(periodContains(found, new Date(midMs).toISOString())).toBe(true);
    }
  });

  it('is correct at every boundary of a long walk, which is where the month-estimate needs its correction', () => {
    for (let i = 1; i < 60; i++) {
      const period = billingPeriodByIndex(monthly, i);
      expect(billingPeriodAt(monthly, period.startsAt).index).toBe(i);
      expect(billingPeriodAt(monthly, new Date(Date.parse(period.endsAt) - 1).toISOString()).index).toBe(i);
    }
  });

  it('refuses an instant before the anchor rather than answering period 0', () => {
    // Answering 0 would let a caller prorate against time the merchant was
    // never subscribed for.
    expectRefusal(() => billingPeriodAt(monthly, '2026-01-30T23:59:59.999Z'), 'billing.as_of_before_anchor');
  });

  it('refuses a missing or unparseable as-of instant', () => {
    expectRefusal(() => billingPeriodAt(monthly, ''), 'billing.as_of_required');
    expectRefusal(() => billingPeriodAt(monthly, 'yesterday'), 'billing.as_of_required');
  });

  it('resolves a far-future instant rather than drifting, while the walk bound still refuses an absurd one', () => {
    // Derived by hand, not copied from the implementation:
    // (9999 − 2026) × 12 + (12 − 1) = 95,676 + 11 = 95,687 whole months, and
    // the 31st is not before the anchor's 31st, so the instant is inside that
    // period rather than the one before it. Inside the bound, so it must be
    // ANSWERED and answered correctly — a bound is not an excuse to stop
    // being right. An expanded year beyond the bound is refused.
    const far = billingPeriodAt(monthly, '9999-12-31T00:00:00.000Z');
    expect(periodContains(far, '9999-12-31T00:00:00.000Z')).toBe(true);
    expect(far.index).toBe(95_687);
    expectRefusal(() => billingPeriodAt(monthly, '+100000-01-01T00:00:00.000Z'), 'billing.period_index_invalid');
  });
});

describe('periodLengthMs and periodContains', () => {
  it('measure the half-open span', () => {
    const period = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-02T00:00:00.000Z' };
    expect(periodLengthMs(period)).toBe(86_400_000);
    expect(periodContains(period, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(periodContains(period, '2026-01-01T23:59:59.999Z')).toBe(true);
    expect(periodContains(period, '2026-01-02T00:00:00.000Z')).toBe(false);
  });

  it('refuse an inverted or empty period rather than returning zero or a negative length', () => {
    expectRefusal(() => periodLengthMs({ startsAt: '2026-01-02T00:00:00.000Z', endsAt: '2026-01-01T00:00:00.000Z' }), 'billing.period_range_invalid');
    expectRefusal(() => periodLengthMs({ startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-01T00:00:00.000Z' }), 'billing.period_range_invalid');
    expectRefusal(
      () => periodContains({ startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z'),
      'billing.period_range_invalid',
    );
  });
});
