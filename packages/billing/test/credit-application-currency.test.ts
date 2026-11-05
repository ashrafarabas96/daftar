/**
 * B1 — THE INVOICE SIDE HAD NO CURRENCY TO COMPARE.
 *
 * Measured on `e9186016` against the built package, before this law existed:
 * an ILS ledger carrying 5000 minor units was applied to an invoice total of
 * 10000 minor units whose currency was named NOWHERE in the input, and the
 * call was ACCEPTED — `currency=ILS applied=5000 payable=5000`, with the
 * output's currency taken from the LEDGER (`credit-application.ts:147,260`).
 * `CreditApplicationInput` carried `invoiceTotalMinor` and no currency beside
 * it, so there was nothing for the unit to disagree with.
 *
 * The unit was never currency-blind in general: a ledger ROW whose currency
 * differs from its scope has always refused with
 * `billing.credit_currency_mismatch` (`credit.ts:208`), measured. The hole was
 * on the invoice side alone, which is why a conservation proof stated in one
 * unit could pass over it: every figure in it belonged to the ledger.
 *
 * So the law is: the invoice declares its currency, and an application whose
 * three currencies — invoice, scope, ledger — are not one is REFUSED BY NAME.
 * A subtraction across currencies is not a rounding question and not a
 * tolerance; it is a different quantity.
 */
import { describe, expect, it } from 'vitest';
import { applyCreditToInvoice } from '../src/credit-application';
import { type CreditAdjustment, type CreditLedgerScope } from '../src/credit';
import { BillingError } from '../src/errors';

const SCOPE: CreditLedgerScope = { businessId: 'biz-1', currency: 'ILS' };

function grant(amountMinor: bigint, currency = 'ILS'): CreditAdjustment {
  return {
    id: 'adj-1',
    businessId: 'biz-1',
    kind: 'grant',
    amountMinor,
    currency,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ref: 'plan-change-1',
    reason: 'a downgrade remainder',
  };
}

function apply(invoiceCurrency: string, scope: CreditLedgerScope = SCOPE, ledger: readonly CreditAdjustment[] = [grant(5000n)]) {
  return applyCreditToInvoice({
    scope,
    ledger,
    invoiceTotalMinor: 10000n,
    invoiceCurrency,
    invoiceRef: 'inv-2026-05',
    appliedAt: '2026-02-01T00:00:00.000Z',
    consumptionIds: ['cons-1'],
    reason: 'automatic application at invoice finalization',
  });
}

function expectRefusal(fn: () => unknown, code: string): BillingError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
  return caught as BillingError;
}

describe('B1 — an application states one currency, or it refuses', () => {
  it('REFUSES the measured case: an ILS balance against a USD invoice', () => {
    // The exact shape that was accepted before this law: the ledger and the
    // scope say ILS, the invoice says USD, and 5000 ILS would have been
    // subtracted from a USD total.
    const e = expectRefusal(() => apply('USD'), 'billing.credit_currency_mismatch');
    // The refusal names the currency it refused on, or it cannot be read.
    expect(JSON.stringify(e.toSafeJSON?.() ?? {}) + String(e.message)).toMatch(/USD|ILS|currenc/i);
  });

  it('POSITIVE CONTROL: the same currency is accepted and conserves exactly', () => {
    const r = apply('ILS');
    expect(r.currency).toBe('ILS');
    expect(r.appliedMinor).toBe(5000n);
    expect(r.payableMinor).toBe(5000n);
    // conservation, stated in the one unit all three now share
    expect(r.appliedMinor + r.payableMinor).toBe(10000n);
    expect(r.balanceBeforeMinor - r.appliedMinor).toBe(r.balanceAfterMinor);
  });

  it('REFUSES a malformed invoice currency rather than normalizing it', () => {
    for (const bad of ['ils', 'IL', 'ILSS', '', ' ILS', 'IL5']) {
      expectRefusal(() => apply(bad), 'billing.payload_invalid');
    }
  });

  it('REFUSES an absent invoice currency: the field is not optional', () => {
    expectRefusal(() => apply(undefined as unknown as string), 'billing.payload_invalid');
  });

  it('NEGATIVE CONTROL: the ledger-row check that already existed still refuses', () => {
    // A row in USD inside an ILS scope was refused before this law and must
    // still be, so this change adds a check and removes none.
    expectRefusal(() => apply('ILS', SCOPE, [grant(5000n, 'USD')]), 'billing.credit_currency_mismatch');
  });

  it('NEGATIVE CONTROL: a scope currency that disagrees with the invoice refuses even with an empty ledger', () => {
    // No grant at all, so nothing is applied and the amounts are all zero:
    // the refusal is about the DECLARED currencies and not about an allocation
    // that happened to be impossible.
    expectRefusal(() => apply('USD', SCOPE, []), 'billing.credit_currency_mismatch');
    // and the same empty ledger in the matching currency is accepted
    const r = apply('ILS', SCOPE, []);
    expect(r.appliedMinor).toBe(0n);
    expect(r.payableMinor).toBe(10000n);
    expect(r.consumptions).toStrictEqual([]);
  });
});
