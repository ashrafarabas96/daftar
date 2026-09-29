/**
 * P3-S4 T-05 — LANDED COST, IN SQL, AGAINST THE PACKAGE VECTORS
 * (docs/PHASE_3_S4_CONTRACT.md A-13 step 3, §6 T-05; P:212-213).
 *
 * Every split of `landed-cost-vectors.json` is stated as a draft whose line
 * nets are the vector's inputs (quantity 1 at the input's price), and the
 * routine's stored allocations must equal the vector's exactly: an uneven
 * `by_value` split with the largest-remainder rule and the `line_no`
 * tie-break, Σ = the cost exactly, a zero-net line taking nothing; an all-zero
 * denominator is `purchase.landed_cost_denominator_zero`; a `manual` split
 * off by ±1 is `purchase.landed_cost_allocation_mismatch`.
 *
 * Behind the routine, the deferred allocation trigger refuses at COMMIT an
 * allocation set the owner tampered with directly (a cost's sum moved, or a
 * unit moved between lines so a line's landed share no longer matches).
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { atCommit, expectAccepted, must, ownerClient, refusedWith, seedS3World, type S3World } from '../helpers/inventory-commands';
import {
  FULL_CONTACTS,
  createSupplier,
  honestDraft,
  landedCostVectors,
  runCommand,
  s4Counts,
  s4Delta,
  tryCommand,
  vectorDraft,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4landed');
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

async function allocationsOf(purchaseId: string): Promise<{ line: string[]; alloc: string[] }> {
  const r = await c.query<{ landed: string; alloc: string }>(
    `SELECT l.landed_cost_txn_minor::text AS landed, a.amount_txn_minor::text AS alloc
       FROM purchase_lines l
       JOIN purchase_landed_cost_allocations a ON a.business_id = l.business_id AND a.purchase_line_id = l.id
      WHERE l.business_id = $1 AND l.purchase_id = $2 ORDER BY l.line_no`,
    [world.A.businessId, purchaseId],
  );
  return { line: r.rows.map((x) => x.landed), alloc: r.rows.map((x) => x.alloc) };
}

describe('T-05 every split vector, in SQL', () => {
  for (const v of landedCostVectors().splits) {
    it(`${v.id} (${v.kind}, ${v.amountMinor} over ${v.inputs.join('/')}) → ${v.outcome}`, async () => {
      await inTx(async () => {
        const A = world.A;
        const supplierId = await createSupplier(c, A, FULL_CONTACTS);
        const draft = await vectorDraft(
          c,
          A,
          supplierId,
          v.inputs.map((net) => ({ qty: '1.0000', unitPriceTxnMinor: net, discountMinor: '0' })),
          [{ mode: v.kind, amountMinor: v.amountMinor, allocations: v.kind === 'manual' ? v.inputs : null }],
        );
        const before = await s4Counts(c, A.businessId);
        if (v.outcome !== 'accepted') {
          refusedWith(await tryCommand(c, A, draft, { raw: true }), 'P0001', v.outcome);
          expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
          return;
        }
        expectAccepted(await tryCommand(c, A, draft));
        const allocations = must(v.allocations);
        const stored = await allocationsOf(draft.purchaseId);
        expect(stored.alloc, 'the stored allocations are the vector’s').toEqual(allocations);
        expect(stored.line, 'each line’s landed share is its allocation').toEqual(allocations);
        expect(
          stored.alloc.reduce((s, a) => s + BigInt(a), 0n),
          'Σ = the cost exactly',
        ).toBe(BigInt(v.amountMinor));
        const atCommitOutcome = await atCommit(c);
        expect(atCommitOutcome.ok, 'the deferred allocation trigger accepts the routine’s split').toBe(true);
      });
    });
  }
});

describe('T-05 the deferred allocation trigger refuses a tampered allocation at COMMIT', () => {
  async function saved(): Promise<string> {
    const A = world.A;
    const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
    await runCommand(c, A, draft);
    return draft.purchaseId;
  }

  it('a cost’s allocation re-inserted one unit higher → purchase.landed_cost_allocation_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      const purchaseId = await saved();
      expect((await atCommit(c)).ok, 'untampered').toBe(true);
      const row = must(
        (
          await c.query<{ landed_cost_id: string; purchase_line_id: string; amount: string }>(
            `DELETE FROM purchase_landed_cost_allocations
              WHERE business_id = $1 AND (landed_cost_id, purchase_line_id) =
                    (SELECT landed_cost_id, purchase_line_id FROM purchase_landed_cost_allocations WHERE business_id = $1 AND purchase_id = $2
                      ORDER BY landed_cost_id, purchase_line_id LIMIT 1)
              RETURNING landed_cost_id::text, purchase_line_id::text, amount_txn_minor::text AS amount`,
            [A.businessId, purchaseId],
          )
        ).rows[0],
      );
      await c.query(
        `INSERT INTO purchase_landed_cost_allocations (tenant_id, business_id, purchase_id, landed_cost_id, purchase_line_id, amount_txn_minor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [A.tenantId, A.businessId, purchaseId, row.landed_cost_id, row.purchase_line_id, (BigInt(row.amount) + 1n).toString()],
      );
      refusedWith(await atCommit(c), 'P0001', 'purchase.landed_cost_allocation_mismatch');
    });
  });

  it('a unit moved between two lines of one cost (the cost’s Σ kept) → mismatch: a line’s landed share no longer matches', async () => {
    await inTx(async () => {
      const A = world.A;
      const purchaseId = await saved();
      const rows = (
        await c.query<{ landed_cost_id: string; purchase_line_id: string; amount: string }>(
          `DELETE FROM purchase_landed_cost_allocations a
            USING purchase_landed_costs lc
            WHERE a.business_id = $1 AND a.purchase_id = $2 AND lc.business_id = a.business_id AND lc.id = a.landed_cost_id AND lc.cost_no = 1
            RETURNING a.landed_cost_id::text, a.purchase_line_id::text, a.amount_txn_minor::text AS amount`,
          [A.businessId, purchaseId],
        )
      ).rows.sort((x, y) => x.purchase_line_id.localeCompare(y.purchase_line_id));
      expect(rows).toHaveLength(2);
      const [a, b] = [must(rows[0]), must(rows[1])];
      const moved = BigInt(a.amount) > 0n ? [BigInt(a.amount) - 1n, BigInt(b.amount) + 1n] : [BigInt(a.amount) + 1n, BigInt(b.amount) - 1n];
      for (const [r, amount] of [
        [a, moved[0]],
        [b, moved[1]],
      ] as const) {
        await c.query(
          `INSERT INTO purchase_landed_cost_allocations (tenant_id, business_id, purchase_id, landed_cost_id, purchase_line_id, amount_txn_minor)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [A.tenantId, A.businessId, purchaseId, r.landed_cost_id, r.purchase_line_id, String(amount)],
        );
      }
      refusedWith(await atCommit(c), 'P0001', 'purchase.landed_cost_allocation_mismatch');
    });
  });

  it('an allocation for a cost that leaves a line out → mismatch (every cost allocates to every line)', async () => {
    await inTx(async () => {
      const A = world.A;
      const purchaseId = await saved();
      const lc = must(
        (
          await c.query<{ id: string }>(`SELECT id::text FROM purchase_landed_costs WHERE business_id = $1 AND purchase_id = $2 AND cost_no = 2`, [
            A.businessId,
            purchaseId,
          ])
        ).rows[0],
      );
      // The manual cost's zero-free split [60, 40]: drop the 40 row, re-insert the 60 row as 100 — Σ kept, a line left out.
      const gone = await c.query<{ purchase_line_id: string; amount: string }>(
        `DELETE FROM purchase_landed_cost_allocations WHERE business_id = $1 AND landed_cost_id = $2
          RETURNING purchase_line_id::text, amount_txn_minor::text AS amount`,
        [A.businessId, lc.id],
      );
      const keep = must(gone.rows.find((r) => r.amount === '60'));
      await c.query(
        `INSERT INTO purchase_landed_cost_allocations (tenant_id, business_id, purchase_id, landed_cost_id, purchase_line_id, amount_txn_minor)
         VALUES ($1, $2, $3, $4, $5, 100)`,
        [A.tenantId, A.businessId, purchaseId, lc.id, keep.purchase_line_id],
      );
      refusedWith(await atCommit(c), 'P0001', 'purchase.landed_cost_allocation_mismatch');
    });
  });
});
