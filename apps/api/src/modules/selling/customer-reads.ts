import { Inject, Injectable } from '@nestjs/common';
import { agingBucketLabels } from '@daftar/domain-core';
import type {
  CustomerAgingBucketDto,
  CustomerAgingDto,
  CustomerContactDto,
  CustomerCurrencyAmountDto,
  CustomerDto,
  CustomerListItemDto,
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
    const found = await this.db.scoped<{
      bucket_no: number;
      currency_code: string | null;
      txn_minor: string | null;
      base_minor: string;
      invoice_count: number;
    }>(
      this.scope(m),
      `SELECT a.bucket_no, a.currency_code, a.txn_minor::text AS txn_minor, a.base_minor::text AS base_minor, a.invoice_count
         FROM customer_ar_aging($1::uuid, $2::uuid, $3::date, $4::integer[]) a
        ORDER BY a.bucket_no, a.currency_code NULLS FIRST`,
      [m.businessId, customerId, q.asOf, q.bucketDays],
    );

    const buckets: CustomerAgingBucketDto[] = labels.map((label, i) => ({
      label,
      fromDays: i === 0 ? 0 : (q.bucketDays[i - 1] as number) + 1,
      toDays: i < q.bucketDays.length ? (q.bucketDays[i] as number) : null,
      baseMinor: '0',
      byCurrency: [],
      invoiceCount: 0,
    }));

    let totalBaseMinor = 0n;
    for (const r of found.rows) {
      const bucket = buckets[r.bucket_no];
      if (bucket === undefined) continue;
      bucket.baseMinor = (BigInt(bucket.baseMinor) + BigInt(r.base_minor)).toString();
      bucket.invoiceCount += r.invoice_count;
      totalBaseMinor += BigInt(r.base_minor);
      if (r.currency_code !== null && r.txn_minor !== null) bucket.byCurrency.push({ currency: r.currency_code, txnMinor: r.txn_minor });
    }

    return { customerId, asOf: q.asOf, baseCurrency, bucketDays: [...q.bucketDays], buckets, totalBaseMinor: totalBaseMinor.toString() };
  }

  /**
   * `GET /v1/customers/:customerId/open-invoices` — the customer's documents
   * that still have something outstanding at the supplied as-of date, oldest
   * first, for the picker `OD-P4-03` requires.
   *
   * `outstanding` and `settlementState` are the SQL functions' answers, not this
   * module's. `daysPastDue` is measured from the invoice's own due date to the
   * supplied as-of date, in the database, so one date arithmetic serves the read
   * and the aging.
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
        days_past_due: number | null;
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
              CASE WHEN o.due_date IS NULL THEN NULL ELSE ($3::date - o.due_date) END AS days_past_due
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
    }));
    return {
      customerId,
      asOf: q.asOf,
      items,
      nextCursor: found.rows.length > size ? (items[items.length - 1]?.invoiceId ?? null) : null,
    };
  }
}
