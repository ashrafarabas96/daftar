import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderInvplS3Vectors, type InvplS3Vectors } from '../scripts/s3-vector-cases';
import { InventoryError } from '../src/errors';
import {
  adjustPayload,
  compareUuid,
  damagePayload,
  MAX_DOCUMENT_LINES,
  MAX_STOCKTAKE_LINES,
  openingPayload,
  stocktakeCountPayload,
  stocktakeFinalizePayload,
  stocktakeOpenPayload,
  toC10,
  toQ4,
  transferPayload,
  yyyymmdd,
  type StocktakeFinalizeLine,
} from '../src/movement-payloads';
import {
  canonicalInventoryIntent,
  canonicalInventoryPayload,
  INVENTORY_PAYLOAD_SCHEMAS,
  INVENTORY_S3_OPERATION_CODES,
  INVENTORY_SERVER_DERIVED_FIELDS,
  inventoryIntentSchema,
  inventoryIntentSha256,
  inventoryPayloadSha256,
  type InventoryPayloadField,
} from '../src/payload';

const FILE = join(__dirname, '..', 'vectors', 'invpl-s3-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as InvplS3Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const DOC = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const tb = { tenantId: T, businessId: B };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

/** A vector field as the typed field the canonicalizer takes. */
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

describe('vectors/invpl-s3-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-s3-vectors.ts after a SPEC change only)', async () => {
    expect(await renderInvplS3Vectors()).toBe(committed);
  });

  it('has at least three cases per P3-S3 kind and unique ids', () => {
    for (const op of INVENTORY_S3_OPERATION_CODES) expect(vectors.cases.filter((c) => c.opCode === op).length).toBeGreaterThanOrEqual(3);
    expect(new Set(vectors.cases.map((c) => c.id)).size).toBe(vectors.cases.length);
  });

  it('covers every shape the contract names (§4.1)', () => {
    const fields = (id: string) => vectors.cases.find((c) => c.id === id)?.payload.fields ?? [];
    const value = (id: string, name: string) =>
      fields(id)
        .filter((f) => f.name === name)
        .map((f) => f.value);
    expect(value('S3-ADJ-02', 'unit_cost_c10')).toEqual([null]);
    expect(value('S3-ADJ-02', 'qty_delta_q4')).toEqual(['-30000']);
    expect(value('S3-ADJ-04', 'expected_value')).toContain('0');
    expect(value('S3-DMG-01', 'expected_value')).toEqual(['-300']);
    expect(value('S3-TRF-01', 'line_count')).toEqual(['1']);
    expect(value('S3-TRF-02', 'line_count')).toEqual(['3']);
    expect(value('S3-STF-03', 'line_count')).toEqual(['0']);
    expect(value('S3-STF-03', 'occurred_on')).toEqual([null]);
    expect(value('S3-STF-03', 'outcome')).toEqual(['cancelled']);
    expect(value('S3-OPN-01', 'opening_balance_id')).toEqual([null]);
    expect(value('S3-OPN-03', 'opening_balance_id')).not.toEqual([null]);
    expect(vectors.reasons.some((r) => Buffer.from(r.reason, 'utf8').length > [...r.reason].length)).toBe(true);
  });
});

