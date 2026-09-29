/**
 * P3-S5 T-10 — CONCURRENCY ON TWO REAL CONNECTIONS
 * (docs/PHASE_3_S5_CONTRACT.md A-08, A-09, R-48, R-49, §6 T-10; PM-13).
 *
 * Committed state, two sessions, the second provably waiting
 * (`pg_stat_activity`) before the first commits:
 *   - a return against a reversal of one purchase: exactly one wins — a
 *     reversal behind a return is refused `purchase_reversal.returned`, a
 *     return behind a reversal `supplier_return.purchase_reversed`;
 *   - two identical reversals: one commits, the other waits on the purchase
 *     key and answers the stored rows as a replay — one reversal, one Phase 2
 *     entry, one movement set;
 *   - a return against a concurrent S3 damage on its key: the return waits
 *     on the key, then is refused `inventory.valuation_changed` (the average
 *     it bound moved) with no partial state, and re-prepared it commits.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  attempt,
  damageCommand,
  expectAccepted,
  must,
  ownerClient,
  pidOf,
  refusedWith,
  seedS3World,
  stockState,
  waitUntilBlocked,
  type S3World,
} from '../helpers/inventory-commands';
import { runFinancial } from '../helpers/inventory-posting';
import { prepareReturn, prepareReversal, receivedPurchase, runReturn, runReversal, s5Counts, type ReceivedPurchase } from '../helpers/purchase-returns';
import { s4Delta } from '../helpers/purchase-commands';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5conc');
});

afterAll(async () => {
  await resetData();
});

async function committed<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const v = await fn(c);
    await c.query('COMMIT');
    return v;
  } finally {
    await c.end();
  }
}

/** Two open sessions; `fn` drives them; both always end. */
async function twoSessions(fn: (c1: Client, c2: Client, pid2: number) => Promise<void>): Promise<void> {
  const c1 = await ownerClient();
  const c2 = await ownerClient();
  try {
    const pid2 = await pidOf(c2);
    await c1.query('BEGIN');
    await c2.query('BEGIN');
    await fn(c1, c2, pid2);
  } finally {
    await c1.end();
    await c2.end();
  }
}

async function purchaseOf(variantId: string, warehouseId: string, qty = '4'): Promise<ReceivedPurchase> {
  return committed((c) => receivedPurchase(c, world.A, [{ variantId, qty, unitPriceMinor: '100' }], { warehouseId }));
}

async function stored(purchaseId: string): Promise<{ returns: number; reversals: number; entries: number }> {
  const A = world.A;
  return must(
    (
      await ownerPool().query<{ returns: number; reversals: number; entries: number }>(
        `SELECT (SELECT count(*)::int FROM supplier_returns WHERE business_id = $1 AND purchase_id = $2) AS returns,
                (SELECT count(*)::int FROM purchase_reversals WHERE business_id = $1 AND id = $2) AS reversals,
                (SELECT count(*)::int FROM accounting_reversals ar JOIN accounting_source_bindings b
                    ON b.business_id = ar.business_id AND b.journal_entry_id = ar.original_entry_id
                  WHERE ar.business_id = $1 AND b.source_type = 'purchase' AND b.source_id = $2) AS entries`,
        [A.businessId, purchaseId],
      )
    ).rows[0],
  );
}

