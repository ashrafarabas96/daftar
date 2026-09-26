import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderInvplS4Vectors, type InvplS4Vectors } from '../scripts/s4-vector-cases';
import { InventoryError } from '../src/errors';
import { toC10, toQ4 } from '../src/movement-payloads';
import {
  canonicalInventoryIntent,
  canonicalInventoryPayload,
  INVENTORY_PAYLOAD_SCHEMAS,
  INVENTORY_S4_OPERATION_CODES,
  inventoryIntentSchema,
  inventoryIntentSha256,
  inventoryPayloadSha256,
  type InventoryPayloadField,
} from '../src/payload';
import {
  currencyCode,
  DOMESTIC_RATE_R10,
  purchaseCancelPayload,
  purchaseDraftPayload,
  purchaseReceiveIntentSha256,
  purchaseReceivePayload,
  type PurchaseDraftPayloadInput,
  type PurchaseReceivePayloadInput,
} from '../src/purchase-payloads';

const FILE = join(__dirname, '..', 'vectors', 'invpl-s4-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as InvplS4Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const PUR = 'a1b2c3d4-0002-4a00-8a00-000000000002';
const SUP = 'a1b2c3d4-0001-4a00-8a00-000000000001';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const L1 = 'b0000000-0000-4000-8000-000000000001';
const L2 = 'b0000000-0000-4000-8000-000000000002';
const LC1 = 'c0000000-0000-4000-8000-000000000001';
const ADJ = 'e0000000-0000-4000-8000-000000000001';
const RATE = 'd0000000-0000-4000-8000-000000000001';

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

const hexOfLines = (lines: readonly (string | null)[]): string => Buffer.from(lines.map((l) => `${l ?? '\u0000'}\n`).join(''), 'utf8').toString('hex');

const draft = (over: Partial<PurchaseDraftPayloadInput> = {}): PurchaseDraftPayloadInput => ({
  tenantId: T,
  businessId: B,
  purchaseId: PUR,
  expectedRevision: 0,
  supplierId: SUP,
  warehouseId: W1,
  previousWarehouseId: null,
  currency: 'ILS',
  documentDate: '2026-09-20',
  supplierReference: null,
  notes: null,
  taxMinor: 0n,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('2'), unitPriceC10: toC10('100'), discountMinor: 0n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('1'), unitPriceC10: toC10('50'), discountMinor: 0n },
  ],
  landedCosts: [],
  ...over,
});

const receipt = (over: Partial<PurchaseReceivePayloadInput> = {}): PurchaseReceivePayloadInput => ({
  tenantId: T,
  businessId: B,
  purchaseId: PUR,
  warehouseId: W1,
  draftRevision: 1,
  supplierId: SUP,
  supplierRevision: 1,
  documentDate: '2026-09-20',
  currency: 'ILS',
  rate: { rateId: null, rateR10: DOMESTIC_RATE_R10, source: 'base', rateAtEpochSeconds: 1789862400n },
  totalTxnMinor: 250n,
  totalBaseMinor: 250n,
  coverageAdjustmentId: null,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('2'), baseShareMinor: 200n, coveredQ4: 0n, catchUpMinor: 0n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('1'), baseShareMinor: 50n, coveredQ4: 0n, catchUpMinor: 0n },
  ],
  ...over,
});

describe('vectors/invpl-s4-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-s4-vectors.ts after a SPEC change only)', async () => {
    expect(await renderInvplS4Vectors()).toBe(committed);
  });

  it('has at least one vector per P3-S4 kind, unique ids and no two equal payload digests', () => {
    for (const op of INVENTORY_S4_OPERATION_CODES) expect(vectors.cases.some((c) => c.opCode === op)).toBe(true);
    expect(new Set(vectors.cases.map((c) => c.id)).size).toBe(vectors.cases.length);
    const payloads = vectors.cases.map((c) => c.payload.sha256);
    expect(new Set(payloads).size).toBe(payloads.length);
  });

  it('has a vector in which each NULL-able field is NULL, and one in which it is not (§4.1)', () => {
    for (const op of INVENTORY_S4_OPERATION_CODES) {
      const s = INVENTORY_PAYLOAD_SCHEMAS[op];
      const nullable = [...s, ...(s.repeat?.fields ?? []), ...(s.trailer ? [...s.trailer.fields, ...(s.trailer.perLine ? [s.trailer.perLine] : [])] : [])]
        .filter((f) => f.nullable)
        .map((f) => f.name);
      for (const name of nullable) {
        const values = vectors.cases.filter((c) => c.opCode === op).flatMap((c) => c.payload.fields.filter((f) => f.name === name).map((f) => f.value));
        expect(values, `${op} ${name}`).toContain(null);
        expect(
          values.some((v) => v !== null),
          `${op} ${name}`,
        ).toBe(true);
      }
    }
  });
});

