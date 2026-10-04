import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CustomerSettlementError,
  planCustomerCreditApplication,
  planCustomerPayment,
  planCustomerPaymentAllocation,
  type CustomerCreditState,
  type CustomerPaymentLeg,
  type CustomerSettlementEntryLine,
  type InvoiceArState,
} from '../src/customer-settlement-payloads';
import { InventoryError } from '../src/errors';
import { roundHalfEven } from '../src/rounding';
import { type SettlementConversion } from '../src/supplier-settlement';

/** The code of a refusal, or `'accepted'`. Never a message: a message is not a contract. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CustomerSettlementError || e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

const at = (rateR10: bigint, txnExponent = 2, baseExponent = 2): SettlementConversion => ({ rateR10, txnExponent, baseExponent });

const R1 = 10n ** 10n;
const ILS = at(R1);
const USD_350 = at(35000000000n);
const USD_360 = at(36000000000n);
const USD_365 = at(36500000000n);
const USD_370 = at(37000000000n);
/** A JOD-base business: 3 minor units. LBP (2 minor units) at 0.0000024900. */
const JOD = at(R1, 3, 3);
const LBP = at(24900n, 2, 3);

const invoice = (over: Partial<InvoiceArState> = {}): InvoiceArState => ({
  totalTxnMinor: 10000n,
  totalBaseMinor: 36000n,
  outstandingTxnMinor: 10000n,
  conversion: USD_360,
  ...over,
});

const credit = (over: Partial<CustomerCreditState> = {}): CustomerCreditState => ({
  originalMinor: 10000n,
  originalCarryingMinor: 36000n,
  remainingMinor: 10000n,
  conversion: USD_360,
  ...over,
});

const line = (
  account: CustomerSettlementEntryLine['account'],
  side: 'D' | 'C',
  currency: CustomerSettlementEntryLine['currency'],
  txnAmountMinor: bigint,
  baseAmountMinor: bigint,
  dimension: 'invoice' | 'origin',
): CustomerSettlementEntryLine => ({ account, side, currency, txnAmountMinor, baseAmountMinor, dimension });

// ── The arithmetic is the accepted one, vector for vector ────────────────

