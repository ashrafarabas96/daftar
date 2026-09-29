/**
 * P3-S4 T-04 — THE PURCHASE DRAFT
 * (docs/PHASE_3_S4_CONTRACT.md A-04, A-12, A-13 steps 1-5, §6 T-04;
 * L:737, L:767-768).
 *
 * - a create stores the A-13 transaction-currency figures of every
 *   `landed-cost-vectors.json` purchase exactly (gross, discount, net,
 *   landed share per line, allocations, subtotal, landed total, total);
 * - a replace advances the revision by one, keeps the line ids the client
 *   sends, and replaces lines, landed costs and allocations in full; a stale
 *   revision is `purchase.draft_changed`; a create over another draft is
 *   `purchase.idempotency_conflict`; the identical command replays;
 * - 200 lines are accepted and 201 refused; a repeated variant is
 *   `purchase.duplicate_variant`; a discount above the gross (the vector) or
 *   below zero is `purchase.discount_invalid`, a discount equal to the gross
 *   is accepted; the refusal vectors answer their codes;
 * - a draft writes no movement, no stock binding, no journal entry and no
 *   accounting binding: nothing reaches AP;
 * - a cancelled draft is terminal (`purchase.state_invalid`).
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { expectAccepted, must, ownerClient, refusedWith, seedS3World, type S3World } from '../helpers/inventory-commands';
import { addVariantProduct } from '../helpers/stock-ledger';
import {
  FULL_CONTACTS,
  cancelCommand,
  createSupplier,
  draftCommand,
  honestDraft,
  landedCostVectors,
  runCommand,
  s4Counts,
  s4Delta,
  tryCommand,
  vectorDraft,
  type DraftCommand,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;
let many: string[];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4draft');
  many = (await addVariantProduct(ownerPool(), world.A, 201)).variantIds;
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

interface StoredLine {
  id: string;
  line_no: number;
  variant_id: string;
  gross: string;
  discount: string;
  net: string;
  landed: string;
  base_share_minor: string | null;
}

async function storedLines(purchaseId: string): Promise<StoredLine[]> {
  const r = await c.query<StoredLine>(
    `SELECT id::text, line_no, variant_id::text, gross_txn_minor::text AS gross, discount_txn_minor::text AS discount, net_txn_minor::text AS net,
            landed_cost_txn_minor::text AS landed, base_share_minor::text
       FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 ORDER BY line_no`,
    [world.A.businessId, purchaseId],
  );
  return r.rows;
}

async function storedAllocations(purchaseId: string): Promise<string[][]> {
  const r = await c.query<{ a: string[] }>(
    `SELECT array_agg(a.amount_txn_minor::text ORDER BY l.line_no) AS a
       FROM purchase_landed_costs lc
       JOIN purchase_landed_cost_allocations a ON a.business_id = lc.business_id AND a.landed_cost_id = lc.id
       JOIN purchase_lines l ON l.business_id = a.business_id AND l.id = a.purchase_line_id
      WHERE lc.business_id = $1 AND lc.purchase_id = $2
      GROUP BY lc.cost_no ORDER BY lc.cost_no`,
    [world.A.businessId, purchaseId],
  );
  return r.rows.map((x) => x.a);
}

async function header(purchaseId: string): Promise<Record<string, string | number>> {
  return must(
    (
      await c.query<Record<string, string | number>>(
        `SELECT status, revision, currency_code::text AS currency, subtotal_txn_minor::text AS subtotal, landed_cost_txn_minor::text AS landed,
                tax_minor::text AS tax, total_txn_minor::text AS total
           FROM purchases WHERE business_id = $1 AND id = $2`,
        [world.A.businessId, purchaseId],
      )
    ).rows[0],
    `purchase ${purchaseId}`,
  );
}

/** What a draft may write: the document, its audit and outbox rows and its assertion use — never stock, entry or AP. */
const DRAFT_ONLY = new Set([
  'purchases',
  'purchase_lines',
  'purchase_landed_costs',
  'purchase_landed_cost_allocations',
  'audit_events',
  'outbox_events',
  'inventory_assertion_uses',
  'purchases_state',
  'purchase_lines_state',
]);

