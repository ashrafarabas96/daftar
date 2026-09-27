/**
 * P3-S8 T-07 — EACH PLANTED DEFECT FIRES EXACTLY ITS OWN CHECK
 * (docs/PHASE_3_S8_CONTRACT.md A-10 "Proof", §6.3 T-07; PM-01, PM-16,
 * PM-26, PM-27, PM-29, PM-31; PM:681).
 *
 * One scratch database built from the real migrations. Each defect gets its
 * own business, built through the real commands and their entries (all five
 * checks `ok` before the plant). The superuser then plants the defect with
 * `session_replication_role = replica` — every trigger and every foreign key
 * of the scratch database off for that transaction, the "deferred FKs dropped
 * in scratch" of A-10 — and R-INV-01..05 run as `daftar_reconciler`:
 *   - a level row's valuation nudged by one minor unit → R-INV-02 only;
 *   - one Inventory (1200) line and its counterpart raised by one unit (the
 *     entry still balances) → R-INV-01 only;
 *   - an emptied key made to carry value 1, consistently in the movement,
 *     the level and the GL → R-INV-03 only;
 *   - a rounding (6100) pair added to an inventory entry → R-INV-04 only;
 *   - a binding deleted (its movement orphaned), and a binding with no
 *     movement → R-INV-05 only.
 * Each names only identifiers: the variant, the business, the entry, the
 * movement or the binding's source line.
 *
 * TOLERANCE NEGATIVE CONTROL (PM:681): the R-INV-01 plants differ from the
 * truth by exactly +1 and −1. Both are `discrepancy`; a reconciler comparing
 * within ±1 would have answered `ok`.
 *
 * The reconciler cannot write: INSERT, UPDATE, DELETE and TRUNCATE on every
 * stock table are refused 42501 under business scope.
 */
import { randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres } from '../helpers/test-app';
import { damageCommand, must, seedS3Business, seedS3World, type S3Business } from '../helpers/inventory-commands';
import { runFinancial, stockUp } from '../helpers/inventory-posting';
import { expectRefused, settle } from '../helpers/stock-ledger';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { inventoryFigures, resultOf, runChecks, statuses, type CheckId } from '../helpers/inventory-reconciliation';

