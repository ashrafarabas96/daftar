/**
 * P3-S8 T-08 — PM-16's LONG MIXED SEQUENCE, R-INV-01 EXACT AFTER EVERY STEP
 * (docs/PHASE_3_S8_CONTRACT.md A-10, A-15, §6.3 T-08; PM:227, PM:681).
 *
 * One business runs the whole of Phase 3's value surface, each step its own
 * committed transaction through the real commands and their entries: an
 * opening, receipts (landed cost; a foreign currency), transfers both ways,
 * an adjustment, damage, a stocktake, a supplier payment, a return that issues
 * a credit note, the credit allocated and refunded, a plain return and a
 * reversal (`mixedSequence`).
 *
 * After EVERY step, `Σ stock_movements.value_delta_base_minor` equals
 * `GL(Inventory)` to the minor unit, read by the owner, and R-INV-01 — the
 * production reader, as `daftar_reconciler` — answers `ok`. There is no
 * tolerance: the comparison is integer equality.
 *
 * NEGATIVE CONTROL (the split seam of A-15): an adjustment's stock half is
 * committed on its own connection, without its posting. As shipped the
 * deferred binding key `inventory_adjustments_binding_fk` (0061:562: the
 * header must be bound to the accounting source the posting creates)
 * refuses it at COMMIT. In a scratch database with that key dropped the split
 * seam commits, the movements and the GL part, and R-INV-01 — and only
 * R-INV-01 — reports the business, by id alone.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, reconcilerDbUrl, resetData } from '../helpers/test-app';
import { adjustCommand, must, ownerClient, runCommand, seedS3World, today, type Queryable, type S3Business } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import { settle } from '../helpers/stock-ledger';
import { stateRate } from '../helpers/supplier-settlement';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { inventoryFigures, mixedSequence, resultOf, runChecks, statuses } from '../helpers/inventory-reconciliation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Every field a result may carry (A-10 "the result contract is unchanged"): identifiers, a count, timings, a code. */
const SAFE_KEYS: ReadonlySet<string> = new Set([
  'businessId',
  'checkId',
  'status',
  'offendingCount',
  'offendingIds',
  'durationMs',
  'startedAt',
  'completedAt',
  'errorCode',
  'correction',
]);

let A: S3Business;
let reconciler: Pool;

async function cashOf(q: Queryable, businessId: string): Promise<string> {
  const r = await q.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId]);
  return must(r.rows[0], 'cash account').id;
}

