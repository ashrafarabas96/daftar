/**
 * P4-S3 — THE POS READ BUDGET, MEASURED (P4-AL-71 P4-A, P4-AL-72, P4-AL-74,
 * P4-AL-75).
 *
 * ── WHAT THIS FILE CLAIMS, AND WHAT IT DOES NOT ────────────────────────
 *
 * It claims two different kinds of thing, and says which is which, because a
 * test whose verdict is the machine's speed proves nothing either way:
 *
 *   GATES — deterministic properties of the QUERY. The index reach of every
 *   one of the five prefix arms, the absence of a sequential scan on the
 *   catalogue relations, the absence of `OFFSET`, a statement count
 *   independent of the row count, and the host-independent RATIO
 *   `p95(50 rows) ≤ 1.6 × p95(10 rows)`. These fail on a bad query on any
 *   host, fast or slow, and they are the cases that make this file RED-capable
 *   from its first commit (P4-AL-72).
 *
 *   A MEASUREMENT — the millisecond figure. P4-A's ceiling (p95 ≤ 150 ms) is
 *   asserted, with the budget written as a constant beside where it came from
 *   so that raising it would be visible in a diff. But a millisecond encodes
 *   this host's speed, so the number is also PRINTED in full — every sample,
 *   the scale, the realized volume and the planner statistics — and the
 *   reader is told plainly that a miss on a contended 4-CPU box is a
 *   measurement about the box until it is reproduced quietly. This suite must
 *   not be run beside another heavy run: `accounting-budgets.test.ts` once
 *   failed a p95 purely from contention and turned eight composed gates red.
 *
 * ── ANALYZE FIRST, ALWAYS (P4-AL-74) ───────────────────────────────────
 *
 * `[[daftar-a-benchmark-measures-what-the-planner-saw]]`: budget C cost 2.9 s
 * on a runner and 122 ms after one `ANALYZE`, with no query and no migration
 * change. So every relation is `ANALYZE`d after the seed, the planner
 * statistics of each one are read back, and a missing or null `last_analyze`
 * FAILS the suite rather than being measured around. The suite also measures
 * the SAME read before and after `ANALYZE` on the first run and prints both,
 * so the figure is reported with the evidence that statistics existed.
 *
 * ── MEASURED AS `daftar_app`, WITH THE RLS COST RECORDED (P4-AL-75) ────
 *
 * The budget is the figure through the HTTP application, which reads as
 * `daftar_app` with the scope GUCs a request sets and row security applied.
 * The same statements are then run on the same rows as the schema owner, who
 * bypasses row security, and the difference is PRINTED as the RLS cost. The
 * owner figure is never the budget and is never compared to it.
 *
 * ── THE VOLUME (P4-AL-73) ──────────────────────────────────────────────
 *
 * 5 000 variants × 3 warehouses — deliberately identical to the accepted
 * P3-S7 stock-page volume, which is what makes P4-A's anchor
 * (`phase3-s7-read-budgets.test.ts:56`) an anchor and not a guess — plus a
 * name, a SKU and a barcode on every one of them, because a prefix read whose
 * relations hold no prefixes measures nothing.
 *
 * The catalogue is seeded in bulk by the schema owner rather than through the
 * movement commands, and that difference is stated rather than hidden. P3-S7
 * drove its 50 000 purchases through `draftAndReceive` because a stock read's
 * CORRECTNESS depends on rows no trigger would have let a bad writer create,
 * and that seed took about two hours. What P4-A measures is the cost of five
 * index ranges over `products`, `product_variants`, `product_translations` and
 * `stock_levels`, and for that the only thing that matters is that those four
 * relations hold the SHAPE and the VOLUME the application would have written —
 * which the suite asserts, row by row and index by index, before it takes a
 * timing. The correctness of the same read against rows the real commands
 * wrote is `tests/integration/pos-s3-search.test.ts`'s job, and it is proved
 * there.
 *
 * `P4_PERF_SCALE` scales the volume. The default is 1 — the acceptance volume,
 * which is what "measure at acceptance scale, not on three rows" requires.
 * Tier 1 is `P4_PERF_SCALE=0.1`: THE SAME CEILINGS on less data, a
 * deliberately weaker claim, never a reduced dataset to make a number pass.
 * The generator asserts the volume it actually realized, and the printed
 * evidence says which scale produced it.
 *
 * ── P4-B IS NOT MEASURED HERE, AND WHY ─────────────────────────────────
 *
 * P4-B is "server-side cart recomputation, 20 lines with discounts and tax",
 * p95 ≤ 60 ms. Its subject is the cart — `pos_cart_lines` and
 * `pos_till_sessions`, created by migration `0079`, which only agent E may
 * write — and the recomputation command, which is agent B's. Neither exists
 * at this commit, and no document in this repository states those relations'
 * columns, so there is nothing to measure and nothing may be invented to
 * stand in for it. A budget case asserting a ceiling on a fabricated cart
 * would be the exact "green gate that cannot be red" this estate refuses. So
 * P4-B is REPORTED as blocked rather than faked; the case belongs in this file
 * and is added the moment `0079` and the cart command land.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────
 *
 * Alone. `PG_PORT=55140 PG_DIR=/tmp/daftar-pg-c`, never beside another
 * `PG_DIR` user and never beside another timing suite.
 */
