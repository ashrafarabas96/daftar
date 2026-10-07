import { describe, expect, it } from 'vitest';
import { BillingError } from '../src/errors';
import { composeSubscriptionInvoice, SUBSCRIPTION_LINE_KINDS, type SubscriptionInvoiceLine } from '../src/invoice';

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

const plan = (amountMinor: bigint): SubscriptionInvoiceLine => ({ kind: 'plan', ref: 'pro', amountMinor, currency: 'ILS' });

describe('composeSubscriptionInvoice', () => {
  it('totals the charge lines exactly', () => {
    const result = composeSubscriptionInvoice({
      lines: [plan(30_000n), { kind: 'addon', ref: 'EXTRA_USER', amountMinor: 6_000n, currency: 'ILS' }],
    });
    expect(result.chargeMinor).toBe(36_000n);
    expect(result.creditMinor).toBe(0n);
    expect(result.subtotalMinor).toBe(36_000n);
    expect(result.totalMinor).toBe(36_000n);
    expect(result.taxMinor).toBe(0n);
    expect(result.currency).toBe('ILS');
  });

  it('subtracts a proration credit, which is supplied POSITIVE', () => {
    // The kind carries the direction. A caller that had to pass a negative
    // amount would be one missing minus sign away from charging for a credit.
    const result = composeSubscriptionInvoice({
      lines: [
        { kind: 'proration_charge', ref: 'business', amountMinor: 15_000n, currency: 'ILS' },
        { kind: 'proration_credit', ref: 'pro', amountMinor: 6_000n, currency: 'ILS' },
      ],
    });
    expect(result.chargeMinor).toBe(15_000n);
    expect(result.creditMinor).toBe(6_000n);
    expect(result.totalMinor).toBe(9_000n);
  });

  it('allows a total of exactly zero, where the credit cancels the charge', () => {
    const result = composeSubscriptionInvoice({
      lines: [
        { kind: 'proration_charge', ref: 'a', amountMinor: 5_000n, currency: 'ILS' },
        { kind: 'proration_credit', ref: 'b', amountMinor: 5_000n, currency: 'ILS' },
      ],
    });
    expect(result.totalMinor).toBe(0n);
  });

  it('returns the lines it was given, in order, rather than a reordered or deduplicated set', () => {
    const lines = [plan(10n), { kind: 'addon' as const, ref: 'x', amountMinor: 20n, currency: 'ILS' }, plan(30n)];
    expect(composeSubscriptionInvoice({ lines }).lines).toEqual(lines);
  });

  it('REFUSES a non-zero tax rather than normalizing, dropping or posting it', () => {
    // Refusing is the only one of the three a reviewer can detect. Tax on the
    // PLATFORM's own invoice is an unsettled policy; OD-03 settled the
    // merchant's sales tax, which is a different question.
    expectRefusal(() => composeSubscriptionInvoice({ lines: [plan(100n)], taxMinor: 1n }), 'billing.subscription_tax_unsupported');
    expectRefusal(() => composeSubscriptionInvoice({ lines: [plan(100n)], taxMinor: -1n }), 'billing.subscription_tax_unsupported');
  });

  it('accepts an explicit zero tax and still reports zero', () => {
    expect(composeSubscriptionInvoice({ lines: [plan(100n)], taxMinor: 0n }).taxMinor).toBe(0n);
  });

  it('REFUSES a net-credit invoice, because that document is a credit note', () => {
    expectRefusal(
      () =>
        composeSubscriptionInvoice({
          lines: [
            { kind: 'proration_charge', ref: 'a', amountMinor: 1_000n, currency: 'ILS' },
            { kind: 'proration_credit', ref: 'b', amountMinor: 1_001n, currency: 'ILS' },
          ],
        }),
      'billing.invoice_total_negative',
    );
  });

  it('refuses an empty invoice', () => {
    expectRefusal(() => composeSubscriptionInvoice({ lines: [] }), 'billing.invoice_empty');
    expectRefusal(() => composeSubscriptionInvoice({ lines: undefined as unknown as SubscriptionInvoiceLine[] }), 'billing.invoice_empty');
  });

  it('refuses a mixed-currency invoice and names the offending line', () => {
    let caught: unknown;
    try {
      composeSubscriptionInvoice({ lines: [plan(100n), { kind: 'addon', ref: 'x', amountMinor: 50n, currency: 'USD' }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillingError);
    expect((caught as BillingError).code).toBe('billing.invoice_currency_mismatch');
    expect((caught as BillingError).context.lineNo).toBe(2);
  });

  it('refuses a zero line, a negative line amount and a non-bigint amount', () => {
    expectRefusal(() => composeSubscriptionInvoice({ lines: [plan(0n)] }), 'billing.invoice_line_zero');
    expectRefusal(() => composeSubscriptionInvoice({ lines: [plan(-1n)] }), 'billing.payload_invalid');
    expectRefusal(() => composeSubscriptionInvoice({ lines: [plan(100 as unknown as bigint)] }), 'billing.payload_invalid');
  });

  it('refuses an unknown line kind and a line with no subject', () => {
    expectRefusal(
      () => composeSubscriptionInvoice({ lines: [{ kind: 'tip' as unknown as 'plan', ref: 'x', amountMinor: 1n, currency: 'ILS' }] }),
      'billing.payload_invalid',
    );
    expectRefusal(() => composeSubscriptionInvoice({ lines: [{ kind: 'plan', ref: ' ', amountMinor: 1n, currency: 'ILS' }] }), 'billing.payload_invalid');
  });

  it('refuses a line amount above the money cap', () => {
    expectRefusal(() => composeSubscriptionInvoice({ lines: [plan(10n ** 18n + 1n)] }), 'billing.payload_invalid');
  });

  it('has a credit set that is a strict, non-empty subset of the line kinds', () => {
    // A guard against the two ways this rule rots: every kind becoming a
    // credit, or none of them. Both would pass the arithmetic tests above —
    // the first by making every invoice negative, the second by making the
    // credit line a charge, which is the expensive one.
    const credits = SUBSCRIPTION_LINE_KINDS.filter((kind) => {
      const result = composeSubscriptionInvoice({
        lines: [
          { kind: 'plan', ref: 'base', amountMinor: 1_000n, currency: 'ILS' },
          { kind, ref: 'probe', amountMinor: 100n, currency: 'ILS' },
        ],
      });
      return result.totalMinor === 900n;
    });
    expect(credits).toEqual(['proration_credit']);
  });
});
