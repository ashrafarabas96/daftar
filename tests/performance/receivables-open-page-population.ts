/**
 * THE POPULATION, THE ORACLE AND THE TWO NEGATIVE CONTROLS FOR THE
 * OPEN-INVOICE PAGE READER (`customer_open_invoices_page`, migration `0084`;
 * P4-S4-0084-CONTRACT §8, §10, §11, §13).
 *
 * ── WHAT THIS MODULE IS FOR ────────────────────────────────────────────────
 *
 * `0084` replaces `CustomerReads.openInvoices`'s read. The old read filtered
 * on the FUNCTION'S OUTPUT (`AND o.outstanding_txn_minor <> 0` over a per-row
 * `JOIN LATERAL invoice_outstanding(i.business_id, i.id)`), so `LIMIT` could
 * not short-circuit: 1 551 `LATERAL` loops to return 51 rows, 991.792 ms
 * against a 100 ms ceiling. The replacement is a bounded chunked keyset loop
 * with a `settlement_mode <> 'cash'` ELIGIBILITY pre-filter.
 *
 * Two of those three words are claims about SPEED and the budgets own them.
 * The claims this module exists to settle are the ones about the ANSWER, and
 * they are the ones that matter more, because the subject is a receivable:
 *
 *   1. §11 RESULT EQUIVALENCE. The OLD semantics are preserved here, as
 *      test-only SQL (`ORACLE_SQL`), in the per-row `JOIN LATERAL` shape they
 *      have today at `apps/api/src/modules/selling/customer-reads.ts:300`.
 *      The oracle and the new reader must agree EXACTLY — the invoice ids, the
 *      paid figures, the outstanding figures, the currency, the due date, the
 *      ORDER, and the pagination boundary. Element by element, not as sets.
 *
 *   2. §8 CASH ELIGIBILITY IS NOT A SECOND BALANCE. The new reader excludes
 *      cash-settled candidates by a TABLE predicate, before any settlement
 *      call. That is legitimate only if the returned result set is exactly
 *      what the CANONICAL definition returns with no such predicate
 *      (`CANONICAL_SQL`). The population therefore carries the rows that
 *      would catch the claim if it were wrong: cash-settled invoices that
 *      every other column makes look outstanding.
 *
 *   3. §13 A FAKE `LIMIT` FIX IS CAUGHT. `FAKE_LIMIT_SQL` is the wrong fix
 *      written out in full — take the first `p_limit` candidate rows, THEN
 *      drop the zero-outstanding ones. On the `fakeLimit` population it
 *      returns about ten rows while 89 invoices are genuinely outstanding.
 *      The suite asserts that short page from the fake AND a full page of 51
 *      from the reader, so the §13 test is demonstrably red-capable rather
 *      than merely green.
 *
 * ── WHY THE ROWS ARE WRITTEN DIRECTLY ──────────────────────────────────────
 *
 * The question is whether TWO READINGS OF THE SAME ROWS AGREE, and some of
 * the rows that settle it are rows the writers REFUSE — a cash-settled
 * invoice carrying a payment allocation is `0080`'s own forbidden shape and
 * is exactly the case §8 turns on. So the population is written directly,
 * with the guards and referential triggers out of the way FOR THE LENGTH OF
 * ONE TRANSACTION THAT IS ALWAYS ROLLED BACK, on a scratch database of this
 * suite's own. Every CHECK constraint still holds on every row —
 * `DISABLE TRIGGER ALL` does not reach them — and every carrying-released
 * figure is computed by the product's own `supplier_ap_release` (`0067:683`)
 * inside the INSERT, never by a second copy of that arithmetic here
 * (P4-AL-07, R-81).
 *
 * This is the shape `tests/performance/receivables-ar-setbased-equivalence.test.ts`
 * established for `0083` and it is followed deliberately: the estate has
 * accepted that evidence once already, for the same kind of claim.
 *
 * ── WHAT THE CONTRACT ASKS FOR THAT THIS HEAD CANNOT GIVE ──────────────────
 *
 * §10 case 3 asks for fully-settled CREDIT invoices settled «through
 * allocations, credit applications and credit notes». On this head
 * `invoices.document_kind` is pinned by `invoices_document_kind_ck` to the
 * single value `'invoice'`, so a credit-NOTE document does not exist and
 * cannot be seeded. The credit instrument that does exist is
 * `customer_credits` plus `customer_credit_applications` — the second arm of
 * the reducer `UNION ALL` in the ONE definition — and that is what the
 * settled-credit tail is settled with, in three shapes: a full payment
 * allocation, a full credit application, and a two-step chain of both. No
 * invoice in that tail is settled by a status change; every one of them is
 * `status = 'open'` with reducers that sum to its total.
 */
import type { Client } from 'pg';

/** The page size every assertion is taken at: `limit 50` plus the `+1` probe. */
export const PAGE = 51;

/** The business the subject reads belong to, and its look-alike neighbour. */
export type BusinessSlot = 'subject' | 'neighbour';

/** Base currency of both businesses, and the one foreign currency seeded. */
export const BASE_CURRENCY = 'ILS';
export const FOREIGN_CURRENCY = 'USD';
export const FOREIGN_RATE = '3.6500000000';

const SHA = 'a'.repeat(64);
const STAMP = '2026-03-01 09:00:00+00';

/**
 * A deterministic id from a BLOCK and an INDEX.
 *
 * The comparison this module serves is a comparison of two orderings, so a
 * diff has to be readable, and `(issue_date, id)` ties have to break the same
 * way on every run. `block` is a 1 000 000-wide band, so case 8's neighbour
 * ids land in a band adjacent to the subject's and are the same shape, the
 * same length and the same prefix — which is what makes it an isolation test
 * rather than a test that two unrelated uuids differ.
 */
