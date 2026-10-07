/**
 * Returns — P4-S5: the credit note, its items, and the refund. The contract the
 * web client and the API share (maturity level B).
 *
 * The P3-S6 / P4-S4 settlement conventions hold unchanged, and are not restated
 * here in full — `customer-settlement.ts` is their statement. The three that
 * decide every shape below:
 *
 * - every amount is an integer STRING of MINOR units (`amountMinor: "12500"`),
 *   never major units and never a JSON number;
 * - `…Minor` in a currency is in that currency's minor units, every
 *   `…BaseMinor` is in the business's base currency, and two amounts in
 *   different currencies are never compared: their base difference is realized
 *   FX;
 * - every document id is a client-chosen canonical LOWERCASE uuid and is the
 *   idempotency key. The same id with the same intent answers the stored result
 *   with `replayed: true`; the same id with a different intent is
 *   `….idempotency_conflict` (409). The intent's closed field list is
 *   `REFUND_INTENT_FIELDS` in `@daftar/domain-core`, and the comparison is over
 *   its canonical pre-image, never field by field.
 *
 * ## What is NOT in these shapes, and why each absence is load-bearing
 *
 * 1. **`RefundDto` carries no invoice of any kind** — no `invoiceId`, no
 *    `invoiceNumber`, no list. `TL-P4-S5-R1`: a refund is not an
 *    invoice-outstanding reducer. The credit-note effect reduces AR exactly
 *    once; the refund then consumes the resulting liability or the customer's
 *    credit and AR does not move again. A field naming an invoice would be that
 *    second reduction expressed as a column, and
 *    `REFUND_NAMES_NO_INVOICE` in `@daftar/domain-core` is the predicate a test
 *    plants against.
 * 2. **`RefundDto` carries no payment** — no `paymentId`, no `paymentIds`. The
 *    execution plan's own words for the row: "no column that could name a
 *    payment". A payment already released the invoice's carrying base; drawing a
 *    refund on it would release the same base twice.
 * 3. **There is no `sourceType` discriminator.** The source is `creditNoteId`
 *    XOR `customerCreditId`, exactly one non-null, and the kind is DERIVED by
 *    `resolveRefundSource`. A stored discriminator beside two nullable foreign
 *    keys is the shape GOLD-74 refuses on the financial core.
 * 4. **There is no `refundedAmountMinor` on any source shape.** The cap is the
 *    source's own locked `remainingAmountMinor`, which the database's
 *    COMMIT-time chain verifier holds equal to
 *    `original − Σ(exact stored consumer rows)`. A stored consumption total is
 *    a cap a direct-SQL attacker can rewrite, and it is independently refused as
 *    an authoritative-balance column by G-3.
 * 5. **There is no tax field.** `OD-03` is OPEN and sales tax is structurally
 *    ZERO in this estate, so this layer carries no tax arithmetic. That is a
 *    description of where the question stands, not a guarantee this slice
 *    enforces: with no tax figure anywhere on the path there is nothing here
 *    that could violate one. When OD-03 is settled, these shapes are what it
 *    will have to change.
 * 6. **No shape carries ANY status of a credit note** — not a settlement
 *    status and not a lifecycle one. How much is left is
 *    `remainingAmountMinor`; a status that could disagree with it is the second
 *    truth P4-AL-14 forbids. The lifecycle `'draft' | 'issued' | 'void'` that
 *    `CreditNoteDto` once carried is gone with the lifecycle itself
 *    (`CREDIT_NOTE_HAS_NO_LIFECYCLE`), and a DTO field whose type admits one
 *    value is not a field.
 *
 * The merchant never reads the words in this file. Every refusal renders from
 * `error.credit_note.*` and `error.customer_refund.*` in the three locale
 * catalogues.
 */

// ── The credit note ──────────────────────────────────────────────────────

/**
 * One returned line of a credit note, as the API reports it.
 *
 * `quantity` is the returned quantity in the sale's own unit, as integer text in
 * the unit's fixed scale — the `@daftar/inventory` `Quantity` convention, never
 * a float. `cogsReversalBaseMinor` is the SUM OF THE EXACT STORED
 * `stock_movements.value_delta_base_minor` of this line's return movements, and
 * never `quantity × average cost`: an average cost is a rounded quotient and
 * cannot reproduce the movement that empties a stock key and takes its stored
 * valuation exactly.
 */
export interface CreditNoteItemDto {
  readonly creditNoteItemId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly quantity: string;
  readonly unitPriceMinor: string;
  readonly netMinor: string;
  /** Structurally zero (OD-03 OPEN). Reported so the field has its place the day the zero stops being zero. */
  readonly taxMinor: '0';
  readonly cogsReversalBaseMinor: string;
}

