/**
 * The SECOND independent challenge, at `4302cd5`, as executable laws.
 *
 * Its verdict was PASS-WITH-SCOPE: the nine original findings are closed and it
 * confirmed that by re-planting each defect against this suite. What it did NOT
 * sign is the surface added in the same push — the scheduled path, revocation,
 * and `classifySend`'s rewritten rejection branch — and it found three real
 * defects there, one of them a blocker. New scope arriving with a fix is the
 * least-reviewed code in any round, which is the lesson under all three.
 */
import { describe, expect, it } from 'vitest';
import { planFromScheduleFiring, type ScheduleReader } from '../src/schedule';
import { dispatchIntent } from '../src/dispatch';
import { obligationKey, deliveryKey, attemptIdentity, originKeyFieldsAreValid } from '../src/identity';
import { classifySend } from '../src/delivery';
import { backoffSeconds } from '../src/retry';
import { onRevocation } from '../src/revocation';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import type { DispatchPorts, HydratedObligation } from '../src/dispatch';
import type { ChannelEligibility, EligibilityDecision } from '../src/eligibility';
import { consentOf, dateFormatter, moneyFormatter } from './helpers';
import type { Recipient } from '../src/types';

const allEligible: ChannelEligibility = { evaluate: (): EligibilityDecision => ({ eligible: true }) };
const vars = {
  customerName: { kind: 'text' as const, text: 'أشرف' },
  invoiceNumber: { kind: 'text' as const, text: 'INV-2026-000041' },
  invoiceTotal: { kind: 'money' as const, money: { minor: '125000', currency: 'ILS' } },
};
function recipientOf(over: Partial<Recipient> = {}): Recipient {
  return { businessId: 'b-1', ref: { kind: 'customer', customerId: 'c-1' }, locale: 'ar', phoneE164: '+972591234567', email: 'c@example.com', ...over };
}
function obligationOf(over: Partial<HydratedObligation> = {}): HydratedObligation {
  return { recipient: recipientOf(), vars, channelOrder: ['whatsapp', 'email', 'inapp'], ...over };
}
function portsFor(over: Partial<DispatchPorts> = {}): DispatchPorts {
  return {
    hydrator: { hydrate: () => Promise.resolve([obligationOf()]) },
    provider: new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] }),
    consent: consentOf(),
    eligibility: allEligible,
    moneyFormatter,
    dateFormatter,
    nowMinuteOfDay: 600,
    ...over,
  };
}

const ISO = '2026-10-12T00:00';
const enabled: ScheduleReader = { read: (_b, id) => ({ scheduleId: id, enabled: true }) };

