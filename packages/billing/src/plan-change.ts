/**
 * What a plan change PRODUCES — `TL-P5-R3`.
 *
 * `proratePlanChange` answers an arithmetic question and returns a `netMinor`
 * that is negative on a downgrade. That number is correct and useless on its
 * own: an invoice cannot carry it (a negative subscription invoice is refused
 * in `invoice.ts`) and a provider must not be handed it. The owner's ruling
 * says what it becomes:
 *
 *   negative proration creates A PLATFORM BILLING CREDIT; it does NOT
 *   automatically trigger a cash/provider refund; if the owner later
 *   authorizes a cash refund, that is a separate explicit payout command.
 *
 * So this module is the single place where the sign of a proration turns into
 * an action, and it offers exactly three:
 *
 *   `invoice`  — net above zero: an invoice with both proration lines.
 *   `credit`   — net below zero: ONE credit `grant` adjustment, nothing else.
 *   `nothing`  — net exactly zero: no invoice, no adjustment, no line.
 *
 * ── Why a discriminated outcome and not an invoice with a flag ───────────
 *
 * A function that always returned an invoice, with a credit hiding in a
 * field, would let a caller ignore the field and bill a downgrade. A caller
 * of this function cannot read an amount without first reading which of the
 * three happened, because the amount does not exist on the other two shapes.
 * It is the same reason `decideDunning` returns an action rather than a
 * nullable charge.
 *
 * ── Why `nothing` is a named outcome ────────────────────────────────────
 *
 * A zero net is the common case of a same-price plan change, and the two
 * wrong answers are both plausible: an invoice totalling zero (which the
 * merchant then sees in their billing history as an event that cost them
 * nothing and explains nothing) and a zero-amount credit adjustment (which
 * pollutes an append-only ledger with rows that never move a balance).
 * Naming the outcome refuses both without a comment asking the caller to be
 * careful.
 *
 * ── What is NOT here, by ruling ─────────────────────────────────────────
 *
 * Any path from a credit to cash. This module creates a `grant`; it never
 * consumes one, never nets one against the invoice it may return in a
 * different branch, and contains no `refund` or `payout` symbol — an absence
 * `test/plan-change.test.ts` asserts over this file's own source, exactly as
 * `credit.ts` does over its own.
 */
import { composeSubscriptionInvoice, type ComposedSubscriptionInvoice, type SubscriptionInvoiceLine } from './invoice';
import { proratePlanChange, type ProrationInput, type ProrationResult } from './proration';
import { refuse } from './errors';
import { foldCreditBalance, type CreditAdjustment } from './credit';

export const PLAN_CHANGE_OUTCOMES = ['invoice', 'credit', 'nothing'] as const;
export type PlanChangeOutcome = (typeof PLAN_CHANGE_OUTCOMES)[number];

export interface PlanChangeInput extends ProrationInput {
  /**
   * Whose subscription is changing. Carried onto the credit adjustment,
   * because `TL-P5-R5` scopes a credit ledger to one business and the fold
   * refuses a ledger that mixes two.
   */
  readonly businessId: string;
  /** The plan being left. An identifier; it becomes the credit line's `ref`. */
  readonly fromPlanKey: string;
  /** The plan being joined. An identifier; it becomes the charge line's `ref`. */
  readonly toPlanKey: string;
  /**
   * The identity the credit adjustment will carry if one is produced. Minted
   * by the command, never here: an adjustment whose id this function invented
   * could not be recognised as a replay by `foldCreditBalance`.
   */
  readonly adjustmentId: string;
  /** Why the credit exists, if one is produced. Mandatory on the adjustment. */
  readonly creditReason: string;
  /**
   * The business's credit ledger, EVERY row of it, in the order the ledger
   * itself is ordered by (`occurredAt`, which is what `foldCreditBalance`
   * measures monotonicity on). MANDATORY, and not defaulted to empty.
   *
   * DECLARED LIMIT, because it has no call site yet to pin it on: a caller that
   * FILTERED this by the new plan's currency would hand this law a ledger with
   * the stranded balance already removed from it, and the refusal below would
   * never fire -- which is the one way to defeat DR-97 while appearing to obey
   * it. The contract is "every row", and the first real call site is where it
   * gets pinned by a test rather than by this sentence. Measured at this
   * commit: zero callers in the repository outside this package's own tests.
   *
   * DR-97: a credit ledger is scoped to ONE currency and this slice has no
   * rate, no expiry and no reversal, so a plan change into another currency
   * leaves whatever balance exists unspendable for good. The change is
   * therefore refused while such a balance exists, which means this function
   * has to be able to SEE the balance. A caller that cannot supply the ledger
   * is a caller that does not know whether it is stranding money, and an empty
   * default would read exactly like a business with no credit.
   */
  readonly ledger: readonly CreditAdjustment[];
}

