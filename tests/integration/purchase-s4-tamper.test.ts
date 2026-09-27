/**
 * P3-S4 T-15 — THE DEFERRED GUARDS, ONE PER MECHANISM
 * (docs/PHASE_3_S4_CONTRACT.md A-14, A-15, A-16(g), §6 T-15; L:1550-1568).
 *
 * The OWNER — a superuser, past every grant and policy — forges exactly one
 * fact each time, and the deferred guard of that fact refuses it at COMMIT
 * (probed with `SET CONSTRAINTS ALL IMMEDIATE`, always rolled back):
 *   1. a received purchase line without its movement
 *      (`inventory.source_movement_set_incomplete`);
 *   2. a coverage without its catch-up movement (the same code, from the
 *      coverage guard);
 *   3. a received header whose total is not Σ of its line shares and movement
 *      values (`inventory.source_value_mismatch`) — the immediate header
 *      guard switched off for that one probe, so the deferred one stands alone;
 *   4. a deficit decremented without a coverage (`inventory.deficit_coverage_mismatch`);
 *   5. a purchase entry with a third line (`accounting.inventory_entry_mismatch`);
 *   6. the generic reversal of a purchase entry, and of a catch-up entry
 *      (`accounting.reversal_source_domain_owned`);
 *   7. a coverage of a variant its origin purchase does not receive
 *      (`inventory.stock_source_line_missing`, R-36/R-41);
 *   8. a coverage added to its header by another operation — refused at
 *      once by the BEFORE INSERT same-transaction guard
 *      (`inventory.source_document_immutable`, R-36).
 * Each case first shows the honest state passes the same probe.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand } from '@daftar/accounting';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { atCommit, attempt, expectAccepted, must, ownerClient, refusedWith, seedS3World, today, type S3World } from '../helpers/inventory-commands';
import { domainReversalFingerprint, reverseInTx } from '../helpers/inventory-posting';
import { installStockFixture } from '../helpers/stock-ledger';
import {
  FULL_CONTACTS,
  createSupplier,
  draftAndReceive,
  draftCommand,
  honestDraft,
  postInTx,
  prepareReceipt,
  receiptPostings,
  runCommand,
  runReceipt,
  type PreparedReceipt,
  type ReceiptRun,
} from '../helpers/purchase-commands';
import { coverageVector, seedDeficitKey } from '../helpers/purchase-deficits';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4tamper');
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

async function honestProbe(): Promise<void> {
  expect((await atCommit(c)).ok, 'the honest state passes the COMMIT probe').toBe(true);
}

/** A saved domestic draft of A and its prepared receipt. */
async function prepared(): Promise<PreparedReceipt> {
  const A = world.A;
  const d = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
  await runCommand(c, A, d);
  return prepareReceipt(c, A, d.purchaseId);
}

/** The GOLD-54 coverage receipt of A, run and posted in the transaction. */
async function coverageReceipt(): Promise<ReceiptRun> {
  const A = world.A;
  await installStockFixture(c);
  const v = coverageVector('GOLD54');
  await seedDeficitKey(c, A, A.w1, A.piece.variantId, must(v.seed[0]));
  const line = must(must(v.receipts[0]).lines[0]);
  const draft = await draftCommand(c, await createSupplier(c, A, FULL_CONTACTS), A.w1, [
    { variantId: A.piece.variantId, qty: line.qty, unitPriceMinor: '120' },
  ]);
  await runCommand(c, A, draft);
  return runReceipt(c, A, await prepareReceipt(c, A, draft.purchaseId));
}

function withAmounts(cmd: PostingCommand, amounts: readonly bigint[]): PostingCommand {
  return { ...cmd, lines: cmd.lines.map((l, i) => ({ ...l, baseAmountMinor: must(amounts[i]), txnAmountMinor: must(amounts[i]) })) };
}

