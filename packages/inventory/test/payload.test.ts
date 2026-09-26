import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import {
  associateWarehouseBranchPayload,
  canonicalInventoryPayload,
  configureProductPayload,
  dissociateWarehouseBranchPayload,
  INVENTORY_OPERATION_CODES,
  INVENTORY_PAYLOAD_SCHEMAS,
  inventoryPayloadSha256,
  isInventoryOperationCode,
  type InventoryOperationCode,
  type InventoryPayloadField,
} from '../src/payload';

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const P = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const W = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const BR = '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301';

const CONFIGURE = 'inventory.configure_product' as const;

/** The expected stream, assembled by hand from the spec rather than by the code under test. */
const stream = (...lines: (string | Buffer)[]): Buffer =>
  Buffer.concat(lines.flatMap((l) => [typeof l === 'string' ? Buffer.from(l, 'ascii') : l, Buffer.from([0x0a])]));
const NULL_LINE = Buffer.from([0x00]);

const configureFields = (
  unitCode: InventoryPayloadField = { kind: 'code', value: 'piece' },
  unitDecimals: InventoryPayloadField = { kind: 'integer', value: 0 },
): InventoryPayloadField[] => [{ kind: 'uuid', value: P }, { kind: 'boolean', value: true }, unitCode, unitDecimals];

const encodeDecimals = (value: number | bigint): Buffer => canonicalInventoryPayload(CONFIGURE, T, B, configureFields(undefined, { kind: 'integer', value }));

/** The unit_decimals line: the ninth line of a configure_product stream (index 7). */
const decimalsLine = (bytes: Buffer): string => bytes.toString('latin1').split('\n')[7] ?? '';

const expectRefused = (fn: () => unknown): void => {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(InventoryError);
  expect((caught as InventoryError).code).toBe('inventory.payload_invalid');
};

describe('invpl/1 — the stream layout (P3-AL-55 §F)', () => {
  it('writes the domain, op_code, tenant, business and every field on its own LF-terminated line', () => {
    const bytes = canonicalInventoryPayload(CONFIGURE, T, B, configureFields());
    expect(bytes.equals(stream('invpl/1', CONFIGURE, T, B, P, 'true', 'piece', '0'))).toBe(true);
  });

  it('terminates the LAST line with LF too', () => {
    const bytes = canonicalInventoryPayload('structure.associate_warehouse_branch', T, B, [
      { kind: 'uuid', value: W },
      { kind: 'uuid', value: BR },
    ]);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes.equals(stream('invpl/1', 'structure.associate_warehouse_branch', T, B, W, BR))).toBe(true);
  });

  it('encodes NULL as the single byte 0x00 and nothing else on the line', () => {
    const bytes = canonicalInventoryPayload(CONFIGURE, T, B, [
      { kind: 'uuid', value: P },
      { kind: 'boolean', value: false },
      { kind: 'null' },
      { kind: 'null' },
    ]);
    expect(bytes.equals(stream('invpl/1', CONFIGURE, T, B, P, 'false', NULL_LINE, NULL_LINE))).toBe(true);
    expect(bytes.subarray(bytes.length - 4).equals(Buffer.from([0x00, 0x0a, 0x00, 0x0a]))).toBe(true);
  });

  it('NULL is not the text "null", the empty line, or zero', () => {
    const nulls = canonicalInventoryPayload(CONFIGURE, T, B, configureFields({ kind: 'null' }, { kind: 'null' }));
    const zero = encodeDecimals(0);
    expect(nulls.includes(Buffer.from('null'))).toBe(false);
    expect(nulls.includes(Buffer.from([0x0a, 0x0a]))).toBe(false);
    expect(decimalsLine(nulls)).toBe('\u0000');
    expect(decimalsLine(zero)).toBe('0');
  });

  it('encodes booleans as ASCII true / false', () => {
    const t = canonicalInventoryPayload(CONFIGURE, T, B, [{ kind: 'uuid', value: P }, { kind: 'boolean', value: true }, { kind: 'null' }, { kind: 'null' }]);
    const f = canonicalInventoryPayload(CONFIGURE, T, B, [{ kind: 'uuid', value: P }, { kind: 'boolean', value: false }, { kind: 'null' }, { kind: 'null' }]);
    expect(t.toString('latin1').split('\n')[5]).toBe('true');
    expect(f.toString('latin1').split('\n')[5]).toBe('false');
  });

  it('writes registry codes as their bytes exactly', () => {
    const bytes = canonicalInventoryPayload(CONFIGURE, T, B, configureFields({ kind: 'code', value: 'u0_long_unit_code_with_digits_99' }));
    expect(bytes.toString('latin1').split('\n')[6]).toBe('u0_long_unit_code_with_digits_99');
  });

  it('the digest is lowercase hex SHA-256 of the exact stream', () => {
    const fields = configureFields();
    const digest = inventoryPayloadSha256(CONFIGURE, T, B, fields);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      createHash('sha256')
        .update(canonicalInventoryPayload(CONFIGURE, T, B, fields))
        .digest('hex'),
    );
  });
});

