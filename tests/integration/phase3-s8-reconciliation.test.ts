/**
 * P3-S8 T-06 — R-INV-01 … R-INV-05 ARE `ok` OVER THE LONG MIXED SEQUENCE
 * (docs/PHASE_3_S8_CONTRACT.md A-10, §6.3 T-06; PM-01, PM-16, PM-26, PM-27,
 * PM-29, PM-31).
 *
 * Every check runs through the production reader and the framework's own
 * `reconcile()`, as the `daftar_reconciler` credential production uses — a
 * missing grant answers `unavailable`, never `ok`:
 *   - after T-08's sequence (every Phase 3 value source, one business), and
 *     an emptied key so R-INV-03 has something to judge, all five are `ok`;
 *   - over every business the reader itself enumerates (the sequenced one, an
 *     untouched one, another tenant's), all five are `ok` for each;
 *   - every result carries only identifiers, a count, timings and the
 *     no-correction notice: no amount, quantity or currency;
 *   - at the S7 head (0068, before 0069 grants the reads) the five are
 *     `unavailable` and say so — the checks cannot pass by reading nothing.
 */
import { Pool, type Client } from 'pg';
import { NO_CORRECTION_NOTICE } from '@daftar/accounting';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, reconcilerDbUrl, resetData } from '../helpers/test-app';
import { damageCommand, must, ownerClient, seedS3World, today, type Queryable, type S3Business } from '../helpers/inventory-commands';
import { runFinancial, stockUp } from '../helpers/inventory-posting';
import { stateRate } from '../helpers/supplier-settlement';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { R_INV, mixedSequence, resultOf, runAll, runChecks, statuses } from '../helpers/inventory-reconciliation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Every field a result may carry: identifiers, a count, timings, a code, the notice. */
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
const ALL_OK = { 'R-INV-01': 'ok', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' };

let A: S3Business;
let A2: S3Business;
let B: S3Business;
let reconciler: Pool;

async function cashOf(q: Queryable, businessId: string): Promise<string> {
  const r = await q.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId]);
  return must(r.rows[0], 'cash account').id;
}

async function committed(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
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

/** A stored `numeric` quantity as a command states it: no trailing zeros. */
function quantity(stored: string): string {
  return stored.includes('.') ? stored.replace(/0+$/, '').replace(/\.$/, '') : stored;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const w = await seedS3World(ownerPool(), 't06');
  A = w.A;
  A2 = w.A2;
  B = w.B;
  const d = new Date(`${await today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const rateAt = `${d.toISOString().slice(0, 10)}T00:00:00Z`;
  for (const step of mixedSequence(A, await cashOf(ownerPool(), A.businessId), () => stateRate(A, 'USD', 'ILS', '3.6000000000', rateAt))) {
    await committed((c) => step.run(c));
  }
  // Empty one key by damage, so R-INV-03 judges a zero-quantity key.
  const left = must(
    (
      await ownerPool().query<{ q: string }>(`SELECT on_hand::text AS q FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
        A.businessId,
        A.w2,
        A.piece.variantId,
      ])
    ).rows[0],
    'the W2 piece key',
  ).q;
  await committed(async (c) => {
    await runFinancial(c, A, await damageCommand(c, A, A.w2, [{ variantId: A.piece.variantId, qty: quantity(left) }]));
  });
  await committed(async (c) => {
    await stockUp(c, B, B.w1, [{ variantId: B.piece.variantId, qty: '4', unitCost: '3' }]);
  });
  reconciler = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
}, 300_000);

afterAll(async () => {
  await reconciler.end();
  await resetData();
});

describe('T-06 R-INV-01..05 over the long mixed sequence', () => {
  it('the sequenced business carries value, movements of every kind and an emptied key', async () => {
    const f = must(
      (
        await ownerPool().query<{ movements: string; keys: string; empty: string; value: string }>(
          `SELECT (SELECT count(*) FROM stock_movements WHERE business_id = $1)::text AS movements,
                  (SELECT count(*) FROM stock_levels WHERE business_id = $1)::text AS keys,
                  (SELECT count(*) FROM stock_levels WHERE business_id = $1 AND on_hand = 0)::text AS empty,
                  (SELECT coalesce(sum(value_delta_base_minor), 0) FROM stock_movements WHERE business_id = $1)::text AS value`,
          [A.businessId],
        )
      ).rows[0],
    );
    expect(Number(f.movements)).toBeGreaterThanOrEqual(20);
    expect(Number(f.keys)).toBeGreaterThanOrEqual(4);
    expect(Number(f.empty)).toBeGreaterThanOrEqual(1);
    expect(BigInt(f.value)).toBeGreaterThan(0n);
  });

  it('as daftar_reconciler, every check is ok for the sequenced business, with no offending id', async () => {
    const run = await runChecks(reconciler, { tenantId: A.tenantId, businessId: A.businessId });
    expect(statuses(run)).toEqual(ALL_OK);
    for (const id of R_INV) {
      const r = resultOf(run, id);
      expect({ id, businessId: r.businessId, count: r.offendingCount, ids: r.offendingIds }).toEqual({ id, businessId: A.businessId, count: 0, ids: [] });
    }
  });

  it('over every business the production reader enumerates, every check is ok for each', async () => {
    const run = await runAll(reconciler);
    const seen = new Set(run.results.map((r) => r.businessId));
    for (const biz of [A, A2, B]) expect(seen.has(biz.businessId), biz.businessId).toBe(true);
    expect(run.businessCount).toBe(seen.size);
    expect(run.results.length).toBe(seen.size * R_INV.length);
    const bad = run.results.filter((r) => r.status !== 'ok').map((r) => `${r.businessId} ${r.checkId} ${r.status} ${r.errorCode ?? ''}`);
    expect(bad).toEqual([]);
  });

  it('every result is UUID-only: identifiers, a count, timings and the no-correction notice — no amount, quantity or currency', async () => {
    const run = await runAll(reconciler);
    for (const r of run.results) {
      expect(
        Object.keys(r).filter((k) => !SAFE_KEYS.has(k)),
        `${r.checkId} ${r.businessId}`,
      ).toEqual([]);
      expect(r.businessId).toMatch(UUID);
      for (const id of r.offendingIds) expect(id).toMatch(UUID);
      expect(r.correction).toBe(NO_CORRECTION_NOTICE);
    }
  });
});

describe('T-06 at the S7 head the inventory checks are unavailable, never ok', () => {
  let s7: ScratchDb;
  let S: S3Business;

  beforeAll(async () => {
    s7 = await createScratchDb('daftar_p3s8_t06_s7head', { upTo: '0068_supplier_settlement_commands.sql' });
    S = (await seedS3World(s7.pool, 't06-s7')).A;
    const c = await s7.pool.connect();
    try {
      await c.query('BEGIN');
      await stockUp(c, S, S.w1, [{ variantId: S.piece.variantId, qty: '2', unitCost: '5' }]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }, 300_000);

  afterAll(async () => {
    await s7.drop();
  });

  it('R-INV-01..05 answer unavailable with the stable code, for a business that holds stock', async () => {
    const run = await runChecks(s7.poolAs('daftar_reconciler'), { tenantId: S.tenantId, businessId: S.businessId });
    expect(statuses(run)).toEqual({
      'R-INV-01': 'unavailable',
      'R-INV-02': 'unavailable',
      'R-INV-03': 'unavailable',
      'R-INV-04': 'unavailable',
      'R-INV-05': 'unavailable',
    });
    for (const id of R_INV) expect(resultOf(run, id).errorCode, id).toMatch(/^accounting\.reconciliation_unavailable:/);
  });
});
