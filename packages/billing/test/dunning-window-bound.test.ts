/**
 * B2 — A DUNNING WINDOW WITHOUT AN UPPER BOUND LEFT THE UNIT'S OWN CHANNEL.
 *
 * `assertDunningPolicy` required every retry offset and the grace window to be
 * a non-negative whole number of hours, strictly increasing, with NO upper
 * bound. `decideDunning` then formats the next attempt's instant:
 *
 *     new Date(periodEndMs + nextOffset * HOUR_MS).toISOString()
 *
 * Measured against the built package before this law, with one failed attempt
 * and a second offset still scheduled, so the instant has to be formatted:
 *
 *     second offset = 48            -> nextAttemptAt 2026-02-02T00:00:00.000Z
 *     second offset = 1e13          -> RangeError: Invalid time value, code (none)
 *     second offset = 2**53 - 1     -> RangeError: Invalid time value, code (none)
 *
 * A `RangeError` with no `code` is not this unit's refusal: it carries no
 * `billing.*` code, nothing for `toSafeJSON` to publish, and a caller that
 * handles `BillingError` does not handle it. And in a neighbouring branch the
 * same policy does not throw at all — it returns `grace_period` with
 * `exhausted: true`, which is a policy with no meaning accepted in silence.
 *
 * The bound is DERIVED, not invented: a dunning window may not outlast the
 * longest billing cycle the plans support. `BILLING_INTERVALS` is
 * `['month', 'year']`, so that is twelve months, over-approximated at 31 days
 * each so the bound does not depend on which year it falls in.
 */
import { describe, expect, it } from 'vitest';
import { decideDunning, MAX_DUNNING_WINDOW_HOURS, type DunningInput } from '../src/dunning';
import { BILLING_INTERVALS } from '../src/types';
import { monthsPerInterval } from '../src/period';
import { BillingError } from '../src/errors';

const BASE = {
  periodEndsAt: '2026-01-31T00:00:00.000Z',
  asOf: '2026-02-01T00:00:00.000Z',
  storedState: 'active',
  attempts: [{ attemptedAt: '2026-01-31T01:00:00.000Z', outcome: 'failed' }],
} as const;

function decide(retryOffsetHours: readonly number[], graceHours: number) {
  return decideDunning({ ...BASE, policy: { retryOffsetHours, graceHours } } as DunningInput);
}

function expectRefusal(fn: () => unknown, code: string): BillingError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
  return caught as BillingError;
}

describe('B2 — the dunning window has a declared upper bound', () => {
  it('states the bound as the longest supported billing cycle, derived and not a literal', () => {
    // The vocabulary this bound is read from, asserted so that adding a longer
    // interval to BILLING_INTERVALS without revisiting the bound is a failure
    // here rather than a silently shorter window.
    expect([...BILLING_INTERVALS]).toStrictEqual(['month', 'year']);
    const longestMonths = Math.max(...BILLING_INTERVALS.map((i) => monthsPerInterval(i)));
    expect(longestMonths).toBe(12);
    expect(MAX_DUNNING_WINDOW_HOURS).toBe(longestMonths * 31 * 24);
  });

  it('REFUSES the two measured values by name, instead of throwing a RangeError', () => {
    for (const h of [1e13, Number.MAX_SAFE_INTEGER]) {
      // A second offset, so the branch that FORMATS the instant is the one
      // reached — that is where the RangeError came from.
      const e = expectRefusal(() => decide([0, h], h), 'billing.dunning_policy_invalid');
      expect(e).toBeInstanceOf(BillingError);
      expect(typeof e.toSafeJSON()).toBe('object');
    }
  });

  it('REFUSES a grace window past the bound even when every offset is small', () => {
    expectRefusal(() => decide([0, 24], MAX_DUNNING_WINDOW_HOURS + 1), 'billing.dunning_policy_invalid');
  });

  it('REFUSES an offset past the bound even when the grace window is inside it, and the three rules keep their order', () => {
    // CORRECTED. This case used to pass `MAX + 1` for `graceHours` as well,
    // so it did NOT isolate the per-offset bound: the grace bound would have
    // caught the same input. The grace window here is 25 hours — inside the
    // bound and below the offending offset — so the only rule that can refuse
    // it first is the per-value offset bound.
    const offset = expectRefusal(() => decide([0, MAX_DUNNING_WINDOW_HOURS + 1], 25), 'billing.dunning_policy_invalid');
    expect(offset.message).toContain('a retry offset may not outlast');

    // The two rules that run AFTER it, each on an input of its own, asserted
    // by MESSAGE and not only by code: these three messages are how the order
    // is pinned. MEASURED, after a narrow review of 2026-11-11 read the
    // earlier sentence here and found it wrong: moving the grace checks in
    // front of the loop does NOT change the first expectation (with grace 25
    // and no retry seen yet, neither grace rule fires, so the offset bound
    // still refuses and still carries its own message). What reds is the
    // THIRD expectation below — `decide([0, 72], 24)` stops being refused,
    // because "a grace window shorter than the last retry" has no last retry
    // to compare against before the loop has run.
    const graceBound = expectRefusal(() => decide([0, 24], MAX_DUNNING_WINDOW_HOURS + 1), 'billing.dunning_policy_invalid');
    expect(graceBound.message).toContain('a grace window may not outlast');
    const graceShorter = expectRefusal(() => decide([0, 72], 24), 'billing.dunning_policy_invalid');
    expect(graceShorter.message).toContain('a grace window shorter than the last retry');
  });

  it('POSITIVE CONTROL: the bound itself is accepted and still formats an instant', () => {
    const r = decide([0, MAX_DUNNING_WINDOW_HOURS], MAX_DUNNING_WINDOW_HOURS);
    expect(r.nextAttemptAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(r.nextAttemptAt as string))).toBe(true);
  });

  it('POSITIVE CONTROL: a real policy is untouched by the bound', () => {
    // The shape every other suite in this package uses. If the bound were set
    // anywhere near a usable window, this case would red.
    const r = decide([0, 24, 72], 120);
    expect(r.nextAttemptAt).toBe('2026-02-01T00:00:00.000Z');
    expect(r.action).toBe('charge');
  });

  it('NEGATIVE CONTROL: the older policy rules still refuse, so the bound added a check and removed none', () => {
    expectRefusal(() => decide([0, 24, 24], 48), 'billing.dunning_policy_invalid'); // not strictly increasing
    expectRefusal(() => decide([0, 1.5], 24), 'billing.dunning_policy_invalid'); // not a whole number
    expectRefusal(() => decide([-1], 24), 'billing.dunning_policy_invalid'); // negative
    expectRefusal(() => decide([0, 72], 24), 'billing.dunning_policy_invalid'); // grace shorter than the last retry
  });
});
