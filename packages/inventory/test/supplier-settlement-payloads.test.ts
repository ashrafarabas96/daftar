import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InvplS6Vectors } from '../scripts/s6-vector-cases';
import { InventoryError } from '../src/errors';
import {
  canonicalInventoryIntent,
  canonicalInventoryPayload,
  INVENTORY_PAYLOAD_SCHEMAS,
  inventoryIntentSchema,
  inventoryIntentSha256,
  inventoryPayloadSha256,
  type InventoryPayloadField,
} from '../src/payload';
import {
  SUPPLIER_PAYMENT_MAX_ALLOCATIONS,
  supplierAllocateCreditIntentSha256,
  supplierAllocateCreditPayload,
  supplierPayIntentSha256,
  supplierPayPayload,
  supplierReceiveRefundIntentSha256,
  supplierReceiveRefundPayload,
  type SupplierAllocateCreditPayloadInput,
  type SupplierPayPayloadAllocation,
  type SupplierPayPayloadInput,
  type SupplierReceiveRefundPayloadInput,
} from '../src/supplier-settlement-payloads';

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'invpl-s6-vectors.json'), 'utf8')) as InvplS6Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const id = (n: number): string => `a1b2c3d4-0006-4a00-8a00-${n.toString(16).padStart(12, '0')}`;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

function typed(f: { type: string; value: string | null }): InventoryPayloadField {
  if (f.value === null) return { kind: 'null' };
  switch (f.type) {
    case 'uuid':
      return { kind: 'uuid', value: f.value };
    case 'integer':
      return { kind: 'integer', value: BigInt(f.value) };
    case 'code':
      return { kind: 'code', value: f.value };
    case 'boolean':
      return { kind: 'boolean', value: f.value === 'true' };
  }
  throw new Error(`unknown vector type ${f.type}`);
}

const allocation = (n: number, over: Partial<SupplierPayPayloadAllocation> = {}): SupplierPayPayloadAllocation => ({
  allocationId: id(0x100 + n),
  purchaseId: id(0x200 + n),
  warehouseId: id(0x300),
  purchaseCurrency: 'ILS',
  paymentAmountMinor: 1000n,
  paymentBaseMinor: 1000n,
  appliedMinor: 1000n,
  releasedBeforeMinor: 0n,
  carryingReleasedMinor: 1000n,
  apDustBaseMinor: 0n,
  realizedMinor: 0n,
  ...over,
});

const pay = (over: Partial<SupplierPayPayloadInput> = {}): SupplierPayPayloadInput => ({
  tenantId: T,
  businessId: B,
  paymentId: id(1),
  supplierId: id(2),
  paymentMethodId: id(3),
  postingAccountId: id(4),
  paymentDate: '2026-09-27',
  currency: 'ILS',
  amountMinor: 2000n,
  reference: null,
  rate: { rateId: null, rateR10: 10n ** 10n, source: 'base', rateAtEpochSeconds: 1790467200n },
  baseAmountMinor: 2000n,
  allocations: [allocation(1), allocation(2)],
  ...over,
});

const allocate = (over: Partial<SupplierAllocateCreditPayloadInput> = {}): SupplierAllocateCreditPayloadInput => ({
  tenantId: T,
  businessId: B,
  allocationId: id(5),
  creditNoteId: id(6),
  purchaseId: id(7),
  warehouseId: id(8),
  allocationDate: '2026-09-28',
  creditCurrency: 'USD',
  consumedMinor: 5000n,
  remainingBeforeMinor: 10000n,
  creditReleasedMinor: 18000n,
  creditDustBaseMinor: 0n,
  purchaseCurrency: 'USD',
  appliedMinor: 5000n,
  apReleasedBeforeMinor: 0n,
  apReleasedMinor: 18500n,
  apDustBaseMinor: 0n,
  realizedMinor: -500n,
  ...over,
});

