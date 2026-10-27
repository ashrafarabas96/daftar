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
  /** A stable machine token — `"not-due"`, `"1-30"`, `"31-60"`, `"over-90"` — which the client translates (P4-AL-54). */
  label: string;
  /**
   * Inclusive lower bound in whole days past due, and **`null` for the first
   * bucket, which has none** (DR-10).
   *
   * The first bucket holds every invoice whose days-past-due does not exceed
   * `bucketDays[0]`, and days-past-due is NEGATIVE for an invoice not yet due,
   * so the bound is open below. It used to be reported as `0`, which was a
   * false statement about a money figure: under the standard boundaries
   * `[0, 30, 60, 90]` this bucket is exactly the NOT-DUE one, and under a
   * caller's own `[30, 60, 90]` it is the one that mixes not-due invoices in
   * with those up to thirty days late.
   */
  fromDays: number | null;
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
  /**
   * Σ of the buckets, in base minor units. Equal to `receivable.baseMinor`
   * restricted to open invoices.
   *
   * **This is the TOTAL RECEIVABLE — "إجمالي الذمم" — and not overdue debt**
   * (DR-10). It includes the first bucket, which under the standard boundaries
   * is the money NOT YET DUE. A client that labels this figure as late, or as
   * what the customer owes in arrears, misstates it; the overdue total is the
   * sum of the buckets AFTER the not-due one.
   */
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
  /**
   * **For a DEBIT document:** whole days from its AGE ANCHOR to the supplied
   * as-of date — `asOf - coalesce(dueDate, issueDate)` (DR-28), negative
   * before the anchor and zero ON it. Never a fraction, never a clock
   * reading: a civil date minus a civil date has no timezone.
   *
   * **For a CREDIT-bearing row, this is `0` (DR-31).** A credit note — and any
   * credit balance, such as an overpaid invoice (DR-23) — is not overdue debt,
   * so it has no overdue age. `isCredit` is `true` on exactly those rows and
   * `ageDays` carries the age of the DOCUMENT the credit sits on. An interface
   * must render such a row as "رصيد دائن على فاتورة عمرها X يومًا" /
   * "a credit balance on an invoice X days old", and **never** as "متأخر" /
   * "overdue". Nor in the superseded form that names the CREDIT's own age
   * instead of the invoice's: this field does not measure the credit's age, and
   * for an overpaid invoice that form overstates it. DR-35 forbids it, and
   * `dr35_2`/`dr35_2b` hold the ban over the whole tree, which is why the
   * banned wording is not quoted here. DR-28 and DR-31 do not collide: DR-28
   * governs an invoice that is DUE, and a credit is not due from the customer.
   *
   * The zero is a literal, not a clamp: it is never negated and never the
   * result of subtracting anything, so this field cannot be negative for a
   * credit. And it is never `null` for anything, credit or debit.
   *
   * **NEVER `null`.** This field used to be `number | null`, with `null`
   * meaning "the invoice named no due date" — and that is exactly the defect
   * DR-28 closes. Under DR-13 and DR-21 a termless invoice is due from its
   * ISSUE date and the aging report bands it accordingly, so a `null` here
   * showed the merchant a dash on the open-invoices page for a debt the
   * report was already placing in the over-90 band. The page hid the age the
   * report asserted, and the merchant acts on the page.
   *
   * The fallback can only move a figure in ONE direction — `issueDate` is
   * `DATE NOT NULL` and `invoices_due_date_ck` requires
   * `dueDate IS NULL OR dueDate >= issueDate` — so substituting the issue
   * date never reports an invoice as LESS overdue than it is. That is the
   * safe direction for a receivable: the error, if any, is toward noticing a
   * debt, never toward losing one.
   *
   * "No stated due date" is a DISPLAY fact and travels in
   * `hasExplicitDueDate`, which is a separate field precisely so that it can
   * never be confused with an age of zero or a negative age.
   */
  daysPastDue: number;
  /**
   * `true` when the invoice states its own due date, `false` when it named
   * none and the age above is therefore anchored on `issueDate` (DR-28).
   *
   * This is what a client renders as "بلا أجل محدد" / "no stated due date".
   * It is `dueDate !== null` and NOTHING else: it is not inferred from
   * `daysPastDue`, so a legitimately zero or negative age is never mistaken
   * for a missing term.
   */
  hasExplicitDueDate: boolean;
  /**
   * Whole days from **the document's own date** to the supplied as-of date:
   * `asOf - issueDate`, for EVERY document kind, debit or credit (DR-31).
   * Negative before that date, zero ON it.
   *
   * **Deliberately NOT the same expression as `daysPastDue`.** That field
   * anchors on `coalesce(dueDate, issueDate)` because it answers "how late is
   * this debt", and lateness is measured against a term. This one answers "how
   * old is this document", so it reads the document's own date and nothing
   * else: a payment term is not part of a document's age, and a credit note
   * has no meaningful term at all.
   *
   * Three consequences, all intended:
   *
   * - **Nothing is substituted here, so no substitution has to be signed.**
   *   `issueDate` is `DATE NOT NULL` on every row of every kind, so the
   *   subtraction is total with no fallback; a `coalesce` would be dead code.
   * - It is the figure a client renders for a credit as
   *   "a credit balance on an invoice X days old" — the DOCUMENT's age and
   *   not the credit's, which is why the wording names the invoice (DR-35).
   * - The two fields stay INDEPENDENT. Had this anchored on the due date, a
   *   debit invoice with a stated term would satisfy `ageDays === daysPastDue`
   *   and a client could derive either from the other — a derivation that
   *   would silently break the first time a credit appeared.
   */
  ageDays: number;
  /**
   * `true` when this row carries CREDIT rather than debt (DR-31): the document
   * is a credit note, or its outstanding figure is negative — an overpaid
   * invoice holding a credit balance (DR-23).
   *
   * Driven by the document's own KIND or by the SIGN of its money, and by
   * NOTHING ELSE. In particular it is **not** `daysPastDue === 0`: a debit
   * invoice due exactly on the as-of date has `daysPastDue === 0` and
   * `isCredit === false`. A client that infers one from the other will show a
   * debt due today as a credit balance.
   *
   * The kind arm is enumerated POSITIVELY (`credit_note`), not as "anything
   * that is not an invoice". That is the signed direction: sweeping an unknown
   * future kind in as credit would force its `daysPastDue` to zero and stop a
   * real debt reading as overdue, which is the one failure DR-13/DR-21/DR-30
   * forbid. The opposite mistake shows a credit labelled overdue — visibly
   * wrong, but it hides nothing.
   */
  isCredit: boolean;
}

/** `GET /v1/customers/:customerId/open-invoices` — requires `receivables.view`. */
export interface CustomerOpenInvoicesDto {
  customerId: string;
  asOf: string;
  items: CustomerOpenInvoiceDto[];
  nextCursor: string | null;
}
