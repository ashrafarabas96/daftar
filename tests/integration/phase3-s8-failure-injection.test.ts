/**
 * P3-S8 T-10 — FAILURE INJECTION ACROSS EVERY FINANCIAL KIND
 * (docs/PHASE_3_S8_CONTRACT.md A-15, §6.2 PM-10/PM-11; L:2003).
 *
 * Driven by the A-06 builders, restricted to `financial = true`: each kind's
 * COMPOSED command (its entry routine as `daftar_app`, then the entries the
 * service posts, in one transaction) is run in a scratch database built from
 * the real migrations, where scratch triggers raise on a named condition —
 * the transaction-local `app.t10_fault`:
 *   1. `domain`  — after the domain half and before the posting: at the
 *      first `stock_movements` insert (for S6, which moves no stock, at the
 *      first insert of its settlement document);
 *   2. `posting` — inside the posting: at the first `journal_lines` insert;
 *   3. `commit`  — at COMMIT: a deferred constraint trigger on
 *      `journal_entries`.
 * After each fault NOTHING survives: every truth table, the journal, the
 * accounting bindings and reversals, both assertion-use logs, audit and
 * outbox are byte-identical to before. Then the SAME inventory assertion,
 * re-presented within its TTL, commits exactly once (a third presentation is
 * `inventory.assertion_replayed`), and the document it wrote has its entry.
 *
 * NEGATIVE CONTROL (PM-10, the split seam of the S3 technique): with the
 * deferred binding key `inventory_adjustments_binding_fk` dropped, the stock
 * half of an adjustment commits on one connection while its posting, on a
 * second, is faulted. T-10's orphan detector then reports the adjustment,
 * and R-INV-01 reports the business.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres } from '../helpers/test-app';
import { adjustCommand, must, runCommand, seedS3Business, seedS3World, type Queryable, type S3Business } from '../helpers/inventory-commands';
import { adjustmentEntry, homeBranch, postEntryInTx, stockUp } from '../helpers/inventory-posting';
import { settle, type Outcome } from '../helpers/stock-ledger';
import { OP_KIND_BUILDERS, mintHonest, type OpKindBuilder, type PreparedKind, type ResultRow } from '../helpers/op-kind-builders';
import { truthTables } from '../helpers/phase3-surface';
import { JOURNAL_AND_LOGS, changedTables, tableDigest } from '../helpers/table-digest';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { resultOf, runChecks } from '../helpers/inventory-reconciliation';

const FINANCIAL = Object.values(OP_KIND_BUILDERS)
  .filter((b): b is OpKindBuilder => b !== undefined && b.financial)
  .map((b) => b.op)
  .sort();
const POINTS = ['domain', 'posting', 'commit'] as const;
type Point = (typeof POINTS)[number];

/** The settlement document each S6 kind inserts first (it moves no stock). */
const S6_DOCUMENT_TABLES = ['supplier_payments', 'supplier_credit_allocations', 'supplier_refunds'] as const;

const FAULTS_SQL = `
CREATE FUNCTION t10_fault() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $f$
BEGIN
  IF coalesce(current_setting('app.t10_fault', true), '') = TG_ARGV[0] THEN
    RAISE EXCEPTION 'injected_fault.%: injected at %', TG_ARGV[0], TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$f$;
CREATE TRIGGER t10_fault_domain AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION t10_fault('domain');
${S6_DOCUMENT_TABLES.map((t) => `CREATE TRIGGER t10_fault_domain AFTER INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION t10_fault('domain');`).join('\n')}
CREATE TRIGGER t10_fault_posting AFTER INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION t10_fault('posting');
CREATE CONSTRAINT TRIGGER t10_fault_commit AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION t10_fault('commit');
`;

let db: ScratchDb;
let owner: S3Business;
let other: S3Business;
let tables: string[];

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: db.url() });
  await c.connect();
  return c;
}

async function cashOf(q: Queryable, businessId: string): Promise<string> {
  const r = await q.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId]);
  return must(r.rows[0], 'cash account').id;
}

