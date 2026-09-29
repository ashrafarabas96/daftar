/**
 * P3-S2 — THE STOCK LEDGER UNDER REAL CONCURRENCY (docs/PHASE_3_S2_CONTRACT.md
 * §6: T-03, T-04, T-06.6, T-17.11; §5 H-3; the post-review M-1 READ COMMITTED
 * reproduction and the H-1 variant-reparent races).
 *
 * Two (or three) REAL connections, each with its own transaction, its own
 * scope and its own `invctl/1` assertion, driven through the fixture producer
 * as `daftar_app`. Every interleaving is FORCED: a second statement is
 * started, the test waits — bounded, failing if it never happens — until
 * that backend is parked on a heavyweight lock (pg_stat_activity), and only
 * then releases the first transaction. No retries, no sleeps as proof.
 *
 * The fixture is COMMITTED here (A-11: the two-connection suites only):
 * installed in beforeAll after an idempotent cleanup, removed in afterAll,
 * and the registries are asserted back at the migration state.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_STOCK_STATE, formatMinor, formatQuantity, formatUnitCost, parseQuantity, parseUnitCost, simulateMovement } from '../../packages/inventory/src';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  addTrackedProduct,
  addVariantProduct,
  addWarehouse,
  applyAsApp,
  assertMigrationState,
  configureAsApp,
  expectAccepted,
  expectRefused,
  installCommittedFixture,
  levelOf,
  movementsOf,
  must,
  ownerClient,
  pidOf,
  removeCommittedFixture,
  req,
  seedStockBusiness,
  setScope,
  settle,
  verify,
  waitUntilBlocked,
  withoutRefusal,
  type ConfigureCall,
  type Key,
  type MovementRequest,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

let biz: StockBusiness;
const open: Client[] = [];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'conc');
  await installCommittedFixture();
});

afterAll(async () => {
  await close(...open);
  await removeCommittedFixture();
  await assertMigrationState();
});

/** Every session of this file, with its backend pid. */
const pids = new Map<Client, number>();

/** A fresh session (a raw owner connection that the helpers switch to daftar_app per call). */
async function session(): Promise<Client> {
  const c = await ownerClient();
  // A session ended by close() below reports the termination as an error event; it is expected.
  c.on('error', () => undefined);
  pids.set(c, await pidOf(c));
  open.push(c);
  return c;
}

/**
 * End sessions WITHOUT queueing behind a statement that may still be waiting
 * (a failed case can leave one parked on a lock): the backend is terminated
 * from outside, which rolls its transaction back and releases its locks.
 */
/** The backend pid of a session, captured when it was opened — never asked of the (possibly busy) session itself. */
function pidFor(c: Client): number {
  return must(pids.get(c), 'session pid');
}

async function close(...cs: Client[]): Promise<void> {
  for (const c of cs) {
    const i = open.indexOf(c);
    if (i < 0) continue;
    open.splice(i, 1);
    const pid = pids.get(c);
    pids.delete(c);
    if (pid !== undefined) await ownerPool().query('SELECT pg_terminate_backend($1)', [pid]);
    await c.end().catch(() => undefined);
  }
}

/** A key nobody has touched: a new warehouse in the business, the piece product's base variant. */
async function freshKey(variantId = biz.piece.variantId): Promise<Key> {
  return { warehouseId: await addWarehouse(ownerPool(), biz.businessId, biz.branchId, `WH ${randomUUID().slice(0, 8)}`), variantId };
}

/** One committed fixture call on its own connection. */
async function commitApply(requests: readonly MovementRequest[]): Promise<void> {
  const c = await session();
  try {
    await c.query('BEGIN');
    await applyAsApp(c, biz, requests);
    await c.query('COMMIT');
  } finally {
    await close(c);
  }
}

/** R6 on its own connection and transaction (the scope GUCs are transaction-local). */
async function verifyNow(K: Key): Promise<boolean> {
  const c = await session();
  try {
    await c.query('BEGIN');
    return (await verify(c, biz, K)).matches;
  } finally {
    await close(c);
  }
}

