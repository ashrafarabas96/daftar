/**
 * Dunning — when to attempt collection again, and what state a subscription
 * should be in while collection is failing.
 *
 * ── The finding that shaped this module ─────────────────────────────────
 *
 * The obvious terminal state for a subscription whose collection has failed
 * for good is `past_due`. It is the wrong one. The live entitlement engine
 * lists `past_due` among the states that ENTITLE
 * (`ENTITLING_STATES` in `apps/api/src/modules/entitlements/entitlements.service.ts`),
 * so a subscription parked there keeps every feature and every limit it had.
 * Dunning that ended in `past_due` would be dunning that never suspends
 * anything, and nobody would see it, because the subscription would look
 * suspended in the billing tables and behave as paid everywhere else.
 *
 * `paused` is the state that is NOT entitling, so suspension targets
 * `paused`. `test/dunning.test.ts` reads the live engine and fails unless
 * `past_due` is still entitling and `paused` is still not — so the day
 * somebody changes that set, this module reds instead of quietly suspending
 * nobody.
 *
 * ── No clock, no second state machine ──────────────────────────────────
 *
 * `asOf` is supplied, like everywhere else in this slice. And this module
 * decides nothing about state that `business_entitlements.state` does not
 * already model: it returns one of the nine values the database CHECK allows,
 * or `null` for "no change". The transition itself is written by whichever
 * command owns the subscription at promotion.
 *
 * ── What "effective" means here, and what it does not ──────────────────
 *
 * `effectiveStateOf` in the entitlement engine derives expiry and
 * cancellation from time bounds. This module derives the DUNNING state from
 * collection attempts. They answer different questions and neither supersedes
 * the other; a caller writes the stored state and the engine still derives
 * the effective one from it.
 */
import { refuse } from './errors';
import { SUBSCRIPTION_STATES, type SubscriptionState } from './types';

const HOUR_MS = 3_600_000;

/** The collection outcomes a recorded attempt can have. */
export const DUNNING_OUTCOMES = ['succeeded', 'failed'] as const;
export type DunningOutcome = (typeof DUNNING_OUTCOMES)[number];

export interface DunningAttempt {
  /** ISO-8601 instant the attempt was made. */
  readonly attemptedAt: string;
  readonly outcome: DunningOutcome;
}

/**
 * The retry schedule, as offsets in whole hours from the period end.
 *
 * Offsets rather than "every N hours" because a real dunning policy is not
 * uniform — the usual shape is immediately, then a day later, then three days
 * later — and expressing that as a list makes the policy readable as data
 * instead of arithmetic. The first offset is normally 0: the renewal charge
 * itself is attempt 1.
 */
export interface DunningPolicy {
  readonly retryOffsetHours: readonly number[];
  /**
   * How long after the period end the subscription stays in `grace_period`.
   * Must be at least the last retry offset: a grace window that closed before
   * the last scheduled retry would suspend a merchant the policy still
   * intended to retry, which is a policy that contradicts itself.
   */
  readonly graceHours: number;
}

/**
 * States in which a failing collection means anything.
 *
 * `trial` is absent: a trial is not being collected yet. `complimentary` is
 * absent: it is not being charged. `cancel_at_period_end`, `cancelled`,
 * `expired` and `paused` are absent: there is nothing left to collect, and
 * dunning a cancelled subscription is how a merchant gets charged after
 * leaving. `active`, `grace_period` and `past_due` are the three that are
 * mid-collection.
 */
const DUNNABLE_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(['active', 'grace_period', 'past_due']);

/**
 * The state a suspended subscription goes to.
 *
 * Deliberately a named constant with the reasoning above it, so a reader who
 * reaches for `past_due` has to pass this comment first.
 */
export const DUNNING_SUSPENDED_STATE: SubscriptionState = 'paused';

/** The state a subscription is in while retries are still scheduled. */
export const DUNNING_GRACE_STATE: SubscriptionState = 'grace_period';

export type DunningAction = 'none' | 'wait' | 'charge';

export interface DunningDecision {
  readonly action: DunningAction;
  /** The ordinal of the attempt `action: 'charge'` refers to, 1-based; 0 when none. */
  readonly attemptNo: number;
  /** When the next scheduled attempt is due. `null` when there is none left. */
  readonly nextAttemptAt: string | null;
  /** The stored state the subscription should carry, or `null` for no change. */
  readonly targetState: SubscriptionState | null;
  /** True once every scheduled retry has been made and has failed. */
  readonly exhausted: boolean;
}

export interface DunningInput {
  readonly policy: DunningPolicy;
  /** The period end the renewal charge is due at. ISO-8601. */
  readonly periodEndsAt: string;
  /** Every recorded attempt for THIS period, oldest first. */
  readonly attempts: readonly DunningAttempt[];
  /** The instant the decision is about. Supplied; never a machine clock. */
  readonly asOf: string;
  /** The stored state, as `business_entitlements.state` holds it. */
  readonly storedState: SubscriptionState;
}

