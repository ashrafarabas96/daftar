/**
 * P3-S8 T-13 — THE S8 BUDGETS (docs/PHASE_3_S8_CONTRACT.md A-17, §6.1 T-13,
 * TL-7).
 *
 * | Id    | Measure                                        | Tier 1   | Tier 2        |
 * | S8-R1 | R-INV-01..05, one business, D-GL               | ≤ 20 s   | ≤ 120 s       |
 * | S8-R2 | R-INV-02/03/05, D-LEDGER                       | ≤ 30 s   | ≤ 300 s       |
 * | S8-V  | fold + verify of EVERY key, D-LEDGER           | ≤ 60 s   | ≤ 600 s       |
 * | S8-B  | dataset build, both datasets                   | ≤ 240 s  | recorded      |
 * | S8-M  | T-01 matrix wall time                          | ≤ 120 s  | —             |
 *
 * The numbers are the contract's, written as constants: a budget may be
 * tightened, never loosened without the Tech Lead, and never raised to obtain
 * a pass. Budget A (15 ms) and, under R-B1a, Budget B are re-measured by the
 * S8 gate's last step, `tests/performance/accounting-budgets.test.ts`, alone.
 *
 * The reconciliation passes are the PRODUCT's: `reconcile()` over the real
 * reader, on a `daftar_reconciler` connection (the Budget F method,
 * accounting-budgets.test.ts:434-457), restricted to the inventory checks.
 * Fold and verify are the S2 routines `inventory_stock_fold` /
 * `inventory_stock_verify`, over every key of D-LEDGER. S8-M times T-01's own
 * test file (vitest's per-file duration, global setup excluded) on a cluster
 * of its own, so it cannot disturb the dataset here.
 *
 * RUNNING IT: alone, after the functional suites, never beside another
 * `PG_DIR` user (SM:36). `P3S8_PERF_TIER=2` selects Tier 2 (local, evidence
 * uploaded on the phase2-s8-evidence pattern).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVENTORY_RECONCILIATION_CHECK_IDS, reconcile, type InventoryReconciliationCheckId, type ReconciliationRunResult } from '@daftar/accounting';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';
import { PoolReconciliationConnection } from '../helpers/accounting-reconciliation';
import { PG_DIR, PG_PORT } from '../helpers/embedded-cluster';
import { must, registerActor } from '../helpers/inventory-commands';
import { setScope } from '../helpers/stock-ledger';
import { createTestApp, ensurePostgres, ownerPool, reconcilerDbUrl, resetData, type TestApp } from '../helpers/test-app';
import {
  GL_VOLUME,
  LEDGER_VOLUME,
  PERF_SCALE,
  PERF_TIER,
  buildGlDataset,
  buildLedgerDataset,
  removeLedgerDataset,
  type GlDataset,
  type LedgerDataset,
} from './phase3-dataset';

/** A-17, verbatim. Milliseconds; `null` is "recorded, not bounded" or "not measured at this tier". */
const BUDGET: Readonly<Record<'S8-R1' | 'S8-R2' | 'S8-V' | 'S8-B' | 'S8-M', { readonly tier1: number; readonly tier2: number | null }>> = {
  'S8-R1': { tier1: 20_000, tier2: 120_000 },
  'S8-R2': { tier1: 30_000, tier2: 300_000 },
  'S8-V': { tier1: 60_000, tier2: 600_000 },
  'S8-B': { tier1: 240_000, tier2: null },
  'S8-M': { tier1: 120_000, tier2: null },
};
const budgetOf = (id: keyof typeof BUDGET): number | null => (PERF_TIER === 2 ? BUDGET[id].tier2 : BUDGET[id].tier1);

const T01 = 'tests/security/phase3-s8-signed-authority-matrix.test.ts';
const REPO = join(__dirname, '../..');

const recorded: Record<string, number> = {};
function record(id: keyof typeof BUDGET, ms: number, facts: Readonly<Record<string, unknown>> = {}): void {
  recorded[id] = ms;
  console.info('[T-13] budget', JSON.stringify({ id, tier: PERF_TIER, scale: PERF_SCALE, ms: Math.round(ms), budgetMs: budgetOf(id), ...facts }));
}

function expectWithin(id: keyof typeof BUDGET, ms: number): void {
  const budget = budgetOf(id);
  if (budget !== null) expect(ms, `${id}: ${Math.round(ms)} ms against ${budget} ms`).toBeLessThanOrEqual(budget);
}

/** One product reconciliation pass over the real reader as `daftar_reconciler`, restricted to `checks`. */
async function inventoryPass(checks: readonly InventoryReconciliationCheckId[]): Promise<{ result: ReconciliationRunResult; ms: number }> {
  const pool = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
  try {
    const reader = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
    const started = process.hrtime.bigint();
    const result = await reconcile(reader, { now: (): Date => new Date() }, { checks });
    return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } finally {
    await pool.end();
  }
}

let t: TestApp;
let ledger: LedgerDataset;
let gl: GlDataset;

beforeAll(
  async () => {
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
  },
  60 * 60 * 1000,
);

afterAll(async () => {
  await t.close();
  await resetData();
});