/**
 * The composed command on its own connection: the entry call as `daftar_app`
 * under the honest carrier, then its entries — one transaction, committed —
 * with the fault `point` armed (or none). Answers how many entries it posted.
 */
async function composed(biz: S3Business, p: PreparedKind, carrier: string, point: Point | null): Promise<Outcome<number>> {
  const c = await connect();
  try {
    return await settle(async () => {
      await c.query('BEGIN');
      try {
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
                  set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true),
                  set_config('app.t10_fault', $5, true)`,
          [biz.tenantId, biz.businessId, carrier, p.trace, point ?? ''],
        );
        await c.query('SET LOCAL ROLE daftar_app');
        const rows = (await c.query<ResultRow>(p.sql, [...p.params])).rows;
        await c.query('RESET ROLE');
        const posted = await p.post(c, rows);
        await c.query('COMMIT');
        return posted;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
  } finally {
    await c.end();
  }
}

/** Financial documents of `businessId` that carry stock movements but no journal entry: the orphans A-15 forbids. */
async function orphans(q: Queryable, businessId: string): Promise<string[]> {
  const r = await q.query<{ id: string }>(
    `SELECT DISTINCT m.source_id::text AS id
       FROM stock_movements m
      WHERE m.business_id = $1
        AND m.source_type IN ('inventory_adjustment', 'stocktake', 'inventory_opening', 'purchase', 'supplier_return', 'purchase_reversal')
        AND NOT EXISTS (SELECT 1 FROM accounting_source_bindings b WHERE b.business_id = m.business_id AND b.source_id = m.source_id)
        AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.business_id = m.business_id AND e.source_id = m.source_id)
      ORDER BY 1`,
    [businessId],
  );
  return r.rows.map((x) => x.id);
}

beforeAll(async () => {
  await ensurePostgres();
  db = await createScratchDb('daftar_p3s8_t10');
  const w = await seedS3World(db.pool, 't10');
  owner = w.A;
  other = w.A2;
  await db.pool.query(FAULTS_SQL);
  tables = [...(await truthTables(db.pool)), ...JOURNAL_AND_LOGS];
}, 300_000);

afterAll(async () => {
  await db.drop();
});

describe('T-10 the financial kinds are the builders’ own', () => {
  it('ten kinds post: every S3 posting kind, receipt, return, reversal and the three settlements', () => {
    expect(FINANCIAL).toEqual([
      'inventory.adjust',
      'inventory.damage',
      'inventory.opening',
      'inventory.stocktake_finalize',
      'purchase.receive',
      'purchase.return',
      'purchase.reverse',
      'supplier.allocate_credit',
      'supplier.pay',
      'supplier.receive_refund',
    ]);
  });
});

describe.each(FINANCIAL.map((op, i) => [op, i] as const))('T-10 %s', (op, i) => {
  it('PM-10: a fault after the domain half, inside the posting, or at COMMIT leaves nothing behind; the same assertion then commits exactly once', async () => {
    const b = must(OP_KIND_BUILDERS[op]);
    const biz = await seedS3Business(db.pool, owner.tenantId, owner.userId, `t10-${i}`);
    const c = await connect();
    let prepared: PreparedKind;
    try {
      await c.query('BEGIN');
      prepared = await b.prepare(c, { biz, other, cashAccountId: await cashOf(c, biz.businessId) });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      await c.end();
    }
    const jti = randomUUID();
    const carrier = mintHonest(biz, b.op, prepared.sha256(biz), { jti });

    for (const point of POINTS) {
      const before = await tableDigest(db.pool, tables);
      const o = await composed(biz, prepared, carrier, point);
      expect(o.ok ? 'committed' : o.code, `${op} ${point}: the fault fired`).toBe(`injected_fault.${point}`);
      expect(changedTables(before, await tableDigest(db.pool, tables)), `${op} ${point}: nothing survives`).toEqual([]);
    }

    const before = await tableDigest(db.pool, tables);
    const retry = await composed(biz, prepared, carrier, null);
    expect(retry.ok ? retry.value : `refused ${retry.sqlstate} ${retry.message}`, `${op}: the same assertion re-presented commits`).toBeGreaterThanOrEqual(1);
    const changed = changedTables(before, await tableDigest(db.pool, tables));
    for (const t of ['inventory_assertion_uses', 'journal_entries', 'journal_lines', 'accounting_source_bindings']) expect(changed, `${op}: ${t}`).toContain(t);
    expect(await orphans(db.pool, biz.businessId), `${op}: no document without its entry`).toEqual([]);

    const again = await composed(biz, prepared, carrier, null);
    expect(again.ok ? 'committed twice' : again.code, `${op}: exactly once`).toBe('inventory.assertion_replayed');
    const uses = must(
      (
        await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM inventory_assertion_uses WHERE jti = $1 AND business_id = $2 AND op_code = $3`, [
          jti,
          biz.businessId,
          b.op,
        ])
      ).rows[0],
    ).n;
    expect(uses, `${op}: the assertion was used exactly once`).toBe('1');
    const r = resultOf(await runChecks(db.poolAs('daftar_reconciler'), { tenantId: biz.tenantId, businessId: biz.businessId }, ['R-INV-01']), 'R-INV-01');
    expect(r.status, `${op}: GL(Inventory) = Σ movements`).toBe('ok');
  });
});

