/**
 * P3-S8 T-09 — THE REBUILD SWAP, REHEARSED AT TIER 1 SCALE
 * (docs/PHASE_3_S8_CONTRACT.md A-13 steps 1–7, A-17 D-LEDGER; TL-1; L:1232-1237).
 *
 * The swap is an operated incident procedure, not a product surface:
 * `infrastructure/database/procedures/stock-rebuild-swap.sql.template`,
 * instantiated for named keys and applied by `daftar_migrator` through the
 * real migration runner as a throwaway migration file. This suite rehearses
 * it in a scratch database built from the real migrations (the deployment
 * shape CI uses: objects owned by the applier, `daftar_migrator` holding
 * only what bootstrap gives it; the runner's own bookkeeping table is granted
 * to it so it can record the file):
 *
 *   D-LEDGER — 60,000 movements over 6,000 keys (2,000 tracked variants × 3
 *   warehouses, ten movements a key: purchases, damage, adjustments up and
 *   down, a stocktake count, a supplier return), through the REAL primitive
 *   via the S2 fixture producer. It carries no GL (A-17), so R-INV-01 does
 *   not apply to it; R-INV-02/03/04/05 and fold/verify do.
 *   G — a business built through the real commands and their entries, where
 *   all five checks apply; it carries the concurrency controls.
 *
 *   1. Clean verify: every key of both verifies; the checks are ok.
 *   2. Drift: the superuser plants cache drift on 25 keys — ±1 minor on the
 *      valuation, ±0.0001 on on_hand, last_stock_seq off by one, and one
 *      level row stating a sequence for a key with no movement.
 *   3. Detection: verify reports exactly those 25 keys and R-INV-02 exactly
 *      their 25 variants; nothing else, and no amount.
 *   4. Swap: the template for the 25 keys, as daftar_migrator, through the
 *      real runner.
 *   5. Green: verify and the checks are ok; the movement ledger (and every
 *      other truth table, the journal and the logs) is byte-identical; only
 *      the stock_levels rows of the 25 keys changed.
 *   6. CONCURRENCY NEGATIVE CONTROL (on G, one drifted key): a live
 *      inventory.adjust interleaved between the fold and the UPDATE. With the
 *      template's `FOR UPDATE` removed the adjust does not wait, commits
 *      inside the swap's window, the swap's own re-verify refuses
 *      (`inventory.migration_end_state_invalid`) and the key stays red. With
 *      the lock the adjust waits on the key, the swap commits, the adjust
 *      then commits on the rebuilt row, and the key verifies.
 *   7. AUTHORITY NEGATIVE CONTROL: the template's UPDATE is refused 42501
 *      for every runtime credential and for the migrator without
 *      `SET LOCAL ROLE`; the whole template is refused for every runtime
 *      credential (no membership in the internal principal).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatQuantity, formatUnitCost } from '../../packages/inventory/src';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { ensurePostgres } from '../helpers/test-app';
import { adjustCommand, seedS3World, type S3Business } from '../helpers/inventory-commands';
import { runFinancial, stockUp } from '../helpers/inventory-posting';
import {
  addWarehouse,
  applyAsApp,
  installStockFixture,
  must,
  req,
  seedStockBusiness,
  settle,
  waitUntilBlocked,
  type Key,
  type MovementRequest,
  type StockBusiness,
} from '../helpers/stock-ledger';
import { createScratchDb, migrationFiles, type ScratchDb, type ScratchRole } from '../helpers/scratch-db';
import { JOURNAL_AND_LOGS, changedTables, tableDigest } from '../helpers/table-digest';
import { truthTables } from '../helpers/phase3-surface';
import { resultOf, runChecks, statuses, type CheckList } from '../helpers/inventory-reconciliation';

const TEMPLATE_PATH = join(__dirname, '../../infrastructure/database/procedures/stock-rebuild-swap.sql.template');
const PLACEHOLDER = '/*@STOCK_KEYS@*/';
const VARIANTS = 2000;
const ROUNDS = 10;
const BATCH = 1500;
const DRIFTED = 25;
const RUNTIME: readonly ScratchRole[] = [
  'daftar_app',
  'daftar_identity',
  'daftar_platform',
  'daftar_provisioner',
  'daftar_reconciler',
  'daftar_resolver',
  'daftar_worker',
];
/** R-INV-01 compares movements with GL(Inventory); D-LEDGER has no GL by construction (A-17). */
const LEDGER_CHECKS: CheckList = ['R-INV-02', 'R-INV-03', 'R-INV-04', 'R-INV-05'];
const ALL_OK = { 'R-INV-01': 'ok', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' };
const LEDGER_OK = { 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' };

interface FullKey extends Key {
  readonly businessId: string;
}

let db: ScratchDb;
let D: StockBusiness;
let G: S3Business;
let keys: FullKey[];
let lonely: FullKey;
let drifted: FullKey[];
let swapNo = 0;

const keyText = (k: FullKey): string => `${k.businessId}/${k.warehouseId}/${k.variantId}`;

async function connect(role: ScratchRole = 'postgres'): Promise<Client> {
  const c = new Client({ connectionString: db.url(role) });
  await c.connect();
  return c;
}

async function committed<T>(fn: (c: Client) => Promise<T>, o: { readonly replica?: boolean } = {}): Promise<T> {
  const c = await connect();
  try {
    await c.query('BEGIN');
    if (o.replica === true) await c.query(`SET LOCAL session_replication_role = replica`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** The keys of `biz` whose cache row does not verify (R6 over every level row, as the superuser under the business's scope). */
async function unverified(biz: { tenantId: string; businessId: string }): Promise<string[]> {
  return committed(async (c) => {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [biz.tenantId, biz.businessId]);
    const r = await c.query<{ k: string }>(
      `SELECT l.business_id || '/' || l.warehouse_id || '/' || l.variant_id AS k
         FROM stock_levels l CROSS JOIN LATERAL inventory_stock_verify(l.business_id, l.warehouse_id, l.variant_id) v
        WHERE l.business_id = $1 AND NOT v.matches ORDER BY 1`,
      [biz.businessId],
    );
    return r.rows.map((x) => x.k);
  });
}

async function levelCount(businessId: string): Promise<number> {
  return Number(must((await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_levels WHERE business_id = $1`, [businessId])).rows[0]).n);
}

/** The template with the placeholder replaced by `ks` (and nothing else changed), optionally edited by `edit`. */
function instantiate(ks: readonly FullKey[], edit: (sql: string) => string = (s) => s): string {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  expect(template.split(PLACEHOLDER).length - 1, 'the placeholder occurs exactly once').toBe(1);
  const rows = ks.map((k) => `           ('${k.businessId}', '${k.warehouseId}', '${k.variantId}')`).join(',\n');
  return edit(template.replace(PLACEHOLDER, rows));
}

/** Apply `sql` as the throwaway migration `9NNN_rebuild_swap_rehearsal.sql` through the real runner, as `daftar_migrator`. */
async function applySwap(sql: string): Promise<string[]> {
  swapNo += 1;
  const name = `9${String(swapNo).padStart(3, '0')}_rebuild_swap_rehearsal.sql`;
  const dir = mkdtempSync(join(tmpdir(), 'daftar-t09-swap-'));
  try {
    for (const f of migrationFiles()) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    writeFileSync(join(dir, name), sql);
    return await runMigrations(db.url('daftar_migrator'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The pid of the migrator's backend once it waits on a lock (the swap parked at the gate). */
async function parkedMigrator(): Promise<number> {
  for (let i = 0; i < 600; i += 1) {
    const r = await db.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND usename = 'daftar_migrator' AND wait_event_type = 'Lock' AND state = 'active'`,
    );
    const pid = r.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the swap never parked at the gate');
}

beforeAll(async () => {
  await ensurePostgres();
  db = await createScratchDb('daftar_p3s8_t09');
  await db.pool.query(`GRANT SELECT, INSERT ON schema_migrations TO daftar_migrator`);
  await committed((c) => installStockFixture(c));

  // ── D-LEDGER: 2,000 tracked variants (+1 never moved) × 3 warehouses ──
  D = await seedStockBusiness(db.pool, 't09');
  const w3 = await addWarehouse(db.pool, D.businessId, D.branchId, 'Third WH');
  const warehouses = [D.warehouse1, D.warehouse2, w3];
  const variants = await committed(async (c) => {
    const products = (
      await c.query<{ id: string }>(
        `INSERT INTO products (business_id, id, base_price_minor, price_currency) SELECT $1, gen_random_uuid(), 1000, 'ILS' FROM generate_series(1, $2::int) RETURNING id::text`,
        [D.businessId, VARIANTS + 1],
      )
    ).rows.map((r) => r.id);
    await c.query(
      `INSERT INTO product_translations (business_id, product_id, locale, name) SELECT $1, p, 'en', 'D-LEDGER product' FROM unnest($2::uuid[]) AS p`,
      [D.businessId, products],
    );
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [D.tenantId, D.businessId]);
    await c.query('SET LOCAL ROLE daftar_inventory_internal');
    await c.query(`UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE business_id = $1 AND id = ANY ($2::uuid[])`, [
      D.businessId,
      products,
    ]);
    const v = await c.query<{ id: string }>(
      `INSERT INTO product_variants (business_id, id, product_id, is_base)
       SELECT $1, gen_random_uuid(), p, true FROM unnest($2::uuid[]) WITH ORDINALITY AS t(p, n) ORDER BY n RETURNING id::text`,
      [D.businessId, products],
    );
    await c.query('RESET ROLE');
    return v.rows.map((r) => r.id);
  });
  expect(variants.length).toBe(VARIANTS + 1);
  const moved = variants.slice(0, VARIANTS);
  keys = moved.flatMap((variantId) => warehouses.map((warehouseId) => ({ businessId: D.businessId, warehouseId, variantId })));
  lonely = { businessId: D.businessId, warehouseId: D.warehouse1, variantId: must(variants[VARIANTS]) };

  // Ten movements a key, one round at a time; on_hand stays positive (10 + 5 − 2 + 3 − 1 − 1 − 1 + 4 − 1 + 2 = 18).
  const q = (n: bigint): string => formatQuantity(n * 10_000n);
  const cost = (i: number, r: number): string => formatUnitCost(BigInt(100 + ((i * 7 + r * 13) % 900)) * 10_000_000_000n + BigInt((i * 31 + r) % 10_000));
  const round = (k: FullKey, i: number, r: number): MovementRequest => {
    switch (r) {
      case 0:
        return req(k, 'purchase', q(10n), { unitCost: cost(i, r) });
      case 1:
        return req(k, 'purchase', q(5n), { unitCost: cost(i, r) });
      case 2:
        return req(k, 'damage', q(-2n), { reason: 'D-LEDGER damage' });
      case 3:
        return req(k, 'adjustment', q(3n), { unitCost: cost(i, r), reason: 'D-LEDGER gain' });
      case 4:
        return req(k, 'adjustment', q(-1n), { reason: 'D-LEDGER loss' });
      case 5:
        return req(k, 'stocktake', q(-1n));
      case 6:
        return req(k, 'supplier_return', q(-1n));
      case 7:
        return req(k, 'purchase', q(4n), { unitCost: cost(i, r) });
      case 8:
        return req(k, 'damage', q(-1n), { reason: 'D-LEDGER damage' });
      default:
        return req(k, 'purchase', q(2n), { unitCost: cost(i, r) });
    }
  };
  for (let r = 0; r < ROUNDS; r += 1) {
    await committed(async (c) => {
      for (let from = 0; from < keys.length; from += BATCH) {
        const batch = keys.slice(from, from + BATCH).map((k, j) => round(k, from + j, r));
        const rows = await applyAsApp(c, D, batch);
        expect(rows.length).toBe(batch.length);
      }
    });
  }

  // ── G: a business of the real commands (its GL exists), two keys ──
  G = (await seedS3World(db.pool, 't09g')).A;
  await committed(async (c) => {
    await stockUp(c, G, G.w1, [
      { variantId: G.piece.variantId, qty: '12', unitCost: '4' },
      { variantId: G.piece2.variantId, qty: '6', unitCost: '7.5' },
    ]);
  });
}, 600_000);

afterAll(async () => {
  await db.drop();
});

describe('T-09 the rebuild rehearsal (A-13 steps 1–5)', () => {
  it('1. clean verify: the dataset is at scale and every key of both businesses verifies; the checks are ok', async () => {
    const n = must(
      (
        await db.pool.query<{ m: string; k: string }>(
          `SELECT count(*)::text AS m, count(DISTINCT (warehouse_id, variant_id))::text AS k FROM stock_movements WHERE business_id = $1`,
          [D.businessId],
        )
      ).rows[0],
    );
    expect({ movements: Number(n.m), keys: Number(n.k) }).toEqual({ movements: 60_000, keys: 6_000 });
    expect(await levelCount(D.businessId)).toBe(6_000);
    expect(await unverified(D)).toEqual([]);
    expect(await unverified(G)).toEqual([]);
    const reconciler = db.poolAs('daftar_reconciler');
    expect(statuses(await runChecks(reconciler, { tenantId: D.tenantId, businessId: D.businessId }, LEDGER_CHECKS))).toEqual(LEDGER_OK);
    expect(statuses(await runChecks(reconciler, { tenantId: G.tenantId, businessId: G.businessId }))).toEqual(ALL_OK);
  });

  it('2–3. drift planted on 25 keys is detected exactly: verify names those keys, R-INV-02 their variants, nothing else and no amount', async () => {
    drifted = [...keys.filter((k, i) => i % 3 === Math.floor(i / 3) % 3).slice(0, DRIFTED - 1), lonely];
    expect(new Set(drifted.map((k) => k.variantId)).size, 'distinct variants').toBe(DRIFTED);
    await committed(
      async (c) => {
        const at = (k: FullKey): unknown[] => [k.businessId, k.warehouseId, k.variantId];
        const where = `WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`;
        for (const [i, k] of drifted.slice(0, DRIFTED - 1).entries()) {
          const sign = i % 2 === 0 ? '+' : '-';
          const set =
            i < 8
              ? `valuation_base_minor = valuation_base_minor ${sign} 1`
              : i < 16
                ? `on_hand = on_hand ${sign} 0.0001`
                : `last_stock_seq = last_stock_seq ${sign} 1`;
          const r = await c.query(`UPDATE stock_levels SET ${set} ${where}`, at(k));
          expect(r.rowCount).toBe(1);
        }
        // A level row that states a sequence for a key with no movement.
        await c.query(
          `INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq)
           VALUES ($1, $2, $3, $4, 0, 0, NULL, 1)`,
          [D.tenantId, lonely.businessId, lonely.warehouseId, lonely.variantId],
        );
      },
      { replica: true },
    );
    expect(await unverified(D)).toEqual(drifted.map(keyText).sort());
    const run = await runChecks(db.poolAs('daftar_reconciler'), { tenantId: D.tenantId, businessId: D.businessId }, LEDGER_CHECKS);
    expect(statuses(run)).toEqual({ ...LEDGER_OK, 'R-INV-02': 'discrepancy' });
    const r = resultOf(run, 'R-INV-02');
    expect(r.offendingCount).toBe(DRIFTED);
    const named = new Set(drifted.map((k) => k.variantId));
    expect(r.offendingIds.length).toBe(20);
    expect(r.offendingIds.filter((id) => !named.has(id))).toEqual([]);
    expect(Object.keys(r).sort()).toEqual([
      'businessId',
      'checkId',
      'completedAt',
      'correction',
      'durationMs',
      'offendingCount',
      'offendingIds',
      'startedAt',
      'status',
    ]);
  });

  it('4–5. the template, applied for the 25 keys as daftar_migrator through the real runner, makes every key verify; the ledger is byte-identical and only those 25 rows changed', async () => {
    expect(drifted.length).toBe(DRIFTED);
    const tables = [...(await truthTables(db.pool)), ...JOURNAL_AND_LOGS].filter((t) => t !== 'stock_levels');
    expect(tables).toContain('stock_movements');
    const rowsOf = async (): Promise<Map<string, string>> =>
      new Map(
        (
          await db.pool.query<{ k: string; d: string }>(
            `SELECT l.business_id || '/' || l.warehouse_id || '/' || l.variant_id AS k, md5(to_jsonb(l)::text) AS d FROM stock_levels l`,
          )
        ).rows.map((x) => [x.k, x.d]),
      );
    const before = await tableDigest(db.pool, tables);
    const levelsBefore = await rowsOf();

    const applied = await applySwap(instantiate(drifted));
    expect(applied).toEqual(['9001_rebuild_swap_rehearsal.sql']);

    expect(await unverified(D)).toEqual([]);
    const reconciler = db.poolAs('daftar_reconciler');
    expect(statuses(await runChecks(reconciler, { tenantId: D.tenantId, businessId: D.businessId }, LEDGER_CHECKS))).toEqual(LEDGER_OK);
    expect(statuses(await runChecks(reconciler, { tenantId: G.tenantId, businessId: G.businessId }))).toEqual(ALL_OK);
    expect(changedTables(before, await tableDigest(db.pool, tables)), 'the ledger, every other truth table, the journal and the logs').toEqual([]);
    const levelsAfter = await rowsOf();
    expect([...levelsAfter.keys()].sort()).toEqual([...levelsBefore.keys()].sort());
    const changed = [...levelsAfter.entries()].filter(([k, d]) => levelsBefore.get(k) !== d).map(([k]) => k);
    expect(changed.sort()).toEqual(drifted.map(keyText).sort());
  });
});

describe('T-09 CONCURRENCY NEGATIVE CONTROL — a live adjust between the fold and the UPDATE (A-13 step 6)', () => {
  const GATE = 7_309_001;

  /** Drift G's piece key by +1 on its valuation, as the superuser. */
  async function driftG(): Promise<FullKey> {
    const k = { businessId: G.businessId, warehouseId: G.w1, variantId: G.piece.variantId };
    await committed(
      async (c) => {
        await c.query(
          `UPDATE stock_levels SET valuation_base_minor = valuation_base_minor + 1 WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
          [k.businessId, k.warehouseId, k.variantId],
        );
      },
      { replica: true },
    );
    expect(await unverified(G)).toEqual([keyText(k)]);
    return k;
  }

  /** The template with a gate after the fold (so the test holds the swap there), and optionally without the key lock. */
  function gated(k: FullKey, withoutLock: boolean): string {
    return instantiate([k], (sql) => {
      const fold = 'FROM inventory_stock_fold(v_key.business_id, v_key.warehouse_id, v_key.variant_id) f;';
      expect(sql.split(fold).length - 1).toBe(1);
      let out = sql.replace(fold, `${fold}\n    PERFORM pg_advisory_xact_lock_shared(${GATE});`);
      if (withoutLock) {
        const lock = '\n       FOR UPDATE;';
        expect(out.split(lock).length - 1, 'the template takes the key lock exactly once').toBe(1);
        out = out.replace(lock, ';');
      }
      return out;
    });
  }

  /** One live inventory.adjust (a loss of one piece) on G's key, with its posting, committed on its own connection. */
  async function liveAdjust(onPid?: (pid: number) => void): Promise<void> {
    const c = await connect();
    try {
      if (onPid !== undefined) onPid(must((await c.query<{ p: number }>(`SELECT pg_backend_pid() AS p`)).rows[0]).p);
      await c.query('BEGIN');
      await runFinancial(c, G, await adjustCommand(c, G, G.w1, [{ variantId: G.piece.variantId, qty: '-1' }]));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      await c.end();
    }
  }

  it('without the template’s FOR UPDATE the adjust does not wait, commits inside the window, the swap refuses and the key stays red', async () => {
    const k = await driftG();
    const gate = await connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT pg_advisory_xact_lock($1)', [GATE]);
      const swap = settle(() => applySwap(gated(k, true)));
      await parkedMigrator();
      await liveAdjust();
      await gate.query('COMMIT');
      const o = await swap;
      expect(o.ok ? 'the swap committed' : o.message).toMatch(/^inventory\.migration_end_state_invalid: a stock key still differs from its ledger/);
    } finally {
      await gate.end();
    }
    expect(await unverified(G), 'the key stays red').toEqual([keyText(k)]);
  });

  it('with the lock the adjust waits on the key, the swap commits, the adjust commits on the rebuilt row, and every key verifies', async () => {
    const k = { businessId: G.businessId, warehouseId: G.w1, variantId: G.piece.variantId };
    expect(await unverified(G), 'still drifted from the control above').toEqual([keyText(k)]);
    const gate = await connect();
    let adjust: Promise<void> | null = null;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT pg_advisory_xact_lock($1)', [GATE]);
      const swap = applySwap(gated(k, false));
      await parkedMigrator();
      let pid = 0;
      adjust = liveAdjust((p) => {
        pid = p;
      });
      for (let i = 0; i < 100 && pid === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      await waitUntilBlocked(pid, 'the live adjust waits on the key the swap holds');
      await gate.query('COMMIT');
      expect((await swap).length).toBe(1);
      await adjust;
    } finally {
      await gate.end();
    }
    expect(await unverified(G)).toEqual([]);
    expect(statuses(await runChecks(db.poolAs('daftar_reconciler'), { tenantId: G.tenantId, businessId: G.businessId }))).toEqual(ALL_OK);
  });
});

describe('T-09 AUTHORITY NEGATIVE CONTROL — nobody but the internal principal writes the cache (A-13 step 7)', () => {
  it('the runtime credentials are exactly the ones probed', async () => {
    const r = await db.pool.query<{ r: string }>(
      `SELECT rolname::text AS r FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname <> 'daftar_migrator' ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.r)).toEqual([...RUNTIME]);
  });

  it('the template’s UPDATE is 42501 for every runtime credential and for the migrator without SET LOCAL ROLE; the whole template is refused for every runtime credential', async () => {
    const k = must(keys[0]);
    const update = `UPDATE stock_levels l SET on_hand = 1, valuation_base_minor = 1, avg_unit_cost_base_minor = 1, last_stock_seq = 1
                     WHERE l.business_id = $1 AND l.warehouse_id = $2 AND l.variant_id = $3`;
    for (const role of [...RUNTIME, 'daftar_migrator'] as const) {
      const c = await connect(role);
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [D.tenantId, D.businessId]);
        const o = await settle(() => c.query(update, [k.businessId, k.warehouseId, k.variantId]));
        await c.query('ROLLBACK');
        expect(o.ok ? 'accepted' : o.sqlstate, `${role}: the UPDATE`).toBe('42501');
        if (role !== 'daftar_migrator') {
          const whole = await settle(() => c.query(instantiate([k])));
          expect(whole.ok ? 'accepted' : whole.sqlstate, `${role}: the template`).toBe('42501');
        }
      } finally {
        await c.end();
      }
    }
    expect(await unverified(D)).toEqual([]);
  });
});
