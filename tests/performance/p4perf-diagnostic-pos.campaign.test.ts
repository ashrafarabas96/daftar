/**
 * TL-P4-PERF-A-02 — CAMPAIGN 1 (PRIMARY SUBJECT): THE POS P4-A RATIO GATE.
 *
 * ── THE SUBJECT, AND THE CORRECTION THAT PRODUCED IT ───────────────────
 *
 * This campaign was first aimed at `accounting-budgets.test.ts:55`
 * (`A_POST_P95: 15`) and was re-aimed mid-build. The record says so rather
 * than hiding it. What is actually red is:
 *
 *   tests/performance/pos-s3-budgets.test.ts:695
 *   P4-A — the POS type-ahead (scale 1, acceptance volume)
 *   GATE: fifty rows cost no more than 1.6x ten rows — the arms terminate early
 *   AssertionError: expected 1.6405440987480928 to be less than or equal to 1.6
 *
 * There are two budgets called A in this estate and they were conflated. The
 * accounting `A_POST_P95: 15` is a LATENCY in milliseconds. This one is a
 * DIMENSIONLESS RATIO of two p95s measured in the same run against a ceiling
 * of 1.6, overshooting by 2.5%. The accounting budget is this campaign's
 * SECONDARY subject and lives in the companion file.
 *
 * ── WHY A RATIO IS A DIFFERENT PROBLEM FROM A CEILING ──────────────────
 *
 * Dividing two p95s measured on one host cancels host SPEED. It does not
 * cancel host NOISE, and it is not symmetric: a stall landing in the ten-row
 * arm raises the DENOMINATOR and pushes the ratio DOWN, while the same stall
 * in the fifty-row arm pushes it UP. So this gate is host-independent in scale
 * and host-SENSITIVE in variance.
 *
 * That matters much more here than it would at 200 samples, because of a fact
 * established by reading the suite rather than by measuring it:
 *
 *   `pos-s3-budgets.test.ts:160`  RUNS   = 20
 *   `pos-s3-budgets.test.ts:427`  index  = min(n - 1, ceil(q·n) - 1)
 *
 * At n = 20 and q = 0.95 that index is 18 of 0..19 — THE SECOND-WORST SAMPLE
 * OF TWENTY. Each arm's verdict is its second-worst sample, and the gate is
 * the quotient of two of them. This is the same single-stalled-iteration
 * problem the accounting suite was explicitly corrected for when it went from
 * 30 samples to 200 (`accounting-budgets.test.ts:70-92`), and it is uncorrected
 * here, in a quotient, which doubles the exposure.
 *
 * `p4perf-diagnostic-analysis.ts` quantifies that exactly: `ratioSensitivity`
 * reports what the ratio becomes if ONE more sample in either arm stalls past
 * the current worst, how many samples must stall to reach the observed 1.6405,
 * and — by bootstrap over the recorded series — what fraction of runs this
 * gate would fail from the observed noise alone. NONE OF THAT IS A VERDICT. It
 * is evidence about the gate's discriminating power, which the ruling says is
 * what decides P versus H versus R.
 *
 * ── CLASS P IS LOOKED FOR FIRST, AND HERE IS THE SPECIFIC QUESTION ─────
 *
 * The gate's own title is "the arms terminate early", so its claim is about
 * the query's shape. The suite ALREADY PROVES, at
 * `pos-s3-budgets.test.ts:622-654`, that two of the five arms CANNOT early
 * terminate: `lower()` is not leakproof, so under this RLS shape neither the
 * SKU arm nor the NAME arm can become an index range, and a broad prefix
 * becomes a bounded sequential scan plus a sort.
 *
 * That gives a precise, falsifiable structural prediction, which `planDelta`
 * below is built to test: a sequential scan's cost does NOT depend on `limit`,
 * so if the scan dominates, the ten-row and fifty-row plans should read the
 * SAME number of blocks and the only growth should be in a bounded top-N sort
 * over 255 rows instead of 55. If that is what the plans show, the TRUE growth
 * is near 1.0 and a 1.64 reading cannot be growth. If instead the fifty-row
 * plan reads materially more blocks, rows or sort memory, the growth is real
 * and structural and that is a Class P product finding — the outcome that
 * matters most, which is why the plans are captured before anything else is
 * concluded.
 *
 * ── NOTHING HERE IS A VERDICT, AND NOTHING HERE IS FROZEN-CONTRACT ─────
 *
 * This file asserts NO budget, NO ratio and NO ceiling. `RATIO_50_OVER_10`,
 * `A_POS_SEARCH_P95`, `B_POS_CART_P95` and `A_POST_P95` are untouched and
 * un-imported. The sample count, the percentile, the warm-up contract, the
 * dataset, the transaction semantics and the timing boundary are MIRRORED from
 * the accepted suite, never altered, and the mirrored values are named as
 * mirrors so a drift would be visible.
 *
 * The only assertions in this file are PRECONDITIONS — the dataset is the one
 * the suite seeds, and the relations have been analyzed — because a campaign
 * that measured a different dataset, or an unanalyzed one, would produce a
 * number about the dataset instead of about the tail.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────
 *
 * Gated behind `P4PERF_DIAG=1` and SKIPPED otherwise, so a whole-tree
 * `vitest run` can never pick it up and spend hours on a diagnostic. Alone,
 * on an exclusive box:
 *
 *   P4PERF_DIAG=1 PG_DIR=/tmp/daftar-pg-perfdiag PG_PORT=56581 \
 *     node /home/user/daftar/node_modules/vitest/vitest.mjs run \
 *     tests/performance/p4perf-diagnostic-pos.campaign.test.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { openTillSession } from '../helpers/pos-till-sessions';
import { must, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { INTERNAL, addWarehouse, setScope } from '../helpers/stock-ledger';
import { readAs } from '../helpers/merchant-reads';
import { Database, type Scope } from '../../apps/api/src/infra/database';
import {
  OUT_DIR,
  backendPidOf,
  buildInstruments,
  captureEnvironment,
  explainJson,
  hostBaseline,
  planningStatistics,
  reportSeries,
  runPass,
  writeReport,
  selectedPasses,
  writeSeries,
  type SeriesResult,
} from './p4perf-diagnostic-campaign';
import { posQuantileIndex, ratioSensitivity } from './p4perf-diagnostic-analysis';

/* ══════════════════════════════════════════════════════════════════════
 * MIRRORS. Copied from the accepted suite, NEVER altered.
 * ════════════════════════════════════════════════════════════════════ */

