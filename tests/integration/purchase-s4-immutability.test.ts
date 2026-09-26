/**
 * P3-S4 T-07 — A RECEIVED OR CANCELLED PURCHASE IS FINAL
 * (docs/PHASE_3_S4_CONTRACT.md A-04, A-15, A-16(i), §6 T-07; P:214).
 *
 * As the OWNER (a superuser: no grant or policy stands in the way, only the
 * triggers), and again as the internal principal:
 *   - a received header refuses UPDATE of any column (the supplier snapshots
 *     and the totals included) and DELETE (`inventory.source_document_immutable`);
 *   - its lines, landed costs and allocations refuse UPDATE and DELETE
 *     (`inventory.source_line_frozen`), and — after the M2 migration fix —
 *     an INSERT under the received header too;
 *   - the purchase bridge, the coverage header and the coverages are
 *     append-only (`inventory.ledger_immutable`);
 *   - a cancelled purchase refuses the same, and a receipt
 *     (`purchase.state_invalid`);
 *   - the internal principal's UPDATE/DELETE is business-isolated (M2): run
 *     under A's scope it reaches no row of A2 or B.
 */
import { randomUUID } from 'node:crypto';
import type { Client, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { attempt, expectAccepted, must, ownerClient, refusedWith, seedS3World, type Outcome, type S3World } from '../helpers/inventory-commands';
import { installStockFixture } from '../helpers/stock-ledger';
import {
  FULL_CONTACTS,
  cancelCommand,
  createSupplier,
  draftAndReceive,
  draftCommand,
  honestDraft,
  prepareReceipt,
  runCommand,
  runReceipt,
  s4Counts,
  s4Delta,
  tryCommand,
} from '../helpers/purchase-commands';
import { coverageVector, seedDeficitKey } from '../helpers/purchase-deficits';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4immut');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

const sql = (text: string, params: unknown[]): Promise<Outcome> => attempt(c, () => c.query(text, params));

/** As the internal principal under A's scope. */
const asInternal = (text: string, params: unknown[]): Promise<Outcome<QueryResult>> =>
  attempt(c, async () => {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [world.A.tenantId, world.A.businessId]);
    await c.query('SET LOCAL ROLE daftar_inventory_internal');
    return c.query(text, params);
  });

interface Doc {
  purchaseId: string;
  lineId: string;
  costId: string;
}

async function docOf(purchaseId: string): Promise<Doc> {
  const r = must(
    (
      await c.query<{ line: string; cost: string }>(
        `SELECT (SELECT id::text FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 ORDER BY line_no LIMIT 1) AS line,
                (SELECT id::text FROM purchase_landed_costs WHERE business_id = $1 AND purchase_id = $2 ORDER BY cost_no LIMIT 1) AS cost`,
        [world.A.businessId, purchaseId],
      )
    ).rows[0],
  );
  return { purchaseId, lineId: r.line, costId: r.cost };
}

/** Every UPDATE and DELETE a final purchase must refuse, with the code of the guard that refuses it. */
function edits(d: Doc): { what: string; text: string; code: string }[] {
  const B = world.A.businessId;
  const p = `business_id = '${B}' AND id = '${d.purchaseId}'`;
  const child = `business_id = '${B}' AND purchase_id = '${d.purchaseId}'`;
  return [
    { what: 'header notes', text: `UPDATE purchases SET notes = 'edited' WHERE ${p}`, code: 'inventory.source_document_immutable' },
    { what: 'header status', text: `UPDATE purchases SET status = 'draft' WHERE ${p}`, code: 'inventory.source_document_immutable' },
    { what: 'header total', text: `UPDATE purchases SET total_base_minor = total_base_minor + 1 WHERE ${p}`, code: 'inventory.source_document_immutable' },
    { what: 'supplier snapshot', text: `UPDATE purchases SET supplier_name_snapshot = 'Other' WHERE ${p}`, code: 'inventory.source_document_immutable' },
    { what: 'header delete', text: `DELETE FROM purchases WHERE ${p}`, code: 'inventory.source_document_immutable' },
    { what: 'line qty', text: `UPDATE purchase_lines SET qty = qty + 1 WHERE ${child}`, code: 'inventory.source_line_frozen' },
    { what: 'line share', text: `UPDATE purchase_lines SET base_share_minor = base_share_minor WHERE ${child}`, code: 'inventory.source_line_frozen' },
    { what: 'line delete', text: `DELETE FROM purchase_lines WHERE ${child}`, code: 'inventory.source_line_frozen' },
    { what: 'landed cost', text: `UPDATE purchase_landed_costs SET description = 'x' WHERE ${child}`, code: 'inventory.source_line_frozen' },
    { what: 'landed cost delete', text: `DELETE FROM purchase_landed_costs WHERE ${child}`, code: 'inventory.source_line_frozen' },
    {
      what: 'allocation',
      text: `UPDATE purchase_landed_cost_allocations SET amount_txn_minor = amount_txn_minor WHERE ${child}`,
      code: 'inventory.source_line_frozen',
    },
    { what: 'allocation delete', text: `DELETE FROM purchase_landed_cost_allocations WHERE ${child}`, code: 'inventory.source_line_frozen' },
  ];
}

