/**
 * P4-S4 — THE MONEY CLOSURE OF A CUSTOMER PAYMENT.
 * (P4-S4 BUILD CONTRACT OQ-4 and OQ-9; implementation map §8.1 Departure 1,
 *  §8.3; `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-05, P4-AL-16, P4-AL-25.)
 *
 * ── THE ONE CLOSURE THE DOCUMENT GENUINELY OWES ───────────────────────────
 *
 *     Σ payment_amount_minor + credit created = amount_minor      (payment currency)
 *     Σ payment_base_amount_minor + credit carrying base = base_amount_minor   (base)
 *
 * in integer minor units, with `allocation_count >= 0`.
 *
 * IN THE PAYMENT'S CURRENCY, with the base identity alongside it. The
 * contract's OQ-4 wording said `Σ invoice_amount_applied`, and the coordinator
 * has corrected it: `invoice_amount_applied_minor` is denominated in the
 * INVOICE's currency while `amount_minor` is in the payment's, so the one
 * cannot be subtracted from the other — a "closure" over two different units
 * holds only when they happen to coincide, which in a single-currency fixture
 * they always do. The accepted law is `0067:950-955`. The base identity counts
 * the surplus credit's `original_carrying_base_amount_minor`, or a pure
 * on-account collection has no base side at all.
 *
 * The invoice-side figure is read too, and it is the subject of the CHAIN law
 * (`tests/integration/p4s4-invoice-settlement-chain.test.ts`), which lives on
 * the invoice and is therefore in the invoice's units — never of this one.
 *
 * It is NOT `payment.amount == the paid amount of an invoice`. The supplier
 * precedent forces a payment to be fully allocated — `supplier_payment_complete()`
 * requires `count = allocation_count >= 1` and `Σ payment_amount = amount_minor`
 * (`0067:938-960`) — and this slice deliberately departs: a merchant who takes
 * 500 against a 300 invoice has taken 500, and the surplus is a LIABILITY to
 * the customer, not revenue and not a smaller payment. So the money received
 * is a document fact and the closure is over where that money WENT: onto
 * invoices, or into a credit.
 *
 * ── MEASURED TWICE, AND THE SECOND TIME OUT OF THE LEDGER ─────────────────
 *
 * The closure is read out of the ROWS, and the same movement is read out of
 * `journal_lines ⋈ accounts` BY `system_key` — never by a typed account code,
 * because a code typed into a test is a second copy of the chart and the day
 * the chart moves the test agrees with the copy instead of with the estate.
 * Two independently-derived sides are each other's completeness proof: a
 * closure that held in the rows while the ledger disagreed would be the
 * "customer ledger and general ledger cannot both be the truth" defect
 * P4-AL-05 exists to forbid.
 *
 * Every figure is summed IN SQL and carried as text into `BigInt`. A money
 * figure read into a JS number is a float, and money in this estate is never a
 * float.
 *
 * ── WHAT THIS FILE SETTLES ────────────────────────────────────────────────
 *
 *   1. a payment allocated in full across TWO invoices closes exactly, and the
 *      receivable the ledger carries falls by exactly the applied total;
 *   2. an OVERPAYMENT closes with a credit: the surplus becomes a
 *      `customer_credits` row and posts to the EXISTING system account
 *      `customer_credit_liability` (`2210`, contract OQ-9) — and NOT to any
 *      revenue account, which is the whole of GOLD-68;
 *   3. a payment with ZERO allocations is LAWFUL: money on account, the whole
 *      amount becoming a credit, `allocation_count = 0`, no receivable moved;
 *   4. the closure can say NO — the law is exercised against synthetic figures
 *      so it is an identity somebody has watched refuse something.
 *
 * ── THIS FILE IS RED UNTIL `0081` LANDS, AND THAT IS CORRECT ──────────────
 *
 * Every `it` below begins by requiring its subject. While the four relations,
 * their columns, the two commands, the two chain verifiers, the two source
 * types, the two operation kinds, the reader-of-record seam and the two routes
 * do not exist, the claim "the money closes" is neither true nor false — it
 * has no subject — and the canary makes that a RED naming every missing name.
 *
 * It is NOT skipped, marked `todo` or guarded by an `if`. A conditional pass is
 * a `.skip` the gate's SKIP regex cannot see, and a suite that reported green
 * while its subject did not exist is precisely the vacuity defect this estate
 * keeps rediscovering.
 *
 * Not named `phase4-*` or `p4-*`: `suiteProblems` (`scripts/phase4-s1-gate.ts:757`)
 * fails any such suite in `tests/integration` that no `S1_SUITES` entry lists.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import {
  AR_KEY,
  CREDIT_LIABILITY_KEY,
  closureResidue,
  closureResidueBase,
  entryLines,
  entryOfSource,
  invoiceChain,
  ledgerBalance,
  must,
  paymentClosure,
  type PaymentClosure,
} from '../golden-regression/phase4-s4/harness';
import { appliedTotal, collectPayment, CREDIT_SOURCE_TYPE, type AllocationInput, type PaymentInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM = 'a customer payment closes: Σ payment_amount_minor + credit created = amount_minor, in the payment’s currency, with the base identity alongside';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** Scenario 1: fully allocated across two invoices of one customer. */
let full: {
  readonly paymentId: string;
  readonly res: Response;
  readonly invoices: readonly OpenInvoice[];
  readonly arBefore: bigint;
  readonly arAfter: bigint;
};
/** Scenario 2: 300 applied out of a larger amount, the surplus a credit. */
let over: { readonly paymentId: string; readonly creditId: string; readonly res: Response; readonly invoice: OpenInvoice; readonly surplus: bigint };
/** Scenario 3: no allocation at all — money on account. */
let onAccount: {
  readonly paymentId: string;
  readonly creditId: string;
  readonly res: Response;
  readonly amount: bigint;
  readonly arBefore: bigint;
  readonly arAfter: bigint;
};