/** `fn` in one committed transaction on a fresh owner connection. */
async function committed(open: () => Promise<Client>, fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await open();
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

async function dayBefore(): Promise<string> {
  const d = new Date(`${await today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  A = (await seedS3World(ownerPool(), 't08')).A;
  reconciler = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
});

afterAll(async () => {
  await reconciler.end();
  await resetData();
});

describe('T-08 the long mixed sequence: GL(Inventory) = Σ movements after every step', () => {
  it('every step commits, and after each one the two figures are equal to the minor unit and R-INV-01 is ok', async () => {
    const rateDay = await dayBefore();
    const steps = mixedSequence(A, await cashOf(ownerPool(), A.businessId), () => stateRate(A, 'USD', 'ILS', '3.6000000000', `${rateDay}T00:00:00Z`));
    expect(steps.length).toBe(18);
    const target = { tenantId: A.tenantId, businessId: A.businessId };
    for (const step of steps) {
      await committed(ownerClient, (c) => step.run(c));
      const f = await inventoryFigures(ownerPool(), A.businessId);
      expect(f.gl, `after "${step.name}": GL(Inventory) = Σ movements`).toBe(f.movements);
      const r = resultOf(await runChecks(reconciler, target, ['R-INV-01']), 'R-INV-01');
      expect({ step: step.name, status: r.status, offending: r.offendingIds }).toEqual({ step: step.name, status: 'ok', offending: [] });
    }
    expect((await inventoryFigures(ownerPool(), A.businessId)).movements, 'the sequence carried value').toBeGreaterThan(0n);
  });

  it('the sequence exercised every value source PM-16 names (movements and entries of each kind, landed cost, a foreign receipt)', async () => {
    const kinds = (
      await ownerPool().query<{ k: string }>(
        `SELECT DISTINCT source_type || ':' || movement_kind AS k FROM stock_movements WHERE business_id = $1 ORDER BY 1`,
        [A.businessId],
      )
    ).rows.map((r) => r.k);
    const sources = (
      await ownerPool().query<{ s: string }>(`SELECT DISTINCT source_type AS s FROM journal_entries WHERE business_id = $1 ORDER BY 1`, [A.businessId])
    ).rows.map((r) => r.s);
    for (const s of [
      'inventory_opening',
      'inventory_adjustment',
      'purchase',
      'supplier_return',
      'reversal',
      'supplier_payment',
      'supplier_credit_allocation',
      'supplier_refund',
    ]) {
      expect(sources, `a ${s} entry`).toContain(s);
    }
    for (const prefix of ['inventory_opening:', 'purchase:', 'inventory_transfer:', 'inventory_adjustment:', 'stocktake:', 'supplier_return:']) {
      expect(
        kinds.some((k) => k.startsWith(prefix)),
        `${prefix} movements in ${kinds.join(', ')}`,
      ).toBe(true);
    }
    const facts = must(
      (
        await ownerPool().query<{ foreign: string; landed: string; reversed: string }>(
          `SELECT (SELECT count(*) FROM purchases WHERE business_id = $1 AND currency_code <> 'ILS')::text AS foreign,
                  (SELECT count(*) FROM purchase_landed_costs WHERE business_id = $1)::text AS landed,
                  (SELECT count(*) FROM purchase_reversals WHERE business_id = $1)::text AS reversed`,
          [A.businessId],
        )
      ).rows[0],
    );
    expect(facts).toEqual({ foreign: '1', landed: '2', reversed: '1' });
  });
});

describe('T-08 NEGATIVE CONTROL — the split seam: an adjustment committed without its posting', () => {
  let scratch: ScratchDb;
  let S: S3Business;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t08_nc');
    S = (await seedS3World(scratch.pool, 't08nc')).A;
    await committed(scratchClient, async (c) => {
      await stockUp(c, S, S.w1, [{ variantId: S.piece.variantId, qty: '6', unitCost: '4' }]);
    });
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  const scratchClient = async (): Promise<Client> => {
    const c = new Client({ connectionString: scratch.url() });
    await c.connect();
    return c;
  };

  const stockHalfOnly = async (c: Client): Promise<void> => {
    await runCommand(c, S, await adjustCommand(c, S, S.w1, [{ variantId: S.piece.variantId, qty: '-2' }], { adjustmentId: randomUUID() }));
  };

  it('as shipped every R-INV check is ok, and the stock half alone is refused at COMMIT by the binding key', async () => {
    const target = { tenantId: S.tenantId, businessId: S.businessId };
    expect(statuses(await runChecks(scratch.poolAs('daftar_reconciler'), target))).toEqual({
      'R-INV-01': 'ok',
      'R-INV-02': 'ok',
      'R-INV-03': 'ok',
      'R-INV-04': 'ok',
      'R-INV-05': 'ok',
    });
    const before = await inventoryFigures(scratch.pool, S.businessId);
    const o = await settle(() => committed(scratchClient, stockHalfOnly));
    expect(o.ok ? 'committed' : { sqlstate: o.sqlstate, constraint: o.constraint }, 'the deferred binding key refuses the unposted adjustment').toEqual({
      sqlstate: '23503',
      constraint: 'inventory_adjustments_binding_fk',
    });
    expect(await inventoryFigures(scratch.pool, S.businessId)).toEqual(before);
  });

  it('with the binding key dropped the split seam commits, the figures part, and exactly R-INV-01 reports the business by id alone', async () => {
    await scratch.pool.query(`ALTER TABLE inventory_adjustments DROP CONSTRAINT inventory_adjustments_binding_fk`);
    await committed(scratchClient, stockHalfOnly);
    const f = await inventoryFigures(scratch.pool, S.businessId);
    expect(f.gl, 'the attack committed: GL no longer equals the movements').not.toBe(f.movements);
    const target = { tenantId: S.tenantId, businessId: S.businessId };
    const run = await runChecks(scratch.poolAs('daftar_reconciler'), target);
    expect(statuses(run)).toEqual({ 'R-INV-01': 'discrepancy', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' });
    const r = resultOf(run, 'R-INV-01');
    expect({ count: r.offendingCount, ids: r.offendingIds }).toEqual({ count: 1, ids: [S.businessId] });
    expect(r.offendingIds.every((id) => UUID.test(id))).toBe(true);
    for (const x of run.results)
      expect(
        Object.keys(x).filter((k) => !SAFE_KEYS.has(k)),
        `${x.checkId}: no amount, quantity or currency`,
      ).toEqual([]);
  });
});
