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
  REFUND_ENTRY_ACCOUNTS,
  CREDIT_NOTE_INTENT_FIELDS,
  REFUND_INTENT_FIELDS,
  REFUND_NAMES_NO_INVOICE,
  RETURNS_DATE_COMPARISON_INSTANT,
  RETURNS_LOCK_ORDER,
  CREDIT_NOTE_HAS_NO_LIFECYCLE,
  RETURNS_REFUSAL_CODES,
  RETURNS_TRANSACTION_BOUNDARY,
  S5_ACCOUNTING_SOURCE_TYPES,
  S5_OPERATION_CODES,
  creditNoteCogsReversalBaseMinor,
  creditNoteIntentItems,
  creditNoteIntentPreimage,
  creditNoteReplayVerdict,
  creditNoteTaxRefusal,
  forbiddenRefundFields,
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
import {
  assertApplicationRowAgreesWithEntry,
  creditNoteApplicationRow,
  type CreditNoteApplicationIdentity,
  type CreditNoteApplicationWrite,
} from '../../apps/api/src/modules/returns/returns-ports';
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

/** 100, the `cr_rel` of a 100-unit consumption from a 1 000-at-rate-1.0 source. Named so the sign-symmetry property reads as a property. */
const CR_REL_100 = 100n;

/** The settlement module's own text, for the two assertions that hold a COMMENT to a ruling. */
const SETTLEMENT_LAW_SOURCE = readFileSync(join(__dirname, '../../apps/api/src/modules/returns/returns-settlement.ts'), 'utf8');

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
    // L4: and TWO things are translated, not one — which executing this test is
    // what established. The account is relabelled 2210 → 2200, and the CURRENCY
    // SNAPSHOT NAME `credit` becomes `source`, because S5's line vocabulary
    // names the consumed source's currency `source` and has no member called
    // `credit`. Both translations live in one declared map each, and both are
    // asserted here rather than left for a reader to discover.
    //
    // This assertion previously claimed the account was the ONLY difference. It
    // was wrong, and it said so in a comment about being thorough.
    const CURRENCY_TRANSLATION: Record<string, string> = { credit: 'source' };
    const translatedCurrency = (c: string): string => CURRENCY_TRANSLATION[c] ?? c;
    expect(mineLines.map((l) => `${l.currency} ${l.txnAmountMinor}`)).toEqual(
      canonicalLines.map((l) => `${translatedCurrency(l.currency)} ${l.txnAmountMinor}`),
    );
    // Non-vacuity of the translation: it really fires on this plan, so the line
    // above is not an identity map dressed up as one.
    expect(canonicalLines.some((l) => l.currency === 'credit')).toBe(true);
    expect(mineLines.some((l) => l.currency === 'source')).toBe(true);
    // Widened ON PURPOSE. `ReturnsEntryLine['currency']` has no `credit` member,
    // so the compiler rejects this comparison outright with TS2367 — which is a
    // STRONGER statement than any runtime check: the translation is not merely
    // performed, the untranslated value is unrepresentable on an S5 line. The
    // runtime check is kept over a widened view so the law is also asserted
    // against the VALUES the mapper produced and not only the type it declares.
    expect((mineLines as readonly { readonly currency: string }[]).some((l) => l.currency === 'credit')).toBe(false);
    const relabelled = mineLines.filter((l) => l.account === 'customer_refund_liability');
    const original = canonicalLines.filter((l) => l.account === 'customer_credit_liability');
    expect(relabelled).toHaveLength(original.length);
    expect(relabelled.length).toBeGreaterThan(0);
    for (let i = 0; i < relabelled.length; i += 1) {
      const a = relabelled[i] as ReturnsEntryLine;
      const b = original[i] as (typeof original)[number];
      expect(a.currency).toBe(translatedCurrency(b.currency));
      expect(a.txnAmountMinor).toBe(b.txnAmountMinor);
      expect(a.baseAmountMinor).toBe(b.baseAmountMinor);
      expect(a.side).toBe(b.side);
    }
    // And the relabelling genuinely happened, so the assertion above is not vacuous.
    expect(canonicalLines.some((l) => l.account === 'customer_credit_liability')).toBe(true);
    expect(mineLines.some((l) => l.account === 'customer_refund_liability')).toBe(true);
    expect(mineLines.some((l) => l.account === 'customer_credit_liability')).toBe(false);
  });

  it('yields a LAWFUL application ROW, every column of it, checked against the entry rather than against itself', () => {
    // This test replaced one that asserted
    // `realizedFxMinor === creditCarryingReleasedMinor − invoiceCarryingReleasedMinor`,
    // which is the DEFINITION of the field restated — true of any input, and so
    // a statement about `-` and not about the plan. The row is the real subject:
    // fifteen command-owned `NOT NULL` columns, mapped by the shipped mapper, and judged
    // against the entry's own lines.
    const plan = planCreditNoteApplication({
      invoice: WORKED_INVOICE,
      note: WORKED_NOTE,
      sameCurrency: true,
      consumedMinor: 3_333n,
      appliedMinor: 3_333n,
    });
    const identity: CreditNoteApplicationIdentity = {
      applicationId: 'app-1',
      lineNo: 1,
      creditNoteId: 'cn-1',
      customerId: 'cus-1',
      invoiceId: 'inv-1',
      applicationDate: '2026-03-04',
      creditCurrencyCode: 'USD',
      invoiceCurrencyCode: 'USD',
    };
    const row = creditNoteApplicationRow(identity, plan);
    // The three money columns, against the numbers the challenger verified BY
    // HAND — not against the plan's own fields: rel = 3 617, cr_rel = 3 633,
    // realized = 16.
    expect(row.invoiceCarryingBaseReleasedMinor).toBe(3_617n);
    expect(row.creditCarryingBaseReleasedMinor).toBe(3_633n);
    expect(row.realizedFxGainLossMinor).toBe(16n);
    // Every column the relation declares `NOT NULL` is present and non-empty.
    for (const [name, value] of Object.entries(row)) {
      expect(value, name).not.toBeUndefined();
      if (typeof value === 'string') expect(value.length, name).toBeGreaterThan(0);
    }
    expect(() => assertApplicationRowAgreesWithEntry(row, plan)).not.toThrow();
  });

  it('RED PROOF — the two adjacent carrying columns CROSSED is refused, which no NOT NULL and no CHECK would catch', () => {
    const plan = planCreditNoteApplication({ invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 3_333n, appliedMinor: 3_333n });
    const identity: CreditNoteApplicationIdentity = {
      applicationId: 'app-1',
      lineNo: 1,
      creditNoteId: 'cn-1',
      customerId: 'cus-1',
      invoiceId: 'inv-1',
      applicationDate: '2026-03-04',
      creditCurrencyCode: 'USD',
      invoiceCurrencyCode: 'EUR',
    };
    const row = creditNoteApplicationRow(identity, plan);
    // Non-vacuity: the two columns genuinely differ in this scenario, so
    // crossing them is a real change and not a relabelling of equals.
    expect(row.creditCarryingBaseReleasedMinor).not.toBe(row.invoiceCarryingBaseReleasedMinor);
    const crossed: CreditNoteApplicationWrite = {
      ...row,
      creditCarryingBaseReleasedMinor: row.invoiceCarryingBaseReleasedMinor,
      invoiceCarryingBaseReleasedMinor: row.creditCarryingBaseReleasedMinor,
    };
    expect(codeOf(() => assertApplicationRowAgreesWithEntry(crossed, plan))).toBe('credit_note.posting_incomplete');
  });

  it('RED PROOF — an entry carrying BOTH a gain and a loss line is refused, which the conditional form could not do', () => {
    // The coordinator's finding 2. The row guard's realized-FX expression used to
    // read whichever of the two accounts was non-zero:
    //
    //     netBaseOnLines('fx_gain') === 0n ? -netBaseOnLines('fx_loss') : -netBaseOnLines('fx_gain')
    //
    // correct in three of the four cases and wrong in the fourth — with both
    // lines present it dropped the loss entirely and attributed a gain the entry
    // had not netted. It is now the negation of the SUM, and this is the case
    // that separates the two.
    const plan = planCreditNoteApplication({ invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 3_333n, appliedMinor: 3_333n });
    const identity: CreditNoteApplicationIdentity = {
      applicationId: 'app-1',
      lineNo: 1,
      creditNoteId: 'cn-1',
      customerId: 'cus-1',
      invoiceId: 'inv-1',
      applicationDate: '2026-03-04',
      creditCurrencyCode: 'USD',
      invoiceCurrencyCode: 'EUR',
    };
    const row = creditNoteApplicationRow(identity, plan);
    // Non-vacuity: the lawful entry has exactly ONE FX line, a 16-minor gain.
    expect(plan.entryLines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss')).toHaveLength(1);
    expect(row.realizedFxGainLossMinor).toBe(16n);
    expect(() => assertApplicationRowAgreesWithEntry(row, plan)).not.toThrow();

    // A second FX line appears on the OTHER account — the shape a sign defect in
    // a future edit to `realizedLines` would produce.
    const bothSides: readonly ReturnsEntryLine[] = [
      ...plan.entryLines,
      { account: 'fx_loss', side: 'D', currency: 'base', txnAmountMinor: 5n, baseAmountMinor: 5n },
    ];
    // The two expressions of the SAME quantity disagree on this entry, which is
    // the whole finding: the sum sees 11, the conditional form saw 16.
    const net = (account: string): bigint =>
      bothSides.filter((l) => l.account === account).reduce((a, l) => a + (l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor), 0n);
    const bySum = -(net('fx_gain') + net('fx_loss'));
    const byConditional = net('fx_gain') === 0n ? -net('fx_loss') : -net('fx_gain');
    expect(bySum).toBe(11n);
    expect(byConditional).toBe(16n);
    expect(byConditional).toBe(row.realizedFxGainLossMinor); // …which is why the old form stayed GREEN here.

    // And the shipped guard, reading the sum, refuses.
    expect(codeOf(() => assertApplicationRowAgreesWithEntry(row, { ...plan, entryLines: bothSides }))).toBe('credit_note.posting_incomplete');
  });

  it('RED PROOF — the mapper refuses an UNPINNED identity, which is reachable from a legitimate handler', () => {
    const plan = planCreditNoteApplication({ invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 3_333n, appliedMinor: 3_333n });
    const identity: CreditNoteApplicationIdentity = {
      applicationId: 'app-1',
      lineNo: 1,
      creditNoteId: 'cn-1',
      customerId: 'cus-1',
      invoiceId: 'inv-1',
      applicationDate: '2026-03-04',
      creditCurrencyCode: 'USD',
      invoiceCurrencyCode: 'USD',
    };
    // A handler that forgot to pin the customer under the rank-1 lock. The
    // composite FK edges would otherwise report this at COMMIT, far from here.
    expect(codeOf(() => creditNoteApplicationRow({ ...identity, customerId: '' }, plan))).toBe('customer_refund.arithmetic_invalid');
    expect(codeOf(() => creditNoteApplicationRow({ ...identity, applicationDate: '' }, plan))).toBe('customer_refund.arithmetic_invalid');
    expect(codeOf(() => creditNoteApplicationRow({ ...identity, lineNo: 0 }, plan))).toBe('customer_refund.arithmetic_invalid');
    // Green on the pinned one, so the refusals above are about the omission.
    expect(() => creditNoteApplicationRow(identity, plan)).not.toThrow();
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

  it('2a — the guard’s oracle is a SECOND implementation, exercised over ties and over a spread', () => {
    // M1. `assertCanonicalArRelease` used to call `apRelease` with the inputs
    // `arSide` had already called it with and compare the results: `f(x) === f(x)`,
    // mathematically unreachable in the shipped composition. It now computes
    // `rel` from a biased-quotient HALF_EVEN written in `returns-settlement.ts`
    // and compares BOTH against the plan and against `apRelease`.
    //
    // The function is deliberately not exported — nothing in the slice may round
    // money with it — so it is exercised THROUGH the guard: every scenario below
    // passes only if the two implementations agree, and the differential arm's
    // message is distinct from the plan-mismatch one.
    expect(SETTLEMENT_SOURCE).toContain('function halfEvenByBiasedQuotient');
    // It is not a call to the accepted primitive wearing a new name.
    const helperMatch = /function halfEvenByBiasedQuotient\(([\s\S]*?)\n\}/.exec(SETTLEMENT_SOURCE)?.[1];
    expect(helperMatch).toBeDefined();
    const helper = helperMatch as string;
    expect(helper).not.toContain('roundHalfEven');
    expect(helper).not.toContain('apRelease');
    expect(helper).toContain('2n * n + d');
    // And it divides on NON-NEGATIVE operands, which is the whole of its
    // correctness on the negative half. BigInt `/` TRUNCATES toward zero; it
    // does not floor. The biased-quotient form `q = (2n + d) / 2d` is `floor`
    // only for a non-negative numerator — `(-9n)/(8n)` is `-1n` where the floor
    // is `-2` — so a signed division here rounds the negative half the wrong
    // way. The accepted `roundHalfEven` avoids it by a DIFFERENT expression
    // (remainder comparison), which is why the two remain two implementations.
    expect(helper).toContain('numerator < 0n ? -numerator : numerator');
    expect(helper).toContain('denominator < 0n ? -denominator : denominator');

    // A NON-TIE NEGATIVE case, which is the one case a tie-only suite cannot
    // see: at an exact tie, truncation and floor AGREE, so every scenario
    // above would pass over the defective form.
    //
    // At 10/3, `R(x) = HALF_EVEN(10x/3)`. `R(-1) = HALF_EVEN(-3.333…) = -3`,
    // and the biased numerator is `2·(-10) + 3 = -17` over `2d = 6`: the
    // shipped helper takes absolute values and returns `-3`; a signed division
    // truncates `-17/6` to `-2`. So the lawful `rel(-1, 1) = R(0) − R(-1) = 3`,
    // and the defective form computes `2`.
    //
    // A negative level is not reachable on the live path — `apRelease` refuses
    // it in the inventory vocabulary, which is what this call ends up doing —
    // and that is the point: the only thing this case can distinguish is the
    // sign handling, before the unreachability is detected downstream.
    const NEG_INVOICE = { totalTxnMinor: 3n, totalBaseMinor: 10n, outstandingTxnMinor: 4n, conversion: BASE };
    let negError: unknown = null;
    try {
      assertCanonicalArRelease(NEG_INVOICE, { arReleasedBeforeMinor: -1n, invoiceAmountAppliedMinor: 1n, invoiceCarryingReleasedMinor: 3n });
    } catch (e) {
      negError = e;
    }
    // Non-vacuity: the call really was refused, so the assertion below is about
    // WHICH refusal and not about a silent pass.
    expect(negError).not.toBeNull();
    expect(
      negError instanceof ReturnsPlanError && /canonical release/.test((negError as Error).message),
      'the half-even helper divided a SIGNED numerator: BigInt `/` truncates toward zero, the negative half rounds the wrong way, and no tie case can see it',
    ).toBe(false);

    // Scenarios chosen so the quotient lands ON a tie, where the two
    // formulations are most likely to part. A base/txn pair of 30/20 makes
    // `R(x) = HE(3x/2)`, so every ODD `x` is an exact half — and a rate of 1.5
    // keeps `conv_R(a)` at or above one base minor unit, so the scenario is a
    // lawful application rather than an `amount_below_base_unit` refusal.
    const TIE_INVOICE = {
      totalTxnMinor: 20n,
      totalBaseMinor: 30n,
      outstandingTxnMinor: 20n,
      conversion: { rateR10: 15n * 10n ** 9n, txnExponent: 2, baseExponent: 2 },
    };
    let ties = 0;
    for (let applied = 1n; applied <= 20n; applied += 1n) {
      const p = planCreditNoteApplication({
        invoice: TIE_INVOICE,
        note: { originalMinor: 20n, originalCarryingMinor: 30n, remainingMinor: 20n, conversion: TIE_INVOICE.conversion },
        sameCurrency: true,
        consumedMinor: applied,
        appliedMinor: applied,
      });
      // The guard runs inside the plan; running it again here names the subject.
      expect(() => assertCanonicalArRelease(TIE_INVOICE, p)).not.toThrow();
      // And the release agrees with the accepted primitive at every tie.
      expect(p.invoiceCarryingReleasedMinor).toBe(apRelease(30n, 20n, 0n, applied));
      if (applied % 2n === 1n) ties += 1;
    }
    // Non-vacuity: the spread really did contain exact ties, which is the only
    // reason to choose this pair.
    expect(ties).toBe(10);

    // A spread over the worked pair, including the full consumption.
    for (const applied of [1n, 2n, 7n, 3_332n, 3_333n, 3_334n, 9_999n, 10_000n]) {
      const p = planCreditNoteApplication({ invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: applied, appliedMinor: applied });
      expect(() => assertCanonicalArRelease(WORKED_INVOICE, p)).not.toThrow();
      expect(p.invoiceCarryingReleasedMinor).toBe(apRelease(WORKED_INVOICE.totalBaseMinor, WORKED_INVOICE.totalTxnMinor, 0n, applied));
    }

    // RED, and reachable: a plan whose level is NOT the chain position the lock
    // returned. A handler that passed the outstanding instead of the released
    // level reaches this with a legitimate invoice and a legitimate amount.
    // The invoice is PARTLY SETTLED, which the first execution of this test
    // showed is necessary for the plant to be a plant at all: over a fresh
    // invoice, `outstanding` IS the total, so `outstanding + applied` exceeds
    // it and `apRelease` refuses in the INVENTORY vocabulary before this guard
    // is ever reached. The proof then measured the inventory primitive's
    // precondition instead of S5's level law.
    //
    // Here `outstanding = 6 667`, so the lock's chain position is
    // `total − outstanding = 3 333`. The handler wrongly passes the OUTSTANDING
    // as the level, with the carrying release that is consistent with it — so
    // the first arm agrees and the LEVEL law is what fires, which is the defect
    // this case is named for.
    const PARTLY_SETTLED = { ...WORKED_INVOICE, outstandingTxnMinor: 6_667n };
    expect(PARTLY_SETTLED.outstandingTxnMinor + 3_333n).toBe(PARTLY_SETTLED.totalTxnMinor);
    expect(
      codeOf(() =>
        assertCanonicalArRelease(PARTLY_SETTLED, {
          arReleasedBeforeMinor: PARTLY_SETTLED.outstandingTxnMinor,
          invoiceAmountAppliedMinor: 3_333n,
          invoiceCarryingReleasedMinor: apRelease(PARTLY_SETTLED.totalBaseMinor, PARTLY_SETTLED.totalTxnMinor, PARTLY_SETTLED.outstandingTxnMinor, 3_333n),
        }),
      ),
    ).toBe('credit_note.posting_incomplete');
    // And the LAWFUL level over the same invoice is accepted, so the refusal
    // above is about the level and not about the invoice.
    expect(() =>
      assertCanonicalArRelease(PARTLY_SETTLED, {
        arReleasedBeforeMinor: 3_333n,
        invoiceAmountAppliedMinor: 3_333n,
        invoiceCarryingReleasedMinor: apRelease(PARTLY_SETTLED.totalBaseMinor, PARTLY_SETTLED.totalTxnMinor, 3_333n, 3_333n),
      }),
    ).not.toThrow();

    // A full release that does not release the whole carrying value, refused.
    //
    // Stated honestly: the FIRST check is what fires here, not the conservation
    // arm. The conservation arm's own subject is a defect common to BOTH
    // rounding implementations, which no plant from outside can produce — so it
    // is a bound that cannot be driven red from here, and claiming otherwise
    // would be the kind of overclaim this round exists to remove. It is kept
    // because it costs nothing and is the only arm that survives a defect in the
    // rounding boundary itself.
    expect(
      codeOf(() =>
        assertCanonicalArRelease(WORKED_INVOICE, {
          arReleasedBeforeMinor: 0n,
          invoiceAmountAppliedMinor: WORKED_INVOICE.totalTxnMinor,
          invoiceCarryingReleasedMinor: WORKED_INVOICE.totalBaseMinor - 1n,
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
    // M5. The first version of this proof declared its own `MANDATORY` list of
    // seven names and its own `missing` lambda, so it tested a filter the test
    // had written against a list the test had chosen — and it passed while the
    // write shape was still missing `credit_note_id`. The mandatory set is now
    // DERIVED from §3 of the DDL specification: every column the relation
    // declares `NOT NULL` with no `DEFAULT` and no `GENERATED` clause.
    const DDL = readFileSync(join(__dirname, '../../docs/PHASE_4_S5_DDL_SPECIFICATION.md'), 'utf8');
    const block = DDL.slice(DDL.indexOf('## 3. `credit_note_applications`'), DDL.indexOf('### 3.1 The level devices'));
    const columns = [...block.matchAll(/^([a-z_]+)\s{2,}(.+)$/gm)]
      .map(([, name, rest]) => ({ name: name as string, rest: rest as string }))
      .filter((c) => / NOT NULL/.test(c.rest) && !/ DEFAULT /.test(c.rest) && !/GENERATED ALWAYS/.test(c.rest));
    // Non-vacuity, counted: the reader found the real block, and the count is
    // the number this slice is held to. A reader that found nothing would make
    // every assertion below pass.
    expect(columns.map((c) => c.name)).toContain('realized_fx_gain_loss_minor');
    // 19, and the number is the DERIVATION's — not a remembered one. This read
    // 20 and the mandatory count below read 15 until the suite was executed;
    // the specification has had 19 such columns throughout (checked against the
    // previous commit), so both anchors were simply wrong and the file's syntax
    // error is why nobody found out.
    expect(columns).toHaveLength(19);

    // The five columns the COMMAND does not supply, each with the reason it is
    // exempt. An exemption is a sentence, not a silence.
    const EXEMPT: Record<string, string> = {
      tenant_id: 'ReturnsScope.tenantId — tenancy is never a per-row argument',
      business_id: 'ReturnsScope.businessId — likewise',
      business_transaction_id: 'ReturnsScope.businessTransactionId — one per command, shared by every row it writes',
      created_by: 'ReturnsScope.actorUserId — the actor is the scope, not the payload',
      binding_source_id: 'pinned by credit_note_applications_binding_identity_ck to `id`, so it IS applicationId',
    };
    // The snake_case → field renames, written out because two columns carry a
    // `Code` suffix in the contract and `id` is the application's own.
    const RENAME: Record<string, string> = { id: 'applicationId', credit_currency: 'creditCurrencyCode', invoice_currency: 'invoiceCurrencyCode' };
    const fieldOf = (column: string): string => RENAME[column] ?? column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    const MANDATORY = columns.filter((c) => !(c.name in EXEMPT)).map((c) => fieldOf(c.name));
    // 19 NOT NULL columns with no default, minus the five the SCOPE supplies.
    expect(Object.keys(EXEMPT)).toHaveLength(5);
    expect(MANDATORY).toHaveLength(14);
    expect(MANDATORY).toContain('creditNoteId');

    const shapeOf = (source: string): readonly string[] => {
      const body = /export interface CreditNoteApplicationWrite \{([\s\S]*?)\n\}/.exec(source)?.[1];
      expect(body).toBeDefined();
      return [...(body as string).matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/gm)].map((m) => m[1] as string);
    };
    const unpopulatable = (shape: readonly string[]): readonly string[] => MANDATORY.filter((m) => !shape.includes(m));

    // Green on what ships.
    expect(unpopulatable(shapeOf(PORTS_SOURCE))).toEqual([]);

    // RED on the shape this slice actually shipped — read out of the contract
    // pack, where §5.1b(c) records it verbatim, not restated here. "A relation
    // with required financial columns that the legitimate command cannot
    // populate is an invalid design."
    const PACK = readFileSync(join(__dirname, '../../docs/PHASE_4_S5_CONTRACT_PACK.md'), 'utf8');
    const recorded = PACK.slice(PACK.indexOf('#### (c) The write shape that could not populate its own relation'));
    const preCorrection = shapeOf(recorded);
    expect(preCorrection).toHaveLength(7);
    const gap = unpopulatable(preCorrection);
    expect(gap.length).toBeGreaterThan(0);
    // And it is missing exactly the money and identity columns the ruling names.
    expect(gap).toContain('creditCarryingBaseReleasedMinor');
    expect(gap).toContain('realizedFxGainLossMinor');
    expect(gap).toContain('creditRemainingBeforeMinor');
    expect(gap).toContain('creditNoteId');

    // And the shape is populatable IN FACT and not only in type: the shipped
    // mapper produces a value for every mandatory field, from a plan and an
    // identity, with no field left undefined.
    const row = creditNoteApplicationRow(
      {
        applicationId: 'app-1',
        lineNo: 1,
        creditNoteId: 'cn-1',
        customerId: 'cus-1',
        invoiceId: 'inv-1',
        applicationDate: '2026-03-04',
        creditCurrencyCode: 'USD',
        invoiceCurrencyCode: 'USD',
      },
      plan(),
    );
    expect(MANDATORY.filter((m) => (row as unknown as Record<string, unknown>)[m] === undefined)).toEqual([]);
  });

  it('7 — TWO independent conversions of the released and the remaining carrying value', () => {
    // Structural, over the shipped text of the one function the defect lived in.
    // `TL-P4-S5-R2`: "Do not independently convert the applied amount and the
    // remaining amount and then reconcile the difference."
    const bodyOf = (source: string): string => {
      const fn = /function planCreditNoteReversal\(([\s\S]*?)\n\}/.exec(source)?.[1];
      expect(fn).toBeDefined();
      return (fn as string).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    };
    const code = bodyOf(SETTLEMENT_SOURCE);
    // Exactly ONE conversion, of the header total.
    expect([...code.matchAll(/\bconvert\(/g)]).toHaveLength(1);
    expect(code).toContain('convert(input.totalMinor, input.conversion)');

    // M5. The red arm was a template literal the test wrote, which proves only
    // that the counter counts. The subject is now the REAL deleted body, read
    // out of §5.1b(a) of the contract pack where it is recorded verbatim from
    // `8e996c5`.
    const PACK = readFileSync(join(__dirname, '../../docs/PHASE_4_S5_CONTRACT_PACK.md'), 'utf8');
    const i = PACK.indexOf('#### (a) The two independent conversions');
    expect(i).toBeGreaterThan(-1);
    const fence = /```ts\n([\s\S]*?)```/.exec(PACK.slice(i))?.[1];
    expect(fence).toBeDefined();
    const deleted = (fence as string).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The recorded defect is the real one: it converts the APPLIED amount, by
    // name, which is the operand the ruling forbids converting independently.
    expect(deleted).toContain('convert(input.appliedToInvoiceMinor, input.conversion)');
    expect([...deleted.matchAll(/\bconvert\(/g)]).toHaveLength(1);
    // One in the recorded fragment plus the header conversion it reconciles
    // against — so the counter applied to the WHOLE pre-correction function
    // sees two, and the shipped one sees one.
    expect([...(deleted + code).matchAll(/\bconvert\(/g)]).toHaveLength(2);

    // The structural arm, which does not depend on counting anything: the input
    // type no longer NAMES an applied amount, so the second conversion has no
    // operand to take. This is the law, and the count above is its symptom.
    const inputBody = /export interface CreditNoteReversalInput \{([\s\S]*?)\n\}/.exec(SETTLEMENT_SOURCE)?.[1];
    expect(inputBody).toBeDefined();
    expect(inputBody as string).toContain('totalMinor');
    expect(inputBody as string).not.toContain('appliedToInvoiceMinor');
    // And the recorded defect's operand IS a field name, so the assertion above
    // is about an absence that was once a presence.
    expect(deleted).toContain('input.appliedToInvoiceMinor');

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
    // …and refused, under `date_invalid` and NOT `amount_invalid`. These three
    // expectations said `amount_invalid` until this file was executed for the
    // first time: the domain had already been corrected — telling a merchant
    // who mistyped a DATE that the AMOUNT was wrong sends them to a field that
    // is correct — and the test kept the old answer, unnoticed because a
    // separate syntax error meant the file never compiled.
    expect(returnsDateRefusal('credit_note', '2026-10-7', '2026-10-01', '2026-10-07')).toBe('credit_note.date_invalid');
    expect(returnsDateRefusal('customer_refund', '07/10/2026', '2026-10-01', '2026-10-07')).toBe('customer_refund.date_invalid');
    expect(returnsDateRefusal('credit_note', '2026-10-07', '2026-10-01', '')).toBe('credit_note.date_invalid');

    // THE SHAPE TEST WAS NOT ENOUGH, and executing this suite is what found it.
    // `2026-13-45` is the example the domain's own comment cites as the input
    // `date_invalid` catches, and it passed `/^\d{4}-\d{2}-\d{2}$/` — month 13
    // then sorted after every real month, so the nonsense date was reported as
    // `date_in_future`: a refusal pointing at the wrong problem, which is
    // exactly what the comment claimed had been fixed.
    expect(returnsDateRefusal('credit_note', '2026-13-45', '2026-10-01', '2026-10-07')).toBe('credit_note.date_invalid');
    // A real month with an impossible day, and the Gregorian leap rule in both
    // directions — 2026 is not a leap year and 2024 is.
    expect(returnsDateRefusal('credit_note', '2026-02-30', '2026-01-01', '2026-10-07')).toBe('credit_note.date_invalid');
    expect(returnsDateRefusal('credit_note', '2026-04-31', '2026-01-01', '2026-10-07')).toBe('credit_note.date_invalid');
    expect(returnsDateRefusal('credit_note', '2026-02-29', '2026-01-01', '2026-10-07')).toBe('credit_note.date_invalid');
    expect(returnsDateRefusal('credit_note', '2024-02-29', '2024-01-01', '2024-10-07')).toBeNull();
    // And a lawful date is still lawful, so the tightening refused nothing real.
    expect(returnsDateRefusal('credit_note', '2026-10-07', '2026-10-01', '2026-10-07')).toBeNull();
    expect(returnsDateRefusal('credit_note', '2026-12-31', '2026-01-01', '2026-12-31')).toBeNull();
  });
});

// ── 10b. `TL-P4-S5-R3`: the SYMMETRIC 2× refund-FX SANITY bound ────────

/**
 * The project owner's rule, approved as `TL-P4-S5-R3`:
 *
 *     accept   0.5× ≤ current_rate / source_rate ≤ 2×     (INCLUSIVE both ends)
 *     refuse   strictly outside that range
 *
 * It is a DATA-QUALITY guard. It computes no realized FX, caps no accounting
 * value and creates no amount; `returns-settlement.ts` says so at the site, and
 * these tests hold the behaviour to the rule at every boundary the ruling names.
 *
 * Eleven cases are required and all eleven are below, each labelled with the
 * ruling's own wording so a reader can count them against it rather than trust
 * this sentence.
 */
describe('TL-P4-S5-R3 — the symmetric 2× refund-FX sanity bound, at every boundary', () => {
  // A source of 1 000 at rate 1.0, so `cr_rel` for a 100-unit consumption is
  // exactly 100 and the disbursement's base equals its minor amount. The rate
  // RATIO is then `db / cr_rel`, readable directly off the numbers, which is
  // what makes the eleven cases legible as ratios rather than as amounts.
  const flat = (over: Partial<ConsumableSource> = {}): ConsumableSource => ({
    kind: 'credit_note',
    originalMinor: 1_000n,
    originalCarryingMinor: 1_000n,
    remainingMinor: 1_000n,
    conversion: BASE,
    ...over,
  });
  const CR_REL = 100n;
  const at = (disbursementAmountMinor: bigint, source: ConsumableSource = flat()): 'admitted' | string => {
    try {
      planCustomerRefund({ source, consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor, disbursement: BASE });
      return 'admitted';
    } catch (e) {
      return e instanceof ReturnsPlanError ? e.code : `other:${(e as Error).name}`;
    }
  };
  const realizedAt = (disbursementAmountMinor: bigint): bigint =>
    planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor, disbursement: BASE }).realizedMinor;

  it('the premise: `cr_rel` really is 100 here, so every ratio below is readable off the numbers', () => {
    // Non-vacuity for all eleven cases at once. If this is wrong they all test
    // something other than what they claim.
    const plan = planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: 100n, disbursement: BASE });
    expect(plan.carryingReleasedMinor).toBe(CR_REL);
    expect(plan.disbursementBaseMinor).toBe(100n);
  });

  it('1 — SAME RATE → accept, and the realized FX is exactly zero', () => {
    expect(at(100n)).toBe('admitted');
    expect(realizedAt(100n)).toBe(0n);
    // And no FX line is posted at all for a zero: a zero-amount line is not a line.
    const plan = planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: 100n, disbursement: BASE });
    expect(plan.entryLines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss')).toHaveLength(0);
  });

  it('2 — +99% → accept', () => {
    expect(at(199n)).toBe('admitted');
    expect(realizedAt(199n)).toBe(-99n);
  });

  it('3 — EXACTLY 2× → accept, because the range is INCLUSIVE at both ends', () => {
    expect(2n * CR_REL).toBe(200n);
    expect(at(200n)).toBe('admitted');
    expect(realizedAt(200n)).toBe(-100n);
  });

  it('4 — above 2× by the MINIMUM REPRESENTABLE STEP → refuse', () => {
    // One minor unit. There is no smaller step in this estate: every amount is
    // an integer number of minor units and nothing is a float.
    expect(at(201n)).toBe('customer_refund.fx_rate_changed');
    // The boundary is exactly here and nowhere near here.
    expect(at(200n)).toBe('admitted');
  });

  it('5 — −49% → accept', () => {
    expect(at(51n)).toBe('admitted');
    expect(realizedAt(51n)).toBe(49n);
  });

  it('6 — EXACTLY 0.5× → accept', () => {
    expect(at(50n)).toBe('admitted');
    expect(realizedAt(50n)).toBe(50n);
  });

  it('7 — below 0.5× by the MINIMUM REPRESENTABLE STEP → refuse', () => {
    expect(at(49n)).toBe('customer_refund.fx_rate_changed');
    expect(at(50n)).toBe('admitted');
  });

  it('8 — the GAIN direction posts a credit to 4900 and nothing to 6900', () => {
    const plan = planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: 60n, disbursement: BASE });
    expect(plan.realizedMinor).toBe(40n);
    const fx = plan.entryLines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss');
    expect(fx).toHaveLength(1);
    expect(fx[0]?.account).toBe('fx_gain');
    expect(fx[0]?.side).toBe('C');
    expect(fx[0]?.baseAmountMinor).toBe(40n);
  });

  it('9 — the LOSS direction posts a debit to 6900 and nothing to 4900', () => {
    const plan = planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: 140n, disbursement: BASE });
    expect(plan.realizedMinor).toBe(-40n);
    const fx = plan.entryLines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss');
    expect(fx).toHaveLength(1);
    expect(fx[0]?.account).toBe('fx_loss');
    expect(fx[0]?.side).toBe('D');
    expect(fx[0]?.baseAmountMinor).toBe(40n);
  });

  it('10 — BASE CURRENCY = 1: the rule holds at the smallest representable liability', () => {
    // `cr_rel = 1`, where "a factor of two" is one minor unit and the integer
    // boundary is at its tightest. A rule that only works on large numbers is a
    // rule that fails on the row a merchant actually complains about.
    const one = flat({ originalMinor: 1n, originalCarryingMinor: 1n, remainingMinor: 1n });
    const atOne = (db: bigint): string => {
      try {
        planCustomerRefund({ source: one, consumedMinor: 1n, sameCurrency: false, disbursementAmountMinor: db, disbursement: BASE });
        return 'admitted';
      } catch (e) {
        return e instanceof ReturnsPlanError ? e.code : `other:${(e as Error).name}`;
      }
    };
    expect(atOne(1n)).toBe('admitted'); // 1×
    expect(atOne(2n)).toBe('admitted'); // exactly 2×
    expect(atOne(3n)).toBe('customer_refund.fx_rate_changed'); // beyond 2×
  });

  it('11 — a malformed, ZERO or NEGATIVE rate is already refused UPSTREAM of this guard', () => {
    // The guard never sees one, and this proves it rather than assuming it: a
    // non-positive rate is refused inside the accepted conversion primitive
    // (`convertToBase`, `packages/inventory/src/supplier-settlement.ts:80`),
    // which raises an `InventoryError` and not an S5 refusal — so the code is
    // NOT `fx_rate_changed`, and the distinction is the evidence.
    for (const rateR10 of [0n, -(10n ** 10n)]) {
      const verdict = at(100n, flat({ conversion: { rateR10, txnExponent: 2, baseExponent: 2 } }));
      expect(verdict).not.toBe('admitted');
      expect(verdict).not.toBe('customer_refund.fx_rate_changed');
    }
    // And the same for the DISBURSEMENT's own snapshot, which is the one a
    // caller supplies and therefore the one a typo arrives on.
    let thrown: unknown;
    try {
      planCustomerRefund({
        source: flat(),
        consumedMinor: 100n,
        sameCurrency: false,
        disbursementAmountMinor: 100n,
        disbursement: { rateR10: 0n, txnExponent: 2, baseExponent: 2 },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof ReturnsPlanError && thrown.code === 'customer_refund.fx_rate_changed').toBe(false);
  });

  it('the guard CAPS NOTHING: an admitted plan’s realized FX is whatever the arithmetic says, untouched', () => {
    // The ruling: "does not cap legitimate accounting values; does not create a
    // gain/loss amount." So across the whole admitted range the realized figure
    // must equal `cr_rel − db` exactly, with no clamping anywhere — including at
    // the two inclusive boundaries, where a clamp would be invisible in a test
    // that only checked the middle.
    for (let db = 50n; db <= 200n; db += 1n) {
      expect(at(db)).toBe('admitted');
      expect(realizedAt(db)).toBe(CR_REL - db);
    }
  });

  it('the refusal is a 409 the caller rebinds, with the remedy named: refresh the rate and retry', () => {
    expect(returnsStatus('customer_refund.fx_rate_changed')).toBe(409);
    // And the site says the policy out loud rather than apologising for it.
    expect(SETTLEMENT_LAW_SOURCE).toContain('TL-P4-S5-R3');
    expect(SETTLEMENT_LAW_SOURCE).toContain('REFRESH THE RATE AND');
    expect(SETTLEMENT_LAW_SOURCE).toContain('Phase 4 policy');
    // And it says what it is NOT, in the ruling's own terms.
    //
    // Over a FLOWED view: the phrase spans a comment line break in the source,
    // so a line break plus the next line's comment marker — `//` here, `*` in a
    // JSDoc block — is collapsed to a single space before the comparison. An earlier
    // draft of this assertion simply broke the string literal across two lines
    // to match — which is a SYNTAX ERROR, so this whole file never compiled and
    // every proof in it was unrunnable. That is the single strongest argument
    // for running a suite rather than reading it.
    const flowed = SETTLEMENT_LAW_SOURCE.replace(/\n\s*(?:\*|\/\/)\s?/g, ' ');
    expect(flowed).toContain('does not cap a legitimate accounting value');
    expect(flowed).toContain('creates no gain or loss amount');
  });
});

