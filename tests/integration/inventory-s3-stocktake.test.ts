/**
 * P3-S3 T-07 — STOCKTAKE: THE STRICT STATE MACHINE, CAPTURE, AND FINALIZE
 * VALUATION (docs/PHASE_3_S3_CONTRACT.md A-04, A-11, §6 T-07; plan §5
 * must-prove "intervening movements do not corrupt the variance",
 * "finalizing twice applies once", "a positive variance on a zero-cost key
 * gives unit_cost_required").
 *
 * Open, count and finalize/cancel run through the REAL routines as
 * `daftar_app`; the finalization's entry is posted by the real primitive in
 * the same transaction. Raw state changes are attempted as the schema owner
 * (H-6). Every case is rolled back.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  adjustCommand,
  atCommit,
  attempt,
  cancelCommand,
  counts,
  countCommand,
  delta,
  entryOf,
  expectAccepted,
  expectConstraint,
  finalizeCommand,
  glInventory,
  movementValue,
  must,
  onHand,
  ownerClient,
  refusedWith,
  runCommand,
  seedS3World,
  stockState,
  stocktakeLines,
  stocktakeOpenCommand,
  today,
  transferCommand,
  tryCommand,
  withoutRefusal,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { runFinancial, stockUp } from '../helpers/inventory-posting';

let world: S3World;
let day: string;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'stk');
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

/** Open a draft on `warehouseId` and count the given lines; returns its id. */
async function openAndCount(b: S3Business, warehouseId: string, lines: readonly { variantId: string; counted: string }[]): Promise<string> {
  const open = stocktakeOpenCommand(warehouseId);
  expect(await runCommand(c, b, open)).toEqual([{ stocktake_id: open.stocktakeId, replayed: false }]);
  if (lines.length > 0) await runCommand(c, b, countCommand(open.stocktakeId, warehouseId, lines));
  return open.stocktakeId;
}

async function statusOf(id: string): Promise<string> {
  return must((await c.query<{ status: string }>(`SELECT status FROM stocktakes WHERE id = $1`, [id])).rows[0]).status;
}

