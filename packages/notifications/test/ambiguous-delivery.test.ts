import { describe, expect, it } from 'vitest';
import { classifySend, isOpenWork, mayAutoRetry, resolveUnknown, type DeliveryState } from '../src/delivery';
import { classifyTransportThrow, type ProviderSendResult } from '../src/provider';
import { backoffSeconds, MAX_ATTEMPTS } from '../src/retry';
import { dispatchIntent, type DispatchPorts, type HydratedObligation, type NotificationHydrator } from '../src/dispatch';
import { planFromOutboxRow, type DispatchIntent, type OutboxRow } from '../src/consumer';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import type { ChannelEligibility, EligibilityDecision } from '../src/eligibility';
import { consentOf, dateFormatter, moneyFormatter } from './helpers';
import type { Recipient } from '../src/types';

const saleRow: OutboxRow = {
  id: 'ev-1',
  type: 'sale.committed.v1',
  payload: { businessId: 'b-1', saleId: 's-1', invoiceId: 'i-1', businessTransactionId: 't-1' },
};

function intentOf(): DispatchIntent {
  const intent = planFromOutboxRow(saleRow).intents[0];
  if (!intent) throw new Error('fixture produced no intent');
  return intent;
}

const allEligible: ChannelEligibility = { evaluate: (): EligibilityDecision => ({ eligible: true }) };

const vars = {
  customerName: { kind: 'text' as const, text: 'أشرف' },
  invoiceNumber: { kind: 'text' as const, text: 'INV-2026-000041' },
  invoiceTotal: { kind: 'money' as const, money: { minor: '125000', currency: 'ILS' } },
};

const recipient: Recipient = {
  businessId: 'b-1',
  ref: { kind: 'customer', customerId: 'c-1' },
  locale: 'ar',
  phoneE164: '+972591234567',
  email: 'customer@example.com',
};

function obligation(over: Partial<HydratedObligation> = {}): HydratedObligation {
  return { recipient, vars, channelOrder: ['whatsapp', 'email', 'inapp'], ...over };
}

function hydratorOf(list: readonly HydratedObligation[]): NotificationHydrator {
  return { hydrate: () => Promise.resolve(list) };
}

function ports(over: Partial<DispatchPorts>): DispatchPorts {
  return {
    hydrator: hydratorOf([obligation()]),
    provider: new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] }),
    consent: consentOf(),
    eligibility: allEligible,
    moneyFormatter,
    dateFormatter,
    nowMinuteOfDay: 600,
    ...over,
  };
}

const unknown: ProviderSendResult = { outcome: 'unknown', code: 'PROVIDER_TIMEOUT', reason: 'timeout_after_send' };
const rejectedTransient: ProviderSendResult = { outcome: 'rejected', code: 'PROVIDER_UNAVAILABLE', retryable: true };
const rejectedTerminal: ProviderSendResult = { outcome: 'rejected', code: 'RECIPIENT_REJECTED', retryable: false };
const accepted: ProviderSendResult = { outcome: 'accepted', providerMessageId: 'wamid.X' };