// ── 10b.1 `TL-P4-S5-R3` §16: realized FX is SIGN-SYMMETRIC ─────────────

describe('TL-P4-S5-R3 §16 — realized FX is ONE signed difference, and the sign is symmetric', () => {
  const flat = (): ConsumableSource => ({
    kind: 'credit_note',
    originalMinor: 1_000n,
    originalCarryingMinor: 1_000n,
    remainingMinor: 1_000n,
    conversion: BASE,
  });
  const realized = (db: bigint): bigint =>
    planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: db, disbursement: BASE }).realizedMinor;

  it('THE PROPERTY: swapping which carrying value is larger REVERSES THE SIGN, it does not switch algorithm', () => {
    // Stated as a property over PAIRS, not as two examples. For every offset `k`
    // in the admitted range, the gain at `100 − k` and the loss at `100 + k` are
    // exact negations of each other. Two separate examples would show two
    // numbers; this shows one function.
    for (let k = 0n; k <= 50n; k += 1n) {
      expect(realized(CR_REL_100 - k)).toBe(-realized(CR_REL_100 + k));
    }
    // Non-vacuity: the range genuinely contains non-zero values of both signs,
    // so the property is not `0 === -0` fifty-one times.
    expect(realized(CR_REL_100 - 50n)).toBeGreaterThan(0n);
    expect(realized(CR_REL_100 + 50n)).toBeLessThan(0n);
  });

  it('the eight required points, in ONE suite: zero, ±1 minor, a large gain, a large loss, a residue and the final release', () => {
    expect(realized(100n)).toBe(0n); // exact zero
    expect(realized(99n)).toBe(1n); // +1 minor
    expect(realized(101n)).toBe(-1n); // −1 minor
    expect(realized(51n)).toBe(49n); // a large gain, at the edge of the admitted range
    expect(realized(199n)).toBe(-99n); // a large loss, at the other edge
    // A ROUNDING RESIDUE: a rate that does not divide evenly, so `db` is a
    // rounded quotient and the realized figure is the one-minor residue rather
    // than a round number.
    const residue = planCustomerRefund({
      source: flat(),
      consumedMinor: 100n,
      sameCurrency: false,
      disbursementAmountMinor: 67n,
      disbursement: { rateR10: 15n * 10n ** 9n, txnExponent: 2, baseExponent: 2 },
    });
    // 67 × 1.5 = 100.5 → HALF_EVEN → 100, so the residue is exactly zero and
    // the NEIGHBOURING amount is where the one-minor residue lives.
    expect(residue.disbursementBaseMinor).toBe(100n);
    expect(residue.realizedMinor).toBe(0n);
    const neighbour = planCustomerRefund({
      source: flat(),
      consumedMinor: 100n,
      sameCurrency: false,
      disbursementAmountMinor: 66n,
      disbursement: { rateR10: 15n * 10n ** 9n, txnExponent: 2, baseExponent: 2 },
    });
    expect(neighbour.disbursementBaseMinor).toBe(99n);
    expect(neighbour.realizedMinor).toBe(1n);
    // THE FINAL RELEASE: the source's whole remaining consumed at once, so the
    // carrying released is the whole original carrying and nothing is left.
    const final = planCustomerRefund({
      source: flat(),
      consumedMinor: 1_000n,
      sameCurrency: false,
      disbursementAmountMinor: 1_000n,
      disbursement: BASE,
    });
    expect(final.carryingReleasedMinor).toBe(1_000n);
    expect(final.remainingAfterMinor).toBe(0n);
    expect(final.realizedMinor).toBe(0n);
  });

  it('NEITHER BRANCH IS DEAD: both accounts are reached in this suite, and each only from its own sign', () => {
    const accountsFor = (db: bigint): readonly string[] =>
      planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: db, disbursement: BASE })
        .entryLines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss')
        .map((l) => l.account);
    expect(accountsFor(99n)).toEqual(['fx_gain']);
    expect(accountsFor(101n)).toEqual(['fx_loss']);
    expect(accountsFor(100n)).toEqual([]);
    // And the sign chooses the account, rather than the account being chosen by
    // a branch that also computes an amount: the magnitudes match across the
    // swap, which is only true if ONE difference was computed.
    const gain = planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: 60n, disbursement: BASE });
    const loss = planCustomerRefund({ source: flat(), consumedMinor: 100n, sameCurrency: false, disbursementAmountMinor: 140n, disbursement: BASE });
    const magnitude = (p: typeof gain): bigint =>
      p.entryLines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss').reduce((a, l) => a + l.baseAmountMinor, 0n);
    expect(magnitude(gain)).toBe(magnitude(loss));
    expect(gain.realizedMinor).toBe(-loss.realizedMinor);
  });
});

