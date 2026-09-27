/**
 * P3-S5 T-07 — AP FIRST, THEN 1150; SQL/TS PARITY ON EVERY VECTOR
 * (docs/PHASE_3_S5_CONTRACT.md A-10, A-11, A-16, §6 T-07; MP-4, L:930-936).
 *
 * Every `supplier-return-vectors` case is received through the real S4
 * routines and returned through the real `purchase_return` + the app's entry
 * builder, in a rolled-back transaction. For each return, the package plan
 * (the TS side), the vector and the rows the routine stored (the SQL side)
 * agree on every amount; the posted entry is the vector's A-10(g) entry line
 * for line; the key's stock after is the vector's. A refusal case is refused
 * with its own code on BOTH sides and writes nothing.
 *
 * `AP-FIRST-EXCESS` and `AP-EXHAUSTED` state the outstanding AP through the
 * settlement fixture (§5, TL-9): AP is debited by exactly `O` (txn) and its
 * cumulative base share, the rest is `Dr supplier_receivable` with a credit
 * note whose original = remaining in both pairs, the purchase's ledger AP net
 * of what the fixture says is allocated is exactly 0 (never negative), and no
 * revenue, 6100 or tax account is touched.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { atCommit, expectAccepted, must, ownerClient, refusedWith, seedS3World, today, type S3World } from '../helpers/inventory-commands';
import {
  RETURN_ACCOUNTS,
  creditNoteOf,
  entryBySource,
  entryShape,
  planAmounts,
  preparationRefusal,
  prepareReturn,
  purchaseLedgerAp,
  purchaseState,
  runReturn,
  s5Counts,
  storedAmounts,
  supplierReturnVector,
  supplierReturnVectors,
  tryS5,
  vectorAmounts,
  vectorDocumentDate,
  vectorPurchase,
  vectorRates,
  vectorStockOf,
  zeroReturn,
  type SupplierReturnVector,
} from '../helpers/purchase-returns';
import { installSettlementFixture, type SettlementFixture } from '../helpers/purchase-settlement-fixture';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5apf');
  await vectorRates(world.A);
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

/** Receive the vector's purchase and run each of its returns in order, checking every one against the vector. */
async function playVector(c: Client, v: SupplierReturnVector, fixture: SettlementFixture | null): Promise<string> {
  const A = world.A;
  const p = await vectorPurchase(c, A, v, { documentDate: vectorDocumentDate(v) });
  for (const [k, r] of v.returns.entries()) {
    const label = `${v.id} return ${k + 1}`;
    if (r.outstanding.source === 'fixture') {
      await must(fixture, `${label}: the fixture`).set(A.businessId, p.purchaseId, { outstandingTxn: BigInt(r.outstanding.txnMinor) });
    }
    expect((await purchaseState(c, A.businessId, p.purchaseId)).outstanding, `${label}: purchase_ap_outstanding`).toBe(r.outstanding.txnMinor);
    const lines = r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty }));

    if (r.outcome !== 'accepted') {
      expect(await preparationRefusal(prepareReturn(c, A, p.purchaseId, { lines })), `${label}: the TS plan refuses`).toBe(r.outcome);
      const before = await s5Counts(c, A.businessId);
      const claimed = zeroReturn(
        p.purchaseId,
        p.warehouseId,
        await today(c),
        r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), variantId: p.variantOf(l.lineNo), qty: l.qty })),
      );
      refusedWith(await tryS5(c, A, claimed, { raw: true }), 'P0001', r.outcome, `${label}: the routine refuses on its own`);
      expect(await s5Counts(c, A.businessId), `${label}: the refusal wrote nothing`).toEqual(before);
      continue;
    }

    const e = must(r.expect, `${label}: expect`);
    const prep = await prepareReturn(c, A, p.purchaseId, { lines });
    expect(planAmounts(prep.plan), `${label}: the TS plan is the vector`).toEqual(vectorAmounts(e));
    expect(prep.plan.apConvertedMinor.toString(10), `${label}: convert(ap_txn)`).toBe(e.apConvertedMinor);
    const run = await runReturn(c, A, prep);
    expectAccepted(await atCommit(c), `${label}: every deferred guard holds at COMMIT`);
    expect(must(run.entry).created).toBe(true);
    expect(await storedAmounts(c, A.businessId, prep.cmd.returnId), `${label}: the stored return is the vector (SQL parity)`).toEqual(vectorAmounts(e));
    const entry = must(await entryBySource(c, A.businessId, 'supplier_return', prep.cmd.returnId), `${label}: the entry`);
    expect(entryShape(entry.lines, prep.purchaseBranchId, p.warehouseId, prep.returnBranchId), `${label}: the A-10(g) entry`).toEqual(e.entry);
    for (const l of entry.lines) expect(RETURN_ACCOUNTS as readonly (string | null)[], `${label}: no 6100, revenue or tax`).toContain(l.system_key);
    for (const l of e.lines) {
      expect(await vectorStockOf(c, A.businessId, p.warehouseId, p.variantOf(l.lineNo)), `${label}: line ${l.lineNo} stock after`).toEqual(l.stockAfter);
    }
    const note = await creditNoteOf(c, A.businessId, prep.cmd.returnId);
    if (e.creditNote) {
      expect(note, `${label}: the credit note, original = remaining in both pairs`).toMatchObject({
        id: prep.cmd.creditNoteId,
        supplier_id: p.supplierId,
        currency_code: v.purchase.txnCurrency,
        original_txn: e.creditTxnMinor,
        remaining_txn: e.creditTxnMinor,
        original_base: e.creditBaseMinor,
        remaining_base: e.creditBaseMinor,
        rate: v.purchase.rate,
      });
    } else {
      expect(note, `${label}: no credit note without a credit`).toBeNull();
    }
  }
  return p.purchaseId;
}

