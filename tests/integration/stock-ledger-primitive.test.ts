/**
 * P3-S2 — THE TRUSTED PRIMITIVE'S REFUSALS AND ITS STORED ANSWERS
 * (docs/PHASE_3_S2_CONTRACT.md §6: T-07, T-08, T-21, A-29, transfer pairs,
 * bounds, the closed kind registry, identity conflicts).
 *
 * Every call goes through the fixture producer (H-2) as `daftar_app`, with a
 * real `invctl/1` assertion, inside a transaction that is rolled back. Each
 * refusal is asserted as SQLSTATE plus stable code. Each DENY group carries
 * a negative control: the same request with exactly that refusal removed
 * from the installed primitive (or the CHECK dropped) inside a rolled-back
 * savepoint, which must then be ACCEPTED (or fall through to a different
 * backstop), so a refusal that came from somewhere else turns the case red.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatQuantity, isQuantityRepresentable, parseQuantity } from '../../packages/inventory/src';
import vectors from '../../packages/inventory/vectors/valuation-vectors.json';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  FIXTURE_SOURCE_TYPE,
  INTERNAL,
  applyAsApp,
  applyOne,
  attempt,
  expectAccepted,
  expectConstraint,
  expectRefused,
  levelOf,
  movementsOf,
  must,
  req,
  scratch,
  seedStockBusiness,
  setScope,
  tryApply,
  withRolledBackFixture,
  withoutRefusal,
  type ApplyOptions,
  type Key,
  type MovementRequest,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

const R3 = 'inventory_apply_stock_movements(inventory_movement_request[])';

let biz: StockBusiness;
let K1: Key;
let K2: Key;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'prim');
  K1 = { warehouseId: biz.warehouse1, variantId: biz.piece.variantId };
  K2 = { warehouseId: biz.warehouse2, variantId: biz.piece.variantId };
});

/** The request is refused with this stable code. */
async function refused(c: Queryable, requests: readonly (MovementRequest | null)[] | null, code: string, why = '', o: ApplyOptions = {}): Promise<void> {
  expectRefused(await tryApply(c, biz, requests, o), 'P0001', code, why || code);
}

/** The request is accepted; its rows are returned. */
async function accepted(c: Queryable, requests: readonly MovementRequest[], why = '', o: ApplyOptions = {}) {
  return expectAccepted(await tryApply(c, biz, requests, o), why);
}

/** Stock on K with a known average: `qty` purchased at `cost`. */
async function stock(c: Client, key: Key, qty: string, cost: string): Promise<void> {
  await applyOne(c, biz, req(key, 'purchase', qty, { unitCost: cost }));
}

/** An owner-raw movement row with exactly the given stored columns (a cache row for its key must exist). */
function rawMovement(c: Queryable, v: { qty: string; cost: string | null; value: string; reason?: string | null; seq?: number }) {
  return attempt(c, () =>
    c.query(
      `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id,
                                    qty_delta, unit_cost_base_minor, value_delta_base_minor, reason, actor_user_id)
       VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, 'adjustment', $6, gen_random_uuid(), gen_random_uuid(), $7::numeric, $8::numeric, $9::bigint, $10, $11)`,
      [biz.tenantId, biz.businessId, K1.warehouseId, K1.variantId, v.seq ?? 1, FIXTURE_SOURCE_TYPE, v.qty, v.cost, v.value, v.reason ?? 'raw', biz.userId],
    ),
  );
}

async function ownerLevel(c: Queryable, key: Key): Promise<void> {
  await c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [
    biz.tenantId,
    biz.businessId,
    key.warehouseId,
    key.variantId,
  ]);
}