/** An INSERT under the final header of each child table (the M2 BEFORE INSERT freeze). */
function inserts(d: Doc): { what: string; text: string }[] {
  const A = world.A;
  const ids = `'${A.tenantId}', '${A.businessId}', '${d.purchaseId}'`;
  return [
    {
      what: 'a new line',
      text: `INSERT INTO purchase_lines (tenant_id, business_id, purchase_id, id, line_no, variant_id, qty, unit_price_txn_minor, gross_txn_minor,
                                     discount_txn_minor, net_txn_minor, landed_cost_txn_minor)
             VALUES (${ids}, '${randomUUID()}', 99, '${A.variantProduct.variantIds[0]}', 1, 100, 100, 0, 100, 0)`,
    },
    {
      what: 'a new landed cost',
      text: `INSERT INTO purchase_landed_costs (tenant_id, business_id, purchase_id, id, cost_no, mode, amount_txn_minor)
             VALUES (${ids}, '${randomUUID()}', 99, 'by_value', 1)`,
    },
    {
      // The (cost, line) pair already exists: a BEFORE INSERT freeze answers before the primary key can.
      what: 'an allocation',
      text: `INSERT INTO purchase_landed_cost_allocations (tenant_id, business_id, purchase_id, landed_cost_id, purchase_line_id, amount_txn_minor)
             VALUES (${ids}, '${d.costId}', '${d.lineId}', 0)`,
    },
  ];
}

describe('T-07 a received purchase is final', () => {
  it('as owner: every UPDATE and DELETE of header, snapshots, lines, landed costs and allocations is refused', async () => {
    await inTx(async () => {
      const A = world.A;
      const run = await draftAndReceive(c, A, await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS)));
      const d = await docOf(run.prepared.cmd.purchaseId);
      const before = await s4Counts(c, A.businessId);
      for (const e of edits(d)) refusedWith(await sql(e.text, []), 'P0001', e.code, e.what);
      for (const bridge of [`UPDATE stock_source_bridge_purchase SET source_id = source_id`, `DELETE FROM stock_source_bridge_purchase`]) {
        refusedWith(await sql(`${bridge} WHERE business_id = $1`, [A.businessId]), 'P0001', 'inventory.ledger_immutable', bridge);
      }
      expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
    });
  });

  it('as the internal principal: the same edits are refused', async () => {
    await inTx(async () => {
      const A = world.A;
      const run = await draftAndReceive(c, A, await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS)));
      const d = await docOf(run.prepared.cmd.purchaseId);
      for (const e of edits(d).filter((x) => /status|total|snapshot|share|delete/.test(x.what) && !x.what.startsWith('header delete'))) {
        refusedWith(await asInternal(e.text, []), 'P0001', e.code, `internal: ${e.what}`);
      }
    });
  });

  it('an INSERT of a line, a landed cost or an allocation under a received purchase → inventory.source_line_frozen (M2)', async () => {
    await inTx(async () => {
      const A = world.A;
      const run = await draftAndReceive(c, A, await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS)));
      const d = await docOf(run.prepared.cmd.purchaseId);
      for (const i of inserts(d)) refusedWith(await sql(i.text, []), 'P0001', 'inventory.source_line_frozen', i.what);
    });
  });

  it('the coverage header and its coverages are append-only', async () => {
    await inTx(async () => {
      const A = world.A;
      await installStockFixture(c);
      const v = coverageVector('GOLD54');
      await seedDeficitKey(c, A, A.w1, A.piece.variantId, must(v.seed[0]));
      const line = must(must(v.receipts[0]).lines[0]);
      const draft = await draftCommand(c, await createSupplier(c, A, FULL_CONTACTS), A.w1, [
        { variantId: A.piece.variantId, qty: line.qty, unitPriceMinor: '120' },
      ]);
      await runCommand(c, A, draft);
      const run = await runReceipt(c, A, await prepareReceipt(c, A, draft.purchaseId));
      const adj = must(run.prepared.cmd.coverageAdjustmentId);
      expect(run.catchUpEntry, 'GOLD-54 posts a catch-up').not.toBeNull();
      for (const text of [
        `UPDATE negative_inventory_cost_adjustments SET warehouse_id = warehouse_id WHERE business_id = $1 AND id = $2`,
        `DELETE FROM negative_inventory_cost_adjustments WHERE business_id = $1 AND id = $2`,
        `UPDATE negative_deficit_coverages SET qty_covered = qty_covered WHERE business_id = $1 AND adjustment_id = $2`,
        `DELETE FROM negative_deficit_coverages WHERE business_id = $1 AND adjustment_id = $2`,
        `UPDATE stock_source_bridge_negative_inventory_cost_adjustment SET source_id = source_id WHERE business_id = $1 AND source_id = $2`,
      ]) {
        refusedWith(await sql(text, [A.businessId, adj]), 'P0001', 'inventory.ledger_immutable', text);
      }
    });
  });
});

