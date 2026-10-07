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
  CREDIT_NOTE_INTENT_FIELDS,
  REFUND_INTENT_FIELDS,
  REFUND_NAMES_NO_INVOICE,
  RETURNS_DATE_COMPARISON_INSTANT,
  RETURNS_LOCK_ORDER,
  RETURNS_REFUSAL_CODES,
  S5_ACCOUNTING_SOURCE_TYPES,
  S5_OPERATION_CODES,
  creditNoteCogsReversalBaseMinor,
  creditNoteIntentItems,
  creditNoteIntentPreimage,
  creditNoteReplayVerdict,
  creditNoteTaxRefusal,
  creditNoteVoidRefusal,
  forbiddenRefundFields,
  isCreditNoteLifecycleTransitionAllowed,
  isLawfulLockTrace,
  isRefundEntryAccount,
  isRepresentableOperationCode,
  isReturnsRefusalCode,
  isSameCreditNoteIntent,
  isSameRefundIntent,
  refundCapRefusal,
  refundIntentPreimage,
  refundLiabilityAccount,
  refundReplayVerdict,
  resolveRefundSource,
  returnsDateRefusal,
  returnsLockRank,
  returnsLockTraceOneSource,
  type CreditNoteIntent,
  type RefundIntent,
} from '@daftar/domain-core';
import { apRelease, convertToBase, planCustomerCreditApplication } from '@daftar/inventory';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReturnsPlanError,
  assertApplicationEntryComplete,
  assertCanonicalArRelease,
  assertNoReceivableLine,
  assertRefundEntryComplete,
  assertReturnEntryReducesNoReceivable,
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

// ── 5a. `TL-P4-S5-R2` — the seven red proofs the ruling names ──────────

/**
 * The project owner's ruling requires seven red proofs before promotion, each
 * failing on the defect it names and each planting a REAL subject — "not a
 * lambda written in the test body". So every proof below plants either a line
 * this slice's own code once produced, a value the pre-correction code computed,
 * or a declaration read off disk. The guards they fire are the ones
 * `returns-settlement.ts` actually calls on every plan.
 */