export const idOf = (block: number, index: number): string => `00000000-0000-4000-8000-${(block * 1_000_000 + index).toString(16).padStart(12, '0')}`;

/** `2026-01-01` plus `days`, as `YYYY-MM-DD`. Every date is inside period `2026`. */
export function dayOf(days: number): string {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + days);
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

/** How an invoice's settlement chain is shaped. */
export type Chain =
  /** No reducer at all. */
  | 'none'
  /** One payment allocation for a quarter of the total. */
  | 'partial'
  /** One payment allocation for the whole total. */
  | 'full-payment'
  /** One credit application for the whole total. */
  | 'full-credit'
  /** A payment allocation for half, then a credit application for the rest. */
  | 'split';

export interface InvoiceSpec {
  readonly block: number;
  readonly index: number;
  readonly id: string;
  readonly saleId: string;
  readonly customerId: string;
  readonly settlement: 'cash' | 'credit';
  readonly currency: typeof BASE_CURRENCY | typeof FOREIGN_CURRENCY;
  readonly rate: string;
  readonly totalTxn: number;
  readonly totalBase: number;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly chain: Chain;
}

/** One case of the §10 matrix: a customer of one business and its invoices. */
export interface CaseSpec {
  readonly key: string;
  readonly label: string;
  readonly business: BusinessSlot;
  readonly customerId: string;
  readonly invoices: readonly InvoiceSpec[];
}

interface Build {
  readonly block: number;
  readonly customerId: string;
  readonly settlement: 'cash' | 'credit';
  readonly currency?: typeof BASE_CURRENCY | typeof FOREIGN_CURRENCY;
  readonly chain: Chain;
  readonly totalTxn: number;
  readonly day: number;
  readonly index: number;
}

/** One invoice spec, with the base figure derived from the rate it carries. */
function invoice(b: Build): InvoiceSpec {
  const currency = b.currency ?? BASE_CURRENCY;
  const rate = currency === BASE_CURRENCY ? '1.0000000000' : FOREIGN_RATE;
  const totalBase = currency === BASE_CURRENCY ? b.totalTxn : Math.round(b.totalTxn * Number(rate));
  return {
    block: b.block,
    index: b.index,
    id: idOf(b.block, b.index),
    saleId: idOf(b.block + 500, b.index),
    customerId: b.customerId,
    settlement: b.settlement,
    currency,
    rate,
    totalTxn: b.totalTxn,
    totalBase,
    issueDate: dayOf(b.day),
    // Every invoice carries a due date except where a case asks for none, so
    // the due date is a column the equivalence assertion can compare.
    dueDate: dayOf(b.day + 30),
    chain: b.chain,
  };
}

// ───── the eight cases of the §10 matrix, plus §8's and §13's populations ──

/** Customer ids. Case 8's neighbour customer reuses case 2's id EXACTLY. */
const CUSTOMER = {
  mostlyOpen: idOf(1, 1),
  cashTail: idOf(1, 2),
  settledCreditTail: idOf(1, 3),
  mixture: idOf(1, 4),
  currencies: idOf(1, 5),
  tiedDates: idOf(1, 6),
  secondPage: idOf(1, 7),
  identity: idOf(1, 8),
  fakeLimit: idOf(1, 9),
} as const;

/**
 * §10 case 1 — mostly-open credit invoices. Seventy credit invoices on
 * seventy distinct days; every seventh is settled to zero by a full payment
 * allocation, so sixty are genuinely outstanding and a page of 51 is full.
 */
function caseMostlyOpen(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 70; n += 1) {
    invoices.push(
      invoice({
        block: 10,
        index: n,
        customerId: CUSTOMER.mostlyOpen,
        settlement: 'credit',
        chain: n % 7 === 6 ? 'full-payment' : 'none',
        totalTxn: 100_00 + n,
        day: n,
      }),
    );
  }
  return { key: 'mostlyOpen', label: 'mostly-open credit invoices', business: 'subject', customerId: CUSTOMER.mostlyOpen, invoices };
}

/**
 * §10 case 2 — about 1 500 CASH-settled invoices, then at least 51 genuinely
 * outstanding credit ones. The cash tail comes FIRST in `(issue_date, id)`
 * order, which is what makes it the fat tail: it is 1 500 permanently failing
 * candidates standing in front of the page.
 */
function caseCashTail(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 1_500; n += 1) {
    invoices.push({
      ...invoice({ block: 11, index: n, customerId: CUSTOMER.cashTail, settlement: 'cash', chain: 'none', totalTxn: 50_00 + n, day: Math.floor(n / 10) }),
    });
  }
  for (let n = 0; n < 60; n += 1) {
    invoices.push(
      invoice({
        block: 12,
        index: n,
        customerId: CUSTOMER.cashTail,
        settlement: 'credit',
        chain: n % 3 === 0 ? 'partial' : 'none',
        totalTxn: 200_00 + n,
        day: 200 + n,
      }),
    );
  }
  return { key: 'cashTail', label: '~1 500 cash-settled invoices plus 60 genuinely outstanding', business: 'subject', customerId: CUSTOMER.cashTail, invoices };
}

/**
 * §10 case 3 — about 1 500 FULLY-SETTLED CREDIT invoices, then at least 51
 * genuinely outstanding ones. MANDATORY, and it is the case a cash-only
 * benchmark would miss: these have NO table predicate that can exclude them,
 * so they are the tail the chunking has to handle rather than pre-filter.
 * Each one is `status = 'open'`, settled to zero through its reducers — a
 * full payment allocation, a full credit application, or a two-step chain of
 * both — and never by a status change.
 */
