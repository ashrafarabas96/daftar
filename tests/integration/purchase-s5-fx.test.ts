/**
 * P3-S5 T-14 — A FOREIGN PURCHASE RETURNED IN THREE PARTS
 * (docs/PHASE_3_S5_CONTRACT.md A-10(c)-(g), TL-3, §6 T-14; DM §7ج).
 *
 * `FOREIGN-DUST` (JOD, 3 dp, at 5.1 into ILS, 2 dp) returned in three
 * parts, every figure from the package vector:
 *   - each return's JOD AP line carries exactly the base amount the 0043
 *     conversion of its txn amount gives at the purchase's rate, and the
 *     cumulative-release dust goes to its own base-currency AP line
 *     (+1, −1, +1) — the entry is the vector's, line for line;
 *   - Σ ap_base over the three returns = B exactly, and the purchase's ledger
 *     AP is then 0 in txn and in base;
 *   - the snapshot rate is used although newer rates are in force at the
 *     return date (JOD 4.9 from the vector registry and a later 7.0): no
 *     lookup — the stored return's rate is the purchase's, and the amounts
 *     are the vector's.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertToBaseMinor } from '@daftar/accounting';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { atCommit, expectAccepted, must, ownerClient, seedS3World, today, type S3World } from '../helpers/inventory-commands';
import {
  entryBySource,
  entryShape,
  foreignRate,
  planAmounts,
  prepareReturn,
  purchaseLedgerAp,
  purchaseState,
  runReturn,
  storedAmounts,
  supplierReturnVector,
  vectorAmounts,
  vectorDocumentDate,
  vectorPurchase,
  vectorRates,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5fx');
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

/** The JOD rates in force at `day`, newest first. */
async function ratesInForce(c: Client, businessId: string, day: string): Promise<string[]> {
  const r = await c.query<{ rate: string }>(
    `SELECT rate::text AS rate FROM accounting_fx_rates
      WHERE business_id = $1 AND from_currency = 'JOD' AND effective_at <= ($2::date + 1)::timestamptz ORDER BY effective_at DESC`,
    [businessId, day],
  );
  return r.rows.map((x) => x.rate);
}

describe('T-14 FOREIGN-DUST: a JOD purchase returned in three parts', () => {
  it('each AP line converts at the purchase rate, the dust has its own line, Σ ap_base = B, the ledger AP ends at 0, and no newer rate is looked up', async () => {
    const A = world.A;
    const v = supplierReturnVector('FOREIGN-DUST');
    // A still newer rate, in force well before the returns are dated.
    await foreignRate(A, 'JOD', '7.0000000000', new Date(Math.floor(Date.now() / 1000 - 86_400) * 1000).toISOString());
    await inTx(async (c) => {
      const day = await today(c);
      const inForce = await ratesInForce(c, A.businessId, day);
      expect(inForce.slice(0, 2), 'at the return date the newest JOD rates are 7.0 and 4.9, not the snapshot').toEqual(['7.0000000000', '4.9000000000']);
      const p = await vectorPurchase(c, A, v, { documentDate: vectorDocumentDate(v) });
      const snapshot = (await purchaseState(c, A.businessId, p.purchaseId)).rate;
      expect(snapshot, 'the purchase snapshot is the vector rate').toBe(v.purchase.rate);
      let releasedBase = 0n;
      for (const [k, r] of v.returns.entries()) {
        const label = `return ${k + 1}`;
        const e = must(r.expect, label);
        expect((await purchaseState(c, A.businessId, p.purchaseId)).outstanding, `${label}: O`).toBe(r.outstanding.txnMinor);
        const prep = await prepareReturn(c, A, p.purchaseId, { lines: r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty })) });
        expect(planAmounts(prep.plan), `${label}: the plan is the vector`).toEqual(vectorAmounts(e));
        await runReturn(c, A, prep);
        expectAccepted(await atCommit(c), `${label}: every deferred guard at COMMIT`);
        expect(await storedAmounts(c, A.businessId, prep.cmd.returnId), `${label}: stored = vector`).toEqual(vectorAmounts(e));
        const stored = must(
          (
            await c.query<{ rate: string }>(`SELECT source_to_base_rate::text AS rate FROM supplier_returns WHERE business_id = $1 AND id = $2`, [
              A.businessId,
              prep.cmd.returnId,
            ])
          ).rows[0],
        );
        expect(stored.rate, `${label}: the stored rate is the snapshot, not a lookup`).toBe(v.purchase.rate);
        const entry = must(await entryBySource(c, A.businessId, 'supplier_return', prep.cmd.returnId), `${label}: the entry`);
        const shape = entryShape(entry.lines, prep.purchaseBranchId, p.warehouseId, prep.returnBranchId);
        expect(shape, `${label}: the A-10(g) entry, the dust line included`).toEqual(e.entry);
        for (const l of shape.filter((x) => x.currency === v.purchase.txnCurrency)) {
          // 0043: a foreign line's base amount is its txn amount converted at its own rate.
          expect(l.rate, `${label}: the JOD line carries the snapshot rate`).toBe(v.purchase.rate);
          expect(
            convertToBaseMinor({
              txnAmountMinor: BigInt(l.txnAmountMinor),
              txnCurrency: v.purchase.txnCurrency,
              baseCurrency: v.purchase.baseCurrency,
              fxRate: l.rate,
            }).toString(10),
            `${label}: base = convert(txn)`,
          ).toBe(l.baseAmountMinor);
        }
        const dust = shape.filter((x) => x.systemKey === 'accounts_payable' && x.currency === v.purchase.baseCurrency);
        expect(dust.length, `${label}: one base-currency dust line`).toBe(1);
        expect((must(dust[0]).side === 'D' ? 1n : -1n) * BigInt(must(dust[0]).baseAmountMinor), `${label}: the dust`).toBe(BigInt(e.apDustBaseMinor));
        releasedBase += BigInt(e.apBaseMinor);
      }
      expect(releasedBase.toString(10), 'Σ ap_base = B').toBe(v.purchase.totalBaseMinor);
      expect(releasedBase.toString(10), 'the vector totals agree').toBe(v.totals.apBaseMinor);
      expect(await purchaseLedgerAp(c, A.businessId, p.purchaseId), 'the purchase owes nothing after the full return').toEqual({ txn: 0n, base: 0n });
    });
  });
});
