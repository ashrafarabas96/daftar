import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InvplS4Vectors } from '../scripts/s4-vector-cases';
import { InventoryError } from '../src/errors';
import { INVENTORY_PAYLOAD_SCHEMAS } from '../src/payload';
import {
  documentTextWords,
  normalizeDocumentText,
  supplierArchivePayload,
  supplierCreatePayload,
  supplierReactivatePayload,
  supplierUpdatePayload,
  type SupplierText,
} from '../src/supplier-payloads';

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'invpl-s4-vectors.json'), 'utf8')) as InvplS4Vectors;

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const SUP = 'a1b2c3d4-0001-4a00-8a00-000000000001';
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

const plain: SupplierText = { name: 'Acme', phone: null, email: null, taxIdentifier: null, notes: null };

describe('document text binding (A-09)', () => {
  it('the text vectors are the SHA-256 of the exact UTF-8, as eight uint32 words', () => {
    for (const v of vectors.texts) {
      expect(Buffer.from(v.text, 'utf8').toString('hex')).toBe(v.utf8Hex);
      expect(createHash('sha256').update(Buffer.from(v.utf8Hex, 'hex')).digest('hex')).toBe(v.sha256);
      expect(documentTextWords(v.text, v.id, { min: 1, max: 1000 }).map((w) => (w === null ? null : w.toString(10)))).toEqual(v.words);
    }
  });

  it('NULL text is eight NULL words', () => {
    expect(documentTextWords(null, 'x', { min: 1, max: 1 })).toEqual([null, null, null, null, null, null, null, null]);
  });

  it('normalizes once (trim, empty is NULL) and the binding refuses anything not normalized', () => {
    expect(normalizeDocumentText('  Acme \n')).toBe('Acme');
    expect(normalizeDocumentText('   ')).toBeNull();
    expect(normalizeDocumentText(undefined)).toBeNull();
    expect(normalizeDocumentText(null)).toBeNull();
    for (const bad of [' Acme', 'Acme ', '', 'a\u0000b', '\uD800x']) {
      expect(codeOf(() => documentTextWords(bad, 'x', { min: 1, max: 10 }))).toBe('inventory.payload_invalid');
    }
  });

  it('counts characters as code points, as char_length does', () => {
    expect(codeOf(() => documentTextWords('📦'.repeat(40), 'phone', { min: 1, max: 40 }))).toBe('accepted');
    expect(codeOf(() => documentTextWords('📦'.repeat(41), 'phone', { min: 1, max: 40 }))).toBe('inventory.payload_invalid');
  });
});

describe('supplier payloads (A-09, A-11)', () => {
  it('create: supplier_id then five word groups; every field is intent', () => {
    const p = supplierCreatePayload({ ...tb, supplierId: SUP, ...plain });
    expect(p.intentSha256).toBe(p.payload.sha256);
    expect(INVENTORY_PAYLOAD_SCHEMAS['supplier.create']).toHaveLength(1 + 5 * 8);
    expect(p.payload.sha256).toBe(vectors.cases.find((c) => c.id === 'S4-SUP-CRT-02')?.payload.sha256);
  });

  it('refuses a missing or over-long name and the A-11 bounds of each field', () => {
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, name: '' }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, name: 'n'.repeat(200) }))).toBe('accepted');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, name: 'n'.repeat(201) }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, phone: 'p'.repeat(41) }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, email: 'ab' }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, taxIdentifier: 't'.repeat(65) }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, notes: 'n'.repeat(1001) }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => supplierCreatePayload({ ...tb, supplierId: SUP.toUpperCase(), ...plain }))).toBe('inventory.payload_invalid');
  });

  it('update binds the expected revision (>= 1); archive and reactivate differ by op code alone', () => {
    const u1 = supplierUpdatePayload({ ...tb, supplierId: SUP, expectedRevision: 1, ...plain });
    const u2 = supplierUpdatePayload({ ...tb, supplierId: SUP, expectedRevision: 2, ...plain });
    expect(u1.payload.sha256).not.toBe(u2.payload.sha256);
    expect(codeOf(() => supplierUpdatePayload({ ...tb, supplierId: SUP, expectedRevision: 0, ...plain }))).toBe('inventory.payload_invalid');
    const a = supplierArchivePayload({ ...tb, supplierId: SUP, expectedRevision: 2 });
    const r = supplierReactivatePayload({ ...tb, supplierId: SUP, expectedRevision: 2 });
    expect(a.payload.bytes.toString('utf8').split('\n').slice(2)).toEqual(r.payload.bytes.toString('utf8').split('\n').slice(2));
    expect(a.payload.sha256).not.toBe(r.payload.sha256);
    expect(codeOf(() => supplierArchivePayload({ ...tb, supplierId: SUP, expectedRevision: 1.5 }))).toBe('inventory.payload_invalid');
  });

  it('a changed text field is a different payload; a NULL field differs from any text', () => {
    const base = supplierCreatePayload({ ...tb, supplierId: SUP, ...plain }).payload.sha256;
    expect(supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, name: 'Acmf' }).payload.sha256).not.toBe(base);
    expect(supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, notes: 'x' }).payload.sha256).not.toBe(base);
    // The same text in another field is another stream.
    expect(supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, phone: 'x' }).payload.sha256).not.toBe(
      supplierCreatePayload({ ...tb, supplierId: SUP, ...plain, notes: 'x' }).payload.sha256,
    );
  });
});
