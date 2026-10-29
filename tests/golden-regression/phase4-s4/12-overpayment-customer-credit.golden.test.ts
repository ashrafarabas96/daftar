/**
 * GOLDEN REGRESSION — G-15: OVERPAYMENT → CUSTOMER CREDIT.
 * (GOLD-68, 69, 70, 79, 80; `docs/PHASE_4_ARCHITECTURE_LOCK.md` G-15 at §17's
 *  golden table, P4-AL-05, P4-AL-16, P4-AL-25; contract OQ-4 and OQ-9;
 *  `0081` `customer_collect_payment` / `customer_apply_credit`,
 *  `0085` re-defining the former.)
 *
 * G-15 names five clauses. THIS FILE RECORDS THE FOUR THAT HAVE A SUBJECT ON
 * THIS HEAD, AND DEFERS THE FIFTH EXPLICITLY — see the deferral section below,
 * which is part of the law and not a disclaimer.
 *
 *   1. THE SURPLUS BECOMES A CREDIT, NOT REVENUE. A merchant who pays 500
 *      against a 300 invoice has handed over 500; the surplus is a LIABILITY
 *      owed back, never something earned. A surplus that reached a revenue
 *      account would book a sale that never happened (P4-AL-16).
 *   2. APPLICATION ONTO A LATER INVOICE, under the cap lock. The credit is
 *      consumed against a DIFFERENT, subsequently-issued invoice through the
 *      real `POST /v1/customer-credits/:creditId/applications`.
 *   3. PARTIAL CONSUMPTION LEAVES BOTH HALVES PROPORTIONAL. A credit carries
 *      two numbers — `remaining_amount_minor` in its own currency and
 *      `remaining_carrying_base_amount_minor` in base — and a partial
 *      consumption must leave the second the proportional image of the first,
 *      computed from the credit's IMMUTABLE original pair and never from a
 *      previous step's already-rounded figure
 *      (`[[daftar-a-rounded-quotient-is-never-an-input]]`, P4-AL-25).
 *   4. FULL CONSUMPTION ZEROES BOTH EXACTLY. Both, and exactly: a credit whose
 *      amount reached zero while its carrying half kept a residue is a
 *      liability the ledger still believes in.
 *
 * ── WHY THE CREDIT IS BORN IN A FOREIGN CURRENCY, AND WHY THAT IS THE POINT ─
 *
 * Clause 3 is a claim about TWO DIFFERENT NUMBERS staying in proportion. In a
 * single-currency world the credit's rate is structurally 1, so its original
 * amount and its original carrying base are the SAME NUMBER, the proportion is
 * the identity, and "both halves proportional" is satisfied by any
 * implementation that simply copies one into the other — the law would be
 * green over code that has no proportional arithmetic in it at all.
 *
 * So the surplus arrives in a currency that is NOT the base, at a stated rate,
 * and the file asserts before anything else that the credit's two halves
 * really do differ. Only then is clause 3 a claim about arithmetic.
 *
 * The proportion is checked against `creditRemainingCarrying` from
 * `@daftar/inventory` — the estate's OWN primitive, the same one
 * `customer_credit_consume` calls through `supplier_credit_remaining_carrying`
 * (`0081:1239-1246`). Never a second copy of the arithmetic written here: a
 * suite that re-implemented it would agree with its own copy rather than with
 * the estate (P4-AL-07). The names are historical; the arithmetic is general.
 *
 * ── WHAT IS DEFERRED TO S5, AND WHY — THIS IS NOT A PASS ──────────────────
 *
 * G-15's owner column reads `S4, S5`. ONE of its five clauses is S5's and is
 * NOT asserted anywhere in this file:
 *
 *   — REFUND AT **CARRYING** VALUE. A refund of an unconsumed credit must pay
 *     out the carrying base rather than a re-converted amount. There is no
 *     subject for it on this head: the tree holds NO `refunds` relation and no
 *     refund command or route at all, and G-12 ("a raw payment cannot be a
 *     refund source") is itself owned by S5. Asserting a refund law here would
 *     mean inventing the relation it is about, and a law proved against a
 *     fixture this file wrote is a law about the fixture.
 *
 * That clause is therefore OPEN, and this file is not evidence for it. It is
 * named here so that a reader counting G-15's clauses against this suite finds
 * the gap stated rather than has to notice it, and so the absence of an S5
 * refund law can never read as a pass.
 *
 * The remaining four clauses are ALL S4's and all asserted. In particular the
 * application-onto-a-later-invoice clause is NOT deferred: `customer_apply_credit`
 * is an S4 command (`0081`, "P4-S4 (R-86, R-90)"), it is one of this slice's
 * two declared operation kinds, and its route is mounted — so its relations do
 * exist today and the clause is recorded below rather than postponed.
 *
 * ── EVERY FIGURE HERE WAS PRODUCED BY A COMMAND ───────────────────────────
 *
 * Nothing is written into a table. The business, catalogue and priced stock
 * arrive through the real onboarding, inventory and adjustment commands; both
 * invoices through `POST /v1/sales` and nothing else; the payment method
 * through the accepted Phase 3 `payment.create_method`; the FX rate through
 * the real `accounting_fx_rate_enter`, which is the only writer of
 * `accounting_fx_rates` — a rate inserted by hand is a rate no fingerprint
 * covers; the surplus through `POST /v1/customer-payments`; and both
 * consumptions through `POST /v1/customer-credits/:creditId/applications`.
 * Every credit figure asserted below is READ BACK off the stored row.
 *
 * Every money figure is summed in SQL in integer minor units and carried as
 * text into `BigInt`. Never a float; rates are R10 integers.
 *
 * ── THIS FILE IS RED UNTIL `0081` LANDS, AND THAT IS CORRECT ──────────────
 *
 * Every `it` begins by requiring its subject, and the canary names what is
 * missing. It is NOT skipped, marked `todo` or guarded by an `if`: a
 * conditional pass is a `.skip` the gate's SKIP regex cannot see.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { creditRemainingCarrying } from '@daftar/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../../helpers/test-app';
import { requireSubject } from '../phase4-s2/harness';
import { closureResidue, closureResidueBase, creditSnapshot, derivedRead, entryLines, entryOfSource, must, paymentClosure } from './harness';
import { applyCredit, collectPayment, CREDIT_SOURCE_TYPE, rateToR10, SYSTEM_KEYS, type AllocationInput } from './settlement-path';
import {
  baseCurrency,
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stateFxRate,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from './settlement-world';

const CLAIM =
  'an overpayment becomes a customer credit and not revenue, is applied onto a later invoice, leaves both of its halves proportional on a partial consumption and zeroes both exactly when fully consumed';

/** The currency the surplus arrives in. Deliberately not the base, and asserted so before anything runs. */
const PAY_CURRENCY = 'USD';
/** The rate in force when the credit is born — `Rn`, the credit's own snapshot. */
const RATE_AT_BIRTH = '3.6700000000';

