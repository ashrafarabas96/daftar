/**
 * P3-S3 T-06 — ADJUSTMENT AND DAMAGE, AND THEIR JOURNALS
 * (docs/PHASE_3_S3_CONTRACT.md A-05, A-07, A-12, A-14(a)(b), §6 T-06).
 *
 * Every document here is written by the REAL routine (`inventory_adjust_stock`
 * / `inventory_record_damage`) as `daftar_app` under a real `invctl/1`
 * assertion, and every entry by the one generic primitive
 * (`accounting_post_entry`) under a real `post` assertion minted by
 * `mintDomainPostingAssertion` over the app's own posting builder — in ONE
 * owner transaction that is always rolled back. `atCommit` fires the deferred
 * completeness triggers without committing.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  adjustCommand,
  atCommit,
  cacheValue,
  counts,
  damageCommand,
  delta,
  entryOf,
  expectAccepted,
  glInventory,
  movementValue,
  must,
  onHand,
  ownerClient,
  refusedWith,
  roundingLines,
  scratch,
  seedS3World,
  settle,
  stockState,
  today,
  tryCommand,
  type S3World,
} from '../helpers/inventory-commands';
import { adjustmentEntry, homeBranch, mintEntry, postEntryInTx, runFinancial, stockUp } from '../helpers/inventory-posting';

let world: S3World;
let day: string;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'adj');
  day = await today();
});

afterAll(async () => {
  await resetData();
});

/** Each case in a fresh owner transaction, always rolled back. */
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

describe('T-06.1/2/3 AL08-ADJ-POS and AL08-ADJ-NEG through the real commands and the real primitive', () => {
  it('a gain posts Dr 1200 / Cr 5000 for exactly the stored value; a loss the reverse; GL Inventory = Σ movements = Σ cache; no 6100/6200 line', async () => {
    await inTx(async () => {
      const A = world.A;
      const key = { warehouseId: A.w1, variantId: A.piece.variantId };
      // Step 1 of the vector (a purchase of 10 @ 100) is seeded as an explicit-cost gain (H-4): the same valuation.
      const seed = await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitCost: '100' }]);
      expect(must(seed.rows[0]).value).toBe('1000');

      // AL08-ADJ-POS: +3 @ 110.5 → 332 (HALF_EVEN of 331.5), avg 102.4615384615.
      const pos = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '3', unitCost: '110.5' }]);
      expect(must(pos.lines[0]).expected).toBe(332n);
      const p = await runFinancial(c, A, pos);
      expect(p.rows.map((r) => [r.total, r.value, r.replayed])).toEqual([['332', '332', false]]);
      const posEntry = must(await entryOf(c, A.businessId, 'inventory_adjustment', pos.adjustmentId));
      expect(posEntry.entry_date).toBe(day);
      expect(posEntry.lines).toEqual([
        { system_key: 'inventory', code: '1200', debit: '332', credit: '0', warehouse_id: A.w1, branch_id: A.branchX },
        { system_key: 'cogs', code: '5000', debit: '0', credit: '332', warehouse_id: A.w1, branch_id: A.branchX },
      ]);
      let s = await stockState(c, A.businessId, key);
      expect([s.onHand, s.valuation, s.avg]).toEqual([130000n, 1332n, 1024615384615n]);

      // AL08-ADJ-NEG: −4 at the average → −410 (HALF_EVEN of 409.846…), avg 102.4444444444.
      const neg = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-4' }]);
      expect(must(neg.lines[0]).expected).toBe(-410n);
      await runFinancial(c, A, neg);
      const negEntry = must(await entryOf(c, A.businessId, 'inventory_adjustment', neg.adjustmentId));
      expect(negEntry.lines).toEqual([
        { system_key: 'cogs', code: '5000', debit: '410', credit: '0', warehouse_id: A.w1, branch_id: A.branchX },
        { system_key: 'inventory', code: '1200', debit: '0', credit: '410', warehouse_id: A.w1, branch_id: A.branchX },
      ]);
      s = await stockState(c, A.businessId, key);
      expect([s.onHand, s.valuation, s.avg]).toEqual([90000n, 922n, 1024444444444n]);

      // Every deferred check — both completeness triggers and the binding FKs — accepts the composition.
      expectAccepted(await atCommit(c), 'the three documents and their entries commit');
      // P:161/P:163 re-proved with the real source: GL Inventory = Σ movement values = Σ cache valuation.
      expect(await glInventory(c, A.businessId)).toBe(922n);
      expect(await movementValue(c, A.businessId)).toBe(922n);
      expect(await cacheValue(c, A.businessId)).toBe(922n);
      expect(await roundingLines(c, A.businessId)).toBe(0);
    });
  });

  it('a multi-line adjustment posts ONE net entry for the document total', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [
        { variantId: A.piece.variantId, qty: '10', unitCost: '100' },
        { variantId: A.piece2.variantId, qty: '5', unitCost: '40' },
      ]);
      const cmd = await adjustCommand(c, A, A.w1, [
        { variantId: A.piece.variantId, qty: '-2' },
        { variantId: A.piece2.variantId, qty: '1', unitCost: '70' },
      ]);
      const r = await runFinancial(c, A, cmd);
      expect(r.rows.map((x) => x.value)).toEqual(['-200', '70']);
      expect(must(r.rows[0]).total).toBe('-130');
      const e = must(await entryOf(c, A.businessId, 'inventory_adjustment', cmd.adjustmentId));
      expect(e.lines.map((l) => [l.system_key, l.debit, l.credit])).toEqual([
        ['cogs', '130', '0'],
        ['inventory', '0', '130'],
      ]);
      expectAccepted(await atCommit(c));
      expect(await glInventory(c, A.businessId)).toBe(await movementValue(c, A.businessId));
    });
  });
});

