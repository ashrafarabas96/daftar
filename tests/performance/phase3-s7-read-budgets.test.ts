/**
 * P3-S7 T-17 — THE READ BUDGETS AND THEIR PLANS (docs PHASE_3_S7_CONTRACT
 * A-02, §6 T-17, §7.3 #4).
 *
 * THE VOLUME (§6 T-17), in one business: 5,000 variants × 3 warehouses;
 * 2,000 suppliers; 50,000 received purchases; 200,000 `accounts_payable`
 * journal lines (one per receipt, the rest from supplier payment
 * allocations, each its own entry). Everything is written through the real
 * command routines and the real posting path (`draftAndReceive`, `runS6`),
 * as the schema owner holding the minted assertions, inside ordinary
 * committed transactions: no trigger, constraint or row security is
 * bypassed, so the reads measure a database the application could have
 * written. One supplier holds 500 open purchases for the open-purchases
 * budget.
 *
 * THE BUDGETS (p95 of 20 warm runs, after 5 warm-up runs), end to end through
 * the HTTP application as the owner:
 *   - stock page (50 rows)                     ≤ 150 ms;
 *   - supplier-balances page (20 suppliers)    ≤ 250 ms;
 *   - open purchases (the 500-purchase supplier, with a proposal) ≤ 200 ms;
 *   - return options (a four-line purchase)    ≤ 50 ms.
 * The budgets are the contract's, written as constants: never raise one to
 * obtain a pass. A failure is the only admission ticket to the conditional
 * index migration 0069 (A-02), and this file's EXPLAIN output is its
 * evidence.
 *
 * THE PLANS: every statement each read runs is captured from `Database.scoped`
 * and EXPLAINed with its own parameters under the same scope (as
 * `daftar_app`, row security applied): the stock read reaches `stock_levels`
 * by an index, open purchases use `purchases_supplier_idx`, the ledger AP read
 * uses `journal_lines_business_account_idx`, and no statement scans
 * `journal_lines` sequentially.
 *
 * RUNNING IT: alone, after the other S7 suites, never beside another
 * `PG_DIR` user (§7.1 #4). The seed at contract volume takes about two hours
 * through the real routines. `P3S7_PERF_SCALE` (default 1, the contract
 * volume) scales every count. TWO TIERS, as P2-S8 §35: the permanent gate runs
 * Tier 1 on every push at scale 0.1 — the same budgets on less data, the
 * weaker claim, and the output says which scale produced it; the acceptance
 * evidence is Tier 2, one run at scale 1 recorded in the acceptance page.
 * The budgets are asserted unchanged at every scale.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { addMerchantVariant, addTrackedProduct, addWarehouse, configureRaw, createProduct } from '../helpers/stock-ledger';
import { createSupplier, draftAndReceive, draftCommand } from '../helpers/purchase-commands';
import { committed, createMethod, preparePay, runS6, seedSettlementAccounts } from '../helpers/supplier-settlement';
import { readAs } from '../helpers/merchant-reads';
import { Database, type Scope } from '../../apps/api/src/infra/database';

/** §6 T-17, verbatim. Milliseconds, ceilings on p95. */
const BUDGET = {
  STOCK_PAGE_P95: 150,
  SUPPLIER_BALANCES_PAGE_P95: 250,
  OPEN_PURCHASES_P95: 200,
  RETURN_OPTIONS_P95: 50,
} as const;

const SCALE = ((): number => {
  const raw = process.env['P3S7_PERF_SCALE'];
  if (raw === undefined || raw === '') return 1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`P3S7_PERF_SCALE must be in (0, 1], got ${raw}`);
  return n;
})();

const scaled = (n: number): number => Math.max(1, Math.round(n * SCALE));

const VOLUME = {
  variants: scaled(5_000),
  suppliers: scaled(2_000),
  purchases: scaled(50_000),
  apLines: scaled(200_000),
  bigSupplierPurchases: Math.min(500, Math.floor(scaled(50_000) / 2)),
} as const;

