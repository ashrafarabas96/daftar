/**
 * The platform billing credit — `TL-P5-R3`.
 *
 * The owner's ruling, verbatim in substance: a negative proration creates A
 * PLATFORM BILLING CREDIT; it does NOT automatically trigger a cash or
 * provider refund; the credit is derived from immutable billing adjustments;
 * there is no manually writable balance authority; and if a cash refund is
 * ever authorized, that is a separate explicit payout command.
 *
 * Every sentence of that ruling is a property of this file.
 *
 * ── The balance is a FOLD, and the type has no field for one ────────────
 *
 * `foldCreditBalance` computes the balance from the adjustments and nothing
 * else. There is no setter, no `balanceMinor` input and no "adjust to" call,
 * because the surest way to keep a derived figure derived is to give the
 * types no way to express a stored one. It is the same discipline
 * `composeSubscriptionInvoice` applies to an invoice total, and the same one
 * `0022` applies to a published plan version.
 *
 * ── Why a consumption beyond the balance is REFUSED, not clamped ───────
 *
 * Clamping would silently spend credit that does not exist and leave a
 * balance of zero that looks correct. The refusal names the exact adjustment
 * that overdrew, because "the balance went negative" is not actionable and
 * "adjustment 4 of 7 overdrew it" is.
 *
 * ── Why there is no refund in this file, and no `payout` either ────────
 *
 * The ruling makes a cash refund a SEPARATE EXPLICIT COMMAND. A helper here
 * called `refund` — even one that only computed an amount — would be the
 * first half of that command living in the wrong place, and the second half
 * would arrive later as "we already have the amount". `test/credit.test.ts`
 * asserts this module's own source contains no such symbol, so the absence is
 * a law rather than a current fact.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────
 *
 * Applying a balance to an invoice. The ledger shape supports it —
 * `consumption` is a kind — but which invoice consumes which credit, and in
 * what order, is a commercial decision this prep has no ruling for. The fold
 * is ready for it; nothing here decides it.
 */
import { refuse } from './errors';
import { MAX_BILLING_MINOR } from './types';

export const CREDIT_ADJUSTMENT_KINDS = ['grant', 'consumption'] as const;
export type CreditAdjustmentKind = (typeof CREDIT_ADJUSTMENT_KINDS)[number];

export interface CreditAdjustment {
  /** The adjustment's own identity. An identifier; never interpreted here. */
  readonly id: string;
  readonly kind: CreditAdjustmentKind;
  /** Always POSITIVE. The kind carries the direction. */
  readonly amountMinor: bigint;
  readonly currency: string;
  /** ISO-8601 instant. Supplied by the command; never a machine clock. */
  readonly occurredAt: string;
  /** What produced it: a plan change, an invoice. An identifier. */
  readonly ref: string;
  /**
   * Mandatory. A credit nobody explained is a credit nobody can review, and a
   * balance that moved for no stated reason is the shape an unauthorized
   * write takes. The same rule `classifyRoundingResidual` applies to a
   * rounding adjustment.
   */
  readonly reason: string;
}

export interface CreditBalance {
  readonly currency: string;
  readonly grantedMinor: bigint;
  readonly consumedMinor: bigint;
  /** `granted − consumed`. Never negative: an overdraw is refused, not clamped. */
  readonly balanceMinor: bigint;
  readonly adjustmentCount: number;
}

/**
 * The balance implied by an append-only list of adjustments, oldest first.
 *
 * An out-of-order list is REFUSED rather than sorted. Sorting would hide a
 * caller that merged two businesses' ledgers or replayed an old adjustment,
 * and the running balance — which is what the overdraw check is about — is
 * only meaningful in the order the adjustments actually happened.
 */