/** `pos-s3-budgets.test.ts:159-160`. The warm-up contract and sample count, unchanged. */
const MIRROR_WARMUP = 5;
const MIRROR_RUNS = 20;
/** `pos-s3-budgets.test.ts:157`, at the default `P4_PERF_SCALE` of 1 — acceptance volume. */
const MIRROR_VOLUME = { variants: 5_000, warehouses: 3, merchantVariants: 500 } as const;
/** `pos-s3-budgets.test.ts:171`. */
const MIRROR_NAME_PREFIX = 'pos item 1';
/** `pos-s3-budgets.test.ts:162`. */
const BATCH = 500;
/** The gate's two arms, in the gate's own order (`pos-s3-budgets.test.ts:690-691`). */
const ARM_LIMITS = [10, 50] as const;
/** The gate's prefix. Broad on purpose: this is the one that cannot index-range. */
const ARM_PREFIX = 'pos-';

/**
 * The relations the read touches, for the counter and statistics instruments.
 * `businesses` is included because the `tenant_membership` RLS policy's
 * subplan reads it under every scan.
 */
const RELATIONS = ['products', 'product_variants', 'product_translations', 'stock_levels', 'businesses', 'pos_till_sessions'] as const;

const ENABLED = process.env['P4PERF_DIAG'] === '1';

/* ══════════════════════════════════════════════════════════════════════
 * STATE
 * ════════════════════════════════════════════════════════════════════ */

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let warehouses: string[] = [];
let tillSessionId = '';
let oneBarcode = '';

