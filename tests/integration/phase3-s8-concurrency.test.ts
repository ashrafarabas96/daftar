/**
 * P3-S8 T-11 — THE CROSS-SLICE SOAK (docs/PHASE_3_S8_CONTRACT.md A-16;
 * PM-02, PM-03, PM-13, PM-15; PM:682).
 *
 * Three connections run 200 seeded-random commands over one business of 4
 * warehouses × 20 variants × 3 suppliers, each command its own transaction
 * through the real routines and their entries: receipts, transfers in both
 * directions, adjustments (gains and losses), returns, reversals, payments,
 * returns after a full payment (credit notes) and credit allocations. The
 * commands read what they need inside their own transaction, so a stale read
 * is the routine's own refusal. It asserts:
 *   - zero `40P01` (deadlock);
 *   - every refusal is a stable domain code — the routine's
 *     (`<area>.<reason>:`) or the package's typed validation the service runs
 *     before it (`InventoryError`/`AccountingError`, by code) — or `40001`,
 *     never an unclassified error;
 *   - enough commands committed for the soak to mean something, every kind;
 *   - after the soak R-INV-01..05 are `ok` and every key verifies.
 * The seed is printed (`T11_SEED` replays it).
 *
 * NEGATIVE CONTROL (PM-03): in a scratch database the S2 primitive is
 * replaced — owner and grants kept — by one that locks the stock keys in
 * PAYLOAD order instead of ascending key order, so a transfer locks its
 * source before its destination. Transfers in both directions over the same
 * keys then deadlock: the soak observes `40P01` within its budget.
 */
import { Client, DatabaseError, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrl, ensurePostgres, ownerPool, reconcilerDbUrl, resetData } from '../helpers/test-app';
import { adjustCommand, must, runCommand, seedS3Business, seedS3World, transferCommand, type Queryable, type S3Business } from '../helpers/inventory-commands';
import { runFinancial, stockUp } from '../helpers/inventory-posting';
import { addTrackedProduct, addWarehouse } from '../helpers/stock-ledger';
import { createSupplier } from '../helpers/purchase-commands';
import { prepareReversal, receivedPurchase, returnGoods, runReversal, type ReceivedPurchase } from '../helpers/purchase-returns';
import { createMethod, prepareAllocate, preparePay, runS6, sqlReturnToCredit } from '../helpers/supplier-settlement';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { R_INV, runChecks, statuses } from '../helpers/inventory-reconciliation';

const COMMANDS = 200;
const WORKERS = 3;
const STABLE = /^[a-z_]+\.[a-z_]+:/;
const ALL_OK = { 'R-INV-01': 'ok', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' };
const SEED = Number(process.env['T11_SEED'] ?? Math.floor(Math.random() * 2 ** 31));

/** mulberry32: a tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'receipt' | 'transfer' | 'adjustment' | 'return' | 'reversal' | 'payment' | 'credit_note' | 'allocation';

interface Soak {
  readonly biz: S3Business;
  readonly warehouses: readonly string[];
  readonly variants: readonly string[];
  readonly suppliers: readonly string[];
  readonly methodId: string;
  readonly purchases: ReceivedPurchase[];
  readonly credits: { readonly creditNoteId: string; readonly supplierId: string }[];
}

/**
 * One command's outcome: committed; a refusal with its SQLSTATE (or `typed`)
 * and message; or skipped — the driver's target purchase was reversed by a
 * concurrent command before the preparation read it, so there was nothing to
 * present (the service answers that before any routine runs).
 */
type Result =
  | { readonly kind: Kind; readonly ok: true; readonly skipped?: boolean }
  | { readonly kind: Kind; readonly ok: false; readonly sqlstate: string; readonly message: string };

/** A package refusal (`InventoryError` / `AccountingError`) carries its stable code; matched by name, whichever module instance threw it. */
function typedCode(e: unknown): string | null {
  if (!(e instanceof Error) || (e.name !== 'InventoryError' && e.name !== 'AccountingError') || !('code' in e)) return null;
  return typeof e.code === 'string' ? e.code : null;
}

interface Command {
  readonly purchaseId: string | null;
  /** Runs the command; answers what to publish to the shared state once it has COMMITTED. */
  run(c: Client): Promise<(() => void) | undefined>;
}

interface SoakReport {
  readonly results: readonly Result[];
  readonly committed: Readonly<Record<string, number>>;
  readonly deadlocks: number;
  readonly unclassified: readonly string[];
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return must(xs[Math.floor(rand() * xs.length)], 'a pick from an empty list');
}

function draw(rand: () => number, weights: readonly (readonly [Kind, number])[]): Kind {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [k, w] of weights) {
    r -= w;
    if (r < 0) return k;
  }
  return must(weights[weights.length - 1])[0];
}

