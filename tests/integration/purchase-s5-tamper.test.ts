/**
 * P3-S5 T-15 — TAMPER AND THE GUARDS, ONE PER MECHANISM
 * (docs/PHASE_3_S5_CONTRACT.md A-11(e), A-15, §2.3, §2.4, §6 T-15; L:1550-1568).
 *
 * The OWNER — a superuser, past every grant and policy — forges exactly one
 * fact each time, and the guard of that fact refuses it:
 *   1. an UPDATE or DELETE on every S5 table and bridge, over real rows
 *      (`inventory.ledger_immutable`; the credit note
 *      `supplier_credit_note.immutable`), and the AL-31 decrement of a
 *      credit note in particular, which S5 does not admit;
 *   2. the generic Phase 2 reversal of a `purchase` entry with no paired
 *      `purchase_reversals` row, and of a `supplier_return` entry
 *      (`accounting.reversal_source_domain_owned`);
 *   3. a `purchase_reversals` row without its reversal entry: its deferred
 *      binding FK fails at COMMIT (23503 on `purchase_reversals_binding_fk`);
 *   4. under R-B1a, the primitive called directly under a consumed
 *      `purchase.reverse`: a caller-supplied value or unit cost
 *      (`inventory.movement_shape_invalid`), a line with no paired purchase
 *      movement (`inventory.reversal_pair_missing`), and a line that names
 *      its pair with another quantity (`inventory.reversal_pair_mismatch`).
 * An entry with an extra line (A-15(a)) is T-03's
 * (`purchase-s5-return-posting.test.ts`). Each case first shows the honest
 * state passes the same probe, and every refusal writes nothing.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  atCommit,
  attempt,
  expectAccepted,
  expectConstraint,
  must,
  ownerClient,
  refusedWith,
  seedS3World,
  today,
  type S3World,
} from '../helpers/inventory-commands';
import { domainReversalFingerprint, reverseInTx, stockUp } from '../helpers/inventory-posting';
import { requestsJson, requestsParam, type MovementRequest } from '../helpers/stock-ledger';
import { installSettlementFixture } from '../helpers/purchase-settlement-fixture';
import {
  S5_BRIDGES,
  S5_TABLES,
  creditNoteOf,
  prepareReturn,
  postReversalInTx,
  prepareReversal,
  receivedPurchase,
  runReturn,
  runReversal,
  s5Counts,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5tamper');
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

describe('T-15 1. every S5 table and bridge is append-only, for the owner too', () => {
  it('UPDATE and DELETE over real rows are refused on each; a credit-note decrement is supplier_credit_note.immutable', async () => {
    await inTx(async (c) => {
      const A = world.A;
      // A return with a credit note: the settlement fixture states O = 0, so the whole carrying value is a supplier credit.
      const fixture = await installSettlementFixture(c);
      const credited = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      await fixture.set(A.businessId, credited.purchaseId, { outstandingTxn: 0n });
      const ret = await prepareReturn(c, A, credited.purchaseId, { lines: [{ purchaseLineId: must(credited.lines[0]).lineId, qty: '1' }] });
      await runReturn(c, A, ret);
      expect(must(await creditNoteOf(c, A.businessId, ret.cmd.returnId), 'the credit note').remaining_txn).toBe(ret.cmd.creditTxnMinor.toString(10));
      // A reversal of another purchase.
      const reversed = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '70' }]);
      await runReversal(c, A, await prepareReversal(c, A, reversed.purchaseId));
      expectAccepted(await atCommit(c), 'the honest state passes the COMMIT probe');

      const before = await s5Counts(c, A.businessId);
      for (const t of [...S5_TABLES, ...S5_BRIDGES]) {
        const rows = must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [A.businessId])).rows[0]).n;
        expect(rows, `${t} holds rows the guard must judge`).toBeGreaterThan(0);
        const code = t === 'supplier_credit_notes' ? 'supplier_credit_note.immutable' : 'inventory.ledger_immutable';
        refusedWith(
          await attempt(c, () => c.query(`UPDATE ${t} SET business_id = business_id WHERE business_id = $1`, [A.businessId])),
          'P0001',
          code,
          `UPDATE ${t}`,
        );
        refusedWith(await attempt(c, () => c.query(`DELETE FROM ${t} WHERE business_id = $1`, [A.businessId])), 'P0001', code, `DELETE ${t}`);
      }
      // The AL-31 decrement is S6's, not S5's: both remaining values together, still refused.
      refusedWith(
        await attempt(c, () =>
          c.query(
            `UPDATE supplier_credit_notes SET remaining_amount_minor = remaining_amount_minor - 1,
                                              remaining_carrying_base_amount_minor = remaining_carrying_base_amount_minor - 1
              WHERE business_id = $1 AND supplier_return_id = $2`,
            [A.businessId, ret.cmd.returnId],
          ),
        ),
        'P0001',
        'supplier_credit_note.immutable',
        'the decrement',
      );
      expect(await s5Counts(c, A.businessId), 'nothing changed').toEqual(before);
      expect(must(await creditNoteOf(c, A.businessId, ret.cmd.returnId)).remaining_txn).toBe(ret.cmd.creditTxnMinor.toString(10));
      await fixture.restore();
    });
  });
});

describe('T-15 2. the generic reversal workflow refuses the domain-owned entries', () => {
  it('a purchase entry with no paired purchase_reversals row, and a supplier_return entry → reversal_source_domain_owned', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const day = await today(c);
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      const other = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '70' }]);
      const ret = await prepareReturn(c, A, other.purchaseId, { lines: [{ purchaseLineId: must(other.lines[0]).lineId, qty: '1' }] });
      const returned = must((await runReturn(c, A, ret)).entry, 'the return entry').entryId;
      expectAccepted(await atCommit(c), 'the honest state passes the COMMIT probe');
      const before = await s5Counts(c, A.businessId);
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, p.entryId, day, domainReversalFingerprint(p.run.postings.purchase, p.entryId, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'a purchase entry, no purchase_reversals row',
      );
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, returned, day, domainReversalFingerprint(ret.posting, returned, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'a supplier_return entry',
      );
      expect(await s5Counts(c, A.businessId), 'nothing written').toEqual(before);
      // The same purchase entry through purchase_reverse and its Phase 2 reversal is admitted (R-B2a).
      expectAccepted(await attempt(c, async () => runReversal(c, A, await prepareReversal(c, A, p.purchaseId))), 'the domain route');
      expectAccepted(await atCommit(c));
    });
  });
});

describe('T-15 3. a purchase reversal needs its reversal entry', () => {
  it('a purchase_reversals row whose Phase 2 reversal is never posted fails COMMIT on its deferred binding FK; posted, it commits', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      const prep = await prepareReversal(c, A, p.purchaseId);
      await runReversal(c, A, prep, { posting: false });
      // 23503 on every server version: a deferred FK.
      expectConstraint(await atCommit(c), '23503', 'purchase_reversals_binding_fk', 'a reversal with no entry cannot commit');
      // Its Phase 2 reversal, posted after the routine in the same transaction, completes it.
      await postReversalInTx(c, A, prep);
      expectAccepted(await atCommit(c), 'with its entry');
    });
  });
});

describe('T-15 4. the R-B1a primitive branch, called directly under a consumed purchase.reverse', () => {
  async function primitive(c: Client, r: MovementRequest) {
    return attempt(c, async () =>
      (
        await c.query<{ value_delta_base_minor: string }>(`SELECT value_delta_base_minor::text FROM inventory_apply_stock_movements(${requestsParam(1)})`, [
          requestsJson([r]),
        ])
      ).rows.map((x) => x.value_delta_base_minor),
    );
  }

  it('a caller-supplied value or unit cost → movement_shape_invalid; no pair → reversal_pair_missing; another quantity → reversal_pair_mismatch', async () => {
    await inTx(async (c) => {
      const A = world.A;
      // A key with stock beyond the purchase, so no refusal is the stock bound's.
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const target = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '100' }]);
      const line = must(target.lines[0]);
      // Consume a purchase.reverse assertion in this transaction: an honest reversal of another purchase, not yet posted.
      const other = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '1', unitPriceMinor: '70' }]);
      await runReversal(c, A, await prepareReversal(c, A, other.purchaseId), { posting: false });
      const honest: MovementRequest = {
        warehouseId: A.w1,
        variantId: line.variantId,
        kind: 'purchase_reversal',
        sourceType: 'purchase_reversal',
        sourceId: target.purchaseId,
        sourceLineId: line.lineId,
        qty: '-2',
        unitCost: null,
        value: null,
        reason: null,
      };
      const before = await s5Counts(c, A.businessId);
      refusedWith(await primitive(c, { ...honest, value: '-200' }), 'P0001', 'inventory.movement_shape_invalid', 'a caller-supplied value');
      refusedWith(await primitive(c, { ...honest, unitCost: '100' }), 'P0001', 'inventory.movement_shape_invalid', 'a caller-supplied unit cost');
      refusedWith(
        await primitive(c, { ...honest, sourceId: randomUUID(), sourceLineId: randomUUID() }),
        'P0001',
        'inventory.reversal_pair_missing',
        'a line with no purchase movement',
      );
      refusedWith(await primitive(c, { ...honest, qty: '-1' }), 'P0001', 'inventory.reversal_pair_mismatch', 'the pair with another quantity');
      expect(await s5Counts(c, A.businessId), 'nothing written').toEqual(before);
      // The honest request is valued by the branch at exactly −s_i, not the key average.
      expect(expectAccepted(await primitive(c, honest), 'the honest request')).toEqual(['-200']);
    });
  });
});
