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
 * ── Applying a balance to an invoice: RULED ON, and it lives next door ──
 *
 * Round 2 left this absent because no ruling existed. `TL-P5-R5` (PART 25)
 * now supplies one — apply automatically at invoice finalization, oldest
 * grant first — and it is implemented in `credit-application.ts`, which is a
 * separate module because allocation is a different question from solvency
 * and because this module must stay readable as the balance authority alone.
 *
 * ── What `TL-P5-R5` forced to change in THIS file ───────────────────────
 *
 * Two things, and both closed a hole rather than adding a feature.
 *
 * `same platform customer/business only` and `no transfer between
 * businesses`: the ledger now carries `businessId` and the fold is scoped to
 * one. Before the ruling, the comment on `foldCreditBalance` claimed that
 * refusing an out-of-order ledger would catch "a caller that merged two
 * businesses' ledgers" — **and it would not have.** There was no business
 * identifier anywhere in the type, so two ledgers interleaved in correct time
 * order folded to one balance without complaint. That is the project's own
 * recurring defect — a comment citing a check that does not exist — written
 * by this module's author, in this module.
 *
 * `allocation order, oldest eligible grant first`: an allocation that can be
 * audited has to say which grant funded which invoice, so a `consumption`
 * now names the grant it draws down (`appliesToGrantId`) and the fold reports
 * a REMAINDER PER GRANT. Without that, FIFO allocation is unverifiable: the
 * totals alone cannot tell a correct allocation from one that drained the
 * newest grant first.
 */
import { refuse } from './errors';
import { MAX_BILLING_MINOR } from './types';

export const CREDIT_ADJUSTMENT_KINDS = ['grant', 'consumption'] as const;
export type CreditAdjustmentKind = (typeof CREDIT_ADJUSTMENT_KINDS)[number];

export interface CreditAdjustment {
  /** The adjustment's own identity. An identifier; never interpreted here. */
  readonly id: string;
  /**
   * Whose credit it is. `TL-P5-R5`: one business only, and no transfer
   * between businesses — a rule the fold can only keep if the rows say whose
   * they are.
   */
  readonly businessId: string;
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
  /**
   * Which grant this consumption draws down. REQUIRED on a `consumption` and
   * FORBIDDEN on a `grant`, and it must name a grant that appears earlier in
   * the same ledger.
   *
   * It exists so FIFO allocation is auditable. `TL-P5-R5` fixes the order —
   * oldest grant first — and the totals alone cannot distinguish a correct
   * allocation from one that drained the newest grant first, because with no
   * expiry and no write-off every grant is otherwise fungible.
   */
  readonly appliesToGrantId?: string;
}

/**
 * What a balance is scoped to. A record rather than two parameters, so
 * `foldCreditBalance` keeps the arity its own test pins — and so that no
 * caller can ever pass a balance in, which is `TL-P5-R3`'s "no manually
 * writable balance authority" expressed in the signature.
 */
export interface CreditLedgerScope {
  readonly businessId: string;
  readonly currency: string;
}

/** One grant and how much of it is still unspent. */
export interface GrantRemainder {
  readonly grantId: string;
  readonly occurredAt: string;
  readonly grantedMinor: bigint;
  readonly remainingMinor: bigint;
}

export interface CreditBalance {
  readonly businessId: string;
  readonly currency: string;
  readonly grantedMinor: bigint;
  readonly consumedMinor: bigint;
  /** `granted − consumed`. Never negative: an overdraw is refused, not clamped. */
  readonly balanceMinor: bigint;
  readonly adjustmentCount: number;
  /**
   * Every grant in ledger order with its unspent remainder, zero remainders
   * included. The allocator reads this; it is reported in full rather than
   * filtered so that "this grant is exhausted" is a visible fact and not an
   * absence a caller has to infer.
   */
  readonly grants: readonly GrantRemainder[];
}

/**
 * The balance implied by an append-only list of adjustments, oldest first.
 *
 * An out-of-order list is REFUSED rather than sorted. Sorting would hide a
 * caller that merged two businesses' ledgers or replayed an old adjustment,
 * and the running balance — which is what the overdraw check is about — is
 * only meaningful in the order the adjustments actually happened.
 */