describe('T-07.2/3 capture and the intervening movements (PM-07, P:196)', () => {
  it('capture, then an adjustment AND a transfer on the same key, then finalize: on-hand = counted + intervening movements, exactly', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      const key = { warehouseId: A.w1, variantId: v };
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '10', unitCost: '100' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '8' }]);
      const [line] = await stocktakeLines(c, A.businessId, id);
      expect(line).toEqual({ variant_id: v, variance_qty: '-2.0000' });
      const cap = must(
        (
          await c.query<{ e: string; s: string }>(
            `SELECT expected_qty_at_capture::text AS e, captured_at_stock_seq::text AS s FROM stocktake_lines WHERE stocktake_id = $1`,
            [id],
          )
        ).rows[0],
      );
      expect(cap).toEqual({ e: '10.0000', s: '1' });

      // Intervening: an adjustment −1 and a transfer of 3 out of the counted key.
      await runFinancial(c, A, await adjustCommand(c, A, A.w1, [{ variantId: v, qty: '-1' }]));
      await runCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '3' }]));
      expect(await onHand(c, A.businessId, key)).toBe('6.0000');

      const fin = await finalizeCommand(c, A, id, A.w1);
      expect(fin.lines).toEqual([{ variantId: v, variance: '-2.0000', unitCost: null, expected: -200n }]);
      const r = await runFinancial(c, A, fin);
      expect(r.rows.map((x) => [x.status, x.replayed, x.value, x.total])).toEqual([['finalized', false, '-200', '-200']]);
      // counted 8 + intervening (−1 −3) = 4.
      expect(await onHand(c, A.businessId, key)).toBe('4.0000');
      const e = must(await entryOf(c, A.businessId, 'inventory_adjustment', id));
      expect(e.lines.map((l) => [l.system_key, l.debit, l.credit, l.warehouse_id])).toEqual([
        ['cogs', '200', '0', A.w1],
        ['inventory', '0', '200', A.w1],
      ]);
      expectAccepted(await atCommit(c));
      expect(await glInventory(c, A.businessId)).toBe(await movementValue(c, A.businessId));
    });
  });

  it('an identical recount changes nothing (changed = false, capture kept); a different recount re-captures', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '10', unitCost: '100' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '8' }]);
      await runCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '3' }]));
      const same = await runCommand(c, A, countCommand(id, A.w1, [{ variantId: v, counted: '8' }]));
      expect(same.map((r) => [r.changed, r.expected_qty_at_capture, r.captured_at_stock_seq, r.variance_qty])).toEqual([[false, '10.0000', '1', '-2.0000']]);
      const again = await runCommand(c, A, countCommand(id, A.w1, [{ variantId: v, counted: '6' }]));
      expect(again.map((r) => [r.changed, r.expected_qty_at_capture, r.captured_at_stock_seq, r.variance_qty])).toEqual([[true, '7.0000', '2', '-1.0000']]);
    });
  });

  it('count refusals: descending order, a negative count, excess precision, an untracked product, a foreign variant, another warehouse', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await openAndCount(A, A.w1, []);
      const [lo, hi] = [A.piece.variantId, A.piece2.variantId].sort();
      const desc = {
        kind: 'stocktake_count' as const,
        stocktakeId: id,
        warehouseId: A.w1,
        lines: [
          { variantId: must(hi), counted: '1' },
          { variantId: must(lo), counted: '1' },
        ],
      };
      refusedWith(await tryCommand(c, A, desc, { raw: true }), 'P0001', 'inventory.payload_invalid', 'descending');
      refusedWith(
        await tryCommand(c, A, countCommand(id, A.w1, [{ variantId: A.piece.variantId, counted: '-1' }]), { raw: true }),
        'P0001',
        'inventory.quantity_sign_invalid',
      );
      refusedWith(
        await tryCommand(c, A, countCommand(id, A.w1, [{ variantId: A.dec2.variantId, counted: '1.234' }])),
        'P0001',
        'inventory.quantity_precision_invalid',
      );
      refusedWith(
        await tryCommand(c, A, countCommand(id, A.w1, [{ variantId: A.untracked.variantId, counted: '1' }])),
        'P0001',
        'inventory.product_not_tracked',
      );
      refusedWith(
        await tryCommand(c, A, countCommand(id, A.w1, [{ variantId: world.A2.piece.variantId, counted: '1' }])),
        'P0001',
        'inventory.variant_not_found',
      );
      refusedWith(
        await tryCommand(c, A, countCommand(id, A.w2, [{ variantId: A.piece.variantId, counted: '1' }])),
        'P0001',
        'inventory.stocktake_not_found',
        'wrong warehouse',
      );
      refusedWith(
        await tryCommand(c, A, countCommand(randomUUID(), A.w1, [{ variantId: A.piece.variantId, counted: '1' }])),
        'P0001',
        'inventory.stocktake_not_found',
      );
      expectAccepted(await tryCommand(c, A, countCommand(id, A.w1, [{ variantId: A.dec2.variantId, counted: '1.23' }])), 'the honest count');
    });
  });
});

describe('T-07.2 one draft per warehouse', () => {
  it('a second draft on the same warehouse is refused stocktake_already_open; another warehouse, or after closing, is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const first = await openAndCount(A, A.w1, []);
      refusedWith(await tryCommand(c, A, stocktakeOpenCommand(A.w1)), 'P0001', 'inventory.stocktake_already_open');
      expectAccepted(await tryCommand(c, A, stocktakeOpenCommand(A.w2)), 'another warehouse');
      await runCommand(c, A, cancelCommand(first, A.w1));
      expectAccepted(await tryCommand(c, A, stocktakeOpenCommand(A.w1)), 'after the first is closed');
    });
  });

  it('negative control: with the routine check removed, the partial unique index is the physical backstop (23505)', async () => {
    await inTx(async () => {
      const A = world.A;
      await openAndCount(A, A.w1, []);
      await withoutRefusal(c, 'inventory_stocktake_open(uuid,uuid)', 'inventory.stocktake_already_open');
      expectConstraint(await tryCommand(c, A, stocktakeOpenCommand(A.w1)), '23505', 'stocktakes_one_draft_per_warehouse_uq');
    });
  });
});