import { cpus, loadavg, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { addWarehouse } from '../helpers/stock-ledger';
import { readAs } from '../helpers/merchant-reads';
import { Database, type Scope } from '../../apps/api/src/infra/database';

/**
 * P4-AL-71, verbatim. Milliseconds, a ceiling on p95.
 *
 * P4-A — "POS search: one 50-row page by name/SKU/barcode prefix, over HTTP",
 * anchored to the accepted P3-S7 stock page: identical shape, volume and
 * principal (`phase3-s7-read-budgets.test.ts:56`). Never raise it to obtain a
 * pass.
 */
const BUDGET = { A_POS_SEARCH_P95: 150 } as const;

/**
 * P4-AL-72's host-independent ratio for this read.
 *
 * The keyset reads get `p95(page 20) ≤ 1.2 × p95(page 1)`; this read has no
 * page two, so the comparable property is how its cost grows with the PAGE
 * SIZE: five index ranges each bounded by `limit + 1`, then a sort over at
 * most `5 × (limit + 1)` rows. Five times the rows must not cost anything like
 * five times the time — if it does, the arms are not early-terminating and
 * something is scanning. `1.6` is the slack a bounded sort of 255 rows instead
 * of 55 may take; it is a property of the query, measured on the same host in
 * the same run, so it carries no millisecond.
 */
const RATIO_50_OVER_10 = 1.6;

const SCALE = ((): number => {
  const raw = process.env['P4_PERF_SCALE'];
  if (raw === undefined || raw === '') return 1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`P4_PERF_SCALE must be in (0, 1], got ${raw}`);
  return n;
})();

const scaled = (n: number): number => Math.max(1, Math.round(n * SCALE));

/** P4-AL-73's POS half: the accepted P3-S7 catalogue volume, exactly. */
const VOLUME = { variants: scaled(5_000), warehouses: 3 } as const;

const WARMUP = 5;
const RUNS = 20;
/** Rows inserted per statement while seeding. */
const BATCH = 500;

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let warehouses: string[];
/** A prefix that matches many names, and one that matches exactly one barcode. */
const NAME_PREFIX = 'pos item 1';
let oneBarcode: string;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly Plans?: readonly PlanNode[];
}

const nodesOf = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodesOf)];

interface Captured {
  readonly scope: Scope;
  readonly text: string;
  readonly params: unknown[];
}

/**
 * The CATALOGUE, in bulk, with every prefix the read searches on.
 *
 * `POS Item <n>` as the `en` name, `POS-SKU-<n>` as the SKU and
 * `79<n padded>` as the barcode, on a product and on its base variant's
 * stock key in all three warehouses. Deterministic: the same dataset on
 * every run, so two runs' numbers are comparable.
 */
async function seed(): Promise<void> {
  const pool = ownerPool();
  warehouses = [A.w1, A.w2, await addWarehouse(pool, A.businessId, A.branchX, 'POS W3')];

  for (let from = 0; from < VOLUME.variants; from += BATCH) {
    const to = Math.min(VOLUME.variants, from + BATCH);
    await pool.query(
      `WITH g AS (SELECT n FROM generate_series($2::int, $3::int - 1) n),
            p AS (
              INSERT INTO products (business_id, id, base_price_minor, price_currency, status,
                                    track_inventory, unit_code, unit_decimals, sku, barcode)
              SELECT $1, gen_random_uuid(), 1000 + g.n, 'ILS', 'active', true, 'piece', 0,
                     'POS-SKU-' || g.n::text, '79' || lpad(g.n::text, 11, '0')
                FROM g
              RETURNING business_id, id, sku
            ),
            tr AS (
              INSERT INTO product_translations (business_id, product_id, locale, name)
              SELECT p.business_id, p.id, 'en', 'POS Item ' || substring(p.sku from 9)
                FROM p
              RETURNING 1
            ),
            v AS (
              INSERT INTO product_variants (business_id, id, product_id, is_base, status)
              SELECT p.business_id, gen_random_uuid(), p.id, true, 'active' FROM p
              RETURNING business_id, id
            )
       INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor)
       SELECT $4::uuid, v.business_id, w.id, v.id, 5, 500
         FROM v CROSS JOIN (SELECT unnest($5::uuid[]) AS id) w`,
      [A.businessId, from, to, A.tenantId, warehouses],
    );
  }
  oneBarcode = `79${String(VOLUME.variants - 1).padStart(11, '0')}`;
}

