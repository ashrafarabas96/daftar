import { describe, expect, it } from 'vitest';
import { priceAddOn } from '../src/addons';
import { BillingError } from '../src/errors';
import { MAX_ADDON_QUANTITY } from '../src/types';
import type { BillingPeriod } from '../src/types';

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

const APRIL: BillingPeriod = { startsAt: '2026-04-01T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' };

/**
 * A FIXTURE measured set for the arithmetic cases below. It is not the live
 * one: `test/addon-meters.test.ts` is the law that reads the live engine, and
 * mixing the two would make every pricing case depend on the engine's current
 * `switch`. These cases are about the arithmetic; §21 is tested where §21
 * lives.
 */
const MEASURED: readonly string[] = ['MAX_USERS', 'MAX_BRANCHES', 'MAX_PRODUCTS'];

describe('priceAddOn', () => {
  it('prices a flat add-on at its whole-period amount', () => {
    const result = priceAddOn({ key: 'EXTRA_BRANCH_PACK', kind: 'flat', unitPrice: { amountMinor: 4_900n, currency: 'ILS' }, quantity: 1 }, APRIL, MEASURED);
    expect(result).toEqual({ key: 'EXTRA_BRANCH_PACK', currency: 'ILS', fullAmountMinor: 4_900n, amountMinor: 4_900n, prorated: false });
  });

  it('multiplies a per-unit add-on by its integer quantity', () => {
    const result = priceAddOn({ key: 'EXTRA_USER', kind: 'per_unit', unitPrice: { amountMinor: 1_500n, currency: 'ILS' }, quantity: 7 }, APRIL, MEASURED);
    expect(result.fullAmountMinor).toBe(10_500n);
    expect(result.amountMinor).toBe(10_500n);
    expect(result.prorated).toBe(false);
  });

  it('prices a quantity of zero as zero instead of refusing it', () => {
    // A reduced-to-nothing add-on is a real state. Refusing it would push a
    // caller into deleting catalogue rows to express it; the invoice layer is
    // where a zero LINE is refused.
    const result = priceAddOn({ key: 'EXTRA_USER', kind: 'per_unit', unitPrice: { amountMinor: 1_500n, currency: 'ILS' }, quantity: 0 }, APRIL, MEASURED);
    expect(result.amountMinor).toBe(0n);
  });

  it('prorates an add-on that starts mid-period, and reports both amounts', () => {
    const result = priceAddOn(
      {
        key: 'EXTRA_USER',
        kind: 'per_unit',
        unitPrice: { amountMinor: 1_500n, currency: 'ILS' },
        quantity: 4,
        startsAt: '2026-04-16T00:00:00.000Z',
      },
      APRIL,
      MEASURED,
    );
    expect(result.fullAmountMinor).toBe(6_000n);
    expect(result.amountMinor).toBe(3_000n);
    expect(result.prorated).toBe(true);
  });

  it('marks an add-on prorated from the period start as prorated, and charges the whole amount', () => {
    // `prorated` reports that a start instant was SUPPLIED, not that the
    // amount came out smaller. Conflating the two would make the flag a
    // function of the arithmetic rather than of the caller's intent.
    const result = priceAddOn(
      { key: 'EXTRA_USER', kind: 'per_unit', unitPrice: { amountMinor: 1_500n, currency: 'ILS' }, quantity: 2, startsAt: APRIL.startsAt },
      APRIL,
      MEASURED,
    );
    expect(result.amountMinor).toBe(3_000n);
    expect(result.fullAmountMinor).toBe(3_000n);
    expect(result.prorated).toBe(true);
  });

  it('refuses a flat add-on with any quantity other than one', () => {
    expectRefusal(
      () => priceAddOn({ key: 'EXTRA_BRANCH_PACK', kind: 'flat', unitPrice: { amountMinor: 4_900n, currency: 'ILS' }, quantity: 3 }, APRIL, MEASURED),
      'billing.addon_quantity_invalid',
    );
    expectRefusal(
      () => priceAddOn({ key: 'EXTRA_BRANCH_PACK', kind: 'flat', unitPrice: { amountMinor: 4_900n, currency: 'ILS' }, quantity: 0 }, APRIL, MEASURED),
      'billing.addon_quantity_invalid',
    );
  });

  it('refuses a fractional, negative or over-cap quantity', () => {
    const base = { key: 'EXTRA_USER', kind: 'per_unit' as const, unitPrice: { amountMinor: 1_500n, currency: 'ILS' } };
    expectRefusal(() => priceAddOn({ ...base, quantity: 1.5 }, APRIL, MEASURED), 'billing.addon_quantity_invalid');
    expectRefusal(() => priceAddOn({ ...base, quantity: -1 }, APRIL, MEASURED), 'billing.addon_quantity_invalid');
    expectRefusal(() => priceAddOn({ ...base, quantity: MAX_ADDON_QUANTITY + 1 }, APRIL, MEASURED), 'billing.addon_quantity_invalid');
    expect(priceAddOn({ ...base, quantity: MAX_ADDON_QUANTITY }, APRIL, MEASURED).fullAmountMinor).toBe(1_500n * BigInt(MAX_ADDON_QUANTITY));
  });

  it('refuses an unknown add-on kind rather than defaulting to one', () => {
    expectRefusal(
      () =>
        priceAddOn({ key: 'TIERED', kind: 'graduated' as unknown as 'flat', unitPrice: { amountMinor: 100n, currency: 'ILS' }, quantity: 1 }, APRIL, MEASURED),
      'billing.addon_kind_unsupported',
    );
  });

  it('refuses a missing key, a malformed price and a currency that is not a code', () => {
    expectRefusal(
      () => priceAddOn({ key: '  ', kind: 'flat', unitPrice: { amountMinor: 100n, currency: 'ILS' }, quantity: 1 }, APRIL, MEASURED),
      'billing.payload_invalid',
    );
    expectRefusal(
      () => priceAddOn({ key: 'X', kind: 'flat', unitPrice: { amountMinor: -1n, currency: 'ILS' }, quantity: 1 }, APRIL, MEASURED),
      'billing.price_invalid',
    );
    expectRefusal(
      () => priceAddOn({ key: 'X', kind: 'flat', unitPrice: { amountMinor: 100n, currency: 'shekel' }, quantity: 1 }, APRIL, MEASURED),
      'billing.price_invalid',
    );
  });

  it('refuses a whole-period amount that overflows the money cap', () => {
    expectRefusal(
      () => priceAddOn({ key: 'X', kind: 'per_unit', unitPrice: { amountMinor: 10n ** 18n, currency: 'ILS' }, quantity: MAX_ADDON_QUANTITY }, APRIL, MEASURED),
      'billing.price_invalid',
    );
  });

  it('refuses a start instant outside the period', () => {
    expectRefusal(
      () => priceAddOn({ key: 'X', kind: 'flat', unitPrice: { amountMinor: 100n, currency: 'ILS' }, quantity: 1, startsAt: APRIL.endsAt }, APRIL, MEASURED),
      'billing.proration_outside_period',
    );
  });
});