/** One recorded consumption of the credit, and the credit's two halves after it. */
interface Consumption {
  readonly n: number;
  readonly applicationId: string;
  readonly res: Response;
  /** `c`, consumed from the credit, in the credit's currency. */
  readonly consumedMinor: bigint;
  /** `rb`, the credit's remaining BEFORE this consumption — read off the row, never assumed. */
  readonly remainingBeforeMinor: bigint;
  /** The credit's two halves AFTER it, read back off the stored row. */
  readonly remainingAfterMinor: bigint;
  readonly remainingCarryingAfterMinor: bigint;
}

/**
 * THE PROPORTION, AS A FUNCTION OF THE MEASURED FIGURES — so it can be proved
 * able to REFUSE on synthetic figures.
 *
 * `creditRemainingCarrying(OA, OB, r)` is the estate's own `g(r)`. The gap is
 * what the row carries less what `g` says it should: zero is lawful, anything
 * else is a credit whose base half has drifted off its own currency half.
 */
function proportionGap(originalMinor: bigint, originalCarryingMinor: bigint, remainingMinor: bigint, carryingMinor: bigint): bigint {
  return carryingMinor - creditRemainingCarrying(originalMinor, originalCarryingMinor, remainingMinor);
}

let w: SettlementWorld;
let missing: readonly string[] = [];
let base = '';
let customer = '';
/** The overpaid invoice, and the LATER invoice the credit is applied onto. */
let invoiceA: OpenInvoice;
let invoiceB: OpenInvoice;
let paymentId = '';
let creditId = '';
let bornRes: Response | null = null;
/** The credit's immutable original pair `(OA, OB)`, read back off the row at birth. */
let originalMinor = 0n;
let originalCarryingMinor = 0n;
let remainingAtBirthMinor = 0n;
let remainingCarryingAtBirthMinor = 0n;
let surplusMinor = 0n;
let consumptions: readonly Consumption[] = [];
/** One revenue-TYPE account a settlement entry posted to, with its signed total. */
interface RevenueHit {
  readonly systemKey: string | null;
  readonly code: string;
  readonly signedMinor: string;
  readonly sources: string;
}