describe('a customer payment allocation reuses the accepted release', () => {
  it('clears a 1.00 USD invoice in USD thirds: the cumulative releases 120, 121, 124 sum to the whole 365 (AP-THIRDS-EXACT-CLEARING)', () => {
    const totals = { totalTxnMinor: 100n, totalBaseMinor: 365n, conversion: USD_365 };
    const expected = [
      { outstanding: 100n, a: 33n, X: 0n, rel: 120n, dust: 0n, pb: 122n, realized: 2n },
      { outstanding: 67n, a: 33n, X: 33n, rel: 121n, dust: 1n, pb: 122n, realized: 1n },
      { outstanding: 34n, a: 34n, X: 66n, rel: 124n, dust: 0n, pb: 126n, realized: 2n },
    ];
    let releaseSum = 0n;
    let appliedSum = 0n;
    for (const e of expected) {
      const plan = planCustomerPaymentAllocation({
        invoice: invoice({ ...totals, outstandingTxnMinor: e.outstanding }),
        sameCurrency: false,
        paymentAmountMinor: e.a,
        payment: USD_370,
        appliedMinor: e.a,
      });
      expect(plan.releasedBeforeMinor).toBe(e.X);
      expect(plan.carryingReleasedMinor).toBe(e.rel);
      expect(plan.arDustBaseMinor).toBe(e.dust);
      expect(plan.paymentBaseMinor).toBe(e.pb);
      expect(plan.realizedMinor).toBe(e.realized);
      releaseSum += plan.carryingReleasedMinor;
      appliedSum += plan.appliedMinor;
    }
    // The cumulative identity: nothing is stranded and nothing is invented.
    expect(appliedSum).toBe(100n);
    expect(releaseSum).toBe(365n);
    expect(releaseSum).toBe(roundHalfEven(365n * appliedSum, 100n));
  });

  it('posts the dust as a second line on accounts_receivable and the imbalance as a gain', () => {
    const plan = planCustomerPaymentAllocation({
      invoice: invoice({ totalTxnMinor: 100n, totalBaseMinor: 365n, outstandingTxnMinor: 67n, conversion: USD_365 }),
      sameCurrency: false,
      paymentAmountMinor: 33n,
      payment: USD_370,
      appliedMinor: 33n,
    });
    expect(plan.entryLines).toStrictEqual([
      line('posting_account', 'D', 'payment', 33n, 122n, 'invoice'),
      line('accounts_receivable', 'C', 'invoice', 33n, 120n, 'invoice'),
      line('accounts_receivable', 'C', 'base', 1n, 1n, 'invoice'),
      line('fx_gain', 'C', 'base', 1n, 1n, 'invoice'),
    ]);
  });

  it('realizes FX at the same rate, because a release is not a conversion (SAME-RATE-SUBUNIT-FX)', () => {
    const totals = { totalTxnMinor: 100n, totalBaseMinor: 365n, conversion: USD_365 };
    const first = planCustomerPaymentAllocation({
      invoice: invoice({ ...totals, outstandingTxnMinor: 100n }),
      sameCurrency: true,
      paymentAmountMinor: 33n,
      payment: USD_365,
      appliedMinor: 33n,
    });
    expect([first.carryingReleasedMinor, first.paymentBaseMinor, first.arDustBaseMinor, first.realizedMinor]).toStrictEqual([120n, 120n, 0n, 0n]);
    const second = planCustomerPaymentAllocation({
      invoice: invoice({ ...totals, outstandingTxnMinor: 67n }),
      sameCurrency: true,
      paymentAmountMinor: 33n,
      payment: USD_365,
      appliedMinor: 33n,
    });
    expect([second.carryingReleasedMinor, second.paymentBaseMinor, second.arDustBaseMinor, second.realizedMinor]).toStrictEqual([121n, 120n, 1n, -1n]);
    // A loss, because the invoice released more carrying base than the cash was worth.
    expect(second.entryLines).toContainEqual(line('fx_loss', 'D', 'base', 1n, 1n, 'invoice'));
  });

  it('carries a negative dust as the opposite side on the same account (FOREIGN-AR-DUST)', () => {
    const totals = { totalTxnMinor: 3n, totalBaseMinor: 11n, conversion: USD_365 };
    const expected = [
      { outstanding: 3n, rel: 4n, conv: 4n, dust: 0n, realized: 0n },
      { outstanding: 2n, rel: 3n, conv: 4n, dust: -1n, realized: 1n },
      { outstanding: 1n, rel: 4n, conv: 4n, dust: 0n, realized: 0n },
    ];
    let releaseSum = 0n;
    for (const e of expected) {
      const plan = planCustomerPaymentAllocation({
        invoice: invoice({ ...totals, outstandingTxnMinor: e.outstanding }),
        sameCurrency: false,
        paymentAmountMinor: 4n,
        payment: ILS,
        appliedMinor: 1n,
      });
      expect([plan.carryingReleasedMinor, plan.arConvertedMinor, plan.arDustBaseMinor, plan.realizedMinor]).toStrictEqual([e.rel, e.conv, e.dust, e.realized]);
      releaseSum += plan.carryingReleasedMinor;
    }
    expect(releaseSum).toBe(11n);
    expect(releaseSum).toBe(roundHalfEven(11n * 3n, 3n));
  });
});