describe('invpl/1 P3-S3 — the shared vectors', () => {
  for (const v of vectors.cases) {
    it(`${v.id}: payload and intent bytes and digests match the recorded vector`, () => {
      const payloadFields = v.payload.fields.map(typed);
      const bytes = canonicalInventoryPayload(v.opCode, v.tenantId, v.businessId, payloadFields);
      expect(bytes.toString('hex')).toBe(v.payload.canonicalHex);
      expect(inventoryPayloadSha256(v.opCode, v.tenantId, v.businessId, payloadFields)).toBe(v.payload.sha256);
      expect(createHash('sha256').update(Buffer.from(v.payload.canonicalHex, 'hex')).digest('hex')).toBe(v.payload.sha256);
      // The recorded bytes are the spec's lines, assembled by hand.
      expect(hexOfLines(['invpl/1', v.opCode, v.tenantId, v.businessId, ...v.payload.fields.map((f) => f.value)])).toBe(v.payload.canonicalHex);

      const intentFields = v.intent.fields.map(typed);
      expect(canonicalInventoryIntent(v.opCode, v.tenantId, v.businessId, intentFields).toString('hex')).toBe(v.intent.canonicalHex);
      expect(inventoryIntentSha256(v.opCode, v.tenantId, v.businessId, intentFields)).toBe(v.intent.sha256);
      expect(hexOfLines(['invpl/1', v.opCode, v.tenantId, v.businessId, ...v.intent.fields.map((f) => f.value)])).toBe(v.intent.canonicalHex);
      // The intent is the payload without exactly the server-derived fields.
      expect(v.intent.fields).toEqual(v.payload.fields.filter((f) => !INVENTORY_SERVER_DERIVED_FIELDS.includes(f.name)));
    });
  }

  it('no two payload digests collide, and a digest is never an intent digest of another case', () => {
    const payloads = vectors.cases.map((c) => c.payload.sha256);
    expect(new Set(payloads).size).toBe(payloads.length);
  });

  it('transfer vs adjust over identical ids differ; swapped warehouses differ', () => {
    const sha = (id: string) => vectors.cases.find((c) => c.id === id)?.payload.sha256;
    expect(sha('S3-TRF-01')).not.toBe(sha('S3-ADJ-05'));
    expect(sha('S3-TRF-01')).not.toBe(sha('S3-TRF-03'));
  });

  it('a server-derived change keeps the intent and changes the payload (A-10(b))', () => {
    const c = (id: string) => vectors.cases.find((x) => x.id === id);
    for (const [a, b] of [
      ['S3-ADJ-02', 'S3-ADJ-03'],
      ['S3-DMG-01', 'S3-DMG-02'],
      ['S3-STF-01', 'S3-STF-04'],
      ['S3-OPN-01', 'S3-OPN-03'],
    ] as const) {
      expect(c(a)?.intent.sha256).toBe(c(b)?.intent.sha256);
      expect(c(a)?.payload.sha256).not.toBe(c(b)?.payload.sha256);
    }
  });

  it('a kind with no server-derived field has intent = payload', () => {
    for (const v of vectors.cases.filter((c) => ['inventory.transfer', 'inventory.stocktake_open', 'inventory.stocktake_count'].includes(c.opCode))) {
      expect(v.intent.sha256).toBe(v.payload.sha256);
    }
  });
});

