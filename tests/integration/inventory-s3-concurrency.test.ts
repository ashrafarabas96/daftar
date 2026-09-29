/**
 * P3-S3 T-10 — CONCURRENCY WITH TWO REAL CONNECTIONS
 * (docs/PHASE_3_S3_CONTRACT.md A-07, A-10(d), A-11, A-14(c), A-19, H-5,
 * §6 T-10).
 *
 * Each case seeds its own world and COMMITS it (a two-connection suite; the
 * data is removed by `resetData` afterwards). Connection 1 runs its command
 * and stays open holding its locks; connection 2 runs the competing command,
 * is observed WAITING on a lock (pg_stat_activity, scoped to its pid), and is
 * released by connection 1's COMMIT. Its outcome is then the serialized one:
 * a replay, a typed refusal of the stale command, or a clean success — never
 * a deadlock (40P01), a lost update, a double application, a cache that
 * disagrees with its ledger, or GL Inventory ≠ Σ movement values.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  adjustCommand,
  cacheValue,
  countCommand,
  expectAccepted,
  finalizeCommand,
  glInventory,
  isBlocked,
  movementValue,
  must,
  onHand,
  openingCommand,
  ownerClient,
  pidOf,
  refusedWith,
  runCommand,
  seedS3World,
  settle,
  stocktakeOpenCommand,
  today,
  transferCommand,
  type CommandRow,
  type Outcome,
  type S3Business,
  type StockKey,
} from '../helpers/inventory-commands';
import { postOpeningBalanceInTx, position, runFinancial, runOpening, stockUp } from '../helpers/inventory-posting';
import { verify } from '../helpers/stock-ledger';

let day: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
});

afterAll(async () => {
  await resetData();
});

/** A fresh business A of a fresh world, committed. */
async function freshBusiness(label: string): Promise<S3Business> {
  return (await seedS3World(ownerPool(), label)).A;
}

/** Run `fn` in one owner transaction and COMMIT it (setup of the committed state). */
async function committed<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } finally {
    await c.end();
  }
}

/** An owner connection with an open transaction and bounded waits. */
async function openTx(): Promise<Client> {
  const c = await ownerClient();
  await c.query('BEGIN');
  await c.query(`SET LOCAL lock_timeout = '10s'`);
  await c.query(`SET LOCAL statement_timeout = '20s'`);
  return c;
}

async function closeTx(c: Client): Promise<void> {
  await c.query('ROLLBACK');
  await c.end();
}

/**
 * Wait, bounded, until `pid` waits on a lock or `pending` has settled; report which.
 * A command that never waited is itself a finding (the serialization is missing).
 */