describe('a customer credit application reuses the accepted carrying function', () => {
  it('releases a cumulative proportional share, and the final consumption releases the entire residue (GOLD-84 boundary)', () => {
    const first = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 6000n, totalBaseMinor: 21600n, outstandingTxnMinor: 6000n, conversion: USD_360 }),
      credit: credit(),
      sameCurrency: true,
      consumedMinor: 6000n,
      appliedMinor: 6000n,
    });
    expect(first.creditReleasedMinor).toBe(21600n);
    expect(first.creditDustBaseMinor).toBe(0n);
    expect(first.remainingAfterMinor).toBe(4000n);
    expect(first.remainingCarryingAfterMinor).toBe(14400n);
    expect(first.realizedMinor).toBe(0n);

    const final = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 4000n, totalBaseMinor: 14800n, outstandingTxnMinor: 4000n, conversion: USD_370 }),
      credit: credit({ remainingMinor: 4000n }),
      sameCurrency: true,
      consumedMinor: 4000n,
      appliedMinor: 4000n,
    });
    // The whole residue, nothing stranded: the two releases are exactly OB.
    expect(final.creditReleasedMinor).toBe(14400n);
    expect(first.creditReleasedMinor + final.creditReleasedMinor).toBe(36000n);
    expect(final.remainingAfterMinor).toBe(0n);
    expect(final.remainingCarryingAfterMinor).toBe(0n);
    expect(final.carryingReleasedMinor).toBe(14800n);
    expect(final.realizedMinor).toBe(-400n);
    expect(final.entryLines).toStrictEqual([
      line('customer_credit_liability', 'D', 'credit', 4000n, 14400n, 'origin'),
      line('accounts_receivable', 'C', 'invoice', 4000n, 14800n, 'invoice'),
      line('fx_loss', 'D', 'base', 400n, 400n, 'invoice'),
    ]);

    // And a consumption past the end is refused, never silently floored.
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ totalTxnMinor: 100n, totalBaseMinor: 370n, outstandingTxnMinor: 100n, conversion: USD_370 }),
          credit: credit({ remainingMinor: 0n }),
          sameCurrency: true,
          consumedMinor: 1n,
          appliedMinor: 1n,
        }),
      ),
    ).toBe('customer_credit_application.credit_exhausted');
  });

  it('realizes the mirror sign of the supplier side: a credit carried cheaper than the invoice is a LOSS, dearer a GAIN (CREDIT-ALLOC-FX-SIGN)', () => {
    const loss = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 5000n, totalBaseMinor: 18500n, outstandingTxnMinor: 5000n, conversion: USD_370 }),
      credit: credit(),
      sameCurrency: true,
      consumedMinor: 5000n,
      appliedMinor: 5000n,
    });
    expect([loss.creditReleasedMinor, loss.carryingReleasedMinor, loss.realizedMinor]).toStrictEqual([18000n, 18500n, -500n]);
    expect(loss.entryLines).toContainEqual(line('fx_loss', 'D', 'base', 500n, 500n, 'invoice'));

    const gain = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 5000n, totalBaseMinor: 17500n, outstandingTxnMinor: 5000n, conversion: USD_350 }),
      credit: credit({ remainingMinor: 5000n }),
      sameCurrency: true,
      consumedMinor: 5000n,
      appliedMinor: 5000n,
    });
    expect([gain.creditReleasedMinor, gain.carryingReleasedMinor, gain.realizedMinor]).toStrictEqual([18000n, 17500n, 500n]);
    expect(gain.entryLines).toContainEqual(line('fx_gain', 'C', 'base', 500n, 500n, 'invoice'));
  });

  it('keeps the max(1, …) floor of g under a strong base currency (STRONG-BASE-MIN1)', () => {
    const totals = { totalTxnMinor: 100000n, totalBaseMinor: 2n, conversion: LBP };
    const lbpCredit = credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 100000n, conversion: LBP });

    const first = planCustomerCreditApplication({
      invoice: invoice({ ...totals, outstandingTxnMinor: 100000n }),
      credit: lbpCredit,
      sameCurrency: true,
      consumedMinor: 79000n,
      appliedMinor: 79000n,
    });
    expect([first.creditReleasedMinor, first.creditConvertedMinor, first.creditDustBaseMinor]).toStrictEqual([1n, 2n, -1n]);
    expect([first.carryingReleasedMinor, first.arConvertedMinor, first.arDustBaseMinor]).toStrictEqual([2n, 2n, 0n]);
    expect(first.realizedMinor).toBe(-1n);
    // g never falls below one minor unit while anything remains.
    expect(first.remainingCarryingAfterMinor).toBe(1n);

    const second = planCustomerCreditApplication({
      invoice: invoice({ ...totals, outstandingTxnMinor: 21000n }),
      credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 21000n, conversion: LBP }),
      sameCurrency: true,
      consumedMinor: 21000n,
      appliedMinor: 21000n,
    });
    expect([second.creditReleasedMinor, second.creditConvertedMinor, second.creditDustBaseMinor]).toStrictEqual([1n, 1n, 0n]);
    expect([second.carryingReleasedMinor, second.arConvertedMinor, second.arDustBaseMinor]).toStrictEqual([0n, 1n, -1n]);
    expect(second.realizedMinor).toBe(1n);
    expect(second.remainingCarryingAfterMinor).toBe(0n);
    // The two releases are exactly OB: the floor took nothing from the total.
    expect(first.creditReleasedMinor + second.creditReleasedMinor).toBe(2n);
  });
});

