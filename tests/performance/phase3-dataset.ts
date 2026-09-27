/**
 * P3-S8 SCALE DATASETS (docs/PHASE_3_S8_CONTRACT.md A-17; T-13 and the T-09
 * rehearsal read them).
 *
 * Two datasets, both SEEDED and deterministic (a fixed linear congruential
 * generator, never `Math.random`), and both ANALYZEd before anything is
 * measured (docs/PHASE_2_PERFORMANCE_BASELINE.md §3):
 *
 *   D-GL — real commands, real GL. One business, 2,000 tracked variants × 3
 *     warehouses. Every row is written by the real command routines and the
 *     real posting path, as the schema owner holding the minted assertions,
 *     in ordinary committed transactions (the S7 T-17 method): receipts of
 *     ten lines (10 % in USD, a by-value landed cost on 5 %), supplier
 *     returns, transfers, adjustments (gains at a stated cost and losses),
 *     damage, one stocktake of 500 lines, supplier payments, and purchase
 *     reversals. No trigger, constraint or row security is bypassed.
 *     Every consuming command takes one unit from a distinct received line,
 *     so the plan never asks a key for stock it does not hold.
 *
 *   D-LEDGER — ledger-only volume, through the S2 fixture path: the
 *     committed stock fixture (`installCommittedFixture`) and the real
 *     primitive `inventory_apply_stock_movements`, batched. No GL, so only
 *     R-INV-02/03/05 and fold/verify are measured on it. The fixture is
 *     removed (and with it every stock row) once the ledger measurements are
 *     done, so it never meets the real-command dataset.
 *
 * | Dataset  | Tier 1 (CI)                                          | Tier 2 (`P3S8_PERF_TIER=2`) |
 * | D-GL     | 1,000 receipts, 300 transfers, 300 adjustments,      | × 10                        |
 * |          | 100 damages, 200 returns, 100 reversals, 1 stocktake |                             |
 * |          | of 500 lines, 300 payments ≈ 12,700 movements         |                             |
 * | D-LEDGER | 60,000 movements over 6,000 keys                     | 1,000,000 over 50,001 keys  |
 *
 * `P3S8_PERF_SCALE` in (0, 1] scales every count for a smoke run of the
 * harness only (the S7 T-17 convention); only scale 1 is evidence.
 */
import type { Client, Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ownerPool, type TestApp } from '../helpers/test-app';
import {
  countCommand,
  must,
  onboardS3Business,
  runCommand as runS3,
  stockState,
  stocktakeOpenCommand,
  today,
  transferCommand,
  adjustCommand,
  damageCommand,
  finalizeCommand,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { runFinancial } from '../helpers/inventory-posting';
import { createSupplier, draftAndReceive, draftCommand, type DraftCommand } from '../helpers/purchase-commands';
import { foreignRate, prepareReversal, returnGoods, runReversal } from '../helpers/purchase-returns';
import { committed, createMethod, preparePay, runS6, seedSettlementAccounts } from '../helpers/supplier-settlement';
import {
  addTrackedProduct,
  addWarehouse,
  applyAsApp,
  installCommittedFixture,
  removeCommittedFixture,
  req,
  seedStockBusiness,
  type Key,
  type MovementRequest,
  type StockBusiness,
} from '../helpers/stock-ledger';

/** Tier 1 on every push; Tier 2 locally (TL-7). */
export const PERF_TIER: 1 | 2 = ((): 1 | 2 => {
  const raw = process.env['P3S8_PERF_TIER'];
  if (raw === undefined || raw === '' || raw === '1') return 1;
  if (raw === '2') return 2;
  throw new Error(`P3S8_PERF_TIER must be 1 or 2, got ${raw}`);
})();

/** A harness smoke factor; the budgets are asserted unchanged at every scale. */
export const PERF_SCALE: number = ((): number => {
  const raw = process.env['P3S8_PERF_SCALE'];
  if (raw === undefined || raw === '') return 1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`P3S8_PERF_SCALE must be in (0, 1], got ${raw}`);
  return n;
})();

const scaled = (n: number): number => Math.max(1, Math.round(n * PERF_SCALE * (PERF_TIER === 2 ? 10 : 1)));