describe('T-07 — movement shape (P:159)', () => {
  it('T-07.1: a quantity movement whose computed value is 0 (vector C) is accepted and stored with its snapshot', async () => {
    await withRolledBackFixture(async (c) => {
      const row = await applyOne(c, biz, req(K1, 'purchase', '1', { unitCost: '0.4' }));
      expect({ qty: row.qty_delta, cost: row.unit_cost_base_minor, value: row.value_delta_base_minor }).toEqual({
        qty: '1.0000',
        cost: '0.4000000000',
        value: '0',
      });
    });
  });

  it('T-07.2: a value-only movement (qty 0, value ≠ 0, no cost) is accepted and stored without a snapshot', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '100');
      const row = await applyOne(c, biz, req(K1, 'negative_inventory_cost_adjustment', '0', { value: '-100' }));
      expect({
        qty: row.qty_delta,
        cost: row.unit_cost_base_minor,
        value: row.value_delta_base_minor,
        valuation: row.valuation_base_minor,
        avg: row.avg_unit_cost_base_minor,
      }).toEqual({
        qty: '0.0000',
        cost: null,
        value: '-100',
        valuation: '400',
        avg: '80.0000000000',
      });
    });
  });

  it('T-07.3 – T-07.5 (raw): the named CHECKs refuse a zero movement, a value-only row with a cost, a quantity row without a cost, a negative cost, a blank reason and an out-of-range value (23514)', async () => {
    await withRolledBackFixture(async (c) => {
      await ownerLevel(c, K1);
      expectConstraint(await rawMovement(c, { qty: '0', cost: null, value: '0' }), '23514', 'stock_movements_value_only_ck', 'qty 0 and value 0');
      expectConstraint(await rawMovement(c, { qty: '0', cost: '1', value: '5' }), '23514', 'stock_movements_cost_snapshot_ck', 'value-only with a cost');
      expectConstraint(await rawMovement(c, { qty: '1', cost: null, value: '5' }), '23514', 'stock_movements_cost_snapshot_ck', 'quantity without a cost');
      expectConstraint(await rawMovement(c, { qty: '1', cost: '-1', value: '5' }), '23514', 'stock_movements_cost_ck', 'negative cost');
      expectConstraint(await rawMovement(c, { qty: '1', cost: '1', value: '1', reason: '   ' }), '23514', 'stock_movements_reason_ck', 'blank reason');
      expectConstraint(await rawMovement(c, { qty: '1', cost: '1', value: '1000000000000000001' }), '23514', 'stock_movements_value_range_ck', 'value range');
      // The same rows are well-formed with the one fact corrected.
      expectAccepted(await rawMovement(c, { qty: '0', cost: null, value: '5', seq: 1 }));
      expectAccepted(await rawMovement(c, { qty: '1', cost: '1', value: '0', seq: 2 }));
    });
  });

  it('T-07.3 – T-07.5 .N: with each CHECK dropped in-transaction, the same raw row is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await ownerLevel(c, K1);
      for (const [ck, v] of [
        ['stock_movements_value_only_ck', { qty: '0', cost: null, value: '0' }],
        ['stock_movements_cost_snapshot_ck', { qty: '0', cost: '1', value: '5' }],
        ['stock_movements_cost_ck', { qty: '1', cost: '-1', value: '5' }],
      ] as const) {
        await scratch(c, async () => {
          await c.query(`ALTER TABLE stock_movements DROP CONSTRAINT ${ck}`);
          expectAccepted(await rawMovement(c, v), `${ck} dropped`);
        });
      }
    });
  });

  it('T-07.3 – T-07.5 (primitive): every malformed value/cost shape is refused with inventory.movement_shape_invalid before anything is written', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      const cases: [string, MovementRequest][] = [
        ['value-only with a zero value', req(K1, 'negative_inventory_cost_adjustment', '0', { value: '0' })],
        ['value-only with no value', req(K1, 'negative_inventory_cost_adjustment', '0')],
        ['value-only with a cost', req(K1, 'negative_inventory_cost_adjustment', '0', { value: '-1', unitCost: '1' })],
        ['inbound without a cost', req(K1, 'purchase', '1')],
        ['inbound value on a non-priced kind', req(K1, 'adjustment', '1', { unitCost: '1', value: '1', reason: 'x' })],
        ['negative supplied inbound value', req(K1, 'purchase', '1', { unitCost: '1', value: '-1' })],
        ['outbound with a cost', req(K1, 'damage', '-1', { unitCost: '1', reason: 'x' })],
        ['outbound with a value', req(K1, 'damage', '-1', { value: '-2', reason: 'x' })],
        ['transfer_in with a cost', req(K2, 'transfer_in', '1', { unitCost: '1' })],
      ];
      for (const [why, r] of cases) await refused(c, [r], 'inventory.movement_shape_invalid', why);
      expect(await movementsOf(c, biz.businessId, K1)).toHaveLength(1);
    });
  });

  it('T-07.N (primitive): without the shape refusal, a zero value-only request reaches the CHECK backstop instead (23514) and a cost-carrying value-only request likewise', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.movement_shape_invalid');
        const zero = await tryApply(c, biz, [req(K1, 'negative_inventory_cost_adjustment', '0', { value: '0' })]);
        expectConstraint(zero, '23514', 'stock_movements_value_only_ck');
        const costed = await tryApply(c, biz, [req(K1, 'negative_inventory_cost_adjustment', '0', { value: '-1', unitCost: '1' })]);
        expectAccepted(costed, 'value-only with a cost: the shape step was the only refusal, the value is taken and the snapshot dropped');
      });
    });
  });

  it('T-07.6: inventory.quantity_sign_invalid — negative purchase, zero purchase, non-zero cost adjustment, zero adjustment, positive damage/transfer_out', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      for (const [why, r] of [
        ['negative purchase', req(K1, 'purchase', '-1')],
        ['zero purchase', req(K1, 'purchase', '0', { unitCost: '1' })],
        ['non-zero cost adjustment', req(K1, 'negative_inventory_cost_adjustment', '1', { value: '-1' })],
        ['zero adjustment', req(K1, 'adjustment', '0', { value: '-1', reason: 'x' })],
        ['positive damage', req(K1, 'damage', '1', { unitCost: '1', reason: 'x' })],
        ['positive transfer_out', req(K1, 'transfer_out', '1', { unitCost: '1' })],
        ['zero stocktake', req(K1, 'stocktake', '0', { value: '1' })],
      ] as const) {
        await refused(c, [r], 'inventory.quantity_sign_invalid', why);
      }
    });
  });

  it('T-07.6.N: without the sign refusal, a "purchase" of −1 is accepted and takes stock out at the average', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.quantity_sign_invalid');
        const rows = await accepted(c, [req(K1, 'purchase', '-1')], 'negative purchase');
        expect(must(rows[0]).value_delta_base_minor).toBe('-2');
      });
    });
  });

  it('T-07.7: inventory.reason_required for damage and adjustment; the given reason is stored; a blank or 501-character reason is refused as a malformed request', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      await refused(c, [req(K1, 'damage', '-1')], 'inventory.reason_required', 'damage');
      await refused(c, [req(K1, 'adjustment', '1', { unitCost: '1' })], 'inventory.reason_required', 'adjustment +');
      await refused(c, [req(K1, 'adjustment', '-1')], 'inventory.reason_required', 'adjustment −');
      await refused(c, [req(K1, 'damage', '-1', { reason: '   ' })], 'inventory.movement_request_invalid', 'blank reason');
      await refused(c, [req(K1, 'damage', '-1', { reason: 'x'.repeat(501) })], 'inventory.movement_request_invalid', '501 characters');
      const d = await applyOne(c, biz, req(K1, 'damage', '-1', { reason: 'broken in transit' }));
      const a = await applyOne(c, biz, req(K1, 'adjustment', '1', { unitCost: '2', reason: 'x'.repeat(500) }));
      const stored = await movementsOf(c, biz.businessId, K1);
      expect(stored.find((m) => m.id === d.movement_id)?.reason).toBe('broken in transit');
      expect(stored.find((m) => m.id === a.movement_id)?.reason).toBe('x'.repeat(500));
      // A kind that does not require a reason may still carry one.
      const p = await applyOne(c, biz, req(K1, 'purchase', '1', { unitCost: '2', reason: 'supplier invoice' }));
      expect((await movementsOf(c, biz.businessId, K1)).find((m) => m.id === p.movement_id)?.reason).toBe('supplier invoice');
    });
  });

  it('T-07.7.N: without the reason refusal, a damage with no reason is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.reason_required');
        await accepted(c, [req(K1, 'damage', '-1')], 'no reason');
      });
    });
  });
});