// ── 10b.2 the old F5 proofs, kept as the UNBOUNDED-defect evidence ─────

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
    // Stated as the RATE comparison `TL-P4-S5-R3` actually is, not as a ceiling
    // on the realized amount: an earlier assertion here read
    // `|realized| <= carryingReleased`, which described the guard as a cap on an
    // accounting value — the one thing the ruling says it is not.
    expect(plan.disbursementBaseMinor).toBeLessThanOrEqual(2n * plan.carryingReleasedMinor);
    expect(plan.carryingReleasedMinor).toBeLessThanOrEqual(2n * plan.disbursementBaseMinor);
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
    // Retained from round 2 and now one of `TL-P4-S5-R3`'s eleven cases (3 and
    // 4), kept here because it is the LOSS edge the challenger recomputed by
    // hand and signed off, and a proof somebody has verified independently is
    // worth keeping at its original site. A bound nobody has driven to its edge
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

// ── 11. There is NO lifecycle, and the deletion is COMPLETE ──────────

/**
 * H3. The specification shipped a `status TEXT NOT NULL CHECK (status IN
 * ('draft','issued','void'))` column, a void command and two refusal codes,
 * while the guard protecting `credit_notes` permitted exactly one `UPDATE` —
 * the remaining pair moving down by one backed consumption. So the void
 * command's only action was forbidden by the guard protecting the relation it
 * acted on, and so was `draft → issued`, which means the specification could
 * not issue a note either.
 *
 * The repair is the deletion, for the reasons `CREDIT_NOTE_HAS_NO_LIFECYCLE`
 * records. These tests exist because a deletion half-done is worse than none:
 * a refusal code left in a catalogue, a status left in a DTO or an operation
 * code left in a patch request each promise a command that does not exist. So
 * every place the lifecycle lived is read off disk and asserted empty, and each
 * assertion carries a NON-VACUITY arm proving the reader can see the file at
 * all.
 */
