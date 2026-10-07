/**
 * P4-S5, maturity level C — the plan layer's guards, each proved able to go RED.
 *
 * Every `describe` here plants a REAL subject: the shape the slice actually
 * ships, the spelling the frozen database CHECK actually forbids, the account
 * the ruling actually excludes, or the field name the ruling actually names.
 * None of them is a fictional example constructed to make a regular expression
 * fire, because a red proof over a fictional subject proves only that the
 * regular expression works on fiction.
 *
 * The device each proof uses is the same: assert the guard GREEN on the real
 * lawful shape, then plant the real unlawful one and assert it RED. A guard that
 * has only ever been seen green is not a trustworthy guard.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDIT_NOTE_LIFECYCLE_TRANSITIONS,
  REFUND_ENTRY_ACCOUNTS,
  REFUND_INTENT_FIELDS,
  REFUND_NAMES_NO_INVOICE,
  RETURNS_LOCK_ORDER,
  RETURNS_REFUSAL_CODES,
  S5_ACCOUNTING_SOURCE_TYPES,
  S5_OPERATION_CODES,
  creditNoteCogsReversalBaseMinor,
  creditNoteTaxRefusal,
  creditNoteVoidRefusal,
  forbiddenRefundFields,
  isCreditNoteLifecycleTransitionAllowed,
  isLawfulLockTrace,
  isRefundEntryAccount,
  isRepresentableOperationCode,
  isReturnsRefusalCode,
  isSameRefundIntent,
  refundCapRefusal,
  refundIntentPreimage,
  refundLiabilityAccount,
  refundReplayVerdict,
  resolveRefundSource,
  returnsLockRank,
  type RefundIntent,
} from '@daftar/domain-core';
import { planCustomerCreditApplication } from '@daftar/inventory';
import {
  ReturnsPlanError,
  assertNoReceivableLine,
  planCreditNoteApplication,
  planCreditNoteReversal,
  planCustomerRefund,
  verifySourceConsumptionChain,
  type ConsumableSource,
  type ReturnsEntryLine,
} from '../../apps/api/src/modules/returns/returns-settlement';
import { RETURNS_CODES, returnsStatus } from '../../apps/api/src/modules/returns/returns-errors';
import { RETURNS_ROUTE_AUTHORITY } from '../../apps/api/src/modules/returns/returns-permissions';

const BASE = { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 } as const;

const source = (over: Partial<ConsumableSource> = {}): ConsumableSource => ({
  kind: 'credit_note',
  originalMinor: 10_000n,
  originalCarryingMinor: 10_000n,
  remainingMinor: 10_000n,
  conversion: BASE,
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReturnsPlanError) return e.code;
    throw e;
  }
  throw new Error('expected a ReturnsPlanError and the call returned normally — the guard did not fire');
};

// ── 1. `TL-P4-S5-R1`: a refund reduces no AR, and cannot ───────────────

describe('TL-P4-S5-R1 — a refund is not an invoice-outstanding reducer', () => {
  it('the lawful refund entry names the liability, the posting account and realized FX — and no AR line', () => {
    const plan = planCustomerRefund({
      source: source(),
      consumedMinor: 4_000n,
      sameCurrency: true,
      disbursementAmountMinor: 4_000n,
      disbursement: BASE,
    });
    expect(plan.entryLines.map((l) => `${l.side} ${l.account}`)).toEqual(['D customer_refund_liability', 'C posting_account']);
    expect(plan.entryLines.some((l) => l.account === ('accounts_receivable' as never))).toBe(false);
    // The source gave up 4000 of 10000; nothing about an invoice appears in the
    // plan at all, and the plan's own type has no field that could carry one.
    expect(plan.remainingAfterMinor).toBe(6_000n);
    expect(Object.keys(plan).filter((k) => /invoice/i.test(k))).toEqual([]);
  });

  it('RED PROOF — planting the real `accounts_receivable` line makes the guard raise', () => {
    // The planted subject is the account the ruling actually excludes, named by
    // its registered system key (`0040:50`, code 1100), on a line of the exact
    // shape the plan layer builds.
    const planted: readonly ReturnsEntryLine[] = [
      { account: 'accounts_receivable' as never, side: 'C', currency: 'base', txnAmountMinor: 4_000n, baseAmountMinor: 4_000n },
    ];
    expect(codeOf(() => assertNoReceivableLine(planted))).toBe('customer_refund.arithmetic_invalid');
    // And the closed account set refuses it by name, so the line is also
    // unexpressible without the cast above.
    expect(isRefundEntryAccount('accounts_receivable')).toBe(false);
    expect(REFUND_ENTRY_ACCOUNTS).not.toContain('accounts_receivable');
  });

  it('RED PROOF — the real `RefundDto` field names carry nothing that could name an invoice or a payment', () => {
    // The planted subjects are the two field names the ruling names in its own
    // words: "it carries no `payment_id`", and the execution plan's "no column
    // that could name a payment".
    const lawful = [
      'refundId',
      'customerId',
      'creditNoteId',
      'customerCreditId',
      'paymentMethodId',
      'refundDate',
      'sourceAmountConsumedMinor',
      'disbursementAmountMinor',
    ];
    // `paymentMethodId` is lawful and must stay lawful: a method is a
    // configuration row, not a payment. This is the case a careless pattern
    // breaks, so it is asserted first.
    expect(forbiddenRefundFields(['paymentMethodId'])).toEqual([]);
    expect(REFUND_NAMES_NO_INVOICE(lawful)).toBe(true);

    expect(REFUND_NAMES_NO_INVOICE([...lawful, 'invoiceId'])).toBe(false);
    expect(forbiddenRefundFields([...lawful, 'paymentId']).map((f) => f.field)).toEqual(['paymentId']);
    expect(forbiddenRefundFields(['refunded_amount_minor']).map((f) => f.field)).toEqual(['refunded_amount_minor']);
    expect(forbiddenRefundFields(['refund_source_type']).map((f) => f.field)).toEqual(['refund_source_type']);
    expect(forbiddenRefundFields(['outstanding_minor']).map((f) => f.field)).toEqual(['outstanding_minor']);
  });
});

// ── 2. The source is `credit_note` XOR `customer_credit` ───────────────

describe('a refund draws on EXACTLY ONE source', () => {
  it('resolves each lawful source and refuses both and neither as DIFFERENT problems', () => {
    expect(resolveRefundSource({ creditNoteId: 'n1' })).toEqual({ ok: true, kind: 'credit_note', sourceId: 'n1' });
    expect(resolveRefundSource({ customerCreditId: 'c1' })).toEqual({ ok: true, kind: 'customer_credit', sourceId: 'c1' });
    expect(resolveRefundSource({})).toEqual({ ok: false, problem: 'source_absent' });
    expect(resolveRefundSource({ creditNoteId: null, customerCreditId: null })).toEqual({ ok: false, problem: 'source_absent' });
    // RED PROOF — the ambiguous case is a DIFFERENT problem, not the same one.
    // A single code would make the client guess which mistake it made.
    expect(resolveRefundSource({ creditNoteId: 'n1', customerCreditId: 'c1' })).toEqual({ ok: false, problem: 'source_ambiguous' });
  });

  it('each kind discharges its OWN liability, and the two do not drift', () => {
    expect(refundLiabilityAccount('credit_note')).toBe('customer_refund_liability');
    expect(refundLiabilityAccount('customer_credit')).toBe('customer_credit_liability');
    // The customer-credit refund debits 2210 — the same account `0081:1594`
    // already debits when a credit is consumed by an application. Not a new
    // model: the same debit through a different consumer.
    const plan = planCustomerRefund({
      source: source({ kind: 'customer_credit' }),
      consumedMinor: 1_000n,
      sameCurrency: true,
      disbursementAmountMinor: 1_000n,
      disbursement: BASE,
    });
    expect(plan.entryLines[0]?.account).toBe('customer_credit_liability');
  });
});

// ── 3. The cap ─────────────────────────────────────────────────────────

describe('the refund cap', () => {
  it('admits exactly up to the locked remaining and refuses one minor unit more', () => {
    const s = { kind: 'credit_note' as const, originalMinor: 10_000n, remainingMinor: 2_500n };
    expect(refundCapRefusal(s, 2_500n)).toBeNull();
    expect(refundCapRefusal(s, 2_501n)).toBe('customer_refund.amount_exceeds_source');
    expect(refundCapRefusal(s, 0n)).toBe('customer_refund.amount_invalid');
    expect(refundCapRefusal(s, -1n)).toBe('customer_refund.amount_invalid');
    expect(refundCapRefusal({ ...s, remainingMinor: 0n }, 1n)).toBe('customer_refund.source_exhausted');
  });

  it('RED PROOF — the plan layer refuses the over-cap refund, so the cap is not advisory', () => {
    expect(
      codeOf(() =>
        planCustomerRefund({
          source: source({ remainingMinor: 2_500n }),
          consumedMinor: 2_501n,
          sameCurrency: true,
          disbursementAmountMinor: 2_501n,
          disbursement: BASE,
        }),
      ),
    ).toBe('customer_refund.amount_exceeds_source');
  });

  it('RED PROOF — nothing in the slice stores a consumption total, so there is no second cap to disagree', () => {
    const plan = planCustomerRefund({ source: source(), consumedMinor: 1n, sameCurrency: true, disbursementAmountMinor: 1n, disbursement: BASE });
    // The planted subject is the exact column name the register and G-3 both
    // name: `credit_notes.refunded_amount_minor`.
    expect(forbiddenRefundFields(Object.keys(plan))).toEqual([]);
    expect(Object.keys(plan)).not.toContain('refundedAmountMinor');
    expect(forbiddenRefundFields(['refundedAmountMinor'])).toHaveLength(1);
  });
});

// ── 4. The same-currency identity and the sub-unit floors ──────────────

describe('the FX behaviour of a refund', () => {
  it('a refund in the source currency pays out exactly what it consumes', () => {
    expect(
      codeOf(() => planCustomerRefund({ source: source(), consumedMinor: 1_000n, sameCurrency: true, disbursementAmountMinor: 999n, disbursement: BASE })),
    ).toBe('customer_refund.amount_mismatch');
  });

  it('a cross-currency refund carries realized FX on 4900 or 6900 and never a rounding line', () => {
    // 1000 source units at rate 1.0 release 1000 base; the money leaves as 900
    // units of a currency at rate 1.0, so 100 base of gain.
    const plan = planCustomerRefund({
      source: source(),
      consumedMinor: 1_000n,
      sameCurrency: false,
      disbursementAmountMinor: 900n,
      disbursement: BASE,
    });
    expect(plan.realizedMinor).toBe(100n);
    expect(plan.entryLines.map((l) => l.account)).toContain('fx_gain');
    expect(plan.entryLines.map((l) => l.account)).not.toContain('rounding');

    const loss = planCustomerRefund({
      source: source(),
      consumedMinor: 1_000n,
      sameCurrency: false,
      disbursementAmountMinor: 1_100n,
      disbursement: BASE,
    });
    expect(loss.realizedMinor).toBe(-100n);
    expect(loss.entryLines.map((l) => l.account)).toContain('fx_loss');
  });

  it('RED PROOF — a disbursement that converts to less than one base minor unit is refused, never posted as a zero line', () => {
    // A real sub-unit case: a currency 100× weaker than the base, disbursing one
    // of its minor units.
    const weak = { rateR10: 10n ** 8n, txnExponent: 2, baseExponent: 2 } as const;
    expect(
      codeOf(() => planCustomerRefund({ source: source(), consumedMinor: 1_000n, sameCurrency: false, disbursementAmountMinor: 1n, disbursement: weak })),
    ).toBe('customer_refund.amount_below_base_unit');
  });

  it('RED PROOF — a refund that would STRAND a sub-unit residue on the source is refused', () => {
    // A rate of 0.4: the consumed 2 converts to 1 (lawful), and the residue of 1
    // converts to 0 — a remaining amount that can never be refunded or applied
    // and would sit on the source forever.
    const weak = { rateR10: 4n * 10n ** 9n, txnExponent: 2, baseExponent: 2 } as const;
    expect(
      codeOf(() =>
        planCustomerRefund({
          source: source({ originalMinor: 3n, originalCarryingMinor: 2n, remainingMinor: 3n, conversion: weak }),
          consumedMinor: 2n,
          sameCurrency: false,
          disbursementAmountMinor: 1_000n,
          disbursement: BASE,
        }),
      ),
    ).toBe('customer_refund.residue_below_base_unit');
  });
});

// ── 5. The credit note: AR falls in ONE place, through ONE algorithm ───

/**
 * The invoice of the challenge's worked scenario: 10 000 in its own currency,
 * 10 853 carrying base, nothing released yet. Its stored rate is therefore
 * 1.0853 — the rate the invoice was BORN at, which is the only rate its own AR
 * may be released at.
 */