describe('the request itself: shape, kind, scope and identity', () => {
  it('inventory.movement_request_invalid — a NULL array, an empty array, a NULL element, and each required NULL field', async () => {
    await withRolledBackFixture(async (c) => {
      await refused(c, null, 'inventory.movement_request_invalid', 'NULL array');
      await refused(c, [], 'inventory.movement_request_invalid', 'empty array');
      await refused(c, [req(K1, 'purchase', '1', { unitCost: '1' }), null], 'inventory.movement_request_invalid', 'NULL element');
      for (const field of ['warehouseId', 'variantId', 'kind', 'sourceType', 'sourceId', 'sourceLineId', 'qty'] as const) {
        await refused(c, [req(K1, 'purchase', '1', { unitCost: '1', [field]: null })], 'inventory.movement_request_invalid', `NULL ${field}`);
      }
      expect(await levelOf(c, biz.businessId, K1)).toBeNull();
    });
  });

  it('inventory.movement_kind_unknown for an unregistered kind; control: once registered and mapped in-transaction, the same kind is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      for (const kind of ['sale', 'Purchase', 'purchase ', 'fixture_receipt']) {
        await refused(c, [req(K1, kind, '1', { unitCost: '1' })], 'inventory.movement_kind_unknown', kind);
      }
      await scratch(c, async () => {
        await c.query(
          `INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by) VALUES ('fixture_receipt', 'positive', false, 'P3-S2')`,
        );
        await c.query(
          `INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES ('fixture.stock_move', 'fixture_receipt', 'P3-S2')`,
        );
        await accepted(c, [req(K1, 'fixture_receipt', '1', { unitCost: '1' })]);
      });
    });
  });

  it('inventory.movement_kind_not_authorized when the mapping row for the verified operation is removed in-transaction (control: present → accepted)', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      await accepted(c, [req(K1, 'damage', '-1', { reason: 'x' })], 'mapped');
      await c.query(`DELETE FROM inventory_operation_movement_kinds WHERE op_code = 'fixture.stock_move' AND movement_kind = 'damage'`);
      await refused(c, [req(K1, 'damage', '-1', { reason: 'x' })], 'inventory.movement_kind_not_authorized');
      // A batch is all-or-nothing: an authorized request beside it does not land either.
      await refused(
        c,
        [req(K1, 'purchase', '1', { unitCost: '1' }), req(K1, 'damage', '-1', { reason: 'x' })],
        'inventory.movement_kind_not_authorized',
        'batch',
      );
      expect(await movementsOf(c, biz.businessId, K1)).toHaveLength(2);
    });
  });

  it('inventory.warehouse_not_found / inventory.variant_not_found for ids that do not exist anywhere', async () => {
    await withRolledBackFixture(async (c) => {
      await refused(c, [req({ warehouseId: randomUUID(), variantId: K1.variantId }, 'purchase', '1', { unitCost: '1' })], 'inventory.warehouse_not_found');
      await refused(c, [req({ warehouseId: K1.warehouseId, variantId: randomUUID() }, 'purchase', '1', { unitCost: '1' })], 'inventory.variant_not_found');
    });
  });

  it('inventory.product_not_tracked for an untracked product’s variant; control: tracked in-transaction, the same request is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      const key = { warehouseId: biz.warehouse1, variantId: biz.untracked.variantId };
      await refused(c, [req(key, 'purchase', '1', { unitCost: '1' })], 'inventory.product_not_tracked');
      await scratch(c, async () => {
        await setScope(c, biz);
        await c.query(`SET LOCAL ROLE ${INTERNAL}`);
        await c.query(`UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE business_id = $1 AND id = $2`, [
          biz.businessId,
          biz.untracked.productId,
        ]);
        await c.query('RESET ROLE');
        await accepted(c, [req(key, 'purchase', '1', { unitCost: '1' })], 'tracked now');
      });
    });
  });

  it('A-29: a merchant variant beside a base variant → inventory.variant_not_stock_identity; the base variant and a variant product’s variants are accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await refused(
        c,
        [req({ warehouseId: biz.warehouse1, variantId: biz.mixed.merchantVariantId }, 'purchase', '1', { unitCost: '1' })],
        'inventory.variant_not_stock_identity',
      );
      await accepted(c, [req({ warehouseId: biz.warehouse1, variantId: biz.mixed.baseVariantId }, 'purchase', '1', { unitCost: '1' })], 'base');
      for (const v of biz.variantProduct.variantIds) {
        await accepted(c, [req({ warehouseId: biz.warehouse1, variantId: v }, 'purchase', '1', { unitCost: '1' })], 'variant product');
      }
    });
  });

  it('A-29.N: without the stock-identity refusal, stock lands on the merchant variant beside the base', async () => {
    await withRolledBackFixture(async (c) => {
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.variant_not_stock_identity');
        await accepted(c, [req({ warehouseId: biz.warehouse1, variantId: biz.mixed.merchantVariantId }, 'purchase', '1', { unitCost: '1' })]);
      });
    });
  });

  it('inventory.movement_identity_conflict for a repeated five-part identity (across calls and within one batch), never 23505, and nothing is written', async () => {
    await withRolledBackFixture(async (c) => {
      const first = req(K1, 'purchase', '2', { unitCost: '1' });
      await applyOne(c, biz, first);
      await refused(c, [{ ...first, qty: '3' }], 'inventory.movement_identity_conflict', 'across calls');
      const twice = req(K1, 'purchase', '1', { unitCost: '1' });
      await refused(c, [twice, twice], 'inventory.movement_identity_conflict', 'within one batch');
      // Same line, another kind, is a different identity (the transfer shape).
      const level = must(await levelOf(c, biz.businessId, K1));
      expect(level.last_stock_seq).toBe('1');
      expect(level.on_hand).toBe('2.0000');
    });
  });

  it('identity .N: without the stable check, the repeat reaches the immediate UNIQUE (23505 stock_movements_identity_uq)', async () => {
    await withRolledBackFixture(async (c) => {
      const first = req(K1, 'purchase', '2', { unitCost: '1' });
      await applyOne(c, biz, first);
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.movement_identity_conflict');
        expectConstraint(await tryApply(c, biz, [first]), '23505', 'stock_movements_identity_uq');
      });
    });
  });

  it('the primitive answers with what it STORED, as stored, per request in array order', async () => {
    await withRolledBackFixture(async (c) => {
      const rows = await applyAsApp(c, biz, [req(K2, 'purchase', '2', { unitCost: '1.5' }), req(K1, 'purchase', '3', { unitCost: '0.3333333333' })]);
      expect(
        rows.map((r) => [
          r.ordinal,
          r.warehouse_id,
          r.stock_seq,
          r.qty_delta,
          r.unit_cost_base_minor,
          r.value_delta_base_minor,
          r.on_hand,
          r.valuation_base_minor,
          r.avg_unit_cost_base_minor,
        ]),
      ).toEqual([
        [1, K2.warehouseId, '1', '2.0000', '1.5000000000', '3', '2.0000', '3', '1.5000000000'],
        [2, K1.warehouseId, '1', '3.0000', '0.3333333333', '1', '3.0000', '1', '0.3333333333'],
      ]);
      const stored = await movementsOf(c, biz.businessId, K1);
      expect(stored.map((m) => [m.id, m.qty_delta, m.unit_cost_base_minor, m.value_delta_base_minor])).toEqual([
        [must(rows[1]).movement_id, '3.0000', '0.3333333333', '1'],
      ]);
    });
  });
});

