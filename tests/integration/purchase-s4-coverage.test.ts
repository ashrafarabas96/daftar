/**
 * P3-S4 T-08 — DEFICIT COVERAGE (docs/PHASE_3_S4_CONTRACT.md A-16, §5, §6
 * T-08; P:207, P:216).
 *
 * Every number is the package's: each case is a vector of
 * `packages/inventory/vectors/coverage-vectors.json`, seeded as the schema
 * owner (§5: one fixture movement standing in for a Phase 4 oversell, a
 * consistent cache row and the open layers) and received through the REAL
 * `purchase_receive` as `daftar_app` under a real `purchase.receive`
 * assertion, with the entries the app's builders produce posted by the
 * primitive in the same transaction. The stored coverages, movements, deficit
 * layers, cache, header and entries are then compared with the vector, and
 * `SET CONSTRAINTS ALL IMMEDIATE` proves every deferred guard accepts the
 * result (COMMIT would).
 *
 * A receipt line's unit price is the vector's base share over its quantity
 * (domestic, no landed cost, one line per variant), so the stored base share
 * is the vector's exactly — derived, never restated.
 *
 * - T-08.1 GOLD-72 end to end (−80, then −180; GL Inventory and COGS as
 *   `AL08-CATCHUP-GOLD72`), in SQL and again through the real HTTP service
 *   with the seed committed.
 * - T-08.2 THREE-LAYERS: three coverage rows, three movements with distinct
 *   `source_line_id`s, one entry equal to Σ stored values.
 * - T-08.3 GOLD-54 and GOLD-55.
 * - T-08.4 ZERO-CATCHUP: a coverage row, no movement, no entry.
 * - T-08.5 FLUSH-RESIDUE: the last coverage carries −valuation.
 * - T-08.6 MIXED-N0: N = 0, no entry, header binding NULL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseQuantity } from '../../packages/inventory/src';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  atCommit,
  must,
  onboardS3Business,
  registerActor,
  rolledBack,
  seedS3World,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { installStockFixture } from '../helpers/stock-ledger';
import {
  createSupplier,
  draftCommand,
  entryOf,
  glOf,
  levelText,
  prepareReceipt,
  runCommand,
  runReceipt,
  type ReceiptRun,
  type S4Row,
} from '../helpers/purchase-commands';
import {
  coverageVector,
  coverageVectors,
  installCommittedDeficitFixture,
  layersOf,
  removeCommittedDeficitFixture,
  seedCommittedDeficitKey,
  seedVector,
  type CoverageVector,
  type VectorReceipt,
} from '../helpers/purchase-deficits';

let A: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  ({ A } = await seedS3World(ownerPool(), 's4cov'));
});

afterAll(async () => {
  await resetData();
});

/** The vector's first variant is `piece`, its second `piece2` (MIXED-N0). */
function variantMap(v: CoverageVector, biz: S3Business): (id: string) => string {
  const ids = v.seed.map((s) => s.variantId);
  return (id) => {
    const k = ids.indexOf(id);
    if (k === 0) return biz.piece.variantId;
    if (k === 1) return biz.piece2.variantId;
    throw new Error(`vector variant ${id} is not seeded`);
  };
}

/** The unit price (txn minor) that makes a one-line domestic receipt carry exactly `share` for `qty`. */
function unitPriceFor(qty: string, share: string): string {
  const q4 = parseQuantity(qty);
  const scaled = BigInt(share) * 10000n;
  expect(scaled % q4, `share ${share} over qty ${qty} is an exact minor unit price`).toBe(0n);
  return (scaled / q4).toString(10);
}

/** Receive one vector receipt in `c`: draft, prepare as the service does, the routine and its entries. */
async function receiveVector(c: Client, biz: S3Business, supplierId: string, r: VectorReceipt, variantOf: (id: string) => string): Promise<ReceiptRun> {
  const draft = await draftCommand(
    c,
    supplierId,
    biz.w1,
    r.lines.map((l) => ({ variantId: variantOf(l.variantId), qty: l.qty, unitPriceMinor: unitPriceFor(l.qty, l.baseShareMinor), lineId: randomUUID() })),
  );
  const saved = await runCommand(c, biz, draft);
  const prepared = await prepareReceipt(c, biz, draft.purchaseId, { draftRevision: must(saved[0]?.revision) });
  prepared.cmd.lines.forEach((l, i) => expect(l.baseShareMinor.toString(10), `line ${i + 1} base share`).toBe(r.lines[i]?.baseShareMinor));
  return runReceipt(c, biz, prepared);
}

const num = (s: string | null | undefined): string | null => (s === null || s === undefined ? null : s);