describe('invpl/1 — integer encoding', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [4, '4'],
    [10, '10'],
    [32767, '32767'],
    [-1, '-1'],
    [-32768, '-32768'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [9223372036854775807n, '9223372036854775807'],
    [-9223372036854775808n, '-9223372036854775808'],
    [0n, '0'],
    [-5n, '-5'],
  ])('%s encodes as %s — base 10, "-" only when negative, no "+", no leading zero', (value, expected) => {
    expect(decimalsLine(encodeDecimals(value))).toBe(expected);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, -(2 ** 53)])(
    'refuses the non-integer or unsafe number %s',
    (value) => {
      expectRefused(() => encodeDecimals(value));
    },
  );

  it('refuses a bigint outside the PostgreSQL bigint range', () => {
    expectRefused(() => encodeDecimals(9223372036854775808n));
    expectRefused(() => encodeDecimals(-9223372036854775809n));
  });

  it('refuses a numeric string where an integer is declared', () => {
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B, configureFields(undefined, { kind: 'integer', value: '1' as unknown as number })));
  });
});

describe('invpl/1 — refusals of non-canonical input (never normalized)', () => {
  const upper = P.toUpperCase();

  it.each([
    ['uppercase', upper],
    ['braced', `{${P}}`],
    ['unhyphenated', P.replace(/-/g, '')],
    ['urn-prefixed', `urn:uuid:${P}`],
    ['padded', ` ${P}`],
    ['trailing newline', `${P}\n`],
    ['not a uuid', 'not-a-uuid'],
    ['empty', ''],
  ])('refuses a %s product uuid', (_label, value) => {
    expectRefused(() =>
      canonicalInventoryPayload(CONFIGURE, T, B, [{ kind: 'uuid', value }, { kind: 'boolean', value: true }, { kind: 'null' }, { kind: 'null' }]),
    );
  });

  it('refuses an uppercase tenant or business uuid rather than lowercasing it', () => {
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T.toUpperCase(), B, configureFields()));
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B.toUpperCase(), configureFields()));
  });

  it.each([
    ['capitalized', 'Piece'],
    ['leading space', ' piece'],
    ['trailing space', 'piece '],
    ['empty', ''],
    ['leading digit', '1kg'],
    ['leading underscore', '_kg'],
    ['hyphen', 'k-g'],
    ['dot', 'k.g'],
    ['embedded LF', 'k\ng'],
    ['embedded NUL', 'k\u0000g'],
    ['non-ASCII', 'kğ'],
    ['fullwidth', 'ｋｇ'],
    ['33 bytes', `a${'b'.repeat(32)}`],
  ])('refuses a %s unit code before hashing', (_label, value) => {
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B, configureFields({ kind: 'code', value })));
    expectRefused(() => configureProductPayload({ tenantId: T, businessId: B, productId: P, trackInventory: true, unitCode: value, unitDecimals: 0 }));
  });

  it('refuses a non-boolean where a boolean is declared', () => {
    expectRefused(() =>
      canonicalInventoryPayload(CONFIGURE, T, B, [
        { kind: 'uuid', value: P },
        { kind: 'boolean', value: 'true' as unknown as boolean },
        { kind: 'null' },
        { kind: 'null' },
      ]),
    );
  });

  it('refuses the wrong field count, the wrong type in a position, and NULL where not nullable', () => {
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B, configureFields().slice(0, 3)));
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B, [...configureFields(), { kind: 'null' }]));
    expectRefused(() =>
      canonicalInventoryPayload(CONFIGURE, T, B, [{ kind: 'boolean', value: true }, { kind: 'uuid', value: P }, { kind: 'null' }, { kind: 'null' }]),
    );
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B, [{ kind: 'null' }, { kind: 'boolean', value: true }, { kind: 'null' }, { kind: 'null' }]));
    expectRefused(() => canonicalInventoryPayload(CONFIGURE, T, B, [{ kind: 'uuid', value: P }, { kind: 'null' }, { kind: 'null' }, { kind: 'null' }]));
    expectRefused(() => canonicalInventoryPayload('structure.associate_warehouse_branch', T, B, [{ kind: 'uuid', value: W }, { kind: 'null' }]));
  });

  it.each(['inventory.transfer', 'inventory.write', 'inventory.execute', '*', 'inventory:configure_product', 'INVENTORY.CONFIGURE_PRODUCT', ''])(
    'refuses the unregistered operation code %j',
    (opCode) => {
      expect(isInventoryOperationCode(opCode)).toBe(false);
      expectRefused(() => canonicalInventoryPayload(opCode as InventoryOperationCode, T, B, configureFields()));
    },
  );

  it('registers exactly the three P3-S1 operation kinds', () => {
    expect([...INVENTORY_OPERATION_CODES].sort()).toEqual([
      'inventory.configure_product',
      'structure.associate_warehouse_branch',
      'structure.dissociate_warehouse_branch',
    ]);
    expect(Object.keys(INVENTORY_PAYLOAD_SCHEMAS).sort()).toEqual([...INVENTORY_OPERATION_CODES].sort());
  });
});