const WARMUP = 5;
const RUNS = 20;
/** Purchases committed per transaction while seeding. */
const BATCH = 200;
/** A payment holds at most 50 allocations (S6 A-07). */
const MAX_ALLOCATIONS = 50;
/** Each allocation pays this much of a purchase: every purchase is worth at least 10.00, so four payments never settle one. */
const INSTALMENT_MINOR = 100n;

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let warehouses: string[];
let bigSupplier: string;
let returnPurchase: string;

/** A small deterministic generator (no `Math.random`): the dataset is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

async function inBatches<T>(items: readonly T[], size: number, fn: (c: Client, batch: readonly T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await committed((c) => fn(c, batch));
  }
}

async function seed(): Promise<void> {
  const pool = ownerPool();
  const rand = lcg(20_260_927);
  const s = { tenantId: A.tenantId, businessId: A.businessId };
  warehouses = [A.w1, A.w2, await addWarehouse(pool, A.businessId, A.branchX, 'W3')];

  // Variants: nine in ten simple products, the rest products of two merchant variants.
  const variants: string[] = [];
  while (variants.length < VOLUME.variants) {
    if (variants.length % 10 === 9 && variants.length + 2 <= VOLUME.variants) {
      const productId = await createProduct(pool, A.businessId);
      const ids = [await addMerchantVariant(pool, A.businessId, productId), await addMerchantVariant(pool, A.businessId, productId)];
      await configureRaw(pool, s, productId, 'piece', 0, false);
      variants.push(...ids);
    } else {
      variants.push((await addTrackedProduct(pool, s, 'piece', 0)).variantId);
    }
  }
  await pool.query(`UPDATE product_translations SET name = 'Item ' || substr(md5(product_id::text), 1, 10) WHERE business_id = $1`, [A.businessId]);

  const suppliers: string[] = [];
  await inBatches(
    Array.from({ length: VOLUME.suppliers }, (_, i) => i),
    BATCH,
    async (c, batch) => {
      for (const i of batch) suppliers.push(await createSupplier(c, A, { name: `Supplier ${String(i).padStart(5, '0')}` }));
    },
  );
  bigSupplier = must(suppliers[0]);

  // Purchases: the big supplier's first, then round-robin; 1..4 lines each. The first line walks the
  // variants per warehouse, so every (warehouse, variant) key holds stock; the others are random.
  const plan = Array.from({ length: VOLUME.purchases }, (_, i) => ({
    supplierId: i < VOLUME.bigSupplierPurchases ? bigSupplier : must(suppliers[1 + (i % Math.max(1, suppliers.length - 1))] ?? suppliers[0]),
    warehouseId: must(warehouses[i % 3]),
    lines: Array.from({ length: i === 0 ? 4 : 1 + Math.floor(rand() * 4) }, (_, k) => ({
      variantId: must(variants[k === 0 ? Math.floor(i / 3) % variants.length : Math.floor(rand() * variants.length)]),
      qty: String(1 + Math.floor(rand() * 5)),
      unitPriceMinor: String(1_000 + Math.floor(rand() * 4_000)),
    })),
  }));
  const received: { purchaseId: string; supplierId: string }[] = [];
  const day = await today();
  await inBatches(plan, BATCH, async (c, batch) => {
    for (const p of batch) {
      // One variant once per purchase: a draft line per distinct key.
      const lines = [...new Map(p.lines.map((l) => [l.variantId, l])).values()];
      const draft = await draftCommand(c, p.supplierId, p.warehouseId, lines, { documentDate: day });
      await draftAndReceive(c, A, draft);
      received.push({ purchaseId: draft.purchaseId, supplierId: p.supplierId });
    }
  });
  returnPurchase = must(received[0]).purchaseId;

  // AP lines: one per receipt so far; the rest are payment allocations (one entry each) on the other suppliers' purchases.
  const acc = await seedSettlementAccounts(pool, A);
  const method = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.cash }));
  const payable = received.filter((r) => r.supplierId !== bigSupplier);
  const needed = Math.max(0, VOLUME.apLines - received.length);
  const bySupplier = new Map<string, string[]>();
  for (let i = 0; i < needed && payable.length > 0; i += 1) {
    const r = must(payable[i % payable.length]);
    bySupplier.set(r.supplierId, [...(bySupplier.get(r.supplierId) ?? []), r.purchaseId]);
  }
  // A payment names distinct purchases: split each supplier's list into rounds of distinct ids, then chunks of 50.
  const payments: { supplierId: string; purchaseIds: string[] }[] = [];
  for (const [supplierId, ids] of bySupplier) {
    const rounds: string[][] = [];
    const seen: Set<string>[] = [];
    for (const id of ids) {
      let k = 0;
      while (seen[k]?.has(id) === true) k += 1;
      (seen[k] ??= new Set()).add(id);
      (rounds[k] ??= []).push(id);
    }
    for (const round of rounds) {
      for (let i = 0; i < round.length; i += MAX_ALLOCATIONS) payments.push({ supplierId, purchaseIds: round.slice(i, i + MAX_ALLOCATIONS) });
    }
  }
  await inBatches(payments, 10, async (c, batch) => {
    for (const p of batch) {
      const call = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: method,
        paymentDate: day,
        allocations: p.purchaseIds.map((purchaseId) => ({ purchaseId, paymentAmountMinor: INSTALMENT_MINOR })),
      });
      await runS6(c, A, call);
    }
  });
  await pool.query('ANALYZE');
}

interface Volume {
  variants: number;
  keys: number;
  suppliers: number;
  purchases: number;
  apLines: number;
  bigSupplierOpen: number;
}

async function measuredVolume(): Promise<Volume> {
  const r = await ownerPool().query<Volume>(
    `SELECT (SELECT count(*)::int FROM product_variants v JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
              WHERE v.business_id = $1 AND p.track_inventory
                AND (NOT v.is_base OR NOT EXISTS (SELECT 1 FROM product_variants m WHERE m.business_id = v.business_id AND m.product_id = v.product_id AND NOT m.is_base))) AS variants,
            (SELECT count(*)::int FROM stock_levels WHERE business_id = $1) AS keys,
            (SELECT count(*)::int FROM suppliers WHERE business_id = $1) AS suppliers,
            (SELECT count(*)::int FROM purchases WHERE business_id = $1 AND status = 'received') AS purchases,
            (SELECT count(*)::int FROM journal_lines jl JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id
              WHERE jl.business_id = $1 AND a.system_key = 'accounts_payable') AS "apLines",
            (SELECT count(*)::int FROM purchases WHERE business_id = $1 AND supplier_id = $2 AND purchase_ap_outstanding(business_id, id) > 0) AS "bigSupplierOpen"`,
    [A.businessId, bigSupplier],
  );
  return must(r.rows[0]);
}

interface Captured {
  readonly scope: Scope;
  readonly text: string;
  readonly params: unknown[];
}

/** Every statement one read runs through `Database.scoped`. */
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

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/** EXPLAIN every captured statement of a read, under its own scope, as `daftar_app`. */
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

