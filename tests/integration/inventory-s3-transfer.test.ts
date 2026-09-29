/**
 * P3-S3 T-03 and T-05 — TRANSFERS AND THE §E NINE-STATE COMPLETENESS VECTOR
 * (docs/PHASE_3_S3_CONTRACT.md A-03, A-15, §6 T-03, T-05; plan §5 must-prove
 * "transfer valuation delta is exactly 0", "creates no journal entry",
 * "the nine-state completeness vector").
 *
 * T-03 drives the REAL `inventory_transfer_stock` as `daftar_app` under a real
 * `invctl/1` assertion. T-05 is the H-6 tamper harness: as the schema owner,
 * inside a transaction that is always rolled back, it writes each incomplete
 * shape a transfer could be left in and shows the named mechanism refusing it
 * at COMMIT (`atCommit`) — each paired with the honest shape accepted, and the
 * line-completeness trigger with a negative control that drops it.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  atCommit,
  attempt,
  cacheValue,
  counts,
  damageCommand,
  delta,
  expectAccepted,
  expectConstraint,
  glInventory,
  movementValue,
  must,
  onHand,
  openingCommand,
  ownerClient,
  refusedWith,
  roundingLines,
  runCommand,
  scratch,
  seedS3World,
  stockState,
  today,
  transferCommand,
  tryCommand,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { runFinancial, runOpening, stockUp } from '../helpers/inventory-posting';

let world: S3World;
let day: string;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'xfer');
  day = await today();
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

describe('T-03 transfer valuation (must-prove: the valuation delta is exactly 0)', () => {
  it('AL08-TRANSFER-GOLD44 reproduces: out −500 at the source average, in +500, destination avg 166.6666666667, business value unchanged, no entry', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '10', unitCost: '100' }]);
      await stockUp(c, A, A.w2, [{ variantId: v, qty: '10', unitCost: '200' }]);
      const before = await counts(c, A.businessId);
      const valueBefore = await cacheValue(c, A.businessId);
      const glBefore = await glInventory(c, A.businessId);
      expect([valueBefore, glBefore]).toEqual([3000n, 3000n]);

      const t = transferCommand(A.w1, A.w2, [{ variantId: v, qty: '5' }]);
      const rows = await runCommand(c, A, t);
      expect(rows.map((r) => [r.document_id, r.replayed, r.variant_id, r.value])).toEqual([[t.transferId, false, v, '500']]);

      const moves = await c.query<{ k: string; w: string; q: string; val: string; cost: string; seq: string }>(
        `SELECT movement_kind AS k, warehouse_id::text AS w, qty_delta::text AS q, value_delta_base_minor::text AS val,
                unit_cost_base_minor::text AS cost, stock_seq::text AS seq
           FROM stock_movements WHERE business_id = $1 AND source_id = $2 ORDER BY movement_kind DESC`,
        [A.businessId, t.transferId],
      );
      expect(moves.rows).toEqual([
        { k: 'transfer_out', w: A.w1, q: '-5.0000', val: '-500', cost: '100.0000000000', seq: '2' },
        { k: 'transfer_in', w: A.w2, q: '5.0000', val: '500', cost: '100.0000000000', seq: '2' },
      ]);
      const src = await stockState(c, A.businessId, { warehouseId: A.w1, variantId: v });
      const dst = await stockState(c, A.businessId, { warehouseId: A.w2, variantId: v });
      // P:190: the source average is unchanged; the destination average is recomputed.
      expect([src.onHand, src.valuation, src.avg]).toEqual([50000n, 500n, 1000000000000n]);
      expect([dst.onHand, dst.valuation, dst.avg]).toEqual([150000n, 2500n, 1666666666667n]);

      // P:193/P:197: exactly zero valuation delta, no journal entry, one assertion consumed, one audit and one outbox row.
      expect(await cacheValue(c, A.businessId)).toBe(valueBefore);
      expect(await glInventory(c, A.businessId)).toBe(glBefore);
      expect(delta(before, await counts(c, A.businessId))).toEqual({
        stock_movements: 2,
        stock_source_bindings: 2,
        stock_source_bridge_inventory_transfer: 2,
        inventory_transfers: 1,
        inventory_transfer_lines: 1,
        audit_events: 1,
        outbox_events: 1,
        inventory_assertion_uses: 1,
      });
      const audit = must(
        (
          await c.query<{ action: string; trace: string }>(
            `SELECT action, metadata->>'business_transaction_id' AS trace FROM audit_events WHERE business_id = $1 AND entity_id = $2`,
            [A.businessId, t.transferId],
          )
        ).rows[0],
      );
      expect(audit.action).toBe('inventory.transfer_completed');
      const header = must(
        (await c.query<{ trace: string }>(`SELECT business_transaction_id::text AS trace FROM inventory_transfers WHERE id = $1`, [t.transferId])).rows[0],
      );
      expect(audit.trace).toBe(header.trace);
      expectAccepted(await atCommit(c), 'the transfer commits with no entry owed');
      expect(await glInventory(c, A.businessId)).toBe(await movementValue(c, A.businessId));
      expect(await roundingLines(c, A.businessId)).toBe(0);
    });
  });

  it('vector H: emptying the source moves the flush (−7/+7), not the rounded average', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      // 3 @ 3.3333333333 is 10 by HALF_EVEN of the weight (the vector's value 10), through a Case A opening.
      const o = await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: v, qty: '3', unitCost: '3.3333333333' }]));
      expect(o.rows.map((r) => r.value)).toEqual(['10']);
      const d = await runFinancial(c, A, await damageCommand(c, A, A.w1, [{ variantId: v, qty: '1' }]));
      expect(must(d.rows[0]).value).toBe('-3');
      const before = await cacheValue(c, A.businessId);
      const rows = await runCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '2' }]));
      expect(must(rows[0]).value).toBe('7');
      const src = await stockState(c, A.businessId, { warehouseId: A.w1, variantId: v });
      const dst = await stockState(c, A.businessId, { warehouseId: A.w2, variantId: v });
      expect([src.onHand, src.valuation]).toEqual([0n, 0n]);
      expect([dst.onHand, dst.valuation, dst.avg]).toEqual([20000n, 7n, 35000000000n]);
      expect(await cacheValue(c, A.businessId)).toBe(before);
      expectAccepted(await atCommit(c));
      expect(await glInventory(c, A.businessId)).toBe(7n);
      expect(await movementValue(c, A.businessId)).toBe(7n);
    });
  });

  it('a multi-line transfer with a decimal unit moves every line and still nets to zero', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w2, [
        { variantId: A.dec2.variantId, qty: '7.25', unitCost: '13' },
        { variantId: A.variantProduct.variantIds[0], qty: '3', unitCost: '9.99' },
      ]);
      const before = await cacheValue(c, A.businessId);
      const t = transferCommand(A.w2, A.w1, [
        { variantId: A.dec2.variantId, qty: '1.5' },
        { variantId: A.variantProduct.variantIds[0], qty: '3' },
      ]);
      const rows = await runCommand(c, A, t);
      expect(rows.map((r) => r.variant_id)).toEqual([A.dec2.variantId, A.variantProduct.variantIds[0]]);
      expect(await cacheValue(c, A.businessId)).toBe(before);
      expect(await onHand(c, A.businessId, { warehouseId: A.w1, variantId: A.dec2.variantId })).toBe('1.5000');
      expectAccepted(await atCommit(c));
    });
  });

  it('refuses source == destination, an archived destination, a foreign warehouse or variant, an untracked product, over-issue; the twin is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '10', unitCost: '100' }]);
      const before = await counts(c, A.businessId);
      refusedWith(
        await tryCommand(c, A, transferCommand(A.w1, A.w1, [{ variantId: v, qty: '1' }]), { raw: true }),
        'P0001',
        'inventory.transfer_same_warehouse',
      );
      // A cross-business pair (L:541): the other business's warehouse does not exist in A.
      refusedWith(await tryCommand(c, A, transferCommand(A.w1, world.A2.w1, [{ variantId: v, qty: '1' }])), 'P0001', 'inventory.warehouse_not_found', 'A → A2');
      refusedWith(await tryCommand(c, A, transferCommand(A.w1, world.B.w1, [{ variantId: v, qty: '1' }])), 'P0001', 'inventory.warehouse_not_found', 'A → B');
      refusedWith(
        await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: world.A2.piece.variantId, qty: '1' }])),
        'P0001',
        'inventory.variant_not_found',
        'A2 variant',
      );
      refusedWith(
        await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.untracked.variantId, qty: '1' }])),
        'P0001',
        'inventory.product_not_tracked',
      );
      refusedWith(await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '11' }])), 'P0001', 'inventory.insufficient_stock');
      refusedWith(await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '0' }]), { raw: true }), 'P0001', 'inventory.quantity_sign_invalid');
      await scratch(c, async () => {
        await c.query(`UPDATE warehouses SET status = 'archived' WHERE business_id = $1 AND id = $2`, [A.businessId, A.w2]);
        refusedWith(await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '1' }])), 'P0001', 'inventory.warehouse_archived');
      });
      expect(delta(before, await counts(c, A.businessId)), 'no refused transfer wrote anything').toEqual({});
      expectAccepted(await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '10' }])), 'the honest twin');
      expectAccepted(await atCommit(c));
    });
  });
});

// ── T-05: the §E nine-state vector under H-6 ───────────────────────────────

/** Owner-written transfer header and one line of `qty` of `variantId`, W1 → W2. */
async function ownerTransfer(b: S3Business, qty = '2'): Promise<{ transferId: string; lineId: string }> {
  const transferId = randomUUID();
  const lineId = randomUUID();
  await c.query(
    `INSERT INTO inventory_transfers (tenant_id, business_id, id, source_warehouse_id, destination_warehouse_id, intent_sha256, actor_user_id, business_transaction_id)
     VALUES ($1, $2, $3, $4, $5, repeat('a', 64), $6, $7)`,
    [b.tenantId, b.businessId, transferId, b.w1, b.w2, b.userId, randomUUID()],
  );
  await c.query(
    `INSERT INTO inventory_transfer_lines (tenant_id, business_id, transfer_id, id, line_no, variant_id, qty) VALUES ($1, $2, $3, $4, 1, $5, $6::numeric)`,
    [b.tenantId, b.businessId, transferId, lineId, b.piece.variantId, qty],
  );
  return { transferId, lineId };
}