describe('T-07.1 the strict state machine: draft → finalized | cancelled, nothing else', () => {
  it('through the commands: a closed stocktake refuses a count and any other closing decision', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const fin = await openAndCount(A, A.w1, [{ variantId: v, counted: '4' }]);
      const f = await finalizeCommand(c, A, fin, A.w1);
      await runFinancial(c, A, f);
      refusedWith(await tryCommand(c, A, cancelCommand(fin, A.w1)), 'P0001', 'inventory.stocktake_state_invalid', 'finalized → cancelled');
      refusedWith(await tryCommand(c, A, { ...f, occurredOn: '2020-01-01' }), 'P0001', 'inventory.stocktake_state_invalid', 'finalized again, another date');
      refusedWith(
        await tryCommand(c, A, countCommand(fin, A.w1, [{ variantId: v, counted: '1' }])),
        'P0001',
        'inventory.stocktake_state_invalid',
        'count on finalized',
      );

      const can = await openAndCount(A, A.w1, [{ variantId: v, counted: '3' }]);
      await runCommand(c, A, cancelCommand(can, A.w1));
      const late = await finalizeCommand(c, A, can, A.w1);
      refusedWith(await tryCommand(c, A, late), 'P0001', 'inventory.stocktake_state_invalid', 'cancelled → finalized');
      refusedWith(
        await tryCommand(c, A, countCommand(can, A.w1, [{ variantId: v, counted: '1' }])),
        'P0001',
        'inventory.stocktake_state_invalid',
        'count on cancelled',
      );
      expect([await statusOf(fin), await statusOf(can)]).toEqual(['finalized', 'cancelled']);
    });
  });

  it('as the schema owner: every transition outside draft→finalized|cancelled, and any other field change, is refused', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const fin = await openAndCount(A, A.w1, [{ variantId: v, counted: '4' }]);
      await runFinancial(c, A, await finalizeCommand(c, A, fin, A.w1));
      const can = await openAndCount(A, A.w1, [{ variantId: v, counted: '3' }]);
      await runCommand(c, A, cancelCommand(can, A.w1));
      const draft = await openAndCount(A, A.w1, [{ variantId: v, counted: '2' }]);
      const cases: readonly [string, string, string][] = [
        [fin, 'draft', 'finalized → draft'],
        [fin, 'cancelled', 'finalized → cancelled'],
        [can, 'draft', 'cancelled → draft'],
        [can, 'finalized', 'cancelled → finalized'],
        [draft, 'draft', 'draft → draft'],
      ];
      for (const [id, to, why] of cases) {
        refusedWith(
          await attempt(c, () => c.query(`UPDATE stocktakes SET status = $2 WHERE id = $1`, [id, to])),
          'P0001',
          'inventory.stocktake_state_invalid',
          why,
        );
      }
      refusedWith(
        await attempt(c, () => c.query(`UPDATE stocktakes SET status = 'cancelled', warehouse_id = $2 WHERE id = $1`, [draft, A.w2])),
        'P0001',
        'inventory.stocktake_state_invalid',
        'closing may not move the warehouse',
      );
      for (const id of [fin, can, draft]) {
        refusedWith(await attempt(c, () => c.query(`DELETE FROM stocktakes WHERE id = $1`, [id])), 'P0001', 'inventory.source_document_immutable', 'delete');
      }
      // A raw close to `finalized` that applies nothing: the header guard admits the transition, and the deferred
      // stocktakes_finalized_complete refuses it at COMMIT because the counted variance carries no movement.
      await c.query('SAVEPOINT raw_close');
      expectAccepted(
        await attempt(c, () =>
          c.query(
            `UPDATE stocktakes SET status = 'finalized', finalize_intent_sha256 = intent_sha256, occurred_on = current_date, total_value_base_minor = 0,
                    finalized_at = now(), closed_by = opened_by WHERE id = $1`,
            [draft],
          ),
        ),
        'the raw close itself',
      );
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete', 'a finalized variance with no movement');
      await c.query('ROLLBACK TO SAVEPOINT raw_close');
      // The ALLOW twin: a raw draft → cancelled with its closing fields (cancel applies nothing, so nothing is owed).
      expectAccepted(
        await attempt(c, () =>
          c.query(
            `UPDATE stocktakes SET status = 'cancelled', finalize_intent_sha256 = intent_sha256, cancelled_at = now(), closed_by = opened_by WHERE id = $1`,
            [draft],
          ),
        ),
        'draft → cancelled',
      );
      expectAccepted(await atCommit(c));
    });
  });

  it('the lines of a finalized or cancelled stocktake refuse updates and deletes; a draft line is editable (only its count)', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const fin = await openAndCount(A, A.w1, [{ variantId: v, counted: '4' }]);
      await runFinancial(c, A, await finalizeCommand(c, A, fin, A.w1));
      const can = await openAndCount(A, A.w1, [{ variantId: v, counted: '3' }]);
      await runCommand(c, A, cancelCommand(can, A.w1));
      for (const id of [fin, can]) {
        refusedWith(
          await attempt(c, () => c.query(`UPDATE stocktake_lines SET counted_qty = 0 WHERE stocktake_id = $1`, [id])),
          'P0001',
          'inventory.source_line_frozen',
        );
        refusedWith(await attempt(c, () => c.query(`DELETE FROM stocktake_lines WHERE stocktake_id = $1`, [id])), 'P0001', 'inventory.source_line_frozen');
      }
      const draft = await openAndCount(A, A.w1, [{ variantId: v, counted: '2' }]);
      refusedWith(
        await attempt(c, () => c.query(`UPDATE stocktake_lines SET variant_id = $2 WHERE stocktake_id = $1`, [draft, A.piece2.variantId])),
        'P0001',
        'inventory.source_line_frozen',
        'identity',
      );
      expectAccepted(await attempt(c, () => c.query(`UPDATE stocktake_lines SET counted_qty = 1 WHERE stocktake_id = $1`, [draft])), 'a draft count');
    });
  });
});

