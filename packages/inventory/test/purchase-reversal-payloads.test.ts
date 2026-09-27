import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InvplS5Vectors } from '../scripts/s5-vector-cases';
import { InventoryError } from '../src/errors';
import { toQ4 } from '../src/movement-payloads';
import { INVENTORY_PAYLOAD_SCHEMAS, inventoryIntentSchema } from '../src/payload';
import {
  purchaseReversalReasonWords,
  purchaseReverseIntentSha256,
  purchaseReversePayload,
  reversalLineVerdict,
  type PurchaseReversePayloadInput,
} from '../src/purchase-reversal-payloads';
import { averageUnitCost, EMPTY_STOCK_STATE, simulateMovement, type StockState } from '../src/valuation';

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'invpl-s5-vectors.json'), 'utf8')) as InvplS5Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const PUR = 'a1b2c3d4-0002-4a00-8a00-000000000002';
const ENTRY = 'a1b2c3d4-0007-4a00-8a00-000000000007';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const L1 = 'b0000000-0000-4000-8000-000000000001';
const L2 = 'b0000000-0000-4000-8000-000000000002';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

const rev = (over: Partial<PurchaseReversePayloadInput> = {}): PurchaseReversePayloadInput => ({
  tenantId: T,
  businessId: B,
  purchaseId: PUR,
  warehouseId: W1,
  reversalDate: '2026-09-27',
  reason: 'Received against the wrong supplier',
  originalEntryId: ENTRY,
  totalValueMinor: 1250n,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('10'), valueMinor: 1000n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('2.5'), valueMinor: 250n },
  ],
  ...over,
});

describe('purchase.reverse — schema and intent (A-17)', () => {
  it('the header and line fields, in order; nothing is NULL-able', () => {
    const s = INVENTORY_PAYLOAD_SCHEMAS['purchase.reverse'];
    expect(s.map((f) => f.name)).toEqual([
      'purchase_id',
      'warehouse_id',
      'reversal_date',
      ...Array.from({ length: 8 }, (_, i) => `reason_w${i + 1}`),
      'original_entry_id',
      'total_value',
      'line_count',
    ]);
    expect(s.repeat?.fields.map((f) => f.name)).toEqual(['line_id', 'variant_id', 'qty_q4', 'value']);
    expect([...s, ...(s.repeat?.fields ?? [])].some((f) => f.nullable)).toBe(false);
  });

  it('the intent is purchase, warehouse, date and reason, with no line group', () => {
    const i = inventoryIntentSchema('purchase.reverse');
    expect(i.map((f) => f.name)).toEqual(['purchase_id', 'warehouse_id', 'reversal_date', ...Array.from({ length: 8 }, (_, k) => `reason_w${k + 1}`)]);
    expect(i.repeat).toBeUndefined();
  });

  it('purchaseReverseIntentSha256 equals the builder intent; the entry id, values and lines are not intent', () => {
    const intent = purchaseReverseIntentSha256({
      tenantId: T,
      businessId: B,
      purchaseId: PUR,
      warehouseId: W1,
      reversalDate: '2026-09-27',
      reason: 'Received against the wrong supplier',
    });
    expect(purchaseReversePayload(rev()).intentSha256).toBe(intent);
    const other = purchaseReversePayload(
      rev({ originalEntryId: L1, totalValueMinor: 1000n, lines: [{ lineId: L1, variantId: V1, qtyQ4: toQ4('10'), valueMinor: 1000n }] }),
    );
    expect(other.intentSha256).toBe(intent);
    expect(other.payload.sha256).not.toBe(purchaseReversePayload(rev()).payload.sha256);
    for (const o of [rev({ warehouseId: W2 }), rev({ reversalDate: '2026-09-28' }), rev({ reason: 'Other reason' })]) {
      expect(purchaseReversePayload(o).intentSha256).not.toBe(intent);
    }
  });

  it('S5-REV-01 is rebuilt by the builder from its routine arguments', () => {
    const v = vectors.cases.find((c) => c.id === 'S5-REV-01');
    const args = v?.routine.args ?? {};
    const str = (k: string): string => {
      const x = args[k];
      if (typeof x !== 'string') throw new Error(`vector argument ${k} is not text`);
      return x;
    };
    const arr = (k: string): string[] => {
      const x = args[k];
      if (!Array.isArray(x)) throw new Error(`vector argument ${k} is not an array`);
      return x.map(String);
    };
    const built = purchaseReversePayload({
      tenantId: T,
      businessId: B,
      purchaseId: str('p_purchase_id'),
      warehouseId: str('p_warehouse_id'),
      reversalDate: str('p_reversal_date'),
      reason: str('p_reason'),
      originalEntryId: str('p_original_entry_id'),
      totalValueMinor: BigInt(str('p_total_value_base_minor')),
      lines: arr('p_line_ids').map((id, k) => ({
        lineId: id,
        variantId: arr('p_variant_ids')[k] ?? '',
        qtyQ4: toQ4(arr('p_qtys')[k] ?? ''),
        valueMinor: BigInt(arr('p_values')[k] ?? ''),
      })),
    });
    expect(built.payload.sha256).toBe(v?.payload.sha256);
    expect(built.intentSha256).toBe(v?.intent.sha256);
  });
});