function caseSettledCreditTail(): CaseSpec {
  const chains: readonly Chain[] = ['full-payment', 'full-credit', 'split'];
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 1_500; n += 1) {
    invoices.push(
      invoice({
        block: 13,
        index: n,
        customerId: CUSTOMER.settledCreditTail,
        settlement: 'credit',
        chain: chains[n % 3] as Chain,
        // An even total, so the two-step chain splits it without a remainder.
        totalTxn: 400_00 + 2 * n,
        day: Math.floor(n / 10),
      }),
    );
  }
  for (let n = 0; n < 60; n += 1) {
    invoices.push(
      invoice({
        block: 14,
        index: n,
        customerId: CUSTOMER.settledCreditTail,
        settlement: 'credit',
        chain: n % 4 === 0 ? 'partial' : 'none',
        totalTxn: 300_00 + n,
        day: 200 + n,
      }),
    );
  }
  return {
    key: 'settledCreditTail',
    label: '~1 500 fully-settled CREDIT invoices plus 60 genuinely outstanding',
    business: 'subject',
    customerId: CUSTOMER.settledCreditTail,
    invoices,
  };
}

/**
 * §10 case 4 — a mixture of the above, INTERLEAVED rather than segregated, so
 * no chunk boundary ever lines up with a change of kind.
 */
function caseMixture(): CaseSpec {
  const kinds: readonly { settlement: 'cash' | 'credit'; chain: Chain }[] = [
    { settlement: 'cash', chain: 'none' },
    { settlement: 'credit', chain: 'full-payment' },
    { settlement: 'credit', chain: 'full-credit' },
    { settlement: 'credit', chain: 'partial' },
    { settlement: 'credit', chain: 'none' },
  ];
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 1_200; n += 1) {
    const k = kinds[n % kinds.length] as { settlement: 'cash' | 'credit'; chain: Chain };
    invoices.push(
      invoice({
        block: 15,
        index: n,
        customerId: CUSTOMER.mixture,
        settlement: k.settlement,
        chain: k.chain,
        totalTxn: 120_00 + 4 * n,
        day: Math.floor(n / 5),
      }),
    );
  }
  return {
    key: 'mixture',
    label: 'a mixture of cash, settled credit, partial and untouched, interleaved',
    business: 'subject',
    customerId: CUSTOMER.mixture,
    invoices,
  };
}

/**
 * §10 case 5 — multiple currencies. The base currency and one foreign one
 * alternate, so the currency column changes from row to row inside one page
 * and an equality that compared only the ids would pass while the currency
 * was wrong.
 */
function caseCurrencies(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 80; n += 1) {
    invoices.push(
      invoice({
        block: 16,
        index: n,
        customerId: CUSTOMER.currencies,
        settlement: 'credit',
        currency: n % 2 === 0 ? BASE_CURRENCY : FOREIGN_CURRENCY,
        chain: n % 4 === 1 ? 'partial' : 'none',
        totalTxn: 80_00 + 4 * n,
        day: n,
      }),
    );
  }
  return { key: 'currencies', label: 'multiple currencies', business: 'subject', customerId: CUSTOMER.currencies, invoices };
}

/**
 * §10 case 6 — IDENTICAL due dates, and identical issue dates with them, so
 * `(issue_date, id)` has nothing to order by but the id. A reader that
 * ordered by the due date, or that let a chunk boundary reorder a tie, cannot
 * agree with the oracle here.
 */
function caseTiedDates(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 60; n += 1) {
    invoices.push(invoice({ block: 17, index: n, customerId: CUSTOMER.tiedDates, settlement: 'credit', chain: 'none', totalTxn: 90_00 + n, day: 151 }));
  }
  return {
    key: 'tiedDates',
    label: 'identical due dates, requiring deterministic tie-breaking',
    business: 'subject',
    customerId: CUSTOMER.tiedDates,
    invoices,
  };
}

/**
 * §10 case 7 — the second page. 130 outstanding credit invoices with 200
 * cash-settled ones interleaved among them, so the keyset boundary between
 * page one and page two falls in the middle of a run of ineligible
 * candidates and the continuation has to carry both ordering components.
 */
function caseSecondPage(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  let outstanding = 0;
  let cash = 0;
  for (let n = 0; n < 330; n += 1) {
    if (n % 5 === 2 || n % 5 === 3) {
      invoices.push(invoice({ block: 18, index: n, customerId: CUSTOMER.secondPage, settlement: 'cash', chain: 'none', totalTxn: 70_00 + n, day: n }));
      cash += 1;
    } else {
      invoices.push(invoice({ block: 18, index: n, customerId: CUSTOMER.secondPage, settlement: 'credit', chain: 'none', totalTxn: 110_00 + n, day: n }));
      outstanding += 1;
    }
  }
  if (outstanding < 2 * PAGE || cash === 0) throw new Error(`case 7 needs at least ${2 * PAGE} outstanding and some cash, got ${outstanding}/${cash}`);
  return {
    key: 'secondPage',
    label: 'the second page — keyset continuation across the boundary',
    business: 'subject',
    customerId: CUSTOMER.secondPage,
    invoices,
  };
}

/**
 * §8 — the cash-eligibility identity population.
 *
 * `cash-no-reducer` is the row that catches the claim if it is wrong: it is
 * `status = 'open'`, it has a due date a year in the past, it has NO reducer
 * at all, and so `total - sum(reducers)` is its WHOLE total. Everything about
 * it except `sales.settlement_mode` says outstanding. `0080`'s law and the
 * ONE definition's own `WHEN s.settlement_mode = 'cash' THEN 0` branch say
 * zero, and the table pre-filter must agree with THEM and not with the raw
 * arithmetic.
 *
 * `cash-partial-reducer` and `cash-full-reducer` are the forbidden shapes
 * `0080` exists to prevent — a cash-settled invoice carrying an allocation —
 * seeded here precisely because a reader must not disagree with itself on a
 * row it is handed.
 */
