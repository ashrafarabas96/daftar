/**
 * GOLDEN REGRESSION — G-14: PARTIAL PAYMENT (GOLD-07).
 * (`docs/PHASE_4_ARCHITECTURE_LOCK.md` G-14 at §17's golden table, P4-AL-05,
 *  P4-AL-06, P4-AL-07, P4-AL-16, P4-AL-25; `docs/PHASE_4_EXECUTION_PLAN.md`
 *  the P4-S4 Exit condition; contract OQ-4 and OQ-9.)
 *
 * G-14 is three claims, and this file is RECORDED against all three:
 *
 *   1. `paid + outstanding = total` AFTER EVERY STEP — not only at the end.
 *      The intermediate states are the whole of the claim: a reader of record
 *      that was right at `0` and right at `total` and wrong in between would
 *      satisfy an end-state law and misreport every open invoice a merchant
 *      ever looks at.
 *   2. REVENUE IS POSTED ONCE AND NEVER RE-POSTED. Revenue is recognised by
 *      the INVOICE entry, at the sale. A payment moves cash against the
 *      receivable and must not touch revenue at all, or the same sale is
 *      booked twice (P4-AL-16).
 *   3. THE FINAL PAYMENT CLOSES TO `outstanding = 0` EXACTLY. Exactly, not
 *      "within a minor unit": dust is a second line on the receivable itself
 *      (OQ-9), never a residue left on the document.
 *
 * ── WHAT THIS FILE IS, AND WHY IT IS A GOLDEN AND NOT AN INTEGRATION TEST ──
 *
 * `tests/integration/p4s4-payment-closure.test.ts` already proves the closure
 * of ONE payment, allocated in full, and the overpayment arm. What G-14 asks
 * for is different in kind: a RECORDED WALK of one invoice from open to paid,
 * with the identity re-read from the product's own reader of record after each
 * step, and the ledger read independently alongside it. The subject is the
 * SEQUENCE, so the thing that can regress is the sequence.
 *
 * ── EVERY FIGURE HERE WAS PRODUCED BY A COMMAND ───────────────────────────
 *
 * Nothing in this file is written into a table. The business, its branches,
 * warehouses and catalogue arrive through the real onboarding and the real
 * inventory commands; the stock arrives priced through the real adjustment
 * command; the INVOICE arrives through `POST /v1/sales` and nothing else,
 * because `sale_commit` is the only sanctioned producer of a committed sale;
 * the payment method arrives through the accepted Phase 3 `payment.create_method`
 * command; and EVERY settlement step arrives through `POST /v1/customer-payments`.
 * `settlement-world.ts` says why the customer and the invoice sequence row are
 * the two exceptions, and nothing here asserts anything about how those two
 * rows arrived — only about what the settlement does with them.
 *
 * The two sides of every identity are derived INDEPENDENTLY and are each
 * other's completeness proof (P4-AL-05): `invoice_outstanding` is the reader of
 * record, and `journal_lines ⋈ accounts` by SYSTEM KEY is the ledger. A walk
 * that closed in the rows while the ledger disagreed is exactly the "customer
 * ledger and general ledger cannot both be the truth" defect.
 *
 * Every money figure is summed in SQL in integer minor units and carried as
 * text into `BigInt`. Never a float.
 *
 * ── THIS FILE IS RED UNTIL `0081` LANDS, AND THAT IS CORRECT ──────────────
 *
 * Every `it` begins by requiring its subject. While the four relations, their
 * columns, the two commands, the two verifiers, the registry rows, the
 * reader-of-record seam and the two routes do not exist, "paid + outstanding =
 * total after every step" is neither true nor false — it has no subject — and
 * the canary makes that a RED with the missing names in the message.
 *
 * It is NOT skipped, marked `todo` or guarded by an `if`. A conditional pass is
 * a `.skip` the gate's SKIP regex cannot see.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../../helpers/test-app';
import { requireSubject } from '../phase4-s2/harness';
import {
  AR_KEY,
  chainBreaks,
  chainTotals,
  closureResidue,
  closureResidueBase,
  derivedRead,
  invoiceChain,
  ledgerBalance,
  must,
  paymentClosure,
  type DerivedRead,
} from './harness';
import { collectPayment, type AllocationInput } from './settlement-path';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type OpenInvoice, type SettlementWorld } from './settlement-world';

const CLAIM =
  'one invoice settled by partial payments: paid + outstanding = total after every step, revenue posted once, and the last step closes to exactly zero';

/**
 * The system key of the account the SALE recognises revenue on, by identity.
 *
 * By identity and never by a typed account code: a code typed into a test is a
 * second copy of the chart, and the day the chart moves the test agrees with
 * the copy rather than with the estate (`0078` reads this same key).
 */
