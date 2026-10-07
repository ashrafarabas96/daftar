/**
 * Customer reversal — P4-S6: reversing a customer payment, reversing a single
 * settlement reducer, and voiding an invoice. Levels A and B only: these are
 * the wire shapes, and no route of this file is mounted while P4-S4 and P4-S5
 * are in acceptance.
 *
 * The P3-S6 / P4-S4 settlement conventions hold unchanged
 * (`customer-settlement.ts`):
 *
 * - every amount is an integer STRING of MINOR units, never a JSON number and
 *   never major units;
 * - every document id is a client-chosen canonical LOWERCASE uuid and IS the
 *   idempotency key: resending the same command answers the stored result with
 *   `replayed: true`, and the same id with a different command is
 *   `….idempotency_conflict` (409);
 * - tax: `OD-03` is OPEN and sales tax is structurally ZERO in this estate, so
 *   nothing here carries a tax field. A reversal of an entry that has no tax
 *   line cannot acquire one, because the reversal's amounts are not stated on
 *   the wire at all — see the next paragraph.
 *
 * ## No request in this file carries an amount
 *
 * That is the exact-inverse law as a wire shape. A reversal states WHICH
 * document, WHEN and WHY; every figure is read from the persisted original by
 * `accounting_post_reversal` (`0046:432-440`) and by the S6 command, and
 * historical carrying release is never recomputed. So there is no
 * `amountMinor`, no `releasedMinor` and no rate on any request below, and a
 * client that wanted to reverse "part of" a payment has nowhere to say so —
 * which is the whole-payment law expressed as an absence rather than as a
 * validation.
 *
 * ## The reported shapes do carry amounts, and they are the ORIGINAL's
 *
 * A reversal's DTO reports what was undone so the merchant can see it. Each
 * figure is copied from the reversed row, never recomputed, and the DTO says so
 * by naming its fields after the original's columns.
 *
 * ## The refusal the merchant will meet most often
 *
 * `payment_reversal.not_last_reducer` / `allocation_reversal.not_last_reducer`
 * (409) is the LIFO law (`TL-P4-S6-R1`): a reducer is reversible only while it
 * is the LAST ACTIVE settlement reducer on every chain it affects. It is a real
 * usability wall and it is the ruled design, so the refusal carries the ordered
 * list of reversals that would clear the way (`reverseInThisOrder`) instead of
 * only saying no. The merchant never reads these codes: they render from
 * `error.payment_reversal.*`, `error.allocation_reversal.*` and
 * `error.invoice_void.*` in the three locale catalogues, which are owed by
 * patch request and do not exist yet.
 */

// ── Requests ──────────────────────────────────────────────────────────────

/**
 * `POST /v1/customer-payments/:paymentId/reversal` — reverse a WHOLE payment.
 *
 * There is no allocation list. The command covers every ACTIVE allocation of
 * the payment plus the surplus credit it created, and if any one of them is not
 * a valid tail the whole command is refused.
 */
export interface CustomerPaymentReversalRequestDto {
  /** The reversal document's id, client-chosen, lowercase uuid; the idempotency key. */
  readonly reversalId: string;
  /** The civil date of the reversal, `YYYY-MM-DD`. Required: no clock is read on this path. */
  readonly reversalDate: string;
  /** Required, 1..200 trimmed characters. A reversal without a reason is refused. */
  readonly reason: string;
  /**
   * THE WEBHOOK IDENTITY, both present or both absent.
   *
   * `docs/PHASE_4_EXECUTION_PLAN.md:199` makes `provider_reference` idempotency **at the
   * database** an exit condition of this slice's gate, and
   * `docs/PHASE_4_ARCHITECTURE_LOCK.md:679` specifies a **partial unique** over
   * `(business_id, provider_source, provider_reference)` as the mechanism. The column exists
   * in **zero** of the 87 migrations, so S6 creates it:
   * `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §1A.
   *
   * A merchant-initiated reversal omits both. A payment provider's chargeback webhook (G-11)
   * carries both, and a REDELIVERY of it carries the same pair with a **fresh** `reversalId` —
   * which is why the stored intent hash does not cover `reversalId`, and why a replay found by
   * the provider key returns the stored rows instead of conflicting. Carrying one without the
   * other is unrepresentable at the database, not refused.
   */
  readonly providerSource?: string;
  readonly providerReference?: string;
}

