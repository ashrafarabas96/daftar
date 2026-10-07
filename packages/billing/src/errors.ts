/**
 * Typed SaaS-billing errors — stable machine codes, never money.
 *
 * Phase 5 bills the PLATFORM's own subscriptions. It is financial code, so it
 * follows the same refusal discipline the accounting authority follows
 * (`packages/accounting/src/errors.ts`): one closed code union, a closed
 * context shape, and a safe representation that carries identifiers only.
 *
 * Why a vocabulary of its own rather than `ApiErrorCode`:
 * `packages/domain-core/src/errors.ts` holds the HTTP contract, whose code
 * union is shared by every app and is owned outside this slice. A prepared,
 * not-yet-promoted phase that widened it would be editing a shared file for
 * work that is not canonical yet. So this package refuses in its own
 * vocabulary; mapping `billing.*` onto one HTTP code is a promotion step and
 * is recorded as a patch request, exactly as `accounting.*` is carried under
 * `ACCOUNTING_REFUSED` today.
 *
 * Why no amount ever reaches a message: a refusal is read by logs, by support
 * and by clients. A price, a proration, a balance or a provider's reference
 * are facts about a merchant's commercial relationship, and the one place
 * they belong is the record the command wrote — not the error it threw.
 */

/** Every refusal this slice can produce. One string, one meaning, forever. */
export type BillingErrorCode =
  // Payload (the same line accounting draws: a malformed command is not a
  // business outcome, and the two must never share a code).
  | 'billing.payload_invalid'
  // Billing periods — the calendar, and only the calendar.
  | 'billing.anchor_invalid'
  | 'billing.interval_unsupported'
  | 'billing.as_of_before_anchor'
  | 'billing.as_of_required'
  | 'billing.period_index_invalid'
  | 'billing.period_range_invalid'
  // Proration — a plan change inside a period.
  | 'billing.proration_outside_period'
  | 'billing.proration_currency_mismatch'
  | 'billing.price_invalid'
  // Add-ons.
  | 'billing.addon_quantity_invalid'
  | 'billing.addon_kind_unsupported'
  // Subscription invoice composition.
  | 'billing.invoice_empty'
  | 'billing.invoice_currency_mismatch'
  | 'billing.invoice_line_zero'
  | 'billing.invoice_total_negative'
  /**
   * Platform subscription tax is a POLICY the owner has not settled, and this
   * slice will not guess one. `OD-03` settled sales tax for Phase 4 as a
   * structural zero; nothing has settled tax on the PLATFORM's own invoices,
   * which is a different question (the platform's own jurisdiction, not the
   * merchant's). So a non-zero tax on a subscription invoice is REFUSED here
   * rather than normalized, ignored, or posted as a line nobody authorized.
   * The code names no jurisdiction and carries no rate.
   */
  | 'billing.subscription_tax_unsupported'
  // Dunning — the retry/grace schedule.
  | 'billing.dunning_policy_invalid'
  | 'billing.dunning_attempt_out_of_order'
  // The payment provider port.
  | 'billing.provider_idempotency_key_invalid'
  | 'billing.provider_idempotency_conflict'
  | 'billing.provider_amount_invalid'
  | 'billing.provider_unavailable'
  | 'billing.provider_declined'
  // An invariant this package states about its OWN arithmetic. It is not a
  // payload complaint and not a business outcome: it means a result this
  // module computed violated a law this module promises, which a caller must
  // never be allowed to carry forward as money.
  | 'billing.invariant_violated';

/**
 * Safe identifiers that may accompany a refusal. Deliberately a closed shape:
 * anything not named here cannot reach an error message. In particular there
 * is no `amountMinor`, no `priceMinor` and no `providerPayload` field, so a
 * later edit cannot widen a refusal into a money leak by adding one argument.
 */
export interface BillingErrorContext {
  readonly businessId?: string;
  readonly planKey?: string;
  readonly planVersionId?: string;
  readonly addOnKey?: string;
  /** A civil instant a refusal is about, ISO-8601. An instant is not a value. */
  readonly at?: string;
  /** Which period, counted from the anchor. An index is not a value. */
  readonly periodIndex?: number;
  /** A currency code. A code is not an amount. */
  readonly currency?: string;
  /** The line's position in the composed invoice, 1-based. */
  readonly lineNo?: number;
  /** The dunning attempt's ordinal, 1-based. A count is not a value. */
  readonly attemptNo?: number;
  /** The provider's own reference. An identifier, like every field here. */
  readonly providerRef?: string;
  /** Which law of this module was violated. A name, never the numbers. */
  readonly invariant?: string;
}

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly context: BillingErrorContext;

  constructor(code: BillingErrorCode, message: string, context: BillingErrorContext = {}) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.context = context;
  }

  /**
   * The only representation that should ever be logged or returned. It carries
   * the code and the safe identifiers, and nothing else — in particular not
   * `message`, which a future edit could accidentally widen.
   */
  toSafeJSON(): { code: BillingErrorCode } & BillingErrorContext {
    return { code: this.code, ...this.context };
  }
}

export const billingError = (code: BillingErrorCode, message: string, context: BillingErrorContext = {}): BillingError =>
  new BillingError(code, message, context);

/** Throwing helper, so a guard reads as one expression at the point of refusal. */
export function refuse(code: BillingErrorCode, message: string, context: BillingErrorContext = {}): never {
  throw new BillingError(code, message, context);
}