describe('T-07.4..13 finalize valuation', () => {
  it('finalizing twice applies once: one movement per line, the second answer is the stored one, replayed', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '3' }]);
      const f = await finalizeCommand(c, A, id, A.w1);
      const first = await runFinancial(c, A, f);
      const before = await counts(c, A.businessId);
      const second = await runFinancial(c, A, f);
      expect(second.entry).toBeNull();
      expect(second.rows.map((r) => ({ ...r, replayed: false }))).toEqual(first.rows);
      expect(second.rows.map((r) => r.replayed)).toEqual([true]);
      expect(delta(before, await counts(c, A.businessId))).toEqual({ inventory_assertion_uses: 1 });
      expect(await onHand(c, A.businessId, { warehouseId: A.w1, variantId: v })).toBe('3.0000');
      expectAccepted(await atCommit(c));
    });
  });

  it('a positive variance on a never-valued key: unit_cost_required; with a cost it is applied at that cost and audited', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece2.variantId;
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '4' }]);
      // The routine is reached directly (the service refuses this before minting) with a zero expectation.
      const noCost = {
        kind: 'stocktake_finalize' as const,
        stocktakeId: id,
        warehouseId: A.w1,
        outcome: 'finalized' as const,
        occurredOn: day,
        lines: [{ variantId: v, variance: '4.0000', unitCost: null, expected: 0n }],
      };
      refusedWith(await tryCommand(c, A, noCost, { raw: true }), 'P0001', 'inventory.unit_cost_required');
      const withCost = await finalizeCommand(c, A, id, A.w1, { costs: { [v]: '12.5' } });
      expect(must(withCost.lines[0]).expected).toBe(50n);
      const r = await runFinancial(c, A, withCost);
      expect(must(r.rows[0]).value).toBe('50');
      const audit = must(
        (
          await c.query<{ ids: string[] }>(
            `SELECT metadata->'explicitCostVariantIds' AS ids FROM audit_events WHERE entity_id = $1 AND action = 'inventory.stocktake_finalized'`,
            [id],
          )
        ).rows[0],
      );
      expect(audit.ids).toEqual([v]);
      expectAccepted(await atCommit(c));
    });
  });

  it('an explicit cost on a key that has an average: unit_cost_not_applicable; a loss with a cost too', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '7' }]);
      const f = await finalizeCommand(c, A, id, A.w1);
      const line = must(f.lines[0]);
      refusedWith(await tryCommand(c, A, { ...f, lines: [{ ...line, unitCost: '10' }] }, { raw: true }), 'P0001', 'inventory.unit_cost_not_applicable', 'gain');
      await runCommand(c, A, countCommand(id, A.w1, [{ variantId: v, counted: '4' }]));
      const loss = await finalizeCommand(c, A, id, A.w1);
      refusedWith(
        await tryCommand(c, A, { ...loss, lines: [{ ...must(loss.lines[0]), unitCost: '10' }] }, { raw: true }),
        'P0001',
        'inventory.unit_cost_not_applicable',
        'loss',
      );
      expectAccepted(await tryCommand(c, A, loss));
    });
  });

  it('a positive variance is valued at the CURRENT average (L:664); a finalize prepared on the old average is refused valuation_changed', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      const key = { warehouseId: A.w1, variantId: v };
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '10', unitCost: '100' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '12' }]);
      const stale = await finalizeCommand(c, A, id, A.w1);
      expect(must(stale.lines[0]).expected).toBe(200n);
      // The average moves between capture and finalize: +10 @ 200 → avg 150.
      await runFinancial(c, A, await adjustCommand(c, A, A.w1, [{ variantId: v, qty: '10', unitCost: '200' }]));
      expect((await stockState(c, A.businessId, key)).avg).toBe(1500000000000n);
      refusedWith(await tryCommand(c, A, stale), 'P0001', 'inventory.valuation_changed');
      const fresh = await finalizeCommand(c, A, id, A.w1);
      expect(must(fresh.lines[0]).expected).toBe(300n);
      const r = await runFinancial(c, A, fresh);
      expect(must(r.rows[0]).value).toBe('300');
      expectAccepted(await atCommit(c));
    });
  });

  it('a negative variance larger than the on-hand left after intervening movements: insufficient_stock', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '0' }]);
      await runCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: v, qty: '3' }]));
      const f = {
        kind: 'stocktake_finalize' as const,
        stocktakeId: id,
        warehouseId: A.w1,
        outcome: 'finalized' as const,
        occurredOn: day,
        lines: [{ variantId: v, variance: '-5.0000', unitCost: null, expected: -50n }],
      };
      refusedWith(await tryCommand(c, A, f), 'P0001', 'inventory.insufficient_stock');
    });
  });

  it('zero-variance lines move nothing; an all-zero stocktake posts no entry and commits', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [
        { variantId: A.piece.variantId, qty: '5', unitCost: '10' },
        { variantId: A.piece2.variantId, qty: '2', unitCost: '10' },
      ]);
      const mixed = await openAndCount(A, A.w1, [
        { variantId: A.piece.variantId, counted: '5' },
        { variantId: A.piece2.variantId, counted: '1' },
      ]);
      const before = await counts(c, A.businessId);
      const r = await runFinancial(c, A, await finalizeCommand(c, A, mixed, A.w1));
      const byVariant = Object.fromEntries(r.rows.map((x) => [must(x.variant_id), x.value]));
      expect(byVariant).toEqual({ [A.piece.variantId]: null, [A.piece2.variantId]: '-10' });
      expect(delta(before, await counts(c, A.businessId))).toMatchObject({ stock_movements: 1, stock_source_bridge_stocktake: 1, journal_entries: 1 });

      const zero = await openAndCount(A, A.w1, [{ variantId: A.piece.variantId, counted: '5' }]);
      const before2 = await counts(c, A.businessId);
      const z = await runFinancial(c, A, await finalizeCommand(c, A, zero, A.w1));
      expect(z.command).toBeNull();
      expect(z.rows.map((x) => [x.status, x.total, x.value])).toEqual([['finalized', '0', null]]);
      expect(delta(before2, await counts(c, A.businessId))).toEqual({ audit_events: 1, outbox_events: 1, inventory_assertion_uses: 1 });
      expectAccepted(await atCommit(c));
    });
  });

  it('a count recorded after the finalization was prepared: stocktake_changed; re-prepared it is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const id = await openAndCount(A, A.w1, [{ variantId: v, counted: '4' }]);
      const prepared = await finalizeCommand(c, A, id, A.w1);
      await runCommand(c, A, countCommand(id, A.w1, [{ variantId: v, counted: '3' }]));
      refusedWith(await tryCommand(c, A, prepared), 'P0001', 'inventory.stocktake_changed', 'variance changed');
      await runCommand(c, A, countCommand(id, A.w1, [{ variantId: A.piece2.variantId, counted: '0' }]));
      refusedWith(
        await tryCommand(c, A, await finalizeCommand(c, A, id, A.w1).then((f) => ({ ...f, lines: f.lines.slice(0, 1) })), { raw: true }),
        'P0001',
        'inventory.stocktake_changed',
        'a line left out',
      );
      expectAccepted(await tryCommand(c, A, await finalizeCommand(c, A, id, A.w1)));
    });
  });

  it('an empty draft cannot be finalized (stocktake_empty); cancel moves nothing, posts nothing, and blocks a later finalize', async () => {
    await inTx(async () => {
      const A = world.A;
      const v = A.piece.variantId;
      await stockUp(c, A, A.w1, [{ variantId: v, qty: '5', unitCost: '10' }]);
      const empty = await openAndCount(A, A.w1, []);
      refusedWith(
        await tryCommand(
          c,
          A,
          { kind: 'stocktake_finalize', stocktakeId: empty, warehouseId: A.w1, outcome: 'finalized', occurredOn: day, lines: [] },
          { raw: true },
        ),
        'P0001',
        'inventory.stocktake_empty',
      );
      await runCommand(c, A, countCommand(empty, A.w1, [{ variantId: v, counted: '1' }]));
      refusedWith(
        await tryCommand(c, A, { ...cancelCommand(empty, A.w1), occurredOn: day }, { raw: true }),
        'P0001',
        'inventory.payload_invalid',
        'a cancel carries no date',
      );
      const before = await counts(c, A.businessId);
      const r = await runCommand(c, A, cancelCommand(empty, A.w1));
      expect(r).toEqual([{ stocktake_id: empty, replayed: false, status: 'cancelled', total: null, line_id: null, variant_id: null, value: null }]);
      expect(delta(before, await counts(c, A.businessId))).toEqual({ audit_events: 1, outbox_events: 1, inventory_assertion_uses: 1 });
      expect(await runCommand(c, A, cancelCommand(empty, A.w1))).toEqual([{ ...must(r[0]), replayed: true }]);
      expectAccepted(await atCommit(c));
    });
  });
});

