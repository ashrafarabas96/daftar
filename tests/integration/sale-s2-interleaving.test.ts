/**
 * P4-S2 — THE FORCED-INTERLEAVING MECHANISM, PROVED BEFORE IT IS TRUSTED.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-41, P4-AL-42, P4-AL-67;
 *  docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §2, §7.)
 *
 * `tests/golden-regression/phase4-s2/harness.ts` is the mechanism every P4-S2
 * concurrency verdict is read out of. A mechanism trusted without proof is the
 * FI-11 defect one level up: FI-11's verdict was the machine's speed, and a
 * harness that silently failed to force an interleaving would make every
 * verdict above it the machine's speed again, while reading green.
 *
 * So each property the harness claims is proved here, and each proof is an
 * ABILITY TO SAY NO:
 *
 *   — `blockedBehind` reaches a backend queued TRANSITIVELY, not only one
 *     blocked directly by the parker. A single-step version sees one waiter
 *     where there are two, releases the park with half the race enqueued, and
 *     reports a green race that never happened.
 *   — `waitUntilQueued` THROWS when an attempt settles without parking.
 *   — `waitUntilQueued` THROWS when the bound expires. The bound is never a
 *     pass.
 *   — `parkStockKey` THROWS when the row it is asked to hold does not exist,
 *     so a park that holds nothing cannot be mistaken for a held lock.
 *   — a real deadlock is CLASSIFIED as a deadlock and `expectNoDeadlock`
 *     FAILS on it. The proof plants an actual 40P01 between two connections
 *     taking two rows in opposite order — which is both the red proof for the
 *     verdict and a demonstration of the defect class it reports.
 *   — the census is DISCOVERED from the catalogue, so a relation outside the
 *     accepted hand-maintained list is inside it.
 *
 * Green today. It depends on nothing P4-S2 has yet to write.
 *
 * Not named `phase4-*` or `p4-*`: `suiteProblems` in the SEALED
 * `scripts/phase4-s1-gate.ts` (:750-753) fails any `phase4-*` or `p4-*` suite
 * in `tests/integration`, `tests/security` or `tests/performance` that no
 * `S1_SUITES` entry lists, and the sealed gate is not reopened. The
 * `inventory-s3-*` / `purchase-s4-*` convention is followed instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { seedStockBusiness, type StockBusiness } from '../helpers/stock-ledger';
import {
  census,
  censusDelta,
  classify,
  expectNoDeadlock,
  must,
  parkStockKey,
  pidOf,
  settle,
  tablesWithColumn,
  waitUntilQueued,
  type Outcome,
} from '../golden-regression/phase4-s2/harness';

let W: StockBusiness;
/** Two stock keys of one business, to park and to deadlock over. */
let keyA: { warehouseId: string; variantId: string };
let keyB: { warehouseId: string; variantId: string };

const open = (): Promise<Client> => ownerClient();

async function ensureLevel(warehouseId: string, variantId: string): Promise<void> {
  await ownerPool().query(
    `INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq)
     VALUES ($1, $2, $3, $4, 0, 0, NULL, 0) ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING`,
    [W.tenantId, W.businessId, warehouseId, variantId],
  );
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  W = await seedStockBusiness(ownerPool(), 'ilv');
  keyA = { warehouseId: W.warehouse1, variantId: W.piece.variantId };
  keyB = { warehouseId: W.warehouse1, variantId: W.dec2.variantId };
  await ensureLevel(keyA.warehouseId, keyA.variantId);
  await ensureLevel(keyB.warehouseId, keyB.variantId);
}, 180_000);

afterAll(async () => {
  await resetData();
});

/** A second connection that takes one stock key FOR UPDATE and stays open. */
async function holder(key: { warehouseId: string; variantId: string }): Promise<{ client: Client; pid: number }> {
  const c = await open();
  await c.query('BEGIN');
  await c.query(`SET LOCAL lock_timeout = '60s'`);
  await c.query(`SELECT 1 FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 FOR UPDATE`, [
    W.businessId,
    key.warehouseId,
    key.variantId,
  ]);
  return { client: c, pid: await pidOf(c) };
}