describe('T-06.4 a zero-value movement (vector C) posts no entry', () => {
  it('+1 @ 0.4 minor is value 0: no entry, no accounting binding, and the document still commits', async () => {
    await inTx(async () => {
      const A = world.A;
      const before = await counts(c, A.businessId);
      const cmd = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '0.4' }]);
      const r = await runFinancial(c, A, cmd);
      expect(r.command).toBeNull();
      expect(r.entry).toBeNull();
      expect(must(r.rows[0]).total).toBe('0');
      expect(delta(before, await counts(c, A.businessId))).toEqual({
        stock_movements: 1,
        stock_source_bindings: 1,
        stock_levels: 1,
        stock_source_bridge_inventory_adjustment: 1,
        inventory_adjustments: 1,
        inventory_adjustment_lines: 1,
        audit_events: 1,
        outbox_events: 1,
        inventory_assertion_uses: 1,
      });
      const header = must(
        (await c.query<{ b: string | null }>(`SELECT binding_source_id::text AS b FROM inventory_adjustments WHERE id = $1`, [cmd.adjustmentId])).rows[0],
      );
      expect(header.b).toBeNull();
      expectAccepted(await atCommit(c), 'a zero-value document owes no entry');
    });
  });
});

describe('T-06.5..8 damage and refusals of the adjustment routine', () => {
  it('damage writes a negative `damage` movement valued at the average, and posts Dr COGS / Cr Inventory', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '25' }]);
      const d = await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '3' }]);
      const r = await runFinancial(c, A, d);
      expect(must(r.rows[0]).value).toBe('-75');
      const kinds = await c.query<{ k: string; q: string; v: string; reason: string | null }>(
        `SELECT movement_kind AS k, qty_delta::text AS q, value_delta_base_minor::text AS v, reason FROM stock_movements WHERE business_id = $1 AND source_id = $2`,
        [A.businessId, d.adjustmentId],
      );
      expect(kinds.rows).toEqual([{ k: 'damage', q: '-3.0000', v: '-75', reason: 'water damage' }]);
      const header = must((await c.query<{ kind: string }>(`SELECT kind FROM inventory_adjustments WHERE id = $1`, [d.adjustmentId])).rows[0]);
      expect(header.kind).toBe('damage');
      const e = must(await entryOf(c, A.businessId, 'inventory_adjustment', d.adjustmentId));
      expect(e.lines.map((l) => [l.system_key, l.debit, l.credit])).toEqual([
        ['cogs', '75', '0'],
        ['inventory', '0', '75'],
      ]);
      expectAccepted(await atCommit(c));
    });
  });

  it('refuses a damage without a reason (reason_required), and accepts the same damage with one', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '25' }]);
      for (const reason of ['', '   ', 'x'.repeat(501)]) {
        const d = await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1' }], { reason });
        refusedWith(await tryCommand(c, A, d, { raw: true }), 'P0001', 'inventory.reason_required', `reason ${JSON.stringify(reason.slice(0, 5))}`);
      }
      const adj = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }], { reason: ' ' });
      refusedWith(await tryCommand(c, A, adj, { raw: true }), 'P0001', 'inventory.reason_required', 'an adjustment too');
      const ok = await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1' }], { reason: 'x'.repeat(500) });
      expectAccepted(await tryCommand(c, A, ok));
    });
  });

  it('refuses a duplicate variant, a gain without cost, a loss with a cost, a zero line; the honest twins are accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '25' }]);
      const v = A.piece.variantId;
      const base = await adjustCommand(c, A, A.w1, [{ variantId: v, qty: '-1' }]);
      const line = must(base.lines[0]);
      const dup = { ...base, lines: [line, line] };
      refusedWith(await tryCommand(c, A, dup, { raw: true }), 'P0001', 'inventory.duplicate_line');
      const dmg = await damageCommand(c, A, A.w1, [{ variantId: v, qty: '1' }]);
      refusedWith(
        await tryCommand(c, A, { ...dmg, lines: [must(dmg.lines[0]), must(dmg.lines[0])] }, { raw: true }),
        'P0001',
        'inventory.duplicate_line',
        'damage',
      );
      refusedWith(
        await tryCommand(c, A, { ...base, lines: [{ ...line, qty: '1', unitCost: null, expected: 25n }] }, { raw: true }),
        'P0001',
        'inventory.unit_cost_required',
      );
      refusedWith(await tryCommand(c, A, { ...base, lines: [{ ...line, unitCost: '25' }] }, { raw: true }), 'P0001', 'inventory.unit_cost_not_applicable');
      refusedWith(await tryCommand(c, A, { ...base, lines: [{ ...line, qty: '0', expected: 0n }] }, { raw: true }), 'P0001', 'inventory.quantity_sign_invalid');
      refusedWith(
        await tryCommand(c, A, { ...dmg, lines: [{ ...must(dmg.lines[0]), qty: '-1' }] }, { raw: true }),
        'P0001',
        'inventory.quantity_sign_invalid',
        'damage of a negative qty',
      );
      refusedWith(await tryCommand(c, A, { ...base, lines: [] }, { raw: true }), 'P0001', 'inventory.lines_required');
      refusedWith(
        await tryCommand(c, A, { ...base, lines: [{ ...line, qty: '-0.5' }] }, { raw: true }),
        'P0001',
        'inventory.quantity_precision_invalid',
        'piece/0 takes no fraction',
      );
      expectAccepted(await tryCommand(c, A, base), 'the honest loss');
    });
  });

  it('over-issue is refused insufficient_stock with no row written; issuing exactly the on-hand is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '25' }]);
      const before = await counts(c, A.businessId);
      // The service refuses over-issue before minting (its simulation); the routine is reached directly here.
      const base = { adjustmentId: randomUUID(), warehouseId: A.w1, occurredOn: day, reason: 'over-issue' };
      const over = { kind: 'adjust' as const, ...base, lines: [{ variantId: A.piece.variantId, qty: '-5', unitCost: null, expected: -125n }] };
      refusedWith(await tryCommand(c, A, over), 'P0001', 'inventory.insufficient_stock');
      const overDamage = { kind: 'damage' as const, ...base, lines: [{ variantId: A.piece.variantId, qty: '5', expected: -125n }] };
      refusedWith(await tryCommand(c, A, overDamage), 'P0001', 'inventory.insufficient_stock', 'damage');
      expect(delta(before, await counts(c, A.businessId))).toEqual({});
      const exact = await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4' }]);
      await runFinancial(c, A, exact);
      expect(await onHand(c, A.businessId, { warehouseId: A.w1, variantId: A.piece.variantId })).toBe('0.0000');
      expectAccepted(await atCommit(c));
    });
  });

  it('a stale bound value is refused valuation_changed (A-07); the value computed now is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '3', unitCost: '10' }]);
      const loss = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      const line = must(loss.lines[0]);
      refusedWith(await tryCommand(c, A, { ...loss, lines: [{ ...line, expected: line.expected - 1n }] }), 'P0001', 'inventory.valuation_changed');
      expectAccepted(await tryCommand(c, A, loss));
    });
  });
});

