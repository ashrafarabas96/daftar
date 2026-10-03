import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import {
  associateWarehouseBranchPayload,
  buildInventoryPayload,
  canonicalInventoryPayload,
  configureProductPayload,
  dissociateWarehouseBranchPayload,
  INVENTORY_OPERATION_CODES,
  INVENTORY_OPERATION_INTENT_FIELDS,
  INVENTORY_P4_S1_OPERATION_CODES,
  INVENTORY_P4_S3_OPERATION_CODES,
  INVENTORY_PAYLOAD_SCHEMAS,
  INVENTORY_SERVER_DERIVED_FIELDS,
  inventoryIntentSchema,
  inventoryPayloadSha256,
  isInventoryOperationCode,
  tillSessionClosePayload,
  tillSessionOpenPayload,
  OPERATION_CODE_RE,
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

  it.each(['inventory.teleport', 'inventory.write', 'inventory.execute', '*', 'inventory:configure_product', 'INVENTORY.CONFIGURE_PRODUCT', ''])(
    'refuses the unregistered operation code %j',
    (opCode) => {
      expect(isInventoryOperationCode(opCode)).toBe(false);
      expectRefused(() => canonicalInventoryPayload(opCode as InventoryOperationCode, T, B, configureFields()));
    },
  );

  // PHASE_3_S3_CONTRACT A-20 row 7: the three P3-S1 kinds with their accepted
  // schemas unchanged, plus exactly the seven P3-S3 kinds and nothing else.
  // P3-S4 (0063/0064): PHASE_3_S4_CONTRACT §7.3 row 21 appends the seven
  // P3-S4 kinds; the S1 and S3 rows stay verbatim.
  // P3-S5 (0065/0066): PHASE_3_S5_CONTRACT §7.3 row 21 appends the two P3-S5
  // kinds; the S1, S3 and S4 rows stay verbatim.
  // P3-S6 (0067/0068): PHASE_3_S6_CONTRACT §7.3 row 19 appends the seven
  // P3-S6 kinds; the S1, S3, S4 and S5 rows stay verbatim.
  // Phase 3 corrective (0072, TD-16) appends the one corrective kind,
  // `purchase.write_off_residue`; every slice row stays verbatim.
  // P4-S1 (gap G-5) appends the four customer kinds; every Phase 3 row stays
  // verbatim.
  // P4-S2 (docs/PHASE_4_S2_CONTRACT.md A-05) appends the ONE sale kind,
  // `sale.commit`; every earlier row stays verbatim. `sale.void` and
  // `sale.return` are NOT here: they belong to P4-S6 and P4-S5, and a kind
  // registered without its routine would be an authority nothing refuses.
  // The list is ABSOLUTE on purpose: a kind added, renamed or quietly dropped
  // turns this red, and the registry is the thing a signed authority is
  // scoped by.
  it('registers exactly the three P3-S1 operation kinds, the seven P3-S3 kinds, the seven P3-S4 kinds, the two P3-S5 kinds, the seven P3-S6 kinds, the one corrective kind, the four P4-S1 customer kinds, the one P4-S2 sale kind and the four P4-S3 POS kinds', () => {
    expect([...INVENTORY_OPERATION_CODES].sort()).toEqual([
      'customer.archive', // P4-S1 (gap G-5)
      'customer.create', // P4-S1 (gap G-5)
      'customer.reactivate', // P4-S1 (gap G-5)
      'customer.update', // P4-S1 (gap G-5)
      'inventory.adjust',
      'inventory.configure_product',
      'inventory.damage',
      'inventory.opening',
      'inventory.stocktake_count',
      'inventory.stocktake_finalize',
      'inventory.stocktake_open',
      'inventory.transfer',
      'payment.activate_method', // P3-S6 (0067/0068)
      'payment.create_method', // P3-S6 (0067/0068)
      'payment.deactivate_method', // P3-S6 (0067/0068)
      'payment.update_method', // P3-S6 (0067/0068)
      // P4-S3 (`0079`): FOUR kinds — the two till-session ones and the two
      // cart ones.
      //
      // An earlier revision of this list carried only the two session kinds
      // and said the cart kinds were «deliberately absent, by this list's own
      // rule — a kind registered here without the builder that mints for it
      // would be an authority nothing refuses». That rule is right and the
      // conclusion was simply out of date: it was written before the cart's
      // minting side landed. `PosCartService.payload()` mints both, through
      // the generic `buildInventoryPayload` over the registered schema rather
      // than through a bespoke named helper, which satisfies the rule — being
      // mintable is a property of having a schema the builder accepts, not of
      // having a function named after the kind.
      //
      // So the rule stops being prose here. `buildInventoryPayload` is driven
      // over every registered P4-S3 kind below, and a kind in this list that
      // nothing can mint for turns THAT red rather than going unnoticed
      // behind a comment — which is the whole failure this list exists to
      // prevent, and the one the stale conclusion above committed.
      'pos.cart_remove_line',
      'pos.cart_set_line',
      'pos.session_close',
      'pos.session_open',
      'purchase.cancel',
      'purchase.draft',
      'purchase.receive',
      'purchase.return', // P3-S5 (0065/0066)
      'purchase.reverse', // P3-S5 (0065/0066)
      'purchase.write_off_residue', // Phase 3 corrective (0072, TD-16)
      'sale.commit', // P4-S2 (the atomic sale commit)
      'structure.associate_warehouse_branch',
      'structure.dissociate_warehouse_branch',
      'supplier.allocate_credit', // P3-S6 (0067/0068)
      'supplier.archive',
      'supplier.create',
      'supplier.pay', // P3-S6 (0067/0068)
      'supplier.reactivate',
      'supplier.receive_refund', // P3-S6 (0067/0068)
      'supplier.update',
    ]);
    expect(Object.keys(INVENTORY_PAYLOAD_SCHEMAS).sort()).toEqual([...INVENTORY_OPERATION_CODES].sort());
    const s1 = (op: InventoryOperationCode) => INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => [f.name, f.type, f.nullable]);
    expect(s1('inventory.configure_product')).toEqual([
      ['product_id', 'uuid', false],
      ['track_inventory', 'boolean', false],
      ['unit_code', 'code', true],
      ['unit_decimals', 'integer', true],
    ]);
    for (const op of ['structure.associate_warehouse_branch', 'structure.dissociate_warehouse_branch'] as const) {
      expect(s1(op)).toEqual([
        ['warehouse_id', 'uuid', false],
        ['branch_id', 'uuid', false],
      ]);
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].repeat).toBeUndefined();
    }
    expect(INVENTORY_PAYLOAD_SCHEMAS['inventory.configure_product'].repeat).toBeUndefined();
    // P4-S3. The grammars are written out field by field because an
    // approximate one is not a smaller defect than a missing one: a field in
    // the wrong place, of the wrong type, or one more or one fewer than the
    // routine's own `inventory_claimed_payload_digest(...)` argument arrays
    // makes EVERY till command `inventory.assertion_payload_mismatch`. The
    // actor is in neither list, which is `OD-P4-09`: the user a till session
    // belongs to comes from the verified assertion, never from an argument.
    expect(s1('pos.session_open')).toEqual([
      ['session_id', 'uuid', false],
      ['branch_id', 'uuid', false],
      ['warehouse_id', 'uuid', false],
      ['terminal_code', 'code', false],
      ['currency_code', 'code', false],
      ['opening_float_minor', 'integer', false],
    ]);
    expect(s1('pos.session_close')).toEqual([
      ['session_id', 'uuid', false],
      ['closing_count_minor', 'integer', false],
    ]);
    // The cart's two, in the order and of the types `0079`'s own
    // `inventory_claimed_payload_digest` argument arrays carry:
    //   pos_cart_set_line      ARRAY['uuid','uuid','integer','uuid','uuid','integer','integer']
    //   pos_cart_remove_line   ARRAY['uuid','uuid']
    // There is no price, line total or tax field in either, and that is the
    // trust boundary expressed as an absence: a forged total has nowhere to
    // arrive, so it is not refused — it is INEXPRESSIBLE (P4-AL-18).
    expect(s1('pos.cart_set_line')).toEqual([
      ['session_id', 'uuid', false],
      ['line_id', 'uuid', false],
      ['line_no', 'integer', false],
      ['product_id', 'uuid', false],
      ['variant_id', 'uuid', false],
      ['qty_q4', 'integer', false],
      ['requested_discount_minor', 'integer', false],
    ]);
    expect(s1('pos.cart_remove_line')).toEqual([
      ['session_id', 'uuid', false],
      ['line_id', 'uuid', false],
    ]);
    for (const op of INVENTORY_P4_S3_OPERATION_CODES) {
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].repeat, op).toBeUndefined();
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].trailer, op).toBeUndefined();
      // THE RULE THIS LIST STATES, MEASURED: every registered P4-S3 kind can
      // actually be minted for. The fields are generated FROM the kind's own
      // schema, so this cannot drift as the grammar changes, and a kind added
      // to the list with no usable schema fails here by name instead of
      // sitting in the list as an authority nothing can produce a payload
      // for. This is what the comment on the list above used to assert in
      // prose, and prose is what let a stale conclusion stand.
      const minted = buildInventoryPayload(
        op,
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        INVENTORY_PAYLOAD_SCHEMAS[op].map(
          (f): InventoryPayloadField =>
            f.type === 'uuid'
              ? { kind: 'uuid', value: '33333333-3333-4333-8333-333333333333' }
              : f.type === 'integer'
                ? { kind: 'integer', value: 1 }
                : { kind: 'code', value: 'abc' },
        ),
      );
      expect(minted.opCode, op).toBe(op);
      // No till-session field is server-derived, so the intent schema is the
      // whole payload: a replay of an open or a close is the same command in
      // every field, the counted cash included.
      expect(
        inventoryIntentSchema(op).map((f) => f.name),
        op,
      ).toEqual(INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => f.name));
    }
  });

  it('the two P4-S3 builders mint the grammars the routines hash, and the currency is lower-cased in the preimage only', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const businessId = '22222222-2222-4222-8222-222222222222';
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const branchId = '44444444-4444-4444-8444-444444444444';
    const warehouseId = '55555555-5555-4555-8555-555555555555';

    const open = tillSessionOpenPayload({
      tenantId,
      businessId,
      sessionId,
      branchId,
      warehouseId,
      terminalCode: 'till_1',
      currencyCode: 'TRY',
      openingFloatMinor: 25000n,
    });
    expect(open.opCode).toBe('pos.session_open');
    // The digest a routine reproduces is the one over the LOWER-CASED
    // currency: `0054:206`'s `code` grammar has no upper-case letter in it,
    // so an upper-case ISO code is not a canonicalisable `code` at all.
    expect(open.sha256).toBe(
      inventoryPayloadSha256('pos.session_open', tenantId, businessId, [
        { kind: 'uuid', value: sessionId },
        { kind: 'uuid', value: branchId },
        { kind: 'uuid', value: warehouseId },
        { kind: 'code', value: 'till_1' },
        { kind: 'code', value: 'try' },
        { kind: 'integer', value: 25000n },
      ]),
    );
    // RED-ADJACENT, and stronger than "a different digest": the upper-case
    // spelling is not a `code` AT ALL. The encoder refuses it rather than
    // hashing it, so a builder that forwarded the column's own spelling could
    // not mint for this routine even in principle — which is why the
    // lower-casing lives in the builder and not in a caller's discipline.
    expect(() =>
      inventoryPayloadSha256('pos.session_open', tenantId, businessId, [
        { kind: 'uuid', value: sessionId },
        { kind: 'uuid', value: branchId },
        { kind: 'uuid', value: warehouseId },
        { kind: 'code', value: 'till_1' },
        { kind: 'code', value: 'TRY' },
        { kind: 'integer', value: 25000n },
      ]),
    ).toThrow(/currency_code\) is not a registry code/);
    // And the counted float is INSIDE the signature: a drawer figure the
    // signature did not cover could be changed between minting and call.
    expect(open.sha256).not.toBe(
      tillSessionOpenPayload({
        tenantId,
        businessId,
        sessionId,
        branchId,
        warehouseId,
        terminalCode: 'till_1',
        currencyCode: 'TRY',
        openingFloatMinor: 25001n,
      }).sha256,
    );

    const close = tillSessionClosePayload({ tenantId, businessId, sessionId, closingCountMinor: 41900n });
    expect(close.opCode).toBe('pos.session_close');
    expect(close.sha256).toBe(
      inventoryPayloadSha256('pos.session_close', tenantId, businessId, [
        { kind: 'uuid', value: sessionId },
        { kind: 'integer', value: 41900n },
      ]),
    );
    expect(close.sha256).not.toBe(tillSessionClosePayload({ tenantId, businessId, sessionId, closingCountMinor: 41901n }).sha256);
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