interface Volume {
  products: number;
  variants: number;
  translations: number;
  stockKeys: number;
  namePrefixMatches: number;
}

async function measuredVolume(): Promise<Volume> {
  const r = await ownerPool().query<Volume>(
    `SELECT (SELECT count(*)::int FROM products WHERE business_id = $1 AND status = 'active' AND sku LIKE 'POS-SKU-%') AS products,
            (SELECT count(*)::int FROM product_variants v JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
              WHERE v.business_id = $1 AND p.sku LIKE 'POS-SKU-%') AS variants,
            (SELECT count(*)::int FROM product_translations WHERE business_id = $1 AND name LIKE 'POS Item %') AS translations,
            (SELECT count(*)::int FROM stock_levels WHERE business_id = $1) AS "stockKeys",
            (SELECT count(*)::int FROM product_translations WHERE business_id = $1 AND lower(name) LIKE $2 || '%') AS "namePrefixMatches"`,
    [A.businessId, NAME_PREFIX],
  );
  return must(r.rows[0]);
}

/** Every relation the read touches, with when PostgreSQL last gathered statistics for it. */
async function planningStatistics(): Promise<Record<string, { rows: number; analyzed: string | null }>> {
  const r = await ownerPool().query<{ relname: string; n_live_tup: string; last_analyze: Date | null; last_autoanalyze: Date | null }>(
    `SELECT relname, n_live_tup::text, last_analyze, last_autoanalyze
       FROM pg_stat_user_tables WHERE relname = ANY($1::text[])`,
    [['products', 'product_variants', 'product_translations', 'stock_levels', 'warehouses', 'businesses']],
  );
  const out: Record<string, { rows: number; analyzed: string | null }> = {};
  for (const row of r.rows) {
    const when = row.last_analyze ?? row.last_autoanalyze;
    out[row.relname] = { rows: Number.parseInt(row.n_live_tup, 10), analyzed: when === null ? null : when.toISOString() };
  }
  return out;
}

const searchPath = (q: string, limit: number): string => `/v1/pos/products?warehouseId=${must(warehouses[0])}&q=${encodeURIComponent(q)}&limit=${limit}`;

/** Every statement one read runs through `Database.scoped`, with its own scope and parameters. */
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

/** EXPLAIN every captured statement under its own scope, as `daftar_app`, row security applied (P4-AL-75). */
async function plansOf(path: string): Promise<{ readonly text: string; readonly nodes: PlanNode[]; readonly json: string }[]> {
  const db = t.app.get(Database);
  const out: { text: string; nodes: PlanNode[]; json: string }[] = [];
  for (const c of await capture(path)) {
    const r = await db.scoped<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(c.scope, `EXPLAIN (FORMAT JSON) ${c.text}`, c.params);
    const plan = must(must(r.rows[0])['QUERY PLAN'][0]).Plan;
    out.push({ text: c.text, nodes: nodesOf(plan), json: JSON.stringify(plan) });
  }
  return out;
}

interface Measurement {
  readonly name: string;
  readonly budgetMs: number | null;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly samplesMs: readonly number[];
}

async function measure(name: string, budgetMs: number | null, path: string): Promise<Measurement> {
  for (let i = 0; i < WARMUP; i += 1) expect((await readAs(t, owner, A.businessId, path, 'en')).status).toBe(200);
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = process.hrtime.bigint();
    const r = await readAs(t, owner, A.businessId, path, 'en');
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    expect(r.status).toBe(200);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (q: number): number => must(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]);
  return { name, budgetMs, p50: rank(0.5), p95: rank(0.95), max: must(sorted.at(-1)), samplesMs: samples };
}

/** The same statements on the same rows as the schema owner, who bypasses row security: the RLS COST, never the budget. */
async function ownerCost(path: string): Promise<number> {
  const statements = await capture(path);
  const pool = ownerPool();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = process.hrtime.bigint();
    for (const c of statements) await pool.query(c.text, c.params);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return must(sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]);
}

const INDEX_ACCESS = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

