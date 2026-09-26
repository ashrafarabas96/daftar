import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INVCTL_DOMAIN,
  INVCTL_VERSION,
  INVENTORY_ASSERTION_COMPONENTS,
  INVENTORY_ASSERTION_TTL_SECONDS,
  inventoryAssertionPreimage,
  mintInventoryAssertion,
  operationCodeFromWire,
  parseInventoryAssertionKey,
  hmacKeysEquivalent,
  secretsAreIdentical,
  splitInventoryAssertion,
  wireOperationCode,
  type InventoryAssertionClaims,
  type InventoryAssertionKey,
} from '../src/assertion';
import { InventoryError } from '../src/errors';
import { associateWarehouseBranchPayload, INVENTORY_OPERATION_CODES, type InventoryOperationCode } from '../src/payload';

const key: InventoryAssertionKey = { kid: 'inv1', secret: Buffer.alloc(32, 7) };
const NOW = new Date('2026-09-26T08:00:00.750Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const JTI = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

const claims: InventoryAssertionClaims = {
  actorUserId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  tenantId: T,
  businessId: B,
  opCode: 'structure.associate_warehouse_branch',
  payloadSha256: associateWarehouseBranchPayload({
    tenantId: T,
    businessId: B,
    warehouseId: '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303',
    branchId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301',
  }).sha256,
};

const COMPONENT_PATTERNS: readonly RegExp[] = [
  /^invctl1$/,
  /^[A-Za-z0-9_-]{1,32}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[a-z]+(:[a-z_]+)+$/,
  /^[0-9a-f]{64}$/,
  /^[1-9][0-9]{0,18}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[0-9a-f]{64}$/,
];

const expectMalformed = (fn: () => unknown): void => {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(InventoryError);
  expect((caught as InventoryError).code).toBe('inventory.assertion_malformed');
};

describe('invctl/1 — the ten-component wire format (P3-AL-55 §D)', () => {
  it('mints exactly ten dot-separated components, each matching its locked pattern', () => {
    const parts = mintInventoryAssertion(claims, key, NOW).split('.');
    expect(INVENTORY_ASSERTION_COMPONENTS).toBe(10);
    expect(parts).toHaveLength(10);
    parts.forEach((p, i) => expect(p).toMatch(COMPONENT_PATTERNS[i] as RegExp));
  });

  it('places every claim in the documented position', () => {
    const p = mintInventoryAssertion({ ...claims, jti: JTI }, key, NOW).split('.');
    expect(p[0]).toBe(INVCTL_VERSION);
    expect(p[0]).toBe('invctl1');
    expect(p[1]).toBe('inv1');
    expect(p[2]).toBe(claims.actorUserId);
    expect(p[3]).toBe(claims.tenantId);
    expect(p[4]).toBe(claims.businessId);
    expect(p[5]).toBe('structure:associate_warehouse_branch');
    expect(p[6]).toBe(claims.payloadSha256);
    expect(p[7]).toBe(String(NOW_S + 60));
    expect(p[8]).toBe(JTI);
  });

  it('the MAC is HMAC-SHA-256 over "invctl/1" LF and components 1..9 joined by "."', () => {
    const raw = mintInventoryAssertion(claims, key, NOW);
    const parts = raw.split('.');
    const preimage = Buffer.concat([Buffer.from('invctl/1', 'utf8'), Buffer.from([0x0a]), Buffer.from(parts.slice(0, 9).join('.'), 'utf8')]);
    expect(parts[9]).toBe(createHmac('sha256', key.secret).update(preimage).digest('hex'));
    expect(inventoryAssertionPreimage(parts.slice(0, 9)).equals(preimage)).toBe(true);
    expect(INVCTL_DOMAIN).toBe('invctl/1');
  });

  it('is domain-separated: the MAC is not the HMAC of the claims alone, and the preimage cannot begin "v1." or "acctctl/1"', () => {
    const parts = mintInventoryAssertion(claims, key, NOW).split('.');
    const bare = createHmac('sha256', key.secret).update(parts.slice(0, 9).join('.'), 'utf8').digest('hex');
    expect(parts[9]).not.toBe(bare);
    const preimage = inventoryAssertionPreimage(parts.slice(0, 9));
    expect(preimage.subarray(0, 9).equals(Buffer.from('invctl/1\n', 'utf8'))).toBe(true);
    expect(preimage.toString('utf8').startsWith('v1.')).toBe(false);
    expect(preimage.toString('utf8').startsWith('acctctl/1\n')).toBe(false);
  });

  it('refuses to build a preimage from anything but nine components', () => {
    expectMalformed(() => inventoryAssertionPreimage(['invctl1']));
    expectMalformed(() => inventoryAssertionPreimage(new Array<string>(10).fill('a')));
  });

  it('gives each mint a fresh lowercase-uuid jti unless one is fixed', () => {
    const a = splitInventoryAssertion(mintInventoryAssertion(claims, key, NOW));
    const b = splitInventoryAssertion(mintInventoryAssertion(claims, key, NOW));
    expect(a.jti).not.toBe(b.jti);
    expect(a.mac).not.toBe(b.mac);
    expect(a.jti).toMatch(COMPONENT_PATTERNS[8] as RegExp);
    const fixed1 = mintInventoryAssertion({ ...claims, jti: JTI }, key, NOW);
    const fixed2 = mintInventoryAssertion({ ...claims, jti: JTI }, key, NOW);
    expect(fixed1).toBe(fixed2);
  });

  it('changing any signed claim changes the MAC', () => {
    const base = splitInventoryAssertion(mintInventoryAssertion({ ...claims, jti: JTI }, key, NOW)).mac;
    const other = '00000000-0000-4000-8000-000000000001';
    const variants: InventoryAssertionClaims[] = [
      { ...claims, jti: JTI, actorUserId: other },
      { ...claims, jti: JTI, tenantId: other },
      { ...claims, jti: JTI, businessId: other },
      { ...claims, jti: JTI, opCode: 'structure.dissociate_warehouse_branch' },
      { ...claims, jti: JTI, payloadSha256: 'b'.repeat(64) },
      { ...claims, jti: other },
    ];
    for (const v of variants) expect(splitInventoryAssertion(mintInventoryAssertion(v, key, NOW)).mac).not.toBe(base);
    expect(splitInventoryAssertion(mintInventoryAssertion({ ...claims, jti: JTI }, key, new Date(NOW.getTime() + 1000))).mac).not.toBe(base);
    expect(splitInventoryAssertion(mintInventoryAssertion({ ...claims, jti: JTI }, { kid: 'inv2', secret: key.secret }, NOW)).mac).not.toBe(base);
    expect(splitInventoryAssertion(mintInventoryAssertion({ ...claims, jti: JTI }, { kid: 'inv1', secret: Buffer.alloc(32, 8) }, NOW)).mac).not.toBe(base);
  });
});

describe('invctl/1 — expiry and the bounded TTL', () => {
  it('defaults to exp = floor(now) + 60, flooring fractional seconds', () => {
    expect(INVENTORY_ASSERTION_TTL_SECONDS).toBe(60);
    expect(splitInventoryAssertion(mintInventoryAssertion(claims, key, NOW)).exp).toBe(String(NOW_S + 60));
    const edge = new Date('2026-09-26T08:00:59.999Z');
    expect(splitInventoryAssertion(mintInventoryAssertion(claims, key, edge)).exp).toBe(String(Math.floor(edge.getTime() / 1000) + 60));
  });

  it.each([1, 30, 60])('accepts a ttl of %i seconds', (ttl) => {
    expect(splitInventoryAssertion(mintInventoryAssertion(claims, key, NOW, ttl)).exp).toBe(String(NOW_S + ttl));
  });

  it.each([0, -1, 61, 3600, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a ttl of %s seconds', (ttl) => {
    expectMalformed(() => mintInventoryAssertion(claims, key, NOW, ttl));
  });

  it('refuses an invalid clock and a clock that yields a non-positive expiry', () => {
    expectMalformed(() => mintInventoryAssertion(claims, key, new Date(Number.NaN)));
    expectMalformed(() => mintInventoryAssertion(claims, key, new Date(-120_000)));
    expectMalformed(() => mintInventoryAssertion(claims, key, new Date(-60_000)));
  });
});

describe('invctl/1 — the minter refuses non-canonical claims instead of normalizing them', () => {
  it.each([
    ['uppercase actor', { actorUserId: claims.actorUserId.toUpperCase() }],
    ['uppercase tenant', { tenantId: T.toUpperCase() }],
    ['uppercase business', { businessId: B.toUpperCase() }],
    ['malformed actor', { actorUserId: 'not-a-uuid' }],
    ['uppercase digest', { payloadSha256: claims.payloadSha256.toUpperCase() }],
    ['short digest', { payloadSha256: 'a'.repeat(63) }],
    ['uppercase jti', { jti: JTI.toUpperCase() }],
    ['malformed jti', { jti: 'jti' }],
    ['unregistered op', { opCode: 'inventory.transfer' as InventoryOperationCode }],
    ['wildcard op', { opCode: '*' as InventoryOperationCode }],
    ['wire-form op', { opCode: 'inventory:configure_product' as InventoryOperationCode }],
  ])('refuses a %s', (_label, patch) => {
    expectMalformed(() => mintInventoryAssertion({ ...claims, ...patch }, key, NOW));
  });

  it.each(['', 'a.b', 'a b', 'k'.repeat(33), 'ké'])('refuses the kid %j', (kid) => {
    expectMalformed(() => mintInventoryAssertion(claims, { kid, secret: key.secret }, NOW));
  });

  it('refuses a secret shorter than 32 bytes', () => {
    expectMalformed(() => mintInventoryAssertion(claims, { kid: 'inv1', secret: Buffer.alloc(31, 7) }, NOW));
  });
});

describe('invctl/1 — operation codes on the wire (§E)', () => {
  it('maps every registered op_code to its wire form and back', () => {
    for (const op of INVENTORY_OPERATION_CODES) {
      const wire = wireOperationCode(op);
      expect(wire).toMatch(/^[a-z]+(:[a-z_]+)+$/);
      expect(wire).not.toContain('.');
      expect(operationCodeFromWire(wire)).toBe(op);
    }
    expect(wireOperationCode('inventory.configure_product')).toBe('inventory:configure_product');
  });

  it.each([
    'inventory:transfer',
    'inventory:write',
    'Inventory:configure_product',
    'inventory.configure_product',
    'inventory',
    'inventory::configure_product',
    '',
  ])('refuses the wire operation %j', (wire) => {
    expectMalformed(() => operationCodeFromWire(wire));
  });

  it('refuses to put an unregistered op_code on the wire', () => {
    expectMalformed(() => wireOperationCode('inventory.transfer' as InventoryOperationCode));
  });
});

describe('invctl/1 — split (structure only, never verification)', () => {
  it('returns the ten named components and round-trips', () => {
    const raw = mintInventoryAssertion({ ...claims, jti: JTI }, key, NOW);
    const s = splitInventoryAssertion(raw);
    expect(s.components).toHaveLength(10);
    expect(s.components.join('.')).toBe(raw);
    expect([s.version, s.kid, s.actorUserId, s.tenantId, s.businessId, s.wireOperation, s.payloadSha256, s.exp, s.jti, s.mac]).toEqual(raw.split('.'));
    expect(s.wireOperation).toBe('structure:associate_warehouse_branch');
    expect(s.jti).toBe(JTI);
  });

  it('never checks the MAC: a tampered signature still splits', () => {
    const parts = mintInventoryAssertion(claims, key, NOW).split('.');
    parts[9] = '0'.repeat(64);
    expect(splitInventoryAssertion(parts.join('.')).mac).toBe('0'.repeat(64));
  });

  it('never checks component patterns: a non-canonical claim still splits (the database refuses it)', () => {
    const parts = mintInventoryAssertion(claims, key, NOW).split('.');
    parts[2] = (parts[2] as string).toUpperCase();
    expect(splitInventoryAssertion(parts.join('.')).actorUserId).toBe(parts[2]);
  });

  it('refuses the wrong component count', () => {
    const parts = mintInventoryAssertion(claims, key, NOW).split('.');
    expectMalformed(() => splitInventoryAssertion(parts.slice(0, 9).join('.')));
    expectMalformed(() => splitInventoryAssertion([...parts, 'x'].join('.')));
    expectMalformed(() => splitInventoryAssertion(''));
  });

  it.each(['invctl2', 'invctl/1', 'INVCTL1', 'v1', 'acctctl1', ''])('refuses the version prefix %j', (version) => {
    const parts = mintInventoryAssertion(claims, key, NOW).split('.');
    parts[0] = version;
    expectMalformed(() => splitInventoryAssertion(parts.join('.')));
  });

  it('refuses a non-string', () => {
    expectMalformed(() => splitInventoryAssertion(undefined as unknown as string));
  });
});

describe('invctl/1 — key parsing and byte separation (§C)', () => {
  const b64 = (n: number, fill = 7): string => Buffer.alloc(n, fill).toString('base64');

  it('accepts a kid of the locked pattern and a secret of at least 32 bytes', () => {
    const k = parseInventoryAssertionKey({ kid: 'inv-P3_s1', keyBase64: b64(32) });
    expect(k.kid).toBe('inv-P3_s1');
    expect(k.secret.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(parseInventoryAssertionKey({ kid: 'k'.repeat(32), keyBase64: b64(64) }).secret).toHaveLength(64);
    expect(parseInventoryAssertionKey({ kid: 'k', keyBase64: b64(32).replace(/=+$/, '') }).secret).toHaveLength(32);
  });

  it.each(['', 'a.b', 'a b', 'k'.repeat(33), 'ké', 'a/b'])('refuses the kid %j', (kid) => {
    expect(() => parseInventoryAssertionKey({ kid, keyBase64: b64(32) })).toThrow(/INVENTORY_ASSERTION_KID/);
  });

  it('refuses a decoded secret shorter than 32 bytes', () => {
    expect(() => parseInventoryAssertionKey({ kid: 'k', keyBase64: b64(31) })).toThrow(/at least 32 bytes/);
    expect(() => parseInventoryAssertionKey({ kid: 'k', keyBase64: '' })).toThrow(/INVENTORY_ASSERTION_KEY/);
  });

  it('refuses text that is not plain base64 instead of silently decoding what it can', () => {
    const good = b64(40);
    for (const bad of [`${good}!`, ` ${good}`, `${good}\n`, good.replace(/B/g, '-'), `${good}===`]) {
      expect(() => parseInventoryAssertionKey({ kid: 'k', keyBase64: bad })).toThrow(/INVENTORY_ASSERTION_KEY/);
    }
  });

  it('never puts the key material into an error message', () => {
    const secretText = Buffer.alloc(31, 0x41).toString('base64');
    try {
      parseInventoryAssertionKey({ kid: 'k', keyBase64: secretText });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secretText);
    }
  });

  it('secretsAreIdentical compares bytes, in constant time for equal lengths', () => {
    expect(secretsAreIdentical(Buffer.alloc(32, 1), Buffer.alloc(32, 1))).toBe(true);
    expect(secretsAreIdentical(Buffer.alloc(32, 1), Buffer.alloc(32, 2))).toBe(false);
    expect(secretsAreIdentical(Buffer.alloc(32, 1), Buffer.alloc(33, 1))).toBe(false);
    // Two base64 spellings of one secret are one secret.
    const a = parseInventoryAssertionKey({ kid: 'a', keyBase64: b64(32) }).secret;
    const b = parseInventoryAssertionKey({ kid: 'b', keyBase64: b64(32).replace(/=+$/, '') }).secret;
    expect(secretsAreIdentical(a, b)).toBe(true);
  });
});

describe('hmacKeysEquivalent — key separation over the EFFECTIVE HMAC-SHA-256 key (P3-AL-55 §C)', () => {
  const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const mac = (key: Buffer): string => createHmac('sha256', key).update('invctl/1\nprobe').digest('hex');
  const zeros = (n: number): Buffer => Buffer.alloc(n, 0);

  it('K and K‖0x00 are one HMAC key — the premise, and the verdict', () => {
    const padded = Buffer.concat([K, zeros(1)]);
    expect(padded.equals(K)).toBe(false);
    expect(mac(padded)).toBe(mac(K));
    expect(hmacKeysEquivalent(K, padded)).toBe(true);
    expect(hmacKeysEquivalent(padded, K)).toBe(true);
  });

  it('K and K‖0x00‖0x00 are one HMAC key, as is K padded to the full 64-byte block', () => {
    for (const extra of [2, 32]) {
      const padded = Buffer.concat([K, zeros(extra)]);
      expect(padded.length).toBeLessThanOrEqual(64);
      expect(mac(padded)).toBe(mac(K));
      expect(hmacKeysEquivalent(K, padded)).toBe(true);
    }
  });

  it('a key longer than 64 bytes is one HMAC key with its own SHA-256 digest', () => {
    for (const length of [65, 100, 128]) {
      const long = Buffer.from(Array.from({ length }, (_, i) => (i * 7 + 3) % 256));
      const digest = createHash('sha256').update(long).digest();
      expect(mac(long)).toBe(mac(digest));
      expect(hmacKeysEquivalent(long, digest)).toBe(true);
      expect(hmacKeysEquivalent(digest, long)).toBe(true);
      // … and with that digest zero-padded, too.
      expect(hmacKeysEquivalent(long, Buffer.concat([digest, zeros(3)]))).toBe(true);
    }
  });

  it('identical keys are equivalent', () => {
    expect(hmacKeysEquivalent(K, Buffer.from(K))).toBe(true);
  });

  it('genuinely different keys are not — including a leading zero, a changed last byte and a truncation', () => {
    const lastByte = Buffer.from(K);
    lastByte[31] = 0xff;
    const cases: Buffer[] = [
      Buffer.alloc(32, 7),
      lastByte,
      Buffer.concat([zeros(1), K]),
      K.subarray(0, 31),
      Buffer.concat([K, Buffer.from([1])]),
      Buffer.from(Array.from({ length: 65 }, (_, i) => i)),
    ];
    for (const other of cases) {
      expect(mac(other)).not.toBe(mac(K));
      expect(hmacKeysEquivalent(K, other)).toBe(false);
    }
  });

  it('a 64-byte key is used as-is, not hashed: it is NOT equivalent to its digest', () => {
    const block = Buffer.from(Array.from({ length: 64 }, (_, i) => i + 1));
    const digest = createHash('sha256').update(block).digest();
    expect(mac(block)).not.toBe(mac(digest));
    expect(hmacKeysEquivalent(block, digest)).toBe(false);
  });
});