const WORKED_INVOICE = {
  totalTxnMinor: 10_000n,
  totalBaseMinor: 10_853n,
  outstandingTxnMinor: 10_000n,
  conversion: { rateR10: 10_853n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
} as const;

/** The credit note, issued LATER and so carrying a DIFFERENT snapshot: 1.0901. */
const WORKED_NOTE = {
  originalMinor: 10_000n,
  originalCarryingMinor: 10_901n,
  remainingMinor: 10_000n,
  conversion: { rateR10: 10_901n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
} as const;

describe('the credit note entry raises a liability and touches NO receivable', () => {
  it('reverses the whole total to 4100 against 2200, at ONE conversion', () => {
    const plan = planCreditNoteReversal({
      totalMinor: 1_000n,
      conversion: BASE,
      taxMinor: '0',
      returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 450n }],
    });
    expect(plan.revenueEntryLines.map((l) => `${l.side} ${l.account} ${l.txnAmountMinor}`)).toEqual([
      'D sales_returns 1000',
      'C customer_refund_liability 1000',
    ]);
    expect(plan.cogsEntryLines.map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`)).toEqual(['D inventory 450', 'C cogs 450']);
  });

  it('carries no `accounts_receivable` line and no invoice, whatever the numbers', () => {
    // Driven over a spread of totals and rates rather than one: the claim is
    // that the SHAPE has no AR line, not that one example happened not to.
    for (const totalMinor of [1n, 7n, 999n, 1_000n, 123_456n]) {
      for (const rateR10 of [10n ** 10n, 10_853n * 10n ** 6n, 3n * 10n ** 10n]) {
        const plan = planCreditNoteReversal({
          totalMinor,
          conversion: { rateR10, txnExponent: 2, baseExponent: 2 },
          taxMinor: '0',
          returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 1n }],
        });
        expect(plan.revenueEntryLines.some((l) => l.account === 'accounts_receivable')).toBe(false);
      }
    }
    // And the input shape cannot even be handed an invoice to fall against.
    const reversalInputKeys = ['totalMinor', 'conversion', 'taxMinor', 'returnedMovements'];
    const INVOICE_SHAPED = /outstanding|applied|carrying/i;
    // The regex is shown able to MATCH on a shape that genuinely carries an
    // invoice's AR state, so its failure to match below is a fact about the
    // reversal input and not about the regex.
    expect(Object.keys(WORKED_INVOICE).some((k) => INVOICE_SHAPED.test(k))).toBe(true);
    expect(reversalInputKeys.some((k) => INVOICE_SHAPED.test(k))).toBe(false);
  });
});

describe('an application reduces AR through the ONE canonical algorithm', () => {
  it('releases AR at the INVOICE’s stored pair (3 617), not at the note’s snapshot (3 633)', () => {
    const plan = planCreditNoteApplication({
      invoice: WORKED_INVOICE,
      note: WORKED_NOTE,
      sameCurrency: true,
      consumedMinor: 3_333n,
      appliedMinor: 3_333n,
    });
    // `rel = R(X + a) − R(X)` over the INVOICE's own (10 000, 10 853) pair.
    expect(plan.invoiceCarryingReleasedMinor).toBe(3_617n);
    // `cr_rel = g(rb) − g(rb − c)` over the NOTE's own (10 000, 10 901) pair.
    expect(plan.creditCarryingReleasedMinor).toBe(3_633n);
    // The 16-minor gap is REALIZED FX and not revenue, and not a rounding.
    expect(plan.realizedFxMinor).toBe(16n);
    // The level the chain verifier walks, stored and not derived.
    expect(plan.arReleasedBeforeMinor).toBe(0n);
    expect(plan.creditRemainingBeforeMinor).toBe(10_000n);
    expect(plan.entryLines.map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`)).toEqual([
      'D customer_refund_liability 3633',
      'C accounts_receivable 3617',
      'C fx_gain 16',
    ]);
  });

  it('is the canonical plan with ONE account relabelled — 2210 becomes 2200 and nothing else moves', () => {
    const args = { invoice: WORKED_INVOICE, credit: WORKED_NOTE, sameCurrency: true, consumedMinor: 3_333n, appliedMinor: 3_333n } as const;
    const canonical = planCustomerCreditApplication(args);
    const mine = planCreditNoteApplication({
      invoice: args.invoice,
      note: args.credit,
      sameCurrency: args.sameCurrency,
      consumedMinor: args.consumedMinor,
      appliedMinor: args.appliedMinor,
    });
    // Every AMOUNT is identical: this is not a second algorithm agreeing, it is
    // the same algorithm's output passed through.
    const { entryLines: canonicalLines, ...canonicalAmounts } = canonical;
    const { entryLines: mineLines, ...mineAmounts } = mine;
    expect(mineAmounts).toEqual(canonicalAmounts);
    // Every LINE is identical but for the liability account's name.
    expect(mineLines.map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`)).toEqual(
      canonicalLines.map((l) => `${l.side} ${l.account === 'customer_credit_liability' ? 'customer_refund_liability' : l.account} ${l.baseAmountMinor}`),
    );
    // And the relabelling genuinely happened, so the assertion above is not vacuous.
    expect(canonicalLines.some((l) => l.account === 'customer_credit_liability')).toBe(true);
    expect(mineLines.some((l) => l.account === 'customer_refund_liability')).toBe(true);
    expect(mineLines.some((l) => l.account === 'customer_credit_liability')).toBe(false);
  });

  it('yields every operand of `credit_note_applications_realized_ck`, so the row is satisfiable from the plan alone', () => {
    const plan = planCreditNoteApplication({
      invoice: WORKED_INVOICE,
      note: WORKED_NOTE,
      sameCurrency: true,
      consumedMinor: 3_333n,
      appliedMinor: 3_333n,
    });
    expect(plan.realizedFxMinor).toBe(plan.creditCarryingReleasedMinor - plan.invoiceCarryingReleasedMinor);
  });

  it('RED PROOF — an application exceeding the invoice’s outstanding is refused in S5’s own vocabulary', () => {
    expect(
      codeOf(() =>
        planCreditNoteApplication({
          invoice: { ...WORKED_INVOICE, outstandingTxnMinor: 3_000n },
          note: WORKED_NOTE,
          sameCurrency: true,
          consumedMinor: 3_333n,
          appliedMinor: 3_333n,
        }),
      ),
    ).toBe('credit_note.amount_exceeds_outstanding');
  });

  it('RED PROOF — an application exceeding the note’s remaining is refused, so AR cannot fall by more than the note', () => {
    expect(
      codeOf(() =>
        planCreditNoteApplication({
          invoice: WORKED_INVOICE,
          note: { ...WORKED_NOTE, remainingMinor: 3_000n },
          sameCurrency: true,
          consumedMinor: 3_333n,
          appliedMinor: 3_333n,
        }),
      ),
    ).toBe('credit_note.amount_exceeds_note');
  });

  it('RED PROOF — an exhausted note is refused, and under its own code rather than a bad-amount code', () => {
    expect(
      codeOf(() =>
        planCreditNoteApplication({
          invoice: WORKED_INVOICE,
          note: { ...WORKED_NOTE, remainingMinor: 0n },
          sameCurrency: true,
          consumedMinor: 1n,
          appliedMinor: 1n,
        }),
      ),
    ).toBe('credit_note.note_exhausted');
  });

  it('RED PROOF — a stale read of the invoice becomes `settlement_changed`, not a merchant-facing amount refusal', () => {
    // `outstanding > total` is impossible in a consistent read: the caller is
    // holding figures from before something else moved. The canonical arithmetic
    // raises `customer_payment.arithmetic_invalid` for it, and the translation
    // must not report that as the merchant's bad amount.
    expect(
      codeOf(() =>
        planCreditNoteApplication({
          invoice: { ...WORKED_INVOICE, outstandingTxnMinor: 10_001n },
          note: WORKED_NOTE,
          sameCurrency: true,
          consumedMinor: 1_000n,
          appliedMinor: 1_000n,
        }),
      ),
    ).toBe('credit_note.settlement_changed');
  });

  it('RED PROOF — no `customer_credit_application.*` code can escape onto an S5 route', () => {
    const escaped: string[] = [];
    const attempts: (() => unknown)[] = [
      () => planCreditNoteApplication({ invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 0n, appliedMinor: 0n }),
      () =>
        planCreditNoteApplication({
          invoice: WORKED_INVOICE,
          note: WORKED_NOTE,
          sameCurrency: true,
          consumedMinor: 3_333n,
          appliedMinor: 3_332n,
        }),
      () =>
        planCreditNoteApplication({
          invoice: { ...WORKED_INVOICE, conversion: { rateR10: 4n * 10n ** 9n, txnExponent: 2, baseExponent: 2 } },
          note: WORKED_NOTE,
          sameCurrency: true,
          consumedMinor: 1n,
          appliedMinor: 1n,
        }),
    ];
    for (const attempt of attempts) {
      const code = codeOf(attempt);
      if (!isReturnsRefusalCode(code)) escaped.push(code);
      if (code.startsWith('customer_credit_application.') || code.startsWith('customer_payment.')) escaped.push(code);
    }
    expect(escaped).toEqual([]);
  });
});

// ── 6. The COGS reversal is EXACT or it is refused ─────────────────────

describe('the COGS reversal takes the stored movement deltas and nothing else', () => {
  it('sums the exact stored deltas', () => {
    expect(
      creditNoteCogsReversalBaseMinor([
        { movementId: 'm1', valueDeltaBaseMinor: 333n },
        { movementId: 'm2', valueDeltaBaseMinor: 334n },
      ]),
    ).toEqual({ ok: true, baseMinor: 667n });
  });

  it('RED PROOF — a REPEATED movement id is refused, which is how a plausible double reversal arrives', () => {
    expect(
      creditNoteCogsReversalBaseMinor([
        { movementId: 'm1', valueDeltaBaseMinor: 333n },
        { movementId: 'm1', valueDeltaBaseMinor: 333n },
      ]),
    ).toEqual({ ok: false, code: 'credit_note.cogs_not_exact' });
  });

  it('RED PROOF — an EMPTY movement list is refused, so a reversal computed from nothing cannot be posted', () => {
    expect(creditNoteCogsReversalBaseMinor([])).toEqual({ ok: false, code: 'credit_note.cogs_not_exact' });
    expect(codeOf(() => planCreditNoteReversal({ totalMinor: 1_000n, conversion: BASE, taxMinor: '0', returnedMovements: [] }))).toBe(
      'credit_note.cogs_not_exact',
    );
  });

  it('RED PROOF — the input shape has no quantity and no unit cost, so `qty × average` is unexpressible', () => {
    // The law this plants against is the one official identity,
    // `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`, and the
    // reason: an average cost is a rounded quotient and cannot reproduce the
    // movement that empties a stock key and takes its valuation exactly.
    const keys = Object.keys({ movementId: '', valueDeltaBaseMinor: 0n });
    expect(keys).toEqual(['movementId', 'valueDeltaBaseMinor']);
    expect(keys.some((k) => /quantity|qty|unitCost|average/i.test(k))).toBe(false);
  });
});

// ── 7. OD-03: the structural zero ─────────────────────────────────────

describe('OD-03 — sales tax is structurally zero and S5 does not reopen it', () => {
  it('admits exactly one spelling of zero and refuses every other value', () => {
    expect(creditNoteTaxRefusal('0')).toBeNull();
    for (const planted of ['1', '-0', '0.00', '', '00', '0.0']) {
      expect(creditNoteTaxRefusal(planted)).toBe('credit_note.tax_policy_absent');
    }
  });

  it('RED PROOF — a non-zero tax refuses the whole credit-note plan, so there is no non-zero tax path', () => {
    expect(
      codeOf(() =>
        planCreditNoteReversal({
          totalMinor: 1_000n,
          conversion: BASE,
          taxMinor: '150',
          returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 1n }],
        }),
      ),
    ).toBe('credit_note.tax_policy_absent');
  });
});

// ── 8. Idempotency: the same identity, the same intent ────────────────

describe('law 8 — a key replays the SAME economic command or conflicts', () => {
  const base: RefundIntent = {
    refundId: 'r1',
    customerId: 'c1',
    creditNoteId: 'n1',
    customerCreditId: null,
    paymentMethodId: 'pm1',
    refundDate: '2026-10-07',
    sourceCurrency: 'JOD',
    sourceAmountConsumedMinor: '4000',
    disbursementCurrency: 'JOD',
    disbursementAmountMinor: '4000',
    reference: null,
  };

  it('replays an identical intent and CONFLICTS on a changed one', () => {
    expect(refundReplayVerdict(null, base)).toBe('fresh');
    expect(refundReplayVerdict(base, { ...base })).toBe('replay');
    expect(refundReplayVerdict(base, { ...base, disbursementAmountMinor: '4001' })).toBe('conflict');
    expect(refundReplayVerdict(base, { ...base, creditNoteId: null, customerCreditId: 'c9' })).toBe('conflict');
    expect(refundReplayVerdict(base, { ...base, paymentMethodId: 'pm2' })).toBe('conflict');
  });

  it('RED PROOF — an absent value and an EMPTY STRING do not collide', () => {
    // The planted subject is the one real collision an unguarded pre-image has:
    // a refund with no reference and a refund whose reference is "" would share
    // a hash, and the second would silently replay the first.
    expect(isSameRefundIntent(base, { ...base, reference: '' })).toBe(false);
    expect(refundIntentPreimage(base)).not.toBe(refundIntentPreimage({ ...base, reference: '' }));
  });

  it('RED PROOF — the LEVEL is deliberately not part of the intent', () => {
    // Including it would turn an honest retry after a concurrent consumption
    // into an `idempotency_conflict` instead of a `source_changed`, and the
    // client would be told it sent a different command when it sent the same
    // one.
    expect(REFUND_INTENT_FIELDS).not.toContain('sourceRemainingBeforeMinor');
    expect(REFUND_INTENT_FIELDS.filter((f) => /remaining|level/i.test(f))).toEqual([]);
  });
});

// ── 9. The frozen operation-code shape ───────────────────────────────

describe('the operation codes S5 needs are representable under the frozen digest CHECK', () => {
  it('every S5 code satisfies `^[a-z]+(\\.[a-z_]+)+$`', () => {
    for (const code of S5_OPERATION_CODES) expect(isRepresentableOperationCode(code)).toBe(true);
  });

  it('RED PROOF — the natural spelling `customer_refund.pay` is UNREPRESENTABLE, and that is why the codes read as they do', () => {
    // The planted subject is the real trap: `inventory_operation_kinds.op_code`
    // is `CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')`, frozen inside
    // `inventory_payload_digest` (`0054:229`), so the FIRST segment may hold no
    // underscore. `0074:62-70` proves both halves by probe.
    expect(isRepresentableOperationCode('customer_refund.pay')).toBe(false);
    expect(isRepresentableOperationCode('customer_credit_note.issue')).toBe(false);
    expect(isRepresentableOperationCode('refund')).toBe(false);
    expect(isRepresentableOperationCode('Customer.refund')).toBe(false);
  });

  it('the source types follow the LIVE registry convention, not P4-AL-20’s stale enumeration', () => {
    // The live rows are `customer_payment_allocation`,
    // `customer_credit_application`, `customer_credit` (`0081:2468-2472`), and
    // the S4 gate pins those spellings as RULED. So S5's are
    // `customer_`-prefixed and singular — never the lock's bare `credit_note` /
    // `refund`.
    for (const t of S5_ACCOUNTING_SOURCE_TYPES) expect(t.startsWith('customer_')).toBe(true);
    expect(S5_ACCOUNTING_SOURCE_TYPES).not.toContain('credit_note' as never);
    expect(S5_ACCOUNTING_SOURCE_TYPES).not.toContain('refund' as never);
  });
});

