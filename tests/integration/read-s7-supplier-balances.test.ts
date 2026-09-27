/**
 * P3-S7 T-05 — SUPPLIER BALANCES ARE THE LEDGER, LIFTED TO THE LIST
 * (docs PHASE_3_S7_CONTRACT A-09(a), §6 T-05; Annex R #2, #3; AL-26).
 *
 * Through the real application, for every supplier of the page and every
 * currency:
 *   - `owed` = `GET /v1/suppliers/:id/payable` `byCurrency` (non-zero) =
 *     Σ `purchase_ap_outstanding` over its received purchases (the S6 T-19
 *     equality, lifted to the list);
 *   - `inYourFavour` = Σ `supplier_credit_notes.remaining_amount_minor` per
 *     note currency;
 *   - business-wide only: the assigned manager is refused;
 *   - the `payableSql` refactor returns the SAME ROWS as the frozen S6
 *     `S5_PAYABLE_SQL` text for all three call sites (supplier payable,
 *     purchase payable, purchase settlement), for every supplier and every
 *     purchase;
 *   - keyset paging (never OFFSET) walks every supplier once; `owedOnly`
 *     keeps exactly the suppliers with something outstanding; `search`
 *     matches a name substring.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must } from '../helpers/inventory-commands';
import { expectRefusal } from '../helpers/supplier-settlement';
import { httpPayPart, namedSupplier, ok, readAs, receive, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';
import { PurchasingReadService } from '../../apps/api/src/modules/purchasing/purchasing-reads';
import { payableSql } from '../../apps/api/src/modules/purchasing/supplier-balance-reads';
import { TenancyService } from '../../apps/api/src/modules/tenancy/tenancy.service';

/** The S6 payable text as frozen at the S6 acceptance (`purchasing-reads.ts:840-885` at 59ddc5b), verbatim. */
const FROZEN_S6_PAYABLE_SQL = `WITH ap AS (
         SELECT p.currency_code::text AS currency_code, jl.txn_currency, jl.credit_minor, jl.debit_minor, jl.txn_amount_minor
           FROM purchases p
           JOIN accounting_source_bindings pb ON pb.business_id = p.business_id AND pb.source_type = 'purchase' AND pb.source_id = p.id
           JOIN LATERAL (
                  SELECT pb.journal_entry_id
                  UNION ALL
                  SELECT rb.journal_entry_id
                    FROM supplier_returns r
                    JOIN accounting_source_bindings rb
                      ON rb.business_id = r.business_id AND rb.source_type = 'supplier_return' AND rb.source_id = r.id
                   WHERE r.business_id = p.business_id AND r.purchase_id = p.id
                  UNION ALL
                  SELECT ar.journal_entry_id
                    FROM accounting_reversals ar
                   WHERE ar.business_id = p.business_id AND ar.original_entry_id = pb.journal_entry_id
                  UNION ALL
                  SELECT ab.journal_entry_id
                    FROM supplier_payment_allocations a
                    JOIN accounting_source_bindings ab
                      ON ab.business_id = a.business_id AND ab.source_type = 'supplier_payment' AND ab.source_id = a.id
                   WHERE a.business_id = p.business_id AND a.purchase_id = p.id
                  UNION ALL
                  SELECT cb.journal_entry_id
                    FROM supplier_credit_allocations c
                    JOIN accounting_source_bindings cb
                      ON cb.business_id = c.business_id AND cb.source_type = 'supplier_credit_allocation' AND cb.source_id = c.id
                   WHERE c.business_id = p.business_id AND c.purchase_id = p.id
                ) e ON true
           JOIN journal_lines jl ON jl.business_id = p.business_id AND jl.journal_entry_id = e.journal_entry_id
           JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id AND a.system_key = 'accounts_payable'
          WHERE p.business_id = $1 AND p.status = 'received' AND %FILTER%)
     SELECT currency_code, sum(credit_minor - debit_minor)::text AS base_minor,
            coalesce(sum(CASE WHEN txn_currency = currency_code
                              THEN CASE WHEN credit_minor > 0 THEN txn_amount_minor ELSE -txn_amount_minor END END), 0)::text AS txn_minor
       FROM ap
      GROUP BY currency_code
      ORDER BY currency_code`;

interface Amount {
  currency: string;
  amountMinor: string;
}
interface BalanceRow {
  supplierId: string;
  name: string;
  status: string;
  owed: Amount[];
  inYourFavour: Amount[];
}
interface BalancePage {
  items: BalanceRow[];
  nextCursor: string | null;
}