describe('N-1 — an ISO occurrence key is legal, and a bad one is a RECORDED refusal, never a throw', () => {
  it('the canonical occurrence spelling — an ISO-8601 timestamp — is accepted', () => {
    // Refusing `:` everywhere broke the single most obvious occurrence value. A
    // rule that rejects the canonical spelling of a period does not make the
    // system safer; it makes the automation layer invent a private format.
    const plan = planFromScheduleFiring({ businessId: 'b1', scheduleId: 'p8.statement.monthly', occurrenceKey: ISO }, enabled);
    expect(plan.plan).toBe('dispatch');
    const key = obligationKey('b1', { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: ISO }, 'customer_statement', {
      kind: 'customer',
      customerId: 'c1',
    });
    expect(key).toBe(`b1|schedule:p8.statement.monthly:${ISO}|customer_statement|customer:c1`);
  });

  it('and it stays unambiguous: the occurrence is last in its segment, so its colons cannot be mistaken', () => {
    // The structural reason `:` is safe HERE and nowhere else. Two firings that
    // differ only in where the colon sits must still differ as keys.
    const a = obligationKey('b1', { source: 'schedule', scheduleId: 's', occurrenceKey: 'x:y' }, 'customer_statement', { kind: 'customer', customerId: 'c1' });
    const b = obligationKey('b1', { source: 'schedule', scheduleId: 's', occurrenceKey: 'x' }, 'customer_statement', { kind: 'customer', customerId: 'c1' });
    expect(a).not.toBe(b);
    // A schedule id carrying a colon would make that parse ambiguous, so it is
    // still refused — the allowance is for the terminal field only.
    expect(() =>
      obligationKey('b1', { source: 'schedule', scheduleId: 's:x', occurrenceKey: 'y' }, 'customer_statement', { kind: 'customer', customerId: 'c1' }),
    ).toThrow(/obligation_key_field_invalid/);
  });

  it('the separators that would break a DELIVERY key are still refused inside an occurrence', () => {
    // `deliveryKey` and `attemptIdentity` append `::channel`, `@context` and
    // `#n` AFTER the obligation key, so a `::`, `@` or `#` in an occurrence
    // would make those ambiguous even while the obligation key stayed sound.
    for (const bad of ['a::b', 'a@b', 'a#b', 'a|b']) {
      expect(() =>
        obligationKey('b1', { source: 'schedule', scheduleId: 's', occurrenceKey: bad }, 'customer_statement', { kind: 'customer', customerId: 'c1' }),
      ).toThrow(/obligation_key_field_invalid/);
    }
    const d = deliveryKey(
      obligationKey('b1', { source: 'schedule', scheduleId: 's', occurrenceKey: ISO }, 'customer_statement', {
        kind: 'customer',
        customerId: 'c1',
      }),
      'whatsapp',
    );
    expect(d.split('::')).toHaveLength(2);
    expect(attemptIdentity(d, 1).split('#')).toHaveLength(2);
  });

  it('a firing whose occurrence cannot be a key is REFUSED at plan time, by name', () => {
    const plan = planFromScheduleFiring({ businessId: 'b1', scheduleId: 'p8.statement.monthly', occurrenceKey: 'a|b' }, enabled);
    expect(plan).toEqual({ plan: 'refuse', code: 'notification.obligation_key_field_invalid', detail: 'occurrenceKey/separator' });
  });

  it('the validity of a key field can be ASKED, not only discovered by triggering it', () => {
    expect(originKeyFieldsAreValid({ source: 'schedule', scheduleId: 's', occurrenceKey: ISO })).toEqual({ valid: true });
    expect(originKeyFieldsAreValid({ source: 'schedule', scheduleId: 's', occurrenceKey: 'a#b' })).toEqual({
      valid: false,
      detail: 'occurrenceKey/separator',
    });
  });

  it('A REAL MONTHLY BATCH: a key defect is one refused outcome, and the other recipients are still dispatched', async () => {
    // The blocker, as the challenger framed it: the refusal escaped
    // `dispatchIntent` as an exception, so the first statement run with a bad
    // occurrence took the WHOLE batch down and the ledger recorded nothing
    // about anybody. The batch must survive, and every recipient must get a
    // named outcome.
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] });
    const three = ['c1', 'c2', 'c3'].map((id) => obligationOf({ recipient: recipientOf({ ref: { kind: 'customer', customerId: id } }) }));
    const outcomes = await dispatchIntent(
      {
        kind: 'invoice_issued',
        businessId: 'b-1',
        subjectRefs: {},
        // A `|` cannot be part of a key, so every obligation of this intent is
        // refused — and every one is REPORTED.
        origin: { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: 'a|b' },
      },
      portsFor({ provider, hydrator: { hydrate: () => Promise.resolve(three) } }),
    );
    expect(outcomes).toHaveLength(3);
    for (const o of outcomes) expect(o).toEqual({ result: 'refused', kind: 'invoice_issued', code: 'notification.obligation_key_field_invalid' });
    expect(provider.deliveryCount()).toBe(0);
  });

  it('and dispatchIntent RESOLVES rather than rejecting, whatever the key', async () => {
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] });
    const call = dispatchIntent(
      {
        kind: 'invoice_issued',
        businessId: 'b-1',
        subjectRefs: {},
        origin: { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: 'a@b' },
      },
      portsFor({ provider, hydrator: { hydrate: () => Promise.resolve([obligationOf()]) } }),
    );
    await expect(call).resolves.toBeDefined();
  });
});