function usesIndex(nodes: readonly PlanNode[], index: string): boolean {
  return nodes.some((n) => INDEX_ACCESS.has(n['Node Type']) && n['Index Name'] === index);
}

/** The whole point of the prefix design: the LIKE must have become an index RANGE, not a filter. */
function indexRangeOn(nodes: readonly PlanNode[], index: string): boolean {
  return nodes.some((n) => n['Index Name'] === index && /\s>=\s/.test(n['Index Cond'] ?? '') && /\s<\s/.test(n['Index Cond'] ?? ''));
}

/** Taken BEFORE and AFTER the seed's ANALYZE, so the figure is reported with the evidence that statistics existed. */
let beforeAnalyze: Measurement | null = null;

beforeAll(
  async () => {
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
    owner = await registerActor(t, 'POS S3 budget owner');
    A = await onboardS3Business(t, owner, `posperf${randomUUID().slice(0, 6)}`);
    await seed();

    // P4-AL-74 in one measurement: the SAME read, on the SAME rows, with and
    // without planner statistics. Printed, never asserted — it exists so the
    // budget's number can never be mistaken for a number about missing
    // statistics.
    beforeAnalyze = await measure('POS search, 50 rows, BEFORE ANALYZE', null, searchPath(NAME_PREFIX, 50));
    await ownerPool().query('ANALYZE');
  },
  4 * 60 * 60 * 1000,
);

afterAll(async () => {
  await t.close();
  await resetData();
});

