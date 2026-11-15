/**
 * Billing-period arithmetic — the calendar, and nothing else.
 *
 * ── Why every period is derived from the anchor, never from its predecessor ─
 *
 * A subscription anchored on 31 January must bill on 28 February and then on
 * 31 March. Chaining (`next = end of previous + 1 month`) cannot do that: the
 * February clamp destroys the anchor day, so March inherits 28 and the
 * subscription silently migrates to the 28th forever. Deriving period `i`
 * from `(anchorAt, interval, i)` keeps the anchor day as the only source of
 * the day-of-month, and the clamp becomes a property of the short month it
 * happens in rather than a permanent injury.
 *
 * ── Why `asOf` is always supplied ────────────────────────────────────────
 *
 * Nothing in this file reads a machine clock. A dunning decision, a proration
 * and an invoice are all answers about a particular instant, and a function
 * that fetched `new Date()` itself could not be tested at a boundary, could
 * not be replayed, and would answer differently on two hosts. The caller
 * states the instant; this module does the calendar. (It is the same law P4-S7
 * arrived at for installment aging.)
 *
 * ── Why UTC only ────────────────────────────────────────────────────────
 *
 * A billing boundary in a local zone is two boundaries twice a year. Platform
 * subscription periods are therefore UTC instants; presenting them in a
 * merchant's zone is a formatting concern and belongs to the UI.
 */
import { refuse } from './errors';
import { BILLING_INTERVALS, type BillingAnchor, type BillingInterval, type BillingPeriod, type IndexedBillingPeriod } from './types';

/** The maximum number of periods this module will walk from an anchor. */
const MAX_PERIOD_INDEX = 100_000;

/** Parse an ISO-8601 instant into exact epoch milliseconds, or refuse. */
function instantMs(value: unknown, what: string, code: 'billing.anchor_invalid' | 'billing.as_of_required' | 'billing.period_range_invalid'): number {
  if (typeof value !== 'string' || value.trim().length === 0) refuse(code, `${what} must be an ISO-8601 instant`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) refuse(code, `${what} is not a parseable ISO-8601 instant`, { at: value });
  return ms;
}

function assertInterval(interval: unknown): BillingInterval {
  if (typeof interval !== 'string' || !(BILLING_INTERVALS as readonly string[]).includes(interval)) {
    refuse('billing.interval_unsupported', 'the billing interval must be one this slice has a calendar law for');
  }
  return interval as BillingInterval;
}

/** Days in a Gregorian month, 1-based month. Pure; no Date involved. */
export function daysInMonth(year: number, month1: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month1) || month1 < 1 || month1 > 12) {
    refuse('billing.payload_invalid', 'a month length needs an integer year and a month in 1..12');
  }
  if (month1 === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month1 === 4 || month1 === 6 || month1 === 9 || month1 === 11 ? 30 : 31;
}

/**
 * Add `count` whole months to an instant, clamping the day of month to the
 * target month's length.
 *
 * Clamping is a REDUCTION only: 31 January + 1 month is 28 February, never
 * 3 March. Rolling forward past the end of the month is the other plausible
 * convention and it is the wrong one here, because it would move a
 * subscription into a month it was not anchored in and make two consecutive
 * periods overlap for the merchant who reads them.
 *
 * The time of day, including milliseconds, is preserved exactly.
 */
