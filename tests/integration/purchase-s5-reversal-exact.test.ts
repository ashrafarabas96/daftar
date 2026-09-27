/**
 * P3-S5 T-09 — THE REVERSAL REMOVES EXACTLY WHAT THE RECEIPT ADDED
 * (docs/PHASE_3_S5_CONTRACT.md A-07, A-08, R-B1a, R-B2a, R-51, §6 T-09; MP-6,
 * L:757).
 *
 * After a reversal:
 *   - each line's `purchase_reversal` movement value is exactly −its
 *     `purchase` movement value `s_i` (R-B1a), at the ORIGINAL receipt cost —
 *     also after an intervening receipt at another cost on the same key, where
 *     the key average is not `s_i / q_i`; the remaining average is re-derived
 *     from what is left;
 *   - the key's valuation drops by exactly `Σ s_i = B`, GL Inventory by
 *     exactly B, and GL Inventory = Σ movement values = the stock cache;
 *   - the entry is the Phase 2 reversal of the purchase entry (R-B2a):
 *     `accounting_reversals` names it, every line mirrored, and the
 *     purchase's ledger AP is 0 in txn and base;
 *   - the purchase reads `reversed` (TL-2) while `status` stays `received`;
 *   - one audit `purchase.reversed` and one `purchase.reversed.v1` event
 *     carry the ORIGINAL entry id (R-51), never amounts.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must, ownerClient, seedS3World, stockState, type S3World } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import {
  entryLinesOf,
  foreignRate,
  glOf,
  movementsOfSource,
  prepareReversal,
  purchaseLedgerAp,
  purchaseState,
  receivedPurchase,
  reversalOf,
  runReversal,
  s5Counts,
  threeWay,
} from '../helpers/purchase-returns';
import { s4Delta } from '../helpers/purchase-commands';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5rev');
  await foreignRate(world.A, 'USD', '3.6725', '2026-01-01T00:00:00Z');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

describe('T-09 the reversal at the original receipt cost (R-B1a)', () => {
  it('after a restock at another cost, each line removes exactly s_i; valuation, GL and AP drop by exactly B; the three agree', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const key1 = { warehouseId: A.w1, variantId: A.piece.variantId };
      const key2 = { warehouseId: A.w1, variantId: A.dec2.variantId };
      // Mixed-cost keys before the purchase: 4 at 250 and 1.5 at 40.
      await stockUp(c, A, A.w1, [
        { variantId: A.piece.variantId, qty: '4', unitCost: '250' },
        { variantId: A.dec2.variantId, qty: '1.5', unitCost: '40' },
      ]);
      const p = await receivedPurchase(c, A, [
        { variantId: A.piece.variantId, qty: '5', unitPriceMinor: '100' },
        { variantId: A.dec2.variantId, qty: '2.5', unitPriceMinor: '60' },
      ]);
      // In purchase line order (the stock_seq order is the lock order of the keys).
      const inLineOrder = <T extends { source_line_id: string }>(rows: readonly T[]): T[] =>
        p.lines.map((l) =>
          must(
            rows.find((r) => r.source_line_id === l.lineId),
            `the movement of line ${l.lineId}`,
          ),
        );
      const purchaseMoves = inLineOrder(await movementsOfSource(c, A.businessId, 'purchase', p.purchaseId));
      expect(purchaseMoves.map((m) => m.value)).toEqual(['500', '150']);
      // The intervening receipt at another cost on both keys: the averages are no longer s_i / q_i.
      await receivedPurchase(c, A, [
        { variantId: A.piece.variantId, qty: '1', unitPriceMinor: '300' },
        { variantId: A.dec2.variantId, qty: '1', unitPriceMinor: '110' },
      ]);
      const before = { k1: await stockState(c, A.businessId, key1), k2: await stockState(c, A.businessId, key2) };
      expect([before.k1.onHand, before.k1.valuation, before.k2.onHand, before.k2.valuation]).toEqual([100_000n, 1800n, 50_000n, 320n]);
      const inventoryBefore = await glOf(c, A.businessId, 'inventory');
      const B = BigInt((await purchaseState(c, A.businessId, p.purchaseId)).total_base_minor);
      expect(B).toBe(650n);
      const counts = await s5Counts(c, A.businessId);

      const prep = await prepareReversal(c, A, p.purchaseId);
      const run = await runReversal(c, A, prep);
      const entry = must(run.entry, 'the Phase 2 reversal');
      expect(entry.created).toBe(true);

      // Each line removes exactly −s_i, not the average.
      const reversal = inLineOrder(await movementsOfSource(c, A.businessId, 'purchase_reversal', p.purchaseId));
      expect(
        reversal.map((m) => ({ line: m.source_line_id, kind: m.kind, qty: m.qty, value: m.value })),
        'each reversal movement is the exact negation of its purchase movement',
      ).toEqual(purchaseMoves.map((m) => ({ line: m.source_line_id, kind: 'purchase_reversal', qty: `-${m.qty}`, value: `-${m.value}` })));
      expect(run.rows.map((r) => r.value_delta_base_minor)).toEqual(['-500', '-150']);
      const after = { k1: await stockState(c, A.businessId, key1), k2: await stockState(c, A.businessId, key2) };
      expect(before.k1.valuation - after.k1.valuation, 'key 1 drops by s_1').toBe(500n);
      expect(before.k2.valuation - after.k2.valuation, 'key 2 drops by s_2').toBe(150n);
      // The remaining averages are re-derived from what is left: 5 worth 1300, 1.5 + 1 = 2.5 worth 170.
      expect([after.k1.onHand, after.k1.valuation, after.k1.avg]).toEqual([50_000n, 1300n, 2_600_000_000_000n]);
      expect([after.k2.onHand, after.k2.valuation, after.k2.avg]).toEqual([25_000n, 170n, 680_000_000_000n]);
      expect(inventoryBefore - (await glOf(c, A.businessId, 'inventory')), 'GL Inventory drops by exactly B').toBe(B);
      const three = await threeWay(c, A.businessId);
      expect(three.movements, 'Σ movement values = GL Inventory').toBe(three.gl);
      expect(three.cache, 'the stock cache = GL Inventory').toBe(three.gl);
      expect(await purchaseLedgerAp(c, A.businessId, p.purchaseId), 'the purchase owes nothing after its reversal').toEqual({ base: 0n, txn: 0n });
      expect(
        s4Delta(counts, await s5Counts(c, A.businessId)),
        'exactly one reversal, its lines, movements, bridge rows, the Phase 2 entry, and one audit row and event each from the routine and the reversal',
      ).toEqual({
        purchase_reversals: 1,
        purchase_reversal_lines: 2,
        stock_source_bridge_purchase_reversal: 2,
        stock_movements: 2,
        stock_source_bindings: 2,
        stock_levels_state: 'changed',
        journal_entries: 1,
        journal_lines: must((await entryLinesOf(c, A.businessId, p.entryId)).length),
        accounting_source_bindings: 1,
        accounting_reversals: 1,
        audit_events: 2,
        outbox_events: 2,
        inventory_assertion_uses: 1,
      });
    });
  });
});

describe('T-09 the Phase 2 reversal of the purchase entry (R-B2a)', () => {
  it('accounting_reversals names the purchase entry; every line is mirrored; the purchase reads reversed, status stays received', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '3', unitPriceMinor: '1000' }], {
        currency: 'USD',
        documentDate: '2026-02-01',
      });
      const prep = await prepareReversal(c, A, p.purchaseId);
      await runReversal(c, A, prep);
      const rev = must(await reversalOf(c, A.businessId, p.entryId), 'the reversal of the purchase entry');
      expect(rev.entryDate).toBe(prep.cmd.reversalDate);
      const original = await entryLinesOf(c, A.businessId, p.entryId);
      expect(
        rev.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
        'the reversal entry mirrors the purchase entry line for line (txn, FX and dimensions kept)',
      ).toEqual(original);
      expect(await purchaseLedgerAp(c, A.businessId, p.purchaseId), 'AP by exactly T (txn) and B (base)').toEqual({ base: 0n, txn: 0n });
      const state = must(
        (
          await c.query<{ status: string; reversed: boolean; header: string | null }>(
            `SELECT p.status,
                    EXISTS (SELECT 1 FROM accounting_source_bindings rb
                              JOIN accounting_reversals ar ON ar.business_id = rb.business_id AND ar.original_entry_id = rb.journal_entry_id
                             WHERE rb.business_id = p.business_id AND rb.source_type = 'purchase' AND rb.source_id = p.id) AS reversed,
                    (SELECT r.original_entry_id::text FROM purchase_reversals r WHERE r.business_id = p.business_id AND r.id = p.id) AS header
               FROM purchases p WHERE p.business_id = $1 AND p.id = $2`,
            [A.businessId, p.purchaseId],
          )
        ).rows[0],
      );
      expect(state, 'derived reversed (TL-2), stored status kept, the header names the original entry').toEqual({
        status: 'received',
        reversed: true,
        header: p.entryId,
      });
      expect((await purchaseState(c, A.businessId, p.purchaseId)).outstanding, 'R-52: nothing is outstanding on a reversed purchase').toBe('0');
    });
  });

  it('R-51: the audit row and the event carry the ORIGINAL entry id and the trace, never amounts', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '100' }]);
      const prep = await prepareReversal(c, A, p.purchaseId);
      await runReversal(c, A, prep);
      const audit = await c.query<{ metadata: Record<string, unknown>; entity: string; entity_id: string }>(
        `SELECT metadata, entity, entity_id FROM audit_events WHERE business_id = $1 AND action = 'purchase.reversed'`,
        [A.businessId],
      );
      expect(audit.rows).toHaveLength(1);
      const a = must(audit.rows[0]);
      expect({ entity: a.entity, id: a.entity_id }).toEqual({ entity: 'purchase', id: p.purchaseId });
      expect(a.metadata).toMatchObject({ originalEntryId: p.entryId, warehouseId: p.warehouseId, lineCount: 1, business_transaction_id: prep.trace });
      const events = await c.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM outbox_events WHERE business_id = $1 AND type = 'purchase.reversed.v1'`,
        [A.businessId],
      );
      expect(events.rows.map((e) => e.payload)).toEqual([
        { businessId: A.businessId, purchaseId: p.purchaseId, originalEntryId: p.entryId, businessTransactionId: prep.trace },
      ]);
      const text = JSON.stringify([a.metadata, events.rows]);
      expect(text, 'no amount in the audit row or the event').not.toMatch(/"(total|value|amount)[A-Za-z]*"/);
    });
  });

  it('a whole-key receipt reverses to an empty key: on hand 0, valuation 0, the last average kept (the S2 depletion rule)', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '3', unitPriceMinor: '333' }]);
      await runReversal(c, A, await prepareReversal(c, A, p.purchaseId));
      const s = await stockState(c, A.businessId, { warehouseId: A.w1, variantId: A.piece2.variantId });
      expect([s.onHand, s.valuation, s.avg]).toEqual([0n, 0n, 3_330_000_000_000n]);
      const three = await threeWay(c, A.businessId);
      expect([three.movements, three.cache]).toEqual([three.gl, three.gl]);
    });
  });
});
