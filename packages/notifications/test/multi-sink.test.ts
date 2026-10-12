/**
 * PART 47 — multi-sink outbox safety, proved by a real failure interleaving.
 *
 * The existing publisher (apps/api/src/modules/outbox/publisher.ts) is
 * at-least-once over the WHOLE event: one row, N sinks, and a retry re-delivers
 * the row to every sink that the publisher cannot prove is done. So if the
 * notification sink succeeded and an analytics sink threw, the retry hands the
 * notification sink the same event again — and a customer gets a second
 * WhatsApp message for one sale.
 *
 * Two independent mechanisms stop it, and this suite exercises both:
 *   1. DURABLE PER-SINK PROGRESS — the publisher records which sink completed
 *      and re-delivers only the rest (patch request P8-02, the file's owner).
 *   2. PROVEN SINK IDEMPOTENCY — the notification sink's own obligation ledger
 *      makes a second delivery of the same event a no-op (this package).
 *
 * The failure is a REAL throw from a real second sink, not a simulated flag:
 * the interleaving is what is being proved, so it has to actually happen.
 *
 * Every provider here declares `serverSideIdempotency: false`, which is what
 * WhatsApp Cloud actually offers (PART 42). A fake that deduped for us would
 * make this whole suite pass without either mechanism existing.
 */
import { describe, expect, it } from 'vitest';
import { dispatchIntent, type DispatchPorts, type HydratedObligation, type NotificationHydrator } from '../src/dispatch';
import { planFromOutboxRow, type OutboxRow } from '../src/consumer';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import type { ChannelEligibility, EligibilityDecision } from '../src/eligibility';
import { dateFormatter, moneyFormatter } from './helpers';
import type { Recipient, RecipientRef } from '../src/types';

const saleRow: OutboxRow = {
  id: 'ev-1',
  type: 'sale.committed.v1',
  payload: { businessId: 'b-1', saleId: 's-1', invoiceId: 'i-1', businessTransactionId: 't-1' },
};

const allEligible: ChannelEligibility = { evaluate: (): EligibilityDecision => ({ eligible: true }) };

const vars = {
  customerName: { kind: 'text' as const, text: 'أشرف' },
  invoiceNumber: { kind: 'text' as const, text: 'INV-2026-000041' },
  invoiceTotal: { kind: 'money' as const, money: { minor: '125000', currency: 'ILS' } },
};

function recipientOf(ref: RecipientRef): Recipient {
  return { businessId: 'b-1', ref, locale: 'ar', phoneE164: '+972591234567', email: 'customer@example.com' };
}

function obligationFor(ref: RecipientRef): HydratedObligation {
  return { recipient: recipientOf(ref), preferences: { channels: [] }, vars, channelOrder: ['whatsapp'], ...{} };
}

function hydratorOf(list: readonly HydratedObligation[]): NotificationHydrator {
  return { hydrate: () => Promise.resolve(list) };
}

/** A sink, as the publisher sees one: a name and something that can throw. */
interface Sink {
  readonly name: string;
  handle(row: OutboxRow): Promise<void>;
}

/** A second sink that genuinely throws, so the interleaving is not simulated. */
class ThrowingAnalyticsSink implements Sink {
  readonly name = 'analytics';
  calls = 0;
  constructor(private failuresLeft: number) {}
  handle(): Promise<void> {
    this.calls += 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      return Promise.reject(new Error('analytics sink is down'));
    }
    return Promise.resolve();
  }
}

/**
 * The publisher, reduced to the behaviour that matters: deliver the row to
 * every sink, and if ANY sink throws, the whole row is retried. `completed`
 * models mechanism 1 — durable per-sink progress — and is deliberately
 * optional so the suite can show what happens WITHOUT it.
 */
async function publishOnce(row: OutboxRow, sinks: readonly Sink[], completed?: Set<string>): Promise<{ redeliver: boolean }> {
  let failed = false;
  for (const sink of sinks) {
    if (completed?.has(`${row.id}:${sink.name}`) === true) continue;
    try {
      await sink.handle(row);
      completed?.add(`${row.id}:${sink.name}`);
    } catch {
      failed = true;
    }
  }
  return { redeliver: failed };
}