interface LegParts {
  readonly binding?: boolean;
  readonly bridge?: boolean;
  readonly movement?: boolean;
}

/** One owner-written leg of a transfer line: its cache row, binding, bridge row and movement (any part may be left out). */
async function ownerLeg(
  b: S3Business,
  t: { transferId: string; lineId: string },
  kind: string,
  warehouseId: string,
  qty: string,
  parts: LegParts = {},
): Promise<void> {
  const variantId = b.piece.variantId;
  const cur = (
    await c.query<{ seq: string; on_hand: string; val: string }>(
      `SELECT last_stock_seq::text AS seq, on_hand::text AS on_hand, valuation_base_minor::text AS val FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
      [b.businessId, warehouseId, variantId],
    )
  ).rows[0];
  const seq = Number(cur?.seq ?? '0') + 1;
  const value = (BigInt(qty.replace('.0000', '')) * 10n).toString();
  if (parts.movement !== false) {
    await c.query(
      `INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::bigint, 10, $7)
       ON CONFLICT (business_id, warehouse_id, variant_id) DO UPDATE
         SET on_hand = stock_levels.on_hand + EXCLUDED.on_hand, valuation_base_minor = stock_levels.valuation_base_minor + EXCLUDED.valuation_base_minor,
             last_stock_seq = EXCLUDED.last_stock_seq`,
      [b.tenantId, b.businessId, warehouseId, variantId, qty, value, seq],
    );
  }
  if (parts.binding !== false) {
    await c.query(
      `INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) VALUES ($1, $2, 'inventory_transfer', $3, $4, $5)`,
      [b.tenantId, b.businessId, t.transferId, t.lineId, kind],
    );
  }
  if (parts.bridge !== false) {
    await c.query(`INSERT INTO stock_source_bridge_inventory_transfer (business_id, source_id, source_line_id, movement_kind) VALUES ($1, $2, $3, $4)`, [
      b.businessId,
      t.transferId,
      t.lineId,
      kind,
    ]);
  }
  if (parts.movement !== false) {
    await c.query(
      `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id,
                                    source_line_id, qty_delta, unit_cost_base_minor, value_delta_base_minor, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'inventory_transfer', $8, $9, $10::numeric, 10, $11::bigint, NULL, $12)`,
      [b.tenantId, b.businessId, randomUUID(), warehouseId, variantId, seq, kind, t.transferId, t.lineId, qty, value, b.userId],
    );
  }
}

describe('T-05 the §E nine-state vector: each incomplete transfer is refused by its named mechanism (H-6)', () => {
  it('ALLOW: the complete owner-written shape (header, line, out and in, each bound and bridged) commits', async () => {
    await inTx(async () => {
      const A = world.A;
      const t = await ownerTransfer(A);
      await ownerLeg(A, t, 'transfer_out', A.w1, '-2');
      await ownerLeg(A, t, 'transfer_in', A.w2, '2');
      expectAccepted(await atCommit(c), 'the honest shape — the harness itself is sound');
    });
  });

  it('1. only the out leg: source_movement_set_incomplete', async () => {
    await inTx(async () => {
      const t = await ownerTransfer(world.A);
      await ownerLeg(world.A, t, 'transfer_out', world.A.w1, '-2');
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete');
    });
  });

  it('negative control for 1: with stock_source_complete_inventory_transfer dropped, the half transfer would commit', async () => {
    await inTx(async () => {
      await c.query('DROP TRIGGER stock_source_complete_inventory_transfer ON inventory_transfer_lines');
      const t = await ownerTransfer(world.A);
      await ownerLeg(world.A, t, 'transfer_out', world.A.w1, '-2');
      expectAccepted(await atCommit(c), 'the attack succeeds without the trigger');
    });
  });

  it('2. only the in leg: source_movement_set_incomplete', async () => {
    await inTx(async () => {
      const t = await ownerTransfer(world.A);
      await ownerLeg(world.A, t, 'transfer_in', world.A.w2, '2');
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete');
    });
  });

  it('a leg with the wrong quantity or warehouse counts as missing: source_movement_set_incomplete', async () => {
    await inTx(async () => {
      const A = world.A;
      await scratch(c, async () => {
        const t = await ownerTransfer(A);
        await ownerLeg(A, t, 'transfer_out', A.w1, '-2');
        await ownerLeg(A, t, 'transfer_in', A.w2, '3');
        refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete', 'in of 3 for a line of 2');
      });
      const t = await ownerTransfer(A);
      await ownerLeg(A, t, 'transfer_out', A.w2, '-2');
      await ownerLeg(A, t, 'transfer_in', A.w2, '2');
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete', 'out from the destination');
    });
  });

  it('3/4. a duplicate out or in on the line: refused by the binding identity (23505)', async () => {
    for (const [kind, wh, qty] of [
      ['transfer_out', 'w1', '-2'],
      ['transfer_in', 'w2', '2'],
    ] as const) {
      await inTx(async () => {
        const A = world.A;
        const t = await ownerTransfer(A);
        await ownerLeg(A, t, 'transfer_out', A.w1, '-2');
        await ownerLeg(A, t, 'transfer_in', A.w2, '2');
        expectConstraint(await attempt(c, () => ownerLeg(A, t, kind, A[wh], qty)), '23505', 'stock_source_bindings_pkey', `duplicate ${kind}`);
      });
    }
  });

  it('5. a binding with no movement: the binding → movement FK (23503)', async () => {
    await inTx(async () => {
      const A = world.A;
      const t = await ownerTransfer(A);
      await ownerLeg(A, t, 'transfer_out', A.w1, '-2');
      await ownerLeg(A, t, 'transfer_in', A.w2, '2');
      // A third, bridged binding on the complete line, of another registered kind, with no movement.
      await ownerLeg(A, t, 'adjustment', A.w1, '-1', { movement: false });
      expectConstraint(await atCommit(c), '23503', 'stock_source_bindings_movement_fk');
    });
  });

  it('6. a movement with no binding: the movement → binding FK (23503)', async () => {
    await inTx(async () => {
      const A = world.A;
      const t = await ownerTransfer(A);
      await ownerLeg(A, t, 'transfer_out', A.w1, '-2');
      await ownerLeg(A, t, 'transfer_in', A.w2, '2');
      await ownerLeg(A, t, 'adjustment', A.w1, '-1', { binding: false, bridge: false });
      expectConstraint(await atCommit(c), '23503', 'stock_movements_binding_fk');
    });
  });

  it('7. a movement and binding with no line: stock_source_line_missing without a bridge, the line FK with one', async () => {
    await inTx(async () => {
      const A = world.A;
      const t = await ownerTransfer(A);
      await ownerLeg(A, t, 'transfer_out', A.w1, '-2');
      await ownerLeg(A, t, 'transfer_in', A.w2, '2');
      const orphan = { transferId: t.transferId, lineId: randomUUID() };
      await scratch(c, async () => {
        await ownerLeg(A, orphan, 'transfer_out', A.w1, '-1', { bridge: false });
        refusedWith(await atCommit(c), 'P0001', 'inventory.stock_source_line_missing');
      });
      expectConstraint(await attempt(c, () => ownerLeg(A, orphan, 'transfer_out', A.w1, '-1')), '23503', 'stock_source_bridge_inventory_transfer_line_fk');
    });
  });

  it('8/9. a posted line cannot be deleted or edited, its header neither, and its bridge rows are append-only', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const t = transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]);
      await runCommand(c, A, t);
      expectAccepted(await atCommit(c));
      const attempts: readonly [string, string, string][] = [
        ['DELETE FROM inventory_transfer_lines WHERE transfer_id = $1', 'P0001', 'inventory.source_line_frozen'],
        ['UPDATE inventory_transfer_lines SET qty = qty + 1 WHERE transfer_id = $1', 'P0001', 'inventory.source_line_frozen'],
        ['UPDATE inventory_transfer_lines SET variant_id = variant_id WHERE transfer_id = $1', 'P0001', 'inventory.source_line_frozen'],
        [
          `UPDATE inventory_transfers SET destination_warehouse_id = source_warehouse_id, source_warehouse_id = destination_warehouse_id WHERE id = $1`,
          'P0001',
          'inventory.source_document_immutable',
        ],
        ['DELETE FROM inventory_transfers WHERE id = $1', 'P0001', 'inventory.source_document_immutable'],
        ['DELETE FROM stock_source_bridge_inventory_transfer WHERE source_id = $1', 'P0001', 'inventory.ledger_immutable'],
        [`UPDATE stock_source_bridge_inventory_transfer SET movement_kind = 'adjustment' WHERE source_id = $1`, 'P0001', 'inventory.ledger_immutable'],
      ];
      for (const [sql, state, code] of attempts) {
        refusedWith(await attempt(c, () => c.query(sql, [t.transferId])), state, code, sql);
      }
    });
  });
});
