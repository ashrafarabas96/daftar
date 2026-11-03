import { Inject, Injectable } from '@nestjs/common';
import { agingBucketLabels, type AppError } from '@daftar/domain-core';
import type {
  CustomerAgingBucketDto,
  CustomerAgingDto,
  CustomerContactDto,
  CustomerCurrencyAmountDto,
  CustomerDto,
  CustomerListItemDto,
  CustomerOpenDocumentCountsDto,
  CustomerOpenInvoiceDto,
  CustomerOpenInvoicesDto,
  CustomerPageDto,
  CustomerReceivableDto,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import { readBaseCurrency } from '../inventory/inventory-stock-read';
import { likeEscaped } from '../inventory/read-scope';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { sellingRefusal } from './selling-errors';
import type { CustomerAgingQuery, CustomerListQuery, CustomerOpenInvoicesQuery } from './selling.schemas';

/**
 * The customer READ surface of P4-S1 (lock §4 source-of-truth matrix, P4-AL-06,
 * P4-AL-07; `OD-P4-03` OPTION A; `OD-P4-07` OPTION A).
 *
 * **Nothing here is stored and nothing here is cached.** What a customer owes is
 * derived per request from the `journal_lines` on the AR account scoped to that
 * customer, and what is outstanding on one of their invoices from
 * `invoice_outstanding(...)`. There is no `customers.balance_minor`, no
 * `invoices.paid_minor` and no `invoices.outstanding_minor` to read: P4-AL-06
 * forbids the columns, and P4-S1's extension of guard G-3 proves in CI that
 * none was introduced.
 *
 * **Every derivation goes through the product's own SQL function**, not through
 * a copy of the arithmetic here. P4-AL-07: "a second copy of the arithmetic in
 * TypeScript is a second truth with a slower failure mode, because it disagrees
 * only under the numbers nobody tested." So this module holds the shaping — the
 * page, the cursor, the bucket labels — and none of the money.
 *
 * Rules this module holds itself to, the G-6 reporting-surface rules
 * (`scripts/guards/read-surface.ts`) applied by hand because that guard's path
 * regex does not yet reach a Phase 4 module:
 *
 * - no write of any kind. A GET that stamped a row or backfilled a total would
 *   be a mutation the merchant did not ask for and cannot audit;
 * - no `OFFSET`. Page N would cost N pages, and a sale committed during the
 *   walk would shift every later page — which on a receivable means an invoice
 *   the merchant never sees. Every page is a keyset walk;
 * - no current exchange-rate lookup. `OD-P4-07` OPTION A: the statement shows
 *   the original currency alongside the HISTORICAL carrying and base figures,
 *   and a revaluation column would be a number no journal line supports;
 * - no `Number(`, `parseInt(` or `parseFloat(` on a money value. A cumulative
 *   receivable exceeds 2^53 long before it exceeds what a merchant can earn.
 *   Amounts leave the database as text and reach the DTO as text;
 * - no module-level result cache.
 */

/** Phase 4 relations and functions this module reads. None exists until the first Phase 4 migration lands. */
const DEFAULT_LIMIT = 20;

export interface CustomerRow extends QueryResultRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  revision: number;
  created_at: Date;
  updated_at: Date;
  business_transaction_id: string;
  create_intent_sha256: string;
  last_intent_sha256: string;
}

interface ContactRow extends QueryResultRow {
  customer_id: string;
  id: string;
  contact_no: number;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_primary: boolean;
}

const CUSTOMER_COLUMNS = `c.id, c.name, c.phone, c.email, c.notes, c.status, c.revision, c.created_at, c.updated_at,
         c.business_transaction_id, c.create_intent_sha256, c.last_intent_sha256`;

/**
 * THE ONE DEFINITION of "this row carries credit, not debt" (DR-31).
 *
 * It is interpolated into the open-invoices page twice — once as the `is_credit`
 * column and once as the predicate of the `days_past_due` CASE — so the two can
 * never drift apart. It is a compile-time constant of this module: no caller
 * input reaches it, and the two parameters the page does take are still bound
 * (`$1`…`$5`).
 *
 * TWO ARMS, AND THE CHOICE OF EACH IS SIGNED:
 *
 *  1. `document_kind = 'credit_note'` — the document's OWN KIND, enumerated
 *     POSITIVELY. Not `<> 'invoice'`. The difference matters in the direction
 *     that costs money: were an unknown future kind swept in as credit, its
 *     `days_past_due` would be forced to zero and a genuine debt would stop
 *     reading as overdue — a debt leaving the report by omission, which is the
 *     one failure DR-13/DR-21/DR-30 exist to forbid. Naming a new DEBIT kind as
 *     credit by accident is therefore unreachable; the opposite mistake (a new
 *     CREDIT kind reading as debit until it is named here) shows a credit
 *     labelled overdue, which is visibly wrong and hides nothing.
 *
 *     MEASURED LIMIT: `invoices_document_kind_ck` (`0075`) today CHECKs
 *     `document_kind = 'invoice'`, so this arm is UNREACHABLE on the published
 *     schema and becomes live the day P4-S5 adds the credit-note kind. It is
 *     written now because the read surface already types the column as
 *     `'invoice' | 'credit_note'` and a client already branches on it.
 *
 *  2. `outstanding_txn_minor < 0` — the SIGN of the money, which is live TODAY.
 *     An overpaid invoice carries a credit balance (DR-23), and
 *     `customer_open_invoices_page` filters on `outstanding_txn_minor <> 0`,
 *     NOT `> 0` (measured in `0084`), so such a row reaches this page. This arm
 *     is what makes the rule hold on the kind-agnostic property that actually
 *     decides whether the merchant is owed or owes.
 *
 * It reads NO date. `is_credit` must never be derivable from `days_past_due`
 * being zero: a debit invoice due exactly ON the as-of date has
 * `days_past_due = 0` and is NOT a credit.
 */