describe('invpl/1 P3-S4 — the shared vectors', () => {
  for (const v of vectors.cases) {
    it(`${v.id}: payload and intent bytes and digests match the recorded vector`, () => {
      const payloadFields = v.payload.fields.map(typed);
      expect(canonicalInventoryPayload(v.opCode, v.tenantId, v.businessId, payloadFields).toString('hex')).toBe(v.payload.canonicalHex);
      expect(inventoryPayloadSha256(v.opCode, v.tenantId, v.businessId, payloadFields)).toBe(v.payload.sha256);
      expect(createHash('sha256').update(Buffer.from(v.payload.canonicalHex, 'hex')).digest('hex')).toBe(v.payload.sha256);
      expect(hexOfLines(['invpl/1', v.opCode, v.tenantId, v.businessId, ...v.payload.fields.map((f) => f.value)])).toBe(v.payload.canonicalHex);

      const intentFields = v.intent.fields.map(typed);
      expect(canonicalInventoryIntent(v.opCode, v.tenantId, v.businessId, intentFields).toString('hex')).toBe(v.intent.canonicalHex);
      expect(inventoryIntentSha256(v.opCode, v.tenantId, v.businessId, intentFields)).toBe(v.intent.sha256);
      expect(hexOfLines(['invpl/1', v.opCode, v.tenantId, v.businessId, ...v.intent.fields.map((f) => f.value)])).toBe(v.intent.canonicalHex);
    });
  }

  it('a supplier, draft or cancel intent is its whole payload; a receipt intent is purchase, warehouse and revision', () => {
    for (const v of vectors.cases) {
      if (v.opCode === 'purchase.receive') {
        expect(v.intent.fields.map((f) => f.name)).toEqual(['purchase_id', 'warehouse_id', 'draft_revision']);
      } else {
        expect(v.intent.sha256).toBe(v.payload.sha256);
      }
    }
    const sha = (id: string) => vectors.cases.find((c) => c.id === id)?.intent.sha256;
    expect(sha('S4-PRC-01')).toBe(sha('S4-PRC-03'));
    expect(vectors.cases.find((c) => c.id === 'S4-SUP-ARC-01')?.payload.sha256).not.toBe(vectors.cases.find((c) => c.id === 'S4-SUP-REA-01')?.payload.sha256);
  });

  it('the draft stream frames its landed costs by landed_count and one allocation per line', () => {
    const v = vectors.cases.find((c) => c.id === 'S4-PDR-02');
    const names = v?.payload.fields.map((f) => f.name) ?? [];
    expect(names.filter((n) => n === 'allocation_minor')).toHaveLength(2 * 3);
    expect(names.indexOf('landed_count')).toBe(names.length - 2 * (3 + 8 + 3) - 1);
    expect(v?.routine.args.p_lc_allocations).toEqual([null, null, null, '100', '150', '0']);
  });
});

describe('invpl/1 P3-S4 — the schema grammar', () => {
  it('a receipt intent schema has no line group; a draft intent schema is the whole schema', () => {
    const r = inventoryIntentSchema('purchase.receive');
    expect(r.map((f) => f.name)).toEqual(['purchase_id', 'warehouse_id', 'draft_revision']);
    expect(r.repeat).toBeUndefined();
    const d = inventoryIntentSchema('purchase.draft');
    expect(d.map((f) => f.name)).toEqual(INVENTORY_PAYLOAD_SCHEMAS['purchase.draft'].map((f) => f.name));
    expect(d.trailer?.countField.name).toBe('landed_count');
    expect(d.trailer?.perLine?.name).toBe('allocation_minor');
  });

  it('refuses a draft stream whose landed group does not match its counts', () => {
    const built = purchaseDraftPayload(
      draft({ landedCosts: [{ landedCostId: LC1, mode: 'by_value', amountMinor: 10n, description: null, allocations: null }] }),
    );
    const values = built.payload.bytes.toString('utf8').slice(0, -1).split('\n').slice(4);
    const fields = INVENTORY_PAYLOAD_SCHEMAS['purchase.draft'];
    expect(fields.length + 2 * 5 + 1 + 11 + 2).toBe(values.length);
    const asFields = (vs: readonly string[]): InventoryPayloadField[] =>
      vs.map((x, i) => {
        if (x === '\u0000') return { kind: 'null' };
        if (i === 0 || i === 2 || i === 3) return { kind: 'uuid', value: x };
        return /^-?\d+$/.test(x) ? { kind: 'integer', value: BigInt(x) } : /^[0-9a-f-]{36}$/.test(x) ? { kind: 'uuid', value: x } : { kind: 'code', value: x };
      });
    expect(codeOf(() => canonicalInventoryPayload('purchase.draft', T, B, asFields(values)))).toBe('accepted');
    expect(codeOf(() => canonicalInventoryPayload('purchase.draft', T, B, asFields(values.slice(0, -1))))).toBe('inventory.payload_invalid');
    expect(codeOf(() => canonicalInventoryPayload('purchase.draft', T, B, asFields([...values, '\u0000'])))).toBe('inventory.payload_invalid');
  });
});