/** A-17 D-GL, per tier. */
export const GL_VOLUME = {
  variants: scaled(2_000),
  receipts: scaled(1_000),
  linesPerReceipt: 10,
  transfers: scaled(300),
  adjustments: scaled(300),
  damages: scaled(100),
  returns: scaled(200),
  reversals: scaled(100),
  stocktakeLines: scaled(500),
  payments: scaled(300),
} as const;

/** A-17 D-LEDGER, per tier: movements per key × keys. */
export const LEDGER_VOLUME =
  PERF_TIER === 2
    ? { variants: Math.max(1, Math.round(16_667 * PERF_SCALE)), warehouses: 3, movementsPerKey: 20 }
    : { variants: Math.max(1, Math.round(2_000 * PERF_SCALE)), warehouses: 3, movementsPerKey: 10 };

/** The generator: the dataset is the same on every run. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const elapsedMs = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e6;

/** ANALYZE every relation the S8 measurements read. */
export async function analyzeMeasuredTables(pool: Pool = ownerPool()): Promise<void> {
  for (const table of [
    'stock_movements',
    'stock_levels',
    'stock_source_bindings',
    'journal_entries',
    'journal_lines',
    'accounts',
    'accounting_source_bindings',
  ]) {
    await pool.query(`ANALYZE ${table}`);
  }
}

// ── D-LEDGER ────────────────────────────────────────────────────────────────

export interface LedgerDataset {
  readonly business: StockBusiness;
  readonly keys: readonly Key[];
  readonly movements: number;
  readonly buildMs: number;
}

/** Requests per primitive call while seeding (one assertion, one transaction each). */
const LEDGER_BATCH = 1_000;

/**
 * D-LEDGER: per key, `movementsPerKey − 2` purchases of 1–5 units at a
 * two-decimal cost, then two damages of one unit — so a key never goes below
 * zero — applied round by round over every key through the real primitive.
 * The caller removes the fixture with `removeLedgerDataset`.
 */
export async function buildLedgerDataset(): Promise<LedgerDataset> {
  const started = process.hrtime.bigint();
  const pool = ownerPool();
  await installCommittedFixture();
  const business = await seedStockBusiness(pool, 's8perf');
  const warehouses = [business.warehouse1, business.warehouse2, await addWarehouse(pool, business.businessId, business.branchId, 'W3')];
  const variants: string[] = [];
  for (let i = 0; i < LEDGER_VOLUME.variants; i += 1) variants.push((await addTrackedProduct(pool, business, 'piece', 0)).variantId);
  const keys = variants.flatMap((variantId) => warehouses.map((warehouseId) => ({ warehouseId, variantId })));
  const rand = lcg(0x5_08_1ed);
  let movements = 0;
  for (let round = 0; round < LEDGER_VOLUME.movementsPerKey; round += 1) {
    const damage = round >= LEDGER_VOLUME.movementsPerKey - 2;
    const requests: MovementRequest[] = keys.map((k) =>
      damage
        ? req(k, 'damage', '-1', { reason: 'scale dataset' })
        : req(k, 'purchase', String(1 + Math.floor(rand() * 5)), {
            unitCost: `${1 + Math.floor(rand() * 50)}.${String(Math.floor(rand() * 100)).padStart(2, '0')}`,
          }),
    );
    for (let i = 0; i < requests.length; i += LEDGER_BATCH) {
      const batch = requests.slice(i, i + LEDGER_BATCH);
      await committed(async (c: Client) => {
        movements += (await applyAsApp(c, business, batch)).length;
      });
    }
  }
  await analyzeMeasuredTables(pool);
  return { business, keys, movements, buildMs: elapsedMs(started) };
}

/** Remove the committed fixture and, with it, every stock row it wrote. */
export async function removeLedgerDataset(): Promise<void> {
  await removeCommittedFixture();
}

// ── D-GL ────────────────────────────────────────────────────────────────────

export interface GlDataset {
  readonly business: S3Business;
  readonly warehouses: readonly string[];
  readonly movements: number;
  /** The movements the commands that ran must have written: one per line, two per transfer line. */
  readonly plannedMovements: number;
  readonly journalLines: number;
  readonly buildMs: number;
}

/** Receipts committed per transaction while seeding. */
const GL_BATCH = 50;

