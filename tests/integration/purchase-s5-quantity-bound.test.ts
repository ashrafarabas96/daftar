/**
 * P3-S5 T-04 — THE CUMULATIVE QUANTITY BOUND (PM-13)
 * (docs/PHASE_3_S5_CONTRACT.md A-10(a), A-12, §2.3, §6 T-04; MP-1).
 *
 *   T-04.1 sequential partial returns up to `qty_i` succeed and the crossing
 *          one is refused `supplier_return.quantity_exceeds_purchased` — by the
 *          package plan AND by the routine on its own — writing nothing;
 *   T-04.2 two concurrent returns that jointly cross it, on two real
 *          connections, the second provably waiting: exactly one commits;
 *   T-04.3 `CUMULATIVE-THIRDS` end to end: Σ carrying = t_i exactly;
 *   T-04.4 an owner-inserted line crossing the bound fails at COMMIT by the
 *          deferred `supplier_return_lines_quantity_bound` guard.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  atCommit,
  attempt,
  expectAccepted,
  must,
  ownerClient,
  pidOf,
  refusedWith,
  seedS3World,
  today,
  waitUntilBlocked,
  type S3World,
} from '../helpers/inventory-commands';
import {
  preparationRefusal,
  prepareReturn,
  receivedPurchase,
  returnGoods,
  runReturn,
  s5Counts,
  supplierReturnVector,
  tryS5,
  vectorPurchase,
  zeroReturn,
  type ReceivedPurchase,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5qty');
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

async function committed<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const v = await fn(c);
    await c.query('COMMIT');
    return v;
  } finally {
    await c.end();
  }
}

async function returnedOf(q: { query: Client['query'] }, businessId: string, purchaseLineId: string): Promise<string> {
  return must(
    (
      await q.query<{ q: string }>(`SELECT coalesce(sum(qty), 0)::text AS q FROM supplier_return_lines WHERE business_id = $1 AND purchase_line_id = $2`, [
        businessId,
        purchaseLineId,
      ])
    ).rows[0],
  ).q;
}

describe('T-04.1 sequential partial returns up to the purchased quantity', () => {
  it('a whole line: 1 + 1 + 1 of 3 succeed; a fourth unit is refused by the plan and by the routine, writing nothing', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '3', unitPriceMinor: '100' }]);
      const line = must(p.lines[0]);
      for (let k = 1; k <= 3; k++) {
        await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: line.lineId, qty: '1' }] });
        expect(await returnedOf(c, A.businessId, line.lineId)).toBe(`${k}.0000`);
      }
      expectAccepted(await atCommit(c), 'three returns within the bound');
      expect(await preparationRefusal(prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: line.lineId, qty: '1' }] }))).toBe(
        'supplier_return.quantity_exceeds_purchased',
      );
      const before = await s5Counts(c, A.businessId);
      const crossing = zeroReturn(p.purchaseId, p.warehouseId, await today(c), [{ purchaseLineId: line.lineId, variantId: line.variantId, qty: '1' }]);
      refusedWith(await tryS5(c, A, crossing, { raw: true }), 'P0001', 'supplier_return.quantity_exceeds_purchased', 'the routine on its own');
      expect(await s5Counts(c, A.businessId), 'nothing written').toEqual(before);
    });
  });

  it('a fractional line: 1.25 + 1.25 of 2.5 succeed; 0.01 more is refused; the other line is still returnable', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [
        { variantId: A.dec2.variantId, qty: '2.5', unitPriceMinor: '80' },
        { variantId: A.piece.variantId, qty: '2', unitPriceMinor: '100' },
      ]);
      const [frac, whole] = [must(p.lines[0]), must(p.lines[1])];
      await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: frac.lineId, qty: '1.25' }] });
      await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: frac.lineId, qty: '1.25' }] });
      expect(await returnedOf(c, A.businessId, frac.lineId)).toBe('2.5000');
      const before = await s5Counts(c, A.businessId);
      refusedWith(
        await tryS5(c, A, zeroReturn(p.purchaseId, p.warehouseId, await today(c), [{ purchaseLineId: frac.lineId, variantId: frac.variantId, qty: '0.01' }]), {
          raw: true,
        }),
        'P0001',
        'supplier_return.quantity_exceeds_purchased',
        '0.01 beyond 2.5',
      );
      // Two lines where only one crosses: the whole return is refused.
      refusedWith(
        await tryS5(
          c,
          A,
          zeroReturn(p.purchaseId, p.warehouseId, await today(c), [
            { purchaseLineId: whole.lineId, variantId: whole.variantId, qty: '1' },
            { purchaseLineId: frac.lineId, variantId: frac.variantId, qty: '0.01' },
          ]),
          { raw: true },
        ),
        'P0001',
        'supplier_return.quantity_exceeds_purchased',
        'one crossing line of two',
      );
      expect(await s5Counts(c, A.businessId)).toEqual(before);
      await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: whole.lineId, qty: '2' }] });
      expectAccepted(await atCommit(c));
    });
  });
});

describe('T-04.2 two concurrent returns that jointly cross the bound', () => {
  it('the second waits on the purchase row, then is refused quantity_exceeds_purchased: exactly one committed', async () => {
    const A = world.A;
    // Committed on W2, so the rolled-back cases on W1 keep starting from empty keys.
    const p: ReceivedPurchase = await committed((c) =>
      receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '3', unitPriceMinor: '100' }], { warehouseId: A.w2 }),
    );
    const line = must(p.lines[0]);
    // Both prepared against the same state: 0 returned, 2 each.
    const r1 = await prepareReturn(ownerPool(), A, p.purchaseId, { lines: [{ purchaseLineId: line.lineId, qty: '2' }] });
    const r2 = await prepareReturn(ownerPool(), A, p.purchaseId, { lines: [{ purchaseLineId: line.lineId, qty: '2' }] });
    const c1 = await ownerClient();
    const c2 = await ownerClient();
    try {
      const pid2 = await pidOf(c2);
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await runReturn(c1, A, r1);
      const loser = attempt(c2, () => runReturn(c2, A, r2));
      await waitUntilBlocked(pid2, 'the second return of the purchase');
      await c1.query('COMMIT');
      refusedWith(await loser, 'P0001', 'supplier_return.quantity_exceeds_purchased', 'the loser, after the winner committed');
      await c2.query('ROLLBACK');
    } finally {
      await c1.end();
      await c2.end();
    }
    const stored = await ownerPool().query<{ id: string }>(`SELECT id::text FROM supplier_returns WHERE business_id = $1 AND purchase_id = $2`, [
      A.businessId,
      p.purchaseId,
    ]);
    expect(
      stored.rows.map((r) => r.id),
      'exactly the winner',
    ).toEqual([r1.cmd.returnId]);
    expect(await returnedOf(ownerPool(), A.businessId, line.lineId)).toBe('2.0000');
  });
});

describe('T-04.3 CUMULATIVE-THIRDS end to end', () => {
  it('three returns of one third each carry 33, 34, 33 — Σ carrying = t_i = 100 — and a fourth is refused', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const v = supplierReturnVector('CUMULATIVE-THIRDS');
      const p = await vectorPurchase(c, A, v);
      const t = BigInt(must(v.purchase.lines[0]).lineTotalTxnMinor);
      let sum = 0n;
      for (const r of v.returns) {
        const lines = r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty }));
        if (r.outcome !== 'accepted') {
          expect(await preparationRefusal(prepareReturn(c, A, p.purchaseId, { lines }))).toBe(r.outcome);
          continue;
        }
        const { prepared } = await returnGoods(c, A, p.purchaseId, { lines });
        expect(prepared.cmd.carryingTxnMinor.toString(10)).toBe(must(r.expect).carryingTxnMinor);
        sum += prepared.cmd.carryingTxnMinor;
      }
      expect(sum, 'Σ carrying over the returns = t_i exactly').toBe(t);
      expectAccepted(await atCommit(c));
    });
  });
});

describe('T-04.4 the deferred quantity bound at COMMIT', () => {
  /** A received two-line purchase, line 1 fully returned and a second return open in this transaction. */
  async function tamperable(c: Client): Promise<{ p: ReceivedPurchase; openReturnId: string }> {
    const A = world.A;
    const p = await receivedPurchase(c, A, [
      { variantId: A.piece.variantId, qty: '3', unitPriceMinor: '100' },
      { variantId: A.piece2.variantId, qty: '3', unitPriceMinor: '100' },
    ]);
    await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '3' }] });
    const { prepared } = await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[1]).lineId, qty: '1' }] });
    expectAccepted(await atCommit(c), 'the honest state holds');
    // Flush the honest deferred events so the table can be altered in this transaction.
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    return { p, openReturnId: prepared.cmd.returnId };
  }

  /** The owner adds a zero-value line on purchase line 1 to the open return. */
  async function tamper(c: Client, p: ReceivedPurchase, returnId: string, qty: string): Promise<void> {
    const A = world.A;
    const l1 = must(p.lines[0]);
    await c.query(
      `INSERT INTO supplier_return_lines (tenant_id, business_id, return_id, id, line_no, purchase_id, purchase_line_id, variant_id, qty,
                                         carrying_txn_minor, unit_cost_base_minor, value_out_base_minor)
       VALUES ($1, $2, $3, gen_random_uuid(), 2, $4, $5, $6, $7::numeric, 0, 0, 0)`,
      [A.tenantId, A.businessId, returnId, p.purchaseId, l1.lineId, l1.variantId, qty],
    );
  }

  it('an owner insert crossing the bound fails at COMMIT (first by the line-completeness guard, which it also breaks)', async () => {
    await inTx(async (c) => {
      const { p, openReturnId } = await tamperable(c);
      await tamper(c, p, openReturnId, '1');
      refusedWith(await atCommit(c), 'P0001', 'inventory.source_movement_set_incomplete', 'a line with no movement');
    });
  });

  it('with only the bound left to judge it, the crossing insert fails at COMMIT: supplier_return.quantity_exceeds_purchased', async () => {
    await inTx(async (c) => {
      const { p, openReturnId } = await tamperable(c);
      // Take the line-completeness guard out of this rolled-back transaction, so the bound alone decides.
      await c.query('ALTER TABLE supplier_return_lines DISABLE TRIGGER stock_source_complete_supplier_return');
      await tamper(c, p, openReturnId, '1');
      refusedWith(await atCommit(c), 'P0001', 'supplier_return.quantity_exceeds_purchased', 'Σ returned 4 of 3');
    });
  });

  it('the same insert without the bound is accepted at COMMIT — the bound is what refused it', async () => {
    await inTx(async (c) => {
      const { p, openReturnId } = await tamperable(c);
      await c.query('ALTER TABLE supplier_return_lines DISABLE TRIGGER stock_source_complete_supplier_return');
      await c.query('ALTER TABLE supplier_return_lines DISABLE TRIGGER supplier_return_lines_quantity_bound');
      await tamper(c, p, openReturnId, '1');
      expectAccepted(await atCommit(c), 'no bound, no refusal');
    });
  });
});