/** Compare everything one receipt stored with its vector expectation. */
async function expectReceipt(c: Client, biz: S3Business, run: ReceiptRun, r: VectorReceipt, variantOf: (id: string) => string, what: string): Promise<void> {
  const e = r.expect;
  const lineRows = run.rows.filter((x) => x.row_kind === 'line');
  const covRows = run.rows.filter((x): x is S4Row & { row_kind: 'coverage' } => x.row_kind === 'coverage');
  expect(lineRows.length, `${what}: one line row per line`).toBe(r.lines.length);
  const header = must(run.rows[0]);
  expect(header.coverage_adjustment_id !== null, `${what}: a header iff anything is covered`).toBe(e.header);
  expect(num(header.coverage_total_value_base_minor), `${what}: N`).toBe(e.header ? e.totalValueBaseMinor : null);

  // Per line, its coverages in FIFO order, each with the vector's stored value and movement.
  for (const [i, el] of e.lines.entries()) {
    const line = must(lineRows[i], `${what}: line ${i + 1}`);
    const cov = covRows.filter((x) => x.line_id === line.line_id);
    expect(
      cov.map((x) => ({
        deficitId: x.deficit_id,
        qtyCovered: x.qty_covered,
        provisional: x.provisional_unit_cost_base_minor,
        actual: x.actual_unit_cost_base_minor,
        value: x.value_delta_base_minor,
        movement: x.movement_id !== null,
      })),
      `${what}: line ${i + 1} coverages`,
    ).toEqual(
      el.coverages.map((v) => ({
        deficitId: v.deficitId,
        qtyCovered: v.qtyCovered,
        provisional: v.provisional,
        actual: v.actual,
        value: v.movement ? v.valueMinor : null,
        movement: v.movement,
      })),
    );
    expect(line.unit_cost_base_minor, `${what}: line ${i + 1} actual = the purchase movement's snapshot`).toBe(el.actual);
    const variantId = variantOf(must(r.lines[i]).variantId);
    expect(await levelText(c, biz.businessId, biz.w1, variantId), `${what}: line ${i + 1} key after`).toEqual(el.stateAfter);
    const layers = await layersOf(c, biz.businessId, biz.w1, variantId);
    for (const v of el.coverages) {
      const layer = must(
        layers.find((l) => l.id === v.deficitId),
        `layer ${v.deficitId}`,
      );
      expect({ uncovered: layer.uncovered, status: layer.status }, `${what}: layer ${v.deficitId} after`).toEqual({
        uncovered: v.uncoveredAfter,
        status: v.statusAfter,
      });
    }
  }

  // A coverage movement per non-zero value, each with its own source_line_id (the coverage id), and no other.
  const adjustmentId = header.coverage_adjustment_id ?? null;
  const moved =
    adjustmentId === null
      ? []
      : (
          await c.query<{ source_line_id: string; value: string; qty: string }>(
            `SELECT source_line_id::text, value_delta_base_minor::text AS value, qty_delta::text AS qty FROM stock_movements
        WHERE business_id = $1 AND source_type = 'negative_inventory_cost_adjustment' AND source_id = $2 ORDER BY stock_seq`,
            [biz.businessId, adjustmentId],
          )
        ).rows;
  const withMovement = e.lines.flatMap((l) => l.coverages.filter((v) => v.movement));
  expect(moved.length, `${what}: one value-only movement per non-zero coverage`).toBe(withMovement.length);
  expect(new Set(moved.map((m) => m.source_line_id)).size, `${what}: distinct source_line_ids`).toBe(moved.length);
  expect(
    moved.every((m) => m.qty === '0.0000'),
    `${what}: value-only`,
  ).toBe(true);

  // The header and its binding (A-16(i)).
  if (adjustmentId !== null) {
    const h = must(
      (
        await c.query<{ total: string; binding: string | null; origin: string; line: string | null }>(
          `SELECT total_value_base_minor::text AS total, binding_source_id::text AS binding, origin_source_id::text AS origin, origin_source_line_id::text AS line
             FROM negative_inventory_cost_adjustments WHERE business_id = $1 AND id = $2`,
          [biz.businessId, adjustmentId],
        )
      ).rows[0],
    );
    expect(h, `${what}: the header`).toEqual({
      total: e.totalValueBaseMinor,
      binding: e.catchUpEntry ? adjustmentId : null,
      origin: run.prepared.cmd.purchaseId,
      line: null,
    });
    expect(BigInt(e.totalValueBaseMinor), `${what}: N = Σ stored movement values`).toBe(moved.reduce((s, m) => s + BigInt(m.value), 0n));
  }

  // The catch-up entry (N < 0: Dr cogs / Cr inventory; N > 0 the reverse), or none.
  const entry = adjustmentId === null ? null : await entryOf(c, biz.businessId, 'negative_inventory_cost_adjustment', adjustmentId);
  expect(entry !== null, `${what}: a catch-up entry iff N ≠ 0`).toBe(e.catchUpEntry);
  if (entry !== null) {
    const n = BigInt(e.totalValueBaseMinor);
    const abs = (n < 0n ? -n : n).toString(10);
    expect(
      entry.lines.map((l) => ({ key: l.system_key, debit: l.debit, credit: l.credit, warehouse: l.warehouse_id, branch: l.branch_id, ccy: l.txn_currency })),
      `${what}: the catch-up entry`,
    ).toEqual(
      n < 0n
        ? [
            { key: 'cogs', debit: abs, credit: '0', warehouse: biz.w1, branch: biz.branchX, ccy: 'ILS' },
            { key: 'inventory', debit: '0', credit: abs, warehouse: biz.w1, branch: biz.branchX, ccy: 'ILS' },
          ]
        : [
            { key: 'inventory', debit: abs, credit: '0', warehouse: biz.w1, branch: biz.branchX, ccy: 'ILS' },
            { key: 'cogs', debit: '0', credit: abs, warehouse: biz.w1, branch: biz.branchX, ccy: 'ILS' },
          ],
    );
  }
  const commit = await atCommit(c);
  expect(commit.ok, `${what}: every deferred guard accepts it — ${commit.ok ? '' : commit.message}`).toBe(true);
}