// ── P4-S1 (gap G-5) — the customer schemas and the policy they may not carry ──
describe('invpl/1 — the four P4-S1 customer kinds (gap G-5)', () => {
  const CUSTOMER_KINDS = ['customer.create', 'customer.update', 'customer.archive', 'customer.reactivate'] as const;
  const words = (prefix: string, nullable: boolean): [string, string, boolean][] =>
    Array.from({ length: 8 }, (_, i) => [`${prefix}_w${i + 1}`, 'integer', nullable]);
  const shape = (op: InventoryOperationCode): [string, string, boolean][] => INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => [f.name, f.type, f.nullable]);

  it('the code list is exactly the four kinds, and every one satisfies the frozen registry grammar', () => {
    expect([...INVENTORY_P4_S1_OPERATION_CODES]).toEqual(['customer.create', 'customer.update', 'customer.archive', 'customer.reactivate']);
    // `0054:53`, duplicated inside the frozen routine body at `0054:229`. The
    // same four codes are proved against the REAL constraint in PostgreSQL;
    // this is the JS half, so a rename cannot slip past the package alone.
    for (const op of INVENTORY_P4_S1_OPERATION_CODES) {
      expect(OPERATION_CODE_RE.test(op)).toBe(true);
      expect(isInventoryOperationCode(op)).toBe(true);
      // Singular first segment: the grammar admits no underscore before the dot.
      expect(OPERATION_CODE_RE.test(op.replace('customer.', 'customer_master.'))).toBe(false);
    }
  });

  it('customer.create is the id plus four word groups; the three edit kinds add expected_revision', () => {
    expect(shape('customer.create')).toEqual([
      ['customer_id', 'uuid', false],
      ...words('name', false),
      ...words('phone', true),
      ...words('email', true),
      ...words('notes', true),
    ]);
    expect(shape('customer.update')).toEqual([
      ['customer_id', 'uuid', false],
      ['expected_revision', 'integer', false],
      ...words('name', false),
      ...words('phone', true),
      ...words('email', true),
      ...words('notes', true),
    ]);
    for (const op of ['customer.archive', 'customer.reactivate'] as const) {
      expect(shape(op)).toEqual([
        ['customer_id', 'uuid', false],
        ['expected_revision', 'integer', false],
      ]);
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].repeat).toBeUndefined();
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].trailer).toBeUndefined();
    }
    for (const op of CUSTOMER_KINDS) {
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].repeat).toBeUndefined();
      expect(INVENTORY_PAYLOAD_SCHEMAS[op].trailer).toBeUndefined();
    }
  });

  // The CUSTOMER group is the SUPPLIER group's binding and nullability, less
  // the tax identifier: P4-AL-44 records that the registered / unregistered /
  // exempt distinction has no representation in the data model yet, P4-AL-45
  // forbids inventing one while OD-03 is open, and the accepted P4-S1 read
  // contract states "no tax identifier and no registration flag".
  it('the customer text group is the supplier group less the tax identifier, binding for binding', () => {
    const supplierText = shape('supplier.create').slice(1);
    const customerText = shape('customer.create').slice(1);
    expect(supplierText).toEqual([
      ...words('name', false),
      ...words('phone', true),
      ...words('email', true),
      ...words('tax_identifier', true),
      ...words('notes', true),
    ]);
    expect(customerText).toEqual(supplierText.filter(([name]) => !name.startsWith('tax_identifier_')));
    // The same required-name / nullable-rest shape, group for group.
    expect(customerText.map(([, type]) => type)).toEqual(Array.from({ length: 32 }, () => 'integer'));
    expect(customerText.filter(([, , nullable]) => !nullable)).toEqual(words('name', false));
  });

  // "No commercial or legal policy invented": no credit limit, no balance, no
  // paid / outstanding / aging figure, no tax rate or tax amount. A signed
  // field is the strongest possible form of storing one, so the ban is
  // asserted over the FIELD NAMES of every customer schema, not documented.
  it('no customer field names money, a limit, a total or a tax', () => {
    const banned = /minor|amount|total|limit|tax_rate|tax_amount/;
    for (const op of CUSTOMER_KINDS) {
      for (const f of INVENTORY_PAYLOAD_SCHEMAS[op]) expect(f.name).not.toMatch(banned);
      // and nothing shaped like a stored position, by name, either.
      for (const f of INVENTORY_PAYLOAD_SCHEMAS[op]) expect(f.name).not.toMatch(/balance|paid|outstanding|aging|credit|tax/);
    }
  });

  // Every customer field is client intent, so intent = payload: the accepted
  // P3-S4 supplier rule (A-10(b)). An entry here would mean the server derives
  // one of these fields, and none of them is derived.
  it('has no INVENTORY_OPERATION_INTENT_FIELDS entry, and no field is server-derived', () => {
    for (const op of CUSTOMER_KINDS) {
      expect(INVENTORY_OPERATION_INTENT_FIELDS[op]).toBeUndefined();
      expect(Object.keys(INVENTORY_OPERATION_INTENT_FIELDS)).not.toContain(op);
      for (const f of INVENTORY_PAYLOAD_SCHEMAS[op]) expect(INVENTORY_SERVER_DERIVED_FIELDS).not.toContain(f.name);
      // So the intent schema is the payload schema, field for field.
      expect(inventoryIntentSchema(op).map((f) => f.name)).toEqual(INVENTORY_PAYLOAD_SCHEMAS[op].map((f) => f.name));
    }
  });
});