describe('H3 — the credit-note lifecycle is deleted, everywhere', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');
  const DEAD = ['credit_note.lifecycle_invalid', 'credit_note.already_consumed', 'customer.void_credit_note'] as const;

  it('the domain states the law, and names no lifecycle symbol', () => {
    expect(CREDIT_NOTE_HAS_NO_LIFECYCLE).toContain('voiding an issued note is a reversal');
    const domain = read('packages/domain-core/src/returns.ts');
    // Non-vacuity: the reader has the right file.
    expect(domain).toContain('export const CREDIT_NOTE_HAS_NO_LIFECYCLE');
    // The symbols are gone from the EXPORT surface. They may still be NAMED in
    // the comment that records their deletion — that is the point of it — so
    // the assertion is over `export`ed declarations, not over the text.
    const exported = [...domain.matchAll(/^export (?:const|function|type|interface) ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1] as string);
    // Case-INSENSITIVE, because the surviving constant is SCREAMING_CASE:
    // `/[Ll]ifecycle/` matched neither `LIFECYCLE` nor the constant that
    // carries it, so this filter returned `[]` and the assertion was comparing
    // an empty list against an expectation that could never be met. Executing
    // the suite is what showed it; the non-vacuity line above passed throughout,
    // which is why the defect was invisible to reading.
    expect(exported.filter((n) => /lifecycle/i.test(n))).toEqual(['CREDIT_NOTE_HAS_NO_LIFECYCLE']);
    expect(exported.filter((n) => /void/i.test(n))).toEqual([]);
  });

  it('the refusal vocabulary and the operation codes no longer promise a void', () => {
    for (const dead of DEAD) expect(isReturnsRefusalCode(dead)).toBe(false);
    // Non-vacuity: the predicate does accept the codes that remain.
    expect(isReturnsRefusalCode('credit_note.date_invalid')).toBe(true);
    expect(RETURNS_REFUSAL_CODES.filter((c) => /lifecycle|already_consumed/.test(c))).toEqual([]);
    expect(S5_OPERATION_CODES).toEqual(['customer.issue_credit_note', 'customer.refund']);
    // TWO commands, counted, so a third reappearing is a failure and not a diff
    // nobody read.
    expect(S5_OPERATION_CODES).toHaveLength(2);
    // And the transaction boundary no longer describes a void transaction.
    expect(RETURNS_TRANSACTION_BOUNDARY.map((b) => b.command)).toEqual(['customer.issue_credit_note', 'customer.refund']);
  });

  it('every dead code is gone from the API status table and from all THREE locale catalogues', () => {
    // `RETURNS_CODES` is the vocabulary as an ARRAY, so membership is the
    // array's own and NOT `Object.keys`. An earlier draft asked
    // `Object.keys(RETURNS_CODES)` — which on an array yields "0", "1", "2" —
    // so this loop compared code names against numeric indices and could never
    // fail. It was VACUOUS, and the line below it was a type error that kept
    // the whole file from compiling, which is why neither was noticed.
    for (const dead of DEAD) {
      expect(RETURNS_CODES as readonly string[]).not.toContain(dead);
    }
    // Non-vacuity, of the right kind: the vocabulary is the real one, a LIVE
    // code is in it, and the status table classifies that code. Asserted
    // through `returnsStatus`, which is the status authority — the array is a
    // list of codes and has no statuses in it to look up.
    expect(RETURNS_CODES.length).toBeGreaterThan(30);
    expect(RETURNS_CODES as readonly string[]).toContain('credit_note.date_invalid');
    expect(returnsStatus('credit_note.date_invalid')).toBe(422);
    for (const lang of ['en', 'ar', 'tr']) {
      const catalogue = JSON.parse(read(`apps/web/src/messages/${lang}.json`)) as Record<string, string>;
      for (const dead of DEAD) expect(catalogue[`error.${dead}`]).toBeUndefined();
      // The two codes that REPLACED a wrong one are present, in every locale:
      // a code with no message renders as its own key to a merchant.
      expect(catalogue['error.credit_note.date_invalid']).toBeTruthy();
      expect(catalogue['error.customer_refund.date_invalid']).toBeTruthy();
    }
  });

  it('the DDL specification declares no `status` column and no void routine, and says why', () => {
    const ddl = read('docs/PHASE_4_S5_DDL_SPECIFICATION.md');
    expect(ddl).toContain('THERE IS NO `status` COLUMN, AND THEREFORE NO VOID');
    // The column declaration itself, in the shape the specification writes
    // columns in. Non-vacuity first: the reader can find a column that IS there.
    expect(ddl).toMatch(/^number_seq\s+BIGINT NOT NULL/m);
    expect(ddl).not.toMatch(/^status\s+TEXT NOT NULL/m);
    // The routine is not DECLARED, which is a different claim from the string
    // being absent — and the weaker claim is the right one for the same reason
    // the domain test gives: the specification NAMES the withdrawn routine in
    // the sentence that records its withdrawal, and that sentence is the point.
    // Asserting the string's absence made this proof red against a document
    // that was correct, which executing it is what showed.
    expect(ddl).toContain('It is withdrawn');
    expect(ddl).not.toMatch(/^CREATE (?:OR REPLACE )?FUNCTION\s+customer_void_credit_note/m);
    expect(ddl).not.toMatch(/^customer_void_credit_note\b/m);
    // Non-vacuity of the routine reader: the TWO routines that ARE specified
    // are found at a line start by the same shape, so the absence above is the
    // absence of a declaration and not of a reader.
    expect(ddl).toMatch(/^customer_issue_credit_note\b/m);
    expect(ddl).toMatch(/^customer_refund_pay\b/m);
  });

  it('RED PROOF — the deletion sweep can FAIL: the same readers, run over the text that shipped before it', () => {
    // The planted subject is the real pre-correction text of each site, so this
    // proves the four assertions above are capable of going red rather than
    // merely passing over files that no longer mention the subject.
    const preDdl =
      "number_seq                           BIGINT NOT NULL CHECK (number_seq >= 1)\nstatus                               TEXT NOT NULL CHECK (status IN ('draft','issued','void'))\n";
    expect(preDdl).toMatch(/^status\s+TEXT NOT NULL/m);
    const preCatalogue = { 'error.credit_note.lifecycle_invalid': 'This return note cannot be changed that way.' } as Record<string, string>;
    expect(preCatalogue['error.credit_note.lifecycle_invalid']).toBeTruthy();
    const preCodes = ['customer.issue_credit_note', 'customer.void_credit_note', 'customer.refund'];
    expect(preCodes).toHaveLength(3);
    expect(preCodes).not.toEqual([...S5_OPERATION_CODES]);
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

/**
 * H1 — THE THREE `*_entry_complete` VALIDATORS ARE INSTALLED, NOT MERELY NAMED.
 *
 * The last open challenger finding against S5, and the DEAD-CONCEPT defect one
 * level below where `TL-P4-S1-R1` first ruled against it. §5.5 of the DDL
 * specification named three deferred completeness validators; §5.6 declared
 * TWO triggers, both on the SOURCE relations and both calling the
 * consumption-chain verifier; and §7's end-state block asserted nothing about
 * the three functions or about any trigger that would fire them. Three named
 * functions, no trigger on `journal_entries`: validators *named, not
 * installed*. A migration written to that text would have let a
 * `customer_credit_note_application` entry commit with the realized-FX line
 * omitted and the liability understated by exactly that amount — BALANCED, so
 * the one check the ledger does make would have passed, and the TypeScript
 * assertions in `returns-settlement.ts` are that validator's twins and do not
 * run in the database.
 *
 * WHAT THIS BLOCK IS AND IS NOT. The validators and their triggers will exist
 * as catalogue objects only when the Migration Owner writes the migration at
 * promotion, so «the trigger fires» is PROVEN BY DATABASE CATALOGUE and is not
 * proven here and must not be read as if it were. What IS proven here, in a
 * suite the runner executes, is the SPECIFICATION's completeness and the thing
 * that actually failed: the pair. The subject is derived from
 * `S5_ACCOUNTING_SOURCE_TYPES` and not from a list written in this file, so a
 * fourth registered source type reds this block until it too has a validator,
 * a trigger that fires it, and both halves of §7's assertion. That is the
 * dead-registry test applied to the one registry H1 is about.
 */
describe('H1 — every registered S5 source type has a validator AND the trigger that FIRES it', () => {
  const DDL = readFileSync(join(__dirname, '../../docs/PHASE_4_S5_DDL_SPECIFICATION.md'), 'utf8');
  /** `accounting_customer_<type minus its `customer_` prefix>_entry_complete`, the `0081:1594` naming. */
  const validatorOf = (type: string): string => `accounting_${type}_entry_complete`;
  /** `journal_entries_<type>_complete`, the `0081:1725-1736` naming. */
  const triggerOf = (type: string): string => `journal_entries_${type}_complete`;

  it('the premise: three registered types, and the derivation is the subject rather than a list in this file', () => {
    expect(S5_ACCOUNTING_SOURCE_TYPES).toHaveLength(3);
    expect([...S5_ACCOUNTING_SOURCE_TYPES]).toEqual(['customer_return', 'customer_credit_note_application', 'customer_refund']);
    // The specification exists and is the subject a red below would be about.
    expect(DDL).toContain('### 5.6 Triggers');
    expect(DDL).toContain('## 7. Expected catalogue shape, as an end-state block');
  });

  it('each type has a NAMED validator function in §5.5', () => {
    for (const type of S5_ACCOUNTING_SOURCE_TYPES) expect(DDL).toContain(`${validatorOf(type)}(`);
  });

  it('AND each type has a CONSTRAINT TRIGGER on `journal_entries` that executes exactly that validator, keyed on that type', () => {
    for (const type of S5_ACCOUNTING_SOURCE_TYPES) {
      const declaration = new RegExp(
        [
          `CREATE CONSTRAINT TRIGGER ${triggerOf(type)}`,
          `\\s+AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED`,
          `\\s+FOR EACH ROW WHEN \\(NEW\\.source_type = '${type}'\\)`,
          `\\s+EXECUTE FUNCTION ${validatorOf(type)}\\(\\);`,
        ].join(''),
      );
      expect(DDL).toMatch(declaration);
    }
  });

  it('§7 asserts BOTH halves from the catalogue — the function from `pg_proc` and the trigger from `pg_trigger` — and says which half is the defect', () => {
    expect(DDL).toContain("FROM pg_proc WHERE proname LIKE 'accounting_customer_%entry_complete'");
    expect(DDL).toContain('FROM pg_trigger WHERE tgrelid =');
    expect(DDL).toContain("'journal_entries'::regclass");
    expect(DDL).toContain('tgconstraint <> 0');
    // The sentence that names the defect, so a later editor cannot delete item
    // 10 and leave item 9 reading as though it were sufficient.
    expect(DDL).toContain('Item 9 without item 10 is the defect');
    expect(DDL).toContain('a function nothing invokes is not a validator');
  });

  it('RED PROOF: strike one trigger declaration from the text and the pair law refuses, naming the type whose validator nothing would invoke', () => {
    const type = 'customer_credit_note_application';
    const struck = DDL.replace(new RegExp(`CREATE CONSTRAINT TRIGGER ${triggerOf(type)}[\\s\\S]*?${validatorOf(type)}\\(\\);`), '');
    // The mutation really occurred, and it removed the trigger WITHOUT
    // removing the validator — which is precisely the shipped shape.
    expect(struck).not.toBe(DDL);
    expect(struck).toContain(`${validatorOf(type)}(`);
    const missing = S5_ACCOUNTING_SOURCE_TYPES.filter((t) => !struck.includes(`CREATE CONSTRAINT TRIGGER ${triggerOf(t)}`));
    expect(missing).toEqual([type]);
    // And the law over the live text finds nothing missing, so the red above
    // is the mutation and not a defect that is simply there.
    expect(S5_ACCOUNTING_SOURCE_TYPES.filter((t) => !DDL.includes(`CREATE CONSTRAINT TRIGGER ${triggerOf(t)}`))).toEqual([]);
  });

  it('RED PROOF: a FOURTH registered source type reds this block until it has both halves, so the obligation is counted and not listed', () => {
    const invented = 'customer_restocking_fee';
    const registry = [...S5_ACCOUNTING_SOURCE_TYPES, invented];
    const incomplete = registry.filter((t) => !DDL.includes(`${validatorOf(t)}(`) || !DDL.includes(`CREATE CONSTRAINT TRIGGER ${triggerOf(t)}`));
    expect(incomplete).toEqual([invented]);
    // The twelve-cell triangle is a COUNT in the specification, so the count
    // is read back here rather than taken on trust.
    expect(DDL).toContain('3 types × 4 duties = 12');
  });

  it('and the two SOURCE-relation verifiers are not mistaken for these three: different subjects, neither substituting for the other', () => {
    expect(DDL).toContain('credit_notes_verify');
    expect(DDL).toContain('refunds_verify');
    expect(DDL).not.toContain('credit_note_applications_verify');
    expect(DDL).toContain('neither substitutes for the other');
    // Five deferred triggers in all: two chain verifiers plus three entry validators.
    expect(DDL).toContain('All five are added to the Phase 4');
  });
});