/** Every revenue-TYPE account line any settlement or credit entry posted, discovered by account TYPE. */
let revenueTouched: readonly RevenueHit[] = [];
/** The payment document's closure, both currencies. */
let residueMinor = 0n;
let residueBaseMinor = 0n;

/**
 * THE ONE REVENUE-TYPE ACCOUNT A SETTLEMENT MAY LAWFULLY TOUCH, by system key.
 *
 * MEASURED, AND IT CORRECTS THE OBVIOUS FORM OF THIS LAW. The obvious
 * statement — "no settlement entry touches any account of type `revenue`" — is
 * FALSE of this estate, and the first cross-currency run of this file proved
 * it: the closed chart classifies `fx_gain` (`4900`, "Realized FX Gain") as
 * TYPE `revenue` (`0040:62`), and a cross-currency settlement posts its
 * realized gain there by design. `fx_loss` raises no question because `6900`
 * is an `expense`.
 *
 * A realized FX gain is a RESULT of holding a receivable across a rate move,
 * not the recognition of a sale, so letting it through is not a weakening of
 * GOLD-68 — and the figure itself is not unasserted: the cross-currency golden
 * `10-settlement-cross-currency.golden.test.ts` pins the realized FX to this
 * exact account and to the exact minor units the snapshots imply. What THIS
 * law owes is the other half: that no OTHER revenue account — `sales_revenue`,
 * or any custom revenue account a business created itself — is reached at all.
 *
 * Named by SYSTEM KEY and never by the code `4900`: a code typed into a test
 * is a second copy of the chart.
 */
const FX_RESULT_REVENUE_KEY = SYSTEM_KEYS.fxGain;

/**
 * Every line a settlement OR credit entry posted to an account of TYPE
 * `revenue`, discovered from the chart rather than from a list of system keys
 * someone maintained: a surplus posted to a CUSTOM revenue account the
 * business created itself would be just as wrong as one posted to
 * `sales_revenue`.
 */