describe('M-1 — READ COMMITTED only', () => {
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
    it(`a stock command in a ${level} transaction → inventory.isolation_unsupported, and nothing is written`, async () => {
      await withRolledBackFixture(
        async (c) => {
          await refused(c, [req(K1, 'purchase', '1', { unitCost: '1' })], 'inventory.isolation_unsupported', level);
          expect(await levelOf(c, biz.businessId, K1)).toBeNull();
        },
        { isolation: level },
      );
    });
  }

  it('control: the same REPEATABLE READ command is accepted once the isolation refusal is removed in-transaction', async () => {
    await withRolledBackFixture(
      async (c) => {
        await scratch(c, async () => {
          await withoutRefusal(c, R3, 'inventory.isolation_unsupported');
          await accepted(c, [req(K1, 'purchase', '1', { unitCost: '1' })], 'refusal removed');
        });
      },
      { isolation: 'REPEATABLE READ' },
    );
  });
});

describe('T-08 — quantity precision (P:160)', () => {
  const productFor = (d: number): string => (d === 0 ? biz.piece.variantId : d === 2 ? biz.dec2.variantId : biz.dec4.variantId);

  it('P-01 … P-10 through R2 agree with the JSON and with the TypeScript twin', async () => {
    expect(vectors.precision).toHaveLength(10);
    for (const p of vectors.precision) {
      const r = await ownerPool().query<{ ok: boolean }>(`SELECT inventory_quantity_is_representable($1::numeric, $2::smallint) AS ok`, [
        p.qty,
        p.unitDecimals,
      ]);
      expect(must(r.rows[0]).ok, `${p.id} R2`).toBe(p.valid);
      expect(isQuantityRepresentable(parseQuantity(p.qty), p.unitDecimals), `${p.id} TS`).toBe(p.valid);
    }
  });

  it('P-01 … P-10 through the primitive: valid ones are stored at 4 dp, invalid ones → inventory.quantity_precision_invalid (P-03 as a damage after a +3 purchase)', async () => {
    await withRolledBackFixture(async (c) => {
      for (const p of vectors.precision) {
        const key = { warehouseId: biz.warehouse1, variantId: productFor(p.unitDecimals) };
        const negative = p.qty.startsWith('-');
        if (negative) await stock(c, key, '3', '1');
        const r = negative ? req(key, 'damage', p.qty, { reason: 'P-03' }) : req(key, 'purchase', p.qty, { unitCost: '1' });
        if (p.valid) {
          const row = must((await accepted(c, [r], p.id))[0]);
          expect(row.qty_delta, p.id).toBe(formatQuantity(parseQuantity(p.qty)));
        } else {
          await refused(c, [r], 'inventory.quantity_precision_invalid', p.id);
        }
      }
    });
  });

  it('T-08.7: the owner changing units.default_decimals for piece to 3 in-transaction changes nothing — the product’s own 0 governs', async () => {
    await withRolledBackFixture(async (c) => {
      await c.query(`UPDATE units SET default_decimals = 3 WHERE unit_code = 'piece'`);
      await refused(c, [req(K1, 'purchase', '1.5', { unitCost: '1' })], 'inventory.quantity_precision_invalid', '1.5 of a 0-dp product');
      await refused(c, [req(K1, 'purchase', '1.125', { unitCost: '1' })], 'inventory.quantity_precision_invalid', '1.125 of a 0-dp product');
      await accepted(c, [req(K1, 'purchase', '1.0000', { unitCost: '1' })]);
      const p = await c.query<{ d: number }>(`SELECT unit_decimals AS d FROM products WHERE id = $1`, [biz.piece.productId]);
      expect(p.rows).toEqual([{ d: 0 }]);
    });
  });

  it('T-08.N: a scale()-based rule (scale(qty) <= d) would refuse P-02 `1.0000` at 0 dp, which R2 accepts', async () => {
    const r = await ownerPool().query<{ scaleRule: boolean; r2: boolean }>(
      `SELECT scale('1.0000'::numeric) <= 0 AS "scaleRule", inventory_quantity_is_representable('1.0000'::numeric, 0::smallint) AS r2`,
    );
    expect(r.rows).toEqual([{ scaleRule: false, r2: true }]);
  });

  it('T-08.N (primitive): without the precision refusal, 0.5 of a piece is accepted — the check is what refuses', async () => {
    await withRolledBackFixture(async (c) => {
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.quantity_precision_invalid');
        await accepted(c, [req(K1, 'purchase', '0.5', { unitCost: '1' })]);
      });
    });
  });
});