interface Captured {
  readonly scope: Scope;
  readonly text: string;
  readonly params: unknown[];
}

const searchPath = (q: string, limit: number): string => `/v1/pos/products?sessionId=${tillSessionId}&q=${encodeURIComponent(q)}&limit=${limit}`;

/* ══════════════════════════════════════════════════════════════════════
 * THE DATASET — the accepted suite's seed, reproduced and then VERIFIED
 * ════════════════════════════════════════════════════════════════════ */

/**
 * `pos-s3-budgets.test.ts`'s `seed()`, reproduced statement for statement.
 *
 * It is reproduced rather than imported because the accepted suite does not
 * export it, and it is VERIFIED rather than trusted: `assertDataset` below
 * runs the suite's own `measuredVolume` counts and the campaign refuses to
 * measure if any of them differs. The ruling freezes the dataset, so a
 * campaign on a different one would be measuring a different question.
 */
async function seed(): Promise<void> {
  const pool = ownerPool();
  warehouses = [A.w1, A.w2, await addWarehouse(pool, A.businessId, A.branchX, 'POS W3')];

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setScope(c, { tenantId: A.tenantId, businessId: A.businessId });
    await seedBatches(c);
    await seedMerchantVariants(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }

  // The tracking columns and the base variants, as the INVENTORY PRINCIPAL —
  // the same documented mechanism the accepted seed uses. No guard, trigger or
  // policy is disabled or bypassed here, exactly as there.
  const cfg = await pool.connect();
  try {
    await cfg.query('BEGIN');
    await setScope(cfg, { tenantId: A.tenantId, businessId: A.businessId });
    await cfg.query(`SET LOCAL ROLE ${INTERNAL}`);
    await cfg.query(
      `UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0
        WHERE business_id = $1 AND sku LIKE 'POS-SKU-%'`,
      [A.businessId],
    );
    await cfg.query(
      `WITH v AS (
         INSERT INTO product_variants (business_id, id, product_id, is_base)
         SELECT p.business_id, gen_random_uuid(), p.id, true
           FROM products p
          WHERE p.business_id = $1 AND p.sku LIKE 'POS-SKU-%'
         RETURNING business_id, id
       )
       INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor)
       SELECT $2::uuid, v.business_id, w.id, v.id, 5, 500
         FROM v CROSS JOIN (SELECT unnest($3::uuid[]) AS id) w`,
      [A.businessId, A.tenantId, warehouses],
    );
    await cfg.query('COMMIT');
  } catch (e) {
    await cfg.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    cfg.release();
  }
  oneBarcode = `79${String(MIRROR_VOLUME.variants - 1).padStart(11, '0')}`;
}

async function seedMerchantVariants(c: PoolClient): Promise<void> {
  for (let from = 0; from < MIRROR_VOLUME.merchantVariants; from += BATCH) {
    const to = Math.min(MIRROR_VOLUME.merchantVariants, from + BATCH);
    await c.query(
      `INSERT INTO product_variants (business_id, product_id, sku, barcode, status)
       SELECT p.business_id, p.id, 'VAR-SKU-' || g.n::text, '68' || lpad(g.n::text, 11, '0'), 'active'
         FROM generate_series($2::int, $3::int - 1) g(n)
         JOIN products p ON p.business_id = $1 AND p.sku = 'POS-SKU-' || g.n::text`,
      [A.businessId, from, to],
    );
  }
}

async function seedBatches(c: PoolClient): Promise<void> {
  for (let from = 0; from < MIRROR_VOLUME.variants; from += BATCH) {
    const to = Math.min(MIRROR_VOLUME.variants, from + BATCH);
    await c.query(
      `WITH g AS (SELECT n FROM generate_series($2::int, $3::int - 1) n),
            p AS (
              INSERT INTO products (business_id, id, base_price_minor, price_currency, status, sku, barcode)
              SELECT $1, gen_random_uuid(), 1000 + g.n, 'ILS', 'active',
                     'POS-SKU-' || g.n::text, '79' || lpad(g.n::text, 11, '0')
                FROM g
              RETURNING business_id, id, sku
            ),
            tr AS (
              INSERT INTO product_translations (business_id, product_id, locale, name)
              SELECT p.business_id, p.id, 'en', 'POS Item ' || substring(p.sku from 9)
                FROM p
              RETURNING 1
            )
       SELECT count(*) FROM tr`,
      [A.businessId, from, to],
    );
  }
}

