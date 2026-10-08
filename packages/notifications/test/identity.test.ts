import { describe, expect, it } from 'vitest';
import { attemptIdentity, obligationKey, type NotificationOrigin } from '../src/identity';

const event: NotificationOrigin = { source: 'event', eventId: 'ev-1' };
const schedule: NotificationOrigin = { source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: '2026-09' };

describe('TL-P8-R1 — the two identities are never the same string', () => {
  it('an obligation names origin, kind AND recipient', () => {
    expect(obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' })).toBe('event:ev-1|invoice_issued|customer:c-1');
    expect(obligationKey(schedule, 'customer_statement', { kind: 'customer', customerId: 'c-1' })).toBe(
      'schedule:p8.statement.monthly:2026-09|customer_statement|customer:c-1',
    );
  });

  it('every axis changes the obligation: origin, kind, recipient kind, recipient id', () => {
    const base = obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const keys = new Set([
      base,
      obligationKey({ source: 'event', eventId: 'ev-2' }, 'invoice_issued', { kind: 'customer', customerId: 'c-1' }),
      obligationKey(event, 'payment_receipt', { kind: 'customer', customerId: 'c-1' }),
      obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'c-2' }),
      obligationKey(event, 'invoice_issued', { kind: 'user', userId: 'c-1' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('a customer and a staff user sharing an id are different obligations', () => {
    expect(obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'x' })).not.toBe(
      obligationKey(event, 'invoice_issued', { kind: 'user', userId: 'x' }),
    );
  });

  it('is stable: the same facts give the same key, with no clock and no randomness', () => {
    const a = obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    const b = obligationKey({ source: 'event', eventId: 'ev-1' }, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    expect(a).toBe(b);
  });

  it('a schedule re-run of the same occurrence is the same obligation; a new occurrence is not', () => {
    const september = obligationKey(schedule, 'customer_statement', { kind: 'customer', customerId: 'c-1' });
    const again = obligationKey({ source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: '2026-09' }, 'customer_statement', {
      kind: 'customer',
      customerId: 'c-1',
    });
    const october = obligationKey({ source: 'schedule', scheduleId: 'p8.statement.monthly', occurrenceKey: '2026-10' }, 'customer_statement', {
      kind: 'customer',
      customerId: 'c-1',
    });
    expect(again).toBe(september);
    expect(october).not.toBe(september);
  });

  it('an attempt identity extends an obligation with channel and attempt number', () => {
    const o = obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    expect(attemptIdentity(o, 'whatsapp', 1)).toBe('event:ev-1|invoice_issued|customer:c-1#whatsapp#1');
    expect(attemptIdentity(o, 'whatsapp', 2)).not.toBe(attemptIdentity(o, 'whatsapp', 1));
    expect(attemptIdentity(o, 'email', 1)).not.toBe(attemptIdentity(o, 'whatsapp', 1));
    // And an attempt identity is never equal to the obligation it belongs to.
    expect(attemptIdentity(o, 'whatsapp', 1)).not.toBe(o);
  });

  it('refuses an attempt number that is not a positive integer', () => {
    const o = obligationKey(event, 'invoice_issued', { kind: 'customer', customerId: 'c-1' });
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => attemptIdentity(o, 'sms', n)).toThrow();
  });
});