const CREDIT_BEARING_SQL = `(i.document_kind = 'credit_note' OR o.outstanding_txn_minor < 0)`;

/** One customer row, or null. Read through RLS as `daftar_app`, like every merchant read. */
export async function findCustomer(db: Database, scope: { tenantId: string; businessId: string }, customerId: string): Promise<CustomerRow | null> {
  const found = await db.scoped<CustomerRow>(
    { tenantId: scope.tenantId, businessId: scope.businessId },
    `SELECT ${CUSTOMER_COLUMNS} FROM customers c WHERE c.business_id = $1 AND c.id = $2`,
    [scope.businessId, customerId],
  );
  return found.rows[0] ?? null;
}

export function customerContactDto(row: ContactRow): CustomerContactDto {
  return {
    contactId: row.id,
    contactNo: row.contact_no,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    isPrimary: row.is_primary,
  };
}

export function customerDto(row: CustomerRow, contacts: readonly CustomerContactDto[]): CustomerDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    contacts: [...contacts],
  };
}

/**
 * One row of `customer_ar_aging(...)` as this module selects it: the SQL
 * function's `RETURNS TABLE` (`0084`, §6) with the two money columns cast to
 * text, because a cumulative receivable exceeds 2^53 long before it exceeds
 * what a merchant can earn.
 */
export interface CustomerAgingSqlRow {
  /**
   * **1-BASED.** `customer_ar_aging` computes `1 + <count of supplied
   * thresholds the invoice's days-past-due exceeds>`, so for
   * `bucketDays = [30, 60, 90]` the four bands arrive as 1, 2, 3, 4 — and 4 is
   * the oldest band, `over-90`, not an overflow.
   *
   * **NULLABLE since DR-39**, and the null is the FULL JOIN's doing rather
   * than the aging routine's: a per-currency counter row that no band matches
   * arrives with no band at all. That is impossible in a correct database and
   * REPRESENTABLE in a row set, so the ordinal guard in `foldCustomerAging`
   * refuses it instead of placing it somewhere.
   */
  bucket_no: number | null;
  currency_code: string | null;
  txn_minor: string | null;
  /** Nullable for the same reason as `bucket_no`: a counter row carries no band money. */
  base_minor: string | null;
  /** Likewise. */
  invoice_count: number | null;
  /**
   * HOW MANY DISTINCT OPEN DEBIT DOCUMENTS THIS CURRENCY HAS — balance `> 0`
   * (DR-39, amending DR-29). A PER-CURRENCY figure repeated on every band row
   * of that currency, because a `RETURNS TABLE` has nowhere else to put one.
   *
   * It does NOT come from `customer_ar_aging`. That routine's return shape is
   * pinned by the owner's section 25 ruling, and the P4-S7 specification
   * installs its body with `CREATE OR REPLACE FUNCTION`, which cannot change a
   * `RETURNS TABLE` list at all (42P13) — so extra columns were never
   * available. It comes from `customer_ar_open_document_counts`, joined on in
   * the same statement, which measures `count(DISTINCT invoice_id)` under an
   * explicit sign filter over the same population the bands are built from.
   *
   * It is NOT the sum of `invoice_count`, and it is not any function of the
   * per-band counts: since P4-S7 one invoice is aged across its instalment
   * schedule, so it reaches several bands and that sum counts it once per band.
   *
   * `null` is the FULL JOIN's other orphan — a band row whose currency the
   * counters do not know about — and is refused, not defaulted to zero.
   */
  open_debit_count: number | null;
  /**
   * HOW MANY DISTINCT OPEN CREDIT DOCUMENTS THIS CURRENCY HAS — balance `< 0`,
   * which is where an overpaid invoice's credit sits (DR-23).
   *
   * **NEVER ADDED TO `open_debit_count`** (DR-39 rule 5): a document at
   * exactly zero is counted in neither, so the sum is not the number of open
   * documents.
   */
  open_credit_count: number | null;
}

/**
 * ONE ROW OF `customer_ar_aging(...)` AS A CORRECT DATABASE YIELDS IT: the
 * wire row above with every column present.
 *
 * It is DERIVED from `CustomerAgingSqlRow` and not declared beside it, so the
 * two cannot drift: a column added to the wire row appears here with no edit,
 * and a column that stops being nullable there stops being narrowed here. Two
 * hand-written interfaces would have let a later field exist in one and not
 * the other — silently, and in a money row.
 *
 * WHY THE NAME EXISTS AT ALL. Since DR-39 the read is a `FULL JOIN` of the
 * bands against the per-currency document counters, so every column is
 * nullable in the WIRE type — a counter row that no band matches arrives with
 * no band, and a band row whose currency the counters do not know about
 * arrives with no counters. Both are impossible in a correct database and
 * representable in a row set, and `foldCustomerAging` REFUSES them
 * (`customer.aging_bucket_mapping_invalid`) rather than placing them
 * somewhere.
 *
 * That makes the nullability a fact about the JOIN, not about the data a
 * caller constructs. A test fixture, an oracle, or any other producer that
 * builds the rows a correct database would return should say so in its type
 * and read the columns without re-deciding, per field, what a null would have
 * meant — because `?? 0`, `?? -1` and `!` are each a silent answer to a
 * question this module answers loudly in exactly one place.
 *
 * IT ASSERTS COMPLETENESS AND NEVER VALIDITY. Every column is present; what
 * the columns SAY is still the fold's business. A row typed this way may carry
 * `bucket_no = 0`, an ordinal past the last band, a fractional counter or a
 * negative one, and `foldCustomerAging` refuses each — which is the sharper
 * statement, because a case built on a total row isolates the ordinal, or the
 * counter, as the single defect instead of leaving a reader to wonder whether
 * the refusal was really about a column that never arrived.
 *
 * ASSIGNABLE TO `CustomerAgingSqlRow`, never the reverse: a producer of total
 * rows can always feed the fold, and a row set that may carry the JOIN's
 * orphans can never be read as though it cannot. `tests/guards/
 * p4s4-customer-aging-bucket-mapping.test.ts` §0 pins both directions.
 */