interface Volume {
  products: number;
  variants: number;
  variantBarcodes: number;
  translations: number;
  stockKeys: number;
  namePrefixMatches: number;
  armPrefixMatches: number;
}

/** The accepted suite's own `measuredVolume`, plus how many rows the ARM's prefix matches. */
async function measuredVolume(): Promise<Volume> {
  const r = await ownerPool().query<Volume>(
    `SELECT (SELECT count(*)::int FROM products WHERE business_id = $1 AND status = 'active' AND sku LIKE 'POS-SKU-%') AS products,
            (SELECT count(*)::int FROM product_variants v JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
              WHERE v.business_id = $1 AND p.sku LIKE 'POS-SKU-%') AS variants,
            (SELECT count(*)::int FROM product_variants v JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
              WHERE v.business_id = $1 AND p.sku LIKE 'POS-SKU-%' AND v.barcode IS NOT NULL AND v.status <> 'archived') AS "variantBarcodes",
            (SELECT count(*)::int FROM product_translations WHERE business_id = $1 AND name LIKE 'POS Item %') AS translations,
            (SELECT count(*)::int FROM stock_levels WHERE business_id = $1) AS "stockKeys",
            (SELECT count(*)::int FROM product_translations WHERE business_id = $1 AND lower(name) LIKE $2 || '%') AS "namePrefixMatches",
            (SELECT count(*)::int FROM products WHERE business_id = $1 AND lower(sku) LIKE $3 || '%') AS "armPrefixMatches"`,
    [A.businessId, MIRROR_NAME_PREFIX, ARM_PREFIX],
  );
  return must(r.rows[0]);
}

/* ══════════════════════════════════════════════════════════════════════
 * PLAN CAPTURE — the Class P instrument (correction item 4)
 * ════════════════════════════════════════════════════════════════════ */

/** Every statement one read runs through `Database.scoped`, with its scope and parameters. */
async function capture(path: string): Promise<Captured[]> {
  const db = t.app.get(Database);
  const seen: Captured[] = [];
  const original = db.scoped.bind(db);
  const spy = vi.spyOn(db, 'scoped').mockImplementation((scope, text, params = []) => {
    seen.push({ scope: { ...scope }, text, params });
    return original(scope, text, params);
  });
  try {
    const r = await readAs(t, owner, A.businessId, path, 'en');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  } finally {
    spy.mockRestore();
  }
  return seen;
}

interface PlanNodeMetrics {
  readonly nodeType: string;
  readonly relation: string | null;
  readonly index: string | null;
  readonly indexCond: string | null;
  readonly actualRows: number | null;
  readonly actualLoops: number | null;
  readonly actualTotalMs: number | null;
  readonly planRows: number | null;
  readonly sharedHit: number | null;
  readonly sharedRead: number | null;
  readonly sortMethod: string | null;
  readonly sortSpaceKb: number | null;
  readonly rowsRemovedByFilter: number | null;
}

interface RawPlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Actual Total Time'?: number;
  readonly 'Plan Rows'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly 'Sort Method'?: string;
  readonly 'Sort Space Used'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly Plans?: readonly RawPlanNode[];
}