function caseIdentity(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  let index = 0;
  const push = (settlement: 'cash' | 'credit', chain: Chain, day: number, total: number): void => {
    invoices.push(invoice({ block: 19, index, customerId: CUSTOMER.identity, settlement, chain, totalTxn: total, day }));
    index += 1;
  };
  for (let n = 0; n < 5; n += 1) push('cash', 'none', n, 900_00 + n);
  for (let n = 0; n < 3; n += 1) push('cash', 'partial', 10 + n, 800_00 + n);
  for (let n = 0; n < 2; n += 1) push('cash', 'full-payment', 20 + n, 700_00 + n);
  for (let n = 0; n < 6; n += 1) push('credit', n % 2 === 0 ? 'none' : 'partial', 30 + n, 600_00 + n);
  for (let n = 0; n < 4; n += 1) push('credit', n % 2 === 0 ? 'full-payment' : 'split', 40 + n, 500_00 + 2 * n);
  return { key: 'identity', label: 'the cash-eligibility identity population', business: 'subject', customerId: CUSTOMER.identity, invoices };
}

/**
 * §13 — the population that separates a correct fix from a fake one.
 *
 * In `(issue_date, id)` order the first 51 candidates are days 0…50, and
 * exactly ten of them are genuinely outstanding (days 0, 5, 10, … 45 — day 50
 * is deliberately cash-settled, so the count is ten and not eleven); the
 * other 41 are cash-settled and can never satisfy `<> 0`. Days 51…129 are 79
 * more genuinely outstanding invoices, so 89 in all.
 *
 * So: take the first 51 candidate rows and then drop the zero-outstanding
 * ones and you return TEN rows while 89 invoices are outstanding. A correct
 * reader returns a FULL PAGE OF 51.
 */
function caseFakeLimit(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  for (let day = 0; day < 130; day += 1) {
    const outstanding = day >= 51 || (day % 5 === 0 && day < 50);
    invoices.push(
      invoice({
        block: 20,
        index: day,
        customerId: CUSTOMER.fakeLimit,
        settlement: outstanding ? 'credit' : 'cash',
        chain: 'none',
        totalTxn: 300_00 + day,
        day,
      }),
    );
  }
  return { key: 'fakeLimit', label: 'the first 51 candidates hold ten outstanding rows', business: 'subject', customerId: CUSTOMER.fakeLimit, invoices };
}

/**
 * §10 case 8 — the neighbour business, whose ids are shaped similarly.
 *
 * `customers` is keyed `(business_id, id)`, so the neighbour's customer
 * carries the SAME uuid as case 2's, and its invoice ids sit in the band
 * directly beside case 2's with the same prefix, the same length and the same
 * issue dates. A read of the subject business must return exactly the
 * subject's rows and a read of the neighbour exactly the neighbour's; a leak
 * in either direction is a leak between rows a careless eye cannot tell
 * apart.
 */
function caseNeighbour(): CaseSpec {
  const invoices: InvoiceSpec[] = [];
  for (let n = 0; n < 200; n += 1) {
    invoices.push(
      invoice({
        block: 21,
        index: n,
        customerId: CUSTOMER.cashTail,
        settlement: n % 4 === 0 ? 'cash' : 'credit',
        chain: n % 4 === 1 ? 'full-payment' : 'none',
        totalTxn: 999_00 + n,
        day: 200 + (n % 60),
      }),
    );
  }
  return { key: 'neighbour', label: 'a second business whose ids are shaped similarly', business: 'neighbour', customerId: CUSTOMER.cashTail, invoices };
}

/** Every case, in the order the suite reports them. */
export function allCases(): readonly CaseSpec[] {
  return [
    caseMostlyOpen(),
    caseCashTail(),
    caseSettledCreditTail(),
    caseMixture(),
    caseCurrencies(),
    caseTiedDates(),
    caseSecondPage(),
    caseNeighbour(),
    caseIdentity(),
    caseFakeLimit(),
  ];
}

// ───── the three SQL texts: the oracle, the canonical set, the fake fix ────

/**
 * §11 THE ORACLE — the OLD semantics, preserved.
 *
 * This is `customer-reads.ts:300` as it reads today: the per-row
 * `JOIN LATERAL invoice_outstanding(i.business_id, i.id)` with
 * `AND o.outstanding_txn_minor <> 0` applied to the FUNCTION'S OUTPUT, the
 * same `status = 'open'` restriction, the same `(issue_date, id)` keyset
 * comparison, the same `ORDER BY i.issue_date, i.id` and the same `LIMIT`.
 *
 * TWO deliberate differences, neither of them semantic:
 *
 *   — the cursor's two components are passed in as `$3`/`$4` instead of being
 *     resolved by a sub-select on `invoices` by primary key. That is the
 *     app-side change §14 describes: the public cursor stays the invoice id
 *     and the app resolves it to `(issue_date, id)` through the primary key.
 *     The pair compared is the same pair, so the boundary is the same
 *     boundary, and passing it in is what lets the oracle and the reader be
 *     asked the SAME question;
 *   — the columns are listed in the page reader's own order, so the two
 *     captures are comparable element by element.
 *
 * IT IS TEST-ONLY. It is never a production fast path, nothing in `apps/api`
 * calls it, and the suite asserts that no file under `apps/api` contains the
 * per-row shape once `0084` has landed.
 */