describe('T-06.9 the journal cannot be forged or mismatched (A-14(a))', () => {
  it('an inventory_adjustment entry with no document is refused at COMMIT: inventory_detail_missing', async () => {
    await inTx(async () => {
      const A = world.A;
      const forged = must(adjustmentEntry(A, { sourceId: randomUUID(), occurredOn: day, warehouseId: A.w1, branchId: A.branchX, netValueMinor: 500n }));
      // The primitive itself accepts the call — the assertion is genuine.
      await postEntryInTx(c, forged, A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_detail_missing');
    });
  });

  it('negative control: with the completeness trigger dropped, the same forged entry would commit', async () => {
    await inTx(async () => {
      const A = world.A;
      await scratch(c, async () => {
        await c.query('DROP TRIGGER journal_entries_inventory_adjustment_complete ON journal_entries');
        const forged = must(adjustmentEntry(A, { sourceId: randomUUID(), occurredOn: day, warehouseId: A.w1, branchId: A.branchX, netValueMinor: 500n }));
        await postEntryInTx(c, forged, A.userId);
        expectAccepted(await atCommit(c), 'the attack succeeds without the trigger');
      });
    });
  });

  it('an entry whose amount, date, dimensions or account differ from its document is refused: inventory_entry_mismatch', async () => {
    const A = world.A;
    const mutations: readonly { why: string; over: Partial<Parameters<typeof adjustmentEntry>[1]> }[] = [
      { why: 'amount +1', over: { netValueMinor: 333n } },
      { why: 'amount −1', over: { netValueMinor: 331n } },
      { why: 'sign flipped', over: { netValueMinor: -332n } },
      { why: 'another warehouse', over: { warehouseId: A.w2, branchId: A.branchY } },
      { why: 'the branch of another warehouse', over: { branchId: A.branchY } },
    ];
    for (const m of mutations) {
      await inTx(async () => {
        await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitCost: '100' }]);
        expectAccepted(await atCommit(c));
        const cmd = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '3', unitCost: '110.5' }]);
        const r = expectAccepted(await tryCommand(c, A, cmd));
        expect(must(r[0]).total).toBe('332');
        const honest = { sourceId: cmd.adjustmentId, occurredOn: day, warehouseId: A.w1, branchId: A.branchX, netValueMinor: 332n };
        await scratch(c, async () => {
          await postEntryInTx(c, must(adjustmentEntry(A, honest)), A.userId);
          expectAccepted(await atCommit(c), 'the honest entry');
        });
        await postEntryInTx(c, must(adjustmentEntry(A, { ...honest, ...m.over })), A.userId);
        refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', m.why);
      });
    }
  });

  it('an entry dated otherwise than its document is refused: inventory_entry_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitCost: '100' }]);
      const yesterday = must((await c.query<{ d: string }>(`SELECT to_char($1::date - 1, 'YYYY-MM-DD') AS d`, [day])).rows[0]).d;
      const cmd = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      expectAccepted(await tryCommand(c, A, cmd));
      const entry = must(
        adjustmentEntry(A, { sourceId: cmd.adjustmentId, occurredOn: yesterday, warehouseId: A.w1, branchId: A.branchX, netValueMinor: -100n }),
      );
      await postEntryInTx(c, entry, A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch');
    });
  });

  it('a document with a non-zero total and NO entry cannot commit (its deferred binding FK), and commits with it', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitCost: '100' }]);
      expectAccepted(await atCommit(c));
      const cmd = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      expectAccepted(await tryCommand(c, A, cmd));
      const missing = await atCommit(c);
      refusedWith(missing, '23503', null, 'no accounting binding for the document');
      await postEntryInTx(
        c,
        must(adjustmentEntry(A, { sourceId: cmd.adjustmentId, occurredOn: day, warehouseId: A.w1, branchId: A.branchX, netValueMinor: -100n })),
        A.userId,
      );
      expectAccepted(await atCommit(c));
    });
  });

  it('the entry must be posted under a genuine assertion: one minted for another amount is refused by the primitive', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitCost: '100' }]);
      const cmd = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      expectAccepted(await tryCommand(c, A, cmd));
      const doc = { sourceId: cmd.adjustmentId, occurredOn: day, warehouseId: A.w1, branchId: A.branchX };
      const honest = must(adjustmentEntry(A, { ...doc, netValueMinor: -100n }));
      const other = must(adjustmentEntry(A, { ...doc, netValueMinor: -101n }));
      const o = await settle(async () => {
        await c.query('SAVEPOINT forged');
        try {
          return await postEntryInTx(c, honest, A.userId, mintEntry(other, A.userId));
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT forged');
        }
      });
      refusedWith(o, 'P0001', 'accounting.assertion_payload_mismatch');
      await postEntryInTx(c, honest, A.userId);
      expectAccepted(await atCommit(c));
    });
  });
});

describe('T-06.2 dimensions come from the document warehouse', () => {
  it('an adjustment of W2 posts under W2 and its home branch Y', async () => {
    await inTx(async () => {
      const A = world.A;
      expect(await homeBranch(c, A.businessId, A.w2)).toBe(A.branchY);
      const cmd = await adjustCommand(c, A, A.w2, [{ variantId: A.dec2.variantId, qty: '2.5', unitCost: '40' }]);
      await runFinancial(c, A, cmd);
      const e = must(await entryOf(c, A.businessId, 'inventory_adjustment', cmd.adjustmentId));
      expect(e.lines.map((l) => [l.system_key, l.debit, l.credit, l.warehouse_id, l.branch_id])).toEqual([
        ['inventory', '100', '0', A.w2, A.branchY],
        ['cogs', '0', '100', A.w2, A.branchY],
      ]);
      expectAccepted(await atCommit(c));
    });
  });
});