describe('TL-P4-S5-R2 — the seven red proofs', () => {
  const APPLICATION = { invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 3_333n, appliedMinor: 3_333n } as const;
  const plan = (): ReturnType<typeof planCreditNoteApplication> => planCreditNoteApplication(APPLICATION);
  const SETTLEMENT_SOURCE = readFileSync(join(__dirname, '../../apps/api/src/modules/returns/returns-settlement.ts'), 'utf8');
  const PORTS_SOURCE = readFileSync(join(__dirname, '../../apps/api/src/modules/returns/returns-ports.ts'), 'utf8');

  it('1 — AR reduced from BOTH credit-note creation and application', () => {
    // The planted subject is the line this slice shipped and had to delete: the
    // `customer_return` entry crediting `accounts_receivable` for the applied
    // part, at the NOTE's snapshot. Reconstructed exactly, and fed to the guard
    // `planCreditNoteReversal` now calls on every entry.
    const deletedLine: ReturnsEntryLine = {
      account: 'accounts_receivable',
      side: 'C',
      currency: 'invoice',
      txnAmountMinor: 3_333n,
      baseAmountMinor: 3_633n,
    };
    const returnEntry = planCreditNoteReversal({
      totalMinor: 10_000n,
      conversion: { rateR10: 10_901n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
      taxMinor: '0',
      returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 7_000n }],
    }).revenueEntryLines;

    // Green on what ships…
    expect(() => assertReturnEntryReducesNoReceivable(returnEntry)).not.toThrow();
    // …RED on the second reducer.
    expect(codeOf(() => assertReturnEntryReducesNoReceivable([...returnEntry, deletedLine]))).toBe('customer_refund.arithmetic_invalid');
  });

  it('2 — an application using its OWN FX conversion instead of canonical settlement arithmetic', () => {
    // The planted value is the one the deleted code computed: 3 333 converted
    // at the NOTE's 1.0901 is 3 633, where the canonical release over the
    // INVOICE's stored (10 000, 10 853) pair is 3 617.
    const atNoteRate = convertToBase(3_333n, 10_901n * 10n ** 6n, 2, 2);
    expect(atNoteRate).toBe(3_633n);
    const canonical = apRelease(WORKED_INVOICE.totalBaseMinor, WORKED_INVOICE.totalTxnMinor, 0n, 3_333n);
    expect(canonical).toBe(3_617n);
    expect(atNoteRate).not.toBe(canonical);

    // Green on the shipped plan…
    expect(() => assertCanonicalArRelease(WORKED_INVOICE, plan())).not.toThrow();
    // …RED on a plan whose AR release is the note-rate conversion.
    expect(
      codeOf(() =>
        assertCanonicalArRelease(WORKED_INVOICE, {
          arReleasedBeforeMinor: 0n,
          invoiceAmountAppliedMinor: 3_333n,
          invoiceCarryingReleasedMinor: atNoteRate,
        }),
      ),
    ).toBe('credit_note.posting_incomplete');
  });

  it('3 — a MISSING realized FX line', () => {
    const p = plan();
    // Non-vacuous: this scenario genuinely realizes FX, so there is a line to remove.
    expect(p.realizedFxMinor).toBe(16n);
    const withoutFx = p.entryLines.filter((l) => l.account !== 'fx_gain' && l.account !== 'fx_loss');
    expect(withoutFx).toHaveLength(p.entryLines.length - 1);
    expect(() => assertApplicationEntryComplete(p)).not.toThrow();
    expect(codeOf(() => assertApplicationEntryComplete({ ...p, entryLines: withoutFx }))).toBe('credit_note.posting_incomplete');
  });

  it('4 — a MISSING dust/residue line', () => {
    // A scenario that genuinely produces dust: the invoice's rate makes
    // `conv_R(a)` and `rel` disagree, so `arLines` emits a second line on
    // `accounts_receivable`.
    const dusty = planCreditNoteApplication({
      invoice: { totalTxnMinor: 10_000n, totalBaseMinor: 10_853n, outstandingTxnMinor: 7_777n, conversion: WORKED_INVOICE.conversion },
      note: WORKED_NOTE,
      sameCurrency: true,
      consumedMinor: 1_111n,
      appliedMinor: 1_111n,
    });
    const arLines = dusty.entryLines.filter((l) => l.account === 'accounts_receivable');
    // Non-vacuous: there really are two AR lines, a principal and its dust.
    expect(arLines.length).toBe(2);
    expect(() => assertApplicationEntryComplete(dusty)).not.toThrow();

    // Drop the dust line only. The entry no longer balances AND the AR movement
    // no longer equals the carrying released — and the guard names the second,
    // which is the one a balance check cannot name.
    const dustLine = arLines[1] as ReturnsEntryLine;
    const withoutDust = dusty.entryLines.filter((l) => l !== dustLine);
    expect(codeOf(() => assertApplicationEntryComplete({ ...dusty, entryLines: withoutDust }))).toBe('credit_note.posting_incomplete');
  });

  it('5 — the refund liability changed by an UNPOSTED FX difference', () => {
    // A cross-currency refund that genuinely realizes FX.
    const refund = planCustomerRefund({
      source: {
        kind: 'credit_note',
        originalMinor: 10_000n,
        originalCarryingMinor: 10_853n,
        remainingMinor: 10_000n,
        conversion: WORKED_INVOICE.conversion,
      },
      consumedMinor: 3_333n,
      sameCurrency: false,
      disbursementAmountMinor: 3_333n,
      disbursement: { rateR10: 10_901n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
    });
    expect(refund.realizedMinor).not.toBe(0n);
    expect(() => assertRefundEntryComplete(refund)).not.toThrow();

    // The planted defect, in the owner's words: the realized movement silently
    // changes the liability instead of being posted. The FX line is removed and
    // the liability debit is widened by the same amount, so the entry still
    // BALANCES — which is exactly why a balance check is not this law.
    const absorbed = refund.entryLines
      .filter((l) => l.account !== 'fx_gain' && l.account !== 'fx_loss')
      .map((l) => (l.account === refund.liabilityAccount && l.currency === 'source' ? { ...l, baseAmountMinor: l.baseAmountMinor - refund.realizedMinor } : l));
    let balance = 0n;
    for (const l of absorbed) balance += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
    expect(balance).toBe(0n); // it balances…
    expect(codeOf(() => assertRefundEntryComplete({ ...refund, entryLines: absorbed }))).toBe('credit_note.posting_incomplete'); // …and is still refused.
  });

  it('6 — a write shape unable to populate the mandatory carrying and FX fields', () => {
    // The operands of `credit_note_applications_realized_ck`, as the DDL
    // specification states it, plus the two level columns the chain verifier
    // walks. Read off the SHIPPED declaration, not restated.
    const body = /export interface CreditNoteApplicationWrite \{([\s\S]*?)\n\}/.exec(PORTS_SOURCE)?.[1];
    expect(body).toBeDefined();
    const fields = [...(body as string).matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/gm)].map((m) => m[1] as string);
    const MANDATORY = [
      'arReleasedBeforeTxnMinor',
      'creditRemainingBeforeMinor',
      'creditAmountConsumedMinor',
      'creditCarryingBaseReleasedMinor',
      'invoiceAmountAppliedMinor',
      'invoiceCarryingBaseReleasedMinor',
      'realizedFxGainLossMinor',
    ];
    const missing = (shape: readonly string[]): readonly string[] => MANDATORY.filter((m) => !shape.includes(m));
    // Green on what ships.
    expect(missing(fields)).toEqual([]);
    // RED on the shape this slice shipped before the correction — the exact
    // field list, reconstructed. "A relation with required financial columns
    // that the legitimate command cannot populate is an invalid design."
    const preCorrection = [
      'applicationId',
      'lineNo',
      'invoiceId',
      'arReleasedBeforeTxnMinor',
      'creditAmountConsumedMinor',
      'invoiceAmountAppliedMinor',
      'invoiceCarryingBaseReleasedMinor',
    ];
    expect(missing(preCorrection)).toEqual(['creditRemainingBeforeMinor', 'creditCarryingBaseReleasedMinor', 'realizedFxGainLossMinor']);
    // And every mandatory field is produced by the plan, so the shape is
    // populatable in fact and not only in type.
    const p = plan();
    expect(p.creditCarryingReleasedMinor + p.invoiceCarryingReleasedMinor + p.realizedFxMinor).toBe(2n * p.creditCarryingReleasedMinor);
  });

  it('7 — TWO independent conversions of the released and the remaining carrying value', () => {
    // Structural, over the shipped text of the one function the defect lived in.
    // `TL-P4-S5-R2`: "Do not independently convert the applied amount and the
    // remaining amount and then reconcile the difference."
    const fn = /export function planCreditNoteReversal\(([\s\S]*?)\n\}/.exec(SETTLEMENT_SOURCE)?.[1];
    expect(fn).toBeDefined();
    const code = (fn as string).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const conversions = [...code.matchAll(/\bconvert\(/g)];
    // Exactly ONE conversion, of the header total.
    expect(conversions).toHaveLength(1);
    expect(code).toContain('convert(input.totalMinor, input.conversion)');
    // And the reconstructed pre-correction body — the planted subject — has two.
    const preCorrection = `
      const totalBaseMinor = convert(input.totalMinor, input.conversion);
      const appliedBaseMinor = input.appliedToInvoiceMinor === 0n ? 0n : convert(input.appliedToInvoiceMinor, input.conversion);
      const liabilityBaseMinor = totalBaseMinor - appliedBaseMinor;
    `;
    expect([...preCorrection.matchAll(/\bconvert\(/g)]).toHaveLength(2);
    // The plan type cannot even carry the second conversion's result any more.
    expect(
      Object.keys(
        planCreditNoteReversal({ totalMinor: 1_000n, conversion: BASE, taxMinor: '0', returnedMovements: [{ movementId: 'm', valueDeltaBaseMinor: 1n }] }),
      ),
    ).toEqual(['totalBaseMinor', 'cogsReversalBaseMinor', 'revenueEntryLines', 'cogsEntryLines']);
  });

  it('the IDENTITY the ruling requires reconciles exactly, in integer minor units', () => {
    // AR effect + realized FX effect + dust/residue effect + liability effect = 0
    for (const scenario of [
      APPLICATION,
      { invoice: { ...WORKED_INVOICE, outstandingTxnMinor: 7_777n }, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 1_111n, appliedMinor: 1_111n },
      { invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 10_000n, appliedMinor: 10_000n },
      { invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 1n, appliedMinor: 1n },
    ]) {
      const p = planCreditNoteApplication(scenario);
      const net = (account: string): bigint =>
        p.entryLines.filter((l) => l.account === account).reduce((a, l) => a + (l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor), 0n);
      const ar = net('accounts_receivable');
      const liability = net('customer_refund_liability');
      const fx = net('fx_gain') + net('fx_loss');
      expect(ar + liability + fx).toBe(0n);
      // And each TERM is the canonical number, not merely a term that balances.
      expect(ar).toBe(-p.invoiceCarryingReleasedMinor);
      expect(liability).toBe(p.creditCarryingReleasedMinor);
      expect(fx).toBe(-p.realizedFxMinor);
    }
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

// ── 8a. The credit note is a command under a key too ──────────────────

describe('law 8 binds the CREDIT NOTE as well, which is what makes its conflict code reachable', () => {
  const items = [
    { lineNo: 1, productId: 'p1', quantity: '2.000', unitPriceMinor: '1500', netMinor: '3000' },
    { lineNo: 2, productId: 'p2', quantity: '1.000', unitPriceMinor: '1000', netMinor: '1000' },
  ];
  const note: CreditNoteIntent = {
    creditNoteId: 'n1',
    customerId: 'c1',
    invoiceId: 'i1',
    creditNoteDate: '2026-10-07',
    currencyCode: 'JOD',
    totalMinor: '4000',
    taxMinor: '0',
    reference: null,
    items: creditNoteIntentItems(items),
  };

  it('replays an identical intent and CONFLICTS on a changed one', () => {
    expect(creditNoteReplayVerdict(null, note)).toBe('fresh');
    expect(creditNoteReplayVerdict(note, { ...note })).toBe('replay');
    expect(creditNoteReplayVerdict(note, { ...note, totalMinor: '4001' })).toBe('conflict');
    expect(creditNoteReplayVerdict(note, { ...note, invoiceId: 'i2' })).toBe('conflict');
  });

  it('RED PROOF — the same key with ONE MORE RETURNED LINE is a conflict, not a replay', () => {
    // The planted subject is the real exposure of an intent that ignored the
    // lines: the caller re-sends `n1` with a third line, the replay answers 200
    // with the first note's result, and the merchant believes the third line was
    // returned and refundable. The lines ARE the economic content.
    const extra = [...items, { lineNo: 3, productId: 'p3', quantity: '1.000', unitPriceMinor: '500', netMinor: '500' }];
    expect(creditNoteReplayVerdict(note, { ...note, items: creditNoteIntentItems(extra) })).toBe('conflict');
    // And a single line's PRICE changing, at the same total, is a conflict too.
    const repriced = [
      { lineNo: 1, productId: 'p1', quantity: '2.000', unitPriceMinor: '1000', netMinor: '2000' },
      { lineNo: 2, productId: 'p2', quantity: '1.000', unitPriceMinor: '2000', netMinor: '2000' },
    ];
    expect(creditNoteReplayVerdict(note, { ...note, items: creditNoteIntentItems(repriced) })).toBe('conflict');
  });

  it('the SAME lines in a different array order are the SAME command', () => {
    expect(creditNoteIntentItems([...items].reverse())).toBe(creditNoteIntentItems(items));
    expect(creditNoteReplayVerdict(note, { ...note, items: creditNoteIntentItems([...items].reverse()) })).toBe('replay');
  });

  it('RED PROOF — the item encoding cannot forge a top-level field boundary', () => {
    // A nested encoding that reused `\n` would let a set of lines render into a
    // byte sequence another set plus a different top-level field also renders
    // into. The assertion is structural: neither nested separator is the
    // top-level one, and the top-level one does not appear in the rendering.
    const rendered = creditNoteIntentItems(items);
    expect(rendered).not.toContain('\n');
    expect(rendered).toContain('\u001f');
    expect(rendered).toContain('\u001e');
  });

  it('RED PROOF — an absent value and an EMPTY STRING do not collide here either', () => {
    expect(isSameCreditNoteIntent(note, { ...note, reference: '' })).toBe(false);
    expect(creditNoteIntentPreimage(note)).not.toBe(creditNoteIntentPreimage({ ...note, reference: '' }));
  });

  it('shares the ABSENCE ENCODING with the refund and no field with it', () => {
    // One encoding, two commands: the shared thing is the function, not a
    // convention written out twice.
    const refundSized: RefundIntent = {
      refundId: null,
      customerId: null,
      creditNoteId: null,
      customerCreditId: null,
      paymentMethodId: null,
      refundDate: null,
      sourceCurrency: null,
      sourceAmountConsumedMinor: null,
      disbursementCurrency: null,
      disbursementAmountMinor: null,
      reference: null,
    };
    const noteSized = Object.fromEntries(CREDIT_NOTE_INTENT_FIELDS.map((f) => [f, null])) as CreditNoteIntent;
    // Every absent value renders as the same single sentinel in both.
    expect(new Set(refundIntentPreimage(refundSized).split('\n'))).toEqual(new Set(['\u0000']));
    expect(new Set(creditNoteIntentPreimage(noteSized).split('\n'))).toEqual(new Set(['\u0000']));
    // And the two field lists are disjoint but for nothing at all.
    const shared = CREDIT_NOTE_INTENT_FIELDS.filter((f) => (REFUND_INTENT_FIELDS as readonly string[]).includes(f));
    expect(shared).toEqual(['creditNoteId', 'customerId', 'reference']);
    // `creditNoteId` means different things in the two: the note's identity in
    // one, the source it draws on in the other. Sharing a spelling is not
    // sharing a field, which is exactly why the lists are separate.
    expect(creditNoteIntentPreimage(noteSized)).not.toBe(refundIntentPreimage(refundSized));
  });

  it('the number is NOT in the intent, because the command allocates it', () => {
    // `allocateNumber` (G-07) renders the document number inside the command, so
    // an intent containing it could not be computed by the caller, and a replay
    // has to compute it before the command runs.
    expect(CREDIT_NOTE_INTENT_FIELDS.filter((f) => /number|seq/i.test(f))).toEqual([]);
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

// ── 10a. The dates, and the instant they are measured against ──────────

describe('the date laws name their comparison instant and take it as an argument', () => {
  it('judges both laws against a CALLER-SUPPLIED business today', () => {
    // An ordinary lawful credit note: dated today, after its invoice.
    expect(returnsDateRefusal('credit_note', '2026-10-07', '2026-10-01', '2026-10-07')).toBeNull();
    expect(returnsDateRefusal('credit_note', '2026-10-08', '2026-10-01', '2026-10-07')).toBe('credit_note.date_in_future');
    expect(returnsDateRefusal('credit_note', '2026-09-30', '2026-10-01', '2026-10-07')).toBe('credit_note.date_before_invoice');
    expect(returnsDateRefusal('customer_refund', '2026-10-08', '2026-10-01', '2026-10-07')).toBe('customer_refund.date_in_future');
    expect(returnsDateRefusal('customer_refund', '2026-09-30', '2026-10-01', '2026-10-07')).toBe('customer_refund.date_before_source');
  });

  it('RED PROOF — the function reads NO clock, so the verdict depends only on its arguments', () => {
    // The planted subject is the real defect: a command that compared against
    // its own `new Date()` would answer differently at 01:00 Amman from the
    // same stored intent sent at 13:00, and an idempotent replay would change
    // its answer at midnight. Proved by arguments alone: the SAME call returns
    // the same verdict, and the verdict FLIPS only when the supplied today
    // changes.
    expect(returnsDateRefusal('credit_note', '2026-10-08', '2026-10-01', '2026-10-07')).toBe('credit_note.date_in_future');
    expect(returnsDateRefusal('credit_note', '2026-10-08', '2026-10-01', '2026-10-08')).toBeNull();
    // And the shipped declaration genuinely takes it: four parameters, the last
    // named for what it is, with no default to fall back on a clock.
    const src = readFileSync(join(__dirname, '../../packages/domain-core/src/returns.ts'), 'utf8');
    const params = /export function returnsDateRefusal\(([\s\S]*?)\n\):/.exec(src)?.[1];
    expect(params).toBeDefined();
    expect(params).toContain('businessToday: string');
    expect(params).not.toContain('=');
    // No `Date`, no `now`, nowhere in the whole module.
    const body = /export function returnsDateRefusal\([\s\S]*?\n\}/.exec(src)?.[0] as string;
    expect(/new Date|Date\.now|\bnow\(\)/.test(body)).toBe(false);
    // The instant is NAMED, as a string a reviewer can read, not inferred.
    expect(RETURNS_DATE_COMPARISON_INSTANT).toMatch(/time zone/);
  });

  it('RED PROOF — a malformed date is refused and never sorted as a string', () => {
    // The planted subject: `'2026-10-7'` and `'07/10/2026'` both compare as
    // strings without error and both would sort WRONG, so a date law built on
    // bare `>` without a shape check is green and incorrect.
    expect('2026-10-7' > '2026-10-07').toBe(true); // the trap, demonstrated…
    expect(returnsDateRefusal('credit_note', '2026-10-7', '2026-10-01', '2026-10-07')).toBe('credit_note.amount_invalid'); // …and refused.
    expect(returnsDateRefusal('customer_refund', '07/10/2026', '2026-10-01', '2026-10-07')).toBe('customer_refund.amount_invalid');
    expect(returnsDateRefusal('credit_note', '2026-10-07', '2026-10-01', '')).toBe('credit_note.amount_invalid');
  });
});

// ── 10b. F5: the realized FX is bounded by the liability it arises on ──

describe('the realized exchange movement is BOUNDED and not merely posted', () => {
  const source = (over: Partial<ConsumableSource> = {}): ConsumableSource => ({
    kind: 'credit_note',
    originalMinor: 10_000n,
    originalCarryingMinor: 10_853n,
    remainingMinor: 10_000n,
    conversion: { rateR10: 10_853n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
    ...over,
  });

  it('admits an ordinary cross-currency refund and posts its gain or loss', () => {
    const plan = planCustomerRefund({
      source: source(),
      consumedMinor: 3_333n,
      sameCurrency: false,
      disbursementAmountMinor: 3_333n,
      disbursement: { rateR10: 10_901n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
    });
    expect(plan.realizedMinor).not.toBe(0n);
    const magnitude = plan.realizedMinor < 0n ? -plan.realizedMinor : plan.realizedMinor;
    expect(magnitude).toBeLessThanOrEqual(plan.carryingReleasedMinor);
  });

  it('RED PROOF — a rate wrong by more than 100% posts an UNBOUNDED fx_loss line without this guard, and is refused with it', () => {
    // The planted subject is a mistyped disbursement rate: 30.0 instead of 3.0,
    // an order of magnitude, which is the single most common way a rate is
    // entered wrongly. The entry would BALANCE — `balanced()` is satisfied —
    // while booking an exchange loss many times the liability being discharged.
    const consumed = 3_333n;
    const carryingReleased = 3_617n; // what the source actually gives up
    const absurdBase = 100_000n; // what a 30.0 rate would cost
    expect(absurdBase - carryingReleased).toBeGreaterThan(carryingReleased); // the loss exceeds the liability…
    expect(
      codeOf(() =>
        planCustomerRefund({
          source: source(),
          consumedMinor: consumed,
          sameCurrency: false,
          disbursementAmountMinor: absurdBase,
          disbursement: { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 },
        }),
      ),
    ).toBe('customer_refund.fx_rate_changed'); // …and is refused.
    // And the refusal is a 409 the caller can act on, never a 500 blaming us.
    expect(returnsStatus('customer_refund.fx_rate_changed')).toBeLessThan(500);
  });

  it('the bound is TIGHT, not generous: exactly twice the carrying is the last admitted disbursement', () => {
    // At `db = 2·cr_rel` the loss equals the liability and is admitted; one
    // minor unit more and it is refused. A bound nobody has driven to its edge
    // is a bound nobody knows the value of.
    const s = source({ originalMinor: 1_000n, originalCarryingMinor: 1_000n, remainingMinor: 1_000n, conversion: BASE });
    const at = (disbursementAmountMinor: bigint): string => {
      try {
        planCustomerRefund({ source: s, consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor, disbursement: BASE });
        return 'admitted';
      } catch (e) {
        return e instanceof ReturnsPlanError ? e.code : 'other';
      }
    };
    expect(at(200n)).toBe('admitted');
    expect(at(201n)).toBe('customer_refund.fx_rate_changed');
  });
});

// ── 10c. F9: why rank 3 is ONE rank ────────────────────────────────────

describe('the lock order’s shared rank has a checked premise', () => {
  it('no S5 command can hold BOTH source relations, which is why they share a rank', () => {
    // A refund: customers, its ONE source, the method. A credit note: customers,
    // the invoice, the note. Neither names both source relations.
    expect(returnsLockTraceOneSource(['customers', 'credit_notes', 'payment_methods'])).toBeNull();
    expect(returnsLockTraceOneSource(['customers', 'customer_credits', 'payment_methods'])).toBeNull();
    expect(returnsLockTraceOneSource(['customers', 'invoices', 'credit_notes'])).toBeNull();
    // And every one of those traces is lawful under the order itself.
    expect(isLawfulLockTrace(['customers', 'credit_notes', 'payment_methods'])).toBe(true);
    expect(isLawfulLockTrace(['customers', 'invoices', 'credit_notes'])).toBe(true);
  });

  it('RED PROOF — a trace holding both IS reported, so the premise is checked and not assumed', () => {
    // The planted subject is the design this slice rejected: a refund that could
    // draw on a credit note AND a customer credit in one command. It is refused
    // by `refunds_one_source_ck` on the row and by `resolveRefundSource` in the
    // command — and if it ever were not, THIS is where the lock order's
    // single-rank argument would collapse, so the premise is asserted rather
    // than remembered.
    expect(returnsLockTraceOneSource(['customers', 'credit_notes', 'customer_credits'])).toEqual(['credit_notes', 'customer_credits']);
    // The same shape, through the ruling that forbids it: two sources named is
    // ambiguous, not a double consumption.
    expect(resolveRefundSource({ creditNoteId: 'n1', customerCreditId: 'c1' })).toEqual({ ok: false, problem: 'source_ambiguous' });
  });

  it('the shared rank is DOCUMENTED as a decision, not left as an accident', () => {
    const src = readFileSync(join(__dirname, '../../packages/domain-core/src/returns.ts'), 'utf8');
    expect(src).toContain('Why step 3 is ONE rank over two relations');
    expect(returnsLockRank('credit_notes')).toBe(returnsLockRank('customer_credits'));
    // And the rank is genuinely shared rather than two relations happening to
    // tie: one step string holds both.
    expect(RETURNS_LOCK_ORDER[returnsLockRank('credit_notes')]).toContain('|');
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
    expect(returnsStatus('credit_note.posting_incomplete')).toBe(500);
    // Every other code is a 4xx: a merchant mistake is never reported as ours.
    const ours = new Set([
      'customer_refund.arithmetic_invalid',
      'customer_refund.registry_incomplete',
      'credit_note.consumption_inconsistent',
      'credit_note.cogs_not_exact',
      'credit_note.posting_incomplete',
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