export function foldCreditBalance(adjustments: readonly CreditAdjustment[], scope: CreditLedgerScope): CreditBalance {
  const currency = scope?.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    refuse('billing.payload_invalid', 'a credit balance is stated in one three-letter currency');
  }
  if (typeof scope.businessId !== 'string' || scope.businessId.trim().length === 0) {
    refuse('billing.payload_invalid', 'a credit balance belongs to exactly one business, which must be named');
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
  /** Grant id → its index in `remainders`, so a draw-down is O(1) to place. */
  const grantIndex = new Map<string, number>();
  const remainders: Array<{ grantId: string; occurredAt: string; grantedMinor: bigint; remainingMinor: bigint }> = [];

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
    if (a.businessId !== scope.businessId) {
      // `TL-P5-R5`: no transfer between businesses. Two ledgers interleaved in
      // correct time order are the shape this catches, and nothing else does:
      // the instants are monotone, the ids are distinct, and the balance comes
      // out plausible.
      refuse('billing.credit_business_mismatch', "a credit ledger may not mix two businesses' adjustments", { attemptNo: n });
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
      if (a.appliesToGrantId !== undefined) {
        refuse('billing.payload_invalid', 'a grant does not draw down another grant', { attemptNo: n });
      }
      granted += a.amountMinor;
      running += a.amountMinor;
      grantIndex.set(a.id, remainders.length);
      remainders.push({ grantId: a.id, occurredAt: a.occurredAt, grantedMinor: a.amountMinor, remainingMinor: a.amountMinor });
    } else {
      if (typeof a.appliesToGrantId !== 'string' || a.appliesToGrantId.trim().length === 0) {
        refuse('billing.payload_invalid', 'a consumption must name the grant it draws down', { attemptNo: n });
      }
      const at = grantIndex.get(a.appliesToGrantId);
      if (at === undefined) {
        // Forward references and unknown grants are the same refusal on
        // purpose: an append-only ledger in which a consumption can precede
        // its grant has no order worth folding.
        refuse('billing.credit_grant_unknown', 'this consumption draws down a grant that is not earlier in this ledger', { attemptNo: n });
      }
      const target = remainders[at];
      if (!target) {
        refuse('billing.invariant_violated', 'a grant index pointed outside the grant list', { invariant: 'grant_index_within_bounds', currency });
      }
      if (a.amountMinor > target.remainingMinor) {
        // Per-grant overdraw. It is distinct from the balance-level overdraw
        // below and strictly stronger: a ledger can hold enough credit in
        // total while one grant is drawn past its own amount, and only the
        // per-grant check sees that.
        refuse('billing.credit_grant_overdrawn', 'this consumption draws more than the named grant still holds', { attemptNo: n, currency });
      }
      target.remainingMinor -= a.amountMinor;
      consumed += a.amountMinor;
      running -= a.amountMinor;
      if (running < 0n) {
        // UNREACHABLE BY CONSTRUCTION, and kept deliberately as a second
        // witness rather than deleted.
        //
        // Every consumption is bounded by its own grant's remainder above, so
        // the consumptions can never sum past the grants, so `running` can
        // never go below zero. It is therefore an INVARIANT of this module
        // and not a business outcome, and it is refused as one — the earlier
        // draft raised `billing.credit_overdrawn` here, which made that code
        // a refusal with no reachable raise site the moment per-grant
        // attribution arrived. A code that cannot be raised is a dead
        // constant authority, so it was removed from the union, and
        // `test/error-codes-are-live.test.ts` now reds on the next one.
        refuse('billing.invariant_violated', 'the running credit balance went below zero', {
          invariant: 'balance_never_negative',
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

  // A second, independent witness for the per-grant split: the remainders
  // must sum to the balance. The loop above maintained them separately from
  // `running`, so this compares two accumulations rather than one with
  // itself — the same discipline as the line above.
  let remainderSum = 0n;
  for (const r of remainders) {
    if (r.remainingMinor < 0n) {
      refuse('billing.invariant_violated', 'a grant remainder went negative', { invariant: 'grant_remainder_non_negative', currency });
    }
    remainderSum += r.remainingMinor;
  }
  // Unreachable given the per-grant bound, and kept and labelled for the same
  // reason as `balance_never_negative` above: the per-grant remainders and
  // `running` are maintained separately, so a future change that broke one
  // without the other would arrive here. Removing it alone is undetectable by
  // any test — the honest consequence of a guard that cannot fire.
  if (remainderSum !== running) {
    refuse('billing.invariant_violated', 'the grant remainders do not sum to the balance', {
      invariant: 'remainders_sum_to_balance',
      currency,
    });
  }

  return {
    businessId: scope.businessId,
    currency,
    grantedMinor: granted,
    consumedMinor: consumed,
    balanceMinor: running,
    adjustmentCount: list.length,
    grants: remainders.map((r) => ({ ...r })),
  };
}
