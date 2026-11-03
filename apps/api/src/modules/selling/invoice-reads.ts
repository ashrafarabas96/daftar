import { Inject, Injectable } from '@nestjs/common';
import type {
  DocumentSequenceDto,
  DocumentSequenceListDto,
  InvoiceDto,
  InvoiceItemDto,
  InvoicePageDto,
  InvoiceSettlementDto,
  InvoiceSummaryDto,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import { readBaseCurrency } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { sellingRefusal } from './selling-errors';
import type { DocumentSequenceQuery, InvoiceListQuery } from './selling.schemas';

/**
 * The invoice READ surface of P4-S1 (lock P4-AL-12, P4-AL-24, P4-AL-26,
 * P4-AL-31, P4-AL-44, P4-AL-54; `OD-P4-07` OPTION A).
 *
 * There is no write path in this module, and there is none anywhere in P4-S1:
 * P4-AL-16's atomic sale law makes the `invoices` row, its items, its number and
 * its revenue/AR entry part of one transaction with the sale, so the only writer
 * of an invoice is the sale command. This module reads what that command wrote.
 *
 * It holds itself to the same G-6 reporting-surface rules
 * (`scripts/guards/read-surface.ts`) as the customer reads: no write, no
 * `OFFSET`, no current exchange-rate lookup, no `Number(`/`parseInt(`/
 * `parseFloat(` on money, no module-level cache. The rate a response carries is
 * the rate the invoice was POSTED at, read off the document; a rate entered
 * tomorrow never changes it.
 *
 * Every settlement figure is derived at read time through the product's own
 * functions — `invoice_outstanding(...)`, `invoice_settlement_state(...)` — the
 * same ones `R-SAL-02` and the P4-E budget use (P4-AL-07). `invoices.paid_minor`
 * and `invoices.outstanding_minor` do not exist to be read (P4-AL-06), and
 * `paid + outstanding = total` is a reconciliation identity rather than a row
 * `CHECK` (P4-AL-26).
 */

const DEFAULT_LIMIT = 20;

interface InvoiceRow extends QueryResultRow {
  id: string;
  sale_id: string;
  customer_id: string | null;
  branch_id: string;
  document_kind: 'invoice' | 'credit_note';
  document_number: string;
  number_seq: string;
  issue_date: string;
  due_date: string | null;
  currency_code: string;
  status: 'draft' | 'open' | 'void';
  notes: string | null;
  subtotal_txn_minor: string;
  discount_txn_minor: string;
  tax_minor: string;
  total_txn_minor: string;
  total_base_minor: string;
  fx_rate_id: string | null;
  source_to_base_rate: string;
  rate_source: 'base' | 'manual' | 'provider';
  rate_timestamp: Date;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  voided_at: Date | null;
  created_at: Date;
}

interface InvoiceItemRow extends QueryResultRow {
  id: string;
  line_no: number;
  product_id: string;
  variant_id: string | null;
  name_snapshot: string;
  quantity: string;
  unit_price_txn_minor: string;
  gross_txn_minor: string;
  discount_txn_minor: string;
  net_txn_minor: string;
  tax_minor: string;
  base_share_minor: string;
}

const INVOICE_SUMMARY_COLUMNS = `i.id, i.customer_id, i.document_kind, i.document_number, i.number_seq::text AS number_seq,
         to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
         i.currency_code, i.status, i.total_txn_minor::text AS total_txn_minor, i.total_base_minor::text AS total_base_minor, i.created_at`;

function invoiceSummaryDto(row: InvoiceRow): InvoiceSummaryDto {
  return {
    id: row.id,
    customerId: row.customer_id,
    documentKind: row.document_kind,
    documentNumber: row.document_number,
    numberSeq: row.number_seq,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currency: row.currency_code,
    status: row.status,
    totalTxnMinor: row.total_txn_minor,
    totalBaseMinor: row.total_base_minor,
    createdAt: row.created_at.toISOString(),
  };
}

function invoiceItemDto(row: InvoiceItemRow): InvoiceItemDto {
  return {
    itemId: row.id,
    lineNo: row.line_no,
    productId: row.product_id,
    variantId: row.variant_id,
    nameSnapshot: row.name_snapshot,
    quantity: row.quantity,
    unitPriceTxnMinor: row.unit_price_txn_minor,
    grossTxnMinor: row.gross_txn_minor,
    discountTxnMinor: row.discount_txn_minor,
    netTxnMinor: row.net_txn_minor,
    // Always the exact spelling of zero while OD-03 is open (P4-AL-44). The
    // value is read from the column rather than hard-coded here, because the
    // day the Country Pack drops the CHECK this read must not lie.
    taxMinor: row.tax_minor,
    baseShareMinor: row.base_share_minor,
  };
}

@Injectable()
export class InvoiceReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private scope(m: MembershipContext): { tenantId: string; businessId: string } {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  /**
   * `GET /v1/invoices` — a keyset page ordered `(issue_date, id)`, newest walk
   * driven by the cursor rather than by an offset. `status` filters the
   * LIFECYCLE only: there is no `paid` value to ask for, because settlement is
   * derived and never a status (P4-AL-24).
   */
  async list(m: MembershipContext, q: InvoiceListQuery): Promise<InvoicePageDto> {
    const size = q.limit ?? DEFAULT_LIMIT;
    const found = await this.db.scoped<InvoiceRow>(
      this.scope(m),
      `SELECT ${INVOICE_SUMMARY_COLUMNS}
         FROM invoices i
        WHERE i.business_id = $1
          AND ($2::uuid IS NULL OR i.customer_id = $2)
          AND ($3::text IS NULL OR i.status = $3)
          AND ($4::text IS NULL OR i.document_kind = $4)
          AND ($5::date IS NULL OR i.issue_date >= $5)
          AND ($6::date IS NULL OR i.issue_date <= $6)
          AND ($7::uuid IS NULL OR (i.issue_date, i.id) > (SELECT p.issue_date, p.id FROM invoices p WHERE p.business_id = $1 AND p.id = $7))
        ORDER BY i.issue_date, i.id
        LIMIT $8`,
      [m.businessId, q.customerId ?? null, q.status ?? null, q.documentKind ?? null, q.from ?? null, q.to ?? null, q.cursor ?? null, size + 1],
    );
    const page = found.rows.slice(0, size);
    return {
      items: page.map(invoiceSummaryDto),
      nextCursor: found.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * `GET /v1/invoices/:invoiceId` — the document with its items in `lineNo`
   * order, the customer snapshot as it was at issue, and the rate as posted.
   *
   * The snapshot is `null` for a walk-in sale, whose `customer_id` is null:
   * P4-AL-11 makes that null the honest representation and refuses a synthetic
   * walk-in customer row, because such a row accumulates a real balance.
   */
  async get(m: MembershipContext, invoiceId: string): Promise<InvoiceDto> {
    const found = await this.db.scoped<InvoiceRow>(
      this.scope(m),
      `SELECT ${INVOICE_SUMMARY_COLUMNS}, i.sale_id, i.branch_id, i.notes,
              i.subtotal_txn_minor::text AS subtotal_txn_minor, i.discount_txn_minor::text AS discount_txn_minor,
              i.tax_minor::text AS tax_minor, i.fx_rate_id, i.source_to_base_rate::text AS source_to_base_rate,
              i.rate_source, i.rate_timestamp, i.customer_name_snapshot, i.customer_phone_snapshot, i.voided_at
         FROM invoices i
        WHERE i.business_id = $1 AND i.id = $2`,
      [m.businessId, invoiceId],
    );
    const row = found.rows[0];
    if (row === undefined) throw sellingRefusal('invoice.not_found');

    const items = await this.db.scoped<InvoiceItemRow>(
      this.scope(m),
      `SELECT t.id, t.line_no, t.product_id, t.variant_id, t.name_snapshot,
              t.quantity::text AS quantity, t.unit_price_txn_minor::text AS unit_price_txn_minor,
              t.gross_txn_minor::text AS gross_txn_minor, t.discount_txn_minor::text AS discount_txn_minor,
              t.net_txn_minor::text AS net_txn_minor, t.tax_minor::text AS tax_minor,
              t.base_share_minor::text AS base_share_minor
         FROM invoice_items t
        WHERE t.business_id = $1 AND t.invoice_id = $2
        ORDER BY t.line_no`,
      [m.businessId, invoiceId],
    );

    return {
      ...invoiceSummaryDto(row),
      saleId: row.sale_id,
      branchId: row.branch_id,
      notes: row.notes,
      subtotalTxnMinor: row.subtotal_txn_minor,
      discountTxnMinor: row.discount_txn_minor,
      taxMinor: row.tax_minor,
      rate: {
        rateId: row.fx_rate_id,
        rate: row.source_to_base_rate,
        source: row.rate_source,
        at: row.rate_timestamp.toISOString(),
      },
      customerSnapshot: row.customer_name_snapshot === null ? null : { name: row.customer_name_snapshot, phone: row.customer_phone_snapshot },
      voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
      items: items.rows.map(invoiceItemDto),
    };
  }

  /**
   * `GET /v1/invoices/:invoiceId/settlement` — what is paid and what is left,
   * derived, with the settlement state.
   *
   * One call to `invoice_outstanding(...)` produces the total, the paid and the
   * outstanding in both currencies, so the three figures of one answer cannot
   * disagree and `paid + outstanding = total` holds by construction of the
   * function rather than by an addition performed here.
   */
  async settlement(m: MembershipContext, invoiceId: string): Promise<InvoiceSettlementDto> {
    const baseCurrency = await readBaseCurrency(this.db, this.scope(m));
    const found = await this.db.scoped<{
      currency_code: string;
      total_txn_minor: string;
      total_base_minor: string;
      paid_txn_minor: string;
      paid_base_minor: string;
      outstanding_txn_minor: string;
      outstanding_base_minor: string;
      settlement_state: 'unpaid' | 'partial' | 'paid';
    }>(
      this.scope(m),
      `SELECT i.currency_code,
              i.total_txn_minor::text AS total_txn_minor, i.total_base_minor::text AS total_base_minor,
              o.paid_txn_minor::text AS paid_txn_minor, o.paid_base_minor::text AS paid_base_minor,
              o.outstanding_txn_minor::text AS outstanding_txn_minor, o.outstanding_base_minor::text AS outstanding_base_minor,
              invoice_settlement_state(i.business_id, i.id) AS settlement_state
         FROM invoices i
         JOIN LATERAL invoice_outstanding(i.business_id, i.id) o ON TRUE
        WHERE i.business_id = $1 AND i.id = $2`,
      [m.businessId, invoiceId],
    );
    const row = found.rows[0];
    if (row === undefined) throw sellingRefusal('invoice.not_found');
    return {
      invoiceId,
      currency: row.currency_code,
      baseCurrency,
      totalTxnMinor: row.total_txn_minor,
      totalBaseMinor: row.total_base_minor,
      paidTxnMinor: row.paid_txn_minor,
      paidBaseMinor: row.paid_base_minor,
      outstandingTxnMinor: row.outstanding_txn_minor,
      outstandingBaseMinor: row.outstanding_base_minor,
      settlementState: row.settlement_state,
    };
  }

  /**
   * `GET /v1/document-sequences` — the business's document series.
   *
   * `highestCommittedSeq` is `max(number_seq)` over the COMMITTED documents of
   * the series, not a stored counter: P4-AL-31 refuses a counter column because
   * it is a derived number and therefore a second truth, and because it buys no
   * concurrency — allocation takes the same lock either way. A rolled-back sale
   * took its number with it, so this figure is the only figure that can be true.
   *
   * There is deliberately no "next number" here. A next number nobody allocated
   * is a number a client would be tempted to use, and the number is allocated
   * inside the sale's transaction while holding this row — last of the domain
   * locks (P4-AL-32).
   */
  async sequences(m: MembershipContext, q: DocumentSequenceQuery): Promise<DocumentSequenceListDto> {
    const found = await this.db.scoped<QueryResultRow & { document_kind: 'invoice' | 'credit_note'; period: string; format: string; highest: string }>(
      this.scope(m),
      `SELECT s.document_kind, s.period, s.number_format AS format,
              coalesce((SELECT max(i.number_seq) FROM invoices i
                         WHERE i.business_id = s.business_id AND i.document_kind = s.document_kind AND i.period = s.period), 0)::text AS highest
         FROM invoice_sequences s
        WHERE s.business_id = $1
          AND ($2::text IS NULL OR s.document_kind = $2)
        ORDER BY s.document_kind, s.period`,
      [m.businessId, q.documentKind ?? null],
    );
    const items: DocumentSequenceDto[] = found.rows.map((r) => ({
      documentKind: r.document_kind,
      period: r.period,
      format: r.format,
      highestCommittedSeq: r.highest,
    }));
    return { items };
  }
}