const INDEX_ACCESS = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

function usesIndexOn(nodes: readonly PlanNode[], table: string, index?: string): boolean {
  return nodes.some(
    (n) =>
      INDEX_ACCESS.has(n['Node Type']) &&
      (index === undefined ? (n['Index Name'] ?? '').startsWith(table) || n['Relation Name'] === table : n['Index Name'] === index),
  );
}

interface Measurement {
  readonly name: string;
  readonly budgetMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly samplesMs: readonly number[];
}

async function measure(name: string, budgetMs: number, path: string): Promise<Measurement> {
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

const PATHS = {
  stock: (): string => `/v1/inventory/stock?warehouseId=${must(warehouses[0])}&limit=50`,
  balances: (): string => '/v1/supplier-balances?limit=20',
  open: (): string => `/v1/suppliers/${bigSupplier}/open-purchases?currency=ILS&amount=100000000&limit=50`,
  returns: (): string => `/v1/purchases/${returnPurchase}/return-options`,
};

beforeAll(
  async () => {
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
    owner = await registerActor(t, 'S7 budgets owner');
    A = await onboardS3Business(t, owner, 's7perf');
    await seed();
    // The seed at contract volume outlives an access token: sign in again, so
    // the measured reads are authenticated as the same owner.
    const login = await t.request.post('/v1/auth/login').send({ email: owner.email, password: 'Str0ng!Passw0rd' });
    expect(login.status, 'the owner signs in again after the seed').toBe(201);
    owner = { ...owner, token: String(login.body.accessToken) };
  },
  4 * 60 * 60 * 1000,
);

afterAll(async () => {
  await t.close();
  await resetData();
});

describe(`T-17 the S7 read budgets (scale ${SCALE})`, () => {
  it('the seeded volume is the contract’s', async () => {
    const v = await measuredVolume();
    console.info('[T-17] volume', JSON.stringify({ scale: SCALE, ...v }));
    expect(v.variants).toBeGreaterThanOrEqual(VOLUME.variants);
    expect(v.keys, 'every variant holds stock in the three warehouses').toBe(VOLUME.variants * 3);
    expect(v.suppliers).toBe(VOLUME.suppliers);
    expect(v.purchases).toBe(VOLUME.purchases);
    expect(v.apLines).toBeGreaterThanOrEqual(VOLUME.apLines);
    expect(v.bigSupplierOpen).toBe(VOLUME.bigSupplierPurchases);
  });

  it('p95 of 20 warm runs is within every budget', async () => {
    const results = [
      await measure('stock page (50)', BUDGET.STOCK_PAGE_P95, PATHS.stock()),
      await measure('supplier-balances page (20)', BUDGET.SUPPLIER_BALANCES_PAGE_P95, PATHS.balances()),
      await measure(`open purchases (${VOLUME.bigSupplierPurchases})`, BUDGET.OPEN_PURCHASES_P95, PATHS.open()),
      await measure('return options', BUDGET.RETURN_OPTIONS_P95, PATHS.returns()),
    ];
    for (const m of results) {
      console.info('[T-17] budget', JSON.stringify({ ...m, samplesMs: m.samplesMs.map((x) => Math.round(x * 100) / 100) }));
    }
    expect(results.map((m) => ({ name: m.name, withinBudget: m.p95 <= m.budgetMs }))).toEqual(results.map((m) => ({ name: m.name, withinBudget: true })));
  });

  it('EXPLAIN: index access on stock_levels, purchases_supplier_idx and journal_lines_business_account_idx; no sequential scan on journal_lines', async () => {
    const stock = await plansOf(PATHS.stock());
    const balances = await plansOf(PATHS.balances());
    const open = await plansOf(PATHS.open());
    const returns = await plansOf(PATHS.returns());
    for (const [name, plans] of Object.entries({ stock, balances, open, returns })) {
      for (const p of plans) console.info(`[T-17] plan ${name}`, p.json);
    }
    const all = [...stock, ...balances, ...open, ...returns].flatMap((p) => p.nodes);
    expect(
      usesIndexOn(
        stock.flatMap((p) => p.nodes),
        'stock_levels',
      ),
      'the stock read reaches stock_levels by an index',
    ).toBe(true);
    expect(
      usesIndexOn(
        open.flatMap((p) => p.nodes),
        'purchases',
        'purchases_supplier_idx',
      ),
      'open purchases use purchases_supplier_idx',
    ).toBe(true);
    expect(
      usesIndexOn(
        balances.flatMap((p) => p.nodes),
        'journal_lines',
        'journal_lines_business_account_idx',
      ),
      'the ledger AP read uses journal_lines_business_account_idx',
    ).toBe(true);
    expect(
      all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'journal_lines'),
      'no sequential scan on journal_lines',
    ).toEqual([]);
  });
});
