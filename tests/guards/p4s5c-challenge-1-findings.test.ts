/**
 * P4-S5 INDEPENDENT CHALLENGE (signature 2) — the findings, demonstrated.
 *
 * This file is the challenger's evidence, not a guard the slice owes. Each test
 * is named for the finding it demonstrates and each one PASSES by exhibiting the
 * defect, so a reader can run it and see the failure scenario rather than read a
 * claim about it.
 *
 * Subject: `p4s5/owner` at `8e996c5`, based on `6587460`.
 */
import { describe, expect, it } from 'vitest';
import { refundCapRefusal, refundIntentPreimage, type RefundIntent, type ConsumableSourceCap } from '@daftar/domain-core';
import { apRelease, convertToBase } from '@daftar/inventory';
import { planCreditNoteReversal, planCustomerRefund, type ConsumableSource } from '../../apps/api/src/modules/returns/returns-settlement';

const BASE = { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 } as const;

// ── F1 (Critical): the credit note's AR reduction is a SECOND algorithm ──

describe('F1 — planCreditNoteReversal computes the AR reduction by a different algorithm than the one credit_note_applications stores', () => {
  it('the AR credit in base differs from the canonical apRelease + invoice-rate conversion, and no dust or FX line absorbs the gap', () => {
    // An invoice of 10 000 txn minor units whose stored carrying base is 10 853
    // (the 1.0853 rate the invoice was raised at, already rounded onto the row).
    const invoiceTotalTxn = 10_000n;
    const invoiceTotalBase = 10_853n;
    const invoiceConversion = { rateR10: 10_853_000_000n, txnExponent: 2, baseExponent: 2 } as const;

    // The credit note reverses 3 333 of it. The note's own snapshot is a
    // different day's rate — 1.0901 — which is the normal case, not a contrived
    // one: a note issued a week after the invoice carries its own rate.
    const noteConversion = { rateR10: 10_901_000_000n, txnExponent: 2, baseExponent: 2 } as const;
    const applied = 3_333n;

    // (a) The CANONICAL AR reduction — the one S4 ships and the one
    //     `credit_note_applications` stores, column for column:
    //       ar_released_before_txn_minor      = X
    //       invoice_carrying_base_released    = apRelease(B, T, X, a)   [invoice pair]
    //       the AR line's base                = convert(a, INVOICE rate)
    //       realized_fx_gain_loss_minor       = credit released - invoice released
    const X = 0n;
    const invoiceCarryingReleased = apRelease(invoiceTotalBase, invoiceTotalTxn, X, applied);
    const arConvertedAtInvoiceRate = convertToBase(applied, invoiceConversion.rateR10, 2, 2);

    // (b) What the plan layer actually produces.
    const plan = planCreditNoteReversal({
      totalMinor: 10_000n,
      conversion: noteConversion,
      taxMinor: '0',
      appliedToInvoiceMinor: applied,
      returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 7_000n }],
    });
    const arLine = plan.revenueEntryLines.find((l) => l.account === 'accounts_receivable');
    expect(arLine).toBeDefined();

    // THE FINDING, in three parts.
    // 1. The plan credits AR at the NOTE's rate, not the invoice's.
    expect(arLine?.baseAmountMinor).toBe(plan.appliedBaseMinor);
    expect(plan.appliedBaseMinor).not.toBe(arConvertedAtInvoiceRate);
    // 2. It disagrees with the exact stored delta the application row carries.
    expect(plan.appliedBaseMinor).not.toBe(invoiceCarryingReleased);
    // 3. There is no AR dust line and no realized-FX line anywhere in the
    //    entry, so the gap is not carried — it is absorbed into the refund
    //    liability, which means the liability a refund may later draw on was
    //    set by an FX movement nobody posted.
    expect(plan.revenueEntryLines.filter((l) => l.account === 'accounts_receivable')).toHaveLength(1);
    expect(plan.revenueEntryLines.some((l) => l.account === 'fx_gain' || l.account === 'fx_loss')).toBe(false);
    expect(plan.liabilityBaseMinor).toBe(plan.totalBaseMinor - plan.appliedBaseMinor);
  });

  it('even at ONE rate, the applied part and the header are TWO roundings at two grains — the thing the comment says it does not do', () => {
    // Same rate for note and invoice, so no FX question at all: the only effect
    // left is the second rounding. Rate 1.085 on a note of 4499 split 3500 / 999
    // is the worked case `packages/accounting/src/sale-posting.ts:36-59` records
    // — and the plan layer reproduces it on the credit-note side.
    const c = { rateR10: 10_850_000_000n, txnExponent: 2, baseExponent: 2 } as const;
    const plan = planCreditNoteReversal({
      totalMinor: 4_499n,
      conversion: c,
      taxMinor: '0',
      appliedToInvoiceMinor: 3_500n,
      returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 1_000n }],
    });
    const headerOnce = convertToBase(4_499n, c.rateR10, 2, 2); // 4881
    const appliedAgain = convertToBase(3_500n, c.rateR10, 2, 2); // 3798
    const remainderAgain = convertToBase(999n, c.rateR10, 2, 2); // 1084
    expect([headerOnce, appliedAgain, remainderAgain]).toEqual([4_881n, 3_798n, 1_084n]);
    // The two roundings are not additive — 3798 + 1084 = 4882, one unit over the
    // header's 4881. That is the exact defect `sale-posting.ts` warns about.
    expect(appliedAgain + remainderAgain).not.toBe(headerOnce);

    // The plan layer performs BOTH roundings: the header AND the applied part.
    expect(plan.totalBaseMinor).toBe(headerOnce);
    expect(plan.appliedBaseMinor).toBe(appliedAgain);
    // It then makes the liability the RESIDUAL, so the entry balances — but the
    // liability is now 1083, not the 1084 a conversion of the remainder gives.
    // Which number is the refund liability depends on which layer rounds, and a
    // later refund's cap is taken from the source's remaining PAIR that this
    // number sets. The comment at `returns-settlement.ts:421-426` says this is
    // "an exact integer SPLIT of the ONE header conversion, never two
    // independent conversions"; the code performs two independent conversions.
    expect(plan.liabilityBaseMinor).toBe(1_083n);
    expect(plan.liabilityBaseMinor).not.toBe(remainderAgain);
    expect(plan.liabilityBaseMinor + plan.appliedBaseMinor).toBe(headerOnce);
  });
});

