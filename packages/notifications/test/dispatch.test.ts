import { describe, expect, it } from 'vitest';
import { dispatchIntent, type DispatchPorts, type HydratedObligation, type NotificationHydrator } from '../src/dispatch';
import { planFromOutboxRow, type DispatchIntent, type OutboxRow } from '../src/consumer';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import { obligationKey } from '../src/identity';
import type { ChannelEligibility, EligibilityDecision } from '../src/eligibility';
import { RefuseExternalChannels } from '../src/eligibility';
import { dateFormatter, moneyFormatter } from './helpers';
import type { Channel, Recipient, RecipientRef } from '../src/types';

const saleRow: OutboxRow = {
  id: 'ev-1',
  type: 'sale.committed.v1',
  payload: { businessId: 'b-1', saleId: 's-1', invoiceId: 'i-1', businessTransactionId: 't-1' },
};

function intentOf(row: OutboxRow = saleRow): DispatchIntent {
  const intent = planFromOutboxRow(row).intents[0];
  if (!intent) throw new Error('fixture produced no intent');
  return intent;
}

/** Everything external is eligible — the strict default has its own tests. */
const allEligible: ChannelEligibility = { evaluate: (): EligibilityDecision => ({ eligible: true }) };

const vars = {
  customerName: { kind: 'text' as const, text: 'أشرف' },
  invoiceNumber: { kind: 'text' as const, text: 'INV-2026-000041' },
  invoiceTotal: { kind: 'money' as const, money: { minor: '125000', currency: 'ILS' } },
};

function recipient(over: Partial<Recipient> = {}): Recipient {
  return { businessId: 'b-1', ref: { kind: 'customer', customerId: 'c-1' }, locale: 'ar', phoneE164: '+972591234567', email: 'customer@example.com', ...over };
}

function obligation(over: Partial<HydratedObligation> = {}): HydratedObligation {
  return { recipient: recipient(), preferences: { channels: [] }, vars, channelOrder: ['whatsapp', 'email', 'inapp'], ...over };
}

function hydratorOf(list: readonly HydratedObligation[] | undefined): NotificationHydrator {
  return { hydrate: () => Promise.resolve(list) };
}

function ports(over: Partial<DispatchPorts> = {}): DispatchPorts {
  return {
    hydrator: hydratorOf([obligation()]),
    provider: new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] }),
    eligibility: allEligible,
    moneyFormatter,
    dateFormatter,
    nowMinuteOfDay: 600,
    ...over,
  };
}