describe('invpl/1 P3-S3 — schemas (A-09)', () => {
  const names = (op: (typeof INVENTORY_S3_OPERATION_CODES)[number]) => {
    const s = INVENTORY_PAYLOAD_SCHEMAS[op];
    return { header: s.map((f) => f.name), group: s.repeat?.fields.map((f) => f.name) ?? null, count: s.repeat?.countField ?? null };
  };
  const reason = Array.from({ length: 8 }, (_, i) => `reason_w${i + 1}`);

  it('lists the fields of every kind in the contract order', () => {
    expect(names('inventory.transfer')).toEqual({
      header: ['transfer_id', 'source_warehouse_id', 'destination_warehouse_id', 'line_count'],
      group: ['variant_id', 'qty_q4'],
      count: 'line_count',
    });
    expect(names('inventory.adjust')).toEqual({
      header: ['adjustment_id', 'warehouse_id', 'occurred_on', ...reason, 'line_count'],
      group: ['variant_id', 'qty_delta_q4', 'unit_cost_c10', 'expected_value'],
      count: 'line_count',
    });
    expect(names('inventory.damage')).toEqual({
      header: ['adjustment_id', 'warehouse_id', 'occurred_on', ...reason, 'line_count'],
      group: ['variant_id', 'qty_q4', 'expected_value'],
      count: 'line_count',
    });
    expect(names('inventory.stocktake_open')).toEqual({ header: ['stocktake_id', 'warehouse_id'], group: null, count: null });
    expect(names('inventory.stocktake_count')).toEqual({
      header: ['stocktake_id', 'warehouse_id', 'line_count'],
      group: ['variant_id', 'counted_q4'],
      count: 'line_count',
    });
    expect(names('inventory.stocktake_finalize')).toEqual({
      header: ['stocktake_id', 'warehouse_id', 'outcome', 'occurred_on', 'line_count'],
      group: ['variant_id', 'variance_q4', 'unit_cost_c10', 'expected_value'],
      count: 'line_count',
    });
    expect(names('inventory.opening')).toEqual({
      header: ['opening_id', 'occurred_on', 'opening_balance_id', 'position_minor', 'line_count'],
      group: ['warehouse_id', 'variant_id', 'qty_q4', 'unit_cost_c10'],
      count: 'line_count',
    });
  });

  it('introduces no field type beyond the locked four', () => {
    for (const op of INVENTORY_S3_OPERATION_CODES) {
      const s = INVENTORY_PAYLOAD_SCHEMAS[op];
      for (const f of [...s, ...(s.repeat?.fields ?? [])]) expect(['uuid', 'boolean', 'integer', 'code']).toContain(f.type);
    }
  });

  it('the intent schema drops exactly the server-derived fields', () => {
    const i = inventoryIntentSchema('inventory.opening');
    expect(i.map((f) => f.name)).toEqual(['opening_id', 'occurred_on', 'line_count']);
    expect(i.repeat?.fields.map((f) => f.name)).toEqual(['warehouse_id', 'variant_id', 'qty_q4', 'unit_cost_c10']);
    const f = inventoryIntentSchema('inventory.stocktake_finalize');
    expect(f.repeat?.fields.map((x) => x.name)).toEqual(['variant_id', 'unit_cost_c10']);
  });

  it('refuses a line_count that disagrees with the fields supplied, and a negative one', () => {
    const header: InventoryPayloadField[] = [
      { kind: 'uuid', value: DOC },
      { kind: 'uuid', value: W1 },
      { kind: 'uuid', value: W2 },
    ];
    const line: InventoryPayloadField[] = [
      { kind: 'uuid', value: V1 },
      { kind: 'integer', value: 1n },
    ];
    const run = (count: bigint, lines: InventoryPayloadField[]) => () =>
      canonicalInventoryPayload('inventory.transfer', T, B, [...header, { kind: 'integer', value: count }, ...lines]);
    expect(codeOf(run(1n, line))).toBe('accepted');
    expect(codeOf(run(2n, line))).toBe('inventory.payload_invalid');
    expect(codeOf(run(0n, line))).toBe('inventory.payload_invalid');
    expect(codeOf(run(-1n, []))).toBe('inventory.payload_invalid');
    expect(codeOf(run(1n, [...line, { kind: 'uuid', value: V2 }]))).toBe('inventory.payload_invalid');
    expect(codeOf(() => canonicalInventoryPayload('inventory.transfer', T, B, [...header, { kind: 'null' }]))).toBe('inventory.payload_invalid');
    expect(
      codeOf(
        run(1n, [
          { kind: 'integer', value: 1n },
          { kind: 'uuid', value: V1 },
        ]),
      ),
    ).toBe('inventory.payload_invalid');
  });
});

