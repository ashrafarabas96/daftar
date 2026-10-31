/**
 * Invoices, invoice items and per-business document numbering — P4-S1 (lock
 * P4-AL-12, P4-AL-16, P4-AL-24, P4-AL-26, P4-AL-31, P4-AL-32, P4-AL-44,
 * P4-AL-54; `OD-P4-02` OPTION A; `OD-P4-07` OPTION A).
 *
 * **There is no invoice create request, and that is the design.** P4-AL-16's
 * atomic sale law makes the `invoices` row, its items, its number and its
 * revenue/AR entry part of ONE transaction with the `sales` row, the stock
 * movements and the COGS entry: "There is no intermediate state in which stock
 * left the shelf and no invoice exists, or an invoice exists and no movement
 * was written." A `POST /v1/invoices` would be exactly that intermediate state
 * offered over HTTP. The invoice is therefore written only by the sale command,
 * and the P4-S1 invoice surface is a READ surface plus the numbering it reads.
 *
 * Voiding is likewise absent here: P4-AL-24 makes it a compound command that
 * reverses the revenue entry once, reverses the inventory entry, returns the
 * stock and issues any refund from the credit-note source only — a direct
 * `UPDATE invoices SET status='void'` is refused by a trigger.
 *
 * Conventions:
 *
 * - **every money value is an integer count of minor units carried as a
 *   STRING.** `…TxnMinor` is the invoice's own currency, `…BaseMinor` the
 *   business's base currency. Quantities are decimal strings (`NUMERIC(18,4)`)
 *   and unit prices are decimal strings of minor units (`NUMERIC(28,10)`),
 *   never JSON numbers;
 * - a line names its stock identity as `productId` plus, only for a product
 *   with merchant variants, `variantId`; a simple product's line carries
 *   `variantId: null` (P3-AL-52, the accepted purchase-line rule);
 * - **discount only.** `OD-P4-02` is RULED OPTION A: a line carries
 *   `discountTxnMinor` and there is NO price override field anywhere. A price
 *   arriving from a client is ignored, not validated (P4-AL-18);
 * - **tax is structurally zero.** `taxMinor` is always `"0"` (P4-AL-44), under
 *   `CHECK (tax_minor = 0)`. No rate, no exemption, no threshold, no
 *   inclusive/exclusive rule and no legal invoice field exists. No merchant
 *   screen renders the field while the value is zero (P4-AL-52);
 * - **nothing settlement-shaped is stored.** `paidTxnMinor` and
 *   `outstandingTxnMinor` below are DERIVED per request through
 *   `invoice_outstanding(...)`, and `settlementState` through
 *   `invoice_settlement_state(...)`. P4-AL-06 forbids the columns and P4-AL-26
 *   makes `paid + outstanding = total` a reconciliation identity, not a row
 *   `CHECK`;
 * - no response carries a journal entry id, an account code, a journal line, a
 *   routine name, a GUC, a constraint name or a raw SQL error (P4-AL-54).
 */

import type { AllocatedDocumentNumber, InvoiceLifecycleState, InvoiceSettlementState, NumberedDocumentKind } from '@daftar/domain-core';

// ── Numbering (P4-AL-31, P4-AL-32) ───────────────────────────────────────

/**
 * One document series of the business: the lock and the format for
 * `(businessId, documentKind, period)`.
 *
 * The row exists "to be the lock and to hold the format, not to hold the
 * count" (P4-AL-31). So this DTO reports no counter and no "next number": a
 * next-number read would be a number nobody allocated, and publishing it would
 * invite a client to use it. The ordinal is `max + 1` computed inside the sale's
 * transaction while holding this row, and the sequence row is the LAST domain
 * lock a sale takes (P4-AL-32).
 *
 * Per-business isolation is structural: the key includes the business, so two
 * businesses of one tenant have two independent series and no tenant-level
 * mixing is expressible.
 */
export interface DocumentSequenceDto {
  documentKind: NumberedDocumentKind;
  /** The series key, as the business configured it. */
  period: string;
  /** The stored rendering format of the series, reported so a client can explain a number to a merchant. */
  format: string;
  /**
   * The highest ordinal COMMITTED in this series, as integer text, or `"0"`
   * while the series is empty. It is a read over the documents, not a stored
   * counter: a rolled-back sale took its number with it, so this figure can
   * only ever be the truth.
   */
  highestCommittedSeq: string;
}

/** `GET /v1/document-sequences` — requires `sales.view`. */
export interface DocumentSequenceListDto {
  items: DocumentSequenceDto[];
}

/** Re-exported so an invoice response and a numbering response name one type. */
export type { AllocatedDocumentNumber };

// ── Invoice responses ────────────────────────────────────────────────────

export type InvoiceStatusDto = InvoiceLifecycleState;
export type InvoiceSettlementStateDto = InvoiceSettlementState;

