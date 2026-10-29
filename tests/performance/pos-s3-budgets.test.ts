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
 * ── P4-B IS MEASURED HERE NOW, AND WAS NOT ─────────────────────────────
 *
 * P4-B is "server-side cart recomputation, 20 lines with discounts and tax",
 * p95 ≤ 60 ms. Its subject is the cart — `pos_cart_lines` and
 * `pos_till_sessions`, created by migration `0079` — and the recomputation
 * command behind `PATCH .../cart-lines/:cartLineId`. While neither existed,
 * this file REPORTED P4-B as blocked rather than faking it, and asserted the
 * fact that made it unmeasurable so that the day the relations landed the case
 * would turn red and call the measurement in. `0079` and the cart routes have
 * landed, the case did turn red, and the measurement is now in this file. See
 * the `P4-B` describe block for what is timed and why tax is zero.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────
 *
 * Alone. `PG_PORT=55140 PG_DIR=/tmp/daftar-pg-c`, never beside another
 * `PG_DIR` user and never beside another timing suite.
 */
import { cpus, loadavg, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { openTillSession } from '../helpers/pos-till-sessions';
import { asMember, must, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { INTERNAL, addWarehouse, setScope } from '../helpers/stock-ledger';
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
const BUDGET = { A_POS_SEARCH_P95: 150, B_POS_CART_P95: 60 } as const;

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
/**
 * `merchantVariants` is the population the BARCODE arm on `product_variants`
 * is measured against, and it exists because the arm had none.
 *
 * The base variants this seed creates carry NO barcode and cannot: a base
 * variant is system stock identity, and `daftar_inventory_internal`'s INSERT
 * grant is exactly `(business_id, id, product_id, is_base)` (`0053:257`). So
 * every one of the 5 000 variants had `barcode IS NULL`, both partial barcode
 * indexes on `product_variants` were EMPTY, and the arm's gate was asserting a
 * plan shape over an index with nothing in it — measured: `pg_stats.null_frac`
 * 1.0, `reltuples` 0, and the planner choosing a Sort over the unique index by
 * a 2.24-unit cost margin computed from two zero-row estimates. A barcode on
 * even ONE merchant variant makes the arm range.
 *
 * A separate namespace on purpose: `catalog_identifiers_sync` enforces
 * identifier uniqueness ACROSS the two tables, so these take `68…` barcodes
 * where the products take `79…`. And their SKUs are `VAR-SKU-…`, deliberately
 * NOT under `pos-`, so adding them does not change which rows the SKU and NAME
 * arms match and therefore does not move what the P4-A budget measures.
 */
const VOLUME = { variants: scaled(5_000), warehouses: 3, merchantVariants: scaled(500) } as const;

const WARMUP = 5;
const RUNS = 20;
/** Rows inserted per statement while seeding. */
const BATCH = 500;

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let warehouses: string[];
/** The owner's open till at `warehouses[0]` — the read's whole scope (RULING 2). */
let tillSessionId: string | undefined;
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

  // The TRACKING columns are written as the INVENTORY PRINCIPAL, under scope,
  // exactly as `configureRaw` writes them. `products.track_inventory`,
  // `unit_code` and `unit_decimals` belong to the inventory configuration
  // command: a direct write by anyone else is refused by
  // `inventory.configuration_authority_required`, and that refusal is correct
  // and is not worked around here. The seed takes the same role the command
  // takes — the documented mechanism (`inventory-db-authority.test.ts:446-452`)
  // — so no guard, trigger or policy is disabled or bypassed. (The principal
  // holds UPDATE on these columns and no INSERT on `products` at all, which is
  // why this is a second statement rather than part of the insert above.)
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
    // The base variant and the stock keys, as the same principal and for the
    // same reason: a base variant is system stock identity, not a merchant
    // object, so anyone else inserting one is refused by
    // `catalog.base_variant_not_mutable`. Its insert grant covers exactly
    // `(business_id, id, product_id, is_base)` — `status` is deliberately NOT
    // in the grant, so it is left to its default rather than named.
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
  oneBarcode = `79${String(VOLUME.variants - 1).padStart(11, '0')}`;
}

/**
 * The merchant variants, with barcodes: the only rows either barcode index on
 * `product_variants` will ever hold in this dataset, and the reason the arm's
 * gate has a subject at all. Written as the merchant principal the seed
 * already runs as, because a barcode IS a merchant identifier — the inventory
 * principal has no grant on the column and should not.
 */
async function seedMerchantVariants(c: PoolClient): Promise<void> {
  for (let from = 0; from < VOLUME.merchantVariants; from += BATCH) {
    const to = Math.min(VOLUME.merchantVariants, from + BATCH);
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
  for (let from = 0; from < VOLUME.variants; from += BATCH) {
    const to = Math.min(VOLUME.variants, from + BATCH);
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
}

async function measuredVolume(): Promise<Volume> {
  const r = await ownerPool().query<Volume>(
    `SELECT (SELECT count(*)::int FROM products WHERE business_id = $1 AND status = 'active' AND sku LIKE 'POS-SKU-%') AS products,
            (SELECT count(*)::int FROM product_variants v JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
              WHERE v.business_id = $1 AND p.sku LIKE 'POS-SKU-%') AS variants,
            (SELECT count(*)::int FROM product_variants v JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
              WHERE v.business_id = $1 AND p.sku LIKE 'POS-SKU-%' AND v.barcode IS NOT NULL AND v.status <> 'archived') AS "variantBarcodes",
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

/**
 * The till names its SESSION and the server derives the warehouse (RULING 2).
 *
 * This used to send `warehouseId=${warehouses[0]}`, which the route has
 * refused since `PosProductSearchQuerySchema` became `.strict()` around
 * `sessionId`: every call answered 400 with `{"path":"sessionId","code":
 * "invalid_type"}` plus `unrecognized_keys`, and because the first such call
 * is in this suite's own `beforeAll`, all ten of its cases reported as
 * SKIPPED rather than run — a suite that measured nothing and said so only in
 * the word "skipped". The fix is to open a real till in the fixture and name
 * it here; it is NOT to re-add `warehouseId`, which is exactly the client
 * naming its own read scope that `P4-AL-18` forbids.
 *
 * The session is opened at `warehouses[0]`, so every figure below is still
 * measured against the same warehouse the seed stocks and the same statement
 * the planner saw.
 */
const searchPath = (q: string, limit: number): string => `/v1/pos/products?sessionId=${must(tillSessionId)}&q=${encodeURIComponent(q)}&limit=${limit}`;

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

/**
 * The indexes either barcode arm may legitimately range on. `0079`'s
 * byte-order index can on any cluster; `0005`'s unique index can only where
 * the database default collation is `C` or `POSIX`.
 */
const BARCODE_INDEXES = {
  products: ['products_barcode_prefix_c_idx', 'products_barcode_uq'],
  product_variants: ['variants_barcode_prefix_c_idx', 'variants_barcode_uq'],
} as const;

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

    // The read's scope, opened through `POST /v1/pos/till-sessions` — the real
    // route, in the real composition, as the owner. Nothing here inserts a
    // session row: `daftar_app` holds SELECT only on `pos_till_sessions`
    // (`0079:605`), so a fixture that tried would be refused by the grant, and
    // a measurement taken against a hand-seeded session would be a measurement
    // of a path no cashier can reach.
    tillSessionId = (await openTillSession(t, owner, A.businessId, { branchId: A.branchX, warehouseId: must(warehouses[0]) }, { terminalCode: 'posperf_1' }))
      .sessionId;

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
    expect(v.variants, 'one base variant per product, plus the barcoded merchant variants').toBe(VOLUME.variants + VOLUME.merchantVariants);
    expect(v.variantBarcodes, 'the barcode arm on product_variants must have a subject').toBe(VOLUME.merchantVariants);
    expect(v.translations).toBe(VOLUME.variants);
    expect(v.stockKeys, 'every variant holds stock in all three warehouses').toBe(VOLUME.variants * VOLUME.warehouses);
    expect(v.namePrefixMatches, 'a prefix read whose prefix matches nothing measures nothing').toBeGreaterThanOrEqual(50);
  });

  it('every relation this read touches has planner statistics — a null fails the suite (P4-AL-74)', async () => {
    const stats = await planningStatistics();
    console.info('[P4-A] planningStatistics', JSON.stringify(stats));
    for (const relation of ['products', 'product_variants', 'product_translations', 'stock_levels', 'warehouses', 'businesses']) {
      expect(stats[relation], `${relation} has no row in pg_stat_user_tables`).toBeDefined();
      expect(
        stats[relation]?.analyzed,
        `${relation} was never ANALYZEd — a budget measured without statistics is a number about the statistics`,
      ).not.toBeNull();
    }
  });

  /**
   * GATE. The whole measured story of this read's plan — and, since 2026-10-03,
   * the case that caught the slice's own worst defect.
   *
   * The two BARCODE arms must carry a `>= / <` RANGE on their own index. That
   * is the scanner path — the one a cashier drives hundreds of times a shift —
   * and it is the one this estate's row security permits to be ranged at all.
   *
   * THE INDEX NAMED HERE IS NOT AN ACCIDENT, and it is not `0005`'s unique
   * index. PostgreSQL derives a prefix range from `^@` only when the index's
   * collation is byte order, and it recognises `C` and `POSIX` and nothing
   * else — not `C.utf8`, not `en_US.utf8`. `variants_barcode_uq` is on the
   * database default collation, so on any cluster not initialised with the
   * bare `C` locale this arm had NO range: it read its index on `business_id`
   * alone and filtered every barcode in the business, and the products arm
   * fell to a Seq Scan. `0079` adds the two byte-order indexes this case
   * names, for exactly that reason.
   *
   * THIS CASE IS THEREFORE NOT "deterministic on any host", which is what the
   * comment here used to claim. Its verdict depends on the cluster's
   * collation, and the comment that denied it was the reason a green local run
   * was mistaken for a fact about the deployment target for as long as it was.
   * It is written down rather than smoothed over.
   *
   * The SKU and NAME arms are deliberately NOT asserted here, and the next
   * case is why: under this RLS shape they cannot be ranged by ANY predicate,
   * so with a broad prefix the planner correctly prefers a bounded sequential
   * scan to an index walk it cannot narrow. A gate demanding an index range
   * there would be a gate with no subject; a gate demanding "no Seq Scan"
   * would be a gate demanding a WORSE plan. So the measured truth is asserted
   * where it is true, and stated by name where it is not.
   */
  it('GATE: the two BARCODE arms carry a >= / < index range — the till’s scanner path', async () => {
    const plans = await plansOf(searchPath('pos-', 50));
    for (const p of plans) console.info('[P4-A] plan', p.json);
    const nodes = plans.flatMap((p) => p.nodes);

    // The SKU arm is named exactly; the barcode arm is named as a SET, and the
    // next paragraph of the doc comment is why. On a cluster initialised with
    // the bare `C` locale BOTH `0005`'s unique index and `0079`'s byte-order
    // index can carry the range, and which one the planner picks is not a
    // claim this product makes. On every other cluster only the byte-order
    // one can. So the gate asserts the thing the till actually needs — that
    // the arm reaches SOME index able to range — and asserting one name would
    // have made this case's verdict the host's collation all over again.
    expect(usesIndex(nodes, 'variants_sku_uq'), 'the arm served by variants_sku_uq must reach it').toBe(true);
    expect(
      BARCODE_INDEXES.product_variants.some((i) => usesIndex(nodes, i)),
      `the barcode arm must reach one of ${BARCODE_INDEXES.product_variants.join(' / ')}`,
    ).toBe(true);

    const barcodePlans = await plansOf(searchPath(oneBarcode, 50));
    // Printed for the same reason the prefix plan above is: the assertion that
    // follows is about a plan, so the plan it judged is part of the record.
    for (const p of barcodePlans) console.info('[P4-A] barcode plan', p.json);
    const barcodeNodes = barcodePlans.flatMap((p) => p.nodes);
    for (const [table, candidates] of Object.entries(BARCODE_INDEXES)) {
      expect(
        candidates.some((i) => indexRangeOn(barcodeNodes, i)),
        `the ${table} barcode arm must carry a >= / < RANGE on one of ${candidates.join(' / ')} — a scanned barcode is the till's hot path, and only a byte-order index makes ^@ a range`,
      ).toBe(true);
    }

    // And the schema fact the range depends on, asserted where it is NOT a
    // property of the host: `0079`'s two indexes exist and order `barcode` in
    // collation C. Without this, a cluster that happens to be `C` would let
    // the case above pass over a schema that has no byte-order index at all,
    // which is the precise shape of the defect this case was changed to catch.
    const collations = await ownerPool().query<{ idx: string; collname: string }>(
      `SELECT ci.relname AS idx, c.collname
         FROM pg_index i
         JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_collation c ON c.oid = i.indcollation[1]
        WHERE ci.relname = ANY ($1::text[])`,
      [['products_barcode_prefix_c_idx', 'variants_barcode_prefix_c_idx']],
    );
    expect(collations.rows.map((r) => `${r.idx}:${r.collname}`).sort()).toEqual(['products_barcode_prefix_c_idx:C', 'variants_barcode_prefix_c_idx:C']);
  });

  /**
   * THE FINDING, as an executable statement rather than a comment.
   *
   * Measured, as the owner and as `daftar_app`, on the same rows:
   *
   *   | predicate                  | owner       | daftar_app  |
   *   |----------------------------|-------------|-------------|
   *   | `barcode LIKE $p || '%'`   | index RANGE | no range    |
   *   | `barcode ^@ $p`            | index RANGE | index RANGE |
   *   | `lower(sku) ^@ $p`         | index RANGE | no range    |
   *   | `lower(name) ^@ $p`        | index RANGE | no range    |
   *
   * The owner bypasses row security; `daftar_app` does not. Under RLS these
   * relations carry a PERMISSIVE `tenant_membership` policy whose qual is a
   * SUBQUERY, which makes the scan a security barrier, and a user qual may
   * only be pushed below a security barrier if it is LEAKPROOF. `lower` is
   * not, so an index on `lower(x)` cannot be ranged by any predicate from
   * `daftar_app`; `starts_with` is, which is why the barcode arms keep their
   * range and `LIKE` would not.
   *
   * This case asserts the `pg_proc` facts the conclusion rests on. It is
   * RED-capable in the useful direction: if a later PostgreSQL, or an estate
   * decision, marks `lower` leakproof, this case fails and tells whoever is
   * holding the slice that the SKU and NAME arms can now be ranged and the
   * gate above should be widened. The remedy is NOT another index — the five
   * indexes are the right five — and it is a migration either way, so this
   * suite measures and reports it rather than acting on it.
   */
  it('FINDING: lower() is not leakproof, so the SKU and NAME arms cannot be index ranges under this RLS shape', async () => {
    const r = await ownerPool().query<{ proname: string; proleakproof: boolean }>(
      `SELECT proname, proleakproof FROM pg_proc WHERE proname = ANY($1::text[]) ORDER BY proname, pronargs`,
      [['lower', 'textlike', 'like_escape', 'starts_with', 'text_ge', 'text_lt', 'uuid_eq']],
    );
    const leakproof = new Map<string, boolean>();
    for (const row of r.rows) leakproof.set(row.proname, (leakproof.get(row.proname) ?? true) && row.proleakproof);
    console.info('[P4-A] leakproof', JSON.stringify([...leakproof]));

    expect(leakproof.get('uuid_eq'), 'business_id = x is leakproof, which is why every arm reaches its index at all').toBe(true);
    expect(leakproof.get('starts_with'), '^@ is leakproof, which is what gives the barcode arms their range under RLS').toBe(true);
    expect(leakproof.get('textlike'), 'LIKE is NOT leakproof — this is why this read does not use it').toBe(false);
    expect(
      leakproof.get('lower'),
      'lower() is NOT leakproof. If this ever becomes true, the SKU and NAME arms can be ranged and the plan gate above should require it.',
    ).toBe(false);

    // And the consequence, in the plan of the statement this module actually
    // ran: no index range on either `lower(...)` index, which is why a broad
    // prefix becomes a bounded sequential scan of the catalogue rather than an
    // index walk. The rows scanned are PRINTED, so a reader can see the cost
    // this policy shape carries at acceptance volume.
    const nodes = (await plansOf(searchPath('pos-', 50))).flatMap((p) => p.nodes);
    expect(indexRangeOn(nodes, 'products_sku_uq'), 'the SKU arm cannot range inside its index').toBe(false);
    expect(indexRangeOn(nodes, 'product_translations_name_idx'), 'the NAME arm cannot range inside its index').toBe(false);
    console.info(
      '[P4-A] unrangedArms',
      JSON.stringify({
        scannedRelations: nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name'] ?? '?'),
        note: 'the SKU and NAME arms scan and sort, bounded by their own LIMIT; the remedy is a migration-level normalized column, not another index',
      }),
    );
  });

  /**
   * GATE. The RLS COST of this read, recorded rather than asserted
   * (P4-AL-75): the `tenant_membership` policy's `EXISTS (SELECT 1 FROM
   * businesses …)` appears under every scan, and `businesses` is read
   * sequentially there. The policy is not this slice's to change and RLS is
   * never weakened, so the number is EVIDENCE and the only assertion is that
   * the subplan is on `businesses` — a tiny relation — and on nothing large.
   */
  it('GATE: the policy subplan reads `businesses` and never a large relation per row', async () => {
    const nodes = (await plansOf(searchPath('pos-', 50))).flatMap((p) => p.nodes);
    const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name'] ?? '?');
    console.info('[P4-A] rlsPolicySubplanScans', JSON.stringify(seq));
    expect(
      seq.filter((r) => ['stock_levels', 'stock_movements', 'invoices', 'journal_lines'].includes(r)),
      'the policy must not make the read scan a large relation',
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
 * P4-B — AND THE TRIPWIRE THAT CALLED IT IN.
 *
 * What stood here asserted the FACT that made P4-B unmeasurable — that neither
 * POS relation existed — so that the day `0079` created them, the case would
 * turn RED and whoever held the slice would be told, by name, that the
 * measurement was owed. It did exactly that, and this is the measurement.
 *
 * It was owed for a while without anyone hearing it, which is worth recording:
 * this suite's `beforeAll` was calling the type-ahead with `warehouseId` after
 * Ruling 2 replaced it, so the fixture threw and all ten cases — the tripwire
 * among them — reported as SKIPPED rather than run. A tripwire inside a file
 * that cannot start is not a tripwire. That is why the fixture now opens a
 * real till through `POST /v1/pos/till-sessions` instead.
 *
 * ── THE SUBJECT, AND WHAT IS AND IS NOT MEASURED ───────────────────────
 *
 * «Server-side cart recomputation, 20 lines with discounts and tax», p95 ≤ 60
 * ms (`P4-AL-71`, table row `P4-B`). The ceiling is the lock's own, taken
 * verbatim, and is never raised to obtain a pass.
 *
 * The subject is a real 20-line basket on the owner's own open till, every
 * line appended through `POST .../cart-lines` and every discount requested
 * through `POST .../cart-lines/:cartLineId/discount`. No row is inserted by
 * hand: `daftar_app` holds SELECT only on both POS relations (`0079:605`), and
 * a figure measured against a hand-seeded basket would be a figure about a
 * path no cashier can reach.
 *
 * What is TIMED is one `PATCH .../cart-lines/:cartLineId` — the smallest
 * command the till issues — because every cart command answers with the WHOLE
 * recomputed cart. So one request is one full recomputation of all twenty
 * lines, which is the thing P4-B names, and the response's own line count is
 * asserted so the number cannot quietly become a figure about a shorter
 * basket.
 *
 * TAX IS ZERO, and that is not an omission this case papers over: `OD-03` is
 * OPEN and tax stays zero across Phase 4, so there is no tax arithmetic in the
 * recomputation to measure. The discounts are real. When `OD-03` is settled and
 * tax arithmetic lands, this case's basket is where it is added.
 */
describe('P4-B — server-side cart recomputation', () => {
  /** The twenty lines, with discounts on a quarter of them, built through the routes alone. */
  async function twentyLineBasket(): Promise<string[]> {
    const products = (
      await ownerPool().query<{ id: string }>(`SELECT id FROM products WHERE business_id = $1 AND sku LIKE 'POS-SKU-%' ORDER BY sku LIMIT 20`, [A.businessId])
    ).rows.map((r) => r.id);
    expect(products, 'the seed holds fewer than twenty priced products, so this would not be a twenty-line measurement').toHaveLength(20);

    const headers = asMember(owner, A.businessId);
    const base = `/v1/pos/till-sessions/${must(tillSessionId)}/cart-lines`;
    const lineIds: string[] = [];
    for (const productId of products) {
      const res = await t.request.post(base).set(headers).send({ productId, variantId: null, quantity: '1' });
      // 201: the basket is append-only, so a line really is created.
      expect(res.status, `the append was refused: ${JSON.stringify(res.body)}`).toBe(201);
      lineIds.push(must((res.body.lines as { cartLineId: string }[]).at(-1)).cartLineId);
    }
    expect(new Set(lineIds).size, 'two appends answered with the same line id').toBe(20);

    // «with discounts»: every fourth line carries one, requested through the
    // route rather than written into a column.
    for (const lineId of lineIds.filter((_, i) => i % 4 === 0)) {
      const res = await t.request.post(`${base}/${lineId}/discount`).set(headers).send({ discountMinor: '1' });
      expect(res.status, `the discount was refused: ${JSON.stringify(res.body)}`).toBe(200);
    }
    return lineIds;
  }

  it(`MEASUREMENT: p95 of ${RUNS} warm recomputations of a 20-line basket is within P4-B (${BUDGET.B_POS_CART_P95} ms)`, async () => {
    // The tripwire's own fact, kept and inverted: the subject must EXIST, so a
    // revert of `0079` makes this red rather than making the figure vacuous.
    const present = (
      await ownerPool().query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`, [
        ['pos_cart_lines', 'pos_till_sessions'],
      ])
    ).rows.map((x) => x.relname);
    expect(present, 'the POS relations P4-B measures are not in the tree').toEqual(['pos_cart_lines', 'pos_till_sessions']);

    const lineIds = await twentyLineBasket();
    const headers = asMember(owner, A.businessId);
    const subject = `/v1/pos/till-sessions/${must(tillSessionId)}/cart-lines/${must(lineIds[0])}`;

    /** One recomputation of the whole basket, timed, with its line count read back off the answer. */
    const recompute = async (quantity: string): Promise<{ ms: number; lines: number }> => {
      const start = process.hrtime.bigint();
      const res = await t.request.patch(subject).set(headers).send({ quantity });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(res.status, `the recomputation was refused: ${JSON.stringify(res.body)}`).toBe(200);
      return { ms, lines: (res.body.lines as unknown[]).length };
    };

    for (let i = 0; i < WARMUP; i += 1) await recompute(i % 2 === 0 ? '1' : '2');
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const run = await recompute(i % 2 === 0 ? '1' : '2');
      // The figure is about TWENTY lines on every single sample, not on average.
      expect(run.lines, 'a sample recomputed a basket of some other size').toBe(20);
      samples.push(run.ms);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const rank = (q: number): number => must(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]);
    const measured = {
      name: 'POS cart recomputation, 20 lines, 5 discounted, tax zero (OD-03 OPEN)',
      budgetMs: BUDGET.B_POS_CART_P95,
      p50: rank(0.5),
      p95: rank(0.95),
      max: must(sorted.at(-1)),
      samplesMs: samples.map((x) => Math.round(x * 100) / 100),
    };
    console.info('[P4-B] budget', JSON.stringify({ lines: 20, discounted: 5, loadavg: loadavg(), measured }));

    expect(measured.p95, `${measured.name}: p95 ${measured.p95.toFixed(1)} ms against P4-B's ${BUDGET.B_POS_CART_P95} ms`).toBeLessThanOrEqual(
      BUDGET.B_POS_CART_P95,
    );
  });
});