/** One command of `kind`, run in the caller's transaction; draws its arguments from `rand`. */
function commandOf(s: Soak, kind: Kind, rand: () => number): Command {
  const run = bodyOf(s, kind, rand);
  return { purchaseId: run.purchaseId, run: run.body };
}

function bodyOf(
  s: Soak,
  kind: Kind,
  rand: () => number,
): { readonly purchaseId: string | null; readonly body: (c: Client) => Promise<(() => void) | undefined> } {
  const { biz } = s;
  const wh = pick(rand, s.warehouses);
  const other = pick(
    rand,
    s.warehouses.filter((w) => w !== wh),
  );
  const variant = pick(rand, s.variants);
  const supplierId = s.suppliers.length === 0 ? '' : pick(rand, s.suppliers);
  const purchase = s.purchases.length === 0 ? null : pick(rand, s.purchases);
  const credit = s.credits.length === 0 ? null : pick(rand, s.credits);
  const creditTargets = credit === null ? [] : s.purchases.filter((p) => p.supplierId === credit.supplierId);
  const creditTarget = creditTargets.length === 0 ? null : pick(rand, creditTargets);
  const qty = String(1 + Math.floor(rand() * 3));
  const price = String(100 + Math.floor(rand() * 1900));
  const gain = rand() < 0.5;
  const none = { purchaseId: null, body: async (): Promise<undefined> => undefined };
  switch (kind) {
    case 'receipt':
      return {
        purchaseId: null,
        body: async (c) => {
          const lines = [...new Set([variant, pick(rand, s.variants)])].map((v) => ({ variantId: v, qty, unitPriceMinor: price }));
          const p = await receivedPurchase(c, biz, lines, { supplierId, warehouseId: wh });
          return () => s.purchases.push(p);
        },
      };
    case 'transfer':
      return {
        purchaseId: null,
        body: async (c) => {
          await runCommand(c, biz, transferCommand(wh, other, [{ variantId: variant, qty: '1' }]));
          return undefined;
        },
      };
    case 'adjustment':
      return {
        purchaseId: null,
        body: async (c) => {
          await runFinancial(
            c,
            biz,
            await adjustCommand(c, biz, wh, [gain ? { variantId: variant, qty: '2', unitCost: '6.25' } : { variantId: variant, qty: '-1' }]),
          );
          return undefined;
        },
      };
    case 'return':
      if (purchase === null) return none;
      return {
        purchaseId: purchase.purchaseId,
        body: async (c) => {
          await returnGoods(c, biz, purchase.purchaseId, { lines: [{ purchaseLineId: must(purchase.lines[0]).lineId, qty: '1' }], reason: 'Soak return' });
          return undefined;
        },
      };
    case 'reversal':
      if (purchase === null) return none;
      return {
        purchaseId: purchase.purchaseId,
        body: async (c) => {
          await runReversal(c, biz, await prepareReversal(c, biz, purchase.purchaseId));
          return undefined;
        },
      };
    case 'payment':
      if (purchase === null) return none;
      return {
        purchaseId: purchase.purchaseId,
        body: async (c) => {
          const allocations = [{ purchaseId: purchase.purchaseId, paymentAmountMinor: 100n }];
          await runS6(c, biz, await preparePay(c, biz, { supplierId: purchase.supplierId, paymentMethodId: s.methodId, allocations }));
          return undefined;
        },
      };
    case 'credit_note':
      return {
        purchaseId: null,
        body: async (c) => {
          const n = await sqlReturnToCredit(c, biz, s.methodId, { supplierId, warehouseId: wh });
          return () => {
            s.purchases.push(n.purchase);
            s.credits.push({ creditNoteId: n.creditNoteId, supplierId: n.purchase.supplierId });
          };
        },
      };
    case 'allocation':
      if (credit === null || creditTarget === null) return none;
      return {
        purchaseId: creditTarget.purchaseId,
        body: async (c) => {
          await runS6(c, biz, await prepareAllocate(c, biz, { creditNoteId: credit.creditNoteId, purchaseId: creditTarget.purchaseId, consumedMinor: 100n }));
          return undefined;
        },
      };
  }
}

