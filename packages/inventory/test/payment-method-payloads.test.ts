import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderInvplS6Vectors, type InvplS6Vectors } from '../scripts/s6-vector-cases';
import { InventoryError } from '../src/errors';
import {
  canonicalInventoryIntent,
  canonicalInventoryPayload,
  INVENTORY_PAYLOAD_SCHEMAS,
  INVENTORY_S6_OPERATION_CODES,
  inventoryIntentSchema,
  inventoryIntentSha256,
  inventoryPayloadSha256,
  type InventoryPayloadField,
} from '../src/payload';
import {
  paymentMethodActivatePayload,
  paymentMethodCreatePayload,
  paymentMethodDeactivatePayload,
  paymentMethodUpdatePayload,
  PAYMENT_METHOD_SYSTEM_TYPES,
  type PaymentMethodCreatePayloadInput,
} from '../src/payment-method-payloads';

const FILE = join(__dirname, '..', 'vectors', 'invpl-s6-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as InvplS6Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const PM = 'a1b2c3d4-0006-4a00-8a00-000000000061';
const ACC = 'a1b2c3d4-0006-4a00-8a00-000000000062';

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

const create = (over: Partial<PaymentMethodCreatePayloadInput> = {}): PaymentMethodCreatePayloadInput => ({
  tenantId: T,
  businessId: B,
  paymentMethodId: PM,
  systemType: 'cash',
  postingAccountId: ACC,
  requiresReference: false,
  sortOrder: 0,
  names: { ar: 'نقدي', en: null, tr: null },
  ...over,
});

const METHOD_KINDS = INVENTORY_S6_OPERATION_CODES.filter((op) => op.startsWith('payment.'));

describe('vectors/invpl-s6-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-s6-vectors.ts after a SPEC change only)', async () => {
    expect(await renderInvplS6Vectors()).toBe(committed);
  });

  it('has a vector per P3-S6 kind, unique ids and no two equal payload digests', () => {
    for (const op of INVENTORY_S6_OPERATION_CODES) expect(vectors.cases.some((c) => c.opCode === op)).toBe(true);
    expect(new Set(vectors.cases.map((c) => c.id)).size).toBe(vectors.cases.length);
    const payloads = vectors.cases.map((c) => c.payload.sha256);
    expect(new Set(payloads).size).toBe(payloads.length);
  });
});

describe('invpl/1 P3-S6 payment-method kinds — the shared vectors', () => {
  for (const v of vectors.cases.filter((c) => c.opCode.startsWith('payment.'))) {
    it(`${v.id}: payload bytes and digest match, and the intent IS the payload (A-16)`, () => {
      const fields = v.payload.fields.map(typed);
      expect(canonicalInventoryPayload(v.opCode, v.tenantId, v.businessId, fields).toString('hex')).toBe(v.payload.canonicalHex);
      expect(inventoryPayloadSha256(v.opCode, v.tenantId, v.businessId, fields)).toBe(v.payload.sha256);
      expect(createHash('sha256').update(Buffer.from(v.payload.canonicalHex, 'hex')).digest('hex')).toBe(v.payload.sha256);
      expect(hexOfLines(['invpl/1', v.opCode, v.tenantId, v.businessId, ...v.payload.fields.map((f) => f.value)])).toBe(v.payload.canonicalHex);
      expect(canonicalInventoryIntent(v.opCode, v.tenantId, v.businessId, fields).toString('hex')).toBe(v.payload.canonicalHex);
      expect(inventoryIntentSha256(v.opCode, v.tenantId, v.businessId, fields)).toBe(v.payload.sha256);
      expect(v.intent.sha256).toBe(v.payload.sha256);
    });
  }

  it('a locale without a name is eight NULL words, and its routine argument is NULL', () => {
    const v = vectors.cases.find((c) => c.id === 'S6-PMC-01');
    expect(v?.routine.args['p_name_tr']).toBeNull();
    expect(v?.payload.fields.filter((f) => f.name.startsWith('name_tr_')).map((f) => f.value)).toEqual(Array.from({ length: 8 }, () => null));
    expect(v?.payload.fields.filter((f) => f.name.startsWith('name_ar_')).every((f) => f.value !== null)).toBe(true);
  });

  it('deactivate and activate share their fields and differ only by the op code line', () => {
    const d = vectors.cases.find((c) => c.id === 'S6-PMD-01');
    const a = vectors.cases.find((c) => c.id === 'S6-PMA-01');
    expect(d?.payload.fields).toEqual(a?.payload.fields);
    expect(d?.payload.sha256).not.toBe(a?.payload.sha256);
  });
});