function flattenPlan(n: RawPlanNode): PlanNodeMetrics[] {
  const self: PlanNodeMetrics = {
    nodeType: n['Node Type'],
    relation: n['Relation Name'] ?? null,
    index: n['Index Name'] ?? null,
    indexCond: n['Index Cond'] ?? null,
    actualRows: n['Actual Rows'] ?? null,
    actualLoops: n['Actual Loops'] ?? null,
    actualTotalMs: n['Actual Total Time'] ?? null,
    planRows: n['Plan Rows'] ?? null,
    sharedHit: n['Shared Hit Blocks'] ?? null,
    sharedRead: n['Shared Read Blocks'] ?? null,
    sortMethod: n['Sort Method'] ?? null,
    sortSpaceKb: n['Sort Space Used'] ?? null,
    rowsRemovedByFilter: n['Rows Removed by Filter'] ?? null,
  };
  return [self, ...(n.Plans ?? []).flatMap(flattenPlan)];
}

/**
 * `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` every statement of an arm, as
 * `daftar_app` under its own scope so row security applies — the principal the
 * budget is measured through.
 *
 * Taken OUTSIDE every timed region, and that limitation is declared: this is a
 * plan captured at this moment, which is not provably the plan any individual
 * sample used.
 */
async function plansOf(path: string): Promise<{ text: string; nodes: PlanNodeMetrics[]; plan: unknown }[]> {
  const db = t.app.get(Database);
  const out: { text: string; nodes: PlanNodeMetrics[]; plan: unknown }[] = [];
  for (const c of await capture(path)) {
    const r = await db
      .scoped<{ 'QUERY PLAN': { Plan: RawPlanNode }[] }>(c.scope, `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE, FORMAT JSON) ${c.text}`, c.params)
      .catch((e: unknown) => ({ rows: [], error: e instanceof Error ? e.message : String(e) }) as never);
    const plan = (r.rows[0] as { 'QUERY PLAN'?: { Plan: RawPlanNode }[] } | undefined)?.['QUERY PLAN']?.[0]?.Plan;
    out.push({ text: c.text, nodes: plan === undefined ? [] : flattenPlan(plan), plan: plan ?? null });
  }
  return out;
}

/**
 * THE STRUCTURAL TEST OF "THE ARMS TERMINATE EARLY".
 *
 * Node by node, what changed between `limit = 10` and `limit = 50`. The
 * falsifiable prediction, from the suite's own leakproof finding, is that the
 * scan nodes read the SAME blocks and return the SAME rows at both limits —
 * because a sequential scan bounded only by its own filter does not care about
 * `limit` — and that the only growth is in a bounded sort over 5x the rows.
 *
 * `blocksGrowth` and `rowsGrowth` are the numbers that settle it. Near 1.0
 * means the cost is limit-independent and the true growth cannot be 1.64.
 * Materially above 1.0 means growth is structural and real, which is Class P.
 */