export function foldCreditBalance(adjustments: readonly CreditAdjustment[], currency: string): CreditBalance {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    refuse('billing.payload_invalid', 'a credit balance is stated in one three-letter currency');
  }
  // Typed before it is validated: `Array.isArray` widens its argument to
  // `any[]` (see the note in `invoice.ts`).
  const list: readonly CreditAdjustment[] = adjustments ?? [];
  if (!Array.isArray(adjustments)) {
    refuse('billing.payload_invalid', 'the credit ledger must be a list of adjustments');
  }

  let granted = 0n;
  let consumed = 0n;
  let running = 0n;
  let previousMs = -Infinity;
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const n = i + 1;
    if (!a) refuse('billing.payload_invalid', 'a credit adjustment may not be absent', { attemptNo: n });
    if (!(CREDIT_ADJUSTMENT_KINDS as readonly string[]).includes(a.kind)) {
      refuse('billing.payload_invalid', 'a credit adjustment must carry a known kind', { attemptNo: n });
    }
    if (typeof a.id !== 'string' || a.id.trim().length === 0) {
      refuse('billing.payload_invalid', 'a credit adjustment must have an identity', { attemptNo: n });
    }
    if (seen.has(a.id)) {
      // A replayed adjustment is the one way an append-only ledger can still
      // produce a wrong balance, and it is indistinguishable from a second
      // genuine adjustment unless the ids are checked.
      refuse('billing.credit_adjustment_replayed', 'this credit adjustment is already in the ledger', { attemptNo: n });
    }
    seen.add(a.id);
    if (typeof a.ref !== 'string' || a.ref.trim().length === 0) {
      refuse('billing.payload_invalid', 'a credit adjustment must say what produced it', { attemptNo: n });
    }
    if (typeof a.reason !== 'string' || a.reason.trim().length === 0 || a.reason.trim().length > 500) {
      refuse('billing.credit_reason_required', 'a credit adjustment must state why it exists', { attemptNo: n });
    }
    if (a.currency !== currency) {
      refuse('billing.credit_currency_mismatch', 'a credit balance may not mix currencies', { attemptNo: n, currency });
    }
    if (typeof a.amountMinor !== 'bigint') {
      refuse('billing.payload_invalid', 'a credit amount must be an exact integer of minor units', { attemptNo: n });
    }
    if (a.amountMinor <= 0n) {
      refuse('billing.payload_invalid', 'a credit amount is positive; the kind carries the direction', { attemptNo: n });
    }
    if (a.amountMinor > MAX_BILLING_MINOR) {
      refuse('billing.payload_invalid', 'a credit amount exceeds the money cap', { attemptNo: n, currency });
    }
    const atMs = Date.parse(a.occurredAt);
    if (typeof a.occurredAt !== 'string' || !Number.isFinite(atMs)) {
      refuse('billing.as_of_required', 'a credit adjustment must carry a parseable instant', { attemptNo: n });
    }
    if (atMs < previousMs) {
      refuse('billing.credit_ledger_out_of_order', 'the credit ledger must be oldest first', { attemptNo: n, at: a.occurredAt });
    }
    previousMs = atMs;

    if (a.kind === 'grant') {
      granted += a.amountMinor;
      running += a.amountMinor;
    } else {
      consumed += a.amountMinor;
      running -= a.amountMinor;
      if (running < 0n) {
        refuse('billing.credit_overdrawn', 'this consumption spends credit the ledger does not hold', {
          attemptNo: n,
          currency,
        });
      }
    }
    if (running > MAX_BILLING_MINOR) {
      refuse('billing.payload_invalid', 'the credit balance exceeds the money cap', { attemptNo: n, currency });
    }
  }

  // The law of this module, asserted rather than trusted: the balance is the
  // difference of the two totals. An accumulator and its own result are not
  // two witnesses, so this is computed from the other two.
  if (running !== granted - consumed) {
    refuse('billing.invariant_violated', 'the folded balance is not granted minus consumed', {
      invariant: 'balance_is_granted_minus_consumed',
      currency,
    });
  }

  return { currency, grantedMinor: granted, consumedMinor: consumed, balanceMinor: running, adjustmentCount: list.length };
}
