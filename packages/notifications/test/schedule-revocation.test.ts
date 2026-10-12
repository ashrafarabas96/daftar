/**
 * HIGH-VELOCITY V1 PART 7.5 — the two Phase 8 items that had no surface at all:
 * **scheduled messaging policies** and **revocation behavior**.
 *
 * Five catalog kinds declare a schedule trigger and, until this round, nothing
 * could fire them: `planFromOutboxRow` was the only entry point, so those five
 * were declared, registry-tested and unreachable. And a consent withdrawal was
 * answered only for a send that had not happened yet — a worker holding a
 * queued, in-flight, retry-scheduled or ambiguous delivery had no rule.
 */
import { describe, expect, it } from 'vitest';
import { planFromScheduleFiring, type ScheduleConfiguration, type ScheduleFiring, type ScheduleReader } from '../src/schedule';
import { scheduledKindsFor, catalogEntry } from '../src/catalog';
import { NotificationRefusal } from '../src/errors';
import { obligationKey } from '../src/identity';
import { onRevocation, revocationAuthorisesASend, verdictsThatPermitASend } from '../src/revocation';
import { ALL_DELIVERY_STATES, isOpenWork } from '../src/delivery';

const STATEMENT = 'p8.statement.monthly';

function reader(configured: readonly ScheduleConfiguration[] = [{ scheduleId: STATEMENT, enabled: true }]): ScheduleReader {
  return { read: (_business, scheduleId) => configured.find((c) => c.scheduleId === scheduleId) };
}

function firing(over: Partial<ScheduleFiring> = {}): ScheduleFiring {
  return { businessId: 'b-1', scheduleId: STATEMENT, occurrenceKey: '2026-09', ...over };
}

describe('PART 7.5 — the scheduled path exists, and fails closed', () => {
  it('the five scheduled kinds are reachable: each one`s schedule id resolves to it', () => {
    // The gap, as a measurement: before this round every one of these returned
    // a kind that no function could fire.
    const ids = ['p8.statement.monthly', 'p8.installment.due_soon', 'p8.installment.overdue', 'p8.report.daily_sales', 'p8.alert.low_stock'];
    for (const id of ids) {
      const kinds = scheduledKindsFor(id);
      expect(kinds.length, id).toBeGreaterThan(0);
      for (const kind of kinds) expect(catalogEntry(kind)?.trigger.source, kind).toBe('schedule');
    }
  });

  it('a configured, enabled schedule produces one intent per bound kind, carrying the occurrence', () => {
    const plan = planFromScheduleFiring(firing(), reader());
    expect(plan.plan).toBe('dispatch');
    if (plan.plan !== 'dispatch') throw new Error('unreachable');
    expect(plan.intents.length).toBeGreaterThan(0);
    for (const intent of plan.intents) {
      expect(intent.businessId).toBe('b-1');
      expect(intent.origin).toEqual({ source: 'schedule', scheduleId: STATEMENT, occurrenceKey: '2026-09' });
    }
  });

  it('§41 fails CLOSED: an unconfigured schedule fires nothing, and says so by name', () => {
    const plan = planFromScheduleFiring(firing(), reader([]));
    expect(plan).toEqual({ plan: 'refuse', code: 'notification.schedule_not_configured', detail: `${STATEMENT}/not_configured` });
  });

  it('a configured but DISABLED schedule fires nothing: "nothing recorded" is not a yes', () => {
    const plan = planFromScheduleFiring(firing(), reader([{ scheduleId: STATEMENT, enabled: false }]));
    expect(plan).toEqual({ plan: 'refuse', code: 'notification.schedule_not_configured', detail: `${STATEMENT}/disabled` });
  });

  it('configuration is read per BUSINESS, so another tenant`s schedule does not fire this one', () => {
    const seen: string[] = [];
    const scoped: ScheduleReader = {
      read: (businessId, scheduleId) => {
        seen.push(`${businessId}/${scheduleId}`);
        return businessId === 'b-1' ? { scheduleId, enabled: true } : undefined;
      },
    };
    expect(planFromScheduleFiring(firing({ businessId: 'b-2' }), scoped).plan).toBe('refuse');
    expect(planFromScheduleFiring(firing(), scoped).plan).toBe('dispatch');
    expect(seen).toEqual([`b-2/${STATEMENT}`, `b-1/${STATEMENT}`]);
  });

  it('a schedule id no kind is bound to fires nothing', () => {
    const plan = planFromScheduleFiring(firing({ scheduleId: 'p8.not.a.schedule' }), reader([{ scheduleId: 'p8.not.a.schedule', enabled: true }]));
    expect(plan).toMatchObject({ plan: 'refuse', code: 'notification.kind_unknown' });
  });

  it('a reader that answers about a DIFFERENT schedule is refused, not acted on', () => {
    // Acting on it would send one schedule's message under another's policy.
    const crossed: ScheduleReader = { read: () => ({ scheduleId: 'p8.report.daily_sales', enabled: true }) };
    expect(() => planFromScheduleFiring(firing(), crossed)).toThrow(NotificationRefusal);
  });
});

