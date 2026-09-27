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
 *     less than one base unit outstanding (pure, on `proposeAllocation`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must } from '../helpers/inventory-commands';
import { expectRefusal, outstandingOf } from '../helpers/supplier-settlement';
import { namedSupplier, ok, readAs, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';
import { proposeAllocation, type ProposalPurchase } from '../../apps/api/src/modules/purchasing/supplier-balance-reads';
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
