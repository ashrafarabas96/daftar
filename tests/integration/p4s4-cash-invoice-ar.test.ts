/**
 * P4-S4 — A CASH SALE TO A NAMED CUSTOMER IS NOT A RECEIVABLE.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-05, P4-AL-06, P4-AL-16, P4-AL-24;
 *  `0075_phase4_customers_invoices_numbering.sql:722`, `:760`, `:780`;
 *  `0077_phase4_sales_sale_items_sources.sql:294`, `:1457`.)
 *
 * ── THE STATE THE ESTATE ALREADY ADMITS ───────────────────────────────────
 *
 * A cash-settled sale to a NAMED customer is legal, and deliberately so:
 * `sales_credit_customer_ck` (`0077:294`) is
 *
 *     CHECK (settlement_mode = 'cash' OR customer_id IS NOT NULL)
 *
 * so the customer is OPTIONAL on a cash sale, not forbidden. The merchant who
 * sells to a regular on the counter for cash, and wants the sale on that
 * regular's record, is inside the schema's intent.
 *
 * The JOURNAL knows exactly what such a sale is. `accounting_invoice_entry_complete`
 * takes the balancing side from the sale's stated settlement mode (`0077:1457`):
 *
 *     v_key := CASE v_settle WHEN 'cash' THEN 'cash' ELSE 'accounts_receivable' END
 *
 * — a cash sale debits the `cash` system account DIRECTLY, and no line of the
 * entry touches `accounts_receivable`. The money arrived; nothing is owed.
 *
 * ── AND THE DERIVED READ DOES NOT ─────────────────────────────────────────
 *
 * `invoice_outstanding` (`0075:722`) keys on NOTHING but `invoices.status`:
 * for any `open` invoice it returns `paid = 0, outstanding = total`, whatever
 * settled it. `invoice_settlement_state` (`0075:760`) derives `'unpaid'` from
 * that zero paid, and `customer_ar_outstanding` (`0075:780`) sums every `open`
 * invoice of the customer. So the cash sale above reports a receivable the
 * general ledger does not carry, and the named customer's AR balance is a
 * figure no account of the chart agrees with.
 *
 * The seam comment above `invoice_outstanding` says the routine "subtracts
 * nothing and says so" because in P4-S1 no settlement relation existed. That
 * is the right account of a MISSING SUBTRAHEND. It is not an account of this:
 * a cash sale's settlement is not a missing payment document, it is a debit
 * that is already in the ledger, and the derived read can see it from
 * `sales.settlement_mode` — the same stored input the posting validator
 * already trusts, so reading it introduces no stored derived truth
 * (`[[daftar-no-stored-derived-truth]]`).
 *
 * ── WHAT THIS SUITE ASSERTS, AND WHY IT IS RED ────────────────────────────
 *
 * The CORRECTED contract, as ruled: the derived read must agree with the
 * journal, by REPLACEMENT in `0080`, never by an edit to `0075`.
 *
 *   — a CASH-settled invoice reports `paid = total`, `outstanding = 0`, and
 *     `invoice_settlement_state` = `'paid'`;
 *   — `customer_ar_outstanding` returns NO row for a customer whose only
 *     invoice is cash-settled (its `HAVING sum(...) <> 0` already drops a zero
 *     sum, so this follows from the first and is asserted so a future
 *     implementation cannot satisfy one and not the other);
 *   — the CREDIT control is UNCHANGED: `outstanding = total`, `'unpaid'`, one
 *     AR row. A correction that reported everything paid would be a worse
 *     defect than the one it replaced, so every cash assertion below has its
 *     credit twin.
 *
 * Three cases, in the order a verdict should be reached in:
 *
 *   1. THE JOURNAL SIDE, MEASURED AND NOT ASSUMED. The migration line is read
 *      out of the LIVE ledger: the cash sale's invoice entry is read from
 *      `journal_lines` joined to `accounts`, its debit must be on the `cash`
 *      system account, and NO line of it may be on `accounts_receivable`. The
 *      credit sale's entry must be the exact opposite. Without this the other
 *      two cases would be asserting against a remembered migration rather
 *      than against the ledger that exists.
 *   2. THE DERIVED READ AGREES WITH IT, per invoice and per customer.
 *   3. THE BUSINESS-LEVEL RECONCILIATION, which is the invariant that
 *      actually matters and the one a merchant would discover by hand:
 *
 *          debit balance of `accounts_receivable` from `journal_lines`
 *            ==  Σ customer_ar_outstanding(business, customer).base_minor
 *
 *      over every customer of the business. Both sides are computed IN SQL in
 *      integer minor units — a balance read into a JS number is a float, and
 *      money in this estate is never a float. On this head the two sides
 *      differ by exactly the cash sale's total, which is the defect stated as
 *      a number.
 *
 * Every assertion carries the MEASURED figures in its message, so the failure
 * output is the evidence and not a prompt to go and look.
 *
 * ── THE FIXTURE IS THE REAL COMMAND, AND THE SUBJECT IS CHECKED ───────────
 *
 * The only sanctioned producer of a committed sale is `sale_commit` behind
 * `POST /v1/sales`, so the sale arrives through `confirmSale` exactly as the
 * other P4-S2 suites' sales do. Nothing here hand-builds a sale, an invoice, a
 * journal line or a stock row: a law proved against hand-built rows is a law
 * about the fixture. `requireSubject` is the canary — a claim whose subject is
 * absent must be RED, never a vacuous green, and `.skip` is refused across
 * Phase 4.
 *
 * Not named `phase4-*` or `p4-*`: `suiteProblems` (`scripts/phase4-s1-gate.ts:757`)
 * fails any such suite in `tests/integration` that no `S1_SUITES` entry lists.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { must, requireSubject, saleSubject, type SaleSubject } from '../golden-regression/phase4-s2/harness';
import { confirmSale, seedSaleFixtures } from '../golden-regression/phase4-s2/sale-path';

const CLAIM = 'a cash-settled invoice to a named customer reports no receivable, and the derived AR read equals the AR account';

/** What the sale, its invoice and its invoice entry actually are, read back from the live state. */
interface CommittedSale {
  readonly saleId: string;
  readonly invoiceId: string;
  readonly entryId: string;
  /** `sales.settlement_mode`, read back rather than assumed from the request. */
  readonly settlementMode: string;
  /** `sales.customer_id`, read back: the whole premise is that it is NOT null on the cash sale. */
  readonly saleCustomerId: string | null;
  readonly invoiceStatus: string;
  readonly totalTxnMinor: string;
  readonly totalBaseMinor: string;
  readonly currencyCode: string;
}

