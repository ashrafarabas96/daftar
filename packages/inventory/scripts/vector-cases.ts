/**
 * The shared `invpl/1` and `invctl/1` vectors, as a pure function.
 *
 * `scripts/generate-vectors.ts` writes the result to
 * `vectors/invpl-vectors.json`; `test/vectors.test.ts` rebuilds it and
 * requires the committed file to be identical, so the JSON can never drift
 * from the code. The SQL canonicalizer (P3-AL-55 §F) is tested against the
 * SAME file — nobody may hand-copy a vector into a second place.
 *
 * Regenerating is legitimate only when the SPEC changed. If a regeneration
 * changes an existing digest, the SQL parity test fails, which is exactly the
 * alarm it exists to raise.
 */
import { createHmac } from 'node:crypto';
import {
  INVENTORY_ASSERTION_TTL_SECONDS,
  inventoryAssertionPreimage,
  mintInventoryAssertion,
  parseInventoryAssertionKey,
  splitInventoryAssertion,
  type InventoryAssertionClaims,
} from '../src/assertion';
import {
  canonicalInventoryPayload,
  INVENTORY_PAYLOAD_SCHEMAS,
  inventoryPayloadSha256,
  type InventoryOperationCode,
  type InventoryPayloadField,
  type InventoryPayloadFieldType,
} from '../src/payload';

/** A field as it appears in the JSON: the declared type, and the value or JSON null for SQL NULL. */
export interface VectorField {
  readonly name: string;
  readonly type: InventoryPayloadFieldType;
  readonly value: string | boolean | number | null;
}

export interface PayloadVector {
  readonly name: string;
  readonly why: string;
  readonly opCode: InventoryOperationCode;
  readonly tenantId: string;
  readonly businessId: string;
  readonly fields: readonly VectorField[];
  readonly canonicalHex: string;
  readonly sha256: string;
}

export interface AssertionVector {
  readonly name: string;
  readonly why: string;
  readonly key: { readonly kid: string; readonly keyBase64: string; readonly secretHex: string };
  readonly claims: Required<InventoryAssertionClaims>;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly exp: string;
  readonly wireOperation: string;
  /** The MAC preimage as text: `invctl/1`, one LF, then components 1–9 joined by `.`. */
  readonly preimage: string;
  readonly mac: string;
  readonly assertion: string;
}

export interface InventoryVectors {
  readonly spec: string;
  readonly note: string;
  readonly invpl: { readonly cases: readonly PayloadVector[] };
  readonly invctl: { readonly cases: readonly AssertionVector[] };
}

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const B2 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e';
const P = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const BR1 = '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301';
const BR2 = '2c5f39cb-3fb2-11d2-9a0c-0305e82c3302';
const ACTOR = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

interface RawPayloadCase {
  readonly name: string;
  readonly why: string;
  readonly opCode: InventoryOperationCode;
  readonly businessId?: string;
  readonly values: readonly (string | boolean | number | null)[];
}