async function revenueLinesOfSettlements(businessId: string): Promise<readonly RevenueHit[]> {
  const r = await ownerPool().query<{ system_key: string | null; code: string; n: string; sources: string }>(
    `SELECT a.system_key::text AS system_key, a.code,
            sum(l.credit_minor - l.debit_minor)::text AS n,
            string_agg(DISTINCT e.source_type, ',') AS sources
       FROM journal_lines l
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
       JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
      WHERE l.business_id = $1 AND a.type = 'revenue' AND e.source_type = ANY ($2)
      GROUP BY 1, 2`,
    [businessId, ['customer_payment_allocation', 'customer_credit_application', CREDIT_SOURCE_TYPE]],
  );
  return r.rows.map((x) => ({ systemKey: x.system_key, code: x.code, signedMinor: x.n, sources: x.sources }));
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4credit');
  missing = await settlementMissing(w);
  base = await baseCurrency(w);
  // THE PREMISE OF CLAUSE 3, checked before any scenario runs: a surplus
  // currency equal to the base makes the credit's rate structurally 1, its two
  // halves the same number, and "both halves proportional" a claim about
  // nothing.
  expect(
    PAY_CURRENCY,
    `NO SUBJECT — the surplus currency must differ from the business base currency ${base}, or the credit's two halves are one number and the proportionality clause is vacuous`,
  ).not.toBe(base);
  if (missing.length > 0) return;

  const rateR10 = rateToR10(RATE_AT_BIRTH);
  await stateFxRate(w, PAY_CURRENCY, base, RATE_AT_BIRTH, `${w.day}T00:00:01Z`);
  await stockUp(w, '200', '11');
  customer = await newCustomer(w);

  // ── the overpaid invoice ──────────────────────────────────────────────
  invoiceA = await sellOnCredit(w, customer, '3');
  const totalA = BigInt(invoiceA.totalTxnMinor);
  // The surplus is a quarter of the overpaid invoice: enough to be split into
  // two strictly-positive consumptions, and small enough that the LATER
  // invoice can absorb both.
  surplusMinor = totalA / 4n;
  expect(
    surplusMinor >= 2n,
    `NO SUBJECT — the surplus would be ${surplusMinor} minor unit(s), which cannot be split into two strictly positive consumptions, so there is no partial-then-full consumption to record`,
  ).toBe(true);

  paymentId = randomUUID();
  creditId = randomUUID();
  // The leg settles invoice A in FULL; everything past it is the surplus. The
  // payment is in USD and the invoice in base, so the invoice-side applied
  // amount and the payment-side amount are figures in DIFFERENT units and are
  // stated as such.
  const legA: AllocationInput = {
    invoiceId: invoiceA.invoiceId,
    appliedMinor: totalA.toString(),
    paymentAmountMinor: totalA.toString(),
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: invoiceA.totalTxnMinor,
    invoiceTotalBaseMinor: invoiceA.totalBaseMinor,
    invoiceToBaseRateR10: rateToR10(invoiceA.sourceToBaseRate),
    paymentToBaseRateR10: rateR10,
  };
  bornRes = await collectPayment(w.t, w.headers, {
    paymentId,
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    currencyCode: PAY_CURRENCY,
    amountMinor: (totalA + surplusMinor).toString(),
    creditId,
    allocations: [legA],
  });
  expect(bornRes.status, `the overpayment is accepted: ${JSON.stringify(bornRes.body)}`).toBeLessThan(300);

  // THE CREDIT'S OWN PAIR, READ BACK off the stored row — never assumed from
  // the request, and never recomputed here.
  const born = await creditSnapshot(ownerPool(), w.shop.businessId, creditId);
  originalMinor = BigInt(born.originalAmountMinor);
  originalCarryingMinor = BigInt(born.originalCarryingBaseAmountMinor);
  remainingAtBirthMinor = BigInt(born.remainingAmountMinor);
  remainingCarryingAtBirthMinor = BigInt(born.remainingCarryingBaseAmountMinor);

  const closure = await paymentClosure(ownerPool(), w.shop.businessId, paymentId);
  residueMinor = closureResidue(closure);
  residueBaseMinor = closureResidueBase(closure);

  // ── the LATER invoice, issued after the credit exists ─────────────────
  invoiceB = await sellOnCredit(w, customer, '6');
  expect(
    BigInt(invoiceB.totalTxnMinor) >= originalMinor,
    `NO SUBJECT — the later invoice totals ${invoiceB.totalTxnMinor} and the credit is ${originalMinor}, so the credit could not be fully consumed against it`,
  ).toBe(true);

  // ── two consumptions: a PARTIAL one, then ALL THAT REMAINS ────────────
  const first = originalMinor / 2n;
  const amounts = [first, originalMinor - first];
  const recorded: Consumption[] = [];
  let releasedBefore = 0n;
  for (const [i, consumed] of amounts.entries()) {
    // `rb` is read off the credit row each time rather than carried forward
    // in this file: the server's figure is the authority and a suite that
    // tracked its own would stop noticing when the two diverged.
    const beforeRow = await creditSnapshot(ownerPool(), w.shop.businessId, creditId);
    const remainingBefore = BigInt(beforeRow.remainingAmountMinor);
    const applicationId = randomUUID();
    const res = await applyCredit(w.t, w.headers, {
      applicationId,
      creditId,
      customerId: customer,
      invoiceId: invoiceB.invoiceId,
      applicationDate: w.day,
      consumedMinor: consumed.toString(),
      remainingBeforeMinor: beforeRow.remainingAmountMinor,
      creditOriginalMinor: beforeRow.originalAmountMinor,
      creditOriginalCarryingMinor: beforeRow.originalCarryingBaseAmountMinor,
      // The CREDIT's own stored snapshot, read off the credit row.
      creditToBaseRateR10: rateToR10(beforeRow.creditToBaseRate),
      leg: {
        invoiceId: invoiceB.invoiceId,
        appliedMinor: consumed.toString(),
        paymentAmountMinor: consumed.toString(),
        releasedBeforeMinor: releasedBefore.toString(),
        invoiceTotalTxnMinor: invoiceB.totalTxnMinor,
        invoiceTotalBaseMinor: invoiceB.totalBaseMinor,
        invoiceToBaseRateR10: rateToR10(invoiceB.sourceToBaseRate),
        paymentToBaseRateR10: rateToR10(beforeRow.creditToBaseRate),
      },
    });
    expect(
      res.status,
      `consumption ${i + 1} of ${amounts.length} (${consumed} of ${originalMinor}) onto the later invoice is accepted: ${JSON.stringify(res.body)}`,
    ).toBeLessThan(300);
    const afterRow = await creditSnapshot(ownerPool(), w.shop.businessId, creditId);
    recorded.push({
      n: i + 1,
      applicationId,
      res,
      consumedMinor: consumed,
      remainingBeforeMinor: remainingBefore,
      remainingAfterMinor: BigInt(afterRow.remainingAmountMinor),
      remainingCarryingAfterMinor: BigInt(afterRow.remainingCarryingBaseAmountMinor),
    });
    releasedBefore += consumed;
  }
  consumptions = recorded;
  revenueTouched = await revenueLinesOfSettlements(w.shop.businessId);
}, 480_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 G-15 overpayment becomes a customer credit, consumed onto a later invoice', () => {
  it('the subject exists, and the recorded world really holds a credit with two DIFFERENT halves', () => {
    requireSubject(missing, CLAIM);
    // THE NON-VACUITY FLOOR ON THIS GOLDEN'S OWN SUBJECT. A golden comparison
    // over an empty recorded world compares nothing to nothing and passes.
    expect(consumptions.length, 'NO SUBJECT — fewer than two consumptions were recorded, so there is no partial-then-full walk of the credit').toBeGreaterThan(
      1,
    );
    expect(surplusMinor > 0n, 'NO SUBJECT — the surplus is zero, so no credit was born and every clause below is about nothing').toBe(true);
    // AND THE PREMISE OF CLAUSE 3, now as a MEASUREMENT of the stored row
    // rather than as the choice of a constant: if the credit's two halves were
    // the same number, "proportional" would be the identity and an
    // implementation with no proportional arithmetic would pass.
    expect(
      originalCarryingMinor.toString(),
      `NO SUBJECT for the proportionality clause — the credit's original amount (${originalMinor} ${PAY_CURRENCY}) and its original carrying ` +
        `base (${originalCarryingMinor} ${base}) are the same number, so g(r) is the identity and clause 3 is vacuous. The rate at birth was ${RATE_AT_BIRTH}`,
    ).not.toBe(originalMinor.toString());
  });

  it('the surplus becomes a customer credit of exactly the surplus, with its remaining pair at the full original', () => {
    requireSubject(missing, CLAIM);
    expect(
      originalMinor.toString(),
      `the credit born of payment ${paymentId} carries the surplus and nothing else: ${surplusMinor} ${PAY_CURRENCY} was received above the ` + `invoice total`,
    ).toBe(surplusMinor.toString());
    expect(
      remainingAtBirthMinor.toString(),
      'nothing has consumed it yet, so at birth the remaining amount IS the original — a credit born already partly spent is a credit the merchant never had',
    ).toBe(originalMinor.toString());
    expect(remainingCarryingAtBirthMinor.toString(), 'and the carrying half likewise, at its full original carrying base').toBe(
      originalCarryingMinor.toString(),
    );
  });

  it('the surplus is a LIABILITY: it posts to customer_credit_liability at its carrying base, as a credit balance', async () => {
    requireSubject(missing, CLAIM);
    const entryId = await entryOfSource(ownerPool(), w.shop.businessId, CREDIT_SOURCE_TYPE, creditId);
    expect(entryId, `the surplus credit ${creditId} has no bound ${CREDIT_SOURCE_TYPE} entry, so this law has no subject`).not.toBeNull();
    const lines = await entryLines(ownerPool(), w.shop.businessId, entryId as string);
    const onLiability = lines.filter((l) => l.systemKey === SYSTEM_KEYS.customerCreditLiability);
    expect(
      onLiability.length,
      `NO SUBJECT — entry ${entryId as string} (the ${CREDIT_SOURCE_TYPE} entry of credit ${creditId}) posts no line to ` +
        `${SYSTEM_KEYS.customerCreditLiability}, so this law is asserted over no line at all`,
    ).toBeGreaterThan(0);
    // A liability is a CREDIT balance, so the signed sum is negative. Stated
    // as the signed figure and never as an absolute value: a surplus that
    // landed as a DEBIT would be an asset, and `abs()` would hide it.
    const signed = onLiability.reduce((acc, l) => acc + l.debitMinor - l.creditMinor, 0n);
    expect(
      signed.toString(),
      `the liability carries the credit's CARRYING BASE ${originalCarryingMinor} ${base} as a credit balance — the ledger is in base, and the ` +
        `credit's own ${RATE_AT_BIRTH} snapshot is what converts it. Measured ${signed} over ${onLiability.length} line(s) of entry ` +
        `${entryId as string}`,
    ).toBe((-originalCarryingMinor).toString());
  });

  it('and the surplus is NOT revenue: no revenue account but the realized-FX result is touched by any settlement', () => {
    requireSubject(missing, CLAIM);
    // Discovered by account TYPE and not by a list of system keys, so a
    // surplus posted to a CUSTOM revenue account is just as much a finding.
    // This is the whole of GOLD-68: a surplus is OWED, never EARNED.
    //
    // `FX_RESULT_REVENUE_KEY` says why realized FX gain is excluded and where
    // its own figure is asserted instead. The exclusion is by system key, so
    // it admits exactly one account and not a class.
    const sales = revenueTouched.filter((h) => h.systemKey !== FX_RESULT_REVENUE_KEY);
    expect(
      sales,
      `a surplus is a liability owed back to the customer, never revenue: revenue is recognised ONCE, by the invoice entry at the sale, and a ` +
        `payment that credited it would book a sale that never happened (P4-AL-16). The ONLY revenue-type account a settlement may reach is ` +
        `${FX_RESULT_REVENUE_KEY}, the realized-FX result (0040:62), whose amount is pinned by the cross-currency golden. Measured over every ` +
        `account of type 'revenue' and every settlement source type: ${JSON.stringify(revenueTouched)}`,
    ).toEqual([]);
    // AND THE EXCLUSION IS NOT A BLANK CHEQUE: whatever did reach a
    // revenue-type account must be the FX result and must carry a non-zero
    // figure, or the carve-out above would be excusing an account nothing
    // actually posted to and the law would have been relaxed for nothing.
    for (const hit of revenueTouched)
      expect(
        hit.signedMinor,
        `the ${FX_RESULT_REVENUE_KEY} line this fixture produced must be a real figure, not a zero the carve-out waved through: measured ` +
          `${JSON.stringify(hit)}`,
      ).not.toBe('0');
  });

  it('the overpaid invoice closes exactly, and the payment document accounts for every minor unit it received', async () => {
    requireSubject(missing, CLAIM);
    const read = await derivedRead(ownerPool(), w.shop.businessId, invoiceA.invoiceId);
    expect(
      { paid: read.paidTxnMinor.toString(), outstanding: read.outstandingTxnMinor.toString(), state: read.state },
      `the overpayment settles invoice A in full and NOT beyond it: the surplus became a credit rather than an over-settlement, so outstanding ` +
        `is exactly zero and never negative`,
    ).toEqual({ paid: invoiceA.totalTxnMinor, outstanding: '0', state: 'paid' });
    // Σ allocations + credit created = amount received, in the payment's own
    // currency and in base. This is the clause that makes "the surplus became
    // a credit" a CLOSURE and not just an observation that a credit row exists.
    expect(
      residueMinor.toString(),
      `payment ${paymentId} received ${BigInt(invoiceA.totalTxnMinor) + surplusMinor} ${PAY_CURRENCY}: a positive residue is money that ` +
        `arrived and went nowhere, a negative one is money the document conjured`,
    ).toBe('0');
    expect(residueBaseMinor.toString(), 'and the same identity on the BASE side, where the surplus contributes its carrying base').toBe('0');
  });

  it('the credit is applied onto a LATER invoice — a different document, issued after the credit existed', async () => {
    requireSubject(missing, CLAIM);
    expect(invoiceB.invoiceId, 'the credit is consumed against a DIFFERENT invoice than the one that was overpaid').not.toBe(invoiceA.invoiceId);
    // The applications really exist as rows of the chain of invoice B, and the
    // reader of record really moved: an accepted HTTP status over a document
    // nothing happened to is not a settlement.
    const r = await ownerPool().query<{ n: number; applied: string }>(
      `SELECT count(*)::int AS n, coalesce(sum(invoice_amount_applied_minor), 0)::text AS applied
         FROM customer_credit_applications
        WHERE business_id = $1 AND credit_id = $2 AND invoice_id = $3`,
      [w.shop.businessId, creditId, invoiceB.invoiceId],
    );
    const row = must(r.rows[0], 'the credit applications against the later invoice');
    expect(row.n, `both consumptions landed as customer_credit_applications rows against invoice ${invoiceB.invoiceId}`).toBe(consumptions.length);
    const read = await derivedRead(ownerPool(), w.shop.businessId, invoiceB.invoiceId);
    expect(read.paidTxnMinor.toString(), `and the later invoice's reader of record moved by exactly what the credit applied to it: ${row.applied}`).toBe(
      row.applied,
    );
    expect(read.paidTxnMinor > 0n, 'NO SUBJECT — the later invoice reports nothing paid, so no consumption reached it').toBe(true);
  });

  it('a PARTIAL consumption leaves both halves proportional, against the estate’s own g(r)', () => {
    requireSubject(missing, CLAIM);
    const partial = consumptions.filter((c) => c.remainingAfterMinor > 0n);
    expect(
      partial.length,
      `NO SUBJECT — no recorded consumption left the credit with anything remaining, so "partial consumption" has nothing to be about. The walk: ` +
        `${JSON.stringify(consumptions.map((c) => ({ step: c.n, consumed: c.consumedMinor.toString(), remaining: c.remainingAfterMinor.toString() })))}`,
    ).toBeGreaterThan(0);
    for (const c of partial) {
      // Both halves must have MOVED — a partial consumption that left the
      // currency half alone would satisfy proportionality trivially.
      expect(
        c.remainingAfterMinor.toString(),
        `consumption ${c.n} consumed ${c.consumedMinor} from a remaining of ${c.remainingBeforeMinor}, so the currency half falls by exactly that`,
      ).toBe((c.remainingBeforeMinor - c.consumedMinor).toString());
      // And the base half is the proportional image of the new remaining,
      // computed from the IMMUTABLE original pair — never from the previous
      // step's already-rounded carrying figure.
      expect(
        proportionGap(originalMinor, originalCarryingMinor, c.remainingAfterMinor, c.remainingCarryingAfterMinor).toString(),
        `after consumption ${c.n} the credit's carrying half must be g(${c.remainingAfterMinor}) = ` +
          `${creditRemainingCarrying(originalMinor, originalCarryingMinor, c.remainingAfterMinor)} against the immutable original pair ` +
          `(${originalMinor}, ${originalCarryingMinor}); measured ${c.remainingCarryingAfterMinor}. A carrying half derived from the previous ` +
          `step's rounded figure drifts, which is what [[daftar-a-rounded-quotient-is-never-an-input]] forbids`,
      ).toBe('0');
      expect(c.remainingCarryingAfterMinor > 0n, `and a partially-consumed credit still carries base value: measured ${c.remainingCarryingAfterMinor}`).toBe(
        true,
      );
    }
  });

  it('FULL consumption zeroes BOTH halves exactly', () => {
    requireSubject(missing, CLAIM);
    const last = must(consumptions[consumptions.length - 1], 'the final recorded consumption');
    expect(
      { remaining: last.remainingAfterMinor.toString(), remaining_carrying: last.remainingCarryingAfterMinor.toString() },
      `the last consumption takes everything that was left, so BOTH halves are exactly zero. Exactly: a credit whose amount reached zero while ` +
        `its carrying half kept a residue is a liability the ledger still believes in and no command can ever release`,
    ).toEqual({ remaining: '0', remaining_carrying: '0' });
    // And the consumptions summed to the original: a walk that zeroed the
    // credit while consuming less than it held would have destroyed money.
    const consumed = consumptions.reduce((acc, c) => acc + c.consumedMinor, 0n);
    expect(consumed.toString(), `and the consumptions summed to the credit's whole original ${originalMinor}, never more and never less`).toBe(
      originalMinor.toString(),
    );
  });

  it('that law can say no: the proportion refuses a carrying half that has drifted off its own currency half', () => {
    // The red proof for the clause above, on synthetic figures, because a
    // proportion that has only ever been handed a real measurement is a
    // proportion nobody has watched refuse anything. It needs no subject: it
    // is about the function, not about the database.
    //
    // A 100.00 USD credit carried at 367.00 base (the rate of this file): half
    // of it remaining must carry 183.50, and nothing else.
    const OA = 10_000n;
    const OB = 36_700n;
    expect(proportionGap(OA, OB, 10_000n, 36_700n), 'an untouched credit is proportional at its original pair').toBe(0n);
    expect(proportionGap(OA, OB, 5_000n, 18_350n), 'and half of it at half the carrying base').toBe(0n);
    expect(proportionGap(OA, OB, 0n, 0n), 'and a fully consumed one at zero on both halves').toBe(0n);
    expect(proportionGap(OA, OB, 5_000n, 18_351n), 'a single minor unit of drift upward is refused').not.toBe(0n);
    expect(proportionGap(OA, OB, 5_000n, 18_349n), 'and a single minor unit downward').not.toBe(0n);
    expect(proportionGap(OA, OB, 0n, 1n), 'a credit zeroed in its currency half while its carrying half keeps a residue is refused').not.toBe(0n);
    expect(proportionGap(OA, OB, 5_000n, 5_000n), 'and the degenerate "copy one half into the other", which is what an unconverted credit looks like').not.toBe(
      0n,
    );
  });

  it('the refund-at-carrying-value clause of G-15 is OPEN and is deferred to S5, with no subject on this head', async () => {
    requireSubject(missing, CLAIM);
    // NOT A PASS FOR THE CLAUSE. This case asserts the DEFERRAL ITSELF — that
    // the relation the clause is about genuinely does not exist here — so the
    // gap is measured rather than left to a reader of the prose above to
    // notice, and so the day S5 lands the relation this case turns RED and
    // whoever lands it is told, by a failing golden, that G-15's fifth clause
    // now has a subject and owes an assertion.
    const r = await ownerPool().query<{ relname: string }>(
      `SELECT c.relname::text AS relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('refunds', 'customer_refunds')`,
    );
    expect(
      r.rows.map((x) => x.relname),
      `G-15's "refund at CARRYING value" clause is S5's (G-12, the refund-source law, is S5-owned too) and this file asserts nothing about it. ` +
        `If a refund relation now exists, the clause has a subject and this golden is INCOMPLETE until it is asserted — that is what this red ` +
        `means, and it is the intended signal, not a defect in this file`,
    ).toEqual([]);
  });
});