const refund = (over: Partial<SupplierReceiveRefundPayloadInput> = {}): SupplierReceiveRefundPayloadInput => ({
  tenantId: T,
  businessId: B,
  refundId: id(9),
  creditNoteId: id(6),
  paymentMethodId: id(3),
  postingAccountId: id(4),
  refundDate: '2026-09-29',
  sourceCurrency: 'USD',
  consumedMinor: 10000n,
  remainingBeforeMinor: 10000n,
  sourceReleasedMinor: 36000n,
  sourceDustBaseMinor: 0n,
  receiptCurrency: 'EUR',
  receiptAmountMinor: 9000n,
  rate: { rateId: id(10), rateR10: 41000000000n, source: 'manual', rateAtEpochSeconds: 1790640000n },
  receiptBaseMinor: 36900n,
  realizedMinor: 900n,
  reference: 'Refund 0929',
  ...over,
});

describe('invpl/1 P3-S6 settlement kinds — the shared vectors', () => {
  for (const v of vectors.cases.filter((c) => !c.opCode.startsWith('payment.'))) {
    it(`${v.id}: payload and intent bytes and digests match the recorded vector`, () => {
      const payloadFields = v.payload.fields.map(typed);
      expect(canonicalInventoryPayload(v.opCode, v.tenantId, v.businessId, payloadFields).toString('hex')).toBe(v.payload.canonicalHex);
      expect(inventoryPayloadSha256(v.opCode, v.tenantId, v.businessId, payloadFields)).toBe(v.payload.sha256);
      const intentFields = v.intent.fields.map(typed);
      expect(canonicalInventoryIntent(v.opCode, v.tenantId, v.businessId, intentFields).toString('hex')).toBe(v.intent.canonicalHex);
      expect(inventoryIntentSha256(v.opCode, v.tenantId, v.businessId, intentFields)).toBe(v.intent.sha256);
      expect(v.intent.sha256).not.toBe(v.payload.sha256);
    });
  }

  it('the routine arguments restate the payload: every allocation array has allocation_count entries; a NULL reference and rate id are NULL', () => {
    for (const v of vectors.cases.filter((c) => c.opCode === 'supplier.pay')) {
      const count = Number(v.payload.fields.find((f) => f.name === 'allocation_count')?.value);
      for (const [k, a] of Object.entries(v.routine.args)) if (Array.isArray(a)) expect(a, `${v.id} ${k}`).toHaveLength(count);
    }
    for (const v of vectors.cases.filter((c) => c.opCode === 'supplier.pay' || c.opCode === 'supplier.receive_refund')) {
      expect(v.routine.args['p_reference'] === null, v.id).toBe(v.payload.fields.find((f) => f.name === 'reference_w1')?.value === null);
      expect(v.routine.args['p_rate_id'] === null, v.id).toBe(v.payload.fields.find((f) => f.name === 'rate_id')?.value === null);
    }
  });
});