// ── F2 (High): `refundCapRefusal.length === 2` is not a constraint ───────

describe('F2 — the race-4 red proof asserts a signature coincidence, not that the cap takes no rate', () => {
  it('a cap that DOES take a rate argument passes `.length === 2`, because an optional parameter is excluded', () => {
    // The widened cap an attacker (or a well-meaning FX patch) would write: the
    // remaining is converted into the DISBURSEMENT currency before comparison,
    // so stating a rate of 4 admits four times the credit note. This is exactly
    // the defect the author's race-4 red proof claims to have made
    // unexpressible.
    // NOTE the mechanism: a DEFAULT-valued parameter, not a TypeScript-optional
    // one. `Function.prototype.length` counts parameters up to the first with a
    // default, so `rateR10 = 10n ** 10n` is invisible to `.length` while
    // `rateR10?: bigint` would not be. A rate added for backward compatibility
    // is added exactly this way.
    const widenedCap = (source: ConsumableSourceCap, requestedMinor: bigint, rateR10: bigint = 10n ** 10n): string | null => {
      const cap = (source.remainingMinor * rateR10) / 10n ** 10n;
      if (requestedMinor <= 0n) return 'customer_refund.amount_invalid';
      if (source.remainingMinor <= 0n) return 'customer_refund.source_exhausted';
      return requestedMinor > cap ? 'customer_refund.amount_exceeds_source' : null;
    };
    const src: ConsumableSourceCap = { kind: 'credit_note', originalMinor: 5_000n, remainingMinor: 5_000n };

    // The author's assertion is satisfied by the widened cap.
    expect(widenedCap.length).toBe(2);
    expect(refundCapRefusal.length).toBe(2);
    // And the widened cap is exactly as wide as the planted defect: 20 000 out
    // of a 5 000 source, admitted by stating a rate.
    expect(widenedCap(src, 20_000n)).toBe('customer_refund.amount_exceeds_source');
    expect(widenedCap(src, 20_000n, 4n * 10n ** 10n)).toBeNull();
    // So `.length` cannot distinguish the lawful cap from the widened one.
  });

  it('the rate-invariance arm compares the cap to ITSELF — the two calls differ in no argument', () => {
    // Reproduced verbatim from the author's race 4, lines 329-332: the names say
    // "weak rate" and "strong rate" and the expressions are identical.
    const locked: ConsumableSourceCap = { kind: 'credit_note', originalMinor: 5_000n, remainingMinor: 5_000n };
    const atWeakRate = refundCapRefusal(locked, 5_000n);
    const atStrongRate = refundCapRefusal(locked, 5_000n);
    expect(atWeakRate).toEqual(atStrongRate);
    // A test of the form f(x) === f(x) over a pure function is true for EVERY
    // f, including a rate-taking one. Demonstrated:
    const rateTaking = (s: ConsumableSourceCap, r: bigint, rate = 10n ** 10n): string | null =>
      r > (s.remainingMinor * rate) / 10n ** 10n ? 'customer_refund.amount_exceeds_source' : null;
    expect(rateTaking(locked, 5_000n)).toEqual(rateTaking(locked, 5_000n));
    expect(rateTaking.length).toBe(2);
  });
});

// ── F3 (Medium): the intent pre-image is not unambiguous ────────────────