export const ORACLE_SQL = `
  SELECT i.id                                AS invoice_id,
         to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
         o.paid_txn_minor::text              AS paid_txn_minor,
         o.paid_base_minor::text             AS paid_base_minor,
         o.outstanding_txn_minor::text       AS outstanding_txn_minor,
         o.outstanding_base_minor::text      AS outstanding_base_minor,
         i.currency_code::text               AS currency_code,
         to_char(i.due_date, 'YYYY-MM-DD')   AS due_date
    FROM public.invoices i
    JOIN LATERAL public.invoice_outstanding(i.business_id, i.id) o ON TRUE
   WHERE i.business_id = $1::uuid AND i.customer_id = $2::uuid AND i.status = 'open'
     AND o.outstanding_txn_minor <> 0
     AND ($3::date IS NULL OR (i.issue_date, i.id) > ($3::date, $4::uuid))
   ORDER BY i.issue_date, i.id
   LIMIT $5::integer`;

/**
 * §8 THE CANONICAL SET — the ONE definition, asked about EVERY candidate.
 *
 * No `settlement_mode` predicate anywhere. Every open invoice of the customer
 * is handed to `invoice_outstanding(business, ids[])` and the filter is
 * applied to the definition's own answer. This is the definition of the
 * result set the page reader's table pre-filter is only allowed to be an
 * optimization OF.
 *
 * The array form is called once over the whole candidate set, so this is the
 * canonical ANSWER and not a second traversal shape: it shares its arithmetic
 * with the oracle and with the reader, because all three call the same ONE
 * definition.
 */
export const CANONICAL_SQL = `
  WITH candidates AS (
    SELECT x.id, x.issue_date
      FROM public.invoices x
     WHERE x.business_id = $1::uuid AND x.customer_id = $2::uuid AND x.status = 'open'
  )
  SELECT i.id                                AS invoice_id,
         to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
         o.paid_txn_minor::text              AS paid_txn_minor,
         o.paid_base_minor::text             AS paid_base_minor,
         o.outstanding_txn_minor::text       AS outstanding_txn_minor,
         o.outstanding_base_minor::text      AS outstanding_base_minor,
         i.currency_code::text               AS currency_code,
         to_char(i.due_date, 'YYYY-MM-DD')   AS due_date
    FROM public.invoice_outstanding($1::uuid, (SELECT array_agg(c.id) FROM candidates c)) o
    JOIN public.invoices i ON i.business_id = $1::uuid AND i.id = o.invoice_id
   WHERE o.outstanding_txn_minor <> 0
     AND ($3::date IS NULL OR (i.issue_date, i.id) > ($3::date, $4::uuid))
   ORDER BY i.issue_date, i.id
   LIMIT $5::integer`;

/**
 * §13 THE FAKE FIX, written out so the §13 assertion can be shown to be
 * red-capable.
 *
 * It pushes the `LIMIT` down to the candidate scan — which is what makes it
 * fast — and then drops the zero-outstanding rows from what it got. It is
 * fast and it is WRONG: it returns a short page whenever the first `p_limit`
 * candidates are not all outstanding. Nothing in the product may ever look
 * like this, and the suite's §13 test exists to fail against it.
 */
export const FAKE_LIMIT_SQL = `
  WITH first_candidates AS (
    SELECT i.id, i.issue_date, i.due_date, i.currency_code, i.business_id
      FROM public.invoices i
     WHERE i.business_id = $1::uuid AND i.customer_id = $2::uuid AND i.status = 'open'
       AND ($3::date IS NULL OR (i.issue_date, i.id) > ($3::date, $4::uuid))
     ORDER BY i.issue_date, i.id
     LIMIT $5::integer
  )
  SELECT c.id                                AS invoice_id,
         to_char(c.issue_date, 'YYYY-MM-DD') AS issue_date,
         o.paid_txn_minor::text              AS paid_txn_minor,
         o.paid_base_minor::text             AS paid_base_minor,
         o.outstanding_txn_minor::text       AS outstanding_txn_minor,
         o.outstanding_base_minor::text      AS outstanding_base_minor,
         c.currency_code::text               AS currency_code,
         to_char(c.due_date, 'YYYY-MM-DD')   AS due_date
    FROM first_candidates c
    JOIN LATERAL public.invoice_outstanding(c.business_id, c.id) o ON TRUE
   WHERE o.outstanding_txn_minor <> 0
   ORDER BY c.issue_date, c.id`;

/**
 * THE READER UNDER TEST, read through the signature the contract fixes.
 *
 * `customer_open_invoices_page(business, customer, after_issue_date, after_id,
 * limit)` returning `(invoice_id, issue_date, paid_txn_minor, paid_base_minor,
 * outstanding_txn_minor, outstanding_base_minor, currency_code, due_date)`.
 * Nothing is re-ordered and nothing is re-filtered here: the reader's own
 * rows, in the reader's own order, are what the comparison is taken over.
 */
export const READER_SQL = `
  SELECT p.invoice_id,
         to_char(p.issue_date, 'YYYY-MM-DD') AS issue_date,
         p.paid_txn_minor::text              AS paid_txn_minor,
         p.paid_base_minor::text             AS paid_base_minor,
         p.outstanding_txn_minor::text       AS outstanding_txn_minor,
         p.outstanding_base_minor::text      AS outstanding_base_minor,
         p.currency_code::text               AS currency_code,
         to_char(p.due_date, 'YYYY-MM-DD')   AS due_date
    FROM public.customer_open_invoices_page($1::uuid, $2::uuid, $3::date, $4::uuid, $5::integer) p`;

/** One row of any of the four readings above. Compared field by field. */
export interface PageRow {
  readonly invoice_id: string;
  readonly issue_date: string;
  readonly paid_txn_minor: string;
  readonly paid_base_minor: string;
  readonly outstanding_txn_minor: string;
  readonly outstanding_base_minor: string;
  readonly currency_code: string;
  readonly due_date: string | null;
}