describe('T-15 each deferred guard refuses its forged fact at COMMIT', () => {
  it('1. a received purchase line without its movement → source_movement_set_incomplete', async () => {
    await inTx(async () => {
      const A = world.A;
      // A real receipt first: the transaction then holds a consumed purchase.receive assertion, as any posting of a purchase needs.
      await draftAndReceive(c, A, await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS)));
      const p = await prepared();
      await honestProbe();
      for (const l of p.cmd.lines) {
        await c.query(
          `UPDATE purchase_lines SET base_share_minor = $3::bigint, unit_cost_base_minor = round($3::numeric / qty, 10) WHERE business_id = $1 AND id = $2`,
          [A.businessId, l.lineId, l.baseShareMinor.toString()],
        );
      }
      await c.query(
        `UPDATE purchases SET status = 'received', receive_intent_sha256 = repeat('a', 64), source_to_base_rate = 1, rate_source = 'base',
                rate_timestamp = date_trunc('second', now()), total_base_minor = $3, supplier_name_snapshot = 'Forged', received_by = $4,
                received_at = now(), binding_source_id = id
          WHERE business_id = $1 AND id = $2`,
        [A.businessId, p.cmd.purchaseId, p.cmd.totalBaseMinor.toString(), A.userId],
      );
      await postInTx(c, receiptPostings(A, p, randomUUID()).purchase, A.userId);
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete');
    });
  });

  it('2. a coverage without its catch-up movement → source_movement_set_incomplete', async () => {
    await inTx(async () => {
      const A = world.A;
      const run = await coverageReceipt();
      await honestProbe();
      const adj = must(run.prepared.cmd.coverageAdjustmentId);
      // A second, open layer of the same key, and a coverage of it with a non-zero catch-up and no movement.
      const layer = randomUUID();
      const src = must(
        (
          await c.query<{ id: string }>(`SELECT source_stock_movement_id::text AS id FROM negative_inventory_deficits WHERE business_id = $1 LIMIT 1`, [
            A.businessId,
          ])
        ).rows[0],
      ).id;
      await c.query(
        `INSERT INTO negative_inventory_deficits (tenant_id, business_id, id, warehouse_id, variant_id, source_stock_movement_id, deficit_seq,
                                                  original_deficit_qty, uncovered_qty, provisional_unit_cost_base_minor, status)
         VALUES ($1, $2, $3, $4, $5, $6, 99, 1, 1, 100, 'open')`,
        [A.tenantId, A.businessId, layer, A.w1, A.piece.variantId, src],
      );
      await c.query(
        `INSERT INTO negative_deficit_coverages (tenant_id, business_id, adjustment_id, deficit_id, variant_id, qty_covered,
                                                 provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
         VALUES ($1, $2, $3, $4, $5, 1, 100, 120)`,
        [A.tenantId, A.businessId, adj, layer, A.piece.variantId],
      );
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete');
    });
  });

  it('3. a received header total ≠ Σ shares and movement values → source_value_mismatch (the immediate guard off)', async () => {
    await inTx(async () => {
      const A = world.A;
      // Off for the rest of this rolled-back transaction: a table with pending trigger events cannot be altered again.
      await c.query('ALTER TABLE purchases DISABLE TRIGGER purchases_immutable');
      const p = await prepared();
      await runCommand(c, A, p.cmd);
      const posting = receiptPostings(A, p, randomUUID()).purchase;
      const B = p.cmd.totalBaseMinor;
      await c.query(`UPDATE purchases SET total_base_minor = total_base_minor + 1 WHERE business_id = $1 AND id = $2`, [A.businessId, p.cmd.purchaseId]);
      // The entry agrees with the forged header, so only the value guard stands between it and COMMIT.
      await postInTx(c, withAmounts(posting, [B + 1n, B + 1n]), A.userId);
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_value_mismatch');
    });
  });

  it('4. a deficit decremented without a coverage → deficit_coverage_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      await installStockFixture(c);
      await seedDeficitKey(c, A, A.w1, A.piece.variantId, must(coverageVector('GOLD54').seed[0]));
      await honestProbe();
      await c.query(`UPDATE negative_inventory_deficits SET uncovered_qty = uncovered_qty - 1, status = 'partially_covered' WHERE business_id = $1`, [
        A.businessId,
      ]);
      refusedWith(await atCommit(c), 'P0001', 'inventory.deficit_coverage_mismatch');
    });
  });

  it('5. a purchase entry with a third line → accounting.inventory_entry_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      const p = await prepared();
      await runCommand(c, A, p.cmd);
      const posting = receiptPostings(A, p, randomUUID()).purchase;
      const [dr, cr] = [must(posting.lines[0]), must(posting.lines[1])];
      const B = p.cmd.totalBaseMinor;
      const threeLines: PostingCommand = {
        ...posting,
        lines: [{ ...dr, baseAmountMinor: B - 1n, txnAmountMinor: B - 1n }, { ...dr, baseAmountMinor: 1n, txnAmountMinor: 1n }, cr],
      };
      await postInTx(c, threeLines, A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch');
    });
  });

  it('6. the generic reversal of a purchase entry, and of a catch-up entry → reversal_source_domain_owned', async () => {
    await inTx(async () => {
      const A = world.A;
      const day = await today(c);
      const run = await coverageReceipt();
      await honestProbe();
      const purchaseEntry = must(run.purchaseEntry).entryId;
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, purchaseEntry, day, domainReversalFingerprint(run.postings.purchase, purchaseEntry, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'purchase',
      );
      const catchUp = must(run.catchUpEntry).entryId;
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, catchUp, day, domainReversalFingerprint(must(run.postings.catchUp), catchUp, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'negative_inventory_cost_adjustment',
      );
    });
  });

  it('7. a coverage of a variant its origin purchase does not receive → stock_source_line_missing (R-36)', async () => {
    await inTx(async () => {
      const A = world.A;
      // A real receipt of piece2 at w1 gives that key a movement a deficit layer can name; the GOLD-54 purchase receives only piece.
      // It runs first: the coverage below is then written by the coverage receipt's own operation, as R-36 requires.
      // Only piece2: the piece key stays empty for the GOLD-54 seed.
      await draftAndReceive(
        c,
        A,
        await draftCommand(c, await createSupplier(c, A, FULL_CONTACTS), A.w1, [{ variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '700' }]),
      );
      const run = await coverageReceipt();
      await honestProbe();
      const adj = must(run.prepared.cmd.coverageAdjustmentId);
      const movement = must(
        (
          await c.query<{ id: string }>(`SELECT id::text FROM stock_movements WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 LIMIT 1`, [
            A.businessId,
            A.w1,
            A.piece2.variantId,
          ])
        ).rows[0],
      ).id;
      const layer = randomUUID();
      await c.query(
        `INSERT INTO negative_inventory_deficits (tenant_id, business_id, id, warehouse_id, variant_id, source_stock_movement_id, deficit_seq,
                                                  original_deficit_qty, uncovered_qty, provisional_unit_cost_base_minor, status)
         VALUES ($1, $2, $3, $4, $5, $6, 99, 1, 1, 100, 'open')`,
        [A.tenantId, A.businessId, layer, A.w1, A.piece2.variantId, movement],
      );
      await c.query(
        `INSERT INTO negative_deficit_coverages (tenant_id, business_id, adjustment_id, deficit_id, variant_id, qty_covered,
                                                 provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
         VALUES ($1, $2, $3, $4, $5, 1, 100, 100)`,
        [A.tenantId, A.businessId, adj, layer, A.piece2.variantId],
      );
      refusedWith(await atCommit(c), 'P0001', 'inventory.stock_source_line_missing');
    });
  });

  it('8. a coverage added to its header by another operation → source_document_immutable at once (R-36); the creating operation may add it', async () => {
    await inTx(async () => {
      const A = world.A;
      const run = await coverageReceipt();
      await honestProbe();
      const adj = must(run.prepared.cmd.coverageAdjustmentId);
      const trace = must((await c.query<{ t: string }>(`SELECT current_setting('app.business_transaction_id', true) AS t`)).rows[0]).t;
      // A fresh open layer of the covered key, so the added coverage is unique on (adjustment, deficit).
      const layer = randomUUID();
      await c.query(
        `INSERT INTO negative_inventory_deficits (tenant_id, business_id, id, warehouse_id, variant_id, source_stock_movement_id, deficit_seq,
                                                  original_deficit_qty, uncovered_qty, provisional_unit_cost_base_minor, status)
         SELECT tenant_id, business_id, $2, warehouse_id, variant_id, source_stock_movement_id, 99, 1, 1, 100, 'open'
           FROM negative_inventory_deficits WHERE business_id = $1 LIMIT 1`,
        [A.businessId, layer],
      );
      const add = (): Promise<unknown> =>
        c.query(
          `INSERT INTO negative_deficit_coverages (tenant_id, business_id, adjustment_id, deficit_id, variant_id, qty_covered,
                                                   provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
           VALUES ($1, $2, $3, $4, $5, 1, 100, 120)`,
          [A.tenantId, A.businessId, adj, layer, A.piece.variantId],
        );
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [randomUUID()]);
      refusedWith(await attempt(c, add), 'P0001', 'inventory.source_document_immutable', 'another operation');
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [trace]);
      expectAccepted(await attempt(c, add), 'the creating operation passes the immediate guard');
    });
  });
});
