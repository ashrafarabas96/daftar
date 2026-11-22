/**
 * SELL ON ACCOUNT, THEN TAKE MONEY, AND READ BOTH OFF THE STATEMENT.
 *
 * This is the merchant's whole receivable loop in one law, driven end to end
 * over HTTP: `POST /v1/sales` commits a credit invoice, `POST
 * /v1/customer-payments` collects part of it, and
 * `GET /v1/customers/:customerId/statement` is asked what the customer owes
 * after each step. No row is written by hand anywhere in it.
 *
 * WHY IT EXISTS SEPARATELY from `l3-statement-http-path.test.ts`: that suite
 * asks whether the statement route answers and whether its running balance is
 * cumulative over entries a FIXTURE planted. This one asks something the other
 * cannot: that a real collection, through the real command, MOVES the balance
 * the merchant reads, and moves it in the right direction by the right amount.
 * A reader can be perfectly cumulative over the wrong set of entries.
 *
 * THE ARMS, one claim each:
 *   §1 after the sale alone, the statement's last running balance IS the
 *      invoice total — the debt as the merchant would read it;
 *   §2 after a PARTIAL collection, a credit entry appears and the last running
 *      balance is total − paid, exactly;
 *   §3 the receipt is a CREDIT entry, not a debit — a receipt recorded on the
 *      wrong side would still keep §2's arithmetic if the sign were flipped
 *      twice, so the side is asserted on its own.
 *
 * WHAT IT DOES NOT CLAIM: nothing about surplus (a payment larger than the
 * invoice), nothing about several invoices, nothing about currency conversion.
 * Those have their own suites, and naming them here is cheaper than letting a
 * reader assume this one covered them.
 *
 * THE FIXTURE MUST DISCRIMINATE BEFORE THE DATABASE IS ASKED: the collection
 * is PARTIAL by construction and asserted to be so. A payment equal to the
 * total would leave a balance of zero, and zero is what a reader that lost the
 * entries entirely would also report.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  collectOnAccount,
  newCustomer,
  sellOnCredit,
  settlementWorld,
  stockUp,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

let w: SettlementWorld;
let customerId: string;
let invoiceId: string;
let totalTxnMinor: string;

const PAID_MINOR = '400';

interface StatementRow {
  readonly entryKind: string;
  readonly debitTxnMinor: string;
  readonly creditTxnMinor: string;
  readonly runningBalanceTxnMinor: string;
}

const statement = async (): Promise<readonly StatementRow[]> => {
  const res = await w.t.request.get(`/v1/customers/${customerId}/statement`).set(w.headers);
  expect(res.status, `the statement answers: ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.rows as readonly StatementRow[];
};

const last = (rows: readonly StatementRow[]): StatementRow => {
  expect(rows.length, 'an empty statement cannot carry a balance').toBeGreaterThan(0);
  return rows[rows.length - 1] as StatementRow;
};

beforeAll(async () => {
  w = await settlementWorld('l3 credit sale and collection in the statement');
  await stockUp(w, '20', '100');
  customerId = await newCustomer(w);
  const invoice = await sellOnCredit(w, customerId, '5');
  invoiceId = invoice.invoiceId;
  totalTxnMinor = invoice.totalTxnMinor;

  // THE DISCRIMINATION, read out of the planted figures before anything is
  // asked of the reader: the collection must be a PART of the debt. If it
  // equalled the total the remaining balance would be zero, which is also what
  // a reader that dropped every entry would report -- so the case would stop
  // telling the two apart.
  expect(BigInt(totalTxnMinor) > BigInt(PAID_MINOR), `the collection must be PARTIAL: total ${totalTxnMinor} vs paid ${PAID_MINOR}`).toBe(true);
  expect(BigInt(PAID_MINOR) > 0n, 'a zero collection moves nothing and proves nothing').toBe(true);
}, 600_000);

describe('a credit sale and a collection, as the statement reports them', () => {
  it('§1 after the sale alone, the last running balance IS the invoice total', async () => {
    const rows = await statement();
    expect(
      last(rows).runningBalanceTxnMinor,
      `the debt after one credit sale is the invoice total ${totalTxnMinor}`,
    ).toBe(totalTxnMinor);
  }, 300_000);

  it('§2 after a PARTIAL collection, the last running balance is total minus paid', async () => {
    const before = (await statement()).length;
    const collected = await collectOnAccount(w, customerId, invoiceId, PAID_MINOR);
    expect(collected.status, 'a first collection is created, not replayed').toBe(201);

    const rows = await statement();
    expect(rows.length, 'the collection must ADD an entry to the statement').toBeGreaterThan(before);
    expect(
      last(rows).runningBalanceTxnMinor,
      `the remaining debt is ${totalTxnMinor} - ${PAID_MINOR}`,
    ).toBe((BigInt(totalTxnMinor) - BigInt(PAID_MINOR)).toString());
  }, 300_000);

  it('§3 the receipt is on the CREDIT side, asserted apart from the arithmetic', async () => {
    const rows = await statement();
    // Named on its own because two sign errors cancel: a receipt booked as a
    // debit with a negated amount would satisfy §2 and still be wrong, and the
    // merchant reads the side, not only the total.
    const receipts = rows.filter((r) => BigInt(r.creditTxnMinor) === BigInt(PAID_MINOR));
    expect(receipts.length, `exactly one entry credits ${PAID_MINOR}; rows: ${JSON.stringify(rows)}`).toBe(1);
    const receipt = receipts[0] as StatementRow;
    expect(BigInt(receipt.debitTxnMinor), 'a receipt debits nothing').toBe(0n);
  }, 300_000);
});