let t: TestApp;
let w: ReadsWorld;
let settledSupplier: string;
let emptySupplier: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'bal');
  settledSupplier = await namedSupplier(t, w.owner, w.A, 'Settled trader');
  const settled = await receive(
    { ...w, supplierId: settledSupplier },
    { warehouseId: w.A.w1, lines: [{ productId: w.A.piece.productId, quantity: '2', unitPrice: '4.00' }] },
  );
  await httpPayPart(t, w.owner, w.A, w.method, settled, '800');
  emptySupplier = await namedSupplier(t, w.owner, w.A, 'Empty trader');
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const balances = (query = '', by = w.owner): Promise<BalancePage> => ok<BalancePage>(readAs(t, by, w.A.businessId, `/v1/supplier-balances?${query}`));

async function allBalances(limit: number, extra = ''): Promise<BalanceRow[]> {
  const out: BalanceRow[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i += 1) {
    const page: BalancePage = await balances(`limit=${limit}${extra}${cursor === null ? '' : `&cursor=${cursor}`}`);
    out.push(...page.items);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

/** Σ purchase_ap_outstanding per currency over the supplier's received purchases, non-zero. */
async function outstandingBySupplier(supplierId: string): Promise<Amount[]> {
  const r = await ownerPool().query<{ currency: string; o: string }>(
    `SELECT p.currency_code AS currency, sum(purchase_ap_outstanding(p.business_id, p.id))::text AS o
       FROM purchases p WHERE p.business_id = $1 AND p.supplier_id = $2 AND p.status = 'received'
      GROUP BY p.currency_code HAVING sum(purchase_ap_outstanding(p.business_id, p.id)) <> 0 ORDER BY p.currency_code`,
    [w.A.businessId, supplierId],
  );
  return r.rows.map((x) => ({ currency: x.currency, amountMinor: x.o }));
}

describe('T-05 the supplier-balance list', () => {
  it('owed = the supplier payable = Σ purchase_ap_outstanding; inYourFavour = Σ remaining; per currency', async () => {
    const rows = await allBalances(50);
    expect(rows.map((r) => r.supplierId).sort()).toEqual([w.supplierId, settledSupplier, emptySupplier].sort());
    for (const row of rows) {
      const payable = await ok<{ byCurrency: { currency: string; txnMinor: string }[] }>(
        readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${row.supplierId}/payable`),
      );
      expect(row.owed, `${row.name}: owed = GET …/payable`).toEqual(
        payable.byCurrency.filter((c) => c.txnMinor !== '0').map((c) => ({ currency: c.currency, amountMinor: c.txnMinor })),
      );
      expect(row.owed, `${row.name}: owed = Σ purchase_ap_outstanding`).toEqual(await outstandingBySupplier(row.supplierId));
      const favour = await ownerPool().query<{ currency: string; r: string }>(
        `SELECT currency_code AS currency, sum(remaining_amount_minor)::text AS r FROM supplier_credit_notes
          WHERE business_id = $1 AND supplier_id = $2 GROUP BY currency_code HAVING sum(remaining_amount_minor) <> 0 ORDER BY currency_code`,
        [w.A.businessId, row.supplierId],
      );
      expect(row.inYourFavour, `${row.name}: in your favour = Σ remaining`).toEqual(favour.rows.map((x) => ({ currency: x.currency, amountMinor: x.r })));
    }
    const main = must(rows.find((r) => r.supplierId === w.supplierId));
    expect(
      main.owed.map((a) => a.currency),
      'both purchase currencies',
    ).toEqual(['ILS', 'USD']);
    expect(main.inYourFavour.length, 'the credit note has remaining value').toBe(1);
    expect(must(rows.find((r) => r.supplierId === settledSupplier)).owed, 'a settled supplier owes nothing').toEqual([]);
    expect(must(rows.find((r) => r.supplierId === emptySupplier))).toMatchObject({ owed: [], inYourFavour: [] });
  });

  it('owedOnly keeps exactly the suppliers with something outstanding; search matches a name substring', async () => {
    expect((await allBalances(50, '&owedOnly=true')).map((r) => r.supplierId)).toEqual([w.supplierId]);
    expect((await balances('search=trader')).items.map((r) => r.supplierId).sort()).toEqual([settledSupplier, emptySupplier].sort());
    expect((await balances('search=_')).items, 'an underscore is a literal').toEqual([]);
  });

  it('keyset paging walks every supplier once, newest first; the module never OFFSETs', async () => {
    const all = (await balances('limit=50')).items.map((r) => r.supplierId);
    expect((await allBalances(1)).map((r) => r.supplierId)).toEqual(all);
    const order = await ownerPool().query<{ id: string }>('SELECT id::text FROM suppliers WHERE business_id = $1 ORDER BY created_at DESC, id DESC', [
      w.A.businessId,
    ]);
    expect(all).toEqual(order.rows.map((r) => r.id));
    const src = readFileSync(join(__dirname, '../../apps/api/src/modules/purchasing/supplier-balance-reads.ts'), 'utf8');
    expect(/\bOFFSET\s+[$\d]/i.test(src)).toBe(false);
  });

  it('business-wide only: the assigned manager is refused; another business reads its own suppliers only', async () => {
    const refused = await readAs(t, w.manager, w.A.businessId, '/v1/supplier-balances');
    expectRefusal(refused, 403, 'inventory.business_wide_scope_required');
    const other = await ok<BalancePage>(readAs(t, w.owner, w.A2.businessId, '/v1/supplier-balances?limit=50'));
    expect(other.items, 'A2 (same owner) has no supplier of A').toEqual([]);
  });

  it('payableSql returns the frozen S6 rows for all three call sites: every supplier, every purchase', async () => {
    const pool = ownerPool();
    const suppliers = await pool.query<{ id: string }>('SELECT id::text FROM suppliers WHERE business_id = $1', [w.A.businessId]);
    const purchases = await pool.query<{ id: string }>('SELECT id::text FROM purchases WHERE business_id = $1', [w.A.businessId]);
    expect(purchases.rows.length).toBeGreaterThan(5);
    const bySupplier = payableSql({ groupBy: 'currency', filter: 'p.supplier_id = $2' });
    const byPurchase = payableSql({ groupBy: 'currency', filter: 'p.id = $2' });
    for (const s of suppliers.rows) {
      const frozen = await pool.query(FROZEN_S6_PAYABLE_SQL.replace('%FILTER%', 'p.supplier_id = $2'), [w.A.businessId, s.id]);
      expect((await pool.query(bySupplier, [w.A.businessId, s.id])).rows, `supplier ${s.id}`).toEqual(frozen.rows);
      const grouped = await pool.query(payableSql({ groupBy: 'supplier_currency', filter: 'p.supplier_id = ANY($2::uuid[])' }), [w.A.businessId, [s.id]]);
      expect(
        grouped.rows.map((r: Record<string, unknown>) => ({ currency_code: r.currency_code, base_minor: r.base_minor, txn_minor: r.txn_minor })),
        `supplier ${s.id} grouped`,
      ).toEqual(frozen.rows);
    }
    const reads = t.app.get(PurchasingReadService);
    const m = await t.app.get(TenancyService).resolveMembership(w.owner.userId, w.A.businessId);
    for (const p of purchases.rows) {
      const frozen = await pool.query<{ currency_code: string; base_minor: string; txn_minor: string }>(
        FROZEN_S6_PAYABLE_SQL.replace('%FILTER%', 'p.id = $2'),
        [w.A.businessId, p.id],
      );
      expect((await pool.query(byPurchase, [w.A.businessId, p.id])).rows, `purchase ${p.id}`).toEqual(frozen.rows);
      const [row] = frozen.rows;
      const payable = await ok<{ outstandingBaseMinor: string; outstandingTxnMinor: string }>(
        readAs(t, w.owner, w.A.businessId, `/v1/purchases/${p.id}/payable`),
      );
      expect(payable, `GET purchase payable ${p.id}`).toMatchObject({
        outstandingBaseMinor: row?.base_minor ?? '0',
        outstandingTxnMinor: row?.txn_minor ?? '0',
      });
      const status = must((await pool.query<{ status: string }>('SELECT status FROM purchases WHERE id = $1', [p.id])).rows[0]).status;
      if (status === 'received') {
        const settlement = await reads.purchaseSettlement(m, p.id);
        expect(settlement, `purchaseSettlement ${p.id}`).toMatchObject({
          ledgerOutstandingBaseMinor: row?.base_minor ?? '0',
          ledgerOutstandingTxnMinor: row?.txn_minor ?? '0',
        });
      }
    }
    for (const s of suppliers.rows) {
      const frozen = await pool.query<{ currency_code: string; txn_minor: string }>(FROZEN_S6_PAYABLE_SQL.replace('%FILTER%', 'p.supplier_id = $2'), [
        w.A.businessId,
        s.id,
      ]);
      const payable = await ok<{ byCurrency: { currency: string; txnMinor: string }[] }>(readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${s.id}/payable`));
      expect(payable.byCurrency, `GET supplier payable ${s.id}`).toEqual(frozen.rows.map((r) => ({ currency: r.currency_code, txnMinor: r.txn_minor })));
    }
  });
});