describe('the forced-interleaving mechanism the P4-S2 concurrency verdicts are read out of', () => {
  it('blockedBehind reaches a transitively queued backend, not only the parker’s direct waiters', async () => {
    const park = await parkStockKey(open, W.businessId, keyA.warehouseId, keyA.variantId);
    const w1 = await open();
    const w2 = await open();
    try {
      await w1.query('BEGIN');
      await w2.query('BEGIN');
      const sql = `SELECT 1 FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 FOR UPDATE`;
      const args = [W.businessId, keyA.warehouseId, keyA.variantId];
      const f1 = { done: false };
      void settle(() => w1.query(sql, args)).then(() => (f1.done = true));
      await waitUntilQueued([park.pid], 1, f1, 'the first waiter');
      const f2 = { done: false };
      void settle(() => w2.query(sql, args)).then(() => (f2.done = true));
      const parked = await waitUntilQueued([park.pid], 2, f2, 'the second waiter');
      expect(parked.length, 'both waiters are reached, the second through the first').toBe(2);
      // And the single-step form does NOT see both: the proof that the fixed
      // point is load-bearing rather than defensive.
      const direct = must(
        (
          await ownerPool().query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND $1 = ANY (pg_blocking_pids(pid))`,
            [park.pid],
          )
        ).rows[0],
      ).n;
      expect(direct, 'a single-step "blocked directly by the parker" test sees fewer than both waiters — which is why blockedBehind iterates').toBeLessThan(2);
    } finally {
      await park.release();
      await w1.query('ROLLBACK').catch(() => undefined);
      await w2.query('ROLLBACK').catch(() => undefined);
      await w1.end().catch(() => undefined);
      await w2.end().catch(() => undefined);
    }
  });

  it('waitUntilQueued throws when the attempt settles without ever parking', async () => {
    const park = await parkStockKey(open, W.businessId, keyA.warehouseId, keyA.variantId);
    try {
      // An attempt that touches a DIFFERENT key never contends with the park.
      const flag = { done: false };
      const pending = settle(() => ownerPool().query(`SELECT 1`)).then((o) => {
        flag.done = true;
        return o;
      });
      await pending;
      await expect(waitUntilQueued([park.pid], 1, flag, 'an attempt that does not contend')).rejects.toThrow(
        /finished without ever waiting on the parked lock/,
      );
    } finally {
      await park.release();
    }
  });

  it('waitUntilQueued throws when its bound expires: the bound is a failure, never a pass', async () => {
    const park = await parkStockKey(open, W.businessId, keyA.warehouseId, keyA.variantId);
    try {
      await expect(waitUntilQueued([park.pid], 1, { done: false }, 'nothing ever parks', 4)).rejects.toThrow(/The bound expiring is a FAILURE, never a pass/);
    } finally {
      await park.release();
    }
  });

  it('parkStockKey throws rather than holding nothing when the row does not exist', async () => {
    await expect(parkStockKey(open, W.businessId, keyA.warehouseId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /a park on an absent row holds no lock/,
    );
  });

  it('a real deadlock is classified as a deadlock, and expectNoDeadlock fails on it', async () => {
    // TWO CONNECTIONS TAKING TWO ROWS IN OPPOSITE ORDER. This is the defect
    // class P4-AL-41 exists to prevent, planted on purpose so the verdict that
    // reports it is proved able to fire. The interleaving is forced, not
    // hoped for: c1 holds A and is OBSERVED waiting for B before c2 asks for A.
    const c1 = await holder(keyA);
    const c2 = await holder(keyB);
    let outcomes: readonly Outcome<unknown>[] = [];
    try {
      const sql = (key: { warehouseId: string; variantId: string }): string =>
        `SELECT 1 FROM stock_levels WHERE business_id = '${W.businessId}' AND warehouse_id = '${key.warehouseId}' AND variant_id = '${key.variantId}' FOR UPDATE`;
      const f1 = { done: false };
      const p1 = settle(() => c1.client.query(sql(keyB))).then((o) => {
        f1.done = true;
        return o;
      });
      await waitUntilQueued([c2.pid], 1, f1, 'c1 waiting for the row c2 holds');
      const p2 = settle(() => c2.client.query(sql(keyA)));
      outcomes = await Promise.all([p1, p2]);
    } finally {
      await c1.client.query('ROLLBACK').catch(() => undefined);
      await c2.client.query('ROLLBACK').catch(() => undefined);
      await c1.client.end().catch(() => undefined);
      await c2.client.end().catch(() => undefined);
    }
    expect(outcomes.filter((o) => o.kind === 'deadlock').length, 'the planted lock-order defect produced a 40P01 and it was classified as one').toBe(1);
    // THE RED PROOF OF THE VERDICT: the assertion that reports a deadlock as a
    // lock-order defect actually fails when one happens, and names it as a
    // lock-order defect rather than as contention.
    expect(() => expectNoDeadlock(outcomes, 'the planted lock-order defect')).toThrow(/LOCK-ORDER DEFECT/);
    expect(() => expectNoDeadlock(outcomes, 'the planted lock-order defect')).toThrow(/will not retry/);
  });

  it('a deadlock is never retried: the harness exposes no retry and the suite performs none', async () => {
    // A negative claim, asserted over the harness's own source so it cannot
    // decay: nothing in the mechanism loops on 40P01, sets deadlock_timeout or
    // re-runs an attempt — `[[daftar-lock-order-not-retry]]`.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'golden-regression', 'phase4-s2', 'harness.ts'), 'utf8');
    // Comments AND string literals removed: the harness's own refusal MESSAGE
    // names `deadlock_timeout` and the word "retry", because that is what it
    // tells the reader not to do. A check that read the messages would be
    // asserting about its own prose. `scripts/phase4-s1-gate.ts` strips quoted
    // text for the same reason before it looks for a `.skip`.
    const prose = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/`(?:\\.|[^`\\])*`/g, "''")
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, "''");
    expect(/deadlock_timeout/.test(prose), 'the mechanism never touches deadlock_timeout').toBe(false);
    expect(/retr(y|ies|ied)/i.test(prose), 'the mechanism contains no retry').toBe(false);
  });

  it('the census is discovered from the catalogue, so a relation no list names is still counted', async () => {
    const scoped = await tablesWithColumn(ownerPool(), 'business_id');
    // `purchases` carries business_id and is NOT in the accepted H-7 counter
    // (`tests/helpers/inventory-commands.ts:756`), which names its tables as
    // literals. A discovered census has no such blind spot, and `sales` will
    // be inside it on the day it is created with no edit to this file.
    expect(scoped, 'the discovered census reaches a business-scoped relation the hand-maintained counter does not name').toContain('purchases');
    expect(scoped.length, 'the discovery found a real estate, not an empty one').toBeGreaterThan(20);
    const c = await census(ownerPool(), W.businessId);
    expect(Object.keys(c).length, 'the census counts every discovered relation').toBeGreaterThanOrEqual(scoped.length);
    expect(censusDelta(c, c), 'a census compared with itself moved nothing').toEqual({});
  });

  it('classify names 40P01 and nothing else a deadlock', () => {
    const notADeadlock = classify<number>(undefined, new Error('plain'));
    expect(notADeadlock.kind, 'an ordinary error is not a deadlock').toBe('error');
    expect(classify<number>(7, undefined).kind, 'a value is an ok outcome').toBe('ok');
    expect(() => expectNoDeadlock([notADeadlock], 'an ordinary error'), 'expectNoDeadlock passes an ordinary error through').not.toThrow();
  });
});