/**
 * The customer as it was when the invoice was issued, immutable thereafter
 * (the accepted `PurchaseSupplierSnapshotDto` rule, `purchasing.ts:189-193`):
 * renaming a customer never rewrites a document they already hold.
 *
 * `null` for a walk-in sale, whose `customerId` is null. P4-AL-11 makes that
 * null the honest representation and refuses a synthetic "walk-in customer"
 * row, "because a synthetic customer is a real row that accumulates a real
 * balance, which is exactly the customer-balance defect with a friendly name".
 */
export interface InvoiceCustomerSnapshotDto {
  name: string;
  phone: string | null;
}

/**
 * The rate the invoice was posted at, frozen on the document. A rate entered
 * tomorrow never changes it, and no read looks a current rate up
 * (`OD-P4-07` OPTION A).
 */
export interface InvoiceRateDto {
  rateId: string | null;
  /** Units of base currency per unit of the invoice currency, decimal string (at most 10 fraction digits). */
  rate: string;
  source: 'base' | 'manual' | 'provider';
  /** The rate instant, RFC3339 UTC at second precision. */
  at: string;
}

/** One invoice item. Discount only: there is no override field (`OD-P4-02` OPTION A). */
export interface InvoiceItemDto {
  itemId: string;
  /** Stable ordinal inside the invoice, `>= 1`. */
  lineNo: number;
  productId: string;
  /** The merchant variant, or null for a simple product. */
  variantId: string | null;
  /** The product name as it was when the invoice was issued. */
  nameSnapshot: string;
  /** Decimal string, at most 4 fraction digits. */
  quantity: string;
  /** Minor units of the invoice currency as a decimal string, at most 10 fraction digits. */
  unitPriceTxnMinor: string;
  grossTxnMinor: string;
  /** `>= 0` and at most `grossTxnMinor`. The ONLY reduction Phase 4 admits. */
  discountTxnMinor: string;
  netTxnMinor: string;
  /** Always `"0"` (P4-AL-44, OD-03 open). */
  taxMinor: string;
  /** The line's share of the base total, computed at the line grain with no intermediate rounding. */
  baseShareMinor: string;
}

/** An invoice as a list returns it. */
export interface InvoiceSummaryDto {
  id: string;
  /** Null for a walk-in sale (P4-AL-11). */
  customerId: string | null;
  documentKind: NumberedDocumentKind;
  documentNumber: string;
  /** The ordinal inside its series, as integer text. */
  numberSeq: string;
  /** `YYYY-MM-DD`, a supplied input — never a server-resolved clock read (P4-AL-30). */
  issueDate: string;
  dueDate: string | null;
  currency: string;
  /** LIFECYCLE ONLY: `draft`, `open`, `void`. Never a settlement value (P4-AL-24). */
  status: InvoiceStatusDto;
  totalTxnMinor: string;
  totalBaseMinor: string;
  createdAt: string;
}

/** `GET /v1/invoices/:invoiceId` — requires `sales.view`. */
export interface InvoiceDto extends InvoiceSummaryDto {
  /** The `sales` row this invoice was billed for. Two tables, two accounting sources (P4-AL-12). */
  saleId: string;
  branchId: string;
  notes: string | null;
  subtotalTxnMinor: string;
  /** Σ of the items' discounts. A total, not a second authority: each item carries its own. */
  discountTxnMinor: string;
  /** Always `"0"` (P4-AL-44). */
  taxMinor: string;
  rate: InvoiceRateDto;
  customerSnapshot: InvoiceCustomerSnapshotDto | null;
  voidedAt: string | null;
  items: InvoiceItemDto[];
}

/** `GET /v1/invoices` — requires `sales.view`. Keyset, never `OFFSET`. */
export interface InvoicePageDto {
  items: InvoiceSummaryDto[];
  nextCursor: string | null;
}

/**
 * `GET /v1/invoices/:invoiceId/settlement` — requires `receivables.view`.
 *
 * Every figure here is DERIVED at read time through the product's own functions
 * (`invoice_outstanding(...)`, `invoice_settlement_state(...)`), which are the
 * same functions the reconciliation check `R-SAL-02` and the performance budget
 * use — P4-AL-07's rule, because "a second copy of the arithmetic in TypeScript
 * is a second truth with a slower failure mode".
 *
 * `paidTxnMinor + outstandingTxnMinor = totalTxnMinor` holds, as a derived
 * identity verified by reconciliation and by golden G-14 after every partial
 * payment — never as a row `CHECK` over two stored columns (P4-AL-26).
 */
export interface InvoiceSettlementDto {
  invoiceId: string;
  currency: string;
  baseCurrency: string;
  totalTxnMinor: string;
  totalBaseMinor: string;
  /** Σ of the unreversed allocations and applied credit notes, in the invoice currency. */
  paidTxnMinor: string;
  paidBaseMinor: string;
  outstandingTxnMinor: string;
  outstandingBaseMinor: string;
  /** `unpaid` / `partial` / `paid`, derived — never `invoices.status` (P4-AL-24). */
  settlementState: InvoiceSettlementStateDto;
}