async function blockedOrDone(pid: number, pending: { settled: boolean }): Promise<'blocked' | 'done'> {
  for (let i = 0; i < 400; i += 1) {
    if (pending.settled) return 'done';
    if (await isBlocked(pid)) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} neither waited on a lock nor finished`);
}

/** Start `run` on connection 2 and return its eventual outcome plus a settled flag. */
function start<T>(run: () => Promise<T>): { outcome: Promise<Outcome<T>>; flag: { settled: boolean } } {
  const flag = { settled: false };
  const outcome = settle(run).then((o) => {
    flag.settled = true;
    return o;
  });
  return { outcome, flag };
}

/**
 * The race: connection 1 has already run its command (and holds its locks);
 * connection 2 starts `second` and must be seen waiting; connection 1 commits;
 * connection 2's outcome is returned with its transaction still open.
 */
async function race<T>(c1: Client, c2: Client, second: () => Promise<T>): Promise<Outcome<T>> {
  const pid2 = await pidOf(c2);
  const run = start(second);
  expect(await blockedOrDone(pid2, run.flag), 'connection 2 waits for connection 1').toBe('blocked');
  await c1.query('COMMIT');
  return run.outcome;
}

async function ledgerAgrees(b: S3Business, keys: readonly StockKey[]): Promise<void> {
  const q = await ownerClient();
  try {
    await q.query('BEGIN');
    for (const k of keys) expect((await verify(q, b, k)).matches, `cache = fold for ${k.warehouseId}/${k.variantId}`).toBe(true);
    await q.query('ROLLBACK');
  } finally {
    await q.end();
  }
  const mv = await movementValue(ownerPool(), b.businessId);
  expect(await cacheValue(ownerPool(), b.businessId), 'Σ cache = Σ movements').toBe(mv);
}

describe('T-10.1 PM-03 opposite transfers on the same keys both complete, never 40P01', () => {
  it('W1→W2 [piece, piece2] and W2→W1 [piece2, piece]: the second waits, then completes; stock returns to where it was', async () => {
    const A = await freshBusiness('cc-pm03');
    await committed(async (c) => {
      await stockUp(c, A, A.w1, [
        { variantId: A.piece.variantId, qty: '5', unitCost: '10' },
        { variantId: A.piece2.variantId, qty: '5', unitCost: '20' },
      ]);
      await stockUp(c, A, A.w2, [
        { variantId: A.piece.variantId, qty: '5', unitCost: '10' },
        { variantId: A.piece2.variantId, qty: '5', unitCost: '20' },
      ]);
    });
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runCommand(
        c1,
        A,
        transferCommand(A.w1, A.w2, [
          { variantId: A.piece.variantId, qty: '2' },
          { variantId: A.piece2.variantId, qty: '1' },
        ]),
      );
      const o2 = await race(c1, c2, () =>
        runCommand(
          c2,
          A,
          transferCommand(A.w2, A.w1, [
            { variantId: A.piece2.variantId, qty: '1' },
            { variantId: A.piece.variantId, qty: '2' },
          ]),
        ),
      );
      expectAccepted(o2, 'the opposite transfer, serialized — no 40P01');
      await c2.query('COMMIT');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    const keys = [A.w1, A.w2].flatMap((w) => [A.piece.variantId, A.piece2.variantId].map((v) => ({ warehouseId: w, variantId: v })));
    for (const k of keys) expect(await onHand(ownerPool(), A.businessId, k)).toBe('5.0000');
    await ledgerAgrees(A, keys);
  });
});

describe('T-10.2 two adjustments on one key: each succeeds or refuses valuation_changed / insufficient_stock; nothing is lost', () => {
  it('two losses prepared from one state: the second succeeds (the average did not move); a third over-issues → insufficient_stock', async () => {
    const A = await freshBusiness('cc-adj');
    const key = { warehouseId: A.w1, variantId: A.piece.variantId };
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '8', unitCost: '100' }]));
    const [l1, l2] = await committed(async (c) => [
      await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-3' }]),
      await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-3' }]),
    ]);
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runFinancial(c1, A, must(l1));
      const o2 = await race(c1, c2, () => runFinancial(c2, A, must(l2)));
      expectAccepted(o2, 'the average is unchanged by a loss, so the bound value still holds');
      await c2.query('COMMIT');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    expect(await onHand(ownerPool(), A.businessId, key)).toBe('2.0000');

    const [l3, l4] = await committed(async (c) => [
      await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-2' }]),
      await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-2' }]),
    ]);
    const c3 = await openTx();
    const c4 = await openTx();
    try {
      await runFinancial(c3, A, must(l3));
      refusedWith(await race(c3, c4, () => runFinancial(c4, A, must(l4))), 'P0001', 'inventory.insufficient_stock', 'the key was drained');
    } finally {
      await closeTx(c3);
      await closeTx(c4);
    }
    expect(await onHand(ownerPool(), A.businessId, key)).toBe('0.0000');
    await ledgerAgrees(A, [key]);
    expect(await glInventory(ownerPool(), A.businessId), 'GL Inventory = Σ movement values').toBe(await movementValue(ownerPool(), A.businessId));
  });

  it('a gain at another cost moves the average under a prepared loss: valuation_changed, and the loss re-prepared succeeds', async () => {
    const A = await freshBusiness('cc-val');
    const key = { warehouseId: A.w1, variantId: A.piece.variantId };
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '100' }]));
    const [gain, loss] = await committed(async (c) => [
      await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '2', unitCost: '50' }]),
      await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]),
    ]);
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runFinancial(c1, A, must(gain));
      refusedWith(await race(c1, c2, () => runFinancial(c2, A, must(loss))), 'P0001', 'inventory.valuation_changed', 'bound at avg 100, now 83.33');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    await committed(async (c) =>
      runFinancial(c, A, await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }], { adjustmentId: must(loss).adjustmentId })),
    );
    expect(await onHand(ownerPool(), A.businessId, key)).toBe('5.0000');
    await ledgerAgrees(A, [key]);
    expect(await glInventory(ownerPool(), A.businessId)).toBe(await movementValue(ownerPool(), A.businessId));
  });
});

describe('T-10.3 the same document id raced: an identical body replays, a different body conflicts', () => {
  it('adjustment (serialized by the id lock) and transfer (by the unique header): one creation, one replay; a different body → idempotency_conflict', async () => {
    const A = await freshBusiness('cc-id');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitCost: '10' }]));
    const loss = await committed((c) => adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]));
    const t = transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]);

    for (const [what, first, second, expectReplay] of [
      ['adjustment, identical', loss, loss, true],
      ['transfer, identical', t, t, true],
    ] as const) {
      const c1 = await openTx();
      const c2 = await openTx();
      try {
        const r1: CommandRow[] = first.kind === 'adjust' ? (await runFinancial(c1, A, first)).rows : await runCommand(c1, A, first);
        const o2 = await race(c1, c2, async () => (second.kind === 'adjust' ? (await runFinancial(c2, A, second)).rows : runCommand(c2, A, second)));
        expect(expectAccepted(o2, what), what).toEqual(r1.map((r) => ({ ...r, replayed: expectReplay })));
        await c2.query('COMMIT');
      } finally {
        await closeTx(c1);
        await closeTx(c2);
      }
    }

    const other = await committed((c) => adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]));
    const t2 = transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '1' }]);
    for (const [what, first, second] of [
      ['adjustment, another reason', other, { ...other, reason: 'a different reason' }],
      ['transfer, another quantity', t2, { ...t2, lines: [{ variantId: A.piece.variantId, qty: '3' }] }],
    ] as const) {
      const c1 = await openTx();
      const c2 = await openTx();
      try {
        if (first.kind === 'adjust') await runFinancial(c1, A, first);
        else await runCommand(c1, A, first);
        const o2 = await race(c1, c2, async () => (second.kind === 'adjust' ? (await runFinancial(c2, A, second)).rows : runCommand(c2, A, second)));
        refusedWith(o2, 'P0001', 'inventory.idempotency_conflict', what);
      } finally {
        await closeTx(c1);
        await closeTx(c2);
      }
    }
    const count = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'inventory_adjustment' AND source_id = ANY ($2::uuid[])`,
      [A.businessId, [loss.adjustmentId, other.adjustmentId]],
    );
    expect(must(count.rows[0]).n, 'one entry per adjustment id').toBe(2);
    await ledgerAgrees(A, [
      { warehouseId: A.w1, variantId: A.piece.variantId },
      { warehouseId: A.w2, variantId: A.piece.variantId },
    ]);
  });
});

