import { describe, expect, it } from 'vitest';
import type {
  CustomerAgingDto,
  CustomerCommandResultDto,
  CustomerCreateRequestDto,
  CustomerOpenInvoiceDto,
  CustomerReceivableDto,
  DocumentSequenceDto,
  InvoiceDto,
  InvoiceItemDto,
  InvoiceSettlementDto,
} from '../src';

/**
 * P4-S1 — the customer and invoice contract surface.
 *
 * These are contract assertions, not behaviour: the value of each check is that
 * it fails to COMPILE the day a money field becomes a JSON number, a credit
 * limit appears on a customer, a price-override field appears on an invoice
 * line, or a stored settlement figure appears on an invoice.
 */

describe('every money field is an integer count of minor units, as a string', () => {
  it('holds on an invoice and its items', () => {
    const item: InvoiceItemDto = {
      itemId: '11111111-1111-4111-8111-111111111111',
      lineNo: 1,
      productId: '22222222-2222-4222-8222-222222222222',
      variantId: null,
      nameSnapshot: 'Sugar 1kg',
      quantity: '2.0000',
      unitPriceTxnMinor: '1250.0000000000',
      grossTxnMinor: '2500',
      discountTxnMinor: '250',
      netTxnMinor: '2250',
      taxMinor: '0',
      baseShareMinor: '2250',
    };
    const invoice: InvoiceDto = {
      id: '33333333-3333-4333-8333-333333333333',
      saleId: '44444444-4444-4444-8444-444444444444',
      customerId: null,
      branchId: '55555555-5555-4555-8555-555555555555',
      documentKind: 'invoice',
      documentNumber: 'INV-2026-000001',
      numberSeq: '1',
      issueDate: '2026-09-30',
      dueDate: null,
      currency: 'JOD',
      status: 'open',
      notes: null,
      subtotalTxnMinor: '2500',
      discountTxnMinor: '250',
      taxMinor: '0',
      totalTxnMinor: '2250',
      // Wider than 2^53: a JSON number would round it, a string does not.
      totalBaseMinor: '9007199254740993',
      rate: { rateId: null, rate: '1', source: 'base', at: '2026-09-30T10:00:00Z' },
      customerSnapshot: null,
      voidedAt: null,
      createdAt: '2026-09-30T10:00:00Z',
      items: [item],
    };
    expect(typeof invoice.totalBaseMinor).toBe('string');
    expect(BigInt(invoice.totalBaseMinor)).toBe(9007199254740993n);
    // The whole of the Phase 4 tax surface (P4-AL-44): a structural zero.
    expect(invoice.taxMinor).toBe('0');
    expect(invoice.items[0]?.taxMinor).toBe('0');
    // Discount only (OD-P4-02 OPTION A): a reduction is a discount, and the
    // line carries no override field to set instead.
    expect(invoice.items[0]?.discountTxnMinor).toBe('250');
  });

  it('holds on a derived settlement, whose identity is checked and not stored', () => {
    const settlement: InvoiceSettlementDto = {
      invoiceId: '33333333-3333-4333-8333-333333333333',
      currency: 'JOD',
      baseCurrency: 'JOD',
      totalTxnMinor: '2250',
      totalBaseMinor: '2250',
      paidTxnMinor: '1000',
      paidBaseMinor: '1000',
      outstandingTxnMinor: '1250',
      outstandingBaseMinor: '1250',
      settlementState: 'partial',
    };
    // P4-AL-26: `paid + outstanding = total` is a derived identity a
    // reconciliation check asserts — never a row CHECK over two stored columns.
    expect(BigInt(settlement.paidTxnMinor) + BigInt(settlement.outstandingTxnMinor)).toBe(BigInt(settlement.totalTxnMinor));
  });

  it('holds on a customer receivable and its aging', () => {
    const receivable: CustomerReceivableDto = {
      customerId: '66666666-6666-4666-8666-666666666666',
      baseMinor: '-1250',
      baseCurrency: 'JOD',
      byCurrency: [{ currency: 'USD', txnMinor: '1764' }],
    };
    const aging: CustomerAgingDto = {
      customerId: receivable.customerId,
      asOf: '2026-09-30',
      baseCurrency: 'JOD',
      bucketDays: [30, 60, 90],
      buckets: [{ label: '0-30', fromDays: 0, toDays: 30, baseMinor: '1250', byCurrency: [], invoiceCount: 1 }],
      totalBaseMinor: '1250',
    };
    // A contra receivable is negative and is never clamped to zero: a customer
    // in credit is a fact, not an error.
    expect(BigInt(receivable.baseMinor) < 0n).toBe(true);
    // The as-of date and the boundaries are inputs echoed back, so the answer
    // is self-describing and no clock was read to produce it.
    expect(aging.asOf).toBe('2026-09-30');
    expect(aging.bucketDays).toEqual([30, 60, 90]);
  });
});

describe('the customer contract states no derived truth (P4-AL-06, OD-P4-03)', () => {
  it('a customer command result carries the stored row, a replay flag and a trace — and no balance', () => {
    const result: CustomerCommandResultDto = {
      id: '66666666-6666-4666-8666-666666666666',
      name: 'Abu Ahmad',
      phone: null,
      email: null,
      notes: null,
      status: 'active',
      revision: 1,
      createdAt: '2026-09-30T10:00:00Z',
      updatedAt: '2026-09-30T10:00:00Z',
      contacts: [],
      replayed: true,
      businessTransactionId: '77777777-7777-4777-8777-777777777777',
    };
    const keys = Object.keys(result);
    for (const forbidden of ['balance', 'amountDue', 'outstanding', 'settled', 'paid', 'creditLimit']) {
      expect(keys).not.toContain(forbidden);
    }
    // P4-AL-30: the document's own UUID plus the stored intent digest are the
    // idempotency mechanism, so no request or response names an idempotency key.
    expect(keys).not.toContain('idempotencyKey');
  });

  it('a create request names the customer id as its own idempotency key', () => {
    const request: CustomerCreateRequestDto = { customerId: '66666666-6666-4666-8666-666666666666', name: 'Abu Ahmad' };
    expect(Object.keys(request)).toEqual(['customerId', 'name']);
  });
});

describe('numbering reports what was committed, not a counter (P4-AL-31)', () => {
  it('a sequence row carries the lock and the format, and the highest committed ordinal', () => {
    const sequence: DocumentSequenceDto = {
      documentKind: 'invoice',
      period: '2026',
      format: 'INV-2026-{seq:6}',
      highestCommittedSeq: '1',
    };
    const keys = Object.keys(sequence);
    // No counter column, no PostgreSQL sequence, and no published "next number".
    for (const forbidden of ['currentValue', 'nextSeq', 'nextNumber', 'counter']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(typeof sequence.highestCommittedSeq).toBe('string');
  });

  it('an open-invoice row derives its settlement state and never reads a status for it', () => {
    const open: CustomerOpenInvoiceDto = {
      invoiceId: '33333333-3333-4333-8333-333333333333',
      documentKind: 'invoice',
      documentNumber: 'INV-2026-000001',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      currency: 'JOD',
      totalTxnMinor: '2250',
      outstandingTxnMinor: '1250',
      outstandingBaseMinor: '1250',
      settlementState: 'partial',
      daysPastDue: 30,
    };
    expect(open.settlementState).toBe('partial');
    expect(Object.keys(open)).not.toContain('status');
  });
});
