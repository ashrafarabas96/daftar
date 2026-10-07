/**
 * The four P4-S1 customer kinds (gap G-5): the disjoint-preimage property, and
 * the refusals the builders make instead of repairing their input.
 *
 * The point of this file is the FIRST one. `customer.*` and `supplier.*` are two
 * command protocols over ONE signing secret — the same `invctl/1` minter signs
 * both — so what keeps a supplier authority from being replayed as a customer
 * authority cannot be parser shape. `customer.archive` and `supplier.archive`
 * have the SAME field list, type for type and nullable for nullable; so do
 * `customer.archive` and `customer.reactivate`. Nothing about their structure
 * tells them apart. What does is the op_code line inside the signed stream, and
 * that is proved here byte by byte rather than asserted in a comment.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  customerArchivePayload,
  customerCreatePayload,
  customerReactivatePayload,
  customerUpdatePayload,
  CUSTOMER_TEXT_BOUNDS,
  type CustomerText,
} from '../src/customer-payloads';
import { InventoryError } from '../src/errors';
import { INVENTORY_PAYLOAD_SCHEMAS } from '../src/payload';
import { normalizeDocumentText, supplierArchivePayload, supplierCreatePayload, supplierReactivatePayload } from '../src/supplier-payloads';

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
/** ONE id, used as both the customer id and the supplier id, so nothing but the code differs. */
const ID = 'a1b2c3d4-0401-4a00-8a00-000000000001';
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

const plain: CustomerText = { name: 'Acme', phone: null, email: null, notes: null };
const full: CustomerText = { name: 'Acme Trading', phone: '+9611234567', email: 'a@b.co', notes: 'pays late' };

// ── The stream, assembled by hand from the spec rather than by the code ──────
const LF = Buffer.from([0x0a]);
const NULL_LINE = Buffer.from([0x00]);
const stream = (...lines: (string | Buffer)[]): Buffer => Buffer.concat(lines.flatMap((l) => [typeof l === 'string' ? Buffer.from(l, 'ascii') : l, LF]));
const textLines = (text: string | null): (string | Buffer)[] => {
  if (text === null) return Array.from({ length: 8 }, () => NULL_LINE);
  const d = createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
  return Array.from({ length: 8 }, (_, i) => String(d.readUInt32BE(i * 4)));
};

describe('customer.* builders follow the lock field order', () => {
  it('customer.create: customer_id then the four word groups, each eight uint32 lines', () => {
    const p = customerCreatePayload({ ...tb, customerId: ID, ...full });
    expect(p.payload.opCode).toBe('customer.create');
    expect(
      p.payload.bytes.equals(
        stream('invpl/1', 'customer.create', T, B, ID, ...textLines(full.name), ...textLines(full.phone), ...textLines(full.email), ...textLines(full.notes)),
      ),
    ).toBe(true);
    expect(p.payload.sha256).toBe(createHash('sha256').update(p.payload.bytes).digest('hex'));
    // Every field is intent, so the intent digest IS the payload digest.
    expect(p.intentSha256).toBe(p.payload.sha256);
    expect(INVENTORY_PAYLOAD_SCHEMAS['customer.create'].length).toBe(33);
  });

  it('a NULL text is eight 0x00 lines, never an empty line and never a zero', () => {
    const p = customerCreatePayload({ ...tb, customerId: ID, ...plain });
    expect(
      p.payload.bytes.equals(stream('invpl/1', 'customer.create', T, B, ID, ...textLines('Acme'), ...textLines(null), ...textLines(null), ...textLines(null))),
    ).toBe(true);
  });

  it('customer.update puts expected_revision second; archive and reactivate are the id and the revision', () => {
    const u = customerUpdatePayload({ ...tb, customerId: ID, expectedRevision: 7, ...plain });
    expect(
      u.payload.bytes.equals(
        stream('invpl/1', 'customer.update', T, B, ID, '7', ...textLines('Acme'), ...textLines(null), ...textLines(null), ...textLines(null)),
      ),
    ).toBe(true);
    expect(
      customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 7 }).payload.bytes.equals(stream('invpl/1', 'customer.archive', T, B, ID, '7')),
    ).toBe(true);
    expect(
      customerReactivatePayload({ ...tb, customerId: ID, expectedRevision: 7 }).payload.bytes.equals(stream('invpl/1', 'customer.reactivate', T, B, ID, '7')),
    ).toBe(true);
    for (const p of [
      u,
      customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 7 }),
      customerReactivatePayload({ ...tb, customerId: ID, expectedRevision: 7 }),
    ]) {
      expect(p.intentSha256).toBe(p.payload.sha256);
    }
  });
});