describe('T-21 — insufficient stock', () => {
  const NEGATIVE: readonly { kind: string; reason?: string; other?: boolean }[] = [
    { kind: 'supplier_return' },
    { kind: 'transfer_out' },
    { kind: 'damage', reason: 'x' },
    { kind: 'adjustment', reason: 'x' },
    { kind: 'stocktake' },
    { kind: 'purchase_reversal', other: true },
  ];

  it('T-21.1: each negative kind with |qty| > on_hand → inventory.insufficient_stock, on a stocked key and on a key never stocked', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '2', '5');
      for (const n of NEGATIVE) {
        const o: ApplyOptions = n.other ? { other: true } : {};
        await refused(c, [req(K1, n.kind, '-3', { reason: n.reason ?? null })], 'inventory.insufficient_stock', `${n.kind} on K1`, o);
        await refused(c, [req(K2, n.kind, '-1', { reason: n.reason ?? null })], 'inventory.insufficient_stock', `${n.kind} on an empty key`, o);
      }
      expect(must(await levelOf(c, biz.businessId, K1)).on_hand).toBe('2.0000');
    });
  });

  it('T-21.N: without the insufficiency refusal, a damage of 3 from 2 is accepted and drives the key negative', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '2', '5');
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.insufficient_stock');
        const row = must((await accepted(c, [req(K1, 'damage', '-3', { reason: 'x' })]))[0]);
        expect({ onHand: row.on_hand, value: row.value_delta_base_minor }).toEqual({ onHand: '-1.0000', value: '-15' });
      });
    });
  });

  it('T-21.2: |qty| = on_hand is accepted by every negative kind and flushes exactly the stored valuation, carrying the average', async () => {
    await withRolledBackFixture(async (c) => {
      for (const n of NEGATIVE) {
        await scratch(c, async () => {
          // 7 units bought for a supplied share of 1: average 0.1428571429.
          await applyOne(c, biz, req(K1, 'purchase', '7', { unitCost: '0', value: '1' }));
          const row = await applyOne(c, biz, req(K1, n.kind, '-7', { reason: n.reason ?? null }), n.other ? { other: true } : {});
          expect(
            {
              value: row.value_delta_base_minor,
              snapshot: row.unit_cost_base_minor,
              onHand: row.on_hand,
              valuation: row.valuation_base_minor,
              avg: row.avg_unit_cost_base_minor,
            },
            n.kind,
          ).toEqual({ value: '-1', snapshot: '0.1428571429', onHand: '0.0000', valuation: '0', avg: '0.1428571429' });
        });
      }
    });
  });
});