describe('settlement schemas and intents (A-16)', () => {
  const words = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix}_w${i + 1}`);

  it('supplier.pay: the header, then one group per allocation counted by allocation_count', () => {
    const s = INVENTORY_PAYLOAD_SCHEMAS['supplier.pay'];
    expect(s.map((f) => f.name)).toEqual([
      'payment_id',
      'supplier_id',
      'payment_method_id',
      'posting_account_id',
      'payment_date',
      'currency',
      'amount',
      'rate_id',
      'rate',
      'rate_source',
      'rate_at',
      'base_amount',
      ...words('reference'),
      'allocation_count',
    ]);
    expect(s.repeat?.countField).toBe('allocation_count');
    expect(s.repeat?.fields.map((f) => f.name)).toEqual([
      'allocation_id',
      'purchase_id',
      'warehouse_id',
      'purchase_currency',
      'payment_amount',
      'payment_base',
      'applied',
      'released_before',
      'carrying_released',
      'ap_dust',
      'realized',
    ]);
    const i = inventoryIntentSchema('supplier.pay');
    expect(i.map((f) => f.name)).toEqual([
      'payment_id',
      'supplier_id',
      'payment_method_id',
      'payment_date',
      'currency',
      'amount',
      ...words('reference'),
      'allocation_count',
    ]);
    expect(i.repeat?.countField).toBe('allocation_count');
    expect(i.repeat?.fields.map((f) => f.name)).toEqual(['allocation_id', 'purchase_id', 'payment_amount', 'applied']);
  });

  it('supplier.allocate_credit and supplier.receive_refund: the fields in order and their intents', () => {
    expect(INVENTORY_PAYLOAD_SCHEMAS['supplier.allocate_credit'].map((f) => f.name)).toEqual([
      'allocation_id',
      'credit_note_id',
      'purchase_id',
      'warehouse_id',
      'allocation_date',
      'credit_currency',
      'consumed',
      'remaining_before',
      'credit_released',
      'credit_dust',
      'purchase_currency',
      'applied',
      'ap_released_before',
      'ap_released',
      'ap_dust',
      'realized',
    ]);
    expect(inventoryIntentSchema('supplier.allocate_credit').map((f) => f.name)).toEqual([
      'allocation_id',
      'credit_note_id',
      'purchase_id',
      'allocation_date',
      'consumed',
      'applied',
    ]);
    expect(INVENTORY_PAYLOAD_SCHEMAS['supplier.receive_refund'].map((f) => f.name)).toEqual([
      'refund_id',
      'credit_note_id',
      'payment_method_id',
      'posting_account_id',
      'refund_date',
      'source_currency',
      'consumed',
      'remaining_before',
      'source_released',
      'source_dust',
      'receipt_currency',
      'receipt_amount',
      'rate_id',
      'rate',
      'rate_source',
      'rate_at',
      'receipt_base',
      'realized',
      ...words('reference'),
    ]);
    expect(inventoryIntentSchema('supplier.receive_refund').map((f) => f.name)).toEqual([
      'refund_id',
      'credit_note_id',
      'payment_method_id',
      'refund_date',
      'consumed',
      'receipt_currency',
      'receipt_amount',
      ...words('reference'),
    ]);
  });

  it('the intent is computable before any state read and ignores every derived amount', () => {
    const p = pay();
    const intent = supplierPayIntentSha256(p);
    expect(supplierPayPayload(p).intentSha256).toBe(intent);
    const moved = pay({
      postingAccountId: id(40),
      rate: { rateId: null, rateR10: 10n ** 10n, source: 'base', rateAtEpochSeconds: 1790467200n },
      allocations: [allocation(1, { warehouseId: id(0x301) }), allocation(2, { releasedBeforeMinor: 100n })],
    });
    expect(supplierPayPayload(moved).intentSha256).toBe(intent);
    expect(supplierPayPayload(moved).payload.sha256).not.toBe(supplierPayPayload(p).payload.sha256);
    for (const other of [pay({ paymentDate: '2026-09-26' }), pay({ reference: 'X' }), pay({ supplierId: id(20) })]) {
      expect(supplierPayIntentSha256(other)).not.toBe(intent);
    }
    const a = allocate();
    expect(supplierAllocateCreditPayload(a).intentSha256).toBe(supplierAllocateCreditIntentSha256(a));
    expect(supplierAllocateCreditPayload(allocate({ remainingBeforeMinor: 9000n })).intentSha256).toBe(supplierAllocateCreditIntentSha256(a));
    const r = refund();
    expect(supplierReceiveRefundPayload(r).intentSha256).toBe(supplierReceiveRefundIntentSha256(r));
    expect(supplierReceiveRefundPayload(refund({ postingAccountId: id(41) })).intentSha256).toBe(supplierReceiveRefundIntentSha256(r));
  });
});

describe('supplierPayPayload — refuses before the signature', () => {
  it('allocations: 1..50, distinct ids and purchases, positive amounts, fully allocated (TL-3)', () => {
    expect(codeOf(() => supplierPayPayload(pay()))).toBe('accepted');
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [] })))).toBe('supplier_payment.allocations_invalid');
    const many = Array.from({ length: SUPPLIER_PAYMENT_MAX_ALLOCATIONS + 1 }, (_, i) => allocation(i));
    expect(codeOf(() => supplierPayPayload(pay({ allocations: many, amountMinor: 51000n, baseAmountMinor: 51000n })))).toBe(
      'supplier_payment.allocations_invalid',
    );
    const fifty = many.slice(0, SUPPLIER_PAYMENT_MAX_ALLOCATIONS);
    expect(codeOf(() => supplierPayPayload(pay({ allocations: fifty, amountMinor: 50000n, baseAmountMinor: 50000n })))).toBe('accepted');
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [allocation(1), allocation(1)] })))).toBe('supplier_payment.allocations_invalid');
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [allocation(1), allocation(2, { purchaseId: id(0x201) })] })))).toBe(
      'supplier_payment.allocations_invalid',
    );
    expect(codeOf(() => supplierPayPayload(pay({ amountMinor: 2001n })))).toBe('supplier_payment.allocations_invalid');
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [allocation(1), allocation(2, { appliedMinor: 0n })] })))).toBe(
      'supplier_payment.allocations_invalid',
    );
    expect(codeOf(() => supplierPayPayload(pay({ reference: ' x ' })))).toBe('supplier_payment.allocations_invalid');
    expect(codeOf(() => supplierPayPayload(pay({ reference: 'x'.repeat(101) })))).toBe('supplier_payment.allocations_invalid');
  });

  it('the row CHECKs: realized = pb - rel, the same-currency equality, the header base', () => {
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [allocation(1), allocation(2, { realizedMinor: 1n })] })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [allocation(1), allocation(2, { appliedMinor: 999n })] })))).toBe(
      'supplier_payment.amount_mismatch',
    );
    expect(codeOf(() => supplierPayPayload(pay({ baseAmountMinor: 1999n })))).toBe('inventory.payload_invalid');
    // Cross-currency: the two amounts are the merchant's; only realized binds them.
    const usd = allocation(2, { purchaseCurrency: 'USD', appliedMinor: 270n, carryingReleasedMinor: 972n, realizedMinor: 28n, apDustBaseMinor: 0n });
    expect(codeOf(() => supplierPayPayload(pay({ allocations: [allocation(1), usd] })))).toBe('accepted');
  });

  it('the rate: domestic is exactly 1 with no registry row; foreign is positive with one', () => {
    expect(codeOf(() => supplierPayPayload(pay({ rate: { rateId: id(10), rateR10: 10n ** 10n, source: 'base', rateAtEpochSeconds: 0n } })))).toBe(
      'inventory.payload_invalid',
    );
    expect(codeOf(() => supplierPayPayload(pay({ rate: { rateId: null, rateR10: 37000000000n, source: 'manual', rateAtEpochSeconds: 0n } })))).toBe(
      'inventory.payload_invalid',
    );
    expect(codeOf(() => supplierPayPayload(pay({ currency: 'usd' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierPayPayload(pay({ paymentDate: '2026-02-30' })))).toBe('inventory.payload_invalid');
  });
});

describe('supplierAllocateCreditPayload / supplierReceiveRefundPayload — refuse before the signature', () => {
  it('a credit allocation', () => {
    expect(codeOf(() => supplierAllocateCreditPayload(allocate()))).toBe('accepted');
    expect(codeOf(() => supplierAllocateCreditPayload(allocate({ remainingBeforeMinor: 4999n })))).toBe('supplier_credit_allocation.amount_exceeds_credit');
    expect(codeOf(() => supplierAllocateCreditPayload(allocate({ realizedMinor: 500n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierAllocateCreditPayload(allocate({ appliedMinor: 4999n })))).toBe('supplier_credit_allocation.amount_mismatch');
    expect(codeOf(() => supplierAllocateCreditPayload(allocate({ consumedMinor: 0n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierAllocateCreditPayload(allocate({ purchaseCurrency: 'EUR', appliedMinor: 4000n })))).toBe('accepted');
  });

  it('a refund', () => {
    expect(codeOf(() => supplierReceiveRefundPayload(refund()))).toBe('accepted');
    expect(codeOf(() => supplierReceiveRefundPayload(refund({ remainingBeforeMinor: 9999n })))).toBe('supplier_refund.amount_exceeds_credit');
    expect(codeOf(() => supplierReceiveRefundPayload(refund({ realizedMinor: -900n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReceiveRefundPayload(refund({ receiptCurrency: 'USD', receiptAmountMinor: 9000n })))).toBe('supplier_refund.amount_mismatch');
    expect(codeOf(() => supplierReceiveRefundPayload(refund({ receiptBaseMinor: 0n, realizedMinor: -36000n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReceiveRefundPayload(refund({ reference: null })))).toBe('accepted');
  });
});