describe('N-2 — a stop reason is carried, never substituted', () => {
  it('a rejection stopped by its ERROR CLASS does not claim the attempt limit was reached', () => {
    const out = classifySend({
      // `retryable` and `isTransient` disagree — the case `retry.ts` says must
      // not happen, and the one place it surfaced reported a falsehood.
      result: { outcome: 'rejected', code: 'RECIPIENT_REJECTED', retryable: true },
      providerServerSideIdempotency: false,
      attemptsMade: 1,
      maxAttempts: 8,
      backoffSeconds,
    });
    expect(out.state).toBe('dead');
    expect(out.next).toEqual({ action: 'stop', reason: 'RECIPIENT_REJECTED' });
    if (out.next.action === 'stop') expect(out.next.reason).not.toMatch(/attempt limit/);
  });

  it('a rejection that really did reach the limit still says so', () => {
    const out = classifySend({
      result: { outcome: 'rejected', code: 'PROVIDER_UNAVAILABLE', retryable: true },
      providerServerSideIdempotency: false,
      attemptsMade: 8,
      maxAttempts: 8,
      backoffSeconds,
    });
    expect(out.state).toBe('dead');
    // The reason names the class that was being retried, which is what an
    // operator needs; the limit is implied by the attempt count beside it.
    expect(out.next).toEqual({ action: 'stop', reason: 'PROVIDER_UNAVAILABLE' });
  });

  it('either veto stops the delivery: the adapter`s flag OR the class policy', () => {
    const byAdapter = classifySend({
      result: { outcome: 'rejected', code: 'PROVIDER_UNAVAILABLE', retryable: false },
      providerServerSideIdempotency: false,
      attemptsMade: 1,
      maxAttempts: 8,
      backoffSeconds,
    });
    expect(byAdapter).toEqual({ state: 'dead', next: { action: 'stop', reason: 'PROVIDER_UNAVAILABLE' } });
    const bothAgreeRetry = classifySend({
      result: { outcome: 'rejected', code: 'PROVIDER_UNAVAILABLE', retryable: true },
      providerServerSideIdempotency: false,
      attemptsMade: 1,
      maxAttempts: 8,
      backoffSeconds,
    });
    expect(bothAgreeRetry.state).toBe('retry_scheduled');
  });
});

describe('N-3 — a scheduled retry says WHY it is scheduled, and an unrecorded reason fails closed', () => {
  it('only a PROVEN rejection permits abandoning a scheduled retry', () => {
    expect(onRevocation({ state: 'retry_scheduled', scheduledRetryProvenance: 'after_proven_rejection' })).toEqual({
      verdict: 'abandon',
      code: 'notification.consent_withdrawn',
    });
  });

  it('a scheduled retry after an AMBIGUOUS attempt is reconciled: a message may already be out', () => {
    // `classifySend` reaches retry_scheduled from an unknown whenever the
    // provider declares server-side idempotency, which this module could not
    // see and asserted could not happen.
    const ambiguous = classifySend({
      result: { outcome: 'unknown', code: 'PROVIDER_TIMEOUT', reason: 'timeout_after_send' },
      providerServerSideIdempotency: true,
      attemptsMade: 1,
      maxAttempts: 8,
      backoffSeconds,
    });
    expect(ambiguous.state).toBe('retry_scheduled');
    expect(onRevocation({ state: 'retry_scheduled', scheduledRetryProvenance: 'after_ambiguous_result' }).verdict).toBe('reconcile_only');
  });

  it('an UNRECORDED provenance is reconciled, not abandoned — silence is not permission', () => {
    const v = onRevocation({ state: 'retry_scheduled' });
    expect(v.verdict).toBe('reconcile_only');
    if (v.verdict === 'reconcile_only') expect(v.reason).toMatch(/not recorded/);
    // And the old positional call, which cannot carry a provenance, must take
    // the safe reading rather than the convenient one.
    expect(onRevocation('retry_scheduled').verdict).toBe('reconcile_only');
  });

  it('the rest of the matrix is unchanged', () => {
    expect(onRevocation('queued')).toEqual({ verdict: 'abandon', code: 'notification.consent_withdrawn' });
    expect(onRevocation('sending').verdict).toBe('reconcile_only');
    expect(onRevocation('unknown').verdict).toBe('reconcile_only');
    for (const terminal of ['accepted', 'closed', 'dead', 'withheld', 'suppressed'] as const) {
      expect(onRevocation(terminal)).toEqual({ verdict: 'nothing_to_do' });
    }
    expect(onRevocation({ state: 'queued', cause: 'eligibility' })).toEqual({ verdict: 'abandon', code: 'notification.eligibility_withdrawn' });
  });
});