interface Receipt {
  readonly draft: DraftCommand;
  readonly supplierId: string;
  readonly foreign: boolean;
}

async function inBatches<T>(items: readonly T[], size: number, fn: (c: Client, item: T, index: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await committed(async (c: Client) => {
      for (const [k, item] of batch.entries()) await fn(c, item, i + k);
    });
  }
}

/**
 * D-GL through the real commands (A-17). Receipt `i` goes to warehouse
 * `i mod 3` with the ten variants `(10 i + k) mod V`; it is in USD when
 * `i mod 10 = 7` (before the reversal block) and carries a by-value landed
 * cost when `i mod 20 = 3`. The consuming commands each take one unit from a
 * distinct received line: returns line 1 of the ILS receipts from 30 %,
 * transfers line 0 and adjustment losses line 2 from 60 %, damage line 3
 * from 75 %; the reversals receive and reverse the last receipts, and the
 * payments settle one instalment of an ILS receipt from the start.
 */
export async function buildGlDataset(t: TestApp, owner: HttpActor): Promise<GlDataset> {
  const started = process.hrtime.bigint();
  const pool = ownerPool();
  const V = GL_VOLUME;
  const A = await onboardS3Business(t, owner, 's8perf');
  const warehouses = [A.w1, A.w2, await addWarehouse(pool, A.businessId, A.branchX, 'W3')];
  const variants: string[] = [];
  for (let i = 0; i < V.variants; i += 1) variants.push((await addTrackedProduct(pool, A, 'piece', 0)).variantId);
  await foreignRate(A, 'USD', '3.65', '2000-01-01T00:00:00Z');
  const day = await today();
  const rand = lcg(0x5_08_61);

  const suppliers: string[] = [];
  await committed(async (c: Client) => {
    for (let i = 0; i < 20; i += 1) suppliers.push(await createSupplier(c, A, { name: `Scale supplier ${String(i).padStart(2, '0')}` }));
  });

  const reversalStart = V.receipts;
  const total = V.receipts + V.reversals;
  const plan: Receipt[] = [];
  for (let i = 0; i < total; i += 1) {
    const foreign = i % 10 === 7 && i < reversalStart;
    const lines = Array.from({ length: V.linesPerReceipt }, (_, k) => ({
      variantId: must(variants[(i * V.linesPerReceipt + k) % variants.length]),
      qty: String(2 + Math.floor(rand() * 4)),
      unitPriceMinor: String(1_000 + Math.floor(rand() * 4_000)),
    }));
    const landed =
      !foreign && i % 20 === 3
        ? [{ landedCostId: randomUUID(), mode: 'by_value' as const, amountMinor: 5_000n, description: 'freight', allocations: null }]
        : [];
    const supplierId = must(suppliers[i % suppliers.length]);
    plan.push({
      draft: await draftCommand(pool, supplierId, must(warehouses[i % warehouses.length]), lines, {
        documentDate: day,
        currency: foreign ? 'USD' : 'ILS',
        landedCosts: landed,
      }),
      supplierId,
      foreign,
    });
  }
  const receipt = (i: number): Receipt => must(plan[i], `receipt ${i}`);
  const lineOf = (i: number, k: number): { warehouseId: string; variantId: string; lineId: string } => {
    const r = receipt(i);
    const line = must(r.draft.lines[k]);
    return { warehouseId: r.draft.warehouseId, variantId: line.variantId, lineId: line.lineId };
  };
  let planned = 0;
  const band = (from: number, count: number, accept: (i: number) => boolean = () => true): number[] => {
    const out: number[] = [];
    for (let i = Math.floor(V.receipts * from); out.length < count && i < V.receipts; i += 1) if (accept(i)) out.push(i);
    return out;
  };

  // 1. The receipts that are not reversed.
  await inBatches(plan.slice(0, V.receipts), GL_BATCH, async (c, r) => {
    await draftAndReceive(c, A, r.draft);
    planned += r.draft.lines.length;
  });

  // 2. Supplier returns: one unit of line 1 of an ILS receipt from 30 %.
  await inBatches(
    band(0.3, V.returns, (i) => !receipt(i).foreign),
    GL_BATCH,
    async (c, i) => {
      await returnGoods(c, A, receipt(i).draft.purchaseId, { lines: [{ purchaseLineId: lineOf(i, 1).lineId, qty: '1' }] });
      planned += 1;
    },
  );

  // 3. Transfers: one unit of line 0, to the next warehouse.
  await inBatches(band(0.6, V.transfers), GL_BATCH, async (c, i) => {
    const l = lineOf(i, 0);
    const to = must(warehouses[(warehouses.indexOf(l.warehouseId) + 1) % warehouses.length]);
    await runS3(c, A, transferCommand(l.warehouseId, to, [{ variantId: l.variantId, qty: '1' }]));
    planned += 2;
  });

  // 4. Adjustments: losses of one unit of line 2, and as many gains of one unit at a stated cost (an S3 gain states its cost).
  const losses = band(0.6, Math.ceil(V.adjustments / 2));
  await inBatches(losses, GL_BATCH, async (c, i) => {
    const l = lineOf(i, 2);
    await runFinancial(c, A, await adjustCommand(c, A, l.warehouseId, [{ variantId: l.variantId, qty: '-1' }]));
    planned += 1;
  });
  await inBatches(band(0.1, V.adjustments - losses.length), GL_BATCH, async (c, i) => {
    const l = lineOf(i, 4);
    await runFinancial(c, A, await adjustCommand(c, A, l.warehouseId, [{ variantId: l.variantId, qty: '1', unitCost: '25.5' }]));
    planned += 1;
  });

  // 5. Damage: one unit of line 3 from 75 %.
  await inBatches(band(0.75, V.damages), GL_BATCH, async (c, i) => {
    const l = lineOf(i, 3);
    await runFinancial(c, A, await damageCommand(c, A, l.warehouseId, [{ variantId: l.variantId, qty: '1' }]));
    planned += 1;
  });

  // 6. One stocktake of the first warehouse: every counted key one unit above its on-hand.
  const w0 = must(warehouses[0]);
  const counted: { variantId: string; counted: string }[] = [];
  for (const variantId of variants) {
    if (counted.length >= V.stocktakeLines) break;
    const state = await stockState(pool, A.businessId, { warehouseId: w0, variantId });
    if (state.onHand > 0n) counted.push({ variantId, counted: String(state.onHand / 10_000n + 1n) });
  }
  const stocktakeId = randomUUID();
  await committed(async (c: Client) => {
    await runS3(c, A, stocktakeOpenCommand(w0, stocktakeId));
    await runS3(c, A, countCommand(stocktakeId, w0, counted));
  });
  await committed(async (c: Client) => {
    await runFinancial(c, A, await finalizeCommand(c, A, stocktakeId, w0));
  });
  planned += counted.length;

  // 7. Payments: one instalment of an ILS receipt each, from the start.
  const accounts = await seedSettlementAccounts(pool, A);
  const method = await committed((c: Client) => createMethod(c, A, { postingAccountId: accounts.settlement.cash }));
  await inBatches(
    band(0, V.payments, (i) => !receipt(i).foreign),
    GL_BATCH,
    async (c, i) => {
      const r = receipt(i);
      await runS6(
        c,
        A,
        await preparePay(c, A, {
          supplierId: r.supplierId,
          paymentMethodId: method,
          allocations: [{ purchaseId: r.draft.purchaseId, paymentAmountMinor: 100n }],
        }),
      );
    },
  );

  // 8. Reversals: each receipted and reversed in the same batch, before anything else touches it.
  await inBatches(plan.slice(reversalStart), GL_BATCH, async (c, r) => {
    await draftAndReceive(c, A, r.draft);
    await runReversal(c, A, await prepareReversal(c, A, r.draft.purchaseId));
    planned += 2 * r.draft.lines.length;
  });

  await analyzeMeasuredTables(pool);
  const counts = must(
    (
      await pool.query<{ movements: number; lines: number }>(
        `SELECT (SELECT count(*)::int FROM stock_movements WHERE business_id = $1) AS movements,
                (SELECT count(*)::int FROM journal_lines WHERE business_id = $1) AS lines`,
        [A.businessId],
      )
    ).rows[0],
  );
  return { business: A, warehouses, movements: counts.movements, plannedMovements: planned, journalLines: counts.lines, buildMs: elapsedMs(started) };
}