// ── The sub-unit residue law, and the order it is judged in ──────────────

describe('the sub-unit residue law (R-77, R-78)', () => {
  const lbpInvoice = { totalTxnMinor: 100000n, totalBaseMinor: 2n, conversion: LBP };

  it('refuses a collection that would leave the invoice an outstanding amount converting to nothing', () => {
    expect(
      codeOf(() =>
        planCustomerPaymentAllocation({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 100000n }),
          sameCurrency: false,
          paymentAmountMinor: 2n,
          payment: JOD,
          appliedMinor: 99990n,
        }),
      ),
    ).toBe('customer_payment_allocation.residue_below_base_unit');
  });

  it('accepts the same invoice when what remains still converts to a base minor unit', () => {
    const plan = planCustomerPaymentAllocation({
      invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 100000n }),
      sameCurrency: false,
      paymentAmountMinor: 2n,
      payment: JOD,
      appliedMinor: 79000n,
    });
    expect([plan.carryingReleasedMinor, plan.arConvertedMinor, plan.arDustBaseMinor, plan.realizedMinor]).toStrictEqual([2n, 2n, 0n, 0n]);
  });

  it('refuses an application that would leave the credit a remaining amount converting to nothing', () => {
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 21000n }),
          credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 21000n, conversion: LBP }),
          sameCurrency: true,
          consumedMinor: 20990n,
          appliedMinor: 20990n,
        }),
      ),
    ).toBe('customer_credit_application.residue_below_base_unit');
  });

  it('judges amount_below_base_unit BEFORE residue_below_base_unit, on both legs', () => {
    // Both laws are broken at once: the applied 0.05 LBP converts to nothing
    // AND the 0.05 LBP it would leave behind converts to nothing. The accepted
    // order says the amount is named, not the residue.
    expect(
      codeOf(() =>
        planCustomerPaymentAllocation({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 10n }),
          sameCurrency: false,
          paymentAmountMinor: 1n,
          payment: JOD,
          appliedMinor: 5n,
        }),
      ),
    ).toBe('customer_payment_allocation.amount_below_base_unit');
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 10n }),
          credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 10n, conversion: LBP }),
          sameCurrency: true,
          consumedMinor: 5n,
          appliedMinor: 5n,
        }),
      ),
    ).toBe('customer_credit_application.amount_below_base_unit');
  });
});

// ── One planted red proof for every refusal code ─────────────────────────