describe('purchaseDraftPayload — refuses before the signature', () => {
  it('accepts a valid draft and returns its A-13 totals', () => {
    const d = purchaseDraftPayload(draft());
    expect(d.totals.totalMinor).toBe(250n);
    expect(d.intentSha256).toBe(d.payload.sha256);
  });

  it('refuses no line, a repeated variant or id, and more than ten landed costs', () => {
    expect(codeOf(() => purchaseDraftPayload(draft({ lines: [] })))).toBe('inventory.lines_required');
    const [a] = draft().lines;
    if (a === undefined) throw new Error('fixture');
    expect(codeOf(() => purchaseDraftPayload(draft({ lines: [a, { ...a, lineId: L2 }] })))).toBe('inventory.duplicate_line');
    expect(codeOf(() => purchaseDraftPayload(draft({ lines: [a, { ...a, variantId: V2 }] })))).toBe('inventory.duplicate_line');
    const lc = { landedCostId: L1, mode: 'by_value' as const, amountMinor: 1n, description: null, allocations: null };
    expect(codeOf(() => purchaseDraftPayload(draft({ landedCosts: [lc] })))).toBe('inventory.duplicate_line');
    const many = Array.from({ length: 11 }, (_, i) => ({ ...lc, landedCostId: `c0000000-0000-4000-8000-0000000000${String(i + 10)}` }));
    expect(codeOf(() => purchaseDraftPayload(draft({ landedCosts: many })))).toBe('inventory.payload_invalid');
  });

  it('refuses the A-13 arithmetic the routine refuses, with the same codes', () => {
    const [a, b] = draft().lines;
    if (a === undefined || b === undefined) throw new Error('fixture');
    expect(codeOf(() => purchaseDraftPayload(draft({ lines: [{ ...a, discountMinor: 201n }, b] })))).toBe('purchase.discount_invalid');
    expect(
      codeOf(() =>
        purchaseDraftPayload(
          draft({
            lines: [
              { ...a, unitPriceC10: 0n },
              { ...b, unitPriceC10: 0n },
            ],
          }),
        ),
      ),
    ).toBe('purchase.total_zero');
    const manual = (allocations: bigint[]) => draft({ landedCosts: [{ landedCostId: LC1, mode: 'manual', amountMinor: 10n, description: null, allocations }] });
    expect(codeOf(() => purchaseDraftPayload(manual([5n, 5n])))).toBe('accepted');
    expect(codeOf(() => purchaseDraftPayload(manual([5n, 6n])))).toBe('purchase.landed_cost_allocation_mismatch');
    expect(codeOf(() => purchaseDraftPayload(manual([5n, 4n])))).toBe('purchase.landed_cost_allocation_mismatch');
    expect(codeOf(() => purchaseDraftPayload(manual([10n])))).toBe('purchase.landed_cost_invalid');
    const zeroNets = draft({
      lines: [{ ...a, discountMinor: 200n }],
      landedCosts: [{ landedCostId: LC1, mode: 'by_value', amountMinor: 10n, description: null, allocations: null }],
    });
    expect(codeOf(() => purchaseDraftPayload(zeroNets))).toBe('purchase.landed_cost_denominator_zero');
  });

  it('refuses a non-zero tax, a previous warehouse on create or unchanged, and non-canonical text or currency', () => {
    expect(codeOf(() => purchaseDraftPayload(draft({ taxMinor: 1n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseDraftPayload(draft({ previousWarehouseId: W2 })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseDraftPayload(draft({ expectedRevision: 1, previousWarehouseId: W1 })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseDraftPayload(draft({ expectedRevision: 1, previousWarehouseId: W2 })))).toBe('accepted');
    expect(codeOf(() => purchaseDraftPayload(draft({ notes: ' padded ' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseDraftPayload(draft({ notes: '' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseDraftPayload(draft({ supplierReference: 'r'.repeat(201) })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseDraftPayload(draft({ currency: 'ils' })))).toBe('inventory.payload_invalid');
    expect(currencyCode('JOD')).toBe('jod');
  });

  it('binds every financial input: a one-unit change of any of them is another payload', () => {
    const base = purchaseDraftPayload(draft()).payload.sha256;
    const [a, b] = draft().lines;
    if (a === undefined || b === undefined) throw new Error('fixture');
    const variants: PurchaseDraftPayloadInput[] = [
      draft({ lines: [{ ...a, qtyQ4: a.qtyQ4 + 1n }, b] }),
      draft({ lines: [{ ...a, unitPriceC10: a.unitPriceC10 + 1n }, b] }),
      draft({ lines: [{ ...a, discountMinor: 1n }, b] }),
      draft({ documentDate: '2026-09-21' }),
      draft({ currency: 'USD' }),
      draft({ notes: 'x' }),
      draft({ landedCosts: [{ landedCostId: LC1, mode: 'by_value', amountMinor: 1n, description: null, allocations: null }] }),
    ];
    for (const v of variants) expect(purchaseDraftPayload(v).payload.sha256).not.toBe(base);
  });
});

describe('purchaseCancelPayload and purchaseReceivePayload', () => {
  it('cancel binds purchase, warehouse and revision (>= 1)', () => {
    const c = purchaseCancelPayload({ tenantId: T, businessId: B, purchaseId: PUR, warehouseId: W1, draftRevision: 1 });
    expect(c.intentSha256).toBe(c.payload.sha256);
    expect(codeOf(() => purchaseCancelPayload({ tenantId: T, businessId: B, purchaseId: PUR, warehouseId: W1, draftRevision: 0 }))).toBe(
      'inventory.payload_invalid',
    );
  });

  it('a receipt intent is computable before any state read and equals the builder`s', () => {
    const r = purchaseReceivePayload(receipt());
    expect(purchaseReceiveIntentSha256({ tenantId: T, businessId: B, purchaseId: PUR, warehouseId: W1, draftRevision: 1 })).toBe(r.intentSha256);
    expect(r.intentSha256).not.toBe(r.payload.sha256);
    // Server-derived fields change the payload, never the intent.
    const other = purchaseReceivePayload(receipt({ supplierRevision: 2 }));
    expect(other.intentSha256).toBe(r.intentSha256);
    expect(other.payload.sha256).not.toBe(r.payload.sha256);
  });

  it('refuses an incoherent snapshot, totals, shares or coverage', () => {
    expect(codeOf(() => purchaseReceivePayload(receipt()))).toBe('accepted');
    expect(codeOf(() => purchaseReceivePayload(receipt({ rate: { rateId: RATE, rateR10: DOMESTIC_RATE_R10, source: 'base', rateAtEpochSeconds: 0n } })))).toBe(
      'inventory.payload_invalid',
    );
    expect(
      codeOf(() => purchaseReceivePayload(receipt({ rate: { rateId: null, rateR10: 2n * DOMESTIC_RATE_R10, source: 'base', rateAtEpochSeconds: 0n } }))),
    ).toBe('inventory.payload_invalid');
    expect(
      codeOf(() => purchaseReceivePayload(receipt({ rate: { rateId: null, rateR10: DOMESTIC_RATE_R10, source: 'manual', rateAtEpochSeconds: 0n } }))),
    ).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReceivePayload(receipt({ totalBaseMinor: 251n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReceivePayload(receipt({ totalTxnMinor: 0n })))).toBe('purchase.total_zero');
    const [a, b] = receipt().lines;
    if (a === undefined || b === undefined) throw new Error('fixture');
    expect(codeOf(() => purchaseReceivePayload(receipt({ lines: [{ ...a, coveredQ4: 1n }, b] })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReceivePayload(receipt({ coverageAdjustmentId: ADJ, lines: [{ ...a, coveredQ4: 1n }, b] })))).toBe('accepted');
    expect(codeOf(() => purchaseReceivePayload(receipt({ coverageAdjustmentId: ADJ })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReceivePayload(receipt({ lines: [{ ...a, catchUpMinor: -1n }, b] })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseReceivePayload(receipt({ coverageAdjustmentId: ADJ, lines: [{ ...a, coveredQ4: a.qtyQ4 + 1n }, b] })))).toBe(
      'inventory.payload_invalid',
    );
  });
});