describe('T-04 a draft stores the A-13 figures of every purchase vector and nothing else', () => {
  for (const v of landedCostVectors().purchases) {
    it(`${v.id}: lines, allocations and totals as the vector states; no movement, entry or AP`, async () => {
      await inTx(async () => {
        const A = world.A;
        const supplierId = await createSupplier(c, A, FULL_CONTACTS);
        const draft = await vectorDraft(c, A, supplierId, v.lines, v.landedCosts, { currency: v.txnCurrency });
        const before = await s4Counts(c, A.businessId);
        const rows = expectAccepted(await tryCommand(c, A, draft), v.id);
        expect(must(rows[0])).toMatchObject({ replayed: false, revision: 1, status: 'draft' });
        const d = s4Delta(before, await s4Counts(c, A.businessId));
        expect(
          Object.keys(d).filter((k) => !DRAFT_ONLY.has(k)),
          'a draft moves no stock and posts nothing',
        ).toEqual([]);
        expect([d.purchases, d.purchase_lines, d.purchase_landed_costs ?? 0]).toEqual([1, v.lines.length, v.landedCosts.length]);

        const lines = await storedLines(draft.purchaseId);
        expect(lines.map((l) => ({ id: l.id, gross: l.gross, net: l.net, landed: l.landed, discount: l.discount, share: l.base_share_minor }))).toEqual(
          v.expect.lines.map((e, i) => ({
            id: must(draft.lines[i]).lineId,
            gross: e.grossMinor,
            net: e.netMinor,
            landed: e.landedMinor,
            discount: must(v.lines[i]).discountMinor,
            share: null,
          })),
        );
        expect(await storedAllocations(draft.purchaseId)).toEqual(v.expect.allocations);
        expect(await header(draft.purchaseId)).toEqual({
          status: 'draft',
          revision: 1,
          currency: v.txnCurrency,
          subtotal: v.expect.subtotalMinor,
          landed: v.expect.landedMinor,
          tax: '0',
          total: v.expect.totalTxnMinor,
        });
      });
    });
  }

  for (const v of landedCostVectors().refusals) {
    it(`${v.id} → ${v.outcome}, nothing written`, async () => {
      await inTx(async () => {
        const A = world.A;
        const supplierId = await createSupplier(c, A, FULL_CONTACTS);
        const draft = await vectorDraft(c, A, supplierId, v.lines, v.landedCosts);
        const before = await s4Counts(c, A.businessId);
        refusedWith(await tryCommand(c, A, draft, { raw: true }), 'P0001', v.outcome);
        expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
      });
    });
  }
});

describe('T-04 replace, conflict and replay', () => {
  it('a replace advances the revision by one, keeps the sent line ids and replaces lines, costs and allocations in full', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const first = await honestDraft(c, A, supplierId);
      await runCommand(c, A, first);
      const [l1, l2] = first.lines;
      const kept = must(l1);
      const replace: DraftCommand = {
        ...first,
        expectedRevision: 1,
        supplierReference: 'INV-2291-B',
        lines: [
          { ...kept, qty: '5', unitPriceMinor: '1300' },
          { lineId: randomUUID(), variantId: A.dec2.variantId, qty: '1.25', unitPriceMinor: '400', discountMinor: 0n },
        ],
        landedCosts: [{ landedCostId: randomUUID(), mode: 'by_value', amountMinor: 50n, description: null, allocations: null }],
      };
      const rows = expectAccepted(await tryCommand(c, A, replace));
      expect(must(rows[0])).toMatchObject({ replayed: false, revision: 2 });
      const lines = await storedLines(first.purchaseId);
      expect(lines.map((l) => [l.id, l.variant_id, l.line_no])).toEqual([
        [kept.lineId, kept.variantId, 1],
        [must(replace.lines[1]).lineId, A.dec2.variantId, 2],
      ]);
      expect(
        lines.some((l) => l.id === must(l2).lineId),
        'a line the replace does not send is gone',
      ).toBe(false);
      expect(
        (await c.query(`SELECT 1 FROM purchase_landed_costs WHERE business_id = $1 AND purchase_id = $2`, [A.businessId, first.purchaseId])).rowCount,
        'one landed cost now',
      ).toBe(1);
      expect((await storedAllocations(first.purchaseId)).map((a) => a.length)).toEqual([2]);
      expect(await header(first.purchaseId)).toMatchObject({ revision: 2, landed: '50' });

      refusedWith(await tryCommand(c, A, { ...replace, supplierReference: 'late' }), 'P0001', 'purchase.draft_changed', 'revision 1 again');
      refusedWith(await tryCommand(c, A, { ...first, supplierReference: 'another' }), 'P0001', 'purchase.idempotency_conflict', 'a create over the draft');
      const replay = expectAccepted(await tryCommand(c, A, replace), 'the identical replace');
      expect(must(replay[0]).replayed).toBe(true);
      expect(await header(first.purchaseId)).toMatchObject({ revision: 2 });
      refusedWith(await tryCommand(c, A, { ...replace, purchaseId: randomUUID() }), 'P0001', 'purchase.not_found', 'a replace of no draft');
    });
  });

  it('a cancelled draft is terminal: replace and cancel again refuse; the identical cancel replays', async () => {
    await inTx(async () => {
      const A = world.A;
      const d = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
      await runCommand(c, A, d);
      const cancel = cancelCommand(d.purchaseId, d.warehouseId, 1);
      expect(must(expectAccepted(await tryCommand(c, A, cancel))[0])).toMatchObject({ replayed: false, status: 'cancelled' });
      expect(must(expectAccepted(await tryCommand(c, A, cancel))[0]).replayed).toBe(true);
      refusedWith(await tryCommand(c, A, { ...d, expectedRevision: 1 }), 'P0001', 'purchase.state_invalid', 'replace a cancelled draft');
      refusedWith(await tryCommand(c, A, cancelCommand(d.purchaseId, d.warehouseId, 2)), 'P0001', 'purchase.state_invalid', 'cancel it again');
    });
  });
});