// ───── seeding ────────────────────────────────────────────────────────────

/** The relations whose guards and referential triggers step aside. */
const TABLES_WITHOUT_TRIGGERS = [
  'customers',
  'sales',
  'invoices',
  'payments',
  'payment_allocations',
  'customer_credits',
  'customer_credit_applications',
] as const;

export interface Seeded {
  readonly tenantId: string;
  readonly userId: string;
  readonly businessId: Readonly<Record<BusinessSlot, string>>;
  readonly cases: readonly CaseSpec[];
}

/** The chain steps of one invoice, in order, as `(amount, releasedBefore)`. */
function stepsOf(spec: InvoiceSpec): {
  readonly allocations: readonly { amount: number; before: number }[];
  readonly credits: readonly { amount: number; before: number }[];
} {
  switch (spec.chain) {
    case 'none':
      return { allocations: [], credits: [] };
    case 'partial':
      return { allocations: [{ amount: Math.max(1, Math.floor(spec.totalTxn / 4)), before: 0 }], credits: [] };
    case 'full-payment':
      return { allocations: [{ amount: spec.totalTxn, before: 0 }], credits: [] };
    case 'full-credit':
      return { allocations: [], credits: [{ amount: spec.totalTxn, before: 0 }] };
    case 'split': {
      const half = Math.floor(spec.totalTxn / 2);
      return { allocations: [{ amount: half, before: 0 }], credits: [{ amount: spec.totalTxn - half, before: half }] };
    }
  }
}

/**
 * Write the whole population. The caller is inside a transaction it will
 * ROLL BACK, and is connected as the schema owner.
 *
 * Every figure the settlement chain carries that the product computes is
 * computed BY THE PRODUCT, inside the INSERT: `invoice_carrying_base_released_minor`
 * is `supplier_ap_release(total_base, total_txn, released_before, amount)` and
 * `realized_fx_gain_loss_minor` is the difference the row's own CHECK
 * constraint demands, expressed over that same call. No arithmetic of the
 * product's is re-implemented here.
 */
