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
import type { CreditAdjustment } from './credit';

export const PLAN_CHANGE_OUTCOMES = ['invoice', 'credit', 'nothing'] as const;
export type PlanChangeOutcome = (typeof PLAN_CHANGE_OUTCOMES)[number];

export interface PlanChangeInput extends ProrationInput {
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
  if (typeof input?.fromPlanKey !== 'string' || input.fromPlanKey.trim().length === 0) {
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

  const proration = proratePlanChange(input);

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