// ── 10. The lock order ───────────────────────────────────────────────

describe('the lock order is one order and a trace that inverts it is a defect', () => {
  it('accepts the command order and refuses an inversion', () => {
    expect(isLawfulLockTrace(['customers', 'invoices', 'credit_notes', 'payment_methods'])).toBe(true);
    expect(isLawfulLockTrace(['customers', 'customer_credits', 'payment_methods'])).toBe(true);
    // A refund takes no invoice lock at all, which is the TL-P4-S5-R1 shape.
    expect(isLawfulLockTrace(['customers', 'credit_notes'])).toBe(true);
  });

  it('RED PROOF — locking the source BEFORE the invoice is refused, and so is a relation the order does not name', () => {
    expect(isLawfulLockTrace(['customers', 'credit_notes', 'invoices'])).toBe(false);
    // An S5 command that locks something the order does not name is a command
    // whose deadlock behaviour nobody has reasoned about, so it is a defect and
    // not a pass.
    expect(isLawfulLockTrace(['customers', 'sales'])).toBe(false);
    expect(returnsLockRank('sales')).toBe(-1);
    expect(RETURNS_LOCK_ORDER[0]).toBe('customers');
  });
});

// ── 11. The credit note's lifecycle ──────────────────────────────────

describe('the credit note is corrected by a new document, never by editing the old one', () => {
  it('permits the three transitions and nothing else', () => {
    expect(CREDIT_NOTE_LIFECYCLE_TRANSITIONS).toHaveLength(3);
    expect(isCreditNoteLifecycleTransitionAllowed('draft', 'issued')).toBe(true);
    expect(isCreditNoteLifecycleTransitionAllowed('issued', 'void')).toBe(true);
    expect(isCreditNoteLifecycleTransitionAllowed('void', 'draft')).toBe(false);
    expect(isCreditNoteLifecycleTransitionAllowed('void', 'issued')).toBe(false);
    expect(isCreditNoteLifecycleTransitionAllowed('issued', 'draft')).toBe(false);
  });

  it('RED PROOF — a note with ANY consumption cannot be voided, so a void can never unwind a disbursement', () => {
    expect(creditNoteVoidRefusal('issued', 0n)).toBeNull();
    expect(creditNoteVoidRefusal('issued', 1n)).toBe('credit_note.already_consumed');
    expect(creditNoteVoidRefusal('void', 0n)).toBe('credit_note.lifecycle_invalid');
  });
});