describe('transfer pairs', () => {
  it('inventory.transfer_pair_missing for a transfer_in with no transfer_out of the same line', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      await refused(c, [req(K2, 'transfer_in', '2')], 'inventory.transfer_pair_missing', 'no pair at all');
      // An out leg of ANOTHER line does not pair.
      await applyOne(c, biz, req(K1, 'transfer_out', '-2'));
      await refused(c, [req(K2, 'transfer_in', '2')], 'inventory.transfer_pair_missing', 'other line');
    });
  });

  it('inventory.transfer_pair_mismatch for another quantity, the same warehouse, or another variant', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      const src = randomUUID();
      const line = randomUUID();
      await applyOne(c, biz, req(K1, 'transfer_out', '-2', { sourceId: src, sourceLineId: line }));
      const leg = (key: Key, qty: string) => req(key, 'transfer_in', qty, { sourceId: src, sourceLineId: line });
      await refused(c, [leg(K2, '3')], 'inventory.transfer_pair_mismatch', 'quantity');
      await refused(c, [leg(K1, '2')], 'inventory.transfer_pair_mismatch', 'same warehouse');
      await refused(c, [leg({ warehouseId: biz.warehouse2, variantId: biz.dec2.variantId }, '2')], 'inventory.transfer_pair_mismatch', 'variant');
      const row = await applyOne(c, biz, leg(K2, '2'));
      expect({ value: row.value_delta_base_minor, snapshot: row.unit_cost_base_minor }).toEqual({ value: '4', snapshot: '2.0000000000' });
    });
  });

  it('transfer .N: without the mismatch refusal, a transfer_in of 3 against an out of 2 is accepted — value created from nothing', async () => {
    await withRolledBackFixture(async (c) => {
      await stock(c, K1, '5', '2');
      const src = randomUUID();
      const line = randomUUID();
      await applyOne(c, biz, req(K1, 'transfer_out', '-2', { sourceId: src, sourceLineId: line }));
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.transfer_pair_mismatch');
        await accepted(c, [req(K2, 'transfer_in', '3', { sourceId: src, sourceLineId: line })]);
      });
    });
  });
});