/** Run a whole vector in one rolled-back transaction and compare every receipt. */
async function runVector(id: string): Promise<{ runs: ReceiptRun[]; seedValue: bigint }> {
  const v = coverageVector(id);
  return rolledBack(async (c) => {
    await installStockFixture(c);
    const variantOf = variantMap(v, A);
    await seedVector(c, A, A.w1, v, variantOf);
    const supplierId = await createSupplier(c, A);
    const runs: ReceiptRun[] = [];
    for (const [k, r] of v.receipts.entries()) {
      const run = await receiveVector(c, A, supplierId, r, variantOf);
      await expectReceipt(c, A, run, r, variantOf, `${id} receipt ${k + 1}`);
      runs.push(run);
    }
    return { runs, seedValue: v.seed.reduce((s, x) => s + BigInt(x.state.valuation), 0n) };
  });
}

describe('T-08 every coverage vector, stored exactly as the package computes it', () => {
  it('the suite covers every vector of the file', () => {
    expect(coverageVectors().map((v) => v.id)).toEqual(['GOLD54', 'GOLD55', 'GOLD72', 'THREE-LAYERS', 'ZERO-CATCHUP', 'FLUSH-RESIDUE', 'MIXED-N0']);
  });

  it('T-08.1 GOLD-72: 4 then 6 against 10 short at 100 — −80, then the flush −180; the GL as AL08-CATCHUP-GOLD72', async () => {
    const v = coverageVector('GOLD72');
    const gl = must(
      (
        JSON.parse(readFileSync(join(__dirname, '../../packages/inventory/vectors/valuation-vectors.json'), 'utf8')) as {
          scenarios: { id: string; journal: { inventoryLineAmounts: string[]; glInventory: string }; cogs: string }[];
        }
      ).scenarios.find((s) => s.id === 'AL08-CATCHUP-GOLD72'),
    );
    await rolledBack(async (c) => {
      await installStockFixture(c);
      const variantOf = variantMap(v, A);
      await seedVector(c, A, A.w1, v, variantOf);
      const supplierId = await createSupplier(c, A);
      const inventoryAmounts: string[] = [];
      for (const [k, r] of v.receipts.entries()) {
        const run = await receiveVector(c, A, supplierId, r, variantOf);
        await expectReceipt(c, A, run, r, variantOf, `GOLD72 receipt ${k + 1}`);
        for (const entryId of [run.purchaseEntry?.entryId, run.catchUpEntry?.entryId]) {
          const rows = await c.query<{ n: string }>(
            `SELECT (l.debit_minor - l.credit_minor)::text AS n FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
              WHERE l.journal_entry_id = $1 AND a.system_key = 'inventory'`,
            [must(entryId)],
          );
          inventoryAmounts.push(must(rows.rows[0]).n);
        }
      }
      // The seed stands for the Phase 4 sale's entry (Dr COGS / Cr Inventory of the seeded value): the vector's first line.
      const seed = BigInt(must(gl.journal.inventoryLineAmounts[0]));
      expect(inventoryAmounts, 'the posted Inventory amounts after the seed').toEqual(gl.journal.inventoryLineAmounts.slice(1));
      expect(seed + (await glOf(c, A.businessId, 'inventory')), 'GL Inventory').toBe(BigInt(gl.journal.glInventory));
      expect(-seed + (await glOf(c, A.businessId, 'cogs')), 'COGS').toBe(BigInt(gl.cogs));
    });
  });

  it('T-08.2 THREE-LAYERS: one line covers three layers — three rows, three movements, one entry of their sum', async () => {
    const { runs } = await runVector('THREE-LAYERS');
    expect(runs[0]?.rows.filter((r) => r.row_kind === 'coverage').length).toBe(3);
  });

  it('T-08.3 GOLD-54: −100', async () => {
    await runVector('GOLD54');
  });

  it('T-08.3 GOLD-55: a provisional 0 — −600', async () => {
    await runVector('GOLD55');
  });

  it('T-08.4 ZERO-CATCHUP: actual = provisional — the coverage row, no movement, the header with no binding, no entry', async () => {
    await runVector('ZERO-CATCHUP');
  });

  it('T-08.5 FLUSH-RESIDUE: the line that closes every layer carries −valuation on its last coverage (−6, not the formula −4)', async () => {
    await runVector('FLUSH-RESIDUE');
  });

  it('T-08.6 MIXED-N0: −20 and +20 give N = 0 — two movements, no entry, header binding NULL', async () => {
    await runVector('MIXED-N0');
  });
});