export function addMonthsUtc(epochMs: number, count: number): number {
  if (!Number.isFinite(epochMs)) refuse('billing.payload_invalid', 'a month addition needs a finite instant');
  if (!Number.isInteger(count)) refuse('billing.payload_invalid', 'a month addition needs an integer month count');
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const day = d.getUTCDate();
  const total = m0 + count;
  // `Math.floor` so a negative month count borrows a year correctly; `%` in
  // JavaScript keeps the sign of the dividend, which would give month -1.
  const targetYear = y + Math.floor(total / 12);
  const targetMonth0 = ((total % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth0 + 1));
  return Date.UTC(targetYear, targetMonth0, clampedDay, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** How many whole months one period of `interval` spans. */
export function monthsPerInterval(interval: BillingInterval): number {
  return interval === 'year' ? 12 : 1;
}

/**
 * The period at distance `index` from the anchor. `index === 0` is the period
 * that starts at the anchor itself.
 */
export function billingPeriodByIndex(anchor: BillingAnchor, index: number): IndexedBillingPeriod {
  const anchorMs = instantMs(anchor?.anchorAt, 'the billing anchor', 'billing.anchor_invalid');
  const interval = assertInterval(anchor?.interval);
  if (!Number.isInteger(index) || index < 0 || index > MAX_PERIOD_INDEX) {
    refuse('billing.period_index_invalid', 'a period index must be a non-negative integer within the walk bound', { periodIndex: index });
  }
  const months = monthsPerInterval(interval);
  const startMs = addMonthsUtc(anchorMs, months * index);
  const endMs = addMonthsUtc(anchorMs, months * (index + 1));
  if (!(endMs > startMs)) {
    // Unreachable for the two supported intervals; stated anyway, because an
    // empty or inverted period is the one shape every caller downstream
    // divides by. A law nobody can reach today is still the law that holds
    // when a third interval arrives.
    refuse('billing.invariant_violated', 'a billing period must be non-empty', { invariant: 'period_non_empty', periodIndex: index });
  }
  return { index, startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString() };
}

/**
 * The period that contains `asOf`.
 *
 * `asOf` before the anchor is REFUSED rather than answered with period 0: a
 * subscription has no billing period before it started, and returning the
 * first one would let a caller prorate a charge against time the merchant was
 * never subscribed for.
 *
 * The search is a direct computation followed by a bounded correction, not a
 * loop from zero: a month's length varies, so an estimate from the elapsed
 * months can be off by one at a clamped boundary, and exactly one step fixes
 * it. The correction is asserted, not assumed.
 */
export function billingPeriodAt(anchor: BillingAnchor, asOf: string): IndexedBillingPeriod {
  const anchorMs = instantMs(anchor?.anchorAt, 'the billing anchor', 'billing.anchor_invalid');
  const interval = assertInterval(anchor?.interval);
  const asOfMs = instantMs(asOf, 'the as-of instant', 'billing.as_of_required');
  if (asOfMs < anchorMs) {
    refuse('billing.as_of_before_anchor', 'a subscription has no billing period before its anchor', { at: asOf });
  }

  const a = new Date(anchorMs);
  const t = new Date(asOfMs);
  const elapsedMonths = (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth());
  const months = monthsPerInterval(interval);
  // Floor toward zero, then correct. `elapsedMonths` can never be negative
  // here because `asOfMs >= anchorMs`, so integer division is the floor.
  let index = Math.floor(elapsedMonths / months);
  if (index < 0) index = 0;
  if (index > MAX_PERIOD_INDEX) {
    refuse('billing.period_index_invalid', 'the as-of instant is beyond the period walk bound', { at: asOf, periodIndex: index });
  }

  for (let step = 0; step <= 2; step++) {
    const candidate = billingPeriodByIndex(anchor, index);
    const startMs = Date.parse(candidate.startsAt);
    const endMs = Date.parse(candidate.endsAt);
    if (asOfMs < startMs) {
      if (index === 0) {
        refuse('billing.invariant_violated', 'the as-of instant fell before period 0 although it is at or after the anchor', {
          invariant: 'period_zero_contains_anchor',
          at: asOf,
        });
      }
      index -= 1;
      continue;
    }
    if (asOfMs >= endMs) {
      index += 1;
      if (index > MAX_PERIOD_INDEX) {
        refuse('billing.period_index_invalid', 'the as-of instant is beyond the period walk bound', { at: asOf, periodIndex: index });
      }
      continue;
    }
    return candidate;
  }
  // Three candidates is more than the clamp can ever need. Reaching here means
  // the calendar disagrees with itself, and the one thing a billing engine may
  // not do with that is pick a period anyway.
  refuse('billing.invariant_violated', 'the containing period did not converge', { invariant: 'period_search_converges', at: asOf });
}

/** Exact length of a period in milliseconds. Always positive. */
export function periodLengthMs(period: BillingPeriod): number {
  const startMs = instantMs(period?.startsAt, 'the period start', 'billing.period_range_invalid');
  const endMs = instantMs(period?.endsAt, 'the period end', 'billing.period_range_invalid');
  if (!(endMs > startMs)) refuse('billing.period_range_invalid', 'a billing period must end after it starts');
  return endMs - startMs;
}

/** Whether `asOf` lies in the half-open period `[startsAt, endsAt)`. */
export function periodContains(period: BillingPeriod, asOf: string): boolean {
  const startMs = instantMs(period?.startsAt, 'the period start', 'billing.period_range_invalid');
  const endMs = instantMs(period?.endsAt, 'the period end', 'billing.period_range_invalid');
  if (!(endMs > startMs)) refuse('billing.period_range_invalid', 'a billing period must end after it starts');
  const atMs = instantMs(asOf, 'the as-of instant', 'billing.as_of_required');
  return atMs >= startMs && atMs < endMs;
}
