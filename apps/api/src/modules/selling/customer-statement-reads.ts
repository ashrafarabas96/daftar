import { Inject, Injectable } from '@nestjs/common';
import type {
  CustomerStatementDto,
  CustomerStatementEntryDto,
  CustomerStatementEntryKindDto,
  CustomerStatementOpeningBalanceDto,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { findCustomer } from './customer-reads';
import { sellingRefusal } from './selling-errors';

/**
 * L3 / P4-S1 — THE READ SIDE OF `GET /v1/customers/:customerId/statement`.
 *
 * THE ONE THING THIS FILE MUST NOT DO IS ARITHMETIC. The running balance is
 * computed by a cumulative window INSIDE `customer_account_statement` (`0092`),
 * over the WHOLE ordered set and partitioned by `currency_code`. That is the
 * reason the owner's permit (DR-146) was for a reader and not for a read: a
 * per-row balance assembled here, over the rows of ONE PAGE, would be a SECOND
 * definition of the balance and the page boundary would decide its value —
 * which is precisely what `P4-AL-07` refuses.
 *
 * So this file selects, pages, and renames. It never sums, never re-orders,
 * never rounds, and never substitutes a value for a missing one.
 *
 * ── WHY THE KEYSET FILTER IS OUTSIDE THE FUNCTION, AND WHY THAT IS SAFE ──
 *
 * The existing keyset reads resolve their cursor by READING THE ANCHOR ROW
 * back from its table — `invoice-reads.ts:148`:
 *
 *     AND ($7::uuid IS NULL OR (i.issue_date, i.id) > (SELECT p.issue_date, p.id FROM invoices p WHERE … p.id = $7))
 *
 * That shape is UNAVAILABLE here, and not by preference: the rows come from a
 * set-returning FUNCTION, and four of the five entry kinds are not rows of any
 * single table whose `(date, id)` could be looked up — a `payment_allocation`
 * takes its date from the PAYMENT and its id from the ALLOCATION. There is no
 * table to `SELECT` the anchor from. So the cursor carries the ordering
 * triple ITSELF, and the comparison runs against the function's own output.
 *
 * AND THIS IS WHY THAT COSTS NOTHING HERE, which is the whole point of the
 * design: THE BALANCE IS ALREADY COMPUTED WHEN THE FILTER RUNS. The window
 * inside the reader has already closed over every row of the set; the
 * `WHERE` below then discards rows from the FRONT of an already-computed
 * sequence. Discarding a prefix cannot change a value computed over the
 * whole, so `items[i].runningBalanceTxnMinor` is the same integer on a page
 * of 1 as on a page of 50. Had the summation lived out here, the same filter
 * would have made the first row of page 2 restart from zero.
 *
 * The row comparison is PostgreSQL's row-wise `>` over
 * `(entry_date, kind_rank, entry_id)`, which is the reader's own TOTAL order,
 * so a page boundary can neither repeat a row nor skip one. The comparison is
 * STRICTLY GREATER — the anchor row itself is excluded, because it was the
 * last row of the previous page and including it would repeat it.
 *
 * ── MINOR UNITS ──────────────────────────────────────────────────────────
 *
 * Every `BIGINT` is cast to `text` IN SQL and carried as a string, the way
 * every accepted money read in this tree does it. The driver would otherwise
 * hand us a string anyway for `int8`, but the cast makes the contract the
 * QUERY's and not the driver's. Nothing is parsed into a `number` anywhere on
 * this path: `JSON.parse` would silently truncate a balance past 2^53, and the
 * loss would have happened before any code could notice it.
 */

/** The server's own page size when the caller states none, as the sibling reads use. */
const DEFAULT_LIMIT = 20;

/**
 * THE CURSOR, AND WHY IT IS OPAQUE AND VALIDATED RATHER THAN TRUSTED.
 *
 * The cursor is `base64url("YYYY-MM-DD|<rank>|<uuid>")`. It is opaque so that
 * no client comes to depend on the ordering triple as a public shape — the
 * triple is an implementation of the reader's order, and a client that built
 * its own cursor would be a client that breaks when the order gains a field.
 *
 * It is DECODED STRICTLY. A cursor that does not decode, or decodes to the
 * wrong number of fields, or carries a date that is not a real calendar date,
 * a rank that is not an integer or an id that is not a UUID, is REFUSED —
 * because the alternative is worse than an error. A silently-dropped cursor
 * would serve PAGE ONE to a caller who asked for page five, and the caller
 * would read a correct-looking statement that had quietly repeated every row
 * it already had. A corrupt cursor coerced to a default date would skip rows
 * instead. A refusal is the only outcome that cannot be mistaken for data.
 *
 * The refusal carries this module's OWN named code,
 * `customer.statement_cursor_invalid`, and not a bare zod failure: a generic
 * `VALIDATION_FAILED` says "your query was malformed", while the named code
 * says "the page you asked to continue from is not one I handed out", and
 * those are two different things for the client to act on. It is therefore
 * raised in the service through `sellingRefusal`, which is why the schema
 * below admits `cursor` as a plain string and does not decode it.
 */
export interface StatementCursor {
  readonly entryDate: string;
  readonly kindRank: number;
  readonly entryId: string;
}

const CURSOR_SEPARATOR = '|';
const CURSOR_FIELDS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANK_RE = /^\d{1,9}$/;
/** `base64url` alphabet, unpadded. A cursor carrying `+`, `/` or `=` is not one we issued. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** A real calendar date, so `2026-13-45` is refused rather than handed to PostgreSQL. */
function isCivilDate(v: string): boolean {
  if (!CIVIL_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The cursor the server issues for `last`. The only place one is ever created. */
export function encodeStatementCursor(c: StatementCursor): string {
  return Buffer.from([c.entryDate, String(c.kindRank), c.entryId].join(CURSOR_SEPARATOR), 'utf8').toString('base64url');
}

/**
 * The strict decode. Returns `null` on ANY defect — the caller turns that into
 * the refusal, so this function never throws and never guesses.
 */
export function decodeStatementCursor(raw: string): StatementCursor | null {
  if (!BASE64URL_RE.test(raw)) return null;
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // `base64url` decoding is lenient: it drops bytes it cannot place rather
  // than failing, so the SHAPE of the decoded text — and not the decode's own
  // success — is what admits a cursor.
  const parts = text.split(CURSOR_SEPARATOR);
  if (parts.length !== CURSOR_FIELDS) return null;
  const [date, rank, id] = parts as [string, string, string];
  if (!isCivilDate(date)) return null;
  if (!RANK_RE.test(rank)) return null;
  if (!UUID_RE.test(id)) return null;
  return { entryDate: date, kindRank: Number.parseInt(rank, 10), entryId: id };
}

/** The decode, or this module's named refusal. The ONE door a cursor enters by. */
export function statementCursorOrRefuse(raw: string): StatementCursor {
  const decoded = decodeStatementCursor(raw);
  if (decoded === null) throw sellingRefusal('customer.statement_cursor_invalid');
  return decoded;
}

/**
 * `GET /v1/customers/:customerId/statement`.
 *
 * `.strict()`, like every other query schema in this module: an unknown key is
 * a 400 and not an ignored typo, because a caller who misspelled `cursor` would
 * otherwise silently receive page one forever.
 *
 * The schema lives HERE and not in `selling.schemas.ts` deliberately: that file
 * is being edited by another lane, and a new export in it would be a conflict
 * for no gain.
 */
export const CustomerStatementQuerySchema = z
  .object({
    // Admitted as an opaque STRING here and decoded in the service, so that a
    // corrupt cursor is refused with the named `customer.statement_cursor_invalid`
    // rather than with a bare zod failure. The schema's job is the SHAPE of
    // the query; the cursor's validity is this module's own refusal.
    cursor: z.string().optional(),
    limit: z
      .string()
      .regex(/^\d{1,2}$/, 'a limit is 1..50')
      .transform((s) => Number.parseInt(s, 10))
      .pipe(z.number().int().min(1).max(50))
      .optional(),
  })
  .strict();

export type CustomerStatementQuery = z.infer<typeof CustomerStatementQuerySchema>;

/**
 * The row as the SQL below selects it: every amount already `text`, the date
 * already a civil `YYYY-MM-DD` string.
 *
 * `entry_date` is rendered with `to_char` rather than handed over as a `Date`.
 * A `DATE` the driver turned into a JavaScript `Date` would acquire the
 * PROCESS's timezone, and `toISOString().slice(0, 10)` on it would print the
 * previous day for every business east of UTC. The statement's dates are
 * CIVIL dates in the merchant's own calendar and they are never allowed to
 * meet a clock.
 */
interface StatementSqlRow extends QueryResultRow {
  entry_kind: CustomerStatementEntryKindDto;
  entry_id: string;
  entry_date: string;
  kind_rank: number;
  document_number: string | null;
  related_id: string | null;
  currency_code: string;
  debit_txn_minor: string | null;
  credit_txn_minor: string | null;
  amount_txn_minor: string | null;
  amount_base_minor: string | null;
  credit_original_txn_minor: string | null;
  credit_remaining_txn_minor: string | null;
  credit_remaining_base_minor: string | null;
  reference: string | null;
  running_balance_txn_minor: string;
  /**
   * The balance this row's CURRENCY stood at immediately before the page
   * began — read from the function, identical on every row of that currency,
   * and `'0'` when no cursor was supplied. It is carried on the row so that
   * one round trip serves both the page and its openings; it is NOT part of
   * the DTO row.
   */
  opening_txn_minor: string;
}

/**
 * The projection: one field per column, renamed and nothing else.
 *
 * `kind_rank` is coerced with `Number()` and that is safe where nothing else
 * on this row would be: it is the reader's own literal 1..5, declared
 * `INTEGER`, and it is an ORDERING TAG and not money. Every actual amount
 * stays a string.
 *
 * A row whose `running_balance_txn_minor` is null cannot exist — the window
 * always produces a value — so a null there is a DEFECT and is refused rather
 * than substituted with `'0'`. A substituted zero would print "this customer
 * owes nothing" over a balance the database failed to state, and that error
 * direction understates a debt, which is the one direction the aging and
 * receivable rules forbid.
 */
function statementEntryDto(r: StatementSqlRow): CustomerStatementEntryDto {
  if (r.running_balance_txn_minor === null) throw sellingRefusal('customer.statement_row_unplaceable');
  return {
    entryKind: r.entry_kind,
    entryId: r.entry_id,
    entryDate: r.entry_date,
    kindRank: Number(r.kind_rank),
    documentNumber: r.document_number,
    relatedId: r.related_id,
    currencyCode: r.currency_code,
    debitTxnMinor: r.debit_txn_minor,
    creditTxnMinor: r.credit_txn_minor,
    amountTxnMinor: r.amount_txn_minor,
    amountBaseMinor: r.amount_base_minor,
    creditOriginalTxnMinor: r.credit_original_txn_minor,
    creditRemainingTxnMinor: r.credit_remaining_txn_minor,
    creditRemainingBaseMinor: r.credit_remaining_base_minor,
    reference: r.reference,
    runningBalanceTxnMinor: r.running_balance_txn_minor,
  };
}

/**
 * One opening entry per currency appearing in the page, in first-appearance
 * order.
 *
 * This is a LOOKUP AND A DEDUPLICATION, not a computation: the value is the
 * `opening_txn_minor` the SQL already read out of the function, and every row
 * of a currency carries the same one. The second arm asserts exactly that —
 * two different openings for one currency would mean the join produced a row
 * the model cannot place, and a row this read cannot place is a defect, never
 * a `continue`.
 */
function openingBalances(page: readonly StatementSqlRow[]): CustomerStatementOpeningBalanceDto[] {
  const seen = new Map<string, string>();
  for (const r of page) {
    const previous = seen.get(r.currency_code);
    if (previous === undefined) {
      seen.set(r.currency_code, r.opening_txn_minor);
      continue;
    }
    if (previous !== r.opening_txn_minor) throw sellingRefusal('customer.statement_row_unplaceable');
  }
  return [...seen].map(([currencyCode, txnMinor]) => ({ currencyCode, txnMinor }));
}

@Injectable()
export class CustomerStatementReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private scope(m: MembershipContext): { tenantId: string; businessId: string } {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  /**
   * One page of the customer's account statement, running balance included.
   *
   * The customer is resolved FIRST and a missing one is `customer.not_found`,
   * exactly as `receivable`, `aging` and `openInvoices` do it. The reader
   * itself would answer the EMPTY SET for a customer that does not exist —
   * it is `INVOKER` and `p_business_id` filters above the caller's own
   * policies — and an empty page would tell the merchant "this customer owes
   * nothing" about a customer who is not there. The two answers must not be
   * the same answer.
   */
  async statement(m: MembershipContext, customerId: string, q: CustomerStatementQuery): Promise<CustomerStatementDto> {
    const row = await findCustomer(this.db, this.scope(m), customerId);
    if (row === null) throw sellingRefusal('customer.not_found');

    const size = q.limit ?? DEFAULT_LIMIT;
    const cursor = q.cursor === undefined ? null : statementCursorOrRefuse(q.cursor);
    const found = await this.db.scoped<StatementSqlRow>(
      this.scope(m),
      // THE BALANCE IS COMPUTED INSIDE THE FUNCTION, OVER THE WHOLE SET, SO
      // THIS PAGE CANNOT CHANGE IT. The `WHERE` below drops a PREFIX of an
      // already-computed sequence; `running_balance_txn_minor` on any row that
      // survives is the value the window gave it over all of the customer's
      // entries, not over the ones this page happens to hold. Nothing out here
      // adds anything up.
      //
      // The keyset predicate is row-wise and STRICT, over the reader's own
      // total order `(entry_date, kind_rank, entry_id)`: `>` excludes the
      // anchor, which was the previous page's last row, so no row is served
      // twice and none is skipped.
      // THE OPENING BALANCE, AND WHY IT IS READ AND NEVER COMPUTED.
      //
      // `opening` takes, PER CURRENCY, the running balance of the LAST row at
      // or BEFORE the cursor. The comparison is `<=` and not `<` on purpose:
      // the anchor IS the previous page's last row, so its own balance is
      // exactly the figure this page opens from. `DISTINCT ON (currency_code)`
      // with the matching DESC order picks that one row per currency, and
      // `coalesce(…, 0)` makes every currency open at `0` when no cursor was
      // supplied — which is the first page, where `a.d IS NOT NULL` already
      // emptied the CTE.
      //
      // The figure therefore comes OUT OF THE FUNCTION. Nothing here adds up
      // rows to produce it: an opening balance summed in TypeScript over the
      // previous page would be a second definition of the balance, and a
      // middle page would carry a figure the database never stated.
      //
      // The reader is scanned twice in this statement — once for the page and
      // once for the openings. That is the price of one round trip instead of
      // two, and the alternative pays the row-security setup twice as well.
      // It is NOT measured: only `EXPLAIN (ANALYZE)` on a real database
      // settles what the planner does here, and that is NOT RUN.
      `WITH anchor AS (SELECT $3::date AS d, $4::integer AS r, $5::uuid AS i),
            opening AS (
              SELECT DISTINCT ON (o.currency_code) o.currency_code, o.running_balance_txn_minor
                FROM customer_account_statement($1::uuid, $2::uuid) o
                CROSS JOIN anchor a
               WHERE a.d IS NOT NULL
                 AND (o.entry_date, o.kind_rank, o.entry_id) <= (a.d, a.r, a.i)
               ORDER BY o.currency_code, o.entry_date DESC, o.kind_rank DESC, o.entry_id DESC)
       SELECT s.entry_kind,
              s.entry_id::text AS entry_id,
              to_char(s.entry_date, 'YYYY-MM-DD') AS entry_date,
              s.kind_rank,
              s.document_number,
              s.related_id::text AS related_id,
              s.currency_code,
              s.debit_txn_minor::text AS debit_txn_minor,
              s.credit_txn_minor::text AS credit_txn_minor,
              s.amount_txn_minor::text AS amount_txn_minor,
              s.amount_base_minor::text AS amount_base_minor,
              s.credit_original_txn_minor::text AS credit_original_txn_minor,
              s.credit_remaining_txn_minor::text AS credit_remaining_txn_minor,
              s.credit_remaining_base_minor::text AS credit_remaining_base_minor,
              s.reference,
              s.running_balance_txn_minor::text AS running_balance_txn_minor,
              coalesce(op.running_balance_txn_minor, 0)::text AS opening_txn_minor
         FROM customer_account_statement($1::uuid, $2::uuid) s
         CROSS JOIN anchor a
         LEFT JOIN opening op ON op.currency_code = s.currency_code
        WHERE (a.d IS NULL OR (s.entry_date, s.kind_rank, s.entry_id) > (a.d, a.r, a.i))
        ORDER BY s.entry_date, s.kind_rank, s.entry_id
        LIMIT $6`,
      [m.businessId, customerId, cursor?.entryDate ?? null, cursor?.kindRank ?? null, cursor?.entryId ?? null, size + 1],
    );

    // `size + 1` was asked for, so the presence of the extra row — and not a
    // count compared against `size` — is what says there is a next page. A
    // cursor issued on a full page that happened to be the last one would send
    // the client on one more round trip for an empty page.
    const page = found.rows.slice(0, size);
    const last = page[page.length - 1];
    return {
      customerId,
      items: page.map(statementEntryDto),
      openingBalanceByCurrency: openingBalances(page),
      nextCursor:
        found.rows.length > size && last !== undefined
          ? encodeStatementCursor({ entryDate: last.entry_date, kindRank: Number(last.kind_rank), entryId: last.entry_id })
          : null,
    };
  }
}
