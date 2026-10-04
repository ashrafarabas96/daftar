/**
 * `src/customer-settlement.ts` — the P4-S4 AR settlement arithmetic, held to
 * `vectors/customer-settlement-vectors.json` exactly as
 * `test/supplier-settlement.test.ts` holds the supplier mirror to its own
 * vectors.
 *
 * The behavioural half of this suite was carried over from
 * `test/customer-settlement-payloads.test.ts`, whose module was one of the two
 * implementations the single body was reconciled from; every case it covered
 * is covered here, under the reconciled (API) names and refusal codes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCustomerSettlementVectors, type CustomerSettlementVectors } from '../scripts/customer-settlement-vector-cases';
import {
  CUSTOMER_PAYMENT_MAX_ALLOCATIONS,
  RECEIVABLE_ARITHMETIC_CODES,
  ReceivableArithmeticError,
  assertPaymentClosure,
  isReceivableArithmeticCode,
  paymentSurplusMinor,
  planCustomerCreditApplication,
  planCustomerCreditCreation,
  planCustomerPayment,
  planCustomerPaymentAllocation,
  type CustomerCreditState,
  type CustomerPaymentLegInput,
  type InvoiceArState,
  type ReceivableConversion,
  type ReceivableEntryLine,
} from '../src/customer-settlement';
import { InventoryError } from '../src/errors';
import { apRelease, convertToBase, creditRemainingCarrying } from '../src/supplier-settlement';
import { roundHalfEven } from '../src/rounding';

const FILE = join(__dirname, '..', 'vectors', 'customer-settlement-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as CustomerSettlementVectors;

/** The code of a refusal, or `'accepted'`. Never a message: a message is not a contract. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReceivableArithmeticError || e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

const at = (rateR10: bigint, txnExponent = 2, baseExponent = 2): ReceivableConversion => ({ rateR10, txnExponent, baseExponent });

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
  account: ReceivableEntryLine['account'],
  side: 'D' | 'C',
  currency: ReceivableEntryLine['currency'],
  txnAmountMinor: bigint,
  baseAmountMinor: bigint,
): ReceivableEntryLine => ({ account, side, currency, txnAmountMinor, baseAmountMinor });

// ── The vector file ──────────────────────────────────────────────────────

describe('vectors/customer-settlement-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-customer-settlement-vectors.ts after a SPEC change only)', async () => {
    expect(await renderCustomerSettlementVectors()).toBe(committed);
  });

  it('carries the case ids of every law this arithmetic owes, each exactly once', () => {
    const ids = vectors.cases.map((c) => c.id);
    for (const required of [
      'AR-THIRDS-EXACT-CLEARING',
      'FOREIGN-AR-DUST',
      'SAME-RATE-SUBUNIT-FX',
      'GOLD-84-PARTIAL-FINAL',
      'CREDIT-ALLOC-FX-SIGN',
      'STRONG-BASE-MIN1',
      'BELOW-BASE-UNIT',
      'RESIDUE-BELOW-BASE-UNIT',
      'ON-ACCOUNT-SURPLUS-CREDIT',
      'SURPLUS-CREDIT-BIRTH-IDENTITY',
    ]) {
      expect(ids).toContain(required);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every recorded primitive call reproduces its result, through the ACCEPTED primitive and no local copy', () => {
    let calls = 0;
    const seen = new Set<string>();
    for (const c of vectors.cases) {
      for (const s of c.steps) {
        for (const p of s.primitives) {
          calls += 1;
          seen.add(p.fn);
          const [a, b, x, y] = p.args;
          let result: bigint;
          if (p.fn === 'supplier_convert_base') {
            const rate = String(b);
            result = convertToBase(BigInt(String(a)), BigInt(rate.replace('.', '')), Number(x), Number(y));
          } else if (p.fn === 'supplier_ap_release') {
            result = apRelease(BigInt(String(a)), BigInt(String(b)), BigInt(String(x)), BigInt(String(y)));
          } else {
            result = creditRemainingCarrying(BigInt(String(a)), BigInt(String(b)), BigInt(String(x)));
          }
          expect(result.toString(), `${c.id} ${p.fn}(${p.args.join(', ')})`).toBe(p.result);
        }
      }
    }
    // All three SQL primitives of 0067:671/683/696 are exercised, so the SQL
    // side can be held to these very numbers.
    expect([...seen].sort()).toStrictEqual(['supplier_ap_release', 'supplier_convert_base', 'supplier_credit_remaining_carrying']);
    expect(calls).toBeGreaterThan(80);
  });

  it('every accepted entry balances in base and carries no 6100, 6200 or tax line', () => {
    let entries = 0;
    for (const c of vectors.cases) {
      for (const s of c.steps) {
        if (s.entry === null) continue;
        entries += 1;
        let balance = 0n;
        for (const l of s.entry) {
          expect(['accounts_receivable', 'customer_credit_liability', 'fx_gain', 'fx_loss', 'posting_account']).toContain(l.account);
          expect(BigInt(String(l.baseAmountMinor)) > 0n, `${c.id} line base`).toBe(true);
          balance += (l.side === 'D' ? 1n : -1n) * BigInt(String(l.baseAmountMinor));
        }
        expect(balance, c.id).toBe(0n);
      }
    }
    expect(entries).toBeGreaterThan(15);
  });

  it('every refusal a case records is a code this arithmetic declares', () => {
    const refusals = vectors.cases.flatMap((c) => c.steps.map((s) => s.outcome)).filter((o) => o !== 'accepted');
    expect(refusals.length).toBeGreaterThan(5);
    for (const code of refusals) expect(isReceivableArithmeticCode(code), code).toBe(true);
  });
});

// ── The arithmetic is the accepted one, vector for vector ────────────────

describe('a customer payment allocation reuses the accepted release', () => {
  it('clears a 1.00 USD invoice in USD thirds: the cumulative releases 120, 121, 124 sum to the whole 365 (AR-THIRDS-EXACT-CLEARING)', () => {
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
      expect(plan.arReleasedBeforeMinor).toBe(e.X);
      expect(plan.invoiceCarryingReleasedMinor).toBe(e.rel);
      expect(plan.arDustBaseMinor).toBe(e.dust);
      expect(plan.paymentBaseMinor).toBe(e.pb);
      expect(plan.realizedFxMinor).toBe(e.realized);
      releaseSum += plan.invoiceCarryingReleasedMinor;
      appliedSum += plan.invoiceAmountAppliedMinor;
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
    // The AR principal and its dust first, then the cash, then the realized FX.
    expect(plan.entryLines).toStrictEqual([
      line('accounts_receivable', 'C', 'invoice', 33n, 120n),
      line('accounts_receivable', 'C', 'base', 1n, 1n),
      line('posting_account', 'D', 'payment', 33n, 122n),
      line('fx_gain', 'C', 'base', 1n, 1n),
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
    expect([first.invoiceCarryingReleasedMinor, first.paymentBaseMinor, first.arDustBaseMinor, first.realizedFxMinor]).toStrictEqual([120n, 120n, 0n, 0n]);
    const second = planCustomerPaymentAllocation({
      invoice: invoice({ ...totals, outstandingTxnMinor: 67n }),
      sameCurrency: true,
      paymentAmountMinor: 33n,
      payment: USD_365,
      appliedMinor: 33n,
    });
    expect([second.invoiceCarryingReleasedMinor, second.paymentBaseMinor, second.arDustBaseMinor, second.realizedFxMinor]).toStrictEqual([121n, 120n, 1n, -1n]);
    // A loss, because the invoice released more carrying base than the cash was worth.
    expect(second.entryLines).toContainEqual(line('fx_loss', 'D', 'base', 1n, 1n));
    expect(second.entryLines.map((l) => l.account)).not.toContain('rounding');
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
      expect([plan.invoiceCarryingReleasedMinor, plan.arConvertedMinor, plan.arDustBaseMinor, plan.realizedFxMinor]).toStrictEqual([
        e.rel,
        e.conv,
        e.dust,
        e.realized,
      ]);
      releaseSum += plan.invoiceCarryingReleasedMinor;
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
    expect(first.creditCarryingReleasedMinor).toBe(21600n);
    expect(first.creditDustBaseMinor).toBe(0n);
    expect(first.remainingAfterMinor).toBe(4000n);
    expect(first.remainingCarryingAfterMinor).toBe(14400n);
    expect(first.realizedFxMinor).toBe(0n);

    const final = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 4000n, totalBaseMinor: 14800n, outstandingTxnMinor: 4000n, conversion: USD_370 }),
      credit: credit({ remainingMinor: 4000n }),
      sameCurrency: true,
      consumedMinor: 4000n,
      appliedMinor: 4000n,
    });
    // The whole residue, nothing stranded: the two releases are exactly OB.
    expect(final.creditCarryingReleasedMinor).toBe(14400n);
    expect(first.creditCarryingReleasedMinor + final.creditCarryingReleasedMinor).toBe(36000n);
    expect(final.remainingAfterMinor).toBe(0n);
    expect(final.remainingCarryingAfterMinor).toBe(0n);
    expect(final.invoiceCarryingReleasedMinor).toBe(14800n);
    expect(final.realizedFxMinor).toBe(-400n);
    expect(final.entryLines).toStrictEqual([
      line('customer_credit_liability', 'D', 'credit', 4000n, 14400n),
      line('accounts_receivable', 'C', 'invoice', 4000n, 14800n),
      line('fx_loss', 'D', 'base', 400n, 400n),
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
    expect([loss.creditCarryingReleasedMinor, loss.invoiceCarryingReleasedMinor, loss.realizedFxMinor]).toStrictEqual([18000n, 18500n, -500n]);
    expect(loss.entryLines).toContainEqual(line('fx_loss', 'D', 'base', 500n, 500n));

    const gain = planCustomerCreditApplication({
      invoice: invoice({ totalTxnMinor: 5000n, totalBaseMinor: 17500n, outstandingTxnMinor: 5000n, conversion: USD_350 }),
      credit: credit({ remainingMinor: 5000n }),
      sameCurrency: true,
      consumedMinor: 5000n,
      appliedMinor: 5000n,
    });
    expect([gain.creditCarryingReleasedMinor, gain.invoiceCarryingReleasedMinor, gain.realizedFxMinor]).toStrictEqual([18000n, 17500n, 500n]);
    expect(gain.entryLines).toContainEqual(line('fx_gain', 'C', 'base', 500n, 500n));
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
    expect([first.creditCarryingReleasedMinor, first.creditConvertedMinor, first.creditDustBaseMinor]).toStrictEqual([1n, 2n, -1n]);
    expect([first.invoiceCarryingReleasedMinor, first.arConvertedMinor, first.arDustBaseMinor]).toStrictEqual([2n, 2n, 0n]);
    expect(first.realizedFxMinor).toBe(-1n);
    // g never falls below one minor unit while anything remains.
    expect(first.remainingCarryingAfterMinor).toBe(1n);

    const second = planCustomerCreditApplication({
      invoice: invoice({ ...totals, outstandingTxnMinor: 21000n }),
      credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 21000n, conversion: LBP }),
      sameCurrency: true,
      consumedMinor: 21000n,
      appliedMinor: 21000n,
    });
    expect([second.creditCarryingReleasedMinor, second.creditConvertedMinor, second.creditDustBaseMinor]).toStrictEqual([1n, 1n, 0n]);
    expect([second.invoiceCarryingReleasedMinor, second.arConvertedMinor, second.arDustBaseMinor]).toStrictEqual([0n, 1n, -1n]);
    expect(second.realizedFxMinor).toBe(1n);
    expect(second.remainingCarryingAfterMinor).toBe(0n);
    // The two releases are exactly OB: the floor took nothing from the total.
    expect(first.creditCarryingReleasedMinor + second.creditCarryingReleasedMinor).toBe(2n);
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
    ).toBe('customer_payment.residue_below_base_unit');
  });

  it('accepts the same invoice when what remains still converts to a base minor unit', () => {
    const plan = planCustomerPaymentAllocation({
      invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 100000n }),
      sameCurrency: false,
      paymentAmountMinor: 2n,
      payment: JOD,
      appliedMinor: 79000n,
    });
    expect([plan.invoiceCarryingReleasedMinor, plan.arConvertedMinor, plan.arDustBaseMinor, plan.realizedFxMinor]).toStrictEqual([2n, 2n, 0n, 0n]);
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
    ).toBe('customer_payment.amount_below_base_unit');
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

describe('every refusal code this module declares has a planted red proof', () => {
  const lbpInvoice = { totalTxnMinor: 100000n, totalBaseMinor: 2n, conversion: LBP };
  const lawfulLeg: CustomerPaymentLegInput = { invoice: invoice(), sameCurrency: true, paymentAmountMinor: 100n, appliedMinor: 100n };

  /** Every code the suite proves reachable, collected and compared with the declared union. */
  const proved = new Set<string>();
  const proves = (expected: string, fn: () => unknown): void => {
    expect(codeOf(fn)).toBe(expected);
    proved.add(expected);
  };

  it('customer_payment.arithmetic_invalid — a payment amount that is not positive', () => {
    // The closure law asserts the header amount; a non-positive one is a
    // DEFECT (the zod schema refuses it long before), so it is a 500-class
    // code and not merchant-facing input validation.
    proves('customer_payment.arithmetic_invalid', () => planCustomerPayment({ amountMinor: 0n, payment: USD_360, legs: [] }));
  });

  it('customer_payment.allocations_invalid — more than 50 allocations', () => {
    proves('customer_payment.allocations_invalid', () =>
      planCustomerPayment({
        amountMinor: 5200n,
        payment: USD_360,
        legs: Array.from({ length: CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1 }, () => lawfulLeg),
      }),
    );
    // And exactly 50 lawful legs is accepted: the cap is a boundary, not an off-by-one.
    expect(
      codeOf(() =>
        planCustomerPayment({
          amountMinor: 5000n,
          payment: USD_360,
          legs: Array.from({ length: CUSTOMER_PAYMENT_MAX_ALLOCATIONS }, () => lawfulLeg),
        }),
      ),
    ).toBe('accepted');
  });

  it('customer_payment.allocations_invalid — the legs consume more than the payment received', () => {
    proves('customer_payment.allocations_invalid', () => planCustomerPayment({ amountMinor: 50n, payment: USD_360, legs: [lawfulLeg] }));
  });

  it('customer_payment.allocations_invalid — a leg whose own payment amount is not positive', () => {
    proves('customer_payment.allocations_invalid', () =>
      planCustomerPaymentAllocation({ invoice: invoice(), sameCurrency: true, paymentAmountMinor: 0n, payment: USD_360, appliedMinor: 100n }),
    );
  });

  it('customer_payment.amount_invalid — a non-positive APPLIED amount, the templated raise site', () => {
    proves('customer_payment.amount_invalid', () =>
      planCustomerPaymentAllocation({ invoice: invoice(), sameCurrency: false, paymentAmountMinor: 100n, payment: USD_360, appliedMinor: 0n }),
    );
  });

  it('customer_payment.credit_below_base_unit — a surplus that converts to less than one base minor unit', () => {
    proves('customer_payment.credit_below_base_unit', () => planCustomerPayment({ amountMinor: 5n, payment: LBP, legs: [] }));
  });

  it('customer_payment.amount_exceeds_outstanding', () => {
    proves('customer_payment.amount_exceeds_outstanding', () =>
      planCustomerPaymentAllocation({
        invoice: invoice({ outstandingTxnMinor: 100n }),
        sameCurrency: true,
        paymentAmountMinor: 101n,
        payment: USD_360,
        appliedMinor: 101n,
      }),
    );
  });

  it('customer_payment.amount_mismatch', () => {
    proves('customer_payment.amount_mismatch', () =>
      planCustomerPaymentAllocation({ invoice: invoice(), sameCurrency: true, paymentAmountMinor: 101n, payment: USD_360, appliedMinor: 100n }),
    );
  });

  it('customer_payment.amount_below_base_unit — the payment amount itself', () => {
    proves('customer_payment.amount_below_base_unit', () =>
      planCustomerPaymentAllocation({
        invoice: invoice({ totalTxnMinor: 100n, totalBaseMinor: 365n, outstandingTxnMinor: 100n, conversion: USD_365 }),
        sameCurrency: false,
        paymentAmountMinor: 5n,
        payment: LBP,
        appliedMinor: 100n,
      }),
    );
  });

  it('customer_payment.residue_below_base_unit', () => {
    proves('customer_payment.residue_below_base_unit', () =>
      planCustomerPaymentAllocation({
        invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 100000n }),
        sameCurrency: false,
        paymentAmountMinor: 2n,
        payment: JOD,
        appliedMinor: 99990n,
      }),
    );
  });

  it('customer_credit_application.amount_invalid — a non-positive APPLIED amount, the other side of the template', () => {
    proves('customer_credit_application.amount_invalid', () =>
      planCustomerCreditApplication({ invoice: invoice(), credit: credit(), sameCurrency: false, consumedMinor: 100n, appliedMinor: 0n }),
    );
  });

  it('customer_credit_application.amount_exceeds_outstanding', () => {
    proves('customer_credit_application.amount_exceeds_outstanding', () =>
      planCustomerCreditApplication({
        invoice: invoice({ outstandingTxnMinor: 100n }),
        credit: credit(),
        sameCurrency: true,
        consumedMinor: 101n,
        appliedMinor: 101n,
      }),
    );
  });

  it('customer_credit_application.amount_exceeds_credit', () => {
    proves('customer_credit_application.amount_exceeds_credit', () =>
      planCustomerCreditApplication({
        invoice: invoice(),
        credit: credit({ remainingMinor: 5000n }),
        sameCurrency: true,
        consumedMinor: 6000n,
        appliedMinor: 6000n,
      }),
    );
  });

  it('customer_credit_application.credit_exhausted', () => {
    proves('customer_credit_application.credit_exhausted', () =>
      planCustomerCreditApplication({ invoice: invoice(), credit: credit({ remainingMinor: 0n }), sameCurrency: true, consumedMinor: 1n, appliedMinor: 1n }),
    );
  });

  it('customer_credit_application.amount_mismatch', () => {
    proves('customer_credit_application.amount_mismatch', () =>
      planCustomerCreditApplication({ invoice: invoice(), credit: credit(), sameCurrency: true, consumedMinor: 100n, appliedMinor: 101n }),
    );
  });

  it('customer_credit_application.amount_below_base_unit — the consumed amount, on the CREDIT snapshot alone', () => {
    // The invoice leg is lawful throughout (JOD at 1, nothing strands), so only
    // the credit side's own conversion can raise this.
    proves('customer_credit_application.amount_below_base_unit', () =>
      planCustomerCreditApplication({
        invoice: invoice({ totalTxnMinor: 1000n, totalBaseMinor: 1000n, outstandingTxnMinor: 1000n, conversion: JOD }),
        credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 100000n, conversion: LBP }),
        sameCurrency: false,
        consumedMinor: 10n,
        appliedMinor: 10n,
      }),
    );
  });

  it('customer_credit_application.amount_below_base_unit — the applied amount, on the INVOICE snapshot alone', () => {
    // Mirror image: the credit leg is lawful (JOD at 1), the invoice leg is not.
    proves('customer_credit_application.amount_below_base_unit', () =>
      planCustomerCreditApplication({
        invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 10n }),
        credit: credit({ originalMinor: 100000n, originalCarryingMinor: 100000n, remainingMinor: 100000n, conversion: JOD }),
        sameCurrency: false,
        consumedMinor: 10n,
        appliedMinor: 10n,
      }),
    );
  });

  it('customer_credit_application.residue_below_base_unit', () => {
    proves('customer_credit_application.residue_below_base_unit', () =>
      planCustomerCreditApplication({
        invoice: invoice({ ...lbpInvoice, outstandingTxnMinor: 21000n }),
        credit: credit({ originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 21000n, conversion: LBP }),
        sameCurrency: true,
        consumedMinor: 20990n,
        appliedMinor: 20990n,
      }),
    );
  });

  it('EVERY declared code was proved reachable, and the declared list is the runtime half of the union', () => {
    expect([...proved].sort()).toStrictEqual([...RECEIVABLE_ARITHMETIC_CODES].sort());
    expect(RECEIVABLE_ARITHMETIC_CODES).toHaveLength(15);
    for (const code of RECEIVABLE_ARITHMETIC_CODES) expect(isReceivableArithmeticCode(code)).toBe(true);
    expect(isReceivableArithmeticCode('customer_payment.not_a_code')).toBe(false);
  });

  it('carries the code alone off the wire', () => {
    const e = new ReceivableArithmeticError('customer_payment.allocations_invalid', 'a payment amount must be positive');
    expect(e.code).toBe('customer_payment.allocations_invalid');
    expect(e.name).toBe('ReceivableArithmeticError');
  });
});