describe(`T-13 D-LEDGER (tier ${PERF_TIER}, scale ${PERF_SCALE})`, () => {
  beforeAll(
    async () => {
      ledger = await buildLedgerDataset();
    },
    8 * 60 * 60 * 1000,
  );
  afterAll(async () => {
    await removeLedgerDataset();
  });

  it('holds the stated volume', () => {
    const keys = LEDGER_VOLUME.variants * LEDGER_VOLUME.warehouses;
    console.info('[T-13] D-LEDGER', JSON.stringify({ keys: ledger.keys.length, movements: ledger.movements, buildMs: Math.round(ledger.buildMs) }));
    expect(ledger.keys.length).toBe(keys);
    expect(ledger.movements).toBe(keys * LEDGER_VOLUME.movementsPerKey);
  });

  it('S8-R2: R-INV-02/03/05 over D-LEDGER, every one ok', async () => {
    const checks = INVENTORY_RECONCILIATION_CHECK_IDS.filter((id) => id === 'R-INV-02' || id === 'R-INV-03' || id === 'R-INV-05');
    expect(checks).toHaveLength(3);
    const { result, ms } = await inventoryPass(checks);
    record('S8-R2', ms, { movements: ledger.movements });
    const mine = result.results.filter((r) => r.businessId === ledger.business.businessId);
    expect(result.enumeration).toBe('complete');
    expect(
      mine.map((r) => `${r.checkId}:${r.status}`),
      'the D-LEDGER business',
    ).toEqual(checks.map((id) => `${id}:ok`));
    expectWithin('S8-R2', ms);
  }, 3_600_000);

  it('S8-V: fold and verify of every key of D-LEDGER, every key matching', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await setScope(c, ledger.business);
      const started = process.hrtime.bigint();
      const r = await c.query<{ keys: number; mismatched: number; gaps: number }>(
        `SELECT count(*)::int AS keys,
                count(*) FILTER (WHERE NOT v.matches)::int AS mismatched,
                count(*) FILTER (WHERE NOT f.sequence_gapless)::int AS gaps
           FROM stock_levels l
           CROSS JOIN LATERAL inventory_stock_fold(l.business_id, l.warehouse_id, l.variant_id) f
           CROSS JOIN LATERAL inventory_stock_verify(l.business_id, l.warehouse_id, l.variant_id) v
          WHERE l.business_id = $1`,
        [ledger.business.businessId],
      );
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      await c.query('COMMIT');
      const row = must(r.rows[0]);
      record('S8-V', ms, row);
      expect(row).toEqual({ keys: ledger.keys.length, mismatched: 0, gaps: 0 });
      expectWithin('S8-V', ms);
    } finally {
      c.release();
    }
  }, 3_600_000);
});

describe(`T-13 D-GL (tier ${PERF_TIER}, scale ${PERF_SCALE})`, () => {
  beforeAll(
    async () => {
      // Signed up here, just before its only use, not once for the whole file:
      // an access token lives 900 s, and at Tier 2 the D-LEDGER build above
      // takes about that long, so a token issued before it had expired by the
      // time D-GL onboarded its business (401).
      const owner = await registerActor(t, 'S8 budgets owner');
      gl = await buildGlDataset(t, owner);
    },
    8 * 60 * 60 * 1000,
  );

  it('holds the stated volume: every planned command wrote its movements', () => {
    console.info(
      '[T-13] D-GL',
      JSON.stringify({
        movements: gl.movements,
        planned: gl.plannedMovements,
        journalLines: gl.journalLines,
        buildMs: Math.round(gl.buildMs),
        volume: GL_VOLUME,
      }),
    );
    expect(gl.movements).toBe(gl.plannedMovements);
    expect(gl.movements).toBeGreaterThanOrEqual(Math.floor(GL_VOLUME.receipts * GL_VOLUME.linesPerReceipt * 1.2));
  });

  it('S8-R1: R-INV-01..05 over D-GL, every one ok', async () => {
    const { result, ms } = await inventoryPass(INVENTORY_RECONCILIATION_CHECK_IDS);
    record('S8-R1', ms, { movements: gl.movements, journalLines: gl.journalLines });
    const mine = result.results.filter((r) => r.businessId === gl.business.businessId);
    expect(result.enumeration).toBe('complete');
    expect(
      mine.map((r) => `${r.checkId}:${r.status}`),
      'the D-GL business',
    ).toEqual(INVENTORY_RECONCILIATION_CHECK_IDS.map((id) => `${id}:ok`));
    expectWithin('S8-R1', ms);
  }, 3_600_000);
});

describe('T-13 build and matrix', () => {
  it('S8-B: both datasets built within the budget', () => {
    const ms = ledger.buildMs + gl.buildMs;
    record('S8-B', ms, { ledgerMs: Math.round(ledger.buildMs), glMs: Math.round(gl.buildMs) });
    expectWithin('S8-B', ms);
  });

  it('S8-M: the T-01 matrix runs within its budget, on a cluster of its own', () => {
    if (budgetOf('S8-M') === null) {
      console.info('[T-13] S8-M is a Tier 1 measure only (A-17)');
      return;
    }
    const out = join(mkdtempSync(join(tmpdir(), 'p3s8-m-')), 'report.json');
    const res = spawnSync('npx', ['vitest', 'run', T01, '--reporter=json', '--outputFile', out], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PG_DIR: `${PG_DIR}-s8m`, PG_PORT: String(PG_PORT + 17) },
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(res.status, `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-3000)).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')) as { testResults?: { name?: string; startTime?: number; endTime?: number; status?: string }[] };
    const file = must(
      (report.testResults ?? []).find((r) => (r.name ?? '').endsWith(T01)),
      'T-01 in the report',
    );
    expect(file.status).toBe('passed');
    const ms = must(file.endTime) - must(file.startTime);
    record('S8-M', ms);
    expectWithin('S8-M', ms);
  }, 3_600_000);
});