/** The closure of one payment, read out of the rows after the fact. */
async function closureOf(paymentId: string): Promise<PaymentClosure> {
  return paymentClosure(ownerPool(), w.shop.businessId, paymentId);
}

/** The leg a suite states for an invoice at the START of its chain. */
function wholeInvoiceLeg(inv: OpenInvoice): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: inv.totalTxnMinor,
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4closure');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '5');

  // ── 1. fully allocated across two invoices ────────────────────────────
  const customerA = await newCustomer(w);
  const i1 = await sellOnCredit(w, customerA, '2');
  const i2 = await sellOnCredit(w, customerA, '3');
  const legs = [wholeInvoiceLeg(i1), wholeInvoiceLeg(i2)];
  const arBefore1 = (await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY)).minor;
  const paymentId1 = randomUUID();
  const res1 = await collectPayment(w.t, w.headers, {
    paymentId: paymentId1,
    customerId: customerA,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: appliedTotal(legs).toString(),
    allocations: legs,
  } satisfies PaymentInput);
  full = {
    paymentId: paymentId1,
    res: res1,
    invoices: [i1, i2],
    arBefore: arBefore1,
    arAfter: (await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY)).minor,
  };

  // ── 2. an overpayment: the surplus is a credit, never revenue ─────────
  const customerB = await newCustomer(w);
  const i3 = await sellOnCredit(w, customerB, '2');
  const surplus = 777n;
  const paymentId2 = randomUUID();
  const creditId2 = randomUUID();
  const res2 = await collectPayment(w.t, w.headers, {
    paymentId: paymentId2,
    customerId: customerB,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(i3.totalTxnMinor) + surplus).toString(),
    creditId: creditId2,
    allocations: [wholeInvoiceLeg(i3)],
  } satisfies PaymentInput);
  over = { paymentId: paymentId2, creditId: creditId2, res: res2, invoice: i3, surplus };

  // ── 3. money on account: zero allocations ─────────────────────────────
  const customerC = await newCustomer(w);
  const iC = await sellOnCredit(w, customerC, '1');
  const amount3 = 5000n;
  const arBefore3 = (await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY)).minor;
  const paymentId3 = randomUUID();
  const creditId3 = randomUUID();
  const res3 = await collectPayment(w.t, w.headers, {
    paymentId: paymentId3,
    customerId: customerC,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: amount3.toString(),
    creditId: creditId3,
    allocations: [],
  } satisfies PaymentInput);
  onAccount = {
    paymentId: paymentId3,
    creditId: creditId3,
    res: res3,
    amount: amount3,
    arBefore: arBefore3,
    arAfter: (await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY)).minor,
  };
  // `iC` exists so customer C's receivable is NOT zero while the on-account
  // payment is taken: the law "money on account moves no receivable" is
  // vacuous against a customer who owes nothing.
  expect(BigInt(iC.totalTxnMinor) > 0n, 'the on-account customer owes something, or law 3 moves nothing either way').toBe(true);
}, 300_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 the money closure of a customer payment', () => {
  it('the subject exists: the four relations, their columns, the commands, the verifiers, the registry rows, the seam and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  // ── 1. fully allocated ────────────────────────────────────────────────

  it('a payment allocated in full across two invoices is accepted', () => {
    requireSubject(missing, CLAIM);
    expect(full.res.status, `the collection commits: ${JSON.stringify(full.res.body)}`).toBeLessThan(300);
  });

  it('and it closes exactly, in the PAYMENT’s currency and again in base minor units', async () => {
    requireSubject(missing, CLAIM);
    const c = await closureOf(full.paymentId);
    expect(c.amountMinor > 0n, 'NO SUBJECT — a payment of zero would satisfy the closure at 0 = 0 and prove nothing').toBe(true);
    expect(c.baseAmountMinor > 0n, 'NO SUBJECT — a payment with no base amount would satisfy the base identity at 0 = 0').toBe(true);
    expect(
      closureResidue(c).toString(),
      `THE CLOSURE in the payment's currency (0067:950-955): the payment received ${c.amountMinor} minor units, its ${c.allocationRows} ` +
        `allocation(s) consumed ${c.consumedMinor} of it and it created ${c.creditCreatedMinor} of customer credit. The residue is ` +
        `${closureResidue(c).toString()}, and money that is neither on an invoice nor in a credit is money the document cannot account for.`,
    ).toBe('0');
    expect(
      closureResidueBase(c).toString(),
      `and the BASE identity: ${c.baseAmountMinor} base minor units received, ${c.consumedBaseMinor} consumed by the allocations and ` +
        `${c.creditCreatedBaseMinor} carried into the credit. The payment-currency closure alone would be satisfied by a base figure that ` +
        `agreed with nothing.`,
    ).toBe('0');
    expect(c.creditCreatedMinor.toString(), 'a fully allocated payment creates no credit').toBe('0');
    expect(c.allocationRows, 'two legs were stated, so two allocation rows exist').toBe(2);
    expect(c.allocationCount, 'and `allocation_count` is the number of rows that exist — not a figure the client chose').toBe(c.allocationRows);
  });

  it('and the receivable the LEDGER carries falls by exactly the applied total — measured by system_key, never by a code', async () => {
    requireSubject(missing, CLAIM);
    const c = await closureOf(full.paymentId);
    const ar = await ledgerBalance(ownerPool(), w.shop.businessId, AR_KEY);
    expect(ar.lines, `NO SUBJECT — the business carries no ${AR_KEY} journal line, so this identity holds at zero`).toBeGreaterThan(0);
    // Both invoices were settled from chain position zero for their whole
    // total, so in the business's base currency the base release equals the
    // applied total and the AR account falls by exactly it. The figure is
    // taken from the CHAIN rather than restated, so a discount that makes
    // `B <> T` does not turn this law into a false one.
    const chains = [
      ...(await invoiceChain(ownerPool(), w.shop.businessId, must(full.invoices[0]).invoiceId)),
      ...(await invoiceChain(ownerPool(), w.shop.businessId, must(full.invoices[1]).invoiceId)),
    ];
    const released = chains.reduce((acc, s) => acc + s.releasedBaseMinor, 0n);
    expect(
      (full.arBefore - full.arAfter).toString(),
      `the ${AR_KEY} account stood at ${full.arBefore} base minor units before the collection and ${full.arAfter} after, a fall of ` +
        `${(full.arBefore - full.arAfter).toString()}, while the chain released ${released} and the rows applied ${c.appliedInvoiceMinor} ` +
        `in the invoices' own currency. ` +
        `The customer ledger and the general ledger cannot both be the truth and P4-AL-05 makes the journal the one that is.`,
    ).toBe(released.toString());
  });

  // ── 2. the overpayment ────────────────────────────────────────────────

  it('an overpayment is accepted and closes with the surplus as a customer credit', async () => {
    requireSubject(missing, CLAIM);
    expect(over.res.status, `the overpayment commits: ${JSON.stringify(over.res.body)}`).toBeLessThan(300);
    const c = await closureOf(over.paymentId);
    expect(
      closureResidue(c).toString(),
      `the overpayment received ${c.amountMinor}, its allocation consumed ${c.consumedMinor} and it created ${c.creditCreatedMinor} of credit`,
    ).toBe('0');
    expect(
      closureResidueBase(c).toString(),
      `and on the base side: ${c.baseAmountMinor} received, ${c.consumedBaseMinor} consumed, ${c.creditCreatedBaseMinor} carried into the credit`,
    ).toBe('0');
    expect(
      c.creditCreatedMinor.toString(),
      `the surplus is the credit: ${c.amountMinor} received less ${c.consumedMinor} consumed is ${over.surplus} and nothing else`,
    ).toBe(over.surplus.toString());
  });

  it('the credit is a row of `customer_credits` born from THAT payment, with its remaining pair at the full original', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ id: string; original: string; remaining: string; origin: string; customer: string; currency: string }>(
      `SELECT id::text AS id, original_amount_minor::text AS original, remaining_amount_minor::text AS remaining,
              origin_payment_id::text AS origin, customer_id::text AS customer, currency_code::text AS currency
         FROM customer_credits WHERE business_id = $1 AND origin_payment_id = $2`,
      [w.shop.businessId, over.paymentId],
    );
    expect(r.rows.length, 'exactly one credit is born from one overpayment — a surplus is not divisible into several').toBe(1);
    const row = must(r.rows[0], 'the credit');
    expect(row.original, `its original amount IS the surplus`).toBe(over.surplus.toString());
    expect(row.remaining, 'and nothing has consumed it yet, so the remaining amount is the original').toBe(over.surplus.toString());
    expect(row.currency, 'in the currency the payment was taken in').toBe(over.invoice.currencyCode);
  });

  it('the surplus posts to `customer_credit_liability` and to NO revenue account — a surplus is owed, never earned', async () => {
    requireSubject(missing, CLAIM);
    // SCOPED TO THE ONE `customer_credit` ENTRY OF THIS SCENARIO, found through
    // the binding rather than by guessing an order.
    //
    // It used to be measured with `ledgerBalance`, which sums the WHOLE account
    // across the business — and this business creates TWO credits, scenario 2's
    // `over.surplus` and scenario 3's whole on-account amount, one
    // `customer_credit` entry and one liability line each. So the account
    // carried the sum of both (5777 over 2 lines) and the law appeared to fail
    // while the reducer was right. The claim is about THIS surplus's entry, so
    // that is what it now measures; nothing about the law is weaker — the
    // figure is still the exact signed amount, not a range, an absolute value
    // or a net.
    const creditEntryId = await entryOfSource(ownerPool(), w.shop.businessId, CREDIT_SOURCE_TYPE, over.creditId);
    expect(creditEntryId, `the surplus credit ${over.creditId} has no bound ${CREDIT_SOURCE_TYPE} entry, so this law has no subject`).not.toBeNull();
    const creditEntryLines = await entryLines(ownerPool(), w.shop.businessId, creditEntryId as string);
    const onLiabilityLines = creditEntryLines.filter((l) => l.systemKey === CREDIT_LIABILITY_KEY);
    expect(
      onLiabilityLines.length,
      `NO SUBJECT — entry ${creditEntryId as string} (the ${CREDIT_SOURCE_TYPE} entry of credit ${over.creditId}) posts no line to ` +
        `${CREDIT_LIABILITY_KEY} (2210, already in the closed chart at 0040:57), so this law is asserted over no line at all`,
    ).toBeGreaterThan(0);
    // A liability is a CREDIT balance, so the signed sum is negative by the
    // surplus. Stated as the signed figure rather than as an absolute value:
    // a surplus that landed as a debit would be an asset, and `abs()` would
    // hide it.
    const liabilityMinor = onLiabilityLines.reduce((acc, l) => acc + l.debitMinor - l.creditMinor, 0n);
    expect(
      liabilityMinor.toString(),
      `the ${CREDIT_LIABILITY_KEY} account must carry the surplus ${over.surplus} as a credit balance (contract OQ-9), measured ` +
        `${liabilityMinor} over ${onLiabilityLines.length} line(s) of entry ${creditEntryId as string} — the ${CREDIT_SOURCE_TYPE} entry of ` +
        `credit ${over.creditId}, this scenario's surplus and no other`,
    ).toBe((-over.surplus).toString());

    // And the GOLD-68 half: the surplus is not revenue. Asserted over EVERY
    // revenue account of the business by its TYPE, discovered from the chart,
    // rather than over a list of system keys someone maintained: a surplus
    // posted to a custom revenue account would be just as wrong.
    const rev = await ownerPool().query<{ system_key: string | null; code: string; n: string; entries: string }>(
      `SELECT a.system_key::text AS system_key, a.code, sum(l.credit_minor - l.debit_minor)::text AS n,
              string_agg(DISTINCT e.source_type, ',') AS entries
         FROM journal_lines l
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
        WHERE l.business_id = $1 AND a.type = 'revenue' AND e.source_type = ANY ($2)
        GROUP BY 1, 2`,
      [w.shop.businessId, ['customer_payment_allocation', 'customer_credit_application']],
    );
    expect(
      rev.rows,
      `NO settlement entry may touch a revenue account: revenue is recognised ONCE, by the invoice entry, and a payment that re-credited ` +
        `it would book the same sale twice (P4-AL-16). Measured: ${JSON.stringify(rev.rows)}`,
    ).toEqual([]);
  });

  it('the rounding account (6100) is untouched by the settlement: dust stays on the receivable', async () => {
    requireSubject(missing, CLAIM);
    // Contract OQ-9: allocation dust goes to `accounts_receivable`, the exact
    // mirror of the accepted `accounts_payable` dust line, and the closed
    // `SettlementAccount` set (`packages/inventory/src/supplier-settlement.ts:224-225`)
    // makes a 6100 line unrepresentable in the first place. This asserts it of
    // the LEDGER, so the day someone widens that set the law still speaks.
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM journal_lines l
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
        WHERE l.business_id = $1 AND a.system_key = 'rounding' AND e.source_type = ANY ($2)`,
      [w.shop.businessId, ['customer_payment_allocation', 'customer_credit_application']],
    );
    expect(must(r.rows[0]).n, 'no settlement entry posts to the rounding account; dust is a second line on the receivable itself').toBe(0);
  });

  // ── 3. money on account ───────────────────────────────────────────────

  it('a payment with ZERO allocations is LAWFUL, and `allocation_count` is 0', async () => {
    requireSubject(missing, CLAIM);
    expect(
      onAccount.res.status,
      `a merchant may take money on account before deciding what it settles. The supplier precedent forbids it ` +
        `(\`supplier_payment_complete\` requires count >= 1, 0067:938-960) and this slice departs deliberately (contract OQ-4): ` +
        `${JSON.stringify(onAccount.res.body)}`,
    ).toBeLessThan(300);
    const c = await closureOf(onAccount.paymentId);
    expect(c.allocationRows, 'no allocation row exists').toBe(0);
    expect(c.allocationCount, 'and the stored count says so — `allocation_count >= 0`, not `>= 1`').toBe(0);
    expect(c.consumedMinor.toString(), 'no leg consumed any of the money').toBe('0');
    expect(c.appliedInvoiceMinor.toString(), 'and nothing was applied to any invoice').toBe('0');
  });

  it('and it still closes: the WHOLE amount became a credit', async () => {
    requireSubject(missing, CLAIM);
    const c = await closureOf(onAccount.paymentId);
    expect(closureResidue(c).toString(), `${c.amountMinor} received, ${c.consumedMinor} consumed, ${c.creditCreatedMinor} of credit created`).toBe('0');
    expect(
      closureResidueBase(c).toString(),
      `and the BASE identity holds only because the credit carries it: ${c.baseAmountMinor} base minor units received against ` +
        `${c.creditCreatedBaseMinor} of credit carrying. Without the surplus credit's original_carrying_base_amount_minor a pure ` +
        `on-account collection has no base side at all and could not be inserted.`,
    ).toBe('0');
    expect(c.creditCreatedMinor.toString(), 'the whole amount is on account as a credit, and none of it is unaccounted for').toBe(onAccount.amount.toString());
  });

  it('and it moved NO receivable: money on account settles no invoice', async () => {
    requireSubject(missing, CLAIM);
    expect(
      onAccount.arAfter.toString(),
      `the ${AR_KEY} account stood at ${onAccount.arBefore} before the on-account payment and ${onAccount.arAfter} after. A payment that ` +
        `allocated nothing may not reduce what anyone owes: the money is a liability to the customer until it is applied.`,
    ).toBe(onAccount.arBefore.toString());
    const chain = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [
      w.shop.businessId,
      onAccount.paymentId,
    ]);
    expect(must(chain.rows[0]).n, 'and it sits on nobody’s invoice chain').toBe(0);
  });

  it('its surplus leg has its OWN journal entry, bound to the CREDIT by the credit’s id', async () => {
    requireSubject(missing, CLAIM);
    // The third accounting source type, and it is FORCED rather than
    // convenient. With zero allocations there is no allocation entry for the
    // surplus leg to ride on, and the completeness validator pins an
    // allocation entry's line multiset EXACTLY (map §3.4, `0067:1998-2027`),
    // so the leg cannot be smuggled into one as an extra line either. The
    // credit therefore carries its own entry, addressed by the credit's own id
    // — which is also what makes it reversible on its own in a later slice.
    //
    // Found through the BINDING and never by guessing which entry of the
    // business it is.
    const entry = await entryOfSource(ownerPool(), w.shop.businessId, CREDIT_SOURCE_TYPE, onAccount.creditId);
    expect(
      entry,
      `the credit ${onAccount.creditId} must be bound to a journal entry of source type ${CREDIT_SOURCE_TYPE}. Money that arrived and ` +
        `moved no account is money the ledger does not know about, and with no allocation there is no other entry it could have ridden on.`,
    ).not.toBeNull();
    const lines = await entryLines(ownerPool(), w.shop.businessId, must(entry, 'the credit’s entry'));
    const shown = JSON.stringify(lines.map((l) => ({ key: l.systemKey, account: l.systemKey, d: l.debitMinor.toString(), c: l.creditMinor.toString() })));
    expect(lines.length, `NO SUBJECT — the credit's entry has no line: ${shown}`).toBeGreaterThan(1);
    const balance = lines.reduce((acc, l) => acc + l.debitMinor - l.creditMinor, 0n);
    expect(balance.toString(), `the credit's entry balances in base minor units: ${shown}`).toBe('0');
    expect(
      lines.map((l) => l.systemKey).includes(AR_KEY),
      `it must NOT touch ${AR_KEY}: nothing was applied to an invoice, so nobody owes anybody less than before. Measured: ${shown}`,
    ).toBe(false);
    expect(
      lines.map((l) => l.systemKey),
      `and it credits ${CREDIT_LIABILITY_KEY}`,
    ).toContain(CREDIT_LIABILITY_KEY);
  });

  it('and that entry’s lines are the method’s posting account and the credit liability, and nothing else', async () => {
    requireSubject(missing, CLAIM);
    const entry = must(await entryOfSource(ownerPool(), w.shop.businessId, CREDIT_SOURCE_TYPE, onAccount.creditId), 'the credit’s entry');
    const r = await ownerPool().query<{ account_id: string; system_key: string | null; code: string; signed: string }>(
      `SELECT l.account_id::text AS account_id, a.system_key::text AS system_key, a.code, (l.debit_minor - l.credit_minor)::text AS signed
         FROM journal_lines l
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2`,
      [w.shop.businessId, entry],
    );
    expect(r.rows.length, 'NO SUBJECT — no line on the credit’s entry to judge').toBeGreaterThan(1);
    const shown = JSON.stringify(r.rows.map((x) => ({ key: x.system_key ?? x.code, signed: x.signed })));
    const stray = r.rows.filter((x) => x.account_id !== w.postingAccountId && x.system_key !== CREDIT_LIABILITY_KEY);
    expect(
      stray.map((x) => `${x.system_key ?? x.code} for ${x.signed}`),
      `the surplus leg debits the method's own posting account (${w.postingAccountId}) and credits ${CREDIT_LIABILITY_KEY}, and that is the ` +
        `whole entry: no revenue, no receivable, no rounding, no tax. Measured: ${shown}`,
    ).toEqual([]);
    const onLiability = r.rows.filter((x) => x.system_key === CREDIT_LIABILITY_KEY).reduce((acc, x) => acc + BigInt(x.signed), 0n);
    expect(
      onLiability.toString(),
      `and the liability is credited by the whole amount received, ${onAccount.amount}: a payment on account is owed in full. Measured: ${shown}`,
    ).toBe((-onAccount.amount).toString());
  });

  // ── 4. the law can say no ─────────────────────────────────────────────

  it('that closure can say no: a residue of any sign is refused', () => {
    // The red proof for the identity above, on synthetic figures, because an
    // identity that has only ever been handed a real measurement is an
    // identity nobody has watched refuse anything. No subject is required:
    // this is arithmetic about the law itself, not a claim about the estate.
    expect(closureResidue({ amountMinor: 50000n, consumedMinor: 30000n, creditCreatedMinor: 20000n }).toString(), 'an exact closure').toBe('0');
    expect(closureResidue({ amountMinor: 50000n, consumedMinor: 50000n, creditCreatedMinor: 0n }).toString(), 'fully allocated, no credit').toBe('0');
    expect(closureResidue({ amountMinor: 50000n, consumedMinor: 0n, creditCreatedMinor: 50000n }).toString(), 'money on account').toBe('0');
    expect(closureResidue({ amountMinor: 50000n, consumedMinor: 30000n, creditCreatedMinor: 19999n }).toString(), 'one minor unit unaccounted for').toBe('1');
    expect(closureResidue({ amountMinor: 50000n, consumedMinor: 30000n, creditCreatedMinor: 20001n }).toString(), 'one minor unit conjured').toBe('-1');
    // And the base identity refuses independently: a surplus whose carrying
    // base is omitted is exactly the on-account collection that could not be
    // inserted at all.
    expect(closureResidueBase({ baseAmountMinor: 50000n, consumedBaseMinor: 0n, creditCreatedBaseMinor: 50000n }).toString(), 'on account, base side').toBe(
      '0',
    );
    expect(
      closureResidueBase({ baseAmountMinor: 50000n, consumedBaseMinor: 0n, creditCreatedBaseMinor: 0n }).toString(),
      'a surplus with no carrying base leaves the whole base amount unaccounted for',
    ).toBe('50000');
  });

  it('every allocation of this file sits on the invoice it names, and on no other', async () => {
    requireSubject(missing, CLAIM);
    // The cheapest completeness check there is, and it is the one that catches
    // a command that wrote the right totals onto the wrong document. Counted
    // WITH a `business_id` predicate: a count over the whole cluster is a
    // number that belongs to nobody's scenario.
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_allocations a
        WHERE a.business_id = $1
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.business_id = a.business_id AND i.id = a.invoice_id AND i.customer_id = a.customer_id)`,
      [w.shop.businessId],
    );
    const total = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_allocations WHERE business_id = $1`, [w.shop.businessId]);
    expect(must(total.rows[0]).n, 'NO SUBJECT — this business has no allocation, so the law is quantified over nothing').toBeGreaterThan(0);
    expect(must(r.rows[0]).n, 'no allocation of this business names an invoice whose customer is not its own').toBe(0);
  });
});
