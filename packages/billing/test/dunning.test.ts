import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideDunning, DUNNING_GRACE_STATE, DUNNING_SUSPENDED_STATE, type DunningAttempt, type DunningPolicy } from '../src/dunning';
import { BillingError } from '../src/errors';

function expectRefusal(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
}

/** Attempt 1 at the period end, then +24h, then +72h; grace closes at +120h. */
const POLICY: DunningPolicy = { retryOffsetHours: [0, 24, 72], graceHours: 120 };
const PERIOD_END = '2026-04-01T00:00:00.000Z';
const failedAt = (iso: string): DunningAttempt => ({ attemptedAt: iso, outcome: 'failed' });

describe('the suspension target state', () => {
  /**
   * The finding this module was shaped by. `past_due` is the obvious name for
   * a subscription whose collection failed, and it is the wrong state: the
   * live engine lists it among the states that ENTITLE, so a subscription
   * parked there keeps every feature. The test reads the live engine rather
   * than trusting the comment, so the day somebody edits that set, this reds.
   */
  const ENGINE = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'api', 'src', 'modules', 'entitlements', 'entitlements.service.ts'), 'utf8');

  function entitlingStates(): string[] {
    const match = /const ENTITLING_STATES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(ENGINE);
    expect(match, 'ENTITLING_STATES was not found in the live entitlement engine — this test would otherwise prove nothing').not.toBeNull();
    const body = match?.[1] ?? '';
    const states = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((s): s is string => s !== undefined);
    expect(states.length, 'the entitling-state extraction came back empty').toBeGreaterThan(0);
    return states;
  }

  it('is a state the live engine does NOT treat as entitling', () => {
    expect(entitlingStates()).not.toContain(DUNNING_SUSPENDED_STATE);
  });

  it('is not past_due, BECAUSE the live engine still treats past_due as entitling', () => {
    expect(entitlingStates()).toContain('past_due');
    expect(DUNNING_SUSPENDED_STATE).not.toBe('past_due');
    expect(DUNNING_SUSPENDED_STATE).toBe('paused');
  });

  it('uses a grace state the live engine DOES treat as entitling, so a merchant in grace keeps working', () => {
    expect(entitlingStates()).toContain(DUNNING_GRACE_STATE);
  });
});

describe('decideDunning — nothing to do', () => {
  it('does nothing in a state that is not mid-collection', () => {
    for (const storedState of ['trial', 'complimentary', 'cancelled', 'expired', 'paused', 'cancel_at_period_end'] as const) {
      const decision = decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts: [], asOf: '2026-05-01T00:00:00.000Z', storedState });
      expect(decision, `state ${storedState}`).toEqual({ action: 'none', attemptNo: 0, nextAttemptAt: null, targetState: null, exhausted: false });
    }
  });

  it('stops the moment an attempt succeeded, even after earlier failures', () => {
    // Continuing would charge twice. This is the only law here whose cost is
    // paid by the merchant rather than by the platform.
    const decision = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts: [failedAt('2026-04-01T00:00:00.000Z'), { attemptedAt: '2026-04-02T00:00:00.000Z', outcome: 'succeeded' }],
      asOf: '2026-04-10T00:00:00.000Z',
      storedState: 'grace_period',
    });
    expect(decision.action).toBe('none');
    expect(decision.targetState).toBeNull();
  });
});

describe('decideDunning — the schedule', () => {
  it('waits before the period end, and the first attempt is due at the period end itself', () => {
    const decision = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts: [],
      asOf: '2026-03-31T23:59:59.999Z',
      storedState: 'active',
    });
    expect(decision).toEqual({ action: 'wait', attemptNo: 1, nextAttemptAt: PERIOD_END, targetState: null, exhausted: false });
  });

  it('charges exactly at the period end — the boundary is due, not pending', () => {
    const decision = decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts: [], asOf: PERIOD_END, storedState: 'active' });
    expect(decision.action).toBe('charge');
    expect(decision.attemptNo).toBe(1);
    expect(decision.targetState).toBeNull();
  });

  it('schedules each retry at its own offset and counts the attempts', () => {
    const afterOne = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts: [failedAt(PERIOD_END)],
      asOf: '2026-04-01T06:00:00.000Z',
      storedState: 'grace_period',
    });
    expect(afterOne).toEqual({
      action: 'wait',
      attemptNo: 2,
      nextAttemptAt: '2026-04-02T00:00:00.000Z',
      targetState: 'grace_period',
      exhausted: false,
    });

    const afterTwo = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts: [failedAt(PERIOD_END), failedAt('2026-04-02T00:00:00.000Z')],
      asOf: '2026-04-04T00:00:00.000Z',
      storedState: 'grace_period',
    });
    expect(afterTwo.action).toBe('charge');
    expect(afterTwo.attemptNo).toBe(3);
    expect(afterTwo.nextAttemptAt).toBe('2026-04-04T00:00:00.000Z');
  });

  it('is exhausted once every scheduled attempt has failed, and schedules nothing more', () => {
    const decision = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts: [failedAt(PERIOD_END), failedAt('2026-04-02T00:00:00.000Z'), failedAt('2026-04-04T00:00:00.000Z')],
      asOf: '2026-04-04T01:00:00.000Z',
      storedState: 'grace_period',
    });
    expect(decision.exhausted).toBe(true);
    expect(decision.action).toBe('none');
    expect(decision.nextAttemptAt).toBeNull();
    // Still inside the grace window, so not suspended yet.
    expect(decision.targetState).toBe('grace_period');
  });

  it('ignores extra failures beyond the schedule rather than walking off the end of the offsets', () => {
    const decision = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts: [failedAt(PERIOD_END), failedAt('2026-04-02T00:00:00.000Z'), failedAt('2026-04-04T00:00:00.000Z'), failedAt('2026-04-05T00:00:00.000Z')],
      asOf: '2026-04-05T00:00:00.000Z',
      storedState: 'grace_period',
    });
    expect(decision.exhausted).toBe(true);
    expect(decision.nextAttemptAt).toBeNull();
  });
});