export type CustomerAgingBandRow = {
  [K in keyof CustomerAgingSqlRow]-?: NonNullable<CustomerAgingSqlRow[K]>;
};

/**
 * THE ONE PLACE A DEGENERATE AGING ROW IS REFUSED, and the one that hands the
 * fold below a TOTAL row.
 *
 * Since DR-39 the read is a `FULL JOIN` of the bands against the per-currency
 * document counters, so the wire row's every column is nullable for a reason
 * that has nothing to do with the data: a counter row that no band matches
 * arrives with no band, and a band row whose currency the counters do not know
 * about arrives with no counters. Both are impossible in a correct database
 * and representable in a row set.
 *
 * The seven checks live HERE, together, rather than beside each of the reads
 * downstream. That is not tidiness. A null test next to a read invites the
 * reader to answer "and what if it is missing?" locally — with `?? 0`, `?? -1`
 * or a cast — and each of those is a silent answer, in a different direction,
 * to a question this module answers loudly once. Seven checks in one function
 * are a boundary; seven checks spread over a fold are seven chances to guess.
 *
 * IT CHECKS COMPLETENESS AND NOTHING ELSE. Whether `bucket_no` is in range,
 * whether a counter is a non-negative integer, and whether the rows of one
 * currency agree with each other are all judgements about what the columns
 * SAY, they need the bucket count and the accumulated map, and they stay in
 * the fold. This function only establishes that there is something to judge.
 *
 * NO CAST. The narrowing is done by seven `=== null` tests over locals, so the
 * returned object is built from values the compiler has already proved
 * non-null. `!`, `as` and `any` would each have moved the claim from the
 * compiler to the author.
 */
function bandRowOrRefuse(row: CustomerAgingSqlRow, rowIndex: number): CustomerAgingBandRow {
  const bucketNo = row.bucket_no;
  if (bucketNo === null) throw agingRowRefusal(rowIndex, 'bucket_no');
  // And a counter row with no currency has no key, so it cannot be placed
  // per currency at all; filing it under some other currency's name would
  // be a guess about which merchant's figure it belongs to. The reasoning
  // moved here with the check when the seven were gathered into one
  // boundary; `dr39-open-document-counts.test.ts` (dr39_17) pins it to this
  // module, not to a particular line of it.
  //
  // UNREACHABLE FROM `aging()`, AND KEPT ANYWAY. That reader selects
  // `coalesce(a.currency_code, c.currency_code)`, which is null only when BOTH
  // sides are, and a row with neither side does not exist — so this arm cannot
  // fire for the one caller in this module today, and `aging()` below is the
  // ONLY production caller there is: the fold is exported, but nothing else in
  // `apps` or `packages` calls it. What exercises this arm today is a test.
  //
  // So it is defence in depth for a caller that MAY one day exist — not for
  // callers that do — and for the day that `coalesce` is dropped. Read the arm
  // as "this cannot happen and is refused regardless", not as a live branch.
  const currencyCode = row.currency_code;
  if (currencyCode === null) throw agingRowRefusal(rowIndex, 'currency_code');
  const txnMinor = row.txn_minor;
  if (txnMinor === null) throw agingRowRefusal(rowIndex, 'txn_minor');
  const baseMinor = row.base_minor;
  if (baseMinor === null) throw agingRowRefusal(rowIndex, 'base_minor');
  const invoiceCount = row.invoice_count;
  if (invoiceCount === null) throw agingRowRefusal(rowIndex, 'invoice_count');
  const openDebitCount = row.open_debit_count;
  if (openDebitCount === null) throw agingRowRefusal(rowIndex, 'open_debit_count');
  const openCreditCount = row.open_credit_count;
  if (openCreditCount === null) throw agingRowRefusal(rowIndex, 'open_credit_count');
  return {
    bucket_no: bucketNo,
    currency_code: currencyCode,
    txn_minor: txnMinor,
    base_minor: baseMinor,
    invoice_count: invoiceCount,
    open_debit_count: openDebitCount,
    open_credit_count: openCreditCount,
  };
}

/**
 * The refusal a degenerate row leaves through, NAMING THE ROW — and naming it
 * where the merchant cannot see it.
 *
 * The code, the status and the generic sentence are exactly what every other
 * refusal in this module carries, because that is the client contract:
 * `details` is `{ sellingCode }` and nothing else, and the message is the safe
 * sentence the client replaces with its own localized text. `details` is
 * serialized into `ApiErrorBody`, so the offending column's NAME must not go
 * there — an internal column name is "written for an engineer reading a log
 * and not for a merchant reading a screen", and a read that leaks the shape of
 * its own query to a browser has told the reader nothing and everyone else
 * something.
 *
 * So the row and the column travel on `cause`, which `ApiErrorBody` has no
 * field for and no serializer reaches. The wire answer is byte-identical to
 * the refusal this module already produced; what is new is that whoever reads
 * the error object knows WHICH row of the result set was malformed and in
 * WHICH column, instead of knowing only that one of them was.
 */
function agingRowRefusal(rowIndex: number, column: keyof CustomerAgingSqlRow): AppError {
  const refusal = sellingRefusal('customer.aging_bucket_mapping_invalid');
  refusal.cause = `customer_ar_aging row ${String(rowIndex)} carries no ${column}: the FULL JOIN against the per-currency document counters left it out, which a correct database cannot do`;
  return refusal;
}

/** The bucket SHAPE a fold folds into: the labels and the boundaries they came from. */
export interface CustomerAgingShape {
  /** `agingBucketLabels(bucketDays)` — length is `bucketDays.length + 1`. */
  readonly labels: readonly string[];
  /** The caller's supplied, ascending boundaries. */
  readonly bucketDays: readonly number[];
}