describe('R-16 a stocktake stores the traces of its open and of its close (A-10(f))', () => {
  const traces = async (id: string): Promise<{ open: string; close: string | null }> =>
    must(
      (
        await c.query<{ open: string; close: string | null }>(
          `SELECT business_transaction_id::text AS open, closed_business_transaction_id::text AS close FROM stocktakes WHERE id = $1`,
          [id],
        )
      ).rows[0],
    );

  it('open and cancel record their own traces; replays of either leave them untouched', async () => {
    await inTx(async () => {
      const A = world.A;
      const [t1, t2, t3, t4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const open = stocktakeOpenCommand(A.w1);
      expect(await runCommand(c, A, open, { trace: t1 })).toEqual([{ stocktake_id: open.stocktakeId, replayed: false }]);
      expect(await traces(open.stocktakeId)).toEqual({ open: t1, close: null });
      expect(await runCommand(c, A, open, { trace: t2 })).toEqual([{ stocktake_id: open.stocktakeId, replayed: true }]);
      expect(await traces(open.stocktakeId), 'the replayed open').toEqual({ open: t1, close: null });
      await runCommand(c, A, cancelCommand(open.stocktakeId, A.w1), { trace: t3 });
      expect(await traces(open.stocktakeId)).toEqual({ open: t1, close: t3 });
      const again = await runCommand(c, A, cancelCommand(open.stocktakeId, A.w1), { trace: t4 });
      expect(must(again[0]).replayed).toBe(true);
      expect(await traces(open.stocktakeId), 'the replayed cancel').toEqual({ open: t1, close: t3 });
      expectAccepted(await atCommit(c));
    });
  });

  it('finalize records its trace; open and close without the trace carrier are trace_missing', async () => {
    await inTx(async () => {
      const A = world.A;
      refusedWith(await tryCommand(c, A, stocktakeOpenCommand(A.w1), { trace: '' }), 'P0001', 'inventory.trace_missing', 'open');
      const id = await openAndCount(A, A.w1, [{ variantId: A.piece2.variantId, counted: '0' }]);
      const fin = await finalizeCommand(c, A, id, A.w1);
      refusedWith(await tryCommand(c, A, fin, { trace: '' }), 'P0001', 'inventory.trace_missing', 'finalize');
      refusedWith(await tryCommand(c, A, cancelCommand(id, A.w1), { trace: '' }), 'P0001', 'inventory.trace_missing', 'cancel');
      const t = randomUUID();
      await runCommand(c, A, fin, { trace: t });
      expect(await traces(id)).toEqual({ open: expect.any(String) as string, close: t });
      expectAccepted(await atCommit(c));
    });
  });

  it('closing may not rewrite the open trace, and a draft holds no closing trace', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await openAndCount(A, A.w1, []);
      refusedWith(
        await attempt(c, () =>
          c.query(
            `UPDATE stocktakes SET status = 'cancelled', finalize_intent_sha256 = intent_sha256, cancelled_at = now(), closed_by = opened_by,
                    business_transaction_id = gen_random_uuid() WHERE id = $1`,
            [id],
          ),
        ),
        'P0001',
        'inventory.stocktake_state_invalid',
      );
      const forged = await attempt(c, async () => {
        // Past the header guard (an origin-only trigger): the CHECK is the shape itself.
        await c.query(`SET LOCAL session_replication_role = replica`);
        return c.query(`UPDATE stocktakes SET closed_business_transaction_id = gen_random_uuid() WHERE id = $1`, [id]);
      });
      expectConstraint(forged, '23514', 'stocktakes_state_ck', 'a draft with a closing trace');
    });
  });
});