const payloadCases: readonly RawPayloadCase[] = [
  {
    name: 'configure_track_piece_0',
    why: 'enable tracking in whole pieces; unit_decimals = 0 encodes as the single digit 0',
    opCode: 'inventory.configure_product',
    values: [P, true, 'piece', 0],
  },
  {
    name: 'configure_track_kg_3',
    why: 'enable tracking by weight with three decimals',
    opCode: 'inventory.configure_product',
    values: [P, true, 'kg', 3],
  },
  {
    name: 'configure_untracked_null_null',
    why: 'NULL unit_code and NULL unit_decimals: each line is the single byte 0x00',
    opCode: 'inventory.configure_product',
    values: [P, false, null, null],
  },
  {
    name: 'configure_untracked_units_kept',
    why: 'disabling tracking keeps the frozen units; false plus non-NULL units',
    opCode: 'inventory.configure_product',
    values: [P, false, 'litre', 2],
  },
  {
    name: 'configure_null_code_decimals_0',
    why: 'NULL unit_code with unit_decimals = 0: the two nullable fields encode independently (0x00 then 0x30)',
    opCode: 'inventory.configure_product',
    values: [P, false, null, 0],
  },
  {
    name: 'configure_code_null_decimals',
    why: 'non-NULL unit_code with NULL unit_decimals',
    opCode: 'inventory.configure_product',
    values: [P, false, 'box', null],
  },
  {
    name: 'configure_negative_decimals',
    why: 'negative integer encoding (-1). unit_decimals is the only integer field in P3-S1; the domain refuses a negative value AFTER verification (CHECK 0..4), so the digest must still be computed identically by both canonicalizers',
    opCode: 'inventory.configure_product',
    values: [P, true, 'piece', -1],
  },
  {
    name: 'configure_smallint_max',
    why: 'multi-digit integer with no leading zero (smallint max 32767)',
    opCode: 'inventory.configure_product',
    values: [P, true, 'dozen', 32767],
  },
  {
    name: 'configure_code_32_chars',
    why: 'longest registry code (32 bytes) with digits and underscores, bytes verbatim',
    opCode: 'inventory.configure_product',
    values: [P, true, 'u0_long_unit_code_with_digits_99', 4],
  },
  {
    name: 'configure_other_business',
    why: 'same product and units as configure_track_piece_0 under another business: the business line changes the digest',
    opCode: 'inventory.configure_product',
    businessId: B2,
    values: [P, true, 'piece', 0],
  },
  {
    name: 'associate_w1_br1',
    why: 'associate warehouse W1 with branch BR1',
    opCode: 'structure.associate_warehouse_branch',
    values: [W1, BR1],
  },
  {
    name: 'associate_w1_br2',
    why: 'same warehouse, another branch: an assertion for W1+BR1 must not authorize W1+BR2',
    opCode: 'structure.associate_warehouse_branch',
    values: [W1, BR2],
  },
  {
    name: 'associate_w2_br1',
    why: 'another warehouse, same branch: an assertion for W1+BR1 must not authorize W2+BR1',
    opCode: 'structure.associate_warehouse_branch',
    values: [W2, BR1],
  },
  {
    name: 'associate_br1_w1_swapped',
    why: 'the two ids in the other order: field order is significant',
    opCode: 'structure.associate_warehouse_branch',
    values: [BR1, W1],
  },
  {
    name: 'dissociate_w1_br1',
    why: 'identical ids to associate_w1_br1: only the op_code line differs, and so must the digest',
    opCode: 'structure.dissociate_warehouse_branch',
    values: [W1, BR1],
  },
  {
    name: 'dissociate_w1_br2',
    why: 'identical ids to associate_w1_br2 under dissociate',
    opCode: 'structure.dissociate_warehouse_branch',
    values: [W1, BR2],
  },
  {
    name: 'dissociate_w1_br1_other_business',
    why: 'identical to dissociate_w1_br1 under another business',
    opCode: 'structure.dissociate_warehouse_branch',
    businessId: B2,
    values: [W1, BR1],
  },
];

/** Turn a JSON value into the typed field the canonicalizer takes. */
export function toPayloadField(type: InventoryPayloadFieldType, value: string | boolean | number | null): InventoryPayloadField {
  if (value === null) return { kind: 'null' };
  switch (type) {
    case 'uuid':
      return { kind: 'uuid', value: value as string };
    case 'boolean':
      return { kind: 'boolean', value: value as boolean };
    case 'integer':
      return { kind: 'integer', value: value as number };
    case 'code':
      return { kind: 'code', value: value as string };
  }
}

function buildPayloadVector(c: RawPayloadCase): PayloadVector {
  const schema = INVENTORY_PAYLOAD_SCHEMAS[c.opCode];
  if (schema.length !== c.values.length) throw new Error(`vector ${c.name} has the wrong field count`);
  const fields: VectorField[] = schema.map((spec, i) => ({ name: spec.name, type: spec.type, value: c.values[i] ?? null }));
  const typed = fields.map((f) => toPayloadField(f.type, f.value));
  const businessId = c.businessId ?? B;
  return {
    name: c.name,
    why: c.why,
    opCode: c.opCode,
    tenantId: T,
    businessId,
    fields,
    canonicalHex: canonicalInventoryPayload(c.opCode, T, businessId, typed).toString('hex'),
    sha256: inventoryPayloadSha256(c.opCode, T, businessId, typed),
  };
}

/** Low-entropy test keys: never a real secret. Key B is longer than the HMAC block, so HMAC hashes it first. */
const KEY_A = { kid: 'inv-p3s1_a', keyBase64: Buffer.alloc(32, 0x07).toString('base64') };
const KEY_B = { kid: 'invB', keyBase64: Buffer.alloc(72, 0x2a).toString('base64') };