/**
 * `commands` draws of `weights`, run by `workers` connections to `url`, each
 * command its own transaction. Stops early once `stop` holds.
 */
async function soak(
  url: string,
  s: Soak,
  seed: number,
  o: { readonly commands: number; readonly workers: number; readonly weights: readonly (readonly [Kind, number])[]; readonly stop?: (r: Result) => boolean },
): Promise<SoakReport> {
  const rand = prng(seed);
  const results: Result[] = [];
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      while (!stopped && next < o.commands) {
        next += 1;
        const kind = draw(rand, o.weights);
        const cmd = commandOf(s, kind, rand);
        let r: Result;
        try {
          await c.query('BEGIN');
          const publish = await cmd.run(c);
          await c.query('COMMIT');
          publish?.();
          r = { kind, ok: true };
        } catch (e) {
          await c.query('ROLLBACK');
          // A refusal by the database (its SQLSTATE and message), or by the
          // package's own typed validation the service runs before the routine
          // (its stable code); a preparation that found its target purchase
          // reversed meanwhile is a skip; anything else is unclassified.
          const code = typedCode(e);
          r =
            e instanceof DatabaseError
              ? { kind, ok: false, sqlstate: e.code ?? '', message: e.message }
              : code !== null
                ? { kind, ok: false, sqlstate: 'typed', message: `${code}: ${e instanceof Error ? e.message : ''}` }
                : cmd.purchaseId !== null && (await reversed(c, s.biz.businessId, cmd.purchaseId))
                  ? { kind, ok: true, skipped: true }
                  : { kind, ok: false, sqlstate: 'JS', message: e instanceof Error ? e.message : String(e) };
        }
        results.push(r);
        if (o.stop?.(r) === true) stopped = true;
      }
    } finally {
      await c.end();
    }
  };
  await Promise.all(Array.from({ length: o.workers }, () => worker()));
  const committed: Record<string, number> = {};
  for (const r of results) if (r.ok && r.skipped !== true) committed[r.kind] = (committed[r.kind] ?? 0) + 1;
  return {
    results,
    committed,
    deadlocks: results.filter((r) => !r.ok && r.sqlstate === '40P01').length,
    unclassified: results
      .filter((r) => !r.ok && r.sqlstate !== '40001' && !STABLE.test(r.message))
      .map((r) => (r.ok ? '' : `${r.kind}: ${r.sqlstate} ${r.message}`)),
  };
}

/** Has `purchaseId` been reversed (committed)? */
async function reversed(c: Client, businessId: string, purchaseId: string): Promise<boolean> {
  const r = await c.query<{ x: boolean }>(`SELECT EXISTS (SELECT 1 FROM purchase_reversals WHERE business_id = $1 AND purchase_id = $2) AS x`, [
    businessId,
    purchaseId,
  ]);
  return must(r.rows[0]).x;
}