describe('decideDunning — the state the failures imply', () => {
  it('is no change while nothing has failed', () => {
    const decision = decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts: [], asOf: PERIOD_END, storedState: 'active' });
    expect(decision.targetState).toBeNull();
  });

  it('is grace from the first failure until the window closes, and the closing instant itself suspends', () => {
    const graceEnd = '2026-04-06T00:00:00.000Z'; // period end + 120h
    const attempts = [failedAt(PERIOD_END)];
    const inside = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts,
      asOf: '2026-04-05T23:59:59.999Z',
      storedState: 'grace_period',
    });
    expect(inside.targetState).toBe('grace_period');

    const atClose = decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts, asOf: graceEnd, storedState: 'grace_period' });
    expect(atClose.targetState).toBe('paused');

    const after = decideDunning({
      policy: POLICY,
      periodEndsAt: PERIOD_END,
      attempts,
      asOf: '2026-04-20T00:00:00.000Z',
      storedState: 'grace_period',
    });
    expect(after.targetState).toBe('paused');
  });

  it('suspends on the grace window even when retries remain scheduled, so a long schedule cannot outlive the grace it was given', () => {
    // The policy guard makes this unreachable by construction — graceHours is
    // never shorter than the last offset — so the case under test is the
    // boundary where they are EQUAL.
    const tight: DunningPolicy = { retryOffsetHours: [0, 48], graceHours: 48 };
    const decision = decideDunning({
      policy: tight,
      periodEndsAt: PERIOD_END,
      attempts: [failedAt(PERIOD_END)],
      asOf: '2026-04-03T00:00:00.000Z', // period end + 48h
      storedState: 'grace_period',
    });
    expect(decision.action).toBe('charge');
    expect(decision.attemptNo).toBe(2);
    expect(decision.targetState).toBe('paused');
  });
});

describe('decideDunning — refusals', () => {
  it('refuses a policy with no attempts, a non-increasing schedule, or a self-contradicting grace window', () => {
    expectRefusal(
      () =>
        decideDunning({ policy: { retryOffsetHours: [], graceHours: 24 }, periodEndsAt: PERIOD_END, attempts: [], asOf: PERIOD_END, storedState: 'active' }),
      'billing.dunning_policy_invalid',
    );
    expectRefusal(
      () =>
        decideDunning({
          policy: { retryOffsetHours: [0, 24, 24], graceHours: 48 },
          periodEndsAt: PERIOD_END,
          attempts: [],
          asOf: PERIOD_END,
          storedState: 'active',
        }),
      'billing.dunning_policy_invalid',
    );
    expectRefusal(
      () =>
        decideDunning({
          policy: { retryOffsetHours: [0, 72], graceHours: 24 },
          periodEndsAt: PERIOD_END,
          attempts: [],
          asOf: PERIOD_END,
          storedState: 'active',
        }),
      'billing.dunning_policy_invalid',
    );
    expectRefusal(
      () =>
        decideDunning({
          policy: { retryOffsetHours: [0, 1.5], graceHours: 24 },
          periodEndsAt: PERIOD_END,
          attempts: [],
          asOf: PERIOD_END,
          storedState: 'active',
        }),
      'billing.dunning_policy_invalid',
    );
  });

  it('refuses an out-of-order attempt history instead of sorting it', () => {
    // Sorting would hide a caller that is passing attempts from two periods,
    // and the count of failures is what the whole schedule is built on.
    expectRefusal(
      () =>
        decideDunning({
          policy: POLICY,
          periodEndsAt: PERIOD_END,
          attempts: [failedAt('2026-04-04T00:00:00.000Z'), failedAt('2026-04-02T00:00:00.000Z')],
          asOf: '2026-04-05T00:00:00.000Z',
          storedState: 'grace_period',
        }),
      'billing.dunning_attempt_out_of_order',
    );
  });

  it('refuses a stored state the database would not allow, and a malformed attempt', () => {
    expectRefusal(
      () =>
        decideDunning({
          policy: POLICY,
          periodEndsAt: PERIOD_END,
          attempts: [],
          asOf: PERIOD_END,
          storedState: 'suspended' as unknown as 'active',
        }),
      'billing.payload_invalid',
    );
    expectRefusal(
      () =>
        decideDunning({
          policy: POLICY,
          periodEndsAt: PERIOD_END,
          attempts: [{ attemptedAt: PERIOD_END, outcome: 'maybe' as unknown as 'failed' }],
          asOf: PERIOD_END,
          storedState: 'active',
        }),
      'billing.payload_invalid',
    );
  });

  it('refuses a missing or unparseable instant', () => {
    expectRefusal(() => decideDunning({ policy: POLICY, periodEndsAt: '', attempts: [], asOf: PERIOD_END, storedState: 'active' }), 'billing.as_of_required');
    expectRefusal(
      () => decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts: [], asOf: 'soon', storedState: 'active' }),
      'billing.as_of_required',
    );
  });
});
