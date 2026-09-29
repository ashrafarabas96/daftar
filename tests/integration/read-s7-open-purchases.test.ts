/**
 * P3-S7 T-06 — A SUPPLIER'S OPEN PURCHASES AND THE ADVISORY PROPOSAL
 * (docs PHASE_3_S7_CONTRACT A-09(b), §6 T-06; Annex R #3).
 *
 * `GET /v1/suppliers/:supplierId/open-purchases` through the real application:
 *   - the supplier's received, unreversed purchases with something
 *     outstanding, OLDEST first; the draft, the reversed purchase and the
 *     fully settled one are absent;
 *   - `outstandingTxnMinor` = `purchase_ap_outstanding` = `GET
 *     /v1/purchases/:id/payable` `outstandingTxnMinor` (Annex R, the two reads
 *     agree);
 *   - the proposal: amount = Σ outstanding + 1 leaves `unallocatedMinor = 1`;
 *     an amount inside the second purchase fills the first and part of the
 *     second; a row in another currency is `proposedMinor: null`;
 *   - the proposal is over ALL the open purchases, so a walked page never
 *     contradicts the next;
 *   - the assigned manager sees only the purchases of the warehouses it
 *     reaches, and the proposal spans only those;
 *   - BigInt at 10^17: the answer is exact where a float would drift;
 *   - the proposal never names more than 50 allocations and never leaves
 *     less than one base unit outstanding (pure, on `proposeAllocation`);
 *   - bounded work (review finding L-3): the open-purchases and the
 *     `owedOnly` supplier-balances statements pre-filter settled purchases
 *     in SQL, so `purchase_ap_outstanding` runs only for purchases that can
 *     be open, and at most for a page (plus the proposal window) of them —
 *     counted with the function-call statistics of the very statement the
 *     service runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must, type HttpActor } from '../helpers/inventory-commands';
import { expectRefusal, outstandingOf } from '../helpers/supplier-settlement';
import { daysBefore, httpPayPart, namedSupplier, ok, readAs, receive, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';
import {
  openPurchasesQuery,
  PROPOSAL_WINDOW,
  proposeAllocation,
  SUPPLIER_SCAN_CAP,
  supplierBalancesQuery,
  SupplierBalancesQuerySchema,
  SupplierOpenPurchasesQuerySchema,
  type ProposalPurchase,
  type ReadQuery,
} from '../../apps/api/src/modules/purchasing/supplier-balance-reads';
import { parseUnitCost } from '@daftar/inventory';

interface OpenRow {
  purchaseId: string;
  documentDate: string;
  supplierReference: string | null;
  warehouseId: string;
  currency: string;
  totalTxnMinor: string;
  outstandingTxnMinor: string;
  proposedMinor: string | null;
}
interface OpenPage {
  items: OpenRow[];
  nextCursor: string | null;
  unallocatedMinor: string | null;
}

let t: TestApp;
let w: ReadsWorld;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'open');
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const open = (query = '', by = w.owner): Promise<OpenPage> =>
  ok<OpenPage>(readAs(t, by, w.A.businessId, `/v1/suppliers/${w.supplierId}/open-purchases${query === '' ? '' : `?${query}`}`));

/** The world's purchase of the mixed product: received today, 3 × 2.00. */
async function mixedPurchaseId(): Promise<string> {
  const r = await ownerPool().query<{ id: string }>(
    `SELECT DISTINCT p.id FROM purchases p JOIN purchase_lines l ON l.business_id = p.business_id AND l.purchase_id = p.id
      WHERE p.business_id = $1 AND l.variant_id = $2`,
    [w.A.businessId, w.mixed.baseVariantId],
  );
  expect(r.rowCount).toBe(1);
  return must(r.rows[0]).id;
}