describe('PART 44 — an ambiguous result is never auto-resent', () => {
  it('mayAutoRetry refuses an unknown result for a provider with no server-side idempotency', () => {
    expect(mayAutoRetry(unknown, false)).toBe(false);
    // Only a real server-side guarantee makes a second identical send harmless.
    expect(mayAutoRetry(unknown, true)).toBe(true);
  });

  it('mayAutoRetry never resends an acceptance, whatever the provider claims', () => {
    expect(mayAutoRetry(accepted, false)).toBe(false);
    expect(mayAutoRetry(accepted, true)).toBe(false);
  });

  it('a PROVEN rejection retries on its own class, with no reference to idempotency', () => {
    expect(mayAutoRetry(rejectedTransient, false)).toBe(true);
    expect(mayAutoRetry(rejectedTerminal, false)).toBe(false);
    expect(mayAutoRetry(rejectedTerminal, true)).toBe(false);
  });

  it('classifySend parks an unknown as `unknown` + reconcile, never as retry', () => {
    const outcome = classifySend({ result: unknown, providerServerSideIdempotency: false, attemptsMade: 1, maxAttempts: MAX_ATTEMPTS, backoffSeconds });
    expect(outcome).toEqual({ state: 'unknown', next: { action: 'reconcile', reason: 'timeout_after_send' } });
  });

  it('an idempotent provider may retry an unknown, and stops at the attempt limit without claiming failure', () => {
    const retry = classifySend({ result: unknown, providerServerSideIdempotency: true, attemptsMade: 1, maxAttempts: 8, backoffSeconds });
    expect(retry).toEqual({ state: 'retry_scheduled', next: { action: 'retry', afterSeconds: 10 } });
    const exhausted = classifySend({ result: unknown, providerServerSideIdempotency: true, attemptsMade: 8, maxAttempts: 8, backoffSeconds });
    // Still `unknown`: the limit says stop trying, not "it was never sent".
    expect(exhausted.state).toBe('unknown');
    expect(exhausted.next).toEqual({ action: 'stop', reason: 'attempt limit reached while the outcome is unknown', cause: 'attempt_limit', attempts: 8 });
  });

  it('a terminal rejection dies; a transient one retries; the limit dead-letters', () => {
    expect(classifySend({ result: rejectedTerminal, providerServerSideIdempotency: false, attemptsMade: 1, maxAttempts: 8, backoffSeconds })).toEqual({
      state: 'dead',
      next: { action: 'stop', reason: 'RECIPIENT_REJECTED', cause: 'terminal_class', attempts: 1 },
    });
    expect(classifySend({ result: rejectedTransient, providerServerSideIdempotency: false, attemptsMade: 2, maxAttempts: 8, backoffSeconds })).toEqual({
      state: 'retry_scheduled',
      next: { action: 'retry', afterSeconds: 20 },
    });
    // The reason NAMES the class that was being retried, rather than the
    // constant "attempt limit reached" this used to assert. That constant was
    // returned for every dead rejection, including ones stopped by their error
    // class on attempt 1 of 8 — a falsehood in the field an operator reads.
    // See `test/challenge-4302cd5.test.ts` N-2.
    expect(classifySend({ result: rejectedTransient, providerServerSideIdempotency: false, attemptsMade: 8, maxAttempts: 8, backoffSeconds })).toEqual({
      state: 'dead',
      next: { action: 'stop', reason: 'PROVIDER_UNAVAILABLE', cause: 'attempt_limit', attempts: 8 },
    });
  });

  it('reconciliation resolves an unknown three ways, and only one of them sends', () => {
    expect(resolveUnknown({ found: true, providerMessageId: 'wamid.X' })).toEqual({ state: 'accepted', next: { action: 'none' } });
    expect(resolveUnknown({ found: false })).toEqual({ state: 'retry_scheduled', next: { action: 'retry', afterSeconds: 0 } });
    // The reason is carried through, so the reconciliation queue entry says
    // what would actually settle it rather than a constant string.
    expect(resolveUnknown({ inconclusive: true, reason: 'lookup_failed' })).toEqual({
      state: 'unknown',
      next: { action: 'reconcile', reason: 'lookup_failed' },
    });
  });

  it('a connection that was never made is a PROVEN rejection; a mid-flight loss is not', () => {
    expect(classifyTransportThrow(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).outcome).toBe('rejected');
    expect(classifyTransportThrow(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).outcome).toBe('rejected');
    expect(classifyTransportThrow(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({
      outcome: 'unknown',
      code: 'PROVIDER_UNAVAILABLE',
      reason: 'transport_interrupted',
    });
    expect(classifyTransportThrow(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).outcome).toBe('unknown');
    // An error nobody recognised is not evidence of non-delivery.
    expect(classifyTransportThrow(new Error('something nobody has seen before')).outcome).toBe('unknown');
  });
});

describe('PART 46 — an open delivery is not finished work', () => {
  it('queued, sending, unknown and retry_scheduled are all OPEN; only dead and closed are not', () => {
    const open: DeliveryState[] = ['queued', 'sending', 'unknown', 'retry_scheduled'];
    for (const state of open) expect(isOpenWork(state), state).toBe(true);
    // `accepted` is not open for the SENDER: the provider has the message, so
    // there is nothing to send. Its final status arrives through a callback,
    // which is concern D, not this machine's work queue.
    expect(isOpenWork('accepted')).toBe(false);
    expect(isOpenWork('dead')).toBe(false);
    expect(isOpenWork('closed')).toBe(false);
  });

  it('an existing obligation whose delivery is UNKNOWN still has work to do', () => {
    // The trap PART 46 names: "an obligation exists" read as "nothing left to do".
    const state = classifySend({ result: unknown, providerServerSideIdempotency: false, attemptsMade: 1, maxAttempts: 8, backoffSeconds }).state;
    expect(isOpenWork(state)).toBe(true);
  });
});

describe('PART 44 — the dispatcher stops the obligation on an ambiguous send', () => {
  it('reports `unknown` with reconcile, and does NOT fall through to the next channel', async () => {
    // The fake RECORDS the message and then reports unknown: the provider has
    // it, the caller does not know. A fallback to email here is a second
    // notification for a message that may already have arrived.
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: true,
      channels: ['whatsapp', 'email', 'inapp'],
      serverSideIdempotency: false,
      unknownWith: ['timeout_after_send'],
    });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      result: 'unknown',
      channel: 'whatsapp',
      reason: 'timeout_after_send',
      state: 'unknown',
      next: { action: 'reconcile', reason: 'timeout_after_send' },
    });
    // One message left the building, and exactly one.
    expect(provider.acceptedCount()).toBe(1);
    expect(provider.acceptedMessages()[0]?.channel).toBe('whatsapp');
  });

  it('and a naive re-dispatch — the bug this round closes — would have sent it twice', async () => {
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: true,
      channels: ['whatsapp', 'email', 'inapp'],
      serverSideIdempotency: false,
      unknownWith: ['timeout_after_send'],
    });
    const intent = intentOf();
    const first = await dispatchIntent(intent, ports({ provider }));
    expect(first[0]?.result).toBe('unknown');

    // A worker that treated `unknown` as a failure and re-dispatched would
    // reach the provider a second time. This asserts the HARM, so the law
    // above is measured against something real rather than asserted.
    await dispatchIntent(intent, ports({ provider }));
    expect(provider.acceptedCount()).toBe(2);
    // Which is why `next.action` is `reconcile` and never `retry`:
    expect(first[0]).toMatchObject({ next: { action: 'reconcile' } });
  });

  it('a provider WITH server-side idempotency collapses the retry to one message', async () => {
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: true,
      channels: ['whatsapp'],
      serverSideIdempotency: true,
      unknownWith: ['timeout_after_send'],
    });
    const intent = intentOf();
    const hydrator = hydratorOf([obligation({ channelOrder: ['whatsapp'] })]);
    const first = await dispatchIntent(intent, ports({ provider, hydrator }));
    expect(first[0]).toMatchObject({ state: 'retry_scheduled', next: { action: 'retry' } });
    // The retry re-uses the STABLE logical delivery key, so the provider
    // recognises it. Change that key per attempt and this becomes two messages.
    const delivery = first[0]?.result === 'unknown' || first[0]?.result === 'failed' ? first[0].delivery : '';
    await dispatchIntent(intent, ports({ provider, hydrator, attemptsSoFar: new Map([[delivery, 1]]) }));
    expect(provider.deliveryCount()).toBe(1);
  });
});
