/**
 * P3-S4 T-09 — CONCURRENCY ON TWO REAL CONNECTIONS
 * (docs/PHASE_3_S4_CONTRACT.md A-07, A-16, R-25, R-26, §6 T-09; P:216).
 *
 * Committed state, two sessions, the second provably waiting
 * (`pg_stat_activity`) before the first commits:
 *   - two receipts of one stock key, both prepared against the same open
 *     deficit layers: the loser waits on the key, then is refused
 *     `inventory.valuation_changed` (its plan is stale) and, re-prepared,
 *     covers exactly the rest — per layer Σ covered = the original deficit,
 *     never more;
 *   - two identical receives of one purchase: one commits the receipt and the
 *     other, after waiting, answers the stored rows as a replay — one set of
 *     movements, one entry;
 *   - a draft replace against a receive of the same purchase: whichever holds
 *     the purchase key first wins, and the other is refused
 *     (`purchase.draft_changed` / `purchase.state_invalid`).
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { attempt, expectAccepted, must, ownerClient, pidOf, refusedWith, seedS3World, waitUntilBlocked, type S3World } from '../helpers/inventory-commands';
import {
  draftCommand,
  honestDraft,
  prepareReceipt,
  runCommand,
  runReceipt,
  supplierIn,
  tryCommand,
  type DraftCommand,
  type PreparedReceipt,
  type ReceiptRun,
} from '../helpers/purchase-commands';
import { coverageVector, installCommittedDeficitFixture, layersOf, removeCommittedDeficitFixture, seedCommittedDeficitKey } from '../helpers/purchase-deficits';

let world: S3World;
let supplierId: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  await installCommittedDeficitFixture();
  world = await seedS3World(ownerPool(), 's4conc');
  supplierId = await supplierIn(ownerPool(), world.A);
});

afterAll(async () => {
  await removeCommittedDeficitFixture();
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

async function savedDraft(d: DraftCommand): Promise<DraftCommand> {
  await committed((c) => runCommand(c, world.A, d));
  return d;
}

async function prepared(purchaseId: string): Promise<PreparedReceipt> {
  return prepareReceipt(ownerPool(), world.A, purchaseId);
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

describe('T-09 two receipts of one key cover disjoint quantities', () => {
  it('THREE-LAYERS: the loser waits, is refused valuation_changed, and re-prepared covers exactly the next layers', async () => {
    const A = world.A;
    const v = coverageVector('THREE-LAYERS');
    const seed = must(v.seed[0]);
    const [l1, l2, l3] = [must(seed.layers[0]), must(seed.layers[1]), must(seed.layers[2])];
    await seedCommittedDeficitKey(A, A.w1, A.piece.variantId, seed);
    // The first receipt covers the first layer exactly; the second, prepared against all three,
    // plans the whole first layer and part of the second — at other provisional costs than it
    // would meet after the first commits, so its bound catch-up is stale.
    const q1 = l1.uncovered;
    const q2 = String(Number(l2.uncovered));
    const d1 = await savedDraft(await draftCommand(ownerPool(), supplierId, A.w1, [{ variantId: A.piece.variantId, qty: q1, unitPriceMinor: '120' }]));
    const d2 = await savedDraft(await draftCommand(ownerPool(), supplierId, A.w1, [{ variantId: A.piece.variantId, qty: q2, unitPriceMinor: '130' }]));
    const p1 = await prepared(d1.purchaseId);
    const p2 = await prepared(d2.purchaseId);
    const p2Stale = p2.cmd.lines.map((l) => l.catchUpMinor);

    await twoSessions(async (c1, c2, pid2) => {
      const first = await runReceipt(c1, A, p1);
      expect(first.catchUpEntry).not.toBeNull();
      const loser = attempt(c2, () => runReceipt(c2, A, p2));
      await waitUntilBlocked(pid2, 'the second receipt of the key');
      await c1.query('COMMIT');
      refusedWith(await loser, 'P0001', 'inventory.valuation_changed', 'a stale coverage plan');
      await c2.query('ROLLBACK');
    });

    const re = await prepareReceipt(ownerPool(), A, d2.purchaseId);
    expect(
      re.cmd.lines.map((l) => l.catchUpMinor),
      'the re-prepared plan differs from the stale one',
    ).not.toEqual(p2Stale);
    const retry: ReceiptRun = await committed((c) => runReceipt(c, A, re));
    expect(
      retry.rows.filter((r) => r.row_kind === 'coverage').map((r) => r.deficit_id),
      'the retry covers the next layers in FIFO order',
    ).toEqual([l2.deficitId]);

    const covered = await ownerPool().query<{ deficit_id: string; q: string }>(
      `SELECT deficit_id::text, sum(qty_covered)::text AS q FROM negative_deficit_coverages WHERE business_id = $1 GROUP BY deficit_id ORDER BY deficit_id`,
      [A.businessId],
    );
    expect(covered.rows, 'per layer, Σ covered never exceeds the original deficit').toEqual([
      { deficit_id: l1.deficitId, q: l1.uncovered },
      { deficit_id: l2.deficitId, q: l2.uncovered },
    ]);
    const layers = await layersOf(ownerPool(), A.businessId, A.w1, A.piece.variantId);
    expect(layers.map((l) => [l.id, l.uncovered, l.status])).toEqual([
      [l1.deficitId, '0.0000', 'closed'],
      [l2.deficitId, '0.0000', 'closed'],
      [l3.deficitId, l3.uncovered, 'open'],
    ]);
  });
});

describe('T-09 two identical receives of one purchase', () => {
  it('one commits the receipt; the other waits and answers the stored rows as a replay', async () => {
    const A = world.A;
    const d = await savedDraft(await honestDraft(ownerPool(), A, supplierId, { warehouseId: A.w2 }));
    const p = await prepared(d.purchaseId);
    let firstRows: ReceiptRun['rows'] = [];
    await twoSessions(async (c1, c2, pid2) => {
      firstRows = (await runReceipt(c1, A, p)).rows;
      const second = attempt(c2, () => runReceipt(c2, A, p));
      await waitUntilBlocked(pid2, 'the identical receive');
      await c1.query('COMMIT');
      const replay = expectAccepted(await second, 'the replay');
      expect(replay.rows.every((r) => r.replayed)).toBe(true);
      expect(replay.purchaseEntry, 'a replay posts nothing').toBeNull();
      expect(replay.rows.map((r) => r.movement_id)).toEqual(firstRows.map((r) => r.movement_id));
      await c2.query('COMMIT');
    });
    const n = must(
      (
        await ownerPool().query<{ m: number; e: number }>(
          `SELECT (SELECT count(*)::int FROM stock_movements WHERE business_id = $1 AND source_type = 'purchase' AND source_id = $2) AS m,
                  (SELECT count(*)::int FROM journal_entries WHERE business_id = $1 AND source_type = 'purchase' AND source_id = $2) AS e`,
          [A.businessId, d.purchaseId],
        )
      ).rows[0],
    );
    expect(n).toEqual({ m: d.lines.length, e: 1 });
  });
});

describe('T-09 a draft replace against a receive of the same purchase', () => {
  it('the replace first: the receive waits, then draft_changed', async () => {
    const A = world.A;
    const d = await savedDraft(await honestDraft(ownerPool(), A, supplierId, { warehouseId: A.w2 }));
    const p = await prepared(d.purchaseId);
    await twoSessions(async (c1, c2, pid2) => {
      await runCommand(c1, A, { ...d, expectedRevision: 1, notes: 'replaced while receiving' });
      const receive = tryCommand(c2, A, p.cmd);
      await waitUntilBlocked(pid2, 'the receive behind the replace');
      await c1.query('COMMIT');
      refusedWith(await receive, 'P0001', 'purchase.draft_changed');
      await c2.query('ROLLBACK');
    });
  });

  it('the receive first: the replace waits, then state_invalid', async () => {
    const A = world.A;
    const d = await savedDraft(await honestDraft(ownerPool(), A, supplierId, { warehouseId: A.w2 }));
    const p = await prepared(d.purchaseId);
    await twoSessions(async (c1, c2, pid2) => {
      await runReceipt(c1, A, p);
      const replace = tryCommand(c2, A, { ...d, expectedRevision: 1, notes: 'replaced after the receipt' });
      await waitUntilBlocked(pid2, 'the replace behind the receive');
      await c1.query('COMMIT');
      refusedWith(await replace, 'P0001', 'purchase.state_invalid');
      await c2.query('ROLLBACK');
    });
  });
});