describe('every refusal code this module introduces has a planted red proof', () => {
  const lbpInvoice = { totalTxnMinor: 100000n, totalBaseMinor: 2n, conversion: LBP };
  const lawfulLeg: CustomerPaymentLeg = { invoice: invoice(), sameCurrency: true, paymentAmountMinor: 100n, appliedMinor: 100n };

  it('payment.allocations_invalid — a payment amount that is not positive', () => {
    expect(codeOf(() => planCustomerPayment({ amountMinor: 0n, payment: USD_360, legs: [] }))).toBe('payment.allocations_invalid');
  });

  it('payment.allocations_invalid — more than 50 allocations', () => {
    expect(codeOf(() => planCustomerPayment({ amountMinor: 5100n, payment: USD_360, legs: Array.from({ length: 51 }, () => lawfulLeg) }))).toBe(
      'payment.allocations_invalid',
    );
  });

  it('payment.allocations_invalid — the legs consume more than the payment received', () => {
    expect(codeOf(() => planCustomerPayment({ amountMinor: 50n, payment: USD_360, legs: [lawfulLeg] }))).toBe('payment.allocations_invalid');
  });

  it('payment.allocations_invalid — a leg whose own payment amount is not positive', () => {
    expect(
      codeOf(() => planCustomerPaymentAllocation({ invoice: invoice(), sameCurrency: true, paymentAmountMinor: 0n, payment: USD_360, appliedMinor: 100n })),
    ).toBe('payment.allocations_invalid');
  });

  it('payment.amount_below_base_unit — a surplus that converts to less than one base minor unit', () => {
    expect(codeOf(() => planCustomerPayment({ amountMinor: 5n, payment: LBP, legs: [] }))).toBe('payment.amount_below_base_unit');
  });

  it('customer_payment_allocation.amount_exceeds_outstanding', () => {
    expect(
      codeOf(() =>
        planCustomerPaymentAllocation({
          invoice: invoice({ outstandingTxnMinor: 100n }),
          sameCurrency: true,
          paymentAmountMinor: 101n,
          payment: USD_360,
          appliedMinor: 101n,
        }),
      ),
    ).toBe('customer_payment_allocation.amount_exceeds_outstanding');
  });

  it('customer_payment_allocation.amount_mismatch', () => {
    expect(
      codeOf(() => planCustomerPaymentAllocation({ invoice: invoice(), sameCurrency: true, paymentAmountMinor: 101n, payment: USD_360, appliedMinor: 100n })),
    ).toBe('customer_payment_allocation.amount_mismatch');
  });

  it('customer_payment_allocation.amount_below_base_unit — the payment amount itself', () => {
    expect(
      codeOf(() =>
        planCustomerPaymentAllocation({
          invoice: invoice({ totalTxnMinor: 100n, totalBaseMinor: 365n, outstandingTxnMinor: 100n, conversion: USD_365 }),
          sameCurrency: false,
          paymentAmountMinor: 5n,
          payment: LBP,
          appliedMinor: 100n,
        }),
      ),
    ).toBe('customer_payment_allocation.amount_below_base_unit');
  });

  it('customer_payment_allocation.residue_below_base_unit', () => {
    expect(
      codeOf(() =>
        planCustomerPaymentAllocation({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 100000n }),
          sameCurrency: false,
          paymentAmountMinor: 2n,
          payment: JOD,
          appliedMinor: 99990n,
        }),
      ),
    ).toBe('customer_payment_allocation.residue_below_base_unit');
  });

  it('customer_credit_application.amount_exceeds_outstanding', () => {
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ outstandingTxnMinor: 100n }),
          credit: credit(),
          sameCurrency: true,
          consumedMinor: 101n,
          appliedMinor: 101n,
        }),
      ),
    ).toBe('customer_credit_application.amount_exceeds_outstanding');
  });

  it('customer_credit_application.amount_exceeds_credit', () => {
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice(),
          credit: credit({ remainingMinor: 5000n }),
          sameCurrency: true,
          consumedMinor: 6000n,
          appliedMinor: 6000n,
        }),
      ),
    ).toBe('customer_credit_application.amount_exceeds_credit');
  });

  it('customer_credit_application.credit_exhausted', () => {
    expect(
      codeOf(() =>
        planCustomerCreditApplication({ invoice: invoice(), credit: credit({ remainingMinor: 0n }), sameCurrency: true, consumedMinor: 1n, appliedMinor: 1n }),
      ),
    ).toBe('customer_credit_application.credit_exhausted');
  });

  it('customer_credit_application.amount_mismatch', () => {
    expect(
      codeOf(() => planCustomerCreditApplication({ invoice: invoice(), credit: credit(), sameCurrency: true, consumedMinor: 100n, appliedMinor: 101n })),
    ).toBe('customer_credit_application.amount_mismatch');
  });

  it('customer_credit_application.amount_below_base_unit — the consumed amount, on the CREDIT snapshot alone', () => {
    // The invoice leg is lawful throughout (JOD at 1, nothing strands), so only
    // the credit side's own conversion can raise this.
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ totalTxnMinor: 1000n, totalBaseMinor: 1000n, outstandingTxnMinor: 1000n, conversion: JOD }),
          credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 100000n, conversion: LBP }),
          sameCurrency: false,
          consumedMinor: 10n,
          appliedMinor: 10n,
        }),
      ),
    ).toBe('customer_credit_application.amount_below_base_unit');
  });

  it('customer_credit_application.amount_below_base_unit — the applied amount, on the INVOICE snapshot alone', () => {
    // Mirror image: the credit leg is lawful (JOD at 1), the invoice leg is not.
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 10n }),
          credit: credit({ originalMinor: 100000n, originalCarryingMinor: 100000n, remainingMinor: 100000n, conversion: JOD }),
          sameCurrency: false,
          consumedMinor: 10n,
          appliedMinor: 10n,
        }),
      ),
    ).toBe('customer_credit_application.amount_below_base_unit');
  });

  it('customer_credit_application.residue_below_base_unit', () => {
    expect(
      codeOf(() =>
        planCustomerCreditApplication({
          invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 21000n }),
          credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 21000n, conversion: LBP }),
          sameCurrency: true,
          consumedMinor: 20990n,
          appliedMinor: 20990n,
        }),
      ),
    ).toBe('customer_credit_application.residue_below_base_unit');
  });

  it('carries the code alone off the wire', () => {
    const e = new CustomerSettlementError('payment.allocations_invalid', 'a payment amount must be positive');
    expect(e.toSafeJSON()).toStrictEqual({ code: 'payment.allocations_invalid' });
    expect(Object.keys(e.toSafeJSON())).toStrictEqual(['code']);
  });
});