describe('disjoint preimages — proved, not asserted (one signing secret, two protocols)', () => {
  const shape = (op: 'customer.create' | 'supplier.create' | 'customer.archive' | 'supplier.archive' | 'customer.reactivate' | 'supplier.reactivate') =>
    INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => [f.type, f.nullable]);

  it('customer.archive and supplier.archive have IDENTICAL field lists, type for type and nullable for nullable', () => {
    expect(shape('customer.archive')).toEqual(shape('supplier.archive'));
    expect(shape('customer.archive')).toEqual([
      ['uuid', false],
      ['integer', false],
    ]);
    // Structurally indistinguishable — and still different bytes and digests,
    // because the code is a line of the signed stream.
    const c = customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 3 }).payload;
    const s = supplierArchivePayload({ ...tb, supplierId: ID, expectedRevision: 3 }).payload;
    expect(c.bytes.equals(s.bytes)).toBe(false);
    expect(c.sha256).not.toBe(s.sha256);
    expect(c.bytes.toString('utf8').split('\n')[1]).toBe('customer.archive');
    expect(s.bytes.toString('utf8').split('\n')[1]).toBe('supplier.archive');
    // The two streams differ ONLY on that line.
    const cl = c.bytes.toString('utf8').split('\n');
    const sl = s.bytes.toString('utf8').split('\n');
    expect(cl.length).toBe(sl.length);
    expect(cl.filter((l, i) => l !== sl[i])).toEqual(['customer.archive']);
  });

  it('customer.archive and customer.reactivate are separated ONLY by the code in the signed stream', () => {
    expect(INVENTORY_PAYLOAD_SCHEMAS['customer.archive'].map((f) => [f.name, f.type, f.nullable])).toEqual(
      INVENTORY_PAYLOAD_SCHEMAS['customer.reactivate'].map((f) => [f.name, f.type, f.nullable]),
    );
    const a = customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 3 }).payload;
    const r = customerReactivatePayload({ ...tb, customerId: ID, expectedRevision: 3 }).payload;
    expect(a.bytes.length).toBe(r.bytes.length - ('reactivate'.length - 'archive'.length));
    expect(a.sha256).not.toBe(r.sha256);
    const al = a.bytes.toString('utf8').split('\n');
    const rl = r.bytes.toString('utf8').split('\n');
    expect(al.filter((l, i) => l !== rl[i])).toEqual(['customer.archive']);
    expect(rl.filter((l, i) => l !== al[i])).toEqual(['customer.reactivate']);
    // So reactivation has to be its own KIND: a direction flag would make the
    // two preimages identical up to one field value the minter never sees.
    expect(a.opCode).not.toBe(r.opCode);
    // The same holds on the supplier side, which is the precedent.
    expect(supplierArchivePayload({ ...tb, supplierId: ID, expectedRevision: 3 }).payload.sha256).not.toBe(
      supplierReactivatePayload({ ...tb, supplierId: ID, expectedRevision: 3 }).payload.sha256,
    );
  });

  it('customer.create and supplier.create share the same text binding and still cannot collide', () => {
    // The two creates are not the same LENGTH — the customer has no tax
    // identifier group (P4-AL-44/45) — but length is parser shape, and parser
    // shape is exactly what may not be relied on. So: the same id, the same
    // name, phone, email and notes, bound by the same `documentTextWords`.
    const c = customerCreatePayload({ ...tb, customerId: ID, ...full }).payload;
    const s = supplierCreatePayload({ ...tb, supplierId: ID, ...full, taxIdentifier: null }).payload;
    expect(c.bytes.equals(s.bytes)).toBe(false);
    expect(c.sha256).not.toBe(s.sha256);
    // Neither stream is a prefix or a substring of the other, so no length
    // confusion can turn one into the other.
    expect(s.bytes.includes(c.bytes)).toBe(false);
    expect(c.bytes.includes(s.bytes)).toBe(false);
    // The code is present in the signed stream, as its own whole line.
    expect(c.bytes.includes(Buffer.from('\ncustomer.create\n', 'ascii'))).toBe(true);
    expect(s.bytes.includes(Buffer.from('\nsupplier.create\n', 'ascii'))).toBe(true);
    // The word groups the two DO share are byte-identical, which is what makes
    // the code line the only separator that is doing any work.
    const shared = (b: Buffer): string[] => b.toString('utf8').split('\n').slice(5, 29);
    expect(shared(c.bytes)).toEqual(shared(s.bytes));
  });

  it('every one of the four customer digests is distinct, and distinct from its supplier twin', () => {
    const digests = [
      customerCreatePayload({ ...tb, customerId: ID, ...plain }).payload.sha256,
      customerUpdatePayload({ ...tb, customerId: ID, expectedRevision: 1, ...plain }).payload.sha256,
      customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 1 }).payload.sha256,
      customerReactivatePayload({ ...tb, customerId: ID, expectedRevision: 1 }).payload.sha256,
      supplierCreatePayload({ ...tb, supplierId: ID, ...plain, taxIdentifier: null }).payload.sha256,
      supplierArchivePayload({ ...tb, supplierId: ID, expectedRevision: 1 }).payload.sha256,
      supplierReactivatePayload({ ...tb, supplierId: ID, expectedRevision: 1 }).payload.sha256,
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('the tenant and the business are in the preimage too, so one business cannot replay another', () => {
    const other = '00000000-0000-4000-8000-000000000001';
    const base = customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 1 }).payload.sha256;
    for (const v of [
      { tenantId: other, businessId: B, customerId: ID, expectedRevision: 1 },
      { tenantId: T, businessId: other, customerId: ID, expectedRevision: 1 },
      { tenantId: T, businessId: B, customerId: other, expectedRevision: 1 },
      { tenantId: T, businessId: B, customerId: ID, expectedRevision: 2 },
    ]) {
      expect(customerArchivePayload(v).payload.sha256).not.toBe(base);
    }
  });
});