const ALL_OK: Record<string, string> = { 'R-INV-01': 'ok', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' };
const STOCK_TABLES = ['stock_movements', 'stock_levels', 'stock_source_bindings'] as const;

let scratch: ScratchDb;
let reconciler: Pool;
let owner: S3Business;
let label = 0;

/** `fn` in one committed superuser transaction on the scratch database. */
async function committed(fn: (c: Client) => Promise<void>, replica = false): Promise<void> {
  const c = new Client({ connectionString: scratch.url() });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (replica) await c.query(`SET LOCAL session_replication_role = replica`);
    await fn(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** A fresh business with stock at W1 (piece × 5 at 4, piece2 × 2 at 7.5), every check ok. */
async function stocked(): Promise<S3Business> {
  label += 1;
  const biz = await seedS3Business(scratch.pool, owner.tenantId, owner.userId, `t07-${label}`);
  await committed(async (c) => {
    await stockUp(c, biz, biz.w1, [
      { variantId: biz.piece.variantId, qty: '5', unitCost: '4' },
      { variantId: biz.piece2.variantId, qty: '2', unitCost: '7.5' },
    ]);
  });
  expect(statuses(await runChecks(reconciler, target(biz))), 'every check is ok before the plant').toEqual(ALL_OK);
  return biz;
}

const target = (b: S3Business): { tenantId: string; businessId: string } => ({ tenantId: b.tenantId, businessId: b.businessId });

/** Exactly `checkId` is a discrepancy, and its offending ids are `ids` (in any order). */
async function firesExactly(biz: S3Business, checkId: CheckId, ids: readonly string[]): Promise<void> {
  const run = await runChecks(reconciler, target(biz));
  expect(statuses(run)).toEqual({ ...ALL_OK, [checkId]: 'discrepancy' });
  const r = resultOf(run, checkId);
  expect([...r.offendingIds].sort()).toEqual([...ids].sort());
  expect(r.offendingCount).toBe(ids.length);
}

/** The entry id of the journal entry whose source is `sourceId`. */
async function entryOf(q: Pool | Client, businessId: string, sourceId: string): Promise<string> {
  return must(
    (await q.query<{ id: string }>(`SELECT id::text FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [businessId, sourceId])).rows[0],
    'the journal entry',
  ).id;
}

/** The entry of the business's one adjustment (the stock-up). */
async function stockUpEntry(biz: S3Business): Promise<string> {
  const r = await scratch.pool.query<{ id: string }>(`SELECT id::text FROM journal_entries WHERE business_id = $1 AND source_type = 'inventory_adjustment'`, [
    biz.businessId,
  ]);
  expect(r.rows.length, 'one adjustment entry').toBe(1);
  return must(r.rows[0]).id;
}

/**
 * Shift the entry's Inventory line by `delta` (GL(Inventory) moves by
 * `delta`) and one non-Inventory line by the opposite, so the entry still
 * balances. A domestic line keeps its txn amount equal to its base amount.
 */
async function shiftInventory(c: Client, businessId: string, entryId: string, delta: bigint): Promise<void> {
  const lines = (
    await c.query<{ id: string; system_key: string | null; debit_minor: string; credit_minor: string }>(
      `SELECT l.id::text, a.system_key, l.debit_minor::text, l.credit_minor::text
         FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
      [businessId, entryId],
    )
  ).rows;
  const inv = must(
    lines.find((l) => l.system_key === 'inventory'),
    'the Inventory line',
  );
  const other = must(
    lines.find((l) => l.system_key !== 'inventory'),
    'a counterpart line',
  );
  // net = debit − credit: raise the Inventory net by delta, lower the other's by delta.
  const move = async (id: string, debit: bigint, credit: bigint, netDelta: bigint): Promise<void> => {
    const [d, k] = debit > 0n ? [debit + netDelta, credit] : [debit, credit - netDelta];
    await c.query(
      `UPDATE journal_lines SET debit_minor = $3, credit_minor = $4, base_amount_minor = greatest($3::bigint, $4::bigint), txn_amount_minor = greatest($3::bigint, $4::bigint)
        WHERE business_id = $1 AND id = $2 AND txn_currency = base_currency`,
      [businessId, id, d.toString(), k.toString()],
    );
  };
  await move(inv.id, BigInt(inv.debit_minor), BigInt(inv.credit_minor), delta);
  await move(other.id, BigInt(other.debit_minor), BigInt(other.credit_minor), -delta);
}

beforeAll(async () => {
  await ensurePostgres();
  scratch = await createScratchDb('daftar_p3s8_t07');
  owner = (await seedS3World(scratch.pool, 't07')).A;
  reconciler = scratch.poolAs('daftar_reconciler');
}, 300_000);

afterAll(async () => {
  await scratch.drop();
});

describe('T-07 each planted defect fires exactly its own check, naming identifiers only', () => {
  it('R-INV-02: one level row’s valuation nudged by one minor unit names its variant and the business (the literal total)', async () => {
    const biz = await stocked();
    await committed(async (c) => {
      await c.query(
        `UPDATE stock_levels SET valuation_base_minor = valuation_base_minor + 1 WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
        [biz.businessId, biz.w1, biz.piece.variantId],
      );
    }, true);
    await firesExactly(biz, 'R-INV-02', [biz.piece.variantId, biz.businessId]);
  });

  it('R-INV-01: one Inventory line and its counterpart raised by one unit (the entry still balances) names the business', async () => {
    const biz = await stocked();
    const entry = await stockUpEntry(biz);
    await committed((c) => shiftInventory(c, biz.businessId, entry, 1n), true);
    const balance = must(
      (
        await scratch.pool.query<{ d: string }>(
          `SELECT (sum(debit_minor) - sum(credit_minor))::text AS d FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2`,
          [biz.businessId, entry],
        )
      ).rows[0],
    ).d;
    expect(balance, 'the planted entry still balances').toBe('0');
    await firesExactly(biz, 'R-INV-01', [biz.businessId]);
  });

  it('R-INV-03: an emptied key carrying value 1 — consistent in the movement, the level and the GL — names its variant', async () => {
    const biz = await stocked();
    const damage = await (async () => {
      const c = new Client({ connectionString: scratch.url() });
      await c.connect();
      try {
        await c.query('BEGIN');
        const cmd = await damageCommand(c, biz, biz.w1, [{ variantId: biz.piece2.variantId, qty: '2' }]);
        await runFinancial(c, biz, cmd);
        await c.query('COMMIT');
        return cmd.adjustmentId;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        await c.end();
      }
    })();
    expect(statuses(await runChecks(reconciler, target(biz))), 'emptied honestly: every check ok').toEqual(ALL_OK);
    const entry = await entryOf(scratch.pool, biz.businessId, damage);
    await committed(async (c) => {
      const moved = await c.query(
        `UPDATE stock_movements SET value_delta_base_minor = value_delta_base_minor + 1
          WHERE business_id = $1 AND source_id = $2 AND variant_id = $3`,
        [biz.businessId, damage, biz.piece2.variantId],
      );
      expect(moved.rowCount).toBe(1);
      await c.query(
        `UPDATE stock_levels SET valuation_base_minor = valuation_base_minor + 1 WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
        [biz.businessId, biz.w1, biz.piece2.variantId],
      );
      await shiftInventory(c, biz.businessId, entry, 1n);
    }, true);
    const f = await inventoryFigures(scratch.pool, biz.businessId);
    expect(f.gl, 'the plant is consistent: GL = Σ movements').toBe(f.movements);
    await firesExactly(biz, 'R-INV-03', [biz.piece2.variantId]);
  });

  it('R-INV-04: a rounding (6100) pair added to an inventory entry names the entry', async () => {
    const biz = await stocked();
    const entry = await stockUpEntry(biz);
    await committed(async (c) => {
      for (const [n, side] of [
        [1, 'debit'],
        [2, 'credit'],
      ] as const) {
        const r = await c.query(
          `INSERT INTO journal_lines (tenant_id, business_id, journal_entry_id, line_no, account_id, debit_minor, credit_minor, base_amount_minor,
                                      base_currency, txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at, branch_id, warehouse_id)
           SELECT l.tenant_id, l.business_id, l.journal_entry_id, (SELECT max(x.line_no) FROM journal_lines x WHERE x.business_id = l.business_id AND x.journal_entry_id = l.journal_entry_id) + 1,
                  (SELECT a.id FROM accounts a WHERE a.business_id = l.business_id AND a.system_key = 'rounding'),
                  $3::bigint, $4::bigint, 1, l.base_currency, l.txn_currency, 1, 1, 'base', l.fx_rate_at, l.branch_id, l.warehouse_id
             FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
            WHERE l.business_id = $1 AND l.journal_entry_id = $2 AND a.system_key = 'inventory'
            LIMIT 1`,
          [biz.businessId, entry, side === 'debit' ? 1 : 0, side === 'credit' ? 1 : 0],
        );
        expect(r.rowCount, `rounding line ${n}`).toBe(1);
      }
    }, true);
    await firesExactly(biz, 'R-INV-04', [entry]);
  });

  it('R-INV-05: a binding deleted orphans its movement, which is named', async () => {
    const biz = await stocked();
    const m = must(
      (
        await scratch.pool.query<{ id: string; source_type: string; source_id: string; source_line_id: string; movement_kind: string }>(
          `SELECT id::text, source_type, source_id::text, source_line_id::text, movement_kind FROM stock_movements WHERE business_id = $1 AND variant_id = $2`,
          [biz.businessId, biz.piece.variantId],
        )
      ).rows[0],
    );
    await committed(async (c) => {
      const r = await c.query(
        `DELETE FROM stock_source_bindings WHERE business_id = $1 AND source_type = $2 AND source_id = $3 AND source_line_id = $4 AND movement_kind = $5`,
        [biz.businessId, m.source_type, m.source_id, m.source_line_id, m.movement_kind],
      );
      expect(r.rowCount).toBe(1);
    }, true);
    await firesExactly(biz, 'R-INV-05', [m.id]);
  });

  it('R-INV-05: a binding with no movement is named by its source line', async () => {
    const biz = await stocked();
    const orphanLine = randomUUID();
    await committed(async (c) => {
      const r = await c.query(
        `INSERT INTO stock_source_bindings SELECT (jsonb_populate_record(b, jsonb_build_object('source_line_id', $2::uuid))).*
           FROM stock_source_bindings b WHERE b.business_id = $1 LIMIT 1`,
        [biz.businessId, orphanLine],
      );
      expect(r.rowCount).toBe(1);
    }, true);
    await firesExactly(biz, 'R-INV-05', [orphanLine]);
  });
});

describe('T-07 TOLERANCE NEGATIVE CONTROL — a planted ±1 is a discrepancy (PM:681)', () => {
  it('tolerance: GL(Inventory) one minor unit above, and one below, the movements are each a discrepancy — a difference a ±1 reconciler would call ok', async () => {
    for (const delta of [1n, -1n]) {
      const biz = await stocked();
      const entry = await stockUpEntry(biz);
      await committed((c) => shiftInventory(c, biz.businessId, entry, delta), true);
      const f = await inventoryFigures(scratch.pool, biz.businessId);
      expect(f.gl - f.movements, `planted ${delta}`).toBe(delta);
      await firesExactly(biz, 'R-INV-01', [biz.businessId]);
    }
  });
});

describe('T-07 the reconciler cannot write', () => {
  it('INSERT, UPDATE, DELETE and TRUNCATE on every stock table are refused 42501 under business scope', async () => {
    const biz = await stocked();
    const c = new Client({ connectionString: scratch.url('daftar_reconciler') });
    await c.connect();
    try {
      for (const t of STOCK_TABLES) {
        for (const [what, sql] of [
          ['INSERT', `INSERT INTO ${t} (business_id) VALUES ($1::uuid)`],
          ['UPDATE', `UPDATE ${t} SET business_id = business_id WHERE business_id = $1::uuid`],
          ['DELETE', `DELETE FROM ${t} WHERE business_id = $1::uuid`],
          ['TRUNCATE', `TRUNCATE ${t}`],
        ] as const) {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [biz.tenantId, biz.businessId]);
          const o = await settle(() => c.query(sql, what === 'TRUNCATE' ? [] : [biz.businessId]));
          await c.query('ROLLBACK');
          expectRefused(o, '42501', '', `${what} ${t}`);
        }
      }
    } finally {
      await c.end();
    }
  });
});