describe('T-10 a return against a reversal of one purchase: exactly one wins', () => {
  it('the return first: the reversal waits on the purchase row, then purchase_reversal.returned', async () => {
    const A = world.A;
    const p = await purchaseOf(A.piece.variantId, A.w1);
    const ret = await prepareReturn(ownerPool(), A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
    const rev = await prepareReversal(ownerPool(), A, p.purchaseId);
    await twoSessions(async (c1, c2, pid2) => {
      await runReturn(c1, A, ret);
      const loser = attempt(c2, () => runReversal(c2, A, rev));
      await waitUntilBlocked(pid2, 'the reversal behind the return');
      await c1.query('COMMIT');
      refusedWith(await loser, 'P0001', 'purchase_reversal.returned', 'the reversal, after the return committed');
      await c2.query('ROLLBACK');
    });
    expect(await stored(p.purchaseId)).toEqual({ returns: 1, reversals: 0, entries: 0 });
  });

  it('the reversal first: the return waits on the purchase row, then supplier_return.purchase_reversed', async () => {
    const A = world.A;
    const p = await purchaseOf(A.piece.variantId, A.w2);
    const ret = await prepareReturn(ownerPool(), A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
    const rev = await prepareReversal(ownerPool(), A, p.purchaseId);
    await twoSessions(async (c1, c2, pid2) => {
      await runReversal(c1, A, rev);
      const loser = attempt(c2, () => runReturn(c2, A, ret));
      await waitUntilBlocked(pid2, 'the return behind the reversal');
      await c1.query('COMMIT');
      refusedWith(await loser, 'P0001', 'supplier_return.purchase_reversed', 'the return, after the reversal committed');
      await c2.query('ROLLBACK');
    });
    expect(await stored(p.purchaseId)).toEqual({ returns: 0, reversals: 1, entries: 1 });
  });
});

describe('T-10 two identical reversals', () => {
  it('one commits; the other waits on the purchase key and replays: one reversal, one entry, one movement set', async () => {
    const A = world.A;
    const p = await purchaseOf(A.piece2.variantId, A.w1);
    const rev = await prepareReversal(ownerPool(), A, p.purchaseId);
    const before = await s5Counts(ownerPool(), A.businessId);
    await twoSessions(async (c1, c2, pid2) => {
      const first = await runReversal(c1, A, rev);
      const second = attempt(c2, () => runReversal(c2, A, rev));
      await waitUntilBlocked(pid2, 'the identical reversal');
      await c1.query('COMMIT');
      const replay = expectAccepted(await second, 'the replay');
      expect(replay.rows.every((r) => r.replayed)).toBe(true);
      expect(replay.entry, 'a replay posts nothing').toBeNull();
      expect(replay.rows.map((r) => r.movement_id)).toEqual(first.rows.map((r) => r.movement_id));
      await c2.query('COMMIT');
    });
    expect(await stored(p.purchaseId)).toEqual({ returns: 0, reversals: 1, entries: 1 });
    const d = s4Delta(before, await s5Counts(ownerPool(), A.businessId));
    expect({ reversals: d.purchase_reversals, movements: d.stock_movements, entries: d.journal_entries, uses: d.inventory_assertion_uses }).toEqual({
      reversals: 1,
      movements: 1,
      entries: 1,
      uses: 2,
    });
  });
});

describe('T-10 a return against a concurrent damage on its key', () => {
  it('the damage first: the return waits on the key, is refused valuation_changed with no partial state, and re-prepared commits', async () => {
    const A = world.A;
    const variantId = must(A.variantProduct.variantIds[0]);
    // Three units worth 1000 (1 at 400, 2 at 300): the average does not terminate, so a damage moves it.
    await committed((c) => receivedPurchase(c, A, [{ variantId, qty: '1', unitPriceMinor: '400' }], { warehouseId: A.w1 }));
    await committed((c) => receivedPurchase(c, A, [{ variantId, qty: '1', unitPriceMinor: '300' }], { warehouseId: A.w1 }));
    const p = await committed((c) => receivedPurchase(c, A, [{ variantId, qty: '1', unitPriceMinor: '300' }], { warehouseId: A.w1 }));
    const key = { warehouseId: A.w1, variantId };
    const ret = await prepareReturn(ownerPool(), A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
    const damage = await damageCommand(ownerPool(), A, A.w1, [{ variantId, qty: '1' }]);
    const before = await s5Counts(ownerPool(), A.businessId);
    await twoSessions(async (c1, c2, pid2) => {
      await runFinancial(c1, A, damage);
      const loser = attempt(c2, () => runReturn(c2, A, ret));
      await waitUntilBlocked(pid2, 'the return behind the damage');
      await c1.query('COMMIT');
      refusedWith(await loser, 'P0001', 'inventory.valuation_changed', 'the bound average moved');
      await c2.query('ROLLBACK');
    });
    const d = s4Delta(before, await s5Counts(ownerPool(), A.businessId));
    expect(d.supplier_returns ?? 0, 'no partial return').toBe(0);
    expect(d.supplier_return_lines ?? 0).toBe(0);
    const level = await stockState(ownerPool(), A.businessId, key);
    const again = await prepareReturn(ownerPool(), A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
    expect(must(again.plan.lines[0]).unitCostSnapshotC10, 'the re-prepared return binds the new average').toBe(must(level.avg));
    expect(again.cmd.inventoryValueMinor, 'at another value than the stale plan').not.toBe(ret.cmd.inventoryValueMinor);
    await committed((c) => runReturn(c, A, again));
    expect(await stored(p.purchaseId)).toEqual({ returns: 1, reversals: 0, entries: 0 });
  });
});
