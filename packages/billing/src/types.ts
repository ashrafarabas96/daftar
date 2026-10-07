/**
 * The vocabulary Phase 5 shares with the entitlement foundation Phase 1 built.
 *
 * ── The one law that shapes this file ────────────────────────────────────
 *
 * Phase 5 does NOT own subscription state. `business_entitlements.state` owns
 * it, its allowed values are a database CHECK, and `EntitlementService`
 * (`apps/api/src/modules/entitlements/entitlements.service.ts`) owns both the
 * effective-state derivation and the question of which states entitle. This
 * package therefore declares no state machine of its own: it RESTATES the
 * value set so a pure function can be typed against it, and
 * `test/subscription-states.test.ts` extracts the live CHECK out of the
 * migrations and fails unless the two sets are exactly equal, in both
 * directions. A tenth state added to the database reds this package; a value
 * invented here and not in the database reds it too.
 *
 * That is the difference between reusing a truth and copying one. The copy is
 * pinned to its source by an executed test, so it cannot drift silently —
 * which is the only form of restatement this project accepts.
 */

/** The stored subscription states, as `business_entitlements_state_check` allows them. */
export const SUBSCRIPTION_STATES = [
  'trial',
  'active',
  'grace_period',
  'past_due',
  'paused',
  'cancel_at_period_end',
  'cancelled',
  'expired',
  'complimentary',
] as const;

export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/**
 * The billing intervals this slice can advance a period by.
 *
 * Deliberately only two. A `week` or a `day` interval is not a smaller version
 * of the same thing — it changes what an anchor day means and what clamping
 * does, and a plan catalogue that offers one has to say so commercially
 * first. Adding a third value without its calendar law is how an off-by-one
 * month becomes a billing incident.
 */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/**
 * A half-open billing period: `[startsAt, endsAt)`.
 *
 * Half-open, and said out loud, because the alternative is a boundary instant
 * that belongs to two periods at once. The instant `endsAt` is the first
 * instant of the NEXT period, so a charge, a proration and a dunning decision
 * taken exactly at a boundary all land in the same period as each other.
 */
export interface BillingPeriod {
  /** ISO-8601 instant, UTC, inclusive. */
  readonly startsAt: string;
  /** ISO-8601 instant, UTC, exclusive. */
  readonly endsAt: string;
}

/** A billing period together with its distance from the anchor. */
export interface IndexedBillingPeriod extends BillingPeriod {
  /** 0 is the first period that starts at the anchor itself. */
  readonly index: number;
}

/**
 * The immutable origin of a subscription's billing calendar.
 *
 * Every period is derived from `(anchorAt, interval, index)` and never from
 * the previous period's end. That is what keeps `Jan 31 → Feb 28 → Mar 31`
 * from collapsing into `Jan 31 → Feb 28 → Mar 28`: the anchor day survives a
 * short month instead of being eaten by it.
 */
export interface BillingAnchor {
  /** ISO-8601 instant, UTC. The first period starts here. */
  readonly anchorAt: string;
  readonly interval: BillingInterval;
}

/** A price, in integer minor units of `currency`. Never a float, never a Number. */
export interface Price {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * The cap this slice applies to any single money value it is handed.
 *
 * It is the same cap the accounting authority applies (`MAX_MONEY_MINOR`),
 * restated rather than imported because `@daftar/accounting` is the posting
 * engine and this slice must not depend on it to do arithmetic about a
 * platform subscription. `test/money-cap.test.ts` pins the two together.
 */
export const MAX_BILLING_MINOR = 10n ** 18n;

/** The largest add-on quantity a single subscription line may carry. */
export const MAX_ADDON_QUANTITY = 1_000_000;