describe('T-08.1 GOLD-72 through the real HTTP service (seed committed)', () => {
  let t: TestApp;
  let owner: HttpActor;
  let H: S3Business;

  beforeAll(async () => {
    await installCommittedDeficitFixture();
    t = await createTestApp();
    owner = await registerActor(t, 'Coverage owner');
    H = await onboardS3Business(t, owner, 'cov-http');
  });

  afterAll(async () => {
    await t.close();
    await removeCommittedDeficitFixture();
  });

  it('two receipts: −80 then −180, the layer closed, the key at 0/0, each receipt one purchase entry and one catch-up entry', async () => {
    const v = coverageVector('GOLD72');
    const seed = must(v.seed[0]);
    await seedCommittedDeficitKey(H, H.w1, H.piece.variantId, seed);
    const headers = asMember(owner, H.businessId);
    const sup = await t.request.post('/v1/suppliers').set(headers).send({ supplierId: randomUUID(), name: 'Coverage supplier' });
    expect(sup.status).toBe(201);
    const day = await today();
    for (const [k, r] of v.receipts.entries()) {
      const line = must(r.lines[0]);
      const purchaseId = randomUUID();
      const minor = BigInt(unitPriceFor(line.qty, line.baseShareMinor));
      const major = `${minor / 100n}.${(minor % 100n).toString(10).padStart(2, '0')}`;
      const draft = await t.request
        .put(`/v1/purchases/${purchaseId}`)
        .set(headers)
        .send({
          expectedRevision: 0,
          supplierId: sup.body.id,
          warehouseId: H.w1,
          currency: 'ILS',
          documentDate: day,
          lines: [{ lineId: randomUUID(), productId: H.piece.productId, quantity: line.qty, unitPrice: major }],
          landedCosts: [],
        });
      expect(draft.status, `draft ${k + 1}: ${JSON.stringify(draft.body)}`).toBe(201);
      const rec = await t.request.post(`/v1/purchases/${purchaseId}/receive`).set(headers).send({ draftRevision: 1 });
      expect(rec.status, `receive ${k + 1}: ${JSON.stringify(rec.body)}`).toBe(200);
      const el = must(r.expect.lines[0]);
      expect(rec.body.coverage.totalValueBaseMinor, `receipt ${k + 1}: N`).toBe(r.expect.totalValueBaseMinor);
      expect(
        (rec.body.coverage.coverages as { deficitId: string; qtyCovered: string; valueDeltaBaseMinor: string | null }[]).map((x) => ({
          deficitId: x.deficitId,
          qty: x.qtyCovered,
          value: x.valueDeltaBaseMinor,
        })),
        `receipt ${k + 1}: coverages`,
      ).toEqual(el.coverages.map((x) => ({ deficitId: x.deficitId, qty: x.qtyCovered, value: x.valueMinor })));
      expect(typeof rec.body.purchaseEntryId).toBe('string');
      expect(typeof rec.body.catchUpEntryId).toBe('string');
      expect(await levelText(ownerPool(), H.businessId, H.w1, H.piece.variantId), `receipt ${k + 1}: key after`).toEqual(el.stateAfter);
    }
    expect(await layersOf(ownerPool(), H.businessId, H.w1, H.piece.variantId)).toEqual([
      { id: must(seed.layers[0]).deficitId, uncovered: '0.0000', status: 'closed', original: '10.0000' },
    ]);
  });
});