describe('T-10.4 two finalizes race: applied once', () => {
  it('the second finalize waits, then answers the stored result; one movement, one entry', async () => {
    const A = await freshBusiness('cc-fin');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]));
    const open = stocktakeOpenCommand(A.w1);
    const fin = await committed(async (c) => {
      await runCommand(c, A, open);
      await runCommand(c, A, countCommand(open.stocktakeId, A.w1, [{ variantId: A.piece.variantId, counted: '3' }]));
      return finalizeCommand(c, A, open.stocktakeId, A.w1, { occurredOn: day });
    });
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      const r1 = (await runFinancial(c1, A, fin)).rows;
      const o2 = await race(c1, c2, async () => (await runFinancial(c2, A, fin)).rows);
      expect(expectAccepted(o2)).toEqual(r1.map((r) => ({ ...r, replayed: true })));
      await c2.query('COMMIT');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    const r = await ownerPool().query<{ movements: number; entries: number }>(
      `SELECT (SELECT count(*)::int FROM stock_movements WHERE business_id = $1 AND source_type = 'stocktake' AND source_id = $2) AS movements,
              (SELECT count(*)::int FROM journal_entries WHERE business_id = $1 AND source_type = 'inventory_adjustment' AND source_id = $2) AS entries`,
      [A.businessId, open.stocktakeId],
    );
    expect(r.rows).toEqual([{ movements: 1, entries: 1 }]);
    expect(await onHand(ownerPool(), A.businessId, { warehouseId: A.w1, variantId: A.piece.variantId })).toBe('3.0000');
  });

  it('finalize vs a concurrent movement on a counted key: the finalize waits, then refuses valuation_changed (the key moved past the sequence it read); nothing half-applied', async () => {
    const A = await freshBusiness('cc-finmv');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]));
    const open = stocktakeOpenCommand(A.w1);
    const [fin, gain] = await committed(async (c) => {
      await runCommand(c, A, open);
      await runCommand(c, A, countCommand(open.stocktakeId, A.w1, [{ variantId: A.piece.variantId, counted: '3' }]));
      return [
        await finalizeCommand(c, A, open.stocktakeId, A.w1, { occurredOn: day }),
        await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '10' }]),
      ] as const;
    });
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runFinancial(c1, A, gain);
      refusedWith(await race(c1, c2, () => runFinancial(c2, A, fin)), 'P0001', 'inventory.valuation_changed', 'the key moved after capture');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    const st = await ownerPool().query<{ status: string; n: number }>(
      `SELECT s.status, (SELECT count(*)::int FROM stock_movements m WHERE m.business_id = s.business_id AND m.source_id = s.id) AS n
         FROM stocktakes s WHERE s.business_id = $1 AND s.id = $2`,
      [A.businessId, open.stocktakeId],
    );
    expect(st.rows).toEqual([{ status: 'draft', n: 0 }]);
    await ledgerAgrees(A, [{ warehouseId: A.w1, variantId: A.piece.variantId }]);
  });
});