describe('T-07 a cancelled purchase is final', () => {
  it('refuses every edit, a receipt and a replace', async () => {
    await inTx(async () => {
      const A = world.A;
      const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
      await runCommand(c, A, draft);
      const prepared = await prepareReceipt(c, A, draft.purchaseId);
      await runCommand(c, A, cancelCommand(draft.purchaseId, draft.warehouseId, 1));
      const d = await docOf(draft.purchaseId);
      const before = await s4Counts(c, A.businessId);
      for (const e of edits(d).filter((x) => !x.what.includes('share'))) refusedWith(await sql(e.text, []), 'P0001', e.code, `cancelled: ${e.what}`);
      refusedWith(await tryCommand(c, A, prepared.cmd), 'P0001', 'purchase.state_invalid', 'receive a cancelled purchase');
      refusedWith(await tryCommand(c, A, { ...draft, expectedRevision: 1 }), 'P0001', 'purchase.state_invalid', 'replace a cancelled purchase');
      expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
    });
  });

  it('an INSERT of a line, a landed cost or an allocation under a cancelled purchase → inventory.source_line_frozen (M2)', async () => {
    await inTx(async () => {
      const A = world.A;
      const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
      await runCommand(c, A, draft);
      await runCommand(c, A, cancelCommand(draft.purchaseId, draft.warehouseId, 1));
      const d = await docOf(draft.purchaseId);
      for (const i of inserts(d)) refusedWith(await sql(i.text, []), 'P0001', 'inventory.source_line_frozen', i.what);
    });
  });
});

describe('T-07 the internal principal is business-isolated (M2)', () => {
  it('under A’s scope, its UPDATE and DELETE reach no row of A2 (same owner) or B; its own business’s draft lines it may replace', async () => {
    await inTx(async () => {
      for (const X of [world.A2, world.B]) {
        const supplierId = await createSupplier(c, X, FULL_CONTACTS);
        const draft = await honestDraft(c, X, supplierId);
        await runCommand(c, X, draft);
        const theirs = await s4Counts(c, X.businessId);
        const del = expectAccepted(await asInternal(`DELETE FROM purchase_landed_cost_allocations WHERE purchase_id = $1`, [draft.purchaseId]));
        expect(del.rowCount, `DELETE of ${X === world.B ? 'B' : 'A2'}’s allocations`).toBe(0);
        const upd = expectAccepted(await asInternal(`UPDATE suppliers SET name = 'Hijacked', revision = revision + 1 WHERE id = $1`, [supplierId]));
        expect(upd.rowCount, 'UPDATE of their supplier').toBe(0);
        const lvl = expectAccepted(await asInternal(`UPDATE negative_inventory_deficits SET status = status WHERE business_id = $1`, [X.businessId]));
        expect(lvl.rowCount, 'UPDATE of their deficits').toBe(0);
        expect(s4Delta(theirs, await s4Counts(c, X.businessId)), 'their state untouched').toEqual({});
      }
      const A = world.A;
      const mine = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
      await runCommand(c, A, mine);
      const own = expectAccepted(await asInternal(`DELETE FROM purchase_landed_cost_allocations WHERE purchase_id = $1`, [mine.purchaseId]));
      expect(own.rowCount, 'its own business’s draft allocations').toBe(4);
    });
  });
});
