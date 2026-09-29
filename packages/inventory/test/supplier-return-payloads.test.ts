import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderInvplS5Vectors, type InvplS5Vectors } from '../scripts/s5-vector-cases';
import { InventoryError } from '../src/errors';
import { toQ4 } from '../src/movement-payloads';
import {
  canonicalInventoryIntent,
  canonicalInventoryPayload,
  INVENTORY_PAYLOAD_SCHEMAS,
  INVENTORY_S5_OPERATION_CODES,
  inventoryIntentSchema,
  inventoryIntentSha256,
  inventoryPayloadSha256,
  type InventoryPayloadField,
} from '../src/payload';
import { supplierReturnIntentSha256, supplierReturnPayload, type SupplierReturnPayloadInput } from '../src/supplier-return-payloads';

const FILE = join(__dirname, '..', 'vectors', 'invpl-s5-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as InvplS5Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const PUR = 'a1b2c3d4-0002-4a00-8a00-000000000002';
const RET = 'a1b2c3d4-0005-4a00-8a00-000000000005';
const CN = 'a1b2c3d4-0006-4a00-8a00-000000000006';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const L1 = 'b0000000-0000-4000-8000-000000000001';
const L2 = 'b0000000-0000-4000-8000-000000000002';
const RL1 = 'b5000000-0000-4000-8000-000000000001';
const RL2 = 'b5000000-0000-4000-8000-000000000002';

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

const ret = (over: Partial<SupplierReturnPayloadInput> = {}): SupplierReturnPayloadInput => ({
  tenantId: T,
  businessId: B,
  returnId: RET,
  purchaseId: PUR,
  warehouseId: W1,
  documentDate: '2026-09-25',
  reason: null,
  creditNoteId: null,
  carryingTxnMinor: 700n,
  apTxnMinor: 700n,
  apBaseMinor: 700n,
  creditTxnMinor: 0n,
  creditBaseMinor: 0n,
  inventoryValueMinor: 680n,
  ppvMinor: 20n,
  lines: [
    { returnLineId: RL1, purchaseLineId: L1, variantId: V1, qtyQ4: toQ4('5'), carryingTxnMinor: 600n, valueOutMinor: 550n },
    { returnLineId: RL2, purchaseLineId: L2, variantId: V2, qtyQ4: toQ4('1'), carryingTxnMinor: 100n, valueOutMinor: 130n },
  ],
  ...over,
});

describe('vectors/invpl-s5-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-s5-vectors.ts after a SPEC change only)', async () => {
    expect(await renderInvplS5Vectors()).toBe(committed);
  });

  it('has a vector per P3-S5 kind, unique ids and no two equal payload digests', () => {
    for (const op of INVENTORY_S5_OPERATION_CODES) expect(vectors.cases.some((c) => c.opCode === op)).toBe(true);
    expect(new Set(vectors.cases.map((c) => c.id)).size).toBe(vectors.cases.length);
    const payloads = vectors.cases.map((c) => c.payload.sha256);
    expect(new Set(payloads).size).toBe(payloads.length);
  });

  it('has a vector in which each NULL-able field is NULL, and one in which it is not (§4.1)', () => {
    for (const op of INVENTORY_S5_OPERATION_CODES) {
      const s = INVENTORY_PAYLOAD_SCHEMAS[op];
      const nullable = [...s, ...(s.repeat?.fields ?? [])].filter((f) => f.nullable).map((f) => f.name);
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

describe('invpl/1 P3-S5 — the shared vectors', () => {
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

  it('the routine arguments restate the payload: every line array has line_count entries and the reason is NULL iff its words are', () => {
    for (const v of vectors.cases) {
      const count = Number(v.payload.fields.find((f) => f.name === 'line_count')?.value);
      for (const [k, a] of Object.entries(v.routine.args)) if (Array.isArray(a)) expect(a, `${v.id} ${k}`).toHaveLength(count);
      const w1 = v.payload.fields.find((f) => f.name === 'reason_w1')?.value;
      expect(v.routine.args.p_reason === null).toBe(w1 === null);
    }
  });

  it('a return intent carries no amount: S5-RET-01 and S5-RET-02 share it and differ in payload', () => {
    const get = (id: string) => vectors.cases.find((c) => c.id === id);
    expect(get('S5-RET-01')?.intent.sha256).toBe(get('S5-RET-02')?.intent.sha256);
    expect(get('S5-RET-01')?.payload.sha256).not.toBe(get('S5-RET-02')?.payload.sha256);
  });
});

describe('purchase.return — schema and intent (A-17)', () => {
  it('the header and line fields, in order', () => {
    const s = INVENTORY_PAYLOAD_SCHEMAS['purchase.return'];
    expect(s.map((f) => f.name)).toEqual([
      'return_id',
      'purchase_id',
      'warehouse_id',
      'document_date',
      ...Array.from({ length: 8 }, (_, i) => `reason_w${i + 1}`),
      'credit_note_id',
      'carrying_txn',
      'ap_txn',
      'ap_base',
      'credit_txn',
      'credit_base',
      'inventory_value',
      'ppv',
      'line_count',
    ]);
    expect(s.filter((f) => f.nullable).map((f) => f.name)).toEqual([...Array.from({ length: 8 }, (_, i) => `reason_w${i + 1}`), 'credit_note_id']);
    expect(s.repeat?.fields.map((f) => f.name)).toEqual(['return_line_id', 'purchase_line_id', 'variant_id', 'qty_q4', 'carrying_txn', 'value_out']);
  });

  it('the intent schema keeps the client fields only', () => {
    const i = inventoryIntentSchema('purchase.return');
    expect(i.map((f) => f.name)).toEqual([
      'return_id',
      'purchase_id',
      'warehouse_id',
      'document_date',
      ...Array.from({ length: 8 }, (_, k) => `reason_w${k + 1}`),
      'line_count',
    ]);
    expect(i.repeat?.fields.map((f) => f.name)).toEqual(['return_line_id', 'purchase_line_id', 'qty_q4']);
  });

  it('supplierReturnIntentSha256 before any state read equals the builder intent, whatever the amounts', () => {
    const p = ret();
    const intent = supplierReturnIntentSha256({
      tenantId: T,
      businessId: B,
      returnId: RET,
      purchaseId: PUR,
      warehouseId: W1,
      documentDate: '2026-09-25',
      reason: null,
      lines: p.lines.map((l) => ({ returnLineId: l.returnLineId, purchaseLineId: l.purchaseLineId, qtyQ4: l.qtyQ4 })),
    });
    const built = supplierReturnPayload(p);
    expect(built.intentSha256).toBe(intent);
    const moved = supplierReturnPayload(
      ret({
        inventoryValueMinor: 700n,
        ppvMinor: 0n,
        lines: p.lines.map((l, k) => ({ ...l, valueOutMinor: k === 0 ? 570n : 130n })),
      }),
    );
    expect(moved.intentSha256).toBe(intent);
    expect(moved.payload.sha256).not.toBe(built.payload.sha256);
    // The warehouse, the date, the reason, a quantity or a line id is intent.
    for (const other of [
      ret({ warehouseId: W2 }),
      ret({ documentDate: '2026-09-26' }),
      ret({ reason: 'damaged' }),
      ret({ lines: p.lines.map((l, k) => (k === 1 ? { ...l, returnLineId: CN } : l)) }),
    ]) {
      expect(supplierReturnPayload(other).intentSha256).not.toBe(intent);
    }
  });
});

describe('supplierReturnPayload — refuses before the signature', () => {
  it('lines: none, more than 200, a repeated line id or purchase line, a non-positive quantity', () => {
    expect(codeOf(() => supplierReturnPayload(ret({ lines: [] })))).toBe('inventory.lines_required');
    const l = ret().lines[0];
    if (l === undefined) throw new Error('fixture');
    expect(codeOf(() => supplierReturnPayload(ret({ lines: Array.from({ length: 201 }, () => l) })))).toBe('inventory.payload_invalid');
    const [a, b] = ret().lines;
    if (a === undefined || b === undefined) throw new Error('fixture');
    expect(codeOf(() => supplierReturnPayload(ret({ lines: [a, { ...b, returnLineId: a.returnLineId }] })))).toBe('inventory.duplicate_line');
    expect(codeOf(() => supplierReturnPayload(ret({ lines: [a, { ...b, purchaseLineId: a.purchaseLineId }] })))).toBe('inventory.duplicate_line');
    expect(codeOf(() => supplierReturnPayload(ret({ lines: [a, { ...b, qtyQ4: 0n }] })))).toBe('inventory.payload_invalid');
  });

  it('the header CHECKs of §2.2', () => {
    expect(codeOf(() => supplierReturnPayload(ret()))).toBe('accepted');
    expect(codeOf(() => supplierReturnPayload(ret({ carryingTxnMinor: 701n, apTxnMinor: 701n, apBaseMinor: 701n, ppvMinor: 21n })))).toBe(
      'inventory.payload_invalid',
    );
    expect(codeOf(() => supplierReturnPayload(ret({ apTxnMinor: 600n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ inventoryValueMinor: 681n, ppvMinor: 19n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ ppvMinor: 21n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ apTxnMinor: -1n })))).toBe('inventory.payload_invalid');
    // A credit is a txn and a base amount and a credit note id, or none of the three.
    const credit = { apTxnMinor: 500n, apBaseMinor: 500n, creditTxnMinor: 200n, creditBaseMinor: 200n, ppvMinor: 20n };
    expect(codeOf(() => supplierReturnPayload(ret({ ...credit, creditNoteId: CN })))).toBe('accepted');
    expect(codeOf(() => supplierReturnPayload(ret(credit)))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ creditNoteId: CN })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ ...credit, creditBaseMinor: 0n, ppvMinor: -180n, creditNoteId: CN })))).toBe('inventory.payload_invalid');
    expect(
      codeOf(() =>
        supplierReturnPayload(ret({ apTxnMinor: 0n, apBaseMinor: 5n, creditTxnMinor: 700n, creditBaseMinor: 700n, creditNoteId: CN, ppvMinor: 25n })),
      ),
    ).toBe('inventory.payload_invalid');
  });

  it('a zero-value return is supplier_return.value_zero (TL-12)', () => {
    const zero = ret({
      carryingTxnMinor: 0n,
      apTxnMinor: 0n,
      apBaseMinor: 0n,
      inventoryValueMinor: 0n,
      ppvMinor: 0n,
      lines: ret().lines.map((l) => ({ ...l, carryingTxnMinor: 0n, valueOutMinor: 0n })),
    });
    expect(codeOf(() => supplierReturnPayload(zero))).toBe('supplier_return.value_zero');
  });

  it('the reason: trimmed, 1..500 characters, no NUL; NULL is eight NULL words', () => {
    expect(codeOf(() => supplierReturnPayload(ret({ reason: ' padded ' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ reason: '' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ reason: 'x'.repeat(501) })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ reason: 'x'.repeat(500) })))).toBe('accepted');
    expect(codeOf(() => supplierReturnPayload(ret({ reason: 'a\u0000b' })))).toBe('inventory.payload_invalid');
    const values = supplierReturnPayload(ret()).payload.bytes.toString('utf8').split('\n');
    expect(values.slice(8, 16)).toEqual(Array.from({ length: 8 }, () => '\u0000'));
  });

  it('non-canonical identifiers and dates', () => {
    expect(codeOf(() => supplierReturnPayload(ret({ returnId: RET.toUpperCase() })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ creditNoteId: 'not-a-uuid', creditTxnMinor: 0n })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierReturnPayload(ret({ documentDate: '2026-02-30' })))).toBe('inventory.payload_invalid');
  });
});