// ── The payment document and its closure law (OQ-4) ──────────────────────

describe('the closure law of a customer payment', () => {
  it('represents a pure on-account collection: no allocation, the whole amount becomes a customer credit', () => {
    const plan = planCustomerPayment({ amountMinor: 50000n, payment: ILS, legs: [] });
    expect(plan.allocationCount).toBe(0);
    expect(plan.allocations).toStrictEqual([]);
    expect(plan.creditCreatedMinor).toBe(50000n);
    expect(plan.creditCarryingBaseMinor).toBe(50000n);
    expect(plan.baseAmountMinor).toBe(50000n);
    expect(plan.creditEntryLines).toStrictEqual([
      line('posting_account', 'D', 'payment', 50000n, 50000n, 'origin'),
      line('customer_credit_liability', 'C', 'payment', 50000n, 50000n, 'origin'),
    ]);
  });

  it('closes a partly allocated payment with the surplus, and a fully allocated one with nothing', () => {
    const inv = invoice({ totalTxnMinor: 30000n, totalBaseMinor: 30000n, outstandingTxnMinor: 30000n, conversion: ILS });
    const leg: CustomerPaymentLeg = { invoice: inv, sameCurrency: true, paymentAmountMinor: 30000n, appliedMinor: 30000n };

    const partial = planCustomerPayment({ amountMinor: 50000n, payment: ILS, legs: [leg] });
    expect(partial.allocationCount).toBe(1);
    expect(partial.creditCreatedMinor).toBe(20000n);
    expect(partial.creditCarryingBaseMinor).toBe(20000n);
    expect(partial.baseAmountMinor).toBe(50000n);
    // The closure law, in the payment currency only.
    expect(partial.allocations.reduce((s, a) => s + a.paymentAmountMinor, 0n) + partial.creditCreatedMinor).toBe(partial.amountMinor);

    const full = planCustomerPayment({ amountMinor: 30000n, payment: ILS, legs: [leg] });
    expect(full.creditCreatedMinor).toBe(0n);
    expect(full.creditCarryingBaseMinor).toBe(0n);
    expect(full.creditEntryLines).toStrictEqual([]);
    expect(full.baseAmountMinor).toBe(30000n);
  });

  it('is the sum of single roundings, never one rounding of the sum', () => {
    const inv = invoice({ totalTxnMinor: 33n, totalBaseMinor: 120n, outstandingTxnMinor: 33n, conversion: USD_365 });
    const plan = planCustomerPayment({
      amountMinor: 66n,
      payment: USD_365,
      legs: [{ invoice: inv, sameCurrency: true, paymentAmountMinor: 33n, appliedMinor: 33n }],
    });
    expect(plan.creditCreatedMinor).toBe(33n);
    expect(plan.creditCarryingBaseMinor).toBe(120n);
    // Σ conv(33) = 240, while conv(66) would be 241. The document stores the former.
    expect(plan.baseAmountMinor).toBe(240n);
    expect(plan.baseAmountMinor).not.toBe(roundHalfEven(66n * USD_365.rateR10, 10n ** 10n));
  });

  it('refuses a payment whose legs are unlawful, leg by leg, without inventing a total', () => {
    expect(
      codeOf(() =>
        planCustomerPayment({
          amountMinor: 50000n,
          payment: ILS,
          legs: [{ invoice: invoice({ outstandingTxnMinor: 100n, conversion: ILS }), sameCurrency: true, paymentAmountMinor: 200n, appliedMinor: 200n }],
        }),
      ),
    ).toBe('customer_payment_allocation.amount_exceeds_outstanding');
  });
});