describe('PART 47 — sink A succeeded, sink B failed, and the retry must not duplicate A', () => {
  function notificationSink(provider: FakeNotificationProvider, ledger: Set<string>): Sink {
    const ports = (): DispatchPorts => ({
      hydrator: hydratorOf([obligationFor({ kind: 'customer', customerId: 'c-1' })]),
      provider,
      eligibility: allEligible,
      moneyFormatter,
      dateFormatter,
      nowMinuteOfDay: 600,
      obligationsAlreadyRecorded: ledger,
    });
    return {
      name: 'notifications',
      handle: async (row) => {
        for (const intent of planFromOutboxRow(row).intents) {
          for (const outcome of await dispatchIntent(intent, ports())) {
            // The ledger write is what mechanism 2 rests on, and it records the
            // OBLIGATION — not the event — so ten recipients are ten rows.
            if (outcome.result === 'delivered') ledger.add(outcome.obligation);
          }
        }
      },
    };
  }

  it('mechanism 2 — the obligation ledger alone makes the retry send nothing', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], serverSideIdempotency: false });
    const ledger = new Set<string>();
    const analytics = new ThrowingAnalyticsSink(1);
    const sinks = [notificationSink(provider, ledger), analytics];

    const first = await publishOnce(saleRow, sinks);
    // The interleaving really happened: A succeeded, B threw.
    expect(provider.acceptedCount()).toBe(1);
    expect(analytics.calls).toBe(1);
    expect(first.redeliver).toBe(true);

    const second = await publishOnce(saleRow, sinks);
    expect(second.redeliver).toBe(false);
    // B ran again, as at-least-once requires. A did not send again.
    expect(analytics.calls).toBe(2);
    expect(provider.acceptedCount()).toBe(1);
    expect(ledger.size).toBe(1);
  });

  it('mechanism 1 — durable per-sink progress skips A entirely on the retry', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], serverSideIdempotency: false });
    const ledger = new Set<string>();
    const analytics = new ThrowingAnalyticsSink(1);
    const sinks = [notificationSink(provider, ledger), analytics];
    const completed = new Set<string>();

    expect((await publishOnce(saleRow, sinks, completed)).redeliver).toBe(true);
    expect(completed.has('ev-1:notifications')).toBe(true);
    expect(completed.has('ev-1:analytics')).toBe(false);

    await publishOnce(saleRow, sinks, completed);
    expect(analytics.calls).toBe(2);
    expect(provider.acceptedCount()).toBe(1);
  });

  it('WITHOUT either mechanism the duplicate is real — which is why both are required', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], serverSideIdempotency: false });
    const analytics = new ThrowingAnalyticsSink(1);
    // A fresh, empty ledger on every delivery: the sink has no memory.
    const forgetful: Sink = {
      name: 'notifications',
      handle: async (row) => {
        for (const intent of planFromOutboxRow(row).intents) {
          await dispatchIntent(intent, {
            hydrator: hydratorOf([obligationFor({ kind: 'customer', customerId: 'c-1' })]),
            provider,
            eligibility: allEligible,
            moneyFormatter,
            dateFormatter,
            nowMinuteOfDay: 600,
          });
        }
      },
    };
    await publishOnce(saleRow, [forgetful, analytics]);
    await publishOnce(saleRow, [forgetful, analytics]);
    // Two messages for one sale: the harm the two mechanisms prevent, measured.
    expect(provider.acceptedCount()).toBe(2);
  });

  it('TL-P8-R1 under a retry — ten recipients are ten ledger rows, and none is lost behind the first', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], serverSideIdempotency: false });
    const ledger = new Set<string>();
    const refs: RecipientRef[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'customer', customerId: `c-${i + 1}` }));
    const ports = (): DispatchPorts => ({
      hydrator: hydratorOf(refs.map(obligationFor)),
      provider,
      eligibility: allEligible,
      moneyFormatter,
      dateFormatter,
      nowMinuteOfDay: 600,
      obligationsAlreadyRecorded: ledger,
    });
    const sink: Sink = {
      name: 'notifications',
      handle: async (row) => {
        for (const intent of planFromOutboxRow(row).intents) {
          for (const outcome of await dispatchIntent(intent, ports())) {
            if (outcome.result === 'delivered') ledger.add(outcome.obligation);
          }
        }
      },
    };
    const analytics = new ThrowingAnalyticsSink(1);

    await publishOnce(saleRow, [sink, analytics]);
    expect(ledger.size).toBe(10);
    expect(provider.acceptedCount()).toBe(10);

    await publishOnce(saleRow, [sink, analytics]);
    // An event-keyed ledger would have 1 row here and nine people untold on the
    // first pass; an obligation-keyed one has 10 and sends nothing twice.
    expect(ledger.size).toBe(10);
    expect(provider.acceptedCount()).toBe(10);
  });
});
