/**
 * P3-S4 T-06 — THE RECEIPT AND ITS POSTING
 * (docs/PHASE_3_S4_CONTRACT.md A-05, A-06, A-13, A-14, §6 T-06; P:207,
 * P:211, PM-22).
 *
 * - the purchase entry is exactly `Dr inventory B / Cr accounts_payable B`,
 *   the inventory line carrying the warehouse; there is no rounding (6100),
 *   price-variance (6200) or tax-payable line;
 * - Σ base shares s_i = B = the header's `total_base_minor` = the entry's
 *   amount, one `purchase` movement per line at its share, and the stock
 *   valuation grows by B exactly; the domestic vector's shares and unit
 *   costs are the vector's;
 * - a cash-labelled and a credit purchase of the same goods produce
 *   byte-identical entry shapes: the label is text, never a posting rule;
 * - the stock and accounting bindings and the purchase bridge are written
 *   once; a replay returns the stored rows and writes nothing new.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { expectAccepted, must, ownerClient, seedS3World, type S3World } from '../helpers/inventory-commands';
import {
  FULL_CONTACTS,
  createSupplier,
  draftAndReceive,
  entryOf,
  honestDraft,
  landedCostVectors,
  levelText,
  prepareReceipt,
  runReceipt,
  runCommand,
  s4Counts,
  s4Delta,
  tryCommand,
  vectorDraft,
  type EntryLineText,
  type ReceiptRun,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4rcpt');
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

interface MovementRow {
  source_line_id: string;
  variant_id: string;
  movement_kind: string;
  qty_delta: string;
  value_delta_base_minor: string;
  unit_cost_base_minor: string;
}

async function movementsOf(purchaseId: string): Promise<MovementRow[]> {
  const r = await c.query<MovementRow>(
    `SELECT source_line_id::text, variant_id::text, movement_kind, qty_delta::text, value_delta_base_minor::text, unit_cost_base_minor::text
       FROM stock_movements m WHERE business_id = $1 AND source_type = 'purchase' AND source_id = $2
      ORDER BY (SELECT l.line_no FROM purchase_lines l WHERE l.business_id = m.business_id AND l.id = m.source_line_id)`,
    [world.A.businessId, purchaseId],
  );
  return r.rows;
}

async function sharesOf(purchaseId: string): Promise<{ id: string; share: string; unit: string }[]> {
  const r = await c.query<{ id: string; share: string; unit: string }>(
    `SELECT id::text, base_share_minor::text AS share, unit_cost_base_minor::text AS unit
       FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 ORDER BY line_no`,
    [world.A.businessId, purchaseId],
  );
  return r.rows;
}

function shape(lines: readonly EntryLineText[]): Omit<EntryLineText, never>[] {
  return lines.map((l) => ({ ...l }));
}

/** The A-14(a) purchase entry of a run, checked line by line. */
async function expectPurchaseEntry(run: ReceiptRun): Promise<void> {
  const A = world.A;
  const B = run.prepared.cmd.totalBaseMinor.toString();
  const e = must(await entryOf(c, A.businessId, 'purchase', run.prepared.cmd.purchaseId), 'the purchase entry');
  expect(e.id).toBe(must(run.purchaseEntry).entryId);
  expect(e.lines.map((l) => ({ key: l.system_key, debit: l.debit, credit: l.credit, warehouse: l.warehouse_id }))).toEqual([
    { key: 'inventory', debit: B, credit: '0', warehouse: run.prepared.cmd.warehouseId },
    { key: 'accounts_payable', debit: '0', credit: B, warehouse: null },
  ]);
  const codes = e.lines.map((l) => l.code);
  for (const forbidden of ['6100', '6200', '2100']) expect(codes, `no ${forbidden} line`).not.toContain(forbidden);
  expect(e.lines.map((l) => l.system_key)).not.toContain('tax_payable');
}