describe('T-04 bounds', () => {
  it('200 lines are accepted; 201 are refused', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const lines = (n: number) => many.slice(0, n).map((variantId) => ({ variantId, qty: '1', unitPriceMinor: '100' }));
      const ok = await draftCommand(c, supplierId, A.w1, lines(200));
      expect(must(expectAccepted(await tryCommand(c, A, ok), '200 lines')[0]).revision).toBe(1);
      expect((await storedLines(ok.purchaseId)).length).toBe(200);
      const over = await draftCommand(c, supplierId, A.w1, lines(201));
      refusedWith(await tryCommand(c, A, over, { raw: true }), 'P0001', 'inventory.payload_invalid', '201 lines');
    });
  });

  it('a repeated variant → duplicate_variant; a discount above the gross or below zero → discount_invalid; equal to the gross → accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const dup = await draftCommand(c, supplierId, A.w1, [
        { variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' },
        { variantId: A.piece.variantId, qty: '2', unitPriceMinor: '100' },
      ]);
      refusedWith(await tryCommand(c, A, dup, { raw: true }), 'P0001', 'purchase.duplicate_variant');
      const withDiscount = (discountMinor: bigint) =>
        draftCommand(c, supplierId, A.w1, [
          { variantId: A.piece.variantId, qty: '2', unitPriceMinor: '150', discountMinor },
          { variantId: A.piece2.variantId, qty: '1', unitPriceMinor: '100' },
        ]);
      refusedWith(await tryCommand(c, A, await withDiscount(301n), { raw: true }), 'P0001', 'purchase.discount_invalid', 'gross + 1');
      refusedWith(await tryCommand(c, A, await withDiscount(-1n), { raw: true }), 'P0001', 'purchase.discount_invalid', '−1');
      const full = await withDiscount(300n);
      expectAccepted(await tryCommand(c, A, full), 'discount = gross');
      expect((await storedLines(full.purchaseId)).map((l) => l.net)).toEqual(['0', '100']);
      expect(await header(full.purchaseId)).toMatchObject({ subtotal: '100', total: '100' });
    });
  });

  it('an unregistered currency and an untracked product are refused; nothing is written', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const before = await s4Counts(c, A.businessId);
      refusedWith(await tryCommand(c, A, await honestDraft(c, A, supplierId, { currency: 'XQZ' }), { raw: true }), 'P0001', 'purchase.currency_unknown');
      refusedWith(
        await tryCommand(c, A, await draftCommand(c, supplierId, A.w1, [{ variantId: A.untracked.variantId, qty: '1', unitPriceMinor: '100' }])),
        'P0001',
        'inventory.product_not_tracked',
      );
      expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
    });
  });
});