describe('PART 7.5 — the occurrence is supplied, so a re-run is not a second message', () => {
  it('the same occurrence fired twice yields the SAME obligation key', () => {
    const first = planFromScheduleFiring(firing(), reader());
    const second = planFromScheduleFiring(firing(), reader());
    if (first.plan !== 'dispatch' || second.plan !== 'dispatch') throw new Error('unreachable');
    const ref = { kind: 'customer' as const, customerId: 'c-1' };
    const keyOf = (plan: typeof first) => {
      const intent = plan.intents[0];
      if (!intent) throw new Error('no intent');
      return obligationKey(intent.origin, intent.kind, ref);
    };
    expect(keyOf(second)).toBe(keyOf(first));
    // Which is what makes the second firing `already_owed` in the dispatcher
    // rather than a second statement for the same month.
    expect(keyOf(first)).toContain(`schedule:${STATEMENT}:2026-09`);
  });

  it('a DIFFERENT occurrence is a different obligation: next month is owed', () => {
    const sep = planFromScheduleFiring(firing({ occurrenceKey: '2026-09' }), reader());
    const oct = planFromScheduleFiring(firing({ occurrenceKey: '2026-10' }), reader());
    if (sep.plan !== 'dispatch' || oct.plan !== 'dispatch') throw new Error('unreachable');
    const ref = { kind: 'customer' as const, customerId: 'c-1' };
    const a = sep.intents[0];
    const b = oct.intents[0];
    if (!a || !b) throw new Error('no intent');
    expect(obligationKey(b.origin, b.kind, ref)).not.toBe(obligationKey(a.origin, a.kind, ref));
  });

  it('an empty occurrence is refused: it would collapse every run into one obligation', () => {
    // With one key for all runs, the second month's statement would be
    // `already_owed` and the customer would never receive it again.
    for (const occurrenceKey of ['', '   ']) {
      expect(() => planFromScheduleFiring(firing({ occurrenceKey }), reader())).toThrow(NotificationRefusal);
    }
  });

  it('a malformed firing is a caller defect and throws, while "not configured" is a normal answer', () => {
    expect(() => planFromScheduleFiring(firing({ businessId: '' }), reader())).toThrow(NotificationRefusal);
    expect(() => planFromScheduleFiring(firing({ scheduleId: '' }), reader())).toThrow(NotificationRefusal);
    expect(planFromScheduleFiring(firing(), reader([])).plan).toBe('refuse');
  });
});

describe('PART 7.5 — revocation cancels future sends and does not rewrite the past', () => {
  it('queued and retry_scheduled are ABANDONED: nothing was sent', () => {
    expect(onRevocation('queued')).toEqual({ verdict: 'abandon', code: 'notification.consent_withdrawn' });
    expect(onRevocation('retry_scheduled')).toEqual({ verdict: 'abandon', code: 'notification.consent_withdrawn' });
    expect(onRevocation('queued', 'eligibility')).toEqual({ verdict: 'abandon', code: 'notification.eligibility_withdrawn' });
  });

  it('sending and unknown are RECONCILED, never abandoned: a message may already have arrived', () => {
    // Abandoning here would leave a possibly-delivered message permanently
    // unsettled, so the ledger could no longer answer whether the person who
    // withdrew had already been contacted — which is worst for them.
    expect(onRevocation('sending').verdict).toBe('reconcile_only');
    expect(onRevocation('unknown').verdict).toBe('reconcile_only');
  });

  it('terminal states have nothing for revocation to change', () => {
    for (const state of ['accepted', 'closed', 'dead', 'withheld', 'suppressed'] as const) {
      expect(onRevocation(state), state).toEqual({ verdict: 'nothing_to_do' });
    }
  });

  it('every state is answered, and no state is answered by falling through', () => {
    for (const state of ALL_DELIVERY_STATES) {
      const verdict = onRevocation(state);
      expect(['abandon', 'reconcile_only', 'nothing_to_do'], state).toContain(verdict.verdict);
      // Open work must never be left as "nothing to do": that would be a
      // withdrawal that silently permits the pending send to go out.
      if (isOpenWork(state)) expect(verdict.verdict, state).not.toBe('nothing_to_do');
    }
  });

  it('NO verdict authorises a send, and the allow-list that could change that is empty', () => {
    // An empty allow-list rather than a chain of `!==`: the chain could only
    // ever return false, so asserting on it would prove nothing. This reds the
    // day someone adds a verdict that sends.
    expect(verdictsThatPermitASend()).toEqual([]);
    for (const state of ALL_DELIVERY_STATES) {
      expect(revocationAuthorisesASend(onRevocation(state)), state).toBe(false);
      expect(revocationAuthorisesASend(onRevocation(state, 'eligibility')), state).toBe(false);
    }
  });
});