describe('dispatch — obligations', () => {
  it('delivers on the first allowed channel and stops there', async () => {
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      result: 'delivered',
      kind: 'invoice_issued',
      channel: 'whatsapp',
      obligation: 'event:ev-1|invoice_issued|customer:c-1',
      attempt: 'event:ev-1|invoice_issued|customer:c-1#whatsapp#1',
    });
    expect(provider.deliveryCount()).toBe(1);
    expect(provider.deliveries()[0]?.rendered.providerTemplate?.name).toBe('daftar_invoice_issued');
  });

  it('TL-P8-R1 — one event owing three recipients produces three obligations, none lost', async () => {
    const refs: RecipientRef[] = [
      { kind: 'customer', customerId: 'c-1' },
      { kind: 'customer', customerId: 'c-2' },
      { kind: 'user', userId: 'u-9' },
    ];
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const owed = refs.map((ref) => obligation({ recipient: recipient({ ref }) }));
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf(owed) }));
    expect(outcomes).toHaveLength(3);
    expect(new Set(outcomes.map((o) => (o.result === 'delivered' ? o.obligation : '')))).toEqual(
      new Set(['event:ev-1|invoice_issued|customer:c-1', 'event:ev-1|invoice_issued|customer:c-2', 'event:ev-1|invoice_issued|user:u-9']),
    );
    expect(provider.deliveryCount()).toBe(3);
  });

  it('two recipients differing only in id are two obligations, not one', async () => {
    const a = obligationKey({ source: 'event', eventId: 'ev-1' }, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const b = obligationKey({ source: 'event', eventId: 'ev-1' }, 'invoice_issued', { kind: 'customer', customerId: 'c-2' });
    expect(a).not.toBe(b);
  });

  it('§38 — a whole-event retry does not externally duplicate an obligation already recorded', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const intent = intentOf();
    const first = await dispatchIntent(intent, ports({ provider }));
    expect(first[0]?.result).toBe('delivered');
    const recorded = new Set(first.flatMap((o) => (o.result === 'delivered' ? [o.obligation] : [])));
    expect(recorded.size).toBe(1);

    // Another sink failed, so the publisher retries the WHOLE event. The
    // notification sink is handed the same row again.
    const second = await dispatchIntent(intent, ports({ provider, obligationsAlreadyRecorded: recorded }));
    expect(second).toEqual([{ result: 'already_owed', kind: 'invoice_issued', obligation: 'event:ev-1|invoice_issued|customer:c-1' }]);
    expect(provider.deliveryCount()).toBe(1);
  });

  it('a hydrator that repeats a recipient still sends once', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation(), obligation()]) }));
    expect(outcomes).toHaveLength(1);
    expect(provider.deliveryCount()).toBe(1);
  });

  it('§39 — refuses a recipient belonging to another business', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydratorOf([obligation({ recipient: recipient({ businessId: 'b-OTHER' }) })]) }),
    );
    expect(outcomes).toEqual([
      { result: 'refused', kind: 'invoice_issued', obligation: 'event:ev-1|invoice_issued|customer:c-1', code: 'notification.recipient_business_mismatch' },
    ]);
    expect(provider.deliveryCount()).toBe(0);
  });

  it('§40 — the strict default eligibility refuses every external channel and sends nothing', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, eligibility: new RefuseExternalChannels() }));
    expect(outcomes.filter((o) => o.result === 'suppressed')).toHaveLength(2); // whatsapp, email
    for (const o of outcomes) {
      if (o.result === 'suppressed') expect(o.code).toBe('notification.channel_not_eligible');
    }
    // The in-app record remains deliverable: it is a local surface, not a dispatch.
    expect(outcomes.at(-1)).toMatchObject({ result: 'delivered', channel: 'inapp' });
    expect(provider.deliveries().map((d) => d.channel)).toEqual(['inapp']);
  });

  it('§40 — an internal consent class alone never opens an external channel', async () => {
    // The kind is transactional and the recipient opted nothing out, so the
    // internal gate allows. Eligibility still decides.
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({
        provider,
        hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]),
        eligibility: { evaluate: () => ({ eligible: false, reason: 'outside the service window' }) },
      }),
    );
    expect(outcomes).toEqual([
      {
        result: 'suppressed',
        kind: 'invoice_issued',
        obligation: 'event:ev-1|invoice_issued|customer:c-1',
        channel: 'whatsapp',
        code: 'notification.channel_not_eligible',
        detail: 'outside the service window',
      },
    ]);
    expect(provider.deliveryCount()).toBe(0);
  });

  it('falls through to the next channel when the first is opted out', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydratorOf([obligation({ preferences: { channels: [{ channel: 'whatsapp', state: 'opted_out' }] } })]) }),
    );
    expect(outcomes.map((o) => o.result)).toEqual(['suppressed', 'delivered']);
    expect(provider.deliveries()[0]?.channel).toBe('email');
  });

  it('defers inside quiet hours and sends nothing', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({
        provider,
        nowMinuteOfDay: 120,
        hydrator: hydratorOf([
          obligation({ preferences: { channels: [], quietHours: { startMinuteOfDay: 1320, endMinuteOfDay: 420 } }, channelOrder: ['whatsapp'] }),
        ]),
      }),
    );
    expect(outcomes).toEqual([
      { result: 'deferred', kind: 'invoice_issued', obligation: 'event:ev-1|invoice_issued|customer:c-1', channel: 'whatsapp', untilMinuteOfDay: 420 },
    ]);
    expect(provider.deliveryCount()).toBe(0);
  });

  it('numbers the attempt from the history it is given', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_TIMEOUT'] });
    const key = 'event:ev-1|invoice_issued|customer:c-1';
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]), attemptsSoFar: new Map([[`${key}#whatsapp`, 2]]) }),
    );
    expect(outcomes).toEqual([
      {
        result: 'failed',
        kind: 'invoice_issued',
        obligation: key,
        channel: 'whatsapp',
        attempt: `${key}#whatsapp#3`,
        next: { step: 'retry', attempts: 3, afterSeconds: 40 },
      },
    ]);
  });

  it('turns a transient provider failure into a retry, not a loss', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_TIMEOUT'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }));
    expect(outcomes[0]).toMatchObject({ result: 'failed', next: { step: 'retry', attempts: 1, afterSeconds: 10 } });
  });

  it('dead-letters a terminal provider failure immediately', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_AUTH_FAILED'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }));
    expect(outcomes[0]).toMatchObject({ result: 'failed', next: { step: 'dead', attempts: 1, reason: 'PROVIDER_AUTH_FAILED' } });
  });

  it('classifies an adapter THROW instead of letting it escape', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], throwOn: [Object.assign(new Error('rate limit reached'), { status: 429 })] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }));
    expect(outcomes[0]).toMatchObject({ result: 'failed', next: { step: 'retry', attempts: 1 } });
  });

  it('refuses when hydration cannot complete — never a blank notification', async () => {
    const outcomes = await dispatchIntent(intentOf(), ports({ hydrator: hydratorOf(undefined) }));
    expect(outcomes).toEqual([{ result: 'refused', kind: 'invoice_issued', code: 'notification.hydration_incomplete' }]);
  });

  it('distinguishes "nobody is owed this" from "I could not read"', async () => {
    const outcomes = await dispatchIntent(intentOf(), ports({ hydrator: hydratorOf([]) }));
    expect(outcomes).toEqual([]);
  });

  it('suppresses with the refusal code when a required variable is missing', async () => {
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ hydrator: hydratorOf([obligation({ vars: { customerName: { kind: 'text', text: 'أشرف' } }, channelOrder: ['whatsapp'] })]) }),
    );
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.template_variable_missing' });
  });

  it('refuses a channel order the kind does not allow at all', async () => {
    const outcomes = await dispatchIntent(intentOf(), ports({ hydrator: hydratorOf([obligation({ channelOrder: ['sms' as Channel] })]) }));
    expect(outcomes).toEqual([
      { result: 'refused', kind: 'invoice_issued', obligation: 'event:ev-1|invoice_issued|customer:c-1', code: 'notification.channel_not_supported_for_kind' },
    ]);
  });

  it('suppresses an unaddressable recipient rather than calling the provider', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const bare: Recipient = { businessId: 'b-1', ref: { kind: 'customer', customerId: 'c-1' }, locale: 'ar' };
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ recipient: bare, channelOrder: ['whatsapp'] })]) }));
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.address_missing' });
    expect(provider.deliveryCount()).toBe(0);
  });

  it('suppresses a malformed phone number (E.164 only)', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydratorOf([obligation({ recipient: recipient({ phoneE164: '0591234567' }), channelOrder: ['whatsapp'] })]) }),
    );
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.address_invalid' });
    expect(provider.deliveryCount()).toBe(0);
  });

  it('renders in the recipient locale, not a default one', async () => {
    const provider = new FakeNotificationProvider({ channels: ['email'] });
    await dispatchIntent(
      intentOf(),
      ports({
        provider,
        hydrator: hydratorOf([obligation({ recipient: recipient({ locale: 'tr', ref: { kind: 'user', userId: 'u-1' } }), channelOrder: ['email'] })]),
      }),
    );
    expect(provider.deliveries()[0]?.rendered.body).toContain('faturanız oluşturuldu');
  });
});
