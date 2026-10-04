import { Inject, Injectable } from '@nestjs/common';
import { hasPermission } from '@daftar/domain-core';
import { parseMinor, parseUnitCost } from '@daftar/inventory';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { receivablesRefusal } from './receivables-errors';
import type { CustomerCreditDto, CustomerPaymentDto } from './receivables-contracts';

/**
 * The reads of the P4-S4 receivables surface, and the ONE state read each
 * command makes.
 *
 * Everything here is read as `daftar_app` UNDER ROW LEVEL SECURITY — never
 * through an internal role and never with a widened GUC. A row of another
 * business is invisible, which is why a cross-business id answers "not found"
 * rather than "forbidden": the answer must not reveal whether it exists
 * (G-02).
 *
 * Every derived figure is read from its ONE definition. The outstanding AR of
 * an invoice is `invoice_outstanding(business, invoice)` and nothing else —
 * not a stored column (P4-AL-06 refuses one), not a sum computed here, and not
 * the journal. `0080` already makes that function report `paid = total,
 * outstanding = 0` for a CASH-settled invoice, so a cash sale to a named
 * customer is not collectable twice; this module inherits that and adds no
 * second opinion.
 *
 * Numerics come back as TEXT and are parsed into `bigint` / R10 by the
 * package's own parsers. A money figure is never a JavaScript `number`: 10^18
 * minor units does not survive the round trip, and `[[no float money]]` is not
 * a style rule.
 */

/** The scope every read runs in: the actor's tenant and business. */
export interface ReceivablesReadScope {
  readonly tenantId: string;
  readonly businessId: string;
}

export async function scopedReceivablesRows<T extends QueryResultRow>(
  db: Database,
  scope: ReceivablesReadScope,
  text: string,
  params: unknown[],
): Promise<T[]> {
  return (await db.scoped<T>({ tenantId: scope.tenantId, businessId: scope.businessId }, text, params)).rows;
}

/** A second-precision instant as the ledger writes it: `YYYY-MM-DDTHH:MM:SSZ`. */
const SECOND_INSTANT = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

// ── The state read of a collected payment ────────────────────────────────

/** One invoice a payment or an application settles, as the state read returns it; numerics as text. */
export interface SettledInvoiceRow {
  id: string;
  customer_id: string | null;
  branch_id: string;
  status: string;
  currency_code: string;
  currency_exponent: number;
  issue_date: string;
  total_txn_minor: string;
  total_base_minor: string;
  rate: string;
  rate_source: 'base' | 'manual' | 'provider';
  rate_timestamp: string;
  /** `invoice_outstanding(...).outstanding_txn_minor`: the ONE definition. */
  outstanding: string;
}

/**
 * The invoices of a state read, in the business's scope, each with its `O` and
 * its own stored snapshot. `LEFT JOIN LATERAL` on the reader-of-record rather
 * than any arithmetic here.
 */
export const SETTLED_INVOICES_SQL = `(SELECT coalesce(json_agg(json_build_object(
            'id', i.id, 'customer_id', i.customer_id, 'branch_id', i.branch_id, 'status', i.status,
            'currency_code', i.currency_code::text, 'currency_exponent', ic.minor_units, 'issue_date', i.issue_date::text,
            'total_txn_minor', i.total_txn_minor::text, 'total_base_minor', i.total_base_minor::text,
            'rate', i.source_to_base_rate::text, 'rate_source', i.rate_source,
            'rate_timestamp', to_char(i.rate_timestamp AT TIME ZONE 'UTC', ${SECOND_INSTANT}),
            'outstanding', o.outstanding_txn_minor::text)), '[]'::json)
       FROM invoices i
       JOIN currencies ic ON ic.code = i.currency_code
       CROSS JOIN LATERAL invoice_outstanding(i.business_id, i.id) o
      WHERE i.business_id = b.id AND i.id = ANY(%IDS%::uuid[]))`;

/** The payment method a settlement names, with its account's chart code. */
export interface ReceivablesMethodRow {
  id: string;
  is_active: boolean;
  requires_reference: boolean;
  posting_account_id: string;
  account_code: string;
}

export const RECEIVABLES_METHOD_SQL = `(SELECT json_build_object('id', m.id, 'is_active', m.is_active, 'requires_reference', m.requires_reference,
            'posting_account_id', m.posting_account_id, 'account_code', a.code)
       FROM payment_methods m
       JOIN accounts a ON a.business_id = m.business_id AND a.id = m.posting_account_id
      WHERE m.business_id = b.id AND m.id = %METHOD%::uuid)`;

/** One customer credit of a state read: its immutable original pair, its mutable remaining pair and its snapshot. */
export interface CustomerCreditRow {
  id: string;
  customer_id: string;
  currency_code: string;
  currency_exponent: number;
  original_amount_minor: string;
  original_carrying_base_amount_minor: string;
  remaining_amount_minor: string;
  remaining_carrying_base_amount_minor: string;
  rate: string;
  rate_source: 'base' | 'manual' | 'provider';
  rate_timestamp: string;
  credit_date: string;
}