/**
 * The SQL rows of `customer_ar_aging(...)` folded into the DTO's buckets and
 * the one total the screen shows as the customer's aged debt.
 *
 * ── THE ORDINAL BASE, WHICH IS THE WHOLE POINT OF THIS FUNCTION ──────────
 *
 * `bucket_no` is 1-BASED and `labels` is a 0-based array, so the mapping is
 * `bucketIndex = bucket_no - 1`. It used to be written `buckets[r.bucket_no]`
 * followed by `if (bucket === undefined) continue`, and that was a financial
 * defect in two directions at once:
 *
 *   1. the OLDEST band — `bucket_no = bucketDays.length + 1` — indexed one
 *      past the end of `labels` and was SILENTLY SKIPPED. Its money left
 *      `baseMinor`, its invoices left `invoiceCount` and its amount left
 *      `totalBaseMinor`, so a customer whose whole debt sat in that band had
 *      an aged debt that read as ZERO — reported as not existing, not as
 *      current;
 *   2. index 0 — the FIRST band, which holds invoices up to `bucketDays[0]`
 *      days past due AND, because `customer_ar_aging` computes
 *      `1 + count(thresholds where (p_as_of - due_date) > threshold)` and
 *      days-past-due goes negative, those not yet due as well — was
 *      UNREACHABLE, because the SQL's smallest `bucket_no` is 1. So no band
 *      ever held its own money: every surviving band carried the PREVIOUS
 *      band's.
 *
 * ── AND WHY THERE IS NO `continue` HERE ──────────────────────────────────
 *
 * «It can drop money from the report with no sound, and that is unacceptable»
 * (TL, this fix). A read that cannot place a row has met a disagreement
 * between the SQL function's ordinal base and this module's, which is a
 * DEFECT and not a merchant outcome, so it is refused as
 * `customer.aging_bucket_mapping_invalid` — a 500 through this module's one
 * refusal channel, `sellingRefusal`, exactly as the cart's internal
 * invariants are (TL-P4-S2-R5). Loud and short is the only acceptable
 * failure mode for a figure a merchant chases a customer with.
 *
 * ── AND THE SHAPE INVARIANT, BECAUSE THIS FUNCTION IS PUBLIC ─────────────
 *
 * `labels.length` MUST be `bucketDays.length + 1`. `agingBucketLabels` always
 * produces exactly that, so `aging()` cannot break it — but this function is
 * EXPORTED, and a caller passing a longer `labels` used to read
 * `bucketDays[i - 1]` past the end and emit **`fromDays: NaN` into a money
 * DTO**: `undefined + 1` is `NaN`, `NaN` leaves `JSON.stringify` as `null`,
 * and a band whose lower bound is missing is a band no merchant can read.
 *
 * The two `as number` casts that used to sit on those reads are GONE. They
 * defeated `noUncheckedIndexedAccess` at precisely the two places it would
 * have caught this, and a cast is the kind of thing a reviewer does not look
 * behind. The boundaries are now read, checked, and used — the compiler's
 * objection answered rather than asserted away.
 *
 * Four invariants per ROW, before anything is added: `bucket_no` is an
 * integer, it is `>= 1`, it is `<= buckets.length`, and the bucket the mapped
 * index names exists. The fourth is not redundant with the third — the
 * compiler is right that an array read can answer `undefined`, and a HOLE in
 * a sparse `labels` is exactly that while leaving `length` intact.
 *
 * PURE: no database, no Nest, no clock, no module state. It is called once by
 * `CustomerReadService.aging` and is otherwise exercised directly by
 * `tests/guards/p4s4-customer-aging-bucket-mapping.test.ts`.
 */
