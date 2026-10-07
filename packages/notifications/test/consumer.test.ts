import { describe, expect, it } from 'vitest';
import { planFromOutboxRow, type OutboxRow } from '../src/consumer';
import { NotificationRefusal } from '../src/errors';

const saleRow: OutboxRow = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'sale.committed.v1',
  payload: { businessId: 'b-1', saleId: 's-1', invoiceId: 'i-1', businessTransactionId: 't-1' },
};

describe('outbox consumer', () => {
  it('maps a live sale commit to the invoice notification', () => {
    const plan = planFromOutboxRow(saleRow);
    expect(plan.unmapped).toBe(false);
    expect(plan.intents).toHaveLength(1);
    const intent = plan.intents[0];
    expect(intent?.kind).toBe('invoice_issued');
    expect(intent?.businessId).toBe('b-1');
    expect(intent?.subjectRefs).toEqual({ saleId: 's-1', invoiceId: 'i-1', businessTransactionId: 't-1' });
  });

  it('derives the idempotency key from the event row, so a repeat is the same key', () => {
    const first = planFromOutboxRow(saleRow).intents[0];
    const second = planFromOutboxRow({ ...saleRow, payload: { ...saleRow.payload } }).intents[0];
    expect(first?.idempotencyKey).toBe('11111111-1111-4111-8111-111111111111:invoice_issued');
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });

  it('ignores the events notifications do not subscribe to, without erroring', () => {
    for (const type of ['accounting.entry.posted', 'inventory.stocktake_finalized.v1', 'supplier.paid.v1']) {
      const plan = planFromOutboxRow({ id: 'e-1', type, payload: { businessId: 'b-1' } });
      expect(plan.unmapped, type).toBe(true);
      expect(plan.intents).toEqual([]);
    }
  });

  it('refuses an event with no businessId — an untenanted notification is a leak', () => {
    try {
      planFromOutboxRow({ ...saleRow, payload: { saleId: 's-1' } });
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(NotificationRefusal);
      if (e instanceof NotificationRefusal) {
        expect(e.code).toBe('notification.event_payload_invalid');
        expect(e.subject).toBe('sale.committed.v1/businessId');
      }
    }
  });

  it('refuses a businessId of the wrong type rather than stringifying it', () => {
    for (const bad of [42, null, {}, []]) {
      expect(() => planFromOutboxRow({ ...saleRow, payload: { ...saleRow.payload, businessId: bad } })).toThrow(NotificationRefusal);
    }
  });

  it('maps the customer payment event with its allocation ids left to the hydrator', () => {
    const plan = planFromOutboxRow({
      id: 'e-2',
      type: 'customer.payment_collected.v1',
      payload: { businessId: 'b-1', paymentId: 'p-1', customerId: 'c-1', allocationIds: ['a-1', 'a-2'], creditId: null, businessTransactionId: 't-2' },
    });
    expect(plan.intents[0]?.kind).toBe('payment_receipt');
    // Non-string payload values (the id array, the null credit) are not coerced
    // into refs: the hydrator reads them from canonical rows, by paymentId.
    expect(plan.intents[0]?.subjectRefs).toEqual({ paymentId: 'p-1', customerId: 'c-1', businessTransactionId: 't-2' });
  });
});