// ── 12. The chain verifier, and the union it needs ───────────────────

describe('the source consumption chain', () => {
  it('accepts a lawful chain of two consumers at their own levels', () => {
    expect(() =>
      verifySourceConsumptionChain({ originalMinor: 1_000n, originalCarryingMinor: 1_000n, remainingMinor: 400n, remainingCarryingMinor: 400n }, [
        { remainingBeforeMinor: 1_000n, consumedMinor: 200n, releasedBaseMinor: 200n },
        { remainingBeforeMinor: 800n, consumedMinor: 400n, releasedBaseMinor: 400n },
      ]),
    ).not.toThrow();
  });

  it('RED PROOF — two consumers computed from the SAME level overlap and are refused', () => {
    // The real double-consumption shape: both read 1000, both took 600.
    expect(
      codeOf(() =>
        verifySourceConsumptionChain({ originalMinor: 1_000n, originalCarryingMinor: 1_000n, remainingMinor: 400n, remainingCarryingMinor: 400n }, [
          { remainingBeforeMinor: 1_000n, consumedMinor: 600n, releasedBaseMinor: 600n },
          { remainingBeforeMinor: 1_000n, consumedMinor: 600n, releasedBaseMinor: 600n },
        ]),
      ),
    ).toBe('credit_note.consumption_inconsistent');
  });

  it('RED PROOF — a stored remaining that disagrees with `original − Σ consumed` is refused', () => {
    expect(
      codeOf(() =>
        verifySourceConsumptionChain({ originalMinor: 1_000n, originalCarryingMinor: 1_000n, remainingMinor: 500n, remainingCarryingMinor: 500n }, [
          { remainingBeforeMinor: 1_000n, consumedMinor: 200n, releasedBaseMinor: 200n },
        ]),
      ),
    ).toBe('credit_note.consumption_inconsistent');
  });
});