describe('F3 — `refundIntentPreimage` is separator-ambiguous, so two different economic commands can share a pre-image', () => {
  it('a newline in one field and its absence in the next produce ONE pre-image for TWO intents', () => {
    const base: RefundIntent = {
      refundId: 'r1',
      customerId: 'c1',
      creditNoteId: 'n1',
      customerCreditId: null,
      paymentMethodId: 'pm1',
      refundDate: '2026-10-07',
      sourceCurrency: 'USD',
      sourceAmountConsumedMinor: '100',
      disbursementCurrency: 'USD',
      disbursementAmountMinor: '100',
      reference: 'ref',
    };
    // A: the disbursement field carries the injected newline; the reference is "y".
    const a: RefundIntent = { ...base, disbursementAmountMinor: '100\nx', reference: 'y' };
    // B: the disbursement is the honest "100"; the reference carries the newline.
    const b: RefundIntent = { ...base, disbursementAmountMinor: '100', reference: 'x\ny' };
    expect(refundIntentPreimage(a)).toBe(refundIntentPreimage(b));
    // So a key stored under A replays B as "the same economic command". The
    // function fixes the ORDER and the ABSENCE encoding, which is what its doc
    // claims, and does NOT make the pre-image injective — a canonical pre-image
    // needs length prefixing or escaping, not a bare separator.
  });

  it('a literal U+0000 in a free-text field collides with the ABSENCE encoding', () => {
    const base: RefundIntent = {
      refundId: 'r1',
      customerId: 'c1',
      creditNoteId: 'n1',
      customerCreditId: null,
      paymentMethodId: 'pm1',
      refundDate: '2026-10-07',
      sourceCurrency: 'USD',
      sourceAmountConsumedMinor: '100',
      disbursementCurrency: 'USD',
      disbursementAmountMinor: '100',
      reference: null,
    };
    const absent: RefundIntent = { ...base, reference: null };
    const literalNul: RefundIntent = { ...base, reference: '\u0000' };
    expect(refundIntentPreimage(absent)).toBe(refundIntentPreimage(literalNul));
    // The doc's stated guarantee is `null` vs `""`, and that one HOLDS:
    expect(refundIntentPreimage({ ...base, reference: '' })).not.toBe(refundIntentPreimage(absent));
  });
});

// ── F4 (Medium): the contract-shape parser is blind to a non-readonly field ──

describe('F4 — the contract-shape guard reads only `readonly` members, so an `invoiceId` without it is invisible', () => {
  it('the parser the suite ships misses a field declared without `readonly`', () => {
    // The parser, copied from
    // `packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts:61`.
    const fieldsOf = (body: string): string[] =>
      [
        ...body
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .matchAll(/^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/gm),
      ].map((m) => m[1] as string);

    const lawful = `
  readonly refundId: string;
  readonly customerId: string;
`;
    const tampered = `
  readonly refundId: string;
  readonly customerId: string;
  invoiceId: string;
`;
    expect(fieldsOf(lawful)).toEqual(['refundId', 'customerId']);
    // The planted `invoiceId` does not appear, so every downstream assertion —
    // `refundInvoiceNamingFields(fields)` is empty, `REFUND_NAMES_NO_INVOICE` is
    // true — stays GREEN over a `RefundDto` that names an invoice.
    expect(fieldsOf(tampered)).toEqual(['refundId', 'customerId']);
    expect(fieldsOf(tampered)).not.toContain('invoiceId');
    // No lint rule in this tree requires `readonly` on an interface member, so
    // the omission is not caught elsewhere either.
  });
});

// ── F5 (Medium): nothing bounds the cash a cross-currency refund disburses ──

describe('F5 — the cap bounds what the SOURCE gives up and nothing bounds what LEAVES the bank', () => {
  it('a refund consuming 100 of a 100 source disburses 50 000, with the gap posted as an FX loss', () => {
    const src: ConsumableSource = {
      kind: 'credit_note',
      originalMinor: 100n,
      originalCarryingMinor: 100n,
      remainingMinor: 100n,
      conversion: BASE,
    };
    const plan = planCustomerRefund({
      source: src,
      consumedMinor: 100n,
      // The caller ASSERTS the currencies differ. The plan layer takes the claim
      // and never compares `sourceCurrency` to `disbursementCurrency` — it holds
      // neither.
      sameCurrency: false,
      disbursementAmountMinor: 50_000n,
      disbursement: BASE,
    });
    expect(plan.consumedMinor).toBe(100n);
    expect(plan.disbursementAmountMinor).toBe(50_000n);
    expect(plan.realizedMinor).toBe(-49_900n);
    // The entry balances, the liability is discharged by 100, and 50 000 leaves
    // the posting account with 49 900 booked to 6900.
    expect(plan.entryLines.map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`)).toEqual([
      'D customer_refund_liability 100',
      'C posting_account 50000',
      'D fx_loss 49900',
    ]);
    // The same-currency guard is a caller-supplied boolean, so flipping it is
    // the whole of the bypass:
    expect(() => planCustomerRefund({ source: src, consumedMinor: 100n, sameCurrency: true, disbursementAmountMinor: 50_000n, disbursement: BASE })).toThrow();
  });
});