export function foldCustomerAging(
  rows: readonly CustomerAgingSqlRow[],
  shape: CustomerAgingShape,
): { buckets: CustomerAgingBucketDto[]; totalBaseMinor: string; openCounts: CustomerOpenDocumentCountsDto[] } {
  if (shape.labels.length !== shape.bucketDays.length + 1) {
    throw sellingRefusal('customer.aging_bucket_mapping_invalid');
  }

  const buckets: CustomerAgingBucketDto[] = shape.labels.map((label, i) => {
    const previousBoundary = i === 0 ? null : shape.bucketDays[i - 1];
    const upperBoundary = i < shape.bucketDays.length ? shape.bucketDays[i] : null;
    if (previousBoundary === undefined || upperBoundary === undefined) {
      throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    }
    return {
      label,
      // `null` and not `0` for the first band: it has NO lower bound. Its
      // members are the invoices whose days-past-due does not exceed
      // `bucketDays[0]`, and that figure is negative for everything not yet
      // due, so `0` was a false statement about which money the band holds
      // (DR-10). Under the standard `[0, 30, 60, 90]` this band IS the not-due
      // one; under a caller's own `[30, 60, 90]` it is the one that mixes.
      fromDays: previousBoundary === null ? null : previousBoundary + 1,
      toDays: upperBoundary,
      baseMinor: '0',
      byCurrency: [],
      invoiceCount: 0,
    };
  });

  let totalBaseMinor = 0n;
  // ── THE PER-CURRENCY DOCUMENT COUNTERS, READ AND NOT COMPUTED (DR-39) ──
  //
  // Keyed by currency, because DR-39 makes both counters distinct at the level
  // of the CUSTOMER AND THE CURRENCY. An empty map is the empty answer and it
  // is a STATEMENT: no rows at all means no currency has an open document, and
  // this function says so with `[]` rather than inventing a row of zeroes
  // under the base currency — "the customer has nothing open" and "the rows
  // forgot to say" must not arrive as the same answer.
  //
  // Every band row OF ONE CURRENCY carries the SAME pair. If two disagree the
  // answer is malformed, and the module's one refusal for "these aging rows
  // are not a valid answer" is the channel for it. Taking the first, the
  // largest or the last would be inventing a money-adjacent figure out of a
  // contradiction, and a count a merchant reads next to a total is not a
  // place to guess.
  //
  // THE TWO ARE NEVER ADDED (DR-39 rule 5). A document at exactly zero is
  // counted in neither, so their sum is not the number of open documents, and
  // nothing in this module computes it.
  const openCounts = new Map<string, CustomerOpenDocumentCountsDto>();
  for (const [rowIndex, wireRow] of rows.entries()) {
    // COMPLETENESS FIRST, in one place, and before any figure on the row is
    // read: `bandRowOrRefuse` catches the FULL JOIN's orphans in both
    // directions — the counter row with no band and the band row with no
    // counters — and names the offending row and column on the refusal. From
    // here down `r` is a TOTAL row, so nothing below asks again whether a
    // column arrived; every test below is about what the columns SAY.
    const r = bandRowOrRefuse(wireRow, rowIndex);
    // The ordinal, which is a judgement about the value and not about its
    // presence: the SQL function's base must agree with this module's.
    //
    // READ OFF `r` DIRECTLY, as it was before DR-39 made the columns nullable.
    // DR-39 had to copy each column into a local to narrow it, and copying
    // `r.bucket_no` into `bucketNo` silently retired a C-1 guard:
    // `phase4-s7-installment-aging.test.ts:1568` pins the literal
    // `buckets[r.bucket_no - 1]` as the proof that the oldest band's money
    // still maps one-based, and a local made that text — and so the guard's
    // positive half — disappear while the negative half went on passing. The
    // boundary above is what lets these reads be total again, so the
    // expressions the guards were written against come back rather than the
    // guards being rewritten around a refactor.
    if (!Number.isInteger(r.bucket_no) || r.bucket_no < 1 || r.bucket_no > buckets.length) {
      throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    }
    const debit = r.open_debit_count;
    const credit = r.open_credit_count;
    // A counter that is not a count. A negative DOCUMENT COUNT is not a credit
    // balance — it is a malformed answer, and it is never read as zero,
    // because zero documents is a claim and this would be the absence of one.
    if (!Number.isInteger(r.open_debit_count) || debit < 0) throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    if (!Number.isInteger(r.open_credit_count) || credit < 0) throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    const seen = openCounts.get(r.currency_code);
    if (seen === undefined) {
      openCounts.set(r.currency_code, { currency: r.currency_code, openDebitCount: debit, openCreditCount: credit });
    } else if (seen.openDebitCount !== debit || seen.openCreditCount !== credit) {
      throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    }
    const baseMinor = r.base_minor;
    const invoiceCount = r.invoice_count;
    if (!Number.isInteger(invoiceCount)) {
      throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    }
    const bucket = buckets[r.bucket_no - 1];
    if (bucket === undefined) throw sellingRefusal('customer.aging_bucket_mapping_invalid');
    bucket.baseMinor = (BigInt(bucket.baseMinor) + BigInt(baseMinor)).toString();
    bucket.invoiceCount += invoiceCount;
    totalBaseMinor += BigInt(baseMinor);
    bucket.byCurrency.push({ currency: r.currency_code, txnMinor: r.txn_minor });
  }

  return {
    buckets,
    totalBaseMinor: totalBaseMinor.toString(),
    // SORTED by currency, so one answer is one answer: a client diffing two
    // reads must not see a reordering as a change.
    //
    // The sort is what guarantees that, and the previous wording said the
    // opposite — that insertion order "is the row order, which is the
    // database's". Insertion order here IS the row order, but row order is
    // only as stable as the reader's `ORDER BY`, and resting a client-visible
    // sequence on it would make the guarantee the planner's to keep. The sort
    // is the guarantee; insertion order is merely what it replaces.
    openCounts: [...openCounts.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
  };
}

@Injectable()
export class CustomerReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private scope(m: MembershipContext): { tenantId: string; businessId: string } {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  /**
   * `GET /v1/customers` — a keyset page ordered `(name, id)` so the merchant's
   * own alphabet drives the list, with `id` as the tiebreak that makes the walk
   * append-stable. A customer created during the walk appears only if it sorts
   * after the cursor; none is ever repeated or skipped.
   */
  async list(m: MembershipContext, q: CustomerListQuery): Promise<CustomerPageDto> {
    const size = q.limit ?? DEFAULT_LIMIT;
    const found = await this.db.scoped<CustomerListItemDto & QueryResultRow & { created_at: Date; updated_at: Date; primary_contact_name: string | null }>(
      this.scope(m),
      `SELECT c.id, c.name, c.phone, c.email, c.status, c.revision, c.created_at, c.updated_at,
              (SELECT k.name FROM customer_contacts k
                WHERE k.business_id = c.business_id AND k.customer_id = c.id AND k.is_primary
                ORDER BY k.contact_no LIMIT 1) AS primary_contact_name
         FROM customers c
        WHERE c.business_id = $1
          AND ($2::text IS NULL OR c.status = $2)
          AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' ESCAPE '\\')
          AND ($4::uuid IS NULL OR (c.name, c.id) > (SELECT p.name, p.id FROM customers p WHERE p.business_id = $1 AND p.id = $4))
        ORDER BY c.name, c.id
        LIMIT $5`,
      [m.businessId, q.status ?? null, q.search === undefined ? null : likeEscaped(q.search), q.cursor ?? null, size + 1],
    );
    const page = found.rows.slice(0, size);
    return {
      items: page.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        email: r.email,
        status: r.status,
        revision: r.revision,
        primaryContactName: r.primary_contact_name,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      nextCursor: found.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** `GET /v1/customers/:customerId`, with its contacts in `contactNo` order. */
  async get(m: MembershipContext, customerId: string): Promise<CustomerDto> {
    const row = await findCustomer(this.db, this.scope(m), customerId);
    if (row === null) throw sellingRefusal('customer.not_found');
    const contacts = await this.db.scoped<ContactRow>(
      this.scope(m),
      `SELECT k.customer_id, k.id, k.contact_no, k.name, k.phone, k.email, k.notes, k.is_primary
         FROM customer_contacts k
        WHERE k.business_id = $1 AND k.customer_id = $2
        ORDER BY k.contact_no`,
      [m.businessId, customerId],
    );
    return customerDto(row, contacts.rows.map(customerContactDto));
  }

  /**
   * `GET /v1/customers/:customerId/receivable` — the live AR of one customer,
   * derived from the ledger through `customer_ar_outstanding(...)`.
   *
   * The base figure and the per-currency figures come from the SAME function
   * call, so the two halves of one answer cannot disagree — the
   * `payableSql`/`purchase_ap_outstanding` discipline of P3-S7 T-05 applied to
   * the customer side.
   */
  async receivable(m: MembershipContext, customerId: string): Promise<CustomerReceivableDto> {
    const row = await findCustomer(this.db, this.scope(m), customerId);
    if (row === null) throw sellingRefusal('customer.not_found');
    const baseCurrency = await readBaseCurrency(this.db, this.scope(m));
    const found = await this.db.scoped<{ currency_code: string | null; txn_minor: string | null; base_minor: string }>(
      this.scope(m),
      `SELECT r.currency_code, r.txn_minor::text AS txn_minor, r.base_minor::text AS base_minor
         FROM customer_ar_outstanding($1::uuid, $2::uuid) r
        ORDER BY r.currency_code NULLS FIRST`,
      [m.businessId, customerId],
    );
    let baseMinor = 0n;
    const byCurrency: CustomerCurrencyAmountDto[] = [];
    for (const r of found.rows) {
      baseMinor += BigInt(r.base_minor);
      if (r.currency_code !== null && r.txn_minor !== null) byCurrency.push({ currency: r.currency_code, txnMinor: r.txn_minor });
    }
    return { customerId, baseMinor: baseMinor.toString(), baseCurrency, byCurrency };
  }

  /**
   * `GET /v1/customers/:customerId/receivable/aging` — the same AR, split by
   * how long each open invoice has been past due at the SUPPLIED as-of date,
   * into the SUPPLIED buckets.
   *
   * Both inputs are the caller's: the lock's §4 matrix makes aging "the AR
   * journal plus a **supplied** as-of date | computed", forbids a materialised
   * aging table, and decides no bucket policy — so the server invents neither
   * the date nor the boundaries. Nothing is written and nothing is memoized.
   */
  async aging(m: MembershipContext, customerId: string, q: CustomerAgingQuery): Promise<CustomerAgingDto> {
    const row = await findCustomer(this.db, this.scope(m), customerId);
    if (row === null) throw sellingRefusal('customer.not_found');
    const baseCurrency = await readBaseCurrency(this.db, this.scope(m));
    const labels = agingBucketLabels(q.bucketDays);
    const found = await this.db.scoped<CustomerAgingSqlRow & QueryResultRow>(
      this.scope(m),
      // ONE statement, and `AS MATERIALIZED` is DEFENSIVE here rather than
      // load-bearing — the honest description, since nothing in this tree has
      // measured it doing anything (DR-29, DR-39).
      // The per-currency open-document counters are document-level figures the
      // aging routine cannot return — its shape is pinned and its body is
      // installed with `CREATE OR REPLACE`, which cannot change a
      // `RETURNS TABLE` (42P13) — so they are joined on here rather than
      // fetched in a second round trip that would pay row-security setup twice
      // for two integers per currency.
      //
      // Without `MATERIALIZED` a STABLE set-returning call MAY be
      // re-evaluated, which would re-scan this customer's invoices once per
      // band. Two reasons to expect it changes nothing as the query stands:
      // `c` is referenced ONCE, and PostgreSQL 12+ inlines a single-reference
      // CTE by default, so the keyword mostly forbids an inlining that would
      // not have duplicated the scan anyway; and on the `FULL JOIN` side the
      // function scan appears once in the plan regardless. So it is kept as a
      // guard against a later edit that references `c` twice, NOT as a
      // measured optimisation — ONLY `EXPLAIN (ANALYZE)` on a real database
      // settles what the planner does, and that is NOT RUN.
      //
      // What IS certain from the text: the customer's invoices are visited by
      // the aging routine and again by the counts routine. Two settlement
      // computations over one population is the cost DR-39 chose, and the
      // aging endpoint's performance budget has not been re-measured since.
      //
      // AND THE JOIN IS `FULL`, DELIBERATELY. A `LEFT JOIN` from the bands
      // onto the counters would silently lose a currency the counters know
      // about and the bands do not; the reverse direction would lose the
      // other. Both are impossible in a correct database — every non-zero
      // open document lands in some band, and every banded currency has
      // counters — and both are REPRESENTABLE in a row set. A `FULL JOIN`
      // makes each orphan ARRIVE, with a null where its missing side would
      // have been, and `foldCustomerAging` refuses it. A row this read cannot
      // place is a defect, and the one thing it must never be is a `continue`.
      `WITH c AS MATERIALIZED (
         SELECT d.currency_code, d.open_debit_count, d.open_credit_count
           FROM public.customer_ar_open_document_counts($1::uuid, $2::uuid) d)
       SELECT a.bucket_no,
              coalesce(a.currency_code, c.currency_code) AS currency_code,
              a.txn_minor::text AS txn_minor, a.base_minor::text AS base_minor, a.invoice_count,
              c.open_debit_count, c.open_credit_count
         FROM customer_ar_aging($1::uuid, $2::uuid, $3::date, $4::integer[]) a
         FULL JOIN c ON c.currency_code = a.currency_code
        ORDER BY a.bucket_no NULLS FIRST, coalesce(a.currency_code, c.currency_code) NULLS FIRST`,
      [m.businessId, customerId, q.asOf, q.bucketDays],
    );

    // The fold — and the 1-based → 0-based mapping — lives in
    // `foldCustomerAging` above, which is pure and is exercised without a
    // database. This method holds the query and the envelope only.
    const { buckets, totalBaseMinor, openCounts } = foldCustomerAging(found.rows, { labels, bucketDays: q.bucketDays });

    return { customerId, asOf: q.asOf, baseCurrency, bucketDays: [...q.bucketDays], buckets, totalBaseMinor, openCounts };
  }

  /**
   * `GET /v1/customers/:customerId/open-invoices` — the customer's documents
   * that still have something outstanding at the supplied as-of date, oldest
   * first, for the picker `OD-P4-03` requires.
   *
   * `outstanding` and `settlementState` are the SQL functions' answers, not this
   * module's. `daysPastDue` is measured from the invoice's AGE ANCHOR to the
   * supplied as-of date, in the database, so one date arithmetic serves the read
   * and the aging.
   *
   * ── THE AGE ANCHOR IS `coalesce(due_date, issue_date)` (DR-28) ───────────
   *
   * It used to be the due date alone, with a `CASE` that returned NULL when the
   * invoice named none. That was a MONEY DEFECT, not a display nicety. Under
   * DR-13 and DR-21 a termless invoice is due from its ISSUE date, and
   * `customer_ar_aging` (`0084`) bands it on exactly that fallback — so the
   * same termless invoice came back from the aging report in the over-90
   * band and from THIS page with no age at all. The page hid the age the
   * report asserted, and the merchant acts on the page.
   *
   * So both readers now anchor on the same expression, and `NULL` is
   * UNREACHABLE here rather than merely unlikely: `invoices.issue_date` is
   * `DATE NOT NULL` (`0075`) and `customer_open_invoices_page` RETURNS it, so
   * neither arm of the `coalesce` can be null and the subtraction has no null
   * operand. The row type above says `number`, not `number | null`, and the
   * contract field is `number` too, so a null would not typecheck through the
   * mapping even if SQL produced one.
   *
   * The substitution is SIGNED. `invoices_due_date_ck` enforces
   * `due_date IS NULL OR due_date >= issue_date`, so falling back to the issue
   * date can only ever report an invoice as the same age or OLDER, never
   * younger. For a receivable that is the safe direction: the error, if any, is
   * toward noticing a debt rather than toward losing one.
   *
   * "No stated due date" is still shown to the merchant, but as a SEPARATE
   * field — `has_explicit_due_date`, which is `o.due_date IS NOT NULL` and
   * nothing else. It is deliberately NOT derived from the age: an age of zero
   * (the as-of date IS the anchor) and a negative age (before it) are ordinary
   * and must never be read as a missing term. And no NEW column is read for it
   * and no join is added — `due_date` and `issue_date` both already come off
   * the page reader, so the single visit R-104/R-106 bought is intact and this
   * change needs no migration.
   *
   * ── A CREDIT IS NOT OVERDUE DEBT (DR-31) ─────────────────────────────────
   *
   * DR-28 settled the anchor for a DEBIT document and raised the question it
   * could not answer: after it, a credit-bearing row began reporting a POSITIVE
   * `days_past_due` where it had reported `null`. DR-31 answers it, and the two
   * decisions do not collide — DR-28 governs "an invoice that is DUE", and a
   * credit is not due from the customer at all. So:
   *
   *  - `age_days = $3::date - o.issue_date` for EVERY document: the document's
   *    OWN date, with no term in it and no fallback needed, because
   *    `issue_date` is `DATE NOT NULL`. This is the figure a client renders as
   *    "a credit balance on an invoice X days old" (DR-35: the
   *    wording names the INVOICE, because the number is the document's age
   *    and not the credit's).
   *  - `days_past_due` is for DEBIT documents only. For a credit it is forced
   *    to a literal `0` — not negated, not clamped, not null — and `is_credit`
   *    travels beside it so the interface says "credit balance", never
   *    "overdue". A DEBIT row's figure is byte-for-byte the DR-28 expression,
   *    in the `ELSE` arm, so every case DR-28 pinned still holds.
   *  - `is_credit` comes from `CREDIT_BEARING_SQL` above — kind or sign, never
   *    the age. See that constant for why each arm is written the way it is.
   *
   * NO AMOUNT MOVES. The three money columns are the same passthrough they
   * were, `customer_open_invoices_page`'s `<> 0` filter is untouched, and no
   * total anywhere is recomputed: DR-31 changes what a date column REPORTS, not
   * what the customer owes.
   *
   * ── WHY THIS ASKS `customer_open_invoices_page` (`0084`, R-105/R-106) ─────
   *
   * It used to ask for the page by driving `FROM invoices i`, joining
   * `invoice_outstanding(i.business_id, i.id)` as a `LATERAL ... ON TRUE`, and
   * then — THE DEFECT — adding the business predicate "outstanding is not
   * zero" to the `WHERE` clause as a test on that lateral's OUTPUT column,
   * under `ORDER BY i.issue_date, i.id LIMIT $n`. (The predicate is described
   * rather than quoted on purpose: the §11 guard in
   * `tests/performance/receivables-open-page-equivalence.test.ts` greps this
   * tree for its exact text, and a guard that greps cannot tell a quotation in
   * a comment from a live filter — so a comment that quoted it would redden
   * the guard, correctly.)
   *
   * The filter was on the FUNCTION'S OUTPUT, so the `LIMIT` could not
   * short-circuit the walk: PostgreSQL had to run the settlement sum for every
   * candidate invoice in page order until `$n` of them survived. Measured on
   * PostgreSQL 16.13 as `daftar_app` with row security applied, over a customer
   * with 1 500 cash-settled invoices and 60 genuinely open ones: **970.845 ms
   * and 1 551 LATERAL loops to return 51 rows**, against a 100 ms ceiling.
   *
   * `0080` is what makes it bite rather than merely cost. A cash-settled invoice
   * keeps `status = 'open'` — the status is the DOCUMENT's lifecycle, not its
   * settlement — and reports outstanding 0, so a shop that sells mostly for cash
   * accumulates permanently FAILING candidates: rows the predicate reaches, pays
   * the full settlement computation for, and discards. The same is true of a
   * fully paid CREDIT invoice, which no table predicate can tell from an unpaid
   * one.
   *
   * So the page is now asked of `customer_open_invoices_page`, which walks the
   * candidates in BOUNDED CHUNKS and makes ONE set-based call to the one
   * definition of the settlement sum per chunk. The same two arms measure
   * **49.591 ms with 1 page-reader call and 1 chunk** (cash) and **87.068 ms
   * with 1 page-reader call and 8 chunks** (settled credit).
   *
   * **This module still holds none of the money.** Every figure here comes out
   * of that function; there is no copy of the arithmetic, no stored or cached
   * balance, and no second formula. `settlementState` is deliberately NOT
   * returned by the page reader — deriving it there would be a second copy of
   * the state law — so it is still asked of `invoice_settlement_state`, which
   * then runs only for the rows actually returned.
   *
   * **The join to `invoices` is bounded by the PAGE, not by the business**,
   * which is the whole difference from the re-join `0084` removed from the AR
   * readers. It is an `invoices_pkey` probe per returned row — measured as a
   * Nested Loop of 51 loops — and it recovers only `document_kind`,
   * `document_number` and `total_txn_minor`. `issueDate`, `dueDate` and
   * `currency` come off the page reader itself.
   *
   * **The cursor stays the invoice id** (§14: the public API shape does not
   * change). The continuation key is `(issue_date, id)`, and under the
   * coordinator's AMENDMENT 1 (A1-2, A1-3) the id's issue date is resolved
   * INSIDE the reader through the primary key rather than here: the cursor is
   * present exactly when the id is non-null, so this module passes the id with
   * a NULL date and makes NO resolution query of its own. That keeps every
   * ordering component in the continuation key without adding back a
   * per-request read of `invoices` under row security — the very kind of read
   * this correction is busy removing. There is no `OFFSET`, and the `limit + 1`
   * probe for `nextCursor` is unchanged.
   *
   * A cursor id that resolves to nothing — including another business's id,
   * which row security hides — yields an EMPTY page rather than a refusal. The
   * reader adds no `P0001` of its own by design; the only refusal reachable
   * through it is `invoice.not_found` from the one definition, and
   * `customer.not_found` above it is this module's own and unchanged.
   */
  async openInvoices(m: MembershipContext, customerId: string, q: CustomerOpenInvoicesQuery): Promise<CustomerOpenInvoicesDto> {
    const row = await findCustomer(this.db, this.scope(m), customerId);
    if (row === null) throw sellingRefusal('customer.not_found');
    const size = q.limit ?? DEFAULT_LIMIT;
    const found = await this.db.scoped<
      QueryResultRow & {
        invoice_id: string;
        document_kind: 'invoice' | 'credit_note';
        document_number: string;
        issue_date: string;
        due_date: string | null;
        currency_code: string;
        total_txn_minor: string;
        outstanding_txn_minor: string;
        outstanding_base_minor: string;
        settlement_state: 'unpaid' | 'partial' | 'paid';
        days_past_due: number;
        has_explicit_due_date: boolean;
        age_days: number;
        is_credit: boolean;
      }
    >(
      this.scope(m),
      `SELECT o.invoice_id, i.document_kind, i.document_number,
              to_char(o.issue_date, 'YYYY-MM-DD') AS issue_date,
              to_char(o.due_date, 'YYYY-MM-DD') AS due_date,
              o.currency_code, i.total_txn_minor::text AS total_txn_minor,
              o.outstanding_txn_minor::text AS outstanding_txn_minor,
              o.outstanding_base_minor::text AS outstanding_base_minor,
              invoice_settlement_state(i.business_id, i.id) AS settlement_state,
              ($3::date - o.issue_date) AS age_days,
              CASE WHEN ${CREDIT_BEARING_SQL} THEN 0
                   ELSE ($3::date - coalesce(o.due_date, o.issue_date)) END AS days_past_due,
              ${CREDIT_BEARING_SQL} AS is_credit,
              (o.due_date IS NOT NULL) AS has_explicit_due_date
         FROM customer_open_invoices_page($1, $2, NULL::date, $4::uuid, $5) o
         JOIN invoices i ON i.business_id = $1 AND i.id = o.invoice_id
        ORDER BY o.issue_date, o.invoice_id`,
      [m.businessId, customerId, q.asOf, q.cursor ?? null, size + 1],
    );
    const page = found.rows.slice(0, size);
    const items: CustomerOpenInvoiceDto[] = page.map((r) => ({
      invoiceId: r.invoice_id,
      documentKind: r.document_kind,
      documentNumber: r.document_number,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      currency: r.currency_code,
      totalTxnMinor: r.total_txn_minor,
      outstandingTxnMinor: r.outstanding_txn_minor,
      outstandingBaseMinor: r.outstanding_base_minor,
      settlementState: r.settlement_state,
      daysPastDue: r.days_past_due,
      hasExplicitDueDate: r.has_explicit_due_date,
      ageDays: r.age_days,
      isCredit: r.is_credit,
    }));
    return {
      customerId,
      asOf: q.asOf,
      items,
      nextCursor: found.rows.length > size ? (items[items.length - 1]?.invoiceId ?? null) : null,
    };
  }
}