const REVENUE_KEY = 'sales_revenue';

/** One recorded step of the walk: what was asked, and every figure measured after it. */
interface Step {
  /** 1-based, so a diagnostic names the step a reader can count to. */
  readonly n: number;
  readonly paymentId: string;
  /** The amount this step collected, in the invoice's currency. */
  readonly amountMinor: bigint;
  /** `X`, the chain position this step's leg sat at — predicted here, derived by the server. */
  readonly releasedBeforeMinor: bigint;
  /** The reader of record, re-read AFTER this step. */
  readonly read: DerivedRead;
  /** The ledger, read independently alongside it. */
  readonly revenueMinor: bigint;
  readonly revenueLines: number;
  readonly arMinor: bigint;
  readonly arLines: number;
  /** This step's own payment document closure, in both currencies. */
  readonly residueMinor: bigint;
  readonly residueBaseMinor: bigint;
  readonly allocationRows: number;
}

/**
 * THE IDENTITY, AS A FUNCTION OF THE MEASURED FIGURES rather than as an inline
 * comparison — so it can be proved able to REFUSE on synthetic figures.
 *
 * An identity that has only ever been handed a real measurement is an identity
 * nobody has watched say no. Zero is lawful; anything else is a document whose
 * paid and outstanding halves do not add up to what it is for.
 */
function identityGap(paid: bigint, outstanding: bigint, total: bigint): bigint {
  return paid + outstanding - total;
}

let w: SettlementWorld;
let missing: readonly string[] = [];
let invoice: OpenInvoice;
let customer = '';
let total = 0n;
let totalBase = 0n;
/** Revenue and AR as the SALE left them, before any settlement step. */
let revenueAtSale = 0n;
let revenueLinesAtSale = 0;
let arAtSale = 0n;
let steps: readonly Step[] = [];
/** Every revenue-account line any SETTLEMENT entry posted, discovered by account TYPE. */
let revenueTouchedBySettlement: readonly Record<string, unknown>[] = [];

/**
 * Every line a settlement entry posted to an account of TYPE `revenue`,
 * discovered from the chart rather than from a list of system keys someone
 * maintained: a surplus or a release posted to a CUSTOM revenue account would
 * be just as wrong as one posted to `sales_revenue`.
 */