describe('invpl/1 — typed builders follow the lock field order', () => {
  it('configureProductPayload: product_id, track_inventory, unit_code, unit_decimals', () => {
    const p = configureProductPayload({ tenantId: T, businessId: B, productId: P, trackInventory: true, unitCode: 'kg', unitDecimals: 3 });
    expect(p.opCode).toBe(CONFIGURE);
    expect(p.bytes.equals(stream('invpl/1', CONFIGURE, T, B, P, 'true', 'kg', '3'))).toBe(true);
    expect(p.sha256).toBe(createHash('sha256').update(p.bytes).digest('hex'));
    expect(INVENTORY_PAYLOAD_SCHEMAS[CONFIGURE].map((f) => f.name)).toEqual(['product_id', 'track_inventory', 'unit_code', 'unit_decimals']);
  });

  it('configureProductPayload: NULL unit_code and NULL unit_decimals each become 0x00', () => {
    const p = configureProductPayload({ tenantId: T, businessId: B, productId: P, trackInventory: false, unitCode: null, unitDecimals: null });
    expect(p.bytes.equals(stream('invpl/1', CONFIGURE, T, B, P, 'false', NULL_LINE, NULL_LINE))).toBe(true);
    const onlyCodeNull = configureProductPayload({ tenantId: T, businessId: B, productId: P, trackInventory: false, unitCode: null, unitDecimals: 0 });
    expect(onlyCodeNull.bytes.equals(stream('invpl/1', CONFIGURE, T, B, P, 'false', NULL_LINE, '0'))).toBe(true);
  });

  it('associate and dissociate write warehouse_id then branch_id', () => {
    const a = associateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W, branchId: BR });
    const d = dissociateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W, branchId: BR });
    expect(a.opCode).toBe('structure.associate_warehouse_branch');
    expect(d.opCode).toBe('structure.dissociate_warehouse_branch');
    expect(a.bytes.equals(stream('invpl/1', 'structure.associate_warehouse_branch', T, B, W, BR))).toBe(true);
    expect(d.bytes.equals(stream('invpl/1', 'structure.dissociate_warehouse_branch', T, B, W, BR))).toBe(true);
  });

  it('associate and dissociate over identical ids never share a digest', () => {
    const a = associateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W, branchId: BR });
    const d = dissociateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W, branchId: BR });
    expect(a.sha256).not.toBe(d.sha256);
  });

  it('every bound id changes the digest: warehouse, branch, tenant, business, and their order', () => {
    const base = associateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W, branchId: BR }).sha256;
    const other = '00000000-0000-4000-8000-000000000001';
    const variants = [
      { tenantId: T, businessId: B, warehouseId: other, branchId: BR },
      { tenantId: T, businessId: B, warehouseId: W, branchId: other },
      { tenantId: other, businessId: B, warehouseId: W, branchId: BR },
      { tenantId: T, businessId: other, warehouseId: W, branchId: BR },
      { tenantId: T, businessId: B, warehouseId: BR, branchId: W },
    ];
    for (const v of variants) expect(associateWarehouseBranchPayload(v).sha256).not.toBe(base);
  });

  it('the builders refuse non-canonical ids', () => {
    expectRefused(() => associateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W.toUpperCase(), branchId: BR }));
    expectRefused(() => dissociateWarehouseBranchPayload({ tenantId: T, businessId: B, warehouseId: W, branchId: BR.toUpperCase() }));
    expectRefused(() =>
      configureProductPayload({ tenantId: T, businessId: B, productId: P.toUpperCase(), trackInventory: true, unitCode: 'kg', unitDecimals: 3 }),
    );
    expectRefused(() => configureProductPayload({ tenantId: T, businessId: B, productId: P, trackInventory: true, unitCode: 'kg', unitDecimals: 2.5 }));
  });
});