describe('invpl/1 P3-S3 — builders refuse what the database would refuse', () => {
  const transfer = (over: Partial<Parameters<typeof transferPayload>[0]> = {}) =>
    transferPayload({ ...tb, transferId: DOC, sourceWarehouseId: W1, destinationWarehouseId: W2, lines: [{ variantId: V1, qtyQ4: 10000n }], ...over });
  const adjust = (lines: Parameters<typeof adjustPayload>[0]['lines'], reason = 'counted wrong') =>
    adjustPayload({ ...tb, adjustmentId: DOC, warehouseId: W1, occurredOn: '2026-09-26', reason, lines });

  it('transfer: lines 1..200, distinct variants, positive quantities, two different warehouses', () => {
    expect(codeOf(() => transfer())).toBe('accepted');
    expect(codeOf(() => transfer({ lines: [] }))).toBe('inventory.lines_required');
    const many = Array.from({ length: MAX_DOCUMENT_LINES + 1 }, (_, i) => ({ variantId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, qtyQ4: 1n }));
    expect(codeOf(() => transfer({ lines: many.slice(0, MAX_DOCUMENT_LINES) }))).toBe('accepted');
    expect(codeOf(() => transfer({ lines: many }))).toBe('inventory.payload_invalid');
    expect(
      codeOf(() =>
        transfer({
          lines: [
            { variantId: V1, qtyQ4: 1n },
            { variantId: V1, qtyQ4: 2n },
          ],
        }),
      ),
    ).toBe('inventory.duplicate_line');
    expect(codeOf(() => transfer({ lines: [{ variantId: V1, qtyQ4: 0n }] }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => transfer({ lines: [{ variantId: V1, qtyQ4: -1n }] }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => transfer({ destinationWarehouseId: W1 }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => transfer({ transferId: DOC.toUpperCase() }))).toBe('inventory.payload_invalid');
  });

  it('adjust: a gain needs a cost, a loss takes none, and each value has the sign of its quantity', () => {
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: 1n, unitCostC10: null, expectedValue: 0n }]))).toBe('inventory.unit_cost_required');
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: -1n, unitCostC10: 5n, expectedValue: 0n }]))).toBe('inventory.payload_invalid');
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: 0n, unitCostC10: null, expectedValue: 0n }]))).toBe('inventory.payload_invalid');
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: 1n, unitCostC10: 5n, expectedValue: -1n }]))).toBe('inventory.payload_invalid');
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: -1n, unitCostC10: null, expectedValue: 1n }]))).toBe('inventory.payload_invalid');
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: -1n, unitCostC10: null, expectedValue: 0n }], '   '))).toBe('inventory.reason_required');
    expect(codeOf(() => adjust([{ variantId: V1, qtyDeltaQ4: -1n, unitCostC10: null, expectedValue: -1n }], 'r'.repeat(501)))).toBe(
      'inventory.payload_invalid',
    );
  });

  it('adjust: the date is bound and never defaulted; a non-date is refused', () => {
    const at = (occurredOn: string) => () =>
      adjustPayload({
        ...tb,
        adjustmentId: DOC,
        warehouseId: W1,
        occurredOn,
        reason: 'r',
        lines: [{ variantId: V1, qtyDeltaQ4: -1n, unitCostC10: null, expectedValue: -1n }],
      });
    expect(codeOf(at('2026-09-26'))).toBe('accepted');
    expect(at('2026-09-26')().payload.sha256).not.toBe(at('2026-09-27')().payload.sha256);
    expect(at('2026-09-26')().intentSha256).not.toBe(at('2026-09-27')().intentSha256);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '26-09-26', '2026-9-26', '', '0000-01-01'])
      expect(codeOf(at(bad))).toBe('inventory.payload_invalid');
  });

  it('damage: positive magnitudes and non-positive values', () => {
    const d = (qtyQ4: bigint, expectedValue: bigint) => () =>
      damagePayload({
        ...tb,
        adjustmentId: DOC,
        warehouseId: W1,
        occurredOn: '2026-09-26',
        reason: 'broken',
        lines: [{ variantId: V1, qtyQ4, expectedValue }],
      });
    expect(codeOf(d(1n, 0n))).toBe('accepted');
    expect(codeOf(d(1n, 1n))).toBe('inventory.payload_invalid');
    expect(codeOf(d(-1n, -1n))).toBe('inventory.payload_invalid');
  });

  it('stocktake count and finalize: strictly ascending variants; finalize outcome shape', () => {
    const count = (lines: { variantId: string; countedQ4: bigint }[]) => () => stocktakeCountPayload({ ...tb, stocktakeId: DOC, warehouseId: W1, lines });
    expect(codeOf(count([{ variantId: V1, countedQ4: 0n }]))).toBe('accepted');
    expect(
      codeOf(
        count([
          { variantId: V2, countedQ4: 0n },
          { variantId: V1, countedQ4: 0n },
        ]),
      ),
    ).toBe('inventory.payload_invalid');
    expect(
      codeOf(
        count([
          { variantId: V1, countedQ4: 0n },
          { variantId: V1, countedQ4: 1n },
        ]),
      ),
    ).toBe('inventory.duplicate_line');
    expect(codeOf(count([{ variantId: V1, countedQ4: -1n }]))).toBe('inventory.payload_invalid');

    const fin = (outcome: 'finalized' | 'cancelled', occurredOn: string | null, lines: StocktakeFinalizeLine[]) => () =>
      stocktakeFinalizePayload({ ...tb, stocktakeId: DOC, warehouseId: W1, outcome, occurredOn, lines });
    const zero: StocktakeFinalizeLine = { variantId: V1, varianceQ4: 0n, unitCostC10: null, expectedValue: 0n };
    expect(codeOf(fin('cancelled', null, []))).toBe('accepted');
    expect(codeOf(fin('cancelled', '2026-09-26', []))).toBe('inventory.payload_invalid');
    expect(codeOf(fin('cancelled', null, [zero]))).toBe('inventory.payload_invalid');
    expect(codeOf(fin('finalized', null, [zero]))).toBe('inventory.payload_invalid');
    expect(codeOf(fin('finalized', '2026-09-26', []))).toBe('inventory.lines_required');
    expect(codeOf(fin('finalized', '2026-09-26', [{ ...zero, expectedValue: 1n }]))).toBe('inventory.payload_invalid');
    expect(codeOf(fin('finalized', '2026-09-26', [{ ...zero, varianceQ4: -1n, unitCostC10: 1n, expectedValue: -1n }]))).toBe('inventory.payload_invalid');
    expect(codeOf(fin('finalized', '2026-09-26', [{ ...zero, varianceQ4: 1n, unitCostC10: 0n, expectedValue: 0n }]))).toBe('accepted');
    const many: StocktakeFinalizeLine[] = Array.from({ length: MAX_STOCKTAKE_LINES + 1 }, (_, i) => ({
      ...zero,
      variantId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(codeOf(fin('finalized', '2026-09-26', many.slice(0, MAX_STOCKTAKE_LINES)))).toBe('accepted');
    expect(codeOf(fin('finalized', '2026-09-26', many))).toBe('inventory.payload_invalid');
    // An assertion minted for one outcome cannot be the other: the outcome is a signed field.
    expect(fin('cancelled', null, [])().payload.sha256).not.toBe(stocktakeOpenPayload({ ...tb, stocktakeId: DOC, warehouseId: W1 }).payload.sha256);
  });

  it('opening: Case A or Case B, never half of one; (warehouse, variant) unique; cost >= 0', () => {
    const open =
      (openingBalanceId: string | null, positionMinor: bigint | null, lines = [{ warehouseId: W1, variantId: V1, qtyQ4: 10000n, unitCostC10: 0n }]) =>
      () =>
        openingPayload({ ...tb, openingId: DOC, occurredOn: '2026-01-01', openingBalanceId, positionMinor, lines });
    expect(codeOf(open(null, null))).toBe('accepted');
    expect(codeOf(open(DOC, 5n))).toBe('accepted');
    expect(codeOf(open(DOC, null))).toBe('inventory.payload_invalid');
    expect(codeOf(open(null, 5n))).toBe('inventory.payload_invalid');
    expect(
      codeOf(
        open(null, null, [
          { warehouseId: W1, variantId: V1, qtyQ4: 1n, unitCostC10: 0n },
          { warehouseId: W2, variantId: V1, qtyQ4: 1n, unitCostC10: 0n },
        ]),
      ),
    ).toBe('accepted');
    expect(
      codeOf(
        open(null, null, [
          { warehouseId: W1, variantId: V1, qtyQ4: 1n, unitCostC10: 0n },
          { warehouseId: W1, variantId: V1, qtyQ4: 2n, unitCostC10: 0n },
        ]),
      ),
    ).toBe('inventory.duplicate_line');
    expect(codeOf(open(null, null, [{ warehouseId: W1, variantId: V1, qtyQ4: 1n, unitCostC10: -1n }]))).toBe('inventory.payload_invalid');
  });
});

describe('fixed-point helpers', () => {
  it('toQ4, toC10 and yyyymmdd are exact', () => {
    expect(toQ4('12.3456')).toBe(123456n);
    expect(toQ4('0.25')).toBe(2500n);
    expect(codeOf(() => toQ4('0.00001'))).toBe('inventory.quantity_invalid');
    expect(toC10('110.5')).toBe(1105000000000n);
    expect(codeOf(() => toC10('-1'))).toBe('inventory.cost_invalid');
    expect(yyyymmdd('2024-02-29')).toBe(20240229n);
    expect(yyyymmdd('0999-12-31')).toBe(9991231n);
  });

  it('compareUuid is the uuid order of canonical text', () => {
    expect([V2, V1].sort(compareUuid)).toEqual([V1, V2]);
    expect(compareUuid(V1, V1)).toBe(0);
  });
});