export const CUSTOMER_CREDIT_SQL = `(SELECT json_build_object(
            'id', k.id, 'customer_id', k.customer_id, 'currency_code', k.currency_code::text, 'currency_exponent', kc.minor_units,
            'original_amount_minor', k.original_amount_minor::text,
            'original_carrying_base_amount_minor', k.original_carrying_base_amount_minor::text,
            'remaining_amount_minor', k.remaining_amount_minor::text,
            'remaining_carrying_base_amount_minor', k.remaining_carrying_base_amount_minor::text,
            'rate', k.credit_to_base_rate::text, 'rate_source', k.rate_source,
            'rate_timestamp', to_char(k.rate_timestamp AT TIME ZONE 'UTC', ${SECOND_INSTANT}),
            'credit_date', k.credit_date::text)
       FROM customer_credits k
       JOIN currencies kc ON kc.code = k.currency_code
      WHERE k.business_id = b.id AND k.id = %CREDIT%::uuid)`;

// ── The replay reads ─────────────────────────────────────────────────────

/** The stored `intent_sha256` of a payment this caller can see, or null when there is no such payment. */
export async function findCustomerPaymentIntent(db: Database, scope: ReceivablesReadScope, paymentId: string): Promise<string | null> {
  const [row] = await scopedReceivablesRows<{ intent_sha256: string }>(
    db,
    scope,
    `SELECT p.intent_sha256 FROM payments p WHERE p.business_id = $1 AND p.id = $2`,
    [scope.businessId, paymentId],
  );
  return row?.intent_sha256 ?? null;
}

/** The stored `intent_sha256` of a credit application, or null. */
export async function findCustomerCreditApplicationIntent(db: Database, scope: ReceivablesReadScope, applicationId: string): Promise<string | null> {
  const [row] = await scopedReceivablesRows<{ intent_sha256: string }>(
    db,
    scope,
    `SELECT a.intent_sha256 FROM customer_credit_applications a WHERE a.business_id = $1 AND a.id = $2`,
    [scope.businessId, applicationId],
  );
  return row?.intent_sha256 ?? null;
}

const CUSTOMER_CREDIT_DTO_SQL = `json_build_object(
  'creditId', k.id, 'customerId', k.customer_id, 'currencyCode', k.currency_code::text,
  'originalAmountMinor', k.original_amount_minor::text,
  'remainingAmountMinor', k.remaining_amount_minor::text,
  'remainingCarryingBaseAmountMinor', k.remaining_carrying_base_amount_minor::text,
  'creditDate', k.credit_date::text)`;

/**
 * One stored payment with its allocations in `line_no` order and the surplus
 * credit it created, or `customer_payment.not_found`.
 *
 * The allocations are ordered by `line_no`, which is the order the entries
 * were posted in and the order the client stated them in: `line_no = ordinal`
 * is the routine's, not this read's.
 *
 * It answers `CustomerPaymentDto`, which carries NO `replayed`. A read has no
 * replay semantics: nothing was written, so there is nothing a retry could
 * have returned instead. The field used to be hard-coded `false` on the GET —
 * true by accident rather than by meaning, and a shape a client could come to
 * rely on. `replayed` belongs to the COMMAND's answer, where 200-vs-201 turns
 * on it, so the two command paths add it to this row (`CustomerPaymentResultDto
 * extends CustomerPaymentDto`) and the read does not.
 */
export async function readCustomerPayment(db: Database, scope: ReceivablesReadScope, paymentId: string): Promise<CustomerPaymentDto> {
  const [row] = await scopedReceivablesRows<{
    payment_id: string;
    customer_id: string;
    payment_method_id: string;
    payment_date: string;
    currency_code: string;
    amount_minor: string;
    reference: string | null;
    allocations: CustomerPaymentDto['allocations'];
    credit: CustomerCreditDto | null;
  }>(
    db,
    scope,
    `SELECT p.id AS payment_id, p.customer_id, p.payment_method_id, p.payment_date::text AS payment_date,
            p.currency_code::text AS currency_code, p.amount_minor::text AS amount_minor, p.reference,
            (SELECT coalesce(json_agg(json_build_object(
                      'allocationId', a.id, 'lineNo', a.line_no, 'invoiceId', a.invoice_id,
                      'invoiceCurrencyCode', a.invoice_currency::text,
                      'paymentAmountMinor', a.payment_amount_minor::text,
                      'invoiceAmountAppliedMinor', a.invoice_amount_applied_minor::text) ORDER BY a.line_no), '[]'::json)
               FROM payment_allocations a
              WHERE a.business_id = p.business_id AND a.payment_id = p.id) AS allocations,
            (SELECT ${CUSTOMER_CREDIT_DTO_SQL}
               FROM customer_credits k
              WHERE k.business_id = p.business_id AND k.origin_payment_id = p.id) AS credit
       FROM payments p
      WHERE p.business_id = $1 AND p.id = $2`,
    [scope.businessId, paymentId],
  );
  if (row === undefined) throw receivablesRefusal('customer_payment.not_found');
  return {
    paymentId: row.payment_id,
    customerId: row.customer_id,
    paymentMethodId: row.payment_method_id,
    paymentDate: row.payment_date,
    currencyCode: row.currency_code,
    amountMinor: row.amount_minor,
    reference: row.reference,
    allocations: row.allocations,
    credit: row.credit,
  };
}