async function walk(query: string, limit: number): Promise<OpenRow[]> {
  const out: OpenRow[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i += 1) {
    const page: OpenPage = await open(`${query}&limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
    out.push(...page.items);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

describe('T-06 open purchases', () => {
  it('lists the open purchases oldest first; the draft, the reversed and the fully settled purchase are absent', async () => {
    const P = w.purchases;
    const mixed = await mixedPurchaseId();
    const page = await open();
    expect(page.items.map((r) => r.purchaseId)).toEqual([
      P.received.purchaseId,
      P.partlyReturned.purchaseId,
      P.partPaid.purchaseId,
      P.foreign.purchaseId,
      mixed,
    ]);
    expect(page.unallocatedMinor, 'no proposal asked').toBeNull();
    expect(page.nextCursor).toBeNull();
    for (const r of page.items) expect(r.proposedMinor).toBeNull();
    const ids = new Set(page.items.map((r) => r.purchaseId));
    for (const absent of [P.draft, P.reversed, P.paid]) expect(ids.has(absent.purchaseId)).toBe(false);
    expect(page.items.map((r) => [r.currency, r.totalTxnMinor, r.outstandingTxnMinor])).toEqual([
      ['ILS', '5000', '5000'],
      ['ILS', '5000', '3000'],
      ['ILS', '3000', '2000'],
      ['USD', '1000', '1000'],
      ['ILS', '600', '600'],
    ]);
    expect(page.items[1]).toMatchObject({ warehouseId: w.A.w2, documentDate: P.partlyReturned.documentDate });
  });

  it('outstandingTxnMinor = purchase_ap_outstanding = GET …/purchases/:id/payable', async () => {
    for (const r of (await open()).items) {
      const { o } = await outstandingOf(ownerPool(), w.A.businessId, r.purchaseId);
      expect(r.outstandingTxnMinor, 'purchase_ap_outstanding').toBe(o.toString(10));
      const payable = await ok<{ outstandingTxnMinor: string; currency: string }>(readAs(t, w.owner, w.A.businessId, `/v1/purchases/${r.purchaseId}/payable`));
      expect({ o: payable.outstandingTxnMinor, c: payable.currency }, 'the per-purchase payable read').toEqual({ o: r.outstandingTxnMinor, c: r.currency });
    }
  });

  it('the proposal: Σ + 1 leaves 1 unallocated; an amount inside the second fills the first; another currency is null', async () => {
    const all = await open('currency=ILS&amount=10601');
    expect(all.items.map((r) => r.proposedMinor)).toEqual(['5000', '3000', '2000', null, '600']);
    expect(all.unallocatedMinor).toBe('1');
    const inside = await open('currency=ILS&amount=6500');
    expect(inside.items.map((r) => r.proposedMinor)).toEqual(['5000', '1500', '0', null, '0']);
    expect(inside.unallocatedMinor).toBe('0');
    const usd = await open('currency=USD&amount=400');
    expect(usd.items.map((r) => r.proposedMinor)).toEqual([null, null, null, '400', null]);
    expect(usd.unallocatedMinor).toBe('0');
    const none = await open('currency=EUR&amount=100');
    expect(none.items.map((r) => r.proposedMinor)).toEqual([null, null, null, null, null]);
    expect(none.unallocatedMinor, 'no purchase in that currency takes any of it').toBe('100');
  });

  it('keyset pages walk every row once, and the proposal is the same on every page', async () => {
    const whole = await open('currency=ILS&amount=6500');
    const walked = await walk('currency=ILS&amount=6500', 2);
    expect(walked).toEqual(whole.items);
    const second = await open(`currency=ILS&amount=6500&limit=2&cursor=${whole.items[1]?.purchaseId ?? ''}`);
    expect(second.unallocatedMinor, 'every page carries the whole proposal').toBe('0');
    expect(second.items.map((r) => r.proposedMinor)).toEqual(['0', null]);
  });

  it('BigInt at 10^17: the unallocated rest is exact', async () => {
    const big = await open('currency=ILS&amount=100000000000000001');
    expect(big.items.map((r) => r.proposedMinor)).toEqual(['5000', '3000', '2000', null, '600']);
    // 10^17 + 1 − 10,600: not representable as a float (the spacing there is 16).
    expect(big.unallocatedMinor).toBe('99999999999989401');
    expect(Number.isSafeInteger(Number(big.unallocatedMinor))).toBe(false);
  });

  it('scope: the manager assigned to Y sees only W2 and W3 purchases, and the proposal spans only those', async () => {
    const P = w.purchases;
    const mine = await open('currency=ILS&amount=10601', w.manager);
    expect(mine.items.map((r) => r.purchaseId)).toEqual([P.partlyReturned.purchaseId, P.partPaid.purchaseId]);
    expect(mine.items.map((r) => r.proposedMinor)).toEqual(['3000', '2000']);
    expect(mine.unallocatedMinor).toBe('5601');
  });

  it('refusals: the cashier, an unknown or foreign supplier, and a bad query', async () => {
    expect((await readAs(t, w.cashier, w.A.businessId, `/v1/suppliers/${w.supplierId}/open-purchases`)).status, 'the cashier holds neither key').toBe(403);
    expectRefusal(await readAs(t, w.owner, w.A.businessId, '/v1/suppliers/00000000-0000-4000-8000-000000000000/open-purchases'), 404, 'supplier.not_found');
    const other = await namedSupplier(t, w.owner, w.A2, 'A2 supplier');
    expectRefusal(await readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${other}/open-purchases`), 404, 'supplier.not_found', 'a supplier of A2');
    expectRefusal(await readAs(t, w.owner, w.A2.businessId, `/v1/suppliers/${w.supplierId}/open-purchases`), 404, 'supplier.not_found', 'A read under A2');
    const empty = await ok<OpenPage>(readAs(t, w.owner, w.A2.businessId, `/v1/suppliers/${other}/open-purchases`));
    expect(empty).toEqual({ items: [], nextCursor: null, unallocatedMinor: null });
    for (const q of [
      'currency=ILS',
      'amount=100',
      'currency=ILS&amount=0',
      'currency=ILS&amount=-5',
      'currency=ILS&amount=1000000000000000000',
      'currency=ils&amount=5',
      'limit=51',
      'offset=1',
      'cursor=nope',
    ]) {
      const r = await readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${w.supplierId}/open-purchases?${q}`);
      expect({ q, status: r.status, code: (r.body as { error: { code: string } }).error.code }).toEqual({ q, status: 400, code: 'VALIDATION_FAILED' });
    }
  });
});

describe('T-06 proposeAllocation (pure)', () => {
  const ils = (outstanding: bigint): ProposalPurchase => ({ currency: 'ILS', outstandingMinor: outstanding, rateR10: parseUnitCost('1') });

  it('never names more than 50 allocations', () => {
    const many = Array.from({ length: 51 }, () => ils(10n));
    const p = proposeAllocation(many, 'ILS', 1000n, 2);
    expect(p.proposed.filter((a) => a !== null && a > 0n)).toHaveLength(50);
    expect(p.proposed.at(-1)).toBe(0n);
    expect(p.unallocatedMinor).toBe(1000n - 500n);
  });

  it('never splits a purchase so that less than one base unit stays outstanding, nor allocates less than one', () => {
    const tiny: ProposalPurchase = { currency: 'USD', outstandingMinor: 100000n, rateR10: parseUnitCost('0.0001') };
    expect(proposeAllocation([tiny], 'USD', 100000n, 2)).toEqual({ proposed: [100000n], unallocatedMinor: 0n });
    const residue = proposeAllocation([tiny, { ...tiny }], 'USD', 99999n, 2);
    expect(residue, 'a residue of 1 minor converts to 0 base: the proposal stops').toEqual({ proposed: [0n, 0n], unallocatedMinor: 99999n });
  });

  it('is exact at 10^17', () => {
    const big = 10n ** 17n + 1n;
    const p = proposeAllocation([ils(big), ils(3n)], 'ILS', big + 1n, 2);
    expect(p).toEqual({ proposed: [big, 1n], unallocatedMinor: 0n });
  });
});

describe('T-06 bounded work: settled purchases are pre-filtered in SQL (review L-3)', () => {
  /** A supplier with two fully paid purchases (the oldest) and three open ones. */
  let busy: { supplierId: string; name: string; open: string[] };
  /** A supplier whose every purchase is fully paid. */
  let settled: { supplierId: string; name: string };

  const tenFor = (supplierId: string, documentDate: string) =>
    receive(w, { supplierId, warehouseId: w.A.w1, documentDate, lines: [{ productId: w.A.piece.productId, quantity: '1', unitPrice: '10.00' }] });
  const payAll = async (by: HttpActor, supplierId: string, dates: readonly string[]): Promise<void> => {
    for (const d of dates) await httpPayPart(t, by, w.A, w.method, await tenFor(supplierId, d), '1000');
  };

  beforeAll(async () => {
    const busyName = `Busy ${w.supplierName}`;
    const busyId = await namedSupplier(t, w.owner, w.A, busyName);
    await payAll(w.owner, busyId, [daysBefore(w.day, 9), daysBefore(w.day, 8)]);
    const open: string[] = [];
    for (const n of [7, 6, 5]) open.push((await tenFor(busyId, daysBefore(w.day, n))).purchaseId);
    busy = { supplierId: busyId, name: busyName, open };
    const settledName = `Settled ${w.supplierName}`;
    const settledId = await namedSupplier(t, w.owner, w.A, settledName);
    await payAll(w.owner, settledId, [daysBefore(w.day, 9), daysBefore(w.day, 8), daysBefore(w.day, 7)]);
    settled = { supplierId: settledId, name: settledName };
  });

  /**
   * Runs `q` exactly as the read does — as `daftar_app`, under row level
   * security for business A — and counts the `purchase_ap_outstanding` calls
   * it made: the backend's function statistics before and after it, in one
   * transaction (a pooled backend may still hold the unflushed counts of an
   * earlier transaction).
   */
  async function run(q: ReadQuery): Promise<{ rows: Record<string, unknown>[]; calls: number }> {
    const c = await ownerPool().connect();
    const callsSoFar = async (): Promise<number> => {
      const r = await c.query<{ n: string }>(
        `SELECT coalesce(pg_stat_get_xact_function_calls('public.purchase_ap_outstanding(uuid,uuid)'::regprocedure), 0)::text AS n`,
      );
      return Number(must(r.rows[0]).n);
    };
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL track_functions = 'pl'");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [w.A.tenantId, w.A.businessId]);
      const before = await callsSoFar();
      await c.query('SET LOCAL ROLE daftar_app');
      const r = await c.query<Record<string, unknown>>(q.text, q.values);
      await c.query('RESET ROLE');
      return { rows: r.rows, calls: (await callsSoFar()) - before };
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  const openQuery = (query: Record<string, string>): ReadQuery =>
    openPurchasesQuery(w.A.businessId, busy.supplierId, null, SupplierOpenPurchasesQuerySchema.parse(query));
  const balancesQuery = (query: Record<string, string>): ReadQuery => supplierBalancesQuery(w.A.businessId, SupplierBalancesQuerySchema.parse(query));

  it('the results: only the open purchases, oldest first; owedOnly keeps the supplier with something open', async () => {
    const page = await ok<OpenPage>(readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${busy.supplierId}/open-purchases?currency=ILS&amount=2500`));
    expect(page.items.map((r) => [r.purchaseId, r.outstandingTxnMinor, r.proposedMinor])).toEqual([
      [busy.open[0], '1000', '1000'],
      [busy.open[1], '1000', '1000'],
      [busy.open[2], '1000', '500'],
    ]);
    expect(page.unallocatedMinor).toBe('0');
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const p: OpenPage = await ok<OpenPage>(
        readAs(t, w.owner, w.A.businessId, `/v1/suppliers/${busy.supplierId}/open-purchases?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`),
      );
      walked.push(...p.items.map((r) => r.purchaseId));
      if (p.nextCursor === null) break;
      cursor = p.nextCursor;
    }
    expect(walked).toEqual(busy.open);
    for (const [name, owed] of [
      [busy.name, true],
      [settled.name, false],
    ] as const) {
      const b = await ok<{ items: { supplierId: string }[] }>(
        readAs(t, w.owner, w.A.businessId, `/v1/supplier-balances?owedOnly=true&search=${encodeURIComponent(name)}`),
      );
      expect({ name, listed: b.items.length }).toEqual({ name, listed: owed ? 1 : 0 });
    }
  });

  it('open purchases: the function runs for the page’s open candidates only, never for a settled purchase', async () => {
    expect((await run(openQuery({}))).calls, 'the three open ones').toBe(3);
    expect((await run(openQuery({ limit: '1' }))).calls, 'a page of one reads at most two candidates').toBeLessThanOrEqual(2);
    expect((await run(openQuery({ currency: 'ILS', amount: '2500' }))).calls, 'the proposal window holds the three open ones').toBe(3);
  });

  it('supplier balances owedOnly: the function never runs for a settled purchase, and at most once per supplier', async () => {
    expect((await run(balancesQuery({ owedOnly: 'true', search: settled.name }))).calls).toBe(0);
    expect((await run(balancesQuery({ owedOnly: 'true', search: busy.name }))).calls).toBe(1);
  });

  it('the caps: the proposal considers the 500 oldest candidates, and an owedOnly page examines at most 500 suppliers', () => {
    expect({ window: PROPOSAL_WINDOW, scan: SUPPLIER_SCAN_CAP }).toEqual({ window: 500, scan: 500 });
    expect(openQuery({ currency: 'ILS', amount: '1' }).values.slice(4)).toEqual([PROPOSAL_WINDOW, 21]);
    expect(openQuery({ limit: '5' }).values.slice(4), 'no proposal, no window').toEqual([0, 6]);
    expect(balancesQuery({ owedOnly: 'true', limit: '5' }).values.slice(5)).toEqual([6, SUPPLIER_SCAN_CAP]);
    expect(balancesQuery({ limit: '5' }).values.slice(5), 'without owedOnly the scan is the page').toEqual([6, 6]);
  });
});