/** The keys of `biz` whose cache row does not verify (R6 over every level row). */
async function unverified(q: Client, biz: S3Business): Promise<string[]> {
  await q.query('BEGIN');
  try {
    await q.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [biz.tenantId, biz.businessId]);
    const r = await q.query<{ k: string }>(
      `SELECT l.warehouse_id || '/' || l.variant_id AS k
         FROM stock_levels l CROSS JOIN LATERAL inventory_stock_verify(l.business_id, l.warehouse_id, l.variant_id) v
        WHERE l.business_id = $1 AND NOT v.matches ORDER BY 1`,
      [biz.businessId],
    );
    return r.rows.map((x) => x.k);
  } finally {
    await q.query('ROLLBACK');
  }
}

async function committedOn(url: string, fn: (c: Client) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

async function cashOf(q: Queryable, businessId: string): Promise<string> {
  return must((await q.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId])).rows[0]).id;
}

describe('T-11 the cross-slice soak', () => {
  let s: Soak;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    const biz = (await seedS3World(ownerPool(), 't11')).A;
    const w3 = await addWarehouse(ownerPool(), biz.businessId, biz.branchX, 'Third WH');
    const w4 = await addWarehouse(ownerPool(), biz.businessId, biz.branchY, 'Fourth WH');
    const variants = [biz.piece.variantId, biz.piece2.variantId];
    for (let i = variants.length; i < 20; i += 1) variants.push((await addTrackedProduct(ownerPool(), biz, 'piece', 0)).variantId);
    const warehouses = [biz.w1, biz.w2, w3, w4];
    const suppliers: string[] = [];
    let methodId = '';
    const purchases: ReceivedPurchase[] = [];
    await committedOn(dbUrl, async (c) => {
      for (let i = 0; i < 3; i += 1) suppliers.push(await createSupplier(c, biz, { name: `Soak supplier ${i + 1}` }));
      methodId = await createMethod(c, biz, { postingAccountId: await cashOf(c, biz.businessId) });
      for (const [i, wh] of warehouses.entries()) {
        purchases.push(
          await receivedPurchase(
            c,
            biz,
            variants.map((v) => ({ variantId: v, qty: '10', unitPriceMinor: String(500 + i * 25) })),
            { supplierId: must(suppliers[i % 3]), warehouseId: wh },
          ),
        );
      }
    });
    s = { biz, warehouses, variants, suppliers, methodId, purchases, credits: [] };
  }, 300_000);

  afterAll(async () => {
    await resetData();
  });

  it('PM-03: 200 seeded-random commands on 3 connections — zero deadlocks, every refusal classified, every kind committed; then R-INV-01..05 ok and every key verifies', async () => {
    console.log(`T-11 soak seed ${SEED} (replay with T11_SEED=${SEED})`);
    const report = await soak(dbUrl, s, SEED, {
      commands: COMMANDS,
      workers: WORKERS,
      weights: [
        ['receipt', 18],
        ['transfer', 25],
        ['adjustment', 14],
        ['return', 9],
        ['reversal', 5],
        ['payment', 12],
        ['credit_note', 7],
        ['allocation', 10],
      ],
    });
    expect(report.results.length).toBe(COMMANDS);
    expect(report.deadlocks, `seed ${SEED}: 40P01`).toBe(0);
    expect(report.unclassified, `seed ${SEED}`).toEqual([]);
    const ok = report.results.filter((r) => r.ok && r.skipped !== true).length;
    expect(ok, `seed ${SEED}: committed ${JSON.stringify(report.committed)}`).toBeGreaterThanOrEqual(COMMANDS / 2);
    for (const k of ['receipt', 'transfer', 'adjustment', 'payment', 'credit_note'])
      expect(report.committed[k] ?? 0, `seed ${SEED}: ${k} committed`).toBeGreaterThan(0);

    const reconciler = new Pool({ connectionString: reconcilerDbUrl, max: 1 });
    try {
      expect(statuses(await runChecks(reconciler, { tenantId: s.biz.tenantId, businessId: s.biz.businessId }, R_INV)), `seed ${SEED}`).toEqual(ALL_OK);
    } finally {
      await reconciler.end();
    }
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    try {
      expect(await unverified(c, s.biz), `seed ${SEED}`).toEqual([]);
    } finally {
      await c.end();
    }
  });
});