// ── The payment document and its closure law (OQ-4) ──────────────────────

describe('the closure law of a customer payment', () => {
  it('represents a pure on-account collection: no allocation, the whole amount becomes a customer credit', () => {
    const plan = planCustomerPayment({ amountMinor: 50000n, payment: ILS, legs: [] });
    expect(plan.allocations).toStrictEqual([]);
    expect(plan.surplusMinor).toBe(50000n);
    expect(plan.credit?.originalAmountMinor).toBe(50000n);
    expect(plan.credit?.originalCarryingBaseMinor).toBe(50000n);
    // Not zero: the header base is the credit's carrying base.
    expect(plan.baseAmountMinor).toBe(50000n);
    expect(plan.credit?.entryLines).toStrictEqual([
      line('posting_account', 'D', 'payment', 50000n, 50000n),
      line('customer_credit_liability', 'C', 'payment', 50000n, 50000n),
    ]);
  });

  it('closes a partly allocated payment with the surplus, and a fully allocated one with nothing', () => {
    const inv = invoice({ totalTxnMinor: 30000n, totalBaseMinor: 30000n, outstandingTxnMinor: 30000n, conversion: ILS });
    const leg: CustomerPaymentLegInput = { invoice: inv, sameCurrency: true, paymentAmountMinor: 30000n, appliedMinor: 30000n };

    const partial = planCustomerPayment({ amountMinor: 50000n, payment: ILS, legs: [leg] });
    expect(partial.allocations).toHaveLength(1);
    expect(partial.surplusMinor).toBe(20000n);
    expect(partial.credit?.originalCarryingBaseMinor).toBe(20000n);
    expect(partial.baseAmountMinor).toBe(50000n);
    // The closure law, in the payment currency only.
    expect(partial.allocations.reduce((s, a) => s + a.paymentAmountMinor, 0n) + partial.surplusMinor).toBe(50000n);

    const full = planCustomerPayment({ amountMinor: 30000n, payment: ILS, legs: [leg] });
    expect(full.surplusMinor).toBe(0n);
    // NULL exactly when the payment is fully allocated.
    expect(full.credit).toBeNull();
    expect(full.baseAmountMinor).toBe(30000n);
  });

  it('is the sum of single roundings, never one rounding of the sum (P4-AL-25)', () => {
    const inv = invoice({ totalTxnMinor: 33n, totalBaseMinor: 120n, outstandingTxnMinor: 33n, conversion: USD_365 });
    const plan = planCustomerPayment({
      amountMinor: 66n,
      payment: USD_365,
      legs: [{ invoice: inv, sameCurrency: true, paymentAmountMinor: 33n, appliedMinor: 33n }],
    });
    expect(plan.surplusMinor).toBe(33n);
    expect(plan.credit?.originalCarryingBaseMinor).toBe(120n);
    // Σ conv(33) = 240, while conv(66) would be 241. The document stores the former.
    expect(plan.baseAmountMinor).toBe(240n);
    expect(convertToBase(66n, USD_365.rateR10, 2, 2)).toBe(241n);
    expect(plan.baseAmountMinor).not.toBe(241n);
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
    ).toBe('customer_payment.amount_exceeds_outstanding');
  });

  it('the closure helpers are the law on their own: the surplus, and both halves of the identity', () => {
    expect(paymentSurplusMinor(100n, [30n, 20n])).toBe(50n);
    expect(paymentSurplusMinor(100n, [100n])).toBe(0n);
    expect(codeOf(() => paymentSurplusMinor(100n, [101n]))).toBe('customer_payment.allocations_invalid');
    expect(codeOf(() => assertPaymentClosure(100n, [30n, 20n], 50n))).toBe('accepted');
    expect(codeOf(() => assertPaymentClosure(100n, [30n, 20n], 49n))).toBe('customer_payment.allocations_invalid');
    expect(codeOf(() => assertPaymentClosure(100n, [], 100n))).toBe('accepted');
  });

  it('a credit is born satisfying g(OA) = OB, the verifier’s stored-pair identity', () => {
    const born = planCustomerCreditCreation({ surplusMinor: 10000n, payment: USD_360 });
    expect(born.originalAmountMinor).toBe(10000n);
    expect(born.originalCarryingBaseMinor).toBe(36000n);
    // Asserted through the ACCEPTED primitive, not re-derived here.
    expect(creditRemainingCarrying(born.originalAmountMinor, born.originalCarryingBaseMinor, born.originalAmountMinor)).toBe(born.originalCarryingBaseMinor);
  });
});

// ── No duplicate financial truth ─────────────────────────────────────────

describe('the settlement arithmetic is imported, never re-implemented', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'customer-settlement.ts'), 'utf8');

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

  it('is the ONLY plan layer in the package: no sibling module re-implements it', () => {
    // The reconciliation that produced this module removed
    // `src/customer-settlement-payloads.ts`, which held a second body of
    // `arSide`, `creditSide`, both dusts, the realized FX and the closure.
    // A reappearing second planner is what this assertion catches.
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(index).toContain("export * from './customer-settlement';");
    expect(index).not.toContain('customer-settlement-payloads');
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