describe('purchaseReversePayload — refuses before the signature', () => {
  it('a reversal needs a reason (inventory.reason_required when absent), trimmed and 1..500 characters', () => {
    expect(codeOf(() => purchaseReversalReasonWords(null))).toBe('inventory.reason_required');
    expect(codeOf(() => purchaseReversePayload(rev({ reason: '' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReversePayload(rev({ reason: ' x' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReversePayload(rev({ reason: 'x'.repeat(501) })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReversePayload(rev({ reason: 'x'.repeat(500) })))).toBe('accepted');
  });

  it('lines: none, more than 200, a repeated line or variant, a non-positive quantity, a negative value', () => {
    expect(codeOf(() => purchaseReversePayload(rev({ lines: [] })))).toBe('inventory.lines_required');
    const [a, b] = rev().lines;
    if (a === undefined || b === undefined) throw new Error('fixture');
    expect(codeOf(() => purchaseReversePayload(rev({ lines: Array.from({ length: 201 }, () => a) })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReversePayload(rev({ lines: [a, { ...b, lineId: a.lineId }] })))).toBe('inventory.duplicate_line');
    expect(codeOf(() => purchaseReversePayload(rev({ lines: [a, { ...b, variantId: a.variantId }] })))).toBe('inventory.duplicate_line');
    expect(codeOf(() => purchaseReversePayload(rev({ lines: [a, { ...b, qtyQ4: 0n }] })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReversePayload(rev({ totalValueMinor: 999n, lines: [a, { ...b, valueMinor: -1n }] })))).toBe('inventory.payload_invalid');
  });

  it('the line values add up to a positive total exactly (Σ s_i = B)', () => {
    expect(codeOf(() => purchaseReversePayload(rev({ totalValueMinor: 1251n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReversePayload(rev({ totalValueMinor: 1249n })))).toBe('inventory.payload_invalid');
    const zero = rev().lines.map((l) => ({ ...l, valueMinor: 0n }));
    expect(codeOf(() => purchaseReversePayload(rev({ totalValueMinor: 0n, lines: zero })))).toBe('inventory.payload_invalid');
  });
});

describe('reversalLineVerdict — A-09 (d), (f); the R-B1a value rule', () => {
  const receive = (s: StockState, qty: string, value: bigint): StockState =>
    simulateMovement(s, { kind: 'purchase', qtyQ4: toQ4(qty), costC10: averageUnitCost(value, toQ4(qty), null) ?? 0n, value }).next;

  it('a receipt into an empty key reverses to exactly zero, at −s_i whatever the average', () => {
    const s = receive(EMPTY_STOCK_STATE, '3', 100n);
    const v = reversalLineVerdict(s, toQ4('3'), 100n);
    expect(v.verdict).toBe('ok');
    if (v.verdict !== 'ok') return;
    expect(v.valueMinor).toBe(-100n);
    expect([v.stateAfter.onHand, v.stateAfter.valuation]).toEqual([0n, 0n]);
  });

  it('with an intervening receipt at another cost, the reversal removes exactly s_i, not the average (Must-prove 6)', () => {
    const s = receive(receive(EMPTY_STOCK_STATE, '10', 1000n), '10', 1400n);
    const v = reversalLineVerdict(s, toQ4('10'), 1000n);
    expect(v.verdict).toBe('ok');
    if (v.verdict !== 'ok') return;
    expect(v.valueMinor).toBe(-1000n);
    expect(v.stateAfter.valuation).toBe(1400n);
    expect(v.stateAfter.avg).toBe(averageUnitCost(1400n, toQ4('10'), null));
  });

  it('insufficient stock (d): the key holds less than qty_i, or nothing', () => {
    expect(reversalLineVerdict(EMPTY_STOCK_STATE, toQ4('1'), 10n)).toEqual({ verdict: 'insufficient_stock' });
    const s = receive(EMPTY_STOCK_STATE, '3', 100n);
    expect(reversalLineVerdict(s, toQ4('3.0001'), 100n)).toEqual({ verdict: 'insufficient_stock' });
  });

  it('a residue (f, TL-8): on_hand reaching 0 with value left, or a negative valuation on a positive key', () => {
    // 3 holding 100 plus 3 holding 200, then 3 leave at the average: 3 remain holding 150, and removing the 200 would leave 0 units holding −50.
    const mixed = simulateMovement(receive(receive(EMPTY_STOCK_STATE, '3', 100n), '3', 200n), {
      kind: 'damage',
      qtyQ4: toQ4('-3'),
      costC10: null,
      value: null,
    }).next;
    expect(mixed.valuation).toBe(150n);
    expect(reversalLineVerdict(mixed, toQ4('3'), 200n)).toEqual({ verdict: 'valuation_residue' });
    // 3 holding 100 plus 1 holding 200, then 2 leave: 2 remain holding 150, and removing the 200 would leave 1 unit holding −50.
    const negative = simulateMovement(receive(receive(EMPTY_STOCK_STATE, '3', 100n), '1', 200n), {
      kind: 'damage',
      qtyQ4: toQ4('-2'),
      costC10: null,
      value: null,
    }).next;
    expect([negative.onHand, negative.valuation]).toEqual([toQ4('2'), 150n]);
    expect(reversalLineVerdict(negative, toQ4('1'), 200n)).toEqual({ verdict: 'valuation_residue' });
    // 1 at 1 plus 1 at 2 (average 1.5); 1 leaves at HALF_EVEN(1.5) = 2: the last unit holds 1, and removing the second receipt's 2 would leave 0 units holding −1.
    const rounded = simulateMovement(receive(receive(EMPTY_STOCK_STATE, '1', 1n), '1', 2n), {
      kind: 'damage',
      qtyQ4: toQ4('-1'),
      costC10: null,
      value: null,
    }).next;
    expect([rounded.onHand, rounded.valuation]).toEqual([toQ4('1'), 1n]);
    expect(reversalLineVerdict(rounded, toQ4('1'), 2n)).toEqual({ verdict: 'valuation_residue' });
    // The first receipt's 1 is exactly what is left: that reversal is lawful and empties the key.
    const v = reversalLineVerdict(rounded, toQ4('1'), 1n);
    expect(v.verdict === 'ok' && v.stateAfter.valuation === 0n && v.stateAfter.onHand === 0n).toBe(true);
  });

  it('refuses a non-positive quantity and a negative purchase value as a malformed call', () => {
    expect(codeOf(() => reversalLineVerdict(EMPTY_STOCK_STATE, 0n, 1n))).toBe('inventory.payload_invalid');
    expect(codeOf(() => reversalLineVerdict(EMPTY_STOCK_STATE, 1n, -1n))).toBe('inventory.payload_invalid');
  });
});