function instantMs(value: unknown, what: string): number {
  if (typeof value !== 'string' || value.trim().length === 0) refuse('billing.as_of_required', `${what} must be an ISO-8601 instant`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) refuse('billing.as_of_required', `${what} is not a parseable ISO-8601 instant`, { at: value });
  return ms;
}

function assertPolicy(policy: DunningPolicy | undefined): DunningPolicy {
  // Typed before it is validated: see the note in `invoice.ts` — the
  // `Array.isArray` narrowing widens its argument to `any[]`.
  const offsets: readonly number[] = policy?.retryOffsetHours ?? [];
  if (!policy || !Array.isArray(policy.retryOffsetHours) || offsets.length === 0) {
    refuse('billing.dunning_policy_invalid', 'a dunning policy must schedule at least one attempt');
  }
  let previous = -1;
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      refuse('billing.dunning_policy_invalid', 'every retry offset must be a non-negative whole number of hours', { attemptNo: i + 1 });
    }
    if (offset <= previous) {
      refuse('billing.dunning_policy_invalid', 'retry offsets must strictly increase, or two attempts fall due together', { attemptNo: i + 1 });
    }
    previous = offset;
  }
  if (!Number.isInteger(policy.graceHours) || policy.graceHours < 0) {
    refuse('billing.dunning_policy_invalid', 'the grace window must be a non-negative whole number of hours');
  }
  if (policy.graceHours < previous) {
    refuse('billing.dunning_policy_invalid', 'a grace window shorter than the last retry would suspend a merchant the policy still means to retry');
  }
  return policy;
}

/**
 * Decide the next dunning step.
 *
 * A succeeded attempt ends dunning for the period, whatever came before it:
 * money arrived, and continuing to retry would charge twice.
 */
export function decideDunning(input: DunningInput): DunningDecision {
  const policy = assertPolicy(input?.policy);
  if (!(SUBSCRIPTION_STATES as readonly string[]).includes(input?.storedState)) {
    refuse('billing.payload_invalid', 'the stored subscription state must be one the database allows');
  }
  const periodEndMs = instantMs(input.periodEndsAt, 'the period end');
  const asOfMs = instantMs(input.asOf, 'the as-of instant');
  // Typed before it is validated: see the note in `invoice.ts` — the
  // `Array.isArray` narrowing widens its argument to `any[]`.
  const attempts: readonly DunningAttempt[] = input.attempts ?? [];
  if (!Array.isArray(input.attempts) && input.attempts !== undefined) {
    refuse('billing.payload_invalid', 'the attempt history must be a list');
  }

  let previousMs = -Infinity;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (!attempt || !(DUNNING_OUTCOMES as readonly string[]).includes(attempt.outcome)) {
      refuse('billing.payload_invalid', 'every recorded attempt must carry a known outcome', { attemptNo: i + 1 });
    }
    const ms = instantMs(attempt.attemptedAt, 'an attempt instant');
    if (ms < previousMs) {
      refuse('billing.dunning_attempt_out_of_order', 'the attempt history must be oldest first', { attemptNo: i + 1 });
    }
    previousMs = ms;
  }

  const idle: DunningDecision = { action: 'none', attemptNo: 0, nextAttemptAt: null, targetState: null, exhausted: false };

  if (!DUNNABLE_STATES.has(input.storedState)) return idle;
  if (attempts.some((a) => a.outcome === 'succeeded')) return idle;

  const failures = attempts.filter((a) => a.outcome === 'failed').length;
  const graceEndMs = periodEndMs + policy.graceHours * HOUR_MS;

  /**
   * The state the failures alone imply at `asOf`. Separate from the action on
   * purpose: whether a charge is due right now and what state the merchant is
   * in are two different facts, and a function that returned only the action
   * would leave the caller to re-derive the state from the same inputs — a
   * second implementation of this rule, in the caller.
   */
  const targetState: SubscriptionState | null = failures === 0 ? null : asOfMs >= graceEndMs ? DUNNING_SUSPENDED_STATE : DUNNING_GRACE_STATE;

  const exhausted = failures >= policy.retryOffsetHours.length;
  if (exhausted) {
    return { action: 'none', attemptNo: 0, nextAttemptAt: null, targetState, exhausted: true };
  }

  const nextOffset = policy.retryOffsetHours[failures];
  if (nextOffset === undefined) {
    refuse('billing.invariant_violated', 'a retry offset was missing although the schedule is not exhausted', {
      invariant: 'retry_offset_present',
      attemptNo: failures + 1,
    });
  }
  const dueMs = periodEndMs + nextOffset * HOUR_MS;
  const nextAttemptAt = new Date(dueMs).toISOString();
  return {
    action: asOfMs >= dueMs ? 'charge' : 'wait',
    attemptNo: failures + 1,
    nextAttemptAt,
    targetState,
    exhausted: false,
  };
}
