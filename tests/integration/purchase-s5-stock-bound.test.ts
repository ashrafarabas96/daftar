/**
 * P3-S5 T-05 / T-06 — THE STOCK BOUND AND THE OTHER WAREHOUSE
 * (docs/PHASE_3_S5_CONTRACT.md A-10(e), A-12, TL-5, §6 T-05, T-06; MP-2,
 * MP-3, PM-14, L:911).
 *
 * T-05: a return of more than the return key holds is refused
 *       `inventory.insufficient_stock` — by the plan and, for a command
 *       prepared while the stock was there, by the routine at lock step 6 —
 *       with nothing written; `|q| = on_hand` flushes the key exactly
 *       (valuation 0, I = the whole valuation); the same return from a
 *       warehouse that holds the stock succeeds.
 * T-06: after an S3 transfer W1→W2 a W1 purchase is returned from W2, at
 *       W2's average, with PPV against the purchase's carrying value, the
 *       Inventory and PPV lines on W2 and its branch and AP on the purchase
 *       branch; an assertion signed over a W1 payload cannot be replayed for
 *       W2 (`inventory.assertion_payload_mismatch`). The HTTP scope side of
 *       T-06 is in `tests/security/purchase-s5-http.test.ts`.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  atCommit,
  expectAccepted,
  must,
  ownerClient,
  refusedWith,
  runCommand as runS3,
  seedS3World,
  stockState,
  transferCommand,
  type S3World,
} from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import {
  assertionFor,
  entryBySource,
  entryShape,
  preparationRefusal,
  prepareReturn,
  receivedPurchase,
  returnHeader,
  runReturn,
  s5Counts,
  threeWay,
  tryReturn,
  tryS5,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5stock');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

describe('T-05 the stock bound (PM-14)', () => {
  it('more than the return key holds → insufficient_stock by the plan and by the routine, nothing written; from the warehouse holding it → accepted', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      const line = must(p.lines[0]);
      // Prepared while W1 holds the four pieces, then three of them leave for W2.
      const prep = await prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: line.lineId, qty: '2' }] });
      await runS3(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '3' }]));
      expect(await preparationRefusal(prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: line.lineId, qty: '2' }] })), 'the plan').toBe(
        'inventory.insufficient_stock',
      );
      const before = await s5Counts(c, A.businessId);
      refusedWith(await tryReturn(c, A, prep), 'P0001', 'inventory.insufficient_stock', 'the routine, at lock step 6');
      expect(await s5Counts(c, A.businessId), 'nothing written').toEqual(before);
      // The same return from W2, which holds the stock, succeeds.
      expectAccepted(await tryReturn(c, A, await prepareReturn(c, A, p.purchaseId, { warehouseId: A.w2, lines: [{ purchaseLineId: line.lineId, qty: '2' }] })));
      expectAccepted(await atCommit(c));
    });
  });

  it('|q| = on_hand flushes the key exactly: on hand 0, valuation 0, I = the whole valuation before', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const key = { warehouseId: A.w1, variantId: A.piece2.variantId };
      // Two purchases on one key: 1 at 400 and 2 at 300, three pieces worth 1000 — a non-terminating average.
      const first = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '1', unitPriceMinor: '400' }]);
      const second = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '300' }]);
      await runReturn(c, A, await prepareReturn(c, A, second.purchaseId, { lines: [{ purchaseLineId: must(second.lines[0]).lineId, qty: '2' }] }));
      const held = await stockState(c, A.businessId, key);
      expect(held.onHand, 'one piece is left').toBe(10_000n);
      // |q| = on_hand: the last piece leaves with exactly the stored valuation.
      const flush = await runReturn(c, A, await prepareReturn(c, A, first.purchaseId, { lines: [{ purchaseLineId: must(first.lines[0]).lineId, qty: '1' }] }));
      const emptied = await stockState(c, A.businessId, key);
      expect([emptied.onHand, emptied.valuation], 'the key is empty and worth nothing').toEqual([0n, 0n]);
      expect(must(flush.rows[0]).inventory_value_base_minor, 'I = the whole valuation before').toBe(held.valuation.toString(10));
      expectAccepted(await atCommit(c));
      const three = await threeWay(c, A.businessId);
      expect([three.movements, three.cache]).toEqual([three.gl, three.gl]);
    });
  });
});

describe('T-06 the return from another warehouse (MP-3)', () => {
  it('after a transfer W1→W2 a W1 purchase returns from W2 at W2’s average, PPV against its carrying value, lines on W2 and the purchase branch', async () => {
    await inTx(async (c) => {
      const A = world.A;
      // W2 already holds pieces at another cost; the transfer brings the purchase's pieces at W1's cost.
      await stockUp(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '2', unitCost: '150' }]);
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      await runS3(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]));
      const w2 = { warehouseId: A.w2, variantId: A.piece.variantId };
      const w1 = { warehouseId: A.w1, variantId: A.piece.variantId };
      const [w2Before, w1Before] = [await stockState(c, A.businessId, w2), await stockState(c, A.businessId, w1)];
      const prep = await prepareReturn(c, A, p.purchaseId, { warehouseId: A.w2, lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '2' }] });
      expect(must(prep.plan.lines[0]).unitCostSnapshotC10, 'valued at W2’s average').toBe(must(w2Before.avg));
      await runReturn(c, A, prep);
      expectAccepted(await atCommit(c));
      const [w2After, w1After] = [await stockState(c, A.businessId, w2), await stockState(c, A.businessId, w1)];
      const h = must(await returnHeader(c, A.businessId, prep.cmd.returnId));
      expect(w2Before.valuation - w2After.valuation, 'W2 drops by I').toBe(BigInt(must(h.inventory)));
      expect(w1After, 'W1 is untouched').toEqual(w1Before);
      expect(must(h.warehouse_id)).toBe(A.w2);
      // PPV against the W1 purchase's carrying value: ap_base + credit_base − I.
      expect(BigInt(must(h.ppv))).toBe(BigInt(must(h.ap_base)) + BigInt(must(h.credit_base)) - BigInt(must(h.inventory)));
      expect(BigInt(must(h.ppv)), 'W2’s average differs from the purchase cost').not.toBe(0n);
      const entry = must(await entryBySource(c, A.businessId, 'supplier_return', prep.cmd.returnId));
      const shape = entryShape(entry.lines, prep.purchaseBranchId, A.w2, prep.returnBranchId);
      expect(prep.purchaseBranchId).toBe(A.branchX);
      expect(prep.returnBranchId).toBe(A.branchY);
      expect(
        shape.map((l) => [l.systemKey, l.dimension]),
        'AP on the purchase branch, Inventory and PPV on W2 and its branch',
      ).toEqual([
        ['accounts_payable', 'purchase'],
        ['inventory', 'return'],
        ['purchase_price_variance', 'return'],
      ]);
    });
  });

  it('an assertion signed over the W1 payload cannot be replayed for W2 → assertion_payload_mismatch', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      await runS3(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]));
      const lines = [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }];
      const fromW1 = await prepareReturn(c, A, p.purchaseId, { lines });
      const fromW2 = await prepareReturn(c, A, p.purchaseId, { warehouseId: A.w2, lines, returnId: fromW1.cmd.returnId });
      const w1Assertion = assertionFor(A, fromW1.cmd);
      const before = await s5Counts(c, A.businessId);
      refusedWith(await tryS5(c, A, fromW2.cmd, { assertion: w1Assertion }), 'P0001', 'inventory.assertion_payload_mismatch', 'W1’s signature on W2');
      expect(await s5Counts(c, A.businessId)).toEqual(before);
      expectAccepted(await tryS5(c, A, fromW1.cmd, { assertion: w1Assertion }), 'the signature on its own payload');
    });
  });
});