function planDelta(
  ten: readonly { text: string; nodes: PlanNodeMetrics[] }[],
  fifty: readonly { text: string; nodes: PlanNodeMetrics[] }[],
): unknown {
  const totals = (plans: readonly { nodes: PlanNodeMetrics[] }[]) => {
    const nodes = plans.flatMap((p) => p.nodes);
    return {
      blocks: nodes.reduce((s, n) => s + (n.sharedHit ?? 0) + (n.sharedRead ?? 0), 0),
      rows: nodes.reduce((s, n) => s + (n.actualRows ?? 0), 0),
      sortSpaceKb: nodes.reduce((s, n) => s + (n.sortSpaceKb ?? 0), 0),
      seqScans: nodes.filter((n) => n.nodeType === 'Seq Scan').map((n) => ({ relation: n.relation, rows: n.actualRows, blocks: (n.sharedHit ?? 0) + (n.sharedRead ?? 0), removedByFilter: n.rowsRemovedByFilter })),
      sorts: nodes.filter((n) => n.nodeType.includes('Sort')).map((n) => ({ method: n.sortMethod, spaceKb: n.sortSpaceKb, rows: n.actualRows })),
      topLevelMs: plans.reduce((s, p) => s + (p.nodes[0]?.actualTotalMs ?? 0), 0),
    };
  };
  const a = totals(ten);
  const b = totals(fifty);
  return {
    ten: a,
    fifty: b,
    blocksGrowth: a.blocks === 0 ? null : b.blocks / a.blocks,
    rowsGrowth: a.rows === 0 ? null : b.rows / a.rows,
    explainedTimeGrowth: a.topLevelMs === 0 ? null : b.topLevelMs / a.topLevelMs,
    interpretation:
      'blocksGrowth near 1.0 means the scans are limit-independent, so the operation cannot grow 1.6x with the page size and a 1.64 reading is not growth. Materially above 1.0 means the growth is structural (Class P).',
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * SETUP
 * ════════════════════════════════════════════════════════════════════ */

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

beforeAll(
  async () => {
    if (!ENABLED) return;
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
    owner = await registerActor(t, 'P4PERF diagnostic owner');
    A = await onboardS3Business(t, owner, `p4perfdiag${randomUUID().slice(0, 6)}`);
    await seed();
    tillSessionId = (
      await openTillSession(t, owner, A.businessId, { branchId: A.branchX, warehouseId: must(warehouses[0]) }, { terminalCode: 'p4perfdiag_1' })
    ).sessionId;

    // THE ACCEPTED SUITE ANALYZES AFTER THE SEED, AND SO DOES THIS CAMPAIGN —
    // identically and for the stated reason. A budget measured against a table
    // with no statistics is a number about the missing statistics, and this
    // project has one budget that cost 2.9 s before an ANALYZE and 122 ms
    // after it with no query and no migration change.
    await ownerPool().query('ANALYZE');
  },
  4 * 60 * 60 * 1000,
);

afterAll(async () => {
  if (!ENABLED) return;
  await t?.close();
  await resetData();
});

/* ══════════════════════════════════════════════════════════════════════
 * THE CAMPAIGN
 * ════════════════════════════════════════════════════════════════════ */

describe.skipIf(!ENABLED)('TL-P4-PERF-A-02 — POS P4-A ratio gate, diagnostic campaign (NO VERDICT)', () => {
  /**
   * PRECONDITIONS, AND THE ONLY ASSERTIONS IN THIS FILE.
   *
   * These do not judge performance. They establish that the campaign is about
   * the dataset the ruling freezes and that the planner could see it. A
   * campaign that skipped these could produce a confident correlation about
   * the wrong database.
   */
  it('PRECONDITION: the dataset is the accepted suite’s, and every relation has been analyzed', async () => {
    const v = await measuredVolume();
    const stats = await planningStatistics(ownerPool(), RELATIONS);
    console.info('[P4PERF] volume', JSON.stringify(v));
    console.info('[P4PERF] planningStatistics', JSON.stringify(stats, null, 1));

    expect(v.products).toBe(MIRROR_VOLUME.variants);
    expect(v.variants).toBe(MIRROR_VOLUME.variants + MIRROR_VOLUME.merchantVariants);
    expect(v.variantBarcodes).toBe(MIRROR_VOLUME.merchantVariants);
    expect(v.translations).toBe(MIRROR_VOLUME.variants);
    expect(v.stockKeys).toBe(MIRROR_VOLUME.variants * MIRROR_VOLUME.warehouses);
    expect(v.namePrefixMatches, 'a prefix read whose prefix matches nothing measures nothing').toBeGreaterThanOrEqual(50);
    expect(v.armPrefixMatches, 'the arm’s own prefix must match more than the larger page size').toBeGreaterThan(50);

    // Statistics must EXIST. Nothing here asserts what they say.
    for (const row of stats as { relname: string; analyzed_columns: string; last_analyze: string | null; last_autoanalyze: string | null }[]) {
      expect(Number(row.analyzed_columns), `${row.relname} has no pg_stats rows: a measurement on it is about the missing statistics`).toBeGreaterThan(0);
      expect(row.last_analyze ?? row.last_autoanalyze, `${row.relname} was never analyzed`).not.toBeNull();
    }
  });

  it(
    'CAMPAIGN: both arms, every pass, both orders, raw ordered series preserved',
    async () => {
      // ── The observer and the measured backend ─────────────────────────
      //
      // The measured work goes through supertest into the in-process Nest app,
      // which uses its own pool, so there is no single "measured client" whose
      // backend pid is stable across requests. The campaign therefore watches
      // the pid the application's pool actually uses for this scope, read once
      // through the same `Database.scoped` path the read uses.
      const db = t.app.get(Database);
      const scope: Scope = { tenantId: A.tenantId, businessId: A.businessId, actorUserId: owner.userId };
      const pidRow = await db
        .scoped<{ pid: number }>(scope, `SELECT pg_backend_pid() AS pid`, [])
        .catch(() => ({ rows: [{ pid: -1 }] }));
      const measuredPid = pidRow.rows[0]?.pid ?? -1;

      const observer = ownerPool();
      const inst = await buildInstruments(observer, measuredPid, RELATIONS);

      const env = await captureEnvironment({
        campaignId: 'pos-p4a',
        observer,
        measuredPid,
        relations: RELATIONS,
        gitSha: git(['rev-parse', 'HEAD']),
        gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        treeClean: git(['status', '--porcelain']) === '',
        host: inst.host,
        counterStatement: inst.pg.statement,
        observerConsistency: inst.observerConsistency,
      });
      console.info('[P4PERF] environment', JSON.stringify(env, null, 1));

      // ── Class P FIRST: the plans, before any noise explanation ────────
      const tenPlans = await plansOf(searchPath(ARM_PREFIX, 10));
      const fiftyPlans = await plansOf(searchPath(ARM_PREFIX, 50));
      const plans = planDelta(tenPlans, fiftyPlans);
      console.info('[P4PERF] planDelta', JSON.stringify(plans, null, 1));

      // ── Host baseline while the box is as quiet as it will be ─────────
      const baselineBefore = hostBaseline('before-campaign', env.server.dataDirectory ?? OUT_DIR);

      // ── The arms ──────────────────────────────────────────────────────
      const armOf = (limit: number) => ({
        label: `limit${limit}`,
        // The timed region is exactly the accepted suite's: one `readAs` and
        // nothing else. The response is RETURNED rather than discarded so the
        // status can be read after the clock stops — the accepted suite's
        // `expect(r.status).toBe(200)` serves the same purpose there.
        once: (): Promise<unknown> => readAs(t, owner, A.businessId, searchPath(ARM_PREFIX, limit), 'en'),
        outcomeOf: (v: unknown): number => (v as { status?: number }).status ?? -1,
        iterations: MIRROR_RUNS,
        warmup: MIRROR_WARMUP,
      });
      const forward = ARM_LIMITS.map(armOf);
      const reversed = [...ARM_LIMITS].reverse().map(armOf);

      const series: SeriesResult[] = [];
      const passes = selectedPasses();
      for (const spec of passes) {
        // BOTH ORDERS, which the accepted gate never runs.
        //
        // The gate always measures ten rows first and fifty second, so it has
        // never been tested for ORDER SENSITIVITY. If the ten-row arm is
        // systematically cold — cache, plan cache, or an autovacuum the first
        // arm triggered — the denominator is biased and the gate is partly
        // measuring arm order rather than growth. Running the same pass in
        // both orders makes that bias measurable instead of arguable, and it
        // is the specific form Class H takes for a ratio.
        for (const [order, arms] of [
          ['forward', forward],
          ['reversed', reversed],
        ] as const) {
          series.push(
            ...(await runPass({
              spec,
              arms,
              order,
              node: inst.node,
              host: inst.host,
              pg: inst.pg,
              observer,
              measuredPid,
              measuredClient: null,
            })),
          );
        }
      }

      const baselineAfter = hostBaseline('after-campaign', env.server.dataDirectory ?? OUT_DIR);

      // ── Raw series to disk, in order, untrimmed ───────────────────────
      const reports = series.map((s) => reportSeries(s, posQuantileIndex, writeSeries(OUT_DIR, 'pos-p4a', s)));

      // ── The ratio, and how much of it one sample can carry ────────────
      const ratios = (['clean', 'db', 'io-timed', 'wait'] as const).flatMap((pass) =>
        (['forward', 'reversed'] as const).flatMap((order) => {
          const ten = series.find((s) => s.pass === pass && s.order === order && s.arm === 'limit10');
          const fifty = series.find((s) => s.pass === pass && s.order === order && s.arm === 'limit50');
          if (ten === undefined || fifty === undefined) return [];
          return [
            {
              pass,
              order,
              // 1.6 is quoted as the SUBJECT of the analysis, never asserted.
              // `RATIO_50_OVER_10` itself is not imported and not touched.
              sensitivity: ratioSensitivity(
                ten.records.map((r) => r.durationMs),
                fifty.records.map((r) => r.durationMs),
                1.6,
                posQuantileIndex,
              ),
            },
          ];
        }),
      );
      console.info('[P4PERF] ratioSensitivity', JSON.stringify(ratios, null, 1));

      // ── WAS EVERY SAMPLE ACTUALLY THE OPERATION? ──────────────────────
      //
      // The first run of this campaign recorded a 15x step change — ~30 ms
      // samples collapsing to ~2 ms partway through and staying there — and an
      // unchecked harness would have reported that as a wonderful result. An
      // endpoint that starts REFUSING answers faster than one that works, so
      // the status of every sample is tabulated here and a non-200 anywhere
      // invalidates the series rather than flattering it.
      const outcomes = series.map((s) => {
        const hist: Record<string, number> = {};
        for (const r of s.records) hist[String(r.outcome)] = (hist[String(r.outcome)] ?? 0) + 1;
        return { pass: s.pass, order: s.order, arm: s.arm, statuses: hist };
      });
      console.info('[P4PERF] sampleOutcomes', JSON.stringify(outcomes));

      const path = writeReport(OUT_DIR, 'pos-p4a', {
        subject: 'tests/performance/pos-s3-budgets.test.ts:695 — GATE: fifty rows cost no more than 1.6x ten rows',
        correctedFrom: 'tests/performance/accounting-budgets.test.ts:55 A_POST_P95 — the campaign was re-aimed mid-build; see the companion accounting campaign.',
        verdict: 'NONE. This campaign has no pass/fail verdict and must not be used as acceptance evidence regardless of its number.',
        environment: env,
        passesRun: passes.map((p) => p.id),
        requestBudget: {
          perRun: passes.length * 2 * (MIRROR_RUNS + MIRROR_WARMUP),
          limiter: '300 requests / 60 s (apps/api/src/app/runtime.ts:116) — not disabled, not raised; the run is sized to fit under it',
        },
        mirrors: { MIRROR_RUNS, MIRROR_WARMUP, MIRROR_VOLUME, ARM_LIMITS, ARM_PREFIX, percentile: 'min(n-1, ceil(0.95*n)-1) = index 18 of 0..19 at n=20' },
        plans,
        planCaptures: { ten: tenPlans, fifty: fiftyPlans },
        hostBaseline: { before: baselineBefore, after: baselineAfter },
        sampleOutcomes: outcomes,
        ratios,
        series: reports,
      });
      console.info(`[P4PERF] report written: ${path}`);
      console.info(`[P4PERF] raw ordered series: ${OUT_DIR}`);

      inst.node.stop();
      inst.host.close();

      // NO ASSERTION ON ANY NUMBER. The campaign's only duty is to have
      // produced the series and the correlations; the classification is the
      // owner's, read off this report.
      expect(reports.length, 'every pass and both orders produced a series').toBe(passes.length * 2 * ARM_LIMITS.length);
      // The one correctness assertion: a sample that was not the operation is
      // not a sample. This guards the campaign's own validity, not a budget.
      for (const o of outcomes) {
        expect(Object.keys(o.statuses), `${o.pass}/${o.order}/${o.arm} recorded a non-200 sample: ${JSON.stringify(o.statuses)}`).toEqual(['200']);
      }
    },
    4 * 60 * 60 * 1000,
  );
});