describe('bounds', () => {
  it('inventory.value_out_of_range — a supplied value beyond 10^18, and a valuation that would pass it', async () => {
    await withRolledBackFixture(async (c) => {
      await refused(c, [req(K1, 'purchase', '1', { unitCost: '1', value: '1000000000000000001' })], 'inventory.value_out_of_range', 'value');
      await applyOne(c, biz, req(K1, 'purchase', '1', { unitCost: '1', value: '600000000000000000' }));
      await refused(c, [req(K1, 'purchase', '1', { unitCost: '1', value: '600000000000000000' })], 'inventory.value_out_of_range', 'valuation');
      await accepted(c, [req(K1, 'purchase', '1', { unitCost: '1', value: '400000000000000000' })], 'exactly 10^18');
    });
  });

  it('inventory.quantity_out_of_range (M-3: |qty| and |on_hand| < 10^10) — 9999999999 is accepted, 10000000000 refused, and an on-hand that would reach 10^10 refused', async () => {
    await withRolledBackFixture(async (c) => {
      for (const q of ['10000000000', '100000000000000']) {
        await refused(c, [req(K1, 'purchase', q, { unitCost: '0' })], 'inventory.quantity_out_of_range', `quantity ${q}`);
      }
      const row = await applyOne(c, biz, req(K1, 'purchase', '9999999999', { unitCost: '0' }));
      expect(row.on_hand).toBe('9999999999.0000');
      await refused(c, [req(K1, 'purchase', '1', { unitCost: '0' })], 'inventory.quantity_out_of_range', 'on hand 10^10');
      // The bound is symmetric: an outbound of 10^10 is refused as out of range before it is judged on stock.
      await refused(c, [req(K1, 'damage', '-10000000000', { reason: 'x' })], 'inventory.quantity_out_of_range', 'outbound 10^10');
      expect((await applyOne(c, biz, req(K1, 'damage', '-9999999999', { reason: 'x' }))).on_hand).toBe('0.0000');
    });
  });

  it('bounds .N: without the quantity-range refusal, 10^10 units are accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.quantity_out_of_range');
        await accepted(c, [req(K1, 'purchase', '10000000000', { unitCost: '0' })]);
      });
    });
  });

  it('inventory.cost_invalid — negative, finer than 10 dp, and at the 10^18 limit', async () => {
    await withRolledBackFixture(async (c) => {
      for (const cost of ['-1', '0.00000000001', '1000000000000000000']) {
        await refused(c, [req(K1, 'purchase', '1', { unitCost: cost })], 'inventory.cost_invalid', cost);
      }
      await accepted(c, [req(K1, 'purchase', '1', { unitCost: '0.0000000001' })], '10 dp');
    });
  });

  it('bounds .N: without the cost refusal, a negative cost reaches the CHECK backstop (23514 stock_movements_cost_ck)', async () => {
    await withRolledBackFixture(async (c) => {
      await scratch(c, async () => {
        await withoutRefusal(c, R3, 'inventory.cost_invalid');
        expectConstraint(await tryApply(c, biz, [req(K1, 'purchase', '1', { unitCost: '-1', value: '0' })]), '23514', 'stock_movements_cost_ck');
      });
    });
  });
});
