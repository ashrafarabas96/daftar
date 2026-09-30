/**
 * Phase 4 invoice domain types and validation (P4-S1, lock P4-AL-12,
 * P4-AL-24, P4-AL-26, P4-AL-31, P4-AL-44, OD-P4-02, OD-P4-07).
 *
 * What this file is, and deliberately is not:
 *
 * - it is the INVOICE's lifecycle, its derived-state vocabulary, its document
 *   numbering vocabulary and the pure rules over an aging question. Nothing
 *   here computes money;
 * - it computes **no outstanding, no paid and no settlement state**. Those are
 *   derived through the product's own SQL functions — `invoice_outstanding(...)`
 *   and `invoice_settlement_state(...)` (lock §4 matrix,
 *   `docs/PHASE_4_ARCHITECTURE_LOCK.md:193,197`) — and P4-AL-07 states that a
 *   second copy of the arithmetic in TypeScript "is a second truth with a
 *   slower failure mode, because it disagrees only under the numbers nobody
 *   tested". So the derivation lives in exactly one place and this file names
 *   its result type only;
 * - `paid + outstanding = total` appears here as neither a check nor a
 *   computation: P4-AL-26 makes it a derived identity verified by
 *   reconciliation (`R-SAL-02`), never a row `CHECK`, and never a pair of
 *   stored columns;
 * - there is **no price override** anywhere: `OD-P4-02` is RULED OPTION A, so a
 *   reduction is a discount and the catalogue price is the price;
 * - tax is **structurally zero**: P4-AL-44 ships `invoices.tax_minor` and
 *   `invoice_items.tax_minor` as real columns under `CHECK (tax_minor = 0)`.
 *   There is no rate, no exemption, no threshold, no inclusive/exclusive rule
 *   and no legal invoice field here, and OD-03 stays open.
 */

// ── Lifecycle (P4-AL-24) ─────────────────────────────────────────────────

/**
 * `invoices.status` is LIFECYCLE ONLY. `purchases.status` is the precedent
 * (`0063:200`: `draft`, `received`, `cancelled` — never settlement). There is
 * no `paid` status, because a payment writes no status: settlement is derived.
 */
export const INVOICE_LIFECYCLE_STATES = ['draft', 'open', 'void'] as const;
export type InvoiceLifecycleState = (typeof INVOICE_LIFECYCLE_STATES)[number];

/**
 * The enumerated transitions the database enforces (lock §10 table). `void` is
 * terminal, and there is no path back to `draft`: P4-AL-46 corrects a
 * commercial mistake with a new document, never by editing the old one.
 *
 * Reaching `void` is a COMPOUND command, not an `UPDATE`: P4-AL-24 requires one
 * transaction that reverses the revenue entry exactly once, reverses the
 * inventory entry, returns the stock and issues any refund from the credit-note
 * source only. A direct `UPDATE invoices SET status = 'void'` is refused by a
 * trigger. That command belongs to a later slice; this table is what it is
 * checked against.
 */
export const INVOICE_LIFECYCLE_TRANSITIONS: readonly { readonly from: InvoiceLifecycleState; readonly to: InvoiceLifecycleState }[] = Object.freeze([
  Object.freeze({ from: 'draft' as const, to: 'open' as const }),
  Object.freeze({ from: 'draft' as const, to: 'void' as const }),
  Object.freeze({ from: 'open' as const, to: 'void' as const }),
]);