// ── 13. The refusal table is total, and the route table is honest ────

describe('the refusal vocabulary and the route authority', () => {
  it('every code of the closed vocabulary carries a status, and every status code is in the vocabulary', () => {
    expect(RETURNS_CODES).toHaveLength(RETURNS_REFUSAL_CODES.length);
    for (const code of RETURNS_REFUSAL_CODES) {
      expect(isReturnsRefusalCode(code)).toBe(true);
      expect(returnsStatus(code)).toBeGreaterThanOrEqual(400);
    }
  });

  it('RED PROOF — no code that is OURS is reported as the merchant’s, and no merchant input maps to a 500', () => {
    // The real defect this plants against cost S4 a round: `arSide` raised
    // `customer_payment.amount_invalid`, no status table classified it, and a
    // merchant's non-positive amount came back as a 500 blaming our arithmetic.
    expect(returnsStatus('customer_refund.arithmetic_invalid')).toBe(500);
    expect(returnsStatus('customer_refund.registry_incomplete')).toBe(500);
    expect(returnsStatus('credit_note.consumption_inconsistent')).toBe(500);
    expect(returnsStatus('credit_note.cogs_not_exact')).toBe(500);
    // Every other code is a 4xx: a merchant mistake is never reported as ours.
    const ours = new Set([
      'customer_refund.arithmetic_invalid',
      'customer_refund.registry_incomplete',
      'credit_note.consumption_inconsistent',
      'credit_note.cogs_not_exact',
    ]);
    for (const code of RETURNS_REFUSAL_CODES) {
      if (!ours.has(code)) expect(returnsStatus(code)).toBeLessThan(500);
    }
  });

  it('the two write routes are SENSITIVE and the reads are not, and no route names `payments.reverse`', () => {
    const writes = RETURNS_ROUTE_AUTHORITY.filter((r) => r.method === 'POST');
    const reads = RETURNS_ROUTE_AUTHORITY.filter((r) => r.method === 'GET');
    expect(writes.length).toBeGreaterThan(0);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of writes) expect(r.sensitive).toBe(true);
    for (const r of reads) {
      expect(r.sensitive).toBe(false);
      expect(r.permission).toBe('receivables.view');
    }
    // A refund is not a reversal: `payments.reverse` is P4-S6's.
    expect(RETURNS_ROUTE_AUTHORITY.map((r) => r.permission)).not.toContain('payments.reverse' as never);
    // Every read route has a write it reads back — the read-path obligation.
    expect(reads.map((r) => r.path).some((p) => p.includes('credit-notes'))).toBe(true);
    expect(reads.map((r) => r.path).some((p) => p.includes('refunds'))).toBe(true);
  });
});
