import { describe, expect, it } from 'vitest';
import { attemptIdentity, deliveryKey, obligationKey, type NotificationOrigin } from '../src/identity';

const event: NotificationOrigin = { source: 'event', eventId: 'ev-1' };
const schedule: NotificationOrigin = { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: '2026-09' };

describe('TL-P8-R2 — three identities, and no two of them are the same string', () => {
  it('an obligation names origin, kind AND recipient', () => {
    expect(obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' })).toBe('b-1|event:ev-1|invoice_issued|customer:c-1');
    expect(obligationKey('b-1', schedule, 'customer_statement', { kind: 'customer', customerId: 'c-1' })).toBe(
      'b-1|schedule:p8.statement.monthly:2026-09|customer_statement|customer:c-1',
    );
  });

  it('every axis changes the obligation: origin, kind, recipient kind, recipient id', () => {
    const base = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const keys = new Set([
      base,
      obligationKey('b-1', { source: 'event', eventId: 'ev-2' }, 'invoice_issued', { kind: 'customer', customerId: 'c-1' }),
      obligationKey('b-1', event, 'payment_receipt', { kind: 'customer', customerId: 'c-1' }),
      obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-2' }),
      obligationKey('b-1', event, 'invoice_issued', { kind: 'user', userId: 'c-1' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('a customer and a staff user sharing an id are different obligations', () => {
    expect(obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'x' })).not.toBe(
      obligationKey('b-1', event, 'invoice_issued', { kind: 'user', userId: 'x' }),
    );
  });

  it('is stable: the same facts give the same key, with no clock and no randomness', () => {
    const a = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const b = obligationKey('b-1', { source: 'event', eventId: 'ev-1' }, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    expect(a).toBe(b);
  });

  it('a schedule re-run of the same occurrence is the same obligation; a new occurrence is not', () => {
    const september = obligationKey('b-1', schedule, 'customer_statement', { kind: 'customer', customerId: 'c-1' });
    const again = obligationKey('b-1', { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: '2026-09' }, 'customer_statement', {
      kind: 'customer',
      customerId: 'c-1',
    });
    const october = obligationKey('b-1', { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: '2026-10' }, 'customer_statement', {
      kind: 'customer',
      customerId: 'c-1',
    });
    expect(again).toBe(september);
    expect(october).not.toBe(september);
  });

  it('a logical delivery extends an obligation with the channel, and separates channels', () => {
    const o = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    expect(deliveryKey(o, 'whatsapp')).toBe('b-1|event:ev-1|invoice_issued|customer:c-1::whatsapp');
    expect(deliveryKey(o, 'email')).not.toBe(deliveryKey(o, 'whatsapp'));
    expect(deliveryKey(o, 'whatsapp')).not.toBe(o);
  });

  it('PART 42 — the logical delivery key is INVARIANT across attempts of the same send', () => {
    const o = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const first = deliveryKey(o, 'whatsapp', 'p8_invoice_issued_ar');
    const afterARetry = deliveryKey(o, 'whatsapp', 'p8_invoice_issued_ar');
    expect(afterARetry).toBe(first);
    // ...and the attempt keys built on it are NOT invariant, which is exactly
    // why the attempt key may never be the provider's idempotency key.
    expect(attemptIdentity(first, 2)).not.toBe(attemptIdentity(first, 1));
  });

  it('a stable provider/template context separates deliveries; an empty one is omitted, never silently varied', () => {
    const o = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    expect(deliveryKey(o, 'whatsapp', 'tpl_ar')).not.toBe(deliveryKey(o, 'whatsapp', 'tpl_en'));
    expect(deliveryKey(o, 'whatsapp', '')).toBe(deliveryKey(o, 'whatsapp'));
    expect(deliveryKey(o, 'whatsapp', undefined)).toBe(deliveryKey(o, 'whatsapp'));
  });

  it('an attempt identity extends a LOGICAL DELIVERY with the attempt number, and is never the delivery itself', () => {
    const o = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const d = deliveryKey(o, 'whatsapp');
    expect(attemptIdentity(d, 1)).toBe('b-1|event:ev-1|invoice_issued|customer:c-1::whatsapp#1');
    expect(attemptIdentity(d, 1)).not.toBe(d);
    expect(attemptIdentity(d, 1)).not.toBe(o);
  });

  it('refuses an attempt number that is not a positive integer', () => {
    const d = deliveryKey(obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' }), 'sms');
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => attemptIdentity(d, n)).toThrow();
  });

  it('the three layers are three distinct strings for one owed notification', () => {
    const o = obligationKey('b-1', event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const d = deliveryKey(o, 'whatsapp', 'tpl_ar');
    const a = attemptIdentity(d, 1);
    expect(new Set([o, d, a]).size).toBe(3);
  });
});