async function revenueLinesOfSettlements(businessId: string): Promise<readonly Record<string, unknown>[]> {
  const r = await ownerPool().query<{ system_key: string | null; code: string; n: string; sources: string }>(
    `SELECT a.system_key::text AS system_key, a.code,
            sum(l.credit_minor - l.debit_minor)::text AS n,
            string_agg(DISTINCT e.source_type, ',') AS sources
       FROM journal_lines l
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
       JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
      WHERE l.business_id = $1 AND a.type = 'revenue' AND e.source_type = ANY ($2)
      GROUP BY 1, 2`,
    [businessId, ['customer_payment_allocation', 'customer_credit_application', 'customer_credit']],
  );
  return r.rows as unknown as readonly Record<string, unknown>[];
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4partial');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '9');
  customer = await newCustomer(w);
  invoice = await sellOnCredit(w, customer, '3');
  total = BigInt(invoice.totalTxnMinor);
  totalBase = BigInt(invoice.totalBaseMinor);

  // THE WALK IS THREE STEPS, and it has to be at least three for the claim to
  // be about an INTERMEDIATE state at all: a two-step walk has one
  // intermediate state and a one-step walk has none, so "after every step"
  // would be satisfied by a reader that is only ever right at the ends.
  expect(
    total >= 4n,
    `NO SUBJECT — the invoice totals ${total} minor unit(s), which cannot be split into three strictly positive partial payments, so there is no partial-payment walk to record`,
  ).toBe(true);

  // Revenue and AR as the SALE left them. Read BEFORE any settlement step, so
  // claim 2 compares against the state the invoice entry produced rather than
  // against a figure this file chose.
  const rev0 = await ledgerBalance(ownerPool(), w.shop.businessId, REVENUE_KEY);
  revenueAtSale = rev0.minor;
  revenueLinesAtSale = rev0.lines;
  arAtSale = (await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY)).minor;

  // The three amounts: a quarter, a quarter, and ALL THAT REMAINS. The last
  // step carries the remainder deliberately — an invoice whose total divides
  // evenly by the number of steps would never exercise "closes to exactly
  // zero" against a non-trivial final figure.
  const quarter = total / 4n;
  expect(quarter > 0n, 'NO SUBJECT — the quarter step is zero, so the first two steps would move nothing').toBe(true);
  const amounts = [quarter, quarter, total - quarter - quarter];

  const recorded: Step[] = [];
  let releasedBefore = 0n;
  for (const [i, amount] of amounts.entries()) {
    const paymentId = randomUUID();
    const leg: AllocationInput = {
      invoiceId: invoice.invoiceId,
      appliedMinor: amount.toString(),
      // THE EXPECTATION HALF, NEVER SENT: the chain position this file
      // predicts and the server derives.
      releasedBeforeMinor: releasedBefore.toString(),
      invoiceTotalTxnMinor: invoice.totalTxnMinor,
      invoiceTotalBaseMinor: invoice.totalBaseMinor,
    };
    const res = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: amount.toString(),
      allocations: [leg],
    });
    expect(res.status, `partial payment ${i + 1} of ${amounts.length} (${amount} of ${total}) is accepted: ${JSON.stringify(res.body)}`).toBeLessThan(300);

    const read = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    const rev = await ledgerBalance(ownerPool(), w.shop.businessId, REVENUE_KEY);
    const ar = await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY);
    const closure = await paymentClosure(ownerPool(), w.shop.businessId, paymentId);
    recorded.push({
      n: i + 1,
      paymentId,
      amountMinor: amount,
      releasedBeforeMinor: releasedBefore,
      read,
      revenueMinor: rev.minor,
      revenueLines: rev.lines,
      arMinor: ar.minor,
      arLines: ar.lines,
      residueMinor: closureResidue(closure),
      residueBaseMinor: closureResidueBase(closure),
      allocationRows: closure.allocationRows,
    });
    releasedBefore += amount;
  }
  steps = recorded;
  revenueTouchedBySettlement = await revenueLinesOfSettlements(w.shop.businessId);
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 G-14 partial payment: the recorded walk of one invoice from open to paid', () => {
  it('the subject exists, and the recorded walk really has intermediate states', () => {
    requireSubject(missing, CLAIM);
    // THE NON-VACUITY FLOOR ON THIS GOLDEN'S OWN SUBJECT. A golden comparison
    // over an empty recorded world compares nothing to nothing and passes, so
    // the world has to be shown to be there — and `> 2` and not `> 0`, because
    // the claim is about a state BETWEEN the ends.
    expect(
      steps.length,
      'NO SUBJECT — fewer than three settlement steps were recorded, so "after every step" is a claim about the two ends only',
    ).toBeGreaterThan(2);
    expect(total > 0n, 'NO SUBJECT — the invoice totals zero, so every identity below would compare 0 with 0').toBe(true);
    expect(revenueLinesAtSale, 'NO SUBJECT — the sale posted no revenue line, so "revenue is posted once" has nothing to be about').toBeGreaterThan(0);
  });

  it('paid + outstanding = total after EVERY step, in the invoice currency and in base', () => {
    requireSubject(missing, CLAIM);
    const shown = JSON.stringify(
      steps.map((s) => ({
        step: s.n,
        collected: s.amountMinor.toString(),
        paid: s.read.paidTxnMinor.toString(),
        outstanding: s.read.outstandingTxnMinor.toString(),
        paid_base: s.read.paidBaseMinor.toString(),
        outstanding_base: s.read.outstandingBaseMinor.toString(),
        state: s.read.state,
      })),
    );
    for (const s of steps) {
      expect(
        identityGap(s.read.paidTxnMinor, s.read.outstandingTxnMinor, total).toString(),
        `after step ${s.n} of ${steps.length} the reader of record must satisfy paid + outstanding = total (${total}) in the invoice's own ` +
          `currency. A non-zero gap is the document disagreeing with itself at a state a merchant can see. The whole walk: ${shown}`,
      ).toBe('0');
      expect(
        identityGap(s.read.paidBaseMinor, s.read.outstandingBaseMinor, totalBase).toString(),
        `after step ${s.n} the BASE side must satisfy the same identity against total_base_minor (${totalBase}). The whole walk: ${shown}`,
      ).toBe('0');
    }
  });

  it('and every step actually moved the document: paid rises strictly, outstanding falls strictly', () => {
    requireSubject(missing, CLAIM);
    // Without this, the identity above is satisfiable by a walk in which the
    // second and third payments changed NOTHING — paid + outstanding = total
    // holds just as well over a document nothing happened to, so the identity
    // alone cannot tell a settled invoice from an inert one.
    const shown = JSON.stringify(steps.map((s) => ({ step: s.n, paid: s.read.paidTxnMinor.toString(), outstanding: s.read.outstandingTxnMinor.toString() })));
    let previousPaid = 0n;
    let previousOutstanding = total;
    for (const s of steps) {
      expect(s.read.paidTxnMinor > previousPaid, `step ${s.n} must raise paid above ${previousPaid}; measured ${s.read.paidTxnMinor}. The walk: ${shown}`).toBe(
        true,
      );
      expect(
        s.read.outstandingTxnMinor < previousOutstanding,
        `step ${s.n} must lower outstanding below ${previousOutstanding}; measured ${s.read.outstandingTxnMinor}. The walk: ${shown}`,
      ).toBe(true);
      // And by EXACTLY what it collected: a step that moved the document by
      // some other amount satisfies monotonicity and still misstates the
      // document. Single-currency walk, so the applied amount IS the release.
      expect(
        (s.read.paidTxnMinor - previousPaid).toString(),
        `step ${s.n} collected ${s.amountMinor} and must have raised paid by exactly that. The walk: ${shown}`,
      ).toBe(s.amountMinor.toString());
      previousPaid = s.read.paidTxnMinor;
      previousOutstanding = s.read.outstandingTxnMinor;
    }
  });

  it('revenue is posted ONCE, by the invoice, and no settlement step re-posts it', () => {
    requireSubject(missing, CLAIM);
    const shown = JSON.stringify(steps.map((s) => ({ step: s.n, revenue: s.revenueMinor.toString(), lines: s.revenueLines })));
    for (const s of steps) {
      expect(
        s.revenueMinor.toString(),
        `revenue is recognised ONCE, by the invoice entry at the sale (${revenueAtSale} over ${revenueLinesAtSale} line(s)). After settlement step ` +
          `${s.n} it must be byte-identical: a payment that re-credited revenue would book the same sale twice (P4-AL-16). The walk: ${shown}`,
      ).toBe(revenueAtSale.toString());
      expect(
        s.revenueLines,
        `and over the same NUMBER of lines: a settlement that posted a revenue debit and an equal credit would leave the balance right and the ` +
          `account wrong. At the sale: ${revenueLinesAtSale} line(s). The walk: ${shown}`,
      ).toBe(revenueLinesAtSale);
    }
  });

  it('and in a SINGLE-CURRENCY walk no account of type revenue is touched at all, custom accounts included', () => {
    requireSubject(missing, CLAIM);
    // The claim above is about the account the sale used. This one is about
    // the CHART: discovered by account TYPE, so a release posted to a custom
    // revenue account the business created itself is just as much a finding.
    //
    // WHY THIS FIXTURE MAY CLAIM THE STRICT FORM, and why the general law
    // cannot. The closed chart classifies `fx_gain` (`4900`, "Realized FX
    // Gain") as TYPE `revenue` (`0040:62`), so "no settlement entry touches
    // any revenue account" is FALSE of this estate the moment a settlement
    // crosses currencies — `12-overpayment-customer-credit.golden.test.ts`
    // measured exactly that and states the corrected law there. THIS walk is
    // single-currency throughout: payment, invoice and base are one currency,
    // every rate is structurally 1, so no realized FX can arise and the strict
    // form is available here as a STRONGER claim about this fixture rather
    // than as the general rule. A revenue-type line appearing in a
    // single-currency walk would be a finding whichever account it landed on.
    expect(
      revenueTouchedBySettlement,
      `in a single-currency walk NO settlement entry may post to a revenue account at all — not the sale's, not a custom one, and not even the ` +
        `realized-FX result, because a single-currency settlement has no rate move to realize. Revenue is the invoice's, and a payment moves ` +
        `cash against the receivable. Measured over every account of type 'revenue' and every settlement source type: ` +
        `${JSON.stringify(revenueTouchedBySettlement)}`,
    ).toEqual([]);
  });

  it('the receivable the LEDGER carries falls by exactly the amount collected, at every step', () => {
    requireSubject(missing, CLAIM);
    // The independently-derived side of the same walk (P4-AL-05). The reader
    // of record and the general ledger are two derivations of one truth, and a
    // walk that closed in one while the other disagreed is the defect
    // P4-AL-05 exists to forbid.
    const shown = JSON.stringify(steps.map((s) => ({ step: s.n, ar: s.arMinor.toString(), lines: s.arLines })));
    expect(arAtSale.toString(), `the sale left the receivable carrying the invoice total ${total} as a debit balance. Measured ${arAtSale}`).toBe(
      total.toString(),
    );
    let previous = arAtSale;
    for (const s of steps) {
      expect(
        (previous - s.arMinor).toString(),
        `step ${s.n} collected ${s.amountMinor} and the receivable must fall by exactly that, from ${previous} to ${previous - s.amountMinor}; ` +
          `measured ${s.arMinor}. The walk: ${shown}`,
      ).toBe(s.amountMinor.toString());
      previous = s.arMinor;
    }
    expect(previous.toString(), `and after the final step the receivable carries nothing at all: measured ${previous}. The walk: ${shown}`).toBe('0');
  });

  it('every step is a document that closes: Σ allocations + credit created = amount, in both currencies', () => {
    requireSubject(missing, CLAIM);
    const shown = JSON.stringify(steps.map((s) => ({ step: s.n, residue: s.residueMinor.toString(), residue_base: s.residueBaseMinor.toString() })));
    for (const s of steps) {
      expect(s.allocationRows, `step ${s.n} must carry exactly its one allocation row; a partial payment with no leg settled nothing. ${shown}`).toBe(1);
      expect(
        s.residueMinor.toString(),
        `step ${s.n}'s payment ${s.paymentId} must account for every minor unit it received: a positive residue is money that arrived and went ` +
          `nowhere, a negative one is money the document conjured. ${shown}`,
      ).toBe('0');
      expect(s.residueBaseMinor.toString(), `and the same on the BASE side of step ${s.n}. ${shown}`).toBe('0');
      // The three values `invoice_settlement_state` names (`0075:765-771`),
      // derived from the pair and never stored: `unpaid`, `partial`, `paid`.
      expect(
        s.read.state,
        `at step ${s.n} of ${steps.length}, the reader of record's state: an invoice with outstanding ${s.read.outstandingTxnMinor} of ${total} is ` +
          `${s.n === steps.length ? 'paid' : 'partial'}. ${shown}`,
      ).toBe(s.n === steps.length ? 'paid' : 'partial');
    }
  });

  it('the FINAL payment closes the invoice to outstanding = 0 EXACTLY, with no gap and no overlap on its chain', async () => {
    requireSubject(missing, CLAIM);
    const last = must(steps[steps.length - 1], 'the final recorded step');
    expect(
      {
        paid_txn: last.read.paidTxnMinor.toString(),
        outstanding_txn: last.read.outstandingTxnMinor.toString(),
        paid_base: last.read.paidBaseMinor.toString(),
        outstanding_base: last.read.outstandingBaseMinor.toString(),
        state: last.read.state,
      },
      `the last partial payment closes the invoice EXACTLY — exactly, not within a minor unit: allocation dust is a second line on the receivable ` +
        `itself (OQ-9), never a residue left on the document, and an outstanding BELOW zero would be an over-allocation stated as a number`,
    ).toEqual({
      paid_txn: invoice.totalTxnMinor,
      outstanding_txn: '0',
      paid_base: invoice.totalBaseMinor,
      outstanding_base: '0',
      state: 'paid',
    });

    const chain = await invoiceChain(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(chain.length, 'NO SUBJECT — the invoice carries no settlement row, so the walk settled nothing').toBeGreaterThan(2);
    const shownChain = JSON.stringify(chain.map((s) => ({ rel: s.relation, X: s.positionMinor.toString(), a: s.appliedMinor.toString() })));
    // One contiguous chain: every step computed from the position the step
    // before it left, with nothing skipped and nothing double-counted.
    expect(chainBreaks(chain), `the chain of invoice ${invoice.invoiceId} after the three-step walk: ${shownChain}`).toEqual([]);
    expect(
      chain.map((s) => s.positionMinor.toString()),
      `and the chain's positions are exactly the ones this file predicted before any step ran: ${shownChain}`,
    ).toEqual(steps.map((s) => s.releasedBeforeMinor.toString()));
    expect(chainTotals(chain).applied.toString(), `and the chain applied exactly the invoice's total ${invoice.totalTxnMinor}, never more: ${shownChain}`).toBe(
      invoice.totalTxnMinor,
    );
  });

  it('that law can say no: the step identity refuses a document whose halves do not add up', () => {
    // The red proof for the identity above, on synthetic figures, because an
    // identity that has only ever been handed a real measurement is an
    // identity nobody has watched refuse anything. It needs no subject: it is
    // about the function, not about the database.
    expect(identityGap(400n, 600n, 1000n), 'a document that adds up').toBe(0n);
    expect(identityGap(0n, 1000n, 1000n), 'an untouched invoice adds up too').toBe(0n);
    expect(identityGap(1000n, 0n, 1000n), 'and a closed one').toBe(0n);
    expect(identityGap(400n, 599n, 1000n), 'a minor unit lost between the halves is refused').not.toBe(0n);
    expect(identityGap(400n, 601n, 1000n), 'and a minor unit conjured').not.toBe(0n);
    expect(identityGap(1001n, 0n, 1000n), 'an over-settled document is refused: paid past the total').not.toBe(0n);
    expect(identityGap(1000n, -1n, 1000n), 'and so is a NEGATIVE outstanding, which is an over-allocation stated as a number').not.toBe(0n);
  });
});