interface RawAssertionCase {
  readonly name: string;
  readonly why: string;
  readonly key: { readonly kid: string; readonly keyBase64: string };
  readonly payload: string;
  readonly jti: string;
  readonly now: string;
  readonly ttlSeconds: number;
}

const assertionCases: readonly RawAssertionCase[] = [
  {
    name: 'configure_default_ttl',
    why: 'configure_track_piece_0 minted at a fractional second: exp = floor(now) + 60',
    key: KEY_A,
    payload: 'configure_track_piece_0',
    jti: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    now: '2026-09-26T08:00:00.750Z',
    ttlSeconds: INVENTORY_ASSERTION_TTL_SECONDS,
  },
  {
    name: 'associate_ttl_1',
    why: 'associate_w1_br1 with the minimum TTL of one second',
    key: KEY_A,
    payload: 'associate_w1_br1',
    jti: '16fd2706-8baf-433b-82eb-8c7fada847da',
    now: '2026-09-26T08:00:00.000Z',
    ttlSeconds: 1,
  },
  {
    name: 'dissociate_long_key',
    why: 'dissociate_w1_br1 under a 72-byte key (longer than the HMAC block) at the last millisecond of a second',
    key: KEY_B,
    payload: 'dissociate_w1_br1',
    jti: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    now: '2026-09-26T08:00:59.999Z',
    ttlSeconds: INVENTORY_ASSERTION_TTL_SECONDS,
  },
];

function buildAssertionVector(c: RawAssertionCase, payloads: readonly PayloadVector[]): AssertionVector {
  const payload = payloads.find((p) => p.name === c.payload);
  if (payload === undefined) throw new Error(`assertion vector ${c.name} names an unknown payload vector`);
  const key = parseInventoryAssertionKey(c.key);
  const claims: Required<InventoryAssertionClaims> = {
    actorUserId: ACTOR,
    tenantId: payload.tenantId,
    businessId: payload.businessId,
    opCode: payload.opCode,
    payloadSha256: payload.sha256,
    jti: c.jti,
  };
  const assertion = mintInventoryAssertion(claims, key, new Date(c.now), c.ttlSeconds);
  const parts = splitInventoryAssertion(assertion);
  const preimage = inventoryAssertionPreimage(parts.components.slice(0, 9));
  // Cross-check the minter against a plain HMAC over the preimage, so the
  // vector records what the spec says rather than what the minter happens to do.
  const mac = createHmac('sha256', key.secret).update(preimage).digest('hex');
  if (mac !== parts.mac) throw new Error(`assertion vector ${c.name}: minted MAC disagrees with the preimage HMAC`);
  return {
    name: c.name,
    why: c.why,
    key: { kid: key.kid, keyBase64: c.key.keyBase64, secretHex: key.secret.toString('hex') },
    claims,
    now: c.now,
    ttlSeconds: c.ttlSeconds,
    exp: parts.exp,
    wireOperation: parts.wireOperation,
    preimage: preimage.toString('utf8'),
    mac,
    assertion,
  };
}

export function buildInventoryVectors(): InventoryVectors {
  const payloads = payloadCases.map(buildPayloadVector);
  return {
    spec: 'invpl/1 + invctl/1 (P3-AL-55 §D, §F)',
    note:
      'Generated by packages/inventory/scripts/generate-vectors.ts and verified by packages/inventory/test/vectors.test.ts. ' +
      'One source for BOTH the TypeScript and PostgreSQL invpl/1 canonicalizers. canonicalHex is the exact stream: ' +
      '696e76706c2f310a is "invpl/1" LF, 0a terminates every line, and a line that is only 00 is SQL NULL. ' +
      'A field value of JSON null means SQL NULL of the declared type. The invctl cases fix the key, the clock and the jti; ' +
      'they are for MAC and format parity only, are never presented to a live verifier, and expire at 2026-09-26T08:01:00Z. ' +
      'The keys are low-entropy test material, never a deployed secret.',
    invpl: { cases: payloads },
    invctl: { cases: assertionCases.map((c) => buildAssertionVector(c, payloads)) },
  };
}

/** The exact text of `vectors/invpl-vectors.json`. */
export function renderInventoryVectors(): string {
  return `${JSON.stringify(buildInventoryVectors(), null, 2)}\n`;
}