export async function seed(c: Client): Promise<Seeded> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => {
    const r = await c.query<{ id: string }>(sql, params);
    return (r.rows[0] as { id: string }).id;
  };
  const tenantId = await one('INSERT INTO tenants DEFAULT VALUES RETURNING id');
  const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Open page equivalence') RETURNING id`, [
    `open-page-${process.pid}@test.daftar.local`,
  ]);

  const businessId: Record<BusinessSlot, string> = { subject: '', neighbour: '' };
  const branchId: Record<BusinessSlot, string> = { subject: '', neighbour: '' };
  for (const [slot, name] of [
    ['subject', 'Subject Books'],
    ['neighbour', 'Neighbour Books'],
  ] as const) {
    businessId[slot] = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, $2, $3, 'PS', $4, 'Asia/Hebron') RETURNING id`,
      [tenantId, name, `open-page-${slot}-${process.pid}`, BASE_CURRENCY],
    );
    branchId[slot] = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId[slot]]);
  }

  for (const t of TABLES_WITHOUT_TRIGGERS) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);

  const cases = allCases();

  // The customers. One row per (business, customer id) actually used; case 8's
  // neighbour customer deliberately carries case 2's uuid.
  const seen = new Set<string>();
  for (const k of cases) {
    const key = `${k.business}/${k.customerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await c.query(
      `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                              business_transaction_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'active', 1, $5, $5, gen_random_uuid(), $6, $6)`,
      [tenantId, businessId[k.business], k.customerId, `Customer ${k.key}`, SHA, userId],
    );
  }

  // Document numbering is unique per (business, kind, period) on both the
  // sequence and the string, so it is handed out from one counter per business.
  const numberSeq: Record<BusinessSlot, number> = { subject: 0, neighbour: 0 };

  for (const k of cases) {
    const bid = businessId[k.business];
    const brid = branchId[k.business];
    const specs = k.invoices;
    const seqs = specs.map(() => (numberSeq[k.business] += 1));

    await c.query(
      `INSERT INTO sales (tenant_id, business_id, id, customer_id, branch_id, warehouse_id, status, settlement_mode, document_date,
                          currency_code, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                          source_to_base_rate, rate_source, rate_timestamp, customer_name_snapshot, commit_intent_sha256,
                          confirmed_by, confirmed_at, business_transaction_id, created_by, binding_source_id)
       SELECT $1::uuid, $2::uuid, t.sale_id, $3::uuid, $4::uuid, gen_random_uuid(), 'confirmed', t.settlement, t.issue_date::date,
              t.currency, t.total_txn, 0, t.total_txn, t.total_base,
              t.rate::numeric, CASE WHEN t.currency = $5 THEN 'base' ELSE 'manual' END, $6::timestamptz, 'Snapshot Name', $7,
              $8::uuid, $6::timestamptz, gen_random_uuid(), $8::uuid, t.sale_id
         FROM unnest($9::uuid[], $10::text[], $11::text[], $12::text[], $13::bigint[], $14::bigint[], $15::text[])
                AS t(sale_id, settlement, issue_date, currency, total_txn, total_base, rate)`,
      [
        tenantId,
        bid,
        k.customerId,
        brid,
        BASE_CURRENCY,
        STAMP,
        SHA,
        userId,
        specs.map((s) => s.saleId),
        specs.map((s) => s.settlement),
        specs.map((s) => s.issueDate),
        specs.map((s) => s.currency),
        specs.map((s) => s.totalTxn),
        specs.map((s) => s.totalBase),
        specs.map((s) => s.rate),
      ],
    );

    await c.query(
      `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                             period, issue_date, due_date, currency_code, status, subtotal_txn_minor, discount_txn_minor,
                             total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                             customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by, binding_source_id)
       SELECT $1::uuid, $2::uuid, t.id, t.sale_id, $3::uuid, $4::uuid, 'invoice', 'INV-' || t.seq::text, t.seq,
              pg_catalog.substr(t.issue_date, 1, 4), t.issue_date::date, t.due_date::date, t.currency, 'open', t.total_txn, 0,
              t.total_txn, t.total_base, t.rate::numeric, CASE WHEN t.currency = $5 THEN 'base' ELSE 'manual' END, $6::timestamptz,
              'Snapshot Name', $7, gen_random_uuid(), $8::uuid, t.id
         FROM unnest($9::uuid[], $10::uuid[], $11::bigint[], $12::text[], $13::text[], $14::text[], $15::bigint[], $16::bigint[], $17::text[])
                AS t(id, sale_id, seq, issue_date, due_date, currency, total_txn, total_base, rate)`,
      [
        tenantId,
        bid,
        k.customerId,
        brid,
        BASE_CURRENCY,
        STAMP,
        SHA,
        userId,
        specs.map((s) => s.id),
        specs.map((s) => s.saleId),
        seqs,
        specs.map((s) => s.issueDate),
        specs.map((s) => s.dueDate),
        specs.map((s) => s.currency),
        specs.map((s) => s.totalTxn),
        specs.map((s) => s.totalBase),
        specs.map((s) => s.rate),
      ],
    );

    // The payment side: one payment per allocation step, so a chain's steps
    // never share a payment and `payment_allocations_invoice_uq` holds.
    const alloc: { paymentId: string; allocationId: string; invoiceId: string; amount: number; before: number; spec: InvoiceSpec }[] = [];
    const credit: { creditId: string; originPaymentId: string; applicationId: string; invoiceId: string; amount: number; before: number; spec: InvoiceSpec }[] =
      [];
    let step = 0;
    for (const s of specs) {
      const steps = stepsOf(s);
      for (const a of steps.allocations) {
        step += 1;
        alloc.push({
          paymentId: idOf(s.block + 600, step),
          allocationId: idOf(s.block + 700, step),
          invoiceId: s.id,
          amount: a.amount,
          before: a.before,
          spec: s,
        });
      }
      for (const a of steps.credits) {
        step += 1;
        credit.push({
          creditId: idOf(s.block + 800, step),
          originPaymentId: idOf(s.block + 960, step),
          applicationId: idOf(s.block + 900, step),
          invoiceId: s.id,
          amount: a.amount,
          before: a.before,
          spec: s,
        });
      }
    }

    if (alloc.length > 0) {
      await c.query(
        `INSERT INTO payments (tenant_id, business_id, id, customer_id, payment_method_id, posting_account_id, currency_code,
                               amount_minor, payment_to_base_rate, rate_source, rate_timestamp, base_amount_minor, payment_date,
                               allocation_count, intent_sha256, business_transaction_id, created_by)
         SELECT $1::uuid, $2::uuid, t.payment_id, $3::uuid, gen_random_uuid(), gen_random_uuid(), t.currency,
                t.amount, t.rate::numeric, CASE WHEN t.currency = $4 THEN 'base' ELSE 'manual' END, $5::timestamptz, t.base_amount,
                $6::date, 1, $7, gen_random_uuid(), $8::uuid
           FROM unnest($9::uuid[], $10::text[], $11::bigint[], $12::text[], $13::bigint[])
                  AS t(payment_id, currency, amount, rate, base_amount)`,
        [
          tenantId,
          bid,
          k.customerId,
          BASE_CURRENCY,
          STAMP,
          dayOf(300),
          SHA,
          userId,
          alloc.map((a) => a.paymentId),
          alloc.map((a) => a.spec.currency),
          alloc.map((a) => a.amount),
          alloc.map((a) => a.spec.rate),
          alloc.map((a) => (a.spec.currency === BASE_CURRENCY ? a.amount : Math.round(a.amount * Number(a.spec.rate)))),
        ],
      );
      await c.query(
        `INSERT INTO payment_allocations (tenant_id, business_id, id, payment_id, customer_id, invoice_id, line_no,
                                          payment_currency, payment_amount_minor, payment_to_base_rate, payment_base_amount_minor,
                                          invoice_currency, invoice_amount_applied_minor, invoice_historical_to_base_rate,
                                          ar_released_before_txn_minor, invoice_carrying_base_released_minor, ar_dust_base_minor,
                                          realized_fx_gain_loss_minor, binding_source_id)
         SELECT $1::uuid, $2::uuid, r.allocation_id, r.payment_id, $3::uuid, r.invoice_id, 1,
                r.currency, r.amount, r.rate::numeric, r.base_amount,
                r.currency, r.amount, r.rate::numeric,
                r.before, r.rel, 0,
                r.base_amount - r.rel, r.allocation_id
           FROM (
             SELECT t.*, public.supplier_ap_release(t.total_base, t.total_txn, t.before, t.amount) AS rel
               FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::bigint[], $9::text[], $10::bigint[],
                           $11::bigint[], $12::bigint[], $13::bigint[])
                      AS t(allocation_id, payment_id, invoice_id, currency, amount, rate, base_amount, before, total_base, total_txn)
           ) r`,
        [
          tenantId,
          bid,
          k.customerId,
          alloc.map((a) => a.allocationId),
          alloc.map((a) => a.paymentId),
          alloc.map((a) => a.invoiceId),
          alloc.map((a) => a.spec.currency),
          alloc.map((a) => a.amount),
          alloc.map((a) => a.spec.rate),
          alloc.map((a) => (a.spec.currency === BASE_CURRENCY ? a.amount : Math.round(a.amount * Number(a.spec.rate)))),
          alloc.map((a) => a.before),
          alloc.map((a) => a.spec.totalBase),
          alloc.map((a) => a.spec.totalTxn),
        ],
      );
    }

    if (credit.length > 0) {
      // Each credit is born from a payment of its own and consumed in full by
      // one application, so `customer_credits_remaining_pair_ck` and
      // `customer_credit_applications_level_uq` both hold.
      await c.query(
        `INSERT INTO payments (tenant_id, business_id, id, customer_id, payment_method_id, posting_account_id, currency_code,
                               amount_minor, payment_to_base_rate, rate_source, rate_timestamp, base_amount_minor, payment_date,
                               allocation_count, intent_sha256, business_transaction_id, created_by)
         SELECT $1::uuid, $2::uuid, t.origin_id, $3::uuid, gen_random_uuid(), gen_random_uuid(), t.currency,
                t.amount, t.rate::numeric, CASE WHEN t.currency = $4 THEN 'base' ELSE 'manual' END, $5::timestamptz, t.base_amount,
                $6::date, 0, $7, gen_random_uuid(), $8::uuid
           FROM unnest($9::uuid[], $10::text[], $11::bigint[], $12::text[], $13::bigint[])
                  AS t(origin_id, currency, amount, rate, base_amount)`,
        [
          tenantId,
          bid,
          k.customerId,
          BASE_CURRENCY,
          STAMP,
          dayOf(301),
          SHA,
          userId,
          credit.map((a) => a.originPaymentId),
          credit.map((a) => a.spec.currency),
          credit.map((a) => a.amount),
          credit.map((a) => a.spec.rate),
          credit.map((a) => (a.spec.currency === BASE_CURRENCY ? a.amount : Math.round(a.amount * Number(a.spec.rate)))),
        ],
      );
      await c.query(
        `INSERT INTO customer_credits (tenant_id, business_id, id, customer_id, origin_payment_id, currency_code,
                                       original_amount_minor, original_carrying_base_amount_minor, credit_to_base_rate,
                                       rate_source, rate_timestamp, remaining_amount_minor, remaining_carrying_base_amount_minor,
                                       credit_date, intent_sha256, business_transaction_id, created_by, binding_source_id)
         SELECT $1::uuid, $2::uuid, t.credit_id, $3::uuid, t.origin_id, t.currency,
                t.amount, t.base_amount, t.rate::numeric,
                CASE WHEN t.currency = $4 THEN 'base' ELSE 'manual' END, $5::timestamptz, 0, 0,
                $6::date, $7, gen_random_uuid(), $8::uuid, t.credit_id
           FROM unnest($9::uuid[], $10::uuid[], $11::text[], $12::bigint[], $13::text[], $14::bigint[])
                  AS t(credit_id, origin_id, currency, amount, rate, base_amount)`,
        [
          tenantId,
          bid,
          k.customerId,
          BASE_CURRENCY,
          STAMP,
          dayOf(302),
          SHA,
          userId,
          credit.map((a) => a.creditId),
          credit.map((a) => a.originPaymentId),
          credit.map((a) => a.spec.currency),
          credit.map((a) => a.amount),
          credit.map((a) => a.spec.rate),
          credit.map((a) => (a.spec.currency === BASE_CURRENCY ? a.amount : Math.round(a.amount * Number(a.spec.rate)))),
        ],
      );
      await c.query(
        `INSERT INTO customer_credit_applications (tenant_id, business_id, id, customer_id, credit_id, invoice_id, application_date,
                                                   credit_currency, credit_amount_consumed_minor, credit_to_base_rate,
                                                   credit_remaining_before_minor, credit_carrying_base_released_minor,
                                                   credit_dust_base_minor, invoice_currency, invoice_amount_applied_minor,
                                                   invoice_historical_to_base_rate, ar_released_before_txn_minor,
                                                   invoice_carrying_base_released_minor, ar_dust_base_minor,
                                                   realized_fx_gain_loss_minor, intent_sha256, business_transaction_id,
                                                   created_by, binding_source_id)
         SELECT $1::uuid, $2::uuid, r.application_id, $3::uuid, r.credit_id, r.invoice_id, $4::date,
                r.currency, r.amount, r.rate::numeric,
                r.amount, r.base_amount,
                0, r.currency, r.amount,
                r.rate::numeric, r.before,
                r.rel, 0,
                r.base_amount - r.rel, $5, gen_random_uuid(),
                $6::uuid, r.application_id
           FROM (
             SELECT t.*, public.supplier_ap_release(t.total_base, t.total_txn, t.before, t.amount) AS rel
               FROM unnest($7::uuid[], $8::uuid[], $9::uuid[], $10::text[], $11::bigint[], $12::text[], $13::bigint[],
                           $14::bigint[], $15::bigint[], $16::bigint[])
                      AS t(application_id, credit_id, invoice_id, currency, amount, rate, base_amount, before, total_base, total_txn)
           ) r`,
        [
          tenantId,
          bid,
          k.customerId,
          dayOf(303),
          SHA,
          userId,
          credit.map((a) => a.applicationId),
          credit.map((a) => a.creditId),
          credit.map((a) => a.invoiceId),
          credit.map((a) => a.spec.currency),
          credit.map((a) => a.amount),
          credit.map((a) => a.spec.rate),
          credit.map((a) => (a.spec.currency === BASE_CURRENCY ? a.amount : Math.round(a.amount * Number(a.spec.rate)))),
          credit.map((a) => a.before),
          credit.map((a) => a.spec.totalBase),
          credit.map((a) => a.spec.totalTxn),
        ],
      );
    }
  }

  return { tenantId, userId, businessId, cases };
}