describe('T-06 the purchase entry is Dr inventory B / Cr accounts_payable B, and Σ s_i = B', () => {
  it('the honest two-line draft with two landed costs: shares, movements, valuation, entry and bindings', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const draft = await honestDraft(c, A, supplierId);
      const levelsBefore = await Promise.all(draft.lines.map((l) => levelText(c, A.businessId, A.w1, l.variantId)));
      await runCommand(c, A, draft);
      const before = await s4Counts(c, A.businessId);
      const run = await runReceipt(c, A, await prepareReceipt(c, A, draft.purchaseId));
      const B = run.prepared.cmd.totalBaseMinor;

      const shares = await sharesOf(draft.purchaseId);
      expect(shares.map((s) => s.share)).toEqual(run.prepared.cmd.lines.map((l) => l.baseShareMinor.toString()));
      expect(
        shares.reduce((s, x) => s + BigInt(x.share), 0n),
        'Σ s_i = B',
      ).toBe(B);
      const header = must(
        (
          await c.query<{ status: string; total_base_minor: string; binding_source_id: string | null }>(
            `SELECT status, total_base_minor::text, binding_source_id::text FROM purchases WHERE business_id = $1 AND id = $2`,
            [A.businessId, draft.purchaseId],
          )
        ).rows[0],
      );
      expect(header).toEqual({ status: 'received', total_base_minor: B.toString(), binding_source_id: draft.purchaseId });

      const moves = await movementsOf(draft.purchaseId);
      expect(moves.map((m) => [m.source_line_id, m.variant_id, m.movement_kind, m.value_delta_base_minor])).toEqual(
        draft.lines.map((l, i) => [l.lineId, l.variantId, 'purchase', must(shares[i]).share]),
      );
      expect(moves.map((m) => m.unit_cost_base_minor)).toEqual(shares.map((s) => s.unit));

      for (const [i, l] of draft.lines.entries()) {
        const was = levelsBefore[i];
        const now = must(await levelText(c, A.businessId, A.w1, l.variantId));
        expect(BigInt(now.valuation) - BigInt(was?.valuation ?? '0'), `valuation of line ${i + 1}`).toBe(BigInt(must(shares[i]).share));
      }
      await expectPurchaseEntry(run);
      expect(run.catchUpEntry, 'no deficit, no catch-up').toBeNull();

      const d = s4Delta(before, await s4Counts(c, A.businessId));
      expect(d, 'one movement, one stock binding and one bridge row per line; one entry of two lines').toMatchObject({
        stock_movements: 2,
        stock_source_bindings: 2,
        stock_source_bridge_purchase: 2,
        journal_entries: 1,
        journal_lines: 2,
        accounting_source_bindings: 1,
      });
      expect(
        Object.keys(d).filter((k) => k.startsWith('negative_')),
        'no coverage',
      ).toEqual([]);
    });
  });

  it('PA-DOMESTIC-01: the base share and the unit cost are the vector’s', async () => {
    const v = must(landedCostVectors().purchases.find((p) => p.id === 'PA-DOMESTIC-01'));
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const run = await draftAndReceive(c, A, await vectorDraft(c, A, supplierId, v.lines, v.landedCosts));
      expect(run.prepared.cmd.totalBaseMinor.toString()).toBe(v.expect.totalBaseMinor);
      expect((await sharesOf(run.prepared.cmd.purchaseId)).map((s) => ({ share: s.share, unit: s.unit }))).toEqual(
        v.expect.lines.map((l) => ({ share: l.baseShareMinor, unit: l.unitCostBaseMinor })),
      );
      await expectPurchaseEntry(run);
    });
  });

  it('a cash-labelled and a credit purchase of the same goods produce byte-identical entry shapes', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const cash = await draftAndReceive(c, A, await honestDraft(c, A, supplierId, { supplierReference: 'CASH-001', notes: 'paid cash on delivery' }));
      const credit = await draftAndReceive(c, A, await honestDraft(c, A, supplierId, { supplierReference: 'NET30-001', notes: 'on credit, net 30' }));
      const a = must(await entryOf(c, A.businessId, 'purchase', cash.prepared.cmd.purchaseId));
      const b = must(await entryOf(c, A.businessId, 'purchase', credit.prepared.cmd.purchaseId));
      expect(shape(a.lines)).toEqual(shape(b.lines));
      expect(a.entry_date).toBe(b.entry_date);
      expect(a.lines.map((l) => l.system_key)).toEqual(['inventory', 'accounts_payable']);
    });
  });

  it('a replay returns the stored rows and writes no second movement, binding or entry', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const run = await draftAndReceive(c, A, await honestDraft(c, A, supplierId));
      const before = await s4Counts(c, A.businessId);
      const again = expectAccepted(await tryCommand(c, A, run.prepared.cmd));
      expect(again.every((r) => r.replayed)).toBe(true);
      expect(again.map((r) => [r.line_id, r.movement_id, r.base_share_minor])).toEqual(run.rows.map((r) => [r.line_id, r.movement_id, r.base_share_minor]));
      expect(s4Delta(before, await s4Counts(c, A.businessId)), 'only the assertion use').toEqual({ inventory_assertion_uses: 1 });
    });
  });
});