describe.sequential('T-07 every supplier-return vector: TS plan = vector = stored rows = posted entry', () => {
  for (const v of supplierReturnVectors()) {
    it(`${v.id}: ${v.why}`, async () => {
      await inTx(async (c) => {
        const needsFixture = v.returns.some((r) => r.outstanding.source === 'fixture');
        const fixture = needsFixture ? await installSettlementFixture(c) : null;
        const purchaseId = await playVector(c, v, fixture);
        // The totals over every accepted return are the vector's.
        const t = must(
          (
            await c.query<{ ap_txn: string; ap_base: string; credit_txn: string; credit_base: string }>(
              `SELECT coalesce(sum(ap_txn_minor), 0)::text AS ap_txn, coalesce(sum(ap_base_minor), 0)::text AS ap_base,
                      coalesce(sum(credit_txn_minor), 0)::text AS credit_txn, coalesce(sum(credit_base_minor), 0)::text AS credit_base
                 FROM supplier_returns WHERE business_id = $1 AND purchase_id = $2`,
              [world.A.businessId, purchaseId],
            )
          ).rows[0],
        );
        expect({ apTxnMinor: t.ap_txn, apBaseMinor: t.ap_base, creditTxnMinor: t.credit_txn, creditBaseMinor: t.credit_base }, `${v.id}: totals`).toEqual(
          v.totals,
        );
        if (fixture !== null) await fixture.restore();
      });
    });
  }
});

describe.sequential('T-07 AP first: the fixture states O < C', () => {
  it('AP-FIRST-EXCESS: AP takes exactly O, the rest is 1150 with a credit note; the ledger AP net of the allocations is exactly 0', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const v = supplierReturnVector('AP-FIRST-EXCESS');
      const fixture = await installSettlementFixture(c);
      const purchaseId = await playVector(c, v, fixture);
      const r = must(v.returns[0]);
      const e = must(r.expect);
      const outstanding = BigInt(r.outstanding.txnMinor);
      const total = { txn: BigInt(v.purchase.totalTxnMinor), base: BigInt(v.purchase.totalBaseMinor) };
      // The ledger AP of the purchase: its entry less the return's AP line(s).
      const ledger = await purchaseLedgerAp(c, A.businessId, purchaseId);
      expect(ledger, 'the purchase ledger AP after the return').toEqual({
        txn: total.txn - BigInt(e.apTxnMinor),
        base: total.base - BigInt(e.apBaseMinor),
      });
      // What the fixture says S6 allocated is T − O; net of it the purchase owes exactly nothing.
      expect(ledger.txn - (total.txn - outstanding), 'AP net of the allocations, txn').toBe(0n);
      expect(BigInt(e.apTxnMinor), 'AP was debited by exactly O').toBe(outstanding);
      expect((await purchaseState(c, A.businessId, purchaseId)).outstanding, 'nothing is outstanding afterwards, never negative').toBe('0');
      // 1150 carries exactly the credit.
      const entry = must(
        await entryBySource(
          c,
          A.businessId,
          'supplier_return',
          must((await c.query<{ id: string }>(`SELECT id::text FROM supplier_returns WHERE purchase_id = $1`, [purchaseId])).rows[0]).id,
        ),
      );
      const receivable = entry.lines.filter((l) => l.system_key === 'supplier_receivable');
      expect(
        receivable.map((l) => ({ debit: l.debit, txn: l.txn_amount })),
        'Dr supplier_receivable credit_base',
      ).toEqual([{ debit: e.creditBaseMinor, txn: e.creditTxnMinor }]);
      await fixture.restore();
    });
  });

  it('AP-EXHAUSTED: O = 0 posts no AP line; the whole carrying value is a supplier credit', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const v = supplierReturnVector('AP-EXHAUSTED');
      const fixture = await installSettlementFixture(c);
      const purchaseId = await playVector(c, v, fixture);
      const id = must((await c.query<{ id: string }>(`SELECT id::text FROM supplier_returns WHERE purchase_id = $1`, [purchaseId])).rows[0]).id;
      const entry = must(await entryBySource(c, A.businessId, 'supplier_return', id));
      expect(
        entry.lines.filter((l) => l.system_key === 'accounts_payable'),
        'no AP line',
      ).toEqual([]);
      const ledger = await purchaseLedgerAp(c, A.businessId, purchaseId);
      expect(ledger, 'the purchase ledger AP is untouched by the return').toEqual({
        txn: BigInt(v.purchase.totalTxnMinor),
        base: BigInt(v.purchase.totalBaseMinor),
      });
      await fixture.restore();
    });
  });

  it('without the fixture the same purchase returns against its derived AP: no credit note, AP only', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const v = supplierReturnVector('AP-EXHAUSTED');
      const p = await vectorPurchase(c, A, v, { documentDate: vectorDocumentDate(v) });
      const r = must(v.returns[0]);
      const prep = await prepareReturn(c, A, p.purchaseId, { lines: r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty })) });
      expect(prep.plan.creditNote, 'the derived O = T covers the whole carrying value').toBe(false);
      expect(prep.plan.apTxnMinor).toBe(prep.plan.carryingTxnMinor);
      await runReturn(c, A, prep);
      expect(await creditNoteOf(c, A.businessId, prep.cmd.returnId)).toBeNull();
    });
  });
});