/** Whether the enumerated table permits this lifecycle transition. */
export function isInvoiceLifecycleTransitionAllowed(from: InvoiceLifecycleState, to: InvoiceLifecycleState): boolean {
  return INVOICE_LIFECYCLE_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/**
 * The DERIVED settlement state (P4-AL-24). It is never stored and never
 * written: `invoice_settlement_state(...)` returns it from the allocations and
 * the applied credit notes at read time. This type names the three values a
 * response may carry; it does not compute which one.
 */
export const INVOICE_SETTLEMENT_STATES = ['unpaid', 'partial', 'paid'] as const;
export type InvoiceSettlementState = (typeof INVOICE_SETTLEMENT_STATES)[number];

// ── The tax boundary (P4-AL-44, OD-03 OPEN) ──────────────────────────────

/**
 * The only tax amount Phase 4 admits, as integer minor units text.
 *
 * It exists so that the day a Country Pack enables non-zero tax the field is
 * already a signed input and the journal shape already has the line's place.
 * Any other value is refused by the command with `sale.tax_policy_absent` and
 * by `CHECK (tax_minor = 0)` in the database. No merchant screen renders it
 * while the value is zero (P4-AL-52).
 */
export const STRUCTURAL_ZERO_TAX_MINOR = '0' as const;

/** True only for an exact spelling of zero. `"0.00"`, `"-0"` and `""` are not integer minor units. */
export function isStructuralZeroTax(taxMinor: string): boolean {
  return taxMinor === STRUCTURAL_ZERO_TAX_MINOR;
}

// ── Document numbering (P4-AL-31, P4-AL-32) ──────────────────────────────

/**
 * The document kinds that draw a number from `invoice_sequences`. P4-AL-31
 * names exactly two: "Invoice and credit-note numbers are allocated as
 * `max + 1` under the sequence row's lock, backed by a `UNIQUE`".
 */
export const NUMBERED_DOCUMENT_KINDS = ['invoice', 'credit_note'] as const;
export type NumberedDocumentKind = (typeof NUMBERED_DOCUMENT_KINDS)[number];

/**
 * A document number as the API reports it: the rendered string the merchant
 * reads, plus the parts that produced it.
 *
 * The number is allocated by the database as `max(number_seq) + 1` over the
 * committed documents of `(business_id, document_kind, period)` while holding
 * the sequence row's lock — the `inventory_next_deficit_seq` form
 * (`0060:490-513`) — and is backed by a `UNIQUE`. There is NO counter column
 * and NO PostgreSQL sequence: a sequence gaps on rollback and a document
 * number may not gap, and a counter is a derived number and therefore a second
 * truth.
 *
 * `numberSeq` travels as a STRING because it is a `BIGINT`: a JSON number
 * would be an IEEE double.
 */
export interface AllocatedDocumentNumber {
  readonly documentKind: NumberedDocumentKind;
  /** The series the number was drawn from, as the sequence row names it. */
  readonly period: string;
  /** The ordinal inside the series, `>= 1`, as integer text. */
  readonly numberSeq: string;
  /** What the merchant reads, rendered by the database from the sequence row's stored format. */
  readonly documentNumber: string;
}

// ── Aging (OD-P4-03 OPTION A, OD-P4-07 OPTION A) ─────────────────────────

/**
 * `OD-P4-03` is RULED OPTION A: there is no customer credit limit, and "the
 * balance and its aging are shown clearly". The lock's §4 matrix makes aging
 * "the AR journal plus a **supplied** as-of date | computed", and forbids a
 * materialised aging table.
 *
 * The lock does not decide the bucket boundaries, and this file does not decide
 * them either: they are a REQUIRED input of the aging question, validated here
 * and passed to the SQL function. That keeps the server from inventing a
 * commercial policy nobody stated, and it keeps the boundaries out of the
 * database where they would become a stored policy.
 */
export const MAX_AGING_BUCKETS = 6;
/** The largest day boundary a caller may state: ten years, so a boundary is always a real horizon. */
export const MAX_AGING_BUCKET_DAY = 3650;

export type AgingBucketProblem = 'bucket_days_empty' | 'bucket_days_too_many' | 'bucket_days_not_ascending' | 'bucket_days_out_of_range';

/**
 * A supplied set of day boundaries, judged. `[30, 60, 90]` asks for four
 * buckets: `0..30`, `31..60`, `61..90` and `over 90`, each counted in whole
 * days from the invoice's own due date to the supplied as-of date.
 *
 * Strictly ascending, because two equal boundaries would produce an empty
 * bucket the merchant cannot interpret, and a descending pair would silently
 * reorder the answer.
 */
export function validateAgingBucketDays(days: readonly number[]): readonly AgingBucketProblem[] {
  const problems: AgingBucketProblem[] = [];
  if (days.length === 0) problems.push('bucket_days_empty');
  if (days.length > MAX_AGING_BUCKETS) problems.push('bucket_days_too_many');
  if (days.some((d) => !Number.isSafeInteger(d) || d < 1 || d > MAX_AGING_BUCKET_DAY)) problems.push('bucket_days_out_of_range');
  if (days.some((d, i) => i > 0 && d <= (days[i - 1] as number))) problems.push('bucket_days_not_ascending');
  return Object.freeze(problems);
}

/**
 * The labels an aging answer carries, derived from the supplied boundaries.
 * `"0-30"`, `"31-60"`, … and a final `"over-90"`. A label is a stable machine
 * token for the client to translate; it is never rendered raw to a merchant
 * (P4-AL-54).
 */
export function agingBucketLabels(days: readonly number[]): readonly string[] {
  const labels: string[] = [];
  let lower = 0;
  for (const boundary of days) {
    labels.push(`${lower}-${boundary}`);
    lower = boundary + 1;
  }
  const last = days[days.length - 1];
  labels.push(`over-${last ?? 0}`);
  return Object.freeze(labels);
}