/**
 * A credit note, as the API reports it: the document, its items, and both
 * halves of the remaining pair. **It carries no status at all** — see
 * `CREDIT_NOTE_HAS_NO_LIFECYCLE` in `@daftar/domain-core`. A note is born
 * issued and is thereafter only consumed, so there is no lifecycle field, and
 * §6 of this file's header already forbade a SETTLEMENT status.
 *
 * ## The identity, stated correctly — it has THREE terms, not two
 *
 * An earlier draft of this comment said "`appliedToInvoiceMinor` and
 * `remainingAmountMinor` plus nothing else account for `totalMinor`". That is
 * FALSE, and it was false in the only direction that matters: it omitted the
 * amount REFUNDED in cash. A note of 10 000 that reduced AR by 4 000 and was
 * refunded 6 000 reports `applied = 4 000`, `remaining = 0`, and
 * `4 000 + 0 ≠ 10 000` — so a reader who trusted the two-term identity would
 * conclude 6 000 had gone missing, which is precisely the reconciliation
 * failure the chain verifier exists to prevent. The identity is:
 *
 *     appliedToInvoiceMinor + Σ refunds against this note + remainingAmountMinor = totalMinor
 *
 * **Why the middle term is not a field here.** It would be a stored
 * consumption total — a `refundedAmountMinor` by another name — which §4 of
 * this file's header forbids and which `G-3` independently refuses as an
 * authoritative-balance column. It is read, when a caller wants it, from the
 * `refunds` rows that name this note as their source: the same rows the
 * COMMIT-time chain verifier sums. That verifier is what holds the identity,
 * not a row `CHECK` (P4-AL-26: a derived identity is verified by
 * reconciliation, never stored as a pair of columns).
 *
 * **`appliedToInvoiceMinor` is therefore the ONE named exemption** to the
 * derived-figure law of §4, and it is exempt for a reason that does not
 * generalise: it is the figure by which AR fell — once — and a caller cannot
 * recompute it, because the applications are not in this shape. It is reported
 * as the SUM OF THE STORED APPLICATION ROWS and never as
 * `total − remaining − refunded`, which would make a rounded difference
 * authoritative. `forbiddenRefundFields` admits it by name and nothing else;
 * any second figure of this kind is a contract change, not a convenience.
 */
export interface CreditNoteDto {
  readonly creditNoteId: string;
  readonly creditNoteNumber: string;
  readonly customerId: string;
  readonly creditNoteDate: string;
  readonly currencyCode: string;
  readonly totalMinor: string;
  /** Structurally zero (OD-03 OPEN). */
  readonly taxMinor: '0';
  readonly reference: string | null;
  readonly items: readonly CreditNoteItemDto[];
  /** Σ of the stored `credit_note_applications` rows: the one AR reduction. */
  readonly appliedToInvoiceMinor: string;
  readonly remainingAmountMinor: string;
  readonly remainingCarryingBaseAmountMinor: string;
}

/** One application of a credit note to one invoice, as the API reports it. */
export interface CreditNoteApplicationDto {
  readonly applicationId: string;
  readonly lineNo: number;
  readonly invoiceId: string;
  readonly invoiceCurrencyCode: string;
  readonly creditAmountConsumedMinor: string;
  readonly invoiceAmountAppliedMinor: string;
}

/** The answer of `POST /v1/credit-notes`, and of its read. */
export interface CreditNoteResultDto extends CreditNoteDto {
  readonly applications: readonly CreditNoteApplicationDto[];
  /** True when the command answered a replay and wrote nothing (200, not 201). */
  readonly replayed: boolean;
}

// ── The refund ───────────────────────────────────────────────────────────

/**
 * A refund, as the API reports it.
 *
 * Exactly one of `creditNoteId` / `customerCreditId` is non-null, and the client
 * derives which kind of source it was from that — there is no discriminator (see
 * the header, absence 3).
 *
 * `sourceAmountConsumedMinor` is in the SOURCE's currency and
 * `disbursementAmountMinor` in the currency the money actually left in. When the
 * two currencies are equal the two amounts must be equal
 * (`customer_refund.amount_mismatch`, 422); when they differ, their base
 * difference is `realizedFxGainLossMinor` — signed, positive a gain (4900),
 * negative a loss (6900) — and never a rounding account.
 *
 * `sourceRemainingBeforeMinor` is the LEVEL the refund landed at: the source's
 * remaining as read under `FOR UPDATE` in the refund's own transaction. It is
 * reported because it is what makes a refund's place in the consumption chain
 * auditable from the outside, and it is NOT an input the client chooses.
 */
export interface RefundDto {
  readonly refundId: string;
  readonly customerId: string;
  readonly creditNoteId: string | null;
  readonly customerCreditId: string | null;
  readonly paymentMethodId: string;
  readonly refundDate: string;
  readonly reference: string | null;
  readonly sourceCurrencyCode: string;
  readonly sourceAmountConsumedMinor: string;
  readonly sourceRemainingBeforeMinor: string;
  readonly sourceCarryingBaseReleasedMinor: string;
  readonly disbursementCurrencyCode: string;
  readonly disbursementAmountMinor: string;
  readonly disbursementBaseAmountMinor: string;
  readonly realizedFxGainLossMinor: string;
  /** The source's remaining pair AFTER this refund. */
  readonly sourceRemainingAmountMinor: string;
  readonly sourceRemainingCarryingBaseAmountMinor: string;
}

export interface RefundResultDto extends RefundDto {
  /** True when the command answered a replay and wrote nothing (200, not 201). */
  readonly replayed: boolean;
}

// ── The reads (the P4-S5 read-path obligation) ──────────────────────────

/**
 * One page of a customer's credit notes.
 *
 * A credit note and a refund each get a REAL read route: "state whose only
 * reader is its own commands' return value has NO read path", and the recorded
 * lesson is the POS basket whose rows sat in `pos_cart_lines` while a reloaded
 * till screen lost them. A merchant who issues a credit note and reloads must
 * see it.
 *
 * `nextCursor` is opaque and `null` on the last page. An EMPTY `items` is a
 * correct answer, never a refusal: a customer with no credit note answers
 * `200 []`.
 */
export interface CreditNotePageDto {
  readonly items: readonly CreditNoteDto[];
  readonly nextCursor: string | null;
}

/** One page of a customer's refunds. Same conventions as `CreditNotePageDto`. */
export interface RefundPageDto {
  readonly items: readonly RefundDto[];
  readonly nextCursor: string | null;
}
