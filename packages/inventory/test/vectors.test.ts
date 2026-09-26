import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderInventoryVectors, toPayloadField, type InventoryVectors } from '../scripts/vector-cases';
import { mintInventoryAssertion, parseInventoryAssertionKey, splitInventoryAssertion } from '../src/assertion';
import { canonicalInventoryPayload, INVENTORY_PAYLOAD_SCHEMAS, inventoryPayloadSha256 } from '../src/payload';

const FILE = join(__dirname, '..', 'vectors', 'invpl-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as InventoryVectors;

describe('vectors/invpl-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-vectors.ts after a SPEC change only)', () => {
    expect(renderInventoryVectors()).toBe(committed);
  });
});

describe('invpl/1 — the shared vectors', () => {
  const cases = vectors.invpl.cases;

  it('covers every P3-S1 operation kind, and every case the lock names', () => {
    for (const op of Object.keys(INVENTORY_PAYLOAD_SCHEMAS)) {
      expect(cases.filter((c) => c.opCode === op).length).toBeGreaterThanOrEqual(2);
    }
    const configure = cases.filter((c) => c.opCode === 'inventory.configure_product');
    const field = (c: (typeof cases)[number], name: string) => c.fields.find((f) => f.name === name)?.value;
    expect(configure.some((c) => field(c, 'unit_code') === null)).toBe(true);
    expect(configure.some((c) => field(c, 'unit_decimals') === null)).toBe(true);
    expect(configure.some((c) => field(c, 'unit_code') === null && field(c, 'unit_decimals') === null)).toBe(true);
    expect(configure.some((c) => field(c, 'unit_decimals') === 0)).toBe(true);
    expect(configure.some((c) => typeof field(c, 'unit_decimals') === 'number' && (field(c, 'unit_decimals') as number) < 0)).toBe(true);
  });

  for (const v of cases) {
    it(`${v.name}: canonical bytes and digest match the recorded vector`, () => {
      const schema = INVENTORY_PAYLOAD_SCHEMAS[v.opCode];
      expect(v.fields.map((f) => [f.name, f.type])).toEqual(schema.map((s) => [s.name, s.type]));
      const typed = v.fields.map((f) => toPayloadField(f.type, f.value));
      const bytes = canonicalInventoryPayload(v.opCode, v.tenantId, v.businessId, typed);
      expect(bytes.toString('hex')).toBe(v.canonicalHex);
      expect(inventoryPayloadSha256(v.opCode, v.tenantId, v.businessId, typed)).toBe(v.sha256);
      // The digest is the SHA-256 of the recorded bytes — independent of the canonicalizer.
      expect(createHash('sha256').update(Buffer.from(v.canonicalHex, 'hex')).digest('hex')).toBe(v.sha256);
      // And the recorded bytes are the spec's lines, assembled by hand.
      const lines = ['invpl/1', v.opCode, v.tenantId, v.businessId, ...v.fields.map((f) => (f.value === null ? '\u0000' : String(f.value)))];
      expect(Buffer.from(lines.map((l) => `${l}\n`).join(''), 'latin1').toString('hex')).toBe(v.canonicalHex);
    });
  }

  it('no two vectors share a digest', () => {
    expect(new Set(cases.map((c) => c.sha256)).size).toBe(cases.length);
  });

  it('associate and dissociate over identical ids differ', () => {
    const key = (c: (typeof cases)[number]) => `${c.tenantId}|${c.businessId}|${c.fields.map((f) => String(f.value)).join('|')}`;
    const associate = cases.filter((c) => c.opCode === 'structure.associate_warehouse_branch');
    const dissociate = cases.filter((c) => c.opCode === 'structure.dissociate_warehouse_branch');
    const pairs = associate.flatMap((a) => dissociate.filter((d) => key(d) === key(a)).map((d) => [a, d] as const));
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (const [a, d] of pairs) expect(a.sha256).not.toBe(d.sha256);
  });
});

describe('invctl/1 — the shared vectors', () => {
  const cases = vectors.invctl.cases;

  it('ships several assertion vectors', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  for (const v of cases) {
    it(`${v.name}: the fixed key, clock and jti mint exactly the recorded assertion`, () => {
      const key = parseInventoryAssertionKey({ kid: v.key.kid, keyBase64: v.key.keyBase64 });
      expect(key.secret.toString('hex')).toBe(v.key.secretHex);
      expect(mintInventoryAssertion(v.claims, key, new Date(v.now), v.ttlSeconds)).toBe(v.assertion);

      const parts = splitInventoryAssertion(v.assertion);
      expect(parts.components).toHaveLength(10);
      expect(parts.exp).toBe(v.exp);
      expect(Number(v.exp)).toBe(Math.floor(new Date(v.now).getTime() / 1000) + v.ttlSeconds);
      expect(parts.wireOperation).toBe(v.wireOperation);
      expect(parts.payloadSha256).toBe(v.claims.payloadSha256);
      expect(v.preimage).toBe(`invctl/1\n${parts.components.slice(0, 9).join('.')}`);
      // Independent of the minter: a plain HMAC over the recorded preimage.
      expect(createHmac('sha256', Buffer.from(v.key.secretHex, 'hex')).update(v.preimage, 'utf8').digest('hex')).toBe(v.mac);
      expect(parts.mac).toBe(v.mac);
      // The payload digest names a recorded invpl/1 vector.
      expect(vectors.invpl.cases.some((p) => p.sha256 === v.claims.payloadSha256 && p.opCode === v.claims.opCode)).toBe(true);
    });
  }
});