// ── No duplicate financial truth ─────────────────────────────────────────

describe('the settlement arithmetic is imported, never re-implemented', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'customer-settlement-payloads.ts'), 'utf8');

  it('imports the four primitives from the accepted module', () => {
    for (const name of ['convertToBase', 'apRelease', 'creditRemainingCarrying', 'creditRelease']) {
      expect(source).toContain(name);
    }
    expect(source).toMatch(/import \{[^}]*\} from '\.\/supplier-settlement';/);
  });

  it('holds no second rounding, no second release formula and no float', () => {
    // A HALF_EVEN of its own, a `rel`/`g` body of its own, or a non-integer
    // literal here would be a second body of one financial truth.
    expect(source).not.toContain('roundHalfEven');
    expect(source).not.toContain('./rounding');
    expect(source).not.toContain('Math.round');
    expect(source).not.toContain('Number(');
    expect(source).not.toContain('parseFloat');
    const executable = source
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(executable).not.toMatch(/[^.\w]\d+\.\d+/);
  });

  it('returns only bigint money', () => {
    const plan = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 5000n, totalBaseMinor: 18500n, outstandingTxnMinor: 5000n, conversion: USD_370 }),
      credit: credit(),
      sameCurrency: true,
      consumedMinor: 5000n,
      appliedMinor: 5000n,
    });
    for (const [key, value] of Object.entries(plan)) {
      if (key === 'entryLines') continue;
      expect(typeof value, key).toBe('bigint');
    }
    for (const l of plan.entryLines) {
      expect(typeof l.txnAmountMinor).toBe('bigint');
      expect(typeof l.baseAmountMinor).toBe('bigint');
    }
  });
});
