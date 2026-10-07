import { describe, expect, it } from 'vitest';
import { dispatchIntent, type DispatchPorts, type HydratedIntent, type NotificationHydrator } from '../src/dispatch';
import { planFromOutboxRow, type DispatchIntent, type OutboxRow } from '../src/consumer';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import { dateFormatter, moneyFormatter } from './helpers';
import type { Channel } from '../src/types';

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

function hydrator(over: Partial<HydratedIntent> = {}, found = true): NotificationHydrator {
  const base: HydratedIntent = {
    recipient: { businessId: 'b-1', customerId: 'c-1', locale: 'ar', phoneE164: '+972591234567', email: 'customer@example.com' },
    preferences: { channels: [] },
    vars: {
      customerName: { kind: 'text', text: 'أشرف' },
      invoiceNumber: { kind: 'text', text: 'INV-2026-000041' },
      invoiceTotal: { kind: 'money', money: { minor: '125000', currency: 'ILS' } },
    },
    channelOrder: ['whatsapp', 'email', 'inapp'],
    ...over,
  };
  return { hydrate: () => Promise.resolve(found ? base : undefined) };
}

function ports(over: Partial<DispatchPorts> = {}): DispatchPorts {
  return {
    hydrator: hydrator(),
    provider: new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] }),
    moneyFormatter,
    dateFormatter,
    nowMinuteOfDay: 600,
    ...over,
  };
}

describe('dispatch', () => {
  it('delivers on the first allowed channel and stops there', async () => {
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ result: 'delivered', kind: 'invoice_issued', channel: 'whatsapp' });
    expect(provider.deliveryCount()).toBe(1);
    const sent = provider.deliveries()[0];
    expect(sent?.rendered.providerTemplate?.name).toBe('daftar_invoice_issued');
    expect(sent?.idempotencyKey).toBe('ev-1:invoice_issued:whatsapp');
  });

  it('sends once when the at-least-once outbox delivers the same row twice', async () => {
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] });
    const p = ports({ provider });
    const first = await dispatchIntent(intentOf(), p);
    const second = await dispatchIntent(intentOf(), p);
    expect(first[0]).toMatchObject({ result: 'delivered' });
    expect(second[0]).toMatchObject({ result: 'delivered' });
    // Two dispatches, ONE message: the provider recognised the stable key.
    expect(provider.deliveryCount()).toBe(1);
  });

  it('honours an explicit already-sent ledger without touching the provider', async () => {
    const provider = new FakeNotificationProvider();
    const intent = intentOf();
    const outcomes = await dispatchIntent(intent, ports({ provider, alreadySent: new Set([intent.idempotencyKey]) }));
    expect(outcomes[0]?.result).toBe('suppressed');
    expect(provider.deliveryCount()).toBe(0);
  });

  it('falls through to the next channel when the first is opted out', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydrator({ preferences: { channels: [{ channel: 'whatsapp', state: 'opted_out' }] } }) }),
    );
    expect(outcomes.map((o) => o.result)).toEqual(['suppressed', 'delivered']);
    expect(provider.deliveries()[0]?.channel).toBe('email');
  });

  it('defers inside quiet hours and sends nothing', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({
        provider,
        nowMinuteOfDay: 120,
        hydrator: hydrator({ preferences: { channels: [], quietHours: { startMinuteOfDay: 1320, endMinuteOfDay: 420 } }, channelOrder: ['whatsapp'] }),
      }),
    );
    expect(outcomes).toEqual([{ result: 'deferred', kind: 'invoice_issued', channel: 'whatsapp', untilMinuteOfDay: 420 }]);
    expect(provider.deliveryCount()).toBe(0);
  });

  it('turns a transient provider failure into a retry, not a loss', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_TIMEOUT'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydrator({ channelOrder: ['whatsapp'] }) }));
    expect(outcomes).toEqual([{ result: 'failed', kind: 'invoice_issued', channel: 'whatsapp', next: { step: 'retry', attempts: 1, afterSeconds: 10 } }]);
  });

  it('dead-letters a terminal provider failure immediately', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_AUTH_FAILED'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydrator({ channelOrder: ['whatsapp'] }) }));
    expect(outcomes).toEqual([
      { result: 'failed', kind: 'invoice_issued', channel: 'whatsapp', next: { step: 'dead', attempts: 1, reason: 'PROVIDER_AUTH_FAILED' } },
    ]);
  });

  it('classifies an adapter THROW instead of letting it escape', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], throwOn: [Object.assign(new Error('rate limit reached'), { status: 429 })] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydrator({ channelOrder: ['whatsapp'] }) }));
    expect(outcomes[0]).toMatchObject({ result: 'failed', next: { step: 'retry', attempts: 1 } });
  });

  it('refuses when hydration cannot complete — never a blank notification', async () => {
    const outcomes = await dispatchIntent(intentOf(), ports({ hydrator: hydrator({}, false) }));
    expect(outcomes).toEqual([{ result: 'refused', kind: 'invoice_issued', code: 'notification.hydration_incomplete' }]);
  });

  it('suppresses with the refusal code when a required variable is missing', async () => {
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ hydrator: hydrator({ vars: { customerName: { kind: 'text', text: 'أشرف' } }, channelOrder: ['whatsapp'] }) }),
    );
    expect(outcomes).toEqual([{ result: 'suppressed', kind: 'invoice_issued', channel: 'whatsapp', code: 'notification.template_variable_missing' }]);
  });

  it('refuses a channel order the kind does not allow at all', async () => {
    const outcomes = await dispatchIntent(intentOf(), ports({ hydrator: hydrator({ channelOrder: ['sms' as Channel] }) }));
    expect(outcomes).toEqual([{ result: 'refused', kind: 'invoice_issued', code: 'notification.channel_not_supported_for_kind' }]);
  });

  it('suppresses an unaddressable recipient rather than calling the provider', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydrator({ recipient: { businessId: 'b-1', customerId: 'c-1', locale: 'ar' }, channelOrder: ['whatsapp'] }) }),
    );
    expect(outcomes).toEqual([{ result: 'suppressed', kind: 'invoice_issued', channel: 'whatsapp', code: 'notification.address_missing' }]);
    expect(provider.deliveryCount()).toBe(0);
  });

  it('suppresses a malformed phone number (E.164 only)', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydrator({ recipient: { businessId: 'b-1', locale: 'ar', phoneE164: '0591234567' }, channelOrder: ['whatsapp'] }) }),
    );
    expect(outcomes).toEqual([{ result: 'suppressed', kind: 'invoice_issued', channel: 'whatsapp', code: 'notification.address_invalid' }]);
    expect(provider.deliveryCount()).toBe(0);
  });

  it('renders in the recipient locale, not a default one', async () => {
    const provider = new FakeNotificationProvider({ channels: ['email'] });
    await dispatchIntent(
      intentOf(),
      ports({ provider, hydrator: hydrator({ recipient: { businessId: 'b-1', locale: 'tr', email: 'musteri@example.com' }, channelOrder: ['email'] }) }),
    );
    expect(provider.deliveries()[0]?.rendered.body).toContain('faturanız oluşturuldu');
  });
});