/** One line of a journal entry, by the account's SYSTEM KEY — never by a typed account code. */
interface EntryLine {
  readonly system_key: string | null;
  readonly debit_minor: string;
  readonly credit_minor: string;
}

/** The four figures of the derived reader, plus the state derived from them. */
interface DerivedRead {
  readonly paid_txn_minor: string;
  readonly paid_base_minor: string;
  readonly outstanding_txn_minor: string;
  readonly outstanding_base_minor: string;
  readonly state: string;
}

describe('P4-S4 a cash sale to a named customer is not a receivable', () => {
  let t: TestApp;
  let day: string;
  let owner: HttpActor;
  let A: S3Business;
  let subject: SaleSubject;
  /** The customer whose ONLY invoice is cash-settled. */
  let cashCustomerId: string;
  /** The control: the customer whose only invoice is credit-settled. */
  let creditCustomerId: string;
  let cash: CommittedSale;
  let credit: CommittedSale;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    day = await today();
    t = await createTestApp();
    owner = await registerActor(t, 'cash invoice ar owner');
    A = await onboardS3Business(t, owner, 's4cashar');
    // Two customers, so `customer_ar_outstanding` is asked a question about a
    // cash-only customer and a credit-only customer SEPARATELY. One customer
    // carrying both invoices would let a wrong implementation pass case 2 by
    // arithmetic coincidence.
    ({ customerId: cashCustomerId } = await seedSaleFixtures(ownerPool(), A, day));
    ({ customerId: creditCustomerId } = await seedSaleFixtures(ownerPool(), A, day));
    subject = await saleSubject(ownerPool());
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await resetData();
  });

  /** Bring priced stock in through the real adjustment command, so the sale has goods that carry value. */
  async function stockUp(quantity: string, unitCost: string): Promise<Response> {
    return t.request
      .post('/v1/inventory/adjustments')
      .set(asMember(owner, A.businessId))
      .send({
        adjustmentId: randomUUID(),
        warehouseId: A.w1,
        occurredOn: day,
        reason: 'p4s4 cash-vs-credit AR fixture',
        lines: [{ productId: A.piece.productId, quantity, unitCost }],
      });
  }

  /**
   * One sale through the real command, and everything about it read back.
   *
   * `settlement` is not sent as a word: `confirmSale` translates the PRESENCE
   * of `payment` into `settlementMode: 'cash'` (`sale-path.ts:133`), which is
   * the one place this estate's request shape is written down. A cash sale
   * with a named customer is therefore expressible without touching that
   * adapter — which is exactly what `sales_credit_customer_ck` permits.
   */
  async function sell(settlement: 'cash' | 'credit', customerId: string, quantity: string): Promise<CommittedSale> {
    const res = await confirmSale(t, asMember(owner, A.businessId), {
      saleId: randomUUID(),
      customerId,
      warehouseId: A.w1,
      branchId: A.branchX,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity }],
      ...(settlement === 'cash' ? { payment: { paymentMethodId: randomUUID() } } : {}),
    });
    expect(res.status, `the ${settlement} sale to a named customer commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    const saleId = String((res.body as { saleId?: unknown }).saleId);

    const r = await ownerPool().query<{
      settlement_mode: string;
      sale_customer_id: string | null;
      invoice_id: string;
      invoice_status: string;
      total_txn_minor: string;
      total_base_minor: string;
      currency_code: string;
      entry_id: string | null;
    }>(
      `SELECT s.settlement_mode,
              s.customer_id::text          AS sale_customer_id,
              i.id::text                   AS invoice_id,
              i.status                     AS invoice_status,
              i.total_txn_minor::text      AS total_txn_minor,
              i.total_base_minor::text     AS total_base_minor,
              i.currency_code::text        AS currency_code,
              (SELECT je.id::text FROM journal_entries je
                WHERE je.business_id = i.business_id AND je.source_type = 'invoice' AND je.source_id = i.id) AS entry_id
         FROM sales s
         JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id
        WHERE s.business_id = $1 AND s.id = $2`,
      [A.businessId, saleId],
    );
    const row = must(r.rows[0], `the committed ${settlement} sale ${saleId} and its invoice`);
    // The premise, read back from the stored row rather than taken from the
    // request: a suite that ASSUMED the mode would still pass if the command
    // had quietly downgraded the sale to the other arm, and then every verdict
    // below would be about the wrong document.
    expect(row.settlement_mode, `the ${settlement} sale really stored settlement_mode = '${settlement}'`).toBe(settlement);
    expect(row.sale_customer_id, `and it really names the customer — a cash sale with a NAMED customer is the whole subject (0077:294)`).toBe(customerId);
    expect(row.invoice_status, `and its invoice is 'open', which is the only status invoice_outstanding reads (0075:722)`).toBe('open');
    expect(row.entry_id, `and its revenue entry exists, or case 1 has no lines to measure`).not.toBeNull();
    return {
      saleId,
      invoiceId: row.invoice_id,
      entryId: must(row.entry_id, 'invoice entry id'),
      settlementMode: row.settlement_mode,
      saleCustomerId: row.sale_customer_id,
      invoiceStatus: row.invoice_status,
      totalTxnMinor: row.total_txn_minor,
      totalBaseMinor: row.total_base_minor,
      currencyCode: row.currency_code,
    };
  }

  /** The lines of one journal entry, by system key, as text so no float touches money. */
  async function entryLines(entryId: string): Promise<readonly EntryLine[]> {
    const r = await ownerPool().query<EntryLine>(
      `SELECT a.system_key::text AS system_key, l.debit_minor::text AS debit_minor, l.credit_minor::text AS credit_minor
         FROM journal_lines l
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2
        ORDER BY a.system_key`,
      [A.businessId, entryId],
    );
    return r.rows;
  }

  /** The derived reader-of-record's four figures and the state derived from them. */
  async function derivedRead(invoiceId: string): Promise<DerivedRead> {
    const r = await ownerPool().query<DerivedRead>(
      `SELECT o.paid_txn_minor::text        AS paid_txn_minor,
              o.paid_base_minor::text       AS paid_base_minor,
              o.outstanding_txn_minor::text AS outstanding_txn_minor,
              o.outstanding_base_minor::text AS outstanding_base_minor,
              invoice_settlement_state($1, $2) AS state
         FROM invoice_outstanding($1, $2) o`,
      [A.businessId, invoiceId],
    );
    return must(r.rows[0], `invoice_outstanding for ${invoiceId}`);
  }

  /** Every row `customer_ar_outstanding` reports for one customer, in integer minor units. */
  async function arRows(customerId: string): Promise<readonly { currency_code: string; txn_minor: string; base_minor: string }[]> {
    const r = await ownerPool().query<{ currency_code: string; txn_minor: string; base_minor: string }>(
      `SELECT o.currency_code, o.txn_minor::text AS txn_minor, o.base_minor::text AS base_minor FROM customer_ar_outstanding($1, $2) o`,
      [A.businessId, customerId],
    );
    return r.rows;
  }

  it('the subject exists: the sale commit routine, the sale relations and the source-type registry rows are in the tree', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('the fixture commits one CASH sale and one CREDIT sale, both to a NAMED customer, through the real command', async () => {
    requireSubject(subject.missing, CLAIM);
    const inbound = await stockUp('10', '5');
    expect(inbound.status, 'the priced inbound adjustment is accepted, or neither sale has goods that carry value').toBe(201);

    cash = await sell('cash', cashCustomerId, '2');
    credit = await sell('credit', creditCustomerId, '3');

    // Non-vacuity: a zero-valued invoice would make every figure below 0, and
    // `0 == 0` would hold on both the correct and the broken reading.
    for (const s of [cash, credit] as const) {
      expect(
        BigInt(s.totalBaseMinor) > 0n,
        `NO SUBJECT — the ${s.settlementMode} invoice totals ${s.totalBaseMinor} base minor units, so every assertion below would compare 0 with 0`,
      ).toBe(true);
    }
  });

  // ── 1. the journal side, measured out of the ledger and not assumed ──────

  it('CASH: the invoice entry debits the `cash` system account, and NO line of it is on accounts_receivable', async () => {
    requireSubject(subject.missing, CLAIM);
    const lines = await entryLines(cash.entryId);
    const shown = JSON.stringify(lines);
    expect(lines.length, `NO SUBJECT — the cash sale's invoice entry ${cash.entryId} has no lines: ${shown}`).toBeGreaterThan(0);

    const debits = lines.filter((l) => BigInt(l.debit_minor) !== 0n);
    expect(
      debits.map((l) => l.system_key),
      `the cash sale's settlement debit is the \`cash\` account (0077:1457), measured: ${shown}`,
    ).toEqual(['cash']);
    expect(
      must(debits[0], 'the cash debit line').debit_minor,
      `and it is the invoice total ${cash.totalBaseMinor} in base minor units, measured: ${shown}`,
    ).toBe(cash.totalBaseMinor);
    expect(
      lines.filter((l) => l.system_key === 'accounts_receivable').length,
      `and NOTHING in this entry is on accounts_receivable — the money arrived, so nothing is owed. Measured: ${shown}`,
    ).toBe(0);
  });

  it('CREDIT: the invoice entry debits accounts_receivable, and NO line of it is on `cash`', async () => {
    requireSubject(subject.missing, CLAIM);
    const lines = await entryLines(credit.entryId);
    const shown = JSON.stringify(lines);
    expect(lines.length, `NO SUBJECT — the credit sale's invoice entry ${credit.entryId} has no lines: ${shown}`).toBeGreaterThan(0);

    const debits = lines.filter((l) => BigInt(l.debit_minor) !== 0n);
    expect(
      debits.map((l) => l.system_key),
      `the credit sale's settlement debit is accounts_receivable (0077:1457), measured: ${shown}`,
    ).toEqual(['accounts_receivable']);
    expect(
      must(debits[0], 'the AR debit line').debit_minor,
      `and it is the invoice total ${credit.totalBaseMinor} in base minor units, measured: ${shown}`,
    ).toBe(credit.totalBaseMinor);
    expect(lines.filter((l) => l.system_key === 'cash').length, `and nothing in this entry is on \`cash\` — no money arrived. Measured: ${shown}`).toBe(0);
  });

  // ── 2. the derived read agrees with the journal ──────────────────────────

  it('CASH: invoice_outstanding reports the invoice fully paid, invoice_settlement_state says `paid`, and the customer has no AR row', async () => {
    requireSubject(subject.missing, CLAIM);
    const read = await derivedRead(cash.invoiceId);
    const rows = await arRows(cashCustomerId);
    expect(
      read,
      `the CASH invoice's derived read must agree with its own journal entry, which debited \`cash\` and not accounts_receivable: ` +
        `measured ${JSON.stringify(read)} against an invoice of ${cash.totalTxnMinor} txn / ${cash.totalBaseMinor} base minor units. ` +
        `invoice_outstanding (0075:722) keys only on invoices.status, so it reports the full total outstanding for a sale that was ` +
        `settled at the counter — a receivable the general ledger does not carry. Corrected by 0080, never by an edit to 0075.`,
    ).toEqual({
      paid_txn_minor: cash.totalTxnMinor,
      paid_base_minor: cash.totalBaseMinor,
      outstanding_txn_minor: '0',
      outstanding_base_minor: '0',
      state: 'paid',
    });
    expect(
      rows,
      `and customer_ar_outstanding must return NO row for a customer whose only invoice is cash-settled — its HAVING sum(...) <> 0 ` +
        `(0075:780) already drops a zero sum, so this follows the moment the figures above are right. Measured: ${JSON.stringify(rows)}`,
    ).toEqual([]);
  });

  it('CREDIT: the control is unchanged — the full total outstanding, `unpaid`, and exactly one AR row', async () => {
    requireSubject(subject.missing, CLAIM);
    const read = await derivedRead(credit.invoiceId);
    const rows = await arRows(creditCustomerId);
    expect(
      read,
      `the CREDIT invoice is still owed in full: a correction that reported every invoice paid would be a worse defect than the one ` +
        `it replaced. Measured ${JSON.stringify(read)} against an invoice of ${credit.totalTxnMinor} txn / ${credit.totalBaseMinor} base minor units.`,
    ).toEqual({
      paid_txn_minor: '0',
      paid_base_minor: '0',
      outstanding_txn_minor: credit.totalTxnMinor,
      outstanding_base_minor: credit.totalBaseMinor,
      state: 'unpaid',
    });
    expect(rows, `and the credit customer DOES carry a receivable, measured: ${JSON.stringify(rows)}`).toEqual([
      { currency_code: credit.currencyCode, txn_minor: credit.totalTxnMinor, base_minor: credit.totalBaseMinor },
    ]);
  });

  // ── 3. the business-level reconciliation ────────────────────────────────

  it('the accounts_receivable balance in the journal equals the sum of customer_ar_outstanding over every customer', async () => {
    requireSubject(subject.missing, CLAIM);
    // Both sides in SQL, in integer minor units. A balance read into a JS
    // number is a float, and money in this estate is never a float
    // (`[[daftar-a-rounded-quotient-is-never-an-input]]`). The AR account is
    // found by its SYSTEM KEY, never by a typed code: a code typed into a test
    // is a second copy of the chart.
    const r = await ownerPool().query<{ gl_ar: string; derived_ar: string; ar_lines: number; customers: number; breakdown: string }>(
      `SELECT (SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text
                 FROM journal_lines l
                 JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
                WHERE l.business_id = $1 AND a.system_key = 'accounts_receivable')              AS gl_ar,
              (SELECT coalesce(sum(o.base_minor), 0)::text
                 FROM customers c
                 JOIN LATERAL customer_ar_outstanding(c.business_id, c.id) o ON TRUE
                WHERE c.business_id = $1)                                                        AS derived_ar,
              (SELECT count(*)::int
                 FROM journal_lines l
                 JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
                WHERE l.business_id = $1 AND a.system_key = 'accounts_receivable')              AS ar_lines,
              (SELECT count(*)::int FROM customers c WHERE c.business_id = $1)                   AS customers,
              (SELECT coalesce(string_agg(x.line, '; ' ORDER BY x.line), '(none)')
                 FROM (SELECT c.name || ' (' || c.id::text || ') owes ' || o.base_minor::text || ' ' || o.currency_code AS line
                         FROM customers c
                         JOIN LATERAL customer_ar_outstanding(c.business_id, c.id) o ON TRUE
                        WHERE c.business_id = $1) x)                                             AS breakdown`,
      [A.businessId],
    );
    const m = must(r.rows[0], 'the reconciliation');

    // Non-vacuity, twice. With no AR line and no customer the identity is
    // `0 == 0` and proves nothing — and the credit control guarantees both.
    expect(
      m.ar_lines,
      `NO SUBJECT — the business carries no accounts_receivable journal line, so this identity holds at zero and proves nothing`,
    ).toBeGreaterThan(0);
    expect(m.customers, 'NO SUBJECT — the business has no customer, so the derived side is a sum over nothing').toBeGreaterThan(0);

    expect(
      m.derived_ar,
      `THE RECONCILIATION A MERCHANT WOULD DO BY HAND: the debit balance of the accounts_receivable account is ${m.gl_ar} base minor ` +
        `units across ${m.ar_lines} journal line(s), while Σ customer_ar_outstanding(...).base_minor over the ${m.customers} customer(s) ` +
        `of the business is ${m.derived_ar} (${m.breakdown}; the cash customer is ${cashCustomerId}, the credit customer is ` +
        `${creditCustomerId}). The difference is ` +
        `${(BigInt(m.derived_ar) - BigInt(m.gl_ar)).toString()}, which is exactly the cash sale's invoice total ${cash.totalBaseMinor}: ` +
        `the cash sale debited \`cash\` (0077:1457) and the derived read counted it as a receivable anyway because ` +
        `invoice_outstanding (0075:722) looks only at invoices.status. The customer ledger and the general ledger cannot both be the ` +
        `truth, and P4-AL-05 makes the journal the one that is.`,
    ).toBe(m.gl_ar);
  });
});