async function blockers(pid: number): Promise<number[]> {
  return must((await ownerPool().query<{ b: number[] }>(`SELECT pg_blocking_pids($1)::int[] AS b`, [pid])).rows[0]).b;
}

describe('T-03 — first touch of a key, concurrently (P:155)', () => {
  it('T-03.1: B blocks on A’s uncommitted new key; after A commits, one cache row carries seq 1 and 2 and the serially simulated average', async () => {
    const K = await freshKey();
    const a = await session();
    const b = await session();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const ra = await applyAsApp(a, biz, [req(K, 'purchase', '2', { unitCost: '3' })]);
      expect(must(ra[0]).stock_seq).toBe('1');
      const pb = settle(() => applyAsApp(b, biz, [req(K, 'purchase', '4', { unitCost: '5.5' })]));
      const pidB = pidFor(b);
      await waitUntilBlocked(pidB, 'B on the first touch of K');
      expect(await blockers(pidB)).toEqual([pidFor(a)]);
      await a.query('COMMIT');
      const rb = expectAccepted(await pb, 'B after A commits');
      await b.query('COMMIT');
      expect(must(rb[0]).stock_seq).toBe('2');

      const first = simulateMovement(EMPTY_STOCK_STATE, { kind: 'purchase', qtyQ4: parseQuantity('2'), costC10: parseUnitCost('3'), value: null });
      const second = simulateMovement(first.next, { kind: 'purchase', qtyQ4: parseQuantity('4'), costC10: parseUnitCost('5.5'), value: null });
      expect(await levelOf(ownerPool(), biz.businessId, K)).toEqual({
        on_hand: formatQuantity(second.next.onHand),
        valuation_base_minor: formatMinor(second.next.valuation),
        avg_unit_cost_base_minor: formatUnitCost(must(second.next.avg)),
        last_stock_seq: '2',
      });
      expect(
        must(
          (
            await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2`, [
              biz.businessId,
              K.warehouseId,
            ])
          ).rows[0],
        ).n,
      ).toBe(1);
      expect((await movementsOf(ownerPool(), biz.businessId, K)).map((m) => m.stock_seq)).toEqual(['1', '2']);
    } finally {
      await close(a, b);
    }
  });

  it('T-03.2: A rolls back its first touch; B, which waited, gets stock_seq 1 and last_stock_seq = 1', async () => {
    const K = await freshKey();
    const a = await session();
    const b = await session();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await applyAsApp(a, biz, [req(K, 'purchase', '2', { unitCost: '3' })]);
      const pb = settle(() => applyAsApp(b, biz, [req(K, 'purchase', '4', { unitCost: '5' })]));
      await waitUntilBlocked(pidFor(b), 'B behind A');
      await a.query('ROLLBACK');
      const rb = expectAccepted(await pb, 'B after A rolls back');
      await b.query('COMMIT');
      expect(must(rb[0]).stock_seq).toBe('1');
      expect(await levelOf(ownerPool(), biz.businessId, K)).toEqual({
        on_hand: '4.0000',
        valuation_base_minor: '20',
        avg_unit_cost_base_minor: '5.0000000000',
        last_stock_seq: '1',
      });
    } finally {
      await close(a, b);
    }
  });

  it('T-03.3: the same five-part identity from both sides — the loser gets inventory.movement_identity_conflict (never 23505) and the sequence has no gap', async () => {
    const K = await freshKey();
    const a = await session();
    const b = await session();
    const same = req(K, 'purchase', '2', { unitCost: '3' });
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await applyAsApp(a, biz, [same]);
      const pb = settle(() => applyAsApp(b, biz, [{ ...same, qty: '5' }]));
      await waitUntilBlocked(pidFor(b), 'B behind A on the same identity');
      await a.query('COMMIT');
      expectRefused(await pb, 'P0001', 'inventory.movement_identity_conflict', 'the loser');
      await b.query('ROLLBACK');
      expect((await movementsOf(ownerPool(), biz.businessId, K)).map((m) => [m.stock_seq, m.qty_delta])).toEqual([['1', '2.0000']]);
      expect(must(await levelOf(ownerPool(), biz.businessId, K)).last_stock_seq).toBe('1');
      // And the next writer continues gaplessly.
      await commitApply([req(K, 'purchase', '1', { unitCost: '3' })]);
      expect(await verifyNow(K)).toBe(true);
    } finally {
      await close(a, b);
    }
  });

  it('T-03.N: a read-modify-write of the cache WITHOUT the locking read loses an update (1 + 5 + 7 ends at 8)', async () => {
    const K = await freshKey();
    await commitApply([req(K, 'purchase', '1', { unitCost: '1' })]);
    const gate = await session();
    const a = await session();
    const b = await session();
    const gateA = 0x5703_0001;
    const gateB = 0x5703_0002;
    try {
      await gate.query('SELECT pg_advisory_lock($1), pg_advisory_lock($2)', [gateA, gateB]);
      await a.query('BEGIN');
      await b.query('BEGIN');
      const unlocked = (c: Client, qty: string, g: number) =>
        settle(() => c.query(`SELECT stock_fixture_unlocked_add($1, $2, $3, $4::numeric, $5)`, [biz.businessId, K.warehouseId, K.variantId, qty, g]));
      const pa = unlocked(a, '5', gateA);
      await waitUntilBlocked(pidFor(a), 'A parked between its read and its write');
      const pb = unlocked(b, '7', gateB);
      await waitUntilBlocked(pidFor(b), 'B parked between its read and its write');
      // Both have read on_hand = 1. A writes and commits; then B writes its stale sum.
      await gate.query('SELECT pg_advisory_unlock($1)', [gateA]);
      expectAccepted(await pa, 'A');
      await a.query('COMMIT');
      await gate.query('SELECT pg_advisory_unlock($1)', [gateB]);
      expectAccepted(await pb, 'B');
      await b.query('COMMIT');
      expect(must(await levelOf(ownerPool(), biz.businessId, K)).on_hand).toBe('8.0000');
      expect(await verifyNow(K)).toBe(false);
    } finally {
      await close(a, b, gate);
    }
  });
});

describe('T-04 — opposite multi-key commands (P:156)', () => {
  it('T-04.1: 50 rounds of opposite K1→K2 / K2→K1 transfers on two connections, started together: never 40P01, stock conserved, both keys verify', async () => {
    const K1 = await freshKey();
    const K2 = await freshKey();
    await commitApply([req(K1, 'purchase', '100', { unitCost: '2' }), req(K2, 'purchase', '100', { unitCost: '3' })]);
    const a = await session();
    const b = await session();
    const transfer = async (c: Client, from: Key, to: Key) => {
      const ids = { sourceId: randomUUID(), sourceLineId: randomUUID() };
      await c.query('BEGIN');
      try {
        await applyAsApp(c, biz, [req(from, 'transfer_out', '-1', ids), req(to, 'transfer_in', '1', ids)]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    };
    try {
      for (let round = 0; round < 50; round += 1) {
        const [x, y] = await Promise.all([settle(() => transfer(a, K1, K2)), settle(() => transfer(b, K2, K1))]);
        expectAccepted(x, `round ${round} A`);
        expectAccepted(y, `round ${round} B`);
      }
      const l1 = must(await levelOf(ownerPool(), biz.businessId, K1));
      const l2 = must(await levelOf(ownerPool(), biz.businessId, K2));
      expect({ k1: l1.on_hand, k2: l2.on_hand, seq1: l1.last_stock_seq, seq2: l2.last_stock_seq }).toEqual({
        k1: '100.0000',
        k2: '100.0000',
        seq1: '101',
        seq2: '101',
      });
      expect(BigInt(l1.valuation_base_minor) + BigInt(l2.valuation_base_minor)).toBe(500n);
      expect(await verifyNow(K1)).toBe(true);
      expect(await verifyNow(K2)).toBe(true);
    } finally {
      await close(a, b);
    }
  });

  it('T-04.2: with K_min held by a third connection, a call whose payload lists K_max first blocks — and K_max is still free (NOWAIT succeeds): the payload order is not the lock order', async () => {
    const X = await freshKey();
    const Y = await freshKey();
    await commitApply([req(X, 'purchase', '5', { unitCost: '1' }), req(Y, 'purchase', '5', { unitCost: '1' })]);
    const [kMin, kMax] = X.warehouseId < Y.warehouseId ? [X, Y] : [Y, X];
    const holder = await session();
    const a = await session();
    const probe = await session();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 FOR UPDATE`, [
        biz.businessId,
        kMin.warehouseId,
        kMin.variantId,
      ]);
      await a.query('BEGIN');
      const ids = { sourceId: randomUUID(), sourceLineId: randomUUID() };
      const pa = settle(() => applyAsApp(a, biz, [req(kMax, 'transfer_out', '-1', ids), req(kMin, 'transfer_in', '1', ids)]));
      const pidA = pidFor(a);
      await waitUntilBlocked(pidA, 'A behind the holder of K_min');
      expect(await blockers(pidA)).toEqual([pidFor(holder)]);
      await probe.query('BEGIN');
      const nowait = await settle(() =>
        probe.query(`SELECT 1 FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 FOR UPDATE NOWAIT`, [
          biz.businessId,
          kMax.warehouseId,
          kMax.variantId,
        ]),
      );
      expectAccepted(nowait, 'K_max is not locked while A waits for K_min');
      await probe.query('ROLLBACK');
      await holder.query('ROLLBACK');
      expectAccepted(await pa, 'A after the holder lets go');
      await a.query('ROLLBACK');
    } finally {
      await close(holder, a, probe);
    }
  });

  it('T-04.3: no inventory migration or inventory API module handles 40P01 / deadlock_detected (rule 21, static)', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    const migrations = join(root, 'infrastructure', 'database', 'migrations');
    for (const f of readdirSync(migrations)) if (f.includes('inventory') && f.endsWith('.sql')) files.push(join(migrations, f));
    walk(join(root, 'apps', 'api', 'src', 'modules', 'inventory'));
    const DEADLOCK = /40P01|deadlock_detected/i;
    expect(files.some((f) => f.endsWith('0060_inventory_stock_primitive.sql'))).toBe(true);
    expect(files.filter((f) => DEADLOCK.test(readFileSync(f, 'utf8')))).toEqual([]);
    // The scanner itself is live: a planted handler is found.
    expect(DEADLOCK.test(`EXCEPTION WHEN deadlock_detected THEN RETRY;`)).toBe(true);
  });

  it('T-04.N: locking the keys in PAYLOAD order (the control routine) deadlocks two opposite commands — 40P01', async () => {
    const X = await freshKey();
    const Y = await freshKey();
    const gate = await session();
    const a = await session();
    const b = await session();
    const gateA = 0x5704_0001;
    const gateB = 0x5704_0002;
    try {
      await gate.query('SELECT pg_advisory_lock($1), pg_advisory_lock($2)', [gateA, gateB]);
      await a.query('BEGIN');
      await b.query('BEGIN');
      const inPayloadOrder = (c: Client, first: Key, second: Key, g: number) =>
        settle(() =>
          c.query(`SELECT stock_fixture_lock_in_payload_order($1, $2, $3::uuid[], $4::uuid[], $5)`, [
            biz.tenantId,
            biz.businessId,
            [first.warehouseId, second.warehouseId],
            [first.variantId, second.variantId],
            g,
          ]),
        );
      const pa = inPayloadOrder(a, X, Y, gateA);
      await waitUntilBlocked(pidFor(a), 'A holds X, parked at its gate');
      const pb = inPayloadOrder(b, Y, X, gateB);
      await waitUntilBlocked(pidFor(b), 'B holds Y, parked at its gate');
      await gate.query('SELECT pg_advisory_unlock($1), pg_advisory_unlock($2)', [gateA, gateB]);
      const outcomes = await Promise.all([pa, pb]);
      const failed = outcomes.filter((o) => !o.ok);
      expect(failed).toHaveLength(1);
      expectRefused(must(failed[0]), '40P01', null, 'payload-order locking');
    } finally {
      await close(a, b, gate);
    }
  });
});