describe('payment-method schemas (A-16)', () => {
  const names = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix}_w${i + 1}`);

  it('create and update: the fields in order, the three name groups nullable', () => {
    expect(INVENTORY_PAYLOAD_SCHEMAS['payment.create_method'].map((f) => f.name)).toEqual([
      'payment_method_id',
      'system_type',
      'posting_account_id',
      'requires_reference',
      'sort_order',
      ...names('name_ar'),
      ...names('name_en'),
      ...names('name_tr'),
    ]);
    expect(INVENTORY_PAYLOAD_SCHEMAS['payment.update_method'].map((f) => f.name)).toEqual([
      'payment_method_id',
      'expected_revision',
      'posting_account_id',
      'requires_reference',
      'sort_order',
      ...names('name_ar'),
      ...names('name_en'),
      ...names('name_tr'),
    ]);
    for (const op of ['payment.create_method', 'payment.update_method'] as const) {
      expect(
        INVENTORY_PAYLOAD_SCHEMAS[op].filter((f) => f.nullable).map((f) => f.name),
        op,
      ).toEqual([...names('name_ar'), ...names('name_en'), ...names('name_tr')]);
    }
  });

  it('deactivate and activate: payment_method_id, expected_revision', () => {
    for (const op of ['payment.deactivate_method', 'payment.activate_method'] as const) {
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => [f.name, f.type, f.nullable])).toEqual([
        ['payment_method_id', 'uuid', false],
        ['expected_revision', 'integer', false],
      ]);
    }
  });

  it('every method kind is all intent: its intent schema is its schema', () => {
    for (const op of METHOD_KINDS) expect(inventoryIntentSchema(op).map((f) => f.name)).toEqual(INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => f.name));
  });
});

describe('payment-method builders — refuse before the signature', () => {
  it('names: at least one locale (name_required), each trimmed 1..100 characters without NUL (name_invalid)', () => {
    expect(codeOf(() => paymentMethodCreatePayload(create()))).toBe('accepted');
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: null, en: null, tr: null } })))).toBe('payment_method.name_required');
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: null, en: ' Cash', tr: null } })))).toBe('payment_method.name_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: null, en: '', tr: null } })))).toBe('payment_method.name_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: null, en: 'x'.repeat(101), tr: null } })))).toBe('payment_method.name_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: null, en: 'x'.repeat(100), tr: null } })))).toBe('accepted');
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: 'a\u0000b', en: null, tr: null } })))).toBe('payment_method.name_invalid');
    // 100 code points, not 100 UTF-16 units: an astral character counts once, as char_length counts it.
    expect(codeOf(() => paymentMethodCreatePayload(create({ names: { ar: null, en: '💳'.repeat(100), tr: null } })))).toBe('accepted');
  });

  it('system_type, sort_order, the boolean and the ids', () => {
    for (const systemType of PAYMENT_METHOD_SYSTEM_TYPES) expect(codeOf(() => paymentMethodCreatePayload(create({ systemType })))).toBe('accepted');
    expect(codeOf(() => paymentMethodCreatePayload(create({ systemType: 'crypto' as 'cash' })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ sortOrder: -1 })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ sortOrder: 10001 })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ sortOrder: 1.5 })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ sortOrder: 10000 })))).toBe('accepted');
    expect(codeOf(() => paymentMethodCreatePayload(create({ paymentMethodId: PM.toUpperCase() })))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodCreatePayload(create({ postingAccountId: 'not-a-uuid' })))).toBe('inventory.payload_invalid');
  });

  it('a revision is a positive integer', () => {
    const base = { tenantId: T, businessId: B, paymentMethodId: PM };
    expect(codeOf(() => paymentMethodDeactivatePayload({ ...base, expectedRevision: 0 }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodActivatePayload({ ...base, expectedRevision: 2147483648 }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => paymentMethodActivatePayload({ ...base, expectedRevision: 1 }))).toBe('accepted');
    expect(
      codeOf(() =>
        paymentMethodUpdatePayload({
          ...base,
          expectedRevision: 0,
          postingAccountId: ACC,
          requiresReference: true,
          sortOrder: 1,
          names: { ar: 'x', en: null, tr: null },
        }),
      ),
    ).toBe('inventory.payload_invalid');
  });

  it('every field is intent: any change moves the digest', () => {
    const built = paymentMethodCreatePayload(create());
    expect(built.intentSha256).toBe(built.payload.sha256);
    for (const other of [
      create({ systemType: 'card' }),
      create({ postingAccountId: PM }),
      create({ requiresReference: true }),
      create({ sortOrder: 1 }),
      create({ names: { ar: 'نقدي', en: 'Cash', tr: null } }),
    ]) {
      expect(paymentMethodCreatePayload(other).intentSha256).not.toBe(built.intentSha256);
    }
  });
});