export type PlanChangeBilling =
  | { readonly outcome: 'invoice'; readonly proration: ProrationResult; readonly invoice: ComposedSubscriptionInvoice }
  | { readonly outcome: 'credit'; readonly proration: ProrationResult; readonly adjustment: CreditAdjustment }
  | { readonly outcome: 'nothing'; readonly proration: ProrationResult };

/**
 * Turn a mid-period plan change into the one thing it produces.
 *
 * The proration is returned on every branch, because the figure the merchant
 * disputes is the proration and not the outcome, and a support conversation
 * that cannot see both sides of it has to be answered by reading code.
 */
export function composePlanChangeBilling(input: PlanChangeInput): PlanChangeBilling {
  if (typeof input?.businessId !== 'string' || input.businessId.trim().length === 0) {
    refuse('billing.payload_invalid', 'a plan change must name the business whose subscription changes');
  }
  if (typeof input.fromPlanKey !== 'string' || input.fromPlanKey.trim().length === 0) {
    refuse('billing.payload_invalid', 'a plan change must name the plan being left');
  }
  if (typeof input.toPlanKey !== 'string' || input.toPlanKey.trim().length === 0) {
    refuse('billing.payload_invalid', 'a plan change must name the plan being joined');
  }
  if (typeof input.adjustmentId !== 'string' || input.adjustmentId.trim().length === 0) {
    refuse('billing.payload_invalid', 'a plan change must carry the identity its credit would use');
  }
  if (typeof input.creditReason !== 'string' || input.creditReason.trim().length === 0) {
    refuse('billing.credit_reason_required', 'a plan change must state why a credit it may create exists');
  }

  if (!Array.isArray(input.ledger as unknown)) {
    refuse('billing.payload_invalid', 'a plan change must carry the credit ledger it could strand');
  }

  const proration = proratePlanChange(input);

  // DR-97, prevention at the origin. The proration's own refusals come first
  // on purpose: a change whose two prices disagree about currency is a payload
  // the caller got wrong, and it is refused before anything reads a balance.
  //
  // The ledger's currency is read from the LEDGER, never assumed to be the
  // plan's: that is the whole point. The fold is then asked for the balance in
  // the ledger's own currency, so every rule it owns -- one business, one
  // currency, append-only order, per-grant remainders -- still refuses by its
  // own name, and this law neither restates nor relaxes them.
  // TWO DEFECTS OF MY OWN, both found in review and both measured before this
  // was rewritten. The first read `input.ledger[0]?.currency` and ran the law
  // only `if (ledgerCurrency !== undefined)`: a ledger whose first row carried
  // no currency -- or whose first element was a hole -- made that `undefined`,
  // so the fold was never called and NOTHING was checked. Measured: a ledger
  // whose second row is an unspent ILS grant, changed to USD, was ACCEPTED and
  // granted a second credit in USD on top of the stranded one. A row whose
  // currency cannot be read is a defect that REFUSES; the unsafe direction was
  // the one the code took.
  //
  // The second handed the WHOLE ledger to a fold that refuses any mixture
  // (`credit.ts`), so a business whose ledger held a spent ILS history beside a
  // live USD balance was refused `billing.credit_currency_mismatch` -- a
  // PAYLOAD code -- for every plan change in either direction, for good. That
  // is the normal state after the administrative write-off this slice's own
  // card describes, and the older refusal was MASKING this law rather than the
  // other way round.
  //
  // So the balance is folded ONCE PER CURRENCY the ledger actually holds, over
  // that currency's own rows. Every rule the fold owns still refuses by its own
  // name on each slice -- one business, append-only order, per-grant remainders
  // -- and this law neither restates nor relaxes them; what it no longer does
  // is ask the fold a question about a ledger it was never scoped to answer.
  // The currencies are visited in order of first appearance, so the refusal is
  // deterministic and names the first currency that would be stranded.
  if (input.ledger.length > 0) {
    const currencies: string[] = [];
    for (const row of input.ledger) {
      const currency = row?.currency;
      if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
        refuse(
          'billing.payload_invalid',
          'a row of the credit ledger carries no readable currency, and a row whose currency cannot be read is not a row this law may pass over',
          {
            businessId: input.businessId,
          },
        );
      }
      if (!currencies.includes(currency)) currencies.push(currency);
    }
    // WHAT THE SLICE NARROWS, named here rather than left to be discovered,
    // because both reviews found it and neither found a money effect in it.
    // Three of the fold's invariants were measured over the WHOLE ledger and
    // are now measured per currency: the per-grant identity set (a duplicated
    // id in two different currencies is no longer
    // `billing.credit_adjustment_replayed`), the `occurredAt` monotonicity (now
    // monotonic within each currency rather than across all of them), and the
    // business scope, which is unchanged in effect because every slice still
    // carries it. The first is the one to watch: its real guard is the primary
    // key of the ledger table, which is NOT_RUN on this host, and a consumption
    // drawing on a grant outside its own slice still refuses
    // `billing.credit_grant_unknown` -- measured. If a caller ever needs
    // cross-currency replay detection, it belongs in the ledger's own authority
    // and not in this composer.
    for (const currency of currencies) {
      const held = foldCreditBalance(
        input.ledger.filter((row) => row.currency === currency),
        { businessId: input.businessId, currency },
      );
      if (held.balanceMinor > 0n && currency !== proration.currency) {
        refuse(
          'billing.subscription_currency_locked_by_credit',
          'this business holds unspent credit in another currency, and a plan change may not strand it',
          {
            businessId: input.businessId,
            currency,
          },
        );
      }
    }
  }

  if (proration.netMinor === 0n) {
    return { outcome: 'nothing', proration };
  }

  if (proration.netMinor < 0n) {
    // The ruling, as code: the whole of a negative net becomes a credit GRANT.
    // Not a refund, not a negative line, not a provider instruction.
    const amountMinor = -proration.netMinor;
    if (amountMinor <= 0n) {
      refuse('billing.invariant_violated', 'a credit produced by a downgrade must be positive', {
        invariant: 'downgrade_credit_positive',
        currency: proration.currency,
      });
    }
    const adjustment: CreditAdjustment = {
      id: input.adjustmentId,
      businessId: input.businessId,
      kind: 'grant',
      amountMinor,
      currency: proration.currency,
      occurredAt: input.changeAt,
      ref: input.toPlanKey,
      reason: input.creditReason,
    };
    return { outcome: 'credit', proration, adjustment };
  }

  // Net above zero. Both proration lines are shown, each positive, with its
  // kind carrying the direction — so the merchant can reconcile the total
  // against each plan's own price instead of against a single net figure.
  const lines: SubscriptionInvoiceLine[] = [];
  if (proration.chargeMinor > 0n) {
    lines.push({
      kind: 'proration_charge',
      ref: input.toPlanKey,
      amountMinor: proration.chargeMinor,
      currency: proration.currency,
    });
  }
  if (proration.creditMinor > 0n) {
    lines.push({
      kind: 'proration_credit',
      ref: input.fromPlanKey,
      amountMinor: proration.creditMinor,
      currency: proration.currency,
    });
  }
  const invoice = composeSubscriptionInvoice({ lines });
  // `composeSubscriptionInvoice` already refuses a negative total; this states
  // the stronger property this branch promises, which is that the invoice
  // total is the net it was selected by. A composer that dropped a line would
  // still produce a non-negative total and would fail here.
  if (invoice.totalMinor !== proration.netMinor) {
    refuse('billing.invariant_violated', 'the composed invoice total is not the prorated net', {
      invariant: 'plan_change_invoice_total_is_net',
      currency: proration.currency,
    });
  }
  return { outcome: 'invoice', proration, invoice };
}
