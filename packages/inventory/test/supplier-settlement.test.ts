import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSupplierSettlementVectors, type SupplierSettlementVectors } from '../scripts/s6-vector-cases';
import { InventoryError } from '../src/errors';
import { roundHalfEven } from '../src/rounding';
import {
  apRelease,
  convertToBase,
  creditRelease,
  creditRemainingCarrying,
  planCreditAllocation,
  planPaymentAllocation,
  planRefund,
  verifyCreditChain,
  verifyPurchaseChain,
  type CreditNoteState,
  type PurchaseApState,
  type SettlementConversion,
} from '../src/supplier-settlement';

const FILE = join(__dirname, '..', 'vectors', 'supplier-settlement-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as SupplierSettlementVectors;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

const ILS: SettlementConversion = { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 };
const usdAt = (rate: string): SettlementConversion => ({
  rateR10: BigInt(rate.replace('.', '').padEnd(rate.indexOf('.') + 10, '0')),
  txnExponent: 2,
  baseExponent: 2,
});

const purchase = (over: Partial<PurchaseApState> = {}): PurchaseApState => ({
  totalTxnMinor: 10000n,
  totalBaseMinor: 36000n,
  outstandingTxnMinor: 10000n,
  conversion: usdAt('3.60'),
  ...over,
});

const note = (over: Partial<CreditNoteState> = {}): CreditNoteState => ({
  originalMinor: 10000n,
  originalCarryingMinor: 36000n,
  remainingMinor: 10000n,
  conversion: usdAt('3.60'),
  ...over,
});

describe('vectors/supplier-settlement-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-s6-vectors.ts after a SPEC change only)', async () => {
    expect(await renderSupplierSettlementVectors()).toBe(committed);
  });

  it('carries the §4.1 case ids', () => {
    const ids = vectors.cases.map((c) => c.id);
    for (const required of [
      'GOLD-84-PARTIAL-FINAL',
      'GOLD-73-REFUND-EUR',
      'GOLD-61-CREDIT-ALLOC',
      'AP-THIRDS-EXACT-CLEARING',
      'FOREIGN-AP-DUST',
      'SAME-RATE-SUBUNIT-FX',
      'STRONG-BASE-MIN1',
      'BELOW-BASE-UNIT',
    ]) {
      expect(ids).toContain(required);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every recorded primitive call reproduces its result (the calls T-07 runs against the SQL functions)', () => {
    let calls = 0;
    for (const c of vectors.cases) {
      for (const s of c.steps) {
        for (const p of s.primitives) {
          calls += 1;
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
    expect(calls).toBeGreaterThan(40);
  });

  it('every accepted entry balances in base and carries no 6100, 6200 or tax line (MP-4)', () => {
    for (const c of vectors.cases) {
      for (const s of c.steps) {
        if (s.entry === null) continue;
        let balance = 0n;
        for (const l of s.entry) {
          expect(['accounts_payable', 'supplier_receivable', 'fx_gain', 'fx_loss', 'posting_account']).toContain(l.account);
          balance += (l.side === 'D' ? 1n : -1n) * BigInt(String(l.baseAmountMinor));
        }
        expect(balance, c.id).toBe(0n);
      }
    }
  });
});

describe('the primitives (§2.3)', () => {
  it('convertToBase is the 0043 law: HALF_EVEN, and the exponent shift both ways', () => {
    expect(convertToBase(33n, 36500000000n, 2, 2)).toBe(120n); // 120.45
    expect(convertToBase(50n, 36500000000n, 2, 2)).toBe(182n); // 182.5 → even
    expect(convertToBase(70n, 36500000000n, 2, 2)).toBe(256n); // 255.5 → even
    expect(convertToBase(1n, 10n ** 10n, 2, 3)).toBe(10n); // 0.01 → 0.010
    expect(convertToBase(15n, 10n ** 10n, 3, 2)).toBe(2n); // 0.015 → 0.02 (even)
    expect(convertToBase(25n, 10n ** 10n, 3, 2)).toBe(2n); // 0.025 → 0.02 (even)
    expect(convertToBase(0n, 36500000000n, 2, 2)).toBe(0n);
    expect(codeOf(() => convertToBase(-1n, 10n ** 10n, 2, 2))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => convertToBase(1n, 0n, 2, 2))).toBe('inventory.arithmetic_invalid');
  });

  it('apRelease is cumulative: any split of T releases exactly B, and never a negative amount', () => {
    for (const [T, B] of [
      [3n, 11n],
      [100n, 365n],
      [7n, 1n],
      [10n, 3n],
      [100000n, 2n],
    ] as const) {
      for (let first = 1n; first < T; first += T > 20n ? T / 7n : 1n) {
        const rest = T - first;
        const half = rest / 2n;
        const parts = [first, half, rest - half].filter((p) => p > 0n);
        let x = 0n;
        let total = 0n;
        for (const a of parts) {
          const rel = apRelease(B, T, x, a);
          expect(rel >= 0n).toBe(true);
          x += a;
          total += rel;
          expect(total).toBe(roundHalfEven(B * x, T));
        }
        expect(total).toBe(B);
      }
    }
    expect(codeOf(() => apRelease(100n, 100n, 60n, 41n))).toBe('inventory.arithmetic_invalid');
  });

  it('g: g(OA) = OB, g(0) = 0, g(r) >= 1 for r > 0, and non-increasing as r falls', () => {
    for (const [OA, OB] of [
      [10000n, 36000n],
      [100000n, 2n],
      [7n, 3n],
      [3n, 100n],
    ] as const) {
      expect(creditRemainingCarrying(OA, OB, OA)).toBe(OB);
      expect(creditRemainingCarrying(OA, OB, 0n)).toBe(0n);
      let previous: bigint = OB;
      const step = OA > 50n ? OA / 37n : 1n;
      for (let r = OA; r > 0n; r -= step) {
        const g = creditRemainingCarrying(OA, OB, r);
        expect(g >= 1n && g <= previous).toBe(true);
        previous = g;
      }
    }
    expect(codeOf(() => creditRemainingCarrying(10n, 10n, 11n))).toBe('inventory.arithmetic_invalid');
  });
});

describe('MP-5 — partial consumption releases a proportional share, the final one the entire residue', () => {
  it('GOLD-84: 60 of 100 USD carried at 360.00 release 216.00; the final 40 release 144.00', () => {
    expect(creditRelease(10000n, 36000n, 10000n, 6000n)).toBe(21600n);
    expect(creditRemainingCarrying(10000n, 36000n, 4000n)).toBe(14400n);
    expect(creditRelease(10000n, 36000n, 4000n, 4000n)).toBe(14400n);
  });

  it('whatever the sequence, the releases add up to OB exactly and the last one takes whatever is left', () => {
    for (const [OA, OB] of [
      [10000n, 36000n],
      [3n, 10n],
      [100000n, 2n],
      [999n, 1000n],
    ] as const) {
      for (const k of [1n, 2n, 3n, 7n]) {
        let r = OA;
        let released = 0n;
        const chunk = OA / k > 0n ? OA / k : 1n;
        while (r > 0n) {
          const c = r - chunk > 0n ? chunk : r;
          const rel = creditRelease(OA, OB, r, c);
          expect(rel >= 0n).toBe(true);
          if (c === r) expect(rel).toBe(creditRemainingCarrying(OA, OB, r));
          r -= c;
          released += rel;
          expect(released).toBe(OB - creditRemainingCarrying(OA, OB, r));
        }
        expect(released).toBe(OB);
      }
    }
  });

  it('a purchase cleared in thirds releases its whole base: AP base is 0 when AP txn is 0', () => {
    let O = 100n;
    let released = 0n;
    for (const a of [33n, 33n, 34n]) {
      const plan = planPaymentAllocation({
        purchase: { totalTxnMinor: 100n, totalBaseMinor: 365n, outstandingTxnMinor: O, conversion: usdAt('3.65') },
        sameCurrency: true,
        paymentAmountMinor: a,
        payment: usdAt('3.70'),
        appliedMinor: a,
      });
      O -= a;
      released += plan.carryingReleasedMinor;
    }
    expect(O).toBe(0n);
    expect(released).toBe(365n);
  });
});

describe('MP-4 — realized FX: its sign and its account', () => {
  it('a payment: paid above the carrying value is a loss (Dr 6900), below it a gain (Cr 4900)', () => {
    const loss = planPaymentAllocation({ purchase: purchase(), sameCurrency: true, paymentAmountMinor: 4000n, payment: usdAt('3.70'), appliedMinor: 4000n });
    expect(loss.realizedMinor).toBe(400n);
    expect(loss.entryLines.at(-1)).toEqual({
      account: 'fx_loss',
      side: 'D',
      currency: 'base',
      txnAmountMinor: 400n,
      baseAmountMinor: 400n,
      dimension: 'purchase',
    });
    const gain = planPaymentAllocation({ purchase: purchase(), sameCurrency: true, paymentAmountMinor: 4000n, payment: usdAt('3.50'), appliedMinor: 4000n });
    expect(gain.realizedMinor).toBe(-400n);
    expect(gain.entryLines.at(-1)).toEqual({
      account: 'fx_gain',
      side: 'C',
      currency: 'base',
      txnAmountMinor: 400n,
      baseAmountMinor: 400n,
      dimension: 'purchase',
    });
    const none = planPaymentAllocation({ purchase: purchase(), sameCurrency: true, paymentAmountMinor: 4000n, payment: usdAt('3.60'), appliedMinor: 4000n });
    expect(none.realizedMinor).toBe(0n);
    expect(none.entryLines.map((l) => l.account)).toEqual(['accounts_payable', 'posting_account']);
  });

  it('a credit allocation: credit carried above the AP extinguished is a loss; below it a gain', () => {
    const loss = planCreditAllocation({
      purchase: purchase({ totalBaseMinor: 35000n, conversion: usdAt('3.50') }),
      note: note(),
      sameCurrency: true,
      consumedMinor: 5000n,
      appliedMinor: 5000n,
    });
    expect(loss.realizedMinor).toBe(500n);
    expect(loss.entryLines.map((l) => `${l.side} ${l.account} ${l.dimension}`)).toEqual([
      'D accounts_payable purchase',
      'C supplier_receivable origin',
      'D fx_loss purchase',
    ]);
    const gain = planCreditAllocation({
      purchase: purchase({ totalBaseMinor: 37000n, conversion: usdAt('3.70') }),
      note: note(),
      sameCurrency: true,
      consumedMinor: 5000n,
      appliedMinor: 5000n,
    });
    expect(gain.realizedMinor).toBe(-500n);
    expect(gain.entryLines.at(-1)?.account).toBe('fx_gain');
  });

  it('a refund: received above the carrying value is a gain (Cr 4900), below it a loss (Dr 6900); GOLD-73', () => {
    const gold73 = planRefund({ note: note(), sameCurrency: false, consumedMinor: 10000n, receiptAmountMinor: 9000n, receipt: usdAt('4.10') });
    expect(gold73.entryLines.map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`)).toEqual([
      'D posting_account 36900',
      'C supplier_receivable 36000',
      'C fx_gain 900',
    ]);
    const loss = planRefund({ note: note(), sameCurrency: true, consumedMinor: 10000n, receiptAmountMinor: 10000n, receipt: usdAt('3.50') });
    expect(loss.realizedMinor).toBe(-1000n);
    expect(loss.entryLines.at(-1)).toEqual({
      account: 'fx_loss',
      side: 'D',
      currency: 'base',
      txnAmountMinor: 1000n,
      baseAmountMinor: 1000n,
      dimension: 'origin',
    });
  });

  it('the same-rate sub-unit difference is dust plus realized FX, never rounding (TL-8)', () => {
    const second = planPaymentAllocation({
      purchase: { totalTxnMinor: 100n, totalBaseMinor: 365n, outstandingTxnMinor: 67n, conversion: usdAt('3.65') },
      sameCurrency: true,
      paymentAmountMinor: 33n,
      payment: usdAt('3.65'),
      appliedMinor: 33n,
    });
    expect(second.apDustBaseMinor).toBe(1n);
    expect(second.realizedMinor).toBe(-1n);
    expect(second.entryLines.map((l) => l.account)).not.toContain('rounding');
  });
});

describe('oldest first — the chains (R-62, R-63)', () => {
  it('a purchase: reducers applied oldest first form one chain; an overlap, a gap or a wrong total is refused', () => {
    const first = { releasedBeforeMinor: 0n, amountMinor: 33n, releasedBaseMinor: 120n };
    const third = { releasedBeforeMinor: 66n, amountMinor: 34n, releasedBaseMinor: 124n };
    const rows = [first, { releasedBeforeMinor: 33n, amountMinor: 33n, releasedBaseMinor: 121n }, third];
    expect(codeOf(() => verifyPurchaseChain(100n, 365n, rows))).toBe('accepted');
    // Stored order does not matter: the chain is ordered by X.
    expect(codeOf(() => verifyPurchaseChain(100n, 365n, [...rows].reverse()))).toBe('accepted');
    // A zero-amount reducer (a return that released no AP) is not in the chain.
    expect(codeOf(() => verifyPurchaseChain(100n, 365n, [...rows, { releasedBeforeMinor: 50n, amountMinor: 0n, releasedBaseMinor: 0n }]))).toBe('accepted');
    // Two writers that computed from the same O overlap.
    expect(codeOf(() => verifyPurchaseChain(100n, 365n, [first, { ...first }]))).toBe('supplier_payment.settlement_inconsistent');
    expect(codeOf(() => verifyPurchaseChain(100n, 365n, [first, third]))).toBe('supplier_payment.settlement_inconsistent');
    expect(
      codeOf(() =>
        verifyPurchaseChain(
          100n,
          365n,
          rows.map((r, i) => (i === 1 ? { ...r, releasedBaseMinor: 120n } : r)),
        ),
      ),
    ).toBe('supplier_payment.settlement_inconsistent');
    expect(codeOf(() => verifyPurchaseChain(100n, 365n, [...rows, { releasedBeforeMinor: 100n, amountMinor: 1n, releasedBaseMinor: 0n }]))).toBe(
      'supplier_payment.settlement_inconsistent',
    );
  });

  it('a note: consumers applied oldest first (rb descending) form one chain matching the stored pair', () => {
    const opening = { remainingBeforeMinor: 10000n, consumedMinor: 6000n, releasedBaseMinor: 21600n };
    const rows = [opening, { remainingBeforeMinor: 4000n, consumedMinor: 4000n, releasedBaseMinor: 14400n }];
    const done = { originalMinor: 10000n, originalCarryingMinor: 36000n, remainingMinor: 0n, remainingCarryingMinor: 0n };
    expect(codeOf(() => verifyCreditChain(done, rows))).toBe('accepted');
    expect(codeOf(() => verifyCreditChain(done, [...rows].reverse()))).toBe('accepted');
    const partial = { ...done, remainingMinor: 4000n, remainingCarryingMinor: 14400n };
    expect(codeOf(() => verifyCreditChain(partial, rows.slice(0, 1)))).toBe('accepted');
    expect(codeOf(() => verifyCreditChain(partial, []))).toBe('supplier_credit_note.consumption_inconsistent');
    expect(codeOf(() => verifyCreditChain({ ...partial, remainingCarryingMinor: 14401n }, rows.slice(0, 1)))).toBe(
      'supplier_credit_note.consumption_inconsistent',
    );
    // Two consumers of the same remaining level.
    expect(codeOf(() => verifyCreditChain(done, [opening, { ...opening, consumedMinor: 4000n, releasedBaseMinor: 14400n }]))).toBe(
      'supplier_credit_note.consumption_inconsistent',
    );
  });
});

describe('the refusals, in the domain the routine raises them under', () => {
  it('MP-3: an applied amount above the outstanding AP', () => {
    expect(
      codeOf(() =>
        planPaymentAllocation({
          purchase: purchase({ outstandingTxnMinor: 100n }),
          sameCurrency: true,
          paymentAmountMinor: 101n,
          payment: usdAt('3.60'),
          appliedMinor: 101n,
        }),
      ),
    ).toBe('supplier_payment.amount_exceeds_outstanding');
    expect(
      codeOf(() =>
        planCreditAllocation({ purchase: purchase({ outstandingTxnMinor: 100n }), note: note(), sameCurrency: true, consumedMinor: 101n, appliedMinor: 101n }),
      ),
    ).toBe('supplier_credit_allocation.amount_exceeds_outstanding');
  });

  it('MP-6: a consumption above the remaining credit, or of an exhausted note', () => {
    expect(
      codeOf(() => planRefund({ note: note({ remainingMinor: 10n }), sameCurrency: true, consumedMinor: 11n, receiptAmountMinor: 11n, receipt: usdAt('3.6') })),
    ).toBe('supplier_refund.amount_exceeds_credit');
    expect(
      codeOf(() => planRefund({ note: note({ remainingMinor: 0n }), sameCurrency: true, consumedMinor: 1n, receiptAmountMinor: 1n, receipt: usdAt('3.6') })),
    ).toBe('supplier_refund.credit_exhausted');
    expect(
      codeOf(() => planCreditAllocation({ purchase: purchase(), note: note({ remainingMinor: 0n }), sameCurrency: true, consumedMinor: 1n, appliedMinor: 1n })),
    ).toBe('supplier_credit_allocation.credit_exhausted');
  });

  it('the same-currency equality', () => {
    expect(
      codeOf(() => planPaymentAllocation({ purchase: purchase(), sameCurrency: true, paymentAmountMinor: 10n, payment: usdAt('3.6'), appliedMinor: 11n })),
    ).toBe('supplier_payment.amount_mismatch');
    expect(codeOf(() => planCreditAllocation({ purchase: purchase(), note: note(), sameCurrency: true, consumedMinor: 10n, appliedMinor: 11n }))).toBe(
      'supplier_credit_allocation.amount_mismatch',
    );
    expect(codeOf(() => planRefund({ note: note(), sameCurrency: true, consumedMinor: 10n, receiptAmountMinor: 11n, receipt: usdAt('3.6') }))).toBe(
      'supplier_refund.amount_mismatch',
    );
    expect(codeOf(() => planPaymentAllocation({ purchase: purchase(), sameCurrency: false, paymentAmountMinor: 37n, payment: ILS, appliedMinor: 10n }))).toBe(
      'accepted',
    );
  });

  it('R-77 (review M1): T = 5000 TRY at 0.11 into ILS — paying 4999 or 4996 would leave a residue converting to 0 and is refused; 4995 and 5000 are accepted', () => {
    const tryAt = { rateR10: 1_100_000_000n, txnExponent: 2, baseExponent: 2 };
    const p = (outstandingTxnMinor: bigint): PurchaseApState => ({ totalTxnMinor: 5000n, totalBaseMinor: 550n, outstandingTxnMinor, conversion: tryAt });
    const payTry = (o: bigint, a: bigint): string =>
      codeOf(() => planPaymentAllocation({ purchase: p(o), sameCurrency: true, paymentAmountMinor: a, payment: tryAt, appliedMinor: a }));
    expect(payTry(5000n, 4999n)).toBe('supplier_payment.residue_below_base_unit');
    expect(codeOf(() => planPaymentAllocation({ purchase: p(5000n), sameCurrency: false, paymentAmountMinor: 550n, payment: ILS, appliedMinor: 4999n }))).toBe(
      'supplier_payment.residue_below_base_unit',
    );
    expect(payTry(5000n, 4996n)).toBe('supplier_payment.residue_below_base_unit');
    expect(payTry(5000n, 4995n)).toBe('accepted');
    expect(payTry(5000n, 5000n)).toBe('accepted');
    expect(payTry(10n, 10n)).toBe('accepted');
  });

  it('R-78: neither a refund nor a credit allocation leaves a note a remaining amount converting to 0', () => {
    const lbp: SettlementConversion = { rateR10: 24900n, txnExponent: 2, baseExponent: 3 };
    const lbpNote: CreditNoteState = { originalMinor: 100000n, originalCarryingMinor: 2n, remainingMinor: 100000n, conversion: lbp };
    const lbpPurchase: PurchaseApState = { totalTxnMinor: 200000n, totalBaseMinor: 5n, outstandingTxnMinor: 200000n, conversion: lbp };
    expect(codeOf(() => planRefund({ note: lbpNote, sameCurrency: true, consumedMinor: 99990n, receiptAmountMinor: 99990n, receipt: lbp }))).toBe(
      'supplier_refund.residue_below_base_unit',
    );
    expect(codeOf(() => planCreditAllocation({ purchase: lbpPurchase, note: lbpNote, sameCurrency: true, consumedMinor: 99990n, appliedMinor: 99990n }))).toBe(
      'supplier_credit_allocation.residue_below_base_unit',
    );
    expect(codeOf(() => planRefund({ note: lbpNote, sameCurrency: true, consumedMinor: 100000n, receiptAmountMinor: 100000n, receipt: lbp }))).toBe('accepted');
    expect(codeOf(() => planRefund({ note: lbpNote, sameCurrency: true, consumedMinor: 79000n, receiptAmountMinor: 79000n, receipt: lbp }))).toBe('accepted');
  });

  it('S5 L2: S6 refuses to leave a txn-only AP residue (base 0); one an S5 return left is a stable amount_below_base_unit refusal, and stays outstanding', () => {
    const lbp: SettlementConversion = { rateR10: 24900n, txnExponent: 2, baseExponent: 3 };
    expect(
      codeOf(() =>
        planPaymentAllocation({
          purchase: { totalTxnMinor: 100000n, totalBaseMinor: 2n, outstandingTxnMinor: 100000n, conversion: lbp },
          sameCurrency: true,
          paymentAmountMinor: 99990n,
          payment: lbp,
          appliedMinor: 99990n,
        }),
      ),
    ).toBe('supplier_payment.residue_below_base_unit');
    const first = planPaymentAllocation({
      purchase: { totalTxnMinor: 100000n, totalBaseMinor: 2n, outstandingTxnMinor: 100000n, conversion: lbp },
      sameCurrency: true,
      paymentAmountMinor: 79000n,
      payment: lbp,
      appliedMinor: 79000n,
    });
    expect(first.carryingReleasedMinor).toBe(2n);
    // An S5 return released 99990 (least(C, O)): the residue O = 10 carries base 0.
    const residue: PurchaseApState = { totalTxnMinor: 100000n, totalBaseMinor: 2n, outstandingTxnMinor: 10n, conversion: lbp };
    expect(apRelease(2n, 100000n, 0n, 99990n)).toBe(2n);
    expect(apRelease(2n, 100000n, 99990n, 10n)).toBe(0n);
    for (let attemptNo = 0; attemptNo < 3; attemptNo += 1) {
      expect(codeOf(() => planPaymentAllocation({ purchase: residue, sameCurrency: true, paymentAmountMinor: 10n, payment: lbp, appliedMinor: 10n }))).toBe(
        'supplier_payment.amount_below_base_unit',
      );
    }
  });
});
