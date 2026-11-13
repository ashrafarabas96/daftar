/**
 * L3 / P4-S1 — THE CUSTOMER ACCOUNT STATEMENT CONTRACT (migration `0092`,
 * owner permit DR-146, `P4-AL-07`).
 *
 * This is the wire shape of `GET /v1/customers/:customerId/statement`, and it
 * is a FAITHFUL projection of the reader `customer_account_statement(uuid,
 * uuid)` — one DTO field per returned column, renamed to camelCase and
 * nothing else. There is no field here the reader does not return, no total
 * the client is expected to add up, and no figure the API computed.
 *
 * ── EVERY AMOUNT IS A STRING OF MINOR UNITS ──────────────────────────────
 *
 * Including `runningBalanceTxnMinor`. The reader's columns are `BIGINT`, whose
 * range is ±9.22·10^18, and a JSON number is an IEEE double exact only to
 * 2^53 ≈ 9.01·10^15 — three orders of magnitude short. A balance in a minor
 * unit of 100 reaches 2^53 at about 90 trillion major units, which a currency
 * like LBP passes inside one real business. The loss would happen in
 * `JSON.parse`, BEFORE any client code could notice, so the figure is a
 * string and the client is expected to read it with `BigInt`.
 *
 * ── THE SIGN IS PART OF THE CONTRACT ─────────────────────────────────────
 *
 * `runningBalanceTxnMinor` is the cumulative `debit − credit` over the whole
 * ordered set, per currency. Therefore:
 *
 *   * a POSITIVE value is a debt the customer owes;
 *   * a NEGATIVE value is a customer in credit — a FACT, never an error, and
 *     never to be clamped at zero or rendered as its absolute value;
 *   * `'0'` on a currency that carries no debit is likewise a fact.
 *
 * ── THE PAGE DOES NOT DECIDE THE BALANCE ─────────────────────────────────
 *
 * THE RUNNING BALANCE IS ABSOLUTE, NOT RELATIVE TO THE PAGE: the window is
 * computed INSIDE the function over the WHOLE set, and the paging filter is
 * applied OUTSIDE it.
 *
 * The window is partitioned by `currencyCode`. The page a client asked for
 * therefore cannot change the value printed on a row: `items[i]` carries the
 * same `runningBalanceTxnMinor` whether it arrived on a page of 1 or a page
 * of 50. A client must NOT re-sum the page to derive a balance — that would
 * be a second definition of the balance, which is what `P4-AL-07` refuses.
 *
 * `nextCursor` is an OPAQUE keyset cursor, never an offset. A client passes it
 * back verbatim or not at all; it must not construct, parse or edit one, and
 * a cursor the server did not issue is REFUSED rather than ignored.
 */

/**
 * The five kinds of entry the statement carries, in the order their
 * `kindRank` puts them on a shared date.
 *
 * Only `invoice` carries a debit, and only the two application kinds carry a
 * credit. `payment` and `credit` are STATED rows with NEITHER side: the money
 * becomes visible once it is applied and never twice, and a held credit is
 * never netted against the receivable (DR-114).
 */
export type CustomerStatementEntryKindDto = 'invoice' | 'payment' | 'payment_allocation' | 'credit' | 'credit_application';

/** One row of the statement, as the reader returned it. */
export interface CustomerStatementEntryDto {
  entryKind: CustomerStatementEntryKindDto;
  /** The id of the underlying document, allocation, credit or application. */
  entryId: string;
  /** Civil date `YYYY-MM-DD` in the business's own calendar. Never a timestamp. */
  entryDate: string;
  /** The tie-break rank within a date: 1 invoice, 2 payment, 3 allocation, 4 credit, 5 application. */
  kindRank: number;
  /** The document number of the invoice this row is about, or `null` where there is none. */
  documentNumber: string | null;
  /** The invoice an application settles, or the payment a credit came from. */
  relatedId: string | null;
  /** The currency this row — and its running balance partition — is in. */
  currencyCode: string;
  /** Minor units. Non-null on `invoice` only. */
  debitTxnMinor: string | null;
  /** Minor units. Non-null on `payment_allocation` and `credit_application` only. */
  creditTxnMinor: string | null;
  /** The row's own stated amount in its currency, where it has one. */
  amountTxnMinor: string | null;
  /** The same amount in the business's base currency, as it was posted. */
  amountBaseMinor: string | null;
  /** The held credit as issued. Non-null on `credit` only. */
  creditOriginalTxnMinor: string | null;
  /** The held credit still unapplied — the STORED column, never recomputed. */
  creditRemainingTxnMinor: string | null;
  creditRemainingBaseMinor: string | null;
  /** The payment reference the merchant typed, where there is one. */
  reference: string | null;
  /**
   * The cumulative `debit − credit` through this row, within this row's
   * CURRENCY. Signed. Never null. Never affected by the page size.
   */
  runningBalanceTxnMinor: string;
}

/**
 * The balance each currency stood at IMMEDIATELY BEFORE this page began.
 *
 * It is what makes a MIDDLE page verifiable on its own. Given a page that
 * starts in the middle of a customer's history, a reader can check the
 * arithmetic without fetching anything else:
 *
 *     items[0].runningBalanceTxnMinor
 *       === opening(items[0].currencyCode) + debitTxnMinor − creditTxnMinor
 *
 * and on the FIRST page every entry here is `'0'`, which is why the field is
 * mandatory rather than present only when a cursor was supplied.
 *
 * It is READ FROM THE FUNCTION — the running balance of the last row at or
 * before the cursor, per currency — and never summed by the API. There is
 * deliberately NO closing-balance field: that figure is the last row's
 * `runningBalanceTxnMinor`, and a money figure stated in two places is a
 * money figure that can disagree with itself.
 */
export interface CustomerStatementOpeningBalanceDto {
  currencyCode: string;
  /** Minor units, signed. `'0'` on the first page. */
  txnMinor: string;
}

/** `GET /v1/customers/:customerId/statement` — requires `receivables.view`. */
export interface CustomerStatementDto {
  customerId: string;
  /**
   * FLAT and multi-currency: one array for every currency, each row carrying
   * its own `currencyCode`, because the function's window is already
   * partitioned by currency. There is no per-currency nesting to keep in
   * step with it.
   */
  items: CustomerStatementEntryDto[];
  /** One entry per currency appearing in `items`. `'0'` throughout on the first page. */
  openingBalanceByCurrency: CustomerStatementOpeningBalanceDto[];
  /** Opaque keyset cursor, or `null` on the last page. Never an offset. */
  nextCursor: string | null;
}