describe('T-11 NEGATIVE CONTROL — the primitive locking in payload order', () => {
  let db: ScratchDb;
  let s: Soak;

  beforeAll(async () => {
    await ensurePostgres();
    db = await createScratchDb('daftar_p3s8_t11_nc');
    const w = await seedS3World(db.pool, 't11nc');
    const biz = await seedS3Business(db.pool, w.A.tenantId, w.A.userId, 't11nc-hot');
    await committedOn(db.url(), async (c) => {
      for (const wh of [biz.w1, biz.w2]) {
        await stockUp(c, biz, wh, [
          { variantId: biz.piece.variantId, qty: '500', unitCost: '4' },
          { variantId: biz.piece2.variantId, qty: '500', unitCost: '7' },
        ]);
      }
    });
    s = { biz, warehouses: [biz.w1, biz.w2], variants: [biz.piece.variantId, biz.piece2.variantId], suppliers: [], methodId: '', purchases: [], credits: [] };
  }, 300_000);

  afterAll(async () => {
    await db.drop();
  });

  it('PM-03 NC: as shipped the transfer-only soak over two hot keys never deadlocks; with payload-order locking it observes 40P01', async () => {
    const seed = SEED ^ 0x5eed;
    const hot = { commands: COMMANDS, workers: 4, weights: [['transfer', 1]] as const };
    const shipped = await soak(db.url(), s, seed, hot);
    expect({ deadlocks: shipped.deadlocks, unclassified: shipped.unclassified }, `seed ${seed}`).toEqual({ deadlocks: 0, unclassified: [] });

    const sig = 'inventory_apply_stock_movements(inventory_movement_request[])';
    const def = must((await db.pool.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [sig])).rows[0]).d;
    const ordered = /SELECT DISTINCT r\.warehouse_id AS wh, r\.variant_id AS va\s+FROM unnest\(p_requests\) AS r\s+ORDER BY 1, 2/;
    expect(ordered.test(def), 'the primitive locks its keys in ascending order').toBe(true);
    const payloadOrder = def.replace(
      ordered,
      `SELECT r.warehouse_id AS wh, r.variant_id AS va FROM unnest(p_requests) WITH ORDINALITY AS r GROUP BY 1, 2 ORDER BY min(r.ordinality)`,
    );
    const before = must(
      (
        await db.pool.query<{ owner: string; acl: string }>(
          `SELECT proowner::regrole::text AS owner, coalesce(proacl::text, '') AS acl FROM pg_proc WHERE oid = $1::regprocedure`,
          [sig],
        )
      ).rows[0],
    );
    await db.pool.query(payloadOrder);
    const after = must(
      (
        await db.pool.query<{ owner: string; acl: string }>(
          `SELECT proowner::regrole::text AS owner, coalesce(proacl::text, '') AS acl FROM pg_proc WHERE oid = $1::regprocedure`,
          [sig],
        )
      ).rows[0],
    );
    expect(after, 'owner and grants kept').toEqual(before);

    const attacked = await soak(db.url(), s, seed, { ...hot, stop: (r) => !r.ok && r.sqlstate === '40P01' });
    expect(
      attacked.unclassified.filter((u) => !u.includes('40P01')),
      `seed ${seed}`,
    ).toEqual([]);
    expect(attacked.deadlocks, `seed ${seed}: the reversed lock order deadlocks`).toBeGreaterThanOrEqual(1);
  });
});