describe('T-10.4b finalize vs a concurrent recount', () => {
  it('a recount commits first: the finalize prepared over the old count waits, then refuses stocktake_changed', async () => {
    const A = await freshBusiness('cc-recount');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]));
    const open = stocktakeOpenCommand(A.w1);
    const fin = await committed(async (c) => {
      await runCommand(c, A, open);
      await runCommand(c, A, countCommand(open.stocktakeId, A.w1, [{ variantId: A.piece.variantId, counted: '3' }]));
      return finalizeCommand(c, A, open.stocktakeId, A.w1, { occurredOn: day });
    });
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runCommand(c1, A, countCommand(open.stocktakeId, A.w1, [{ variantId: A.piece.variantId, counted: '4' }]));
      refusedWith(await race(c1, c2, () => runFinancial(c2, A, fin)), 'P0001', 'inventory.stocktake_changed', 'the counted line changed');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    const st = await ownerPool().query<{ status: string; variance: string }>(
      `SELECT s.status, l.variance_qty::text AS variance FROM stocktakes s JOIN stocktake_lines l ON l.business_id = s.business_id AND l.stocktake_id = s.id
        WHERE s.business_id = $1 AND s.id = $2`,
      [A.businessId, open.stocktakeId],
    );
    expect(st.rows).toEqual([{ status: 'draft', variance: '-1.0000' }]);
  });
});

