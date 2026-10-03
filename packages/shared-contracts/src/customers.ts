/**
 * Customers and their contacts — P4-S1 (lock P4-AL-08, P4-AL-09, P4-AL-05,
 * P4-AL-06, P4-AL-54; `OD-P4-03` OPTION A; `OD-P4-07` OPTION A).
 *
 * The Phase 3 conventions hold unchanged, and two of them matter here:
 *
 * - **money is an integer count of minor units carried as a STRING.** Never a
 *   JSON number: a double cannot hold an LBP receivable exactly, and one
 *   implicit coercion is unrecoverable. `…BaseMinor` is the business's base
 *   currency, `…TxnMinor` the document's own currency;
 * - every id a client chooses is a canonical LOWERCASE uuid, and the customer
 *   id IS the idempotency key of the create: resending the same command answers
 *   the stored result with `replayed: true` (P4-AL-30 — a document UUID plus a
 *   stored `intent_sha256`, and no `idempotency_key` anywhere).
 *
 * Three things are absent by ruling rather than by omission:
 *
 * - **no credit limit.** `OD-P4-03` is RULED OPTION A: no per-customer limit in
 *   Phase 4, so no field, and no refusal a limit could drive. The balance and
 *   its aging are shown instead;
 * - **no stored balance, amount due, outstanding or settled figure.** Every
 *   receivable below is DERIVED per request from the AR journal through the
 *   product's own SQL function; P4-AL-06 forbids the column and P4-S1's
 *   extension of guard G-3 proves it in CI;
 * - **no tax identifier and no registration flag.** P4-AL-44 records that the
 *   registered / unregistered / exempt distinction "has no representation in
 *   the data model yet", and P4-AL-45 forbids inventing one while OD-03 is
 *   open.
 *
 * No response here carries a journal entry id, an account code, a journal line,
 * a routine name, a GUC, a constraint name or a raw SQL error (P4-AL-54).
 */

import type { InvoiceSettlementState, NumberedDocumentKind } from '@daftar/domain-core';

// ── Requests ─────────────────────────────────────────────────────────────

/**
 * One contact of a customer. A contact is a person to reach; no permission, no
 * authority and no notification policy hangs off it in Phase 4.
 *
 * `name` is 1..200 characters after trimming, `phone` 1..40, `email` 3..254 and
 * address-shaped, `notes` 1..1000. At least one of `phone` and `email` is
 * stated (`customer.contact_reachability_missing`), and at most one contact of
 * a customer is `isPrimary` (`customer.contact_primary_ambiguous`).
 */
export interface CustomerContactRequestDto {
  /** Client-chosen canonical lowercase uuid; the contact keeps its id across statements. */
  contactId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}

/**
 * The editable customer fields. An update states the WHOLE customer: an
 * omitted or null optional field is stored as NULL, and a contact the statement
 * does not name is removed. It never merges — the accepted supplier rule
 * (`purchasing.ts:37-46`), for the same reason: a merge cannot express "clear
 * this".
 */
export interface CustomerFieldsDto {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  /** At most 20 (`customer.contacts_too_many`). Omitted means none. */
  contacts?: CustomerContactRequestDto[];
}

/**
 * `POST /v1/customers` — requires `customers.manage`. 201 on create, 200 on
 * replay. The customer id is the client's idempotency key; a replay carrying a
 * different statement is `customer.idempotency_conflict` (409), because the
 * stored `intent_sha256` proves WHICH command is being replayed before the
 * command reads anything else.
 */
export interface CustomerCreateRequestDto extends CustomerFieldsDto {
  customerId: string;
}

/** `PUT /v1/customers/:customerId` — requires `customers.manage`. */
export interface CustomerUpdateRequestDto extends CustomerFieldsDto {
  /** The revision the client read (>= 1); a moved revision is `customer.revision_changed` (409). */
  expectedRevision: number;
}

/** `POST /v1/customers/:customerId/archive` and `/reactivate` — require `customers.manage`. */
export interface CustomerLifecycleRequestDto {
  expectedRevision: number;
}

// ── Responses ────────────────────────────────────────────────────────────

export type CustomerStatusDto = 'active' | 'inactive';

/** One contact as stored, in `contactNo` order. */
export interface CustomerContactDto {
  contactId: string;
  /** Stable ordinal inside the customer, `>= 1`; a JSON number, like a revision. */
  contactNo: number;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isPrimary: boolean;
}

/**
 * A customer as stored. Deliberately carries NO balance: a balance needs an
 * as-of date and a currency, and storing one would be the second truth
 * P4-AL-06 refuses. `GET …/receivable` answers that question.
 */
export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: CustomerStatusDto;
  revision: number;
  createdAt: string;
  updatedAt: string;
  contacts: CustomerContactDto[];
}

/** A customer as a list returns it: no contacts, so one page is one query. */
export interface CustomerListItemDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: CustomerStatusDto;
  revision: number;
  /** The primary contact's name, or null when the customer named none. */
  primaryContactName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The answer of every customer command — always read back from the stored row. */