describe('T-06.6 — verification against a live writer', () => {
  it('verify waits for an uncommitted movement on the key, then matches the committed state including it', async () => {
    const K = await freshKey();
    await commitApply([req(K, 'purchase', '3', { unitCost: '2' })]);
    const a = await session();
    const v = await session();
    try {
      await a.query('BEGIN');
      await applyAsApp(a, biz, [req(K, 'damage', '-1', { reason: 'live writer' })]);
      await v.query('BEGIN');
      const pv = settle(() => verify(v, biz, K));
      await waitUntilBlocked(pidFor(v), 'verify behind the live writer');
      await a.query('COMMIT');
      const r = expectAccepted(await pv, 'verify');
      await v.query('ROLLBACK');
      expect({ matches: r.matches, seq: r.cache_last_seq, rebuiltSeq: r.rebuilt_last_seq, onHand: r.cache_on_hand }).toEqual({
        matches: true,
        seq: '2',
        rebuiltSeq: '2',
        onHand: '2.0000',
      });
    } finally {
      await close(a, v);
    }
  });
});

describe('T-17.11 — the first movement racing a configuration change (A-23)', () => {
  /** A fresh kg/4 product, so a quantity of 1.5 is valid now and invalid at piece/0. */
  async function kgProduct(): Promise<Key> {
    const p = await addTrackedProduct(ownerPool(), biz, 'kg', 4);
    return { warehouseId: biz.warehouse1, variantId: p.variantId };
  }
  async function productOf(variantId: string): Promise<string> {
    return must((await ownerPool().query<{ p: string }>(`SELECT product_id::text AS p FROM product_variants WHERE id = $1`, [variantId])).rows[0]).p;
  }
  const configure = (c: Client, cfg: ConfigureCall) => settle(() => configureAsApp(c, biz, cfg));

  it('movement first, then a unit change: the change waits on the product lock and is refused (inventory.unit_identity_locked)', async () => {
    const K = await kgProduct();
    const productId = await productOf(K.variantId);
    const a = await session();
    const b = await session();
    try {
      await a.query('BEGIN');
      await applyAsApp(a, biz, [req(K, 'purchase', '1.5', { unitCost: '2' })]);
      await b.query('BEGIN');
      const pb = configure(b, { productId, track: true, unitCode: 'piece', unitDecimals: 0 });
      await waitUntilBlocked(pidFor(b), 'the unit change behind the first movement');
      await a.query('COMMIT');
      expectRefused(await pb, 'P0001', 'inventory.unit_identity_locked', 'the change after the movement');
      await b.query('ROLLBACK');
      expect(must((await ownerPool().query<{ u: string }>(`SELECT unit_code AS u FROM products WHERE id = $1`, [productId])).rows[0]).u).toBe('kg');
    } finally {
      await close(a, b);
    }
  });

  it('unit change first, then the movement: the movement waits on the product lock and is judged under the NEW unit (inventory.quantity_precision_invalid)', async () => {
    const K = await kgProduct();
    const productId = await productOf(K.variantId);
    const a = await session();
    const b = await session();
    try {
      await b.query('BEGIN');
      expectAccepted(await configure(b, { productId, track: true, unitCode: 'piece', unitDecimals: 0 }), 'the change');
      await a.query('BEGIN');
      const pa = settle(() => applyAsApp(a, biz, [req(K, 'purchase', '1.5', { unitCost: '2' })]));
      await waitUntilBlocked(pidFor(a), 'the first movement behind the unit change');
      await b.query('COMMIT');
      expectRefused(await pa, 'P0001', 'inventory.quantity_precision_invalid', 'the movement after the change');
      await a.query('ROLLBACK');
      expect(await levelOf(ownerPool(), biz.businessId, K)).toBeNull();
    } finally {
      await close(a, b);
    }
  });

  it('movement first, then disabling tracking: the disable waits and is refused (inventory.tracking_disable_requires_zero_stock)', async () => {
    const K = await kgProduct();
    const productId = await productOf(K.variantId);
    const a = await session();
    const b = await session();
    try {
      await a.query('BEGIN');
      await applyAsApp(a, biz, [req(K, 'purchase', '1.5', { unitCost: '2' })]);
      await b.query('BEGIN');
      const pb = configure(b, { productId, track: false, unitCode: null, unitDecimals: null });
      await waitUntilBlocked(pidFor(b), 'the disable behind the first movement');
      await a.query('COMMIT');
      expectRefused(await pb, 'P0001', 'inventory.tracking_disable_requires_zero_stock', 'the disable after the movement');
      await b.query('ROLLBACK');
    } finally {
      await close(a, b);
    }
  });

  it('disabling first, then the movement: the movement waits and is refused (inventory.product_not_tracked)', async () => {
    const K = await kgProduct();
    const productId = await productOf(K.variantId);
    const a = await session();
    const b = await session();
    try {
      await b.query('BEGIN');
      expectAccepted(await configure(b, { productId, track: false, unitCode: null, unitDecimals: null }), 'the disable');
      await a.query('BEGIN');
      const pa = settle(() => applyAsApp(a, biz, [req(K, 'purchase', '1.5', { unitCost: '2' })]));
      await waitUntilBlocked(pidFor(a), 'the movement behind the disable');
      await b.query('COMMIT');
      expectRefused(await pa, 'P0001', 'inventory.product_not_tracked', 'the movement after the disable');
      await a.query('ROLLBACK');
    } finally {
      await close(a, b);
    }
  });

  it('T-17.11.N: with the primitive’s products FOR SHARE removed (in the movement’s own transaction, restored before its COMMIT), the unit change does not wait and BOTH commit — history reinterpreted', async () => {
    const K = await kgProduct();
    const productId = await productOf(K.variantId);
    const a = await session();
    const b = await session();
    const R3 = 'inventory_apply_stock_movements(inventory_movement_request[])';
    try {
      await a.query('BEGIN');
      const def = must((await a.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [R3])).rows[0]).d;
      const productLock = /(FROM products p\s+WHERE p\.business_id = v_business AND p\.id = ANY \(v_products\)\s+ORDER BY p\.id\s+)FOR SHARE/g;
      expect(def.match(productLock), 'the primitive locks products FOR SHARE in exactly one statement').toHaveLength(1);
      await a.query(def.replace(productLock, '$1'));
      await applyAsApp(a, biz, [req(K, 'purchase', '1.5', { unitCost: '2' })]);
      // Restore the real primitive inside A before anything commits.
      await a.query(def);
      await b.query('BEGIN');
      const changed = await configure(b, { productId, track: true, unitCode: 'piece', unitDecimals: 0 });
      expectAccepted(changed, 'the unit change did not wait for the uncommitted first movement');
      await b.query('COMMIT');
      await a.query('COMMIT');
      const r = await ownerPool().query<{ u: string; d: number; n: number }>(
        `SELECT p.unit_code AS u, p.unit_decimals AS d, (SELECT count(*)::int FROM stock_movements m WHERE m.variant_id = $2) AS n FROM products p WHERE p.id = $1`,
        [productId, K.variantId],
      );
      // A 1.5 movement now sits under a 0-decimal unit: exactly what the lock prevents.
      expect(r.rows).toEqual([{ u: 'piece', d: 0, n: 1 }]);
      const live = must((await ownerPool().query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [R3])).rows[0]).d;
      expect(live).toBe(def);
    } finally {
      await close(a, b);
    }
  });
});