/** One stored credit application, with the credit's remaining pair as it stands AFTER it. */
export async function readCustomerCreditApplicationResult(
  db: Database,
  scope: ReceivablesReadScope,
  applicationId: string,
  replayed: boolean,
): Promise<{
  readonly applicationId: string;
  readonly creditId: string;
  readonly invoiceId: string;
  readonly applicationDate: string;
  readonly consumedMinor: string;
  readonly invoiceAmountAppliedMinor: string;
  readonly creditRemainingAmountMinor: string;
  readonly creditRemainingCarryingBaseAmountMinor: string;
  readonly replayed: boolean;
}> {
  const [row] = await scopedReceivablesRows<{
    application_id: string;
    credit_id: string;
    invoice_id: string;
    application_date: string;
    consumed_minor: string;
    applied_minor: string;
    remaining_amount_minor: string;
    remaining_carrying_base_amount_minor: string;
  }>(
    db,
    scope,
    `SELECT a.id AS application_id, a.credit_id, a.invoice_id, a.application_date::text AS application_date,
            a.credit_amount_consumed_minor::text AS consumed_minor,
            a.invoice_amount_applied_minor::text AS applied_minor,
            k.remaining_amount_minor::text AS remaining_amount_minor,
            k.remaining_carrying_base_amount_minor::text AS remaining_carrying_base_amount_minor
       FROM customer_credit_applications a
       JOIN customer_credits k ON k.business_id = a.business_id AND k.id = a.credit_id
      WHERE a.business_id = $1 AND a.id = $2`,
    [scope.businessId, applicationId],
  );
  if (row === undefined) throw receivablesRefusal('customer_credit_application.not_found');
  return {
    applicationId: row.application_id,
    creditId: row.credit_id,
    invoiceId: row.invoice_id,
    applicationDate: row.application_date,
    consumedMinor: row.consumed_minor,
    invoiceAmountAppliedMinor: row.applied_minor,
    creditRemainingAmountMinor: row.remaining_amount_minor,
    creditRemainingCarryingBaseAmountMinor: row.remaining_carrying_base_amount_minor,
    replayed,
  };
}

/**
 * The GET reads of this slice.
 *
 * `receivables.view` gates BOTH: the read of one payment and a customer's
 * credit list. A read is gated on the READ key — `GET /v1/sales/:saleId`
 * requires `sales.view` and not `sales.create`, and the settlement mirror
 * reads under `suppliers.view` and not `suppliers.pay`. A credit balance is a
 * receivable-surface fact and is business-wide besides (a credit is the
 * customer's across every branch).
 *
 * The permission is checked here as well as by the route decorator. The
 * decorator is the gate a request passes; this is the check a CALL passes, so
 * a future internal caller cannot reach the rows by skipping the controller.
 */
@Injectable()
export class ReceivablesReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async getCustomerPayment(m: MembershipContext, paymentId: string): Promise<CustomerPaymentDto> {
    if (!hasPermission(m.roles, 'receivables.view')) throw receivablesRefusal('customer_payment.not_found');
    return readCustomerPayment(this.db, m, paymentId);
  }

  /** A customer's credits, newest first. Both halves of the remaining pair; no derived status. */
  async listCustomerCredits(m: MembershipContext, customerId: string): Promise<readonly CustomerCreditDto[]> {
    if (!hasPermission(m.roles, 'receivables.view')) throw receivablesRefusal('customer_credit.not_found');
    const rows = await scopedReceivablesRows<{ credit: CustomerCreditDto }>(
      this.db,
      m,
      `SELECT ${CUSTOMER_CREDIT_DTO_SQL} AS credit
         FROM customer_credits k
        WHERE k.business_id = $1 AND k.customer_id = $2
        ORDER BY k.credit_date DESC, k.id DESC
        LIMIT 200`,
      [m.businessId, customerId],
    );
    return rows.map((r) => r.credit);
  }
}

/** An invoice row's stored snapshot, parsed. A snapshot is never looked up again for a line. */
export function invoiceSnapshotRateR10(row: SettledInvoiceRow): bigint {
  return parseUnitCost(row.rate);
}

/** A stored minor-unit text as `bigint`. Never `Number`. */
export const minor = (text: string): bigint => parseMinor(text);