describe(`P4-A — the POS type-ahead (scale ${SCALE}, ${SCALE === 1 ? 'acceptance volume' : 'Tier 1, same ceilings on less data'})`, () => {
  it('the seeded volume is P4-AL-73’s, and the prefix actually matches a page of rows', async () => {
    const v = await measuredVolume();
    console.info('[P4-A] volume', JSON.stringify({ scale: SCALE, ...v, cpus: cpus().length, totalmemGiB: Math.round(totalmem() / 2 ** 30) }));
    expect(v.products).toBe(VOLUME.variants);
    expect(v.variants, 'one base variant per product').toBe(VOLUME.variants);
    expect(v.translations).toBe(VOLUME.variants);
    expect(v.stockKeys, 'every variant holds stock in all three warehouses').toBe(VOLUME.variants * VOLUME.warehouses);
    expect(v.namePrefixMatches, 'a prefix read whose prefix matches nothing measures nothing').toBeGreaterThanOrEqual(50);
  });

  it('every relation this read touches has planner statistics — a null fails the suite (P4-AL-74)', async () => {
    const stats = await planningStatistics();
    console.info('[P4-A] planningStatistics', JSON.stringify(stats));
    for (const relation of ['products', 'product_variants', 'product_translations', 'stock_levels', 'warehouses', 'businesses']) {
      expect(stats[relation], `${relation} has no row in pg_stat_user_tables`).toBeDefined();
      expect(stats[relation]?.analyzed, `${relation} was never ANALYZEd — a budget measured without statistics is a number about the statistics`).not.toBeNull();
    }
  });

  /**
   * GATE. Deterministic on any host: every one of the five prefix arms must
   * reach its own index AS A RANGE, and nothing may scan a catalogue relation
   * sequentially. This is the case that would catch the two things that would
   * silently destroy this read — a substring predicate, and a generic plan
   * that demotes the prefix to a filter.
   */
  it('GATE: all five prefix arms become index RANGES, and nothing scans a catalogue relation sequentially', async () => {
    const plans = await plansOf(searchPath('pos-', 50));
    for (const p of plans) console.info('[P4-A] plan', p.json);
    const nodes = plans.flatMap((p) => p.nodes);

    for (const index of ['products_barcode_uq', 'products_sku_uq', 'variants_barcode_uq', 'variants_sku_uq', 'product_translations_name_idx']) {
      expect(usesIndex(nodes, index), `the arm served by ${index} must reach it`).toBe(true);
    }
    for (const index of ['products_sku_uq', 'variants_sku_uq', 'product_translations_name_idx']) {
      expect(indexRangeOn(nodes, index), `${index} must carry a >= / < RANGE: a prefix demoted to a Filter scans the whole business`).toBe(true);
    }
    expect(
      nodes.filter((n) => n['Node Type'] === 'Seq Scan' && ['products', 'product_variants', 'product_translations', 'stock_levels'].includes(n['Relation Name'] ?? '')),
      'no sequential scan on a catalogue relation',
    ).toEqual([]);
  });

  /** GATE. `OFFSET` is forbidden to every read module, and this read has no page two to need one. */
  it('GATE: no statement of this read uses OFFSET', async () => {
    const statements = await capture(searchPath('pos-', 50));
    for (const c of statements) expect(c.text, c.text.slice(0, 120)).not.toMatch(/\bOFFSET\b/i);
  });

  /** GATE. P4-AL-72: a statement count independent of the row count. */
  it('GATE: the statement count is the same for one row and for fifty, and the same at any volume', async () => {
    const one = await capture(searchPath(oneBarcode, 50));
    const fifty = await capture(searchPath('pos-', 50));
    console.info('[P4-A] statements', JSON.stringify({ oneRow: one.length, fiftyRows: fifty.length }));
    expect(fifty.length).toBe(one.length);
    expect(one.length, 'the facts statement and the search statement, and nothing per row').toBe(2);
  });

  /** GATE. Host-independent: the shape of the growth, measured on this host in this run. */
  it('GATE: fifty rows cost no more than 1.6× ten rows — the arms terminate early', async () => {
    const ten = await measure('POS search, 10 rows', null, searchPath('pos-', 10));
    const fifty = await measure('POS search, 50 rows', null, searchPath('pos-', 50));
    const ratio = fifty.p95 / ten.p95;
    console.info('[P4-A] ratio', JSON.stringify({ p95_10: ten.p95, p95_50: fifty.p95, ratio, ceiling: RATIO_50_OVER_10 }));
    expect(ratio).toBeLessThanOrEqual(RATIO_50_OVER_10);
  });

  /**
   * A MEASUREMENT, and it says so.
   *
   * The ceiling is P4-A's own and is not raised. But the verdict of this one
   * case is partly this host's speed, so everything a reader needs to judge it
   * is printed: the scale, every sample, the load average at the time, the
   * before-ANALYZE figure for comparison, and the owner-side figure as the RLS
   * cost. A miss on a contended box is a measurement about the box until it
   * reproduces on a quiet one; the four GATE cases above are what hold the
   * query itself, and they do not care how fast the machine is.
   */
  it(`MEASUREMENT: p95 of ${RUNS} warm runs of the 50-row page is within P4-A (${BUDGET.A_POS_SEARCH_P95} ms)`, async () => {
    const byName = await measure('POS search, 50 rows, name prefix', BUDGET.A_POS_SEARCH_P95, searchPath(NAME_PREFIX, 50));
    const bySku = await measure('POS search, 50 rows, SKU prefix', BUDGET.A_POS_SEARCH_P95, searchPath('pos-sku-1', 50));
    const byBarcode = await measure('POS search, one barcode', BUDGET.A_POS_SEARCH_P95, searchPath(oneBarcode, 50));
    const rlsCost = { name: await ownerCost(searchPath(NAME_PREFIX, 50)) };

    const round = (m: Measurement): unknown => ({ ...m, samplesMs: m.samplesMs.map((x) => Math.round(x * 100) / 100) });
    console.info(
      '[P4-A] budget',
      JSON.stringify({
        scale: SCALE,
        loadavg: loadavg(),
        beforeAnalyze: beforeAnalyze === null ? null : round(beforeAnalyze),
        measured: [byName, bySku, byBarcode].map(round),
        rlsCostP95MsAsOwner: rlsCost,
        note: 'the daftar_app figure IS the budget; the owner figure is the RLS cost and is never compared to the ceiling',
      }),
    );

    for (const m of [byName, bySku, byBarcode]) {
      expect(m.p95, `${m.name}: p95 ${m.p95.toFixed(1)} ms against P4-A's ${BUDGET.A_POS_SEARCH_P95} ms`).toBeLessThanOrEqual(BUDGET.A_POS_SEARCH_P95);
    }
  });
});

/**
 * P4-B has no subject at this commit, and this case says so out loud rather
 * than leaving a silent gap in the file that is supposed to measure it.
 *
 * It asserts the FACT that makes P4-B unmeasurable — that neither POS relation
 * exists yet — so that the day migration `0079` creates them, this case turns
 * RED and whoever is holding the slice is told, by name, that the P4-B
 * measurement is now owed. A comment would not have done that.
 */
describe('P4-B — server-side cart recomputation', () => {
  it('is not measured here, and the reason is checkable: neither POS relation exists yet', async () => {
    const r = await ownerPool().query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relname = ANY($1::text[])`, [
      ['pos_till_sessions', 'pos_cart_lines'],
    ]);
    expect(
      r.rows.map((x) => x.relname),
      'pos_till_sessions / pos_cart_lines now exist: migration 0079 has landed, so the P4-B budget case is owed in this file',
    ).toEqual([]);
  });
});