describe('T-10.5 opening vs opening-balance post: serialized by the opening-balance lock, with exactly the A-14(c) outcome', () => {
  it('a Case A opening first: the opening balance stating Inventory waits, then refuses opening_balance_inventory_conflict', async () => {
    const A = await freshBusiness('cc-ob-a');
    const opening = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '2', unitCost: '50' }]);
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runOpening(c1, A, opening);
      refusedWith(
        await race(c1, c2, () => postOpeningBalanceInTx(c2, A, day, [position('inventory', 'D', 100n), position('cash', 'D', 50n)])),
        'P0001',
        'accounting.opening_balance_inventory_conflict',
        'Inventory stated twice',
      );
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    expect(await glInventory(ownerPool(), A.businessId)).toBe(100n);
  });

  it('the opening balance first: the Case A opening prepared before it waits, then refuses opening_case_changed', async () => {
    const A = await freshBusiness('cc-ob-b');
    const opening = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '2', unitCost: '50' }]);
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await postOpeningBalanceInTx(c1, A, day, [position('inventory', 'D', 100n), position('cash', 'D', 50n)]);
      refusedWith(await race(c1, c2, () => runOpening(c2, A, opening)), 'P0001', 'inventory.opening_case_changed', 'Case A prepared, Case B now');
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    expect(await glInventory(ownerPool(), A.businessId), 'GL Inventory is the opening position alone').toBe(100n);
    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_openings WHERE business_id = $1`, [A.businessId]);
    expect(must(n.rows[0]).n).toBe(0);
  });
});

describe('T-10.6 archive vs inbound movement on one warehouse: serialized; never an archived warehouse with stock', () => {
  it('the movement first: the archive waits, then refuses warehouse_has_stock', async () => {
    const A = await freshBusiness('cc-arch1');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '3', unitCost: '10' }]));
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await runCommand(c1, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '1' }]));
      refusedWith(
        await race(c1, c2, () => c2.query(`UPDATE warehouses SET status = 'archived' WHERE business_id = $1 AND id = $2`, [A.businessId, A.w2])),
        'P0001',
        'inventory.warehouse_has_stock',
        'archive after an inbound transfer',
      );
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    await expectNoArchivedWarehouseWithStock(A);
  });

  it('the archive first: the inbound transfer waits, then refuses warehouse_archived', async () => {
    const A = await freshBusiness('cc-arch2');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '3', unitCost: '10' }]));
    const c1 = await openTx();
    const c2 = await openTx();
    try {
      await c1.query(`UPDATE warehouses SET status = 'archived' WHERE business_id = $1 AND id = $2`, [A.businessId, A.w2]);
      refusedWith(
        await race(c1, c2, () => runCommand(c2, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '1' }]))),
        'P0001',
        'inventory.warehouse_archived',
        'inbound transfer after the archive',
      );
    } finally {
      await closeTx(c1);
      await closeTx(c2);
    }
    await expectNoArchivedWarehouseWithStock(A);
  });
});

describe('T-10.7 a replay never waits on stock: the proof precedes every stock lock', () => {
  it('while another transaction holds the key, a replay of a committed adjustment answers at once; a fresh one on the key waits', async () => {
    const A = await freshBusiness('cc-replay');
    await committed((c) => stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '6', unitCost: '10' }]));
    const done = await committed(async (c) => {
      const cmd = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      await runFinancial(c, A, cmd);
      return cmd;
    });
    const fresh = await committed((c) => adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]));
    const holder = await openTx();
    const replayer = await openTx();
    const waiter = await openTx();
    try {
      await runFinancial(holder, A, await adjustCommand(holder, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]));
      await replayer.query(`SET LOCAL lock_timeout = '2s'`);
      const started = Date.now();
      const replay = await runCommand(replayer, A, done);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(replay.every((r) => r.replayed === true)).toBe(true);

      const pid = await pidOf(waiter);
      const run = start(() => runFinancial(waiter, A, fresh));
      expect(await blockedOrDone(pid, run.flag), 'ALLOW-side contrast: a fresh command on the key waits').toBe('blocked');
      await holder.query('ROLLBACK');
      expectAccepted(await run.outcome);
    } finally {
      await closeTx(holder);
      await closeTx(replayer);
      await closeTx(waiter);
    }
  });
});

async function expectNoArchivedWarehouseWithStock(b: S3Business): Promise<void> {
  const r = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM warehouses w
      WHERE w.business_id = $1 AND w.status = 'archived'
        AND (EXISTS (SELECT 1 FROM stock_levels l WHERE l.business_id = w.business_id AND l.warehouse_id = w.id AND l.on_hand <> 0)
          OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.business_id = w.business_id AND m.warehouse_id = w.id GROUP BY m.variant_id HAVING sum(m.qty_delta) <> 0))`,
    [b.businessId],
  );
  expect(must(r.rows[0]).n).toBe(0);
}