describe('M-1 — READ COMMITTED only: the reviewer’s REPEATABLE READ reproduction', () => {
  const CONFIGURE = 'inventory_configure_product(uuid,boolean,text,smallint)';
  const R7 = 'products_20_unit_history_lock()';
  const movementsSeenBy = async (c: Queryable, variantId: string): Promise<number> =>
    must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1`, [variantId])).rows[0]).n;
  const unitOf = async (productId: string): Promise<string> =>
    must((await ownerPool().query<{ u: string }>(`SELECT unit_code AS u FROM products WHERE id = $1`, [productId])).rows[0]).u;

  it('T1 at REPEATABLE READ takes its snapshot, T2 at READ COMMITTED commits the first purchase, T1’s unit change → inventory.isolation_unsupported', async () => {
    const p = await addTrackedProduct(ownerPool(), biz, 'piece', 0);
    const K = { warehouseId: biz.warehouse1, variantId: p.variantId };
    const t1 = await session();
    try {
      await t1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      expect(await movementsSeenBy(t1, p.variantId), 'T1’s snapshot, taken before T2').toBe(0);
      await commitApply([req(K, 'purchase', '1', { unitCost: '1' })]);
      expect(await movementsSeenBy(t1, p.variantId), 'T1 still cannot see T2’s committed movement').toBe(0);
      const o = await settle(() => configureAsApp(t1, biz, { productId: p.productId, track: true, unitCode: 'kg', unitDecimals: null }));
      expectRefused(o, 'P0001', 'inventory.isolation_unsupported', 'the RR unit change after a committed first movement');
      await t1.query('ROLLBACK');
      expect(await unitOf(p.productId)).toBe('piece');
    } finally {
      await close(t1);
    }
  });

  it('M-1.N: the same interleaving with the isolation refusals of the configure command and R7 removed (in T1 only) — T1’s history check misses the committed movement and the unit change is ACCEPTED', async () => {
    const p = await addTrackedProduct(ownerPool(), biz, 'piece', 0);
    const K = { warehouseId: biz.warehouse1, variantId: p.variantId };
    const t1 = await session();
    try {
      await t1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await withoutRefusal(t1, CONFIGURE, 'inventory.isolation_unsupported');
      await withoutRefusal(t1, R7, 'inventory.isolation_unsupported');
      expect(await movementsSeenBy(t1, p.variantId), 'T1’s snapshot, taken before T2').toBe(0);
      await commitApply([req(K, 'purchase', '1', { unitCost: '1' })]);
      const r = expectAccepted(
        await settle(() => configureAsApp(t1, biz, { productId: p.productId, track: true, unitCode: 'kg', unitDecimals: null })),
        'refusals removed',
      );
      // The committed movement is history; the lock would refuse this at READ COMMITTED.
      expect(r.unit_code).toBe('kg');
      expect(await movementsSeenBy(t1, p.variantId)).toBe(0);
      expect(await movementsSeenBy(ownerPool(), p.variantId)).toBe(1);
      await t1.query('ROLLBACK');
      expect(await unitOf(p.productId)).toBe('piece');
    } finally {
      await close(t1);
    }
  });
});

describe('H-1 — a variant reparent racing the first movement on it', () => {
  const R3 = 'inventory_apply_stock_movements(inventory_movement_request[])';
  const R9 = 'product_variants_20_stock_identity_lock()';

  /** Two tracked products (committed): the variant starts on `from`. */
  async function variantPair(): Promise<{ from: string; to: string; K: Key }> {
    const a = await addVariantProduct(ownerPool(), biz, 1);
    const b = await addVariantProduct(ownerPool(), biz, 1);
    return { from: a.productId, to: b.productId, K: { warehouseId: biz.warehouse1, variantId: must(a.variantIds[0]) } };
  }
  /** The reparent as daftar_app, raw, under the business scope, in the session's open transaction. */
  const reparent = (c: Client, variantId: string, toProductId: string) =>
    settle(async () => {
      await setScope(c, biz);
      await c.query('SET LOCAL ROLE daftar_app');
      const r = await c.query(`UPDATE product_variants SET product_id = $2 WHERE id = $1`, [variantId, toProductId]);
      await c.query('RESET ROLE');
      return r.rowCount;
    });
  const productOf = async (variantId: string): Promise<string> =>
    must((await ownerPool().query<{ p: string }>(`SELECT product_id::text AS p FROM product_variants WHERE id = $1`, [variantId])).rows[0]).p;

  it('reparent first (uncommitted): the purchase waits on the product lock and, after the reparent commits, is refused (inventory.variant_stock_identity_changed)', async () => {
    const t = await variantPair();
    const r = await session();
    const a = await session();
    try {
      await r.query('BEGIN');
      expect(expectAccepted(await reparent(r, t.K.variantId, t.to), 'the reparent, no stock yet')).toBe(1);
      await a.query('BEGIN');
      const pa = settle(() => applyAsApp(a, biz, [req(t.K, 'purchase', '1', { unitCost: '1' })]));
      await waitUntilBlocked(pidFor(a), 'the purchase behind the reparent');
      expect(await blockers(pidFor(a))).toEqual([pidFor(r)]);
      await r.query('COMMIT');
      expectRefused(await pa, 'P0001', 'inventory.variant_stock_identity_changed', 'the purchase after the reparent');
      await a.query('ROLLBACK');
      expect(await levelOf(ownerPool(), biz.businessId, t.K)).toBeNull();
      expect(await productOf(t.K.variantId)).toBe(t.to);
    } finally {
      await close(r, a);
    }
  });

  it('reparent first, control: with R3’s re-read refusal removed (in the purchase’s own transaction), the purchase is ACCEPTED for a variant that no longer belongs to the product it locked', async () => {
    const t = await variantPair();
    const r = await session();
    const a = await session();
    try {
      await r.query('BEGIN');
      expect(expectAccepted(await reparent(r, t.K.variantId, t.to), 'the reparent')).toBe(1);
      await a.query('BEGIN');
      await withoutRefusal(a, R3, 'inventory.variant_stock_identity_changed');
      const pa = settle(() => applyAsApp(a, biz, [req(t.K, 'purchase', '1', { unitCost: '1' })]));
      await waitUntilBlocked(pidFor(a), 'the purchase behind the reparent');
      await r.query('COMMIT');
      const rows = expectAccepted(await pa, 're-read refusal removed');
      expect(rows.map((x) => x.variant_id)).toEqual([t.K.variantId]);
      await a.query('ROLLBACK');
    } finally {
      await close(r, a);
    }
  });

  it('purchase first (uncommitted): the reparent waits on the product lock and, after the purchase commits, is refused (inventory.variant_stock_identity_locked)', async () => {
    const t = await variantPair();
    const a = await session();
    const r = await session();
    try {
      await a.query('BEGIN');
      await applyAsApp(a, biz, [req(t.K, 'purchase', '1', { unitCost: '1' })]);
      await r.query('BEGIN');
      const pr = reparent(r, t.K.variantId, t.to);
      await waitUntilBlocked(pidFor(r), 'the reparent behind the first purchase');
      expect(await blockers(pidFor(r))).toEqual([pidFor(a)]);
      await a.query('COMMIT');
      expectRefused(await pr, 'P0001', 'inventory.variant_stock_identity_locked', 'the reparent after the purchase');
      await r.query('ROLLBACK');
      expect(await productOf(t.K.variantId)).toBe(t.from);
    } finally {
      await close(a, r);
    }
  });

  it('purchase first, control: with R9’s FOR UPDATE on the product removed (in the reparent’s own transaction, restored before its COMMIT), the reparent does not wait, sees no key, and BOTH commit — a stocked variant on another product', async () => {
    const t = await variantPair();
    const a = await session();
    const r = await session();
    try {
      await a.query('BEGIN');
      await applyAsApp(a, biz, [req(t.K, 'purchase', '1', { unitCost: '1' })]);
      await r.query('BEGIN');
      const def = must((await r.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [R9])).rows[0]).d;
      const productLock = /(WHERE p\.business_id = OLD\.business_id AND p\.id = OLD\.product_id)\s+FOR UPDATE;/g;
      expect(def.match(productLock), 'R9 locks the product FOR UPDATE in exactly one statement').toHaveLength(1);
      await r.query(def.replace(productLock, '$1;'));
      expect(expectAccepted(await reparent(r, t.K.variantId, t.to), 'the reparent did not wait for the in-flight purchase')).toBe(1);
      await r.query(def);
      await r.query('COMMIT');
      await a.query('COMMIT');
      expect(await productOf(t.K.variantId)).toBe(t.to);
      expect(must(await levelOf(ownerPool(), biz.businessId, t.K)).on_hand).toBe('1.0000');
      const live = must((await ownerPool().query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [R9])).rows[0]).d;
      expect(live).toBe(def);
    } finally {
      await close(a, r);
    }
  });
});