export interface CustomerCommandResultDto extends CustomerDto {
  /** True when this is the stored result of an earlier identical command. */
  replayed: boolean;
  /** The trace id of the operation that last changed the customer. */
  businessTransactionId: string;
}

/** `GET /v1/customers` — requires `customers.view`. Keyset, never `OFFSET`. */
export interface CustomerPageDto {
  items: CustomerListItemDto[];
  /** Opaque keyset cursor, or `null` on the last page. */
  nextCursor: string | null;
}

// ── The receivable read (derived, never stored) ───────────────────────────

/** One currency's figure, as integer minor units text. */
export interface CustomerCurrencyAmountDto {
  currency: string;
  txnMinor: string;
}

/**
 * `GET /v1/customers/:customerId/receivable` — requires `receivables.view` AND
 * business-wide branch scope.
 *
 * It sums across every branch of the business, so an assigned-scope actor is
 * refused before any read (the accepted `SupplierPayableDto` precedent,
 * `suppliers.controller.ts:139-146`). Derived per request from the
 * `journal_lines` on the AR account scoped to this customer, through the
 * product's own `customer_ar_outstanding(...)`; there is no cached balance to
 * read and none to invalidate.
 *
 * `OD-P4-07` is RULED OPTION A, so the currency figures are the HISTORICAL ones
 * as posted. There is no revaluation column, no today's-rate figure and no
 * "worth now": a number no journal line supports is a number someone will
 * reconcile against.
 */
export interface CustomerReceivableDto {
  customerId: string;
  /** Outstanding AR in base-currency minor units, integer string (debit − credit). */
  baseMinor: string;
  baseCurrency: string;
  /** The same outstanding amount per invoice currency, at that currency's minor units, as posted. */
  byCurrency: CustomerCurrencyAmountDto[];
}

/** One bucket of an aging answer. */
export interface CustomerAgingBucketDto {
  /** A stable machine token — `"0-30"`, `"31-60"`, `"over-90"` — which the client translates (P4-AL-54). */
  label: string;
  /** Inclusive lower bound in whole days past due; 0 for the first bucket. */
  fromDays: number;
  /** Inclusive upper bound, or `null` for the final open bucket. */
  toDays: number | null;
  baseMinor: string;
  byCurrency: CustomerCurrencyAmountDto[];
  /** How many open invoices fall in the bucket. A count, so a JSON number. */
  invoiceCount: number;
}

/**
 * `GET /v1/customers/:customerId/receivable/aging` — requires
 * `receivables.view` AND business-wide branch scope.
 *
 * `asOf` and `bucketDays` are BOTH required inputs. The as-of date is supplied
 * because the lock's §4 matrix makes aging "the AR journal plus a **supplied**
 * as-of date", and because a command or a read that resolves a date from the
 * server's clock answers a different question either side of local midnight.
 * The boundaries are supplied because the lock decides no bucket policy and the
 * server may not invent one; they are never stored, so there is no materialised
 * aging table (forbidden by the same matrix row).
 */
export interface CustomerAgingDto {
  customerId: string;
  /** `YYYY-MM-DD`, the supplied civil date every bucket is measured to. */
  asOf: string;
  baseCurrency: string;
  /** The supplied ascending day boundaries, echoed so the answer is self-describing. */
  bucketDays: number[];
  /** `bucketDays.length + 1` buckets, in ascending age order, the open bucket last. */
  buckets: CustomerAgingBucketDto[];
  /** Σ of the buckets, in base minor units. Equal to `receivable.baseMinor` restricted to open invoices. */
  totalBaseMinor: string;
}

/**
 * One row of the customer's open document list, used by the customer picker
 * `OD-P4-03` requires ("the balance and the aging are shown on the customer
 * picker"). Oldest first.
 */
export interface CustomerOpenInvoiceDto {
  invoiceId: string;
  documentKind: NumberedDocumentKind;
  documentNumber: string;
  /** `YYYY-MM-DD`, as the invoice states it. */
  issueDate: string;
  /** `YYYY-MM-DD`, or null when the invoice named no due date. */
  dueDate: string | null;
  currency: string;
  totalTxnMinor: string;
  /** Derived through `invoice_outstanding(...)`; never a stored column. */
  outstandingTxnMinor: string;
  outstandingBaseMinor: string;
  /** Derived through `invoice_settlement_state(...)`; never `invoices.status`. */
  settlementState: InvoiceSettlementState;
  /** Whole days from `dueDate` to the supplied as-of date; negative before it, null with no due date. */
  daysPastDue: number | null;
}

/** `GET /v1/customers/:customerId/open-invoices` — requires `receivables.view`. */
export interface CustomerOpenInvoicesDto {
  customerId: string;
  asOf: string;
  items: CustomerOpenInvoiceDto[];
  nextCursor: string | null;
}