describe('the builders refuse rather than repair', () => {
  const create = (over: Partial<CustomerText & { customerId: string }>) => () => customerCreatePayload({ ...tb, customerId: ID, ...plain, ...over });

  it('refuses un-trimmed and empty text instead of normalizing it', () => {
    for (const bad of [' Acme', 'Acme ', '\tAcme', 'Acme\n', '']) expect(codeOf(create({ name: bad }))).toBe('inventory.payload_invalid');
    for (const bad of [' 1234', '1234 ', '']) expect(codeOf(create({ phone: bad }))).toBe('inventory.payload_invalid');
    // Normalization is the SERVICE's one step, and it is available — the
    // builder simply refuses anything it did not already do.
    expect(normalizeDocumentText('  Acme \n')).toBe('Acme');
    expect(normalizeDocumentText('   ')).toBeNull();
    expect(codeOf(create({ name: normalizeDocumentText('  Acme \n') as string }))).toBe('accepted');
  });

  it('refuses NUL and a lone surrogate — text with no exact UTF-8 bytes', () => {
    for (const bad of ['a\u0000b', '\u0000', 'A\uD800', '\uDC00A', 'x\uD83Dy']) {
      expect(codeOf(create({ name: bad }))).toBe('inventory.payload_invalid');
      expect(codeOf(create({ notes: bad }))).toBe('inventory.payload_invalid');
    }
    // A well-formed surrogate PAIR is ordinary text and is accepted.
    expect(codeOf(create({ name: 'Acme \u{1F600}' }))).toBe('accepted');
  });

  it('refuses over-length text at each field bound, and accepts the bound exactly', () => {
    const cases: [keyof CustomerText, { min: number; max: number }][] = [
      ['name', CUSTOMER_TEXT_BOUNDS.name],
      ['phone', CUSTOMER_TEXT_BOUNDS.phone],
      ['email', CUSTOMER_TEXT_BOUNDS.email],
      ['notes', CUSTOMER_TEXT_BOUNDS.notes],
    ];
    for (const [field, bounds] of cases) {
      expect(codeOf(create({ [field]: 'a'.repeat(bounds.max) } as Partial<CustomerText>))).toBe('accepted');
      expect(codeOf(create({ [field]: 'a'.repeat(bounds.max + 1) } as Partial<CustomerText>))).toBe('inventory.payload_invalid');
      if (bounds.min > 1) expect(codeOf(create({ [field]: 'a'.repeat(bounds.min - 1) } as Partial<CustomerText>))).toBe('inventory.payload_invalid');
    }
    // Length is counted in CODE POINTS, as PostgreSQL's char_length is.
    expect(codeOf(create({ phone: '\u{1F600}'.repeat(CUSTOMER_TEXT_BOUNDS.phone.max) }))).toBe('accepted');
    expect(codeOf(create({ phone: '\u{1F600}'.repeat(CUSTOMER_TEXT_BOUNDS.phone.max + 1) }))).toBe('inventory.payload_invalid');
  });

  it('refuses a non-canonical uuid — an uppercase one is never lowercased', () => {
    expect(codeOf(create({ customerId: ID.toUpperCase() }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => customerCreatePayload({ ...tb, tenantId: T.toUpperCase(), customerId: ID, ...plain }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => customerCreatePayload({ ...tb, businessId: B.toUpperCase(), customerId: ID, ...plain }))).toBe('inventory.payload_invalid');
    for (const bad of ['not-a-uuid', '', `${ID} `, ID.replace(/-/g, '')]) {
      expect(codeOf(() => customerArchivePayload({ ...tb, customerId: bad, expectedRevision: 1 }))).toBe('inventory.payload_invalid');
    }
  });

  it('refuses a revision of 0, a negative one and a fractional one; 1 is the lowest a client can have read', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
      expect(codeOf(() => customerArchivePayload({ ...tb, customerId: ID, expectedRevision: bad }))).toBe('inventory.payload_invalid');
      expect(codeOf(() => customerReactivatePayload({ ...tb, customerId: ID, expectedRevision: bad }))).toBe('inventory.payload_invalid');
      expect(codeOf(() => customerUpdatePayload({ ...tb, customerId: ID, expectedRevision: bad, ...plain }))).toBe('inventory.payload_invalid');
    }
    expect(codeOf(() => customerArchivePayload({ ...tb, customerId: ID, expectedRevision: 1 }))).toBe('accepted');
  });
});