/**
 * `POST /v1/settlement-reducers/:reducerId/reversal` — reverse ONE reducer.
 *
 * The path names the reducer, which is a `payment_allocations.id` or a
 * `customer_credit_applications.id`. The route does not ask the client which it
 * is: the command reads the row, and a client that guessed wrong would be
 * stating a fact about the database it does not own.
 */
export interface SettlementReducerReversalRequestDto {
  readonly reversalId: string;
  readonly reversalDate: string;
  readonly reason: string;
}

/**
 * `POST /v1/invoices/:invoiceId/void` — the compound command (P4-AL-24).
 *
 * A direct `PATCH` of the invoice's status is not a route of this API and a
 * direct `UPDATE invoices SET status = 'void'` is refused at the database. This
 * is the only door, and it has a precondition rather than a power: the
 * invoice's AR chain must carry no active reducer.
 */
export interface InvoiceVoidRequestDto {
  readonly voidId: string;
  readonly voidDate: string;
  readonly reason: string;
}

// ── Reported shapes ───────────────────────────────────────────────────────

/** One chain a reversal freed, and the level it freed on it. */
export interface ReversedChainDto {
  /** An `invoices.id` or a `customer_credits.id`. */
  readonly chainId: string;
  readonly chainKind: 'invoice_ar' | 'customer_credit';
  /**
   * The level the reversal freed — the reversed row's own stored level, copied
   * and not recomputed. It is `ar_released_before_txn_minor` on an `invoice_ar`
   * chain and `credit_remaining_before_minor` on a `customer_credit` chain, so
   * it is reported in the stored column's own sense and a reader does not have
   * to know which way the chain runs.
   */
  readonly freedLevelMinor: string;
  /** The amount the reversed row consumed, copied from the original. */
  readonly amountMinor: string;
}

/** One journal entry a reversal mirrored, and the mirror it produced. */
export interface ReversedEntryDto {
  readonly originalEntryId: string;
  readonly reversalEntryId: string;
  readonly sourceType: 'customer_payment_allocation' | 'customer_credit_application' | 'customer_credit' | 'invoice' | 'sale';
  readonly sourceId: string;
}

/** One reducer a reversal undid. */
export interface ReversedReducerDto {
  readonly reducerId: string;
  readonly kind: 'payment_allocation' | 'credit_application';
  readonly chains: readonly ReversedChainDto[];
}

/** The answer of the payment reversal, and of its read. */
export interface CustomerPaymentReversalDto {
  readonly reversalId: string;
  readonly paymentId: string;
  readonly reversalDate: string;
  readonly reason: string;
  /** Every allocation the reversal covered. Empty when the payment was pure on-account money (R-87). */
  readonly reducers: readonly ReversedReducerDto[];
  /** The surplus credit the reversal undid, or null when the payment created none. */
  readonly surplusCreditId: string | null;
  readonly entries: readonly ReversedEntryDto[];
}

export interface CustomerPaymentReversalResultDto extends CustomerPaymentReversalDto {
  /** True when the command answered a replay and wrote nothing (200, not 201). */
  readonly replayed: boolean;
}

/** The answer of the single-reducer reversal. */
export interface SettlementReducerReversalResultDto {
  readonly reversalId: string;
  readonly reducer: ReversedReducerDto;
  readonly reversalDate: string;
  readonly reason: string;
  readonly entries: readonly ReversedEntryDto[];
  readonly replayed: boolean;
}

/** The answer of the void. */
export interface InvoiceVoidResultDto {
  readonly voidId: string;
  readonly invoiceId: string;
  readonly voidDate: string;
  readonly reason: string;
  readonly entries: readonly ReversedEntryDto[];
  readonly replayed: boolean;
}

/**
 * The details a `*.not_last_reducer` refusal carries.
 *
 * `reverseInThisOrder` is newest-first, which is the only order the LIFO law
 * admits, and it names reducers rather than amounts: a refusal never carries an
 * amount. It exists so the client can offer the merchant the next lawful step
 * instead of a dead end.
 */
export interface NotLastReducerDetailsDto {
  readonly chainId: string;
  readonly chainKind: 'invoice_ar' | 'customer_credit';
  readonly reverseInThisOrder: readonly string[];
}