describe('T-10 NEGATIVE CONTROL — the split seam: the stock half committed, its posting faulted on another connection', () => {
  it('PM-10 NC: with the binding key dropped the stock half commits alone; the orphan detector names the adjustment and R-INV-01 names the business', async () => {
    const biz = await seedS3Business(db.pool, owner.tenantId, owner.userId, 't10-nc');
    const seed = await connect();
    try {
      await seed.query('BEGIN');
      await stockUp(seed, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '5', unitCost: '6' }]);
      await seed.query('COMMIT');
    } finally {
      await seed.end();
    }
    expect(await orphans(db.pool, biz.businessId)).toEqual([]);

    const adjustmentId = randomUUID();
    let total = '';
    let occurredOn = '';
    const stockHalf = async (): Promise<void> => {
      const c = await connect();
      try {
        await c.query('BEGIN');
        const cmd = await adjustCommand(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '-2' }], { adjustmentId });
        occurredOn = must(cmd.occurredOn);
        total = must(must((await runCommand(c, biz, cmd))[0]).total, 'the adjustment total');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        await c.end();
      }
    };
    const shipped = await settle(stockHalf);
    expect(shipped.ok ? 'committed' : shipped.constraint, 'as shipped the stock half alone is refused at COMMIT').toBe('inventory_adjustments_binding_fk');

    await db.pool.query(`ALTER TABLE inventory_adjustments DROP CONSTRAINT inventory_adjustments_binding_fk`);
    await stockHalf();
    // Its posting, on a second connection, faulted inside the posting: it never lands.
    const posting = await settle(async () => {
      const c = await connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.t10_fault', 'posting', true)`);
        const entry = must(
          adjustmentEntry(biz, {
            sourceId: adjustmentId,
            occurredOn,
            warehouseId: biz.w1,
            branchId: await homeBranch(c, biz.businessId, biz.w1),
            netValueMinor: BigInt(total),
          }),
          'the entry the adjustment owes',
        );
        await postEntryInTx(c, entry, biz.userId);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        await c.end();
      }
    });
    expect(posting.ok ? 'posted' : posting.code).toBe('injected_fault.posting');
    expect(await orphans(db.pool, biz.businessId), 'the orphan is reported').toEqual([adjustmentId]);
    const r = resultOf(await runChecks(db.poolAs('daftar_reconciler'), { tenantId: biz.tenantId, businessId: biz.businessId }, ['R-INV-01']), 'R-INV-01');
    expect({ status: r.status, ids: r.offendingIds }).toEqual({ status: 'discrepancy', ids: [biz.businessId] });
  });
});
